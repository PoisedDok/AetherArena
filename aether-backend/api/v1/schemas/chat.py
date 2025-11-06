"""
Chat Schemas

Pydantic models for chat and messaging endpoints.

@.architecture
Incoming: api/v1/endpoints/chat.py, api/v1/endpoints/storage.py --- {JSON request payloads, database records}
Processing: Pydantic validation and serialization --- {2 jobs: data_validation, serialization}
Outgoing: api/v1/endpoints/chat.py, api/v1/endpoints/storage.py --- {ChatCreate, ChatUpdate, ChatResponse, MessageCreate, MessageResponse, ArtifactCreate validated models}
"""

from typing import List, Optional, Dict, Any
from datetime import datetime
from uuid import UUID
from pydantic import BaseModel, Field


# =============================================================================
# Chat Models
# =============================================================================

class ChatCreate(BaseModel):
    """Request to create a new chat."""
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=500)
    metadata: Optional[Dict[str, Any]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "title": "Code Review Discussion",
                "description": "Discussing Python code improvements",
                "metadata": {"tags": ["code", "python"]}
            }
        }


class ChatUpdate(BaseModel):
    """Request to update a chat."""
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=500)
    metadata: Optional[Dict[str, Any]] = None
    archived: Optional[bool] = None


class ChatResponse(BaseModel):
    """Chat information response."""
    id: UUID
    title: str
    description: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    message_count: int = 0
    archived: bool = False
    metadata: Optional[Dict[str, Any]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "title": "Code Review Discussion",
                "description": "Discussing Python code improvements",
                "created_at": "2024-11-04T12:00:00Z",
                "updated_at": "2024-11-04T12:30:00Z",
                "message_count": 15,
                "archived": False,
                "metadata": {"tags": ["code", "python"]}
            }
        }


# =============================================================================
# Message Models
# =============================================================================

class MessageCreate(BaseModel):
    """Request to create a message."""
    role: str = Field(..., pattern="^(user|assistant|system)$")
    content: str = Field(..., min_length=1)
    llm_model: Optional[str] = None
    llm_provider: Optional[str] = None
    tokens_used: Optional[int] = None
    metadata: Optional[Dict[str, Any]] = None
    parent_message_id: Optional[UUID] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "role": "user",
                "content": "Can you help me optimize this function?",
                "llm_model": "gpt-4",
                "llm_provider": "openai",
                "metadata": {"custom": "data"}
            }
        }


class MessageResponse(BaseModel):
    """Message information response."""
    id: UUID
    chat_id: UUID
    role: str
    content: str
    created_at: datetime
    metadata: Optional[Dict[str, Any]] = None
    parent_message_id: Optional[UUID] = None
    token_count: Optional[int] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "id": "650e8400-e29b-41d4-a716-446655440001",
                "chat_id": "550e8400-e29b-41d4-a716-446655440000",
                "role": "user",
                "content": "Can you help me optimize this function?",
                "created_at": "2024-11-04T12:00:00Z",
                "metadata": {"model": "gpt-4"},
                "token_count": 12
            }
        }


# =============================================================================
# Artifact Models
# =============================================================================

class ArtifactCreate(BaseModel):
    """Request to create an artifact."""
    type: str = Field(...)
    content: Optional[str] = None
    filename: Optional[str] = None
    language: Optional[str] = None
    artifact_id: Optional[str] = None
    message_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "type": "code",
                "filename": "optimized_function.py",
                "content": "def optimized_function():\\n    pass",
                "language": "python",
                "message_id": "650e8400-e29b-41d4-a716-446655440001"
            }
        }


class ArtifactResponse(BaseModel):
    """Artifact information response."""
    id: UUID
    chat_id: UUID
    message_id: Optional[UUID] = None
    type: str
    title: str
    content: str
    language: Optional[str] = None
    file_path: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    metadata: Optional[Dict[str, Any]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "id": "750e8400-e29b-41d4-a716-446655440002",
                "chat_id": "550e8400-e29b-41d4-a716-446655440000",
                "message_id": "650e8400-e29b-41d4-a716-446655440001",
                "type": "code",
                "title": "optimized_function.py",
                "content": "def optimized_function():\\n    pass",
                "language": "python",
                "created_at": "2024-11-04T12:00:00Z",
                "updated_at": "2024-11-04T12:00:00Z"
            }
        }


# =============================================================================
# Chat Session Models
# =============================================================================

class ChatSessionResponse(BaseModel):
    """Complete chat session with messages."""
    chat: ChatResponse
    messages: List[MessageResponse]
    artifacts: List[ArtifactResponse] = Field(default_factory=list)


# =============================================================================
# Artifact Update Models
# =============================================================================

class ArtifactUpdateMessageIdRequest(BaseModel):
    """Request to update artifact message ID linkage."""
    artifact_id: str = Field(..., description="Frontend-generated artifact ID")
    message_id: UUID = Field(..., description="PostgreSQL message UUID to link to")
    chat_id: Optional[UUID] = Field(None, description="Optional chat ID for additional filtering")
    
    class Config:
        json_schema_extra = {
            "example": {
                "artifact_id": "artifact_1762369978272_abc123",
                "message_id": "650e8400-e29b-41d4-a716-446655440001",
                "chat_id": "550e8400-e29b-41d4-a716-446655440000"
            }
        }


class ArtifactUpdateMessageIdResponse(BaseModel):
    """Response for artifact message ID update."""
    success: bool
    updated_count: int = Field(default=0, description="Number of artifacts updated")
    message: str
    artifact_id: Optional[str] = None
    message_id: Optional[UUID] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "success": True,
                "updated_count": 1,
                "message": "Artifact linked to message successfully",
                "artifact_id": "artifact_1762369978272_abc123",
                "message_id": "650e8400-e29b-41d4-a716-446655440001"
            }
        }


# =============================================================================
# Streaming Models
# =============================================================================

class StreamChunk(BaseModel):
    """Streaming chat response chunk."""
    type: str = Field(..., pattern="^(text|tool_call|error|done)$")
    content: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "type": "text",
                "content": "Here is the optimized version...",
                "metadata": {"model": "gpt-4"}
            }
        }

