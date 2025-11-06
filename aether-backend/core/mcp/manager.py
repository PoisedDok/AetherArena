"""
MCP Server Manager

@.architecture
Incoming: app.py (startup_event), api/v1/endpoints/mcp.py, core/mcp/database.py, core/mcp/server.py, core/mcp/sandbox.py --- {MCPDatabase instance, server registration/execution requests, LocalMcpServer/RemoteMcpServer classes, MCPSandbox}
Processing: start(), stop(), register_server(), get_server(), list_servers(), delete_server(), execute_tool(), check_server_health(), get_server_tools(), get_server_stats(), _health_check_loop() --- {11 jobs: lifecycle_management, server_registration, tool_discovery, tool_execution, health_monitoring, execution_auditing, sandbox_coordination}
Outgoing: core/mcp/database.py, core/mcp/server.py, core/mcp/sandbox.py, api/v1/endpoints/mcp.py --- {database method calls, McpServer instance control, sandboxed execution, Dict[str, Any] server/tool/execution records}

Central orchestrator for MCP server lifecycle and tool execution.

Responsibilities:
- Server lifecycle (start, stop, restart, health monitoring)
- Tool discovery and caching
- Tool execution with sandboxing
- Database persistence
- Error handling and recovery
- Execution auditing
"""

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional
from uuid import UUID

from core.mcp.database import MCPDatabase
from core.mcp.sandbox import MCPSandbox, NoOpSandbox
from core.mcp.server import LocalMcpServer, RemoteMcpServer, McpServer, ConfiguredLocalServer

logger = logging.getLogger(__name__)


class MCPServerManager:
    """
    Manages lifecycle of MCP servers with security and persistence.
    
    Features:
    - Database-backed configuration
    - Automatic server startup/shutdown
    - Health monitoring with periodic checks
    - Execution auditing with full history
    - Security sandboxing with resource limits
    - Tool discovery and caching
    - Error recovery and reporting
    
    Architecture:
    - Async-first design with proper resource cleanup
    - Thread-safe operations with asyncio.Lock
    - Background health monitoring task
    - Graceful shutdown handling
    """

    def __init__(self, database: MCPDatabase):
        """
        Initialize MCP server manager.
        
        Args:
            database: MCPDatabase instance for persistence
        """
        self.db = database
        self._active_servers: Dict[UUID, McpServer] = {}
        self._sandboxes: Dict[UUID, MCPSandbox] = {}
        self._health_check_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    async def start(self):
        """
        Initialize manager and start enabled servers.
        
        Startup sequence:
        1. Query database for enabled servers
        2. Start each server (failures don't block others)
        3. Cache tools from started servers
        4. Start health check background task
        """
        logger.info("Starting MCP Server Manager")
        
        # Load and start all enabled servers
        try:
            logger.info("Querying database for enabled servers...")
            servers = await self.db.list_servers(enabled_only=True)
            logger.info(f"Found {len(servers)} enabled servers to start")
        except Exception as e:
            logger.error(f"Failed to query database: {e}", exc_info=True)
            raise
        
        # Start each server (don't let individual failures block startup)
        for server_record in servers:
            try:
                logger.debug(f"Starting server: {server_record['name']}")
                await self._start_server(server_record)
                logger.debug(f"Successfully started server: {server_record['name']}")
            except Exception as e:
                logger.error(f"Failed to start server {server_record['name']}: {e}", exc_info=True)
                try:
                    server_id = server_record["id"] if isinstance(server_record["id"], UUID) else UUID(str(server_record["id"]))
                    await self.db.update_server_status(server_id, "error", str(e))
                except:
                    pass  # Don't let DB errors block startup
        
        # Start health check loop
        logger.debug("Starting health check loop")
        self._health_check_task = asyncio.create_task(self._health_check_loop())
        
        logger.info(f"✅ MCP Manager started with {len(self._active_servers)} active servers")

    async def stop(self):
        """
        Stop all servers and cleanup resources.
        
        Shutdown sequence:
        1. Cancel health check task
        2. Stop all active servers (without database updates to avoid race conditions)
        3. Cleanup sandboxes
        """
        logger.info("Stopping MCP Server Manager")
        
        # Cancel health checks first
        if self._health_check_task and not self._health_check_task.done():
            self._health_check_task.cancel()
            try:
                await asyncio.wait_for(self._health_check_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        
        # Stop all servers with timeout to prevent hanging
        stop_tasks = []
        for server_id in list(self._active_servers.keys()):
            task = asyncio.create_task(self._stop_server_quick(server_id))
            stop_tasks.append(task)
        
        if stop_tasks:
            # Wait for all stops with overall timeout
            try:
                await asyncio.wait_for(
                    asyncio.gather(*stop_tasks, return_exceptions=True),
                    timeout=5.0
                )
            except asyncio.TimeoutError:
                logger.warning("Server shutdown timed out, forcing cleanup")
        
        # Clear active servers
        self._active_servers.clear()
        
        logger.info("MCP Manager stopped")

    async def register_server(
        self,
        name: str,
        display_name: str,
        server_type: str,
        config: Dict[str, Any],
        description: Optional[str] = None,
        sandbox_enabled: bool = True,
        resource_limits: Optional[Dict[str, Any]] = None,
        auto_start: bool = True,
        enabled: bool = True
    ) -> Dict[str, Any]:
        """
        Register a new MCP server.
        
        Args:
            name: Unique identifier (lowercase, no spaces)
            display_name: Human-readable name
            server_type: 'local' or 'remote'
            config: Server configuration
                Local: {"command": str, "args": List[str], "env": Dict[str, str]}
                Remote: {"url": str}
            description: Optional description
            sandbox_enabled: Enable security sandbox (local only)
            resource_limits: Resource constraints
                {"max_memory_mb": int, "max_cpu_percent": int, "max_execution_time_seconds": int}
            auto_start: Start server immediately after registration
            
        Returns:
            Server record with ID
            
        Raises:
            ValueError: If server already exists or invalid config
        """
        async with self._lock:
            # Check if server exists
            existing = await self.db.get_server_by_name(name)
            if existing:
                raise ValueError(f"Server '{name}' already exists")
            
            # Validate config
            self._validate_server_config(server_type, config)
            
            # Create database record
            server_record = await self.db.create_server(
                name=name,
                display_name=display_name,
                server_type=server_type,
                config=config,
                description=description,
                sandbox_enabled=sandbox_enabled,
                resource_limits=resource_limits,
            )
            
            # Start server if requested
            if auto_start:
                try:
                    await self._start_server(server_record)
                    server_record["status"] = "active"
                except Exception as e:
                    logger.error(f"Failed to auto-start server {name}: {e}")
                    await self.db.update_server_status(
                        server_record["id"],
                        "error",
                        str(e)
                    )
                    server_record["status"] = "error"
                    server_record["error_message"] = str(e)
            
            logger.info(f"Registered server: {name}")
            return server_record

    async def unregister_server(self, server_id: UUID) -> bool:
        """
        Remove server from database and stop if running.
        
        Args:
            server_id: Server UUID
            
        Returns:
            True if successful
        """
        async with self._lock:
            # Stop if running
            if server_id in self._active_servers:
                await self._stop_server(server_id)
            
            # Delete from database (cascade deletes tools and executions)
            await self.db.delete_server(server_id)
            
            logger.info(f"Unregistered server {server_id}")
            return True

    async def get_server_info(self, server_id: UUID) -> Optional[Dict[str, Any]]:
        """
        Get server information including runtime status.
        
        Args:
            server_id: Server UUID
            
        Returns:
            Server record with runtime info, or None if not found
        """
        server_record = await self.db.get_server(server_id)
        if not server_record:
            return None
        
        # Add runtime information
        is_running = server_id in self._active_servers
        server_record["is_running"] = is_running
        
        if is_running and server_id in self._sandboxes:
            server_record["sandbox_stats"] = self._sandboxes[server_id].get_stats()
        
        return server_record

    async def list_servers(self) -> List[Dict[str, Any]]:
        """
        List all servers with runtime status.
        
        Returns:
            List of server records with is_running flag
        """
        servers = await self.db.list_servers(enabled_only=False)
        
        for server in servers:
            # Handle both UUID objects and string representations
            server_id = server["id"] if isinstance(server["id"], UUID) else UUID(str(server["id"]))
            server["is_running"] = server_id in self._active_servers
        
        return servers
    
    async def get_server(self, server_id_or_name: str) -> Optional[Dict[str, Any]]:
        """
        Get server by ID or name (endpoint compatibility method).
        
        Args:
            server_id_or_name: Server UUID string or name
            
        Returns:
            Server info dict or None if not found
        """
        # Try as UUID first
        try:
            server_uuid = UUID(server_id_or_name)
            return await self.get_server_info(server_uuid)
        except (ValueError, TypeError):
            # Not a valid UUID, try by name
            servers = await self.list_servers()
            for server in servers:
                if server["name"] == server_id_or_name:
                    return server
            return None
    
    async def delete_server(self, server_id_or_name: str) -> bool:
        """
        Delete server by ID or name (endpoint compatibility method).
        
        Args:
            server_id_or_name: Server UUID string or name
            
        Returns:
            True if deleted successfully
        """
        # Try as UUID first
        try:
            server_uuid = UUID(server_id_or_name)
            return await self.unregister_server(server_uuid)
        except (ValueError, TypeError):
            # Not a valid UUID, look up by name
            server = await self.get_server(server_id_or_name)
            if server:
                return await self.unregister_server(UUID(str(server["id"])))
            return False

    async def get_server_tools_by_name(self, server_name: str, refresh: bool = False) -> List[Dict[str, Any]]:
        """
        Get tools from server by name.

        Args:
            server_name: Server name
            refresh: Force refresh from server (ignores cache)

        Returns:
            List of tool schemas in OpenAI format

        Raises:
            ValueError: If server not found
        """
        # Find server by name
        server_record = await self.db.get_server_by_name(server_name)
        if not server_record:
            raise ValueError(f"Server '{server_name}' not found")

        server_id = server_record["id"]
        return await self.get_server_tools(server_id, refresh)

    async def get_server_tools(self, server_id: UUID, refresh: bool = False) -> List[Dict[str, Any]]:
        """
        Get tools from server (cached or fresh).
        
        Args:
            server_id: Server UUID
            refresh: Force refresh from server (ignores cache)
            
        Returns:
            List of tool schemas in OpenAI format
            
        Raises:
            RuntimeError: If server is not running and no cache available
        """
        # Check if server is active
        if server_id not in self._active_servers:
            # Try to get cached tools
            if not refresh:
                cached = await self.db.get_tools(server_id)
                if cached:
                    return [tool["openai_schema"] for tool in cached]
            
            raise RuntimeError("Server is not running")
        
        server = self._active_servers[server_id]
        
        # Fetch tools from server
        tools = await server.get_tools()
        
        # Cache in database
        await self.db.upsert_tools(server_id, tools)
        
        return tools

    async def execute_tool(
        self,
        server_id: UUID,
        tool_name: str,
        arguments: Dict[str, Any],
        execution_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Execute tool on MCP server.
        
        Args:
            server_id: Server UUID
            tool_name: Name of tool to execute
            arguments: Tool arguments
            execution_context: Optional context for audit trail
            
        Returns:
            Execution result:
                {
                    "success": bool,
                    "result": str (if success),
                    "error": str (if failure),
                    "duration_ms": int
                }
        """
        if server_id not in self._active_servers:
            raise RuntimeError("Server is not running")
        
        server = self._active_servers[server_id]
        start_time = time.time()
        
        try:
            # Execute tool
            result = await server.apply_tool(tool_name, arguments)
            
            duration_ms = int((time.time() - start_time) * 1000)
            
            # Log execution
            await self.db.log_execution(
                server_id=server_id,
                tool_name=tool_name,
                arguments=arguments,
                result=result,
                status="success",
                duration_ms=duration_ms,
                execution_context=execution_context,
                sandboxed=(server_id in self._sandboxes),
            )
            
            # Update usage stats
            await self.db.increment_usage(server_id)
            
            return {
                "success": True,
                "result": result,
                "duration_ms": duration_ms,
            }
            
        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            
            # Log error
            await self.db.log_execution(
                server_id=server_id,
                tool_name=tool_name,
                arguments=arguments,
                result=None,
                status="error",
                duration_ms=duration_ms,
                error_message=str(e),
                execution_context=execution_context,
                sandboxed=(server_id in self._sandboxes),
            )
            
            # Update error stats
            await self.db.increment_errors(server_id)
            
            return {
                "success": False,
                "error": str(e),
                "duration_ms": duration_ms,
            }

    async def check_server_health(self, server_id: UUID) -> Dict[str, Any]:
        """
        Check server health.
        
        Args:
            server_id: Server UUID
            
        Returns:
            Health status:
                {
                    "healthy": bool,
                    "status": str,
                    "tool_count": int (if healthy),
                    "sandbox_stats": dict (if sandboxed),
                    "error": str (if unhealthy)
                }
        """
        if server_id not in self._active_servers:
            return {
                "healthy": False,
                "status": "not_running",
                "message": "Server is not running"
            }
        
        try:
            # Try to list tools as health check
            tools = await self._active_servers[server_id].get_tools()
            
            await self.db.update_health_status(server_id, "healthy")
            
            sandbox_stats = {}
            if server_id in self._sandboxes:
                sandbox_stats = self._sandboxes[server_id].get_stats()
            
            return {
                "healthy": True,
                "status": "healthy",
                "tool_count": len(tools),
                "sandbox_stats": sandbox_stats
            }
            
        except Exception as e:
            await self.db.update_health_status(server_id, "unhealthy")
            
            return {
                "healthy": False,
                "status": "unhealthy",
                "error": str(e)
            }

    async def restart_server(self, server_id: UUID) -> bool:
        """
        Restart a server.
        
        Args:
            server_id: Server UUID
            
        Returns:
            True if successful
        """
        async with self._lock:
            # Get server record
            server_record = await self.db.get_server(server_id)
            if not server_record:
                raise ValueError(f"Server not found: {server_id}")
            
            # Stop if running
            if server_id in self._active_servers:
                await self._stop_server(server_id)
            
            # Start
            await self._start_server(server_record)
            
            logger.info(f"Restarted server: {server_record['name']}")
            return True

    async def get_execution_history(
        self,
        server_id: Optional[UUID] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get execution history.
        
        Args:
            server_id: Filter by server UUID (None for all servers)
            limit: Maximum number of results
            
        Returns:
            List of execution records
        """
        return await self.db.get_execution_history(server_id, limit)

    async def get_server_stats(self, server_id: UUID) -> Dict[str, Any]:
        """
        Get aggregated server statistics.
        
        Args:
            server_id: Server UUID
            
        Returns:
            Statistics dictionary
        """
        return await self.db.get_server_stats(server_id)

    # ==================== Private Methods ====================

    async def _start_server(self, server_record: Dict[str, Any]):
        """
        Start MCP server from database record.
        
        Args:
            server_record: Server record from database
            
        Raises:
            RuntimeError: If server fails to start
        """
        server_id = server_record["id"] if isinstance(server_record["id"], UUID) else UUID(str(server_record["id"]))
        server_type = server_record["server_type"]
        config = server_record["config"]
        
        logger.info(f"Starting {server_type} server: {server_record['name']}")
        
        await self.db.update_server_status(server_id, "starting")
        
        try:
            if server_type == "local":
                server = await self._start_local_server(server_id, server_record)
            elif server_type == "remote":
                server = await self._start_remote_server(server_id, server_record)
            else:
                raise ValueError(f"Unknown server type: {server_type}")
            
            self._active_servers[server_id] = server
            await self.db.update_server_status(server_id, "active")
            
            # Cache tools
            try:
                tools = await server.get_tools()
                await self.db.upsert_tools(server_id, tools)
                logger.info(f"Server {server_record['name']}: cached {len(tools)} tools")
            except Exception as e:
                logger.warning(f"Failed to cache tools: {e}")
            
        except Exception as e:
            logger.error(f"Failed to start server {server_record['name']}: {e}")
            await self.db.update_server_status(server_id, "error", str(e))
            raise

    async def _start_local_server(
        self,
        server_id: UUID,
        server_record: Dict[str, Any]
    ) -> LocalMcpServer:
        """
        Start local stdio-based MCP server.
        
        Args:
            server_id: Server UUID
            server_record: Server record from database
            
        Returns:
            Started LocalMcpServer instance
        """
        config = server_record["config"]
        sandbox_enabled = server_record.get("sandbox_enabled", True)
        resource_limits = server_record.get("resource_limits") or {}
        
        # Create sandbox if enabled
        if sandbox_enabled:
            sandbox = MCPSandbox(
                max_memory_mb=resource_limits.get("max_memory_mb", 512),
                max_cpu_percent=resource_limits.get("max_cpu_percent", 50),
                max_execution_time_seconds=resource_limits.get("max_execution_time_seconds", 300),
            )
        else:
            sandbox = NoOpSandbox()
        
        self._sandboxes[server_id] = sandbox
        
        # Create and start server
        server = ConfiguredLocalServer(config)
        await server.start()
        
        return server

    async def _start_remote_server(
        self,
        server_id: UUID,
        server_record: Dict[str, Any]
    ) -> RemoteMcpServer:
        """
        Start remote HTTP-based MCP server.
        
        Args:
            server_id: Server UUID
            server_record: Server record from database
            
        Returns:
            Started RemoteMcpServer instance
        """
        config = server_record["config"]
        api_endpoint = config.get("url")
        
        if not api_endpoint:
            raise ValueError("Remote server requires 'url' in config")
        
        server = RemoteMcpServer(api_endpoint)
        await server.start()
        
        return server

    async def _stop_server(self, server_id: UUID):
        """
        Stop MCP server.
        
        Args:
            server_id: Server UUID
        """
        if server_id not in self._active_servers:
            return
        
        logger.info(f"Stopping server {server_id}")
        
        try:
            await self.db.update_server_status(server_id, "stopping")
            
            server = self._active_servers[server_id]
            await server.stop()
            
            # Stop sandbox if present
            if server_id in self._sandboxes:
                await self._sandboxes[server_id].stop_server()
                del self._sandboxes[server_id]
            
            del self._active_servers[server_id]
            
            await self.db.update_server_status(server_id, "inactive")
            
        except Exception as e:
            logger.error(f"Error stopping server {server_id}: {e}")
            await self.db.update_server_status(server_id, "error", str(e))
    
    async def _stop_server_quick(self, server_id: UUID):
        """
        Quickly stop server without database updates (for shutdown).
        
        Args:
            server_id: Server UUID
        """
        if server_id not in self._active_servers:
            return
        
        try:
            server = self._active_servers[server_id]
            
            # Stop server with timeout
            await asyncio.wait_for(server.stop(), timeout=2.0)
            
            # Stop sandbox if present
            if server_id in self._sandboxes:
                try:
                    await asyncio.wait_for(
                        self._sandboxes[server_id].stop_server(),
                        timeout=1.0
                    )
                except asyncio.TimeoutError:
                    pass
                    
        except asyncio.TimeoutError:
            logger.warning(f"Server {server_id} stop timed out")
        except Exception as e:
            logger.debug(f"Error stopping server {server_id}: {e}")

    async def _health_check_loop(self):
        """
        Periodic health check for all servers.
        
        Runs every 60 seconds, checks health of all active servers.
        """
        while True:
            try:
                await asyncio.sleep(60)  # Check every minute
                
                for server_id in list(self._active_servers.keys()):
                    try:
                        await self.check_server_health(server_id)
                    except Exception as e:
                        logger.error(f"Health check failed for {server_id}: {e}")
                        
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Health check loop error: {e}")

    def _validate_server_config(self, server_type: str, config: Dict[str, Any]):
        """
        Validate server configuration.
        
        Args:
            server_type: 'local' or 'remote'
            config: Configuration dictionary
            
        Raises:
            ValueError: If configuration is invalid
        """
        if server_type == "local":
            if "command" not in config:
                raise ValueError("Local server requires 'command' in config")
        elif server_type == "remote":
            if "url" not in config:
                raise ValueError("Remote server requires 'url' in config")
        else:
            raise ValueError(f"Invalid server type: {server_type}")

