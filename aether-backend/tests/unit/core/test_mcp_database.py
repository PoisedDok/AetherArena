"""
Tests for core.mcp.database — MCPDatabase Supabase wrapper.

Covers all 17 public methods:
- Constructor validation
- initialize / close lifecycle
- CRUD: create_server, get_server, get_server_by_name, list_servers,
        update_server_status, update_health_status, update_server, delete_server
- Tools: upsert_tools, get_tools, get_tool
- Execution: log_execution, update_execution, get_execution_history
- Stats: get_server_stats

Every method delegates to self._repository and transforms the result via model_dump().
Tests verify:
  1. Correct delegation (call args)
  2. Return value transformation (model_dump called)
  3. None handling for Optional returns
  4. Error paths (constructor, initialize, update_server not found)
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from core.mcp.database import MCPDatabase


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_model(data: dict) -> MagicMock:
    """Create a mock Pydantic model with model_dump()."""
    model = MagicMock()
    model.model_dump.return_value = data
    return model


def _make_repo() -> MagicMock:
    """Create a mock repository with all async methods."""
    repo = MagicMock()
    repo.create_server = AsyncMock()
    repo.get_server = AsyncMock()
    repo.get_server_by_name = AsyncMock()
    repo.list_servers = AsyncMock()
    repo.update_server_status = AsyncMock()
    repo.update_server_health = AsyncMock()
    repo.update_server = AsyncMock()
    repo.delete_server = AsyncMock()
    repo.upsert_tools = AsyncMock()
    repo.get_tools = AsyncMock()
    repo.get_tool = AsyncMock()
    repo.log_execution = AsyncMock()
    repo.update_execution = AsyncMock()
    repo.get_execution_history = AsyncMock()
    repo.get_server_stats = AsyncMock()
    return repo


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------

class TestConstructor:
    def test_raises_on_none_repository(self):
        with pytest.raises(ValueError, match="requires a repository instance"):
            MCPDatabase(repository=None)

    def test_stores_repository(self):
        repo = _make_repo()
        db = MCPDatabase(repository=repo)
        assert db._repository is repo


# ---------------------------------------------------------------------------
# Initialize / Close
# ---------------------------------------------------------------------------

class TestInitialize:
    async def test_success(self):
        repo = _make_repo()
        db = MCPDatabase(repository=repo)
        await db.initialize()
        # No exception means success — repo is not None

    async def test_raises_if_repository_becomes_none(self):
        repo = _make_repo()
        db = MCPDatabase(repository=repo)
        db._repository = None
        with pytest.raises(RuntimeError, match="Database initialization failed"):
            await db.initialize()


class TestClose:
    async def test_close_succeeds(self):
        repo = _make_repo()
        db = MCPDatabase(repository=repo)
        await db.close()
        # No exception — just logs


# ---------------------------------------------------------------------------
# Server Operations
# ---------------------------------------------------------------------------

class TestCreateServer:
    async def test_delegates_and_returns_dict(self):
        repo = _make_repo()
        server_data = {"id": str(uuid4()), "name": "test-srv"}
        repo.create_server.return_value = _make_model(server_data)
        db = MCPDatabase(repository=repo)

        result = await db.create_server(
            name="test-srv",
            display_name="Test Server",
            server_type="local",
            config={"command": "python"},
            description="A test",
            enabled=True,
            auto_start=True,
            sandbox_enabled=True,
            resource_limits={"max_memory_mb": 256},
        )

        assert result == server_data
        repo.create_server.assert_awaited_once_with(
            name="test-srv",
            display_name="Test Server",
            server_type="local",
            config={"command": "python"},
            description="A test",
            enabled=True,
            auto_start=True,
            sandbox_enabled=True,
            resource_limits={"max_memory_mb": 256},
        )


class TestGetServer:
    async def test_returns_dict_when_found(self):
        repo = _make_repo()
        sid = uuid4()
        data = {"id": str(sid), "name": "srv"}
        repo.get_server.return_value = _make_model(data)
        db = MCPDatabase(repository=repo)

        result = await db.get_server(sid)
        assert result == data
        repo.get_server.assert_awaited_once_with(sid)

    async def test_returns_none_when_not_found(self):
        repo = _make_repo()
        repo.get_server.return_value = None
        db = MCPDatabase(repository=repo)

        result = await db.get_server(uuid4())
        assert result is None


class TestGetServerByName:
    async def test_returns_dict_when_found(self):
        repo = _make_repo()
        data = {"id": str(uuid4()), "name": "my-srv"}
        repo.get_server_by_name.return_value = _make_model(data)
        db = MCPDatabase(repository=repo)

        result = await db.get_server_by_name("my-srv")
        assert result == data
        repo.get_server_by_name.assert_awaited_once_with("my-srv")

    async def test_returns_none_when_not_found(self):
        repo = _make_repo()
        repo.get_server_by_name.return_value = None
        db = MCPDatabase(repository=repo)

        result = await db.get_server_by_name("nonexistent")
        assert result is None


class TestListServers:
    async def test_returns_list_of_dicts(self):
        repo = _make_repo()
        models = [
            _make_model({"id": "1", "name": "a"}),
            _make_model({"id": "2", "name": "b"}),
        ]
        repo.list_servers.return_value = models
        db = MCPDatabase(repository=repo)

        result = await db.list_servers(enabled_only=True, server_type="local")
        assert result == [{"id": "1", "name": "a"}, {"id": "2", "name": "b"}]
        repo.list_servers.assert_awaited_once_with(enabled_only=True, server_type="local")

    async def test_returns_empty_list(self):
        repo = _make_repo()
        repo.list_servers.return_value = []
        db = MCPDatabase(repository=repo)

        result = await db.list_servers()
        assert result == []


class TestUpdateServerStatus:
    async def test_returns_dict_when_found(self):
        repo = _make_repo()
        sid = uuid4()
        data = {"id": str(sid), "status": "active"}
        repo.update_server_status.return_value = _make_model(data)
        db = MCPDatabase(repository=repo)

        result = await db.update_server_status(sid, "active", error_message=None)
        assert result == data
        repo.update_server_status.assert_awaited_once_with(
            server_id=sid, status="active", error_message=None
        )

    async def test_returns_none_when_not_found(self):
        repo = _make_repo()
        repo.update_server_status.return_value = None
        db = MCPDatabase(repository=repo)

        result = await db.update_server_status(uuid4(), "error", error_message="boom")
        assert result is None


class TestUpdateHealthStatus:
    async def test_returns_dict_when_found(self):
        repo = _make_repo()
        sid = uuid4()
        now = datetime.utcnow()
        data = {"id": str(sid), "health_status": "healthy"}
        repo.update_server_health.return_value = _make_model(data)
        db = MCPDatabase(repository=repo)

        result = await db.update_health_status(sid, "healthy", now)
        assert result == data
        repo.update_server_health.assert_awaited_once_with(
            server_id=sid, health_status="healthy", last_health_check=now
        )

    async def test_returns_none_when_not_found(self):
        repo = _make_repo()
        repo.update_server_health.return_value = None
        db = MCPDatabase(repository=repo)

        result = await db.update_health_status(uuid4(), "unhealthy", datetime.utcnow())
        assert result is None


class TestUpdateServer:
    async def test_returns_updated_dict(self):
        repo = _make_repo()
        sid = uuid4()
        data = {"id": str(sid), "display_name": "New Name"}
        repo.update_server.return_value = _make_model(data)
        db = MCPDatabase(repository=repo)

        result = await db.update_server(sid, display_name="New Name")
        assert result == data
        repo.update_server.assert_awaited_once_with(sid, display_name="New Name")

    async def test_raises_when_not_found(self):
        repo = _make_repo()
        sid = uuid4()
        repo.update_server.return_value = None
        db = MCPDatabase(repository=repo)

        with pytest.raises(ValueError, match=str(sid)):
            await db.update_server(sid, enabled=False)


class TestDeleteServer:
    async def test_delegates_and_returns_bool(self):
        repo = _make_repo()
        sid = uuid4()
        repo.delete_server.return_value = True
        db = MCPDatabase(repository=repo)

        result = await db.delete_server(sid)
        assert result is True
        repo.delete_server.assert_awaited_once_with(sid)


# ---------------------------------------------------------------------------
# Tool Operations
# ---------------------------------------------------------------------------

class TestUpsertTools:
    async def test_returns_list_of_dicts(self):
        repo = _make_repo()
        sid = uuid4()
        tool_models = [
            _make_model({"name": "tool1", "enabled": True}),
            _make_model({"name": "tool2", "enabled": True}),
        ]
        repo.upsert_tools.return_value = tool_models
        db = MCPDatabase(repository=repo)

        tools_input = [{"name": "tool1"}, {"name": "tool2"}]
        result = await db.upsert_tools(sid, tools_input)
        assert result == [
            {"name": "tool1", "enabled": True},
            {"name": "tool2", "enabled": True},
        ]
        repo.upsert_tools.assert_awaited_once_with(sid, tools_input)


class TestGetTools:
    async def test_returns_list_of_dicts(self):
        repo = _make_repo()
        sid = uuid4()
        repo.get_tools.return_value = [_make_model({"name": "t1"})]
        db = MCPDatabase(repository=repo)

        result = await db.get_tools(sid, enabled_only=False)
        assert result == [{"name": "t1"}]
        repo.get_tools.assert_awaited_once_with(sid, False)

    async def test_empty_list(self):
        repo = _make_repo()
        repo.get_tools.return_value = []
        db = MCPDatabase(repository=repo)

        result = await db.get_tools(uuid4())
        assert result == []


class TestGetTool:
    async def test_returns_dict_when_found(self):
        repo = _make_repo()
        sid = uuid4()
        data = {"name": "my-tool", "enabled": True}
        repo.get_tool.return_value = _make_model(data)
        db = MCPDatabase(repository=repo)

        result = await db.get_tool(sid, "my-tool")
        assert result == data
        repo.get_tool.assert_awaited_once_with(sid, "my-tool")

    async def test_returns_none_when_not_found(self):
        repo = _make_repo()
        repo.get_tool.return_value = None
        db = MCPDatabase(repository=repo)

        result = await db.get_tool(uuid4(), "missing")
        assert result is None


# ---------------------------------------------------------------------------
# Execution Operations
# ---------------------------------------------------------------------------

class TestLogExecution:
    async def test_delegates_all_params(self):
        repo = _make_repo()
        sid = uuid4()
        exec_data = {"id": str(uuid4()), "status": "success"}
        repo.log_execution.return_value = _make_model(exec_data)
        db = MCPDatabase(repository=repo)

        result = await db.log_execution(
            server_id=sid,
            tool_name="calc",
            parameters={"x": 1},
            result={"answer": 42},
            error=None,
            execution_time_ms=150,
            status="success",
            execution_context={"user": "test"},
            sandboxed=True,
        )
        assert result == exec_data
        repo.log_execution.assert_awaited_once_with(
            server_id=sid,
            tool_name="calc",
            parameters={"x": 1},
            result={"answer": 42},
            error=None,
            execution_time_ms=150,
            status="success",
            execution_context={"user": "test"},
            sandboxed=True,
        )


class TestUpdateExecution:
    async def test_returns_dict_when_found(self):
        repo = _make_repo()
        eid = uuid4()
        data = {"id": str(eid), "status": "success"}
        repo.update_execution.return_value = _make_model(data)
        db = MCPDatabase(repository=repo)

        result = await db.update_execution(
            execution_id=eid,
            result={"ok": True},
            error=None,
            execution_time_ms=200,
            status="success",
        )
        assert result == data
        repo.update_execution.assert_awaited_once_with(
            execution_id=eid,
            result={"ok": True},
            error=None,
            execution_time_ms=200,
            status="success",
        )

    async def test_returns_none_when_not_found(self):
        repo = _make_repo()
        repo.update_execution.return_value = None
        db = MCPDatabase(repository=repo)

        result = await db.update_execution(execution_id=uuid4())
        assert result is None


class TestGetExecutionHistory:
    async def test_returns_list_of_dicts(self):
        repo = _make_repo()
        sid = uuid4()
        exec_models = [
            _make_model({"id": "e1", "tool_name": "t1"}),
            _make_model({"id": "e2", "tool_name": "t2"}),
        ]
        repo.get_execution_history.return_value = exec_models
        db = MCPDatabase(repository=repo)

        result = await db.get_execution_history(
            server_id=sid, tool_name="t1", status="success", limit=50, offset=10
        )
        assert result == [
            {"id": "e1", "tool_name": "t1"},
            {"id": "e2", "tool_name": "t2"},
        ]
        repo.get_execution_history.assert_awaited_once_with(
            server_id=sid, tool_name="t1", status="success", limit=50, offset=10
        )

    async def test_empty_history(self):
        repo = _make_repo()
        repo.get_execution_history.return_value = []
        db = MCPDatabase(repository=repo)

        result = await db.get_execution_history()
        assert result == []


class TestGetServerStats:
    async def test_delegates_and_returns_raw(self):
        repo = _make_repo()
        sid = uuid4()
        stats = {"total_executions": 42, "avg_duration_ms": 100}
        repo.get_server_stats.return_value = stats
        db = MCPDatabase(repository=repo)

        result = await db.get_server_stats(sid)
        assert result == stats
        repo.get_server_stats.assert_awaited_once_with(sid)
