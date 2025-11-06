"""
Settings Management Endpoints

Endpoints for managing application settings.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/PUT/PATCH/POST) --- {HTTP requests to /v1/settings, SettingsUpdateRequest JSON payloads}
Processing: get_application_settings(), update_application_settings(), reload_application_settings() --- {3 jobs: settings_retrieval, settings_mutation, settings_reloading}
Outgoing: config/settings.py, Frontend (HTTP) --- {Settings instance mutations, SettingsResponse with LLM/interpreter/security/integration configs}
"""

from typing import Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status

from api.dependencies import get_settings, setup_request_context
from api.v1.schemas.settings import (
    SettingsResponse,
    SettingsUpdateRequest,
    LLMSettingsResponse,
    InterpreterSettingsResponse,
    SecuritySettingsResponse,
    IntegrationSettingsResponse
)
from config.settings import Settings, reload_settings
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["settings"])


# =============================================================================
# Get Settings
# =============================================================================

@router.get(
    "/settings",
    response_model=SettingsResponse,
    summary="Get application settings",
    description="Retrieve current application settings"
)
async def get_application_settings(
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> SettingsResponse:
    """
    Get application settings.
    
    Returns current configuration including LLM, interpreter,
    security, and integration settings.
    """
    try:
        return SettingsResponse(
            app_name=settings.app_name,
            app_version=settings.app_version,
            environment=settings.environment,
            llm=LLMSettingsResponse(
                provider=settings.llm.provider,
                api_base=settings.llm.api_base,
                model=settings.llm.model,
                supports_vision=settings.llm.supports_vision,
                context_window=settings.llm.context_window,
                max_tokens=settings.llm.max_tokens,
                temperature=settings.llm.temperature
            ),
            interpreter=InterpreterSettingsResponse(
                auto_run=settings.interpreter.auto_run,
                loop=settings.interpreter.loop,
                safe_mode=settings.interpreter.safe_mode,
                system_message=settings.interpreter.system_message,
                profile=settings.interpreter.profile,
                offline=settings.interpreter.offline,
                disable_telemetry=settings.interpreter.disable_telemetry
            ),
            security=SecuritySettingsResponse(
                bind_host=settings.security.bind_host,
                bind_port=settings.security.bind_port,
                allowed_origins=settings.security.allowed_origins,
                cors_allow_credentials=settings.security.cors_allow_credentials,
                auth_enabled=settings.security.auth_enabled,
                rate_limit_enabled=settings.security.rate_limit_enabled
            ),
            integrations=IntegrationSettingsResponse(
                perplexica_url=settings.integrations.perplexica_url,
                perplexica_enabled=settings.integrations.perplexica_enabled,
                searxng_url=settings.integrations.searxng_url,
                searxng_enabled=settings.integrations.searxng_enabled,
                docling_url=settings.integrations.docling_url,
                docling_enabled=settings.integrations.docling_enabled,
                mcp_enabled=settings.integrations.mcp_enabled,
                mcp_auto_start=settings.integrations.mcp_auto_start
            )
        )
    except Exception as e:
        logger.error(f"Failed to get settings: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve settings"
        )


# =============================================================================
# Update Settings
# =============================================================================

@router.put(
    "/settings",
    response_model=SettingsResponse,
    summary="Update application settings",
    description="Update application settings (partial update supported)"
)
async def update_application_settings_put(
    update_request: SettingsUpdateRequest,
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> SettingsResponse:
    """Update application settings (PUT)."""
    return await update_application_settings(update_request, settings, _context)


@router.patch(
    "/settings",
    response_model=SettingsResponse,
    summary="Update application settings (partial)",
    description="Update application settings (partial update supported)"
)
async def update_application_settings_patch(
    update_request: SettingsUpdateRequest,
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> SettingsResponse:
    """Update application settings (PATCH)."""
    return await update_application_settings(update_request, settings, _context)


@router.post(
    "/settings",
    response_model=SettingsResponse,
    summary="Update application settings",
    description="Update application settings (partial update supported)"
)
async def update_application_settings(
    update_request: SettingsUpdateRequest,
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> SettingsResponse:
    """
    Update application settings.
    
    Supports partial updates - only provided fields will be updated.
    Changes are validated before applying.
    
    Note: Some settings may require application restart to take effect.
    """
    try:
        # Update LLM settings
        if update_request.llm:
            if update_request.llm.provider is not None:
                settings.llm.provider = update_request.llm.provider
            if update_request.llm.api_base is not None:
                settings.llm.api_base = update_request.llm.api_base
            if update_request.llm.model is not None:
                settings.llm.model = update_request.llm.model
            if update_request.llm.supports_vision is not None:
                settings.llm.supports_vision = update_request.llm.supports_vision
            if update_request.llm.context_window is not None:
                settings.llm.context_window = update_request.llm.context_window
            if update_request.llm.max_tokens is not None:
                settings.llm.max_tokens = update_request.llm.max_tokens
            if update_request.llm.temperature is not None:
                settings.llm.temperature = update_request.llm.temperature
        
        # Update interpreter settings
        if update_request.interpreter:
            if update_request.interpreter.auto_run is not None:
                settings.interpreter.auto_run = update_request.interpreter.auto_run
            if update_request.interpreter.loop is not None:
                settings.interpreter.loop = update_request.interpreter.loop
            if update_request.interpreter.safe_mode is not None:
                settings.interpreter.safe_mode = update_request.interpreter.safe_mode
            if update_request.interpreter.system_message is not None:
                settings.interpreter.system_message = update_request.interpreter.system_message
            if update_request.interpreter.profile is not None:
                settings.interpreter.profile = update_request.interpreter.profile
        
        # Update integration settings
        if update_request.integrations:
            if update_request.integrations.perplexica_enabled is not None:
                settings.integrations.perplexica_enabled = update_request.integrations.perplexica_enabled
            if update_request.integrations.searxng_enabled is not None:
                settings.integrations.searxng_enabled = update_request.integrations.searxng_enabled
            if update_request.integrations.docling_enabled is not None:
                settings.integrations.docling_enabled = update_request.integrations.docling_enabled
            if update_request.integrations.mcp_enabled is not None:
                settings.integrations.mcp_enabled = update_request.integrations.mcp_enabled
            if update_request.integrations.mcp_auto_start is not None:
                settings.integrations.mcp_auto_start = update_request.integrations.mcp_auto_start
        
        logger.info("Settings updated successfully", extra={
            "llm_updated": update_request.llm is not None,
            "interpreter_updated": update_request.interpreter is not None,
            "integrations_updated": update_request.integrations is not None
        })
        
        # Return updated settings
        return await get_application_settings(settings, _context)
        
    except Exception as e:
        logger.error(f"Failed to update settings: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update settings"
        )


# =============================================================================
# Reload Settings
# =============================================================================

@router.post(
    "/settings/reload",
    response_model=SettingsResponse,
    summary="Reload settings from file",
    description="Reload settings from configuration files (discards in-memory changes)"
)
async def reload_application_settings(
    _context: dict = Depends(setup_request_context)
) -> SettingsResponse:
    """
    Reload settings from configuration files.
    
    Discards any in-memory changes and reloads from:
    - TOML config file
    - Environment variables
    - Default values
    """
    try:
        logger.info("Reloading settings from file")
        settings = reload_settings()
        
        return await get_application_settings(settings, _context)
        
    except Exception as e:
        logger.error(f"Failed to reload settings: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reload settings"
        )

