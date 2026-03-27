"""
MCP Server Abstractions

@.architecture
Incoming: core/mcp/manager.py, mcp SDK (ClientSession, StdioServerParameters, stdio_client) --- {server config with command/args/env or API endpoint, start/stop/get_tools/apply_tool requests}
Processing: McpServer (ABC interface), LocalMcpServer.start(), LocalMcpServer.stop(), LocalMcpServer.get_tools(), LocalMcpServer.apply_tool(), RemoteMcpServer.start(), RemoteMcpServer.stop(), RemoteMcpServer.get_tools(), RemoteMcpServer.apply_tool(), ConfiguredLocalServer.init_server() --- {JOB_CLEANUP_RESOURCE, JOB_DISCOVER_TOOLS, JOB_EXECUTE_TOOL, JOB_HTTP_REQUEST, JOB_INITIALIZE_COMPONENT, JOB_MANAGE_CONNECTION, JOB_TRANSFORM_DATA}
Outgoing: OS (subprocess via MCP SDK stdio_client), External MCP APIs (HTTP GET/POST via aiohttp), core/mcp/manager.py --- {stdio communication, HTTP GET to {api}/tools, HTTP POST to {api}/execute, List[Dict] tool schemas in OpenAI format, str tool results}

Base classes for MCP server implementations supporting:
- Local stdio-based servers
- Remote HTTP/SSE servers
- Unified tool interface
"""

import json
import os
import asyncio
import ssl
import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

import aiohttp
import anyio
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
    async def apply_tool(self, tool_name: str, arguments: Dict[str, Any], timeout: float = 120.0) -> str:
        """
        Execute a tool with given arguments.
        
        Args:
            tool_name: Name of the tool to call
            arguments: Arguments to pass to the tool
            timeout: Maximum execution time in seconds
            
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


class AsyncioToAnyioReadStream(anyio.abc.ByteReceiveStream):
    def __init__(self, reader: asyncio.StreamReader):
        self.reader = reader

    async def receive(self, max_bytes: int = 65536) -> bytes:
        try:
            data = await self.reader.read(max_bytes)
        except Exception as e:
            raise anyio.EndOfStream from e
        if not data:
            raise anyio.EndOfStream
        return data

    async def aclose(self) -> None:
        pass


class AsyncioToAnyioWriteStream(anyio.abc.ByteSendStream):
    def __init__(self, writer: asyncio.StreamWriter):
        self.writer = writer

    async def send(self, item: bytes) -> None:
        try:
            self.writer.write(item)
            await self.writer.drain()
        except Exception as e:
            raise anyio.BrokenResourceError from e

    async def aclose(self) -> None:
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except Exception:
            pass


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

    def __init__(self, sandbox=None):
        """Initialize local MCP server wrapper."""
        super().__init__()
        self._session: Optional[ClientSession] = None
        self._run_task: Optional[asyncio.Task] = None
        self._ready_event: Optional[asyncio.Event] = None
        self._startup_error: Optional[Exception] = None
        self.sandbox = sandbox

    @abstractmethod
    async def init_server(self) -> StdioServerParameters:
        """
        Initialize server configuration.
        
        Subclasses must implement this to provide server-specific parameters.
        
        Returns:
            StdioServerParameters for the specific server implementation
        """
        pass

    async def _run_server_task(self, server_params: StdioServerParameters):
        """Background task to run the AnyIO context managers in a single task."""
        from contextlib import asynccontextmanager
        from mcp.shared.session import SessionMessage
        from mcp.types import JSONRPCMessage
        import anyio
        
        @asynccontextmanager
        async def _sandboxed_stdio():
            read_stream_writer, read_stream = anyio.create_memory_object_stream(100)
            write_stream, write_stream_reader = anyio.create_memory_object_stream(100)
            
            try:
                # Merge current env before spawning if sandbox doesn't do it fully, 
                # though MCPSandbox handles PATH/HOME manually.
                # However, our server_params.env should already be augmented.
                read, write = await self.sandbox.start_server(
                    command=server_params.command,
                    args=server_params.args,
                    env=server_params.env
                )
                
                async def stdout_reader():
                    try:
                        async with read_stream_writer:
                            buffer = ""
                            while True:
                                chunk = await read.read(4096)
                                if not chunk:
                                    break
                                
                                buffer += chunk.decode('utf-8', errors='replace')
                                lines = buffer.split("\n")
                                buffer = lines.pop()
                                
                                for line in lines:
                                    if not line.strip():
                                        continue
                                    try:
                                        message = JSONRPCMessage.model_validate_json(line)
                                        await read_stream_writer.send(SessionMessage(message=message))
                                    except Exception as exc:
                                        logger.exception("Failed to parse JSONRPC message from server")
                                        await read_stream_writer.send(exc)
                    except anyio.ClosedResourceError:
                        pass
                    except Exception as e:
                        logger.error(f"stdout_reader error: {e}")

                async def stdin_writer():
                    try:
                        async with write_stream_reader:
                            async for session_message in write_stream_reader:
                                json_str = session_message.message.model_dump_json(by_alias=True, exclude_none=True)
                                write.write((json_str + "\n").encode('utf-8'))
                                await write.drain()
                    except anyio.ClosedResourceError:
                        pass
                    except Exception as e:
                        logger.error(f"stdin_writer error: {e}")
                        
                async with anyio.create_task_group() as tg:
                    tg.start_soon(stdout_reader)
                    tg.start_soon(stdin_writer)
                    
                    try:
                        yield read_stream, write_stream
                    finally:
                        try:
                            write.close()
                            await write.wait_closed()
                        except Exception:
                            pass
                        await self.sandbox.stop_server()
            finally:
                await read_stream.aclose()
                await write_stream.aclose()
                await read_stream_writer.aclose()
                await write_stream_reader.aclose()

        try:
            context_mgr = _sandboxed_stdio() if self.sandbox else stdio_client(server_params)
            
            async with context_mgr as (r, w):
                async with ClientSession(r, w) as session:
                    self._session = session
                    await session.initialize()
                    self._ready_event.set()
                    
                    try:
                        # Keep alive until cancelled
                        await asyncio.Future()
                    except asyncio.CancelledError:
                        pass
        except Exception as e:
            # Unwrap ExceptionGroup to get the real underlying error
            error_msg = str(e)
            if hasattr(e, 'exceptions'):
                msgs = []
                def _unwrap(eg):
                    for exc in getattr(eg, 'exceptions', []):
                        if hasattr(exc, 'exceptions'):
                            _unwrap(exc)
                        else:
                            msgs.append(f"{type(exc).__name__}: {str(exc)}")
                _unwrap(e)
                if msgs:
                    error_msg = " | ".join(msgs)
            
            import traceback
            logger.error("Local MCP server subprocess error TRACEBACK:\n%s", "".join(traceback.format_exception(type(e), e, e.__traceback__)))
            
            # Attempt to gather any recent stderr from the sandbox to provide context
            if self.sandbox:
                stderr_context = ""
                if hasattr(self.sandbox, 'recent_stderr') and self.sandbox.recent_stderr:
                    stderr_context = "\n".join(self.sandbox.recent_stderr[-10:])
                
                if stderr_context.strip():
                    clean_stderr = stderr_context.strip()
                    error_msg += f" (Process Output: {clean_stderr})"
                elif hasattr(self.sandbox, 'exit_code') and self.sandbox.exit_code is not None:
                    error_msg += f" (Process exited unexpectedly with code {self.sandbox.exit_code})"
            
            logger.error("Local MCP server subprocess error: %s", error_msg)
            self._startup_error = RuntimeError(error_msg)
            if self._ready_event and not self._ready_event.is_set():
                self._ready_event.set()

    async def start(self) -> None:
        """
        Start the MCP server and establish stdio connection.
        
        Raises:
            RuntimeError: If server fails to start or initialize
        """
        try:
            server_params = await self.init_server()

            self._ready_event = asyncio.Event()
            self._startup_error = None
            self._run_task = asyncio.create_task(self._run_server_task(server_params))
            
            await self._ready_event.wait()
            
            if self._startup_error:
                raise self._startup_error
                
            if not self._session:
                raise RuntimeError("Failed to initialize session")
            
            logger.info("Started local MCP server: %s", server_params.command)
            
        except Exception as e:  # noqa: BLE001 -- server start: re-raises as RuntimeError; must catch all to cleanup first
            logger.error("Failed to start local MCP server: %s", e)
            await self.stop()
            raise RuntimeError(f"Local server startup failed: {e}")

    async def stop(self) -> None:
        """Stop the MCP server and clean up connections."""
        try:
            if self._run_task and not self._run_task.done():
                self._run_task.cancel()
                try:
                    await asyncio.wait_for(self._run_task, timeout=2.0)
                except (asyncio.TimeoutError, asyncio.CancelledError, RuntimeError):
                    pass  # Ignore context manager exit errors during shutdown
            
            self._run_task = None
            self._session = None
            self._ready_event = None
            self._startup_error = None
            
            logger.debug("Stopped local MCP server")
            
        except Exception as e:  # noqa: BLE001 -- stop boundary: must not raise during shutdown
            logger.error("Error stopping local MCP server: %s", e)

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
            
        except Exception as e:  # noqa: BLE001 -- tool discovery: re-raises; must catch all MCP protocol errors
            logger.error("Failed to get tools from local MCP server: %s", e)
            raise

    async def apply_tool(self, tool_name: str, arguments: Dict[str, Any], timeout: float = 120.0) -> str:
        """
        Apply a tool with given arguments.
        
        Args:
            tool_name: Name of the tool to call
            arguments: Arguments to pass to the tool
            timeout: Maximum execution time in seconds
            
        Returns:
            Tool result as string
            
        Raises:
            RuntimeError: If server not started or tool execution fails
        """
        if not self._session:
            raise RuntimeError("Server not started. Call start() first.")

        try:
            result = await asyncio.wait_for(
                self._session.call_tool(tool_name, arguments),
                timeout=timeout
            )
            
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
            
        except asyncio.TimeoutError:
            logger.error("Tool execution timed out after %s seconds: %s", timeout, tool_name)
            raise RuntimeError(f"Tool execution timed out after {timeout} seconds")
        except Exception as e:  # noqa: BLE001 -- tool execution: re-raises as RuntimeError; must catch all MCP protocol errors
            logger.error("Failed to execute tool %s: %s", tool_name, e)
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
            
            logger.info("Started remote MCP server client: %s", self.api_endpoint)
            
        except Exception as e:  # noqa: BLE001 -- remote server start: re-raises as RuntimeError; must catch all HTTP/SSL errors
            logger.error("Failed to start remote MCP server: %s", e)
            raise RuntimeError(f"Remote server startup failed: {e}")

    async def stop(self) -> None:
        """Stop the API session."""
        try:
            if self._session:
                await self._session.close()
                self._session = None
                
            logger.debug("Stopped remote MCP server client")
            
        except Exception as e:  # noqa: BLE001 -- stop boundary: must not raise during shutdown
            logger.error("Error stopping remote MCP server: %s", e)

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
                
        except Exception as e:  # noqa: BLE001 -- remote tool discovery: re-raises as RuntimeError; must catch all HTTP errors
            logger.error("Failed to get tools from remote MCP server: %s", e)
            raise RuntimeError(f"Failed to fetch tools: {e}")

    async def apply_tool(self, tool_name: str, arguments: Dict[str, Any], timeout: float = 120.0) -> str:
        """
        Execute a tool via the API server.
        
        Args:
            tool_name: Name of the tool to call
            arguments: Arguments to pass to the tool
            timeout: Maximum execution time in seconds
            
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
                timeout=aiohttp.ClientTimeout(total=timeout)
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
                    
        except asyncio.TimeoutError:
            logger.error("Tool execution timed out after %s seconds on remote server: %s", timeout, tool_name)
            raise RuntimeError(f"Remote tool execution timed out after {timeout} seconds")
        except Exception as e:  # noqa: BLE001 -- remote tool execution: re-raises as RuntimeError; must catch all HTTP errors
            logger.error("Failed to execute tool %s on remote server: %s", tool_name, e)
            raise RuntimeError(f"Remote tool execution failed: {e}")


# ==================== Concrete Server Implementations ====================

class ConfiguredLocalServer(LocalMcpServer):
    """
    Dynamically configured local MCP server.
    
    Created at runtime from database configuration. Supports any MCP server
    that follows stdio protocol.
    """

    def __init__(self, config: Dict[str, Any], sandbox=None):
        """
        Initialize with configuration.
        
        Args:
            config: Server configuration with command, args, env
            sandbox: Optional sandbox instance
        """
        super().__init__(sandbox=sandbox)
        self._config = config

    async def init_server(self) -> StdioServerParameters:
        """Create StdioServerParameters from config."""
        # Merge configured environment with system environment
        # MCP servers need PATH and other critical system variables to function
        merged_env = os.environ.copy()
        config_env = self._config.get("env", {})
        if config_env:
            merged_env.update({k: str(v) for k, v in config_env.items()})
            
        return StdioServerParameters(
            command=self._config["command"],
            args=self._config.get("args", []),
            env=merged_env,
        )

