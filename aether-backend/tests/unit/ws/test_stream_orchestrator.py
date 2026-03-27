"""
Integration Tests: StreamOrchestrator

Tests the refactored orchestrator's relay_stream with a deterministic
mock runtime that yields predetermined event sequences. Verifies correct
command output, delegation to extracted services, and error handling.

Uses mock services throughout -- no DB, no network.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from ws.application.stream_orchestrator import StreamOrchestrator
from ws.application.user_message_persister import UserMessagePersister, PersistResult
from ws.application.assistant_text_flusher import AssistantTextFlusher
from ws.application.runtime_settings_applicator import RuntimeSettingsApplicator
from ws.application.chat_summarization_service import ChatSummarizationService
from ws.domain.services.event_normalizer import EventNormalizer
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
    EmitAgentMessageSequence,
)
from ws.domain.services.artifact_tracker import ArtifactTracker
from ws.domain.services.message_accumulator import MessageAccumulator


# =========================================================================
# Deterministic Runtime (mock stream_chat)
# =========================================================================

class DeterministicRuntime:
    """
    Mock runtime that yields a predetermined sequence of events.

    Usage:
        runtime = DeterministicRuntime([
            {"role": "assistant", "type": "message", "content": "Hello"},
            {"role": "assistant", "type": "message", "content": " world", "end": True},
        ])
    """

    def __init__(self, events=None, *, raise_on_stream=None):
        self.events = events or []
        self.stream_chat_calls = []
        self._raise_on_stream = raise_on_stream

    async def stream_chat(self, **kwargs):
        self.stream_chat_calls.append(kwargs)
        if self._raise_on_stream:
            raise self._raise_on_stream
        for event in self.events:
            yield event


# =========================================================================
# Fixtures
# =========================================================================

@pytest.fixture
def stub_cache():
    """Mock CacheService."""
    cache = MagicMock()
    cache.record_session_state = AsyncMock()
    return cache


@pytest.fixture
def stub_trail_coordinator():
    """Mock TrailCoordinator (no-op for basic tests)."""
    coord = MagicMock()
    coord.complete_hierarchy = AsyncMock()
    coord.create_hierarchy = AsyncMock(return_value=None)
    coord.create_subgroup = AsyncMock(return_value=None)
    coord.update_node_status = AsyncMock()
    coord._trail_repo = None  # No trail repo (skip agent message sequence reservation)
    coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
    return coord


@pytest.fixture
def stub_persister():
    """Stub UserMessagePersister that returns empty result."""
    persister = MagicMock(spec=UserMessagePersister)
    persister.persist_user_message = AsyncMock(return_value=PersistResult())
    return persister


@pytest.fixture
def stub_flusher():
    """Stub AssistantTextFlusher that returns None (no flush)."""
    flusher = MagicMock(spec=AssistantTextFlusher)
    flusher.flush_if_pending = AsyncMock(return_value=None)
    return flusher


@pytest.fixture
def stub_settings_applicator():
    """Stub RuntimeSettingsApplicator that no-ops."""
    applicator = MagicMock(spec=RuntimeSettingsApplicator)
    applicator.apply = AsyncMock()
    return applicator


@pytest.fixture
def stub_summarization():
    """Stub ChatSummarizationService that no-ops."""
    service = MagicMock(spec=ChatSummarizationService)
    service.check_and_summarize = AsyncMock()
    return service


def make_orchestrator(
    events=None,
    *,
    cache=None,
    trail_coordinator=None,
    persister=None,
    flusher=None,
    settings_applicator=None,
    summarization=None,
    chat_repository=None,
    raise_on_stream=None,
):
    """Factory: create StreamOrchestrator with deterministic runtime."""
    runtime = DeterministicRuntime(events or [], raise_on_stream=raise_on_stream)
    cache = cache or MagicMock(record_session_state=AsyncMock())
    trail = trail_coordinator or MagicMock(
        complete_hierarchy=AsyncMock(),
        create_hierarchy=AsyncMock(return_value=None),
        create_subgroup=AsyncMock(return_value=None),
        _trail_repo=None,
        _calculate_subgroup_sequence=AsyncMock(return_value=1),
    )

    return StreamOrchestrator(
        runtime=runtime,
        trail_coordinator=trail,
        cache_service=cache,
        chat_repository=chat_repository,
        event_normalizer=EventNormalizer(),
        user_message_persister=persister or MagicMock(
            spec=UserMessagePersister,
            persist_user_message=AsyncMock(return_value=PersistResult()),
        ),
        assistant_text_flusher=flusher or MagicMock(
            spec=AssistantTextFlusher,
            flush_if_pending=AsyncMock(return_value=None),
        ),
        settings_applicator=settings_applicator or MagicMock(
            spec=RuntimeSettingsApplicator,
            apply=AsyncMock(),
        ),
        summarization_service=summarization or MagicMock(
            spec=ChatSummarizationService,
            check_and_summarize=AsyncMock(),
        ),
    ), runtime


async def collect_commands(orchestrator, **kwargs):
    """Collect all yielded commands from relay_stream into a list."""
    commands = []
    async for cmd in orchestrator.relay_stream(**kwargs):
        commands.append(cmd)
    return commands


# =========================================================================
# Test Classes
# =========================================================================

class TestSimpleTextStream:
    """Test a simple assistant text-only stream (no artifacts, no trails)."""

    @pytest.mark.asyncio
    async def test_yields_stream_events_for_text_deltas(self):
        """Assistant message deltas should produce EmitStreamEvent commands."""
        events = [
            {"role": "assistant", "type": "message", "content": "Hello"},
            {"role": "assistant", "type": "message", "content": " world"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
        )

        # Should have: 2 stream events + 1 end + 1 completion
        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        ends = [c for c in commands if isinstance(c, EmitStreamEnd)]
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]

        assert len(stream_events) == 2
        assert len(ends) == 1
        assert len(completions) == 1

    @pytest.mark.asyncio
    async def test_enriched_events_have_request_id(self):
        """Enriched events should carry the request_id from enrich_event."""
        events = [
            {"role": "assistant", "type": "message", "content": "test"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1",
            request_id="req-123",
            frontend_id="f1",
            text="Hi",
        )

        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) >= 1
        assert stream_events[0].event.get("request_id") == "req-123"


class TestNormalizationFiltering:
    """Test that EventNormalizer correctly filters events."""

    @pytest.mark.asyncio
    async def test_auth_handshake_events_are_filtered(self):
        """Auth handshake events should be silently filtered."""
        events = [
            {"auth": "token_xyz", "status": "ok"},  # Should be filtered
            {"role": "assistant", "type": "message", "content": "Hi"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
        )

        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        # Only the assistant message should produce a stream event (auth filtered)
        assert len(stream_events) == 1
        assert stream_events[0].event.get("content") == "Hi"

    @pytest.mark.asyncio
    async def test_active_line_markers_are_filtered(self):
        """Active line progress markers should be filtered (format=active_line and ##active_line##)."""
        events = [
            {"role": "computer", "type": "console", "format": "active_line", "content": "5"},
            {"role": "computer", "type": "output", "content": "##active_line3##", "format": "text"},
            {"role": "assistant", "type": "message", "content": "Done"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Run",
        )

        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        # Only "Done" message should come through (both markers filtered)
        assert len(stream_events) == 1


class TestStopAndErrorSignals:
    """Test stop/error signal handling from runtime."""

    @pytest.mark.asyncio
    async def test_stop_signal_produces_stream_event_and_stops(self):
        """Server stop signal should yield EmitStreamEvent and break."""
        events = [
            {"role": "assistant", "type": "message", "content": "partial"},
            {"role": "server", "type": "stopped", "message": "User cancelled"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
        )

        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        # Should have 2 stream events: the partial + the stop
        assert len(stream_events) == 2
        # Should NOT have completion (was cancelled)
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 0

    @pytest.mark.asyncio
    async def test_error_signal_produces_stream_event_and_stops(self):
        """Server error signal should yield EmitStreamEvent and break."""
        events = [
            {"role": "server", "type": "error", "message": "OI crashed"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
        )

        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 1
        # Should NOT have completion (errored)
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 0


class TestExceptionHandling:
    """Test exception handling in relay_stream."""

    @pytest.mark.asyncio
    async def test_runtime_exception_yields_stream_error(self):
        """Unexpected runtime exception should yield EmitStreamError."""
        orch, _ = make_orchestrator(
            raise_on_stream=ValueError("Unexpected runtime crash")
        )

        commands = await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
        )

        errors = [c for c in commands if isinstance(c, EmitStreamError)]
        assert len(errors) == 1
        assert errors[0].request_id == "r1"


class TestServiceDelegation:
    """Test that orchestrator correctly delegates to extracted services."""

    @pytest.mark.asyncio
    async def test_calls_settings_applicator_before_stream(self):
        """RuntimeSettingsApplicator.apply must be called before streaming."""
        applicator = MagicMock(spec=RuntimeSettingsApplicator)
        applicator.apply = AsyncMock()

        orch, runtime = make_orchestrator(
            events=[],
            settings_applicator=applicator,
        )

        await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
        )

        applicator.apply.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_calls_user_message_persister_when_chat_id_provided(self):
        """UserMessagePersister.persist_user_message called when chat_id is set."""
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(return_value=PersistResult())

        orch, _ = make_orchestrator(
            events=[],
            persister=persister,
        )

        chat_id = str(uuid4())
        await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
            chat_id=chat_id,
        )

        persister.persist_user_message.assert_awaited_once()
        persist_kwargs = persister.persist_user_message.call_args.kwargs
        assert persist_kwargs["chat_id"] == chat_id
        assert persist_kwargs["text"] == "Hi"
        assert persist_kwargs["metadata"] is None

    @pytest.mark.asyncio
    async def test_forwards_metadata_to_user_message_persister(self):
        """relay_stream forwards hidden message metadata to persistence layer."""
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(return_value=PersistResult())

        orch, _ = make_orchestrator(
            events=[],
            persister=persister,
        )

        chat_id = str(uuid4())
        hidden_metadata = {
            "source": "proactive",
            "context": {"doc_research": [{"query": "q1"}]},
        }
        await collect_commands(
            orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
            chat_id=chat_id,
            metadata=hidden_metadata,
        )

        persister.persist_user_message.assert_awaited_once()
        persist_kwargs = persister.persist_user_message.call_args.kwargs
        assert persist_kwargs["metadata"] == hidden_metadata

    @pytest.mark.asyncio
    async def test_skips_user_message_persister_when_no_chat_id(self):
        """UserMessagePersister should NOT be called without chat_id."""
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(return_value=PersistResult())

        orch, _ = make_orchestrator(
            events=[],
            persister=persister,
        )

        await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
            chat_id=None,
        )

        persister.persist_user_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_yields_commands_from_user_message_persister(self):
        """Commands returned by UserMessagePersister should be yielded."""
        control_event = EmitControlEvent(event={
            "type": "user.message_persisted",
            "message_id": str(uuid4()),
        })
        result = PersistResult(user_msg_id=uuid4(), commands=[control_event])
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(return_value=result)

        orch, _ = make_orchestrator(
            events=[],
            persister=persister,
        )

        commands = await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
            chat_id=str(uuid4()),
        )

        control_events = [c for c in commands if isinstance(c, EmitControlEvent)]
        assert len(control_events) == 1
        assert control_events[0].event["type"] == "user.message_persisted"


class TestFinalizationPhase:
    """Test the finally block (Phase 3: Finalization)."""

    @pytest.mark.asyncio
    async def test_flushes_remaining_text_in_finally(self):
        """AssistantTextFlusher should be called in finally block."""
        flusher = MagicMock(spec=AssistantTextFlusher)
        flusher.flush_if_pending = AsyncMock(return_value=None)

        msg_id = uuid4()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "message", "content": "Hello"},
        ]
        orch, _ = make_orchestrator(
            events=events,
            persister=persister,
            flusher=flusher,
        )

        await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
            chat_id=str(uuid4()),
        )

        # flush_if_pending should be called at least once (in finally block)
        assert flusher.flush_if_pending.await_count >= 1

    @pytest.mark.asyncio
    async def test_sends_end_marker_if_not_already_sent(self):
        """End marker should be synthesized in finally if not sent during stream."""
        events = [
            {"role": "assistant", "type": "message", "content": "partial"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
        )

        ends = [c for c in commands if isinstance(c, EmitStreamEnd)]
        assert len(ends) == 1

    @pytest.mark.asyncio
    async def test_records_final_session_state(self):
        """Should record session state at start and end."""
        cache = MagicMock()
        cache.record_session_state = AsyncMock()

        orch, _ = make_orchestrator(events=[], cache=cache)

        await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
        )

        # Should be called at least twice: initial "active" + final state
        assert cache.record_session_state.await_count >= 2


class TestContentDeltaAccumulation:
    """Test that content deltas are accumulated for assistant text flush."""

    @pytest.mark.asyncio
    async def test_content_deltas_accumulated_for_flush(self):
        """Content from assistant deltas should be passed to flusher."""
        flusher = MagicMock(spec=AssistantTextFlusher)
        flusher.flush_if_pending = AsyncMock(return_value=None)

        msg_id = uuid4()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "message", "content": "Hello"},
            {"role": "assistant", "type": "message", "content": " world"},
        ]
        orch, _ = make_orchestrator(
            events=events,
            persister=persister,
            flusher=flusher,
        )

        await collect_commands(orch,
            client_id="c1",
            request_id="r1",
            frontend_id="f1",
            text="Hi",
            chat_id=str(uuid4()),
        )

        # The finally block should call flush_if_pending with the accumulated parts
        assert flusher.flush_if_pending.await_count >= 1
        # The 'parts' argument should contain the accumulated text
        call_kwargs = flusher.flush_if_pending.call_args[1]
        assert "parts" in call_kwargs
        # Parts may be empty if cleared during stream, but should have been called


class TestStructuralIntegrity:
    """Structural tests verifying the orchestrator's architecture."""

    def test_orchestrator_has_no_websocket_parameter(self):
        """StreamOrchestrator.__init__ must NOT accept a websocket parameter."""
        import inspect
        sig = inspect.signature(StreamOrchestrator.__init__)
        param_names = list(sig.parameters.keys())
        assert "ws" not in param_names
        assert "websocket" not in param_names

    def test_relay_stream_is_async_generator(self):
        """relay_stream must be an async generator (yields commands)."""
        import inspect
        assert inspect.isasyncgenfunction(StreamOrchestrator.relay_stream)

    def test_orchestrator_accepts_all_extracted_services(self):
        """Constructor should accept all 5 extracted service parameters."""
        import inspect
        sig = inspect.signature(StreamOrchestrator.__init__)
        param_names = set(sig.parameters.keys())
        expected = {
            "event_normalizer",
            "user_message_persister",
            "assistant_text_flusher",
            "settings_applicator",
            "summarization_service",
        }
        assert expected.issubset(param_names), (
            f"Missing constructor params: {expected - param_names}"
        )


# =========================================================================
# Expanded Coverage (Agent C Audit)
# =========================================================================


class TestCancelledStream:
    """Test CancelledError handling in relay_stream."""

    @pytest.mark.asyncio
    async def test_cancellation_yields_stop_command(self):
        """CancelledError should yield EmitStreamStop and re-raise."""
        class CancellingRuntime:
            stream_chat_calls = []

            async def stream_chat(self, **kwargs):
                self.stream_chat_calls.append(kwargs)
                yield {"role": "assistant", "type": "message", "content": "partial"}
                raise asyncio.CancelledError()

        runtime = CancellingRuntime()
        cache = MagicMock(record_session_state=AsyncMock())
        orch = StreamOrchestrator(
            runtime=runtime,
            trail_coordinator=MagicMock(
                complete_hierarchy=AsyncMock(),
                create_hierarchy=AsyncMock(return_value=None),
                _trail_repo=None,
            ),
            cache_service=cache,
            event_normalizer=EventNormalizer(),
            user_message_persister=MagicMock(
                spec=UserMessagePersister,
                persist_user_message=AsyncMock(return_value=PersistResult()),
            ),
            assistant_text_flusher=MagicMock(
                spec=AssistantTextFlusher,
                flush_if_pending=AsyncMock(return_value=None),
            ),
            settings_applicator=MagicMock(
                spec=RuntimeSettingsApplicator,
                apply=AsyncMock(),
            ),
            summarization_service=MagicMock(
                spec=ChatSummarizationService,
                check_and_summarize=AsyncMock(),
            ),
        )

        commands = []
        with pytest.raises(asyncio.CancelledError):
            async for cmd in orch.relay_stream(
                client_id="c1",
                request_id="r1",
                frontend_id="f1",
                text="Hi",
            ):
                commands.append(cmd)

        # Should have: stream event + stop
        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        stops = [c for c in commands if isinstance(c, EmitStreamStop)]
        assert len(stream_events) >= 1
        assert len(stops) == 1
        assert stops[0].request_id == "r1"


class TestIsContentDelta:
    """Test _is_content_delta helper method."""

    def test_assistant_message_with_content(self):
        orch, _ = make_orchestrator([])
        event = {"role": "assistant", "type": "message", "content": "hello"}
        assert orch._is_content_delta(event) is True

    def test_assistant_message_empty_content(self):
        orch, _ = make_orchestrator([])
        event = {"role": "assistant", "type": "message", "content": ""}
        assert not orch._is_content_delta(event)

    def test_assistant_message_with_end(self):
        orch, _ = make_orchestrator([])
        event = {"role": "assistant", "type": "message", "content": "hi", "end": True}
        assert not orch._is_content_delta(event)

    def test_computer_message(self):
        orch, _ = make_orchestrator([])
        event = {"role": "computer", "type": "message", "content": "output"}
        assert not orch._is_content_delta(event)

    def test_assistant_code_type(self):
        orch, _ = make_orchestrator([])
        event = {"role": "assistant", "type": "code", "content": "print()"}
        assert not orch._is_content_delta(event)

    def test_no_role(self):
        orch, _ = make_orchestrator([])
        event = {"type": "message", "content": "test"}
        assert not orch._is_content_delta(event)


class TestShutdown:
    """Test shutdown method for background task cleanup."""

    @pytest.mark.asyncio
    async def test_shutdown_with_no_tasks(self):
        orch, _ = make_orchestrator([])
        await orch.shutdown()  # Should not raise

    @pytest.mark.asyncio
    async def test_shutdown_cancels_background_tasks(self):
        orch, _ = make_orchestrator([])

        async def long_running():
            await asyncio.sleep(999)

        task = asyncio.create_task(long_running())
        orch._background_tasks.add(task)

        await orch.shutdown()
        assert task.cancelled()
        assert len(orch._background_tasks) == 0

    @pytest.mark.asyncio
    async def test_track_background_task(self):
        orch, _ = make_orchestrator([])

        async def quick():
            pass

        task = asyncio.create_task(quick())
        orch._track_background_task(task)
        assert task in orch._background_tasks
        # Wait for task to complete
        await task
        await asyncio.sleep(0)  # Let callback fire
        assert task not in orch._background_tasks


class TestRecordSessionState:
    """Test _record_session_state helper."""

    @pytest.mark.asyncio
    async def test_records_active_state(self):
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator([], cache=cache)
        await orch._record_session_state(
            "req-1", "c1", "f1", "corr-1", "chat-1", "active",
        )
        cache.record_session_state.assert_awaited_once()
        call_args = cache.record_session_state.call_args[0]
        assert call_args[0] == "req-1"
        payload = call_args[1]
        assert payload["state"] == "active"
        assert payload["client_id"] == "c1"
        assert "error" not in payload

    @pytest.mark.asyncio
    async def test_records_error_state_with_detail(self):
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator([], cache=cache)
        await orch._record_session_state(
            "req-1", "c1", "f1", None, None, "error", "timeout",
        )
        payload = cache.record_session_state.call_args[0][1]
        assert payload["state"] == "error"
        assert payload["error"] == "timeout"

    @pytest.mark.asyncio
    async def test_cache_failure_does_not_raise(self):
        """BUG: _record_session_state had no error handling.
        Called from finally block of relay_stream — a raise here would
        mask the original error and crash finalization. Fixed: wrapped in try/except.
        """
        cache = MagicMock(
            record_session_state=AsyncMock(side_effect=RuntimeError("cache down")),
        )
        orch, _ = make_orchestrator([], cache=cache)
        # Must NOT raise
        await orch._record_session_state(
            "req-1", "c1", "f1", "corr-1", "chat-1", "completed",
        )

    @pytest.mark.asyncio
    async def test_connection_error_does_not_raise(self):
        """ConnectionError from cache service is caught."""
        cache = MagicMock(
            record_session_state=AsyncMock(side_effect=ConnectionError("redis down")),
        )
        orch, _ = make_orchestrator([], cache=cache)
        await orch._record_session_state(
            "req-1", "c1", "f1", None, None, "active",
        )


class TestEndMarkerHandling:
    """Test that end markers from runtime are properly handled."""

    @pytest.mark.asyncio
    async def test_end_marker_in_stream_prevents_duplicate(self):
        """If runtime sends end marker, finally block should not synthesize another."""
        events = [
            {"role": "assistant", "type": "message", "content": "text"},
            {"role": "assistant", "type": "message", "end": True},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        ends = [c for c in commands if isinstance(c, EmitStreamEnd)]
        # Should have exactly 1 end (from stream), not 2
        assert len(ends) == 1


class TestContentAccumulationWithPersistence:
    """Test that content is accumulated and flushed for persistence."""

    @pytest.mark.asyncio
    async def test_content_parts_passed_to_flusher(self):
        flusher = MagicMock(spec=AssistantTextFlusher)
        flusher.flush_if_pending = AsyncMock(return_value=None)

        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=uuid4()),
        )

        events = [
            {"role": "assistant", "type": "message", "content": "Hello "},
            {"role": "assistant", "type": "message", "content": "world"},
        ]
        orch, _ = make_orchestrator(
            events, persister=persister, flusher=flusher,
        )

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Hi", chat_id=str(uuid4()),
        )

        # Verify flusher was called with accumulated parts
        assert flusher.flush_if_pending.await_count >= 1
        # Get the final flush call kwargs
        final_call = flusher.flush_if_pending.call_args_list[-1]
        parts = final_call[1].get("parts", [])
        # Parts should contain accumulated content
        combined = "".join(parts)
        assert "Hello " in combined
        assert "world" in combined


class TestSessionStateTransitions:
    """Test that session state is recorded at start and end."""

    @pytest.mark.asyncio
    async def test_records_completed_state_on_success(self):
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(
            events=[{"role": "assistant", "type": "message", "content": "ok"}],
            cache=cache,
        )

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        # Check final state recorded
        calls = cache.record_session_state.call_args_list
        assert len(calls) >= 2
        final_payload = calls[-1][0][1]
        assert final_payload["state"] == "completed"

    @pytest.mark.asyncio
    async def test_records_error_state_on_exception(self):
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(
            raise_on_stream=ValueError("crash"),
            cache=cache,
        )

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        calls = cache.record_session_state.call_args_list
        final_payload = calls[-1][0][1]
        assert final_payload["state"] == "error"
        assert final_payload["error"] == "crash"


# =========================================================================
# Extended Coverage — Trail, Artifact, and Lifecycle Gap Tests
# =========================================================================


def make_trail_hierarchy(**overrides):
    """Create a trail hierarchy dict matching what trail_coordinator returns."""
    data = {
        "chat_id": str(uuid4()),
        "group_id": str(uuid4()),
        "subgroup_id": str(uuid4()),
        "writing_node_id": str(uuid4()),
        "executing_node_id": str(uuid4()),
        "output_node_id": str(uuid4()),
        "execution_group": "exec_test_1",
        "sequence_number": 1,
        "subgroup_sequence_number": 1,
        "sequence_in_chat": 1,
    }
    data.update(overrides)
    return data


def make_trail_coordinator_with_hierarchy(hierarchy_data=None, subgroup_data=None):
    """Create trail coordinator that returns actual data."""
    coord = MagicMock()
    coord.complete_hierarchy = AsyncMock()
    coord.create_hierarchy = AsyncMock(return_value=hierarchy_data)
    coord.create_subgroup = AsyncMock(return_value=subgroup_data)
    coord.update_node_status = AsyncMock()
    coord._trail_repo = MagicMock()
    coord._trail_repo.get_next_chat_sequence = AsyncMock(return_value=1)
    coord._trail_repo.get_group_by_user_message_id = AsyncMock(return_value=None)
    coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
    return coord


def make_chat_repository():
    """Create mock chat repository."""
    repo = MagicMock()
    repo.ensure_chat_exists = AsyncMock()
    repo.create_artifact = AsyncMock()
    return repo


# =========================================================================
# TestHandleStartMarker
# =========================================================================


class TestHandleStartMarker:
    """Tests for _handle_start_marker method."""

    def test_start_marker_for_message_type_emits_event(self):
        """Non-artifact start marker should emit enriched stream event."""
        orch, _ = make_orchestrator([])
        tracker = ArtifactTracker()

        cmds = orch._handle_start_marker(
            event={"role": "assistant", "type": "message", "start": True},
            sent_start_per_type={},
            artifact_tracker=tracker,
            artifact_counters={},
            sequence=1,
            request_id="r1",
            frontend_id="f1",
            correlation_id="c1",
            chat_id="ch1",
        )

        assert len(cmds) == 1
        assert isinstance(cmds[0], EmitStreamEvent)
        assert cmds[0].event["request_id"] == "r1"
        # Non-artifact type should NOT have artifact_id
        assert "artifact_id" not in cmds[0].event

    def test_start_marker_for_code_type_generates_artifact_id(self):
        """Code start marker should generate and store artifact_id."""
        orch, _ = make_orchestrator([])
        tracker = ArtifactTracker()
        counters = {}

        cmds = orch._handle_start_marker(
            event={"role": "assistant", "type": "code", "format": "python", "start": True},
            sent_start_per_type={},
            artifact_tracker=tracker,
            artifact_counters=counters,
            sequence=1,
            request_id="r1",
            frontend_id="f1",
            correlation_id=None,
            chat_id=None,
        )

        assert len(cmds) == 1
        assert isinstance(cmds[0], EmitStreamEvent)
        assert cmds[0].event["artifact_id"] == "r1:code:1"
        assert tracker.has_artifact_type("code")
        assert tracker.get_artifact_id("code") == "r1:code:1"
        assert counters["code"] == 1

    def test_start_marker_deduplication(self):
        """Same type start marker sent twice should only emit once."""
        orch, _ = make_orchestrator([])
        tracker = ArtifactTracker()
        sent_start = {}
        counters = {}

        cmds1 = orch._handle_start_marker(
            event={"role": "assistant", "type": "code", "format": "python", "start": True},
            sent_start_per_type=sent_start,
            artifact_tracker=tracker,
            artifact_counters=counters,
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
        )
        cmds2 = orch._handle_start_marker(
            event={"role": "assistant", "type": "code", "format": "python", "start": True},
            sent_start_per_type=sent_start,
            artifact_tracker=tracker,
            artifact_counters=counters,
            sequence=2,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
        )

        assert len(cmds1) == 1
        assert len(cmds2) == 0
        assert counters["code"] == 1

    def test_start_marker_with_user_msg_id(self):
        """Start marker with user_msg_id includes message_id in enriched event."""
        orch, _ = make_orchestrator([])
        msg_id = str(uuid4())

        cmds = orch._handle_start_marker(
            event={"role": "assistant", "type": "code", "start": True},
            sent_start_per_type={},
            artifact_tracker=ArtifactTracker(),
            artifact_counters={},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
            user_msg_id=msg_id,
        )

        assert len(cmds) == 1
        assert cmds[0].event.get("message_id") == msg_id

    def test_start_marker_with_no_event_type(self):
        """Start marker with no type should not emit any command."""
        orch, _ = make_orchestrator([])

        cmds = orch._handle_start_marker(
            event={"start": True},
            sent_start_per_type={},
            artifact_tracker=ArtifactTracker(),
            artifact_counters={},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
        )

        assert len(cmds) == 0


# =========================================================================
# TestProcessArtifactEvent — basic
# =========================================================================


class TestProcessArtifactEvent:
    """Tests for _process_artifact_event method (basic paths)."""

    @pytest.mark.asyncio
    async def test_basic_code_artifact_emits_enriched_event(self):
        """Assistant code artifact should emit enriched stream event with artifact_id."""
        orch, _ = make_orchestrator([])
        tracker = ArtifactTracker()
        counters = {}
        content_parts = {}

        cmds, trail_h, last_type, sub_created = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "print('hi')"},
            sequence=1,
            request_id="r1",
            frontend_id="f1",
            correlation_id=None,
            chat_id=None,
            artifact_tracker=tracker,
            artifact_counters=counters,
            artifact_content_parts=content_parts,
            trail_hierarchy=None,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        assert len(cmds) == 1
        assert isinstance(cmds[0], EmitStreamEvent)
        assert cmds[0].event["artifact_id"] == "r1:code:1"
        assert last_type == "code"
        assert sub_created is False
        assert trail_h is None

    @pytest.mark.asyncio
    async def test_legacy_console_type_normalized_to_output(self):
        """Console type should be normalized to output+console."""
        orch, _ = make_orchestrator([])
        tracker = ArtifactTracker()
        event = {"role": "computer", "type": "console", "content": "running..."}

        cmds, _, last_type, _ = await orch._process_artifact_event(
            event=event,
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=None,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        assert last_type == "output"
        assert event["type"] == "output"
        assert event["format"] == "console"

    @pytest.mark.asyncio
    async def test_artifact_content_accumulated(self):
        """Artifact content should be accumulated in content_parts dict."""
        orch, _ = make_orchestrator([])
        tracker = ArtifactTracker()
        content_parts = {}

        await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "line1\n"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts=content_parts,
            trail_hierarchy=None,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        art_id = tracker.get_artifact_id("code")
        assert art_id is not None
        assert art_id in content_parts
        assert content_parts[art_id] == ["line1\n"]

    @pytest.mark.asyncio
    async def test_no_content_key_not_accumulated(self):
        """Event without content should create entry but not accumulate."""
        orch, _ = make_orchestrator([])
        tracker = ArtifactTracker()
        content_parts = {}

        await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts=content_parts,
            trail_hierarchy=None,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        art_id = tracker.get_artifact_id("code")
        assert content_parts.get(art_id) == []


# =========================================================================
# TestTrailLinking — artifact-to-node linking in _process_artifact_event
# =========================================================================


class TestTrailLinking:
    """Tests for trail linking logic in _process_artifact_event."""

    @pytest.mark.asyncio
    async def test_assistant_code_activates_writing_node(self):
        """Assistant code event should activate writing node and link artifact."""
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()

        cmds, _, last_type, _ = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            sequence=1,
            request_id="r1",
            frontend_id="f1",
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        node_updates = [c for c in cmds if isinstance(c, EmitNodeStatusUpdated)]
        linked = [c for c in cmds if isinstance(c, EmitArtifactLinked)]
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]

        assert len(node_updates) == 1
        assert node_updates[0].node_id == hierarchy["writing_node_id"]
        assert node_updates[0].status == "active"
        assert node_updates[0].chat_id == hierarchy["chat_id"]
        assert node_updates[0].group_id == hierarchy["group_id"]
        assert node_updates[0].subgroup_id == hierarchy["subgroup_id"]

        assert len(linked) == 1
        assert linked[0].node_id == hierarchy["writing_node_id"]
        assert linked[0].artifact_type == "code"
        assert linked[0].chat_id == hierarchy["chat_id"]
        assert linked[0].group_id == hierarchy["group_id"]
        assert linked[0].subgroup_id == hierarchy["subgroup_id"]
        assert linked[0].artifact_id == "r1:code:1"
        assert linked[0].backend_id == "r1"

        assert len(stream_events) == 1

        coord.update_node_status.assert_awaited_once_with(
            node_id=hierarchy["writing_node_id"],
            status="active",
        )

    @pytest.mark.asyncio
    async def test_computer_code_links_to_executing_node_no_status_updates(self):
        """Computer code event links artifact to executing node.

        Node status updates (writing→completed, executing→active) are now
        handled by _emit_forward_phase_transition in the main stream loop,
        NOT by _process_artifact_event.  The artifact handler only sets
        target_node_id for linking.
        """
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()

        cmds, _, _, _ = await orch._process_artifact_event(
            event={"role": "computer", "type": "code", "format": "python", "content": "x=1"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        node_updates = [c for c in cmds if isinstance(c, EmitNodeStatusUpdated)]
        linked = [c for c in cmds if isinstance(c, EmitArtifactLinked)]

        # No node status updates from artifact handler (phase block owns lifecycle)
        assert len(node_updates) == 0

        assert len(linked) == 1
        assert linked[0].node_id == hierarchy["executing_node_id"]
        assert linked[0].chat_id == hierarchy["chat_id"]
        assert linked[0].group_id == hierarchy["group_id"]
        assert linked[0].subgroup_id == hierarchy["subgroup_id"]
        assert linked[0].artifact_type == "code"
        assert linked[0].backend_id == "r1"

    @pytest.mark.asyncio
    async def test_computer_output_links_to_output_node_no_status_updates(self):
        """Computer output event links artifact to output node.

        Node status updates (writing→completed, executing→completed,
        output→active) are now handled by _emit_forward_phase_transition
        in the main stream loop.  The artifact handler only sets
        target_node_id for linking.
        """
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()

        cmds, _, last_type, _ = await orch._process_artifact_event(
            event={"role": "computer", "type": "output", "format": "text", "content": "result"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        node_updates = [c for c in cmds if isinstance(c, EmitNodeStatusUpdated)]
        linked = [c for c in cmds if isinstance(c, EmitArtifactLinked)]

        # No node status updates from artifact handler (phase block owns lifecycle)
        assert len(node_updates) == 0

        assert len(linked) == 1
        assert linked[0].node_id == hierarchy["output_node_id"]
        assert linked[0].artifact_type == "output"
        assert linked[0].chat_id == hierarchy["chat_id"]
        assert linked[0].group_id == hierarchy["group_id"]
        assert linked[0].subgroup_id == hierarchy["subgroup_id"]
        assert linked[0].backend_id == "r1"
        assert last_type == "output"

    @pytest.mark.asyncio
    async def test_already_linked_artifact_not_relinked(self):
        """Already-linked artifact should not emit linking commands again."""
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()
        tracker.store_artifact_id("code", "r1:code:1")
        tracker.mark_as_linked("r1:code:1")

        cmds, _, _, _ = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "more"},
            sequence=2,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={"code": 1},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        linked = [c for c in cmds if isinstance(c, EmitArtifactLinked)]
        node_updates = [c for c in cmds if isinstance(c, EmitNodeStatusUpdated)]
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]

        assert len(linked) == 0
        assert len(node_updates) == 0
        assert len(stream_events) == 1

    @pytest.mark.asyncio
    async def test_artifact_persisted_on_end_event(self):
        """Artifact with end=True should be persisted to DB."""
        hierarchy = make_trail_hierarchy()
        repo = make_chat_repository()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord, chat_repository=repo)
        tracker = ArtifactTracker()
        content_parts = {}
        msg_id = str(uuid4())

        # First chunk: accumulate content
        await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "print('hi')"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts=content_parts,
            trail_hierarchy=hierarchy,
            user_msg_id=msg_id,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # End chunk: triggers persistence
        await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "\n", "end": True},
            sequence=2,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts=content_parts,
            trail_hierarchy=hierarchy,
            user_msg_id=msg_id,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        repo.create_artifact.assert_awaited_once()
        call_kwargs = repo.create_artifact.call_args[1]
        assert call_kwargs["type"] == "code"
        assert "print('hi')" in call_kwargs["content"]
        assert call_kwargs["language"] == "python"


# =========================================================================
# TestEmergencyTrailCreation
# =========================================================================


class TestEmergencyTrailCreation:
    """Tests for emergency trail hierarchy creation in _process_artifact_event."""

    @pytest.mark.asyncio
    async def test_emergency_trail_created_when_no_hierarchy(self):
        """Artifact without active hierarchy triggers emergency trail creation."""
        hierarchy_data = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy(hierarchy_data=hierarchy_data)
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()
        chat_id = str(uuid4())

        cmds, trail_h, _, _ = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            sequence=1,
            request_id="r1",
            frontend_id="f1",
            correlation_id="c1",
            chat_id=chat_id,
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=None,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        coord.create_hierarchy.assert_awaited_once()
        create_kwargs = coord.create_hierarchy.call_args[1]
        assert create_kwargs["user_message"] == "[Emergency Context]"

        group_cmds = [c for c in cmds if isinstance(c, EmitGroupCreated)]
        subgroup_cmds = [c for c in cmds if isinstance(c, EmitSubgroupCreated)]
        assert len(group_cmds) == 1
        assert len(subgroup_cmds) == 1

        assert trail_h is not None
        assert trail_h["group_id"] == hierarchy_data["group_id"]

    @pytest.mark.asyncio
    async def test_emergency_trail_skipped_without_chat_id(self):
        """No emergency trail when chat_id is None."""
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)

        cmds, trail_h, _, _ = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
            artifact_tracker=ArtifactTracker(),
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=None,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        coord.create_hierarchy.assert_not_awaited()
        assert trail_h is None

    @pytest.mark.asyncio
    async def test_emergency_trail_handles_creation_failure(self):
        """Emergency trail creation failure should not crash artifact processing."""
        coord = make_trail_coordinator_with_hierarchy()
        coord.create_hierarchy = AsyncMock(side_effect=ConnectionError("DB down"))
        orch, _ = make_orchestrator([], trail_coordinator=coord)

        cmds, trail_h, _, _ = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=str(uuid4()),
            artifact_tracker=ArtifactTracker(),
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=None,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # Should still emit the artifact stream event despite trail failure
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 1
        assert trail_h is None


# =========================================================================
# TestMultiExecutionSubgroup
# =========================================================================


class TestMultiExecutionSubgroup:
    """Tests for multi-execution subgroup creation in _process_artifact_event."""

    @pytest.mark.asyncio
    async def test_code_after_output_creates_new_subgroup(self):
        """Code artifact after output (new cycle) should create new subgroup."""
        old_hierarchy = make_trail_hierarchy()
        new_subgroup = make_trail_hierarchy(group_id=old_hierarchy["group_id"])
        coord = make_trail_coordinator_with_hierarchy(subgroup_data=new_subgroup)
        repo = make_chat_repository()
        orch, _ = make_orchestrator([], trail_coordinator=coord, chat_repository=repo)
        tracker = ArtifactTracker()

        cmds, trail_h, _, sub_created = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "x=2"},
            sequence=5,
            request_id="r1",
            frontend_id="f1",
            correlation_id=None,
            chat_id=old_hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=old_hierarchy,
            user_msg_id=None,
            last_artifact_type="output",
            full_assistant_text_parts=["some text"],
            subgroup_created_for_code_event=False,
        )

        assert sub_created is True
        coord.complete_hierarchy.assert_awaited_once()
        coord.create_subgroup.assert_awaited_once()

        completed_cmds = [c for c in cmds if isinstance(c, EmitSubgroupCompleted)]
        subgroup_cmds = [c for c in cmds if isinstance(c, EmitSubgroupCreated)]
        assert len(completed_cmds) == 1
        assert len(subgroup_cmds) == 1

        assert trail_h["subgroup_id"] == new_subgroup["subgroup_id"]

    @pytest.mark.asyncio
    async def test_code_after_output_skipped_when_already_created(self):
        """Should not create subgroup if subgroup_created_for_code_event is True."""
        old_hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)

        cmds, _, _, sub_created = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "x=2"},
            sequence=5,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=old_hierarchy["chat_id"],
            artifact_tracker=ArtifactTracker(),
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=old_hierarchy,
            user_msg_id=None,
            last_artifact_type="output",
            full_assistant_text_parts=[],
            subgroup_created_for_code_event=True,
        )

        assert sub_created is False
        coord.create_subgroup.assert_not_awaited()


# =========================================================================
# TestOutputGapDetection
# =========================================================================


class TestOutputGapDetection:
    """Tests for output artifact gap detection in _process_artifact_event."""

    @pytest.mark.asyncio
    async def test_new_output_block_gets_new_artifact_id(self):
        """New output block after linked previous should get new artifact ID."""
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()
        tracker.store_artifact_id("output", "r1:output:1")
        tracker.mark_as_linked("r1:output:1")

        await orch._process_artifact_event(
            event={"role": "computer", "type": "output", "format": "text", "content": "new result"},
            sequence=3,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={"output": 1},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type="code",
            full_assistant_text_parts=[],
        )

        current_output_id = tracker.get_artifact_id("output")
        assert current_output_id != "r1:output:1"
        assert current_output_id == "r1:output:2"


# =========================================================================
# TestCompleteTrailHierarchy
# =========================================================================


class TestCompleteTrailHierarchy:
    """Tests for _complete_trail_hierarchy method."""

    @pytest.mark.asyncio
    async def test_returns_completion_commands_for_all_nodes(self):
        """Should return NodeStatusUpdated(completed) for all 3 nodes + SubgroupCompleted."""
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        hierarchy = make_trail_hierarchy()

        cmds = await orch._complete_trail_hierarchy(hierarchy)

        # 3 node completions + 1 subgroup completion = 4 commands
        assert len(cmds) == 4
        status_cmds = [c for c in cmds if isinstance(c, EmitNodeStatusUpdated)]
        assert len(status_cmds) == 3
        # All three nodes completed
        completed_ids = {c.node_id for c in status_cmds}
        assert completed_ids == {
            hierarchy["writing_node_id"],
            hierarchy["executing_node_id"],
            hierarchy["output_node_id"],
        }
        for c in status_cmds:
            assert c.status == "completed"
        # Subgroup completed last
        assert isinstance(cmds[-1], EmitSubgroupCompleted)
        assert cmds[-1].subgroup_id == hierarchy["subgroup_id"]

        coord.complete_hierarchy.assert_awaited_once_with(
            subgroup_id=hierarchy["subgroup_id"],
            output_node_id=hierarchy["output_node_id"],
        )

    @pytest.mark.asyncio
    async def test_db_failure_returns_empty_commands(self):
        """DB failure during completion returns empty list (no optimistic emission).

        Frontend must NOT be told hierarchy is completed if the DB was not updated.
        Consistency: both frontend and DB remain in the same (incomplete) state.
        """
        coord = make_trail_coordinator_with_hierarchy()
        coord.complete_hierarchy = AsyncMock(side_effect=ConnectionError("DB down"))
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        hierarchy = make_trail_hierarchy()

        cmds = await orch._complete_trail_hierarchy(hierarchy)

        # No commands emitted — DB failed, so frontend should not see completion
        assert len(cmds) == 0


# =========================================================================
# TestEmitForwardPhaseTransition
# =========================================================================


class TestEmitForwardPhaseTransition:
    """Tests for _emit_forward_phase_transition (phase-driven node lifecycle)."""

    @pytest.mark.asyncio
    async def test_writing_to_executing(self):
        """writing→executing completes writing and activates executing."""
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)

        cmds = await orch._emit_forward_phase_transition(
            trail_hierarchy=hierarchy,
            from_phase="writing",
            to_phase="executing",
            chat_id=hierarchy["chat_id"],
        )

        assert len(cmds) == 2
        assert cmds[0].node_id == hierarchy["writing_node_id"]
        assert cmds[0].status == "completed"
        assert cmds[1].node_id == hierarchy["executing_node_id"]
        assert cmds[1].status == "active"

    @pytest.mark.asyncio
    async def test_executing_to_output(self):
        """executing→output completes executing and activates output."""
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)

        cmds = await orch._emit_forward_phase_transition(
            trail_hierarchy=hierarchy,
            from_phase="executing",
            to_phase="output",
            chat_id=hierarchy["chat_id"],
        )

        assert len(cmds) == 2
        assert cmds[0].node_id == hierarchy["executing_node_id"]
        assert cmds[0].status == "completed"
        assert cmds[1].node_id == hierarchy["output_node_id"]
        assert cmds[1].status == "active"

    @pytest.mark.asyncio
    async def test_writing_to_output_skips_executing(self):
        """writing→output (skip executing) completes writing+executing, activates output."""
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)

        cmds = await orch._emit_forward_phase_transition(
            trail_hierarchy=hierarchy,
            from_phase="writing",
            to_phase="output",
            chat_id=hierarchy["chat_id"],
        )

        assert len(cmds) == 3
        assert cmds[0].node_id == hierarchy["writing_node_id"]
        assert cmds[0].status == "completed"
        assert cmds[1].node_id == hierarchy["executing_node_id"]
        assert cmds[1].status == "completed"
        assert cmds[2].node_id == hierarchy["output_node_id"]
        assert cmds[2].status == "active"

    @pytest.mark.asyncio
    async def test_no_commands_for_writing_phase(self):
        """writing phase doesn't trigger forward transition (trail creation handles it)."""
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)

        cmds = await orch._emit_forward_phase_transition(
            trail_hierarchy=hierarchy,
            from_phase=None,
            to_phase="writing",
            chat_id=hierarchy["chat_id"],
        )

        assert len(cmds) == 0


# =========================================================================
# TestPrepareSubgroupArtifacts
# =========================================================================


class TestPrepareSubgroupArtifacts:
    """Tests for _prepare_subgroup_artifacts method."""

    @pytest.mark.asyncio
    async def test_resets_tracker_and_generates_two_ids(self):
        """Should reset tracker and generate code + output artifact IDs."""
        orch, _ = make_orchestrator([])
        tracker = ArtifactTracker()
        tracker.store_artifact_id("code", "old:code:1")
        tracker.mark_as_linked("old:code:1")
        counters = {"code": 1, "output": 0}

        await orch._prepare_subgroup_artifacts(
            artifact_tracker=tracker,
            artifact_counters=counters,
            request_id="r2",
        )

        assert tracker.get_artifact_id("code") == "r2:code:2"
        assert tracker.get_artifact_id("output") == "r2:output:1"
        assert counters["code"] == 2
        assert counters["output"] == 1
        assert not tracker.is_already_linked("old:code:1")

    @pytest.mark.asyncio
    async def test_creates_placeholder_artifacts_in_db(self):
        """When chat_repository is present, creates placeholder artifacts with correct types."""
        repo = make_chat_repository()
        orch, _ = make_orchestrator([], chat_repository=repo)
        tracker = ArtifactTracker()
        chat_id = str(uuid4())
        subgroup_id = str(uuid4())
        writing_node_id = str(uuid4())
        output_node_id = str(uuid4())

        await orch._prepare_subgroup_artifacts(
            artifact_tracker=tracker,
            artifact_counters={},
            request_id="r1",
            chat_id=chat_id,
            subgroup_id=subgroup_id,
            writing_node_id=writing_node_id,
            output_node_id=output_node_id,
        )

        assert repo.create_artifact.await_count == 2
        calls = repo.create_artifact.call_args_list
        # First call: code artifact linked to writing node
        assert calls[0][1]["type"] == "code"
        assert str(calls[0][1]["node_id"]) == writing_node_id
        assert str(calls[0][1]["subgroup_id"]) == subgroup_id
        assert calls[0][1]["content"] is None
        # Second call: output artifact linked to output node
        assert calls[1][1]["type"] == "output"
        assert str(calls[1][1]["node_id"]) == output_node_id
        assert str(calls[1][1]["subgroup_id"]) == subgroup_id
        assert calls[1][1]["content"] is None

    @pytest.mark.asyncio
    async def test_handles_db_error_gracefully(self):
        """DB error during artifact creation should not propagate."""
        repo = make_chat_repository()
        repo.create_artifact = AsyncMock(side_effect=ConnectionError("DB down"))
        orch, _ = make_orchestrator([], chat_repository=repo)
        tracker = ArtifactTracker()

        await orch._prepare_subgroup_artifacts(
            artifact_tracker=tracker,
            artifact_counters={},
            request_id="r1",
            chat_id=str(uuid4()),
            subgroup_id=str(uuid4()),
            writing_node_id=str(uuid4()),
            output_node_id=str(uuid4()),
        )

        assert tracker.has_artifact_type("code")
        assert tracker.has_artifact_type("output")


# =========================================================================
# TestEndToEndTrailCreation — relay_stream with trail paths
# =========================================================================


class TestEndToEndTrailCreation:
    """End-to-end tests for trail creation through relay_stream."""

    @pytest.mark.asyncio
    async def test_code_event_triggers_trail_hierarchy_creation(self):
        """Code event with chat_id should trigger full trail hierarchy."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = make_trail_coordinator_with_hierarchy(hierarchy_data=hierarchy_data)
        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "print('hi')"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Write code", chat_id=chat_id,
        )

        group_cmds = [c for c in commands if isinstance(c, EmitGroupCreated)]
        subgroup_cmds = [c for c in commands if isinstance(c, EmitSubgroupCreated)]

        assert len(group_cmds) == 1
        assert group_cmds[0].group_id == hierarchy_data["group_id"]
        assert len(subgroup_cmds) == 1
        assert subgroup_cmds[0].subgroup_id == hierarchy_data["subgroup_id"]

        coord.create_hierarchy.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_text_after_execution_completes_trail(self):
        """Text event after execution phase should complete trail hierarchy."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = make_trail_coordinator_with_hierarchy(hierarchy_data=hierarchy_data)
        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            {"role": "computer", "type": "output", "format": "text", "content": "result"},
            {"role": "assistant", "type": "message", "content": "Done!"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Run code", chat_id=chat_id,
        )

        completed_cmds = [c for c in commands if isinstance(c, EmitSubgroupCompleted)]
        assert len(completed_cmds) == 1

    @pytest.mark.asyncio
    async def test_agent_message_sequence_reserved(self):
        """Agent message sequence should be reserved when trail_repo exists."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = make_trail_coordinator_with_hierarchy(hierarchy_data=hierarchy_data)
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )
        repo = make_chat_repository()

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Code please", chat_id=chat_id,
        )

        seq_cmds = [c for c in commands if isinstance(c, EmitAgentMessageSequence)]
        assert len(seq_cmds) == 1
        assert seq_cmds[0].chat_id == chat_id
        assert seq_cmds[0].backend_id == "r1"

    @pytest.mark.asyncio
    async def test_existing_group_creates_subgroup_not_hierarchy(self):
        """When group already exists for user_msg_id, creates subgroup only."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        existing_group = {"id": uuid4(), "chat_id": chat_id}
        subgroup_data = make_trail_hierarchy(
            chat_id=chat_id,
            group_id=str(existing_group["id"]),
        )

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_hierarchy = AsyncMock(return_value=None)
        coord.create_subgroup = AsyncMock(return_value=subgroup_data)
        coord.update_node_status = AsyncMock()
        coord._trail_repo = MagicMock()
        coord._trail_repo.get_next_chat_sequence = AsyncMock(return_value=2)
        coord._trail_repo.get_group_by_user_message_id = AsyncMock(return_value=existing_group)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=2)

        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="More code", chat_id=chat_id,
        )

        coord.create_hierarchy.assert_not_awaited()
        coord.create_subgroup.assert_awaited_once()

        group_cmds = [c for c in commands if isinstance(c, EmitGroupCreated)]
        subgroup_cmds = [c for c in commands if isinstance(c, EmitSubgroupCreated)]
        assert len(group_cmds) == 0
        assert len(subgroup_cmds) == 1


# =========================================================================
# TestFinalizationWithTrails
# =========================================================================


class TestFinalizationWithTrails:
    """Tests for finalization (finally block) with active trail hierarchy."""

    @pytest.mark.asyncio
    async def test_triggers_auto_summarization_on_success(self):
        """Successful stream with trail should trigger auto-summarization."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = make_trail_coordinator_with_hierarchy(hierarchy_data=hierarchy_data)
        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )
        summarization = MagicMock(spec=ChatSummarizationService)
        summarization.check_and_summarize = AsyncMock()

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
            summarization=summarization,
        )

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Code", chat_id=chat_id,
        )

        await asyncio.sleep(0.1)
        summarization.check_and_summarize.assert_awaited_once_with(chat_id)

    @pytest.mark.asyncio
    async def test_skips_summarization_on_error(self):
        """Errored stream should NOT trigger summarization."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = make_trail_coordinator_with_hierarchy(hierarchy_data=hierarchy_data)
        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )
        summarization = MagicMock(spec=ChatSummarizationService)
        summarization.check_and_summarize = AsyncMock()

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            {"role": "server", "type": "error", "message": "OI crashed"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
            summarization=summarization,
        )

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Code", chat_id=chat_id,
        )

        await asyncio.sleep(0.1)
        summarization.check_and_summarize.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_skips_summarization_on_cancelled(self):
        """Cancelled stream should NOT trigger summarization."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = make_trail_coordinator_with_hierarchy(hierarchy_data=hierarchy_data)
        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )
        summarization = MagicMock(spec=ChatSummarizationService)
        summarization.check_and_summarize = AsyncMock()

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            {"role": "server", "type": "stopped", "message": "User cancelled"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
            summarization=summarization,
        )

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Code", chat_id=chat_id,
        )

        await asyncio.sleep(0.1)
        summarization.check_and_summarize.assert_not_awaited()


# =========================================================================
# TestEdgeCasesAndBugHunting
# =========================================================================


class TestEdgeCasesAndBugHunting:
    """Adversarial tests hunting for bugs in stream_orchestrator."""

    @pytest.mark.asyncio
    async def test_error_detail_empty_message_falls_through(self):
        """Intentional: empty string message is falsy, falls through to content field.

        The `or` chain (event.get("message") or event.get("content") or "runtime_error")
        deliberately skips empty strings. An empty error message is not meaningful.
        This is consistent with _record_session_state's `if error:` check.
        """
        events = [
            {"role": "server", "type": "error", "message": "", "content": "fallback_content"},
        ]
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(events, cache=cache)

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        final_payload = cache.record_session_state.call_args_list[-1][0][1]
        assert final_payload["state"] == "error"
        # Intentional: "" is falsy so `or` chain falls through to content field
        assert final_payload["error"] == "fallback_content"

    @pytest.mark.asyncio
    async def test_error_detail_no_message_no_content_defaults(self):
        """Error without message or content should use 'runtime_error'."""
        events = [
            {"role": "server", "type": "error"},
        ]
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(events, cache=cache)

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        final_payload = cache.record_session_state.call_args_list[-1][0][1]
        assert final_payload["error"] == "runtime_error"

    @pytest.mark.asyncio
    async def test_stop_signal_prevents_completion_and_end(self):
        """Stop signal should prevent both completion and end marker."""
        events = [
            {"role": "server", "type": "stopped"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        ends = [c for c in commands if isinstance(c, EmitStreamEnd)]
        assert len(completions) == 0
        assert len(ends) == 0

    @pytest.mark.asyncio
    async def test_background_task_exception_handled(self):
        """Background task exception should be logged, not propagated."""
        orch, _ = make_orchestrator([])

        async def failing_task():
            raise ValueError("bg task failure")

        task = asyncio.create_task(failing_task())
        orch._track_background_task(task)

        await asyncio.sleep(0.1)
        assert task not in orch._background_tasks

    @pytest.mark.asyncio
    async def test_sequence_counter_increments_per_delta(self):
        """Each content delta should increment the sequence counter."""
        events = [
            {"role": "assistant", "type": "message", "content": "A"},
            {"role": "assistant", "type": "message", "content": "B"},
            {"role": "assistant", "type": "message", "content": "C"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 3
        seqs = [e.event["sequence"] for e in stream_events]
        assert seqs == [1, 2, 3]

    @pytest.mark.asyncio
    async def test_flush_failure_in_finally_does_not_crash(self):
        """Flush failure in finally block should be caught."""
        flusher = MagicMock(spec=AssistantTextFlusher)
        flusher.flush_if_pending = AsyncMock(side_effect=ConnectionError("DB unreachable"))

        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=uuid4())
        )

        events = [
            {"role": "assistant", "type": "message", "content": "Hello"},
        ]
        orch, _ = make_orchestrator(
            events, persister=persister, flusher=flusher,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Hi", chat_id=str(uuid4()),
        )

        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 1

    def test_is_content_delta_with_none_content(self):
        """Event with content=None should not be a content delta."""
        orch, _ = make_orchestrator([])
        event = {"role": "assistant", "type": "message", "content": None}
        assert not orch._is_content_delta(event)

    def test_is_content_delta_with_end_true(self):
        """Event with end=True should not be a content delta even with content."""
        orch, _ = make_orchestrator([])
        event = {"role": "assistant", "type": "message", "content": "text", "end": True}
        assert not orch._is_content_delta(event)

    def test_is_content_delta_with_empty_string_content(self):
        """Event with content='' (empty string, falsy) should not be a content delta."""
        orch, _ = make_orchestrator([])
        event = {"role": "assistant", "type": "message", "content": ""}
        assert not orch._is_content_delta(event)

    def test_is_content_delta_positive_case(self):
        """Valid assistant message with content and no end flag is a content delta."""
        orch, _ = make_orchestrator([])
        event = {"role": "assistant", "type": "message", "content": "hello"}
        assert orch._is_content_delta(event)

    def test_is_content_delta_wrong_role(self):
        """Computer role message with content is NOT a content delta."""
        orch, _ = make_orchestrator([])
        event = {"role": "computer", "type": "message", "content": "hello"}
        assert not orch._is_content_delta(event)

    def test_is_content_delta_wrong_type(self):
        """Assistant code event is NOT a content delta."""
        orch, _ = make_orchestrator([])
        event = {"role": "assistant", "type": "code", "content": "x=1"}
        assert not orch._is_content_delta(event)

    @pytest.mark.asyncio
    async def test_node_status_update_failure_still_emits_command(self):
        """If update_node_status fails, EmitNodeStatusUpdated should still be emitted."""
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        coord.update_node_status = AsyncMock(side_effect=ConnectionError("DB down"))
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()

        cmds, _, _, _ = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        node_updates = [c for c in cmds if isinstance(c, EmitNodeStatusUpdated)]
        assert len(node_updates) == 1
        assert node_updates[0].status == "active"

    @pytest.mark.asyncio
    async def test_trail_hierarchy_creation_error_does_not_crash_stream(self):
        """Trail creation failure should not crash the entire stream."""
        chat_id = str(uuid4())
        msg_id = uuid4()

        coord = make_trail_coordinator_with_hierarchy()
        coord.create_hierarchy = AsyncMock(side_effect=ConnectionError("DB down"))
        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            {"role": "assistant", "type": "message", "content": "Done"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Code", chat_id=chat_id,
        )

        # Stream should still complete despite trail creation failure
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 1

        # Artifact and text events should still be emitted
        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) >= 2


# =========================================================================
# TestHandleContentDelta — direct unit tests
# =========================================================================


class TestHandleContentDelta:
    """Direct tests for _handle_content_delta method."""

    @pytest.mark.asyncio
    async def test_accumulates_content_in_message_accumulator(self):
        """Content delta should add content to message accumulator."""
        orch, _ = make_orchestrator([])
        accumulator = MessageAccumulator(user_message="Hi")

        await orch._handle_content_delta(
            event={"role": "assistant", "type": "message", "content": "Hello"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
            message_accumulator=accumulator,
        )
        await orch._handle_content_delta(
            event={"role": "assistant", "type": "message", "content": " world"},
            sequence=2,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
            message_accumulator=accumulator,
        )

        assert accumulator.get_agent_message() == "Hello world"

    @pytest.mark.asyncio
    async def test_returns_enriched_stream_event(self):
        """Should return exactly one EmitStreamEvent with enriched fields."""
        orch, _ = make_orchestrator([])
        accumulator = MessageAccumulator(user_message="Hi")

        cmds = await orch._handle_content_delta(
            event={"role": "assistant", "type": "message", "content": "Hello"},
            sequence=5,
            request_id="r1",
            frontend_id="f1",
            correlation_id="c1",
            chat_id="ch1",
            message_accumulator=accumulator,
            user_msg_id="msg1",
        )

        assert len(cmds) == 1
        assert isinstance(cmds[0], EmitStreamEvent)
        enriched = cmds[0].event
        assert enriched["request_id"] == "r1"
        assert enriched["frontend_id"] == "f1"
        assert enriched["correlation_id"] == "c1"
        assert enriched["chat_id"] == "ch1"
        assert enriched["sequence"] == 5
        assert enriched["content"] == "Hello"
        assert enriched["message_id"] == "msg1"

    @pytest.mark.asyncio
    async def test_empty_content_still_accumulated(self):
        """Empty string content is still passed to accumulator."""
        orch, _ = make_orchestrator([])
        accumulator = MessageAccumulator(user_message="Hi")

        await orch._handle_content_delta(
            event={"role": "assistant", "type": "message", "content": ""},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=None,
            message_accumulator=accumulator,
        )

        # Empty string IS accumulated (accumulator.add_agent_content("") called)
        # Agent message returns the joined parts, which is ""
        # But MessageAccumulator returns fallback when parts join to empty
        # Actually: parts = [""], join = "", which is falsy? No, the list is non-empty.
        # Let's verify: MessageAccumulator._agent_message_parts = [""]
        # get_agent_message: not empty (list has one element), so:
        # accumulated = "".join([""]) = "", return ""[:500] = ""
        assert accumulator.get_agent_message() == ""


# =========================================================================
# TestWhitespaceArtifactPersistence — edge case for artifact content
# =========================================================================


class TestWhitespaceArtifactPersistence:
    """Tests for whitespace-only artifact content handling."""

    @pytest.mark.asyncio
    async def test_whitespace_only_artifact_not_persisted(self):
        """Intentional: whitespace-only artifacts are not persisted to DB.

        Source: `if isinstance(artifact_content, str) and not artifact_content.strip():`
        sets artifact_content to None, preventing persistence.

        This is correct behavior: whitespace-only code or output has no meaningful
        content worth persisting. The strip() check ensures empty-looking artifacts
        don't consume DB rows.
        """
        hierarchy = make_trail_hierarchy()
        repo = make_chat_repository()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord, chat_repository=repo)
        tracker = ArtifactTracker()
        content_parts = {}

        # Accumulate whitespace-only content
        await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "   \n  \t  "},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts=content_parts,
            trail_hierarchy=hierarchy,
            user_msg_id=str(uuid4()),
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # End event should NOT trigger persistence due to whitespace-only content
        await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "  ", "end": True},
            sequence=2,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts=content_parts,
            trail_hierarchy=hierarchy,
            user_msg_id=str(uuid4()),
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # create_artifact should NOT be called — whitespace-only content is treated as None
        repo.create_artifact.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_real_content_after_whitespace_persisted(self):
        """Artifact with real content (not just whitespace) should be persisted."""
        hierarchy = make_trail_hierarchy()
        repo = make_chat_repository()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord, chat_repository=repo)
        tracker = ArtifactTracker()
        content_parts = {}
        msg_id = str(uuid4())

        await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "x = 1"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts=content_parts,
            trail_hierarchy=hierarchy,
            user_msg_id=msg_id,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "\n", "end": True},
            sequence=2,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts=content_parts,
            trail_hierarchy=hierarchy,
            user_msg_id=msg_id,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # Real content should trigger persistence
        repo.create_artifact.assert_awaited_once()
        call_kwargs = repo.create_artifact.call_args[1]
        assert "x = 1" in call_kwargs["content"]


# =========================================================================
# TestGeneratorExit — client disconnect mid-stream
# =========================================================================


class TestGeneratorExit:
    """Tests for GeneratorExit handling (client disconnect)."""

    @pytest.mark.asyncio
    async def test_client_disconnect_records_disconnected_state(self):
        """Closing the generator mid-stream should record 'disconnected' state."""
        events = [
            {"role": "assistant", "type": "message", "content": "A"},
            {"role": "assistant", "type": "message", "content": "B"},
            {"role": "assistant", "type": "message", "content": "C"},
        ]
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(events, cache=cache)

        gen = orch.relay_stream(
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        # Consume first yielded command, then simulate client disconnect
        await gen.__anext__()
        await gen.aclose()

        # Verify final state is "disconnected"
        final_call = cache.record_session_state.call_args_list[-1]
        final_payload = final_call[0][1]
        assert final_payload["state"] == "disconnected"

    @pytest.mark.asyncio
    async def test_client_disconnect_no_completion_or_end(self):
        """Disconnected stream should NOT emit completion or end markers."""
        events = [
            {"role": "assistant", "type": "message", "content": "Hello"},
        ]
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(events, cache=cache)

        gen = orch.relay_stream(
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        commands = []
        commands.append(await gen.__anext__())
        await gen.aclose()

        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        ends = [c for c in commands if isinstance(c, EmitStreamEnd)]
        assert len(completions) == 0
        assert len(ends) == 0

    @pytest.mark.asyncio
    async def test_client_disconnect_initial_state_recorded_as_active(self):
        """Even on disconnect, initial state should have been 'active'."""
        events = [
            {"role": "assistant", "type": "message", "content": "A"},
        ]
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(events, cache=cache)

        gen = orch.relay_stream(
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )
        await gen.__anext__()
        await gen.aclose()

        # First call should be "active", last should be "disconnected"
        assert len(cache.record_session_state.call_args_list) == 2
        first_payload = cache.record_session_state.call_args_list[0][0][1]
        assert first_payload["state"] == "active"
        last_payload = cache.record_session_state.call_args_list[-1][0][1]
        assert last_payload["state"] == "disconnected"


# =========================================================================
# TestCancelledError — task cancellation mid-stream
# =========================================================================


class TestCancelledError:
    """Tests for asyncio.CancelledError handling (task cancellation)."""

    @pytest.mark.asyncio
    async def test_cancelled_error_yields_stop_command(self):
        """CancelledError during stream should yield EmitStreamStop."""

        class CancellingRuntime:
            """Runtime that cancels after yielding one event."""
            async def stream_chat(self, **kwargs):
                yield {"role": "assistant", "type": "message", "content": "Hello"}
                raise asyncio.CancelledError()

        cache = MagicMock(record_session_state=AsyncMock())
        coord = MagicMock(
            complete_hierarchy=AsyncMock(),
            create_hierarchy=AsyncMock(return_value=None),
            create_subgroup=AsyncMock(return_value=None),
            _trail_repo=None,
            _calculate_subgroup_sequence=AsyncMock(return_value=1),
        )
        orch = StreamOrchestrator(
            runtime=CancellingRuntime(),
            trail_coordinator=coord,
            cache_service=cache,
            event_normalizer=EventNormalizer(),
            user_message_persister=MagicMock(
                spec=UserMessagePersister,
                persist_user_message=AsyncMock(return_value=PersistResult()),
            ),
            assistant_text_flusher=MagicMock(
                spec=AssistantTextFlusher,
                flush_if_pending=AsyncMock(return_value=None),
            ),
            settings_applicator=MagicMock(
                spec=RuntimeSettingsApplicator,
                apply=AsyncMock(),
            ),
            summarization_service=MagicMock(
                spec=ChatSummarizationService,
                check_and_summarize=AsyncMock(),
            ),
        )

        commands = []
        with pytest.raises(asyncio.CancelledError):
            async for cmd in orch.relay_stream(
                client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
            ):
                commands.append(cmd)

        stop_cmds = [c for c in commands if isinstance(c, EmitStreamStop)]
        assert len(stop_cmds) == 1
        assert stop_cmds[0].request_id == "r1"

    @pytest.mark.asyncio
    async def test_cancelled_error_records_cancelled_state(self):
        """CancelledError should record 'cancelled' as final state."""

        class CancellingRuntime:
            async def stream_chat(self, **kwargs):
                yield {"role": "assistant", "type": "message", "content": "Hello"}
                raise asyncio.CancelledError()

        cache = MagicMock(record_session_state=AsyncMock())
        coord = MagicMock(
            complete_hierarchy=AsyncMock(),
            create_hierarchy=AsyncMock(return_value=None),
            create_subgroup=AsyncMock(return_value=None),
            _trail_repo=None,
            _calculate_subgroup_sequence=AsyncMock(return_value=1),
        )
        orch = StreamOrchestrator(
            runtime=CancellingRuntime(),
            trail_coordinator=coord,
            cache_service=cache,
            event_normalizer=EventNormalizer(),
            user_message_persister=MagicMock(
                spec=UserMessagePersister,
                persist_user_message=AsyncMock(return_value=PersistResult()),
            ),
            assistant_text_flusher=MagicMock(
                spec=AssistantTextFlusher,
                flush_if_pending=AsyncMock(return_value=None),
            ),
            settings_applicator=MagicMock(
                spec=RuntimeSettingsApplicator,
                apply=AsyncMock(),
            ),
            summarization_service=MagicMock(
                spec=ChatSummarizationService,
                check_and_summarize=AsyncMock(),
            ),
        )

        with pytest.raises(asyncio.CancelledError):
            async for _ in orch.relay_stream(
                client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
            ):
                pass

        final_call = cache.record_session_state.call_args_list[-1]
        final_payload = final_call[0][1]
        assert final_payload["state"] == "cancelled"

    @pytest.mark.asyncio
    async def test_cancelled_error_no_completion_emitted(self):
        """Cancelled stream should NOT emit completion command."""
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(
            [], cache=cache,
            raise_on_stream=asyncio.CancelledError(),
        )

        commands = []
        with pytest.raises(asyncio.CancelledError):
            async for cmd in orch.relay_stream(
                client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
            ):
                commands.append(cmd)

        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 0
        # Should emit EmitStreamStop before re-raising
        stop_cmds = [c for c in commands if isinstance(c, EmitStreamStop)]
        assert len(stop_cmds) == 1


# =========================================================================
# TestSessionStateLifecycle — _record_session_state transitions
# =========================================================================


class TestSessionStateLifecycle:
    """Tests verifying initial and final session state recording."""

    @pytest.mark.asyncio
    async def test_success_records_active_then_completed(self):
        """Successful stream: state transitions active -> completed."""
        events = [
            {"role": "assistant", "type": "message", "content": "Done"},
        ]
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(events, cache=cache)

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        calls = cache.record_session_state.call_args_list
        assert len(calls) == 2
        assert calls[0][0][1]["state"] == "active"
        assert calls[1][0][1]["state"] == "completed"
        assert "error" not in calls[1][0][1]

    @pytest.mark.asyncio
    async def test_error_records_active_then_error_with_detail(self):
        """Errored stream: state transitions active -> error with error detail."""
        events = [
            {"role": "server", "type": "error", "message": "LLM timeout"},
        ]
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(events, cache=cache)

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        calls = cache.record_session_state.call_args_list
        assert len(calls) == 2
        assert calls[0][0][1]["state"] == "active"
        assert calls[1][0][1]["state"] == "error"
        assert calls[1][0][1]["error"] == "LLM timeout"

    @pytest.mark.asyncio
    async def test_stop_records_active_then_cancelled(self):
        """Stopped stream: state transitions active -> cancelled."""
        events = [
            {"role": "server", "type": "stopped"},
        ]
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(events, cache=cache)

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        calls = cache.record_session_state.call_args_list
        assert len(calls) == 2
        assert calls[0][0][1]["state"] == "active"
        assert calls[1][0][1]["state"] == "cancelled"
        assert "error" not in calls[1][0][1]

    @pytest.mark.asyncio
    async def test_runtime_exception_records_error_state(self):
        """Runtime exception: state transitions active -> error."""
        cache = MagicMock(record_session_state=AsyncMock())
        orch, _ = make_orchestrator(
            [], cache=cache,
            raise_on_stream=RuntimeError("OI process crashed"),
        )

        await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        calls = cache.record_session_state.call_args_list
        assert len(calls) == 2
        assert calls[0][0][1]["state"] == "active"
        assert calls[1][0][1]["state"] == "error"
        assert "OI process crashed" in calls[1][0][1]["error"]


# =========================================================================
# Coverage Gap Tests: CASE 2 — New code cycle with active hierarchy
# Lines 448-519
# =========================================================================


class TestCase2ActiveHierarchyNewCodeCycle:
    """
    Tests for CASE 2 in relay_stream: when a new writing phase begins
    while an existing trail_hierarchy is still active (code->output->code).

    This exercises lines 448-519 which handle:
    - Phase machine reset
    - Previous subgroup completion
    - Pending text flush
    - New subgroup creation in the existing group
    """

    @pytest.mark.asyncio
    async def test_new_code_cycle_creates_additional_subgroup(self):
        """
        Sequence: code -> output -> code should complete previous subgroup
        and create a new one in the same group.

        Covers lines 448-517: CASE 2 full flow.
        """
        chat_id = str(uuid4())
        msg_id = uuid4()

        # Initial hierarchy from CASE 1
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)
        # New subgroup for CASE 2
        new_subgroup = make_trail_hierarchy(
            chat_id=chat_id,
            group_id=hierarchy_data["group_id"],
        )

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_hierarchy = AsyncMock(return_value=hierarchy_data)
        coord.create_subgroup = AsyncMock(return_value=new_subgroup)
        coord.update_node_status = AsyncMock()
        coord._trail_repo = MagicMock()
        coord._trail_repo.get_next_chat_sequence = AsyncMock(return_value=1)
        coord._trail_repo.get_group_by_user_message_id = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=2)

        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            # CASE 1: first code event creates hierarchy
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            # Output phase: triggers subgroup_created_for_cycle reset
            {"role": "computer", "type": "output", "format": "text", "content": "result"},
            # CASE 2: second code event with active hierarchy
            {"role": "assistant", "type": "code", "format": "python", "content": "y=2"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="multi-exec", chat_id=chat_id,
        )

        # CASE 2 should have created a subgroup
        subgroup_cmds = [c for c in commands if isinstance(c, EmitSubgroupCreated)]
        # At least 2: one from CASE 1 and one from CASE 2
        assert len(subgroup_cmds) >= 2

        # Previous subgroup should have been completed
        completed_cmds = [c for c in commands if isinstance(c, EmitSubgroupCompleted)]
        assert len(completed_cmds) >= 1

        # complete_hierarchy should be called for previous subgroup (CASE 2 + finally)
        assert coord.complete_hierarchy.await_count >= 1

        # create_subgroup should be called for CASE 2
        coord.create_subgroup.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_case2_error_handling_continues_stream(self):
        """
        If CASE 2 subgroup creation fails, stream should continue.

        Covers lines 518-519: except block for CASE 2.
        """
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = MagicMock()
        coord.create_hierarchy = AsyncMock(return_value=hierarchy_data)
        # complete_hierarchy raises error in CASE 2 flow
        coord.complete_hierarchy = AsyncMock(side_effect=ConnectionError("DB down"))
        coord.create_subgroup = AsyncMock(return_value=None)
        coord.update_node_status = AsyncMock()
        coord._trail_repo = MagicMock()
        coord._trail_repo.get_next_chat_sequence = AsyncMock(return_value=1)
        coord._trail_repo.get_group_by_user_message_id = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=2)

        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            {"role": "computer", "type": "output", "format": "text", "content": "result"},
            {"role": "assistant", "type": "code", "format": "python", "content": "y=2"},
            {"role": "assistant", "type": "message", "content": "Done"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        # Should not crash despite CASE 2 error
        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="multi", chat_id=chat_id,
        )

        # Stream should complete
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 1

        # Text event should still be yielded
        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) >= 1


# =========================================================================
# Coverage Gap Tests: Start markers + fallthrough events in relay loop
# Lines 523-537, 623-632
# =========================================================================


class TestRelayStreamEventRouting:
    """
    Tests for event routing in the main relay_stream loop:
    - Start marker events (lines 523-537)
    - Fallthrough events (lines 623-632)
    """

    @pytest.mark.asyncio
    async def test_start_marker_routed_in_relay_stream(self):
        """
        Start marker events should flow through _handle_start_marker
        in the main relay_stream loop and be yielded as commands.

        Covers lines 523-537.
        """
        events = [
            {"role": "assistant", "type": "message", "start": True},
            {"role": "assistant", "type": "message", "content": "Hello"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        # Start marker event + content delta + end marker in finalization
        assert len(stream_events) >= 2

        # First stream event should come from the start marker
        first_event = stream_events[0].event
        assert first_event.get("start") is True

    @pytest.mark.asyncio
    async def test_start_marker_with_artifact_type_in_relay(self):
        """
        Start marker for code type in relay loop should generate artifact ID.

        Covers lines 523-537 with artifact type start.
        """
        events = [
            {"role": "assistant", "type": "code", "format": "python", "start": True},
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Code",
        )

        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) >= 2

        # Start marker should have artifact_id set
        start_event = stream_events[0].event
        assert start_event.get("start") is True
        assert start_event.get("artifact_id") is not None

    @pytest.mark.asyncio
    async def test_fallthrough_event_enriched_and_yielded(self):
        """
        Events that don't match any handler (not start, not content delta,
        not artifact, not end) should be enriched and yielded as-is.

        Covers lines 623-632.
        """
        # A server status event with no start/end, not a content delta,
        # not an artifact type, not a stop/error signal
        events = [
            {"role": "server", "type": "status", "content": "processing"},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        stream_events = [c for c in commands if isinstance(c, EmitStreamEvent)]
        # Should have at least the fallthrough event
        found = False
        for cmd in stream_events:
            if cmd.event.get("type") == "status":
                found = True
                # enrich_event adds request_id (not backend_id) at the event level
                assert cmd.event.get("request_id") == "r1"
                break
        assert found, "Fallthrough event should be enriched and yielded"

    @pytest.mark.asyncio
    async def test_end_marker_prevents_duplicate_and_sets_flag(self):
        """
        An explicit end marker in the stream sets sent_end flag,
        preventing duplicate end in finalization.

        Covers lines 597-620 (end marker handling in main loop).
        """
        events = [
            {"role": "assistant", "type": "message", "content": "Hello"},
            {"role": "assistant", "type": "message", "end": True},
        ]
        orch, _ = make_orchestrator(events)

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1", text="Hi",
        )

        end_cmds = [c for c in commands if isinstance(c, EmitStreamEnd)]
        # Should only have ONE end marker, not two
        assert len(end_cmds) == 1


# =========================================================================
# Coverage Gap Tests: Error paths — sequence reservation, final hierarchy,
# artifact processing errors
# Lines 339-340, 703-704, 913-914, 924, 963-964
# =========================================================================


class TestErrorPathsCoverage:
    """
    Tests for specific error handling branches that weren't previously covered.
    """

    @pytest.mark.asyncio
    async def test_sequence_reservation_failure_continues_stream(self):
        """
        If trail_repo.get_next_chat_sequence raises, stream continues.

        Covers lines 339-340.
        """
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_hierarchy = AsyncMock(return_value=hierarchy_data)
        coord.create_subgroup = AsyncMock(return_value=None)
        coord.update_node_status = AsyncMock()
        coord._trail_repo = MagicMock()
        # This is the key: reservation fails
        coord._trail_repo.get_next_chat_sequence = AsyncMock(
            side_effect=ConnectionError("Redis timeout")
        )
        coord._trail_repo.get_group_by_user_message_id = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)

        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Code", chat_id=chat_id,
        )

        # No EmitAgentMessageSequence should be emitted (reservation failed)
        seq_cmds = [c for c in commands if isinstance(c, EmitAgentMessageSequence)]
        assert len(seq_cmds) == 0

        # Stream should still complete (hierarchy creation proceeds)
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 1

    @pytest.mark.asyncio
    async def test_final_hierarchy_completion_failure_handled(self):
        """
        If completing the final trail hierarchy in the finally block fails,
        the stream should not crash.

        Covers lines 703-704.
        """
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = MagicMock()
        coord.create_hierarchy = AsyncMock(return_value=hierarchy_data)
        coord.create_subgroup = AsyncMock(return_value=None)
        coord.update_node_status = AsyncMock()
        # complete_hierarchy fails in finally block
        coord.complete_hierarchy = AsyncMock(
            side_effect=TimeoutError("DB timeout in finally")
        )
        coord._trail_repo = MagicMock()
        coord._trail_repo.get_next_chat_sequence = AsyncMock(return_value=1)
        coord._trail_repo.get_group_by_user_message_id = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)

        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        # Should not crash
        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Code", chat_id=chat_id,
        )

        # Completion should still be emitted
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 1

    @pytest.mark.asyncio
    async def test_multi_exec_previous_subgroup_completion_error(self):
        """
        In _process_artifact_event, if completing previous subgroup fails
        during multi-execution subgroup creation, stream continues.

        Covers lines 913-914.
        """
        hierarchy = make_trail_hierarchy()

        coord = MagicMock()
        # complete_hierarchy fails for previous subgroup
        coord.complete_hierarchy = AsyncMock(
            side_effect=ConnectionError("DB lost")
        )
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=2)
        coord.update_node_status = AsyncMock()

        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()

        # Simulate: last_artifact_type was "output", now assistant sends code
        # This triggers the multi-execution subgroup check at line 879
        cmds, new_hierarchy, art_type, subgroup_created = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "y=2"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type="output",
            full_assistant_text_parts=[],
        )

        # Should not crash, should still emit artifact event
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 1
        assert art_type == "code"

    @pytest.mark.asyncio
    async def test_multi_exec_fallback_subgroup_creation_error(self):
        """
        In _process_artifact_event, if the entire multi-execution try block
        fails, stream continues.

        Covers lines 963-964.
        """
        hierarchy = make_trail_hierarchy()

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        # create_subgroup raises
        coord.create_subgroup = AsyncMock(side_effect=OSError("disk full"))
        coord._calculate_subgroup_sequence = AsyncMock(return_value=2)
        coord.update_node_status = AsyncMock()

        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()

        cmds, new_hierarchy, art_type, subgroup_created = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "y=2"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type="output",
            full_assistant_text_parts=[],
        )

        # Should not crash
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 1
        assert not subgroup_created

    @pytest.mark.asyncio
    async def test_multi_exec_flush_appended_before_new_subgroup(self):
        """
        In _process_artifact_event multi-execution flow, pending text
        should be flushed before creating new subgroup.

        Covers line 924.
        """
        hierarchy = make_trail_hierarchy()
        flush_cmd = EmitStreamEvent(event={"type": "flush_marker"})

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=2)
        coord.update_node_status = AsyncMock()

        flusher = MagicMock(spec=AssistantTextFlusher)
        flusher.flush_if_pending = AsyncMock(return_value=flush_cmd)

        repo = make_chat_repository()

        orch, _ = make_orchestrator(
            [],
            trail_coordinator=coord,
            flusher=flusher,
            chat_repository=repo,
        )
        tracker = ArtifactTracker()

        cmds, _, _, _ = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "y=2"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type="output",
            full_assistant_text_parts=["some pending text"],
        )

        # Flush should have been called exactly once
        flusher.flush_if_pending.assert_awaited_once()
        # The flush_cmd should appear in the returned commands
        assert flush_cmd in cmds


# =========================================================================
# Coverage Gap Tests: Node status update errors in trail linking +
# other artifact type + content fallback + persistence error
# Lines 1102-1103, 1133-1134, 1152-1153, 1171-1172, 1183, 1188, 1206-1207
# =========================================================================


class TestTrailLinkingErrorPaths:
    """
    Tests for error handling in trail linking section of _process_artifact_event.
    Each test makes a specific update_node_status call fail.
    """

    @pytest.mark.asyncio
    async def test_phase_transition_db_error_still_emits_commands(self):
        """
        Phase transition DB update failure should not prevent command emission.

        _emit_forward_phase_transition catches DB errors and still emits
        frontend commands so the UI updates even when the DB is unavailable.
        """
        hierarchy = make_trail_hierarchy()
        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
        coord.update_node_status = AsyncMock(
            side_effect=ConnectionError("node update failed")
        )

        orch, _ = make_orchestrator([], trail_coordinator=coord)

        cmds = await orch._emit_forward_phase_transition(
            trail_hierarchy=hierarchy,
            from_phase="writing",
            to_phase="executing",
            chat_id=hierarchy["chat_id"],
        )

        # Commands still emitted despite DB failure
        assert len(cmds) == 2
        assert cmds[0].node_id == hierarchy["writing_node_id"]
        assert cmds[0].status == "completed"
        assert cmds[1].node_id == hierarchy["executing_node_id"]
        assert cmds[1].status == "active"

    @pytest.mark.asyncio
    async def test_phase_transition_executing_to_output_db_error(self):
        """
        executing→output transition emits commands even when DB fails.
        """
        hierarchy = make_trail_hierarchy()
        coord = MagicMock()
        coord.update_node_status = AsyncMock(
            side_effect=TimeoutError("db timeout")
        )

        orch, _ = make_orchestrator([], trail_coordinator=coord)

        cmds = await orch._emit_forward_phase_transition(
            trail_hierarchy=hierarchy,
            from_phase="executing",
            to_phase="output",
            chat_id=hierarchy["chat_id"],
        )

        assert len(cmds) == 2
        assert cmds[0].node_id == hierarchy["executing_node_id"]
        assert cmds[0].status == "completed"
        assert cmds[1].node_id == hierarchy["output_node_id"]
        assert cmds[1].status == "active"

    @pytest.mark.asyncio
    async def test_computer_code_artifact_still_links_without_status_updates(self):
        """
        computer:code in artifact handler should still link artifact to
        executing node even though node status is now phase-driven.
        """
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()

        cmds, _, _, _ = await orch._process_artifact_event(
            event={"role": "computer", "type": "code", "format": "python", "content": "echo x=1"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # No node status commands (phase-driven now)
        node_cmds = [c for c in cmds if isinstance(c, EmitNodeStatusUpdated)]
        assert len(node_cmds) == 0

        # Artifact linking still works
        linked_cmds = [c for c in cmds if isinstance(c, EmitArtifactLinked)]
        assert len(linked_cmds) == 1
        assert linked_cmds[0].node_id == hierarchy["executing_node_id"]

    @pytest.mark.asyncio
    async def test_computer_output_artifact_still_links_without_status_updates(self):
        """
        computer:output in artifact handler should still link artifact to
        output node even though node status is now phase-driven.
        """
        hierarchy = make_trail_hierarchy()
        coord = make_trail_coordinator_with_hierarchy()
        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()

        cmds, _, _, _ = await orch._process_artifact_event(
            event={"role": "computer", "type": "output", "format": "text", "content": "result"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # No node status commands (phase-driven now)
        node_cmds = [c for c in cmds if isinstance(c, EmitNodeStatusUpdated)]
        assert len(node_cmds) == 0

        # Artifact linking still works
        linked_cmds = [c for c in cmds if isinstance(c, EmitArtifactLinked)]
        assert len(linked_cmds) == 1
        assert linked_cmds[0].node_id == hierarchy["output_node_id"]
        assert linked_cmds[0].artifact_type == "output"

    @pytest.mark.asyncio
    async def test_other_role_artifact_targets_writing_node(self):
        """
        Artifact events with non-standard role (not assistant code,
        not computer code, not computer output) should target writing_node.

        Covers line 1183.
        """
        hierarchy = make_trail_hierarchy()

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
        coord.update_node_status = AsyncMock()

        orch, _ = make_orchestrator([], trail_coordinator=coord)
        tracker = ArtifactTracker()

        # user:code is not assistant:code or computer:code or computer:output
        cmds, _, _, _ = await orch._process_artifact_event(
            event={"role": "user", "type": "code", "format": "python", "content": "z=3"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # Should target writing_node_id (the else branch at line 1183)
        linked_cmds = [c for c in cmds if isinstance(c, EmitArtifactLinked)]
        assert len(linked_cmds) == 1
        assert linked_cmds[0].node_id == hierarchy["writing_node_id"]

    @pytest.mark.asyncio
    async def test_empty_accumulated_parts_uses_event_content(self):
        """
        When artifact_content_parts is empty for an artifact_id,
        event.get('content') should be used instead.

        Covers line 1188.
        """
        hierarchy = make_trail_hierarchy()
        repo = make_chat_repository()

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
        coord.update_node_status = AsyncMock()

        orch, _ = make_orchestrator(
            [],
            trail_coordinator=coord,
            chat_repository=repo,
        )
        tracker = ArtifactTracker()

        cmds, _, _, _ = await orch._process_artifact_event(
            event={
                "role": "assistant", "type": "code", "format": "python",
                "content": "final_code", "end": True,
            },
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},  # Empty — no accumulated parts
            trail_hierarchy=hierarchy,
            user_msg_id=str(uuid4()),
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # create_artifact should have been called with the event's content
        repo.create_artifact.assert_awaited_once()
        call_kwargs = repo.create_artifact.call_args[1]
        assert call_kwargs["content"] == "final_code"

    @pytest.mark.asyncio
    async def test_artifact_persistence_db_error_handled(self):
        """
        If create_artifact raises, stream continues without crash.

        Covers lines 1206-1207.
        """
        hierarchy = make_trail_hierarchy()
        repo = make_chat_repository()
        repo.create_artifact = AsyncMock(side_effect=ConnectionError("DB dead"))

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
        coord.update_node_status = AsyncMock()

        orch, _ = make_orchestrator(
            [],
            trail_coordinator=coord,
            chat_repository=repo,
        )
        tracker = ArtifactTracker()

        cmds, _, _, _ = await orch._process_artifact_event(
            event={
                "role": "assistant", "type": "code", "format": "python",
                "content": "x=1", "end": True,
            },
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=str(uuid4()),
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # Should not crash, artifact event should still be emitted
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 1

        # DB persistence was attempted and failed
        repo.create_artifact.assert_awaited_once()


# =========================================================================
# Coverage Gap Tests: Artifact ID fallback generation
# Lines 997-1003, 1229-1235
# =========================================================================


class TestArtifactIdFallbackGeneration:
    """
    Tests for fallback artifact_id generation when the tracker returns None.
    """

    @pytest.mark.asyncio
    async def test_artifact_id_generated_when_tracker_returns_none(self):
        """
        When artifact_tracker.get_artifact_id returns None (after gap detection),
        a new artifact_id should be generated on-the-fly.

        Covers lines 997-1003.
        """
        hierarchy = make_trail_hierarchy()
        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
        coord.update_node_status = AsyncMock()

        orch, _ = make_orchestrator([], trail_coordinator=coord)

        # Use a tracker that has been reset (returns None for all types)
        tracker = ArtifactTracker()
        tracker.reset()

        # Process an output event - tracker was just reset, so get_artifact_id
        # returns None, triggering the fallback at lines 996-1006
        cmds, _, art_type, _ = await orch._process_artifact_event(
            event={"role": "computer", "type": "output", "format": "text", "content": "result"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # A stream event should be emitted with a valid artifact_id
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 1
        assert stream_events[0].event.get("artifact_id") is not None


# =========================================================================
# Coverage Gap Tests: Flush before trail creation, flush in finalization,
# background task cancelled, artifact subgroup cycle flag
# Lines 349, 674, 592, 1397
# =========================================================================


class TestFlushAndBackgroundTaskCoverage:
    """
    Tests covering specific flush and background task branches.
    """

    @pytest.mark.asyncio
    async def test_flush_yielded_before_trail_creation(self):
        """
        If flush_if_pending returns a command during pre-trail setup,
        it should be yielded to the caller.

        Covers line 349.
        """
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        flush_event = EmitStreamEvent(event={"type": "flush_before_trail"})
        flusher = MagicMock(spec=AssistantTextFlusher)
        flusher.flush_if_pending = AsyncMock(return_value=flush_event)

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_hierarchy = AsyncMock(return_value=hierarchy_data)
        coord.create_subgroup = AsyncMock(return_value=None)
        coord.update_node_status = AsyncMock()
        coord._trail_repo = MagicMock()
        coord._trail_repo.get_next_chat_sequence = AsyncMock(return_value=1)
        coord._trail_repo.get_group_by_user_message_id = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)

        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
            flusher=flusher,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Flush test", chat_id=chat_id,
        )

        # The flush command should appear in the yielded commands
        assert flush_event in commands

    @pytest.mark.asyncio
    async def test_flush_logging_in_finalization(self):
        """
        If flush_if_pending returns a command in the finally block,
        the success log should fire.

        Covers line 674.
        """
        chat_id = str(uuid4())
        msg_id = uuid4()
        flush_event = EmitStreamEvent(event={"type": "final_flush"})

        flusher = MagicMock(spec=AssistantTextFlusher)
        flusher.flush_if_pending = AsyncMock(return_value=flush_event)

        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "message", "content": "Hello"},
        ]
        orch, _ = make_orchestrator(
            events,
            persister=persister,
            flusher=flusher,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="Flush fin", chat_id=chat_id,
        )

        # Flusher should have been called exactly once
        flusher.flush_if_pending.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cancelled_background_task_handled(self):
        """
        Background task that is cancelled should be handled gracefully
        in the _on_done callback without logging an exception.

        Covers line 1397.
        """
        orch, _ = make_orchestrator([])

        # Create a task that we'll cancel
        async def noop():
            await asyncio.sleep(100)

        task = asyncio.create_task(noop())
        orch._track_background_task(task)

        assert task in orch._background_tasks

        # Cancel the task
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        # After cancellation callback fires, task should be discarded
        # Give event loop a tick to process the callback
        await asyncio.sleep(0)
        assert task not in orch._background_tasks

    @pytest.mark.asyncio
    async def test_artifact_subgroup_creation_sets_cycle_flag(self):
        """
        When _process_artifact_event creates a subgroup (returns
        subgroup_created=True), the subgroup_created_for_cycle flag
        should be set in the main loop.

        Covers line 592.
        """
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)
        new_subgroup = make_trail_hierarchy(
            chat_id=chat_id,
            group_id=hierarchy_data["group_id"],
        )

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_hierarchy = AsyncMock(return_value=hierarchy_data)
        # create_subgroup returns data (triggers subgroup_created=True in _process_artifact_event)
        coord.create_subgroup = AsyncMock(return_value=new_subgroup)
        coord.update_node_status = AsyncMock()
        coord._trail_repo = MagicMock()
        coord._trail_repo.get_next_chat_sequence = AsyncMock(return_value=1)
        coord._trail_repo.get_group_by_user_message_id = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=2)

        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            # First code event: CASE 1 creates hierarchy
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            # Output event (sets last_artifact_type="output")
            {"role": "computer", "type": "output", "format": "text", "content": "result"},
            # Second code as artifact (triggers multi-exec subgroup in _process_artifact_event)
            {"role": "assistant", "type": "code", "format": "python", "content": "y=2"},
            # Third code event should NOT trigger CASE 2 because cycle flag was set
            {"role": "assistant", "type": "code", "format": "python", "content": "z=3"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="cycle flag test", chat_id=chat_id,
        )

        # The stream should complete without errors
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 1


# =========================================================================
# Final Coverage Gap Tests — 14 remaining missed lines
# Lines: 481, 559, 592, 605-606, 703-704, 997-1003, 1188, 1229-1235
# =========================================================================


class TestFinalCoverageGaps:
    """Tests covering the last 14 missed lines for 100% statement coverage."""

    # ----- relay_stream level: line 481 -----

    @pytest.mark.asyncio
    async def test_case2_flush_cmd_yielded(self):
        """
        Line 481: yield flush_cmd in CASE 2 code cycling.

        When relay_stream enters CASE 2 (active trail hierarchy + new code
        cycle with phase_changed=True), flush_if_pending returning a truthy
        command must be yielded to the consumer.

        Sequence: code(CASE 1) -> output -> code(CASE 2 with flush)
        """
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)
        new_subgroup = make_trail_hierarchy(
            chat_id=chat_id,
            group_id=hierarchy_data["group_id"],
        )

        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_hierarchy = AsyncMock(return_value=hierarchy_data)
        coord.create_subgroup = AsyncMock(return_value=new_subgroup)
        coord.update_node_status = AsyncMock()
        coord._trail_repo = MagicMock()
        coord._trail_repo.get_next_chat_sequence = AsyncMock(return_value=1)
        coord._trail_repo.get_group_by_user_message_id = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=2)

        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        flush_event = EmitStreamEvent(event={"type": "case2_flush"})
        flusher = MagicMock(spec=AssistantTextFlusher)
        # Call order: CASE 1 (line 343), CASE 2 (line 475), finally (line 668)
        flusher.flush_if_pending = AsyncMock(
            side_effect=[None, flush_event, None]
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            {"role": "computer", "type": "output", "format": "text", "content": "result"},
            {"role": "assistant", "type": "code", "format": "python", "content": "y=2"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
            flusher=flusher,
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="flush case2", chat_id=chat_id,
        )

        # The CASE 2 flush command must appear in yielded commands
        assert flush_event in commands
        # Flusher was called exactly 3 times (CASE 1, CASE 2, finally)
        assert flusher.flush_if_pending.await_count == 3

    # ----- relay_stream level: line 559 -----

    @pytest.mark.asyncio
    async def test_content_delta_subgroup_sets_trail_hierarchy(self):
        """
        Line 559: trail_hierarchy set from EmitSubgroupCreated in content delta.

        Defensive code: _handle_content_delta currently only returns
        EmitStreamEvent, never EmitSubgroupCreated. This tests the guard
        by monkeypatching the method to return an EmitSubgroupCreated.
        """
        chat_id = str(uuid4())

        subgroup_cmd = EmitSubgroupCreated(
            chat_id=chat_id,
            subgroup_id="sg-1",
            group_id="grp-1",
            execution_group="exec_1",
            writing_node_id="w-1",
            executing_node_id="e-1",
            output_node_id="o-1",
            backend_id="r1",
            subgroup_sequence_number=1,
            sequence_in_chat=1,
        )

        events = [
            {"role": "assistant", "type": "message", "content": "Hello"},
        ]
        orch, _ = make_orchestrator(events)

        # Monkeypatch to return EmitSubgroupCreated from content delta
        orch._handle_content_delta = AsyncMock(return_value=[subgroup_cmd])
        # Prevent _complete_trail_hierarchy from failing on the mock hierarchy
        orch._complete_trail_hierarchy = AsyncMock(return_value=[])

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="delta subgroup", chat_id=chat_id,
        )

        # EmitSubgroupCreated should be yielded
        assert subgroup_cmd in commands
        # _complete_trail_hierarchy was called (trail_hierarchy was set)
        orch._complete_trail_hierarchy.assert_awaited_once()

    # ----- relay_stream level: line 592 -----

    @pytest.mark.asyncio
    async def test_artifact_subgroup_created_sets_cycle_flag(self):
        """
        Line 592: subgroup_created_for_cycle = True from _process_artifact_event.

        Defensive code: in normal relay_stream flow, CASE 2 always preempts
        _process_artifact_event's multi-execution subgroup creation. This tests
        the guard by monkeypatching _process_artifact_event to return
        subgroup_created=True.
        """
        # Use an output event: output phase doesn't trigger CASE 1/2
        events = [
            {"role": "computer", "type": "output", "format": "text", "content": "result"},
        ]
        orch, _ = make_orchestrator(events)

        # Monkeypatch _process_artifact_event to return subgroup_created=True
        orch._process_artifact_event = AsyncMock(
            return_value=([], None, "output", True)
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="artifact subgroup flag",
        )

        # _process_artifact_event was called and returned subgroup_created=True
        orch._process_artifact_event.assert_awaited_once()
        # Stream completes without error
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 1

    # ----- relay_stream level: lines 605-606 -----

    @pytest.mark.asyncio
    async def test_end_marker_artifact_type_normalization(self):
        """
        Lines 605-606: normalize_artifact_type + get_artifact_id in end marker.

        Defensive code: artifact-type events are caught by the artifact handling
        block (line 573) before reaching the end marker block. This tests the
        guard by patching is_artifact_type at the module level.
        """
        events = [
            # message end event bypasses artifact block but reaches end marker
            {"role": "assistant", "type": "message", "end": True},
        ]
        orch, _ = make_orchestrator(events)

        with patch(
            "ws.application.stream_orchestrator.is_artifact_type",
            return_value=True,
        ):
            commands = await collect_commands(orch,
                client_id="c1", request_id="r1", frontend_id="f1",
                text="end marker artifact",
            )

        # An EmitStreamEnd should be yielded for the end marker
        ends = [c for c in commands if isinstance(c, EmitStreamEnd)]
        assert len(ends) >= 1

    # ----- relay_stream level: lines 703-704 -----

    @pytest.mark.asyncio
    async def test_final_trail_completion_error_caught(self):
        """
        Lines 703-704: except handler for final trail hierarchy completion.

        When _complete_trail_hierarchy raises a covered exception during
        finalization, the error is caught and logged (not propagated).
        """
        chat_id = str(uuid4())
        msg_id = uuid4()
        hierarchy_data = make_trail_hierarchy(chat_id=chat_id)

        coord = make_trail_coordinator_with_hierarchy(hierarchy_data=hierarchy_data)
        repo = make_chat_repository()
        persister = MagicMock(spec=UserMessagePersister)
        persister.persist_user_message = AsyncMock(
            return_value=PersistResult(user_msg_id=msg_id)
        )

        events = [
            {"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
        ]
        orch, _ = make_orchestrator(
            events,
            trail_coordinator=coord,
            chat_repository=repo,
            persister=persister,
        )

        # Monkeypatch _complete_trail_hierarchy to raise ConnectionError
        orch._complete_trail_hierarchy = AsyncMock(
            side_effect=ConnectionError("DB unreachable")
        )

        commands = await collect_commands(orch,
            client_id="c1", request_id="r1", frontend_id="f1",
            text="trail error test", chat_id=chat_id,
        )

        # Stream should still complete (error caught, not propagated)
        completions = [c for c in commands if isinstance(c, EmitStreamCompletion)]
        assert len(completions) == 1
        # _complete_trail_hierarchy was called and raised
        orch._complete_trail_hierarchy.assert_awaited_once()

    # ----- _process_artifact_event level: lines 997-1003 -----

    @pytest.mark.asyncio
    async def test_artifact_id_fallback_generation(self):
        """
        Lines 997-1003: fallback artifact_id generation in _process_artifact_event.

        Defensive code: normally lines 862-875 always store an artifact_id before
        line 992, making the fallback unreachable. This tests with a mock tracker
        that has the type but returns None for get_artifact_id.
        """
        hierarchy = make_trail_hierarchy()
        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
        coord.update_node_status = AsyncMock()

        orch, _ = make_orchestrator([], trail_coordinator=coord)

        # Mock tracker: has the type (skip 862-875) but returns None (trigger 997-1003)
        tracker = MagicMock(spec=ArtifactTracker)
        tracker.has_artifact_type.return_value = True
        tracker.get_artifact_id.return_value = None
        tracker.is_already_linked.return_value = False
        tracker.store_artifact_id = MagicMock()
        tracker.mark_as_linked = MagicMock()

        cmds, _, art_type, _ = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=tracker,
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=None,
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # Fallback at lines 997-1003 should have generated and stored an artifact_id
        assert tracker.store_artifact_id.called
        # A stream event should be emitted with a valid artifact_id
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 1
        assert stream_events[0].event.get("artifact_id") is not None

    # ----- _process_artifact_event level: line 1188 -----

    @pytest.mark.asyncio
    async def test_artifact_content_fallback_from_event(self):
        """
        Line 1188: artifact_content fallback to event.get("content").

        When accumulated artifact_content_parts is empty for an artifact_id,
        the code falls back to event.get("content") for persistence.
        """
        hierarchy = make_trail_hierarchy()
        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
        coord.update_node_status = AsyncMock()
        repo = make_chat_repository()

        orch, _ = make_orchestrator(
            [], trail_coordinator=coord, chat_repository=repo,
        )

        # Event with empty content (falsy) triggers the fallback at line 1188
        # content="" is falsy, so not accumulated at line 1010, but line 1188 evaluates it
        cmds, _, _, _ = await orch._process_artifact_event(
            event={"role": "assistant", "type": "code", "format": "python", "content": "", "end": True},
            sequence=1,
            request_id="r1",
            frontend_id=None,
            correlation_id=None,
            chat_id=hierarchy["chat_id"],
            artifact_tracker=ArtifactTracker(),
            artifact_counters={},
            artifact_content_parts={},
            trail_hierarchy=hierarchy,
            user_msg_id=str(uuid4()),
            last_artifact_type=None,
            full_assistant_text_parts=[],
        )

        # Stream event emitted (line 1188 executed during trail linking)
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 1
        # create_artifact was NOT called because content="" → cleaned to None
        repo.create_artifact.assert_not_awaited()

    # ----- _process_artifact_event level: lines 1229-1235 -----

    @pytest.mark.asyncio
    async def test_artifact_id_for_event_fallback_generation(self):
        """
        Lines 1229-1235: fallback artifact_id_for_event generation.

        Defensive code: artifact_id at line 1224 is always truthy in normal flow
        because lines 997-1003 ensure it. This tests with generate_artifact_id
        patched to return "" (falsy) for the first call, then a real ID for the
        second call (the fallback at line 1230).
        """
        hierarchy = make_trail_hierarchy()
        coord = MagicMock()
        coord.complete_hierarchy = AsyncMock()
        coord.create_subgroup = AsyncMock(return_value=None)
        coord._calculate_subgroup_sequence = AsyncMock(return_value=1)
        coord.update_node_status = AsyncMock()

        orch, _ = make_orchestrator([], trail_coordinator=coord)

        # Mock tracker: has type but returns None for get_artifact_id
        tracker = MagicMock(spec=ArtifactTracker)
        tracker.has_artifact_type.return_value = True
        tracker.get_artifact_id.return_value = None
        tracker.is_already_linked.return_value = False
        tracker.store_artifact_id = MagicMock()
        tracker.mark_as_linked = MagicMock()

        # generate_artifact_id: first call returns "" (falsy), second returns real ID
        with patch(
            "ws.application.stream_orchestrator.generate_artifact_id",
            side_effect=["", "art-fallback-1"],
        ):
            cmds, _, _, _ = await orch._process_artifact_event(
                event={"role": "assistant", "type": "code", "format": "python", "content": "x=1"},
                sequence=1,
                request_id="r1",
                frontend_id=None,
                correlation_id=None,
                chat_id=hierarchy["chat_id"],
                artifact_tracker=tracker,
                artifact_counters={},
                artifact_content_parts={},
                trail_hierarchy=hierarchy,
                user_msg_id=None,
                last_artifact_type=None,
                full_assistant_text_parts=[],
            )

        # The fallback at 1229-1235 should have stored the real artifact ID
        store_calls = tracker.store_artifact_id.call_args_list
        assert len(store_calls) == 2  # line 1003 (stores "") + line 1235 (stores real)
        # Second store_artifact_id call should contain the fallback ID
        second_call_kwargs = store_calls[1]
        assert second_call_kwargs == (
            (), {"event_type": "code", "artifact_id": "art-fallback-1"}
        )
        # Stream event with the fallback artifact_id
        stream_events = [c for c in cmds if isinstance(c, EmitStreamEvent)]
        assert len(stream_events) == 1
        assert stream_events[0].event.get("artifact_id") == "art-fallback-1"
