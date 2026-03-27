"""
Integration Tests: Utils API Endpoints

Tests /v1/utils/extractive and /v1/utils/rank-results endpoints
via the ASGI test client (no network, no mocking of core logic).
"""

import pytest
from httpx import AsyncClient


# =============================================================================
# POST /v1/utils/extractive
# =============================================================================

class TestExtractiveEndpoint:
    """Tests for the extractive text processing API."""

    @pytest.mark.asyncio
    async def test_short_text_passthrough(self, client: AsyncClient):
        """Short text within budget should pass through."""
        resp = await client.post("/v1/utils/extractive", json={
            "text": "Short text that fits within the budget easily.",
            "budget_chars": 5000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["text"] == "Short text that fits within the budget easily."
        assert data["chunks_total"] == 1
        assert data["chunks_selected"] == 1

    @pytest.mark.asyncio
    async def test_large_text_reduced(self, client: AsyncClient):
        """Large text should be reduced within budget."""
        large_text = (
            "Machine learning algorithms process data to find patterns. " * 100 + "\n\n"
            "Quantum computing uses qubits for parallel computations. " * 100 + "\n\n"
            "Blockchain provides decentralized transaction recording. " * 100
        )
        resp = await client.post("/v1/utils/extractive", json={
            "text": large_text,
            "budget_chars": 2000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["result_chars"] <= data["original_chars"]
        assert data["chunks_selected"] <= data["chunks_total"]
        assert data["processing_ms"] >= 0

    @pytest.mark.asyncio
    async def test_query_aware_ranking(self, client: AsyncClient):
        """With query, relevant content should be selected."""
        text = (
            "Neural networks consist of interconnected layers of artificial neurons. " * 50 + "\n\n"
            "Cooking pasta requires boiling water and adding salt to taste. " * 50 + "\n\n"
            "Deep learning has revolutionized computer vision and NLP tasks. " * 50
        )
        resp = await client.post("/v1/utils/extractive", json={
            "text": text,
            "query": "neural networks deep learning",
            "budget_chars": 1500,
        })
        assert resp.status_code == 200
        data = resp.json()
        lower = data["text"].lower()
        assert "neural" in lower or "deep learning" in lower
        # Cooking content should be underrepresented
        neural_count = lower.count("neural")
        cooking_count = lower.count("cooking")
        assert neural_count >= cooking_count

    @pytest.mark.asyncio
    async def test_custom_chunk_params(self, client: AsyncClient):
        """Custom chunk_size and chunk_overlap should be respected."""
        text = "Content block. " * 500
        resp = await client.post("/v1/utils/extractive", json={
            "text": text,
            "budget_chars": 1000,
            "chunk_size": 300,
            "chunk_overlap": 50,
            "max_chunks": 20,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["chunks_total"] >= 1

    @pytest.mark.asyncio
    async def test_empty_text(self, client: AsyncClient):
        """Empty text should return empty result."""
        resp = await client.post("/v1/utils/extractive", json={
            "text": "",
            "budget_chars": 1000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["text"] == ""
        assert data["result_chars"] == 0

    @pytest.mark.asyncio
    async def test_missing_required_field(self, client: AsyncClient):
        """Missing 'text' field should return 422."""
        resp = await client.post("/v1/utils/extractive", json={
            "budget_chars": 1000,
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_response_schema(self, client: AsyncClient):
        """Response should contain all expected fields."""
        resp = await client.post("/v1/utils/extractive", json={
            "text": "Some content to process for testing the response schema validation.",
            "budget_chars": 5000,
        })
        assert resp.status_code == 200
        data = resp.json()
        required_fields = ["text", "original_chars", "result_chars",
                           "chunks_total", "chunks_selected", "processing_ms"]
        for field in required_fields:
            assert field in data, f"Missing field: {field}"


# =============================================================================
# POST /v1/utils/rank-results
# =============================================================================

class TestRankResultsEndpoint:
    """Tests for the search result ranking API."""

    @pytest.mark.asyncio
    async def test_empty_results(self, client: AsyncClient):
        """Empty results list should return empty."""
        resp = await client.post("/v1/utils/rank-results", json={
            "results": [],
            "query": "test",
            "budget_chars": 1000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["results"] == []
        assert data["total_input"] == 0
        assert data["total_selected"] == 0

    @pytest.mark.asyncio
    async def test_results_within_budget(self, client: AsyncClient):
        """Results fitting in budget should all be returned."""
        results = [
            {"content": "First search result about AI.", "title": "AI Basics"},
            {"content": "Second search result about ML.", "title": "ML Guide"},
        ]
        resp = await client.post("/v1/utils/rank-results", json={
            "results": results,
            "query": "artificial intelligence",
            "budget_chars": 100000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_selected"] == 2
        assert len(data["results"]) == 2

    @pytest.mark.asyncio
    async def test_results_pruned_to_budget(self, client: AsyncClient):
        """Results exceeding budget should be pruned."""
        results = [
            {"content": f"Search result {i} with substantial content. " * 30, "title": f"Result {i}"}
            for i in range(15)
        ]
        resp = await client.post("/v1/utils/rank-results", json={
            "results": results,
            "query": "search result content",
            "budget_chars": 3000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_selected"] < data["total_input"]
        assert data["total_selected"] >= 1
        assert data["result_chars"] <= data["original_chars"]

    @pytest.mark.asyncio
    async def test_query_relevance(self, client: AsyncClient):
        """Results relevant to query should be preferred."""
        results = [
            {"content": "Cooking pasta with tomato sauce and basil leaves. " * 10, "title": "Pasta Recipe"},
            {"content": "Quantum entanglement enables faster than light communication theories. " * 10, "title": "Quantum Physics"},
            {"content": "Baking sourdough bread requires patience and a starter culture. " * 10, "title": "Bread Baking"},
            {"content": "Quantum computing qubits achieve superposition for parallel processing. " * 10, "title": "Quantum Computing"},
        ]
        resp = await client.post("/v1/utils/rank-results", json={
            "results": results,
            "query": "quantum computing qubits",
            "budget_chars": 2000,
        })
        assert resp.status_code == 200
        data = resp.json()
        # At least one quantum result should be present
        titles = [r["title"] for r in data["results"]]
        assert any("Quantum" in t for t in titles)

    @pytest.mark.asyncio
    async def test_custom_content_field(self, client: AsyncClient):
        """Custom content_field and title_field should work."""
        results = [
            {"text": "Custom field content here. " * 20, "name": "Item A"},
            {"text": "Another custom field content. " * 20, "name": "Item B"},
        ]
        resp = await client.post("/v1/utils/rank-results", json={
            "results": results,
            "query": "custom field",
            "budget_chars": 100000,
            "content_field": "text",
            "title_field": "name",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_selected"] == 2

    @pytest.mark.asyncio
    async def test_preserves_metadata(self, client: AsyncClient):
        """Result metadata should be preserved in output."""
        results = [
            {
                "content": "Content with metadata attached to the result.",
                "title": "Title",
                "url": "https://example.com",
                "score": 0.95,
                "extra": {"nested": True},
            }
        ]
        resp = await client.post("/v1/utils/rank-results", json={
            "results": results,
            "query": "test",
            "budget_chars": 100000,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["results"][0]["url"] == "https://example.com"
        assert data["results"][0]["score"] == 0.95
        assert data["results"][0]["extra"]["nested"] is True

    @pytest.mark.asyncio
    async def test_missing_query(self, client: AsyncClient):
        """Missing 'query' field should return 422."""
        resp = await client.post("/v1/utils/rank-results", json={
            "results": [{"content": "test", "title": "test"}],
            "budget_chars": 1000,
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_response_schema(self, client: AsyncClient):
        """Response should contain all expected fields."""
        resp = await client.post("/v1/utils/rank-results", json={
            "results": [{"content": "test content", "title": "test"}],
            "query": "test",
            "budget_chars": 100000,
        })
        assert resp.status_code == 200
        data = resp.json()
        required_fields = ["results", "total_input", "total_selected",
                           "original_chars", "result_chars", "processing_ms"]
        for field in required_fields:
            assert field in data, f"Missing field: {field}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
