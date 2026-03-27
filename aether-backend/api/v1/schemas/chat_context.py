"""
@.architecture
Incoming: api/v1/endpoints/chat.py, api/v1/endpoints/chat_references.py --- {Dict[str, Any], json}
Processing: Pydantic validation for chat summary and reference payloads --- {JOB_VALIDATE_SCHEMA}
Outgoing: api/v1/endpoints/chat.py, api/v1/endpoints/chat_references.py --- {validated Pydantic model instances}

Chat Context Schemas - Pydantic models for chat summaries and search API.
"""

from pydantic import BaseModel, Field, UUID4
from typing import List, Dict, Any, Optional
from datetime import datetime


# Chat Summary Schemas

class ChatSummaryCreate(BaseModel):
    """Request schema for generating a chat summary."""
    summary_type: str = Field(
        default="full",
        description="Type of summary (full, brief, technical, executive)"
    )
    force_regenerate: bool = Field(
        default=False,
        description="Force regeneration even if summary exists"
    )


class ChatSummaryResponse(BaseModel):
    """Response schema for chat summary."""
    id: UUID4
    chat_id: UUID4
    summary_type: str
    title: Optional[str]
    key_points: List[str]
    entities: Dict[str, Any]
    llm_model: Optional[str]
    created_at: datetime
    updated_at: datetime


# Search Schemas

class ChatSearchRequest(BaseModel):
    """Request schema for searching chats."""
    query: str = Field(..., description="Search query", min_length=1)
    limit: int = Field(default=10, ge=1, le=2000)
    filters: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Optional search filters (backend-defined contract).",
    )


class ChatSearchResult(BaseModel):
    """Single chat search result."""
    chat_id: UUID4
    title: Optional[str]
    key_points: List[str]
    relevance_score: float


class ChatSearchResponse(BaseModel):
    """Response schema for chat search."""
    query: str
    results: List[ChatSearchResult]
    total_count: int


# Chat Reference Schemas

class ChatReferenceCreate(BaseModel):
    """Request schema for creating a chat reference."""
    target_chat_id: UUID4
    reference_type: str = Field(default="context")
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_by: str = Field(default="user")


class ChatReferenceResponse(BaseModel):
    """Response schema for chat reference."""
    id: UUID4
    source_chat_id: UUID4
    target_chat_id: UUID4
    reference_type: str
    metadata: Dict[str, Any]
    created_by: str
    created_at: datetime

