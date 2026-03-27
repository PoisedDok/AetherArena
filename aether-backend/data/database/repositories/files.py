"""
@.architecture
Incoming: api/v1/endpoints/files.py, services/daemons/file_indexing/daemon.py --- {SupabaseClient, query parameters}
Processing: CRUD operations on file_indexing_* tables --- {4 jobs: JOB_DELETE_FROM_DB, JOB_QUERY_DB, JOB_SAVE_TO_DB, JOB_UPDATE_DB}
Outgoing: Supabase REST API (via SDK) --- {Dict[str, Any], List[Dict]}
"""

from core.domain.repository_interfaces import IFileIndexingRepository

import logging
import os
from typing import Any, Dict, List, Optional
from uuid import UUID
from datetime import datetime
from pathlib import Path

from ..clients.supabase import SupabaseClient
from ..persistence_gateway import SupabasePersistenceGateway

logger = logging.getLogger(__name__)


class FileIndexingRepository(IFileIndexingRepository):
    """Repository for file indexing operations using Supabase SDK."""
    
    def __init__(self, db=None):
        """Initialize repository with Supabase client or gateway."""
        if db is None:
            raise ValueError("SupabasePersistenceGateway or SupabaseClient instance required")
        if isinstance(db, SupabasePersistenceGateway):
            self._gateway = db
        elif isinstance(db, SupabaseClient):
            self._gateway = SupabasePersistenceGateway(db)
        else:
            raise TypeError("Expected SupabasePersistenceGateway or SupabaseClient")
        self.db = self._gateway

    @staticmethod
    def _normalize_path(path_value: str) -> str:
        """Normalize filesystem path for stable DB lookup and slash variants."""
        return os.path.abspath(os.path.normpath(path_value))

    @staticmethod
    def _resolve_path(path_value: str) -> str:
        """Resolve symlink/canonical path for fallback duplicate detection."""
        return os.path.realpath(os.path.abspath(path_value))

    def _location_matches_root_path(self, location: Dict[str, Any], normalized_root_path: str) -> bool:
        """Return True when stored location root_path resolves to normalized_root_path."""
        existing_root_path = location.get("root_path")
        if not existing_root_path:
            return False

        try:
            normalized_existing = self._normalize_path(existing_root_path)
            if normalized_existing == normalized_root_path:
                return True

            resolved_existing = self._resolve_path(existing_root_path)
            resolved_root_path = self._resolve_path(normalized_root_path)
            return resolved_existing == resolved_root_path
        except Exception:
            # Defensive: historical malformed paths should not crash comparisons.
            return False
    
    # =========================================================================
    # LOCATION OPERATIONS
    # =========================================================================
    
    async def create_location(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Create new indexing location."""
        if 'location_name' not in data:
            raise KeyError("location_name")
        if 'root_path' not in data:
            raise KeyError("root_path")
            
        try:
            # Generate index name from location name
            index_name = data['location_name'].lower().replace(' ', '_').replace('-', '_')
            index_name = ''.join(c for c in index_name if c.isalnum() or c == '_')
            
            # Generate index directory centrally to avoid polluting user directories
            from config.settings import Settings
            settings = Settings()
            index_directory = str(settings.app_root / "data" / "aether_rag_sources" / "filesystem" / index_name)
            
            location_data = {
                **data,
                'index_name': index_name,
                'index_directory': index_directory
            }
            
            result = await self._gateway.insert("file_indexing_locations", location_data, admin=True)
            
            if isinstance(result, list):
                result = result[0]
            
            logger.info(f"Created indexing location '{data['location_name']}' ({result['id']})")
            return result
        except Exception as e:
            logger.error("Failed to create location", exc_info=True, extra={"data": data, "error": str(e)})
            raise
    
    async def get_location(self, location_id: UUID) -> Optional[Dict[str, Any]]:
        """Get location by ID."""
        try:
            result = await self._gateway.select(
                "file_indexing_locations",
                filters={"id": str(location_id)},
                limit=1,
                admin=True
            )
            return result[0] if result else None
        except Exception as e:
            logger.error(f"Failed to get location {location_id}: {e}", exc_info=True)
            raise

    async def get_location_by_root_path(self, root_path: str) -> Optional[Dict[str, Any]]:
        """
        Get location by normalized root path.

        Performs exact DB lookup first, then falls back to normalized comparison
        across rows to prevent duplicates from slash/symlink path variants.
        """
        try:
            normalized_root_path = self._normalize_path(root_path)

            exact = await self._gateway.select(
                "file_indexing_locations",
                filters={"root_path": normalized_root_path},
                limit=1,
                admin=True,
            )
            if exact:
                return exact[0]

            locations = await self._gateway.select(
                "file_indexing_locations",
                admin=True,
            )
            for location in locations:
                if self._location_matches_root_path(location, normalized_root_path):
                    return location

            return None
        except Exception as e:
            logger.error(f"Failed to get location by root path {root_path}: {e}", exc_info=True)
            raise
    
    async def get_all_locations(self, enabled_only: bool = False) -> List[Dict[str, Any]]:
        """Get all indexing locations (sorted: primary first, then secondary)."""
        try:
            filters = {"enabled": True} if enabled_only else {}
            locations = await self._gateway.select(
                "file_indexing_locations",
                filters=filters,
                order_by="location_type",
                admin=True
            )
            # Sort: primary first (0), secondary second (1)
            locations.sort(key=lambda loc: 0 if loc.get('location_type') == 'primary' else 1)
            return locations
        except Exception as e:
            logger.error(f"Failed to get all locations: {e}", exc_info=True)
            raise
    
    async def update_location(self, location_id: UUID, updates: Dict[str, Any]) -> Dict[str, Any]:
        """Update location configuration."""
        try:
            result = await self._gateway.update(
                "file_indexing_locations",
                updates,
                record_id=str(location_id),
                admin=True
            )
            if isinstance(result, list) and result:
                result = result[0]
            elif not result:
                raise ValueError(f"Location {location_id} not found for update")
                
            logger.info(f"Updated location {location_id}")
            return result
        except Exception as e:
            logger.error(f"Failed to update location {location_id}: {e}", exc_info=True)
            raise
    
    async def delete_location(self, location_id: UUID) -> None:
        """Delete location (cascades to indexed_files)."""
        try:
            await self._gateway.delete("file_indexing_locations", record_id=str(location_id), admin=True)
            logger.info(f"Deleted location {location_id}")
        except Exception as e:
            logger.error(f"Failed to delete location {location_id}: {e}", exc_info=True)
            raise
    
    async def update_location_status(
        self,
        location_id: UUID,
        status: str,
        error: Optional[str] = None
    ) -> None:
        """Update location scan status."""
        updates = {
            "last_scan_status": status,
            "last_scan_at": datetime.utcnow().isoformat()
        }
        if error:
            updates["last_scan_error"] = error
        elif status == "completed":
            updates["last_scan_error"] = None  # Clear previous errors
        
        await self.update_location(location_id, updates)
    
    async def update_location_stats(
        self,
        location_id: UUID,
        status: str,
        file_count: int,
        chunk_count: Optional[int] = None,
        index_size_bytes: Optional[int] = None,
        duration_seconds: Optional[int] = None
    ) -> None:
        """Update location statistics after scan."""
        updates = {
            "last_scan_status": status,
            "last_scan_at": datetime.utcnow().isoformat(),
            "file_count": file_count,
            "last_scan_error": None
        }
        if duration_seconds is not None:
            updates["last_scan_duration_seconds"] = duration_seconds
        if chunk_count is not None:
            updates["chunk_count"] = chunk_count
        if index_size_bytes is not None:
            updates["index_size_bytes"] = index_size_bytes
            
        await self.update_location(location_id, updates)
    
    # =========================================================================
    # FILE OPERATIONS
    # =========================================================================
    
    async def upsert_indexed_file(
        self,
        location_id: UUID,
        file_meta: Dict[str, Any],
        chunk_count: int
    ) -> Dict[str, Any]:
        """Upsert indexed file metadata."""
        try:
            data = {
                "location_id": str(location_id),
                "file_path": file_meta['file_path'],
                "file_name": file_meta['file_name'],
                "file_size": file_meta['file_size'],
                "file_extension": file_meta['file_extension'],
                "mime_type": file_meta.get('mime_type'),
                "content_hash": file_meta['content_hash'],
                "file_modified_at": file_meta['file_modified_at'],
                "chunk_count": chunk_count,
                "creation_date": file_meta.get('creation_date'),
                "modification_date": file_meta.get('modification_date'),
                "status": "indexed",
                "indexed_at": datetime.utcnow().isoformat()
            }
            
            # Check if file already exists
            existing = await self._gateway.select(
                "indexed_files",
                filters={
                    "location_id": str(location_id),
                    "file_path": file_meta['file_path']
                },
                limit=1,
                admin=True
            )
            
            if existing:
                # Update existing record
                result = await self._gateway.update(
                    "indexed_files",
                    data,
                    record_id=existing[0]['id'],
                    admin=True
                )
            else:
                # Insert new record
                result = await self._gateway.insert(
                    "indexed_files",
                    data,
                    admin=True
                )
                if isinstance(result, list):
                    result = result[0]
            
            return result
        except Exception as e:
            logger.error(f"Failed to upsert indexed file {file_meta.get('file_path')}: {e}", exc_info=True)
            raise
    
    async def get_files_by_location(self, location_id: UUID) -> List[Dict[str, Any]]:
        """Get all indexed files for a location."""
        try:
            return await self._gateway.select(
                "indexed_files",
                filters={"location_id": str(location_id)},
                admin=True
            )
        except Exception as e:
            logger.error(f"Failed to get files by location {location_id}: {e}", exc_info=True)
            raise
    
    async def filter_changed_files(
        self,
        location_id: UUID,
        scanned_files: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Filter files that have changed since last index."""
        try:
            existing_files = await self.get_files_by_location(location_id)
            existing_hashes = {f['file_path']: f['content_hash'] for f in existing_files}
            
            changed = []
            for file_meta in scanned_files:
                file_path = file_meta['file_path']
                current_hash = file_meta['content_hash']
                
                # New file or hash changed
                if file_path not in existing_hashes or existing_hashes[file_path] != current_hash:
                    changed.append(file_meta)
            
            logger.info(f"Found {len(changed)} changed files out of {len(scanned_files)} scanned")
            return changed
        except Exception as e:
            logger.error(f"Failed to filter changed files for location {location_id}: {e}", exc_info=True)
            raise
    
    # =========================================================================
    # HEALTH OPERATIONS
    # =========================================================================
    
    async def register_service(self, process_id: int) -> Dict[str, Any]:
        """Register service on startup."""
        data = {
            "service_status": "running",
            "last_heartbeat": datetime.utcnow().isoformat(),
            "process_id": process_id,
            "consecutive_errors": 0
        }
        
        # Delete old health records by getting them first
        old_records = await self._gateway.select(
            "file_indexing_health",
            admin=True
        )
        for record in old_records:
            await self._gateway.delete("file_indexing_health", record_id=record['id'], admin=True)
        
        # Insert new record
        result = await self._gateway.insert("file_indexing_health", data, admin=True)
        
        if isinstance(result, list):
            result = result[0]
        
        logger.info(f"Registered service with PID {process_id}")
        return result
    
    async def update_heartbeat(self) -> None:
        """Update service heartbeat."""
        # Update most recent health record
        records = await self._gateway.select(
            "file_indexing_health",
            order_by="created_at.desc",
            limit=1,
            admin=True
        )
        
        if records:
            await self._gateway.update(
                "file_indexing_health",
                {
                    "last_heartbeat": datetime.utcnow().isoformat(),
                    "service_status": "idle"  # Fix: Update status to show service is alive
                },
                record_id=records[0]['id'],
                admin=True
            )
    
    async def update_service_status(self, status: str, error: Optional[str] = None) -> None:
        """Update service status."""
        records = await self._gateway.select(
            "file_indexing_health",
            order_by="created_at.desc",
            limit=1,
            admin=True
        )
        
        if records:
            updates = {"service_status": status}
            if error:
                updates["error_message"] = error
                updates["consecutive_errors"] = records[0].get("consecutive_errors", 0) + 1
            else:
                updates["consecutive_errors"] = 0
            
            await self._gateway.update(
                "file_indexing_health",
                updates,
                record_id=records[0]['id'],
                admin=True
            )
    
    async def get_service_health(self) -> Optional[Dict[str, Any]]:
        """Get current service health."""
        records = await self._gateway.select(
            "file_indexing_health",
            order_by="created_at.desc",
            limit=1,
            admin=True
        )
        return records[0] if records else None

    async def get_active_reindex_job(self, location_id: UUID) -> Optional[Dict[str, Any]]:
        """Get the most recent active reindex job for a location."""
        results = await self._gateway.select(
            "reindex_jobs",
            filters={"location_id": str(location_id)},
            in_filters={"status": ["running", "queued", "paused"]},
            order_by="created_at.desc",
            limit=1,
            admin=True
        )
        return results[0] if results else None
    
    async def get_daemon_config(self) -> Optional[Dict[str, Any]]:
        """Get global daemon configuration."""
        records = await self._gateway.select(
            "file_indexing_config",
            limit=1,
            admin=True
        )
        return records[0] if records else None
    
    async def update_daemon_config(self, config: Dict[str, Any]) -> None:
        """Update global daemon configuration."""
        # Check if config exists
        existing = await self.get_daemon_config()
        
        # The fixed ID for singleton config
        config_id = '00000000-0000-0000-0000-000000000001'
        
        if not existing:
            # Create new config entry with fixed ID
            config_data = {
                'id': config_id,
                **config
            }
            await self._gateway.insert(
                "file_indexing_config",
                config_data,
                admin=True
            )
        else:
            # Update existing config by ID (don't include id in update data)
            await self._gateway.update(
                "file_indexing_config",
                {k: v for k, v in config.items() if k != "id"},
                record_id=config_id,
                admin=True
            )

