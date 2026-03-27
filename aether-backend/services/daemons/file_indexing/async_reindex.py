"""
Async File Indexing Reindex System

@.architecture
Incoming: API endpoints --- {location_id, job_id}
Processing: async reindex with progress tracking, file scanning, embedding generation --- {6 jobs: JOB_QUERY_DB, JOB_SAVE_TO_DB, JOB_SEARCH_INDEX, JOB_TRANSFORM_DATA, JOB_UPDATE_UI, JOB_VALIDATE_INPUT}
Outgoing: Database (job status updates), Index files --- {progress updates, indexed chunks}
"""

import asyncio
from pathlib import Path as PathLib
from datetime import datetime
from typing import Dict, Any, Optional
from uuid import UUID

from monitoring import get_logger
from data.database.repositories.files import FileIndexingRepository
from core.system.task_tracker import TaskTracker

logger = get_logger(__name__)

# Global registry of running jobs for cancellation
_running_jobs: Dict[str, asyncio.Task] = {}

# Global registry of job control flags (pause/stop)
_job_controls: Dict[str, Dict[str, bool]] = {}  # {job_id: {"paused": bool, "should_stop": bool}}


class ReindexJobManager:
    """Manages async reindex jobs with progress tracking"""
    
    def __init__(self, repository: FileIndexingRepository):
        self.repository = repository
        # Use the repository's gateway which already has an initialized client
        self._gateway = repository._gateway
    
    async def cleanup_stale_statuses(self):
        """
        Cleanup stale 'running' statuses on startup.
        Called when backend restarts to fix orphaned jobs.
        """
        try:
            # Mark all running jobs as failed (they were interrupted)
            results = await self._gateway.select(
                table="reindex_jobs",
                filters={"status": "running"},
                admin=True
            )
            
            for job in results:
                await self.update_job_progress(
                    job_id=job['id'],
                    status="failed",
                    error_message="Job interrupted by server restart",
                    completed_at=datetime.utcnow()
                )
                logger.warning(f"Cleaned up stale job {job['id']} - marked as failed")
            
            # Fix any locations stuck in 'running' status
            running_locations = await self._gateway.select(
                table="file_indexing_locations",
                filters={"last_scan_status": "running"},
                admin=True
            )
            
            for location in running_locations:
                await self._gateway.update(
                    table="file_indexing_locations",
                    record_id=str(location['id']),
                    data={"last_scan_status": "failed"},
                    admin=True
                )
                logger.warning(f"Fixed stale location status: {location['location_name']}")
            
            if results:
                logger.info(f"✅ Cleaned up {len(results)} stale reindex jobs")
                
        except Exception as e:
            logger.error(f"Failed to cleanup stale statuses: {e}", exc_info=True)
    
    async def create_job(self, location_name: str, source_type: str = "filesystem", location_id: Optional[UUID] = None) -> Dict[str, Any]:
        """Create a new reindex job"""
        job_data = {
            "location_name": location_name,
            "source_type": source_type,
            "status": "queued",
            "progress_phase": "queued",
            "files_scanned": 0,
            "files_total": 0,
            "chunks_processed": 0,
            "created_at": datetime.utcnow().isoformat()
        }
        if location_id:
            job_data["location_id"] = str(location_id)
        
        result = await self._gateway.insert(
            table="reindex_jobs",
            data=job_data,
            admin=True
        )
        
        if isinstance(result, list):
            result = result[0]
        
        logger.info(f"Created reindex job {result['id']} for location {location_name}")
        return result
    
    async def update_job_progress(
        self,
        job_id: UUID,
        status: Optional[str] = None,
        progress_phase: Optional[str] = None,
        files_scanned: Optional[int] = None,
        files_total: Optional[int] = None,
        chunks_processed: Optional[int] = None,
        error_message: Optional[str] = None,
        started_at: Optional[datetime] = None,
        completed_at: Optional[datetime] = None,
        checkpoint_data: Optional[Dict[str, Any]] = None
    ):
        """Update job progress with optional checkpoint data"""
        updates = {}
        
        if status:
            updates["status"] = status
        if progress_phase:
            updates["progress_phase"] = progress_phase
        if files_scanned is not None:
            updates["files_scanned"] = files_scanned
        if files_total is not None:
            updates["files_total"] = files_total
        if chunks_processed is not None:
            updates["chunks_processed"] = chunks_processed
        if error_message:
            updates["error_message"] = error_message
        if started_at:
            updates["started_at"] = started_at.isoformat()
        if completed_at:
            updates["completed_at"] = completed_at.isoformat()
        if checkpoint_data is not None:
            updates["checkpoint_data"] = checkpoint_data
        
        if not updates:
            return
        
        await self._gateway.update(
            table="reindex_jobs",
            record_id=str(job_id),
            data=updates,
            admin=True
        )
    
    async def get_job_status(self, job_id: UUID) -> Optional[Dict[str, Any]]:
        """Get current job status"""
        results = await self._gateway.select(
            table="reindex_jobs",
            filters={"id": str(job_id)},
            admin=True
        )
        
        return results[0] if results else None
    
    async def start_reindex(self, job_id: UUID, location_id: Optional[UUID] = None):
        """Start async reindex operation with checkpoint support (runs in background)"""
        job_id_str = str(job_id)
        
        try:
            # Atomic claim: UPDATE status='running' only if job is in a startable state.
            claimed_rows = await self._gateway.update(
                table="reindex_jobs",
                record_id=str(job_id),
                data={"status": "running"},
                in_filters={"status": ["queued", "paused", "stopped"]},
                admin=True
            )
            
            if not claimed_rows:
                logger.warning(f"Aborting reindex for job {job_id}: already claimed by another process")
                return
            
            job_data = claimed_rows[0] if isinstance(claimed_rows, list) else claimed_rows

            current = asyncio.current_task()
            if current is not None:
                _running_jobs[job_id_str] = current

            _job_controls[job_id_str] = {"paused": False, "should_stop": False}
            
            source_type = job_data.get('source_type', 'filesystem')
            
            if source_type == 'filesystem':
                if not location_id:
                    raise ValueError("location_id is required for filesystem source_type")
                location = await self.repository.get_location(location_id)
                if not location:
                    raise ValueError(f"Location not found: {location_id}")
                await self._run_filesystem_reindex(job_id, job_id_str, job_data, location)
            elif source_type in ('browser', 'email'):
                await self._run_daemon_historical_backfill(job_id, job_id_str, job_data, source_type)
            else:
                raise ValueError(f"Unknown source_type: {source_type}")
                
        except Exception as e:
            logger.error(f"❌ [Job {job_id}] Reindex routing failed: {e}", exc_info=True)
            await self.update_job_progress(job_id, status="failed", error_message=str(e), completed_at=datetime.utcnow())
        finally:
            if job_id_str in _running_jobs:
                del _running_jobs[job_id_str]
            if job_id_str in _job_controls:
                del _job_controls[job_id_str]

    async def _run_filesystem_reindex(self, job_id: UUID, job_id_str: str, job_data: Dict[str, Any], location: Dict[str, Any]):
        """Run the filesystem reindex loop."""
        location_id = location['id']
        try:
            # Resume from checkpoint if available (data returned by atomic claim
            # includes the full row, so no second SELECT is needed)
            checkpoint = job_data.get('checkpoint_data') or {}
            start_file_idx = checkpoint.get('last_file_index', 0)
            processed_paths = set(checkpoint.get('processed_file_paths', []))
            all_chunks = checkpoint.get('partial_chunks', [])
            
            # Set phase and start time (status already set to 'running' by atomic claim)
            await self.update_job_progress(
                job_id,
                progress_phase="scanning" if start_file_idx == 0 else "processing",
                started_at=datetime.utcnow() if start_file_idx == 0 else None
            )
            
            # Update location status
            await self.repository.update_location_status(location_id, "running")
            
            start_time = datetime.utcnow()
            
            # Import scanning/indexing components
            from application.indexing.aether_rag_service import AetherRagService
            from services.daemons.file_indexing.core import FileSystemScanner, DocumentProcessor
            
            # Phase 1: Scan filesystem (skip if resuming)
            if start_file_idx == 0:
                logger.info(f"[Job {job_id}] Starting filesystem scan for {location['location_name']}")
            else:
                logger.info(f"[Job {job_id}] Resuming from file {start_file_idx}/{len(processed_paths)}")
            
            scanner = FileSystemScanner(
                root_path=PathLib(location['root_path']),
                allowed_extensions=location['allowed_extensions'],
                exclude_patterns=location['exclude_patterns']
            )
            
            scanned_files = await asyncio.to_thread(scanner.scan)
            await self.update_job_progress(
                job_id,
                progress_phase="processing",
                files_total=len(scanned_files),
                files_scanned=start_file_idx
            )
            
            # Immediately update the location's file_count so the UI shows it even if indexing fails later
            await self.repository.update_location(
                location_id,
                {"file_count": len(scanned_files)}
            )
            
            logger.info(f"[Job {job_id}] Found {len(scanned_files)} files (starting at {start_file_idx})")
            
            # Phase 2: Process files and build index in batches
            processor = DocumentProcessor(
                chunk_size=location['chunk_size'],
                chunk_overlap=location['chunk_overlap']
            )
            
            # Use batching to keep memory low and ensure resume correctness.
            # We index chunks into the AETHER_RAG index after every batch of files.
            from services.daemons.file_indexing.config import IndexingServiceConfig
            fi_config = IndexingServiceConfig.from_env()
            aether_rag_manager = AetherRagService(
                embedding_model=fi_config.aether_rag_embedding_model,
                api_base=fi_config.aether_rag_embedding_api_base,
                api_key=fi_config.aether_rag_embedding_api_key,
            )
            
            batch_size = 25  # Index every 25 files to balance IO and responsiveness
            current_batch_chunks = []
            total_chunks_processed = checkpoint.get('total_chunks_processed', 0)
            
            for idx, file_meta in enumerate(scanned_files, 1):
                # Skip already processed files
                if idx <= start_file_idx or file_meta['file_path'] in processed_paths:
                    continue
                
                # Check control flags
                control = _job_controls.get(job_id_str, {})
                
                # Handle pause
                while control.get("paused", False):
                    logger.info(f"[Job {job_id}] Paused at file {idx}/{len(scanned_files)}")
                    await self.update_job_progress(
                        job_id,
                        status="paused",
                        checkpoint_data={
                            "last_file_index": idx - 1,
                            "processed_file_paths": list(processed_paths),
                            "total_chunks_processed": total_chunks_processed,
                            "partial_chunks": []  # Batching means no need to store partials
                        }
                    )
                    await asyncio.sleep(1)  # Wait while paused
                    control = _job_controls.get(job_id_str, {})
                
                # Handle stop/cancel
                if control.get("should_stop", False) or (str(job_id) in _running_jobs and _running_jobs[str(job_id)].cancelled()):
                    logger.info(f"[Job {job_id}] Stopped at file {idx}/{len(scanned_files)}")
                    # Flush current batch before stopping if requested
                    if current_batch_chunks:
                        is_first_batch = (total_chunks_processed == 0 and start_file_idx == 0)
                        
                        await aether_rag_manager.build_index(
                            index_directory=PathLib(location['index_directory']),
                            index_name=location['index_name'],
                            chunks=current_batch_chunks,
                            index_mode=location.get('index_mode', 'combined'),
                            incremental=not is_first_batch,
                            defer_sparse_build=True,
                            disable_sharding=True
                        )
                        
                        total_chunks_processed += len(current_batch_chunks)

                    await self.update_job_progress(
                        job_id,
                        status="stopped",
                        completed_at=datetime.utcnow(),
                        checkpoint_data={
                            "last_file_index": idx - 1,
                            "processed_file_paths": list(processed_paths),
                            "total_chunks_processed": total_chunks_processed,
                            "partial_chunks": []
                        }
                    )
                    await self.repository.update_location_status(location_id, "completed")
                    return
                
                # Process file
                try:
                    file_path = PathLib(file_meta['file_path'])
                    chunks = await asyncio.to_thread(processor.process_file, file_path, file_meta)
                    
                    if chunks:
                        current_batch_chunks.extend(chunks)
                        processed_paths.add(file_meta['file_path'])
                        
                        # Update file metadata in DB
                        await self.repository.upsert_indexed_file(
                            location_id,
                            file_meta,
                            chunk_count=len(chunks)
                        )
                except Exception as e:
                    logger.warning(f"[Job {job_id}] Failed to process {file_meta['file_path']}: {e}")

                # Check if batch is full or it's the last file
                if idx % batch_size == 0 or idx == len(scanned_files):
                    if current_batch_chunks:
                        # Incremental build: add current batch to index
                        is_first_batch = (total_chunks_processed == 0 and start_file_idx == 0)
                        
                        await aether_rag_manager.build_index(
                            index_directory=PathLib(location['index_directory']),
                            index_name=location['index_name'],
                            chunks=current_batch_chunks,
                            index_mode=location.get('index_mode', 'combined'),
                            incremental=not is_first_batch,
                            defer_sparse_build=True,
                            disable_sharding=True
                        )
                        
                        total_chunks_processed += len(current_batch_chunks)
                        current_batch_chunks = []
                    
                    # Update progress and save checkpoint
                    await self.update_job_progress(
                        job_id,
                        files_scanned=idx,
                        chunks_processed=total_chunks_processed,
                        checkpoint_data={
                            "last_file_index": idx,
                            "processed_file_paths": list(processed_paths),
                            "total_chunks_processed": total_chunks_processed,
                            "partial_chunks": []
                        }
                    )
            
            # Finalize sparse build if BM25 is enabled
            index_mode = location.get('index_mode', 'combined')
            if index_mode in ("bm25", "combined", "hybrid"):
                logger.info(f"[Job {job_id}] Forcing monolithic sparse index build...")
                await aether_rag_manager.force_sparse_build(
                    str(PathLib(location['index_directory']) / f"{location['index_name']}.aether_rag")
                )
            
            # Phase 3: Finalize - calculate stats
            await self.update_job_progress(
                job_id,
                progress_phase="finalizing"
            )
            
            index_size = await asyncio.to_thread(
                AetherRagService.calculate_index_size,
                PathLib(location['index_directory']), location['index_name'],
            )
            
            duration = int((datetime.utcnow() - start_time).total_seconds())
            
            # Update location stats
            await self.repository.update_location_stats(
                location_id,
                status="completed",
                file_count=len(scanned_files),
                chunk_count=total_chunks_processed,
                index_size_bytes=index_size,
                duration_seconds=duration
            )
            
            # Mark job as completed
            await self.update_job_progress(
                job_id,
                status="completed",
                progress_phase="completed",
                completed_at=datetime.utcnow()
            )
            
            logger.info(f"✅ [Job {job_id}] Reindex completed in {duration}s")
            
        except Exception as e:
            logger.error(f"❌ [Job {job_id}] Reindex failed: {e}", exc_info=True)
            
            # Mark job as failed
            await self.update_job_progress(
                job_id,
                status="failed",
                error_message=str(e),
                completed_at=datetime.utcnow()
            )
            
            # Update location status
            try:
                await self.repository.update_location_status(location_id, "failed", str(e))
            except Exception:
                pass
        
        finally:
            # Cleanup
            if job_id_str in _running_jobs:
                del _running_jobs[job_id_str]
            if job_id_str in _job_controls:
                del _job_controls[job_id_str]
    
    async def _run_daemon_historical_backfill(self, job_id: UUID, job_id_str: str, job_data: Dict[str, Any], source_type: str):
        """Run the backfill loop for browser or email."""
        try:
            await self.update_job_progress(job_id, progress_phase="scanning", started_at=datetime.utcnow())
            
            from application.indexing.aether_rag_service import AetherRagService
            from config.settings import get_settings
            settings = get_settings()
            
            aether_rag_manager = AetherRagService(
                embedding_model=settings.embedding_service.model,
                api_base=settings.embedding_service.openai_base_url
            )
            
            chunks = []
            index_dir = None
            index_name = None
            index_mode = "bm25"
            
            if source_type == 'browser':
                from application.sources.chromium_history import resolve_chromium_user_data_dir, find_profile_dirs, read_history_entries, extract_search_query
                browser_name = settings.integrations.aether_rag_sources.browser_history.browser
                user_data_dir = resolve_chromium_user_data_dir(browser_name)
                index_dir = settings.app_root / "data" / "aether_rag_sources" / "browser"
                index_name = settings.integrations.aether_rag_sources.browser_history.default_index_name
                index_mode = settings.integrations.aether_rag_sources.browser_history.index_mode
                max_items = settings.integrations.aether_rag_sources.browser_history.max_items
                
                if not user_data_dir:
                    raise RuntimeError(f"Could not resolve user data dir for {browser_name}")
                    
                profile_paths = []
                cfg = settings.integrations.aether_rag_sources.browser_history
                if not cfg.auto_find_profiles and cfg.profile_path:
                    # Resolve explicit profile path, which could be relative to user_data_dir
                    from pathlib import Path
                    p_path = Path(cfg.profile_path)
                    if p_path.is_absolute():
                        profile_paths = [p_path]
                    else:
                        profile_paths = [Path(user_data_dir) / p_path]
                else:
                    profile_paths = find_profile_dirs(user_data_dir)
                    
                for profile_path in profile_paths:
                    entries = read_history_entries(profile_dir=profile_path, max_items=max_items)
                    for entry in entries:
                        search_q = extract_search_query(entry['url']) or ''
                        text = f"{entry['url']} {entry.get('title', '')} {search_q}".strip()
                        chunks.append({
                            'text': text,
                            'metadata': {
                                'source': 'browser_history',
                                'url': entry['url'],
                                'title': entry.get('title', ''),
                                'timestamp': entry.get('last_visit_time', ''),
                                'profile': profile_path.name
                            }
                        })
            elif source_type == 'email':
                from application.sources.email_ingest import read_eml_items, read_mbox_items, format_email_item
                import sys
                index_dir = settings.app_root / "data" / "aether_rag_sources" / "email"
                index_name = settings.integrations.aether_rag_sources.email.default_index_name
                index_mode = settings.integrations.aether_rag_sources.email.index_mode
                max_items = settings.integrations.aether_rag_sources.email.max_items
                path = PathLib(settings.integrations.aether_rag_sources.email.source_path or "~/.aether_email").expanduser()
                
                if sys.platform == "darwin":
                    from application.sources.macos_mail import get_recent_emails_via_applescript, test_mail_access
                    if test_mail_access():
                        # Historical backfill should fetch a large window (e.g. 5 years)
                        emails = get_recent_emails_via_applescript(max_items=max_items, hours_back=24*30)
                        for email in emails:
                            text = f"Subject: {email.get('subject', '')}\nSender: {email.get('sender', '')}\n\n{email.get('content', '')}".strip()
                            chunks.append({
                                'text': text,
                                'metadata': {
                                    'source': 'email',
                                    'subject': email.get('subject', ''),
                                    'sender': email.get('sender', ''),
                                    'timestamp': email['_parsed_dt'].isoformat() if '_parsed_dt' in email else ''
                                }
                            })
                    else:
                        raise RuntimeError("Mail.app is not accessible")
                else:
                    if path.is_dir() or path.suffix.lower() == ".eml":
                        items = read_eml_items(path, max_items=max_items)
                    else:
                        items = read_mbox_items(path, max_items=max_items)
                    for item in items:
                        chunks.append({
                            "text": format_email_item(item),
                            "metadata": {"source": "email", "source_path": str(path)}
                        })
            
            await self.update_job_progress(job_id, progress_phase="processing", files_total=len(chunks), files_scanned=len(chunks))
            
            if chunks:
                await aether_rag_manager.build_index(
                    index_directory=index_dir,
                    index_name=index_name,
                    chunks=chunks,
                    index_mode=index_mode,
                    incremental=False,
                    defer_sparse_build=True,
                    disable_sharding=True
                )
                
                if index_mode in ("bm25", "combined", "hybrid"):
                    await aether_rag_manager.force_sparse_build(
                        str(index_dir / f"{index_name}.aether_rag")
                    )
                    
            # Register index in the database so it's discoverable
            try:
                from data.database.repositories.search_indexes import SearchIndexesRepository
                search_repo = SearchIndexesRepository(self._gateway)
                
                registry_metadata = {
                    "source": source_type,
                    "semantic_enabled": index_mode in ("semantic", "combined", "hybrid"),
                    "bm25_enabled": index_mode in ("bm25", "combined", "hybrid"),
                    "bm25_chunk_count": len(chunks) if index_mode in ("bm25", "combined", "hybrid") else 0
                }
                
                await search_repo.register_index(
                    index_name=index_name,
                    source_type=source_type + "_history" if source_type == "browser" else source_type,
                    index_directory=str(index_dir),
                    chunk_count=len(chunks),
                    display_name=f"{source_type.title()} Archive",
                    description=f"Auto-generated {source_type} index",
                    metadata=registry_metadata
                )
                logger.info(f"Registered {source_type} index '{index_name}' in search_indexes table")
            except Exception as e:
                logger.error(f"Failed to register index {index_name} in db: {e}", exc_info=True)
            
            await self.update_job_progress(
                job_id,
                status="completed",
                progress_phase="completed",
                completed_at=datetime.utcnow()
            )
            
            logger.info(f"✅ [Job {job_id}] Backfill completed for {source_type}")
            
        except Exception as e:
            logger.error(f"❌ [Job {job_id}] Backfill failed: {e}", exc_info=True)
            await self.update_job_progress(
                job_id,
                status="failed",
                error_message=str(e),
                completed_at=datetime.utcnow()
            )
        finally:
            if job_id_str in _running_jobs:
                del _running_jobs[job_id_str]
            if job_id_str in _job_controls:
                del _job_controls[job_id_str]

    async def get_pending_jobs(self) -> list:
        """Get all queued reindex jobs for daemon to pick up."""
        try:
            results = await self._gateway.select(
                table="reindex_jobs",
                filters={"status": "queued"},
                admin=True
            )
            return results if results else []
        except Exception as e:
            logger.error(f"Failed to get pending jobs: {e}", exc_info=True)
            return []
    
    async def trigger_reindex_async(self, location_name: str, source_type: str = "filesystem", location_id: Optional[UUID] = None) -> Dict[str, Any]:
        """Create reindex job - daemon will pick it up and process it"""
        # Create job record in 'queued' status
        job = await self.create_job(location_name=location_name, source_type=source_type, location_id=location_id)
        job_id = job['id']
        
        logger.info(f"🚀 Reindex job {job_id} queued for daemon: {location_name}")
        
        return {
            "job_id": str(job_id),
            "location_id": str(location_id) if location_id else None,
            "source_type": source_type,
            "location_name": location_name,
            "status": "queued",
            "message": "Reindex job queued - daemon will process shortly"
        }
    
    async def pause_job(self, job_id: UUID):
        """Pause a running job (saves checkpoint)"""
        job_id_str = str(job_id)
        
        if job_id_str in _job_controls:
            _job_controls[job_id_str]["paused"] = True
            logger.info(f"Pausing reindex job {job_id}")
    
    async def resume_job(self, job_id: UUID):
        """Resume a paused job - delegate to daemon"""
        job_id_str = str(job_id)
        
        if job_id_str in _job_controls:
            # Job is running in daemon - just unpause it
            _job_controls[job_id_str]["paused"] = False
            await self.update_job_progress(job_id, status="running")
            logger.info(f"Resuming reindex job {job_id} in daemon")
        else:
            # Job not in daemon memory - set to queued for daemon to pick up
            job_status = await self.get_job_status(job_id)
            if job_status and job_status.get('status') == 'paused':
                # Set to queued - daemon will pick it up and resume from checkpoint
                await self.update_job_progress(job_id, status="queued")
                logger.info(f"Job {job_id} queued for daemon to resume from checkpoint")
    
    async def stop_job(self, job_id: UUID):
        """Stop a running job (saves checkpoint, can be resumed later)"""
        job_id_str = str(job_id)
        
        if job_id_str in _job_controls:
            _job_controls[job_id_str]["should_stop"] = True
            logger.info(f"Stopping reindex job {job_id}")
        
        await self.update_job_progress(
            job_id,
            status="stopped",
            completed_at=datetime.utcnow()
        )
    
    async def cancel_job(self, job_id: UUID):
        """Cancel a running job (discards progress, cannot be resumed)"""
        job_id_str = str(job_id)
        
        if job_id_str in _running_jobs:
            task = _running_jobs[job_id_str]
            task.cancel()
            logger.info(f"Cancelled reindex job {job_id}")
        
        if job_id_str in _job_controls:
            _job_controls[job_id_str]["should_stop"] = True
        
        await self.update_job_progress(
            job_id,
            status="cancelled",
            completed_at=datetime.utcnow(),
            checkpoint_data={}  # Clear checkpoint on cancel
        )


# =============================================================================
# In-Process Background Poller
# =============================================================================
# Fallback for when the launchd/systemd daemon is not running.
# Runs inside the FastAPI process and picks up queued reindex jobs.

# Track poller-owned reindex tasks for deterministic cleanup
_task_tracker = TaskTracker()
_poller_reindex_tasks: Dict[str, asyncio.Task] = {}


async def _run_reindex_poller(repository, poll_interval: int = 15) -> None:
    """
    Background loop that polls for queued reindex jobs and executes them.

    Runs inside the FastAPI process so indexing works even without the
    external launchd/systemd daemon. Deduplicates with the external daemon
    via the atomic UPDATE claim in start_reindex() (only one caller can
    transition a job from queued/paused/stopped to running).

    @param repository: FileIndexingRepository instance
    @param poll_interval: Seconds between poll cycles (default 15)
    """
    logger.info("[ReindexPoller] Starting in-process reindex job poller (interval=%ds)", poll_interval)

    while True:
        try:
            job_manager = ReindexJobManager(repository)
            pending_jobs = await job_manager.get_pending_jobs()

            for job in pending_jobs:
                job_id = str(job['id'])
                location_id = job['location_id']

                # Skip if already being processed by this poller
                existing = _poller_reindex_tasks.get(job_id)
                if existing and not existing.done():
                    continue

                logger.info("[ReindexPoller] Picked up reindex job %s for location %s", job_id, location_id)

                task = _task_tracker.track_task(asyncio.create_task(job_manager.start_reindex(job['id'], location_id)))
                _poller_reindex_tasks[job_id] = task
                task.add_done_callback(lambda _t, jid=job_id: _poller_reindex_tasks.pop(jid, None))

        except asyncio.CancelledError:
            logger.info("[ReindexPoller] Poller cancelled, stopping")
            # Cancel in-flight reindex tasks owned by poller
            await _task_tracker.cancel_all()
            _poller_reindex_tasks.clear()
            return
        except Exception as e:
            logger.error("[ReindexPoller] Poll cycle failed: %s", e, exc_info=True)
            await asyncio.sleep(poll_interval)

        try:
            await asyncio.sleep(poll_interval)
        except asyncio.CancelledError:
            logger.info("[ReindexPoller] Poller cancelled during sleep, stopping")
            # Cancel in-flight reindex tasks owned by poller
            await _task_tracker.cancel_all()
            _poller_reindex_tasks.clear()
            return


def start_background_poller(repository, poll_interval: int = 15) -> asyncio.Task:
    """
    Launch the in-process reindex job poller as a background asyncio task.

    Call from app.py lifespan startup after the FileIndexingRepository is initialized.
    The returned task should be tracked for cancellation during app shutdown.

    @param repository: FileIndexingRepository instance
    @param poll_interval: Seconds between poll cycles
    @returns: asyncio.Task that runs until cancelled
    """
    return _task_tracker.track_task(asyncio.create_task(_run_reindex_poller(repository, poll_interval)))
