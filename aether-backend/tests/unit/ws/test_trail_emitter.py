"""
Unit tests for ws.presentation.emitters.trail_emitter

Tests TrailEmitter:
- emit_group_created: group creation event
- emit_subgroup_created: subgroup creation with nodes array
- emit_node_status_updated: node status change event
- emit_artifact_linked: artifact linkage event
- emit_subgroup_completed: subgroup completion event
- emit_agent_message_sequence: timeline sequence event
- emit_assistant_message_flushed: assistant message flush event
- _send_event: shared helper (timeout, error handling, serialization)

Each method tests: correct payload structure, optional field handling,
timeout, RuntimeError, OSError, ConnectionError.

Bugs found: 0
"""

import asyncio
import json
from unittest.mock import AsyncMock, patch

from ws.presentation.emitters.trail_emitter import TrailEmitter


def _mock_ws(send_side_effect=None):
    """Create mock WebSocket with configurable send_text behavior."""
    ws = AsyncMock()
    if send_side_effect:
        ws.send_text.side_effect = send_side_effect
    return ws


def _assert_timeout_warning(mock_warn, event_name):
    """Assert timeout warning was logged for the given event name."""
    mock_warn.assert_called_once_with("Timeout emitting %s event", event_name)


def _assert_error_warning(mock_warn, event_name, error_msg):
    """Assert error warning was logged for the given event name and message."""
    mock_warn.assert_called_once()
    args = mock_warn.call_args[0]
    assert args[0] == "Failed to emit %s event: %s"
    assert args[1] == event_name
    assert str(args[2]) == error_msg


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------

class TestConstruction:
    """Tests for TrailEmitter construction."""

    def test_default_timeout(self):
        """Default timeout comes from WS_SEND_TIMEOUT."""
        from ws.protocols import WS_SEND_TIMEOUT
        emitter = TrailEmitter()
        assert emitter._timeout == WS_SEND_TIMEOUT

    def test_custom_timeout(self):
        """Custom timeout is stored."""
        emitter = TrailEmitter(timeout=7.5)
        assert emitter._timeout == 7.5

    def test_logger_assigned(self):
        """Logger is assigned from module-level logger."""
        emitter = TrailEmitter()
        assert emitter._logger is not None
        assert emitter._logger.name == "ws.presentation.emitters.trail_emitter"


# ---------------------------------------------------------------------------
# emit_group_created
# ---------------------------------------------------------------------------

class TestEmitGroupCreated:
    """Tests for emit_group_created."""

    async def test_sends_correct_event(self):
        """Sends JSON with all expected fields."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_group_created(
            ws=ws,
            group_id="grp-001",
            chat_id="chat-001",
            sequence_number=1,
            backend_id="be-001",
            frontend_id="fe-001",
            correlation_id="cor-001",
        )

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent == {
            "role": "server",
            "type": "trail.group_created",
            "group_id": "grp-001",
            "chat_id": "chat-001",
            "sequence_number": 1,
            "backend_id": "be-001",
            "frontend_id": "fe-001",
            "correlation_id": "cor-001",
        }

    async def test_optional_fields_null_when_none(self):
        """frontend_id and correlation_id are serialized as null when None."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_group_created(
            ws=ws,
            group_id="grp-002",
            chat_id="chat-002",
            sequence_number=2,
            backend_id="be-002",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["frontend_id"] is None
        assert sent["correlation_id"] is None
        # Keys are present (not omitted)
        assert "frontend_id" in sent
        assert "correlation_id" in sent

    async def test_role_is_server(self):
        """Role must be 'server'."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_group_created(
            ws=ws, group_id="g", chat_id="c",
            sequence_number=0, backend_id="b",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["role"] == "server"

    async def test_type_is_trail_group_created(self):
        """Type must be 'trail.group_created'."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_group_created(
            ws=ws, group_id="g", chat_id="c",
            sequence_number=0, backend_id="b",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["type"] == "trail.group_created"

    async def test_timeout_handled(self):
        """TimeoutError is caught and warning logged with event name."""
        emitter = TrailEmitter(timeout=0.001)

        async def slow_send(_text):
            await asyncio.sleep(10)

        ws = _mock_ws()
        ws.send_text.side_effect = slow_send

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_group_created(
                ws=ws, group_id="g", chat_id="c",
                sequence_number=0, backend_id="b",
            )
            _assert_timeout_warning(mock_warn, "group_created")

    async def test_runtime_error_handled(self):
        """RuntimeError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("ws closed"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_group_created(
                ws=ws, group_id="g", chat_id="c",
                sequence_number=0, backend_id="b",
            )
            _assert_error_warning(mock_warn, "group_created", "ws closed")

    async def test_os_error_handled(self):
        """OSError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=OSError("broken pipe"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_group_created(
                ws=ws, group_id="g", chat_id="c",
                sequence_number=0, backend_id="b",
            )
            _assert_error_warning(mock_warn, "group_created", "broken pipe")

    async def test_connection_error_handled(self):
        """ConnectionError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_group_created(
                ws=ws, group_id="g", chat_id="c",
                sequence_number=0, backend_id="b",
            )
            _assert_error_warning(mock_warn, "group_created", "reset")


# ---------------------------------------------------------------------------
# emit_subgroup_created
# ---------------------------------------------------------------------------

class TestEmitSubgroupCreated:
    """Tests for emit_subgroup_created."""

    async def test_sends_correct_top_level_fields(self):
        """Sends all expected top-level fields."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_subgroup_created(
            ws=ws,
            chat_id="chat-001",
            subgroup_id="sg-001",
            group_id="grp-001",
            execution_group="exec-001",
            writing_node_id="wn-001",
            executing_node_id="en-001",
            output_node_id="on-001",
            backend_id="be-001",
            subgroup_sequence_number=3,
            sequence_in_chat=10,
            frontend_id="fe-001",
        )

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["role"] == "server"
        assert sent["type"] == "trail.subgroup_created"
        assert sent["chat_id"] == "chat-001"
        assert sent["subgroup_id"] == "sg-001"
        assert sent["group_id"] == "grp-001"
        assert sent["execution_group"] == "exec-001"
        assert sent["backend_id"] == "be-001"
        assert sent["frontend_id"] == "fe-001"
        assert sent["sequence_in_chat"] == 10

    async def test_sequence_number_alias(self):
        """sequence_number and subgroup_sequence both equal the input value."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_subgroup_created(
            ws=ws, chat_id="c", subgroup_id="sg", group_id="g",
            execution_group="eg", writing_node_id="w", executing_node_id="e",
            output_node_id="o", backend_id="b",
            subgroup_sequence_number=7, sequence_in_chat=20,
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["sequence_number"] == 7
        assert sent["subgroup_sequence"] == 7
        assert sent["sequence_number"] == sent["subgroup_sequence"]

    async def test_nodes_structure(self):
        """Nodes array contains 3 nodes with correct structure."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_subgroup_created(
            ws=ws, chat_id="c", subgroup_id="sg", group_id="g",
            execution_group="eg", writing_node_id="wn-100",
            executing_node_id="en-200", output_node_id="on-300",
            backend_id="b", subgroup_sequence_number=1, sequence_in_chat=1,
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        nodes = sent["nodes"]
        assert len(nodes) == 3

        # Node 1: writing
        assert nodes[0] == {
            "node_id": "wn-100",
            "type": "writing",
            "sequence": 1,
            "clickable": True,
            "status": "pending",
        }

        # Node 2: executing
        assert nodes[1] == {
            "node_id": "en-200",
            "type": "executing",
            "sequence": 2,
            "clickable": False,
            "status": "pending",
        }

        # Node 3: output
        assert nodes[2] == {
            "node_id": "on-300",
            "type": "output",
            "sequence": 3,
            "clickable": True,
            "status": "pending",
        }

    async def test_frontend_id_null_when_none(self):
        """frontend_id is serialized as null when None."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_subgroup_created(
            ws=ws, chat_id="c", subgroup_id="sg", group_id="g",
            execution_group="eg", writing_node_id="w", executing_node_id="e",
            output_node_id="o", backend_id="b",
            subgroup_sequence_number=1, sequence_in_chat=1,
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert "frontend_id" in sent
        assert sent["frontend_id"] is None

    async def test_timeout_handled(self):
        """TimeoutError is caught and warning logged with event name."""
        emitter = TrailEmitter(timeout=0.001)

        async def slow_send(_text):
            await asyncio.sleep(10)

        ws = _mock_ws()
        ws.send_text.side_effect = slow_send

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_subgroup_created(
                ws=ws, chat_id="c", subgroup_id="sg", group_id="g",
                execution_group="eg", writing_node_id="w", executing_node_id="e",
                output_node_id="o", backend_id="b",
                subgroup_sequence_number=1, sequence_in_chat=1,
            )
            _assert_timeout_warning(mock_warn, "subgroup_created")

    async def test_runtime_error_handled(self):
        """RuntimeError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_subgroup_created(
                ws=ws, chat_id="c", subgroup_id="sg", group_id="g",
                execution_group="eg", writing_node_id="w", executing_node_id="e",
                output_node_id="o", backend_id="b",
                subgroup_sequence_number=1, sequence_in_chat=1,
            )
            _assert_error_warning(mock_warn, "subgroup_created", "closed")

    async def test_os_error_handled(self):
        """OSError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=OSError("broken pipe"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_subgroup_created(
                ws=ws, chat_id="c", subgroup_id="sg", group_id="g",
                execution_group="eg", writing_node_id="w", executing_node_id="e",
                output_node_id="o", backend_id="b",
                subgroup_sequence_number=1, sequence_in_chat=1,
            )
            _assert_error_warning(mock_warn, "subgroup_created", "broken pipe")

    async def test_connection_error_handled(self):
        """ConnectionError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_subgroup_created(
                ws=ws, chat_id="c", subgroup_id="sg", group_id="g",
                execution_group="eg", writing_node_id="w", executing_node_id="e",
                output_node_id="o", backend_id="b",
                subgroup_sequence_number=1, sequence_in_chat=1,
            )
            _assert_error_warning(mock_warn, "subgroup_created", "reset")


# ---------------------------------------------------------------------------
# emit_node_status_updated
# ---------------------------------------------------------------------------

class TestEmitNodeStatusUpdated:
    """Tests for emit_node_status_updated."""

    async def test_sends_correct_event(self):
        """Sends all expected fields."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_node_status_updated(
            ws=ws,
            chat_id="chat-001",
            group_id="grp-001",
            node_id="node-001",
            status="active",
            subgroup_id="sg-001",
        )

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent == {
            "role": "server",
            "type": "trail.node_status_updated",
            "chat_id": "chat-001",
            "group_id": "grp-001",
            "node_id": "node-001",
            "status": "active",
            "subgroup_id": "sg-001",
        }

    async def test_status_pending(self):
        """Status 'pending' is emitted correctly."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_node_status_updated(
            ws=ws, chat_id="c", group_id="g",
            node_id="n", status="pending", subgroup_id="sg",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["status"] == "pending"

    async def test_status_completed(self):
        """Status 'completed' is emitted correctly."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_node_status_updated(
            ws=ws, chat_id="c", group_id="g",
            node_id="n", status="completed", subgroup_id="sg",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["status"] == "completed"

    async def test_timeout_handled(self):
        """TimeoutError is caught and warning logged with event name."""
        emitter = TrailEmitter(timeout=0.001)

        async def slow_send(_text):
            await asyncio.sleep(10)

        ws = _mock_ws()
        ws.send_text.side_effect = slow_send

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_node_status_updated(
                ws=ws, chat_id="c", group_id="g",
                node_id="n", status="active", subgroup_id="sg",
            )
            _assert_timeout_warning(mock_warn, "node_status_updated")

    async def test_runtime_error_handled(self):
        """RuntimeError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_node_status_updated(
                ws=ws, chat_id="c", group_id="g",
                node_id="n", status="active", subgroup_id="sg",
            )
            _assert_error_warning(mock_warn, "node_status_updated", "closed")

    async def test_os_error_handled(self):
        """OSError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=OSError("pipe"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_node_status_updated(
                ws=ws, chat_id="c", group_id="g",
                node_id="n", status="active", subgroup_id="sg",
            )
            _assert_error_warning(mock_warn, "node_status_updated", "pipe")

    async def test_connection_error_handled(self):
        """ConnectionError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_node_status_updated(
                ws=ws, chat_id="c", group_id="g",
                node_id="n", status="active", subgroup_id="sg",
            )
            _assert_error_warning(mock_warn, "node_status_updated", "reset")


# ---------------------------------------------------------------------------
# emit_artifact_linked
# ---------------------------------------------------------------------------

class TestEmitArtifactLinked:
    """Tests for emit_artifact_linked."""

    async def test_sends_correct_event(self):
        """Sends all expected fields."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_artifact_linked(
            ws=ws,
            chat_id="chat-001",
            group_id="grp-001",
            artifact_id="art-001",
            subgroup_id="sg-001",
            node_id="node-001",
            artifact_type="code",
            backend_id="be-001",
        )

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent == {
            "role": "server",
            "type": "trail.artifact_linked",
            "chat_id": "chat-001",
            "group_id": "grp-001",
            "artifact_id": "art-001",
            "subgroup_id": "sg-001",
            "node_id": "node-001",
            "artifact_type": "code",
            "backend_id": "be-001",
        }

    async def test_artifact_type_output(self):
        """Different artifact_type values are passed through."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_artifact_linked(
            ws=ws, chat_id="c", group_id="g", artifact_id="a",
            subgroup_id="sg", node_id="n", artifact_type="output",
            backend_id="b",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["artifact_type"] == "output"

    async def test_timeout_handled(self):
        """TimeoutError is caught and warning logged with event name."""
        emitter = TrailEmitter(timeout=0.001)

        async def slow_send(_text):
            await asyncio.sleep(10)

        ws = _mock_ws()
        ws.send_text.side_effect = slow_send

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_artifact_linked(
                ws=ws, chat_id="c", group_id="g", artifact_id="a",
                subgroup_id="sg", node_id="n", artifact_type="code",
                backend_id="b",
            )
            _assert_timeout_warning(mock_warn, "artifact_linked")

    async def test_runtime_error_handled(self):
        """RuntimeError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_artifact_linked(
                ws=ws, chat_id="c", group_id="g", artifact_id="a",
                subgroup_id="sg", node_id="n", artifact_type="code",
                backend_id="b",
            )
            _assert_error_warning(mock_warn, "artifact_linked", "closed")

    async def test_os_error_handled(self):
        """OSError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=OSError("pipe"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_artifact_linked(
                ws=ws, chat_id="c", group_id="g", artifact_id="a",
                subgroup_id="sg", node_id="n", artifact_type="code",
                backend_id="b",
            )
            _assert_error_warning(mock_warn, "artifact_linked", "pipe")

    async def test_connection_error_handled(self):
        """ConnectionError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_artifact_linked(
                ws=ws, chat_id="c", group_id="g", artifact_id="a",
                subgroup_id="sg", node_id="n", artifact_type="code",
                backend_id="b",
            )
            _assert_error_warning(mock_warn, "artifact_linked", "reset")


# ---------------------------------------------------------------------------
# emit_subgroup_completed
# ---------------------------------------------------------------------------

class TestEmitSubgroupCompleted:
    """Tests for emit_subgroup_completed."""

    async def test_sends_correct_event(self):
        """Sends all expected fields."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_subgroup_completed(
            ws=ws,
            chat_id="chat-001",
            group_id="grp-001",
            subgroup_id="sg-001",
        )

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent == {
            "role": "server",
            "type": "trail.subgroup_completed",
            "chat_id": "chat-001",
            "group_id": "grp-001",
            "subgroup_id": "sg-001",
            "status": "completed",
        }

    async def test_status_always_completed(self):
        """Status is hardcoded to 'completed' regardless of input."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_subgroup_completed(
            ws=ws, chat_id="c", group_id="g", subgroup_id="sg",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["status"] == "completed"

    async def test_timeout_handled(self):
        """TimeoutError is caught and warning logged with event name."""
        emitter = TrailEmitter(timeout=0.001)

        async def slow_send(_text):
            await asyncio.sleep(10)

        ws = _mock_ws()
        ws.send_text.side_effect = slow_send

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_subgroup_completed(
                ws=ws, chat_id="c", group_id="g", subgroup_id="sg",
            )
            _assert_timeout_warning(mock_warn, "subgroup_completed")

    async def test_runtime_error_handled(self):
        """RuntimeError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_subgroup_completed(
                ws=ws, chat_id="c", group_id="g", subgroup_id="sg",
            )
            _assert_error_warning(mock_warn, "subgroup_completed", "closed")

    async def test_os_error_handled(self):
        """OSError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=OSError("pipe"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_subgroup_completed(
                ws=ws, chat_id="c", group_id="g", subgroup_id="sg",
            )
            _assert_error_warning(mock_warn, "subgroup_completed", "pipe")

    async def test_connection_error_handled(self):
        """ConnectionError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_subgroup_completed(
                ws=ws, chat_id="c", group_id="g", subgroup_id="sg",
            )
            _assert_error_warning(mock_warn, "subgroup_completed", "reset")


# ---------------------------------------------------------------------------
# emit_agent_message_sequence
# ---------------------------------------------------------------------------

class TestEmitAgentMessageSequence:
    """Tests for emit_agent_message_sequence."""

    async def test_sends_correct_event(self):
        """Sends all expected fields."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_agent_message_sequence(
            ws=ws,
            chat_id="chat-001",
            sequence_in_chat=42,
            backend_id="be-001",
        )

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent == {
            "role": "server",
            "type": "trail.agent_message_sequence",
            "chat_id": "chat-001",
            "sequence_in_chat": 42,
            "backend_id": "be-001",
        }

    async def test_role_is_server(self):
        """Role must be 'server' for trail events."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_agent_message_sequence(
            ws=ws, chat_id="c", sequence_in_chat=1, backend_id="b",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["role"] == "server"

    async def test_timeout_handled(self):
        """TimeoutError is caught and warning logged with event name."""
        emitter = TrailEmitter(timeout=0.001)

        async def slow_send(_text):
            await asyncio.sleep(10)

        ws = _mock_ws()
        ws.send_text.side_effect = slow_send

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_agent_message_sequence(
                ws=ws, chat_id="c", sequence_in_chat=1, backend_id="b",
            )
            _assert_timeout_warning(mock_warn, "agent_message_sequence")

    async def test_runtime_error_handled(self):
        """RuntimeError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_agent_message_sequence(
                ws=ws, chat_id="c", sequence_in_chat=1, backend_id="b",
            )
            _assert_error_warning(mock_warn, "agent_message_sequence", "closed")

    async def test_os_error_handled(self):
        """OSError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=OSError("pipe"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_agent_message_sequence(
                ws=ws, chat_id="c", sequence_in_chat=1, backend_id="b",
            )
            _assert_error_warning(mock_warn, "agent_message_sequence", "pipe")

    async def test_connection_error_handled(self):
        """ConnectionError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_agent_message_sequence(
                ws=ws, chat_id="c", sequence_in_chat=1, backend_id="b",
            )
            _assert_error_warning(mock_warn, "agent_message_sequence", "reset")


# ---------------------------------------------------------------------------
# emit_assistant_message_flushed
# ---------------------------------------------------------------------------

class TestEmitAssistantMessageFlushed:
    """Tests for emit_assistant_message_flushed."""

    async def test_sends_correct_event(self):
        """Sends all expected fields."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_assistant_message_flushed(
            ws=ws,
            chat_id="chat-001",
            sequence_in_chat=5,
            content="Hello world",
            message_id="msg-001",
        )

        ws.send_text.assert_awaited_once()
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent == {
            "role": "assistant",
            "type": "assistant.message_flushed",
            "chat_id": "chat-001",
            "sequence_in_chat": 5,
            "content": "Hello world",
            "message_id": "msg-001",
        }

    async def test_role_is_assistant_not_server(self):
        """Role must be 'assistant', not 'server'."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_assistant_message_flushed(
            ws=ws, chat_id="c", sequence_in_chat=1,
            content="test",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["role"] == "assistant"
        assert sent["role"] != "server"

    async def test_message_id_null_when_none(self):
        """message_id is serialized as null when None."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_assistant_message_flushed(
            ws=ws, chat_id="c", sequence_in_chat=1,
            content="test",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert "message_id" in sent
        assert sent["message_id"] is None

    async def test_content_preserved_exactly(self):
        """Content is not modified during emission."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()
        raw_content = "Hello\nworld\twith\rspecial <chars> & \"quotes\""

        await emitter.emit_assistant_message_flushed(
            ws=ws, chat_id="c", sequence_in_chat=1,
            content=raw_content,
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["content"] == raw_content

    async def test_empty_content(self):
        """Empty string content is emitted without modification."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter.emit_assistant_message_flushed(
            ws=ws, chat_id="c", sequence_in_chat=1,
            content="",
        )

        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["content"] == ""

    async def test_timeout_handled(self):
        """TimeoutError is caught and warning logged with event name."""
        emitter = TrailEmitter(timeout=0.001)

        async def slow_send(_text):
            await asyncio.sleep(10)

        ws = _mock_ws()
        ws.send_text.side_effect = slow_send

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_assistant_message_flushed(
                ws=ws, chat_id="c", sequence_in_chat=1,
                content="test",
            )
            _assert_timeout_warning(mock_warn, "assistant_message_flushed")

    async def test_runtime_error_handled(self):
        """RuntimeError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("closed"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_assistant_message_flushed(
                ws=ws, chat_id="c", sequence_in_chat=1,
                content="test",
            )
            _assert_error_warning(mock_warn, "assistant_message_flushed", "closed")

    async def test_os_error_handled(self):
        """OSError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=OSError("pipe"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_assistant_message_flushed(
                ws=ws, chat_id="c", sequence_in_chat=1,
                content="test",
            )
            _assert_error_warning(mock_warn, "assistant_message_flushed", "pipe")

    async def test_connection_error_handled(self):
        """ConnectionError is caught and warning logged."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=ConnectionError("reset"))
        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter.emit_assistant_message_flushed(
                ws=ws, chat_id="c", sequence_in_chat=1,
                content="test",
            )
            _assert_error_warning(mock_warn, "assistant_message_flushed", "reset")


# ---------------------------------------------------------------------------
# _send_event (internal helper — edge cases not covered by public methods)
# ---------------------------------------------------------------------------

class TestSendEvent:
    """Tests for _send_event internals."""

    async def test_json_serialization_exact(self):
        """Verify exact JSON string sent to WebSocket."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()
        event = {"role": "server", "type": "trail.test", "data": 42}

        await emitter._send_event(ws, event, "test")

        raw_text = ws.send_text.call_args[0][0]
        assert json.loads(raw_text) == event

    async def test_unserializable_payload_handled(self):
        """TypeError from json.dumps is caught and warning logged; send_text never called."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        class NotSerializable:
            pass

        event = {"data": NotSerializable()}

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter._send_event(ws, event, "bad_event")
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Failed to emit %s event: %s"
            assert args[1] == "bad_event"
            assert "not JSON serializable" in str(args[2])
        ws.send_text.assert_not_awaited()

    async def test_websocket_disconnect_handled(self):
        """WebSocketDisconnect is caught and warning logged."""
        from starlette.websockets import WebSocketDisconnect

        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws(send_side_effect=WebSocketDisconnect())

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter._send_event(ws, {"type": "test"}, "disconnect_event")
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Failed to emit %s event: %s"
            assert args[1] == "disconnect_event"

    async def test_timeout_logs_warning(self):
        """Timeout logs warning with event name."""
        emitter = TrailEmitter(timeout=0.001)

        async def slow_send(_text):
            await asyncio.sleep(10)

        ws = _mock_ws()
        ws.send_text.side_effect = slow_send

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter._send_event(ws, {"type": "test"}, "my_event")
            mock_warn.assert_called_once()
            assert "my_event" in mock_warn.call_args[0][1]

    async def test_runtime_error_logs_warning_with_event_name(self):
        """RuntimeError logs warning that includes the event name."""
        emitter = TrailEmitter()
        ws = _mock_ws(send_side_effect=RuntimeError("ws closed"))

        with patch.object(emitter._logger, "warning") as mock_warn:
            await emitter._send_event(ws, {"type": "test"}, "my_event")
            mock_warn.assert_called_once()
            assert "my_event" in mock_warn.call_args[0][1]

    async def test_multiple_calls_independent(self):
        """Multiple calls don't share state."""
        emitter = TrailEmitter(timeout=5.0)
        ws = _mock_ws()

        await emitter._send_event(ws, {"id": 1}, "first")
        await emitter._send_event(ws, {"id": 2}, "second")

        assert ws.send_text.await_count == 2
        first_sent = json.loads(ws.send_text.call_args_list[0][0][0])
        second_sent = json.loads(ws.send_text.call_args_list[1][0][0])
        assert first_sent == {"id": 1}
        assert second_sent == {"id": 2}
