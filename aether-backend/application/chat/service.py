"""
Chat Application Service

Orchestrates chat use-cases: list, create, update, delete chats and messages, manage artifacts.
Bridges HTTP/WebSocket layers to domain and persistence layers.

@.architecture
Incoming: api/v1/endpoints/chat.py, api/dependencies.py --- {SupabaseUnitOfWork, chat_id, message_id}
Processing: list_chats(), create_chat(), delete_chat(), list_messages(), create_message() --- {3 jobs: JOB_MANAGE_STORAGE, JOB_ORCHESTRATE, JOB_TRANSFORM_DATA}
Outgoing: data/database/repositories/chat.py, api/v1/endpoints/chat.py --- {ChatSummary, ChatMessage, ChatArtifact}
"""

from __future__ import annotations

from typing import List, Optional, Iterable, Any, Dict
from uuid import UUID

from config.settings import Settings
from data.database.uow import SupabaseUnitOfWork
from data.database.repositories.chat import ChatRepository
from data.database.models.chat import Chat
from application.chat.entities import ChatSummary, ChatMessage, ChatArtifact
from monitoring import get_logger

logger = get_logger(__name__)

class ChatService:
    """Application service orchestrating chat read operations."""

    def __init__(self, uow: SupabaseUnitOfWork, settings: Optional[Settings] = None) -> None:
        self._uow = uow
        self._repository = ChatRepository(uow.gateway)
        self._settings = settings

    async def list_chats(self, *, skip: int = 0, limit: int = 50) -> List[ChatSummary]:
        """List chats with statistics using optimized view query (3 queries → 1)."""
        try:
            chats_data = await self._repository.list_chats_from_view(
                limit=limit, 
                offset=skip
            )
            
            if not chats_data:
                return []
            
            # View already includes message_count and last_message_at
            summaries: List[ChatSummary] = []
            for data in chats_data:
                # Convert view result to Chat model, then to ChatSummary
                chat = Chat(
                    id=UUID(data['id']),
                    title=data['title'],
                    description=data.get('description'),
                    created_at=data['created_at'],
                    updated_at=data['updated_at'],
                    last_message_at=data.get('last_message_at'),
                    metadata=data.get('metadata'),
                    archived=data.get('archived', False)
                )
                summaries.append(
                    ChatSummary.from_model(
                        chat,
                        message_count=data.get('message_count', 0),
                        last_message_at=data.get('last_message_at')
                    )
                )
            return summaries
        except Exception as e:
            logger.error("Failed to list chats: %s", e, exc_info=True)
            raise

    async def get_chat(self, chat_id: UUID) -> Optional[ChatSummary]:
        try:
            chat = await self._repository.get_chat(chat_id)
            if not chat:
                return None
            stats = await self._repository.get_chat_statistics(chat_id)
            return ChatSummary.from_model(
                chat,
                message_count=stats.get("message_count"),
                last_message_at=chat.last_message_at,
            )
        except Exception as e:
            logger.error("Failed to get chat %s: %s", chat_id, e, exc_info=True)
            raise

    async def create_chat(
        self, 
        title: str,
        description: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> ChatSummary:
        try:
            new_chat = await self._repository.create_chat(
                title=title,
                description=description,
                metadata=metadata
            )
            return ChatSummary.from_model(
                new_chat,
                message_count=0,
                last_message_at=new_chat.last_message_at,
            )
        except Exception as e:
            logger.error("Failed to create chat: %s", e, exc_info=True)
            raise

    async def update_chat(
        self, 
        chat_id: UUID, 
        title: Optional[str] = None,
        description: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        archived: Optional[bool] = None
    ) -> Optional[ChatSummary]:
        try:
            updated_chat = await self._repository.update_chat(
                chat_id, 
                title=title,
                description=description,
                metadata=metadata,
                archived=archived
            )
            if not updated_chat:
                return None
            stats = await self._repository.get_chat_statistics(chat_id)
            return ChatSummary.from_model(
                updated_chat,
                message_count=stats.get("message_count"),
                last_message_at=updated_chat.last_message_at,
            )
        except Exception as e:
            logger.error("Failed to update chat %s: %s", chat_id, e, exc_info=True)
            raise

    async def delete_chat(self, chat_id: UUID) -> bool:
        try:
            return await self._repository.delete_chat(chat_id)
        except Exception as e:
            logger.error("Failed to delete chat %s: %s", chat_id, e, exc_info=True)
            raise

    async def delete_message_group(self, message_id: UUID) -> Dict[str, Any]:
        """Delete a user message and its corresponding assistant response group."""
        try:
            return await self._repository.delete_message_group(message_id)
        except Exception as e:
            logger.error("Failed to delete message group %s: %s", message_id, e, exc_info=True)
            raise

    async def list_messages(
        self,
        chat_id: UUID,
        *,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> List[ChatMessage]:
        try:
            messages = await self._repository.get_messages(chat_id, limit=limit, offset=offset)
            return [ChatMessage.from_model(message) for message in messages]
        except Exception as e:
            logger.error("Failed to list messages for chat %s: %s", chat_id, e, exc_info=True)
            raise

    async def get_message(self, message_id: UUID) -> Optional[ChatMessage]:
        """Get a single message by ID."""
        try:
            message = await self._repository.get_message(message_id)
            if not message:
                return None
            return ChatMessage.from_model(message)
        except Exception as e:
            logger.error("Failed to get message %s: %s", message_id, e, exc_info=True)
            raise

    async def create_message(
        self,
        chat_id: UUID,
        *,
        role: str,
        content: str,
        llm_model: Optional[str] = None,
        llm_provider: Optional[str] = None,
        tokens_used: Optional[int] = None,
        metadata: Optional[dict] = None,
        parent_message_id: Optional[UUID] = None,
    ) -> ChatMessage:
        try:
            new_message = await self._repository.create_message(
                chat_id=chat_id,
                role=role,
                content=content,
                llm_model=llm_model,
                llm_provider=llm_provider,
                tokens_used=tokens_used,
                metadata=metadata,
                parent_message_id=parent_message_id,
            )
            return ChatMessage.from_model(new_message)
        except Exception as e:
            logger.error("Failed to create message for chat %s: %s", chat_id, e, exc_info=True)
            raise

    async def list_artifacts(
        self,
        chat_id: UUID,
        *,
        artifact_type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: int = 0,
    ) -> List[ChatArtifact]:
        try:
            artifacts = await self._repository.get_artifacts(
                chat_id,
                type=artifact_type,
                limit=limit,
                offset=offset,
            )
            return [ChatArtifact.from_model(artifact) for artifact in artifacts]
        except Exception as e:
            logger.error("Failed to list artifacts for chat %s: %s", chat_id, e, exc_info=True)
            raise

    async def create_artifact(
        self,
        chat_id: UUID,
        *,
        artifact_type: str,
        content: Optional[str],
        filename: Optional[str],
        language: Optional[str],
        artifact_id: Optional[str],
        message_id: Optional[UUID],
        metadata: Optional[dict],
        subgroup_id: Optional[UUID] = None,
        node_id: Optional[UUID] = None,
        execution_group: Optional[str] = None,
    ) -> ChatArtifact:
        try:
            metadata = metadata or {}
            
            # Determine if this is a user-uploaded file (not agent-generated)
            is_user_file = metadata.get('role') == 'user' and artifact_type == 'file'
            
            if is_user_file and filename and self._settings:
                # Check file extension
                filename_lower = filename.lower()
                is_image = any(filename_lower.endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
                # Binary documents need Docling extraction (OCR, XML parsing)
                is_binary_document = any(filename_lower.endswith(ext) for ext in [
                    '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
                ])
                # Text documents are already readable — no extraction needed.
                is_text_document = any(filename_lower.endswith(ext) for ext in ['.txt', '.md'])
                
                # Set routing flags based on LLM capabilities and file type
                if is_image:
                    if self._settings.llm.supports_vision:
                        # Vision LLM: images go directly to model
                        metadata['requires_vision'] = False
                        metadata['requires_docling'] = False
                    else:
                        # Text-only LLM: images go to InternVL for description
                        metadata['requires_vision'] = True
                        metadata['requires_docling'] = False
                elif is_binary_document:
                    # Binary documents need Docling for text extraction
                    metadata['requires_vision'] = False
                    metadata['requires_docling'] = True
                elif is_text_document:
                    # Text files are already readable — DocumentUtility handles
                    # budget-fitting in the generic artifact path.
                    metadata['requires_vision'] = False
                    metadata['requires_docling'] = False

            new_artifact = await self._repository.create_artifact(
                chat_id=chat_id,
                type=artifact_type,
                content=content,
                filename=filename,
                language=language,
                artifact_id=artifact_id,
                message_id=message_id,
                metadata=metadata,
                subgroup_id=subgroup_id,
                node_id=node_id,
                execution_group=execution_group,
            )
            return ChatArtifact.from_model(new_artifact)
        except Exception as e:
            logger.error("Failed to create artifact for chat %s: %s", chat_id, e, exc_info=True)
            raise

    async def update_artifact_message_id(
        self,
        artifact_id: str,
        message_id: UUID,
    ) -> Iterable[ChatArtifact]:
        try:
            updated = await self._repository.update_artifact_message_id(
                artifact_id=artifact_id,
                message_id=message_id,
            )
            return [ChatArtifact.from_model(artifact) for artifact in updated]
        except Exception as e:
            logger.error("Failed to update artifact message_id for artifact %s: %s", artifact_id, e, exc_info=True)
            raise

    async def get_message_artifacts(self, message_id: UUID) -> List[ChatArtifact]:
        try:
            artifacts = await self._repository.get_message_artifacts(message_id)
            return [ChatArtifact.from_model(artifact) for artifact in artifacts]
        except Exception as e:
            logger.error("Failed to get message artifacts for message %s: %s", message_id, e, exc_info=True)
            raise

    async def get_artifact_source(self, artifact_id: UUID) -> Optional[ChatMessage]:
        try:
            message = await self._repository.get_artifact_source(artifact_id)
            if not message:
                return None
            return ChatMessage.from_model(message)
        except Exception as e:
            logger.error("Failed to get artifact source for artifact %s: %s", artifact_id, e, exc_info=True)
            raise

    async def get_artifact(self, artifact_id: UUID) -> Optional[ChatArtifact]:
        """Get artifact by ID."""
        try:
            artifact = await self._repository.get_artifact(artifact_id)
            if not artifact:
                return None
            return ChatArtifact.from_model(artifact)
        except Exception as e:
            logger.error("Failed to get artifact %s: %s", artifact_id, e, exc_info=True)
            raise

    async def update_artifact(
        self,
        artifact_id: UUID,
        *,
        content: Optional[str] = None,
        filename: Optional[str] = None,
        language: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> Optional[ChatArtifact]:
        """Update artifact fields."""
        try:
            updated_artifact = await self._repository.update_artifact(
                artifact_id,
                content=content,
                filename=filename,
                language=language,
                metadata=metadata,
            )
            if not updated_artifact:
                return None
            return ChatArtifact.from_model(updated_artifact)
        except Exception as e:
            logger.error("Failed to update artifact %s: %s", artifact_id, e, exc_info=True)
            raise

    async def delete_artifact(self, artifact_id: UUID) -> bool:
        """Delete artifact by ID."""
        try:
            return await self._repository.delete_artifact(artifact_id)
        except Exception as e:
            logger.error("Failed to delete artifact %s: %s", artifact_id, e, exc_info=True)
            raise

    async def search_chats(
        self,
        query: str,
        limit: int = 20,
        filters: Optional[dict] = None
    ) -> List[Any]:
        """Search chats by title, content, or semantic similarity."""
        try:
            return await self._repository.search_chats(
                query=query,
                limit=limit,
                filters=filters
            )
        except Exception as e:
            logger.error("Failed to search chats: %s", e, exc_info=True)
            raise

    async def get_chat_reference_by_chats(
        self, source_chat_id: UUID, target_chat_id: UUID
    ) -> Optional[Dict[str, Any]]:
        try:
            return await self._repository.get_chat_reference_by_chats(source_chat_id, target_chat_id)
        except Exception as e:
            logger.error("Failed to get chat reference: %s", e, exc_info=True)
            raise

    async def create_chat_reference(
        self,
        source_chat_id: UUID,
        target_chat_id: UUID,
        reference_type: str = "context",
        metadata: Optional[Dict[str, Any]] = None,
        created_by: str = "user",
    ) -> Dict[str, Any]:
        try:
            target_chat = await self.get_chat(target_chat_id)
            if not target_chat:
                from core.exceptions import ResourceNotFoundError
                raise ResourceNotFoundError(f"Target chat {target_chat_id} not found")

            return await self._repository.create_chat_reference(
                source_chat_id=source_chat_id,
                target_chat_id=target_chat_id,
                reference_type=reference_type,
                metadata=metadata,
                created_by=created_by,
            )
        except Exception as e:
            logger.error("Failed to create chat reference: %s", e, exc_info=True)
            raise

    async def list_chat_references(
        self,
        chat_id: UUID,
        direction: str = "both",
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        try:
            return await self._repository.list_chat_references(
                chat_id=chat_id,
                direction=direction,
                limit=limit,
                offset=offset,
            )
        except Exception as e:
            logger.error("Failed to list chat references for chat %s: %s", chat_id, e, exc_info=True)
            raise

    async def delete_chat_reference(self, reference_id: UUID) -> bool:
        try:
            return await self._repository.delete_chat_reference(reference_id)
        except Exception as e:
            logger.error("Failed to delete chat reference %s: %s", reference_id, e, exc_info=True)
            raise

    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass

__all__ = ["ChatService"]
