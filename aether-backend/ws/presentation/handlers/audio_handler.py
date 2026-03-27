"""
@.architecture
Incoming: presentation/router --- {str, Message objects, primitives}
Processing: audio control delegation, audio chunk processing --- {3 jobs: JOB_ROUTE, JOB_DELEGATE, JOB_PROCESS_AUDIO}
Outgoing: runtime, audio_processor --- {str, primitives}

Audio Handler - Audio stream control and processing

Presentation layer handler for audio messages.
Handles audio stream control (start/end) and audio chunk processing.

Handles:
- audio stream start/end
- audio chunk processing (Base64 Opus → STT)
"""

import asyncio
from typing import Any, Optional
import logging

logger = logging.getLogger(__name__)


class AudioHandler:
    """
    Audio control and processing handler.
    
    Delegates audio stream control to runtime and chunk processing to audio_processor.
    """
    
    def __init__(
        self,
        *,
        runtime: Any,
        cache_service: Any,
        audio_processor: Optional[Any] = None,
        tts_coordinator: Optional[Any] = None,
    ):
        """
        Initialize audio handler.
        
        Args:
            runtime: RuntimeEngine instance
            cache_service: Cache service for presence updates
            audio_processor: AudioProcessingService instance (optional)
            tts_coordinator: TTSCoordinator for handsfree TTS control (optional)
        """
        self._runtime = runtime
        self._cache = cache_service
        self._audio_processor = audio_processor
        self._tts_coordinator = tts_coordinator
        self._logger = logger
    
    async def handle_audio_control(
        self,
        *,
        client_id: str,
        message: Any,
    ) -> None:
        """
        Handle audio control message.
        
        Args:
            client_id: Client identifier
            message: Audio control message object
        """
        try:
            state = "audio_start" if message.start else "audio_end" if message.end else "audio_control"
            
            await self._cache.update_presence_metadata(
                client_id,
                last_event=state,
            )
            
            if message.start:
                await self._runtime.start_audio_stream(client_id=client_id)
            elif message.end:
                await self._runtime.end_audio_stream(client_id=client_id)
        
        except Exception as e:
            self._logger.warning("Audio control error: %s", e)
    
    async def handle_audio_chunk(
        self,
        *,
        client_id: str,
        message: Any,
    ) -> None:
        """
        Handle audio chunk message (handsfree mode).
        
        Args:
            client_id: Client identifier
            message: AudioMessage object with base64 Opus audio
        """
        try:
            # Check for end marker
            if message.end:
                if self._audio_processor:
                    # CRITICAL FIX: reset_buffer is now async (calls Redis clear)
                    await self._audio_processor.reset_buffer(client_id)
                self._logger.debug("Audio stream ended: %s", client_id[:8])
                return
            
            # Process audio chunk
            if message.audio and self._audio_processor:
                format_hint = message.format if hasattr(message, 'format') else None
                await self._audio_processor.process_chunk(
                    base64_opus=message.audio,
                    client_id=client_id,
                    format_hint=format_hint,
                )
            elif not self._audio_processor:
                self._logger.warning("Audio chunk received but audio_processor not initialized")
        
        except Exception as e:
            self._logger.warning("Audio chunk error: %s", e)
    
    async def handle_cancel_tts(
        self,
        *,
        client_id: str,
    ) -> None:
        """
        Handle cancel-tts command from frontend.
        
        User interrupted TTS playback (spoke during SPEAKING state).
        Cancel ongoing TTS generation immediately.
        
        Args:
            client_id: Client identifier
        """
        try:
            if not self._tts_coordinator:
                self._logger.warning("cancel-tts received but tts_coordinator not initialized: %s", client_id[:8])
                return
            
            # Clear TTS queues (discard pending audio)
            await self._tts_coordinator.clear_queues(client_id)
            self._logger.info("TTS cancelled by frontend request: %s", client_id[:8])
            
        except Exception as e:
            self._logger.error("Cancel TTS error for %s: %s", client_id[:8], e)

