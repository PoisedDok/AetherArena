"""
Inference Process Lifecycle Manager

Manages the native inference server process (vllm-mlx / vLLM / Ollama).
Handles start, stop, health checks, model management, and crash recovery.

@.architecture
Incoming: api/v1/endpoints/inference.py, app.py lifespan, start_production.sh --- {start/stop/health/model commands}
Processing: subprocess management, health polling, model pull/list/delete --- {4 jobs: JOB_MANAGE_TASK, JOB_HEALTH_CHECK, JOB_CLEANUP_RESOURCE, JOB_INITIALIZE_COMPONENT}
Outgoing: Native process (vllm-mlx/vllm/ollama) via subprocess, PID file --- {process lifecycle, OpenAI-compatible server}
"""

import asyncio
import logging
import os
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from .platform_detector import InferenceEngine, PlatformInfo, detect_platform

logger = logging.getLogger(__name__)


class ServerStatus(str, Enum):
    """Inference server status."""
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    ERROR = "error"
    STOPPING = "stopping"


@dataclass
class ModelInfo:
    """Information about a downloaded model."""
    id: str
    name: str
    size_bytes: Optional[int] = None
    format: Optional[str] = None  # mlx, gguf, safetensors
    quantization: Optional[str] = None  # 8bit, 4bit, etc.


@dataclass
class PullProgress:
    """Model pull progress tracking."""
    job_id: str
    model: str
    status: str = "pending"  # pending, downloading, complete, error
    progress_pct: float = 0.0
    downloaded_bytes: int = 0
    total_bytes: int = 0
    error: Optional[str] = None


class InferenceManager:
    """
    Manages the lifecycle of the native inference server.
    
    DAEMON ARCHITECTURE:
    - Inference server runs as a fully detached process (start_new_session=True)
    - Survives backend restarts (same pattern as daemon_manager)
    - PID file tracks the running server across backend lifecycles
    - On backend startup, reconnects to existing server via PID file + health check
    
    LIFECYCLE:
    - App shutdown: inference_shutdown(stop_server=True) kills the server.
      No orphan processes survive after the user closes the app.
    - Proactive toggle OFF: inference stopped (no consumers).
    - Proactive toggle ON: inference restarted if configured.
    
    Thread-safe singleton. One inference server per Aether instance.
    """
    
    _instance: Optional["InferenceManager"] = None
    
    def __init__(self, port: int = 7090, venv_path: Optional[str] = None, models_dir: Optional[str] = None, idle_timeout: int = 600):
        """Initialize InferenceManager.
        
        Path resolution is NOT this class's responsibility.
        Paths are resolved upstream by the pipeline:
          start_production.sh → env vars → settings.py → inference_control.py → here
        
        This class trusts its caller.  If a path is invalid, it logs a warning
        but does NOT attempt discovery — that would be architectural violation.
        """
        self._port = port
        self._idle_timeout = idle_timeout
        self._process: Optional[subprocess.Popen] = None
        self._pid: Optional[int] = None
        self._status = ServerStatus.STOPPED
        self._platform: Optional[PlatformInfo] = None
        self._current_model: Optional[str] = None
        self._log_file: Optional[Path] = None
        self._pid_file: Optional[Path] = None
        self._pull_jobs: Dict[str, PullProgress] = {}
        self._restart_count = 0
        self._max_restarts = 3
        self._started_at: Optional[float] = None
        self._start_lock = asyncio.Lock()  # Prevents concurrent start() calls from spawning duplicates
        
        # Accept paths from pipeline (settings.py resolves, inference_control.py passes).
        # Validate on use, not on init — the server may already be running externally.
        self._venv_path = Path(venv_path) if venv_path else None
        self._models_dir = Path(models_dir) if models_dir else None
        
        # Resolve PYTHONPATH source dir for subprocess launch (PyInstaller concern).
        # This is the ONLY path resolution this class does — it's about the binary
        # structure, not about discovering user-installed venvs.
        self._service_source_dir = self._resolve_service_source_dir()
        
        # Ensure models directory exists (create if caller provided a path)
        if self._models_dir:
            self._models_dir.mkdir(parents=True, exist_ok=True)
        
        # Log/PID paths: AETHER_BACKEND_ROOT is always set by the orchestrator.
        data_dir = os.getenv("AETHER_BACKEND_ROOT") or os.getenv("AETHER_DATA_DIR") or "."
        log_dir = Path(data_dir) / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        self._log_file = log_dir / "inference-server.log"
        self._pid_file = log_dir / "inference.pid"
        
        # Validate paths and log status
        venv_ok = self._venv_path and (self._venv_path / "bin" / "python").exists()
        models_ok = self._models_dir and self._models_dir.is_dir()
        if not venv_ok:
            logger.warning(
                "Inference venv not found at %s — start() will fail. "
                "Run setup/onboarding or set INFERENCE_VENV_PATH.",
                self._venv_path,
            )
        if not models_ok:
            logger.warning(
                "Inference models dir not found at %s — no local models available.",
                self._models_dir,
            )
        logger.info(
            "InferenceManager init: port=%d, venv=%s (ok=%s), models=%s (ok=%s), logs=%s",
            self._port, self._venv_path, venv_ok, self._models_dir, models_ok, log_dir,
        )
        
        # Reconnect to existing server if PID file exists and process is alive
        self._reconnect_existing()
    
    # -- Service source resolution (PyInstaller binary structure concern) ------
    
    @staticmethod
    def _resolve_service_source_dir() -> Optional[Path]:
        """Resolve the directory containing services/aether_inference/server.py.
        
        The subprocess (server.py) runs in venv-inference as a standalone process.
        It is NOT bundled inside the PyInstaller binary — it lives alongside it,
        like Perplexica source. The binary's _internal/ directory is NEVER used
        because it contains bundled Python packages that conflict with venv-inference.
        
        Resolution: AETHER_BACKEND_ROOT > AETHER_INSTALL_DIR (set by orchestrator).
        """
        marker = Path("services") / "aether_inference" / "server.py"
        
        # 1. AETHER_BACKEND_ROOT (repo-root mode: source tree; packaged: DATA_DIR)
        backend_root = os.getenv("AETHER_BACKEND_ROOT")
        if backend_root and (Path(backend_root) / marker).exists():
            return Path(backend_root)
        
        # 2. AETHER_INSTALL_DIR (packaged app: read-only Resources/bin/ alongside binary)
        install_dir = os.getenv("AETHER_INSTALL_DIR")
        if install_dir and (Path(install_dir) / marker).exists():
            return Path(install_dir)
        
        logger.error(
            "Cannot find services/aether_inference/server.py. "
            "Set AETHER_BACKEND_ROOT or AETHER_INSTALL_DIR. "
            "The inference subprocess cannot start without the source."
        )
        return None
    
    def _reconnect_existing(self) -> None:
        """
        Check PID file for a previously started inference server.
        If the process is alive and healthy, adopt it (skip re-launch).
        
        This allows the inference server to survive backend restarts.
        """
        if not self._pid_file or not self._pid_file.exists():
            return
        
        try:
            stored_pid = int(self._pid_file.read_text().strip())
            
            # Check if process is alive
            os.kill(stored_pid, 0)  # Signal 0: existence check only
            
            # Verify it's actually an inference server (not a reused PID)
            try:
                import psutil
                proc = psutil.Process(stored_pid)
                cmdline = " ".join(proc.cmdline()).lower()
                
                # Must contain one of our known engine identifiers
                is_ours = any(
                    marker in cmdline
                    for marker in [
                        "vllm-mlx", "vllm_mlx.server", "vllm", "ollama serve",
                        "aether_inference.server", "inference",
                    ]
                )
                
                if not is_ours:
                    logger.warning(
                        "PID %d is not an inference server (cmdline: %s), cleaning stale PID file",
                        stored_pid, cmdline[:120]
                    )
                    self._pid_file.unlink(missing_ok=True)
                    return
            except ImportError:
                # psutil not available -- trust PID file + health check below
                pass
            except Exception:
                self._pid_file.unlink(missing_ok=True)
                return
            
            # Process is alive and appears to be ours -- adopt it.
            # Set STARTING (not RUNNING) because we have not verified health yet.
            # The caller (ensure_inference_running) performs health_check() which
            # promotes to RUNNING on success. This prevents serving requests to an
            # unhealthy server that happens to have a valid PID.
            self._pid = stored_pid
            self._status = ServerStatus.STARTING
            self._started_at = self._pid_file.stat().st_mtime
            logger.info(
                "Reconnected to existing inference server (PID: %d, port: %d, status=STARTING pending health)",
                stored_pid, self._port
            )
            
        except (ValueError, OSError):
            # PID file corrupt or process dead -- clean up
            self._pid_file.unlink(missing_ok=True)
        except Exception as e:
            logger.debug("Reconnect check failed: %s", e)
    
    def _write_pid_file(self, pid: int) -> None:
        """Write PID to file atomically using temp + rename.
        
        Atomic on POSIX: os.rename() is guaranteed atomic when src and dst
        are on the same filesystem. This prevents partial reads if the backend
        crashes mid-write (the old PID file is replaced in one syscall).
        """
        if not self._pid_file:
            return
        try:
            pid_dir = self._pid_file.parent
            fd, tmp_path = tempfile.mkstemp(dir=str(pid_dir), prefix=".inference_pid_")
            try:
                os.write(fd, str(pid).encode())
            finally:
                os.close(fd)
            os.rename(tmp_path, str(self._pid_file))
        except Exception as e:
            logger.warning("Failed to write PID file atomically: %s", e)
            # Fallback: direct write (better than no PID file)
            try:
                self._pid_file.write_text(str(pid))
            except Exception:
                pass

    def resolve_model_path(self, model_id: str) -> str:
        """
        Resolve a model identifier to a local path if available in models_dir.
        
        Resolution order:
        1. If model_id is already an absolute path to a directory, return as-is
        2. Check models_dir/{model_id} (e.g. models/mlx-community/GLM-OCR-8bit)
        3. Fall back to model_id as-is (HuggingFace hub ID, resolved by the engine)
        
        The models_dir structure mirrors HuggingFace org/model naming:
          models/
            mlx-community/
              GLM-OCR-8bit/
                config.json, model.safetensors, ...
            lmstudio-community/
              LFM2.5-1.2B-Instruct-MLX-8bit/
                config.json, model.safetensors, ...
        
        Returns:
            Absolute path string if local model found, otherwise original model_id
        """
        # Already an absolute local path
        if os.path.isabs(model_id) and Path(model_id).is_dir():
            if (Path(model_id) / "config.json").exists():
                logger.info("Model resolved: %s (absolute path)", model_id)
                return model_id
        
        # Check models_dir
        if self._models_dir:
            local_path = self._models_dir / model_id
            if local_path.is_dir() and (local_path / "config.json").exists():
                resolved = str(local_path.resolve())
                logger.info("Model resolved: %s -> %s (local models_dir)", model_id, resolved)
                return resolved
        
        # Fall back: let engine resolve from HuggingFace Hub
        logger.debug("Model not found locally, using HF hub ID: %s", model_id)
        return model_id
    
    def list_local_models(self) -> List[Dict[str, Any]]:
        """
        List all models available in the local models directory.
        
        Returns:
            List of dicts with model info (id, path, size_bytes, has_safetensors)
        """
        results = []
        if not self._models_dir or not self._models_dir.exists():
            return results
        
        # Walk org/model structure (two levels)
        for org_dir in sorted(self._models_dir.iterdir()):
            if not org_dir.is_dir() or org_dir.name.startswith("."):
                continue
            for model_dir in sorted(org_dir.iterdir()):
                if not model_dir.is_dir() or model_dir.name.startswith("."):
                    continue
                config_path = model_dir / "config.json"
                if not config_path.exists():
                    continue
                
                # Calculate total size
                total_bytes = sum(
                    f.stat().st_size for f in model_dir.rglob("*") if f.is_file()
                )
                
                model_id = f"{org_dir.name}/{model_dir.name}"
                results.append({
                    "id": model_id,
                    "path": str(model_dir),
                    "size_bytes": total_bytes,
                    "has_safetensors": any(model_dir.glob("*.safetensors")),
                })
        
        return results
    
    @classmethod
    def get_instance(cls, **kwargs) -> "InferenceManager":
        """Get or create singleton instance."""
        if cls._instance is None:
            cls._instance = cls(**kwargs)
        return cls._instance
    
    @property
    def port(self) -> int:
        return self._port
    
    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._port}"
    
    @property
    def api_url(self) -> str:
        return f"{self.base_url}/v1"
    
    @property
    def status(self) -> ServerStatus:
        return self._status
    
    @property
    def platform_info(self) -> Optional[PlatformInfo]:
        if self._platform is None:
            self._platform = detect_platform()
        return self._platform
    
    def _resolve_engine_binary(self) -> str:
        """
        Resolve the path to the inference engine binary.
        
        Priority:
        1. Dedicated venv-inference python (for module-based engines like vllm-mlx)
        2. Dedicated venv-inference binary (for binary-based engines like vllm)
        3. System PATH
        """
        pinfo = self.platform_info
        cmd = pinfo.engine_command
        
        if self._venv_path and self._venv_path.exists():
            # For VLLM_MLX: engine_command is "python" (uses -m vllm_mlx.server)
            # For VLLM: engine_command is "vllm" (direct binary)
            venv_bin = self._venv_path / "bin" / cmd
            if venv_bin.exists():
                return str(venv_bin)
        
        # Fallback: system PATH
        import shutil
        system_cmd = shutil.which(cmd)
        if system_cmd:
            return system_cmd
        
        raise FileNotFoundError(
            f"Inference engine '{cmd}' not found. "
            f"Checked venv at {self._venv_path} and system PATH. "
            f"Run setup/onboarding to install."
        )
    
    def _discover_models(self) -> List[str]:
        """
        Discover all models in models_dir that should be served.
        
        Returns list of model ID strings (e.g. ['mlx-community/GLM-OCR-8bit', ...]).
        Supports: safetensors, pytorch (.bin), and GGUF model formats.
        """
        models = []
        if self._models_dir and self._models_dir.exists():
            # Two-level org/model structure
            for org_dir in sorted(self._models_dir.iterdir()):
                if not org_dir.is_dir() or org_dir.name.startswith("."):
                    continue
                for model_dir in sorted(org_dir.iterdir()):
                    if not model_dir.is_dir() or model_dir.name.startswith("."):
                        continue
                    has_hf = (model_dir / "config.json").exists() and (
                        any(model_dir.glob("*.safetensors")) or any(model_dir.glob("*.bin"))
                    )
                    has_gguf = any(model_dir.glob("*.gguf"))
                    if has_hf or has_gguf:
                        models.append(f"{org_dir.name}/{model_dir.name}")
            
            # Flat GGUF files directly in models_dir
            for gguf_file in sorted(self._models_dir.glob("*.gguf")):
                models.append(gguf_file.stem)
        return models
    
    def _build_serve_command(self, model: Optional[str] = None) -> List[str]:
        """
        Build the command to start the inference server.
        
        For VLLM_MLX and VLLM: Uses the multi-model router (services.aether_inference.server)
        which internally manages backend processes per model on demand.
        The router auto-discovers models from models_dir and loads on first request.
        
        For OLLAMA: Direct ollama serve (Ollama handles multi-model natively).
        """
        pinfo = self.platform_info
        engine_bin = self._resolve_engine_binary()
        
        # Map platform engine to router engine flag
        _engine_map = {
            InferenceEngine.VLLM_MLX: "vllm-mlx",
            InferenceEngine.VLLM: "vllm",
        }
        
        if pinfo.engine in (InferenceEngine.VLLM_MLX, InferenceEngine.VLLM):
            # Multi-model on-demand router for both Apple Silicon and NVIDIA.
            # Router auto-discovers models from models_dir. Explicit --model args
            # are only needed for models NOT in models_dir (e.g. HF hub IDs).
            router_engine = _engine_map[pinfo.engine]
            
            discovered = self._discover_models()
            
            # If a specific model was requested and not yet in models_dir,
            # include it as a HF hub model
            target_model = model or self._current_model or pinfo.glm_ocr_model
            if target_model and target_model not in discovered:
                discovered.append(target_model)
            
            # CRITICAL: Use direct script path, NOT '-m services.aether_inference.server'.
            # The -m invocation triggers __init__.py which imports manager/platform/inference_control
            # — modules with heavy deps (psutil, asyncio locks) not available in venv-inference.
            # server.py is self-contained (only needs httpx, uvicorn, fastapi from venv-inference).
            if self._service_source_dir:
                server_script = str(self._service_source_dir / "services" / "aether_inference" / "server.py")
                cmd = [engine_bin, server_script]
            else:
                # Fallback: try -m invocation (may fail if __init__.py has incompatible imports)
                logger.warning("No service source dir resolved — falling back to -m invocation")
                cmd = [engine_bin, "-m", "services.aether_inference.server"]
            
            cmd.extend([
                "--port", str(self._port),
                "--idle-timeout", str(self._idle_timeout),
                "--engine", router_engine,
            ])
            
            if self._venv_path:
                cmd.extend(["--venv", str(self._venv_path)])
            if self._models_dir:
                cmd.extend(["--models-dir", str(self._models_dir)])
            
            # Only pass models not discoverable from models_dir
            for mid in discovered:
                cmd.extend(["--model", mid])
            
            self._current_model = ",".join(discovered) if discovered else pinfo.glm_ocr_model
            
        elif pinfo.engine == InferenceEngine.OLLAMA:
            # Ollama: native multi-model. No router needed.
            cmd = [engine_bin, "serve"]
            
        else:
            raise ValueError(f"Unsupported engine: {pinfo.engine}")
        
        return cmd
    
    async def start(self, model: Optional[str] = None) -> Dict[str, Any]:
        """
        Start the inference server.
        
        Concurrent-safe: uses asyncio.Lock to prevent duplicate spawns when
        multiple callers (lifespan + API endpoint) invoke start() simultaneously.
        
        Args:
            model: Model to serve (None = use default from platform detection)
            
        Returns:
            Dict with status and details
        """
        async with self._start_lock:
            return await self._start_locked(model)

    async def _start_locked(self, model: Optional[str] = None) -> Dict[str, Any]:
        """Inner start logic, always called under _start_lock."""
        if self._status == ServerStatus.RUNNING:
            health = await self.health_check()
            if health.get("healthy"):
                return {"status": "already_running", "port": self._port, "model": self._current_model}
        
        self._status = ServerStatus.STARTING
        logger.info("Starting inference server on port %d...", self._port)
        
        log_handle = None
        try:
            cmd = self._build_serve_command(model)
            logger.info("Inference command: %s", " ".join(cmd))
            
            # Open log file for stdout/stderr (tracked for cleanup on error)
            log_handle = open(self._log_file, "a") if self._log_file else None
            stdout_target = log_handle if log_handle else subprocess.DEVNULL
            
            # Build environment with PYTHONPATH for the subprocess.
            # The subprocess is a separate python process that needs to find
            # services.aether_inference.server as a module.
            env = os.environ.copy()
            pinfo = self.platform_info
            
            # PYTHONPATH: include the directory containing services/ so the
            # subprocess can import services.aether_inference.server.
            if self._service_source_dir:
                existing_pp = env.get("PYTHONPATH", "")
                src = str(self._service_source_dir)
                if src not in existing_pp.split(os.pathsep):
                    env["PYTHONPATH"] = f"{src}{os.pathsep}{existing_pp}" if existing_pp else src
            
            # For Ollama: set port via env var (OLLAMA_HOST)
            # Ollama: bind to AETHER_BIND_IP (default loopback) to support external mesh if configured
            if pinfo.engine == InferenceEngine.OLLAMA:
                bind_ip = os.environ.get("AETHER_BIND_IP", "127.0.0.1")
                env["OLLAMA_HOST"] = f"{bind_ip}:{self._port}"
            
            # Resolve CWD: prefer the service source dir (where services/ lives)
            # so relative imports and model paths resolve correctly.
            cwd = str(self._service_source_dir) if self._service_source_dir else None
            
            self._process = subprocess.Popen(
                cmd,
                stdout=stdout_target,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                env=env,
                cwd=cwd,
                start_new_session=True,  # Detach from parent process group (survives backend restarts)
                close_fds=True,          # Close inherited file descriptors (full detachment)
            )
            
            # Popen succeeded — subprocess owns the log fd now.
            # Close our handle; the subprocess inherited a dup via Popen.
            if log_handle:
                log_handle.close()
                log_handle = None  # Prevent double-close in finally
            
            self._pid = self._process.pid
            self._started_at = time.time()
            
            # Write PID file atomically (temp + rename prevents corruption on crash)
            self._write_pid_file(self._pid)
            
            logger.info("Inference server started (PID: %d)", self._pid)
            
            # Wait for server to become healthy (max 60s for model loading)
            healthy = await self._wait_for_healthy(timeout_seconds=60)
            
            if healthy:
                self._status = ServerStatus.RUNNING
                self._restart_count = 0
                logger.info("Inference server healthy on port %d", self._port)
                return {
                    "status": "running",
                    "port": self._port,
                    "pid": self._pid,
                    "model": self._current_model,
                    "engine": pinfo.engine.value,
                }
            else:
                self._status = ServerStatus.ERROR
                logger.error("Inference server failed health check after startup")
                return {
                    "status": "error",
                    "error": "Server started but failed health check",
                    "port": self._port,
                    "pid": self._pid,
                }
                
        except FileNotFoundError as e:
            self._status = ServerStatus.ERROR
            logger.error("Inference engine not found: %s", e)
            return {"status": "error", "error": str(e)}
        except Exception as e:
            self._status = ServerStatus.ERROR
            logger.error("Failed to start inference server: %s", e, exc_info=True)
            return {"status": "error", "error": str(e)}
        finally:
            # Close log handle if Popen failed before the subprocess could inherit it
            if log_handle is not None:
                try:
                    log_handle.close()
                except Exception:
                    pass
    
    async def stop(self) -> Dict[str, Any]:
        """Stop the inference server gracefully.
        
        Handles three scenarios:
        1. Server started by this manager (self._process is set)
        2. Server adopted via PID file (self._pid is set)
        3. Server running externally (neither set, but port responds)
        """
        # If we think it's stopped, verify via health check before short-circuiting.
        # Shell script may have started the server outside our control.
        if self._status == ServerStatus.STOPPED and not self._pid and not self._process:
            health = await self.health_check()
            if not health.get("healthy"):
                return {"status": "already_stopped"}
            # Server IS running but we have no reference -- fall through to port-based kill
            logger.info("Inference server is running externally (detected via health check), will stop by port")
        
        self._status = ServerStatus.STOPPING
        logger.info("Stopping inference server (PID: %s)...", self._pid)
        
        try:
            if self._process and self._process.poll() is None:
                # Graceful: SIGTERM
                os.killpg(os.getpgid(self._process.pid), signal.SIGTERM)
                try:
                    self._process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    # Force: SIGKILL
                    logger.warning("Inference server did not stop gracefully, sending SIGKILL")
                    os.killpg(os.getpgid(self._process.pid), signal.SIGKILL)
                    self._process.wait(timeout=5)
            
            elif self._pid:
                # Process started externally (e.g. from PID file)
                try:
                    os.kill(self._pid, signal.SIGTERM)
                    await asyncio.sleep(2)
                    try:
                        os.kill(self._pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # Died after SIGTERM -- good
                except ProcessLookupError:
                    pass  # Already dead
            
            else:
                # No PID, no process -- find and kill by port (externally started)
                await self._kill_by_port()
            
            self._status = ServerStatus.STOPPED
            self._process = None
            self._pid = None
            self._current_model = None
            
            # Clean PID file (also check common alternate locations)
            for pf in self._get_pid_file_candidates():
                try:
                    pf.unlink(missing_ok=True)
                except Exception:
                    pass
            
            logger.info("Inference server stopped")
            return {"status": "stopped"}
            
        except Exception as e:
            self._status = ServerStatus.ERROR
            logger.error("Error stopping inference server: %s", e)
            return {"status": "error", "error": str(e)}
    
    def _is_inference_process(self, pid: int) -> bool:
        """Verify a PID belongs to an inference server via cmdline inspection.
        
        Returns True if the process cmdline contains known inference markers,
        or if psutil is unavailable (benefit of the doubt — can't verify).
        Returns False if the process is verifiably NOT an inference server.
        """
        try:
            import psutil
            proc = psutil.Process(pid)
            cmdline = " ".join(proc.cmdline()).lower()
            return any(
                marker in cmdline
                for marker in [
                    "vllm-mlx", "vllm_mlx.server", "vllm", "ollama serve",
                    "aether_inference.server", "inference",
                ]
            )
        except ImportError:
            # psutil not available — can't verify, trust the port match
            return True
        except Exception:
            # Process may have died between lsof and this check — safe to skip
            return False

    async def _kill_by_port(self) -> None:
        """Find and kill the process listening on our inference port.
        
        Identity-verified: before killing any PID found via lsof/psutil,
        verifies the process cmdline contains inference markers. This prevents
        killing unrelated services that may have reused the port.
        
        Strategy order:
        1. lsof (works without privileges on macOS/Linux, most reliable)
        2. psutil.net_connections (requires root on macOS, fallback)
        """
        # Strategy 1: lsof (macOS/Linux) — works without elevated privileges
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{self._port}"],
                capture_output=True, text=True, timeout=5
            )
            if result.stdout.strip():
                verified_pids = []
                for pid_str in result.stdout.strip().split("\n"):
                    pid = int(pid_str.strip())
                    if self._is_inference_process(pid):
                        verified_pids.append(pid)
                    else:
                        logger.warning(
                            "PID %d on port %d is NOT an inference process — skipping kill",
                            pid, self._port
                        )
                
                if not verified_pids:
                    logger.warning("No verified inference processes found on port %d", self._port)
                    return
                
                for pid in verified_pids:
                    logger.info("Killing inference process on port %d: PID %d (via lsof, identity verified)", self._port, pid)
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                await asyncio.sleep(3)
                # Verify kill, force if needed
                for pid in verified_pids:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # Already dead — good
                return
        except (FileNotFoundError, subprocess.TimeoutExpired, ValueError) as e:
            logger.debug("lsof fallback failed: %s", e)
        
        # Strategy 2: psutil (requires privileges on macOS — AccessDenied common)
        try:
            import psutil
            for conn in psutil.net_connections(kind='inet'):
                if conn.laddr.port == self._port and conn.status == 'LISTEN' and conn.pid:
                    if not self._is_inference_process(conn.pid):
                        logger.warning(
                            "PID %d on port %d is NOT an inference process — skipping (psutil)",
                            conn.pid, self._port
                        )
                        continue
                    logger.info("Found inference process on port %d: PID %d (via psutil, identity verified)", self._port, conn.pid)
                    try:
                        os.kill(conn.pid, signal.SIGTERM)
                        await asyncio.sleep(3)
                        try:
                            os.kill(conn.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass  # Died after SIGTERM
                    except ProcessLookupError:
                        pass
                    return
        except Exception as e:
            # psutil.AccessDenied on macOS, ImportError if not installed, etc.
            logger.debug("psutil net_connections failed (non-fatal): %s", e)
        
        logger.warning("Could not find process on port %d to stop", self._port)
    
    def _get_pid_file_candidates(self) -> list:
        """Return all possible PID file locations (ours + shell script's)."""
        candidates = []
        if self._pid_file:
            candidates.append(self._pid_file)
        # Shell script may write to DATA_DIR/logs/inference.pid
        # which can differ from AETHER_BACKEND_ROOT/logs/inference.pid in dev
        data_dir = os.getenv("AETHER_DATA_DIR")
        if data_dir:
            alt = Path(data_dir) / "logs" / "inference.pid"
            if alt not in candidates:
                candidates.append(alt)
        # macOS default
        mac_default = Path.home() / "Library" / "Application Support" / "Aether" / "logs" / "inference.pid"
        if mac_default not in candidates:
            candidates.append(mac_default)
        return candidates
    
    async def restart(self, model: Optional[str] = None) -> Dict[str, Any]:
        """Restart the inference server."""
        await self.stop()
        await asyncio.sleep(1)
        return await self.start(model=model)
    
    async def health_check(self) -> Dict[str, Any]:
        """
        Check inference server health.
        
        Returns:
            Dict with healthy status, model info, and response time
        """
        start_time = time.time()
        
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=2.0, read=5.0, write=5.0, pool=5.0)) as client:
                # Try /health first, then /v1/models
                try:
                    resp = await client.get(f"{self.base_url}/health")
                    if resp.status_code < 500:
                        payload = None
                        try:
                            payload = resp.json()
                        except Exception:
                            payload = None

                        # Router can be reachable while every registered model is
                        # hard-failed. Treat that as unhealthy to force restart/recovery.
                        if isinstance(payload, dict):
                            model_count = int(payload.get("model_count") or 0)
                            loaded_count = int(payload.get("loaded_count") or 0)
                            available = payload.get("available") or []
                            all_error = bool(available) and all(
                                isinstance(item, dict) and item.get("state") == "error"
                                for item in available
                            )
                            if model_count > 0 and loaded_count == 0 and all_error:
                                elapsed_ms = (time.time() - start_time) * 1000
                                return {
                                    "healthy": False,
                                    "status": ServerStatus.ERROR.value,
                                    "response_time_ms": round(elapsed_ms, 2),
                                    "port": self._port,
                                    "model": self._current_model,
                                    "error": "Inference router reachable but all models are in error state",
                                }

                        elapsed_ms = (time.time() - start_time) * 1000
                        # Sync internal status: promote STOPPED or STARTING to RUNNING
                        # on confirmed healthy response. STARTING comes from _reconnect_existing
                        # which adopts a PID but defers health verification to the caller.
                        if self._status in (ServerStatus.STOPPED, ServerStatus.STARTING):
                            self._status = ServerStatus.RUNNING
                        return {
                            "healthy": True,
                            "status": self._status.value,
                            "response_time_ms": round(elapsed_ms, 2),
                            "port": self._port,
                            "model": self._current_model,
                        }
                except httpx.RequestError:
                    pass
                
                # Fallback: /v1/models (OpenAI-compatible)
                resp = await client.get(f"{self.api_url}/models")
                elapsed_ms = (time.time() - start_time) * 1000
                healthy = resp.status_code < 500
                
                # Sync internal status based on actual health
                if healthy and self._status in (ServerStatus.STOPPED, ServerStatus.STARTING):
                    self._status = ServerStatus.RUNNING
                
                result = {
                    "healthy": healthy,
                    "status": self._status.value if healthy else ServerStatus.ERROR.value,
                    "response_time_ms": round(elapsed_ms, 2),
                    "port": self._port,
                    "model": self._current_model,
                }
                
                if healthy:
                    try:
                        data = resp.json()
                        models = data.get("data", [])
                        result["loaded_models"] = [m.get("id") for m in models if m.get("id")]
                    except Exception:
                        pass
                
                return result
                
        except (httpx.ConnectError, httpx.TimeoutException):
            return {
                "healthy": False,
                "status": ServerStatus.STOPPED.value,
                "error": "Connection refused",
                "port": self._port,
            }
        except Exception as e:
            return {
                "healthy": False,
                "status": ServerStatus.ERROR.value,
                "error": str(e),
                "port": self._port,
            }
    
    async def list_models(self) -> List[Dict[str, Any]]:
        """
        List models available on the inference server.
        
        Returns:
            List of model info dicts
        """
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                pinfo = self.platform_info
                
                if pinfo.engine == InferenceEngine.OLLAMA:
                    resp = await client.get(f"{self.base_url}/api/tags")
                    resp.raise_for_status()
                    data = resp.json()
                    return [
                        {"id": m.get("model") or m.get("name"), "name": m.get("name", ""), "size": m.get("size")}
                        for m in data.get("models", [])
                    ]
                else:
                    # OpenAI-compatible /v1/models
                    resp = await client.get(f"{self.api_url}/models")
                    resp.raise_for_status()
                    data = resp.json()
                    return [
                        {"id": m.get("id"), "name": m.get("id", ""), "owned_by": m.get("owned_by")}
                        for m in data.get("data", [])
                    ]
                    
        except Exception as e:
            logger.warning("Failed to list models: %s", e)
            return []
    
    async def pull_model(self, model: str) -> PullProgress:
        """
        Pull/download a model. For Ollama, uses the pull API.
        For vllm-mlx/vllm, the model is downloaded on first serve.
        
        Args:
            model: Model identifier (e.g. "mlx-community/GLM-OCR-8bit")
            
        Returns:
            PullProgress with job tracking info
        """
        import uuid
        job_id = str(uuid.uuid4())[:8]
        progress = PullProgress(job_id=job_id, model=model, status="downloading")
        self._pull_jobs[job_id] = progress
        
        pinfo = self.platform_info
        
        if pinfo.engine == InferenceEngine.OLLAMA:
            # Ollama has a pull API
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
                    resp = await client.post(
                        f"{self.base_url}/api/pull",
                        json={"name": model, "stream": False},
                    )
                    if resp.status_code < 400:
                        progress.status = "complete"
                        progress.progress_pct = 100.0
                    else:
                        progress.status = "error"
                        progress.error = f"HTTP {resp.status_code}: {resp.text}"
            except Exception as e:
                progress.status = "error"
                progress.error = str(e)
        else:
            # vllm-mlx / vLLM: Download model into local models_dir.
            # Uses huggingface_hub.snapshot_download with local_dir to place
            # files directly in models_dir/{org}/{name} (no HF cache symlinks).
            try:
                venv_python = None
                if self._venv_path:
                    venv_python = self._venv_path / "bin" / "python"
                    if not venv_python.exists():
                        venv_python = None
                
                python_bin = str(venv_python) if venv_python else sys.executable
                
                # Download into models_dir if configured, otherwise let HF cache handle it.
                # SECURITY: NEVER interpolate user input (model name) into python -c strings.
                # Use subprocess args to pass model_id and local_dir as environment variables,
                # preventing code injection via crafted model names (e.g. containing single quotes).
                import re
                _MODEL_ID_RE = re.compile(r'^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$')
                if not _MODEL_ID_RE.match(model):
                    raise ValueError(
                        f"Invalid model ID '{model}'. Must be 'org/model' with alphanumeric, "
                        f"dot, hyphen, or underscore characters only."
                    )
                
                dl_env = os.environ.copy()
                dl_env["_AETHER_DL_MODEL"] = model
                
                # Redirect HF cache to app data directory to avoid macOS
                # com.apple.provenance xattr issues on ~/.cache/huggingface/.
                backend_root = os.environ.get("AETHER_BACKEND_ROOT")
                if backend_root and "HF_HOME" not in dl_env:
                    hf_home = os.path.join(backend_root, "cache", "huggingface")
                    os.makedirs(hf_home, exist_ok=True)
                    dl_env["HF_HOME"] = hf_home
                    dl_env["HF_HUB_CACHE"] = os.path.join(hf_home, "hub")
                
                if self._models_dir:
                    local_dir = self._models_dir / model.replace("/", os.sep)
                    local_dir.mkdir(parents=True, exist_ok=True)
                    dl_env["_AETHER_DL_LOCAL_DIR"] = str(local_dir)
                    download_script = (
                        "import os; from huggingface_hub import snapshot_download; "
                        "snapshot_download(os.environ['_AETHER_DL_MODEL'], "
                        "local_dir=os.environ['_AETHER_DL_LOCAL_DIR'])"
                    )
                else:
                    download_script = (
                        "import os; from huggingface_hub import snapshot_download; "
                        "snapshot_download(os.environ['_AETHER_DL_MODEL'])"
                    )
                
                proc = await asyncio.create_subprocess_exec(
                    python_bin, "-c", download_script,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=dl_env,
                )
                stdout, stderr = await proc.communicate()
                
                if proc.returncode == 0:
                    progress.status = "complete"
                    progress.progress_pct = 100.0
                else:
                    progress.status = "error"
                    progress.error = stderr.decode("utf-8", errors="replace")[:500]
                    
            except Exception as e:
                progress.status = "error"
                progress.error = str(e)
        
        return progress
    
    def get_pull_progress(self, job_id: str) -> Optional[PullProgress]:
        """Get progress of a model pull job."""
        return self._pull_jobs.get(job_id)
    
    async def get_status(self) -> Dict[str, Any]:
        """Get comprehensive server status."""
        health = await self.health_check()
        pinfo = self.platform_info
        
        return {
            "status": self._status.value,
            "healthy": health.get("healthy", False),
            "port": self._port,
            "pid": self._pid,
            "current_model": self._current_model,
            "models_dir": str(self._models_dir) if self._models_dir else None,
            "local_models": self.list_local_models(),
            "engine": pinfo.engine.value if pinfo else None,
            "engine_display": pinfo.engine_display_name if pinfo else None,
            "platform": {
                "os": pinfo.os,
                "arch": pinfo.arch,
                "gpu": pinfo.gpu.value,
                "gpu_name": pinfo.gpu_name,
                "gpu_memory_gb": pinfo.gpu_memory_gb,
            } if pinfo else None,
            "uptime_seconds": round(time.time() - self._started_at, 1) if self._started_at and self._status == ServerStatus.RUNNING else None,
            "response_time_ms": health.get("response_time_ms"),
            "loaded_models": health.get("loaded_models", []),
        }
    
    async def _wait_for_healthy(self, timeout_seconds: int = 60) -> bool:
        """
        Poll health endpoint until server is ready or timeout.
        
        Uses exponential backoff: 1s, 2s, 4s, 8s, then 5s intervals.
        """
        start = time.time()
        delays = [1, 2, 4, 8]  # Initial backoff delays
        attempt = 0
        
        while (time.time() - start) < timeout_seconds:
            # Check if process died
            if self._process and self._process.poll() is not None:
                logger.error("Inference server process exited with code %d", self._process.returncode)
                return False
            
            health = await self.health_check()
            if health.get("healthy"):
                return True
            
            delay = delays[attempt] if attempt < len(delays) else 5
            attempt += 1
            await asyncio.sleep(delay)
        
        return False
    
    def is_server_process_alive(self) -> bool:
        """
        Check if the inference server process is alive (via PID file or tracked PID).
        
        Used for reconnection after backend restart.
        """
        pid = self._pid
        if not pid and self._pid_file and self._pid_file.exists():
            try:
                pid = int(self._pid_file.read_text().strip())
            except (ValueError, OSError):
                return False
        
        if not pid:
            return False
        
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    
    async def dispose(self, stop_server: bool = False) -> None:
        """Release manager state and optionally stop the inference server.

        Called during app shutdown. The app decides stop_server based on the
        proactive master switch state (see app.py _read_proactive_master_enabled):
          proactive enabled  -> stop_server=False (server survives for instant reconnect)
          proactive disabled -> stop_server=True  (server killed to prevent orphans)

        Args:
            stop_server: If True, stop the inference server process.
                         If False, only release manager state (server keeps running).
        """
        if stop_server and self._status in (ServerStatus.RUNNING, ServerStatus.STARTING):
            await self.stop()
        else:
            logger.info(
                "Backend shutting down -- inference server continues running (PID: %s, port: %d)",
                self._pid, self._port
            )
        
        self._pull_jobs.clear()
        InferenceManager._instance = None
