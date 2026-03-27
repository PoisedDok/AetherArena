"""
Unit Tests: RuntimeCoordinator (core/runtime/coordinator.py)

Covers initialization sequencing, lifecycle management, module orchestration,
stream_chat delegation, cleanup, health status, and background task tracking.

Mock boundaries:
  - core.runtime.config.ConfigManager (via lazy import)
  - RuntimeSessionManager, RuntimeInterpreterAdapter, RuntimeMediaService (direct imports)
  All sub-modules are mocked to test the coordinator's orchestration logic.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.runtime.coordinator import RuntimeCoordinator


def _make_coordinator(settings=None):
    """Create a RuntimeCoordinator with pre-injected mock sub-modules."""
    s = settings or MagicMock()
    coord = RuntimeCoordinator(s)

    mock_cm = MagicMock()
    mock_cm.load_and_apply_settings = MagicMock(return_value=s)
    mock_cm.reset_client = AsyncMock()
    mock_cm.cleanup = AsyncMock()
    coord._config_manager = mock_cm

    mock_sm = MagicMock()
    mock_sm.initialize = AsyncMock()
    mock_sm.cancel_request = AsyncMock(return_value=True)
    mock_sm.reset_context = AsyncMock()
    mock_sm.cleanup = AsyncMock()
    mock_sm.start_audio_stream = AsyncMock()
    mock_sm.end_audio_stream = AsyncMock()
    mock_sm.handle_audio_chunk = AsyncMock()
    mock_sm.cleanup_stale_resources = AsyncMock(return_value=3)
    mock_sm.get_history = MagicMock(return_value=[{"role": "user", "content": "hi"}])
    mock_sm.set_history = MagicMock(return_value=[{"role": "user", "content": "hi"}])
    mock_sm.get_history_limit = MagicMock(return_value=50)
    mock_sm.get_request_count = MagicMock(return_value=2)
    mock_sm.get_health_status = MagicMock(return_value={"available": True, "audio_sessions": 1})
    mock_sm.request_tracker = MagicMock()
    mock_sm.request_tracker.get_request_info = MagicMock(return_value={"chat_id": "chat-1"})
    coord._session_manager = mock_sm

    mock_ia = MagicMock()
    mock_ia.initialize = AsyncMock()
    mock_ia.configure = AsyncMock()
    mock_ia.stop_generation = AsyncMock()
    mock_ia.reset_state = AsyncMock()
    mock_ia.get_interpreter = AsyncMock(return_value=MagicMock())
    mock_ia.cleanup = AsyncMock()
    mock_ia.apply_history = AsyncMock()
    mock_ia.append_custom_instructions = AsyncMock()
    mock_ia.get_health_status = MagicMock(return_value={"available": True})
    coord._interpreter_adapter = mock_ia

    mock_ms = MagicMock()
    mock_ms.initialize = AsyncMock()
    mock_ms.process_file_chat = AsyncMock(return_value={"result": "file"})
    mock_ms.process_file_chat_multipart = AsyncMock(return_value={"result": "multi"})
    mock_ms.cleanup = AsyncMock()
    mock_ms.get_health_status = MagicMock(return_value={"available": True})
    coord._media_service = mock_ms

    coord._initialized = True
    coord._startup_complete = True

    return coord


# ─── Constructor ──────────────────────────────────────────────────────────────


class TestRuntimeCoordinatorInit:
    def test_initial_state(self):
        settings = MagicMock()
        coord = RuntimeCoordinator(settings)
        assert coord.settings is settings
        assert coord._config_manager is None
        assert coord._session_manager is None
        assert coord._interpreter_adapter is None
        assert coord._media_service is None
        assert coord._initialized is False
        assert coord._startup_complete is False
        assert coord._is_disposed is False
        assert coord._background_tasks == set()


# ─── start() ──────────────────────────────────────────────────────────────────


class TestStart:
    async def test_full_startup(self):
        settings = MagicMock()
        coord = RuntimeCoordinator(settings)

        with patch("core.runtime.coordinator.RuntimeSessionManager") as MockSM, \
             patch("core.runtime.coordinator.RuntimeInterpreterAdapter") as MockIA, \
             patch("core.runtime.coordinator.RuntimeMediaService") as MockMS, \
             patch("core.runtime.config.ConfigManager") as MockCM:
            mock_sm = MagicMock()
            mock_sm.initialize = AsyncMock()
            mock_sm.request_tracker = MagicMock()
            MockSM.return_value = mock_sm

            mock_ia = MagicMock()
            mock_ia.initialize = AsyncMock()
            mock_ia.configure = AsyncMock()
            MockIA.return_value = mock_ia

            mock_ms = MagicMock()
            mock_ms.initialize = AsyncMock()
            MockMS.return_value = mock_ms

            mock_cm = MagicMock()
            mock_cm.load_and_apply_settings = MagicMock(return_value=settings)
            MockCM.return_value = mock_cm

            await coord.start()

            assert coord._startup_complete is True
            assert coord._initialized is True

    async def test_raises_if_disposed(self):
        coord = _make_coordinator()
        coord._is_disposed = True
        with pytest.raises(RuntimeError, match="Cannot start a disposed"):
            await coord.start()

    async def test_cleans_up_on_failure(self):
        settings = MagicMock()
        coord = RuntimeCoordinator(settings)

        with patch("core.runtime.config.ConfigManager", side_effect=Exception("boom")):
            with pytest.raises(Exception, match="boom"):
                await coord.start()

        assert coord._startup_complete is False

    async def test_raises_if_config_manager_none_after_init(self):
        """Line 51: ConfigManager init succeeds but returns None."""
        settings = MagicMock()
        coord = RuntimeCoordinator(settings)

        async def _fake_init():
            coord._config_manager = None  # Simulate failed init without exception

        coord._init_config_manager = _fake_init

        with pytest.raises(RuntimeError, match="Critical module.*ConfigManager.*failed"):
            await coord.start()

    async def test_interpreter_configure_failure_non_critical(self):
        """Lines 64-65: interpreter_adapter.configure raises, startup still completes."""
        settings = MagicMock()
        coord = RuntimeCoordinator(settings)

        with patch("core.runtime.coordinator.RuntimeSessionManager") as MockSM, \
             patch("core.runtime.coordinator.RuntimeInterpreterAdapter") as MockIA, \
             patch("core.runtime.coordinator.RuntimeMediaService") as MockMS, \
             patch("core.runtime.config.ConfigManager") as MockCM:
            mock_cm = MagicMock()
            mock_cm.load_and_apply_settings = MagicMock(return_value=settings)
            MockCM.return_value = mock_cm

            mock_sm = MagicMock()
            mock_sm.initialize = AsyncMock()
            mock_sm.request_tracker = MagicMock()
            MockSM.return_value = mock_sm

            mock_ia = MagicMock()
            mock_ia.initialize = AsyncMock()
            mock_ia.configure = AsyncMock(side_effect=ValueError("bad interpreter config"))
            MockIA.return_value = mock_ia

            mock_ms = MagicMock()
            mock_ms.initialize = AsyncMock()
            MockMS.return_value = mock_ms

            await coord.start()

            assert coord._startup_complete is True  # Non-critical failure


# ─── _initialize_remaining_modules() ─────────────────────────────────────────


class TestInitializeRemainingModules:
    async def test_idempotent(self):
        coord = _make_coordinator()
        coord._initialized = True
        result = await coord._initialize_remaining_modules()
        assert result is True

    async def test_session_manager_failure_is_critical(self):
        coord = _make_coordinator()
        coord._initialized = False
        coord._session_manager = None

        with patch("core.runtime.coordinator.RuntimeSessionManager") as MockSM:
            mock_sm = MagicMock()
            mock_sm.initialize = AsyncMock(side_effect=RuntimeError("critical"))
            MockSM.return_value = mock_sm

            result = await coord._initialize_remaining_modules()
            assert result is False

    async def test_non_critical_failure_continues(self):
        coord = _make_coordinator()
        coord._initialized = False
        coord._session_manager = None
        coord._interpreter_adapter = None
        coord._media_service = None

        with patch("core.runtime.coordinator.RuntimeSessionManager") as MockSM, \
             patch("core.runtime.coordinator.RuntimeInterpreterAdapter") as MockIA, \
             patch("core.runtime.coordinator.RuntimeMediaService") as MockMS:
            mock_sm = MagicMock()
            mock_sm.initialize = AsyncMock()
            mock_sm.request_tracker = MagicMock()
            MockSM.return_value = mock_sm

            MockIA.return_value.initialize = AsyncMock(side_effect=RuntimeError("non-critical"))

            mock_ms = MagicMock()
            mock_ms.initialize = AsyncMock()
            MockMS.return_value = mock_ms

            result = await coord._initialize_remaining_modules()
            assert result is True
            assert coord._initialized is True


# ─── Init helpers ─────────────────────────────────────────────────────────────


class TestInitHelpers:
    async def test_init_config_manager_idempotent(self):
        coord = _make_coordinator()
        existing = coord._config_manager
        await coord._init_config_manager()
        assert coord._config_manager is existing

    async def test_init_session_manager_idempotent(self):
        coord = _make_coordinator()
        existing = coord._session_manager
        await coord._init_session_manager()
        assert coord._session_manager is existing

    async def test_init_session_manager_requires_config(self):
        coord = _make_coordinator()
        coord._session_manager = None
        coord._config_manager = None
        with pytest.raises(RuntimeError, match="Config manager required"):
            await coord._init_session_manager()

    async def test_init_interpreter_adapter_idempotent(self):
        coord = _make_coordinator()
        existing = coord._interpreter_adapter
        await coord._init_interpreter_adapter()
        assert coord._interpreter_adapter is existing

    async def test_init_media_service_idempotent(self):
        coord = _make_coordinator()
        existing = coord._media_service
        await coord._init_media_service()
        assert coord._media_service is existing

    async def test_init_media_service_requires_deps(self):
        coord = _make_coordinator()
        coord._media_service = None
        coord._config_manager = None
        with pytest.raises(RuntimeError, match="Session manager and config manager required"):
            await coord._init_media_service()


# ─── stop() ──────────────────────────────────────────────────────────────────


class TestStop:
    async def test_full_shutdown(self):
        coord = _make_coordinator()
        await coord.stop()

        assert coord._is_disposed is True
        assert coord._startup_complete is False
        coord._media_service is None
        coord._session_manager is None

    async def test_idempotent_double_stop(self):
        coord = _make_coordinator()
        await coord.stop()
        await coord.stop()  # No error

    async def test_cancels_background_tasks(self):
        coord = _make_coordinator()

        async def long_task():
            await asyncio.sleep(999)

        task = asyncio.create_task(long_task())
        coord._background_tasks.add(task)

        await coord.stop()

        assert task.cancelled()
        assert coord._background_tasks == set()


# ─── _cleanup_all_modules() ──────────────────────────────────────────────────


class TestCleanupAllModules:
    async def test_cleans_all(self):
        coord = _make_coordinator()
        await coord._cleanup_all_modules()

        assert coord._media_service is None
        assert coord._session_manager is None
        assert coord._interpreter_adapter is None
        assert coord._config_manager is None
        assert coord._initialized is False

    async def test_handles_cleanup_errors(self):
        coord = _make_coordinator()
        coord._media_service.cleanup = AsyncMock(side_effect=RuntimeError("cleanup failed"))

        await coord._cleanup_all_modules()  # Should not raise

        assert coord._media_service is None

    async def test_no_modules(self):
        coord = RuntimeCoordinator(MagicMock())
        await coord._cleanup_all_modules()  # No error


# ─── stop_generation() ───────────────────────────────────────────────────────


class TestStopGeneration:
    async def test_success(self):
        coord = _make_coordinator()
        await coord.stop_generation("req-1")

        coord._session_manager.cancel_request.assert_called_once_with("req-1")
        coord._interpreter_adapter.stop_generation.assert_called_once_with("req-1", chat_id="chat-1")
        coord._config_manager.reset_client.assert_called_once()

    async def test_no_session_manager(self):
        coord = _make_coordinator()
        coord._session_manager = None
        await coord.stop_generation("req-1")  # No error

    async def test_cancel_not_found(self):
        """cancel_request returns False (request already ended via race), but
        stop_generation STILL fires — the implementation explicitly documents
        'DO NOT gate this on cancelled' because the OI server process may
        still be running even if the tracker entry is gone."""
        coord = _make_coordinator()
        coord._session_manager.cancel_request = AsyncMock(return_value=False)
        await coord.stop_generation("req-1")
        # Interpreter stop fires regardless — see coordinator.py lines 224-234
        coord._interpreter_adapter.stop_generation.assert_called_once_with("req-1", chat_id="chat-1")

    async def test_no_tracker_info(self):
        coord = _make_coordinator()
        coord._session_manager.request_tracker.get_request_info.return_value = None
        await coord.stop_generation("req-1")
        coord._interpreter_adapter.stop_generation.assert_called_once_with("req-1", chat_id=None)

    async def test_tracker_info_raises_exception(self):
        """Lines 192-193: tracker.get_request_info raises, chat_id defaults to None."""
        coord = _make_coordinator()
        coord._session_manager.request_tracker.get_request_info.side_effect = AttributeError("broken")
        await coord.stop_generation("req-1")
        coord._interpreter_adapter.stop_generation.assert_called_once_with("req-1", chat_id=None)


# ─── reset_context() ─────────────────────────────────────────────────────────


class TestResetContext:
    async def test_resets_all(self):
        coord = _make_coordinator()
        await coord.reset_context("client-1", chat_id="chat-1")

        coord._interpreter_adapter.reset_state.assert_called_once_with("client-1", chat_id="chat-1")
        coord._session_manager.reset_context.assert_called_once_with("client-1", chat_id="chat-1")
        coord._config_manager.reset_client.assert_called_once()

    async def test_no_modules(self):
        coord = _make_coordinator()
        coord._interpreter_adapter = None
        coord._session_manager = None
        coord._config_manager = None
        await coord.reset_context("client-1")  # No error

    async def test_exception_suppressed(self):
        coord = _make_coordinator()
        coord._interpreter_adapter.reset_state = AsyncMock(side_effect=RuntimeError("oops"))
        await coord.reset_context("client-1")  # Should not raise


# ─── handle_file_chat() / handle_file_chat_multipart() ──────────────────────


class TestHandleFileChat:
    async def test_success(self):
        coord = _make_coordinator()
        result = await coord.handle_file_chat({"chat_id": "c1"}, "summarize", "req-1")
        assert result == {"result": "file"}
        coord._interpreter_adapter.get_interpreter.assert_called_once_with(chat_id="c1")

    async def test_raises_if_not_initialized(self):
        coord = _make_coordinator()
        coord._media_service = None
        with pytest.raises(RuntimeError, match="Runtime media service not initialized"):
            await coord.handle_file_chat({"name": "f.pdf"})

    async def test_uses_session_id_fallback(self):
        coord = _make_coordinator()
        await coord.handle_file_chat({"session_id": "s1"})
        coord._interpreter_adapter.get_interpreter.assert_called_once_with(chat_id="s1")


class TestHandleFileChatMultipart:
    async def test_success(self):
        coord = _make_coordinator()
        result = await coord.handle_file_chat_multipart({"chat_id": "c1"})
        assert result == {"result": "multi"}

    async def test_raises_if_not_initialized(self):
        coord = _make_coordinator()
        coord._interpreter_adapter = None
        with pytest.raises(RuntimeError, match="Runtime media service not initialized"):
            await coord.handle_file_chat_multipart({"name": "f.pdf"})


# ─── Audio ────────────────────────────────────────────────────────────────────


class TestAudioMethods:
    async def test_start_audio_stream(self):
        coord = _make_coordinator()
        await coord.start_audio_stream("client-1")
        coord._session_manager.start_audio_stream.assert_called_once_with("client-1")

    async def test_end_audio_stream(self):
        coord = _make_coordinator()
        await coord.end_audio_stream("client-1")
        coord._session_manager.end_audio_stream.assert_called_once_with("client-1")

    async def test_handle_audio_chunk(self):
        coord = _make_coordinator()
        await coord.handle_audio_chunk("client-1", b"\x00")
        coord._session_manager.handle_audio_chunk.assert_called_once_with("client-1", b"\x00")

    async def test_no_session_manager(self):
        coord = _make_coordinator()
        coord._session_manager = None
        await coord.start_audio_stream("c1")
        await coord.end_audio_stream("c1")
        await coord.handle_audio_chunk("c1", b"")


# ─── stream_chat() ───────────────────────────────────────────────────────────


class TestStreamChat:
    async def test_success(self):
        coord = _make_coordinator()
        chunks = [{"type": "text", "content": "hi"}, {"type": "done"}]

        async def mock_stream(**kwargs):
            for c in chunks:
                yield c

        coord._session_manager.stream_chat = mock_stream

        collected = []
        async for chunk in coord.stream_chat(
            client_id="c1", text="hello", image_b64=None, request_id="r1", chat_id="ch1"
        ):
            collected.append(chunk)

        assert collected == chunks
        coord._interpreter_adapter.get_interpreter.assert_called_once_with(chat_id="ch1")

    async def test_not_startup_complete_returns_empty(self):
        coord = _make_coordinator()
        coord._startup_complete = False

        collected = []
        # Override sleep to avoid real waits
        with patch("asyncio.sleep", new_callable=AsyncMock):
            async for chunk in coord.stream_chat(
                client_id="c1", text="hello", image_b64=None, request_id="r1"
            ):
                collected.append(chunk)

        assert collected == []

    async def test_missing_modules_returns_empty(self):
        coord = _make_coordinator()
        coord._session_manager = None

        collected = []
        async for chunk in coord.stream_chat(
            client_id="c1", text="hello", image_b64=None, request_id="r1"
        ):
            collected.append(chunk)

        assert collected == []

    async def test_startup_becomes_ready_during_wait(self):
        """Line 280: _startup_complete becomes True mid-loop, triggering break."""
        coord = _make_coordinator()
        coord._startup_complete = False
        chunks = [{"type": "text", "content": "delayed"}]

        async def mock_stream(**kwargs):
            for c in chunks:
                yield c

        coord._session_manager.stream_chat = mock_stream

        call_count = 0
        original_sleep = asyncio.sleep

        async def _flip_on_second_call(secs):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                coord._startup_complete = True
            await original_sleep(0)  # Don't actually sleep

        collected = []
        with patch("asyncio.sleep", side_effect=_flip_on_second_call):
            async for chunk in coord.stream_chat(
                client_id="c1", text="hello", image_b64=None, request_id="r1"
            ):
                collected.append(chunk)

        assert collected == chunks


# ─── get_health_status() ─────────────────────────────────────────────────────


class TestGetHealthStatus:
    def test_fully_initialized(self):
        coord = _make_coordinator()
        status = coord.get_health_status()

        assert status["runtime"]["initialized"] is True
        assert status["runtime"]["startup_complete"] is True
        assert status["runtime"]["module_count"] == 4
        assert status["active_requests"] == 2
        assert status["active_audio_sessions"] == 1
        assert "modules" in status

    def test_nothing_initialized(self):
        coord = RuntimeCoordinator(MagicMock())
        status = coord.get_health_status()

        assert status["runtime"]["initialized"] is False
        assert status["runtime"]["module_count"] == 0
        assert status["active_requests"] == 0


# ─── is_ready() ──────────────────────────────────────────────────────────────


class TestIsReady:
    def test_ready(self):
        coord = _make_coordinator()
        assert coord.is_ready() is True

    def test_not_ready_no_startup(self):
        coord = _make_coordinator()
        coord._startup_complete = False
        assert coord.is_ready() is False

    def test_not_ready_no_session_manager(self):
        coord = _make_coordinator()
        coord._session_manager = None
        assert coord.is_ready() is False


# ─── cleanup_stale_resources() ────────────────────────────────────────────────


class TestCleanupStaleResources:
    async def test_with_session_manager(self):
        coord = _make_coordinator()
        result = await coord.cleanup_stale_resources()
        assert result == 3

    async def test_no_session_manager(self):
        coord = _make_coordinator()
        coord._session_manager = None
        result = await coord.cleanup_stale_resources()
        assert result == 0


# ─── get_history() ────────────────────────────────────────────────────────────


class TestGetHistory:
    async def test_with_session_manager(self):
        coord = _make_coordinator()
        result = await coord.get_history("sess-1")
        assert result == [{"role": "user", "content": "hi"}]

    async def test_no_session_manager(self):
        coord = _make_coordinator()
        coord._session_manager = None
        result = await coord.get_history("sess-1")
        assert result == []


# ─── _track_task() ────────────────────────────────────────────────────────────


class TestTrackTask:
    async def test_tracks_and_removes_on_done(self):
        coord = _make_coordinator()

        async def quick():
            return 42

        task = asyncio.create_task(quick())
        coord._track_task(task)
        assert task in coord._background_tasks

        await task
        await asyncio.sleep(0.01)  # Allow callback to fire

        assert task not in coord._background_tasks

    async def test_logs_on_exception(self):
        coord = _make_coordinator()

        async def failing():
            raise ValueError("task failed")

        task = asyncio.create_task(failing())
        coord._track_task(task)

        await asyncio.sleep(0.05)  # Allow task to fail and callback to fire

        assert task not in coord._background_tasks

    async def test_cancelled_task_handled(self):
        coord = _make_coordinator()

        async def slow():
            await asyncio.sleep(999)

        task = asyncio.create_task(slow())
        coord._track_task(task)
        task.cancel()

        await asyncio.sleep(0.05)

        assert task not in coord._background_tasks


# ─── set_history() ────────────────────────────────────────────────────────────


class TestSetHistory:
    def test_no_session_manager(self):
        coord = _make_coordinator()
        coord._session_manager = None
        coord.set_history("sess-1", [])  # No error

    async def test_with_session_and_interpreter(self):
        coord = _make_coordinator()
        coord.set_history("sess-1", [{"role": "user", "content": "hi"}])

        coord._session_manager.set_history.assert_called_once()
        # Background task should be tracked
        assert len(coord._background_tasks) == 1

        # Wait for background task to complete
        for task in list(coord._background_tasks):
            await task
        await asyncio.sleep(0.01)

    def test_empty_history_no_task(self):
        coord = _make_coordinator()
        coord._session_manager.set_history.return_value = []
        coord.set_history("sess-1", [])
        assert len(coord._background_tasks) == 0


# ─── inject_system_context() ─────────────────────────────────────────────────


class TestInjectSystemContext:
    def test_empty_session_id(self):
        coord = _make_coordinator()
        coord.inject_system_context("", "context")
        assert len(coord._background_tasks) == 0

    def test_empty_context(self):
        coord = _make_coordinator()
        coord.inject_system_context("sess-1", "")
        assert len(coord._background_tasks) == 0

    def test_no_interpreter_adapter(self):
        coord = _make_coordinator()
        coord._interpreter_adapter = None
        coord.inject_system_context("sess-1", "some context")
        assert len(coord._background_tasks) == 0

    async def test_schedules_task(self):
        coord = _make_coordinator()
        coord.inject_system_context("sess-1", "extra context")
        assert len(coord._background_tasks) == 1

        for task in list(coord._background_tasks):
            await task
        await asyncio.sleep(0.01)


# ─── get_history_limit() ─────────────────────────────────────────────────────


class TestGetHistoryLimit:
    def test_with_session_manager(self):
        coord = _make_coordinator()
        assert coord.get_history_limit() == 50

    def test_no_session_manager(self):
        coord = _make_coordinator()
        coord._session_manager = None
        assert coord.get_history_limit() == 0


# ─── Properties ───────────────────────────────────────────────────────────────


class TestProperties:
    def test_config_manager(self):
        coord = _make_coordinator()
        assert coord.config_manager is coord._config_manager

    def test_session_manager(self):
        coord = _make_coordinator()
        assert coord.session_manager is coord._session_manager

    def test_interpreter_adapter(self):
        coord = _make_coordinator()
        assert coord.interpreter_adapter is coord._interpreter_adapter

    def test_media_service(self):
        coord = _make_coordinator()
        assert coord.media_service is coord._media_service
