"""
WebSocket Message Handlers

Handles WebSocket message processing, stream relay, and generation control.

@.architecture
Incoming: ws/hub.py, core/runtime/streaming.py (via runtime.stream_chat) --- {JSON messages from clients, streaming chat chunks from RuntimeEngine}
Processing: handle_json(), handle_binary(), relay_stream(), _handle_user_message(), _handle_stop(), cleanup_client_tasks() --- {7 jobs: cancellation_handling, data_validation, error_handling, message_parsing, message_routing, streaming, stream_relay}
Outgoing: ws/hub.py, Frontend (WebSocket), core/runtime/engine.py --- {validated messages to runtime, streaming responses to clients, stop signals to runtime}

Features:
- Message parsing and routing
- Stream relay with cancellation
- Generation control (stop/cancel)
- Audio stream handling
- Error handling and recovery
"""

import asyncio
import json
import logging
from typing import Any, Dict, Optional
from uuid import uuid4

from fastapi import WebSocket

from monitoring import get_logger
from ws.protocols import (
    MessageType,
    MessageRole,
    validate_message,
    ClientMessage,
    StopMessage,
    HeartbeatMessage,
    AudioControlMessage,
    WS_SEND_TIMEOUT,
)

logger = get_logger(__name__)


class StreamRelay:
    """
    Handles streaming chat responses from runtime to WebSocket clients.
    
    Features:
    - Non-blocking async stream relay
    - Cancellation support
    - Error handling and recovery
    - Automatic end marker emission
    - Client disconnection detection
    """
    
    def __init__(self, runtime: Any):
        """
        Initialize stream relay.
        
        Args:
            runtime: RuntimeEngine instance for chat streaming
        """
        self.runtime = runtime
        self._logger = logging.getLogger(f"{__name__}.StreamRelay")
    
    async def relay_stream(
        self,
        ws: WebSocket,
        client_id: str,
        request_id: str,
        frontend_id: Optional[str],
        text: str,
        image_b64: Optional[str] = None,
    ) -> None:
        """
        Relay streaming chat response from runtime to WebSocket client.
        
        Args:
            ws: WebSocket connection
            client_id: Client identifier
            request_id: Backend request identifier
            frontend_id: Frontend-generated ID to echo back
            text: User message text
            image_b64: Optional base64-encoded image
        """
        sent_end = False
        
        try:
            self._logger.debug(f"Starting stream relay for request {request_id} (frontend_id={frontend_id})")
            
            # Stream chat completion from runtime
            async for event in self.runtime.stream_chat(
                client_id=client_id,
                text=text,
                image_b64=image_b64,
                request_id=request_id,
            ):
                # Check if client disconnected
                if ws.client_state.name == "DISCONNECTED":
                    self._logger.debug(f"Client disconnected during stream {request_id}")
                    break
                
                # Check if task was cancelled
                try:
                    if asyncio.current_task().cancelled():
                        self._logger.debug(f"Stream relay cancelled for {request_id}")
                        break
                except RuntimeError:
                    break
                
                # Process event
                if not isinstance(event, dict):
                    continue
                
                # Track end marker
                if event.get("end"):
                    sent_end = True
                
                # Forward start marker
                if event.get("start"):
                    try:
                        # Echo frontend_id back
                        start_event = dict(event)
                        start_event["id"] = request_id
                        if frontend_id:
                            start_event["frontend_id"] = frontend_id
                        
                        self._logger.info(f"🚀 EXIT POINT: Sending start marker - backend_id={request_id}, frontend_id={frontend_id}")
                        
                        await asyncio.wait_for(
                            ws.send_text(json.dumps(start_event)),
                            timeout=WS_SEND_TIMEOUT
                        )
                    except Exception as e:
                        self._logger.debug(f"Failed to send start marker: {e}")
                        break
                    continue
                
                # Forward content deltas (assistant messages only)
                if (
                    event.get("role") == MessageRole.ASSISTANT
                    and event.get("type") == MessageType.MESSAGE
                    and event.get("content")
                    and not event.get("end")  # Don't forward content on end marker
                ):
                    try:
                        delta = {
                            "role": MessageRole.ASSISTANT,
                            "type": MessageType.MESSAGE,
                            "content": event["content"],
                            "id": request_id,
                        }
                        # Echo frontend_id back in every chunk
                        if frontend_id:
                            delta["frontend_id"] = frontend_id
                        
                        await asyncio.wait_for(
                            ws.send_text(json.dumps(delta)),
                            timeout=WS_SEND_TIMEOUT
                        )
                    except Exception as e:
                        self._logger.debug(f"Failed to send content delta: {e}")
                        break
                    continue
                
                # Forward other events as-is (code, console, system, etc.)
                # Add frontend_id to artifacts too
                try:
                    event_copy = dict(event)
                    if frontend_id and event_copy.get("role") in ("assistant", "computer"):
                        event_copy["frontend_id"] = frontend_id
                    
                    await asyncio.wait_for(
                        ws.send_text(json.dumps(event_copy)),
                        timeout=WS_SEND_TIMEOUT
                    )
                except Exception as e:
                    self._logger.debug(f"Failed to send event: {e}")
                    break
        
        except asyncio.CancelledError:
            self._logger.info(f"Stream relay cancelled for {request_id}")
            # Send cancellation notification
            try:
                stop_message = {
                    "role": MessageRole.SERVER,
                    "type": MessageType.STOPPED,
                    "id": request_id,
                    "message": "Generation stopped by user request",
                }
                await ws.send_text(json.dumps(stop_message))
            except Exception:
                pass
            raise
        
        except Exception as e:
            self._logger.warning(f"Error in stream relay for {request_id}: {e}")
            # Send error notification
            try:
                error_message = {
                    "role": MessageRole.ASSISTANT,
                    "type": MessageType.MESSAGE,
                    "content": "(Model unavailable or offline)",
                    "id": request_id,
                }
                await ws.send_text(json.dumps(error_message))
            except Exception:
                pass
        
        finally:
            # Send end marker if not already sent
            if not sent_end:
                try:
                    end_message = {
                        "role": MessageRole.ASSISTANT,
                        "type": MessageType.MESSAGE,
                        "end": True,
                        "id": request_id,
                    }
                    if frontend_id:
                        end_message["frontend_id"] = frontend_id
                    
                    self._logger.info(f"🚀 EXIT POINT: Sending end marker - backend_id={request_id}, frontend_id={frontend_id}")
                    
                    await ws.send_text(json.dumps(end_message))
                except Exception:
                    pass
            
            # Send completion signal
            try:
                completion_message = {
                    "role": MessageRole.SERVER,
                    "type": MessageType.COMPLETION,
                    "id": request_id,
                }
                if frontend_id:
                    completion_message["frontend_id"] = frontend_id
                
                await ws.send_text(json.dumps(completion_message))
            except Exception:
                pass
            
            self._logger.info(f"Stream relay complete for {request_id} (frontend_id={frontend_id})")


class MessageHandler:
    """
    Handles incoming WebSocket messages and routes to appropriate handlers.
    
    Features:
    - Message parsing and validation
    - User message processing
    - Stop/cancel handling
    - Heartbeat/ping-pong
    - Audio stream control
    - Error handling
    """
    
    def __init__(self, runtime: Any):
        """
        Initialize message handler.
        
        Args:
            runtime: RuntimeEngine instance
        """
        self.runtime = runtime
        self.stream_relay = StreamRelay(runtime)
        self._logger = logging.getLogger(f"{__name__}.MessageHandler")
        
        # Track active stream tasks for cancellation
        self._stream_tasks: Dict[str, asyncio.Task] = {}
        self._tasks_lock = asyncio.Lock()
    
    async def handle_json(
        self,
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
        # Parse JSON
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as e:
            self._logger.warning(f"Invalid JSON from client {client_id}: {e}")
            return
        
        # Log raw payload for debugging
        role = payload.get("role", "unknown")
        msg_type = payload.get("type", "unknown")
        msg_id_raw = payload.get("id", "")
        msg_id = str(msg_id_raw)[:8] if msg_id_raw else ""
        self._logger.info(f"Received message: {role}/{msg_type} {msg_id}")
        
        # Validate message
        message = validate_message(payload)
        
        if message is None:
            self._logger.warning(f"Message validation failed for {role}/{msg_type}: {payload}")
            return
        
        # Handle heartbeat
        if isinstance(message, HeartbeatMessage):
            await self._handle_heartbeat(ws, message)
            return
        
        # Handle audio control
        if isinstance(message, AudioControlMessage):
            await self._handle_audio_control(client_id, message)
            return
        
        # Handle stop/cancel
        if isinstance(message, StopMessage):
            await self._handle_stop(ws, client_id, message)
            return
        
        # Handle user message
        if isinstance(message, ClientMessage):
            await self._handle_user_message(ws, client_id, message)
            return
        
        # Handle raw LMC pass-through (advanced clients)
        if isinstance(payload, dict) and any(k in payload for k in ("start", "end", "auth")):
            await self._handle_lmc_passthrough(payload)
            return
        
        # Unknown message - send diagnostic
        try:
            await ws.send_text(json.dumps({
                "role": MessageRole.SERVER,
                "type": MessageType.INFO,
                "data": payload,
            }))
        except Exception:
            pass
    
    async def handle_binary(
        self,
        client_id: str,
        data: bytes,
    ) -> None:
        """
        Handle incoming binary data (audio chunks).
        
        Args:
            client_id: Client identifier
            data: Binary data
        """
        try:
            await self.runtime.handle_audio_chunk(
                client_id=client_id,
                chunk=data,
            )
        except Exception as e:
            self._logger.warning(f"Error handling audio chunk: {e}")
    
    async def cleanup_client_tasks(self, client_id: str) -> None:
        """
        Cleanup all tasks for a disconnected client.
        
        Args:
            client_id: Client identifier
        """
        async with self._tasks_lock:
            # Cancel all tasks for this client
            tasks_to_cancel = [
                (request_id, task)
                for request_id, task in self._stream_tasks.items()
            ]
            
            for request_id, task in tasks_to_cancel:
                try:
                    task.cancel()
                    self._stream_tasks.pop(request_id, None)
                except Exception:
                    pass
    
    # Private handlers
    
    async def _handle_heartbeat(
        self,
        ws: WebSocket,
        message: HeartbeatMessage,
    ) -> None:
        """Handle heartbeat/ping message"""
        try:
            response = {
                "type": MessageType.PONG,
                "timestamp": message.timestamp,
            }
            await ws.send_text(json.dumps(response))
        except Exception as e:
            self._logger.debug(f"Failed to send pong: {e}")
    
    async def _handle_audio_control(
        self,
        client_id: str,
        message: AudioControlMessage,
    ) -> None:
        """Handle audio stream control"""
        try:
            if message.start:
                await self.runtime.start_audio_stream(client_id=client_id)
            elif message.end:
                await self.runtime.end_audio_stream(client_id=client_id)
        except Exception as e:
            self._logger.warning(f"Error handling audio control: {e}")
    
    async def _handle_stop(
        self,
        ws: WebSocket,
        client_id: str,
        message: StopMessage,
    ) -> None:
        """Handle stop/cancel generation"""
        request_id = message.id
        if not request_id:
            self._logger.warning("Stop message without request ID")
            return
        
        self._logger.info(f"Received stop signal for request {request_id}")
        
        # Cancel the stream task
        async with self._tasks_lock:
            if request_id in self._stream_tasks:
                try:
                    task = self._stream_tasks[request_id]
                    task.cancel()
                    del self._stream_tasks[request_id]
                    self._logger.debug(f"Cancelled stream task for {request_id}")
                except Exception as e:
                    self._logger.debug(f"Failed to cancel task: {e}")
        
        # Notify runtime to stop generation
        try:
            await self.runtime.stop_generation(request_id)
        except Exception as e:
            self._logger.debug(f"Error stopping generation: {e}")
        
        # Send acknowledgment
        try:
            stop_message = {
                "role": MessageRole.SERVER,
                "type": MessageType.STOPPED,
                "id": request_id,
                "message": "Generation stopped by user request",
            }
            await ws.send_text(json.dumps(stop_message))
        except Exception:
            pass
    
    async def _handle_user_message(
        self,
        ws: WebSocket,
        client_id: str,
        message: ClientMessage,
    ) -> None:
        """Handle user message and start stream relay"""
        # Preserve frontend_id if provided, otherwise generate backend ID
        frontend_id = message.id
        request_id = message.id or str(uuid4())
        
        self._logger.info(f"📥 ENTRY POINT: User message received - frontend_id={frontend_id}, backend_id={request_id}")
        self._logger.debug(f"Creating stream task for request {request_id}")
        
        # Create stream relay task with frontend_id preservation
        stream_task = asyncio.create_task(
            self.stream_relay.relay_stream(
                ws=ws,
                client_id=client_id,
                request_id=request_id,
                frontend_id=frontend_id,  # Pass frontend ID for echoing
                text=message.content,
                image_b64=message.image,
            )
        )
        
        # Track task for cancellation
        async with self._tasks_lock:
            # Cancel existing task with same ID
            if request_id in self._stream_tasks:
                try:
                    self._stream_tasks[request_id].cancel()
                except Exception:
                    pass
            
            self._stream_tasks[request_id] = stream_task
    
    async def _handle_lmc_passthrough(
        self,
        payload: Dict[str, Any],
    ) -> None:
        """Handle raw LMC message pass-through for advanced clients"""
        try:
            if hasattr(self.runtime, '_interpreter') and self.runtime._interpreter:
                await self.runtime._interpreter.input(payload)
        except Exception:
            pass

