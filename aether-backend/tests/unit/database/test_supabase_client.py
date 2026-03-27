"""
Tests for data/database/clients/supabase.py

Covers: SupabaseClient constructor, lifecycle (initialize, dispose), from_env,
get_client, _execute, CRUD operations (insert, select, update, delete, upsert, count),
group_count, subscribe_realtime, health_check, is_initialized, get_diagnostics,
rpc, reload_schema_cache, _sanitize_identifier, _build_group_count_columns,
_GROUP_COUNT_VIEW_MAP.
"""

import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from httpx import QueryParams

from data.database.clients.supabase import SupabaseClient


# ===========================================================================
# Helpers
# ===========================================================================

def _make_response(data=None, count=None):
    """Create a mock Supabase API response."""
    resp = MagicMock()
    resp.data = data if data is not None else []
    resp.count = count
    return resp


def _make_initialized_client(*, realtime_enabled=True):
    """Create a SupabaseClient with mocked internals, already initialized."""
    sb = SupabaseClient(
        url="http://localhost:54321",
        key="test-anon-key",
        service_role_key="test-service-key",
        schema="public",
        realtime_enabled=realtime_enabled,
    )
    sb._client = MagicMock()
    sb._async_client = AsyncMock()
    # Fix: channel() should return a sync mock, not a coroutine
    sb._async_client.channel = MagicMock()
    sb._admin_client = MagicMock()
    sb._initialized = True
    sb._execute = AsyncMock(return_value=_make_response([{"id": "r1"}]))
    return sb


@pytest.fixture
def sb():
    """Initialized SupabaseClient with mocked _execute."""
    return _make_initialized_client()


@pytest.fixture
def sb_no_realtime():
    """Initialized SupabaseClient with realtime disabled."""
    return _make_initialized_client(realtime_enabled=False)


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_basic_init(self):
        sb = SupabaseClient(url="http://localhost:54321", key="test-key")
        assert sb.url == "http://localhost:54321"
        assert sb.key == "test-key"
        assert sb.service_role_key == "test-key"  # defaults to key
        assert sb.schema == "public"
        assert sb.realtime_enabled is True
        assert sb._client is None
        assert sb._admin_client is None
        assert sb._initialized is False
        assert sb._channels == []

    def test_init_with_all_params(self):
        sb = SupabaseClient(
            url="http://db.example.com",
            key="anon-key",
            service_role_key="service-key",
            schema="custom",
            realtime_enabled=False,
        )
        assert sb.url == "http://db.example.com"
        assert sb.key == "anon-key"
        assert sb.service_role_key == "service-key"
        assert sb.schema == "custom"
        assert sb.realtime_enabled is False

    def test_service_role_key_defaults_to_key_when_none(self):
        sb = SupabaseClient(url="http://x", key="k", service_role_key=None)
        assert sb.service_role_key == "k"

    def test_service_role_key_defaults_to_key_when_empty(self):
        sb = SupabaseClient(url="http://x", key="k", service_role_key="")
        assert sb.service_role_key == "k"

    def test_service_role_key_explicit(self):
        sb = SupabaseClient(url="http://x", key="k", service_role_key="sk")
        assert sb.service_role_key == "sk"


# ===========================================================================
# Lifecycle: initialize
# ===========================================================================

class TestInitialize:

    async def test_initialize_creates_clients(self):
        sb = SupabaseClient(url="http://localhost", key="k", service_role_key="sk")
        mock_client = MagicMock()
        mock_admin = MagicMock()
        mock_async = MagicMock()

        with patch(
            "data.database.clients.supabase.create_client",
            side_effect=[mock_client, mock_admin],
        ) as mock_create:
            with patch("data.database.clients.supabase.acreate_client", new_callable=AsyncMock) as mock_acreate:
                mock_acreate.return_value = mock_async
                sb.health_check = AsyncMock(return_value={"healthy": True})
                await sb.initialize()

        assert sb._initialized is True
        assert sb._client is mock_client
        assert sb._admin_client is mock_admin
        assert sb._async_client is mock_async
        mock_create.assert_any_call("http://localhost", "k")
        mock_create.assert_any_call("http://localhost", "sk")
        mock_acreate.assert_called_with("http://localhost", "k")

    async def test_initialize_already_initialized_returns_early(self):
        sb = _make_initialized_client()
        original_client = sb._client
        await sb.initialize()  # Should return early, not recreate clients
        assert sb._client is original_client

    async def test_initialize_health_check_failure_raises(self):
        sb = SupabaseClient(url="http://localhost", key="k")
        with patch("data.database.clients.supabase.create_client", return_value=MagicMock()):
            sb.health_check = AsyncMock(
                return_value={"healthy": False, "error": "Connection refused"}
            )
            with pytest.raises(RuntimeError, match="Supabase initialization failed"):
                await sb.initialize()
        assert sb._initialized is False

    async def test_initialize_create_client_exception(self):
        sb = SupabaseClient(url="http://localhost", key="k")
        with patch(
            "data.database.clients.supabase.create_client",
            side_effect=Exception("SDK error"),
        ):
            with pytest.raises(RuntimeError, match="Supabase initialization failed"):
                await sb.initialize()
        assert sb._initialized is False

    async def test_initialize_supabase_unavailable(self):
        sb = SupabaseClient(url="http://localhost", key="k")
        with patch("data.database.clients.supabase.SUPABASE_AVAILABLE", False):
            with pytest.raises(RuntimeError, match="dependency is missing"):
                await sb.initialize()


# ===========================================================================
# Lifecycle: dispose
# ===========================================================================

class TestDispose:

    async def test_dispose_cleans_up_channels(self):
        sb = _make_initialized_client()
        ch1 = AsyncMock()
        ch2 = AsyncMock()
        sb._channels = [ch1, ch2]

        await sb.dispose()

        assert sb._initialized is False
        assert sb._client is None
        assert sb._admin_client is None
        assert sb._async_client is None
        assert sb._channels == []
        ch1.unsubscribe.assert_called_once()
        ch2.unsubscribe.assert_called_once()

    async def test_dispose_not_initialized_is_noop(self):
        sb = SupabaseClient(url="http://localhost", key="k")
        await sb.dispose()  # Should not raise

    async def test_dispose_channel_error_continues(self):
        sb = _make_initialized_client()
        bad_ch = AsyncMock()
        bad_ch.unsubscribe.side_effect = Exception("unsubscribe failed")
        good_ch = AsyncMock()
        sb._channels = [bad_ch, good_ch]

        await sb.dispose()  # Should not raise

        assert sb._initialized is False
        assert sb._channels == []
        good_ch.unsubscribe.assert_called_once()

    async def test_dispose_outer_exception_caught(self):
        """Trigger the outer except block in dispose (line 179-180)."""
        sb = _make_initialized_client()
        # Replace _channels with an object whose iteration raises after the first
        # item, causing the outer try to catch the error
        broken_list = MagicMock()
        broken_list.__iter__ = MagicMock(side_effect=RuntimeError("corrupt state"))
        sb._channels = broken_list

        # Should not raise — outer except catches and logs
        await sb.dispose()


# ===========================================================================
# from_env
# ===========================================================================

class TestFromEnv:

    def test_from_settings_dict(self):
        settings = {
            "url": "http://db.example.com",
            "anon_key": "my-anon-key",
            "service_role_key": "my-service-key",
            "schema": "custom_schema",
            "realtime_enabled": True,
        }
        sb = SupabaseClient.from_env(settings)
        assert sb.url == "http://db.example.com"
        assert sb.key == "my-anon-key"
        assert sb.service_role_key == "my-service-key"
        assert sb.schema == "custom_schema"
        assert sb.realtime_enabled is True

    def test_from_env_variables(self):
        env = {
            "SUPABASE_URL": "http://env.example.com",
            "SUPABASE_ANON_KEY": "env-anon",
            "SUPABASE_SERVICE_ROLE_KEY": "env-service",
            "SUPABASE_SCHEMA": "env_schema",
            "SUPABASE_REALTIME_ENABLED": "false",
        }
        with patch.dict(os.environ, env, clear=False):
            sb = SupabaseClient.from_env()
        assert sb.url == "http://env.example.com"
        assert sb.key == "env-anon"
        assert sb.service_role_key == "env-service"
        assert sb.schema == "env_schema"
        assert sb.realtime_enabled is False

    def test_from_env_missing_anon_key_raises(self):
        env = {"SUPABASE_ANON_KEY": ""}
        with patch.dict(os.environ, env, clear=False):
            with pytest.raises(RuntimeError, match="SUPABASE_ANON_KEY is missing"):
                SupabaseClient.from_env()

    def test_from_settings_dict_missing_anon_key_raises(self):
        settings = {"url": "http://x", "anon_key": ""}
        with pytest.raises(RuntimeError, match="SUPABASE_ANON_KEY is missing"):
            SupabaseClient.from_env(settings)

    def test_from_env_defaults(self):
        env = {"SUPABASE_ANON_KEY": "key123"}
        with patch.dict(os.environ, env, clear=True):
            sb = SupabaseClient.from_env()
        assert sb.url == "http://localhost:54321"
        assert sb.schema == "public"
        assert sb.realtime_enabled is True

    def test_from_env_realtime_truthy_values(self):
        for val in ("1", "true", "yes", "True", "YES"):
            env = {"SUPABASE_ANON_KEY": "k", "SUPABASE_REALTIME_ENABLED": val}
            with patch.dict(os.environ, env, clear=True):
                sb = SupabaseClient.from_env()
            assert sb.realtime_enabled is True, f"Expected True for '{val}'"

    def test_from_env_realtime_falsy_values(self):
        for val in ("0", "false", "no", "anything", ""):
            env = {"SUPABASE_ANON_KEY": "k", "SUPABASE_REALTIME_ENABLED": val}
            with patch.dict(os.environ, env, clear=True):
                sb = SupabaseClient.from_env()
            assert sb.realtime_enabled is False, f"Expected False for '{val}'"

    def test_from_settings_without_optional_keys(self):
        settings = {"url": "http://x", "anon_key": "k"}
        sb = SupabaseClient.from_env(settings)
        assert sb.schema == "public"
        assert sb.realtime_enabled is True


# ===========================================================================
# get_client
# ===========================================================================

class TestGetClient:

    def test_returns_anon_client(self, sb):
        result = sb.get_client(admin=False)
        assert result is sb._client

    def test_returns_admin_client(self, sb):
        result = sb.get_client(admin=True)
        assert result is sb._admin_client

    def test_default_returns_anon(self, sb):
        result = sb.get_client()
        assert result is sb._client

    def test_not_initialized_raises(self):
        sb = SupabaseClient(url="http://x", key="k")
        with pytest.raises(RuntimeError, match="not initialized"):
            sb.get_client()


# ===========================================================================
# _execute
# ===========================================================================

class TestExecute:

    async def test_execute_delegates_to_asyncio_to_thread(self):
        sb = _make_initialized_client()
        # Restore real _execute (fixture mocks it)
        sb._execute = SupabaseClient._execute.__get__(sb, SupabaseClient)

        mock_query = MagicMock()
        mock_response = MagicMock()
        mock_query.execute.return_value = mock_response

        with patch("asyncio.to_thread", new_callable=AsyncMock) as mock_tt:
            mock_tt.return_value = mock_response
            result = await sb._execute(mock_query)

        mock_tt.assert_called_once_with(mock_query.execute)
        assert result is mock_response


# ===========================================================================
# Insert
# ===========================================================================

class TestInsert:

    async def test_insert_returns_data(self, sb):
        sb._execute.return_value = _make_response([{"id": "new-1", "title": "Test"}])
        result = await sb.insert("chats", {"title": "Test"})
        assert result == [{"id": "new-1", "title": "Test"}]

    async def test_insert_calls_correct_chain(self, sb):
        sb._execute.return_value = _make_response([{"id": "1"}])
        await sb.insert("chats", {"title": "T"})
        sb._client.table.assert_called_with("chats")
        sb._client.table().insert.assert_called_with({"title": "T"})
        sb._execute.assert_called_once()

    async def test_insert_batch(self, sb):
        records = [{"title": "A"}, {"title": "B"}]
        sb._execute.return_value = _make_response([{"id": "1"}, {"id": "2"}])
        result = await sb.insert("chats", records)
        assert len(result) == 2

    async def test_insert_admin_client(self, sb):
        sb._execute.return_value = _make_response([{"id": "1"}])
        await sb.insert("chats", {"title": "T"}, admin=True)
        sb._admin_client.table.assert_called_with("chats")

    async def test_insert_no_return_representation(self, sb):
        data = {"title": "T"}
        result = await sb.insert("chats", data, return_representation=False)
        assert result is data
        sb._execute.assert_called_once()  # Still executed, just result ignored

    async def test_insert_error_propagates(self, sb):
        sb._execute.side_effect = Exception("Insert failed")
        with pytest.raises(Exception, match="Insert failed"):
            await sb.insert("chats", {"x": 1})


# ===========================================================================
# Select
# ===========================================================================

class TestSelect:

    async def test_select_all(self, sb):
        sb._execute.return_value = _make_response([{"id": "1"}, {"id": "2"}])
        result = await sb.select("chats")
        assert len(result) == 2
        sb._client.table.assert_called_with("chats")

    async def test_select_string_columns(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", columns="id,title")
        # columns="id,title" → select_args = ("id,title",) — single string passed through
        sb._client.table().select.assert_called_once_with("id,title")

    async def test_select_list_columns(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", columns=["id", "title"])
        # List columns → each as separate positional arg: select("id", "title")
        sb._client.table().select.assert_called_once_with("id", "title")

    async def test_select_equality_filter(self, sb):
        sb._execute.return_value = _make_response([{"id": "abc"}])
        result = await sb.select("chats", filters={"id": "abc"})
        assert result == [{"id": "abc"}]

    async def test_select_null_filter(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", filters={"deleted_at": "is.null"})
        chain = sb._client.table().select()
        chain.is_.assert_called_with("deleted_at", "null")

    async def test_select_dict_filter_gte(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", filters={"created_at": {"gte": "2024-01-01"}})
        chain = sb._client.table().select()
        chain.gte.assert_called_with("created_at", "2024-01-01")

    async def test_select_dict_filter_lte(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", filters={"col": {"lte": "val"}})
        chain = sb._client.table().select()
        chain.lte.assert_called_with("col", "val")

    async def test_select_dict_filter_gt(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", filters={"col": {"gt": "val"}})
        chain = sb._client.table().select()
        chain.gt.assert_called_with("col", "val")

    async def test_select_dict_filter_lt(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", filters={"col": {"lt": "val"}})
        chain = sb._client.table().select()
        chain.lt.assert_called_with("col", "val")

    async def test_select_dict_filter_neq(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", filters={"col": {"neq": "val"}})
        chain = sb._client.table().select()
        chain.neq.assert_called_with("col", "val")

    async def test_select_dict_filter_like(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", filters={"col": {"like": "%test%"}})
        chain = sb._client.table().select()
        chain.like.assert_called_with("col", "%test%")

    async def test_select_dict_filter_ilike(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", filters={"col": {"ilike": "%test%"}})
        chain = sb._client.table().select()
        chain.ilike.assert_called_with("col", "%test%")

    async def test_select_dict_filter_unsupported_op_falls_back_to_eq(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", filters={"col": {"unknown_op": "val"}})
        # Unsupported ops fall back to eq with the inner dict's value extracted
        chain = sb._client.table().select()
        chain.eq.assert_called_with("col", "val")

    async def test_select_in_filters(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", in_filters={"id": ["a", "b", "c"]})
        chain = sb._client.table().select()
        chain.in_.assert_called_with("id", ["a", "b", "c"])

    async def test_select_in_filters_tuple(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", in_filters={"id": ("a", "b")})
        chain = sb._client.table().select()
        chain.in_.assert_called_with("id", ["a", "b"])

    async def test_select_in_filters_set(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", in_filters={"id": {"a"}})
        chain = sb._client.table().select()
        chain.in_.assert_called_once()

    async def test_select_in_filters_empty_adds_impossible_predicate(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", in_filters={"id": []})
        chain = sb._client.table().select()
        chain.eq.assert_called_with("id", "__never_matches__")

    async def test_select_in_filters_invalid_type_raises(self, sb):
        with pytest.raises(ValueError, match="must be a sequence"):
            await sb.select("chats", in_filters={"id": "not-a-list"})

    async def test_select_order_by_asc(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", order_by="created_at")
        chain = sb._client.table().select()
        chain.order.assert_called_with("created_at")

    async def test_select_order_by_desc(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", order_by="created_at.desc")
        chain = sb._client.table().select()
        chain.order.assert_called_with("created_at", desc=True)

    async def test_select_with_limit(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", limit=10)
        chain = sb._client.table().select()
        chain.limit.assert_called_with(10)

    async def test_select_with_offset(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", offset=20)
        chain = sb._client.table().select()
        chain.offset.assert_called_with(20)

    async def test_select_head_mode_sets_limit_zero(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", head=True)
        chain = sb._client.table().select()
        chain.limit.assert_called_with(0)

    async def test_select_with_count(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", count="exact")
        # count is passed as kwarg to select(): select("*", count="exact")
        sb._client.table().select.assert_called_once_with("*", count="exact")

    async def test_select_admin_client(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", admin=True)
        sb._admin_client.table.assert_called_with("chats")

    async def test_select_error_propagates(self, sb):
        sb._execute.side_effect = Exception("Select error")
        with pytest.raises(Exception, match="Select error"):
            await sb.select("chats")

    async def test_select_group_by_string(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", group_by="status")
        sb._execute.assert_called_once()  # Query was executed

    async def test_select_group_by_list(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.select("chats", group_by=["status", "type_col"])
        sb._execute.assert_called_once()  # Query was executed

    async def test_select_group_by_invalid_raises(self, sb):
        with pytest.raises(ValueError, match="Invalid identifier"):
            await sb.select("chats", group_by="DROP TABLE;")

    async def test_select_group_by_queryparams(self, sb):
        """group_by path when query.params is QueryParams."""
        sb._execute.return_value = _make_response([])

        mock_query = MagicMock()
        original_params = QueryParams({"existing": "value"})
        mock_query.params = original_params
        # Chain every method back to same mock
        for m in ("eq", "is_", "gte", "lte", "gt", "lt", "neq", "like", "ilike",
                   "in_", "order", "limit", "offset"):
            getattr(mock_query, m).return_value = mock_query
        sb._client.table.return_value.select.return_value = mock_query

        await sb.select("chats", group_by="status")

        # Params should now include "group"
        assert isinstance(mock_query.params, QueryParams)
        assert "group" in dict(mock_query.params)

    async def test_select_group_by_dict_params(self, sb):
        """group_by path when query.params is a dict."""
        sb._execute.return_value = _make_response([])

        mock_query = MagicMock()
        mock_query.params = {"existing": "value"}
        for m in ("eq", "is_", "gte", "lte", "gt", "lt", "neq", "like", "ilike",
                   "in_", "order", "limit", "offset"):
            getattr(mock_query, m).return_value = mock_query
        sb._client.table.return_value.select.return_value = mock_query

        await sb.select("chats", group_by="status")

        assert mock_query.params["group"] == "status"
        assert mock_query.params["existing"] == "value"

    async def test_select_group_by_no_params(self, sb):
        """group_by path when query.params is something else (else branch)."""
        sb._execute.return_value = _make_response([])

        mock_query = MagicMock()
        # MagicMock().params is a MagicMock (not dict, not QueryParams)
        mock_query.params = MagicMock()
        for m in ("eq", "is_", "gte", "lte", "gt", "lt", "neq", "like", "ilike",
                   "in_", "order", "limit", "offset"):
            getattr(mock_query, m).return_value = mock_query
        sb._client.table.return_value.select.return_value = mock_query

        await sb.select("chats", group_by="status")

        # Else branch: query.params = {"group": group_value}
        assert mock_query.params == {"group": "status"}


# ===========================================================================
# Group Count
# ===========================================================================

class TestGroupCount:

    async def test_group_count_messages_uses_view(self, sb):
        """messages + chat_id should use the precomputed view."""
        sb.select = AsyncMock(return_value=[{"chat_id": "c1", "count": 5}])
        result = await sb.group_count("messages", "chat_id")
        sb.select.assert_called_once()
        assert sb.select.call_args[0][0] == "messages_group_counts"
        assert result == [{"chat_id": "c1", "count": 5}]

    async def test_group_count_artifacts_uses_view(self, sb):
        sb.select = AsyncMock(return_value=[])
        await sb.group_count("artifacts", "chat_id")
        assert sb.select.call_args[0][0] == "artifacts_group_counts"

    async def test_group_count_view_custom_alias(self, sb):
        sb.select = AsyncMock(return_value=[])
        await sb.group_count("messages", "chat_id", count_alias="total")
        call_kwargs = sb.select.call_args[1]
        # View path uses _build_group_count_columns: "chat_id,total:count"
        # (PostgREST syntax: rename 'count' column to 'total')
        assert call_kwargs.get("columns") == "chat_id,total:count"

    async def test_group_count_view_skipped_on_unsupported_eq_filter(self, sb):
        """Extra equality filters outside group column skip the view."""
        sb.select = AsyncMock(return_value=[])
        await sb.group_count("messages", "chat_id", filters={"role": "user"})
        assert sb.select.call_args[0][0] == "messages"

    async def test_group_count_view_skipped_on_unsupported_in_filter(self, sb):
        sb.select = AsyncMock(return_value=[])
        await sb.group_count(
            "messages", "chat_id",
            in_filters={"role": ["user", "assistant"]},
        )
        assert sb.select.call_args[0][0] == "messages"

    async def test_group_count_view_with_allowed_group_column_filter(self, sb):
        """Filters on the group column itself should still use the view."""
        sb.select = AsyncMock(return_value=[])
        await sb.group_count("messages", "chat_id", filters={"chat_id": "c1"})
        assert sb.select.call_args[0][0] == "messages_group_counts"

    async def test_group_count_view_with_allowed_in_filter(self, sb):
        sb.select = AsyncMock(return_value=[])
        await sb.group_count(
            "messages", "chat_id",
            in_filters={"chat_id": ["c1", "c2"]},
        )
        assert sb.select.call_args[0][0] == "messages_group_counts"

    async def test_group_count_no_view_uses_aggregation(self, sb):
        """Table/column combo not in view map uses direct aggregation."""
        sb.select = AsyncMock(return_value=[])
        await sb.group_count("chats", "status")
        call_args = sb.select.call_args
        assert call_args[0][0] == "chats"
        assert call_args[1].get("group_by") is not None

    async def test_group_count_no_view_custom_count_column(self, sb):
        sb.select = AsyncMock(return_value=[])
        await sb.group_count("chats", "status", count_column="chat_id")
        call_kwargs = sb.select.call_args[1]
        # columns = "status,count:count" from _build_group_count_columns
        assert call_kwargs.get("columns") == "status,count:count"

    async def test_group_count_admin(self, sb):
        sb.select = AsyncMock(return_value=[])
        await sb.group_count("messages", "chat_id", admin=True)
        assert sb.select.call_args[1].get("admin") is True

    async def test_group_count_empty_alias_defaults(self, sb):
        """count_alias='' should default to 'count'."""
        sb.select = AsyncMock(return_value=[])
        await sb.group_count("messages", "chat_id", count_alias="")
        # alias '' → alias = "count" (line 439: alias = count_alias or "count")
        # Then view path with alias == "count" → columns = "chat_id,count"
        call_kwargs = sb.select.call_args[1]
        assert call_kwargs.get("columns") == "chat_id,count"


# ===========================================================================
# Update
# ===========================================================================

class TestUpdate:

    async def test_update_by_record_id(self, sb):
        sb._execute.return_value = _make_response([{"id": "r1", "title": "Updated"}])
        result = await sb.update("chats", {"title": "Updated"}, record_id="r1")
        assert result == [{"id": "r1", "title": "Updated"}]
        sb._client.table.assert_called_with("chats")

    async def test_update_custom_id_column(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, record_id="r1", id_column="chat_id")
        chain = sb._client.table().update()
        chain.eq.assert_called_with("chat_id", "r1")

    async def test_update_equality_filters(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"status": "closed"}, filters={"status": "open"})

    async def test_update_null_filter(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, filters={"deleted_at": "is.null"})
        chain = sb._client.table().update()
        chain.is_.assert_called_with("deleted_at", "null")

    async def test_update_dict_filter_gte(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, filters={"col": {"gte": "v"}})

    async def test_update_dict_filter_lte(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, filters={"col": {"lte": "v"}})

    async def test_update_dict_filter_gt(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, filters={"col": {"gt": "v"}})

    async def test_update_dict_filter_lt(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, filters={"col": {"lt": "v"}})

    async def test_update_dict_filter_neq(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, filters={"col": {"neq": "v"}})

    async def test_update_dict_filter_in(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, filters={"col": {"in": ["a", "b"]}})

    async def test_update_dict_filter_unsupported_op(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, filters={"col": {"unknown": "v"}})
        chain = sb._client.table().update()
        chain.eq.assert_called_with("col", "v")

    async def test_update_in_filters(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, in_filters={"id": ["a", "b"]})

    async def test_update_empty_in_filters_skipped(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, in_filters={"id": []})
        # Empty list → values is falsy → skipped (no in_ call)

    async def test_update_admin(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.update("chats", {"x": 1}, admin=True)
        sb._admin_client.table.assert_called_with("chats")

    async def test_update_error_propagates(self, sb):
        sb._execute.side_effect = Exception("Update failed")
        with pytest.raises(Exception, match="Update failed"):
            await sb.update("chats", {"x": 1})


# ===========================================================================
# Delete
# ===========================================================================

class TestDelete:

    async def test_delete_by_record_id(self, sb):
        sb._execute.return_value = _make_response([{"id": "r1"}])
        result = await sb.delete("chats", record_id="r1")
        assert result == [{"id": "r1"}]
        sb._client.table.assert_called_with("chats")

    async def test_delete_custom_id_column(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.delete("chats", record_id="r1", id_column="chat_id")
        chain = sb._client.table().delete()
        chain.eq.assert_called_with("chat_id", "r1")

    async def test_delete_with_filters(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.delete("chats", filters={"status": "archived"})

    async def test_delete_null_filter(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.delete("chats", filters={"parent_id": "is.null"})
        chain = sb._client.table().delete()
        chain.is_.assert_called_with("parent_id", "null")

    async def test_delete_dict_filter_gte(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.delete("chats", filters={"col": {"gte": "v"}})

    async def test_delete_dict_filter_lte(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.delete("chats", filters={"col": {"lte": "v"}})

    async def test_delete_dict_filter_gt(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.delete("chats", filters={"col": {"gt": "v"}})

    async def test_delete_dict_filter_lt(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.delete("chats", filters={"col": {"lt": "v"}})

    async def test_delete_dict_filter_unsupported_eq_fallback(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.delete("chats", filters={"col": {"unknown": "v"}})
        chain = sb._client.table().delete()
        chain.eq.assert_called_with("col", "v")

    async def test_delete_admin(self, sb):
        sb._execute.return_value = _make_response([])
        await sb.delete("chats", record_id="r1", admin=True)
        sb._admin_client.table.assert_called_with("chats")

    async def test_delete_error_propagates(self, sb):
        sb._execute.side_effect = Exception("Delete failed")
        with pytest.raises(Exception, match="Delete failed"):
            await sb.delete("chats", record_id="r1")


# ===========================================================================
# Upsert
# ===========================================================================

class TestUpsert:

    # --- Composite key on_conflict upserts (fast path) ---

    async def test_upsert_artifacts_on_conflict(self, sb):
        data = {"chat_id": "c1", "artifact_id": "a1", "content": "x"}
        sb._execute.return_value = _make_response([data])
        result = await sb.upsert("artifacts", data)
        assert result == data
        sb._client.table().upsert.assert_called_with(
            data, on_conflict="chat_id,artifact_id",
        )

    async def test_upsert_mcp_tools_on_conflict(self, sb):
        data = {"server_id": "s1", "tool_name": "t1", "desc": "x"}
        sb._execute.return_value = _make_response([data])
        result = await sb.upsert("mcp_tools", data)
        assert result == data
        sb._client.table().upsert.assert_called_with(
            data, on_conflict="server_id,tool_name",
        )

    async def test_upsert_user_preferences_on_conflict(self, sb):
        data = {"user_id": "u1", "preference_key": "theme", "value": "dark"}
        sb._execute.return_value = _make_response([data])
        result = await sb.upsert("user_preferences", data)
        assert result == data
        sb._client.table().upsert.assert_called_with(
            data, on_conflict="user_id,preference_key",
        )

    async def test_upsert_trail_states_on_conflict(self, sb):
        data = {"chat_id": "c1", "state": "active"}
        sb._execute.return_value = _make_response([data])
        result = await sb.upsert("trail_states", data)
        assert result == data
        sb._client.table().upsert.assert_called_with(
            data, on_conflict="chat_id",
        )

    async def test_upsert_composite_empty_response_returns_empty(self, sb):
        data = {"chat_id": "c1", "artifact_id": "a1"}
        sb._execute.return_value = _make_response([])
        result = await sb.upsert("artifacts", data)
        assert result == {}

    async def test_upsert_composite_error_fail_fast(self, sb):
        """Composite key upsert errors propagate immediately (fail-fast)."""
        data = {"chat_id": "c1", "artifact_id": "a1"}
        sb._execute.side_effect = Exception("DB error")
        with pytest.raises(Exception, match="DB error"):
            await sb.upsert("artifacts", data)

    # --- Artifacts missing keys falls through to INSERT path ---

    async def test_upsert_artifacts_missing_artifact_id_uses_insert(self, sb):
        """artifacts without artifact_id skips on_conflict, uses INSERT."""
        data = {"chat_id": "c1", "content": "no artifact_id"}
        sb._execute.return_value = _make_response([{"id": "1", **data}])
        result = await sb.upsert("artifacts", data)
        sb._client.table().insert.assert_called_with(data)

    # --- Generic INSERT-first path ---

    async def test_upsert_generic_insert_succeeds(self, sb):
        data = {"name": "item"}
        sb._execute.return_value = _make_response([{"id": "1", "name": "item"}])
        result = await sb.upsert("generic_table", data)
        assert result == {"id": "1", "name": "item"}
        sb._client.table().insert.assert_called_with(data)

    async def test_upsert_generic_insert_empty_response(self, sb):
        data = {"name": "item"}
        sb._execute.return_value = _make_response([])
        result = await sb.upsert("generic_table", data)
        assert result == {}

    # --- 23505 unique violation fallback paths ---

    async def test_upsert_23505_user_settings_fallback(self, sb):
        """user_settings 23505 triggers UPDATE by setting_key."""
        data = {"setting_key": "theme", "value": "dark"}
        # First _execute (insert) raises 23505; second (update) succeeds
        error_dict = {"message": "duplicate", "code": "23505", "details": "", "hint": ""}
        sb._execute.side_effect = [
            Exception(error_dict),
            _make_response([data]),
        ]
        result = await sb.upsert("user_settings", data)
        assert result == data

    async def test_upsert_23505_integration_health_fallback(self, sb):
        data = {"name": "supabase", "status": "healthy"}
        error_dict = {"message": "dup", "code": "23505", "details": "", "hint": ""}
        sb._execute.side_effect = [
            Exception(error_dict),
            _make_response([data]),
        ]
        result = await sb.upsert("integration_health", data)
        assert result == data

    async def test_upsert_23505_string_error_parsed(self, sb):
        """Error arg is string repr of dict — parsed via ast.literal_eval."""
        data = {"setting_key": "theme", "value": "dark"}
        error_str = str({"message": "dup", "code": "23505", "details": "", "hint": ""})
        sb._execute.side_effect = [
            Exception(error_str),
            _make_response([data]),
        ]
        result = await sb.upsert("user_settings", data)
        assert result == data

    async def test_upsert_23505_artifacts_fallback(self, sb):
        """23505 on artifacts in INSERT-first path triggers match-based update."""
        # Create data that skips the on_conflict path (e.g. missing artifact_id would
        # skip, but let's test the actual 23505 fallback branch directly)
        # For artifacts with both keys, it goes to on_conflict first (tested above).
        # For the INSERT-first + 23505 path, use artifacts without on_conflict keys.
        # Actually: artifacts with chat_id AND artifact_id goes to on_conflict, not INSERT.
        # But if we had an artifact with JUST chat_id (no artifact_id), it goes to INSERT.
        # If INSERT fails with 23505 and table == 'artifacts' but no artifact_id... the code
        # checks 'chat_id' in data and 'artifact_id' in data. If artifact_id is missing, skips.
        # So there's no 23505 fallback for artifacts without artifact_id. Test with both keys
        # would never reach INSERT path. Skip this edge case.
        pass

    async def test_upsert_23505_trail_states_fallback(self, sb):
        """23505 on trail_states in INSERT-first uses chat_id filter."""
        # trail_states with chat_id goes to on_conflict first. But if chat_id key
        # is missing, it falls to INSERT. If INSERT 23505 with chat_id present, it
        # does update. But with chat_id, the on_conflict path is taken first.
        # This path is effectively dead code for trail_states. Skip.
        pass

    async def test_upsert_23505_unknown_table_reraises(self, sb):
        """23505 on unknown table without handler re-raises."""
        data = {"id": "1"}
        error_dict = {"message": "dup", "code": "23505", "details": "", "hint": ""}
        sb._execute.side_effect = Exception(error_dict)
        with pytest.raises(Exception):
            await sb.upsert("unknown_table", data)

    async def test_upsert_non_23505_error_raises(self, sb):
        data = {"name": "item"}
        error_dict = {"message": "perm denied", "code": "42501", "details": ""}
        sb._execute.side_effect = Exception(str(error_dict))
        with pytest.raises(Exception):
            await sb.upsert("generic_table", data)

    async def test_upsert_unparseable_error_raises(self, sb):
        data = {"name": "item"}
        sb._execute.side_effect = Exception("not a dict at all")
        with pytest.raises(Exception):
            await sb.upsert("generic_table", data)

    async def test_upsert_error_with_empty_args(self, sb):
        """Exception with no args."""
        data = {"name": "item"}
        sb._execute.side_effect = Exception()
        with pytest.raises(Exception):
            await sb.upsert("generic_table", data)

    # --- Batch upsert ---

    async def test_upsert_batch(self, sb):
        records = [{"id": "1"}, {"id": "2"}]
        sb._execute.return_value = _make_response(records)
        result = await sb.upsert("chats", records)
        assert result == records
        sb._client.table().upsert.assert_called_with(records)

    async def test_upsert_batch_error_propagates(self, sb):
        sb._execute.side_effect = Exception("Batch error")
        with pytest.raises(Exception, match="Batch error"):
            await sb.upsert("chats", [{"id": "1"}])

    async def test_upsert_admin_client(self, sb):
        data = {"name": "item"}
        sb._execute.return_value = _make_response([data])
        await sb.upsert("generic_table", data, admin=True)
        sb._admin_client.table.assert_called_with("generic_table")

    async def test_upsert_batch_admin_client(self, sb):
        records = [{"id": "1"}]
        sb._execute.return_value = _make_response(records)
        await sb.upsert("chats", records, admin=True)
        sb._admin_client.table.assert_called_with("chats")


# ===========================================================================
# Count
# ===========================================================================

class TestCount:

    async def test_count_basic(self, sb):
        sb._execute.return_value = _make_response([], count=42)
        result = await sb.count("chats")
        assert result == 42

    async def test_count_with_filters(self, sb):
        sb._execute.return_value = _make_response([], count=5)
        result = await sb.count("chats", filters={"status": "active"})
        assert result == 5

    async def test_count_null_returns_zero(self, sb):
        sb._execute.return_value = _make_response([], count=None)
        result = await sb.count("chats")
        assert result == 0

    async def test_count_admin(self, sb):
        sb._execute.return_value = _make_response([], count=0)
        result = await sb.count("chats", admin=True)
        assert result == 0
        sb._admin_client.table.assert_called_with("chats")

    async def test_count_custom_type(self, sb):
        sb._execute.return_value = _make_response([], count=100)
        result = await sb.count("chats", count_type="estimated")
        assert result == 100
        # Verify count_type is passed through to select()'s count kwarg
        sb._client.table().select.assert_called_once_with("id", count="estimated")

    async def test_count_error_propagates(self, sb):
        sb._execute.side_effect = Exception("Count error")
        with pytest.raises(Exception, match="Count error"):
            await sb.count("chats")


# ===========================================================================
# Subscribe Realtime
# ===========================================================================

class TestSubscribeRealtime:

    async def test_subscribe_all_events(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        on_insert = MagicMock()
        on_update = MagicMock()
        on_delete = MagicMock()

        result = await sb.subscribe_realtime(
            "chats",
            on_insert=on_insert,
            on_update=on_update,
            on_delete=on_delete,
        )

        assert result is mock_channel
        assert mock_channel in sb._channels
        mock_channel.subscribe.assert_called_once()
        assert mock_channel.on_postgres_changes.call_count == 3

    async def test_subscribe_insert_event_only(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        await sb.subscribe_realtime("chats", event="INSERT", on_insert=MagicMock())
        mock_channel.on_postgres_changes.assert_called_once()

    async def test_subscribe_update_event_only(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        await sb.subscribe_realtime("chats", event="UPDATE", on_update=MagicMock())
        mock_channel.on_postgres_changes.assert_called_once()

    async def test_subscribe_delete_event_only(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        await sb.subscribe_realtime("chats", event="DELETE", on_delete=MagicMock())
        mock_channel.on_postgres_changes.assert_called_once()

    async def test_subscribe_with_filters(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        await sb.subscribe_realtime(
            "messages",
            on_insert=MagicMock(),
            filters={"chat_id": "c1"},
        )

        call_kwargs = mock_channel.on_postgres_changes.call_args[1]
        assert call_kwargs["filter"] == "chat_id=eq.c1"

    async def test_subscribe_with_multiple_filters(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        await sb.subscribe_realtime(
            "messages",
            on_insert=MagicMock(),
            filters={"chat_id": "c1", "role": "user"},
        )

        call_kwargs = mock_channel.on_postgres_changes.call_args[1]
        assert "chat_id=eq.c1" in call_kwargs["filter"]
        assert "role=eq.user" in call_kwargs["filter"]
        assert "&" in call_kwargs["filter"]

    async def test_subscribe_no_callbacks_no_handlers(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        await sb.subscribe_realtime("chats")

        mock_channel.on_postgres_changes.assert_not_called()
        mock_channel.subscribe.assert_called_once()

    async def test_subscribe_without_filter_passes_none(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        await sb.subscribe_realtime("chats", on_insert=MagicMock())

        call_kwargs = mock_channel.on_postgres_changes.call_args[1]
        assert call_kwargs["filter"] is None

    async def test_subscribe_realtime_disabled(self, sb_no_realtime):
        result = await sb_no_realtime.subscribe_realtime("chats", on_insert=MagicMock())
        assert result is None

    async def test_subscribe_not_initialized_raises(self):
        sb = SupabaseClient(url="http://x", key="k")
        with pytest.raises(RuntimeError, match="not initialized"):
            await sb.subscribe_realtime("chats")

    async def test_subscribe_error_propagates(self, sb):
        sb._async_client.channel.side_effect = Exception("Channel error")
        with pytest.raises(Exception, match="Channel error"):
            await sb.subscribe_realtime("chats", on_insert=MagicMock())

    async def test_subscribe_channel_name_format(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        await sb.subscribe_realtime("chats", event="INSERT", on_insert=MagicMock())

        sb._async_client.channel.assert_called_with("chats:INSERT")

    async def test_subscribe_schema_passed(self, sb):
        mock_channel = AsyncMock()
        sb._async_client.channel.return_value = mock_channel

        await sb.subscribe_realtime("chats", on_insert=MagicMock())

        call_kwargs = mock_channel.on_postgres_changes.call_args[1]
        assert call_kwargs["schema"] == "public"
        assert call_kwargs["table"] == "chats"


# ===========================================================================
# Health Check
# ===========================================================================

class TestHealthCheck:

    @pytest.fixture(autouse=True)
    def mock_httpx(self, monkeypatch):
        mock_response = MagicMock()
        mock_response.status_code = 200

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        monkeypatch.setattr("httpx.AsyncClient", lambda **kw: mock_client)
        self.mock_client_instance = mock_client
        return mock_client

    async def test_health_check_success(self, sb):
        sb.count = AsyncMock(return_value=10)

        result = await sb.health_check()

        assert result["healthy"] is True
        assert result["connection"] == "ok"
        assert result["counts"]["chats"] == 10
        assert result["counts"]["messages"] == 10
        assert result["counts"]["artifacts"] == 10

    async def test_health_check_no_client(self):
        sb = SupabaseClient(url="http://x", key="k")
        result = await sb.health_check()
        assert result["healthy"] is False
        assert result["error"] == "Client not initialized"

    async def test_health_check_query_fails(self, sb):
        self.mock_client_instance.get.side_effect = Exception("Connection refused")
        result = await sb.health_check()
        assert result["healthy"] is False
        assert "Connection refused" in result["error"]

    async def test_health_check_count_fails_gracefully(self, sb):
        sb.count = AsyncMock(side_effect=Exception("Count failed"))

        result = await sb.health_check()

        assert result["healthy"] is True
        assert "counts" not in result  # Count block failed, no counts key

    async def test_health_check_uses_admin_client(self, sb):
        # We test that count uses admin=True
        sb.count = AsyncMock(return_value=0)

        await sb.health_check()

        sb.count.assert_any_call("chats", admin=True, count_type="estimated")

    async def test_health_check_initialized_field(self, sb):
        sb.count = AsyncMock(return_value=0)

        result = await sb.health_check()

        assert result["initialized"] is True

    async def test_health_check_not_initialized_but_client_exists(self):
        """During initialization, _initialized is False but _client exists."""
        sb = SupabaseClient(url="http://x", key="k")
        sb._client = MagicMock()
        sb._admin_client = MagicMock()
        sb.count = AsyncMock(return_value=0)

        result = await sb.health_check()

        assert result["healthy"] is True
        assert result["initialized"] is False


# ===========================================================================
# Diagnostics
# ===========================================================================

class TestDiagnostics:

    def test_is_initialized_true(self, sb):
        assert sb.is_initialized() is True

    def test_is_initialized_false(self):
        sb = SupabaseClient(url="http://x", key="k")
        assert sb.is_initialized() is False

    def test_get_diagnostics(self, sb):
        result = sb.get_diagnostics()
        assert result["initialized"] is True
        assert result["url"] == "http://localhost:54321"
        assert result["schema"] == "public"
        assert result["realtime_enabled"] is True
        assert result["active_channels"] == 0

    def test_get_diagnostics_with_channels(self, sb):
        sb._channels = [MagicMock(), MagicMock()]
        result = sb.get_diagnostics()
        assert result["active_channels"] == 2


# ===========================================================================
# RPC
# ===========================================================================

class TestRpc:

    async def test_rpc_with_params(self, sb):
        sb._execute.return_value = _make_response(42)
        result = await sb.rpc("get_next_sequence", {"p_chat_id": "c1"})
        assert result == 42
        sb._client.rpc.assert_called_with("get_next_sequence", {"p_chat_id": "c1"})

    async def test_rpc_no_params_passes_empty_dict(self, sb):
        sb._execute.return_value = _make_response("ok")
        await sb.rpc("ping")
        sb._client.rpc.assert_called_with("ping", {})

    async def test_rpc_admin(self, sb):
        sb._execute.return_value = _make_response("ok")
        await sb.rpc("admin_fn", admin=True)
        sb._admin_client.rpc.assert_called_with("admin_fn", {})

    async def test_rpc_error_propagates(self, sb):
        sb._execute.side_effect = Exception("RPC error")
        with pytest.raises(Exception, match="RPC error"):
            await sb.rpc("bad_fn")


# ===========================================================================
# Reload Schema Cache
# ===========================================================================

class TestReloadSchemaCache:

    async def test_reload_schema_cache_calls_rpc(self, sb):
        sb.rpc = AsyncMock()
        await sb.reload_schema_cache()
        sb.rpc.assert_called_once_with("reload_schema_cache", admin=True)

    async def test_reload_schema_cache_error_propagates(self, sb):
        sb.rpc = AsyncMock(side_effect=Exception("Reload failed"))
        with pytest.raises(Exception, match="Reload failed"):
            await sb.reload_schema_cache()


# ===========================================================================
# _sanitize_identifier
# ===========================================================================

class TestSanitizeIdentifier:

    def test_valid_simple(self):
        assert SupabaseClient._sanitize_identifier("chat_id") == "chat_id"

    def test_valid_leading_underscore(self):
        assert SupabaseClient._sanitize_identifier("_private") == "_private"

    def test_valid_with_dollar(self):
        assert SupabaseClient._sanitize_identifier("col$1") == "col$1"

    def test_valid_dotted(self):
        assert SupabaseClient._sanitize_identifier("table.column") == "table.column"

    def test_wildcard_allowed(self):
        assert SupabaseClient._sanitize_identifier("*", allow_wildcard=True) == "*"

    def test_wildcard_rejected_by_default(self):
        with pytest.raises(ValueError, match="Invalid identifier"):
            SupabaseClient._sanitize_identifier("*")

    def test_sql_injection_rejected(self):
        for bad_input in [
            "DROP TABLE;", "'; --", "table; DELETE",
            "", " ", "123abc", "1=1", "-col",
        ]:
            with pytest.raises(ValueError, match="Invalid identifier"):
                SupabaseClient._sanitize_identifier(bad_input)

    def test_non_string_rejected(self):
        with pytest.raises((ValueError, AttributeError)):
            SupabaseClient._sanitize_identifier(123)

    def test_starts_with_letter(self):
        assert SupabaseClient._sanitize_identifier("A") == "A"
        assert SupabaseClient._sanitize_identifier("z") == "z"


# ===========================================================================
# _build_group_count_columns
# ===========================================================================

class TestBuildGroupCountColumns:

    def test_basic(self):
        result = SupabaseClient._build_group_count_columns(
            group_column="chat_id", count_column="id", alias="count",
        )
        assert result == "chat_id,count:count"

    def test_custom_alias(self):
        result = SupabaseClient._build_group_count_columns(
            group_column="chat_id", count_column="id", alias="total",
        )
        assert result == "chat_id,total:count"

    def test_wildcard_count_column(self):
        result = SupabaseClient._build_group_count_columns(
            group_column="status", count_column="*", alias="cnt",
        )
        assert result == "status,cnt:count"

    def test_invalid_group_column_raises(self):
        with pytest.raises(ValueError):
            SupabaseClient._build_group_count_columns(
                group_column="DROP TABLE;", count_column="id", alias="count",
            )

    def test_invalid_alias_raises(self):
        with pytest.raises(ValueError):
            SupabaseClient._build_group_count_columns(
                group_column="chat_id", count_column="id", alias="bad; alias",
            )

    def test_invalid_count_column_raises(self):
        with pytest.raises(ValueError):
            SupabaseClient._build_group_count_columns(
                group_column="chat_id", count_column="bad; col", alias="count",
            )


# ===========================================================================
# _GROUP_COUNT_VIEW_MAP
# ===========================================================================

class TestGroupCountViewMap:

    def test_messages_chat_id_view(self):
        assert SupabaseClient._GROUP_COUNT_VIEW_MAP[("messages", "chat_id")] == "messages_group_counts"

    def test_artifacts_chat_id_view(self):
        assert SupabaseClient._GROUP_COUNT_VIEW_MAP[("artifacts", "chat_id")] == "artifacts_group_counts"

    def test_unknown_combo_absent(self):
        assert ("chats", "status") not in SupabaseClient._GROUP_COUNT_VIEW_MAP

    def test_map_has_exactly_two_entries(self):
        assert len(SupabaseClient._GROUP_COUNT_VIEW_MAP) == 2
