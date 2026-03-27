"""
Tests for workers/handlers/promote_memories.py

Covers: PromoteMemoriesHandler constructor, execute (happy path, missing chat_id,
invalid chat_id, no memories to promote, partial promotion failure),
_find_and_promote_memories, _should_retry_error.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4


def _make_gateway():
    from data.database.persistence_gateway import SupabasePersistenceGateway
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.rpc = AsyncMock()
    gw.select = AsyncMock(return_value=[])
    gw.update = AsyncMock()
    gw.insert = AsyncMock()
    return gw


def _make_settings(threshold=0.8):
    settings = MagicMock()
    settings.memory_service.promotion_threshold = threshold
    return settings


def _make_job(chat_id=None, importance_threshold=None):
    metadata = {}
    if chat_id:
        metadata["chat_id"] = str(chat_id)
    if importance_threshold is not None:
        metadata["importance_threshold"] = importance_threshold
    return {
        "id": str(uuid4()),
        "job_type": "promote_memories",
        "entity_id": "e1",
        "metadata": metadata,
    }


def _make_memory(chat_id, importance=0.9):
    return {
        "id": str(uuid4()),
        "source_chat_id": str(chat_id),
        "importance_score": importance,
        "content": "A high-importance memory",
    }


@pytest.fixture
def handler():
    gw = _make_gateway()
    with patch("workers.handlers.promote_memories.get_settings", return_value=_make_settings()), \
         patch("workers.handlers.promote_memories.MemoryService"):
        from workers.handlers.promote_memories import PromoteMemoriesHandler
        h = PromoteMemoriesHandler(gw)
    return h, gw


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_init(self, handler):
        h, gw = handler
        assert h._gateway is gw
        assert h._settings is not None


# ===========================================================================
# Execute - Happy Path
# ===========================================================================

class TestExecuteHappyPath:

    @pytest.mark.asyncio
    async def test_promotes_high_importance(self, handler):
        h, gw = handler
        chat_id = uuid4()
        memories = [_make_memory(chat_id, 0.9), _make_memory(chat_id, 0.85)]
        gw.select.return_value = memories
        job = _make_job(chat_id=chat_id)
        await h.execute(job)
        assert gw.update.call_count == 2  # Both promoted
        gw.rpc.assert_called()  # complete_job

    @pytest.mark.asyncio
    async def test_no_memories_to_promote(self, handler):
        h, gw = handler
        gw.select.return_value = []  # No high-importance memories
        job = _make_job(chat_id=uuid4())
        await h.execute(job)
        gw.update.assert_not_called()
        gw.rpc.assert_called()  # Still completes

    @pytest.mark.asyncio
    async def test_custom_threshold(self, handler):
        h, gw = handler
        chat_id = uuid4()
        gw.select.return_value = [_make_memory(chat_id, 0.95)]
        job = _make_job(chat_id=chat_id, importance_threshold=0.95)
        await h.execute(job)
        # Verify gateway query used correct threshold
        gw.select.assert_called_once()
        call_filters = gw.select.call_args[1].get("filters", gw.select.call_args[0][1] if len(gw.select.call_args[0]) > 1 else {})
        assert "importance_score" in call_filters


# ===========================================================================
# Execute - Validation
# ===========================================================================

class TestExecuteValidation:

    @pytest.mark.asyncio
    async def test_missing_chat_id(self, handler):
        h, gw = handler
        job = _make_job()
        with pytest.raises(ValueError, match="Missing chat_id"):
            await h.execute(job)

    @pytest.mark.asyncio
    async def test_invalid_chat_id(self, handler):
        h, _ = handler
        job = _make_job()
        job["metadata"]["chat_id"] = "invalid"
        with pytest.raises(ValueError, match="Invalid chat_id"):
            await h.execute(job)


# ===========================================================================
# Execute - Partial Failure
# ===========================================================================

class TestPartialFailure:

    @pytest.mark.asyncio
    async def test_one_memory_fails_others_succeed(self, handler):
        """If one memory update fails, others still get promoted."""
        h, gw = handler
        chat_id = uuid4()
        memories = [_make_memory(chat_id, 0.9), _make_memory(chat_id, 0.85)]
        gw.select.return_value = memories
        # First update succeeds, second fails
        gw.update.side_effect = [None, RuntimeError("DB error")]
        job = _make_job(chat_id=chat_id)
        await h.execute(job)
        assert gw.update.call_count == 2
        gw.rpc.assert_called()  # Job still completes

    @pytest.mark.asyncio
    async def test_service_error_fails_job(self, handler):
        h, gw = handler
        gw.select.side_effect = RuntimeError("DB unavailable")
        job = _make_job(chat_id=uuid4())
        with pytest.raises(RuntimeError):
            await h.execute(job)


# ===========================================================================
# Find And Promote Memories
# ===========================================================================

class TestFindAndPromoteMemories:

    @pytest.mark.asyncio
    async def test_sets_source_chat_id_null(self, handler):
        """Promoted memories must have source_chat_id=None (global)."""
        h, gw = handler
        chat_id = uuid4()
        gw.select.return_value = [_make_memory(chat_id, 0.9)]
        result = await h._find_and_promote_memories(chat_id, 0.8)
        assert len(result) == 1
        update_call = gw.update.call_args
        data = update_call[1].get("data", update_call[0][2] if len(update_call[0]) > 2 else {})
        assert data["source_chat_id"] is None

    @pytest.mark.asyncio
    async def test_empty_result(self, handler):
        h, gw = handler
        gw.select.return_value = []
        result = await h._find_and_promote_memories(uuid4(), 0.8)
        assert result == []


# ===========================================================================
# Retry Error Classification
# ===========================================================================

class TestShouldRetryError:

    def test_timeout_retryable(self, handler):
        h, _ = handler
        assert h._should_retry_error(TimeoutError("timed out")) is True

    def test_connection_retryable(self, handler):
        h, _ = handler
        assert h._should_retry_error(ConnectionError("refused")) is True

    def test_value_error_not_retryable(self, handler):
        h, _ = handler
        assert h._should_retry_error(ValueError("bad")) is False

    def test_key_error_not_retryable(self, handler):
        h, _ = handler
        assert h._should_retry_error(KeyError("x")) is False

    def test_unknown_retryable(self, handler):
        h, _ = handler
        assert h._should_retry_error(MemoryError()) is True
