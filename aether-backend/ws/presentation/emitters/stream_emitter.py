"""
@.architecture
Incoming: application --- {str, Dict[str, Any], primitives}
Processing: WebSocket emission, JSON serialization, timeout handling --- {3 jobs: JOB_SERIALIZE, JOB_EXTERNAL_CALL, JOB_LOG}
Outgoing: WebSocket --- {str, json}

Stream Emitter - Stream event emission

Presentation layer emitter for stream WebSocket events.
NO business logic, pure emission with error recovery.

Events:
- stream.start (artifact type start markers)
- stream.delta (content chunks)
- stream.end (end marker)
- stream.completion (completion signal)
- stream.stopped (user cancellation)
- stream.error (error notification)
"""

import asyncio
import json
from typing import Any, Dict, Optional
from fastapi import WebSocket
import logging

from ws.protocols import WS_SEND_TIMEOUT

logger = logging.getLogger(__name__)


class StreamEmitter:
    """
    Stream event emitter.
    
    Emits stream events to WebSocket with timeout protection.
    """
    
    def __init__(self, timeout: float = WS_SEND_TIMEOUT):
        """
        Initialize stream emitter.
        
        Args:
            timeout: Send timeout in seconds (default WS_SEND_TIMEOUT)
        """
        self._timeout = timeout
        self._logger = logger
    
    async def emit_event(
        self,
        ws: WebSocket,
        event: Dict[str, Any],
    ) -> None:
        """
        Emit generic stream event.
        
        Args:
            ws: WebSocket connection
            event: Event payload (pre-enriched)
        """
        try:
            await asyncio.wait_for(
                ws.send_text(json.dumps(event)),
                timeout=self._timeout,
            )
        except asyncio.TimeoutError:
            self._logger.warning("Timeout emitting stream event")
        except Exception as e:
            self._logger.debug("Failed to emit stream event: %s", e)
    
    async def emit_end(
        self,
        ws: WebSocket,
        end_message: Dict[str, Any],
    ) -> None:
        """
        Emit end marker.
        
        Args:
            ws: WebSocket connection
            end_message: Pre-enriched end marker
        """
        try:
            await ws.send_text(json.dumps(end_message))
        except Exception as e:
            self._logger.debug("Failed to emit end marker: %s", e)
    
    async def emit_completion(
        self,
        ws: WebSocket,
        completion_message: Dict[str, Any],
    ) -> None:
        """
        Emit completion signal.
        
        Args:
            ws: WebSocket connection
            completion_message: Pre-enriched completion signal
        """
        try:
            await ws.send_text(json.dumps(completion_message))
        except Exception as e:
            self._logger.debug("Failed to emit completion: %s", e)
    
    async def emit_stop(
        self,
        ws: WebSocket,
        request_id: str,
        correlation_id: Optional[str] = None,
        chat_id: Optional[str] = None,
    ) -> None:
        """
        Emit stop notification (user cancellation).
        
        Args:
            ws: WebSocket connection
            request_id: Request identifier
            correlation_id: Optional correlation ID
            chat_id: Optional chat ID
        """
        try:
            from ws.protocols import MessageRole, MessageType
            
            stop_message = {
                "role": MessageRole.SERVER,
                "type": MessageType.STOPPED,
                "request_id": request_id,
                "message": "Generation stopped by user request",
            }
            if correlation_id:
                stop_message["correlation_id"] = correlation_id
            if chat_id:
                stop_message["chat_id"] = chat_id
            
            await ws.send_text(json.dumps(stop_message))
        except Exception as e:
            self._logger.debug("Failed to emit stop notification: %s", e)
    
    async def emit_error(
        self,
        ws: WebSocket,
        request_id: str,
        correlation_id: Optional[str] = None,
        chat_id: Optional[str] = None,
    ) -> None:
        """
        Emit error notification.
        
        Args:
            ws: WebSocket connection
            request_id: Request identifier
            correlation_id: Optional correlation ID
            chat_id: Optional chat ID
        """
        try:
            from ws.protocols import MessageRole, MessageType
            
            error_message = {
                "role": MessageRole.ASSISTANT,
                "type": MessageType.MESSAGE,
                "content": "(Model unavailable or offline)",
                "request_id": request_id,
            }
            if correlation_id:
                error_message["correlation_id"] = correlation_id
            if chat_id:
                error_message["chat_id"] = chat_id
            
            await ws.send_text(json.dumps(error_message))
        except Exception as e:
            self._logger.debug("Failed to emit error notification: %s", e)

