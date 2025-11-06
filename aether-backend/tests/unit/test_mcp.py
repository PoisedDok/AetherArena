"""
Unit Tests: MCP System

Tests for MCP server management, tool execution, database persistence,
and sandbox operations.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path

from core.mcp.server import McpServer
from core.mcp.manager import MCPServerManager
from core.mcp.database import MCPDatabase
from core.mcp.sandbox import MCPSandbox


# =============================================================================
# MCP Server Tests
# =============================================================================

class TestMCPServer:
    """Test MCPServer abstraction."""
    
    @pytest.fixture
    def server_config(self):
        """Create test server configuration."""
        return {
            'name': 'test-server',
            'command': 'python',
            'args': ['-m', 'test_mcp_server'],
            'env': {},
            'timeout': 30
        }
    
    @pytest.mark.asyncio
    async def test_server_initialization(self, server_config):
        """Test server initialization."""
        server = MCPServer(config=server_config)
        
        assert server.name == 'test-server'
        assert server.command == 'python'
        assert server.status == 'stopped'
    
    @pytest.mark.asyncio
    async def test_server_start(self, server_config):
        """Test server start."""
        with patch('core.mcp.server.asyncio.create_subprocess_exec') as mock_proc:
            mock_proc.return_value = MagicMock(
                pid=12345,
                returncode=None
            )
            
            server = MCPServer(config=server_config)
            await server.start()
            
            assert server.status == 'running'
            assert server.process is not None
    
    @pytest.mark.asyncio
    async def test_server_stop(self, server_config):
        """Test server stop."""
        server = MCPServer(config=server_config)
        
        with patch.object(server, 'process', MagicMock(terminate=MagicMock())):
            await server.stop()
            
            assert server.status == 'stopped'
    
    @pytest.mark.asyncio
    async def test_server_health_check(self, server_config):
        """Test server health check."""
        server = MCPServer(config=server_config)
        server.status = 'running'
        server.process = MagicMock(returncode=None)
        
        health = await server.health_check()
        assert health is True
    
    @pytest.mark.asyncio
    async def test_server_communication(self, server_config):
        """Test server communication."""
        server = MCPServer(config=server_config)
        
        with patch.object(server, '_send_message', new_callable=AsyncMock) as mock_send:
            mock_send.return_value = {'result': 'success'}
            
            response = await server.send_request({'method': 'test'})
            
            assert response['result'] == 'success'


# =============================================================================
# MCP Manager Tests
# =============================================================================

class TestMCPServerManager:
    """Test MCPServerManager functionality."""
    
    @pytest.fixture
    def manager(self):
        """Create MCP manager."""
        return MCPServerManager()
    
    @pytest.mark.asyncio
    async def test_manager_initialization(self, manager):
        """Test manager initialization."""
        assert manager is not None
        assert hasattr(manager, 'servers')
        assert hasattr(manager, 'start_server')
    
    @pytest.mark.asyncio
    async def test_list_servers(self, manager):
        """Test listing servers."""
        servers = await manager.list_servers()
        
        assert isinstance(servers, list)
    
    @pytest.mark.asyncio
    async def test_start_server(self, manager, mcp_server_factory):
        """Test starting a server."""
        config = mcp_server_factory(name="test-server")
        
        with patch.object(manager, '_create_server') as mock_create:
            mock_server = MagicMock(spec=MCPServer)
            mock_server.start = AsyncMock()
            mock_create.return_value = mock_server
            
            await manager.start_server(config)
            
            mock_server.start.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_stop_server(self, manager):
        """Test stopping a server."""
        server_name = "test-server"
        
        mock_server = MagicMock(spec=MCPServer)
        mock_server.stop = AsyncMock()
        manager.servers[server_name] = mock_server
        
        await manager.stop_server(server_name)
        
        mock_server.stop.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_discover_tools(self, manager):
        """Test tool discovery."""
        server_name = "test-server"
        
        mock_server = MagicMock(spec=MCPServer)
        mock_server.list_tools = AsyncMock(return_value=['tool1', 'tool2'])
        manager.servers[server_name] = mock_server
        
        tools = await manager.discover_tools(server_name)
        
        assert len(tools) == 2
        assert 'tool1' in tools
    
    @pytest.mark.asyncio
    async def test_execute_tool(self, manager):
        """Test tool execution."""
        server_name = "test-server"
        tool_name = "test_tool"
        
        mock_server = MagicMock(spec=MCPServer)
        mock_server.call_tool = AsyncMock(return_value={'result': 'success'})
        manager.servers[server_name] = mock_server
        
        result = await manager.execute_tool(
            server_name,
            tool_name,
            args={'param': 'value'}
        )
        
        assert result['result'] == 'success'
    
    @pytest.mark.asyncio
    async def test_health_monitoring(self, manager):
        """Test health monitoring."""
        server_name = "test-server"
        
        mock_server = MagicMock(spec=MCPServer)
        mock_server.health_check = AsyncMock(return_value=True)
        mock_server.name = server_name
        manager.servers[server_name] = mock_server
        
        health_status = await manager.check_all_health()
        
        assert server_name in health_status
        assert health_status[server_name] is True


# =============================================================================
# MCP Database Tests
# =============================================================================

class TestMCPDatabase:
    """Test MCPDatabase persistence."""
    
    @pytest.fixture
    async def mcp_db(self, db_session):
        """Create MCP database instance."""
        return MCPDatabase(session=db_session)
    
    @pytest.mark.asyncio
    async def test_save_server(self, mcp_db):
        """Test saving server configuration."""
        server_data = {
            'name': 'test-server',
            'command': 'python',
            'args': ['-m', 'test_mcp_server'],
            'enabled': True
        }
        
        saved = await mcp_db.save_server(server_data)
        
        assert saved is not None
        assert saved['name'] == 'test-server'
    
    @pytest.mark.asyncio
    async def test_get_server(self, mcp_db):
        """Test retrieving server configuration."""
        # First save a server
        server_data = {
            'name': 'test-server',
            'command': 'python',
            'enabled': True
        }
        await mcp_db.save_server(server_data)
        
        # Then retrieve it
        server = await mcp_db.get_server('test-server')
        
        assert server is not None
        assert server['name'] == 'test-server'
    
    @pytest.mark.asyncio
    async def test_list_servers(self, mcp_db):
        """Test listing all servers."""
        # Save multiple servers
        for i in range(3):
            await mcp_db.save_server({
                'name': f'server-{i}',
                'command': 'python',
                'enabled': True
            })
        
        servers = await mcp_db.list_servers()
        
        assert len(servers) >= 3
    
    @pytest.mark.asyncio
    async def test_delete_server(self, mcp_db):
        """Test deleting server."""
        server_data = {
            'name': 'test-server',
            'command': 'python',
            'enabled': True
        }
        await mcp_db.save_server(server_data)
        
        await mcp_db.delete_server('test-server')
        
        server = await mcp_db.get_server('test-server')
        assert server is None
    
    @pytest.mark.asyncio
    async def test_track_execution(self, mcp_db):
        """Test tracking tool execution."""
        execution_data = {
            'server_name': 'test-server',
            'tool_name': 'test_tool',
            'args': {'param': 'value'},
            'result': {'status': 'success'},
            'duration_ms': 150
        }
        
        tracked = await mcp_db.track_execution(execution_data)
        
        assert tracked is not None
        assert tracked['server_name'] == 'test-server'
    
    @pytest.mark.asyncio
    async def test_get_statistics(self, mcp_db):
        """Test getting execution statistics."""
        # Track some executions
        for i in range(5):
            await mcp_db.track_execution({
                'server_name': 'test-server',
                'tool_name': 'test_tool',
                'duration_ms': 100 + i * 10
            })
        
        stats = await mcp_db.get_statistics('test-server')
        
        assert stats is not None
        assert stats['total_executions'] >= 5


# =============================================================================
# Sandbox Executor Tests
# =============================================================================

class TestSandboxExecutor:
    """Test SandboxExecutor for secure execution."""
    
    @pytest.fixture
    def sandbox(self):
        """Create sandbox executor."""
        return SandboxExecutor()
    
    @pytest.mark.asyncio
    async def test_execute_in_sandbox(self, sandbox):
        """Test executing code in sandbox."""
        code = "print('Hello from sandbox')"
        
        result = await sandbox.execute(code)
        
        assert result is not None
        assert 'output' in result or 'result' in result
    
    @pytest.mark.asyncio
    async def test_sandbox_timeout(self, sandbox):
        """Test sandbox timeout enforcement."""
        # Code that would run forever
        code = "while True: pass"
        
        with pytest.raises(TimeoutError):
            await sandbox.execute(code, timeout=1)
    
    @pytest.mark.asyncio
    async def test_sandbox_resource_limits(self, sandbox):
        """Test resource limit enforcement."""
        # Code that tries to use too much memory
        code = "data = 'x' * (1024 * 1024 * 1024)  # 1GB string"
        
        with pytest.raises((MemoryError, Exception)):
            await sandbox.execute(code, max_memory_mb=100)
    
    @pytest.mark.asyncio
    async def test_sandbox_isolation(self, sandbox):
        """Test sandbox isolation."""
        # Code that tries to access filesystem
        code = "open('/etc/passwd', 'r').read()"
        
        result = await sandbox.execute(code)
        
        # Should either deny access or raise error
        assert 'error' in result or result.get('status') == 'error'
    
    @pytest.mark.asyncio
    async def test_sandbox_safe_execution(self, sandbox):
        """Test safe code execution."""
        code = """
result = 2 + 2
print(f"Result: {result}")
"""
        
        result = await sandbox.execute(code)
        
        assert result is not None
        assert result.get('status') != 'error'


# =============================================================================
# MCP Integration Tests
# =============================================================================

class TestMCPIntegration:
    """Test MCP system integration."""
    
    @pytest.mark.asyncio
    async def test_server_lifecycle(self, mcp_server_factory):
        """Test complete server lifecycle."""
        config = mcp_server_factory(name="lifecycle-test")
        
        manager = MCPServerManager()
        
        # Start server
        with patch.object(manager, '_create_server') as mock_create:
            mock_server = MagicMock(spec=MCPServer)
            mock_server.start = AsyncMock()
            mock_server.stop = AsyncMock()
            mock_server.health_check = AsyncMock(return_value=True)
            mock_create.return_value = mock_server
            
            await manager.start_server(config)
            
            # Check health
            health = await manager.check_server_health(config['name'])
            assert health is True
            
            # Stop server
            await manager.stop_server(config['name'])
    
    @pytest.mark.asyncio
    async def test_tool_discovery_and_execution(self):
        """Test tool discovery and execution flow."""
        manager = MCPServerManager()
        server_name = "test-server"
        
        mock_server = MagicMock(spec=MCPServer)
        mock_server.list_tools = AsyncMock(return_value=[
            {'name': 'tool1', 'description': 'Test tool 1'},
            {'name': 'tool2', 'description': 'Test tool 2'}
        ])
        mock_server.call_tool = AsyncMock(return_value={'result': 'success'})
        manager.servers[server_name] = mock_server
        
        # Discover tools
        tools = await manager.discover_tools(server_name)
        assert len(tools) == 2
        
        # Execute tool
        result = await manager.execute_tool(server_name, 'tool1', {})
        assert result['result'] == 'success'
    
    @pytest.mark.asyncio
    async def test_persistence_and_recovery(self, db_session):
        """Test server configuration persistence and recovery."""
        mcp_db = MCPDatabase(session=db_session)
        
        # Save server config
        config = {
            'name': 'persistent-server',
            'command': 'python',
            'args': ['-m', 'server'],
            'enabled': True
        }
        await mcp_db.save_server(config)
        
        # Simulate restart - recover config
        recovered = await mcp_db.get_server('persistent-server')
        
        assert recovered is not None
        assert recovered['name'] == 'persistent-server'
        assert recovered['command'] == 'python'


# =============================================================================
# MCP Error Handling Tests
# =============================================================================

class TestMCPErrorHandling:
    """Test MCP error handling."""
    
    @pytest.mark.asyncio
    async def test_server_start_failure(self, mcp_server_factory):
        """Test handling of server start failure."""
        config = mcp_server_factory(name="fail-server")
        
        with patch('core.mcp.server.asyncio.create_subprocess_exec') as mock_proc:
            mock_proc.side_effect = Exception("Failed to start")
            
            server = MCPServer(config=config)
            
            with pytest.raises(Exception):
                await server.start()
    
    @pytest.mark.asyncio
    async def test_tool_execution_error(self):
        """Test handling of tool execution error."""
        manager = MCPServerManager()
        server_name = "test-server"
        
        mock_server = MagicMock(spec=MCPServer)
        mock_server.call_tool = AsyncMock(side_effect=Exception("Tool error"))
        manager.servers[server_name] = mock_server
        
        with pytest.raises(Exception):
            await manager.execute_tool(server_name, 'failing_tool', {})
    
    @pytest.mark.asyncio
    async def test_server_crash_detection(self):
        """Test detection of crashed server."""
        manager = MCPServerManager()
        server_name = "test-server"
        
        mock_server = MagicMock(spec=MCPServer)
        mock_server.process = MagicMock(returncode=-1)  # Crashed
        mock_server.health_check = AsyncMock(return_value=False)
        manager.servers[server_name] = mock_server
        
        health = await manager.check_server_health(server_name)
        
        assert health is False

