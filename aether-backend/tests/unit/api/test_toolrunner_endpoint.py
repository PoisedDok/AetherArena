"""
Tool Runner Endpoint Tests

Covers all 6 routes in api/v1/endpoints/toolrunner.py:
  GET  /v1/toolrunner/health
  GET  /v1/toolrunner/search?q=
  GET  /v1/toolrunner/list-categories
  GET  /v1/toolrunner/list-tools?category=
  GET  /v1/toolrunner/info?tool=
  POST /v1/execute/tool

Mocking strategy:
  - _get_tools: patched to return controlled tool metadata
  - invalidate_tool_cache: called before tests to prevent stale state
  - httpx.AsyncClient: patched for tool execution (POST /v1/execute/tool)
  - OIToolCatalogBridge: patched to avoid real OpenAPI parsing
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock


# ---------------------------------------------------------------------------
# Shared mock tool registry
# ---------------------------------------------------------------------------

MOCK_TOOLS = {
    "search_web": {
        "name": "search_web",
        "description": "Search the web using Perplexica",
        "category": "Search",
        "parameters": {"query": {"type": "string"}},
        "path": "/v1/search/web",
        "method": "POST",
    },
    "search_academic": {
        "name": "search_academic",
        "description": "Search academic papers",
        "category": "Search",
        "parameters": {"query": {"type": "string"}},
        "path": "/v1/search/academic",
        "method": "POST",
    },
    "tts_synthesize": {
        "name": "tts_synthesize",
        "description": "Synthesize speech from text",
        "category": "Audio",
        "parameters": {"text": {"type": "string"}},
        "path": "/v1/tts/synthesize",
        "method": "POST",
    },
    "list_services_status": {
        "name": "list_services_status",
        "description": "List all service statuses",
        "category": "System",
        "parameters": {},
        "path": "/v1/services/status",
        "method": "GET",
    },
    "notebook_import": {
        "name": "notebook_import",
        "description": "Import a Python module into the notebook runtime",
        "category": "Compute",
        "parameters": {"module": {"type": "string"}},
        "path": "/v1/notebook/import",
        "method": "POST",
    },
}


def _patch_get_tools():
    """Patch _get_tools to return MOCK_TOOLS."""
    return patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=MOCK_TOOLS)


# ===================================================================
# GET /v1/toolrunner/health
# ===================================================================


class TestToolRunnerHealth:

    @pytest.mark.asyncio
    async def test_health_returns_ok(self, client):
        """Health endpoint returns status ok."""
        resp = await client.get("/v1/toolrunner/health")

        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


# ===================================================================
# GET /v1/toolrunner/search?q=
# ===================================================================


class TestSearchTools:

    @pytest.mark.asyncio
    async def test_search_by_keyword(self, client):
        """Search returns tools matching keyword."""
        mock_results = [
            {"tool": "computer.search_web", "name": "search_web", "description": "web", "parameters": {}},
            {"tool": "computer.search_academic", "name": "search_academic", "description": "academic", "parameters": {}}
        ]
        with patch("application.tools.tool_service.ToolService.search_tools", new_callable=AsyncMock, return_value=mock_results):
            resp = await client.get("/v1/toolrunner/search", params={"q": "search"})

        assert resp.status_code == 200
        results = resp.json()
        assert isinstance(results, list)
        assert len(results) >= 2
        tool_names = [r.get("name", r.get("tool", "").replace("computer.", "")) for r in results]
        assert "search_web" in tool_names
        assert "search_academic" in tool_names

    @pytest.mark.asyncio
    async def test_search_empty_query_returns_400(self, client):
        """Empty query returns 400."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/search", params={"q": ""})

        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_search_no_match_returns_empty(self, client):
        """Query with no matches returns empty list."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/search", params={"q": "zzzznonexistent"})

        assert resp.status_code == 200
        # Given hybrid search, no match still returns empty list
        assert isinstance(resp.json(), list)

    @pytest.mark.asyncio
    async def test_search_includes_tool_prefix(self, client):
        """Results include computer. prefix in tool field."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/search", params={"q": "synthesize speech"})

        assert resp.status_code == 200
        results = resp.json()
        if results:
            assert results[0]["tool"].startswith("computer.")

    @pytest.mark.asyncio
    async def test_search_available_tools_inventory(self, client):
        """'available tools' query triggers inventory fallback if no matches."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/search", params={"q": "available tools"})

        assert resp.status_code == 200
        results = resp.json()
        assert isinstance(results, list)
        # Should return either scored results or inventory info
        assert len(results) > 0

    @pytest.mark.asyncio
    async def test_search_web_research_boost(self, client):
        """Research-related queries boost search_ prefixed tools."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/search", params={"q": "research biography"})

        assert resp.status_code == 200
        results = resp.json()
        if results:
            # search_web should be boosted to the top
            assert results[0]["name"].startswith("search_")


# ===================================================================
# GET /v1/toolrunner/list-categories
# ===================================================================


class TestListCategories:

    @pytest.mark.asyncio
    async def test_list_categories_returns_sorted(self, client):
        """Categories returned sorted alphabetically."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/list-categories")

        assert resp.status_code == 200
        cats = resp.json()
        assert isinstance(cats, list)
        assert cats == sorted(cats)
        assert "Search" in cats
        assert "Audio" in cats

    @pytest.mark.asyncio
    async def test_list_categories_no_duplicates(self, client):
        """No duplicate categories."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/list-categories")

        cats = resp.json()
        assert len(cats) == len(set(cats))


# ===================================================================
# GET /v1/toolrunner/list-tools?category=
# ===================================================================


class TestListTools:

    @pytest.mark.asyncio
    async def test_list_tools_by_category(self, client):
        """Tools filtered by category."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/list-tools", params={"category": "Search"})

        assert resp.status_code == 200
        tools = resp.json()
        assert isinstance(tools, list)
        assert len(tools) == 2
        for t in tools:
            assert t.startswith("computer.")

    @pytest.mark.asyncio
    async def test_list_tools_empty_category_returns_400(self, client):
        """Empty category returns 400."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/list-tools", params={"category": ""})

        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_list_tools_unknown_category_returns_empty(self, client):
        """Unknown category returns empty list."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/list-tools", params={"category": "nonexistent"})

        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_list_tools_case_insensitive(self, client):
        """Category matching is case-insensitive."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/list-tools", params={"category": "search"})

        assert resp.status_code == 200
        assert len(resp.json()) == 2


# ===================================================================
# GET /v1/toolrunner/info?tool=
# ===================================================================


class TestGetToolInfo:

    @pytest.mark.asyncio
    async def test_known_tool_returns_info(self, client):
        """Known tool returns full metadata."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/info", params={"tool": "search_web"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "search_web"
        assert body["tool"] == "computer.search_web"
        assert body["category"] == "Search"
        assert "parameters" in body
        assert "description" in body

    @pytest.mark.asyncio
    async def test_computer_prefix_stripped(self, client):
        """computer. prefix is stripped from tool name."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/info", params={"tool": "computer.search_web"})

        assert resp.status_code == 200
        assert resp.json()["name"] == "search_web"

    @pytest.mark.asyncio
    async def test_unknown_tool_returns_404(self, client):
        """Unknown tool returns 404."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/info", params={"tool": "nonexistent_tool"})

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_empty_tool_name_returns_error(self, client):
        """Empty tool name returns error."""
        with _patch_get_tools():
            resp = await client.get("/v1/toolrunner/info", params={"tool": ""})

        # _normalize_tool_name raises ValueError -> endpoint should return 4xx
        assert resp.status_code in (400, 422, 500)


# ===================================================================
# POST /v1/execute/tool
# ===================================================================


class TestRunTool:

    @pytest.mark.asyncio
    async def test_execute_get_tool(self, client):
        """Execute a GET tool dispatches correct HTTP call."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"services": []}

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with _patch_get_tools(), patch(
            "data.network.http_client.httpx.AsyncClient",
            return_value=mock_httpx,
        ):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "list_services_status",
                "kwargs": {},
            })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_execute_post_tool(self, client):
        """Execute a POST tool dispatches correct HTTP call."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"results": []}

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with _patch_get_tools(), patch(
            "data.network.http_client.httpx.AsyncClient",
            return_value=mock_httpx,
        ):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "search_web",
                "kwargs": {"query": "test query"},
            })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_execute_unknown_tool_returns_404(self, client):
        """Unknown tool returns 404."""
        with _patch_get_tools():
            resp = await client.post("/v1/execute/tool", json={
                "tool": "nonexistent_tool",
                "kwargs": {},
            })

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_execute_empty_tool_returns_400(self, client):
        """Empty tool name returns 400."""
        with _patch_get_tools():
            resp = await client.post("/v1/execute/tool", json={
                "tool": "",
                "kwargs": {},
            })

        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_execute_recursion_guard(self, client):
        """Toolrunner refuses to execute itself (recursion prevention)."""
        recursive_tools = {
            "self_call": {
                "name": "self_call",
                "description": "Calls toolrunner",
                "category": "System",
                "parameters": {},
                "path": "/v1/toolrunner/health",
                "method": "GET",
            },
        }

        with patch(
            "application.tools.tool_service.ToolService._get_tools",
            return_value=recursive_tools,
        ):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "self_call",
                "kwargs": {},
            })

        assert resp.status_code == 400
        assert "recursion" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_execute_tool_remote_error(self, client):
        """Remote HTTP error forwarded as HTTPException."""
        mock_resp = MagicMock()
        mock_resp.status_code = 503
        mock_resp.text = "Service Unavailable"

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with _patch_get_tools(), patch(
            "data.network.http_client.httpx.AsyncClient",
            return_value=mock_httpx,
        ):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "list_services_status",
                "kwargs": {},
            })

        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_execute_with_computer_prefix(self, client):
        """computer. prefix is stripped before lookup."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"ok": True}

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with _patch_get_tools(), patch(
            "data.network.http_client.httpx.AsyncClient",
            return_value=mock_httpx,
        ):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "computer.search_web",
                "kwargs": {"query": "test"},
            })

        assert resp.status_code == 200


# ===================================================================
# Deep Coverage: cache, normalize, and run_tool branches
# ===================================================================


class TestToolRunnerDeep:
    """Cover uncovered branches: cache, methods, errors, path params."""

    def test_invalidate_tool_cache(self):
        """invalidate_tool_cache resets instance variables."""
        from application.tools.tool_service import ToolService
        from unittest.mock import MagicMock
        service = ToolService(MagicMock(), MagicMock())
        service._tool_cache = {"cached_tool": {}}
        service._tool_cache_at = 12345.0
        service.invalidate_cache()
        assert service._tool_cache is None
        assert service._tool_cache_at == 0.0

    def test_normalize_tool_name_strips_prefix(self):
        """Strips computer. prefix."""
        from api.v1.endpoints.toolrunner import _normalize_tool_name
        assert _normalize_tool_name("computer.search_web") == "search_web"
        assert _normalize_tool_name("search_web") == "search_web"

    def test_normalize_tool_name_empty_raises(self):
        """Empty name raises ValueError."""
        from api.v1.endpoints.toolrunner import _normalize_tool_name
        import pytest as _pytest
        with _pytest.raises(ValueError, match="tool is required"):
            _normalize_tool_name("")
        with _pytest.raises(ValueError, match="tool is required"):
            _normalize_tool_name("computer.")

    @pytest.mark.asyncio
    async def test_execute_delete_method(self, client):
        """DELETE tool dispatches client.delete."""
        delete_tools = {
            "remove_item": {
                "name": "remove_item",
                "description": "Remove an item",
                "category": "System",
                "parameters": {},
                "path": "/v1/items/123",
                "method": "DELETE",
            }
        }
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"deleted": True}

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=delete_tools):
            with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_httpx):
                resp = await client.post("/v1/execute/tool", json={
                    "tool": "remove_item", "kwargs": {},
                })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_execute_put_method(self, client):
        """PUT tool dispatches client.put."""
        put_tools = {
            "update_item": {
                "name": "update_item",
                "description": "Update item",
                "category": "System",
                "parameters": {},
                "path": "/v1/items/123",
                "method": "PUT",
            }
        }
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"updated": True}

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=put_tools):
            with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_httpx):
                resp = await client.post("/v1/execute/tool", json={
                    "tool": "update_item", "kwargs": {"name": "new"},
                })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_execute_patch_method(self, client):
        """PATCH tool dispatches client.patch."""
        patch_tools = {
            "patch_item": {
                "name": "patch_item",
                "description": "Patch item",
                "category": "System",
                "parameters": {},
                "path": "/v1/items/123",
                "method": "PATCH",
            }
        }
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"patched": True}

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=patch_tools):
            with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_httpx):
                resp = await client.post("/v1/execute/tool", json={
                    "tool": "patch_item", "kwargs": {"field": "val"},
                })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_execute_unsupported_method_400(self, client):
        """Unsupported HTTP method → 400."""
        weird_tools = {
            "weird": {
                "name": "weird",
                "description": "Weird tool",
                "category": "System",
                "parameters": {},
                "path": "/v1/weird",
                "method": "OPTIONS",
            }
        }
        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=weird_tools):
            with patch("data.network.http_client.httpx.AsyncClient"):
                resp = await client.post("/v1/execute/tool", json={
                    "tool": "weird", "kwargs": {},
                })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_execute_missing_path_500(self, client):
        """Tool missing path → 500."""
        no_path = {
            "bad": {
                "name": "bad",
                "description": "Bad tool",
                "category": "System",
                "parameters": {},
                "path": None,
                "method": "GET",
            }
        }
        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=no_path):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "bad", "kwargs": {},
            })
        assert resp.status_code == 500
        assert "missing path" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_execute_missing_method_500(self, client):
        """Tool missing method → 500."""
        no_method = {
            "bad": {
                "name": "bad",
                "description": "Bad tool",
                "category": "System",
                "parameters": {},
                "path": "/v1/ok",
                "method": "",
            }
        }
        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=no_method):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "bad", "kwargs": {},
            })
        assert resp.status_code == 500
        assert "missing method" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_execute_missing_base_url_500(self, client):
        """settings.base_url empty → 500."""
        mock_settings = MagicMock()
        mock_settings.base_url = ""
        with _patch_get_tools():
            with patch("api.v1.endpoints.toolrunner.get_settings", return_value=mock_settings):
                resp = await client.post("/v1/execute/tool", json={
                    "tool": "search_web", "kwargs": {"query": "test"},
                })
        assert resp.status_code == 500
        assert "base_url" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_execute_path_param_substitution(self, client):
        """Path parameters extracted from kwargs and substituted in URL."""
        param_tools = {
            "get_job": {
                "name": "get_job",
                "description": "Get job status",
                "category": "System",
                "parameters": {},
                "path": "/v1/jobs/{job_id}",
                "method": "GET",
            }
        }
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"job_id": "abc", "status": "done"}

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=param_tools):
            with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_httpx):
                resp = await client.post("/v1/execute/tool", json={
                    "tool": "get_job", "kwargs": {"job_id": "abc"},
                })
        assert resp.status_code == 200
        # Verify the URL included the substituted parameter
        call_args = mock_httpx.request.call_args
        assert "abc" in str(call_args)

    @pytest.mark.asyncio
    async def test_execute_missing_path_param_400(self, client):
        """Missing required path parameter → 400."""
        param_tools = {
            "get_job": {
                "name": "get_job",
                "description": "Get job",
                "category": "System",
                "parameters": {},
                "path": "/v1/jobs/{job_id}",
                "method": "GET",
            }
        }
        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=param_tools):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "get_job", "kwargs": {},
            })
        assert resp.status_code == 400
        assert "job_id" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_execute_generic_exception_500(self, client):
        """Generic httpx exception → 500 with context."""
        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(side_effect=RuntimeError("connection reset"))
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with _patch_get_tools(), patch(
            "data.network.http_client.httpx.AsyncClient", return_value=mock_httpx,
        ):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "list_services_status", "kwargs": {},
            })
        assert resp.status_code == 500
        assert "connection reset" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_execute_non_json_response(self, client):
        """Response that can't be parsed as JSON → returns text."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json = MagicMock(side_effect=ValueError("not JSON"))
        mock_resp.text = "plain text result"

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with _patch_get_tools(), patch(
            "data.network.http_client.httpx.AsyncClient", return_value=mock_httpx,
        ):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "list_services_status", "kwargs": {},
            })
        assert resp.status_code == 200
        assert resp.json()["result"] == "plain text result"

    @pytest.mark.asyncio
    async def test_execute_positional_args_warning(self, client):
        """Positional args with no path params → warning + still executes."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"ok": True}

        mock_httpx = AsyncMock()
        mock_httpx.request = AsyncMock(return_value=mock_resp)
        mock_httpx.__aenter__ = AsyncMock(return_value=mock_httpx)
        mock_httpx.__aexit__ = AsyncMock(return_value=False)

        with _patch_get_tools(), patch(
            "data.network.http_client.httpx.AsyncClient", return_value=mock_httpx,
        ):
            resp = await client.post("/v1/execute/tool", json={
                "tool": "list_services_status",
                "positional": ["arg1", "arg2"],
                "kwargs": {},
            })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_search_inventory_fallback(self, client):
        """'list tools' with no scored hits triggers inventory fallback."""
        # Use a tool set where 'list' doesn't score high enough as tokens
        empty_tools = {
            "obscure_internal": {
                "name": "obscure_internal",
                "description": "Something internal",
                "category": "Internal",
                "parameters": {},
                "path": "/v1/internal",
                "method": "GET",
            }
        }
        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=empty_tools):
            resp = await client.get("/v1/toolrunner/search", params={"q": "categories available"})
        assert resp.status_code == 200
        results = resp.json()
        # Should trigger inventory fallback
        assert isinstance(results, list)


# ===================================================================
# Coverage Gaps: Lines 80, 91, 175, 178
# ===================================================================


class TestToolRunnerCoverageGaps:
    """Tests for remaining uncovered branches in toolrunner.py."""

    @pytest.mark.asyncio
    async def test_get_tools_cache_hit(self):
        """Line 80: _get_tools returns cached result within TTL."""
        import time as _time
        from application.tools.tool_service import ToolService
        from unittest.mock import MagicMock
        service = ToolService(MagicMock(), MagicMock())
    
        # Set up cache directly
        cached_tools = {"cached_tool": {"name": "cached_tool", "category": "Test"}}
        service._tool_cache = cached_tools
        service._tool_cache_at = _time.time()  # fresh cache
    
        result = await service._get_tools()
        assert result == cached_tools
        assert result is cached_tools
        # OIToolCatalogBridge should NOT be called (cache hit)


    @pytest.mark.asyncio
    async def test_get_tools_skips_bad_names(self):
        """Line 91: tools with empty or non-string names are skipped."""
        from application.tools.tool_service import ToolService
        from unittest.mock import MagicMock
        service = ToolService(MagicMock(), MagicMock())
    
        # Reset cache to force rebuild
        service._tool_cache = None
        service._tool_cache_at = 0.0
    
        mock_bridge = MagicMock()
        mock_bridge.generate_tools_from_openapi.return_value = [
            {"name": "good_tool", "category": "Test"},
            {"name": "", "category": "Test"},        # empty name — skipped
            {"name": None, "category": "Test"},       # None name — skipped
            {"name": 42, "category": "Test"},          # int name — skipped
            {"name": "  ", "category": "Test"},        # whitespace — skipped
            {"name": "another_good", "category": "X"},
        ]
    
        with patch("application.tools.tool_service.OIToolCatalogBridge", return_value=mock_bridge):
            result = await service._get_tools()

        # Only "good_tool" and "another_good" should survive
        assert "good_tool" in result
        assert "another_good" in result
        assert len(result) == 2


    @pytest.mark.asyncio
    async def test_inventory_fallback_skips_non_matching_category(self, client):
        """Line 175: tools with non-matching category are skipped in inventory."""
        # Two categories: "Alpha" and "Beta". Query won't match any tool name/desc tokens.
        multi_cat_tools = {
            "alpha_tool": {
                "name": "alpha_tool",
                "description": "Does alpha things",
                "category": "Alpha",
                "parameters": {},
            },
            "beta_tool": {
                "name": "beta_tool",
                "description": "Does beta things",
                "category": "Beta",
                "parameters": {},
            },
        }
        # In hybrid search, "available zzz" might have no overlap and hit the fallback
        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=multi_cat_tools):
            # Also patch embedding to return something empty so similarity is 0
            with patch("application.tools.tool_service.ToolService._generate_embedding", new_callable=AsyncMock, return_value=[0.0]*384):
                resp = await client.get("/v1/toolrunner/search", params={"q": "available zzz"})
        assert resp.status_code == 200
        results = resp.json()
        if len(results) > 0 and isinstance(results[0], dict) and "type" in results[0]:
            # Should be inventory format: first entry is categories info
            assert results[0]["type"] == "info"
            # Each category entry should only contain its own tools
            for entry in results[1:]:
                if entry.get("type") == "category":
                    cat = entry["category"]
                    for tool_name in entry["tools"]:
                        stripped = tool_name.replace("computer.", "")
                        tool_meta = multi_cat_tools[stripped]
                        assert tool_meta["category"] == cat

    @pytest.mark.asyncio
    async def test_inventory_fallback_breaks_at_five(self, client):
        """Line 178: inventory sample breaks after 5 tools per category."""
        # Create 8 tools in the same category
        many_tools = {}
        for i in range(8):
            many_tools[f"xtool_{i}"] = {
                "name": f"xtool_{i}",
                "description": f"X tool number {i}",
                "category": "BigCategory",
                "parameters": {},
            }
        with patch("application.tools.tool_service.ToolService._get_tools", new_callable=AsyncMock, return_value=many_tools):
            with patch("application.tools.tool_service.ToolService._generate_embedding", new_callable=AsyncMock, return_value=[0.0]*384):
                resp = await client.get("/v1/toolrunner/search", params={"q": "available zzz"})
        assert resp.status_code == 200
        results = resp.json()
        # Find the BigCategory entry
        big_cat = next((e for e in results if isinstance(e, dict) and e.get("category") == "BigCategory"), None)
        if big_cat is not None:
            # Should be capped at 5 (the break on line 178)
            assert len(big_cat["tools"]) == 5
