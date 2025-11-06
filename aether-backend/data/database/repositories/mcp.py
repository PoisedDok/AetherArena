"""
MCP Repository - Data access layer for MCP server operations

@.architecture
Incoming: core/mcp/database.py, data/database/connection.py --- {DatabaseConnection instance, CRUD operation requests for servers/tools/executions}
Processing: create_server(), get_server(), list_servers(), update_server_status(), delete_server(), upsert_tools(), get_tools(), log_execution(), get_execution_history(), get_server_stats() --- {10 jobs: server_crud, tool_caching, execution_logging, statistics_aggregation, transaction_management}
Outgoing: PostgreSQL (via DatabaseConnection), core/mcp/database.py --- {SQL INSERT/SELECT/UPDATE/DELETE via async connection, Pydantic model instances: MCPServer, MCPTool, MCPExecution}

Provides CRUD operations for:
- MCP Servers (registration, configuration, status)
- MCP Tools (cached tool definitions)
- MCP Executions (audit log for tool executions)

All operations use async/await and proper transaction management.
"""

import json
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from ..connection import DatabaseConnection
from ..models.mcp import MCPExecution, MCPServer, MCPTool

logger = logging.getLogger(__name__)


class MCPRepository:
    """
    Repository for MCP-related database operations.
    
    Provides clean API for:
    - Server registration and management
    - Tool caching and retrieval
    - Execution logging and statistics
    - Health tracking
    
    All methods are async and use connection pooling.
    """
    
    def __init__(self, db: DatabaseConnection):
        """
        Initialize MCP repository.
        
        Args:
            db: Database connection manager
        """
        self.db = db
    
    # =========================================================================
    # SERVER OPERATIONS
    # =========================================================================
    
    async def create_server(
        self,
        name: str,
        display_name: str,
        server_type: str,
        config: Dict[str, Any],
        description: Optional[str] = None,
        enabled: bool = True,
        sandbox_enabled: bool = True,
        resource_limits: Optional[Dict[str, Any]] = None,
    ) -> MCPServer:
        """
        Register a new MCP server.
        
        Args:
            name: Unique server name
            display_name: Human-readable name
            server_type: Server type (local, remote)
            config: Server configuration (command, args, etc)
            description: Optional description
            enabled: Whether server is enabled
            sandbox_enabled: Whether execution is sandboxed
            resource_limits: Optional resource limits dict
            
        Returns:
            Created MCPServer object
            
        Raises:
            Exception: If server with same name exists or creation fails
        """
        if resource_limits is None:
            resource_limits = {
                "max_memory_mb": 512,
                "max_cpu_percent": 50,
                "max_execution_time_seconds": 300,
            }
        
        config_json = json.dumps(config)
        limits_json = json.dumps(resource_limits)
        
        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO mcp_servers 
                (name, display_name, description, server_type, config, enabled, 
                 sandbox_enabled, resource_limits)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    name,
                    display_name,
                    description,
                    server_type,
                    config_json,
                    enabled,
                    sandbox_enabled,
                    limits_json,
                ),
            )
            row = await cursor.fetchone()
            
        logger.info(f"Registered MCP server '{name}' ({row['id']})")
        return MCPServer(**row)
    
    async def get_server(self, server_id: UUID) -> Optional[MCPServer]:
        """
        Get server by ID.
        
        Args:
            server_id: Server UUID
            
        Returns:
            MCPServer object or None if not found
        """
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(
                "SELECT * FROM mcp_servers WHERE id = %s",
                (server_id,),
            )
            row = await cursor.fetchone()
            
        return MCPServer(**row) if row else None
    
    async def get_server_by_name(self, name: str) -> Optional[MCPServer]:
        """
        Get server by name.
        
        Args:
            name: Server name
            
        Returns:
            MCPServer object or None if not found
        """
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(
                "SELECT * FROM mcp_servers WHERE name = %s",
                (name,),
            )
            row = await cursor.fetchone()
            
        return MCPServer(**row) if row else None
    
    async def list_servers(
        self,
        enabled_only: bool = False,
        server_type: Optional[str] = None
    ) -> List[MCPServer]:
        """
        List all MCP servers.
        
        Args:
            enabled_only: If True, only return enabled servers
            server_type: Optional type filter (local, remote)
            
        Returns:
            List of MCPServer objects
        """
        query = "SELECT * FROM mcp_servers WHERE 1=1"
        params = []
        
        if enabled_only:
            query += " AND enabled = true"
        
        if server_type:
            query += " AND server_type = %s"
            params.append(server_type)
        
        query += " ORDER BY display_name"
        
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(query, tuple(params))
            rows = await cursor.fetchall()
            
        return [MCPServer(**row) for row in rows]
    
    async def update_server(
        self,
        server_id: UUID,
        status: Optional[str] = None,
        error_message: Optional[str] = None,
        health_status: Optional[str] = None,
        enabled: Optional[bool] = None,
        config: Optional[Dict[str, Any]] = None,
    ) -> Optional[MCPServer]:
        """
        Update server status, health, or configuration.
        
        Args:
            server_id: Server UUID
            status: Optional new status (active, inactive, error, etc)
            error_message: Optional error message
            health_status: Optional health status (healthy, unhealthy, unknown)
            enabled: Optional enabled flag
            config: Optional new configuration
            
        Returns:
            Updated MCPServer object or None if not found
        """
        updates = []
        params = []
        
        if status is not None:
            updates.append("status = %s")
            params.append(status)
        
        if error_message is not None:
            updates.append("error_message = %s")
            params.append(error_message)
        
        if health_status is not None:
            updates.append("health_status = %s, last_health_check = NOW()")
            params.append(health_status)
        
        if enabled is not None:
            updates.append("enabled = %s")
            params.append(enabled)
        
        if config is not None:
            updates.append("config = %s")
            params.append(json.dumps(config))
        
        if not updates:
            return await self.get_server(server_id)
        
        query = f"""
            UPDATE mcp_servers
            SET {', '.join(updates)}
            WHERE id = %s
            RETURNING *
        """
        params.append(server_id)
        
        async with self.db.transaction() as conn:
            cursor = await conn.execute(query, tuple(params))
            row = await cursor.fetchone()
            
        if row:
            logger.debug(f"Updated MCP server {server_id}")
            return MCPServer(**row)
        return None
    
    async def delete_server(self, server_id: UUID) -> bool:
        """
        Delete MCP server and all associated data (CASCADE).
        
        Args:
            server_id: Server UUID
            
        Returns:
            True if server was deleted, False if not found
        """
        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                "DELETE FROM mcp_servers WHERE id = %s RETURNING id",
                (server_id,),
            )
            row = await cursor.fetchone()
            
        if row:
            logger.info(f"Deleted MCP server {server_id} and all associated data")
            return True
        return False
    
    async def increment_usage(self, server_id: UUID) -> None:
        """
        Increment total tool calls counter for a server.
        
        Args:
            server_id: Server UUID
        """
        async with self.db.transaction() as conn:
            await conn.execute(
                """
                UPDATE mcp_servers
                SET total_tool_calls = total_tool_calls + 1,
                    last_used_at = NOW()
                WHERE id = %s
                """,
                (server_id,),
            )
    
    async def increment_errors(self, server_id: UUID) -> None:
        """
        Increment total errors counter for a server.
        
        Args:
            server_id: Server UUID
        """
        async with self.db.transaction() as conn:
            await conn.execute(
                """
                UPDATE mcp_servers
                SET total_errors = total_errors + 1
                WHERE id = %s
                """,
                (server_id,),
            )
    
    # =========================================================================
    # TOOL OPERATIONS
    # =========================================================================
    
    async def cache_tools(
        self,
        server_id: UUID,
        tools: List[Dict[str, Any]]
    ) -> int:
        """
        Cache tool definitions from a server.
        
        Replaces existing cached tools for this server.
        
        Args:
            server_id: Server UUID
            tools: List of tool definitions with name, description, schema
            
        Returns:
            Number of tools cached
        """
        async with self.db.transaction() as conn:
            # Delete existing tools
            await conn.execute(
                "DELETE FROM mcp_tools WHERE server_id = %s",
                (server_id,),
            )
            
            # Insert new tools
            cached_count = 0
            for tool in tools:
                await conn.execute(
                    """
                    INSERT INTO mcp_tools
                    (server_id, tool_name, description, parameters, openai_schema)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        server_id,
                        tool["name"],
                        tool.get("description"),
                        json.dumps(tool.get("parameters", {})),
                        json.dumps(tool.get("openai_schema", {})),
                    ),
                )
                cached_count += 1
                
        logger.debug(f"Cached {cached_count} tools for server {server_id}")
        return cached_count
    
    async def get_tools(self, server_id: UUID) -> List[MCPTool]:
        """
        Get cached tools for a server.
        
        Args:
            server_id: Server UUID
            
        Returns:
            List of MCPTool objects
        """
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT * FROM mcp_tools
                WHERE server_id = %s
                ORDER BY tool_name
                """,
                (server_id,),
            )
            rows = await cursor.fetchall()
            
        return [MCPTool(**row) for row in rows]
    
    # =========================================================================
    # EXECUTION LOGGING
    # =========================================================================
    
    async def log_execution(
        self,
        server_id: UUID,
        tool_name: str,
        arguments: Dict[str, Any],
        result: Optional[str],
        status: str,
        duration_ms: Optional[int] = None,
        error_message: Optional[str] = None,
        execution_context: Optional[Dict[str, Any]] = None,
        sandboxed: bool = True,
    ) -> MCPExecution:
        """
        Log a tool execution for audit trail.
        
        Args:
            server_id: Server UUID
            tool_name: Name of tool that was executed
            arguments: Tool arguments
            result: Execution result
            status: Status (success, error, timeout, cancelled)
            duration_ms: Execution duration in milliseconds
            error_message: Optional error message
            execution_context: Optional context information
            sandboxed: Whether execution was sandboxed
            
        Returns:
            Created MCPExecution object
        """
        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO mcp_executions
                (server_id, tool_name, arguments, result, status, duration_ms,
                 error_message, execution_context, sandboxed)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    server_id,
                    tool_name,
                    json.dumps(arguments),
                    result,
                    status,
                    duration_ms,
                    error_message,
                    json.dumps(execution_context) if execution_context else None,
                    sandboxed,
                ),
            )
            row = await cursor.fetchone()
            
        logger.debug(
            f"Logged {status} execution of {tool_name} on server {server_id}"
        )
        return MCPExecution(**row)
    
    async def get_executions(
        self,
        server_id: Optional[UUID] = None,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> List[MCPExecution]:
        """
        Get execution history.
        
        Args:
            server_id: Optional server filter
            status: Optional status filter
            limit: Maximum number of executions
            offset: Number of executions to skip
            
        Returns:
            List of MCPExecution objects
        """
        query = "SELECT * FROM mcp_executions WHERE 1=1"
        params = []
        
        if server_id is not None:
            query += " AND server_id = %s"
            params.append(server_id)
        
        if status is not None:
            query += " AND status = %s"
            params.append(status)
        
        query += " ORDER BY executed_at DESC LIMIT %s OFFSET %s"
        params.extend([limit, offset])
        
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(query, tuple(params))
            rows = await cursor.fetchall()
            
        return [MCPExecution(**row) for row in rows]
    
    # =========================================================================
    # STATISTICS
    # =========================================================================
    
    async def get_server_statistics(
        self,
        server_id: UUID
    ) -> Dict[str, Any]:
        """
        Get execution statistics for a server.
        
        Args:
            server_id: Server UUID
            
        Returns:
            Dict with execution counts and metrics
        """
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT 
                    COUNT(*) as total_executions,
                    COUNT(CASE WHEN status = 'success' THEN 1 END) as successful_executions,
                    COUNT(CASE WHEN status = 'error' THEN 1 END) as failed_executions,
                    COUNT(CASE WHEN status = 'timeout' THEN 1 END) as timeout_executions,
                    AVG(duration_ms) as avg_duration_ms,
                    MAX(executed_at) as last_execution_at
                FROM mcp_executions
                WHERE server_id = %s
                """,
                (server_id,),
            )
            row = await cursor.fetchone()
            
        return dict(row) if row else {}

