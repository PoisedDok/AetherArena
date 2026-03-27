"""
@.architecture
Incoming: message_handler._wrap_with_tts, audio_processor (client_id, sentence text) --- {str, sentence chunks}
Processing: Per-client TTS service lifecycle + interruption --- {5 jobs: JOB_CREATE_SERVICE, JOB_START_WORKER, JOB_ROUTE_SENTENCE, JOB_CLEAR_QUEUES, JOB_CLEANUP}
Outgoing: TTSGenerationService instances, audio queue access --- {TTSGenerationService, audio data}

TTSCoordinator - Per-client TTS generation service management.

Follows AudioProcessingService pattern:
- Manages per-client TTSGenerationService instances
- Lifecycle: create on first use, cleanup on disconnect
- FAIL_FAST: No fallbacks, explicit error propagation
- Central config: All settings from tts_config parameter

Key Methods:
- add_sentence(): Queue sentence for TTS generation (per-client routing)
- get_next_audio(): Retrieve generated audio (consumer pattern)
- clear_queues(): Discard pending audio on interruption (user spoke during TTS)
- stop_service(): Stop worker + cleanup resources (per-client lifecycle)
- is_generation_complete(): Check if all queues empty + worker idle (consumer wait condition)

Interruption Handling:
- audio_processor calls clear_queues() when user speaks during TTS playback
- Discards both sentence_queue (not yet generated) and audio_queue (not yet sent)
- Enables natural turn-taking: user interrupts agent, queues clear, new response starts
"""

import asyncio
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


class TTSCoordinator:
    """
    Coordinates per-client TTS generation services.
    
    Follows AudioProcessingService pattern for consistency.
    Each client gets an independent TTSGenerationService with dual queues.
    """
    
    def __init__(self, tts_integration: Any, tts_config: Any):
        """
        Initialize TTS coordinator.
        
        Args:
            tts_integration: RealtimeTTSIntegration singleton
            tts_config: TtsConfig from audio_config.py (central config)
        """
        if not tts_integration or not tts_integration.is_available():
            raise ValueError("TTS integration not available or not initialized")
        
        self.tts_integration = tts_integration
        self.tts_config = tts_config
        
        # Per-client services
        self._client_services: Dict[str, Any] = {}  # client_id -> TTSGenerationService
        
        # Per-client locks (prevent race conditions during service creation)
        self._client_locks: Dict[str, asyncio.Lock] = {}
        
        logger.info("TTSCoordinator initialized: engine=%s, voice=%s", tts_config.engine, tts_config.voice)
    
    async def get_or_create_service(self, client_id: str):
        """
        Get existing TTS service for client or create new one.
        
        Thread-safe: Uses per-client lock to prevent race conditions.
        FAIL_FAST: Raises on service creation failure.
        
        Args:
            client_id: Client identifier
            
        Returns:
            TTSGenerationService instance
            
        Raises:
            Exception: If service creation fails
        """
        # Fast path: service already exists
        if client_id in self._client_services:
            return self._client_services[client_id]
        
        # Get or create lock for this client
        lock = self._client_locks.setdefault(client_id, asyncio.Lock())
        
        async with lock:
            # Double-check (another task might have created it)
            if client_id in self._client_services:
                return self._client_services[client_id]
            
            # Create new service
            try:
                from .tts_generation_service import TTSGenerationService
                
                service = TTSGenerationService(
                    tts_integration=self.tts_integration,
                    tts_config=self.tts_config,
                    client_id=client_id
                )
                
                # Start worker task
                await service.start()
                
                # Store service
                self._client_services[client_id] = service
                
                logger.info("TTS service created and started: %s", client_id[:8])
                return service
                
            except Exception as e:
                logger.error("Failed to create TTS service for %s: %s", client_id[:8], e)
                raise  # FAIL_FAST
    
    async def add_sentence(self, client_id: str, sentence: str):
        """
        Add sentence to client's TTS queue.
        
        Creates service if doesn't exist.
        FAIL_FAST: Propagates queue full errors.
        
        Args:
            client_id: Client identifier
            sentence: Text to synthesize
            
        Raises:
            asyncio.QueueFull: If sentence queue is full
            Exception: If service creation fails
        """
        service = await self.get_or_create_service(client_id)
        await service.add_sentence(sentence)
    
    async def get_next_audio(self, client_id: str):
        """
        Get next audio chunk from client's audio queue.
        
        Args:
            client_id: Client identifier
            
        Returns:
            (audio_data, sentence) or None if no service or queue empty
        """
        service = self._client_services.get(client_id)
        if not service:
            return None
        return await service.get_next_audio()
    
    def is_generation_complete(self, client_id: str) -> bool:
        """
        Check if client's TTS generation is complete.
        
        Args:
            client_id: Client identifier
            
        Returns:
            True if no service or all generation complete
        """
        service = self._client_services.get(client_id)
        if not service:
            return True
        return service.is_generation_complete()
        
    async def wait_for_state_change(self, client_id: str, timeout: Optional[float] = None) -> None:
        """
        Wait for a state change in the client's TTS service (new audio, idle state).
        
        Args:
            client_id: Client identifier
            timeout: Optional timeout in seconds
        """
        service = self._client_services.get(client_id)
        if service:
            await service.wait_for_state_change(timeout=timeout)
            
    def trigger_state_change(self, client_id: str) -> None:
        """
        Manually trigger a state change event for the client's TTS service.
        
        Args:
            client_id: Client identifier
        """
        service = self._client_services.get(client_id)
        if service:
            service.trigger_state_change()
    
    async def clear_queues(self, client_id: str):
        """
        Clear both queues for client (for interruption handling).
        
        Args:
            client_id: Client identifier
        """
        service = self._client_services.get(client_id)
        if service:
            await service.clear_queues()
            logger.info("TTS queues cleared for %s", client_id[:8])
    
    async def stop_service(self, client_id: str):
        """
        Stop TTS service for client (end of response).
        
        Gracefully stops worker, waits for queues to drain.
        Does NOT remove service from cache (reuse for next message).
        
        Args:
            client_id: Client identifier
        """
        service = self._client_services.get(client_id)
        if service:
            await service.stop()
            logger.debug("TTS service stopped: %s", client_id[:8])
    
    async def cleanup_client(self, client_id: str):
        """
        Complete cleanup for disconnected client.
        
        Called from AudioProcessingService.cleanup_client() or WebSocketHub disconnect.
        Stops service, clears queues, removes from cache.
        
        Args:
            client_id: Client identifier
        """
        service = self._client_services.pop(client_id, None)
        try:
            if service:
                await service.stop()
                logger.info("TTS service cleaned up: %s", client_id[:8])
        except Exception as e:
            # Log but do NOT re-raise: disconnect cleanup must not break caller's
            # cleanup chain (audio_processor clears circuit breaker, Redis, wake word after this)
            logger.error("Error stopping TTS service for %s: %s", client_id[:8], e)
        finally:
            # Lock cleanup ALWAYS runs, even if stop() fails
            self._client_locks.pop(client_id, None)
    
    def get_service_stats(self, client_id: str) -> dict:
        """
        Get statistics for client's TTS service.
        
        Args:
            client_id: Client identifier
            
        Returns:
            Dict with sentences_processed, audio_generated, failed_sentences
            or empty dict if no service
        """
        service = self._client_services.get(client_id)
        if not service:
            return {}
        
        return {
            'sentences_processed': service.sentences_processed,
            'audio_generated': service.audio_generated,
            'failed_sentences': len(service.failed_sentences),
            'sentence_queue_size': service.sentence_queue.qsize(),
            'audio_queue_size': service.audio_queue.qsize(),
        }
