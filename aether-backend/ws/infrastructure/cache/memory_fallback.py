"""
@.architecture
Incoming: application --- {str, Dict[str, Any], int, primitives}
Processing: in-memory storage, TTL expiration, cleanup --- {3 jobs: JOB_TRANSFORM_DATA, JOB_CLEANUP, JOB_LOG}
Outgoing: application --- {Dict[str, Any], bool, primitives}

Memory Fallback Cache - In-memory cache with TTL

Infrastructure adapter for in-memory caching when Redis unavailable.
Thread-safe, TTL-aware, automatic expiration cleanup.

Features:
- Same interface as redis_adapter
- TTL-based expiration
- Automatic cleanup
- Thread-safe operations
"""

import asyncio
import time
from typing import Any, Dict, Optional
from threading import Lock
import logging

logger = logging.getLogger(__name__)


class MemoryFallbackCache:
    """
    In-memory cache fallback with TTL support.
    
    Provides Redis-like interface for ephemeral caching.
    Thread-safe with automatic TTL cleanup.
    """
    
    def __init__(self, cleanup_interval: int = 60):
        """
        Initialize memory cache.
        
        Args:
            cleanup_interval: Seconds between expired entry cleanup (default 60)
        """
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._lock = Lock()
        self._logger = logger
        self._cleanup_interval = cleanup_interval
        self._cleanup_task: Optional[asyncio.Task] = None
        self._is_running = False
    
    def is_connected(self) -> bool:
        """
        Check if cache is available (always True for memory).
        
        Returns:
            True
        """
        return True
    
    async def get(self, key: str) -> Optional[Dict[str, Any]]:
        """
        Get value from cache.
        
        Args:
            key: Cache key
            
        Returns:
            Value or None if not found/expired
        """
        with self._lock:
            entry = self._cache.get(key)
            if not entry:
                return None
            
            # Check expiration
            if entry.get("expires_at") and time.time() > entry["expires_at"]:
                del self._cache[key]
                return None
            
            return entry.get("value")
    
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
            value: Value to cache
            ttl: Time to live in seconds (optional)
            
        Returns:
            True (always succeeds)
        """
        with self._lock:
            expires_at = time.time() + ttl if ttl else None
            self._cache[key] = {
                "value": value,
                "expires_at": expires_at,
            }
        return True
    
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
            ttl: Time to live in seconds (optional)
            
        Returns:
            New value after increment
        """
        with self._lock:
            entry = self._cache.get(key)
            
            # Check if exists and not expired
            if entry:
                if entry.get("expires_at") and time.time() > entry["expires_at"]:
                    # Expired, reinitialize
                    current = 0
                else:
                    current = entry.get("value", 0)
            else:
                current = 0
            
            new_value = current + amount
            expires_at = time.time() + ttl if ttl else None
            
            self._cache[key] = {
                "value": new_value,
                "expires_at": expires_at,
            }
            
            return new_value
    
    async def delete(self, key: str) -> bool:
        """
        Delete key from cache.
        
        Args:
            key: Cache key
            
        Returns:
            True if deleted, False if not found
        """
        with self._lock:
            if key in self._cache:
                del self._cache[key]
                return True
            return False
    
    async def _cleanup_expired(self) -> None:
        """Background task to remove expired entries."""
        while self._is_running:
            try:
                await asyncio.sleep(self._cleanup_interval)
                if not self._is_running:
                    break
                
                with self._lock:
                    now = time.time()
                    expired_keys = [
                        key
                        for key, entry in self._cache.items()
                        if entry.get("expires_at") and now > entry["expires_at"]
                    ]
                    
                    for key in expired_keys:
                        del self._cache[key]
                    
                    if expired_keys:
                        self._logger.debug("Cleaned up %d expired cache entries", len(expired_keys))
            
            except asyncio.CancelledError:
                break
            except (RuntimeError, KeyError, TypeError) as e:
                self._logger.warning("Error during cache cleanup: %s", e)
    
    def start_cleanup(self) -> None:
        """Start background cleanup task."""
        if not self._is_running:
            self._is_running = True
        if not self._cleanup_task or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_expired())
    
    async def stop_cleanup(self) -> None:
        """Stop background cleanup task and await its completion."""
        self._is_running = False
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        self._cleanup_task = None

