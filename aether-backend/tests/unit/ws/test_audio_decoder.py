"""
Unit Tests: ws/domain/audio/services/audio_decoder.py

Tests OpusDecoder: Base64 audio decoding for two paths:
  1. PCM16 direct path (format_hint='pcm16') — fast, no pydub/ffmpeg
  2. Container format path (WAV via pydub) — mono conversion, resampling

Also tests: DoS protection (max chunk size), float32 normalization,
error handling, and two bug regressions fixed in source.

BUGS FOUND AND FIXED:
  1. Line 109: `opus_bytes` referenced but undefined (should be `audio_bytes`).
     Container format decode crashed with NameError on every successful call.
  2. Line 115: except clause (RuntimeError, ValueError, TypeError, OSError)
     did not catch pydub.CouldntDecodeError or wave.Error (both inherit from
     Exception directly). Invalid audio data caused uncaught exceptions.

Direct import bypasses ws.domain.audio.__init__ heavy deps.
OpusDecoder imports: base64, io, numpy, pydub.AudioSegment, logging (all installed).
"""

import base64
import importlib.util
import io
import os
import struct
import wave

import numpy as np
import pytest

# Direct import: bypass ws.domain.audio.__init__ heavy deps (openwakeword chain)
_spec = importlib.util.spec_from_file_location(
    "audio_decoder",
    os.path.join(
        os.path.dirname(__file__),
        "..", "..", "..", "ws", "domain", "audio", "services", "audio_decoder.py",
    ),
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
OpusDecoder = _module.OpusDecoder


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_pcm16_b64(samples_int16):
    """Create base64-encoded raw PCM16 from int16 sample values."""
    arr = np.array(samples_int16, dtype=np.int16)
    return base64.b64encode(arr.tobytes()).decode()


def _make_wav_b64(samples_int16, channels=1, sample_rate=16000):
    """Create base64-encoded WAV file from int16 sample values.

    Uses stdlib wave module — no pydub/ffmpeg needed for fixture creation.
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(sample_rate)
        data = struct.pack(f"<{len(samples_int16)}h", *samples_int16)
        w.writeframes(data)
    return base64.b64encode(buf.getvalue()).decode()


# =========================================================================
# __init__
# =========================================================================


class TestInit:
    def test_default_target_sr(self):
        d = OpusDecoder()
        assert d.target_sr == 16000

    def test_default_max_chunk_size(self):
        d = OpusDecoder()
        assert d.max_chunk_size_bytes == 10 * 1024 * 1024

    def test_custom_target_sr(self):
        d = OpusDecoder(target_sr=44100)
        assert d.target_sr == 44100

    def test_custom_max_chunk_size(self):
        d = OpusDecoder(max_chunk_size_mb=5)
        assert d.max_chunk_size_bytes == 5 * 1024 * 1024

    def test_max_chunk_size_zero(self):
        d = OpusDecoder(max_chunk_size_mb=0)
        assert d.max_chunk_size_bytes == 0

    def test_logger_is_module_logger(self):
        """_logger is the module-level logger, not a fresh one."""
        d = OpusDecoder()
        assert d._logger.name == "audio_decoder"  # __name__ of direct-imported module


# =========================================================================
# decode — size validation (DoS protection)
# =========================================================================


class TestDecodeSizeValidation:
    def test_payload_exceeding_max_raises(self):
        """Line 57-60: payload > max_chunk_size_bytes → ValueError."""
        d = OpusDecoder(max_chunk_size_mb=0)
        with pytest.raises(ValueError, match="exceeds max size"):
            d.decode("AAAA")

    def test_error_message_includes_both_sizes(self):
        """ValueError message includes actual and max sizes for debugging."""
        d = OpusDecoder(max_chunk_size_mb=0)
        with pytest.raises(ValueError) as exc_info:
            d.decode("AAAA")
        msg = str(exc_info.value)
        assert "4" in msg  # actual size
        assert "0" in msg  # max size

    def test_payload_at_exact_limit_passes_size_check(self):
        """Line 57: strictly > check. Exactly at limit must pass."""
        pcm = np.array([100], dtype=np.int16)
        b64 = base64.b64encode(pcm.tobytes()).decode()
        d = OpusDecoder()
        d.max_chunk_size_bytes = len(b64)  # Exact match
        result = d.decode(b64, format_hint="pcm16")
        assert len(result) == 1

    def test_payload_one_byte_over_max_rejected(self):
        pcm = np.array([100], dtype=np.int16)
        b64 = base64.b64encode(pcm.tobytes()).decode()
        d = OpusDecoder()
        d.max_chunk_size_bytes = len(b64) - 1  # One byte under payload length
        with pytest.raises(ValueError, match="exceeds max size"):
            d.decode(b64, format_hint="pcm16")


# =========================================================================
# decode — PCM16 path (format_hint='pcm16')
# =========================================================================


class TestDecodePcm16:
    def test_basic_decode(self):
        """Lines 67-74: PCM16 path decodes int16 → float32, normalized."""
        d = OpusDecoder()
        samples = [0, 16384, -16384, 32767, -32768]
        b64 = _make_pcm16_b64(samples)
        result = d.decode(b64, format_hint="pcm16")
        expected = np.array(samples, dtype=np.float32) / 32768.0
        np.testing.assert_array_almost_equal(result, expected)

    def test_normalization_positive_max(self):
        """int16 max 32767 → 32767/32768 ≈ 0.99997 (not exactly 1.0)."""
        d = OpusDecoder()
        result = d.decode(_make_pcm16_b64([32767]), format_hint="pcm16")
        assert result[0] == pytest.approx(32767.0 / 32768.0)

    def test_normalization_negative_max(self):
        """int16 min -32768 → exactly -1.0."""
        d = OpusDecoder()
        result = d.decode(_make_pcm16_b64([-32768]), format_hint="pcm16")
        assert result[0] == pytest.approx(-1.0)

    def test_silence(self):
        d = OpusDecoder()
        result = d.decode(_make_pcm16_b64([0, 0, 0, 0]), format_hint="pcm16")
        np.testing.assert_array_equal(result, [0.0, 0.0, 0.0, 0.0])

    def test_output_dtype_is_float32(self):
        d = OpusDecoder()
        result = d.decode(_make_pcm16_b64([100, -100]), format_hint="pcm16")
        assert result.dtype == np.float32

    def test_empty_pcm16_returns_empty_array(self):
        """Zero-length PCM16 data → empty float32 array."""
        d = OpusDecoder()
        b64 = base64.b64encode(b"").decode()
        result = d.decode(b64, format_hint="pcm16")
        assert len(result) == 0
        assert result.dtype == np.float32

    def test_single_sample(self):
        d = OpusDecoder()
        result = d.decode(_make_pcm16_b64([12345]), format_hint="pcm16")
        assert len(result) == 1
        assert result[0] == pytest.approx(12345.0 / 32768.0)

    def test_alternating_polarity_preserved(self):
        """Alternating positive/negative samples preserve sign after normalization."""
        d = OpusDecoder()
        samples = [10000, -10000, 20000, -20000]
        result = d.decode(_make_pcm16_b64(samples), format_hint="pcm16")
        assert result[0] > 0
        assert result[1] < 0
        assert result[2] > 0
        assert result[3] < 0

    def test_pcm16_ignores_target_sr(self):
        """PCM16 path does not resample — target_sr is irrelevant."""
        d = OpusDecoder(target_sr=44100)
        samples = [100, 200, 300]
        result = d.decode(_make_pcm16_b64(samples), format_hint="pcm16")
        assert len(result) == 3  # No resampling, same count

    def test_odd_length_pcm16_raises(self):
        """PCM16 with odd byte count (not multiple of 2) → ValueError.

        np.frombuffer(dtype=int16) requires even byte count. Odd bytes
        cause ValueError caught by except Exception handler.
        """
        d = OpusDecoder()
        odd_bytes = base64.b64encode(b"\x00\x01\x02").decode()  # 3 bytes
        with pytest.raises(ValueError, match="Failed to decode audio"):
            d.decode(odd_bytes, format_hint="pcm16")


# =========================================================================
# decode — container format path (WAV via pydub)
# =========================================================================


class TestDecodeContainerFormat:
    def test_wav_mono_matching_rate(self):
        """WAV decode: mono 16kHz → no channel/rate conversion needed."""
        d = OpusDecoder(target_sr=16000)
        samples = [0, 1000, -1000, 5000, -5000]
        b64 = _make_wav_b64(samples, channels=1, sample_rate=16000)
        result = d.decode(b64)
        assert len(result) == len(samples)
        expected = np.array(samples, dtype=np.float32) / 32768.0
        np.testing.assert_array_almost_equal(result, expected, decimal=3)

    def test_stereo_to_mono(self):
        """Lines 94-95: stereo WAV → mono conversion."""
        d = OpusDecoder(target_sr=16000)
        # 6 interleaved int16 values = 3 stereo frames
        stereo = [1000, 500, 2000, 800, 3000, 1200]
        b64 = _make_wav_b64(stereo, channels=2, sample_rate=16000)
        result = d.decode(b64)
        # 3 stereo frames → 3 mono samples
        assert len(result) == 3
        assert result.dtype == np.float32

    def test_resampling_from_higher_rate(self):
        """Lines 98-99: 44100Hz WAV resampled to 16000Hz target."""
        d = OpusDecoder(target_sr=16000)
        # 100 samples of a sine wave at 44100Hz
        samples = [int(1000 * np.sin(2 * np.pi * i / 100)) for i in range(100)]
        b64 = _make_wav_b64(samples, channels=1, sample_rate=44100)
        result = d.decode(b64)
        # 100 samples at 44100 → ~36 samples at 16000
        assert len(result) < len(samples)
        assert 30 <= len(result) <= 42

    def test_no_resample_when_rate_matches(self):
        """When WAV sample_rate == target_sr, no resampling occurs."""
        d = OpusDecoder(target_sr=16000)
        samples = [500, -500, 1000, -1000, 2000]
        b64 = _make_wav_b64(samples, channels=1, sample_rate=16000)
        result = d.decode(b64)
        # Same rate: sample count preserved exactly
        assert len(result) == len(samples)

    def test_header_detection_wav_magic(self):
        """Lines 78-85: WAV has RIFF header (0x52494646)."""
        d = OpusDecoder(target_sr=16000)
        samples = [0, 100]
        b64 = _make_wav_b64(samples, channels=1, sample_rate=16000)
        # Verify the raw bytes start with RIFF magic
        raw = base64.b64decode(b64)
        assert raw[:4] == b"RIFF"
        # Decode succeeds
        result = d.decode(b64)
        assert len(result) == 2

    def test_output_dtype_is_float32(self):
        d = OpusDecoder(target_sr=16000)
        b64 = _make_wav_b64([0, 1000], channels=1, sample_rate=16000)
        result = d.decode(b64)
        assert result.dtype == np.float32

    def test_output_normalized_range(self):
        """Container path output is normalized to [-1, 1]."""
        d = OpusDecoder(target_sr=16000)
        samples = [32767, -32768, 0]
        b64 = _make_wav_b64(samples, channels=1, sample_rate=16000)
        result = d.decode(b64)
        assert np.all(result >= -1.0)
        assert np.all(result <= 1.0)


# =========================================================================
# decode — error handling
# =========================================================================


class TestDecodeErrorHandling:
    def test_invalid_base64_raises_value_error(self):
        """binascii.Error (subclass of ValueError) caught and wrapped."""
        d = OpusDecoder()
        with pytest.raises(ValueError, match="Failed to decode audio"):
            d.decode("!!!not-valid-base64!!!")

    def test_corrupted_audio_bytes_raises_value_error(self):
        """Valid base64, invalid audio → ValueError (pydub error caught).

        Before bug fix #2: pydub.CouldntDecodeError was uncaught because
        it inherits from Exception, not from the original narrow catch list.
        """
        d = OpusDecoder()
        b64 = base64.b64encode(b"this is not audio data at all and is junk").decode()
        with pytest.raises(ValueError, match="Failed to decode audio"):
            d.decode(b64)

    def test_error_wraps_original_cause(self):
        """Line 117: 'from e' preserves original exception as __cause__."""
        d = OpusDecoder()
        with pytest.raises(ValueError) as exc_info:
            d.decode("!!!invalid!!!")
        assert exc_info.value.__cause__ is not None

    def test_short_payload_no_header_detection(self):
        """< 4 bytes: header detection skipped (line 78), pydub decode attempted."""
        d = OpusDecoder()
        b64 = base64.b64encode(b"\x00\x01").decode()
        with pytest.raises(ValueError, match="Failed to decode audio"):
            d.decode(b64)

    def test_empty_string_input(self):
        """Empty base64 string → empty bytes → pydub fails → ValueError."""
        d = OpusDecoder()
        with pytest.raises(ValueError, match="Failed to decode audio"):
            d.decode("")


# =========================================================================
# BUG REGRESSIONS
# =========================================================================


class TestBugRegressions:
    """Regression tests for bugs found and fixed in audio_decoder.py."""

    def test_container_decode_no_name_error_on_opus_bytes(self):
        """BUG #1: Line 109 referenced `opus_bytes` (undefined).

        Should be `audio_bytes`. Container format decode crashed with
        NameError on every successful call. After fix: completes normally.
        """
        d = OpusDecoder(target_sr=16000)
        samples = [0, 1000, -1000]
        b64 = _make_wav_b64(samples, channels=1, sample_rate=16000)
        # Before fix: NameError('name opus_bytes is not defined')
        # After fix: returns decoded array
        result = d.decode(b64)
        assert len(result) == 3
        expected = np.array(samples, dtype=np.float32) / 32768.0
        np.testing.assert_array_almost_equal(result, expected, decimal=3)

    def test_pydub_error_caught_after_except_widening(self):
        """BUG #2: except clause did not catch pydub.CouldntDecodeError.

        pydub.CouldntDecodeError inherits from Exception, not from
        RuntimeError/ValueError/TypeError/OSError. Invalid audio that
        passed base64 decode caused an uncaught exception.
        After fix: all exceptions caught and wrapped in ValueError.
        """
        d = OpusDecoder()
        # Valid base64 but garbage audio bytes — triggers pydub error path
        garbage = base64.b64encode(b"\x00" * 100).decode()
        with pytest.raises(ValueError, match="Failed to decode audio"):
            d.decode(garbage)
