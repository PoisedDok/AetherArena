"""
File Service

Orchestrates file uploads, indexing location management, and reindex job control.
"""

from core.domain.repository_interfaces import IChatRepository, IFileIndexingRepository
import shutil
from pathlib import Path as PathLib
from typing import List, Optional, Dict, Any
from uuid import UUID, uuid4
from datetime import datetime, timezone
import base64

from config.settings import Settings
from security.sanitization import DEFAULT_LIMITS
from monitoring import get_logger

logger = get_logger(__name__)

class FileService:
    def __init__(
        self,
        settings: Settings,
        file_indexing_repo: IFileIndexingRepository,
        chat_repo: IChatRepository
    ):
        self._settings = settings
        self._file_indexing_repo = file_indexing_repo
        self._chat_repo = chat_repo

    async def upload_file(
        self,
        filename: str,
        content_bytes: bytes,
        content_type: str,
        purpose: str,
        chat_id: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            allowed_extensions = {'.pdf', '.doc', '.docx', '.txt', '.md', '.json', '.csv'}
            
            file_ext = PathLib(filename).suffix.lower()
            if file_ext not in allowed_extensions:
                raise ValueError(f"File type not allowed: {file_ext}. Allowed: {', '.join(allowed_extensions)}")
                
            file_size = len(content_bytes)
            max_size_bytes = DEFAULT_LIMITS.MAX_FILE_SIZE_BYTES
            
            if file_size > max_size_bytes:
                raise ValueError(f"File too large: {file_size / 1024 / 1024:.2f}MB (max: {max_size_bytes / (1024 * 1024):.0f}MB)")
                
            if file_size == 0:
                raise ValueError("File is empty")
                
            try:
                if file_ext in {'.txt', '.md', '.json', '.csv'}:
                    content_text = content_bytes.decode('utf-8')
                else:
                    content_text = base64.b64encode(content_bytes).decode('utf-8')
            except UnicodeDecodeError:
                raise ValueError("File encoding not supported (expected UTF-8 for text files)")
                
            if not chat_id:
                system_chat = await self._chat_repo.get_or_create_chat_by_title("__system_file_uploads__")
                chat_id = str(system_chat.id)
                logger.info("Using system file uploads chat: %s", chat_id)
                
            artifact_id_str = f"upload_{uuid4().hex[:12]}"
            
            metadata = {
                "purpose": purpose,
                "content_type": content_type or "application/octet-stream",
                "size": file_size,
                "extension": file_ext,
                "is_base64": file_ext in {'.pdf', '.doc', '.docx'},
                "uploaded_at": datetime.now(timezone.utc).isoformat()
            }
            
            created_artifact = await self._chat_repo.create_artifact(
                chat_id=UUID(str(chat_id)),
                type="file",
                content=content_text,
                filename=filename,
                artifact_id=artifact_id_str,
                metadata=metadata
            )
            
            attachment_id = created_artifact.id
            logger.info("File uploaded: %s (%d bytes) -> artifact %s", filename, file_size, attachment_id)
            
            if isinstance(created_artifact.created_at, str):
                created_dt = datetime.fromisoformat(created_artifact.created_at.replace('Z', '+00:00'))
            else:
                created_dt = created_artifact.created_at
                
            return {
                "attachment_id": attachment_id,
                "filename": filename,
                "size": file_size,
                "content_type": content_type or "application/octet-stream",
                "created_at": created_dt
            }
        except Exception as e:
            logger.error("Failed to upload file %s: %s", filename, e, exc_info=True)
            raise
        
    async def get_indexing_locations(self, enabled_only: bool = False) -> List[Dict[str, Any]]:
        try:
            return await self._file_indexing_repo.get_all_locations(enabled_only=enabled_only)
        except Exception as e:
            logger.error("Failed to get indexing locations: %s", e, exc_info=True)
            raise
        
    async def create_indexing_location(self, location_data: Dict[str, Any]) -> Dict[str, Any]:
        try:
            requested_root_path = location_data.get("root_path", "").strip()
            root = PathLib(requested_root_path).expanduser()
            try:
                normalized_root_path = str(root.resolve(strict=True))
            except FileNotFoundError:
                raise ValueError(f"Directory does not exist: {requested_root_path}")
            except Exception as path_error:
                raise ValueError(f"Invalid directory path: {requested_root_path}") from path_error

            if not PathLib(normalized_root_path).is_dir():
                raise ValueError(f"Path is not a directory: {requested_root_path}")

            existing_location = await self._file_indexing_repo.get_location_by_root_path(normalized_root_path)
            if existing_location:
                logger.info("Indexing location already exists for path '%s'", normalized_root_path)
                return existing_location

            create_payload = location_data.copy()
            create_payload["root_path"] = normalized_root_path
            result = await self._file_indexing_repo.create_location(create_payload)
            logger.info("Created indexing location: %s", result["location_name"])
            return result
        except Exception as e:
            logger.error("Failed to create indexing location: %s", e, exc_info=True)
            raise
        
    async def get_indexing_location(self, location_id: UUID) -> Optional[Dict[str, Any]]:
        try:
            return await self._file_indexing_repo.get_location(location_id)
        except Exception as e:
            logger.error("Failed to get indexing location %s: %s", location_id, e, exc_info=True)
            raise
        
    async def update_indexing_location(self, location_id: UUID, updates: Dict[str, Any]) -> Dict[str, Any]:
        try:
            existing = await self._file_indexing_repo.get_location(location_id)
            if not existing:
                raise ValueError(f"Location not found: {location_id}")
                
            result = await self._file_indexing_repo.update_location(location_id, updates)
            logger.info("Updated location %s", location_id)
            return result
        except Exception as e:
            logger.error("Failed to update indexing location %s: %s", location_id, e, exc_info=True)
            raise
        
    async def delete_indexing_location(self, location_id: UUID) -> bool:
        try:
            existing = await self._file_indexing_repo.get_location(location_id)
            if not existing:
                raise ValueError(f"Location not found: {location_id}")
                
            try:
                root_path = PathLib(existing["root_path"]).expanduser().resolve()
                index_dir = PathLib(existing.get("index_directory", "")).expanduser().resolve()
                
                # Check if it's within our new global storage path or the old legacy path
                from config.settings import Settings
                settings = Settings()
                safe_global_parent = settings.app_root / "data" / "aether_rag_sources" / "filesystem"
                safe_legacy_parent = root_path / ".aether_rag_index"
                
                is_safe_global = safe_global_parent in index_dir.parents
                is_safe_legacy = safe_legacy_parent in index_dir.parents
                
                if index_dir and (is_safe_global or is_safe_legacy) and index_dir.exists():
                    await __import__("asyncio").to_thread(shutil.rmtree, index_dir)
            except Exception as cleanup_error:
                logger.warning("Failed to delete index directory for %s: %s", location_id, cleanup_error)
                
            await self._file_indexing_repo.delete_location(location_id)
            logger.info("Deleted location %s", location_id)
            return True
        except Exception as e:
            logger.error("Failed to delete indexing location %s: %s", location_id, e, exc_info=True)
            raise
        
    async def get_active_reindex_job(self, location_id: UUID) -> Optional[Dict[str, Any]]:
        try:
            return await self._file_indexing_repo.get_active_reindex_job(location_id)
        except Exception as e:
            logger.error("Failed to get active reindex job for %s: %s", location_id, e, exc_info=True)
            raise
        
    async def trigger_manual_reindex(self, location_id: UUID) -> Dict[str, Any]:
        try:
            location = await self._file_indexing_repo.get_location(location_id)
            if not location:
                raise ValueError(f"Location not found: {location_id}")
                
            from services.daemons.file_indexing.async_reindex import ReindexJobManager
            job_manager = ReindexJobManager(self._file_indexing_repo)
            result = await job_manager.trigger_reindex_async(
                location_name=location['location_name'],
                source_type="filesystem",
                location_id=location_id
            )
            logger.info("Async reindex job %s queued for %s", result["job_id"], location["location_name"])
            return result
        except Exception as e:
            logger.error("Failed to trigger manual reindex for %s: %s", location_id, e, exc_info=True)
            raise
        
    async def get_reindex_job_status(self, job_id: UUID) -> Optional[Dict[str, Any]]:
        try:
            from services.daemons.file_indexing.async_reindex import ReindexJobManager
            job_manager = ReindexJobManager(self._file_indexing_repo)
            return await job_manager.get_job_status(job_id)
        except Exception as e:
            logger.error("Failed to get reindex job status for %s: %s", job_id, e, exc_info=True)
            raise
        
    async def pause_reindex_job(self, job_id: UUID) -> None:
        try:
            from services.daemons.file_indexing.async_reindex import ReindexJobManager
            job_manager = ReindexJobManager(self._file_indexing_repo)
            await job_manager.pause_job(job_id)
            logger.info("Paused reindex job %s", job_id)
        except Exception as e:
            logger.error("Failed to pause reindex job %s: %s", job_id, e, exc_info=True)
            raise
        
    async def resume_reindex_job(self, job_id: UUID) -> None:
        try:
            from services.daemons.file_indexing.async_reindex import ReindexJobManager
            job_manager = ReindexJobManager(self._file_indexing_repo)
            await job_manager.resume_job(job_id)
            logger.info("Resumed reindex job %s", job_id)
        except Exception as e:
            logger.error("Failed to resume reindex job %s: %s", job_id, e, exc_info=True)
            raise
        
    async def stop_reindex_job(self, job_id: UUID) -> None:
        try:
            from services.daemons.file_indexing.async_reindex import ReindexJobManager
            job_manager = ReindexJobManager(self._file_indexing_repo)
            await job_manager.stop_job(job_id)
            logger.info("Stopped reindex job %s", job_id)
        except Exception as e:
            logger.error("Failed to stop reindex job %s: %s", job_id, e, exc_info=True)
            raise
        
    async def cancel_reindex_job(self, job_id: UUID) -> None:
        try:
            from services.daemons.file_indexing.async_reindex import ReindexJobManager
            job_manager = ReindexJobManager(self._file_indexing_repo)
            await job_manager.cancel_job(job_id)
            logger.info("Cancelled reindex job %s", job_id)
        except Exception as e:
            logger.error("Failed to cancel reindex job %s: %s", job_id, e, exc_info=True)
            raise


    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
