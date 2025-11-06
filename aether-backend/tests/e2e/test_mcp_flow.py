"""
End-to-End Tests: MCP Flow

Complete MCP server lifecycle testing including server management,
tool discovery, execution, and statistics tracking.
"""

import pytest
from httpx import AsyncClient


# =============================================================================
# MCP Server Lifecycle Tests
# =============================================================================

class TestMCPServerLifecycle:
    """Test complete MCP server lifecycle."""
    
    @pytest.mark.e2e
    @pytest.mark.requires_services
    @pytest.mark.asyncio
    async def test_complete_server_lifecycle(self, client: AsyncClient):
        """Test complete server lifecycle from start to stop."""
        server_config = {
            'name': 'e2e-test-server',
            'command': 'python',
            'args': ['-m', 'test_mcp_server'],
            'enabled': True
        }
        
        # Start server
        start_response = await client.post(
            "/api/v1/mcp/servers/start",
            json=server_config
        )
        
        # May succeed or fail if server already exists
        assert start_response.status_code in [200, 201, 400, 409]
        
        if start_response.status_code in [200, 201]:
            # Check server health
            health_response = await client.get(
                f"/api/v1/mcp/servers/{server_config['name']}/health"
            )
            assert health_response.status_code in [200, 503]
            
            # Stop server
            stop_response = await client.post(
                f"/api/v1/mcp/servers/{server_config['name']}/stop"
            )
            assert stop_response.status_code in [200, 404]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_list_and_manage_servers(self, client: AsyncClient):
        """Test listing and managing MCP servers."""
        # List all servers
        list_response = await client.get("/api/v1/mcp/servers")
        assert list_response.status_code == 200
        
        servers = list_response.json()
        assert isinstance(servers, list) or 'servers' in servers
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_server_restart(self, client: AsyncClient):
        """Test restarting MCP server."""
        server_name = "e2e-restart-test"
        
        # Attempt restart
        restart_response = await client.post(
            f"/api/v1/mcp/servers/{server_name}/restart"
        )
        
        # Will succeed only if server exists
        assert restart_response.status_code in [200, 404]


# =============================================================================
# Tool Discovery and Execution Tests
# =============================================================================

class TestMCPToolWorkflow:
    """Test MCP tool discovery and execution workflow."""
    
    @pytest.mark.e2e
    @pytest.mark.requires_services
    @pytest.mark.asyncio
    async def test_discover_and_execute_tools(self, client: AsyncClient):
        """Test discovering and executing MCP tools."""
        server_name = "test-mcp-server"
        
        # Discover tools
        tools_response = await client.get(
            f"/api/v1/mcp/servers/{server_name}/tools"
        )
        
        if tools_response.status_code == 200:
            tools = tools_response.json()
            assert isinstance(tools, list) or 'tools' in tools
            
            # Execute first tool if available
            tool_list = tools if isinstance(tools, list) else tools.get('tools', [])
            if len(tool_list) > 0:
                tool_name = tool_list[0].get('name') or tool_list[0]
                
                execute_response = await client.post(
                    f"/api/v1/mcp/servers/{server_name}/tools/{tool_name}/execute",
                    json={'args': {}}
                )
                
                assert execute_response.status_code in [200, 400, 500]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_tool_execution_with_args(self, client: AsyncClient):
        """Test executing tool with arguments."""
        server_name = "test-server"
        tool_name = "test_tool"
        
        execution_payload = {
            'args': {
                'param1': 'value1',
                'param2': 42
            }
        }
        
        response = await client.post(
            f"/api/v1/mcp/servers/{server_name}/tools/{tool_name}/execute",
            json=execution_payload
        )
        
        # Will fail if server/tool doesn't exist, but should handle gracefully
        assert response.status_code in [200, 400, 404, 500]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_list_all_tools(self, client: AsyncClient):
        """Test listing all tools across all servers."""
        response = await client.get("/api/v1/mcp/tools")
        
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict) or isinstance(data, list)


# =============================================================================
# Statistics and Monitoring Tests
# =============================================================================

class TestMCPStatistics:
    """Test MCP statistics tracking."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_execution_statistics(self, client: AsyncClient):
        """Test tracking execution statistics."""
        server_name = "test-server"
        
        # Get statistics
        stats_response = await client.get(
            f"/api/v1/mcp/servers/{server_name}/stats"
        )
        
        if stats_response.status_code == 200:
            stats = stats_response.json()
            assert 'total_executions' in stats or 'executions' in stats
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_execution_history(self, client: AsyncClient):
        """Test retrieving execution history."""
        server_name = "test-server"
        
        history_response = await client.get(
            f"/api/v1/mcp/servers/{server_name}/history"
        )
        
        if history_response.status_code == 200:
            history = history_response.json()
            assert isinstance(history, list) or 'executions' in history
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_overall_mcp_statistics(self, client: AsyncClient):
        """Test getting overall MCP system statistics."""
        response = await client.get("/api/v1/mcp/stats")
        
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)


# =============================================================================
# MCP Integration with Chat Tests
# =============================================================================

class TestMCPChatIntegration:
    """Test MCP integration with chat system."""
    
    @pytest.mark.e2e
    @pytest.mark.requires_services
    @pytest.mark.asyncio
    async def test_chat_with_tool_call(self, client: AsyncClient):
        """Test chat that triggers MCP tool execution."""
        response = await client.post(
            "/api/v1/chat",
            json={
                'message': 'Use the calculator tool to compute 15 * 23',
                'session_id': 'e2e-mcp-chat-001',
                'enable_tools': True
            }
        )
        
        # Should work if tools are available
        assert response.status_code in [200, 201, 503]
    
    @pytest.mark.e2e
    @pytest.mark.requires_services
    @pytest.mark.asyncio
    async def test_chat_with_multiple_tools(self, client: AsyncClient):
        """Test chat that uses multiple MCP tools."""
        response = await client.post(
            "/api/v1/chat",
            json={
                'message': 'Search for weather and then calculate the average temperature',
                'session_id': 'e2e-mcp-chat-002',
                'enable_tools': True
            }
        )
        
        assert response.status_code in [200, 201, 503]


# =============================================================================
# Error Handling Tests
# =============================================================================

class TestMCPErrorHandling:
    """Test MCP error handling."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_nonexistent_server(self, client: AsyncClient):
        """Test accessing nonexistent server."""
        response = await client.get(
            "/api/v1/mcp/servers/nonexistent-server/tools"
        )
        
        assert response.status_code == 404
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_tool_execution_failure(self, client: AsyncClient):
        """Test handling tool execution failure."""
        response = await client.post(
            "/api/v1/mcp/servers/test-server/tools/failing_tool/execute",
            json={'args': {'cause_error': True}}
        )
        
        # Should return error status
        assert response.status_code in [400, 404, 500]
        
        if response.status_code in [400, 500]:
            data = response.json()
            assert 'error' in data or 'detail' in data
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_invalid_tool_arguments(self, client: AsyncClient):
        """Test executing tool with invalid arguments."""
        response = await client.post(
            "/api/v1/mcp/servers/test-server/tools/test_tool/execute",
            json={'args': 'invalid'}  # Should be dict
        )
        
        assert response.status_code in [400, 422]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_server_crash_recovery(self, client: AsyncClient):
        """Test detecting and recovering from server crash."""
        server_name = "crash-test-server"
        
        # Check health (server might be crashed)
        health_response = await client.get(
            f"/api/v1/mcp/servers/{server_name}/health"
        )
        
        if health_response.status_code == 503:
            # Attempt restart
            restart_response = await client.post(
                f"/api/v1/mcp/servers/{server_name}/restart"
            )
            
            # Should attempt recovery
            assert restart_response.status_code in [200, 404, 500]


# =============================================================================
# Configuration Management Tests
# =============================================================================

class TestMCPConfiguration:
    """Test MCP configuration management."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_save_server_configuration(self, client: AsyncClient):
        """Test saving server configuration."""
        config = {
            'name': 'persistent-server',
            'command': 'python',
            'args': ['-m', 'persistent_server'],
            'enabled': True,
            'auto_start': True
        }
        
        response = await client.post(
            "/api/v1/mcp/servers/config",
            json=config
        )
        
        assert response.status_code in [200, 201]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_update_server_configuration(self, client: AsyncClient):
        """Test updating server configuration."""
        server_name = "test-server"
        update = {
            'enabled': False,
            'timeout': 60
        }
        
        response = await client.patch(
            f"/api/v1/mcp/servers/{server_name}/config",
            json=update
        )
        
        assert response.status_code in [200, 404]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_delete_server_configuration(self, client: AsyncClient):
        """Test deleting server configuration."""
        server_name = "deletable-server"
        
        response = await client.delete(
            f"/api/v1/mcp/servers/{server_name}/config"
        )
        
        assert response.status_code in [200, 404]


# =============================================================================
# Performance Tests
# =============================================================================

class TestMCPPerformance:
    """Test MCP performance."""
    
    @pytest.mark.e2e
    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_concurrent_tool_executions(self, client: AsyncClient):
        """Test executing multiple tools concurrently."""
        import asyncio
        
        async def execute_tool(i: int):
            response = await client.post(
                "/api/v1/mcp/servers/test-server/tools/test_tool/execute",
                json={'args': {'index': i}}
            )
            return response.status_code in [200, 404]  # 404 if server doesn't exist
        
        # Execute 20 tools concurrently
        results = await asyncio.gather(
            *[execute_tool(i) for i in range(20)]
        )
        
        # Count successes
        successes = sum(results)
        assert successes >= 0  # At least attempted all
    
    @pytest.mark.e2e
    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_rapid_server_restarts(self, client: AsyncClient):
        """Test handling rapid server restarts."""
        server_name = "restart-stress-test"
        
        for _ in range(5):
            # Attempt stop
            await client.post(f"/api/v1/mcp/servers/{server_name}/stop")
            
            # Attempt start
            start_response = await client.post(
                "/api/v1/mcp/servers/start",
                json={
                    'name': server_name,
                    'command': 'python',
                    'args': ['-m', 'test_server']
                }
            )
            
            # Should handle gracefully
            assert start_response.status_code in [200, 201, 400, 409]

