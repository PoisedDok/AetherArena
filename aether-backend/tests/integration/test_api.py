"""
Integration Tests: API Endpoints

Tests for all v1 API endpoints including request/response validation,
error handling, and authentication.
"""

import os
import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.skipif(
    os.environ.get("SKIP_SERVICE_HEALTH_CHECK") == "1",
    reason="Requires live infrastructure"
)


# =============================================================================
# Health Endpoint Tests
# =============================================================================

class TestHealthEndpoints:
    """Test health check endpoints."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_health_check(self, client: AsyncClient):
        """Test basic health check."""
        response = await client.get("/v1/health")
        
        assert response.status_code == 200
        data = response.json()
        assert 'status' in data
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_health_detailed(self, client: AsyncClient):
        """Test detailed health check."""
        response = await client.get("/v1/health/detailed")
        
        assert response.status_code == 200
        data = response.json()
        assert 'components' in data


# =============================================================================
# Services & Backends Endpoint Tests
# =============================================================================

class TestServicesAndBackendsEndpoints:
    """Test services and backends status endpoints."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_services_status(self, client: AsyncClient):
        """Test services status aggregation."""
        response = await client.get("/v1/services/status")
        
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data.get("services"), list)
        assert any(s.get("name") == "Aether Backend" for s in data.get("services", []))
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_backends_health_all(self, client: AsyncClient):
        """Test aggregated backend health checks."""
        response = await client.get("/v1/backends/health/all")
        
        assert response.status_code == 200
        data = response.json()
        assert "total_backends" in data
        assert isinstance(data.get("health_checks"), dict)
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_document_health(self, client: AsyncClient):
        """Test Docling health endpoint."""
        response = await client.get("/v1/document/health")
        
        assert response.status_code == 200
        data = response.json()
        assert "healthy" in data or data.get("status") in {"ok", "healthy"}
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_llm_health(self, client: AsyncClient):
        """Test LLM provider health endpoint."""
        response = await client.get("/v1/llm/health")
        
        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert "services" in data
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_mcp_health(self, client: AsyncClient):
        """Test MCP health endpoint."""
        response = await client.get("/v1/mcp/health")
        
        assert response.status_code == 200
        data = response.json()
        assert "status" in data or "healthy" in data
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_files_health(self, client: AsyncClient):
        """Test file indexing health endpoint."""
        response = await client.get("/v1/file/health")
        
        assert response.status_code == 200
        data = response.json()
        assert "service_status" in data


# =============================================================================
# Chat Endpoint Tests
# =============================================================================

class TestChatEndpoints:
    """Test chat API endpoints."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_send_message(self, client: AsyncClient):
        """Test sending chat message."""
        payload = {
            'message': 'Hello, assistant!',
            'session_id': 'test-session-123'
        }
        
        response = await client.post("/v1/create/chat", json=payload)
        
        assert response.status_code in [200, 201]
        data = response.json()
        assert 'response' in data or 'content' in data
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_send_message_with_context(self, client: AsyncClient):
        """Test sending message with conversation context."""
        payload = {
            'message': 'Follow-up question',
            'session_id': 'test-session-123',
            'history': [
                {'role': 'user', 'content': 'Previous message'},
                {'role': 'assistant', 'content': 'Previous response'}
            ]
        }
        
        response = await client.post("/v1/create/chat", json=payload)
        
        assert response.status_code in [200, 201]
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_chat_stream(self, client: AsyncClient):
        """Test streaming chat response."""
        payload = {
            'message': 'Stream this response',
            'session_id': 'test-session-123',
            'stream': True
        }
        
        async with client.stream("POST", "/v1/create/chat/stream", json=payload) as response:
            assert response.status_code == 200
            
            chunks = []
            async for chunk in response.aiter_bytes():
                if chunk:
                    chunks.append(chunk)
            
            assert len(chunks) > 0
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_get_chat_history(self, client: AsyncClient):
        """Test retrieving chat history."""
        session_id = 'test-session-123'
        
        response = await client.get(f"/v1/chat/history/{session_id}")
        
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list) or 'messages' in data


# =============================================================================
# MCP Endpoint Tests
# =============================================================================

class TestMCPEndpoints:
    """Test MCP management API."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_list_servers(self, client: AsyncClient):
        """Test listing MCP servers."""
        response = await client.get("/v1/mcp/servers")
        
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list) or 'servers' in data
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_start_server(self, client: AsyncClient):
        """Test starting MCP server."""
        payload = {
            'name': 'test-mcp-server',
            'command': 'python',
            'args': ['-m', 'test_server']
        }
        
        response = await client.post("/v1/mcp/servers/start", json=payload)
        
        assert response.status_code in [200, 201, 400]  # May fail if server already running
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_list_tools(self, client: AsyncClient):
        """Test listing MCP tools."""
        server_name = "test-server"
        
        response = await client.get(f"/v1/mcp/servers/by-name/{server_name}/tools")
        
        assert response.status_code in [200, 404]  # 404 if server doesn't exist


# =============================================================================
# Models Endpoint Tests
# =============================================================================

class TestModelsEndpoints:
    """Test models management API."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_list_models(self, client: AsyncClient):
        """Test listing available models."""
        response = await client.get("/v1/models")
        
        assert response.status_code in (200, 502) # Accept 502 Bad Gateway if external service isn't running in tests
        if response.status_code == 200:
            data = response.json()
            assert isinstance(data, list) or 'models' in data
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_get_active_model(self, client: AsyncClient):
        """Test getting active model."""
        response = await client.get("/v1/models/active")
        
        assert response.status_code == 200
        data = response.json()
        assert 'model' in data or 'name' in data


# =============================================================================
# Profiles Endpoint Tests
# =============================================================================

class TestProfilesEndpoints:
    """Test profiles management API."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_list_profiles(self, client: AsyncClient):
        """Test listing profiles."""
        response = await client.get("/v1/profiles")
        
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list) or 'profiles' in data
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_get_active_profile(self, client: AsyncClient):
        """Test getting active profile."""
        response = await client.get("/v1/profiles/active")
        
        assert response.status_code == 200
        data = response.json()
        assert 'profile' in data or 'name' in data
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_switch_profile(self, client: AsyncClient):
        """Test switching profile."""
        payload = {'profile': 'GURU.yaml'}
        
        response = await client.post("/v1/profiles/switch", json=payload)
        
        assert response.status_code in [200, 404]  # 404 if profile doesn't exist


# =============================================================================
# Settings Endpoint Tests
# =============================================================================

class TestSettingsEndpoints:
    """Test settings management API."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_get_settings(self, client: AsyncClient):
        """Test retrieving settings."""
        response = await client.get("/v1/settings")
        
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_update_settings(self, client: AsyncClient):
        """Test updating settings."""
        payload = {
            'llm': {
                'temperature': 0.8
            }
        }
        
        response = await client.post("/v1/settings", json=payload)
        
        assert response.status_code in [200, 400]  # May fail validation


# =============================================================================
# Storage Endpoint Tests
# =============================================================================

class TestStorageEndpoints:
    """Test storage management API."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_list_storage(self, client: AsyncClient):
        """Test listing storage items."""
        response = await client.get("/v1/storage/chat/list")
        
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list) or 'items' in data
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_get_storage_stats(self, client: AsyncClient):
        """Test getting storage statistics."""
        response = await client.get("/v1/storage/stats")
        
        assert response.status_code == 200
        data = response.json()
        assert 'total_size' in data or 'size' in data


# =============================================================================
# Error Handling Tests
# =============================================================================

class TestAPIErrorHandling:
    """Test API error handling."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_invalid_endpoint(self, client: AsyncClient):
        """Test accessing invalid endpoint."""
        response = await client.get("/v1/nonexistent")
        
        assert response.status_code == 404
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_invalid_payload(self, client: AsyncClient):
        """Test sending invalid payload."""
        payload = {'invalid': 'data'}
        
        response = await client.post("/v1/create/chat", json=payload)
        
        assert response.status_code in [400, 422]  # Validation error
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_method_not_allowed(self, client: AsyncClient):
        """Test using wrong HTTP method."""
        response = await client.delete("/v1/health")
        
        assert response.status_code == 405
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_large_payload(self, client: AsyncClient):
        """Test sending payload exceeding size limit."""
        large_payload = {
            'message': 'x' * (10 * 1024 * 1024),  # 10MB
            'session_id': 'test'
        }
        
        response = await client.post("/v1/create/chat", json=large_payload)
        
        assert response.status_code in [413, 422]  # Payload too large


# =============================================================================
# Authentication Tests (if enabled)
# =============================================================================

class TestAuthenticationOptional:
    """Test authentication (when enabled)."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_unauthenticated_access(self, client: AsyncClient):
        """Test accessing API without authentication."""
        # In test environment, auth is disabled
        response = await client.get("/v1/health")
        
        assert response.status_code == 200
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_with_auth_header(self, client: AsyncClient):
        """Test accessing API with auth header."""
        headers = {'Authorization': 'Bearer test-token'}
        
        response = await client.get("/v1/health", headers=headers)
        
        # Should work regardless of token in test env
        assert response.status_code == 200

