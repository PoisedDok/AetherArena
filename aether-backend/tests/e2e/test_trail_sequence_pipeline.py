"""
E2E Tests: Trail Sequence Pipeline

Validates sequence ordering between assistant flush and trail creation.
"""

import os
import uuid

import pytest
import pytest_asyncio

from ws.application.stream_orchestrator import StreamOrchestrator
from ws.application.cache_service import CacheService
from ws.infrastructure.cache.memory_fallback import MemoryFallbackCache
from ws.application.trail_coordinator import TrailCoordinator
from ws.infrastructure.persistence.trail_repository_adapter import TrailRepositoryAdapter
from ws.domain.commands.trail_commands import EmitAssistantMessageFlushed, EmitSubgroupCreated

from config.settings import get_settings
from data.database.clients.supabase import SupabaseClient, SUPABASE_AVAILABLE
from data.database.persistence_gateway import SupabasePersistenceGateway
from data.database.repositories.chat import ChatRepository
from data.database.repositories.trail import TrailRepository


class DeterministicRuntime:
    def __init__(self, events):
        self._events = events
        self.stop_calls = []

    async def stream_chat(self, **kwargs):
        for event in self._events:
            yield event

    async def stop_generation(self, request_id: str) -> None:
        self.stop_calls.append(request_id)


@pytest_asyncio.fixture
async def supabase_gateway(requires_supabase):
    if not SUPABASE_AVAILABLE:
        pytest.skip("Supabase SDK not available for gateway tests")
    runtime_settings = get_settings()
    settings = {"url": runtime_settings.supabase.url}
    anon_key = os.getenv("SUPABASE_ANON_KEY") or runtime_settings.supabase.anon_key
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or runtime_settings.supabase.service_role_key
    if anon_key:
        settings["anon_key"] = anon_key
    if service_role_key:
        settings["service_role_key"] = service_role_key
    client = SupabaseClient.from_env(settings)
    try:
        await client.initialize()
    except RuntimeError as e:
        pytest.skip(f"Supabase connection failed: {e}")
    from data.database.migration_runner import run_migrations
    migrations_ok = await run_migrations()
    if not migrations_ok:
        pytest.fail("Supabase migrations failed to apply before e2e tests")
    gateway = SupabasePersistenceGateway(client)
    yield gateway
    await client.dispose()


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_assistant_flush_precedes_trail_sequence(
    supabase_gateway,
    requires_supabase,
):
    chat_id = str(uuid.uuid4())
    correlation_id = str(uuid.uuid4())
    request_id = str(uuid.uuid4())

    runtime_events = [
        {"role": "assistant", "type": "message", "start": True},
        {"role": "assistant", "type": "message", "content": "Intro before code."},
        {"role": "assistant", "type": "code", "format": "python", "content": "print('hi')"},
        {"role": "computer", "type": "output", "format": "console", "content": "hi"},
        {"role": "computer", "type": "output", "format": "text", "content": "done"},
        {"role": "assistant", "type": "message", "end": True},
    ]

    chat_repo = ChatRepository(supabase_gateway)
    await chat_repo.ensure_chat_exists(uuid.UUID(chat_id))
    trail_repo = TrailRepository(supabase_gateway)
    trail_adapter = TrailRepositoryAdapter(trail_repo)
    trail_coordinator = TrailCoordinator(trail_repository_adapter=trail_adapter)
    cache_service = CacheService(cache_adapter=MemoryFallbackCache())

    orchestrator = StreamOrchestrator(
        runtime=DeterministicRuntime(runtime_events),
        trail_coordinator=trail_coordinator,
        cache_service=cache_service,
        chat_repository=chat_repo,
    )

    commands = []
    async for command in orchestrator.relay_stream(
        client_id="e2e-client",
        request_id=request_id,
        frontend_id="frontend-id",
        text="Generate code",
        original_text="Generate code",
        correlation_id=correlation_id,
        chat_id=chat_id,
    ):
        commands.append(command)

    flush_events = [c for c in commands if isinstance(c, EmitAssistantMessageFlushed)]
    subgroup_events = [c for c in commands if isinstance(c, EmitSubgroupCreated)]

    assert flush_events, "Expected assistant message flush event"
    assert subgroup_events, "Expected trail subgroup creation event"

    flush_sequence = flush_events[0].sequence_in_chat
    trail_sequence = subgroup_events[0].sequence_in_chat
    assert flush_sequence < trail_sequence

    messages = await supabase_gateway.select(
        "messages",
        filters={"chat_id": chat_id},
        order_by="sequence_in_chat",
        admin=True,
    )
    assert messages, "Expected persisted messages"
    sequences = [msg.get("sequence_in_chat") for msg in messages if msg.get("sequence_in_chat") is not None]
    assert sequences == sorted(sequences)

    await chat_repo.delete_chat(uuid.UUID(chat_id))


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_multiple_flushes_follow_sequence_order(
    supabase_gateway,
    requires_supabase,
):
    chat_id = str(uuid.uuid4())
    correlation_id = str(uuid.uuid4())
    request_id = str(uuid.uuid4())

    runtime_events = [
        {"role": "assistant", "type": "message", "start": True},
        {"role": "assistant", "type": "message", "content": "Segment before first code."},
        {"role": "assistant", "type": "code", "format": "python", "content": "print('one')"},
        {"role": "computer", "type": "output", "format": "console", "content": "one"},
        {"role": "computer", "type": "output", "format": "text", "content": "done one"},
        {"role": "assistant", "type": "message", "content": "Segment before second code."},
        {"role": "assistant", "type": "code", "format": "python", "content": "print('two')"},
        {"role": "computer", "type": "output", "format": "console", "content": "two"},
        {"role": "computer", "type": "output", "format": "text", "content": "done two"},
        {"role": "assistant", "type": "message", "end": True},
    ]

    chat_repo = ChatRepository(supabase_gateway)
    await chat_repo.ensure_chat_exists(uuid.UUID(chat_id))
    trail_repo = TrailRepository(supabase_gateway)
    trail_adapter = TrailRepositoryAdapter(trail_repo)
    trail_coordinator = TrailCoordinator(trail_repository_adapter=trail_adapter)
    cache_service = CacheService(cache_adapter=MemoryFallbackCache())

    orchestrator = StreamOrchestrator(
        runtime=DeterministicRuntime(runtime_events),
        trail_coordinator=trail_coordinator,
        cache_service=cache_service,
        chat_repository=chat_repo,
    )

    commands = []
    async for command in orchestrator.relay_stream(
        client_id="e2e-client",
        request_id=request_id,
        frontend_id="frontend-id",
        text="Generate code twice",
        original_text="Generate code twice",
        correlation_id=correlation_id,
        chat_id=chat_id,
    ):
        commands.append(command)

    flush_events = [c for c in commands if isinstance(c, EmitAssistantMessageFlushed)]
    subgroup_events = [c for c in commands if isinstance(c, EmitSubgroupCreated)]

    assert len(flush_events) == 2
    assert len(subgroup_events) == 2

    flush_sequences = [event.sequence_in_chat for event in flush_events]
    subgroup_sequences = [event.sequence_in_chat for event in subgroup_events]

    assert flush_sequences == sorted(flush_sequences)
    assert subgroup_sequences == sorted(subgroup_sequences)

    for flush_seq, subgroup_seq in zip(flush_sequences, subgroup_sequences):
        assert flush_seq < subgroup_seq

    await chat_repo.delete_chat(uuid.UUID(chat_id))
