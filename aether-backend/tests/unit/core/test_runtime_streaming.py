"""
Unit Tests: ChatStreamer (core/runtime/streaming.py)

Covers constructor, stream_response, process_chunk, stream_chat (OI + HTTP paths),
TTS synthesis, conversation history, health status.

Mock boundaries:
  - interpreter (input/output async methods)
  - httpx streaming response (via config_manager.client_context)
  - TTS integration (optional)
"""

from __future__ import annotations

import asyncio
import sys
import base64
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.runtime.streaming import ChatStreamer
from core.runtime.request import RequestTracker


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_streamer(config_manager=None, request_tracker=None, enable_tts=False):
    cm = config_manager or MagicMock()
    rt = request_tracker or RequestTracker()
    return ChatStreamer(config_manager=cm, request_tracker=rt, enable_tts=enable_tts)


# ─── Constructor ──────────────────────────────────────────────────────────────


class TestChatStreamerInit:
    def test_with_provided_deps(self):
        cm = MagicMock()
        rt = MagicMock()
        cs = ChatStreamer(config_manager=cm, request_tracker=rt)
        assert cs._config_manager is cm
        assert cs._request_tracker is rt
        assert cs._tts_enabled is False
        assert cs._max_history_messages == 30
        assert cs._conversation_history == {}

    def test_defaults_create_instances(self):
        cs = ChatStreamer()
        assert cs._config_manager is not None
        assert cs._request_tracker is not None

    def test_tts_disabled_by_default(self):
        cs = _make_streamer()
        assert cs._tts_enabled is False
        assert cs._tts_integration is None

    def test_config_manager_import_fails(self):
        """Lines 59-60: ConfigManager import failure → _config_manager is None."""
        with patch.dict(sys.modules, {"core.runtime.config": None}):
            cs = ChatStreamer(config_manager=None, request_tracker=MagicMock())
        assert cs._config_manager is None

    def test_request_tracker_import_fails(self):
        """Lines 69-70: RequestTracker import failure → _request_tracker is None."""
        with patch.dict(sys.modules, {"core.runtime.request": None}):
            cs = ChatStreamer(config_manager=MagicMock(), request_tracker=None)
        assert cs._request_tracker is None

    def test_tts_init_qwen3_available(self):
        """Lines 82-104: TTS init with qwen3 engine, integration available."""
        mock_tts = MagicMock()
        mock_tts.is_available.return_value = True

        mock_audio_cfg = MagicMock()
        mock_audio_cfg.tts.voice = "alloy"
        mock_audio_cfg.tts.engine = "qwen3"
        mock_audio_cfg.tts.qwen3_model_path = "/models/qwen3"
        mock_audio_cfg.tts.qwen3_device = "cpu"
        mock_audio_cfg.tts.qwen3_instruct = True

        mock_tts_module = MagicMock()
        mock_tts_module.get_tts_integration.return_value = mock_tts

        mock_audio_module = MagicMock()
        mock_audio_module.get_audio_config.return_value = mock_audio_cfg

        with patch.dict(sys.modules, {
            "core.integrations.libraries.tts": mock_tts_module,
            "core.integrations.libraries": MagicMock(),
            "config.audio_config": mock_audio_module,
        }):
            cs = ChatStreamer(
                config_manager=MagicMock(),
                request_tracker=MagicMock(),
                enable_tts=True,
            )

        assert cs._tts_enabled is True
        assert cs._tts_integration is mock_tts
        mock_tts.initialize_engine.assert_called_once_with(
            "qwen3",
            voice="alloy",
            model_path="/models/qwen3",
            device="cpu",
            instruct=True,
        )

    def test_tts_init_non_qwen3_available(self):
        """Lines 82-104: TTS init with non-qwen3 engine (no qwen3 kwargs)."""
        mock_tts = MagicMock()
        mock_tts.is_available.return_value = True

        mock_audio_cfg = MagicMock()
        mock_audio_cfg.tts.voice = "nova"
        mock_audio_cfg.tts.engine = "openai"

        mock_tts_module = MagicMock()
        mock_tts_module.get_tts_integration.return_value = mock_tts

        mock_audio_module = MagicMock()
        mock_audio_module.get_audio_config.return_value = mock_audio_cfg

        with patch.dict(sys.modules, {
            "core.integrations.libraries.tts": mock_tts_module,
            "core.integrations.libraries": MagicMock(),
            "config.audio_config": mock_audio_module,
        }):
            cs = ChatStreamer(
                config_manager=MagicMock(),
                request_tracker=MagicMock(),
                enable_tts=True,
            )

        assert cs._tts_enabled is True
        mock_tts.initialize_engine.assert_called_once_with("openai", voice="nova")

    def test_tts_init_not_available(self):
        """Lines 105-107: TTS requested but integration not available."""
        mock_tts = MagicMock()
        mock_tts.is_available.return_value = False

        mock_tts_module = MagicMock()
        mock_tts_module.get_tts_integration.return_value = mock_tts

        mock_audio_module = MagicMock()

        with patch.dict(sys.modules, {
            "core.integrations.libraries.tts": mock_tts_module,
            "core.integrations.libraries": MagicMock(),
            "config.audio_config": mock_audio_module,
        }):
            cs = ChatStreamer(
                config_manager=MagicMock(),
                request_tracker=MagicMock(),
                enable_tts=True,
            )

        assert cs._tts_enabled is False

    def test_tts_init_exception(self):
        """Lines 108-110: TTS init raises exception → disabled."""
        mock_tts_module = MagicMock()
        mock_tts_module.get_tts_integration.side_effect = ImportError("no tts")

        with patch.dict(sys.modules, {
            "core.integrations.libraries.tts": mock_tts_module,
            "core.integrations.libraries": MagicMock(),
            "config.audio_config": MagicMock(),
        }):
            cs = ChatStreamer(
                config_manager=MagicMock(),
                request_tracker=MagicMock(),
                enable_tts=True,
            )

        assert cs._tts_enabled is False


# ─── process_chunk() ─────────────────────────────────────────────────────────


class TestProcessChunk:
    async def test_dict_passthrough(self):
        cs = _make_streamer()
        result = await cs.process_chunk({"role": "assistant", "content": "hi"})
        assert result == {"role": "assistant", "content": "hi"}

    async def test_non_dict_returns_none(self):
        cs = _make_streamer()
        assert await cs.process_chunk("not a dict") is None
        assert await cs.process_chunk(None) is None
        assert await cs.process_chunk(42) is None

    async def test_returns_copy(self):
        cs = _make_streamer()
        original = {"key": "value"}
        result = await cs.process_chunk(original)
        assert result is not original
        assert result == original


# ─── stream_response() ───────────────────────────────────────────────────────


class TestStreamResponse:
    async def test_iterates_and_processes(self):
        cs = _make_streamer()

        async def gen():
            yield {"type": "text", "content": "a"}
            yield {"type": "text", "content": "b"}
            yield "not a dict"

        collected = []
        async for chunk in cs.stream_response(gen()):
            collected.append(chunk)

        assert len(collected) == 2
        assert collected[0]["content"] == "a"


# ─── stream_chat() ───────────────────────────────────────────────────────────


class TestStreamChat:
    async def test_raises_without_tracker(self):
        # Constructor fallback creates a real RequestTracker when None is passed.
        # Force _request_tracker to None after construction to test the guard.
        cs = ChatStreamer(config_manager=MagicMock(), request_tracker=MagicMock())
        cs._request_tracker = None
        with pytest.raises(RuntimeError, match="RequestTracker is required"):
            async for _ in cs.stream_chat("c1", "hi", None, "r1"):
                pass

    async def test_oi_path_selected_with_interpreter(self):
        cs = _make_streamer()

        chunks = [
            {"role": "server", "type": "path", "source": "oi", "request_id": "r1"},
            {"role": "assistant", "type": "message", "start": True, "request_id": "r1"},
            {"role": "assistant", "type": "message", "content": "hello", "request_id": "r1"},
            {"role": "assistant", "type": "message", "end": True, "request_id": "r1"},
        ]

        async def _mock_oi_stream(*args, **kwargs):
            for c in chunks:
                yield c

        cs._stream_with_oi = _mock_oi_stream

        collected = []
        async for chunk in cs.stream_chat("c1", "hi", None, "r1", interpreter=MagicMock()):
            collected.append(chunk)

        assert len(collected) == 4
        assert collected[0]["source"] == "oi"

    async def test_http_path_without_interpreter(self):
        cs = _make_streamer()

        chunks = [
            {"role": "server", "type": "path", "source": "http", "request_id": "r1"},
            {"role": "assistant", "type": "message", "end": True, "request_id": "r1"},
        ]

        async def _mock_http_stream(*args, **kwargs):
            for c in chunks:
                yield c

        cs._stream_with_http = _mock_http_stream

        collected = []
        async for chunk in cs.stream_chat("c1", "hi", None, "r1", settings=MagicMock()):
            collected.append(chunk)

        assert collected[0]["source"] == "http"

    async def test_request_tracking_lifecycle(self):
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)

        async def _noop(*args, **kwargs):
            return
            yield

        cs._stream_with_http = _noop

        async for _ in cs.stream_chat("c1", "hi", None, "r1", settings=MagicMock()):
            pass

        # Request should be ended after stream completes
        assert rt.get_request_count() == 0


# ─── _stream_with_oi() ───────────────────────────────────────────────────────


class TestStreamWithOI:
    async def test_basic_flow(self):
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")

        # OI sends start, content chunks, then completion.
        # Code yields its own start before the loop and its own end after.
        # OI's start markers are skipped; if OI sends an end marker before
        # completion, code consumes it silently (sets sent_end flag) and does
        # NOT yield its own end — so omit OI end to test the normal path
        # where the code sends its own end after completion.
        output_sequence = [
            {"role": "assistant", "type": "message", "start": True},
            {"role": "assistant", "type": "message", "content": "Hello"},
            {"role": "assistant", "type": "message", "content": " world"},
            {"role": "server", "type": "completion"},
        ]
        idx = {"i": 0}

        mock_interp = MagicMock()
        mock_interp.input = AsyncMock()

        async def _output():
            i = idx["i"]
            idx["i"] += 1
            return output_sequence[i]

        mock_interp.output = _output

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        # path + start + content + content + end
        types = [(c.get("type"), c.get("content")) for c in collected]
        assert ("path", None) in [(t, c) for t, c in types]
        assert any(c.get("content") == "Hello" for c in collected)
        assert any(c.get("content") == " world" for c in collected)
        assert any(c.get("end") is True for c in collected)

    async def test_with_image(self):
        cs = _make_streamer()

        mock_interp = MagicMock()
        mock_interp.input = AsyncMock()

        call_count = {"i": 0}
        async def _output():
            call_count["i"] += 1
            if call_count["i"] == 1:
                return {"role": "server", "type": "completion"}
            return None

        mock_interp.output = _output

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "text", "base64img", "r1"):
            collected.append(chunk)

        # Verify image was sent
        calls = mock_interp.input.call_args_list
        image_calls = [c for c in calls if c[0][0].get("type") == "image"]
        assert len(image_calls) == 1

    async def test_cancellation(self):
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")
        await rt.cancel_request("r1")

        mock_interp = MagicMock()
        mock_interp.input = AsyncMock()
        mock_interp.output = AsyncMock()  # Should not be called

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        assert any(c.get("type") == "stopped" for c in collected)

    async def test_error_handling(self):
        cs = _make_streamer()

        mock_interp = MagicMock()
        mock_interp.input = AsyncMock(side_effect=ConnectionError("ws closed"))

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        assert any(c.get("type") == "error" for c in collected)

    async def test_non_dict_output_skipped(self):
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")
        mock_interp = MagicMock()
        mock_interp.input = AsyncMock()

        outputs = [
            "not a dict",
            {"role": "assistant", "type": "message", "content": "valid"},
            {"role": "server", "type": "completion"},
        ]
        idx = {"i": 0}

        async def _output():
            i = idx["i"]
            idx["i"] += 1
            return outputs[i]

        mock_interp.output = _output

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        assert any(c.get("content") == "valid" for c in collected)

    async def test_id_removed_from_output(self):
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")
        mock_interp = MagicMock()
        mock_interp.input = AsyncMock()

        outputs = [
            {"id": "oi-uuid", "role": "computer", "type": "code", "content": "print('hi')"},
            {"role": "server", "type": "completion"},
        ]
        idx = {"i": 0}

        async def _output():
            i = idx["i"]
            idx["i"] += 1
            return outputs[i]

        mock_interp.output = _output

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        # The forwarded chunk should have request_id, not id
        forwarded = [c for c in collected if c.get("role") == "computer"]
        assert len(forwarded) == 1
        assert "id" not in forwarded[0]
        assert forwarded[0]["request_id"] == "r1"

    async def test_ui_content_extracted_and_format_changed(self):
        """Verify that hidden __ui_content is extracted to content and format is forced to html."""
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")
        mock_interp = MagicMock()
        mock_interp.input = AsyncMock()

        outputs = [
            {
                "role": "computer",
                "type": "console",
                "format": "output",
                "content": "[HTML executed successfully]",
                "__ui_content": "<h1>Real HTML</h1>"
            },
            {"role": "server", "type": "completion"},
        ]
        idx = {"i": 0}

        async def _output():
            i = idx["i"]
            idx["i"] += 1
            return outputs[i]

        mock_interp.output = _output

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        # Check the console output chunk
        console_chunks = [c for c in collected if c.get("type") == "console"]
        assert len(console_chunks) == 1
        assert console_chunks[0]["content"] == "<h1>Real HTML</h1>"
        assert console_chunks[0]["format"] == "html"
        assert "__ui_content" not in console_chunks[0]

    async def test_oi_end_marker_consumed(self):
        """Lines 278-279: OI end marker sets sent_end=True, no own end yielded."""
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")

        outputs = [
            {"role": "assistant", "type": "message", "end": True},
            {"role": "server", "type": "completion"},
        ]
        idx = {"i": 0}
        mock_interp = MagicMock()
        mock_interp.input = AsyncMock()

        async def _output():
            i = idx["i"]
            idx["i"] += 1
            return outputs[i]

        mock_interp.output = _output

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        # OI end was consumed (sent_end=True), code does not yield its own end
        end_chunks = [c for c in collected if c.get("end") is True]
        assert len(end_chunks) == 0

    async def test_tts_synthesis_after_oi_stream(self):
        """Lines 299-301: TTS synthesis when enabled and text buffer has content."""
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")
        cs._tts_enabled = True
        cs._tts_integration = MagicMock()
        cs._tts_integration.synthesize_text_async = AsyncMock(return_value=b"\x00\x01")

        outputs = [
            {"role": "assistant", "type": "message", "content": "Hello"},
            {"role": "server", "type": "completion"},
        ]
        idx = {"i": 0}
        mock_interp = MagicMock()
        mock_interp.input = AsyncMock()

        async def _output():
            i = idx["i"]
            idx["i"] += 1
            return outputs[i]

        mock_interp.output = _output

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        assert any(c.get("type") == "tts-audio" for c in collected)
        cs._tts_integration.synthesize_text_async.assert_awaited_once_with("Hello")

    async def test_cancelled_error_yields_stopped_and_end(self):
        """Lines 313-327: asyncio.CancelledError yields stopped + end (sent_end=False)."""
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")

        mock_interp = MagicMock()
        mock_interp.input = AsyncMock(side_effect=asyncio.CancelledError())

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        assert any(
            c.get("type") == "stopped" and c.get("message") == "Generation cancelled"
            for c in collected
        )
        assert any(c.get("end") is True for c in collected)

    async def test_cancelled_error_after_end_sent(self):
        """Lines 313, 320 branch: CancelledError when sent_end is already True."""
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")

        mock_interp = MagicMock()
        mock_interp.input = AsyncMock()
        call_count = {"i": 0}

        async def _output():
            call_count["i"] += 1
            if call_count["i"] == 1:
                # OI end marker → sets sent_end = True
                return {"role": "assistant", "type": "message", "end": True}
            raise asyncio.CancelledError()

        mock_interp.output = _output

        collected = []
        async for chunk in cs._stream_with_oi(mock_interp, "c1", "hi", None, "r1"):
            collected.append(chunk)

        assert any(c.get("message") == "Generation cancelled" for c in collected)
        # No end message because sent_end was already True
        end_chunks = [c for c in collected if c.get("end") is True]
        assert len(end_chunks) == 0


# ─── _stream_with_http() ─────────────────────────────────────────────────────


class TestStreamWithHTTP:
    def _make_settings(self, provider="lm-studio", supports_vision=False, api_key=""):
        s = MagicMock()
        s.llm.api_base = "http://localhost:1234/v1"
        s.llm.model = "qwen3-4b"
        s.llm.api_key = api_key
        s.llm.supports_vision = supports_vision
        s.llm.max_tokens = 4096
        s.llm.provider = provider
        return s

    async def test_basic_http_stream(self):
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")
        settings = self._make_settings()

        sse_lines = [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            'data: {"choices":[{"delta":{"content":" world"}}]}',
            "data: [DONE]",
        ]

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        async def _aiter_lines():
            for line in sse_lines:
                yield line

        mock_resp.aiter_lines = _aiter_lines

        mock_client = MagicMock()

        class _FakeStream:
            def __init__(self, *a, **kw):
                pass
            async def __aenter__(self):
                return mock_resp
            async def __aexit__(self, *a):
                pass

        mock_client.stream = _FakeStream

        class _FakeContext:
            async def __aenter__(self_inner):
                return mock_client
            async def __aexit__(self_inner, *a):
                pass

        cs._config_manager.client_context = _FakeContext

        collected = []
        async for chunk in cs._stream_with_http(settings, "c1", "hi", None, "r1"):
            collected.append(chunk)

        contents = [c.get("content") for c in collected if c.get("content")]
        assert "Hello" in contents
        assert " world" in contents
        assert any(c.get("end") is True for c in collected)

    async def test_empty_choices_skipped(self):
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")
        settings = self._make_settings()

        sse_lines = [
            'data: {"choices":[]}',
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            "data: [DONE]",
        ]

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        async def _aiter_lines():
            for line in sse_lines:
                yield line

        mock_resp.aiter_lines = _aiter_lines

        mock_client = MagicMock()

        class _FakeStream:
            def __init__(self, *a, **kw):
                pass
            async def __aenter__(self):
                return mock_resp
            async def __aexit__(self, *a):
                pass

        mock_client.stream = _FakeStream

        class _FakeContext:
            async def __aenter__(self_inner):
                return mock_client
            async def __aexit__(self_inner, *a):
                pass

        cs._config_manager.client_context = _FakeContext

        collected = []
        async for chunk in cs._stream_with_http(settings, "c1", "hi", None, "r1"):
            collected.append(chunk)

        contents = [c.get("content") for c in collected if c.get("content")]
        assert contents == ["ok"]

    async def test_invalid_json_skipped(self):
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")
        settings = self._make_settings()

        sse_lines = [
            "data: not-json",
            'data: {"choices":[{"delta":{"content":"valid"}}]}',
            "data: [DONE]",
        ]

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        async def _aiter_lines():
            for line in sse_lines:
                yield line

        mock_resp.aiter_lines = _aiter_lines
        mock_client = MagicMock()

        class _FakeStream:
            def __init__(self, *a, **kw):
                pass
            async def __aenter__(self):
                return mock_resp
            async def __aexit__(self, *a):
                pass

        mock_client.stream = _FakeStream

        class _FakeContext:
            async def __aenter__(s):
                return mock_client
            async def __aexit__(s, *a):
                pass

        cs._config_manager.client_context = _FakeContext

        collected = []
        async for chunk in cs._stream_with_http(settings, "c1", "hi", None, "r1"):
            collected.append(chunk)

        assert any(c.get("content") == "valid" for c in collected)

    async def test_empty_sse_lines_skipped(self):
        """Line 433: empty lines in SSE stream are skipped."""
        rt = RequestTracker()
        cs = _make_streamer(request_tracker=rt)
        await rt.start_request("r1", "c1")
        settings = self._make_settings()

        sse_lines = [
            "",  # empty line — skipped by `if not line: continue`
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            "",  # another empty line
            "data: [DONE]",
        ]

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        async def _aiter_lines():
            for line in sse_lines:
                yield line

        mock_resp.aiter_lines = _aiter_lines
        mock_client = MagicMock()

        class _FakeStream:
            def __init__(self, *a, **kw):
                pass
            async def __aenter__(self):
                return mock_resp
            async def __aexit__(self, *a):
                pass

        mock_client.stream = _FakeStream

        class _FakeContext:
            async def __aenter__(s):
                return mock_client
            async def __aexit__(s, *a):
                pass

        cs._config_manager.client_context = _FakeContext

        collected = []
        async for chunk in cs._stream_with_http(settings, "c1", "hi", None, "r1"):
            collected.append(chunk)

        contents = [c.get("content") for c in collected if c.get("content")]
        assert contents == ["ok"]

    async def test_http_error_yields_error_chunk(self):
        cs = _make_streamer()
        settings = self._make_settings()

        class _FailContext:
            async def __aenter__(self):
                raise ConnectionError("connection refused")
            async def __aexit__(self, *a):
                pass

        cs._config_manager.client_context = _FailContext

        collected = []
        async for chunk in cs._stream_with_http(settings, "c1", "hi", None, "r1"):
            collected.append(chunk)

        assert any(c.get("type") == "error" for c in collected)

    async def test_openai_prefix_stripped(self):
        cs = _make_streamer()
        settings = self._make_settings()
        settings.llm.model = "openai/gpt-4"

        sse_lines = ["data: [DONE]"]
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        async def _aiter_lines():
            for line in sse_lines:
                yield line

        mock_resp.aiter_lines = _aiter_lines
        mock_client = MagicMock()

        captured_payload = {}

        class _FakeStream:
            def __init__(self, method, url, json=None, headers=None):
                captured_payload.update(json or {})

            async def __aenter__(self):
                return mock_resp
            async def __aexit__(self, *a):
                pass

        mock_client.stream = _FakeStream

        class _FakeContext:
            async def __aenter__(s):
                return mock_client
            async def __aexit__(s, *a):
                pass

        cs._config_manager.client_context = _FakeContext

        async for _ in cs._stream_with_http(settings, "c1", "hi", None, "r1"):
            pass

        assert captured_payload["model"] == "gpt-4"

    async def test_aether_inference_provider(self):
        cs = _make_streamer()
        settings = self._make_settings(provider="aether_inference")
        settings.inference_url = "http://inference:8080/v1"

        sse_lines = ["data: [DONE]"]
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        async def _aiter_lines():
            for line in sse_lines:
                yield line

        mock_resp.aiter_lines = _aiter_lines
        mock_client = MagicMock()

        captured_url = {}

        class _FakeStream:
            def __init__(self, method, url, json=None, headers=None):
                captured_url["url"] = url

            async def __aenter__(self):
                return mock_resp
            async def __aexit__(self, *a):
                pass

        mock_client.stream = _FakeStream

        class _FakeContext:
            async def __aenter__(s):
                return mock_client
            async def __aexit__(s, *a):
                pass

        cs._config_manager.client_context = _FakeContext

        async for _ in cs._stream_with_http(settings, "c1", "hi", None, "r1"):
            pass

        assert "inference:8080" in captured_url["url"]

    async def test_vision_content_blocks(self):
        cs = _make_streamer()
        settings = self._make_settings(supports_vision=True)

        sse_lines = ["data: [DONE]"]
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        async def _aiter_lines():
            for line in sse_lines:
                yield line

        mock_resp.aiter_lines = _aiter_lines
        mock_client = MagicMock()

        captured_payload = {}

        class _FakeStream:
            def __init__(self, method, url, json=None, headers=None):
                captured_payload.update(json or {})

            async def __aenter__(self):
                return mock_resp
            async def __aexit__(self, *a):
                pass

        mock_client.stream = _FakeStream

        class _FakeContext:
            async def __aenter__(s):
                return mock_client
            async def __aexit__(s, *a):
                pass

        cs._config_manager.client_context = _FakeContext

        async for _ in cs._stream_with_http(settings, "c1", "hi", "base64img", "r1"):
            pass

        user_msg = captured_payload["messages"][-1]
        content = user_msg["content"]
        assert isinstance(content, list)
        assert any(b["type"] == "image_url" for b in content)

    async def test_api_key_in_header(self):
        cs = _make_streamer()
        settings = self._make_settings(api_key="sk-test-key")

        sse_lines = ["data: [DONE]"]
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        async def _aiter_lines():
            for line in sse_lines:
                yield line

        mock_resp.aiter_lines = _aiter_lines
        mock_client = MagicMock()

        captured_headers = {}

        class _FakeStream:
            def __init__(self, method, url, json=None, headers=None):
                captured_headers.update(headers or {})

            async def __aenter__(self):
                return mock_resp
            async def __aexit__(self, *a):
                pass

        mock_client.stream = _FakeStream

        class _FakeContext:
            async def __aenter__(s):
                return mock_client
            async def __aexit__(s, *a):
                pass

        cs._config_manager.client_context = _FakeContext

        async for _ in cs._stream_with_http(settings, "c1", "hi", None, "r1"):
            pass

        assert captured_headers["Authorization"] == "Bearer sk-test-key"


# ─── _create_stop_message() ──────────────────────────────────────────────────


class TestCreateStopMessage:
    def test_default_message(self):
        cs = _make_streamer()
        msg = cs._create_stop_message("r1")
        assert msg == {
            "role": "server",
            "type": "stopped",
            "request_id": "r1",
            "message": "Generation stopped by backend",
        }

    def test_custom_message(self):
        cs = _make_streamer()
        msg = cs._create_stop_message("r1", "custom stop")
        assert msg["message"] == "custom stop"


# ─── _synthesize_tts() ───────────────────────────────────────────────────────


class TestSynthesizeTTS:
    async def test_no_integration(self):
        cs = _make_streamer()
        collected = []
        async for chunk in cs._synthesize_tts("hello", "r1"):
            collected.append(chunk)
        assert collected == []

    async def test_empty_text(self):
        cs = _make_streamer()
        cs._tts_integration = MagicMock()
        collected = []
        async for chunk in cs._synthesize_tts("   ", "r1"):
            collected.append(chunk)
        assert collected == []

    async def test_success(self):
        cs = _make_streamer()
        cs._tts_integration = MagicMock()
        cs._tts_integration.synthesize_text_async = AsyncMock(return_value=b"\x00\x01\x02")

        collected = []
        async for chunk in cs._synthesize_tts("hello world", "r1"):
            collected.append(chunk)

        assert len(collected) == 1
        assert collected[0]["type"] == "tts-audio"
        assert collected[0]["format"] == "wav"
        decoded = base64.b64decode(collected[0]["audio"])
        assert decoded == b"\x00\x01\x02"

    async def test_empty_audio(self):
        cs = _make_streamer()
        cs._tts_integration = MagicMock()
        cs._tts_integration.synthesize_text_async = AsyncMock(return_value=b"")

        collected = []
        async for chunk in cs._synthesize_tts("hello", "r1"):
            collected.append(chunk)
        assert collected == []

    async def test_exception_suppressed(self):
        cs = _make_streamer()
        cs._tts_integration = MagicMock()
        cs._tts_integration.synthesize_text_async = AsyncMock(side_effect=RuntimeError("tts crash"))

        collected = []
        async for chunk in cs._synthesize_tts("hello", "r1"):
            collected.append(chunk)
        assert collected == []


# ─── _update_conversation_history() ──────────────────────────────────────────


class TestUpdateConversationHistory:
    def test_basic_update(self):
        cs = _make_streamer()
        cs._update_conversation_history("c1", [], ["Hello", " world"])

        assert "c1" in cs._conversation_history
        assert cs._conversation_history["c1"][-1]["content"] == "Hello world"
        assert cs._conversation_history["c1"][-1]["role"] == "assistant"

    def test_caps_history(self):
        cs = _make_streamer()
        cs._max_history_messages = 5

        # Fill with 6 messages
        cs._conversation_history["c1"] = [
            {"role": "user", "content": f"msg-{i}"} for i in range(5)
        ]
        cs._update_conversation_history("c1", [], ["response"])

        assert len(cs._conversation_history["c1"]) <= 5

    def test_preserves_system_message(self):
        cs = _make_streamer()
        cs._max_history_messages = 3

        cs._conversation_history["c1"] = [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "msg1"},
            {"role": "assistant", "content": "resp1"},
            {"role": "user", "content": "msg2"},
        ]

        cs._update_conversation_history("c1", [], ["resp2"])

        history = cs._conversation_history["c1"]
        assert history[0]["role"] == "system"


# ─── get_health_status() ─────────────────────────────────────────────────────


class TestGetHealthStatus:
    def test_empty(self):
        cs = _make_streamer()
        status = cs.get_health_status()
        assert status["config_manager_available"] is True
        assert status["request_tracker_available"] is True
        assert status["active_history_sessions"] == 0
        assert status["max_history_length"] == 0

    def test_with_histories(self):
        cs = _make_streamer()
        cs._conversation_history = {
            "c1": [{"role": "user", "content": "hi"}],
            "c2": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}],
        }
        status = cs.get_health_status()
        assert status["active_history_sessions"] == 2
        assert status["max_history_length"] == 2


# ─── History Methods ─────────────────────────────────────────────────────────


class TestHistoryMethods:
    def test_get_history_returns_copy(self):
        cs = _make_streamer()
        cs._conversation_history["c1"] = [{"role": "user", "content": "hi"}]

        h = cs.get_history("c1")
        assert h == [{"role": "user", "content": "hi"}]
        h.append({"role": "extra"})
        assert len(cs._conversation_history["c1"]) == 1

    def test_get_history_empty(self):
        cs = _make_streamer()
        assert cs.get_history("nonexistent") == []

    def test_get_history_limit(self):
        cs = _make_streamer()
        assert cs.get_history_limit() == 30

    def test_clear_history_specific(self):
        cs = _make_streamer()
        cs._conversation_history = {"c1": [{"x": 1}], "c2": [{"y": 2}]}
        cs.clear_history("c1")
        assert "c1" not in cs._conversation_history
        assert "c2" in cs._conversation_history

    def test_clear_history_all(self):
        cs = _make_streamer()
        cs._conversation_history = {"c1": [{"x": 1}], "c2": [{"y": 2}]}
        cs.clear_history()
        assert cs._conversation_history == {}


# ─── set_history() ───────────────────────────────────────────────────────────


class TestSetHistory:
    def test_basic_hydration(self):
        cs = _make_streamer()
        cs.set_history("c1", [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi there"},
        ])
        assert len(cs._conversation_history["c1"]) == 2

    def test_preserves_dict_metadata(self):
        cs = _make_streamer()
        cs.set_history("c1", [
            {
                "role": "user",
                "content": "hello",
                "metadata": {"source": "proactive", "context": {"k": "v"}},
            },
        ])
        assert len(cs._conversation_history["c1"]) == 1
        assert cs._conversation_history["c1"][0]["metadata"] == {
            "source": "proactive",
            "context": {"k": "v"},
        }

    def test_normalizes_non_dict_metadata(self):
        cs = _make_streamer()
        cs.set_history("c1", [
            {"role": "user", "content": "hello", "metadata": "raw"},
            {"role": "assistant", "content": "hi", "metadata": None},
        ])
        assert len(cs._conversation_history["c1"]) == 2
        assert cs._conversation_history["c1"][0]["metadata"] == {}
        assert cs._conversation_history["c1"][1]["metadata"] == {}

    def test_filters_invalid_entries(self):
        cs = _make_streamer()
        cs.set_history("c1", [
            "not a dict",
            {"role": "invalid_role", "content": "x"},
            {"role": "user"},  # no content
            {"role": "user", "content": ""},  # empty content
            {"role": "user", "content": "valid"},
        ])
        assert len(cs._conversation_history["c1"]) == 1
        assert cs._conversation_history["c1"][0]["content"] == "valid"

    def test_non_list_clears(self):
        cs = _make_streamer()
        cs._conversation_history["c1"] = [{"role": "user", "content": "old"}]
        cs.set_history("c1", "not a list")
        assert "c1" not in cs._conversation_history

    def test_empty_normalized_clears(self):
        cs = _make_streamer()
        cs._conversation_history["c1"] = [{"role": "user", "content": "old"}]
        cs.set_history("c1", [{"role": "invalid", "content": "x"}])
        assert "c1" not in cs._conversation_history

    def test_enforces_max_history(self):
        cs = _make_streamer()
        cs._max_history_messages = 3

        messages = [{"role": "user", "content": f"msg-{i}"} for i in range(10)]
        cs.set_history("c1", messages)
        assert len(cs._conversation_history["c1"]) <= 3

    def test_preserves_system_prefix(self):
        """System message is preserved when messages fit within max_history (no trimming)."""
        cs = _make_streamer()
        cs._max_history_messages = 4

        messages = [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "msg-0"},
            {"role": "assistant", "content": "resp-0"},
            {"role": "user", "content": "msg-1"},
        ]
        cs.set_history("c1", messages)

        history = cs._conversation_history["c1"]
        assert len(history) == 4
        assert history[0]["role"] == "system"

    def test_system_prefix_lost_when_heavily_trimmed(self):
        """set_history re-trim logic drops system prefix when list exceeds max_history.

        Lines 671-672: after prepending system to trimmed, if len > max_history,
        trimmed[-max_history:] removes system since it was just prepended.
        This test documents the actual code behavior.
        """
        cs = _make_streamer()
        cs._max_history_messages = 3

        messages = [
            {"role": "system", "content": "system prompt"},
        ] + [{"role": "user", "content": f"msg-{i}"} for i in range(10)]
        cs.set_history("c1", messages)

        history = cs._conversation_history["c1"]
        assert len(history) == 3
        # System prefix is lost due to re-trim
        assert history[0]["role"] == "user"

    def test_non_string_content_converted(self):
        cs = _make_streamer()
        cs.set_history("c1", [
            {"role": "user", "content": 42},
        ])
        assert cs._conversation_history["c1"][0]["content"] == "42"

    def test_content_none_filtered(self):
        cs = _make_streamer()
        cs.set_history("c1", [
            {"role": "user", "content": None},
            {"role": "user", "content": "valid"},
        ])
        assert len(cs._conversation_history["c1"]) == 1

    def test_str_conversion_failure_filtered(self):
        """Lines 649-651: content where str() raises TypeError → skipped."""
        cs = _make_streamer()

        class BadStr:
            def __str__(self):
                raise TypeError("cannot convert")

        cs.set_history("c1", [
            {"role": "user", "content": BadStr()},
            {"role": "user", "content": "valid"},
        ])
        assert len(cs._conversation_history["c1"]) == 1
        assert cs._conversation_history["c1"][0]["content"] == "valid"

    def test_str_conversion_empty_filtered(self):
        """Line 653: str(content).strip() gives empty → skipped."""
        cs = _make_streamer()

        class EmptyStr:
            def __str__(self):
                return "   "  # whitespace only → empty after strip

        cs.set_history("c1", [
            {"role": "user", "content": EmptyStr()},
            {"role": "user", "content": "valid"},
        ])
        assert len(cs._conversation_history["c1"]) == 1
        assert cs._conversation_history["c1"][0]["content"] == "valid"
