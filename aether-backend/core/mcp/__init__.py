"""
MCP Core System - Supabase-powered Model Context Protocol management

Production-ready MCP server lifecycle management with security isolation.

@.architecture
Incoming: core/runtime/engine.py, data/database/clients/supabase.py --- {interpreter instance, SupabaseClient, runtime orchestration triggers}
Processing: coordinate MCP lifecycle, persist server registry, enforce sandbox controls --- {JOB_INITIALIZE_COMPONENT, JOB_MANAGE_SESSIONS, JOB_SAVE_TO_DB, JOB_TRACE, JOB_VALIDATE}
Outgoing: interpreter.computer namespace, MCP tools, database tables --- {McpServer instances, registered tools, execution audit logs}

Architecture:
- Server abstractions (LocalMcpServer, RemoteMcpServer) for MCP protocol handling
- Manager for lifecycle orchestration and tool registration
- Database persistence with Supabase (replaces legacy PostgreSQL)
- Security sandboxing with resource limits and process isolation
- Health monitoring and execution auditing via Supabase tables
- Dynamic tool registration into Open Interpreter runtime
"""

from core.mcp.server import McpServer, LocalMcpServer, RemoteMcpServer
from core.mcp.manager import MCPServerManager
from core.mcp.database import MCPDatabase
from core.mcp.sandbox import MCPSandbox, NoOpSandbox
from core.mcp.context import get_mcp_manager, set_mcp_manager

__all__ = [
    # Server abstractions
    "McpServer",
    "LocalMcpServer",
    "RemoteMcpServer",
    # Manager
    "MCPServerManager",
    # Database
    "MCPDatabase",
    # Security
    "MCPSandbox",
    "NoOpSandbox",
    # Global context
    "get_mcp_manager",
    "set_mcp_manager",
]

