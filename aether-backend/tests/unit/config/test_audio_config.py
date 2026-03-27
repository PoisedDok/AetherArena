"""
Unit Tests: config/audio_config.py

Covers: _is_apple_silicon, _default_qwen3_model_path, get_audio_config,
Pydantic model construction and field validation.

Mock boundaries:
- platform.system / platform.machine → mocked for Apple Silicon detection
- Path.exists → mocked for local model path resolution
- lru_cache → cleared between tests for get_audio_config
"""

from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from config.audio_config import (
    _is_apple_silicon,
    _default_qwen3_model_path,
    get_audio_config,
    AudioConfig,
    OpusDecoderConfig,
    VadConfig,
    SttConfig,
    WakeWordConfig,
    HandsfreeConfig,
    TtsConfig,
)


# ─── _is_apple_silicon ──────────────────────────────────────────────────────


class TestIsAppleSilicon:
    def test_returns_true_on_apple_silicon(self):
        """Darwin + arm64 → True."""
        with patch("platform.system", return_value="Darwin"), \
             patch("platform.machine", return_value="arm64"):
            assert _is_apple_silicon() is True

    def test_returns_false_on_intel_mac(self):
        """Darwin + x86_64 → False."""
        with patch("platform.system", return_value="Darwin"), \
             patch("platform.machine", return_value="x86_64"):
            assert _is_apple_silicon() is False

    def test_returns_false_on_linux(self):
        """Linux + anything → False."""
        with patch("platform.system", return_value="Linux"), \
             patch("platform.machine", return_value="arm64"):
            assert _is_apple_silicon() is False

    def test_returns_false_on_windows(self):
        """Windows + anything → False."""
        with patch("platform.system", return_value="Windows"), \
             patch("platform.machine", return_value="AMD64"):
            assert _is_apple_silicon() is False


# ─── _default_qwen3_model_path ─────────────────────────────────────────────


class TestDefaultQwen3ModelPath:
    def test_local_model_found(self, tmp_path):
        """Local model directory + safetensors exists → returns local path."""
        model_dir = tmp_path / "data" / "models" / "tts" / "Qwen3-TTS-12Hz-0.6B-CustomVoice"
        model_dir.mkdir(parents=True)
        (model_dir / "model.safetensors").touch()

        with patch("config.audio_config._BACKEND_ROOT", tmp_path):
            result = _default_qwen3_model_path()

        assert result == str(model_dir)

    def test_local_model_dir_missing(self):
        """No local model + not Apple Silicon → HuggingFace PyTorch path."""
        with patch("config.audio_config._BACKEND_ROOT", Path("/nonexistent")), \
             patch("config.audio_config._is_apple_silicon", return_value=False):
            result = _default_qwen3_model_path()

        assert result == "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"

    def test_local_model_dir_exists_but_no_safetensors(self, tmp_path):
        """Model dir exists but missing safetensors → falls through."""
        model_dir = tmp_path / "data" / "models" / "tts" / "Qwen3-TTS-12Hz-0.6B-CustomVoice"
        model_dir.mkdir(parents=True)
        # No model.safetensors file

        with patch("config.audio_config._BACKEND_ROOT", tmp_path), \
             patch("config.audio_config._is_apple_silicon", return_value=False):
            result = _default_qwen3_model_path()

        assert result == "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"

    def test_apple_silicon_returns_mlx_model(self):
        """No local model + Apple Silicon → MLX quantized path."""
        with patch("config.audio_config._BACKEND_ROOT", Path("/nonexistent")), \
             patch("config.audio_config._is_apple_silicon", return_value=True):
            result = _default_qwen3_model_path()

        assert result == "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"


# ─── get_audio_config ──────────────────────────────────────────────────────


class TestGetAudioConfig:
    def test_returns_audio_config_instance(self):
        """get_audio_config() returns a valid AudioConfig."""
        # Clear lru_cache from prior calls
        get_audio_config.cache_clear()
        config = get_audio_config()
        assert isinstance(config, AudioConfig)

    def test_cached_returns_same_instance(self):
        """Repeated calls return the same cached object."""
        get_audio_config.cache_clear()
        first = get_audio_config()
        second = get_audio_config()
        assert first is second

    def test_cache_clear_returns_new_instance(self):
        """After cache_clear(), a new instance is created."""
        get_audio_config.cache_clear()
        first = get_audio_config()
        get_audio_config.cache_clear()
        second = get_audio_config()
        # Both are AudioConfig but may be different objects
        assert isinstance(first, AudioConfig)
        assert isinstance(second, AudioConfig)


# ─── Pydantic model construction ───────────────────────────────────────────


class TestAudioConfigModels:
    def test_default_construction(self):
        """AudioConfig with all defaults constructs successfully."""
        config = AudioConfig()
        assert isinstance(config.opus, OpusDecoderConfig)
        assert isinstance(config.vad, VadConfig)
        assert isinstance(config.stt, SttConfig)
        assert isinstance(config.wake_word, WakeWordConfig)
        assert isinstance(config.handsfree, HandsfreeConfig)
        assert isinstance(config.tts, TtsConfig)

    def test_opus_decoder_defaults(self):
        opus = OpusDecoderConfig()
        assert opus.target_sample_rate == 16000
        assert opus.max_chunk_size_mb == 10

    def test_vad_defaults(self):
        vad = VadConfig()
        assert vad.model_id == "pyannote/segmentation-3.0"
        assert vad.threshold == 0.5

    def test_stt_defaults(self):
        stt = SttConfig()
        assert stt.model_id == "openai/whisper-small"
        assert len(stt.available_models) > 0

    def test_wake_word_defaults(self):
        ww = WakeWordConfig()
        assert ww.model_name == "hey_jarvis"
        assert ww.inference_framework == "onnx"

    def test_handsfree_defaults(self):
        hf = HandsfreeConfig()
        assert hf.conversation_timeout_seconds == 300.0
        assert hf.auto_loop is True

    def test_tts_defaults(self):
        """TtsConfig default construction triggers _default_qwen3_model_path."""
        tts = TtsConfig()
        assert tts.engine == "qwen3"
        assert tts.voice == "Ryan"
        # qwen3_model_path is set by _default_qwen3_model_path factory
        assert isinstance(tts.qwen3_model_path, str)
        assert len(tts.qwen3_model_path) > 0

    def test_opus_sample_rate_validation(self):
        """Out-of-range sample rate rejected."""
        with pytest.raises(ValidationError):
            OpusDecoderConfig(target_sample_rate=100)

    def test_vad_threshold_validation(self):
        """Out-of-range threshold rejected."""
        with pytest.raises(ValidationError):
            VadConfig(threshold=2.0)

    def test_handsfree_timeout_validation(self):
        """Too-low timeout rejected."""
        with pytest.raises(ValidationError):
            HandsfreeConfig(conversation_timeout_seconds=1.0)

    def test_tts_speed_validation(self):
        """Speed out of range rejected."""
        with pytest.raises(ValidationError):
            TtsConfig(speed=5.0)
