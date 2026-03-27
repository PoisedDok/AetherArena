from typing import Optional, Dict, Any
from fastapi import Depends, Header, Request
import uuid

from config.settings import Settings, get_settings as load_settings
from monitoring import get_logger, set_request_context, clear_request_context
from application.settings import get_runtime_settings_service

logger = get_logger(__name__)

# =============================================================================
# Settings Dependencies
# =============================================================================

def shutdown_runtime_settings_service():
    rss = get_runtime_settings_service()
    if rss is not None:
        rss.dispose()

def get_settings() -> Settings:
    """
    Get application settings (no caching - delegates to config.settings.get_settings).
    
    Loads settings from config files and environment variables.
    Caching removed to allow hot-reload of profile changes.
    
    Returns:
        Settings: Application configuration (always fresh from disk)
    """
    return load_settings()

async def get_runtime_settings(
    request: Request,
    x_user_id: Optional[str] = Header(None),
    cache_control: Optional[str] = Header(None)
) -> Settings:
    """
    Dependency for runtime settings (with DB overrides).

    Use this for endpoints that need current user-selected settings.
    Use get_settings() for endpoints that only need schema/defaults.

    Args:
        request: FastAPI request object
        x_user_id: Optional user identifier from request header
        cache_control: Optional Cache-Control header (no-cache forces refresh)

    Returns:
        Settings: Settings with DB overrides merged
    """
    from .database import get_database_connection
    rss = get_runtime_settings_service()
    settings = load_settings()
    resolved_user_id = (
        x_user_id.strip() if x_user_id and x_user_id.strip() else settings.security.default_user_id
    )
    gateway = get_database_connection()
    if gateway is None:
        logger.debug("Database not available, returning default settings for user %s", resolved_user_id)
        return settings
    
    # Check for cache-busting header
    force_refresh = False
    if cache_control and ("no-cache" in cache_control.lower() or "no-store" in cache_control.lower()):
        force_refresh = True
        logger.info("Forced refresh of runtime settings for user %s", resolved_user_id)

    return await rss.get_runtime_settings(gateway, resolved_user_id, force_refresh=force_refresh)

# =============================================================================
# Request Context Dependencies
# =============================================================================

async def setup_request_context(
    request: Request,
    x_request_id: Optional[str] = Header(None),
    x_user_id: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None),
    x_chat_id: Optional[str] = Header(None),
    x_frontend_id: Optional[str] = Header(None),
    x_correlation_id: Optional[str] = Header(None),
    x_operator_id: Optional[str] = Header(None)
) -> dict:
    """
    Setup request context for logging and tracing.
    
    Extracts request metadata and sets up context variables for
    structured logging and distributed tracing.
    """
    # Generate request ID if not provided
    request_id = (
        x_request_id.strip() if x_request_id and x_request_id.strip() else str(uuid.uuid4())
    )
    correlation_id = (
        x_correlation_id.strip() if x_correlation_id and x_correlation_id.strip() else request_id
    )
    frontend_id = (
        x_frontend_id.strip() if x_frontend_id and x_frontend_id.strip() else "local-single-user"
    )
    user_id = x_user_id.strip() if x_user_id and x_user_id.strip() else None
    
    # Authoritative chat_id mapping
    chat_id = x_chat_id.strip() if x_chat_id and x_chat_id.strip() else None
    session_id = x_session_id.strip() if x_session_id and x_session_id.strip() else chat_id
    
    # Resolve operator_id (defaults to x_operator_id or None)
    operator_id = x_operator_id.strip() if x_operator_id and x_operator_id.strip() else None
    
    # Set logging context
    set_request_context(
        request_id=request_id,
        user_id=user_id,
        session_id=session_id,
        chat_id=chat_id,
        frontend_id=frontend_id,
        correlation_id=correlation_id,
        operator_id=operator_id,
    )
    
    # Store in request state for access in handlers
    request.state.request_id = request_id
    request.state.user_id = user_id
    request.state.session_id = session_id
    request.state.chat_id = chat_id
    request.state.frontend_id = frontend_id
    request.state.correlation_id = correlation_id
    request.state.operator_id = operator_id
    
    return {
        "request_id": request_id,
        "user_id": user_id,
        "session_id": session_id,
        "chat_id": chat_id,
        "frontend_id": frontend_id,
        "correlation_id": correlation_id,
        "operator_id": operator_id,
        "method": request.method,
        "path": request.url.path
    }

async def cleanup_request_context():
    """
    Cleanup request context after request completes.
    
    Should be called in middleware or as dependency cleanup.
    """
    clear_request_context()

def _build_request_context_payload(request: Optional[Request]) -> Dict[str, Any]:
    """
    Normalize request metadata for downstream contexts (Supabase, Redis, tracing).
    """
    state = getattr(request, "state", None)
    request_id = getattr(state, "request_id", None) or str(uuid.uuid4())
    correlation_id = getattr(state, "correlation_id", None) or request_id
    session_id = getattr(state, "session_id", None)
    user_id = getattr(state, "user_id", None)
    actor_id = getattr(state, "operator_id", None) or user_id
    frontend_id = getattr(state, "frontend_id", None)

    http_method = getattr(request, "method", None)
    http_path = None
    if request is not None:
        try:
            http_path = request.url.path
        except Exception:
            http_path = None
    client_ip = None
    if request is not None and request.client:
        client_ip = request.client.host

    extras = {
        "http.method": http_method,
        "http.path": http_path,
        "client.ip": client_ip,
        "frontend.id": frontend_id,
    }

    return {
        "request_id": request_id,
        "correlation_id": correlation_id,
        "session_id": session_id,
        "user_id": user_id,
        "actor_id": actor_id,
        "extras": {k: v for k, v in extras.items() if v is not None},
    }

# =============================================================================
# Pagination Dependencies
# =============================================================================

class PaginationParams:
    """Pagination parameters for list endpoints."""
    
    def __init__(
        self,
        skip: int = 0,
        limit: int = 100,
        max_limit: int = 1000
    ):
        self.skip = max(0, skip)
        self.limit = min(max(1, limit), max_limit)
        self.max_limit = max_limit

def get_pagination_params(
    skip: int = 0,
    limit: int = 100
) -> PaginationParams:
    """
    Get pagination parameters from query string.
    
    Args:
        skip: Number of items to skip (offset)
        limit: Maximum number of items to return
        
    Returns:
        PaginationParams: Validated pagination parameters
    """
    return PaginationParams(skip=skip, limit=limit)
