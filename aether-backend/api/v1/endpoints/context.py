"""
Context Management Endpoints

REST API endpoints for conversation context management.
Returns COMPLETE LLM context including system message, global memories, and conversation history.

@.architecture
Incoming: api/v1/router.py, HTTP clients --- {http_request, json, chat_id}
Processing: get_context_messages(), inject_system_message(), inject_global_memories() --- {3 jobs: JOB_ROUTE, JOB_ORCHESTRATE_CONTEXT, JOB_SERIALIZE_RESPONSE}
Outgoing: core/runtime/interpreter.py, core/runtime/memory_injector.py, data/database/repositories/chat.py, HTTP clients --- {ContextMessagesResponse, json}
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi import status as http_status
from uuid import UUID
from typing import List
import logging
import inspect

from core.exceptions import DomainException
from api.dependencies import setup_request_context, get_database, get_chat_service
from api.v1.schemas.context import (
    ContextStatusResponse,
    SummarizationResponse,
    ContextExportResponse,
    ContextMessagesResponse,
    ContextMessage,
)
from application.context.context_manager import ContextManager
from core.runtime.interpreter import get_interpreter_manager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["context"], prefix="/context")


def estimate_token_count(messages: list) -> int:
    """
    Estimate token count from messages using simple heuristic.
    
    Uses ~4 characters per token approximation (conservative for English).
    More accurate than 0, good enough for context visualization.
    
    Args:
        messages: List of message objects with 'content' field
        
    Returns:
        Estimated token count
    """
    total_chars = 0
    for msg in messages:
        content = msg.content if hasattr(msg, 'content') else ''
        if isinstance(content, str):
            total_chars += len(content)
        elif isinstance(content, dict) and 'text' in content:
            total_chars += len(content['text'])
    
    # ~4 chars per token (conservative estimate)
    return total_chars // 4


async def _get_full_context_for_chat(chat_id: UUID, chat_service) -> List[ContextMessage]:
    """
    Build the COMPLETE LLM context for a chat, matching what is sent to the LLM.
    
    Includes:
    1. Enriched system prompt (profile, computer API, custom instructions)
    2. Global memory context (injected via MemoryInjector)
    3. Chat-specific memory context (injected via MemoryInjector)
    4. API documentation reference
    5. Database conversation messages
    
    Args:
        chat_id: Chat UUID
        db: Database session
        
    Returns:
        List of ContextMessage objects
    """
    # Get conversation messages from database (single source of truth)
    messages_db = await chat_service.list_messages(chat_id, limit=1000)
    
    # Get interpreter manager to retrieve system message + memories
    interpreter_manager = get_interpreter_manager()
    
    # Build COMPLETE context (matching what LLM receives)
    context_messages = []
    
    # 1. Get enriched system message (includes profile + computer API + custom instructions)
    #    PERF FIX: Use cached-only lookup — never spawn an OI server for a read-only
    #    context viewer request.
    system_content = None
    interp = interpreter_manager.get_cached_interpreter(str(chat_id))
    try:
        # PRIMARY: Try to get system message from a *cached* interpreter instance
        if interp and hasattr(interp, 'system_message') and interp.system_message:
            system_content = interp.system_message
            logger.debug("Got system message from cached interpreter instance for chat %s", chat_id)
        
        # FALLBACK: Use cached enriched system message
        if not system_content:
            if hasattr(interpreter_manager, '_enriched_system_message') and interpreter_manager._enriched_system_message:
                system_content = interpreter_manager._enriched_system_message
                logger.debug("Using cached system message for context builder - chat %s", chat_id)
            else:
                logger.warning("No cached system message available in InterpreterManager for chat %s", chat_id)
        
        if system_content:
            # Add language-specific system messages (only if interpreter instance exists)
            if interp and hasattr(interp, 'computer') and hasattr(interp.computer, 'terminal') and hasattr(interp.computer.terminal, 'languages'):
                for language in interp.computer.terminal.languages:
                    if hasattr(language, 'system_message'):
                        system_content += "\n\n" + language.system_message
            
            # Add custom instructions if present (only if interpreter instance exists)
            if interp and hasattr(interp, 'custom_instructions') and interp.custom_instructions:
                system_content += "\n\n" + interp.custom_instructions
            
            # Add computer API system message if enabled (only if interpreter instance exists)
            if (interp and hasattr(interp, 'computer') and 
                interp.computer.import_computer_api and
                hasattr(interp.computer, 'system_message') and
                interp.computer.system_message and
                interp.computer.system_message not in system_content):
                system_content += "\n\n" + interp.computer.system_message
            
            # Inject global memories
            try:
                from core.runtime.memory_injector import get_memory_injector
                memory_injector = get_memory_injector()
                global_memory_context = await memory_injector.get_global_memory_context(
                    limit=20
                )
                if global_memory_context and isinstance(global_memory_context, str) and global_memory_context.strip():
                    if "## 🧠 Global Memory Context" not in system_content:
                        system_content += global_memory_context
            except Exception as mem_error:
                logger.warning("Failed to inject global memories: %s", mem_error)
            
            # Inject chat-specific memories
            try:
                from core.runtime.memory_injector import get_memory_injector
                memory_injector = get_memory_injector()
                chat_memory_context = await memory_injector.get_chat_memory_context(
                    chat_id=chat_id,
                    limit=10
                )
                if chat_memory_context and isinstance(chat_memory_context, str) and chat_memory_context.strip():
                    if "## 💬 Chat Memory Context" not in system_content:
                        system_content += chat_memory_context
            except Exception as mem_error:
                logger.warning("Failed to inject chat memories: %s", mem_error)
            
            # Inject API documentation reference
            try:
                if "## 🔌 Backend API Access" not in system_content:
                    from config.settings import get_settings
                    settings = get_settings()
                    backend_url = settings.base_url
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
                    system_content += api_docs_reference
            except Exception as api_error:
                logger.warning("Failed to inject API docs reference: %s", api_error)
            
            # Add as first message (marked as system)
            context_messages.append(ContextMessage(
                id="system",
                role="system",
                content=system_content,
                is_system=True
            ))
    except Exception as e:
        logger.error("Failed to build full system message for chat %s: %s", chat_id, e, exc_info=True)
    
    # 2. Add conversation messages
    # ARCHITECTURAL FIX: Merge database messages with in-memory interpreter messages
    # to ensure the viewer reflects the actual context that would be sent to the LLM.
    # Note: messages_db contains persisted history, interp.messages (if async get_messages() is used)
    # contains the active session history including un-persisted turns from /stream.
    interp_messages = []
    if interp and hasattr(interp, "get_messages") and inspect.iscoroutinefunction(interp.get_messages):
        try:
            interp_messages = await interp.get_messages()
            logger.debug("Fetched %d messages from remote interpreter for context viewer", len(interp_messages))
        except Exception as exc:
            logger.warning("Failed to fetch messages from remote interpreter: %s", exc)
    
    if interp_messages:
        # If we have interpreter messages, they are the source of truth for the active session.
        # They usually include the system message at index 0, so we skip our manual system msg
        # if the interpreter already provides one.
        for i, msg in enumerate(interp_messages):
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            msg_id = msg.get("id", f"interp-{i}")
            is_system = (role == "system")
            
            # Skip adding our manual system message if the interpreter already has one
            if is_system and context_messages:
                context_messages = [] # Clear the fallback system message
                
            context_messages.append(ContextMessage(
                id=str(msg_id),
                role=role,
                content=content,
                is_system=is_system,
                metadata=msg.get("metadata")
            ))
    else:
        # Fallback: use database messages (single source of truth for persistent history)
        for msg in messages_db:
            context_messages.append(ContextMessage(
                id=str(msg.id),
                role=msg.role,
                content=msg.content,
                is_system=False,
                metadata=msg.metadata if hasattr(msg, 'metadata') and isinstance(msg.metadata, dict) else None
            ))
    
    return context_messages


# =============================================================================
# Context Status Endpoints
# =============================================================================

@router.get(
    "/chats/{chat_id}/context/status",
    response_model=ContextStatusResponse,
    summary="Get context status for chat"
)
async def get_context_status(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service),
) -> ContextStatusResponse:
    """
    Get conversation context status for a chat.
    
    Returns real-time token usage, status level, and threshold information
    based on the in-memory Open Interpreter instance for this chat.
    
    Args:
        chat_id: Chat UUID
        
    Returns:
        Context status with token metrics and recommendations
        
    Status Levels:
        - new: No messages yet
        - normal: < 80% of token limit
        - warning: 80-90% of token limit
        - high: 90-95% of token limit (summarization recommended)
        - critical: > 95% of token limit (new chat recommended)
    """
    try:
        # ARCHITECTURAL FIX: Calculate token usage from the COMPLETE context
        # This includes system prompt, memories, and database messages to ensure
        # the status icon (0-100%) matches the reality of the LLM turn.
        context_messages = await _get_full_context_for_chat(chat_id, chat_service)
        
        # Calculate token count from complete context
        token_count = estimate_token_count(context_messages)
        
        # Get settings for limits and thresholds
        from config.settings import get_settings
        settings = get_settings()
        token_limit = settings.llm.context_window
        usage_percent = (token_count / token_limit * 100) if token_limit > 0 else 0.0
        
        # Calculate thresholds
        warning_threshold = int(token_limit * 0.8)
        high_threshold = int(token_limit * 0.9)
        critical_threshold = int(token_limit * 0.95)
        
        # Determine status - use presence of user content for 'new' status,
        # but token counts for all other levels.
        has_user_content = any(not msg.is_system for msg in context_messages)
        
        if not has_user_content:
            status_level = "new"
        elif token_count >= critical_threshold:
            status_level = "critical"
        elif token_count >= high_threshold:
            status_level = "high"
        elif token_count >= warning_threshold:
            status_level = "warning"
        else:
            status_level = "normal"
        
        status = {
            "chat_id": str(chat_id),
            "message_count": len(context_messages),
            "token_count": token_count,
            "token_limit": token_limit,
            "usage_percent": usage_percent,
            "status": status_level,
            "needs_summarization": token_count >= high_threshold,
            "recommend_new_chat": token_count >= critical_threshold,
            "thresholds": {
                "warning": warning_threshold,
                "high": high_threshold,
                "critical": critical_threshold
            }
        }
        
        logger.info(
            f"Retrieved context status for chat {chat_id}",
            extra={
                "chat_id": str(chat_id),
                "status": status["status"],
                "token_count": status["token_count"],
                "usage_percent": status["usage_percent"],
            }
        )
        
        return ContextStatusResponse(**status)
        
    except Exception as e:
        logger.error("Failed to get context status for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve context status. Check server logs for details."
        )


# =============================================================================
# Context Summarization Endpoints
# =============================================================================

@router.post(
    "/chats/{chat_id}/context/summarize",
    response_model=SummarizationResponse,
    summary="Trigger context summarization"
)
async def trigger_summarization(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service),
) -> SummarizationResponse:
    """
    Manually trigger context summarization for a chat.
    
    Condenses the conversation history to reduce token usage while
    preserving important context. Keeps first 2 and last 5 messages,
    summarizes the middle.
    
    Args:
        chat_id: Chat UUID
        
    Returns:
        Summarization results with before/after token counts
    """
    try:
        # Initialize context manager
        context_manager = ContextManager(
            interpreter_manager=get_interpreter_manager(),
            chat_service=chat_service,
        )
        
        # Trigger summarization
        result = await context_manager.summarize_context(str(chat_id))
        
        logger.info(
            f"Summarized context for chat {chat_id}",
            extra={
                "chat_id": str(chat_id),
                "tokens_saved": result["tokens_saved"],
                "success": result["success"],
            }
        )
        
        return SummarizationResponse(**result)
        
    except Exception as e:
        logger.error("Failed to summarize context for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to summarize context. Check server logs for details."
        )


# =============================================================================
# Context Export Endpoints
# =============================================================================

@router.get(
    "/chats/{chat_id}/context/export",
    response_model=ContextExportResponse,
    summary="Export context for cross-chat use"
)
async def export_context(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service),
) -> ContextExportResponse:
    """
    Export condensed context summary for cross-chat reasoning.
    
    Provides a structured export of the conversation context including
    summary, key points, and artifacts used. Can be used to provide
    context from one chat to another.
    
    Args:
        chat_id: Chat UUID
        
    Returns:
        Exportable context summary with metadata
    """
    try:
        # Initialize context manager
        context_manager = ContextManager(
            interpreter_manager=get_interpreter_manager(),
            chat_service=chat_service,
        )
        
        # Export context
        result = await context_manager.export_context(str(chat_id))
        
        logger.info(
            f"Exported context for chat {chat_id}",
            extra={
                "chat_id": str(chat_id),
                "message_count": result["message_count"],
                "token_count": result["token_count"],
            }
        )
        
        return ContextExportResponse(**result)
        
    except Exception as e:
        logger.error("Failed to export context for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to export context. Check server logs for details."
        )


# =============================================================================
# Context Messages Viewer Endpoint
# =============================================================================

@router.get(
    "/chats/{chat_id}/context/messages",
    response_model=ContextMessagesResponse,
    summary="Get current context messages for viewer"
)
async def get_context_messages(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service),
) -> ContextMessagesResponse:
    """
    Get the current context messages for display in the context viewer.
    
    Returns the exact messages that would be sent to the LLM on the next turn,
    including system prompt, conversation history, and all context.
    
    Args:
        chat_id: Chat UUID
        
    Returns:
        Context messages with metadata for visualization
    """
    try:
        import time as _time
        _t0 = _time.perf_counter()

        # Build COMPLETE context using shared helper
        context_messages = await _get_full_context_for_chat(chat_id, chat_service)
        _t_build = _time.perf_counter()
        
        # Get settings for token limit
        from config.settings import get_settings
        settings = get_settings()
        token_limit = settings.llm.context_window
        
        # Calculate token count from complete context
        token_count = estimate_token_count(context_messages)
        usage_percent = (token_count / token_limit * 100) if token_limit > 0 else 0.0
        
        # Calculate thresholds
        warning_threshold = int(token_limit * 0.8)
        high_threshold = int(token_limit * 0.9)
        critical_threshold = int(token_limit * 0.95)
        
        _t_end = _time.perf_counter()
        logger.info(
            "context/messages for chat %s: build=%.1fms total=%.1fms msgs=%d tokens=%d",
            str(chat_id)[:8],
            (_t_build - _t0) * 1000,
            (_t_end - _t0) * 1000,
            len(context_messages),
            token_count,
        )
        
        # Return complete response
        return ContextMessagesResponse(
            chat_id=str(chat_id),
            messages=context_messages,
            message_count=len(context_messages),
            token_count=token_count,
            token_limit=token_limit,
            usage_percent=usage_percent,
            thresholds={
                "warning": warning_threshold,
                "high": high_threshold,
                "critical": critical_threshold,
            },
        )
        
    except Exception as e:
        logger.error("Failed to get context messages for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve context messages. Check server logs for details."
        )


@router.get(
    "/agent-context",
    summary="Test agent context injection"
)
async def test_agent_context(
    query: str,
    _context: dict = Depends(setup_request_context),
    db = Depends(get_database),
) -> dict:
    """
    Test endpoint for agent context injection.
    
    Queries enabled agents and returns their context.
    
    Args:
        query: Search query
        
    Returns:
        Dict with context and metadata
    """
    try:
        from services.agents.context_injector import AgentContextInjector
        from data.database.uow import SupabaseUnitOfWork, SupabaseRequestContext
        import uuid
        
        # Create UoW
        context = SupabaseRequestContext(request_id=str(uuid.uuid4()))
        async with SupabaseUnitOfWork(db, context) as uow:
            injector = AgentContextInjector(uow)
            context_str = await injector.get_agent_context(query)
        
        return {
            "query": query,
            "context": context_str,
            "context_length": len(context_str),
            "has_context": bool(context_str)
        }
        
    except Exception as e:
        logger.error("Failed to get agent context: %s", e, exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get agent context. Check server logs for details."
        )


@router.delete(
    "/chats/{chat_id}/messages/{message_id}",
    status_code=http_status.HTTP_200_OK,
    summary="Delete message group (user + assistant)"
)
async def delete_message_group(
    chat_id: UUID,
    message_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service),
) -> dict:
    """
    Delete a user message and its corresponding assistant response.
    
    This is the primary deletion method for user-initiated context cleanup.
    Deletes:
    - User message
    - Assistant response
    - All artifacts from both messages
    - All attachments from both messages
    
    Args:
        chat_id: Chat UUID
        message_id: User message UUID to delete
        
    Returns:
        Deletion summary with counts
        
    Raises:
        404: If message not found or not a user message
        500: If deletion fails
    """
    try:
        # Verify message belongs to this chat
        message = await chat_service.get_message(message_id)
        if not message:
            raise HTTPException(
                status_code=http_status.HTTP_404_NOT_FOUND,
                detail=f"Message {message_id} not found"
            )
        
        if str(message.chat_id) != str(chat_id):
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=f"Message {message_id} does not belong to chat {chat_id}"
            )
        
        if message.role != "user":
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=f"Can only delete user messages. Message {message_id} is role={message.role}"
            )
        
        # Delete message group
        result = await chat_service.delete_message_group(message_id)
        
        logger.info(
            f"Deleted message group in chat {chat_id}",
            extra={
                "chat_id": str(chat_id),
                "user_message_id": str(message_id),
                "deleted_messages": result["deleted_messages"],
                "deleted_artifacts": result["deleted_artifacts"]
            }
        )
        
        return {
            "success": True,
            **result
        }
        
    except (HTTPException, DomainException):
        raise
    except ValueError as e:
        logger.warning("Invalid delete request for message %s: %s", message_id, e)
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Invalid request. Check server logs for details."
        )
    except Exception as e:
        logger.error("Failed to delete message group %s: %s", message_id, e, exc_info=True)
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete message. Check server logs for details."
        )

