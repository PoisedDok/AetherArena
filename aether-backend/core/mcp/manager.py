"""
MCP Server Manager

@.architecture
Incoming: app.py (startup_event), api/v1/endpoints/mcp.py, core/mcp/database.py, core/mcp/server.py, core/mcp/sandbox.py --- {MCPDatabase instance, server registration/execution requests, LocalMcpServer/RemoteMcpServer classes, MCPSandbox}
Processing: start(), stop(), register_server(), get_server(), list_servers(), delete_server(), execute_tool(), check_server_health(), get_server_tools(), get_server_stats(), _health_check_loop() --- {JOB_DISCOVER_TOOLS, JOB_EXECUTE_TOOL, JOB_ORCHESTRATE}
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
import os
import time
import anyio
from concurrent.futures import ThreadPoolExecutor, TimeoutError as ThreadTimeoutError
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
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

    def __init__(self, database: MCPDatabase, tool_cache_ttl_seconds: int = 300):
        """
        Initialize MCP server manager.
        
        Args:
            database: MCPDatabase instance for persistence
            tool_cache_ttl_seconds: TTL for in-memory tool cache (default: 5 minutes)
        """
        self.db = database
        self._active_servers: Dict[UUID, McpServer] = {}
        self._sandboxes: Dict[UUID, MCPSandbox] = {}
        self._health_check_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        
        # In-memory tool cache: server_id -> (tools, expiry_time)
        self._tool_cache: Dict[UUID, Tuple[List[Dict[str, Any]], datetime]] = {}
        self._tool_cache_ttl = timedelta(seconds=tool_cache_ttl_seconds)
        self._sync_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mcp-manager-sync")
        self._sync_timeout_seconds = 30
        self._is_disposed = False
        logger.info("MCP tool cache TTL set to %d seconds", tool_cache_ttl_seconds)

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
            # Central config contract: only auto-start servers explicitly marked for auto-start.
            # Back-compat (pre-migration): only auto-start known core servers.
            core_autostart_names = {"file_indexing_mcp"}

            def _should_autostart(server: Dict[str, Any]) -> bool:
                # Never auto-start test servers outside pytest.
                # Tests may register servers with names like "test-mcp-..." and we must not
                # leak that into normal dev/prod startup behavior.
                name = (server.get("name") or "").strip()
                if name.startswith("test-") and not os.getenv("PYTEST_CURRENT_TEST"):
                    return False
                if "auto_start" in server:
                    return bool(server.get("auto_start"))
                return (server.get("name") or "") in core_autostart_names

            servers = [s for s in servers if _should_autostart(s)]
            logger.info("Found %d enabled servers to start", len(servers))
        except Exception as e:  # noqa: BLE001 -- startup boundary: re-raises; must catch all to log before propagation
            logger.error("Failed to query database: %s", e, exc_info=True)
            raise
        
        # ARCHITECTURAL PRINCIPLE: Isolate MCP failures - don't crash backend
        # Each server failure is logged and tracked, but doesn't block startup
        # Shield each server startup to prevent cancellation cascade
        startup_results = {"success": 0, "failed": 0, "errors": []}

        async def _disable_autostart_on_failure(server_record: Dict[str, Any]) -> None:
            """
            Fail-fast: if a server fails to start, disable its auto_start to prevent repeated
            startup noise/crashes on every backend boot.
            """
            try:
                name = server_record.get("name") or ""
                if name in {"file_indexing_mcp"}:
                    return
                server_id_raw = server_record.get("id")
                if not server_id_raw:
                    return
                server_id = server_id_raw if isinstance(server_id_raw, UUID) else UUID(str(server_id_raw))
                await self.db.update_server(server_id, auto_start=False)
            except Exception:  # noqa: BLE001 -- DB auto_start disable: best-effort, don't block startup
                return
        
        for server_record in servers:
            server_name = server_record.get('name', 'unknown')
            try:
                logger.debug("Starting server: %s", server_name)
                # Shield from cancellation by other servers' cleanup tasks
                started = await asyncio.shield(self._start_server(server_record))
                if started:
                    logger.debug("Successfully started server: %s", server_name)
                    startup_results["success"] += 1
                else:
                    startup_results["failed"] += 1
                    startup_results["errors"].append("%s: Failed to start (see server status/error_message)" % server_name)
                # Brief delay to let cleanup tasks finish before next server
                await asyncio.sleep(0.1)
            except asyncio.CancelledError:
                # Handle cancellation explicitly - don't let it crash startup
                startup_results["failed"] += 1
                startup_results["errors"].append("%s: Cancelled by cleanup task" % server_name)
                logger.warning("Server %s startup was cancelled", server_name)
                await _disable_autostart_on_failure(server_record)
                # Brief delay to let cleanup finish
                await asyncio.sleep(0.5)
            except Exception as e:  # noqa: BLE001 -- server startup loop: must catch all to continue starting other servers
                startup_results["failed"] += 1
                startup_results["errors"].append("%s: %s" % (server_name, str(e)[:100]))
                logger.error("Failed to start server %s: %s", server_name, e, exc_info=True)
                await _disable_autostart_on_failure(server_record)
                try:
                    # CRITICAL BUG FIX: Safe UUID casting with proper error handling
                    server_id_raw = server_record.get("id")
                    if not server_id_raw:
                        logger.warning("Server record missing 'id' field: %s", server_name)
                        continue
                    
                    if isinstance(server_id_raw, UUID):
                        server_id = server_id_raw
                    else:
                        try:
                            server_id = UUID(str(server_id_raw))
                        except (ValueError, TypeError) as uuid_err:
                            logger.warning("Invalid UUID for server %s: %s", server_name, uuid_err)
                            continue
                    
                    await self.db.update_server_status(server_id, "error", str(e))
                except Exception as db_err:  # noqa: BLE001 -- DB status update: best-effort during error handling
                    logger.debug("Failed to update error status: %s", db_err)
        
        # Log startup summary - critical for debugging
        if startup_results["failed"] > 0:
            logger.warning(
                "MCP startup completed with errors: %d succeeded, %d failed",
                startup_results['success'], startup_results['failed'],
            )
            for error in startup_results["errors"]:
                logger.warning("  - %s", error)
        elif startup_results["success"] > 0:
            logger.info("All %d MCP servers started successfully", startup_results['success'])
        
        # Start health check loop
        logger.debug("Starting health check loop")
        self._health_check_task = asyncio.create_task(self._health_check_loop())
        
        logger.info("MCP Manager started with %d active servers", len(self._active_servers))

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
            except (asyncio.TimeoutError, asyncio.CancelledError):
                logger.warning("Server shutdown timed out, forcing cleanup")
        
        # Clear active servers and sandboxes (release all references)
        self._active_servers.clear()
        self._sandboxes.clear()
        
        # Clear in-memory tool cache
        self._tool_cache.clear()
        logger.info("Cleared in-memory tool cache and sandbox references")
        
        logger.info("MCP Manager stopped")
        self._is_disposed = True
        self._sync_executor.shutdown(wait=True)
    
    def invalidate_tool_cache(self, server_id: Optional[UUID] = None) -> None:
        """
        Invalidate tool cache for a specific server or all servers.
        
        Args:
            server_id: Server UUID to invalidate, or None to clear all caches
        """
        if server_id is None:
            # Clear all caches
            self._tool_cache.clear()
            logger.info("Invalidated all tool caches")
        elif server_id in self._tool_cache:
            del self._tool_cache[server_id]
            logger.info("Invalidated tool cache for server %s", server_id)
    
    @staticmethod
    def _run_coro_new_loop(coro):
        # Preserve the caller's event loop reference so we don't destroy it.
        # This matters when called from threads that already have a loop set
        # (e.g. the main thread during testing, or frameworks that pre-set a loop).
        prev_loop = None
        try:
            prev_loop = asyncio.get_event_loop()
        except RuntimeError:
            pass
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            return loop.run_until_complete(coro)
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except (RuntimeError, OSError):
                pass
            asyncio.set_event_loop(prev_loop)
            loop.close()

    def run_coroutine_sync(self, coro, timeout: Optional[float] = None):
        """
        Run an async coroutine synchronously.
        
        Used by sync wrappers (AETHER_RAG client) to call async manager methods.
        Creates new event loop if needed; if already running, schedules thread-safe and waits.
        
        Args:
            coro: Coroutine to execute
            
        Returns:
            Result of coroutine execution
        """
        timeout = timeout or self._sync_timeout_seconds
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            # No running loop in this thread; safe to execute directly
            return self._run_coro_new_loop(coro)
        else:
            # Running inside event loop thread; offload to dedicated executor
            future = self._sync_executor.submit(self._run_coro_new_loop, coro)
            try:
                return future.result(timeout=timeout)
            except ThreadTimeoutError:
                future.cancel()
                raise TimeoutError("Timed out waiting for MCP coroutine") from None

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
                enabled=enabled,
                auto_start=auto_start,
                sandbox_enabled=sandbox_enabled,
                resource_limits=resource_limits,
            )
            
            # Start server if requested
            if auto_start:
                try:
                    success = await self._start_server(server_record)
                    if success:
                        server_record["status"] = "active"
                    else:
                        server_record["status"] = "error"
                        server_record["error_message"] = "Failed to start server"
                except Exception as e:  # noqa: BLE001 -- auto-start boundary: isolate server failure, don't block other servers
                    logger.error("Failed to auto-start server %s: %s", name, e)
                    await self.db.update_server_status(
                        server_record["id"],
                        "error",
                        str(e),
                    )
                    server_record["status"] = "error"
                    server_record["error_message"] = str(e)
            
            logger.info("Registered server: %s", name)
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
            
            logger.info("Unregistered server %s", server_id)
            return True

    async def update_server(
        self,
        server_id: UUID,
        display_name: Optional[str] = None,
        description: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        auto_start: Optional[bool] = None,
        enabled: Optional[bool] = None,
        sandbox_enabled: Optional[bool] = None,
        resource_limits: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Update server configuration.
        
        If server is running, it will be stopped and restarted with new config.
        
        Args:
            server_id: Server UUID
            display_name: New display name (optional)
            description: New description (optional)
            config: New configuration (optional)
            auto_start: New auto-start setting (optional)
            enabled: New enabled setting (optional)
            sandbox_enabled: New sandbox enabled setting (optional)
            resource_limits: New resource limits (optional)
            
        Returns:
            Updated server record
            
        Raises:
            ValueError: If server not found
        """
        async with self._lock:
            # Get existing server
            server = await self.db.get_server(server_id)
            if not server:
                raise ValueError(f"Server {server_id} not found")
            
            # Check if running
            was_running = server_id in self._active_servers
            
            # Stop if running
            if was_running:
                await self._stop_server(server_id)
            
            # Update database record
            updates = {}
            if display_name is not None:
                updates["display_name"] = display_name
            if description is not None:
                updates["description"] = description
            if config is not None:
                updates["config"] = config
            if auto_start is not None:
                updates["auto_start"] = auto_start
            if enabled is not None:
                updates["enabled"] = enabled
            if sandbox_enabled is not None:
                updates["sandbox_enabled"] = sandbox_enabled
            if resource_limits is not None:
                updates["resource_limits"] = resource_limits
            
            updated_server = await self.db.update_server(server_id, **updates)
            
            # Start or restart the server if it is enabled
            if updated_server.get("enabled", True):
                try:
                    await self._start_server(updated_server)
                except Exception as e:  # noqa: BLE001 -- restart boundary: isolate failure, don't crash update operation
                    logger.warning("Failed to start/restart server %s after update: %s", server_id, e)
            
            logger.info("Updated server %s", server_id)
            return updated_server

    async def test_server(self, server_id: UUID) -> Dict[str, Any]:
        """
        Test server connectivity without starting permanently.
        
        Creates a temporary server instance to validate configuration
        and discover available tools.
        
        Args:
            server_id: Server UUID
            
        Returns:
            Diagnostic information including success status, message, and details
        """
        import time
        
        server = await self.db.get_server(server_id)
        if not server:
            return {
                "success": False,
                "message": "Server not found",
                "diagnostics": {}
            }
        
        try:
            start_time = time.time()
            
            # Create temporary server instance
            if server["server_type"] == "local":
                from core.mcp.server import ConfiguredLocalServer
                
                # Retrieve the sandbox settings from the server configuration
                sandbox_enabled = server.get("sandbox_enabled", False)
                resource_limits = server.get("resource_limits", None)
                
                # Enable sandboxing based on config, closing the RCE vulnerability during test_server
                if sandbox_enabled:
                    from core.mcp.sandbox import MCPSandbox
                    resource_limits = resource_limits or {}
                    sandbox_instance = MCPSandbox(
                        max_memory_mb=resource_limits.get("max_memory_mb", 512),
                        max_cpu_percent=resource_limits.get("max_cpu_percent", 50),
                        max_execution_time_seconds=resource_limits.get("max_execution_time_seconds", 300),
                        allow_network=resource_limits.get("network_access", True)
                    )
                else:
                    sandbox_instance = None
                    
                test_server = ConfiguredLocalServer(server["config"], sandbox=sandbox_instance)
            else:
                from core.mcp.server import RemoteMcpServer
                test_server = RemoteMcpServer(server["config"]["url"])
            
            # Start, discover, stop — ALWAYS stop in finally to prevent process leak.
            # If get_tools() raises after start(), the process would remain orphaned
            # without the finally guard.
            started = False
            try:
                await test_server.start()
                started = True
                tools = await test_server.get_tools()
            finally:
                if started:
                    try:
                        await test_server.stop()
                    except Exception as stop_err:  # noqa: BLE001 -- cleanup in finally: must not mask original error
                        logger.warning("Failed to stop test server: %s", stop_err)
            
            elapsed = (time.time() - start_time) * 1000
            
            return {
                "success": True,
                "message": f"Server is healthy. Discovered {len(tools)} tools.",
                "diagnostics": {
                    "can_connect": True,
                    "tools_discovered": len(tools),
                    "response_time_ms": round(elapsed, 2),
                    "tool_names": [
                        t.get("function", {}).get("name", "")
                        for t in tools[:10]
                    ],
                }
            }
        except Exception as e:  # noqa: BLE001 -- test_server API boundary: returns structured dict; MCP servers can raise anything
            elapsed = (time.time() - start_time) * 1000
            return {
                "success": False,
                "message": f"Server test failed: {str(e)}",
                "diagnostics": {
                    "can_connect": False,
                    "response_time_ms": round(elapsed, 2),
                    "error_details": str(e)
                }
            }

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
        List all servers with runtime status and tool counts.
        
        Returns:
            List of server records with is_running flag and tools_count
        """
        servers_raw = await self.db.list_servers(enabled_only=False)
        
        # Enrich server records with runtime data and tool counts
        servers = []
        for server_obj in servers_raw:
            # Convert Pydantic model to dict if needed
            if hasattr(server_obj, 'model_dump'):
                server = server_obj.model_dump()
            elif hasattr(server_obj, 'dict'):
                server = server_obj.dict()
            elif isinstance(server_obj, dict):
                server = server_obj
            else:
                logger.error("Unexpected server type: %s", type(server_obj))
                continue
            
            # Add runtime status
            try:
                server_id = server["id"]
                if not isinstance(server_id, UUID):
                    server_id = UUID(str(server_id))
                server["is_running"] = server_id in self._active_servers
            except (ValueError, TypeError, AttributeError) as e:
                logger.warning("Invalid UUID for server %s: %s", server.get('name'), e)
                server["is_running"] = False
            
            # Add tool count
            try:
                stats = await self.db.get_server_stats(server_id)
                server["tools_count"] = stats.get("tool_count", 0)
            except Exception as e:  # noqa: BLE001 -- stats lookup: best-effort, default to 0 on any failure
                logger.warning("Failed to get tool count for server %s: %s", server.get('name'), e)
                server["tools_count"] = 0
            
            servers.append(server)
        
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
        Get tools from server with multi-tier caching.
        
        Cache hierarchy (fastest to slowest):
        1. In-memory cache (TTL-based, 5min default)
        2. Database cache (persistent)
        3. Live server fetch (if running)
        
        Args:
            server_id: Server UUID (accepts str or UUID, converted to UUID)
            refresh: Force refresh from server (ignores all caches)
            
        Returns:
            List of tool schemas in OpenAI format
            
        Raises:
            RuntimeError: If server is not running and no cache available
        """
        # CRITICAL FIX: Ensure server_id is UUID type for dict lookup
        if isinstance(server_id, str):
            server_id = UUID(server_id)
        
        # Check in-memory cache first (unless refresh requested)
        if not refresh and server_id in self._tool_cache:
            tools, expiry = self._tool_cache[server_id]
            if datetime.now(timezone.utc) < expiry:
                logger.debug("Tool cache HIT (in-memory) for server %s", server_id)
                return tools
            else:
                # Expired, remove from cache
                logger.debug("Tool cache EXPIRED (in-memory) for server %s", server_id)
                del self._tool_cache[server_id]
        
        # Check if server is active
        if server_id not in self._active_servers:
            # Try to get cached tools from database
            if not refresh:
                cached = await self.db.get_tools(server_id)
                if cached:
                    logger.debug("Tool cache HIT (database) for server %s", server_id)
                    tools = [tool["openai_schema"] for tool in cached]
                    # Populate in-memory cache
                    self._tool_cache[server_id] = (tools, datetime.now(timezone.utc) + self._tool_cache_ttl)
                    return tools
            
            raise RuntimeError("Server is not running")
        
        logger.debug("Tool cache MISS for server %s, fetching from server", server_id)
        server = self._active_servers[server_id]
        
        # Fetch tools from server
        tools = await server.get_tools()
        
        # Cache in database (persistent)
        await self.db.upsert_tools(server_id, tools)
        
        # Cache in memory (fast access)
        self._tool_cache[server_id] = (tools, datetime.now(timezone.utc) + self._tool_cache_ttl)
        
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
            server_id: Server UUID (accepts str or UUID, converted to UUID)
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
        # CRITICAL FIX: Ensure server_id is UUID type for dict lookup
        if isinstance(server_id, str):
            server_id = UUID(server_id)
        
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
                parameters=arguments,  # Fixed: was 'arguments', now 'parameters'
                result=result,
                status="success",
                execution_time_ms=duration_ms,  # Fixed: was 'duration_ms', now 'execution_time_ms'
                execution_context=execution_context,
                sandboxed=(server_id in self._sandboxes),
            )
            
            return {
                "success": True,
                "result": result,
                "duration_ms": duration_ms,
            }
            
        except Exception as e:  # noqa: BLE001 -- execute_tool API boundary: logs and returns structured error; MCP tools can raise anything
            duration_ms = int((time.time() - start_time) * 1000)
            
            # Log error - CRITICAL BUG FIX: Use correct parameter names
            await self.db.log_execution(
                server_id=server_id,
                tool_name=tool_name,
                parameters=arguments,  # Fixed: was 'arguments', now 'parameters'
                result=None,
                status="error",
                execution_time_ms=duration_ms,  # Fixed: was 'duration_ms', now 'execution_time_ms'
                error=str(e),  # Fixed: was 'error_message', now 'error'
                execution_context=execution_context,
                sandboxed=(server_id in self._sandboxes),
            )
            
            return {
                "success": False,
                "error": str(e),
                "duration_ms": duration_ms,
            }

    async def check_server_health(self, server_id: UUID) -> Dict[str, Any]:
        """
        Check server health.
        
        Args:
            server_id: Server UUID (accepts str or UUID, converted to UUID)
            
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
        # CRITICAL FIX: Ensure server_id is UUID type for dict lookup
        if isinstance(server_id, str):
            server_id = UUID(server_id)
        
        if server_id not in self._active_servers:
            return {
                "healthy": False,
                "status": "not_running",
                "message": "Server is not running"
            }
        
        try:
            # Try to list tools as health check with timeout
            with anyio.fail_after(10.0):
                tools = await self._active_servers[server_id].get_tools()
            
            await self.db.update_health_status(server_id, "healthy", datetime.utcnow())
            
            sandbox_stats = {}
            if server_id in self._sandboxes:
                sandbox_stats = self._sandboxes[server_id].get_stats()
            
            return {
                "healthy": True,
                "status": "healthy",
                "tool_count": len(tools),
                "sandbox_stats": sandbox_stats
            }
            
        except Exception as e:  # noqa: BLE001 -- health check API boundary: returns structured dict; server checks can fail unpredictably
            await self.db.update_health_status(server_id, "unhealthy", datetime.utcnow())
            
            return {
                "healthy": False,
                "status": "unhealthy",
                "error": str(e)
            }

    async def start_server_by_name(self, server_name: str) -> Dict[str, Any]:
        """
        Start a server by name.
        
        Args:
            server_name: Server name
            
        Returns:
            Server record dict
            
        Raises:
            ValueError: If server not found
            RuntimeError: If server fails to start
        """
        async with self._lock:
            # Get server by name
            server_record = await self.db.get_server_by_name(server_name)
            if not server_record:
                raise ValueError(f"Server '{server_name}' not found")
            
            server_id = server_record["id"]
            
            # Stop if already running
            if server_id in self._active_servers:
                logger.info("Server %s already running, restarting...", server_name)
                await self._stop_server(server_id)
            
            # Start
            await self._start_server(server_record)
            
            # Verify server was actually started
            if server_id not in self._active_servers:
                raise RuntimeError(f"Server {server_name} failed to start (check logs for details)")
            
            logger.info("Started server: %s", server_name)
            return server_record

    async def stop_server_by_name(self, server_name: str) -> Dict[str, Any]:
        """
        Stop a server by name.
        
        Args:
            server_name: Server name
            
        Returns:
            Server record dict
            
        Raises:
            ValueError: If server not found
        """
        async with self._lock:
            server_record = await self.db.get_server_by_name(server_name)
            if not server_record:
                raise ValueError(f"Server '{server_name}' not found")
            
            server_id_raw = server_record.get("id")
            if not server_id_raw:
                raise ValueError(f"Server record missing 'id' field: {server_name}")
            server_id = server_id_raw if isinstance(server_id_raw, UUID) else UUID(str(server_id_raw))
            
            if server_id in self._active_servers:
                await self._stop_server(server_id)
                logger.info("Stopped server: %s", server_name)
            else:
                # Ensure database status reflects reality even if server was already stopped.
                try:
                    await self.db.update_server_status(server_id, "inactive")
                except Exception as db_err:  # noqa: BLE001 -- DB status update: best-effort
                    logger.debug("Failed to update server status to 'inactive': %s", db_err)
            
            return server_record

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
            
            logger.info("Restarted server: %s", server_record['name'])
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
        return await self.db.get_execution_history(server_id=server_id, limit=limit)

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

    async def _start_server(self, server_record: Dict[str, Any]) -> bool:
        """
        Start MCP server from database record.
        
        Args:
            server_record: Server record from database
            
        Raises:
            RuntimeError: If server fails to start
        """
        # CRITICAL BUG FIX: Safe UUID casting with proper error handling
        server_id_raw = server_record.get("id")
        if not server_id_raw:
            raise ValueError(f"Server record missing 'id' field: {server_record.get('name')}")
        
        if isinstance(server_id_raw, UUID):
            server_id = server_id_raw
        else:
            try:
                server_id = UUID(str(server_id_raw))
            except (ValueError, TypeError) as e:
                raise ValueError(f"Invalid UUID for server {server_record.get('name')}: {e}")
        
        server_type = server_record["server_type"]
        config = server_record["config"]
        
        logger.info("Starting %s server: %s", server_type, server_record['name'])
        
        # CRITICAL BUG FIX: Wrap DB operations in try/except to handle race conditions
        try:
            await self.db.update_server_status(server_id, "starting")
        except Exception as db_err:  # noqa: BLE001 -- DB status update: best-effort
            logger.debug("Failed to update server status to 'starting': %s", db_err)
        
        try:
            if server_type == "local":
                server = await self._start_local_server(server_id, server_record)
            elif server_type == "remote":
                server = await self._start_remote_server(server_id, server_record)
            else:
                raise ValueError(f"Unknown server type: {server_type}")
            
            self._active_servers[server_id] = server
            
            # CRITICAL BUG FIX: Wrap DB operations in try/except to handle race conditions
            try:
                await self.db.update_server_status(server_id, "active")
            except Exception as db_err:  # noqa: BLE001 -- DB status update: best-effort
                logger.debug("Failed to update server status to 'active': %s", db_err)
            
            # Cache tools
            try:
                tools = await server.get_tools()
                await self.db.upsert_tools(server_id, tools)
                logger.info("Server %s: cached %d tools", server_record['name'], len(tools))
            except Exception as e:  # noqa: BLE001 -- tool caching: non-critical, don't fail server start
                logger.warning("Failed to cache tools: %s", e)
            return True
            
        except Exception as e:  # noqa: BLE001 -- server start boundary: must catch all to mark error and continue
            logger.error("Failed to start server %s: %s", server_record['name'], e)
            # ARCHITECTURAL FIX: Isolate MCP failures - don't crash entire backend
            # Mark server as error and continue with other servers
            # Use fire-and-forget to prevent DB update from blocking startup
            try:
                # Include full string representation for better UI diagnostics
                await self.db.update_server_status(server_id, "error", str(e))
            except Exception as db_err:  # noqa: BLE001 -- DB status update: best-effort during error handling
                logger.debug("Failed to update server status to 'error': %s", db_err)
            # Fail-fast: prevent repeatedly auto-starting a broken server on every boot.
            # If the schema doesn't support auto_start yet, this is a no-op.
            try:
                await self.db.update_server(server_id, auto_start=False)
            except Exception as e:  # noqa: BLE001 -- DB auto_start disable: best-effort
                logger.warning("Failed to disable auto_start for broken server %s: %s", server_id, e, exc_info=True)
            # DON'T raise - let application startup continue
            return False

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
        server = ConfiguredLocalServer(config, sandbox=sandbox)
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
        
        logger.info("Stopping server %s", server_id)
        
        try:
            # CRITICAL BUG FIX: Wrap DB operations in try/except to handle race conditions during shutdown
            try:
                await self.db.update_server_status(server_id, "stopping")
            except Exception as db_err:  # noqa: BLE001 -- DB status update: best-effort
                logger.debug("Failed to update server status to 'stopping': %s", db_err)
            
            server = self._active_servers[server_id]
            await server.stop()
            
            # CRITICAL BUG FIX: Wrap DB operations in try/except to handle race conditions during shutdown
            try:
                await self.db.update_server_status(server_id, "inactive")
            except Exception as db_err:  # noqa: BLE001 -- DB status update: best-effort
                logger.debug("Failed to update server status to 'inactive': %s", db_err)
            
        except Exception as e:  # noqa: BLE001 -- server stop boundary: must catch all to update error status
            logger.error("Error stopping server %s: %s", server_id, e)
            try:
                await self.db.update_server_status(server_id, "error", type(e).__name__)
            except Exception as db_err:  # noqa: BLE001 -- DB status update: best-effort during error handling
                logger.debug("Failed to update server status to 'error': %s", db_err)
        finally:
            # Always clean up references to prevent resource leaks,
            # even if server.stop() raised an exception.
            self._active_servers.pop(server_id, None)
            if server_id in self._sandboxes:
                try:
                    await self._sandboxes[server_id].stop_server()
                except Exception as e:  # noqa: BLE001 -- sandbox cleanup: best-effort during teardown
                    logger.warning("Sandbox cleanup failed during teardown for server %s: %s", server_id, e, exc_info=True)
                self._sandboxes.pop(server_id, None)
    
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
            logger.warning("Server %s stop timed out", server_id)
        except Exception as e:  # noqa: BLE001 -- quick stop: must not raise during shutdown
            logger.debug("Error stopping server %s: %s", server_id, e)

    async def _health_check_loop(self):
        """
        Periodic health check for all servers.
        
        Runs every 60 seconds, checks health of all active servers.
        """
        while not self._is_disposed:
            try:
                await asyncio.sleep(60)  # Check every minute
                
                for server_id in list(self._active_servers.keys()):
                    try:
                        await self.check_server_health(server_id)
                    except Exception as e:  # noqa: BLE001 -- health check loop: continue with other servers on any failure
                        logger.error("Health check failed for %s: %s", server_id, e)
                        
            except asyncio.CancelledError:
                break
            except Exception as e:  # noqa: BLE001 -- health check loop: must catch all to keep monitoring alive
                logger.error("Health check loop error: %s", e)

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

