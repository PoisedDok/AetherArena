"""
MCP Server Abstractions

@.architecture
Incoming: core/mcp/manager.py, mcp SDK (ClientSession, StdioServerParameters, stdio_client) --- {server config with command/args/env or API endpoint, start/stop/get_tools/apply_tool requests}
Processing: McpServer (ABC interface), LocalMcpServer.start(), LocalMcpServer.stop(), LocalMcpServer.get_tools(), LocalMcpServer.apply_tool(), RemoteMcpServer.start(), RemoteMcpServer.stop(), RemoteMcpServer.get_tools(), RemoteMcpServer.apply_tool(), ConfiguredLocalServer.init_server() --- {10 jobs: abstraction, cleanup, http_communication, initialization, lifecycle_management, schema_conversion, session_management, stdio_connection, tool_discovery, tool_execution}
Outgoing: OS (subprocess via MCP SDK stdio_client), External MCP APIs (HTTP GET/POST via aiohttp), core/mcp/manager.py --- {stdio communication, HTTP GET to {api}/tools, HTTP POST to {api}/execute, List[Dict] tool schemas in OpenAI format, str tool results}

Base classes for MCP server implementations supporting:
- Local stdio-based servers
- Remote HTTP/SSE servers
- Unified tool interface
"""

import json
import ssl
import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

import aiohttp
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logger = logging.getLogger(__name__)


class McpServer(ABC):
    """
    Abstract base class for all MCP server implementations.
    
    Provides unified interface for:
    - Server lifecycle management (start/stop)
    - Tool discovery (get_tools)
    - Tool execution (apply_tool)
    """

    def __init__(self):
        """Initialize MCP server."""
        pass

    @abstractmethod
    async def start(self) -> None:
        """
        Start the MCP server connection.
        
        Raises:
            RuntimeError: If server fails to start
        """
        pass

    @abstractmethod
    async def stop(self) -> None:
        """Stop the MCP server connection and cleanup resources."""
        pass

    @abstractmethod
    async def get_tools(self) -> List[Dict[str, Any]]:
        """
        Get available tools from the MCP server.
        
        Returns:
            List of tool schemas in OpenAI function calling format:
            [
                {
                    "type": "function",
                    "function": {
                        "name": str,
                        "description": str,
                        "parameters": dict
                    }
                }
            ]
        """
        pass

    @abstractmethod
    async def apply_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """
        Execute a tool with given arguments.
        
        Args:
            tool_name: Name of the tool to call
            arguments: Arguments to pass to the tool
            
        Returns:
            Tool result as string
            
        Raises:
            RuntimeError: If server not started or tool execution fails
        """
        pass

    async def __aenter__(self):
        """Async context manager entry."""
        await self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.stop()


class LocalMcpServer(McpServer):
    """
    MCP server that runs locally via stdio communication.
    
    Executes MCP server as subprocess and communicates via stdin/stdout using
    the official MCP Python SDK. Supports all MCP servers that follow the
    stdio protocol specification.
    
    Example config:
        {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
            "env": {"API_KEY": "value"}
        }
    """

    def __init__(self):
        """Initialize local MCP server wrapper."""
        super().__init__()
        self._session: Optional[ClientSession] = None
        self._read = None
        self._write = None
        self._stdio_context = None
        self._session_context = None

    @abstractmethod
    async def init_server(self) -> StdioServerParameters:
        """
        Initialize server configuration.
        
        Subclasses must implement this to provide server-specific parameters.
        
        Returns:
            StdioServerParameters for the specific server implementation
        """
        pass

    async def start(self) -> None:
        """
        Start the MCP server and establish stdio connection.
        
        Raises:
            RuntimeError: If server fails to start or initialize
        """
        try:
            server_params = await self.init_server()

            # Start stdio client (spawns subprocess)
            self._stdio_context = stdio_client(server_params)
            self._read, self._write = await self._stdio_context.__aenter__()

            # Start session
            self._session_context = ClientSession(self._read, self._write)
            self._session = await self._session_context.__aenter__()

            # Initialize session
            await self._session.initialize()
            
            logger.info(f"Started local MCP server: {server_params.command}")
            
        except Exception as e:
            logger.error(f"Failed to start local MCP server: {e}")
            await self.stop()
            raise RuntimeError(f"Local server startup failed: {e}")

    async def stop(self) -> None:
        """Stop the MCP server and clean up connections."""
        try:
            # Close session first
            if self._session_context:
                try:
                    await asyncio.wait_for(
                        self._session_context.__aexit__(None, None, None),
                        timeout=1.0
                    )
                except (asyncio.TimeoutError, asyncio.CancelledError, RuntimeError):
                    pass  # Ignore context manager exit errors during shutdown
                finally:
                    self._session_context = None
                self._session = None

            # Close stdio context
            if self._stdio_context:
                try:
                    await asyncio.wait_for(
                        self._stdio_context.__aexit__(None, None, None),
                        timeout=1.0
                    )
                except (asyncio.TimeoutError, asyncio.CancelledError, RuntimeError):
                    pass  # Ignore context manager exit errors during shutdown
                finally:
                    self._stdio_context = None
                    self._read = None
                    self._write = None
                
            logger.debug("Stopped local MCP server")
            
        except Exception as e:
            logger.error(f"Error stopping local MCP server: {e}")

    async def get_tools(self) -> List[Dict[str, Any]]:
        """
        Get available tools in OpenAI format.
        
        Returns:
            List of tool schemas in OpenAI format
            
        Raises:
            RuntimeError: If server not started
        """
        if not self._session:
            raise RuntimeError("Server not started. Call start() first.")

        try:
            # Get available tools from MCP server
            tools_result = await self._session.list_tools()

            # Convert to OpenAI format
            tool_schemas = []
            for tool in tools_result.tools:
                tool_schema = {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description or f"MCP tool: {tool.name}",
                        "parameters": tool.inputSchema
                        or {"type": "object", "properties": {}},
                    },
                }
                tool_schemas.append(tool_schema)

            return tool_schemas
            
        except Exception as e:
            logger.error(f"Failed to get tools from local MCP server: {e}")
            raise

    async def apply_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """
        Apply a tool with given arguments.
        
        Args:
            tool_name: Name of the tool to call
            arguments: Arguments to pass to the tool
            
        Returns:
            Tool result as string
            
        Raises:
            RuntimeError: If server not started or tool execution fails
        """
        if not self._session:
            raise RuntimeError("Server not started. Call start() first.")

        try:
            result = await self._session.call_tool(tool_name, arguments)
            
            # Extract text content from MCP result
            if hasattr(result, "content") and result.content:
                if isinstance(result.content, list):
                    # Handle list of content items
                    content_text = ""
                    for item in result.content:
                        if hasattr(item, "text"):
                            content_text += item.text
                        else:
                            content_text += str(item)
                else:
                    content_text = (
                        result.content.text
                        if hasattr(result.content, "text")
                        else str(result.content)
                    )
            else:
                content_text = str(result)

            return content_text
            
        except Exception as e:
            logger.error(f"Failed to execute tool {tool_name}: {e}")
            raise RuntimeError(f"Tool execution failed: {e}")


class RemoteMcpServer(McpServer):
    """
    MCP server that communicates with a hosted API server via HTTP.
    
    For remote MCP servers exposed over HTTP/SSE. Communicates using standard
    HTTP requests instead of stdio protocol.
    
    Example config:
        {
            "url": "https://api.example.com/mcp"
        }
    """

    def __init__(self, api_endpoint: str):
        """
        Initialize API-based MCP server.
        
        Args:
            api_endpoint: Base URL of the hosted MCP server API
        """
        super().__init__()
        self.api_endpoint = api_endpoint.rstrip("/")
        self._session: Optional[aiohttp.ClientSession] = None

    async def start(self) -> None:
        """
        Start the API session.
        
        Creates aiohttp client session with SSL configuration.
        """
        try:
            # Create SSL context (for development, accepts self-signed certs)
            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
            connector = aiohttp.TCPConnector(ssl=ssl_context)
            self._session = aiohttp.ClientSession(connector=connector)
            
            logger.info(f"Started remote MCP server client: {self.api_endpoint}")
            
        except Exception as e:
            logger.error(f"Failed to start remote MCP server: {e}")
            raise RuntimeError(f"Remote server startup failed: {e}")

    async def stop(self) -> None:
        """Stop the API session."""
        try:
            if self._session:
                await self._session.close()
                self._session = None
                
            logger.debug("Stopped remote MCP server client")
            
        except Exception as e:
            logger.error(f"Error stopping remote MCP server: {e}")

    async def get_tools(self) -> List[Dict[str, Any]]:
        """
        Get available tools from the API server.
        
        Returns:
            List of tool schemas in OpenAI format
            
        Raises:
            RuntimeError: If server not started or API request fails
        """
        if not self._session:
            raise RuntimeError("Server not started. Call start() first.")

        try:
            async with self._session.get(
                f"{self.api_endpoint}/tools",
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                response.raise_for_status()
                tools_data = await response.json()

                # Convert to OpenAI format if needed
                tool_schemas = []
                for tool in tools_data.get("tools", []):
                    if "function" in tool:
                        # Already in OpenAI format
                        tool_schemas.append(tool)
                    else:
                        # Convert from MCP format to OpenAI format
                        tool_schema = {
                            "type": "function",
                            "function": {
                                "name": tool.get("name", ""),
                                "description": tool.get(
                                    "description", f"API tool: {tool.get('name', '')}"
                                ),
                                "parameters": tool.get(
                                    "inputSchema", {"type": "object", "properties": {}}
                                ),
                            },
                        }
                        tool_schemas.append(tool_schema)

                return tool_schemas
                
        except Exception as e:
            logger.error(f"Failed to get tools from remote MCP server: {e}")
            raise RuntimeError(f"Failed to fetch tools: {e}")

    async def apply_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """
        Execute a tool via the API server.
        
        Args:
            tool_name: Name of the tool to call
            arguments: Arguments to pass to the tool
            
        Returns:
            Tool result as string
            
        Raises:
            RuntimeError: If server not started or API request fails
        """
        if not self._session:
            raise RuntimeError("Server not started. Call start() first.")

        try:
            payload = {"tool_name": tool_name, "arguments": arguments}

            async with self._session.post(
                f"{self.api_endpoint}/execute",
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=60)
            ) as response:
                response.raise_for_status()
                result_data = await response.json()

                # Extract result text
                if "result" in result_data:
                    if isinstance(result_data["result"], str):
                        return result_data["result"]
                    elif isinstance(result_data["result"], dict):
                        # Handle structured result
                        if "content" in result_data["result"]:
                            content = result_data["result"]["content"]
                            if isinstance(content, list):
                                # Handle list of content items
                                content_text = ""
                                for item in content:
                                    if isinstance(item, dict) and "text" in item:
                                        content_text += item["text"]
                                    else:
                                        content_text += str(item)
                                return content_text
                            elif isinstance(content, dict) and "text" in content:
                                return content["text"]
                            else:
                                return str(content)
                        else:
                            return json.dumps(result_data["result"])
                    else:
                        return str(result_data["result"])
                else:
                    return json.dumps(result_data)
                    
        except Exception as e:
            logger.error(f"Failed to execute tool {tool_name} on remote server: {e}")
            raise RuntimeError(f"Remote tool execution failed: {e}")


# ==================== Concrete Server Implementations ====================

class ConfiguredLocalServer(LocalMcpServer):
    """
    Dynamically configured local MCP server.
    
    Created at runtime from database configuration. Supports any MCP server
    that follows stdio protocol.
    """

    def __init__(self, config: Dict[str, Any]):
        """
        Initialize with configuration.
        
        Args:
            config: Server configuration with command, args, env
        """
        super().__init__()
        self._config = config

    async def init_server(self) -> StdioServerParameters:
        """Create StdioServerParameters from config."""
        return StdioServerParameters(
            command=self._config["command"],
            args=self._config.get("args", []),
            env=self._config.get("env", {}),
        )

