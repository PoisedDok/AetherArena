"""Filesystem event logging daemon."""
import asyncio
import logging
import signal
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Optional
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent

from services.daemons.filesystem.config import FileSystemDaemonConfig
from services.daemons.filesystem.db import FileSystemDB
from services.daemons import QUERY_GEN_SIGNAL_FILE, FILE_INDEX_SIGNAL_FILE
from utils.document_processing import DocumentUtility

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("FileSystemDaemon")


class FileSystemEventLogger(FileSystemEventHandler):
    """Handler for filesystem events."""
    
    # Maximum debounce cache entries before forced pruning
    _DEBOUNCE_CACHE_MAX = 10000
    # Entries older than this (seconds) are pruned
    _DEBOUNCE_CACHE_TTL = 300  # 5 minutes
    
    def __init__(self, db: FileSystemDB, config: FileSystemDaemonConfig, location_name: str, daemon):
        self.db = db
        self.config = config
        self.location_name = location_name
        self.daemon = daemon  # Reference to parent daemon for threshold checking
        self._debounce_cache: Dict[str, float] = {}
        self._last_cache_prune = 0.0  # Timestamp of last prune
        # PRO-FIX: Record start time to ignore events triggered before daemon was ready
        self.handler_ready_time = datetime.now(timezone.utc)
        self.doc_util = DocumentUtility()
    
    def _prune_debounce_cache(self, now_ts: float):
        """Remove expired entries from debounce cache to prevent unbounded growth.
        
        Called periodically (every 60s) and when cache exceeds max size.
        """
        cutoff = now_ts - self._DEBOUNCE_CACHE_TTL
        expired_keys = [k for k, v in self._debounce_cache.items() if v < cutoff]
        for key in expired_keys:
            del self._debounce_cache[key]
        
        if expired_keys:
            logger.debug(f"Pruned {len(expired_keys)} expired debounce entries for {self.location_name}")
        
        self._last_cache_prune = now_ts
    
    def _should_log_event(self, file_path: str) -> bool:
        """Check if event should be logged (debounce + start-time logic)."""
        now_dt = datetime.now(timezone.utc)
        
        # 0. System-level ignore list (prevent monitoring infinite logs/caches/DBs)
        path_parts = Path(file_path).parts
        ignore_dirs = {
            '.git', 'node_modules', '.venv', 'venv', '__pycache__', 
            '.pytest_cache', 'logs', 'dist', 'build', '.next', '.nuxt', 
            '.aether_rag_index', 'coverage', '.tox', '.cursor'
        }
        if any(part in ignore_dirs for part in path_parts):
            return False
            
        # 0.5. File-level ignore list (prevent infinite loops with our own signal/log files)
        file_name = Path(file_path).name
        if file_name.endswith('.log') or file_name.endswith('.trigger') or file_name.endswith('.pid') or file_name.endswith('.db') or file_name.endswith('.db-wal') or file_name.endswith('.db-shm') or file_name.endswith('.db-journal') or file_name == '.DS_Store' or '.aether_rag' in file_name or '.faiss' in file_name or '.bf' in file_name:
            return False
        
        # 1. Start-time check: Ignore anything from before handler was ready
        if now_dt < self.handler_ready_time:
            return False

        # 2. Debounce logic
        now_ts = now_dt.timestamp()
        last_time = self._debounce_cache.get(file_path, 0)
        
        if now_ts - last_time < self.config.debounce_seconds:
            return False
        
        self._debounce_cache[file_path] = now_ts
        
        # 3. Periodic cache pruning (every 60s or when over max size)
        if (now_ts - self._last_cache_prune > 60.0 or
                len(self._debounce_cache) > self._DEBOUNCE_CACHE_MAX):
            self._prune_debounce_cache(now_ts)
        
        return True
    
    def _extract_content_preview(self, file_path: str) -> Optional[str]:
        """Extract intelligent context from files for query generation."""
        try:
            return self.doc_util.extract_context(Path(file_path))
        except Exception as e:
            logger.error(f"Context extraction failed for {file_path}: {e}")
            return None
    
    def on_created(self, event: FileSystemEvent):
        if not self.config.track_created or event.is_directory:
            return
        
        if self._should_log_event(event.src_path):
            content_preview = self._extract_content_preview(event.src_path)
            self.db.insert_log(
                action="created",
                file_path=event.src_path,
                location_name=self.location_name,
                content_preview=content_preview
            )
            # Check threshold after insert
            self.daemon._check_threshold_and_signal()
    
    def on_modified(self, event: FileSystemEvent):
        if not self.config.track_modified or event.is_directory:
            return
        
        if self._should_log_event(event.src_path):
            content_preview = self._extract_content_preview(event.src_path)
            self.db.insert_log(
                action="modified",
                file_path=event.src_path,
                location_name=self.location_name,
                content_preview=content_preview
            )
            # Check threshold after insert
            self.daemon._check_threshold_and_signal()
    
    def on_deleted(self, event: FileSystemEvent):
        if not self.config.track_deleted or event.is_directory:
            return
        
        self.db.insert_log(
            action="deleted",
            file_path=event.src_path,
            location_name=self.location_name
        )
        # Check threshold after insert
        self.daemon._check_threshold_and_signal()
    
    def on_moved(self, event: FileSystemEvent):
        if not self.config.track_moved or event.is_directory:
            return
        
        self.db.insert_log(
            action="moved",
            file_path=f"{event.src_path} -> {event.dest_path}",
            location_name=self.location_name
        )
        # Check threshold after insert
        self.daemon._check_threshold_and_signal()


class FileSystemDaemon:
    """Main daemon for filesystem event logging."""
    
    def __init__(self, config: FileSystemDaemonConfig):
        self.config = config
        self.running = False
        self._is_disposed = False
        self.db = FileSystemDB(config.db_path)
        
        self.observer = Observer()
        self.last_cleanup_time = datetime.now(timezone.utc)
        
        # Track if we've signaled (prevents signal storm)
        self._has_signaled = False
        self._has_signaled_file_index = False
        self._last_file_index_signal_ts = 0.0
    
    async def start(self):
        """Start the daemon loop."""
        logger.info(f"🚀 Starting FileSystem Daemon (watching {len(self.config.watch_locations)} locations)")
        self.running = True
        
        # Start watchdog observers
        for location in self.config.watch_locations:
            try:
                location_path = Path(location).expanduser()
                if not location_path.exists():
                    logger.warning(f"Watch location does not exist: {location}")
                    continue
                
                event_handler = FileSystemEventLogger(
                    self.db,
                    self.config,
                    location_name=location_path.name,
                    daemon=self  # Pass daemon reference
                )
                self.observer.schedule(event_handler, str(location_path), recursive=True)
                logger.info(f"👀 Watching: {location_path}")
            except Exception as e:
                logger.error(f"Failed to watch {location}: {e}")
        
        self.observer.start()
        
        while self.running:
            try:
                now = datetime.now(timezone.utc)
                
                # 1. Check threshold and signal if needed (handles missed rapid changes)
                self._check_threshold_and_signal()
                self._signal_file_index_daemon()
                
                # 2. Cleanup old logs daily
                if (now - self.last_cleanup_time).total_seconds() >= 86400:  # 24 hours
                    await self._cleanup_old_logs()
                    self.last_cleanup_time = now
                
                await asyncio.sleep(5)  # Check every 5 seconds
                
            except Exception as e:
                logger.error(f"Error in main loop: {e}", exc_info=True)
                await asyncio.sleep(5)
    
    async def stop(self):
        """Graceful shutdown -- stop observer with timeout."""
        if self._is_disposed:
            return
        self._is_disposed = True
        
        logger.info("Stopping FileSystem Daemon...")
        self.running = False
        self.observer.stop()
        # Timeout on join to prevent indefinite hang during shutdown.
        # Guard: observer.join() raises RuntimeError if thread was never started.
        try:
            self.observer.join(timeout=10.0)
            if self.observer.is_alive():
                logger.warning("Observer thread did not stop within 10s timeout")
        except RuntimeError:
            pass  # Observer was never started (e.g., stop() called before start())
    
    def _check_threshold_and_signal(self):
        """
        Signal query gen ONLY when crossing threshold (prevents signal storm).
        Signals once when unprocessed goes from <1 to >=1.
        Resets flag when count drops back below threshold.
        """
        try:
            unprocessed_count = self.db.get_unprocessed_count()
            threshold = 1  # Filesystem threshold (every file change matters)
            
            if unprocessed_count >= threshold and not self._has_signaled:
                # CROSSING threshold - signal once
                QUERY_GEN_SIGNAL_FILE.touch()
                self._has_signaled = True
                logger.info(f"🔔 Threshold CROSSED: {unprocessed_count} unprocessed logs (>= {threshold}) → Signaled query gen")
            elif unprocessed_count < threshold and self._has_signaled:
                # Dropped below threshold - reset flag for next batch
                self._has_signaled = False
                logger.debug(f"Reset signal flag: {unprocessed_count} < {threshold}")
        except Exception as e:
            logger.error(f"Failed to check threshold: {e}", exc_info=True)
    
    def _signal_file_index_daemon(self):
        """Signal the file indexing daemon that primary folder contents changed.
        
        Rate-limited: at most one signal per 30 seconds.  Uses a separate flag
        from the query gen signal to keep the two signal paths independent.
        """
        import time
        try:
            now = time.monotonic()
            if now - self._last_file_index_signal_ts < 30.0:
                return
            
            unprocessed_count = self.db.get_unprocessed_count()
            if unprocessed_count >= 1 and not self._has_signaled_file_index:
                FILE_INDEX_SIGNAL_FILE.touch()
                self._has_signaled_file_index = True
                self._last_file_index_signal_ts = now
                logger.info(f"Signaled file indexing daemon (primary folder changed, {unprocessed_count} events)")
            elif unprocessed_count < 1 and self._has_signaled_file_index:
                self._has_signaled_file_index = False
        except Exception as e:
            logger.error(f"Failed to signal file index daemon: {e}", exc_info=True)

    async def _cleanup_old_logs(self):
        """Cleanup logs older than retention days."""
        try:
            self.db.cleanup_old_logs(self.config.retention_days)
        except Exception as e:
            logger.error(f"Failed to cleanup old logs: {e}", exc_info=True)


async def main():
    """Entry point for filesystem daemon."""
    config = FileSystemDaemonConfig.from_settings()
    daemon = FileSystemDaemon(config)
    
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(daemon.stop()))
    
    try:
        await daemon.start()
    except Exception as e:
        logger.error(f"Daemon failed: {e}", exc_info=True)
    finally:
        # Safe to call even if already stopped -- disposed guard prevents double-stop
        await daemon.stop()


if __name__ == "__main__":
    asyncio.run(main())
