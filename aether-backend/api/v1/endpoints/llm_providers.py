"""
LLM Provider Discovery and Configuration Endpoints

Auto-detects available LLM providers (LM Studio, Ollama, etc.) and manages user configuration.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/llm-providers/*}
Processing: discover_providers(), list_models(), save_config(), get_config() --- {JOB_HTTP_REQUEST, JOB_PROVIDER_DETECT, JOB_MODEL_LIST}
Outgoing: External LLM APIs (HTTP GET), Database (user_settings), Frontend (HTTP) --- {Provider list, model list, config saved/retrieved}
"""

from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from core.exceptions import DomainException
from api.dependencies import get_settings, setup_request_context, get_database
from data.database.persistence_gateway import SupabasePersistenceGateway
from data.network.llm_gateway import get_llm_gateway
from core.domain.gateway_interfaces import ILlmProviderGateway
from config.settings import Settings
from monitoring import get_logger
from core.exceptions import UpstreamServiceError

logger = get_logger(__name__)
router = APIRouter(prefix="/llm-providers", tags=["llm-providers"])


# =============================================================================
# Schemas
# =============================================================================

class ProviderInfo(BaseModel):
    """Information about a discovered LLM provider"""
    key: str = Field(..., description="Unique provider key (e.g., 'ollama', 'lmstudio')")
    displayName: str = Field(..., description="Human-readable name")
    url: str = Field(..., description="API endpoint URL")
    available: bool = Field(..., description="Whether provider is currently accessible")
    models: List[str] = Field(default_factory=list, description="List of available model names (if accessible)")


class ProviderConfigRequest(BaseModel):
    """User's LLM provider configuration"""
    provider_key: str = Field(..., description="Selected provider key")
    provider_url: str = Field(..., description="Provider API endpoint URL")
    model_name: Optional[str] = Field(None, description="Selected model name")


class ProviderConfigResponse(BaseModel):
    """Response for saved provider configuration"""
    provider_key: str
    provider_url: str
    model_name: Optional[str]
    updated_at: Optional[str]


# =============================================================================
# Known Provider Defaults
# =============================================================================

KNOWN_PROVIDERS = [
    {
        "key": "aether_inference",
        "displayName": "Aether Inference (Built-in)",
        "defaultUrl": "http://127.0.0.1:7090/v1",
        "healthEndpoint": "/models",
    },
    {
        "key": "lmstudio",
        "displayName": "LM Studio",
        "defaultUrl": "http://localhost:1234/v1",
        "healthEndpoint": "/models",
    },
    {
        "key": "ollama",
        "displayName": "Ollama",
        "defaultUrl": "http://127.0.0.1:11434",
        "healthEndpoint": "/api/version",
    },
    {
        "key": "openai",
        "displayName": "OpenAI",
        "defaultUrl": "https://api.openai.com/v1",
        "healthEndpoint": "/models",
        "requiresAuth": True,
    },
    {
        "key": "openrouter",
        "displayName": "OpenRouter",
        "defaultUrl": "https://openrouter.ai/api/v1",
        "healthEndpoint": "/models",
        "requiresAuth": True,
    },
    {
        "key": "custom_openai",
        "displayName": "Custom OpenAI-Compatible",
        "defaultUrl": "http://localhost:8080/v1",
        "healthEndpoint": "/models",
    },
]


# =============================================================================
# Provider Detection Logic
# =============================================================================

async def check_provider_availability(url: str, health_endpoint: str, gateway: Optional[ILlmProviderGateway] = None, requires_auth: bool = False) -> bool:
    """
    Check if a provider is available at the given URL.
    
    Args:
        url: Base URL of the provider
        health_endpoint: Health check endpoint path
        gateway: LLM gateway
        requires_auth: Whether this provider requires authentication
        
    Returns:
        True if provider is available, False otherwise
    """
    if gateway is None:
        gateway = get_llm_gateway()

    if requires_auth:
        # Don't auto-check providers that require API keys
        # User must explicitly configure them
        return False
    
    try:
        url_stripped = url.rstrip('/')
        if not health_endpoint.startswith('/'):
            health_endpoint = f"/{health_endpoint}"
        full_url = f"{url_stripped}{health_endpoint}"
        
        await gateway.verify_provider(full_url, {}, timeout=3.0)
        return True
    except UpstreamServiceError as e:
        # AetherHTTPClient wraps HTTPStatusError in UpstreamServiceError
        if e.status_code and 400 <= e.status_code < 500:
            return True
        return False
    except Exception:  # noqa: BLE001 — health probe must never crash
        return False


async def fetch_provider_models(url: str, provider_key: str, gateway: Optional[ILlmProviderGateway] = None) -> List[str]:
    """
    Fetch available models from a provider.
    
    Args:
        url: Base URL of the provider
        provider_key: Provider key for format detection
        
    Returns:
        List of model names
    """
    if gateway is None:
        gateway = get_llm_gateway()

    # Determine models endpoint based on provider type
    if provider_key == "ollama":
        models_url = f"{url.rstrip('/')}/api/tags"
    else:
        # OpenAI-compatible format (LM Studio, OpenAI, etc.)
        models_url = f"{url.rstrip('/')}/models"
    
    try:
        data = await gateway.fetch_models(models_url, {}, timeout=5.0)
        
        # Parse response based on provider format
        if provider_key == "ollama":
            # Ollama format: {"models": [{"model": "...", "name": "..."}, ...]}
            if not data or not isinstance(data.get("models"), list):
                return []
            return [model.get("model") or model.get("name") for model in data.get("models", [])]
        else:
            # OpenAI format: {"data": [{"id": "..."}, ...]}
            if data and isinstance(data.get("data"), list):
                return [model.get("id") for model in data["data"] if model.get("id")]
            return []
    except Exception as e:
        logger.warning("Failed to fetch models from %s: %s", url, e)
        return []


# =============================================================================
# Endpoints
# =============================================================================

@router.get(
    "/discover",
    response_model=List[ProviderInfo],
    summary="Discover available LLM providers",
    description="Auto-detects locally running LLM providers (LM Studio, Ollama, etc.) and returns list with availability status"
)
async def discover_providers(
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ILlmProviderGateway = Depends(get_llm_gateway)
) -> List[ProviderInfo]:
    """
    Discover available LLM providers on the local machine.
    
    Returns providers sorted with available ones first (highlighted for user).
    """
    try:
        discovered_providers: List[ProviderInfo] = []
        
        for provider_spec in KNOWN_PROVIDERS:
            url = provider_spec["defaultUrl"]
            
            # Dynamic URL resolution from central config
            if provider_spec["key"] == "aether_inference":
                url = settings.inference_url
            
            available = await check_provider_availability(
                url=url,
                health_endpoint=provider_spec["healthEndpoint"],
                gateway=gateway,
                requires_auth=provider_spec.get("requiresAuth", False)
            )
            
            models = []
            if available and not provider_spec.get("requiresAuth"):
                models = await fetch_provider_models(url, provider_spec["key"], gateway)
            
            discovered_providers.append(ProviderInfo(
                key=provider_spec["key"],
                displayName=provider_spec["displayName"],
                url=url,
                available=available,
                models=models
            ))
        
        # Sort: available providers first
        discovered_providers.sort(key=lambda p: (not p.available, p.displayName))
        
        logger.info("Discovered %s available LLM providers", len([p for p in discovered_providers if p.available]))
        return discovered_providers
    except Exception as e:
        logger.error("Failed to discover providers: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to discover LLM providers. Check server logs for details."
        )


@router.get(
    "/models",
    summary="List models from a specific provider",
    description="Fetch available models from a given provider URL"
)
async def list_provider_models(
    provider_url: str,
    provider_key: str = "custom_openai",
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ILlmProviderGateway = Depends(get_llm_gateway)
) -> Dict[str, Any]:
    """
    List models from a specific provider URL.
    
    Args:
        provider_url: Base URL of the provider
        provider_key: Provider key for format detection (ollama, lmstudio, etc.)
        
    Returns:
        Dictionary with models list and count
    """
    try:
        if not provider_url:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="provider_url is required"
            )
        
        models = await fetch_provider_models(provider_url, provider_key, gateway)
        
        return {
            "provider_url": provider_url,
            "provider_key": provider_key,
            "models": models,
            "count": len(models)
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to list provider models for %s: %s", provider_url, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list models for provider. Check server logs for details."
        )


@router.post(
    "/config",
    response_model=ProviderConfigResponse,
    summary="Save LLM provider configuration",
    description="Save user's selected LLM provider, URL, and model to database"
)
async def save_provider_config(
    config: ProviderConfigRequest,
    gateway: SupabasePersistenceGateway = Depends(get_database),
    _context: dict = Depends(setup_request_context)
) -> ProviderConfigResponse:
    """
    Save user's LLM provider configuration to database.
    
    Stores in user_settings table for persistence across sessions.
    """
    try:
        # Upsert configuration into user_settings table
        config_data = {
            "setting_key": "llm_provider",
            "setting_value": {
                "provider_key": config.provider_key,
                "provider_url": config.provider_url,
                "model_name": config.model_name,
            }
        }
        
        result = await gateway.upsert(
            "user_settings",
            config_data,
            admin=True  # Use service_role to bypass RLS
        )
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save provider configuration"
            )
        
        # Gateway upsert returns list or single dict
        saved = result[0] if isinstance(result, list) else result
        
        logger.info("Saved LLM provider config: %s at %s", config.provider_key, config.provider_url)
        
        return ProviderConfigResponse(
            provider_key=config.provider_key,
            provider_url=config.provider_url,
            model_name=config.model_name,
            updated_at=saved.get("updated_at")
        )
        
    except (HTTPException, DomainException):
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        logger.error("Failed to save provider config: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save provider configuration. Check server logs for details."
        )


@router.get(
    "/config",
    response_model=ProviderConfigResponse,
    summary="Get current LLM provider configuration",
    description="Retrieve user's currently configured LLM provider settings"
)
async def get_provider_config(
    gateway: SupabasePersistenceGateway = Depends(get_database),
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> ProviderConfigResponse:
    """
    Get user's current LLM provider configuration from database.
    
    Falls back to default settings if no user config exists.
    """
    try:
        result = await gateway.select(
            "user_settings",
            columns="*",
            filters={"setting_key": "llm_provider"},
            limit=1,
            admin=True  # Use service_role to bypass RLS
        )
        
        # Central config fallbacks (no hardcoding)
        default_url = settings.llm.api_base
        default_model = settings.llm.model
        
        if result and len(result) > 0:
            saved = result[0]
            value = saved["setting_value"]
            
            return ProviderConfigResponse(
                provider_key=value.get("provider_key", settings.llm.provider),
                provider_url=value.get("provider_url", default_url),
                model_name=value.get("model_name"),
                updated_at=saved.get("updated_at")
            )
        else:
            # Return default configuration from central config
            return ProviderConfigResponse(
                provider_key=settings.llm.provider,
                provider_url=default_url,
                model_name=default_model,
                updated_at=None
            )
            
    except (HTTPException, DomainException):
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        logger.error("Failed to retrieve provider config: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve provider configuration"
        )
