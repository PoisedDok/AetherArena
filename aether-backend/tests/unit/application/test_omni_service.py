"""
Unit Tests: OmniService (application/omni/service.py)

Comprehensive coverage of screenshot capture, screen analysis via vision LLM,
workflow listing, health check, and shutdown.

Mock boundaries:
- omni_tools → mock (injected dependency)
- httpx.AsyncClient → mock for vision LLM calls
- config.settings.get_settings → mock for provider resolution
"""

from __future__ import annotations

import json
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from application.omni.service import OmniService, OmniServiceError


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_omni_tools(
    *,
    screenshot_result: Dict[str, Any] | None = None,
    workflows_result: Dict[str, Any] | None = None,
) -> MagicMock:
    """Create a mock omni_tools."""
    tools = MagicMock()
    tools.screenshot.return_value = screenshot_result or {
        "success": True,
        "base64": "iVBOR...base64data",
    }
    tools.workflows.return_value = workflows_result or {
        "analyze": {"name": "analyze", "description": "Analyze screen"},
    }
    return tools


def _make_settings_mock(
    *,
    provider_url: str = "http://127.0.0.1:7090/v1",
    model: str = "test-vision-model",
    api_key: str = "not-needed",
    temperature: float = 0.1,
    max_tokens: int = 4096,
    llm_timeout: float = 300.0,
    provider_name: str = "aether_inference",
) -> MagicMock:
    """Create a mock settings for OmniService."""
    settings = MagicMock()
    settings.resolve_service_provider.return_value = (provider_url, model, api_key)
    settings.vision_document.provider_config.provider = provider_name
    settings.inference.get_agent_generation_params.return_value = {
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    settings.http_client.llm_timeout = llm_timeout
    return settings


def _mock_httpx_response(data: dict, status_code: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = data
    resp.text = json.dumps(data)
    return resp


def _vision_response(content: str = "I see a dashboard with metrics.") -> dict:
    return {
        "choices": [{
            "message": {"content": content}
        }]
    }


# ─── __init__ ────────────────────────────────────────────────────────────────


class TestInit:
    def test_stores_tools(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)
        assert svc._omni_tools is tools


# ─── capture_screenshot ──────────────────────────────────────────────────────


class TestCaptureScreenshot:
    async def test_happy_path(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        result = await svc.capture_screenshot(save_path="/tmp/screenshot.png")

        assert result["success"] is True
        assert "base64" in result

    async def test_failed_screenshot_raises(self):
        tools = _make_omni_tools(screenshot_result={
            "success": False,
            "error": "Display not available",
        })
        svc = OmniService(tools)

        with pytest.raises(OmniServiceError, match="Display not available"):
            await svc.capture_screenshot(save_path=None)

    async def test_failed_screenshot_default_error(self):
        tools = _make_omni_tools(screenshot_result={"success": False})
        svc = OmniService(tools)

        with pytest.raises(OmniServiceError, match="Screenshot capture failed"):
            await svc.capture_screenshot(save_path=None)


# ─── get_workflows ───────────────────────────────────────────────────────────


class TestGetWorkflows:
    def test_returns_workflows(self):
        tools = _make_omni_tools(workflows_result={"wf1": {}, "wf2": {}})
        svc = OmniService(tools)

        result = svc.get_workflows()
        assert len(result) == 2


# ─── _analyze_image_with_configured_vision_llm ───────────────────────────────


class TestAnalyzeImageWithVisionLlm:
    async def test_happy_path(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response(_vision_response("Dashboard with 3 charts"))
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock()), \
             patch("httpx.AsyncClient", return_value=mock_client):
            result = await svc._analyze_image_with_configured_vision_llm(
                prompt="Describe what you see",
                base64_png="iVBOR...",
            )

        assert result == "Dashboard with 3 charts"
        mock_client.post.assert_awaited_once()

    async def test_sends_auth_header_when_key_provided(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response(_vision_response())
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock(api_key="my-key")), \
             patch("httpx.AsyncClient", return_value=mock_client):
            await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")

        call_kwargs = mock_client.post.call_args.kwargs
        assert call_kwargs["headers"]["Authorization"] == "Bearer my-key"

    async def test_no_auth_header_when_not_needed(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response(_vision_response())
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock(api_key="not-needed")), \
             patch("httpx.AsyncClient", return_value=mock_client):
            await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")

        call_kwargs = mock_client.post.call_args.kwargs
        assert "Authorization" not in call_kwargs["headers"]

    async def test_empty_provider_url_raises(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock(provider_url="")):
            with pytest.raises(OmniServiceError, match="Vision provider URL not resolved"):
                await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")

    async def test_empty_model_raises(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock(model="")):
            with pytest.raises(OmniServiceError, match="Vision model not resolved"):
                await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")

    async def test_empty_base64_raises(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock()):
            with pytest.raises(OmniServiceError, match="No screenshot image data"):
                await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="")

    async def test_non_200_raises(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response({"error": "overloaded"}, status_code=503)
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock()), \
             patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(OmniServiceError, match="status=503"):
                await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")

    async def test_timeout_raises_omni_error(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock()), \
             patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(OmniServiceError, match="timed out"):
                await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")

    async def test_request_error_raises_omni_error(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            side_effect=httpx.RequestError("connection refused", request=MagicMock())
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock()), \
             patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(OmniServiceError, match="failed to connect"):
                await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")

    async def test_invalid_json_response_raises(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.side_effect = Exception("Invalid JSON")

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock()), \
             patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(OmniServiceError, match="invalid JSON"):
                await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")

    async def test_empty_content_raises(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response({"choices": [{"message": {"content": ""}}]})
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock()), \
             patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(OmniServiceError, match="empty content"):
                await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")

    async def test_no_choices_raises(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response({"choices": []})
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock()), \
             patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(OmniServiceError, match="empty content"):
                await svc._analyze_image_with_configured_vision_llm(prompt="test", base64_png="data")


# ─── analyze_screen ──────────────────────────────────────────────────────────


class TestAnalyzeScreen:
    async def test_happy_path(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        with patch.object(svc, "capture_screenshot", new_callable=AsyncMock) as mock_cap, \
             patch.object(svc, "_analyze_image_with_configured_vision_llm", new_callable=AsyncMock) as mock_analyze:
            mock_cap.return_value = {"success": True, "base64": "png_data"}
            mock_analyze.return_value = "I see a login page."

            result = await svc.analyze_screen("What is on screen?")

        assert result["success"] is True
        assert result["analysis"] == "I see a login page."
        assert result["screenshot_base64"] == "png_data"
        mock_cap.assert_awaited_once_with(save_path=None)
        mock_analyze.assert_awaited_once_with(prompt="What is on screen?", base64_png="png_data")


# ─── health ──────────────────────────────────────────────────────────────────


class TestHealth:
    async def test_happy_path(self):
        tools = _make_omni_tools(workflows_result={"wf1": {}, "wf2": {}, "wf3": {}})
        svc = OmniService(tools)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock(model="vision-v2")):
            result = await svc.health()

        assert result["healthy"] is True
        assert result["workflows"] == 3
        assert result["capabilities"]["screenshot"] is True
        assert result["capabilities"]["screen_analysis"] is True
        assert result["capabilities"]["vision_model"] == "vision-v2"
        assert result["capabilities"]["provider"] == "aether_inference"

    async def test_no_vision_model(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        with patch("application.omni.service.get_settings", return_value=_make_settings_mock(model="")):
            result = await svc.health()

        assert result["capabilities"]["screen_analysis"] is False


# ─── shutdown ────────────────────────────────────────────────────────────────


class TestShutdown:
    async def test_returns_none(self):
        tools = _make_omni_tools()
        svc = OmniService(tools)

        result = await svc.shutdown()
        assert result is None
