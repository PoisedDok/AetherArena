"""
Inference server control utilities for backend to manage inference lifecycle.

Mirrors daemon_control.py pattern: fully detached process that survives backend restarts.

@.architecture
Incoming: app.py lifespan (startup/shutdown), api/v1/endpoints/inference.py --- {ensure_running, stop}
Processing: check PID file, health check, start if needed --- {3 jobs: JOB_HEALTH_CHECK, JOB_INITIALIZE_COMPONENT, JOB_MANAGE_TASK}
Outgoing: InferenceManager (subprocess control), logs --- {process lifecycle, PID file}
"""

import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


async def ensure_inference_running() -> bool:
    """
    Ensure the inference server is running.
    
    Called by app.py lifespan on startup. If an existing server is already
    running (from a previous backend session), it reconnects. Otherwise
    starts a new one.
    
    Returns:
        True if inference server is running (either reconnected or newly started)
    """
    try:
        from config.settings import get_settings
        settings = get_settings()
        
        if not settings.inference.enabled:
            logger.info("Inference service disabled in config")
            return False
        
        # Check user preference (persisted toggle from frontend).
        # If the user explicitly disabled inference, respect that even if
        # config says enabled + auto_start. Preference overrides auto_start.
        user_pref_enabled = await _get_inference_preference(settings)
        if user_pref_enabled is False:
            logger.info("Inference server disabled by user preference (inference_enabled=false)")
            # CRITICAL: If a server is already running (e.g. started by
            # start_production.sh before the Python backend booted), stop it.
            # The user explicitly chose to disable inference -- respect that.
            try:
                from .manager import InferenceManager
                manager = InferenceManager.get_instance(
                    port=settings.inference.port,
                    venv_path=settings.inference.venv_path or None,
                    models_dir=settings.inference.models_dir or None,
                    idle_timeout=settings.inference.idle_timeout,
                )
                health = await manager.health_check()
                if health.get("healthy"):
                    logger.info("Stopping inference server that was started before backend (user disabled)")
                    await manager.stop()
            except Exception as stop_err:
                logger.debug("Could not stop pre-existing inference server: %s", stop_err)
            return False
        
        from .manager import InferenceManager
        
        manager = InferenceManager.get_instance(
            port=settings.inference.port,
            venv_path=settings.inference.venv_path or None,
            models_dir=settings.inference.models_dir or None,
            idle_timeout=settings.inference.idle_timeout,
        )
        
        # Check if already running (reconnected via PID file in __init__)
        health = await manager.health_check()
        if health.get("healthy"):
            logger.info(
                "Inference server already running (PID: %s, port: %d)",
                manager._pid, manager.port
            )
            return True
        
        # Not running -- start if auto_start enabled
        if not settings.inference.auto_start:
            logger.info("Inference auto_start disabled -- not starting")
            return False
        
        logger.info("Starting inference server...")
        result = await manager.start()
        
        if result.get("status") in ("running", "already_running"):
            logger.info("Inference server ready: %s", result)
            return True
        else:
            logger.warning("Inference server failed to start: %s", result)
            return False
        
    except Exception as e:
        logger.warning("Failed to ensure inference server: %s", e)
        return False


async def inference_shutdown(stop_server: bool = False) -> None:
    """Release the InferenceManager singleton and optionally stop the server.

    Called during app shutdown. Behavior depends on proactive master state:
      proactive ENABLED  -> stop_server=False (server survives for instant reconnect)
      proactive DISABLED -> stop_server=True  (server killed to prevent orphans)

    The proactive master toggle does NOT call this function — it only
    controls daemons. Inference lifecycle is managed exclusively at
    app startup/shutdown (see app.py lifespan).

    Args:
        stop_server: If True, terminate the inference server process.
                     If False, only dispose the manager reference (server keeps running).
    """
    try:
        from .manager import InferenceManager
        
        if InferenceManager._instance is not None:
            await InferenceManager._instance.dispose(stop_server=stop_server)
            
    except Exception as e:
        logger.warning("Inference shutdown error: %s", e)


async def get_inference_status() -> Dict[str, Any]:
    """
    Get current inference server status.
    
    Safe to call even if manager not initialized.
    Includes user_enabled flag from preferences for frontend toggle state.
    """
    try:
        from config.settings import get_settings
        from .manager import InferenceManager
        
        settings = get_settings()
        
        if not settings.inference.enabled:
            return {"status": "disabled", "enabled": False, "user_enabled": False}
        
        # Include user preference in status so frontend can reflect toggle state
        user_pref = await _get_inference_preference(settings)
        
        manager = InferenceManager.get_instance(
            port=settings.inference.port,
            venv_path=settings.inference.venv_path or None,
            models_dir=settings.inference.models_dir or None,
            idle_timeout=settings.inference.idle_timeout,
        )
        status = await manager.get_status()
        status["user_enabled"] = user_pref if user_pref is not None else True
        return status
        
    except Exception as e:
        return {"status": "error", "error": str(e)}


async def _get_inference_preference(settings=None) -> Optional[bool]:
    """
    Read the user's inference_enabled preference from the database.
    
    Returns:
        True if enabled (or preference not set — default enabled).
        False if user explicitly disabled.
        None if preference system unavailable (treat as enabled).
    """
    try:
        if settings is None:
            from config.settings import get_settings
            settings = get_settings()
        
        from api.dependencies import get_database_connection
        from data.database.repositories.preferences import PreferencesRepository
        
        gateway = get_database_connection()
        if gateway is None:
            logger.debug("Database not available for inference preference check")
            return None
        
        repo = PreferencesRepository(gateway)
        user_id = settings.security.default_user_id
        
        value = await repo.get_preference(
            preference_key="inference_enabled",
            user_id=user_id,
            default_value=True,  # Default: enabled (matches _PREFERENCE_DEFAULTS)
        )
        
        # Value can be True/False (bool) or {"enabled": bool} (legacy format)
        if isinstance(value, dict):
            return value.get("enabled", True)
        return bool(value)
        
    except Exception as e:
        logger.debug("Could not read inference preference (non-fatal): %s", e)
        return None  # Treat as enabled when DB unavailable
