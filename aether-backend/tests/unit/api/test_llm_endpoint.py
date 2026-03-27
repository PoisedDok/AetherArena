"""
LLM Proxy Endpoint Tests

Covers all 5 routes:
  POST /v1/llm/chat/completions  — proxy to LLM provider (mocked httpx)
  POST /v1/llm/embeddings        — proxy to embedding service (mocked httpx)
  GET  /v1/llm/config            — get LLM configuration
  GET  /v1/llm/models            — list models from provider (mocked httpx)
  GET  /v1/llm/health            — LLM + embedding health check (mocked httpx)

Quality: mock all external calls, test error paths, validation, streaming.
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import httpx as real_httpx


def _mock_httpx_client(response_data, status_code=200):
    """Helper: create a mocked httpx.AsyncClient context manager."""
    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    mock_resp.json = lambda: response_data
    mock_resp.text = json.dumps(response_data) if response_data else ""
    mock_resp.headers = {"content-type": "application/json"}
    
    def _raise_for_status():
        if status_code >= 400:
            import httpx
            # raise an httpx.HTTPStatusError as AetherHTTPClient catches that specifically
            req = httpx.Request("GET", "http://test")
            raise httpx.HTTPStatusError("error", request=req, response=mock_resp)
            
    mock_resp.raise_for_status = _raise_for_status

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.get = AsyncMock(return_value=mock_resp)
    mock_client.request = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


VALID_COMPLETION_RESPONSE = {
    "id": "chatcmpl-test123",
    "object": "chat.completion",
    "created": 1700000000,
    "model": "qwen3-4b",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "Hello!"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
}

VALID_EMBEDDING_RESPONSE = {
    "object": "list",
    "data": [
        {"object": "embedding", "embedding": [0.1, 0.2, 0.3], "index": 0}
    ],
    "model": "text-embedding-3-small",
    "usage": {"prompt_tokens": 4, "total_tokens": 4},
}

VALID_MODELS_RESPONSE = {
    "object": "list",
    "data": [
        {"id": "qwen3-4b", "object": "model", "created": 0, "owned_by": "local"},
        {"id": "qwen3-8b", "object": "model", "created": 0, "owned_by": "local"},
    ],
}


# =========================================================================
# GET /v1/llm/config
# =========================================================================


class TestLLMConfig:
    """Tests for LLM configuration endpoint (no external calls)."""

    @pytest.mark.asyncio
    async def test_get_config(self, client):
        """Returns LLM config with provider, model, and is_local flag."""
        resp = await client.get("/v1/llm/config")
        assert resp.status_code == 200
        body = resp.json()
        assert "provider" in body
        assert "model" in body
        assert "is_local" in body
        assert isinstance(body["is_local"], bool)

    @pytest.mark.asyncio
    async def test_config_includes_summarizer(self, client):
        """Config includes summarizer and embedding model."""
        resp = await client.get("/v1/llm/config")
        body = resp.json()
        assert "summarizer_model" in body
        assert "embedding_model" in body


# =========================================================================
# POST /v1/llm/chat/completions
# =========================================================================


class TestChatCompletions:
    """Tests for the chat completions proxy endpoint."""

    @pytest.mark.asyncio
    async def test_valid_completion(self, client):
        """Valid request returns completion response."""
        mock_client = _mock_httpx_client(VALID_COMPLETION_RESPONSE)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{"role": "user", "content": "Hello"}],
                })

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == "chatcmpl-test123"
        assert body["choices"][0]["message"]["content"] == "Hello!"

    @pytest.mark.asyncio
    async def test_missing_messages_returns_422(self, client):
        """Missing messages field returns 422."""
        resp = await client.post("/v1/llm/chat/completions", json={
            "model": "qwen3-4b",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_missing_model_returns_422(self, client):
        """Missing model field returns 422."""
        resp = await client.post("/v1/llm/chat/completions", json={
            "messages": [{"role": "user", "content": "Hello"}],
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_provider_error_forwarded(self, client):
        """Provider non-200 error is forwarded as-is."""
        mock_client = _mock_httpx_client(
            {"error": {"message": "Model not found"}},
            status_code=404,
        )

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "nonexistent-model",
                    "messages": [{"role": "user", "content": "test"}],
                })

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_provider_timeout_returns_504(self, client):
        """Provider timeout returns 504."""
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=real_httpx.TimeoutException("timeout"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{"role": "user", "content": "test"}],
                })

        assert resp.status_code == 504

    @pytest.mark.asyncio
    async def test_provider_connection_error_returns_503(self, client):
        """Provider connection error returns 503."""
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(
            side_effect=real_httpx.ConnectError("connection refused")
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{"role": "user", "content": "test"}],
                })

        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_provider_empty_response_returns_502(self, client):
        """Empty LLM response returns 502 Bad Gateway."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = ""
        mock_resp.headers = {"content-type": "application/json"}

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{"role": "user", "content": "test"}],
                })

        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_multimodal_message_accepted(self, client):
        """Multimodal message with image_url is accepted."""
        mock_client = _mock_httpx_client(VALID_COMPLETION_RESPONSE)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "What is this?"},
                            {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
                        ],
                    }],
                })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_max_completion_tokens_consolidation(self, client):
        """max_completion_tokens is consolidated to max_tokens."""
        mock_client = _mock_httpx_client(VALID_COMPLETION_RESPONSE)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{"role": "user", "content": "test"}],
                    "max_completion_tokens": 256,
                })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_text_content_part_empty_text_returns_422(self, client):
        """ContentPart type='text' with empty text raises validation error."""
        resp = await client.post("/v1/llm/chat/completions", json={
            "model": "qwen3-4b",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": ""},
                ],
            }],
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_image_url_content_part_missing_url_returns_422(self, client):
        """ContentPart type='image_url' without image_url raises validation error."""
        resp = await client.post("/v1/llm/chat/completions", json={
            "model": "qwen3-4b",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url"},
                ],
            }],
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_streaming_completion(self, client):
        """stream=true returns StreamingResponse with SSE."""

        async def mock_aiter_lines():
            yield "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}"
            yield "data: [DONE]"

        mock_stream_resp = MagicMock()
        mock_stream_resp.status_code = 200
        mock_stream_resp.aiter_lines = mock_aiter_lines
        mock_stream_resp.aread = AsyncMock(return_value=b"")

        mock_inner_client = AsyncMock()
        mock_inner_client.stream = MagicMock(return_value=MagicMock(
            __aenter__=AsyncMock(return_value=mock_stream_resp),
            __aexit__=AsyncMock(return_value=False),
        ))
        mock_inner_client.__aenter__ = AsyncMock(return_value=mock_inner_client)
        mock_inner_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_inner_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{"role": "user", "content": "test"}],
                    "stream": True,
                })

        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_streaming_provider_error(self, client):
        """stream=true with provider error yields error SSE event."""

        import httpx
        mock_stream_resp = MagicMock()
        mock_stream_resp.status_code = 500
        mock_stream_resp.aread = AsyncMock(return_value=b"Internal Server Error")
        
        def _raise_for_status():
            req = httpx.Request("POST", "http://test")
            raise httpx.HTTPStatusError("error", request=req, response=mock_stream_resp)
            
        mock_stream_resp.raise_for_status = _raise_for_status

        mock_inner_client = AsyncMock()
        mock_inner_client.stream = MagicMock(return_value=MagicMock(
            __aenter__=AsyncMock(return_value=mock_stream_resp),
            __aexit__=AsyncMock(return_value=False),
        ))
        mock_inner_client.__aenter__ = AsyncMock(return_value=mock_inner_client)
        mock_inner_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_inner_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{"role": "user", "content": "test"}],
                    "stream": True,
                })

        assert resp.status_code == 200
        # Response body should contain error data
        text = resp.text
        assert "error" in text


# =========================================================================
# POST /v1/llm/embeddings
# =========================================================================


class TestEmbeddings:
    """Tests for the embeddings proxy endpoint."""

    @pytest.mark.asyncio
    async def test_valid_embedding(self, client):
        """Valid embedding request returns embedding data."""
        mock_client = _mock_httpx_client(VALID_EMBEDDING_RESPONSE)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.post("/v1/llm/embeddings", json={
                "input": "Hello, world!",
            })

        assert resp.status_code == 200
        body = resp.json()
        assert body["object"] == "list"
        assert len(body["data"]) == 1
        assert body["data"][0]["object"] == "embedding"
        assert len(body["data"][0]["embedding"]) == 3

    @pytest.mark.asyncio
    async def test_embedding_list_input(self, client):
        """List of texts is accepted."""
        mock_client = _mock_httpx_client(VALID_EMBEDDING_RESPONSE)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.post("/v1/llm/embeddings", json={
                "input": ["Hello", "World"],
            })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_embedding_timeout_returns_504(self, client):
        """Embedding service timeout returns 504."""
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=real_httpx.TimeoutException("timeout"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.post("/v1/llm/embeddings", json={
                "input": "test",
            })

        assert resp.status_code == 504

    @pytest.mark.asyncio
    async def test_embedding_missing_input_returns_422(self, client):
        """Missing input field returns 422."""
        resp = await client.post("/v1/llm/embeddings", json={})
        assert resp.status_code == 422


# =========================================================================
# GET /v1/llm/models
# =========================================================================


class TestListModels:
    """Tests for model listing endpoint."""

    @pytest.mark.asyncio
    async def test_list_models_from_provider(self, client):
        """Returns models from the provider."""
        mock_client = _mock_httpx_client(VALID_MODELS_RESPONSE)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/llm/models")

        assert resp.status_code == 200
        body = resp.json()
        assert body["object"] == "list"
        assert len(body["data"]) == 2

    @pytest.mark.asyncio
    async def test_list_models_provider_unavailable(self, client):
        """Falls back to configured models when provider unreachable."""
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=Exception("connection refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/llm/models")

        assert resp.status_code == 200
        body = resp.json()
        # Fallback should still return model list
        assert body["object"] == "list"
        assert len(body["data"]) >= 1


# =========================================================================
# GET /v1/llm/health
# =========================================================================


class TestLLMHealth:
    """Tests for LLM provider health check."""

    @pytest.mark.asyncio
    async def test_health_both_healthy(self, client):
        """Both LLM and embedding healthy returns healthy."""
        mock_llm_resp = MagicMock()
        mock_llm_resp.status_code = 200

        mock_embed_resp = MagicMock()
        mock_embed_resp.status_code = 200
        mock_embed_resp.json = lambda: {"status": "healthy", "default_model": "bge-small"}

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=[mock_llm_resp, mock_embed_resp])
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/llm/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "healthy"
        assert body["services"]["llm_provider"]["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_health_provider_down(self, client):
        """LLM provider unreachable returns degraded."""
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=Exception("connection refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/llm/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "degraded"


# =========================================================================
# Deep Coverage: chat completion branches
# =========================================================================


class TestChatCompletionsDeep:
    """Cover aether_inference routing, default model, JSON parse error, generic exception."""

    @pytest.mark.asyncio
    async def test_aether_inference_provider_routing(self, client, app):
        """Provider 'aether_inference' routes to settings.inference_url."""
        from api.dependencies import get_runtime_settings
        mock_settings = MagicMock()
        mock_settings.llm.api_base = "http://ignored"
        mock_settings.llm.api_key = "old-key"
        mock_settings.llm.provider = "aether_inference"
        mock_settings.llm.model = "qwen3-4b"
        mock_settings.inference_url = "http://localhost:7090/v1"
        mock_settings.http_client.llm_timeout = 60
        app.dependency_overrides[get_runtime_settings] = lambda: mock_settings

        mock_client = _mock_httpx_client(VALID_COMPLETION_RESPONSE)
        try:
            with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
                with patch("data.network.http_client.httpx.Limits"):
                    resp = await client.post("/v1/llm/chat/completions", json={
                        "model": "qwen3-4b",
                        "messages": [{"role": "user", "content": "hi"}],
                    })
            assert resp.status_code == 200
            # Verify it called the inference_url, not api_base
            call_args = mock_client.request.call_args
            assert "localhost:7090" in str(call_args)
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)

    @pytest.mark.asyncio
    async def test_default_model_substitution(self, client):
        """model='default' substituted with settings.llm.model."""
        mock_client = _mock_httpx_client(VALID_COMPLETION_RESPONSE)
        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "default",
                    "messages": [{"role": "user", "content": "test"}],
                })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_invalid_json_response_502(self, client):
        """LLM returns non-JSON → 502."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "not valid json {{"
        mock_resp.headers = {"content-type": "text/plain"}
        mock_resp.json = MagicMock(side_effect=ValueError("bad JSON"))

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{"role": "user", "content": "test"}],
                })
        assert resp.status_code == 502
        assert "invalid JSON" in resp.json()["error"]["message"]

    @pytest.mark.asyncio
    async def test_generic_exception_500(self, client):
        """Unexpected exception → 500."""
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=TypeError("unexpected"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            with patch("data.network.http_client.httpx.Limits"):
                resp = await client.post("/v1/llm/chat/completions", json={
                    "model": "qwen3-4b",
                    "messages": [{"role": "user", "content": "test"}],
                })
        assert resp.status_code == 500


# =========================================================================
# Deep Coverage: embeddings error paths
# =========================================================================


class TestEmbeddingsDeep:
    """Cover embeddings error paths: non-200, connection error, generic."""

    @pytest.mark.asyncio
    async def test_embedding_provider_error(self, client):
        """Embedding service returns non-200 → correctly forwards the status code."""
        mock_client = _mock_httpx_client(
            {"error": "model not found"}, status_code=400
        )
        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.post("/v1/llm/embeddings", json={
                "input": "test text",
            })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_embedding_connection_error_503(self, client):
        """Connection error → 503."""
        import httpx as real_httpx
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(
            side_effect=real_httpx.ConnectError("connection refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.post("/v1/llm/embeddings", json={
                "input": "test text",
            })
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_embedding_generic_exception_500(self, client):
        """Generic exception → 500."""
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=TypeError("unexpected"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.post("/v1/llm/embeddings", json={
                "input": "test text",
            })
        assert resp.status_code == 500


# =========================================================================
# Deep Coverage: list_models non-200 fallback
# =========================================================================


class TestListModelsDeep:
    """Cover provider non-200 fallback."""

    @pytest.mark.asyncio
    async def test_list_models_non_200_fallback(self, client):
        """Provider returns non-200 → fallback to configured models."""
        mock_client = _mock_httpx_client({}, status_code=500)
        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            resp = await client.get("/v1/llm/models")
        assert resp.status_code == 200
        body = resp.json()
        assert body["object"] == "list"
        assert len(body["data"]) >= 1
