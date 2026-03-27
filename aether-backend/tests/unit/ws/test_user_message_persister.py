"""
Unit Tests: UserMessagePersister

Application service tests -- mocked ChatRepository.
Tests user message persistence, artifact linking, and control event emission.

Bugs found: 0
(Inner _link_pending_artifacts except catches ConnectionError, TimeoutError,
ValueError, KeyError but not OSError. Outer handler catches OSError. Documented
with test_os_error_propagates_to_outer_handler. Not a functional bug — both
handlers log and continue — but an inconsistency.)
"""

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest

from ws.application.user_message_persister import UserMessagePersister
from ws.domain.commands.stream_commands import EmitControlEvent


@pytest.fixture
def mock_chat_repo():
    """Mock ChatRepository with required interface."""
    repo = MagicMock()
    repo.ensure_chat_exists = AsyncMock()
    repo.create_message = AsyncMock()
    repo.get_pending_artifacts = AsyncMock(return_value=[])
    repo.update_artifact_message_id = AsyncMock(return_value=[])
    return repo


@pytest.fixture
def persister(mock_chat_repo):
    """UserMessagePersister with mocked repository."""
    return UserMessagePersister(chat_repository=mock_chat_repo)


class TestPersistUserMessage:
    """Core persistence flow tests."""

    @pytest.mark.asyncio
    async def test_returns_empty_result_when_no_chat_id(self, persister):
        """Empty chat_id should return empty PersistResult (no DB calls)."""
        result = await persister.persist_user_message(
            chat_id="",
            text="hello",
        )
        assert result.user_msg_id is None
        assert result.commands == []

    @pytest.mark.asyncio
    async def test_returns_empty_result_when_no_repository(self):
        """No chat_repository should return empty PersistResult."""
        persister = UserMessagePersister(chat_repository=None)
        result = await persister.persist_user_message(
            chat_id=str(uuid4()),
            text="hello",
        )
        assert result.user_msg_id is None
        assert result.commands == []

    @pytest.mark.asyncio
    async def test_persists_message_with_correct_content(self, persister, mock_chat_repo):
        """Should persist original_text (not enriched text) when provided."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="enriched text with artifact context",
            original_text="original user text",
        )

        assert result.user_msg_id == msg_id
        # Verify create_message was called with original_text, not enriched text
        call_kwargs = mock_chat_repo.create_message.call_args[1]
        assert call_kwargs["content"] == "original user text"
        assert call_kwargs["role"] == "user"

    @pytest.mark.asyncio
    async def test_uses_enriched_text_when_no_original(self, persister, mock_chat_repo):
        """When original_text is None, should use enriched text."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="enriched text",
            original_text=None,
        )

        call_kwargs = mock_chat_repo.create_message.call_args[1]
        assert call_kwargs["content"] == "enriched text"

    @pytest.mark.asyncio
    async def test_persists_metadata_when_provided(self, persister, mock_chat_repo):
        """Hidden metadata must be persisted with the user message."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        hidden_metadata = {
            "source": "proactive",
            "context": {"doc_research": [{"query": "q1"}]},
        }
        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            metadata=hidden_metadata,
        )

        call_kwargs = mock_chat_repo.create_message.call_args[1]
        assert call_kwargs["metadata"] == hidden_metadata

    @pytest.mark.asyncio
    async def test_normalizes_non_dict_metadata_to_empty_dict(self, persister, mock_chat_repo):
        """Non-dict metadata input should never leak through persistence calls."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            metadata="not-a-dict",
        )

        call_kwargs = mock_chat_repo.create_message.call_args[1]
        assert call_kwargs["metadata"] == {}

    @pytest.mark.asyncio
    async def test_ensures_chat_exists_before_message(self, persister, mock_chat_repo):
        """Must call ensure_chat_exists before create_message."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        call_order = []

        async def track_ensure(*args, **kwargs):
            call_order.append("ensure_chat")

        async def track_create(*args, **kwargs):
            call_order.append("create_message")
            return SimpleNamespace(id=msg_id, sequence_in_chat=1)

        mock_chat_repo.ensure_chat_exists = track_ensure
        mock_chat_repo.create_message = track_create

        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
        )

        assert call_order == ["ensure_chat", "create_message"]


class TestCorrelationIdAsUuid:
    """Test correlation_id → message UUID mapping."""

    @pytest.mark.asyncio
    async def test_uses_valid_correlation_id_as_message_uuid(self, persister, mock_chat_repo):
        """Valid UUID correlation_id should be passed as message_id."""
        chat_id = str(uuid4())
        corr_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id=corr_id,
        )

        call_kwargs = mock_chat_repo.create_message.call_args[1]
        assert call_kwargs["message_id"] == UUID(corr_id)

    @pytest.mark.asyncio
    async def test_ignores_invalid_correlation_id(self, persister, mock_chat_repo):
        """Invalid UUID correlation_id should NOT crash; message_id should be None."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id="not-a-uuid",
        )

        call_kwargs = mock_chat_repo.create_message.call_args[1]
        assert call_kwargs["message_id"] is None


class TestControlEventEmission:
    """Test EmitControlEvent generation."""

    @pytest.mark.asyncio
    async def test_emits_user_message_persisted_control_event(self, persister, mock_chat_repo):
        """Should emit EmitControlEvent with user.message_persisted type."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=3)
        )

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id="corr-abc",
        )

        assert len(result.commands) == 1
        cmd = result.commands[0]
        assert isinstance(cmd, EmitControlEvent)
        assert cmd.event["type"] == "user.message_persisted"
        assert cmd.event["message_id"] == str(msg_id)
        assert cmd.event["correlation_id"] == "corr-abc"
        assert cmd.event["chat_id"] == chat_id
        assert cmd.event["sequence_in_chat"] == 3

    @pytest.mark.asyncio
    async def test_handsfree_flag_in_control_event(self, persister, mock_chat_repo):
        """Control event should have is_handsfree=True for handsfree correlation IDs."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id="handsfree-abc123",
        )

        cmd = result.commands[0]
        assert cmd.event["is_handsfree"] is True


class TestErrorHandling:
    """Test graceful error handling for expected DB/network errors."""

    @pytest.mark.asyncio
    async def test_db_errors_return_empty_result(self, persister, mock_chat_repo):
        """Expected DB errors should return empty PersistResult, not raise."""
        for exc_type in (ConnectionError, TimeoutError, ValueError, KeyError, OSError):
            mock_chat_repo.ensure_chat_exists = AsyncMock(
                side_effect=exc_type("simulated failure")
            )

            result = await persister.persist_user_message(
                chat_id=str(uuid4()),
                text="hello",
            )

            assert result.user_msg_id is None
            assert result.commands == []

    @pytest.mark.asyncio
    async def test_artifact_link_error_does_not_break_persistence(self, persister, mock_chat_repo):
        """Artifact linking failure should NOT prevent message persistence result."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(
            side_effect=ConnectionError("DB down")
        )

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
        )

        # Message persisted successfully despite artifact link failure
        assert result.user_msg_id == msg_id
        assert len(result.commands) == 1


# ---------------------------------------------------------------------------
# Artifact linking logic (_link_pending_artifacts, lines 206-254)
# ---------------------------------------------------------------------------

def _recent_iso() -> str:
    """Return an ISO 8601 timestamp from 10 seconds ago (within 60s cutoff)."""
    return (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()


def _old_iso() -> str:
    """Return an ISO 8601 timestamp from 120 seconds ago (outside 60s cutoff)."""
    return (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()


class TestLinkPendingArtifacts:
    """Tests for _link_pending_artifacts artifact matching and linking."""

    @pytest.mark.asyncio
    async def test_links_artifacts_by_correlation_id(self, persister, mock_chat_repo):
        """Artifacts matching correlation_id in metadata are linked."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        corr_id = str(uuid4())
        art_id = str(uuid4())

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[
            {
                "id": art_id,
                "created_at": _recent_iso(),
                "metadata": {"correlation_id": corr_id},
            },
        ])

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id=corr_id,
        )

        assert result.user_msg_id == msg_id
        mock_chat_repo.update_artifact_message_id.assert_awaited_once_with(
            artifact_id=art_id,
            message_id=msg_id,
        )

    @pytest.mark.asyncio
    async def test_falls_back_to_time_window(self, persister, mock_chat_repo):
        """When no correlation_id match, recent artifacts matched by time window."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        art_id = str(uuid4())

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[
            {
                "id": art_id,
                "created_at": _recent_iso(),
                "metadata": {},
            },
        ])

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id="unmatched-corr-id",
        )

        assert result.user_msg_id == msg_id
        mock_chat_repo.update_artifact_message_id.assert_awaited_once_with(
            artifact_id=art_id,
            message_id=msg_id,
        )

    @pytest.mark.asyncio
    async def test_no_correlation_id_uses_time_window(self, persister, mock_chat_repo):
        """When correlation_id is None, time-window matching is used."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        art_id = str(uuid4())

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[
            {
                "id": art_id,
                "created_at": _recent_iso(),
                "metadata": {},
            },
        ])

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id=None,
        )

        assert result.user_msg_id == msg_id
        mock_chat_repo.update_artifact_message_id.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_old_artifacts_not_linked(self, persister, mock_chat_repo):
        """Artifacts older than 60s cutoff are not linked."""
        chat_id = str(uuid4())
        msg_id = uuid4()

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[
            {
                "id": str(uuid4()),
                "created_at": _old_iso(),
                "metadata": {},
            },
        ])

        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
        )

        mock_chat_repo.update_artifact_message_id.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_pending_artifacts(self, persister, mock_chat_repo):
        """No pending artifacts → no linking attempted."""
        chat_id = str(uuid4())
        msg_id = uuid4()

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[])

        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
        )

        mock_chat_repo.update_artifact_message_id.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_metadata_string_parsed_as_json(self, persister, mock_chat_repo):
        """Metadata stored as JSON string is parsed correctly."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        corr_id = str(uuid4())
        art_id = str(uuid4())

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[
            {
                "id": art_id,
                "created_at": _recent_iso(),
                "metadata": json.dumps({"correlation_id": corr_id}),
            },
        ])

        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id=corr_id,
        )

        mock_chat_repo.update_artifact_message_id.assert_awaited_once_with(
            artifact_id=art_id,
            message_id=msg_id,
        )

    @pytest.mark.asyncio
    async def test_invalid_metadata_json_falls_back(self, persister, mock_chat_repo):
        """Invalid JSON metadata doesn't crash; falls back to time window."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        art_id = str(uuid4())

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[
            {
                "id": art_id,
                "created_at": _recent_iso(),
                "metadata": "{invalid json",
            },
        ])

        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id="some-corr-id",
        )

        # Falls back to time window and links the recent artifact
        mock_chat_repo.update_artifact_message_id.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_multiple_artifacts_all_linked(self, persister, mock_chat_repo):
        """All matching artifacts are linked, not just the first."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        art_ids = [str(uuid4()) for _ in range(3)]

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[
            {"id": aid, "created_at": _recent_iso(), "metadata": {}}
            for aid in art_ids
        ])

        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
        )

        assert mock_chat_repo.update_artifact_message_id.await_count == 3
        linked_ids = [
            call.kwargs["artifact_id"]
            for call in mock_chat_repo.update_artifact_message_id.call_args_list
        ]
        for aid in art_ids:
            assert aid in linked_ids

    @pytest.mark.asyncio
    async def test_none_metadata_handled(self, persister, mock_chat_repo):
        """artifact_row with metadata=None doesn't crash correlation matching."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        art_id = str(uuid4())

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[
            {
                "id": art_id,
                "created_at": _recent_iso(),
                "metadata": None,
            },
        ])

        # Should not raise; falls back to time window
        await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id="some-corr",
        )

        mock_chat_repo.update_artifact_message_id.assert_awaited_once()


# ---------------------------------------------------------------------------
# Defensive guards and error propagation
# ---------------------------------------------------------------------------

class TestLinkPendingArtifactsDefensiveGuards:
    """Tests for _link_pending_artifacts defensive paths."""

    @pytest.mark.asyncio
    async def test_no_repository_returns_early(self):
        """_link_pending_artifacts returns immediately if no repository."""
        persister = UserMessagePersister(chat_repository=None)
        # Direct call — this path is unreachable via public API
        await persister._link_pending_artifacts(
            chat_id=uuid4(),
            message_id=uuid4(),
        )
        # No exception, no crash

    @pytest.mark.asyncio
    async def test_os_error_propagates_to_outer_handler(self, persister, mock_chat_repo):
        """OSError from artifact linking bypasses inner handler, caught by outer."""
        chat_id = str(uuid4())
        msg_id = uuid4()

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[
            {"id": str(uuid4()), "created_at": _recent_iso(), "metadata": {}},
        ])
        mock_chat_repo.update_artifact_message_id = AsyncMock(
            side_effect=OSError("disk full")
        )

        # Should NOT raise — outer handler catches OSError
        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
        )

        # Message was persisted before artifact linking failed
        assert result.user_msg_id == msg_id
        assert len(result.commands) == 1

    @pytest.mark.asyncio
    async def test_inner_value_error_caught_gracefully(self, persister, mock_chat_repo):
        """ValueError inside _link_pending_artifacts caught by inner handler."""
        chat_id = str(uuid4())
        msg_id = uuid4()

        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )
        mock_chat_repo.get_pending_artifacts = AsyncMock(
            side_effect=ValueError("bad data")
        )

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
        )

        # Message still persisted, artifact linking failed silently
        assert result.user_msg_id == msg_id


# ---------------------------------------------------------------------------
# Handsfree flag edge cases
# ---------------------------------------------------------------------------

class TestHandsfreeEdgeCases:
    """Extended handsfree flag tests."""

    @pytest.mark.asyncio
    async def test_non_handsfree_correlation_id(self, persister, mock_chat_repo):
        """Regular correlation_id → is_handsfree=False."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id="regular-corr-id",
        )

        cmd = result.commands[0]
        assert cmd.event["is_handsfree"] is False

    @pytest.mark.asyncio
    async def test_none_correlation_id_handsfree_false(self, persister, mock_chat_repo):
        """None correlation_id → is_handsfree=False."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="hello",
            correlation_id=None,
        )

        cmd = result.commands[0]
        assert cmd.event["is_handsfree"] is False

    @pytest.mark.asyncio
    async def test_control_event_contains_content(self, persister, mock_chat_repo):
        """Control event includes persist_content, not enriched text."""
        chat_id = str(uuid4())
        msg_id = uuid4()
        mock_chat_repo.create_message = AsyncMock(
            return_value=SimpleNamespace(id=msg_id, sequence_in_chat=1)
        )

        result = await persister.persist_user_message(
            chat_id=chat_id,
            text="enriched with artifact",
            original_text="original input",
        )

        cmd = result.commands[0]
        assert cmd.event["content"] == "original input"
        assert cmd.event["role"] == "user"
