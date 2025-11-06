"""
Chat Streamer - LLM streaming chat with OI and HTTP fallback
Consolidated from chat_streamer.py

@.architecture
Incoming: core/runtime/engine.py (stream_chat), core/runtime/request.py, core/runtime/config.py --- {client_id, text, image_b64, request_id, interpreter instance, settings}
Processing: stream_chat(), _stream_with_oi(), _stream_with_http(), _update_conversation_history() --- {6 jobs: cancellation_detection, error_handling, history_management, http_communication, request_tracking, stream_generation}
Outgoing: core/runtime/engine.py, ws/handlers.py, api/v1/endpoints/chat.py --- {AsyncGenerator[Dict] with streaming chunks: start markers, content deltas, end markers, error messages}

Handles:
- Streaming chat completion using Open Interpreter (primary)
- HTTP fallback to OpenAI-compatible servers
- Request tracking and cancellation support
- Vision content support with base64 images
- Conversation history management
- Error handling and recovery
- Graceful fallback between OI and HTTP

Production Features:
- Complete async streaming support
- Proper cancellation detection
- Error boundaries for each stream
- Conversation history with size limits
- Vision support detection
- Request ID injection for tracking
"""

import asyncio
import json
import logging
from typing import Any, AsyncGenerator, Dict, Optional

logger = logging.getLogger(__name__)


class ChatStreamer:
    """
    Handles streaming chat completion with OI and HTTP fallback.
    
    Features:
    - Open Interpreter streaming (primary path)
    - HTTP fallback for OpenAI-compatible servers
    - Request tracking and cancellation
    - Vision content support with base64 images
    - Conversation history management with size limits
    - Error handling and graceful recovery
    - Proper start/end message coordination
    
    Streaming Paths:
    1. OI Path: Uses interpreter.input/output for full agentic capabilities
    2. HTTP Path: Direct API calls for simple completion
    """

    def __init__(self, config_manager, request_tracker):
        """
        Initialize chat streamer.
        
        Args:
            config_manager: Config manager for HTTP client access
            request_tracker: Request tracker for cancellation support
        """
        self._config_manager = config_manager
        self._request_tracker = request_tracker
        self._max_history_messages = 30  # Cap history length
        self._conversation_history = []

    async def stream_chat(
        self,
        client_id: str,
        text: str,
        image_b64: Optional[str],
        request_id: str,
        interpreter: Optional[Any] = None,
        settings: Optional[Any] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Stream chat completion using OI or HTTP fallback.
        
        Args:
            client_id: Client identifier
            text: User message text
            image_b64: Optional base64 image data
            request_id: Unique request identifier
            interpreter: Optional OI interpreter instance
            settings: Runtime settings
            
        Yields:
            Streaming response chunks
        """
        # Start tracking this request
        await self._request_tracker.start_request(request_id, client_id, text)
        
        try:
            # Try OI streaming first if available
            if interpreter:
                async for chunk in self._stream_with_oi(
                    interpreter, client_id, text, image_b64, request_id
                ):
                    yield chunk
            else:
                # Fall back to HTTP streaming
                async for chunk in self._stream_with_http(
                    settings, client_id, text, image_b64, request_id
                ):
                    yield chunk
                    
        finally:
            # Clean up request tracking
            await self._request_tracker.end_request(request_id)

    # ============================================================================
    # OPEN INTERPRETER STREAMING
    # ============================================================================

    async def _stream_with_oi(
        self,
        interpreter: Any,
        client_id: str,
        text: str,
        image_b64: Optional[str],
        request_id: str,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Stream using Open Interpreter with full agentic capabilities."""
        sent_end = False
        
        try:
            # Inform UI which path is being used
            yield {"role": "server", "type": "path", "source": "oi", "id": request_id}
            
            # Send user input to interpreter
            await interpreter.input({"role": "user", "start": True})
            
            if text:
                await interpreter.input({
                    "role": "user",
                    "type": "message",
                    "content": text,
                })
            
            if image_b64:
                await interpreter.input({
                    "role": "user",
                    "type": "image",
                    "format": "base64.png",
                    "content": image_b64,
                })
            
            await interpreter.input({"role": "user", "end": True})
            
            # Emit start signal
            yield {
                "role": "assistant",
                "type": "message",
                "start": True,
                "id": request_id,
            }
            
            # Stream responses
            while True:
                # Check for cancellation
                if self._request_tracker.is_cancelled(request_id):
                    yield self._create_stop_message(request_id)
                    if not sent_end:
                        yield {
                            "role": "assistant",
                            "type": "message",
                            "end": True,
                            "id": request_id,
                        }
                    return
                
                # Get next output from interpreter
                out = await interpreter.output()
                
                # Stop on completion
                if (
                    isinstance(out, dict)
                    and out.get("role") == "server"
                    and out.get("type") in {"status", "completion"}
                ):
                    break
                
                if not isinstance(out, dict):
                    continue
                
                # Inject request ID
                out["id"] = request_id
                
                # Handle assistant message content
                if out.get("role") == "assistant" and out.get("type") == "message":
                    # Skip OI's start markers (we send our own)
                    if out.get("start"):
                        continue
                    
                    is_end = out.get("end")
                    
                    # Skip OI's end markers (we send our own)
                    if is_end:
                        sent_end = True
                        continue
                    
                    # Forward content chunks
                    if out.get("content"):
                        yield {
                            "role": "assistant",
                            "type": "message",
                            "content": out["content"],
                            "id": request_id,
                        }
                        continue
                
                # Forward other chunks unchanged
                yield out
            
            # Ensure end message is sent
            if not sent_end:
                yield {
                    "role": "assistant",
                    "type": "message",
                    "end": True,
                    "id": request_id,
                }
                
        except asyncio.CancelledError:
            logger.debug(f"OI stream cancelled for {request_id}")
            yield {
                "role": "server",
                "type": "stopped",
                "id": request_id,
                "message": "Generation cancelled",
            }
            if not sent_end:
                yield {
                    "role": "assistant",
                    "type": "message",
                    "end": True,
                    "id": request_id,
                }
            return
            
        except Exception as e:
            logger.warning(f"Error in OI streaming: {e}")
            try:
                yield {
                    "role": "server",
                    "type": "error",
                    "origin": "oi",
                    "message": str(e),
                    "id": request_id,
                }
                if not sent_end:
                    yield {
                        "role": "assistant",
                        "type": "message",
                        "end": True,
                        "id": request_id,
                    }
            except Exception as inner_e:
                logger.debug(f"Failed to send error: {inner_e}")

    # ============================================================================
    # HTTP FALLBACK STREAMING
    # ============================================================================

    async def _stream_with_http(
        self,
        settings: Any,
        client_id: str,
        text: str,
        image_b64: Optional[str],
        request_id: str,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Stream using HTTP fallback to OpenAI-compatible server."""
        llm = settings.llm
        api_base = llm.api_base.rstrip("/")
        model = llm.model
        
        # Remove openai/ prefix for direct API calls
        if model.startswith("openai/"):
            model = model[7:]
        
        # Build content blocks
        content_blocks = []
        if text:
            content_blocks.append({"type": "text", "text": text})
        
        if image_b64 and llm.supports_vision:
            content_blocks.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{image_b64}"},
            })
        
        # Get conversation history
        messages = list(self._conversation_history)
        user_message = {"role": "user", "content": content_blocks or text}
        messages.append(user_message)
        
        # Build payload
        payload = {
            "model": model,
            "stream": True,
            "messages": messages,
            "max_tokens": llm.max_tokens,
        }
        
        # Notify UI of HTTP path
        yield {"role": "server", "type": "path", "source": "http", "id": request_id}
        yield {
            "role": "assistant",
            "type": "message",
            "start": True,
            "id": request_id,
        }
        
        url = f"{api_base}/chat/completions"
        assistant_accum = []
        
        try:
            async with self._config_manager.client_context() as client:
                async with client.stream("POST", url, json=payload) as resp:
                    resp.raise_for_status()
                    
                    async for line in resp.aiter_lines():
                        # Check for cancellation
                        if self._request_tracker.is_cancelled(request_id):
                            yield self._create_stop_message(
                                request_id,
                                "Generation stopped by user (HTTP fallback)",
                            )
                            break
                        
                        if not line:
                            continue
                        
                        if line.startswith("data:"):
                            data = line[len("data:") :].strip()
                            if data == "[DONE]":
                                break
                            
                            try:
                                chunk = json.loads(data)
                            except Exception:
                                continue
                            
                            delta = (
                                chunk.get("choices", [{}])[0]
                                .get("delta", {})
                                .get("content")
                            )
                            if delta:
                                yield {
                                    "role": "assistant",
                                    "type": "message",
                                    "content": delta,
                                    "id": request_id,
                                }
                                assistant_accum.append(delta)
                                
        except Exception as e:
            logger.warning(f"HTTP stream error: {e}")
            yield {
                "role": "server",
                "type": "error",
                "origin": "http",
                "message": str(e),
                "id": request_id,
            }
            return
        
        # Send end message
        yield {
            "role": "assistant",
            "type": "message",
            "end": True,
            "id": request_id,
        }
        
        # Update conversation history
        if assistant_accum:
            self._update_conversation_history(messages, assistant_accum)

    # ============================================================================
    # HELPER METHODS
    # ============================================================================

    def _create_stop_message(
        self, request_id: str, message: str = "Generation stopped by backend"
    ) -> Dict[str, Any]:
        """Create a stop message for UI."""
        return {
            "role": "server",
            "type": "stopped",
            "id": request_id,
            "message": message,
        }

    def _update_conversation_history(
        self, messages: list, assistant_response: list
    ) -> None:
        """Update conversation history with assistant response."""
        assistant_content = "".join(assistant_response)
        self._conversation_history.append({
            "role": "assistant",
            "content": assistant_content,
        })
        
        # Cap history length
        if len(self._conversation_history) > self._max_history_messages:
            system_msg = None
            if (
                self._conversation_history
                and self._conversation_history[0].get("role") == "system"
            ):
                system_msg = self._conversation_history[0]
            
            recent = self._conversation_history[
                -(self._max_history_messages - (1 if system_msg else 0)) :
            ]
            self._conversation_history = ([system_msg] if system_msg else []) + recent

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of chat streamer.
        
        Returns:
            Dict with health status information
        """
        return {
            "config_manager_available": self._config_manager is not None,
            "request_tracker_available": self._request_tracker is not None,
            "conversation_history_length": len(self._conversation_history),
        }

