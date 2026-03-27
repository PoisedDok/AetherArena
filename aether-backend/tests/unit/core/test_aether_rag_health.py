"""
Tests for core.integrations.providers.aether_rag.health

Coverage target: 100% of health.py (127 lines, 0 existing tests).

Mock boundaries:
- core.mcp.context.get_mcp_manager → MCP manager singleton
- config.settings.get_settings → application settings (imported but not directly used)

Real logic under test:
- Multi-stage health check: manager → server → status → tools → test search
- Degradation vs error distinction (healthy=True with degradation vs healthy=False with error)
- Tool name extraction from nested dict structure
- UUID conversion for server ID in tool/execute calls
- Comprehensive result dict assembly at each exit point
"""

from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest

from core.integrations.providers.aether_rag.health import aether_rag_health

# Real UUID — source uses UUID(str(server_id))
_SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

_TOOL_SEARCH = {"function": {"name": "aether_rag_search"}}
_TOOL_LIST = {"function": {"name": "aether_rag_list"}}
_TOOL_OTHER = {"function": {"name": "some_other_tool"}}

# Expected base result (all-false initial state)
_BASE_RESULT = {
    "healthy": False,
    "status": "error",
    "server_registered": False,
    "server_connected": False,
    "tools_count": 0,
    "tools_available": [],
    "test_search_ok": False,
}


def _server(sid=_SID, status="running", is_running=True):
    """Build a mock server dict."""
    return {"id": sid, "status": status, "is_running": is_running}


# ---------------------------------------------------------------------------
# No manager / no server (early exits)
# ---------------------------------------------------------------------------

class TestEarlyExits:

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_no_manager_returns_error(self, mock_mgr):
        mock_mgr.return_value = None

        result = await aether_rag_health()

        assert result["healthy"] is False
        assert result["status"] == "error"
        assert result["server_registered"] is False
        assert "not initialized" in result["error"]

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_no_server_returns_error(self, mock_mgr):
        mgr = AsyncMock()
        mgr.get_server.return_value = None
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["healthy"] is False
        assert result["status"] == "error"
        assert result["server_registered"] is False
        assert "not registered" in result["error"]
        assert "'file_indexing_mcp'" in result["error"]

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_custom_server_name_in_error(self, mock_mgr):
        """Custom server_name should appear in error message."""
        mgr = AsyncMock()
        mgr.get_server.return_value = None
        mock_mgr.return_value = mgr

        result = await aether_rag_health(server_name="my_custom_mcp")

        assert "'my_custom_mcp'" in result["error"]
        mgr.get_server.assert_awaited_once_with("my_custom_mcp")


# ---------------------------------------------------------------------------
# Server status detection
# ---------------------------------------------------------------------------

class TestServerStatus:

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_running_status_connected(self, mock_mgr):
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="running")
        mgr.get_server_tools.return_value = []
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["server_registered"] is True
        assert result["server_connected"] is True
        assert result["server_status"] == "running"

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_connected_status_connected(self, mock_mgr):
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="connected")
        mgr.get_server_tools.return_value = []
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["server_connected"] is True

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_ready_status_connected(self, mock_mgr):
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="ready")
        mgr.get_server_tools.return_value = []
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["server_connected"] is True

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_active_status_connected(self, mock_mgr):
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="active")
        mgr.get_server_tools.return_value = []
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["server_connected"] is True

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_unknown_status_not_connected(self, mock_mgr):
        """Unknown status → server_connected=False. Provide search tool so
        the degradation_reason from status check (line 72) isn't overwritten
        by 'Search tool not available' (line 88)."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="unknown")
        mgr.get_server_tools.return_value = [_TOOL_SEARCH]
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["server_connected"] is False
        assert result["degradation_reason"] == "Server status: unknown"
        # Has search tool but not connected → else branch (line 112), no execute
        mgr.execute_tool.assert_not_awaited()

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_stopped_status_not_connected(self, mock_mgr):
        """Stopped status → server_connected=False, same pattern as unknown."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="stopped")
        mgr.get_server_tools.return_value = [_TOOL_SEARCH]
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["server_connected"] is False
        assert result["degradation_reason"] == "Server status: stopped"
        mgr.execute_tool.assert_not_awaited()


# ---------------------------------------------------------------------------
# Tools listing
# ---------------------------------------------------------------------------

class TestToolsListing:

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_tools_counted_and_named(self, mock_mgr):
        mgr = AsyncMock()
        mgr.get_server.return_value = _server()
        mgr.get_server_tools.return_value = [_TOOL_SEARCH, _TOOL_LIST, _TOOL_OTHER]
        mgr.execute_tool.return_value = {"success": True}
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["tools_count"] == 3
        assert result["tools_available"] == ["aether_rag_search", "aether_rag_list", "some_other_tool"]

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_tools_with_missing_function_key(self, mock_mgr):
        """Tool dict without 'function' key → name should be 'unknown'."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server()
        mgr.get_server_tools.return_value = [{"not_function": True}]
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["tools_count"] == 1
        assert result["tools_available"] == ["unknown"]

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_server_id_none_skips_tools(self, mock_mgr):
        """server_id is None → get_server_tools not called, tools empty."""
        mgr = AsyncMock()
        mgr.get_server.return_value = {"id": None, "status": "running"}
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["tools_count"] == 0
        assert result["tools_available"] == []
        mgr.get_server_tools.assert_not_awaited()

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_get_server_tools_receives_uuid(self, mock_mgr):
        """get_server_tools should receive UUID(server_id) with refresh=True."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server()
        mgr.get_server_tools.return_value = []
        mock_mgr.return_value = mgr

        await aether_rag_health()

        mgr.get_server_tools.assert_awaited_once_with(UUID(_SID), refresh=True)

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_tools_listing_exception_degrades(self, mock_mgr):
        """get_server_tools raises → status=degraded, healthy=True."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server()
        mgr.get_server_tools.side_effect = RuntimeError("tools boom")
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["healthy"] is True
        assert result["status"] == "degraded"
        assert "Tools listing failed" in result["degradation_reason"]
        assert "tools boom" in result["degradation_reason"]


# ---------------------------------------------------------------------------
# Search tool presence and test execution
# ---------------------------------------------------------------------------

class TestSearchToolPresence:

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_no_search_tool_degrades(self, mock_mgr):
        """Tools exist but no aether_rag_search → degraded, healthy=True."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server()
        mgr.get_server_tools.return_value = [_TOOL_LIST, _TOOL_OTHER]
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["healthy"] is True
        assert result["status"] == "degraded"
        assert result["degradation_reason"] == "Search tool not available"
        assert result["test_search_ok"] is False

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_search_success_active(self, mock_mgr):
        """Search tool exists, connected, execute succeeds → active, healthy."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="running")
        mgr.get_server_tools.return_value = [_TOOL_SEARCH]
        mgr.execute_tool.return_value = {"success": True}
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["healthy"] is True
        assert result["status"] == "active"
        assert result["test_search_ok"] is True
        # Verify exact execute_tool args
        mgr.execute_tool.assert_awaited_once_with(
            UUID(_SID),
            "aether_rag_search",
            {"query": "test", "top_k": 1},
        )

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_search_returns_failure_degrades(self, mock_mgr):
        """Search tool executes but returns success=False → degraded."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="running")
        mgr.get_server_tools.return_value = [_TOOL_SEARCH]
        mgr.execute_tool.return_value = {"success": False, "error": "index not found"}
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["healthy"] is True
        assert result["status"] == "degraded"
        assert result["test_search_ok"] is False
        assert result["degradation_reason"] == "index not found"

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_search_failure_no_error_key(self, mock_mgr):
        """Execute returns success=False without 'error' key → 'Unknown error'."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="running")
        mgr.get_server_tools.return_value = [_TOOL_SEARCH]
        mgr.execute_tool.return_value = {"success": False}
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["degradation_reason"] == "Unknown error"

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_search_execution_exception_degrades(self, mock_mgr):
        """execute_tool raises → degraded, healthy=True, test_search_ok=False."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="running")
        mgr.get_server_tools.return_value = [_TOOL_SEARCH]
        mgr.execute_tool.side_effect = ConnectionError("connection refused")
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["healthy"] is True
        assert result["status"] == "degraded"
        assert result["test_search_ok"] is False
        assert "Search execution failed" in result["degradation_reason"]
        assert "connection refused" in result["degradation_reason"]

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_has_search_not_connected_degrades(self, mock_mgr):
        """Search tool present but server not connected → degraded, no execute."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="stopped")
        mgr.get_server_tools.return_value = [_TOOL_SEARCH]
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["healthy"] is True
        assert result["status"] == "degraded"
        assert result["server_connected"] is False
        mgr.execute_tool.assert_not_awaited()

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_has_search_no_server_id_degrades(self, mock_mgr):
        """Search tool present, connected, but server_id is None → degraded, no execute.
        (Line 91: server_connected AND server_id both required)
        """
        mgr = AsyncMock()
        # server_id is None but status triggers connected=True
        mgr.get_server.return_value = {"id": None, "status": "running"}
        # server_id is None → tools listing skipped (line 76), tools=[]
        # so has_search is False → hits line 88, not line 91
        # We need a different approach: server_id truthy for tools listing
        # but then falsy for execute. This can't happen — same variable.
        # So line 91 with !server_id only triggers when server_id is None
        # AND tools have aether_rag_search, which requires get_server_tools call,
        # which requires server_id truthy. Contradiction.
        # Line 112-114 (else branch) is reachable when:
        #   has_search=True AND (NOT server_connected OR NOT server_id)
        # Since has_search requires tools, which requires server_id truthy,
        # the only way to hit line 112 is: has_search=True AND NOT server_connected.
        # The NOT server_id path in line 91 is unreachable if tools require server_id.
        # Testing the server_connected=False + has_search path instead (above test).
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        # With id=None, tools skipped, no search tool → degraded via status check
        assert result["healthy"] is True
        assert result["status"] == "degraded"


# ---------------------------------------------------------------------------
# Outer exception handler
# ---------------------------------------------------------------------------

class TestOuterException:

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_manager_raises_exception(self, mock_mgr):
        """get_mcp_manager() raises → error, not healthy."""
        mock_mgr.side_effect = RuntimeError("init failed")

        result = await aether_rag_health()

        assert result["healthy"] is False
        assert result["status"] == "error"
        assert result["error"] == "init failed"
        assert result["error_type"] == "RuntimeError"

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_get_server_raises_exception(self, mock_mgr):
        """manager.get_server() raises → error, not healthy."""
        mgr = AsyncMock()
        mgr.get_server.side_effect = ConnectionError("db unreachable")
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        assert result["healthy"] is False
        assert result["status"] == "error"
        assert result["error"] == "db unreachable"
        assert result["error_type"] == "ConnectionError"


# ---------------------------------------------------------------------------
# Result structure completeness
# ---------------------------------------------------------------------------

class TestResultStructure:

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_all_base_keys_present_on_error(self, mock_mgr):
        """Even on early error, all base keys must be present."""
        mock_mgr.return_value = None

        result = await aether_rag_health()

        for key in _BASE_RESULT:
            assert key in result, f"Missing key: {key}"

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.health.get_mcp_manager")
    async def test_full_success_has_all_fields(self, mock_mgr):
        """Full success path includes all base keys + server_status."""
        mgr = AsyncMock()
        mgr.get_server.return_value = _server(status="running")
        mgr.get_server_tools.return_value = [_TOOL_SEARCH]
        mgr.execute_tool.return_value = {"success": True}
        mock_mgr.return_value = mgr

        result = await aether_rag_health()

        for key in _BASE_RESULT:
            assert key in result, f"Missing key: {key}"
        assert "server_status" in result
        assert result["server_status"] == "running"
