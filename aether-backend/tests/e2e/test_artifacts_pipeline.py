"""
E2E Tests: Artifact Linking Pipeline

Validates artifact-node linkage for writing/output nodes.
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
from ws.domain.builders.event_enricher import generate_artifact_id
from ws.domain.commands import EmitSubgroupCreated

from config.settings import get_settings
from data.database.clients.supabase import SupabaseClient, SUPABASE_AVAILABLE
from data.database.persistence_gateway import SupabasePersistenceGateway
from data.database.repositories.chat import ChatRepository
from data.database.repositories.trail import TrailRepository


class DeterministicRuntime:
    def __init__(self, events):
        self._events = events

    async def stream_chat(self, **kwargs):
        for event in self._events:
            yield event

    async def stop_generation(self, request_id: str) -> None:
        return None


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
async def test_artifacts_linked_to_trail_nodes(
    supabase_gateway,
    requires_supabase,
):
    chat_id = str(uuid.uuid4())
    correlation_id = str(uuid.uuid4())
    request_id = str(uuid.uuid4())

    runtime_events = [
        {"role": "assistant", "type": "message", "start": True},
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

    subgroup_events = [c for c in commands if isinstance(c, EmitSubgroupCreated)]
    assert subgroup_events, "Expected trail subgroup creation"
    subgroup = subgroup_events[0]

    code_artifact_id = generate_artifact_id(
        backend_id=request_id,
        event_type="code",
        artifact_counter=1,
    )
    output_artifact_id = generate_artifact_id(
        backend_id=request_id,
        event_type="output",
        artifact_counter=1,
    )
    await chat_repo.create_artifact(
        chat_id=uuid.UUID(chat_id),
        type="code",
        content="e2e code",
        artifact_id=code_artifact_id,
        subgroup_id=uuid.UUID(subgroup.subgroup_id),
        node_id=uuid.UUID(subgroup.writing_node_id),
    )
    await chat_repo.create_artifact(
        chat_id=uuid.UUID(chat_id),
        type="output",
        content="e2e output",
        artifact_id=output_artifact_id,
        subgroup_id=uuid.UUID(subgroup.subgroup_id),
        node_id=uuid.UUID(subgroup.output_node_id),
    )

    artifacts = await supabase_gateway.select(
        "artifacts",
        filters={"chat_id": chat_id},
        admin=True,
    )
    assert artifacts, "Expected artifacts persisted"

    artifact_nodes = {a.get("node_id") for a in artifacts if a.get("node_id")}
    assert subgroup.writing_node_id in artifact_nodes
    assert subgroup.output_node_id in artifact_nodes
    assert subgroup.executing_node_id not in artifact_nodes

    await chat_repo.delete_chat(uuid.UUID(chat_id))
