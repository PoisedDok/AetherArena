"""
WebSocket Hub - Client lifecycle and message routing

Central hub for managing WebSocket client connections and routing messages.

@.architecture
Incoming: app.py (websocket_endpoint), ws/handlers.py --- {WebSocket connection objects, JSON/binary data from clients}
Processing: register(), unregister(), handle_json(), handle_binary(), broadcast_json(), send_to_client(), cleanup_all() --- {5 jobs: broadcasting, cleanup, connection_management, error_handling, message_routing}
Outgoing: ws/handlers.py, Frontend (WebSocket) --- {Client instances, routed messages to MessageHandler, broadcast messages to all clients}

Features:
- Client registration and lifecycle management
- Message routing (JSON and binary)
- Broadcasting with timeout protection
- Connection tracking
- Error handling and auto-cleanup
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, List
from uuid import uuid4

from fastapi import WebSocket

from monitoring import get_logger
from ws.handlers import MessageHandler
from ws.protocols import WS_SEND_TIMEOUT, WS_BROADCAST_TIMEOUT

logger = get_logger(__name__)


@dataclass
class Client:
    """
    WebSocket client representation.
    
    Attributes:
        id: Unique client identifier
        ws: WebSocket connection
    """
    id: str
    ws: WebSocket


class WebSocketHub:
    """
    Central hub for WebSocket client management and message routing.
    
    Features:
    - Client lifecycle (register/unregister)
    - Message handling (JSON and binary)
    - Broadcasting to all clients
    - Timeout protection
    - Concurrent operations with locks
    - Error recovery and auto-cleanup
    
    Architecture:
    - Uses MessageHandler for message processing
    - Uses StreamRelay for chat streaming
    - Thread-safe with asyncio.Lock
    - Non-blocking message dispatch
    """
    
    def __init__(self, runtime: Any):
        """
        Initialize WebSocket hub.
        
        Args:
            runtime: RuntimeEngine instance
        """
        self.runtime = runtime
        self.clients: Dict[str, Client] = {}
        self._lock = asyncio.Lock()
        self._logger = logging.getLogger(__name__)
        
        # Message handler
        self.message_handler = MessageHandler(runtime)
    
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
        
        self._logger.info(f"Client registered: {client.id}")
        return client
    
    async def unregister(self, client: Client) -> None:
        """
        Unregister WebSocket client and cleanup resources.
        
        Args:
            client: Client to unregister
        """
        async with self._lock:
            self.clients.pop(client.id, None)
        
        # Cleanup client tasks
        await self.message_handler.cleanup_client_tasks(client.id)
        
        self._logger.info(f"Client unregistered: {client.id}")
    
    async def handle_json(self, client: Client, text: str) -> None:
        """
        Handle incoming JSON message.
        
        Args:
            client: Client who sent the message
            text: Raw JSON text
        """
        await self.message_handler.handle_json(
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
        await self.message_handler.handle_binary(
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
                timeout=WS_SEND_TIMEOUT
            )
            return True
        except Exception as e:
            self._logger.debug(f"Failed to send to client {client.id}: {e}")
            # Auto-unregister disconnected clients
            await self.unregister(client)
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
                    timeout=WS_SEND_TIMEOUT
                )
            except Exception as e:
                self._logger.debug(f"Broadcast failed for {c.id}: {e}")
                try:
                    await self.unregister(c)
                except Exception:
                    pass
        
        # Send to all clients concurrently
        try:
            await asyncio.wait_for(
                asyncio.gather(*[_send(c) for c in targets], return_exceptions=True),
                timeout=WS_BROADCAST_TIMEOUT
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
            clients = list(self.clients.values())
            self.clients.clear()
        
        for client in clients:
            try:
                await self.message_handler.cleanup_client_tasks(client.id)
            except Exception as e:
                self._logger.debug(f"Error cleaning up client {client.id}: {e}")
        
        self._logger.info("All clients cleaned up")

