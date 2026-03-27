"""
@.architecture
Incoming: message_handler._wrap_with_tts (sentence text) --- {str, sentence chunks}
Processing: Dual-queue TTS architecture (Kokoro pattern) --- {4 jobs: JOB_QUEUE_SENTENCE, JOB_GENERATE_AUDIO, JOB_QUEUE_AUDIO, JOB_MONITOR_CAPACITY}
Outgoing: audio_queue (base64 audio data) --- {bytes, base64 encoded PCM}

TTSGenerationService - Async dual-queue architecture for TTS generation.

Adapted from Kokoro-Conversational/src/utils/audio_queue.py pattern:
- sentence_queue: Input queue for text chunks (maxsize=100, configurable via audio_config.py)
- audio_queue: Output queue for generated audio (maxsize=200, 2x sentence queue)
- generation_task: Background asyncio task (not thread - we're async)
- _generation_worker(): Pulls sentences, synthesizes audio (60s timeout), queues output
- Capacity monitoring: Logs queue sizes when >50% full (every 10s)

Key Differences from Kokoro:
1. asyncio.Queue instead of threading.Queue (async architecture)
2. Bounded queues (100/200) vs unlimited (prevents memory exhaustion in multi-client SaaS)
3. asyncio.Task instead of threading.Thread (async worker)
4. asyncio.to_thread() for CPU-bound TTS synthesis (60s timeout protection)
5. Per-client lifecycle management (multi-client support + interruption handling)
6. Queue monitoring + overflow detection (emit errors to frontend on QueueFull)

Critical Fixes Applied:
- Queue sizes: 10→100 (sentence), 20→200 (audio) - handles 99% of GPT-4 responses
- Timeout: 60s max per synthesis (prevents infinite hangs on model crashes)
- Monitoring: Log queue capacity if >50% full (early warning system)
- Interruption: clear_queues() method discards pending audio on user speech
"""

import asyncio
import logging
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


class TTSGenerationService:
    """
    Async dual-queue TTS generation service (Kokoro pattern adapted for async).
    
    Separates text chunking from audio generation from audio transmission.
    Enables true parallelization without blocking the message handler.
    
    Architecture:
        sentence_queue → generation_worker → audio_queue → transmission
        (non-blocking)   (asyncio.Task)     (decoupled)    (websocket)
    """
    
    def __init__(self, tts_integration, tts_config, client_id: str):
        """
        Initialize TTS generation service for a single client.
        
        Args:
            tts_integration: RealtimeTTSIntegration instance
            tts_config: TtsConfig with voice/speed settings
            client_id: Client identifier for logging
        """
        self.tts_integration = tts_integration
        self.tts_config = tts_config
        self.client_id = client_id
        
        # Dual queue architecture (Kokoro pattern) - sizes from central config
        self.sentence_queue = asyncio.Queue(maxsize=self.tts_config.sentence_queue_maxsize)
        self.audio_queue = asyncio.Queue(maxsize=self.tts_config.audio_queue_maxsize)
        
        # Worker task
        self.is_running = False
        self.generation_task: Optional[asyncio.Task] = None
        self._worker_idle = True  # CRITICAL: Track worker idle vs processing state
        
        # State changed event for consumer wakeups
        self.state_changed = asyncio.Event()
        
        # Statistics
        self.sentences_processed = 0
        self.audio_generated = 0
        self.failed_sentences = []
        
        # MEDIUM FIX: Queue size monitoring (log when >50% full)
        self._last_queue_log_time = 0
        self._queue_log_interval = 10.0  # Log every 10s max
        
        logger.info("TTSGenerationService created: %s (sentence_q=%d, audio_q=%d)", client_id[:8], self.tts_config.sentence_queue_maxsize, self.tts_config.audio_queue_maxsize)
    
    async def start(self):
        """Start the generation worker task."""
        if not self.is_running:
            self.is_running = True
            self.generation_task = asyncio.create_task(self._generation_worker())
            logger.info("TTS generation worker started: %s", self.client_id[:8])
    
    async def stop(self):
        """Stop the generation worker gracefully."""
        if self.generation_task:
            # Wait for queues to drain
            while not self.sentence_queue.empty():
                await asyncio.sleep(0.1)
            
            # Give worker 500ms to finish current sentence
            await asyncio.sleep(0.5)
            
            # Stop worker
            self.is_running = False
            
            # Cancel task if still running
            if not self.generation_task.done():
                self.generation_task.cancel()
                try:
                    await self.generation_task
                except asyncio.CancelledError:
                    pass
            
            self.generation_task = None
            
            logger.info("TTS generation complete: %s - Processed: %d, Generated: %d, Failed: %d", self.client_id[:8], self.sentences_processed, self.audio_generated, len(self.failed_sentences))
    
    async def add_sentence(self, sentence: str):
        """
        Add sentence to generation queue (non-blocking with FAIL_FAST).
        
        Args:
            sentence: Text to synthesize
            
        Raises:
            asyncio.QueueFull: If queue is full (FAIL_FAST)
        """
        sentence = sentence.strip()
        if not sentence:
            return
        
        try:
            # FAIL_FAST: put_nowait raises QueueFull if maxsize reached
            self.sentence_queue.put_nowait(sentence)
            logger.debug("Queued sentence: %s -> '%s...'", self.client_id[:8], sentence[:50])
        except asyncio.QueueFull:
            logger.error("TTS sentence queue full: %s, dropping: '%s...'", self.client_id[:8], sentence[:50])
            raise
    
    async def get_next_audio(self) -> Optional[Tuple[bytes, str]]:
        """
        Get next generated audio from queue (non-blocking).
        
        Returns:
            (audio_data, sentence) or None if queue empty
        """
        try:
            item = self.audio_queue.get_nowait()
            if self.audio_queue.empty():
                self.state_changed.clear()
            return item
        except asyncio.QueueEmpty:
            self.state_changed.clear()
            return None
            
    async def wait_for_state_change(self, timeout: Optional[float] = None) -> None:
        """Wait for state change (new audio, worker idle, etc)."""
        try:
            if timeout:
                await asyncio.wait_for(self.state_changed.wait(), timeout=timeout)
            else:
                await self.state_changed.wait()
        except asyncio.TimeoutError:
            pass
            
    def trigger_state_change(self) -> None:
        """Manually trigger state change event (e.g. from producer when stream ends)."""
        self.state_changed.set()
    
    def is_generation_complete(self) -> bool:
        """
        Check if ALL generation is complete.
        
        CRITICAL FIX: Uses _worker_idle flag instead of is_running/task.done().
        
        Previous logic checked `not self.is_running or self.generation_task.done()`,
        but the worker stays running (waiting for new sentences) even after all work
        is done. This caused a deadlock: consumer waited for is_generation_complete()
        which waited for worker to stop, but stop() is only called after consumer exits.
        
        New logic: Worker sets _worker_idle=True when waiting for new sentence,
        _worker_idle=False when actively processing. Combined with empty queues,
        this accurately detects "all current work is complete" without requiring
        the worker to terminate.
        
        Returns:
            True if sentence queue empty, audio queue empty, and worker idle
        """
        return (
            self.sentence_queue.empty() and 
            self.audio_queue.empty() and 
            self._worker_idle
        )
    
    async def _generation_worker(self):
        """
        Background worker task - generates TTS audio from sentence queue.
        
        Adapted from Kokoro-Conversational audio_queue.py _generation_worker.
        Key difference: Uses asyncio.to_thread() instead of blocking call.
        """
        import time
        logger.info("TTS generation worker running: %s", self.client_id[:8])
        
        while self.is_running or not self.sentence_queue.empty():
            # MEDIUM FIX: Periodic queue size monitoring (every 10s if >50% full)
            current_time = time.time()
            if current_time - self._last_queue_log_time >= self._queue_log_interval:
                self._last_queue_log_time = current_time
                sentence_size = self.sentence_queue.qsize()
                audio_size = self.audio_queue.qsize()
                sentence_pct = (sentence_size / self.tts_config.sentence_queue_maxsize) * 100
                audio_pct = (audio_size / self.tts_config.audio_queue_maxsize) * 100
                
                if sentence_pct > 50 or audio_pct > 50:
                    logger.warning(
                        "TTS Queue capacity: client=%s, sentence=%d/%d (%.0f%%), audio=%d/%d (%.0f%%)",
                        self.client_id[:8], sentence_size, self.tts_config.sentence_queue_maxsize, sentence_pct,
                        audio_size, self.tts_config.audio_queue_maxsize, audio_pct,
                    )
            
            try:
                # CRITICAL FIX: Mark worker as idle while waiting for sentence.
                # Consumer uses _worker_idle + empty queues to detect completion
                # without requiring the worker to stop (prevents deadlock).
                if not self._worker_idle:
                    self._worker_idle = True
                    self.state_changed.set()
                
                # Get sentence from queue (with timeout to check is_running)
                try:
                    sentence = await asyncio.wait_for(
                        self.sentence_queue.get(),
                        timeout=0.1
                    )
                    self._worker_idle = False  # Processing sentence
                    self.state_changed.set()
                    self.sentences_processed += 1
                except asyncio.TimeoutError:
                    if not self.is_running and self.sentence_queue.empty():
                        break
                    continue
                
                # Generate audio (CPU-bound - run in thread with 60s timeout)
                try:
                    # CRITICAL FIX: Add 60s timeout to prevent infinite hangs
                    # If model crashes/hangs, fail fast and continue to next sentence
                    audio_data = await asyncio.wait_for(
                        asyncio.to_thread(
                            self.tts_integration.synthesize_text,
                            sentence
                        ),
                        timeout=60.0
                    )
                    
                    if not audio_data or len(audio_data) == 0:
                        raise ValueError("Generated audio data is empty")
                    
                    self.audio_generated += 1
                    
                    # Put in audio queue (blocking - wait for space if full)
                    await self.audio_queue.put((audio_data, sentence))
                    self.state_changed.set()
                    
                    logger.debug("TTS generated: %s -> %d bytes", self.client_id[:8], len(audio_data))
                    
                except asyncio.TimeoutError:
                    # TTS synthesis exceeded 60s timeout (model hung)
                    logger.error("TTS synthesis timeout (>60s): '%s...' [client=%s]", sentence[:50], self.client_id[:8])
                    self.failed_sentences.append((sentence, "timeout"))
                    continue
                
                except Exception as e:
                    error_msg = str(e)
                    logger.error("TTS generation failed: %s -> %s", self.client_id[:8], error_msg)
                    self.failed_sentences.append((sentence, error_msg))
                    continue
                
            except Exception as e:  # noqa: BLE001 -- worker loop boundary: must keep running to drain sentence queue
                if not self.is_running and self.sentence_queue.empty():
                    break
                logger.error("Worker error: %s -> %s", self.client_id[:8], e)
                await asyncio.sleep(0.1)
        
        # CRITICAL: Set flags when worker exits naturally
        self._worker_idle = True
        self.is_running = False
        logger.info("TTS generation worker stopped: %s", self.client_id[:8])
    
    async def clear_queues(self):
        """Clear both queues (for interruption handling)."""
        sentences_cleared = 0
        audio_cleared = 0
        
        while not self.sentence_queue.empty():
            try:
                self.sentence_queue.get_nowait()
                sentences_cleared += 1
            except asyncio.QueueEmpty:
                break
        
        while not self.audio_queue.empty():
            try:
                self.audio_queue.get_nowait()
                audio_cleared += 1
            except asyncio.QueueEmpty:
                break
        
        if sentences_cleared > 0 or audio_cleared > 0:
            logger.info("Cleared queues: %s - %d sentences, %d audio chunks", self.client_id[:8], sentences_cleared, audio_cleared)
