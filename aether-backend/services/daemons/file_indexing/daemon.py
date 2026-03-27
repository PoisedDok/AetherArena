"""
@.architecture
Incoming: CLI invocation, systemd/launchd --- {python -m services.daemons.file_indexing.daemon}
Processing: orchestrate file indexing service lifecycle --- {7 jobs: JOB_BUILD_INDEX, JOB_CLEANUP_RESOURCE, JOB_INITIALIZE_COMPONENT, JOB_MANAGE_CONNECTION, JOB_ORCHESTRATE, JOB_SCAN, JOB_SCHEDULE}
Outgoing: Supabase (metadata), Filesystem (.aether_rag indexes) --- {health updates, index files}
"""

import asyncio
import logging
import os
import signal
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from services.daemons.file_indexing.config import IndexingServiceConfig
from services.daemons.file_indexing.db import create_supabase_client
from services.daemons.file_indexing.core import FileSystemScanner, DocumentProcessor, IndexingScheduler
from application.indexing.aether_rag_service import AetherRagService
from data.database.repositories.files import FileIndexingRepository
from data.database.persistence_gateway import SupabasePersistenceGateway
from services.daemons import FILE_INDEX_SIGNAL_FILE

logger = logging.getLogger(__name__)

DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024  # 10MB
DEFAULT_LOG_BACKUP_COUNT = 3


def _writable_root() -> Path:
    """Resolve canonical writable backend root for daemon log files."""
    backend_root = os.environ.get("AETHER_BACKEND_ROOT")
    if backend_root:
        return Path(backend_root)
    return Path(__file__).parent.parent.parent.parent


def _parse_positive_int(value: object, default: int, minimum: int = 1) -> int:
    """Parse positive integer values with fallback defaults."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, parsed)


def _resolve_log_file(config_log_file: Optional[Path]) -> Path:
    """Resolve configured file-indexing daemon log path with canonical fallback."""
    if config_log_file:
        return config_log_file if config_log_file.is_absolute() else (_writable_root() / config_log_file)
    return _writable_root() / "logs" / "file_indexing.log"


def _configure_file_indexing_logging(config: IndexingServiceConfig) -> Path:
    """Configure bounded rotating logging for standalone file-indexing daemon mode."""
    log_file = _resolve_log_file(config.log_file)
    log_file.parent.mkdir(parents=True, exist_ok=True)

    max_bytes = _parse_positive_int(
        os.getenv("FI_LOG_MAX_BYTES", os.getenv("DAEMON_LOG_MAX_BYTES")),
        DEFAULT_LOG_MAX_BYTES,
        minimum=1024,
    )
    backup_count = _parse_positive_int(
        os.getenv("FI_LOG_BACKUP_COUNT", os.getenv("DAEMON_LOG_BACKUP_COUNT")),
        DEFAULT_LOG_BACKUP_COUNT,
    )
    level_value = getattr(logging, str(config.log_level).upper(), logging.INFO)

    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    root_logger = logging.getLogger()
    root_logger.setLevel(level_value)
    root_logger.handlers = []

    rotating_handler = RotatingFileHandler(
        log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    rotating_handler.setFormatter(formatter)

    if log_file.exists():
        try:
            if log_file.stat().st_size >= max_bytes:
                rotating_handler.doRollover()
        except OSError:
            pass

    root_logger.addHandler(rotating_handler)

    if os.getenv("FI_LOG_TO_STDOUT", "").strip().lower() in {"1", "true", "yes", "on"}:
        stream_handler = logging.StreamHandler(sys.stdout)
        stream_handler.setFormatter(formatter)
        root_logger.addHandler(stream_handler)

    return log_file


class FileIndexingDaemon:
    """Main daemon for file indexing service."""
    
    def __init__(self, config: IndexingServiceConfig):
        """Initialize daemon."""
        self.config = config
        self.running = False
        self._is_disposed = False
        self.repository: Optional[FileIndexingRepository] = None
        self.aether_rag_manager: Optional[AetherRagService] = None
        self.scheduler: Optional[IndexingScheduler] = None
        self.process_id = os.getpid()
        # Track background reindex jobs started by this daemon for deterministic shutdown.
        self._reindex_tasks: dict[str, asyncio.Task] = {}
        self._last_signal_scan_ts: float = 0.0
        self._signal_scan_lock = asyncio.Lock()
        self.incremental_sync_manager: Optional['IncrementalSyncManager'] = None
    
    async def start(self):
        """Start daemon."""
        logger.info(f"Starting File Indexing Daemon (PID: {self.process_id})")
        
        try:
            # Validate configuration
            self.config.validate()
            
            # Initialize Supabase client
            logger.info("Connecting to Supabase...")
            supabase_client = create_supabase_client(self.config)
            await supabase_client.initialize()
            gateway = SupabasePersistenceGateway(supabase_client)
            
            # Initialize repository
            self.repository = FileIndexingRepository(gateway)
            logger.info("✅ Repository initialized")
            
            # Register service
            await self.repository.register_service(self.process_id)
            logger.info("✅ Service registered")
            
            # Cleanup stale statuses from previous crashes/restarts
            await self._cleanup_stale_statuses()
            
            # Initialize AETHER_RAG manager (embeddings via central config [EMBEDDINGS])
            self.aether_rag_manager = AetherRagService(
                embedding_model=self.config.aether_rag_embedding_model,
                api_base=self.config.aether_rag_embedding_api_base,
                api_key=self.config.aether_rag_embedding_api_key,
            )
            logger.info("✅ AETHER_RAG manager initialized")
            
            from services.daemons.file_indexing.incremental_sync import IncrementalSyncManager
            self.incremental_sync_manager = IncrementalSyncManager(self.aether_rag_manager)
            logger.info("✅ Incremental Sync Manager initialized")
            
            # Initialize scheduler
            self.scheduler = IndexingScheduler()
            self.scheduler.start()
            logger.info("✅ Scheduler started")
            
            # Load and schedule all enabled locations
            await self._load_and_schedule_locations()
            
            # Set running flag
            self.running = True
            
            # Start heartbeat loop
            await self._run_heartbeat_loop()
            
        except Exception as e:
            logger.error(f"Failed to start daemon: {e}", exc_info=True)
            await self._update_status("error", str(e))
            raise
    
    async def stop(self):
        """Stop daemon -- cancel reindex jobs, shutdown scheduler, dispose gateway."""
        if self._is_disposed:
            return
        self._is_disposed = True
        
        logger.info("Stopping File Indexing Daemon...")
        self.running = False

        # Cancel any in-flight daemon-owned reindex jobs (FAIL_FAST: stop means stop).
        if self._reindex_tasks:
            tasks = list(self._reindex_tasks.values())
            self._reindex_tasks.clear()
            for task in tasks:
                try:
                    task.cancel()
                except Exception:
                    pass
            try:
                await asyncio.gather(*tasks, return_exceptions=True)
            except Exception:
                pass
        
        if self.scheduler:
            self.scheduler.shutdown()
        
        if self.repository:
            try:
                await self._update_status("stopped")
                # Dispose of the repository's gateway to close database connections
                if hasattr(self.repository, '_gateway') and self.repository._gateway:
                    await self.repository._gateway.dispose()
                    logger.info("✅ Database connection disposed")
            except Exception as e:
                logger.warning(f"Error during repository cleanup: {e}")
        
        logger.info("✅ Daemon stopped")
    
    async def _load_and_schedule_locations(self):
        """Load enabled locations and schedule scans (primary first, then secondary)."""
        try:
            locations = await self.repository.get_all_locations(enabled_only=True)
            
            # Sort by location_type: primary first, then secondary
            locations.sort(key=lambda loc: 0 if loc.get('location_type') == 'primary' else 1)
            
            logger.info(f"Found {len(locations)} enabled locations ({sum(1 for l in locations if l.get('location_type') == 'primary')} primary, {sum(1 for l in locations if l.get('location_type') == 'secondary')} secondary)")
            
            for location in locations:
                location_id = location['id']
                scan_interval = location['scan_interval_minutes'] * 60  # Convert to seconds
                location_type = location.get('location_type', 'secondary')

                async def _scheduled_scan(loc=location):
                    await self._scan_location(loc)

                # Schedule scan
                self.scheduler.schedule_scan(
                    location_id=location_id,
                    scan_func=_scheduled_scan,
                    interval_seconds=scan_interval
                )
                
                logger.debug(f"Scheduled {location_type} location: {location['location_name']}")
            
            logger.info(f"✅ Scheduled {len(locations)} locations")
            
        except Exception as e:
            logger.error(f"Failed to load locations: {e}", exc_info=True)
    
    async def _scan_location(self, location: dict):
        """
        Scan and index a location.
        
        Args:
            location: Location configuration dict
        """
        location_id = location['id']
        location_name = location['location_name']
        
        logger.info(f"Scanning location: {location_name}")
        
        try:
            # Update status to running
            await self.repository.update_location_status(location_id, "running")
            
            start_time = datetime.now(timezone.utc)
            
            # Initialize scanner
            scanner = FileSystemScanner(
                root_path=Path(location['root_path']),
                allowed_extensions=location['allowed_extensions'],
                exclude_patterns=location['exclude_patterns']
            )
            
            # Scan filesystem
            scanned_files = scanner.scan()
            
            # Filter for changed files
            changed_files = await self.repository.filter_changed_files(
                location_id,
                scanned_files
            )
            
            if not changed_files:
                logger.info(f"No changes detected for {location_name}")
                duration = int((datetime.now(timezone.utc) - start_time).total_seconds())
                await self.repository.update_location_stats(
                    location_id,
                    status="completed",
                    file_count=len(scanned_files),
                    chunk_count=None,  # Don't overwrite with potentially stale memory data
                    index_size_bytes=None,
                    duration_seconds=duration
                )
                return
            
            logger.info(f"Processing {len(changed_files)} changed files")
            
            # Process documents
            processor = DocumentProcessor(
                chunk_size=location['chunk_size'],
                chunk_overlap=location['chunk_overlap']
            )
            
            all_chunks = []
            for file_meta in changed_files:
                file_path = Path(file_meta['file_path'])
                chunks = processor.process_file(file_path, file_meta)
                
                if chunks:
                    all_chunks.extend(chunks)
                    
                    # Update file metadata in DB
                    await self.repository.upsert_indexed_file(
                        location_id,
                        file_meta,
                        chunk_count=len(chunks)
                    )
            
            # Build AETHER_RAG index
            if all_chunks:
                chunk_count = await self.aether_rag_manager.build_index(
                    index_directory=Path(location['index_directory']),
                    index_name=location['index_name'],
                    chunks=all_chunks,
                    index_mode="combined" if self.config.aether_rag_enable_bm25 else "semantic",
                    disable_sharding=True
                )
                
                logger.info(f"Indexed {chunk_count} chunks for {location_name}")
            
            # Calculate index size
            index_size = AetherRagService.calculate_index_size(
                Path(location['index_directory']), location['index_name'],
            )
            
            # Update location stats
            duration = int((datetime.now(timezone.utc) - start_time).total_seconds())
            
            # Use current count from location, add new chunks if any
            new_chunk_count = (location.get('chunk_count') or 0) + len(all_chunks)
            
            await self.repository.update_location_stats(
                location_id,
                status="completed",
                file_count=len(scanned_files),
                chunk_count=new_chunk_count,
                index_size_bytes=index_size,
                duration_seconds=duration
            )
            
            logger.info(f"✅ Completed scan of {location_name} in {duration}s")
            
        except Exception as e:
            logger.error(f"Failed to scan {location_name}: {e}", exc_info=True)
            await self.repository.update_location_status(location_id, "failed", str(e))
    
    async def _run_heartbeat_loop(self):
        """Run heartbeat loop."""
        logger.info("Starting heartbeat loop")
        
        while self.running:
            try:
                await self.repository.update_heartbeat()
                
                # Check for pending reindex jobs to process
                await self._check_and_process_reindex_jobs()
                
                # Process incremental syncs
                if self.incremental_sync_manager:
                    await self.incremental_sync_manager.process_syncs()
                
                # Check if filesystem daemon signaled a primary folder change
                await self._check_file_index_signal()
                
                await asyncio.sleep(self.config.heartbeat_interval_seconds)
            except Exception as e:
                logger.error(f"Heartbeat failed: {e}", exc_info=True)
                await asyncio.sleep(self.config.heartbeat_interval_seconds)
    
    async def _check_and_process_reindex_jobs(self):
        """Check for queued reindex jobs and process them in this daemon."""
        try:
            from services.daemons.file_indexing.async_reindex import ReindexJobManager
            
            job_manager = ReindexJobManager(self.repository)
            pending_jobs = await job_manager.get_pending_jobs()
            
            for job in pending_jobs:
                job_id = job['id']
                location_id = job['location_id']
                
                logger.info(f"🎯 Daemon picked up reindex job {job_id} for location {location_id}")

                job_id_str = str(job_id)
                existing = self._reindex_tasks.get(job_id_str)
                if existing and not existing.done():
                    continue

                # Execute reindex in daemon process (not API) and track for cancellation.
                task = asyncio.create_task(job_manager.start_reindex(job_id, location_id))
                self._reindex_tasks[job_id_str] = task
                task.add_done_callback(lambda _t, jid=job_id_str: self._reindex_tasks.pop(jid, None))
                
        except Exception as e:
            logger.error(f"Failed to check reindex jobs: {e}", exc_info=True)
    
    async def _check_file_index_signal(self):
        """Check for signal file from filesystem daemon and trigger primary scan."""
        import time
        try:
            if not FILE_INDEX_SIGNAL_FILE.exists():
                return
            
            now = time.monotonic()
            if now - self._last_signal_scan_ts < 30.0:
                return
            
            FILE_INDEX_SIGNAL_FILE.unlink(missing_ok=True)
            
            if self._signal_scan_lock.locked():
                logger.debug("Signal scan already in progress, skipping")
                return
            
            async with self._signal_scan_lock:
                self._last_signal_scan_ts = now
                logger.info("File index signal detected — scanning primary locations")
                await self._scan_primary_locations()
                
        except Exception as e:
            logger.error(f"Failed to process file index signal: {e}", exc_info=True)
    
    async def _scan_primary_locations(self):
        """Scan only primary-type locations (triggered by filesystem daemon signal)."""
        try:
            locations = await self.repository.get_all_locations(enabled_only=True)
            primary_locations = [
                loc for loc in locations
                if loc.get('location_type') == 'primary'
            ]
            
            if not primary_locations:
                logger.debug("No primary locations to scan on signal")
                return
            
            for location in primary_locations:
                logger.info(f"Signal-triggered scan for primary location: {location['location_name']}")
                await self._scan_location(location)
                
        except Exception as e:
            logger.error(f"Failed to scan primary locations on signal: {e}", exc_info=True)

    async def _update_status(self, status: str, error: Optional[str] = None):
        """Update service status."""
        if self.repository:
            try:
                await self.repository.update_service_status(status, error)
            except Exception as e:
                logger.error(f"Failed to update status: {e}")
    
    async def _cleanup_stale_statuses(self):
        """Reset stale 'running' statuses to 'pending' on daemon startup."""
        try:
            # Get all locations with 'running' status
            locations = await self.repository.get_all_locations()
            running_locations = [loc for loc in locations if loc.get('last_scan_status') == 'running']
            
            if running_locations:
                logger.info(f"Found {len(running_locations)} locations with stale 'running' status")
                
                for loc in running_locations:
                    # Check if truly stale (last_scan_at > 15 minutes ago)
                    last_scan = loc.get('last_scan_at')
                    if last_scan:
                        from datetime import datetime, timezone
                        last_scan_time = datetime.fromisoformat(last_scan.replace('Z', '+00:00'))
                        age = (datetime.now(timezone.utc) - last_scan_time).total_seconds() / 60
                        
                        if age > 15:  # Older than 15 minutes
                            logger.warning(f"Resetting stale 'running' status for {loc['location_name']} (age: {age:.1f}min)")
                            await self.repository.update_location_status(loc['id'], "failed", f"Scan timeout - exceeded 15 minutes (was {age:.0f}min old)")
                        else:
                            # Recent 'running' status - might be from previous daemon instance still finishing
                            logger.info(f"Keeping recent 'running' status for {loc['location_name']} (age: {age:.1f}min)")
                    else:
                        # No last_scan_at but status is running - reset to pending
                        logger.warning(f"Resetting 'running' status (no timestamp) for {loc['location_name']}")
                        await self.repository.update_location_status(loc['id'], "pending")
                
                logger.info("✅ Stale status cleanup complete")
        except Exception as e:
            logger.error(f"Failed to cleanup stale statuses: {e}", exc_info=True)


# =============================================================================
# Main Entry Point
# =============================================================================

async def main():
    """Main entry point."""
    # Load configuration
    config = IndexingServiceConfig.from_env()

    log_file = _configure_file_indexing_logging(config)
    logger.info("File indexing daemon logging configured at %s", log_file)
    
    # Initialize daemon
    daemon = FileIndexingDaemon(config)
    
    # Get the running event loop
    loop = asyncio.get_running_loop()
    
    # Handle signals using loop-native handlers for cleaner async shutdown
    def signal_handler():
        logger.info("Received shutdown signal, stopping daemon...")
        # Create task to stop daemon gracefully
        loop.create_task(daemon.stop())

    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, signal_handler)
    except NotImplementedError:
        # Fallback for Windows which doesn't support add_signal_handler
        def win_signal_handler(sig, frame):
            logger.info(f"Received signal {sig}, stopping...")
            asyncio.create_task(daemon.stop())
        signal.signal(signal.SIGINT, win_signal_handler)
        signal.signal(signal.SIGTERM, win_signal_handler)
    
    # Start daemon
    try:
        await daemon.start()
    except asyncio.CancelledError:
        logger.info("Daemon execution cancelled")
    except Exception as e:
        logger.error(f"Daemon failed: {e}", exc_info=True)
    finally:
        await daemon.stop()


if __name__ == "__main__":
    asyncio.run(main())

