"""
E2E Tests: Embedding Service Pipeline

Validates the embedding service hosted inside Perplexica's Docker container
(ONNX via @huggingface/transformers).  Endpoint: POST /api/embeddings (OpenAI-compatible).
"""

import os

import pytest
import pytest_asyncio
from httpx import AsyncClient


@pytest_asyncio.fixture
async def embedding_client(requires_embeddings):
    # follow_redirects=True: Next.js normalises trailing slashes with 308;
    # httpx base_url + empty path produces a trailing slash that triggers this.
    async with AsyncClient(
        base_url=requires_embeddings, timeout=30.0, follow_redirects=True
    ) as client:
        yield client


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.asyncio
async def test_embedding_service_health(embedding_client: AsyncClient):
    """GET /api/embeddings returns health/info when embedding service is up."""
    resp = await embedding_client.get("")
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("status") == "healthy"
    assert body.get("model_loaded") is True


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.asyncio
async def test_embedding_service_single(embedding_client: AsyncClient):
    """POST /api/embeddings with OpenAI format returns a valid embedding vector."""
    payload = {"input": "E2E embeddings check", "model": "Xenova/bge-small-en-v1.5"}
    resp = await embedding_client.post("", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert "data" in body
    assert len(body["data"]) == 1
    assert isinstance(body["data"][0]["embedding"], list)
    assert len(body["data"][0]["embedding"]) == 384  # bge-small dimensions


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_embeddings_roundtrip_index_search(requires_embeddings):
    base_url = os.getenv("AETHER_E2E_BASE_URL", "http://127.0.0.1:8765")
    async with AsyncClient(base_url=base_url, timeout=60.0) as client:
        health = await client.get("/v1/health")
        if health.status_code != 200:
            pytest.skip(f"Backend not healthy at {base_url}")

        indexes_resp = await client.get("/v1/index/list")
        if indexes_resp.status_code == 503:
            pytest.skip("Indexing repository unavailable")
        assert indexes_resp.status_code == 200
        indexes = indexes_resp.json().get("indexes", [])
        if not indexes:
            pytest.skip("No indexes available for search")

        index_name = indexes[0]["index_name"]
        search_resp = await client.post(
            "/v1/search/indexes",
            json={"query": "contract", "index_names": [index_name], "top_k": 3, "min_score": 0.0}
        )
        assert search_resp.status_code == 200
