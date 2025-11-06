"""
MCP Bridge for Open Interpreter
Secure integration with isolated execution environment

This bridge exposes MCP servers to Open Interpreter agents via computer.mcp API
with security isolation and audit logging.

@.architecture
Incoming: Open Interpreter computer, core/mcp/manager.py --- {MCPServerManager, str server_name, str tool_name, Dict tool_args}
Processing: list_servers(), list_tools(), execute(), health(), _log_execution() --- {5 jobs: audit_logging, mcp_orchestration, security_isolation, tool_discovery, tool_execution}
Outgoing: Open Interpreter computer.mcp namespace, core/mcp/manager.py --- {List[Dict] servers/tools, Any tool_execution_result, Dict health status}
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

logger = logging.getLogger(__name__)


class MCPBridge:
    """
    Bridge between Open Interpreter and MCP Server Manager
    
    Provides access to MCP tools through computer.mcp API:
    - computer.mcp.list_servers() - List available servers
    - computer.mcp.list_tools(server_name) - List tools from a server
    - computer.mcp.execute(server_name, tool_name, **kwargs) - Execute tool
    - computer.mcp.health(server_name) - Check server health
    
    Security features:
    - All executions run in sandbox
    - Full audit trail in database
    - Resource limits enforced
    - Network isolation (optional)
    """

    def __init__(self, interpreter, manager):
        """
        Initialize MCP bridge
        
        Args:
            interpreter: Open Interpreter instance
            manager: MCPServerManager instance
        """
        self._interpreter = interpreter
        self._computer = interpreter.computer
        self._manager = manager
        self._bridge_marker = "mcp_bridge"
        
        # Cache for server name to UUID mapping
        self._server_cache: Dict[str, UUID] = {}

    def install(self) -> bool:
        """
        Install bridge into interpreter's computer API
        
        Returns:
            True if installation successful
        """
        try:
            # Create a proper MCP class instance for tool discovery
            mcp_class = MCPToolsClass(self)
            
            # Attach both the bridge and the tool class to computer API
            self._computer.mcp = self
            self._computer.mcp_tools = mcp_class
            logger.info("MCP bridge installed: computer.mcp and computer.mcp_tools available")
            
            # Tool registration will be called by oi_runtime after delay
            
            return True
        except Exception as e:
            logger.error(f"Failed to install MCP bridge: {e}")
            return False
    
    async def _register_dynamic_tools_async(self):
        """
        Dynamically register all MCP tools as individual functions in computer API
        AND populate the MCPToolsClass for proper tool discovery
        This makes MCP tools discoverable by the agent's semantic search
        """
        try:
            # Import ToolMetadata for catalog registration
            try:
                from interpreter.core.computer.tool_metadata import ToolMetadata, ToolComplexity
                has_tool_metadata = True
            except ImportError:
                logger.warning("Cannot import ToolMetadata - tools won't be indexed in semantic search")
                has_tool_metadata = False
            
            # Get servers directly from manager (async)
            servers = await self._manager.list_servers()
            total_tools = 0
            tool_metadata_list = []
            
            for server in servers:
                if not server.get("is_running"):
                    logger.debug(f"Skipping server {server.get('name')} - not running")
                    continue
                
                server_name = server["name"]
                server_id = server["id"] if isinstance(server["id"], UUID) else UUID(str(server["id"]))
                server_desc = server.get("description", "")
                
                # Get tools directly from manager (async)
                tools = await self._manager.get_server_tools(server_id, refresh=False)
                
                for tool in tools:
                    tool_func = tool["function"]
                    tool_name = f"mcp_{server_name}_{tool_func['name']}"
                    tool_desc = tool_func.get("description", "")
                    tool_params = tool_func.get("parameters", {})
                    
                    # Create wrapper function for this tool
                    def make_tool_executor(srv_name, tl_name, tl_desc, tl_params):
                        def executor(**kwargs):
                            """Dynamically generated MCP tool executor"""
                            return self.execute(srv_name, tl_name, **kwargs)
                        
                        executor.__name__ = f"mcp_{srv_name}_{tl_name}"
                        executor.__doc__ = f"{tl_desc}\n\nServer: {srv_name}\nTool: {tl_name}\nParameters: {tl_params}"
                        return executor
                    
                    # Register tool in computer API
                    tool_executor = make_tool_executor(
                        server_name,
                        tool_func["name"],
                        tool_desc,
                        tool_params
                    )
                    
                    setattr(self._computer, tool_name, tool_executor)
                    total_tools += 1
                    logger.debug(f"Registered MCP tool: {tool_name}")
                    
                    # Create ToolMetadata for catalog registration
                    if has_tool_metadata:
                        # Extract parameters
                        params_list = []
                        if isinstance(tool_params, dict) and "properties" in tool_params:
                            required = tool_params.get("required", [])
                            for param_name, param_info in tool_params["properties"].items():
                                params_list.append({
                                    "name": param_name,
                                    "type": param_info.get("type", "any"),
                                    "description": param_info.get("description", ""),
                                    "required": param_name in required
                                })
                        
                        # Determine subcategory based on server name
                        subcategory = "External Services"
                        if "memory" in server_name.lower() or "knowledge" in server_name.lower():
                            subcategory = "Memory & Knowledge"
                        elif "file" in server_name.lower() or "fs" in server_name.lower():
                            subcategory = "Filesystem Access"
                        
                        # Create metadata
                        metadata = ToolMetadata(
                            name=tool_name,
                            category="MCP Tools",
                            subcategory=subcategory,
                            description=f"{tool_desc} (via {server_name} MCP server)",
                            complexity=ToolComplexity.MODERATE,
                            parameters=params_list,
                            use_cases=[
                                f"Use {server_name} server for {tool_func['name']}",
                                server_desc if server_desc else f"{server_name} operations"
                            ],
                            tags={server_name, "mcp", "external", tool_func['name']},
                            signature=f"{tool_name}(**kwargs)",
                            full_path=f"computer.{tool_name}"
                        )
                        tool_metadata_list.append(metadata)
            
            logger.info(f"✅ Dynamically registered {total_tools} MCP tools across {len(servers)} servers")
            
            # Register with tool engine for semantic search
            if has_tool_metadata and tool_metadata_list:
                try:
                    # Access tool engine via computer.tools._engine
                    if hasattr(self._computer, 'tools') and hasattr(self._computer.tools, '_engine'):
                        self._computer.tools._engine.register_dynamic_tools(tool_metadata_list)
                        logger.info(f"✅ Indexed {len(tool_metadata_list)} MCP tools in semantic search")
                    else:
                        logger.warning("Tool engine not available - MCP tools not indexed for search")
                except Exception as e:
                    logger.error(f"Failed to register MCP tools in engine: {e}", exc_info=True)
            
            # Also populate MCPToolsClass for proper tool discovery
            if hasattr(self._computer, 'mcp_tools'):
                try:  
                    await self._computer.mcp_tools._populate_tools()
                    logger.info("✅ MCP Bridge: Populated MCPToolsClass for tool discovery")
                except Exception as e:
                    logger.warning(f"Failed to populate MCPToolsClass: {e}")
            
        except Exception as e:
            logger.error(f"Failed to register dynamic MCP tools: {e}", exc_info=True)

    async def _get_server_id(self, server_name: str) -> UUID:
        """
        Get server UUID from name with caching
        
        Args:
            server_name: Server name
            
        Returns:
            Server UUID
            
        Raises:
            ValueError: If server not found
        """
        # Check cache first
        if server_name in self._server_cache:
            return self._server_cache[server_name]
        
        # Fetch from manager
        server = await self._manager.db.get_server_by_name(server_name)
        
        if not server:
            raise ValueError(f"MCP server '{server_name}' not found")
        
        server_id = UUID(server["id"])
        self._server_cache[server_name] = server_id
        
        return server_id

    # ==================== Public API ====================

    def list_servers(self) -> List[Dict[str, Any]]:
        """
        List all available MCP servers
        
        Returns:
            List of server information dicts
        """
        try:
            # Run async operation in event loop
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # If called from async context, use run_until_complete
                future = asyncio.run_coroutine_threadsafe(
                    self._manager.list_servers(),
                    loop
                )
                servers = future.result(timeout=10)
            else:
                servers = loop.run_until_complete(self._manager.list_servers())
            
            # Simplify output for agent
            return [
                {
                    "name": s["name"],
                    "display_name": s["display_name"],
                    "type": s["server_type"],
                    "status": s["status"],
                    "is_running": s.get("is_running", False),
                    "description": s.get("description", ""),
                }
                for s in servers
                if s.get("enabled", True)
            ]
            
        except Exception as e:
            logger.error(f"Failed to list servers: {e}")
            return []

    def list_tools(self, server_name: str, refresh: bool = False) -> List[Dict[str, Any]]:
        """
        List tools available from an MCP server
        
        Args:
            server_name: Name of the server
            refresh: Force refresh from server
            
        Returns:
            List of tool schemas
        """
        try:
            loop = asyncio.get_event_loop()
            
            # Get server ID
            if loop.is_running():
                future = asyncio.run_coroutine_threadsafe(
                    self._get_server_id(server_name),
                    loop
                )
                server_id = future.result(timeout=5)
            else:
                server_id = loop.run_until_complete(
                    self._get_server_id(server_name)
                )
            
            # Get tools
            if loop.is_running():
                future = asyncio.run_coroutine_threadsafe(
                    self._manager.get_server_tools(server_id, refresh=refresh),
                    loop
                )
                tools = future.result(timeout=30)
            else:
                tools = loop.run_until_complete(
                    self._manager.get_server_tools(server_id, refresh=refresh)
                )
            
            return tools
            
        except Exception as e:
            logger.error(f"Failed to list tools for {server_name}: {e}")
            return []

    def execute(
        self,
        server_name: str,
        tool_name: str,
        **arguments
    ) -> Dict[str, Any]:
        """
        Execute a tool on an MCP server
        
        Args:
            server_name: Name of the server
            tool_name: Name of the tool
            **arguments: Tool arguments as keyword args
            
        Returns:
            Execution result
            
        Example:
            result = computer.mcp.execute(
                "weather",
                "get_forecast",
                location="San Francisco",
                days=3
            )
        """
        try:
            loop = asyncio.get_event_loop()
            
            # Get server ID
            if loop.is_running():
                future = asyncio.run_coroutine_threadsafe(
                    self._get_server_id(server_name),
                    loop
                )
                server_id = future.result(timeout=5)
            else:
                server_id = loop.run_until_complete(
                    self._get_server_id(server_name)
                )
            
            # Execute tool
            execution_context = {
                "source": "open_interpreter",
                "interpreter_id": id(self._interpreter),
            }
            
            if loop.is_running():
                future = asyncio.run_coroutine_threadsafe(
                    self._manager.execute_tool(
                        server_id=server_id,
                        tool_name=tool_name,
                        arguments=arguments,
                        execution_context=execution_context,
                    ),
                    loop
                )
                result = future.result(timeout=300)  # 5 min timeout
            else:
                result = loop.run_until_complete(
                    self._manager.execute_tool(
                        server_id=server_id,
                        tool_name=tool_name,
                        arguments=arguments,
                        execution_context=execution_context,
                    )
                )
            
            return result
            
        except Exception as e:
            logger.error(f"Failed to execute {tool_name} on {server_name}: {e}")
            return {
                "success": False,
                "error": str(e),
                "duration_ms": 0,
            }

    def health(self, server_name: str) -> Dict[str, Any]:
        """
        Check health of an MCP server
        
        Args:
            server_name: Name of the server
            
        Returns:
            Health status
        """
        try:
            loop = asyncio.get_event_loop()
            
            # Get server ID
            if loop.is_running():
                future = asyncio.run_coroutine_threadsafe(
                    self._get_server_id(server_name),
                    loop
                )
                server_id = future.result(timeout=5)
            else:
                server_id = loop.run_until_complete(
                    self._get_server_id(server_name)
                )
            
            # Check health
            if loop.is_running():
                future = asyncio.run_coroutine_threadsafe(
                    self._manager.check_server_health(server_id),
                    loop
                )
                health = future.result(timeout=30)
            else:
                health = loop.run_until_complete(
                    self._manager.check_server_health(server_id)
                )
            
            return health
            
        except Exception as e:
            logger.error(f"Failed to check health for {server_name}: {e}")
            return {
                "healthy": False,
                "status": "error",
                "error": str(e)
            }

    def get_execution_history(
        self,
        server_name: Optional[str] = None,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Get execution history
        
        Args:
            server_name: Filter by server (optional)
            limit: Maximum number of results
            
        Returns:
            List of execution records
        """
        try:
            loop = asyncio.get_event_loop()
            
            # Get server ID if specified
            server_id = None
            if server_name:
                if loop.is_running():
                    future = asyncio.run_coroutine_threadsafe(
                        self._get_server_id(server_name),
                        loop
                    )
                    server_id = future.result(timeout=5)
                else:
                    server_id = loop.run_until_complete(
                        self._get_server_id(server_name)
                    )
            
            # Get history
            if loop.is_running():
                future = asyncio.run_coroutine_threadsafe(
                    self._manager.get_execution_history(server_id, limit),
                    loop
                )
                history = future.result(timeout=10)
            else:
                history = loop.run_until_complete(
                    self._manager.get_execution_history(server_id, limit)
                )
            
            return history
            
        except Exception as e:
            logger.error(f"Failed to get execution history: {e}")
            return []

    def __repr__(self) -> str:
        """String representation"""
        return f"<MCPBridge: {len(self._server_cache)} servers cached>"

    def __str__(self) -> str:
        """Human-readable description"""
        servers = self.list_servers()
        server_list = ", ".join(s["name"] for s in servers) or "none"
        return f"MCP Bridge ({len(servers)} servers): {server_list}"


class MCPToolsClass:
    """
    Wrapper class to make MCP tools discoverable by the tool catalog system.
    This class dynamically populates itself with MCP tool methods.
    """
    
    def __init__(self, bridge: MCPBridge):
        self._bridge = bridge
        self._tools_populated = False
    
    async def _populate_tools(self):
        """Populate the class with MCP tool methods"""
        if self._tools_populated:
            return
            
        try:
            # Get servers from manager
            servers = await self._bridge._manager.list_servers()
            
            for server in servers:
                if not server.get("is_running"):
                    continue
                
                server_name = server["name"]
                server_id = server["id"] if isinstance(server["id"], UUID) else UUID(str(server["id"]))
                
                # Get tools from server
                tools = await self._bridge._manager.get_server_tools(server_id, refresh=False)
                
                for tool in tools:
                    tool_func = tool["function"]
                    tool_name = f"{server_name}_{tool_func['name']}"
                    tool_desc = tool_func.get("description", "")
                    
                    # Create wrapper method
                    def make_tool_method(srv_name, tl_name, tl_desc):
                        async def tool_method(**kwargs):
                            """MCP tool method"""
                            return await self._bridge.execute(srv_name, tl_name, **kwargs)
                        
                        tool_method.__name__ = f"{srv_name}_{tl_name}"
                        tool_method.__doc__ = f"{tl_desc}\n\nMCP Server: {srv_name}\nTool: {tl_name}"
                        return tool_method
                    
                    # Set method on this class instance
                    method = make_tool_method(server_name, tool_func["name"], tool_desc)
                    setattr(self, tool_name, method)
                    
                    logger.debug(f"Added MCP tool method: {tool_name}")
            
            self._tools_populated = True
            logger.info("MCP tools populated in MCPToolsClass")
            
        except Exception as e:
            logger.error(f"Failed to populate MCP tools: {e}")
    
    def list_servers(self):
        """List available MCP servers"""
        return self._bridge.list_servers()
    
    def list_tools(self, server_name: str):
        """List tools from a specific server"""
        return self._bridge.list_tools(server_name)
    
    def health(self, server_name: str):
        """Check server health"""
        return self._bridge.health(server_name)
    
    async def execute(self, server_name: str, tool_name: str, **kwargs):
        """Execute a tool"""
        return await self._bridge.execute(server_name, tool_name, **kwargs)

