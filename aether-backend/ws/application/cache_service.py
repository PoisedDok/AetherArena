"""
@.architecture

Incoming: application --- {str, Dict[str, Any], int, primitives}
Processing: cache coordination, presence tracking, session state, counters --- {4 jobs: JOB_ROUTE_TO_CACHE, JOB_FALLBACK, JOB_TRANSFORM_DATA, JOB_LOG}
Outgoing: application --- {Dict[str, Any], bool, primitives}

Cache Service - Unified cache interface

Application service for cache operations with automatic fallback.
Coordinates between Redis adapter and memory fallback.

Features:
- Presence tracking (client connection state)
- Session state recording (request metadata)
- Counter operations (metrics, gauges)
- Automatic Redis→Memory fallback
- ISO timestamp utilities
"""

from datetime import datetime, timezone
from typing import Any, Dict, Optional
import logging

logger = logging.getLogger(__name__)


class CacheService:
    """
    Unified cache service with automatic fallback.
    
    Provides high-level cache operations for WebSocket layer.
    Automatically falls back to memory cache when Redis unavailable.
    """
    
    def __init__(
        self,
        *,
        cache_adapter: Optional[Any] = None,
        presence_ttl: int = 180,
        session_ttl: int = 900,
        counter_ttl: int = 3600,
    ):
        """
        Initialize cache service.
        
        Args:
            cache_adapter: Redis or Memory cache adapter
            presence_ttl: Presence record TTL in seconds (default 180)
            session_ttl: Session record TTL in seconds (default 900)
            counter_ttl: Counter TTL in seconds (default 3600)
        """
        self._cache = cache_adapter
        self._presence_ttl = presence_ttl
        self._session_ttl = session_ttl
        self._counter_ttl = counter_ttl
        self._logger = logger
        if self._cache and hasattr(self._cache, "start_cleanup"):
            try:
                self._cache.start_cleanup()
            except Exception as e:
                self._logger.debug("Failed to start cache cleanup: %s", e)
    
    def is_available(self) -> bool:
        """
        Check if cache is available.
        
        Returns:
            True if cache connected, False otherwise
        """
        return self._cache is not None and self._cache.is_connected()
    
    # Presence operations
    
    async def initialize_presence(self, client_id: str) -> None:
        """
        Initialize presence record for new client.
        
        Args:
            client_id: Client identifier
        """
        await self._set_presence_record(
            client_id,
            {
                "status": "connected",
                "connected_at": self._now_iso(),
            },
        )
    
    async def mark_presence_disconnected(self, client_id: str) -> None:
        """
        Mark client as disconnected.
        
        Args:
            client_id: Client identifier
        """
        await self._set_presence_record(
            client_id,
            {
                "status": "disconnected",
                "last_seen": self._now_iso(),
            },
        )
    
    async def update_presence_metadata(
        self,
        client_id: str,
        **fields: Any,
    ) -> None:
        """
        Update presence metadata (status, last_event, etc.).
        
        Args:
            client_id: Client identifier
            **fields: Metadata fields to update
        """
        if fields:
            await self._set_presence_record(client_id, fields)
        else:
            await self._set_presence_record(
                client_id,
                {"last_seen": self._now_iso()},
            )
    
    async def _set_presence_record(
        self,
        client_id: str,
        updates: Dict[str, Any],
    ) -> None:
        """
        Internal: Set presence record with updates.
        
        Args:
            client_id: Client identifier
            updates: Fields to update
        """
        if not self.is_available():
            return
        
        try:
            key = f"ws:presence:{client_id}"
            record = await self._cache.get(key) or {"client_id": client_id}
            
            # Preserve connected_at if already set
            record.setdefault(
                "connected_at",
                updates.get("connected_at", self._now_iso()),
            )
            
            record.update(updates)
            record["last_seen"] = updates.get("last_seen", self._now_iso())
            record["updated_at"] = self._now_iso()
            
            await self._cache.set(key, record, ttl=self._presence_ttl)
        except Exception as e:
            self._logger.debug("Failed to update presence for %s: %s", client_id, e)
    
    # Session state operations
    
    async def record_session_state(
        self,
        request_id: str,
        payload: Dict[str, Any],
    ) -> None:
        """
        Record session state for request.
        
        Args:
            request_id: Request identifier
            payload: Session metadata
        """
        if not self.is_available():
            return
        
        try:
            key = f"ws:session:{request_id}"
            record = await self._cache.get(key) or {"request_id": request_id}
            
            record.update(payload)
            record["updated_at"] = self._now_iso()
            
            await self._cache.set(key, record, ttl=self._session_ttl)
        except Exception as e:
            self._logger.debug(
                "Failed to persist session state for %s: %s", request_id, e
            )
    
    async def get_session_state(self, request_id: str) -> Optional[Dict[str, Any]]:
        """
        Get session state for request.
        
        Args:
            request_id: Request identifier
            
        Returns:
            Session metadata dict, or None if not found
        """
        if not self.is_available():
            return None
            
        try:
            key = f"ws:session:{request_id}"
            return await self._cache.get(key)
        except Exception as e:
            self._logger.debug("Failed to get session state for %s: %s", request_id, e)
            return None

    
    # Counter operations
    
    async def increment_counter(self, metric: str, amount: int = 1) -> None:
        """
        Increment counter metric.
        
        Args:
            metric: Metric name
            amount: Increment amount (default 1)
        """
        if not self.is_available():
            return
        
        try:
            key = f"ws:counters:{metric}"
            await self._cache.increment(key, amount, ttl=self._counter_ttl)
        except Exception as e:
            self._logger.debug("Failed to increment counter %s: %s", metric, e)
    
    async def set_active_gauge(self, gauge: str, value: int) -> None:
        """
        Set gauge metric value.
        
        Args:
            gauge: Gauge name (e.g., "active")
            value: Gauge value (client count)
        """
        if not self.is_available():
            return
        
        try:
            key = f"ws:gauges:{gauge}"
            payload = {
                "value": value,
                "updated_at": self._now_iso(),
            }
            await self._cache.set(key, payload, ttl=self._counter_ttl)
        except Exception as e:
            self._logger.debug("Failed to set gauge %s: %s", gauge, e)
    
    # Utilities
    
    def _now_iso(self) -> str:
        """
        Get current UTC timestamp in ISO format.
        
        Returns:
            ISO timestamp string
        """
        return datetime.now(timezone.utc).isoformat()

    async def shutdown(self) -> None:
        """Shutdown cache service resources if supported by adapter."""
        import asyncio as _asyncio
        cache = self._cache
        if cache and hasattr(cache, "stop_cleanup"):
            try:
                result = cache.stop_cleanup()
                # Await if stop_cleanup is async (MemoryFallbackCache returns coroutine)
                if _asyncio.iscoroutine(result):
                    await result
            except Exception as e:
                self._logger.debug("Failed to stop cache cleanup: %s", e)
