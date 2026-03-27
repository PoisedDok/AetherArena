"""
Incoming: aether-backend/app.py::websocket_endpoint --- {WebSocket, ws_connection}
Processing: register clients, route messages, orchestrate streaming, emit lifecycle events --- {4 jobs: JOB_CANCEL_STREAM, JOB_LOG, JOB_ORCHESTRATE, JOB_WEBSOCKET_SEND}
Outgoing: frontend WebSocket clients; core/runtime/streaming.py::ChatStreamer --- {Dict[str, Any], json}

WebSocket Layer - Clean Architecture Implementation

This module provides production-ready WebSocket infrastructure with clean architecture:
- Domain layer: Pure business logic (event enrichment, artifact detection, commands)
- Application layer: Service orchestration (stream orchestrator, trail coordinator)
- Presentation layer: Message routing, handlers, and emitters
- Infrastructure layer: Cache and persistence adapters

Components:
- factory.py: Dependency injection factory (create_websocket_hub)
- presentation/hub.py: WebSocketHub for client lifecycle
- presentation/router.py: Message routing
- application/stream_orchestrator.py: Stream orchestration (yields commands)
- application/trail_coordinator.py: Trail hierarchy coordination
- application/session_builder.py: Session map generation
- domain/: Pure domain logic (builders, services, commands, validators)
- protocols.py: Protocol definitions and message schemas

Architecture:
- Clean 4-layer architecture (Domain → Application → Presentation → Infrastructure)
- NO WebSocket in application layer (commands pattern)
- NO business logic in presentation layer (pure routing/emission)
- Thread-safe task management
- Proper dependency injection

Usage:
    from ws.factory import create_websocket_hub
    
    # In app.py:
    hub = create_websocket_hub(
        runtime=runtime_engine,
        cache_client=redis_client,
        database_gateway=db_gateway,
        history_service=history_service,
    )
    
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

# Clean architecture exports (refactored implementation)
from ws.factory import create_websocket_hub
from ws.presentation.hub import WebSocketHub, Client
from ws.presentation.router import Router
from ws.application.stream_orchestrator import StreamOrchestrator
from ws.application.trail_coordinator import TrailCoordinator
from ws.domain.event_builder import StreamEventBuilder
from ws.protocols import (
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
    # Factory (primary entry point)
    "create_websocket_hub",
    
    # Client Management
    "WebSocketHub",
    "Client",
    
    # Application Layer
    "StreamOrchestrator",
    "TrailCoordinator",
    
    # Domain Layer
    "StreamEventBuilder",
    
    # Presentation Layer
    "Router",
    
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

__version__ = "4.0.0"

