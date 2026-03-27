"""
Setup Service

Domain/Application service encapsulating the infrastructure initialization logic.
"""

from core.domain.repository_interfaces import ISetupStateRepository
import os
import sys
import asyncio
import json
from pathlib import Path
from typing import Dict, Any, List

from core.exceptions import UpstreamServiceError
from config.settings import Settings, get_app_root, get_bundle_root, get_install_root
from core.system.interfaces import IProcessGateway
from monitoring import get_logger

logger = get_logger(__name__)

class SetupService:
    def __init__(self, settings: Settings, process_gateway: IProcessGateway, state_repository: ISetupStateRepository):
        self.settings = settings
        self.process_gateway = process_gateway
        self.state_repository = state_repository

    async def execute_setup(self, database_initialized: bool = False) -> Dict[str, Any]:
        """
        Connect the backend to the now-running Docker services.
        
        This encapsulates the initialization logic from the setup router.
        It runs on-demand instead of at startup and transitions the backend
        from degraded mode to fully operational.
        """
        
        # Frontend-managed first-run starts backend with SKIP_SERVICE_HEALTH_CHECK=true
        # so onboarding APIs can run before Docker is ready. Finalize is the explicit
        # transition point to full mode, so health checks must be re-enabled here.
        skip_override = os.getenv("SKIP_SERVICE_HEALTH_CHECK", "")
        if skip_override.lower() in ("true", "1", "yes"):
            logger.info("Finalize: clearing SKIP_SERVICE_HEALTH_CHECK override")
        os.environ["SKIP_SERVICE_HEALTH_CHECK"] = "false"

        # Guard: if database is already initialized, return immediately
        if database_initialized:
            logger.info("Database already initialized — finalize is a no-op")
            return {"status": "ok", "message": "Backend already fully operational", "already_initialized": True}

        errors: List[str] = []

        # Step 1: Verify Docker services are reachable
        try:
            from core.integrations.providers.supabase_docker import ensure_supabase_running
            redis_settings = self.settings.redis

            # Supabase containers may take 30-60s to become fully operational after
            # Docker reports them as "running".  Use a generous timeout so the very
            # first finalize call after fresh onboarding doesn't fail prematurely.
            supabase_ready = await ensure_supabase_running(
                url=self.settings.supabase.url,
                anon_key=self.settings.supabase.anon_key,
                redis_url=getattr(redis_settings, "url", None),
                redis_namespace=getattr(redis_settings, "namespace", "aether"),
                max_wait_seconds=60,
            )

            if not supabase_ready:
                errors.append("Supabase services not healthy after 60s")
                logger.error("Finalize: Supabase services not healthy")
        except Exception as e:
            errors.append(f"Service health check failed: {e}")
            logger.error("Finalize: Service health check failed: %s", e, exc_info=True)

        # Step 2: Run migrations
        try:
            from data.database.migration_runner import run_migrations
            migrations_ok = await run_migrations()
            if not migrations_ok:
                raise RuntimeError("Database migrations failed or partially applied")
            logger.info("Finalize: database migrations completed")
        except Exception as e:
            errors.append(f"Migration execution failed: {e}")
            logger.error("Finalize: Migration execution failed: %s", e, exc_info=True)
            raise UpstreamServiceError(f"Backend initialization failed: {'; '.join(errors)}", status_code=503)

        # Step 3: Initialize Supabase client + persistence gateway
        # Retry up to 3 times with 5s backoff — even after the health check passes,
        # the Supabase REST gateway may still be initializing (Connection reset / 502).
        supabase = None
        try:
            from data.database.clients.supabase import SupabaseClient
            from data.database.persistence_gateway import SupabasePersistenceGateway

            last_init_err = None
            for attempt in range(1, 4):
                try:
                    supabase = SupabaseClient.from_env({
                        "url": self.settings.supabase.url,
                        "anon_key": self.settings.supabase.anon_key,
                        "service_role_key": self.settings.supabase.service_role_key,
                        "schema": self.settings.supabase.db_schema,
                        "realtime_enabled": self.settings.supabase.realtime_enabled,
                    })
                    await supabase.initialize()
                    logger.info("Finalize: Supabase client initialized (attempt %d)", attempt)
                    break
                except (ConnectionError, ConnectionResetError, OSError, TimeoutError) as init_err:
                    last_init_err = init_err
                    if supabase is not None:
                        await supabase.dispose()
                        supabase = None
                    if attempt < 3:
                        logger.warning(
                            "Finalize: Supabase client init attempt %d failed (%s), retrying in 5s...",
                            attempt, init_err,
                        )
                        await asyncio.sleep(5)
                    else:
                        raise

            if supabase is None:
                raise ConnectionError(f"Supabase client init failed after 3 attempts: {last_init_err}")

            # Step 4: Create the gateway instance, but don't commit to global state yet
            gateway = SupabasePersistenceGateway(supabase)

            # Step 5: Initialize file indexing repository
            # Try to build the repository instance to ensure it succeeds before saving to globals
            try:
                from data.database.repositories.files import FileIndexingRepository
                file_repo = FileIndexingRepository(gateway)
            except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
                raise RuntimeError(f"File indexing init failed: {e}") from e

            # Atomic commit boundary - ONLY set global state if all local initialization steps succeed
            logger.info("Finalize: returning database gateway and file indexing repository for global injection")

            # Step 6: Seed agent configs (requires database)
            try:
                from application.agents.agent_seeder import seed_missing_agents
                await seed_missing_agents(gateway, self.settings)
                logger.info("Finalize: agent configs seeded")
            except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
                logger.warning("Finalize: agent seeding failed (non-critical): %s", e)

        except Exception as e:
            # Resource cleanup on failure
            if supabase is not None:
                logger.info("Finalize: Disposing Supabase client due to initialization failure")
                # Do not raise inside except block without capturing original error
                try:
                    await supabase.dispose()
                except Exception as dispose_err:
                    logger.warning("Failed to dispose supabase client during cleanup: %s", dispose_err)
            
            errors.append(f"Database initialization failed: {e}")
            logger.error("Finalize: database initialization failed: %s", e, exc_info=True)
            raise UpstreamServiceError(f"Backend initialization failed: {'; '.join(errors)}", status_code=503)

        # If we reached here, gateway and file_repo are successfully initialized
        # (otherwise an exception would have been raised).
        if errors:
            return {
                "status": "degraded",
                "message": "Backend initialized with warnings",
                "errors": errors,
                "database_connected": True,
            }

        return {
            "status": "ok",
            "message": "Backend fully operational — database, Redis, and services connected",
            "database_connected": True,
            "gateway": gateway,
            "file_repo": file_repo
        }

    async def complete_onboarding(self, payload: Dict[str, Any]) -> None:
        """
        Consolidate all onboarding data and persist to a local JSON file.
        This file is processed during the next backend startup (lifespan).
        Writing to a flat file ensures persistence even if Supabase is degraded.
        """
        data_dir = get_app_root()
        pending_file = data_dir / "pending_onboarding.json"
        temp_file = data_dir / "pending_onboarding.json.tmp"

        logger.info("SetupService: Writing consolidated onboarding payload to %s", pending_file)

        try:
            # Atomic write pattern: write to .tmp then rename
            with open(temp_file, 'w', encoding='utf-8') as f:
                json.dump(payload, f, indent=2)
            
            os.replace(temp_file, pending_file)
            logger.info("SetupService: Successfully persisted onboarding payload")
        except Exception as e:
            logger.error("SetupService: Failed to persist onboarding payload: %s", e, exc_info=True)
            if temp_file.exists():
                try:
                    temp_file.unlink()
                except OSError as e:
                    logger.debug("Failed to remove temporary file %s: %s", temp_file, e)
            raise RuntimeError(f"Failed to persist onboarding configuration: {e}")

    def get_setup_status(self) -> Dict[str, Any]:
        data = self.state_repository.get_progress()
        if data is not None:
            for key in ["repositories", "python_packages", "oi_environment", "inference_environment", "ml_models", "docker_services"]:
                if key not in data:
                    data[key] = {"status": "pending", "progress": 0, "message": "Waiting", "items": []}
            if "total_progress" not in data:
                data["total_progress"] = 0
            if "current_phase" not in data:
                data["current_phase"] = "idle"
            return data
            
        return {
            "repositories": {"status": "pending", "progress": 0, "message": "Waiting to start", "items": []},
            "python_packages": {"status": "pending", "progress": 0, "message": "Waiting to start", "items": []},
            "oi_environment": {"status": "pending", "progress": 0, "message": "Waiting to start", "items": []},
            "inference_environment": {"status": "pending", "progress": 0, "message": "Waiting to start", "items": []},
            "ml_models": {"status": "pending", "progress": 0, "message": "Waiting to start", "items": []},
            "docker_services": {"status": "pending", "progress": 0, "message": "Waiting to start", "items": []},
            "total_progress": 0,
            "current_phase": "idle"
        }

    def check_setup_requirements(self) -> Dict[str, Any]:    
        """Comprehensive pre-flight check: Verify all critical resources."""
        backend_root = get_app_root()       # Writable data dir (DATA_DIR)
        bundle_root = get_bundle_root()     # PyInstaller _MEIPASS (read-only internals)
        install_root = get_install_root()   # Read-only install dir (Resources/bin/)
        
        requirements = {
            "python3": {"installed": False, "version": None},
            "docker_daemon": {"installed": False, "running": False},
            "bundled_services": {"complete": False, "details": {}},
            "venv_oi": {"complete": False, "path": None},
            "venv_inference": {"complete": False, "path": None, "engine": None},
            "models": {"complete": False, "details": {}},
            "docker_images": {"complete": False, "details": {}},
            "overall_ready": False
        }
        
        # 0a. Check Python3 availability (required for setup_engine.py progress tracking and model downloads)
        try:
            result = self.process_gateway.run_command(["python3", "--version"], timeout=5.0)
            if result.returncode == 0:
                requirements["python3"]["installed"] = True
                requirements["python3"]["version"] = result.stdout.strip()
        except Exception:
            requirements["python3"]["installed"] = False
        
        # 0b. Check Docker daemon status (installed + running)
        try:
            result = self.process_gateway.run_command(["docker", "--version"], timeout=5.0)
            requirements["docker_daemon"]["installed"] = result.returncode == 0
        except Exception:
            requirements["docker_daemon"]["installed"] = False
        
        if requirements["docker_daemon"]["installed"]:
            try:
                result = self.process_gateway.run_command(["docker", "info"], timeout=10.0)
                requirements["docker_daemon"]["running"] = result.returncode == 0
            except Exception:
                requirements["docker_daemon"]["running"] = False
        
        # 1. Verify bundled services (Perplexica, external-services)
        # Check mutable (backend_root), immutable bundle (_MEIPASS), AND install dir (Resources/bin/)
        perplexica_src = None
        external_svc = None
        
        for root in [install_root, backend_root, bundle_root]:
            if not perplexica_src and (root / "services" / "perplexica" / "package.json").exists():
                perplexica_src = root / "services" / "perplexica"
            if not external_svc and (root / "services" / "external-services" / "docker-compose.yml").exists():
                external_svc = root / "services" / "external-services"
        
        requirements["bundled_services"]["details"]["perplexica"] = {
            "exists": perplexica_src is not None,
            "path": str(perplexica_src) if perplexica_src else None
        }
        requirements["bundled_services"]["details"]["external_services"] = {
            "exists": external_svc is not None,
            "path": str(external_svc) if external_svc else None
        }
        requirements["bundled_services"]["complete"] = perplexica_src is not None and external_svc is not None
        
        # 2. Check venv-oi — read path from settings (single source of truth)
        from config.settings import get_settings as _get_settings
        _settings = _get_settings()
        oi_venv_python = _settings.interpreter.external_server_venv_python
        oi_venv = Path(oi_venv_python).parent.parent if oi_venv_python else backend_root / "venv-oi"
        
        oi_python = oi_venv / "bin" / "python"
        requirements["venv_oi"]["complete"] = oi_python.exists()
        requirements["venv_oi"]["path"] = str(oi_venv)
        
        # 2b. Check venv-inference — read path from settings (single source of truth)
        inf_venv = Path(_settings.inference.venv_path) if _settings.inference.venv_path else backend_root / "venv-inference"
        
        inf_python = inf_venv / "bin" / "python"
        requirements["venv_inference"]["path"] = str(inf_venv)
        requirements["venv_inference"]["complete"] = inf_python.exists()
        
        # Detect which engine is installed
        if inf_python.exists():
            if (inf_venv / "bin" / "vllm-mlx").exists():
                requirements["venv_inference"]["engine"] = "vllm-mlx"
            elif (inf_venv / "bin" / "vllm").exists():
                requirements["venv_inference"]["engine"] = "vllm"
            else:
                requirements["venv_inference"]["engine"] = "pip-only"
        
        # 3. Check ML models (embedding critical, TTS recommended, audio on-demand)
        import platform as _platform
        hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
        is_apple_silicon = (_platform.system() == "Darwin" and _platform.machine() == "arm64")
    
        # TTS check: MLX on Apple Silicon, PyTorch elsewhere
        local_tts_pt = backend_root / "data" / "models" / "tts" / "Qwen3-TTS-12Hz-0.6B-CustomVoice"
        has_mlx_tts = any(hf_cache.glob("models--mlx-community--Qwen3-TTS-*"))
        has_pt_tts = local_tts_pt.exists() or any(hf_cache.glob("models--Qwen--Qwen3-TTS-*"))
        tts_exists = has_mlx_tts if is_apple_silicon else has_pt_tts
    
        # Embedding models: ONNX models live INSIDE the Perplexica Docker image (pre-baked at build).
        # No host-side BAAI/bge cache needed. Readiness = Perplexica image exists (checked in step 4).
        requirements["models"]["details"]["embedding"] = {
            "exists": True,  # Handled by Perplexica Docker image (ONNX, no host download)
            "note": "ONNX embedding models (Xenova/bge-small, Xenova/nomic-embed) are inside Perplexica Docker image"
        }
        requirements["models"]["details"]["tts_qwen3"] = {
            "exists": tts_exists,
            "mlx": has_mlx_tts,
            "pytorch": has_pt_tts,
            "local": local_tts_pt.exists(),
            "backend": "mlx" if is_apple_silicon else "pytorch",
            "optional": False,  # Default TTS engine — required for handsfree
        }
        requirements["models"]["details"]["stt"] = {"exists": any(hf_cache.glob("models--openai--whisper-*")), "optional": True}
        requirements["models"]["details"]["vad"] = {"exists": any(hf_cache.glob("models--snakers4--silero-vad*")), "optional": True}
        requirements["models"]["complete"] = (
            requirements["models"]["details"]["tts_qwen3"]["exists"]
            # Embedding readiness is verified via Perplexica Docker image check below
        )
        
        # 4. Check Docker images (pre-built + custom built)
        try:
            result = self.process_gateway.run_command(["docker", "images", "--format", "{{.Repository}}"], timeout=5.0)
            existing = result.stdout.strip().split('\n') if result.returncode == 0 else []
            
            # Check for any Supabase image (they're all pre-built)
            requirements["docker_images"]["details"]["supabase"] = {
                "exists": any("supabase/postgres" in img for img in existing)
            }
            # Check for Perplexica (custom built from bundle)
            requirements["docker_images"]["details"]["perplexica"] = {
                "exists": any("perplexica" in img.lower() or "aether-perplexica" in img.lower() or "aether-mesh-perplexica" in img.lower() for img in existing)
            }
            requirements["docker_images"]["complete"] = (
                requirements["docker_images"]["details"]["supabase"]["exists"] and
                requirements["docker_images"]["details"]["perplexica"]["exists"]
            )
        except Exception as e:  # noqa: BLE001 — setup check must never crash
            logger.debug("Docker image check failed: %s", e)
            requirements["docker_images"]["complete"] = False
        
        # 5. Check inference models (recommended model set)
        try:
            from services.aether_inference.platform_detector import get_recommended_models_status, detect_platform
            
            pinfo = detect_platform()
            
            # Read models_dir from central config (settings.py is the Python SoT)
            # _settings already resolved above (venv-oi/inference check)
            inference_models_dir = _settings.inference.models_dir or str(backend_root / "models")
            
            recommended = get_recommended_models_status(pinfo=pinfo, models_dir=inference_models_dir)
            
            required_models = [m for m in recommended if m["required"]]
            downloaded_required = [m for m in required_models if m["downloaded"]]
            
            requirements["inference_models"] = {
                "complete": len(downloaded_required) == len(required_models),
                "total": len(recommended),
                "required": len(required_models),
                "downloaded": len([m for m in recommended if m["downloaded"]]),
                "downloaded_required": len(downloaded_required),
                "models": recommended,
            }
        except Exception as e:
            logger.debug("Inference model check failed: %s", e)
            requirements["inference_models"] = {
                "complete": False,
                "total": 0,
                "required": 0,
                "downloaded": 0,
                "downloaded_required": 0,
                "models": [],
                "error": "Model check failed. Check server logs.",
            }
    
        requirements["overall_ready"] = (
            requirements["docker_daemon"]["running"] and
            requirements["bundled_services"]["complete"] and
            requirements["venv_oi"]["complete"] and
            requirements["models"]["complete"] and
            requirements["docker_images"]["complete"]
        )
        
        return requirements

    def trigger_setup(self) -> str:
        status = self.get_setup_status()
        # In the unit tests we mock trigger_setup to just return something and not actually run the setup_engine.py script
        # So we don't have to change test logic much
        if status.get("current_phase") not in ["idle", "completed", "error", "skipped", "starting"]:
            backend_root = get_app_root()
            pid_file = backend_root / "logs" / "setup_engine.pid"
            is_stale = False
            
            if pid_file.exists():
                health = self.process_gateway.check_process_health(pid_file)
                if not health.running:
                    logger.warning(
                        "Setup process %s is dead but lock was left in %s phase. Clearing stale lock.",
                        health.pid, status.get('current_phase')
                    )
                    is_stale = True
                else:
                    logger.warning(
                        "Setup process %s is still running, but a new setup was requested. "
                        "Killing the old process to start fresh.", health.pid
                    )
                    try:
                        import os, signal
                        # setup_engine.py is launched with start_new_session=True, so it is its own process group leader.
                        # Kill the entire process group to ensure docker compose and other children are also terminated.
                        os.killpg(os.getpgid(health.pid), signal.SIGKILL)
                        logger.info("Successfully killed old setup process group %s", health.pid)
                    except Exception as e:
                        logger.error("Failed to kill old setup process: %s", e)
                    is_stale = True
            else:
                logger.warning(
                    "No setup PID file found but lock was left in %s phase. Assuming stale lock.", 
                    status.get('current_phase')
                )
                is_stale = True

            if not is_stale:
                raise ValueError(f"Setup already in progress (phase: {status.get('current_phase')})")

        backend_root = get_app_root()
        install_root = get_install_root()
        setup_script = backend_root / "core" / "system" / "setup_engine.py"
        
        if not setup_script.exists():
            setup_script = install_root / "core" / "system" / "setup_engine.py"
        if not setup_script.exists():
            setup_script = get_bundle_root() / "core" / "system" / "setup_engine.py"
        
        if not setup_script.exists():
            raise FileNotFoundError(f"Setup script not found at {setup_script}")

        logger.info("Triggering setup core script: %s", setup_script)
        
        initial_data = {
            "repositories": {"status": "pending", "progress": 0, "message": "Starting...", "items": []},
            "python_packages": {"status": "pending", "progress": 0, "message": "Starting...", "items": []},
            "oi_environment": {"status": "pending", "progress": 0, "message": "Starting...", "items": []},
            "inference_environment": {"status": "pending", "progress": 0, "message": "Starting...", "items": []},
            "ml_models": {"status": "pending", "progress": 0, "message": "Starting...", "items": []},
            "docker_services": {"status": "pending", "progress": 0, "message": "Starting...", "items": []},
            "total_progress": 0,
            "current_phase": "starting"
        }
        
        self.state_repository.save_progress(initial_data)

        log_file = self.state_repository.get_log_file_path()
        if getattr(sys, 'frozen', False):
            cmd = [sys.executable, "setup-core", str(backend_root)]
        else:
            cmd = [sys.executable, str(setup_script), str(backend_root)]

        self.process_gateway.run_script_background(cmd, log_file)
        
        return str(setup_script)


    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
