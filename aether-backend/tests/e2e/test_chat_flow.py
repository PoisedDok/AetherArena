"""
End-to-End Tests: Chat Flow

Complete chat workflow testing from chat initiation
through multi-turn interactions, streaming, and integration fallbacks.
"""

import pytest
from httpx import AsyncClient


# =============================================================================
# Complete Chat Workflow Tests
# =============================================================================

class TestCompleteChatFlow:
    """Test complete chat flow end-to-end."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_basic_chat_interaction(self, client: AsyncClient):
        """Test basic chat interaction."""
        # Send initial message
        response = await client.post(
            "/v1/create/chat",
            json={
                'message': 'Hello, assistant! How can you help me?',
                'session_id': 'e2e-test-001'
            }
        )
        
        assert response.status_code in [200, 201]
        data = response.json()
        assert 'response' in data or 'content' in data
        
        # Send follow-up message
        follow_up = await client.post(
            "/v1/create/chat",
            json={
                'message': 'Can you explain more?',
                'session_id': 'e2e-test-001'
            }
        )
        
        assert follow_up.status_code in [200, 201]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_streaming_chat_flow(self, client: AsyncClient):
        """Test streaming chat response."""
        payload = {
            'message': 'Tell me a story about AI',
            'session_id': 'e2e-test-003',
            'stream': True
        }
        
        async with client.stream("POST", "/v1/create/chat/stream", json=payload) as response:
            assert response.status_code == 200
            
            chunks = []
            async for chunk in response.aiter_bytes():
                if chunk:
                    chunks.append(chunk)
            
            assert len(chunks) > 0
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_multi_turn_conversation(self, client: AsyncClient):
        """Test multi-turn conversation."""
        session_id = 'e2e-test-004'
        
        # Turn 1
        response1 = await client.post(
            "/v1/create/chat",
            json={
                'message': 'What is 2 + 2?',
                'session_id': session_id
            }
        )
        assert response1.status_code in [200, 201]
        
        # Turn 2
        response2 = await client.post(
            "/v1/create/chat",
            json={
                'message': 'What about 3 + 3?',
                'session_id': session_id
            }
        )
        assert response2.status_code in [200, 201]
        
        # Turn 3
        response3 = await client.post(
            "/v1/create/chat",
            json={
                'message': 'Can you summarize what we discussed?',
                'session_id': session_id
            }
        )
        assert response3.status_code in [200, 201]
        
        # Get full history
        history_response = await client.get(f"/v1/chat/history/{session_id}")
        assert history_response.status_code == 200
        
        history = history_response.json()
        assert isinstance(history, list) or 'messages' in history


# =============================================================================
# Error Scenario Tests
# =============================================================================

class TestErrorScenarios:
    """Test error handling in complete workflows."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_malformed_chat_request(self, client: AsyncClient):
        """Test handling malformed chat request."""
        response = await client.post(
            "/v1/create/chat",
            json={
                # Missing required fields
                'invalid_field': 'value'
            }
        )
        
        assert response.status_code in [400, 422]


# =============================================================================
# Integration Workflow Tests
# =============================================================================

class TestIntegrationWorkflows:
    """Test workflows involving external integrations."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_chat_with_search(self, client: AsyncClient):
        """Test chat with search integration."""
        response = await client.post(
            "/v1/create/chat",
            json={
                'message': 'Search for information about quantum computing',
                'session_id': 'e2e-integration-001',
                'use_search': True
            }
        )
        
        # In test environment, search may be mocked
        assert response.status_code in [200, 201, 503]  # 503 if service unavailable
    

# =============================================================================
# Performance Tests
# =============================================================================

class TestPerformanceWorkflows:
    """Test performance of complete workflows."""
    
    @pytest.mark.e2e
    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_concurrent_chat_sessions(self, client: AsyncClient):
        """Test multiple concurrent chat sessions."""
        import asyncio
        
        async def chat_session(session_id: str):
            response = await client.post(
                "/v1/create/chat",
                json={
                    'message': f'Hello from session {session_id}',
                    'session_id': session_id
                }
            )
            return response.status_code in [200, 201]
        
        # Run 10 concurrent sessions
        results = await asyncio.gather(
            *[chat_session(f'e2e-perf-{i}') for i in range(10)]
        )
        
        # All should succeed
        assert all(results)
    

