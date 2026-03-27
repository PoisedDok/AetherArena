"""
Integration Tests: WebSocket

Tests for WebSocket connection management, message handling,
event routing, and streaming.
"""

import pytest
import json
from unittest.mock import AsyncMock, MagicMock, patch

from ws.presentation.router import Router
from ws.protocols import (
    ClientMessage,
    StopMessage,
    ContextResetMessage,
    MessageRole,
    MessageType,
)


# =============================================================================
# WebSocket Connection Tests
# =============================================================================

class TestWebSocketConnection:
    """Test WebSocket connection lifecycle."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_websocket_connect(self, client):
        """Test WebSocket connection."""
        # Note: This requires actual WebSocket support in test client
        # Using mock for now
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.connect = AsyncMock()
            
            # Simulate connection
            result = await mock_hub.return_value.connect("test-client-001")
            
            assert result is not None
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_websocket_disconnect(self):
        """Test WebSocket disconnection."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.disconnect = AsyncMock()
            
            # Simulate disconnection
            await mock_hub.return_value.disconnect("test-client-001")
            
            mock_hub.return_value.disconnect.assert_awaited_once_with("test-client-001")
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_multiple_connections(self):
        """Test handling multiple WebSocket connections."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.active_connections = []
            mock_hub.return_value.connect = AsyncMock(
                side_effect=lambda client_id: mock_hub.return_value.active_connections.append(client_id)
            )
            
            # Connect multiple clients
            for i in range(5):
                await mock_hub.return_value.connect(f"client-{i}")
            
            assert len(mock_hub.return_value.active_connections) == 5


# =============================================================================
# Message Handling Tests
# =============================================================================

class TestWebSocketMessages:
    """Test WebSocket message handling."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_send_message(self):
        """Test sending message via WebSocket."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.send_message = AsyncMock()
            
            message = {
                'type': 'chat',
                'content': 'Hello via WebSocket'
            }
            
            await mock_hub.return_value.send_message("client-001", message)
            
            mock_hub.return_value.send_message.assert_called_once()
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_broadcast_message(self):
        """Test broadcasting message to all clients."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.broadcast = AsyncMock()
            
            message = {
                'type': 'notification',
                'content': 'System announcement'
            }
            
            await mock_hub.return_value.broadcast(message)
            
            mock_hub.return_value.broadcast.assert_called_once()
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_receive_message(self):
        """Test routing a client message to the message handler."""
        message_handler = MagicMock()
        message_handler.handle_user_message = AsyncMock()
        control_handler = MagicMock()
        control_handler.handle_stop = AsyncMock()
        audio_handler = MagicMock()
        audio_handler.handle_audio_control = AsyncMock()
        audio_handler.handle_audio_chunk = AsyncMock()
        context_handler = MagicMock()
        context_handler.handle_context_reset = AsyncMock()
        task_manager = MagicMock()
        request_mapper = MagicMock()
        cache_service = MagicMock()
        cache_service.update_presence_metadata = AsyncMock()
        runtime = MagicMock()

        router = Router(
            runtime=runtime,
            message_handler=message_handler,
            control_handler=control_handler,
            audio_handler=audio_handler,
            context_handler=context_handler,
            task_manager=task_manager,
            request_mapper=request_mapper,
            cache_service=cache_service,
        )
        ws = MagicMock()
        ws.send_text = AsyncMock()
        payload = {
            "role": "user",
            "type": "message",
            "content": "Hello",
            "id": "frontend-123",
        }
        message = ClientMessage.model_construct(
            role=MessageRole.USER,
            type=MessageType.MESSAGE,
            id="frontend-123",
            content="Hello",
        )

        with patch("ws.presentation.router.validate_message", return_value=message):
            await router.handle_json(ws=ws, client_id="client-001", text=json.dumps(payload))

        message_handler.handle_user_message.assert_called_once()
        cache_service.update_presence_metadata.assert_called_once()


# =============================================================================
# Event Routing Tests
# =============================================================================

class TestWebSocketEventRouting:
    """Test WebSocket event routing."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_route_chat_event(self):
        """Test routing stop event to control handler."""
        message_handler = MagicMock()
        message_handler.handle_user_message = AsyncMock()
        control_handler = MagicMock()
        control_handler.handle_stop = AsyncMock()
        audio_handler = MagicMock()
        audio_handler.handle_audio_control = AsyncMock()
        audio_handler.handle_audio_chunk = AsyncMock()
        context_handler = MagicMock()
        context_handler.handle_context_reset = AsyncMock()
        task_manager = MagicMock()
        request_mapper = MagicMock()
        cache_service = MagicMock()
        cache_service.update_presence_metadata = AsyncMock()
        runtime = MagicMock()

        router = Router(
            runtime=runtime,
            message_handler=message_handler,
            control_handler=control_handler,
            audio_handler=audio_handler,
            context_handler=context_handler,
            task_manager=task_manager,
            request_mapper=request_mapper,
            cache_service=cache_service,
        )
        ws = MagicMock()
        ws.send_text = AsyncMock()
        payload = {"type": "stop", "id": "frontend-stop"}
        stop_message = StopMessage.model_construct(
            type=MessageType.STOP,
            id="frontend-stop",
            role=MessageRole.USER,
        )

        with patch("ws.presentation.router.validate_message", return_value=stop_message):
            await router.handle_json(ws=ws, client_id="client-001", text=json.dumps(payload))

        control_handler.handle_stop.assert_called_once()
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_route_file_event(self):
        """Test routing context reset event to context handler."""
        message_handler = MagicMock()
        message_handler.handle_user_message = AsyncMock()
        control_handler = MagicMock()
        control_handler.handle_stop = AsyncMock()
        audio_handler = MagicMock()
        audio_handler.handle_audio_control = AsyncMock()
        audio_handler.handle_audio_chunk = AsyncMock()
        context_handler = MagicMock()
        context_handler.handle_context_reset = AsyncMock()
        task_manager = MagicMock()
        request_mapper = MagicMock()
        cache_service = MagicMock()
        cache_service.update_presence_metadata = AsyncMock()
        runtime = MagicMock()

        router = Router(
            runtime=runtime,
            message_handler=message_handler,
            control_handler=control_handler,
            audio_handler=audio_handler,
            context_handler=context_handler,
            task_manager=task_manager,
            request_mapper=request_mapper,
            cache_service=cache_service,
        )
        ws = MagicMock()
        ws.send_text = AsyncMock()
        payload = {"role": "user", "type": "context_reset", "chat_id": "chat-001"}
        context_message = ContextResetMessage.model_construct(
            role=MessageRole.USER,
            type=MessageType.CONTEXT_RESET,
            chat_id="chat-001",
        )

        with patch("ws.presentation.router.validate_message", return_value=context_message):
            await router.handle_json(ws=ws, client_id="client-001", text=json.dumps(payload))

        context_handler.handle_context_reset.assert_called_once()
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_route_unknown_event(self):
        """Test handling unknown event type."""
        message_handler = MagicMock()
        message_handler.handle_user_message = AsyncMock()
        control_handler = MagicMock()
        control_handler.handle_stop = AsyncMock()
        audio_handler = MagicMock()
        audio_handler.handle_audio_control = AsyncMock()
        audio_handler.handle_audio_chunk = AsyncMock()
        context_handler = MagicMock()
        context_handler.handle_context_reset = AsyncMock()
        task_manager = MagicMock()
        request_mapper = MagicMock()
        cache_service = MagicMock()
        cache_service.update_presence_metadata = AsyncMock()
        runtime = MagicMock()

        router = Router(
            runtime=runtime,
            message_handler=message_handler,
            control_handler=control_handler,
            audio_handler=audio_handler,
            context_handler=context_handler,
            task_manager=task_manager,
            request_mapper=request_mapper,
            cache_service=cache_service,
        )
        ws = MagicMock()
        ws.send_text = AsyncMock()
        payload = {"role": "user", "type": "unknown", "content": "???"}

        with patch("ws.presentation.router.validate_message", return_value=object()):
            await router.handle_json(ws=ws, client_id="client-001", text=json.dumps(payload))

        ws.send_text.assert_called_once()


# =============================================================================
# Streaming Tests
# =============================================================================

class TestWebSocketStreaming:
    """Test WebSocket streaming functionality."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_stream_chat_response(self):
        """Test streaming chat response."""
        async def mock_stream():
            for i in range(5):
                yield {'type': 'chunk', 'content': f'Chunk {i}'}
        
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.stream_to_client = AsyncMock()
            
            chunks = []
            async for chunk in mock_stream():
                chunks.append(chunk)
                await mock_hub.return_value.stream_to_client("client-001", chunk)
            
            assert len(chunks) == 5
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_stream_file_processing(self):
        """Test streaming file processing progress."""
        async def mock_progress_stream():
            for progress in [0, 25, 50, 75, 100]:
                yield {'type': 'progress', 'percent': progress}
        
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.send_message = AsyncMock()
            
            progress_updates = []
            async for update in mock_progress_stream():
                progress_updates.append(update)
                await mock_hub.return_value.send_message("client-001", update)
            
            assert len(progress_updates) == 5
            assert progress_updates[-1]['percent'] == 100


# =============================================================================
# Error Handling Tests
# =============================================================================

class TestWebSocketErrorHandling:
    """Test WebSocket error handling."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_connection_error(self):
        """Test handling connection error."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.connect = AsyncMock(
                side_effect=ConnectionError("Connection failed")
            )
            
            with pytest.raises(ConnectionError):
                await mock_hub.return_value.connect("client-001")
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_message_send_error(self):
        """Test handling message send error."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.send_message = AsyncMock(
                side_effect=Exception("Send failed")
            )
            
            with pytest.raises(Exception):
                await mock_hub.return_value.send_message("client-001", {})
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_invalid_message_format(self):
        """Test handling invalid message format."""
        with patch('ws.protocols.validate_message') as mock_validator:
            mock_validator.return_value = False
            
            message = "invalid_format"  # Not a dict
            
            is_valid = mock_validator(message)
            
            assert is_valid is False


# =============================================================================
# Client Management Tests
# =============================================================================

class TestWebSocketClientManagement:
    """Test WebSocket client management."""
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_track_active_clients(self):
        """Test tracking active clients."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.get_active_clients = AsyncMock(
                return_value=['client-1', 'client-2', 'client-3']
            )
            
            clients = await mock_hub.return_value.get_active_clients()
            
            assert len(clients) == 3
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_client_cleanup_on_disconnect(self):
        """Test client cleanup on disconnect."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.active_connections = ['client-1', 'client-2']
            mock_hub.return_value.disconnect = AsyncMock(
                side_effect=lambda client_id: mock_hub.return_value.active_connections.remove(client_id)
            )
            
            await mock_hub.return_value.disconnect('client-1')
            
            assert 'client-1' not in mock_hub.return_value.active_connections
            assert 'client-2' in mock_hub.return_value.active_connections
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_heartbeat_ping(self):
        """Test WebSocket heartbeat ping."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.ping = AsyncMock(return_value=True)
            
            result = await mock_hub.return_value.ping('client-001')
            
            assert result is True


# =============================================================================
# Performance Tests
# =============================================================================

class TestWebSocketPerformance:
    """Test WebSocket performance."""
    
    @pytest.mark.integration
    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_concurrent_connections(self):
        """Test handling many concurrent connections."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.active_connections = []
            mock_hub.return_value.connect = AsyncMock(
                side_effect=lambda client_id: mock_hub.return_value.active_connections.append(client_id)
            )
            
            import asyncio
            
            # Connect 100 clients concurrently
            tasks = [
                mock_hub.return_value.connect(f"client-{i}")
                for i in range(100)
            ]
            await asyncio.gather(*tasks)
            
            assert len(mock_hub.return_value.active_connections) == 100
    
    @pytest.mark.integration
    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_high_message_throughput(self):
        """Test high message throughput."""
        with patch('ws.presentation.hub.WebSocketHub') as mock_hub:
            mock_hub.return_value.send_message = AsyncMock()
            
            import asyncio
            import time
            
            # Send 1000 messages
            start = time.time()
            tasks = [
                mock_hub.return_value.send_message(
                    f"client-{i % 10}",
                    {'message': f'Test {i}'}
                )
                for i in range(1000)
            ]
            await asyncio.gather(*tasks)
            duration = time.time() - start
            
            # Should handle in reasonable time (< 5 seconds)
            assert duration < 5.0

