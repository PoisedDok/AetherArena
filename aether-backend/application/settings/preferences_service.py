"""
Preferences Service

Orchestrates user preferences read/write operations.

@.architecture
Incoming: api/v1/endpoints/preferences.py, api/v1/endpoints/settings.py --- {preference operations}
Processing: get, set, delete preferences --- {JOB_QUERY_DB, JOB_UPSERT_DATA}
Outgoing: data/database/repositories/preferences.py --- {Dict[str, Any]}
"""

from core.domain.repository_interfaces import IPreferencesRepository
from typing import Any, Dict
from monitoring import get_logger


logger = get_logger(__name__)

class PreferencesService:
    """Application service for managing user preferences."""

    def __init__(self, repository: IPreferencesRepository) -> None:
        self._repository = repository

    async def get_preference(
        self,
        preference_key: str,
        user_id: str,
        default_value: Any = None,
    ) -> Any:
        try:
            return await self._repository.get_preference(
                preference_key=preference_key,
                user_id=user_id,
                default_value=default_value,
            )
        except Exception as e:
            logger.error("Failed to get preference %s for user %s: %s", preference_key, user_id, e, exc_info=True)
            raise

    async def get_all_preferences(
        self,
        user_id: str,
    ) -> Dict[str, Any]:
        try:
            return await self._repository.get_all_preferences(user_id=user_id)
        except Exception as e:
            logger.error("Failed to get all preferences for user %s: %s", user_id, e, exc_info=True)
            raise

    async def set_preference(
        self,
        preference_key: str,
        preference_value: Any,
        user_id: str,
    ) -> bool:
        try:
            return await self._repository.set_preference(
                preference_key=preference_key,
                preference_value=preference_value,
                user_id=user_id,
            )
        except Exception as e:
            logger.error("Failed to set preference %s for user %s: %s", preference_key, user_id, e, exc_info=True)
            raise

    async def delete_preference(
        self,
        preference_key: str,
        user_id: str,
    ) -> bool:
        try:
            return await self._repository.delete_preference(
                preference_key=preference_key,
                user_id=user_id,
            )
        except Exception as e:
            logger.error("Failed to delete preference %s for user %s: %s", preference_key, user_id, e, exc_info=True)
            raise

    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass

__all__ = ["PreferencesService"]
