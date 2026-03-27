"""
E2E Tests: Memory Pipeline

Validates create, fetch, search, and delete flows.
"""

import os

import pytest
import pytest_asyncio
from httpx import AsyncClient

from tests.e2e.helpers.http_wait import wait_for_endpoint


@pytest_asyncio.fixture
async def real_client():
    base_url = os.getenv("AETHER_E2E_BASE_URL", "http://127.0.0.1:8765")
    async with AsyncClient(base_url=base_url, timeout=60.0) as client:
        status = await wait_for_endpoint(client, "/v1/health")
        if status != 200:
            pytest.skip(f"Backend not reachable at {base_url}")
        yield client


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_memory_create_search_delete(real_client: AsyncClient, requires_embeddings):
    create_payload = {
        "content": "E2E memory: Important contract deadline is June 1.",
        "memory_type": "fact",
        "importance_score": 0.8,
        "metadata": {"source": "e2e-test"},
        "created_by": "user"
    }
    create_resp = await real_client.post("/v1/memory/create", json=create_payload)
    assert create_resp.status_code == 201
    memory = create_resp.json()
    memory_id = memory.get("id")
    assert memory_id

    get_resp = await real_client.get(f"/v1/memory/get/{memory_id}")
    assert get_resp.status_code == 200

    search_payload = {
        "query": "contract deadline June 1",
        "search_type": "vector",
        "match_count": 5
    }
    search_resp = await real_client.post("/v1/search/memories", json=search_payload)
    assert search_resp.status_code == 200
    search_body = search_resp.json()
    assert search_body.get("total", 0) >= 1

    delete_resp = await real_client.delete(f"/v1/memory/delete/{memory_id}")
    assert delete_resp.status_code == 204
