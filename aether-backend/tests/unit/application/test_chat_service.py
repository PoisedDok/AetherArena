"""
Unit Tests: ChatService (application/chat/service.py)

Comprehensive coverage of chat CRUD orchestration, message/artifact management,
and DTO conversion via from_model().

Mock boundary:
- ChatRepository → mock all repository methods, return real Pydantic models
  so that from_model() conversion logic executes for real.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4


from application.chat.service import ChatService
from application.chat.entities import ChatSummary, ChatMessage, ChatArtifact
from data.database.models.chat import Chat, Message, Artifact
from data.database.persistence_gateway import SupabasePersistenceGateway


# ─── Helpers ─────────────────────────────────────────────────────────────────

CHAT_ID = uuid4()
MSG_ID = uuid4()
ARTIFACT_UUID = uuid4()
NOW = datetime(2026, 2, 9, 12, 0, 0, tzinfo=timezone.utc)


def _make_gateway() -> MagicMock:
    """Create a mock gateway that passes isinstance check."""
    return MagicMock(spec=SupabasePersistenceGateway)


def _make_service(gateway: MagicMock | None = None) -> tuple[ChatService, MagicMock]:
    """Create ChatService with mocked UOW. Returns (service, gateway)."""
    if gateway is None:
        gateway = _make_gateway()
    uow = SimpleNamespace(gateway=gateway)
    svc = ChatService(uow)
    return svc, gateway


def _make_chat(
    *,
    chat_id: UUID | None = None,
    title: str = "Test Chat",
    message_count: int | None = None,
    last_message_at: datetime | None = None,
) -> Chat:
    """Create a real Chat Pydantic model."""
    return Chat(
        id=chat_id or CHAT_ID,
        title=title,
        created_at=NOW,
        updated_at=NOW,
        message_count=message_count,
        last_message_at=last_message_at,
    )


def _make_message(
    *,
    msg_id: UUID | None = None,
    chat_id: UUID | None = None,
    role: str = "user",
    content: str = "Hello",
    tokens_used: int | None = None,
    correlation_id: UUID | None = None,
) -> Message:
    """Create a real Message Pydantic model."""
    return Message(
        id=msg_id or MSG_ID,
        chat_id=chat_id or CHAT_ID,
        role=role,
        content=content,
        timestamp=NOW,
        sequence_in_chat=1,
        created_at=NOW,
        tokens_used=tokens_used,
        correlation_id=correlation_id,
    )


def _make_artifact(
    *,
    art_id: UUID | None = None,
    chat_id: UUID | None = None,
    message_id: UUID | None = None,
    artifact_id: str | None = "art-001",
    art_type: str = "code",
    content: str = "print('hi')",
    language: str | None = "python",
    filename: str | None = "main.py",
    metadata: dict | None = None,
    subgroup_id: UUID | None = None,
    node_id: UUID | None = None,
) -> Artifact:
    """Create a real Artifact Pydantic model."""
    return Artifact(
        id=art_id or ARTIFACT_UUID,
        chat_id=chat_id or CHAT_ID,
        message_id=message_id,
        artifact_id=artifact_id,
        type=art_type,
        content=content,
        language=language,
        filename=filename,
        metadata=metadata or {},
        subgroup_id=subgroup_id,
        node_id=node_id,
        created_at=NOW,
    )


def _make_view_row(
    *,
    chat_id: UUID | None = None,
    title: str = "Test Chat",
    message_count: int = 5,
    last_message_at: str | None = None,
) -> Dict[str, Any]:
    """Create a dict matching the chat_list view output."""
    return {
        "id": str(chat_id or CHAT_ID),
        "title": title,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
        "message_count": message_count,
        "last_message_at": last_message_at,
    }


# ─── __init__ ────────────────────────────────────────────────────────────────


class TestInit:
    def test_creates_repository_from_gateway(self):
        svc, gw = _make_service()
        assert svc._repository is not None
        assert svc._repository._gateway is gw

    def test_stores_uow(self):
        svc, _ = _make_service()
        assert svc._uow is not None


# ─── list_chats ──────────────────────────────────────────────────────────────


class TestListChats:
    async def test_happy_path(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "list_chats_from_view", new_callable=AsyncMock) as mock_view:
            mock_view.return_value = [_make_view_row(message_count=3)]
            result = await svc.list_chats()

        assert len(result) == 1
        assert isinstance(result[0], ChatSummary)
        assert result[0].title == "Test Chat"
        assert result[0].message_count == 3

    async def test_empty_result(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "list_chats_from_view", new_callable=AsyncMock) as mock_view:
            mock_view.return_value = []
            result = await svc.list_chats()

        assert result == []

    async def test_none_result(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "list_chats_from_view", new_callable=AsyncMock) as mock_view:
            mock_view.return_value = None
            result = await svc.list_chats()

        assert result == []

    async def test_passes_skip_and_limit(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "list_chats_from_view", new_callable=AsyncMock) as mock_view:
            mock_view.return_value = []
            await svc.list_chats(skip=10, limit=25)

        mock_view.assert_awaited_once_with(limit=25, offset=10)

    async def test_multiple_chats_converted(self):
        svc, _ = _make_service()
        id1, id2 = uuid4(), uuid4()

        with patch.object(svc._repository, "list_chats_from_view", new_callable=AsyncMock) as mock_view:
            mock_view.return_value = [
                _make_view_row(chat_id=id1, title="Chat A", message_count=1),
                _make_view_row(chat_id=id2, title="Chat B", message_count=10),
            ]
            result = await svc.list_chats()

        assert len(result) == 2
        assert result[0].id == id1
        assert result[0].title == "Chat A"
        assert result[1].id == id2
        assert result[1].message_count == 10


# ─── get_chat ────────────────────────────────────────────────────────────────


class TestGetChat:
    async def test_found(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_chat", new_callable=AsyncMock) as mock_get, \
             patch.object(svc._repository, "get_chat_statistics", new_callable=AsyncMock) as mock_stats:
            mock_get.return_value = _make_chat()
            mock_stats.return_value = {"message_count": 7, "artifact_count": 2}
            result = await svc.get_chat(CHAT_ID)

        assert isinstance(result, ChatSummary)
        assert result.id == CHAT_ID
        assert result.message_count == 7

    async def test_not_found(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_chat", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = None
            result = await svc.get_chat(CHAT_ID)

        assert result is None


# ─── create_chat ─────────────────────────────────────────────────────────────


class TestCreateChat:
    async def test_happy_path(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "create_chat", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_chat(title="New Chat")
            result = await svc.create_chat("New Chat")

        assert isinstance(result, ChatSummary)
        assert result.title == "New Chat"
        assert result.message_count == 0
        mock_create.assert_awaited_once_with(title="New Chat", description=None, metadata=None)


# ─── update_chat ─────────────────────────────────────────────────────────────


class TestUpdateChat:
    async def test_happy_path(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "update_chat", new_callable=AsyncMock) as mock_update, \
             patch.object(svc._repository, "get_chat_statistics", new_callable=AsyncMock) as mock_stats:
            mock_update.return_value = _make_chat(title="Updated Title")
            mock_stats.return_value = {"message_count": 12}
            result = await svc.update_chat(CHAT_ID, "Updated Title")

        assert isinstance(result, ChatSummary)
        assert result.title == "Updated Title"
        assert result.message_count == 12

    async def test_not_found(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "update_chat", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = None
            result = await svc.update_chat(CHAT_ID, "New Title")

        assert result is None


# ─── delete_chat ─────────────────────────────────────────────────────────────


class TestDeleteChat:
    async def test_returns_true(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "delete_chat", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = True
            result = await svc.delete_chat(CHAT_ID)

        assert result is True

    async def test_returns_false_not_found(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "delete_chat", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = False
            result = await svc.delete_chat(CHAT_ID)

        assert result is False


# ─── list_messages ───────────────────────────────────────────────────────────


class TestListMessages:
    async def test_happy_path(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_messages", new_callable=AsyncMock) as mock_msgs:
            mock_msgs.return_value = [
                _make_message(role="user", content="Hello"),
                _make_message(msg_id=uuid4(), role="assistant", content="Hi there"),
            ]
            result = await svc.list_messages(CHAT_ID)

        assert len(result) == 2
        assert all(isinstance(m, ChatMessage) for m in result)
        assert result[0].role == "user"
        assert result[1].role == "assistant"

    async def test_empty(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_messages", new_callable=AsyncMock) as mock_msgs:
            mock_msgs.return_value = []
            result = await svc.list_messages(CHAT_ID)

        assert result == []

    async def test_passes_limit_and_offset(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_messages", new_callable=AsyncMock) as mock_msgs:
            mock_msgs.return_value = []
            await svc.list_messages(CHAT_ID, limit=20, offset=5)

        mock_msgs.assert_awaited_once_with(CHAT_ID, limit=20, offset=5)


# ─── create_message ──────────────────────────────────────────────────────────


class TestCreateMessage:
    async def test_happy_path(self):
        svc, _ = _make_service()
        parent_id = uuid4()

        with patch.object(svc._repository, "create_message", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_message(
                role="user",
                content="Hello world",
                tokens_used=15,
                correlation_id=parent_id,
            )
            result = await svc.create_message(
                CHAT_ID,
                role="user",
                content="Hello world",
                llm_model="gpt-4",
                llm_provider="openai",
                tokens_used=15,
                parent_message_id=parent_id,
            )

        assert isinstance(result, ChatMessage)
        assert result.content == "Hello world"
        assert result.token_count == 15
        assert result.parent_message_id == parent_id

    async def test_minimal_params(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "create_message", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_message()
            result = await svc.create_message(CHAT_ID, role="user", content="Hello")

        assert isinstance(result, ChatMessage)
        mock_create.assert_awaited_once()
        call_kwargs = mock_create.call_args.kwargs
        assert call_kwargs["llm_model"] is None
        assert call_kwargs["llm_provider"] is None
        assert call_kwargs["tokens_used"] is None
        assert call_kwargs["parent_message_id"] is None


# ─── list_artifacts ──────────────────────────────────────────────────────────


class TestListArtifacts:
    async def test_happy_path(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_artifacts", new_callable=AsyncMock) as mock_arts:
            mock_arts.return_value = [_make_artifact()]
            result = await svc.list_artifacts(CHAT_ID)

        assert len(result) == 1
        assert isinstance(result[0], ChatArtifact)
        assert result[0].type == "code"

    async def test_with_type_filter(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_artifacts", new_callable=AsyncMock) as mock_arts:
            mock_arts.return_value = []
            await svc.list_artifacts(CHAT_ID, artifact_type="html", limit=10, offset=5)

        mock_arts.assert_awaited_once_with(CHAT_ID, type="html", limit=10, offset=5)

    async def test_empty(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_artifacts", new_callable=AsyncMock) as mock_arts:
            mock_arts.return_value = []
            result = await svc.list_artifacts(CHAT_ID)

        assert result == []


# ─── create_artifact ─────────────────────────────────────────────────────────


class TestCreateArtifact:
    async def test_happy_path(self):
        svc, _ = _make_service()
        subgroup = uuid4()
        node = uuid4()

        with patch.object(svc._repository, "create_artifact", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_artifact(
                message_id=MSG_ID,
                subgroup_id=subgroup,
                node_id=node,
            )
            result = await svc.create_artifact(
                CHAT_ID,
                artifact_type="code",
                content="print('hi')",
                filename="main.py",
                language="python",
                artifact_id="art-001",
                message_id=MSG_ID,
                metadata={"key": "val"},
                subgroup_id=subgroup,
                node_id=node,
                execution_group="exec-1",
            )

        assert isinstance(result, ChatArtifact)
        assert result.type == "code"
        assert result.subgroup_id == subgroup
        assert result.node_id == node

    async def test_user_image_vision_llm_routing(self):
        settings = MagicMock()
        settings.llm.supports_vision = True
        svc, _ = _make_service()
        svc._settings = settings
        
        with patch.object(svc._repository, "create_artifact", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_artifact()
            await svc.create_artifact(
                CHAT_ID,
                artifact_type="file",
                content=None,
                filename="photo.jpg",
                language=None,
                artifact_id="file_img001",
                message_id=MSG_ID,
                metadata={"role": "user"},
            )
            
        kw = mock_create.call_args.kwargs
        assert kw["metadata"]["requires_vision"] is False
        assert kw["metadata"]["requires_docling"] is False

    async def test_user_image_text_only_llm_routing(self):
        settings = MagicMock()
        settings.llm.supports_vision = False
        svc, _ = _make_service()
        svc._settings = settings
        
        with patch.object(svc._repository, "create_artifact", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_artifact()
            await svc.create_artifact(
                CHAT_ID,
                artifact_type="file",
                content=None,
                filename="photo.png",
                language=None,
                artifact_id="file_img002",
                message_id=MSG_ID,
                metadata={"role": "user"},
            )
            
        kw = mock_create.call_args.kwargs
        assert kw["metadata"]["requires_vision"] is True
        assert kw["metadata"]["requires_docling"] is False

    async def test_user_document_routing(self):
        settings = MagicMock()
        settings.llm.supports_vision = True
        svc, _ = _make_service()
        svc._settings = settings
        
        with patch.object(svc._repository, "create_artifact", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_artifact()
            await svc.create_artifact(
                CHAT_ID,
                artifact_type="file",
                content=None,
                filename="report.pdf",
                language=None,
                artifact_id="file_doc001",
                message_id=MSG_ID,
                metadata={"role": "user"},
            )
            
        kw = mock_create.call_args.kwargs
        assert kw["metadata"]["requires_vision"] is False
        assert kw["metadata"]["requires_docling"] is True


# ─── update_artifact_message_id ──────────────────────────────────────────────


class TestUpdateArtifactMessageId:
    async def test_happy_path(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "update_artifact_message_id", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = [_make_artifact(message_id=MSG_ID)]
            result = await svc.update_artifact_message_id("art-001", MSG_ID)

        result_list = list(result)
        assert len(result_list) == 1
        assert isinstance(result_list[0], ChatArtifact)

    async def test_empty_result(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "update_artifact_message_id", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = []
            result = await svc.update_artifact_message_id("art-001", MSG_ID)

        assert list(result) == []


# ─── get_message_artifacts ───────────────────────────────────────────────────


class TestGetMessageArtifacts:
    async def test_happy_path(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_message_artifacts", new_callable=AsyncMock) as mock_arts:
            mock_arts.return_value = [
                _make_artifact(art_id=uuid4()),
                _make_artifact(art_id=uuid4(), art_type="output", content="result"),
            ]
            result = await svc.get_message_artifacts(MSG_ID)

        assert len(result) == 2
        assert all(isinstance(a, ChatArtifact) for a in result)

    async def test_empty(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_message_artifacts", new_callable=AsyncMock) as mock_arts:
            mock_arts.return_value = []
            result = await svc.get_message_artifacts(MSG_ID)

        assert result == []


# ─── get_artifact_source ─────────────────────────────────────────────────────


class TestGetArtifactSource:
    async def test_found(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_artifact_source", new_callable=AsyncMock) as mock_src:
            mock_src.return_value = _make_message(role="assistant", content="Generated code")
            result = await svc.get_artifact_source(ARTIFACT_UUID)

        assert isinstance(result, ChatMessage)
        assert result.content == "Generated code"

    async def test_not_found(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_artifact_source", new_callable=AsyncMock) as mock_src:
            mock_src.return_value = None
            result = await svc.get_artifact_source(ARTIFACT_UUID)

        assert result is None


# ─── get_artifact ────────────────────────────────────────────────────────────


class TestGetArtifact:
    async def test_found(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_artifact", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = _make_artifact()
            result = await svc.get_artifact(ARTIFACT_UUID)

        assert isinstance(result, ChatArtifact)
        assert result.id == ARTIFACT_UUID

    async def test_not_found(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "get_artifact", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = None
            result = await svc.get_artifact(ARTIFACT_UUID)

        assert result is None


# ─── update_artifact ─────────────────────────────────────────────────────────


class TestUpdateArtifact:
    async def test_happy_path(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "update_artifact", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = _make_artifact(content="updated code", filename="new.py")
            result = await svc.update_artifact(
                ARTIFACT_UUID,
                content="updated code",
                filename="new.py",
                language="python",
                metadata={"version": 2},
            )

        assert isinstance(result, ChatArtifact)
        assert result.content == "updated code"
        assert result.filename == "new.py"

    async def test_not_found(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "update_artifact", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = None
            result = await svc.update_artifact(ARTIFACT_UUID, content="x")

        assert result is None


# ─── delete_artifact ─────────────────────────────────────────────────────────


class TestDeleteArtifact:
    async def test_returns_true(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "delete_artifact", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = True
            result = await svc.delete_artifact(ARTIFACT_UUID)

        assert result is True

    async def test_returns_false(self):
        svc, _ = _make_service()

        with patch.object(svc._repository, "delete_artifact", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = False
            result = await svc.delete_artifact(ARTIFACT_UUID)

        assert result is False
