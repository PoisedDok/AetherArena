"""
@.architecture
Incoming: presentation/router --- {str, WebSocket, Message objects, primitives}
Processing: control message handling, task cancellation coordination --- {3 jobs: JOB_ROUTE, JOB_DELEGATE, JOB_LOG}
Outgoing: application/task_manager, application/cache_service --- {str, primitives}

Control Handler - Stop/heartbeat control messages

Presentation layer handler for control messages.
NO business logic, delegates to application services.

Handles:
- stop/cancel generation
- heartbeat/ping-pong
"""

import json
from typing import Any
from fastapi import WebSocket
import logging

from ws.protocols import MessageRole, MessageType

logger = logging.getLogger(__name__)


class ControlHandler:
    """
    Control message handler.
    
    Handles stop/cancel and heartbeat messages.
    Delegates task cancellation to task_manager.
    """
    
    def __init__(
        self,
        *,
        runtime: Any,
        task_manager: Any,
        request_mapper: Any,
        cache_service: Any,
    ):
        """
        Initialize control handler.
        
        Args:
            runtime: RuntimeEngine instance
            task_manager: Task lifecycle manager
            request_mapper: Request ID mapper
            cache_service: Cache service
        """
        self._runtime = runtime
        self._task_manager = task_manager
        self._request_mapper = request_mapper
        self._cache = cache_service
        self._logger = logger
    
    async def handle_stop(
        self,
        *,
        ws: WebSocket,
        client_id: str,
        message: Any,
    ) -> None:
        """
        Handle stop/cancel generation.
        
        Args:
            ws: WebSocket connection
            client_id: Client identifier
            message: Stop message object
        """
        stop_id = message.id
        if not stop_id:
            self._logger.warning("Stop message without ID")
            return
        
        # Resolve backend ID
        backend_id = await self._request_mapper.resolve_backend_id(client_id, stop_id)
        
        # Look up session state from cache to get chat_id (prevents race condition if task clears request tracker)
        session_state = await self._cache.get_session_state(backend_id)
        chat_id = session_state.get("chat_id") if session_state else None
        
        # Log correctly: client_id is the websocket client; stop_id is client-submitted identifier.
        self._logger.info(
            f"Stop signal: request={backend_id}, client={client_id}, submitted={stop_id}, chat_id={chat_id}"
        )
        
        # Update presence
        await self._cache.update_presence_metadata(
            client_id,
            status="stopping",
            last_event="stop",
        )
        
        # Notify runtime FIRST before task cancellation
        # This ensures the runtime can access the request tracker (for chat_id)
        # before the streaming task's finally block removes it.
        try:
            await self._runtime.stop_generation(backend_id, chat_id=chat_id)
        except (RuntimeError, AttributeError, ConnectionError, OSError) as e:
            self._logger.debug("Runtime stop error: %s", e)
        
        # Cancel task via task_manager
        task_info = await self._task_manager.cancel_task(backend_id)
        
        correlation_id = task_info.get("correlation_id") if task_info else None
        frontend_id = task_info.get("frontend_id") if task_info else None
        
        # Forget mapping
        await self._request_mapper.forget_mapping(
            client_id=client_id,
            frontend_id=frontend_id,
            correlation_id=correlation_id,
            backend_id=backend_id,
        )
        
        # Send acknowledgment only when no active stream task exists.
        # If a stream is active, the stream pipeline emits the stop event.
        if task_info is None:
            try:
                stop_msg = {
                    "role": MessageRole.SERVER,
                    "type": MessageType.STOPPED,
                    "request_id": backend_id,
                    "message": "Generation stopped by user request",
                }
                if frontend_id:
                    stop_msg["frontend_id"] = frontend_id
                if correlation_id:
                    stop_msg["correlation_id"] = correlation_id
                
                await ws.send_text(json.dumps(stop_msg))
            except (RuntimeError, OSError, ConnectionError) as e:
                self._logger.debug("Failed to send stop ack: %s", e)
    
    async def handle_heartbeat(
        self,
        *,
        ws: WebSocket,
        client_id: str,
        message: Any,
    ) -> None:
        """
        Handle heartbeat/ping.
        
        Args:
            ws: WebSocket connection
            client_id: Client identifier
            message: Heartbeat message object
        """
        try:
            await self._cache.update_presence_metadata(
                client_id,
                last_event="heartbeat",
            )
            
            response = {
                "type": MessageType.PONG,
                "timestamp": message.timestamp,
            }
            await ws.send_text(json.dumps(response))
        except (RuntimeError, OSError, ConnectionError) as e:
            self._logger.debug("Failed to send pong: %s", e)

