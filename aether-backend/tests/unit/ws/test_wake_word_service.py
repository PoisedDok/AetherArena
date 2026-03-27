"""
Unit Tests: ws/domain/audio/services/wake_word_service.py

Tests WakeWordService: initialization, per-client state, frame-by-frame detection,
threshold comparison, prediction validation, sample rate validation, metrics,
client cleanup, stats, and resource cleanup.

openwakeword is NOT installed. Stubbed in sys.modules before import.
"""

import sys
from types import ModuleType
from unittest.mock import MagicMock, patch
from collections import deque

import numpy as np
import pytest

# Stub openwakeword before any ws.domain.audio imports
if "openwakeword" not in sys.modules:
    _ow = ModuleType("openwakeword")
    _ow.__path__ = []
    _ow_model = ModuleType("openwakeword.model")
    _ow_model.Model = type("Model", (), {})
    sys.modules["openwakeword"] = _ow
    sys.modules["openwakeword.model"] = _ow_model

MODULE = "ws.domain.audio.services.wake_word_service"


# =========================================================================
# Helpers
# =========================================================================


def _mock_oww_model(predictions=None):
    """Create a mock openWakeWord Model.

    Args:
        predictions: dict returned by model.predict(). Default: low confidence.
    """
    model = MagicMock()
    if predictions is None:
        predictions = {"hey_jarvis": 0.1}
    model.predict.return_value = predictions
    model.reset.return_value = None
    return model


def _make_service(
    model_name="hey_jarvis",
    threshold=0.5,
    predictions=None,
    frame_duration_ms=80,
    expected_sample_rate=16000,
    max_buffer_frames=10,
):
    """Create WakeWordService with mocked openWakeWord Model."""
    mock_model = _mock_oww_model(predictions)

    with patch(f"{MODULE}.Model", return_value=mock_model):
        from ws.domain.audio.services.wake_word_service import WakeWordService
        svc = WakeWordService(
            model_name=model_name,
            threshold=threshold,
            frame_duration_ms=frame_duration_ms,
            expected_sample_rate=expected_sample_rate,
            max_buffer_frames=max_buffer_frames,
        )

    # Expose mock for test assertions
    svc._mock_model = mock_model
    return svc


def _audio_frame(n_samples=1280, value=0.5):
    """Create a float32 audio frame of n_samples with a constant value."""
    return np.full(n_samples, value, dtype=np.float32)


# =========================================================================
# __init__
# =========================================================================


class TestInit:
    def test_config_stored(self):
        svc = _make_service(model_name="hey_jarvis", threshold=0.7)
        assert svc.model_name == "hey_jarvis"
        assert svc.threshold == 0.7
        assert svc.expected_sample_rate == 16000
        assert svc.frame_duration_ms == 80

    def test_per_client_state_initialized_empty(self):
        svc = _make_service()
        assert svc._frame_buffers == {}
        assert svc._awaiting_wake_word == {}
        assert svc._detection_counts == {}

    def test_frame_size_calculated_from_config(self):
        svc = _make_service(expected_sample_rate=16000, frame_duration_ms=80)
        # 16000 * 80 / 1000 = 1280
        assert svc._frame_size_samples == 1280

    def test_frame_size_custom(self):
        svc = _make_service(expected_sample_rate=8000, frame_duration_ms=100)
        # 8000 * 100 / 1000 = 800
        assert svc._frame_size_samples == 800

    def test_model_creation_called(self):
        with patch(f"{MODULE}.Model") as mock_cls:
            mock_cls.return_value = _mock_oww_model()
            from ws.domain.audio.services.wake_word_service import WakeWordService
            WakeWordService(
                model_name="hey_jarvis",
                threshold=0.5,
                inference_framework="onnx",
                enable_vad=True,
                vad_threshold=0.5,
            )
        mock_cls.assert_called_once_with(
            wakeword_models=["hey_jarvis"],
            inference_framework="onnx",
            enable_speex_noise_suppression=False,
            vad_threshold=0.5,
        )

    def test_model_creation_vad_disabled(self):
        with patch(f"{MODULE}.Model") as mock_cls:
            mock_cls.return_value = _mock_oww_model()
            from ws.domain.audio.services.wake_word_service import WakeWordService
            WakeWordService(
                model_name="hey_jarvis",
                enable_vad=False,
                vad_threshold=0.5,
            )
        _, kwargs = mock_cls.call_args
        assert kwargs["vad_threshold"] == 0.0

    def test_model_creation_failure_propagates(self):
        with patch(f"{MODULE}.Model", side_effect=RuntimeError("ONNX init failed")):
            from ws.domain.audio.services.wake_word_service import WakeWordService
            with pytest.raises(RuntimeError, match="ONNX init failed"):
                WakeWordService(model_name="bad")

    def test_int16_max_constant(self):
        svc = _make_service()
        assert svc.INT16_MAX == 32767


# =========================================================================
# __init__ — metrics
# =========================================================================


class TestInitMetrics:
    def test_metrics_available_true_when_import_succeeds(self):
        """Line 29: METRICS_AVAILABLE = True."""
        import monitoring.metrics as metrics_mod
        metrics_mod.get_metrics_registry = MagicMock()

        mod_key = "ws.domain.audio.services.wake_word_service"
        saved = sys.modules.pop(mod_key, None)
        try:
            import ws.domain.audio.services.wake_word_service as ww_mod
            assert ww_mod.METRICS_AVAILABLE is True
        finally:
            if saved is not None:
                sys.modules[mod_key] = saved
            else:
                sys.modules.pop(mod_key, None)
            delattr(metrics_mod, "get_metrics_registry")

    def test_metrics_counter_initialized_when_available(self):
        mock_registry = MagicMock()
        mock_counter = MagicMock()
        mock_registry.counter.return_value = mock_counter

        with patch(f"{MODULE}.METRICS_AVAILABLE", True), \
             patch(f"{MODULE}.get_metrics_registry", return_value=mock_registry), \
             patch(f"{MODULE}.Model", return_value=_mock_oww_model()):
            from ws.domain.audio.services.wake_word_service import WakeWordService
            svc = WakeWordService()

        assert svc._wake_word_counter is mock_counter

    def test_metrics_counter_none_when_registry_fails(self):
        with patch(f"{MODULE}.METRICS_AVAILABLE", True), \
             patch(f"{MODULE}.get_metrics_registry", side_effect=AttributeError), \
             patch(f"{MODULE}.Model", return_value=_mock_oww_model()):
            from ws.domain.audio.services.wake_word_service import WakeWordService
            svc = WakeWordService()

        assert svc._wake_word_counter is None

    def test_metrics_counter_none_when_not_available(self):
        with patch(f"{MODULE}.METRICS_AVAILABLE", False), \
             patch(f"{MODULE}.Model", return_value=_mock_oww_model()):
            from ws.domain.audio.services.wake_word_service import WakeWordService
            svc = WakeWordService()

        assert svc._wake_word_counter is None


# =========================================================================
# detect — input validation
# =========================================================================


class TestDetectValidation:
    def test_wrong_sample_rate_returns_false(self):
        svc = _make_service(expected_sample_rate=16000)
        audio = _audio_frame()
        assert svc.detect(audio, sample_rate=8000, client_id="c1") is False

    def test_none_audio_returns_false(self):
        svc = _make_service()
        assert svc.detect(None, sample_rate=16000, client_id="c1") is False

    def test_empty_audio_returns_false(self):
        svc = _make_service()
        assert svc.detect(np.array([]), sample_rate=16000, client_id="c1") is False

    def test_non_ndarray_returns_false(self):
        svc = _make_service()
        assert svc.detect([1, 2, 3], sample_rate=16000, client_id="c1") is False

    def test_non_float32_converted(self, caplog):
        import logging
        svc = _make_service()
        audio = np.ones(1280, dtype=np.float64)

        with caplog.at_level(logging.WARNING):
            svc.detect(audio, sample_rate=16000, client_id="c1")

        assert any("expected float32" in r.message for r in caplog.records)


# =========================================================================
# detect — per-client state
# =========================================================================


class TestDetectPerClientState:
    def test_first_call_initializes_state(self):
        svc = _make_service()
        audio = _audio_frame(640)  # Less than frame_size, won't trigger prediction
        svc.detect(audio, sample_rate=16000, client_id="client-A")

        assert "client-A" in svc._frame_buffers
        assert svc._awaiting_wake_word["client-A"] is True
        assert svc._detection_counts["client-A"] == 0

    def test_multiple_clients_isolated(self):
        svc = _make_service()
        svc.detect(_audio_frame(640), sample_rate=16000, client_id="c1")
        svc.detect(_audio_frame(640), sample_rate=16000, client_id="c2")

        assert "c1" in svc._frame_buffers
        assert "c2" in svc._frame_buffers
        assert svc._frame_buffers["c1"] is not svc._frame_buffers["c2"]

    def test_buffer_uses_deque_with_maxlen(self):
        svc = _make_service(max_buffer_frames=10, frame_duration_ms=80)
        svc.detect(_audio_frame(640), sample_rate=16000, client_id="c1")

        buf = svc._frame_buffers["c1"]
        assert isinstance(buf, deque)
        # maxlen = frame_size * max_buffer_frames = 1280 * 10 = 12800
        assert buf.maxlen == 12800


# =========================================================================
# detect — frame processing
# =========================================================================


class TestDetectFrameProcessing:
    def test_no_detection_below_threshold(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.3})
        audio = _audio_frame(1280)  # Exactly one frame
        result = svc.detect(audio, sample_rate=16000, client_id="c1")
        assert result is False

    def test_detection_at_threshold(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.5})
        audio = _audio_frame(1280)
        result = svc.detect(audio, sample_rate=16000, client_id="c1")
        assert result is True

    def test_detection_above_threshold(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        audio = _audio_frame(1280)
        result = svc.detect(audio, sample_rate=16000, client_id="c1")
        assert result is True

    def test_detection_increments_count(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        audio = _audio_frame(1280)
        svc.detect(audio, sample_rate=16000, client_id="c1")
        assert svc._detection_counts["c1"] == 1

    def test_detection_sets_awaiting_false(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        audio = _audio_frame(1280)
        svc.detect(audio, sample_rate=16000, client_id="c1")
        assert svc._awaiting_wake_word["c1"] is False

    def test_detection_resets_model(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        audio = _audio_frame(1280)
        svc.detect(audio, sample_rate=16000, client_id="c1")
        svc._mock_model.reset.assert_called_once()

    def test_detection_clears_buffer(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        audio = _audio_frame(1280)
        svc.detect(audio, sample_rate=16000, client_id="c1")
        assert len(svc._frame_buffers["c1"]) == 0

    def test_partial_frame_buffered(self):
        svc = _make_service()
        audio = _audio_frame(640)  # Half a frame
        svc.detect(audio, sample_rate=16000, client_id="c1")
        # Buffer should have 640 samples; predict NOT called (need 1280)
        svc._mock_model.predict.assert_not_called()

    def test_accumulated_frames_processed(self):
        svc = _make_service(predictions={"hey_jarvis": 0.1})
        # Send two half-frames
        svc.detect(_audio_frame(640), sample_rate=16000, client_id="c1")
        svc.detect(_audio_frame(640), sample_rate=16000, client_id="c1")
        # Now buffer has 1280 = one full frame; predict called
        svc._mock_model.predict.assert_called_once()

    def test_multiple_frames_processed(self):
        svc = _make_service(predictions={"hey_jarvis": 0.1})
        audio = _audio_frame(2560)  # Two full frames
        svc.detect(audio, sample_rate=16000, client_id="c1")
        assert svc._mock_model.predict.call_count == 2

    def test_float32_to_int16_conversion(self):
        svc = _make_service(predictions={"hey_jarvis": 0.1})
        audio = np.full(1280, 0.5, dtype=np.float32)
        svc.detect(audio, sample_rate=16000, client_id="c1")

        # Verify predict was called with int16 data
        call_args = svc._mock_model.predict.call_args
        frame = call_args[0][0]
        assert frame.dtype == np.int16
        # 0.5 * 32767 = 16383.5 → int16 = 16383
        expected = int(0.5 * 32767)
        assert frame[0] == expected


# =========================================================================
# detect — prediction validation
# =========================================================================


class TestDetectPredictionValidation:
    def test_non_dict_prediction_skipped(self):
        """Line 184: prediction is not dict → warning, continue."""
        svc = _make_service()
        svc._mock_model.predict.return_value = "invalid"
        audio = _audio_frame(1280)
        result = svc.detect(audio, sample_rate=16000, client_id="c1")
        assert result is False

    def test_missing_model_name_key_skipped(self):
        """Line 184: dict without model_name key → warning, continue."""
        svc = _make_service(model_name="hey_jarvis")
        svc._mock_model.predict.return_value = {"wrong_key": 0.9}
        audio = _audio_frame(1280)
        result = svc.detect(audio, sample_rate=16000, client_id="c1")
        assert result is False

    def test_predict_runtime_error_continues(self):
        """Lines 176-181: predict error → log, continue to next frame."""
        svc = _make_service()
        svc._mock_model.predict.side_effect = RuntimeError("model crash")
        audio = _audio_frame(1280)
        result = svc.detect(audio, sample_rate=16000, client_id="c1")
        assert result is False

    def test_predict_value_error_continues(self):
        svc = _make_service()
        svc._mock_model.predict.side_effect = ValueError("bad frame")
        audio = _audio_frame(1280)
        result = svc.detect(audio, sample_rate=16000, client_id="c1")
        assert result is False

    def test_predict_error_logs_error(self, caplog):
        import logging
        svc = _make_service()
        svc._mock_model.predict.side_effect = RuntimeError("crash")
        audio = _audio_frame(1280)
        with caplog.at_level(logging.ERROR):
            svc.detect(audio, sample_rate=16000, client_id="c1")
        assert any("prediction failed" in r.message for r in caplog.records)


# =========================================================================
# detect — metrics
# =========================================================================


class TestDetectMetrics:
    def test_metrics_incremented_on_detection(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        mock_counter = MagicMock()
        svc._wake_word_counter = mock_counter

        audio = _audio_frame(1280)
        svc.detect(audio, sample_rate=16000, client_id="client-12345678")

        mock_counter.inc.assert_called_once_with(
            model="hey_jarvis", client_id="client-1"
        )

    def test_metrics_not_incremented_below_threshold(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.3})
        mock_counter = MagicMock()
        svc._wake_word_counter = mock_counter

        audio = _audio_frame(1280)
        svc.detect(audio, sample_rate=16000, client_id="c1")

        mock_counter.inc.assert_not_called()

    def test_metrics_error_swallowed(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        mock_counter = MagicMock()
        mock_counter.inc.side_effect = AttributeError("broken")
        svc._wake_word_counter = mock_counter

        audio = _audio_frame(1280)
        result = svc.detect(audio, sample_rate=16000, client_id="c1")

        # Detection still succeeds despite metrics failure
        assert result is True


# =========================================================================
# reset
# =========================================================================


class TestReset:
    def test_reset_clears_buffer(self):
        svc = _make_service(predictions={"hey_jarvis": 0.1})
        svc.detect(_audio_frame(640), sample_rate=16000, client_id="c1")
        assert len(svc._frame_buffers["c1"]) > 0

        svc.reset("c1")
        assert len(svc._frame_buffers["c1"]) == 0

    def test_reset_sets_awaiting_true(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        svc.detect(_audio_frame(1280), sample_rate=16000, client_id="c1")
        assert svc._awaiting_wake_word["c1"] is False

        svc.reset("c1")
        assert svc._awaiting_wake_word["c1"] is True

    def test_reset_unknown_client_no_error(self):
        svc = _make_service()
        svc.reset("unknown-client")  # Should not raise


# =========================================================================
# cleanup_client
# =========================================================================


class TestCleanupClient:
    def test_removes_all_client_state(self):
        svc = _make_service(predictions={"hey_jarvis": 0.1})
        svc.detect(_audio_frame(640), sample_rate=16000, client_id="c1")

        assert "c1" in svc._frame_buffers
        assert "c1" in svc._awaiting_wake_word
        assert "c1" in svc._detection_counts

        svc.cleanup_client("c1")

        assert "c1" not in svc._frame_buffers
        assert "c1" not in svc._awaiting_wake_word
        assert "c1" not in svc._detection_counts

    def test_cleanup_unknown_client_no_error(self):
        svc = _make_service()
        svc.cleanup_client("nonexistent")  # Should not raise


# =========================================================================
# is_awaiting_wake_word
# =========================================================================


class TestIsAwaitingWakeWord:
    def test_unknown_client_returns_true(self):
        svc = _make_service()
        assert svc.is_awaiting_wake_word("unknown") is True

    def test_returns_true_after_init(self):
        svc = _make_service(predictions={"hey_jarvis": 0.1})
        svc.detect(_audio_frame(640), sample_rate=16000, client_id="c1")
        assert svc.is_awaiting_wake_word("c1") is True

    def test_returns_false_after_detection(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        svc.detect(_audio_frame(1280), sample_rate=16000, client_id="c1")
        assert svc.is_awaiting_wake_word("c1") is False


# =========================================================================
# get_stats
# =========================================================================


class TestGetStats:
    def test_per_client_stats(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        svc.detect(_audio_frame(1280), sample_rate=16000, client_id="client-12345678")

        stats = svc.get_stats(client_id="client-12345678")

        assert stats["model"] == "hey_jarvis"
        assert stats["threshold"] == 0.5
        assert stats["client_id"] == "client-1"
        assert stats["awaiting_wake_word"] is False
        assert stats["detection_count"] == 1
        assert stats["buffer_size"] == 0  # Cleared after detection

    def test_per_client_stats_unknown_client(self):
        svc = _make_service()
        stats = svc.get_stats(client_id="unknown-client-id")

        assert stats["awaiting_wake_word"] is True
        assert stats["detection_count"] == 0
        assert stats["buffer_size"] == 0

    def test_global_stats(self):
        svc = _make_service(threshold=0.5, predictions={"hey_jarvis": 0.9})
        svc.detect(_audio_frame(1280), sample_rate=16000, client_id="c1")
        svc.detect(_audio_frame(1280), sample_rate=16000, client_id="c2")

        stats = svc.get_stats()

        assert stats["model"] == "hey_jarvis"
        assert stats["threshold"] == 0.5
        assert stats["total_clients"] == 2
        assert stats["total_detections"] == 2

    def test_global_stats_empty(self):
        svc = _make_service()
        stats = svc.get_stats()

        assert stats["total_clients"] == 0
        assert stats["total_detections"] == 0


# =========================================================================
# cleanup
# =========================================================================


class TestCleanup:
    def test_normal_cleanup(self):
        svc = _make_service()
        svc.cleanup()

        svc._mock_model.reset.assert_called_once()
        assert svc.model is None

    def test_cleanup_when_model_already_none(self):
        svc = _make_service()
        svc.model = None
        svc.cleanup()  # Should not raise
        assert svc.model is None

    def test_cleanup_idempotent(self):
        svc = _make_service()
        svc.cleanup()
        svc.cleanup()  # Second call safe
        assert svc.model is None

    def test_cleanup_error_logs_warning(self, caplog):
        import logging
        svc = _make_service()
        svc._mock_model.reset.side_effect = RuntimeError("reset failed")
        # Put real mock back (cleanup uses svc.model, not svc._mock_model)
        svc.model = svc._mock_model

        with caplog.at_level(logging.WARNING):
            svc.cleanup()

        assert any("WakeWord cleanup failed" in r.message for r in caplog.records)

    def test_cleanup_logs_success(self, caplog):
        import logging
        svc = _make_service()

        with caplog.at_level(logging.INFO):
            svc.cleanup()

        assert any("WakeWord model cleaned up" in r.message for r in caplog.records)

    def test_cleanup_pipeline_missing_attribute(self):
        """Model attribute missing entirely."""
        svc = _make_service()
        del svc.model
        svc.cleanup()  # Should not raise
