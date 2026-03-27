import pytest
from fastapi import FastAPI
from httpx import AsyncClient


@pytest.mark.unit
@pytest.mark.asyncio
async def test_update_artifact_message_id_noop_returns_zero(app: FastAPI, client: AsyncClient, monkeypatch):
    """
    When repository returns no updated artifacts, the endpoint should respond 200
    with updated_count=0 and success=True, without raising.
    """
    from api.dependencies import get_chat_service

    class FakeService:
        async def update_artifact_message_id(self, artifact_id, message_id):
            # Simulate strict backend behavior: nothing matched this id
            return []

    app.dependency_overrides[get_chat_service] = lambda: FakeService()

    payload = {
        "artifact_id": "nonexistent_artifact_foo",
        "message_id": "650e8400-e29b-41d4-a716-446655440001"
    }

    resp = await client.put("/v1/storage/artifact/link-message", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    assert body["updated_count"] == 0
    assert body["artifact_id"] == payload["artifact_id"]
    assert body["message_id"] == payload["message_id"]

    # Cleanup override
    app.dependency_overrides.pop(get_chat_service, None)


