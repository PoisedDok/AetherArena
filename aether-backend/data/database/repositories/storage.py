"""
@.architecture
Incoming: /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/api/v1/endpoints/storage.py; /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/data/database/clients/supabase.py::SupabaseClient --- {Dict[str, Any], json}
Processing: hydrate traceability payloads, emit Supabase telemetry --- {JOB_QUERY_DB, JOB_SAVE_TO_DB}
Outgoing: Supabase REST API (traceability_data tables); /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/api/v1/endpoints/storage.py --- {Dict[str, Any], json}
"""

from core.domain.repository_interfaces import IStorageRepository

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..clients.supabase import SupabaseClient
from ..persistence_gateway import SupabasePersistenceGateway

logger = logging.getLogger(__name__)

# Cache schema validation to avoid repeated round-trips.
_SCHEMA_LOCK = asyncio.Lock()
_SCHEMA_VALIDATED = False


class SchemaValidationError(Exception):
    """Raised when required Supabase schema elements are missing."""


class StorageRepository(IStorageRepository):
    """
    Repository for storage metadata and traceability using Supabase SDK.
    
    Provides clean API for:
    - Traceability data persistence (message-artifact relationships)
    - Artifact queries (via ChatRepository artifacts)
    - Storage statistics
    
    All methods use Supabase REST API (no raw SQL).
    
    NOTE: Trail hierarchy persistence is now handled by TrailRepository 
    (data/database/repositories/trail.py) using the groups→subgroups→nodes schema.
    """
    
    def __init__(self, db=None, *, session=None):
        """
        Initialize storage repository.
        
        Args:
            db: Supabase persistence gateway or raw Supabase client
            session: Legacy SQLAlchemy session (unsupported)
        """
        if session is not None:
            raise RuntimeError(
                "SQLAlchemy sessions are no longer supported. "
                "Initialize StorageRepository with a SupabasePersistenceGateway.",
            )
        if db is None:
            raise ValueError(
                "SupabasePersistenceGateway (or SupabaseClient) instance required for StorageRepository."
            )
        if isinstance(db, SupabasePersistenceGateway):
            self._gateway = db
        elif isinstance(db, SupabaseClient):
            self._gateway = SupabasePersistenceGateway(db)
        else:
            raise TypeError(
                "Unsupported database adapter for StorageRepository. "
                "Expected SupabasePersistenceGateway or SupabaseClient."
            )
        self.db = self._gateway
    
    # =========================================================================
    # ARTIFACT QUERIES
    # =========================================================================
    
    async def get_all_artifacts(
        self,
        artifact_type: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Get all artifacts across all chats.
        
        Args:
            artifact_type: Optional type filter (code, html, output, file, etc)
            limit: Maximum number of artifacts
            offset: Number of artifacts to skip
            
        Returns:
            List of artifact dicts
        """
        try:
            filters = {}
            if artifact_type:
                filters["type"] = artifact_type
            
            result = await self._gateway.select(
                "artifacts",
                filters=filters,
                order_by="created_at.desc",
                limit=limit,
                offset=offset,
                admin=True
            )
            
            return result
            
        except Exception as e:
            logger.error(f"Failed to get artifacts: {e}", exc_info=True)
            raise
    
    async def get_storage_statistics(self) -> Dict[str, Any]:
        """
        Get storage statistics (counts of chats, messages, artifacts).
        
        Returns:
            Dict with counts for each entity type
        """
        try:
            total_chats, total_messages, total_artifacts = await asyncio.gather(
                self._gateway.count("chats", admin=True),
                self._gateway.count("messages", admin=True),
                self._gateway.count("artifacts", admin=True),
            )
            
            # ARCHITECTURAL ENFORCEMENT: Only 2 artifact types exist (code, output)
            # Legacy types (console, html, json, text, markdown) are normalized to output+format
            artifact_types = ("code", "output")
            artifact_count_tasks = [
                self._gateway.count("artifacts", filters={"type": artifact_type}, admin=True)
                for artifact_type in artifact_types
            ]
            artifact_counts_raw = await asyncio.gather(*artifact_count_tasks)
            artifact_counts = {
                artifact_type: count
                for artifact_type, count in zip(artifact_types, artifact_counts_raw)
            }
            
            last_artifact = await self._gateway.select(
                "artifacts",
                columns="created_at",
                order_by="created_at.desc",
                limit=1,
                admin=True
            )
            last_artifact_at = last_artifact[0]["created_at"] if last_artifact else None
            
            return {
                "total_chats": total_chats,
                "total_messages": total_messages,
                "total_artifacts": total_artifacts,
                "artifact_counts_by_type": artifact_counts,
                "last_artifact_at": last_artifact_at,
                "total_content_bytes": 0
            }
            
        except Exception as e:
            logger.error(f"Failed to get storage statistics: {e}", exc_info=True)
            raise
    
    # =========================================================================
    # TRACEABILITY DATA (Message-Artifact Relationship Tracking)
    # =========================================================================
    
    async def save_traceability_data(self, data: Dict[str, Any]) -> None:
        """
        Save traceability data to Supabase.
        
        Traceability data tracks relationships between messages and artifacts
        for debugging and audit trail purposes. Stored as JSONB in traceability_data table.
        
        Args:
            data: Traceability data structure with message-artifact indexes
        """
        try:
            def _normalize_entity_entries(entries, entity_label: str) -> Dict[str, Any]:
                normalized: Dict[str, Any] = {}
                if not entries:
                    return normalized
                for entry in entries:
                    key = None
                    value = None
                    if isinstance(entry, (list, tuple)) and len(entry) == 2:
                        key, value = entry
                    elif isinstance(entry, dict):
                        candidate_fields = ["id"]
                        if entity_label == "artifact":
                            candidate_fields.extend(["artifact_id", "artifactId"])
                        elif entity_label == "message":
                            candidate_fields.extend(["message_id", "messageId"])
                        key_field = next(
                            (field for field in candidate_fields if entry.get(field)),
                            None,
                        )
                        if not key_field:
                            continue
                        key = entry.get(key_field)
                        fields_to_strip = set(candidate_fields)
                        value = {
                            k: v
                            for k, v in entry.items()
                            if k not in fields_to_strip
                        }
                    else:
                        logger.debug(
                            "Skipping invalid %s entry in traceability payload: %r",
                            entity_label,
                            entry,
                        )
                        continue
                    if key:
                        normalized[str(key)] = value
                return normalized

            messages = _normalize_entity_entries(
                data.get("messages"),
                entity_label="message",
            )
            artifacts = _normalize_entity_entries(
                data.get("artifacts"),
                entity_label="artifact",
            )
            chat_messages_index = {
                chat_id: message_ids or []
                for chat_id, message_ids in data.get("chatMessagesIndex", [])
            }
            chat_artifacts_index = {
                chat_id: artifact_ids or []
                for chat_id, artifact_ids in data.get("chatArtifactsIndex", [])
            }
            message_artifacts_index = {
                message_id: set(artifact_ids or [])
                for message_id, artifact_ids in data.get("messageArtifactsIndex", [])
            }
            artifact_message_index = {
                artifact_id: message_id
                for artifact_id, message_id in data.get("artifactMessageIndex", [])
            }
            correlation_index = {
                correlation_id: payload or {}
                for correlation_id, payload in data.get("correlationIndex", [])
            }
            
            chat_ids = set(chat_messages_index.keys()) | set(chat_artifacts_index.keys())
            chat_ids |= {
                msg.get("chatId")
                for msg in messages.values()
                if msg and msg.get("chatId")
            }
            chat_ids |= {
                art.get("chatId")
                for art in artifacts.values()
                if art and art.get("chatId")
            }
            chat_ids.discard(None)
            
            if not chat_ids:
                logger.debug("No chat IDs found in traceability payload; skipping persistence")
                return
            
            for chat_id in chat_ids:
                chat_message_ids = set(chat_messages_index.get(chat_id, []))
                chat_artifact_ids = set(chat_artifacts_index.get(chat_id, []))
                
                if not chat_message_ids:
                    chat_message_ids |= {
                        msg_id
                        for msg_id, msg in messages.items()
                        if msg and msg.get("chatId") == chat_id
                    }
                if not chat_artifact_ids:
                    chat_artifact_ids |= {
                        art_id
                        for art_id, art in artifacts.items()
                        if art and art.get("chatId") == chat_id
                    }
                
                chat_messages = [
                    [msg_id, msg]
                    for msg_id, msg in messages.items()
                    if msg and msg.get("chatId") == chat_id
                ]
                chat_artifacts = [
                    [art_id, art]
                    for art_id, art in artifacts.items()
                    if art and art.get("chatId") == chat_id
                ]
                
                chat_message_artifacts_index = [
                    [
                        message_id,
                        [
                            artifact_id
                            for artifact_id in message_artifacts_index.get(message_id, set())
                            if artifact_id in chat_artifact_ids
                        ]
                    ]
                    for message_id in chat_message_ids
                    if message_id in message_artifacts_index
                ]
                
                chat_artifact_message_index = [
                    [artifact_id, artifact_message_index.get(artifact_id)]
                    for artifact_id in chat_artifact_ids
                    if artifact_id in artifact_message_index
                ]
                
                chat_correlation_index = []
                for corr_id, payload in correlation_index.items():
                    request_id = payload.get("requestMessageId")
                    response_id = payload.get("responseMessageId")
                    if (
                        (request_id and request_id in chat_message_ids)
                        or (response_id and response_id in chat_message_ids)
                    ):
                        chat_correlation_index.append([corr_id, payload])
                
                chat_payload = {
                    "version": data.get("version", "2.0"),
                    "timestamp": data.get("timestamp"),
                    "messages": chat_messages,
                    "artifacts": chat_artifacts,
                    "correlationIndex": chat_correlation_index,
                    "messageArtifactsIndex": chat_message_artifacts_index,
                    "artifactMessageIndex": chat_artifact_message_index,
                    "chatMessagesIndex": [[chat_id, list(chat_message_ids)]],
                    "chatArtifactsIndex": [[chat_id, list(chat_artifact_ids)]],
                }
                
                record = {
                    "id": chat_id,
                    "data": chat_payload,
                    "updated_at": datetime.utcnow().isoformat()
                }
                
                await self._gateway.upsert(
                    "traceability_data",
                    record,
                    admin=True
                )
            
            logger.info(
                "Saved traceability data for %d chats (%d messages, %d artifacts)",
                len(chat_ids),
                len(messages),
                len(artifacts)
            )
            
        except Exception as e:
            logger.warning(f"Failed to save traceability data (non-critical): {e}")
            # Don't raise - this is a non-critical feature
    
    async def load_traceability_data(self, chat_id: str) -> Optional[Dict[str, Any]]:
        """
        Load traceability data from Supabase.
        
        Args:
            chat_id: Chat ID (for future per-chat filtering, currently loads global data)
            
        Returns:
            Traceability data structure or None if not found
        """
        try:
            result = await self._gateway.select(
                "traceability_data",
                filters={"id": chat_id},
                limit=1,
                admin=True
            )
            
            if result:
                return result[0].get("data")
            return None
            
        except Exception as e:
            logger.warning(f"Failed to load traceability data (non-critical): {e}")
            return None
    
    # =========================================================================
    # TRAIL STATE PERSISTENCE (Execution Trail UI State)
    # =========================================================================
    
    async def _ensure_schema(self) -> None:
        """Verify that trail persistence tables exist before use."""
        global _SCHEMA_VALIDATED
        if _SCHEMA_VALIDATED:
            return
        async with _SCHEMA_LOCK:
            if _SCHEMA_VALIDATED:
                return
            try:
                await self._gateway.select(
                    "trail_states",
                    columns="chat_id",
                    limit=1,
                    admin=True,
                )
            except Exception as exc:
                logger.error(
                    "Trail state schema verification failed. Ensure Supabase migrations "
                    "have been applied (services/supabase/docker/volumes/db/init/00-aether-schema.sql).",
                    exc_info=True,
                )
                raise SchemaValidationError(
                    "Trail state schema missing. Run Supabase migrations to create 'trail_states'."
                ) from exc
            else:
                _SCHEMA_VALIDATED = True
    
    async def save_trail_state(self, chat_id: str, trail_data: Dict[str, Any]) -> None:
        """
        Save trail container state to Supabase trail_states table.
        
        Trail state includes DOM snapshots and metadata for execution trail UI.
        Allows trails to persist across frontend restarts.
        
        Uses UPSERT to handle concurrent updates gracefully.
        
        Args:
            chat_id: Chat ID to associate trail state with
            trail_data: Trail state structure with trails array and metadata
        """
        await self._ensure_schema()
        record = {
            "chat_id": chat_id,
            "data": trail_data,
            "updated_at": datetime.utcnow().isoformat()
        }
        
        try:
            await self._gateway.upsert(
                "trail_states",
                record,
                admin=True
            )
            logger.info(f"Saved trail state for chat {chat_id}: {len(trail_data.get('trails', []))} trails")
        except Exception as primary_error:
            logger.error(
                f"Failed to save trail state for chat {chat_id}: {primary_error}",
                exc_info=True,
            )
            raise
    
    async def load_trail_state(self, chat_id: str) -> Optional[Dict[str, Any]]:
        """
        Load trail container state from Supabase.
        
        Args:
            chat_id: Chat ID to load trail state for
            
        Returns:
            Trail state structure or None if not found
        """
        await self._ensure_schema()
        try:
            result = await self._gateway.select(
                "trail_states",
                filters={"chat_id": chat_id},
                limit=1,
                admin=True
            )
            
            if result:
                return result[0].get("data")
            return None
        except Exception as primary_error:
            logger.error(
                f"Failed to load trail state for chat {chat_id}: {primary_error}",
                exc_info=True,
            )
            raise
    
    async def delete_trail_state(self, chat_id: str) -> bool:
        """
        Delete trail state for a chat.
        
        Args:
            chat_id: Chat ID to delete trail state for
            
        Returns:
            True if deleted, False if not found
        """
        await self._ensure_schema()
        try:
            await self._gateway.delete(
                "trail_states",
                record_id=chat_id,
                id_column="chat_id",
                admin=True
            )
            logger.info(f"Deleted trail state for chat {chat_id}")
            return True
        except Exception as primary_error:
            logger.error(
                f"Failed to delete trail state for chat {chat_id}: {primary_error}",
                exc_info=True,
            )
            raise
