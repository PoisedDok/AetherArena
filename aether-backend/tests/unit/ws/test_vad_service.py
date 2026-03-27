"""
Unit Tests: ws/domain/audio/services/vad_service.py

Tests PyannotVadService: device auto-detection, model loading, speech detection,
segment extraction, metrics integration, cleanup, and error handling.

pyannote.audio is installed but model files are NOT downloaded in test env.
All Model/Pipeline creation is patched.
"""

import sys
from types import ModuleType
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
import torch

# Stub openwakeword to allow ws.domain.audio package import
if "openwakeword" not in sys.modules:
    _ow = ModuleType("openwakeword")
    _ow.__path__ = []
    _ow_model = ModuleType("openwakeword.model")
    _ow_model.Model = type("Model", (), {})
    sys.modules["openwakeword"] = _ow
    sys.modules["openwakeword.model"] = _ow_model

MODULE = "ws.domain.audio.services.vad_service"


# =========================================================================
# Helpers
# =========================================================================


class FakeSegment:
    """Mimics pyannote Segment with start/end attributes."""
    def __init__(self, start, end):
        self.start = start
        self.end = end


class FakeAnnotation:
    """Mimics pyannote Annotation returned by VAD pipeline."""
    def __init__(self, items):
        self._items = items

    def itertracks(self):
        return iter(self._items)


def _mock_pyannote_model():
    """Create a mock pyannote Model."""
    model = MagicMock()
    model.to.return_value = model
    return model


def _mock_pipeline(segments=None):
    """Create a mock VoiceActivityDetection pipeline."""
    pipeline = MagicMock()
    if segments is None:
        segments = [(FakeSegment(0.5, 1.2), "SPEECH", "speaker")]
    annotation = FakeAnnotation(segments)
    pipeline.return_value = annotation
    pipeline.instantiate = MagicMock()
    return pipeline


def _make_service(device="cpu", pipeline=None):
    """Create PyannotVadService with mocked model loading."""
    mock_model = _mock_pyannote_model()
    if pipeline is None:
        pipeline = _mock_pipeline()

    with patch(f"{MODULE}.Model") as mock_model_cls, \
         patch(f"{MODULE}.VoiceActivityDetection") as mock_vad_cls, \
         patch(f"{MODULE}.torch") as mock_torch:
        mock_model_cls.from_pretrained.return_value = mock_model
        mock_vad_cls.return_value = pipeline
        mock_torch.cuda.is_available.return_value = False
        mock_torch.backends.mps.is_available.return_value = False
        mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)

        from ws.domain.audio.services.vad_service import PyannotVadService
        svc = PyannotVadService(model_id="test-model", device=device)

    # Assign pipeline so tests can control it
    svc.pipeline = pipeline
    return svc


# =========================================================================
# __init__ — device auto-detection
# =========================================================================


class TestInitDeviceDetection:
    def test_explicit_device_skips_autodetect(self):
        svc = _make_service(device="cpu")
        assert svc.device == "cpu"

    def test_cuda_autodetect(self):
        with patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection") as mock_vad_cls, \
             patch(f"{MODULE}.torch") as mock_torch:
            model = _mock_pyannote_model()
            mock_model_cls.from_pretrained.return_value = model
            mock_vad_cls.return_value = _mock_pipeline()
            mock_torch.cuda.is_available.return_value = True
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            svc = PyannotVadService(model_id="test", device=None)

        assert svc.device == "cuda"

    def test_mps_autodetect(self):
        with patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection") as mock_vad_cls, \
             patch(f"{MODULE}.torch") as mock_torch:
            model = _mock_pyannote_model()
            mock_model_cls.from_pretrained.return_value = model
            mock_vad_cls.return_value = _mock_pipeline()
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = True

            from ws.domain.audio.services.vad_service import PyannotVadService
            svc = PyannotVadService(model_id="test", device=None)

        assert svc.device == "mps"

    def test_cpu_fallback_autodetect(self):
        with patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection") as mock_vad_cls, \
             patch(f"{MODULE}.torch") as mock_torch:
            model = _mock_pyannote_model()
            mock_model_cls.from_pretrained.return_value = model
            mock_vad_cls.return_value = _mock_pipeline()
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            svc = PyannotVadService(model_id="test", device=None)

        assert svc.device == "cpu"


# =========================================================================
# __init__ — model loading
# =========================================================================


class TestInitModelLoading:
    def test_model_loaded_and_pipeline_created(self):
        pipeline = _mock_pipeline()
        svc = _make_service(pipeline=pipeline)
        assert svc.pipeline is pipeline

    def test_model_none_raises_runtime_error(self):
        """Line 87-88: Model.from_pretrained returns None."""
        with patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection"), \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_model_cls.from_pretrained.return_value = None
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            with pytest.raises(RuntimeError, match="Failed to initialize VAD service"):
                PyannotVadService(model_id="bad", device="cpu")

    def test_model_loading_runtime_error(self):
        with patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection"), \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_model_cls.from_pretrained.side_effect = RuntimeError("No model")
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            with pytest.raises(RuntimeError, match="Failed to initialize VAD service"):
                PyannotVadService(model_id="bad", device="cpu")

    def test_model_loading_oserror(self):
        with patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection"), \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_model_cls.from_pretrained.side_effect = OSError("Network error")
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            with pytest.raises(RuntimeError, match="Failed to initialize VAD service"):
                PyannotVadService(model_id="bad", device="cpu")

    def test_init_error_logs_detailed_causes(self, caplog):
        import logging
        with patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection"), \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_model_cls.from_pretrained.side_effect = RuntimeError("fail")
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            with caplog.at_level(logging.ERROR):
                with pytest.raises(RuntimeError):
                    PyannotVadService(model_id="pyannote/test", device="cpu", hf_token="tok123")

        assert any("Possible causes" in r.message for r in caplog.records)
        assert any("SET" in r.message for r in caplog.records)

    def test_init_error_logs_token_not_set(self, caplog):
        import logging
        with patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection"), \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_model_cls.from_pretrained.side_effect = RuntimeError("fail")
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            with caplog.at_level(logging.ERROR):
                with pytest.raises(RuntimeError):
                    PyannotVadService(model_id="test", device="cpu", hf_token=None)

        assert any("NOT SET" in r.message for r in caplog.records)

    def test_pipeline_instantiated_with_hyperparameters(self):
        pipeline = _mock_pipeline()

        with patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection") as mock_vad_cls, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_model_cls.from_pretrained.return_value = _mock_pyannote_model()
            mock_vad_cls.return_value = pipeline
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            PyannotVadService(
                model_id="test", device="cpu",
                min_duration_on=0.5, min_duration_off=0.3,
            )

        pipeline.instantiate.assert_called_once_with({
            "min_duration_on": 0.5,
            "min_duration_off": 0.3,
        })


# =========================================================================
# __init__ — metrics
# =========================================================================


class TestInitMetrics:
    def test_metrics_available_true_when_import_succeeds(self):
        """Line 26: METRICS_AVAILABLE = True when get_metrics_registry exists."""
        import monitoring.metrics as metrics_mod

        metrics_mod.get_metrics_registry = MagicMock()
        mod_key = "ws.domain.audio.services.vad_service"
        saved_mod = sys.modules.pop(mod_key, None)

        try:
            import ws.domain.audio.services.vad_service as vad_mod
            assert vad_mod.METRICS_AVAILABLE is True
        finally:
            if saved_mod is not None:
                sys.modules[mod_key] = saved_mod
            else:
                sys.modules.pop(mod_key, None)
            delattr(metrics_mod, "get_metrics_registry")

    def test_metrics_counter_initialized_when_available(self):
        mock_registry = MagicMock()
        mock_counter = MagicMock()
        mock_registry.counter.return_value = mock_counter

        with patch(f"{MODULE}.METRICS_AVAILABLE", True), \
             patch(f"{MODULE}.get_metrics_registry", return_value=mock_registry), \
             patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection") as mock_vad_cls, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_model_cls.from_pretrained.return_value = _mock_pyannote_model()
            mock_vad_cls.return_value = _mock_pipeline()
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            svc = PyannotVadService(device="cpu")

        assert svc._vad_segments_counter is mock_counter

    def test_metrics_counter_none_when_registry_fails(self):
        with patch(f"{MODULE}.METRICS_AVAILABLE", True), \
             patch(f"{MODULE}.get_metrics_registry", side_effect=AttributeError), \
             patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection") as mock_vad_cls, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_model_cls.from_pretrained.return_value = _mock_pyannote_model()
            mock_vad_cls.return_value = _mock_pipeline()
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            svc = PyannotVadService(device="cpu")

        assert svc._vad_segments_counter is None

    def test_metrics_counter_none_when_not_available(self):
        with patch(f"{MODULE}.METRICS_AVAILABLE", False), \
             patch(f"{MODULE}.Model") as mock_model_cls, \
             patch(f"{MODULE}.VoiceActivityDetection") as mock_vad_cls, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_model_cls.from_pretrained.return_value = _mock_pyannote_model()
            mock_vad_cls.return_value = _mock_pipeline()
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.vad_service import PyannotVadService
            svc = PyannotVadService(device="cpu")

        assert svc._vad_segments_counter is None


# =========================================================================
# detect_speech
# =========================================================================


class TestDetectSpeech:
    def test_none_input_returns_empty(self):
        """Bug fix: None input returns [] instead of AttributeError."""
        svc = _make_service()
        assert svc.detect_speech(None) == []

    def test_empty_array_returns_empty(self):
        svc = _make_service()
        assert svc.detect_speech(np.array([])) == []

    def test_segments_from_tuple_with_segment_objects(self):
        """Lines 152-156: itertracks returns (Segment, track, label) tuples."""
        segments_data = [
            (FakeSegment(0.5, 1.2), "SPEECH", "speaker1"),
            (FakeSegment(2.0, 3.5), "SPEECH", "speaker1"),
        ]
        pipeline = _mock_pipeline(segments=segments_data)
        svc = _make_service(pipeline=pipeline)

        audio = np.random.randn(16000).astype(np.float32)
        with patch(f"{MODULE}.torch") as mock_torch:
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)
            result = svc.detect_speech(audio)

        assert len(result) == 2
        assert result[0] == (0.5, 1.2)
        assert result[1] == (2.0, 3.5)

    def test_segments_from_raw_segment_objects(self):
        """Lines 160-162: itertracks returns raw Segment objects (not tuples)."""
        segments_data = [
            FakeSegment(1.0, 2.0),
            FakeSegment(3.0, 4.0),
        ]
        pipeline = _mock_pipeline(segments=segments_data)
        svc = _make_service(pipeline=pipeline)

        audio = np.random.randn(16000).astype(np.float32)
        with patch(f"{MODULE}.torch") as mock_torch:
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)
            result = svc.detect_speech(audio)

        assert len(result) == 2
        assert result[0] == (1.0, 2.0)
        assert result[1] == (3.0, 4.0)

    def test_segments_from_tuple_without_start_end(self):
        """Lines 157-159: Fallback for tuple items without start/end attributes."""
        # item is a tuple of plain numbers, no start/end attributes
        segments_data = [
            (0.5, 1.2),
            (2.0, 3.5),
        ]
        pipeline = _mock_pipeline(segments=segments_data)
        svc = _make_service(pipeline=pipeline)

        audio = np.random.randn(16000).astype(np.float32)
        with patch(f"{MODULE}.torch") as mock_torch:
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)
            result = svc.detect_speech(audio)

        assert len(result) == 2
        assert result[0] == (0.5, 1.2)
        assert result[1] == (2.0, 3.5)

    def test_no_segments_returns_empty(self):
        pipeline = _mock_pipeline(segments=[])
        svc = _make_service(pipeline=pipeline)

        audio = np.random.randn(16000).astype(np.float32)
        with patch(f"{MODULE}.torch") as mock_torch:
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)
            result = svc.detect_speech(audio)

        assert result == []

    def test_1d_audio_reshaped_to_2d(self):
        """Line 135-136: 1D audio is reshaped to (1, N)."""
        pipeline = _mock_pipeline(segments=[])
        svc = _make_service(pipeline=pipeline)

        audio = np.random.randn(16000).astype(np.float32)
        assert len(audio.shape) == 1  # Confirm 1D

        with patch(f"{MODULE}.torch") as mock_torch:
            mock_tensor = MagicMock()
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = mock_tensor
            svc.detect_speech(audio)

        # Pipeline was called (audio was reshaped and processed)
        pipeline.assert_called_once()

    def test_2d_audio_not_reshaped(self):
        """Line 135: 2D audio is NOT reshaped."""
        pipeline = _mock_pipeline(segments=[])
        svc = _make_service(pipeline=pipeline)

        audio = np.random.randn(1, 16000).astype(np.float32)
        assert len(audio.shape) == 2  # Confirm 2D

        with patch(f"{MODULE}.torch") as mock_torch:
            mock_tensor = MagicMock()
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = mock_tensor
            svc.detect_speech(audio)

        pipeline.assert_called_once()

    def test_runtime_error_returns_empty(self):
        pipeline = MagicMock()
        pipeline.side_effect = RuntimeError("CUDA error")
        svc = _make_service(pipeline=pipeline)

        audio = np.random.randn(16000).astype(np.float32)
        with patch(f"{MODULE}.torch") as mock_torch:
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)
            result = svc.detect_speech(audio)

        assert result == []

    def test_detection_error_logs_error(self, caplog):
        import logging
        pipeline = MagicMock()
        pipeline.side_effect = RuntimeError("Pipeline crash")
        svc = _make_service(pipeline=pipeline)

        audio = np.random.randn(16000).astype(np.float32)
        with caplog.at_level(logging.ERROR):
            with patch(f"{MODULE}.torch") as mock_torch:
                mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)
                svc.detect_speech(audio)

        assert any("VAD detection failed" in r.message for r in caplog.records)


# =========================================================================
# detect_speech — metrics
# =========================================================================


class TestDetectSpeechMetrics:
    def test_metrics_incremented_on_segments(self):
        segments_data = [(FakeSegment(0.5, 1.2), "SPEECH", "spk")]
        pipeline = _mock_pipeline(segments=segments_data)
        svc = _make_service(pipeline=pipeline)

        mock_counter = MagicMock()
        svc._vad_segments_counter = mock_counter

        audio = np.random.randn(16000).astype(np.float32)
        with patch(f"{MODULE}.torch") as mock_torch:
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)
            svc.detect_speech(audio)

        mock_counter.inc.assert_called_once_with(value=1, device=svc.device)

    def test_metrics_not_incremented_on_empty_segments(self):
        pipeline = _mock_pipeline(segments=[])
        svc = _make_service(pipeline=pipeline)

        mock_counter = MagicMock()
        svc._vad_segments_counter = mock_counter

        audio = np.random.randn(16000).astype(np.float32)
        with patch(f"{MODULE}.torch") as mock_torch:
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)
            svc.detect_speech(audio)

        mock_counter.inc.assert_not_called()

    def test_metrics_error_swallowed(self):
        segments_data = [(FakeSegment(0.5, 1.2), "SPEECH", "spk")]
        pipeline = _mock_pipeline(segments=segments_data)
        svc = _make_service(pipeline=pipeline)

        mock_counter = MagicMock()
        mock_counter.inc.side_effect = AttributeError("broken")
        svc._vad_segments_counter = mock_counter

        audio = np.random.randn(16000).astype(np.float32)
        with patch(f"{MODULE}.torch") as mock_torch:
            mock_torch.from_numpy.return_value.float.return_value.to.return_value = torch.zeros(1, 16000)
            result = svc.detect_speech(audio)

        # Returns segments despite metrics failure
        assert len(result) == 1


# =========================================================================
# cleanup
# =========================================================================


class TestCleanup:
    def test_normal_cleanup(self):
        svc = _make_service()
        mock_segmentation = MagicMock()
        svc.pipeline.segmentation = mock_segmentation

        svc.cleanup()

        mock_segmentation.to.assert_called_with("cpu")
        assert svc.pipeline is None

    def test_cleanup_without_segmentation(self):
        svc = _make_service()
        del svc.pipeline.segmentation

        svc.cleanup()

        assert svc.pipeline is None

    def test_cleanup_when_pipeline_already_none(self):
        svc = _make_service()
        svc.pipeline = None

        svc.cleanup()  # Should not raise

        assert svc.pipeline is None

    def test_cleanup_idempotent(self):
        svc = _make_service()
        svc.pipeline.segmentation = MagicMock()

        svc.cleanup()
        svc.cleanup()  # Second call safe

        assert svc.pipeline is None

    def test_cleanup_error_logs_warning(self, caplog):
        import logging
        svc = _make_service()
        mock_seg = MagicMock()
        mock_seg.to.side_effect = RuntimeError("GPU error")
        svc.pipeline.segmentation = mock_seg

        with caplog.at_level(logging.WARNING):
            svc.cleanup()

        assert any("VAD cleanup failed" in r.message for r in caplog.records)

    def test_cleanup_logs_success(self, caplog):
        import logging
        svc = _make_service()
        svc.pipeline.segmentation = MagicMock()

        with caplog.at_level(logging.INFO):
            svc.cleanup()

        assert any("VAD model cleaned up" in r.message for r in caplog.records)

    def test_cleanup_pipeline_missing_attribute(self):
        """Pipeline exists but no pipeline attribute (hasattr guard)."""
        svc = _make_service()
        del svc.pipeline

        svc.cleanup()  # Should not raise
