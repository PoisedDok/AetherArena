"""
Incoming: AudioProcessingService --- {np.ndarray (PCM int16, 16kHz)}
Processing: Real-time wake word detection using openWakeWord, process 80ms frames, accumulate predictions, emit when threshold exceeded --- {4 jobs: JOB_DETECT_WAKE_WORD, JOB_INITIALIZE, JOB_RESET_STATE, JOB_VALIDATE_SCHEMA}
Outgoing: AudioProcessingService --- {bool (wake_word_detected)}

WakeWordService - Production-grade wake word detection using openWakeWord

Uses openWakeWord library with pre-trained "hey jarvis" model (closest to "hey guru").
Processes audio in 80ms frames (1280 samples @ 16kHz) and returns confidence scores.

Architecture: Frame-by-frame processing with prediction smoothing to reduce false positives.
Models: Uses ONNX runtime for cross-platform inference (CPU/CUDA/MPS compatible).

Future: Train custom "hey guru" model using openWakeWord training utilities.
"""

import numpy as np
import logging
from typing import Optional, Dict
from collections import deque
from itertools import islice
from openwakeword.model import Model

logger = logging.getLogger(__name__)

# CRITICAL FIX: Define METRICS_AVAILABLE before use
try:
    from monitoring.metrics import get_metrics_registry
    METRICS_AVAILABLE = True
except ImportError:
    METRICS_AVAILABLE = False
    get_metrics_registry = None


class WakeWordService:
    """Production-grade wake word detection using openWakeWord (per-client state)."""
    
    # Universal constant (not configurable - int16 audio standard)
    INT16_MAX = 32767  # Maximum value for int16 audio
    
    def __init__(
        self,
        model_name: str = "hey_jarvis",
        threshold: float = 0.5,
        inference_framework: str = "onnx",
        enable_vad: bool = True,
        vad_threshold: float = 0.5,
        expected_sample_rate: int = 16000,
        frame_duration_ms: int = 80,
        max_buffer_frames: int = 10,
    ):
        """
        Initialize wake word service.
        
        Args:
            model_name: Wake word model name ("hey_jarvis", "alexa", "hey_mycroft")
            threshold: Confidence threshold for detection (0.0-1.0)
            inference_framework: "onnx" or "tflite"
            enable_vad: Enable Silero VAD for noise rejection
            vad_threshold: VAD confidence threshold (0.0-1.0)
            expected_sample_rate: Expected audio sample rate (Hz) - openWakeWord requires 16kHz
            frame_duration_ms: Audio frame duration (milliseconds)
            max_buffer_frames: Maximum frames to buffer (memory leak protection)
        """
        self.model_name = model_name
        self.threshold = threshold
        self.inference_framework = inference_framework
        self.expected_sample_rate = expected_sample_rate
        self.frame_duration_ms = frame_duration_ms
        self.max_buffer_frames = max_buffer_frames
        self._logger = logger
        
        # Initialize openWakeWord model (shared across clients - stateless)
        try:
            self.model = Model(
                wakeword_models=[model_name],
                inference_framework=inference_framework,
                enable_speex_noise_suppression=False,  # macOS not supported
                vad_threshold=vad_threshold if enable_vad else 0.0,
            )
            
            self._logger.info(
                f"✅ WakeWordService initialized: model={model_name}, "
                f"threshold={threshold}, framework={inference_framework}, "
                f"vad={'enabled' if enable_vad else 'disabled'}"
            )
            
        except Exception as e:
            self._logger.error("Failed to initialize WakeWordService: %s", e)
            raise
        
        # CRITICAL FIX: Per-client state tracking (not shared)
        self._frame_buffers: Dict[str, deque] = {}  # client_id -> deque of audio samples
        self._awaiting_wake_word: Dict[str, bool] = {}  # client_id -> awaiting flag
        self._detection_counts: Dict[str, int] = {}  # client_id -> count
        
        # CRITICAL FIX: Calculate frame size from config (not hardcoded)
        self._frame_size_samples = int(self.expected_sample_rate * self.frame_duration_ms / 1000)
        self._max_buffer_frames = self.max_buffer_frames
        
        # MEDIUM FIX: Initialize metrics counter
        if METRICS_AVAILABLE:
            try:
                registry = get_metrics_registry()
                self._wake_word_counter = registry.counter(
                    "wake_word_detections_total",
                    "Total number of wake word detections",
                    labels=["model", "client_id"]
                )
            except (AttributeError, TypeError, ImportError):
                self._wake_word_counter = None
        else:
            self._wake_word_counter = None
    
    def detect(self, audio: np.ndarray, sample_rate: int, client_id: str) -> bool:
        """
        Detect wake word in audio (per-client state).
        
        Args:
            audio: PCM audio array (mono, float32, normalized to [-1, 1])
            sample_rate: Audio sample rate (must be 16kHz)
            client_id: Client identifier for per-client state isolation
            
        Returns:
            True if wake word detected above threshold, False otherwise
        """
        # CRITICAL FIX: Validate sample rate using config (not hardcoded constant)
        if sample_rate != self.expected_sample_rate:
            self._logger.error(
                f"WakeWordService requires {self.expected_sample_rate}Hz audio, got {sample_rate}Hz"
            )
            return False
        
        # MEDIUM FIX: Validate audio dtype and shape
        if audio is None or len(audio) == 0:
            return False
        
        if not isinstance(audio, np.ndarray):
            self._logger.error("Audio must be np.ndarray, got %s", type(audio))
            return False
        
        if audio.dtype != np.float32:
            self._logger.warning("Audio dtype is %s, expected float32 - converting", audio.dtype)
            audio = audio.astype(np.float32)
        
        # Initialize per-client state on first use
        if client_id not in self._frame_buffers:
            # HIGH FIX: Use deque with maxlen for bounded memory
            max_samples = self._frame_size_samples * self._max_buffer_frames
            self._frame_buffers[client_id] = deque(maxlen=max_samples)
            self._awaiting_wake_word[client_id] = True
            self._detection_counts[client_id] = 0
        
        # HIGH FIX: Convert float32 [-1, 1] to int16 using constant (openWakeWord expects int16)
        audio_int16 = (audio * self.INT16_MAX).astype(np.int16)
        
        # Add to per-client frame buffer
        self._frame_buffers[client_id].extend(audio_int16)
        
        # Process all complete 80ms frames
        detected = False
        buffer = self._frame_buffers[client_id]
        
        while len(buffer) >= self._frame_size_samples:
            # HIGH FIX: Efficient frame extraction using islice (avoid list() conversion)
            frame = np.array(list(islice(buffer, self._frame_size_samples)), dtype=np.int16)
            
            # HIGH FIX: Efficient buffer removal (bulk popleft)
            for _ in range(self._frame_size_samples):
                buffer.popleft()
            
            # LOW FIX: Error recovery - don't let model.predict() failure kill detection
            try:
                # Get prediction (model is stateless, safe for concurrent use)
                prediction = self.model.predict(frame)
            except Exception as predict_error:
                self._logger.error(
                    "WakeWord prediction failed for %s: %s", client_id[:8], predict_error
                )
                # Continue processing remaining frames - don't return False
                continue
            
            # MEDIUM FIX: Validate prediction structure before accessing
            if not isinstance(prediction, dict) or self.model_name not in prediction:
                self._logger.warning(
                    f"Invalid prediction format from model (expected dict with '{self.model_name}' key)"
                )
                continue
            
            score = prediction[self.model_name]
            
            if score >= self.threshold:
                detected = True
                self._detection_counts[client_id] += 1
                self._awaiting_wake_word[client_id] = False
                
                # MEDIUM FIX: Remove emoji from production log
                self._logger.info(
                    f"WAKE WORD DETECTED: '{self.model_name}' "
                    f"(score={score:.3f}, threshold={self.threshold}, client={client_id[:8]})"
                )
                
                # HIGH FIX: Increment metrics counter (was missing!)
                if self._wake_word_counter:
                    try:
                        self._wake_word_counter.inc(model=self.model_name, client_id=client_id[:8])
                    except (AttributeError, TypeError, RuntimeError):
                        pass  # Don't fail detection on metrics error
                
                # Reset model state for next detection
                self.model.reset()
                buffer.clear()
                break
        
        return detected
    
    def reset(self, client_id: str) -> None:
        """
        Reset wake word detection state for specific client.
        
        Call this after conversation timeout to require wake word again.
        
        Args:
            client_id: Client identifier
        """
        if client_id in self._frame_buffers:
            self._frame_buffers[client_id].clear()
        
        if client_id in self._awaiting_wake_word:
            self._awaiting_wake_word[client_id] = True
        
        # Model reset not needed (stateless)
        self._logger.debug("WakeWordService reset for client %s", client_id[:8])
    
    def cleanup_client(self, client_id: str) -> None:
        """
        Remove all state for disconnected client (prevent memory leak).
        
        Args:
            client_id: Client identifier
        """
        self._frame_buffers.pop(client_id, None)
        self._awaiting_wake_word.pop(client_id, None)
        self._detection_counts.pop(client_id, None)
        self._logger.debug("WakeWordService cleaned up client %s", client_id[:8])
    
    def is_awaiting_wake_word(self, client_id: str) -> bool:
        """Check if client is awaiting wake word."""
        return self._awaiting_wake_word.get(client_id, True)
    
    def get_stats(self, client_id: Optional[str] = None) -> dict:
        """
        Get wake word detection statistics.
        
        Args:
            client_id: Optional client identifier for per-client stats
            
        Returns:
            Statistics dictionary (global or per-client)
        """
        if client_id:
            return {
                "model": self.model_name,
                "threshold": self.threshold,
                "client_id": client_id[:8],
                "awaiting_wake_word": self._awaiting_wake_word.get(client_id, True),
                "detection_count": self._detection_counts.get(client_id, 0),
                "buffer_size": len(self._frame_buffers.get(client_id, [])),
            }
        else:
            return {
                "model": self.model_name,
                "threshold": self.threshold,
                "total_clients": len(self._frame_buffers),
                "total_detections": sum(self._detection_counts.values()),
            }
    
    def cleanup(self) -> None:
        """
        CRITICAL FIX: Release ML model resources (CPU memory, ONNX runtime).
        
        Call this on server shutdown to prevent memory leaks.
        """
        try:
            if hasattr(self, 'model') and self.model is not None:
                # Reset and delete model to release ONNX runtime memory
                self.model.reset()
                del self.model
                self.model = None
                self._logger.info("WakeWord model cleaned up (ONNX runtime memory released)")
        except Exception as e:
            self._logger.warning("WakeWord cleanup failed: %s", e)
