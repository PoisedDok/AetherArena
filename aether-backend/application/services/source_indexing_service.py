"""
@.architecture
Incoming: api/v1/endpoints/sources.py, api/v1/endpoints/indexes.py, config/settings.py --- {Settings, source parameters}
Processing: validate source config, read local data sources, build AETHER_RAG indexes, update registry --- {JOB_VALIDATE_CONFIG, JOB_LOAD_DATA, JOB_BUILD_INDEX, JOB_SAVE_TO_DISK}
Outgoing: Filesystem (.aether_rag index files, registry.json) --- {index files, index registry}
"""

import asyncio
import logging
import shutil
import tempfile
import threading
import glob
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import unquote

from config.settings import Settings
from application.indexing.job_tracker import IndexingJobTracker
from application.indexing.index_storage import IndexStorageManager
from application.indexing.aether_rag_service import AetherRagService
from application.sources.custom_file_ingestor import CustomFileIngestor

from services.daemons.browser.db import BrowserDB
from services.daemons import QUERY_GEN_SIGNAL_FILE
from aether_rag.document_store import SQLiteDocumentStore

logger = logging.getLogger(__name__)

# Module-level lock to prevent race conditions during atomic swaps and registry updates
_commit_lock = threading.Lock()

class SourceIndexingService:
    """Build and register AETHER_RAG indexes for local data sources.
    Operates as a facade/orchestrator over specialized infrastructure and domain components.
    """

    def __init__(self, settings: Settings, search_indexes_repo=None):
        self.settings = settings
        self.sources_cfg = settings.integrations.aether_rag_sources
        
        index_root = Path(self.sources_cfg.index_root_dir).expanduser().resolve()
        
        self.registry = search_indexes_repo
        self.storage = IndexStorageManager(index_root)
        self.tracker = IndexingJobTracker()
        self.builder = AetherRagService(
            embedding_model=self.settings.embedding_service.model,
            api_base=self.settings.embedding_service.openai_base_url,
        )
        self.custom_ingestor = CustomFileIngestor()

    def list_indexes(self) -> List[Dict[str, Any]]:
        """Return all registered source indexes."""
        if not self.registry:
            return []
        import asyncio
        try:
            loop = asyncio.get_running_loop()
            indexes = loop.run_until_complete(self.registry.list_indexes())
        except RuntimeError:
            indexes = asyncio.run(self.registry.list_indexes())
            
        # Background/lazy validation: purge DB records if physical index was deleted
        valid_indexes = []
        for idx in indexes:
            index_dir = Path(idx.get("index_directory", ""))
            index_name = idx.get("index_name", "")
            if index_dir.exists() and (index_dir / f"{index_name}.aether_rag.meta.json").exists():
                # Ensure supported_modes is explicitly computed and available on the object
                meta = idx.get("metadata", {})
                modes = []
                bm25_only = meta.get("bm25_only", False)
                bm25_enabled = meta.get("bm25_enabled", True)
                
                if bm25_enabled or bm25_only:
                    modes.append("bm25")
                if not bm25_only:
                    modes.append("semantic")
                    modes.append("hybrid")
                    
                idx["supported_modes"] = modes
                idx["source_type"] = idx.get("source_type", "custom")
                valid_indexes.append(idx)
            else:
                logger.warning(f"Index {index_name} missing from disk, removing from registry.")
                try:
                    try:
                        loop = asyncio.get_running_loop()
                        loop.run_until_complete(self.registry.remove_index(index_name))
                    except RuntimeError:
                        asyncio.run(self.registry.remove_index(index_name))
                except Exception as e:
                    logger.error(f"Failed to lazily remove missing index {index_name}: {e}")
                    
        return valid_indexes

    def get_index_entry(self, index_name: str) -> Optional[Dict[str, Any]]:
        """Get a registered index entry by name."""
        if not self.registry:
            return None
        import asyncio
        try:
            loop = asyncio.get_running_loop()
            return loop.run_until_complete(self.registry.get_index(index_name))
        except RuntimeError:
            return asyncio.run(self.registry.get_index(index_name))

    def describe_sources(self) -> Dict[str, Any]:
        """Summarize available source integrations and registry state."""
        return {
            "enabled": self.sources_cfg.enabled,
            "index_root_dir": str(self.storage.index_root),
            "sources": {
                "browser_history": {
                    "enabled": self.sources_cfg.browser_history.enabled,
                    "default_index_name": self.sources_cfg.browser_history.default_index_name,
                    "max_items": self.sources_cfg.browser_history.max_items,
                    "browser": self.sources_cfg.browser_history.browser,
                    "profile_path": self.sources_cfg.browser_history.profile_path,
                    "auto_find_profiles": self.sources_cfg.browser_history.auto_find_profiles,
                    "user_data_dir": self.sources_cfg.browser_history.user_data_dir,
                },
                "email": {
                    "enabled": self.sources_cfg.email.enabled,
                    "default_index_name": self.sources_cfg.email.default_index_name,
                    "source_path": self.sources_cfg.email.source_path,
                    "max_items": self.sources_cfg.email.max_items,
                },
            },
            "indexes": self.list_indexes(),
        }

    def discover_browser_profiles(
        self,
        browser: str,
        user_data_dir_override: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Discover available browser profiles WITHOUT indexing.
        Returns profile metadata including estimated entry counts.
        """
        from application.sources.chromium_history import (
            resolve_chromium_user_data_dir,
            find_profile_dirs,
        )
        import sqlite3
        import os
        
        # Resolve User Data directory
        if user_data_dir_override:
            user_data_dir = Path(user_data_dir_override).expanduser().resolve()
        else:
            user_data_dir = resolve_chromium_user_data_dir(browser=browser)
        
        if not user_data_dir or not user_data_dir.exists():
            raise ValueError(f"Browser User Data directory not found for {browser}")
        
        # Find all profiles
        profile_dirs = find_profile_dirs(user_data_dir)
        
        if not profile_dirs:
            raise ValueError(f"No {browser} profiles with History database found in {user_data_dir}")
        
        profiles_info = []
        total_entries = 0
        
        for profile_dir in profile_dirs:
            history_db = profile_dir / "History"
            
            profile_info = {
                "profile_name": profile_dir.name,
                "profile_path": str(profile_dir),
                "history_db_exists": history_db.exists(),
                "estimated_entries": 0,
                "estimated_size_mb": 0.0,
                "last_modified": None,
            }
            
            if history_db.exists():
                try:
                    # Get DB size
                    size_bytes = os.path.getsize(history_db)
                    profile_info["estimated_size_mb"] = round(size_bytes / (1024 * 1024), 2)
                    
                    # Get last modified time
                    mtime = os.path.getmtime(history_db)
                    from datetime import datetime, timezone
                    profile_info["last_modified"] = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
                    
                    # Count entries (fast query)
                    conn = sqlite3.connect(str(history_db))
                    try:
                        cursor = conn.cursor()
                        cursor.execute("SELECT COUNT(*) FROM urls")
                        count = cursor.fetchone()[0]
                        profile_info["estimated_entries"] = count
                        total_entries += count
                    finally:
                        conn.close()
                        
                except Exception as e:
                    logger.warning("Failed to read profile %s: %s", profile_dir.name, e)
            
            profiles_info.append(profile_info)
        
        return {
            "success": True,
            "browser": browser,
            "user_data_dir": str(user_data_dir),
            "profiles": profiles_info,
            "total_estimated_entries": total_entries,
        }

    async def build_browser_history_index(
        self,
        index_name: Optional[str],
        browser: str,
        profile_path: Optional[str],
        auto_find_profiles: Optional[bool],
        max_items: Optional[int],
        force_rebuild: bool,
        build_semantic: bool = True,
        build_bm25: bool = True,
    ) -> Dict[str, Any]:
        """Queue a AETHER_RAG background index build from Chromium browser history."""
        from services.daemons.file_indexing.async_reindex import ReindexJobManager
        from data.database.repositories.files import FileIndexingRepository
        from data.database.persistence_gateway import SupabasePersistenceGateway
        
        from data.database.clients.supabase import SupabaseClient
        supabase_client = SupabaseClient.from_env()
        await supabase_client.initialize()
        gateway = SupabasePersistenceGateway(supabase_client)
        repo = FileIndexingRepository(gateway)
        
        manager = ReindexJobManager(repo)
        
        index_name = self.storage.sanitize_index_name(
            index_name or self.sources_cfg.browser_history.default_index_name
        )
        
        # Enqueue job
        job_info = await manager.trigger_reindex_async(
            location_name=index_name,
            source_type="browser",
            location_id=None
        )
        
        return {
            "index_name": index_name,
            "display_name": "Browser History",
            "state": job_info.get("status", "queued"),
            "progress_pct": 0,
            "files_total": 0,
            "job_id": str(job_info.get("job_id"))
        }

    async def build_email_index(
        self,
        index_name: Optional[str],
        source_path: Optional[str],
        max_items: Optional[int],
        force_rebuild: bool,
        build_semantic: bool = False,
        build_bm25: bool = True,
    ) -> Dict[str, Any]:
        """Queue a AETHER_RAG background index build from local emails."""
        from services.daemons.file_indexing.async_reindex import ReindexJobManager
        from data.database.repositories.files import FileIndexingRepository
        from data.database.persistence_gateway import SupabasePersistenceGateway
        
        from data.database.clients.supabase import SupabaseClient
        supabase_client = SupabaseClient.from_env()
        await supabase_client.initialize()
        gateway = SupabasePersistenceGateway(supabase_client)
        repo = FileIndexingRepository(gateway)
        
        manager = ReindexJobManager(repo)
        
        index_name = self.storage.sanitize_index_name(
            index_name or self.sources_cfg.email.default_index_name
        )
        
        # Enqueue job
        job_info = await manager.trigger_reindex_async(
            location_name=index_name,
            source_type="email",
            location_id=None
        )
        
        return {
            "index_name": index_name,
            "display_name": "Email Archive",
            "state": job_info.get("status", "queued"),
            "progress_pct": 0,
            "files_total": 0,
            "job_id": str(job_info.get("job_id"))
        }

    # =========================================================================
    # Custom User Source Indexing (files / folders / zips from native dialog)
    # =========================================================================

    def get_index_status(self, index_name: str) -> Dict[str, Any]:
        """Return the current indexing status for a background job."""
        job = self.tracker.get_job(index_name)
        if job:
            return job
            
        # Check database for active job
        from data.database.persistence_gateway import SupabasePersistenceGateway
        import asyncio
        from data.database.clients.supabase import SupabaseClient
        
        try:
            supabase_client = SupabaseClient.from_env()
            async def _check_db():
                await supabase_client.initialize()
                gateway = SupabasePersistenceGateway(supabase_client)
                # Find active job by location_name
                results = await gateway.select(
                    table="reindex_jobs",
                    filters={"location_name": index_name},
                    in_filters={"status": ["queued", "running", "paused"]},
                    admin=True
                )
                if results:
                    # Sort to get the most recent active job just in case
                    sorted_jobs = sorted(results, key=lambda x: x.get('created_at', ''), reverse=True)
                    return sorted_jobs[0]
                
                # If no active job, find the most recently completed/failed job for this location
                results = await gateway.select(
                    table="reindex_jobs",
                    filters={"location_name": index_name},
                    admin=True
                )
                if results:
                    sorted_jobs = sorted(results, key=lambda x: x.get('created_at', ''), reverse=True)
                    return sorted_jobs[0]
                return None
            
            try:
                loop = asyncio.get_running_loop()
                db_job = loop.run_until_complete(_check_db())
            except RuntimeError:
                db_job = asyncio.run(_check_db())
                
            if db_job:
                progress_pct = 0
                if db_job.get('files_total', 0) > 0:
                    progress_pct = int((db_job.get('files_scanned', 0) / db_job['files_total']) * 95)
                    if db_job.get('progress_phase') == 'completed':
                        progress_pct = 100
                elif db_job.get('status') == 'completed':
                    progress_pct = 100

                state_map = {
                    "running": "processing",
                    "queued": "queued",
                    "completed": "completed",
                    "failed": "failed",
                    "paused": "processing",
                    "stopped": "failed",
                    "cancelled": "failed"
                }

                return {
                    "index_name": index_name,
                    "state": state_map.get(db_job.get('status'), db_job.get('status')),
                    "progress_pct": progress_pct,
                    "files_total": db_job.get('files_total', 0),
                    "files_processed": db_job.get('files_scanned', 0),
                    "files_skipped": 0,
                    "chunk_count": db_job.get('chunks_processed', 0),
                    "error": db_job.get('error_message', None),
                }
        except Exception as e:
            logger.error(f"Failed to check job status from DB: {e}")

        # No active job — check if a completed index exists in registry
        entry = self.get_index_entry(index_name)
        if entry:
            meta = entry.get("metadata", {})
            return {
                "index_name": index_name,
                "state": "completed",
                "progress_pct": 100,
                "files_total": meta.get("files_total", 0),
                "files_processed": meta.get("files_total", 0),
                "files_skipped": meta.get("files_skipped", 0),
                "chunk_count": entry.get("chunk_count", 0),
                "error": None,
            }
        return {
            "index_name": index_name,
            "state": "not_found",
            "progress_pct": 0,
            "files_total": 0,
            "files_processed": 0,
            "files_skipped": 0,
            "chunk_count": 0,
            "error": None,
        }

    def list_active_jobs(self) -> List[Dict[str, Any]]:
        """Return all in-flight indexing jobs (queued or processing)."""
        return self.tracker.list_active_jobs()

    async def build_custom_index(
        self,
        file_paths: List[str],
        index_name: str,
        display_name: str,
        index_mode: List[str],
        chunk_size: Optional[int] = None,
        chunk_overlap: Optional[int] = None,
        force_rebuild: bool = False,
    ) -> Dict[str, Any]:
        """Start an async background job to build a AETHER_RAG index."""
        if not index_mode:
            raise ValueError("index_mode must contain at least one mode")

        if "semantic" in index_mode and "bm25" in index_mode:
            backend_mode = "combined"
        elif "bm25" in index_mode:
            backend_mode = "bm25"
        else:
            backend_mode = "semantic"

        index_name = self.storage.sanitize_index_name(index_name)
        index_dir = self.storage.get_index_dir("custom")

        # Pre-validate: reject duplicate unless force_rebuild
        await asyncio.to_thread(
            self.storage.enforce_index_state, index_dir, index_name, force_rebuild, self.builder.index_exists
        )

        if self.tracker.has_active_job(index_name):
            raise ValueError(f"An indexing job for '{index_name}' is already running.")
            
        # Register the job as queued
        job_info = {
            "index_name": index_name,
            "display_name": display_name,
            "state": "queued",
            "progress_pct": 0,
            "files_total": 0,
            "files_processed": 0,
            "files_skipped": 0,
            "chunk_count": 0,
            "error": None,
        }
        self.tracker.add_job(index_name, job_info)

        try:
            # Resolve all actual file paths (CPU/IO bound, dispatch to thread pool)
            resolved_files, temp_dirs = await asyncio.to_thread(
                self.custom_ingestor.resolve_input_paths, file_paths
            )
            if not resolved_files:
                def _cleanup_empty():
                    for td in temp_dirs:
                        shutil.rmtree(td, ignore_errors=True)
                await asyncio.to_thread(_cleanup_empty)
                raise ValueError("No indexable files found in the provided paths")
                
            self.tracker.update_job(index_name, files_total=len(resolved_files))
        except Exception:
            self.tracker.remove_job(index_name)
            raise

        try:
            # Fire-and-forget background task
            loop = asyncio.get_running_loop()
            loop.run_in_executor(
                None,
                self._run_custom_index_build,
                index_name,
                index_dir,
                display_name,
                resolved_files,
                backend_mode,
                temp_dirs,
                chunk_size,
                chunk_overlap,
            )
        except Exception:
            self.tracker.remove_job(index_name)
            def _cleanup_fail():
                for td in temp_dirs:
                    shutil.rmtree(td, ignore_errors=True)
            await asyncio.to_thread(_cleanup_fail)
            raise

        return self.tracker.get_job(index_name) or job_info

    def _run_custom_index_build(
        self,
        index_name: str,
        index_dir: Path,
        display_name: str,
        files: List[Path],
        index_mode: str,
        temp_dirs: Optional[List[Path]] = None,
        chunk_size: Optional[int] = None,
        chunk_overlap: Optional[int] = None,
    ) -> None:
        """Synchronous worker executed in a thread pool."""
        cleanup_dirs = list(temp_dirs) if temp_dirs else []
        remove_job_on_exit = True

        try:
            # Create staging directory for atomic build
            staging_dir = Path(tempfile.mkdtemp(prefix=f"aether_rag_staging_{index_name}_", dir=index_dir.parent))
            cleanup_dirs.append(staging_dir)

            if not self.tracker.update_job(index_name, state="processing"):
                logger.info("Custom index '%s' cancelled before processing started", index_name)
                return

            total_chunks_indexed = 0
            skipped = 0
            
            current_batch_chunks: List[Dict[str, Any]] = []

            for idx, file_path in enumerate(files):
                # Check for cancellation between files
                if not self.tracker.get_job(index_name):
                    logger.info("Custom index '%s' cancelled during file processing", index_name)
                    return

                logger.info("Custom index '%s': processing file %d/%d: %s", index_name, idx + 1, len(files), file_path.name)
                try:
                    chunk_iterator = self.custom_ingestor.read_file_to_chunks(
                        file_path,
                        chunk_size=chunk_size,
                        chunk_overlap=chunk_overlap,
                    )
                    for chunk in chunk_iterator:
                        current_batch_chunks.append(chunk)
                        
                        # Update tracker periodically without flushing to disk to save overhead
                        if len(current_batch_chunks) % 1000 == 0:
                            total = len(files)
                            pct = int(((idx + 1) / total) * 95) if total else 0
                            self.tracker.update_job(
                                index_name,
                                progress_pct=pct,
                                chunk_count=total_chunks_indexed + len(current_batch_chunks)
                            )
                        
                        # Flush batch to index if it gets very large (prevent OOM)
                        if len(current_batch_chunks) >= 5000:
                            is_first_batch = (total_chunks_indexed == 0)
                            total_chunks_indexed += self.builder._build_index_sync(
                                staging_dir, index_name, current_batch_chunks, index_mode, incremental=not is_first_batch,
                                defer_sparse_build=True, disable_sharding=True
                            )
                            current_batch_chunks = []
                except Exception as exc:
                    logger.warning("Custom index: failed to read %s: %s", file_path, exc)
                    skipped += 1

                # Flush batch to index
                if len(current_batch_chunks) >= 5000 or (idx + 1) == len(files):
                    if current_batch_chunks:
                        is_first_batch = (total_chunks_indexed == 0)
                        total_chunks_indexed += self.builder._build_index_sync(
                            staging_dir, index_name, current_batch_chunks, index_mode, incremental=not is_first_batch,
                            defer_sparse_build=True, disable_sharding=True
                        )
                        current_batch_chunks = []

                    total = len(files)
                    pct = int(((idx + 1) / total) * 95) if total else 0
                    self.tracker.update_job(
                        index_name,
                        files_processed=idx + 1,
                        files_skipped=skipped,
                        progress_pct=pct,
                        chunk_count=total_chunks_indexed
                    )

            if total_chunks_indexed == 0:
                raise RuntimeError("No text content extracted from any of the provided files")

            # Force sparse build at the end if it was deferred and enabled
            if index_mode in ("bm25", "combined", "hybrid"):
                self.builder._force_sparse_build_sync(str(staging_dir / f"{index_name}.aether_rag"))

            # Final check before committing to disk
            with _commit_lock:
                if not self.tracker.get_job(index_name):
                    logger.info("Custom index '%s' cancelled before disk write", index_name)
                    return

                # ATOMIC SWAP
                self.storage.delete_index_files(index_dir, index_name)
                for item in staging_dir.iterdir():
                    dest = index_dir / item.name
                    if dest.exists():
                        if dest.is_dir():
                            shutil.rmtree(dest, ignore_errors=True)
                        else:
                            dest.unlink(missing_ok=True)
                    shutil.move(str(item), str(dest))

                # Finalize
                file_names = [f.name for f in files[:5]]
                desc_suffix = f" (+{len(files) - 5} more)" if len(files) > 5 else ""
                description = ", ".join(file_names) + desc_suffix

                metadata = {
                    "source": "custom",
                    "files_total": len(files),
                    "files_skipped": skipped,
                    "index_mode": index_mode,
                }

                import asyncio
                if self.registry:
                    asyncio.run(self.registry.register_index(
                        index_name=index_name,
                        source_type="custom",
                        index_directory=str(index_dir),
                        chunk_count=total_chunks_indexed,
                        display_name=display_name,
                        description=description,
                        metadata=metadata,
                    ))
                else:
                    logger.warning("Registry missing, index '%s' built on disk but not registered", index_name)

                self.tracker.update_job(index_name, state="completed", progress_pct=100, chunk_count=total_chunks_indexed)
                remove_job_on_exit = False

            logger.info(
                "Custom index '%s' completed: %d chunks from %d files (%d skipped)",
                index_name, total_chunks_indexed, len(files), skipped,
            )

        except Exception as exc:
            logger.error("Custom index '%s' failed: %s", index_name, exc, exc_info=True)
            self.tracker.update_job(index_name, state="failed", error=str(exc))
            remove_job_on_exit = False
        finally:
            if remove_job_on_exit:
                self.tracker.remove_job(index_name)

            for tmp_dir in cleanup_dirs:
                try:
                    if tmp_dir.exists():
                        shutil.rmtree(tmp_dir, ignore_errors=True)
                except Exception:
                    pass

    def delete_index(self, index_name: str) -> Dict[str, Any]:
        """Delete a registered source index."""
        with _commit_lock:
            # Cancel any in-progress job first
            job_cancelled = self.tracker.remove_job(index_name)

            entry = self.get_index_entry(index_name)
            if not entry:
                if job_cancelled:
                    return {"success": True, "deleted": {"index_name": index_name, "note": "Cancelled pending/active job"}}
                raise ValueError(f"Index '{index_name}' not found in registry")

            # Because job is removed and we hold the lock, we just cleanly remove from disk & registry
            index_dir = Path(entry.get("index_directory", ""))
            if index_dir.exists():
                self.storage.delete_index_files(index_dir, index_name)

            import asyncio
            if self.registry:
                try:
                    loop = asyncio.get_running_loop()
                    loop.run_until_complete(self.registry.remove_index(index_name))
                except RuntimeError:
                    asyncio.run(self.registry.remove_index(index_name))

        logger.info("Deleted source index '%s' from %s", index_name, index_dir)
        return {"success": True, "deleted": entry}

    def dispose(self) -> None:
        """Clean up resources held by this service."""
        from application.indexing.aether_rag_service import dispose_aether_rag_service
        dispose_aether_rag_service()

    def log_activity(self, url: str, title: str, text_content: str) -> int:
        """Log UI activity into the browser daemon's SQLite database to trigger Proactive Agent."""
        db_path = self.settings.app_root / "data" / "daemons" / "browser" / "logs.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        
        db = BrowserDB(db_path)
        
        log_id = db.insert_log(
            url=url,
            title=title,
            search_query=text_content,
            visit_count=1,
            typed_count=1,
            profile="aether_study_ui"
        )
        
        # Touch signal file to trigger query generation immediately
        QUERY_GEN_SIGNAL_FILE.parent.mkdir(parents=True, exist_ok=True)
        QUERY_GEN_SIGNAL_FILE.touch(exist_ok=True)
        
        return log_id

    def get_aether_document(self, url: str) -> Dict[str, Any]:
        """Retrieve the full content of a document or note by its Aether URL."""
        if url.startswith("aether://index/"):
            parts = url.replace("aether://index/", "").split("/")
            if len(parts) >= 2:
                index_name = unquote(parts[0])
                doc_id = unquote("/".join(parts[1:]))
                
                base_dir = self.settings.app_root / "data" / "aether_rag_sources"
                index_paths = glob.glob(str(base_dir / f"**/{index_name}.aether_rag.sqlite"), recursive=True)
                
                db_path = None
                if index_paths:
                    db_path = Path(index_paths[0])
                else:
                    index_dir = self.settings.app_root / "data" / "indexes"
                    db_path = index_dir / f"{index_name}.aether_rag.sqlite"
                    if not db_path.exists():
                        db_path = index_dir / f"{index_name}.aether_rag" / "documents.db"
                    if not db_path.exists():
                        db_path = index_dir / index_name / "documents.db"
                        
                    if not db_path.exists():
                        logical_to_daemon = {
                            "browser_history": "browser_bm25",
                            "email": "email_bm25",
                        }
                        if index_name in logical_to_daemon:
                            db_path = index_dir / logical_to_daemon[index_name] / "documents.db"
                
                if not db_path or not db_path.exists():
                    raise ValueError(f"Index DB '{index_name}' not found")
                
                store = SQLiteDocumentStore(db_path)
                try:
                    docs = store.get([doc_id])
                    if not docs:
                        raise ValueError(f"Document '{doc_id}' not found in index '{index_name}'")
                    doc = docs[0]
                    return {
                        "url": url,
                        "title": doc.metadata.get("title", doc_id),
                        "content": doc.text,
                        "metadata": doc.metadata
                    }
                finally:
                    store.close()
            else:
                raise ValueError("Invalid aether://index URL format")
                
        elif url.startswith("aether://notes/"):
            note_name = unquote(url.replace("aether://notes/", ""))
            db_path = self.settings.app_root / "data" / "daemons" / "browser" / "logs.db"
            if not db_path.exists():
                raise ValueError("Browser DB not found")
                
            db = BrowserDB(db_path)
            conn = db._get_connection()
            cursor = conn.execute(
                "SELECT title, search_query FROM browser_logs WHERE url = ? ORDER BY timestamp DESC LIMIT 1",
                (url,)
            )
            row = cursor.fetchone()
            if row:
                return {
                    "url": url,
                    "title": row["title"] or note_name,
                    "content": row["search_query"] or "Empty note",
                    "metadata": {}
                }
            else:
                raise ValueError(f"Note '{note_name}' not found in logs")
        else:
            raise ValueError("Unsupported aether:// URL protocol")

