"""
Unit tests for ws.presentation.emitters.stream_emitter

Tests StreamEmitter:
- emit_event: generic event emission with timeout protection
- emit_end: end marker emission
- emit_completion: completion signal emission
- emit_stop: user cancellation notification
- emit_error: error notification

Each method tests: success, timeout, RuntimeError, OSError, ConnectionError.
Adversarial tests: WebSocketDisconnect, TypeError (unserializable payload).

Bugs found: 1
- Bug G (MEDIUM): All 5 methods had narrow except (RuntimeError, OSError, ConnectionError),
  missing WebSocketDisconnect and TypeError. Fixed: broadened to except Exception.
"""

import asyncio
import json
from unittest.mock import AsyncMock, patch

from ws.presentation.emitters.stream_emitter import StreamEmitter


def _mock_ws(send_side_effect=None):
    """Create mock WebSocket with configurable send_text behavior."""
    ws = AsyncMock()
    if send_side_effect:
        ws.send_text.side_effect = send_side_effect
    return ws


def _assert_debug_error_log(mock_debug, expected_fmt, error_msg):
    """Assert debug error was logged with format string and error message."""
    mock_debug.assert_called_once()
    args = mock_debug.call_args[0]
    assert args[0] == expected_fmt
    assert str(args[1]) == error_msg


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------

class TestConstruction:
    """Tests for StreamEmitter construction."""

    def test_default_timeout(self):
        """Default timeout comes from WS_SEND_TIMEOUT."""
        from ws.protocols import WS_SEND_TIMEOUT
        emitter = StreamEmitter()
        assert emitter._timeout == WS_SEND_TIMEOUT

    def test_custom_timeout(self):
        """Custom timeout is stored."""
        emitter = StreamEmitter(timeout=5.0)
        assert emitter._timeout == 5.0


# ---------------------------------------------------------------------------
# emit_event
# ---------------------------------------------------------------------------

class TestEmitEvent:
    """Tests for emit_event."""

    async def test_sends_json(self):
        """Sends JSON-serialized event."""
        emitter = StreamEmitter(timeout=5.0)
        ws = _mock_ws()
        event = {"role": "assistant", "type": "message", "content": "Hello"}

        await emitter.emit_event(ws, event)

        ws.send_text.assert_awaited_once()
        sent_data = ws.send_text.call_args[0][0]
        assert json.loads(sent_data) == event

    async def test_timeout_handled(self):
        """TimeoutError is caught and warning logged."""
        emitter = StreamEmitter(timeout=0.001)

        async def slow_send(_text):
            await asyncio.sleep(10)

        ws = _mock_ws()
        ws.send_text.side_effect = slow_send

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_event(ws, {"type": "message"})
            mock_warn.assert_called_once_with("Timeout emitting stream event")

    async def test_runtime_error_handled(self):
        """RuntimeError is caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("ws closed"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_event(ws, {"type": "message"})
            _assert_debug_error_log(mock_debug, "Failed to emit stream event: %s", "ws closed")

    async def test_os_error_handled(self):
        """OSError is caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=OSError("broken pipe"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_event(ws, {"type": "message"})
            _assert_debug_error_log(mock_debug, "Failed to emit stream event: %s", "broken pipe")

    async def test_connection_error_handled(self):
        """ConnectionError is caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_event(ws, {"type": "message"})
            _assert_debug_error_log(mock_debug, "Failed to emit stream event: %s", "reset")


# ---------------------------------------------------------------------------
# emit_end
# ---------------------------------------------------------------------------

class TestEmitEnd:
    """Tests for emit_end."""

    async def test_sends_end_marker(self):
        """Sends JSON-serialized end message."""
        emitter = StreamEmitter()
        ws = _mock_ws()
        end_msg = {"role": "assistant", "type": "message", "end": True}

        await emitter.emit_end(ws, end_msg)

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent == end_msg

    async def test_runtime_error_handled(self):
        """RuntimeError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_end(ws, {"end": True})
            _assert_debug_error_log(mock_debug, "Failed to emit end marker: %s", "closed")

    async def test_os_error_handled(self):
        """OSError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=OSError("pipe"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_end(ws, {"end": True})
            _assert_debug_error_log(mock_debug, "Failed to emit end marker: %s", "pipe")

    async def test_connection_error_handled(self):
        """ConnectionError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_end(ws, {"end": True})
            _assert_debug_error_log(mock_debug, "Failed to emit end marker: %s", "reset")


# ---------------------------------------------------------------------------
# emit_completion
# ---------------------------------------------------------------------------

class TestEmitCompletion:
    """Tests for emit_completion."""

    async def test_sends_completion(self):
        """Sends JSON-serialized completion message."""
        emitter = StreamEmitter()
        ws = _mock_ws()
        comp = {"role": "assistant", "type": "completion", "request_id": "req-001"}

        await emitter.emit_completion(ws, comp)

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent == comp

    async def test_runtime_error_handled(self):
        """RuntimeError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_completion(ws, {"type": "completion"})
            _assert_debug_error_log(mock_debug, "Failed to emit completion: %s", "closed")

    async def test_os_error_handled(self):
        """OSError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=OSError("pipe"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_completion(ws, {"type": "completion"})
            _assert_debug_error_log(mock_debug, "Failed to emit completion: %s", "pipe")

    async def test_connection_error_handled(self):
        """ConnectionError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_completion(ws, {"type": "completion"})
            _assert_debug_error_log(mock_debug, "Failed to emit completion: %s", "reset")


# ---------------------------------------------------------------------------
# emit_stop
# ---------------------------------------------------------------------------

class TestEmitStop:
    """Tests for emit_stop."""

    async def test_sends_stop_notification(self):
        """Sends stop notification with server role and stopped type."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_stop(ws, "req-001")

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["role"] == "server"
        assert sent["type"] == "stopped"
        assert sent["request_id"] == "req-001"
        assert sent["message"] == "Generation stopped by user request"

    async def test_includes_correlation_id(self):
        """correlation_id included when provided."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_stop(ws, "req-001", correlation_id="cor-001")

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["correlation_id"] == "cor-001"

    async def test_includes_chat_id(self):
        """chat_id included when provided."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_stop(ws, "req-001", chat_id="chat-001")

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["chat_id"] == "chat-001"

    async def test_no_correlation_id_when_none(self):
        """No correlation_id field when None."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_stop(ws, "req-001", correlation_id=None)

        sent = json.loads(ws.send_text.call_args[0][0])
        assert "correlation_id" not in sent

    async def test_no_chat_id_when_none(self):
        """No chat_id field when None."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_stop(ws, "req-001", chat_id=None)

        sent = json.loads(ws.send_text.call_args[0][0])
        assert "chat_id" not in sent

    async def test_runtime_error_handled(self):
        """RuntimeError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_stop(ws, "req-001")
            _assert_debug_error_log(mock_debug, "Failed to emit stop notification: %s", "closed")

    async def test_connection_error_handled(self):
        """ConnectionError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_stop(ws, "req-001")
            _assert_debug_error_log(mock_debug, "Failed to emit stop notification: %s", "reset")


# ---------------------------------------------------------------------------
# emit_error
# ---------------------------------------------------------------------------

class TestEmitError:
    """Tests for emit_error."""

    async def test_sends_error_notification(self):
        """Sends error notification with assistant role and message type."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_error(ws, "req-001")

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["role"] == "assistant"
        assert sent["type"] == "message"
        assert sent["request_id"] == "req-001"
        assert "unavailable" in sent["content"].lower() or "offline" in sent["content"].lower()

    async def test_includes_correlation_id(self):
        """correlation_id included when provided."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_error(ws, "req-001", correlation_id="cor-001")

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["correlation_id"] == "cor-001"

    async def test_includes_chat_id(self):
        """chat_id included when provided."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_error(ws, "req-001", chat_id="chat-001")

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["chat_id"] == "chat-001"

    async def test_no_correlation_id_when_none(self):
        """No correlation_id when None."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_error(ws, "req-001")

        sent = json.loads(ws.send_text.call_args[0][0])
        assert "correlation_id" not in sent

    async def test_no_chat_id_when_none(self):
        """No chat_id when None."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        await emitter.emit_error(ws, "req-001")

        sent = json.loads(ws.send_text.call_args[0][0])
        assert "chat_id" not in sent

    async def test_runtime_error_handled(self):
        """RuntimeError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_error(ws, "req-001")
            _assert_debug_error_log(mock_debug, "Failed to emit error notification: %s", "closed")

    async def test_os_error_handled(self):
        """OSError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=OSError("pipe"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_error(ws, "req-001")
            _assert_debug_error_log(mock_debug, "Failed to emit error notification: %s", "pipe")

    async def test_connection_error_handled(self):
        """ConnectionError caught and debug logged."""
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_error(ws, "req-001")
            _assert_debug_error_log(mock_debug, "Failed to emit error notification: %s", "reset")


# ---------------------------------------------------------------------------
# Adversarial: Broad exception handling (Bug G fix verification)
# ---------------------------------------------------------------------------

class TestBroadExceptionHandling:
    """BUG FIX: All 5 emit methods had narrow except (RuntimeError, OSError, ConnectionError).
    WebSocketDisconnect and TypeError were NOT caught. Fixed: broadened to except Exception.
    """

    async def test_emit_event_websocket_disconnect(self):
        """WebSocketDisconnect is caught and debug logged."""
        from starlette.websockets import WebSocketDisconnect
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=WebSocketDisconnect())
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_event(ws, {"type": "message"})
            mock_debug.assert_called_once()
            assert mock_debug.call_args[0][0] == "Failed to emit stream event: %s"

    async def test_emit_event_type_error_unserializable(self):
        """TypeError from json.dumps is caught and debug logged; send_text never called."""
        emitter = StreamEmitter()
        ws = _mock_ws()

        class BadObj:
            pass

        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_event(ws, {"data": BadObj()})
            mock_debug.assert_called_once()
            args = mock_debug.call_args[0]
            assert args[0] == "Failed to emit stream event: %s"
            assert "not JSON serializable" in str(args[1])
        ws.send_text.assert_not_awaited()

    async def test_emit_end_websocket_disconnect(self):
        """WebSocketDisconnect on emit_end is caught and debug logged."""
        from starlette.websockets import WebSocketDisconnect
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=WebSocketDisconnect())
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_end(ws, {"end": True})
            mock_debug.assert_called_once()
            assert mock_debug.call_args[0][0] == "Failed to emit end marker: %s"

    async def test_emit_completion_websocket_disconnect(self):
        """WebSocketDisconnect on emit_completion is caught and debug logged."""
        from starlette.websockets import WebSocketDisconnect
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=WebSocketDisconnect())
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_completion(ws, {"type": "completion"})
            mock_debug.assert_called_once()
            assert mock_debug.call_args[0][0] == "Failed to emit completion: %s"

    async def test_emit_stop_websocket_disconnect(self):
        """WebSocketDisconnect on emit_stop is caught and debug logged."""
        from starlette.websockets import WebSocketDisconnect
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=WebSocketDisconnect())
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_stop(ws, "req-001")
            mock_debug.assert_called_once()
            assert mock_debug.call_args[0][0] == "Failed to emit stop notification: %s"

    async def test_emit_error_websocket_disconnect(self):
        """WebSocketDisconnect on emit_error is caught and debug logged."""
        from starlette.websockets import WebSocketDisconnect
        emitter = StreamEmitter()
        ws = _mock_ws(send_side_effect=WebSocketDisconnect())
        with patch.object(emitter._logger, "debug") as mock_debug:
            await emitter.emit_error(ws, "req-001")
            mock_debug.assert_called_once()
            assert mock_debug.call_args[0][0] == "Failed to emit error notification: %s"
