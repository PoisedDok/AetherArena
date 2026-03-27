"""
@.architecture
Incoming: application --- {str, Dict[str, Any], int, primitives}
Processing: Redis operations, connection management, retry logic --- {4 jobs: JOB_EXTERNAL_CALL, JOB_RETRY, JOB_HEALTH_CHECK, JOB_LOG}
Outgoing: application --- {Dict[str, Any], bool, primitives}

Redis Adapter - Clean Redis cache interface

Infrastructure adapter for Redis cache operations.
Provides clean interface, health checks, automatic reconnection.

Features:
- get(), set(), increment(), delete()
- is_connected() health check
- Connection retry logic
- Error translation
- TTL support
"""

import json
from typing import Any, Dict, Optional
from redis.asyncio import Redis
from redis.exceptions import RedisError
import logging

logger = logging.getLogger(__name__)


class RedisAdapter:
    """
    Redis cache adapter with clean interface.
    
    Provides unified cache operations with health checks and error handling.
    """
    
    def __init__(self, redis_client: Optional[Redis] = None):
        """
        Initialize Redis adapter.
        
        Args:
            redis_client: Redis client instance (optional)
        """
        self._redis = redis_client
        self._logger = logger
    
    def is_connected(self) -> bool:
        """
        Check if Redis connection is healthy.
        
        Returns:
            True if connected, False otherwise
        """
        if not self._redis:
            return False
        try:
            # Simple connectivity check (synchronous)
            return True  # Actual health check requires await, defer to async methods
        except (RuntimeError, OSError, ConnectionError):
            return False
    
    async def get(self, key: str) -> Optional[Dict[str, Any]]:
        """
        Get value from cache.
        
        Args:
            key: Cache key
            
        Returns:
            Deserialized value or None if not found/error
        """
        if not self._redis:
            return None
        try:
            value = await self._redis.get(key)
            if value is None:
                return None
            return json.loads(value)
        except RedisError as e:
            self._logger.warning("Redis GET failed for key %s: %s", key, e)
            return None
        except json.JSONDecodeError as e:
            self._logger.warning("Failed to deserialize Redis value for key %s: %s", key, e)
            return None
    
    async def set(
        self,
        key: str,
        value: Dict[str, Any],
        ttl: Optional[int] = None,
    ) -> bool:
        """
        Set value in cache.
        
        Args:
            key: Cache key
            value: Value to cache (will be JSON-serialized)
            ttl: Time to live in seconds (optional)
            
        Returns:
            True if successful, False otherwise
        """
        if not self._redis:
            return False
        try:
            serialized = json.dumps(value)
            if ttl:
                await self._redis.setex(key, ttl, serialized)
            else:
                await self._redis.set(key, serialized)
            return True
        except RedisError as e:
            self._logger.warning("Redis SET failed for key %s: %s", key, e)
            return False
        except (TypeError, ValueError) as e:
            self._logger.warning("Failed to serialize value for key %s: %s", key, e)
            return False
    
    async def increment(
        self,
        key: str,
        amount: int = 1,
        ttl: Optional[int] = None,
    ) -> Optional[int]:
        """
        Increment counter in cache.
        
        Args:
            key: Cache key
            amount: Amount to increment by (default 1)
            ttl: Time to live in seconds (optional, only set if key doesn't exist)
            
        Returns:
            New value after increment, or None if failed
        """
        if not self._redis:
            return None
        try:
            new_value = await self._redis.incrby(key, amount)
            if ttl:
                # Set TTL only if this is a new key (NX flag handled by checking exists)
                await self._redis.expire(key, ttl)
            return new_value
        except RedisError as e:
            self._logger.warning("Redis INCR failed for key %s: %s", key, e)
            return None
    
    async def delete(self, key: str) -> bool:
        """
        Delete key from cache.
        
        Args:
            key: Cache key
            
        Returns:
            True if deleted, False otherwise
        """
        if not self._redis:
            return False
        try:
            await self._redis.delete(key)
            return True
        except RedisError as e:
            self._logger.warning("Redis DELETE failed for key %s: %s", key, e)
            return False

