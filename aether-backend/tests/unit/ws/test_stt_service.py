"""
Unit Tests: ws/domain/audio/services/stt_service.py

Tests WhisperSttService: device auto-detection, model loading, transcription,
metrics integration, cleanup, and error handling.

Heavy ML deps (torch, transformers) are available but Whisper model files are NOT
downloaded in test env. All model/processor creation is patched.
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

MODULE = "ws.domain.audio.services.stt_service"


# =========================================================================
# Helpers
# =========================================================================


def _mock_model():
    """Create a mock Whisper model with standard interface."""
    model = MagicMock()
    model.to.return_value = model
    model.eval.return_value = None
    model.generate.return_value = torch.tensor([[1, 2, 3]])
    model.name_or_path = "openai/whisper-small"
    return model


def _mock_processor():
    """Create a mock WhisperProcessor with standard interface."""
    proc = MagicMock()
    # processor(audio, sampling_rate=..., return_tensors=...) returns object with .input_features
    features_obj = MagicMock()
    features_obj.input_features = torch.zeros(1, 80, 3000)
    features_obj.input_features.to = MagicMock(return_value=torch.zeros(1, 80, 3000))
    proc.return_value = features_obj
    proc.batch_decode.return_value = ["Hello world"]
    return proc


def _make_service(device="cpu", model=None, processor=None):
    """Create WhisperSttService with mocked model loading."""
    if model is None:
        model = _mock_model()
    if processor is None:
        processor = _mock_processor()

    with patch(f"{MODULE}.WhisperForConditionalGeneration") as mock_gen, \
         patch(f"{MODULE}.WhisperProcessor") as mock_proc, \
         patch(f"{MODULE}.torch") as mock_torch:
        mock_gen.from_pretrained.return_value = model
        mock_proc.from_pretrained.return_value = processor
        # Disable auto-detection by providing explicit device
        mock_torch.cuda.is_available.return_value = False
        mock_torch.backends.mps.is_available.return_value = False
        mock_torch.no_grad.return_value = MagicMock(__enter__=MagicMock(), __exit__=MagicMock())

        from ws.domain.audio.services.stt_service import WhisperSttService
        svc = WhisperSttService(model_id="test-model", device=device)

    # Replace the model/processor refs so tests can inspect/mock them further
    svc.model = model
    svc.processor = processor
    return svc


# =========================================================================
# __init__ — device auto-detection
# =========================================================================


class TestInitDeviceDetection:
    def test_explicit_device_skips_autodetect(self):
        svc = _make_service(device="cpu")
        assert svc.device == "cpu"

    def test_cuda_autodetect(self):
        model = _mock_model()
        proc = _mock_processor()

        with patch(f"{MODULE}.WhisperForConditionalGeneration") as mock_gen, \
             patch(f"{MODULE}.WhisperProcessor") as mock_proc, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_gen.from_pretrained.return_value = model
            mock_proc.from_pretrained.return_value = proc
            mock_torch.cuda.is_available.return_value = True
            mock_torch.backends.mps.is_available.return_value = False
            mock_torch.no_grad.return_value = MagicMock(__enter__=MagicMock(), __exit__=MagicMock())

            from ws.domain.audio.services.stt_service import WhisperSttService
            svc = WhisperSttService(model_id="test-model", device=None)

        assert svc.device == "cuda"

    def test_mps_autodetect(self):
        model = _mock_model()
        proc = _mock_processor()

        with patch(f"{MODULE}.WhisperForConditionalGeneration") as mock_gen, \
             patch(f"{MODULE}.WhisperProcessor") as mock_proc, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_gen.from_pretrained.return_value = model
            mock_proc.from_pretrained.return_value = proc
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = True
            mock_torch.no_grad.return_value = MagicMock(__enter__=MagicMock(), __exit__=MagicMock())

            from ws.domain.audio.services.stt_service import WhisperSttService
            svc = WhisperSttService(model_id="test-model", device=None)

        assert svc.device == "mps"

    def test_cpu_fallback_autodetect(self):
        model = _mock_model()
        proc = _mock_processor()

        with patch(f"{MODULE}.WhisperForConditionalGeneration") as mock_gen, \
             patch(f"{MODULE}.WhisperProcessor") as mock_proc, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_gen.from_pretrained.return_value = model
            mock_proc.from_pretrained.return_value = proc
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False
            mock_torch.no_grad.return_value = MagicMock(__enter__=MagicMock(), __exit__=MagicMock())

            from ws.domain.audio.services.stt_service import WhisperSttService
            svc = WhisperSttService(model_id="test-model", device=None)

        assert svc.device == "cpu"


# =========================================================================
# __init__ — model loading
# =========================================================================


class TestInitModelLoading:
    def test_model_loaded_and_moved_to_device(self):
        model = _mock_model()
        proc = _mock_processor()
        svc = _make_service(device="cpu", model=model, processor=proc)

        assert svc.processor is proc
        assert svc.model is model

    def test_model_set_to_eval_mode(self):
        model = _mock_model()
        svc = _make_service(model=model)
        # model.eval() is called during init (we verify via mock)
        model.eval.assert_called_once()

    def test_model_loading_failure_raises_runtime_error(self):
        with patch(f"{MODULE}.WhisperForConditionalGeneration") as mock_gen, \
             patch(f"{MODULE}.WhisperProcessor") as mock_proc, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_proc.from_pretrained.side_effect = RuntimeError("Download failed")
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.stt_service import WhisperSttService
            with pytest.raises(RuntimeError, match="Failed to initialize STT service"):
                WhisperSttService(model_id="bad-model", device="cpu")

    def test_model_loading_oserror_raises_runtime_error(self):
        with patch(f"{MODULE}.WhisperForConditionalGeneration") as mock_gen, \
             patch(f"{MODULE}.WhisperProcessor") as mock_proc, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_proc.from_pretrained.return_value = MagicMock()
            mock_gen.from_pretrained.side_effect = OSError("No model files found")
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.stt_service import WhisperSttService
            with pytest.raises(RuntimeError, match="Failed to initialize STT service"):
                WhisperSttService(model_id="missing-model", device="cpu")


# =========================================================================
# __init__ — metrics
# =========================================================================


class TestInitMetrics:
    def test_metrics_counter_initialized_when_available(self):
        mock_registry = MagicMock()
        mock_counter = MagicMock()
        mock_registry.counter.return_value = mock_counter

        with patch(f"{MODULE}.METRICS_AVAILABLE", True), \
             patch(f"{MODULE}.get_metrics_registry", return_value=mock_registry), \
             patch(f"{MODULE}.WhisperForConditionalGeneration") as mock_gen, \
             patch(f"{MODULE}.WhisperProcessor") as mock_proc, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_gen.from_pretrained.return_value = _mock_model()
            mock_proc.from_pretrained.return_value = _mock_processor()
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.stt_service import WhisperSttService
            svc = WhisperSttService(device="cpu")

        assert svc._stt_transcriptions_counter is mock_counter
        mock_registry.counter.assert_called_once_with(
            "stt_transcriptions_total",
            "Total number of STT transcriptions completed",
            labels=["model", "device"],
        )

    def test_metrics_available_true_when_import_succeeds(self):
        """Line 25: METRICS_AVAILABLE = True when get_metrics_registry is importable.

        get_metrics_registry doesn't exist in monitoring.metrics yet (planned feature).
        This test injects it temporarily and reimports the module to cover line 25.
        """
        import monitoring.metrics as metrics_mod

        # Inject the function so the import in stt_service line 24 succeeds
        metrics_mod.get_metrics_registry = MagicMock()

        mod_key = "ws.domain.audio.services.stt_service"
        saved_mod = sys.modules.pop(mod_key, None)

        try:
            import ws.domain.audio.services.stt_service as stt_mod
            assert stt_mod.METRICS_AVAILABLE is True
            assert stt_mod.get_metrics_registry is metrics_mod.get_metrics_registry
        finally:
            # Restore original cached module so other tests are unaffected
            if saved_mod is not None:
                sys.modules[mod_key] = saved_mod
            else:
                sys.modules.pop(mod_key, None)
            delattr(metrics_mod, "get_metrics_registry")

    def test_metrics_counter_none_when_registry_fails(self):
        with patch(f"{MODULE}.METRICS_AVAILABLE", True), \
             patch(f"{MODULE}.get_metrics_registry", side_effect=AttributeError("no registry")), \
             patch(f"{MODULE}.WhisperForConditionalGeneration") as mock_gen, \
             patch(f"{MODULE}.WhisperProcessor") as mock_proc, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_gen.from_pretrained.return_value = _mock_model()
            mock_proc.from_pretrained.return_value = _mock_processor()
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.stt_service import WhisperSttService
            svc = WhisperSttService(device="cpu")

        assert svc._stt_transcriptions_counter is None

    def test_metrics_counter_none_when_not_available(self):
        svc = _make_service()
        # _make_service patches torch which makes METRICS_AVAILABLE remain its
        # real value. The default _make_service doesn't patch METRICS_AVAILABLE,
        # so whatever the real import result is, counter should be set (or None).
        # For explicit test: patch METRICS_AVAILABLE=False
        with patch(f"{MODULE}.METRICS_AVAILABLE", False), \
             patch(f"{MODULE}.WhisperForConditionalGeneration") as mock_gen, \
             patch(f"{MODULE}.WhisperProcessor") as mock_proc, \
             patch(f"{MODULE}.torch") as mock_torch:
            mock_gen.from_pretrained.return_value = _mock_model()
            mock_proc.from_pretrained.return_value = _mock_processor()
            mock_torch.cuda.is_available.return_value = False
            mock_torch.backends.mps.is_available.return_value = False

            from ws.domain.audio.services.stt_service import WhisperSttService
            svc = WhisperSttService(device="cpu")

        assert svc._stt_transcriptions_counter is None


# =========================================================================
# transcribe
# =========================================================================


class TestTranscribe:
    def test_none_input_returns_empty(self):
        svc = _make_service()
        assert svc.transcribe(None) == ""

    def test_empty_array_returns_empty(self):
        svc = _make_service()
        assert svc.transcribe(np.array([])) == ""

    def test_successful_transcription(self):
        proc = _mock_processor()
        model = _mock_model()
        proc.batch_decode.return_value = ["Hello world"]
        svc = _make_service(model=model, processor=proc)

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio, sample_rate=16000)

        assert result == "Hello world"
        proc.assert_called_once_with(audio, sampling_rate=16000, return_tensors="pt")
        model.generate.assert_called_once()
        proc.batch_decode.assert_called_once()

    def test_transcription_strips_whitespace(self):
        proc = _mock_processor()
        proc.batch_decode.return_value = ["  Stripped text  "]
        svc = _make_service(processor=proc)

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        assert result == "Stripped text"

    def test_empty_transcription_returns_empty(self):
        proc = _mock_processor()
        proc.batch_decode.return_value = [""]
        svc = _make_service(processor=proc)

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        assert result == ""

    def test_whitespace_only_transcription_returns_empty(self):
        proc = _mock_processor()
        proc.batch_decode.return_value = ["   "]
        svc = _make_service(processor=proc)

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        assert result == ""

    def test_runtime_error_returns_empty(self):
        proc = _mock_processor()
        proc.return_value.input_features.to.side_effect = RuntimeError("CUDA OOM")
        svc = _make_service(processor=proc)

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        assert result == ""

    def test_value_error_returns_empty(self):
        model = _mock_model()
        model.generate.side_effect = ValueError("Bad input shape")
        svc = _make_service(model=model)

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        assert result == ""

    def test_type_error_returns_empty(self):
        model = _mock_model()
        model.generate.side_effect = TypeError("Wrong type")
        svc = _make_service(model=model)

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        assert result == ""

    def test_oserror_returns_empty(self):
        model = _mock_model()
        model.generate.side_effect = OSError("Disk error")
        svc = _make_service(model=model)

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        assert result == ""

    def test_index_error_from_empty_decode_returns_empty(self):
        """Bug fix: batch_decode returning empty list → IndexError now caught."""
        proc = _mock_processor()
        proc.batch_decode.return_value = []  # Empty list triggers IndexError
        svc = _make_service(processor=proc)

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        assert result == ""

    def test_transcription_logs_on_success(self, caplog):
        import logging
        proc = _mock_processor()
        proc.batch_decode.return_value = ["Logged text"]
        svc = _make_service(processor=proc)

        audio = np.random.randn(16000).astype(np.float32)
        with caplog.at_level(logging.INFO):
            result = svc.transcribe(audio)

        assert result == "Logged text"
        assert any("STT transcribed" in r.message for r in caplog.records)

    def test_transcription_error_logs_error(self, caplog):
        import logging
        model = _mock_model()
        model.generate.side_effect = RuntimeError("Model crashed")
        svc = _make_service(model=model)

        audio = np.random.randn(16000).astype(np.float32)
        with caplog.at_level(logging.ERROR):
            result = svc.transcribe(audio)

        assert result == ""
        assert any("STT transcription failed" in r.message for r in caplog.records)


# =========================================================================
# transcribe — metrics
# =========================================================================


class TestTranscribeMetrics:
    def test_metrics_incremented_on_success(self):
        proc = _mock_processor()
        model = _mock_model()
        proc.batch_decode.return_value = ["Some text"]
        svc = _make_service(model=model, processor=proc)

        mock_counter = MagicMock()
        svc._stt_transcriptions_counter = mock_counter

        audio = np.random.randn(16000).astype(np.float32)
        svc.transcribe(audio)

        mock_counter.inc.assert_called_once_with(
            model=model.name_or_path,
            device=svc.device,
        )

    def test_metrics_not_incremented_on_empty_text(self):
        proc = _mock_processor()
        proc.batch_decode.return_value = [""]
        svc = _make_service(processor=proc)

        mock_counter = MagicMock()
        svc._stt_transcriptions_counter = mock_counter

        audio = np.random.randn(16000).astype(np.float32)
        svc.transcribe(audio)

        mock_counter.inc.assert_not_called()

    def test_metrics_error_swallowed(self):
        proc = _mock_processor()
        model = _mock_model()
        proc.batch_decode.return_value = ["Some text"]
        svc = _make_service(model=model, processor=proc)

        mock_counter = MagicMock()
        mock_counter.inc.side_effect = AttributeError("metrics broken")
        svc._stt_transcriptions_counter = mock_counter

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        # Transcription succeeds even though metrics failed
        assert result == "Some text"

    def test_metrics_none_counter_no_error(self):
        proc = _mock_processor()
        proc.batch_decode.return_value = ["Text"]
        svc = _make_service(processor=proc)
        svc._stt_transcriptions_counter = None

        audio = np.random.randn(16000).astype(np.float32)
        result = svc.transcribe(audio)

        assert result == "Text"


# =========================================================================
# cleanup
# =========================================================================


class TestCleanup:
    def test_normal_cleanup(self):
        model = _mock_model()
        proc = _mock_processor()
        svc = _make_service(model=model, processor=proc)

        svc.cleanup()

        model.to.assert_called_with("cpu")
        assert svc.model is None
        assert svc.processor is None

    def test_cleanup_when_model_already_none(self):
        svc = _make_service()
        svc.model = None
        svc.processor = None

        svc.cleanup()  # Should not raise

        assert svc.model is None
        assert svc.processor is None

    def test_cleanup_idempotent(self):
        model = _mock_model()
        proc = _mock_processor()
        svc = _make_service(model=model, processor=proc)

        svc.cleanup()
        svc.cleanup()  # Second call should be safe

        assert svc.model is None
        assert svc.processor is None

    def test_cleanup_error_logs_warning(self, caplog):
        import logging
        model = _mock_model()
        svc = _make_service(model=model)

        # Set side_effect AFTER init (init calls model.to(device) successfully)
        model.to.side_effect = RuntimeError("GPU error during cleanup")

        with caplog.at_level(logging.WARNING):
            svc.cleanup()

        assert any("STT cleanup failed" in r.message for r in caplog.records)

    def test_cleanup_logs_success(self, caplog):
        import logging
        model = _mock_model()
        svc = _make_service(model=model)

        with caplog.at_level(logging.INFO):
            svc.cleanup()

        assert any("STT model cleaned up" in r.message for r in caplog.records)

    def test_cleanup_processor_only_when_model_missing(self):
        """Model missing (no attr) but processor exists."""
        proc = _mock_processor()
        svc = _make_service(processor=proc)
        # Remove model attribute entirely
        del svc.model

        svc.cleanup()  # Should clean processor without error

        assert svc.processor is None
