"""
Tests for data/database/repositories/storage.py

Covers: get_all_artifacts, get_storage_statistics, traceability save/load,
trail state save/load/delete.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import data.database.repositories.storage as storage_module
from data.database.repositories.storage import StorageRepository
from data.database.persistence_gateway import SupabasePersistenceGateway


def _make_gateway():
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.select = AsyncMock(return_value=[])
    gw.insert = AsyncMock(return_value=[{}])
    gw.upsert = AsyncMock(return_value=[{}])
    gw.delete = AsyncMock()
    gw.count = AsyncMock(return_value=0)
    return gw


@pytest.fixture(autouse=True)
def reset_schema_flag():
    """Reset _SCHEMA_VALIDATED global so _ensure_schema runs."""
    storage_module._SCHEMA_VALIDATED = False
    yield
    storage_module._SCHEMA_VALIDATED = False


@pytest.fixture
def repo():
    gw = _make_gateway()
    return StorageRepository(db=gw), gw


class TestGetAllArtifacts:
    @pytest.mark.asyncio
    async def test_empty(self, repo):
        r, gw = repo
        result = await r.get_all_artifacts()
        assert result == []

    @pytest.mark.asyncio
    async def test_with_data(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": str(uuid4()), "type": "code"}]
        result = await r.get_all_artifacts()
        assert len(result) == 1


class TestStorageStatistics:
    @pytest.mark.asyncio
    async def test_statistics(self, repo):
        r, gw = repo
        # gather calls: chats, messages, artifacts, then code_count, output_count
        gw.count.side_effect = [5, 10, 3, 2, 1]
        gw.select.return_value = []  # last_artifact query
        result = await r.get_storage_statistics()
        assert isinstance(result, dict)
        assert result["total_chats"] == 5
        assert result["total_messages"] == 10


class TestTraceability:
    @pytest.mark.asyncio
    async def test_save_traceability_empty(self, repo):
        """Save with no chat IDs in data skips persistence."""
        r, gw = repo
        await r.save_traceability_data({})
        # No upsert called because no chat IDs extracted
        gw.upsert.assert_not_called()

    @pytest.mark.asyncio
    async def test_save_traceability_with_data(self, repo):
        """Save with valid chat data calls upsert."""
        r, gw = repo
        chat_id = str(uuid4())
        await r.save_traceability_data({
            "chatMessagesIndex": [(chat_id, ["m1"])],
            "chatArtifactsIndex": [(chat_id, [])],
            "messages": [("m1", {"chatId": chat_id, "role": "user"})],
            "artifacts": [],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "correlationIndex": [],
        })
        gw.upsert.assert_called()

    @pytest.mark.asyncio
    async def test_load_traceability_found(self, repo):
        r, gw = repo
        chat_id = str(uuid4())
        gw.select.return_value = [{"id": chat_id, "data": {"messages": {}}}]
        result = await r.load_traceability_data(chat_id)
        assert result is not None
        assert "messages" in result

    @pytest.mark.asyncio
    async def test_load_traceability_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.load_traceability_data(str(uuid4()))
        assert result is None


class TestTrailState:
    @pytest.mark.asyncio
    async def test_save_trail_state(self, repo):
        r, gw = repo
        await r.save_trail_state(str(uuid4()), {"groups": []})
        gw.upsert.assert_called()

    @pytest.mark.asyncio
    async def test_load_trail_state_found(self, repo):
        r, gw = repo
        # First select call is _ensure_schema, second is the actual load
        gw.select.side_effect = [
            [],  # _ensure_schema validation
            [{"data": {"groups": []}}],  # actual load
        ]
        result = await r.load_trail_state(str(uuid4()))
        assert result is not None
        assert "groups" in result

    @pytest.mark.asyncio
    async def test_load_trail_state_not_found(self, repo):
        r, gw = repo
        gw.select.side_effect = [[], []]  # schema check then empty result
        result = await r.load_trail_state(str(uuid4()))
        assert result is None

    @pytest.mark.asyncio
    async def test_delete_trail_state(self, repo):
        r, gw = repo
        gw.select.return_value = []  # _ensure_schema
        result = await r.delete_trail_state(str(uuid4()))
        assert isinstance(result, bool)


# =========================================================================
# Constructor error paths (lines 51, 56, 61-64)
# =========================================================================

class TestConstructorErrors:
    def test_session_raises_runtime_error(self):
        """SQLAlchemy session → RuntimeError."""
        with pytest.raises(RuntimeError, match="SQLAlchemy sessions are no longer supported"):
            StorageRepository(db=None, session=MagicMock())

    def test_none_db_raises_value_error(self):
        """db=None → ValueError."""
        with pytest.raises(ValueError, match="SupabasePersistenceGateway.*instance required"):
            StorageRepository(db=None)

    def test_wrong_type_raises_type_error(self):
        """Wrong db type → TypeError."""
        with pytest.raises(TypeError, match="Unsupported database adapter"):
            StorageRepository(db="not_a_gateway")


# =========================================================================
# get_all_artifacts with type filter and error (lines 94, 107-109)
# =========================================================================

class TestGetAllArtifactsExtended:
    @pytest.mark.asyncio
    async def test_with_type_filter(self, repo):
        """artifact_type filter is passed to select."""
        r, gw = repo
        gw.select.return_value = [{"id": "a1", "type": "code"}]
        result = await r.get_all_artifacts(artifact_type="code")
        assert len(result) == 1
        call_kwargs = gw.select.call_args
        assert call_kwargs[1]["filters"] == {"type": "code"}

    @pytest.mark.asyncio
    async def test_error_propagates(self, repo):
        """Gateway error → exception re-raised."""
        r, gw = repo
        gw.select.side_effect = RuntimeError("DB down")
        with pytest.raises(RuntimeError, match="DB down"):
            await r.get_all_artifacts()


# =========================================================================
# get_storage_statistics error path (lines 156-158)
# =========================================================================

class TestStorageStatisticsError:
    @pytest.mark.asyncio
    async def test_stats_error_propagates(self, repo):
        """Gateway count error → exception re-raised."""
        r, gw = repo
        gw.count.side_effect = RuntimeError("count failed")
        with pytest.raises(RuntimeError, match="count failed"):
            await r.get_storage_statistics()


# =========================================================================
# save_traceability_data: dict entries, correlation index, error (lines 184-209, 265, 309-315, 348-349)
# =========================================================================

class TestTraceabilityExtended:
    @pytest.mark.asyncio
    async def test_dict_message_entries_normalized(self, repo):
        """Messages as dict entries with message_id key → normalized."""
        r, gw = repo
        chat_id = str(uuid4())
        msg_id = str(uuid4())
        await r.save_traceability_data({
            "chatMessagesIndex": [(chat_id, [msg_id])],
            "chatArtifactsIndex": [(chat_id, [])],
            "messages": [{"message_id": msg_id, "chatId": chat_id, "role": "user"}],
            "artifacts": [],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "correlationIndex": [],
        })
        gw.upsert.assert_called()

    @pytest.mark.asyncio
    async def test_dict_artifact_entries_normalized(self, repo):
        """Artifacts as dict entries with artifact_id key → normalized."""
        r, gw = repo
        chat_id = str(uuid4())
        art_id = str(uuid4())
        await r.save_traceability_data({
            "chatMessagesIndex": [(chat_id, [])],
            "chatArtifactsIndex": [(chat_id, [art_id])],
            "messages": [],
            "artifacts": [{"artifact_id": art_id, "chatId": chat_id, "type": "code"}],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "correlationIndex": [],
        })
        gw.upsert.assert_called()

    @pytest.mark.asyncio
    async def test_invalid_entry_skipped(self, repo):
        """Non-dict, non-tuple entry → skipped."""
        r, gw = repo
        chat_id = str(uuid4())
        await r.save_traceability_data({
            "chatMessagesIndex": [(chat_id, ["m1"])],
            "chatArtifactsIndex": [],
            "messages": [42, "bad_entry", ("m1", {"chatId": chat_id})],
            "artifacts": [],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "correlationIndex": [],
        })
        gw.upsert.assert_called()

    @pytest.mark.asyncio
    async def test_correlation_index_filtered(self, repo):
        """Correlation index entries are filtered to matching chat messages."""
        r, gw = repo
        chat_id = str(uuid4())
        msg_id = str(uuid4())
        corr_id = str(uuid4())
        await r.save_traceability_data({
            "chatMessagesIndex": [(chat_id, [msg_id])],
            "chatArtifactsIndex": [(chat_id, [])],
            "messages": [("m1", {"chatId": chat_id}), (msg_id, {"chatId": chat_id})],
            "artifacts": [],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "correlationIndex": [(corr_id, {"requestMessageId": msg_id, "responseMessageId": None})],
        })
        gw.upsert.assert_called()
        # Verify the payload includes correlation index
        call_data = gw.upsert.call_args[0][1]
        assert "correlationIndex" in call_data["data"]

    @pytest.mark.asyncio
    async def test_chat_ids_from_messages(self, repo):
        """Chat IDs extracted from message chatId when index is empty."""
        r, gw = repo
        chat_id = str(uuid4())
        await r.save_traceability_data({
            "chatMessagesIndex": [],
            "chatArtifactsIndex": [],
            "messages": [("m1", {"chatId": chat_id, "role": "user"})],
            "artifacts": [],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "correlationIndex": [],
        })
        gw.upsert.assert_called()

    @pytest.mark.asyncio
    async def test_chat_ids_from_artifacts(self, repo):
        """Chat IDs extracted from artifact chatId when index is empty."""
        r, gw = repo
        chat_id = str(uuid4())
        await r.save_traceability_data({
            "chatMessagesIndex": [],
            "chatArtifactsIndex": [],
            "messages": [],
            "artifacts": [("a1", {"chatId": chat_id, "type": "code"})],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "correlationIndex": [],
        })
        gw.upsert.assert_called()

    @pytest.mark.asyncio
    async def test_save_error_swallowed(self, repo):
        """Gateway error during save → warning logged, no exception."""
        r, gw = repo
        chat_id = str(uuid4())
        gw.upsert.side_effect = RuntimeError("upsert failed")
        # Should not raise
        await r.save_traceability_data({
            "chatMessagesIndex": [(chat_id, ["m1"])],
            "chatArtifactsIndex": [(chat_id, [])],
            "messages": [("m1", {"chatId": chat_id})],
            "artifacts": [],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "correlationIndex": [],
        })

    @pytest.mark.asyncio
    async def test_load_error_returns_none(self, repo):
        """Gateway error during load → returns None."""
        r, gw = repo
        gw.select.side_effect = RuntimeError("select failed")
        result = await r.load_traceability_data(str(uuid4()))
        assert result is None

    @pytest.mark.asyncio
    async def test_dict_entry_no_key_field_skipped(self, repo):
        """Dict entry without any known key field → skipped."""
        r, gw = repo
        chat_id = str(uuid4())
        await r.save_traceability_data({
            "chatMessagesIndex": [(chat_id, [])],
            "chatArtifactsIndex": [],
            "messages": [{"unknown_field": "value", "chatId": chat_id}],
            "artifacts": [],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "correlationIndex": [],
        })
        # Still processes (chat_id came from index), even though message was skipped
        gw.upsert.assert_called()


# =========================================================================
# _ensure_schema error path (lines 397-403)
# =========================================================================

class TestEnsureSchemaError:
    @pytest.mark.asyncio
    async def test_schema_validation_failure(self):
        """Schema check failure → SchemaValidationError."""
        from data.database.repositories.storage import SchemaValidationError
        gw = _make_gateway()
        gw.select.side_effect = RuntimeError("table not found")
        r = StorageRepository(db=gw)
        with pytest.raises(SchemaValidationError, match="Trail state schema missing"):
            await r.save_trail_state("chat-1", {"groups": []})


# =========================================================================
# Trail state error paths (lines 436-441, 465-470, 492-497)
# =========================================================================

class TestTrailStateErrors:
    @pytest.mark.asyncio
    async def test_save_trail_error_propagates(self, repo):
        """Upsert error during save → exception re-raised."""
        r, gw = repo
        gw.select.return_value = []  # _ensure_schema
        gw.upsert.side_effect = RuntimeError("upsert failed")
        storage_module._SCHEMA_VALIDATED = True  # Skip schema check
        with pytest.raises(RuntimeError, match="upsert failed"):
            await r.save_trail_state("chat-1", {"groups": []})

    @pytest.mark.asyncio
    async def test_load_trail_error_propagates(self, repo):
        """Select error during load → exception re-raised."""
        r, gw = repo
        storage_module._SCHEMA_VALIDATED = True
        gw.select.side_effect = RuntimeError("select failed")
        with pytest.raises(RuntimeError, match="select failed"):
            await r.load_trail_state("chat-1")

    @pytest.mark.asyncio
    async def test_delete_trail_error_propagates(self, repo):
        """Delete error → exception re-raised."""
        r, gw = repo
        storage_module._SCHEMA_VALIDATED = True
        gw.delete.side_effect = RuntimeError("delete failed")
        with pytest.raises(RuntimeError, match="delete failed"):
            await r.delete_trail_state("chat-1")
