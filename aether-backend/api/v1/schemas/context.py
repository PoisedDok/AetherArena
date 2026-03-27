"""
Context Management Schemas

Pydantic models for context management API responses.

@.architecture
Incoming: api/v1/endpoints/context.py --- {Dict[str, Any], python}
Processing: schema validation, serialization --- {JOB_VALIDATE_SCHEMA}
Outgoing: HTTP clients --- {json}
"""

from pydantic import BaseModel, Field
from typing import Dict, List, Optional, Literal, Any
from datetime import datetime


class ContextStatusResponse(BaseModel):
    """Response model for context status."""
    
    chat_id: str = Field(..., description="Chat UUID")
    message_count: int = Field(..., description="Number of messages in conversation")
    token_count: int = Field(..., description="Estimated token count")
    token_limit: int = Field(..., description="Maximum tokens allowed")
    usage_percent: float = Field(..., description="Token usage percentage")
    status: Literal["new", "normal", "warning", "high", "critical"] = Field(
        ..., description="Context status level"
    )
    needs_summarization: bool = Field(..., description="Whether summarization is recommended")
    recommend_new_chat: bool = Field(..., description="Whether starting new chat is recommended")
    thresholds: Dict[str, int] = Field(..., description="Token thresholds for each status level")


class SummarizationResponse(BaseModel):
    """Response model for context summarization."""
    
    success: bool = Field(..., description="Whether summarization succeeded")
    summary_text: Optional[str] = Field(None, description="Generated summary text")
    tokens_before: int = Field(..., description="Token count before summarization")
    tokens_after: int = Field(..., description="Token count after summarization")
    tokens_saved: int = Field(..., description="Tokens saved by summarization")
    message_count: int = Field(..., description="Current message count")


class ContextExportResponse(BaseModel):
    """Response model for context export."""
    
    chat_id: str = Field(..., description="Chat UUID")
    title: str = Field(..., description="Chat title")
    created_at: Optional[datetime] = Field(None, description="Chat creation timestamp")
    summary: str = Field(..., description="Context summary")
    key_points: List[str] = Field(default_factory=list, description="Key points from conversation")
    artifacts_used: List[Dict[str, Any]] = Field(
        default_factory=list, description="Artifacts referenced in conversation"
    )
    token_count: int = Field(..., description="Current token count")
    message_count: int = Field(..., description="Current message count")


class ContextMessage(BaseModel):
    """Individual context message."""
    
    id: Optional[str] = Field(None, description="Message UUID (required for deletion)")
    role: str = Field(..., description="Message role (system, user, assistant, computer)")
    content: Any = Field(..., description="Message content (can be string or dict with type/text)")
    is_system: bool = Field(False, description="Whether this is the system prompt")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Message metadata")


class ContextMessagesResponse(BaseModel):
    """Response model for context messages viewer."""
    
    chat_id: str = Field(..., description="Chat UUID")
    messages: List[ContextMessage] = Field(default_factory=list, description="Current context messages")
    message_count: int = Field(..., description="Number of messages")
    token_count: int = Field(..., description="Estimated token count")
    token_limit: int = Field(..., description="Maximum tokens allowed")
    usage_percent: float = Field(..., description="Token usage percentage")
    thresholds: Dict[str, int] = Field(..., description="Token thresholds for each status level")

