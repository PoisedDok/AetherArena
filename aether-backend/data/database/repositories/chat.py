"""
Chat Repository - Data access layer for chat operations

@.architecture
Incoming: api/v1/endpoints/storage.py, data/database/connection.py --- {DatabaseConnection instance, CRUD operation requests for chats/messages/artifacts}
Processing: create_chat(), get_chat(), list_chats(), update_chat(), delete_chat(), create_message(), get_message(), get_messages(), create_artifact(), get_artifact(), get_artifacts(), update_artifact_message_id() --- {12 jobs: chat_crud, message_crud, artifact_crud, transaction_management, query_execution}
Outgoing: PostgreSQL (via DatabaseConnection), api/v1/endpoints/storage.py --- {SQL INSERT/SELECT/UPDATE/DELETE via async connection, Pydantic model instances: Chat, Message, Artifact}

Provides CRUD operations for:
- Chats (conversation containers)
- Messages (user/assistant interactions)
- Artifacts (generated outputs)

All operations use async/await and proper transaction management.
"""

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

import psycopg.types.json

from ..connection import DatabaseConnection
from ..models.chat import Artifact, Chat, Message

logger = logging.getLogger(__name__)


class ChatRepository:
    """
    Repository for chat-related database operations.
    
    Provides clean API for:
    - Chat CRUD operations
    - Message persistence and retrieval
    - Artifact management
    - Transaction-safe bulk operations
    
    All methods are async and use connection pooling.
    """
    
    def __init__(self, db: DatabaseConnection):
        """
        Initialize chat repository.
        
        Args:
            db: Database connection manager
        """
        self.db = db
    
    # =========================================================================
    # CHAT OPERATIONS
    # =========================================================================
    
    async def create_chat(self, title: str = "New Chat") -> Chat:
        """
        Create a new chat.
        
        Args:
            title: Chat title
            
        Returns:
            Created Chat object
            
        Raises:
            Exception: If creation fails
        """
        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO chats (title)
                VALUES (%s)
                RETURNING *
                """,
                (title,),
            )
            row = await cursor.fetchone()
            
        logger.debug(f"Created chat {row['id']} with title '{title}'")
        return Chat(**row)
    
    async def get_chat(self, chat_id: UUID) -> Optional[Chat]:
        """
        Get chat by ID.
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            Chat object or None if not found
        """
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(
                "SELECT * FROM chats WHERE id = %s",
                (chat_id,),
            )
            row = await cursor.fetchone()
            
        return Chat(**row) if row else None
    
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
            List of Chat objects with message counts
        """
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT 
                    c.id,
                    c.title,
                    c.created_at,
                    c.updated_at,
                    COUNT(m.id) AS message_count,
                    MAX(m.timestamp) AS last_message_at
                FROM chats c
                LEFT JOIN messages m ON c.id = m.chat_id
                GROUP BY c.id, c.title, c.created_at, c.updated_at
                ORDER BY c.updated_at DESC
                LIMIT %s OFFSET %s
                """,
                (limit, offset),
            )
            rows = await cursor.fetchall()
            
        return [Chat(**row) for row in rows]
    
    async def update_chat(
        self,
        chat_id: UUID,
        title: Optional[str] = None
    ) -> Optional[Chat]:
        """
        Update chat title.
        
        Args:
            chat_id: Chat UUID
            title: New title (if provided)
            
        Returns:
            Updated Chat object or None if not found
        """
        if title is None:
            return await self.get_chat(chat_id)
        
        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                """
                UPDATE chats
                SET title = %s, updated_at = NOW()
                WHERE id = %s
                RETURNING *
                """,
                (title, chat_id),
            )
            row = await cursor.fetchone()
            
        if row:
            logger.debug(f"Updated chat {chat_id} title to '{title}'")
            return Chat(**row)
        return None
    
    async def delete_chat(self, chat_id: UUID) -> bool:
        """
        Delete chat and all associated messages/artifacts (CASCADE).
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            True if chat was deleted, False if not found
        """
        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                "DELETE FROM chats WHERE id = %s RETURNING id",
                (chat_id,),
            )
            row = await cursor.fetchone()
            
        if row:
            logger.info(f"Deleted chat {chat_id} and all associated data")
            return True
        return False
    
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
        correlation_id: Optional[UUID] = None,
    ) -> Message:
        """
        Create a new message in a chat.
        
        Args:
            chat_id: Parent chat UUID
            role: Message role (user, assistant, system)
            content: Message content
            llm_model: Optional LLM model name
            llm_provider: Optional LLM provider name
            tokens_used: Optional token count
            correlation_id: Optional correlation ID linking user/assistant messages
            
        Returns:
            Created Message object
            
        Raises:
            Exception: If chat doesn't exist or creation fails
        """
        async with self.db.transaction() as conn:
            # Verify chat exists
            cursor = await conn.execute(
                "SELECT id FROM chats WHERE id = %s",
                (chat_id,),
            )
            if not await cursor.fetchone():
                raise ValueError(f"Chat {chat_id} not found")
            
            # Insert message
            cursor = await conn.execute(
                """
                INSERT INTO messages 
                (chat_id, role, content, llm_model, llm_provider, tokens_used, correlation_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    chat_id,
                    role,
                    content,
                    llm_model,
                    llm_provider,
                    tokens_used,
                    correlation_id,
                ),
            )
            row = await cursor.fetchone()
            
        logger.debug(f"Created {role} message {row['id']} in chat {chat_id}")
        return Message(**row)
    
    async def get_messages(
        self,
        chat_id: UUID,
        limit: Optional[int] = None,
        offset: int = 0
    ) -> List[Message]:
        """
        Get messages for a chat ordered by timestamp.
        
        Args:
            chat_id: Chat UUID
            limit: Optional maximum number of messages
            offset: Number of messages to skip
            
        Returns:
            List of Message objects
        """
        query = """
            SELECT * FROM messages
            WHERE chat_id = %s
            ORDER BY timestamp ASC
        """
        params = [chat_id]
        
        if limit is not None:
            query += " LIMIT %s OFFSET %s"
            params.extend([limit, offset])
        
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(query, tuple(params))
            rows = await cursor.fetchall()
            
        return [Message(**row) for row in rows]
    
    async def delete_messages_after(
        self,
        chat_id: UUID,
        message_id: UUID
    ) -> int:
        """
        Delete all messages in a chat after a specific message.
        
        Used for branching conversations (when user edits past message).
        
        Args:
            chat_id: Chat UUID
            message_id: Message ID to delete after
            
        Returns:
            Number of messages deleted
        """
        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                """
                DELETE FROM messages
                WHERE chat_id = %s
                AND id > (SELECT id FROM messages WHERE id = %s)
                RETURNING id
                """,
                (chat_id, message_id),
            )
            rows = await cursor.fetchall()
            deleted_count = len(rows)
            
        if deleted_count > 0:
            logger.debug(
                f"Deleted {deleted_count} messages after {message_id} in chat {chat_id}"
            )
        
        return deleted_count
    
    # =========================================================================
    # ARTIFACT OPERATIONS
    # =========================================================================
    
    async def create_artifact(
        self,
        chat_id: UUID,
        type: str,
        content: Optional[str] = None,
        filename: Optional[str] = None,
        language: Optional[str] = None,
        message_id: Optional[UUID] = None,
        artifact_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Artifact:
        """
        Create a new artifact linked to a chat.
        
        Args:
            chat_id: Parent chat UUID
            type: Artifact type (code, html, output, file, text, markdown, json)
            content: Artifact content
            filename: Optional filename
            language: Optional programming language
            message_id: Optional link to message that created this
            artifact_id: Optional frontend-generated ID
            metadata: Optional metadata dict
            
        Returns:
            Created Artifact object
            
        Raises:
            Exception: If chat doesn't exist or creation fails
        """
        async with self.db.transaction() as conn:
            # Verify chat exists
            cursor = await conn.execute(
                "SELECT id FROM chats WHERE id = %s",
                (chat_id,),
            )
            if not await cursor.fetchone():
                raise ValueError(f"Chat {chat_id} not found")
            
            # psycopg3 requires explicit Json wrapper for dict -> JSONB conversion
            # Wrap metadata with psycopg.types.json.Json() if it's a dict
            metadata_json = psycopg.types.json.Json(metadata) if metadata else None
            
            # Insert artifact
            cursor = await conn.execute(
                """
                INSERT INTO artifacts 
                (chat_id, message_id, artifact_id, type, filename, content, language, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    chat_id,
                    message_id,
                    artifact_id,
                    type,
                    filename,
                    content,
                    language,
                    metadata_json,
                ),
            )
            row = await cursor.fetchone()
            
        logger.debug(f"Created {type} artifact {row['id']} in chat {chat_id}")
        return Artifact(**row)
    
    async def get_artifacts(
        self,
        chat_id: UUID,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: int = 0
    ) -> List[Artifact]:
        """
        Get artifacts for a chat.
        
        Args:
            chat_id: Chat UUID
            type: Optional type filter
            limit: Optional maximum number of artifacts
            offset: Number of artifacts to skip
            
        Returns:
            List of Artifact objects
        """
        query = """
            SELECT * FROM artifacts
            WHERE chat_id = %s
        """
        params = [chat_id]
        
        if type:
            query += " AND type = %s"
            params.append(type)
        
        query += " ORDER BY created_at DESC"
        
        if limit is not None:
            query += " LIMIT %s OFFSET %s"
            params.extend([limit, offset])
        
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(query, tuple(params))
            rows = await cursor.fetchall()
            
        return [Artifact(**row) for row in rows]
    
    async def update_artifact_message_id(
        self,
        artifact_id: str,
        message_id: UUID
    ) -> Optional[Artifact]:
        """
        Update artifact to link it to a message.
        
        Used when artifact is created during streaming but message ID
        isn't known until streaming completes.
        
        Args:
            artifact_id: Frontend-generated artifact ID
            message_id: Message UUID to link to
            
        Returns:
            Updated Artifact object or None if not found
        """
        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                """
                UPDATE artifacts
                SET message_id = %s
                WHERE artifact_id = %s
                RETURNING *
                """,
                (message_id, artifact_id),
            )
            row = await cursor.fetchone()
            
        if row:
            logger.debug(f"Linked artifact {artifact_id} to message {message_id}")
            return Artifact(**row)
        return None
    
    # =========================================================================
    # UTILITY METHODS
    # =========================================================================
    
    async def get_chat_statistics(self, chat_id: UUID) -> Dict[str, Any]:
        """
        Get statistics for a chat.
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            Dict with message/artifact counts and timestamps
        """
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT 
                    (SELECT COUNT(*) FROM messages WHERE chat_id = %s) as message_count,
                    (SELECT COUNT(*) FROM artifacts WHERE chat_id = %s) as artifact_count,
                    (SELECT MAX(timestamp) FROM messages WHERE chat_id = %s) as last_message_at,
                    (SELECT MAX(created_at) FROM artifacts WHERE chat_id = %s) as last_artifact_at
                """,
                (chat_id, chat_id, chat_id, chat_id),
            )
            row = await cursor.fetchone()
            
        return dict(row) if row else {}

