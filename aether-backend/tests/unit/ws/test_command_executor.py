"""
Unit Tests: ws/presentation/command_executor.py

Tests CommandExecutor: dispatch for all 17 command types, list normalization,
unknown command fallback. Each command type verified for correct emitter call
with exact arguments.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from ws.presentation.command_executor import CommandExecutor
from ws.domain.commands.stream_commands import (
    EmitStreamEvent,
    EmitStreamEnd,
    EmitStreamCompletion,
    EmitStreamStop,
    EmitStreamError,
    EmitControlEvent,
)
from ws.domain.commands.trail_commands import (
    EmitGroupCreated,
    EmitSubgroupCreated,
    EmitNodeStatusUpdated,
    EmitArtifactLinked,
    EmitSubgroupCompleted,
    EmitAssistantMessageFlushed,
    EmitAgentMessageSequence,
)
from ws.domain.commands.audio_commands import (
    EmitTTSAudio,
    EmitTTSQueued,
    EmitTTSCompleted,
    EmitSleepWordDetected,
    EmitTTSError,
)


# =========================================================================
# Stubs
# =========================================================================


class StubWebSocket:
    """Captures send_json calls."""

    def __init__(self):
        self.sent = []

    async def send_json(self, payload: dict):
        self.sent.append(payload)


def make_executor():
    stream_emitter = MagicMock()
    stream_emitter.emit_event = AsyncMock()
    stream_emitter.emit_end = AsyncMock()
    stream_emitter.emit_completion = AsyncMock()
    stream_emitter.emit_stop = AsyncMock()
    stream_emitter.emit_error = AsyncMock()

    trail_emitter = MagicMock()
    trail_emitter.emit_group_created = AsyncMock()
    trail_emitter.emit_subgroup_created = AsyncMock()
    trail_emitter.emit_node_status_updated = AsyncMock()
    trail_emitter.emit_artifact_linked = AsyncMock()
    trail_emitter.emit_subgroup_completed = AsyncMock()
    trail_emitter.emit_assistant_message_flushed = AsyncMock()
    trail_emitter.emit_agent_message_sequence = AsyncMock()

    executor = CommandExecutor(
        stream_emitter=stream_emitter,
        trail_emitter=trail_emitter,
    )
    return executor, stream_emitter, trail_emitter


# =========================================================================
# execute: normalization
# =========================================================================


class TestExecuteNormalization:
    @pytest.mark.asyncio
    async def test_single_command_accepted(self):
        ex, se, _ = make_executor()
        ws = StubWebSocket()
        cmd = EmitStreamEvent(event={"role": "assistant", "content": "hi"})
        await ex.execute(ws, cmd)
        se.emit_event.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_list_of_commands(self):
        ex, se, _ = make_executor()
        ws = StubWebSocket()
        cmd1 = EmitStreamEvent(event={"content": "a"})
        cmd2 = EmitStreamEvent(event={"content": "b"})
        await ex.execute(ws, [cmd1, cmd2])
        assert se.emit_event.await_count == 2

    @pytest.mark.asyncio
    async def test_empty_list(self):
        ex, se, _ = make_executor()
        ws = StubWebSocket()
        await ex.execute(ws, [])
        se.emit_event.assert_not_awaited()


# =========================================================================
# Stream commands
# =========================================================================


class TestStreamCommands:
    @pytest.mark.asyncio
    async def test_emit_stream_event(self):
        ex, se, _ = make_executor()
        ws = StubWebSocket()
        event = {"role": "assistant", "content": "hello"}
        await ex.execute(ws, EmitStreamEvent(event=event))
        se.emit_event.assert_awaited_once_with(ws, event)

    @pytest.mark.asyncio
    async def test_emit_stream_end(self):
        ex, se, _ = make_executor()
        ws = StubWebSocket()
        end_msg = {"role": "assistant", "end": True}
        await ex.execute(ws, EmitStreamEnd(end_message=end_msg))
        se.emit_end.assert_awaited_once_with(ws, end_msg)

    @pytest.mark.asyncio
    async def test_emit_stream_completion(self):
        ex, se, _ = make_executor()
        ws = StubWebSocket()
        comp_msg = {"role": "server", "type": "completion"}
        await ex.execute(ws, EmitStreamCompletion(completion_message=comp_msg))
        se.emit_completion.assert_awaited_once_with(ws, comp_msg)

    @pytest.mark.asyncio
    async def test_emit_stream_stop(self):
        ex, se, _ = make_executor()
        ws = StubWebSocket()
        await ex.execute(ws, EmitStreamStop(
            request_id="req-1", correlation_id="corr-1", chat_id="chat-1",
        ))
        se.emit_stop.assert_awaited_once_with(ws, "req-1", "corr-1", "chat-1")

    @pytest.mark.asyncio
    async def test_emit_stream_error(self):
        ex, se, _ = make_executor()
        ws = StubWebSocket()
        await ex.execute(ws, EmitStreamError(
            request_id="req-1", correlation_id=None, chat_id=None,
        ))
        se.emit_error.assert_awaited_once_with(ws, "req-1", None, None)

    @pytest.mark.asyncio
    async def test_emit_control_event(self):
        ex, se, _ = make_executor()
        ws = StubWebSocket()
        event = {"type": "user.message_persisted", "message_id": "msg-1"}
        await ex.execute(ws, EmitControlEvent(event=event))
        se.emit_event.assert_awaited_once_with(ws, event)


# =========================================================================
# Trail commands
# =========================================================================


class TestTrailCommands:
    @pytest.mark.asyncio
    async def test_emit_group_created(self):
        ex, _, te = make_executor()
        ws = StubWebSocket()
        cmd = EmitGroupCreated(
            group_id="g1", chat_id="c1", sequence_number=1,
            backend_id="b1", frontend_id="f1", correlation_id="corr-1",
        )
        await ex.execute(ws, cmd)
        te.emit_group_created.assert_awaited_once()
        kwargs = te.emit_group_created.call_args[1]
        assert kwargs["ws"] is ws
        assert kwargs["group_id"] == "g1"
        assert kwargs["chat_id"] == "c1"
        assert kwargs["sequence_number"] == 1

    @pytest.mark.asyncio
    async def test_emit_subgroup_created(self):
        ex, _, te = make_executor()
        ws = StubWebSocket()
        cmd = EmitSubgroupCreated(
            chat_id="c1", subgroup_id="sg1", group_id="g1",
            execution_group="exec-1", writing_node_id="wn1",
            executing_node_id="en1", output_node_id="on1",
            backend_id="b1", subgroup_sequence_number=1,
            sequence_in_chat=5,
        )
        await ex.execute(ws, cmd)
        te.emit_subgroup_created.assert_awaited_once()
        kwargs = te.emit_subgroup_created.call_args[1]
        assert kwargs["subgroup_id"] == "sg1"
        assert kwargs["writing_node_id"] == "wn1"

    @pytest.mark.asyncio
    async def test_emit_node_status_updated(self):
        ex, _, te = make_executor()
        ws = StubWebSocket()
        cmd = EmitNodeStatusUpdated(
            chat_id="c1", group_id="g1", node_id="n1",
            status="active", subgroup_id="sg1",
        )
        await ex.execute(ws, cmd)
        te.emit_node_status_updated.assert_awaited_once()
        kwargs = te.emit_node_status_updated.call_args[1]
        assert kwargs["node_id"] == "n1"
        assert kwargs["status"] == "active"

    @pytest.mark.asyncio
    async def test_emit_artifact_linked(self):
        ex, _, te = make_executor()
        ws = StubWebSocket()
        cmd = EmitArtifactLinked(
            chat_id="c1", group_id="g1", artifact_id="art1",
            subgroup_id="sg1", node_id="n1",
            artifact_type="code", backend_id="b1",
        )
        await ex.execute(ws, cmd)
        te.emit_artifact_linked.assert_awaited_once()
        kwargs = te.emit_artifact_linked.call_args[1]
        assert kwargs["artifact_id"] == "art1"
        assert kwargs["artifact_type"] == "code"

    @pytest.mark.asyncio
    async def test_emit_subgroup_completed(self):
        ex, _, te = make_executor()
        ws = StubWebSocket()
        cmd = EmitSubgroupCompleted(
            chat_id="c1", group_id="g1", subgroup_id="sg1",
        )
        await ex.execute(ws, cmd)
        te.emit_subgroup_completed.assert_awaited_once()
        kwargs = te.emit_subgroup_completed.call_args[1]
        assert kwargs["subgroup_id"] == "sg1"

    @pytest.mark.asyncio
    async def test_emit_assistant_message_flushed(self):
        ex, _, te = make_executor()
        ws = StubWebSocket()
        cmd = EmitAssistantMessageFlushed(
            chat_id="c1", sequence_in_chat=3,
            content="Hello world", message_id="msg-1",
        )
        await ex.execute(ws, cmd)
        te.emit_assistant_message_flushed.assert_awaited_once()
        kwargs = te.emit_assistant_message_flushed.call_args[1]
        assert kwargs["content"] == "Hello world"
        assert kwargs["sequence_in_chat"] == 3

    @pytest.mark.asyncio
    async def test_emit_agent_message_sequence(self):
        ex, _, te = make_executor()
        ws = StubWebSocket()
        cmd = EmitAgentMessageSequence(
            chat_id="c1", sequence_in_chat=7, backend_id="b1",
        )
        await ex.execute(ws, cmd)
        te.emit_agent_message_sequence.assert_awaited_once()
        kwargs = te.emit_agent_message_sequence.call_args[1]
        assert kwargs["sequence_in_chat"] == 7


# =========================================================================
# Audio commands (direct WebSocket sends)
# =========================================================================


class TestAudioCommands:
    @pytest.mark.asyncio
    async def test_emit_tts_audio(self):
        ex, _, _ = make_executor()
        ws = StubWebSocket()
        cmd = EmitTTSAudio(
            client_id="c1", audio_data="base64audio",
            format="pcm16", sample_rate=24000,
        )
        await ex.execute(ws, cmd)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == "tts-audio"
        assert ws.sent[0]["audio"] == "base64audio"
        assert ws.sent[0]["format"] == "pcm16"
        assert ws.sent[0]["sample_rate"] == 24000
        assert ws.sent[0]["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_emit_tts_queued(self):
        ex, _, _ = make_executor()
        ws = StubWebSocket()
        cmd = EmitTTSQueued(client_id="c1")
        await ex.execute(ws, cmd)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == "tts-queued"
        assert ws.sent[0]["client_id"] == "c1"
        assert ws.sent[0]["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_emit_tts_completed(self):
        ex, _, _ = make_executor()
        ws = StubWebSocket()
        cmd = EmitTTSCompleted(client_id="c1")
        await ex.execute(ws, cmd)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == "tts-completed"
        assert ws.sent[0]["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_emit_sleep_word_detected(self):
        ex, _, _ = make_executor()
        ws = StubWebSocket()
        cmd = EmitSleepWordDetected(client_id="c1", text="go to sleep")
        await ex.execute(ws, cmd)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == "sleep-word-detected"
        assert ws.sent[0]["text"] == "go to sleep"

    @pytest.mark.asyncio
    async def test_emit_tts_error(self):
        ex, _, _ = make_executor()
        ws = StubWebSocket()
        cmd = EmitTTSError(
            client_id="c1", error_type="queue_full",
            message="TTS queue overflow",
        )
        await ex.execute(ws, cmd)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == "tts-error"
        assert ws.sent[0]["error_type"] == "queue_full"
        assert ws.sent[0]["message"] == "TTS queue overflow"


# =========================================================================
# Unknown command
# =========================================================================


class TestUnknownCommand:
    @pytest.mark.asyncio
    async def test_unknown_command_type_logged(self):
        ex, se, te = make_executor()
        ws = StubWebSocket()

        class FakeCommand:
            pass

        await ex.execute(ws, FakeCommand())
        # No emitter should be called
        se.emit_event.assert_not_awaited()
        te.emit_group_created.assert_not_awaited()
        # No WebSocket send
        assert len(ws.sent) == 0
