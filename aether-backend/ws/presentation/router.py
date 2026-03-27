"""
@.architecture
Incoming: presentation/hub --- {str, WebSocket, bytes, json}
Processing: message parsing, type-based routing, handler delegation --- {4 jobs: JOB_PARSE, JOB_VALIDATE, JOB_ROUTE, JOB_LOG}
Outgoing: presentation/handlers --- {Message objects, WebSocket, primitives}

Router - Message routing and dispatch

Presentation layer router for WebSocket messages.
Parses, validates, and routes messages to appropriate handlers.

Architecture:
- NO orchestration logic
- NO task management (delegates to task_manager)
- NO cache operations (delegates to cache_service)
- Pure routing and delegation
"""

import asyncio
import json
from typing import Any
from fastapi import WebSocket
import logging

from ws.config.constants import MAX_MESSAGE_SIZE
from ws.protocols import (
    validate_message,
    HeartbeatMessage,
    AudioControlMessage,
    AudioMessage,
    StopMessage,
    ContextResetMessage,
    ClientMessage,
    MessageRole,
    MessageType,
)
from services.daemons import CHAT_ACTIVITY_SIGNAL_FILE

logger = logging.getLogger(__name__)


class Router:
    """
    WebSocket message router.
    
    Routes messages to appropriate handlers based on type.
    """
    
    def __init__(
        self,
        *,
        runtime: Any,
        message_handler: Any,
        control_handler: Any,
        audio_handler: Any,
        context_handler: Any,
        task_manager: Any,
        request_mapper: Any,
        cache_service: Any,
        hub: Any = None,  # WebSocketHub reference for client state access
    ):
        """
        Initialize router.
        
        Args:
            runtime: RuntimeEngine instance
            message_handler: User message handler
            control_handler: Control message handler
            audio_handler: Audio control handler
            context_handler: Context management handler
            task_manager: Task lifecycle manager
            request_mapper: Request ID mapper
            cache_service: Cache service
            hub: Optional WebSocketHub reference for client state access
        """
        self._runtime = runtime
        self._message_handler = message_handler
        self._control_handler = control_handler
        self._audio_handler = audio_handler
        self._context_handler = context_handler
        self._task_manager = task_manager
        self._request_mapper = request_mapper
        self._cache = cache_service
        self._hub = hub
        self._logger = logger
    
    async def handle_json(
        self,
        *,
        ws: WebSocket,
        client_id: str,
        text: str,
    ) -> None:
        """
        Handle incoming JSON message.
        
        Args:
            ws: WebSocket connection
            client_id: Client identifier
            text: Raw JSON text
        """
        # Size guard: reject payloads exceeding configured limit (prevents OOM)
        if len(text) > MAX_MESSAGE_SIZE:
            self._logger.warning(
                "Message too large from %s: %d bytes (limit %d)",
                client_id, len(text), MAX_MESSAGE_SIZE,
            )
            return

        # Parse JSON
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as e:
            self._logger.warning("Invalid JSON from client %s: %s", client_id, e)
            return
        
        # Log (suppress audio spam - logs every 43ms for ScriptProcessorNode)
        role = payload.get("role", "unknown")
        msg_type = payload.get("type", "unknown")
        msg_id = str(payload.get("id", ""))[:8] if payload.get("id") else ""
        
        # CRITICAL FIX: Handle cancel-tts command BEFORE validation
        # Frontend sends: { "type": "audio/cancel-tts" } (no role field)
        if msg_type == "audio/cancel-tts":
            self._logger.info("Message: cancel-tts command from %s", client_id[:8])
            await self._audio_handler.handle_cancel_tts(client_id=client_id)
            return
        
        # Only log non-audio messages (audio floods logs at ~23 msg/sec)
        if msg_type != "audio":
            self._logger.info("Message: %s/%s %s", role, msg_type, msg_id)
        
        # Validate
        message = validate_message(payload)
        if message is None:
            self._logger.warning("Validation failed: %s/%s", role, msg_type)
            return
        
        # Update presence
        await self._cache.update_presence_metadata(client_id, last_event=msg_type)
        
        # Track user chat activity to pause proactive pipeline
        # Throttle touches to max once every 5 seconds to prevent I/O thrashing from 23Hz AudioMessages
        if isinstance(message, (ClientMessage, AudioControlMessage, AudioMessage, StopMessage)):
            import time
            now = time.time()
            if getattr(self, '_last_activity_touch', 0) < now - 5.0:
                self._last_activity_touch = now
                try:
                    # Ensure directory exists just in case (e.g. tests)
                    if not CHAT_ACTIVITY_SIGNAL_FILE.parent.exists():
                        CHAT_ACTIVITY_SIGNAL_FILE.parent.mkdir(parents=True, exist_ok=True)
                    CHAT_ACTIVITY_SIGNAL_FILE.touch(exist_ok=True)
                except OSError as e:
                    self._logger.warning("Failed to touch chat activity signal file: %s", e)
        
        # Route to handler
        if isinstance(message, HeartbeatMessage):
            await self._control_handler.handle_heartbeat(
                ws=ws,
                client_id=client_id,
                message=message,
            )
            return
        
        if isinstance(message, AudioControlMessage):
            await self._audio_handler.handle_audio_control(
                client_id=client_id,
                message=message,
            )
            return
        
        if isinstance(message, AudioMessage):
            await self._audio_handler.handle_audio_chunk(
                client_id=client_id,
                message=message,
            )
            return
        
        if isinstance(message, StopMessage):
            await self._control_handler.handle_stop(
                ws=ws,
                client_id=client_id,
                message=message,
            )
            return
        
        if isinstance(message, ContextResetMessage):
            await self._context_handler.handle_context_reset(
                ws=ws,
                client_id=client_id,
                message=message,
                hub=self._hub,  # Pass hub for client state update
            )
            return
        
        if isinstance(message, ClientMessage):
            await self._message_handler.handle_user_message(
                ws=ws,
                client_id=client_id,
                message=message,
            )
            return
        
        # Unknown message type
        self._logger.warning("Unknown message type: %s", type(message))
        try:
            await ws.send_text(json.dumps({
                "role": MessageRole.SERVER,
                "type": MessageType.INFO,
                "data": payload,
            }))
        except (ConnectionError, OSError, RuntimeError):
            pass  # Client already disconnected
    
    async def handle_binary(
        self,
        *,
        client_id: str,
        data: bytes,
    ) -> None:
        """
        Handle incoming binary data (audio chunks).
        
        Args:
            client_id: Client identifier
            data: Binary data
        """
        # Track user chat activity to pause proactive pipeline
        # Throttle touches to max once every 5 seconds
        import time
        now = time.time()
        if getattr(self, '_last_activity_touch', 0) < now - 5.0:
            self._last_activity_touch = now
            try:
                if not CHAT_ACTIVITY_SIGNAL_FILE.parent.exists():
                    CHAT_ACTIVITY_SIGNAL_FILE.parent.mkdir(parents=True, exist_ok=True)
                CHAT_ACTIVITY_SIGNAL_FILE.touch(exist_ok=True)
            except OSError as e:
                self._logger.warning("Failed to touch chat activity signal file: %s", e)

        # NOTE: No size guard on binary -- users legitimately send large files/images
        # for processing (artifacts, audio). Size is bounded by the WS server config.
        try:
            await self._runtime.handle_audio_chunk(
                client_id=client_id,
                chunk=data,
            )
        except Exception as e:
            self._logger.warning("Audio chunk error: %s", e)
    
    async def cleanup_client(self, client_id: str) -> int:
        """
        Cleanup client on disconnect.
        
        Args:
            client_id: Client identifier
            
        Returns:
            Number of tasks cancelled
        """
        # Cancel all client tasks — each step independently guarded so that
        # failure of one does not prevent subsequent cleanup steps.
        cancelled_ids = []
        try:
            cancelled_ids = await self._task_manager.cleanup_client_tasks(client_id)
        except Exception as e:
            self._logger.warning("Task manager cleanup failed for %s: %s", client_id, e)
        
        # Stop LLM generation for any in-flight requests tied to client.
        for request_id in cancelled_ids:
            try:
                await self._runtime.stop_generation(request_id)
                self._logger.debug("Stopped generation for %s after disconnect", request_id[:8])
            except Exception as e:
                self._logger.warning("Failed to stop generation %s: %s", request_id[:8], e)
        
        # Cleanup audio processing state (wake word, buffers, conversation)
        try:
            if self._audio_handler and hasattr(self._audio_handler, '_audio_processor'):
                audio_processor = self._audio_handler._audio_processor
                if audio_processor and hasattr(audio_processor, 'cleanup_client'):
                    await audio_processor.cleanup_client(client_id)
                    self._logger.debug("Audio processor cleaned up for %s", client_id[:8])
        except Exception as e:
            self._logger.warning("Audio cleanup failed for %s: %s", client_id, e)
        
        # Cleanup request mappings
        try:
            if self._request_mapper:
                await self._request_mapper.cleanup_client_mappings(client_id)
        except Exception as e:
            self._logger.warning("Request mapper cleanup failed for %s: %s", client_id, e)
        
        # Cleanup message handler state (locks, active task refs)
        try:
            if self._message_handler and hasattr(self._message_handler, "cleanup_client"):
                await self._message_handler.cleanup_client(client_id)
        except Exception as e:
            self._logger.warning("Message handler cleanup failed for %s: %s", client_id, e)
        
        # Cleanup per-client LLM request serialization lock (module-level dict in factory.py)
        # Prevents memory leak for long-running servers with many transient clients.
        try:
            from ws.factory import client_llm_locks
            client_llm_locks.pop(client_id, None)
        except (ImportError, AttributeError, KeyError):
            pass  # Lock dict not available or already cleaned
        
        cancelled = len(cancelled_ids)
        if cancelled > 0:
            self._logger.info("Cleaned up %d tasks for client %s", cancelled, client_id)
        
        return cancelled

    async def shutdown(self) -> None:
        """Shutdown router resources."""
        try:
            if self._message_handler and hasattr(self._message_handler, "shutdown"):
                await self._message_handler.shutdown()
        except Exception as e:
            self._logger.warning("Message handler shutdown failed: %s", e)
