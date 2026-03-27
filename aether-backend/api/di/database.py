from typing import AsyncGenerator, Optional, Any
from fastapi import Depends, HTTPException, Request

from monitoring import get_logger
from config.settings import Settings
from core.system.connection_manager import ConnectionManager
from data.database.persistence_gateway import SupabasePersistenceGateway
from data.database.uow import SupabaseUnitOfWork, SupabaseRequestContext
from data.cache import RedisSessionContext, RedisRequestContext

from .core import _build_request_context_payload, get_settings

logger = get_logger(__name__)

# =============================================================================
# Database Dependencies (Supabase Gateway)
# =============================================================================

def set_database_connection(connection: SupabasePersistenceGateway) -> None:
    """
    Set the global database persistence gateway instance.
    
    Args:
        connection: Gateway providing resilient Supabase access
    """
    ConnectionManager.get_instance().set_database_gateway(connection)


def get_database_connection() -> Optional[SupabasePersistenceGateway]:
    """
    Get the global database connection (non-async, for use in non-request contexts).
    
    Returns:
        SupabasePersistenceGateway instance or None if not initialized
    """
    return ConnectionManager.get_instance().get_database_gateway()


async def get_database() -> AsyncGenerator[SupabasePersistenceGateway, None]:
    """
    Get persistence gateway (async generator for dependency injection).
    
    The gateway wraps the Supabase client with retry, telemetry, and
    identifier sanitisation guarantees.
    
    Yields:
        SupabasePersistenceGateway instance
        
    Raises:
        HTTPException: If database is not initialized
    """
    conn = ConnectionManager.get_instance().get_database_gateway()
    if conn is None:
        logger.error("Database client not initialized")
        raise HTTPException(
            status_code=503,
            detail="Database not available. Server is starting up."
        )
    
    try:
        yield conn
    finally:
        # Connection cleanup if needed (Supabase handles internally)
        pass


# =============================================================================
# Unit of Work Dependencies
# =============================================================================

async def get_supabase_uow(
    request: Request
) -> AsyncGenerator[SupabaseUnitOfWork, None]:
    """
    Provide a request-scoped Supabase unit of work with tracing metadata.
    """
    conn = ConnectionManager.get_instance().get_database_gateway()
    if conn is None:
        logger.error("Database client not initialized (uow)")
        raise HTTPException(
            status_code=503,
            detail="Database not available. Server is starting up."
        )

    context_payload = _build_request_context_payload(request)
    context = SupabaseRequestContext(
        request_id=context_payload["request_id"],
        correlation_id=context_payload["correlation_id"],
        session_id=context_payload["session_id"],
        user_id=context_payload["user_id"],
        actor_id=context_payload["actor_id"],
        extras=context_payload["extras"],
    )
    uow = SupabaseUnitOfWork(
        gateway=conn,
        context=context,
    )
    await uow.__aenter__()
    try:
        yield uow
    finally:
        await uow.close()


def get_redis_session(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> RedisSessionContext:
    """
    Provide a Redis session context for safely namespaced cache operations.
    """
    cache = get_cache_client()
    context_payload = _build_request_context_payload(request)
    redis_context = RedisRequestContext(
        request_id=context_payload["request_id"],
        correlation_id=context_payload["correlation_id"],
        session_id=context_payload["session_id"],
        user_id=context_payload["user_id"],
        extras=context_payload["extras"],
    )
    namespace_prefix = "runtime"
    try:
        redis_namespace = getattr(settings, "redis", None)
        if redis_namespace and getattr(redis_namespace, "namespace", None):
            namespace_prefix = f"{redis_namespace.namespace}:{namespace_prefix}"
    except Exception:
        namespace_prefix = "runtime"
    return RedisSessionContext(
        cache=cache,
        namespace=namespace_prefix,
        context=redis_context,
    )


# =============================================================================
# Cache Dependencies (Redis)
# =============================================================================

_cache_client: Optional[Any] = None


def set_cache_client(cache: Optional[Any]) -> None:
    """Register global Redis cache client."""
    global _cache_client
    _cache_client = cache


def get_cache_client() -> Optional[Any]:
    """Retrieve global Redis cache client."""
    return _cache_client
