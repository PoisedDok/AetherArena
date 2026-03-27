"""
E2E Tests: Chat Real Pipeline

Validates chat endpoints against running backend.
"""

import os

import pytest
import pytest_asyncio
from httpx import AsyncClient

from config.settings import get_settings
from tests.e2e.helpers.http_wait import wait_for_endpoint


@pytest_asyncio.fixture
async def real_client():
    base_url = os.getenv("AETHER_E2E_BASE_URL", "http://127.0.0.1:8765")
    settings = get_settings()
    llm_timeout = getattr(getattr(settings, "http_client", None), "llm_timeout", 60.0)
    # E2E chat tests need extra time for per-chat OI spawn (2-5s) + LLM inference (10-60s)
    # Increase timeout to 120s to account for full round-trip with per-chat isolation
    timeout_seconds = max(120.0, float(llm_timeout))
    async with AsyncClient(base_url=base_url, timeout=timeout_seconds) as client:
        status = await wait_for_endpoint(client, "/v1/health")
        if status != 200:
            pytest.skip(f"Backend not reachable at {base_url}")
        yield client


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
@pytest.mark.timeout(300)  # 5 min: cold OI spawn + LLM inference on local hardware
async def test_chat_round_trip(real_client: AsyncClient):
    payload = {"message": "Say hello in one sentence.", "session_id": "e2e-real-chat-1"}
    response = await real_client.post("/v1/create/chat", json=payload)
    assert response.status_code in [200, 201]

    history = await real_client.get("/v1/chat/history/e2e-real-chat-1")
    assert history.status_code == 200
