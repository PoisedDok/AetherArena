"""
Storage Repository - Data access layer for file storage metadata

@.architecture
Incoming: api/v1/endpoints/storage.py, data/database/connection.py --- {DatabaseConnection instance, artifact query requests, search requests, statistics requests}
Processing: get_all_artifacts(), search_artifacts(), get_artifacts_by_filename(), get_storage_statistics(), get_chat_storage_usage(), delete_orphaned_artifacts() --- {6 jobs: artifact_querying, fulltext_search, statistics_aggregation, cleanup_operations}
Outgoing: PostgreSQL (via DatabaseConnection), api/v1/endpoints/storage.py --- {SQL SELECT/DELETE with PostgreSQL FTS (GIN index), artifact dicts with chat_title, statistics dicts}

Provides operations for:
- File metadata tracking
- Storage location management
- File type categorization

This repository tracks metadata about files stored on disk.
The actual file content is managed by LocalFileStorage in data/storage/.
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

