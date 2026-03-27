"""
Tests for core.integrations.providers.aether_rag.mcp_client

Coverage target: 100% of mcp_client.py (139 lines, 0 existing tests).

Mock boundaries:
- core.mcp.context.get_mcp_manager → MCP manager singleton
- config.settings.get_settings → application settings

Real logic under test:
- Server registration with config comparison and conditional update
- Default script path resolution via Path(__file__)
- Backend URL env propagation
- Idempotent registration (skip re-register if already exists)
- Start/skip logic based on is_running
"""

from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import pytest

from core.integrations.providers.aether_rag.mcp_client import (
    ensure_aether_rag_registered,
    aether_rag_list,
    aether_rag_search,
)

# Real UUIDs — source does UUID(str(existing_id)), so string IDs must be valid UUIDs.
_SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
_SID2 = "11111111-2222-3333-4444-555555555555"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _settings(
    base_url="http://127.0.0.1:8765",
    aether_rag_command=None,
    aether_rag_args=None,
    backend_url=None,
):
    s = MagicMock()
    s.base_url = base_url
    s.integrations.aether_rag_mcp_command = aether_rag_command if aether_rag_command else "/usr/bin/python3"
    s.integrations.aether_rag_mcp_args = aether_rag_args if aether_rag_args else []
    s.integrations.file_indexing_backend_url = backend_url
    return s


def _manager(
    get_server_return=None,
    register_return=None,
    execute_return=None,
):
    m = AsyncMock()
    m.get_server.return_value = get_server_return
    m.register_server.return_value = register_return or {"id": _SID2, "name": "file_indexing_mcp"}
    m.update_server.return_value = None
    m.start_server_by_name.return_value = None
    m.execute_tool.return_value = execute_return or {}
    return m


# ---------------------------------------------------------------------------
# ensure_aether_rag_registered
# ---------------------------------------------------------------------------

class TestEnsureAetherRagRegistered:

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.get_settings")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_no_manager_returns_error(self, mock_mgr, mock_gs):
        mock_mgr.return_value = None
        result = await ensure_aether_rag_registered()
        assert result["ok"] is False
        assert "not initialized" in result["error"]

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.get_settings")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_new_registration(self, mock_mgr, mock_gs):
        mock_gs.return_value = _settings()
        mgr = _manager(get_server_return=None, register_return={"id": _SID2, "name": "file_indexing_mcp"})
        mock_mgr.return_value = mgr

        result = await ensure_aether_rag_registered()

        assert result["ok"] is True
        assert result["server"]["id"] == _SID2
        mgr.register_server.assert_awaited_once()

        # Verify exact registration arguments
        call_kwargs = mgr.register_server.call_args[1]
        assert call_kwargs["name"] == "file_indexing_mcp"
        assert call_kwargs["display_name"] == "File Indexing MCP"
        assert call_kwargs["server_type"] == "local"
        assert call_kwargs["config"]["command"] == "/usr/bin/python3"
        # Default path (args was empty → resolved from __file__)
        assert len(call_kwargs["config"]["args"]) == 1
        assert call_kwargs["config"]["args"][0].endswith("mcp_server.py")
        assert call_kwargs["auto_start"] is True
        assert call_kwargs["enabled"] is True

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.get_settings")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_existing_no_update_needed(self, mock_mgr, mock_gs):
        settings = _settings(aether_rag_command="/usr/bin/python3", aether_rag_args=["script.py"])
        mock_gs.return_value = settings
        existing = {
            "id": _SID,
            "config": {"command": "/usr/bin/python3", "args": ["script.py"]},
            "is_running": True,
        }
        mgr = _manager(get_server_return=existing)
        # Second get_server (refreshed) returns same
        mgr.get_server.side_effect = [existing, existing]
        mock_mgr.return_value = mgr

        result = await ensure_aether_rag_registered()

        assert result["ok"] is True
        mgr.update_server.assert_not_awaited()
        mgr.start_server_by_name.assert_not_awaited()  # already running

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.get_settings")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_existing_needs_update(self, mock_mgr, mock_gs):
        settings = _settings(aether_rag_command="/usr/bin/python3", aether_rag_args=["new_script.py"])
        mock_gs.return_value = settings
        existing = {
            "id": _SID,
            "config": {"command": "/usr/bin/python3", "args": ["old_script.py"]},
            "is_running": False,
        }
        refreshed = {**existing, "config": {"command": "/usr/bin/python3", "args": ["new_script.py"]}}
        mgr = _manager(get_server_return=existing)
        mgr.get_server.side_effect = [existing, refreshed]
        mock_mgr.return_value = mgr

        result = await ensure_aether_rag_registered()

        assert result["ok"] is True
        # Verify update_server called with correct UUID, full config, and flags
        mgr.update_server.assert_awaited_once_with(
            UUID(_SID),
            config={
                "command": "/usr/bin/python3",
                "args": ["new_script.py"],
                "env": {"INTEGRATION_FILE_INDEXING_BACKEND_URL": "http://127.0.0.1:8765"},
            },
            auto_start=True,
            enabled=True,
        )
        mgr.start_server_by_name.assert_awaited_once_with("file_indexing_mcp")

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.get_settings")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_existing_not_running_starts(self, mock_mgr, mock_gs):
        settings = _settings(aether_rag_command="python3", aether_rag_args=["s.py"])
        mock_gs.return_value = settings
        existing = {
            "id": _SID,
            "config": {"command": "python3", "args": ["s.py"]},
            "is_running": False,
        }
        mgr = _manager(get_server_return=existing)
        mgr.get_server.side_effect = [existing, existing]
        mock_mgr.return_value = mgr

        await ensure_aether_rag_registered(auto_start=True)

        mgr.start_server_by_name.assert_awaited_once_with("file_indexing_mcp")

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.get_settings")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_backend_url_in_env(self, mock_mgr, mock_gs):
        settings = _settings(backend_url="http://custom:9999")
        mock_gs.return_value = settings
        mgr = _manager(get_server_return=None)
        mock_mgr.return_value = mgr

        await ensure_aether_rag_registered()

        call_kwargs = mgr.register_server.call_args[1]
        assert call_kwargs["config"]["env"]["INTEGRATION_FILE_INDEXING_BACKEND_URL"] == "http://custom:9999"

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.get_settings")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_default_backend_url_from_base(self, mock_mgr, mock_gs):
        """No file_indexing_backend_url → falls back to settings.base_url."""
        settings = _settings(base_url="http://127.0.0.1:8765", backend_url=None)
        mock_gs.return_value = settings
        mgr = _manager(get_server_return=None)
        mock_mgr.return_value = mgr

        await ensure_aether_rag_registered()

        call_kwargs = mgr.register_server.call_args[1]
        assert call_kwargs["config"]["env"]["INTEGRATION_FILE_INDEXING_BACKEND_URL"] == "http://127.0.0.1:8765"


# ---------------------------------------------------------------------------
# aether_rag_list
# ---------------------------------------------------------------------------

class TestAetherRagList:

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.ensure_aether_rag_registered")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_no_manager_returns_empty(self, mock_mgr, mock_ensure):
        mock_mgr.return_value = None
        result = await aether_rag_list()
        assert result == []

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.ensure_aether_rag_registered")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_ensure_fails(self, mock_mgr, mock_ensure):
        mgr = AsyncMock()
        mock_mgr.return_value = mgr
        mock_ensure.return_value = {"ok": False, "error": "registration failed"}

        result = await aether_rag_list()

        assert result["success"] is False
        assert "registration failed" in result["error"]

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.ensure_aether_rag_registered")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_no_server_after_ensure(self, mock_mgr, mock_ensure):
        mgr = AsyncMock()
        mgr.get_server.return_value = None
        mock_mgr.return_value = mgr
        mock_ensure.return_value = {"ok": True}

        result = await aether_rag_list()

        assert result["success"] is False

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.ensure_aether_rag_registered")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_success(self, mock_mgr, mock_ensure):
        mgr = AsyncMock()
        mgr.get_server.return_value = {"id": "sid"}
        mgr.execute_tool.return_value = {"indexes": ["idx1", "idx2"]}
        mock_mgr.return_value = mgr
        mock_ensure.return_value = {"ok": True}

        result = await aether_rag_list()

        assert result == {"indexes": ["idx1", "idx2"]}
        mgr.execute_tool.assert_awaited_once_with("sid", "aether_rag_list", {})


# ---------------------------------------------------------------------------
# aether_rag_search
# ---------------------------------------------------------------------------

class TestAetherRagSearch:

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.ensure_aether_rag_registered")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_no_manager_returns_error(self, mock_mgr, mock_ensure):
        mock_mgr.return_value = None
        result = await aether_rag_search("idx", "query")
        assert result["success"] is False
        assert "not initialized" in result["error"]

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.ensure_aether_rag_registered")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_ensure_fails(self, mock_mgr, mock_ensure):
        mgr = AsyncMock()
        mock_mgr.return_value = mgr
        mock_ensure.return_value = {"ok": False, "error": "reg failed"}

        result = await aether_rag_search("idx", "q")
        assert result["success"] is False

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.ensure_aether_rag_registered")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_no_server_returns_error(self, mock_mgr, mock_ensure):
        mgr = AsyncMock()
        mgr.get_server.return_value = None
        mock_mgr.return_value = mgr
        mock_ensure.return_value = {"ok": True}

        result = await aether_rag_search("idx", "q")
        assert result["success"] is False

    @pytest.mark.asyncio
    @patch("core.integrations.providers.aether_rag.mcp_client.ensure_aether_rag_registered")
    @patch("core.integrations.providers.aether_rag.mcp_client.get_mcp_manager")
    async def test_success_with_all_args(self, mock_mgr, mock_ensure):
        mgr = AsyncMock()
        mgr.get_server.return_value = {"id": "sid"}
        mgr.execute_tool.return_value = {"results": [{"text": "found"}]}
        mock_mgr.return_value = mgr
        mock_ensure.return_value = {"ok": True}

        result = await aether_rag_search(
            index_name="my_index",
            query="test query",
            top_k=10,
            complexity=64,
            show_metadata=True,
        )

        assert result == {"results": [{"text": "found"}]}
        mgr.execute_tool.assert_awaited_once_with(
            "sid",
            "aether_rag_search",
            {
                "index_name": "my_index",
                "query": "test query",
                "top_k": 10,
                "complexity": 64,
                "show_metadata": True,
            },
        )
