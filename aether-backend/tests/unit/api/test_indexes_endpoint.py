"""
Unit tests for indexes endpoint (api/v1/endpoints/indexes.py).

2 routes:
  GET /v1/index/list
  GET /v1/index/health/{index_name}

CI: pytest tests/unit/api/test_indexes_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, patch


def _mock_index(name="test_index", idx_type="file_location", searchable=True, source_type=None):
    """Build an IndexInfo instance."""
    return {
        "index_name": name,
        "index_type": idx_type,
        "display_name": name.replace("_", " ").title(),
        "description": f"Test {name}",
        "chunk_count": 100,
        "index_size_bytes": 2048,
        "last_updated": "2026-01-01T00:00:00",
        "is_searchable": searchable,
        "index_path": "/tmp/indexes",
        "supported_modes": ["semantic"],
        "source_type": source_type,
        "metadata": {},
    }


DISCOVER_AGENT = "application.indexing.index_service.IndexService.discover_agent_indexes"
DISCOVER_FILE = "application.indexing.index_service.IndexService.discover_file_indexes"
DISCOVER_SOURCE = "application.indexing.index_service.IndexService.discover_source_indexes"


@pytest.fixture
def override_runtime_settings(app):
    """Override get_runtime_settings to avoid DB call."""
    from api.dependencies import get_runtime_settings
    from config.settings import get_settings

    app.dependency_overrides[get_runtime_settings] = lambda: get_settings()
    yield
    app.dependency_overrides.pop(get_runtime_settings, None)


# ===========================================================================
# GET /index/list
# ===========================================================================

class TestListIndexes:

    @pytest.mark.asyncio
    async def test_list_returns_all_types(self, client, override_runtime_settings):
        """Returns combined agent, file, and source indexes."""
        agent = [_mock_index("agent_research_index", "agent_output")]
        file = [_mock_index("downloads_index", "file_location")]
        source = [_mock_index("slack_index", "source")]

        with patch(DISCOVER_AGENT, new_callable=AsyncMock, return_value=agent), \
             patch(DISCOVER_FILE, new_callable=AsyncMock, return_value=file), \
             patch(DISCOVER_SOURCE, new_callable=AsyncMock, return_value=source):
            resp = await client.get("/v1/index/list")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_count"] == 3
        assert body["by_type"]["agent_output"] == 1
        assert body["by_type"]["file_location"] == 1
        assert body["by_type"]["source"] == 1
        assert len(body["indexes"]) == 3

    @pytest.mark.asyncio
    async def test_list_empty(self, client, override_runtime_settings):
        """No indexes returns empty list."""
        with patch(DISCOVER_AGENT, new_callable=AsyncMock, return_value=[]), \
             patch(DISCOVER_FILE, new_callable=AsyncMock, return_value=[]), \
             patch(DISCOVER_SOURCE, new_callable=AsyncMock, return_value=[]):
            resp = await client.get("/v1/index/list")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_count"] == 0
        assert body["indexes"] == []

    @pytest.mark.asyncio
    async def test_list_error_returns_500(self, client, override_runtime_settings):
        """Discovery error returns 500."""
        with patch(
            DISCOVER_AGENT, new_callable=AsyncMock,
            side_effect=RuntimeError("fs error"),
        ):
            resp = await client.get("/v1/index/list")

        assert resp.status_code == 500
        assert "Failed to list indexes" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_list_index_fields(self, client, override_runtime_settings):
        """Each index has all required fields."""
        idx = _mock_index("my_index", "file_location")
        with patch(DISCOVER_AGENT, new_callable=AsyncMock, return_value=[]), \
             patch(DISCOVER_FILE, new_callable=AsyncMock, return_value=[idx]), \
             patch(DISCOVER_SOURCE, new_callable=AsyncMock, return_value=[]):
            resp = await client.get("/v1/index/list")

        assert resp.status_code == 200
        index = resp.json()["indexes"][0]
        assert index["index_name"] == "my_index"
        assert index["index_type"] == "file_location"
        assert index["is_searchable"] is True
        assert index["chunk_count"] == 100
        assert "supported_modes" in index


# ===========================================================================
# GET /index/health/{index_name}
# ===========================================================================

class TestIndexHealth:

    @pytest.mark.asyncio
    async def test_health_found_healthy(self, client, override_runtime_settings):
        """Known searchable index returns healthy."""
        idx = _mock_index("my_index", "file_location", searchable=True)
        with patch(DISCOVER_AGENT, new_callable=AsyncMock, return_value=[]), \
             patch(DISCOVER_FILE, new_callable=AsyncMock, return_value=[idx]), \
             patch(DISCOVER_SOURCE, new_callable=AsyncMock, return_value=[]):
            resp = await client.get("/v1/index/health/my_index")

        assert resp.status_code == 200
        body = resp.json()
        assert body["exists"] is True
        assert body["status"] == "healthy"
        assert body["is_searchable"] is True
        assert body["index_name"] == "my_index"
        assert body["index_type"] == "file_location"

    @pytest.mark.asyncio
    async def test_health_found_disabled(self, client, override_runtime_settings):
        """Disabled index returns disabled status."""
        idx = _mock_index("disabled_idx", "file_location", searchable=False)
        with patch(DISCOVER_AGENT, new_callable=AsyncMock, return_value=[]), \
             patch(DISCOVER_FILE, new_callable=AsyncMock, return_value=[idx]), \
             patch(DISCOVER_SOURCE, new_callable=AsyncMock, return_value=[]):
            resp = await client.get("/v1/index/health/disabled_idx")

        assert resp.status_code == 200
        body = resp.json()
        assert body["exists"] is True
        assert body["status"] == "disabled"
        assert body["is_searchable"] is False

    @pytest.mark.asyncio
    async def test_health_not_found(self, client, override_runtime_settings):
        """Unknown index returns not_found status (200, not 404)."""
        with patch(DISCOVER_AGENT, new_callable=AsyncMock, return_value=[]), \
             patch(DISCOVER_FILE, new_callable=AsyncMock, return_value=[]), \
             patch(DISCOVER_SOURCE, new_callable=AsyncMock, return_value=[]):
            resp = await client.get("/v1/index/health/nonexistent")

        assert resp.status_code == 200
        body = resp.json()
        assert body["exists"] is False
        assert body["status"] == "not_found"
        assert body["is_searchable"] is False

    @pytest.mark.asyncio
    async def test_health_error_returns_500(self, client, override_runtime_settings):
        """Discovery error returns 500."""
        with patch(
            DISCOVER_AGENT, new_callable=AsyncMock,
            side_effect=RuntimeError("fail"),
        ):
            resp = await client.get("/v1/index/health/any_index")

        assert resp.status_code == 500
        assert "Health check failed" in resp.json()["detail"]


# ===========================================================================
# DEEP: _discover_agent_indexes (lines 88-143)
# ===========================================================================

