"""
Storage Repository - Data access layer for file storage metadata and trail state persistence

@.architecture
Incoming: api/v1/endpoints/storage.py, data/database/connection.py --- {DatabaseConnection instance, artifact query requests, search requests, statistics requests, trail state save/load/delete requests, traceability data requests}
Processing: get_all_artifacts(), search_artifacts(), get_artifacts_by_filename(), get_storage_statistics(), get_chat_storage_usage(), delete_orphaned_artifacts(), save_trail_state(), load_trail_state(), delete_trail_state(), save_traceability_data(), load_traceability_data() --- {11 jobs: artifact_querying, cleanup_operations, data_validation, fulltext_search, json_serialization, statistics_aggregation, trail_state_persistence, traceability_tracking, transaction_management}
Outgoing: PostgreSQL (via DatabaseConnection), api/v1/endpoints/storage.py --- {SQL SELECT/INSERT/UPDATE/DELETE with PostgreSQL FTS (GIN index), artifact dicts with chat_title, statistics dicts, trail state JSONB, traceability JSONB}

Provides operations for:
- File metadata tracking
- Storage location management
- File type categorization
- Trail state persistence (UI execution trails)
- Traceability data persistence (message-artifact relationships)

This repository tracks metadata about files stored on disk.
The actual file content is managed by LocalFileStorage in data/storage/.
Trail states and traceability data stored as JSONB for frontend UI continuity.
"""

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from ..connection import DatabaseConnection

logger = logging.getLogger(__name__)


class StorageRepository:
    """
    Repository for storage metadata operations.
    
    Provides clean API for:
    - Artifact-based file tracking (via ChatRepository)
    - Storage statistics and queries
    - File type filtering
    
    Note: This repository primarily provides query helpers.
    Most storage operations go through ChatRepository.create_artifact()
    since files are stored as artifacts linked to chats.
    """
    
    def __init__(self, db: DatabaseConnection):
        """
        Initialize storage repository.
        
        Args:
            db: Database connection manager
        """
        self.db = db
    
    # =========================================================================
    # QUERY HELPERS
    # =========================================================================
    
    async def get_all_artifacts(
        self,
        type: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Get all artifacts across all chats.
        
        Args:
            type: Optional type filter (code, html, output, file, etc)
            limit: Maximum number of artifacts
            offset: Number of artifacts to skip
            
        Returns:
            List of artifact dicts with chat information
        """
        query = """
            SELECT 
                a.*,
                c.title as chat_title
            FROM artifacts a
            JOIN chats c ON a.chat_id = c.id
            WHERE 1=1
        """
        params = []
        
        if type:
            query += " AND a.type = %s"
            params.append(type)
        
        query += " ORDER BY a.created_at DESC LIMIT %s OFFSET %s"
        params.extend([limit, offset])
        
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(query, tuple(params))
            rows = await cursor.fetchall()
            
        return [dict(row) for row in rows]
    
    async def search_artifacts(
        self,
        search_text: str,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Full-text search across artifact content.
        
        Uses PostgreSQL full-text search (GIN index).
        
        Args:
            search_text: Search query
            limit: Maximum number of results
            
        Returns:
            List of matching artifacts with relevance ranking
        """
        query = """
            SELECT 
                a.*,
                c.title as chat_title,
                ts_rank(to_tsvector('english', a.content), plainto_tsquery('english', %s)) as rank
            FROM artifacts a
            JOIN chats c ON a.chat_id = c.id
            WHERE to_tsvector('english', a.content) @@ plainto_tsquery('english', %s)
            ORDER BY rank DESC
            LIMIT %s
        """
        
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(query, (search_text, search_text, limit))
            rows = await cursor.fetchall()
            
        return [dict(row) for row in rows]
    
    async def get_artifacts_by_filename(
        self,
        filename: str
    ) -> List[Dict[str, Any]]:
        """
        Find artifacts by filename (exact match).
        
        Args:
            filename: Filename to search for
            
        Returns:
            List of matching artifacts
        """
        query = """
            SELECT 
                a.*,
                c.title as chat_title
            FROM artifacts a
            JOIN chats c ON a.chat_id = c.id
            WHERE a.filename = %s
            ORDER BY a.created_at DESC
        """
        
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(query, (filename,))
            rows = await cursor.fetchall()
            
        return [dict(row) for row in rows]
    
    # =========================================================================
    # STATISTICS
    # =========================================================================
    
    async def get_storage_statistics(self) -> Dict[str, Any]:
        """
        Get storage statistics across all artifacts.
        
        Returns:
            Dict with counts by type, total size estimates, etc
        """
        query = """
            SELECT 
                COUNT(*) as total_artifacts,
                COUNT(DISTINCT chat_id) as total_chats_with_artifacts,
                COUNT(CASE WHEN type = 'code' THEN 1 END) as code_count,
                COUNT(CASE WHEN type = 'html' THEN 1 END) as html_count,
                COUNT(CASE WHEN type = 'output' THEN 1 END) as output_count,
                COUNT(CASE WHEN type = 'file' THEN 1 END) as file_count,
                COUNT(CASE WHEN type = 'text' THEN 1 END) as text_count,
                COUNT(CASE WHEN type = 'markdown' THEN 1 END) as markdown_count,
                COUNT(CASE WHEN type = 'json' THEN 1 END) as json_count,
                SUM(LENGTH(content)) as total_content_bytes,
                AVG(LENGTH(content)) as avg_content_bytes,
                MAX(created_at) as last_artifact_at
            FROM artifacts
        """
        
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(query)
            row = await cursor.fetchone()
            
        return dict(row) if row else {}
    
    async def get_chat_storage_usage(
        self,
        chat_id: UUID
    ) -> Dict[str, Any]:
        """
        Get storage usage statistics for a specific chat.
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            Dict with artifact counts and size for the chat
        """
        query = """
            SELECT 
                COUNT(*) as artifact_count,
                COUNT(CASE WHEN type = 'code' THEN 1 END) as code_count,
                COUNT(CASE WHEN type = 'file' THEN 1 END) as file_count,
                SUM(LENGTH(content)) as total_content_bytes
            FROM artifacts
            WHERE chat_id = %s
        """
        
        async with self.db.get_connection() as conn:
            cursor = await conn.execute(query, (chat_id,))
            row = await cursor.fetchone()
            
        return dict(row) if row else {}
    
    # =========================================================================
    # CLEANUP OPERATIONS
    # =========================================================================
    
    async def delete_orphaned_artifacts(self) -> int:
        """
        Delete artifacts that reference non-existent chats.
        
        This shouldn't happen due to CASCADE, but provided as a safety check.
        
        Returns:
            Number of artifacts deleted
        """
        query = """
            DELETE FROM artifacts
            WHERE chat_id NOT IN (SELECT id FROM chats)
            RETURNING id
        """
        
        async with self.db.transaction() as conn:
            cursor = await conn.execute(query)
            rows = await cursor.fetchall()
            deleted_count = len(rows)
            
        if deleted_count > 0:
            logger.warning(f"Deleted {deleted_count} orphaned artifacts")
        
        return deleted_count
    
    # =========================================================================
    # TRACEABILITY DATA (Message-Artifact Relationship Tracking)
    # =========================================================================
    
    async def save_traceability_data(self, data: Dict[str, Any]) -> None:
        """
        Save traceability data to PostgreSQL.
        
        Traceability data tracks relationships between messages and artifacts
        for debugging and audit trail purposes. Stored as JSON in metadata table.
        
        Args:
            data: Traceability data structure with indexes
        """
        import json
        
        try:
            # Create table if it doesn't exist
            create_table_query = """
                CREATE TABLE IF NOT EXISTS traceability_data (
                    id VARCHAR(255) PRIMARY KEY,
                    data JSONB NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            """
            
            # Store in a metadata table or as JSON in a dedicated traceability table
            # For simplicity, we'll use a key-value approach
            query = """
                INSERT INTO traceability_data (id, data, created_at, updated_at)
                VALUES ('global', %s::jsonb, NOW(), NOW())
                ON CONFLICT (id) 
                DO UPDATE SET 
                    data = EXCLUDED.data,
                    updated_at = NOW()
            """
            
            async with self.db.transaction() as conn:
                await conn.execute(create_table_query)
                await conn.execute(query, (json.dumps(data),))
            
            logger.info(f"Saved traceability data: {len(data.get('messages', []))} messages, {len(data.get('artifacts', []))} artifacts")
        except Exception as e:
            logger.warning(f"Failed to save traceability data (non-critical): {e}")
            # Don't raise - this is a non-critical feature
    
    async def load_traceability_data(self, chat_id: str) -> Optional[Dict[str, Any]]:
        """
        Load traceability data from PostgreSQL.
        
        Args:
            chat_id: Chat ID (for future per-chat filtering, currently loads global data)
            
        Returns:
            Traceability data structure or None if not found
        """
        import json
        
        try:
            # Load from metadata table
            query = """
                SELECT data
                FROM traceability_data
                WHERE id = 'global'
            """
            
            async with self.db.get_connection() as conn:
                cursor = await conn.execute(query)
                row = await cursor.fetchone()
            
            if row:
                data = dict(row)
                # Parse JSON if stored as string
                if isinstance(data.get('data'), str):
                    return json.loads(data['data'])
                return data.get('data')
        except Exception as e:
            logger.warning(f"Failed to load traceability data (non-critical): {e}")
        
        return None
    
    # =========================================================================
    # TRAIL STATE PERSISTENCE (Execution Trail UI State)
    # =========================================================================
    
    async def save_trail_state(self, chat_id: str, trail_data: Dict[str, Any]) -> None:
        """
        Save trail container state to PostgreSQL.
        
        Trail state includes DOM snapshots and metadata for execution trail UI.
        Allows trails to persist across frontend restarts.
        
        Args:
            chat_id: Chat ID to associate trail state with
            trail_data: Trail state structure with trails array and metadata
        """
        import json
        
        try:
            # Create table if it doesn't exist
            create_table_query = """
                CREATE TABLE IF NOT EXISTS trail_states (
                    chat_id VARCHAR(255) PRIMARY KEY,
                    data JSONB NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            """
            
            # Upsert trail state for this chat
            query = """
                INSERT INTO trail_states (chat_id, data, created_at, updated_at)
                VALUES (%s, %s::jsonb, NOW(), NOW())
                ON CONFLICT (chat_id) 
                DO UPDATE SET 
                    data = EXCLUDED.data,
                    updated_at = NOW()
            """
            
            async with self.db.transaction() as conn:
                await conn.execute(create_table_query)
                await conn.execute(query, (chat_id, json.dumps(trail_data)))
            
            logger.info(f"Saved trail state for chat {chat_id}: {len(trail_data.get('trails', []))} trails")
        except Exception as e:
            logger.warning(f"Failed to save trail state for chat {chat_id} (non-critical): {e}")
            # Don't raise - this is a non-critical feature
    
    async def load_trail_state(self, chat_id: str) -> Optional[Dict[str, Any]]:
        """
        Load trail container state from PostgreSQL.
        
        Args:
            chat_id: Chat ID to load trail state for
            
        Returns:
            Trail state structure or None if not found
        """
        import json
        
        try:
            query = """
                SELECT data
                FROM trail_states
                WHERE chat_id = %s
            """
            
            async with self.db.get_connection() as conn:
                cursor = await conn.execute(query, (chat_id,))
                row = await cursor.fetchone()
            
            if row:
                data = dict(row)
                # Parse JSON if stored as string
                if isinstance(data.get('data'), str):
                    return json.loads(data['data'])
                return data.get('data')
        except Exception as e:
            logger.warning(f"Failed to load trail state for chat {chat_id} (non-critical): {e}")
        
        return None
    
    async def delete_trail_state(self, chat_id: str) -> bool:
        """
        Delete trail state for a chat.
        
        Args:
            chat_id: Chat ID to delete trail state for
            
        Returns:
            True if deleted, False if not found
        """
        try:
            query = """
                DELETE FROM trail_states
                WHERE chat_id = %s
                RETURNING chat_id
            """
            
            async with self.db.transaction() as conn:
                cursor = await conn.execute(query, (chat_id,))
                row = await cursor.fetchone()
            
            if row:
                logger.info(f"Deleted trail state for chat {chat_id}")
                return True
        except Exception as e:
            logger.warning(f"Failed to delete trail state for chat {chat_id}: {e}")
        
        return False

