"""
E2E Tests: Research Pipeline

Validates fast (Searxng) and AI (Perplexica) research modes.
"""

import os

import pytest
import pytest_asyncio
from httpx import AsyncClient

from tests.e2e.helpers.http_wait import wait_for_endpoint


@pytest_asyncio.fixture
async def real_client():
    base_url = os.getenv("AETHER_E2E_BASE_URL", "http://127.0.0.1:8765")
    async with AsyncClient(base_url=base_url, timeout=180.0) as client:
        status = await wait_for_endpoint(client, "/v1/health")
        if status != 200:
            pytest.skip(f"Backend not reachable at {base_url}")
        yield client


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.asyncio
async def test_research_fast_mode(real_client: AsyncClient, requires_searxng):
    payload = {
        "query": "latest AI research trends",
        "sources": ["web"],
        "ai_mode": False,
        "max_results": 3
    }
    resp = await real_client.post("/v1/search/research", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("ai_mode") is False
    assert "results" in body


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.asyncio
async def test_search_web_fast_endpoint(real_client: AsyncClient, requires_searxng):
    resp = await real_client.post("/v1/search/web", json={"query": "test", "mode": "fast"})
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("query") == "test"
    assert isinstance(body.get("results"), list)


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_research_ai_mode(real_client: AsyncClient, requires_perplexica):
    payload = {
        "query": "recent legal AI developments",
        "sources": ["web"],
        "ai_mode": True,
        "optimization_mode": "speed",
        "max_results": 1,
    }
    resp = await real_client.post("/v1/search/research", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("ai_mode") is True
    assert "results" in body
