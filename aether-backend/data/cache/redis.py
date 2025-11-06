"""
Redis Cache - Redis-based caching implementation

@.architecture
Incoming: app.py (optional startup), api/dependencies.py (optional get_cache), services requiring caching --- {Redis URL, cache set/get/delete/expire requests}
Processing: connect(), disconnect(), set(), get(), delete(), exists(), expire(), clear_namespace(), health_check(), _make_key() --- {10 jobs: connection_management, key_operations, json_serialization, ttl_management, namespace_management, batch_operations, health_checking}
Outgoing: Redis server (via redis.asyncio), calling services --- {Redis GET/SET/DEL/EXPIRE commands, JSON-serialized cached data, bool status, health status dict}

Provides Redis caching with:
- Async operations
- JSON serialization
- TTL management
- Key namespacing
- Connection pooling

This is an optional component. System works without Redis.
"""

import json
import logging
from typing import Any, Optional

try:
    import redis.asyncio as redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

logger = logging.getLogger(__name__)


class RedisCache:
    """
    Redis cache manager with async operations.
    
    Features:
    - Async get/set/delete operations
    - JSON serialization
    - TTL (time-to-live) support
    - Key namespacing
    - Connection pooling
    - Graceful degradation if Redis unavailable
    
    Usage:
        cache = RedisCache(redis_url="redis://localhost:6379")
        await cache.connect()
        
        await cache.set("key", {"data": "value"}, ttl=300)
        data = await cache.get("key")
        
        await cache.disconnect()
    """
    
    def __init__(
        self,
        redis_url: str = "redis://localhost:6379",
        namespace: str = "aether",
        encoding: str = "utf-8"
    ):
        """
        Initialize Redis cache.
        
        Args:
            redis_url: Redis connection URL
            namespace: Key namespace prefix
            encoding: String encoding
        """
        self.redis_url = redis_url
        self.namespace = namespace
        self.encoding = encoding
        
        self._client: Optional[Any] = None
        self._connected = False
        
        if not REDIS_AVAILABLE:
            logger.warning("Redis library not available. Cache will be disabled.")
    
    # =========================================================================
    # CONNECTION MANAGEMENT
    # =========================================================================
    
    async def connect(self) -> bool:
        """
        Connect to Redis server.
        
        Returns:
            True if connection successful, False otherwise
        """
        if not REDIS_AVAILABLE:
            logger.warning("Redis not available, skipping connection")
            return False
        
        if self._connected:
            logger.warning("Redis already connected")
            return True
        
        try:
            self._client = redis.from_url(
                self.redis_url,
                encoding=self.encoding,
                decode_responses=True,
            )
            
            # Test connection
            await self._client.ping()
            
            self._connected = True
            logger.info(f"✅ Connected to Redis at {self.redis_url}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            self._client = None
            return False
    
    async def disconnect(self) -> None:
        """Close Redis connection."""
        if not self._connected or not self._client:
            return
        
        try:
            await self._client.close()
            self._client = None
            self._connected = False
            logger.info("✅ Disconnected from Redis")
            
        except Exception as e:
            logger.error(f"Error disconnecting from Redis: {e}")
    
    def is_connected(self) -> bool:
        """Check if Redis is connected."""
        return self._connected and self._client is not None
    
    # =========================================================================
    # KEY OPERATIONS
    # =========================================================================
    
    def _make_key(self, key: str) -> str:
        """
        Create namespaced key.
        
        Args:
            key: Raw key
            
        Returns:
            Namespaced key (e.g., "aether:key")
        """
        return f"{self.namespace}:{key}"
    
    async def set(
        self,
        key: str,
        value: Any,
        ttl: Optional[int] = None
    ) -> bool:
        """
        Set cache value with optional TTL.
        
        Args:
            key: Cache key
            value: Value to cache (will be JSON serialized)
            ttl: Optional time-to-live in seconds
            
        Returns:
            True if successful, False otherwise
        """
        if not self.is_connected():
            return False
        
        try:
            namespaced_key = self._make_key(key)
            
            # Serialize value to JSON
            serialized = json.dumps(value)
            
            # Set with TTL if provided
            if ttl:
                await self._client.setex(namespaced_key, ttl, serialized)
            else:
                await self._client.set(namespaced_key, serialized)
            
            logger.debug(f"Cached key '{key}' (TTL: {ttl}s)")
            return True
            
        except Exception as e:
            logger.error(f"Failed to set cache key '{key}': {e}")
            return False
    
    async def get(self, key: str) -> Optional[Any]:
        """
        Get cached value.
        
        Args:
            key: Cache key
            
        Returns:
            Cached value or None if not found
        """
        if not self.is_connected():
            return None
        
        try:
            namespaced_key = self._make_key(key)
            value = await self._client.get(namespaced_key)
            
            if value is None:
                return None
            
            # Deserialize from JSON
            return json.loads(value)
            
        except Exception as e:
            logger.error(f"Failed to get cache key '{key}': {e}")
            return None
    
    async def delete(self, key: str) -> bool:
        """
        Delete cached value.
        
        Args:
            key: Cache key
            
        Returns:
            True if key was deleted, False otherwise
        """
        if not self.is_connected():
            return False
        
        try:
            namespaced_key = self._make_key(key)
            result = await self._client.delete(namespaced_key)
            return result > 0
            
        except Exception as e:
            logger.error(f"Failed to delete cache key '{key}': {e}")
            return False
    
    async def exists(self, key: str) -> bool:
        """
        Check if key exists in cache.
        
        Args:
            key: Cache key
            
        Returns:
            True if key exists, False otherwise
        """
        if not self.is_connected():
            return False
        
        try:
            namespaced_key = self._make_key(key)
            result = await self._client.exists(namespaced_key)
            return result > 0
            
        except Exception as e:
            logger.error(f"Failed to check existence of key '{key}': {e}")
            return False
    
    async def expire(self, key: str, ttl: int) -> bool:
        """
        Set TTL on existing key.
        
        Args:
            key: Cache key
            ttl: Time-to-live in seconds
            
        Returns:
            True if TTL was set, False otherwise
        """
        if not self.is_connected():
            return False
        
        try:
            namespaced_key = self._make_key(key)
            result = await self._client.expire(namespaced_key, ttl)
            return result > 0
            
        except Exception as e:
            logger.error(f"Failed to set TTL on key '{key}': {e}")
            return False
    
    # =========================================================================
    # BATCH OPERATIONS
    # =========================================================================
    
    async def clear_namespace(self) -> int:
        """
        Clear all keys in namespace.
        
        WARNING: This deletes all cached data for this application.
        
        Returns:
            Number of keys deleted
        """
        if not self.is_connected():
            return 0
        
        try:
            pattern = f"{self.namespace}:*"
            keys = []
            
            # Scan for keys (memory-efficient for large keyspaces)
            async for key in self._client.scan_iter(match=pattern):
                keys.append(key)
            
            if not keys:
                return 0
            
            # Delete keys
            deleted = await self._client.delete(*keys)
            logger.info(f"Cleared {deleted} keys from namespace '{self.namespace}'")
            return deleted
            
        except Exception as e:
            logger.error(f"Failed to clear namespace: {e}")
            return 0
    
    # =========================================================================
    # HEALTH CHECK
    # =========================================================================
    
    async def health_check(self) -> dict:
        """
        Perform health check.
        
        Returns:
            Dict with health status and info
        """
        result = {
            "healthy": False,
            "connected": self._connected,
            "redis_available": REDIS_AVAILABLE,
            "error": None,
        }
        
        if not REDIS_AVAILABLE:
            result["error"] = "Redis library not installed"
            return result
        
        if not self.is_connected():
            result["error"] = "Not connected to Redis"
            return result
        
        try:
            # Test connection
            await self._client.ping()
            result["healthy"] = True
            
            # Get server info
            info = await self._client.info()
            result["server_version"] = info.get("redis_version")
            result["used_memory_human"] = info.get("used_memory_human")
            result["connected_clients"] = info.get("connected_clients")
            
        except Exception as e:
            result["error"] = str(e)
            logger.error(f"Redis health check failed: {e}")
        
        return result

