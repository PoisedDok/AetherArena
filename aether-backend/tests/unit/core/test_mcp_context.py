"""
Tests for core.mcp.context — global MCP manager singleton registry.

Covers:
- set_mcp_manager: stores manager to module-level global
- get_mcp_manager: retrieves stored manager or None
- Isolation between set/get calls
"""

from unittest.mock import MagicMock

import core.mcp.context as ctx


class TestSetMcpManager:
    """Tests for set_mcp_manager()."""

    def setup_method(self):
        """Reset global state before each test."""
        ctx._MCP_MANAGER = None

    def teardown_method(self):
        """Reset global state after each test."""
        ctx._MCP_MANAGER = None

    def test_set_stores_manager(self):
        manager = MagicMock()
        ctx.set_mcp_manager(manager)
        assert ctx._MCP_MANAGER is manager

    def test_set_overwrites_previous(self):
        first = MagicMock()
        second = MagicMock()
        ctx.set_mcp_manager(first)
        ctx.set_mcp_manager(second)
        assert ctx._MCP_MANAGER is second
        assert ctx._MCP_MANAGER is not first

    def test_set_none_clears_manager(self):
        ctx.set_mcp_manager(MagicMock())
        ctx.set_mcp_manager(None)
        assert ctx._MCP_MANAGER is None


class TestGetMcpManager:
    """Tests for get_mcp_manager()."""

    def setup_method(self):
        ctx._MCP_MANAGER = None

    def teardown_method(self):
        ctx._MCP_MANAGER = None

    def test_get_returns_none_when_unset(self):
        result = ctx.get_mcp_manager()
        assert result is None

    def test_get_returns_stored_manager(self):
        manager = MagicMock()
        ctx.set_mcp_manager(manager)
        result = ctx.get_mcp_manager()
        assert result is manager

    def test_get_does_not_consume(self):
        """get_mcp_manager is idempotent — repeated calls return same object."""
        manager = MagicMock()
        ctx.set_mcp_manager(manager)
        assert ctx.get_mcp_manager() is manager
        assert ctx.get_mcp_manager() is manager
