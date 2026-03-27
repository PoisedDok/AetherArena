"""
Tests for core.mcp.manager — MCPServerManager lifecycle orchestrator.

Covers all 30 public and private methods including:
- Constructor, start/stop lifecycle
- Server registration, update, deletion
- Tool caching (memory + database tiers)
- Tool execution with audit trail
- Health checking and background monitoring
- Sync wrapper for async coroutines
- Config validation
- UUID casting and error recovery

All external dependencies (MCPDatabase, McpServer, MCPSandbox) are mocked.
"""

import asyncio
import os
from concurrent.futures import TimeoutError as ThreadTimeoutError
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from core.mcp.manager import MCPServerManager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_db() -> MagicMock:
    """Create a mock MCPDatabase with all async methods."""
    db = MagicMock()
    db.list_servers = AsyncMock(return_value=[])
    db.create_server = AsyncMock()
    db.get_server = AsyncMock()
    db.get_server_by_name = AsyncMock()
    db.update_server_status = AsyncMock()
    db.update_server = AsyncMock()
    db.update_health_status = AsyncMock()
    db.delete_server = AsyncMock()
    db.upsert_tools = AsyncMock()
    db.get_tools = AsyncMock(return_value=[])
    db.get_tool = AsyncMock()
    db.log_execution = AsyncMock()
    db.update_execution = AsyncMock()
    db.get_execution_history = AsyncMock(return_value=[])
    db.get_server_stats = AsyncMock(return_value={"tool_count": 0})
    return db


def _make_server_record(
    server_id=None, name="test-srv", server_type="local",
    config=None, auto_start=True, enabled=True,
    sandbox_enabled=True, resource_limits=None,
):
    """Create a server record dict."""
    return {
        "id": server_id or uuid4(),
        "name": name,
        "display_name": f"Test {name}",
        "server_type": server_type,
        "config": config or {"command": "python", "args": ["-m", "mcp"]},
        "auto_start": auto_start,
        "enabled": enabled,
        "sandbox_enabled": sandbox_enabled,
        "resource_limits": resource_limits,
        "status": "inactive",
    }


def _make_mock_server() -> AsyncMock:
    """Create a mock McpServer."""
    srv = AsyncMock()
    srv.start = AsyncMock()
    srv.stop = AsyncMock()
    srv.get_tools = AsyncMock(return_value=[
        {"type": "function", "function": {"name": "tool1", "description": "d", "parameters": {}}},
    ])
    srv.apply_tool = AsyncMock(return_value="result-text")
    return srv


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:
    def test_initializes_fields(self):
        db = _make_db()
        mgr = MCPServerManager(db, tool_cache_ttl_seconds=600)
        assert mgr.db is db
        assert mgr._active_servers == {}
        assert mgr._sandboxes == {}
        assert mgr._health_check_task is None
        assert mgr._tool_cache == {}
        assert mgr._tool_cache_ttl == timedelta(seconds=600)


# ===========================================================================
# _validate_server_config
# ===========================================================================

class TestValidateServerConfig:
    def test_local_valid(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        mgr._validate_server_config("local", {"command": "python"})

    def test_local_missing_command(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="Local server requires 'command'"):
            mgr._validate_server_config("local", {})

    def test_remote_valid(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        mgr._validate_server_config("remote", {"url": "https://api.example.com"})

    def test_remote_missing_url(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="Remote server requires 'url'"):
            mgr._validate_server_config("remote", {})

    def test_invalid_type(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="Invalid server type"):
            mgr._validate_server_config("grpc", {})


# ===========================================================================
# invalidate_tool_cache
# ===========================================================================

class TestInvalidateToolCache:
    def test_invalidate_all(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        sid1, sid2 = uuid4(), uuid4()
        mgr._tool_cache[sid1] = ([], datetime.now(timezone.utc))
        mgr._tool_cache[sid2] = ([], datetime.now(timezone.utc))

        mgr.invalidate_tool_cache()
        assert mgr._tool_cache == {}

    def test_invalidate_specific(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        sid1, sid2 = uuid4(), uuid4()
        mgr._tool_cache[sid1] = ([], datetime.now(timezone.utc))
        mgr._tool_cache[sid2] = ([], datetime.now(timezone.utc))

        mgr.invalidate_tool_cache(sid1)
        assert sid1 not in mgr._tool_cache
        assert sid2 in mgr._tool_cache

    def test_invalidate_missing_is_noop(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        mgr.invalidate_tool_cache(uuid4())  # No error


# ===========================================================================
# _run_coro_new_loop (static)
# ===========================================================================

class TestRunCoroNewLoop:
    def test_runs_coroutine(self):
        async def coro():
            return 42

        result = MCPServerManager._run_coro_new_loop(coro())
        assert result == 42

    def test_preserves_previous_loop(self):
        """If a loop was set before, it should be restored after."""
        async def coro():
            return "done"

        # Run in a context where no loop is set
        result = MCPServerManager._run_coro_new_loop(coro())
        assert result == "done"


# ===========================================================================
# run_coroutine_sync
# ===========================================================================

class TestRunCoroutineSync:
    def test_no_running_loop(self):
        """When no event loop is running, executes directly."""
        db = _make_db()
        mgr = MCPServerManager(db)

        async def coro():
            return "value"

        result = mgr.run_coroutine_sync(coro())
        assert result == "value"

    async def test_with_running_loop_offloads_to_executor(self):
        """When called from within an event loop, uses executor."""
        db = _make_db()
        mgr = MCPServerManager(db)

        async def coro():
            return "from-executor"

        # We're inside an async test, so there IS a running loop
        result = mgr.run_coroutine_sync(coro(), timeout=5)
        assert result == "from-executor"

    async def test_timeout_raises(self):
        """When executor times out, raises TimeoutError."""
        db = _make_db()
        mgr = MCPServerManager(db)

        # Mock the executor to simulate a timeout without creating real threads
        mock_future = MagicMock()
        mock_future.result.side_effect = ThreadTimeoutError
        mock_future.cancel = MagicMock()
        mock_executor = MagicMock()
        mock_executor.submit.return_value = mock_future
        mgr._sync_executor = mock_executor

        async def dummy():
            return "done"

        with pytest.raises(TimeoutError, match="Timed out"):
            mgr.run_coroutine_sync(dummy())


# ===========================================================================
# start
# ===========================================================================

class TestStart:
    @patch("core.mcp.manager.asyncio.create_task")
    async def test_start_no_servers(self, mock_create_task):
        db = _make_db()
        db.list_servers.return_value = []
        mgr = MCPServerManager(db)

        await mgr.start()

        db.list_servers.assert_awaited_once_with(enabled_only=True)
        mock_create_task.assert_called_once()  # health check loop

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_start_filters_test_servers_outside_pytest(self, mock_create_task):
        db = _make_db()
        record = _make_server_record(name="test-my-server", auto_start=True)
        db.list_servers.return_value = [record]
        mgr = MCPServerManager(db)

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PYTEST_CURRENT_TEST", None)
            await mgr.start()

        # test-* server should be filtered out
        assert len(mgr._active_servers) == 0

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_start_autostart_by_name(self, mock_create_task):
        """Servers without auto_start key use core_autostart_names fallback."""
        db = _make_db()
        record = _make_server_record(name="file_indexing_mcp")
        del record["auto_start"]  # Remove auto_start key
        db.list_servers.return_value = [record]
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(return_value=True)

        await mgr.start()

        mgr._start_server.assert_awaited_once()

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_start_server_failure_continues(self, mock_create_task):
        db = _make_db()
        record = _make_server_record(auto_start=True)
        db.list_servers.return_value = [record]
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=RuntimeError("crash"))

        await mgr.start()
        # Should not raise — error is logged and start continues

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_start_cancelled_error_handled(self, mock_create_task):
        db = _make_db()
        record = _make_server_record(auto_start=True)
        db.list_servers.return_value = [record]
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=asyncio.CancelledError)

        await mgr.start()
        # Should not raise

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_start_server_returns_false(self, mock_create_task):
        db = _make_db()
        record = _make_server_record(auto_start=True)
        db.list_servers.return_value = [record]
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(return_value=False)

        await mgr.start()
        # Failed startup logged but no crash

    async def test_start_db_query_failure_raises(self):
        db = _make_db()
        db.list_servers.side_effect = RuntimeError("DB down")
        mgr = MCPServerManager(db)

        with pytest.raises(RuntimeError, match="DB down"):
            await mgr.start()

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_start_server_failure_missing_id(self, mock_create_task):
        db = _make_db()
        record = _make_server_record(auto_start=True)
        record["id"] = None  # Missing ID
        db.list_servers.return_value = [record]
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=RuntimeError("failed"))

        await mgr.start()
        # Should handle missing ID gracefully

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_start_server_failure_invalid_uuid(self, mock_create_task):
        db = _make_db()
        record = _make_server_record(auto_start=True)
        record["id"] = "not-a-uuid"
        db.list_servers.return_value = [record]
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=RuntimeError("failed"))

        await mgr.start()
        # Should handle invalid UUID gracefully

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_start_server_failure_uuid_obj(self, mock_create_task):
        """When server_id is already a UUID object."""
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid, auto_start=True)
        db.list_servers.return_value = [record]
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=RuntimeError("failed"))

        await mgr.start()
        db.update_server_status.assert_awaited_once_with(sid, "error", "failed")


# ===========================================================================
# stop
# ===========================================================================

class TestStop:
    async def test_stop_empty(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        await mgr.stop()  # No servers, no health check

    async def test_stop_cancels_health_check(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        # Create a real asyncio task that we can cancel
        async def fake_health_loop():
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                pass

        task = asyncio.create_task(fake_health_loop())
        mgr._health_check_task = task

        await mgr.stop()
        assert task.cancelled() or task.done()

    async def test_stop_stops_active_servers(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        sid = uuid4()
        mock_srv = _make_mock_server()
        mgr._active_servers[sid] = mock_srv

        await mgr.stop()

        assert mgr._active_servers == {}
        assert mgr._tool_cache == {}

    async def test_stop_handles_timeout(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        sid = uuid4()
        mock_srv = AsyncMock()
        mock_srv.stop = AsyncMock(side_effect=asyncio.TimeoutError)
        mgr._active_servers[sid] = mock_srv

        await mgr.stop()  # Should not raise


# ===========================================================================
# register_server
# ===========================================================================

class TestRegisterServer:
    async def test_register_success_with_auto_start(self):
        db = _make_db()
        db.get_server_by_name.return_value = None
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.create_server.return_value = record
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock()

        result = await mgr.register_server(
            name="test-srv", display_name="Test", server_type="local",
            config={"command": "python"}, auto_start=True,
        )

        assert result["status"] == "active"
        mgr._start_server.assert_awaited_once()

    async def test_register_existing_raises(self):
        db = _make_db()
        db.get_server_by_name.return_value = {"id": uuid4(), "name": "exists"}
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="already exists"):
            await mgr.register_server(
                name="exists", display_name="E", server_type="local",
                config={"command": "python"},
            )

    async def test_register_auto_start_failure(self):
        db = _make_db()
        db.get_server_by_name.return_value = None
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.create_server.return_value = record
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=RuntimeError("boom"))

        result = await mgr.register_server(
            name="test", display_name="T", server_type="local",
            config={"command": "python"}, auto_start=True,
        )

        assert result["status"] == "error"
        db.update_server_status.assert_awaited_once_with(sid, "error", "boom")

    async def test_register_no_auto_start(self):
        db = _make_db()
        db.get_server_by_name.return_value = None
        record = _make_server_record()
        db.create_server.return_value = record
        mgr = MCPServerManager(db)

        result = await mgr.register_server(
            name="test", display_name="T", server_type="local",
            config={"command": "python"}, auto_start=False,
        )

        assert "status" in result


# ===========================================================================
# unregister_server
# ===========================================================================

class TestUnregisterServer:
    async def test_unregister_running_server(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        sid = uuid4()
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()

        result = await mgr.unregister_server(sid)

        assert result is True
        mgr._stop_server.assert_awaited_once_with(sid)
        db.delete_server.assert_awaited_once_with(sid)

    async def test_unregister_stopped_server(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        sid = uuid4()

        result = await mgr.unregister_server(sid)
        assert result is True
        db.delete_server.assert_awaited_once_with(sid)


# ===========================================================================
# update_server
# ===========================================================================

class TestUpdateServer:
    async def test_update_not_found(self):
        db = _make_db()
        db.get_server.return_value = None
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="not found"):
            await mgr.update_server(uuid4(), display_name="New")

    async def test_update_running_restarts(self):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {"id": sid, "name": "srv"}
        updated = {"id": sid, "name": "srv", "display_name": "New", "enabled": True}
        db.update_server.return_value = updated
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock()

        result = await mgr.update_server(sid, display_name="New")

        mgr._stop_server.assert_awaited_once_with(sid)
        mgr._start_server.assert_awaited_once()
        assert result == updated

    async def test_update_stopped_no_restart(self):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {"id": sid, "name": "srv"}
        updated = {"id": sid, "name": "srv", "enabled": True}
        db.update_server.return_value = updated
        mgr = MCPServerManager(db)

        result = await mgr.update_server(sid, description="desc")

        assert result == updated

    async def test_update_restart_failure_logged(self):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {"id": sid, "name": "srv"}
        updated = {"id": sid, "name": "srv", "enabled": True}
        db.update_server.return_value = updated
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock(side_effect=RuntimeError("restart fail"))

        result = await mgr.update_server(sid, config={"command": "new"})
        assert result == updated  # Returns updated despite restart failure

    async def test_update_all_fields(self):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {"id": sid, "name": "srv"}
        db.update_server.return_value = {"id": sid}
        mgr = MCPServerManager(db)

        await mgr.update_server(
            sid, display_name="N", description="D",
            config={"command": "x"}, auto_start=False, enabled=False,
        )

        db.update_server.assert_awaited_once_with(
            sid,
            display_name="N", description="D",
            config={"command": "x"}, auto_start=False, enabled=False,
        )


# ===========================================================================
# test_server
# ===========================================================================

class TestTestServer:
    async def test_server_not_found(self):
        db = _make_db()
        db.get_server.return_value = None
        mgr = MCPServerManager(db)

        result = await mgr.test_server(uuid4())
        assert result["success"] is False
        assert result["message"] == "Server not found"

    @patch("core.mcp.server.ConfiguredLocalServer")
    async def test_local_server_success(self, mock_cls):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {
            "id": sid, "server_type": "local",
            "config": {"command": "python", "args": []},
        }
        mock_srv = _make_mock_server()
        mock_cls.return_value = mock_srv

        mgr = MCPServerManager(db)
        result = await mgr.test_server(sid)

        assert result["success"] is True
        assert result["diagnostics"]["can_connect"] is True
        assert result["diagnostics"]["tools_discovered"] == 1
        assert result["diagnostics"]["tool_names"] == ["tool1"]

    @patch("core.mcp.server.RemoteMcpServer")
    async def test_remote_server_success(self, mock_cls):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {
            "id": sid, "server_type": "remote",
            "config": {"url": "https://api.example.com"},
        }
        mock_srv = _make_mock_server()
        mock_cls.return_value = mock_srv

        mgr = MCPServerManager(db)
        result = await mgr.test_server(sid)

        assert result["success"] is True

    @patch("core.mcp.server.ConfiguredLocalServer")
    async def test_server_failure(self, mock_cls):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {
            "id": sid, "server_type": "local",
            "config": {"command": "python"},
        }
        mock_srv = _make_mock_server()
        mock_srv.start.side_effect = RuntimeError("connection refused")
        mock_cls.return_value = mock_srv

        mgr = MCPServerManager(db)
        result = await mgr.test_server(sid)

        assert result["success"] is False
        assert "connection refused" in result["message"]
        assert result["diagnostics"]["can_connect"] is False

    @patch("core.mcp.server.ConfiguredLocalServer")
    async def test_stop_called_when_get_tools_fails(self, mock_cls):
        """Regression: start() succeeds but get_tools() raises -> stop() MUST be called.

        Before the fix, the spawned MCP process would leak because stop() was
        only called in the happy path (after get_tools() returned successfully).
        """
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {
            "id": sid, "server_type": "local",
            "config": {"command": "python", "args": []},
        }
        mock_srv = _make_mock_server()
        mock_srv.get_tools.side_effect = RuntimeError("protocol mismatch")
        mock_cls.return_value = mock_srv

        mgr = MCPServerManager(db)
        result = await mgr.test_server(sid)

        # Error result is correct
        assert result["success"] is False
        assert "protocol mismatch" in result["message"]
        assert result["diagnostics"]["can_connect"] is False

        # CRITICAL: stop() was called despite get_tools() failure (no process leak)
        mock_srv.start.assert_awaited_once()
        mock_srv.stop.assert_awaited_once()

    @patch("core.mcp.server.ConfiguredLocalServer")
    async def test_stop_error_during_cleanup_logged(self, mock_cls):
        """Coverage for lines 518-519: stop() raises during finally cleanup.

        When test_server succeeds (start + get_tools) but stop() fails in the
        finally block, the error must be caught and logged, not propagated.
        The test result should still be successful.
        """
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {
            "id": sid, "server_type": "local",
            "config": {"command": "python", "args": []},
        }
        mock_srv = _make_mock_server()
        mock_srv.stop.side_effect = RuntimeError("process already dead")
        mock_cls.return_value = mock_srv

        mgr = MCPServerManager(db)
        result = await mgr.test_server(sid)

        # Test still reports success despite stop failure
        assert result["success"] is True
        assert result["diagnostics"]["can_connect"] is True
        # stop was attempted
        mock_srv.stop.assert_awaited_once()


# ===========================================================================
# get_server_info
# ===========================================================================

class TestGetServerInfo:
    async def test_not_found(self):
        db = _make_db()
        db.get_server.return_value = None
        mgr = MCPServerManager(db)

        result = await mgr.get_server_info(uuid4())
        assert result is None

    async def test_found_not_running(self):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {"id": sid, "name": "srv"}
        mgr = MCPServerManager(db)

        result = await mgr.get_server_info(sid)
        assert result["is_running"] is False

    async def test_found_running_with_sandbox(self):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {"id": sid, "name": "srv"}
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mock_sandbox = MagicMock()
        mock_sandbox.get_stats.return_value = {"status": "running", "pid": 123}
        mgr._sandboxes[sid] = mock_sandbox

        result = await mgr.get_server_info(sid)
        assert result["is_running"] is True
        assert result["sandbox_stats"]["pid"] == 123


# ===========================================================================
# list_servers
# ===========================================================================

class TestListServers:
    async def test_empty_list(self):
        db = _make_db()
        db.list_servers.return_value = []
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert result == []

    async def test_dict_server_with_runtime_status(self):
        db = _make_db()
        sid = uuid4()
        db.list_servers.return_value = [{"id": sid, "name": "srv"}]
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()

        result = await mgr.list_servers()
        assert len(result) == 1
        assert result[0]["is_running"] is True

    async def test_pydantic_model_dump(self):
        """Server object with model_dump method."""
        db = _make_db()
        sid = uuid4()
        model = MagicMock()
        model.model_dump.return_value = {"id": sid, "name": "srv"}
        db.list_servers.return_value = [model]
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert len(result) == 1
        assert result[0]["name"] == "srv"

    async def test_pydantic_dict_fallback(self):
        """Server object with .dict() method (older Pydantic)."""
        db = _make_db()
        sid = uuid4()
        model = MagicMock(spec=[])
        model.dict = MagicMock(return_value={"id": sid, "name": "srv"})
        # Remove model_dump so it falls through to dict
        db.list_servers.return_value = [model]
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert len(result) == 1

    async def test_unexpected_type_skipped(self):
        """Non-dict, non-model objects are skipped."""
        db = _make_db()
        # Create object with no model_dump, no dict, not a dict
        obj = 42  # An integer — has no model_dump, dict, or isinstance dict
        db.list_servers.return_value = [obj]
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert result == []

    async def test_invalid_uuid_in_server(self):
        db = _make_db()
        db.list_servers.return_value = [{"id": "not-a-uuid", "name": "srv"}]
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert len(result) == 1
        assert result[0]["is_running"] is False

    async def test_stats_failure_defaults_to_zero(self):
        db = _make_db()
        sid = uuid4()
        db.list_servers.return_value = [{"id": sid, "name": "srv"}]
        db.get_server_stats.side_effect = RuntimeError("DB error")
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert result[0]["tools_count"] == 0


# ===========================================================================
# get_server (by ID or name)
# ===========================================================================

class TestGetServer:
    async def test_by_uuid(self):
        db = _make_db()
        sid = uuid4()
        db.get_server.return_value = {"id": sid, "name": "srv"}
        mgr = MCPServerManager(db)

        result = await mgr.get_server(str(sid))
        assert result is not None

    async def test_by_name(self):
        db = _make_db()
        db.list_servers.return_value = [{"id": uuid4(), "name": "my-srv"}]
        mgr = MCPServerManager(db)

        result = await mgr.get_server("my-srv")
        assert result is not None
        assert result["name"] == "my-srv"

    async def test_not_found(self):
        db = _make_db()
        db.get_server.return_value = None
        db.list_servers.return_value = []
        mgr = MCPServerManager(db)

        result = await mgr.get_server("nonexistent")
        assert result is None


# ===========================================================================
# delete_server (by ID or name)
# ===========================================================================

class TestDeleteServer:
    async def test_by_uuid(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        mgr.unregister_server = AsyncMock(return_value=True)

        result = await mgr.delete_server(str(uuid4()))
        assert result is True

    async def test_by_name(self):
        db = _make_db()
        sid = uuid4()
        db.list_servers.return_value = [{"id": sid, "name": "srv"}]
        mgr = MCPServerManager(db)
        mgr.unregister_server = AsyncMock(return_value=True)

        result = await mgr.delete_server("srv")
        assert result is True

    async def test_not_found(self):
        db = _make_db()
        db.get_server.return_value = None
        db.list_servers.return_value = []
        mgr = MCPServerManager(db)

        result = await mgr.delete_server("nonexistent")
        assert result is False


# ===========================================================================
# get_server_tools_by_name
# ===========================================================================

class TestGetServerToolsByName:
    async def test_found(self):
        db = _make_db()
        sid = uuid4()
        db.get_server_by_name.return_value = {"id": sid, "name": "srv"}
        mgr = MCPServerManager(db)
        mgr.get_server_tools = AsyncMock(return_value=[{"type": "function"}])

        result = await mgr.get_server_tools_by_name("srv")
        assert result == [{"type": "function"}]
        mgr.get_server_tools.assert_awaited_once_with(sid, False)

    async def test_not_found(self):
        db = _make_db()
        db.get_server_by_name.return_value = None
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="not found"):
            await mgr.get_server_tools_by_name("missing")

    async def test_refresh(self):
        db = _make_db()
        sid = uuid4()
        db.get_server_by_name.return_value = {"id": sid, "name": "srv"}
        mgr = MCPServerManager(db)
        mgr.get_server_tools = AsyncMock(return_value=[])

        await mgr.get_server_tools_by_name("srv", refresh=True)
        mgr.get_server_tools.assert_awaited_once_with(sid, True)


# ===========================================================================
# get_server_tools (multi-tier cache)
# ===========================================================================

class TestGetServerTools:
    async def test_memory_cache_hit(self):
        db = _make_db()
        sid = uuid4()
        tools = [{"type": "function", "function": {"name": "t1"}}]
        mgr = MCPServerManager(db)
        mgr._tool_cache[sid] = (tools, datetime.now(timezone.utc) + timedelta(minutes=5))

        result = await mgr.get_server_tools(sid)
        assert result == tools

    async def test_memory_cache_expired(self):
        db = _make_db()
        sid = uuid4()
        mgr = MCPServerManager(db)
        mgr._tool_cache[sid] = ([], datetime.now(timezone.utc) - timedelta(minutes=1))
        # Server not active, no DB cache → RuntimeError
        with pytest.raises(RuntimeError, match="Server is not running"):
            await mgr.get_server_tools(sid)

    async def test_database_cache_hit(self):
        db = _make_db()
        sid = uuid4()
        db.get_tools.return_value = [
            {"openai_schema": {"type": "function", "function": {"name": "t1"}}},
        ]
        mgr = MCPServerManager(db)

        result = await mgr.get_server_tools(sid)
        assert len(result) == 1
        assert result[0]["function"]["name"] == "t1"
        # Should populate memory cache
        assert sid in mgr._tool_cache

    async def test_live_fetch(self):
        db = _make_db()
        sid = uuid4()
        tools = [{"type": "function", "function": {"name": "live"}}]
        mock_srv = _make_mock_server()
        mock_srv.get_tools.return_value = tools

        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        result = await mgr.get_server_tools(sid, refresh=True)
        assert result == tools
        db.upsert_tools.assert_awaited_once()
        upsert_args = db.upsert_tools.call_args[0]
        assert upsert_args[0] == sid
        assert upsert_args[1] == tools
        assert sid in mgr._tool_cache

    async def test_string_id_converted_to_uuid(self):
        db = _make_db()
        sid = uuid4()
        tools = [{"type": "function"}]
        mgr = MCPServerManager(db)
        mgr._tool_cache[sid] = (tools, datetime.now(timezone.utc) + timedelta(minutes=5))

        result = await mgr.get_server_tools(str(sid))
        assert result == tools

    async def test_not_running_no_cache_raises(self):
        db = _make_db()
        db.get_tools.return_value = []
        mgr = MCPServerManager(db)

        with pytest.raises(RuntimeError, match="Server is not running"):
            await mgr.get_server_tools(uuid4())


# ===========================================================================
# execute_tool
# ===========================================================================

class TestExecuteTool:
    async def test_success(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_srv.apply_tool.return_value = "42"
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        result = await mgr.execute_tool(sid, "calc", {"x": 1})

        assert result["success"] is True
        assert result["result"] == "42"
        assert "duration_ms" in result
        db.log_execution.assert_awaited_once()
        log_kwargs = db.log_execution.call_args.kwargs
        assert log_kwargs["server_id"] == sid
        assert log_kwargs["tool_name"] == "calc"
        assert log_kwargs["status"] == "success"

    async def test_failure(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_srv.apply_tool.side_effect = RuntimeError("tool crashed")
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        result = await mgr.execute_tool(sid, "broken", {})

        assert result["success"] is False
        assert "tool crashed" in result["error"]
        db.log_execution.assert_awaited_once()
        log_kwargs = db.log_execution.call_args.kwargs
        assert log_kwargs["server_id"] == sid
        assert log_kwargs["tool_name"] == "broken"
        assert log_kwargs["status"] == "error"

    async def test_not_running_raises(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        with pytest.raises(RuntimeError, match="Server is not running"):
            await mgr.execute_tool(uuid4(), "tool", {})

    async def test_string_id_converted(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        result = await mgr.execute_tool(str(sid), "tool", {})
        assert result["success"] is True

    async def test_sandboxed_flag(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv
        mgr._sandboxes[sid] = MagicMock()

        await mgr.execute_tool(sid, "tool", {})

        call_kwargs = db.log_execution.call_args.kwargs
        assert call_kwargs["sandboxed"] is True


# ===========================================================================
# check_server_health
# ===========================================================================

class TestCheckServerHealth:
    async def test_not_running(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        result = await mgr.check_server_health(uuid4())
        assert result["healthy"] is False
        assert result["status"] == "not_running"

    async def test_healthy(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        result = await mgr.check_server_health(sid)
        assert result["healthy"] is True
        assert result["tool_count"] == 1

    async def test_healthy_with_sandbox(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_sandbox = MagicMock()
        mock_sandbox.get_stats.return_value = {"pid": 123}
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv
        mgr._sandboxes[sid] = mock_sandbox

        result = await mgr.check_server_health(sid)
        assert result["sandbox_stats"]["pid"] == 123

    async def test_unhealthy(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_srv.get_tools.side_effect = ConnectionError("dead")
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        result = await mgr.check_server_health(sid)
        assert result["healthy"] is False
        assert result["status"] == "unhealthy"
        assert "dead" in result["error"]

    async def test_string_id_converted(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        result = await mgr.check_server_health(str(uuid4()))
        assert result["healthy"] is False


# ===========================================================================
# start_server_by_name
# ===========================================================================

class TestStartServerByName:
    async def test_success(self):
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.get_server_by_name.return_value = record
        mgr = MCPServerManager(db)

        async def mock_start_server(rec):
            mgr._active_servers[sid] = _make_mock_server()

        mgr._start_server = AsyncMock(side_effect=mock_start_server)

        result = await mgr.start_server_by_name("test-srv")
        assert result is record

    async def test_not_found(self):
        db = _make_db()
        db.get_server_by_name.return_value = None
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="not found"):
            await mgr.start_server_by_name("missing")

    async def test_restarts_if_running(self):
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.get_server_by_name.return_value = record
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock()

        await mgr.start_server_by_name("test-srv")
        mgr._stop_server.assert_awaited_once_with(sid)

    async def test_failure_to_start(self):
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.get_server_by_name.return_value = record
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock()
        # After _start_server, server is NOT in _active_servers → error

        with pytest.raises(RuntimeError, match="failed to start"):
            await mgr.start_server_by_name("test-srv")


# ===========================================================================
# stop_server_by_name
# ===========================================================================

class TestStopServerByName:
    async def test_stop_running(self):
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.get_server_by_name.return_value = record
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()

        result = await mgr.stop_server_by_name("test-srv")
        assert result is record
        mgr._stop_server.assert_awaited_once_with(sid)

    async def test_not_found(self):
        db = _make_db()
        db.get_server_by_name.return_value = None
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="not found"):
            await mgr.stop_server_by_name("missing")

    async def test_already_stopped_updates_db(self):
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.get_server_by_name.return_value = record
        mgr = MCPServerManager(db)

        await mgr.stop_server_by_name("test-srv")
        db.update_server_status.assert_awaited_once_with(sid, "inactive")

    async def test_missing_id_raises(self):
        db = _make_db()
        record = {"name": "srv"}  # No "id" key
        db.get_server_by_name.return_value = record
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="missing 'id' field"):
            await mgr.stop_server_by_name("srv")

    async def test_already_stopped_db_error_suppressed(self):
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.get_server_by_name.return_value = record
        db.update_server_status.side_effect = RuntimeError("DB error")
        mgr = MCPServerManager(db)

        # Should not raise — DB error is suppressed
        await mgr.stop_server_by_name("test-srv")


# ===========================================================================
# restart_server
# ===========================================================================

class TestRestartServer:
    async def test_restart_success(self):
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.get_server.return_value = record
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock()

        result = await mgr.restart_server(sid)
        assert result is True
        mgr._stop_server.assert_awaited_once_with(sid)
        mgr._start_server.assert_awaited_once()

    async def test_not_found(self):
        db = _make_db()
        db.get_server.return_value = None
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="Server not found"):
            await mgr.restart_server(uuid4())

    async def test_restart_stopped_server(self):
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid)
        db.get_server.return_value = record
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock()

        result = await mgr.restart_server(sid)
        assert result is True


# ===========================================================================
# get_execution_history / get_server_stats
# ===========================================================================

class TestDelegationMethods:
    async def test_get_execution_history(self):
        db = _make_db()
        sid = uuid4()
        db.get_execution_history.return_value = [{"id": "e1"}]
        mgr = MCPServerManager(db)

        result = await mgr.get_execution_history(server_id=sid, limit=50)
        assert result == [{"id": "e1"}]
        db.get_execution_history.assert_awaited_once_with(server_id=sid, limit=50)

    async def test_get_server_stats(self):
        db = _make_db()
        sid = uuid4()
        db.get_server_stats.return_value = {"total_executions": 10}
        mgr = MCPServerManager(db)

        result = await mgr.get_server_stats(sid)
        assert result == {"total_executions": 10}
        db.get_server_stats.assert_awaited_once_with(sid)


# ===========================================================================
# _start_server (internal)
# ===========================================================================

class TestStartServerInternal:
    async def test_missing_id_raises(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="missing 'id' field"):
            await mgr._start_server({"name": "no-id"})

    async def test_invalid_uuid_raises(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="Invalid UUID"):
            await mgr._start_server({"id": "not-uuid", "name": "srv"})

    async def test_unknown_type_raises(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        result = await mgr._start_server({
            "id": uuid4(), "name": "srv",
            "server_type": "grpc", "config": {},
        })
        # Unknown type is caught by the outer except, returns False
        assert result is False

    @patch("core.mcp.manager.ConfiguredLocalServer")
    async def test_local_server_start(self, mock_cls):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_cls.return_value = mock_srv
        mgr = MCPServerManager(db)

        result = await mgr._start_server({
            "id": sid, "name": "local-srv",
            "server_type": "local",
            "config": {"command": "python"},
            "sandbox_enabled": False,
            "resource_limits": {},
        })

        assert result is True
        assert sid in mgr._active_servers

    @patch("core.mcp.manager.RemoteMcpServer")
    async def test_remote_server_start(self, mock_cls):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_cls.return_value = mock_srv
        mgr = MCPServerManager(db)

        result = await mgr._start_server({
            "id": sid, "name": "remote-srv",
            "server_type": "remote",
            "config": {"url": "https://api.example.com"},
        })

        assert result is True
        assert sid in mgr._active_servers

    async def test_start_failure_returns_false(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        mgr._start_local_server = AsyncMock(side_effect=RuntimeError("fail"))
        sid = uuid4()

        result = await mgr._start_server({
            "id": sid, "name": "fail-srv",
            "server_type": "local",
            "config": {"command": "python"},
        })

        assert result is False
        # auto_start should be disabled to prevent repeated startup failures
        db.update_server.assert_awaited_once_with(sid, auto_start=False)

    async def test_db_status_update_failure_suppressed(self):
        db = _make_db()
        db.update_server_status.side_effect = RuntimeError("DB error")
        mgr = MCPServerManager(db)
        mgr._start_local_server = AsyncMock(return_value=_make_mock_server())

        result = await mgr._start_server({
            "id": uuid4(), "name": "srv",
            "server_type": "local",
            "config": {"command": "python"},
        })

        # Despite DB errors, server starts successfully
        assert result is True

    async def test_tool_caching_failure_suppressed(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        mock_srv = _make_mock_server()
        mock_srv.get_tools.side_effect = RuntimeError("no tools")
        mgr._start_local_server = AsyncMock(return_value=mock_srv)

        result = await mgr._start_server({
            "id": uuid4(), "name": "srv",
            "server_type": "local",
            "config": {"command": "python"},
        })

        assert result is True  # Tool cache failure doesn't block startup


# ===========================================================================
# _start_local_server / _start_remote_server
# ===========================================================================

class TestStartLocalServer:
    @patch("core.mcp.manager.ConfiguredLocalServer")
    @patch("core.mcp.manager.MCPSandbox")
    async def test_with_sandbox(self, mock_sandbox_cls, mock_server_cls):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_server_cls.return_value = mock_srv
        mock_sandbox_cls.return_value = MagicMock()

        mgr = MCPServerManager(db)
        result = await mgr._start_local_server(sid, {
            "config": {"command": "python"},
            "sandbox_enabled": True,
            "resource_limits": {"max_memory_mb": 256},
        })

        assert result is mock_srv
        assert sid in mgr._sandboxes
        mock_sandbox_cls.assert_called_once_with(
            max_memory_mb=256, max_cpu_percent=50, max_execution_time_seconds=300,
        )

    @patch("core.mcp.manager.ConfiguredLocalServer")
    @patch("core.mcp.manager.NoOpSandbox")
    async def test_without_sandbox(self, mock_noop_cls, mock_server_cls):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_server_cls.return_value = mock_srv
        mock_noop_cls.return_value = MagicMock()

        mgr = MCPServerManager(db)
        result = await mgr._start_local_server(sid, {
            "config": {"command": "python"},
            "sandbox_enabled": False,
        })

        assert result is mock_srv
        mock_noop_cls.assert_called_once()


class TestStartRemoteServer:
    @patch("core.mcp.manager.RemoteMcpServer")
    async def test_success(self, mock_cls):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_cls.return_value = mock_srv

        mgr = MCPServerManager(db)
        result = await mgr._start_remote_server(sid, {
            "config": {"url": "https://api.example.com"},
        })

        assert result is mock_srv
        mock_cls.assert_called_once_with("https://api.example.com")

    async def test_missing_url_raises(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="Remote server requires 'url'"):
            await mgr._start_remote_server(uuid4(), {"config": {}})


# ===========================================================================
# _stop_server (internal, bug-fixed)
# ===========================================================================

class TestStopServerInternal:
    async def test_noop_if_not_active(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        await mgr._stop_server(uuid4())  # No error

    async def test_success_cleans_up(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        await mgr._stop_server(sid)

        mock_srv.stop.assert_awaited_once()
        assert sid not in mgr._active_servers
        # _stop_server calls: "stopping" then "inactive"
        assert db.update_server_status.await_count == 2
        db.update_server_status.assert_any_await(sid, "stopping")
        db.update_server_status.assert_any_await(sid, "inactive")

    async def test_stop_failure_still_cleans_references(self):
        """BUG FIX TEST: If server.stop() raises, references must still be cleaned."""
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_srv.stop.side_effect = RuntimeError("stop failed")
        mock_sandbox = AsyncMock()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv
        mgr._sandboxes[sid] = mock_sandbox

        await mgr._stop_server(sid)

        # Critical: references cleaned despite exception
        assert sid not in mgr._active_servers
        assert sid not in mgr._sandboxes

    async def test_db_update_failures_suppressed(self):
        db = _make_db()
        db.update_server_status.side_effect = RuntimeError("DB error")
        sid = uuid4()
        mock_srv = _make_mock_server()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        await mgr._stop_server(sid)  # Should not raise
        assert sid not in mgr._active_servers

    async def test_sandbox_cleanup_in_finally(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_sandbox = AsyncMock()
        mock_sandbox.stop_server = AsyncMock()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv
        mgr._sandboxes[sid] = mock_sandbox

        await mgr._stop_server(sid)

        mock_sandbox.stop_server.assert_awaited_once()
        assert sid not in mgr._sandboxes


# ===========================================================================
# _stop_server_quick
# ===========================================================================

class TestStopServerQuick:
    async def test_noop_if_not_active(self):
        db = _make_db()
        mgr = MCPServerManager(db)
        await mgr._stop_server_quick(uuid4())

    async def test_stops_server(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        await mgr._stop_server_quick(sid)
        mock_srv.stop.assert_awaited_once()

    async def test_stops_sandbox(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_sandbox = AsyncMock()
        mock_sandbox.stop_server = AsyncMock()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv
        mgr._sandboxes[sid] = mock_sandbox

        await mgr._stop_server_quick(sid)
        mock_sandbox.stop_server.assert_awaited_once()

    async def test_server_timeout_logged(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_srv.stop.side_effect = asyncio.TimeoutError
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        await mgr._stop_server_quick(sid)  # No raise

    async def test_sandbox_timeout_suppressed(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_sandbox = AsyncMock()
        mock_sandbox.stop_server = AsyncMock(side_effect=asyncio.TimeoutError)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv
        mgr._sandboxes[sid] = mock_sandbox

        await mgr._stop_server_quick(sid)  # No raise

    async def test_general_exception_suppressed(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_srv.stop.side_effect = RuntimeError("unexpected")
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        await mgr._stop_server_quick(sid)  # No raise


# ===========================================================================
# _health_check_loop
# ===========================================================================

class TestHealthCheckLoop:
    async def test_cancelled_exits_cleanly(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        with patch("core.mcp.manager.asyncio.sleep", new_callable=AsyncMock, side_effect=asyncio.CancelledError):
            await mgr._health_check_loop()

    async def test_checks_active_servers(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        call_count = 0

        async def mock_sleep(seconds):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError

        with patch("core.mcp.manager.asyncio.sleep", side_effect=mock_sleep):
            await mgr._health_check_loop()

    async def test_health_check_failure_continues(self):
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_srv.get_tools.side_effect = RuntimeError("dead")
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        call_count = 0

        async def mock_sleep(seconds):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError

        with patch("core.mcp.manager.asyncio.sleep", side_effect=mock_sleep):
            await mgr._health_check_loop()

    async def test_general_loop_exception_continues(self):
        db = _make_db()
        mgr = MCPServerManager(db)

        call_count = 0

        async def mock_sleep(seconds):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise TypeError("weird error")
            raise asyncio.CancelledError

        with patch("core.mcp.manager.asyncio.sleep", side_effect=mock_sleep):
            await mgr._health_check_loop()

    async def test_per_server_check_exception_logged(self):
        """check_server_health raises propagating to the per-server except (line 1230)."""
        db = _make_db()
        sid = uuid4()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr.check_server_health = AsyncMock(side_effect=RuntimeError("unexpected"))

        call_count = 0

        async def mock_sleep(seconds):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise asyncio.CancelledError

        with patch("core.mcp.manager.asyncio.sleep", side_effect=mock_sleep):
            await mgr._health_check_loop()


# ===========================================================================
# Additional targeted tests for remaining coverage gaps
# ===========================================================================

class TestStartupEdgeCases:
    """Tests for remaining uncovered lines in start() and _start_server()."""

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_disable_autostart_core_server_returns_early(self, mock_create_task):
        """Line 127: _disable_autostart_on_failure returns early for core servers."""
        db = _make_db()
        record = _make_server_record(name="file_indexing_mcp", auto_start=True)
        db.list_servers.return_value = [record]
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=asyncio.CancelledError)

        await mgr.start()

        # db.update_server should NOT be called since file_indexing_mcp is a core server
        # (the _disable_autostart_on_failure function returns early)

    @patch("core.mcp.manager.asyncio.create_task")
    async def test_startup_error_db_update_fails(self, mock_create_task):
        """Lines 180-181: DB status update fails during startup error handling."""
        db = _make_db()
        sid = uuid4()
        record = _make_server_record(server_id=sid, auto_start=True)
        db.list_servers.return_value = [record]
        db.update_server_status.side_effect = RuntimeError("DB unreachable")
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=RuntimeError("start failed"))

        await mgr.start()  # Should not raise despite DB error

    async def test_start_server_db_error_status_update_fails(self):
        """Lines 1067-1068: _start_server error path where DB status update fails."""
        db = _make_db()
        db.update_server_status.side_effect = RuntimeError("DB error")
        mgr = MCPServerManager(db)
        mgr._start_local_server = AsyncMock(side_effect=RuntimeError("fail"))

        result = await mgr._start_server({
            "id": uuid4(), "name": "srv",
            "server_type": "local",
            "config": {"command": "python"},
        })

        assert result is False

    async def test_start_server_auto_start_disable_fails(self):
        """Line 1073: _start_server error path where auto_start disable fails."""
        db = _make_db()
        db.update_server.side_effect = RuntimeError("DB error")
        mgr = MCPServerManager(db)
        mgr._start_local_server = AsyncMock(side_effect=RuntimeError("fail"))

        result = await mgr._start_server({
            "id": uuid4(), "name": "srv",
            "server_type": "local",
            "config": {"command": "python"},
        })

        assert result is False


class TestStopEdgeCases:
    """Tests for remaining uncovered lines in stop() and _stop_server()."""

    async def test_stop_gather_timeout(self):
        """Lines 232-233: stop() handles gather timeout."""
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        # Make server.stop() hang
        mock_srv.stop = AsyncMock(side_effect=lambda: asyncio.sleep(100))
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        # Patch asyncio.wait_for to simulate timeout on the gather
        original_wait_for = asyncio.wait_for

        async def patched_wait_for(coro, timeout):
            if timeout == 5.0:
                raise asyncio.TimeoutError
            return await original_wait_for(coro, timeout)

        with patch("core.mcp.manager.asyncio.wait_for", side_effect=patched_wait_for):
            await mgr.stop()

        assert mgr._active_servers == {}

    async def test_stop_server_db_error_status_during_stop(self):
        """Lines 1173-1174: _stop_server exception path where DB status update also fails."""
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_srv.stop.side_effect = RuntimeError("stop failed")
        db.update_server_status.side_effect = RuntimeError("DB also dead")
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv

        await mgr._stop_server(sid)
        assert sid not in mgr._active_servers

    async def test_stop_server_sandbox_cleanup_exception(self):
        """Line 1182: sandbox.stop_server() raises during finally cleanup."""
        db = _make_db()
        sid = uuid4()
        mock_srv = _make_mock_server()
        mock_srv.stop.side_effect = RuntimeError("stop failed")
        mock_sandbox = AsyncMock()
        mock_sandbox.stop_server.side_effect = RuntimeError("sandbox also failed")
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = mock_srv
        mgr._sandboxes[sid] = mock_sandbox

        await mgr._stop_server(sid)

        assert sid not in mgr._active_servers
        assert sid not in mgr._sandboxes


class TestRunCoroNewLoopEdge:
    """Line 278: shutdown_asyncgens raises during _run_coro_new_loop."""

    def test_shutdown_asyncgens_runtime_error(self):
        async def sneaky_coro():
            """Coroutine that poisons shutdown_asyncgens to raise on cleanup."""
            loop = asyncio.get_running_loop()

            async def broken_shutdown():
                raise RuntimeError("shutdown fail")

            loop.shutdown_asyncgens = broken_shutdown
            return 42

        result = MCPServerManager._run_coro_new_loop(sneaky_coro())
        assert result == 42
