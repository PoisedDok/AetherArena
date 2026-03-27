"""
Model Management Endpoint Tests

Covers all 3 routes in api/v1/endpoints/models.py:
  GET /v1/models
  GET /v1/models/active
  GET /v1/models/capabilities

Mocking strategy:
  - httpx.AsyncClient: patched for external LLM provider calls
  - get_runtime_settings: inherited from conftest (settings fixture)
  - litellm: patched to avoid import dependency
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock
import httpx as real_httpx


def _mock_httpx_models_response(models_data, status_code=200):
    """Create mock httpx client returning models data."""
    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    mock_resp.json.return_value = models_data
    mock_resp.raise_for_status = MagicMock()
    if status_code >= 400:
        mock_resp.raise_for_status.side_effect = real_httpx.HTTPStatusError(
            f"HTTP {status_code}",
            request=MagicMock(),
            response=mock_resp,
        )
        mock_resp.text = f"Error {status_code}"

    mock_client = AsyncMock()
    mock_client.request = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


# ===================================================================
# GET /v1/models
# ===================================================================


class TestListModels:

    @pytest.mark.asyncio
    async def test_list_openai_format(self, client):
        """List models from OpenAI-compatible format."""
        models_data = {
            "data": [
                {"id": "Qwen3-4b-Instruct-2507-MLX-8bit", "object": "model"},
                {"id": "llama-3.2-3b", "object": "model"},
            ]
        }
        mock_client = _mock_httpx_models_response(models_data)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models")

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 2
        assert "Qwen3-4b-Instruct-2507-MLX-8bit" in body["models"]

    @pytest.mark.asyncio
    async def test_list_simple_list_format(self, client):
        """List models from simple list format."""
        models_data = [
            {"id": "model-a"},
            {"name": "model-b"},
        ]
        mock_client = _mock_httpx_models_response(models_data)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models")

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 2

    @pytest.mark.asyncio
    async def test_list_with_base_override(self, client):
        """Custom base URL override works."""
        models_data = {"data": [{"id": "custom-model"}]}
        mock_client = _mock_httpx_models_response(models_data)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models", params={"base": "http://custom:1234/v1"})

        assert resp.status_code == 200
        assert resp.json()["count"] == 1

    @pytest.mark.asyncio
    async def test_list_timeout_returns_504(self, client):
        """Provider timeout returns 504."""
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=real_httpx.TimeoutException("timed out"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models")

        assert resp.status_code == 504

    @pytest.mark.asyncio
    async def test_list_http_error_forwarded(self, client):
        """Provider HTTP error forwarded."""
        mock_client = _mock_httpx_models_response({}, status_code=503)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models")

        assert resp.status_code == 503


# ===================================================================
# GET /v1/models/active
# ===================================================================


class TestActiveModel:

    @pytest.mark.asyncio
    async def test_active_model_returns_config(self, client):
        """Active model returns current LLM config."""
        resp = await client.get("/v1/models/active")

        assert resp.status_code == 200
        body = resp.json()
        assert "model" in body
        assert "provider" in body
        assert "api_base" in body
        assert "supports_vision" in body
        assert "context_window" in body
        assert "max_tokens" in body
        assert "temperature" in body


# ===================================================================
# GET /v1/models/capabilities
# ===================================================================


class TestModelCapabilities:

    @pytest.mark.asyncio
    async def test_capabilities_returns_model_info(self, client):
        """Capabilities returns model capabilities."""
        models_data = {
            "data": [
                {
                    "id": "Qwen3-4b-Instruct-2507-MLX-8bit",
                    "parameters": {
                        "context_length": 32768,
                        "default_max_tokens": 4096,
                        "default_temperature": 0.7,
                    },
                    "capabilities": {"vision": False, "tool_use": True},
                }
            ]
        }
        mock_client = _mock_httpx_models_response(models_data)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models/capabilities", params={"model": "Qwen3-4b-Instruct-2507-MLX-8bit"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["model"] == "Qwen3-4b-Instruct-2507-MLX-8bit"
        assert body["supports_streaming"] is True
        assert "context_window_max" in body
        assert "default_max_tokens" in body

    @pytest.mark.asyncio
    async def test_capabilities_missing_model_returns_422(self, client):
        """Missing model query param returns 422."""
        resp = await client.get("/v1/models/capabilities")

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_capabilities_inference_unavailable(self, client):
        """Capabilities still returns when inference server is down."""
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=real_httpx.ConnectError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models/capabilities", params={"model": "Qwen3-4b-Instruct-2507-MLX-8bit"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["model"] == "Qwen3-4b-Instruct-2507-MLX-8bit"
        # Physical limits unknown when inference down
        assert body.get("context_window_max") is None


# ===================================================================
# Deep Coverage: error handlers + data format branches
# ===================================================================


class TestListModelsDeep:

    async def test_no_api_base_returns_400(self, app, client):
        """Empty API base URL returns 400."""
        from api.dependencies import get_runtime_settings
        mock_settings = MagicMock()
        mock_settings.llm.api_base = ""
        mock_settings.llm.model = "test"

        app.dependency_overrides[get_runtime_settings] = lambda: mock_settings
        try:
            resp = await client.get("/v1/models")
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
        assert resp.status_code == 400
        assert "no api base" in resp.json()["detail"].lower()

    async def test_simple_list_format(self, client):
        """Response is a plain list of dicts."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"id": "model-a"}, {"name": "model-b"}, "model-c"
        ]
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models")
        assert resp.status_code == 200
        body = resp.json()
        assert "model-a" in body["models"]
        assert "model-b" in body["models"]
        assert "model-c" in body["models"]

    async def test_generic_exception_returns_502(self, client):
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=RuntimeError("unexpected"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models")
        assert resp.status_code == 502

    async def test_http_status_error_proxied(self, client):
        import httpx as real_httpx
        mock_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"
        mock_client.request = AsyncMock(side_effect=real_httpx.HTTPStatusError(
            "401", request=MagicMock(), response=mock_response))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models")
        assert resp.status_code == 401


class TestGetActiveModelDeep:

    async def test_active_model_exception(self, app, client):
        from api.dependencies import get_runtime_settings

        def _broken():
            raise RuntimeError("settings broken")

        app.dependency_overrides[get_runtime_settings] = _broken
        try:
            resp = await client.get("/v1/models/active")
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
        assert resp.status_code == 500


class TestModelCapabilitiesDeep:

    async def test_litellm_import_error_graceful(self, client):
        """litellm not installed doesn't crash."""
        import httpx as real_httpx
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=real_httpx.ConnectError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client), \
             patch.dict("sys.modules", {"litellm": None}):
            resp = await client.get("/v1/models/capabilities", params={"model": "test-model"})
        assert resp.status_code == 200

    async def test_fuzzy_model_match(self, client):
        """Fuzzy match: model tokens overlap with inference server model IDs."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "data": [{
                "id": "Qwen/Qwen2.5-Coder-32B-Instruct",
                "model_type": "vision",
                "parameters": {
                    "context_length": 131072,
                    "default_max_tokens": 4096,
                    "default_temperature": 0.7,
                },
                "capabilities": {"vision": True, "tool_use": True},
            }]
        }

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models/capabilities", params={"model": "qwen2.5-coder-32b"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["supports_vision"] is True
        assert body["supports_functions"] is True
        assert body["context_window_max"] == 131072

    async def test_no_model_match_on_inference_server(self, client):
        """No matching model on inference server returns defaults."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "data": [{"id": "totally-different-model", "parameters": {"context_length": 8192}}]
        }

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/models/capabilities", params={"model": "unrelated"})
        assert resp.status_code == 200
        assert resp.json()["context_window_max"] is None

    async def test_litellm_supports_vision_raises(self, client):
        """litellm.supports_vision raises → supports_vision=False (lines 203-204)."""
        import httpx as real_httpx

        mock_litellm = MagicMock()
        mock_litellm.supports_vision.side_effect = RuntimeError("bad model lookup")

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=real_httpx.ConnectError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client), \
             patch.dict("sys.modules", {"litellm": mock_litellm}):
            resp = await client.get("/v1/models/capabilities", params={"model": "test-model"})
        assert resp.status_code == 200
        assert resp.json()["supports_vision"] is False

    async def test_litellm_import_generic_exception(self, client):
        """litellm import raises non-ImportError → warning logged (lines 207-208)."""
        import builtins
        import httpx as real_httpx

        original_import = builtins.__import__

        def broken_import(name, *args, **kwargs):
            if name == "litellm":
                raise RuntimeError("litellm broken during import")
            return original_import(name, *args, **kwargs)

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=real_httpx.ConnectError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        # Remove litellm from sys.modules so __import__ is actually called
        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client), \
             patch.dict("sys.modules", {k: v for k, v in __import__('sys').modules.items() if k != "litellm" and not k.startswith("litellm.")}), \
             patch("builtins.__import__", side_effect=broken_import):
            resp = await client.get("/v1/models/capabilities", params={"model": "test-model"})
        assert resp.status_code == 200


class TestGetActiveModelDeepV2:
    """Cover get_active_model exception handler (lines 144-146)."""

    async def test_active_model_settings_attribute_error(self, app, client):
        """Settings resolves but .llm.model raises → 500 (lines 144-146).

        Override get_runtime_settings to return a mock where llm.model raises.
        The exception happens INSIDE the endpoint's try block.
        """
        from api.dependencies import get_runtime_settings
        from unittest.mock import PropertyMock

        mock_settings = MagicMock()
        type(mock_settings.llm).model = PropertyMock(
            side_effect=RuntimeError("settings corrupted")
        )

        app.dependency_overrides[get_runtime_settings] = lambda: mock_settings
        try:
            resp = await client.get("/v1/models/active")
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)
        assert resp.status_code == 500
