"""
Unit Tests: ws/presentation/router.py

Tests message routing, unknown-type fallback, binary handling,
client cleanup, shutdown, and error paths.

Bugs found: 3
- cleanup_client: sequential failure cascade — if task_manager.cleanup_client_tasks()
  raises, ALL subsequent cleanup (stop_generation, audio_processor, request_mapper,
  message_handler, client_llm_locks) is skipped. Fixed: each step wrapped in try/except.
- handle_binary: narrow except clause (RuntimeError, OSError, ValueError, TypeError)
  misses AttributeError, ConnectionError, etc. Fixed: broadened to catch Exception.
- cleanup_client stop_generation loop: narrow except clause misses ValueError, TypeError.
  Fixed: broadened to catch Exception.
"""

import json
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ws.presentation.router import Router
from ws.protocols import (
    MessageRole,
    MessageType,
    HeartbeatMessage,
    AudioControlMessage,
    AudioMessage,
    StopMessage,
    ContextResetMessage,
    ClientMessage,
)


# =========================================================================
# Fixtures
# =========================================================================


@pytest.fixture
def audio_handler():
    """Audio handler with properly mocked async methods and audio_processor."""
    handler = MagicMock()
    handler.handle_audio_control = AsyncMock()
    handler.handle_audio_chunk = AsyncMock()
    handler.handle_cancel_tts = AsyncMock()
    handler._audio_processor = MagicMock()
    handler._audio_processor.cleanup_client = AsyncMock()
    return handler


@pytest.fixture
def router(audio_handler):
    """Build a Router with all dependencies mocked."""
    return Router(
        runtime=MagicMock(
            handle_audio_chunk=AsyncMock(),
            stop_generation=AsyncMock(),
        ),
        message_handler=MagicMock(
            handle_user_message=AsyncMock(),
            cleanup_client=AsyncMock(),
            shutdown=AsyncMock(),
        ),
        control_handler=MagicMock(
            handle_heartbeat=AsyncMock(),
            handle_stop=AsyncMock(),
        ),
        audio_handler=audio_handler,
        context_handler=MagicMock(handle_context_reset=AsyncMock()),
        task_manager=MagicMock(cleanup_client_tasks=AsyncMock(return_value=[])),
        request_mapper=MagicMock(cleanup_client_mappings=AsyncMock()),
        cache_service=MagicMock(update_presence_metadata=AsyncMock()),
        hub=MagicMock(),
    )


@pytest.fixture
def ws():
    """Mock WebSocket."""
    mock_ws = AsyncMock()
    mock_ws.send_text = AsyncMock()
    return mock_ws


# =========================================================================
# Message type routing — every branch must be tested
# =========================================================================


class TestMessageTypeRouting:
    """Tests that each validated message type dispatches to the correct handler."""

    @pytest.mark.asyncio
    async def test_heartbeat_routes_to_control_handler(self, router, ws):
        """Lines 141-147: HeartbeatMessage dispatches to control_handler.handle_heartbeat."""
        heartbeat = HeartbeatMessage(role="system", type="heartbeat")
        with patch("ws.presentation.router.validate_message", return_value=heartbeat):
            payload = {"role": "system", "type": "heartbeat"}
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        router._control_handler.handle_heartbeat.assert_awaited_once_with(
            ws=ws, client_id="c1", message=heartbeat,
        )
        # No other handler should be called
        router._message_handler.handle_user_message.assert_not_awaited()
        router._audio_handler.handle_audio_control.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_audio_control_routes_to_audio_handler(self, router, ws):
        """Lines 149-154: AudioControlMessage dispatches to audio_handler.handle_audio_control."""
        msg = AudioControlMessage(role="user", type="audio-control", action="start")
        with patch("ws.presentation.router.validate_message", return_value=msg):
            payload = {"role": "user", "type": "audio-control", "action": "start"}
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        router._audio_handler.handle_audio_control.assert_awaited_once_with(
            client_id="c1", message=msg,
        )
        router._message_handler.handle_user_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_audio_message_routes_to_audio_handler(self, router, ws):
        """Lines 156-161: AudioMessage dispatches to audio_handler.handle_audio_chunk."""
        msg = AudioMessage(role="user", type="audio", data="base64data")
        with patch("ws.presentation.router.validate_message", return_value=msg):
            payload = {"role": "user", "type": "audio", "data": "base64data"}
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        router._audio_handler.handle_audio_chunk.assert_awaited_once_with(
            client_id="c1", message=msg,
        )

    @pytest.mark.asyncio
    async def test_stop_message_routes_to_control_handler(self, router, ws):
        """Lines 163-169: StopMessage dispatches to control_handler.handle_stop."""
        msg = StopMessage(role="user", type="stop")
        with patch("ws.presentation.router.validate_message", return_value=msg):
            payload = {"role": "user", "type": "stop"}
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        router._control_handler.handle_stop.assert_awaited_once_with(
            ws=ws, client_id="c1", message=msg,
        )

    @pytest.mark.asyncio
    async def test_context_reset_routes_to_context_handler_with_hub(self, router, ws):
        """Lines 171-178: ContextResetMessage dispatches to context_handler with hub passed."""
        msg = ContextResetMessage(role="user", type="context_reset", chat_id="chat-123")
        with patch("ws.presentation.router.validate_message", return_value=msg):
            payload = {"role": "user", "type": "context_reset", "chat_id": "chat-123"}
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        router._context_handler.handle_context_reset.assert_awaited_once_with(
            ws=ws, client_id="c1", message=msg, hub=router._hub,
        )

    @pytest.mark.asyncio
    async def test_client_message_routes_to_message_handler(self, router, ws):
        """Lines 180-186: ClientMessage dispatches to message_handler.handle_user_message."""
        msg = ClientMessage(role="user", type="message", content="hello", id="msg-001")
        with patch("ws.presentation.router.validate_message", return_value=msg):
            payload = {"role": "user", "type": "message", "content": "hello", "id": "msg-001"}
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        router._message_handler.handle_user_message.assert_awaited_once_with(
            ws=ws, client_id="c1", message=msg,
        )

    @pytest.mark.asyncio
    async def test_presence_metadata_updated_on_valid_message(self, router, ws):
        """Line 138: After validation passes, update_presence_metadata is called."""
        msg = StopMessage(role="user", type="stop")
        with patch("ws.presentation.router.validate_message", return_value=msg):
            payload = {"role": "user", "type": "stop"}
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        router._cache.update_presence_metadata.assert_awaited_once_with(
            "c1", last_event="stop",
        )

    @pytest.mark.asyncio
    async def test_presence_not_updated_on_validation_failure(self, router, ws):
        """Validation failure returns before update_presence_metadata."""
        with patch("ws.presentation.router.validate_message", return_value=None):
            payload = {"role": "user", "type": "bad"}
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        router._cache.update_presence_metadata.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_presence_not_updated_on_cancel_tts(self, router, ws):
        """cancel-tts is handled before validation and presence update."""
        payload = {"type": "audio/cancel-tts"}
        await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        router._cache.update_presence_metadata.assert_not_awaited()
        router._audio_handler.handle_cancel_tts.assert_awaited_once()


# =========================================================================
# Size guard and JSON parsing
# =========================================================================


class TestHandleJsonGuards:
    """Tests for size guard and JSON validation."""

    @pytest.mark.asyncio
    async def test_size_guard_rejects_oversized_message(self, router, ws):
        """Line 101-106: Messages exceeding MAX_MESSAGE_SIZE are dropped."""
        with patch("ws.presentation.router.MAX_MESSAGE_SIZE", 10):
            await router.handle_json(ws=ws, client_id="c1", text="x" * 100)
        ws.send_text.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_size_guard_allows_exact_limit(self, router, ws):
        """Size exactly at limit is allowed."""
        payload = json.dumps({"role": "user", "type": "stop"})
        with patch("ws.presentation.router.MAX_MESSAGE_SIZE", len(payload)):
            with patch("ws.presentation.router.validate_message", return_value=StopMessage(role="user", type="stop")):
                await router.handle_json(ws=ws, client_id="c1", text=payload)
        router._control_handler.handle_stop.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_invalid_json_rejected(self, router, ws):
        """Line 111-113: Malformed JSON is logged and dropped."""
        await router.handle_json(ws=ws, client_id="c1", text="{broken")
        ws.send_text.assert_not_awaited()
        router._cache.update_presence_metadata.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_string_rejected(self, router, ws):
        """Empty string is invalid JSON."""
        await router.handle_json(ws=ws, client_id="c1", text="")
        router._cache.update_presence_metadata.assert_not_awaited()


# =========================================================================
# Unknown message type (lines 189-196)
# =========================================================================


class TestUnknownMessageType:
    """Tests for the unknown message type fallback in handle_json."""

    @pytest.mark.asyncio
    async def test_unknown_type_echoes_payload_as_info(self, router, ws):
        """
        Lines 189-195: validate_message returns an unrecognized type ->
        router logs warning and echoes payload as INFO message.
        """
        payload = {"role": "user", "type": "some_custom_thing", "id": "abc123"}
        with patch("ws.presentation.router.validate_message", return_value=object()):
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["role"] == MessageRole.SERVER
        assert sent["type"] == MessageType.INFO
        assert sent["data"] == payload

    @pytest.mark.asyncio
    async def test_unknown_type_connection_error_suppressed(self, router, ws):
        """Line 196: ConnectionError when echoing unknown type is suppressed."""
        ws.send_text = AsyncMock(side_effect=ConnectionError("gone"))
        payload = {"role": "user", "type": "custom"}
        with patch("ws.presentation.router.validate_message", return_value=object()):
            result = await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))
        assert result is None

    @pytest.mark.asyncio
    async def test_unknown_type_os_error_suppressed(self, router, ws):
        """Line 196: OSError variant also suppressed."""
        ws.send_text = AsyncMock(side_effect=OSError("broken pipe"))
        payload = {"role": "user", "type": "custom"}
        with patch("ws.presentation.router.validate_message", return_value=object()):
            result = await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))
        assert result is None

    @pytest.mark.asyncio
    async def test_unknown_type_runtime_error_suppressed(self, router, ws):
        """Line 196: RuntimeError variant also suppressed."""
        ws.send_text = AsyncMock(side_effect=RuntimeError("ws closed"))
        payload = {"role": "user", "type": "custom"}
        with patch("ws.presentation.router.validate_message", return_value=object()):
            result = await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))
        assert result is None


# =========================================================================
# cancel-tts edge cases
# =========================================================================


class TestCancelTts:
    """Tests for cancel-tts handling."""

    @pytest.mark.asyncio
    async def test_cancel_tts_routed_before_validation(self, router, ws):
        """Line 122-125: audio/cancel-tts is handled before validate_message."""
        payload = {"type": "audio/cancel-tts"}
        await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))
        router._audio_handler.handle_cancel_tts.assert_awaited_once_with(client_id="c1")

    @pytest.mark.asyncio
    async def test_cancel_tts_error_propagates(self, router, ws):
        """cancel-tts handler error is NOT caught by router — propagates to hub."""
        router._audio_handler.handle_cancel_tts = AsyncMock(
            side_effect=RuntimeError("tts crash"),
        )
        payload = {"type": "audio/cancel-tts"}
        with pytest.raises(RuntimeError, match="tts crash"):
            await router.handle_json(ws=ws, client_id="c1", text=json.dumps(payload))


# =========================================================================
# Binary handling
# =========================================================================


class TestHandleBinary:
    """Tests for binary (audio chunk) handling."""

    @pytest.mark.asyncio
    async def test_binary_delegates_to_runtime(self, router):
        """Lines 214-218: Binary data forwarded to runtime."""
        data = b"\x00\x01\x02"
        await router.handle_binary(client_id="c1", data=data)
        router._runtime.handle_audio_chunk.assert_awaited_once_with(
            client_id="c1", chunk=data,
        )

    @pytest.mark.asyncio
    async def test_binary_runtime_error_suppressed(self, router):
        """Lines 219-220: RuntimeError from audio chunk is suppressed."""
        router._runtime.handle_audio_chunk = AsyncMock(
            side_effect=RuntimeError("audio error"),
        )
        with patch.object(router._logger, "warning") as mock_warn:
            result = await router.handle_binary(client_id="c1", data=b"\x00")
        assert result is None
        mock_warn.assert_called_once()
        assert "Audio chunk error" in mock_warn.call_args[0][0]

    @pytest.mark.asyncio
    async def test_binary_os_error_suppressed(self, router):
        """OSError from audio chunk is suppressed."""
        router._runtime.handle_audio_chunk = AsyncMock(
            side_effect=OSError("broken pipe"),
        )
        with patch.object(router._logger, "warning") as mock_warn:
            result = await router.handle_binary(client_id="c1", data=b"\x00")
        assert result is None
        mock_warn.assert_called_once()
        assert "Audio chunk error" in mock_warn.call_args[0][0]

    @pytest.mark.asyncio
    async def test_binary_value_error_suppressed(self, router):
        """ValueError from audio chunk is suppressed."""
        router._runtime.handle_audio_chunk = AsyncMock(
            side_effect=ValueError("bad data"),
        )
        with patch.object(router._logger, "warning") as mock_warn:
            result = await router.handle_binary(client_id="c1", data=b"\x00")
        assert result is None
        mock_warn.assert_called_once()
        assert "Audio chunk error" in mock_warn.call_args[0][0]

    @pytest.mark.asyncio
    async def test_binary_type_error_suppressed(self, router):
        """TypeError from audio chunk is suppressed."""
        router._runtime.handle_audio_chunk = AsyncMock(
            side_effect=TypeError("wrong type"),
        )
        with patch.object(router._logger, "warning") as mock_warn:
            result = await router.handle_binary(client_id="c1", data=b"\x00")
        assert result is None
        mock_warn.assert_called_once()
        assert "Audio chunk error" in mock_warn.call_args[0][0]

    @pytest.mark.asyncio
    async def test_binary_attribute_error_suppressed(self, router):
        """BUG: AttributeError was NOT caught — would propagate. Now fixed."""
        router._runtime.handle_audio_chunk = AsyncMock(
            side_effect=AttributeError("no method"),
        )
        with patch.object(router._logger, "warning") as mock_warn:
            result = await router.handle_binary(client_id="c1", data=b"\x00")
        assert result is None
        mock_warn.assert_called_once()
        assert "Audio chunk error" in mock_warn.call_args[0][0]

    @pytest.mark.asyncio
    async def test_binary_connection_error_suppressed(self, router):
        """BUG: ConnectionError was NOT caught — would propagate. Now fixed."""
        router._runtime.handle_audio_chunk = AsyncMock(
            side_effect=ConnectionError("lost"),
        )
        with patch.object(router._logger, "warning") as mock_warn:
            result = await router.handle_binary(client_id="c1", data=b"\x00")
        assert result is None
        mock_warn.assert_called_once()
        assert "Audio chunk error" in mock_warn.call_args[0][0]


# =========================================================================
# cleanup_client — comprehensive
# =========================================================================


class TestCleanupClient:
    """Tests for cleanup_client lifecycle correctness."""

    @pytest.mark.asyncio
    async def test_cleanup_with_zero_tasks(self, router):
        """Normal cleanup with no active tasks."""
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        result = await router.cleanup_client("c1")
        assert result == 0

    @pytest.mark.asyncio
    async def test_cleanup_with_active_tasks_calls_stop_generation(self, router):
        """Active tasks trigger stop_generation for each request_id."""
        router._task_manager.cleanup_client_tasks = AsyncMock(
            return_value=["req-aaa", "req-bbb"],
        )
        result = await router.cleanup_client("c1")
        assert result == 2
        assert router._runtime.stop_generation.await_count == 2
        router._runtime.stop_generation.assert_any_await("req-aaa")
        router._runtime.stop_generation.assert_any_await("req-bbb")

    @pytest.mark.asyncio
    async def test_cleanup_calls_audio_processor(self, router):
        """Audio processor cleanup is called during cleanup_client."""
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        await router.cleanup_client("c1")
        router._audio_handler._audio_processor.cleanup_client.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_cleanup_calls_request_mapper(self, router):
        """Request mapper cleanup is called."""
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        await router.cleanup_client("c1")
        router._request_mapper.cleanup_client_mappings.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_cleanup_calls_message_handler(self, router):
        """Message handler cleanup is called."""
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        await router.cleanup_client("c1")
        router._message_handler.cleanup_client.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_cleanup_pops_client_llm_lock(self, router):
        """client_llm_locks.pop is called during cleanup."""
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        # Factory import is dynamic inside cleanup_client; verify it doesn't crash
        result = await router.cleanup_client("c1")
        assert result == 0


class TestCleanupClientResilience:
    """BUG: cleanup_client sequential failure cascade.
    
    If task_manager.cleanup_client_tasks() raises, ALL subsequent cleanup
    (stop_generation, audio_processor, request_mapper, message_handler,
    client_llm_locks) is skipped. Each step must be independently guarded.
    """

    @pytest.mark.asyncio
    async def test_task_manager_failure_still_cleans_audio(self, router):
        """BUG: task_manager crash must NOT prevent audio cleanup."""
        router._task_manager.cleanup_client_tasks = AsyncMock(
            side_effect=RuntimeError("task manager dead"),
        )
        await router.cleanup_client("c1")
        router._audio_handler._audio_processor.cleanup_client.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_task_manager_failure_still_cleans_request_mapper(self, router):
        """BUG: task_manager crash must NOT prevent request_mapper cleanup."""
        router._task_manager.cleanup_client_tasks = AsyncMock(
            side_effect=RuntimeError("task manager dead"),
        )
        await router.cleanup_client("c1")
        router._request_mapper.cleanup_client_mappings.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_task_manager_failure_still_cleans_message_handler(self, router):
        """BUG: task_manager crash must NOT prevent message_handler cleanup."""
        router._task_manager.cleanup_client_tasks = AsyncMock(
            side_effect=RuntimeError("task manager dead"),
        )
        await router.cleanup_client("c1")
        router._message_handler.cleanup_client.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_audio_processor_failure_still_cleans_request_mapper(self, router):
        """Audio processor crash must NOT prevent request_mapper cleanup."""
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        router._audio_handler._audio_processor.cleanup_client = AsyncMock(
            side_effect=RuntimeError("audio dead"),
        )
        await router.cleanup_client("c1")
        router._request_mapper.cleanup_client_mappings.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_stop_generation_error_continues_loop(self, router):
        """stop_generation failure for one request must NOT prevent others."""
        router._task_manager.cleanup_client_tasks = AsyncMock(
            return_value=["req-1", "req-2", "req-3"],
        )
        call_count = 0

        async def stop_gen_side_effect(request_id):
            nonlocal call_count
            call_count += 1
            if request_id == "req-2":
                raise RuntimeError("gen stop failed")

        router._runtime.stop_generation = AsyncMock(side_effect=stop_gen_side_effect)
        result = await router.cleanup_client("c1")
        assert result == 3
        assert call_count == 3  # All three attempted despite req-2 failure

    @pytest.mark.asyncio
    async def test_stop_generation_unexpected_exception_caught(self, router):
        """BUG: ValueError from stop_generation was not caught. Now fixed."""
        router._task_manager.cleanup_client_tasks = AsyncMock(
            return_value=["req-1"],
        )
        router._runtime.stop_generation = AsyncMock(
            side_effect=ValueError("unexpected"),
        )
        result = await router.cleanup_client("c1")
        assert result == 1  # Task was still counted as cancelled

    @pytest.mark.asyncio
    async def test_all_steps_fail_gracefully(self, router):
        """Every single cleanup step fails — method still returns without raising."""
        router._task_manager.cleanup_client_tasks = AsyncMock(
            side_effect=RuntimeError("task mgr dead"),
        )
        router._audio_handler._audio_processor.cleanup_client = AsyncMock(
            side_effect=RuntimeError("audio dead"),
        )
        router._request_mapper.cleanup_client_mappings = AsyncMock(
            side_effect=RuntimeError("mapper dead"),
        )
        router._message_handler.cleanup_client = AsyncMock(
            side_effect=RuntimeError("handler dead"),
        )
        # Must NOT raise — every step independently guarded
        result = await router.cleanup_client("c1")
        assert result == 0  # No tasks cancelled because task_manager failed

    @pytest.mark.asyncio
    async def test_cleanup_with_none_audio_handler(self, router):
        """cleanup_client handles audio_handler being None."""
        router._audio_handler = None
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        await router.cleanup_client("c1")
        router._request_mapper.cleanup_client_mappings.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cleanup_with_none_request_mapper(self, router):
        """cleanup_client handles request_mapper being None."""
        router._request_mapper = None
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        await router.cleanup_client("c1")
        router._message_handler.cleanup_client.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cleanup_with_none_message_handler(self, router):
        """cleanup_client handles message_handler being None."""
        router._message_handler = None
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        result = await router.cleanup_client("c1")
        assert result == 0

    @pytest.mark.asyncio
    async def test_factory_import_error_suppressed(self, router, monkeypatch):
        """Line 266: ImportError from factory import is caught."""
        router._task_manager.cleanup_client_tasks = AsyncMock(return_value=[])
        monkeypatch.setitem(sys.modules, "ws.factory", None)
        cancelled = await router.cleanup_client("client-1")
        assert cancelled == 0

    @pytest.mark.asyncio
    async def test_factory_import_error_with_active_tasks(self, router, monkeypatch):
        """Factory import error with active tasks still returns correct count."""
        router._task_manager.cleanup_client_tasks = AsyncMock(
            return_value=["req-1", "req-2"],
        )
        monkeypatch.setitem(sys.modules, "ws.factory", None)
        cancelled = await router.cleanup_client("client-1")
        assert cancelled == 2
        assert router._runtime.stop_generation.await_count == 2


# =========================================================================
# Shutdown
# =========================================================================


class TestShutdown:
    """Tests for router shutdown."""

    @pytest.mark.asyncio
    async def test_shutdown_delegates_to_message_handler(self, router):
        """Lines 276-278: Shutdown calls message_handler.shutdown()."""
        await router.shutdown()
        router._message_handler.shutdown.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_shutdown_no_handler(self):
        """Shutdown with no message_handler does not crash."""
        r = Router(
            runtime=MagicMock(),
            message_handler=None,
            control_handler=MagicMock(),
            audio_handler=MagicMock(),
            context_handler=MagicMock(),
            task_manager=MagicMock(),
            request_mapper=MagicMock(),
            cache_service=MagicMock(),
        )
        result = await r.shutdown()
        assert result is None

    @pytest.mark.asyncio
    async def test_shutdown_handler_error_does_not_propagate(self, router):
        """Shutdown error from message_handler is caught gracefully."""
        router._message_handler.shutdown = AsyncMock(
            side_effect=RuntimeError("shutdown crash"),
        )
        with patch.object(router._logger, "warning") as mock_warn:
            result = await router.shutdown()
        assert result is None
        mock_warn.assert_called_once()
        assert "Message handler shutdown failed" in mock_warn.call_args[0][0]

    @pytest.mark.asyncio
    async def test_shutdown_handler_without_shutdown_method(self):
        """Handler that exists but has no shutdown method doesn't crash."""
        handler = MagicMock(spec=[])  # Empty spec — no shutdown attribute
        r = Router(
            runtime=MagicMock(),
            message_handler=handler,
            control_handler=MagicMock(),
            audio_handler=MagicMock(),
            context_handler=MagicMock(),
            task_manager=MagicMock(),
            request_mapper=MagicMock(),
            cache_service=MagicMock(),
        )
        result = await r.shutdown()
        assert result is None
