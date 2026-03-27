"""
Chat Repository

Persistence layer for chat, message, and artifact CRUD via Supabase SDK.
No raw SQL; all operations use Supabase REST API.

@.architecture
Incoming: application/chat/service.py, data/database/uow.py --- {SupabasePersistenceGateway, chat_id, message_id, artifact_id}
Processing: create_chat(), get_messages(), create_artifact(), delete_chat() --- {2 jobs: JOB_MANAGE_STORAGE, JOB_TRANSFORM_DATA}
Outgoing: data/database/models/chat.py, application/chat/service.py --- {Chat, Message, Artifact}
"""

from core.domain.repository_interfaces import IChatRepository

import asyncio
import logging
from typing import Any, Dict, List, Optional, Union
from uuid import UUID
from datetime import datetime, timedelta, timezone

from ..clients.supabase import SupabaseClient
from ..models.chat import Artifact, Chat, Message
from ..persistence_gateway import SupabasePersistenceGateway

logger = logging.getLogger(__name__)


class ChatRepository(IChatRepository):
    """
    Repository for chat-related database operations using Supabase SDK.
    
    Provides clean API for:
    - Chat CRUD operations
    - Message persistence and retrieval
    - Artifact management
    
    All methods use Supabase REST API (no raw SQL).
    """
    
    def __init__(self, db=None, *, session=None):
        """
        Initialize chat repository.
        
        Args:
            db: Supabase persistence gateway or raw Supabase client
            session: Legacy SQLAlchemy session (no longer supported)
        """
        if session is not None:
            raise RuntimeError(
                "SQLAlchemy sessions are no longer supported. "
                "Initialize ChatRepository with a SupabasePersistenceGateway.",
            )
        if db is None:
            raise ValueError(
                "SupabasePersistenceGateway (or SupabaseClient) instance required for ChatRepository."
            )
        if isinstance(db, SupabasePersistenceGateway):
            self._gateway = db
        elif isinstance(db, SupabaseClient):
            self._gateway = SupabasePersistenceGateway(db)
        else:
            raise TypeError(
                "Unsupported database adapter for ChatRepository. "
                "Expected SupabasePersistenceGateway or SupabaseClient."
            )
        # Backwards compatibility attribute
        self.db = self._gateway
    
    # =========================================================================
    # CHAT OPERATIONS
    # =========================================================================
    
    async def create_chat(
        self, 
        title: str = "New Chat",
        description: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Chat:
        """
        Create a new chat with auto-generated UUID.
        
        Args:
            title: Chat title
            description: Optional description
            metadata: Optional metadata
            
        Returns:
            Created Chat object
            
        Raises:
            Exception: If creation fails
        """
        try:
            data = {"title": title}
            if description:
                data["description"] = description
            if metadata:
                data["metadata"] = metadata
                
            result = await self._gateway.insert("chats", data, admin=True)
            
            if isinstance(result, list):
                result = result[0]
            
            logger.debug(f"Created chat {result['id']} with title '{title}'")
            return Chat(**result)
            
        except Exception as e:
            logger.error(f"Failed to create chat: {e}", exc_info=True)
            raise
    
    async def create_chat_with_id(
        self,
        chat_id: UUID,
        title: str = "New Chat",
        user_id: Optional[UUID] = None
    ) -> Chat:
        """
        Create a new chat with a specific UUID.
        
        This method is used by the WebSocket layer to create chat records
        for client-provided chat_id values, ensuring message persistence
        doesn't fail due to foreign key constraints.
        
        Args:
            chat_id: Specific chat UUID to use
            title: Chat title
            user_id: Optional user UUID
            
        Returns:
            Created Chat object
            
        Raises:
            Exception: If creation fails (including unique constraint violations)
        """
        try:
            data = {
                "id": str(chat_id),
                "title": title
            }
            
            if user_id:
                data["user_id"] = str(user_id)
            
            result = await self._gateway.insert("chats", data, admin=True)
            
            if isinstance(result, list):
                result = result[0]
            
            logger.debug(f"Created chat {chat_id} with title '{title}'")
            return Chat(**result)
            
        except Exception as e:
            logger.error(f"Failed to create chat with id {chat_id}: {e}", exc_info=True)
            raise
    
    async def ensure_chat_exists(
        self,
        chat_id: UUID,
        title: str = "New Chat",
        user_id: Optional[UUID] = None
    ) -> Chat:
        """
        Ensure a chat exists with the given UUID, creating it if necessary.
        
        This method handles race conditions by:
        1. Attempting to fetch the chat
        2. If not found, attempting to create it
        3. If creation fails with unique constraint violation, re-fetching
        
        This is safe for concurrent use - multiple callers with the same chat_id
        will all succeed, with at most one performing the actual creation.
        
        Args:
            chat_id: Chat UUID to ensure exists
            title: Title to use if creating (default: "New Chat")
            user_id: Optional user UUID
            
        Returns:
            Chat object (either existing or newly created)
            
        Raises:
            Exception: For non-retryable database errors
        """
        try:
            # First attempt: check if already exists
            chat = await self.get_chat(chat_id)
            if chat:
                return chat
            
            # Second attempt: try to create
            try:
                return await self.create_chat_with_id(
                    chat_id=chat_id,
                    title=title,
                    user_id=user_id
                )
            except Exception as create_error:
                error_str = str(create_error).lower()
                
                # Check if this is a unique constraint violation
                # PostgreSQL error code 23505 or message containing "duplicate" or "unique"
                if any(indicator in error_str for indicator in ["23505", "duplicate", "unique", "already exists"]):
                    # Another request created it concurrently, fetch it
                    logger.debug(f"Chat {chat_id} created by concurrent request, fetching...")
                    chat = await self.get_chat(chat_id)
                    if chat:
                        return chat
                    # If still not found, this is a critical error
                    logger.error(f"Chat {chat_id} should exist but not found after unique violation")
                
                # Re-raise for non-constraint-violation errors
                raise
                
        except Exception as e:
            logger.error(f"Failed to ensure chat {chat_id} exists: {e}", exc_info=True)
            raise
    
    async def get_or_create_chat_by_title(
        self,
        title: str,
        user_id: Optional[UUID] = None
    ) -> Chat:
        """
        Get a chat by exact title, or create it if it doesn't exist.
        
        Args:
            title: Chat title to find or create
            user_id: Optional user UUID for creation
            
        Returns:
            Existing or newly created Chat object
        """
        try:
            # First attempt: check if already exists
            existing = await self._gateway.select(
                "chats",
                filters={"title": title},
                limit=1,
                admin=True
            )
            
            if existing:
                return Chat(**existing[0])
            
            # Second attempt: create
            # Handle potential race conditions via idempotency/unique constraints
            now_iso = datetime.now(timezone.utc).isoformat()
            import uuid
            new_id = str(uuid.uuid4())
            
            data = {
                "id": new_id,
                "title": title,
                "created_at": now_iso,
                "updated_at": now_iso
            }
            if user_id:
                data["user_id"] = str(user_id)
                
            try:
                result = await self._gateway.insert("chats", data, admin=True)
                if isinstance(result, list):
                    result = result[0]
                logger.debug(f"Created chat {new_id} with title '{title}'")
                return Chat(**result)
            except Exception as create_error:
                error_str = str(create_error).lower()
                # Check if this is a unique constraint violation
                if any(indicator in error_str for indicator in ["23505", "duplicate", "unique", "already exists"]):
                    # Another request created it concurrently, fetch it again
                    logger.debug(f"Chat '{title}' created by concurrent request, fetching...")
                    existing = await self._gateway.select(
                        "chats",
                        filters={"title": title},
                        limit=1,
                        admin=True
                    )
                    if existing:
                        return Chat(**existing[0])
                raise
                
        except Exception as e:
            logger.error(f"Failed to get_or_create_chat_by_title '{title}': {e}", exc_info=True)
            raise

    async def get_chat(self, chat_id: UUID) -> Optional[Chat]:
        """
        Get chat by ID.
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            Chat object or None if not found
        """
        try:
            result = await self._gateway.select(
                "chats",
                filters={"id": str(chat_id)},
                limit=1,
                admin=True
            )
            
            if result:
                return Chat(**result[0])
            return None
            
        except Exception as e:
            logger.error(f"Failed to get chat {chat_id}: {e}", exc_info=True)
            raise
    
    async def list_chats(
        self,
        limit: int = 50,
        offset: int = 0
    ) -> List[Chat]:
        """
        List chats ordered by most recently updated.
        
        Args:
            limit: Maximum number of chats to return
            offset: Number of chats to skip
            
        Returns:
            List of Chat objects
        """
        try:
            result = await self._gateway.select(
                "chats",
                offset=offset,
                limit=limit,
                order_by="updated_at.desc",
                admin=True
            )
            
            return [Chat(**chat) for chat in result]
            
        except Exception as e:
            logger.error(f"Failed to list chats: {e}", exc_info=True)
            raise
    
    async def list_chats_from_view(
        self,
        limit: int = 50,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Fetch chats with pre-aggregated statistics using chat_list view.
        
        Single query instead of 3 (chats + message_counts + artifact_counts).
        View is defined in 00-aether-schema.sql lines 105-116.
        
        Args:
            limit: Maximum number of chats to return
            offset: Number of chats to skip
            
        Returns:
            List of dicts with: id, title, created_at, updated_at, 
            message_count, last_message_at
        """
        try:
            result = await self._gateway.select(
                "chat_list",
                offset=offset,
                limit=limit,
                admin=True
            )
            
            logger.debug(f"Retrieved {len(result) if result else 0} chats from view")
            return result or []
            
        except Exception as e:
            logger.error(f"Failed to list chats from view: {e}", exc_info=True)
            raise

    async def search_chats(
        self,
        *,
        query: str,
        limit: int = 10,
        filters: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Search chats by title and recent message content.

        Design constraints:
        - Supabase REST wrapper does not expose ilike/or filters in a portable way here.
        - We therefore do a bounded scan over recent chats and score matches in Python.
        - This is acceptable given API limit <= 50 and typical chat counts.

        Returns list of dicts compatible with api.v1.schemas.chat_context.ChatSearchResult:
            {"chat_id": str, "title": str|None, "key_points": [str], "relevance_score": float}
        """
        q = (query or "").strip()
        if not q:
            raise ValueError("query must be non-empty")

        limit = int(limit or 10)
        if limit < 1:
            raise ValueError("limit must be >= 1")
        if limit > 50:
            limit = 50

        q_lower = q.lower()
        _ = filters  # Reserved for future server-side filtering (schema compatibility)

        # Phase 1: candidate chats (most recent first)
        candidates = await self.list_chats_from_view(limit=200, offset=0)

        results: List[Dict[str, Any]] = []

        async def fetch_recent_messages_text(chat_id_str: str) -> str:
            # Pull recent messages (bounded) and concatenate content for substring scan.
            # Use raw select to avoid model overhead and to request desc ordering.
            rows = await self._gateway.select(
                "messages",
                filters={"chat_id": chat_id_str},
                order_by="timestamp.desc",
                limit=50,
                admin=True,
            )
            # Keep it deterministic and cheap.
            return "\n".join(
                (row.get("content") or "")
                for row in rows
                if isinstance(row, dict) and isinstance(row.get("content"), str)
            )

        for row in candidates:
            if not isinstance(row, dict):
                continue
            chat_id = row.get("id")
            title = row.get("title")
            if not chat_id:
                continue

            title_str = title if isinstance(title, str) else ""
            title_match = q_lower in title_str.lower()

            relevance = 0.0
            key_points: List[str] = []

            if title_match:
                relevance = 1.0
                key_points.append("Title match")
            else:
                # Only pay the message-scan cost if title didn't match.
                try:
                    recent_text = await fetch_recent_messages_text(str(chat_id))
                except Exception:
                    recent_text = ""
                if recent_text and q_lower in recent_text.lower():
                    relevance = 0.6
                    key_points.append("Recent message match")

            if relevance <= 0.0:
                continue

            results.append(
                {
                    "chat_id": str(chat_id),
                    "title": title if isinstance(title, str) else None,
                    "key_points": key_points,
                    "relevance_score": float(relevance),
                }
            )

            if len(results) >= limit:
                break

        # Already ordered by recency of candidates; keep stable ordering for equal scores.
        results.sort(key=lambda r: float(r.get("relevance_score") or 0.0), reverse=True)
        return results[:limit]
    
    async def update_chat(
        self,
        chat_id: UUID,
        title: Optional[str] = None,
        description: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        archived: Optional[bool] = None
    ) -> Optional[Chat]:
        """
        Update chat properties.
        
        Args:
            chat_id: Chat UUID
            title: New title
            description: New description
            metadata: New metadata
            archived: Archived status
            
        Returns:
            Updated Chat object or None if not found
        """
        try:
            data = {"updated_at": datetime.now(timezone.utc).isoformat()}
            
            if title is not None:
                data["title"] = title
            if description is not None:
                data["description"] = description
            if metadata is not None:
                data["metadata"] = metadata
            if archived is not None:
                data["archived"] = archived
                
            if len(data) == 1: # Only updated_at
                return await self.get_chat(chat_id)
                
            result = await self._gateway.update("chats", data, record_id=str(chat_id), admin=True)
            
            if isinstance(result, list) and result:
                result = result[0]
            
            logger.debug(f"Updated chat {chat_id} fields: {list(data.keys())}")
            return Chat(**result)
            
        except Exception as e:
            logger.error(f"Failed to update chat {chat_id}: {e}", exc_info=True)
            # If record not found, return None
            if "not found" in str(e).lower():
                return None
            raise
    
    async def delete_chat(self, chat_id: UUID) -> bool:
        """
        Delete chat and all associated messages/artifacts (CASCADE).
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            True if deleted, False if not found
        """
        try:
            await self._gateway.delete("chats", record_id=str(chat_id), admin=True)
            logger.debug(f"Deleted chat {chat_id}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to delete chat {chat_id}: {e}", exc_info=True)
            if "not found" in str(e).lower():
                return False
            raise
    
    # =========================================================================
    # MESSAGE OPERATIONS
    # =========================================================================
    
    async def create_message(
        self,
        chat_id: UUID,
        role: str,
        content: str,
        llm_model: Optional[str] = None,
        llm_provider: Optional[str] = None,
        tokens_used: Optional[int] = None,
        timestamp: Optional[datetime] = None,
        parent_message_id: Optional[UUID] = None,
        message_id: Optional[UUID] = None,  # ARCHITECTURAL FIX: Allow specifying UUID for artifact linkage
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Message:
        """
        Create a new message in a chat with sequence-based timeline ordering.
        
        Sequence is atomically assigned via get_next_chat_sequence() RPC.
        
        Args:
            chat_id: Chat UUID
            role: Message role ('user' or 'assistant')
            content: Message content
            llm_model: Optional LLM model name
            llm_provider: Optional LLM provider name
            tokens_used: Optional token count
            timestamp: Optional timestamp (defaults to now)
            parent_message_id: Optional parent message UUID for threading
            message_id: Optional UUID to use (enables artifact linkage via correlation_id)
            metadata: Optional message metadata payload (persisted as JSONB)
            
        Returns:
            Created Message object
        """
        try:
            # CRITICAL: Get next sequence number atomically via RPC
            sequence_result = await self.db.rpc(
                'get_next_chat_sequence',
                {'p_chat_id': str(chat_id)}
            )
            sequence_in_chat = sequence_result
            
            logger.info(f"Assigning sequence {sequence_in_chat} to {role} message in chat {str(chat_id)[:8]}")
            
            data = {
                'sequence_in_chat': sequence_in_chat,  # ★ SEQUENCE-FIRST
                "chat_id": str(chat_id),
                "role": role,
                "content": content,
                "timestamp": (timestamp or datetime.now(timezone.utc)).isoformat(),
                "metadata": dict(metadata) if isinstance(metadata, dict) else {},
            }
            
            # ARCHITECTURAL FIX: Use specified UUID if provided (for artifact linkage)
            if message_id:
                data["id"] = str(message_id)
                logger.info(f"Using specified message UUID: {message_id}")
            
            # Add optional fields if provided
            if llm_model:
                data["llm_model"] = llm_model
            if llm_provider:
                data["llm_provider"] = llm_provider
            if tokens_used is not None:
                data["tokens_used"] = tokens_used
            if parent_message_id:
                data["correlation_id"] = str(parent_message_id)
            
            result = await self._gateway.insert("messages", data, admin=True)
            
            if isinstance(result, list):
                result = result[0]
            
            logger.debug(f"Created message {result['id']} in chat {chat_id}")
            return Message(**result)
            
        except Exception as e:
            logger.error(f"Failed to create message: {e}", exc_info=True)
            raise
    
    async def get_message(self, message_id: UUID) -> Optional[Message]:
        """
        Get message by ID.
        
        Args:
            message_id: Message UUID
            
        Returns:
            Message object or None if not found
        """
        try:
            result = await self._gateway.select(
                "messages",
                filters={"id": str(message_id)},
                limit=1,
                admin=True
            )
            
            if result:
                return Message(**result[0])
            return None
            
        except Exception as e:
            logger.error(f"Failed to get message {message_id}: {e}", exc_info=True)
            raise
    
    async def get_messages(
        self,
        chat_id: UUID,
        limit: Optional[int] = None,
        offset: int = 0
    ) -> List[Message]:
        """
        Get all messages for a chat.
        
        Args:
            chat_id: Chat UUID
            limit: Optional limit on number of messages
            offset: Number of messages to skip
            
        Returns:
            List of Message objects ordered by timestamp
        """
        try:
            result = await self._gateway.select(
                "messages",
                filters={"chat_id": str(chat_id)},
                order_by="timestamp",
                limit=limit,
                offset=offset,
                admin=True
            )
            
            return [Message(**msg) for msg in result]
            
        except Exception as e:
            logger.error(f"Failed to get messages for chat {chat_id}: {e}", exc_info=True)
            raise
    
    # =========================================================================
    # ARTIFACT OPERATIONS
    # =========================================================================
    
    async def create_artifact(
        self,
        chat_id: UUID,
        type: str,
        content: Optional[str],
        language: Optional[str] = None,
        filename: Optional[str] = None,
        artifact_id: Optional[str] = None,
        message_id: Optional[UUID] = None,
        metadata: Optional[Dict[str, Any]] = None,
        subgroup_id: Optional[UUID] = None,
        node_id: Optional[UUID] = None,
        execution_group: Optional[str] = None
    ) -> Artifact:
        """
        Create or update an artifact (UPSERT behavior).
        
        If artifact_id is provided and an artifact with that artifact_id exists
        in the chat, it will be updated. Otherwise, a new artifact is created.
        
        CRITICAL: Trail schema integration - artifacts MUST be linked to nodes:
        - code artifacts → writing nodes (sequence=1)
        - output artifacts → output nodes (sequence=3)
        - executing nodes → NO artifacts (enforced by CHECK constraint)
        
        Args:
            chat_id: Chat UUID
            type: Artifact type ('code', 'markdown', 'html', etc.)
            content: Artifact content
            language: Programming language (for code artifacts)
            filename: Optional filename
            artifact_id: Optional artifact identifier for tracking/deduplication
            message_id: Optional associated message ID
            metadata: Optional metadata dict
            subgroup_id: Optional subgroup UUID (for trail schema linkage)
            node_id: Optional node UUID (for trail schema linkage)
            
        Returns:
            Created or updated Artifact object
        """
        try:
            if not artifact_id:
                raise ValueError(f"artifact_id is REQUIRED for artifact creation (type={type}, chat_id={chat_id})")
            
            data = {
                "chat_id": str(chat_id),
                "type": type,
                "content": content,
                "language": language,
                "filename": filename,
                "artifact_id": artifact_id,
                "message_id": str(message_id) if message_id else None,
                "metadata": metadata or {},
                "subgroup_id": str(subgroup_id) if subgroup_id else None,
                "node_id": str(node_id) if node_id else None,
                # NOTE: execution_group belongs to subgroups table, NOT artifacts.
                # Do NOT include it here -- it's retrieved via JOIN in
                # get_artifacts_with_execution_group() SQL function.
            }
            
            # UPSERT with automatic conflict resolution
            # PostgREST auto-detects the (chat_id, artifact_id) unique constraint
            # This ensures idempotent artifact persistence - same artifact_id updates existing record
            result = await self._gateway.upsert(
                table="artifacts",
                data=data,
                admin=True
            )
            
            if isinstance(result, list):
                result = result[0]
            
            # CRITICAL: If artifact is linked to a node, update the node with artifact_id reference
            # This enables frontend to restore artifact links when loading historic trails
            if node_id:
                try:
                    from ..repositories.trail import TrailRepository
                    trail_repo = TrailRepository(self._gateway)
                    await trail_repo.update_node(
                        node_id=node_id,
                        updates={"artifact_id": artifact_id}
                    )
                    logger.debug(f"Updated node {node_id} with artifact_id={artifact_id}")
                except Exception as node_update_error:
                    logger.error(
                        f"Failed to update node {node_id} with artifact_id: {node_update_error}",
                        exc_info=True
                    )
                    # Don't fail artifact creation if node update fails
            
            logger.debug(f"Upserted artifact {result['id']} (artifact_id={artifact_id}) in chat {chat_id}")
            return Artifact(**result)
            
        except Exception as e:
            logger.error(f"Failed to upsert artifact: {e}", exc_info=True)
            raise
    
    async def get_artifact(self, artifact_id: UUID) -> Optional[Artifact]:
        """
        Get artifact by ID.
        
        Args:
            artifact_id: Artifact UUID
            
        Returns:
            Artifact object or None if not found
        """
        try:
            result = await self._gateway.select(
                "artifacts",
                filters={"id": str(artifact_id)},
                limit=1,
                admin=True
            )
            
            if result:
                return Artifact(**result[0])
            return None
            
        except Exception as e:
            logger.error(f"Failed to get artifact {artifact_id}: {e}", exc_info=True)
            raise
    
    async def get_artifacts(
        self,
        chat_id: UUID,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: int = 0
    ) -> List[Artifact]:
        """
        Get all artifacts for a chat.
        
        Args:
            chat_id: Chat UUID
            type: Optional artifact type filter
            limit: Optional limit on number of artifacts
            offset: Number of artifacts to skip
            
        Returns:
            List of Artifact objects ordered by creation time
        """
        try:
            filters = {"chat_id": str(chat_id)}
            if type:
                filters["type"] = type
            
            result = await self._gateway.select(
                "artifacts",
                filters=filters,
                order_by="created_at",
                limit=limit,
                offset=offset,
                admin=True
            )
            
            return [Artifact(**art) for art in result]
            
        except Exception as e:
            logger.error(f"Failed to get artifacts for chat {chat_id}: {e}", exc_info=True)
            raise
    
    async def get_pending_artifacts(
        self,
        chat_id: UUID,
        since_seconds: int = 60,
    ) -> List[dict]:
        """
        Get artifacts with no linked message (pending linkage).
        
        Returns raw dicts (not Artifact objects) since these may have NULL
        fields that Artifact model doesn't expect.
        
        Server-side time filtering uses the gateway's gte operator
        (same pattern as proactive_agent.py get_recent_runs).
        
        Args:
            chat_id: Chat UUID
            since_seconds: Only consider artifacts created within this window
            
        Returns:
            List of artifact dicts with message_id IS NULL and created_at >= cutoff
        """
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(seconds=since_seconds)

            result = await self._gateway.select(
                "artifacts",
                filters={
                    "chat_id": str(chat_id),
                    "message_id": "is.null",
                    "created_at": {"gte": cutoff.isoformat()},
                },
                admin=True,
            )
            return result or []
        except Exception as e:
            logger.error(f"Failed to get pending artifacts for chat {chat_id}: {e}")
            return []

    async def update_artifact_message_id(
        self,
        artifact_id: Union[UUID, str],
        message_id: UUID
    ) -> List[Artifact]:
        """
        Update artifact's message_id (link artifact to message).
        
        Args:
            artifact_id: Frontend artifact identifier or PostgreSQL UUID
            message_id: Message UUID
            
        Returns:
            List of updated Artifact objects (empty if not found)
        """
        data = {"message_id": str(message_id)}
        identifier = str(artifact_id)
        attempts = ("artifact_id", "id")
        
        for id_column in attempts:
            try:
                result = await self._gateway.update(
                    "artifacts",
                    data,
                    record_id=identifier,
                    id_column=id_column,
                    admin=True
                )
                
                if isinstance(result, list) and result:
                    result = result[0]
                elif not result:
                    continue
                    
                logger.debug(
                    f"Updated artifact ({id_column}={identifier}) message_id to {message_id}"
                )
                return [Artifact(**result)]
            except ValueError as not_found_error:
                logger.debug(
                    f"No artifact matched {id_column}={identifier}: {not_found_error}"
                )
                continue
            except Exception as e:
                logger.error(
                    f"Failed to update artifact ({id_column}={identifier}): {e}",
                    exc_info=True
                )
                raise
        
        # Fallback: treat identifier as request prefix and update all artifacts matching it
        try:
            fallback_artifacts = await self._update_artifacts_by_prefix(identifier, data)
            if fallback_artifacts:
                logger.warning(
                    "Updated %d artifact(s) using prefix fallback for identifier=%s",
                    len(fallback_artifacts),
                    identifier,
                )
                return fallback_artifacts
        except Exception as e:
            logger.error(
                "Prefix-based artifact update failed for identifier=%s: %s",
                identifier,
                e,
                exc_info=True,
            )
            raise

        logger.info(
            f"Artifact not found for update (artifact_id={identifier})"
        )
        return []

    async def get_message_artifacts(self, message_id: UUID) -> List[Artifact]:
        """
        Get artifacts linked to a specific message.
        
        Args:
            message_id: Message UUID
            
        Returns:
            List of Artifact objects
        """
        try:
            result = await self._gateway.select(
                "artifacts",
                filters={"message_id": str(message_id)},
                order_by="created_at",
                admin=True
            )
            return [Artifact(**art) for art in result]
        except Exception as e:
            logger.error(f"Failed to get artifacts for message {message_id}: {e}", exc_info=True)
            raise

    async def get_artifact_source(self, artifact_id: UUID) -> Optional[Message]:
        """
        Get the message that created an artifact.
        
        Args:
            artifact_id: Artifact UUID
            
        Returns:
            Message object or None if not found/linked
        """
        try:
            # First get the artifact to find the message_id
            artifact = await self.get_artifact(artifact_id)
            if not artifact or not artifact.message_id:
                return None
            
            return await self.get_message(artifact.message_id)
        except Exception as e:
            logger.error(f"Failed to get source message for artifact {artifact_id}: {e}", exc_info=True)
            raise

    async def _update_artifacts_by_prefix(
        self,
        identifier: str,
        data: Dict[str, Any],
    ) -> List[Artifact]:
        """
        Update artifacts whose artifact_id begins with the provided identifier.

        Args:
            identifier: Artifact identifier prefix (typically request/correlation id)
            data: Columns to update

        Returns:
            List of updated artifacts (can be empty)
        """
        pattern = f"{identifier}%"

        try:
            results = await self._gateway.update_like(
                "artifacts",
                "artifact_id",
                pattern,
                data,
                admin=True,
            )
        except ValueError as not_found_error:
            logger.debug(
                "No artifacts matched prefix pattern %s: %s",
                pattern,
                not_found_error,
            )
            return []

        return [Artifact(**row) for row in results]

    async def update_artifact(
        self,
        artifact_id: UUID,
        *,
        content: Optional[str] = None,
        filename: Optional[str] = None,
        language: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Optional[Artifact]:
        """
        Update artifact fields.
        
        Args:
            artifact_id: Artifact UUID (PostgreSQL primary key)
            content: Optional new content
            filename: Optional new filename
            language: Optional new language
            metadata: Optional new metadata
            
        Returns:
            Updated Artifact object or None if not found
        """
        try:
            # Build update data with only provided fields
            data = {}
            if content is not None:
                data["content"] = content
            if filename is not None:
                data["filename"] = filename
            if language is not None:
                data["language"] = language
            if metadata is not None:
                data["metadata"] = metadata
            
            if not data:
                logger.warning(f"update_artifact called with no fields to update for {artifact_id}")
                return await self.get_artifact(artifact_id)
            
            result = await self._gateway.update(
                "artifacts",
                data,
                record_id=str(artifact_id),
                id_column="id",
                admin=True
            )
            
            if isinstance(result, list) and result:
                result = result[0]
            
            logger.debug(f"Updated artifact {artifact_id}")
            return Artifact(**result)
            
        except ValueError as e:
            logger.warning(f"Artifact {artifact_id} not found for update: {e}")
            return None
        except Exception as e:
            logger.error(f"Failed to update artifact {artifact_id}: {e}", exc_info=True)
            raise

    async def delete_artifact(self, artifact_id: UUID) -> bool:
        """
        Delete artifact by ID.
        
        Args:
            artifact_id: Artifact UUID (PostgreSQL primary key)
            
        Returns:
            True if deleted, False if not found
        """
        try:
            await self._gateway.delete(
                "artifacts",
                record_id=str(artifact_id),
                admin=True
            )
            
            logger.info(f"Deleted artifact {artifact_id}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to delete artifact {artifact_id}: {e}", exc_info=True)
            raise

    async def delete_message(self, message_id: UUID, cascade_artifacts: bool = True) -> bool:
        """
        Delete message by ID with optional cascade to artifacts.
        
        ARCHITECTURAL NOTE: Database schema has ON DELETE SET NULL for artifacts.message_id,
        so deleting a message orphans its artifacts rather than cascading.
        This method handles application-level cascade if requested.
        
        Args:
            message_id: Message UUID
            cascade_artifacts: If True, delete all artifacts linked to this message
            
        Returns:
            True if deleted, False if not found
            
        Raises:
            Exception: If deletion fails
        """
        try:
            # If cascade requested, delete all artifacts linked to this message first
            if cascade_artifacts:
                artifacts = await self._gateway.select(
                    "artifacts",
                    filters={"message_id": str(message_id)},
                    admin=True
                )
                
                for artifact in artifacts:
                    try:
                        await self.delete_artifact(UUID(artifact["id"]))
                        logger.debug(f"Cascaded delete: artifact {artifact['id']} for message {message_id}")
                    except Exception as artifact_error:
                        logger.error(
                            f"Failed to delete artifact {artifact['id']} during message cascade: {artifact_error}",
                            exc_info=True
                        )
                        # Continue deleting other artifacts
                
                logger.info(f"Deleted {len(artifacts)} artifacts for message {message_id}")
            
            # Delete the message
            await self._gateway.delete(
                "messages",
                record_id=str(message_id),
                admin=True
            )
            
            logger.info(f"Deleted message {message_id}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to delete message {message_id}: {e}", exc_info=True)
            raise

    async def delete_message_group(self, user_message_id: UUID) -> dict:
        """
        Delete user message and corresponding assistant response as a group.
        This is the primary deletion method for user-initiated message removal.
        
        ARCHITECTURAL LOGIC:
        1. Verify the provided message is a user message
        2. Find the assistant response (next message in sequence from same chat)
        3. Delete all artifacts from both messages
        4. Delete both messages
        
        Args:
            user_message_id: User message UUID
            
        Returns:
            dict with deletion summary: {
                "deleted_messages": int,
                "deleted_artifacts": int,
                "user_message_id": str,
                "assistant_message_id": str or None
            }
            
        Raises:
            ValueError: If message is not a user message or not found
            Exception: If deletion fails
        """
        try:
            # Get the user message
            user_message = await self.get_message(user_message_id)
            
            if not user_message:
                raise ValueError(f"Message {user_message_id} not found")
            
            if user_message.role != "user":
                raise ValueError(f"Message {user_message_id} is not a user message (role={user_message.role})")
            
            # Find the corresponding assistant response
            # Strategy: Get next message in sequence from same chat
            all_messages = await self.get_messages(user_message.chat_id)
            
            # Sort by sequence to find adjacent messages
            # Guard against None sequence_in_chat (legacy/migrated data)
            all_messages.sort(key=lambda m: m.sequence_in_chat if m.sequence_in_chat is not None else float('inf'))
            
            assistant_message = None
            found_user = False
            for msg in all_messages:
                if msg.id == user_message_id:
                    found_user = True
                    continue
                
                if found_user and msg.role == "assistant":
                    assistant_message = msg
                    break
            
            messages_to_delete = [user_message]
            if assistant_message:
                messages_to_delete.append(assistant_message)
                logger.info(
                    f"Deleting message group: user={user_message_id}, assistant={assistant_message.id}"
                )
            else:
                logger.warning(f"No assistant response found for user message {user_message_id}")
            
            # Delete all messages in the group (cascade handles artifacts)
            deleted_messages = 0
            deleted_artifacts = 0
            
            for message in messages_to_delete:
                # Get artifact count for this message before deleting
                artifacts = await self._gateway.select(
                    "artifacts",
                    filters={"message_id": str(message.id)},
                    admin=True
                )
                deleted_artifacts += len(artifacts)
                
                # Delete message (cascade_artifacts=True)
                await self.delete_message(message.id, cascade_artifacts=True)
                deleted_messages += 1
            
            result = {
                "deleted_messages": deleted_messages,
                "deleted_artifacts": deleted_artifacts,
                "user_message_id": str(user_message_id),
                "assistant_message_id": str(assistant_message.id) if assistant_message else None
            }
            
            logger.info(f"Deleted message group: {result}")
            return result
            
        except ValueError as e:
            logger.warning(f"Invalid message group deletion request: {e}")
            raise
        except Exception as e:
            logger.error(f"Failed to delete message group for {user_message_id}: {e}", exc_info=True)
            raise

    
    # =========================================================================
    # STATISTICS & HELPER METHODS
    # =========================================================================
    
    async def get_chat_statistics(self, chat_id: UUID) -> Dict[str, Any]:
        """
        Get statistics for a chat (message count, artifact count, etc.).
        
        Uses precomputed views via group_count for performance on large tables.
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            Dict with chat statistics
        """
        try:
            # Use group_count which leverages precomputed views for messages and artifacts
            # to avoid expensive full-table scans that cause timeouts (Postgres 57014).
            cid_str = str(chat_id)
            
            message_counts_task = self._gateway.group_count(
                "messages",
                "chat_id",
                filters={"chat_id": cid_str},
                admin=True
            )
            artifact_counts_task = self._gateway.group_count(
                "artifacts",
                "chat_id",
                filters={"chat_id": cid_str},
                admin=True
            )
            
            message_results, artifact_results = await asyncio.gather(
                message_counts_task,
                artifact_counts_task
            )
            
            message_count = int(message_results[0]["count"]) if message_results else 0
            artifact_count = int(artifact_results[0]["count"]) if artifact_results else 0
            
            return {
                "message_count": message_count,
                "artifact_count": artifact_count
            }
            
        except Exception as e:
            logger.error(f"Failed to get chat statistics for {chat_id}: {e}")
            # Fallback to direct count if group_count fails (less likely to succeed if views are broken)
            try:
                message_count = await self._gateway.count(
                    "messages",
                    filters={"chat_id": str(chat_id)},
                    admin=True
                )
                artifact_count = await self._gateway.count(
                    "artifacts",
                    filters={"chat_id": str(chat_id)},
                    admin=True
                )
                return {
                    "message_count": message_count,
                    "artifact_count": artifact_count
                }
            except Exception as inner_e:
                logger.debug("Fallback direct count failed for %s: %s", chat_id, inner_e)
                return {
                    "message_count": 0,
                    "artifact_count": 0
                }

    async def get_chat_statistics_bulk(
        self,
        chat_ids: List[UUID],
    ) -> Dict[str, Dict[str, int]]:
        """
        Fetch statistics for multiple chats in aggregated queries.
        
        Args:
            chat_ids: List of chat UUIDs
        
        Returns:
            Mapping of chat_id -> {"message_count": int, "artifact_count": int}
        """
        if not chat_ids:
            return {}

        chat_id_values = [str(chat_id) for chat_id in chat_ids]

        try:
            message_alias = "message_count"
            artifact_alias = "artifact_count"
            message_counts_task = self._gateway.group_count(
                "messages",
                "chat_id",
                count_column="id",
                count_alias=message_alias,
                in_filters={"chat_id": chat_id_values},
                admin=True,
            )
            artifact_counts_task = self._gateway.group_count(
                "artifacts",
                "chat_id",
                count_column="id",
                count_alias=artifact_alias,
                in_filters={"chat_id": chat_id_values},
                admin=True,
            )

            message_counts, artifact_counts = await asyncio.gather(
                message_counts_task,
                artifact_counts_task,
                return_exceptions=False,
            )

            stats_map: Dict[str, Dict[str, int]] = {
                chat_id: {"message_count": 0, "artifact_count": 0}
                for chat_id in chat_id_values
            }

            for row in message_counts:
                chat_id = row.get("chat_id")
                if not chat_id:
                    continue
                stats_map.setdefault(chat_id, {"message_count": 0, "artifact_count": 0})[
                    "message_count"
                ] = int(row.get(message_alias) or 0)

            for row in artifact_counts:
                chat_id = row.get("chat_id")
                if not chat_id:
                    continue
                stats_map.setdefault(chat_id, {"message_count": 0, "artifact_count": 0})[
                    "artifact_count"
                ] = int(row.get(artifact_alias) or 0)

            return stats_map

        except Exception as e:
            # Fallback: per-chat counts if PostgREST server lacks group support
            logger.error(
                "Grouped count failed; falling back to per-chat counts: %s",
                e,
                exc_info=True,
            )
            stats_map: Dict[str, Dict[str, int]] = {
                chat_id: {"message_count": 0, "artifact_count": 0}
                for chat_id in chat_id_values
            }

            async def count_messages(c_id: str) -> None:
                try:
                    cnt = await self._gateway.count(
                        "messages", filters={"chat_id": c_id}, admin=True
                    )
                    stats_map[c_id]["message_count"] = int(cnt or 0)
                except Exception as e:
                    logger.debug("Failed to count messages for %s: %s", c_id, e)
                    # keep default 0
                    pass

            async def count_artifacts(c_id: str) -> None:
                try:
                    cnt = await self._gateway.count(
                        "artifacts", filters={"chat_id": c_id}, admin=True
                    )
                    stats_map[c_id]["artifact_count"] = int(cnt or 0)
                except Exception as e:
                    logger.debug("Failed to count artifacts for %s: %s", c_id, e)
                    # keep default 0
                    pass

            await asyncio.gather(
                *(count_messages(cid) for cid in chat_id_values),
                *(count_artifacts(cid) for cid in chat_id_values),
            )
            return stats_map
    
    # =========================================================================
    # Chat References Methods
    # =========================================================================
    
    async def create_chat_reference(
        self,
        source_chat_id: UUID,
        target_chat_id: UUID,
        reference_type: str = "context",
        metadata: Optional[Dict[str, Any]] = None,
        created_by: str = "user"
    ) -> Dict[str, Any]:
        """
        Create a new reference between two chats.

        Args:
            source_chat_id: UUID of the source chat
            target_chat_id: UUID of the target chat
            reference_type: Type of reference (context, memory, attachment, related)
            metadata: Optional JSONB metadata
            created_by: Creator (user, agent, system)

        Returns:
            The created chat_reference record
        """
        try:
            result = await self._gateway.insert(
                "chat_references",
                {
                    "source_chat_id": str(source_chat_id),
                    "target_chat_id": str(target_chat_id),
                    "reference_type": reference_type,
                    "metadata": metadata or {},
                    "created_by": created_by
                },
                admin=True
            )
            # insert() returns a list; extract the first element for single record insert
            if isinstance(result, list) and len(result) > 0:
                return result[0]
            return result
        except Exception as e:
            logger.error(f"Failed to create chat reference: {e}", exc_info=True)
            raise

    async def get_chat_reference(self, reference_id: UUID) -> Optional[Dict[str, Any]]:
        """Get a specific chat reference by ID."""
        try:
            results = await self._gateway.select(
                "chat_references",
                filters={"id": str(reference_id)},
                limit=1,
                admin=True
            )
            return results[0] if results else None
        except Exception as e:
            logger.error(f"Failed to get chat reference {reference_id}: {e}", exc_info=True)
            return None

    async def get_chat_reference_by_chats(
        self,
        source_chat_id: UUID,
        target_chat_id: UUID
    ) -> Optional[Dict[str, Any]]:
        """Get a reference by source and target chat IDs."""
        try:
            results = await self._gateway.select(
                "chat_references",
                filters={
                    "source_chat_id": str(source_chat_id),
                    "target_chat_id": str(target_chat_id)
                },
                limit=1,
                admin=True
            )
            return results[0] if results else None
        except Exception as e:
            logger.error(f"Failed to get chat reference: {e}", exc_info=True)
            return None
    
    async def list_chat_references(
        self,
        chat_id: UUID,
        direction: str = "both",
        limit: int = 100,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """
        List chat references for a given chat.
        
        Args:
            chat_id: UUID of the chat
            direction: Filter by direction (source, target, both)
            limit: Maximum number of results
            offset: Offset for pagination
            
        Returns:
            List of chat_reference records
        """
        try:
            chat_id_str = str(chat_id)
            
            if direction == "source":
                filters = {"source_chat_id": chat_id_str}
            elif direction == "target":
                filters = {"target_chat_id": chat_id_str}
            else:  # both
                # For "both", we need OR logic - use raw RPC or two queries
                source_refs = await self._gateway.select(
                    table="chat_references",
                    filters={"source_chat_id": chat_id_str},
                    limit=limit,
                    offset=offset,
                    admin=True
                )
                target_refs = await self._gateway.select(
                    table="chat_references",
                    filters={"target_chat_id": chat_id_str},
                    limit=limit,
                    offset=offset,
                    admin=True
                )
                # Merge and deduplicate
                all_refs = {ref["id"]: ref for ref in source_refs + target_refs}
                return list(all_refs.values())[:limit]
            
            results = await self._gateway.select(
                table="chat_references",
                filters=filters,
                limit=limit,
                offset=offset,
                admin=True
            )
            return results
        except Exception as e:
            logger.error(f"Failed to list chat references for {chat_id}: {e}", exc_info=True)
            return []
    
    async def delete_chat_reference(self, reference_id: UUID) -> bool:
        """Delete a chat reference by ID."""
        try:
            await self._gateway.delete(
                table="chat_references",
                filters={"id": str(reference_id)},
                admin=True
            )
            return True
        except Exception as e:
            logger.error(f"Failed to delete chat reference {reference_id}: {e}", exc_info=True)
            return False
    
    # =========================================================================
    # Chat Summaries Methods
    # =========================================================================
    
    async def create_chat_summary(
        self,
        chat_id: UUID,
        summary_type: str,
        title: Optional[str],
        summary_text: str,
        key_points: List[str],
        entities: Dict[str, Any],
        llm_model: Optional[str],
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Create or update a chat summary.
        
        Uses UPSERT logic based on (chat_id, summary_type) unique constraint.
        """
        try:
            # Check if summary exists
            existing = await self.get_chat_summary(chat_id, summary_type)
            
            data = {
                "chat_id": str(chat_id),
                "summary_type": summary_type,
                "title": title,
                "summary_text": summary_text,
                "key_points": key_points,
                "entities": entities,
                "llm_model": llm_model,
                "metadata": metadata or {}
            }
            
            if existing:
                # Update existing
                result = await self._gateway.update(
                    table="chat_summaries",
                    data=data,
                    filters={"id": existing["id"]},
                    admin=True
                )
                return result[0] if result else existing
            else:
                # Insert new
                result = await self._gateway.insert(
                    table="chat_summaries",
                    data=[data],
                    admin=True
                )
                return result[0] if result else data
        except Exception as e:
            logger.error(f"Failed to create chat summary: {e}", exc_info=True)
            raise
    
    async def get_chat_summary(
        self,
        chat_id: UUID,
        summary_type: str = "full"
    ) -> Optional[Dict[str, Any]]:
        """Get a specific chat summary by chat_id and type."""
        try:
            results = await self._gateway.select(
                table="chat_summaries",
                filters={"chat_id": str(chat_id), "summary_type": summary_type},
                admin=True
            )
            return results[0] if results else None
        except Exception as e:
            logger.error(f"Failed to get chat summary: {e}", exc_info=True)
            return None
    
    async def list_chat_summaries(
        self,
        chat_id: Optional[UUID] = None,
        summary_type: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """List chat summaries with optional filters."""
        try:
            filters = {}
            if chat_id:
                filters["chat_id"] = str(chat_id)
            if summary_type:
                filters["summary_type"] = summary_type
            
            results = await self._gateway.select(
                table="chat_summaries",
                filters=filters,
                limit=limit,
                offset=offset,
                order_by="created_at.desc",
                admin=True
            )
            return results
        except Exception as e:
            logger.error(f"Failed to list chat summaries: {e}", exc_info=True)
            return []
    
    async def search_chat_summaries(
        self,
        query: str,
        limit: int = 10,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Search chat summaries using full-text search.
        
        Uses PostgreSQL full-text search on summary_text and title fields.
        """
        try:
            # Use Supabase text search (requires GIN index on tsvector)
            results = await self._gateway.text_search(
                table="chat_summaries",
                column="summary_text",
                query=query,
                limit=limit,
                offset=offset,
                admin=True
            )
            return results
        except Exception as e:
            logger.error(f"Failed to search chat summaries: {e}", exc_info=True)
            return []
