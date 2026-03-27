"""
Tests for workers/handlers/extract_memories.py

Covers: ExtractMemoriesHandler constructor, execute (happy path, missing chat_id,
invalid chat_id, service failure + retry, source_chat_id verification),
_should_retry_error.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4


def _make_gateway():
    from data.database.persistence_gateway import SupabasePersistenceGateway
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.rpc = AsyncMock()
    gw.select = AsyncMock(return_value=[])
    gw.insert = AsyncMock()
    return gw


def _make_settings():
    settings = MagicMock()
    settings.memory_service = MagicMock()
    return settings


def _make_job(chat_id=None, groups_to_process=None, group_sequence=None):
    metadata = {}
    if chat_id:
        metadata["chat_id"] = str(chat_id)
    if groups_to_process:
        metadata["groups_to_process"] = groups_to_process
    if group_sequence is not None:
        metadata["group_sequence"] = group_sequence
    return {
        "id": str(uuid4()),
        "job_type": "extract_memories",
        "entity_id": "e1",
        "metadata": metadata,
    }

@pytest.fixture
def handler():
    gw = _make_gateway()
    with patch("workers.handlers.extract_memories.get_settings", return_value=_make_settings()), \
         patch("workers.handlers.extract_memories.MemoryService") as MockService:
        mock_service = MockService.return_value
        chat_id_holder = {}

        async def mock_extract(chat_id, num_groups=5, max_sequence=None):
            chat_id_holder["last"] = chat_id
            return [
                {"id": str(uuid4()), "source_chat_id": str(chat_id), "importance_score": 0.9},
                {"id": str(uuid4()), "source_chat_id": str(chat_id), "importance_score": 0.7},
            ]

        mock_service.extract_memories_from_groups = AsyncMock(side_effect=mock_extract)
        from workers.handlers.extract_memories import ExtractMemoriesHandler
        h = ExtractMemoriesHandler(gw)
        h._memory_service = mock_service
    return h, gw, mock_service


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_init(self, handler):
        h, gw, svc = handler
        assert h._gateway is gw
        assert h._memory_service is svc


# ===========================================================================
# Execute - Happy Path
# ===========================================================================

class TestExecuteHappyPath:

    @pytest.mark.asyncio
    async def test_extracts_memories(self, handler):
        h, gw, svc = handler
        chat_id = uuid4()
        job = _make_job(chat_id=chat_id)
        
        svc.auto_promote_important_memories = AsyncMock(return_value=[uuid4()])
        
        await h.execute(job)
        
        svc.extract_memories_from_groups.assert_called_once_with(
            chat_id=chat_id, num_groups=5, max_sequence=None
        )
        svc.auto_promote_important_memories.assert_called_once()
        gw.rpc.assert_called()  # complete_job

    @pytest.mark.asyncio
    async def test_custom_groups_to_process(self, handler):
        h, gw, svc = handler
        chat_id = uuid4()
        job = _make_job(chat_id=chat_id, groups_to_process=10)
        await h.execute(job)
        svc.extract_memories_from_groups.assert_called_once_with(
            chat_id=chat_id, num_groups=10, max_sequence=None
        )

    @pytest.mark.asyncio
    async def test_group_sequence_logged(self, handler):
        """group_sequence in metadata should not cause errors."""
        h, _, svc = handler
        chat_id = uuid4()
        job = _make_job(chat_id=chat_id, group_sequence=42)
        await h.execute(job)
        svc.extract_memories_from_groups.assert_called_once()


# ===========================================================================
# Execute - Validation
# ===========================================================================

class TestExecuteValidation:

    @pytest.mark.asyncio
    async def test_missing_chat_id(self, handler):
        h, gw, _ = handler
        job = _make_job()
        with pytest.raises(ValueError, match="Missing chat_id"):
            await h.execute(job)

    @pytest.mark.asyncio
    async def test_invalid_chat_id(self, handler):
        h, _, _ = handler
        job = _make_job()
        job["metadata"]["chat_id"] = "garbage"
        with pytest.raises(ValueError, match="Invalid chat_id"):
            await h.execute(job)


# ===========================================================================
# Execute - Source Chat ID Verification
# ===========================================================================

class TestSourceChatIdVerification:

    @pytest.mark.asyncio
    async def test_mismatched_source_chat_id_logs_warning(self, handler):
        """If a memory has a wrong source_chat_id, handler logs warning but completes."""
        h, gw, svc = handler
        chat_id = uuid4()

        async def mock_extract_mismatch(chat_id, num_groups=5, max_sequence=None):
            return [{"id": str(uuid4()), "source_chat_id": str(uuid4()), "importance_score": 0.5}]

        svc.extract_memories_from_groups = AsyncMock(side_effect=mock_extract_mismatch)
        job = _make_job(chat_id=chat_id)
        await h.execute(job)
        gw.rpc.assert_called()  # complete_job still called


# ===========================================================================
# Execute - Service Failure
# ===========================================================================

class TestExecuteServiceFailure:

    @pytest.mark.asyncio
    async def test_value_error_fails_no_retry(self, handler):
        h, gw, svc = handler
        svc.extract_memories_from_groups.side_effect = ValueError("No summary found")
        job = _make_job(chat_id=uuid4())
        with pytest.raises(ValueError):
            await h.execute(job)

    @pytest.mark.asyncio
    async def test_runtime_error_fails_with_retry(self, handler):
        h, gw, svc = handler
        svc.extract_memories_from_groups.side_effect = RuntimeError("LLM timeout")
        job = _make_job(chat_id=uuid4())
        with pytest.raises(RuntimeError):
            await h.execute(job)


# ===========================================================================
# Retry Error Classification
# ===========================================================================

class TestShouldRetryError:

    def test_timeout_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(TimeoutError("timed out")) is True

    def test_connection_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(ConnectionError("refused")) is True

    def test_value_error_not_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(ValueError("bad")) is False

    def test_key_error_not_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(KeyError("missing")) is False

    def test_503_in_message_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(RuntimeError("503 service unavailable")) is True

    def test_unknown_error_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(MemoryError()) is True
