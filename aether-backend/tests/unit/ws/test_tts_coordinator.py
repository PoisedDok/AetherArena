"""
Unit Tests: ws/domain/audio/services/tts_coordinator.py

Tests TTS coordinator per-client lifecycle: service creation with double-checked
locking, queue management, interruption handling, disconnect cleanup.

Bug found and fixed: cleanup_client did not use try/finally — if stop() raised,
the per-client lock leaked. Fixed with try/except/finally.
"""

import sys
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock, patch

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

from ws.domain.audio.services.tts_coordinator import TTSCoordinator


# =========================================================================
# Helpers
# =========================================================================


def _make_tts_integration(available=True):
    """Create a mock TTS integration."""
    mock = MagicMock()
    mock.is_available.return_value = available
    return mock


def _make_tts_config(engine="piper", voice="en_US-lessac-medium"):
    """Create a mock TTS config."""
    config = MagicMock()
    config.engine = engine
    config.voice = voice
    return config


def _make_service():
    """Create a mock TTSGenerationService."""
    svc = MagicMock()
    svc.start = AsyncMock()
    svc.stop = AsyncMock()
    svc.add_sentence = AsyncMock()
    svc.get_next_audio = AsyncMock(return_value=(b"audio-data", "hello"))
    svc.is_generation_complete.return_value = False
    svc.clear_queues = AsyncMock()
    svc.sentences_processed = 5
    svc.audio_generated = 3
    svc.failed_sentences = ["bad1"]
    svc.sentence_queue = MagicMock()
    svc.sentence_queue.qsize.return_value = 2
    svc.audio_queue = MagicMock()
    svc.audio_queue.qsize.return_value = 1
    return svc


# =========================================================================
# __init__
# =========================================================================


class TestInit:
    def test_valid_initialization(self):
        integration = _make_tts_integration()
        config = _make_tts_config()
        coord = TTSCoordinator(integration, config)
        assert coord.tts_integration is integration
        assert coord.tts_config is config
        assert coord._client_services == {}
        assert coord._client_locks == {}

    def test_none_integration_raises(self):
        with pytest.raises(ValueError, match="not available"):
            TTSCoordinator(None, _make_tts_config())

    def test_unavailable_integration_raises(self):
        integration = _make_tts_integration(available=False)
        with pytest.raises(ValueError, match="not available"):
            TTSCoordinator(integration, _make_tts_config())


# =========================================================================
# get_or_create_service
# =========================================================================


class TestGetOrCreateService:
    @pytest.mark.asyncio
    async def test_creates_new_service(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        mock_svc = _make_service()

        with patch(
            "ws.domain.audio.services.tts_coordinator.TTSCoordinator.get_or_create_service",
            new=None,
        ):
            pass  # We test the actual method, not a patch

        # Patch the lazy import inside get_or_create_service
        mock_cls = MagicMock(return_value=mock_svc)
        with patch.dict(
            sys.modules,
            {"ws.domain.audio.services.tts_generation_service": MagicMock(TTSGenerationService=mock_cls)},
        ):
            svc = await coord.get_or_create_service("client-1")

        assert svc is mock_svc
        mock_svc.start.assert_awaited_once()
        assert "client-1" in coord._client_services
        assert coord._client_services["client-1"] is mock_svc

    @pytest.mark.asyncio
    async def test_returns_existing_service_fast_path(self):
        """Line 82-83: Fast path returns cached service without lock."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        existing = _make_service()
        coord._client_services["client-1"] = existing

        result = await coord.get_or_create_service("client-1")
        assert result is existing

    @pytest.mark.asyncio
    async def test_double_check_under_lock(self):
        """Line 90-91: Second check inside lock returns service created by another task.

        Simulates race condition:
        1. Competing task acquires lock, holds it
        2. Our call passes fast-path (line 82: service not in cache yet), waits for lock
        3. Competing task injects service into cache, then releases lock
        4. Our call acquires lock, double-check (line 90) finds service → returns it
        """
        import asyncio

        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        injected_svc = _make_service()

        # Pre-create the lock so get_or_create_service reuses it (line 86 setdefault)
        lock = asyncio.Lock()
        coord._client_locks["client-race"] = lock

        async def competing_task():
            """Acquires lock first, waits, injects service, releases lock."""
            async with lock:
                # Hold lock while our call passes fast-path and starts waiting
                await asyncio.sleep(0.005)
                # Inject service just before releasing lock
                coord._client_services["client-race"] = injected_svc

        # Start competitor — it acquires lock immediately (lock is free)
        task = asyncio.create_task(competing_task())
        await asyncio.sleep(0)  # Yield to let competitor acquire lock

        # Now call: fast-path (line 82) misses (service not injected yet),
        # then waits for lock (line 88). When competitor releases, our code
        # enters lock and double-check (line 90) finds the injected service.
        result = await coord.get_or_create_service("client-race")
        assert result is injected_svc

        await task

    @pytest.mark.asyncio
    async def test_creation_failure_propagates(self):
        """Lines 112-114: RuntimeError during creation propagates (FAIL_FAST)."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())

        failing_cls = MagicMock(side_effect=RuntimeError("GPU init failed"))
        mock_tts_mod = MagicMock(TTSGenerationService=failing_cls)
        with patch.dict(
            sys.modules,
            {"ws.domain.audio.services.tts_generation_service": mock_tts_mod},
        ):
            with pytest.raises(RuntimeError, match="GPU init failed"):
                await coord.get_or_create_service("client-fail")

        # Service should NOT be in cache after failure
        assert "client-fail" not in coord._client_services

    @pytest.mark.asyncio
    async def test_creation_creates_per_client_lock(self):
        """Line 86: setdefault creates lock for new client."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        assert "client-lock" not in coord._client_locks

        mock_cls = MagicMock(return_value=_make_service())
        mock_tts_mod = MagicMock(TTSGenerationService=mock_cls)
        with patch.dict(
            sys.modules,
            {"ws.domain.audio.services.tts_generation_service": mock_tts_mod},
        ):
            await coord.get_or_create_service("client-lock")

        assert "client-lock" in coord._client_locks


# =========================================================================
# add_sentence
# =========================================================================


class TestAddSentence:
    @pytest.mark.asyncio
    async def test_delegates_to_service(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        svc = _make_service()
        coord._client_services["c1"] = svc

        await coord.add_sentence("c1", "Hello world")
        svc.add_sentence.assert_awaited_once_with("Hello world")

    @pytest.mark.asyncio
    async def test_creates_service_if_not_exists(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        new_svc = _make_service()
        mock_cls = MagicMock(return_value=new_svc)
        mock_tts_mod = MagicMock(TTSGenerationService=mock_cls)

        with patch.dict(
            sys.modules,
            {"ws.domain.audio.services.tts_generation_service": mock_tts_mod},
        ):
            await coord.add_sentence("c2", "Testing")

        new_svc.start.assert_awaited_once()
        new_svc.add_sentence.assert_awaited_once_with("Testing")


# =========================================================================
# get_next_audio
# =========================================================================


class TestGetNextAudio:
    @pytest.mark.asyncio
    async def test_returns_audio_from_service(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        svc = _make_service()
        coord._client_services["c1"] = svc

        result = await coord.get_next_audio("c1")
        assert result == (b"audio-data", "hello")
        svc.get_next_audio.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_client(self):
        """Line 145-146: No service → returns None."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        result = await coord.get_next_audio("nonexistent")
        assert result is None


# =========================================================================
# is_generation_complete
# =========================================================================


class TestIsGenerationComplete:
    def test_returns_true_for_unknown_client(self):
        """Line 160-161: No service → True."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        assert coord.is_generation_complete("nobody") is True

    def test_delegates_to_service(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        svc = _make_service()
        svc.is_generation_complete.return_value = True
        coord._client_services["c1"] = svc

        assert coord.is_generation_complete("c1") is True
        svc.is_generation_complete.assert_called_once()

    def test_returns_false_when_not_complete(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        svc = _make_service()
        svc.is_generation_complete.return_value = False
        coord._client_services["c1"] = svc

        assert coord.is_generation_complete("c1") is False


# =========================================================================
# clear_queues
# =========================================================================


class TestClearQueues:
    @pytest.mark.asyncio
    async def test_clears_existing_service(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        svc = _make_service()
        coord._client_services["c1"] = svc

        await coord.clear_queues("c1")
        svc.clear_queues.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_noop_for_unknown_client(self):
        """Line 171-172: No service → no-op."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        await coord.clear_queues("nobody")  # Should not raise


# =========================================================================
# stop_service
# =========================================================================


class TestStopService:
    @pytest.mark.asyncio
    async def test_stops_existing_service(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        svc = _make_service()
        coord._client_services["c1"] = svc

        await coord.stop_service("c1")
        svc.stop.assert_awaited_once()
        # Service should NOT be removed from cache (reuse for next message)
        assert "c1" in coord._client_services

    @pytest.mark.asyncio
    async def test_noop_for_unknown_client(self):
        """Line 186-187: No service → no-op."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        await coord.stop_service("nobody")  # Should not raise


# =========================================================================
# cleanup_client
# =========================================================================


class TestCleanupClient:
    @pytest.mark.asyncio
    async def test_stops_and_removes_service(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        svc = _make_service()
        coord._client_services["c1"] = svc
        coord._client_locks["c1"] = MagicMock()

        await coord.cleanup_client("c1")

        svc.stop.assert_awaited_once()
        assert "c1" not in coord._client_services
        assert "c1" not in coord._client_locks

    @pytest.mark.asyncio
    async def test_noop_for_unknown_client(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        await coord.cleanup_client("nobody")  # Should not raise

    @pytest.mark.asyncio
    async def test_lock_cleaned_even_if_stop_fails(self):
        """BUG FIX TEST: stop() failure must not leak lock."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        svc = _make_service()
        svc.stop = AsyncMock(side_effect=RuntimeError("worker crash"))
        coord._client_services["c1"] = svc
        coord._client_locks["c1"] = MagicMock()

        # Should NOT raise (exception caught in cleanup_client)
        await coord.cleanup_client("c1")

        # Service removed from cache (popped before stop)
        assert "c1" not in coord._client_services
        # Lock MUST be cleaned despite stop() failure
        assert "c1" not in coord._client_locks

    @pytest.mark.asyncio
    async def test_only_lock_cleaned_when_no_service(self):
        """Service absent but lock exists → lock still cleaned."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        coord._client_locks["orphan"] = MagicMock()

        await coord.cleanup_client("orphan")
        assert "orphan" not in coord._client_locks


# =========================================================================
# get_service_stats
# =========================================================================


class TestGetServiceStats:
    def test_returns_empty_dict_for_unknown_client(self):
        """Line 222-223: No service → empty dict."""
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        assert coord.get_service_stats("nobody") == {}

    def test_returns_full_stats(self):
        coord = TTSCoordinator(_make_tts_integration(), _make_tts_config())
        svc = _make_service()
        coord._client_services["c1"] = svc

        stats = coord.get_service_stats("c1")
        assert stats == {
            "sentences_processed": 5,
            "audio_generated": 3,
            "failed_sentences": 1,
            "sentence_queue_size": 2,
            "audio_queue_size": 1,
        }
