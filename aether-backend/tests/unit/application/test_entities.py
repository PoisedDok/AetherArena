"""
Tests for application/chat/entities.py

Covers: ChatSummary.from_model(), ChatSummary.to_dict(),
        ChatMessage.from_model(), ChatArtifact.from_model()

Missing lines: 82 (ChatSummary.from_model return), 93 (to_dict return),
               118 (ChatMessage.from_model return), 152 (ChatArtifact.from_model return)
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock
from uuid import uuid4

from application.chat.entities import ChatArtifact, ChatMessage, ChatSummary


NOW = datetime.now(timezone.utc)
CHAT_ID = uuid4()
MSG_ID = uuid4()
ART_ID = uuid4()
CORRELATION_ID = uuid4()
SUBGROUP_ID = uuid4()
NODE_ID = uuid4()


# ======================================================================
# ChatSummary
# ======================================================================


class TestChatSummary:

    def test_from_model_defaults(self):
        """Line 82: from_model with no overrides uses model fields."""
        model = MagicMock()
        model.id = CHAT_ID
        model.title = "Test Chat"
        model.created_at = NOW
        model.updated_at = NOW
        model.message_count = 5
        model.last_message_at = NOW

        summary = ChatSummary.from_model(model)

        assert summary.id == CHAT_ID
        assert summary.title == "Test Chat"
        assert summary.created_at == NOW
        assert summary.updated_at == NOW
        assert summary.message_count == 5
        assert summary.last_message_at == NOW

    def test_from_model_with_overrides(self):
        """from_model with explicit message_count and last_message_at overrides model values."""
        model = MagicMock()
        model.id = CHAT_ID
        model.title = "Chat"
        model.created_at = NOW
        model.updated_at = NOW
        model.message_count = 5
        model.last_message_at = NOW

        override_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
        summary = ChatSummary.from_model(model, message_count=99, last_message_at=override_time)

        assert summary.message_count == 99
        assert summary.last_message_at == override_time

    def test_from_model_none_message_count_fallback(self):
        """When model.message_count is None and no override, defaults to 0."""
        model = MagicMock()
        model.id = CHAT_ID
        model.title = "Chat"
        model.created_at = NOW
        model.updated_at = NOW
        model.message_count = None
        model.last_message_at = None

        summary = ChatSummary.from_model(model)

        assert summary.message_count == 0
        assert summary.last_message_at is None

    def test_to_dict(self):
        """Line 93: to_dict returns correct serializable dict."""
        summary = ChatSummary(
            id=CHAT_ID,
            title="Test",
            created_at=NOW,
            updated_at=NOW,
            message_count=3,
            last_message_at=NOW,
        )

        d = summary.to_dict()

        assert d["id"] == CHAT_ID
        assert d["title"] == "Test"
        assert d["created_at"] == NOW
        assert d["updated_at"] == NOW
        assert d["message_count"] == 3
        assert d["last_message_at"] == NOW
        assert d["description"] is None
        assert d["metadata"] is None
        assert d["archived"] is False
        assert len(d) == 9  # Exact keys, no extras

    def test_to_dict_none_last_message(self):
        """to_dict with last_message_at=None."""
        summary = ChatSummary(
            id=CHAT_ID, title="X", created_at=NOW, updated_at=NOW,
        )

        d = summary.to_dict()
        assert d["last_message_at"] is None
        assert d["message_count"] == 0


# ======================================================================
# ChatMessage
# ======================================================================


class TestChatMessage:

    def test_from_model(self):
        """Line 118: from_model maps all fields correctly."""
        model = MagicMock()
        model.id = MSG_ID
        model.chat_id = CHAT_ID
        model.role = "user"
        model.content = "Hello"
        model.created_at = NOW
        model.tokens_used = 42
        model.correlation_id = CORRELATION_ID

        msg = ChatMessage.from_model(model)

        assert msg.id == MSG_ID
        assert msg.chat_id == CHAT_ID
        assert msg.role == "user"
        assert msg.content == "Hello"
        assert msg.created_at == NOW
        assert msg.token_count == 42
        assert msg.parent_message_id == CORRELATION_ID
        assert msg.metadata is None

    def test_from_model_none_optional_fields(self):
        """from_model with None optional fields."""
        model = MagicMock()
        model.id = MSG_ID
        model.chat_id = CHAT_ID
        model.role = "assistant"
        model.content = "Hi"
        model.created_at = NOW
        model.tokens_used = None
        model.correlation_id = None

        msg = ChatMessage.from_model(model)

        assert msg.token_count is None
        assert msg.parent_message_id is None


# ======================================================================
# ChatArtifact
# ======================================================================


class TestChatArtifact:

    def test_from_model(self):
        """Line 152: from_model maps all fields including trail linkage."""
        model = MagicMock()
        model.id = ART_ID
        model.chat_id = CHAT_ID
        model.message_id = MSG_ID
        model.artifact_id = "dedup-123"
        model.type = "code"
        model.filename = "test.py"
        model.content = "print('hi')"
        model.language = "python"
        model.created_at = NOW
        model.metadata = {"key": "value"}
        model.subgroup_id = SUBGROUP_ID
        model.node_id = NODE_ID
        model.execution_group = "exec-group-1"

        art = ChatArtifact.from_model(model)

        assert art.id == ART_ID
        assert art.chat_id == CHAT_ID
        assert art.message_id == MSG_ID
        assert art.artifact_id == "dedup-123"
        assert art.type == "code"
        assert art.filename == "test.py"
        assert art.content == "print('hi')"
        assert art.language == "python"
        assert art.created_at == NOW
        assert art.metadata == {"key": "value"}
        assert art.subgroup_id == SUBGROUP_ID
        assert art.node_id == NODE_ID
        assert art.execution_group == "exec-group-1"

    def test_from_model_no_execution_group(self):
        """from_model with model lacking execution_group attribute falls back to None."""
        model = MagicMock(spec=[
            "id", "chat_id", "message_id", "artifact_id", "type",
            "filename", "content", "language", "created_at", "metadata",
            "subgroup_id", "node_id",
        ])
        model.id = ART_ID
        model.chat_id = CHAT_ID
        model.message_id = MSG_ID
        model.artifact_id = None
        model.type = "output"
        model.filename = None
        model.content = "result"
        model.language = None
        model.created_at = NOW
        model.metadata = None
        model.subgroup_id = None
        model.node_id = None

        art = ChatArtifact.from_model(model)

        assert art.execution_group is None
        assert art.artifact_id is None
        assert art.filename is None
