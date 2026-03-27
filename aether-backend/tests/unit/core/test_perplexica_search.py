"""
Unit Tests: Perplexica Search (core/integrations/providers/perplexica/search.py)

Covers PerplexicaClient, all convenience wrappers, legal search, model resolution.

Mock boundaries:
- config.settings.get_settings → mock settings (module-level import in search.py)
- httpx.AsyncClient → mock HTTP client for all async search calls
- httpx.get → mock sync HTTP for model resolution
"""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from core.integrations.providers.perplexica.search import (
    PerplexicaClient,
    perplexica_search,
    web_search,
    academic_search,
    reddit_search,
    wolfram_search,
    writing_assistant,
    quick_search,
    image_search,
    video_search,
    suggestions,
    discover_news,
    legal_search,
    get_legal_databases_for_jurisdiction,
    LEGAL_DATABASES,
    perplexica_models,
    show_current_model,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_settings(
    *,
    perplexica_url: str = "http://localhost:3000",
    searxng_url: str = "http://localhost:8888",
    inference_url: str = "http://127.0.0.1:7090/v1",
    model: str = "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
    summarizer_model: str = "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
    embedding_model: str = "Xenova/bge-small-en-v1.5",
    external_timeout: float = 600.0,
) -> MagicMock:
    settings = MagicMock()
    settings.integrations = MagicMock()
    settings.integrations.perplexica_url = perplexica_url
    settings.integrations.searxng_url = searxng_url
    settings.inference_url = inference_url
    settings.llm = MagicMock()
    settings.llm.model = model
    settings.llm.summarizer_model = summarizer_model
    settings.llm.embedding_model = embedding_model
    settings.http_client = MagicMock()
    settings.http_client.external_service_timeout = external_timeout
    settings.embedding_service = MagicMock()
    settings.embedding_service.model = embedding_model
    return settings


def _mock_httpx_response(
    *,
    status_code: int = 200,
    json_data: Dict[str, Any] | None = None,
) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    resp.raise_for_status = MagicMock()
    if status_code >= 400:
        resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Error", request=MagicMock(), response=resp
        )
    return resp


def _mock_async_client(response: MagicMock) -> MagicMock:
    """Create a mock httpx.AsyncClient context manager."""
    client = AsyncMock()
    client.post = AsyncMock(return_value=response)
    client.get = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


# ─── PerplexicaClient.__init__ ───────────────────────────────────────────────


class TestPerplexicaClientInit:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_default_url_from_settings(self, mock_gs):
        mock_gs.return_value = _make_settings(perplexica_url="http://perplexica:3000")
        client = PerplexicaClient()
        assert client.base_url == "http://perplexica:3000"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_custom_url_overrides(self, mock_gs):
        mock_gs.return_value = _make_settings()
        client = PerplexicaClient(base_url="http://custom:4000/")
        assert client.base_url == "http://custom:4000"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_timeout_from_settings(self, mock_gs):
        mock_gs.return_value = _make_settings(external_timeout=120.0)
        client = PerplexicaClient()
        assert client.timeout == 120.0


# ─── _resolve_inference_model_id ─────────────────────────────────────────────


class TestResolveInferenceModelId:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_exact_match(self, mock_gs):
        mock_gs.return_value = _make_settings()
        client = PerplexicaClient()

        with patch("httpx.get") as mock_get:
            mock_get.return_value = _mock_httpx_response(json_data={
                "data": [{"id": "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"}, {"id": "other-model"}]
            })
            result = client._resolve_inference_model_id("lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit")

        assert result == "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_token_match(self, mock_gs):
        mock_gs.return_value = _make_settings()
        client = PerplexicaClient()

        with patch("httpx.get") as mock_get:
            mock_get.return_value = _mock_httpx_response(json_data={
                "data": [
                    {"id": "lmstudio-community/LFM2.5-1.2B-Instruct-MLX-8bit"},
                ]
            })
            result = client._resolve_inference_model_id("liquid/lfm2.5-1.2b")

        # All tokens ["lfm2", "5", "1", "2b"] match in the server model ID
        assert result == "lmstudio-community/LFM2.5-1.2B-Instruct-MLX-8bit"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_type_fallback(self, mock_gs):
        """When no exact or token match, falls back to first model of matching type."""
        mock_gs.return_value = _make_settings()
        client = PerplexicaClient()

        # Use IDs with NO overlapping tokens with canonical name "zzz/xyzabc"
        # tokens: ["xyzabc"] — won't appear in "alpha-gamma-7b"
        with patch("httpx.get") as mock_get:
            mock_get.return_value = _mock_httpx_response(json_data={
                "data": [
                    {"id": "alpha-gamma-7b", "model_type": "text"},
                ]
            })
            result = client._resolve_inference_model_id("zzz/xyzabc", model_type="text")

        assert result == "alpha-gamma-7b"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_any_model_fallback(self, mock_gs):
        """When no exact, token, or type match, falls back to first model."""
        mock_gs.return_value = _make_settings()
        client = PerplexicaClient()

        # canonical tokens ["xyzabc"] won't match "alpha-gamma-7b"
        # model_type is "vision" but we request "text" — type mismatch forces any-model fallback
        with patch("httpx.get") as mock_get:
            mock_get.return_value = _mock_httpx_response(json_data={
                "data": [
                    {"id": "alpha-gamma-7b", "model_type": "vision"},
                ]
            })
            result = client._resolve_inference_model_id("zzz/xyzabc", model_type="text")

        assert result == "alpha-gamma-7b"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_empty_models_returns_canonical(self, mock_gs):
        mock_gs.return_value = _make_settings()
        client = PerplexicaClient()

        with patch("httpx.get") as mock_get:
            mock_get.return_value = _mock_httpx_response(json_data={"data": []})
            result = client._resolve_inference_model_id("lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit")

        assert result == "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_http_error_returns_canonical(self, mock_gs):
        mock_gs.return_value = _make_settings()
        client = PerplexicaClient()

        with patch("httpx.get") as mock_get:
            mock_get.return_value = _mock_httpx_response(status_code=500, json_data={})
            # Override raise_for_status to not raise (the code checks status_code directly)
            mock_get.return_value.raise_for_status = MagicMock()
            result = client._resolve_inference_model_id("lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit")

        assert result == "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_connection_error_returns_canonical(self, mock_gs):
        mock_gs.return_value = _make_settings()
        client = PerplexicaClient()

        with patch("httpx.get", side_effect=httpx.ConnectError("refused")):
            result = client._resolve_inference_model_id("lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit")

        assert result == "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"


# ─── _get_model_config ───────────────────────────────────────────────────────


class TestGetModelConfig:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_returns_chat_and_embedding(self, mock_gs):
        mock_gs.return_value = _make_settings(model="lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit")
        client = PerplexicaClient()

        with patch.object(client, "_resolve_inference_model_id", return_value="resolved-model"):
            chat, embedding = client._get_model_config()

        assert chat["providerId"] == "aether-inference-default"
        assert chat["key"] == "resolved-model"
        assert embedding["providerId"] == "transformers-default"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_strips_openai_prefix(self, mock_gs):
        settings = _make_settings()
        settings.llm.summarizer_model = "openai/qwen3-4b"
        mock_gs.return_value = settings
        client = PerplexicaClient()

        with patch.object(client, "_resolve_inference_model_id", return_value="qwen3-4b") as mock_resolve:
            chat, _ = client._get_model_config()
            # Should have stripped "openai/" prefix before resolving
            mock_resolve.assert_called_once_with("qwen3-4b", model_type="text")


# ─── search ──────────────────────────────────────────────────────────────────


class TestSearch:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_happy_path(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={
            "message": "Search results here",
            "sources": [{"title": "Source 1", "url": "http://example.com"}],
        })
        mock_client = _mock_async_client(response)

        client = PerplexicaClient()
        with patch.object(client, "_get_model_config", return_value=(
            {"providerId": "test", "key": "model"},
            {"providerId": "embed", "key": "emb"},
        )), patch("httpx.AsyncClient", return_value=mock_client):
            result = await client.search("test query")

        assert result["query"] == "test query"
        assert result["answer"] == "Search results here"
        assert result["source_count"] == 1
        assert result["sources"] == [{"title": "Source 1", "url": "http://example.com"}]
        assert result["focus_mode"] == "webSearch"
        # timestamp is datetime.now().isoformat() — verify it's a non-empty ISO string
        assert isinstance(result["timestamp"], str) and "T" in result["timestamp"]
        # model_used is "{providerId}/{key}" from mock config
        assert result["model_used"] == "test/model"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_focus_mode_mapping(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"message": "", "sources": []})
        mock_client = _mock_async_client(response)

        client = PerplexicaClient()
        with patch.object(client, "_get_model_config", return_value=(
            {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"},
        )), patch("httpx.AsyncClient", return_value=mock_client):
            result = await client.search("test", focus="academicSearch")

        assert result["focus_mode"] == "academicSearch"
        # Verify payload has correct source
        call_kwargs = mock_client.post.call_args
        payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        assert payload["sources"] == ["academic"]

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_mode_quality_passes_through(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"message": "", "sources": []})
        mock_client = _mock_async_client(response)

        client = PerplexicaClient()
        with patch.object(client, "_get_model_config", return_value=(
            {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"},
        )), patch("httpx.AsyncClient", return_value=mock_client):
            await client.search("test", mode="quality")

        payload = mock_client.post.call_args.kwargs.get("json")
        assert payload["optimizationMode"] == "quality"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_invalid_mode_defaults_to_balanced(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"message": "", "sources": []})
        mock_client = _mock_async_client(response)

        client = PerplexicaClient()
        with patch.object(client, "_get_model_config", return_value=(
            {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"},
        )), patch("httpx.AsyncClient", return_value=mock_client):
            await client.search("test", mode="invalid_mode")

        payload = mock_client.post.call_args.kwargs.get("json")
        assert payload["optimizationMode"] == "balanced"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_custom_system_instructions(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"message": "", "sources": []})
        mock_client = _mock_async_client(response)

        client = PerplexicaClient()
        with patch.object(client, "_get_model_config", return_value=(
            {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"},
        )), patch("httpx.AsyncClient", return_value=mock_client):
            await client.search("test", system_instructions="Custom instructions")

        payload = mock_client.post.call_args.kwargs.get("json")
        assert payload["systemInstructions"] == "Custom instructions"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_engines_kwarg(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"message": "", "sources": []})
        mock_client = _mock_async_client(response)

        client = PerplexicaClient()
        with patch.object(client, "_get_model_config", return_value=(
            {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"},
        )), patch("httpx.AsyncClient", return_value=mock_client):
            await client.search("test", engines=["google", "brave"])

        payload = mock_client.post.call_args.kwargs.get("json")
        assert payload["engines"] == ["google", "brave"]

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_http_error_returns_error(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(status_code=500)
        mock_client = _mock_async_client(response)

        client = PerplexicaClient()
        with patch.object(client, "_get_model_config", return_value=(
            {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"},
        )), patch("httpx.AsyncClient", return_value=mock_client):
            result = await client.search("test")

        assert isinstance(result["error"], str) and len(result["error"]) > 0
        assert result["query"] == "test"
        # Only error + query keys in error response (source returns exactly these two)
        assert set(result.keys()) == {"error", "query"}

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_connection_error(self, mock_gs):
        mock_gs.return_value = _make_settings()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.ConnectError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        client = PerplexicaClient()
        with patch.object(client, "_get_model_config", return_value=(
            {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"},
        )), patch("httpx.AsyncClient", return_value=mock_client):
            result = await client.search("test")

        assert "refused" in result["error"]
        assert result["query"] == "test"
        assert set(result.keys()) == {"error", "query"}


# ─── Convenience wrappers ────────────────────────────────────────────────────


class TestConvenienceWrappers:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_perplexica_search(self, mock_gs):
        mock_gs.return_value = _make_settings()
        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockClient:
            mock_instance = MagicMock()
            mock_instance.search = AsyncMock(return_value={"answer": "result"})
            MockClient.return_value = mock_instance

            result = await perplexica_search("test query", focus="webSearch")
            assert result["answer"] == "result"
            mock_instance.search.assert_awaited_once()

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_web_search(self, mock_gs):
        mock_gs.return_value = _make_settings()
        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockClient:
            mock_instance = MagicMock()
            mock_instance.search = AsyncMock(return_value={"answer": "web result"})
            MockClient.return_value = mock_instance

            result = await web_search("test")
            assert result["answer"] == "web result"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_academic_search(self, mock_gs):
        mock_gs.return_value = _make_settings()
        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockClient:
            mock_instance = MagicMock()
            mock_instance.search = AsyncMock(return_value={"answer": "academic"})
            MockClient.return_value = mock_instance

            result = await academic_search("test")
            assert result["answer"] == "academic"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_reddit_search(self, mock_gs):
        mock_gs.return_value = _make_settings()
        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockClient:
            mock_instance = MagicMock()
            mock_instance.search = AsyncMock(return_value={"answer": "reddit"})
            MockClient.return_value = mock_instance

            result = await reddit_search("test")
            assert result["answer"] == "reddit"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_wolfram_search(self, mock_gs):
        mock_gs.return_value = _make_settings()
        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockClient:
            mock_instance = MagicMock()
            mock_instance.search = AsyncMock(return_value={"answer": "wolfram"})
            MockClient.return_value = mock_instance

            result = await wolfram_search("test")
            assert result["answer"] == "wolfram"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_writing_assistant(self, mock_gs):
        mock_gs.return_value = _make_settings()
        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockClient:
            mock_instance = MagicMock()
            mock_instance.search = AsyncMock(return_value={"answer": "writing"})
            MockClient.return_value = mock_instance

            result = await writing_assistant("help me write")
            assert result["answer"] == "writing"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_quick_search_returns_answer(self, mock_gs):
        mock_gs.return_value = _make_settings()
        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockClient:
            mock_instance = MagicMock()
            mock_instance.search = AsyncMock(return_value={"answer": "quick answer"})
            MockClient.return_value = mock_instance

            result = await quick_search("fast query")
            assert result == "quick answer"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_quick_search_error_fallback(self, mock_gs):
        mock_gs.return_value = _make_settings()
        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockClient:
            mock_instance = MagicMock()
            mock_instance.search = AsyncMock(return_value={"error": "failed"})
            MockClient.return_value = mock_instance

            result = await quick_search("query")
            assert result == "failed"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_quick_search_no_answer_or_error(self, mock_gs):
        mock_gs.return_value = _make_settings()
        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockClient:
            mock_instance = MagicMock()
            mock_instance.search = AsyncMock(return_value={})
            MockClient.return_value = mock_instance

            result = await quick_search("query")
            assert result == "No answer available"


# ─── image_search ────────────────────────────────────────────────────────────


class TestImageSearch:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_happy_path(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={
            "images": [{"url": "http://img1.jpg"}, {"url": "http://img2.jpg"}]
        })
        mock_client = _mock_async_client(response)

        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockPC:
            mock_pc = MagicMock()
            mock_pc._get_model_config.return_value = (
                {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"}
            )
            MockPC.return_value = mock_pc

            with patch("httpx.AsyncClient", return_value=mock_client):
                result = await image_search("cats")

        assert result["count"] == 2
        assert len(result["images"]) == 2
        assert result["images"] == [{"url": "http://img1.jpg"}, {"url": "http://img2.jpg"}]
        assert result["query"] == "cats"
        assert isinstance(result["timestamp"], str) and "T" in result["timestamp"]
        assert result["model_used"] == "t/m"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_error_returns_empty(self, mock_gs):
        mock_gs.return_value = _make_settings()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.ConnectError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockPC:
            mock_pc = MagicMock()
            mock_pc._get_model_config.return_value = (
                {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"}
            )
            MockPC.return_value = mock_pc

            with patch("httpx.AsyncClient", return_value=mock_client):
                result = await image_search("cats")

        assert "refused" in result["error"]
        assert result["images"] == []
        assert result["query"] == "cats"


# ─── video_search ────────────────────────────────────────────────────────────


class TestVideoSearch:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_happy_path(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={
            "videos": [{"url": "http://vid1.mp4"}]
        })
        mock_client = _mock_async_client(response)

        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockPC:
            mock_pc = MagicMock()
            mock_pc._get_model_config.return_value = (
                {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"}
            )
            MockPC.return_value = mock_pc

            with patch("httpx.AsyncClient", return_value=mock_client):
                result = await video_search("tutorials")

        assert result["count"] == 1
        assert result["videos"] == [{"url": "http://vid1.mp4"}]
        assert result["query"] == "tutorials"
        assert isinstance(result["timestamp"], str) and "T" in result["timestamp"]
        assert result["model_used"] == "t/m"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_error_returns_empty(self, mock_gs):
        mock_gs.return_value = _make_settings()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=RuntimeError("error"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockPC:
            mock_pc = MagicMock()
            mock_pc._get_model_config.return_value = (
                {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"}
            )
            MockPC.return_value = mock_pc

            with patch("httpx.AsyncClient", return_value=mock_client):
                result = await video_search("tutorials")

        assert result["error"] == "error"
        assert result["videos"] == []
        assert result["query"] == "tutorials"


# ─── suggestions ─────────────────────────────────────────────────────────────


class TestSuggestions:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_happy_path(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={
            "suggestions": ["Follow up 1", "Follow up 2"]
        })
        mock_client = _mock_async_client(response)

        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockPC:
            mock_pc = MagicMock()
            mock_pc._get_model_config.return_value = (
                {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"}
            )
            MockPC.return_value = mock_pc

            with patch("httpx.AsyncClient", return_value=mock_client):
                result = await suggestions([{"role": "user", "content": "hello"}])

        assert result["count"] == 2
        assert result["suggestions"] == ["Follow up 1", "Follow up 2"]
        assert isinstance(result["timestamp"], str) and "T" in result["timestamp"]
        assert result["model_used"] == "t/m"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_error_returns_empty(self, mock_gs):
        mock_gs.return_value = _make_settings()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=RuntimeError("error"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("core.integrations.providers.perplexica.search.PerplexicaClient") as MockPC:
            mock_pc = MagicMock()
            mock_pc._get_model_config.return_value = (
                {"providerId": "t", "key": "m"}, {"providerId": "e", "key": "k"}
            )
            MockPC.return_value = mock_pc

            with patch("httpx.AsyncClient", return_value=mock_client):
                result = await suggestions([])

        assert result["suggestions"] == []


# ─── discover_news ───────────────────────────────────────────────────────────


class TestDiscoverNews:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_happy_path(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={
            "blogs": [{"title": "Article 1"}, {"title": "Article 2"}]
        })
        mock_client = _mock_async_client(response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await discover_news("tech")

        assert result["count"] == 2
        assert result["topic"] == "tech"
        assert result["mode"] == "normal"
        assert result["articles"] == [{"title": "Article 1"}, {"title": "Article 2"}]
        assert isinstance(result["timestamp"], str) and "T" in result["timestamp"]

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_invalid_topic_defaults_to_tech(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"blogs": []})
        mock_client = _mock_async_client(response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await discover_news("invalid_topic")

        assert result["topic"] == "tech"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_invalid_mode_defaults_to_normal(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"blogs": []})
        mock_client = _mock_async_client(response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await discover_news("tech", mode="invalid")

        assert result["mode"] == "normal"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_error_returns_empty(self, mock_gs):
        mock_gs.return_value = _make_settings()

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=RuntimeError("network"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await discover_news()

        assert result["error"] == "network"
        assert result["articles"] == []


# ─── get_legal_databases_for_jurisdiction ────────────────────────────────────


class TestGetLegalDatabases:
    """Tests for get_legal_databases_for_jurisdiction — pure logic."""

    def test_uk_jurisdiction(self):
        dbs = get_legal_databases_for_jurisdiction("uk")
        assert len(dbs) == 1  # bailii only
        assert dbs[0]["name"] == "BAILII (UK)"
        assert dbs[0]["region"] == "uk"
        assert dbs[0]["key"] == "bailii"

    def test_us_jurisdiction(self):
        dbs = get_legal_databases_for_jurisdiction("us")
        assert len(dbs) == 2  # courtlistener + justia
        names = sorted([db["name"] for db in dbs])
        assert names == ["CourtListener (US)", "Justia (US)"]

    def test_all_jurisdiction(self):
        dbs = get_legal_databases_for_jurisdiction("all")
        # uk(1) + us(2) + commonwealth(4) + eu(1) + international(2) = 10
        assert len(dbs) == 10

    def test_unknown_jurisdiction(self):
        dbs = get_legal_databases_for_jurisdiction("unknown_country")
        assert dbs == []

    def test_case_insensitive(self):
        dbs = get_legal_databases_for_jurisdiction("UK")
        assert len(dbs) == 1
        assert dbs[0]["name"] == "BAILII (UK)"

    def test_eu_jurisdiction(self):
        dbs = get_legal_databases_for_jurisdiction("eu")
        assert len(dbs) == 1
        assert dbs[0]["name"] == "EUR-Lex"
        assert dbs[0]["key"] == "eur_lex"

    def test_international_jurisdiction(self):
        dbs = get_legal_databases_for_jurisdiction("international")
        assert len(dbs) == 2  # icj + worldlii
        names = sorted([db["name"] for db in dbs])
        assert names == ["ICJ", "WorldLII"]


# ─── legal_search ────────────────────────────────────────────────────────────


class TestLegalSearch:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_no_databases_found(self, mock_gs):
        mock_gs.return_value = _make_settings()
        result = await legal_search("test case", jurisdiction="nonexistent")
        assert "error" in result
        assert "No databases found" in result["error"]

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_happy_path_uk(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={
            "results": [
                {"url": "http://bailii.org/case/123", "title": "Test Case"}
            ]
        })
        mock_client = _mock_async_client(response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await legal_search("R v Smith", jurisdiction="uk")

        assert result["count"] == 1
        assert result["jurisdiction"] == "uk"
        assert result["databases_searched"] == ["BAILII (UK)"]
        assert result["query"] == "R v Smith"
        assert result["document_type"] == "cases"
        assert isinstance(result["timestamp"], str) and "T" in result["timestamp"]
        # Verify enriched result has database metadata
        assert result["results"][0]["database"] == "BAILII (UK)"
        assert result["results"][0]["jurisdiction"] == "uk"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_document_type_legislation(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"results": []})
        mock_client = _mock_async_client(response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await legal_search("Data Protection", jurisdiction="uk", document_type="legislation")

        assert result["document_type"] == "legislation"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_document_type_regulations(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"results": []})
        mock_client = _mock_async_client(response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await legal_search("test", jurisdiction="uk", document_type="regulations")

        assert result["document_type"] == "regulations"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_document_type_treaties(self, mock_gs):
        mock_gs.return_value = _make_settings()

        response = _mock_httpx_response(json_data={"results": []})
        mock_client = _mock_async_client(response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await legal_search("test", jurisdiction="eu", document_type="treaties")

        assert result["document_type"] == "treaties"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_no_searxng_url(self, mock_gs):
        settings = _make_settings()
        settings.integrations.searxng_url = ""
        mock_gs.return_value = settings

        result = await legal_search("test", jurisdiction="uk")
        assert "error" in result
        assert "SearXNG not configured" in result["error"]

    @patch("core.integrations.providers.perplexica.search.get_settings")
    async def test_searxng_error(self, mock_gs):
        mock_gs.return_value = _make_settings()

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=RuntimeError("network error"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await legal_search("test", jurisdiction="uk")

        assert result["error"] == "network error"
        assert result["query"] == "test"
        assert result["jurisdiction"] == "uk"
        assert result["results"] == []


# ─── perplexica_models / show_current_model ──────────────────────────────────


class TestModelsInfo:

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_perplexica_models(self, mock_gs):
        mock_gs.return_value = _make_settings(
            model="lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
            embedding_model="Xenova/bge-small-en-v1.5",
            perplexica_url="http://perplexica:3000",
        )
        result = perplexica_models()
        assert result["chat_model"] == "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"
        assert result["perplexica_url"] == "http://perplexica:3000"

    @patch("core.integrations.providers.perplexica.search.get_settings")
    def test_show_current_model(self, mock_gs):
        mock_gs.return_value = _make_settings(
            model="lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
            embedding_model="Xenova/bge-small-en-v1.5",
        )
        result = show_current_model()
        assert "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit" in result
        assert "Xenova/bge-small-en-v1.5" in result


# ─── LEGAL_DATABASES constant ────────────────────────────────────────────────


class TestLegalDatabasesConstant:

    def test_structure(self):
        assert "uk" in LEGAL_DATABASES
        assert "us" in LEGAL_DATABASES
        assert "eu" in LEGAL_DATABASES
        assert "international" in LEGAL_DATABASES
        assert "commonwealth" in LEGAL_DATABASES

    def test_uk_has_bailii(self):
        assert "bailii" in LEGAL_DATABASES["uk"]
        assert "BAILII" in LEGAL_DATABASES["uk"]["bailii"]["name"]

    def test_us_has_courtlistener(self):
        assert "courtlistener" in LEGAL_DATABASES["us"]
