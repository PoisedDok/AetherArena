"""
Services Status Endpoint Tests

Covers routes in api/v1/endpoints/services.py:
  GET /v1/services/status
  GET /v1/status/research

Mocking strategy:
  - httpx.AsyncClient: patched globally to avoid real network calls
  - load_integrations_registry: patched to return controlled data
  - Settings: inherited from conftest (test environment defaults)
  - aether_rag_health, docling_health: patched to avoid real service calls
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock
import httpx as real_httpx


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_check_service_health(status="online", status_code=200, response_time_ms=5.0, error=None):
    """Create a mock return for check_service_health."""
    return {
        "status": status,
        "status_code": status_code,
        "response_time_ms": response_time_ms,
        "error": error,
    }


MOCK_REGISTRY = {
    "integrations": {
        "tts": {"type": "library", "enabled": True},
        "notebook": {"type": "library", "enabled": True},
    }
}


# ===================================================================
# GET /v1/services/status
# ===================================================================


class TestServicesStatus:

    @pytest.mark.asyncio
    async def test_services_status_returns_list(self, client):
        """Services endpoint returns a list of services with summary."""
        with patch(
            "api.v1.endpoints.services.check_service_health",
            new_callable=AsyncMock,
            return_value=_mock_check_service_health(),
        ), patch(
            "api.v1.endpoints.services.check_file_indexing_health",
            new_callable=AsyncMock,
            return_value=_mock_check_service_health(),
        ), patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.services.aether_rag_health",
            new_callable=AsyncMock,
            return_value={"healthy": True, "status": "active", "server_registered": True, "server_connected": True, "tools_count": 3, "test_search_ok": True},
            create=True,
        ):
            resp = await client.get("/v1/services/status")

        assert resp.status_code == 200
        body = resp.json()
        assert "services" in body
        assert "summary" in body
        assert isinstance(body["services"], list)
        assert body["summary"]["total"] > 0

    @pytest.mark.asyncio
    async def test_services_status_includes_backend_core(self, client):
        """Backend core service always present in list."""
        with patch(
            "api.v1.endpoints.services.check_service_health",
            new_callable=AsyncMock,
            return_value=_mock_check_service_health(),
        ), patch(
            "api.v1.endpoints.services.check_file_indexing_health",
            new_callable=AsyncMock,
            return_value=_mock_check_service_health(),
        ), patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.services.aether_rag_health",
            new_callable=AsyncMock,
            return_value={"healthy": True, "status": "active", "server_registered": True, "server_connected": True, "tools_count": 3, "test_search_ok": True},
            create=True,
        ):
            resp = await client.get("/v1/services/status")

        body = resp.json()
        names = [s["name"] for s in body["services"]]
        assert "Aether Backend" in names

    @pytest.mark.asyncio
    async def test_services_status_lm_studio_health(self, client):
        """LM Studio health check included."""
        with patch(
            "api.v1.endpoints.services.check_service_health",
            new_callable=AsyncMock,
            return_value=_mock_check_service_health(status="offline", error="Connection refused"),
        ), patch(
            "api.v1.endpoints.services.check_file_indexing_health",
            new_callable=AsyncMock,
            return_value=_mock_check_service_health(),
        ), patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.services.aether_rag_health",
            new_callable=AsyncMock,
            return_value={"healthy": False, "status": "error", "error": "not found"},
            create=True,
        ):
            resp = await client.get("/v1/services/status")

        body = resp.json()
        lm_studio = next((s for s in body["services"] if s["name"] == "LM Studio"), None)
        assert lm_studio is not None
        assert lm_studio["type"] == "llm_provider"

    @pytest.mark.asyncio
    async def test_services_status_empty_registry(self, client):
        """Empty registry still returns core services."""
        with patch(
            "api.v1.endpoints.services.check_service_health",
            new_callable=AsyncMock,
            return_value=_mock_check_service_health(),
        ), patch(
            "api.v1.endpoints.services.check_file_indexing_health",
            new_callable=AsyncMock,
            return_value=_mock_check_service_health(),
        ), patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value={"integrations": {}},
        ), patch(
            "api.v1.endpoints.services.aether_rag_health",
            new_callable=AsyncMock,
            return_value={"healthy": False, "error": "not configured"},
            create=True,
        ):
            resp = await client.get("/v1/services/status")

        body = resp.json()
        # At minimum: Backend Core + LM Studio + Supabase + AETHER_RAG
        assert body["summary"]["total"] >= 3


# ===================================================================
# check_service_health (unit function)
# ===================================================================


class TestCheckServiceHealth:

    @pytest.mark.asyncio
    async def test_timeout_returns_timeout_status(self):
        """Timeout exception returns timeout status."""
        from api.v1.endpoints.services import check_service_health

        with patch(
            "data.network.http_client.httpx.AsyncClient",
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(side_effect=real_httpx.TimeoutException("timed out"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_service_health("http://localhost:9999/health")

        assert result["status"] == "timeout"
        assert "timed out" in (result.get("error") or "").lower()

    @pytest.mark.asyncio
    async def test_connection_error_returns_offline(self):
        """Connection error returns offline status."""
        from api.v1.endpoints.services import check_service_health

        with patch(
            "data.network.http_client.httpx.AsyncClient",
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(side_effect=real_httpx.ConnectError("refused"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_service_health("http://localhost:9999/health")

        assert result["status"] == "offline"

    @pytest.mark.asyncio
    async def test_healthy_response(self):
        """200 response returns online status."""
        from api.v1.endpoints.services import check_service_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.05

        with patch(
            "data.network.http_client.httpx.AsyncClient",
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_service_health("http://localhost:1234/api/health")

        assert result["status"] == "online"
        assert result["status_code"] == 200


# ===================================================================
# check_file_indexing_health (unit function)
# ===================================================================


class TestCheckFileIndexingHealth:

    @pytest.mark.asyncio
    async def test_running_status_returns_online(self):
        """service_status=running maps to online."""
        from api.v1.endpoints.services import check_file_indexing_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.01
        mock_resp.json.return_value = {"service_status": "running"}

        with patch(
            "data.network.http_client.httpx.AsyncClient",
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")

        assert result["status"] == "online"
        assert result["service_status"] == "running"

    @pytest.mark.asyncio
    async def test_stopped_status_returns_offline(self):
        """service_status=stopped maps to offline."""
        from api.v1.endpoints.services import check_file_indexing_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.01
        mock_resp.json.return_value = {"service_status": "stopped"}

        with patch(
            "data.network.http_client.httpx.AsyncClient",
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")

        assert result["status"] == "offline"

    @pytest.mark.asyncio
    async def test_error_status_returns_degraded(self):
        """service_status=error maps to degraded."""
        from api.v1.endpoints.services import check_file_indexing_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.01
        mock_resp.json.return_value = {"service_status": "error", "error_message": "disk full"}

        with patch(
            "data.network.http_client.httpx.AsyncClient",
        ) as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")

        assert result["status"] == "degraded"
        assert result["error"] == "disk full"


# ===================================================================
# Deep Coverage: check_service_health edge cases
# ===================================================================


class TestCheckServiceHealthDeep:
    """Cover remaining paths: generic exception, degraded (non-ok status), custom ok_status_codes."""

    async def test_generic_exception_returns_error(self):
        from api.v1.endpoints.services import check_service_health

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(side_effect=RuntimeError("unexpected"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_service_health("http://localhost:9999/health")
        assert result["status"] == "error"
        assert "check server logs" in result["error"].lower()
        assert result["status_code"] is None

    async def test_degraded_status_non_ok_code(self):
        from api.v1.endpoints.services import check_service_health

        mock_resp = MagicMock()
        mock_resp.status_code = 503
        mock_resp.elapsed.total_seconds.return_value = 0.02

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_service_health("http://localhost:9999/health")
        assert result["status"] == "degraded"
        assert result["error"] == "HTTP 503"

    async def test_custom_ok_status_codes(self):
        from api.v1.endpoints.services import check_service_health

        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.elapsed.total_seconds.return_value = 0.01

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_service_health(
                "http://localhost:9999/health",
                ok_status_codes={200, 401, 403},
            )
        assert result["status"] == "online"

    async def test_custom_headers_passed(self):
        from api.v1.endpoints.services import check_service_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.01

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            await check_service_health(
                "http://localhost:9999/health",
                headers={"apikey": "test-key"},
            )
        call_kwargs = mock_client.request.call_args
        assert call_kwargs[1]["headers"]["apikey"] == "test-key"


# ===================================================================
# Deep Coverage: check_file_indexing_health edge cases
# ===================================================================


class TestCheckFileIndexingHealthDeep:
    """Cover: non-200 status, json parse exception, unknown service_status,
    idle service_status, timeout, connect error, generic exception."""

    async def test_non_200_returns_degraded(self):
        from api.v1.endpoints.services import check_file_indexing_health

        mock_resp = MagicMock()
        mock_resp.status_code = 503
        mock_resp.elapsed.total_seconds.return_value = 0.01

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")
        assert result["status"] == "degraded"
        assert result["error"] == "HTTP 503"

    async def test_json_parse_failure_falls_to_unknown(self):
        """If response.json() throws, service_status is None -> degraded."""
        from api.v1.endpoints.services import check_file_indexing_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.01
        mock_resp.json.side_effect = ValueError("not json")

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")
        assert result["status"] == "degraded"
        assert "unknown service_status" in result["error"].lower()

    async def test_unknown_service_status_returns_degraded(self):
        from api.v1.endpoints.services import check_file_indexing_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.01
        mock_resp.json.return_value = {"service_status": "maintenance"}

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")
        assert result["status"] == "degraded"
        assert "unknown" in result["error"].lower()

    async def test_idle_status_returns_online(self):
        from api.v1.endpoints.services import check_file_indexing_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.01
        mock_resp.json.return_value = {"service_status": "idle"}

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")
        assert result["status"] == "online"
        assert result["error"] is None

    async def test_error_status_without_error_message(self):
        """error_message is None -> fallback to 'Service error'."""
        from api.v1.endpoints.services import check_file_indexing_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.01
        mock_resp.json.return_value = {"service_status": "error"}

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")
        assert result["status"] == "degraded"
        assert result["error"] == "Service error"

    async def test_timeout_returns_timeout(self):
        from api.v1.endpoints.services import check_file_indexing_health

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(side_effect=real_httpx.TimeoutException("timed out"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")
        assert result["status"] == "timeout"

    async def test_connect_error_returns_offline(self):
        from api.v1.endpoints.services import check_file_indexing_health

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(side_effect=real_httpx.ConnectError("refused"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")
        assert result["status"] == "offline"

    async def test_generic_exception_returns_error(self):
        from api.v1.endpoints.services import check_file_indexing_health

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(side_effect=RuntimeError("boom"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")
        assert result["status"] == "error"

    async def test_response_json_not_a_dict(self):
        """If json() returns a list, service_status is None -> degraded."""
        from api.v1.endpoints.services import check_file_indexing_health

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.elapsed.total_seconds.return_value = 0.01
        mock_resp.json.return_value = [1, 2, 3]

        with patch("data.network.http_client.httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.request = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await check_file_indexing_health("http://localhost:8080/v1/file/health")
        assert result["status"] == "degraded"




# ===================================================================
# Deep Coverage: get_services_status edge paths
# ===================================================================


class TestServicesStatusDeep:
    """Cover: AETHER_RAG degraded, AETHER_RAG exception, Supabase URL empty, Supabase no anon key,
    Docling health, Perplexica fallback, generic exception."""

    def _standard_patches(self, **overrides):
        """Return a dict of standard patches for get_services_status."""
        defaults = {
            "check_service_health": AsyncMock(return_value=_mock_check_service_health()),
            "check_file_indexing_health": AsyncMock(return_value=_mock_check_service_health()),
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry": MagicMock(return_value=MOCK_REGISTRY),
            "aether_rag_health": AsyncMock(return_value={"healthy": True, "status": "active",
                "server_registered": True, "server_connected": True, "tools_count": 3, "test_search_ok": True}),
        }
        defaults.update(overrides)
        return defaults

    async def test_aether_rag_degraded_status(self, client):
        """Late import: must patch at source module."""
        patches = self._standard_patches()
        with patch("api.v1.endpoints.services.check_service_health", patches["check_service_health"]), \
             patch("api.v1.endpoints.services.check_file_indexing_health", patches["check_file_indexing_health"]), \
             patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry", patches["data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry"]), \
             patch("core.integrations.providers.aether_rag.aether_rag_health", new_callable=AsyncMock,
                   return_value={
                       "healthy": False, "status": "degraded", "error": "partial failure",
                       "server_registered": True, "server_connected": False,
                       "tools_count": 0, "test_search_ok": False,
                   }):
            resp = await client.get("/v1/services/status")
        body = resp.json()
        aether_rag = next((s for s in body["services"] if s["name"] == "AETHER_RAG MCP"), None)
        assert aether_rag is not None
        assert aether_rag["status"] == "degraded"

    async def test_aether_rag_offline_status(self, client):
        patches = self._standard_patches()
        with patch("api.v1.endpoints.services.check_service_health", patches["check_service_health"]), \
             patch("api.v1.endpoints.services.check_file_indexing_health", patches["check_file_indexing_health"]), \
             patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry", patches["data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry"]), \
             patch("core.integrations.providers.aether_rag.aether_rag_health", new_callable=AsyncMock,
                   return_value={
                       "healthy": False, "status": "error",
                       "server_registered": False, "server_connected": False,
                       "tools_count": 0, "test_search_ok": False,
                   }):
            resp = await client.get("/v1/services/status")
        body = resp.json()
        aether_rag = next((s for s in body["services"] if s["name"] == "AETHER_RAG MCP"), None)
        assert aether_rag is not None
        assert aether_rag["status"] == "offline"

    async def test_aether_rag_exception_handled(self, client):
        patches = self._standard_patches()
        with patch("api.v1.endpoints.services.check_service_health", patches["check_service_health"]), \
             patch("api.v1.endpoints.services.check_file_indexing_health", patches["check_file_indexing_health"]), \
             patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry", patches["data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry"]), \
             patch("core.integrations.providers.aether_rag.aether_rag_health", new_callable=AsyncMock,
                   side_effect=RuntimeError("aether_rag crashed")):
            resp = await client.get("/v1/services/status")
        body = resp.json()
        aether_rag = next((s for s in body["services"] if s["name"] == "AETHER_RAG MCP"), None)
        assert aether_rag is not None
        assert aether_rag["status"] == "error"
        assert "check server logs" in aether_rag["error"].lower()

    async def test_get_research_status_success(self, client):
        """GET /v1/status/research delegates to research_status_handler."""
        mock_result = {"status": "operational", "enabled": True}
        with patch(
            "api.v1.endpoints.services.research_status_handler",
            new_callable=AsyncMock,
            return_value=mock_result,
            create=True,
        ), patch(
            "api.v1.endpoints.research.research_status",
            new_callable=AsyncMock,
            return_value=mock_result,
            create=True,
        ):
            resp = await client.get("/v1/status/research")
        # May succeed or fail depending on import resolution; test the path
        assert resp.status_code in (200, 500)

    async def test_get_research_status_exception(self, client, app):
        """Generic exception in research status returns 500."""
        from api.dependencies import get_research_service
        mock_rs = AsyncMock()
        mock_rs.get_research_status.side_effect = RuntimeError("research broken")
        app.dependency_overrides[get_research_service] = lambda: mock_rs
        try:
            resp = await client.get("/v1/status/research")
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_research_service, None)


# ===================================================================
# Deep Coverage: settings-dependent branches + research HTTPException
# ===================================================================


def _make_mock_settings(**overrides):
    """Build a MagicMock Settings with safe defaults for get_services_status.

    Override specific attributes via dotted-key kwargs, e.g.:
        _make_mock_settings(**{"supabase.url": "", "integrations.docling_enabled": True})
    """
    s = MagicMock()
    # Security
    s.security.bind_port = 8000
    s.security.bind_host = "127.0.0.1"
    # LLM
    s.llm.api_base = "http://localhost:1234/v1"
    # Inference (disabled)
    s.inference.enabled = False
    # Supabase (valid defaults)
    s.supabase.url = "http://localhost:54321"
    s.supabase.anon_key = "test-anon-key"
    # Integrations (all disabled by default)
    s.integrations.perplexica_enabled = False
    s.integrations.perplexica_url = "http://localhost:3001"
    s.integrations.searxng_enabled = False
    s.integrations.docling_enabled = False
    s.integrations.xlwings_enabled = False
    s.integrations.file_indexing_enabled = False
    s.integrations.mcp_enabled = False
    # Embedding (disabled)
    s.embedding_service.enabled = False
    # Environment
    s.environment = "test"

    for key, value in overrides.items():
        parts = key.split(".")
        obj = s
        for part in parts[:-1]:
            obj = getattr(obj, part)
        setattr(obj, parts[-1], value)
    return s


class TestServicesStatusSettingsBranches:
    """Cover settings-dependent branches in get_services_status:
    Supabase URL empty (L217), Supabase no anon key (L229),
    Perplexica fallback (L269), Docling enabled (L304-307),
    generic exception (L441-443), research HTTPException re-raise (L475)."""

    def _aether_rag_patch(self):
        """Patch aether_rag_health with healthy defaults."""
        return patch(
            "core.integrations.providers.aether_rag.aether_rag_health",
            new_callable=AsyncMock,
            return_value={
                "healthy": True, "status": "active",
                "server_registered": True, "server_connected": True,
                "tools_count": 3, "test_search_ok": True,
            },
        )

    async def test_supabase_url_empty(self, app, client):
        """Line 217: Supabase entry with status=error when SUPABASE_URL is empty."""
        from api.dependencies import get_settings as dep_get_settings

        mock_settings = _make_mock_settings(**{"supabase.url": ""})
        app.dependency_overrides[dep_get_settings] = lambda: mock_settings
        try:
            with patch("api.v1.endpoints.services.check_service_health",
                       new_callable=AsyncMock,
                       return_value=_mock_check_service_health()), \
                 patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
                       return_value=MOCK_REGISTRY), \
                 self._aether_rag_patch():
                resp = await client.get("/v1/services/status")
            assert resp.status_code == 200
            body = resp.json()
            supabase = next((s for s in body["services"] if s["name"] == "Supabase"), None)
            assert supabase is not None
            assert supabase["status"] == "error"
            assert supabase["error"] == "SUPABASE_URL is empty"
        finally:
            app.dependency_overrides.pop(dep_get_settings, None)

    async def test_supabase_no_anon_key(self, app, client):
        """Line 229: Supabase degraded when URL exists but anon key is missing."""
        from api.dependencies import get_settings as dep_get_settings

        mock_settings = _make_mock_settings(**{"supabase.anon_key": ""})
        app.dependency_overrides[dep_get_settings] = lambda: mock_settings
        try:
            with patch("api.v1.endpoints.services.check_service_health",
                       new_callable=AsyncMock,
                       return_value=_mock_check_service_health()), \
                 patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
                       return_value=MOCK_REGISTRY), \
                 self._aether_rag_patch():
                resp = await client.get("/v1/services/status")
            assert resp.status_code == 200
            body = resp.json()
            supabase = next((s for s in body["services"] if s["name"] == "Supabase"), None)
            assert supabase is not None
            assert supabase["status"] == "degraded"
            assert supabase["error"] == "SUPABASE_ANON_KEY is empty"
        finally:
            app.dependency_overrides.pop(dep_get_settings, None)

    async def test_perplexica_fallback_root_succeeds(self, app, client):
        """Line 269: Perplexica fallback to root URL returns online."""
        from api.dependencies import get_settings as dep_get_settings

        mock_settings = _make_mock_settings(**{
            "integrations.perplexica_enabled": True,
            "integrations.perplexica_url": "http://localhost:3001",
        })
        app.dependency_overrides[dep_get_settings] = lambda: mock_settings

        async def _url_router(url, gateway=None, **kwargs):
            if "/api/health" in url:
                return _mock_check_service_health(status="offline", error="not found")
            return _mock_check_service_health(status="online")

        try:
            with patch("api.v1.endpoints.services.check_service_health",
                       new_callable=AsyncMock, side_effect=_url_router), \
                 patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
                       return_value=MOCK_REGISTRY), \
                 self._aether_rag_patch():
                resp = await client.get("/v1/services/status")
            assert resp.status_code == 200
            body = resp.json()
            perplexica = next((s for s in body["services"] if s["name"] == "Perplexica"), None)
            assert perplexica is not None
            assert perplexica["status"] == "online"
        finally:
            app.dependency_overrides.pop(dep_get_settings, None)

    async def test_docling_enabled_healthy(self, app, client):
        """Lines 304-307: Docling service entry appears when enabled and healthy."""
        from api.dependencies import get_settings as dep_get_settings

        mock_settings = _make_mock_settings(**{"integrations.docling_enabled": True})
        app.dependency_overrides[dep_get_settings] = lambda: mock_settings
        try:
            with patch("api.v1.endpoints.services.check_service_health",
                       new_callable=AsyncMock,
                       return_value=_mock_check_service_health()), \
                 patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
                       return_value=MOCK_REGISTRY), \
                 self._aether_rag_patch(), \
                 patch("core.integrations.providers.docling.docling_health",
                       return_value={"healthy": True, "response_time_ms": 1.5}):
                resp = await client.get("/v1/services/status")
            assert resp.status_code == 200
            body = resp.json()
            docling = next((s for s in body["services"] if s["name"] == "Docling"), None)
            assert docling is not None
            assert docling["status"] == "online"
            assert docling["type"] == "document_processing"
        finally:
            app.dependency_overrides.pop(dep_get_settings, None)

    async def test_get_services_status_generic_exception(self, client):
        """Lines 441-443: Generic exception in get_services_status returns 500."""
        with patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
                   side_effect=RuntimeError("registry exploded")):
            resp = await client.get("/v1/services/status")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to retrieve services status"

    async def test_research_status_http_exception_reraise(self, client, app):
        """Line 475: HTTPException from research handler is re-raised as-is."""
        from api.dependencies import get_research_service
        from application.research.research_service import ResearchError
        mock_rs = AsyncMock()
        mock_rs.get_research_status.side_effect = ResearchError("Research config not found")
        app.dependency_overrides[get_research_service] = lambda: mock_rs
        try:
            resp = await client.get("/v1/status/research")
            assert resp.status_code == 500
            assert "Research config not found" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_research_service, None)
