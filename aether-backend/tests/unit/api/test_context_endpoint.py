"""
Unit tests for context endpoint (api/v1/endpoints/context.py).

6 routes:
  GET    /v1/context/chats/{chat_id}/context/status
  POST   /v1/context/chats/{chat_id}/context/summarize
  GET    /v1/context/chats/{chat_id}/context/export
  GET    /v1/context/chats/{chat_id}/context/messages
  GET    /v1/context/agent-context
  DELETE /v1/context/chats/{chat_id}/messages/{message_id}

CI: pytest tests/unit/api/test_context_endpoint.py -m unit --no-cov -q
"""

import pytest
from api.dependencies import get_chat_service
from contextlib import contextmanager

@contextmanager
def override_chat_service(mock_svc, app):
    app.dependency_overrides[get_chat_service] = lambda: mock_svc
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_chat_service, None)



from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock
from uuid import uuid4


CHAT_ID = str(uuid4())
MSG_ID = str(uuid4())

CHAT_SERVICE_PATCH = "api.dependencies.get_chat_service"
INTERP_MGR_PATCH = "api.v1.endpoints.context.get_interpreter_manager"


def _mock_message(role="user", content="Hello world", chat_id=CHAT_ID, msg_id=None):
    """Build a mock message object."""
    msg = MagicMock()
    msg.id = msg_id or str(uuid4())
    msg.role = role
    msg.content = content
    msg.chat_id = chat_id
    return msg


# ===========================================================================
# GET /context/chats/{chat_id}/context/status
# ===========================================================================

class TestContextStatus:

    @pytest.mark.asyncio
    async def test_status_new_chat(self, client, app):
        """Empty chat returns 'new' status (with overhead tokens)."""
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=[])
        
        # Mock interpreter manager to return a system message
        mock_interp = MagicMock()
        mock_interp.system_message = "System prompt"
        mock_interp.computer.terminal.languages = []
        mock_interp.custom_instructions = None
        mock_interp.computer.import_computer_api = False
        
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter.return_value = mock_interp
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "new"
        assert body["message_count"] == 1  # System message
        assert body["token_count"] > 0    # Should have overhead tokens
        assert body["chat_id"] == CHAT_ID

    @pytest.mark.asyncio
    async def test_status_new_chat_no_system(self, client, app):
        """Truly empty chat (no system message) returns 0 tokens."""
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=[])
        
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter.return_value = None
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "new"
        assert body["message_count"] == 0
        assert body["token_count"] == 0

    @pytest.mark.asyncio
    async def test_status_normal_chat(self, client, app):
        """Chat with few messages returns 'normal' status."""
        messages = [_mock_message(content="Short msg")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        with override_chat_service(mock_repo, app):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")
            print("response json:", resp.json())
            print("called:", mock_repo.list_messages.called)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "normal"
        assert body["message_count"] == 1
        assert body["token_count"] > 0
        assert body["usage_percent"] < 80.0

    @pytest.mark.asyncio
    async def test_status_contains_thresholds(self, client, app):
        """Response includes warning/high/critical thresholds with exact values."""
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=[])

        with override_chat_service(mock_repo, app):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")

        assert resp.status_code == 200
        body = resp.json()
        thresholds = body["thresholds"]
        token_limit = body["token_limit"]

        # Verify exact threshold multipliers (0.8 / 0.9 / 0.95)
        assert thresholds["warning"] == int(token_limit * 0.8)
        assert thresholds["high"] == int(token_limit * 0.9)
        assert thresholds["critical"] == int(token_limit * 0.95)
        # Ordering is a consequence of exact values, but verify explicitly
        assert thresholds["warning"] < thresholds["high"] < thresholds["critical"]

    @pytest.mark.asyncio
    async def test_status_invalid_uuid_returns_422(self, client, app):
        """Invalid UUID in path returns 422."""
        resp = await client.get("/v1/context/chats/not-a-uuid/context/status")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_status_db_error_returns_500(self, client, app):
        """Database error returns 500."""
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(side_effect=RuntimeError("db fail"))

        with override_chat_service(mock_repo, app):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")

        assert resp.status_code == 500
        assert "Failed to retrieve context status" in resp.json()["detail"]


# ===========================================================================
# POST /context/chats/{chat_id}/context/summarize
# ===========================================================================

class TestSummarize:

    @pytest.mark.asyncio
    async def test_summarize_invalid_uuid_returns_422(self, client, app):
        """Invalid UUID returns 422."""
        resp = await client.post("/v1/context/chats/not-a-uuid/context/summarize")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_summarize_error_returns_500(self, client, app):
        """Error during summarization returns 500.

        NOTE: The handler has a bug — uses `status.HTTP_500_INTERNAL_SERVER_ERROR`
        but the import is `from fastapi import status as http_status`.
        This causes NameError, which FastAPI converts to 500 anyway.
        """
        mock_repo = MagicMock()
        mock_interp_mgr = MagicMock()

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch(
                 "api.v1.endpoints.context.ContextManager"
             ) as MockCM:
            mock_cm = MagicMock()
            mock_cm.summarize_context = AsyncMock(
                side_effect=RuntimeError("summarize fail")
            )
            MockCM.return_value = mock_cm
            resp = await client.post(
                f"/v1/context/chats/{CHAT_ID}/context/summarize"
            )

        assert resp.status_code == 500


# ===========================================================================
# GET /context/chats/{chat_id}/context/export
# ===========================================================================

class TestExport:

    @pytest.mark.asyncio
    async def test_export_success(self, client, app):
        """Successful export returns context data."""
        export_data = {
            "chat_id": CHAT_ID,
            "title": "Test Chat",
            "summary": "Test conversation summary",
            "key_points": ["Point 1", "Point 2"],
            "artifacts_used": [],
            "message_count": 5,
            "token_count": 200,
        }
        mock_repo = MagicMock()
        mock_interp_mgr = MagicMock()

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch("api.v1.endpoints.context.ContextManager") as MockCM:
            mock_cm = MagicMock()
            mock_cm.export_context = AsyncMock(return_value=export_data)
            MockCM.return_value = mock_cm
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/export"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["summary"] == "Test conversation summary"
        assert body["message_count"] == 5
        assert body["title"] == "Test Chat"

    @pytest.mark.asyncio
    async def test_export_invalid_uuid_returns_422(self, client, app):
        """Invalid UUID returns 422."""
        resp = await client.get("/v1/context/chats/bad/context/export")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_export_error_returns_500(self, client, app):
        """Error during export returns 500."""
        mock_repo = MagicMock()
        mock_interp_mgr = MagicMock()

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch("api.v1.endpoints.context.ContextManager") as MockCM:
            mock_cm = MagicMock()
            mock_cm.export_context = AsyncMock(
                side_effect=RuntimeError("export fail")
            )
            MockCM.return_value = mock_cm
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/export"
            )

        assert resp.status_code == 500
        assert "Failed to export context" in resp.json()["detail"]


# ===========================================================================
# GET /context/chats/{chat_id}/context/messages
# ===========================================================================

class TestContextMessages:

    @pytest.mark.asyncio
    async def test_messages_empty_chat_no_system(self, client, app):
        """Empty chat with no cached interpreter returns no messages."""
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=[])
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=None)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["chat_id"] == CHAT_ID
        assert body["message_count"] == 0
        assert body["messages"] == []

    @pytest.mark.asyncio
    async def test_messages_with_system_message(self, client, app):
        """When cached interpreter has system_message, it's prepended."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)
        mock_interp = MagicMock()
        mock_interp.system_message = "You are a helpful assistant."
        mock_interp.computer = MagicMock()
        mock_interp.computer.terminal.languages = []
        mock_interp.custom_instructions = None
        mock_interp.computer.import_computer_api = False
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=mock_interp)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["message_count"] == 2
        assert body["messages"][0]["role"] == "system"
        assert body["messages"][0]["is_system"] is True
        assert body["messages"][1]["role"] == "user"

    @pytest.mark.asyncio
    async def test_messages_with_conversation(self, client, app):
        """Chat with messages returns them (no cached interpreter)."""
        messages = [
            _mock_message(role="user", content="Hi"),
            _mock_message(role="assistant", content="Hello!"),
        ]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=None)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["message_count"] == 2
        assert body["messages"][0]["role"] == "user"
        assert body["messages"][1]["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_messages_never_calls_spawning_get_interpreter(self, client, app):
        """Regression: context/messages must use get_cached_interpreter, never get_interpreter."""
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=[])
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=None)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        mock_interp_mgr.get_cached_interpreter.assert_called_once()
        mock_interp_mgr.get_interpreter.assert_not_called()

    @pytest.mark.asyncio
    async def test_messages_invalid_uuid_returns_422(self, client, app):
        """Invalid UUID returns 422."""
        resp = await client.get("/v1/context/chats/bad/context/messages")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_messages_db_error_returns_500(self, client, app):
        """Database error returns 500."""
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(side_effect=RuntimeError("db fail"))

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=MagicMock()):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 500


# ===========================================================================
# DELETE /context/chats/{chat_id}/messages/{message_id}
# ===========================================================================

class TestDeleteMessageGroup:

    @pytest.mark.asyncio
    async def test_delete_success(self, client, app):
        """Successful deletion returns result."""
        msg = _mock_message(role="user", chat_id=CHAT_ID, msg_id=MSG_ID)
        mock_repo = MagicMock()
        mock_repo.get_message = AsyncMock(return_value=msg)
        mock_repo.delete_message_group = AsyncMock(
            return_value={"deleted_messages": 2, "deleted_artifacts": 1}
        )

        with override_chat_service(mock_repo, app):
            resp = await client.delete(
                f"/v1/context/chats/{CHAT_ID}/messages/{MSG_ID}"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["deleted_messages"] == 2
        assert body["deleted_artifacts"] == 1

    @pytest.mark.asyncio
    async def test_delete_not_found_returns_404(self, client, app):
        """Missing message returns 404."""
        mock_repo = MagicMock()
        mock_repo.get_message = AsyncMock(return_value=None)

        with override_chat_service(mock_repo, app):
            resp = await client.delete(
                f"/v1/context/chats/{CHAT_ID}/messages/{MSG_ID}"
            )

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_wrong_chat_returns_400(self, client, app):
        """Message from different chat returns 400."""
        other_chat = str(uuid4())
        msg = _mock_message(role="user", chat_id=other_chat, msg_id=MSG_ID)
        mock_repo = MagicMock()
        mock_repo.get_message = AsyncMock(return_value=msg)

        with override_chat_service(mock_repo, app):
            resp = await client.delete(
                f"/v1/context/chats/{CHAT_ID}/messages/{MSG_ID}"
            )

        assert resp.status_code == 400
        assert "does not belong to chat" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_delete_assistant_message_returns_400(self, client, app):
        """Deleting assistant message returns 400."""
        msg = _mock_message(role="assistant", chat_id=CHAT_ID, msg_id=MSG_ID)
        mock_repo = MagicMock()
        mock_repo.get_message = AsyncMock(return_value=msg)

        with override_chat_service(mock_repo, app):
            resp = await client.delete(
                f"/v1/context/chats/{CHAT_ID}/messages/{MSG_ID}"
            )

        assert resp.status_code == 400
        assert "Can only delete user messages" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_delete_invalid_uuid_returns_422(self, client, app):
        """Invalid UUID returns 422."""
        resp = await client.delete(f"/v1/context/chats/{CHAT_ID}/messages/bad")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_delete_db_error_returns_500(self, client, app):
        """Database error returns 500."""
        mock_repo = MagicMock()
        mock_repo.get_message = AsyncMock(side_effect=RuntimeError("db fail"))

        with override_chat_service(mock_repo, app):
            resp = await client.delete(
                f"/v1/context/chats/{CHAT_ID}/messages/{MSG_ID}"
            )

        assert resp.status_code == 500


# ===========================================================================
# GET /context/agent-context
# ===========================================================================

class TestAgentContext:

    @pytest.mark.asyncio
    async def test_agent_context_missing_query_returns_422(self, client, app):
        """Missing query param returns 422."""
        resp = await client.get("/v1/context/agent-context")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_agent_context_success(self, client, app):
        """Valid query returns context data."""
        mock_injector = MagicMock()
        mock_injector.get_agent_context = AsyncMock(
            return_value="Relevant agent context"
        )

        mock_uow = AsyncMock()
        mock_uow.__aenter__ = AsyncMock(return_value=mock_uow)
        mock_uow.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "services.agents.context_injector.AgentContextInjector",
            return_value=mock_injector,
        ), patch(
            "data.database.uow.SupabaseUnitOfWork",
            return_value=mock_uow,
        ):
            resp = await client.get(
                "/v1/context/agent-context?query=test+query"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["query"] == "test query"
        assert body["has_context"] is True
        assert body["context"] == "Relevant agent context"

    @pytest.mark.asyncio
    async def test_agent_context_error_returns_500(self, client, app):
        """Error returns 500."""
        with patch(
            "services.agents.context_injector.AgentContextInjector",
            side_effect=RuntimeError("fail"),
        ), patch(
            "data.database.uow.SupabaseUnitOfWork",
            side_effect=RuntimeError("fail"),
        ):
            resp = await client.get(
                "/v1/context/agent-context?query=test"
            )

        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_agent_context_empty_result(self, client, app):
        """Empty context returns has_context=False."""
        mock_injector = MagicMock()
        mock_injector.get_agent_context = AsyncMock(return_value="")

        mock_uow = AsyncMock()
        mock_uow.__aenter__ = AsyncMock(return_value=mock_uow)
        mock_uow.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "services.agents.context_injector.AgentContextInjector",
            return_value=mock_injector,
        ), patch(
            "data.database.uow.SupabaseUnitOfWork",
            return_value=mock_uow,
        ):
            resp = await client.get(
                "/v1/context/agent-context?query=some+query"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["has_context"] is False
        assert body["context_length"] == 0


# ===========================================================================
# EXPANDED: estimate_token_count helper
# ===========================================================================

class TestEstimateTokenCount:
    """Tests for the estimate_token_count helper function."""

    def test_empty_messages(self):
        from api.v1.endpoints.context import estimate_token_count
        assert estimate_token_count([]) == 0

    def test_string_content(self):
        from api.v1.endpoints.context import estimate_token_count
        msg = MagicMock()
        msg.content = "a" * 100  # 100 chars -> ~25 tokens
        assert estimate_token_count([msg]) == 25

    def test_dict_content_with_text(self):
        from api.v1.endpoints.context import estimate_token_count
        msg = MagicMock()
        msg.content = {"text": "b" * 80}  # 80 chars -> 20 tokens
        assert estimate_token_count([msg]) == 20

    def test_dict_content_without_text(self):
        from api.v1.endpoints.context import estimate_token_count
        msg = MagicMock()
        msg.content = {"image": "base64data"}
        assert estimate_token_count([msg]) == 0

    def test_none_content_attribute(self):
        from api.v1.endpoints.context import estimate_token_count
        msg = MagicMock(spec=[])  # no content attribute
        assert estimate_token_count([msg]) == 0

    def test_multiple_messages(self):
        from api.v1.endpoints.context import estimate_token_count
        m1 = MagicMock()
        m1.content = "a" * 40
        m2 = MagicMock()
        m2.content = "b" * 60
        # (40 + 60) / 4 = 25
        assert estimate_token_count([m1, m2]) == 25

    def test_content_is_none(self):
        """msg.content = None → isinstance(None, str) is False → 0 chars."""
        from api.v1.endpoints.context import estimate_token_count
        msg = MagicMock()
        msg.content = None
        assert estimate_token_count([msg]) == 0

    def test_content_is_integer(self):
        """msg.content = 42 → not str, not dict → 0 chars."""
        from api.v1.endpoints.context import estimate_token_count
        msg = MagicMock()
        msg.content = 42
        assert estimate_token_count([msg]) == 0

    def test_content_is_list(self):
        """msg.content = [{"text": "x"}] → not str, not dict → 0 chars."""
        from api.v1.endpoints.context import estimate_token_count
        msg = MagicMock()
        msg.content = [{"text": "hello"}]
        assert estimate_token_count([msg]) == 0

    def test_empty_string_content(self):
        """msg.content = '' → 0 chars → 0 tokens."""
        from api.v1.endpoints.context import estimate_token_count
        msg = MagicMock()
        msg.content = ""
        assert estimate_token_count([msg]) == 0


# ===========================================================================
# EXPANDED: Context Status — warning, high, critical levels
# ===========================================================================

class TestContextStatusExpanded:
    """Additional context status tests for all status levels."""

    @pytest.mark.asyncio
    async def test_status_warning_level(self, client, app):
        """Chat at 80-90% usage returns 'warning' status."""
        # Need messages totaling ~80% of context window
        # Default context_window is typically 128000, so 80% = 102400 tokens = 409600 chars
        # Create enough content
        from config.settings import get_settings
        settings = get_settings()
        token_limit = settings.llm.context_window
        # Target 85% usage
        target_chars = int(token_limit * 0.85 * 4)
        big_content = "x" * target_chars

        messages = [_mock_message(content=big_content)]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        with override_chat_service(mock_repo, app):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "warning"
        assert body["needs_summarization"] is False
        assert body["recommend_new_chat"] is False

    @pytest.mark.asyncio
    async def test_status_high_level(self, client, app):
        """Chat at 90-95% usage returns 'high' status with needs_summarization."""
        from config.settings import get_settings
        settings = get_settings()
        token_limit = settings.llm.context_window
        # Target 92% usage
        target_chars = int(token_limit * 0.92 * 4)
        big_content = "x" * target_chars

        messages = [_mock_message(content=big_content)]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        with override_chat_service(mock_repo, app):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "high"
        assert body["needs_summarization"] is True
        assert body["recommend_new_chat"] is False

    @pytest.mark.asyncio
    async def test_status_critical_level(self, client, app):
        """Chat at >95% usage returns 'critical' with recommend_new_chat."""
        from config.settings import get_settings
        settings = get_settings()
        token_limit = settings.llm.context_window
        # Target 97% usage
        target_chars = int(token_limit * 0.97 * 4)
        big_content = "x" * target_chars

        messages = [_mock_message(content=big_content)]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        with override_chat_service(mock_repo, app):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "critical"
        assert body["needs_summarization"] is True
        assert body["recommend_new_chat"] is True

    @pytest.mark.asyncio
    async def test_status_usage_percent_calculated(self, client, app):
        """usage_percent is correctly calculated as (token_count / token_limit * 100)."""
        messages = [_mock_message(content="test " * 100)]  # 500 chars = 125 tokens
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        with override_chat_service(mock_repo, app):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["token_count"] == 125
        # Verify exact usage_percent calculation
        expected_usage = 125 / body["token_limit"] * 100
        assert abs(body["usage_percent"] - expected_usage) < 0.001

    @pytest.mark.asyncio
    async def test_status_zero_token_limit(self, client, app):
        """token_limit=0 → usage_percent=0, all thresholds=0, any message → 'critical'.

        Documents edge case: when context_window is 0, all thresholds collapse
        to 0, making any non-empty chat immediately 'critical'. This is
        mathematically correct but semantically ambiguous.
        """
        messages = [_mock_message(content="Hello")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        mock_settings = MagicMock()
        mock_settings.llm.context_window = 0

        with override_chat_service(mock_repo, app), \
             patch("config.settings.get_settings", return_value=mock_settings):
            resp = await client.get(f"/v1/context/chats/{CHAT_ID}/context/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["token_limit"] == 0
        assert body["usage_percent"] == 0.0
        assert body["thresholds"]["warning"] == 0
        assert body["thresholds"]["high"] == 0
        assert body["thresholds"]["critical"] == 0
        # Any message with token_count >= 0 → critical
        assert body["status"] == "critical"
        assert body["recommend_new_chat"] is True


# ===========================================================================
# EXPANDED: Summarization — success path
# ===========================================================================

class TestSummarizeExpanded:
    """Additional summarization tests."""

    @pytest.mark.asyncio
    async def test_summarize_success(self, client, app):
        """Successful summarization returns before/after token counts."""
        summarize_result = {
            "success": True,
            "summary_text": "Conversation summarized.",
            "tokens_before": 5000,
            "tokens_after": 2000,
            "tokens_saved": 3000,
            "message_count": 20,
        }
        mock_repo = MagicMock()
        mock_interp_mgr = MagicMock()

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch("api.v1.endpoints.context.ContextManager") as MockCM:
            mock_cm = MagicMock()
            mock_cm.summarize_context = AsyncMock(return_value=summarize_result)
            MockCM.return_value = mock_cm
            resp = await client.post(
                f"/v1/context/chats/{CHAT_ID}/context/summarize"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["tokens_saved"] == 3000
        assert body["tokens_before"] == 5000
        assert body["tokens_after"] == 2000
        assert body["message_count"] == 20


# ===========================================================================
# EXPANDED: Context Messages — system message injection paths
# ===========================================================================

class TestContextMessagesExpanded:
    """Additional context messages tests for system message injection branches."""

    @pytest.mark.asyncio
    async def test_messages_fallback_enriched_system_message(self, client, app):
        """Fallback to _enriched_system_message when no cached interpreter."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=None)
        mock_interp_mgr._enriched_system_message = "Enriched system prompt from cache."

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch("core.runtime.memory_injector.get_memory_injector") as mock_mem:
            mock_mem_inst = MagicMock()
            mock_mem_inst.get_global_memory_context = AsyncMock(return_value="")
            mock_mem_inst.get_chat_memory_context = AsyncMock(return_value="")
            mock_mem.return_value = mock_mem_inst

            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        # Should have system + user = 2 messages
        assert body["message_count"] == 2
        assert body["messages"][0]["role"] == "system"
        assert body["messages"][0]["is_system"] is True

    @pytest.mark.asyncio
    async def test_messages_with_custom_instructions(self, client, app):
        """Custom instructions are appended to system message."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)
        mock_interp = MagicMock()
        mock_interp.system_message = "Base system prompt."
        mock_interp.computer = MagicMock()
        mock_interp.computer.terminal.languages = []
        mock_interp.custom_instructions = "Always respond in JSON."
        mock_interp.computer.import_computer_api = False
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=mock_interp)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        system_msg = body["messages"][0]
        assert "Always respond in JSON" in system_msg["content"]

    @pytest.mark.asyncio
    async def test_messages_with_language_system_messages(self, client, app):
        """Language-specific system messages are appended."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        mock_lang = MagicMock()
        mock_lang.system_message = "Use Python 3.11."

        mock_interp = MagicMock()
        mock_interp.system_message = "Base system."
        mock_interp.computer = MagicMock()
        mock_interp.computer.terminal.languages = [mock_lang]
        mock_interp.custom_instructions = None
        mock_interp.computer.import_computer_api = False
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=mock_interp)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        system_msg = body["messages"][0]
        assert "Use Python 3.11" in system_msg["content"]

    @pytest.mark.asyncio
    async def test_messages_with_computer_api_message(self, client, app):
        """Computer API system message appended when enabled."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        mock_interp = MagicMock()
        mock_interp.system_message = "Base."
        mock_interp.computer = MagicMock()
        mock_interp.computer.terminal.languages = []
        mock_interp.custom_instructions = None
        mock_interp.computer.import_computer_api = True
        mock_interp.computer.system_message = "Computer API docs here."
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=mock_interp)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        system_msg = body["messages"][0]
        assert "Computer API docs here" in system_msg["content"]

    @pytest.mark.asyncio
    async def test_messages_global_memory_injection(self, client, app):
        """Global memories are injected into system message."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        mock_interp = MagicMock()
        mock_interp.system_message = "Base system."
        mock_interp.computer = MagicMock()
        mock_interp.computer.terminal.languages = []
        mock_interp.custom_instructions = None
        mock_interp.computer.import_computer_api = False
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=mock_interp)
        mock_interp_mgr._enriched_system_message = None

        mock_mem_inst = MagicMock()
        mock_mem_inst.get_global_memory_context = AsyncMock(
            return_value="## \U0001f9e0 Global Memory Context\nUser prefers dark mode."
        )
        mock_mem_inst.get_chat_memory_context = AsyncMock(return_value="")

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch("core.runtime.memory_injector.get_memory_injector", return_value=mock_mem_inst):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        system_msg = body["messages"][0]
        assert "Global Memory Context" in system_msg["content"]
        assert "dark mode" in system_msg["content"]

    @pytest.mark.asyncio
    async def test_messages_chat_memory_injection(self, client, app):
        """Chat-specific memories are injected into system message."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        mock_interp = MagicMock()
        mock_interp.system_message = "Base system."
        mock_interp.computer = MagicMock()
        mock_interp.computer.terminal.languages = []
        mock_interp.custom_instructions = None
        mock_interp.computer.import_computer_api = False
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=mock_interp)
        mock_interp_mgr._enriched_system_message = None

        mock_mem_inst = MagicMock()
        mock_mem_inst.get_global_memory_context = AsyncMock(return_value="")
        mock_mem_inst.get_chat_memory_context = AsyncMock(
            return_value="## \U0001f4ac Chat Memory Context\nPreviously discussed Python."
        )

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch("core.runtime.memory_injector.get_memory_injector", return_value=mock_mem_inst):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        system_msg = body["messages"][0]
        assert "Chat Memory Context" in system_msg["content"]

    @pytest.mark.asyncio
    async def test_messages_memory_failure_continues(self, client, app):
        """Memory injection failure doesn't break the endpoint."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        mock_interp = MagicMock()
        mock_interp.system_message = "Base system."
        mock_interp.computer = MagicMock()
        mock_interp.computer.terminal.languages = []
        mock_interp.custom_instructions = None
        mock_interp.computer.import_computer_api = False
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=mock_interp)
        mock_interp_mgr._enriched_system_message = None

        mock_mem_inst = MagicMock()
        mock_mem_inst.get_global_memory_context = AsyncMock(
            side_effect=RuntimeError("memory db crash")
        )
        mock_mem_inst.get_chat_memory_context = AsyncMock(
            side_effect=RuntimeError("memory db crash")
        )

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch("core.runtime.memory_injector.get_memory_injector", return_value=mock_mem_inst):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        # Should still have system + user messages (memory error is non-fatal)
        assert body["message_count"] == 2

    @pytest.mark.asyncio
    async def test_messages_cache_miss_graceful(self, client, app):
        """Cache miss for interpreter returns messages without system prompt."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=None)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["message_count"] == 1
        assert body["messages"][0]["role"] == "user"

    @pytest.mark.asyncio
    async def test_messages_token_count_and_usage(self, client, app):
        """Token count and usage_percent are calculated from full context."""
        messages = [_mock_message(role="user", content="a" * 400)]  # 100 tokens
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=None)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["token_count"] == 100
        assert body["usage_percent"] > 0
        assert "thresholds" in body
        assert body["token_limit"] > 0

    @pytest.mark.asyncio
    async def test_messages_api_docs_injection(self, client, app):
        """API documentation reference is injected into system message."""
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)

        mock_interp = MagicMock()
        mock_interp.system_message = "Base system."
        mock_interp.computer = MagicMock()
        mock_interp.computer.terminal.languages = []
        mock_interp.custom_instructions = None
        mock_interp.computer.import_computer_api = False
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=mock_interp)
        mock_interp_mgr._enriched_system_message = None

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        system_msg = body["messages"][0]
        assert "Backend API Access" in system_msg["content"]


# ===========================================================================
# EXPANDED: Delete Message Group — ValueError path
# ===========================================================================

class TestDeleteMessageGroupExpanded:
    """Additional delete message group tests."""

    @pytest.mark.asyncio
    async def test_delete_value_error_returns_400(self, client, app):
        """ValueError during deletion returns 400."""
        msg = _mock_message(role="user", chat_id=CHAT_ID, msg_id=MSG_ID)
        mock_repo = MagicMock()
        mock_repo.get_message = AsyncMock(return_value=msg)
        mock_repo.delete_message_group = AsyncMock(
            side_effect=ValueError("invalid state")
        )

        with override_chat_service(mock_repo, app):
            resp = await client.delete(
                f"/v1/context/chats/{CHAT_ID}/messages/{MSG_ID}"
            )

        assert resp.status_code == 400
        assert "Invalid request" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_delete_both_uuids_invalid(self, client, app):
        """Both invalid UUIDs returns 422."""
        resp = await client.delete("/v1/context/chats/bad/messages/also-bad")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_delete_system_message_returns_400(self, client, app):
        """Deleting system message returns 400."""
        msg = _mock_message(role="system", chat_id=CHAT_ID, msg_id=MSG_ID)
        mock_repo = MagicMock()
        mock_repo.get_message = AsyncMock(return_value=msg)

        with override_chat_service(mock_repo, app):
            resp = await client.delete(
                f"/v1/context/chats/{CHAT_ID}/messages/{MSG_ID}"
            )

        assert resp.status_code == 400
        assert "Can only delete user messages" in resp.json()["detail"]


# ===========================================================================
# EXPANDED: Export — additional paths
# ===========================================================================

class TestApiDocsInjectionException:
    """Coverage gap: lines 424-425 — exception in API docs injection."""

    @pytest.mark.asyncio
    async def test_api_docs_injection_failure_graceful(self, client, app):
        """Lines 424-425: exception in get_settings during API docs injection is caught.

        The inline import at context.py:400 does 'from config.settings import get_settings'.
        We patch only that module-level attribute so the INLINE call raises, while FastAPI
        dependency resolution (which already bound its own reference at module load) is unaffected.
        We return a mock whose .base_url is a PropertyMock that raises, so the try block at
        lines 398-425 enters but fails, hitting the except at 424-425.
        """
        messages = [_mock_message(role="user", content="Hi")]
        mock_repo = MagicMock()
        mock_repo.list_messages = AsyncMock(return_value=messages)
        mock_interp = MagicMock()
        mock_interp.system_message = "You are a helpful assistant."
        mock_interp.computer = MagicMock()
        mock_interp.computer.terminal.languages = []
        mock_interp.custom_instructions = None
        mock_interp.computer.import_computer_api = False
        mock_interp.computer.system_message = None
        mock_interp_mgr = MagicMock()
        mock_interp_mgr.get_cached_interpreter = MagicMock(return_value=mock_interp)
        mock_interp_mgr._enriched_system_message = None

        # Return a mock settings object where accessing .base_url raises,
        # triggering the except block at lines 424-425.
        # Must provide real values for llm.context_window (used at line 316)
        # so that token_limit calculations don't crash.
        broken_settings = MagicMock()
        broken_settings.llm.context_window = 128000
        type(broken_settings).base_url = PropertyMock(
            side_effect=RuntimeError("settings unavailable")
        )

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch("core.runtime.memory_injector.get_memory_injector", side_effect=RuntimeError("no injector")), \
             patch("config.settings.get_settings", return_value=broken_settings):
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/messages"
            )

        assert resp.status_code == 200
        body = resp.json()
        # System message should still exist (API docs injection failure is graceful)
        assert body["messages"][0]["role"] == "system"
        # API docs reference should NOT be present (injection failed)
        assert "Backend API Access" not in body["messages"][0]["content"]


class TestExportExpanded:
    """Additional export tests."""

    @pytest.mark.asyncio
    async def test_export_with_artifacts(self, client, app):
        """Export includes artifacts_used."""
        export_data = {
            "chat_id": CHAT_ID,
            "title": "Test",
            "summary": "Summary",
            "key_points": [],
            "artifacts_used": [{"name": "code.py", "type": "code"}],
            "message_count": 3,
            "token_count": 100,
        }
        mock_repo = MagicMock()
        mock_interp_mgr = MagicMock()

        with override_chat_service(mock_repo, app), \
             patch(INTERP_MGR_PATCH, return_value=mock_interp_mgr), \
             patch("api.v1.endpoints.context.ContextManager") as MockCM:
            mock_cm = MagicMock()
            mock_cm.export_context = AsyncMock(return_value=export_data)
            MockCM.return_value = mock_cm
            resp = await client.get(
                f"/v1/context/chats/{CHAT_ID}/context/export"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["artifacts_used"]) == 1
        assert body["artifacts_used"][0]["name"] == "code.py"
