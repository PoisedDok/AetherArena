"""
Aether Inference API Endpoints

Management endpoints for the native inference server (vllm-mlx / vLLM / Ollama).
Provides status, start/stop control, model management, and platform info.

@.architecture
Incoming: frontend settings UI, admin tools --- {HTTP requests}
Processing: delegates to InferenceManager (services/aether-inference/manager.py) --- {8 endpoints}
Outgoing: HTTP JSON responses --- {status, model info, pull progress}
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/inference", tags=["inference"])


# --- Request/Response Models ---

class StartRequest(BaseModel):
    """Request to start the inference server."""
    model: Optional[str] = None  # None = use default from platform detection


class PullRequest(BaseModel):
    """Request to pull/download a model."""
    model: str  # Model identifier (e.g. "mlx-community/GLM-OCR-8bit")


# --- Helper: Get Manager ---

def _get_manager():
    """
    Get the InferenceManager singleton.
    
    Reads port and venv_path from central config (settings.py).
    """
    from config.settings import get_settings
    from services.aether_inference.manager import InferenceManager
    
    settings = get_settings()
    return InferenceManager.get_instance(
        port=settings.inference.port,
        venv_path=settings.inference.venv_path or None,
        models_dir=settings.inference.models_dir or None,
        idle_timeout=settings.inference.idle_timeout,
    )


# --- Endpoints ---

@router.get(
    "/status",
    summary="Get inference server status",
    description="Returns comprehensive status including health, platform info, loaded models, "
                "and user_enabled flag (persisted preference for the enable/disable toggle).",
)
async def get_status():
    """
    Get inference server status.
    
    Returns comprehensive status including health, platform info, loaded models,
    and user_enabled flag (persisted preference for the enable/disable toggle).
    """
    try:
        from services.aether_inference.inference_control import get_inference_status
        return await get_inference_status()
    except Exception as e:
        logger.error("Failed to get inference status: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve inference status. Check server logs for details."
        )


@router.post(
    "/start",
    summary="Start the inference server",
    description="Automatically detects platform and selects the optimal engine. "
                "Model can be specified or defaults to GLM-OCR for the detected platform.",
)
async def start_server(request: StartRequest = StartRequest()):
    """
    Start the inference server.
    
    Automatically detects platform and selects the optimal engine.
    Model can be specified or defaults to GLM-OCR for the detected platform.
    """
    try:
        manager = _get_manager()
        result = await manager.start(model=request.model)
        
        if result.get("status") == "error":
            raise HTTPException(status_code=503, detail=result.get("error", "Failed to start"))
        
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to start inference server: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to start inference server. Check server logs for details."
        )


@router.post(
    "/stop",
    summary="Stop the inference server",
    description="Gracefully shuts down the running inference engine process.",
)
async def stop_server():
    """Stop the inference server."""
    try:
        manager = _get_manager()
        return await manager.stop()
    except Exception as e:
        logger.error("Failed to stop inference server: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to stop inference server. Check server logs for details."
        )

@router.post(
    "/restart",
    summary="Restart the inference server",
    description="Stops then restarts the inference engine. Optionally switch model on restart.",
)
async def restart_server(request: StartRequest = StartRequest()):
    """Restart the inference server (stop + start)."""
    try:
        manager = _get_manager()
        return await manager.restart(model=request.model)
    except Exception as e:
        logger.error("Failed to restart inference server: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to restart inference server. Check server logs for details."
        )

@router.get(
    "/models",
    summary="List available models",
    description="Returns models currently downloaded or loaded on the inference server.",
)
async def list_models():
    """
    List models available on the inference server.
    
    Returns models currently downloaded/loaded on the server.
    """
    try:
        manager = _get_manager()
        models = await manager.list_models()
        return {"models": models}
    except Exception as e:
        logger.error("Failed to list models from inference server: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to list models. Check server logs for details."
        )


@router.post(
    "/models/pull",
    summary="Pull / download a model",
    description="Initiates a background model download. For Ollama uses the pull API; "
                "for vllm-mlx/vLLM downloads from HuggingFace Hub. Returns a job ID for tracking.",
)
async def pull_model(request: PullRequest):
    """
    Pull/download a model.
    
    For Ollama: uses the pull API.
    For vllm-mlx/vLLM: downloads from HuggingFace Hub.
    
    Returns a job ID for tracking progress.
    """
    try:
        manager = _get_manager()
        progress = await manager.pull_model(model=request.model)
        return {
            "job_id": progress.job_id,
            "model": progress.model,
            "status": progress.status,
            "progress_pct": progress.progress_pct,
            "error": progress.error,
        }
    except Exception as e:
        logger.error("Failed to initiate model pull: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to pull model. Check server logs for details."
        )

@router.get(
    "/models/pull/{job_id}",
    summary="Get model pull progress",
    description="Returns download progress for a specific pull job including bytes downloaded and total size.",
)
async def get_pull_progress(job_id: str):
    """Get progress of a model pull job."""
    try:
        manager = _get_manager()
        progress = manager.get_pull_progress(job_id)
        
        if not progress:
            raise HTTPException(status_code=404, detail=f"Pull job {job_id} not found")
        
        return {
            "job_id": progress.job_id,
            "model": progress.model,
            "status": progress.status,
            "progress_pct": progress.progress_pct,
            "downloaded_bytes": progress.downloaded_bytes,
            "total_bytes": progress.total_bytes,
            "error": progress.error,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get pull progress for job %s: %s", job_id, e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to get pull progress. Check server logs for details."
        )


@router.get(
    "/platform",
    summary="Get platform detection info",
    description="Returns OS, architecture, GPU type, selected engine, and recommended model formats.",
)
async def get_platform_info():
    """
    Get platform detection info.
    
    Returns OS, architecture, GPU type, selected engine, and recommended model formats.
    """
    try:
        manager = _get_manager()
        pinfo = manager.platform_info
        
        if not pinfo:
            raise HTTPException(status_code=500, detail="Platform detection failed")
        
        return {
            "os": pinfo.os,
            "arch": pinfo.arch,
            "gpu": pinfo.gpu.value,
            "gpu_name": pinfo.gpu_name,
            "gpu_memory_gb": pinfo.gpu_memory_gb,
            "engine": pinfo.engine.value,
            "engine_display_name": pinfo.engine_display_name,
            "is_apple_silicon": pinfo.is_apple_silicon,
            "is_nvidia": pinfo.is_nvidia,
            "glm_ocr_model": pinfo.glm_ocr_model,
            "pip_install_target": pinfo.pip_install_target,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get platform info: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve platform information. Check server logs for details."
        )

@router.get(
    "/recommended-models",
    summary="Get recommended models for this platform",
    description="Returns the 4 core recommended models (text, OCR, main agent, vision) "
                "optimized for the detected hardware, with download status.",
)
async def get_recommended_models():
    """
    Get recommended models for this platform with download status.
    
    Returns the 4 core recommended models (text, OCR, main agent, vision)
    optimized for the detected hardware. Each entry includes:
    - model_id, role, display_name, description, size_hint
    - downloaded: whether the model is already in local models_dir
    - required: whether the model is essential for core features
    
    Used by the onboarding flow and the settings AI Models panel.
    """
    try:
        from services.aether_inference.platform_detector import get_recommended_models_status
        
        manager = _get_manager()
        pinfo = manager.platform_info
        models_dir = str(manager._models_dir) if manager._models_dir else None
        
        models = get_recommended_models_status(pinfo=pinfo, models_dir=models_dir)
        
        return {
            "models": models,
            "platform": {
                "engine": pinfo.engine.value if pinfo else None,
                "engine_display": pinfo.engine_display_name if pinfo else None,
                "gpu": pinfo.gpu.value if pinfo else None,
                "gpu_name": pinfo.gpu_name if pinfo else None,
            },
        }
    except Exception as e:
        logger.error("Failed to get recommended models: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve recommended models. Check server logs for details."
        )


@router.post(
    "/recommended-models/download-all",
    summary="Download all recommended models",
    description="Triggers download of all recommended models not yet present locally. "
                "Returns a list of pull job IDs for tracking progress.",
)
async def download_all_recommended():
    """
    Trigger download of all recommended models that are not yet downloaded.
    
    Returns a list of pull job IDs for tracking progress.
    Used during onboarding for one-click setup.
    """
    try:
        from services.aether_inference.platform_detector import get_recommended_models_status
        
        manager = _get_manager()
        pinfo = manager.platform_info
        models_dir = str(manager._models_dir) if manager._models_dir else None
        
        models = get_recommended_models_status(pinfo=pinfo, models_dir=models_dir)
        
        jobs = []
        for model in models:
            if not model["downloaded"]:
                progress = await manager.pull_model(model["model_id"])
                jobs.append({
                    "model_id": model["model_id"],
                    "role": model["role"],
                    "job_id": progress.job_id,
                    "status": progress.status,
                    "error": progress.error,
                })
        
        return {
            "jobs": jobs,
            "already_downloaded": [m["model_id"] for m in models if m["downloaded"]],
        }
    except Exception as e:
        logger.error("Failed to initiate download for all recommended models: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to initiate downloads. Check server logs for details."
        )

@router.get(
    "/health",
    summary="Inference health check",
    description="Lightweight connectivity check for the inference server, cheaper than /status.",
)
async def health_check():
    """
    Quick health check for the inference server.
    
    Lighter than /status -- just checks connectivity.
    """
    try:
        manager = _get_manager()
        return await manager.health_check()
    except Exception as e:
        logger.error("Failed to perform inference health check: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to perform inference health check. Check server logs for details."
        )

@router.get(
    "/agent-defaults",
    summary="Get per-agent generation defaults",
    description="Backend-controlled tuning parameters for each agent role. "
                "Not intended for user modification.",
)
async def get_agent_defaults():
    """
    Return smart per-agent generation defaults.
    
    These are backend-controlled tuning parameters for each agent role
    (summarizer, query_gen, ocr, main_agent, research, vision).
    Not intended for user modification -- used by backend agents automatically.
    Frontend should only show model name + context window to non-technical users.
    
    Returns:
        Dict mapping agent_role -> {temperature, max_tokens, top_p, top_k, repeat_penalty}
    """
    try:
        from config.settings import _AGENT_GENERATION_DEFAULTS
        
        return {
            "agent_defaults": {
                role: dict(params)
                for role, params in _AGENT_GENERATION_DEFAULTS.items()
                if role != "_default"
            },
            "fallback_default": dict(_AGENT_GENERATION_DEFAULTS["_default"]),
        }
    except Exception as e:
        logger.error("Failed to retrieve agent defaults: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve agent defaults. Check server logs for details."
        )
