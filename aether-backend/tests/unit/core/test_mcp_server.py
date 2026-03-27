"""
Tests for core.mcp.server — MCP server abstractions.

Covers:
- McpServer ABC: async context manager (__aenter__, __aexit__)
- LocalMcpServer: start, stop, get_tools, apply_tool
- RemoteMcpServer: start, stop, get_tools, apply_tool
- ConfiguredLocalServer: init_server from config dict

All external dependencies (mcp SDK, aiohttp, ssl) are mocked.
Tests verify delegation, error handling, content extraction branches,
and format conversion logic.
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.mcp.server import (
    LocalMcpServer,
    RemoteMcpServer,
    ConfiguredLocalServer,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class ConcreteLocalServer(LocalMcpServer):
    """Concrete subclass for testing LocalMcpServer (which has abstract init_server)."""

    def __init__(self, params=None):
        super().__init__()
        self._params = params or MagicMock()

    async def init_server(self):
        return self._params


def _make_tool(name, description=None, input_schema=None):
    """Create a mock MCP tool object."""
    tool = MagicMock()
    tool.name = name
    tool.description = description
    tool.inputSchema = input_schema
    return tool


def _make_tools_result(tools):
    """Create a mock tools_result with .tools attribute."""
    result = MagicMock()
    result.tools = tools
    return result


def _make_content_item(text=None):
    """Create a mock content item with optional .text."""
    item = MagicMock()
    if text is not None:
        item.text = text
    else:
        del item.text  # Remove attribute so hasattr returns False
    return item


# ===========================================================================
# McpServer ABC
# ===========================================================================

class TestMcpServerContextManager:
    """Tests for McpServer async context manager protocol."""

    async def test_aenter_calls_start_and_returns_self(self):
        server = ConcreteLocalServer()
        server.start = AsyncMock()
        result = await server.__aenter__()
        server.start.assert_awaited_once()
        assert result is server

    async def test_aexit_calls_stop(self):
        server = ConcreteLocalServer()
        server.stop = AsyncMock()
        await server.__aexit__(None, None, None)
        server.stop.assert_awaited_once()

    async def test_aexit_calls_stop_on_exception(self):
        server = ConcreteLocalServer()
        server.stop = AsyncMock()
        await server.__aexit__(RuntimeError, RuntimeError("boom"), None)
        server.stop.assert_awaited_once()


# ===========================================================================
# LocalMcpServer
# ===========================================================================

class TestLocalMcpServerInit:
    def test_initial_state(self):
        server = ConcreteLocalServer()
        assert server._session is None
        assert getattr(server, '_run_task', None) is None
        assert getattr(server, '_ready_event', None) is None
        assert getattr(server, '_startup_error', None) is None


class TestLocalMcpServerStart:
    @patch("core.mcp.server.ClientSession")
    @patch("core.mcp.server.stdio_client")
    async def test_start_success(self, mock_stdio_client, mock_client_session):
        params = MagicMock()
        server = ConcreteLocalServer(params=params)

        # Mock stdio_client context manager
        mock_read = MagicMock()
        mock_write = MagicMock()
        mock_stdio_ctx = MagicMock()
        mock_stdio_ctx.__aenter__ = AsyncMock(return_value=(mock_read, mock_write))
        mock_stdio_ctx.__aexit__ = AsyncMock()
        mock_stdio_client.return_value = mock_stdio_ctx

        # Mock ClientSession context manager
        mock_session = AsyncMock()
        mock_session.initialize = AsyncMock()
        mock_session_ctx = MagicMock()
        mock_session_ctx.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_ctx.__aexit__ = AsyncMock()
        mock_client_session.return_value = mock_session_ctx

        # Make start() complete so we can inspect it
        start_task = asyncio.create_task(server.start())
        await asyncio.sleep(0.05)

        mock_stdio_client.assert_called_once_with(params)
        mock_client_session.assert_called_once_with(mock_read, mock_write)
        mock_session.initialize.assert_awaited_once()
        assert server._session is mock_session
        
        await server.stop()
        await start_task

    @patch("core.mcp.server.ClientSession")
    @patch("core.mcp.server.stdio_client")
    async def test_start_failure_calls_stop_and_raises(self, mock_stdio_client, mock_client_session):
        server = ConcreteLocalServer()

        # Make stdio_client.__aenter__ fail
        mock_stdio_ctx = MagicMock()
        mock_stdio_ctx.__aenter__ = AsyncMock(side_effect=OSError("no such binary"))
        mock_stdio_client.return_value = mock_stdio_ctx

        with patch.object(server, "stop", new_callable=AsyncMock) as mock_stop:
            with pytest.raises(RuntimeError, match="Local server startup failed"):
                await server.start()
            mock_stop.assert_awaited_once()


class TestLocalMcpServerStop:
    async def test_stop_cancels_run_task(self):
        server = ConcreteLocalServer()
        mock_task = MagicMock(spec=asyncio.Task)
        mock_task.done.return_value = False
        server._run_task = mock_task
        server._session = MagicMock()
        server._ready_event = MagicMock()

        with patch("asyncio.wait_for", new_callable=AsyncMock) as mock_wait_for:
            await server.stop()
            
            mock_task.cancel.assert_called_once()
            mock_wait_for.assert_awaited_once_with(mock_task, timeout=2.0)
            
            assert server._run_task is None
            assert server._session is None
            assert server._ready_event is None

    async def test_stop_handles_timeout(self):
        server = ConcreteLocalServer()
        mock_task = MagicMock(spec=asyncio.Task)
        mock_task.done.return_value = False
        server._run_task = mock_task
        
        with patch("asyncio.wait_for", AsyncMock(side_effect=asyncio.TimeoutError)):
            await server.stop()
            assert server._run_task is None

    async def test_stop_handles_cancelled_error(self):
        server = ConcreteLocalServer()
        mock_task = MagicMock(spec=asyncio.Task)
        mock_task.done.return_value = False
        server._run_task = mock_task
        
        with patch("asyncio.wait_for", AsyncMock(side_effect=asyncio.CancelledError)):
            await server.stop()
            assert server._run_task is None

    async def test_stop_handles_runtime_error(self):
        server = ConcreteLocalServer()
        mock_task = MagicMock(spec=asyncio.Task)
        mock_task.done.return_value = False
        server._run_task = mock_task
        
        with patch("asyncio.wait_for", AsyncMock(side_effect=RuntimeError)):
            await server.stop()
            assert server._run_task is None

    async def test_stop_noop_when_nothing_open(self):
        server = ConcreteLocalServer()
        server._run_task = None
        server._session = None

        await server.stop()
        assert server._run_task is None
        assert server._session is None

    async def test_stop_outer_exception_logged(self):
        server = ConcreteLocalServer()
        
        # Force an unexpected exception to trigger outer except
        server._run_task = "Not a task"
        
        with patch("core.mcp.server.logger") as mock_logger:
            await server.stop()
            mock_logger.error.assert_called_once()
            assert "Error stopping local MCP server" in mock_logger.error.call_args[0][0]


class TestLocalMcpServerGetTools:
    async def test_raises_when_no_session(self):
        server = ConcreteLocalServer()
        with pytest.raises(RuntimeError, match="Server not started"):
            await server.get_tools()

    async def test_converts_to_openai_format(self):
        server = ConcreteLocalServer()
        mock_session = AsyncMock()
        tools = [
            _make_tool("read_file", description="Read a file", input_schema={"type": "object", "properties": {"path": {"type": "string"}}}),
            _make_tool("write_file", description="Write a file", input_schema={"type": "object", "properties": {"path": {"type": "string"}}}),
        ]
        mock_session.list_tools.return_value = _make_tools_result(tools)
        server._session = mock_session

        result = await server.get_tools()
        assert len(result) == 2
        assert result[0] == {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
            },
        }

    async def test_fallback_description_when_none(self):
        server = ConcreteLocalServer()
        mock_session = AsyncMock()
        tools = [_make_tool("my_tool", description=None)]
        mock_session.list_tools.return_value = _make_tools_result(tools)
        server._session = mock_session

        result = await server.get_tools()
        assert result[0]["function"]["description"] == "MCP tool: my_tool"

    async def test_fallback_schema_when_none(self):
        server = ConcreteLocalServer()
        mock_session = AsyncMock()
        tools = [_make_tool("my_tool", description="desc", input_schema=None)]
        mock_session.list_tools.return_value = _make_tools_result(tools)
        server._session = mock_session

        result = await server.get_tools()
        assert result[0]["function"]["parameters"] == {"type": "object", "properties": {}}

    async def test_reraises_on_exception(self):
        server = ConcreteLocalServer()
        mock_session = AsyncMock()
        mock_session.list_tools.side_effect = ConnectionError("broken pipe")
        server._session = mock_session

        with pytest.raises(ConnectionError, match="broken pipe"):
            await server.get_tools()


class TestLocalMcpServerApplyTool:
    async def test_raises_when_no_session(self):
        server = ConcreteLocalServer()
        with pytest.raises(RuntimeError, match="Server not started"):
            await server.apply_tool("test", {})

    async def test_content_list_with_text(self):
        """Content is list of items with .text — concatenated."""
        server = ConcreteLocalServer()
        mock_session = AsyncMock()

        item1 = MagicMock()
        item1.text = "Hello "
        item2 = MagicMock()
        item2.text = "World"
        result = MagicMock()
        result.content = [item1, item2]
        mock_session.call_tool.return_value = result
        server._session = mock_session

        text = await server.apply_tool("greet", {"name": "test"})
        assert text == "Hello World"
        mock_session.call_tool.assert_awaited_once_with("greet", {"name": "test"})

    async def test_content_list_without_text(self):
        """Content is list of items without .text — uses str()."""
        server = ConcreteLocalServer()
        mock_session = AsyncMock()

        item = _make_content_item(text=None)
        result = MagicMock()
        result.content = [item]
        mock_session.call_tool.return_value = result
        server._session = mock_session

        text = await server.apply_tool("tool", {})
        assert text == str(item)

    async def test_content_not_list_with_text(self):
        """Content is single object with .text."""
        server = ConcreteLocalServer()
        mock_session = AsyncMock()

        content = MagicMock()
        content.text = "single result"
        result = MagicMock()
        result.content = content
        mock_session.call_tool.return_value = result
        server._session = mock_session

        text = await server.apply_tool("tool", {})
        assert text == "single result"

    async def test_content_not_list_without_text(self):
        """Content is single object without .text — uses str()."""
        server = ConcreteLocalServer()
        mock_session = AsyncMock()

        content = _make_content_item(text=None)
        result = MagicMock()
        result.content = content
        mock_session.call_tool.return_value = result
        server._session = mock_session

        text = await server.apply_tool("tool", {})
        assert text == str(content)

    async def test_no_content_attribute(self):
        """Result has no .content (or content is falsy) — uses str(result)."""
        server = ConcreteLocalServer()
        mock_session = AsyncMock()

        class BareResult:
            def __str__(self):
                return "raw-result"

        mock_session.call_tool.return_value = BareResult()
        server._session = mock_session

        text = await server.apply_tool("tool", {})
        assert text == "raw-result"

    async def test_empty_content_list(self):
        """Content is empty list — empty string."""
        server = ConcreteLocalServer()
        mock_session = AsyncMock()

        result = MagicMock()
        result.content = []
        mock_session.call_tool.return_value = result
        server._session = mock_session

        # Empty list is falsy, so hits the `else` branch (no content)
        text = await server.apply_tool("tool", {})
        assert text == str(result)

    async def test_exception_raises_runtime_error(self):
        server = ConcreteLocalServer()
        mock_session = AsyncMock()
        mock_session.call_tool.side_effect = ValueError("bad args")
        server._session = mock_session

        with pytest.raises(RuntimeError, match="Tool execution failed"):
            await server.apply_tool("broken", {"x": 1})


# ===========================================================================
# RemoteMcpServer
# ===========================================================================

class TestRemoteMcpServerInit:
    def test_strips_trailing_slash(self):
        server = RemoteMcpServer("https://api.example.com/mcp/")
        assert server.api_endpoint == "https://api.example.com/mcp"

    def test_stores_endpoint(self):
        server = RemoteMcpServer("https://api.example.com/mcp")
        assert server.api_endpoint == "https://api.example.com/mcp"
        assert server._session is None


class TestRemoteMcpServerStart:
    @patch("core.mcp.server.aiohttp.TCPConnector")
    @patch("core.mcp.server.aiohttp.ClientSession")
    @patch("core.mcp.server.ssl.create_default_context")
    async def test_start_creates_session(self, mock_ssl, mock_session_cls, mock_connector):
        server = RemoteMcpServer("https://api.example.com")

        mock_ctx = MagicMock()
        mock_ssl.return_value = mock_ctx
        mock_conn = MagicMock()
        mock_connector.return_value = mock_conn
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        await server.start()

        mock_ssl.assert_called_once()
        assert mock_ctx.check_hostname is False
        mock_connector.assert_called_once_with(ssl=mock_ctx)
        mock_session_cls.assert_called_once_with(connector=mock_conn)
        assert server._session is mock_session

    @patch("core.mcp.server.aiohttp.TCPConnector")
    @patch("core.mcp.server.ssl.create_default_context")
    async def test_start_failure_raises_runtime_error(self, mock_ssl, mock_connector):
        server = RemoteMcpServer("https://api.example.com")
        mock_ssl.side_effect = OSError("SSL fail")

        with pytest.raises(RuntimeError, match="Remote server startup failed"):
            await server.start()


class TestRemoteMcpServerStop:
    async def test_stop_closes_session(self):
        server = RemoteMcpServer("https://api.example.com")
        mock_session = AsyncMock()
        server._session = mock_session

        await server.stop()

        mock_session.close.assert_awaited_once()
        assert server._session is None

    async def test_stop_noop_when_no_session(self):
        server = RemoteMcpServer("https://api.example.com")
        await server.stop()  # No exception

    async def test_stop_handles_exception(self):
        server = RemoteMcpServer("https://api.example.com")
        mock_session = AsyncMock()
        mock_session.close.side_effect = OSError("connection reset")
        server._session = mock_session

        await server.stop()  # Should not raise


class TestRemoteMcpServerGetTools:
    async def test_raises_when_no_session(self):
        server = RemoteMcpServer("https://api.example.com")
        with pytest.raises(RuntimeError, match="Server not started"):
            await server.get_tools()

    async def test_tools_already_openai_format(self):
        server = RemoteMcpServer("https://api.example.com")

        tools_data = {
            "tools": [
                {
                    "type": "function",
                    "function": {"name": "tool1", "description": "desc1", "parameters": {}},
                }
            ]
        }

        # Mock aiohttp response
        mock_response = AsyncMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json = AsyncMock(return_value=tools_data)

        mock_session = MagicMock()
        mock_cm = AsyncMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_response)
        mock_cm.__aexit__ = AsyncMock(return_value=False)
        mock_session.get.return_value = mock_cm
        server._session = mock_session

        result = await server.get_tools()
        assert len(result) == 1
        assert result[0]["function"]["name"] == "tool1"

    async def test_tools_in_mcp_format_converted(self):
        server = RemoteMcpServer("https://api.example.com")

        tools_data = {
            "tools": [
                {
                    "name": "mcp_tool",
                    "description": "An MCP tool",
                    "inputSchema": {"type": "object", "properties": {"x": {"type": "integer"}}},
                }
            ]
        }

        mock_response = AsyncMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json = AsyncMock(return_value=tools_data)

        mock_session = MagicMock()
        mock_cm = AsyncMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_response)
        mock_cm.__aexit__ = AsyncMock(return_value=False)
        mock_session.get.return_value = mock_cm
        server._session = mock_session

        result = await server.get_tools()
        assert len(result) == 1
        assert result[0] == {
            "type": "function",
            "function": {
                "name": "mcp_tool",
                "description": "An MCP tool",
                "parameters": {"type": "object", "properties": {"x": {"type": "integer"}}},
            },
        }

    async def test_tools_mcp_format_fallback_description_and_schema(self):
        """Tool without description or inputSchema gets defaults."""
        server = RemoteMcpServer("https://api.example.com")

        tools_data = {"tools": [{"name": "bare_tool"}]}

        mock_response = AsyncMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json = AsyncMock(return_value=tools_data)

        mock_session = MagicMock()
        mock_cm = AsyncMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_response)
        mock_cm.__aexit__ = AsyncMock(return_value=False)
        mock_session.get.return_value = mock_cm
        server._session = mock_session

        result = await server.get_tools()
        assert result[0]["function"]["description"] == "API tool: bare_tool"
        assert result[0]["function"]["parameters"] == {"type": "object", "properties": {}}

    async def test_get_tools_exception_raises_runtime_error(self):
        server = RemoteMcpServer("https://api.example.com")

        mock_session = MagicMock()
        mock_cm = AsyncMock()
        mock_cm.__aenter__ = AsyncMock(side_effect=ConnectionError("refused"))
        mock_cm.__aexit__ = AsyncMock(return_value=False)
        mock_session.get.return_value = mock_cm
        server._session = mock_session

        with pytest.raises(RuntimeError, match="Failed to fetch tools"):
            await server.get_tools()


class TestRemoteMcpServerApplyTool:
    async def test_raises_when_no_session(self):
        server = RemoteMcpServer("https://api.example.com")
        with pytest.raises(RuntimeError, match="Server not started"):
            await server.apply_tool("tool", {})

    def _setup_mock_session(self, server, response_data):
        """Helper to set up mock aiohttp session with response data."""
        mock_response = AsyncMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json = AsyncMock(return_value=response_data)

        mock_session = MagicMock()
        mock_cm = AsyncMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_response)
        mock_cm.__aexit__ = AsyncMock(return_value=False)
        mock_session.post.return_value = mock_cm
        server._session = mock_session
        return mock_session

    async def test_result_is_string(self):
        server = RemoteMcpServer("https://api.example.com")
        self._setup_mock_session(server, {"result": "hello world"})

        result = await server.apply_tool("echo", {"text": "hello"})
        assert result == "hello world"

    async def test_result_dict_with_content_list_text(self):
        """result is dict with content list of text items."""
        server = RemoteMcpServer("https://api.example.com")
        self._setup_mock_session(server, {
            "result": {
                "content": [
                    {"text": "part1"},
                    {"text": "part2"},
                ]
            }
        })

        result = await server.apply_tool("tool", {})
        assert result == "part1part2"

    async def test_result_dict_with_content_list_non_text(self):
        """result is dict with content list of non-text items — uses str()."""
        server = RemoteMcpServer("https://api.example.com")
        self._setup_mock_session(server, {
            "result": {
                "content": [42, True]
            }
        })

        result = await server.apply_tool("tool", {})
        assert result == "42True"

    async def test_result_dict_with_content_dict_text(self):
        """result is dict with content dict that has text key."""
        server = RemoteMcpServer("https://api.example.com")
        self._setup_mock_session(server, {
            "result": {
                "content": {"text": "single item"}
            }
        })

        result = await server.apply_tool("tool", {})
        assert result == "single item"

    async def test_result_dict_with_content_dict_no_text(self):
        """result is dict with content dict without text key — str()."""
        server = RemoteMcpServer("https://api.example.com")
        self._setup_mock_session(server, {
            "result": {
                "content": {"data": 123}
            }
        })

        result = await server.apply_tool("tool", {})
        assert result == str({"data": 123})

    async def test_result_dict_with_content_string(self):
        """result is dict with content that is a plain string — str()."""
        server = RemoteMcpServer("https://api.example.com")
        self._setup_mock_session(server, {
            "result": {
                "content": "plain string"
            }
        })

        result = await server.apply_tool("tool", {})
        assert result == "plain string"

    async def test_result_dict_without_content(self):
        """result is dict but has no 'content' key — json.dumps."""
        server = RemoteMcpServer("https://api.example.com")
        self._setup_mock_session(server, {
            "result": {"status": "ok", "value": 42}
        })

        result = await server.apply_tool("tool", {})
        assert result == json.dumps({"status": "ok", "value": 42})

    async def test_result_not_string_not_dict(self):
        """result is not string and not dict — str()."""
        server = RemoteMcpServer("https://api.example.com")
        self._setup_mock_session(server, {"result": 12345})

        result = await server.apply_tool("tool", {})
        assert result == "12345"

    async def test_no_result_key(self):
        """Response has no 'result' key — json.dumps entire response."""
        server = RemoteMcpServer("https://api.example.com")
        self._setup_mock_session(server, {"status": "done", "output": "data"})

        result = await server.apply_tool("tool", {})
        assert result == json.dumps({"status": "done", "output": "data"})

    async def test_exception_raises_runtime_error(self):
        server = RemoteMcpServer("https://api.example.com")

        mock_session = MagicMock()
        mock_cm = AsyncMock()
        mock_cm.__aenter__ = AsyncMock(side_effect=ConnectionError("refused"))
        mock_cm.__aexit__ = AsyncMock(return_value=False)
        mock_session.post.return_value = mock_cm
        server._session = mock_session

        with pytest.raises(RuntimeError, match="Remote tool execution failed"):
            await server.apply_tool("tool", {})


# ===========================================================================
# ConfiguredLocalServer
# ===========================================================================

class TestConfiguredLocalServer:
    def test_stores_config(self):
        config = {"command": "npx", "args": ["-y", "mcp-server"], "env": {"KEY": "val"}}
        server = ConfiguredLocalServer(config)
        assert server._config is config

    @patch("core.mcp.server.os.environ", new_callable=dict)
    @patch("core.mcp.server.StdioServerParameters")
    async def test_init_server_creates_params(self, mock_params_cls, mock_environ):
        config = {"command": "npx", "args": ["-y", "mcp-fs"], "env": {"A": "B"}}
        server = ConfiguredLocalServer(config)
        mock_params_cls.return_value = MagicMock()

        result = await server.init_server()

        mock_params_cls.assert_called_once_with(
            command="npx",
            args=["-y", "mcp-fs"],
            env={"A": "B"},
        )
        assert result is mock_params_cls.return_value

    @patch("core.mcp.server.os.environ", new_callable=dict)
    @patch("core.mcp.server.StdioServerParameters")
    async def test_init_server_defaults(self, mock_params_cls, mock_environ):
        """Config without args/env uses defaults."""
        config = {"command": "python"}
        server = ConfiguredLocalServer(config)
        mock_params_cls.return_value = MagicMock()

        await server.init_server()

        mock_params_cls.assert_called_once_with(
            command="python",
            args=[],
            env={},
        )
