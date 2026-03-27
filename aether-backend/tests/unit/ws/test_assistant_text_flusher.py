"""
Unit Tests: AssistantTextFlusher

Application service tests -- mocked ChatRepository.
Tests text accumulation flush, persistence, and parts clearing.
"""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from ws.application.assistant_text_flusher import AssistantTextFlusher
from ws.domain.commands.trail_commands import EmitAssistantMessageFlushed


@pytest.fixture
def mock_chat_repo():
    """Mock ChatRepository with create_message."""
    repo = MagicMock()
    repo.create_message = AsyncMock()
    return repo


@pytest.fixture
def flusher(mock_chat_repo):
    """AssistantTextFlusher with mocked repository."""
    return AssistantTextFlusher(chat_repository=mock_chat_repo)


class TestFlushGuards:
    """Tests for early-return conditions (no-op cases)."""

    @pytest.mark.asyncio
    async def test_returns_none_when_no_repository(self):
        """No chat_repository should return None (no DB calls)."""
        flusher = AssistantTextFlusher(chat_repository=None)
        result = await flusher.flush_if_pending(
            chat_id=str(uuid4()),
            parts=["hello"],
            user_msg_id=uuid4(),
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_parts_empty(self, flusher):
        """Empty parts list should return None."""
        result = await flusher.flush_if_pending(
            chat_id=str(uuid4()),
            parts=[],
            user_msg_id=uuid4(),
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_no_user_msg_id(self, flusher):
        """None user_msg_id should return None (can't link without parent)."""
        result = await flusher.flush_if_pending(
            chat_id=str(uuid4()),
            parts=["hello"],
            user_msg_id=None,
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_parts_only_whitespace(self, flusher):
        """Parts that join to only whitespace should return None."""
        result = await flusher.flush_if_pending(
            chat_id=str(uuid4()),
            parts=["  ", "\n", "\t"],
            user_msg_id=uuid4(),
        )
        assert result is None


class TestFlushBehavior:
    """Tests for the core flush logic."""

    @pytest.mark.asyncio
    async def test_joins_parts_and_persists(self, flusher, mock_chat_repo):
        """Should join all parts into a single string and persist."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        user_msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=5)
        )

        parts = ["Hello ", "world", "!"]
        result = await flusher.flush_if_pending(
            chat_id=chat_id,
            parts=parts,
            user_msg_id=user_msg_id,
        )

        # Verify create_message called with joined content
        call_kwargs = mock_chat_repo.create_message.call_args[1]
        assert call_kwargs["content"] == "Hello world!"
        assert call_kwargs["role"] == "assistant"
        assert call_kwargs["parent_message_id"] == user_msg_id

    @pytest.mark.asyncio
    async def test_clears_parts_after_flush(self, flusher, mock_chat_repo):
        """Should clear the parts list in-place after successful flush."""
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        parts = ["Hello ", "world"]
        await flusher.flush_if_pending(
            chat_id=str(uuid4()),
            parts=parts,
            user_msg_id=uuid4(),
        )

        # Parts list should be empty (cleared in-place)
        assert parts == []

    @pytest.mark.asyncio
    async def test_returns_emit_assistant_message_flushed(self, flusher, mock_chat_repo):
        """Should return EmitAssistantMessageFlushed with correct fields."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=7)
        )

        result = await flusher.flush_if_pending(
            chat_id=chat_id,
            parts=["test content"],
            user_msg_id=uuid4(),
        )

        assert isinstance(result, EmitAssistantMessageFlushed)
        assert result.chat_id == chat_id
        assert result.sequence_in_chat == 7
        assert result.content == "test content"
        assert result.message_id == str(msg_id)

    @pytest.mark.asyncio
    async def test_passes_timestamp_to_create_message(self, flusher, mock_chat_repo):
        """Should pass explicit timestamp when provided."""
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        explicit_ts = datetime(2026, 2, 8, 12, 0, 0, tzinfo=timezone.utc)

        await flusher.flush_if_pending(
            chat_id=str(uuid4()),
            parts=["content"],
            user_msg_id=uuid4(),
            timestamp=explicit_ts,
        )

        call_kwargs = mock_chat_repo.create_message.call_args[1]
        assert call_kwargs["timestamp"] == explicit_ts


class TestErrorHandling:
    """Test graceful error handling."""

    @pytest.mark.asyncio
    async def test_db_errors_return_none(self, flusher, mock_chat_repo):
        """Expected DB errors should return None, not raise."""
        for exc_type in (ConnectionError, TimeoutError, ValueError, KeyError, OSError):
            mock_chat_repo.create_message = AsyncMock(
                side_effect=exc_type("simulated failure")
            )

            result = await flusher.flush_if_pending(
                chat_id=str(uuid4()),
                parts=["content"],
                user_msg_id=uuid4(),
            )

            assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_create_message_returns_none(self, flusher, mock_chat_repo):
        """If create_message returns None (unusual), should return None."""
        mock_chat_repo.create_message = AsyncMock(return_value=None)

        result = await flusher.flush_if_pending(
            chat_id=str(uuid4()),
            parts=["content"],
            user_msg_id=uuid4(),
        )

        assert result is None
