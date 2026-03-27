"""
Incoming: AudioProcessingService --- {np.ndarray (PCM float32), int (sample_rate)}
Processing: Speech-to-Text using Whisper (transformers), auto device detection --- {3 jobs: JOB_INITIALIZE_STT, JOB_PROCESS_AUDIO, JOB_DECODE_TEXT}
Outgoing: AudioProcessingService --- {str (transcribed text)}

WhisperSttService - Speech-to-Text using Whisper

Transcribes speech audio to text using OpenAI Whisper model via transformers.
Supports auto device detection (cuda → mps → cpu) for optimal performance.

Ported from Kokoro-Conversational/src/utils/speech.py lines 289-316.
"""

import torch
import numpy as np
from transformers import WhisperProcessor, WhisperForConditionalGeneration
from typing import Optional
import logging

logger = logging.getLogger(__name__)

# MEDIUM FIX: Wire metrics for STT transcriptions
try:
    from monitoring.metrics import get_metrics_registry
    METRICS_AVAILABLE = True
except ImportError:
    METRICS_AVAILABLE = False
    get_metrics_registry = None


class WhisperSttService:
    """Speech-to-Text using Whisper (transformers)."""
    
    def __init__(
        self,
        model_id: str = "openai/whisper-small",
        device: Optional[str] = None,
    ):
        """
        Initialize STT service with device auto-detection.
        
        Args:
            model_id: HuggingFace Whisper model ID (default: whisper-small for balance of speed/accuracy)
            device: Device override ('cuda', 'mps', 'cpu') or None for auto-detect
        """
        # Auto-detect device (cuda → mps → cpu)
        if device is None:
            if torch.cuda.is_available():
                device = "cuda"
                logger.info("STT using CUDA")
            elif torch.backends.mps.is_available():
                device = "mps"
                logger.info("STT using MPS (Apple Silicon)")
            else:
                device = "cpu"
                logger.info("STT using CPU")
        
        self.device = device
        self._logger = logger
        
        # MEDIUM FIX: Initialize metrics counter
        if METRICS_AVAILABLE:
            try:
                registry = get_metrics_registry()
                self._stt_transcriptions_counter = registry.counter(
                    "stt_transcriptions_total",
                    "Total number of STT transcriptions completed",
                    labels=["model", "device"]
                )
            except (AttributeError, TypeError, ImportError):
                self._stt_transcriptions_counter = None
        else:
            self._stt_transcriptions_counter = None

        # Load Whisper model and processor from HuggingFace cache
        # Models are downloaded via onboarding flow to ~/.cache/huggingface/hub/
        try:
            self._logger.info("Loading Whisper model from HF cache: %s", model_id)
            self.processor = WhisperProcessor.from_pretrained(model_id)
            self.model = WhisperForConditionalGeneration.from_pretrained(model_id)
            self.model = self.model.to(device)
            self.model.eval()
            
            self._logger.info("STT initialized: model=%s, device=%s", model_id, device)
            
        except Exception as e:
            self._logger.error("STT initialization failed: %s", e)
            raise RuntimeError("Failed to initialize STT service") from e
    
    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000) -> str:
        """
        Transcribe audio to text.
        
        Args:
            audio: PCM audio array (mono, float32, normalized)
            sample_rate: Audio sample rate in Hz (default 16000)
            
        Returns:
            Transcribed text
        """
        if audio is None or len(audio) == 0:
            return ""
        
        try:
            # Process audio
            input_features = self.processor(
                audio,
                sampling_rate=sample_rate,
                return_tensors="pt"
            ).input_features
            
            input_features = input_features.to(self.device)
            
            # Generate transcription
            with torch.no_grad():
                predicted_ids = self.model.generate(input_features)
            
            # Decode
            transcription = self.processor.batch_decode(
                predicted_ids,
                skip_special_tokens=True
            )
            
            text = transcription[0].strip()
            
            if text:
                self._logger.info("STT transcribed: %d samples -> '%s'", len(audio), text)
                
                # MEDIUM FIX: Increment metrics counter
                if self._stt_transcriptions_counter:
                    try:
                        self._stt_transcriptions_counter.inc(model=self.model.name_or_path, device=self.device)
                    except (AttributeError, TypeError, RuntimeError):
                        pass  # Don't fail STT on metrics error
            
            return text
            
        except Exception as e:
            self._logger.error("STT transcription failed: %s", e)
            return ""
    
    def cleanup(self) -> None:
        """
        CRITICAL FIX: Release ML model resources (GPU/CPU memory).
        
        Call this on server shutdown to prevent memory leaks.
        """
        try:
            if hasattr(self, 'model') and self.model is not None:
                # Move model to CPU and delete to release GPU memory
                self.model.to('cpu')
                del self.model
                self.model = None
                self._logger.info("STT model cleaned up (GPU/CPU memory released)")
            
            if hasattr(self, 'processor') and self.processor is not None:
                del self.processor
                self.processor = None
        except Exception as e:
            self._logger.warning("STT cleanup failed: %s", e)

