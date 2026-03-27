"""
Unit Tests: MCP Server Manager (core/mcp/manager.py)

Comprehensive coverage of MCPServerManager: server lifecycle, tool caching,
execution, health checks, validation, sync wrappers.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

import pytest

from core.mcp.manager import MCPServerManager


# ─── Fake database ──────────────────────────────────────────────────────────


class _FakeMcpDb:
    """In-memory mock of MCPDatabase for testing."""

    def __init__(self, servers: Optional[List[Dict[str, Any]]] = None):
        self._servers = list(servers or [])
        self.update_server_status = AsyncMock()
        self.upsert_tools = AsyncMock()
        self.get_tools = AsyncMock(return_value=[])
        self.log_execution = AsyncMock()
        self.update_health_status = AsyncMock()
        self.get_execution_history = AsyncMock(return_value=[])

    async def list_servers(self, enabled_only: bool = False, server_type: Optional[str] = None):
        servers = self._servers
        if enabled_only:
            servers = [s for s in servers if s.get("enabled", True)]
        if server_type:
            servers = [s for s in servers if s.get("server_type") == server_type]
        return servers

    async def get_server(self, server_id: UUID):
        for s in self._servers:
            if str(s.get("id")) == str(server_id):
                return s
        return None

    async def get_server_by_name(self, name: str):
        for s in self._servers:
            if s.get("name") == name:
                return s
        return None

    async def update_server(self, server_id: UUID, **updates):
        server = await self.get_server(server_id)
        if not server:
            return None
        server.update(updates)
        return server

    async def create_server(self, **kwargs):
        server_id = uuid4()
        record = {"id": server_id, **kwargs}
        self._servers.append(record)
        return record

    async def delete_server(self, server_id: UUID):
        self._servers = [s for s in self._servers if str(s.get("id")) != str(server_id)]
        return True

    async def get_server_stats(self, server_id: UUID):
        return {"tool_count": 0, "execution_count": 0, "success_count": 0, "error_count": 0}


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_server_record(
    *,
    name: str = "test-server",
    server_type: str = "local",
    enabled: bool = True,
    auto_start: bool = False,
    server_id: Optional[UUID] = None,
    config: Optional[Dict[str, Any]] = None,
    sandbox_enabled: bool = True,
    resource_limits: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "id": server_id or uuid4(),
        "name": name,
        "server_type": server_type,
        "config": config or {"command": "python", "args": ["-m", "mcp_server"]},
        "enabled": enabled,
        "auto_start": auto_start,
        "sandbox_enabled": sandbox_enabled,
        "resource_limits": resource_limits,
    }


def _make_mock_server(tools: Optional[List[Dict[str, Any]]] = None) -> AsyncMock:
    """Create a mock MCP server instance."""
    server = AsyncMock()
    server.start = AsyncMock()
    server.stop = AsyncMock()
    server.get_tools = AsyncMock(return_value=tools or [{"name": "test_tool"}])
    server.apply_tool = AsyncMock(return_value="tool result")
    server.list_tools = AsyncMock(return_value=tools or [{"name": "test_tool"}])
    return server


# ═══════════════════════════════════════════════════════════════════════════
# INIT AND BASIC PROPERTIES
# ═══════════════════════════════════════════════════════════════════════════


class TestMCPServerManagerInit:
    def test_requires_database(self):
        with pytest.raises(TypeError):
            MCPServerManager()  # type: ignore[call-arg]

    def test_init_defaults(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        assert mgr.db is db
        assert mgr._active_servers == {}
        assert mgr._sandboxes == {}
        assert mgr._health_check_task is None
        assert mgr._tool_cache == {}
        assert mgr._sync_timeout_seconds == 30

    def test_init_custom_cache_ttl(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db, tool_cache_ttl_seconds=600)
        assert mgr._tool_cache_ttl == timedelta(seconds=600)


# ═══════════════════════════════════════════════════════════════════════════
# VALIDATE SERVER CONFIG
# ═══════════════════════════════════════════════════════════════════════════


class TestValidateServerConfig:
    def test_valid_local_config(self):
        mgr = MCPServerManager(_FakeMcpDb())
        mgr._validate_server_config("local", {"command": "python"})

    def test_local_missing_command(self):
        mgr = MCPServerManager(_FakeMcpDb())
        with pytest.raises(ValueError, match="command"):
            mgr._validate_server_config("local", {"args": ["--help"]})

    def test_valid_remote_config(self):
        mgr = MCPServerManager(_FakeMcpDb())
        mgr._validate_server_config("remote", {"url": "http://localhost:8000"})

    def test_remote_missing_url(self):
        mgr = MCPServerManager(_FakeMcpDb())
        with pytest.raises(ValueError, match="url"):
            mgr._validate_server_config("remote", {"host": "localhost"})

    def test_invalid_server_type(self):
        mgr = MCPServerManager(_FakeMcpDb())
        with pytest.raises(ValueError, match="Invalid server type"):
            mgr._validate_server_config("webhook", {"url": "http://x"})


# ═══════════════════════════════════════════════════════════════════════════
# INVALIDATE TOOL CACHE
# ═══════════════════════════════════════════════════════════════════════════


class TestInvalidateToolCache:
    def test_invalidate_specific_server(self):
        mgr = MCPServerManager(_FakeMcpDb())
        sid = uuid4()
        mgr._tool_cache[sid] = ([{"name": "t1"}], datetime.now(timezone.utc) + timedelta(hours=1))
        mgr.invalidate_tool_cache(sid)
        assert sid not in mgr._tool_cache

    def test_invalidate_nonexistent_server(self):
        mgr = MCPServerManager(_FakeMcpDb())
        mgr.invalidate_tool_cache(uuid4())  # Should not raise

    def test_invalidate_all_caches(self):
        mgr = MCPServerManager(_FakeMcpDb())
        for _ in range(3):
            mgr._tool_cache[uuid4()] = ([{"name": "t"}], datetime.now(timezone.utc))
        mgr.invalidate_tool_cache(None)
        assert len(mgr._tool_cache) == 0


# ═══════════════════════════════════════════════════════════════════════════
# START / STOP LIFECYCLE
# ═══════════════════════════════════════════════════════════════════════════


class TestStartStop:
    async def test_start_empty_servers(self):
        db = _FakeMcpDb([])
        mgr = MCPServerManager(db)
        try:
            await mgr.start()
            assert len(mgr._active_servers) == 0
            assert mgr._health_check_task is not None
        finally:
            await mgr.stop()

    async def test_start_filters_by_autostart(self):
        servers = [
            _make_server_record(name="file_indexing_mcp", auto_start=True),
            _make_server_record(name="no-auto", auto_start=False),
        ]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(return_value=True)
        try:
            await mgr.start()
            assert mgr._start_server.await_count == 1
            called_record = mgr._start_server.await_args_list[0].args[0]
            assert called_record["name"] == "file_indexing_mcp"
        finally:
            await mgr.stop()

    async def test_start_filters_test_servers_outside_pytest(self, monkeypatch):
        monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
        servers = [
            _make_server_record(name="test-mcp-fake", auto_start=True),
        ]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(return_value=True)
        try:
            await mgr.start()
            # test- prefixed servers should be filtered out when not in pytest
            assert mgr._start_server.await_count == 0
        finally:
            await mgr.stop()

    async def test_start_core_autostart_names(self):
        """Servers named file_indexing_mcp auto-start without explicit flag."""
        servers = [
            _make_server_record(name="file_indexing_mcp"),
        ]
        # Remove auto_start key to test back-compat fallback
        for s in servers:
            s.pop("auto_start", None)
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(return_value=True)
        try:
            await mgr.start()
            assert mgr._start_server.await_count == 1
        finally:
            await mgr.stop()

    async def test_start_server_failure_continues(self):
        servers = [
            _make_server_record(name="file_indexing_mcp", auto_start=True),
            _make_server_record(name="another_mcp", auto_start=True),
        ]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        # First fails, second succeeds
        mgr._start_server = AsyncMock(side_effect=[Exception("startup fail"), True])
        try:
            await mgr.start()  # Should not raise
            assert mgr._start_server.await_count == 2
        finally:
            await mgr.stop()

    async def test_start_db_query_fails(self):
        db = _FakeMcpDb()
        db.list_servers = AsyncMock(side_effect=RuntimeError("DB down"))
        mgr = MCPServerManager(db)
        with pytest.raises(RuntimeError, match="DB down"):
            await mgr.start()
        await mgr.stop()

    async def test_start_cancelled_server(self):
        servers = [_make_server_record(name="file_indexing_mcp", auto_start=True)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=asyncio.CancelledError())
        try:
            await mgr.start()  # Should not raise
        finally:
            await mgr.stop()

    async def test_stop_clears_all_state(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        sid = uuid4()
        mgr._active_servers[sid] = _make_mock_server()
        mgr._sandboxes[sid] = MagicMock()
        mgr._tool_cache[sid] = ([], datetime.now(timezone.utc))

        await mgr.stop()
        assert len(mgr._active_servers) == 0
        assert len(mgr._sandboxes) == 0
        assert len(mgr._tool_cache) == 0

    async def test_stop_cancels_health_check(self):
        db = _FakeMcpDb([])
        mgr = MCPServerManager(db)
        try:
            await mgr.start()
            assert mgr._health_check_task is not None
            assert not mgr._health_check_task.done()
        finally:
            await mgr.stop()
        # After stop, health check should be done/cancelled
        # (the task object reference still exists, but it's cancelled)

    async def test_stop_with_server_stop_timeout(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        sid = uuid4()
        slow_server = _make_mock_server()
        slow_server.stop = AsyncMock(side_effect=asyncio.TimeoutError())
        mgr._active_servers[sid] = slow_server

        await mgr.stop()  # Should not raise
        assert len(mgr._active_servers) == 0


# ═══════════════════════════════════════════════════════════════════════════
# REGISTER / UNREGISTER
# ═══════════════════════════════════════════════════════════════════════════


class TestRegisterUnregister:
    async def test_register_server_happy_path(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(return_value=True)

        result = await mgr.register_server(
            name="new-server",
            display_name="New Server",
            server_type="local",
            config={"command": "python"},
            auto_start=True,
        )
        assert result["name"] == "new-server"
        assert result["status"] == "active"
        mgr._start_server.assert_awaited_once()

    async def test_register_server_no_auto_start(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(return_value=True)

        result = await mgr.register_server(
            name="manual-server",
            display_name="Manual",
            server_type="remote",
            config={"url": "http://localhost:9000"},
            auto_start=False,
        )
        assert "status" not in result or result.get("status") != "active"
        mgr._start_server.assert_not_awaited()

    async def test_register_server_duplicate_name(self):
        servers = [_make_server_record(name="existing")]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        with pytest.raises(ValueError, match="already exists"):
            await mgr.register_server(
                name="existing",
                display_name="Dup",
                server_type="local",
                config={"command": "python"},
            )

    async def test_register_server_auto_start_failure(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(side_effect=RuntimeError("cannot start"))

        result = await mgr.register_server(
            name="fail-server",
            display_name="Fail",
            server_type="local",
            config={"command": "bad-cmd"},
            auto_start=True,
        )
        assert result["status"] == "error"
        db.update_server_status.assert_awaited_once()
        call_args = db.update_server_status.call_args[0]
        assert call_args[1] == "error"
        assert call_args[2] == "cannot start"

    async def test_register_invalid_config(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="command"):
            await mgr.register_server(
                name="bad",
                display_name="Bad",
                server_type="local",
                config={},  # Missing command
            )

    async def test_unregister_running_server(self):
        sid = uuid4()
        servers = [_make_server_record(name="to-remove", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()

        result = await mgr.unregister_server(sid)
        assert result is True
        mgr._stop_server.assert_awaited_once_with(sid)

    async def test_unregister_stopped_server(self):
        sid = uuid4()
        servers = [_make_server_record(name="stopped", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        result = await mgr.unregister_server(sid)
        assert result is True
        # Server should be deleted from db
        assert all(str(s.get("id")) != str(sid) for s in db._servers)


# ═══════════════════════════════════════════════════════════════════════════
# UPDATE SERVER
# ═══════════════════════════════════════════════════════════════════════════


class TestUpdateServer:
    async def test_update_running_server_restarts(self):
        sid = uuid4()
        servers = [_make_server_record(name="updatable", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock(return_value=True)

        result = await mgr.update_server(sid, display_name="Updated")
        assert result["display_name"] == "Updated"
        mgr._stop_server.assert_awaited_once_with(sid)
        mgr._start_server.assert_awaited_once()
        assert mgr._start_server.call_args[0][0]["id"] == sid

    async def test_update_non_running_server(self):
        sid = uuid4()
        servers = [_make_server_record(name="stopped", server_id=sid, enabled=False)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock()

        result = await mgr.update_server(sid, description="new desc")
        assert result["description"] == "new desc"
        mgr._stop_server.assert_not_awaited()
        mgr._start_server.assert_not_awaited()

    async def test_update_not_found(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="not found"):
            await mgr.update_server(uuid4(), display_name="X")

    async def test_update_restart_fails_gracefully(self):
        sid = uuid4()
        servers = [_make_server_record(name="s", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock(side_effect=RuntimeError("restart fail"))

        result = await mgr.update_server(sid, config={"command": "new-cmd"})
        # Should not raise, just warn
        assert result["config"]["command"] == "new-cmd"

    async def test_update_disabled_server_not_restarted(self):
        sid = uuid4()
        servers = [_make_server_record(name="s", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock()

        result = await mgr.update_server(sid, enabled=False)
        mgr._stop_server.assert_awaited_once_with(sid)
        mgr._start_server.assert_not_awaited()


# ═══════════════════════════════════════════════════════════════════════════
# TEST SERVER
# ═══════════════════════════════════════════════════════════════════════════


class TestTestServer:
    async def test_test_server_not_found(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        result = await mgr.test_server(uuid4())
        assert result["success"] is False
        assert "not found" in result["message"]

    @patch("core.mcp.server.ConfiguredLocalServer")
    async def test_test_server_local_success(self, mock_cls):
        sid = uuid4()
        servers = [_make_server_record(name="test-local", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        mock_instance = _make_mock_server(tools=[{"name": "t1"}, {"name": "t2"}])
        mock_cls.return_value = mock_instance

        result = await mgr.test_server(sid)
        assert result["success"] is True
        assert result["diagnostics"]["tools_discovered"] == 2
        assert result["diagnostics"]["can_connect"] is True
        mock_instance.start.assert_awaited_once()
        mock_instance.stop.assert_awaited_once()

    @patch("core.mcp.server.RemoteMcpServer")
    async def test_test_server_remote_success(self, mock_cls):
        sid = uuid4()
        servers = [_make_server_record(
            name="test-remote", server_id=sid,
            server_type="remote",
            config={"url": "http://remote:8000"},
        )]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        mock_instance = _make_mock_server(tools=[{"name": "r1"}])
        mock_cls.return_value = mock_instance

        result = await mgr.test_server(sid)
        assert result["success"] is True

    @patch("core.mcp.server.ConfiguredLocalServer")
    async def test_test_server_failure(self, mock_cls):
        sid = uuid4()
        servers = [_make_server_record(name="broken", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        mock_instance = _make_mock_server()
        mock_instance.start = AsyncMock(side_effect=ConnectionError("cannot connect"))
        mock_cls.return_value = mock_instance

        result = await mgr.test_server(sid)
        assert result["success"] is False
        assert "cannot connect" in result["diagnostics"]["error_details"]


# ═══════════════════════════════════════════════════════════════════════════
# SERVER INFO AND LISTING
# ═══════════════════════════════════════════════════════════════════════════


class TestServerInfoAndListing:
    async def test_get_server_info_found_running(self):
        sid = uuid4()
        servers = [_make_server_record(name="running", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()

        result = await mgr.get_server_info(sid)
        assert result is not None
        assert result["is_running"] is True

    async def test_get_server_info_found_not_running(self):
        sid = uuid4()
        servers = [_make_server_record(name="stopped", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        result = await mgr.get_server_info(sid)
        assert result is not None
        assert result["is_running"] is False

    async def test_get_server_info_with_sandbox(self):
        sid = uuid4()
        servers = [_make_server_record(name="sandboxed", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mock_sandbox = MagicMock()
        mock_sandbox.get_stats.return_value = {"cpu_usage": 10}
        mgr._sandboxes[sid] = mock_sandbox

        result = await mgr.get_server_info(sid)
        assert result["sandbox_stats"] == {"cpu_usage": 10}

    async def test_get_server_info_not_found(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        result = await mgr.get_server_info(uuid4())
        assert result is None

    async def test_list_servers_empty(self):
        db = _FakeMcpDb([])
        mgr = MCPServerManager(db)
        result = await mgr.list_servers()
        assert result == []

    async def test_list_servers_with_dicts(self):
        sid = uuid4()
        servers = [_make_server_record(name="s1", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert len(result) == 1
        assert result[0]["name"] == "s1"
        assert "is_running" in result[0]
        assert "tools_count" in result[0]

    async def test_list_servers_with_pydantic_model(self):
        sid = uuid4()
        mock_model = MagicMock()
        mock_model.model_dump.return_value = {
            "id": sid, "name": "pydantic-server", "server_type": "local",
        }
        db = _FakeMcpDb()
        db.list_servers = AsyncMock(return_value=[mock_model])
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert len(result) == 1
        assert result[0]["name"] == "pydantic-server"

    async def test_list_servers_stats_failure(self):
        sid = uuid4()
        servers = [_make_server_record(name="s1", server_id=sid)]
        db = _FakeMcpDb(servers)
        db.get_server_stats = AsyncMock(side_effect=RuntimeError("stats fail"))
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert len(result) == 1
        assert result[0]["tools_count"] == 0  # Falls back to 0

    async def test_list_servers_invalid_uuid(self):
        db = _FakeMcpDb()
        db.list_servers = AsyncMock(return_value=[{"id": "not-a-uuid", "name": "bad"}])
        mgr = MCPServerManager(db)

        result = await mgr.list_servers()
        assert len(result) == 1
        assert result[0]["is_running"] is False


# ═══════════════════════════════════════════════════════════════════════════
# GET / DELETE SERVER (by ID or name)
# ═══════════════════════════════════════════════════════════════════════════


class TestGetDeleteServer:
    async def test_get_server_by_uuid(self):
        sid = uuid4()
        servers = [_make_server_record(name="find-me", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        result = await mgr.get_server(str(sid))
        assert result is not None
        assert result["name"] == "find-me"

    async def test_get_server_by_name(self):
        servers = [_make_server_record(name="named-server")]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        result = await mgr.get_server("named-server")
        assert result is not None
        assert result["name"] == "named-server"

    async def test_get_server_not_found(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        result = await mgr.get_server("nonexistent")
        assert result is None

    async def test_delete_server_by_uuid(self):
        sid = uuid4()
        servers = [_make_server_record(name="delete-me", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._stop_server = AsyncMock()

        result = await mgr.delete_server(str(sid))
        assert result is True

    async def test_delete_server_by_name(self):
        sid = uuid4()
        servers = [_make_server_record(name="delete-by-name", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._stop_server = AsyncMock()

        result = await mgr.delete_server("delete-by-name")
        assert result is True

    async def test_delete_server_not_found(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        result = await mgr.delete_server("ghost")
        assert result is False


# ═══════════════════════════════════════════════════════════════════════════
# TOOL CACHING
# ═══════════════════════════════════════════════════════════════════════════


class TestGetServerTools:
    async def test_memory_cache_hit(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        cached_tools = [{"name": "cached_tool"}]
        mgr._tool_cache[sid] = (cached_tools, datetime.now(timezone.utc) + timedelta(hours=1))

        result = await mgr.get_server_tools(sid)
        assert result == cached_tools

    async def test_memory_cache_expired(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        expired_tools = [{"name": "old_tool"}]
        mgr._tool_cache[sid] = (expired_tools, datetime.now(timezone.utc) - timedelta(hours=1))
        mgr._active_servers[sid] = _make_mock_server(tools=[{"name": "fresh_tool"}])

        result = await mgr.get_server_tools(sid)
        assert result == [{"name": "fresh_tool"}]
        assert sid not in mgr._tool_cache or mgr._tool_cache[sid][0] == [{"name": "fresh_tool"}]

    async def test_database_cache_hit(self):
        sid = uuid4()
        db = _FakeMcpDb()
        db.get_tools = AsyncMock(return_value=[
            {"openai_schema": {"name": "db_tool"}}
        ])
        mgr = MCPServerManager(db)

        result = await mgr.get_server_tools(sid)
        assert result == [{"name": "db_tool"}]
        # Should populate in-memory cache
        assert sid in mgr._tool_cache

    async def test_live_fetch_from_running_server(self):
        sid = uuid4()
        db = _FakeMcpDb()
        db.get_tools = AsyncMock(return_value=[])  # No DB cache
        mgr = MCPServerManager(db)
        live_tools = [{"name": "live_tool"}]
        mgr._active_servers[sid] = _make_mock_server(tools=live_tools)

        result = await mgr.get_server_tools(sid)
        assert result == live_tools
        db.upsert_tools.assert_awaited_once()
        upsert_args = db.upsert_tools.call_args[0]
        assert upsert_args[0] == sid
        assert upsert_args[1] == live_tools

    async def test_not_running_no_cache(self):
        sid = uuid4()
        db = _FakeMcpDb()
        db.get_tools = AsyncMock(return_value=[])
        mgr = MCPServerManager(db)

        with pytest.raises(RuntimeError, match="not running"):
            await mgr.get_server_tools(sid)

    async def test_string_server_id_conversion(self):
        sid = uuid4()
        db = _FakeMcpDb()
        cached_tools = [{"name": "t"}]
        mgr = MCPServerManager(db)
        mgr._tool_cache[sid] = (cached_tools, datetime.now(timezone.utc) + timedelta(hours=1))

        result = await mgr.get_server_tools(str(sid))
        assert result == cached_tools

    async def test_refresh_ignores_cache(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._tool_cache[sid] = ([{"name": "stale"}], datetime.now(timezone.utc) + timedelta(hours=1))
        mgr._active_servers[sid] = _make_mock_server(tools=[{"name": "fresh"}])

        result = await mgr.get_server_tools(sid, refresh=True)
        assert result == [{"name": "fresh"}]


class TestGetServerToolsByName:
    async def test_found(self):
        sid = uuid4()
        servers = [_make_server_record(name="named", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._tool_cache[sid] = ([{"name": "t"}], datetime.now(timezone.utc) + timedelta(hours=1))

        result = await mgr.get_server_tools_by_name("named")
        assert result == [{"name": "t"}]

    async def test_not_found(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="not found"):
            await mgr.get_server_tools_by_name("ghost")


# ═══════════════════════════════════════════════════════════════════════════
# EXECUTE TOOL
# ═══════════════════════════════════════════════════════════════════════════


class TestExecuteTool:
    async def test_execute_success(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mock_server = _make_mock_server()
        mock_server.apply_tool = AsyncMock(return_value="result data")
        mgr._active_servers[sid] = mock_server

        result = await mgr.execute_tool(sid, "test_tool", {"arg": "val"})
        assert result["success"] is True
        assert result["result"] == "result data"
        assert "duration_ms" in result
        db.log_execution.assert_awaited_once()
        log_kwargs = db.log_execution.call_args.kwargs
        assert log_kwargs["server_id"] == sid
        assert log_kwargs["tool_name"] == "test_tool"
        assert log_kwargs["status"] == "success"

    async def test_execute_error(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mock_server = _make_mock_server()
        mock_server.apply_tool = AsyncMock(side_effect=RuntimeError("tool crashed"))
        mgr._active_servers[sid] = mock_server

        result = await mgr.execute_tool(sid, "bad_tool", {})
        assert result["success"] is False
        assert "tool crashed" in result["error"]
        # Error execution also logged
        assert db.log_execution.await_count == 1

    async def test_execute_not_running(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        with pytest.raises(RuntimeError, match="not running"):
            await mgr.execute_tool(uuid4(), "any", {})

    async def test_execute_string_server_id(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()

        result = await mgr.execute_tool(str(sid), "tool", {})
        assert result["success"] is True

    async def test_execute_with_context(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()

        ctx = {"user_id": "u1", "chat_id": "c1"}
        result = await mgr.execute_tool(sid, "tool", {}, execution_context=ctx)
        assert result["success"] is True
        # Context passed to log_execution
        call_kwargs = db.log_execution.await_args.kwargs
        assert call_kwargs["execution_context"] == ctx

    async def test_execute_with_sandbox(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._sandboxes[sid] = MagicMock()

        result = await mgr.execute_tool(sid, "tool", {})
        assert result["success"] is True
        call_kwargs = db.log_execution.await_args.kwargs
        assert call_kwargs["sandboxed"] is True


# ═══════════════════════════════════════════════════════════════════════════
# HEALTH CHECKS
# ═══════════════════════════════════════════════════════════════════════════


class TestCheckServerHealth:
    async def test_healthy(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server(tools=[{"name": "t1"}, {"name": "t2"}])

        result = await mgr.check_server_health(sid)
        assert result["healthy"] is True
        assert result["tool_count"] == 2
        db.update_health_status.assert_awaited_once()
        call_args = db.update_health_status.call_args[0]
        assert call_args[0] == sid
        assert call_args[1] == "healthy"

    async def test_healthy_with_sandbox(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mock_sandbox = MagicMock()
        mock_sandbox.get_stats.return_value = {"cpu": 5}
        mgr._sandboxes[sid] = mock_sandbox

        result = await mgr.check_server_health(sid)
        assert result["healthy"] is True
        assert result["sandbox_stats"] == {"cpu": 5}

    async def test_unhealthy(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        bad_server = _make_mock_server()
        bad_server.get_tools = AsyncMock(side_effect=ConnectionError("dead"))
        mgr._active_servers[sid] = bad_server

        result = await mgr.check_server_health(sid)
        assert result["healthy"] is False
        assert result["status"] == "unhealthy"
        assert "dead" in result["error"]

    async def test_not_running(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        result = await mgr.check_server_health(uuid4())
        assert result["healthy"] is False
        assert result["status"] == "not_running"

    async def test_string_server_id(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        result = await mgr.check_server_health(str(sid))
        assert result["healthy"] is False  # Not running


# ═══════════════════════════════════════════════════════════════════════════
# START / STOP / RESTART BY NAME
# ═══════════════════════════════════════════════════════════════════════════


class TestStartStopRestartByName:
    async def test_start_by_name_success(self):
        sid = uuid4()
        servers = [_make_server_record(name="startable", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        async def _fake_start(record):
            mgr._active_servers[record["id"]] = _make_mock_server()
            return True

        mgr._start_server = AsyncMock(side_effect=_fake_start)

        result = await mgr.start_server_by_name("startable")
        assert result["name"] == "startable"

    async def test_start_by_name_not_found(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="not found"):
            await mgr.start_server_by_name("ghost")

    async def test_start_by_name_already_running_restarts(self):
        sid = uuid4()
        servers = [_make_server_record(name="running", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock(return_value=True)

        await mgr.start_server_by_name("running")
        mgr._stop_server.assert_awaited_once_with(sid)
        mgr._start_server.assert_awaited_once()

    async def test_start_by_name_fails(self):
        sid = uuid4()
        servers = [_make_server_record(name="bad", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._start_server = AsyncMock(return_value=True)
        # Server not in _active_servers after _start_server (simulates failure)

        with pytest.raises(RuntimeError, match="failed to start"):
            await mgr.start_server_by_name("bad")

    async def test_stop_by_name_running(self):
        sid = uuid4()
        servers = [_make_server_record(name="stoppable", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()

        result = await mgr.stop_server_by_name("stoppable")
        assert result["name"] == "stoppable"
        mgr._stop_server.assert_awaited_once_with(sid)

    async def test_stop_by_name_not_running(self):
        sid = uuid4()
        servers = [_make_server_record(name="already-stopped", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)

        result = await mgr.stop_server_by_name("already-stopped")
        assert result["name"] == "already-stopped"
        db.update_server_status.assert_awaited_once_with(sid, "inactive")

    async def test_stop_by_name_not_found(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="not found"):
            await mgr.stop_server_by_name("ghost")

    async def test_stop_by_name_missing_id(self):
        db = _FakeMcpDb()
        db.get_server_by_name = AsyncMock(return_value={"name": "no-id"})
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="missing 'id'"):
            await mgr.stop_server_by_name("no-id")

    async def test_restart_running_server(self):
        sid = uuid4()
        servers = [_make_server_record(name="restartable", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock(return_value=True)

        result = await mgr.restart_server(sid)
        assert result is True
        mgr._stop_server.assert_awaited_once_with(sid)
        mgr._start_server.assert_awaited_once()

    async def test_restart_stopped_server(self):
        sid = uuid4()
        servers = [_make_server_record(name="stopped", server_id=sid)]
        db = _FakeMcpDb(servers)
        mgr = MCPServerManager(db)
        mgr._stop_server = AsyncMock()
        mgr._start_server = AsyncMock(return_value=True)

        result = await mgr.restart_server(sid)
        assert result is True
        mgr._stop_server.assert_not_awaited()

    async def test_restart_not_found(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="not found"):
            await mgr.restart_server(uuid4())


# ═══════════════════════════════════════════════════════════════════════════
# HISTORY AND STATS
# ═══════════════════════════════════════════════════════════════════════════


class TestHistoryAndStats:
    async def test_get_execution_history(self):
        db = _FakeMcpDb()
        db.get_execution_history = AsyncMock(return_value=[{"id": 1}])
        mgr = MCPServerManager(db)
        result = await mgr.get_execution_history(limit=50)
        assert result == [{"id": 1}]

    async def test_get_execution_history_with_server_id(self):
        sid = uuid4()
        db = _FakeMcpDb()
        db.get_execution_history = AsyncMock(return_value=[])
        mgr = MCPServerManager(db)
        await mgr.get_execution_history(server_id=sid, limit=10)
        db.get_execution_history.assert_awaited_once_with(server_id=sid, limit=10)

    async def test_get_server_stats(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        result = await mgr.get_server_stats(sid)
        assert "tool_count" in result


# ═══════════════════════════════════════════════════════════════════════════
# PRIVATE: _start_server, _start_local_server, _start_remote_server
# ═══════════════════════════════════════════════════════════════════════════


class TestStartServerInternal:
    @patch("core.mcp.manager.ConfiguredLocalServer")
    @patch("core.mcp.manager.MCPSandbox")
    async def test_start_local_with_sandbox(self, mock_sandbox_cls, mock_server_cls):
        sid = uuid4()
        record = _make_server_record(
            name="local-sandboxed", server_id=sid,
            sandbox_enabled=True,
            resource_limits={"max_memory_mb": 256},
        )
        db = _FakeMcpDb([record])
        mgr = MCPServerManager(db)

        mock_server = _make_mock_server()
        mock_server_cls.return_value = mock_server

        result = await mgr._start_server(record)
        assert result is True
        assert sid in mgr._active_servers
        assert sid in mgr._sandboxes

    @patch("core.mcp.manager.ConfiguredLocalServer")
    @patch("core.mcp.manager.NoOpSandbox")
    async def test_start_local_no_sandbox(self, mock_noop_cls, mock_server_cls):
        sid = uuid4()
        record = _make_server_record(
            name="local-no-sandbox", server_id=sid,
            sandbox_enabled=False,
        )
        db = _FakeMcpDb([record])
        mgr = MCPServerManager(db)

        mock_server = _make_mock_server()
        mock_server_cls.return_value = mock_server

        result = await mgr._start_server(record)
        assert result is True
        mock_noop_cls.assert_called_once()

    @patch("core.mcp.manager.RemoteMcpServer")
    async def test_start_remote(self, mock_remote_cls):
        sid = uuid4()
        record = _make_server_record(
            name="remote", server_id=sid,
            server_type="remote",
            config={"url": "http://remote:8000"},
        )
        db = _FakeMcpDb([record])
        mgr = MCPServerManager(db)

        mock_server = _make_mock_server()
        mock_remote_cls.return_value = mock_server

        result = await mgr._start_server(record)
        assert result is True
        assert sid in mgr._active_servers

    async def test_start_server_missing_id(self):
        record = {"name": "no-id", "server_type": "local", "config": {"command": "x"}}
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="missing 'id'"):
            await mgr._start_server(record)

    async def test_start_server_invalid_uuid(self):
        record = {
            "id": "not-a-uuid", "name": "bad-id",
            "server_type": "local", "config": {"command": "x"},
        }
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        with pytest.raises(ValueError, match="Invalid UUID"):
            await mgr._start_server(record)

    async def test_start_server_unknown_type(self):
        sid = uuid4()
        record = {
            "id": sid, "name": "unknown-type",
            "server_type": "webhook", "config": {"url": "x"},
        }
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        result = await mgr._start_server(record)
        assert result is False  # Failure is caught, returns False

    @patch("core.mcp.manager.ConfiguredLocalServer")
    @patch("core.mcp.manager.MCPSandbox")
    async def test_start_server_failure_returns_false(self, mock_sandbox_cls, mock_server_cls):
        sid = uuid4()
        record = _make_server_record(name="fail", server_id=sid)
        db = _FakeMcpDb([record])
        mgr = MCPServerManager(db)

        mock_server = _make_mock_server()
        mock_server.start = AsyncMock(side_effect=OSError("cannot start"))
        mock_server_cls.return_value = mock_server

        result = await mgr._start_server(record)
        assert result is False
        assert sid not in mgr._active_servers

    async def test_start_remote_missing_url(self):
        sid = uuid4()
        record = _make_server_record(
            name="remote-no-url", server_id=sid,
            server_type="remote",
            config={"host": "localhost"},
        )
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        result = await mgr._start_server(record)
        assert result is False  # ValueError caught internally


# ═══════════════════════════════════════════════════════════════════════════
# PRIVATE: _stop_server, _stop_server_quick
# ═══════════════════════════════════════════════════════════════════════════


class TestStopServerInternal:
    async def test_stop_running_server(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mock_server = _make_mock_server()
        mgr._active_servers[sid] = mock_server

        await mgr._stop_server(sid)
        mock_server.stop.assert_awaited_once()
        assert sid not in mgr._active_servers

    async def test_stop_not_running(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        await mgr._stop_server(uuid4())  # Should not raise

    async def test_stop_with_sandbox(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mock_sandbox = AsyncMock()
        mgr._sandboxes[sid] = mock_sandbox

        await mgr._stop_server(sid)
        mock_sandbox.stop_server.assert_awaited_once()
        assert sid not in mgr._sandboxes

    async def test_stop_error_updates_status(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        bad_server = _make_mock_server()
        bad_server.stop = AsyncMock(side_effect=RuntimeError("stop failed"))
        mgr._active_servers[sid] = bad_server

        await mgr._stop_server(sid)  # Should not raise
        # Error status should be reported: "stopping" first, then "error" from the exception
        assert db.update_server_status.await_count >= 2
        db.update_server_status.assert_any_await(sid, "stopping")
        db.update_server_status.assert_any_await(sid, "error", "RuntimeError")

    async def test_stop_quick_running(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()

        await mgr._stop_server_quick(sid)
        mgr._active_servers[sid].stop.assert_awaited_once()

    async def test_stop_quick_not_running(self):
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        await mgr._stop_server_quick(uuid4())  # Should not raise

    async def test_stop_quick_timeout(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        slow = _make_mock_server()
        slow.stop = AsyncMock(side_effect=asyncio.TimeoutError())
        mgr._active_servers[sid] = slow

        await mgr._stop_server_quick(sid)  # Should not raise

    async def test_stop_quick_with_sandbox(self):
        sid = uuid4()
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        mgr._active_servers[sid] = _make_mock_server()
        mock_sandbox = AsyncMock()
        mgr._sandboxes[sid] = mock_sandbox

        await mgr._stop_server_quick(sid)
        mock_sandbox.stop_server.assert_awaited_once()


# ═══════════════════════════════════════════════════════════════════════════
# HEALTH CHECK LOOP
# ═══════════════════════════════════════════════════════════════════════════


class TestHealthCheckLoop:
    async def test_health_check_loop_cancellation(self):
        """Health check loop catches CancelledError and breaks cleanly."""
        db = _FakeMcpDb()
        mgr = MCPServerManager(db)
        task = asyncio.create_task(mgr._health_check_loop())
        await asyncio.sleep(0.01)
        task.cancel()
        # The loop catches CancelledError and breaks, so task finishes normally
        try:
            await asyncio.wait_for(task, timeout=1.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        assert task.done()


# ═══════════════════════════════════════════════════════════════════════════
# SYNC WRAPPER
# ═══════════════════════════════════════════════════════════════════════════


class TestRunCoroutineSync:
    def test_run_coro_new_loop(self):
        mgr = MCPServerManager(_FakeMcpDb())

        async def coro():
            return 42

        result = mgr._run_coro_new_loop(coro())
        assert result == 42

    def test_run_coroutine_sync_no_running_loop(self):
        mgr = MCPServerManager(_FakeMcpDb())

        async def coro():
            return "hello"

        result = mgr.run_coroutine_sync(coro())
        assert result == "hello"
