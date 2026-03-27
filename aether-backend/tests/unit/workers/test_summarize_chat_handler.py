"""
Tests for workers/handlers/summarize_chat.py

Covers: SummarizeChatHandler constructor, execute (happy path, missing chat_id,
invalid chat_id, user preference check, service failure with retry logic),
_check_user_preference, _should_retry_error.

All gateway + service calls mocked.
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
    settings.summary_service.auto_summarize = True
    settings.memory_service = MagicMock()
    return settings


def _make_job(chat_id=None, user_id=None, job_id=None):
    jid = str(job_id or uuid4())
    metadata = {}
    if chat_id:
        metadata["chat_id"] = str(chat_id)
    if user_id:
        metadata["user_id"] = user_id
    return {
        "id": jid,
        "job_type": "summarize_chat",
        "entity_id": "e1",
        "metadata": metadata,
    }


@pytest.fixture
def handler():
    gw = _make_gateway()
    with patch("workers.handlers.summarize_chat.get_settings", return_value=_make_settings()), \
         patch("workers.handlers.summarize_chat.ChatSummaryService") as MockService:
        mock_service = MockService.return_value
        mock_service.generate_summary = AsyncMock(return_value={
            "id": str(uuid4()),
            "title": "Test Summary",
            "summary_type": "full",
        })
        from workers.handlers.summarize_chat import SummarizeChatHandler
        h = SummarizeChatHandler(gw)
        h._summary_service = mock_service
    return h, gw, mock_service


# ===========================================================================
# Constructor Tests
# ===========================================================================

class TestConstructor:

    def test_init_creates_service(self, handler):
        h, gw, svc = handler
        assert h._gateway is gw
        assert h._summary_service is svc

    def test_init_has_settings(self, handler):
        h, _, _ = handler
        assert h._settings is not None


# ===========================================================================
# Execute - Happy Path
# ===========================================================================

class TestExecuteHappyPath:

    @pytest.mark.asyncio
    async def test_success(self, handler):
        h, gw, svc = handler
        chat_id = uuid4()
        job = _make_job(chat_id=chat_id)
        await h.execute(job)
        svc.generate_summary.assert_called_once_with(
            chat_id=chat_id,
            summary_type="full",
            force_regenerate=False,
        )
        gw.rpc.assert_called()  # complete_job called

    @pytest.mark.asyncio
    async def test_custom_summary_type(self, handler):
        h, gw, svc = handler
        chat_id = uuid4()
        job = _make_job(chat_id=chat_id)
        job["metadata"]["summary_type"] = "brief"
        job["metadata"]["force_regenerate"] = True
        await h.execute(job)
        svc.generate_summary.assert_called_once_with(
            chat_id=chat_id,
            summary_type="brief",
            force_regenerate=True,
        )


# ===========================================================================
# Execute - Validation Errors
# ===========================================================================

class TestExecuteValidation:

    @pytest.mark.asyncio
    async def test_missing_chat_id_raises(self, handler):
        h, gw, _ = handler
        job = _make_job()  # No chat_id, no entity_type
        with pytest.raises(ValueError, match="Missing chat_id"):
            await h.execute(job)
        # fail_job called with retry=False
        gw.rpc.assert_called()

    @pytest.mark.asyncio
    async def test_invalid_chat_id_raises(self, handler):
        h, gw, _ = handler
        job = _make_job()
        job["metadata"]["chat_id"] = "not-a-uuid"
        with pytest.raises(ValueError, match="Invalid chat_id"):
            await h.execute(job)

    @pytest.mark.asyncio
    async def test_entity_id_fallback_when_metadata_missing_chat_id(self, handler):
        """DB trigger puts chat_id in entity_id, not metadata. Handler must fall back."""
        h, gw, svc = handler
        chat_id = uuid4()
        job = {
            "id": str(uuid4()),
            "job_type": "summarize_chat",
            "entity_id": str(chat_id),
            "entity_type": "chat",
            "metadata": {"message_id": str(uuid4())},  # No chat_id — matches DB trigger
        }
        await h.execute(job)
        svc.generate_summary.assert_called_once_with(
            chat_id=chat_id,
            summary_type="full",
            force_regenerate=False,
        )

    @pytest.mark.asyncio
    async def test_entity_id_fallback_wrong_entity_type_raises(self, handler):
        """entity_id fallback only works when entity_type == 'chat'."""
        h, gw, _ = handler
        job = {
            "id": str(uuid4()),
            "job_type": "summarize_chat",
            "entity_id": str(uuid4()),
            "entity_type": "user",  # Not 'chat' — fallback should NOT work
            "metadata": {},
        }
        with pytest.raises(ValueError, match="Missing chat_id"):
            await h.execute(job)


# ===========================================================================
# Execute - Service Failure
# ===========================================================================

class TestExecuteServiceFailure:

    @pytest.mark.asyncio
    async def test_service_error_fails_job_and_reraises(self, handler):
        h, gw, svc = handler
        svc.generate_summary.side_effect = RuntimeError("LLM timeout")
        job = _make_job(chat_id=uuid4())
        with pytest.raises(RuntimeError, match="LLM timeout"):
            await h.execute(job)
        # fail_job was called
        assert gw.rpc.call_count >= 1


# ===========================================================================
# User Preference Check
# ===========================================================================

class TestCheckUserPreference:

    @pytest.mark.asyncio
    async def test_no_preference_returns_config_default(self, handler):
        h, gw, _ = handler
        gw.select.return_value = []
        result = await h._check_user_preference("user-1")
        assert result is True  # _make_settings sets auto_summarize=True

    @pytest.mark.asyncio
    async def test_preference_disabled(self, handler):
        h, gw, _ = handler
        gw.select.return_value = [{"preference_value": {"auto_summarize": False}}]
        result = await h._check_user_preference("user-1")
        assert result is False

    @pytest.mark.asyncio
    async def test_preference_enabled(self, handler):
        h, gw, _ = handler
        gw.select.return_value = [{"preference_value": {"auto_summarize": True}}]
        result = await h._check_user_preference("user-1")
        assert result is True

    @pytest.mark.asyncio
    async def test_enabled_key_alone_does_not_activate(self, handler):
        """'enabled' field is a section-visited flag, NOT the auto-summarize toggle.
        Only 'auto_summarize' field controls the feature."""
        h, gw, _ = handler
        gw.select.return_value = [{"preference_value": {"enabled": True}}]
        result = await h._check_user_preference("user-1")
        assert result is False

    @pytest.mark.asyncio
    async def test_db_error_returns_config_default(self, handler):
        h, gw, _ = handler
        gw.select.side_effect = RuntimeError("DB down")
        result = await h._check_user_preference("user-1")
        assert result is True  # Falls back to config default

    @pytest.mark.asyncio
    async def test_user_preference_disabled_skips_job(self, handler):
        h, gw, svc = handler
        gw.select.return_value = [{"preference_value": {"auto_summarize": False}}]
        job = _make_job(chat_id=uuid4(), user_id="user-1")
        await h.execute(job)
        svc.generate_summary.assert_not_called()
        # complete_job called with skip status
        gw.rpc.assert_called()

    @pytest.mark.asyncio
    async def test_no_user_id_checks_central_config_default(self, handler):
        """DB trigger jobs have no user_id. Handler must check central config default."""
        h, gw, svc = handler
        # Central config has auto_summarize=True (from _make_settings)
        job = _make_job(chat_id=uuid4())  # No user_id
        await h.execute(job)
        # Should proceed because config default is True (in test fixture)
        svc.generate_summary.assert_called_once()

    @pytest.mark.asyncio
    async def test_no_user_id_auto_summarize_disabled_skips(self, handler):
        """When auto_summarize=False in config and no user_id, job must be skipped."""
        h, gw, svc = handler
        h._settings.summary_service.auto_summarize = False
        job = _make_job(chat_id=uuid4())  # No user_id
        await h.execute(job)
        # Must NOT summarize — config default is False
        svc.generate_summary.assert_not_called()
        gw.rpc.assert_called()  # complete_job called with skip


# ===========================================================================
# Retry Error Classification
# ===========================================================================

class TestShouldRetryError:

    def test_timeout_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(TimeoutError("connection timed out")) is True

    def test_connection_error_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(ConnectionError("refused")) is True

    def test_503_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(RuntimeError("503 service unavailable")) is True

    def test_value_error_not_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(ValueError("bad data")) is False

    def test_key_error_not_retryable(self, handler):
        h, _, _ = handler
        assert h._should_retry_error(KeyError("missing_key")) is False

    def test_unknown_error_retryable(self, handler):
        """Unknown errors default to retryable."""
        h, _, _ = handler
        assert h._should_retry_error(MemoryError("out of memory")) is True
