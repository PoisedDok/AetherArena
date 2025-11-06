"""
API Dependencies

FastAPI dependency injection functions for:
- Settings management
- Runtime engine access
- Database connections
- MCP manager access
- Request context setup
- Authentication (future)

@.architecture
Incoming: app.py (startup_event), api/v1/endpoints/*.py --- {set_runtime_engine/set_mcp_manager/set_database_connection calls, Depends() injections from endpoints}
Processing: get_settings(), get_runtime_engine(), get_mcp_manager(), get_database(), setup_request_context(), cleanup_request_context(), get_pagination_params() --- {5 jobs: cleanup, context_setup, dependency_injection, resource_management, validation}
Outgoing: api/v1/endpoints/*.py, app.py --- {Settings instance, RuntimeEngine instance, MCPServerManager instance, DatabaseConnection instance, request context dict, PaginationParams}
"""

from typing import AsyncGenerator, Optional
from fastapi import Depends, HTTPException, Header, Request
from functools import lru_cache
import uuid

from config.settings import Settings, get_settings as load_settings
from core.runtime.engine import RuntimeEngine
from core.mcp.manager import MCPServerManager
from data.database.connection import DatabaseConnection
from monitoring import get_logger, set_request_context, clear_request_context

logger = get_logger(__name__)


# =============================================================================
# Settings Dependencies
# =============================================================================

@lru_cache()
def get_settings() -> Settings:
    """
    Get application settings (cached).
    
    Loads settings from config files and environment variables.
    Cached to avoid repeated file I/O.
    
    Returns:
        Settings: Application configuration
    """
    return load_settings()


# =============================================================================
# Runtime Engine Dependencies
# =============================================================================

_runtime_engine: Optional[RuntimeEngine] = None


def set_runtime_engine(engine: RuntimeEngine) -> None:
    """Set the global runtime engine instance."""
    global _runtime_engine
    _runtime_engine = engine


def get_runtime_engine() -> RuntimeEngine:
    """
    Get the runtime engine instance.
    
    The runtime engine handles Open Interpreter interactions,
    chat streaming, and integration coordination.
    
    Returns:
        RuntimeEngine: The runtime engine instance
        
    Raises:
        HTTPException: If runtime engine is not initialized
    """
    if _runtime_engine is None:
        logger.error("Runtime engine not initialized")
        raise HTTPException(
            status_code=503,
            detail="Runtime engine not initialized. Server is starting up."
        )
    return _runtime_engine


# =============================================================================
# MCP Manager Dependencies
# =============================================================================

_mcp_manager: Optional[MCPServerManager] = None


def set_mcp_manager(manager: MCPServerManager) -> None:
    """Set the global MCP server manager instance."""
    global _mcp_manager
    _mcp_manager = manager


def get_mcp_manager() -> Optional[MCPServerManager]:
    """
    Get the MCP server manager instance.
    
    The MCP manager handles MCP server lifecycle and tool execution.
    Returns None if MCP is not enabled or not initialized yet.
    
    Returns:
        Optional[MCPServerManager]: The MCP manager instance or None
    """
    return _mcp_manager


def require_mcp_manager() -> MCPServerManager:
    """
    Get the MCP server manager instance (required).
    
    Use this dependency when MCP functionality is required for the endpoint.
    
    Returns:
        MCPServerManager: The MCP manager instance
        
    Raises:
        HTTPException: If MCP manager is not initialized
    """
    manager = get_mcp_manager()
    if manager is None:
        logger.error("MCP manager not initialized")
        raise HTTPException(
            status_code=503,
            detail="MCP functionality not available. MCP manager not initialized."
        )
    return manager


# =============================================================================
# Database Dependencies
# =============================================================================

_database_connection: Optional[DatabaseConnection] = None


def set_database_connection(connection: DatabaseConnection) -> None:
    """Set the global database connection instance."""
    global _database_connection
    _database_connection = connection


async def get_database() -> AsyncGenerator[DatabaseConnection, None]:
    """
    Get database connection (async generator for dependency injection).
    
    Yields:
        DatabaseConnection: Active database connection
        
    Raises:
        HTTPException: If database is not initialized
    """
    if _database_connection is None:
        logger.error("Database connection not initialized")
        raise HTTPException(
            status_code=503,
            detail="Database not available. Server is starting up."
        )
    
    try:
        yield _database_connection
    finally:
        # Connection cleanup if needed
        pass


# =============================================================================
# Request Context Dependencies
# =============================================================================

async def setup_request_context(
    request: Request,
    x_request_id: Optional[str] = Header(None),
    x_user_id: Optional[str] = Header(None),
    x_session_id: Optional[str] = Header(None)
) -> dict:
    """
    Setup request context for logging and tracing.
    
    Extracts request metadata and sets up context variables for
    structured logging and distributed tracing.
    
    Args:
        request: FastAPI request object
        x_request_id: Optional request ID from header
        x_user_id: Optional user ID from header
        x_session_id: Optional session ID from header
        
    Returns:
        dict: Request context information
    """
    # Generate request ID if not provided
    request_id = x_request_id or str(uuid.uuid4())
    
    # Set logging context
    set_request_context(
        request_id=request_id,
        user_id=x_user_id,
        session_id=x_session_id
    )
    
    # Store in request state for access in handlers
    request.state.request_id = request_id
    request.state.user_id = x_user_id
    request.state.session_id = x_session_id
    
    return {
        "request_id": request_id,
        "user_id": x_user_id,
        "session_id": x_session_id,
        "method": request.method,
        "path": request.url.path
    }


async def cleanup_request_context():
    """
    Cleanup request context after request completes.
    
    Should be called in middleware or as dependency cleanup.
    """
    clear_request_context()


# =============================================================================
# Authentication Dependencies (Future)
# =============================================================================

async def get_current_user(
    authorization: Optional[str] = Header(None),
    settings: Settings = Depends(get_settings)
) -> Optional[dict]:
    """
    Get current authenticated user.
    
    Currently placeholder for future authentication implementation.
    
    Args:
        authorization: Authorization header
        settings: Application settings
        
    Returns:
        Optional[dict]: User information if authenticated
        
    Raises:
        HTTPException: If authentication is enabled and fails
    """
    # Future: Implement JWT or API key authentication
    if settings.security and hasattr(settings.security, 'auth_enabled'):
        if settings.security.auth_enabled:
            if not authorization:
                raise HTTPException(
                    status_code=401,
                    detail="Authentication required"
                )
            # TODO: Validate token and return user
    
    return None  # Authentication disabled or not implemented yet


async def require_authenticated_user(
    user: Optional[dict] = Depends(get_current_user)
) -> dict:
    """
    Require authenticated user for endpoint.
    
    Args:
        user: Current user from get_current_user dependency
        
    Returns:
        dict: User information
        
    Raises:
        HTTPException: If user is not authenticated
    """
    if user is None:
        raise HTTPException(
            status_code=401,
            detail="Authentication required"
        )
    return user


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

