"""
Chat Endpoint Tests

Covers:
  POST /v1/create/chat       — send message, collect streamed chunks, return JSON
  POST /v1/create/chat/stream — SSE streaming (verify response type + headers)
  POST /v1/stop-generation    — stop by request_id, session_id, or 400 on missing
  GET  /v1/chat/history/{sid} — retrieve in-memory history, validate session_id

Quality: assert response bodies (not just status codes), test all branches,
         validate Pydantic rejection paths, edge cases.
"""

import pytest
import base64
from unittest.mock import AsyncMock


# =========================================================================
# POST /v1/create/chat
# =========================================================================


class TestSendChatMessage:
    """Tests for the synchronous chat message endpoint."""

    @pytest.mark.asyncio
    async def test_valid_message_returns_response(self, client):
        """Valid message returns 200 with collected response text."""
        resp = await client.post("/v1/create/chat", json={
            "message": "Hello, world!",
            "session_id": "test-session-1",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        # mock_runtime_engine yields {"type":"text","content":"Test "} + {"type":"text","content":"response"}
        assert body["response"] == "Test response"
        assert body["session_id"] == "test-session-1"
        assert "request_id" in body
        assert "chunks_count" in body
        assert body["chunks_count"] == 3  # text + text + done

    @pytest.mark.asyncio
    async def test_default_session_id(self, client):
        """Omitting session_id uses 'default' when no header present."""
        resp = await client.post("/v1/create/chat", json={
            "message": "test",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == "default"

    @pytest.mark.asyncio
    async def test_session_id_falls_back_to_header(self, app, client):
        """Omitting session_id in body falls back to X-Session-Id header.

        Regression: Bug #8 — session_id had Pydantic default 'default' (always truthy),
        making the header fallback dead code.  Now session_id defaults to None so the
        'session_id or header_session or "default"' chain evaluates correctly.
        """
        from api.dependencies import setup_request_context

        app.dependency_overrides[setup_request_context] = lambda: {
            "request_id": "ctx-rid",
            "session_id": "header-session-42",
            "correlation_id": None,
            "frontend_id": None,
            "operator_id": None,
            "user_id": None,
            "chat_id": None,
        }
        try:
            resp = await client.post("/v1/create/chat", json={
                "message": "test",
            })
        finally:
            app.dependency_overrides.pop(setup_request_context, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == "header-session-42"

    @pytest.mark.asyncio
    async def test_body_session_id_overrides_header(self, app, client):
        """Body session_id takes priority over X-Session-Id header."""
        from api.dependencies import setup_request_context

        app.dependency_overrides[setup_request_context] = lambda: {
            "request_id": "ctx-rid",
            "session_id": "header-session-99",
            "correlation_id": None,
            "frontend_id": None,
            "operator_id": None,
            "user_id": None,
            "chat_id": None,
        }
        try:
            resp = await client.post("/v1/create/chat", json={
                "message": "test",
                "session_id": "body-session-1",
            })
        finally:
            app.dependency_overrides.pop(setup_request_context, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == "body-session-1"

    @pytest.mark.asyncio
    async def test_empty_message_rejected(self, client):
        """Empty string message returns 422 validation error."""
        resp = await client.post("/v1/create/chat", json={
            "message": "",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_missing_message_field(self, client):
        """Missing message field returns 422."""
        resp = await client.post("/v1/create/chat", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_whitespace_only_message_rejected(self, client):
        """Whitespace-only message rejected by validator."""
        resp = await client.post("/v1/create/chat", json={
            "message": "   ",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_invalid_session_id_characters(self, client):
        """Session ID with special characters is rejected."""
        resp = await client.post("/v1/create/chat", json={
            "message": "test",
            "session_id": "invalid session!@#",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_session_id_too_long(self, client):
        """Session ID exceeding 255 characters is rejected."""
        resp = await client.post("/v1/create/chat", json={
            "message": "test",
            "session_id": "a" * 256,
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_valid_base64_image(self, client):
        """Valid base64 image is accepted."""
        small_image = base64.b64encode(b"fake-image-bytes").decode()
        resp = await client.post("/v1/create/chat", json={
            "message": "describe this image",
            "session_id": "img-session",
            "image_b64": small_image,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"

    @pytest.mark.asyncio
    async def test_invalid_base64_image_rejected(self, client):
        """Invalid base64 data is rejected."""
        resp = await client.post("/v1/create/chat", json={
            "message": "describe this",
            "image_b64": "not!valid!base64!!!",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_with_history(self, client):
        """Providing conversation history is accepted."""
        resp = await client.post("/v1/create/chat", json={
            "message": "follow up question",
            "history": [
                {"role": "user", "content": "first message"},
                {"role": "assistant", "content": "first response"},
            ],
        })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_runtime_error_returns_500(self, client, mock_runtime_engine):
        """Runtime engine error returns 500."""
        async def failing_stream(**kwargs):
            raise RuntimeError("LLM unavailable")
            yield  # noqa: unreachable — makes this an async generator

        mock_runtime_engine.stream_chat = failing_stream
        resp = await client.post("/v1/create/chat", json={
            "message": "test",
        })
        assert resp.status_code == 500
        body = resp.json()
        assert "detail" in body


# =========================================================================
# POST /v1/create/chat/stream
# =========================================================================


class TestStreamChatMessage:
    """Tests for the SSE streaming chat endpoint."""

    @pytest.mark.asyncio
    async def test_stream_returns_sse_content_type(self, client):
        """Streaming endpoint returns text/event-stream media type."""
        resp = await client.post("/v1/create/chat/stream", json={
            "message": "stream me",
            "session_id": "stream-session",
        })
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_stream_body_contains_sse_data(self, client):
        """Response body contains SSE 'data:' lines with JSON."""
        resp = await client.post("/v1/create/chat/stream", json={
            "message": "hello",
        })
        assert resp.status_code == 200
        body = resp.text
        # SSE format: "data: {...}\n\n"
        assert "data:" in body

    @pytest.mark.asyncio
    async def test_stream_empty_message_rejected(self, client):
        """Empty message on stream endpoint returns 422."""
        resp = await client.post("/v1/create/chat/stream", json={
            "message": "",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stream_no_cache_headers(self, client):
        """Streaming response includes proper no-cache headers."""
        resp = await client.post("/v1/create/chat/stream", json={
            "message": "test",
        })
        assert resp.status_code == 200
        assert resp.headers.get("cache-control") == "no-cache"


# =========================================================================
# POST /v1/stop-generation
# =========================================================================


class TestStopGeneration:
    """Tests for the stop-generation endpoint."""

    @pytest.mark.asyncio
    async def test_stop_by_request_id(self, client, mock_runtime_engine):
        """Stopping by request_id succeeds."""
        mock_runtime_engine.stop_generation = AsyncMock(return_value=True)
        resp = await client.post("/v1/stop-generation", json={
            "request_id": "req-abc-123",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["stopped"] == 1
        assert body["request_id"] == "req-abc-123"
        mock_runtime_engine.stop_generation.assert_awaited_once_with("req-abc-123")

    @pytest.mark.asyncio
    async def test_stop_by_session_id(self, client, mock_runtime_engine):
        """Stopping by session_id succeeds."""
        mock_runtime_engine.stop_session_generations = AsyncMock(return_value=1)
        resp = await client.post("/v1/stop-generation", json={
            "session_id": "session-xyz",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["stopped"] == 1
        mock_runtime_engine.stop_session_generations.assert_awaited_once_with("session-xyz")

    @pytest.mark.asyncio
    async def test_stop_empty_body_returns_400(self, client, mock_runtime_engine):
        """Empty body (no request_id or session_id) returns 400."""
        resp = await client.post("/v1/stop-generation", json={})
        assert resp.status_code == 400
        body = resp.json()
        assert "request_id or session_id is required" in body["detail"]

    @pytest.mark.asyncio
    async def test_stop_inactive_request(self, client, mock_runtime_engine):
        """Engine reports request not active — stopped=0."""
        mock_runtime_engine.stop_generation = AsyncMock(return_value=False)
        resp = await client.post("/v1/stop-generation", json={
            "request_id": "inactive-req",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["stopped"] == 0

    @pytest.mark.asyncio
    async def test_stop_prefers_request_id_over_session_id(self, client, mock_runtime_engine):
        """When both request_id and session_id are provided, request_id takes priority."""
        mock_runtime_engine.stop_generation = AsyncMock(return_value=True)
        resp = await client.post("/v1/stop-generation", json={
            "request_id": "priority-req",
            "session_id": "also-provided",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["request_id"] == "priority-req"
        assert body["stopped"] == 1

    @pytest.mark.asyncio
    async def test_stop_invalid_session_id_rejected(self, client):
        """Session ID with invalid characters in stop request is rejected."""
        resp = await client.post("/v1/stop-generation", json={
            "session_id": "bad session!",
        })
        assert resp.status_code == 422


# =========================================================================
# GET /v1/chat/history/{session_id}
# =========================================================================


class TestGetChatHistory:
    """Tests for the chat history endpoint."""

    @pytest.mark.asyncio
    async def test_valid_session_returns_history(self, client, mock_runtime_engine):
        """Valid session ID returns history with message count."""
        mock_runtime_engine.get_history = AsyncMock(return_value=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi there"},
        ])

        resp = await client.get("/v1/chat/history/test-session")
        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == "test-session"
        assert body["message_count"] == 2
        assert len(body["messages"]) == 2
        assert body["messages"][0]["role"] == "user"

    @pytest.mark.asyncio
    async def test_empty_history(self, client, mock_runtime_engine):
        """Session with no history returns empty list."""
        mock_runtime_engine.get_history = AsyncMock(return_value=[])

        resp = await client.get("/v1/chat/history/empty-session")
        assert resp.status_code == 200
        body = resp.json()
        assert body["message_count"] == 0
        assert body["messages"] == []

    @pytest.mark.asyncio
    async def test_invalid_session_id_returns_400(self, client):
        """Session ID with special characters returns 400."""
        resp = await client.get("/v1/chat/history/bad%20session!")
        assert resp.status_code == 400
        body = resp.json()
        assert "detail" in body

    @pytest.mark.asyncio
    async def test_alphanumeric_session_id(self, client, mock_runtime_engine):
        """Alphanumeric session ID with hyphens and underscores works."""
        mock_runtime_engine.get_history = AsyncMock(return_value=[])

        resp = await client.get("/v1/chat/history/my-Session_123")
        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == "my-Session_123"

    @pytest.mark.asyncio
    async def test_runtime_error_returns_500(self, client, mock_runtime_engine):
        """Runtime engine failure returns 500."""
        mock_runtime_engine.get_history = AsyncMock(
            side_effect=RuntimeError("storage failure")
        )

        resp = await client.get("/v1/chat/history/valid-session")
        assert resp.status_code == 500


# =========================================================================
# Pydantic Validator Direct Tests
# =========================================================================


class TestValidatorsDirectly:
    """Cover Pydantic validator branches that HTTP tests skip (lines 51, 55, 90, 93, 111, 113, 120)."""

    def test_validate_session_id_empty(self):
        """Empty session → ValueError (line 51)."""
        from api.v1.endpoints.chat import _validate_session_id
        with pytest.raises(ValueError, match="empty"):
            _validate_session_id("")

    def test_validate_session_id_whitespace(self):
        """Whitespace-only session → ValueError (line 51)."""
        from api.v1.endpoints.chat import _validate_session_id
        with pytest.raises(ValueError, match="empty"):
            _validate_session_id("   ")

    def test_validate_session_id_too_long(self):
        """Session ID > 255 chars → ValueError (line 55)."""
        from api.v1.endpoints.chat import _validate_session_id
        with pytest.raises(ValueError, match="too long"):
            _validate_session_id("a" * 256)

    def test_chat_request_image_none(self):
        """ChatRequest with image_b64=None triggers validator (line 90)."""
        from api.v1.endpoints.chat import ChatRequest
        req = ChatRequest(message="test", image_b64=None)
        assert req.image_b64 is None

    def test_chat_request_image_too_large(self):
        """Oversized base64 image → ValueError (line 93)."""
        from api.v1.endpoints.chat import ChatRequest, MAX_IMAGE_B64_SIZE
        import pydantic
        big_image = base64.b64encode(b"x" * (MAX_IMAGE_B64_SIZE + 1)).decode()
        with pytest.raises(pydantic.ValidationError):
            ChatRequest(message="test", image_b64=big_image)

    def test_stop_request_id_none(self):
        """StopGenerationRequest with request_id=None (line 111)."""
        from api.v1.endpoints.chat import StopGenerationRequest
        req = StopGenerationRequest(request_id=None, session_id=None)
        assert req.request_id is None

    def test_stop_request_id_whitespace(self):
        """StopGenerationRequest with empty request_id → error (line 113)."""
        from api.v1.endpoints.chat import StopGenerationRequest
        import pydantic
        with pytest.raises(pydantic.ValidationError):
            StopGenerationRequest(request_id="   ")

    def test_stop_session_id_none(self):
        """StopGenerationRequest with session_id=None (line 120)."""
        from api.v1.endpoints.chat import StopGenerationRequest
        req = StopGenerationRequest(session_id=None)
        assert req.session_id is None


# =========================================================================
# SSE Streaming Deep Tests
# =========================================================================


class TestStreamChatMessageDeep:
    """Cover SSE streaming internals (disconnect, error, enrichment)."""

    @pytest.mark.asyncio
    async def test_stream_with_operator_and_user_id(self, client):
        """Headers X-Operator-Id and X-User-Id enrich chunks (lines 257, 259, 277, 279)."""
        resp = await client.post(
            "/v1/create/chat/stream",
            json={"message": "hello"},
            headers={
                "X-Operator-Id": "op-123",
                "X-User-Id": "user-456",
            },
        )
        assert resp.status_code == 200
        body = resp.text
        # Parse SSE lines
        import json
        data_lines = [line for line in body.strip().split("\n") if line.startswith("data:")]
        assert len(data_lines) >= 2  # at least chunks + done
        # Check first data chunk has operator_id and user_id
        first_chunk = json.loads(data_lines[0].replace("data: ", ""))
        assert first_chunk.get("operator_id") == "op-123"
        assert first_chunk.get("user_id") == "user-456"
        # Check done event
        last_chunk = json.loads(data_lines[-1].replace("data: ", ""))
        assert last_chunk.get("type") == "done"
        assert last_chunk.get("operator_id") == "op-123"
        assert last_chunk.get("user_id") == "user-456"

    @pytest.mark.asyncio
    async def test_stream_client_disconnect(self, client, mock_runtime_engine):
        """Client disconnect triggers stop_generation and break (lines 236-246)."""
        from starlette.requests import Request as StarletteRequest
        from unittest.mock import patch

        call_count = 0

        async def mock_is_disconnected(self):
            nonlocal call_count
            call_count += 1
            return call_count > 1  # First chunk ok, then disconnect

        with patch.object(StarletteRequest, "is_disconnected", new=mock_is_disconnected):
            resp = await client.post(
                "/v1/create/chat/stream",
                json={"message": "hello"},
            )
        assert resp.status_code == 200
        mock_runtime_engine.stop_generation.assert_awaited_once()
        # request_id is middleware-generated UUID; verify it's a non-empty string
        stop_arg = mock_runtime_engine.stop_generation.call_args[0][0]
        assert isinstance(stop_arg, str) and len(stop_arg) > 0

    @pytest.mark.asyncio
    async def test_stream_runtime_error(self, client, mock_runtime_engine):
        """Runtime error during streaming → error payload (lines 294-321)."""
        async def failing_stream(**kwargs):
            yield {"type": "text", "content": "partial"}
            raise RuntimeError("LLM crash")

        mock_runtime_engine.stream_chat = failing_stream

        resp = await client.post(
            "/v1/create/chat/stream",
            json={"message": "test"},
            headers={"X-Operator-Id": "op-1", "X-User-Id": "u-1"},
        )
        assert resp.status_code == 200
        body = resp.text
        import json
        data_lines = [line for line in body.strip().split("\n") if line.startswith("data:")]
        # Should have at least the partial chunk + error event
        assert len(data_lines) >= 2
        last_event = json.loads(data_lines[-1].replace("data: ", ""))
        assert last_event.get("type") == "error"
        assert "request_id" in last_event

    @pytest.mark.asyncio
    async def test_stream_cancelled_error(self, client, mock_runtime_engine):
        """CancelledError during streaming → stop_generation called (lines 282-293)."""
        import asyncio

        async def cancelled_stream(**kwargs):
            yield {"type": "text", "content": "before cancel"}
            raise asyncio.CancelledError()

        mock_runtime_engine.stream_chat = cancelled_stream

        resp = await client.post(
            "/v1/create/chat/stream",
            json={"message": "test"},
        )
        # CancelledError may propagate or be handled by ASGI
        # The important thing: stop_generation was called with the request_id
        mock_runtime_engine.stop_generation.assert_awaited_once()
        stop_arg = mock_runtime_engine.stop_generation.call_args[0][0]
        assert isinstance(stop_arg, str) and len(stop_arg) > 0

    @pytest.mark.asyncio
    async def test_stream_outer_exception(self, app, client):
        """Generic exception inside try block before StreamingResponse → 500 (lines 335-337).

        Override setup_request_context to return an object whose .get() raises,
        so the exception occurs inside the function body's try block.
        """
        from api.dependencies import setup_request_context

        class BrokenContext:
            def get(self, key, default=None):
                raise RuntimeError("context exploded")

        app.dependency_overrides[setup_request_context] = lambda: BrokenContext()
        try:
            resp = await client.post(
                "/v1/create/chat/stream",
                json={"message": "test"},
            )
        finally:
            app.dependency_overrides.pop(setup_request_context, None)
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_stream_outer_http_exception(self, app, client):
        """HTTPException inside try block is re-raised (lines 333-334).

        Return a dict subclass that raises HTTPException on a specific key,
        causing the exception to occur inside the function's try block.
        """
        from api.dependencies import setup_request_context
        from fastapi import HTTPException

        class TrapDict(dict):
            """Dict that raises HTTPException on 'user_id' access."""
            def get(self, key, default=None):
                if key == "user_id":
                    raise HTTPException(status_code=403, detail="forbidden context")
                return super().get(key, default)

        ctx = TrapDict(request_id="test-rid", session_id=None,
                        correlation_id=None, frontend_id=None, operator_id=None)
        app.dependency_overrides[setup_request_context] = lambda: ctx
        try:
            resp = await client.post(
                "/v1/create/chat/stream",
                json={"message": "test"},
            )
        finally:
            app.dependency_overrides.pop(setup_request_context, None)
        assert resp.status_code == 403


# =========================================================================
# Stop Generation Deep Tests
# =========================================================================


class TestStopGenerationDeep:
    """Cover remaining stop_generation branches."""

    @pytest.mark.asyncio
    async def test_stop_generic_exception(self, app, client, mock_runtime_engine):
        """Runtime raises during stop → 500 (lines 408-410)."""
        mock_runtime_engine.stop_generation = AsyncMock(
            side_effect=RuntimeError("engine exploded")
        )

        resp = await client.post("/v1/stop-generation", json={
            "request_id": "req-boom",
        })
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_stop_by_session_with_multiple(self, app, client, mock_runtime_engine):
        """Session-based stop returns actual count from engine."""
        from api.dependencies import setup_request_context

        # Override returns context with no request_id so session_id branch is hit
        app.dependency_overrides[setup_request_context] = lambda: {
            "request_id": None, "session_id": None,
            "correlation_id": None, "frontend_id": None, "operator_id": None,
        }

        mock_runtime_engine.stop_session_generations = AsyncMock(return_value=3)

        try:
            resp = await client.post("/v1/stop-generation", json={
                "session_id": "my-session",
            })
        finally:
            app.dependency_overrides.pop(setup_request_context, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["stopped"] == 3
        mock_runtime_engine.stop_session_generations.assert_awaited_once_with("my-session")

    @pytest.mark.asyncio
    async def test_stop_no_ids_returns_400(self, app, client):
        """Neither request_id nor session_id → 400 (lines 394-398)."""
        from api.dependencies import setup_request_context

        app.dependency_overrides[setup_request_context] = lambda: {
            "request_id": None, "session_id": None,
            "correlation_id": None, "frontend_id": None, "operator_id": None,
        }

        try:
            resp = await client.post("/v1/stop-generation", json={})
        finally:
            app.dependency_overrides.pop(setup_request_context, None)

        assert resp.status_code == 400
        assert "required" in resp.json()["detail"]
