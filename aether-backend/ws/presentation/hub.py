"""
@.architecture
Incoming: FastAPI WebSocket endpoint --- {WebSocket, str, bytes}
Processing: client lifecycle, message delegation, broadcasting --- {4 jobs: JOB_TRACK_STATE, JOB_DELEGATE, JOB_BROADCAST, JOB_LOG}
Outgoing: presentation/router, infrastructure/cache --- {Client, str, primitives}

WebSocket Hub - Client lifecycle management

Presentation layer hub for WebSocket connections.
Manages client registration, message delegation, broadcasting.

Architecture:
- Client lifecycle ONLY (register, unregister, cleanup)
- Delegates message handling to Router
- Uses CacheService for presence/metrics
- NO business logic, NO orchestration
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import WebSocket

from ws.config.constants import WS_SEND_TIMEOUT, WS_BROADCAST_TIMEOUT

logger = logging.getLogger(__name__)


@dataclass
class Client:
    """WebSocket client representation."""
    id: str
    ws: WebSocket
    active_chat_id: Optional[str] = None  # Tracks active chat for handsfree integration


class WebSocketHub:
    """
    Central hub for WebSocket client management.
    
    Features:
    - Client lifecycle (register/unregister)
    - Message delegation to Router
    - Broadcasting to all clients
    - Presence tracking via CacheService
    - Thread-safe operations
    """
    
    def __init__(
        self,
        *,
        router: Any,
        cache_service: Any,
    ):
        """
        Initialize WebSocket hub.
        
        Args:
            router: Message router (presentation layer)
            cache_service: Cache service for presence/metrics
        """
        self.router = router
        self._cache = cache_service
        self.clients: Dict[str, Client] = {}
        self._lock = asyncio.Lock()
        self._logger = logger
    
    async def register(self, ws: WebSocket) -> Client:
        """
        Register new WebSocket client.
        
        Args:
            ws: WebSocket connection
            
        Returns:
            Client instance
        """
        client = Client(id=str(uuid4()), ws=ws)
        
        async with self._lock:
            self.clients[client.id] = client
        
        self._logger.info("Client registered: %s", client.id)
        
        # Initialize presence
        await self._cache.initialize_presence(client.id)
        
        # Update metrics
        await self._cache.increment_counter("connections_total")
        await self._cache.set_active_gauge("active", len(self.clients))
        
        return client
    
    async def unregister(self, client: Client) -> None:
        """
        Unregister WebSocket client and cleanup resources.
        
        Args:
            client: Client to unregister
        """
        async with self._lock:
            self.clients.pop(client.id, None)
        
        # Cleanup client tasks via router
        await self.router.cleanup_client(client.id)
        
        self._logger.info("Client unregistered: %s", client.id)
        
        # Mark disconnected
        await self._cache.mark_presence_disconnected(client.id)
        
        # Update metrics
        await self._cache.increment_counter("disconnects_total")
        await self._cache.set_active_gauge("active", len(self.clients))
    
    async def handle_json(self, client: Client, text: str) -> None:
        """
        Handle incoming JSON message.
        
        Args:
            client: Client who sent the message
            text: Raw JSON text
        """
        await self.router.handle_json(
            ws=client.ws,
            client_id=client.id,
            text=text,
        )
    
    async def handle_binary(self, client: Client, data: bytes) -> None:
        """
        Handle incoming binary data (audio chunks).
        
        Args:
            client: Client who sent the data
            data: Binary data
        """
        await self.router.handle_binary(
            client_id=client.id,
            data=data,
        )
    
    async def send_to_client(self, client: Client, message: dict) -> bool:
        """
        Send message to specific client with error handling.
        
        Args:
            client: Target client
            message: Message dictionary
            
        Returns:
            True if sent successfully, False otherwise
        """
        try:
            await asyncio.wait_for(
                client.ws.send_text(json.dumps(message)),
                timeout=WS_SEND_TIMEOUT,
            )
            return True
        except Exception as e:
            self._logger.debug("Failed to send to client %s: %s", client.id, e)
            try:
                await self.unregister(client)
            except Exception as e2:
                self._logger.debug("Failed to unregister client %s after send failure: %s", client.id, e2)
            return False
    
    async def broadcast_json(self, payload: Dict[str, Any]) -> None:
        """
        Broadcast JSON message to all connected clients.
        
        Uses concurrent sending with timeouts to prevent slow clients from
        blocking the broadcast.
        
        Args:
            payload: Message dictionary to broadcast
        """
        as_text = json.dumps(payload)
        
        # Get current clients
        async with self._lock:
            targets = list(self.clients.values())
        
        if not targets:
            return
        
        # Concurrent send with timeout protection
        async def _send(c: Client) -> None:
            try:
                await asyncio.wait_for(
                    c.ws.send_text(as_text),
                    timeout=WS_SEND_TIMEOUT,
                )
            except Exception as e:
                self._logger.debug("Broadcast failed for %s: %s", c.id, e)
                try:
                    await self.unregister(c)
                except Exception as e2:
                    self._logger.debug("Failed to unregister client %s after broadcast failure: %s", c.id, e2)
        
        # Send to all clients concurrently
        try:
            await asyncio.wait_for(
                asyncio.gather(*[_send(c) for c in targets], return_exceptions=True),
                timeout=WS_BROADCAST_TIMEOUT,
            )
        except asyncio.TimeoutError:
            self._logger.warning("Broadcast timeout")
    
    def get_client_count(self) -> int:
        """
        Get number of connected clients.
        
        Returns:
            Number of clients
        """
        return len(self.clients)
    
    def get_client_ids(self) -> List[str]:
        """
        Get list of connected client IDs.
        
        Returns:
            List of client IDs
        """
        return list(self.clients.keys())
    
    async def cleanup_all(self) -> None:
        """
        Cleanup all clients (for shutdown).
        """
        async with self._lock:
            clients = list(self.clients.items())
            self.clients.clear()
        
        for key, client in clients:
            client_id = getattr(client, "id", None) or key
            try:
                await self.router.cleanup_client(client_id)
            except Exception as e:
                self._logger.debug("Error cleaning up client %s: %s", client_id, e)
        
        self._logger.info("All clients cleaned up")

    async def shutdown(self) -> None:
        """Shutdown hub resources."""
        try:
            await self.cleanup_all()
        except Exception as e:
            self._logger.debug("Error during client cleanup: %s", e)
        
        cache_service = getattr(self, "_cache", None)
        if cache_service and hasattr(cache_service, "shutdown"):
            try:
                await cache_service.shutdown()
            except Exception as e:
                self._logger.debug("Cache shutdown failed: %s", e)
