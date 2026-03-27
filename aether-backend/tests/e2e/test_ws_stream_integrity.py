"""
E2E Tests: WebSocket Stream Integrity

Validates monotonic sequence ordering and end marker delivery.
"""

import uuid

import pytest

from ws.application.stream_orchestrator import StreamOrchestrator
from ws.application.cache_service import CacheService
from ws.infrastructure.cache.memory_fallback import MemoryFallbackCache
from ws.application.trail_coordinator import TrailCoordinator
from ws.infrastructure.persistence.trail_repository_adapter import TrailRepositoryAdapter
from ws.domain.commands.stream_commands import (
    EmitStreamEvent,
    EmitStreamEnd,
    EmitStreamCompletion,
    EmitControlEvent,
)

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


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_ws_stream_sequence_monotonic(supabase_gateway, requires_supabase):
    chat_id = str(uuid.uuid4())
    correlation_id = str(uuid.uuid4())
    request_id = str(uuid.uuid4())

    runtime_events = [
        {"role": "assistant", "type": "message", "start": True},
        {"role": "assistant", "type": "message", "content": "E2E stream integrity check."},
        {"role": "assistant", "type": "code", "format": "python", "content": "print('ok')"},
        {"role": "computer", "type": "output", "format": "console", "content": "ok"},
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

    sequences = []
    end_seen = False
    async for command in orchestrator.relay_stream(
        client_id="e2e-client",
        request_id=request_id,
        frontend_id="frontend-id",
        text="Generate code",
        original_text="Generate code",
        correlation_id=correlation_id,
        chat_id=chat_id,
    ):
        payload = None
        if isinstance(command, EmitStreamEvent):
            payload = command.event
        elif isinstance(command, EmitStreamEnd):
            payload = command.end_message
        elif isinstance(command, EmitStreamCompletion):
            payload = command.completion_message
        elif isinstance(command, EmitControlEvent):
            payload = command.event

        if payload:
            if "sequence" in payload:
                sequences.append(payload["sequence"])
            if payload.get("end") is True:
                end_seen = True

    ordered = [seq for seq in sequences if isinstance(seq, int)]
    assert ordered == sorted(ordered)
    assert end_seen