"""
Chat Endpoints

HTTP API for chat streaming, message history, and session management.
Validates payloads, enforces security limits, and streams responses via SSE.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP POST/GET) --- {ChatCreate, MessageCreate, session_id, /v1/create/chat}
Processing: stream_chat(), get_history(), reset_context(), validate_session_id() --- {6 jobs: JOB_ORCHESTRATE, JOB_ROUTE, JOB_SANITIZE, JOB_SERIALIZE, JOB_TRANSFORM_DATA, JOB_VALIDATE_SCHEMA}
Outgoing: core/runtime/engine.py, Frontend (SSE/JSON) --- {StreamingResponse, ChatResponse, MessageResponse}
"""

from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.responses import StreamingResponse, JSONResponse
import uuid
import json
import asyncio

from core.exceptions import DomainException
from api.dependencies import setup_request_context, get_runtime_engine
from core.runtime.engine import RuntimeEngine
from monitoring import get_logger
from security.sanitization import sanitize_text, DEFAULT_LIMITS
from pydantic import BaseModel, Field, field_validator
import base64

logger = get_logger(__name__)
router = APIRouter(tags=["chat"])
action_router = APIRouter(prefix="/create", tags=["create"])

# Security constants -- sourced from central SizeLimits
MAX_MESSAGE_LENGTH = DEFAULT_LIMITS.MAX_PROMPT_LENGTH       # 50K characters
MAX_IMAGE_B64_SIZE = DEFAULT_LIMITS.MAX_IMAGE_SIZE_BYTES    # 10MB base64 (≈7.5MB actual)


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
    session_id: Optional[str] = Field(None, description="Session identifier (falls back to X-Session-Id header, then 'default')", max_length=255)
    history: List[Dict[str, Any]] = Field(default_factory=list, description="Optional conversation history")
    image_b64: Optional[str] = Field(None, description="Optional base64 encoded image")
    show_thinking: bool = Field(True, description="Whether to include AI reasoning/thinking in the response")
    
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
        """Validate session ID format. None is allowed (header fallback)."""
        if v is None:
            return v
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


class StopGenerationRequest(BaseModel):
    """Request to stop an active generation."""
    request_id: Optional[str] = Field(None, description="Backend request_id to stop")
    session_id: Optional[str] = Field(None, description="Session/chat ID to stop all active requests")
    
    @field_validator('request_id')
    @classmethod
    def validate_request_id(cls, v):
        if v is None:
            return v
        if not isinstance(v, str) or not v.strip():
            raise ValueError("request_id must be a non-empty string if provided")
        return v.strip()
    
    @field_validator('session_id')
    @classmethod
    def validate_stop_session_id(cls, v):
        if v is None:
            return v
        return _validate_session_id(v)


# =============================================================================
# Chat Message Endpoint (main chat route)
# =============================================================================

@action_router.post(
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
        image_b64 = request.image_b64
        context_request_id = _context.get("request_id")
        request_id = context_request_id or str(uuid.uuid4())
        correlation_id = _context.get("correlation_id")
        frontend_id = _context.get("frontend_id")
        operator_id = _context.get("operator_id")
        header_session = _context.get("session_id")
        session_id = session_id or header_session or "default"
        
        # Stream chat response and collect
        response_text = ""
        chunks = []
        
        async for chunk in runtime.stream_chat(
            message=message,
            session_id=session_id,
            client_id=session_id,
            image_b64=image_b64,
            request_id=request_id,
            show_thinking=request.show_thinking,
        ):
            chunks.append(chunk)
            if chunk.get("type") in ("message", "text"):
                response_text += chunk.get("content", "")
        
        return JSONResponse({
            "status": "ok",
            "response": response_text,
            "request_id": request_id,
            "correlation_id": correlation_id,
            "frontend_id": frontend_id,
            "operator_id": operator_id,
            "session_id": session_id,
            "chunks_count": len(chunks)
        })
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Chat message error: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to process chat message"
        )


# =============================================================================
# Chat Streaming Endpoint
# =============================================================================

@action_router.post(
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
        header_session = _context.get("session_id")
        session_id = session_id or header_session or "default"
        correlation_id = _context.get("correlation_id")
        frontend_id = _context.get("frontend_id")
        operator_id = _context.get("operator_id")
        user_id = _context.get("user_id")
        context_request_id = _context.get("request_id")
        request_id = context_request_id or str(uuid.uuid4())
        
        async def event_stream():
            """Generate SSE stream with disconnect detection."""
            try:
                async for chunk in runtime.stream_chat(
                    message=message,
                    session_id=session_id,
                    client_id=session_id,
                    image_b64=image_b64,
                    request_id=request_id,
                ):
                    # Check for client disconnect
                    if await http_request.is_disconnected():
                        logger.info(
                            "Client disconnected for request %s",
                            request_id,
                            extra={
                                "correlation_id": correlation_id,
                                "frontend_id": frontend_id,
                                "session_id": session_id,
                            },
                        )
                        try:
                            await runtime.stop_generation(request_id)
                        except Exception as stop_err:
                            logger.warning("Failed to stop generation on disconnect: %s", stop_err)
                        break
                    
                    enriched_chunk = dict(chunk)
                    enriched_chunk.setdefault("request_id", request_id)
                    if correlation_id:
                        enriched_chunk.setdefault("correlation_id", correlation_id)
                    if frontend_id:
                        enriched_chunk.setdefault("frontend_id", frontend_id)
                    if session_id:
                        enriched_chunk.setdefault("session_id", session_id)
                    if operator_id:
                        enriched_chunk.setdefault("operator_id", operator_id)
                    if user_id:
                        enriched_chunk.setdefault("user_id", user_id)
                    
                    # Send as JSON lines
                    yield f"data: {json.dumps(enriched_chunk)}\n\n"
                
                # Send done event if still connected
                if not await http_request.is_disconnected():
                    completion_payload = {
                        "type": "done",
                        "request_id": request_id,
                    }
                    if correlation_id:
                        completion_payload["correlation_id"] = correlation_id
                    if frontend_id:
                        completion_payload["frontend_id"] = frontend_id
                    if session_id:
                        completion_payload["session_id"] = session_id
                    if operator_id:
                        completion_payload["operator_id"] = operator_id
                    if user_id:
                        completion_payload["user_id"] = user_id
                    yield f"data: {json.dumps(completion_payload)}\n\n"
                
            except asyncio.CancelledError:
                logger.info(
                    "Stream cancelled for request %s",
                    request_id,
                    extra={
                        "correlation_id": correlation_id,
                        "frontend_id": frontend_id,
                        "session_id": session_id,
                    },
                )
                try:
                    await runtime.stop_generation(request_id)
                except Exception as stop_err:
                    logger.warning("Failed to stop generation on cancel: %s", stop_err)
                raise
            except (HTTPException, DomainException):
                raise
            except Exception as e:
                logger.error(
                    "Streaming error: %s",
                    e,
                    exc_info=True,
                    extra={
                        "correlation_id": correlation_id,
                        "frontend_id": frontend_id,
                        "session_id": session_id,
                    },
                )
                if not await http_request.is_disconnected():
                    error_payload = {
                        "type": "error",
                        "message": "Operation failed. Check server logs for details.",
                        "request_id": request_id,
                    }
                    if correlation_id:
                        error_payload["correlation_id"] = correlation_id
                    if frontend_id:
                        error_payload["frontend_id"] = frontend_id
                    if session_id:
                        error_payload["session_id"] = session_id
                    if operator_id:
                        error_payload["operator_id"] = operator_id
                    if user_id:
                        error_payload["user_id"] = user_id
                    yield f"data: {json.dumps(error_payload)}\n\n"
        
        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Chat stream error: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to stream chat"
        )


# =============================================================================
# Stop Generation Endpoint
# =============================================================================

@router.post(
    "/stop-generation",
    summary="Stop active generation",
    description="Stop an active LLM generation by request_id or session_id"
)
async def stop_generation(
    request: StopGenerationRequest,
    runtime: RuntimeEngine = Depends(get_runtime_engine),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Stop active generation.
    
    - If request_id is provided, stop that request.
    - Otherwise, stop all active requests for the provided session_id (chat).
    """
    try:
        # Do NOT fall back to _context["request_id"] — that is the HTTP middleware
        # tracing ID, not a generation request_id. Using it would attempt to stop
        # a non-existent generation.
        request_id = request.request_id
        session_id = request.session_id or _context.get("session_id")
        
        stopped = 0
        if request_id:
            was_stopped = await runtime.stop_generation(request_id)
            stopped = 1 if was_stopped else 0
        elif session_id:
            stopped = await runtime.stop_session_generations(session_id)
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="request_id or session_id is required"
            )
        
        return JSONResponse({
            "status": "ok",
            "stopped": stopped,
            "request_id": request_id,
            "session_id": session_id,
        })
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Stop generation failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to stop generation"
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
            logger.warning("Invalid session_id: %s", e)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid session identifier. Check server logs for details."
            )
        
        # Retrieve history from runtime
        messages = await runtime.get_history(session_id)
        
        return JSONResponse({
            "session_id": session_id,
            "messages": messages,
            "message_count": len(messages)
        })
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("History retrieval error: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve history"
        )

