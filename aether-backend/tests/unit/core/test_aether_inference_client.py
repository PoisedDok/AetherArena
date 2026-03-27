"""
Tests for core.integrations.providers.aether_inference.client

Coverage target: 100% of client.py (228 lines, 0 existing tests).

Mock boundaries:
- config.settings.get_settings → lazy import; patched at source module
- services.aether_inference.platform_detector.detect_platform → lazy import; patched at source
- httpx.AsyncClient → async HTTP context manager

Real logic under test:
- URL resolution (explicit vs settings)
- Model resolution (3-level settings chain → platform detection → "glm-ocr" fallback)
- Payload assembly with kwargs filtering (None values excluded)
- Health check dual-probe (/health → /models fallback)
- Singleton factory (create/reuse/replace)
- Timeout configuration (connect/read/write/pool)
"""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from core.integrations.providers.aether_inference.client import (
    InferenceClient,
    get_inference_client,
    inference_health,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BASE_URL = "http://127.0.0.1:7090/v1"


def _settings(inference_url=_BASE_URL, vision_model="", vision_model_provider="", default_model=""):
    s = MagicMock()
    s.inference_url = inference_url
    s.vision_document.provider_config.model = vision_model_provider
    s.inference.default_vision_model = vision_model
    s.inference.default_model = default_model
    return s


def _mock_response(json_data=None, status_code=200):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json.return_value = json_data if json_data is not None else {}
    if status_code >= 400:
        resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            f"HTTP {status_code}", request=MagicMock(), response=resp
        )
    else:
        resp.raise_for_status.return_value = None
    return resp


def _async_client_mock(get_return=None, post_return=None, get_side_effect=None):
    """Create a mock httpx.AsyncClient with async context manager support."""
    client = AsyncMock()
    if get_side_effect:
        client.get.side_effect = get_side_effect
    elif get_return:
        client.get.return_value = get_return
    if post_return:
        client.post.return_value = post_return

    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm, client


# ---------------------------------------------------------------------------
# InferenceClient.__init__
# ---------------------------------------------------------------------------

class TestInferenceClientInit:

    def test_stores_base_url_and_timeout(self):
        c = InferenceClient(base_url="http://host:9090/v1", timeout=30.0)
        assert c._base_url == "http://host:9090/v1"
        assert c._timeout == 30.0

    def test_defaults(self):
        c = InferenceClient()
        assert c._base_url is None
        assert c._timeout == 120.0


# ---------------------------------------------------------------------------
# _get_base_url
# ---------------------------------------------------------------------------

class TestGetBaseUrl:

    def test_returns_explicit_url(self):
        c = InferenceClient(base_url="http://explicit:8080/v1")
        assert c._get_base_url() == "http://explicit:8080/v1"

    @patch("config.settings.get_settings")
    def test_resolves_from_settings(self, mock_gs):
        mock_gs.return_value = _settings(inference_url="http://from-settings:7090/v1")
        c = InferenceClient()
        assert c._get_base_url() == "http://from-settings:7090/v1"

    @patch("config.settings.get_settings", side_effect=RuntimeError("no config"))
    def test_propagates_settings_error(self, mock_gs):
        c = InferenceClient()
        with pytest.raises(RuntimeError, match="no config"):
            c._get_base_url()


# ---------------------------------------------------------------------------
# _get_timeout
# ---------------------------------------------------------------------------

class TestGetTimeout:

    def test_returns_httpx_timeout_object(self):
        c = InferenceClient(timeout=60.0)
        t = c._get_timeout()
        assert isinstance(t, httpx.Timeout)
        assert t.read == 60.0
        assert t.connect == 5.0
        assert t.write == 10.0
        assert t.pool == 5.0

    def test_default_120_read_timeout(self):
        c = InferenceClient()
        t = c._get_timeout()
        assert t.read == 120.0


# ---------------------------------------------------------------------------
# _resolve_default_model
# ---------------------------------------------------------------------------

class TestResolveDefaultModel:

    @patch("config.settings.get_settings")
    def test_from_vision_document_provider(self, mock_gs):
        mock_gs.return_value = _settings(vision_model_provider="mlx-glm-ocr")
        c = InferenceClient()
        assert c._resolve_default_model() == "mlx-glm-ocr"

    @patch("config.settings.get_settings")
    def test_fallback_to_default_vision_model(self, mock_gs):
        mock_gs.return_value = _settings(vision_model="lfm-vl", vision_model_provider="")
        c = InferenceClient()
        assert c._resolve_default_model() == "lfm-vl"

    @patch("config.settings.get_settings")
    def test_fallback_to_default_model(self, mock_gs):
        mock_gs.return_value = _settings(default_model="qwen3", vision_model="", vision_model_provider="")
        c = InferenceClient()
        assert c._resolve_default_model() == "qwen3"

    @patch("config.settings.get_settings", side_effect=RuntimeError("no settings"))
    def test_fallback_to_platform_detection(self, mock_gs):
        mock_platform = MagicMock()
        mock_platform.glm_ocr_model = "platform-ocr-model"

        with patch(
            "services.aether_inference.platform_detector.detect_platform",
            return_value=mock_platform,
        ):
            c = InferenceClient()
            assert c._resolve_default_model() == "platform-ocr-model"

    @patch("config.settings.get_settings", side_effect=RuntimeError("no settings"))
    def test_ultimate_fallback_glm_ocr(self, mock_gs):
        with patch(
            "services.aether_inference.platform_detector.detect_platform",
            side_effect=ImportError("no platform"),
        ):
            c = InferenceClient()
            assert c._resolve_default_model() == "glm-ocr"

    @patch("config.settings.get_settings")
    def test_all_settings_empty_falls_to_platform(self, mock_gs):
        """Settings load but all model fields are empty strings."""
        mock_gs.return_value = _settings(vision_model_provider="", vision_model="", default_model="")

        mock_platform = MagicMock()
        mock_platform.glm_ocr_model = "from-platform"
        with patch(
            "services.aether_inference.platform_detector.detect_platform",
            return_value=mock_platform,
        ):
            c = InferenceClient()
            assert c._resolve_default_model() == "from-platform"


# ---------------------------------------------------------------------------
# chat_completion
# ---------------------------------------------------------------------------

class TestChatCompletion:

    @pytest.mark.asyncio
    async def test_full_args(self):
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response({"choices": [{"message": {"content": "hello"}}]})
        cm, mock_client = _async_client_mock(post_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.chat_completion(
                messages=[{"role": "user", "content": "Hi"}],
                model="test-model",
                max_tokens=4096,
                temperature=0.7,
                stream=False,
            )

        mock_client.post.assert_awaited_once()
        call_args = mock_client.post.call_args
        assert call_args[0][0] == f"{_BASE_URL}/chat/completions"
        payload = call_args[1]["json"]
        assert payload["model"] == "test-model"
        assert payload["messages"] == [{"role": "user", "content": "Hi"}]
        assert payload["max_tokens"] == 4096
        assert payload["temperature"] == 0.7
        assert payload["stream"] is False
        assert result == {"choices": [{"message": {"content": "hello"}}]}

    @pytest.mark.asyncio
    @patch("config.settings.get_settings")
    async def test_model_auto_resolved(self, mock_gs):
        """No model provided → _resolve_default_model called."""
        mock_gs.return_value = _settings(vision_model_provider="auto-model")
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response({})
        cm, mock_client = _async_client_mock(post_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            await c.chat_completion(messages=[{"role": "user", "content": "x"}])

        payload = mock_client.post.call_args[1]["json"]
        assert payload["model"] == "auto-model"

    @pytest.mark.asyncio
    async def test_kwargs_none_filtered(self):
        """kwargs with None values are excluded from payload."""
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response({})
        cm, mock_client = _async_client_mock(post_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            await c.chat_completion(
                messages=[{"role": "user", "content": "x"}],
                model="m",
                top_p=None,
                stop=None,
            )

        payload = mock_client.post.call_args[1]["json"]
        assert "top_p" not in payload
        assert "stop" not in payload

    @pytest.mark.asyncio
    async def test_kwargs_included(self):
        """Non-None kwargs are included in payload."""
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response({})
        cm, mock_client = _async_client_mock(post_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            await c.chat_completion(
                messages=[{"role": "user", "content": "x"}],
                model="m",
                top_p=0.9,
                stop=["###"],
            )

        payload = mock_client.post.call_args[1]["json"]
        assert payload["top_p"] == 0.9
        assert payload["stop"] == ["###"]

    @pytest.mark.asyncio
    async def test_http_error_propagates(self):
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response(status_code=500)
        cm, _ = _async_client_mock(post_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            with pytest.raises(httpx.HTTPStatusError):
                await c.chat_completion(
                    messages=[{"role": "user", "content": "x"}], model="m"
                )

    @pytest.mark.asyncio
    async def test_explicit_model_not_overridden(self):
        """When caller provides model, _resolve_default_model is NOT called."""
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response({})
        cm, mock_client = _async_client_mock(post_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            with patch.object(c, "_resolve_default_model") as mock_resolve:
                await c.chat_completion(
                    messages=[{"role": "user", "content": "x"}], model="explicit"
                )
                mock_resolve.assert_not_called()

        assert mock_client.post.call_args[1]["json"]["model"] == "explicit"


# ---------------------------------------------------------------------------
# list_models
# ---------------------------------------------------------------------------

class TestListModels:

    @pytest.mark.asyncio
    async def test_success(self):
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response({"data": [{"id": "model-1"}, {"id": "model-2"}]})
        cm, mock_client = _async_client_mock(get_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.list_models()

        mock_client.get.assert_awaited_once_with(f"{_BASE_URL}/models")
        assert result == [{"id": "model-1"}, {"id": "model-2"}]

    @pytest.mark.asyncio
    async def test_missing_data_key(self):
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response({"models": ["a"]})
        cm, _ = _async_client_mock(get_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.list_models()

        assert result == []

    @pytest.mark.asyncio
    async def test_http_error_propagates(self):
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response(status_code=500)
        cm, _ = _async_client_mock(get_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            with pytest.raises(httpx.HTTPStatusError):
                await c.list_models()


# ---------------------------------------------------------------------------
# health_check
# ---------------------------------------------------------------------------

class TestHealthCheck:

    @pytest.mark.asyncio
    async def test_health_endpoint_success(self):
        c = InferenceClient(base_url=_BASE_URL)
        resp = _mock_response(status_code=200)
        cm, _ = _async_client_mock(get_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.health_check()

        assert result["healthy"] is True
        assert "response_time_ms" in result

    @pytest.mark.asyncio
    async def test_health_request_error_fallback_to_models(self):
        """If /health raises RequestError, falls back to /models."""
        c = InferenceClient(base_url=_BASE_URL)
        models_resp = _mock_response(status_code=200)

        cm, mock_client = _async_client_mock()
        mock_client.get.side_effect = [
            httpx.RequestError("connection refused"),  # /health fails
            models_resp,  # /models succeeds
        ]

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.health_check()

        assert result["healthy"] is True
        assert result["status_code"] == 200
        assert mock_client.get.await_count == 2

    @pytest.mark.asyncio
    async def test_health_server_error_fallback_to_models(self):
        """If /health returns >= 500, falls through to /models."""
        c = InferenceClient(base_url=_BASE_URL)
        health_resp = _mock_response(status_code=503)
        models_resp = _mock_response(status_code=200)

        cm, mock_client = _async_client_mock()
        mock_client.get.side_effect = [health_resp, models_resp]

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.health_check()

        # /health returned 503 (>= 500), so it fell through to /models
        assert result["healthy"] is True
        assert result["status_code"] == 200

    @pytest.mark.asyncio
    async def test_models_unhealthy(self):
        """/models returns >= 500."""
        c = InferenceClient(base_url=_BASE_URL)

        cm, mock_client = _async_client_mock()
        mock_client.get.side_effect = [
            httpx.RequestError("no /health"),
            _mock_response(status_code=502),
        ]

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.health_check()

        assert result["healthy"] is False
        assert result["status_code"] == 502

    @pytest.mark.asyncio
    async def test_connect_error(self):
        c = InferenceClient(base_url=_BASE_URL)

        cm, mock_client = _async_client_mock()
        mock_client.get.side_effect = httpx.ConnectError("refused")

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.health_check()

        assert result["healthy"] is False
        assert "ConnectError" in result["error"]

    @pytest.mark.asyncio
    async def test_timeout_error(self):
        c = InferenceClient(base_url=_BASE_URL)

        cm, mock_client = _async_client_mock()
        mock_client.get.side_effect = httpx.ReadTimeout("timed out")

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.health_check()

        assert result["healthy"] is False
        assert "ReadTimeout" in result["error"]

    @pytest.mark.asyncio
    async def test_generic_exception(self):
        c = InferenceClient(base_url=_BASE_URL)

        cm, mock_client = _async_client_mock()
        mock_client.get.side_effect = RuntimeError("unexpected")

        with patch("httpx.AsyncClient", return_value=cm):
            result = await c.health_check()

        assert result["healthy"] is False
        assert "unexpected" in result["error"]

    @pytest.mark.asyncio
    async def test_health_url_construction(self):
        """BUG REGRESSION: removesuffix('/v1') instead of rstrip('/v1').
        rstrip strips individual chars, corrupting ports ending in 1/v.
        """
        c = InferenceClient(base_url="http://host:7091/v1")
        resp = _mock_response(status_code=200)
        cm, mock_client = _async_client_mock(get_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            await c.health_check()

        # First call is /health — verify port is NOT corrupted
        first_call_url = mock_client.get.call_args_list[0][0][0]
        assert first_call_url == "http://host:7091/health"

    @pytest.mark.asyncio
    async def test_health_url_without_v1_suffix(self):
        """Base URL that doesn't end with /v1 — removesuffix is no-op."""
        c = InferenceClient(base_url="http://host:7090/api")
        resp = _mock_response(status_code=200)
        cm, mock_client = _async_client_mock(get_return=resp)

        with patch("httpx.AsyncClient", return_value=cm):
            await c.health_check()

        first_call_url = mock_client.get.call_args_list[0][0][0]
        assert first_call_url == "http://host:7090/api/health"


# ---------------------------------------------------------------------------
# get_inference_client (singleton)
# ---------------------------------------------------------------------------

class TestGetInferenceClient:

    def setup_method(self):
        """Reset singleton before each test."""
        import core.integrations.providers.aether_inference.client as mod
        mod._client = None

    def test_creates_new_client(self):
        c = get_inference_client(base_url="http://host:9090/v1")
        assert isinstance(c, InferenceClient)
        assert c._base_url == "http://host:9090/v1"

    def test_reuses_existing(self):
        c1 = get_inference_client(base_url="http://host:9090/v1")
        c2 = get_inference_client(base_url="http://host:9090/v1")
        assert c1 is c2

    def test_replaces_on_url_change(self):
        c1 = get_inference_client(base_url="http://host:9090/v1")
        c2 = get_inference_client(base_url="http://host:8080/v1")
        assert c1 is not c2
        assert c2._base_url == "http://host:8080/v1"

    def test_reuses_when_no_url_provided(self):
        c1 = get_inference_client(base_url="http://host:9090/v1")
        c2 = get_inference_client()  # no base_url
        assert c1 is c2

    def test_creates_without_url(self):
        c = get_inference_client()
        assert isinstance(c, InferenceClient)
        assert c._base_url is None


# ---------------------------------------------------------------------------
# inference_health
# ---------------------------------------------------------------------------

class TestInferenceHealth:

    def setup_method(self):
        import core.integrations.providers.aether_inference.client as mod
        mod._client = None

    @pytest.mark.asyncio
    async def test_delegates_to_health_check(self):
        mock_client = MagicMock(spec=InferenceClient)
        mock_client.health_check = AsyncMock(return_value={"healthy": True})

        with patch(
            "core.integrations.providers.aether_inference.client.get_inference_client",
            return_value=mock_client,
        ):
            result = await inference_health()

        assert result == {"healthy": True}
        mock_client.health_check.assert_awaited_once()
