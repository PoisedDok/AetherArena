"""
Audio domain module for handsfree voice mode.

Provides VAD (Voice Activity Detection) and STT (Speech-to-Text) services
for processing audio chunks from WebSocket clients.
"""

from .services.audio_decoder import OpusDecoder
from .services.vad_service import PyannotVadService
from .services.stt_service import WhisperSttService
from .services.audio_processor import AudioProcessingService

__all__ = [
    "OpusDecoder",
    "PyannotVadService",
    "WhisperSttService",
    "AudioProcessingService",
]
