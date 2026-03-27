"""
Incoming: AudioProcessingService --- {np.ndarray (PCM float32), int (sample_rate)}
Processing: Voice Activity Detection using pyannote.audio, auto device detection --- {3 jobs: JOB_INITIALIZE_VAD, JOB_DETECT_SPEECH, JOB_EXTRACT_SEGMENTS}
Outgoing: AudioProcessingService --- {List[Tuple[float, float]] (start, end times in seconds)}

PyannotVadService - Voice Activity Detection using pyannote.audio

Detects speech segments in audio using pyannote/segmentation-3.0 model.
Supports auto device detection (cuda → mps → cpu) for optimal performance.

Ported from Kokoro-Conversational/src/utils/speech.py lines 19-81.
"""

import torch
import numpy as np
from pyannote.audio import Model
from pyannote.audio.pipelines import VoiceActivityDetection
from typing import List, Tuple, Optional
import logging

logger = logging.getLogger(__name__)

# MEDIUM FIX: Wire metrics for VAD segments
try:
    from monitoring.metrics import get_metrics_registry
    METRICS_AVAILABLE = True
except ImportError:
    METRICS_AVAILABLE = False
    get_metrics_registry = None


class PyannotVadService:
    """Voice Activity Detection using pyannote.audio."""
    
    def __init__(
        self,
        model_id: str = "pyannote/segmentation-3.0",
        device: Optional[str] = None,
        hf_token: Optional[str] = None,
        min_duration_on: float = 0.25,
        min_duration_off: float = 0.25,
    ):
        """
        Initialize VAD service with device auto-detection.
        
        Args:
            model_id: HuggingFace model ID
            device: Device override ('cuda', 'mps', 'cpu') or None for auto-detect
            hf_token: HuggingFace token for model download
            min_duration_on: Minimum speech duration in seconds
            min_duration_off: Minimum silence duration in seconds
        """
        # Auto-detect device (cuda → mps → cpu)
        if device is None:
            if torch.cuda.is_available():
                device = "cuda"
                logger.info("VAD using CUDA")
            elif torch.backends.mps.is_available():
                device = "mps"
                logger.info("VAD using MPS (Apple Silicon)")
            else:
                device = "cpu"
                logger.info("VAD using CPU")
        
        self.device = device
        self._logger = logger
        
        # MEDIUM FIX: Initialize metrics counter
        if METRICS_AVAILABLE:
            try:
                registry = get_metrics_registry()
                self._vad_segments_counter = registry.counter(
                    "vad_speech_segments_total",
                    "Total number of speech segments detected by VAD",
                    labels=["device"]
                )
            except (AttributeError, TypeError, ImportError):
                self._vad_segments_counter = None
        else:
            self._vad_segments_counter = None

        # Load model
        try:
            self._logger.info("Loading VAD model: %s", model_id)
            model = Model.from_pretrained(model_id, use_auth_token=hf_token)
            
            if model is None:
                raise RuntimeError("Model.from_pretrained returned None - check HuggingFace token and model access")
            
            model = model.to(device)
            
            # Initialize pipeline
            self.pipeline = VoiceActivityDetection(segmentation=model)
            
            # Hyperparameters (from Kokoro-Conversational settings)
            HYPER_PARAMETERS = {
                "min_duration_on": min_duration_on,
                "min_duration_off": min_duration_off,
            }
            self.pipeline.instantiate(HYPER_PARAMETERS)
            
            self._logger.info(
                "VAD initialized: model=%s, device=%s, min_speech=%ss, min_silence=%ss",
                model_id, device, min_duration_on, min_duration_off,
            )
            
        except Exception as e:
            self._logger.error("VAD initialization failed: %s", e)
            self._logger.error(
                "Possible causes:\n"
                "1. HuggingFace token not set or invalid (HUGGINGFACE_TOKEN in .env)\n"
                "2. Model access not granted - accept terms at: https://huggingface.co/%s\n"
                "3. Network/download issue\n"
                "Current token: %s",
                model_id, 'SET' if hf_token else 'NOT SET',
            )
            raise RuntimeError("Failed to initialize VAD service") from e
    
    def detect_speech(self, audio: np.ndarray, sample_rate: int = 16000) -> List[Tuple[float, float]]:
        """
        Detect speech segments in audio.
        
        Args:
            audio: PCM audio array (mono, float32, normalized)
            sample_rate: Audio sample rate in Hz
            
        Returns:
            List of (start_time, end_time) tuples in seconds
        """
        if audio is None or len(audio) == 0:
            return []
        
        try:
            # Convert to torch tensor
            if len(audio.shape) == 1:
                audio = audio.reshape(1, -1)
            
            audio_tensor = torch.from_numpy(audio).float().to(self.device)
            
            # Create audio dict for pyannote
            audio_dict = {
                "waveform": audio_tensor,
                "sample_rate": sample_rate,
            }
            
            # Run VAD
            vad_output = self.pipeline(audio_dict)
            
            # Extract segments (handle both Segment objects and tuples)
            segments = []
            for item in vad_output.itertracks():
                if isinstance(item, tuple):
                    # API returns (track, segment) tuple
                    segment = item[0] if len(item) > 0 else item
                    if hasattr(segment, 'start') and hasattr(segment, 'end'):
                        segments.append((segment.start, segment.end))
                    else:
                        # Fallback: treat as (start, end) tuple
                        segments.append((float(item[0]), float(item[1])))
                else:
                    # Segment object
                    segments.append((item.start, item.end))
            
            if segments:
                self._logger.debug(
                    f"VAD detected {len(segments)} speech segment(s): "
                    f"{segments}"
                )
                
                # MEDIUM FIX: Increment metrics counter
                if self._vad_segments_counter:
                    try:
                        self._vad_segments_counter.inc(value=len(segments), device=self.device)
                    except (AttributeError, TypeError, RuntimeError):
                        pass  # Don't fail VAD on metrics error
            
            return segments
            
        except Exception as e:
            self._logger.error("VAD detection failed: %s", e)
            return []
    
    def cleanup(self) -> None:
        """
        CRITICAL FIX: Release ML model resources (GPU/CPU memory).
        
        Call this on server shutdown to prevent memory leaks.
        """
        try:
            if hasattr(self, 'pipeline') and self.pipeline is not None:
                # Move model to CPU and delete to release GPU memory
                if hasattr(self.pipeline, 'segmentation') and self.pipeline.segmentation is not None:
                    self.pipeline.segmentation.to('cpu')
                    del self.pipeline.segmentation
                del self.pipeline
                self.pipeline = None
                self._logger.info("VAD model cleaned up (GPU/CPU memory released)")
        except Exception as e:
            self._logger.warning("VAD cleanup failed: %s", e)

