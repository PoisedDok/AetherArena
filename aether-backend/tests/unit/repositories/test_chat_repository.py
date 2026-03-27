"""
Tests for data/database/repositories/chat.py

Covers: Chat CRUD, Message CRUD (with RPC sequence), Artifact CRUD,
search_chats, chat statistics, chat references, chat summaries.
All gateway calls mocked via AsyncMock.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4, UUID
from datetime import datetime, timezone

from data.database.repositories.chat import ChatRepository
from data.database.persistence_gateway import SupabasePersistenceGateway


NOW_ISO = datetime.now(timezone.utc).isoformat()
CHAT_ID = uuid4()
MSG_ID = uuid4()
ART_ID = uuid4()


def _make_gateway():
    """Create a mocked SupabasePersistenceGateway."""
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.insert = AsyncMock()
    gw.insert_one = AsyncMock()
    gw.select = AsyncMock(return_value=[])
    gw.select_one = AsyncMock(return_value=None)
    gw.update = AsyncMock()
    gw.update_like = AsyncMock(return_value=[])
    gw.delete = AsyncMock()
    gw.upsert = AsyncMock()
    gw.count = AsyncMock(return_value=0)
    gw.rpc = AsyncMock(return_value=1)
    gw.group_count = AsyncMock(return_value=[])
    gw.text_search = AsyncMock(return_value=[])
    return gw


SAMPLE_CHAT = {
    "id": str(CHAT_ID),
    "title": "Test Chat",
    "created_at": NOW_ISO,
    "updated_at": NOW_ISO,
}

SAMPLE_MESSAGE = {
    "id": str(MSG_ID),
    "chat_id": str(CHAT_ID),
    "role": "user",
    "content": "Hello",
    "timestamp": NOW_ISO,
    "sequence_in_chat": 1,
    "llm_model": None,
    "llm_provider": None,
    "tokens_used": None,
    "correlation_id": None,
    "created_at": NOW_ISO,
}

SAMPLE_ARTIFACT = {
    "id": str(ART_ID),
    "chat_id": str(CHAT_ID),
    "type": "code",
    "content": "print('hi')",
    "language": "python",
    "filename": "test.py",
    "artifact_id": "art-001",
    "message_id": str(MSG_ID),
    "metadata": {},
    "subgroup_id": None,
    "node_id": None,
    "created_at": NOW_ISO,
    "updated_at": NOW_ISO,
}


@pytest.fixture
def repo():
    gw = _make_gateway()
    return ChatRepository(db=gw), gw


# ===========================================================================
# Constructor Tests
# ===========================================================================

class TestConstructor:
    """Tests for ChatRepository constructor."""

    def test_with_gateway(self):
        gw = _make_gateway()
        repo = ChatRepository(db=gw)
        assert repo._gateway is gw

    def test_with_none_raises(self):
        with pytest.raises(ValueError):
            ChatRepository(db=None)

    def test_with_session_raises(self):
        with pytest.raises(RuntimeError, match="SQLAlchemy"):
            ChatRepository(db=None, session=MagicMock())

    def test_with_unsupported_type_raises(self):
        with pytest.raises(TypeError):
            ChatRepository(db="invalid")


# ===========================================================================
# Chat CRUD Tests
# ===========================================================================

class TestChatCRUD:
    """Tests for chat create/read/update/delete."""

    @pytest.mark.asyncio
    async def test_create_chat(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_CHAT]
        chat = await r.create_chat("Test Chat")
        assert chat.title == "Test Chat"
        gw.insert.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_chat_with_id(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_CHAT]
        chat = await r.create_chat_with_id(CHAT_ID, "Test")
        assert str(chat.id) == str(CHAT_ID)

    @pytest.mark.asyncio
    async def test_get_chat(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_CHAT]
        chat = await r.get_chat(CHAT_ID)
        assert chat is not None
        assert chat.title == "Test Chat"

    @pytest.mark.asyncio
    async def test_get_chat_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        chat = await r.get_chat(uuid4())
        assert chat is None

    @pytest.mark.asyncio
    async def test_list_chats(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_CHAT]
        chats = await r.list_chats()
        assert len(chats) == 1

    @pytest.mark.asyncio
    async def test_update_chat(self, repo):
        r, gw = repo
        updated = {**SAMPLE_CHAT, "title": "Updated"}
        gw.update.return_value = [updated]
        chat = await r.update_chat(CHAT_ID, title="Updated")
        assert chat.title == "Updated"

    @pytest.mark.asyncio
    async def test_update_chat_no_title(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_CHAT]
        chat = await r.update_chat(CHAT_ID, title=None)
        assert chat.title == "Test Chat"

    @pytest.mark.asyncio
    async def test_delete_chat(self, repo):
        r, gw = repo
        result = await r.delete_chat(CHAT_ID)
        assert result is True


# ===========================================================================
# Ensure Chat Exists Tests
# ===========================================================================

class TestEnsureChatExists:
    """Tests for ensure_chat_exists (concurrent-safe upsert)."""

    @pytest.mark.asyncio
    async def test_chat_already_exists(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_CHAT]
        chat = await r.ensure_chat_exists(CHAT_ID)
        assert chat is not None

    @pytest.mark.asyncio
    async def test_chat_created_fresh(self, repo):
        r, gw = repo
        # First call: not found; then create succeeds
        gw.select.side_effect = [[], [SAMPLE_CHAT]]
        gw.insert.return_value = [SAMPLE_CHAT]
        chat = await r.ensure_chat_exists(CHAT_ID)
        assert chat is not None


# ===========================================================================
# Message CRUD Tests
# ===========================================================================

class TestMessageCRUD:
    """Tests for message create/read."""

    @pytest.mark.asyncio
    async def test_create_message(self, repo):
        r, gw = repo
        gw.rpc.return_value = 1
        gw.insert.return_value = [SAMPLE_MESSAGE]
        msg = await r.create_message(CHAT_ID, "user", "Hello")
        assert msg.role == "user"
        gw.rpc.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_message_with_optional_fields(self, repo):
        r, gw = repo
        gw.rpc.return_value = 2
        gw.insert.return_value = [{**SAMPLE_MESSAGE, "llm_model": "gpt-4"}]
        msg = await r.create_message(
            CHAT_ID, "assistant", "Hi there",
            llm_model="gpt-4", llm_provider="openai",
            tokens_used=100, message_id=MSG_ID
        )
        assert msg is not None

    @pytest.mark.asyncio
    async def test_get_message(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_MESSAGE]
        msg = await r.get_message(MSG_ID)
        assert msg is not None
        assert msg.content == "Hello"

    @pytest.mark.asyncio
    async def test_get_message_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        msg = await r.get_message(uuid4())
        assert msg is None

    @pytest.mark.asyncio
    async def test_get_messages(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_MESSAGE]
        msgs = await r.get_messages(CHAT_ID)
        assert len(msgs) == 1


# ===========================================================================
# Artifact CRUD Tests
# ===========================================================================

class TestArtifactCRUD:
    """Tests for artifact create/read/update/delete."""

    @pytest.mark.asyncio
    async def test_create_artifact(self, repo):
        r, gw = repo
        gw.upsert.return_value = [SAMPLE_ARTIFACT]
        art = await r.create_artifact(
            CHAT_ID, "code", "print('hi')",
            language="python", artifact_id="art-001"
        )
        assert art.type == "code"
        gw.upsert.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_artifact_no_id_raises(self, repo):
        r, gw = repo
        with pytest.raises(ValueError, match="artifact_id is REQUIRED"):
            await r.create_artifact(CHAT_ID, "code", "content")

    @pytest.mark.asyncio
    async def test_get_artifact(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_ARTIFACT]
        art = await r.get_artifact(ART_ID)
        assert art is not None

    @pytest.mark.asyncio
    async def test_get_artifacts(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_ARTIFACT]
        arts = await r.get_artifacts(CHAT_ID)
        assert len(arts) == 1

    @pytest.mark.asyncio
    async def test_get_artifacts_with_type_filter(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_ARTIFACT]
        arts = await r.get_artifacts(CHAT_ID, type="code")
        assert len(arts) == 1

    @pytest.mark.asyncio
    async def test_update_artifact(self, repo):
        r, gw = repo
        updated = {**SAMPLE_ARTIFACT, "content": "updated"}
        gw.update.return_value = [updated]
        art = await r.update_artifact(ART_ID, content="updated")
        assert art.content == "updated"

    @pytest.mark.asyncio
    async def test_update_artifact_no_fields(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_ARTIFACT]
        art = await r.update_artifact(ART_ID)
        assert art is not None

    @pytest.mark.asyncio
    async def test_delete_artifact(self, repo):
        r, gw = repo
        result = await r.delete_artifact(ART_ID)
        assert result is True

    @pytest.mark.asyncio
    async def test_get_message_artifacts(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_ARTIFACT]
        arts = await r.get_message_artifacts(MSG_ID)
        assert len(arts) == 1


# ===========================================================================
# Delete Message Tests
# ===========================================================================

class TestDeleteMessage:
    """Tests for message deletion with cascade."""

    @pytest.mark.asyncio
    async def test_delete_message_with_cascade(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_ARTIFACT]
        result = await r.delete_message(MSG_ID, cascade_artifacts=True)
        assert result is True

    @pytest.mark.asyncio
    async def test_delete_message_no_cascade(self, repo):
        r, gw = repo
        result = await r.delete_message(MSG_ID, cascade_artifacts=False)
        assert result is True
        # Should not query artifacts
        assert gw.select.call_count == 0


# ===========================================================================
# Search Chats Tests
# ===========================================================================

class TestSearchChats:
    """Tests for search_chats."""

    @pytest.mark.asyncio
    async def test_search_empty_query_raises(self, repo):
        r, gw = repo
        with pytest.raises(ValueError, match="non-empty"):
            await r.search_chats(query="")

    @pytest.mark.asyncio
    async def test_search_title_match(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": str(CHAT_ID), "title": "Machine Learning Notes"}]
        results = await r.search_chats(query="machine")
        assert len(results) == 1
        assert results[0]["relevance_score"] == 1.0

    @pytest.mark.asyncio
    async def test_search_no_match(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": str(CHAT_ID), "title": "Unrelated"}]
        results = await r.search_chats(query="quantum")
        assert len(results) == 0


# ===========================================================================
# Chat Statistics Tests
# ===========================================================================

class TestChatStatistics:
    """Tests for get_chat_statistics and bulk."""

    @pytest.mark.asyncio
    async def test_get_statistics(self, repo):
        r, gw = repo
        gw.group_count.side_effect = [
            [{"count": "5"}],  # messages
            [{"count": "2"}],  # artifacts
        ]
        stats = await r.get_chat_statistics(CHAT_ID)
        assert stats["message_count"] == 5
        assert stats["artifact_count"] == 2

    @pytest.mark.asyncio
    async def test_get_statistics_empty(self, repo):
        r, gw = repo
        gw.group_count.side_effect = [[], []]
        stats = await r.get_chat_statistics(CHAT_ID)
        assert stats["message_count"] == 0

    @pytest.mark.asyncio
    async def test_bulk_statistics_empty_list(self, repo):
        r, gw = repo
        result = await r.get_chat_statistics_bulk([])
        assert result == {}

    @pytest.mark.asyncio
    async def test_bulk_statistics(self, repo):
        r, gw = repo
        cid = str(CHAT_ID)
        gw.group_count.side_effect = [
            [{"chat_id": cid, "message_count": 3}],
            [{"chat_id": cid, "artifact_count": 1}],
        ]
        result = await r.get_chat_statistics_bulk([CHAT_ID])
        assert cid in result


# ===========================================================================
# Chat References Tests
# ===========================================================================

class TestChatReferences:
    """Tests for chat reference operations."""

    @pytest.mark.asyncio
    async def test_create_reference(self, repo):
        r, gw = repo
        ref_data = {"id": str(uuid4()), "source_chat_id": str(CHAT_ID)}
        gw.insert.return_value = [ref_data]
        result = await r.create_chat_reference(CHAT_ID, uuid4())
        assert "id" in result

    @pytest.mark.asyncio
    async def test_get_reference(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": str(uuid4())}]
        result = await r.get_chat_reference(uuid4())
        assert result is not None

    @pytest.mark.asyncio
    async def test_list_references_source(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": str(uuid4())}]
        result = await r.list_chat_references(CHAT_ID, direction="source")
        assert len(result) == 1

    @pytest.mark.asyncio
    async def test_list_references_both(self, repo):
        r, gw = repo
        ref_id = str(uuid4())
        gw.select.side_effect = [
            [{"id": ref_id}],  # source
            [{"id": ref_id}],  # target (same -- dedup)
        ]
        result = await r.list_chat_references(CHAT_ID, direction="both")
        assert len(result) == 1  # Deduplicated

    @pytest.mark.asyncio
    async def test_delete_reference(self, repo):
        r, gw = repo
        result = await r.delete_chat_reference(uuid4())
        assert result is True


# ===========================================================================
# Chat Summaries Tests
# ===========================================================================

class TestChatSummaries:
    """Tests for chat summary operations."""

    @pytest.mark.asyncio
    async def test_get_summary(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": str(uuid4()), "summary_text": "test"}]
        result = await r.get_chat_summary(CHAT_ID)
        assert result is not None

    @pytest.mark.asyncio
    async def test_get_summary_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_chat_summary(CHAT_ID)
        assert result is None

    @pytest.mark.asyncio
    async def test_list_summaries(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.list_chat_summaries(CHAT_ID)
        assert result == []

    @pytest.mark.asyncio
    async def test_search_summaries(self, repo):
        r, gw = repo
        result = await r.search_chat_summaries("test query")
        assert isinstance(result, list)


# ===========================================================================
# Constructor — SupabaseClient adapter path
# ===========================================================================

class TestConstructorSupabaseClientPath:
    """Tests for the SupabaseClient → gateway wrapping path."""

    def test_with_supabase_client(self):
        from data.database.clients.supabase import SupabaseClient
        mock_client = MagicMock(spec=SupabaseClient)
        repo = ChatRepository(db=mock_client)
        assert repo._gateway is not None


# ===========================================================================
# Chat CRUD — additional branches & error paths
# ===========================================================================

class TestChatCRUDExtra:

    async def test_create_chat_error_propagates(self, repo):
        r, gw = repo
        gw.insert.side_effect = Exception("DB error")
        with pytest.raises(Exception, match="DB error"):
            await r.create_chat("Fail")

    async def test_create_chat_with_id_user_id_branch(self, repo):
        r, gw = repo
        uid = uuid4()
        gw.insert.return_value = [{**SAMPLE_CHAT, "user_id": str(uid)}]
        chat = await r.create_chat_with_id(CHAT_ID, "Test", user_id=uid)
        call_data = gw.insert.call_args[0][1]
        assert call_data["user_id"] == str(uid)

    async def test_create_chat_with_id_error_propagates(self, repo):
        r, gw = repo
        gw.insert.side_effect = Exception("Insert fail")
        with pytest.raises(Exception, match="Insert fail"):
            await r.create_chat_with_id(uuid4(), "Fail")

    async def test_get_chat_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Select fail")
        with pytest.raises(Exception, match="Select fail"):
            await r.get_chat(uuid4())

    async def test_list_chats_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("List fail")
        with pytest.raises(Exception, match="List fail"):
            await r.list_chats()

    async def test_update_chat_uses_timezone_aware_datetime(self, repo):
        """BUG FIX: update_chat must use timezone-aware datetime, not deprecated utcnow()."""
        r, gw = repo
        updated = {**SAMPLE_CHAT, "title": "T"}
        gw.update.return_value = [updated]
        await r.update_chat(CHAT_ID, title="T")
        call_data = gw.update.call_args[0][1]
        # Must contain '+00:00' or 'Z' suffix (timezone-aware)
        updated_at = call_data["updated_at"]
        assert "+00:00" in updated_at or updated_at.endswith("Z"), (
            f"updated_at must be timezone-aware, got: {updated_at}"
        )

    async def test_update_chat_not_found_error(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("record not found")
        result = await r.update_chat(uuid4(), title="T")
        assert result is None

    async def test_update_chat_non_found_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("DB crash")
        with pytest.raises(Exception, match="DB crash"):
            await r.update_chat(uuid4(), title="T")

    async def test_delete_chat_not_found_error(self, repo):
        r, gw = repo
        gw.delete.side_effect = Exception("not found in table")
        result = await r.delete_chat(uuid4())
        assert result is False

    async def test_delete_chat_other_error_propagates(self, repo):
        r, gw = repo
        gw.delete.side_effect = Exception("permission denied")
        with pytest.raises(Exception, match="permission denied"):
            await r.delete_chat(uuid4())


# ===========================================================================
# ensure_chat_exists — unique violation / concurrent creation
# ===========================================================================

class TestEnsureChatExistsExtra:

    async def test_unique_violation_refetches(self, repo):
        """Concurrent creation triggers 23505; re-fetch succeeds."""
        r, gw = repo
        gw.select.side_effect = [
            [],              # first check: not found
            [SAMPLE_CHAT],   # re-fetch after unique violation
        ]
        gw.insert.side_effect = Exception("duplicate key value violates unique constraint 23505")
        chat = await r.ensure_chat_exists(CHAT_ID)
        assert chat is not None

    async def test_unique_violation_refetch_also_fails(self, repo):
        """23505 + re-fetch returns None → logs error, raises."""
        r, gw = repo
        gw.select.side_effect = [
            [],    # first check: not found
            [],    # re-fetch after unique violation: still empty
        ]
        gw.insert.side_effect = Exception("duplicate key 23505")
        with pytest.raises(Exception, match="23505"):
            await r.ensure_chat_exists(CHAT_ID)

    async def test_non_unique_error_propagates(self, repo):
        r, gw = repo
        gw.select.return_value = []
        gw.insert.side_effect = Exception("permission denied")
        with pytest.raises(Exception, match="permission denied"):
            await r.ensure_chat_exists(CHAT_ID)


# ===========================================================================
# list_chats_from_view
# ===========================================================================

class TestListChatsFromView:

    async def test_success(self, repo):
        r, gw = repo
        view_data = [
            {"id": str(CHAT_ID), "title": "T", "message_count": 5, "last_message_at": NOW_ISO}
        ]
        gw.select.return_value = view_data
        result = await r.list_chats_from_view(limit=10, offset=0)
        assert result == view_data

    async def test_empty_result(self, repo):
        r, gw = repo
        gw.select.return_value = None
        result = await r.list_chats_from_view()
        assert result == []

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("View fail")
        with pytest.raises(Exception, match="View fail"):
            await r.list_chats_from_view()


# ===========================================================================
# search_chats — additional branches
# ===========================================================================

class TestSearchChatsExtra:

    async def test_search_limit_validation(self, repo):
        r, gw = repo
        # limit=0 is falsy → int(0 or 10) = 10, so use -1 to trigger < 1 check
        with pytest.raises(ValueError, match="limit must be >= 1"):
            await r.search_chats(query="test", limit=-1)

    async def test_search_limit_capped_at_50(self, repo):
        r, gw = repo
        gw.select.return_value = []
        # Mock list_chats_from_view
        r.list_chats_from_view = AsyncMock(return_value=[])
        results = await r.search_chats(query="test", limit=100)
        assert isinstance(results, list)

    async def test_search_message_content_match(self, repo):
        r, gw = repo
        # list_chats_from_view returns candidate with non-matching title
        r.list_chats_from_view = AsyncMock(return_value=[
            {"id": str(CHAT_ID), "title": "Unrelated Title"}
        ])
        # Messages contain the query
        gw.select.return_value = [
            {"content": "This discusses quantum physics theory"}
        ]
        results = await r.search_chats(query="quantum")
        assert len(results) == 1
        assert results[0]["relevance_score"] == 0.6
        assert results[0]["key_points"] == ["Recent message match"]

    async def test_search_message_fetch_error_continues(self, repo):
        r, gw = repo
        r.list_chats_from_view = AsyncMock(return_value=[
            {"id": str(CHAT_ID), "title": "No Match"}
        ])
        gw.select.side_effect = Exception("Message fetch fail")
        results = await r.search_chats(query="test")
        assert len(results) == 0

    async def test_search_non_dict_candidate_skipped(self, repo):
        r, gw = repo
        r.list_chats_from_view = AsyncMock(return_value=["not-a-dict"])
        results = await r.search_chats(query="test")
        assert results == []

    async def test_search_candidate_without_id_skipped(self, repo):
        r, gw = repo
        r.list_chats_from_view = AsyncMock(return_value=[
            {"title": "No ID here"}
        ])
        results = await r.search_chats(query="test")
        assert results == []

    async def test_search_non_string_title(self, repo):
        r, gw = repo
        r.list_chats_from_view = AsyncMock(return_value=[
            {"id": str(CHAT_ID), "title": None}
        ])
        gw.select.return_value = []
        results = await r.search_chats(query="test")
        assert results == []

    async def test_search_results_sorted_by_relevance(self, repo):
        """Title matches (1.0) should come before message matches (0.6)."""
        r, gw = repo
        cid1 = str(uuid4())
        cid2 = str(uuid4())
        r.list_chats_from_view = AsyncMock(return_value=[
            {"id": cid1, "title": "Unrelated"},
            {"id": cid2, "title": "Python tutorial"},
        ])
        gw.select.return_value = [{"content": "Learning python basics"}]
        results = await r.search_chats(query="python")
        assert len(results) == 2
        # Title match should be first
        assert results[0]["relevance_score"] == 1.0
        assert results[1]["relevance_score"] == 0.6

    async def test_search_stops_at_limit(self, repo):
        r, gw = repo
        candidates = [
            {"id": str(uuid4()), "title": f"Python {i}"} for i in range(20)
        ]
        r.list_chats_from_view = AsyncMock(return_value=candidates)
        results = await r.search_chats(query="python", limit=3)
        assert len(results) == 3

    async def test_search_whitespace_only_raises(self, repo):
        r, gw = repo
        with pytest.raises(ValueError, match="non-empty"):
            await r.search_chats(query="   ")


# ===========================================================================
# Message CRUD — additional branches
# ===========================================================================

class TestMessageCRUDExtra:

    async def test_create_message_with_parent_id(self, repo):
        r, gw = repo
        parent_id = uuid4()
        gw.rpc.return_value = 3
        gw.insert.return_value = [{**SAMPLE_MESSAGE, "correlation_id": str(parent_id)}]
        msg = await r.create_message(
            CHAT_ID, "user", "Reply",
            parent_message_id=parent_id,
        )
        call_data = gw.insert.call_args[0][1]
        assert call_data["correlation_id"] == str(parent_id)

    async def test_create_message_error_propagates(self, repo):
        r, gw = repo
        gw.rpc.return_value = 1
        gw.insert.side_effect = Exception("Insert fail")
        with pytest.raises(Exception, match="Insert fail"):
            await r.create_message(CHAT_ID, "user", "Test")

    async def test_get_message_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Select fail")
        with pytest.raises(Exception, match="Select fail"):
            await r.get_message(uuid4())

    async def test_get_messages_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Select fail")
        with pytest.raises(Exception, match="Select fail"):
            await r.get_messages(uuid4())


# ===========================================================================
# get_pending_artifacts
# ===========================================================================

class TestGetPendingArtifacts:

    async def test_returns_results(self, repo):
        r, gw = repo
        pending = [{"id": str(uuid4()), "chat_id": str(CHAT_ID), "message_id": None}]
        gw.select.return_value = pending
        result = await r.get_pending_artifacts(CHAT_ID)
        assert result == pending

    async def test_none_result_returns_empty(self, repo):
        r, gw = repo
        gw.select.return_value = None
        result = await r.get_pending_artifacts(CHAT_ID)
        assert result == []

    async def test_error_returns_empty(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("DB error")
        result = await r.get_pending_artifacts(CHAT_ID)
        assert result == []

    async def test_custom_since_seconds(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_pending_artifacts(CHAT_ID, since_seconds=300)
        assert result == []
        call_kwargs = gw.select.call_args[1]
        assert "gte" in str(call_kwargs["filters"]["created_at"])


# ===========================================================================
# update_artifact_message_id
# ===========================================================================

class TestUpdateArtifactMessageId:

    async def test_success_on_artifact_id_column(self, repo):
        r, gw = repo
        mid = uuid4()
        gw.update.return_value = [{**SAMPLE_ARTIFACT, "message_id": str(mid)}]
        result = await r.update_artifact_message_id("art-001", mid)
        assert len(result) == 1

    async def test_first_attempt_empty_fallback_to_id(self, repo):
        r, gw = repo
        mid = uuid4()
        gw.update.side_effect = [
            [],  # artifact_id column: empty → continue
            [{**SAMPLE_ARTIFACT, "message_id": str(mid)}],  # id column: success
        ]
        result = await r.update_artifact_message_id(str(ART_ID), mid)
        assert len(result) == 1
        assert gw.update.call_count == 2

    async def test_value_error_continues(self, repo):
        r, gw = repo
        mid = uuid4()
        gw.update.side_effect = [
            ValueError("not found"),
            [{**SAMPLE_ARTIFACT, "message_id": str(mid)}],
        ]
        result = await r.update_artifact_message_id("art-x", mid)
        assert len(result) == 1

    async def test_other_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("DB crash")
        with pytest.raises(Exception, match="DB crash"):
            await r.update_artifact_message_id("art-x", uuid4())

    async def test_prefix_fallback_succeeds(self, repo):
        r, gw = repo
        mid = uuid4()
        gw.update.side_effect = [
            [],           # artifact_id: empty
            ValueError(), # id: not found
        ]
        gw.update_like.return_value = [{**SAMPLE_ARTIFACT, "message_id": str(mid)}]
        result = await r.update_artifact_message_id("art-prefix", mid)
        assert len(result) == 1

    async def test_prefix_fallback_fails(self, repo):
        r, gw = repo
        gw.update.side_effect = [[], ValueError()]
        gw.update_like.side_effect = Exception("Like fail")
        with pytest.raises(Exception, match="Like fail"):
            await r.update_artifact_message_id("art-x", uuid4())

    async def test_no_match_returns_empty(self, repo):
        r, gw = repo
        gw.update.side_effect = [[], ValueError()]
        gw.update_like.return_value = []
        result = await r.update_artifact_message_id("art-x", uuid4())
        assert result == []


# ===========================================================================
# get_artifact_source
# ===========================================================================

class TestGetArtifactSource:

    async def test_found_with_message(self, repo):
        r, gw = repo
        gw.select.side_effect = [
            [SAMPLE_ARTIFACT],   # get_artifact
            [SAMPLE_MESSAGE],    # get_message
        ]
        result = await r.get_artifact_source(ART_ID)
        assert result is not None
        assert result.content == "Hello"

    async def test_artifact_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_artifact_source(uuid4())
        assert result is None

    async def test_artifact_no_message_id(self, repo):
        r, gw = repo
        art_no_msg = {**SAMPLE_ARTIFACT, "message_id": None}
        gw.select.return_value = [art_no_msg]
        result = await r.get_artifact_source(ART_ID)
        assert result is None

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("DB error")
        with pytest.raises(Exception, match="DB error"):
            await r.get_artifact_source(uuid4())


# ===========================================================================
# _update_artifacts_by_prefix
# ===========================================================================

class TestUpdateArtifactsByPrefix:

    async def test_success(self, repo):
        r, gw = repo
        gw.update_like.return_value = [SAMPLE_ARTIFACT]
        result = await r._update_artifacts_by_prefix("prefix-123", {"message_id": str(MSG_ID)})
        assert len(result) == 1

    async def test_not_found_returns_empty(self, repo):
        r, gw = repo
        gw.update_like.side_effect = ValueError("no match")
        result = await r._update_artifacts_by_prefix("prefix-x", {"message_id": str(MSG_ID)})
        assert result == []

    async def test_pattern_format(self, repo):
        r, gw = repo
        gw.update_like.return_value = []
        await r._update_artifacts_by_prefix("my-id", {"x": 1})
        call_args = gw.update_like.call_args
        assert call_args[0][2] == "my-id%"


# ===========================================================================
# Artifact CRUD — additional error & node_id paths
# ===========================================================================

class TestArtifactCRUDExtra:

    async def test_create_artifact_with_node_id(self, repo):
        r, gw = repo
        nid = uuid4()
        gw.upsert.return_value = [{**SAMPLE_ARTIFACT, "node_id": str(nid)}]
        with patch("data.database.repositories.trail.TrailRepository") as MockTrailRepo:
            mock_trail = MagicMock()
            mock_trail.update_node = AsyncMock()
            MockTrailRepo.return_value = mock_trail

            art = await r.create_artifact(
                CHAT_ID, "code", "content",
                artifact_id="art-n1", node_id=nid,
            )
            assert art is not None
            mock_trail.update_node.assert_called_once()

    async def test_create_artifact_node_update_fails_gracefully(self, repo):
        r, gw = repo
        nid = uuid4()
        gw.upsert.return_value = [{**SAMPLE_ARTIFACT, "node_id": str(nid)}]
        with patch("data.database.repositories.trail.TrailRepository") as MockTrailRepo:
            mock_trail = MagicMock()
            mock_trail.update_node = AsyncMock(side_effect=Exception("node fail"))
            MockTrailRepo.return_value = mock_trail

            art = await r.create_artifact(
                CHAT_ID, "code", "content",
                artifact_id="art-n2", node_id=nid,
            )
            # Should succeed despite node update failure
            assert art is not None

    async def test_create_artifact_error_propagates(self, repo):
        r, gw = repo
        gw.upsert.side_effect = Exception("Upsert fail")
        with pytest.raises(Exception, match="Upsert fail"):
            await r.create_artifact(CHAT_ID, "code", "x", artifact_id="a1")

    async def test_get_artifact_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Select fail")
        with pytest.raises(Exception, match="Select fail"):
            await r.get_artifact(uuid4())

    async def test_get_artifacts_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Select fail")
        with pytest.raises(Exception, match="Select fail"):
            await r.get_artifacts(uuid4())

    async def test_update_artifact_with_all_fields(self, repo):
        r, gw = repo
        updated = {**SAMPLE_ARTIFACT, "content": "new", "filename": "f.py", "language": "go"}
        gw.update.return_value = [updated]
        art = await r.update_artifact(
            ART_ID, content="new", filename="f.py", language="go",
            metadata={"key": "val"},
        )
        assert art.content == "new"

    async def test_update_artifact_value_error_returns_none(self, repo):
        r, gw = repo
        gw.update.side_effect = ValueError("not found")
        result = await r.update_artifact(ART_ID, content="x")
        assert result is None

    async def test_update_artifact_other_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("DB error")
        with pytest.raises(Exception, match="DB error"):
            await r.update_artifact(ART_ID, content="x")

    async def test_delete_artifact_error_propagates(self, repo):
        r, gw = repo
        gw.delete.side_effect = Exception("Delete fail")
        with pytest.raises(Exception, match="Delete fail"):
            await r.delete_artifact(uuid4())

    async def test_get_message_artifacts_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        with pytest.raises(Exception, match="Error"):
            await r.get_message_artifacts(uuid4())


# ===========================================================================
# delete_message — additional paths
# ===========================================================================

class TestDeleteMessageExtra:

    async def test_cascade_artifact_delete_error_continues(self, repo):
        """Artifact delete failure should not prevent message deletion."""
        r, gw = repo
        art_id = str(uuid4())
        gw.select.return_value = [{"id": art_id}]
        gw.delete.side_effect = [
            Exception("artifact delete fail"),  # artifact delete
            None,                               # message delete
        ]
        result = await r.delete_message(MSG_ID, cascade_artifacts=True)
        assert result is True

    async def test_delete_message_error_propagates(self, repo):
        r, gw = repo
        gw.delete.side_effect = Exception("Message delete fail")
        with pytest.raises(Exception, match="Message delete fail"):
            await r.delete_message(MSG_ID, cascade_artifacts=False)


# ===========================================================================
# delete_message_group
# ===========================================================================

class TestDeleteMessageGroup:

    async def test_happy_path_with_assistant(self, repo):
        r, gw = repo
        user_msg = {**SAMPLE_MESSAGE, "id": str(uuid4()), "role": "user", "sequence_in_chat": 1}
        asst_msg = {**SAMPLE_MESSAGE, "id": str(uuid4()), "role": "assistant", "sequence_in_chat": 2}
        user_msg_id = UUID(user_msg["id"])

        gw.select.side_effect = [
            [user_msg],                   # get_message
            [user_msg, asst_msg],         # get_messages (all messages)
            [],                           # artifacts for user msg
            [],                           # cascade artifacts for user msg delete
            [],                           # artifacts for asst msg
            [],                           # cascade artifacts for asst msg delete
        ]
        gw.delete.return_value = None

        result = await r.delete_message_group(user_msg_id)
        assert result["deleted_messages"] == 2
        assert result["assistant_message_id"] == asst_msg["id"]

    async def test_user_message_without_assistant(self, repo):
        r, gw = repo
        user_msg = {**SAMPLE_MESSAGE, "id": str(uuid4()), "role": "user", "sequence_in_chat": 1}
        user_msg_id = UUID(user_msg["id"])

        gw.select.side_effect = [
            [user_msg],           # get_message
            [user_msg],           # get_messages (only user msg)
            [],                   # artifacts for user msg
            [],                   # cascade artifacts
        ]
        gw.delete.return_value = None

        result = await r.delete_message_group(user_msg_id)
        assert result["deleted_messages"] == 1
        assert result["assistant_message_id"] is None

    async def test_message_not_found_raises(self, repo):
        r, gw = repo
        gw.select.return_value = []
        with pytest.raises(ValueError, match="not found"):
            await r.delete_message_group(uuid4())

    async def test_non_user_message_raises(self, repo):
        r, gw = repo
        asst_msg = {**SAMPLE_MESSAGE, "role": "assistant"}
        gw.select.return_value = [asst_msg]
        with pytest.raises(ValueError, match="not a user message"):
            await r.delete_message_group(MSG_ID)

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("DB error")
        with pytest.raises(Exception, match="DB error"):
            await r.delete_message_group(uuid4())


# ===========================================================================
# get_chat_statistics — fallback path
# ===========================================================================

class TestChatStatisticsExtra:

    async def test_group_count_fails_fallback_to_count(self, repo):
        r, gw = repo
        gw.group_count.side_effect = Exception("group count fail")
        gw.count.side_effect = [10, 5]  # messages, artifacts
        stats = await r.get_chat_statistics(CHAT_ID)
        assert stats["message_count"] == 10
        assert stats["artifact_count"] == 5

    async def test_both_group_count_and_count_fail(self, repo):
        r, gw = repo
        gw.group_count.side_effect = Exception("fail")
        gw.count.side_effect = Exception("also fail")
        stats = await r.get_chat_statistics(CHAT_ID)
        assert stats["message_count"] == 0
        assert stats["artifact_count"] == 0


# ===========================================================================
# get_chat_statistics_bulk — additional paths
# ===========================================================================

class TestChatStatisticsBulkExtra:

    async def test_rows_without_chat_id_skipped(self, repo):
        r, gw = repo
        gw.group_count.side_effect = [
            [{"message_count": 3}],   # no chat_id key
            [{"artifact_count": 1}],  # no chat_id key
        ]
        result = await r.get_chat_statistics_bulk([CHAT_ID])
        cid = str(CHAT_ID)
        assert result[cid]["message_count"] == 0
        assert result[cid]["artifact_count"] == 0

    async def test_group_count_fails_fallback_to_per_chat_count(self, repo):
        r, gw = repo
        gw.group_count.side_effect = Exception("group fail")
        gw.count.side_effect = [7, 3]  # messages, artifacts
        result = await r.get_chat_statistics_bulk([CHAT_ID])
        cid = str(CHAT_ID)
        assert result[cid]["message_count"] == 7
        assert result[cid]["artifact_count"] == 3

    async def test_fallback_count_also_fails(self, repo):
        r, gw = repo
        gw.group_count.side_effect = Exception("fail")
        gw.count.side_effect = Exception("also fail")
        result = await r.get_chat_statistics_bulk([CHAT_ID])
        cid = str(CHAT_ID)
        assert result[cid]["message_count"] == 0


# ===========================================================================
# Chat References — additional paths
# ===========================================================================

class TestChatReferencesExtra:

    async def test_create_reference_error_propagates(self, repo):
        r, gw = repo
        gw.insert.side_effect = Exception("Insert fail")
        with pytest.raises(Exception, match="Insert fail"):
            await r.create_chat_reference(uuid4(), uuid4())

    async def test_get_reference_error_returns_none(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        result = await r.get_chat_reference(uuid4())
        assert result is None

    async def test_get_reference_by_chats_found(self, repo):
        r, gw = repo
        ref = {"id": str(uuid4()), "source_chat_id": str(CHAT_ID)}
        gw.select.return_value = [ref]
        result = await r.get_chat_reference_by_chats(CHAT_ID, uuid4())
        assert result == ref

    async def test_get_reference_by_chats_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_chat_reference_by_chats(CHAT_ID, uuid4())
        assert result is None

    async def test_get_reference_by_chats_error(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        result = await r.get_chat_reference_by_chats(CHAT_ID, uuid4())
        assert result is None

    async def test_list_references_target_direction(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": str(uuid4())}]
        result = await r.list_chat_references(CHAT_ID, direction="target")
        assert len(result) == 1

    async def test_list_references_error_returns_empty(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        result = await r.list_chat_references(CHAT_ID)
        assert result == []

    async def test_delete_reference_error_returns_false(self, repo):
        r, gw = repo
        gw.delete.side_effect = Exception("Error")
        result = await r.delete_chat_reference(uuid4())
        assert result is False


# ===========================================================================
# Chat Summaries — create, error paths
# ===========================================================================

class TestChatSummariesExtra:

    async def test_create_summary_new(self, repo):
        r, gw = repo
        gw.select.return_value = []  # get_chat_summary → not found
        new_summary = {"id": str(uuid4()), "summary_text": "New"}
        gw.insert.return_value = [new_summary]
        result = await r.create_chat_summary(
            CHAT_ID, "full", "Title", "Summary text",
            key_points=["p1"], entities={"e": 1}, llm_model="gpt-4",
        )
        assert result == new_summary

    async def test_create_summary_update_existing(self, repo):
        r, gw = repo
        existing = {"id": str(uuid4()), "summary_text": "Old"}
        gw.select.return_value = [existing]  # get_chat_summary → found
        updated = {**existing, "summary_text": "Updated"}
        gw.update.return_value = [updated]
        result = await r.create_chat_summary(
            CHAT_ID, "full", "Title", "Updated",
            key_points=[], entities={}, llm_model="gpt-4",
        )
        assert result == updated

    async def test_create_summary_insert_error_propagates(self, repo):
        r, gw = repo
        gw.select.return_value = []  # get_chat_summary returns None (no existing)
        gw.insert.side_effect = Exception("Insert fail")
        with pytest.raises(Exception, match="Insert fail"):
            await r.create_chat_summary(
                CHAT_ID, "full", "T", "S",
                key_points=[], entities={}, llm_model=None,
            )

    async def test_get_summary_error_returns_none(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        result = await r.get_chat_summary(CHAT_ID)
        assert result is None

    async def test_list_summaries_with_type_filter(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.list_chat_summaries(CHAT_ID, summary_type="full")
        assert result == []

    async def test_list_summaries_no_filters(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.list_chat_summaries()
        assert result == []

    async def test_list_summaries_error_returns_empty(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        result = await r.list_chat_summaries(CHAT_ID)
        assert result == []

    async def test_search_summaries_error_returns_empty(self, repo):
        r, gw = repo
        gw.text_search.side_effect = Exception("Search fail")
        result = await r.search_chat_summaries("query")
        assert result == []
