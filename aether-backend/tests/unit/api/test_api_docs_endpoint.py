"""
Unit tests for API docs endpoints (api/v1/endpoints/api_docs.py).

6 routes:
  GET  /v1/docs
  GET  /v1/docs/endpoint
  GET  /v1/docs/tags
  GET  /v1/docs/schemas
  GET  /v1/docs/openapi
  GET  /v1/docs/stats

CI: pytest tests/unit/api/test_api_docs_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import patch


# ===========================================================================
# GET /docs — full documentation
# ===========================================================================

class TestGetDocs:
    """Tests for GET /v1/docs."""

    @pytest.mark.asyncio
    async def test_docs_returns_200(self, client):
        """Full docs endpoint returns 200."""
        resp = await client.get("/v1/docs")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_docs_has_required_fields(self, client):
        """Response includes api_name, version, endpoint_groups."""
        resp = await client.get("/v1/docs")
        assert resp.status_code == 200
        body = resp.json()
        assert "api_name" in body
        assert "version" in body
        # Response model uses endpoint_groups
        assert "endpoint_groups" in body
        assert isinstance(body["endpoint_groups"], list)

    @pytest.mark.asyncio
    async def test_docs_without_examples(self, client):
        """Docs with include_examples=false."""
        resp = await client.get("/v1/docs?include_examples=false")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_docs_without_schemas(self, client):
        """Docs with include_schemas=false."""
        resp = await client.get("/v1/docs?include_schemas=false")
        assert resp.status_code == 200


# ===========================================================================
# GET /docs/endpoint — specific endpoint
# ===========================================================================

class TestGetEndpointDocs:
    """Tests for GET /v1/docs/endpoint."""

    @pytest.mark.asyncio
    async def test_endpoint_docs_valid(self, client):
        """Valid endpoint returns details."""
        resp = await client.get("/v1/docs/endpoint?path=/v1/health&method=GET")
        assert resp.status_code in (200, 404)

    @pytest.mark.asyncio
    async def test_endpoint_docs_missing_path(self, client):
        """Missing path param returns 422."""
        resp = await client.get("/v1/docs/endpoint?method=GET")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_endpoint_docs_missing_method(self, client):
        """Missing method param returns 422."""
        resp = await client.get("/v1/docs/endpoint?path=/v1/health")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_endpoint_docs_not_found(self, client):
        """Nonexistent endpoint returns 404."""
        resp = await client.get("/v1/docs/endpoint?path=/v1/nonexistent&method=GET")
        assert resp.status_code == 404


# ===========================================================================
# GET /docs/tags — tag listing
# ===========================================================================

class TestListTags:
    """Tests for GET /v1/docs/tags."""

    @pytest.mark.asyncio
    async def test_tags_returns_200(self, client):
        """Tags endpoint returns 200."""
        resp = await client.get("/v1/docs/tags")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_tags_is_list(self, client):
        """Tags response is a list."""
        resp = await client.get("/v1/docs/tags")
        body = resp.json()
        assert isinstance(body, (list, dict))


# ===========================================================================
# GET /docs/schemas — schema listing
# ===========================================================================

class TestGetSchemas:
    """Tests for GET /v1/docs/schemas."""

    @pytest.mark.asyncio
    async def test_schemas_returns_200(self, client):
        """Schemas endpoint returns 200."""
        resp = await client.get("/v1/docs/schemas")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_schemas_specific(self, client):
        """Query specific schema by name."""
        resp = await client.get("/v1/docs/schemas?schema_name=ContextStatusResponse")
        # May or may not find it, but shouldn't crash
        assert resp.status_code in (200, 404)


# ===========================================================================
# GET /docs/openapi — OpenAPI spec
# ===========================================================================

class TestOpenAPI:
    """Tests for GET /v1/docs/openapi."""

    @pytest.mark.asyncio
    async def test_openapi_returns_200(self, client):
        """OpenAPI spec returns 200."""
        resp = await client.get("/v1/docs/openapi")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_openapi_has_paths(self, client):
        """OpenAPI spec includes paths key."""
        resp = await client.get("/v1/docs/openapi")
        body = resp.json()
        assert "paths" in body
        assert "info" in body


# ===========================================================================
# GET /docs/stats — API statistics
# ===========================================================================

class TestApiStats:
    """Tests for GET /v1/docs/stats."""

    @pytest.mark.asyncio
    async def test_stats_returns_200(self, client):
        """Stats endpoint returns 200."""
        resp = await client.get("/v1/docs/stats")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_stats_has_counts(self, client):
        """Stats includes endpoint counts."""
        resp = await client.get("/v1/docs/stats")
        body = resp.json()
        assert "total_endpoints" in body
        assert isinstance(body["total_endpoints"], int)
        assert body["total_endpoints"] > 0


# ===========================================================================
# Direct unit tests for helper functions
# ===========================================================================

OPENAPI_PATCH = "api.v1.endpoints.api_docs.get_openapi"


class TestEndpointExamples:
    """Direct tests for _get_endpoint_examples branches."""

    @pytest.mark.parametrize("path,method,title", [
        ("/v1/create/chat", "POST", "Send chat message"),
        ("/v1/api/mcp/servers", "POST", "Register local MCP server"),
        ("/v1/models", "GET", "List available models"),
        ("/v1/storage/memories/search", "POST", "Search memories"),
        ("/v1/sources/browser-history/discover", "POST", "Discover browser profiles"),
        ("/v1/sources/browser-history/index", "POST", "Build browser history index"),
        ("/v1/search/index", "POST", "Search index with hybrid mode"),
    ])
    def test_examples_branch(self, path, method, title):
        """Each path+method combo returns its specific example."""
        from api.v1.endpoints.api_docs import _get_endpoint_examples
        examples = _get_endpoint_examples(path, method)
        assert len(examples) == 1
        assert examples[0].title == title


class TestParseEndpointDetails:
    """Direct tests for _parse_endpoint_details edge cases."""

    def test_operation_with_security_sets_required(self):
        """Operation with 'security' key produces authentication.required=True."""
        from api.v1.endpoints.api_docs import _parse_endpoint_details
        operation = {
            "security": [{"BearerAuth": []}],
            "tags": ["test"],
            "responses": {"200": {"description": "ok"}},
        }
        result = _parse_endpoint_details("/test", "GET", operation, {})
        assert result.authentication["required"] is True
        assert result.authentication["schemes"] == [{"BearerAuth": []}]


# ===========================================================================
# Non-method keys, deprecated endpoints, method-not-found, schema-not-found
# ===========================================================================

# Mock schema with a non-method key ("parameters") and a deprecated endpoint.
MOCK_OPENAPI_SCHEMA = {
    "paths": {
        "/v1/test": {
            "parameters": [{"name": "x", "in": "query"}],
            "get": {
                "summary": "Deprecated test",
                "tags": ["test-tag"],
                "deprecated": True,
                "responses": {"200": {"description": "ok"}},
            },
        }
    },
    "components": {"schemas": {}},
}


class TestDocsEdgeCases:
    """Tests for non-method keys, deprecated, method-not-found, schema-not-found."""

    @pytest.mark.asyncio
    async def test_docs_skips_non_method_keys(self, client):
        """Docs generation skips non-HTTP-method keys in path items."""
        with patch(OPENAPI_PATCH, return_value=MOCK_OPENAPI_SCHEMA):
            resp = await client.get("/v1/docs")
        assert resp.status_code == 200
        body = resp.json()
        assert body["total_endpoints"] == 1

    @pytest.mark.asyncio
    async def test_tags_skips_non_method_keys(self, client):
        """Tags listing skips non-HTTP-method keys."""
        with patch(OPENAPI_PATCH, return_value=MOCK_OPENAPI_SCHEMA):
            resp = await client.get("/v1/docs/tags")
        assert resp.status_code == 200
        body = resp.json()
        tag_names = [t["name"] for t in body["tags"]]
        assert "test-tag" in tag_names

    @pytest.mark.asyncio
    async def test_stats_counts_deprecated_and_skips_non_method(self, client):
        """Stats counts deprecated endpoints and skips non-method keys."""
        with patch(OPENAPI_PATCH, return_value=MOCK_OPENAPI_SCHEMA):
            resp = await client.get("/v1/docs/stats")
        assert resp.status_code == 200
        body = resp.json()
        assert body["deprecated_endpoints"] == 1
        assert body["total_endpoints"] == 1

    @pytest.mark.asyncio
    async def test_endpoint_method_not_found(self, client):
        """Valid path but wrong method returns 404."""
        resp = await client.get("/v1/docs/endpoint?path=/v1/health&method=DELETE")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_schema_not_found(self, client):
        """Nonexistent schema name returns 404."""
        resp = await client.get("/v1/docs/schemas?schema_name=NonexistentSchemaXYZ999")
        assert resp.status_code == 404


# ===========================================================================
# Exception handlers for all 6 docs endpoints
# ===========================================================================

class TestDocsErrorHandlers:
    """Tests for generic exception handlers across all docs endpoints."""

    @pytest.mark.asyncio
    async def test_docs_generic_error_returns_500(self, client):
        """get_openapi crash in /docs returns 500."""
        with patch(OPENAPI_PATCH, side_effect=RuntimeError("crash")):
            resp = await client.get("/v1/docs")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_endpoint_docs_generic_error_returns_500(self, client):
        """get_openapi crash in /docs/endpoint returns 500."""
        with patch(OPENAPI_PATCH, side_effect=RuntimeError("crash")):
            resp = await client.get("/v1/docs/endpoint?path=/v1/health&method=GET")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_tags_generic_error_returns_500(self, client):
        """get_openapi crash in /docs/tags returns 500."""
        with patch(OPENAPI_PATCH, side_effect=RuntimeError("crash")):
            resp = await client.get("/v1/docs/tags")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_schemas_generic_error_returns_500(self, client):
        """get_openapi crash in /docs/schemas returns 500."""
        with patch(OPENAPI_PATCH, side_effect=RuntimeError("crash")):
            resp = await client.get("/v1/docs/schemas")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_openapi_generic_error_returns_500(self, client):
        """get_openapi crash in /docs/openapi returns 500."""
        with patch(OPENAPI_PATCH, side_effect=RuntimeError("crash")):
            resp = await client.get("/v1/docs/openapi")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_stats_generic_error_returns_500(self, client):
        """get_openapi crash in /docs/stats returns 500."""
        with patch(OPENAPI_PATCH, side_effect=RuntimeError("crash")):
            resp = await client.get("/v1/docs/stats")
        assert resp.status_code == 500
