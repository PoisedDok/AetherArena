"""
@.architecture
Incoming: core/mcp/database.py --- {SupabaseClient, Dict[str, Any]}
Processing: manage MCP server records, cache tools with concurrency protection, log executions, enforce schema expectations --- {JOB_DELETE_FROM_DB, JOB_QUERY_DB, JOB_RETRY, JOB_SAVE_TO_DB, JOB_UPDATE_DB, JOB_VALIDATE_SCHEMA}
Outgoing: Supabase REST API (via SDK), core/mcp/database.py --- {Dict[str, Any], MCPServer}
"""

from core.domain.repository_interfaces import IMCPRepository

import json
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID
from datetime import datetime

from ..clients.supabase import SupabaseClient
from ..models.mcp import MCPExecution, MCPServer, MCPTool
from ..persistence_gateway import SupabasePersistenceGateway

logger = logging.getLogger(__name__)


class MCPRepository(IMCPRepository):
    """
    Repository for MCP-related database operations using Supabase SDK.
    
    Provides clean API for:
    - Server registration and management
    - Tool caching and retrieval
    - Execution logging and statistics
    - Health tracking
    
    All methods are async and use Supabase connection pooling.
    """
    
    def __init__(self, db=None, *, session=None):
        """
        Initialize MCP repository.
        
        Args:
            db: Supabase persistence gateway or raw Supabase client
            session: Legacy SQLAlchemy session (unsupported)
        """
        if session is not None:
            raise RuntimeError(
                "SQLAlchemy sessions are no longer supported. "
                "Initialize MCPRepository with a SupabasePersistenceGateway.",
            )
        if db is None:
            raise ValueError(
                "SupabasePersistenceGateway (or SupabaseClient) instance required for MCPRepository."
            )
        if isinstance(db, SupabasePersistenceGateway):
            self._gateway = db
        elif isinstance(db, SupabaseClient):
            self._gateway = SupabasePersistenceGateway(db)
        else:
            raise TypeError(
                "Unsupported database adapter for MCPRepository. "
                "Expected SupabasePersistenceGateway or SupabaseClient."
            )
        self.db = self._gateway
    
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
        auto_start: bool = True,
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
        """
        if resource_limits is None:
            resource_limits = {
                "max_memory_mb": 512,
                "max_cpu_percent": 50,
                "max_execution_time_seconds": 300,
            }
        
        data = {
            "name": name,
            "display_name": display_name,
            "description": description,
            "server_type": server_type,
            "config": config,
            "enabled": enabled,
            "auto_start": auto_start,
            "sandbox_enabled": sandbox_enabled,
            "resource_limits": resource_limits,
        }
        
        result = await self._gateway.insert("mcp_servers", data, admin=True)
        
        if isinstance(result, list) and result:
            result = result[0]
        
        if not result:
            raise RuntimeError("Failed to create MCP server")
            
        logger.info(f"Registered MCP server '{name}' ({result['id']})")
        return MCPServer(**result)
    
    async def get_server(self, server_id: UUID) -> Optional[MCPServer]:
        """
        Get server by ID.
        
        Args:
            server_id: Server UUID
            
        Returns:
            MCPServer object or None if not found
        """
        try:
            result = await self._gateway.select(
                "mcp_servers",
                filters={"id": str(server_id)},
                limit=1,
                admin=True
            )
            
            return MCPServer(**result[0]) if result else None
        except Exception as e:
            logger.error(f"Failed to get MCP server {server_id}: {e}", exc_info=True)
            raise
    
    async def get_server_by_name(self, name: str) -> Optional[MCPServer]:
        """
        Get server by name.
        
        Args:
            name: Server name
            
        Returns:
            MCPServer object or None if not found
        """
        try:
            result = await self._gateway.select(
                "mcp_servers",
                filters={"name": name},
                limit=1,
                admin=True
            )
            
            return MCPServer(**result[0]) if result else None
        except Exception as e:
            logger.error(f"Failed to get MCP server by name '{name}': {e}", exc_info=True)
            raise
    
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
        try:
            filters = {}
            
            if enabled_only:
                filters["enabled"] = True
            
            if server_type:
                filters["server_type"] = server_type
            
            result = await self._gateway.select(
                "mcp_servers",
                filters=filters,
                order_by="display_name",
                admin=True
            )
            
            return [MCPServer(**row) for row in result]
        except Exception as e:
            logger.error(f"Failed to list MCP servers: {e}", exc_info=True)
            raise
    
    async def update_server_status(
        self,
        server_id: UUID,
        status: str,
        error_message: Optional[str] = None
    ) -> Optional[MCPServer]:
        """
        Update server status.
        
        Args:
            server_id: Server UUID
            status: Status (active, inactive, error, maintenance)
            error_message: Optional error message
            
        Returns:
            Updated MCPServer object or None if not found
        """
        data = {"status": status}
        if error_message is not None:
            data["error_message"] = error_message
        elif status == "active":
            # Clear lingering error messages on successful start
            data["error_message"] = None
        
        try:
            result = await self._gateway.update("mcp_servers", data, record_id=str(server_id), admin=True)
            if isinstance(result, list) and result:
                result = result[0]
            elif not result:
                return None
                
            return MCPServer(**result)
        except Exception as e:
            logger.error(f"Failed to update server {server_id}: {e}")
            if "not found" in str(e).lower():
                return None
            raise
    
    async def update_server_health(
        self,
        server_id: UUID,
        health_status: str,
        last_health_check: datetime
    ) -> Optional[MCPServer]:
        """
        Update server health status.
        
        Args:
            server_id: Server UUID
            health_status: Health status (healthy, unhealthy, unknown)
            last_health_check: Timestamp of health check
            
        Returns:
            Updated MCPServer object or None if not found
        """
        data = {
            "health_status": health_status,
            "last_health_check": last_health_check.isoformat()
        }
        
        try:
            result = await self._gateway.update("mcp_servers", data, record_id=str(server_id), admin=True)
            if isinstance(result, list) and result:
                result = result[0]
            elif not result:
                return None
                
            return MCPServer(**result)
        except Exception as e:
            logger.error(f"Failed to update server health {server_id}: {e}")
            if "not found" in str(e).lower():
                return None
            raise
    
    async def update_server(
        self,
        server_id: UUID,
        **updates
    ) -> Optional[MCPServer]:
        """
        Update MCP server configuration.
        
        Args:
            server_id: Server UUID
            **updates: Fields to update (display_name, description, config, auto_start, enabled)
            
        Returns:
            Updated MCPServer model or None if not found
        """
        try:
            # Prepare update data
            update_data = {"updated_at": datetime.utcnow().isoformat() + "Z"}
            
            if "display_name" in updates and updates["display_name"] is not None:
                update_data["display_name"] = updates["display_name"]
            if "description" in updates and updates["description"] is not None:
                update_data["description"] = updates["description"]
            if "config" in updates and updates["config"] is not None:
                update_data["config"] = updates["config"]
            if "auto_start" in updates and updates["auto_start"] is not None:
                update_data["auto_start"] = updates["auto_start"]
            if "enabled" in updates and updates["enabled"] is not None:
                update_data["enabled"] = updates["enabled"]
            if "sandbox_enabled" in updates and updates["sandbox_enabled"] is not None:
                update_data["sandbox_enabled"] = updates["sandbox_enabled"]
            if "resource_limits" in updates and updates["resource_limits"] is not None:
                update_data["resource_limits"] = updates["resource_limits"]
            
            # Update server
            updated = await self._gateway.update("mcp_servers", update_data, record_id=str(server_id), admin=True)
            
            if updated and isinstance(updated, list):
                updated = updated[0]
            
            if not updated:
                logger.warning(f"Server {server_id} not found for update")
                return None
            
            logger.info(f"Updated MCP server {server_id}")
            return MCPServer.model_validate(updated)
            
        except Exception as e:
            logger.error(f"Failed to update server {server_id}: {e}")
            if "not found" in str(e).lower():
                return None
            raise

    async def delete_server(self, server_id: UUID) -> bool:
        """
        Delete an MCP server.
        
        Args:
            server_id: Server UUID
            
        Returns:
            True if deleted, False if not found
        """
        try:
            await self._gateway.delete("mcp_servers", record_id=str(server_id), admin=True)
            logger.info(f"Deleted MCP server {server_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete server {server_id}: {e}")
            if "not found" in str(e).lower():
                return False
            raise
    
    # =========================================================================
    # TOOL OPERATIONS
    # =========================================================================
    
    async def upsert_tools(
        self,
        server_id: UUID,
        tools: List[Dict[str, Any]]
    ) -> List[MCPTool]:
        """
        Upsert tool definitions for a server with gateway-managed retry protection.
        
        Ensures concurrent tool discovery remains idempotent by leveraging
        Supabase UPSERT with conflict resolution and gateway retries.
        
        Args:
            server_id: Server UUID
            tools: List of tool definitions (with 'name' and 'inputSchema' keys)
            
        Returns:
            List of created/updated MCPTool objects
        """
        results = []
        
        for tool in tools:
            # CRITICAL BUG FIX: Validate required fields before accessing
            if not isinstance(tool, dict):
                logger.warning(f"Skipping invalid tool (not a dict): {type(tool)}")
                continue
                
            tool_name = tool.get("name")
            function_schema = {}
            if not tool_name:
                function_schema = tool.get("function") if isinstance(tool.get("function"), dict) else {}
                tool_name = function_schema.get("name")
            if not tool_name:
                logger.warning(f"Skipping tool without 'name' field: {tool}")
                continue
            
            description = tool.get("description")
            if not description and function_schema:
                description = function_schema.get("description")
            
            input_schema = tool.get("inputSchema")
            if input_schema is None and function_schema:
                input_schema = function_schema.get("parameters")
            if input_schema is None:
                input_schema = {}
            
            if not function_schema and isinstance(tool.get("function"), dict):
                function_schema = tool["function"]
            if function_schema:
                # Ensure the nested schema carries the resolved name
                function_schema = {**function_schema}
                function_schema.setdefault("name", tool_name)
            
            openai_schema = tool
            if tool.get("type") == "function" and function_schema:
                openai_schema = {
                    "type": "function",
                    "function": function_schema,
                }
            elif "function" not in tool and tool_name:
                openai_schema = {
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "description": description or "",
                        "parameters": input_schema,
                    },
                }
            
            # Map from MCP protocol to DB schema
            data = {
                "server_id": str(server_id),
                "tool_name": tool_name,  # DB column is tool_name
                "description": description,
                "parameters": input_schema,  # DB column is parameters
                "openai_schema": openai_schema,  # Store OpenAI-compatible schema for LLM usage
                "enabled": True,
            }
            
            # RACE PROTECTION: UPSERT with conflict resolution (gateway adds retries)
            result = await self._gateway.upsert(
                "mcp_tools",
                data,
                admin=True,
            )
            
            if isinstance(result, list):
                result = result[0]
            
            # Map DB columns to model fields
            tool_obj = MCPTool(
                id=result["id"],
                server_id=result["server_id"],
                name=result["tool_name"],  # Map tool_name -> name
                description=result.get("description"),
                input_schema=result.get("parameters", {}),  # Map parameters -> input_schema
                enabled=result.get("enabled", True),
                created_at=result["created_at"],
                updated_at=result["updated_at"]
            )
            results.append(tool_obj)
        
        logger.info(f"Upserted {len(tools)} tools for server {server_id}")
        return results
    
    async def get_tools(
        self,
        server_id: UUID,
        enabled_only: bool = True
    ) -> List[MCPTool]:
        """
        Get tool definitions for a server.
        
        Args:
            server_id: Server UUID
            enabled_only: If True, only return enabled tools
            
        Returns:
            List of MCPTool objects with mapped fields
        """
        try:
            filters = {"server_id": str(server_id)}
            
            result = await self._gateway.select(
                "mcp_tools",
                filters=filters,
                order_by="tool_name",  # DB column is tool_name
                admin=True
            )
            
            # Map DB columns to model fields
            tools = [
                MCPTool(
                    id=row["id"],
                    server_id=row["server_id"],
                    name=row["tool_name"],  # Map tool_name -> name
                    description=row.get("description"),
                    input_schema=row.get("parameters", {}),  # Map parameters -> input_schema
                    openai_schema=row.get("openai_schema", {}),  # Extract openai_schema from DB
                    enabled=row.get("enabled", True),
                    created_at=row["created_at"],
                    updated_at=row["updated_at"]
                )
                for row in result
            ]
            
            if enabled_only:
                tools = [tool for tool in tools if tool.enabled]
            
            return tools
        except Exception as e:
            logger.error(f"Failed to get tools for server {server_id}: {e}", exc_info=True)
            raise
    
    async def get_tool(
        self,
        server_id: UUID,
        tool_name: str
    ) -> Optional[MCPTool]:
        """
        Get a specific tool.
        
        Args:
            server_id: Server UUID
            tool_name: Tool name
            
        Returns:
            MCPTool object or None if not found
        """
        try:
            result = await self._gateway.select(
                "mcp_tools",
                filters={"server_id": str(server_id), "tool_name": tool_name},  # DB column is tool_name
                limit=1,
                admin=True
            )
            
            if not result:
                return None
            
            # Map DB columns to model fields
            row = result[0]
            return MCPTool(
                id=row["id"],
                server_id=row["server_id"],
                name=row["tool_name"],  # Map tool_name -> name
                description=row.get("description"),
                input_schema=row.get("parameters", {}),  # Map parameters -> input_schema
                enabled=row.get("enabled", True),
                created_at=row["created_at"],
                updated_at=row["updated_at"]
            )
        except Exception as e:
            logger.error(f"Failed to get tool {tool_name} for server {server_id}: {e}", exc_info=True)
            raise
    
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
    ) -> MCPExecution:
        """
        Log a tool execution.
        
        Args:
            server_id: Server UUID
            tool_name: Tool name
            parameters: Tool parameters
            result: Optional execution result
            error: Optional error message
            execution_time_ms: Optional execution time in milliseconds
            status: Execution status (pending, success, error)
            execution_context: Optional execution context for audit trail
            sandboxed: Whether execution was sandboxed
            
        Returns:
            Created MCPExecution object
        """
        data = {
            "server_id": str(server_id),
            "tool_name": tool_name,
            "arguments": parameters,
            "result": json.dumps(result) if isinstance(result, (dict, list)) else result,
            "error_message": error,
            "duration_ms": execution_time_ms,
            "status": status,
            "execution_context": execution_context,
            "sandboxed": sandboxed,
        }
        
        result_obj = await self._gateway.insert("mcp_executions", data, admin=True)
        
        if isinstance(result_obj, list):
            result_obj = result_obj[0]
        
        logger.debug(f"Logged execution for {tool_name} on server {server_id}")
        return MCPExecution(**result_obj)
    
    async def update_execution(
        self,
        execution_id: UUID,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        execution_time_ms: Optional[int] = None,
        status: str = "success",
    ) -> Optional[MCPExecution]:
        """
        Update an execution record.
        
        Args:
            execution_id: Execution UUID
            result: Optional execution result
            error: Optional error message
            execution_time_ms: Optional execution time
            status: Execution status
            
        Returns:
            Updated MCPExecution object or None if not found
        """
        data = {"status": status}
        
        if result is not None:
            data["result"] = json.dumps(result) if isinstance(result, (dict, list)) else result
        if error is not None:
            data["error_message"] = error
        if execution_time_ms is not None:
            data["duration_ms"] = execution_time_ms
        
        try:
            result_obj = await self._gateway.update("mcp_executions", data, record_id=str(execution_id), admin=True)
            if isinstance(result_obj, list) and result_obj:
                result_obj = result_obj[0]
            elif not result_obj:
                return None
                
            return MCPExecution(**result_obj)
        except Exception as e:
            logger.error(f"Failed to update execution {execution_id}: {e}")
            if "not found" in str(e).lower():
                return None
            raise
    
    async def get_execution_history(
        self,
        server_id: Optional[UUID] = None,
        tool_name: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> List[MCPExecution]:
        """
        Get execution history.
        
        Args:
            server_id: Optional server UUID filter
            tool_name: Optional tool name filter
            status: Optional status filter
            limit: Maximum number of records
            offset: Number of records to skip
            
        Returns:
            List of MCPExecution objects
        """
        try:
            filters = {}
            
            if server_id:
                filters["server_id"] = str(server_id)
            if tool_name:
                filters["tool_name"] = tool_name
            if status:
                filters["status"] = status
            
            result = await self._gateway.select(
                "mcp_executions",
                filters=filters,
                order_by="executed_at.desc",
                limit=limit,
                offset=offset,
                admin=True
            )
            
            return [MCPExecution(**row) for row in result]
        except Exception as e:
            logger.error(f"Failed to get execution history: {e}", exc_info=True)
            raise
    
    async def get_server_stats(self, server_id: UUID) -> Dict[str, Any]:
        """
        Get statistics for a server.
        
        Args:
            server_id: Server UUID
            
        Returns:
            Dict with server statistics
        """
        try:
            # Get tool count
            tools = await self._gateway.select(
                "mcp_tools",
                columns="id",
                filters={"server_id": str(server_id)},
                admin=True
            )
            
            # Get execution counts by status
            executions_all = await self._gateway.select(
                "mcp_executions",
                columns="status",
                filters={"server_id": str(server_id)},
                admin=True
            )
            
            success_count = sum(1 for e in executions_all if e.get("status") == "success")
            error_count = sum(1 for e in executions_all if e.get("status") == "error")
            
            return {
                "tool_count": len(tools),
                "execution_count": len(executions_all),
                "success_count": success_count,
                "error_count": error_count,
            }
        except Exception as e:
            logger.error(f"Failed to get server stats for {server_id}: {e}", exc_info=True)
            raise
