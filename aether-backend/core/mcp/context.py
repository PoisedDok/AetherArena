"""
MCP Manager Global Context

Global registry for MCP (Model Context Protocol) manager singleton.
Allows cross-module access without circular dependencies.

@.architecture
Incoming: app.py, api/dependencies.py, core/integrations/providers/aether_rag/health.py --- {MCPServerManager instance}
Processing: set_mcp_manager(), get_mcp_manager() --- {1 jobs: JOB_ORCHESTRATE}
Outgoing: api/dependencies.py, core/integrations/providers/aether_rag/mcp_client.py --- {Optional[MCPServerManager]}
"""

from __future__ import annotations

from typing import Any, Optional


_MCP_MANAGER: Optional[Any] = None


def set_mcp_manager(manager: Any) -> None:
    """Register the global MCP manager instance."""
    global _MCP_MANAGER
    _MCP_MANAGER = manager


def get_mcp_manager() -> Optional[Any]:
    """Return the registered MCP manager if available."""
    return _MCP_MANAGER


__all__ = ["get_mcp_manager", "set_mcp_manager"]

