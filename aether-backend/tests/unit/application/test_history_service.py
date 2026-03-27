"""
Tests for application/chat/history_service.py

Covers: ChatHistoryService.__init__ (lines 32-34),
        ChatHistoryService.load_history (lines 46-68)
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from application.chat.history_service import ChatHistoryService


CHAT_ID = uuid4()


# ======================================================================
# Constructor
# ======================================================================


class TestChatHistoryServiceInit:

    def test_constructor_stores_gateway(self):
        """Line 34: Constructor stores gateway reference."""
        gateway = MagicMock()
        svc = ChatHistoryService(gateway)
        assert svc._gateway is gateway

    def test_constructor_none_gateway_raises(self):
        """Lines 32-33: None gateway raises ValueError."""
        with pytest.raises(ValueError, match="requires a SupabasePersistenceGateway"):
            ChatHistoryService(None)


# ======================================================================
# load_history
# ======================================================================


class TestLoadHistory:

    @pytest.mark.asyncio
    async def test_load_history_returns_filtered_messages(self):
        """Lines 46-68: load_history filters by role and non-empty content."""
        mock_msg_user = MagicMock(
            role="user",
            content="Hello",
            metadata={"source": "proactive"},
        )
        mock_msg_asst = MagicMock(
            role="assistant",
            content="Hi there",
            metadata={"context": {"doc_research": [{"query": "q1"}]}},
        )
        mock_msg_system = MagicMock(
            role="system",
            content="You are helpful",
            metadata={"internal": True},
        )
        mock_msg_empty = MagicMock(role="user", content="", metadata={"ignored": True})
        mock_msg_none = MagicMock(role="user", content=None, metadata={"ignored": True})
        mock_msg_tool = MagicMock(role="tool", content="tool output", metadata={"ignored": True})

        mock_repo = MagicMock()
        mock_repo.get_messages = AsyncMock(
            return_value=[mock_msg_user, mock_msg_asst, mock_msg_system,
                          mock_msg_empty, mock_msg_none, mock_msg_tool]
        )

        mock_uow = AsyncMock()
        mock_uow.gateway = MagicMock()
        mock_uow.__aenter__ = AsyncMock(return_value=mock_uow)
        mock_uow.__aexit__ = AsyncMock(return_value=False)

        gateway = MagicMock()
        svc = ChatHistoryService(gateway)

        with patch("application.chat.history_service.SupabaseUnitOfWork", return_value=mock_uow), \
             patch("application.chat.history_service.ChatRepository", return_value=mock_repo), \
             patch("data.database.repositories.proactive_agent.ProactiveAgentRepository", return_value=MagicMock()):
            result = await svc.load_history(
                CHAT_ID,
                limit=50,
                client_id="client-1",
                frontend_id="fe-1",
                correlation_id="corr-1",
            )

        # Only user, assistant, system with non-empty content pass filter
        assert len(result) == 3
        assert result[0] == {
            "role": "user",
            "content": "Hello",
            "metadata": {"source": "proactive"},
        }
        assert result[1] == {
            "role": "assistant",
            "content": "Hi there",
            "metadata": {"context": {"doc_research": [{"query": "q1"}]}},
        }
        assert result[2] == {
            "role": "system",
            "content": "You are helpful",
            "metadata": {"internal": True},
        }

        # Verify repository was called with correct args
        mock_repo.get_messages.assert_called_once_with(CHAT_ID, limit=50)

    @pytest.mark.asyncio
    async def test_load_history_empty_chat(self):
        """Empty chat returns empty list."""
        mock_repo = MagicMock()
        mock_repo.get_messages = AsyncMock(return_value=[])

        mock_uow = AsyncMock()
        mock_uow.gateway = MagicMock()
        mock_uow.__aenter__ = AsyncMock(return_value=mock_uow)
        mock_uow.__aexit__ = AsyncMock(return_value=False)

        gateway = MagicMock()
        svc = ChatHistoryService(gateway)

        with patch("application.chat.history_service.SupabaseUnitOfWork", return_value=mock_uow), \
             patch("application.chat.history_service.ChatRepository", return_value=mock_repo), \
             patch("data.database.repositories.proactive_agent.ProactiveAgentRepository", return_value=MagicMock()):
            result = await svc.load_history(CHAT_ID)

        assert result == []

    @pytest.mark.asyncio
    async def test_load_history_no_optional_params(self):
        """load_history works with only required chat_id."""
        mock_repo = MagicMock()
        mock_repo.get_messages = AsyncMock(
            return_value=[MagicMock(role="user", content="Test", metadata={"k": "v"})]
        )

        mock_uow = AsyncMock()
        mock_uow.gateway = MagicMock()
        mock_uow.__aenter__ = AsyncMock(return_value=mock_uow)
        mock_uow.__aexit__ = AsyncMock(return_value=False)

        gateway = MagicMock()
        svc = ChatHistoryService(gateway)

        with patch("application.chat.history_service.SupabaseUnitOfWork", return_value=mock_uow), \
             patch("application.chat.history_service.ChatRepository", return_value=mock_repo), \
             patch("data.database.repositories.proactive_agent.ProactiveAgentRepository", return_value=MagicMock()):
            result = await svc.load_history(CHAT_ID)

        assert len(result) == 1
        assert result[0] == {"role": "user", "content": "Test", "metadata": {"k": "v"}}
        mock_repo.get_messages.assert_called_once_with(CHAT_ID, limit=None)

    @pytest.mark.asyncio
    async def test_load_history_normalizes_non_dict_metadata_to_empty_dict(self):
        """History hydration must always include a dict metadata payload."""
        mock_repo = MagicMock()
        mock_repo.get_messages = AsyncMock(
            return_value=[
                MagicMock(role="user", content="Has string metadata", metadata="raw"),
                MagicMock(role="assistant", content="Has none metadata", metadata=None),
            ]
        )

        mock_uow = AsyncMock()
        mock_uow.gateway = MagicMock()
        mock_uow.__aenter__ = AsyncMock(return_value=mock_uow)
        mock_uow.__aexit__ = AsyncMock(return_value=False)

        gateway = MagicMock()
        svc = ChatHistoryService(gateway)

        with patch("application.chat.history_service.SupabaseUnitOfWork", return_value=mock_uow), \
             patch("application.chat.history_service.ChatRepository", return_value=mock_repo), \
             patch("data.database.repositories.proactive_agent.ProactiveAgentRepository", return_value=MagicMock()):
            result = await svc.load_history(CHAT_ID)

        assert result == [
            {"role": "user", "content": "Has string metadata", "metadata": {}},
            {"role": "assistant", "content": "Has none metadata", "metadata": {}},
        ]
