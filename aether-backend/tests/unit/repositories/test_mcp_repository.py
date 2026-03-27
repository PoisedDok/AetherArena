"""
Tests for data/database/repositories/mcp.py

Covers: MCPRepository constructor, Server CRUD (create, get, get_by_name,
list, update_status, update_health, update_server, delete), Tool operations
(upsert_tools, get_tools, get_tool), Execution operations (log_execution,
update_execution, get_execution_history, get_server_stats).
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4
from datetime import datetime, timezone

from data.database.repositories.mcp import MCPRepository
from data.database.models.mcp import MCPServer
from data.database.persistence_gateway import SupabasePersistenceGateway


# ===========================================================================
# Helpers
# ===========================================================================

SERVER_ID = uuid4()
TOOL_ID = uuid4()
EXEC_ID = uuid4()
NOW_ISO = datetime.now(timezone.utc).isoformat()

SAMPLE_SERVER = {
    "id": str(SERVER_ID),
    "name": "test-server",
    "display_name": "Test Server",
    "description": "A test server",
    "server_type": "local",
    "config": {"command": "node", "args": ["server.js"]},
    "status": "active",
    "error_message": None,
    "created_at": NOW_ISO,
    "updated_at": NOW_ISO,
    "last_health_check": None,
    "health_status": None,
    "enabled": True,
    "auto_start": True,
    "sandbox_enabled": True,
    "resource_limits": {"max_memory_mb": 512},
    "total_tool_calls": 0,
    "total_errors": 0,
    "last_used_at": None,
}

SAMPLE_TOOL_ROW = {
    "id": str(TOOL_ID),
    "server_id": str(SERVER_ID),
    "tool_name": "read_file",
    "description": "Read a file",
    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
    "openai_schema": {},
    "enabled": True,
    "created_at": NOW_ISO,
    "updated_at": NOW_ISO,
}

SAMPLE_EXECUTION = {
    "id": str(EXEC_ID),
    "server_id": str(SERVER_ID),
    "tool_name": "read_file",
    "arguments": {"path": "/tmp/test.txt"},
    "result": "file content",
    "status": "success",
    "error_message": None,
    "executed_at": NOW_ISO,
    "duration_ms": 42,
    "execution_context": None,
    "sandboxed": True,
}


def _make_gateway():
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.insert = AsyncMock()
    gw.select = AsyncMock(return_value=[])
    gw.update = AsyncMock()
    gw.delete = AsyncMock()
    gw.upsert = AsyncMock()
    gw.count = AsyncMock(return_value=0)
    return gw


@pytest.fixture
def repo():
    gw = _make_gateway()
    return MCPRepository(db=gw), gw


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_with_gateway(self):
        gw = _make_gateway()
        r = MCPRepository(db=gw)
        assert r._gateway is gw

    def test_with_supabase_client(self):
        from data.database.clients.supabase import SupabaseClient
        mock_client = MagicMock(spec=SupabaseClient)
        r = MCPRepository(db=mock_client)
        assert r._gateway is not None

    def test_with_none_raises(self):
        with pytest.raises(ValueError):
            MCPRepository(db=None)

    def test_with_session_raises(self):
        with pytest.raises(RuntimeError, match="SQLAlchemy"):
            MCPRepository(db=None, session=MagicMock())

    def test_with_unsupported_type_raises(self):
        with pytest.raises(TypeError):
            MCPRepository(db="invalid")


# ===========================================================================
# Server Operations
# ===========================================================================

class TestCreateServer:

    async def test_create_basic(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_SERVER]
        server = await r.create_server(
            "test-server", "Test Server", "local",
            config={"command": "node"},
        )
        assert server.name == "test-server"
        assert server.display_name == "Test Server"
        assert server.server_type == "local"
        assert server.status == "active"
        assert server.enabled is True
        gw.insert.assert_called_once()
        # Verify table name and admin flag
        call_args = gw.insert.call_args
        assert call_args[0][0] == "mcp_servers"
        assert call_args[1]["admin"] is True

    async def test_create_with_all_params(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_SERVER]
        server = await r.create_server(
            "srv", "Server", "local",
            config={}, description="desc",
            enabled=False, auto_start=False,
            sandbox_enabled=False,
            resource_limits={"max_memory_mb": 1024},
        )
        call_data = gw.insert.call_args[0][1]
        assert call_data["description"] == "desc"
        assert call_data["enabled"] is False
        assert call_data["resource_limits"]["max_memory_mb"] == 1024

    async def test_create_default_resource_limits(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_SERVER]
        await r.create_server("s", "S", "local", config={})
        call_data = gw.insert.call_args[0][1]
        assert call_data["resource_limits"]["max_memory_mb"] == 512

    async def test_create_empty_result_raises(self, repo):
        r, gw = repo
        gw.insert.return_value = []
        with pytest.raises(RuntimeError, match="Failed to create"):
            await r.create_server("s", "S", "local", config={})


class TestGetServer:

    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_SERVER]
        server = await r.get_server(SERVER_ID)
        assert server.name == "test-server"

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        assert await r.get_server(uuid4()) is None


class TestGetServerByName:

    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_SERVER]
        server = await r.get_server_by_name("test-server")
        assert server.name == "test-server"

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        assert await r.get_server_by_name("nonexistent") is None


class TestListServers:

    async def test_list_all(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_SERVER]
        servers = await r.list_servers()
        assert len(servers) == 1
        assert isinstance(servers[0], MCPServer)
        assert servers[0].name == "test-server"

    async def test_enabled_only(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_SERVER]
        await r.list_servers(enabled_only=True)
        call_kwargs = gw.select.call_args[1]
        assert call_kwargs["filters"]["enabled"] is True

    async def test_type_filter(self, repo):
        r, gw = repo
        gw.select.return_value = []
        await r.list_servers(server_type="remote")
        call_kwargs = gw.select.call_args[1]
        assert call_kwargs["filters"]["server_type"] == "remote"

    async def test_no_filters(self, repo):
        r, gw = repo
        gw.select.return_value = []
        await r.list_servers()
        call_kwargs = gw.select.call_args[1]
        assert call_kwargs["filters"] == {}


class TestUpdateServerStatus:

    async def test_update_status(self, repo):
        r, gw = repo
        updated = {**SAMPLE_SERVER, "status": "error"}
        gw.update.return_value = [updated]
        server = await r.update_server_status(SERVER_ID, "error")
        assert server.status == "error"

    async def test_update_with_error_message(self, repo):
        r, gw = repo
        gw.update.return_value = [{**SAMPLE_SERVER, "status": "error", "error_message": "crash"}]
        server = await r.update_server_status(SERVER_ID, "error", error_message="crash")
        assert server.error_message == "crash"

    async def test_empty_result_returns_none(self, repo):
        r, gw = repo
        gw.update.return_value = []
        result = await r.update_server_status(SERVER_ID, "active")
        assert result is None

    async def test_not_found_error_returns_none(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("not found")
        result = await r.update_server_status(SERVER_ID, "active")
        assert result is None

    async def test_other_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("DB crash")
        with pytest.raises(Exception, match="DB crash"):
            await r.update_server_status(SERVER_ID, "active")


class TestUpdateServerHealth:

    async def test_update_health(self, repo):
        r, gw = repo
        now = datetime.now(timezone.utc)
        gw.update.return_value = [{**SAMPLE_SERVER, "health_status": "healthy"}]
        server = await r.update_server_health(SERVER_ID, "healthy", now)
        assert server is not None
        assert server.health_status == "healthy"
        # Verify the gateway was called with the correct data
        call_data = gw.update.call_args[0][1]
        assert call_data["health_status"] == "healthy"
        assert call_data["last_health_check"] == now.isoformat()

    async def test_empty_result_returns_none(self, repo):
        r, gw = repo
        gw.update.return_value = []
        result = await r.update_server_health(
            SERVER_ID, "healthy", datetime.now(timezone.utc)
        )
        assert result is None

    async def test_not_found_returns_none(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("not found")
        result = await r.update_server_health(
            SERVER_ID, "healthy", datetime.now(timezone.utc)
        )
        assert result is None

    async def test_other_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("permission denied")
        with pytest.raises(Exception, match="permission denied"):
            await r.update_server_health(
                SERVER_ID, "healthy", datetime.now(timezone.utc)
            )


class TestUpdateServer:

    async def test_update_fields(self, repo):
        r, gw = repo
        gw.update.return_value = [{**SAMPLE_SERVER, "display_name": "New Name"}]
        server = await r.update_server(SERVER_ID, display_name="New Name")
        assert server.display_name == "New Name"

    async def test_update_all_fields(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_SERVER]
        await r.update_server(
            SERVER_ID,
            display_name="N", description="D",
            config={"x": 1}, auto_start=False, enabled=False,
        )
        call_data = gw.update.call_args[0][1]
        assert call_data["display_name"] == "N"
        assert call_data["description"] == "D"
        assert call_data["config"] == {"x": 1}
        assert call_data["auto_start"] is False
        assert call_data["enabled"] is False

    async def test_empty_result_returns_none(self, repo):
        r, gw = repo
        gw.update.return_value = []
        result = await r.update_server(SERVER_ID, display_name="X")
        assert result is None

    async def test_not_found_error_returns_none(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("not found")
        result = await r.update_server(SERVER_ID, display_name="X")
        assert result is None

    async def test_other_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("DB crash")
        with pytest.raises(Exception, match="DB crash"):
            await r.update_server(SERVER_ID, display_name="X")

    async def test_none_values_excluded(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_SERVER]
        await r.update_server(SERVER_ID, display_name=None, enabled=None)
        call_data = gw.update.call_args[0][1]
        assert "display_name" not in call_data
        assert "enabled" not in call_data


class TestDeleteServer:

    async def test_delete_success(self, repo):
        r, gw = repo
        gw.delete.return_value = None
        result = await r.delete_server(SERVER_ID)
        assert result is True

    async def test_not_found_returns_false(self, repo):
        r, gw = repo
        gw.delete.side_effect = Exception("not found")
        result = await r.delete_server(SERVER_ID)
        assert result is False

    async def test_other_error_propagates(self, repo):
        r, gw = repo
        gw.delete.side_effect = Exception("permission denied")
        with pytest.raises(Exception, match="permission denied"):
            await r.delete_server(SERVER_ID)


# ===========================================================================
# Tool Operations
# ===========================================================================

class TestUpsertTools:

    async def test_basic_tool(self, repo):
        r, gw = repo
        gw.upsert.return_value = [SAMPLE_TOOL_ROW]
        tools = await r.upsert_tools(SERVER_ID, [
            {"name": "read_file", "description": "Read a file", "inputSchema": {}}
        ])
        assert len(tools) == 1
        assert tools[0].name == "read_file"

    async def test_function_format_tool(self, repo):
        """Tool with OpenAI function format (name inside .function)."""
        r, gw = repo
        gw.upsert.return_value = [SAMPLE_TOOL_ROW]
        tools = await r.upsert_tools(SERVER_ID, [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read",
                    "parameters": {"type": "object"},
                },
            }
        ])
        assert len(tools) == 1

    async def test_tool_without_name_skipped(self, repo):
        r, gw = repo
        tools = await r.upsert_tools(SERVER_ID, [
            {"description": "No name field"}
        ])
        assert len(tools) == 0
        gw.upsert.assert_not_called()

    async def test_non_dict_tool_skipped(self, repo):
        r, gw = repo
        tools = await r.upsert_tools(SERVER_ID, ["not-a-dict"])
        assert len(tools) == 0

    async def test_tool_with_no_input_schema_defaults_empty(self, repo):
        r, gw = repo
        gw.upsert.return_value = [SAMPLE_TOOL_ROW]
        tools = await r.upsert_tools(SERVER_ID, [
            {"name": "simple_tool"}
        ])
        call_data = gw.upsert.call_args[0][1]
        assert call_data["parameters"] == {}

    async def test_multiple_tools(self, repo):
        r, gw = repo
        tool_row_2 = {**SAMPLE_TOOL_ROW, "id": str(uuid4()), "tool_name": "write_file"}
        gw.upsert.side_effect = [[SAMPLE_TOOL_ROW], [tool_row_2]]
        tools = await r.upsert_tools(SERVER_ID, [
            {"name": "read_file", "inputSchema": {}},
            {"name": "write_file", "inputSchema": {}},
        ])
        assert len(tools) == 2

    async def test_openai_schema_built_for_plain_tool(self, repo):
        """Tool without 'function' key should get openai_schema auto-built."""
        r, gw = repo
        gw.upsert.return_value = [SAMPLE_TOOL_ROW]
        await r.upsert_tools(SERVER_ID, [
            {"name": "my_tool", "description": "Do stuff", "inputSchema": {"type": "object"}}
        ])
        call_data = gw.upsert.call_args[0][1]
        schema = call_data["openai_schema"]
        assert schema["type"] == "function"
        assert schema["function"]["name"] == "my_tool"

    async def test_description_from_function(self, repo):
        """Description falls back to function.description."""
        r, gw = repo
        gw.upsert.return_value = [SAMPLE_TOOL_ROW]
        await r.upsert_tools(SERVER_ID, [
            {
                "function": {
                    "name": "fn_tool",
                    "description": "From function",
                    "parameters": {},
                }
            }
        ])
        call_data = gw.upsert.call_args[0][1]
        assert call_data["description"] == "From function"

    async def test_input_schema_from_function_parameters(self, repo):
        r, gw = repo
        gw.upsert.return_value = [SAMPLE_TOOL_ROW]
        await r.upsert_tools(SERVER_ID, [
            {
                "function": {
                    "name": "fn_tool",
                    "parameters": {"type": "object", "properties": {}},
                }
            }
        ])
        call_data = gw.upsert.call_args[0][1]
        assert call_data["parameters"]["type"] == "object"

    async def test_tool_with_name_and_function_dict(self, repo):
        """Tool has top-level 'name' AND a nested 'function' dict.

        This hits the late-binding fallback (line 383-384) where function_schema
        was empty because tool_name was resolved from top-level 'name', but the
        tool still carries a 'function' dict for openai_schema enrichment.
        """
        r, gw = repo
        gw.upsert.return_value = [SAMPLE_TOOL_ROW]
        await r.upsert_tools(SERVER_ID, [
            {
                "name": "read_file",
                "description": "Read a file",
                "inputSchema": {"type": "object"},
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {"type": "object"},
                },
            }
        ])
        call_data = gw.upsert.call_args[0][1]
        schema = call_data["openai_schema"]
        assert schema["function"]["name"] == "read_file"


class TestGetTools:

    async def test_get_all(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_TOOL_ROW]
        tools = await r.get_tools(SERVER_ID, enabled_only=False)
        assert len(tools) == 1
        assert tools[0].name == "read_file"

    async def test_enabled_only_filter(self, repo):
        r, gw = repo
        disabled_row = {**SAMPLE_TOOL_ROW, "enabled": False}
        gw.select.return_value = [SAMPLE_TOOL_ROW, disabled_row]
        tools = await r.get_tools(SERVER_ID, enabled_only=True)
        assert len(tools) == 1

    async def test_empty_result(self, repo):
        r, gw = repo
        gw.select.return_value = []
        tools = await r.get_tools(SERVER_ID)
        assert tools == []


class TestGetTool:

    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_TOOL_ROW]
        tool = await r.get_tool(SERVER_ID, "read_file")
        assert tool.name == "read_file"

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        tool = await r.get_tool(SERVER_ID, "nonexistent")
        assert tool is None


# ===========================================================================
# Execution Operations
# ===========================================================================

class TestLogExecution:

    async def test_basic_log(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_EXECUTION]
        execution = await r.log_execution(
            SERVER_ID, "read_file", {"path": "/tmp/test.txt"},
        )
        assert execution.tool_name == "read_file"

    async def test_log_with_all_params(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_EXECUTION]
        await r.log_execution(
            SERVER_ID, "read_file", {"path": "/tmp"},
            result={"content": "hello"},
            error=None,
            execution_time_ms=42,
            status="success",
            execution_context={"chat_id": "c1"},
            sandboxed=True,
        )
        call_data = gw.insert.call_args[0][1]
        assert call_data["result"] == json.dumps({"content": "hello"})
        assert call_data["duration_ms"] == 42

    async def test_log_result_as_string(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_EXECUTION]
        await r.log_execution(
            SERVER_ID, "tool", {}, result="plain string",
        )
        call_data = gw.insert.call_args[0][1]
        assert call_data["result"] == "plain string"

    async def test_log_result_as_list(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_EXECUTION]
        await r.log_execution(
            SERVER_ID, "tool", {}, result=[1, 2, 3],
        )
        call_data = gw.insert.call_args[0][1]
        assert call_data["result"] == json.dumps([1, 2, 3])


class TestUpdateExecution:

    async def test_update_success(self, repo):
        r, gw = repo
        gw.update.return_value = [{**SAMPLE_EXECUTION, "status": "success"}]
        execution = await r.update_execution(EXEC_ID, status="success")
        assert execution.status == "success"

    async def test_update_with_result_dict(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_EXECUTION]
        await r.update_execution(EXEC_ID, result={"data": "x"})
        call_data = gw.update.call_args[0][1]
        assert call_data["result"] == json.dumps({"data": "x"})

    async def test_update_with_error(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_EXECUTION]
        await r.update_execution(EXEC_ID, error="fail", status="error")
        call_data = gw.update.call_args[0][1]
        assert call_data["error_message"] == "fail"

    async def test_update_with_execution_time(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_EXECUTION]
        await r.update_execution(EXEC_ID, execution_time_ms=100)
        call_data = gw.update.call_args[0][1]
        assert call_data["duration_ms"] == 100

    async def test_empty_result_returns_none(self, repo):
        r, gw = repo
        gw.update.return_value = []
        result = await r.update_execution(EXEC_ID)
        assert result is None

    async def test_not_found_returns_none(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("not found")
        result = await r.update_execution(EXEC_ID)
        assert result is None

    async def test_other_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("DB crash")
        with pytest.raises(Exception, match="DB crash"):
            await r.update_execution(EXEC_ID)


class TestGetExecutionHistory:

    async def test_no_filters(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_EXECUTION]
        history = await r.get_execution_history()
        assert len(history) == 1

    async def test_all_filters(self, repo):
        r, gw = repo
        gw.select.return_value = []
        await r.get_execution_history(
            server_id=SERVER_ID,
            tool_name="read_file",
            status="success",
            limit=10,
            offset=5,
        )
        call_kwargs = gw.select.call_args[1]
        assert call_kwargs["filters"]["server_id"] == str(SERVER_ID)
        assert call_kwargs["filters"]["tool_name"] == "read_file"
        assert call_kwargs["filters"]["status"] == "success"
        assert call_kwargs["limit"] == 10
        assert call_kwargs["offset"] == 5


class TestGetServerStats:

    async def test_stats(self, repo):
        r, gw = repo
        gw.select.side_effect = [
            [{"id": "1"}, {"id": "2"}],                       # tools
            [{"status": "success"}, {"status": "error"}, {"status": "success"}],  # executions
        ]
        stats = await r.get_server_stats(SERVER_ID)
        assert stats == {
            "tool_count": 2,
            "execution_count": 3,
            "success_count": 2,
            "error_count": 1,
        }

    async def test_stats_empty(self, repo):
        r, gw = repo
        gw.select.side_effect = [[], []]
        stats = await r.get_server_stats(SERVER_ID)
        assert stats == {
            "tool_count": 0,
            "execution_count": 0,
            "success_count": 0,
            "error_count": 0,
        }

    async def test_stats_pending_status_not_counted_as_success_or_error(self, repo):
        """Execution with status 'pending' should not inflate success/error."""
        r, gw = repo
        gw.select.side_effect = [
            [],
            [{"status": "pending"}, {"status": "pending"}],
        ]
        stats = await r.get_server_stats(SERVER_ID)
        assert stats["execution_count"] == 2
        assert stats["success_count"] == 0
        assert stats["error_count"] == 0
