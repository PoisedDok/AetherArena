"""
@.architecture
Incoming: api/v1/endpoints/memories.py --- {Dict[str, Any], json}
Processing: Pydantic validation for memory CRUD payloads --- {JOB_VALIDATE_SCHEMA}
Outgoing: api/v1/endpoints/memories.py --- {validated Pydantic model instances}

Memory API Schemas - Pydantic models for memory management endpoints.
"""

from typing import List, Dict, Any, Optional, Literal
from pydantic import BaseModel, Field
from uuid import UUID
from datetime import datetime


class MemoryCreate(BaseModel):
    """Schema for creating a new memory."""
    content: str = Field(..., description="Memory content")
    memory_type: Literal["fact", "decision", "preference", "action_item", "insight", "reference"] = Field("fact", description="Memory type (fact, decision, preference, action_item, insight, reference)")
    importance_score: Optional[float] = Field(None, ge=0.0, le=1.0, description="Importance score (0.0-1.0)")
    source_chat_id: Optional[UUID] = Field(None, description="Source chat ID")
    source_message_id: Optional[UUID] = Field(None, description="Source message ID")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Additional metadata")
    created_by: Literal["agent", "user", "system"] = Field("user", description="Creator (user, agent, system)")


class MemoryUpdate(BaseModel):
    """Schema for updating a memory."""
    content: Optional[str] = Field(None, description="Updated content")
    memory_type: Optional[Literal["fact", "decision", "preference", "action_item", "insight", "reference"]] = Field(None, description="Updated memory type")
    importance_score: Optional[float] = Field(None, ge=0.0, le=1.0, description="Updated importance score")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Updated metadata")


class MemoryResponse(BaseModel):
    """Schema for memory response."""
    id: UUID
    content: str
    memory_type: str
    importance_score: float
    source_chat_id: Optional[UUID]
    source_message_id: Optional[UUID]
    extracted_at: datetime
    last_accessed_at: Optional[datetime]
    access_count: int
    metadata: Dict[str, Any]
    created_by: str
    updated_at: datetime
    expires_at: Optional[datetime]


class MemorySearchRequest(BaseModel):
    """Schema for memory search request."""
    query: str = Field(..., description="Search query")
    search_type: str = Field("vector", description="Search type (vector or hybrid)")
    match_threshold: float = Field(0.5, ge=0.0, le=1.0, description="Similarity threshold")
    match_count: int = Field(10, ge=1, le=100, description="Number of results")
    memory_type: Optional[str] = Field(None, description="Filter by memory type")
    semantic_weight: float = Field(0.7, ge=0.0, le=1.0, description="Semantic weight for hybrid search")
    keyword_weight: float = Field(0.3, ge=0.0, le=1.0, description="Keyword weight for hybrid search")


class MemorySearchResponse(BaseModel):
    """Schema for memory search response."""
    results: List[Dict[str, Any]]
    total: int


class MemoryRelationCreate(BaseModel):
    """Schema for creating a memory relation."""
    related_memory_id: UUID = Field(..., description="ID of related memory")
    relation_type: Literal["contradicts", "supports", "supersedes", "related_to", "expands_on"] = Field(..., description="Relation type (contradicts, supports, supersedes, related_to, expands_on)")
    strength: float = Field(0.5, ge=0.0, le=1.0, description="Relation strength")


class MemoryRelationResponse(BaseModel):
    """Schema for memory relation response."""
    id: UUID
    memory_id: UUID
    related_memory_id: UUID
    relation_type: str
    strength: float
    created_at: datetime


class MemoryPromoteRequest(BaseModel):
    """Schema for promoting a memory to global."""
    boost_importance: Optional[float] = Field(None, ge=0.0, le=0.5, description="Amount to boost importance score")


class MemoryDemoteRequest(BaseModel):
    """Schema for demoting a memory to chat-specific."""
    chat_id: UUID = Field(..., description="Chat ID to assign this memory to")


class MemoryPromotionResponse(BaseModel):
    """Schema for promotion/demotion response."""
    memory: MemoryResponse
    message: str

