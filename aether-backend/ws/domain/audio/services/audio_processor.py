"""
@.architecture
Incoming: AudioHandler (Base64 Opus audio), Frontend WebSocket --- {str (Base64 Opus), str (client_id)}
Processing: Decode Opus, wake word detection, buffer audio, VAD, STT, TTS interruption --- {7 jobs: JOB_DECODE, JOB_WAKE_WORD, JOB_BUFFER, JOB_VAD, JOB_STT, JOB_INTERRUPT_TTS, JOB_EMIT}
Outgoing: on_transcript callback, on_interruption callback --- {str (client_id), str (transcription)}

AudioProcessingService - Coordinates Wake Word + VAD + STT + Interruption pipeline

Coordinates the audio processing pipeline for handsfree mode:
1. Decode Base64 Opus to PCM16
2. Detect wake word using openWakeWord (hey_jarvis model)
3. After wake word detected, buffer audio chunks
4. Run VAD (pyannote) to detect speech segments
5. Transcribe speech segments with Whisper STT
6. CRITICAL: Interrupt ongoing TTS if user speaks during playback
7. Invoke callbacks with results (transcript, interruption event)

Architecture: Two-stage filtering (wake word → VAD/STT) for low false-positive rate.
Wake word detection runs on every frame (~30ms latency), VAD/STT only after activation.

Conversation Mode: After wake word detected, stays active for 30 seconds (configurable).
During conversation mode, all speech is transcribed without requiring wake word again.
Enables natural turn-taking: agent speaks → user speaks → agent responds (no wake word)

Interruption Detection (CRITICAL FIX):
- When STT detects user speech, checks if TTS is active for this client
- If TTS active: calls tts_coordinator.clear_queues() to discard pending audio
- Calls on_interruption() callback to notify frontend (emits WebSocket event)
- Prevents: queue overflow, resource waste, unnatural conversation flow
- Enables: natural turn-taking, user can interrupt agent mid-response
"""

import asyncio
import numpy as np
from typing import Optional, Callable, Awaitable, Any
import logging
import time
from enum import Enum

from .audio_decoder import OpusDecoder
from .vad_service import PyannotVadService
from .stt_service import WhisperSttService
from .wake_word_service import WakeWordService

logger = logging.getLogger(__name__)


class CircuitState(str, Enum):
    """Circuit breaker states (HIGH FIX: enum instead of hardcoded strings)."""
    CLOSED = 'closed'      # Normal operation
    OPEN = 'open'          # Consecutive failures exceeded threshold
    HALF_OPEN = 'half_open'  # Testing if service recovered


class AudioProcessingService:
    """Coordinates Wake Word + VAD + STT pipeline for audio chunk processing."""
    
    def __init__(
        self,
        opus_decoder: OpusDecoder,
        vad_service: PyannotVadService,
        stt_service: WhisperSttService,
        wake_word_service: WakeWordService,
        on_transcript: Optional[Callable[[str, str], Awaitable[None]]] = None,
        on_interruption: Optional[Callable[[str], Awaitable[None]]] = None,
        conversation_timeout: float = 30.0,
        cache_adapter: Optional[Any] = None,
        cache_namespace: str = "handsfree:conversation",
        max_buffer_seconds: int = 30,
        sample_rate: int = 16000,
        circuit_breaker_enabled: bool = True,
        circuit_breaker_threshold: int = 5,
        circuit_breaker_reset_timeout: int = 60,
        silence_threshold: float = 0.01,
        clipping_threshold: float = 0.99,
        tts_coordinator: Optional[Any] = None,  # TTSCoordinator for per-client TTS cleanup
    ):
        """
        Initialize audio processing service.
        
        Args:
            opus_decoder: Opus decoder instance
            vad_service: VAD service instance
            stt_service: STT service instance
            wake_word_service: Wake word detection service
            on_transcript: Async callback for transcription results (client_id, text)
            on_interruption: Async callback for TTS interruption detection (client_id)
            conversation_timeout: Seconds before requiring wake word again (from config)
            cache_adapter: Redis adapter for conversation state persistence (optional)
            cache_namespace: Redis key namespace for state persistence (from config)
            max_buffer_seconds: Maximum audio buffer duration (from config)
            sample_rate: Audio sample rate in Hz (from config)
            circuit_breaker_enabled: Enable circuit breaker for ML failures (from config)
            circuit_breaker_threshold: Consecutive failures before opening circuit (from config)
            circuit_breaker_reset_timeout: Seconds before attempting reset (from config)
            silence_threshold: RMS threshold for silence detection (from config)
            clipping_threshold: Peak amplitude threshold for clipping detection (from config)
            tts_coordinator: TTSCoordinator instance for per-client TTS service lifecycle (optional)
        """
        self.decoder = opus_decoder
        self.vad = vad_service
        self.stt = stt_service
        self.wake_word = wake_word_service
        self.on_transcript = on_transcript
        self.on_interruption = on_interruption
        self._tts_coordinator = tts_coordinator
        
        # CRITICAL FIX: Redis adapter for persistence (namespace from config, not hardcoded)
        self._cache = cache_adapter
        self._cache_namespace = cache_namespace
        
        # Conversation state (per client)
        self.conversation_active = {}  # client_id -> timestamp of last activity
        self.conversation_timeout = conversation_timeout
        
        # Audio quality validation thresholds (from config)
        self.silence_threshold = silence_threshold
        self.clipping_threshold = clipping_threshold
        
        # MEDIUM FIX: Track last wake word detection separately from last transcript
        # This prevents timeout reset abuse (user says anything every 25s to extend conversation)
        self.last_wake_word_time = {}  # client_id -> timestamp of wake word detection
        
        # HIGH FIX: Per-client locks for race condition protection
        self._client_locks = {}  # client_id -> asyncio.Lock
        
        # CRITICAL FIX: Track which clients have attempted state load (avoid repeated Redis calls)
        self._state_loaded = {}  # client_id -> bool
        
        # HIGH FIX: Use config values (NO HARDCODED VALUES)
        self.sample_rate = sample_rate
        self.MAX_BUFFER_SECONDS = max_buffer_seconds
        self.MAX_BUFFER_SAMPLES = self.MAX_BUFFER_SECONDS * self.sample_rate
        
        # MEDIUM FIX: Circuit breaker pattern (prevent resource exhaustion from ML failures)
        self.circuit_breaker_enabled = circuit_breaker_enabled
        self.circuit_breaker_threshold = circuit_breaker_threshold
        self.circuit_breaker_reset_timeout = circuit_breaker_reset_timeout
        self._circuit_breaker_failures = {}  # client_id -> consecutive failure count
        self._circuit_breaker_opened_at = {}  # client_id -> timestamp when circuit opened
        self._circuit_breaker_state = {}  # client_id -> 'closed'|'open'|'half_open'
        
        # Buffer for audio accumulation (per client) - ONLY used after wake word detected
        self.audio_buffers = {}  # client_id -> List[np.ndarray]
        self._logger = logger
        
        persistence_status = "enabled" if cache_adapter else "disabled (in-memory only)"
        self._logger.info(
            f"AudioProcessingService initialized: "
            f"wake_word_enabled=True, "
            f"timeout={conversation_timeout}s, "
            f"max_buffer={self.MAX_BUFFER_SECONDS}s, "
            f"persistence={persistence_status}"
        )
    
    def _strip_wake_word_phrases(self, text: str) -> str:
        """
        Strip wake word phrases from transcript (fallback cleanup).
        
        Removes wake word variants from beginning/middle/end of transcript.
        This is a safety net - GAP 3 fix should prevent wake word audio from reaching STT,
        but this ensures any leaked phrases are cleaned.
        
        Args:
            text: Raw transcript text
            
        Returns:
            Cleaned transcript with wake word phrases removed
        """
        if not text:
            return text
        
        # Dynamically generate wake word variants based on the active model
        model_name = getattr(self.wake_word, 'model_name', 'hey_jarvis')
        if not isinstance(model_name, str):
            model_name = 'hey_jarvis'
            
        model_name = model_name.replace('_', ' ')
        base_word = model_name.replace('hey ', '').replace('hi ', '')
        
        wake_word_variants = [
            model_name,
            f"hi {base_word}",
            f"hello {base_word}",
            f"{model_name} please",
            f"{model_name} can you",
            base_word,
        ]
        
        text_lower = text.lower().strip()
        text_cleaned = text.strip()
        
        # Strip from beginning (most common case)
        for variant in wake_word_variants:
            if text_lower.startswith(variant):
                # Remove variant + any trailing punctuation/whitespace
                text_cleaned = text[len(variant):].lstrip(" ,.!?")
                text_lower = text_cleaned.lower()
                self._logger.debug("Stripped wake word from start: '%s' -> '%s'", variant, text_cleaned)
                break
        
        # If transcript is now empty or just wake word, return empty
        if not text_cleaned or text_cleaned.lower().strip() in wake_word_variants:
            return ""
        
        return text_cleaned
    
    def _validate_audio_quality(self, audio: np.ndarray, client_id: str) -> bool:
        """
        Validate audio quality before expensive ML inference (MEDIUM FIX).
        
        Checks:
        - Audio is not silent (RMS > threshold)
        - Audio is not corrupted (finite values)
        
        Args:
            audio: PCM audio array (mono, float32, normalized to [-1, 1])
            client_id: Client identifier
            
        Returns:
            True if audio quality acceptable, False if should drop
        """
        if audio is None or len(audio) == 0:
            return False
        
        # Check for corruption (NaN, Inf)
        if not np.all(np.isfinite(audio)):
            self._logger.warning("Corrupted audio for %s (non-finite values)", client_id[:8])
            return False
        
        # Silence detection (using config threshold)
        rms = np.sqrt(np.mean(audio ** 2))
        if rms < self.silence_threshold:
            return False
        
        return True
    
    def _check_circuit_breaker(self, client_id: str) -> bool:
        """
        MEDIUM FIX: Check if circuit breaker is open for client.
        
        Circuit states:
        - closed: Normal operation
        - open: Too many failures, reject requests
        - half_open: Testing if service recovered
        
        Args:
            client_id: Client identifier
            
        Returns:
            True if circuit is closed (allow processing), False if open (reject)
        """
        if not self.circuit_breaker_enabled:
            return True
        
        state = self._circuit_breaker_state.get(client_id, CircuitState.CLOSED)
        
        if state == CircuitState.CLOSED:
            return True
        
        if state == CircuitState.OPEN:
            # Check if reset timeout elapsed
            opened_at = self._circuit_breaker_opened_at.get(client_id, 0)
            elapsed = time.time() - opened_at
            
            if elapsed >= self.circuit_breaker_reset_timeout:
                # Attempt reset - transition to half_open
                self._circuit_breaker_state[client_id] = CircuitState.HALF_OPEN
                self._logger.info(
                    f"Circuit breaker HALF_OPEN for {client_id[:8]} "
                    f"(reset attempt after {elapsed:.1f}s)"
                )
                return True
            else:
                # Circuit still open - suppress logs (already logged once when opened)
                return False
        
        # HALF_OPEN or unknown future states: allow one request to test recovery
        return True
    
    def _record_ml_success(self, client_id: str) -> None:
        """
        MEDIUM FIX: Record successful ML operation - reset circuit breaker.
        
        Args:
            client_id: Client identifier
        """
        if not self.circuit_breaker_enabled:
            return
        
        prev_state = self._circuit_breaker_state.get(client_id, CircuitState.CLOSED)
        
        # Reset failures
        self._circuit_breaker_failures[client_id] = 0
        
        # Close circuit if it was open/half_open
        if prev_state != CircuitState.CLOSED:
            self._circuit_breaker_state[client_id] = CircuitState.CLOSED
            self._logger.info("Circuit breaker CLOSED for %s (service recovered)", client_id[:8])
    
    def _record_ml_failure(self, client_id: str, error: Exception) -> None:
        """
        MEDIUM FIX: Record ML operation failure - open circuit if threshold exceeded.
        
        Args:
            client_id: Client identifier
            error: Exception that occurred
        """
        if not self.circuit_breaker_enabled:
            return
        
        # Increment failure counter
        failures = self._circuit_breaker_failures.get(client_id, 0) + 1
        self._circuit_breaker_failures[client_id] = failures
        
        # Check if threshold exceeded
        if failures >= self.circuit_breaker_threshold:
            self._circuit_breaker_state[client_id] = CircuitState.OPEN
            self._circuit_breaker_opened_at[client_id] = time.time()
            
            self._logger.error(
                f"Circuit breaker OPEN for {client_id[:8]} "
                f"({failures} consecutive failures, threshold={self.circuit_breaker_threshold}). "
                f"Last error: {error}. "
                f"Will attempt reset in {self.circuit_breaker_reset_timeout}s"
            )
    
    async def _is_conversation_active(self, client_id: str) -> bool:
        """
        Check if conversation is active for client.
        
        MEDIUM FIX: Timeout based on last WAKE WORD detection, not last transcript.
        Prevents abuse where user extends conversation indefinitely by speaking every 25s.
        
        Args:
            client_id: Client identifier
            
        Returns:
            True if conversation active, False if awaiting wake word
        """
        if client_id not in self.conversation_active:
            return False
        
        # CRITICAL FIX: Check timeout from LAST ACTIVITY (STT transcript), not wake word
        # Allows continuous conversation - timeout resets on user speech, not just wake word
        last_activity = self.conversation_active.get(client_id, 0)
        elapsed = time.time() - last_activity

        if elapsed < self.conversation_timeout:
            return True
        else:
            # Conversation timed out
            self._logger.info(
                f"⏱️  Conversation timeout for {client_id[:8]} "
                f"(elapsed={elapsed:.1f}s since last activity, awaiting wake word)"
            )
            del self.conversation_active[client_id]
            self.last_wake_word_time.pop(client_id, None)
            self.wake_word.reset(client_id)
            
            # WIRE FIX: Clear conversation state from Redis
            if self._cache:
                await self._clear_conversation_state(client_id)
            
            return False
    
    async def process_chunk(self, base64_opus: str, client_id: str, format_hint: str = None) -> None:
        """
        Process incoming audio chunk with wake word detection.
        
        Pipeline:
        1. Decode audio → PCM (supports: pcm16, wav, opus, webm)
        2. If conversation NOT active: detect wake word (openWakeWord, ~30ms latency)
        3. If wake word detected: clear buffer (prevent wake word contamination), activate conversation
        4. If conversation active: buffer audio, run VAD, run STT, send transcript to LLM
        5. If wake word NOT detected and conversation NOT active: drop audio (save VAD/STT compute)
        
        Args:
            base64_opus: Base64-encoded Opus audio
            client_id: Client identifier
        """
        # AUDIT FIX: Initialize lock ONCE per client (not per-call)
        if client_id not in self._client_locks:
            self._client_locks[client_id] = asyncio.Lock()
        
        async with self._client_locks[client_id]:
            # CRITICAL FIX: Load conversation state from Redis (first chunk only)
            if client_id not in self._state_loaded:
                self._state_loaded[client_id] = True
                await self._load_conversation_state(client_id)
            
            try:
                # Decode audio → PCM (format auto-detected or use hint)
                pcm_audio = self.decoder.decode(base64_opus, format_hint=format_hint)
                
                # MEDIUM FIX: Audio quality validation before expensive ML inference
                if not self._validate_audio_quality(pcm_audio, client_id):
                    # Silent or corrupted audio - drop chunk
                    return
                
                # MEDIUM FIX: Check circuit breaker before expensive ML operations
                if not self._check_circuit_breaker(client_id):
                    # Circuit open - reject processing to prevent resource exhaustion
                    return
                
                # Check if conversation is active
                conversation_active = await self._is_conversation_active(client_id)
                
                # GAP 2 FIX: Only run wake word detection if conversation NOT active
                # Saves compute + prevents duplicate wake word detection
                if not conversation_active:
                    wake_word_detected = self.wake_word.detect(pcm_audio, self.sample_rate, client_id)
                    
                    if wake_word_detected:
                        # Activate conversation mode
                        self.conversation_active[client_id] = time.time()
                        self.last_wake_word_time[client_id] = time.time()  # MEDIUM FIX: Track wake word time
                        conversation_active = True
                        
                        # WIRE FIX: Persist conversation state to Redis
                        if self._cache:
                            await self._save_conversation_state(client_id)
                        
                        # GAP 3 FIX: Clear buffer to prevent wake word audio from reaching STT
                        # This chunk contains wake word - discard it
                        if client_id in self.audio_buffers:
                            self.audio_buffers[client_id].clear()
                        
                        self._logger.info(
                            f"🎯 Wake word activated conversation for {client_id[:8]}"
                        )
                        
                        # GAP 6 FIX: Send wake word detection event to frontend for visual feedback
                        if self.on_transcript:
                            await self.on_transcript(client_id, "__WAKE_WORD_DETECTED__")
                        
                        # Skip this chunk - it contains wake word audio
                        # Next chunks will be clean user speech
                        return
                
                # If conversation NOT active and wake word NOT detected, drop audio
                if not conversation_active:
                    # Audio dropped - awaiting wake word (no logging to reduce spam)
                    return
                
                # Initialize buffer for client
                if client_id not in self.audio_buffers:
                    self.audio_buffers[client_id] = []
                
                # Add to buffer
                self.audio_buffers[client_id].append(pcm_audio)
                
                # Concatenate buffer
                full_audio = np.concatenate(self.audio_buffers[client_id])
                
                # HIGH FIX: Backpressure - enforce max buffer size
                if len(full_audio) > self.MAX_BUFFER_SAMPLES:
                    # Trim old audio, keep most recent
                    samples_to_keep = self.MAX_BUFFER_SAMPLES
                    full_audio = full_audio[-samples_to_keep:]
                    
                    # Update buffer with trimmed audio
                    self.audio_buffers[client_id] = [full_audio]
                    
                    self._logger.warning(
                        f"⚠️  Buffer overflow for {client_id[:8]}: "
                        f"trimmed to {self.MAX_BUFFER_SECONDS}s "
                        f"(VAD may not be detecting speech end - noisy environment?)"
                    )
                
                # Run VAD to detect speech segments
                speech_segments = self.vad.detect_speech(full_audio, self.sample_rate)
                
                # If speech detected, transcribe
                if speech_segments:
                    self._logger.debug(
                        f"Processing {len(speech_segments)} speech segment(s) for client {client_id[:8]}"
                    )
                    
                    # NEW CRITICAL FIX: Instant VAD-driven Barge-in
                    # Interrupt ongoing TTS generation immediately when VAD detects speech,
                    # rather than waiting for Whisper STT to complete (saves 1-3 seconds of latency).
                    if self._tts_coordinator:
                        try:
                            # Clear pending TTS audio (discard what hasn't been sent yet)
                            await self._tts_coordinator.clear_queues(client_id)
                            self._logger.debug("TTS interrupted by instant VAD detection: %s", client_id[:8])
                            
                            # CRITICAL FIX: Notify frontend of interruption (backend-driven)
                            # Frontend transitions SPEAKING -> LISTENING automatically
                            if self.on_interruption:
                                try:
                                    await self.on_interruption(client_id)
                                    self._logger.debug("Interruption event emitted: %s", client_id[:8])
                                except Exception as emit_error:
                                    self._logger.error(
                                        "Failed to emit interruption event for %s: %s", client_id[:8], emit_error
                                    )
                                    # Continue - don't let event emission block transcription
                        except Exception as tts_interrupt_error:
                            self._logger.error(
                                "TTS interruption failed for %s: %s", client_id[:8], tts_interrupt_error
                            )
                            # Continue - don't let TTS errors block transcription
                    
                    # Extract and transcribe each speech segment
                    for start, end in speech_segments:
                        start_sample = int(start * self.sample_rate)
                        end_sample = int(end * self.sample_rate)
                        
                        # Ensure indices are within bounds
                        if start_sample >= len(full_audio):
                            continue
                        
                        end_sample = min(end_sample, len(full_audio))
                        speech_audio = full_audio[start_sample:end_sample]
                        
                        # CRITICAL FIX: Run blocking STT in thread pool to avoid blocking audio pipeline
                        # Whisper inference is CPU-bound and blocks asyncio event loop
                        text = await asyncio.to_thread(
                            self.stt.transcribe, speech_audio, self.sample_rate
                        )
                        
                        if not text:
                            continue
                        
                        # GAP 1 FIX: Post-process transcript to strip wake word phrases (fallback cleanup)
                        # Even though GAP 3 prevents wake word audio from buffering, this ensures
                        # any leaked wake word phrases are removed from transcript
                        text_cleaned = self._strip_wake_word_phrases(text)
                        
                        if not text_cleaned or text_cleaned.strip() == "":
                            self._logger.debug(
                                f"Transcript only contained wake word: '{text}' → skipped"
                            )
                            continue
                        
                        # Update last activity timestamp - resets conversation timeout
                        # This enables continuous turn-taking without wake word
                        self.conversation_active[client_id] = time.time()
                        
                        # HIGH FIX: Isolate callback exceptions - don't let client errors kill pipeline
                        if self.on_transcript:
                            try:
                                self._logger.info(
                                    "Transcription: client=%s, text='%s'", client_id[:8], text_cleaned
                                )
                                await self.on_transcript(client_id, text_cleaned)
                                
                                # Sleep word detection: Check for "sleep" keyword (case-insensitive)
                                if "sleep" in text_cleaned.lower():
                                    self._logger.info(
                                        "Sleep word detected for %s, disabling handsfree", client_id[:8]
                                    )
                                    # Emit sleep word marker (frontend will disable handsfree)
                                    await self.on_transcript(client_id, "__SLEEP_WORD_DETECTED__")
                                
                                # MEDIUM FIX: Record successful ML operation for circuit breaker
                                self._record_ml_success(client_id)
                            except Exception as callback_error:  # noqa: BLE001 -- pipeline boundary: callback errors must not kill audio processing loop
                                self._logger.error(
                                    "Callback error for %s: %s", client_id[:8], callback_error,
                                    exc_info=True
                                )
                                # Continue processing - don't let callback failure stop pipeline
                    
                    # Clear buffer after processing
                    self.audio_buffers[client_id].clear()
                
            except asyncio.CancelledError:
                # Re-raise cancellation (don't catch this)
                raise
            except Exception as e:  # noqa: BLE001 -- audio processing loop boundary: must catch all to keep pipeline alive and feed circuit breaker
                # Only log if circuit breaker not already open (suppress spam)
                state = self._circuit_breaker_state.get(client_id, CircuitState.CLOSED)
                if state != CircuitState.OPEN:
                    self._logger.error("Audio chunk processing error for %s: %s", client_id[:8], e)

                # MEDIUM FIX: Record ML failure for circuit breaker
                self._record_ml_failure(client_id, e)
    
    async def reset_buffer(self, client_id: str) -> None:
        """
        Clear audio buffer for client (called on stream end).
        
        Acquires per-client lock to prevent race with concurrent process_chunk.
        
        Args:
            client_id: Client identifier
        """
        # RACE FIX: Acquire per-client lock — process_chunk holds this lock
        # while reading/writing the same dicts (audio_buffers, conversation_active).
        if client_id not in self._client_locks:
            self._client_locks[client_id] = asyncio.Lock()
        
        async with self._client_locks[client_id]:
            if client_id in self.audio_buffers:
                self.audio_buffers.pop(client_id, None)
                self._logger.debug("Buffer cleared for client %s", client_id[:8])
            
            # Reset conversation state
            if client_id in self.conversation_active:
                del self.conversation_active[client_id]
                self._logger.debug("Conversation reset for client %s", client_id[:8])
            
            # AUDIT FIX: Clean up wake word time tracking
            self.last_wake_word_time.pop(client_id, None)
            
            # CRITICAL FIX: Clear Redis state on reset
            if self._cache:
                await self._clear_conversation_state(client_id)
            
            # Reset wake word service for this client
            try:
                self.wake_word.reset(client_id)
            except Exception as e:
                self._logger.warning("Wake word reset failed for %s: %s", client_id[:8], e)
    
    async def cleanup_client(self, client_id: str) -> None:
        """
        AUDIT FIX: Complete cleanup for disconnected client (prevent memory leaks).
        
        Call this when client disconnects to release ALL resources.
        Acquires per-client lock to prevent race with concurrent process_chunk.
        
        Args:
            client_id: Client identifier
        """
        # RACE FIX: Acquire per-client lock before clearing state.
        # process_chunk holds this lock during pipeline execution — without acquiring
        # it here, cleanup can clear state mid-pipeline (e.g. buffers, conversation_active).
        if client_id not in self._client_locks:
            self._client_locks[client_id] = asyncio.Lock()
        
        async with self._client_locks[client_id]:
            # Clear buffers
            self.audio_buffers.pop(client_id, None)
            
            # Clear conversation state
            self.conversation_active.pop(client_id, None)
            self.last_wake_word_time.pop(client_id, None)
            
            # CRITICAL FIX: Clear state load tracking
            self._state_loaded.pop(client_id, None)
            
            # NOTE: client_llm_locks cleanup is handled by router.cleanup_client()
            # (presentation layer owns factory-level resources, not domain services)
            
            # Clear TTS coordinator service — independently guarded
            try:
                if self._tts_coordinator:
                    await self._tts_coordinator.cleanup_client(client_id)
            except Exception as e:
                self._logger.warning("TTS coordinator cleanup failed for %s: %s", client_id[:8], e)
            
            # MEDIUM FIX: Clear circuit breaker state
            self._circuit_breaker_failures.pop(client_id, None)
            self._circuit_breaker_opened_at.pop(client_id, None)
            self._circuit_breaker_state.pop(client_id, None)
            
            # CRITICAL FIX: Clear Redis state on disconnect — independently guarded
            try:
                if self._cache:
                    await self._clear_conversation_state(client_id)
            except Exception as e:
                self._logger.warning("Redis state cleanup failed for %s: %s", client_id[:8], e)
            
            # Cleanup wake word service — independently guarded
            try:
                self.wake_word.cleanup_client(client_id)
            except Exception as e:
                self._logger.warning("Wake word cleanup failed for %s: %s", client_id[:8], e)
            
            self._logger.info("Client %s fully cleaned up", client_id[:8])
        
        # Pop lock AFTER releasing it (outside async with block)
        self._client_locks.pop(client_id, None)
    
    def get_conversation_status(self, client_id: str) -> dict:
        """Get conversation status for client."""
        if client_id in self.conversation_active:
            elapsed = time.time() - self.conversation_active[client_id]
            return {
                "active": True,
                "elapsed": elapsed,
                "remaining": max(0, self.conversation_timeout - elapsed),
                "wake_word_stats": self.wake_word.get_stats(client_id),
            }
        return {
            "active": False,
            "awaiting_wake_word": True,
            "wake_word_stats": self.wake_word.get_stats(client_id),
        }
    
    async def _save_conversation_state(self, client_id: str) -> None:
        """
        WIRE FIX: Save conversation state to Redis for persistence.
        
        Args:
            client_id: Client identifier
        """
        if not self._cache:
            return
        
        try:
            key = f"{self._cache_namespace}:{client_id}"
            state = {
                "active": client_id in self.conversation_active,
                "last_activity": self.conversation_active.get(client_id, 0),
                "wake_word_time": self.last_wake_word_time.get(client_id, 0),
            }
            # TTL = 2x conversation timeout (grace period for reconnection)
            ttl = int(self.conversation_timeout * 2)
            await self._cache.set(key, state, ttl=ttl)
        except Exception as e:
            self._logger.warning("Failed to save conversation state for %s: %s", client_id[:8], e)
    
    async def _load_conversation_state(self, client_id: str) -> bool:
        """
        WIRE FIX: Load conversation state from Redis after reconnection.
        
        Args:
            client_id: Client identifier
            
        Returns:
            True if state was restored, False otherwise
        """
        if not self._cache:
            return False
        
        try:
            key = f"{self._cache_namespace}:{client_id}"
            state = await self._cache.get(key)
            
            if not state or not state.get("active"):
                return False
            
            # CRITICAL FIX: Validate timeout before restoring state
            wake_word_time = state.get("wake_word_time", 0)
            elapsed = time.time() - wake_word_time
            
            if elapsed >= self.conversation_timeout:
                # State expired - don't restore
                self._logger.debug(
                    f"Conversation state for {client_id[:8]} expired "
                    f"(elapsed={elapsed:.1f}s > timeout={self.conversation_timeout}s)"
                )
                # Clear stale Redis state
                await self._clear_conversation_state(client_id)
                return False
            
            # Restore valid state
            self.conversation_active[client_id] = state.get("last_activity", time.time())
            self.last_wake_word_time[client_id] = wake_word_time
            
            self._logger.info(
                f"Conversation state restored for {client_id[:8]} "
                f"({self.conversation_timeout - elapsed:.1f}s remaining)"
            )
            return True
        except Exception as e:
            self._logger.warning("Failed to load conversation state for %s: %s", client_id[:8], e)
            return False
    
    async def _clear_conversation_state(self, client_id: str) -> None:
        """
        WIRE FIX: Clear conversation state from Redis.
        
        Args:
            client_id: Client identifier
        """
        if not self._cache:
            return
        
        try:
            key = f"{self._cache_namespace}:{client_id}"
            await self._cache.delete(key)
        except Exception as e:
            self._logger.warning("Failed to clear conversation state for %s: %s", client_id[:8], e)
    
    def cleanup(self) -> None:
        """
        CRITICAL FIX: Release all ML model resources on server shutdown.
        
        Calls cleanup() on all ML services (VAD, STT, WakeWord) to release GPU/CPU memory.
        """
        try:
            self._logger.info("AudioProcessingService shutting down...")
            
            # Cleanup VAD
            if hasattr(self, 'vad') and hasattr(self.vad, 'cleanup'):
                self.vad.cleanup()
            
            # Cleanup STT
            if hasattr(self, 'stt') and hasattr(self.stt, 'cleanup'):
                self.stt.cleanup()
            
            # Cleanup Wake Word
            if hasattr(self, 'wake_word') and hasattr(self.wake_word, 'cleanup'):
                self.wake_word.cleanup()
            
            # Cleanup Opus decoder (no ML models, but clear references)
            if hasattr(self, 'decoder'):
                del self.decoder
                self.decoder = None
            
            self._logger.info("AudioProcessingService shutdown complete")
        except Exception as e:
            self._logger.error("AudioProcessingService cleanup failed: %s", e)

