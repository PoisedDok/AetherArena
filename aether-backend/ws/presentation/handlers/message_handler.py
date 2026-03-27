"""
Incoming: presentation/router --- {str, WebSocket, Message objects, primitives}
Processing: message validation, orchestrator delegation --- {3 jobs: JOB_VALIDATE, JOB_DELEGATE, JOB_LOG}
Outgoing: application/stream_orchestrator, application/task_manager --- {str, WebSocket, primitives}

Message Handler - User message handling

Presentation layer handler for user messages.
Validates, registers tasks, delegates to stream_orchestrator.

Handles:
- user text/image messages
- task registration
- request ID mapping
"""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from fastapi import WebSocket
import logging

from config.settings import get_settings as _get_settings

logger = logging.getLogger(__name__)


class MessageHandler:
    """
    User message handler.
    
    Validates user messages and delegates to stream orchestrator.
    """
    
    def __init__(
        self,
        *,
        stream_orchestrator: Any,
        command_executor: Any,
        task_manager: Any,
        request_mapper: Any,
        cache_service: Any,
        runtime: Any = None,  # For context monitoring
        chat_repository: Any = None,  # For loading artifacts
        tts_coordinator: Any = None,  # TTSCoordinator for handsfree TTS generation
        tts_config: Any = None,  # TTS configuration (from audio_config.TtsConfig)
    ):
        """
        Initialize message handler.
        
        Args:
            stream_orchestrator: Stream orchestration service
            command_executor: Command executor for WebSocket emissions
            task_manager: Task lifecycle manager
            request_mapper: Request ID mapper
            cache_service: Cache service
            runtime: RuntimeEngine for context monitoring
            chat_repository: ChatRepository for loading artifacts
            tts_coordinator: TTSCoordinator instance (injected by factory.py, for handsfree mode)
            tts_config: TTS configuration (optional, from audio_config.TtsConfig)
        """
        self._stream_orchestrator = stream_orchestrator
        self._command_executor = command_executor
        self._task_manager = task_manager
        self._request_mapper = request_mapper
        self._cache = cache_service
        self._runtime = runtime
        self._chat_repository = chat_repository
        self._tts_coordinator = tts_coordinator
        self._tts_config = tts_config
        self._logger = logger
        
        # CRITICAL FIX: Per-client request serialization (prevents DB race conditions)
        # Only one request per client processed at a time (subsequent requests wait)
        self._client_request_locks: dict[str, asyncio.Lock] = {}
        
        # CRITICAL FIX: Track active stream tasks per client (enables cancellation)
        # When new request arrives, cancel old task immediately (prevents resource waste)
        # Store BOTH task and backend_id so we can properly stop LLM execution
        self._active_stream_tasks: dict[str, dict[str, Any]] = {}  # client_id -> {'task': Task, 'backend_id': str, 'correlation_id': Optional[str]}

    @staticmethod
    def _is_valid_uuid(value: Any) -> bool:
        try:
            uuid.UUID(str(value))
            return True
        except (ValueError, TypeError, AttributeError):
            return False
    
    async def _wrap_with_tts(self, command_stream, client_id: str, chat_id: Optional[str] = None):
        """
        @.architecture
        Incoming: stream_orchestrator.relay_stream (LLM command stream) --- {AsyncIterator[Command], EmitStreamEvent chunks}
        Processing: Dual-queue TTS architecture (Kokoro pattern) --- {5 jobs: JOB_CHUNK_TEXT, JOB_QUEUE_SENTENCE, JOB_CATCH_QUEUEFULL, JOB_PULL_AUDIO, JOB_EMIT_AUDIO}
        Outgoing: command_executor (original commands + TTS audio commands) --- {EmitTTSAudio, EmitTTSQueued, EmitTTSCompleted, EmitTTSError}
        
        Async generator: Wraps relay_stream for handsfree, adds TTS generation.
        
        KOKORO ARCHITECTURE ADAPTED:
        Producer: Chunks text → queues sentences (via coordinator.add_sentence)
          - TextChunker splits LLM stream into natural sentence boundaries
          - Catches asyncio.QueueFull → emits EmitTTSError to frontend (no silent drops)
        Consumer: Pulls audio from queue (via coordinator.get_next_audio) → yields commands
          - Polls audio_queue asynchronously (non-blocking)
          - Waits for generation to complete before stopping service
        
        CRITICAL FIXES:
        - QueueFull handling: Catch + emit error to frontend (user sees content loss)
        - Per-client locking: Lock serializes requests, prevents DB race conditions
        - LLM stop on cancel: Stops Open Interpreter BEFORE cancelling task (prevents ghost generation)
        - Exception propagation: All errors logged + handled (FAIL_FAST pattern)
        - chat_id propagation: REQUIRED by ArtifactsStreamOrchestrator contract validation
        
        Pattern: Uses TTSCoordinator (injected by factory.py) for queue-based async generation.
        
        Args:
            command_stream: AsyncIterator[Command] from relay_stream()
            client_id: Client identifier for routing
            chat_id: Chat identifier for frontend IPC routing (REQUIRED by ArtifactsStreamOrchestrator)
            
        Yields:
            Original commands + EmitTTSAudio/EmitTTSQueued/EmitTTSCompleted commands
        """
        from ws.domain.audio.services.text_chunker import TextChunker
        from ws.domain.commands.audio_commands import (
            EmitTTSAudio,
            EmitTTSQueued,
            EmitTTSCompleted,
            EmitTTSError,
        )
        from ws.domain.commands.stream_commands import EmitStreamEvent
        import base64
        
        # Initialize per-request chunker
        chunker = TextChunker(
            first_size=self._tts_config.first_sentence_target_words,
            target_size=self._tts_config.chunk_target_words
        )
        
        first_chunk_sent = False
        stream_ended = False
        
        # Producer task: Process LLM stream → queue sentences
        async def producer():
            nonlocal first_chunk_sent, stream_ended
            try:
                async for command in command_stream:
                    # ALWAYS yield original command
                    yield command
                    
                    # Extract text for TTS
                    if isinstance(command, EmitStreamEvent):
                        event = command.event
                        if event.get('role') == 'assistant' and 'content' in event:
                            content = event['content']
                            
                            # Accumulate in chunker
                            chunker.current_text.append(content)
                            text = "".join(chunker.current_text)
                            
                            # Check if ready to process
                            if chunker.should_process(text):
                                # Compute break point BEFORE process() updates
                                # found_first_sentence (target_size changes after).
                                words = text.split()
                                target = chunker.first_size if not chunker.found_first_sentence else chunker.target_size
                                split_point = chunker.find_break_point(words, target)
                                
                                sentence = chunker.process(text, None)
                                
                                if sentence:
                                    # CRITICAL FIX: Preserve words AFTER the break
                                    # point.  Previous code did
                                    #   chunker.current_text = []
                                    # which silently dropped any text beyond the
                                    # sentence boundary (e.g. 15 words accumulated,
                                    # break at word 8 → words 9-15 lost).
                                    remaining_words = words[split_point:]
                                    remaining = " ".join(remaining_words)
                                    chunker.current_text = [remaining] if remaining.strip() else []
                                    
                                    # Emit tts-queued on FIRST chunk only
                                    if not first_chunk_sent:
                                        first_chunk_sent = True
                                        yield EmitTTSQueued(client_id=client_id, chat_id=chat_id)
                                    
                                    # Queue sentence for generation (with QueueFull error handling)
                                    try:
                                        await self._tts_coordinator.add_sentence(client_id, sentence)
                                        self._logger.info("TTS queued: '%s...'", sentence[:50])
                                    except asyncio.QueueFull:
                                        # CRITICAL: Queue overflow - user MUST know content was lost
                                        self._logger.error("TTS queue full (dropped sentence): '%s...' [client=%s]", sentence[:50], client_id[:8])
                                        
                                        # Notify frontend immediately (don't silently drop)
                                        yield EmitTTSError(
                                            client_id=client_id,
                                            error_type='queue_full',
                                            message="TTS queue overflow - some content may be missing from audio playback",
                                            chat_id=chat_id
                                        )
                
                # Stream ended - flush ALL remaining text as final sentence.
                # Don't re-chunk: the stream is over, so there's no benefit
                # to splitting further, and process() could leave a tail that
                # would never be queued (nothing more coming to trigger
                # should_process again).
                final_text = "".join(chunker.current_text).strip()
                if final_text and any(c.isalnum() for c in final_text):
                    if not first_chunk_sent:
                        first_chunk_sent = True
                        yield EmitTTSQueued(client_id=client_id, chat_id=chat_id)
                    try:
                        await self._tts_coordinator.add_sentence(client_id, final_text)
                        self._logger.info("TTS queued (final): '%s...'", final_text[:50])
                    except asyncio.QueueFull:
                        # CRITICAL: Queue overflow on final sentence
                        self._logger.error("TTS queue full (dropped final sentence): '%s...' [client=%s]", final_text[:50], client_id[:8])
                        
                        # Notify frontend immediately (don't silently drop)
                        yield EmitTTSError(
                            client_id=client_id,
                            error_type='queue_full',
                            message="TTS queue overflow - final sentence missing from audio playback",
                            chat_id=chat_id
                        )
                
                stream_ended = True
                
            finally:
                # CRITICAL: Signal consumer on BOTH success and error.
                # Without this, if the producer crashes (exception in command_stream),
                # stream_ended stays False and the consumer polls forever at
                # asyncio.sleep(0.01), causing an infinite spinner for the user.
                stream_ended = True
                chunker.current_text = []
                chunker.found_first_sentence = False
                
                # Trigger state change to wake up the consumer in case it's waiting
                self._tts_coordinator.trigger_state_change(client_id)
        
        # Consumer task: Pull audio from queue → yield commands
        async def consumer():
            try:
                while True:
                    # Get next audio from queue
                    result = await self._tts_coordinator.get_next_audio(client_id)
                    
                    if result:
                        audio_bytes, sentence = result
                        self._logger.info("TTS audio ready: %d bytes", len(audio_bytes))
                        
                        # Encode for WebSocket
                        audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')
                        
                        # Yield TTS audio command
                        yield EmitTTSAudio(
                            client_id=client_id,
                            audio_data=audio_b64,
                            format="pcm16",
                            sample_rate=self._tts_config.sample_rate,
                            chat_id=chat_id
                        )
                    else:
                        # Queue empty - check if generation truly complete
                        if stream_ended and self._tts_coordinator.is_generation_complete(client_id):
                            self._logger.info("TTS generation and consumption complete for %s", client_id[:8])
                            break
                        
                        # Wait for state change event instead of burning CPU with active polling
                        await self._tts_coordinator.wait_for_state_change(client_id)
            finally:
                # Stop TTS service (always, to clean up resources)
                await self._tts_coordinator.stop_service(client_id)
                
                # Only emit completion if TTS was actually started (first_chunk_sent).
                # If LLM returned empty response, no tts-queued was emitted and frontend
                # is still in PROCESSING — sending tts-completed without tts-queued would
                # be silently ignored, leaving the state machine stuck.
                if first_chunk_sent:
                    yield EmitTTSCompleted(client_id=client_id, chat_id=chat_id)
                else:
                    self._logger.warning("TTS consumer finished with no audio generated for %s (empty LLM response?)", client_id[:8])
        
        # Merge producer and consumer streams concurrently
        command_queue = asyncio.Queue()
        
        async def producer_wrapper():
            try:
                async for cmd in producer():
                    await command_queue.put(cmd)
            finally:
                await command_queue.put(None)
        
        async def consumer_wrapper():
            try:
                async for cmd in consumer():
                    await command_queue.put(cmd)
            finally:
                await command_queue.put(None)
        
        # Start both tasks concurrently
        producer_task = asyncio.create_task(producer_wrapper())
        consumer_task = asyncio.create_task(consumer_wrapper())
        
        completed_normally = False
        try:
            # Yield commands as they arrive
            done_count = 0
            while done_count < 2:
                cmd = await command_queue.get()
                if cmd is None:
                    done_count += 1
                else:
                    yield cmd
            
            # Ensure both complete
            await asyncio.gather(producer_task, consumer_task)
            completed_normally = True
        except asyncio.CancelledError:
            self._logger.debug("TTS wrap cancelled for client %s", client_id[:8])
            raise
        finally:
            if not completed_normally:
                for task in (producer_task, consumer_task):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(producer_task, consumer_task, return_exceptions=True)
                try:
                    await asyncio.shield(self._tts_coordinator.clear_queues(client_id))
                except (RuntimeError, TypeError, ValueError, KeyError, OSError, ConnectionError, asyncio.TimeoutError) as cleanup_error:
                    self._logger.warning(
                        "Failed to clear TTS queues for %s: %s", client_id[:8], cleanup_error
                    )
                try:
                    await asyncio.shield(self._tts_coordinator.stop_service(client_id))
                except (RuntimeError, TypeError, ValueError, KeyError, OSError, ConnectionError, asyncio.TimeoutError) as cleanup_error:
                    self._logger.warning(
                        "Failed to stop TTS service for %s: %s", client_id[:8], cleanup_error
                    )
    
    async def handle_user_message(
        self,
        *,
        ws: WebSocket,
        client_id: str,
        message: Any,
    ) -> None:
        """
        Handle user message (text/image).
        
        CRITICAL: Serializes requests per client using asyncio.Lock.
        Prevents DB race conditions (duplicate sequence_in_chat assignments)
        and ensures only one stream task runs per client at a time.
        
        Args:
            ws: WebSocket connection
            client_id: Client identifier
            message: User message object
        """
        # CRITICAL FIX: Get or create lock for this client (serialize requests per client)
        # Prevents race condition: rapid requests → concurrent DB writes → duplicate key errors.
        # Also ensures that cancellation of the previous task is complete before starting the next.
        if client_id not in self._client_request_locks:
            self._client_request_locks[client_id] = asyncio.Lock()
        
        async with self._client_request_locks[client_id]:
            # CRITICAL FIX: Stop previous stream execution (LLM + task cancellation)
            # User sent new request → old request is obsolete → STOP LLM FIRST, then cancel task.
            # This must be inside the lock to prevent overlapping setup tasks.
            if client_id in self._active_stream_tasks:
                old_info = self._active_stream_tasks[client_id]
                old_task = old_info['task']
                old_backend_id = old_info['backend_id']
                
                if not old_task.done():
                    # STEP 1: Stop Open Interpreter execution (critical!)
                    try:
                        old_chat_id = old_info.get('chat_id')
                        await self._runtime.stop_generation(old_backend_id, chat_id=old_chat_id)
                        self._logger.info("Stopped LLM generation: %s", old_backend_id[:8])
                    except (RuntimeError, TypeError, ValueError, KeyError, OSError, ConnectionError, asyncio.TimeoutError) as stop_error:
                        self._logger.warning("Failed to stop LLM generation %s: %s", old_backend_id[:8], stop_error)
                    
                    # STEP 2: Cancel the task (now safe, LLM is stopped)
                    old_task.cancel()
                    self._logger.info("Cancelled previous stream task: %s", client_id[:8])
                    
                    try:
                        # Wait for cancellation to propagate before starting the next setup
                        await asyncio.wait_for(old_task, timeout=2.0)
                    except (asyncio.CancelledError):
                        pass  # Expected - task successfully cancelled
                    except asyncio.TimeoutError:
                        self._logger.error("CRITICAL: Stream task cancellation timed out (zombie task): client=%s, req=%s", client_id[:8], old_backend_id[:8])
                        if hasattr(self._task_manager, 'track_orphaned_task'):
                            self._task_manager.track_orphaned_task(old_task, old_backend_id)
                    except Exception as cancel_error:  # noqa: BLE001 -- must catch all to avoid permanently crashing WebSocket loop for this client
                        self._logger.warning("Error during task cancellation wait: %s", cancel_error)

            # Extract message content
            text = message.content or ""
            image_b64 = message.image
            frontend_id = message.id
            correlation_id = getattr(message, 'correlation_id', None)
            chat_id = getattr(message, 'chat_id', None)
            raw_metadata = getattr(message, 'metadata', None)
            metadata = raw_metadata if isinstance(raw_metadata, dict) else None

            # CONTRACT: chat_id must be a UUID when provided (required for persistence + artifacts).
            if chat_id and not self._is_valid_uuid(chat_id):
                self._logger.warning("Rejected message with invalid chat_id: %s", chat_id)
                try:
                    await ws.send_json({
                        "role": "server",
                        "type": "error",
                        "content": "Invalid chat_id. Expected UUID.",
                        "error_details": {
                            "category": "validation",
                            "technical_details": "chat_id must be a UUID string for chat persistence and artifacts.",
                            "suggestions": [
                                "Use the chat_id returned by the backend",
                                "Generate a UUID for chat_id on the client",
                            ],
                        },
                        "chat_id": chat_id,
                    })
                except (RuntimeError, OSError, ConnectionError) as exc:
                    self._logger.debug("Failed to send invalid chat_id error: %s", exc)
                return
        
            # CRITICAL DIAGNOSTIC: Log correlation_id extraction
            self._logger.info("Extracted correlation_id from message: %s (frontend_id: %s)", correlation_id, frontend_id)
        
            # Generate backend request ID
            backend_id = str(uuid.uuid4())
        
            # Register request ID mapping
            registered = await self._request_mapper.register_mapping(
                client_id=client_id,
                frontend_id=frontend_id,
                correlation_id=correlation_id,
                backend_id=backend_id,
            )
        
            if not registered:
                self._logger.warning("Duplicate message: frontend_id=%s", frontend_id)
                return
        
            # CRITICAL: Record session state at stream start (matches legacy behavior)
            # Legacy MessageRouter records "active" state with "started_at" timestamp
            await self._cache.record_session_state(
                backend_id,
                {
                    "client_id": client_id,
                    "frontend_id": frontend_id,
                    "correlation_id": correlation_id,
                    "chat_id": chat_id,
                    "state": "active",
                    "started_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        
            # Create stream task (wrapper that consumes commands and executes)
            async def stream_and_execute():
                """Stream commands from orchestrator and execute via executor."""
                try:
                    # Process artifacts and prepend context to user message
                    enriched_text = text
                    vision_image = image_b64  # Start with message image (if any)
                
                    if self._runtime and chat_id and self._chat_repository:
                        self._logger.info("Processing artifacts for chat: %s", chat_id[:8])
                    
                        # Check if LLM supports vision.
                        # Avoid DB-backed runtime settings from WS layer; prefer runtime-provided settings when available.
                        try:
                            settings_obj = getattr(self._runtime, "settings", None) if self._runtime else None
                            if settings_obj is None:
                                settings_obj = _get_settings()
                            supports_vision = bool(getattr(getattr(settings_obj, "llm", None), "supports_vision", False))
                        except (AttributeError, TypeError, ImportError):
                            supports_vision = False
                    
                        # Get artifact context (and extract images for vision models)
                        artifact_result = await self._get_artifact_context_with_images(
                            chat_id,
                            supports_vision,
                            correlation_id=correlation_id,
                        )
                    
                        if artifact_result['text_context']:
                            enriched_text = artifact_result['text_context'] + "\n\n" + text
                            self._logger.info("Enriched message with artifact context (%d chars)", len(artifact_result['text_context']))
                    
                        # For vision models, use first image artifact directly
                        if supports_vision and artifact_result['image_b64'] and not vision_image:
                            vision_image = artifact_result['image_b64']
                            self._logger.info("Using image artifact directly for vision model")
                
                    # Check context before streaming if runtime available
                    if self._runtime and chat_id:
                        self._logger.info("Checking context for chat: %s", chat_id[:8])
                        await self._check_and_notify_context(ws, chat_id, client_id)
                    else:
                        self._logger.warning("Skipping context check: runtime=%s, chat_id=%s", self._runtime is not None, chat_id is not None)
                
                    # Detect handsfree mode (via correlation_id prefix or message flag)
                    is_handsfree = (
                        (correlation_id and correlation_id.startswith('handsfree-')) or
                        getattr(message, 'handsfree', False)
                    )
                
                    if is_handsfree:
                        handsfree_instruction = """
[SYSTEM INSTRUCTION: You are responding to a Voice (Handsfree) request. Keep your response conversational, concise, and natural as if speaking aloud. You MUST use emotion tags like <happy>, <sad>, <excited>, <calm>, <serious>, or [laugh], [sigh], [breath] to add prosody and emotion to your voice. These tags will be processed by the TTS engine. Avoid using emojis, markdown formatting, or long lists.]
"""
                        enriched_text = enriched_text + "\n\n" + handsfree_instruction.strip()
                        self._logger.info("Injected handsfree system instruction into user message context")
                
                    # Get relay_stream command iterator
                    command_stream = self._stream_orchestrator.relay_stream(
                        client_id=client_id,
                        request_id=backend_id,
                        frontend_id=frontend_id,
                        text=enriched_text,  # Use enriched text with artifact context FOR LLM
                        original_text=text,  # Pass original text FOR DATABASE PERSISTENCE
                        image_b64=vision_image,  # Use vision_image (may include artifact image)
                        correlation_id=correlation_id,
                        chat_id=chat_id,
                        metadata=metadata,
                    )
                
                    # Wrap with TTS if handsfree mode and TTS available
                    if is_handsfree and self._tts_coordinator and self._tts_config:
                        self._logger.info("Handsfree mode: wrapping stream with TTS queue (correlation_id=%s)", correlation_id)
                        command_stream = self._wrap_with_tts(command_stream, client_id, chat_id)
                
                    # Execute commands from (potentially wrapped) stream
                    async for command in command_stream:
                        # Check WebSocket state before executing
                        if ws.client_state.name == "DISCONNECTED":
                            self._logger.debug("Client disconnected: %s", backend_id)
                            break
                    
                        await self._command_executor.execute(ws, command)
                
                    # Post-stream context check
                    if self._runtime and chat_id:
                        await self._check_and_summarize_context(chat_id)
                    
                except Exception as e:
                    self._logger.error("Stream execution error: %s: %s", backend_id, e, exc_info=True)
                    raise
        
            stream_task = asyncio.create_task(stream_and_execute())
            
            # CRITICAL FIX: Track task + backend_id for proper LLM cancellation
            # Enables immediate interruption AND LLM stop when user sends new message
            self._active_stream_tasks[client_id] = {
                'task': stream_task,
                'backend_id': backend_id,
                'correlation_id': correlation_id,
                'chat_id': chat_id,
            }
        
            # Register task for tracking
            await self._task_manager.register_task(
                request_id=backend_id,
                task=stream_task,
                client_id=client_id,
                correlation_id=correlation_id,
                frontend_id=frontend_id,
            )
        
            # Attach finalizer for automatic cleanup
            self._task_manager.attach_finalizer(
                stream_task,
                request_id=backend_id,
                cleanup_callback=lambda rid: asyncio.create_task(
                    self._cleanup_stream_task(
                        client_id=client_id,
                        frontend_id=frontend_id,
                        correlation_id=correlation_id,
                        backend_id=rid,
                    )
                ),
            )
        
            self._logger.info(
                f"User message: backend={backend_id[:8]}, frontend={frontend_id[:8] if frontend_id else 'none'}"
            )
    
    async def _cleanup_stream_task(
        self,
        client_id: str,
        frontend_id: str,
        correlation_id: Optional[str],
        backend_id: str,
    ) -> None:
        """
        Cleanup stream task on completion/cancellation.
        
        Removes task from tracking dict and cleans up request mapping.
        
        Args:
            client_id: Client identifier
            frontend_id: Frontend request ID
            backend_id: Backend request ID
        """
        # Remove from active tasks tracking (check backend_id matches to avoid race)
        if client_id in self._active_stream_tasks:
            if self._active_stream_tasks[client_id].get('backend_id') == backend_id:
                self._active_stream_tasks.pop(client_id, None)
        
        # Clean up request mapping
        await self._request_mapper.forget_mapping(
            client_id=client_id,
            frontend_id=frontend_id,
            correlation_id=correlation_id,
            backend_id=backend_id,
        )
    
    async def cleanup_client(self, client_id: str) -> None:
        """
        Cleanup per-client handler state on disconnect.

        Mirrors the cancellation logic in handle_user_message (lines 334-358):
        stop LLM generation first, then cancel the asyncio task, then wait.
        Without this, disconnect leaves orphaned tasks and running LLM inference.
        """
        # CRITICAL FIX: Synchronize with handle_user_message to prevent race conditions
        if client_id not in self._client_request_locks:
            self._client_request_locks[client_id] = asyncio.Lock()
            
        async with self._client_request_locks[client_id]:
            task_info = self._active_stream_tasks.pop(client_id, None)
            if task_info:
                task = task_info.get('task')
                backend_id = task_info.get('backend_id')
                if task and not task.done():
                    # STEP 1: Stop LLM generation (prevents wasted inference)
                    if backend_id and self._runtime:
                        try:
                            old_chat_id = task_info.get('chat_id')
                            await self._runtime.stop_generation(backend_id, chat_id=old_chat_id)
                            self._logger.info("Stopped LLM on disconnect: %s", backend_id[:8])
                        except Exception as e:
                            self._logger.warning(
                                "Failed to stop LLM on disconnect %s: %s", backend_id[:8], e
                            )
                    # STEP 2: Cancel the asyncio task (now safe, LLM is stopped)
                    task.cancel()
                    try:
                        await asyncio.wait_for(task, timeout=2.0)
                    except asyncio.CancelledError:
                        pass  # Expected
                    except asyncio.TimeoutError:
                        self._logger.error("CRITICAL: Disconnect task cancellation timed out (zombie task): client=%s, req=%s", client_id[:8], backend_id[:8] if backend_id else "unknown")
                        if hasattr(self._task_manager, 'track_orphaned_task') and backend_id:
                            self._task_manager.track_orphaned_task(task, backend_id)
                    except Exception as e:
                        self._logger.warning("Error during disconnect task cleanup: %s", e)

        self._client_request_locks.pop(client_id, None)

    async def shutdown(self) -> None:
        """Shutdown handler resources (background tasks)."""
        try:
            if self._stream_orchestrator and hasattr(self._stream_orchestrator, "shutdown"):
                await self._stream_orchestrator.shutdown()
        except Exception as e:
            self._logger.warning("Stream orchestrator shutdown failed: %s", e)
    
    async def _check_and_notify_context(
        self,
        ws: WebSocket,
        chat_id: str,
        client_id: str,
    ) -> None:
        """
        Check conversation context and notify client if high.
        
        Args:
            ws: WebSocket connection
            chat_id: Chat identifier
            client_id: Client identifier
        """
        try:
            if not hasattr(self._runtime, '_interpreter_manager'):
                self._logger.warning("Runtime has no _interpreter_manager")
                return
            
            status = await self._runtime._interpreter_manager.get_context_status(chat_id)
            
            self._logger.info(
                f"Context status: chat={chat_id[:8]}, "
                f"count={status['message_count']}, status={status['status']}"
            )
            
            if status['status'] in ['warning', 'high', 'critical']:
                # Emit system notification
                # CONTRACT: System notifications don't have request_id (not part of request stream)
                # But we don't send 'id' field anymore - removed for clean architecture
                notification = {
                    'type': 'system',
                    'role': 'system',
                    'content': self._build_context_warning(status),
                    'metadata': {
                        'context_status': status['status'],
                        'message_count': status['message_count'],
                        'recommend_new_chat': status['recommend_new_chat'],
                    },
                }
                
                await ws.send_json(notification)
                
                self._logger.info(
                    "Context warning sent: chat=%s, status=%s, count=%s",
                    chat_id[:8], status['status'], status['message_count'],
                )
        except (RuntimeError, AttributeError, KeyError, OSError, ConnectionError) as e:
            self._logger.warning("Failed to check context: %s", e)
    
    async def _get_artifact_context(
        self,
        chat_id: str,
        correlation_id: Optional[str] = None,
    ) -> str:
        """
        Load and process artifacts, return formatted context string.
        
        Args:
            chat_id: Chat identifier
            
        Returns:
            Formatted artifact context string (empty if no artifacts)
        """
        try:
            from ws.application.artifact_processor import get_artifact_processor
            
            # Load artifacts from database
            chat_uuid = UUID(chat_id)
            artifacts = await self._chat_repository.get_artifacts(
                chat_uuid,
                type='file',  # Only process file artifacts
            )
            
            if not artifacts:
                self._logger.debug("No artifacts found for chat %s", chat_id[:8])
                return ""
            
            # Filter artifacts for THIS message only (prevents reprocessing older files)
            if not correlation_id:
                self._logger.debug(
                    "Skipping artifact context: missing correlation_id (chat=%s)",
                    chat_id[:8],
                )
                return ""

            user_artifacts = []
            for artifact in artifacts:
                metadata = getattr(artifact, 'metadata', {}) or {}
                if isinstance(metadata, str):
                    import json
                    try:
                        metadata = json.loads(metadata)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        metadata = {}

                if metadata.get('role') != 'user':
                    continue

                artifact_message_id = getattr(artifact, 'message_id', None)
                if metadata.get('correlation_id') == correlation_id or (
                    artifact_message_id and str(artifact_message_id) == correlation_id
                ):
                    user_artifacts.append(artifact)
            
            if not user_artifacts:
                self._logger.debug("No user artifacts to process for chat %s", chat_id[:8])
                return ""
            
            self._logger.info("Found %d user artifacts for chat %s", len(user_artifacts), chat_id[:8])
            
            # Process artifacts
            processor = get_artifact_processor()
            result = await processor.process_artifacts(
                artifacts=user_artifacts,
                chat_id=chat_id,
            )
            
            context_text = result.get('context_text', '')
            processed_count = result.get('processed_count', 0)
            
            if not context_text:
                self._logger.debug("No context generated from artifacts")
                return ""
            
            # Format as context message prefix with STRICT instructions
            formatted_context = f"""[SYSTEM INSTRUCTION: The user has attached {processed_count} file(s). The content has ALREADY been extracted and processed. DO NOT attempt to use tools like computer.docling_convert, computer.agents.vision, or any file reading tools. The complete content is provided below. Use ONLY this content to answer the user's question.]

{context_text}

[SYSTEM INSTRUCTION: End of attached file content. The user's message follows. Answer DIRECTLY using the content above. DO NOT search for, parse, or attempt to load any files.]

"""
            
            self._logger.info(
                "Generated context from %d artifacts (%d chars) for chat %s",
                processed_count, len(formatted_context), chat_id[:8],
            )
            
            return formatted_context
                
        except (ValueError, TypeError, AttributeError, KeyError, OSError, RuntimeError) as e:
            self._logger.error("Failed to process artifacts: %s", e, exc_info=True)
            return ""
    
    async def _get_artifact_context_with_images(
        self,
        chat_id: str,
        supports_vision: bool,
        correlation_id: Optional[str] = None,
    ) -> dict:
        """
        Load and process artifacts, handling images specially for vision models.
        
        For vision models:
        - Images are returned as base64 (not processed through InternVL)
        - Documents are processed through Docling
        
        For text models:
        - Images are processed through InternVL
        - Documents are processed through Docling
        
        Args:
            chat_id: Chat identifier
            supports_vision: Whether LLM supports native vision
            
        Returns:
            Dictionary with 'text_context' and 'image_b64' keys
        """
        try:
            from ws.application.artifact_processor import get_artifact_processor
            
            # Load artifacts from database
            chat_uuid = UUID(chat_id)
            artifacts = await self._chat_repository.get_artifacts(
                chat_uuid,
                type='file',  # Only process file artifacts
            )
            
            if not artifacts:
                return {'text_context': '', 'image_b64': None}
            
            if not correlation_id:
                self._logger.debug(
                    "Skipping artifact context: missing correlation_id (chat=%s)",
                    chat_id[:8],
                )
                return {'text_context': '', 'image_b64': None}

            # Filter user artifacts for THIS message and separate images from documents
            image_artifacts = []
            text_artifacts = []

            for artifact in artifacts:
                metadata = getattr(artifact, 'metadata', {}) or {}
                if isinstance(metadata, str):
                    import json
                    try:
                        metadata = json.loads(metadata)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        metadata = {}

                if metadata.get('role') != 'user':
                    continue

                artifact_message_id = getattr(artifact, 'message_id', None)
                is_current_message = (
                    metadata.get('correlation_id') == correlation_id
                    or (artifact_message_id and str(artifact_message_id) == correlation_id)
                )
                if not is_current_message:
                    continue

                filename = getattr(artifact, 'filename', '')
                is_image = any(
                    filename.lower().endswith(ext)
                    for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']
                )

                if is_image and supports_vision:
                    image_artifacts.append(artifact)
                else:
                    text_artifacts.append(artifact)
            
            # Process text artifacts (documents + images for text models)
            text_context = ""
            if text_artifacts:
                processor = get_artifact_processor()
                result = await processor.process_artifacts(
                    artifacts=text_artifacts,
                    chat_id=chat_id,
                )
                
                context_text = result.get('context_text', '')
                processed_count = result.get('processed_count', 0)
                
                if context_text:
                    text_context = f"""[SYSTEM INSTRUCTION: The user has attached {processed_count} file(s). The content has ALREADY been extracted and processed. DO NOT attempt to use tools to read or parse these files. The complete content is provided below. Use ONLY this content to answer the user's question.]

{context_text}

[SYSTEM INSTRUCTION: End of attached file content. The user's message follows. Answer DIRECTLY using the content above.]

"""
            
            # Extract first image for vision models (native vision API).
            # Additional images beyond the first are routed through InternVL
            # text analysis so their content is preserved as text context
            # (most vision LLM APIs accept only one image per message).
            image_b64 = None
            if image_artifacts and supports_vision:
                first_image = image_artifacts[0]
                image_b64 = getattr(first_image, 'content', None)
                self._logger.info(
                    f"Extracted image artifact for vision model: "
                    f"{getattr(first_image, 'filename', 'unknown')}"
                )
                
                # Route overflow images through InternVL text analysis
                # so their content is not silently dropped.
                if len(image_artifacts) > 1:
                    overflow_images = image_artifacts[1:]
                    self._logger.info(
                        f"Processing {len(overflow_images)} additional image(s) "
                        f"through InternVL text analysis (vision API limit: 1 image)"
                    )
                    overflow_processor = get_artifact_processor()
                    overflow_result = await overflow_processor.process_artifacts(
                        artifacts=overflow_images,
                        chat_id=chat_id,
                    )
                    overflow_context = overflow_result.get('context_text', '')
                    if overflow_context:
                        overflow_count = overflow_result.get('processed_count', 0)
                        if text_context:
                            text_context += f"\n\n{overflow_context}"
                        else:
                            text_context = (
                                f"[SYSTEM INSTRUCTION: The user has attached "
                                f"{overflow_count} additional image(s). Their content "
                                f"has been analyzed and is provided below.]\n\n"
                                f"{overflow_context}\n\n"
                                f"[SYSTEM INSTRUCTION: End of image analysis content.]\n\n"
                            )
                        self._logger.info(
                            f"Overflow image context added: {len(overflow_context)} chars "
                            f"from {overflow_count} image(s)"
                        )
            
            return {
                'text_context': text_context,
                'image_b64': image_b64
            }
            
        except (ValueError, TypeError, AttributeError, KeyError, OSError, RuntimeError) as e:
            self._logger.error("Failed to get artifact context with images: %s", e, exc_info=True)
            return {'text_context': '', 'image_b64': None}
    
    async def _check_and_summarize_context(self, chat_id: str) -> None:
        """
        Check if context needs summarization and trigger if needed.
        
        Args:
            chat_id: Chat identifier
        """
        try:
            if not hasattr(self._runtime, '_interpreter_manager'):
                return
            
            status = await self._runtime._interpreter_manager.get_context_status(chat_id)
            
            if status['needs_summarization']:
                self._logger.info(
                    "Triggering context summarization: chat=%s, messages=%s",
                    chat_id[:8], status['message_count'],
                )
                
                summary = await self._runtime._interpreter_manager.summarize_context(chat_id)
                
                if summary:
                    self._logger.info(
                        "Context summarized: chat=%s, length=%d chars",
                        chat_id[:8], len(summary),
                    )
        except (RuntimeError, AttributeError, KeyError, TypeError) as e:
            self._logger.warning("Failed to summarize context: %s", e)
    
    def _build_context_warning(self, status: dict) -> str:
        """Build context warning message for client."""
        tokens = status['token_count']
        limit = status['token_limit']
        percent = status['usage_percent']
        
        if status['recommend_new_chat']:
            return (
                f"⚠️ Context usage is very high ({percent}% of {limit:,} tokens). "
                f"Consider starting a new chat for optimal performance. "
                f"Your context will be automatically summarized to maintain continuity."
            )
        elif status['status'] == 'high':
            return (
                f"💡 Context usage is getting high ({percent}% of {limit:,} tokens). "
                f"Starting a new chat soon is recommended for best results."
            )
        else:  # warning
            return (
                f"📊 Context usage: {tokens:,} tokens ({percent}% of {limit:,} limit). "
                f"You have plenty of space remaining."
            )


