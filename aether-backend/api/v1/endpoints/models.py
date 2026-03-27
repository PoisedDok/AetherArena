"""
Model Management Endpoints

Endpoints for LLM model discovery and capabilities.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET), External LLM APIs --- {HTTP requests to /v1/models, /v1/models/active, /v1/models/capabilities, HTTP responses from LLM providers}
Processing: list_models(), get_active_model(), model_capabilities() --- {JOB_HTTP_REQUEST, JOB_MATCH_MODEL}
Outgoing: External LLM APIs (HTTP GET), Frontend (HTTP) --- {HTTP GET to {api_base}/models, ModelsListResponse, ModelCapabilitiesResponse}
"""

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse

from api.dependencies import get_runtime_settings, setup_request_context
from data.network.llm_gateway import get_llm_gateway
from core.domain.gateway_interfaces import ILlmProviderGateway
from api.v1.schemas.models import ModelsListResponse, ModelCapabilitiesResponse
from config.settings import Settings
from monitoring import get_logger
from core.exceptions import NetworkTimeoutError, UpstreamServiceError

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
    settings: Settings = Depends(get_runtime_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ILlmProviderGateway = Depends(get_llm_gateway)
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
        data = await gateway.fetch_models(url, {}, timeout=30.0)
        
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
        
        logger.debug("Listed %s models from %s", len(names), effective_base)
        
        return ModelsListResponse(
            models=names if names else (data if isinstance(data, list) else []),
            count=len(names) if names else (len(data) if isinstance(data, list) else 0)
        )
            
    except NetworkTimeoutError:
        logger.error("Timeout connecting to %s", url)
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"Timeout connecting to model provider at {effective_base}"
        )
    except UpstreamServiceError as e:
        logger.error("HTTP error from %s: %s", url, e)
        raise HTTPException(
            status_code=e.status_code,
            detail=f"Error from model provider: {e.message}"
        )
    except Exception as e:
        logger.error("Failed to list models from %s: %s", url, e, exc_info=True)
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
    settings: Settings = Depends(get_runtime_settings),
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
        logger.error("Failed to get active model: %s", e, exc_info=True)
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
    settings: Settings = Depends(get_runtime_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ILlmProviderGateway = Depends(get_llm_gateway)
) -> ModelCapabilitiesResponse:
    """
    Get model capabilities.
    
    Checks if model supports:
    - Vision (image inputs)
    - Functions/tools
    - Streaming
    
    Queries the inference server's /v1/models to get PHYSICAL model limits
    (context_window_max, default_max_tokens, default_temperature, etc.)
    so the frontend can set slider bounds correctly.
    
    Also returns the user's current settings (context_window, max_tokens)
    so the frontend can set slider VALUES correctly.
    
    Args:
        model: Model name to check
        
    Returns:
        ModelCapabilitiesResponse: Model capabilities with physical limits + user settings
    """
    try:
        supports_vision = False
        supports_functions = False
        
        # Physical model limits from inference server
        context_window_max = None
        default_max_tokens = None
        default_temperature = None
        default_top_p = None
        default_top_k = None
        
        # Try litellm detection via gateway.
        supports_vision = gateway.check_litellm_vision_support(model)
        
        # Query inference server for physical model parameters
        # This gives us the model's ACTUAL limits (from its config.json)
        inference_url = settings.inference_url.rstrip("/")
        try:
            data = await gateway.fetch_models(f"{inference_url}/models", {}, timeout=5.0)
            models_list = data.get("data", [])
            
            # Find the matching model by ID (exact or substring match)
            model_lower = model.lower()
            matched = None
            for m in models_list:
                mid = (m.get("id") or "").lower()
                if mid == model_lower:
                    matched = m
                    break
            
            # Fuzzy match: model name tokens appear in model ID
            if not matched:
                model_tokens = set(model_lower.replace("/", "-").replace("_", "-").split("-"))
                model_tokens = {t for t in model_tokens if len(t) > 1}
                best_score = 0
                for m in models_list:
                    mid = (m.get("id") or "").lower()
                    mid_tokens = set(mid.replace("/", "-").replace("_", "-").split("-"))
                    overlap = len(model_tokens & mid_tokens)
                    if overlap > best_score and overlap >= max(1, len(model_tokens) // 2):
                        best_score = overlap
                        matched = m
            
            if matched:
                params = matched.get("parameters", {})
                context_window_max = params.get("context_length")
                default_max_tokens = params.get("default_max_tokens")
                default_temperature = params.get("default_temperature")
                default_top_p = params.get("default_top_p")
                default_top_k = params.get("default_top_k")
                
                # Use inference server's model_type for vision detection
                if matched.get("model_type") == "vision":
                    supports_vision = True
                caps = matched.get("capabilities", {})
                if caps.get("vision"):
                    supports_vision = True
                if caps.get("tool_use"):
                    supports_functions = True
                
                logger.debug(
                    "Inference server model params for %s: ctx_max=%s, max_tok=%s, temp=%s",
                    model, context_window_max, default_max_tokens, default_temperature
                )
        except Exception as e:
            logger.debug("Could not query inference server for model params: %s", e)
        
        # User's current settings (slider VALUES)
        user_context_window = settings.llm.context_window if model == settings.llm.model else context_window_max
        user_max_tokens = settings.llm.max_tokens if model == settings.llm.model else default_max_tokens
        
        logger.debug(
            f"Model capabilities for {model}: vision={supports_vision}, functions={supports_functions}, "
            f"ctx={user_context_window}, ctx_max={context_window_max}"
        )
        
        return ModelCapabilitiesResponse(
            model=model,
            supports_vision=supports_vision,
            supports_functions=supports_functions,
            supports_streaming=True,
            # User's chosen values (slider position)
            context_window=user_context_window,
            max_tokens=user_max_tokens,
            # Physical limits from inference server (slider bounds)
            context_window_max=context_window_max,
            default_max_tokens=default_max_tokens,
            default_temperature=default_temperature,
            default_top_p=default_top_p,
            default_top_k=default_top_k,
        )
    except Exception as e:
        logger.error("Failed to retrieve capabilities for model %s: %s", model, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve model capabilities. Check server logs for details."
        )

