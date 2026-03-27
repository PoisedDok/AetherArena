"""
@.architecture
Incoming: presentation/router --- {str, WebSocket, Message objects, primitives}
Processing: context reset coordination, history loading --- {3 jobs: JOB_ROUTE, JOB_DELEGATE, JOB_LOG}
Outgoing: runtime, services --- {str, primitives}

Context Handler - Context reset and history loading

Presentation layer handler for context management.
Coordinates runtime context reset and history loading.

Handles:
- context reset
- history loading from chat
"""

import json
from typing import Any, Optional
from fastapi import WebSocket
import logging

from ws.protocols import MessageRole, MessageType

logger = logging.getLogger(__name__)


class ContextHandler:
    """
    Context management handler.
    
    Handles context reset and history loading.
    """
    
    def __init__(
        self,
        *,
        runtime: Any,
        history_service: Optional[Any] = None,
        cache_service: Any,
    ):
        """
        Initialize context handler.
        
        Args:
            runtime: RuntimeEngine instance
            history_service: Optional history service
            cache_service: Cache service
        """
        self._runtime = runtime
        self._history_service = history_service
        self._cache = cache_service
        self._logger = logger
    
    async def handle_context_reset(
        self,
        *,
        ws: WebSocket,
        client_id: str,
        message: Any,
        hub: Any = None,  # WebSocketHub reference for updating client state
    ) -> None:
        """
        Handle context reset request.
        
        Args:
            ws: WebSocket connection
            client_id: Client identifier
            message: Context reset message object
            hub: Optional WebSocketHub reference for updating client state
        """
        chat_id = message.chat_id
        
        self._logger.info("Context reset: client=%s, chat=%s", client_id, chat_id)
        
        # CRITICAL FIX: Store active_chat_id on Client for handsfree integration
        # This enables handsfree messages to integrate with the active chat session
        if hub and chat_id:
            client = hub.clients.get(client_id)
            if client:
                client.active_chat_id = chat_id
                self._logger.debug("Updated active_chat_id for %s: %s", client_id[:8], chat_id)
        
        # Update presence
        await self._cache.update_presence_metadata(
            client_id,
            last_event="context_reset",
        )
        
        # Reset runtime context — MUST succeed before loading history.
        # Loading history into a failed/stale context produces contaminated state
        # (mix of old and new conversation). Bail out on failure.
        try:
            await self._runtime.reset_context(client_id=client_id, chat_id=chat_id)
        except (RuntimeError, AttributeError, ConnectionError, OSError, ValueError) as e:
            self._logger.error("Runtime reset failed — aborting context switch: %s", e, exc_info=True)
            try:
                await ws.send_text(json.dumps({
                    "role": MessageRole.SERVER,
                    "type": MessageType.CONTEXT_RESET_ACK,
                    "chat_id": chat_id,
                    "error": True,
                    "message": "Context reset failed. Please try again.",
                }))
            except (RuntimeError, OSError, ConnectionError):
                pass  # Connection may be dead
            return
        
        # Load history if chat_id provided
        if chat_id and self._history_service:
            try:
                from uuid import UUID
                
                chat_uuid = UUID(chat_id)
                history_limit = 100
                if hasattr(self._runtime, "get_history_limit"):
                    try:
                        history_limit = self._runtime.get_history_limit() or history_limit
                    except (AttributeError, TypeError, ValueError):
                        history_limit = 100
                history_messages = await self._history_service.load_history(
                    chat_uuid,
                    limit=history_limit,
                    client_id=client_id,
                )
                
                # Load into runtime context
                if hasattr(self._runtime, 'set_history'):
                    history_key = chat_id or client_id
                    self._runtime.set_history(history_key, history_messages)
                elif hasattr(self._runtime, 'load_history'):
                    await self._runtime.load_history(
                        client_id=client_id,
                        messages=history_messages,
                    )
                
                self._logger.info(
                    "Loaded %d messages into context", len(history_messages)
                )
            
            except (ValueError, RuntimeError, OSError, TypeError, KeyError) as e:
                self._logger.error("History loading error: %s", e, exc_info=True)

        async def _resolve_interpreter(identifier: str) -> Optional[Any]:
            """Resolve interpreter via runtime if available; fallback to engine helper."""
            getter = getattr(self._runtime, "get_interpreter", None)
            if callable(getter):
                return await getter(identifier)
            from core.runtime.engine import get_interpreter as _get_interpreter
            return await _get_interpreter(chat_id=identifier)

        # Inject global and chat memories into system message (after history hydration).
        try:
            from core.runtime.memory_injector import get_memory_injector
            memory_injector = get_memory_injector()
            
            global_memory_context = await memory_injector.get_global_memory_context(
                limit=20
            )
            
            chat_memory_context = ""
            if chat_id:
                try:
                    from uuid import UUID
                    chat_uuid = UUID(chat_id)
                    chat_memory_context = await memory_injector.get_chat_memory_context(
                        chat_id=chat_uuid,
                        limit=10
                    )
                except ValueError:
                    pass
            
            combined_memory_context = ""
            if global_memory_context and isinstance(global_memory_context, str) and global_memory_context.strip():
                combined_memory_context += global_memory_context
            if chat_memory_context and isinstance(chat_memory_context, str) and chat_memory_context.strip():
                combined_memory_context += chat_memory_context
                
            if combined_memory_context:
                if hasattr(self._runtime, "inject_system_context"):
                    history_key = chat_id or client_id
                    self._runtime.inject_system_context(history_key, combined_memory_context)
                    self._logger.info("Injected memory context for client %s", client_id)
                else:
                    interpreter = await _resolve_interpreter(chat_id or client_id)
                    if interpreter and hasattr(interpreter, 'system_message'):
                        original_message = str(interpreter.system_message or "")
                        if "## Global Memory Context" not in original_message and "## 💬 Chat Memory Context" not in original_message:
                            interpreter.system_message = original_message + combined_memory_context
                            self._logger.info("Injected memory context into system message for client %s", client_id)
                        else:
                            self._logger.debug("Memory already injected for client %s", client_id)
        except (ImportError, AttributeError, TypeError, ValueError, RuntimeError) as mem_error:
            self._logger.warning("Failed to inject memories: %s", mem_error, exc_info=True)

        # Inject API documentation reference (lightweight).
        try:
            from config.settings import get_settings
            settings = get_settings()
            backend_url = getattr(settings, "base_url", None)
            if backend_url:
                api_docs_reference = f"""

## 🔌 Backend API Access

You have direct access to the backend REST API for advanced operations.

**API Documentation:** `GET {backend_url}/v1/docs` - Returns hierarchical API documentation
**OpenAPI Spec:** `GET {backend_url}/openapi.json` - Full OpenAPI 3.1.0 specification

Use the docs endpoint to discover available APIs hierarchically when tools are insufficient.

**Example:**
```python
import httpx
docs = httpx.get('{backend_url}/v1/docs').json()
# Navigate through paths, tags, schemas as needed
```
"""
                if hasattr(self._runtime, "inject_system_context"):
                    history_key = chat_id or client_id
                    self._runtime.inject_system_context(history_key, api_docs_reference)
                    self._logger.info("Injected API docs reference for client %s", client_id)
                else:
                    interpreter = await _resolve_interpreter(chat_id or client_id)
                    if interpreter and hasattr(interpreter, 'system_message'):
                        original_message = str(interpreter.system_message or "")
                        if "## 🔌 Backend API Access" not in original_message:
                            interpreter.system_message = original_message + api_docs_reference
                            self._logger.info("Injected API docs reference for client %s", client_id)
                        else:
                            self._logger.debug("API docs reference already injected for client %s", client_id)
        except (ImportError, AttributeError, TypeError, RuntimeError) as api_error:
            self._logger.warning("Failed to inject API docs reference: %s", api_error, exc_info=True)
        
        # Send acknowledgment
        try:
            response = {
                "role": MessageRole.SERVER,
                "type": MessageType.CONTEXT_RESET_ACK,
                "chat_id": chat_id,
                "message": "Context reset complete",
            }
            await ws.send_text(json.dumps(response))
        except (RuntimeError, OSError, ConnectionError) as e:
            self._logger.debug("Failed to send reset ack: %s", e)

