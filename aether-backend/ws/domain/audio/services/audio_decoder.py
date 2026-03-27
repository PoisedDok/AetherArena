"""
Incoming: AudioProcessingService --- {str (Base64 PCM16 or container format)}
Processing: Base64 decode, format detection, PCM conversion, numpy conversion --- {3 jobs: JOB_DECODE_BASE64, JOB_CONVERT_PCM16, JOB_DECODE_CONTAINER}
Outgoing: AudioProcessingService --- {np.ndarray (PCM float32)}

OpusDecoder - Decode Base64 audio to PCM numpy array

PRODUCTION ARCHITECTURE:
- Primary: Raw PCM16 from frontend (ScriptProcessorNode, already resampled to 16kHz)
- Fallback: Container formats (WAV/WebM) via pydub/ffmpeg for legacy compatibility

Raw PCM16 path: Base64 → Int16 → Float32 → Normalize (no ffmpeg, instant)
Container path: Base64 → pydub AudioSegment → resample → PCM (slower, uses ffmpeg)

Frontend sends pre-resampled 16kHz PCM16, so no backend resampling needed.
"""

import base64
import io
import numpy as np
from pydub import AudioSegment
import logging

logger = logging.getLogger(__name__)


class OpusDecoder:
    """Decode Base64 audio (WAV/Opus) to PCM numpy array."""
    
    def __init__(self, target_sr: int = 16000, max_chunk_size_mb: int = 10):
        """
        Initialize audio decoder.
        
        Args:
            target_sr: Target sample rate in Hz (from config)
            max_chunk_size_mb: Maximum Base64 chunk size in MB (DoS protection, from config)
        """
        self.target_sr = target_sr
        self.max_chunk_size_bytes = max_chunk_size_mb * 1024 * 1024
        self._logger = logger
    
    def decode(self, base64_opus: str, format_hint: str = None) -> np.ndarray:
        """
        Decode Base64 audio to PCM numpy array.
        
        Args:
            base64_opus: Base64-encoded audio data
            format_hint: Optional format hint ('pcm16', 'wav', 'webm')
            
        Returns:
            PCM audio as numpy array (mono, float32, normalized to [-1, 1])
            
        Raises:
            ValueError: If decoding fails or payload exceeds max size
        """
        # LOW FIX: Validate max chunk size using config (DoS protection)
        if len(base64_opus) > self.max_chunk_size_bytes:
            raise ValueError(
                f"Base64 payload exceeds max size: {len(base64_opus)} > {self.max_chunk_size_bytes} bytes"
            )
        
        try:
            # Decode Base64
            audio_bytes = base64.b64decode(base64_opus)
            
            # ARCHITECTURAL FIX: Handle raw PCM16 directly (from AudioWorklet)
            if format_hint == 'pcm16':
                # Raw PCM16 - convert directly to numpy
                pcm_array = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32)
                pcm_array = pcm_array / 32768.0  # Normalize to [-1, 1]
                
                # PCM16 decoded successfully (no logging to reduce spam)
                
                return pcm_array
            
            # Fallback: Try to decode as container format (WAV/WebM) using pydub
            # DEBUG: Log first few bytes to verify format
            if len(audio_bytes) >= 4:
                header_hex = audio_bytes[:4].hex()
                # WAV: 52 49 46 46 (RIFF)
                # WebM: 1a 45 df a3
                format_detected = "WAV" if header_hex.startswith("52494646") else "WebM" if header_hex.startswith("1a45dfa3") else "Unknown"
                self._logger.debug(
                    f"Audio chunk: {len(audio_bytes)} bytes, header: 0x{header_hex} ({format_detected})"
                )
            
            # Decode using pydub (unreliable for incomplete chunks)
            audio_segment = AudioSegment.from_file(
                io.BytesIO(audio_bytes),
                format="wav"  # Assume WAV if no format hint
            )
            
            # Convert to mono if stereo
            if audio_segment.channels > 1:
                audio_segment = audio_segment.set_channels(1)
            
            # Resample to target sample rate
            if audio_segment.frame_rate != self.target_sr:
                audio_segment = audio_segment.set_frame_rate(self.target_sr)
            
            # Export to raw PCM
            pcm_bytes = audio_segment.raw_data
            
            # Convert to numpy array (int16 → float32, normalize)
            pcm_array = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
            pcm_array = pcm_array / 32768.0  # Normalize to [-1, 1]
            
            self._logger.debug(
                f"Decoded audio: {len(audio_bytes)} bytes → "
                f"{len(pcm_array)} samples @ {self.target_sr}Hz"
            )
            
            return pcm_array
            
        except Exception as e:
            self._logger.error("Audio decoding failed: %s", e)
            raise ValueError("Failed to decode audio") from e
