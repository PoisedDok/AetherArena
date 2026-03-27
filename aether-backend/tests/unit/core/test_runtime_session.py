"""
Unit Tests: RuntimeSessionManager (core/runtime/session.py)

Covers initialization, cleanup lifecycle, cancel/reset, stream_chat delegation,
audio session tracking, history/request accessors, and health status.

Mock boundaries:
  - core.runtime.request.RequestTracker (lazy import in initialize())
  - core.runtime.streaming.ChatStreamer (lazy import in initialize())
  For non-init tests, mocks injected directly into _request_tracker / _chat_streamer.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.runtime.session import RuntimeSessionManager


# ─── Constructor ──────────────────────────────────────────────────────────────


class TestRuntimeSessionManagerInit:
    def test_initial_state(self):
        mgr = RuntimeSessionManager()
        assert mgr._request_tracker is None
        assert mgr._chat_streamer is None
        assert mgr._audio_sessions == {}

    def test_properties_return_none_initially(self):
        mgr = RuntimeSessionManager()
        assert mgr.request_tracker is None
        assert mgr.chat_streamer is None


# ─── initialize() ─────────────────────────────────────────────────────────────


class TestInitialize:
    async def test_creates_tracker_and_streamer(self):
        mgr = RuntimeSessionManager()
        config_mgr = MagicMock()

        with patch("core.runtime.engine.get_request_tracker") as MockRT, \
             patch("core.runtime.streaming.ChatStreamer") as MockCS:
            mock_rt = MagicMock()
            mock_cs = MagicMock()
            MockRT.return_value = mock_rt
            MockCS.return_value = mock_cs

            await mgr.initialize(config_mgr)

            MockRT.assert_called_once()
            MockCS.assert_called_once_with(config_mgr, mock_rt)
            assert mgr._request_tracker is mock_rt
            assert mgr._chat_streamer is mock_cs

    async def test_idempotent_if_already_initialized(self):
        mgr = RuntimeSessionManager()
        existing_rt = MagicMock()
        existing_cs = MagicMock()
        mgr._request_tracker = existing_rt
        mgr._chat_streamer = existing_cs

        with patch("core.runtime.engine.get_request_tracker") as MockRT, \
             patch("core.runtime.streaming.ChatStreamer") as MockCS:
            await mgr.initialize(MagicMock())

            MockRT.assert_not_called()
            MockCS.assert_not_called()
            assert mgr._request_tracker is existing_rt
            assert mgr._chat_streamer is existing_cs

    async def test_raises_if_config_manager_missing(self):
        mgr = RuntimeSessionManager()
        with pytest.raises(RuntimeError, match="Config manager required"):
            await mgr.initialize(None)

    async def test_reinitializes_if_only_tracker_set(self):
        """If only one of the two is set, re-init should proceed."""
        mgr = RuntimeSessionManager()
        mgr._request_tracker = MagicMock()
        mgr._chat_streamer = None

        with patch("core.runtime.engine.get_request_tracker") as MockRT, \
             patch("core.runtime.streaming.ChatStreamer") as MockCS:
            MockRT.return_value = MagicMock()
            MockCS.return_value = MagicMock()

            await mgr.initialize(MagicMock())

            MockRT.assert_called_once()
            MockCS.assert_called_once()


# ─── cleanup() ────────────────────────────────────────────────────────────────


class TestCleanup:
    async def test_cleans_both_and_clears_audio(self):
        mgr = RuntimeSessionManager()
        mock_cs = MagicMock()
        mock_cs.cleanup = AsyncMock()
        mock_rt = MagicMock()
        mock_rt.cleanup = AsyncMock()
        mgr._chat_streamer = mock_cs
        mgr._request_tracker = mock_rt
        mgr._audio_sessions = {"client-1": True, "client-2": True}

        await mgr.cleanup()

        mock_cs.cleanup.assert_called_once()
        mock_rt.cleanup.assert_called_once()
        assert mgr._chat_streamer is None
        assert mgr._request_tracker is None
        assert mgr._audio_sessions == {}

    async def test_cleanup_without_cleanup_methods(self):
        mgr = RuntimeSessionManager()
        mgr._chat_streamer = MagicMock(spec=[])
        mgr._request_tracker = MagicMock(spec=[])
        mgr._audio_sessions = {"x": True}

        await mgr.cleanup()

        assert mgr._chat_streamer is None
        assert mgr._request_tracker is None
        assert mgr._audio_sessions == {}

    async def test_cleanup_when_nothing_initialized(self):
        mgr = RuntimeSessionManager()
        await mgr.cleanup()
        assert mgr._chat_streamer is None
        assert mgr._request_tracker is None

    async def test_idempotent_double_cleanup(self):
        mgr = RuntimeSessionManager()
        mock_cs = MagicMock()
        mock_cs.cleanup = AsyncMock()
        mock_rt = MagicMock()
        mock_rt.cleanup = AsyncMock()
        mgr._chat_streamer = mock_cs
        mgr._request_tracker = mock_rt

        await mgr.cleanup()
        await mgr.cleanup()

        mock_cs.cleanup.assert_called_once()
        mock_rt.cleanup.assert_called_once()


# ─── cancel_request() ────────────────────────────────────────────────────────


class TestCancelRequest:
    async def test_returns_false_when_no_tracker(self):
        mgr = RuntimeSessionManager()
        result = await mgr.cancel_request("req-1")
        assert result is False

    async def test_delegates_to_tracker(self):
        mgr = RuntimeSessionManager()
        mock_rt = MagicMock()
        mock_rt.cancel_request = AsyncMock(return_value=True)
        mgr._request_tracker = mock_rt

        result = await mgr.cancel_request("req-42")

        assert result is True
        mock_rt.cancel_request.assert_called_once_with("req-42")

    async def test_returns_false_from_tracker(self):
        mgr = RuntimeSessionManager()
        mock_rt = MagicMock()
        mock_rt.cancel_request = AsyncMock(return_value=False)
        mgr._request_tracker = mock_rt

        result = await mgr.cancel_request("req-unknown")
        assert result is False


# ─── reset_context() ─────────────────────────────────────────────────────────


class TestResetContext:
    async def test_clears_history_and_cancels_requests_and_removes_audio(self):
        mgr = RuntimeSessionManager()

        mock_cs = MagicMock()
        mock_cs.get_history.return_value = [{"role": "user", "content": "hi"}]
        mock_cs.clear_history = MagicMock()
        mgr._chat_streamer = mock_cs

        mock_rt = MagicMock()
        mock_rt.get_requests_by_client.return_value = {"req-1": {}, "req-2": {}}
        mock_rt.cancel_request = AsyncMock(return_value=True)
        mgr._request_tracker = mock_rt

        mgr._audio_sessions = {"client-A": True, "client-B": True}

        await mgr.reset_context("client-A")

        mock_cs.get_history.assert_called_once_with("client-A")
        mock_cs.clear_history.assert_called_once_with("client-A")
        mock_rt.get_requests_by_client.assert_called_once_with("client-A")
        assert mock_rt.cancel_request.call_count == 2
        assert "client-A" not in mgr._audio_sessions
        assert "client-B" in mgr._audio_sessions

    async def test_no_history_to_clear(self):
        mgr = RuntimeSessionManager()
        mock_cs = MagicMock()
        mock_cs.get_history.return_value = []
        mgr._chat_streamer = mock_cs

        mock_rt = MagicMock()
        mock_rt.get_requests_by_client.return_value = {}
        mgr._request_tracker = mock_rt

        await mgr.reset_context("client-X")

        mock_cs.clear_history.assert_not_called()

    async def test_no_streamer_or_tracker(self):
        mgr = RuntimeSessionManager()
        mgr._audio_sessions = {"client-Z": True}

        await mgr.reset_context("client-Z")

        assert "client-Z" not in mgr._audio_sessions

    async def test_client_not_in_audio_sessions(self):
        mgr = RuntimeSessionManager()
        mgr._audio_sessions = {"other": True}

        await mgr.reset_context("missing-client")

        assert mgr._audio_sessions == {"other": True}


# ─── cleanup_stale_resources() ────────────────────────────────────────────────


class TestCleanupStaleResources:
    async def test_returns_zero_when_no_tracker(self):
        mgr = RuntimeSessionManager()
        result = await mgr.cleanup_stale_resources()
        assert result == 0

    async def test_delegates_to_tracker(self):
        mgr = RuntimeSessionManager()
        mock_rt = MagicMock()
        mock_rt.cleanup_stale_requests = AsyncMock(return_value=5)
        mgr._request_tracker = mock_rt

        result = await mgr.cleanup_stale_resources()

        assert result == 5
        mock_rt.cleanup_stale_requests.assert_called_once()


# ─── stream_chat() ────────────────────────────────────────────────────────────


class TestStreamChat:
    async def test_raises_if_not_initialized(self):
        mgr = RuntimeSessionManager()
        with pytest.raises(RuntimeError, match="Chat streamer not initialized"):
            async for _ in mgr.stream_chat(
                client_id="c1",
                text="hello",
                image_b64=None,
                request_id="r1",
                interpreter=None,
                settings=MagicMock(),
            ):
                pass

    async def test_yields_chunks_from_streamer(self):
        mgr = RuntimeSessionManager()

        chunks = [
            {"type": "text", "content": "Hello "},
            {"type": "text", "content": "world"},
            {"type": "done"},
        ]

        async def mock_stream(**kwargs):
            for c in chunks:
                yield c

        mock_cs = MagicMock()
        mock_cs.stream_chat = mock_stream
        mgr._chat_streamer = mock_cs

        collected = []
        async for chunk in mgr.stream_chat(
            client_id="c1",
            text="hi",
            image_b64=None,
            request_id="r1",
            interpreter=None,
            settings=MagicMock(),
            chat_id="chat-1",
        ):
            collected.append(chunk)

        assert collected == chunks

    async def test_forwards_all_kwargs(self):
        mgr = RuntimeSessionManager()

        received_kwargs = {}

        async def mock_stream(**kwargs):
            received_kwargs.update(kwargs)
            return
            yield  # make it an async generator

        mock_cs = MagicMock()
        mock_cs.stream_chat = mock_stream
        mgr._chat_streamer = mock_cs

        interp = MagicMock()
        settings = MagicMock()
        async for _ in mgr.stream_chat(
            client_id="cid",
            text="msg",
            image_b64="base64data",
            request_id="rid",
            interpreter=interp,
            settings=settings,
            chat_id="chat-99",
        ):
            pass

        assert received_kwargs["client_id"] == "cid"
        assert received_kwargs["text"] == "msg"
        assert received_kwargs["image_b64"] == "base64data"
        assert received_kwargs["request_id"] == "rid"
        assert received_kwargs["interpreter"] is interp
        assert received_kwargs["settings"] is settings
        assert received_kwargs["chat_id"] == "chat-99"


# ─── Audio Session Methods ────────────────────────────────────────────────────


class TestAudioSessions:
    async def test_start_audio_stream(self):
        mgr = RuntimeSessionManager()
        await mgr.start_audio_stream("client-1")
        assert mgr._audio_sessions == {"client-1": True}

    async def test_end_audio_stream(self):
        mgr = RuntimeSessionManager()
        mgr._audio_sessions = {"client-1": True}
        await mgr.end_audio_stream("client-1")
        assert mgr._audio_sessions == {}

    async def test_end_audio_stream_missing_client(self):
        mgr = RuntimeSessionManager()
        await mgr.end_audio_stream("nonexistent")
        assert mgr._audio_sessions == {}

    async def test_handle_audio_chunk_returns_none(self):
        mgr = RuntimeSessionManager()
        result = await mgr.handle_audio_chunk("client-1", b"\x00\x01\x02")
        assert result is None


# ─── get_history() / set_history() ────────────────────────────────────────────


class TestHistoryMethods:
    def test_get_history_no_streamer(self):
        mgr = RuntimeSessionManager()
        assert mgr.get_history("sess-1") == []

    def test_get_history_delegates(self):
        mgr = RuntimeSessionManager()
        mock_cs = MagicMock()
        mock_cs.get_history.return_value = [{"role": "user", "content": "test"}]
        mgr._chat_streamer = mock_cs

        result = mgr.get_history("sess-1")

        assert result == [{"role": "user", "content": "test"}]
        mock_cs.get_history.assert_called_once_with("sess-1")

    def test_set_history_no_streamer(self):
        mgr = RuntimeSessionManager()
        result = mgr.set_history("sess-1", [{"role": "user", "content": "x"}])
        assert result == []

    def test_set_history_delegates_and_returns(self):
        mgr = RuntimeSessionManager()
        mock_cs = MagicMock()
        messages = [{"role": "user", "content": "hello"}]
        mock_cs.get_history.return_value = messages
        mgr._chat_streamer = mock_cs

        result = mgr.set_history("sess-1", messages)

        mock_cs.set_history.assert_called_once_with("sess-1", messages)
        mock_cs.get_history.assert_called_once_with("sess-1")
        assert result == messages

    def test_set_history_returns_empty_if_get_returns_none(self):
        mgr = RuntimeSessionManager()
        mock_cs = MagicMock()
        mock_cs.get_history.return_value = None
        mgr._chat_streamer = mock_cs

        result = mgr.set_history("sess-1", [])

        assert result == []


# ─── get_history_limit() ──────────────────────────────────────────────────────


class TestGetHistoryLimit:
    def test_no_streamer_returns_zero(self):
        mgr = RuntimeSessionManager()
        assert mgr.get_history_limit() == 0

    def test_delegates_to_streamer(self):
        mgr = RuntimeSessionManager()
        mock_cs = MagicMock()
        mock_cs.get_history_limit.return_value = 50
        mgr._chat_streamer = mock_cs

        assert mgr.get_history_limit() == 50
        mock_cs.get_history_limit.assert_called_once()


# ─── get_request_count() ─────────────────────────────────────────────────────


class TestGetRequestCount:
    def test_no_tracker_returns_zero(self):
        mgr = RuntimeSessionManager()
        assert mgr.get_request_count() == 0

    def test_delegates_to_tracker(self):
        mgr = RuntimeSessionManager()
        mock_rt = MagicMock()
        mock_rt.get_request_count.return_value = 7
        mgr._request_tracker = mock_rt

        assert mgr.get_request_count() == 7
        mock_rt.get_request_count.assert_called_once()


# ─── get_health_status() ─────────────────────────────────────────────────────


class TestGetHealthStatus:
    def test_nothing_initialized(self):
        mgr = RuntimeSessionManager()
        status = mgr.get_health_status()

        assert status["request_tracker"] == {"available": False}
        assert status["chat_streamer"] == {"available": False}
        assert status["audio_sessions"] == 0

    def test_fully_initialized_with_health_methods(self):
        mgr = RuntimeSessionManager()
        mock_rt = MagicMock()
        mock_rt.get_health_status.return_value = {"active": 3}
        mock_cs = MagicMock()
        mock_cs.get_health_status.return_value = {"streams": 2}
        mgr._request_tracker = mock_rt
        mgr._chat_streamer = mock_cs
        mgr._audio_sessions = {"a": True, "b": True}

        status = mgr.get_health_status()

        assert status["request_tracker"] == {"active": 3}
        assert status["chat_streamer"] == {"streams": 2}
        assert status["audio_sessions"] == 2

    def test_initialized_without_health_methods(self):
        mgr = RuntimeSessionManager()
        mgr._request_tracker = MagicMock(spec=[])
        mgr._chat_streamer = MagicMock(spec=[])

        status = mgr.get_health_status()

        assert status["request_tracker"] == {"available": True}
        assert status["chat_streamer"] == {"available": True}


# ─── Properties ───────────────────────────────────────────────────────────────


class TestProperties:
    def test_request_tracker_property(self):
        mgr = RuntimeSessionManager()
        mock_rt = MagicMock()
        mgr._request_tracker = mock_rt
        assert mgr.request_tracker is mock_rt

    def test_chat_streamer_property(self):
        mgr = RuntimeSessionManager()
        mock_cs = MagicMock()
        mgr._chat_streamer = mock_cs
        assert mgr.chat_streamer is mock_cs
