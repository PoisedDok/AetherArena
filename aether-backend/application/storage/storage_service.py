"""
Storage Service

Encapsulates top-level storage operations for traceability, statistics, and trail hierarchy.
"""

from core.domain.repository_interfaces import IChatRepository, IStorageRepository, ITrailRepository
from typing import List, Dict, Any
from uuid import UUID
from monitoring import get_logger

logger = get_logger(__name__)

class StorageService:
    def __init__(
        self,
        storage_repo: IStorageRepository,
        trail_repo: ITrailRepository,
        chat_repo: IChatRepository
    ):
        self._storage_repo = storage_repo
        self._trail_repo = trail_repo
        self._chat_repo = chat_repo

    async def save_traceability_data(self, data: Dict[str, Any]) -> None:
        """Save traceability data (message-artifact relationships and indexes)."""
        await self._storage_repo.save_traceability_data(data)
        logger.info(
            "Saved traceability data: %s messages, %d artifacts", 
            data.get("messages", [])[:10], 
            len(data.get("artifacts", []))
        )

    async def load_traceability_data(self, chat_id: str) -> Dict[str, Any]:
        """Load traceability data for a specific chat."""
        data = await self._storage_repo.load_traceability_data(chat_id)
        if not data:
            return {
                "version": "2.0",
                "timestamp": None,
                "messages": [],
                "artifacts": [],
                "correlationIndex": [],
                "messageArtifactsIndex": [],
                "artifactMessageIndex": [],
                "chatMessagesIndex": [],
                "chatArtifactsIndex": []
            }
        logger.info("Loaded traceability data for chat %s", chat_id)
        return data

    async def get_storage_statistics(self) -> Dict[str, Any]:
        """Get storage statistics across all chats and artifacts."""
        return await self._storage_repo.get_storage_statistics()

    async def get_trail_hierarchy(self, chat_id: UUID) -> List[Dict[str, Any]]:
        return await self._trail_repo.get_trail_hierarchy(chat_id)

    async def get_groups_by_chat(self, chat_id: UUID) -> List[Dict[str, Any]]:
        return await self._trail_repo.get_groups_by_chat(chat_id)

    async def get_subgroups_by_group(self, group_id: UUID) -> List[Dict[str, Any]]:
        return await self._trail_repo.get_subgroups_by_group(group_id)

    async def get_nodes_by_subgroup(self, subgroup_id: UUID) -> List[Dict[str, Any]]:
        return await self._trail_repo.get_nodes_by_subgroup(subgroup_id)

    async def get_subgroup_artifacts(self, subgroup_id: UUID) -> List[Dict[str, Any]]:
        return await self._trail_repo.get_subgroup_artifacts(subgroup_id)

    async def get_chat_session_map(self, chat_id: UUID, settings: Any) -> Dict[str, Any]:
        from application.chat.session_builder import SessionBuilder
        session_builder = SessionBuilder(
            trail_repository=self._trail_repo,
            chat_repository=self._chat_repo,
            settings=settings,
        )
        return await session_builder.build_session_map(str(chat_id))


    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
