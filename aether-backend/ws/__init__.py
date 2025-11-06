"""
WebSocket Layer - Real-time communication for Aether Backend

This module provides production-ready WebSocket infrastructure for real-time
chat streaming, audio streaming, and bidirectional client-server communication.

Components:
- hub.py: WebSocketHub for client lifecycle and message routing
- handlers.py: Message processing and stream relay logic
- protocols.py: Protocol definitions and message schemas

Features:
- Client lifecycle management (register/unregister)
- Message routing (JSON and binary)
- Stream relay with cancellation support
- Broadcasting with timeout protection
- Heartbeat/ping-pong support
- Error handling and auto-cleanup
- Task tracking for generation control
- Audio streaming support

Usage:
    from ws import WebSocketHub
    from core.runtime import RuntimeEngine
    
    # In app.py:
    hub = WebSocketHub(runtime)
    
    @app.websocket("/")
    async def websocket_endpoint(ws: WebSocket):
        await ws.accept()
        client = await hub.register(ws)
        try:
            while True:
                message = await ws.receive()
                if message.get("bytes"):
                    await hub.handle_binary(client, message["bytes"])
                else:
                    await hub.handle_json(client, message.get("text"))
        except WebSocketDisconnect:
            pass
        finally:
            await hub.unregister(client)
"""

from .hub import WebSocketHub, Client
from .handlers import MessageHandler, StreamRelay
from .protocols import (
    MessageType,
    MessageRole,
    ClientMessage,
    AssistantMessage,
    SystemMessage,
    StopMessage,
    HeartbeatMessage,
    validate_message,
)

__all__ = [
    # Client Management
    "WebSocketHub",
    "Client",
    
    # Message Processing
    "MessageHandler",
    "StreamRelay",
    
    # Protocols
    "MessageType",
    "MessageRole",
    "ClientMessage",
    "AssistantMessage",
    "SystemMessage",
    "StopMessage",
    "HeartbeatMessage",
    "validate_message",
]

__version__ = "2.0.0"

