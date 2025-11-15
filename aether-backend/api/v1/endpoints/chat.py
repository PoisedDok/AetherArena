"""
Chat Management Endpoints

Endpoints for chat and conversation management.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP POST/GET) --- {HTTP requests to /v1/chat, /v1/chat/stream, /v1/chat/history, Dict[str, Any] payload with message/session_id/image_b64}
Processing: send_chat_message(), stream_chat_message(), get_chat_history() --- {9 jobs: data_validation, dependency_injection, error_handling, history_retrieval, http_communication, message_handling, sanitization, streaming, streaming_coordination}
Outgoing: core/runtime/engine.py (runtime.stream_chat), Frontend (HTTP) --- {runtime streaming requests, JSONResponse or StreamingResponse (SSE)}
"""

from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.responses import StreamingResponse, JSONResponse
from uuid import UUID
import uuid
import json
import asyncio

from api.dependencies import setup_request_context, get_runtime_engine
from api.v1.schemas.chat import (
    ChatCreate,
    ChatUpdate,
    ChatResponse,
    MessageCreate,
    MessageResponse
)
from core.runtime.engine import RuntimeEngine
from monitoring import get_logger
from security.sanitization import sanitize_text, SizeExceededError, ValidationError
from pydantic import BaseModel, Field, field_validator
import base64

logger = get_logger(__name__)
router = APIRouter(tags=["chat"])

# Security constants
MAX_MESSAGE_LENGTH = 50000  # 50K characters
MAX_IMAGE_B64_SIZE = 10 * 1024 * 1024  # 10MB base64 (≈7.5MB actual image)


def _validate_session_id(session_id: str) -> str:
    """
    Validate and sanitize session ID.
    
    Args:
        session_id: Raw session ID string
        
    Returns:
        Validated and sanitized session ID
        
    Raises:
        ValueError: If validation fails
    """
    if not session_id or not session_id.strip():
        raise ValueError("Session ID cannot be empty")
    
    session_id = session_id.strip()
    if len(session_id) > 255:
        raise ValueError("Session ID too long")
    
    # Allow alphanumeric, hyphens, underscores only
    if not all(c.isalnum() or c in '-_' for c in session_id):
        raise ValueError("Session ID contains invalid characters")
    
    return session_id


class ChatRequest(BaseModel):
    """Chat request payload."""
    message: str = Field(..., description="User message text", min_length=1, max_length=MAX_MESSAGE_LENGTH)
    session_id: str = Field("default", description="Session identifier", min_length=1, max_length=255)
    history: List[Dict[str, Any]] = Field(default_factory=list, description="Optional conversation history")
    image_b64: Optional[str] = Field(None, description="Optional base64 encoded image")
    
    @field_validator('message')
    @classmethod
    def validate_message(cls, v):
        """Sanitize message text."""
        if not v or not v.strip():
            raise ValueError("Message cannot be empty")
        return sanitize_text(v, max_length=MAX_MESSAGE_LENGTH, allow_html=False)
    
    @field_validator('session_id')
    @classmethod
    def validate_session_id(cls, v):
        """Validate session ID format."""
        return _validate_session_id(v)
    
    @field_validator('image_b64')
    @classmethod
    def validate_image_b64(cls, v):
        """Validate base64 image."""
        if v is None:
            return v
        # Check size
        if len(v) > MAX_IMAGE_B64_SIZE:
            raise ValueError(f"Image too large. Maximum: {MAX_IMAGE_B64_SIZE / (1024*1024):.1f}MB")
        # Verify it's valid base64
        try:
            base64.b64decode(v)
        except Exception:
            raise ValueError("Invalid base64 image data")
        return v


# =============================================================================
# Chat Message Endpoint (main chat route)
# =============================================================================

@router.post(
    "/chat",
    summary="Send chat message",
    description="Send a message and get response from AI assistant"
)
async def send_chat_message(
    request: ChatRequest,
    runtime: RuntimeEngine = Depends(get_runtime_engine),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Send chat message and get response.
    
    Payload validated via Pydantic ChatRequest model.
    """
    try:
        message = request.message
        session_id = request.session_id
        history = request.history
        image_b64 = request.image_b64
        
        # Generate request ID
        request_id = str(uuid.uuid4())
        
        # Stream chat response and collect
        response_text = ""
        chunks = []
        
        async for chunk in runtime.stream_chat(
            client_id=session_id,
            text=message,
            image_b64=image_b64,
            request_id=request_id
        ):
            chunks.append(chunk)
            if chunk.get("type") == "text":
                response_text += chunk.get("content", "")
        
        return JSONResponse({
            "status": "ok",
            "response": response_text,
            "request_id": request_id,
            "session_id": session_id,
            "chunks_count": len(chunks)
        })
        
    except Exception as e:
        logger.error(f"Chat message error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to process chat message"
        )


# =============================================================================
# Chat Streaming Endpoint
# =============================================================================

@router.post(
    "/chat/stream",
    summary="Stream chat response",
    description="Send message and stream the response in real-time"
)
async def stream_chat_message(
    request: ChatRequest,
    http_request: Request,
    runtime: RuntimeEngine = Depends(get_runtime_engine),
    _context: dict = Depends(setup_request_context)
) -> StreamingResponse:
    """
    Stream chat response in real-time.
    
    Returns Server-Sent Events (SSE) stream.
    Payload validated via Pydantic ChatRequest model.
    Handles client disconnect cleanup.
    """
    try:
        message = request.message
        session_id = request.session_id
        image_b64 = request.image_b64
        
        request_id = str(uuid.uuid4())
        
        async def event_stream():
            """Generate SSE stream with disconnect detection."""
            try:
                async for chunk in runtime.stream_chat(
                    client_id=session_id,
                    text=message,
                    image_b64=image_b64,
                    request_id=request_id
                ):
                    # Check for client disconnect
                    if await http_request.is_disconnected():
                        logger.info(f"Client disconnected for request {request_id}")
                        await runtime.stop_generation(request_id)
                        break
                    
                    # Send as JSON lines
                    yield f"data: {json.dumps(chunk)}\n\n"
                
                # Send done event if still connected
                if not await http_request.is_disconnected():
                    yield f"data: {json.dumps({'type': 'done', 'request_id': request_id})}\n\n"
                
            except asyncio.CancelledError:
                logger.info(f"Stream cancelled for request {request_id}")
                await runtime.stop_generation(request_id)
                raise
            except Exception as e:
                logger.error(f"Streaming error: {e}", exc_info=True)
                if not await http_request.is_disconnected():
                    yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        
        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Chat stream error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to stream chat"
        )


# =============================================================================
# Chat History Endpoint
# =============================================================================

@router.get(
    "/chat/history/{session_id}",
    summary="Get chat history",
    description="Retrieve chat history for a session"
)
async def get_chat_history(
    session_id: str,
    runtime: RuntimeEngine = Depends(get_runtime_engine),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get chat history for a session.
    
    Note: In-memory history only. For persistent storage, use storage endpoints.
    """
    try:
        # Validate and sanitize session_id using shared function
        try:
            session_id = _validate_session_id(session_id)
        except ValueError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(e)
            )
        
        # Retrieve history from runtime
        messages = await runtime.get_history(session_id)
        
        return JSONResponse({
            "session_id": session_id,
            "messages": messages,
            "message_count": len(messages)
        })
        
    except Exception as e:
        logger.error(f"History retrieval error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve history"
        )

