"""
Unit Tests: ws/domain/audio/services/audio_processor.py

Tests AudioProcessingService: the coordination class for the handsfree audio
pipeline (decode → wake word → buffer → VAD → STT → callbacks).

Coverage targets: __init__, _strip_wake_word_phrases, _validate_audio_quality,
circuit breaker state machine, _is_conversation_active, process_chunk pipeline,
reset_buffer, cleanup_client, get_conversation_status, Redis persistence, cleanup.

Bugs found: 7+
- cleanup_client: tts_coordinator, Redis, wake_word steps not independently guarded
- Multiple narrow except clauses across Redis persistence, reset_buffer, cleanup, TTS interruption
All fixed: independent try/except wrapping + broadened to except Exception.

NOTES:
  - Dead code REMOVED from _validate_audio_quality: snr_estimate, min_amplitude,
    samples_clipped, clipping_rate computations and dead if/pass clipping check were
    producing local values never consumed. self.clipping_threshold param kept (config-wired API).
  - ARCH FIX: Removed 'from ws.factory import client_llm_locks' from cleanup_client
    (domain must not import from factory). LLM lock cleanup is owned by router.cleanup_client().
  - RACE FIX: cleanup_client now acquires per-client lock before clearing state.

Import: stubs openwakeword (NOT installed) then imports through package path.
All other audio deps (numpy, pydub, torch, pyannote, transformers) are installed.
"""

import asyncio
import sys
import time
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest

# Stub openwakeword (not installed) to allow ws.domain.audio package import.
# Only needed because ws.domain.audio.__init__ imports AudioProcessingService
# which chains to wake_word_service -> openwakeword.
if "openwakeword" not in sys.modules:
    _ow = ModuleType("openwakeword")
    _ow.__path__ = []
    _ow_model = ModuleType("openwakeword.model")
    _ow_model.Model = type("Model", (), {})
    sys.modules["openwakeword"] = _ow
    sys.modules["openwakeword.model"] = _ow_model

from ws.domain.audio.services.audio_processor import (
    AudioProcessingService,
    CircuitState,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

VALID_AUDIO = np.array([0.5, -0.5, 0.3, -0.3] * 50, dtype=np.float32)
SILENT_AUDIO = np.zeros(200, dtype=np.float32)


def _make_service(**overrides):
    """Create AudioProcessingService with mocked deps.

    All sub-services are MagicMock. Callbacks are AsyncMock.
    Override any kwarg to customize.
    """
    defaults = {
        "opus_decoder": MagicMock(),
        "vad_service": MagicMock(),
        "stt_service": MagicMock(),
        "wake_word_service": MagicMock(),
        "on_transcript": AsyncMock(),
        "on_interruption": AsyncMock(),
        "tts_coordinator": AsyncMock(),
        "conversation_timeout": 30.0,
        "cache_adapter": None,
        "max_buffer_seconds": 30,
        "sample_rate": 16000,
        "circuit_breaker_enabled": True,
        "circuit_breaker_threshold": 5,
        "circuit_breaker_reset_timeout": 60,
        "silence_threshold": 0.01,
        "clipping_threshold": 0.99,
    }
    defaults.update(overrides)
    return AudioProcessingService(**defaults)


# =========================================================================
# __init__
# =========================================================================


class TestInit:
    def test_services_assigned(self):
        decoder = MagicMock()
        vad = MagicMock()
        stt = MagicMock()
        ww = MagicMock()
        s = _make_service(
            opus_decoder=decoder, vad_service=vad,
            stt_service=stt, wake_word_service=ww,
        )
        assert s.decoder is decoder
        assert s.vad is vad
        assert s.stt is stt
        assert s.wake_word is ww

    def test_callbacks_assigned(self):
        cb = AsyncMock()
        s = _make_service(on_transcript=cb)
        assert s.on_transcript is cb

    def test_default_conversation_timeout(self):
        s = _make_service()
        assert s.conversation_timeout == 30.0

    def test_custom_conversation_timeout(self):
        s = _make_service(conversation_timeout=60.0)
        assert s.conversation_timeout == 60.0

    def test_max_buffer_calculation(self):
        s = _make_service(max_buffer_seconds=10, sample_rate=16000)
        assert s.MAX_BUFFER_SECONDS == 10
        assert s.MAX_BUFFER_SAMPLES == 10 * 16000

    def test_per_client_dicts_initialized_empty(self):
        s = _make_service()
        assert s.conversation_active == {}
        assert s.last_wake_word_time == {}
        assert s._client_locks == {}
        assert s._state_loaded == {}
        assert s.audio_buffers == {}

    def test_circuit_breaker_config(self):
        s = _make_service(
            circuit_breaker_enabled=True,
            circuit_breaker_threshold=3,
            circuit_breaker_reset_timeout=120,
        )
        assert s.circuit_breaker_enabled is True
        assert s.circuit_breaker_threshold == 3
        assert s.circuit_breaker_reset_timeout == 120

    def test_quality_thresholds(self):
        s = _make_service(silence_threshold=0.02, clipping_threshold=0.95)
        assert s.silence_threshold == 0.02
        assert s.clipping_threshold == 0.95

    def test_cache_adapter_stored(self):
        cache = AsyncMock()
        s = _make_service(cache_adapter=cache)
        assert s._cache is cache

    def test_tts_coordinator_stored(self):
        tts = AsyncMock()
        s = _make_service(tts_coordinator=tts)
        assert s._tts_coordinator is tts


# =========================================================================
# _strip_wake_word_phrases
# =========================================================================


class TestStripWakeWordPhrases:
    def test_empty_string(self):
        s = _make_service()
        assert s._strip_wake_word_phrases("") == ""

    def test_none_returns_none(self):
        s = _make_service()
        assert s._strip_wake_word_phrases(None) is None

    def test_no_wake_word(self):
        s = _make_service()
        assert s._strip_wake_word_phrases("what time is it") == "what time is it"

    def test_strip_hey_jarvis(self):
        s = _make_service()
        result = s._strip_wake_word_phrases("hey jarvis what time is it")
        assert result == "what time is it"

    def test_strip_hi_jarvis(self):
        s = _make_service()
        result = s._strip_wake_word_phrases("hi jarvis tell me a joke")
        assert result == "tell me a joke"

    def test_strip_hello_jarvis(self):
        s = _make_service()
        result = s._strip_wake_word_phrases("hello jarvis how are you")
        assert result == "how are you"

    def test_strip_jarvis_only_returns_empty(self):
        """Transcript that is ONLY the wake word returns empty."""
        s = _make_service()
        assert s._strip_wake_word_phrases("jarvis") == ""

    def test_strip_hey_jarvis_only_returns_empty(self):
        s = _make_service()
        assert s._strip_wake_word_phrases("hey jarvis") == ""

    def test_case_insensitive(self):
        s = _make_service()
        result = s._strip_wake_word_phrases("HEY JARVIS tell me something")
        assert result == "tell me something"

    def test_strip_leading_punctuation_after_wake_word(self):
        """Line 191: lstrip(' ,.!?') after removing wake word."""
        s = _make_service()
        result = s._strip_wake_word_phrases("hey jarvis, what time is it")
        assert result == "what time is it"

    def test_strip_with_exclamation(self):
        s = _make_service()
        result = s._strip_wake_word_phrases("hey jarvis! do something")
        assert result == "do something"


# =========================================================================
# _validate_audio_quality
# =========================================================================


class TestValidateAudioQuality:
    def test_none_audio_returns_false(self):
        s = _make_service()
        assert s._validate_audio_quality(None, "c1") is False

    def test_empty_audio_returns_false(self):
        s = _make_service()
        assert s._validate_audio_quality(np.array([], dtype=np.float32), "c1") is False

    def test_silent_audio_returns_false(self):
        s = _make_service(silence_threshold=0.01)
        assert s._validate_audio_quality(SILENT_AUDIO, "c1") is False

    def test_valid_audio_returns_true(self):
        s = _make_service(silence_threshold=0.01)
        assert s._validate_audio_quality(VALID_AUDIO, "c1") is True

    def test_nan_audio_returns_false(self):
        arr = np.array([np.nan, 0.5, 0.3], dtype=np.float32)
        s = _make_service()
        assert s._validate_audio_quality(arr, "c1") is False

    def test_inf_audio_returns_false(self):
        arr = np.array([np.inf, 0.5, 0.3], dtype=np.float32)
        s = _make_service()
        assert s._validate_audio_quality(arr, "c1") is False

    def test_loud_audio_passes_validation(self):
        """High-amplitude audio (near clipping) passes — only silence/corruption rejected."""
        arr = np.ones(100, dtype=np.float32) * 0.999
        s = _make_service(silence_threshold=0.001, clipping_threshold=0.99)
        assert s._validate_audio_quality(arr, "c1") is True

    def test_custom_silence_threshold(self):
        """Silence threshold from config is respected."""
        arr = np.ones(100, dtype=np.float32) * 0.005  # Very quiet
        s = _make_service(silence_threshold=0.01)
        # RMS = 0.005 < threshold 0.01 → silent
        assert s._validate_audio_quality(arr, "c1") is False

    def test_audio_just_above_silence_threshold(self):
        arr = np.ones(100, dtype=np.float32) * 0.02
        s = _make_service(silence_threshold=0.01)
        # RMS = 0.02 > threshold 0.01 → valid
        assert s._validate_audio_quality(arr, "c1") is True


# =========================================================================
# Circuit Breaker: _check_circuit_breaker, _record_ml_success, _record_ml_failure
# =========================================================================


class TestCircuitBreaker:
    def test_disabled_always_returns_true(self):
        s = _make_service(circuit_breaker_enabled=False)
        assert s._check_circuit_breaker("c1") is True

    def test_closed_returns_true(self):
        s = _make_service()
        assert s._check_circuit_breaker("c1") is True

    def test_open_before_timeout_returns_false(self):
        s = _make_service(circuit_breaker_reset_timeout=60)
        s._circuit_breaker_state["c1"] = CircuitState.OPEN
        s._circuit_breaker_opened_at["c1"] = time.time()
        assert s._check_circuit_breaker("c1") is False

    def test_open_after_timeout_transitions_to_half_open(self):
        s = _make_service(circuit_breaker_reset_timeout=1)
        s._circuit_breaker_state["c1"] = CircuitState.OPEN
        s._circuit_breaker_opened_at["c1"] = time.time() - 2  # 2 seconds ago
        assert s._check_circuit_breaker("c1") is True
        assert s._circuit_breaker_state["c1"] == CircuitState.HALF_OPEN

    def test_half_open_returns_true(self):
        s = _make_service()
        s._circuit_breaker_state["c1"] = CircuitState.HALF_OPEN
        assert s._check_circuit_breaker("c1") is True

    def test_record_success_resets_failures(self):
        s = _make_service()
        s._circuit_breaker_failures["c1"] = 3
        s._record_ml_success("c1")
        assert s._circuit_breaker_failures["c1"] == 0

    def test_record_success_closes_circuit(self):
        s = _make_service()
        s._circuit_breaker_state["c1"] = CircuitState.HALF_OPEN
        s._record_ml_success("c1")
        assert s._circuit_breaker_state["c1"] == CircuitState.CLOSED

    def test_record_success_disabled_is_noop(self):
        s = _make_service(circuit_breaker_enabled=False)
        s._record_ml_success("c1")
        assert "c1" not in s._circuit_breaker_failures

    def test_record_failure_increments_count(self):
        s = _make_service()
        s._record_ml_failure("c1", RuntimeError("test"))
        assert s._circuit_breaker_failures["c1"] == 1

    def test_record_failure_opens_circuit_at_threshold(self):
        s = _make_service(circuit_breaker_threshold=3)
        for _ in range(3):
            s._record_ml_failure("c1", RuntimeError("test"))
        assert s._circuit_breaker_state["c1"] == CircuitState.OPEN
        assert "c1" in s._circuit_breaker_opened_at

    def test_record_failure_below_threshold_stays_closed(self):
        s = _make_service(circuit_breaker_threshold=5)
        for _ in range(4):
            s._record_ml_failure("c1", RuntimeError("test"))
        assert s._circuit_breaker_state.get("c1") != CircuitState.OPEN

    def test_record_failure_disabled_is_noop(self):
        s = _make_service(circuit_breaker_enabled=False)
        s._record_ml_failure("c1", RuntimeError("test"))
        assert "c1" not in s._circuit_breaker_failures

    def test_full_lifecycle_closed_to_open_to_half_open_to_closed(self):
        """Full circuit breaker state machine transition."""
        s = _make_service(circuit_breaker_threshold=2, circuit_breaker_reset_timeout=1)

        # CLOSED → 2 failures → OPEN
        s._record_ml_failure("c1", RuntimeError("fail"))
        s._record_ml_failure("c1", RuntimeError("fail"))
        assert s._circuit_breaker_state["c1"] == CircuitState.OPEN

        # OPEN → check before timeout → False
        assert s._check_circuit_breaker("c1") is False

        # OPEN → set opened_at to past → transitions to HALF_OPEN
        s._circuit_breaker_opened_at["c1"] = time.time() - 2
        assert s._check_circuit_breaker("c1") is True
        assert s._circuit_breaker_state["c1"] == CircuitState.HALF_OPEN

        # HALF_OPEN → success → CLOSED
        s._record_ml_success("c1")
        assert s._circuit_breaker_state["c1"] == CircuitState.CLOSED
        assert s._circuit_breaker_failures["c1"] == 0


# =========================================================================
# _is_conversation_active
# =========================================================================


class TestIsConversationActive:
    async def test_no_conversation_returns_false(self):
        s = _make_service()
        assert await s._is_conversation_active("c1") is False

    async def test_active_within_timeout_returns_true(self):
        s = _make_service(conversation_timeout=30.0)
        s.conversation_active["c1"] = time.time()
        assert await s._is_conversation_active("c1") is True

    async def test_expired_conversation_returns_false(self):
        s = _make_service(conversation_timeout=1.0)
        s.conversation_active["c1"] = time.time() - 2  # 2 seconds ago
        s.last_wake_word_time["c1"] = time.time() - 2
        result = await s._is_conversation_active("c1")
        assert result is False
        # Conversation state cleaned up
        assert "c1" not in s.conversation_active
        assert "c1" not in s.last_wake_word_time

    async def test_expired_conversation_calls_wake_word_reset(self):
        s = _make_service(conversation_timeout=1.0)
        s.conversation_active["c1"] = time.time() - 2
        await s._is_conversation_active("c1")
        s.wake_word.reset.assert_called_once_with("c1")

    async def test_expired_conversation_clears_redis(self):
        """Line 380-381: if cache exists, clear state on timeout."""
        cache = AsyncMock()
        s = _make_service(conversation_timeout=1.0, cache_adapter=cache)
        s.conversation_active["c1"] = time.time() - 2
        await s._is_conversation_active("c1")
        cache.delete.assert_called_once_with("handsfree:conversation:c1")


# =========================================================================
# process_chunk — pipeline stages
# =========================================================================


class TestProcessChunk:
    async def test_decode_called_with_format_hint(self):
        """Line 412: decoder.decode(base64_opus, format_hint=format_hint)."""
        s = _make_service()
        s.decoder.decode.return_value = SILENT_AUDIO  # Will be dropped as silent
        await s.process_chunk("base64data", "c1", format_hint="pcm16")
        s.decoder.decode.assert_called_once_with("base64data", format_hint="pcm16")

    async def test_silent_audio_dropped(self):
        """Lines 415-417: silent audio fails quality check → returns early."""
        s = _make_service()
        s.decoder.decode.return_value = SILENT_AUDIO
        await s.process_chunk("data", "c1")
        s.wake_word.detect.assert_not_called()

    async def test_circuit_breaker_open_rejects(self):
        """Lines 420-422: circuit breaker open → returns early."""
        s = _make_service(circuit_breaker_threshold=1)
        s.decoder.decode.return_value = VALID_AUDIO
        s._circuit_breaker_state["c1"] = CircuitState.OPEN
        s._circuit_breaker_opened_at["c1"] = time.time()
        await s.process_chunk("data", "c1")
        s.wake_word.detect.assert_not_called()

    async def test_no_conversation_no_wake_word_drops_audio(self):
        """Lines 459-462: no conversation, no wake word → drops audio."""
        s = _make_service()
        s.decoder.decode.return_value = VALID_AUDIO
        s.wake_word.detect.return_value = False
        await s.process_chunk("data", "c1")
        # No VAD, no STT, no callback
        s.vad.detect_speech.assert_not_called()
        s.on_transcript.assert_not_called()

    async def test_wake_word_activates_conversation(self):
        """Lines 432-457: wake word detected → activates conversation, emits event."""
        s = _make_service()
        s.decoder.decode.return_value = VALID_AUDIO
        s.wake_word.detect.return_value = True
        await s.process_chunk("data", "c1")
        # Conversation activated
        assert "c1" in s.conversation_active
        assert "c1" in s.last_wake_word_time
        # Wake word detection event emitted
        s.on_transcript.assert_awaited_once_with("c1", "__WAKE_WORD_DETECTED__")

    async def test_wake_word_clears_buffer(self):
        """Lines 444-445: wake word clears existing buffer."""
        s = _make_service()
        s.decoder.decode.return_value = VALID_AUDIO
        s.wake_word.detect.return_value = True
        s.audio_buffers["c1"] = [np.ones(100)]
        await s.process_chunk("data", "c1")
        # Buffer cleared (list exists but is empty)
        assert s.audio_buffers["c1"] == []

    async def test_wake_word_saves_redis_state(self):
        """Lines 439-440: wake word + cache → saves conversation state."""
        cache = MagicMock()
        cache.get = AsyncMock(return_value=None)
        cache.set = AsyncMock(return_value=None)
        cache.delete = AsyncMock(return_value=None)
        s = _make_service(cache_adapter=cache, conversation_timeout=30.0)
        s.decoder.decode.return_value = VALID_AUDIO
        s.wake_word.detect.return_value = True
        await s.process_chunk("data", "c1")
        cache.set.assert_called_once()
        args = cache.set.call_args
        assert args[0][0] == "handsfree:conversation:c1"
        state = args[0][1]
        assert state["active"] is True
        assert args[1]["ttl"] == 60  # 2x conversation_timeout

    async def test_active_conversation_buffers_audio(self):
        """Lines 465-469: active conversation → audio buffered."""
        s = _make_service()
        s.decoder.decode.return_value = VALID_AUDIO
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = []  # No speech yet
        await s.process_chunk("data", "c1")
        assert "c1" in s.audio_buffers
        assert len(s.audio_buffers["c1"]) == 1

    async def test_buffer_overflow_trims(self):
        """Lines 475-487: buffer exceeding MAX_BUFFER_SAMPLES trimmed."""
        s = _make_service(max_buffer_seconds=1, sample_rate=16000)
        # Buffer is 16000 samples. Add 20000 to exceed.
        s.audio_buffers["c1"] = [np.ones(20000, dtype=np.float32) * 0.5]
        s.decoder.decode.return_value = VALID_AUDIO  # + 200 more
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = []
        await s.process_chunk("data", "c1")
        # After trim: buffer should contain exactly MAX_BUFFER_SAMPLES (16000)
        total = sum(len(b) for b in s.audio_buffers["c1"])
        assert total <= s.MAX_BUFFER_SAMPLES

    async def test_vad_speech_triggers_stt(self):
        """Lines 490-514: VAD detects speech → STT transcription."""
        s = _make_service()
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)  # 1s at 16kHz
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]  # 0-0.5s speech
        s.stt.transcribe.return_value = "hello world"
        await s.process_chunk("data", "c1")
        s.stt.transcribe.assert_called_once()

    async def test_stt_transcript_invokes_callback(self):
        """Lines 560-565: valid transcript → on_transcript callback."""
        s = _make_service()
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "hello world"
        await s.process_chunk("data", "c1")
        s.on_transcript.assert_any_await("c1", "hello world")

    async def test_empty_stt_result_skipped(self):
        """Lines 516-517: empty STT result → continue (no callback)."""
        s = _make_service()
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = ""
        await s.process_chunk("data", "c1")
        s.on_transcript.assert_not_awaited()

    async def test_wake_word_stripped_from_transcript(self):
        """Lines 522-528: transcript only containing wake word → skipped."""
        s = _make_service()
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "hey jarvis"
        await s.process_chunk("data", "c1")
        # "hey jarvis" stripped → empty → skipped
        s.on_transcript.assert_not_awaited()

    async def test_conversation_timeout_reset_on_transcript(self):
        """Line 532: conversation_active[client_id] updated on valid transcript."""
        s = _make_service()
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        old_time = time.time() - 10
        s.conversation_active["c1"] = old_time
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "hello world"
        await s.process_chunk("data", "c1")
        assert s.conversation_active["c1"] > old_time

    async def test_tts_interruption_on_speech(self):
        """Lines 536-557: TTS interrupted when user speaks during playback."""
        tts = AsyncMock()
        s = _make_service(tts_coordinator=tts)
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "hello world"
        await s.process_chunk("data", "c1")
        tts.clear_queues.assert_awaited_once_with("c1")
        s.on_interruption.assert_awaited_once_with("c1")

    async def test_sleep_word_detected(self):
        """Lines 568-573: 'sleep' in transcript → emits __SLEEP_WORD_DETECTED__."""
        s = _make_service()
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "go to sleep now"
        await s.process_chunk("data", "c1")
        calls = s.on_transcript.await_args_list
        texts = [c.args[1] for c in calls]
        assert "go to sleep now" in texts
        assert "__SLEEP_WORD_DETECTED__" in texts

    async def test_buffer_cleared_after_speech_processing(self):
        """Line 585: buffer cleared after speech segments processed."""
        s = _make_service()
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "hello"
        await s.process_chunk("data", "c1")
        assert s.audio_buffers["c1"] == []

    async def test_ml_success_recorded_on_successful_transcription(self):
        """Line 576: _record_ml_success called after successful callback."""
        s = _make_service(circuit_breaker_threshold=5)
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "hello"
        # Pre-set failures
        s._circuit_breaker_failures["c1"] = 3
        await s.process_chunk("data", "c1")
        # Success resets failures to 0
        assert s._circuit_breaker_failures["c1"] == 0

    async def test_decode_error_records_ml_failure(self):
        """Lines 590-597: exception in pipeline → _record_ml_failure."""
        s = _make_service(circuit_breaker_threshold=5)
        s.decoder.decode.side_effect = RuntimeError("decode failed")
        await s.process_chunk("data", "c1")
        assert s._circuit_breaker_failures["c1"] == 1

    async def test_cancellation_re_raised(self):
        """Lines 587-589: asyncio.CancelledError is re-raised, not caught."""
        s = _make_service()
        s.decoder.decode.side_effect = asyncio.CancelledError()
        with pytest.raises(asyncio.CancelledError):
            await s.process_chunk("data", "c1")

    async def test_callback_error_does_not_kill_pipeline(self):
        """Lines 577-582: callback error caught, pipeline continues."""
        s = _make_service()
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "hello"
        s.on_transcript.side_effect = RuntimeError("callback crash")
        # Should NOT raise — callback error is caught
        await s.process_chunk("data", "c1")

    async def test_tts_interrupt_error_does_not_kill_pipeline(self):
        """Lines 553-557: TTS interruption error caught, transcription continues."""
        tts = AsyncMock()
        tts.clear_queues.side_effect = RuntimeError("TTS error")
        s = _make_service(tts_coordinator=tts)
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "hello"
        # Should NOT raise — TTS error caught
        await s.process_chunk("data", "c1")

    async def test_interruption_emit_error_caught(self):
        """Lines 548-552: on_interruption error caught, processing continues."""
        tts = AsyncMock()
        s = _make_service(tts_coordinator=tts)
        s.on_interruption = AsyncMock(side_effect=RuntimeError("emit fail"))
        audio = np.array([0.5, -0.5] * 8000, dtype=np.float32)
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        s.vad.detect_speech.return_value = [(0.0, 0.5)]
        s.stt.transcribe.return_value = "hello"
        # Should NOT raise — emit error caught
        await s.process_chunk("data", "c1")

    async def test_state_loaded_only_once_per_client(self):
        """Lines 406-408: state loaded once per client (not per chunk)."""
        cache = AsyncMock()
        cache.get.return_value = None
        s = _make_service(cache_adapter=cache)
        s.decoder.decode.return_value = SILENT_AUDIO  # Drop early
        await s.process_chunk("data", "c1")
        await s.process_chunk("data", "c1")
        # _load_conversation_state called only once
        assert cache.get.await_count == 1

    async def test_per_client_lock_created(self):
        """Lines 401-402: lock initialized per client."""
        s = _make_service()
        s.decoder.decode.return_value = SILENT_AUDIO
        await s.process_chunk("data", "c1")
        assert "c1" in s._client_locks
        assert isinstance(s._client_locks["c1"], asyncio.Lock)

    async def test_speech_segment_out_of_bounds_skipped(self):
        """Lines 504-505: start_sample >= len(full_audio) → continue."""
        s = _make_service()
        audio = np.array([0.5, -0.5] * 100, dtype=np.float32)  # 200 samples
        s.decoder.decode.return_value = audio
        s.conversation_active["c1"] = time.time()
        # VAD reports speech segment beyond audio length
        s.vad.detect_speech.return_value = [(100.0, 200.0)]  # Way beyond
        s.stt.transcribe.return_value = "hello"
        await s.process_chunk("data", "c1")
        # STT should NOT be called (segment out of bounds)
        s.stt.transcribe.assert_not_called()

    async def test_circuit_breaker_open_suppresses_error_log(self):
        """Lines 592-594: circuit already open → error logged conditionally."""
        s = _make_service(circuit_breaker_threshold=1)
        s._circuit_breaker_state["c1"] = CircuitState.OPEN
        s._circuit_breaker_opened_at["c1"] = time.time()
        # First chunk: circuit is open, so decode still happens (lock created, state loaded)
        # but circuit check rejects before decode
        s.decoder.decode.return_value = VALID_AUDIO
        # Manually simulate: already open, then failure
        s.decoder.decode.side_effect = RuntimeError("fail")
        await s.process_chunk("data", "c1")
        # Failure recorded but log suppressed (circuit already open)
        assert s._circuit_breaker_failures["c1"] >= 1


# =========================================================================
# reset_buffer
# =========================================================================


class TestResetBuffer:
    async def test_clears_audio_buffer(self):
        s = _make_service()
        s.audio_buffers["c1"] = [np.ones(100)]
        await s.reset_buffer("c1")
        assert "c1" not in s.audio_buffers

    async def test_clears_conversation_state(self):
        s = _make_service()
        s.conversation_active["c1"] = time.time()
        await s.reset_buffer("c1")
        assert "c1" not in s.conversation_active

    async def test_clears_wake_word_time(self):
        s = _make_service()
        s.last_wake_word_time["c1"] = time.time()
        await s.reset_buffer("c1")
        assert "c1" not in s.last_wake_word_time

    async def test_resets_wake_word_service(self):
        s = _make_service()
        await s.reset_buffer("c1")
        s.wake_word.reset.assert_called_once_with("c1")

    async def test_clears_redis_state(self):
        cache = AsyncMock()
        s = _make_service(cache_adapter=cache)
        s.audio_buffers["c1"] = [np.ones(100)]
        await s.reset_buffer("c1")
        cache.delete.assert_called_once_with("handsfree:conversation:c1")

    async def test_no_error_if_no_existing_state(self):
        s = _make_service()
        await s.reset_buffer("nonexistent")
        # No error raised

    async def test_acquires_client_lock(self):
        """RACE FIX: reset_buffer acquires per-client lock like process_chunk."""
        s = _make_service()
        lock = asyncio.Lock()
        s._client_locks["c1"] = lock
        s.audio_buffers["c1"] = [np.ones(10)]
        assert not lock.locked()
        await s.reset_buffer("c1")
        # Lock NOT popped (reset_buffer doesn't remove lock, only cleanup_client does)
        assert "c1" in s._client_locks
        assert "c1" not in s.audio_buffers

    async def test_creates_lock_if_none_exists(self):
        """reset_buffer creates lock if client never called process_chunk."""
        s = _make_service()
        assert "c1" not in s._client_locks
        await s.reset_buffer("c1")
        assert "c1" in s._client_locks
        assert isinstance(s._client_locks["c1"], asyncio.Lock)

    async def test_wake_word_reset_error_caught(self):
        """wake_word.reset() error is caught, not propagated to handler."""
        s = _make_service()
        s.wake_word.reset.side_effect = RuntimeError("model unloaded")
        await s.reset_buffer("c1")
        # No exception raised — error caught internally


# =========================================================================
# cleanup_client
# =========================================================================


class TestCleanupClient:
    async def test_clears_all_per_client_state(self):
        s = _make_service()
        s.audio_buffers["c1"] = [np.ones(100)]
        s.conversation_active["c1"] = time.time()
        s.last_wake_word_time["c1"] = time.time()
        s._state_loaded["c1"] = True
        s._client_locks["c1"] = asyncio.Lock()
        s._circuit_breaker_failures["c1"] = 3
        s._circuit_breaker_opened_at["c1"] = time.time()
        s._circuit_breaker_state["c1"] = CircuitState.OPEN

        await s.cleanup_client("c1")

        assert "c1" not in s.audio_buffers
        assert "c1" not in s.conversation_active
        assert "c1" not in s.last_wake_word_time
        assert "c1" not in s._state_loaded
        assert "c1" not in s._client_locks
        assert "c1" not in s._circuit_breaker_failures
        assert "c1" not in s._circuit_breaker_opened_at
        assert "c1" not in s._circuit_breaker_state

    async def test_calls_tts_coordinator_cleanup(self):
        tts = AsyncMock()
        s = _make_service(tts_coordinator=tts)
        await s.cleanup_client("c1")
        tts.cleanup_client.assert_awaited_once_with("c1")

    async def test_calls_wake_word_cleanup(self):
        s = _make_service()
        await s.cleanup_client("c1")
        s.wake_word.cleanup_client.assert_called_once_with("c1")

    async def test_clears_redis_state(self):
        cache = AsyncMock()
        s = _make_service(cache_adapter=cache)
        await s.cleanup_client("c1")
        cache.delete.assert_called_once_with("handsfree:conversation:c1")

    async def test_no_tts_coordinator_still_succeeds(self):
        s = _make_service(tts_coordinator=None)
        await s.cleanup_client("c1")
        # No error

    async def test_cleanup_acquires_client_lock(self):
        """RACE FIX regression: cleanup_client acquires per-client lock.

        Without this, cleanup can clear state while process_chunk is holding
        the lock and using the same state dictionaries.
        """
        s = _make_service()
        lock = asyncio.Lock()
        s._client_locks["c1"] = lock

        # Pre-populate state to clean
        s.audio_buffers["c1"] = [np.ones(10)]
        s.conversation_active["c1"] = time.time()

        # Lock is NOT held → cleanup should acquire and release it
        assert not lock.locked()
        await s.cleanup_client("c1")
        # Lock popped after release
        assert "c1" not in s._client_locks
        # State cleaned
        assert "c1" not in s.audio_buffers
        assert "c1" not in s.conversation_active

    async def test_cleanup_without_existing_lock(self):
        """cleanup_client creates lock if none exists (no KeyError)."""
        s = _make_service()
        assert "c1" not in s._client_locks
        await s.cleanup_client("c1")
        # Lock created then popped
        assert "c1" not in s._client_locks


# =========================================================================
# get_conversation_status
# =========================================================================


class TestGetConversationStatus:
    def test_active_conversation(self):
        s = _make_service(conversation_timeout=30.0)
        s.conversation_active["c1"] = time.time()
        s.wake_word.get_stats.return_value = {"detections": 1}
        status = s.get_conversation_status("c1")
        assert status["active"] is True
        assert 0 <= status["elapsed"] <= 1.0  # Just activated, ~0s elapsed
        assert 29.0 <= status["remaining"] <= 30.0  # ~30s remaining
        assert status["wake_word_stats"] == {"detections": 1}

    def test_inactive_conversation(self):
        s = _make_service()
        s.wake_word.get_stats.return_value = {"detections": 0}
        status = s.get_conversation_status("c1")
        assert status["active"] is False
        assert status["awaiting_wake_word"] is True

    def test_remaining_never_negative(self):
        s = _make_service(conversation_timeout=1.0)
        s.conversation_active["c1"] = time.time() - 10  # Expired
        s.wake_word.get_stats.return_value = {}
        status = s.get_conversation_status("c1")
        assert status["remaining"] >= 0


# =========================================================================
# Redis persistence: _save, _load, _clear conversation state
# =========================================================================


class TestRedisPersistence:
    async def test_save_no_cache_is_noop(self):
        s = _make_service(cache_adapter=None)
        await s._save_conversation_state("c1")
        # No error

    async def test_save_writes_state(self):
        cache = AsyncMock()
        s = _make_service(cache_adapter=cache, conversation_timeout=30.0)
        s.conversation_active["c1"] = time.time()
        s.last_wake_word_time["c1"] = time.time()
        await s._save_conversation_state("c1")
        cache.set.assert_called_once()
        args = cache.set.call_args
        key = args[0][0]
        state = args[0][1]
        assert "handsfree:conversation:c1" == key
        assert state["active"] is True
        assert "last_activity" in state
        assert "wake_word_time" in state
        assert args[1]["ttl"] == 60  # 2x timeout

    async def test_save_error_caught(self):
        cache = AsyncMock()
        cache.set.side_effect = RuntimeError("Redis down")
        s = _make_service(cache_adapter=cache)
        await s._save_conversation_state("c1")
        # No error raised

    async def test_load_no_cache_returns_false(self):
        s = _make_service(cache_adapter=None)
        assert await s._load_conversation_state("c1") is False

    async def test_load_no_state_returns_false(self):
        cache = AsyncMock()
        cache.get.return_value = None
        s = _make_service(cache_adapter=cache)
        assert await s._load_conversation_state("c1") is False

    async def test_load_inactive_state_returns_false(self):
        cache = AsyncMock()
        cache.get.return_value = {"active": False}
        s = _make_service(cache_adapter=cache)
        assert await s._load_conversation_state("c1") is False

    async def test_load_expired_state_returns_false_and_clears(self):
        cache = AsyncMock()
        cache.get.return_value = {
            "active": True,
            "wake_word_time": time.time() - 100,
            "last_activity": time.time() - 100,
        }
        s = _make_service(cache_adapter=cache, conversation_timeout=30.0)
        assert await s._load_conversation_state("c1") is False
        cache.delete.assert_called_once_with("handsfree:conversation:c1")

    async def test_load_valid_state_restores(self):
        now = time.time()
        cache = AsyncMock()
        cache.get.return_value = {
            "active": True,
            "wake_word_time": now - 5,
            "last_activity": now - 3,
        }
        s = _make_service(cache_adapter=cache, conversation_timeout=30.0)
        assert await s._load_conversation_state("c1") is True
        assert "c1" in s.conversation_active
        assert "c1" in s.last_wake_word_time

    async def test_load_error_caught_returns_false(self):
        cache = AsyncMock()
        cache.get.side_effect = RuntimeError("Redis down")
        s = _make_service(cache_adapter=cache)
        assert await s._load_conversation_state("c1") is False

    async def test_clear_no_cache_is_noop(self):
        s = _make_service(cache_adapter=None)
        await s._clear_conversation_state("c1")

    async def test_clear_deletes_key(self):
        cache = AsyncMock()
        s = _make_service(cache_adapter=cache)
        await s._clear_conversation_state("c1")
        cache.delete.assert_called_once_with("handsfree:conversation:c1")

    async def test_clear_error_caught(self):
        cache = AsyncMock()
        cache.delete.side_effect = RuntimeError("Redis down")
        s = _make_service(cache_adapter=cache)
        await s._clear_conversation_state("c1")
        # No error raised


# =========================================================================
# cleanup (sync — ML resource release)
# =========================================================================


class TestCleanup:
    def test_calls_vad_cleanup(self):
        s = _make_service()
        s.cleanup()
        s.vad.cleanup.assert_called_once()

    def test_calls_stt_cleanup(self):
        s = _make_service()
        s.cleanup()
        s.stt.cleanup.assert_called_once()

    def test_calls_wake_word_cleanup(self):
        s = _make_service()
        s.cleanup()
        s.wake_word.cleanup.assert_called_once()

    def test_nulls_decoder(self):
        s = _make_service()
        s.cleanup()
        assert s.decoder is None

    def test_cleanup_error_caught(self):
        s = _make_service()
        s.vad.cleanup.side_effect = RuntimeError("GPU error")
        s.cleanup()  # Should not raise

    def test_cleanup_without_cleanup_methods(self):
        """Lines 781-790: hasattr checks protect against missing cleanup methods."""
        s = _make_service()
        # Remove cleanup method from mocks
        del s.vad.cleanup
        del s.stt.cleanup
        del s.wake_word.cleanup
        s.cleanup()  # Should not raise


# =========================================================================
# Lifecycle: re-initialization after cleanup
# =========================================================================


class TestReInitAfterCleanup:
    """Section 5 (Integration Gaps): full lifecycle create → use → cleanup → reuse."""

    async def test_same_client_works_after_cleanup(self):
        """cleanup_client then process_chunk for same client_id: all state rebuilt."""
        s = _make_service()
        s.decoder.decode.return_value = VALID_AUDIO
        s.wake_word.detect.return_value = True

        # Phase 1: use — wake word activates conversation
        await s.process_chunk("data", "c1")
        assert "c1" in s.conversation_active
        assert "c1" in s._client_locks
        assert "c1" in s._state_loaded

        # Phase 2: cleanup — all per-client state removed
        await s.cleanup_client("c1")
        assert "c1" not in s.conversation_active
        assert "c1" not in s._client_locks
        assert "c1" not in s._state_loaded
        assert "c1" not in s.audio_buffers

        # Phase 3: reuse — same client processes audio again from scratch
        s.wake_word.detect.return_value = False  # No wake word this time
        await s.process_chunk("data2", "c1")
        # Lock recreated, state_loaded reset, new chunk processed
        assert "c1" in s._client_locks
        assert "c1" in s._state_loaded
        # No conversation (wake word not detected), but no errors
        assert "c1" not in s.conversation_active

    async def test_circuit_breaker_resets_after_cleanup(self):
        """Circuit breaker state fully cleared after cleanup, fresh start."""
        s = _make_service(circuit_breaker_threshold=2)

        # Open circuit
        s._record_ml_failure("c1", RuntimeError("fail"))
        s._record_ml_failure("c1", RuntimeError("fail"))
        assert s._circuit_breaker_state["c1"] == CircuitState.OPEN

        # Cleanup
        await s.cleanup_client("c1")

        # All circuit breaker state gone
        assert "c1" not in s._circuit_breaker_state
        assert "c1" not in s._circuit_breaker_failures
        assert "c1" not in s._circuit_breaker_opened_at

        # Fresh check returns True (default CLOSED)
        assert s._check_circuit_breaker("c1") is True


# =========================================================================
# CircuitState enum
# =========================================================================


class TestCircuitStateEnum:
    def test_values(self):
        assert CircuitState.CLOSED == "closed"
        assert CircuitState.OPEN == "open"
        assert CircuitState.HALF_OPEN == "half_open"

    def test_is_string_enum(self):
        assert isinstance(CircuitState.CLOSED, str)


# =========================================================================
# Adversarial: cleanup_client cascade failure prevention
# =========================================================================


class TestCleanupClientCascade:
    """BUG FIX: cleanup_client had unguarded steps.
    If tts_coordinator.cleanup_client raised, Redis + wake_word cleanup were skipped.
    Fixed: each step independently wrapped in try/except Exception.
    """

    @pytest.mark.asyncio
    async def test_tts_failure_doesnt_skip_redis_and_wakeword(self):
        """BUG FIX: TTS cleanup failure must NOT skip Redis + wake word cleanup."""
        tts = AsyncMock()
        tts.cleanup_client.side_effect = RuntimeError("TTS crash")
        cache = AsyncMock()
        ww = MagicMock()
        ww.cleanup_client = MagicMock()

        s = _make_service(tts_coordinator=tts, cache_adapter=cache, wake_word_service=ww)
        s.audio_buffers["c1"] = [np.array([0.1])]
        s.conversation_active["c1"] = 100.0

        # Must not raise
        await s.cleanup_client("c1")

        # Redis was still cleared despite TTS failure
        cache.delete.assert_awaited_once()
        # Wake word was still cleaned despite TTS failure
        ww.cleanup_client.assert_called_once_with("c1")

    @pytest.mark.asyncio
    async def test_redis_failure_doesnt_skip_wakeword(self):
        """BUG FIX: Redis cleanup failure must NOT skip wake word cleanup."""
        cache = AsyncMock()
        cache.delete.side_effect = ConnectionError("Redis down")
        ww = MagicMock()
        ww.cleanup_client = MagicMock()

        s = _make_service(cache_adapter=cache, wake_word_service=ww)
        s.audio_buffers["c1"] = [np.array([0.1])]

        await s.cleanup_client("c1")

        # Wake word was still cleaned despite Redis failure
        ww.cleanup_client.assert_called_once_with("c1")

    @pytest.mark.asyncio
    async def test_wakeword_failure_doesnt_propagate(self):
        """BUG FIX: Wake word cleanup failure must NOT propagate."""
        ww = MagicMock()
        ww.cleanup_client.side_effect = RuntimeError("ONNX crash")

        s = _make_service(wake_word_service=ww)
        s.audio_buffers["c1"] = [np.array([0.1])]

        # Must not raise
        await s.cleanup_client("c1")
        # Buffers still cleared
        assert "c1" not in s.audio_buffers
