"""
Aether Inference Server - On-Demand Multi-Model Router (Multi-Platform)

Lightweight FastAPI proxy on a single external port (7090). Models are loaded
on first request and automatically evicted after an idle timeout (default 10 min).

Supported backends:
    vllm-mlx   : Apple Silicon (MLX safetensors via Metal GPU)
    vllm       : NVIDIA CUDA (HuggingFace safetensors/bin via CUDA)
    llama-cpp  : Any platform (GGUF models via llama.cpp)

Architecture:
    Client (port 7090)  ->  Router (this file, always running)
                              |-- lazy --> vllm-mlx backend  (vision/text, .safetensors)
                              |-- lazy --> vllm backend       (vision/text, .safetensors)
                              +-- lazy --> llama-cpp backend   (text,        .gguf)

Lifecycle:
    1. Router starts with ZERO backends. /v1/models lists available (not loaded).
    2. First request matching a model triggers backend launch (blocks until ready).
    3. Subsequent requests route to warm backend instantly.
    4. Background reaper checks every 60s: idle backends > timeout are stopped.
    5. Next request for an evicted model re-launches it.

Model format detection:
    config.json + *.safetensors  ->  safetensors format (vllm-mlx or vllm)
    config.json + *.bin          ->  pytorch format (vllm-mlx or vllm)
    *.gguf                       ->  GGUF format (llama-cpp)

Usage:
    python -m services.aether_inference.server \\
        --port 7090 --models-dir ./models --venv ./venv-inference \\
        --engine vllm-mlx --idle-timeout 600

@.architecture
Incoming: InferenceManager subprocess, InferenceClient HTTP calls
Processing: on-demand subprocess spawn, async httpx proxy, idle eviction
Outgoing: OpenAI-compatible JSON responses (transparent proxy)
"""

import argparse
import asyncio
import json
import logging
import os
import signal
import shutil
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

# --- THIRD-PARTY TELEMETRY SUPPRESSION ---
# Mirror main.py: ensure no ML library phones home, even when run standalone.
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('TRANSFORMERS_NO_ADVISORY_WARNINGS', '1')
os.environ.setdefault('DO_NOT_TRACK', '1')
os.environ.setdefault('SCARF_NO_ANALYTICS', '1')

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("aether-inference")


# ---------------------------------------------------------------------------
# Constants & Enums
# ---------------------------------------------------------------------------
class BackendEngine(str, Enum):
    """Backend engine types for serving models."""
    VLLM_MLX = "vllm-mlx"      # Apple Silicon: python -m vllm_mlx.server
    VLLM = "vllm"               # NVIDIA CUDA: vllm serve
    LLAMA_CPP = "llama-cpp"     # Any platform: python -m llama_cpp.server (GGUF)


class ModelFormat(str, Enum):
    """Detected model file format."""
    SAFETENSORS = "safetensors"  # HuggingFace / MLX safetensors
    PYTORCH = "pytorch"          # Legacy HuggingFace *.bin
    GGUF = "gguf"                # llama.cpp GGUF format


class BackendState(str, Enum):
    AVAILABLE = "available"   # Known model, not loaded
    LOADING = "loading"       # Backend process starting
    READY = "ready"           # Backend healthy, accepting requests
    STOPPING = "stopping"     # Being evicted
    ERROR = "error"           # Failed to start


_VISION_MODEL_TYPES: Set[str] = {
    "glm_ocr", "qwen2_vl", "llava", "llava_next", "gemma3",
    "internvl", "phi3_v", "cogvlm2", "minicpmv", "mplugowl2",
    "lfm2_vl",  # LFM 2.5 Vision
}
_VISION_CONFIG_KEYS: Set[str] = {
    "vision_config", "image_size", "visual", "vision_tower",
    "mm_vision_tower", "image_token_id",
}

# Maximum consecutive load failures before the server stops retrying a model
_MAX_LOAD_RETRIES = 3


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------
@dataclass
class ModelParams:
    """
    Per-model inference parameters extracted from config.json / generation_config.json.
    Backend uses these for per-agent defaults; frontend exposes user-friendly subset.
    """
    context_length: int = 4096             # max_position_embeddings (tokens)
    default_temperature: float = 0.7       # generation default
    default_top_p: float = 0.9             # nucleus sampling
    default_top_k: int = 40               # top-k sampling (0 = disabled)
    default_max_tokens: int = 2048         # default generation length
    repeat_penalty: float = 1.0            # repetition penalty
    vocab_size: int = 0                    # vocabulary size
    num_layers: int = 0                    # transformer layers
    hidden_size: int = 0                   # hidden dimension
    do_sample: bool = True                 # whether to sample vs greedy


@dataclass
class ModelEntry:
    """Registry entry for a known model (loaded or not)."""
    model_id: str                          # e.g. "mlx-community/GLM-OCR-8bit"
    model_path: str                        # Resolved local path (dir for HF, file for GGUF)
    model_type: str                        # "vision" or "text"
    model_format: ModelFormat = ModelFormat.SAFETENSORS
    backend_engine: BackendEngine = BackendEngine.VLLM_MLX
    state: BackendState = BackendState.AVAILABLE
    supports_tools: bool = False           # Whether model chat template supports tool calls
    params: ModelParams = field(default_factory=ModelParams)  # Model config & generation defaults
    port: int = 0
    process: Optional[subprocess.Popen] = None
    pid: Optional[int] = None
    started_at: float = 0.0
    last_request_at: float = 0.0
    request_count: int = 0
    load_error: str = ""                   # Last error message for diagnostics
    _consecutive_failures: int = 0         # Retry tracking
    _load_lock: Optional[asyncio.Lock] = field(default=None, repr=False)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}" if self.port else ""

    @property
    def is_loaded(self) -> bool:
        return self.state == BackendState.READY

    def get_lock(self) -> asyncio.Lock:
        if self._load_lock is None:
            self._load_lock = asyncio.Lock()
        return self._load_lock


# ---------------------------------------------------------------------------
# InferenceRouter
# ---------------------------------------------------------------------------
class InferenceRouter:
    """
    On-demand multi-model router with idle eviction.
    Supports vllm-mlx (Apple), vllm (NVIDIA), and llama-cpp (GGUF).
    Thread-safe via per-model asyncio.Lock.
    """

    def __init__(
        self,
        port: int = 7090,
        internal_port_start: int = 7091,
        venv_path: Optional[str] = None,
        models_dir: Optional[str] = None,
        idle_timeout: int = 600,
        engine: str = "vllm-mlx",
        max_loaded_models: int = 2,
    ):
        self.port = port
        self._next_port = internal_port_start
        self._venv_path = Path(venv_path) if venv_path else self._auto_discover_venv()
        self._models_dir = Path(models_dir) if models_dir else None
        self._idle_timeout = idle_timeout
        self._max_loaded_models = max(1, max_loaded_models)
        self._default_engine = BackendEngine(engine) if engine in [e.value for e in BackendEngine] else BackendEngine.VLLM_MLX
        self._registry: Dict[str, ModelEntry] = {}
        self._started_at = time.time()
        self._reaper_task: Optional[asyncio.Task] = None
        self._log_dir = Path(os.getenv("AETHER_BACKEND_ROOT", ".")) / "logs"
        self._log_dir.mkdir(parents=True, exist_ok=True)
        self._stabilize_working_directory()
        # Per-model parameter overrides file (persists user changes across restarts)
        self._param_overrides_path = self._log_dir.parent / "model_param_overrides.json"
        self._param_overrides: Dict[str, Dict[str, Any]] = self._load_param_overrides()
        self._is_disposed = False

        # Handle any orphaned model backends from previous router crashes
        self._adopt_or_kill_orphaned_backends()

        # DAEMON ARCHITECTURE: Do NOT kill orphaned model backends here.
        # The inference server is a daemon — model backends (7091+) survive
        # app restarts by design.  If this server is replacing a crashed predecessor,
        # _load_model_on_demand() handles port conflicts by skipping occupied ports.
        # Background daemons (query agent, file indexing) may be actively using
        # those models.

    @staticmethod
    def _auto_discover_venv() -> Optional[Path]:
        """
        Standalone fallback: discover venv-inference when --venv not provided.
        
        In the managed pipeline (manager.py → server.py), --venv is always passed.
        This only runs when the server is started directly for debugging.
        
        Priority: INFERENCE_VENV_PATH env var > AETHER_BACKEND_ROOT > source tree.
        """
        candidates = []
        # 1. INFERENCE_VENV_PATH env var (set by start_production.sh orchestrator)
        env_venv = os.getenv("INFERENCE_VENV_PATH")
        if env_venv:
            candidates.append(Path(env_venv))
        # 2. AETHER_BACKEND_ROOT / venv-inference
        backend_root = os.getenv("AETHER_BACKEND_ROOT")
        if backend_root:
            candidates.append(Path(backend_root) / "venv-inference")
        # 3. Relative to this source file (services/aether_inference/server.py -> ../../venv-inference)
        candidates.append(Path(__file__).resolve().parent.parent.parent / "venv-inference")

        for candidate in candidates:
            python_bin = candidate / "bin" / "python"
            if python_bin.exists():
                logger.info("Auto-discovered inference venv: %s", candidate)
                return candidate

        logger.warning(
            "No venv-inference found (checked: %s). Engine subprocesses will use sys.executable.",
            ", ".join(str(c) for c in candidates),
        )
        return None

    def _stabilize_working_directory(self) -> None:
        """
        Ensure cwd is valid before any subprocess/model load work.

        Long-lived daemon processes can outlive a transient launch directory
        (for example, an unmounted DMG path). In that state, os.getcwd() raises
        FileNotFoundError and downstream libraries (torch/inspect) can fail while
        resolving relative module paths.
        """
        try:
            os.getcwd()
            return
        except FileNotFoundError:
            pass
        except Exception as e:
            logger.debug("Failed to stabilize working directory: %s", e)

        candidates = [
            os.getenv("AETHER_BACKEND_ROOT", ""),
            str(self._log_dir.parent),
            str(Path.home()),
            "/tmp",
            "/",
        ]

        for candidate in candidates:
            if not candidate:
                continue
            try:
                os.chdir(candidate)
                logger.warning("Recovered invalid cwd; switched to %s", candidate)
                return
            except Exception:
                continue

        logger.error("Failed to recover invalid cwd; model subprocesses may fail")

    def _adopt_or_kill_orphaned_backends(self) -> None:
        """
        Scan ports for orphaned model backends from a previous router crash.
        If a port is occupied, try to query /v1/models to adopt it.
        If it can't be adopted or isn't a recognized backend, kill it to prevent leaks.
        """
        import subprocess
        import httpx
        
        # Scan a reasonable range of ports where backends might be
        for port in range(self._next_port, self._next_port + 20):
            if self._is_port_available(port):
                continue
                
            logger.info("Port %d is occupied on startup. Probing to adopt or kill...", port)
            adopted = False
            try:
                # Synchronous request because we are in __init__ (before event loop runs heavily)
                with httpx.Client(timeout=2.0) as client:
                    resp = client.get(f"http://127.0.0.1:{port}/v1/models")
                    if resp.status_code == 200:
                        data = resp.json()
                        models = data.get("data", [])
                        if models:
                            model_id = models[0].get("id")
                            # Normalize model_id (some engines return full path)
                            if "/" in model_id and not Path(model_id).exists():
                                # Try to match against our registry or assume it's valid
                                pass
                            
                            logger.info("Adopting orphaned backend on port %d for model '%s'", port, model_id)
                            entry = self.register_model(model_id)
                            entry.state = BackendState.READY
                            entry.port = port
                            entry.last_request_at = time.time()
                            
                            # Find its PID so we can kill it later
                            result = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True)
                            if result.stdout.strip():
                                entry.pid = int(result.stdout.strip().split("\n")[0])
                                
                            adopted = True
            except Exception as e:
                logger.debug("Failed to adopt process on port %d: %s", port, e)

            if not adopted:
                logger.info("Killing unadoptable process on port %d to prevent memory leaks", port)
                try:
                    result = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True)
                    if result.stdout.strip():
                        for pid_str in result.stdout.strip().split("\n"):
                            try:
                                pid = int(pid_str.strip())
                                os.kill(pid, signal.SIGKILL)
                                logger.info("Sent SIGKILL to orphaned PID %d", pid)
                            except (ValueError, ProcessLookupError):
                                pass
                except Exception as e:
                    logger.warning("Error killing process on port %d: %s", port, e)

    # -- Parameter Override Persistence ------------------------------------

    def _load_param_overrides(self) -> Dict[str, Dict[str, Any]]:
        """Load per-model parameter overrides from persistent JSON file."""
        if self._param_overrides_path.exists():
            try:
                with open(self._param_overrides_path, "r") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    logger.info("Loaded %d model parameter overrides from %s", len(data), self._param_overrides_path)
                    return data
            except Exception as e:
                logger.warning("Failed to load param overrides: %s", e)
        return {}

    def _save_param_overrides(self) -> None:
        """Persist per-model parameter overrides to JSON file."""
        try:
            self._param_overrides_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._param_overrides_path, "w") as f:
                json.dump(self._param_overrides, f, indent=2)
            logger.debug("Saved param overrides to %s", self._param_overrides_path)
        except Exception as e:
            logger.error("Failed to save param overrides: %s", e)

    def _apply_param_overrides(self, model_id: str, params: ModelParams) -> ModelParams:
        """Apply any user overrides to extracted model params."""
        overrides = self._param_overrides.get(model_id)
        if not overrides:
            return params
        # Apply each override field
        for field_name, value in overrides.items():
            if hasattr(params, field_name):
                try:
                    expected_type = type(getattr(params, field_name))
                    setattr(params, field_name, expected_type(value))
                except (ValueError, TypeError):
                    logger.warning("Invalid override %s=%r for %s", field_name, value, model_id)
        logger.info("Applied param overrides for %s: %s", model_id, overrides)
        return params

    def update_model_params(self, model_id: str, updates: Dict[str, Any]) -> Optional[ModelParams]:
        """
        Update model parameters at runtime.
        
        Args:
            model_id: Model identifier
            updates: Dict of param name -> new value (e.g. {"context_length": 65536})
            
        Returns:
            Updated ModelParams or None if model not found.
            
        Side effects:
            - Updates registry entry params
            - Persists overrides to disk
            - If model is loaded and context_length changed, signals that restart is needed
        """
        entry = self._registry.get(model_id)
        if not entry:
            return None
        
        # Validate and apply updates
        changed_fields = {}
        for field_name, value in updates.items():
            if not hasattr(entry.params, field_name):
                continue
            old_value = getattr(entry.params, field_name)
            try:
                expected_type = type(old_value)
                new_value = expected_type(value)
                setattr(entry.params, field_name, new_value)
                changed_fields[field_name] = new_value
            except (ValueError, TypeError):
                logger.warning("Skipping invalid param %s=%r (expected %s)", field_name, value, type(old_value).__name__)
        
        if not changed_fields:
            return entry.params
        
        # Persist overrides
        if model_id not in self._param_overrides:
            self._param_overrides[model_id] = {}
        self._param_overrides[model_id].update(changed_fields)
        self._save_param_overrides()
        
        logger.info("Updated params for %s: %s", model_id, changed_fields)
        return entry.params

    # -- Discovery --------------------------------------------------------

    def discover_models(self) -> None:
        """
        Scan models_dir and register all found models as AVAILABLE.
        Supports:
          - HuggingFace format: org/model/ with config.json + (*.safetensors | *.bin)
          - GGUF format: org/model/*.gguf or flat *.gguf files
        """
        if not self._models_dir or not self._models_dir.exists():
            return

        # Pattern 1: Two-level org/model directories (HuggingFace + GGUF-in-dir)
        for org_dir in sorted(self._models_dir.iterdir()):
            if not org_dir.is_dir() or org_dir.name.startswith("."):
                continue
            for model_dir in sorted(org_dir.iterdir()):
                if not model_dir.is_dir() or model_dir.name.startswith("."):
                    continue

                model_id = f"{org_dir.name}/{model_dir.name}"
                if model_id in self._registry:
                    continue

                entry = self._probe_model_dir(model_id, model_dir)
                if entry:
                    self._registry[model_id] = entry
                    logger.info(
                        "Discovered model: %s (type=%s, format=%s, engine=%s, tools=%s)",
                        model_id, entry.model_type, entry.model_format.value,
                        entry.backend_engine.value, entry.supports_tools,
                    )

        # Pattern 2: Flat GGUF files directly in models_dir (no org/model nesting)
        for gguf_file in sorted(self._models_dir.glob("*.gguf")):
            model_id = gguf_file.stem
            if model_id in self._registry:
                continue
            entry = ModelEntry(
                model_id=model_id,
                model_path=str(gguf_file.resolve()),
                model_type="text",
                model_format=ModelFormat.GGUF,
                backend_engine=BackendEngine.LLAMA_CPP,
            )
            self._registry[model_id] = entry
            logger.info("Discovered flat GGUF model: %s", model_id)

        logger.info("Model registry: %d models available", len(self._registry))

    def _probe_model_dir(self, model_id: str, model_dir: Path) -> Optional[ModelEntry]:
        """
        Probe a model directory and return a ModelEntry if valid, else None.
        Determines format, type, and engine.
        """
        has_config = (model_dir / "config.json").exists()
        safetensor_files = list(model_dir.glob("*.safetensors"))
        bin_files = list(model_dir.glob("*.bin"))
        gguf_files = list(model_dir.glob("*.gguf"))

        model_format: Optional[ModelFormat] = None
        model_path: str = str(model_dir.resolve())

        if gguf_files:
            # GGUF: model_path is the specific .gguf file
            # Prefer the largest file (likely the full model, not a shard)
            gguf_files.sort(key=lambda f: f.stat().st_size, reverse=True)
            model_path = str(gguf_files[0].resolve())
            model_format = ModelFormat.GGUF
        elif has_config and safetensor_files:
            model_format = ModelFormat.SAFETENSORS
        elif has_config and bin_files:
            model_format = ModelFormat.PYTORCH
        else:
            # Not a recognizable model directory
            return None

        # Determine model type (vision vs text)
        model_type = self._detect_model_type(str(model_dir.resolve())) if has_config else "text"

        # Determine backend engine
        backend_engine = self._determine_engine(model_format)

        # Detect tool/function calling support
        supports_tools = self._detect_tool_support(str(model_dir.resolve()))

        # Extract model params (context_length, temperature defaults, etc.)
        params = self._extract_model_params(str(model_dir.resolve()))
        # Apply any user-persisted param overrides (e.g., context_length changed via UI)
        params = self._apply_param_overrides(model_id, params)

        return ModelEntry(
            model_id=model_id,
            model_path=model_path,
            model_type=model_type,
            model_format=model_format,
            backend_engine=backend_engine,
            supports_tools=supports_tools,
            params=params,
        )

    def _determine_engine(self, model_format: ModelFormat) -> BackendEngine:
        """
        Select backend engine based on model format and platform default.
        GGUF always uses llama-cpp. Others use platform default.
        """
        if model_format == ModelFormat.GGUF:
            return BackendEngine.LLAMA_CPP
        return self._default_engine

    def register_model(self, model_id: str, model_type: Optional[str] = None) -> ModelEntry:
        """Register a model (by HF ID or path) without loading it."""
        if model_id in self._registry:
            return self._registry[model_id]

        model_path = self._resolve_model_path(model_id)
        resolved_path = Path(model_path)

        # Detect format
        model_format = ModelFormat.SAFETENSORS
        if resolved_path.is_file() and resolved_path.suffix == ".gguf":
            model_format = ModelFormat.GGUF
        elif resolved_path.is_dir():
            if any(resolved_path.glob("*.gguf")):
                gguf_files = sorted(resolved_path.glob("*.gguf"), key=lambda f: f.stat().st_size, reverse=True)
                model_path = str(gguf_files[0].resolve())
                model_format = ModelFormat.GGUF
            elif any(resolved_path.glob("*.safetensors")):
                model_format = ModelFormat.SAFETENSORS
            elif any(resolved_path.glob("*.bin")):
                model_format = ModelFormat.PYTORCH

        # Detect type
        if model_type is None:
            model_type = self._detect_model_type(model_path)

        backend_engine = self._determine_engine(model_format)
        supports_tools = self._detect_tool_support(model_path)
        params = self._extract_model_params(model_path)
        # Apply any user-persisted param overrides (e.g., context_length changed via UI)
        params = self._apply_param_overrides(model_id, params)

        entry = ModelEntry(
            model_id=model_id,
            model_path=model_path,
            model_type=model_type,
            model_format=model_format,
            backend_engine=backend_engine,
            supports_tools=supports_tools,
            params=params,
        )
        self._registry[model_id] = entry
        logger.info(
            "Registered model: %s (type=%s, format=%s, engine=%s, tools=%s, ctx=%d)",
            model_id, model_type, model_format.value, backend_engine.value,
            supports_tools, params.context_length,
        )
        return entry

    # -- Model resolution -------------------------------------------------

    def _resolve_model_path(self, model_id: str) -> str:
        if os.path.isabs(model_id) and (Path(model_id).is_dir() or Path(model_id).is_file()):
            return model_id
        if self._models_dir:
            local_path = self._models_dir / model_id
            if local_path.is_dir() and ((local_path / "config.json").exists()
                                        or any(local_path.glob("*.gguf"))):
                return str(local_path.resolve())
            # Check if it's a direct GGUF file reference
            gguf_path = self._models_dir / f"{model_id}.gguf"
            if gguf_path.is_file():
                return str(gguf_path.resolve())
        return model_id

    def _detect_model_type(self, model_path: str) -> str:
        """Detect vision vs text from config.json. GGUF files are always text."""
        path = Path(model_path)
        # For GGUF files, the config is in parent dir (if present)
        config_path = path / "config.json" if path.is_dir() else path.parent / "config.json"
        if config_path and config_path.exists():
            try:
                config = json.loads(config_path.read_text())
                if config.get("model_type", "").lower() in _VISION_MODEL_TYPES:
                    return "vision"
                if any(k in config for k in _VISION_CONFIG_KEYS):
                    return "vision"
            except Exception as e:
                logger.debug("Failed to detect model type from config: %s", e)
        return "text"

    @staticmethod
    def _extract_model_params(model_path: str) -> ModelParams:
        """
        Extract model parameters from config.json + generation_config.json.
        
        Reads context_length, vocab_size, hidden_size, num_layers from config.json
        (checking both top-level and nested text_config for VLM models).
        Reads temperature, top_p, top_k, do_sample from generation_config.json.
        
        Returns ModelParams with sensible defaults for any missing fields.
        """
        params = ModelParams()
        path = Path(model_path)
        config_path = path / "config.json" if path.is_dir() else path.parent / "config.json"
        gen_config_path = path / "generation_config.json" if path.is_dir() else path.parent / "generation_config.json"

        if config_path and config_path.exists():
            try:
                config = json.loads(config_path.read_text())

                # Context length: check top-level first, then text_config (for VLMs)
                ctx = config.get("max_position_embeddings", 0)
                if not ctx:
                    for nested_key in ("text_config", "language_config", "llm_config"):
                        nested = config.get(nested_key)
                        if isinstance(nested, dict):
                            ctx = nested.get("max_position_embeddings", 0)
                            if ctx:
                                break
                if ctx:
                    params.context_length = ctx

                # Architecture params (top-level or nested)
                def _get(key: str, default: int = 0) -> int:
                    val = config.get(key, 0)
                    if not val:
                        for nk in ("text_config", "language_config", "llm_config"):
                            n = config.get(nk)
                            if isinstance(n, dict):
                                val = n.get(key, 0)
                                if val:
                                    break
                    return val or default

                params.vocab_size = _get("vocab_size")
                params.hidden_size = _get("hidden_size")
                params.num_layers = _get("num_hidden_layers")

            except Exception as e:
                logger.debug("Failed to extract model params from config: %s", e)

        # Generation defaults from generation_config.json
        if gen_config_path and gen_config_path.exists():
            try:
                gen = json.loads(gen_config_path.read_text())
                if "temperature" in gen:
                    params.default_temperature = float(gen["temperature"])
                if "top_p" in gen:
                    params.default_top_p = float(gen["top_p"])
                if "top_k" in gen:
                    params.default_top_k = int(gen["top_k"])
                if "do_sample" in gen:
                    params.do_sample = bool(gen["do_sample"])
                if "repetition_penalty" in gen:
                    params.repeat_penalty = float(gen["repetition_penalty"])
                if "max_new_tokens" in gen:
                    params.default_max_tokens = int(gen["max_new_tokens"])
            except Exception as e:
                logger.debug("Failed to extract generation config: %s", e)

        # Sensible default_max_tokens: min(context/2, 8192) -- leave room for input
        if params.default_max_tokens == 2048 and params.context_length > 8192:
            params.default_max_tokens = min(params.context_length // 2, 8192)

        return params

    @staticmethod
    def _detect_tool_support(model_path: str) -> bool:
        """
        Detect if a model supports tool/function calling.
        
        Checks the chat_template.jinja for tool-related patterns.
        Models like LFM, Qwen3, and GLM-OCR all include tool_call sections
        in their Jinja templates when they support function calling.
        """
        path = Path(model_path)
        template_path = path / "chat_template.jinja" if path.is_dir() else path.parent / "chat_template.jinja"
        if template_path and template_path.exists():
            try:
                template_text = template_path.read_text()
                # All known tool-supporting models use these patterns:
                # - {% if tools %} or {%- if tools -%} for tool definitions
                # - <tool_call> for tool invocation format
                # - tool_calls for assistant tool call messages
                if "tools" in template_text and "tool_call" in template_text:
                    return True
            except Exception as e:
                logger.debug("Failed to read chat template for tool support detection: %s", e)
        # Also check tokenizer_config.json for chat_template field (inline templates)
        tokenizer_config = path / "tokenizer_config.json" if path.is_dir() else path.parent / "tokenizer_config.json"
        if tokenizer_config and tokenizer_config.exists():
            try:
                tc = json.loads(tokenizer_config.read_text())
                chat_tmpl = tc.get("chat_template", "")
                if isinstance(chat_tmpl, str) and "tools" in chat_tmpl and "tool_call" in chat_tmpl:
                    return True
            except Exception as e:
                logger.debug("Failed to read tokenizer config for tool support detection: %s", e)
        return False

    def _allocate_port(self) -> int:
        """Allocate the next free port, skipping any already in use.

        Daemon architecture: model backends from a previous inference server
        may still be alive (start_new_session=True).  Instead of killing them,
        skip occupied ports so the new server coexists until the old backends
        idle-timeout or are explicitly unloaded by the user.
        """
        max_attempts = 20  # Avoid infinite loop on pathological port exhaustion
        for _ in range(max_attempts):
            port = self._next_port
            self._next_port += 1
            if self._is_port_available(port):
                return port
            logger.info("Port %d occupied (likely daemon model backend from previous session) — skipping", port)
        # Fallback: return next port anyway and let subprocess fail with a clear error
        logger.warning("No free port found in %d attempts starting from %d", max_attempts, self._next_port - max_attempts)
        port = self._next_port
        self._next_port += 1
        return port

    @staticmethod
    def _is_port_available(port: int) -> bool:
        """Check if a TCP port is available for binding."""
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return True
            except OSError:
                return False

    # -- Binary resolution ------------------------------------------------

    def _get_python_binary(self) -> str:
        """Get python from the inference venv (for vllm-mlx, llama-cpp)."""
        if self._venv_path:
            venv_python = self._venv_path / "bin" / "python"
            if venv_python.exists():
                return str(venv_python)
        return sys.executable

    def _get_vllm_binary(self) -> str:
        """Get the vllm CLI binary (for NVIDIA vLLM)."""
        if self._venv_path:
            vllm_bin = self._venv_path / "bin" / "vllm"
            if vllm_bin.exists():
                return str(vllm_bin)
        found = shutil.which("vllm")
        if found:
            return found
        # Fallback: try python -m vllm.entrypoints.openai.api_server
        return self._get_python_binary()

    def _get_llama_cpp_binary(self) -> str:
        """
        Get the llama-cpp-python server binary.
        Falls back to llama-server (standalone llama.cpp) if available.
        """
        python_bin = self._get_python_binary()
        # Check if llama_cpp is importable from venv
        # We'll use python -m llama_cpp.server as the command
        return python_bin

    # -- Lazy loading / unloading -----------------------------------------

    async def ensure_loaded(self, model_id: str) -> ModelEntry:
        """
        Ensure a model backend is running. Loads on demand if needed.
        Per-model lock prevents duplicate loads. Respects retry limit.
        """
        entry = self._registry.get(model_id)
        if entry is None:
            raise HTTPException(
                status_code=404,
                detail=f"Model '{model_id}' not found. Available: {list(self._registry.keys())}",
            )

        # Fast path: already loaded
        if entry.is_loaded:
            entry.last_request_at = time.time()
            entry.request_count += 1
            return entry

        # Circuit breaker: stop retrying after too many consecutive failures
        if entry._consecutive_failures >= _MAX_LOAD_RETRIES:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Model '{model_id}' failed to load after {entry._consecutive_failures} attempts. "
                    f"Last error: {entry.load_error or 'unknown'}. "
                    f"Restart the server or fix the issue to retry."
                ),
            )

        # Slow path: acquire per-model lock
        async with entry.get_lock():
            # Double-check after lock acquisition
            if entry.is_loaded:
                entry.last_request_at = time.time()
                entry.request_count += 1
                return entry

            if entry.state == BackendState.ERROR:
                await self._stop_backend(entry)

            # Evict least-recently-used model(s) if at capacity
            await self._evict_lru_if_at_capacity(model_id)

            await self._start_backend(entry)

            if not entry.is_loaded:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        f"Model '{model_id}' failed to load (engine={entry.backend_engine.value}). "
                        f"Error: {entry.load_error or 'health check timeout'}. "
                        f"Attempts: {entry._consecutive_failures}/{_MAX_LOAD_RETRIES}."
                    ),
                )

            entry.last_request_at = time.time()
            entry.request_count += 1
            return entry

    async def _evict_lru_if_at_capacity(self, exclude_model_id: str) -> None:
        """
        Enforce max_loaded_models limit by evicting least-recently-used model(s).

        Called BEFORE loading a new model. Evicts the oldest-idle model(s) until
        the loaded count is below the limit, making room for the incoming model.
        Skips the model about to be loaded (exclude_model_id).
        """
        loaded = [
            e for e in self._registry.values()
            if e.state == BackendState.READY and e.model_id != exclude_model_id
        ]
        evict_count = len(loaded) - self._max_loaded_models + 1  # +1 = room for the new model
        if evict_count <= 0:
            return

        # Sort by last_request_at ascending (least recently used first)
        loaded.sort(key=lambda e: e.last_request_at or e.started_at)
        for i in range(min(evict_count, len(loaded))):
            victim = loaded[i]
            logger.info(
                "LRU eviction: unloading %s (idle %.0fs) to stay within max_loaded_models=%d",
                victim.model_id,
                time.time() - (victim.last_request_at or victim.started_at),
                self._max_loaded_models,
            )
            await self._stop_backend(victim)

    async def _start_backend(self, entry: ModelEntry) -> None:
        """Spawn a backend process for a model. Command varies by engine."""
        self._stabilize_working_directory()
        entry.state = BackendState.LOADING
        entry.port = self._allocate_port()
        entry.load_error = ""

        cmd = self._build_backend_command(entry)

        log_file = self._log_dir / f"inference-{entry.model_id.replace('/', '_')}-{entry.port}.log"
        logger.info(
            "Loading model on-demand: %s (engine=%s, type=%s, format=%s, port=%d)",
            entry.model_id, entry.backend_engine.value, entry.model_type,
            entry.model_format.value, entry.port,
        )
        logger.info("  cmd: %s", " ".join(cmd))

        log_handle = None
        try:
            log_handle = open(log_file, "w")  # Overwrite for clean diagnostics
            entry.process = subprocess.Popen(
                cmd,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
                cwd=str(self._log_dir.parent),
            )
            entry.pid = entry.process.pid
            entry.started_at = time.time()

            healthy = await self._wait_healthy(entry, timeout=180)
            if healthy:
                entry.state = BackendState.READY
                entry._consecutive_failures = 0  # Reset on success
                entry.load_error = ""
                logger.info(
                    "Model ready: %s (engine=%s, port=%d, PID=%d, load_time=%.1fs)",
                    entry.model_id, entry.backend_engine.value, entry.port, entry.pid,
                    time.time() - entry.started_at,
                )
            else:
                entry.state = BackendState.ERROR
                entry._consecutive_failures += 1
                # Capture stderr/stdout from the log file for diagnostics
                entry.load_error = self._tail_log(log_file, lines=20)
                logger.error(
                    "Model failed health check: %s (engine=%s, port=%d, attempt=%d/%d)",
                    entry.model_id, entry.backend_engine.value, entry.port,
                    entry._consecutive_failures, _MAX_LOAD_RETRIES,
                )
                if entry.load_error:
                    logger.error("Backend log tail:\n%s", entry.load_error)
        except Exception as e:
            entry.state = BackendState.ERROR
            entry._consecutive_failures += 1
            entry.load_error = str(e)
            logger.error("Failed to start backend for %s: %s", entry.model_id, e)
        finally:
            # Close the log file handle to prevent fd leak.
            # The subprocess has already inherited the fd via Popen, so closing
            # the parent's handle does not affect the child's stdout/stderr.
            if log_handle is not None:
                try:
                    log_handle.close()
                except Exception as e:
                    logger.debug("Error closing log handle for backend: %s", e)

    @staticmethod
    def _tail_log(log_file: Path, lines: int = 20) -> str:
        """Read last N lines from a log file for error diagnostics."""
        try:
            if not log_file.exists():
                return ""
            text = log_file.read_text(errors="replace")
            all_lines = text.strip().splitlines()
            tail = all_lines[-lines:] if len(all_lines) > lines else all_lines
            return "\n".join(tail)
        except Exception:
            return ""

    def _build_backend_command(self, entry: ModelEntry) -> List[str]:
        """
        Build the subprocess command for a backend based on its engine.
        
        CRITICAL: Pass model params (max_tokens, context_length, reasoning parser)
        to each engine so models launch with correct capabilities.
        ALWAYS bind strictly to 127.0.0.1 to prevent LAN exposure bypassing the router proxy.

        vllm-mlx : python -m vllm_mlx.server --model PATH --port PORT --host 127.0.0.1 [--mllm] [--max-tokens N] [--reasoning-parser X]
        vllm     : vllm serve PATH --port PORT --host 127.0.0.1 [--dtype auto] [--max-model-len N]
        llama-cpp: llama-server --model PATH --host 127.0.0.1 --port PORT [--ctx-size N]
        """
        p = entry.params  # Shorthand for model params

        if entry.backend_engine == BackendEngine.VLLM_MLX:
            python_bin = self._get_python_binary()
            cmd = [
                python_bin, "-m", "vllm_mlx.server",
                "--model", entry.model_path,
                "--port", str(entry.port),
                "--host", "127.0.0.1",
            ]
            if entry.model_type == "vision":
                cmd.append("--mllm")
            # Pass max generation tokens from model params (extracted from config.json)
            if p.default_max_tokens and p.default_max_tokens > 0:
                cmd.extend(["--max-tokens", str(p.default_max_tokens)])
            # Enable reasoning parser ONLY for explicit thinking/reasoning model
            # variants.  Qwen3-*-Instruct does NOT use <think> tags — only
            # Qwen3-*-Thinking does.  Applying the parser to a non-thinking
            # model routes ALL content to reasoning_content (content=null),
            # which breaks LiteLLM and other OpenAI-compatible consumers.
            # PRO-FIX: Removed Qwen3-4b-Instruct-2507-MLX-8bit from reasoning parser check as it causes the inference server to hang
            model_lower = entry.model_id.lower()
            is_thinking_variant = "thinking" in model_lower or "think" in model_lower
            if "qwen3" in model_lower and is_thinking_variant:
                cmd.extend(["--reasoning-parser", "qwen3"])
            elif "deepseek" in model_lower and ("r1" in model_lower or "reasoner" in model_lower or is_thinking_variant):
                cmd.extend(["--reasoning-parser", "deepseek_r1"])
            return cmd

        elif entry.backend_engine == BackendEngine.VLLM:
            vllm_bin = self._get_vllm_binary()
            if vllm_bin.endswith("python") or vllm_bin.endswith("python3"):
                cmd = [
                    vllm_bin, "-m", "vllm.entrypoints.openai.api_server",
                    "--model", entry.model_path,
                    "--port", str(entry.port),
                    "--host", "127.0.0.1",
                    "--dtype", "auto",
                ]
            else:
                cmd = [
                    vllm_bin, "serve", entry.model_path,
                    "--port", str(entry.port),
                    "--host", "127.0.0.1",
                    "--dtype", "auto",
                ]
            # Pass context window explicitly so vllm doesn't auto-pick a smaller one
            if p.context_length and p.context_length > 0:
                cmd.extend(["--max-model-len", str(p.context_length)])
            return cmd

        elif entry.backend_engine == BackendEngine.LLAMA_CPP:
            python_bin = self._get_python_binary()
            llama_server = None
            if self._venv_path:
                candidate = self._venv_path / "bin" / "llama-server"
                if candidate.exists():
                    llama_server = str(candidate)
            if not llama_server:
                llama_server = shutil.which("llama-server")

            if llama_server:
                cmd = [
                    llama_server,
                    "--model", entry.model_path,
                    "--host", "127.0.0.1",
                    "--port", str(entry.port),
                ]
            else:
                cmd = [
                    python_bin, "-m", "llama_cpp.server",
                    "--model", entry.model_path,
                    "--host", "127.0.0.1",
                    "--port", str(entry.port),
                ]
            # Pass context size for llama-cpp (critical: default is often 512 or 2048)
            ctx = p.context_length if p.context_length > 0 else 8192
            cmd.extend(["--ctx-size", str(ctx)])
            return cmd

        else:
            raise ValueError(f"Unsupported backend engine: {entry.backend_engine}")

    async def _stop_backend(self, entry: ModelEntry) -> None:
        """Stop a running backend process and release its port."""
        if entry.process is None:
            entry.state = BackendState.AVAILABLE
            entry.port = 0
            entry.pid = None
            return

        prev_state = entry.state
        entry.state = BackendState.STOPPING

        logger.info(
            "Unloading model: %s (engine=%s, port=%d, PID=%d, was=%s, requests=%d, idle=%.0fs)",
            entry.model_id, entry.backend_engine.value, entry.port, entry.pid or 0,
            prev_state.value, entry.request_count,
            time.time() - entry.last_request_at if entry.last_request_at else 0,
        )

        try:
            if entry.process.poll() is None:
                os.killpg(os.getpgid(entry.pid), signal.SIGTERM)
                try:
                    entry.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    logger.warning("Backend %s did not stop gracefully, sending SIGKILL", entry.model_id)
                    os.killpg(os.getpgid(entry.pid), signal.SIGKILL)
                    entry.process.wait(timeout=5)
        except ProcessLookupError:
            pass
        except Exception as e:
            logger.warning("Error stopping backend %s: %s", entry.model_id, e)

        entry.process = None
        entry.pid = None
        entry.port = 0
        entry.state = BackendState.AVAILABLE
        entry.request_count = 0

    async def _wait_healthy(self, entry: ModelEntry, timeout: int = 180) -> bool:
        """
        Poll backend health until ready or timeout.
        Handles different health endpoint patterns across engines:
          vllm-mlx : /health -> {"model_loaded": true}
          vllm     : /health -> 200 OK (empty body or {"status":"ok"})
          llama-cpp: /health -> {"status":"ok"} or /v1/models -> 200
        """
        start = time.time()
        delays = [1, 2, 4, 8, 8]
        attempt = 0

        while (time.time() - start) < timeout:
            if entry.process and entry.process.poll() is not None:
                logger.error(
                    "Backend process exited with code %d (engine=%s)",
                    entry.process.returncode, entry.backend_engine.value,
                )
                return False

            try:
                async with httpx.AsyncClient(timeout=3.0) as client:
                    # Try /health first (works for all engines)
                    try:
                        resp = await client.get(f"{entry.base_url}/health")
                        if resp.status_code == 200:
                            try:
                                data = resp.json()
                                # vllm-mlx returns {"model_loaded": true/false}
                                if data.get("model_loaded", False):
                                    return True
                                # vllm and llama-cpp return {"status": "ok"/"healthy"}
                                if data.get("status") in ("ok", "healthy", "ready"):
                                    return True
                            except (json.JSONDecodeError, ValueError):
                                # Plain 200 OK with no JSON body -- server is up
                                return True
                    except (httpx.ConnectError, httpx.TimeoutException):
                        pass

                    # Fallback: /v1/models (OpenAI-compatible, all engines support this)
                    try:
                        resp = await client.get(f"{entry.base_url}/v1/models")
                        if resp.status_code == 200:
                            data = resp.json()
                            models = data.get("data", [])
                            if models:
                                return True
                    except (httpx.ConnectError, httpx.TimeoutException):
                        pass
                    except Exception as e:
                        logger.debug("Health check fallback /v1/models failed: %s", e)

            except Exception as e:
                logger.debug("Health check iteration failed: %s", e)

            delay = delays[attempt] if attempt < len(delays) else 5
            attempt += 1
            await asyncio.sleep(delay)

        return False

    # -- Idle reaper ------------------------------------------------------

    async def start_reaper(self) -> None:
        """Start the background idle eviction task."""
        self._reaper_task = asyncio.create_task(self._reaper_loop())
        logger.info("Idle reaper started (timeout=%ds, check_interval=60s)", self._idle_timeout)

    async def _reaper_loop(self) -> None:
        """Periodically check for idle backends and evict them."""
        while not self._is_disposed:
            try:
                await asyncio.sleep(60)
                now = time.time()

                for entry in list(self._registry.values()):
                    if entry.state != BackendState.READY:
                        continue

                    idle_seconds = now - entry.last_request_at if entry.last_request_at else now - entry.started_at

                    if idle_seconds >= self._idle_timeout:
                        logger.info(
                            "Evicting idle model: %s (idle %.0fs > %ds threshold)",
                            entry.model_id, idle_seconds, self._idle_timeout,
                        )
                        await self._stop_backend(entry)

                    # Crash recovery: detect dead processes.
                    # Reset _consecutive_failures so the circuit breaker doesn't
                    # permanently block reload after a transient crash (e.g. OOM).
                    # The crash itself is a different failure mode than a health-check
                    # timeout during _start_backend — it warrants a fresh retry budget.
                    elif entry.process and entry.process.poll() is not None:
                        logger.warning(
                            "Backend %s crashed (exit code %d), marking available for reload "
                            "(resetting failure counter from %d)",
                            entry.model_id, entry.process.returncode,
                            entry._consecutive_failures,
                        )
                        entry.process = None
                        entry.pid = None
                        entry.port = 0
                        entry.state = BackendState.AVAILABLE
                        entry._consecutive_failures = 0
                        entry.load_error = ""

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Reaper error: %s", e)

    # -- Request routing --------------------------------------------------

    def find_model_id(self, requested: Optional[str], has_images: bool = False) -> Optional[str]:
        """
        Resolve a request's model field to a registered model_id.
        1. Exact match
        2. Partial/substring match
        3. Content-based: images -> vision, text -> text
        4. Any available
        """
        if not self._registry:
            return None

        if requested and requested in self._registry:
            return requested

        if requested:
            req_lower = requested.lower()
            for mid, entry in self._registry.items():
                if req_lower in mid.lower() or mid.lower() in req_lower:
                    return mid
                path_name = Path(entry.model_path).name.lower()
                if req_lower in path_name or path_name in req_lower:
                    return mid

        target_type = "vision" if has_images else "text"
        for mid, entry in self._registry.items():
            if entry.model_type == target_type:
                return mid

        return next(iter(self._registry))

    def request_has_images(self, messages: List[Any]) -> bool:
        """Check if messages contain image/video content."""
        for msg in messages:
            content = msg.get("content") if isinstance(msg, dict) else None
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        ptype = part.get("type", "")
                        if ptype in ("image_url", "image", "video_url"):
                            return True
        return False

    # -- Proxy ------------------------------------------------------------

    async def proxy_request(
        self,
        entry: ModelEntry,
        method: str,
        path: str,
        body: Optional[bytes] = None,
        headers: Optional[Dict[str, str]] = None,
        stream: bool = False,
    ):
        """Proxy an HTTP request to a backend."""
        url = f"{entry.base_url}{path}"

        proxy_headers = {}
        if headers:
            for k, v in headers.items():
                if k.lower() in ("content-type", "accept", "authorization"):
                    proxy_headers[k] = v

        timeout = httpx.Timeout(connect=5.0, read=300.0, write=30.0, pool=30.0)

        if stream:
            async def stream_generator():
                client = httpx.AsyncClient(timeout=timeout)
                try:
                    async with client.stream(method, url, content=body, headers=proxy_headers) as resp:
                        # Check status BEFORE streaming body.  Backend errors
                        # (OOM, invalid prompt, context overflow) return 4xx/5xx
                        # with a JSON body — not SSE chunks.  Yielding that raw
                        # would corrupt the client's SSE parser.  Convert to a
                        # single SSE error event so the client can handle it.
                        if resp.status_code >= 400:
                            error_bytes = await resp.aread()
                            try:
                                err_detail = json.loads(error_bytes).get("error", {})
                                if isinstance(err_detail, dict):
                                    err_msg = err_detail.get("message", error_bytes.decode(errors="replace"))
                                else:
                                    err_msg = str(err_detail)
                            except (json.JSONDecodeError, UnicodeDecodeError):
                                err_msg = error_bytes.decode(errors="replace")[:500]
                            sse_error = json.dumps({
                                "error": {"message": err_msg, "type": "backend_error", "code": resp.status_code},
                            })
                            yield f"data: {sse_error}\n\n".encode()
                            yield b"data: [DONE]\n\n"
                            return
                        async for chunk in resp.aiter_bytes():
                            yield chunk
                finally:
                    await client.aclose()

            return stream_generator
        else:
            async with httpx.AsyncClient(timeout=timeout) as client:
                return await client.request(method, url, content=body, headers=proxy_headers)

    # -- Shutdown ---------------------------------------------------------

    async def shutdown(self) -> None:
        """Stop all backends and cancel reaper."""
        self._is_disposed = True
        if self._reaper_task:
            self._reaper_task.cancel()
            try:
                await self._reaper_task
            except asyncio.CancelledError:
                pass

        for entry in list(self._registry.values()):
            if entry.state in (BackendState.READY, BackendState.LOADING, BackendState.ERROR):
                await self._stop_backend(entry)

        logger.info("All backends stopped")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------
router_instance: Optional[InferenceRouter] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: discover models, start reaper."""
    if router_instance:
        router_instance.discover_models()
        await router_instance.start_reaper()
    yield
    if router_instance:
        await router_instance.shutdown()


app = FastAPI(title="Aether Inference", version="2.0.0", lifespan=lifespan)

# Dynamic CORS
allow_external = os.getenv("AETHER_ALLOW_EXTERNAL_BIND", "false").lower() == "true"
if allow_external:
    allowed_origins = ["*"]
else:
    allowed_origins = [
        "http://localhost",
        "http://localhost:54321",
        "http://127.0.0.1:54321",
        "http://localhost:8765",
        "http://127.0.0.1:8765",
        "app://.",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "tauri://localhost",
        "null",
        "file://",
        "app://",
        "aether://",
        "aether://."
    ]

cors_env = os.getenv("AETHER_CORS_ALLOWED_ORIGINS")
if cors_env:
    allowed_origins.extend([o.strip() for o in cors_env.split(",") if o.strip()])

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -- Endpoints -----------------------------------------------------------

@app.get("/health")
async def health():
    """Health check. Router is healthy if initialized."""
    if not router_instance:
        raise HTTPException(status_code=503, detail="Router not initialized")

    loaded = []
    available = []

    for mid, entry in router_instance._registry.items():
        info = {
            "model_id": mid,
            "model_type": entry.model_type,
            "model_format": entry.model_format.value,
            "backend_engine": entry.backend_engine.value,
            "state": entry.state.value,
            "supports_tools": entry.supports_tools,
            "context_length": entry.params.context_length,
        }
        if entry.is_loaded:
            info["port"] = entry.port
            info["pid"] = entry.pid
            info["idle_seconds"] = round(time.time() - entry.last_request_at, 0) if entry.last_request_at else 0
            info["request_count"] = entry.request_count
            loaded.append(info)
        else:
            if entry.load_error:
                info["last_error"] = entry.load_error[:200]
            available.append(info)

    return JSONResponse({
        "status": "healthy",
        "model_loaded": len(loaded) > 0,
        "model_count": len(router_instance._registry),
        "loaded_count": len(loaded),
        "max_loaded_models": router_instance._max_loaded_models,
        "idle_timeout": router_instance._idle_timeout,
        "default_engine": router_instance._default_engine.value,
        "loaded": loaded,
        "available": available,
        "uptime_seconds": round(time.time() - router_instance._started_at, 1),
    })


@app.get("/v1/models")
async def list_models():
    """
    List ALL available models (loaded + available).
    The 'status' field indicates warm ('ready') or cold ('available').
    """
    if not router_instance:
        return {"object": "list", "data": []}

    models = []
    for mid, entry in router_instance._registry.items():
        model_info = {
            "id": mid,
            "object": "model",
            "created": int(entry.started_at) if entry.started_at else int(router_instance._started_at),
            "owned_by": "aether-inference",
            "model_type": entry.model_type,
            "model_format": entry.model_format.value,
            "backend_engine": entry.backend_engine.value,
            "status": entry.state.value,
            "supports_tools": entry.supports_tools,
            "capabilities": {
                "vision": entry.model_type == "vision",
                "tool_use": entry.supports_tools,
                "streaming": True,
            },
            "parameters": {
                "context_length": entry.params.context_length,
                "default_temperature": entry.params.default_temperature,
                "default_top_p": entry.params.default_top_p,
                "default_top_k": entry.params.default_top_k,
                "default_max_tokens": entry.params.default_max_tokens,
                "repeat_penalty": entry.params.repeat_penalty,
                "do_sample": entry.params.do_sample,
            },
            "architecture": {
                "vocab_size": entry.params.vocab_size,
                "hidden_size": entry.params.hidden_size,
                "num_layers": entry.params.num_layers,
            },
        }
        models.append(model_info)

    return {"object": "list", "data": models}


@app.patch("/v1/models/{model_id:path}/params")
async def update_model_params(model_id: str, request: Request):
    """
    Update model parameters at runtime (context_length, max_tokens, temperature, etc.).
    
    Persists changes to model_param_overrides.json so they survive server restarts.
    If context_length or default_max_tokens changes for a LOADED model, the engine
    subprocess needs restart — the response indicates this with 'restart_required'.
    
    Request body example:
        {"context_length": 65536, "default_max_tokens": 8192, "default_temperature": 0.6}
    
    Allowed fields: context_length, default_temperature, default_top_p, default_top_k,
                    default_max_tokens, repeat_penalty, do_sample
    """
    if not router_instance:
        raise HTTPException(status_code=503, detail="Router not initialized")
    
    entry = router_instance._registry.get(model_id)
    if not entry:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found in registry")
    
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    
    if not isinstance(body, dict) or not body:
        raise HTTPException(status_code=400, detail="Request body must be a non-empty JSON object")
    
    # Whitelist of updatable fields (exclude architecture fields like vocab_size/num_layers)
    ALLOWED_FIELDS = {
        "context_length", "default_temperature", "default_top_p", "default_top_k",
        "default_max_tokens", "repeat_penalty", "do_sample",
    }
    filtered = {k: v for k, v in body.items() if k in ALLOWED_FIELDS}
    
    if not filtered:
        raise HTTPException(
            status_code=400,
            detail=f"No valid fields to update. Allowed: {sorted(ALLOWED_FIELDS)}"
        )
    
    # Check if engine restart is needed (context_length or max_tokens changed for loaded model)
    restart_required = False
    if entry.is_loaded:
        engine_affecting = {"context_length", "default_max_tokens"}
        if engine_affecting & set(filtered.keys()):
            restart_required = True
    
    # Apply updates
    updated_params = router_instance.update_model_params(model_id, filtered)
    if not updated_params:
        raise HTTPException(status_code=500, detail="Failed to update params")
    
    return JSONResponse({
        "model_id": model_id,
        "updated_fields": list(filtered.keys()),
        "restart_required": restart_required,
        "parameters": {
            "context_length": updated_params.context_length,
            "default_temperature": updated_params.default_temperature,
            "default_top_p": updated_params.default_top_p,
            "default_top_k": updated_params.default_top_k,
            "default_max_tokens": updated_params.default_max_tokens,
            "repeat_penalty": updated_params.repeat_penalty,
            "do_sample": updated_params.do_sample,
        },
        "message": (
            "Parameters updated. Model restart required for engine-level changes to take effect."
            if restart_required else
            "Parameters updated and persisted."
        ),
    })


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """Route chat completion. Loads model on demand if needed."""
    content_type = request.headers.get("content-type", "").lower()
    if not content_type.startswith("application/json"):
        raise HTTPException(status_code=415, detail="Content-Type must be application/json to prevent CSRF")

    if not router_instance:
        raise HTTPException(status_code=503, detail="Router not initialized")

    body_bytes = await request.body()
    try:
        payload = json.loads(body_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    requested_model = payload.get("model")
    messages = payload.get("messages", [])
    stream = payload.get("stream", False)
    has_images = router_instance.request_has_images(messages)
    has_tools = bool(payload.get("tools"))

    model_id = router_instance.find_model_id(requested_model, has_images=has_images)
    if model_id is None:
        raise HTTPException(status_code=404, detail="No models registered")

    entry = await router_instance.ensure_loaded(model_id)

    # Warn (but don't block) if tools requested on a model without tool support
    if has_tools and not entry.supports_tools:
        logger.warning(
            "Tool calls requested but model %s may not support tools (no tool template detected)",
            model_id,
        )

    if stream:
        generator_fn = await router_instance.proxy_request(
            entry, "POST", "/v1/chat/completions",
            body=body_bytes,
            headers={"content-type": "application/json", "accept": "text/event-stream"},
            stream=True,
        )
        return StreamingResponse(
            generator_fn(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    resp = await router_instance.proxy_request(
        entry, "POST", "/v1/chat/completions",
        body=body_bytes,
        headers={"content-type": "application/json"},
    )

    if resp.status_code >= 400:
        try:
            err_body = resp.json()
        except Exception:
            err_body = {"error": resp.text}
        return JSONResponse(status_code=resp.status_code, content=err_body)

    return JSONResponse(content=resp.json(), status_code=resp.status_code)


@app.post("/v1/completions")
async def completions(request: Request):
    """Route text completions. On-demand loading."""
    content_type = request.headers.get("content-type", "").lower()
    if not content_type.startswith("application/json"):
        raise HTTPException(status_code=415, detail="Content-Type must be application/json to prevent CSRF")

    if not router_instance:
        raise HTTPException(status_code=503, detail="Router not initialized")

    body_bytes = await request.body()
    try:
        payload = json.loads(body_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    model_id = router_instance.find_model_id(payload.get("model"), has_images=False)
    if model_id is None:
        raise HTTPException(status_code=404, detail="No models registered")

    entry = await router_instance.ensure_loaded(model_id)
    stream = payload.get("stream", False)

    if stream:
        generator_fn = await router_instance.proxy_request(
            entry, "POST", "/v1/completions",
            body=body_bytes,
            headers={"content-type": "application/json", "accept": "text/event-stream"},
            stream=True,
        )
        return StreamingResponse(generator_fn(), media_type="text/event-stream")

    resp = await router_instance.proxy_request(
        entry, "POST", "/v1/completions",
        body=body_bytes,
        headers={"content-type": "application/json"},
    )

    if resp.status_code >= 400:
        try:
            err_body = resp.json()
        except Exception:
            err_body = {"error": resp.text}
        return JSONResponse(status_code=resp.status_code, content=err_body)

    return JSONResponse(content=resp.json(), status_code=resp.status_code)


@app.post("/v1/embeddings")
async def embeddings(request: Request):
    """Forward embeddings to a text backend."""
    content_type = request.headers.get("content-type", "").lower()
    if not content_type.startswith("application/json"):
        raise HTTPException(status_code=415, detail="Content-Type must be application/json to prevent CSRF")

    if not router_instance:
        raise HTTPException(status_code=503, detail="Router not initialized")

    body_bytes = await request.body()
    model_id = router_instance.find_model_id(None, has_images=False)
    if model_id is None:
        raise HTTPException(status_code=404, detail="No models registered")

    entry = await router_instance.ensure_loaded(model_id)
    resp = await router_instance.proxy_request(
        entry, "POST", "/v1/embeddings",
        body=body_bytes,
        headers={"content-type": "application/json"},
    )

    if resp.status_code >= 400:
        try:
            err_body = resp.json()
        except Exception:
            err_body = {"error": resp.text}
        return JSONResponse(status_code=resp.status_code, content=err_body)

    return JSONResponse(content=resp.json(), status_code=resp.status_code)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _parse_model_spec(spec: str) -> tuple:
    """Parse 'model_id' or 'model_id:type' -> (model_id, type|None)."""
    if ":" in spec:
        parts = spec.rsplit(":", 1)
        if parts[1].lower() in ("text", "vision", "mllm", "llm"):
            model_type = "vision" if parts[1].lower() in ("vision", "mllm") else "text"
            return parts[0], model_type
    return spec, None


def _detect_default_engine() -> str:
    """Auto-detect the best engine for this platform."""
    import platform as plat
    system = plat.system().lower()
    machine = plat.machine().lower()

    if system == "darwin" and machine == "arm64":
        return "vllm-mlx"

    # Check for NVIDIA GPU
    if shutil.which("nvidia-smi"):
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                return "vllm"
        except Exception as e:
            logger.debug("NVIDIA GPU check failed: %s", e)

    # Fallback: llama-cpp works everywhere
    return "llama-cpp"


def main():
    global router_instance

    parser = argparse.ArgumentParser(
        description="Aether Inference - On-demand multi-model OpenAI server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Models are loaded on first request and evicted after --idle-timeout seconds.
Supports: safetensors (vllm-mlx/vllm), GGUF (llama-cpp), pytorch (vllm).

Examples:
  # Auto-discover models + auto-detect engine
  python -m services.aether_inference.server --port 7090 --models-dir ./models

  # Apple Silicon (explicit)
  python -m services.aether_inference.server --engine vllm-mlx --models-dir ./models

  # NVIDIA CUDA
  python -m services.aether_inference.server --engine vllm --models-dir ./models

  # GGUF models via llama.cpp
  python -m services.aether_inference.server --engine llama-cpp --models-dir ./models

  # Explicit model list
  python -m services.aether_inference.server \\
      --model mlx-community/GLM-OCR-8bit:vision \\
      --model lmstudio-community/LFM2.5-1.2B-Instruct-MLX-8bit:text
        """,
    )
    parser.add_argument("--port", type=int, default=7090, help="External port (default: 7090)")
    parser.add_argument("--host", default=os.environ.get("AETHER_BIND_IP", "127.0.0.1"), help="Host to bind")
    parser.add_argument("--model", action="append", dest="models", default=None,
                        help="Model spec 'model_id' or 'model_id:type' (repeatable)")
    parser.add_argument("--models-dir", default=None, help="Local models directory")
    parser.add_argument("--venv", default=None, help="Path to venv-inference")
    parser.add_argument("--engine", default=None, choices=["vllm-mlx", "vllm", "llama-cpp"],
                        help="Default backend engine (auto-detected if omitted)")
    parser.add_argument("--internal-port-start", type=int, default=7091,
                        help="Starting port for backends (default: 7091)")
    parser.add_argument("--idle-timeout", type=int, default=600,
                        help="Seconds idle before unloading a model (default: 600)")
    parser.add_argument("--max-loaded-models", type=int, default=2,
                        help="Maximum models loaded simultaneously. LRU-evicts when exceeded (default: 2)")
    args = parser.parse_args()

    # Auto-detect engine if not specified
    engine = args.engine or _detect_default_engine()

    router_instance = InferenceRouter(
        port=args.port,
        internal_port_start=args.internal_port_start,
        venv_path=args.venv,
        models_dir=args.models_dir,
        idle_timeout=args.idle_timeout,
        engine=engine,
        max_loaded_models=args.max_loaded_models,
    )

    if args.models:
        for spec in args.models:
            model_id, model_type = _parse_model_spec(spec)
            router_instance.register_model(model_id, model_type)

    logger.info(
        "Aether Inference starting on %s:%d (engine=%s, idle_timeout=%ds, max_loaded=%d)",
        args.host, args.port, engine, args.idle_timeout, args.max_loaded_models,
    )
    if args.models_dir:
        logger.info("Models directory: %s", args.models_dir)

    # Register signal handlers for graceful shutdown.
    # When SIGTERM/SIGINT arrive (from manager.py's os.killpg or manual kill),
    # we need to stop all model backend subprocesses before exiting.
    # Without this, the lifespan shutdown may not trigger cleanly and
    # model backends would be orphaned.
    #
    # IMPORTANT: Signal handlers must be synchronous and signal-safe.
    # asyncio.get_event_loop() is deprecated in Python 3.12+ and removed in 3.14.
    # loop.create_task() from a signal handler can deadlock if the signal
    # interrupts an asyncio internal.  Instead, kill backend subprocesses
    # directly via os.killpg (synchronous, signal-safe), then let uvicorn
    # handle its own shutdown via SystemExit.
    def _signal_handler(signum, frame):
        logger.info("Received signal %d — initiating graceful shutdown", signum)
        if router_instance:
            # Synchronous process termination — signal-safe, no asyncio needed.
            # Send SIGTERM to each backend's process group.  The lifespan
            # shutdown handler will clean up state; this just ensures the
            # subprocesses don't outlive us.
            for entry in list(router_instance._registry.values()):
                if entry.process and entry.process.poll() is None:
                    try:
                        os.killpg(os.getpgid(entry.pid), signal.SIGTERM)
                    except (ProcessLookupError, OSError):
                        pass
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
