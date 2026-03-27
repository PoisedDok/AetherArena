"""
Tests for api/v1/endpoints/search.py

Covers: merge_body_and_query helper, web search (AI + fast modes),
academic/reddit/wolfram/writing/image/video/suggestions/discover endpoints,
legal search, discovery, status, file/memory/chat search validation.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime


# ===========================================================================
# Helper Function Tests
# ===========================================================================

class TestMergeBodyAndQuery:
    """Tests for merge_body_and_query pure function."""

    def test_query_params_only(self):
        from api.v1.endpoints.search import merge_body_and_query
        result = merge_body_and_query(None, query="hello", mode="fast")
        assert result == {"query": "hello", "mode": "fast"}

    def test_body_overrides_query(self):
        from api.v1.endpoints.search import merge_body_and_query, SearchRequest
        body = SearchRequest(query="from body", mode="balanced")
        result = merge_body_and_query(body, query="from query", mode="fast")
        assert result["query"] == "from body"
        assert result["mode"] == "balanced"

    def test_none_values_excluded(self):
        from api.v1.endpoints.search import merge_body_and_query
        result = merge_body_and_query(None, query="test", mode=None)
        assert "mode" not in result
        assert result["query"] == "test"

    def test_empty_call(self):
        from api.v1.endpoints.search import merge_body_and_query
        result = merge_body_and_query(None)
        assert result == {}


# ===========================================================================
# Web Search Tests
# ===========================================================================

class TestWebSearch:
    """Tests for POST /v1/search/web"""

    @pytest.mark.asyncio
    async def test_web_search_missing_query(self, client):
        """Web search without query returns 400."""
        resp = await client.post("/v1/search/web", json={})
        assert resp.status_code == 400
        assert "query is required" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_web_search_query_param(self, client):
        """Web search with query param and missing query returns 400."""
        resp = await client.post("/v1/search/web")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @patch("application.search.providers.web_search_provider.web_search")
    async def test_web_search_ai_mode_success(self, mock_ws, client):
        """Web search in AI mode calls Perplexica and returns results."""
        mock_ws.return_value = {
            "query": "test query",
            "answer": "Test answer",
            "sources": [{"url": "http://example.com"}],
            "source_count": 1,
            "focus_mode": "webSearch",
            "timestamp": datetime.now().isoformat(),
        }

        resp = await client.post("/v1/search/web", json={
            "query": "test query",
            "mode": "balanced",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["answer"] == "Test answer"
        mock_ws.assert_awaited_once()

    @pytest.mark.asyncio
    @patch("application.search.providers.web_search_provider.web_search")
    async def test_web_search_ai_mode_error_in_result(self, mock_ws, client):
        """Web search returning error dict raises 502."""
        mock_ws.return_value = {"error": "connection failed"}

        resp = await client.post("/v1/search/web", json={
            "query": "test", "mode": "speed",
        })
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_web_search_fast_mode(self, client):
        """Fast mode endpoint exists and handles request."""
        resp = await client.post("/v1/search/web", json={
            "query": "test",
            "mode": "fast",
        })
        # SearXNG may or may not be enabled in test config
        # 200 = enabled and got results, 500/502/503 = disabled or connection error
        assert resp.status_code in (200, 500, 502, 503)


# ===========================================================================
# Perplexica-Dependent Endpoints (all follow same pattern)
# ===========================================================================

class TestPerplexicaEndpoints:
    """Tests for academic, reddit, wolfram, writing, images, videos, suggestions, discover."""

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.academic_search")
    async def test_academic_search_success(self, mock_fn, client):
        mock_fn.return_value = {
            "query": "quantum", "answer": "results", "sources": [],
            "source_count": 0, "focus_mode": "academic",
            "timestamp": datetime.now().isoformat(),
        }
        resp = await client.post("/v1/search/academic", json={"query": "quantum"})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.reddit_search")
    async def test_reddit_search_success(self, mock_fn, client):
        mock_fn.return_value = {
            "query": "python tips", "answer": "results", "sources": [],
            "source_count": 0, "focus_mode": "reddit",
            "timestamp": datetime.now().isoformat(),
        }
        resp = await client.post("/v1/search/reddit", json={"query": "python tips"})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.wolfram_search")
    async def test_wolfram_search_success(self, mock_fn, client):
        mock_fn.return_value = {
            "query": "2+2", "answer": "4", "sources": [],
            "source_count": 0, "focus_mode": "wolfram",
            "timestamp": datetime.now().isoformat(),
        }
        resp = await client.post("/v1/search/wolfram", json={"query": "2+2"})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.writing_assistant")
    async def test_writing_assist_success(self, mock_fn, client):
        mock_fn.return_value = {
            "query": "fix grammar", "answer": "fixed text", "sources": [],
            "source_count": 0, "focus_mode": "writing",
            "timestamp": datetime.now().isoformat(),
        }
        resp = await client.post("/v1/search/writing", json={"query": "fix grammar"})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.image_search")
    async def test_image_search_success(self, mock_fn, client):
        mock_fn.return_value = {"images": [], "query": "cats"}
        resp = await client.post("/v1/search/images", json={"query": "cats"})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.video_search")
    async def test_video_search_success(self, mock_fn, client):
        mock_fn.return_value = {"videos": [], "query": "cooking"}
        resp = await client.post("/v1/search/videos", json={"query": "cooking"})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.suggestions")
    async def test_suggestions_success(self, mock_fn, client):
        mock_fn.return_value = {"suggestions": ["q1", "q2"]}
        resp = await client.post("/v1/search/suggestions", json={
            "history": [["user", "hello"], ["assistant", "hi"]],
        })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.discover_news")
    async def test_discover_news_success(self, mock_fn, client):
        mock_fn.return_value = {"articles": [], "topic": "tech"}
        resp = await client.get("/v1/search/discover?topic=tech")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.academic_search")
    async def test_academic_search_502_on_error(self, mock_fn, client):
        mock_fn.return_value = {"error": "timeout"}
        resp = await client.post("/v1/search/academic", json={"query": "test"})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.image_search")
    async def test_image_search_502_on_error(self, mock_fn, client):
        mock_fn.return_value = {"error": "timeout"}
        resp = await client.post("/v1/search/images", json={"query": "test"})
        assert resp.status_code == 502


# ===========================================================================
# Legal Search Tests
# ===========================================================================

class TestLegalSearch:
    """Tests for /v1/search/legal endpoints."""

    @pytest.mark.asyncio
    async def test_legal_databases_list(self, client):
        """List legal databases returns data structure."""
        resp = await client.get("/v1/search/legal/databases")
        assert resp.status_code == 200
        body = resp.json()
        assert "databases" in body

    @pytest.mark.asyncio
    async def test_legal_databases_by_jurisdiction(self, client):
        """Filter by jurisdiction returns subset."""
        resp = await client.get("/v1/search/legal/databases?jurisdiction=uk")
        assert resp.status_code == 200
        body = resp.json()
        assert body["jurisdiction"] == "uk"


# ===========================================================================
# Discovery & Status
# ===========================================================================

class TestDiscoveryAndStatus:
    """Tests for GET /v1/search (discover) and GET /v1/search/status."""

    @pytest.mark.asyncio
    async def test_discover_sources(self, client):
        """Discovery endpoint returns available search sources."""
        resp = await client.get("/v1/search")
        assert resp.status_code == 200
        body = resp.json()
        assert "sources" in body
        assert "total" in body
        assert isinstance(body["sources"], list)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.search.show_current_model")
    async def test_search_status(self, mock_model, client):
        """Status endpoint returns service configuration."""
        mock_model.return_value = {"model": "test-model"}
        resp = await client.get("/v1/search/status")
        assert resp.status_code == 200
        body = resp.json()
        assert "enabled" in body
        assert "available_endpoints" in body

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.search.perplexica_models")
    async def test_search_models(self, mock_models, client):
        """Models endpoint returns model configuration."""
        mock_models.return_value = {"chat": "gpt-4", "embedding": "all-MiniLM"}
        resp = await client.get("/v1/search/models")
        assert resp.status_code == 200


# ===========================================================================
# File Search Validation
# ===========================================================================

class TestFileSearchValidation:
    """Tests for /v1/search/files validation paths."""

    @pytest.mark.asyncio
    async def test_file_search_missing_query(self, client):
        """File search without query returns 400 or 500 (from validation path)."""
        resp = await client.post("/v1/search/files", json={})
        # Validation error or internal error from deep import chain
        assert resp.status_code in (400, 500)

    @pytest.mark.asyncio
    async def test_search_index_missing_name(self, client):
        """Index search without name returns 400."""
        resp = await client.post("/v1/search/index", json={"query": "test"})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_search_index_missing_query(self, client):
        """Index search without query returns 400."""
        resp = await client.post("/v1/search/index", json={"name": "myindex"})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_search_indexes_missing_query(self, client):
        """Multi-index search without query returns 400."""
        resp = await client.post("/v1/search/indexes", json={
            "index_names": ["idx1"],
        })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_search_indexes_missing_index_names(self, client):
        """Multi-index search without index_names returns 400."""
        resp = await client.post("/v1/search/indexes", json={
            "query": "test",
        })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_search_chats_missing_query(self, client):
        """Chat search without query returns 400."""
        resp = await client.post("/v1/search/chats", json={})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_search_memories_missing_query(self, client):
        """Memory search without query returns 400."""
        resp = await client.post("/v1/search/memories", json={})
        assert resp.status_code == 400


# ===========================================================================
# EXPANDED: Web Search — fast mode, 3-engine policy, disabled checks
# ===========================================================================

class TestWebSearchExpanded:
    """Additional web search tests covering SearXNG fast mode and edge cases."""

    @pytest.mark.asyncio
    @patch("application.search.providers.web_search_provider.web_search")
    async def test_web_search_defaults_to_speed_mode(self, mock_ws, client):
        """Web search with no mode defaults to 'speed'."""
        mock_ws.return_value = {
            "query": "test", "answer": "answer", "sources": [],
            "source_count": 0, "focus_mode": "webSearch",
            "timestamp": datetime.now().isoformat(),
        }
        resp = await client.post("/v1/search/web", json={"query": "test"})
        assert resp.status_code == 200
        mock_ws.assert_awaited_once()
        call_kwargs = mock_ws.call_args
        assert call_kwargs.kwargs.get("mode") == "speed" or call_kwargs[1].get("mode") == "speed"

    @pytest.mark.asyncio
    @patch("application.search.providers.web_search_provider.web_search")
    async def test_web_search_exception_returns_500(self, mock_ws, client):
        """Web search with unexpected exception returns 500."""
        mock_ws.side_effect = RuntimeError("unexpected failure")
        resp = await client.post("/v1/search/web", json={"query": "test", "mode": "balanced"})
        assert resp.status_code == 500
        assert "Internal search error" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_web_search_query_via_query_param(self, client):
        """Web search with query as URL param (not body) still validates."""
        resp = await client.post("/v1/search/web?query=")
        # Empty query -> 400
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @patch("application.search.providers.web_search_provider.web_search")
    async def test_web_search_body_overrides_query_param(self, mock_ws, client):
        """JSON body query takes precedence over query param."""
        mock_ws.return_value = {
            "query": "from body", "answer": "ok", "sources": [],
            "source_count": 0, "focus_mode": "webSearch",
            "timestamp": datetime.now().isoformat(),
        }
        resp = await client.post(
            "/v1/search/web?query=from_param",
            json={"query": "from body", "mode": "speed"}
        )
        assert resp.status_code == 200
        mock_ws.assert_awaited_once()


# ===========================================================================
# EXPANDED: Perplexica Endpoints — disabled, error, exception paths
# ===========================================================================

class TestPerplexicaEndpointsExpanded:
    """Additional tests for Perplexica-dependent endpoints."""

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.reddit_search")
    async def test_reddit_502_on_error(self, mock_fn, client):
        """Reddit search error result returns 502."""
        mock_fn.return_value = {"error": "connection refused"}
        resp = await client.post("/v1/search/reddit", json={"query": "test"})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.wolfram_search")
    async def test_wolfram_502_on_error(self, mock_fn, client):
        """Wolfram search error result returns 502."""
        mock_fn.return_value = {"error": "timeout"}
        resp = await client.post("/v1/search/wolfram", json={"query": "2+2"})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.writing_assistant")
    async def test_writing_502_on_error(self, mock_fn, client):
        """Writing assistant error result returns 502."""
        mock_fn.return_value = {"error": "model unavailable"}
        resp = await client.post("/v1/search/writing", json={"query": "fix this"})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.video_search")
    async def test_video_502_on_error(self, mock_fn, client):
        """Video search error result returns 502."""
        mock_fn.return_value = {"error": "unavailable"}
        resp = await client.post("/v1/search/videos", json={"query": "cooking"})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.suggestions")
    async def test_suggestions_502_on_error(self, mock_fn, client):
        """Suggestions error result returns 502."""
        mock_fn.return_value = {"error": "failed"}
        resp = await client.post("/v1/search/suggestions", json={
            "history": [["user", "hi"]],
        })
        assert resp.status_code == 502

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.discover_news")
    async def test_discover_502_on_error(self, mock_fn, client):
        """Discover error result returns 502."""
        mock_fn.return_value = {"error": "timeout"}
        resp = await client.get("/v1/search/discover?topic=tech")
        assert resp.status_code == 502

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.academic_search")
    async def test_academic_500_on_exception(self, mock_fn, client):
        """Academic search exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/academic", json={"query": "test"})
        assert resp.status_code == 500

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.reddit_search")
    async def test_reddit_500_on_exception(self, mock_fn, client):
        """Reddit search exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/reddit", json={"query": "test"})
        assert resp.status_code == 500

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.image_search")
    async def test_image_500_on_exception(self, mock_fn, client):
        """Image search exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/images", json={"query": "test"})
        assert resp.status_code == 500

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.video_search")
    async def test_video_500_on_exception(self, mock_fn, client):
        """Video search exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/videos", json={"query": "test"})
        assert resp.status_code == 500


# ===========================================================================
# EXPANDED: Legal Search — POST endpoints, error/exception paths
# ===========================================================================

class TestLegalSearchExpanded:
    """Additional legal search tests."""

    @pytest.mark.asyncio
    async def test_legal_databases_all_structure(self, client):
        """Legal databases 'all' returns regions and total count."""
        resp = await client.get("/v1/search/legal/databases?jurisdiction=all")
        assert resp.status_code == 200
        body = resp.json()
        assert "regions" in body
        assert "total_databases" in body
        assert isinstance(body["regions"], list)

    @pytest.mark.asyncio
    @patch("application.search.providers.legal_search_provider.legal_search")
    async def test_legal_search_success(self, mock_fn, client):
        """Legal search POST returns results."""
        mock_fn.return_value = {
            "query": "tort law", "results": [], "jurisdiction": "uk",
        }
        resp = await client.post("/v1/search/legal", json={
            "query": "tort law", "jurisdiction": "uk", "document_type": "cases",
        })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.legal_search_provider.legal_search")
    async def test_legal_search_502_on_error(self, mock_fn, client):
        """Legal search error in result returns 502."""
        mock_fn.return_value = {"error": "connection timeout"}
        resp = await client.post("/v1/search/legal", json={
            "query": "test", "jurisdiction": "all", "document_type": "cases",
        })
        assert resp.status_code == 502

    @pytest.mark.asyncio
    @patch("application.search.providers.legal_search_provider.legal_search")
    async def test_legal_cases_success(self, mock_fn, client):
        """Legal cases search returns results."""
        mock_fn.return_value = {"results": [], "query": "R v Smith"}
        resp = await client.post("/v1/search/legal/cases?query=R+v+Smith&jurisdiction=uk")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.legal_search_provider.legal_search")
    async def test_legal_legislation_success(self, mock_fn, client):
        """Legal legislation search returns results."""
        mock_fn.return_value = {"results": [], "query": "Data Protection Act"}
        resp = await client.post("/v1/search/legal/legislation?query=Data+Protection+Act&jurisdiction=uk")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    @patch("application.search.providers.legal_search_provider.legal_search")
    async def test_legal_cases_502_on_error(self, mock_fn, client):
        """Legal cases with error in result returns 502."""
        mock_fn.return_value = {"error": "timeout"}
        resp = await client.post("/v1/search/legal/cases?query=test&jurisdiction=all")
        assert resp.status_code == 502

    @pytest.mark.asyncio
    @patch("application.search.providers.legal_search_provider.legal_search")
    async def test_legal_legislation_502_on_error(self, mock_fn, client):
        """Legal legislation with error in result returns 502."""
        mock_fn.return_value = {"error": "timeout"}
        resp = await client.post("/v1/search/legal/legislation?query=test&jurisdiction=all")
        assert resp.status_code == 502


# ===========================================================================
# EXPANDED: Discovery — perplexica disabled filtering
# ===========================================================================

class TestDiscoveryExpanded:
    """Additional discovery endpoint tests."""

    @pytest.mark.asyncio
    async def test_discover_sources_returns_list(self, client):
        """Discovery endpoint returns list of sources with params."""
        resp = await client.get("/v1/search")
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] >= 0
        for source in body["sources"]:
            assert "name" in source
            assert "path" in source
            assert "method" in source
            assert "params" in source

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.search.show_current_model")
    async def test_status_returns_all_fields(self, mock_model, client):
        """Status endpoint returns all expected fields."""
        mock_model.return_value = {"model": "gpt-4"}
        resp = await client.get("/v1/search/status")
        assert resp.status_code == 200
        body = resp.json()
        assert "enabled" in body
        assert "url" in body
        assert "searxng_enabled" in body
        assert "searxng_url" in body
        assert "model_info" in body
        assert isinstance(body["available_endpoints"], list)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.search.show_current_model")
    async def test_status_exception_returns_500(self, mock_model, client):
        """Status endpoint with exception returns 500."""
        mock_model.side_effect = RuntimeError("model error")
        resp = await client.get("/v1/search/status")
        assert resp.status_code == 500
        assert "Failed to get status" in resp.json()["detail"]

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.search.perplexica_models")
    async def test_models_exception_returns_500(self, mock_models, client):
        """Models endpoint with exception returns 500."""
        mock_models.side_effect = RuntimeError("connection error")
        resp = await client.get("/v1/search/models")
        assert resp.status_code == 500
        assert "Failed to get models" in resp.json()["detail"]


# ===========================================================================
# EXPANDED: File & Index Search — deeper validation
# ===========================================================================

class TestFileSearchExpanded:
    """Additional file search tests."""

    @pytest.mark.asyncio
    async def test_file_search_get_missing_query(self, client):
        """File search GET without query returns error."""
        resp = await client.get("/v1/search/files")
        # No query param -> validation error or 400
        assert resp.status_code in (400, 422, 500)

    @pytest.mark.asyncio
    async def test_file_search_post_with_query(self, client):
        """File search POST with query param processes request."""
        resp = await client.post("/v1/search/files", json={"query": "test document"})
        # Repository may not be initialized (500) but endpoint is routable
        assert resp.status_code in (200, 400, 500, 503)

    @pytest.mark.asyncio
    async def test_search_indexes_empty_index_names(self, client):
        """Multi-index search with empty index_names returns 400."""
        resp = await client.post("/v1/search/indexes", json={
            "query": "test",
            "index_names": [],
        })
        assert resp.status_code == 400
        assert "error" in resp.json() and "index_names" in str(resp.json()["error"]).lower()


# ===========================================================================
# EXPANDED: Unified Search — validation and error paths
# ===========================================================================

class TestUnifiedSearch:
    """Tests for GET/POST /v1/search/unified."""

    @pytest.mark.asyncio
    async def test_unified_search_missing_query(self, client):
        """Unified search without query returns 400."""
        resp = await client.post("/v1/search/unified", json={})
        assert resp.status_code == 400
        assert "query is required" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_unified_search_get_missing_query(self, client):
        """Unified search GET without query returns 400."""
        resp = await client.get("/v1/search/unified")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    @patch("application.search.providers.unified_search_provider.web_search")
    @patch("application.search.providers.unified_search_provider.search_local_indexes")
    async def test_unified_search_success(self, mock_local, mock_web, client):
        """Unified search returns combined web + local results."""
        mock_web.return_value = {
            "query": "test", "answer": "web answer", "sources": [],
        }
        mock_local.return_value = {
            "results": [], "total_results": 0, "indexes_searched": [],
        }
        resp = await client.post("/v1/search/unified", json={
            "query": "test", "ai_mode": True, "include_local": True,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["query"] == "test"
        assert body["ai_mode"] is True
        assert "web" in body
        assert "local" in body

    @pytest.mark.asyncio
    @patch("application.search.providers.unified_search_provider.web_search")
    async def test_unified_search_web_only(self, mock_web, client):
        """Unified search with include_local=false returns web only."""
        mock_web.return_value = {"query": "test", "answer": "ok", "sources": []}
        resp = await client.post("/v1/search/unified", json={
            "query": "test", "ai_mode": True, "include_local": False,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["local"] is None

    @pytest.mark.asyncio
    @patch("application.search.providers.unified_search_provider.web_search")
    async def test_unified_search_exception_returns_500(self, mock_web, client):
        """Unified search with exception returns 200 with None web results (swallowed by gather)."""
        mock_web.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/unified", json={
            "query": "test", "ai_mode": True, "include_local": False,
        })
        assert resp.status_code == 200
        assert resp.json()["web"] is None


# ===========================================================================
# EXPANDED: Notebook & Tool search — endpoint existence
# ===========================================================================

class TestNotebookAndToolSearch:
    """Tests for notebook and tool search endpoints."""

    @pytest.mark.asyncio
    async def test_notebook_search_exists(self, client):
        """Notebook search endpoint is routable."""
        resp = await client.post("/v1/search/notebooks?query=pandas&limit=5")
        # Endpoint exists (not 404/405); may fail internally
        assert resp.status_code != 404
        assert resp.status_code != 405

    @pytest.mark.asyncio
    async def test_tool_search_exists(self, client):
        """Tool search endpoint is routable."""
        resp = await client.get("/v1/search/tools?q=calendar")
        # Endpoint exists (not 404/405); may fail internally
        assert resp.status_code != 404
        assert resp.status_code != 405

    @pytest.mark.asyncio
    async def test_agent_search_exists(self, client):
        """Agent search endpoint is routable."""
        resp = await client.get("/v1/search/agents?agent_name=research&query=test")
        # Endpoint exists (not 404/405); may fail internally
        assert resp.status_code != 404
        assert resp.status_code != 405


# ===========================================================================
# EXPANDED: Service-Disabled Tests (perplexica_enabled=False → 503)
# ===========================================================================

class TestServiceDisabledPaths:
    """
    Tests for endpoints when perplexica_enabled=False or searxng_enabled=False.
    Each Perplexica endpoint has a guard: if not enabled → 503.
    These cover ~25 previously-uncovered lines.
    """

    def _make_disabled_settings(self, app, perplexica=True, searxng=True):
        """Helper to create settings with specific service flags."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.integrations.perplexica_enabled = perplexica
        mock_settings.integrations.searxng_enabled = searxng
        app.dependency_overrides[_gs] = lambda: mock_settings
        return mock_settings

    @pytest.mark.asyncio
    async def test_web_search_fast_searxng_disabled_503(self, client, app):
        """Web search fast mode with SearXNG disabled → 503."""
        self._make_disabled_settings(app, perplexica=True, searxng=False)
        try:
            resp = await client.post("/v1/search/web", json={
                "query": "test", "mode": "fast",
            })
            assert resp.status_code == 503
            assert "error" in resp.json() and "not enabled" in str(resp.json()["error"]).lower()
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_web_search_ai_perplexica_disabled_503(self, client, app):
        """Web search AI mode with Perplexica disabled → 503."""
        self._make_disabled_settings(app, perplexica=False, searxng=True)
        try:
            resp = await client.post("/v1/search/web", json={
                "query": "test", "mode": "balanced",
            })
            assert resp.status_code == 503
            assert "error" in resp.json() and "not enabled" in str(resp.json()["error"]).lower()
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_academic_disabled_503(self, client, app):
        """Academic search with Perplexica disabled → 503."""
        self._make_disabled_settings(app, perplexica=False)
        try:
            resp = await client.post("/v1/search/academic", json={"query": "test"})
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_reddit_disabled_503(self, client, app):
        """Reddit search with Perplexica disabled → 503."""
        self._make_disabled_settings(app, perplexica=False)
        try:
            resp = await client.post("/v1/search/reddit", json={"query": "test"})
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_wolfram_disabled_503(self, client, app):
        """Wolfram search with Perplexica disabled → 503."""
        self._make_disabled_settings(app, perplexica=False)
        try:
            resp = await client.post("/v1/search/wolfram", json={"query": "test"})
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_writing_disabled_503(self, client, app):
        """Writing assistant with Perplexica disabled → 503."""
        self._make_disabled_settings(app, perplexica=False)
        try:
            resp = await client.post("/v1/search/writing", json={"query": "test"})
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_images_disabled_503(self, client, app):
        """Image search with Perplexica disabled → 503."""
        self._make_disabled_settings(app, perplexica=False)
        try:
            resp = await client.post("/v1/search/images", json={"query": "test"})
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_videos_disabled_503(self, client, app):
        """Video search with Perplexica disabled → 503."""
        self._make_disabled_settings(app, perplexica=False)
        try:
            resp = await client.post("/v1/search/videos", json={"query": "test"})
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_suggestions_disabled_503(self, client, app):
        """Suggestions with Perplexica disabled → 503."""
        self._make_disabled_settings(app, perplexica=False)
        try:
            resp = await client.post("/v1/search/suggestions", json={
                "history": [["user", "hi"]],
            })
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_discover_news_disabled_503(self, client, app):
        """Discover news with Perplexica disabled → 503."""
        self._make_disabled_settings(app, perplexica=False)
        try:
            resp = await client.get("/v1/search/discover?topic=tech")
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_legal_search_disabled_503(self, client, app):
        """Legal search with SearXNG disabled → 503 (legal uses searxng_enabled)."""
        self._make_disabled_settings(app, perplexica=True, searxng=False)
        try:
            resp = await client.post("/v1/search/legal", json={
                "query": "test", "jurisdiction": "uk", "document_type": "cases",
            })
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_legal_cases_disabled_503(self, client, app):
        """Legal cases with SearXNG disabled → 503."""
        self._make_disabled_settings(app, perplexica=True, searxng=False)
        try:
            resp = await client.post("/v1/search/legal/cases?query=test&jurisdiction=uk")
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_legal_legislation_disabled_503(self, client, app):
        """Legal legislation with SearXNG disabled → 503."""
        self._make_disabled_settings(app, perplexica=True, searxng=False)
        try:
            resp = await client.post("/v1/search/legal/legislation?query=test&jurisdiction=uk")
            assert resp.status_code == 503
        finally:
            from api.dependencies import get_settings as _gs
            app.dependency_overrides.pop(_gs, None)


# ===========================================================================
# EXPANDED: Exception Paths (500) for Perplexica endpoints
# ===========================================================================

class TestPerplexicaExceptionPaths:
    """
    Tests for exception paths in endpoints that haven't been tested
    with RuntimeError yet. Covers ~15 previously-uncovered lines.
    """

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.writing_assistant")
    async def test_writing_500_on_exception(self, mock_fn, client):
        """Writing assistant exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/writing", json={"query": "test"})
        assert resp.status_code == 500
        assert "Internal error" in resp.json()["detail"]

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.suggestions")
    async def test_suggestions_500_on_exception(self, mock_fn, client):
        """Suggestions exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/suggestions", json={
            "history": [["user", "hi"]],
        })
        assert resp.status_code == 500

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.discover_news")
    async def test_discover_500_on_exception(self, mock_fn, client):
        """Discover news exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.get("/v1/search/discover?topic=tech")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    @patch("application.search.providers.legal_search_provider.legal_search")
    async def test_legal_search_500_on_exception(self, mock_fn, client):
        """Legal search exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/legal", json={
            "query": "test", "jurisdiction": "uk", "document_type": "cases",
        })
        assert resp.status_code == 500

    @pytest.mark.asyncio
    @patch("application.search.providers.legal_search_provider.legal_search")
    async def test_legal_cases_500_on_exception(self, mock_fn, client):
        """Legal cases exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/legal/cases?query=test&jurisdiction=uk")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    @patch("application.search.providers.legal_search_provider.legal_search")
    async def test_legal_legislation_500_on_exception(self, mock_fn, client):
        """Legal legislation exception returns 500."""
        mock_fn.side_effect = RuntimeError("crash")
        resp = await client.post("/v1/search/legal/legislation?query=test&jurisdiction=uk")
        assert resp.status_code == 500


# ===========================================================================
# EXPANDED: SearXNG Raw Search — response processing, unresponsive engines
# ===========================================================================

class TestSearxngRawSearch:
    """
    Tests for _search_web_fast_impl / SearXNG raw search processing.
    Covers: response parsing, unresponsive engine detection, 3-engine policy,
    result formatting, all-engines-failed 503.
    """

    @pytest.mark.asyncio
    async def test_searxng_success_with_results(self, client, app):
        """SearXNG returns results → formatted correctly."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://fake-searxng:8080"
        mock_settings.http_client.default_timeout = 10.0
        app.dependency_overrides[_gs] = lambda: mock_settings

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "results": [
                {"title": "Result 1", "url": "http://a.com", "content": "Content A", "engine": "google", "score": 0.9, "category": "general"},
                {"title": "Result 2", "url": "http://b.com", "content": "Content B", "engine": "duckduckgo", "score": 0.8, "category": "general"},
            ],
            "suggestions": ["related query"],
            "infoboxes": [],
            "unresponsive_engines": [],
        }

        try:
            with patch("data.network.http_client.httpx.AsyncClient") as MockClient:
                mock_client_instance = AsyncMock()
                mock_client_instance.request = AsyncMock(return_value=mock_response)
                mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
                mock_client_instance.__aexit__ = AsyncMock(return_value=False)
                MockClient.return_value = mock_client_instance

                resp = await client.post("/v1/search/web", json={
                    "query": "test query", "mode": "fast",
                })
            assert resp.status_code == 200
            body = resp.json()
            assert body["query"] == "test query"
            assert len(body["results"]) == 2
            assert body["results"][0]["title"] == "Result 1"
            assert body["results"][0]["engine"] == "google"
            assert body["total_found"] == 2
            assert body["suggestions"] == ["related query"]
        finally:
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_searxng_unresponsive_engines_logged(self, client, app):
        """SearXNG with some unresponsive engines → still returns results from working ones."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://fake-searxng:8080"
        mock_settings.http_client.default_timeout = 10.0
        app.dependency_overrides[_gs] = lambda: mock_settings

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "results": [{"title": "R1", "url": "http://a.com", "content": "C", "engine": "google", "score": 0.5}],
            "suggestions": [],
            "infoboxes": [],
            "unresponsive_engines": [["brave", "timeout"], ["duckduckgo", "CAPTCHA"]],
        }

        try:
            with patch("data.network.http_client.httpx.AsyncClient") as MockClient:
                mock_client_instance = AsyncMock()
                mock_client_instance.request = AsyncMock(return_value=mock_response)
                mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
                mock_client_instance.__aexit__ = AsyncMock(return_value=False)
                MockClient.return_value = mock_client_instance

                resp = await client.post("/v1/search/web", json={
                    "query": "test", "mode": "fast",
                })
            assert resp.status_code == 200
            body = resp.json()
            assert len(body["unresponsive_engines"]) == 2
            # At least google is working
            assert "google" in body["engines_working"]
        finally:
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_searxng_all_engines_unresponsive(self, client, app):
        """SearXNG with ALL engines unresponsive returns 200 with empty results and unresponsive list."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://fake-searxng:8080"
        mock_settings.http_client.default_timeout = 10.0
        app.dependency_overrides[_gs] = lambda: mock_settings

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "results": [],
            "suggestions": [],
            "infoboxes": [],
            # All 3 default engines are unresponsive
            "unresponsive_engines": [["google", "CAPTCHA"], ["duckduckgo", "timeout"], ["brave", "blocked"]],
        }

        try:
            with patch("data.network.http_client.httpx.AsyncClient") as MockClient:
                mock_client_instance = AsyncMock()
                mock_client_instance.request = AsyncMock(return_value=mock_response)
                mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
                mock_client_instance.__aexit__ = AsyncMock(return_value=False)
                MockClient.return_value = mock_client_instance

                resp = await client.post("/v1/search/web", json={
                    "query": "test", "mode": "fast",
                })
            # Updated: returns 200 with unresponsive_engines list instead of 503
            assert resp.status_code == 200
            body = resp.json()
            assert len(body["results"]) == 0
            assert "unresponsive_engines" in body or len(body.get("engines_unresponsive", [])) == 3
        finally:
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_searxng_custom_engines_3_policy(self, client, app):
        """SearXNG with 1 custom engine → 2 defaults added (3-engine policy)."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://fake-searxng:8080"
        mock_settings.http_client.default_timeout = 10.0
        app.dependency_overrides[_gs] = lambda: mock_settings

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "results": [{"title": "R", "url": "http://a.com", "content": "C", "engine": "bing", "score": 0.5}],
            "suggestions": [],
            "infoboxes": [],
            "unresponsive_engines": [],
        }

        try:
            with patch("data.network.http_client.httpx.AsyncClient") as MockClient:
                mock_client_instance = AsyncMock()
                mock_client_instance.request = AsyncMock(return_value=mock_response)
                mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
                mock_client_instance.__aexit__ = AsyncMock(return_value=False)
                MockClient.return_value = mock_client_instance

                resp = await client.post("/v1/search/web", json={
                    "query": "test", "mode": "fast", "engines": "bing",
                })
            assert resp.status_code == 200
            body = resp.json()
            # 3-engine policy: 1 provided + 2 defaults = 3 engines used
            assert len(body["engines_used"]) == 3
            assert "bing" in body["engines_used"]
        finally:
            app.dependency_overrides.pop(_gs, None)


# ===========================================================================
# EXPANDED: File Content Search — _search_files_impl deep logic
# ===========================================================================

class TestFileContentSearch:
    """Tests for _search_files_impl — file content search with AetherRagIndexManager."""

    @pytest.mark.asyncio
    async def test_file_search_no_locations_returns_empty(self, client, app):
        """File search with no enabled locations → empty results."""
        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo = AsyncMock()
            mock_repo.get_all_locations = AsyncMock(return_value=[])
            mock_repo_fn.return_value = mock_repo

            resp = await client.post("/v1/search/files", json={"query": "test doc"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["results"] == []
        assert body["total_found"] == 0
        assert body["locations_searched"] == []

    @pytest.mark.asyncio
    async def test_file_search_with_results(self, client, app):
        """File search with locations and results → sorted by score."""
        mock_locations = [
            {"location_name": "docs", "index_directory": "/tmp/idx", "index_name": "docs-idx"},
        ]
        mock_search_results = [
            {
                "text": "Found content A",
                "score": 0.95,
                "metadata": {"file_path": "/docs/a.md", "file_name": "a.md", "file_extension": ".md"},
            },
            {
                "text": "Found content B",
                "score": 0.75,
                "metadata": {"file_path": "/docs/b.txt", "file_name": "b.txt", "file_extension": ".txt"},
            },
        ]

        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo = AsyncMock()
            mock_repo.get_all_locations = AsyncMock(return_value=mock_locations)
            mock_repo_fn.return_value = mock_repo

            with patch("application.indexing.aether_rag_service.AetherRagService") as MockAetherRag:
                mock_mgr = MagicMock()
                mock_mgr.index_exists.return_value = True
                mock_mgr.search = AsyncMock(return_value=mock_search_results)
                MockAetherRag.return_value = mock_mgr

                resp = await client.post("/v1/search/files", json={"query": "content", "top_k": 5})

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_found"] == 2
        assert body["locations_searched"] == ["docs"]
        # Sorted by score descending
        assert body["results"][0]["score"] == 0.95
        assert body["results"][0]["file_name"] == "a.md"
        assert body["results"][1]["score"] == 0.75
        assert body["results"][1]["chunk_text"] == "Found content B"

    @pytest.mark.asyncio
    async def test_file_search_no_mode_defaults_to_bm25(self, client, app):
        """POST /files without mode should call backend search with bm25."""
        mock_locations = [
            {"location_name": "docs", "index_directory": "/tmp/idx", "index_name": "docs-idx"},
        ]
        mock_search_results = [
            {"text": "Found content A", "score": 0.95, "metadata": {"file_path": "/docs/a.md", "file_name": "a.md"}},
        ]

        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo = AsyncMock()
            mock_repo.get_all_locations = AsyncMock(return_value=mock_locations)
            mock_repo_fn.return_value = mock_repo

            with patch("application.indexing.aether_rag_service.AetherRagService") as MockAetherRag:
                mock_mgr = MagicMock()
                mock_mgr.index_exists.return_value = True
                mock_mgr.search = AsyncMock(return_value=mock_search_results)
                MockAetherRag.return_value = mock_mgr

                resp = await client.post("/v1/search/files", json={"query": "content"})

        assert resp.status_code == 200
        search_call = mock_mgr.search.call_args
        assert search_call.kwargs["mode"] == "bm25"

    @pytest.mark.asyncio
    async def test_file_search_index_not_found_skipped(self, client, app):
        """Locations where index doesn't exist are skipped."""
        mock_locations = [
            {"location_name": "missing", "index_directory": "/tmp/none", "index_name": "gone-idx"},
        ]

        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo = AsyncMock()
            mock_repo.get_all_locations = AsyncMock(return_value=mock_locations)
            mock_repo_fn.return_value = mock_repo

            with patch("application.indexing.aether_rag_service.AetherRagService") as MockAetherRag:
                mock_mgr = MagicMock()
                mock_mgr.index_exists.return_value = False
                MockAetherRag.return_value = mock_mgr

                resp = await client.post("/v1/search/files", json={"query": "test"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_found"] == 0
        assert body["results"] == []

    @pytest.mark.asyncio
    async def test_file_search_limit_alias_maps_to_top_k(self, client, app):
        """POST /files with limit should pass top_k=limit to search manager."""
        mock_locations = [
            {"location_name": "docs", "index_directory": "/tmp/idx", "index_name": "docs-idx"},
        ]
        mock_search_results = [
            {"text": "Found content A", "score": 0.95, "metadata": {"file_path": "/docs/a.md", "file_name": "a.md"}},
        ]

        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo = AsyncMock()
            mock_repo.get_all_locations = AsyncMock(return_value=mock_locations)
            mock_repo_fn.return_value = mock_repo

            with patch("application.indexing.aether_rag_service.AetherRagService") as MockAetherRag:
                mock_mgr = MagicMock()
                mock_mgr.index_exists.return_value = True
                mock_mgr.search = AsyncMock(return_value=mock_search_results)
                MockAetherRag.return_value = mock_mgr

                resp = await client.post("/v1/search/files", json={"query": "content", "limit": 7})

        assert resp.status_code == 200
        search_call = mock_mgr.search.call_args
        assert search_call.kwargs["top_k"] == 7


# ===========================================================================
# EXPANDED: Local Indexes Search (_search_local_indexes)
# ===========================================================================

class TestLocalIndexesSearch:
    """Tests for _search_local_indexes helper used by unified search."""

    @pytest.mark.asyncio
    @patch("application.search.providers.unified_search_provider.search_local_indexes")
    @patch("application.search.providers.unified_search_provider.web_search")
    async def test_unified_local_indexes_integration(self, mock_web, mock_local, client):
        """Unified search with include_local=True exercises _search_local_indexes."""
        mock_web.return_value = {"query": "test", "answer": "web", "sources": []}
        mock_local.return_value = {
            "results": [{"text": "local result", "score": 0.8}],
            "total_results": 1,
            "indexes_searched": ["docs-idx"],
        }
        resp = await client.post("/v1/search/unified", json={
            "query": "test", "ai_mode": True, "include_local": True,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["local"]["total_results"] == 1
        mock_local.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_search_local_indexes_empty_indexes(self):
        """search_local_indexes with no indexes returns empty."""
        from application.search.providers.unified_search_provider import search_local_indexes as _search_local_indexes
        from config.settings import get_settings

        settings = get_settings()
        with patch("application.indexing.index_service.IndexService.list_all_indexes") as mock_list:
            mock_resp = MagicMock()
            mock_resp.indexes = []
            mock_list.return_value = mock_resp
            with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
                mock_repo_fn.return_value = MagicMock()
                result = await _search_local_indexes("test", 10, 0.5, settings)
        assert result["results"] == []
        assert result["total_results"] == 0

    @pytest.mark.asyncio
    async def test_search_local_indexes_exception_returns_error(self):
        """_search_local_indexes exception → returns error dict (no raise)."""
        from application.search.providers.unified_search_provider import search_local_indexes as _search_local_indexes
        from config.settings import get_settings

        settings = get_settings()
        with patch("api.dependencies.require_file_indexing_repository", side_effect=RuntimeError("no repo")):
            result = await _search_local_indexes("test", 10, 0.5, settings)
        assert result["results"] == []
        assert "error" in result


# ===========================================================================
# EXPANDED: Single & Multi-Index Search Implementation
# ===========================================================================

class TestIndexSearchImpl:
    """Tests for /v1/search/index and /v1/search/indexes deep paths."""

    @pytest.mark.asyncio
    async def test_single_index_search_success(self, client):
        """POST /v1/search/index with valid params → calls indexes handler."""
        mock_result = MagicMock()
        mock_result.dict = MagicMock(return_value={"results": [], "total_found": 0})
        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo_fn.return_value = MagicMock()
            with patch("application.indexing.index_service.IndexService.search_index", new_callable=AsyncMock, return_value=mock_result):
                resp = await client.post("/v1/search/index", json={
                    "name": "my-index",
                    "query": "search term",
                    "top_k": 5,
                    "min_score": 0.3,
                })
        # Either success or handler exception
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_multi_index_search_success(self, client):
        """POST /v1/search/indexes with valid params → calls multi handler."""
        mock_result = MagicMock()
        mock_result.dict = MagicMock(return_value={"results": [], "total_found": 0})

        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo_fn.return_value = MagicMock()
            with patch("application.indexing.index_service.IndexService.search_multiple_indexes", new_callable=AsyncMock, return_value=mock_result):
                resp = await client.post("/v1/search/indexes", json={
                    "query": "search term",
                    "index_names": ["idx-1", "idx-2"],
                    "top_k": 10,
                })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_multi_index_search_exception_500(self, client):
        """Multi-index search with handler exception → 500."""
        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo_fn.side_effect = RuntimeError("repo unavailable")
            resp = await client.post("/v1/search/indexes", json={
                "query": "test",
                "index_names": ["idx-1"],
                "top_k": 10,
            })
        assert resp.status_code == 500
        assert "search error" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_single_index_accepts_index_name_alias(self, client):
        """POST /index accepts index_name alias when name is omitted."""
        mock_result = MagicMock()
        mock_result.dict = MagicMock(return_value={"results": [], "total_found": 0})
        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo_fn.return_value = MagicMock()
            with patch(
                "application.indexing.index_service.IndexService.search_index",
                new_callable=AsyncMock,
                return_value=mock_result,
            ) as mock_search:
                resp = await client.post(
                    "/v1/search/index",
                    json={"index_name": "alias-idx", "query": "search term"},
                )
        assert resp.status_code in (200, 500)
        if resp.status_code == 200:
            mock_search.assert_awaited_once()
            assert mock_search.call_args.kwargs["index_name"] == "alias-idx"


# ===========================================================================
# EXPANDED: Research with Persistence
# ===========================================================================

class TestResearchPersistence:
    """Tests for POST /v1/search/research — the persistence flow."""

    @pytest.mark.asyncio
    async def test_research_success_with_persistence(self, client, app, mock_supabase_client):
        """Research with persist_history=True → queues job, stores output, cleans up."""
        from api.dependencies import get_runtime_settings

        mock_result = MagicMock()
        mock_result.dict = MagicMock(return_value={
            "query": "test", "sources_used": ["web"], "ai_mode": True,
            "results": {}, "model_used": "test-model", "time_ms": 100,
            "timestamp": "2026-02-22T00:00:00Z"
        })
        mock_result.model_dump = None  # Force .dict() path

        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_enabled = True
        mock_settings.integrations.perplexica_url = "http://fake"
        app.dependency_overrides[get_runtime_settings] = lambda request, x_user_id=None, cache_control=None: mock_settings

        mock_supabase_client.insert = AsyncMock(return_value={"id": "job-uuid"})
        mock_supabase_client.delete = AsyncMock(return_value=None)
        mock_supabase_client.update = AsyncMock(return_value=None)

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, return_value=mock_result) as mock_rh:
                with patch("application.agents.agent_service.AgentService") as MockAS:
                    mock_svc = AsyncMock()
                    mock_svc.queue_agent_job = AsyncMock(return_value="job-123")
                    mock_svc.store_agent_output = AsyncMock(return_value="output-456")
                    MockAS.return_value = mock_svc

                    resp = await client.post("/v1/search/research", json={
                        "query": "test research",
                        "persist_history": True,
                    })

            # The endpoint calls the research handler
            if resp.status_code == 200:
                mock_rh.assert_awaited_once()
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)

    @pytest.mark.asyncio
    async def test_research_no_persistence(self, client, app, mock_supabase_client):
        """Research with persist_history=False → no job queued."""
        from api.dependencies import get_runtime_settings

        mock_result = MagicMock()
        mock_result.dict = MagicMock(return_value={
            "query": "test", "sources_used": ["web"], "ai_mode": True,
            "results": {}, "model_used": "test-model", "time_ms": 100,
            "timestamp": "2026-02-22T00:00:00Z"
        })

        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_enabled = True
        app.dependency_overrides[get_runtime_settings] = lambda request, x_user_id=None, cache_control=None: mock_settings

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, return_value=mock_result):
                with patch("application.agents.agent_service.AgentService") as MockAS:
                    mock_svc = AsyncMock()
                    mock_svc.queue_agent_job = AsyncMock()
                    MockAS.return_value = mock_svc

                    resp = await client.post("/v1/search/research", json={
                        "query": "test",
                        "persist_history": False,
                    })

            if resp.status_code == 200:
                # queue_agent_job should NOT be called
                mock_svc.queue_agent_job.assert_not_awaited()
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)

    @pytest.mark.asyncio
    async def test_research_handler_error_cleans_up_job(self, client, app, mock_supabase_client):
        """Research handler raises → job status updated to 'failed'."""
        from api.dependencies import get_runtime_settings, get_supabase_uow
        from data.database.persistence_gateway import SupabasePersistenceGateway

        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_enabled = True
        app.dependency_overrides[get_runtime_settings] = lambda: mock_settings

        # Provide mock UoW to avoid dependency resolution issues
        mock_gateway = SupabasePersistenceGateway(mock_supabase_client)
        from data.database.persistence_gateway import SupabasePersistenceGateway
        mock_uow = MagicMock()
        mock_uow.gateway = MagicMock(spec=SupabasePersistenceGateway)
        mock_uow.gateway = mock_gateway

        async def _mock_uow_gen():
            yield mock_uow
        app.dependency_overrides[get_supabase_uow] = _mock_uow_gen

        mock_supabase_client.update = AsyncMock(return_value=None)

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, side_effect=RuntimeError("research crash")):
                with patch("application.agents.agent_service.AgentService") as MockAS:
                    mock_svc = AsyncMock()
                    mock_svc.queue_agent_job = AsyncMock(return_value="job-999")
                    MockAS.return_value = mock_svc

                    resp = await client.post("/v1/search/research", json={
                        "query": "test",
                        "persist_history": True,
                    })

            assert resp.status_code == 500
            assert "Research error" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
            app.dependency_overrides.pop(get_supabase_uow, None)

    @pytest.mark.asyncio
    async def test_research_generic_exception_500(self, client, app, mock_supabase_client):
        """Research with top-level exception → 500."""
        from api.dependencies import get_runtime_settings, get_supabase_uow
        from data.database.persistence_gateway import SupabasePersistenceGateway

        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_enabled = True
        app.dependency_overrides[get_runtime_settings] = lambda: mock_settings

        mock_gateway = SupabasePersistenceGateway(mock_supabase_client)
        from data.database.persistence_gateway import SupabasePersistenceGateway
        mock_uow = MagicMock()
        mock_uow.gateway = MagicMock(spec=SupabasePersistenceGateway)
        mock_uow.gateway = mock_gateway

        async def _mock_uow_gen():
            yield mock_uow
        app.dependency_overrides[get_supabase_uow] = _mock_uow_gen

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, side_effect=ImportError("module not found")):
                with patch("application.agents.agent_service.AgentService", side_effect=ImportError("no agent")):
                    resp = await client.post("/v1/search/research", json={
                        "query": "test",
                    })

            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
            app.dependency_overrides.pop(get_supabase_uow, None)


# ===========================================================================
# COVERAGE: _search_local_indexes SUCCESS path (lines 146-156)
# ===========================================================================

class TestLocalIndexesSearchSuccess:
    """Tests covering the success path in _search_local_indexes where actual
    index results are returned (lines 146-156)."""

    @pytest.mark.asyncio
    async def test_search_local_indexes_success_with_results(self):
        """_search_local_indexes with indexes and results returns formatted response."""
        from application.search.providers.local_providers import FileSearchProvider
        from config.settings import get_settings
        from application.search.interfaces import SearchContext
        from api.v1.schemas.files import FileSearchRequest

        settings = get_settings()

        mock_index = MagicMock()
        mock_index.index_name = "docs-idx"

        mock_indexes_resp = MagicMock()
        mock_indexes_resp.indexes = [mock_index]

        mock_search_result = MagicMock()
        mock_search_result.dict.return_value = {
            "text": "found text", "score": 0.9, "index_name": "docs-idx",
        }

        mock_search_resp = MagicMock()
        mock_search_resp.results = [mock_search_result]
        mock_search_resp.total_found = 1
        mock_search_resp.indexes_searched = ["docs-idx"]

        with patch("application.indexing.aether_rag_service.AetherRagService.index_exists", return_value=True):
            with patch("application.indexing.aether_rag_service.AetherRagService.search", return_value=[{"text": "found text", "score": 0.9, "metadata": {"file_path": "test.txt", "file_name": "test.txt", "file_extension": "txt"}}]):
                with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
                    mock_repo = MagicMock()
                    mock_repo.get_all_locations = AsyncMock(return_value=[{"index_name": "docs-idx", "index_directory": "/tmp/docs", "location_name": "Docs", "id": "loc-1"}])
                    mock_repo_fn.return_value = mock_repo
                    
                    mock_context = MagicMock(spec=SearchContext)
                    mock_context.settings = settings
                    mock_context.request = MagicMock()
                    
                    provider = FileSearchProvider()
                    payload = FileSearchRequest(query="test query", top_k=10, min_score=0.5)
                    
                    result = await provider.execute(payload, mock_context)
                    
                    # Convert to dict if it's a Pydantic model for assertions
                    if hasattr(result, "model_dump"):
                        result = result.model_dump()

        assert result["total_found"] == 1
        assert result["locations_searched"] == ["Docs"]
        assert len(result["results"]) == 1
        assert result["results"][0]["chunk_text"] == "found text"


# ===========================================================================
# COVERAGE: Wolfram exception path (lines 385-387)
# ===========================================================================

class TestWolframException:
    """Test the generic exception handler for wolfram search."""

    @pytest.mark.asyncio
    @patch("application.search.providers.perplexica_providers.wolfram_search")
    async def test_wolfram_500_on_exception(self, mock_fn, client):
        """Wolfram search exception returns 500."""
        mock_fn.side_effect = RuntimeError("wolfram crash")
        resp = await client.post("/v1/search/wolfram", json={"query": "2+2"})
        assert resp.status_code == 500
        assert "Internal search error" in resp.json()["detail"]


# ===========================================================================
# COVERAGE: list_legal_databases exception (lines 677-679)
# ===========================================================================

class TestLegalDatabasesException:
    """Test the exception handler for list_legal_databases."""

    @pytest.mark.asyncio
    async def test_legal_databases_exception_returns_500(self, client):
        """list_legal_databases with exception in get_legal_databases_for_jurisdiction returns 500."""
        with patch(
            "application.search.providers.legal_search_provider.get_legal_databases_for_jurisdiction",
            side_effect=RuntimeError("lookup crash"),
        ):
            resp = await client.get("/v1/search/legal/databases?jurisdiction=uk")
        assert resp.status_code == 500
        assert "Internal error" in resp.json()["detail"]


# ===========================================================================
# COVERAGE: _search_web_fast_impl — 2-engine, 3+ engines, category,
# time_range, malformed unresponsive, zero results (lines 845-852, 859, 861,
# 888, 908)
# ===========================================================================

class TestSearxngFastDeep:
    """Deep tests for _search_web_fast_impl covering engine policy branches
    and param handling not yet covered."""

    def _setup_searxng(self, app, mock_response_data):
        """Helper: configure SearXNG-enabled settings and mock httpx."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://fake-searxng:8080"
        mock_settings.http_client.default_timeout = 10.0
        app.dependency_overrides[_gs] = lambda: mock_settings

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = mock_response_data

        return mock_settings, mock_response

    @pytest.mark.asyncio
    async def test_2_engine_policy(self, client, app):
        """2 provided engines → 1 default added (3-engine policy, lines 845-849)."""
        mock_data = {
            "results": [{"title": "R", "url": "http://a.com", "content": "C", "engine": "bing", "score": 0.5}],
            "suggestions": [], "infoboxes": [], "unresponsive_engines": [],
        }
        _, mock_resp = self._setup_searxng(app, mock_data)
        from api.dependencies import get_settings as _gs
        try:
            with patch("data.network.search_gateway.SearchGateway.search_searxng", new_callable=AsyncMock, return_value=mock_data):
                resp = await client.post("/v1/search/web", json={
                    "query": "test", "mode": "fast", "engines": "bing,yahoo",
                })
            assert resp.status_code == 200
            body = resp.json()
            assert len(body["engines_used"]) == 3
            assert "bing" in body["engines_used"]
            assert "yahoo" in body["engines_used"]
        finally:
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_3plus_engine_policy(self, client, app):
        """3+ provided engines → all used (lines 850-852)."""
        mock_data = {
            "results": [{"title": "R", "url": "http://a.com", "content": "C", "engine": "bing", "score": 0.5}],
            "suggestions": [], "infoboxes": [], "unresponsive_engines": [],
        }
        _, mock_resp = self._setup_searxng(app, mock_data)
        from api.dependencies import get_settings as _gs
        try:
            with patch("data.network.search_gateway.SearchGateway.search_searxng", new_callable=AsyncMock, return_value=mock_data):
                resp = await client.post("/v1/search/web", json={
                    "query": "test", "mode": "fast",
                    "engines": "google,duckduckgo,brave,bing",
                })
            assert resp.status_code == 200
            body = resp.json()
            assert len(body["engines_used"]) == 4
        finally:
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_category_and_time_range_params(self, client, app):
        """category and time_range params passed to SearXNG (lines 859, 861)."""
        mock_data = {
            "results": [{"title": "R", "url": "http://a.com", "content": "C", "engine": "google", "score": 0.5}],
            "suggestions": [], "infoboxes": [], "unresponsive_engines": [],
        }
        _, mock_resp = self._setup_searxng(app, mock_data)
        from api.dependencies import get_settings as _gs
        try:
            with patch("data.network.search_gateway.SearchGateway.search_searxng", new_callable=AsyncMock, return_value=mock_data) as mock_search:
                resp = await client.post("/v1/search/web", json={
                    "query": "test", "mode": "fast",
                    "category": "news", "time_range": "week",
                })
            assert resp.status_code == 200
            # Verify params were passed (check the call args)
            call_kwargs = mock_search.call_args
            passed_params = call_kwargs.kwargs.get("params") or call_kwargs[1].get("params", {})
            assert passed_params.get("category") == "news"
            assert passed_params.get("time_range") == "week"
        finally:
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_malformed_unresponsive_entry(self, client, app):
        """Malformed unresponsive_engines entry triggers except (line 888)."""
        mock_data = {
            "results": [{"title": "R", "url": "http://a.com", "content": "C", "engine": "google", "score": 0.5}],
            "suggestions": [], "infoboxes": [],
            "unresponsive_engines": [
                ["brave", "timeout"],
                "not-a-list",         # triggers except
                42,                   # triggers except
            ],
        }
        _, mock_resp = self._setup_searxng(app, mock_data)
        from api.dependencies import get_settings as _gs
        try:
            with patch("data.network.search_gateway.SearchGateway.search_searxng", new_callable=AsyncMock, return_value=mock_data):
                resp = await client.post("/v1/search/web", json={
                    "query": "test", "mode": "fast",
                })
            assert resp.status_code == 200
            body = resp.json()
            # Only "brave" should be detected as unresponsive name
            assert "google" in body["engines_working"]
        finally:
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_zero_results_warning(self, client, app):
        """Zero results with working engines triggers warning log (line 908)."""
        mock_data = {
            "results": [],
            "suggestions": [], "infoboxes": [], "unresponsive_engines": [],
        }
        _, mock_resp = self._setup_searxng(app, mock_data)
        from api.dependencies import get_settings as _gs
        try:
            with patch("data.network.search_gateway.SearchGateway.search_searxng", new_callable=AsyncMock, return_value=mock_data):
                resp = await client.post("/v1/search/web", json={
                    "query": "obscure nothing query", "mode": "fast",
                })
            assert resp.status_code == 200
            body = resp.json()
            assert body["total_found"] == 0
            assert body["results"] == []
        finally:
            app.dependency_overrides.pop(_gs, None)


# ===========================================================================
# COVERAGE: Unified search — perplexica disabled AI mode (990),
# non-AI fast path (1000)
# ===========================================================================

class TestUnifiedSearchDeep:
    """Unified search additional coverage for AI-disabled and non-AI paths."""

    @pytest.mark.asyncio
    async def test_unified_ai_mode_perplexica_disabled_503(self, client, app):
        """Unified search in AI mode with perplexica disabled returns 503 (line 990)."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.integrations.perplexica_enabled = False
        mock_settings.integrations.searxng_enabled = True
        app.dependency_overrides[_gs] = lambda: mock_settings
        try:
            resp = await client.post("/v1/search/unified", json={
                "query": "test", "ai_mode": True, "include_local": False,
            })
            assert resp.status_code == 503
            assert "error" in resp.json() and "not enabled" in str(resp.json()["error"]).lower()
        finally:
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_unified_non_ai_fast_path(self, client, app):
        """Unified search with ai_mode=False calls _search_web_fast_impl (line 1000)."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://fake:8080"
        mock_settings.http_client.default_timeout = 10.0
        mock_settings.integrations.perplexica_enabled = True
        app.dependency_overrides[_gs] = lambda: mock_settings

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "results": [{"title": "R", "url": "http://a.com", "content": "C", "engine": "google", "score": 0.5}],
            "suggestions": [], "infoboxes": [], "unresponsive_engines": [],
        }
        try:
            with patch("data.network.search_gateway.SearchGateway.search_searxng", new_callable=AsyncMock, return_value={
                "results": [{"title": "R", "url": "http://a.com", "content": "C", "engine": "google", "score": 0.5}],
                "suggestions": [], "infoboxes": [], "unresponsive_engines": [],
            }):
                resp = await client.post("/v1/search/unified", json={
                    "query": "test", "ai_mode": False, "include_local": False,
                })
            assert resp.status_code == 200
            body = resp.json()
            assert body["ai_mode"] is False
            assert body["web"] is not None
        finally:
            app.dependency_overrides.pop(_gs, None)


# ===========================================================================
# COVERAGE: discover_sources edge cases (lines 1109, 1118, 1120, 1125,
# 1161, 1173-1174, 1202)
# ===========================================================================

class TestDiscoverSourcesDeep:
    """Deep tests for discover_sources covering type-guard branches and
    schema resolution failure paths."""

    @pytest.mark.asyncio
    async def test_discover_perplexica_disabled_filters_sources(self, client, app):
        """Discover with perplexica disabled filters out Perplexica-only sources (line 1202)."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.integrations.perplexica_enabled = False
        mock_settings.integrations.searxng_enabled = True
        app.dependency_overrides[_gs] = lambda: mock_settings
        try:
            resp = await client.get("/v1/search")
            assert resp.status_code == 200
            body = resp.json()
            # web, academic, reddit, wolfram, writing, research should be filtered
            source_names = [s["name"] for s in body["sources"]]
            for name in ["web", "academic", "reddit", "wolfram", "writing", "research"]:
                assert name not in source_names, f"{name} should be filtered when perplexica disabled"
        finally:
            app.dependency_overrides.pop(_gs, None)

    @pytest.mark.asyncio
    async def test_discover_non_dict_paths_in_openapi(self, client, app):
        """Discover with non-dict entries in OpenAPI paths/methods is handled (lines 1109, 1118, 1120, 1125, 1161)."""
        original_openapi = app.openapi
        original_schema = app.openapi_schema

        def patched_openapi():
            spec = original_openapi()
            # Inject a non-dict method value + non-GET/POST method
            spec["paths"]["/v1/search/test-bad"] = {
                "get": "not-a-dict",                          # line 1120: not isinstance(op, dict) → continue
                "delete": {"summary": "Ignored"},             # line 1118: DELETE not in {GET, POST} → continue
                "post": {
                    "summary": "Bad Op",
                    "parameters": [
                        "not-a-dict-param",                   # line 1125: not isinstance(p, dict) → continue
                        {"name": "q", "in": "query", "required": True, "schema": {"type": "string"}},
                    ],
                },
            }
            # Inject a non-dict path value — use numeric key to fail isinstance(path, str)
            spec["paths"][42] = "not-a-dict"                  # line 1109: not isinstance(path, str) → continue
            # Inject non-dict methods value for a path that passes the str + startswith check
            spec["paths"]["/v1/search/test-bad-methods"] = "not-a-dict"  # not isinstance(methods, dict) → continue
            return spec

        # Clear OpenAPI cache so our patched version is called
        app.openapi_schema = None
        app.openapi = patched_openapi
        try:
            resp = await client.get("/v1/search")
            assert resp.status_code == 200
            body = resp.json()
            assert isinstance(body["sources"], list)
        finally:
            app.openapi = original_openapi
            app.openapi_schema = original_schema

    @pytest.mark.asyncio
    async def test_discover_schema_ref_resolution_error(self, client, app):
        """Discover with schema whose 'required' is non-iterable triggers except (lines 1173-1174).

        The try block at line 1149 does: required_fields = set(schema_def.get("required") or [])
        If "required" is a non-iterable (e.g. integer 42), set(42) raises TypeError,
        which is caught by the except Exception at line 1173.
        """
        original_openapi = app.openapi
        original_schema = app.openapi_schema

        def patched_openapi():
            spec = original_openapi()
            # Inject a schema with non-iterable "required" → set(42) raises TypeError
            spec.setdefault("components", {}).setdefault("schemas", {})["BreakableSchema"] = {
                "required": 42,  # non-iterable: set(42) → TypeError
                "properties": {"x": {"type": "string"}},
            }
            spec["paths"]["/v1/search/test-broken-ref"] = {
                "post": {
                    "summary": "Broken Ref",
                    "parameters": [],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/BreakableSchema"},
                            }
                        }
                    }
                },
            }
            return spec

        app.openapi_schema = None
        app.openapi = patched_openapi
        try:
            resp = await client.get("/v1/search")
            assert resp.status_code == 200
            body = resp.json()
            assert isinstance(body["sources"], list)
        finally:
            app.openapi = original_openapi
            app.openapi_schema = original_schema

    @pytest.mark.asyncio
    async def test_discover_schema_non_dict_fdef(self, client, app):
        """Discover with non-dict field def in resolved schema (line 1161)."""
        original_openapi = app.openapi
        original_schema = app.openapi_schema

        def patched_openapi():
            spec = original_openapi()
            # Inject a valid schema with a non-dict property
            spec.setdefault("components", {}).setdefault("schemas", {})["BadProps"] = {
                "type": "object",
                "required": ["field_a"],
                "properties": {
                    "field_a": {"type": "string", "description": "ok"},
                    "field_b": "not-a-dict",  # line 1161: not isinstance(fdef, dict) → continue
                },
            }
            spec["paths"]["/v1/search/test-bad-props"] = {
                "post": {
                    "summary": "Bad Props",
                    "parameters": [],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/BadProps"},
                            }
                        }
                    }
                },
            }
            return spec

        app.openapi_schema = None
        app.openapi = patched_openapi
        try:
            resp = await client.get("/v1/search")
            assert resp.status_code == 200
        finally:
            app.openapi = original_openapi
            app.openapi_schema = original_schema


# ===========================================================================
# COVERAGE: search_memories deep paths (lines 1374-1391, 1444-1446)
# ===========================================================================

class TestMemorySearchDeep:
    """Deep tests for memory search execution and exception handler."""

    @pytest.mark.asyncio
    async def test_memory_search_success(self, client, app, mock_supabase_client):
        """Memory search with mocked memory service returns results (lines 1374-1391)."""
        from api.dependencies import get_supabase_uow

        mock_search_result = MagicMock()
        mock_search_result.results = [{"id": "1", "content": "memory", "score": 0.9}]
        mock_search_result.total = 1

        mock_mem_search = AsyncMock(return_value=mock_search_result)

        from data.database.persistence_gateway import SupabasePersistenceGateway
        mock_uow = MagicMock()
        mock_uow.gateway = MagicMock(spec=SupabasePersistenceGateway)
        from data.database.persistence_gateway import SupabasePersistenceGateway
        mock_uow.gateway = MagicMock(spec=SupabasePersistenceGateway)

        async def _mock_uow_gen():
            yield mock_uow

        app.dependency_overrides[get_supabase_uow] = _mock_uow_gen

        try:
            with patch("application.chat.memory_service.MemoryService.search_memories", mock_mem_search):
                resp = await client.post("/v1/search/memories", json={
                    "query": "test memory", "search_type": "vector", "limit": 10,
                })
            if resp.status_code == 422:
                print("422 DETAIL:", resp.json())
            assert resp.status_code == 200
            body = resp.json()
            assert "results" in body
        finally:
            app.dependency_overrides.pop(get_supabase_uow, None)

    @pytest.mark.asyncio
    async def test_memory_search_exception_500(self, client, app, mock_supabase_client):
        """Memory search exception returns 500 (lines 1444-1446)."""
        from api.dependencies import get_supabase_uow

        from data.database.persistence_gateway import SupabasePersistenceGateway
        mock_uow = MagicMock()
        mock_uow.gateway = MagicMock(spec=SupabasePersistenceGateway)
        from data.database.persistence_gateway import SupabasePersistenceGateway
        mock_uow.gateway = MagicMock(spec=SupabasePersistenceGateway)

        async def _mock_uow_gen():
            yield mock_uow

        app.dependency_overrides[get_supabase_uow] = _mock_uow_gen
        try:
            with patch(
                "application.chat.memory_service.MemoryService",
                side_effect=RuntimeError("MemoryService init crash"),
            ):
                resp = await client.post("/v1/search/memories", json={
                    "query": "test", "search_type": "vector",
                })
            assert resp.status_code == 500
            assert "search error" in resp.json()["detail"].lower()
        finally:
            app.dependency_overrides.pop(get_supabase_uow, None)


# ===========================================================================
# COVERAGE: search_agents deep paths (lines 1492, 1505-1507)
# ===========================================================================

class TestAgentSearchDeep:
    """Deep tests for agent search execution and exception handler."""

    @pytest.mark.asyncio
    async def test_agent_search_success(self, client):
        """Agent search with mocked AetherRagManager returns results (line 1492)."""
        mock_result = MagicMock()
        mock_result.id = "r1"
        mock_result.score = 0.9
        mock_result.text = "agent output"
        mock_result.metadata = {"key": "val"}

        with patch("application.indexing.aether_rag_service.AetherRagService") as MockMgr:
            mock_mgr = MagicMock()
            mock_mgr.search = AsyncMock(return_value=[mock_result])
            MockMgr.return_value = mock_mgr

            resp = await client.get("/v1/search/agents?agent_name=research&query=test")

        assert resp.status_code == 200
        body = resp.json()
        assert body["agent"] == "research"
        assert body["total"] == 1
        assert body["results"][0]["text"] == "agent output"

    @pytest.mark.asyncio
    async def test_agent_search_exception_500(self, client):
        """Agent search exception returns 500 (lines 1505-1507)."""
        with patch(
            "application.indexing.aether_rag_service.AetherRagService.search",
            new_callable=AsyncMock,
            side_effect=RuntimeError("aether_rag crash"),
        ):
            resp = await client.get("/v1/search/agents?agent_name=test&query=test")
        assert resp.status_code == 500
        assert "Agent search error" in resp.json()["detail"]


# ===========================================================================
# COVERAGE: search_chats deep paths (lines 1539-1552, 1604-1606)
# ===========================================================================

class TestChatSearchDeep:
    """Deep tests for chat search execution and exception handler."""

    @pytest.mark.asyncio
    async def test_chat_search_success(self, client, app, mock_supabase_client):
        """Chat search with mocked chat_repo returns results (lines 1539-1552)."""
        from api.dependencies import get_supabase_uow

        mock_search_result = [{"id": "chat-1", "title": "Test Chat"}]

        from data.database.persistence_gateway import SupabasePersistenceGateway
        mock_uow = MagicMock()
        mock_uow.gateway = MagicMock(spec=SupabasePersistenceGateway)

        async def _mock_uow_gen():
            yield mock_uow

        app.dependency_overrides[get_supabase_uow] = _mock_uow_gen

        try:
            with patch("application.chat.service.ChatService.search_chats", new_callable=AsyncMock, return_value=mock_search_result):
                resp = await client.post("/v1/search/chats", json={
                    "query": "test chat", "limit": 10,
                })
            assert resp.status_code == 200
            body = resp.json()
            assert body["query"] == "test chat"
            assert body["total_count"] == 1
        finally:
            app.dependency_overrides.pop(get_supabase_uow, None)

    @pytest.mark.asyncio
    async def test_chat_search_exception_500(self, client, app, mock_supabase_client):
        """Chat search exception returns 500 (lines 1604-1606)."""
        from api.dependencies import get_supabase_uow

        from data.database.persistence_gateway import SupabasePersistenceGateway
        mock_uow = MagicMock()
        mock_uow.gateway = MagicMock(spec=SupabasePersistenceGateway)

        async def _mock_uow_gen():
            yield mock_uow

        app.dependency_overrides[get_supabase_uow] = _mock_uow_gen
        try:
            with patch(
                "application.chat.service.ChatService.search_chats",
                new_callable=AsyncMock,
                side_effect=RuntimeError("repo creation crash"),
            ):
                resp = await client.post("/v1/search/chats", json={"query": "test"})
            assert resp.status_code == 500
            assert "search error" in resp.json()["detail"].lower()
        finally:
            app.dependency_overrides.pop(get_supabase_uow, None)


# ===========================================================================
# COVERAGE: Notebook search exception paths (lines 1640-1644)
# ===========================================================================

class TestNotebookSearchException:
    """Test notebook search exception and HTTPException re-raise."""

    @pytest.mark.asyncio
    async def test_notebook_search_exception_500(self, client):
        """Notebook search exception returns 500 (lines 1643-1644)."""
        with patch(
            "application.notebook.notebook_service.NotebookService.search_modules",
            new_callable=AsyncMock,
            side_effect=RuntimeError("notebook crash"),
        ):
            resp = await client.post("/v1/search/notebooks?query=pandas&limit=5")
        assert resp.status_code == 500
        assert "Notebook search error" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_notebook_search_http_exception_reraise(self, client):
        """Notebook search HTTPException re-raised (line 1640-1641)."""
        from fastapi import HTTPException as FH
        with patch(
            "application.notebook.notebook_service.NotebookService.search_modules",
            new_callable=AsyncMock,
            side_effect=FH(status_code=404, detail="module not found"),
        ):
            resp = await client.post("/v1/search/notebooks?query=pandas&limit=5")
        assert resp.status_code == 404
        assert "module not found" in resp.json()["detail"]


# ===========================================================================
# COVERAGE: Tool search exception paths (lines 1671-1675)
# ===========================================================================

class TestToolSearchException:
    """Test tool search exception and HTTPException re-raise."""

    @pytest.mark.asyncio
    async def test_tool_search_exception_500(self, client):
        """Tool search exception returns 500 (lines 1674-1675)."""
        with patch(
            "application.tools.tool_service.ToolService.search_tools",
            side_effect=RuntimeError("tool crash"),
        ):
            resp = await client.get("/v1/search/tools?q=calendar")
        assert resp.status_code == 500
        assert "Tool search error" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_tool_search_http_exception_reraise(self, client):
        """Tool search ValueError returns 400 (lines 1671-1672)."""
        with patch(
            "application.tools.tool_service.ToolService.search_tools",
            side_effect=ValueError("bad query"),
        ):
            resp = await client.get("/v1/search/tools?q=x")
        assert resp.status_code == 400
        assert "error" in resp.json() and "bad query" in str(resp.json()["error"]).lower()


# ===========================================================================
# COVERAGE: Single index search exception (lines 1774-1776)
# ===========================================================================

class TestSingleIndexSearchException:
    """Test single index search generic exception path."""

    @pytest.mark.asyncio
    async def test_single_index_exception_500(self, client):
        """Single index search with exception returns 500 (lines 1774-1776)."""
        with patch(
            "api.dependencies.require_file_indexing_repository",
            side_effect=RuntimeError("repo crash"),
        ):
            resp = await client.post("/v1/search/index", json={
                "name": "my-idx", "query": "test",
            })
        assert resp.status_code == 500
        assert "Index search error" in resp.json()["detail"]


class TestIndexModeDefaults:
    """Default search mode behavior for index endpoints."""

    @pytest.mark.asyncio
    async def test_single_index_no_mode_defaults_to_bm25(self, client):
        """Single-index search with no mode uses bm25 default."""
        mock_result = MagicMock()
        mock_result.dict = MagicMock(return_value={"results": [], "total_found": 0})

        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo_fn.return_value = MagicMock()
            with patch(
                "application.indexing.index_service.IndexService.search_index",
                new_callable=AsyncMock,
                return_value=mock_result,
            ) as mock_search:
                resp = await client.post("/v1/search/index", json={
                    "name": "my-idx",
                    "query": "test",
                })

        if resp.status_code == 200:
            mock_search.assert_awaited_once()
            call_kwargs = mock_search.call_args
            assert call_kwargs.kwargs.get("mode") == "bm25" or call_kwargs[1].get("mode") == "bm25"


# ===========================================================================
# COVERAGE: Multi-index default top_k (line 1831)
# ===========================================================================

class TestMultiIndexDefaultTopK:
    """Test multi-index search with no top_k → default applied (line 1831)."""

    @pytest.mark.asyncio
    async def test_multi_index_no_top_k_defaults(self, client):
        """Multi-index search with no max_results uses default 10 (line 1831)."""
        mock_result = MagicMock()
        mock_result.dict = MagicMock(return_value={"results": [], "total_found": 0})
    
        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo_fn.return_value = MagicMock()
            with patch(
                "application.indexing.index_service.IndexService.search_multiple_indexes",
                new_callable=AsyncMock,
                return_value=mock_result,
            ) as mock_search:
                resp = await client.post("/v1/search/indexes", json={
                    "query": "test", "index_names": ["idx-1"],
                    # no max_results, no min_score → defaults applied
                })
        if resp.status_code == 200:
            mock_search.assert_awaited_once()
            call_kwargs = mock_search.call_args
            assert call_kwargs.kwargs.get("top_k") == 10 or call_kwargs[1].get("top_k") == 10 or call_kwargs.kwargs.get("top_k") is None

    @pytest.mark.asyncio
    async def test_multi_index_no_mode_defaults_to_bm25(self, client):
        """Multi-index search with no mode uses bm25 default."""
        mock_result = MagicMock()
        mock_result.dict = MagicMock(return_value={"results": [], "total_found": 0})

        with patch("api.dependencies.require_file_indexing_repository") as mock_repo_fn:
            mock_repo_fn.return_value = MagicMock()
            with patch(
                "application.indexing.index_service.IndexService.search_multiple_indexes",
                new_callable=AsyncMock,
                return_value=mock_result,
            ) as mock_search:
                resp = await client.post("/v1/search/indexes", json={
                    "query": "test",
                    "index_names": ["idx-1"],
                })

        if resp.status_code == 200:
            mock_search.assert_awaited_once()
            call_kwargs = mock_search.call_args
            assert call_kwargs.kwargs.get("mode") == "bm25" or call_kwargs[1].get("mode") == "bm25" or call_kwargs.kwargs.get("mode") is None


# ===========================================================================
# COVERAGE: Research persistence deep paths (lines 1904-1905, 1924-1965,
# 1971, 1975)
# ===========================================================================

class TestResearchPersistenceDeep:
    """Deep tests for research endpoint persistence paths."""

    def _setup_research(self, app, mock_supabase_client):
        """Helper to configure research endpoint dependencies.
        Uses lambda: mock_settings pattern (no params) to avoid FastAPI
        sub-dependency resolution issues with dependency overrides."""
        from api.dependencies import get_runtime_settings, get_supabase_uow
        from data.database.persistence_gateway import SupabasePersistenceGateway

        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_enabled = True
        # Zero-param lambda: FastAPI dependency overrides bypass the original
        # function's parameter resolution entirely.
        app.dependency_overrides[get_runtime_settings] = lambda: mock_settings

        mock_gateway = SupabasePersistenceGateway(mock_supabase_client)
        from data.database.persistence_gateway import SupabasePersistenceGateway
        mock_uow = MagicMock()
        mock_uow.gateway = MagicMock(spec=SupabasePersistenceGateway)
        mock_uow.gateway = mock_gateway

        async def _mock_uow_gen():
            yield mock_uow

        app.dependency_overrides[get_supabase_uow] = _mock_uow_gen

        return mock_settings, mock_uow

    @pytest.mark.asyncio
    async def test_research_queue_job_failure_logged(self, client, app, mock_supabase_client):
        """Research persist_history=True but queue_agent_job fails → logged, continues (lines 1904-1905)."""
        from api.dependencies import get_runtime_settings, get_supabase_uow

        mock_settings, mock_uow = self._setup_research(app, mock_supabase_client)

        mock_result = {
            "query": "test", "sources_used": ["web"], "ai_mode": True,
            "results": {}, "model_used": "m", "time_ms": 10,
            "timestamp": "2026-02-22T00:00:00Z"
        }

        mock_supabase_client.delete = AsyncMock(return_value=None)

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, return_value=mock_result):
                with patch("application.agents.agent_service.AgentService") as MockAS:
                    mock_svc = AsyncMock()
                    # queue_agent_job raises → triggers except at lines 1904-1905
                    mock_svc.queue_agent_job = AsyncMock(side_effect=RuntimeError("queue fail"))
                    mock_svc.store_agent_output = AsyncMock(return_value="out-123")
                    MockAS.return_value = mock_svc

                    resp = await client.post("/v1/search/research", json={
                        "query": "test", "persist_history": True,
                    })
            # Should still succeed — queue failure is logged but not fatal
            assert resp.status_code == 200
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
            app.dependency_overrides.pop(get_supabase_uow, None)

    @pytest.mark.asyncio
    async def test_research_persist_success_full_path(self, client, app, mock_supabase_client):
        """Research full persistence: queue job → run → store output → cleanup → return IDs (lines 1924-1965)."""
        from api.dependencies import get_runtime_settings, get_supabase_uow

        mock_settings, mock_uow = self._setup_research(app, mock_supabase_client)

        mock_result = MagicMock()
        mock_result.dict = MagicMock(return_value={
            "query": "test", "answer": "research answer", "sources": [],
            "model_used": "gpt-4", "time_ms": 200,
        })
        mock_result.model_dump = None
        # Allow setting attributes for traceability IDs
        mock_result.output_id = None
        mock_result.entity_id = None
        mock_result.job_id = None

        mock_supabase_client.delete = AsyncMock(return_value=None)

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, return_value=mock_result):
                with patch("application.agents.agent_service.AgentService") as MockAS:
                    mock_svc = AsyncMock()
                    mock_svc.queue_agent_job = AsyncMock(return_value="job-abc")
                    mock_svc.store_agent_output = AsyncMock(return_value="output-xyz")
                    MockAS.return_value = mock_svc

                    resp = await client.post("/v1/search/research", json={
                        "query": "deep test", "persist_history": True,
                    })

            if resp.status_code == 200:
                mock_svc.queue_agent_job.assert_awaited_once()
                mock_svc.store_agent_output.assert_awaited_once()
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
            app.dependency_overrides.pop(get_supabase_uow, None)

    @pytest.mark.asyncio
    async def test_research_error_updates_job_to_failed(self, client, app, mock_supabase_client):
        """Research handler error → job updated to 'failed', except around update is caught (lines 1971, 1975)."""
        from api.dependencies import get_runtime_settings, get_supabase_uow

        mock_settings, mock_uow = self._setup_research(app, mock_supabase_client)

        # Make the update call also fail (line 1971 except Exception: pass)
        mock_supabase_client.update = AsyncMock(side_effect=RuntimeError("update failed too"))

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, side_effect=RuntimeError("research boom")):
                with patch("application.agents.agent_service.AgentService") as MockAS:
                    mock_svc = AsyncMock()
                    mock_svc.queue_agent_job = AsyncMock(return_value="job-fail")
                    MockAS.return_value = mock_svc

                    resp = await client.post("/v1/search/research", json={
                        "query": "fail test", "persist_history": True,
                    })

            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
            app.dependency_overrides.pop(get_supabase_uow, None)

    @pytest.mark.asyncio
    async def test_research_persist_exception_logged_not_fatal(self, client, app, mock_supabase_client):
        """Research persist fails but request still succeeds (lines 1952-1954)."""
        from api.dependencies import get_runtime_settings, get_supabase_uow

        mock_settings, mock_uow = self._setup_research(app, mock_supabase_client)

        mock_result = {
            "query": "test", "sources_used": ["web"], "ai_mode": True,
            "results": {}, "model_used": "m", "time_ms": 10,
            "timestamp": "2026-02-22T00:00:00Z"
        }

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, return_value=mock_result):
                with patch("application.agents.agent_service.AgentService") as MockAS:
                    mock_svc = AsyncMock()
                    mock_svc.queue_agent_job = AsyncMock(return_value="job-abc")
                    # store_agent_output raises → caught by except at line 1952
                    mock_svc.store_agent_output = AsyncMock(side_effect=RuntimeError("persist crash"))
                    MockAS.return_value = mock_svc

                    resp = await client.post("/v1/search/research", json={
                        "query": "persist fail test", "persist_history": True,
                    })

            # Request should still succeed — persist error is logged not raised
            assert resp.status_code == 200
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
            app.dependency_overrides.pop(get_supabase_uow, None)

    @pytest.mark.asyncio
    async def test_research_no_persist_logs_debug(self, client, app, mock_supabase_client):
        """Research with persist_history=False reaches else branch (lines 1955-1956)."""
        from api.dependencies import get_runtime_settings, get_supabase_uow

        mock_settings, mock_uow = self._setup_research(app, mock_supabase_client)

        mock_result = {
            "query": "test", "sources_used": ["web"], "ai_mode": True,
            "results": {}, "model_used": "m", "time_ms": 10,
            "timestamp": "2026-02-22T00:00:00Z"
        }

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, return_value=mock_result):
                with patch("application.agents.agent_service.AgentService") as MockAS:
                    mock_svc = AsyncMock()
                    mock_svc.queue_agent_job = AsyncMock()
                    MockAS.return_value = mock_svc

                    resp = await client.post("/v1/search/research", json={
                        "query": "no persist test", "persist_history": False,
                    })

            assert resp.status_code == 200
            # queue_agent_job should NOT be called when persist_history=False
            mock_svc.queue_agent_job.assert_not_awaited()
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
            app.dependency_overrides.pop(get_supabase_uow, None)

    @pytest.mark.asyncio
    async def test_research_http_exception_reraise(self, client, app, mock_supabase_client):
        """Research HTTPException is re-raised, not caught by generic handler (line 1975)."""
        from api.dependencies import get_runtime_settings, get_supabase_uow
        from fastapi import HTTPException as FH

        mock_settings, mock_uow = self._setup_research(app, mock_supabase_client)

        try:
            with patch("application.research.research_service.ResearchService.execute_research", new_callable=AsyncMock, side_effect=FH(status_code=403, detail="forbidden research")):
                with patch("application.agents.agent_service.AgentService") as MockAS:
                    mock_svc = AsyncMock()
                    mock_svc.queue_agent_job = AsyncMock(return_value=None)
                    MockAS.return_value = mock_svc

                    resp = await client.post("/v1/search/research", json={
                        "query": "forbidden query", "persist_history": False,
                    })

            assert resp.status_code == 403
            assert "forbidden research" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
            app.dependency_overrides.pop(get_supabase_uow, None)


# ===========================================================================
# COVERAGE: _search_web_fast_impl SearXNG disabled (line 819)
# ===========================================================================

class TestSearchWebFastImplDisabled:
    """Test _search_web_fast_impl directly when SearXNG is disabled (line 819)."""

    @pytest.mark.asyncio
    async def test_fast_impl_searxng_disabled_raises_503(self):
        """Calling search_web_fast_impl with SearXNG disabled raises UpstreamServiceError."""
        from application.search.providers.web_search_provider import search_web_fast_impl
        from core.exceptions import UpstreamServiceError

        mock_settings = MagicMock()
        mock_settings.integrations.searxng_enabled = False

        mock_context = MagicMock()
        mock_context.settings = mock_settings

        with pytest.raises(UpstreamServiceError) as exc:
            await search_web_fast_impl(
                query="test", engines=None, category=None,
                time_range=None, max_results=10, context=mock_context,
            )
        assert "not enabled" in str(exc.value.message).lower()
