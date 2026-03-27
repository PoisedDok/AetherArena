import os
from typing import Optional

from fastapi import Depends, HTTPException, Request, status

from monitoring import get_logger
from config.settings import Settings
from .core import get_settings
from security.auth import AuthConfig, AuthenticationManager, AuthenticationError, get_auth_manager
from security.permissions import AuthorizationContext, User, Role, get_permission_manager

logger = get_logger(__name__)

def require_local_request(request: Request, settings: Settings = Depends(get_settings)) -> None:
    """
    Enforce that the request originates from localhost and target the correct host.
    This prevents external access AND DNS rebinding attacks.
    """
    client = getattr(request, "client", None)
    client_host = getattr(client, "host", None) if client else None
    
    # 1. Validate Client IP (Strict loopback and local private networks for Docker support)
    is_local_ip = client_host in {"127.0.0.1", "::1"}
    
    if not is_local_ip:
        # Allow internal Docker network IPs and private LAN subnets ALWAYS
        # so that the Docker mesh (Supabase, Kong, etc.) can reach the backend host.
        if client_host and (client_host.startswith("172.") or client_host.startswith("192.168.") or client_host.startswith("10.")):
            is_local_ip = True
            
        # If external bind is explicitly allowed, accept any IP.
        if os.getenv("AETHER_ALLOW_EXTERNAL_BIND", "false").lower() == "true":
            is_local_ip = True
    
    # Allow test clients in test environment
    if not is_local_ip and (settings.environment == "test" or os.getenv("TESTING") == "1"):
        if client_host in {"test", "testclient", "testserver"}:
            is_local_ip = True

    if not is_local_ip:
        logger.warning("Blocked non-local request from %s", client_host)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Local-only endpoint: access denied",
        )

    # 2. Validate Host Header (DNS Rebinding Protection)
    # The Host header MUST be localhost or 127.0.0.1
    host_raw = request.headers.get("host", "").lower()
    # Handle both IPv4 (127.0.0.1:8765) and IPv6 ([::1]:8765) formats
    if ":" in host_raw:
        if host_raw.startswith("["):
            # IPv6 case: [::1]:8765 -> [::1]
            host_header = host_raw.split("]")[0] + "]"
        else:
            # IPv4 case: 127.0.0.1:8765 -> 127.0.0.1
            host_header = host_raw.split(":")[0]
    else:
        host_header = host_raw

    # Allow empty host header only if not in production (some test clients)
    if not host_header:
        if settings.environment != "production":
            return
        else:
            logger.warning("Blocked request with empty Host header in production")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Host header required",
            )

    allow_external = os.getenv("AETHER_ALLOW_EXTERNAL_BIND", "false").lower() == "true"
    
    if not allow_external and host_header not in {"localhost", "127.0.0.1", "[::1]", "host.docker.internal", "0.0.0.0"}:
        # Allow 'test' host in test environment for integration tests
        if (settings.environment == "test" or os.getenv("TESTING") == "1") and host_header in {"test", "testclient", "testserver"}:
            pass
        else:
            logger.warning("Blocked potential DNS rebinding attack with Host: '%s'", host_header)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Security violation: invalid Host header",
            )

    # 3. Validate Origin Header (CSRF Protection)
    origin_header = request.headers.get("origin")
    # We enforce strict origin checks using settings
    if origin_header is not None:
        origin_lower = origin_header.lower()
        allowed_origins = {origin.lower().rstrip('/') for origin in getattr(settings.security, "allowed_origins", [])}
        # Add internal defaults just in case config is sparse
        allowed_origins.update({
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:8765",
            "http://127.0.0.1:8765",
        })
        
        # Test environment bypass
        is_test_env = settings.environment == "test" or os.getenv("TESTING") == "1"
        
        # Electron apps can send "null", "file://", "app://", or custom protocols
        if not (origin_lower == "null" or origin_lower.startswith("file://") or origin_lower.startswith("aether://") or origin_lower.startswith("app://") or origin_lower in allowed_origins or is_test_env):
            logger.warning("Blocked request with unauthorized Origin header: '%s'", origin_header)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Security violation: invalid Origin header",
            )

    # 4. Validate Sec-Fetch-Site Header (CSRF Protection)
    # REMOVED ARCHITECTURALLY: Electron's fetch() from file:// to localhost is classified
    # as "cross-site" by Chromium. Blocking "cross-site" completely breaks
    # the desktop app's ability to communicate with its own backend.
    pass


def require_local_request_dependency(
    request: Request,
    settings: Settings = Depends(get_settings)
) -> None:
    """
    Dependency wrapper for local-only enforcement.
    """
    require_local_request(request, settings)


# =============================================================================
# Authentication Dependencies
# =============================================================================

_auth_seeded: bool = False


def _get_authentication_manager(settings: Settings) -> AuthenticationManager:
    """Configure and return global authentication manager from settings."""
    global _auth_seeded

    require_api_key = settings.security.auth_enabled and settings.security.api_key_required
    allow_anonymous = settings.security.allow_anonymous and not require_api_key

    config = AuthConfig(
        require_api_key=require_api_key,
        api_key_header=settings.security.api_key_header,
        allow_bearer_tokens=settings.security.allow_bearer_tokens,
        allow_anonymous=allow_anonymous,
        default_role=settings.security.default_role or Role.USER,
    )

    manager = get_auth_manager(config)
    manager.config = config

    if not _auth_seeded:
        for key_definition in settings.security.static_api_keys:
            metadata = {"source": "settings.api_keys"}
            manager.register_api_key(
                user_id=key_definition.user_id,
                role=key_definition.role or config.default_role,
                description=key_definition.description,
                metadata=metadata,
                api_key=key_definition.key,
            )
        _auth_seeded = True

    return manager


async def require_auth_context(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> AuthorizationContext:
    """
    Enforce API authentication (API key and/or bearer token).
    """
    manager = _get_authentication_manager(settings)
    api_key_value = request.headers.get(settings.security.api_key_header)
    bearer_header = request.headers.get("Authorization")
    bearer_token = None
    if bearer_header and bearer_header.lower().startswith("bearer "):
        bearer_token = bearer_header.split(" ", 1)[1].strip() or None

    try:
        context = manager.authenticate_request(
            api_key=api_key_value,
            bearer_token=bearer_token,
        )
    except AuthenticationError as exc:
        logger.warning("Authentication failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc

    request.state.auth_context = context
    return context


def get_anonymous_context() -> AuthorizationContext:
    """Return anonymous authorization context."""
    perm_manager = get_permission_manager()
    anonymous = User(user_id="anonymous", role=Role.ANONYMOUS, metadata={"authenticated": False})
    return AuthorizationContext(anonymous, perm_manager)


# =============================================================================
# Rate Limiting Dependencies (Future)
# =============================================================================

async def check_rate_limit(
    request: Request,
    identifier: Optional[str] = None
) -> None:
    """
    Check rate limit for request.
    
    Currently placeholder for future rate limiting implementation.
    Will integrate with security.rate_limit module.
    
    Args:
        request: FastAPI request object
        identifier: Optional identifier for rate limiting (IP, user ID, etc.)
        
    Raises:
        HTTPException: If rate limit is exceeded
    """
    # Future: Implement rate limiting check
    # from security.rate_limit import check_limit
    # if not await check_limit(identifier or request.client.host):
    #     raise HTTPException(status_code=429, detail="Rate limit exceeded")
    pass
