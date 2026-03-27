"""
@.architecture

Incoming: core/mcp/manager.py --- {Supabase client instance, server/tool/execution data dicts}
Processing: initialize(), close(), create_server(), get_server(), list_servers(), update_server_status(), update_health_status(), upsert_tools(), get_tools(), log_execution(), get_execution_history(), get_server_stats() --- {JOB_CLEANUP_RESOURCE, JOB_DISCOVER_TOOLS, JOB_QUERY_DB, JOB_SAVE_TO_DB, JOB_VALIDATE_SCHEMA}
Outgoing: data/database/repositories/mcp.py (MCPRepository), core/mcp/manager.py --- {Dict[str, Any] server/tool/execution records via Supabase}


MCP Database Layer - Supabase-powered persistence

Provides persistent storage for MCP server management:
- Server configuration and status tracking
- Tool definition caching
- Execution audit trail
- Statistics and health monitoring

All operations delegated to MCPRepository (Supabase SDK).
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

logger = logging.getLogger(__name__)


class MCPDatabase:
    """
    Supabase database interface for MCP server management.
    
    Thin wrapper around MCPRepository that maintains compatibility
    with existing MCP manager code while using Supabase underneath.
    
    All operations use Supabase SDK (no raw SQL).
    """

    def __init__(self, repository: Any):
        """
        Initialize database with an injected repository.
        
        Args:
            repository: Object implementing MCPRepository methods (created in data_persistence layer).
        """
        if repository is None:
            raise ValueError("MCPDatabase requires a repository instance")
        self._repository = repository

    async def initialize(self):
        """
        Initialize MCPDatabase wrapper.

        Repository is expected to be ready (schema created by migrations).
        """
        try:
            if self._repository is None:
                raise RuntimeError("Repository not configured")
            logger.info("MCP database initialized successfully (repository injected)")
            
        except Exception as e:  # noqa: BLE001 -- DB init boundary: re-raises as RuntimeError; must catch all to provide clear error
            logger.error("Failed to initialize MCP database: %s", e)
            raise RuntimeError(f"Database initialization failed: {e}")

    async def close(self):
        """Close database connections (handled by Supabase client)."""
        logger.info("MCP database closed")

    # =========================================================================
    # SERVER OPERATIONS - Delegate to MCPRepository
    # =========================================================================

    async def create_server(
        self,
        name: str,
        display_name: str,
        server_type: str,
        config: Dict[str, Any],
        description: Optional[str] = None,
        enabled: bool = True,
        auto_start: bool = True,
        sandbox_enabled: bool = True,
        resource_limits: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create MCP server."""
        server = await self._repository.create_server(
            name=name,
            display_name=display_name,
            server_type=server_type,
            config=config,
            description=description,
            enabled=enabled,
            auto_start=auto_start,
            sandbox_enabled=sandbox_enabled,
            resource_limits=resource_limits,
        )
        return server.model_dump()

    async def get_server(self, server_id: UUID) -> Optional[Dict[str, Any]]:
        """Get server by ID."""
        server = await self._repository.get_server(server_id)
        return server.model_dump() if server else None

    async def get_server_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """Get server by name."""
        server = await self._repository.get_server_by_name(name)
        return server.model_dump() if server else None

    async def list_servers(
        self,
        enabled_only: bool = False,
        server_type: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """List all servers."""
        servers = await self._repository.list_servers(
            enabled_only=enabled_only,
            server_type=server_type
        )
        return [s.model_dump() for s in servers]

    async def update_server_status(
        self,
        server_id: UUID,
        status: str,
        error_message: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Update server status."""
        server = await self._repository.update_server_status(
            server_id=server_id,
            status=status,
            error_message=error_message
        )
        return server.model_dump() if server else None

    async def update_health_status(
        self,
        server_id: UUID,
        health_status: str,
        last_health_check: datetime
    ) -> Optional[Dict[str, Any]]:
        """Update server health."""
        server = await self._repository.update_server_health(
            server_id=server_id,
            health_status=health_status,
            last_health_check=last_health_check
        )
        return server.model_dump() if server else None

    async def update_server(
        self,
        server_id: UUID,
        **updates
    ) -> Dict[str, Any]:
        """
        Update server configuration.
        
        Args:
            server_id: Server UUID
            **updates: Fields to update (display_name, description, config, auto_start, enabled)
            
        Returns:
            Updated server record
            
        Raises:
            ValueError: If server not found
        """
        server = await self._repository.update_server(server_id, **updates)
        if not server:
            raise ValueError(f"Server {server_id} not found")
        return server.model_dump()

    async def delete_server(self, server_id: UUID) -> bool:
        """Delete server."""
        return await self._repository.delete_server(server_id)

    # =========================================================================
    # TOOL OPERATIONS
    # =========================================================================

    async def upsert_tools(
        self,
        server_id: UUID,
        tools: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Upsert tool definitions."""
        tool_objs = await self._repository.upsert_tools(server_id, tools)
        return [t.model_dump() for t in tool_objs]

    async def get_tools(
        self,
        server_id: UUID,
        enabled_only: bool = True
    ) -> List[Dict[str, Any]]:
        """Get server tools."""
        tools = await self._repository.get_tools(server_id, enabled_only)
        return [t.model_dump() for t in tools]

    async def get_tool(
        self,
        server_id: UUID,
        tool_name: str
    ) -> Optional[Dict[str, Any]]:
        """Get specific tool."""
        tool = await self._repository.get_tool(server_id, tool_name)
        return tool.model_dump() if tool else None

    # =========================================================================
    # EXECUTION OPERATIONS
    # =========================================================================

    async def log_execution(
        self,
        server_id: UUID,
        tool_name: str,
        parameters: Dict[str, Any],
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        execution_time_ms: Optional[int] = None,
        status: str = "pending",
        execution_context: Optional[Dict[str, Any]] = None,
        sandboxed: bool = True,
    ) -> Dict[str, Any]:
        """Log tool execution."""
        execution = await self._repository.log_execution(
            server_id=server_id,
            tool_name=tool_name,
            parameters=parameters,
            result=result,
            error=error,
            execution_time_ms=execution_time_ms,
            status=status,
            execution_context=execution_context,
            sandboxed=sandboxed,
        )
        return execution.model_dump()

    async def update_execution(
        self,
        execution_id: UUID,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        execution_time_ms: Optional[int] = None,
        status: str = "success",
    ) -> Optional[Dict[str, Any]]:
        """Update execution record."""
        execution = await self._repository.update_execution(
            execution_id=execution_id,
            result=result,
            error=error,
            execution_time_ms=execution_time_ms,
            status=status,
        )
        return execution.model_dump() if execution else None

    async def get_execution_history(
        self,
        server_id: Optional[UUID] = None,
        tool_name: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """Get execution history."""
        executions = await self._repository.get_execution_history(
            server_id=server_id,
            tool_name=tool_name,
            status=status,
            limit=limit,
            offset=offset
        )
        return [e.model_dump() for e in executions]

    async def get_server_stats(self, server_id: UUID) -> Dict[str, Any]:
        """Get server statistics."""
        return await self._repository.get_server_stats(server_id)
