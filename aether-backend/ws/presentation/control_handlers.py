"""
@.architecture
Incoming: ws/presentation/message_router.py::MessageRouter; frontend WebSocket clients --- {Dict[str, Any], json}
Processing: handle control messages, validate payloads, emit acknowledgments, update presence/cache --- {5 jobs: JOB_CACHE_READ, JOB_CACHE_WRITE, JOB_ORCHESTRATE, JOB_VALIDATE_SCHEMA, JOB_WEBSOCKET_SEND}
Outgoing: core/runtime/engine.py::RuntimeEngine; frontend WebSocket clients --- {Dict[str, Any], json}

Control Message Handlers - Control message processing and acknowledgments

This module provides handlers for WebSocket control messages:
- Heartbeat/ping-pong for connection keepalive
- Stop/cancel for generation control
- Context reset for chat switching
- Audio control for audio streaming

Architecture:
- Presentation layer (no business logic, no database access)
- Pure message handling and acknowledgment
- Delegates to runtime for execution control
"""

import asyncio
import json
import logging
from typing import Any, Dict, Optional, TYPE_CHECKING
from uuid import UUID

from fastapi import WebSocket

from ws.protocols import (
    MessageType,
    MessageRole,
    HeartbeatMessage,
    StopMessage,
    ContextResetMessage,
    AudioControlMessage,
)

if TYPE_CHECKING:
    from application.chat import ChatHistoryService

logger = logging.getLogger(__name__)


async def handle_heartbeat(
    ws: WebSocket,
    client_id: str,
    message: HeartbeatMessage,
    presence_callback: Optional[Any] = None,
) -> None:
    """
    Handle heartbeat/ping message.
    
    Args:
        ws: WebSocket connection
        client_id: Client identifier
        message: Heartbeat message
        presence_callback: Optional presence update callback
    """
    try:
        if presence_callback:
            await presence_callback(client_id, last_event="heartbeat")
        
        response = {
            "type": MessageType.PONG,
            "timestamp": message.timestamp,
        }
        await ws.send_text(json.dumps(response))
    except (RuntimeError, OSError, ConnectionError) as e:
        logger.debug("Failed to send pong: %s", e)


async def handle_audio_control(
    client_id: str,
    message: AudioControlMessage,
    runtime: Any,
    presence_callback: Optional[Any] = None,
) -> None:
    """
    Handle audio stream control.
    
    Args:
        client_id: Client identifier
        message: Audio control message
        runtime: RuntimeEngine instance
        presence_callback: Optional presence update callback
    """
    try:
        state = "audio_start" if message.start else "audio_end" if message.end else "audio_control"
        if presence_callback:
            await presence_callback(client_id, last_event=state)
        
        if message.start:
            await runtime.start_audio_stream(client_id=client_id)
        elif message.end:
            await runtime.end_audio_stream(client_id=client_id)
    except (RuntimeError, AttributeError, OSError, ConnectionError) as e:
        logger.warning("Error handling audio control: %s", e)


async def handle_stop(
    ws: WebSocket,
    client_id: str,
    message: StopMessage,
    runtime: Any,
    stream_tasks: Dict[str, Dict[str, Any]],
    tasks_lock: asyncio.Lock,
    resolve_backend_id_func: Any,
    forget_mapping_func: Any,
    presence_callback: Optional[Any] = None,
) -> None:
    """
    Handle stop/cancel generation.
    
    Args:
        ws: WebSocket connection
        client_id: Client identifier
        message: Stop message
        runtime: RuntimeEngine instance
        stream_tasks: Active stream tasks dictionary
        tasks_lock: Tasks lock for thread safety
        resolve_backend_id_func: Function to resolve backend ID from frontend ID
        forget_mapping_func: Function to forget request mapping
        presence_callback: Optional presence update callback
    """
    stop_identifier = message.id
    if not stop_identifier:
        logger.warning("Stop message without request ID")
        return
    
    backend_request_id = resolve_backend_id_func(client_id, stop_identifier)
    logger.info("Received stop signal for request %s (client_submitted=%s)", backend_request_id, stop_identifier)
    
    if presence_callback:
        await presence_callback(
            client_id,
            status="stopping",
            last_event="stop",
        )
    
    correlation_id = None
    frontend_id = None
    
    # Cancel the stream task
    async with tasks_lock:
        if backend_request_id in stream_tasks:
            try:
                task_info = stream_tasks[backend_request_id]
                correlation_id = task_info.get("correlation_id")
                frontend_id = task_info.get("frontend_id")
                task_info["task"].cancel()
                del stream_tasks[backend_request_id]
                forget_mapping_func(
                    client_id=client_id,
                    frontend_id=frontend_id,
                    backend_id=backend_request_id,
                )
                logger.debug("Cancelled stream task for %s", backend_request_id)
            except (KeyError, RuntimeError, asyncio.CancelledError) as e:
                logger.debug("Failed to cancel task: %s", e)
    
    # Notify runtime to stop generation
    try:
        await runtime.stop_generation(backend_request_id)
    except (RuntimeError, AttributeError, ConnectionError, OSError) as e:
        logger.debug("Error stopping generation: %s", e)
    
    # Send acknowledgment
    try:
        stop_message = {
            "role": MessageRole.SERVER,
            "type": MessageType.STOPPED,
            "request_id": backend_request_id,
            "message": "Generation stopped by user request",
        }
        if frontend_id:
            stop_message["frontend_id"] = frontend_id
        if correlation_id:
            stop_message["correlation_id"] = correlation_id
        await ws.send_text(json.dumps(stop_message))
    except (RuntimeError, OSError, ConnectionError):  # noqa: BLE001 -- best-effort ack: client may have disconnected
        pass


async def _cleanup_interpreter_instance(runtime: Any, chat_id: str) -> None:
    """Cleanup OI instance for this chat before resetting context."""
    if hasattr(runtime, '_interpreter_manager') and chat_id:
        interpreter_manager = runtime._interpreter_manager
        if interpreter_manager:
            try:
                await interpreter_manager.reset_interpreter(chat_id=chat_id)
                logger.info("Cleaned up OI instance for chat %s", chat_id[:8])
            except (RuntimeError, AttributeError, OSError, ConnectionError) as e:
                logger.warning("Failed to cleanup OI instance for chat %s: %s", chat_id[:8], e)


async def _hydrate_chat_history(
    runtime: Any, 
    history_service: Optional["ChatHistoryService"], 
    chat_uuid: Optional[UUID], 
    client_id: str, 
    chat_id: str
) -> int:
    """Load and inject history into runtime. Returns number of messages loaded."""
    if not chat_uuid or not history_service:
        logger.debug("No history service or chat_uuid available; skipping hydration for chat %s", chat_id)
        return 0

    history_limit = None
    if hasattr(runtime, "get_history_limit"):
        try:
            history_limit = runtime.get_history_limit() or None
        except (AttributeError, TypeError, ValueError):
            pass

    try:
        hydrated_history = await history_service.load_history(
            chat_uuid,
            limit=history_limit,
            client_id=client_id,
        )
    except (RuntimeError, OSError, ValueError, TypeError, KeyError) as hydrate_error:
        logger.warning(
            "Failed to hydrate chat history during context reset (chat=%s, client=%s): %s",
            chat_id, client_id, hydrate_error,
        )
        return 0

    if hydrated_history and hasattr(runtime, "set_history"):
        history_key = chat_id or client_id
        runtime.set_history(history_key, hydrated_history)
        history_loaded = len(hydrated_history)
        logger.info(
            "Hydrated %s history messages into runtime for %s",
            history_loaded, history_key,
        )
        return history_loaded
    return 0


async def _inject_memory_context(runtime: Any, chat_uuid: Optional[UUID], client_id: str, chat_id: str) -> None:
    """Inject global and chat-specific memories into system message."""
    try:
        from core.runtime.memory_injector import get_memory_injector
        memory_injector = get_memory_injector()
        
        global_memory_context = await memory_injector.get_global_memory_context(limit=20)
        
        chat_memory_context = ""
        if chat_uuid:
            chat_memory_context = await memory_injector.get_chat_memory_context(
                chat_id=chat_uuid, limit=10
            )
        
        combined_memory_context = ""
        if global_memory_context and isinstance(global_memory_context, str) and global_memory_context.strip():
            combined_memory_context += global_memory_context
        if chat_memory_context and isinstance(chat_memory_context, str) and chat_memory_context.strip():
            combined_memory_context += chat_memory_context
        
        if combined_memory_context:
            if hasattr(runtime, "inject_system_context"):
                runtime.inject_system_context(client_id, combined_memory_context)
                logger.info("Injected memory context for client %s", client_id)
            else:
                interpreter = await runtime.get_interpreter(chat_id or client_id)
                if interpreter and hasattr(interpreter, 'system_message'):
                    original_message = str(interpreter.system_message or "")
                    if "## Global Memory Context" not in original_message and "## 💬 Chat Memory Context" not in original_message:
                        interpreter.system_message = original_message + combined_memory_context
                        logger.info("Injected memory context into system message for client %s", client_id)
                    else:
                        logger.debug("Memory already injected for client %s", client_id)
    except (ImportError, AttributeError, TypeError, ValueError, RuntimeError) as mem_error:
        logger.warning("Failed to inject memories: %s", mem_error, exc_info=True)


async def _inject_api_docs_reference(runtime: Any, client_id: str, chat_id: str) -> None:
    """Inject API documentation reference (lightweight)."""
    try:
        interpreter = await runtime.get_interpreter(chat_id or client_id)
        if interpreter and hasattr(interpreter, 'system_message'):
            original_message = str(interpreter.system_message or "")
            if "## 🔌 Backend API Access" not in original_message:
                from config.settings import get_settings
                settings = get_settings()
                backend_url = getattr(settings, "backend_url", None)

                if backend_url:
                    api_docs_reference = f"\n\n## 🔌 Backend API Access\n\nYou have direct access to the backend REST API for advanced operations.\n\n**API Documentation:** `GET {backend_url}/v1/docs` - Returns hierarchical API documentation\n**OpenAPI Spec:** `GET {backend_url}/openapi.json` - Full OpenAPI 3.1.0 specification\n\nUse the docs endpoint to discover available APIs hierarchically when tools are insufficient.\n\n**Example:**\n```python\nimport requests\ndocs = requests.get('{backend_url}/v1/docs').json()\n# Navigate through paths, tags, schemas as needed\n```\n"
                    interpreter.system_message = original_message + api_docs_reference
                    logger.info("Injected API docs reference for client %s", client_id)
            else:
                logger.debug("API docs reference already injected for client %s", client_id)
    except (ImportError, AttributeError, TypeError, RuntimeError) as api_error:
        logger.warning("Failed to inject API docs reference: %s", api_error, exc_info=True)


async def handle_context_reset(
    ws: WebSocket,
    client_id: str,
    message: ContextResetMessage,
    runtime: Any,
    history_service: Optional["ChatHistoryService"] = None,
    presence_callback: Optional[Any] = None,
) -> None:
    """
    Handle context reset when user switches/creates chats.
    Clears the LM Studio conversation context for clean slate.
    
    Args:
        ws: WebSocket connection
        client_id: Client identifier
        message: Context reset message
        runtime: RuntimeEngine instance
        history_service: Optional chat history service
        presence_callback: Optional presence update callback
    """
    chat_id = message.chat_id
    chat_label = chat_id[:8] if chat_id else "none"
    logger.info("Context reset requested for client %s, chat %s", client_id, chat_label)
    
    if presence_callback:
        await presence_callback(client_id, last_event="context_reset")
    
    try:
        await _cleanup_interpreter_instance(runtime, chat_id)
        
        # Reset runtime context for this client
        if hasattr(runtime, 'reset_context'):
            await runtime.reset_context(client_id, chat_id=chat_id)
            logger.info("Context reset complete for client %s", client_id)
        else:
            logger.warning("Runtime does not support context reset")
        
        chat_uuid: Optional[UUID] = None
        if chat_id:
            try:
                chat_uuid = UUID(chat_id)
            except ValueError:
                logger.warning(
                    "Invalid chat_id received for context reset (chat=%s, client=%s)",
                    chat_id,
                    client_id,
                )
        
        history_loaded = await _hydrate_chat_history(
            runtime, history_service, chat_uuid, client_id, chat_id
        )
        
        await _inject_memory_context(runtime, chat_uuid, client_id, chat_id)
        await _inject_api_docs_reference(runtime, client_id, chat_id)
        
        # Send acknowledgment
        ack_message = {
            "role": MessageRole.SERVER,
            "type": MessageType.CONTEXT_RESET_ACK,
            "chat_id": chat_id,
            "timestamp": message.timestamp,
            "history_count": history_loaded,
        }
        await ws.send_text(json.dumps(ack_message))
        
    except Exception as e:
        logger.error("Error resetting context for client %s: %s", client_id, e, exc_info=True)
        # Send error response (generic message -- no internal details to client)
        try:
            error_message = {
                "role": MessageRole.SERVER,
                "type": MessageType.ERROR,
                "message": "Context reset failed. Please try again.",
            }
            await ws.send_text(json.dumps(error_message))
        except (RuntimeError, OSError, ConnectionError):  # noqa: BLE001 -- best-effort error response: client may have disconnected
            pass

