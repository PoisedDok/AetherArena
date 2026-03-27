"""
Unit tests for ws.presentation.handlers.control_handler

Tests ControlHandler:
- handle_stop: full stop flow (resolve, cancel, notify runtime, forget mapping, ack)
- handle_heartbeat: presence update + pong response

Mocks: runtime, task_manager, request_mapper, cache_service, WebSocket, message.

Bugs found: 0
"""

import json
from unittest.mock import AsyncMock, MagicMock

from ws.presentation.handlers.control_handler import ControlHandler


def _make_handler(**overrides):
    """Create ControlHandler with mock dependencies."""
    runtime = overrides.get("runtime", AsyncMock())
    task_manager = overrides.get("task_manager", AsyncMock())
    request_mapper = overrides.get("request_mapper", AsyncMock())
    cache_service = overrides.get("cache_service", AsyncMock())

    handler = ControlHandler(
        runtime=runtime,
        task_manager=task_manager,
        request_mapper=request_mapper,
        cache_service=cache_service,
    )
    return handler, runtime, task_manager, request_mapper, cache_service


def _mock_ws(send_side_effect=None):
    """Create mock WebSocket."""
    ws = AsyncMock()
    if send_side_effect:
        ws.send_text.side_effect = send_side_effect
    return ws


def _stop_message(stop_id="stop-001"):
    """Create mock stop message."""
    msg = MagicMock()
    msg.id = stop_id
    return msg


def _heartbeat_message(timestamp="2026-02-09T12:00:00Z"):
    """Create mock heartbeat message."""
    msg = MagicMock()
    msg.timestamp = timestamp
    return msg


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------

class TestConstruction:
    """Tests for ControlHandler construction."""

    def test_stores_dependencies(self):
        """All dependencies stored."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()
        assert handler._runtime is runtime
        assert handler._task_manager is task_mgr
        assert handler._request_mapper is mapper
        assert handler._cache is cache


# ---------------------------------------------------------------------------
# handle_stop — full flow
# ---------------------------------------------------------------------------

class TestHandleStop:
    """Tests for handle_stop."""

    async def test_full_stop_flow_with_active_task(self):
        """Active task: resolve → cancel → runtime stop → forget. No ack (stream emits stop)."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()
    
        mapper.resolve_backend_id = AsyncMock(return_value="backend-001")
        cache.get_session_state = AsyncMock(return_value={"chat_id": "chat-001"})
        task_mgr.cancel_task = AsyncMock(return_value={
            "correlation_id": "cor-001",
            "frontend_id": "fe-001",
        })
    
        ws = _mock_ws()
        msg = _stop_message("stop-001")
    
        await handler.handle_stop(ws=ws, client_id="client-A", message=msg)
    
        # 1. Resolve
        mapper.resolve_backend_id.assert_awaited_once_with("client-A", "stop-001")
        # 2. Presence update
        cache.update_presence_metadata.assert_awaited_once_with(
            "client-A", status="stopping", last_event="stop",
        )
        # 3. Cancel task
        task_mgr.cancel_task.assert_awaited_once_with("backend-001")
        # 4. Runtime stop
        runtime.stop_generation.assert_awaited_once_with("backend-001", chat_id="chat-001")
        # 5. Forget mapping
        mapper.forget_mapping.assert_awaited_once_with(
            client_id="client-A",
            frontend_id="fe-001",
            correlation_id="cor-001",
            backend_id="backend-001",
        )
        # 6. NO ack (task_info was not None)
        ws.send_text.assert_not_awaited()

    async def test_no_active_task_sends_ack(self):
        """No active task: sends stop acknowledgment via WebSocket."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        mapper.resolve_backend_id = AsyncMock(return_value="backend-001")
        task_mgr.cancel_task = AsyncMock(return_value=None)

        ws = _mock_ws()
        msg = _stop_message("stop-001")

        await handler.handle_stop(ws=ws, client_id="client-A", message=msg)

        # Ack sent
        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["role"] == "server"
        assert sent["type"] == "stopped"
        assert sent["request_id"] == "backend-001"
        assert "Generation stopped" in sent["message"]

    async def test_ack_no_optional_fields_when_task_info_none(self):
        """When task_info is None, frontend_id and correlation_id are both None.
        Ack should NOT include frontend_id or correlation_id fields.
        """
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        mapper.resolve_backend_id = AsyncMock(return_value="backend-001")
        task_mgr.cancel_task = AsyncMock(return_value=None)

        ws = _mock_ws()
        await handler.handle_stop(ws=ws, client_id="client-A", message=_stop_message())

        sent = json.loads(ws.send_text.call_args[0][0])
        assert "frontend_id" not in sent
        assert "correlation_id" not in sent

    async def test_no_stop_id_returns_early(self):
        """Stop message with no ID returns early, nothing called."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        ws = _mock_ws()
        msg = MagicMock()
        msg.id = None

        await handler.handle_stop(ws=ws, client_id="client-A", message=msg)

        mapper.resolve_backend_id.assert_not_awaited()
        task_mgr.cancel_task.assert_not_awaited()

    async def test_empty_stop_id_returns_early(self):
        """Stop message with empty string ID returns early."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        ws = _mock_ws()
        msg = MagicMock()
        msg.id = ""

        await handler.handle_stop(ws=ws, client_id="client-A", message=msg)

        mapper.resolve_backend_id.assert_not_awaited()

    async def test_runtime_stop_error_caught(self):
        """RuntimeError from runtime.stop_generation is caught."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        mapper.resolve_backend_id = AsyncMock(return_value="backend-001")
        task_mgr.cancel_task = AsyncMock(return_value={"correlation_id": None, "frontend_id": None})
        runtime.stop_generation = AsyncMock(side_effect=RuntimeError("engine down"))

        ws = _mock_ws()
        await handler.handle_stop(ws=ws, client_id="client-A", message=_stop_message())

        # Continues past the error
        mapper.forget_mapping.assert_awaited_once()

    async def test_runtime_connection_error_caught(self):
        """ConnectionError from runtime is caught."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        mapper.resolve_backend_id = AsyncMock(return_value="backend-001")
        task_mgr.cancel_task = AsyncMock(return_value={"correlation_id": None, "frontend_id": None})
        runtime.stop_generation = AsyncMock(side_effect=ConnectionError("conn reset"))

        ws = _mock_ws()
        await handler.handle_stop(ws=ws, client_id="client-A", message=_stop_message())

        mapper.forget_mapping.assert_awaited_once()

    async def test_runtime_attribute_error_caught(self):
        """AttributeError from runtime.stop_generation is caught (source line 103)."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        mapper.resolve_backend_id = AsyncMock(return_value="backend-001")
        task_mgr.cancel_task = AsyncMock(return_value={"correlation_id": None, "frontend_id": None})
        runtime.stop_generation = AsyncMock(side_effect=AttributeError("no attr"))

        ws = _mock_ws()
        await handler.handle_stop(ws=ws, client_id="client-A", message=_stop_message())

        # Continues past the error — forget_mapping still called
        mapper.forget_mapping.assert_awaited_once()

    async def test_runtime_os_error_caught(self):
        """OSError from runtime.stop_generation is caught (source line 103)."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        mapper.resolve_backend_id = AsyncMock(return_value="backend-001")
        task_mgr.cancel_task = AsyncMock(return_value={"correlation_id": None, "frontend_id": None})
        runtime.stop_generation = AsyncMock(side_effect=OSError("broken pipe"))

        ws = _mock_ws()
        await handler.handle_stop(ws=ws, client_id="client-A", message=_stop_message())

        mapper.forget_mapping.assert_awaited_once()

    async def test_ack_ws_error_caught(self):
        """WebSocket error during ack is caught."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        mapper.resolve_backend_id = AsyncMock(return_value="backend-001")
        task_mgr.cancel_task = AsyncMock(return_value=None)

        ws = _mock_ws(send_side_effect=RuntimeError("ws closed"))
        await handler.handle_stop(ws=ws, client_id="client-A", message=_stop_message())

        # Should not raise — error caught

    async def test_forget_mapping_called_with_task_ids(self):
        """forget_mapping uses correlation_id and frontend_id from task_info."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        mapper.resolve_backend_id = AsyncMock(return_value="backend-002")
        task_mgr.cancel_task = AsyncMock(return_value={
            "correlation_id": "cor-X",
            "frontend_id": "fe-Y",
        })

        ws = _mock_ws()
        await handler.handle_stop(ws=ws, client_id="client-B", message=_stop_message("sid"))

        mapper.forget_mapping.assert_awaited_once_with(
            client_id="client-B",
            frontend_id="fe-Y",
            correlation_id="cor-X",
            backend_id="backend-002",
        )


# ---------------------------------------------------------------------------
# handle_heartbeat
# ---------------------------------------------------------------------------

class TestHandleHeartbeat:
    """Tests for handle_heartbeat."""

    async def test_sends_pong(self):
        """Sends pong response with timestamp."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        ws = _mock_ws()
        msg = _heartbeat_message("2026-02-09T12:00:00Z")

        await handler.handle_heartbeat(ws=ws, client_id="client-A", message=msg)

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["type"] == "pong"
        assert sent["timestamp"] == "2026-02-09T12:00:00Z"

    async def test_updates_presence(self):
        """Presence metadata updated with heartbeat event."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        ws = _mock_ws()
        msg = _heartbeat_message()

        await handler.handle_heartbeat(ws=ws, client_id="client-A", message=msg)

        cache.update_presence_metadata.assert_awaited_once_with(
            "client-A", last_event="heartbeat",
        )

    async def test_runtime_error_caught(self):
        """RuntimeError during pong is caught."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        msg = _heartbeat_message()

        await handler.handle_heartbeat(ws=ws, client_id="client-A", message=msg)

    async def test_os_error_caught(self):
        """OSError during pong is caught."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        ws = _mock_ws(send_side_effect=OSError("broken pipe"))
        msg = _heartbeat_message()

        await handler.handle_heartbeat(ws=ws, client_id="client-A", message=msg)

    async def test_connection_error_caught(self):
        """ConnectionError during pong is caught."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()

        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        msg = _heartbeat_message()

        await handler.handle_heartbeat(ws=ws, client_id="client-A", message=msg)

    async def test_presence_error_propagates_to_outer_catch(self):
        """If cache update raises RuntimeError, the outer try-except catches it."""
        handler, runtime, task_mgr, mapper, cache = _make_handler()
        cache.update_presence_metadata = AsyncMock(side_effect=RuntimeError("cache down"))

        ws = _mock_ws()
        msg = _heartbeat_message()

        # Should not raise (caught by except block)
        await handler.handle_heartbeat(ws=ws, client_id="client-A", message=msg)

        # Pong was NOT sent (error happened before)
        ws.send_text.assert_not_awaited()
