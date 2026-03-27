"""
Chat Application Entities (DTOs)

Immutable application-layer projections for chat, message, and artifact data.
Provides ChatSummary, ChatMessage, ChatArtifact with from_model() constructors for
data transfer between repository layer and API layer.

@.architecture
Incoming: data/database/repositories/chat.py, data/database/models/chat.py --- {ChatRecord, MessageRecord, ArtifactRecord}
Processing: from_model(), to_dict() --- {1 jobs: JOB_TRANSFORM_DATA}
Outgoing: application/chat/service.py, api/v1/endpoints/chat.py --- {ChatSummary, ChatMessage, ChatArtifact}
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional, Protocol
from uuid import UUID


class ChatRecord(Protocol):
	"""Minimal interface required to construct a ChatSummary."""

	id: UUID
	title: str
	description: Optional[str]
	created_at: datetime
	updated_at: datetime
	message_count: Optional[int]
	last_message_at: Optional[datetime]
	metadata: Optional[Dict[str, Any]]
	archived: bool


class MessageRecord(Protocol):
	"""Minimal interface required to construct a ChatMessage."""

	id: UUID
	chat_id: UUID
	role: str
	content: str
	created_at: datetime
	tokens_used: Optional[int]
	correlation_id: Optional[UUID]
	metadata: Optional[Dict[str, Any]]


class ArtifactRecord(Protocol):
	"""Minimal interface required to construct a ChatArtifact."""

	id: UUID
	chat_id: UUID
	message_id: Optional[UUID]
	artifact_id: Optional[str]  # Frontend-generated dedup ID
	type: str
	filename: Optional[str]
	content: Optional[str]
	language: Optional[str]
	metadata: Optional[Dict[str, Any]]
	created_at: datetime
	# ARCHITECTURE FIX: Trail linkage fields for artifact restoration
	subgroup_id: Optional[UUID]
	node_id: Optional[UUID]


@dataclass(frozen=True)
class ChatSummary:
    """Immutable projection of chat metadata."""

    id: UUID
    title: str
    created_at: datetime
    updated_at: datetime
    description: Optional[str] = None
    message_count: int = 0
    last_message_at: Optional[datetime] = None
    metadata: Optional[Dict[str, Any]] = None
    archived: bool = False

    @classmethod
    def from_model(
        cls,
        model: ChatRecord,
        *,
        message_count: Optional[int] = None,
        last_message_at: Optional[datetime] = None,
    ) -> "ChatSummary":
        return cls(
            id=model.id,
            title=model.title,
            created_at=model.created_at,
            updated_at=model.updated_at,
            description=model.description,
            message_count=message_count if message_count is not None else (model.message_count or 0),
            last_message_at=last_message_at if last_message_at is not None else model.last_message_at,
            metadata=model.metadata,
            archived=model.archived,
        )

    def to_dict(self) -> dict:
        """Return serializable dict for response mapping."""
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "message_count": self.message_count,
            "last_message_at": self.last_message_at,
            "metadata": self.metadata,
            "archived": self.archived,
        }


@dataclass(frozen=True)
class ChatMessage:
    """Domain representation of a chat message."""

    id: UUID
    chat_id: UUID
    role: str
    content: str
    created_at: datetime
    token_count: Optional[int] = None
    metadata: Optional[Dict[str, Any]] = None
    parent_message_id: Optional[UUID] = None

    @classmethod
    def from_model(cls, model: MessageRecord) -> "ChatMessage":
        model_metadata = getattr(model, "metadata", None)
        return cls(
            id=model.id,
            chat_id=model.chat_id,
            role=model.role,
            content=model.content,
            created_at=model.created_at,
            token_count=model.tokens_used,
            metadata=dict(model_metadata) if isinstance(model_metadata, dict) else None,
            parent_message_id=model.correlation_id,
        )


@dataclass(frozen=True)
class ChatArtifact:
    """Domain representation of a chat artifact."""

    id: UUID
    chat_id: UUID
    message_id: Optional[UUID]
    artifact_id: Optional[str]  # Frontend-generated dedup ID
    type: str
    filename: Optional[str]
    content: Optional[str]
    language: Optional[str]
    created_at: datetime
    metadata: Optional[Dict[str, Any]]
    # ARCHITECTURE FIX: Trail linkage fields for artifact restoration
    subgroup_id: Optional[UUID] = None
    node_id: Optional[UUID] = None
    # ARCHITECTURE FIX: Execution group for code+output pairing
    execution_group: Optional[str] = None

    @classmethod
    def from_model(cls, model: ArtifactRecord) -> "ChatArtifact":
        return cls(
            id=model.id,
            chat_id=model.chat_id,
            message_id=model.message_id,
            artifact_id=model.artifact_id,  # Include dedup ID
            type=model.type,
            filename=model.filename,
            content=model.content,
            language=model.language,
            created_at=model.created_at,
            metadata=model.metadata,
            # ARCHITECTURE FIX: Include trail linkage
            subgroup_id=model.subgroup_id,
            node_id=model.node_id,
            # ARCHITECTURE FIX: Include execution group for code+output pairing
            execution_group=getattr(model, "execution_group", None),
        )


__all__ = ["ChatSummary", "ChatMessage", "ChatArtifact"]

