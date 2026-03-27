"""
Repository for search_indexes table operations using Supabase SDK.
"""

import logging
from typing import Any, Dict, List, Optional
from datetime import datetime

from core.domain.repository_interfaces import ISearchIndexesRepository
from ..clients.supabase import SupabaseClient
from ..persistence_gateway import SupabasePersistenceGateway

logger = logging.getLogger(__name__)

class SearchIndexesRepository(ISearchIndexesRepository):
    def __init__(self, db=None):
        if db is None:
            raise ValueError("SupabasePersistenceGateway or SupabaseClient instance required")
        if isinstance(db, SupabasePersistenceGateway):
            self._gateway = db
        elif isinstance(db, SupabaseClient):
            self._gateway = SupabasePersistenceGateway(db)
        else:
            raise TypeError("Expected SupabasePersistenceGateway or SupabaseClient")
        self.db = self._gateway

    async def register_index(
        self,
        index_name: str,
        source_type: str,
        index_directory: str,
        chunk_count: int,
        display_name: str,
        description: str,
        metadata: Dict[str, Any]
    ) -> Dict[str, Any]:
        try:
            data = {
                "index_name": index_name,
                "source_type": source_type,
                "index_directory": index_directory,
                "chunk_count": chunk_count,
                "display_name": display_name,
                "description": description,
                "metadata": metadata,
                "updated_at": datetime.utcnow().isoformat()
            }
            
            existing = await self._gateway.select(
                "search_indexes",
                filters={"index_name": index_name},
                limit=1,
                admin=True
            )
            
            if existing:
                result = await self._gateway.update(
                    "search_indexes",
                    data,
                    record_id=index_name,
                    id_column="index_name",
                    admin=True
                )
            else:
                data["created_at"] = data["updated_at"]
                result = await self._gateway.insert(
                    "search_indexes",
                    data,
                    admin=True
                )
                
            if isinstance(result, list) and result:
                return result[0]
            return data
        except Exception as e:
            logger.error(f"Failed to register search index {index_name}: {e}", exc_info=True)
            raise

    async def get_index(self, index_name: str) -> Optional[Dict[str, Any]]:
        try:
            result = await self._gateway.select(
                "search_indexes",
                filters={"index_name": index_name},
                limit=1,
                admin=True
            )
            return result[0] if result else None
        except Exception as e:
            logger.error(f"Failed to get search index {index_name}: {e}", exc_info=True)
            raise

    async def list_indexes(self) -> List[Dict[str, Any]]:
        try:
            return await self._gateway.select(
                "search_indexes",
                admin=True
            )
        except Exception as e:
            logger.error(f"Failed to list search indexes: {e}", exc_info=True)
            raise

    async def remove_index(self, index_name: str) -> bool:
        try:
            await self._gateway.delete(
                "search_indexes",
                record_id=index_name,
                id_column="index_name",
                admin=True
            )
            return True
        except Exception as e:
            logger.error(f"Failed to remove search index {index_name}: {e}", exc_info=True)
            raise
