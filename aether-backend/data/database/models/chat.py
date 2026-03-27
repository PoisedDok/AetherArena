"""
Chat Data Models - Pydantic models for chat entities

@.architecture
Incoming: data/database/repositories/chat.py, api/v1/endpoints/storage.py --- {database row dicts, API request payloads for validation}
Processing: Pydantic BaseModel validation (Chat, Message, Artifact) --- {JOB_SERIALIZE, JOB_VALIDATE, JOB_VALIDATE_SCHEMA}
Outgoing: data/database/repositories/chat.py, api/v1/endpoints/storage.py --- {validated Pydantic model instances: Chat, Message, Artifact}

Models for:
- Chat: Top-level conversation container
- Message: User/assistant messages with LLM tracking
- Artifact: Generated outputs (code, files, etc)
"""

from datetime import datetime
from typing import Any, Dict, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class Chat(BaseModel):
    """
    Chat model representing a conversation session.
    
    Attributes:
        id: Unique chat identifier (UUID)
        title: Chat title/name
        created_at: Creation timestamp
        updated_at: Last update timestamp
        message_count: Number of messages (from join)
        last_message_at: Timestamp of last message (from join)
    """
    
    id: UUID
    title: str
    description: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    message_count: Optional[int] = None
    last_message_at: Optional[datetime] = None
    metadata: Optional[Dict[str, Any]] = None
    archived: bool = False
    
    class Config:
        from_attributes = True


class Message(BaseModel):
    """
    Message model representing user/assistant interactions.
    
    Attributes:
        id: Unique message identifier (UUID)
        chat_id: Parent chat ID
        role: Message role (user, assistant, system)
        content: Message text content
        timestamp: Message timestamp
        llm_model: Model used for generation (if assistant)
        llm_provider: Provider used (openai, anthropic, etc)
        tokens_used: Token count for LLM call
        correlation_id: Links user message to assistant response
        metadata: Opaque per-message metadata for runtime hydration
        created_at: Creation timestamp
    """
    
    id: UUID
    chat_id: UUID
    role: str = Field(..., pattern="^(user|assistant|system)$")
    content: str
    timestamp: datetime
    sequence_in_chat: int = Field(..., ge=1, description="Timeline sequence number for chat reconstruction")
    llm_model: Optional[str] = None
    llm_provider: Optional[str] = None
    tokens_used: Optional[int] = None
    correlation_id: Optional[UUID] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    
    class Config:
        from_attributes = True


class Artifact(BaseModel):
    """
    Artifact model representing generated outputs.
    
    Attributes:
        id: Unique artifact identifier (UUID)
        chat_id: Parent chat ID
        message_id: Optional link to message that created this
        artifact_id: Frontend-generated ID for compatibility
        type: Artifact type (code, html, output, file, text, markdown, json)
        filename: Optional filename
        content: Artifact content
        language: Optional programming language
        metadata: Additional metadata (JSONB)
        subgroup_id: Optional trail subgroup UUID (for trail linkage)
        node_id: Optional trail node UUID (for trail linkage)
        created_at: Creation timestamp
    """
    
    id: UUID
    chat_id: UUID
    message_id: Optional[UUID] = None
    artifact_id: Optional[str] = None
    type: str = Field(
        ...,
        pattern="^(code|html|output|file|text|markdown|json|console)$"
    )
    filename: Optional[str] = None
    content: Optional[str] = None
    language: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = Field(default=None)
    # ARCHITECTURE FIX: Trail linkage fields for artifact restoration
    subgroup_id: Optional[UUID] = None
    node_id: Optional[UUID] = None
    execution_group: Optional[str] = None
    created_at: datetime
    
    class Config:
        from_attributes = True

