"""
Tests for core.integrations.providers.mcp.bridge — MCPBridge and MCPToolsClass.

Coverage targets: 100% of bridge.py (570 lines, 0 existing tests).

Bug regressions:
- Lines 537/568: await on sync method (TypeError) — fixed to sync delegation.
"""

import inspect
import sys
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

import pytest

from core.integrations.providers.mcp.bridge import MCPBridge, MCPToolsClass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SID = uuid4()


def _server(name="test-srv", running=True, enabled=True, sid=None):
    return {
        "id": sid or _SID,
        "name": name,
        "display_name": f"Display: {name}",
        "server_type": "local",
        "status": "running" if running else "stopped",
        "is_running": running,
        "enabled": enabled,
        "description": f"Desc: {name}",
    }


def _tool(name="do_thing", desc="Does a thing", params=None):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": desc,
            "parameters": params or {"type": "object", "properties": {}},
        },
    }


def _mgr(**kw):
    m = MagicMock()
    m.list_servers = AsyncMock(return_value=kw.get("servers", []))
    m.get_server_tools = AsyncMock(return_value=kw.get("tools", []))
    m.execute_tool = AsyncMock(return_value=kw.get("exec_result", {"success": True}))
    m.check_server_health = AsyncMock(return_value=kw.get("health", {"healthy": True}))
    m.get_execution_history = AsyncMock(return_value=kw.get("history", []))
    m.db = MagicMock()
    m.db.get_server_by_name = AsyncMock(return_value=kw.get("db_server", None))
    return m


def _interp():
    i = MagicMock()
    i.computer = MagicMock()
    return i


def _bridge(interp=None, mgr=None):
    return MCPBridge(interp or _interp(), mgr or _mgr())


@contextmanager
def _loop_running():
    """Mock event loop in running state → run_coroutine_threadsafe path."""
    loop = MagicMock()
    loop.is_running.return_value = True
    future = MagicMock()
    with patch("asyncio.get_event_loop", return_value=loop), \
         patch("asyncio.run_coroutine_threadsafe", return_value=future):
        yield loop, future


@contextmanager
def _loop_stopped():
    """Mock event loop in stopped state → run_until_complete path."""
    loop = MagicMock()
    loop.is_running.return_value = False
    with patch("asyncio.get_event_loop", return_value=loop):
        yield loop


def _tool_metadata_modules():
    """Create fake sys.modules entries for interpreter.core.computer.tool_metadata."""
    mock_module = MagicMock()
    mock_module.ToolComplexity = MagicMock()
    mock_module.ToolComplexity.MODERATE = "moderate"
    return {
        "interpreter": MagicMock(),
        "interpreter.core": MagicMock(),
        "interpreter.core.computer": MagicMock(),
        "interpreter.core.computer.tool_metadata": mock_module,
    }, mock_module


# ---------------------------------------------------------------------------
# MCPBridge.__init__
# ---------------------------------------------------------------------------

class TestMCPBridgeInit:
    def test_attributes(self):
        interp = _interp()
        mgr = _mgr()
        b = MCPBridge(interp, mgr)
        assert b._interpreter is interp
        assert b._computer is interp.computer
        assert b._manager is mgr
        assert b._bridge_marker == "mcp_bridge"

    def test_empty_cache(self):
        assert _bridge()._server_cache == {}


# ---------------------------------------------------------------------------
# MCPBridge.install
# ---------------------------------------------------------------------------

class TestInstall:
    def test_success(self):
        interp = _interp()
        b = MCPBridge(interp, _mgr())
        assert b.install() is True
        assert interp.computer.mcp is b
        assert isinstance(interp.computer.mcp_tools, MCPToolsClass)

    def test_failure_returns_false(self):
        b = _bridge()
        with patch("core.integrations.providers.mcp.bridge.MCPToolsClass", side_effect=RuntimeError):
            assert b.install() is False


# ---------------------------------------------------------------------------
# MCPBridge._get_server_id
# ---------------------------------------------------------------------------

class TestGetServerId:
    @pytest.mark.asyncio
    async def test_cache_hit(self):
        b = _bridge()
        uid = uuid4()
        b._server_cache["cached"] = uid
        result = await b._get_server_id("cached")
        assert result == uid
        b._manager.db.get_server_by_name.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_cache_miss_fetches_and_caches(self):
        uid = uuid4()
        mgr = _mgr(db_server={"id": str(uid)})
        b = _bridge(mgr=mgr)
        result = await b._get_server_id("new")
        assert result == uid
        assert b._server_cache["new"] == uid
        mgr.db.get_server_by_name.assert_awaited_once_with("new")

    @pytest.mark.asyncio
    async def test_not_found_raises(self):
        b = _bridge(mgr=_mgr(db_server=None))
        with pytest.raises(ValueError, match="not found"):
            await b._get_server_id("missing")


# ---------------------------------------------------------------------------
# MCPBridge.list_servers
# ---------------------------------------------------------------------------

class TestListServers:
    def test_loop_stopped(self):
        servers = [_server("a"), _server("b")]
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.return_value = servers
            result = b.list_servers()
        assert len(result) == 2
        assert result[0]["name"] == "a"
        assert result[1]["name"] == "b"

    def test_loop_running(self):
        servers = [_server("x")]
        b = _bridge()
        with _loop_running() as (_, future):
            future.result.return_value = servers
            result = b.list_servers()
        assert len(result) == 1
        assert result[0]["name"] == "x"
        future.result.assert_called_once_with(timeout=10)

    def test_filters_disabled(self):
        servers = [_server("ok", enabled=True), _server("off", enabled=False)]
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.return_value = servers
            result = b.list_servers()
        assert len(result) == 1
        assert result[0]["name"] == "ok"

    def test_output_keys(self):
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.return_value = [_server("s")]
            result = b.list_servers()
        expected = {"name", "display_name", "type", "status", "is_running", "description"}
        assert set(result[0].keys()) == expected

    def test_exception_returns_empty(self):
        b = _bridge()
        with patch("asyncio.get_event_loop", side_effect=RuntimeError):
            assert b.list_servers() == []


# ---------------------------------------------------------------------------
# MCPBridge.list_tools
# ---------------------------------------------------------------------------

class TestListTools:
    def test_loop_stopped(self):
        tools = [_tool("t1")]
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.side_effect = [uuid4(), tools]
            result = b.list_tools("srv")
        assert result == tools

    def test_loop_running(self):
        tools = [_tool("t2")]
        b = _bridge()
        with _loop_running() as (_, future):
            future.result.side_effect = [uuid4(), tools]
            result = b.list_tools("srv")
        assert result == tools

    def test_with_refresh(self):
        tools = [_tool()]
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.side_effect = [uuid4(), tools]
            result = b.list_tools("srv", refresh=True)
        assert result == tools

    def test_exception_returns_empty(self):
        b = _bridge()
        with patch("asyncio.get_event_loop", side_effect=RuntimeError):
            assert b.list_tools("srv") == []


# ---------------------------------------------------------------------------
# MCPBridge.execute
# ---------------------------------------------------------------------------

class TestExecute:
    def test_loop_stopped(self):
        sid = uuid4()
        exec_result = {"success": True, "data": "val"}
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.side_effect = [sid, exec_result]
            result = b.execute("srv", "tool", arg1="v1")
        assert result == exec_result

    def test_loop_running(self):
        exec_result = {"success": True}
        b = _bridge()
        with _loop_running() as (_, future):
            future.result.side_effect = [uuid4(), exec_result]
            result = b.execute("srv", "tool")
        assert result == exec_result
        # Second call has 5-min timeout
        assert future.result.call_args_list[1][1] == {"timeout": 300}

    def test_exception_returns_error_dict(self):
        b = _bridge()
        with patch("asyncio.get_event_loop", side_effect=ValueError("bad")):
            result = b.execute("srv", "tool")
        assert result["success"] is False
        assert "bad" in result["error"]
        assert result["duration_ms"] == 0

    def test_passes_execution_context(self):
        """Execution context includes source and interpreter_id."""
        sid = uuid4()
        mgr = _mgr()
        interp = _interp()
        b = MCPBridge(interp, mgr)
        with _loop_stopped() as loop:
            # _get_server_id
            loop.run_until_complete.side_effect = [
                sid,
                {"success": True},
            ]
            b.execute("srv", "tool", x=1)
        # The second run_until_complete call is execute_tool coroutine
        assert loop.run_until_complete.call_count == 2


# ---------------------------------------------------------------------------
# MCPBridge.health
# ---------------------------------------------------------------------------

class TestHealth:
    def test_loop_stopped(self):
        health = {"healthy": True, "latency_ms": 5}
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.side_effect = [uuid4(), health]
            result = b.health("srv")
        assert result == health

    def test_loop_running(self):
        health = {"healthy": True}
        b = _bridge()
        with _loop_running() as (_, future):
            future.result.side_effect = [uuid4(), health]
            result = b.health("srv")
        assert result == health

    def test_exception_returns_unhealthy(self):
        b = _bridge()
        with patch("asyncio.get_event_loop", side_effect=RuntimeError("fail")):
            result = b.health("srv")
        assert result["healthy"] is False
        assert result["status"] == "error"
        assert "fail" in result["error"]


# ---------------------------------------------------------------------------
# MCPBridge.get_execution_history
# ---------------------------------------------------------------------------

class TestExecutionHistory:
    def test_with_server_name_loop_stopped(self):
        history = [{"id": "e1"}]
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.side_effect = [uuid4(), history]
            result = b.get_execution_history(server_name="srv", limit=10)
        assert result == history

    def test_without_server_name_loop_stopped(self):
        history = [{"id": "e2"}]
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.return_value = history
            result = b.get_execution_history()
        assert result == history
        loop.run_until_complete.assert_called_once()

    def test_with_server_name_loop_running(self):
        history = [{"id": "e3"}]
        b = _bridge()
        with _loop_running() as (_, future):
            future.result.side_effect = [uuid4(), history]
            result = b.get_execution_history(server_name="srv")
        assert result == history

    def test_without_server_name_loop_running(self):
        history = [{"id": "e4"}]
        b = _bridge()
        with _loop_running() as (_, future):
            future.result.return_value = history
            result = b.get_execution_history()
        assert result == history

    def test_exception_returns_empty(self):
        b = _bridge()
        with patch("asyncio.get_event_loop", side_effect=RuntimeError):
            assert b.get_execution_history() == []


# ---------------------------------------------------------------------------
# MCPBridge.__repr__ / __str__
# ---------------------------------------------------------------------------

class TestReprStr:
    def test_repr(self):
        b = _bridge()
        b._server_cache["a"] = uuid4()
        b._server_cache["b"] = uuid4()
        assert "2 servers cached" in repr(b)

    def test_str_with_servers(self):
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.return_value = [_server("alpha"), _server("beta")]
            s = str(b)
        assert "2 servers" in s
        assert "alpha" in s
        assert "beta" in s

    def test_str_no_servers(self):
        b = _bridge()
        with _loop_stopped() as loop:
            loop.run_until_complete.return_value = []
            s = str(b)
        assert "0 servers" in s
        assert "none" in s


# ---------------------------------------------------------------------------
# MCPBridge._register_dynamic_tools_async
# ---------------------------------------------------------------------------

class TestRegisterDynamicTools:
    @pytest.mark.asyncio
    async def test_registers_tool_on_computer(self):
        srv = _server("weather", running=True)
        tool = _tool("forecast", "Get forecast")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        b = MCPBridge(interp, mgr)
        await b._register_dynamic_tools_async()
        assert hasattr(interp.computer, "mcp_weather_forecast")

    @pytest.mark.asyncio
    async def test_skips_non_running_servers(self):
        srv = _server("stopped", running=False)
        mgr = _mgr(servers=[srv])
        b = _bridge(mgr=mgr)
        await b._register_dynamic_tools_async()
        mgr.get_server_tools.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_tool_executor_delegates_to_bridge_execute(self):
        srv = _server("s1", running=True)
        tool = _tool("run", "Run it")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        b = MCPBridge(interp, mgr)
        await b._register_dynamic_tools_async()
        executor = getattr(interp.computer, "mcp_s1_run")
        with patch.object(b, "execute", return_value={"ok": True}) as mock_exec:
            result = executor(key="val")
        mock_exec.assert_called_once_with("s1", "run", key="val")
        assert result == {"ok": True}

    @pytest.mark.asyncio
    async def test_tool_executor_name_and_doc(self):
        srv = _server("myserv", running=True)
        params = {"type": "object", "properties": {"x": {"type": "integer"}}}
        tool = _tool("my_tool", "Tool desc", params)
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        b = MCPBridge(interp, mgr)
        await b._register_dynamic_tools_async()
        executor = getattr(interp.computer, "mcp_myserv_my_tool")
        assert executor.__name__ == "mcp_myserv_my_tool"
        assert "Tool desc" in executor.__doc__
        assert "myserv" in executor.__doc__

    @pytest.mark.asyncio
    async def test_with_tool_metadata_and_engine(self):
        srv = _server("mem-server", running=True)
        tool = _tool("search", "Search", {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Q"}},
            "required": ["query"],
        })
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        interp.computer.tools = MagicMock()
        interp.computer.tools._engine = MagicMock()
        b = MCPBridge(interp, mgr)
        b.install()

        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()

        interp.computer.tools._engine.register_dynamic_tools.assert_called_once()
        metadata_list = interp.computer.tools._engine.register_dynamic_tools.call_args[0][0]
        assert len(metadata_list) == 1

    @pytest.mark.asyncio
    async def test_subcategory_memory(self):
        srv = _server("memory-store", running=True)
        tool = _tool("recall", "Recall")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        interp.computer.tools = MagicMock()
        interp.computer.tools._engine = MagicMock()
        b = MCPBridge(interp, mgr)
        b.install()

        captured = []
        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = lambda **kw: captured.append(kw) or MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()
        assert captured[0]["subcategory"] == "Memory & Knowledge"

    @pytest.mark.asyncio
    async def test_subcategory_knowledge(self):
        srv = _server("knowledge-base", running=True)
        tool = _tool("query", "Query")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        interp.computer.tools = MagicMock()
        interp.computer.tools._engine = MagicMock()
        b = MCPBridge(interp, mgr)
        b.install()

        captured = []
        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = lambda **kw: captured.append(kw) or MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()
        assert captured[0]["subcategory"] == "Memory & Knowledge"

    @pytest.mark.asyncio
    async def test_subcategory_filesystem(self):
        srv = _server("file-manager", running=True)
        tool = _tool("read", "Read")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        interp.computer.tools = MagicMock()
        interp.computer.tools._engine = MagicMock()
        b = MCPBridge(interp, mgr)
        b.install()

        captured = []
        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = lambda **kw: captured.append(kw) or MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()
        assert captured[0]["subcategory"] == "Filesystem Access"

    @pytest.mark.asyncio
    async def test_subcategory_fs(self):
        srv = _server("local-fs", running=True)
        tool = _tool("write", "Write")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        interp.computer.tools = MagicMock()
        interp.computer.tools._engine = MagicMock()
        b = MCPBridge(interp, mgr)
        b.install()

        captured = []
        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = lambda **kw: captured.append(kw) or MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()
        assert captured[0]["subcategory"] == "Filesystem Access"

    @pytest.mark.asyncio
    async def test_subcategory_default(self):
        srv = _server("custom-api", running=True)
        tool = _tool("call", "Call")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        interp.computer.tools = MagicMock()
        interp.computer.tools._engine = MagicMock()
        b = MCPBridge(interp, mgr)
        b.install()

        captured = []
        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = lambda **kw: captured.append(kw) or MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()
        assert captured[0]["subcategory"] == "External Services"

    @pytest.mark.asyncio
    async def test_tool_engine_not_available_no_crash(self):
        """No crash when computer lacks tools._engine."""
        srv = _server("s", running=True)
        tool = _tool("t", "T")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        # Delete tools attribute so hasattr returns False
        del interp.computer.tools
        b = MCPBridge(interp, mgr)

        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()
        # Should complete without error

    @pytest.mark.asyncio
    async def test_tool_engine_register_exception(self):
        srv = _server("s", running=True)
        tool = _tool("t", "T")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        interp.computer.tools = MagicMock()
        interp.computer.tools._engine = MagicMock()
        interp.computer.tools._engine.register_dynamic_tools = MagicMock(
            side_effect=RuntimeError("engine fail")
        )
        b = MCPBridge(interp, mgr)
        b.install()

        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()
        # No propagation

    @pytest.mark.asyncio
    async def test_without_tool_metadata(self):
        """Import failure → tools still registered, no metadata."""
        srv = _server("s", running=True)
        tool = _tool("t", "T")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        b = MCPBridge(interp, mgr)
        # interpreter not installed → import fails naturally
        await b._register_dynamic_tools_async()
        assert hasattr(interp.computer, "mcp_s_t")

    @pytest.mark.asyncio
    async def test_populates_mcp_tools_class(self):
        srv = _server("s", running=True)
        tool = _tool("t", "T")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        b = MCPBridge(interp, mgr)
        b.install()
        mock_pop = AsyncMock()
        interp.computer.mcp_tools._populate_tools = mock_pop
        await b._register_dynamic_tools_async()
        mock_pop.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_populate_exception_logged(self):
        srv = _server("s", running=True)
        tool = _tool("t", "T")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        b = MCPBridge(interp, mgr)
        b.install()
        interp.computer.mcp_tools._populate_tools = AsyncMock(side_effect=RuntimeError("pop fail"))
        await b._register_dynamic_tools_async()
        # No propagation

    @pytest.mark.asyncio
    async def test_no_mcp_tools_attribute(self):
        """When mcp_tools not set, populate is skipped."""
        srv = _server("s", running=True)
        tool = _tool("t", "T")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        b = MCPBridge(interp, mgr)
        # Do NOT call install() — mcp_tools not set
        # But MagicMock auto-creates attributes, so delete it
        del interp.computer.mcp_tools
        await b._register_dynamic_tools_async()
        # Should work fine — populate block skipped

    @pytest.mark.asyncio
    async def test_overall_exception(self):
        mgr = _mgr()
        mgr.list_servers = AsyncMock(side_effect=RuntimeError("boom"))
        b = _bridge(mgr=mgr)
        await b._register_dynamic_tools_async()
        # No propagation

    @pytest.mark.asyncio
    async def test_server_id_string_converted(self):
        sid_str = str(uuid4())
        srv = _server("s", running=True, sid=sid_str)
        tool = _tool("t", "T")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        b = MCPBridge(interp, mgr)
        await b._register_dynamic_tools_async()
        call_args = mgr.get_server_tools.call_args
        assert isinstance(call_args[0][0], UUID)

    @pytest.mark.asyncio
    async def test_tool_params_extraction(self):
        """Tool parameters with properties/required are extracted for metadata."""
        srv = _server("s", running=True)
        tool = _tool("t", "T", {
            "type": "object",
            "properties": {
                "a": {"type": "string", "description": "Param A"},
                "b": {"type": "integer"},
            },
            "required": ["a"],
        })
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        interp.computer.tools = MagicMock()
        interp.computer.tools._engine = MagicMock()
        b = MCPBridge(interp, mgr)
        b.install()

        captured = []
        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = lambda **kw: captured.append(kw) or MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()

        params = captured[0]["parameters"]
        assert len(params) == 2
        param_a = next(p for p in params if p["name"] == "a")
        assert param_a["required"] is True
        assert param_a["type"] == "string"
        assert param_a["description"] == "Param A"
        param_b = next(p for p in params if p["name"] == "b")
        assert param_b["required"] is False

    @pytest.mark.asyncio
    async def test_empty_server_desc_use_case(self):
        """When server has no description, use_cases uses server name as fallback."""
        srv = _server("s", running=True)
        srv["description"] = ""
        tool = _tool("t", "T")
        mgr = _mgr(servers=[srv], tools=[tool])
        interp = _interp()
        interp.computer.tools = MagicMock()
        interp.computer.tools._engine = MagicMock()
        b = MCPBridge(interp, mgr)
        b.install()

        captured = []
        modules, mock_tm = _tool_metadata_modules()
        mock_tm.ToolMetadata = lambda **kw: captured.append(kw) or MagicMock()

        with patch.dict(sys.modules, modules):
            await b._register_dynamic_tools_async()

        use_cases = captured[0]["use_cases"]
        assert "s operations" in use_cases[1]


# ---------------------------------------------------------------------------
# MCPToolsClass
# ---------------------------------------------------------------------------

class TestMCPToolsClass:
    def test_init(self):
        b = _bridge()
        tc = MCPToolsClass(b)
        assert tc._bridge is b
        assert tc._tools_populated is False

    @pytest.mark.asyncio
    async def test_populate_sets_methods(self):
        srv = _server("alpha", running=True)
        tool = _tool("beta", "Beta")
        mgr = _mgr(servers=[srv], tools=[tool])
        b = _bridge(mgr=mgr)
        tc = MCPToolsClass(b)
        await tc._populate_tools()
        assert tc._tools_populated is True
        assert hasattr(tc, "alpha_beta")

    @pytest.mark.asyncio
    async def test_populate_already_done(self):
        mgr = _mgr(servers=[_server()])
        b = _bridge(mgr=mgr)
        tc = MCPToolsClass(b)
        tc._tools_populated = True
        await tc._populate_tools()
        mgr.list_servers.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_populate_skips_non_running(self):
        srv = _server("off", running=False)
        mgr = _mgr(servers=[srv])
        b = _bridge(mgr=mgr)
        tc = MCPToolsClass(b)
        await tc._populate_tools()
        assert tc._tools_populated is True
        mgr.get_server_tools.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_populate_exception(self):
        mgr = _mgr()
        mgr.list_servers = AsyncMock(side_effect=RuntimeError("fail"))
        b = _bridge(mgr=mgr)
        tc = MCPToolsClass(b)
        await tc._populate_tools()
        assert tc._tools_populated is False

    @pytest.mark.asyncio
    async def test_populate_string_id_converted(self):
        sid_str = str(uuid4())
        srv = _server("s", running=True, sid=sid_str)
        tool = _tool("t", "T")
        mgr = _mgr(servers=[srv], tools=[tool])
        b = _bridge(mgr=mgr)
        tc = MCPToolsClass(b)
        await tc._populate_tools()
        assert isinstance(mgr.get_server_tools.call_args[0][0], UUID)

    @pytest.mark.asyncio
    async def test_populated_method_delegates_sync(self):
        """Generated method is sync and delegates to bridge.execute (bug regression)."""
        srv = _server("x", running=True)
        tool = _tool("y", "Y")
        mgr = _mgr(servers=[srv], tools=[tool])
        b = _bridge(mgr=mgr)
        tc = MCPToolsClass(b)
        await tc._populate_tools()
        method = getattr(tc, "x_y")
        # Method must be sync (not coroutine) — regression test for bug fix
        assert not inspect.iscoroutinefunction(method)
        with patch.object(b, "execute", return_value={"r": 1}) as mock_exec:
            result = method(key="val")
        mock_exec.assert_called_once_with("x", "y", key="val")
        assert result == {"r": 1}

    @pytest.mark.asyncio
    async def test_populated_method_has_name_and_doc(self):
        srv = _server("srv", running=True)
        tool = _tool("op", "Op desc")
        mgr = _mgr(servers=[srv], tools=[tool])
        b = _bridge(mgr=mgr)
        tc = MCPToolsClass(b)
        await tc._populate_tools()
        method = getattr(tc, "srv_op")
        assert method.__name__ == "srv_op"
        assert "Op desc" in method.__doc__
        assert "MCP Server: srv" in method.__doc__

    def test_list_servers_delegates(self):
        b = _bridge()
        tc = MCPToolsClass(b)
        with patch.object(b, "list_servers", return_value=[{"name": "s"}]) as m:
            result = tc.list_servers()
        m.assert_called_once()
        assert result == [{"name": "s"}]

    def test_list_tools_delegates(self):
        b = _bridge()
        tc = MCPToolsClass(b)
        with patch.object(b, "list_tools", return_value=[_tool()]) as m:
            result = tc.list_tools("srv")
        m.assert_called_once_with("srv")
        assert len(result) == 1

    def test_health_delegates(self):
        b = _bridge()
        tc = MCPToolsClass(b)
        with patch.object(b, "health", return_value={"healthy": True}) as m:
            result = tc.health("srv")
        m.assert_called_once_with("srv")
        assert result["healthy"] is True

    def test_execute_is_sync_and_delegates(self):
        """Execute is sync — regression for bug fix (was async with await)."""
        b = _bridge()
        tc = MCPToolsClass(b)
        assert not inspect.iscoroutinefunction(tc.execute)
        with patch.object(b, "execute", return_value={"success": True}) as m:
            result = tc.execute("srv", "tool", key="val")
        m.assert_called_once_with("srv", "tool", key="val")
        assert result["success"] is True
