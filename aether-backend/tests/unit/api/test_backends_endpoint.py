"""
Backends Registry Endpoint Tests

Covers all 5 routes in api/v1/endpoints/backends.py:
  GET /v1/backends/list
  GET /v1/backends/{backend_name}
  GET /v1/backends/{backend_name}/health
  GET /v1/backends/registry/info
  GET /v1/backends/health/all

Mocking strategy:
  - _load_integrations_registry: patched to return controlled YAML data
  - _check_backend_available: patched to avoid real integration imports
  - Integration health checks: patched per-backend (tts, notebook, omni, xlwings, etc.)
  - httpx.AsyncClient: patched for external health probes (perplexica)
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock


# ---------------------------------------------------------------------------
# Shared test registry data
# ---------------------------------------------------------------------------

MOCK_REGISTRY = {
    "metadata": {
        "version": "1.0.0",
        "description": "Test registry",
    },
    "runtime": {
        "tool_namespace": "computer",
    },
    "integrations": {
        "tts": {
            "type": "library",
            "description": "Text-to-speech engine",
            "enabled": True,
            "priority": 1,
            "layer1_implementation": {"module": "tts"},
            "layer2_exposure": {"routes": ["/v1/tts/*"]},
            "layer3_metadata": {
                "category": "audio",
                "tool_count": 3,
                "requires_service": False,
            },
            "layer4_runtime": {
                "namespace": "computer",
                "attach_as": "functions",
            },
        },
        "notebook": {
            "type": "library",
            "description": "Jupyter notebook runtime",
            "enabled": True,
            "priority": 2,
            "layer3_metadata": {
                "category": "compute",
                "tool_count": 5,
                "requires_service": False,
            },
            "layer4_runtime": {
                "namespace": "computer",
                "attach_as": "functions",
            },
        },
        "perplexica": {
            "type": "service",
            "description": "Web search engine",
            "enabled": False,
            "priority": 10,
            "layer3_metadata": {
                "category": "search",
                "tool_count": 6,
                "requires_service": True,
            },
            "layer4_runtime": {
                "namespace": "computer",
                "attach_as": "functions",
            },
        },
    },
}


# ===================================================================
# GET /v1/backends/list
# ===================================================================


class TestListBackends:

    @pytest.mark.asyncio
    async def test_list_returns_all_backends(self, client):
        """List endpoint returns all backends from registry."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.backends._check_backend_available",
            return_value=True,
        ):
            resp = await client.get("/v1/backends/list")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 3
        assert "tts" in body["backends"]
        assert "notebook" in body["backends"]
        assert "perplexica" in body["backends"]

    @pytest.mark.asyncio
    async def test_list_includes_categories(self, client):
        """List groups backends by category."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.backends._check_backend_available",
            return_value=True,
        ):
            resp = await client.get("/v1/backends/list")

        body = resp.json()
        assert "categories" in body
        assert "audio" in body["categories"]
        assert "tts" in body["categories"]["audio"]

    @pytest.mark.asyncio
    async def test_list_sorted_by_priority(self, client):
        """Backends sorted by priority (lowest first)."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.backends._check_backend_available",
            return_value=True,
        ):
            resp = await client.get("/v1/backends/list")

        body = resp.json()
        names = list(body["backends"].keys())
        # tts=1, notebook=2, perplexica=10
        assert names.index("tts") < names.index("notebook")
        assert names.index("notebook") < names.index("perplexica")

    @pytest.mark.asyncio
    async def test_list_empty_registry(self, client):
        """Graceful response when registry has no integrations."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value={"integrations": {}},
        ):
            resp = await client.get("/v1/backends/list")

        assert resp.status_code == 200
        assert resp.json()["total"] == 0

    @pytest.mark.asyncio
    async def test_list_registry_load_failure(self, client):
        """500 when registry loader raises."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            side_effect=RuntimeError("YAML parse error"),
        ):
            resp = await client.get("/v1/backends/list")

        assert resp.status_code == 500


# ===================================================================
# GET /v1/backends/{backend_name}
# ===================================================================


class TestGetBackendDetails:

    @pytest.mark.asyncio
    async def test_known_backend_returns_details(self, client):
        """Known backend returns full detail payload."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.backends._check_backend_available",
            return_value=True,
        ):
            resp = await client.get("/v1/backends/tts")

        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "tts"
        assert body["enabled"] is True
        assert body["type"] == "library"
        assert "layer3_metadata" in body
        assert "api_endpoints" in body
        assert isinstance(body["api_endpoints"], list)

    @pytest.mark.asyncio
    async def test_unknown_backend_returns_404(self, client):
        """Non-existent backend returns 404."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ):
            resp = await client.get("/v1/backends/nonexistent_backend")

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_detail_includes_availability(self, client):
        """Detail includes 'available' boolean."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.backends._check_backend_available",
            return_value=False,
        ):
            resp = await client.get("/v1/backends/tts")

        assert resp.status_code == 200
        assert resp.json()["available"] is False


# ===================================================================
# GET /v1/backends/{backend_name}/health
# ===================================================================


class TestBackendHealth:

    @pytest.mark.asyncio
    async def test_notebook_health(self, client):
        """Notebook health returns healthy with sys_path_count."""
        mock_result = {"count": 5, "paths": ["/a", "/b"]}
        with patch(
            "api.v1.endpoints.backends.notebook_runtime.nb_list_sys_path",
            return_value=mock_result,
        ):
            resp = await client.get("/v1/backends/notebook/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["backend"] == "notebook"
        assert body["healthy"] is True
        assert body["sys_path_count"] == 5

    @pytest.mark.asyncio
    async def test_omni_health(self, client):
        """Omni health returns healthy with workflow count."""
        with patch(
            "api.v1.endpoints.backends.omni_tools.omni_workflows",
            return_value=["wf1", "wf2"],
        ):
            resp = await client.get("/v1/backends/omni/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["backend"] == "omni"
        assert body["healthy"] is True
        assert body["workflows"] == 2

    @pytest.mark.asyncio
    async def test_tts_health(self, client):
        """TTS health delegates to integration."""
        mock_tts = MagicMock()
        mock_tts.check_health = AsyncMock(return_value={"healthy": True, "engine": "piper"})

        with patch(
            "api.v1.endpoints.backends.realtime_tts.get_tts_integration",
            return_value=mock_tts,
        ):
            resp = await client.get("/v1/backends/tts/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["backend"] == "tts"
        assert body["healthy"] is True

    @pytest.mark.asyncio
    async def test_xlwings_health(self, client):
        """xlwings health delegates to excel module."""
        with patch(
            "api.v1.endpoints.backends.xlwings_excel.xlwings_health",
            return_value={"status": "active", "version": "0.30"},
        ):
            resp = await client.get("/v1/backends/xlwings/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["backend"] == "xlwings"

    @pytest.mark.asyncio
    async def test_unknown_backend_health_not_implemented(self, client):
        """Unknown backend returns not-implemented message."""
        resp = await client.get("/v1/backends/some_unknown/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["backend"] == "some_unknown"
        assert body["healthy"] is False
        assert "not implemented" in body.get("message", "").lower()

    @pytest.mark.asyncio
    async def test_chat_context_health(self, client):
        """In-process tool wrappers return active."""
        resp = await client.get("/v1/backends/chat_context/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is True
        assert body["status"] == "active"

    @pytest.mark.asyncio
    async def test_health_check_exception_returns_error(self, client):
        """Exception during health check returns graceful error."""
        with patch(
            "api.v1.endpoints.backends.notebook_runtime.nb_list_sys_path",
            side_effect=RuntimeError("kernel crashed"),
        ):
            resp = await client.get("/v1/backends/notebook/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is False
        assert "error" in body


# ===================================================================
# GET /v1/backends/registry/info
# ===================================================================


class TestRegistryInfo:

    @pytest.mark.asyncio
    async def test_registry_info_returns_metadata(self, client):
        """Registry info returns metadata and counts."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ):
            resp = await client.get("/v1/backends/registry/info")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_integrations"] == 3
        assert "metadata" in body
        assert body["metadata"]["version"] == "1.0.0"
        assert body["architecture"] == "4-layer modular abstraction"

    @pytest.mark.asyncio
    async def test_registry_info_empty(self, client):
        """Empty registry returns zero count."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value={"integrations": {}, "metadata": {}, "runtime": {}},
        ):
            resp = await client.get("/v1/backends/registry/info")

        assert resp.status_code == 200
        assert resp.json()["total_integrations"] == 0


# ===================================================================
# GET /v1/backends/health/all
# ===================================================================


class TestAllBackendsHealth:

    @pytest.mark.asyncio
    async def test_all_health_checks_disabled_backends(self, client):
        """Disabled backends reported as disabled in bulk check."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.backends.check_backend_health",
            new_callable=AsyncMock,
            return_value={"backend": "test", "healthy": True},
        ):
            resp = await client.get("/v1/backends/health/all")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_backends"] == 3
        # perplexica is disabled in MOCK_REGISTRY
        assert body["disabled_backends"] >= 1
        checks = body["health_checks"]
        assert checks["perplexica"]["status"] == "disabled"

    @pytest.mark.asyncio
    async def test_all_health_enabled_backends_checked(self, client):
        """Enabled backends get actual health checks."""
        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.backends.check_backend_health",
            new_callable=AsyncMock,
            return_value={"backend": "tts", "healthy": True},
        ):
            resp = await client.get("/v1/backends/health/all")

        assert resp.status_code == 200
        body = resp.json()
        assert body["enabled_backends"] == 2  # tts + notebook

    @pytest.mark.asyncio
    async def test_all_health_exception_in_single_backend(self, client):
        """Exception in one backend doesn't crash bulk check."""
        async def _side_effect(backend_name, _context):
            if backend_name == "tts":
                raise RuntimeError("TTS crashed")
            return {"backend": backend_name, "healthy": True}

        with patch(
            "data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
            return_value=MOCK_REGISTRY,
        ), patch(
            "api.v1.endpoints.backends.check_backend_health",
            new_callable=AsyncMock,
            side_effect=_side_effect,
        ):
            resp = await client.get("/v1/backends/health/all")

        assert resp.status_code == 200
        body = resp.json()
        # tts should be reported as unhealthy due to exception
        assert body["health_checks"]["tts"]["healthy"] is False




# ===================================================================
# Deep Coverage: _check_backend_available
# ===================================================================


class TestCheckBackendAvailable:

    def test_tts_available(self):
        from api.v1.endpoints.backends import _check_backend_available
        mock_tts = MagicMock()
        mock_tts.is_available.return_value = True
        with patch("api.v1.endpoints.backends.realtime_tts.get_tts_integration", return_value=mock_tts):
            assert _check_backend_available("tts") is True

    def test_tts_unavailable(self):
        from api.v1.endpoints.backends import _check_backend_available
        mock_tts = MagicMock()
        mock_tts.is_available.return_value = False
        with patch("api.v1.endpoints.backends.realtime_tts.get_tts_integration", return_value=mock_tts):
            assert _check_backend_available("tts") is False

    def test_tts_exception_returns_false(self):
        from api.v1.endpoints.backends import _check_backend_available
        with patch("api.v1.endpoints.backends.realtime_tts.get_tts_integration", side_effect=ImportError("no tts")):
            assert _check_backend_available("tts") is False

    def test_notebook_always_true(self):
        from api.v1.endpoints.backends import _check_backend_available
        assert _check_backend_available("notebook") is True

    def test_omni_always_true(self):
        from api.v1.endpoints.backends import _check_backend_available
        assert _check_backend_available("omni") is True

    def test_xlwings_healthy(self):
        from api.v1.endpoints.backends import _check_backend_available
        with patch("api.v1.endpoints.backends.xlwings_excel.xlwings_health",
                    return_value={"status": "active"}):
            assert _check_backend_available("xlwings") is True

    def test_xlwings_unhealthy(self):
        from api.v1.endpoints.backends import _check_backend_available
        with patch("api.v1.endpoints.backends.xlwings_excel.xlwings_health",
                    return_value={"status": "error"}):
            assert _check_backend_available("xlwings") is False

    def test_unknown_backend_defaults_true(self):
        from api.v1.endpoints.backends import _check_backend_available
        assert _check_backend_available("some_new_backend") is True


# ===================================================================
# Deep Coverage: backend health - docling, aether_rag, mcp, perplexica
# ===================================================================


class TestBackendHealthDeep:

    async def test_docling_health(self, client):
        with patch("core.integrations.providers.docling.docling_health",
                    return_value={"healthy": True, "engine": "docling"}):
            resp = await client.get("/v1/backends/docling/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["backend"] == "docling"

    async def test_aether_rag_health(self, client):
        with patch("core.integrations.providers.aether_rag.aether_rag_health",
                    new_callable=AsyncMock,
                    return_value={"healthy": True, "status": "active"}):
            resp = await client.get("/v1/backends/aether_rag/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["backend"] == "aether_rag"

    async def test_mcp_health_manager_none(self, client):
        with patch("core.mcp.context.get_mcp_manager", return_value=None):
            resp = await client.get("/v1/backends/mcp/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is False
        assert "not initialized" in body.get("error", "").lower()

    async def test_mcp_health_manager_active(self, client):
        mock_mgr = AsyncMock()
        mock_mgr.list_servers = AsyncMock(return_value=[
            {"name": "srv1", "enabled": True, "status": "running"},
            {"name": "srv2", "enabled": True, "status": "stopped"},
            {"name": "srv3", "enabled": False, "status": "stopped"},
        ])
        with patch("core.mcp.context.get_mcp_manager", return_value=mock_mgr):
            resp = await client.get("/v1/backends/mcp/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is True
        assert body["enabled_servers"] == 2
        assert body["running_servers"] == 1

    async def test_perplexica_health_enabled_online(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200

        with patch("data.network.http_client.AetherHTTPClient.get", new_callable=AsyncMock) as mock_get, \
             patch("api.v1.endpoints.backends.get_settings") as mock_gs:
            mock_get.return_value = mock_resp
            mock_settings = MagicMock()
            mock_settings.integrations.perplexica_enabled = True
            mock_settings.integrations.perplexica_url = "http://localhost:3001"
            mock_gs.return_value = mock_settings
            resp = await client.get("/v1/backends/perplexica/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["backend"] == "perplexica"
        assert body["healthy"] is True

    async def test_perplexica_health_enabled_offline(self, client):
        with patch("data.network.http_client.AetherHTTPClient.get", new_callable=AsyncMock) as mock_get, \
             patch("api.v1.endpoints.backends.get_settings") as mock_gs:
            mock_get.side_effect = Exception("refused")
            mock_settings = MagicMock()
            mock_settings.integrations.perplexica_enabled = True
            mock_settings.integrations.perplexica_url = "http://localhost:3001"
            mock_gs.return_value = mock_settings
            resp = await client.get("/v1/backends/perplexica/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is False
        assert body["status"] == "offline"

    async def test_perplexica_health_disabled(self, client):
        """Late import uses config.settings.get_settings, must patch at source."""
        with patch("config.settings.get_settings") as mock_gs:
            mock_settings = MagicMock()
            mock_settings.integrations.perplexica_enabled = False
            mock_gs.return_value = mock_settings
            resp = await client.get("/v1/backends/perplexica/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "disabled"

    async def test_memory_context_health(self, client):
        resp = await client.get("/v1/backends/memory_context/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is True
        assert body["status"] == "active"


# ===================================================================
# Deep Coverage: get_backend_details exception
# ===================================================================


class TestGetBackendDetailsDeep:

    async def test_generic_exception_returns_500(self, client):
        with patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
                    side_effect=RuntimeError("disk error")):
            resp = await client.get("/v1/backends/tts")
        assert resp.status_code == 500

    async def test_registry_info_exception_returns_500(self, client):
        with patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
                    side_effect=RuntimeError("yaml broken")):
            resp = await client.get("/v1/backends/registry/info")
        assert resp.status_code == 500

    async def test_bulk_health_exception_returns_500(self, client):
        with patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry",
                    side_effect=RuntimeError("total failure")):
            resp = await client.get("/v1/backends/health/all")
        assert resp.status_code == 500


# ===================================================================
# Deep Coverage: list_backends service_url resolution
# ===================================================================


class TestListBackendsServiceUrl:

    async def test_list_resolves_service_url_for_perplexica(self, client):
        registry = {
            "integrations": {
                "perplexica": {
                    "type": "service",
                    "description": "Search",
                    "enabled": True,
                    "priority": 1,
                    "layer3_metadata": {"category": "search", "tool_count": 1, "requires_service": True},
                    "layer4_runtime": {"namespace": "computer", "attach_as": "functions"},
                },
            }
        }
        with patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry", return_value=registry), \
             patch("api.v1.endpoints.backends._check_backend_available", return_value=True):
            resp = await client.get("/v1/backends/list")
        assert resp.status_code == 200
        body = resp.json()
        perplexica = body["backends"]["perplexica"]
        # service_url should be resolved from settings (non-None when enabled)
        assert "service_url" in perplexica

    async def test_list_resolves_service_url_for_searxng(self, client, app):
        """Line 126: searxng backend resolves service_url from settings."""
        from api.dependencies import get_settings as _get_settings

        registry = {
            "integrations": {
                "searxng": {
                    "type": "service",
                    "description": "SearXNG meta-search",
                    "enabled": True,
                    "priority": 5,
                    "layer3_metadata": {"category": "search", "tool_count": 2, "requires_service": True},
                    "layer4_runtime": {"namespace": "computer", "attach_as": "functions"},
                },
            }
        }
        mock_settings = MagicMock()
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://localhost:8080"
        app.dependency_overrides[_get_settings] = lambda: mock_settings
        try:
            with patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry", return_value=registry), \
                 patch("api.v1.endpoints.backends._check_backend_available", return_value=True):
                resp = await client.get("/v1/backends/list")
            assert resp.status_code == 200
            body = resp.json()
            searxng = body["backends"]["searxng"]
            assert searxng["service_url"] == "http://localhost:8080"
        finally:
            app.dependency_overrides.pop(_get_settings, None)

    async def test_list_resolves_service_url_for_embedding(self, client, app):
        """Lines 128-129: embedding backend resolves service_url from settings."""
        from api.dependencies import get_settings as _get_settings

        registry = {
            "integrations": {
                "embedding": {
                    "type": "service",
                    "description": "Embedding service",
                    "enabled": True,
                    "priority": 3,
                    "layer3_metadata": {"category": "ai", "tool_count": 1, "requires_service": True},
                    "layer4_runtime": {"namespace": "computer", "attach_as": "functions"},
                },
            }
        }
        mock_settings = MagicMock()
        mock_settings.embedding_service.enabled = True
        mock_settings.embedding_service.service_url = "http://localhost:11434"
        app.dependency_overrides[_get_settings] = lambda: mock_settings
        try:
            with patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry", return_value=registry), \
                 patch("api.v1.endpoints.backends._check_backend_available", return_value=True):
                resp = await client.get("/v1/backends/list")
            assert resp.status_code == 200
            body = resp.json()
            embedding = body["backends"]["embedding"]
            assert embedding["service_url"] == "http://localhost:11434"
        finally:
            app.dependency_overrides.pop(_get_settings, None)

    async def test_list_service_url_resolution_exception(self, client, app):
        """Line 130: exception during service_url resolution falls back to None."""
        from api.dependencies import get_settings as _get_settings

        registry = {
            "integrations": {
                "embedding": {
                    "type": "service",
                    "description": "Embedding service",
                    "enabled": True,
                    "priority": 3,
                    "layer3_metadata": {"category": "ai", "tool_count": 1, "requires_service": True},
                    "layer4_runtime": {"namespace": "computer", "attach_as": "functions"},
                },
            }
        }

        class _BrokenEmbeddingService:
            """Object that raises on any attribute access to trigger except branch."""
            @property
            def enabled(self):
                raise RuntimeError("embedding service unavailable")
            @property
            def service_url(self):
                raise RuntimeError("embedding service unavailable")

        mock_settings = MagicMock()
        mock_settings.embedding_service = _BrokenEmbeddingService()
        app.dependency_overrides[_get_settings] = lambda: mock_settings
        try:
            with patch("data.infrastructure.registry_gateway.RegistryGateway.get_raw_registry", return_value=registry), \
                 patch("api.v1.endpoints.backends._check_backend_available", return_value=True):
                resp = await client.get("/v1/backends/list")
            assert resp.status_code == 200
            body = resp.json()
            embedding = body["backends"]["embedding"]
            assert embedding["service_url"] is None
        finally:
            app.dependency_overrides.pop(_get_settings, None)


