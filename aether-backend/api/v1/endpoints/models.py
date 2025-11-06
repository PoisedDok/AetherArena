"""
Model Management Endpoints

Endpoints for LLM model discovery and capabilities.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET), External LLM APIs --- {HTTP requests to /v1/models, /v1/models/active, /v1/models/capabilities, HTTP responses from LLM providers}
Processing: list_models(), get_active_model(), model_capabilities() --- {3 jobs: model_discovery, capability_detection, provider_communication}
Outgoing: External LLM APIs (HTTP GET), Frontend (HTTP) --- {HTTP GET to {api_base}/models, ModelsListResponse, ModelCapabilitiesResponse}
"""

import httpx
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse

from api.dependencies import get_settings, setup_request_context
from api.v1.schemas.models import ModelsListResponse, ModelCapabilitiesResponse
from config.settings import Settings
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["models"])


# =============================================================================
# List Models
# =============================================================================

@router.get(
    "/models",
    response_model=ModelsListResponse,
    summary="List available models",
    description="List all available LLM models from the configured provider"
)
async def list_models(
    base: Optional[str] = Query(None, description="Override API base URL"),
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> ModelsListResponse:
    """
    List available models from LLM provider.
    
    Args:
        base: Optional API base URL override
        
    Returns:
        ModelsListResponse: List of available model names
    """
    # Determine API base URL
    effective_base = (base or settings.llm.api_base or "").rstrip("/")
    
    if not effective_base:
        logger.error("No API base URL configured")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No API base URL configured"
        )
    
    url = f"{effective_base}/models"
    
    try:
        # Fast connect but allow slow model hosts
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=3.0, read=30.0, write=10.0, pool=10.0)) as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.json()
            
            # Normalize to list of names
            names = []
            
            # OpenAI-compatible format
            if isinstance(data, dict) and isinstance(data.get("data"), list):
                for item in data["data"]:
                    name = item.get("id") or item.get("name")
                    if name:
                        names.append(name)
            # Simple list format
            elif isinstance(data, list):
                for item in data:
                    if isinstance(item, dict):
                        name = item.get("id") or item.get("name")
                        if name:
                            names.append(name)
                    elif isinstance(item, str):
                        names.append(item)
            
            logger.info(f"Listed {len(names)} models from {effective_base}")
            
            return ModelsListResponse(
                models=names if names else (data if isinstance(data, list) else []),
                count=len(names) if names else (len(data) if isinstance(data, list) else 0)
            )
            
    except httpx.TimeoutException:
        logger.error(f"Timeout connecting to {url}")
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"Timeout connecting to model provider at {effective_base}"
        )
    except httpx.HTTPStatusError as e:
        logger.error(f"HTTP error from {url}: {e}")
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Error from model provider: {e.response.text}"
        )
    except Exception as e:
        logger.error(f"Failed to list models from {url}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to list models"
        )


# =============================================================================
# Get Active Model
# =============================================================================

@router.get(
    "/models/active",
    summary="Get active model",
    description="Get currently active/configured model"
)
async def get_active_model(
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get active model configuration.
    
    Returns:
        Current model name and settings
    """
    try:
        return JSONResponse({
            "model": settings.llm.model,
            "provider": settings.llm.provider,
            "api_base": settings.llm.api_base,
            "supports_vision": settings.llm.supports_vision,
            "context_window": settings.llm.context_window,
            "max_tokens": settings.llm.max_tokens,
            "temperature": settings.llm.temperature
        })
    except Exception as e:
        logger.error(f"Failed to get active model: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get active model"
        )


# =============================================================================
# Model Capabilities
# =============================================================================

@router.get(
    "/models/capabilities",
    response_model=ModelCapabilitiesResponse,
    summary="Get model capabilities",
    description="Check capabilities of a specific model (vision, functions, etc.)"
)
async def model_capabilities(
    model: str = Query(..., description="Model name to check"),
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> ModelCapabilitiesResponse:
    """
    Get model capabilities.
    
    Checks if model supports:
    - Vision (image inputs)
    - Functions/tools
    - Streaming
    
    Uses litellm detection with keyword fallbacks.
    
    Args:
        model: Model name to check
        
    Returns:
        ModelCapabilitiesResponse: Model capabilities
    """
    supports_vision = False
    supports_functions = False
    
    # Keyword matching for vision support
    lowered = (model or "").lower()
    vision_keywords = [
        "vision",
        "gpt-4o",
        "gpt-4.1",
        "mini-omni",
        "omni",
        "qwen-vl",
        "qwen2-vl",
        "qwen3-vl",
        "qwen/qwen3-vl",
        "llava",
        "glm-4v",
        "gemini",
        "internvl",
        "smoldocling",
        "pixtral",
        "granite-vision",
    ]
    keyword_match = any(k in lowered for k in vision_keywords)
    
    # Try litellm detection
    try:
        import litellm
        try:
            supports_vision = bool(litellm.supports_vision(model))
        except Exception:
            supports_vision = False
    except ImportError:
        logger.warning("litellm not available for capability detection")
    except Exception as e:
        logger.warning(f"litellm detection failed: {e}")
    
    # Fallback to keywords if litellm didn't detect
    if not supports_vision and keyword_match:
        supports_vision = True
    
    logger.info(f"Model capabilities for {model}: vision={supports_vision}, functions={supports_functions}")
    
    return ModelCapabilitiesResponse(
        model=model,
        supports_vision=supports_vision,
        supports_functions=supports_functions,
        supports_streaming=True,  # Most modern models support streaming
        context_window=settings.llm.context_window if model == settings.llm.model else None,
        max_tokens=settings.llm.max_tokens if model == settings.llm.model else None
    )

