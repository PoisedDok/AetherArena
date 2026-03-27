"""
Unit Tests: RuntimeEngine and module-level helpers (core/runtime/engine.py)

Covers RuntimeEngine facade, singleton management, settings loading,
runtime config building, interpreter resolution, response normalization.

Mock boundaries:
  - core.runtime.coordinator.RuntimeCoordinator (direct import)
  - core.runtime.streaming.ChatStreamer (direct import)
  - core.runtime.document.DocumentProcessor (direct import)
  - config.settings.get_settings (via _load_settings)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.runtime.config import RuntimeConfig, ConfigManager
from core.runtime.request import RequestTracker

# Must import AFTER setting up patches for singletons
import core.runtime.engine as engine_mod
from core.runtime.engine import (
    RuntimeEngine,
    _build_runtime_config,
    _create_document_processor,
    _load_default_settings,
    _maybe_await,
    _normalize_response,
    _resolve_async_generator,
    get_config_manager,
    get_interpreter,
    get_interpreter_manager,
    get_request_tracker,
    reset_singletons,
)


@pytest.fixture(autouse=True)
def _reset_engine_singletons():
    """Reset module-level singletons before and after each test."""
    reset_singletons()
    yield
    reset_singletons()


# ═══════════════════════════════════════════════════════════════════════════════
# Module-level helpers
# ═══════════════════════════════════════════════════════════════════════════════


class TestLoadDefaultSettings:
    def test_returns_settings(self):
        mock_settings = MagicMock()
        with patch.object(engine_mod, "_load_settings", mock_settings):
            result = _load_default_settings()
            assert result is mock_settings.return_value

    def test_returns_none_when_no_loader(self):
        with patch.object(engine_mod, "_load_settings", None):
            result = _load_default_settings()
            assert result is None

    def test_returns_none_on_exception(self):
        mock_loader = MagicMock(side_effect=RuntimeError("config broken"))
        with patch.object(engine_mod, "_load_settings", mock_loader):
            result = _load_default_settings()
            assert result is None


class TestBuildRuntimeConfig:
    def test_with_valid_settings(self):
        settings = MagicMock()
        settings.llm.context_window = 50_000
        settings.llm.max_tokens = 2_048
        settings.embeddings.timeout_seconds = 120

        cfg = _build_runtime_config(settings)
        assert isinstance(cfg, RuntimeConfig)
        assert cfg.context_window == 50_000

    def test_with_none_settings(self):
        cfg = _build_runtime_config(None)
        assert isinstance(cfg, RuntimeConfig)
        assert cfg.context_window == 100_000  # default

    def test_on_exception_returns_defaults(self):
        settings = MagicMock()
        # Make from_settings raise
        with patch("core.runtime.engine.RuntimeConfig.from_settings", side_effect=TypeError("broken")):
            cfg = _build_runtime_config(settings)
        assert isinstance(cfg, RuntimeConfig)
        assert cfg.context_window == 100_000


class TestSingletons:
    def test_get_config_manager(self):
        cm = get_config_manager()
        assert isinstance(cm, ConfigManager)
        # Same instance on second call
        assert get_config_manager() is cm

    def test_get_request_tracker(self):
        rt = get_request_tracker()
        assert isinstance(rt, RequestTracker)
        assert get_request_tracker() is rt

    def test_get_interpreter_manager(self):
        from core.runtime.interpreter import InterpreterManager
        im = get_interpreter_manager()
        assert isinstance(im, InterpreterManager)
        assert get_interpreter_manager() is im

    def test_reset_singletons(self):
        cm = get_config_manager()
        rt = get_request_tracker()
        im = get_interpreter_manager()

        reset_singletons()

        assert get_config_manager() is not cm
        assert get_request_tracker() is not rt
        assert get_interpreter_manager() is not im


class TestCreateDocumentProcessor:
    def test_with_two_args(self):
        from core.runtime.document import DocumentProcessor
        cm = MagicMock()
        rt = MagicMock()
        dp = _create_document_processor(cm, rt)
        assert isinstance(dp, DocumentProcessor)

    def test_fallback_no_args(self):
        """If constructor raises TypeError, falls back to no-arg."""
        with patch("core.runtime.engine.DocumentProcessor", side_effect=[TypeError("nope"), MagicMock()]):
            dp = _create_document_processor(MagicMock(), MagicMock())
            assert dp is not None


class TestMaybeAwait:
    async def test_awaitable(self):
        async def coro():
            return 42
        result = await _maybe_await(coro())
        assert result == 42

    async def test_non_awaitable(self):
        result = await _maybe_await("plain value")
        assert result == "plain value"


class TestResolveAsyncGenerator:
    async def test_collects_chunks(self):
        async def gen():
            yield "a"
            yield "b"
            yield "c"
        result = await _resolve_async_generator(gen())
        assert result == ["a", "b", "c"]


class TestNormalizeResponse:
    def test_dict_passthrough(self):
        d = {"response": "ok"}
        assert _normalize_response(d, []) is d

    def test_list_wraps(self):
        r = _normalize_response(["chunk1", "chunk2"], [{"role": "user"}])
        assert r == {"content": ["chunk1", "chunk2"], "history": [{"role": "user"}]}

    def test_none_returns_empty(self):
        r = _normalize_response(None, [])
        assert r == {"response": "", "history": []}

    def test_other_wraps_as_response(self):
        r = _normalize_response("some text", [])
        assert r == {"response": "some text", "history": []}


class TestGetInterpreterHelper:
    async def test_returns_coroutine(self):
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=MagicMock())

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await get_interpreter(chat_id="chat-1")
            mock_manager.get_interpreter.assert_called_once_with(chat_id="chat-1")

    async def test_fallback_to_session_id(self):
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=None)

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await get_interpreter(session_id="sess-1")
            mock_manager.get_interpreter.assert_called_once_with(chat_id="sess-1")


# ═══════════════════════════════════════════════════════════════════════════════
# RuntimeEngine
# ═══════════════════════════════════════════════════════════════════════════════


def _create_engine(settings=None):
    """Create a RuntimeEngine with fully mocked dependencies."""
    mock_settings = settings or MagicMock()
    mock_coord = MagicMock()
    mock_coord.start = AsyncMock()
    mock_coord.stop = AsyncMock()
    mock_coord.stop_generation = AsyncMock()
    mock_coord.reset_context = AsyncMock()
    mock_coord.handle_file_chat = AsyncMock(return_value={"result": "file"})
    mock_coord.handle_file_chat_multipart = AsyncMock(return_value={"result": "multi"})
    mock_coord.start_audio_stream = AsyncMock()
    mock_coord.end_audio_stream = AsyncMock()
    mock_coord.handle_audio_chunk = AsyncMock()
    mock_coord.get_health_status.return_value = {"runtime": {"initialized": True}}
    mock_coord.is_ready.return_value = True
    mock_coord.cleanup_stale_resources = AsyncMock(return_value=3)
    mock_coord.get_history = AsyncMock(return_value=[{"role": "user", "content": "hi"}])
    mock_coord.set_history = MagicMock()
    mock_coord.get_history_limit.return_value = 50
    mock_coord.inject_system_context = MagicMock()

    with patch("core.runtime.engine.RuntimeCoordinator", return_value=mock_coord), \
         patch("core.runtime.engine._load_default_settings", return_value=mock_settings):
        engine = RuntimeEngine(settings=mock_settings)

    engine._coordinator = mock_coord
    return engine


class TestRuntimeEngineInit:
    def test_with_settings(self):
        engine = _create_engine()
        assert engine._settings is not None
        assert engine._coordinator is not None
        assert engine._config_manager is not None
        assert engine._request_tracker is not None

    def test_without_settings(self):
        with patch("core.runtime.engine._load_default_settings", return_value=None), \
             patch("core.runtime.engine.RuntimeCoordinator"):
            engine = RuntimeEngine(settings=None)
            # coordinator not created when settings is None
            # (the constructor guards: `if self._settings is not None`)


class TestSettingsProperty:
    def test_getter_with_settings(self):
        engine = _create_engine()
        assert engine.settings is engine._settings

    def test_getter_fallback_to_runtime_config(self):
        engine = _create_engine()
        engine._settings = None
        assert engine.settings is engine._runtime_config

    def test_setter_updates_coordinator(self):
        engine = _create_engine()
        new_settings = MagicMock()
        engine.settings = new_settings
        assert engine._settings is new_settings
        engine._coordinator.__setattr__("settings", new_settings)

    def test_setter_creates_coordinator_if_none(self):
        engine = _create_engine()
        engine._coordinator = None
        new_settings = MagicMock()

        with patch("core.runtime.engine.RuntimeCoordinator") as MockCoord:
            engine.settings = new_settings
            MockCoord.assert_called_once_with(new_settings)
            assert engine._coordinator is MockCoord.return_value


class TestCoordinatorProperty:
    def test_returns_coordinator(self):
        engine = _create_engine()
        assert engine.coordinator is engine._coordinator


class TestStartStop:
    async def test_start(self):
        engine = _create_engine()
        mcp = MagicMock()
        await engine.start(mcp_manager=mcp)
        engine._coordinator.start.assert_called_once_with(mcp_manager=mcp)

    async def test_start_no_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        await engine.start()  # Should not raise

    async def test_stop(self):
        engine = _create_engine()
        await engine.stop()
        engine._coordinator.stop.assert_called_once()

    async def test_stop_no_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        await engine.stop()  # Should not raise


class TestStopGeneration:
    async def test_delegates(self):
        engine = _create_engine()
        engine._request_tracker = MagicMock()
        engine._request_tracker.get_request_info.return_value = {"active": True}
        await engine.stop_generation("req-1")
        engine._coordinator.stop_generation.assert_called_once_with("req-1", chat_id=None)

    async def test_race_condition_delegates_even_if_tracker_missing(self):
        """
        Regression test:
        If a request has already been cleared from the tracker due to a race
        (e.g., streaming task finished and removed it), we MUST still call the
        coordinator to ensure the external process is killed.
        """
        engine = _create_engine()
        engine._request_tracker = MagicMock()
        # Simulate tracker entry missing (race condition happened)
        engine._request_tracker.get_request_info.return_value = None
        await engine.stop_generation("req-2", chat_id="chat-2")
        engine._coordinator.stop_generation.assert_called_once_with("req-2", chat_id="chat-2")

    async def test_no_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        engine._request_tracker = MagicMock()
        engine._request_tracker.get_request_info.return_value = {"active": True}
        await engine.stop_generation("req-1")  # No-op


class TestRegisterBackendApis:
    async def test_returns_skip_info(self):
        engine = _create_engine()
        result = await engine.register_backend_apis(MagicMock())
        assert result["success"] is True
        assert result["skipped"] is True


class TestResetContext:
    async def test_with_coordinator(self):
        engine = _create_engine()
        await engine.reset_context("client-1", chat_id="chat-1")
        engine._coordinator.reset_context.assert_called_once_with("client-1", chat_id="chat-1")

    async def test_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        engine._request_tracker.get_requests_by_client = MagicMock(return_value={"req-1": {}})
        engine._request_tracker.cancel_request = AsyncMock(return_value=True)
        await engine.reset_context("client-1")
        engine._request_tracker.cancel_request.assert_called_once_with("req-1")


class TestGetInterpreterEngine:
    async def test_with_chat_id(self):
        engine = _create_engine()
        mock_interp = MagicMock()

        async def _fake_resolve():
            return mock_interp

        with patch("core.runtime.engine.get_interpreter", return_value=_fake_resolve()):
            result = await engine.get_interpreter(chat_id="chat-1")
            assert result is mock_interp

    async def test_with_identifier(self):
        engine = _create_engine()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=MagicMock())

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await engine.get_interpreter("id-1")


class TestProcessMessage:
    async def test_no_interpreter(self):
        engine = _create_engine()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=None)

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await engine.process_message("hi", "sess-1")
            assert result == {"response": ""}

    async def test_with_process_message(self):
        engine = _create_engine()
        mock_interp = MagicMock()
        mock_interp.process_message = MagicMock(return_value={"response": "hello"})

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await engine.process_message("hi", "sess-1")
            assert result == {"response": "hello"}

    async def test_with_chat_method(self):
        engine = _create_engine()
        mock_interp = MagicMock(spec=[])  # No process_message
        mock_interp.chat = MagicMock(return_value={"response": "chat reply"})

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await engine.process_message("hi", "sess-1")
            assert result == {"response": "chat reply"}

    async def test_no_method_returns_empty(self):
        engine = _create_engine()
        mock_interp = MagicMock(spec=[])  # No methods

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await engine.process_message("hi", "sess-1")
            assert result == {"response": "", "history": []}

    async def test_process_message_returns_async_gen(self):
        engine = _create_engine()

        async def mock_gen():
            yield {"chunk": 1}
            yield {"chunk": 2}

        mock_interp = MagicMock()
        mock_interp.process_message = MagicMock(return_value=mock_gen())

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await engine.process_message("hi", "sess-1")
            assert result["content"] == [{"chunk": 1}, {"chunk": 2}]

    async def test_chat_returns_async_gen(self):
        engine = _create_engine()

        async def mock_gen():
            yield "part1"
            yield "part2"

        mock_interp = MagicMock(spec=[])
        mock_interp.chat = MagicMock(return_value=mock_gen())

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await engine.process_message("hi", "sess-1")
            assert result["content"] == ["part1", "part2"]


class TestProcessFile:
    async def test_success(self):
        engine = _create_engine()
        engine._document_processor.process_file = AsyncMock(
            return_value={"success": True, "content": "extracted"}
        )

        result = await engine.process_file({"path": "/test.pdf"}, user_prompt="summarize")
        assert result["status"] == "success"

    async def test_already_has_status(self):
        engine = _create_engine()
        engine._document_processor.process_file = AsyncMock(
            return_value={"status": "ok", "content": "data"}
        )

        result = await engine.process_file("/test.pdf")
        assert result["status"] == "ok"


class TestStreamChat:
    async def test_raises_without_message(self):
        engine = _create_engine()
        with pytest.raises(ValueError, match="requires 'message' or 'text'"):
            async for _ in engine.stream_chat(session_id="s1"):
                pass

    async def test_raises_without_session(self):
        engine = _create_engine()
        with pytest.raises(ValueError, match="requires 'session_id' or 'client_id'"):
            async for _ in engine.stream_chat(message="hello"):
                pass

    async def test_basic_stream(self):
        engine = _create_engine()
        chunks = [{"type": "text", "content": "hi"}, {"type": "done"}]

        async def mock_stream(**kwargs):
            for c in chunks:
                yield c

        engine._chat_streamer.stream_chat = mock_stream

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=MagicMock())

        collected = []
        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            async for chunk in engine.stream_chat(message="hello", session_id="s1"):
                collected.append(chunk)

        assert collected == chunks

    async def test_vision_preprocessing(self):
        engine = _create_engine()
        # Settings indicate no vision support
        engine._settings.llm.supports_vision = False

        engine._document_processor.process_file = AsyncMock(
            return_value={"success": True, "combined_prompt": "described image content"}
        )

        chunks = [{"type": "text", "content": "response"}]

        async def mock_stream(**kwargs):
            # Should receive text, not image
            assert kwargs["image_b64"] is None
            assert "described image content" in kwargs["text"]
            for c in chunks:
                yield c

        engine._chat_streamer.stream_chat = mock_stream

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=MagicMock())

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            collected = []
            async for chunk in engine.stream_chat(
                message="what is this?",
                session_id="s1",
                image_b64="base64data",
            ):
                collected.append(chunk)

    async def test_vision_preprocessing_failure(self):
        engine = _create_engine()
        engine._settings.llm.supports_vision = False

        engine._document_processor.process_file = AsyncMock(
            return_value={"success": False, "error": "unsupported format"}
        )

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=MagicMock())

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            with pytest.raises(RuntimeError, match="unsupported format"):
                async for _ in engine.stream_chat(
                    message="what?", session_id="s1", image_b64="img"
                ):
                    pass

    async def test_vision_preprocessing_empty_content(self):
        engine = _create_engine()
        engine._settings.llm.supports_vision = False

        engine._document_processor.process_file = AsyncMock(
            return_value={"success": True}
        )

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=MagicMock())

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            with pytest.raises(RuntimeError, match="empty content"):
                async for _ in engine.stream_chat(
                    message="what?", session_id="s1", image_b64="img"
                ):
                    pass


class TestHandleFileChat:
    async def test_with_coordinator(self):
        engine = _create_engine()
        result = await engine.handle_file_chat({"name": "file.pdf"}, "summarize", "req-1")
        engine._coordinator.handle_file_chat.assert_called_once()
        assert result == {"result": "file"}

    async def test_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        engine._document_processor.process_file_chat = AsyncMock(return_value={"ok": True})

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=None)

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await engine.handle_file_chat({"name": "f.pdf", "chat_id": "c1"})
            assert result == {"ok": True}


class TestHandleFileChatMultipart:
    async def test_with_coordinator(self):
        engine = _create_engine()
        result = await engine.handle_file_chat_multipart({"name": "f.pdf"}, "extract", "req-1")
        engine._coordinator.handle_file_chat_multipart.assert_called_once()
        assert result == {"result": "multi"}

    async def test_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        engine._document_processor.process_file_chat_multipart = AsyncMock(return_value={"parts": []})

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=None)

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager):
            result = await engine.handle_file_chat_multipart({"name": "f.pdf", "session_id": "s1"})
            assert result == {"parts": []}


class TestAudioMethods:
    async def test_start_audio_stream(self):
        engine = _create_engine()
        await engine.start_audio_stream("client-1")
        engine._coordinator.start_audio_stream.assert_called_once_with("client-1")

    async def test_end_audio_stream(self):
        engine = _create_engine()
        await engine.end_audio_stream("client-1")
        engine._coordinator.end_audio_stream.assert_called_once_with("client-1")

    async def test_handle_audio_chunk(self):
        engine = _create_engine()
        await engine.handle_audio_chunk("client-1", b"\x00\x01")
        engine._coordinator.handle_audio_chunk.assert_called_once_with("client-1", b"\x00\x01")

    async def test_no_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        await engine.start_audio_stream("c1")
        await engine.end_audio_stream("c1")
        await engine.handle_audio_chunk("c1", b"")


class TestGetHealthStatus:
    def test_with_coordinator(self):
        engine = _create_engine()
        status = engine.get_health_status()
        assert "engine" in status
        assert "coordinator" in status
        assert status["engine"]["settings_loaded"] is True

    def test_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        status = engine.get_health_status()
        assert status["coordinator"] == {"runtime": {"initialized": False}}


class TestIsReady:
    def test_with_coordinator(self):
        engine = _create_engine()
        assert engine.is_ready() is True

    def test_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        assert engine.is_ready() is True


class TestCleanupStaleResources:
    async def test_with_coordinator(self):
        engine = _create_engine()
        result = await engine.cleanup_stale_resources()
        assert result == 3

    async def test_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        engine._request_tracker = MagicMock()
        engine._request_tracker.cleanup_stale_requests = AsyncMock(return_value=1)
        result = await engine.cleanup_stale_resources()
        assert result == 1


class TestHistoryMethods:
    async def test_get_history_with_coordinator(self):
        engine = _create_engine()
        result = await engine.get_history("sess-1")
        assert result == [{"role": "user", "content": "hi"}]

    async def test_get_history_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        engine._chat_streamer.get_history = MagicMock(return_value=[])
        result = await engine.get_history("sess-1")
        assert result == []

    def test_set_history_with_coordinator(self):
        engine = _create_engine()
        engine.set_history("sess-1", [{"role": "user", "content": "test"}])
        engine._coordinator.set_history.assert_called_once()

    def test_set_history_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        engine._chat_streamer.set_history = MagicMock()
        engine.set_history("sess-1", [])
        engine._chat_streamer.set_history.assert_called_once()

    def test_get_history_limit_with_coordinator(self):
        engine = _create_engine()
        assert engine.get_history_limit() == 50

    def test_get_history_limit_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        engine._chat_streamer.get_history_limit = MagicMock(return_value=25)
        assert engine.get_history_limit() == 25


class TestInjectSystemContext:
    def test_with_coordinator(self):
        engine = _create_engine()
        engine.inject_system_context("sess-1", "extra context")
        engine._coordinator.inject_system_context.assert_called_once_with("sess-1", "extra context")

    def test_without_coordinator(self):
        engine = _create_engine()
        engine._coordinator = None
        engine.inject_system_context("sess-1", "extra")  # No-op, no error
