"""
Tests for data/database/persistence_gateway.py

Covers: SupabasePersistenceGateway constructor, lifecycle delegation,
data access methods (insert, select, update, delete, upsert, count, group_count),
_run_with_retry (success, retry on transient, schema cache reload, non-retryable),
_sanitize_identifier, _sanitize_group_by, _payload_size, _resolve_correlation_id,
__getattr__ delegation, subscribe_realtime.
"""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from data.database.persistence_gateway import SupabasePersistenceGateway, APIError


def _make_api_error(message="error", code=None, details=None):
    """Create APIError compatible with whichever version is imported."""
    try:
        # Real postgrest APIError takes a dict
        return APIError({"message": message, "code": code or "", "details": details or ""})
    except TypeError:
        # Fallback APIError class takes keyword args
        return APIError(message, code=code, details=details)


def _make_client():
    """Create mocked SupabaseClient."""
    client = MagicMock()
    client.initialize = AsyncMock()
    client.dispose = AsyncMock()
    client.is_initialized = MagicMock(return_value=True)
    client.health_check = AsyncMock(return_value={"healthy": True})
    client.get_diagnostics = MagicMock(return_value={})
    client.insert = AsyncMock(return_value=[{"id": "r1"}])
    client.select = AsyncMock(return_value=[{"id": "r1"}])
    client.update = AsyncMock(return_value=[{"id": "r1"}])
    client.delete = AsyncMock(return_value=[{"id": "r1"}])
    client.upsert = AsyncMock(return_value=[{"id": "r1"}])
    client.count = AsyncMock(return_value=5)
    client.group_count = AsyncMock(return_value=[{"group": "a", "count": 3}])
    client.subscribe_realtime = AsyncMock(return_value="sub-handle")
    client.reload_schema_cache = AsyncMock()
    return client


@pytest.fixture
def gateway():
    client = _make_client()
    gw = SupabasePersistenceGateway(client, max_retries=2, initial_delay=0.01)
    return gw, client


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_init(self, gateway):
        gw, client = gateway
        assert gw._client is client
        assert gw._max_retries == 2

    def test_retryable_codes_set(self, gateway):
        gw, _ = gateway
        assert "PGRST116" in gw._retryable_postgrest_codes
        assert "57014" in gw._retryable_postgrest_codes


# ===========================================================================
# Lifecycle Delegation
# ===========================================================================

class TestLifecycle:

    @pytest.mark.asyncio
    async def test_initialize(self, gateway):
        gw, client = gateway
        await gw.initialize()
        client.initialize.assert_called_once()

    @pytest.mark.asyncio
    async def test_dispose(self, gateway):
        gw, client = gateway
        await gw.dispose()
        client.dispose.assert_called_once()

    def test_is_initialized(self, gateway):
        gw, _ = gateway
        assert gw.is_initialized() is True

    @pytest.mark.asyncio
    async def test_health_check(self, gateway):
        gw, _ = gateway
        result = await gw.health_check()
        assert result["healthy"] is True

    def test_get_diagnostics(self, gateway):
        gw, _ = gateway
        result = gw.get_diagnostics()
        assert isinstance(result, dict)

    def test_raw_client(self, gateway):
        gw, client = gateway
        assert gw.raw_client is client


# ===========================================================================
# Data Access Methods
# ===========================================================================

class TestInsert:

    @pytest.mark.asyncio
    async def test_insert(self, gateway):
        gw, client = gateway
        result = await gw.insert("chats", {"title": "Test"})
        client.insert.assert_called_once()
        assert result == [{"id": "r1"}]

    @pytest.mark.asyncio
    async def test_insert_admin(self, gateway):
        gw, client = gateway
        await gw.insert("chats", {"title": "Test"}, admin=True)
        call_kwargs = client.insert.call_args
        assert call_kwargs[1]["admin"] is True


class TestSelect:

    @pytest.mark.asyncio
    async def test_select(self, gateway):
        gw, client = gateway
        result = await gw.select("chats")
        client.select.assert_called_once()
        assert result == [{"id": "r1"}]

    @pytest.mark.asyncio
    async def test_select_with_filters(self, gateway):
        gw, client = gateway
        await gw.select("chats", filters={"id": "abc"}, limit=10)
        call_kwargs = client.select.call_args[1]
        assert call_kwargs["filters"] == {"id": "abc"}
        assert call_kwargs["limit"] == 10


class TestUpdate:

    @pytest.mark.asyncio
    async def test_update(self, gateway):
        gw, client = gateway
        result = await gw.update("chats", {"title": "New"}, record_id="r1")
        client.update.assert_called_once()

    @pytest.mark.asyncio
    async def test_update_with_filters(self, gateway):
        gw, client = gateway
        await gw.update("chats", {"title": "New"}, filters={"status": "active"})
        client.update.assert_called_once()


class TestDelete:

    @pytest.mark.asyncio
    async def test_delete(self, gateway):
        gw, client = gateway
        result = await gw.delete("chats", record_id="r1")
        client.delete.assert_called_once()


class TestUpsert:

    @pytest.mark.asyncio
    async def test_upsert(self, gateway):
        gw, client = gateway
        result = await gw.upsert("tools", {"name": "tool1"})
        client.upsert.assert_called_once()


class TestCount:

    @pytest.mark.asyncio
    async def test_count(self, gateway):
        gw, client = gateway
        result = await gw.count("chats")
        assert result == 5

    @pytest.mark.asyncio
    async def test_count_with_filters(self, gateway):
        gw, client = gateway
        await gw.count("chats", filters={"status": "active"})
        client.count.assert_called_once()


class TestGroupCount:

    @pytest.mark.asyncio
    async def test_group_count(self, gateway):
        gw, client = gateway
        result = await gw.group_count("messages", "chat_id")
        client.group_count.assert_called_once()
        assert result == [{"group": "a", "count": 3}]


# ===========================================================================
# Retry Logic
# ===========================================================================

class TestRunWithRetry:

    @pytest.mark.asyncio
    async def test_success_first_attempt(self, gateway):
        gw, client = gateway
        result = await gw.insert("t", {"k": "v"})
        assert result == [{"id": "r1"}]
        assert client.insert.call_count == 1

    @pytest.mark.asyncio
    async def test_retry_on_connection_error(self, gateway):
        gw, client = gateway
        client.insert.side_effect = [ConnectionError("timeout"), [{"id": "r2"}]]
        result = await gw.insert("t", {"k": "v"})
        assert client.insert.call_count == 2
        assert result == [{"id": "r2"}]

    @pytest.mark.asyncio
    async def test_retry_exhausted_raises(self, gateway):
        gw, client = gateway
        client.insert.side_effect = ConnectionError("always failing")
        with pytest.raises(ConnectionError):
            await gw.insert("t", {"k": "v"})
        assert client.insert.call_count == 3  # initial + 2 retries

    @pytest.mark.asyncio
    async def test_non_retryable_error_raises_immediately(self, gateway):
        gw, client = gateway
        err = _make_api_error("permission denied", code="42501")
        client.insert.side_effect = err
        with pytest.raises(APIError):
            await gw.insert("t", {"k": "v"})
        assert client.insert.call_count == 1  # No retry

    @pytest.mark.asyncio
    async def test_retryable_postgrest_code(self, gateway):
        gw, client = gateway
        err = _make_api_error("timeout", code="PGRST116")
        client.insert.side_effect = [err, [{"id": "r3"}]]
        result = await gw.insert("t", {"k": "v"})
        assert result == [{"id": "r3"}]

    @pytest.mark.asyncio
    async def test_schema_cache_reload_on_pgrst204(self, gateway):
        gw, client = gateway
        err = _make_api_error("schema cache stale", code="PGRST204", details="schema cache")
        client.insert.side_effect = [err, [{"id": "r4"}]]
        result = await gw.insert("t", {"k": "v"})
        client.reload_schema_cache.assert_called_once()
        assert result == [{"id": "r4"}]

    @pytest.mark.asyncio
    async def test_schema_cache_reload_failure_still_retries(self, gateway):
        gw, client = gateway
        err = _make_api_error("schema cache stale", code="PGRST204", details="schema cache")
        client.reload_schema_cache.side_effect = RuntimeError("reload fail")
        client.insert.side_effect = [err, [{"id": "r5"}]]
        result = await gw.insert("t", {"k": "v"})
        assert result == [{"id": "r5"}]

    @pytest.mark.asyncio
    async def test_timeout_error_retried(self, gateway):
        gw, client = gateway
        client.select.side_effect = [asyncio.TimeoutError(), [{"id": "r6"}]]
        result = await gw.select("t")
        assert result == [{"id": "r6"}]


# ===========================================================================
# Sanitize Identifier
# ===========================================================================

class TestSanitizeIdentifier:

    def test_valid_identifier(self):
        assert SupabasePersistenceGateway._sanitize_identifier("chat_id") == "chat_id"

    def test_valid_dotted(self):
        assert SupabasePersistenceGateway._sanitize_identifier("table.column") == "table.column"

    def test_invalid_identifier_raises(self):
        with pytest.raises(ValueError, match="Invalid identifier"):
            SupabasePersistenceGateway._sanitize_identifier("DROP TABLE; --")

    def test_wildcard_allowed(self):
        assert SupabasePersistenceGateway._sanitize_identifier("*", allow_wildcard=True) == "*"

    def test_wildcard_rejected_by_default(self):
        with pytest.raises(ValueError):
            SupabasePersistenceGateway._sanitize_identifier("*")


# ===========================================================================
# Sanitize Group By
# ===========================================================================

class TestSanitizeGroupBy:

    def test_none(self, gateway):
        gw, _ = gateway
        assert gw._sanitize_group_by(None) is None

    def test_string(self, gateway):
        gw, _ = gateway
        assert gw._sanitize_group_by("chat_id") == "chat_id"

    def test_iterable(self, gateway):
        gw, _ = gateway
        result = gw._sanitize_group_by(["chat_id", "role"])
        assert result == ("chat_id", "role")

    def test_invalid_group_by_raises(self, gateway):
        gw, _ = gateway
        with pytest.raises(ValueError):
            gw._sanitize_group_by("DROP TABLE;")


# ===========================================================================
# Payload Size
# ===========================================================================

class TestPayloadSize:

    def test_dict(self):
        assert SupabasePersistenceGateway._payload_size({"a": 1}) == 1

    def test_list(self):
        assert SupabasePersistenceGateway._payload_size([{"a": 1}, {"b": 2}]) == 2


# ===========================================================================
# Resolve Correlation ID
# ===========================================================================

class TestResolveCorrelationId:

    def test_provided(self):
        result = SupabasePersistenceGateway._resolve_correlation_id("my-id")
        assert result == "my-id"

    def test_none_generates_uuid(self):
        with patch("data.database.persistence_gateway.get_correlation_id", return_value=None):
            result = SupabasePersistenceGateway._resolve_correlation_id(None)
        assert len(result) == 36  # UUID format


# ===========================================================================
# __getattr__ Delegation
# ===========================================================================

class TestGetattr:

    def test_delegates_to_client(self, gateway):
        gw, client = gateway
        client.some_custom_method = MagicMock(return_value="custom")
        assert gw.some_custom_method() == "custom"

    @pytest.mark.asyncio
    async def test_subscribe_realtime(self, gateway):
        gw, client = gateway
        result = await gw.subscribe_realtime("channel")
        assert result == "sub-handle"
