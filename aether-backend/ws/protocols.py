"""
WebSocket Protocol Definitions

Defines message schemas and validation for Aether WebSocket communication.
Based on OpenInterpreter's LMC (Language Model Communication) format with extensions.

@.architecture
Incoming: /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/ws/handlers.py::MessageHandler; /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/ws/hub.py::WebSocketHub --- {Dict[str, Any], json}
Processing: enforce message schemas, sanitize payloads, log validation outcomes --- {JOB_SANITIZE, JOB_VALIDATE_SCHEMA}
Outgoing: /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/ws/handlers.py::MessageHandler --- {Dict[str, Any], json}

Message Types:
- User messages: Text/image inputs from frontend
- Assistant messages: Streaming responses from LLM
- System messages: Server status and control
- Control messages: Stop/cancel/heartbeat

All messages follow JSON format with role/type/content structure.
"""

import logging
from enum import Enum
from typing import Any, Dict, Optional, Literal
from pydantic import BaseModel, Field, field_validator

_logger = logging.getLogger(__name__)

# Import sanitization for message content
try:
    from security.sanitization import sanitize_text
    _SANITIZATION_AVAILABLE = True
except ImportError:
    _SANITIZATION_AVAILABLE = False


class MessageRole(str, Enum):
    """Message role types"""
    USER = "user"
    ASSISTANT = "assistant"
    COMPUTER = "computer"
    SYSTEM = "system"
    SERVER = "server"


class MessageType(str, Enum):
    """Message content types"""
    MESSAGE = "message"
    IMAGE = "image"
    FILE = "file"
    CODE = "code"
    CONSOLE = "console"
    OUTPUT = "output"
    COMMAND = "command"
    AUDIO = "audio"  # Audio chunk (Base64 Opus)
    
    # Control messages
    STOP = "stop"
    CANCEL = "cancel"
    ABORT = "abort"
    CONTEXT_RESET = "context_reset"
    
    # System messages
    PING = "ping"
    PONG = "pong"
    HEARTBEAT = "heartbeat"
    STOPPED = "stopped"
    COMPLETION = "completion"
    ERROR = "error"
    INFO = "info"
    CONTEXT_RESET_ACK = "context_reset_ack"


class BaseMessage(BaseModel):
    """Base message schema"""
    role: MessageRole
    type: MessageType
    id: Optional[str] = None
    
    class Config:
        use_enum_values = True


class ClientMessage(BaseMessage):
    """
    User message from client to server.
    
    CONTRACT: Frontend MUST provide 'id' field (SessionManager-generated ID).
    Backend uses this for request mapping and correlation.
    
    Examples:
        # Text message
        {"role": "user", "type": "message", "content": "Hello", "id": "uuid", "chat_id": "chat-uuid"}
        
        # With image
        {"role": "user", "type": "message", "content": "What's this?", 
         "image": "base64...", "id": "uuid", "chat_id": "chat-uuid"}
    """
    role: Literal[MessageRole.USER] = MessageRole.USER
    type: Literal[MessageType.MESSAGE] = MessageType.MESSAGE
    id: str = Field(..., description="Frontend-generated message ID (SessionManager format) - REQUIRED")
    content: str
    chat_id: Optional[str] = None  # Chat identifier for message context
    chatId: Optional[str] = None   # CamelCase alias for chat_id
    correlation_id: Optional[str] = None  # CRITICAL: Correlation ID for frontend-backend message UUID linkage
    correlationId: Optional[str] = None   # CamelCase alias for correlation_id
    image: Optional[str] = None  # Base64 encoded image
    metadata: Optional[Dict[str, Any]] = None  # Optional hidden message metadata/context
    
    @field_validator('id')
    @classmethod
    def id_not_empty(cls, v):
        """Validate that id is provided and non-empty."""
        if not v or not isinstance(v, str) or not v.strip():
            raise ValueError('id field is required and must be a non-empty string')
        return v.strip()
    
    @field_validator('content')
    @classmethod
    def content_not_empty(cls, v):
        if not v or not v.strip():
            raise ValueError('Content cannot be empty')
        # Sanitize content to prevent injection attacks
        if not _SANITIZATION_AVAILABLE:
            raise ImportError('Sanitization module required but unavailable')
        try:
            return sanitize_text(v, max_length=50000, allow_html=False)
        except (ValueError, TypeError, RuntimeError) as e:
            _logger.error("Sanitization failed: %s", e)
            raise


class AssistantMessage(BaseMessage):
    """
    Assistant streaming response.
    
    Stream format:
        # Start marker
        {"role": "assistant", "type": "message", "start": true, "id": "uuid"}
        
        # Content deltas
        {"role": "assistant", "type": "message", "content": "Hello", "id": "uuid"}
        {"role": "assistant", "type": "message", "content": " world", "id": "uuid"}
        
        # End marker
        {"role": "assistant", "type": "message", "end": true, "id": "uuid"}
    """
    role: Literal[MessageRole.ASSISTANT] = MessageRole.ASSISTANT
    type: Literal[MessageType.MESSAGE] = MessageType.MESSAGE
    content: Optional[str] = None
    start: Optional[bool] = None
    end: Optional[bool] = None


class SystemMessage(BaseMessage):
    """
    System/server status messages.
    
    Examples:
        # Completion
        {"role": "server", "type": "completion", "id": "uuid"}
        
        # Error
        {"role": "server", "type": "error", "message": "...", "id": "uuid"}
        
        # Stopped
        {"role": "server", "type": "stopped", "message": "Generation stopped", 
         "id": "uuid"}
    """
    role: Literal[MessageRole.SERVER] = MessageRole.SERVER
    message: Optional[str] = None
    data: Optional[Dict[str, Any]] = None


class StopMessage(BaseModel):
    """
    Stop/cancel generation request.
    
    Examples:
        {"type": "stop", "id": "uuid"}
        {"role": "user", "type": "stop", "id": "uuid"}
    """
    type: Literal[MessageType.STOP, MessageType.CANCEL, MessageType.ABORT]
    id: Optional[str] = None  # Request ID to stop
    role: Optional[MessageRole] = None


class HeartbeatMessage(BaseModel):
    """
    Heartbeat/ping-pong for connection keepalive.
    
    Examples:
        # Ping from client
        {"type": "ping", "timestamp": 1234567890}
        
        # Pong from server
        {"type": "pong", "timestamp": 1234567890}
    """
    type: Literal[MessageType.PING, MessageType.PONG, MessageType.HEARTBEAT]
    timestamp: Optional[int] = None


class AudioControlMessage(BaseModel):
    """
    Audio stream control.
    
    Examples:
        # Start audio stream
        {"start": true}
        
        # End audio stream
        {"end": true}
    """
    start: Optional[bool] = None
    end: Optional[bool] = None


class ContextResetMessage(BaseModel):
    """
    Context reset when switching/creating chats.
    
    Examples:
        # Reset context for new chat
        {"role": "user", "type": "context_reset", "chat_id": "uuid", "timestamp": 1234567890}
    """
    role: Literal[MessageRole.USER] = MessageRole.USER
    type: Literal[MessageType.CONTEXT_RESET] = MessageType.CONTEXT_RESET
    chat_id: str
    timestamp: Optional[int] = None


class AudioMessage(BaseModel):
    """
    Audio chunk for handsfree mode STT processing.

    Examples:
        # Audio chunk (raw PCM16)
        {"role": "user", "type": "audio", "audio": "base64pcm...", "format": "pcm16", "sampleRate": 16000}

        # Audio chunk (Opus - legacy)
        {"role": "user", "type": "audio", "audio": "base64opus...", "format": "opus"}

        # End marker
        {"role": "user", "type": "audio", "end": true}
    """
    role: Literal[MessageRole.USER] = MessageRole.USER
    type: Literal[MessageType.AUDIO] = MessageType.AUDIO
    audio: Optional[str] = None  # Base64-encoded audio data
    format: Literal["pcm16", "opus", "wav", "webm"] = "pcm16"  # Audio format
    sampleRate: Optional[int] = None  # Sample rate (for raw PCM)
    end: Optional[bool] = None  # End of audio stream marker


# Message validation helper
def validate_message(payload: Dict[str, Any]) -> Optional[BaseModel]:
    """
    Validate and parse incoming message.
    
    CONTRACT: ClientMessage requires 'id' field. Validation failures are logged
    and message is rejected (fail-fast behavior).
    
    Args:
        payload: Raw JSON payload
        
    Returns:
        Parsed message model or None if invalid
    """
    try:
        # Stop/cancel messages
        if payload.get("type") in (MessageType.STOP, MessageType.CANCEL, MessageType.ABORT):
            return StopMessage(**payload)
        
        # Context reset messages
        if payload.get("type") == MessageType.CONTEXT_RESET:
            return ContextResetMessage(**payload)
        
        # Heartbeat messages
        if payload.get("type") in (MessageType.PING, MessageType.PONG, MessageType.HEARTBEAT):
            return HeartbeatMessage(**payload)
        
        # Audio control
        if "start" in payload or "end" in payload:
            if isinstance(payload.get("start"), bool) or isinstance(payload.get("end"), bool):
                return AudioControlMessage(**payload)
        
        # Audio chunks (handsfree mode)
        if payload.get("type") == MessageType.AUDIO:
            return AudioMessage(**payload)
        
        # User messages
        if payload.get("role") == MessageRole.USER:
            if payload.get("type") == MessageType.MESSAGE:
                return ClientMessage(**payload)
        
        # Assistant messages
        if payload.get("role") == MessageRole.ASSISTANT:
            return AssistantMessage(**payload)
        
        # System messages
        if payload.get("role") == MessageRole.SERVER:
            return SystemMessage(**payload)
        
        # Unknown format - return None
        return None
        
    except (ValueError, TypeError, KeyError, AttributeError) as e:
        # Log validation error for debugging (fail-fast: reject invalid messages)
        _logger.warning("Message validation failed: %s: %s", type(e).__name__, e)
        return None


# Import WebSocket constants from config
# These are now loaded from settings for flexibility
from ws.config.constants import (
    WS_SEND_TIMEOUT,  # noqa: F401
    WS_BROADCAST_TIMEOUT,  # noqa: F401
    HEARTBEAT_INTERVAL,  # noqa: F401
    CONNECTION_TIMEOUT,  # noqa: F401
)

