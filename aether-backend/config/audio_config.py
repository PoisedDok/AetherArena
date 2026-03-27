"""
@.architecture
Incoming: config/settings.py, environment variables, user preferences API --- {Dict[str, Any], env vars}
Processing: Define typed audio/handsfree configuration schemas, validate ranges, provide defaults --- {3 jobs: JOB_LOAD_CONFIG, JOB_VALIDATE_CONFIG, JOB_VALIDATE_SCHEMA}
Outgoing: ws/factory.py, audio services --- {AudioConfig, VadConfig, SttConfig, WakeWordConfig, HandsfreeConfig}

Audio Configuration - Central config for all audio/handsfree services

Defines typed configuration for:
- Opus decoder (sample rate, max chunk size)
- VAD (pyannote model, thresholds, durations)
- STT (Whisper model, language, device)
- Wake word detection (openWakeWord model, threshold, framework)
- Handsfree mode (conversation timeout, buffer limits, auto-loop)

All values can be overridden via:
1. Environment variables (AUDIO_* prefix)
2. User preferences API (stored in database)
3. Frontend settings panel

NO HARDCODED VALUES IN SERVICE CLASSES.
"""

from pathlib import Path
from typing import Optional, List
from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# ── Backend root: resolves correctly in dev, frozen binary, and test contexts ──
_BACKEND_ROOT = Path(__file__).resolve().parent.parent

def _is_apple_silicon() -> bool:
    """Detect Apple Silicon (M1/M2/M3/M4)."""
    import platform
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def _default_qwen3_model_path() -> str:
    """
    Resolve Qwen3-TTS model path with platform-aware defaults.

    Priority:
      1. Local data/models/tts/ directory (fastest — no network)
      2. Apple Silicon → MLX 8-bit quantised (3-6x faster than PyTorch MPS)
      3. Other → PyTorch full-precision from HuggingFace

    The integration layer (realtime_tts.py) selects the engine class
    (Qwen3MLXEngine vs Qwen3Engine) based on which is importable.
    This function just provides the right model ID for the selected engine.
    """
    # Check for local PyTorch model first (setup_engine.py copies here)
    local_pt = _BACKEND_ROOT / "data" / "models" / "tts" / "Qwen3-TTS-12Hz-0.6B-CustomVoice"
    if local_pt.exists() and (local_pt / "model.safetensors").exists():
        return str(local_pt)

    # Platform-aware default: MLX on Apple Silicon, PyTorch elsewhere
    if _is_apple_silicon():
        return "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
    return "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"



class AetherAudioBaseSettings(BaseSettings):
    @classmethod
    def settings_customise_sources(
        cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
    ):
        return (env_settings, init_settings)

class OpusDecoderConfig(AetherAudioBaseSettings):

    """Opus decoder configuration."""
    target_sample_rate: int = Field(
        default=16000,
        description="Target sample rate for PCM output (Hz)",
        ge=8000,
        le=48000
    )
    max_chunk_size_mb: int = Field(
        default=10,
        description="Maximum Base64 chunk size (MB) - DoS protection",
        ge=1,
        le=100
    )
    
    model_config = SettingsConfigDict(env_prefix="AUDIO_OPUS_")


class VadConfig(AetherAudioBaseSettings):
    """Voice Activity Detection configuration."""
    model_id: str = Field(
        default="pyannote/segmentation-3.0",
        description="HuggingFace VAD model ID"
    )
    device: Optional[str] = Field(
        default=None,
        description="Device override (cuda/mps/cpu) or None for auto-detect"
    )
    min_duration_on: float = Field(
        default=0.3,
        description="Minimum speech duration (seconds)",
        ge=0.1,
        le=2.0
    )
    min_duration_off: float = Field(
        default=0.3,
        description="Minimum silence duration before end of utterance (Kokoro uses 0.1-0.3s for segment merging)",
        ge=0.1,
        le=10.0
    )
    threshold: float = Field(
        default=0.5,
        description="VAD confidence threshold (0.0-1.0)",
        ge=0.0,
        le=1.0
    )
    
    model_config = SettingsConfigDict(env_prefix="AUDIO_VAD_")


class SttConfig(AetherAudioBaseSettings):
    """Speech-to-Text configuration."""
    model_id: str = Field(
        default="openai/whisper-small",
        description="HuggingFace Whisper model ID",
    )
    device: Optional[str] = Field(
        default=None,
        description="Device override (cuda/mps/cpu) or None for auto-detect"
    )
    language: Optional[str] = Field(
        default=None,
        description="Language code (en/es/fr/de/zh/ja) or None for auto-detect"
    )
    
    # Model options for frontend settings dropdown
    available_models: List[str] = Field(
        default_factory=lambda: [
            "openai/whisper-tiny",
            "openai/whisper-small",
            "openai/whisper-medium",
            "openai/whisper-large-v3",
            "openai/whisper-large-v3-turbo",
        ]
    )
    
    model_config = SettingsConfigDict(env_prefix="AUDIO_STT_")


class WakeWordConfig(AetherAudioBaseSettings):
    """Wake word detection configuration."""
    model_name: str = Field(
        default="hey_jarvis",
        description="openWakeWord model name"
    )
    threshold: float = Field(
        default=0.5,
        description="Detection confidence threshold (0.0-1.0)",
        ge=0.0,
        le=1.0
    )
    inference_framework: str = Field(
        default="onnx",
        description="Inference framework (onnx/tflite)"
    )
    enable_vad: bool = Field(
        default=True,
        description="Enable openWakeWord internal VAD"
    )
    vad_threshold: float = Field(
        default=0.5,
        description="openWakeWord VAD threshold (0.0-1.0)",
        ge=0.0,
        le=1.0
    )
    expected_sample_rate: int = Field(
        default=16000,
        description="Expected audio sample rate (Hz) - openWakeWord requires 16kHz",
        ge=8000,
        le=48000
    )
    frame_duration_ms: int = Field(
        default=80,
        description="Audio frame duration (milliseconds)",
        ge=20,
        le=200
    )
    max_buffer_frames: int = Field(
        default=10,
        description="Maximum frames to buffer (memory leak protection)",
        ge=5,
        le=50
    )
    
    # Available models for frontend settings
    available_models: List[str] = Field(
        default_factory=lambda: [
            "hey_jarvis",
            "alexa",
            "hey_mycroft",
            "hey_rhasspy",
        ]
    )
    
    model_config = SettingsConfigDict(env_prefix="AUDIO_WAKE_WORD_")


class HandsfreeConfig(AetherAudioBaseSettings):
    """Handsfree mode configuration."""
    enabled_by_default: bool = Field(
        default=False,
        description="Enable handsfree mode on startup"
    )
    conversation_timeout_seconds: float = Field(
        default=300.0,
        description="Seconds of inactivity before requiring wake word again (5 min for natural conversation flow)",
        ge=5.0,
        le=600.0
    )
    max_buffer_seconds: int = Field(
        default=30,
        description="Maximum audio buffer duration (seconds)",
        ge=10,
        le=120
    )
    sample_rate: int = Field(
        default=16000,
        description="Audio sample rate (Hz)",
        ge=8000,
        le=48000
    )
    auto_loop: bool = Field(
        default=True,
        description="Auto-return to listening after TTS completes"
    )
    auto_loop_debounce_ms: int = Field(
        default=800,
        description="Debounce delay before re-enabling mic after TTS (ms)",
        ge=0,
        le=3000
    )
    vad_timeout_ms: int = Field(
        default=30000,
        description="Max time in LISTENING state before timeout (ms)",
        ge=5000,
        le=120000
    )
    interruption_threshold: float = Field(
        default=0.03,
        description="Audio level threshold for interruption detection (Kokoro uses 0.02-0.03)",
        ge=0.01,
        le=0.5
    )
    interruption_cooldown_ms: int = Field(
        default=1000,
        description="Cooldown after interruption before detecting again (ms)",
        ge=500,
        le=5000
    )
    
    # Circuit breaker configuration
    circuit_breaker_enabled: bool = Field(
        default=True,
        description="Enable circuit breaker for ML failures"
    )
    circuit_breaker_failure_threshold: int = Field(
        default=5,
        description="Consecutive failures before opening circuit",
        ge=3,
        le=20
    )
    circuit_breaker_reset_timeout_seconds: int = Field(
        default=60,
        description="Seconds before attempting to reset circuit",
        ge=30,
        le=300
    )
    
    # Redis persistence configuration
    cache_namespace: str = Field(
        default="handsfree:conversation",
        description="Redis key namespace for conversation state persistence"
    )
    
    # Audio quality validation thresholds
    silence_threshold: float = Field(
        default=0.01,
        description="RMS threshold for silence detection (-40 dB)",
        ge=0.001,
        le=0.1
    )
    clipping_threshold: float = Field(
        default=0.99,
        description="Peak amplitude threshold for clipping detection",
        ge=0.9,
        le=1.0
    )
    
    model_config = SettingsConfigDict(env_prefix="AUDIO_HANDSFREE_")


class TtsConfig(AetherAudioBaseSettings):
    """Text-to-Speech configuration for handsfree mode."""
    engine: str = Field(
        default="qwen3",
        description="TTS engine (qwen3/kokoro/system/edge/gtts)"
    )
    voice: str = Field(
        default="Ryan",
        description="Voice name (qwen3: Ryan/Aiden/Vivian/etc, kokoro: af_heart/etc)"
    )
    sample_rate: int = Field(
        default=24000,
        description="Audio sample rate (Hz) - Qwen3 and Kokoro native is 24000",
        ge=16000,
        le=48000
    )
    speed: float = Field(
        default=1.0,
        description="Speech speed multiplier",
        ge=0.5,
        le=2.0
    )
    first_sentence_target_words: int = Field(
        default=6,
        description="Target words for first sentence. Tradeoff: lower = faster "
                    "first audio, higher = more stable prosody. 3 words gives "
                    "erratic emotion; 6-8 gives stable output with acceptable latency.",
        ge=2,
        le=15
    )
    chunk_target_words: int = Field(
        default=18,
        description="Target words for subsequent chunks (natural pacing)",
        ge=10,
        le=30
    )
    sentence_queue_maxsize: int = Field(
        default=100,
        description="Sentence queue size (bounded for resource control)",
        ge=10,
        le=500
    )
    audio_queue_maxsize: int = Field(
        default=200,
        description="Audio queue size (2x sentence queue for buffering)",
        ge=20,
        le=1000
    )

    # ── Qwen3-TTS specific ────────────────────────────────────
    qwen3_model_path: str = Field(
        default_factory=_default_qwen3_model_path,
        description="Local path or HuggingFace model ID for Qwen3-TTS. "
                    "Auto-resolves: data/models/tts/ first, HF fallback."
    )
    qwen3_device: Optional[str] = Field(
        default=None,
        description="Device for Qwen3 (cuda:0/mps/cpu/None=auto)"
    )
    qwen3_language: str = Field(
        default="",
        description="Explicit language for Qwen3-TTS ('english'/'chinese'/etc). "
                    "Empty = auto-resolve from voice's native language. "
                    "Explicit is recommended for consistent prosody on short chunks."
    )
    qwen3_instruct: str = Field(
        default="Speak naturally in a clear, steady conversational tone.",
        description="Natural-language style instruction for voice stability. "
                    "Anchors emotional baseline across chunked synthesis. "
                    "Effective on 1.7B models; minimal effect on 0.6B."
    )

    # Available engines for frontend settings dropdown
    available_engines: List[str] = Field(
        default_factory=lambda: [
            "qwen3",
            "kokoro",
            "system",
            "edge",
            "gtts",
        ]
    )

    # Available Qwen3 voices (flat list kept for backward compat)
    available_qwen3_voices: List[str] = Field(
        default_factory=lambda: [
            "Ryan", "Aiden", "Vivian", "Serena", "Uncle_Fu",
            "Dylan", "Eric", "Ono_Anna", "Sohee",
        ]
    )

    # Available Kokoro voices (flat list kept for backward compat)
    available_kokoro_voices: List[str] = Field(
        default_factory=lambda: [
            "af_heart", "af_sky", "af_bella", "af_nicole",
            "am_adam", "am_michael",
        ]
    )

    # ── Rich voice metadata for frontend dropdown population ──────────
    # Backend is SSOT: value, label, native language.
    # Frontend fetches from /v1/tts/capabilities — never hardcodes.

    @staticmethod
    def get_qwen3_voice_options() -> list:
        """Qwen3 voice options with display metadata."""
        return [
            {"value": "Ryan", "label": "Ryan (male, dynamic, English)", "language": "english"},
            {"value": "Aiden", "label": "Aiden (male, clear, English)", "language": "english"},
            {"value": "Vivian", "label": "Vivian (female, bright, Chinese)", "language": "chinese"},
            {"value": "Serena", "label": "Serena (female, warm, Chinese)", "language": "chinese"},
            {"value": "Uncle_Fu", "label": "Uncle Fu (male, mellow, Chinese)", "language": "chinese"},
            {"value": "Dylan", "label": "Dylan (male, youthful, Chinese)", "language": "chinese"},
            {"value": "Eric", "label": "Eric (male, lively, Chinese)", "language": "chinese"},
            {"value": "Ono_Anna", "label": "Ono Anna (female, playful, Japanese)", "language": "japanese"},
            {"value": "Sohee", "label": "Sohee (female, warm, Korean)", "language": "korean"},
        ]

    @staticmethod
    def get_kokoro_voice_options() -> list:
        """Kokoro voice options with display metadata."""
        return [
            {"value": "af_heart", "label": "AF Heart (female, warm)", "language": "english"},
            {"value": "af_sky", "label": "AF Sky (female, bright)", "language": "english"},
            {"value": "af_bella", "label": "AF Bella (female, smooth)", "language": "english"},
            {"value": "af_nicole", "label": "AF Nicole (female, clear)", "language": "english"},
            {"value": "am_adam", "label": "AM Adam (male, deep)", "language": "english"},
            {"value": "am_michael", "label": "AM Michael (male, smooth)", "language": "english"},
        ]

    @staticmethod
    def get_engine_options() -> list:
        """TTS engine options with display metadata."""
        return [
            {"value": "qwen3", "label": "Qwen3 (0.6B, high quality)"},
            {"value": "kokoro", "label": "Kokoro (82M, legacy)"},
            {"value": "system", "label": "System (fallback)"},
            {"value": "edge", "label": "Edge TTS (online)"},
            {"value": "gtts", "label": "Google TTS (online)"},
        ]

    @staticmethod
    def get_supported_languages() -> list:
        """Supported TTS languages with display metadata."""
        return [
            {"value": "", "label": "Auto (from voice)"},
            {"value": "english", "label": "English"},
            {"value": "chinese", "label": "Chinese"},
            {"value": "japanese", "label": "Japanese"},
            {"value": "korean", "label": "Korean"},
            {"value": "german", "label": "German"},
            {"value": "french", "label": "French"},
            {"value": "russian", "label": "Russian"},
            {"value": "portuguese", "label": "Portuguese"},
            {"value": "spanish", "label": "Spanish"},
            {"value": "italian", "label": "Italian"},
        ]

    model_config = SettingsConfigDict(env_prefix="AUDIO_TTS_")


class AudioConfig(AetherAudioBaseSettings):
    """Complete audio services configuration."""
    opus: OpusDecoderConfig = Field(default_factory=OpusDecoderConfig)
    vad: VadConfig = Field(default_factory=VadConfig)
    stt: SttConfig = Field(default_factory=SttConfig)
    wake_word: WakeWordConfig = Field(default_factory=WakeWordConfig)
    handsfree: HandsfreeConfig = Field(default_factory=HandsfreeConfig)
    tts: TtsConfig = Field(default_factory=TtsConfig)
    
    model_config = SettingsConfigDict(env_prefix="AUDIO_")


@lru_cache()
def get_audio_config() -> AudioConfig:
    """
    Get cached audio configuration.
    
    Loads from environment variables with AUDIO_* prefix.
    Can be overridden by user preferences at runtime.
    
    Returns:
        AudioConfig: Complete audio services configuration
    """
    return AudioConfig()
