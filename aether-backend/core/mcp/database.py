"""
MCP Database Layer

@.architecture
Incoming: core/mcp/manager.py, data/database/migrations/mcp_schema.sql --- {connection string, server/tool/execution data dicts, SQL schema}
Processing: initialize(), close(), create_server(), get_server(), list_servers(), update_server_status(), update_health_status(), upsert_tools(), get_tools(), log_execution(), get_execution_history(), get_server_stats() --- {10 jobs: cleanup, connection_pooling, execution_auditing, health_monitoring, query_execution, schema_initialization, server_crud, statistics_aggregation, tool_caching, transaction_management}
Outgoing: PostgreSQL database (via psycopg pool), core/mcp/manager.py --- {SQL queries with async connection pool, Dict[str, Any] server/tool/execution records}

PostgreSQL persistence for MCP server management with:
- Server configuration and status tracking
- Tool definition caching
- Execution audit trail
- Statistics and health monitoring
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger(__name__)


class MCPDatabase:
    """
    PostgreSQL database interface for MCP server management.
    
    Provides persistent storage for:
    - Server registrations and configurations
    - Tool definitions (cached from servers)
    - Execution history (audit trail)
    - Server statistics and health status
    
    All operations use async connection pooling for performance.
    """

    def __init__(self, connection_string: str):
        """
        Initialize database connection.
        
        Args:
            connection_string: PostgreSQL connection string
                Format: postgresql://user:pass@host:port/database
        """
        self.connection_string = connection_string
        self._pool: Optional[AsyncConnectionPool] = None

    async def initialize(self):
        """
        Create connection pool and initialize schema.
        
        Raises:
            RuntimeError: If database initialization fails
        """
        try:
            # Create async connection pool
            self._pool = AsyncConnectionPool(
                self.connection_string,
                min_size=2,
                max_size=10,
                kwargs={"row_factory": dict_row}
            )
            await self._pool.wait()
            
            # Initialize schema
            await self._initialize_schema()
            logger.info("MCP database initialized successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize MCP database: {e}")
            raise RuntimeError(f"Database initialization failed: {e}")

    async def _initialize_schema(self):
        """Execute schema creation from migrations/mcp_schema.sql."""
        schema_path = Path(__file__).parent.parent.parent / "data" / "database" / "migrations" / "mcp_schema.sql"
        
        if not schema_path.exists():
            logger.warning(f"MCP schema file not found: {schema_path}")
            return
            
        try:
            async with self._pool.connection() as conn:
                async with conn.cursor() as cur:
                    schema_sql = schema_path.read_text()
                    await cur.execute(schema_sql)
                    await conn.commit()
                    logger.info("MCP schema created/updated")
        except Exception as e:
            logger.error(f"Failed to initialize MCP schema: {e}")
            raise

    async def close(self):
        """Close database connections."""
        if self._pool:
            await self._pool.close()
            logger.debug("MCP database connections closed")

    # ==================== Server Operations ====================

    async def create_server(
        self,
        name: str,
        display_name: str,
        server_type: str,
        config: Dict[str, Any],
        description: Optional[str] = None,
        sandbox_enabled: bool = True,
        resource_limits: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Register a new MCP server.
        
        Args:
            name: Unique server identifier (lowercase, no spaces)
            display_name: Human-readable name
            server_type: 'local' or 'remote'
            config: Server configuration (command/args for local, url for remote)
            description: Optional description
            sandbox_enabled: Enable security sandbox
            resource_limits: Resource constraints (memory, CPU, timeout)
            
        Returns:
            Created server record with ID
            
        Raises:
            ValueError: If server with same name already exists
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                try:
                    await cur.execute(
                        """
                        INSERT INTO mcp_servers 
                        (name, display_name, description, server_type, config, 
                         sandbox_enabled, resource_limits)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        RETURNING *
                        """,
                        (
                            name,
                            display_name,
                            description,
                            server_type,
                            json.dumps(config),
                            sandbox_enabled,
                            json.dumps(resource_limits) if resource_limits else None,
                        ),
                    )
                    result = await cur.fetchone()
                    await conn.commit()
                    return dict(result)
                except psycopg.errors.UniqueViolation:
                    raise ValueError(f"Server '{name}' already exists")

    async def get_server(self, server_id: UUID) -> Optional[Dict[str, Any]]:
        """
        Get server by ID.
        
        Args:
            server_id: Server UUID
            
        Returns:
            Server record or None if not found
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT * FROM mcp_servers WHERE id = %s",
                    (str(server_id),)
                )
                result = await cur.fetchone()
                return dict(result) if result else None

    async def get_server_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get server by name.
        
        Args:
            name: Server name
            
        Returns:
            Server record or None if not found
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT * FROM mcp_servers WHERE name = %s",
                    (name,)
                )
                result = await cur.fetchone()
                return dict(result) if result else None

    async def list_servers(
        self,
        status: Optional[str] = None,
        enabled_only: bool = True
    ) -> List[Dict[str, Any]]:
        """
        List all servers with optional filtering.
        
        Args:
            status: Filter by status (active, inactive, error, starting, stopping)
            enabled_only: Only return enabled servers
            
        Returns:
            List of server records
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                query = "SELECT * FROM mcp_servers WHERE 1=1"
                params = []
                
                if enabled_only:
                    query += " AND enabled = true"
                    
                if status:
                    query += " AND status = %s"
                    params.append(status)
                    
                query += " ORDER BY created_at DESC"
                
                await cur.execute(query, params)
                results = await cur.fetchall()
                return [dict(r) for r in results]

    async def update_server_status(
        self,
        server_id: UUID,
        status: str,
        error_message: Optional[str] = None
    ):
        """
        Update server status.
        
        Args:
            server_id: Server UUID
            status: New status (active, inactive, error, starting, stopping)
            error_message: Optional error message
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    UPDATE mcp_servers 
                    SET status = %s, error_message = %s
                    WHERE id = %s
                    """,
                    (status, error_message, str(server_id))
                )
                await conn.commit()

    async def update_health_status(
        self,
        server_id: UUID,
        health_status: str
    ):
        """
        Update server health check result.
        
        Args:
            server_id: Server UUID
            health_status: Health status (healthy, unhealthy, unknown)
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    UPDATE mcp_servers 
                    SET health_status = %s, last_health_check = CURRENT_TIMESTAMP
                    WHERE id = %s
                    """,
                    (health_status, str(server_id))
                )
                await conn.commit()

    async def delete_server(self, server_id: UUID):
        """
        Delete server and all associated data (cascade).
        
        Args:
            server_id: Server UUID
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "DELETE FROM mcp_servers WHERE id = %s",
                    (str(server_id),)
                )
                await conn.commit()

    async def increment_usage(self, server_id: UUID):
        """
        Increment tool call counter.
        
        Args:
            server_id: Server UUID
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    UPDATE mcp_servers 
                    SET total_tool_calls = total_tool_calls + 1,
                        last_used_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                    """,
                    (str(server_id),)
                )
                await conn.commit()

    async def increment_errors(self, server_id: UUID):
        """
        Increment error counter.
        
        Args:
            server_id: Server UUID
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    UPDATE mcp_servers 
                    SET total_errors = total_errors + 1
                    WHERE id = %s
                    """,
                    (str(server_id),)
                )
                await conn.commit()

    # ==================== Tool Operations ====================

    async def upsert_tools(
        self,
        server_id: UUID,
        tools: List[Dict[str, Any]]
    ):
        """
        Update cached tool definitions for a server.
        
        Deletes existing tools and inserts new ones (atomic operation).
        
        Args:
            server_id: Server UUID
            tools: List of tool schemas in OpenAI format
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                # Delete existing tools
                await cur.execute(
                    "DELETE FROM mcp_tools WHERE server_id = %s",
                    (str(server_id),)
                )
                
                # Insert new tools
                for tool in tools:
                    function_def = tool.get("function", {})
                    await cur.execute(
                        """
                        INSERT INTO mcp_tools 
                        (server_id, tool_name, description, parameters, openai_schema)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            str(server_id),
                            function_def.get("name"),
                            function_def.get("description"),
                            json.dumps(function_def.get("parameters", {})),
                            json.dumps(tool),
                        )
                    )
                
                await conn.commit()

    async def get_tools(self, server_id: UUID) -> List[Dict[str, Any]]:
        """
        Get cached tools for a server.
        
        Args:
            server_id: Server UUID
            
        Returns:
            List of tool records
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT * FROM mcp_tools WHERE server_id = %s ORDER BY tool_name",
                    (str(server_id),)
                )
                results = await cur.fetchall()
                return [dict(r) for r in results]

    # ==================== Execution History ====================

    async def log_execution(
        self,
        server_id: UUID,
        tool_name: str,
        arguments: Dict[str, Any],
        result: Optional[str],
        status: str,
        duration_ms: int,
        error_message: Optional[str] = None,
        execution_context: Optional[Dict[str, Any]] = None,
        sandboxed: bool = True,
    ) -> UUID:
        """
        Log tool execution for audit trail.
        
        Args:
            server_id: Server UUID
            tool_name: Name of executed tool
            arguments: Tool arguments
            result: Tool result (if successful)
            status: Execution status (success, error, timeout, cancelled)
            duration_ms: Execution duration in milliseconds
            error_message: Error message (if failed)
            execution_context: Optional context metadata
            sandboxed: Whether execution was sandboxed
            
        Returns:
            Execution UUID
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    INSERT INTO mcp_executions
                    (server_id, tool_name, arguments, result, status, 
                     duration_ms, error_message, execution_context, sandboxed)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        str(server_id),
                        tool_name,
                        json.dumps(arguments),
                        result,
                        status,
                        duration_ms,
                        error_message,
                        json.dumps(execution_context) if execution_context else None,
                        sandboxed,
                    )
                )
                result = await cur.fetchone()
                await conn.commit()
                exec_id = result["id"] if isinstance(result["id"], UUID) else UUID(str(result["id"]))
                return exec_id

    async def get_execution_history(
        self,
        server_id: Optional[UUID] = None,
        limit: int = 100,
        status: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Get execution history with optional filtering.
        
        Args:
            server_id: Filter by server UUID (None for all servers)
            limit: Maximum number of results
            status: Filter by status (success, error, timeout, cancelled)
            
        Returns:
            List of execution records
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                query = "SELECT * FROM mcp_executions WHERE 1=1"
                params = []
                
                if server_id:
                    query += " AND server_id = %s"
                    params.append(str(server_id))
                    
                if status:
                    query += " AND status = %s"
                    params.append(status)
                    
                query += " ORDER BY executed_at DESC LIMIT %s"
                params.append(limit)
                
                await cur.execute(query, params)
                results = await cur.fetchall()
                return [dict(r) for r in results]

    async def get_server_stats(self, server_id: UUID) -> Dict[str, Any]:
        """
        Get aggregated statistics for a server.
        
        Uses the mcp_server_stats view for efficient aggregation.
        
        Args:
            server_id: Server UUID
            
        Returns:
            Statistics dictionary
        """
        async with self._pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT * FROM mcp_server_stats WHERE id = %s",
                    (str(server_id),)
                )
                result = await cur.fetchone()
                return dict(result) if result else {}

