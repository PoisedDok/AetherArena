import pytest
from unittest.mock import AsyncMock


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stop_generation_route_exists_and_calls_runtime(client, mock_runtime_engine):
    """
    Regression test:
    - Stop-generation endpoint is `/v1/stop-generation` (route must exist; avoid /v1/chat/... confusion).
    - Handler must delegate to RuntimeEngine.stop_generation(request_id).
    """
    mock_runtime_engine.stop_generation = AsyncMock(return_value=None)

    resp = await client.post("/v1/stop-generation", json={"request_id": "req-1"})

    assert resp.status_code == 200
    payload = resp.json()
    assert payload.get("status") == "ok"
    mock_runtime_engine.stop_generation.assert_awaited_once_with("req-1")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_runtime_coordinator_stop_generation_passes_chat_id():
    """
    Regression test:
    stop_generation must stop the correct chat-scoped interpreter instance.
    This requires request_id -> chat_id mapping to survive up to interpreter stop.
    """
    from core.runtime.coordinator import RuntimeCoordinator
    from core.runtime.request import RequestTracker

    class FakeSessionManager:
        def __init__(self, tracker):
            self._tracker = tracker

        @property
        def request_tracker(self):
            return self._tracker

        async def cancel_request(self, request_id: str) -> bool:
            return await self._tracker.cancel_request(request_id)

    tracker = RequestTracker()
    await tracker.start_request("req-2", client_id="client-1", text="hi", chat_id="chat-123")

    coordinator = RuntimeCoordinator(settings=object())
    coordinator._session_manager = FakeSessionManager(tracker)  # type: ignore[attr-defined]
    coordinator._config_manager = None  # type: ignore[attr-defined]
    adapter = AsyncMock()
    coordinator._interpreter_adapter = adapter  # type: ignore[attr-defined]

    await coordinator.stop_generation("req-2")

    adapter.stop_generation.assert_awaited_once()
    _, kwargs = adapter.stop_generation.await_args
    assert kwargs.get("chat_id") == "chat-123"
