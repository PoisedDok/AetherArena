"""
Chat Streamer

Manages streaming chat completions with Open Interpreter and HTTP fallback paths.
Handles request tracking, cancellation, history management, and vision content support.

@.architecture
Incoming: core/runtime/engine.py, core/runtime/request.py, core/runtime/config.py --- {interpreter instance, request_id, client_id, text, image_b64}
Processing: stream_chat(), stream_via_interpreter(), stream_via_http(), track_and_cancel(), _synthesize_tts() --- {6 jobs: JOB_CLEANUP_RESOURCE, JOB_HTTP_REQUEST, JOB_MANAGE_TASK, JOB_ORCHESTRATE, JOB_TRANSFORM_DATA, JOB_EXECUTE_TOOL}
Outgoing: ws/handlers.py, api/v1/endpoints/chat.py --- {AsyncGenerator[Dict[str, Any], None]}
"""

import asyncio
import json
import logging
import base64
from typing import Any, AsyncGenerator, AsyncIterator, Dict, List, Optional


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

    def __init__(
        self,
        config_manager: Optional[Any] = None,
        request_tracker: Optional[Any] = None,
        enable_tts: bool = False,  # Default to disabled, check preference
    ):
        """
        Initialize chat streamer.
        
        Args:
            config_manager: Config manager for HTTP client access
            request_tracker: Request tracker for cancellation support
            enable_tts: Whether to enable real-time TTS synthesis (overridden by user preference)
        """
        if config_manager is None:
            try:
                from .config import ConfigManager  # Local import to avoid cycles
            except Exception:  # noqa: BLE001 -- defensive boundary for optional import fallback
                ConfigManager = None  # type: ignore
            self._config_manager = ConfigManager() if ConfigManager else None
        else:
            self._config_manager = config_manager

        if request_tracker is None:
            try:
                from .request import RequestTracker  # Local import to avoid cycles
                request_tracker = RequestTracker()
            except Exception:  # noqa: BLE001 -- defensive boundary for optional import fallback
                request_tracker = None
        self._request_tracker = request_tracker
        self._max_history_messages = 30  # Cap history length
        self._conversation_history: Dict[str, List[Dict[str, Any]]] = {}
        
        # TTS integration (handsfree mode)
        # NOTE: TTS is controlled by enable_tts parameter (default=False)
        # Frontend toggle button saves preference and enables TTS dynamically
        self._tts_enabled = enable_tts
        self._tts_integration = None
        
        if enable_tts:
            try:
                from core.integrations.libraries.tts import get_tts_integration
                from config.audio_config import get_audio_config

                self._tts_integration = get_tts_integration()
                tts_config = get_audio_config().tts

                if self._tts_integration.is_available():
                    # Use central config — no hardcoded engine/voice
                    init_kwargs = {"voice": tts_config.voice}
                    if tts_config.engine == "qwen3":
                        init_kwargs["model_path"] = tts_config.qwen3_model_path
                        init_kwargs["device"] = tts_config.qwen3_device
                        init_kwargs["instruct"] = tts_config.qwen3_instruct

                    self._tts_integration.initialize_engine(
                        tts_config.engine, **init_kwargs
                    )
                    logger.info(
                        "TTS integration enabled: engine=%s, voice=%s",
                        tts_config.engine,
                        tts_config.voice,
                    )
                else:
                    logger.warning("TTS requested but RealtimeTTS not available")
                    self._tts_enabled = False
            except Exception as e:  # noqa: BLE001 -- TTS init: non-critical, disable on any failure
                logger.warning("Failed to initialize TTS integration: %s", e)
                self._tts_enabled = False

    async def stream_response(
        self,
        chunk_generator: AsyncIterator[Dict[str, Any]],
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Legacy compatibility layer: iterate generator and process chunks.
        """
        async for chunk in chunk_generator:
            processed = await self.process_chunk(chunk)
            if processed is not None:
                yield processed

    async def process_chunk(self, chunk: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Legacy compatibility layer: pass-through processing hook.
        """
        if not isinstance(chunk, dict):
            return None
        return dict(chunk)

    async def stream_chat(
        self,
        client_id: str,
        text: str,
        image_b64: Optional[str],
        request_id: str,
        interpreter: Optional[Any] = None,
        settings: Optional[Any] = None,
        chat_id: Optional[str] = None,
        show_thinking: bool = True,
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
        if self._request_tracker is None:
            raise RuntimeError("RequestTracker is required for streaming chat")
        # Track chat_id so stop_generation can stop the correct per-chat interpreter instance.
        # If chat_id is not provided, fall back to client_id for isolation key.
        await self._request_tracker.start_request(
            request_id,
            client_id,
            text=text,
            chat_id=chat_id or client_id,
        )
        
        try:
            # Try OI streaming first if available
            history_key = chat_id or client_id
            if interpreter:
                async for chunk in self._stream_with_oi(
                    interpreter, client_id, text, image_b64, request_id, history_key, show_thinking
                ):
                    yield chunk
            else:
                # Fall back to HTTP streaming
                async for chunk in self._stream_with_http(
                    settings, client_id, text, image_b64, request_id, history_key, show_thinking
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
        history_key: Optional[str] = None,
        show_thinking: bool = True,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Stream using Open Interpreter with full agentic capabilities."""
        _ = show_thinking  # Currently unused in OI path as it does not separate reasoning
        sent_end = False
        assistant_text_buffer = []  # Buffer for TTS synthesis
        
        # Setup for TTS sentence chunking
        tts_buffer = ""
        sentence_end_chars = {'.', '!', '?', '\n'}
        
        try:
            # Inform UI which path is being used
            yield {"role": "server", "type": "path", "source": "oi", "request_id": request_id}
            
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
                "request_id": request_id,
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
                            "request_id": request_id,
                        }
                    return
                
                # Get next output from interpreter.
                # Timeout prevents indefinite blocking on WebSocket read,
                # allowing the loop to re-check cancellation every 1s.
                try:
                    out = await asyncio.wait_for(interpreter.output(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue  # Loop back to cancellation check
                
                # Stop on completion
                if (
                    isinstance(out, dict)
                    and out.get("role") == "server"
                    and out.get("type") in {"status", "completion"}
                ):
                    break
                
                if not isinstance(out, dict):
                    continue
                
                # CRITICAL FIX: If the external OI server sent a hidden __ui_content field 
                # (e.g., from the HTML passthrough handler), use it for the frontend content
                # and strip it out before yielding. This allows the frontend to render the
                # full HTML in the Output tab, while the LLM only sees the short status message.
                if "__ui_content" in out:
                    out["content"] = out.pop("__ui_content")
                    # Force the format to "html" so the frontend's OutputViewer uses the HtmlRenderer
                    out["format"] = "html"
                
                # Inject request_id (remove Open Interpreter's id if present)
                if "id" in out:
                    del out["id"]
                out["request_id"] = request_id
                
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
                    
                    # Forward content chunks + buffer for TTS
                    if out.get("content"):
                        content = out["content"]
                        assistant_text_buffer.append(content)
                        
                        yield {
                            "role": "assistant",
                            "type": "message",
                            "content": content,
                            "request_id": request_id,
                        }
                        
                        # TTS real-time chunking
                        if self._tts_enabled:
                            tts_buffer += content
                            if any(c in sentence_end_chars for c in content):
                                last_end = max(tts_buffer.rfind(c) for c in sentence_end_chars)
                                if last_end != -1:
                                    sentence = tts_buffer[:last_end + 1]
                                    tts_buffer = tts_buffer[last_end + 1:]
                                    if len(sentence.strip()) > 3:
                                        async for tts_chunk in self._synthesize_tts(sentence.strip(), request_id):
                                            yield tts_chunk
                        continue
                
                # Forward other chunks unchanged
                yield out
            
        except asyncio.CancelledError:
            logger.debug("OI stream cancelled for %s", request_id)
            yield {
                "role": "server",
                "type": "stopped",
                "request_id": request_id,
                "message": "Generation cancelled",
            }
            if not sent_end:
                yield {
                    "role": "assistant",
                    "type": "message",
                    "end": True,
                    "request_id": request_id,
                }
            return
            
        except Exception as e:  # noqa: BLE001 -- streaming boundary: must yield error, never crash generator
            import traceback; traceback.print_exc()
            logger.error("CRITICAL Error in OI streaming: %s", e)
            try:
                yield {
                    "role": "server",
                    "type": "error",
                    "origin": "oi",
                    "message": str(e),
                    "request_id": request_id,
                }
            except Exception as inner_e:  # noqa: BLE001 -- defensive boundary when sending error message
                logger.debug("Failed to send error: %s", inner_e)
            
            if not sent_end:
                yield {
                    "role": "assistant",
                    "type": "message",
                    "end": True,
                    "request_id": request_id,
                }
            return

        finally:
            # Update history ALWAYS (no yields here to avoid GeneratorExit issues)
            h_key = history_key or client_id
            if assistant_text_buffer:
                self._update_conversation_history(h_key, text, assistant_text_buffer)

        # NORMAL EXIT
        # Synthesize any remaining text
        if self._tts_enabled and tts_buffer.strip():
            async for tts_chunk in self._synthesize_tts(tts_buffer.strip(), request_id):
                yield tts_chunk
        
        # Ensure end message is sent
        if not sent_end:
            yield {
                "role": "assistant",
                "type": "message",
                "end": True,
                "request_id": request_id,
            }

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
        history_key: Optional[str] = None,
        show_thinking: bool = True,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Stream using HTTP fallback to OpenAI-compatible server."""
        llm = settings.llm
        api_base = llm.api_base.rstrip("/")
        model = llm.model
        api_key = llm.api_key or "not-needed"
        
        # Setup for TTS sentence chunking
        tts_buffer = ""
        sentence_end_chars = {'.', '!', '?', '\n'}
        
        # Route to aether-inference when it is the main provider
        llm_provider = (llm.provider or "").strip().lower()
        if llm_provider == "aether_inference":
            api_base = settings.inference_url.rstrip("/")
            api_key = "not-needed"
        
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
        
        history_id = history_key or client_id
        history = list(self._conversation_history.get(history_id, []))
        messages = []
        for entry in history:
            if not isinstance(entry, dict):
                continue
            payload_message = {
                "role": entry.get("role"),
                "content": entry.get("content"),
            }
            if entry.get("type"):
                payload_message["type"] = entry.get("type")
            messages.append(payload_message)
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
        yield {"role": "server", "type": "path", "source": "http", "request_id": request_id}
        yield {
            "role": "assistant",
            "type": "message",
            "start": True,
            "request_id": request_id,
        }
        
        url = f"{api_base}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if api_key and api_key != "not-needed":
            headers["Authorization"] = f"Bearer {api_key}"
        assistant_accum = []
        has_started_reasoning = False
        has_ended_reasoning = False
        
        try:
            async with self._config_manager.client_context() as client:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
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
                            except (json.JSONDecodeError, TypeError, ValueError) as e:
                                logger.debug("Failed to parse SSE chunk: %s", e)
                                continue
                            
                            # CRITICAL BUG FIX: Safe extraction with bounds checking
                            # Prevent IndexError when API returns empty choices array
                            choices = chunk.get("choices", [])
                            if not choices:
                                logger.debug("Received chunk with empty choices array: %r", chunk)
                                continue
                            
                            # Safely extract delta content from first choice
                            first_choice = choices[0] if isinstance(choices, list) else {}
                            delta_obj = first_choice.get("delta", {})
                            
                            if not isinstance(delta_obj, dict):
                                continue
                                
                            delta = delta_obj.get("content")
                            reasoning_delta = delta_obj.get("reasoning_content")
                            
                            content_to_yield = ""
                            
                            if reasoning_delta and show_thinking:
                                if not has_started_reasoning:
                                    content_to_yield += "<think>\n"
                                    has_started_reasoning = True
                                content_to_yield += reasoning_delta
                            
                            if delta:
                                if has_started_reasoning and not has_ended_reasoning:
                                    content_to_yield += "\n</think>\n"
                                    has_ended_reasoning = True
                                content_to_yield += delta
                            
                            if content_to_yield:
                                yield {
                                    "role": "assistant",
                                    "type": "message",
                                    "content": content_to_yield,
                                    "request_id": request_id,
                                }
                                assistant_accum.append(content_to_yield)
                                
                                # TTS real-time chunking
                                if self._tts_enabled:
                                    tts_buffer += content_to_yield
                                    if any(c in sentence_end_chars for c in content_to_yield):
                                        last_end = max(tts_buffer.rfind(c) for c in sentence_end_chars)
                                        if last_end != -1:
                                            sentence = tts_buffer[:last_end + 1]
                                            tts_buffer = tts_buffer[last_end + 1:]
                                            if len(sentence.strip()) > 3:
                                                async for tts_chunk in self._synthesize_tts(sentence.strip(), request_id):
                                                    yield tts_chunk
                                
        except Exception as e:  # noqa: BLE001 -- HTTP stream boundary: must yield error, never crash generator
            logger.warning("HTTP stream error: %s", e)
            try:
                yield {
                    "role": "server",
                    "type": "error",
                    "origin": "http",
                    "message": str(e),
                    "request_id": request_id,
                }
            except Exception as inner_e:
                logger.debug("Failed to send error: %s", inner_e)
            
            yield {
                "role": "assistant",
                "type": "message",
                "end": True,
                "request_id": request_id,
            }
            return
            
        finally:
            # Update conversation history ALWAYS (no yields here to avoid GeneratorExit issues)
            if assistant_accum:
                self._update_conversation_history(history_id, text, assistant_accum)

        # NORMAL EXIT
        if has_started_reasoning and not has_ended_reasoning:
            yield {
                "role": "assistant",
                "type": "message",
                "content": "\n</think>\n",
                "request_id": request_id,
            }
            assistant_accum.append("\n</think>\n")
            if self._tts_enabled:
                tts_buffer += "\n</think>\n"

        if not self._request_tracker.is_cancelled(request_id):
            # Synthesize any remaining text
            if self._tts_enabled and tts_buffer.strip():
                async for tts_chunk in self._synthesize_tts(tts_buffer.strip(), request_id):
                    yield tts_chunk
        
        # Send end message
        yield {
            "role": "assistant",
            "type": "message",
            "end": True,
            "request_id": request_id,
        }

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
            "request_id": request_id,
            "message": message,
        }
    
    async def _synthesize_tts(
        self, 
        text: str, 
        request_id: str
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Synthesize TTS audio from text and yield audio chunks.
        
        Args:
            text: Complete assistant response text
            request_id: Request identifier
            
        Yields:
            TTS audio chunks as WebSocket messages
        """
        if not self._tts_integration or not text.strip():
            return
        
        try:
            # Synthesize audio (blocking, run in executor)
            audio_wav = await self._tts_integration.synthesize_text_async(text)
            
            if not audio_wav:
                logger.warning("TTS synthesis failed for request %s", request_id)
                return
            
            # Encode as base64
            audio_b64 = base64.b64encode(audio_wav).decode('utf-8')
            
            # Yield single TTS audio message
            yield {
                "role": "assistant",
                "type": "tts-audio",
                "audio": audio_b64,
                "format": "wav",
                "request_id": request_id,
            }
            
            logger.info(
                "TTS synthesized %d chars → %d bytes for %s",
                len(text),
                len(audio_wav),
                request_id,
            )
            
        except Exception as e:  # noqa: BLE001 -- TTS synthesis: non-critical, don't crash streaming
            logger.error("TTS synthesis error: %s", e, exc_info=True)

    def _update_conversation_history(
        self, history_key: str, user_text: str, assistant_response: list
    ) -> None:
        """Update per-session conversation history with user and assistant responses."""
        history = self._conversation_history.setdefault(history_key, [])
        if user_text:
            history.append({
                "role": "user",
                "content": user_text,
            })
            
        assistant_content = "".join(assistant_response)
        if assistant_content:
            history.append({
                "role": "assistant",
                "content": assistant_content,
            })
        
        # Cap history length
        if len(history) > self._max_history_messages:
            system_msg = None
            if history and history[0].get("role") == "system":
                system_msg = history[0]
            
            recent = history[-(self._max_history_messages - (1 if system_msg else 0)) :]
            trimmed = ([system_msg] if system_msg else []) + recent
            self._conversation_history[history_key] = trimmed

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of chat streamer.
        
        Returns:
            Dict with health status information
        """
        active_histories = {
            client_id: len(history)
            for client_id, history in self._conversation_history.items()
        }
        return {
            "config_manager_available": self._config_manager is not None,
            "request_tracker_available": self._request_tracker is not None,
            "active_history_sessions": len(active_histories),
            "max_history_length": max(active_histories.values(), default=0),
        }

    def get_history(self, client_id: str) -> List[Dict[str, Any]]:
        """Return a copy of the conversation history for a client."""
        return list(self._conversation_history.get(client_id, []))

    def get_history_limit(self) -> int:
        """Return the maximum number of history messages retained per client."""
        return self._max_history_messages

    def clear_history(self, client_id: Optional[str] = None) -> None:
        """Clear conversation history for a client or all clients."""
        if client_id is None:
            self._conversation_history.clear()
        else:
            self._conversation_history.pop(client_id, None)

    def set_history(self, client_id: str, messages: List[Dict[str, Any]]) -> None:
        """
        Hydrate conversation history for a client.

        Args:
            client_id: Client identifier (WebSocket session)
            messages: List of dicts with minimally {"role": str, "content": str}
        """
        if not isinstance(messages, list):
            self._conversation_history.pop(client_id, None)
            return

        normalized: List[Dict[str, Any]] = []
        for entry in messages:
            if not isinstance(entry, dict):
                continue
            role = entry.get("role")
            content = entry.get("content")
            entry_type = entry.get("type") or "message"
            raw_metadata = entry.get("metadata")
            normalized_metadata = (
                dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
            )

            if role not in ("user", "assistant", "system"):
                continue

            if content is None:
                continue

            if isinstance(content, str):
                text = content.strip()
                if not text:
                    continue
                normalized.append({
                    "role": role,
                    "type": entry_type,
                    "content": text,
                    "metadata": normalized_metadata,
                })
            else:
                try:
                    text = str(content).strip()
                except (TypeError, ValueError):
                    logger.debug("Failed to convert content to string: %r", content)
                    continue
                if not text:
                    continue
                normalized.append({
                    "role": role,
                    "type": entry_type,
                    "content": text,
                    "metadata": normalized_metadata,
                })

        if not normalized:
            self._conversation_history.pop(client_id, None)
            return

        # Enforce max history while preserving leading system message if present
        max_history = self._max_history_messages
        if max_history > 0 and len(normalized) > max_history:
            system_prefix = normalized[0] if normalized[0]["role"] == "system" else None
            trimmed = normalized[-max_history:]
            if system_prefix and trimmed[0]["role"] != "system":
                trimmed = [system_prefix] + trimmed
                if len(trimmed) > max_history:
                    trimmed = trimmed[-max_history:]
            normalized = trimmed

        self._conversation_history[client_id] = normalized
        logger.debug(
            "Hydrated conversation history for client %s (%d messages)",
            client_id,
            len(normalized),
        )

