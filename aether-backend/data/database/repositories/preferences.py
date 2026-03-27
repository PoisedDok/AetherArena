"""
User Preferences Repository

@.architecture
Incoming: API endpoints, service layers --- {preference_key, preference_value}
Processing: get_preference(), set_preference(), get_all_preferences() --- {3 jobs: JOB_QUERY_DB, JOB_UPSERT_DATA, JOB_TRANSFORM_DATA}
Outgoing: User preferences dict --- {Dict[str, Any]}
"""

from core.domain.repository_interfaces import IPreferencesRepository

import logging
from typing import Any, Dict
from datetime import datetime

from ..clients.supabase import SupabaseClient
from ..persistence_gateway import SupabasePersistenceGateway

logger = logging.getLogger(__name__)


class PreferencesRepository(IPreferencesRepository):
    """
    Repository for user preferences using Supabase SDK.
    
    Manages user-configurable runtime preferences (auto-summary, UI settings, etc.)
    All operations use Supabase REST API (no raw SQL).
    """
    
    def __init__(self, db=None, *, session=None):
        """
        Initialize preferences repository.
        
        Args:
            db: Supabase persistence gateway or raw Supabase client
            session: Legacy SQLAlchemy session (not supported)
        """
        if session is not None:
            raise RuntimeError(
                "SQLAlchemy sessions are no longer supported. "
                "Initialize PreferencesRepository with a SupabasePersistenceGateway."
            )
        
        self._gateway = None
        if db is not None:
            if isinstance(db, SupabasePersistenceGateway):
                self._gateway = db
            elif isinstance(db, SupabaseClient):
                self._gateway = SupabasePersistenceGateway(db)
            else:
                raise TypeError(
                    "Unsupported database adapter. "
                    "Expected SupabasePersistenceGateway or SupabaseClient."
                )
        self.db = self._gateway
    
    async def get_preference(
        self, 
        preference_key: str, 
        user_id: str = "default_user",
        default_value: Any = None
    ) -> Any:
        """
        Get a user preference value.
        
        Args:
            preference_key: Preference identifier (e.g., 'auto_summarize')
            user_id: User identifier (default: 'default_user')
            default_value: Value to return if preference not found
            
        Returns:
            Preference value (from JSONB field) or default_value
        """
        if self._gateway is None:
            logger.debug(f"Database not available, returning default for preference {preference_key}")
            return default_value

        try:
            response = await self._gateway.select(
                table="user_preferences",
                filters={
                    "user_id": user_id,
                    "preference_key": preference_key
                }
            )
            
            if response and len(response) > 0:
                # Return the value from JSONB field
                return response[0].get("preference_value", default_value)
            
            return default_value
            
        except Exception as e:
            logger.error(
                f"Failed to get preference {preference_key} for user {user_id}: {e}",
                exc_info=True
            )
            return default_value
    
    async def set_preference(
        self,
        preference_key: str,
        preference_value: Any,
        user_id: str = "default_user"
    ) -> bool:
        """
        Set a user preference value (upsert).
        
        Args:
            preference_key: Preference identifier
            preference_value: Value to store (will be converted to JSONB)
            user_id: User identifier
            
        Returns:
            True if successful, False otherwise
        """
        if self._gateway is None:
            logger.warning(f"Database not available, cannot set preference {preference_key}")
            return False

        try:
            # Upsert preference (unique constraint on user_id+preference_key handles conflicts)
            data = {
                "user_id": user_id,
                "preference_key": preference_key,
                "preference_value": preference_value,
                "updated_at": datetime.utcnow().isoformat()
            }
            
            response = await self._gateway.upsert(
                table="user_preferences",
                data=data,
                admin=True
            )
            
            logger.info(
                f"Set preference {preference_key}={preference_value} for user {user_id}"
            )
            return True
            
        except Exception as e:
            logger.error(
                f"Failed to set preference {preference_key} for user {user_id}: {e}",
                exc_info=True
            )
            return False
    
    async def get_all_preferences(
        self, 
        user_id: str = "default_user"
    ) -> Dict[str, Any]:
        """
        Get all preferences for a user.
        
        Args:
            user_id: User identifier
            
        Returns:
            Dict mapping preference_key to preference_value
        """
        if self._gateway is None:
            logger.debug("Database not available, returning empty dict for all preferences")
            return {}

        try:
            response = await self._gateway.select(
                table="user_preferences",
                filters={"user_id": user_id}
            )
            
            # Convert list of records to dict
            preferences = {}
            for record in response:
                key = record.get("preference_key")
                value = record.get("preference_value")
                if key:
                    preferences[key] = value
            
            return preferences
            
        except Exception as e:
            logger.error(
                f"Failed to get all preferences for user {user_id}: {e}",
                exc_info=True
            )
            return {}
    
    async def delete_preference(
        self,
        preference_key: str,
        user_id: str = "default_user"
    ) -> bool:
        """
        Delete a user preference.
        
        Args:
            preference_key: Preference identifier
            user_id: User identifier
            
        Returns:
            True if successful, False otherwise
        """
        if self._gateway is None:
            logger.warning(f"Database not available, cannot delete preference {preference_key}")
            return False

        try:
            # First, fetch the record to get its ID
            response = await self._gateway.select(
                table="user_preferences",
                filters={
                    "user_id": user_id,
                    "preference_key": preference_key
                },
                admin=True
            )
            
            if not response or len(response) == 0:
                logger.warning(
                    f"Preference {preference_key} not found for user {user_id}"
                )
                return False
            
            # Delete by ID
            record_id = response[0]["id"]
            await self._gateway.delete(
                table="user_preferences",
                record_id=str(record_id),
                admin=True
            )
            
            logger.info(
                f"Deleted preference {preference_key} for user {user_id}"
            )
            return True
            
        except Exception as e:
            logger.error(
                f"Failed to delete preference {preference_key} for user {user_id}: {e}",
                exc_info=True
            )
            return False
