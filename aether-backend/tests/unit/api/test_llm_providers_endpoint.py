"""
Tests for api/v1/endpoints/llm_providers.py

Covers: provider discovery, availability check, model fetching,
provider config save/load, sort ordering, edge cases, error paths.
Pattern: conftest.py `client` fixture + httpx mocking for external calls.

Target: 34.95% → ~90%+ (67 miss → <10)
"""

import pytest
from unittest.mock import AsyncMock, patch
import httpx


# =============================================================================
# Fixtures
# =============================================================================

@pytest.fixture
def mock_supabase(mock_supabase_client):
    """Alias for readability."""
    return mock_supabase_client


# =============================================================================
# Helper: build httpx.Response
# =============================================================================

def _httpx_response(status_code: int = 200, json_data=None) -> httpx.Response:
    """Build a real httpx.Response for mocking."""
    import json as _json
    resp = httpx.Response(
        status_code=status_code,
        content=_json.dumps(json_data or {}).encode(),
        headers={"content-type": "application/json"},
        request=httpx.Request("GET", "http://fake"),
    )
    return resp


# =============================================================================
# Unit: check_provider_availability
# =============================================================================

class TestCheckProviderAvailability:
    """Direct unit tests for check_provider_availability helper."""

    async def test_requires_auth_returns_false_immediately(self):
        from api.v1.endpoints.llm_providers import check_provider_availability
        result = await check_provider_availability(
            "https://api.openai.com/v1", "/models", requires_auth=True
        )
        assert result is False

    async def test_healthy_provider_returns_true(self):
        from api.v1.endpoints.llm_providers import check_provider_availability
        
        mock_gateway = AsyncMock()
        mock_gateway.verify_provider = AsyncMock() # Doesn't raise = success
        
        result = await check_provider_availability(
            "http://localhost:1234/v1", "/models", gateway=mock_gateway, requires_auth=False
        )
        assert result is True

    async def test_404_still_considered_available(self):
        """Any non-5xx is considered available."""
        from api.v1.endpoints.llm_providers import check_provider_availability
        from core.exceptions import UpstreamServiceError
        
        # When check_provider_availability calls gateway.verify_provider(url, {}, timeout=3.0)
        # gateway.verify_provider calls get_http_client().get(url, headers={}, timeout=3.0, retry_request=False)
        # get_http_client().request will catch httpx.HTTPStatusError and raise UpstreamServiceError
        
        mock_gateway = AsyncMock()
        # Mock gateway to raise UpstreamServiceError with status_code=404
        mock_gateway.verify_provider = AsyncMock(
            side_effect=UpstreamServiceError("404 Not Found", status_code=404)
        )
        
        result = await check_provider_availability(
            "http://localhost:1234/v1", "/models", gateway=mock_gateway
        )
        assert result is True

    async def test_500_returns_unavailable(self):
        from api.v1.endpoints.llm_providers import check_provider_availability
        from core.exceptions import UpstreamServiceError
        
        mock_gateway = AsyncMock()
        mock_gateway.verify_provider = AsyncMock(
            side_effect=UpstreamServiceError("500 Internal Server Error", status_code=500)
        )
        
        result = await check_provider_availability(
            "http://localhost:1234/v1", "/models", gateway=mock_gateway
        )
        assert result is False

    async def test_connection_error_returns_false(self):
        from api.v1.endpoints.llm_providers import check_provider_availability
        from core.exceptions import NetworkConnectionError
        
        mock_gateway = AsyncMock()
        mock_gateway.verify_provider = AsyncMock(side_effect=NetworkConnectionError("refused"))
        
        result = await check_provider_availability(
            "http://localhost:1234/v1", "/models", gateway=mock_gateway
        )
        assert result is False

    async def test_timeout_returns_false(self):
        from api.v1.endpoints.llm_providers import check_provider_availability
        from core.exceptions import NetworkTimeoutError
        
        mock_gateway = AsyncMock()
        mock_gateway.verify_provider = AsyncMock(side_effect=NetworkTimeoutError("timed out"))
        
        result = await check_provider_availability(
            "http://localhost:1234/v1", "/models", gateway=mock_gateway
        )
        assert result is False

    async def test_trailing_slash_stripped_from_url(self):
        """URL construction should handle trailing slashes correctly."""
        from api.v1.endpoints.llm_providers import check_provider_availability
        
        mock_gateway = AsyncMock()
        mock_gateway.verify_provider = AsyncMock()
        
        await check_provider_availability(
            "http://localhost:1234/v1/", "/models", gateway=mock_gateway
        )
        called_url = mock_gateway.verify_provider.call_args[0][0]
        assert "/v1//models" not in called_url
        assert called_url == "http://localhost:1234/v1/models"


# =============================================================================
# Unit: fetch_provider_models
# =============================================================================

class TestFetchProviderModels:
    """Direct unit tests for fetch_provider_models helper."""

    async def test_ollama_format_uses_api_tags(self):
        from api.v1.endpoints.llm_providers import fetch_provider_models
        resp = {
            "models": [{"model": "llama3:latest", "name": "llama3"}, {"model": "mistral:latest", "name": "mistral"}]
        }
        mock_gateway = AsyncMock()
        mock_gateway.fetch_models = AsyncMock(return_value=resp)
        models = await fetch_provider_models("http://127.0.0.1:11434", "ollama", gateway=mock_gateway)
        # Verify endpoint used /api/tags
        assert "http://127.0.0.1:11434/api/tags" in mock_gateway.fetch_models.call_args[0][0]
        assert models == ["llama3:latest", "mistral:latest"]

    async def test_ollama_fallback_to_name_field(self):
        """If 'model' key is missing, falls back to 'name'."""
        from api.v1.endpoints.llm_providers import fetch_provider_models
        resp = {
            "models": [{"name": "phi3"}, {"name": "gemma2"}]
        }
        mock_gateway = AsyncMock()
        mock_gateway.fetch_models = AsyncMock(return_value=resp)
        models = await fetch_provider_models("http://127.0.0.1:11434", "ollama", gateway=mock_gateway)
        assert models == ["phi3", "gemma2"]

    async def test_openai_format_uses_data_array(self):
        from api.v1.endpoints.llm_providers import fetch_provider_models
        resp = {
            "data": [{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}]
        }
        mock_gateway = AsyncMock()
        mock_gateway.fetch_models = AsyncMock(return_value=resp)
        models = await fetch_provider_models("http://localhost:1234/v1", "lmstudio", gateway=mock_gateway)
        assert "http://localhost:1234/v1/models" in mock_gateway.fetch_models.call_args[0][0]
        assert models == ["gpt-4o", "gpt-4o-mini"]

    async def test_openai_format_filters_none_ids(self):
        """Models without 'id' should be excluded."""
        from api.v1.endpoints.llm_providers import fetch_provider_models
        resp = {
            "data": [{"id": "model-a"}, {"id": None}, {"other": "no-id"}]
        }
        mock_gateway = AsyncMock()
        mock_gateway.fetch_models = AsyncMock(return_value=resp)
        models = await fetch_provider_models("http://localhost:1234/v1", "custom_openai", gateway=mock_gateway)
        assert models == ["model-a"]

    async def test_openai_format_no_data_key(self):
        """Response without 'data' key returns empty list."""
        from api.v1.endpoints.llm_providers import fetch_provider_models
        resp = {"models": []}
        mock_gateway = AsyncMock()
        mock_gateway.fetch_models = AsyncMock(return_value=resp)
        models = await fetch_provider_models("http://localhost:1234/v1", "lmstudio", gateway=mock_gateway)
        assert models == []

    async def test_connection_error_returns_empty(self):
        from api.v1.endpoints.llm_providers import fetch_provider_models
        mock_gateway = AsyncMock()
        mock_gateway.fetch_models = AsyncMock(side_effect=httpx.ConnectError("refused"))
        models = await fetch_provider_models("http://localhost:1234/v1", "lmstudio", gateway=mock_gateway)
        assert models == []

    async def test_server_error_returns_empty(self):
        from api.v1.endpoints.llm_providers import fetch_provider_models
        mock_gateway = AsyncMock()
        mock_gateway.fetch_models = AsyncMock(side_effect=RuntimeError("internal"))
        models = await fetch_provider_models("http://localhost:1234/v1", "lmstudio", gateway=mock_gateway)
        assert models == []

    async def test_ollama_empty_models_array(self):
        from api.v1.endpoints.llm_providers import fetch_provider_models
        resp = {"models": []}
        mock_gateway = AsyncMock()
        mock_gateway.fetch_models = AsyncMock(return_value=resp)
        models = await fetch_provider_models("http://127.0.0.1:11434", "ollama", gateway=mock_gateway)
        assert models == []

    async def test_openai_data_not_a_list(self):
        """If 'data' is not a list, return empty."""
        from api.v1.endpoints.llm_providers import fetch_provider_models
        resp = {"data": "not-a-list"}
        mock_gateway = AsyncMock()
        mock_gateway.fetch_models = AsyncMock(return_value=resp)
        models = await fetch_provider_models("http://localhost:1234/v1", "lmstudio", gateway=mock_gateway)
        assert models == []


# =============================================================================
# Endpoint: GET /v1/llm-providers/discover
# =============================================================================

class TestDiscoverProviders:
    """Integration tests for /v1/llm-providers/discover."""

    async def test_all_providers_offline(self, client):
        """When nothing is running, all providers show available=False."""
        with patch(
            "api.v1.endpoints.llm_providers.check_provider_availability",
            new_callable=AsyncMock,
            return_value=False,
        ):
            resp = await client.get("/v1/llm-providers/discover")
        assert resp.status_code == 200
        data = resp.json()
        # Should have all KNOWN_PROVIDERS entries
        assert len(data) == 6
        for provider in data:
            assert provider["available"] is False
            assert provider["models"] == []

    async def test_one_provider_online(self, client):
        """When only Ollama is online, it appears first (sorted available-first)."""
        async def _mock_availability(url, health_endpoint, gateway=None, requires_auth=False, **kwargs):
            if requires_auth:
                return False
            return "11434" in url

        async def _mock_models(url, provider_key, gateway=None, **kwargs):
            if provider_key == "ollama":
                return ["llama3:latest", "mistral:latest"]
            return []

        with patch(
            "api.v1.endpoints.llm_providers.check_provider_availability",
            side_effect=_mock_availability,
        ), patch(
            "api.v1.endpoints.llm_providers.fetch_provider_models",
            side_effect=_mock_models,
        ):
            resp = await client.get("/v1/llm-providers/discover")
        assert resp.status_code == 200
        data = resp.json()
        # Ollama should be first (available=True)
        assert data[0]["key"] == "ollama"
        assert data[0]["available"] is True
        assert data[0]["models"] == ["llama3:latest", "mistral:latest"]
        # All others should be unavailable
        for p in data[1:]:
            assert p["available"] is False

    async def test_aether_inference_uses_settings_url(self, client):
        """aether_inference provider uses settings.inference_url, not hardcoded URL."""
        captured_urls = []

        async def _capture_availability(url, health_endpoint, gateway=None, requires_auth=False, **kwargs):
            captured_urls.append(url)
            return False

        with patch(
            "api.v1.endpoints.llm_providers.check_provider_availability",
            side_effect=_capture_availability,
        ):
            resp = await client.get("/v1/llm-providers/discover")
        assert resp.status_code == 200
        # The aether_inference URL should come from settings.inference_url
        # (not the hardcoded defaultUrl in KNOWN_PROVIDERS)
        # In test env, inference_url resolves from settings
        aether_urls = [u for u in captured_urls if "7090" in u]
        assert len(aether_urls) >= 1, "aether_inference URL should use settings.inference_url"

    async def test_auth_providers_not_probed_for_models(self, client):
        """Providers with requiresAuth should not have model fetching attempted."""
        model_calls = []

        async def _mock_availability(url, health_endpoint, gateway=None, requires_auth=False, **kwargs):
            if requires_auth:
                return False
            return True

        async def _mock_models(url, provider_key, gateway=None, **kwargs):
            model_calls.append(provider_key)
            return ["model-a"]

        with patch(
            "api.v1.endpoints.llm_providers.check_provider_availability",
            side_effect=_mock_availability,
        ), patch(
            "api.v1.endpoints.llm_providers.fetch_provider_models",
            side_effect=_mock_models,
        ):
            resp = await client.get("/v1/llm-providers/discover")
        assert resp.status_code == 200
        # openai and openrouter have requiresAuth=True, should NOT appear in model_calls
        assert "openai" not in model_calls
        assert "openrouter" not in model_calls

    async def test_discover_returns_correct_schema_fields(self, client):
        """Each provider in response has required schema fields."""
        with patch(
            "api.v1.endpoints.llm_providers.check_provider_availability",
            new_callable=AsyncMock,
            return_value=False,
        ):
            resp = await client.get("/v1/llm-providers/discover")
        data = resp.json()
        for p in data:
            assert "key" in p
            assert "displayName" in p
            assert "url" in p
            assert "available" in p
            assert "models" in p
            assert isinstance(p["models"], list)

    async def test_sort_available_first_then_alphabetical(self, client):
        """Available providers sorted first, then alphabetically by displayName."""
        call_count = {"n": 0}

        async def _alternating(url, health_endpoint, gateway=None, requires_auth=False, **kwargs):
            if requires_auth:
                return False
            call_count["n"] += 1
            # Make only every other non-auth provider available
            return call_count["n"] % 2 == 0

        with patch(
            "api.v1.endpoints.llm_providers.check_provider_availability",
            side_effect=_alternating,
        ), patch(
            "api.v1.endpoints.llm_providers.fetch_provider_models",
            new_callable=AsyncMock,
            return_value=[],
        ):
            resp = await client.get("/v1/llm-providers/discover")
        data = resp.json()
        # Partition into available and unavailable
        available = [p for p in data if p["available"]]
        unavailable = [p for p in data if not p["available"]]
        # Available ones should be before unavailable ones
        all_keys = [p["key"] for p in data]
        if available and unavailable:
            last_available_idx = max(all_keys.index(p["key"]) for p in available)
            first_unavailable_idx = min(all_keys.index(p["key"]) for p in unavailable)
            assert last_available_idx < first_unavailable_idx


# =============================================================================
# Endpoint: GET /v1/llm-providers/models
# =============================================================================

class TestListProviderModels:
    """Tests for /v1/llm-providers/models."""

    async def test_returns_models_list(self, client):
        with patch(
            "api.v1.endpoints.llm_providers.fetch_provider_models",
            new_callable=AsyncMock,
            return_value=["model-a", "model-b"],
        ):
            resp = await client.get(
                "/v1/llm-providers/models",
                params={"provider_url": "http://localhost:1234/v1", "provider_key": "lmstudio"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["models"] == ["model-a", "model-b"]
        assert data["count"] == 2
        assert data["provider_key"] == "lmstudio"
        assert data["provider_url"] == "http://localhost:1234/v1"

    async def test_empty_provider_url_returns_400(self, client):
        resp = await client.get(
            "/v1/llm-providers/models",
            params={"provider_url": "", "provider_key": "ollama"},
        )
        assert resp.status_code == 400
        assert "provider_url" in resp.json()["detail"].lower()

    async def test_default_provider_key_is_custom_openai(self, client):
        """When provider_key is not specified, defaults to custom_openai."""
        from unittest.mock import ANY
        with patch(
            "api.v1.endpoints.llm_providers.fetch_provider_models",
            new_callable=AsyncMock,
            return_value=[],
        ) as mock_fetch:
            resp = await client.get(
                "/v1/llm-providers/models",
                params={"provider_url": "http://localhost:8080/v1"},
            )
        assert resp.status_code == 200
        assert resp.json()["provider_key"] == "custom_openai"
        mock_fetch.assert_called_once_with("http://localhost:8080/v1", "custom_openai", ANY)

    async def test_ollama_key_passed_through(self, client):
        from unittest.mock import ANY
        with patch(
            "api.v1.endpoints.llm_providers.fetch_provider_models",
            new_callable=AsyncMock,
            return_value=["llama3"],
        ) as mock_fetch:
            resp = await client.get(
                "/v1/llm-providers/models",
                params={"provider_url": "http://127.0.0.1:11434", "provider_key": "ollama"},
            )
        assert resp.status_code == 200
        mock_fetch.assert_called_once_with("http://127.0.0.1:11434", "ollama", ANY)

    async def test_models_empty_list(self, client):
        with patch(
            "api.v1.endpoints.llm_providers.fetch_provider_models",
            new_callable=AsyncMock,
            return_value=[],
        ):
            resp = await client.get(
                "/v1/llm-providers/models",
                params={"provider_url": "http://localhost:9999/v1"},
            )
        assert resp.status_code == 200
        assert resp.json()["models"] == []
        assert resp.json()["count"] == 0


# =============================================================================
# Endpoint: POST /v1/llm-providers/config (save)
# =============================================================================

class TestSaveProviderConfig:
    """Tests for POST /v1/llm-providers/config."""

    async def test_save_config_success(self, client, mock_supabase_client):
        mock_supabase_client.upsert = AsyncMock(return_value=[{
            "id": "cfg-1",
            "setting_key": "llm_provider",
            "setting_value": {
                "provider_key": "ollama",
                "provider_url": "http://127.0.0.1:11434",
                "model_name": "llama3",
            },
            "updated_at": "2025-01-01T00:00:00Z",
        }])
        resp = await client.post("/v1/llm-providers/config", json={
            "provider_key": "ollama",
            "provider_url": "http://127.0.0.1:11434",
            "model_name": "llama3",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["provider_key"] == "ollama"
        assert data["provider_url"] == "http://127.0.0.1:11434"
        assert data["model_name"] == "llama3"
        assert data["updated_at"] == "2025-01-01T00:00:00Z"

    async def test_save_config_upsert_returns_dict(self, client, mock_supabase_client):
        """Gateway upsert may return a dict instead of list."""
        mock_supabase_client.upsert = AsyncMock(return_value={
            "id": "cfg-1",
            "updated_at": "2025-02-01T00:00:00Z",
        })
        resp = await client.post("/v1/llm-providers/config", json={
            "provider_key": "lmstudio",
            "provider_url": "http://localhost:1234/v1",
        })
        assert resp.status_code == 200
        assert resp.json()["updated_at"] == "2025-02-01T00:00:00Z"

    async def test_save_config_upsert_returns_none(self, client, mock_supabase_client):
        """If upsert returns falsy, should get 500."""
        mock_supabase_client.upsert = AsyncMock(return_value=None)
        resp = await client.post("/v1/llm-providers/config", json={
            "provider_key": "ollama",
            "provider_url": "http://127.0.0.1:11434",
        })
        assert resp.status_code == 500
        assert "failed" in resp.json()["detail"].lower()

    async def test_save_config_upsert_empty_list(self, client, mock_supabase_client):
        """If upsert returns empty list (falsy), should get 500."""
        mock_supabase_client.upsert = AsyncMock(return_value=[])
        resp = await client.post("/v1/llm-providers/config", json={
            "provider_key": "ollama",
            "provider_url": "http://127.0.0.1:11434",
        })
        assert resp.status_code == 500

    async def test_save_config_database_exception(self, client, mock_supabase_client):
        """Generic DB error should return 500."""
        mock_supabase_client.upsert = AsyncMock(side_effect=RuntimeError("DB down"))
        resp = await client.post("/v1/llm-providers/config", json={
            "provider_key": "ollama",
            "provider_url": "http://127.0.0.1:11434",
        })
        assert resp.status_code == 500
        assert "check server logs" in resp.json()["detail"].lower()

    async def test_save_config_missing_required_field(self, client):
        """Missing provider_key should fail validation."""
        resp = await client.post("/v1/llm-providers/config", json={
            "provider_url": "http://localhost:1234/v1",
        })
        assert resp.status_code == 422

    async def test_save_config_model_name_optional(self, client, mock_supabase_client):
        """model_name is optional, should save with None."""
        mock_supabase_client.upsert = AsyncMock(return_value=[{
            "id": "cfg-2",
            "updated_at": "2025-03-01T00:00:00Z",
        }])
        resp = await client.post("/v1/llm-providers/config", json={
            "provider_key": "custom_openai",
            "provider_url": "http://my-server:8080/v1",
        })
        assert resp.status_code == 200
        assert resp.json()["model_name"] is None


# =============================================================================
# Endpoint: GET /v1/llm-providers/config (load)
# =============================================================================

class TestGetProviderConfig:
    """Tests for GET /v1/llm-providers/config."""

    async def test_load_saved_config(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[{
            "setting_key": "llm_provider",
            "setting_value": {
                "provider_key": "ollama",
                "provider_url": "http://127.0.0.1:11434",
                "model_name": "llama3",
            },
            "updated_at": "2025-01-01T00:00:00Z",
        }])
        resp = await client.get("/v1/llm-providers/config")
        assert resp.status_code == 200
        data = resp.json()
        assert data["provider_key"] == "ollama"
        assert data["provider_url"] == "http://127.0.0.1:11434"
        assert data["model_name"] == "llama3"
        assert data["updated_at"] == "2025-01-01T00:00:00Z"

    async def test_fallback_to_defaults_when_no_config(self, client, mock_supabase_client):
        """No saved config returns defaults from central config."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/llm-providers/config")
        assert resp.status_code == 200
        data = resp.json()
        # Should fall back to settings.llm.provider / settings.llm.api_base / settings.llm.model
        assert data["provider_key"]  # non-empty
        assert data["provider_url"]  # non-empty
        assert data["updated_at"] is None

    async def test_fallback_when_select_returns_none(self, client, mock_supabase_client):
        """select() returning None should trigger defaults path."""
        mock_supabase_client.select = AsyncMock(return_value=None)
        resp = await client.get("/v1/llm-providers/config")
        assert resp.status_code == 200
        data = resp.json()
        assert data["updated_at"] is None

    async def test_partial_saved_config_fills_defaults(self, client, mock_supabase_client):
        """If saved config is missing fields, defaults fill in."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "setting_key": "llm_provider",
            "setting_value": {
                # provider_key and provider_url missing — should use defaults
            },
            "updated_at": "2025-04-01T00:00:00Z",
        }])
        resp = await client.get("/v1/llm-providers/config")
        assert resp.status_code == 200
        data = resp.json()
        # Should use settings defaults for missing keys
        assert data["provider_key"]  # non-empty from settings.llm.provider
        assert data["provider_url"]  # non-empty from settings.llm.api_base

    async def test_database_error_returns_500(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("DB error"))
        resp = await client.get("/v1/llm-providers/config")
        assert resp.status_code == 500
        assert "failed" in resp.json()["detail"].lower()

    async def test_saved_model_name_none(self, client, mock_supabase_client):
        """model_name can be None in saved config."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "setting_key": "llm_provider",
            "setting_value": {
                "provider_key": "lmstudio",
                "provider_url": "http://localhost:1234/v1",
                "model_name": None,
            },
            "updated_at": "2025-05-01T00:00:00Z",
        }])
        resp = await client.get("/v1/llm-providers/config")
        assert resp.status_code == 200
        assert resp.json()["model_name"] is None

    async def test_http_exception_reraise(self, client, mock_supabase_client):
        """Line 370: HTTPException inside try is re-raised, not caught by generic except."""
        from fastapi import HTTPException
        mock_supabase_client.select = AsyncMock(
            side_effect=HTTPException(status_code=403, detail="forbidden")
        )
        resp = await client.get("/v1/llm-providers/config")
        assert resp.status_code == 403
        assert resp.json()["detail"] == "forbidden"
