"""
WebSocket Protocol Definitions

Defines message schemas and validation for Aether WebSocket communication.
Based on OpenInterpreter's LMC (Language Model Communication) format with extensions.

@.architecture
Incoming: ws/handlers.py, ws/hub.py --- {raw JSON payloads from WebSocket messages}
Processing: validate_message(), Pydantic model validation, content sanitization --- {4 jobs: data_validation, message_parsing, sanitization, schema_validation}
Outgoing: ws/handlers.py --- {Pydantic message models: ClientMessage, AssistantMessage, SystemMessage, StopMessage, HeartbeatMessage, AudioControlMessage}

Message Types:
- User messages: Text/image inputs from frontend
- Assistant messages: Streaming responses from LLM
- System messages: Server status and control
- Control messages: Stop/cancel/heartbeat

All messages follow JSON format with role/type/content structure.
"""

from enum import Enum
from typing import Any, Dict, Optional, Literal
from pydantic import BaseModel, Field, validator

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
    SYSTEM = "system"
    SERVER = "server"


class MessageType(str, Enum):
    """Message content types"""
    MESSAGE = "message"
    IMAGE = "image"
    FILE = "file"
    CODE = "code"
    CONSOLE = "console"
    COMMAND = "command"
    
    # Control messages
    STOP = "stop"
    CANCEL = "cancel"
    ABORT = "abort"
    
    # System messages
    PING = "ping"
    PONG = "pong"
    HEARTBEAT = "heartbeat"
    STOPPED = "stopped"
    COMPLETION = "completion"
    ERROR = "error"
    INFO = "info"


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
    
    Examples:
        # Text message
        {"role": "user", "type": "message", "content": "Hello", "id": "uuid"}
        
        # With image
        {"role": "user", "type": "message", "content": "What's this?", 
         "image": "base64...", "id": "uuid"}
    """
    role: Literal[MessageRole.USER] = MessageRole.USER
    type: Literal[MessageType.MESSAGE] = MessageType.MESSAGE
    content: str
    image: Optional[str] = None  # Base64 encoded image
    
    @validator('content')
    def content_not_empty(cls, v):
        if not v or not v.strip():
            raise ValueError('Content cannot be empty')
        # Sanitize content to prevent injection attacks
        if not _SANITIZATION_AVAILABLE:
            raise ImportError('Sanitization module required but unavailable')
        try:
            import logging
            return sanitize_text(v, max_length=10000, allow_html=False)
        except Exception as e:
            logging.error(f"Sanitization failed: {str(e)}")
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


# Message validation helper
def validate_message(payload: Dict[str, Any]) -> Optional[BaseModel]:
    """
    Validate and parse incoming message.
    
    Args:
        payload: Raw JSON payload
        
    Returns:
        Parsed message model or None if invalid
    """
    try:
        # Stop/cancel messages
        if payload.get("type") in (MessageType.STOP, MessageType.CANCEL, MessageType.ABORT):
            return StopMessage(**payload)
        
        # Heartbeat messages
        if payload.get("type") in (MessageType.PING, MessageType.PONG, MessageType.HEARTBEAT):
            return HeartbeatMessage(**payload)
        
        # Audio control
        if "start" in payload or "end" in payload:
            if isinstance(payload.get("start"), bool) or isinstance(payload.get("end"), bool):
                return AudioControlMessage(**payload)
        
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
        
    except Exception:
        return None


# Protocol constants
WS_SEND_TIMEOUT = 3.0  # Timeout for sending to single client
WS_BROADCAST_TIMEOUT = 5.0  # Timeout for broadcasting
HEARTBEAT_INTERVAL = 30.0  # Heartbeat interval in seconds
CONNECTION_TIMEOUT = 300.0  # Connection timeout in seconds

