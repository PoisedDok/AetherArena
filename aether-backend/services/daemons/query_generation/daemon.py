"""
Query generation daemon main loop.

EVENT-DRIVEN: Monitors signal file from source daemons, processes immediately.
"""
import asyncio
import logging
import signal
import sqlite3
import uuid
from pathlib import Path
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent

from services.daemons.query_generation.config import QueryGenerationDaemonConfig
from services.daemons.query_generation.db import QueryGenerationDB
from services.daemons.query_generation.generator import QueryGenerator
from services.daemons import QUERY_GEN_SIGNAL_FILE, CHAT_ACTIVITY_SIGNAL_FILE

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("QueryGenerationDaemon")


class SignalFileHandler(FileSystemEventHandler):
    """Watches for signal file from source daemons.
    
    RACE CONDITION FIX: Uses _pending_signal flag to prevent dropped signals.
    Without this, a signal arriving while processing is True would be silently
    dropped. If no further activity triggers a new signal, the logs from the
    dropped signal sit in SQLite indefinitely (silent data loss).
    
    With _pending_signal: the dropped signal is remembered, and after
    processing completes, the handler re-triggers itself to pick up any
    logs that arrived during the processing window.
    """
    
    def __init__(self, daemon, loop):
        self.daemon = daemon
        self.loop = loop  # Main daemon's event loop
        self.processing = False  # Prevent overlapping processing
        self._pending_signal = False  # Track signals that arrived during processing
    
    def on_created(self, event: FileSystemEvent):
        """Triggered when signal file is created."""
        event_path = Path(event.src_path).resolve()
        if event_path == QUERY_GEN_SIGNAL_FILE:
            self._trigger_processing()
    
    def on_modified(self, event: FileSystemEvent):
        """Triggered when signal file is modified (touch)."""
        event_path = Path(event.src_path).resolve()
        if event_path == QUERY_GEN_SIGNAL_FILE:
            self._trigger_processing()
    
    def _trigger_processing(self):
        """Trigger immediate processing (non-blocking) from watchdog thread.
        
        If already processing, sets _pending_signal so the current processing
        loop re-triggers after completion instead of silently dropping the signal.
        """
        if self.processing:
            self._pending_signal = True
            logger.debug("Already processing — signal queued via _pending_signal")
            return
        
        self.processing = True
        logger.info("Signal detected — triggering query generation immediately")
        
        # Schedule coroutine in main event loop from different thread
        asyncio.run_coroutine_threadsafe(self._process_and_cleanup(), self.loop)
    
    async def _process_and_cleanup(self):
        """Process logs and cleanup signal file. Loops until no more logs above threshold."""
        try:
            was_paused = False
            while True:
                # --- CHAT ACTIVITY GUARD ---
                # Check BEFORE every batch. If user starts chatting mid-backlog, pause immediately.
                # Running this inside the coroutine is safe because self.processing = True,
                # meaning subsequent Watchdog triggers just set self._pending_signal = True
                # instead of being dropped.
                if CHAT_ACTIVITY_SIGNAL_FILE.exists():
                    try:
                        last_chat_time = datetime.fromtimestamp(CHAT_ACTIVITY_SIGNAL_FILE.stat().st_mtime, tz=timezone.utc)
                        diff = (datetime.now(timezone.utc) - last_chat_time).total_seconds()
                        if diff < 120:
                            was_paused = True
                            remaining = 120 - diff
                            logger.info(f"Pipeline paused due to active chat. Sleeping {remaining:.1f}s...")
                            await asyncio.sleep(remaining + 1)
                            continue  # Re-evaluate after sleep in case they chatted again
                    except OSError as e:
                        logger.warning(f"Failed to check chat activity signal file: {e}")
                
                # If we just woke up from a pause, mark all accumulated backlog as stale.
                # Proactive pipeline must ONLY process fresh logs, never the stale backlog
                # that built up while the user was actively chatting.
                if was_paused:
                    logger.info("Woke from active chat pause. Trashing accumulated backlog to ensure only fresh logs are processed.")
                    await self.daemon._mark_existing_logs_stale(reason="stale_due_to_chat")
                    was_paused = False
                # --- END CHAT ACTIVITY GUARD ---

                logs_processed_count = await self.daemon._process_new_logs()
                
                # Delete signal file after a round of processing
                try:
                    if QUERY_GEN_SIGNAL_FILE.exists():
                        QUERY_GEN_SIGNAL_FILE.unlink()
                        logger.debug("Signal file deleted")
                except OSError:
                    pass  # Already deleted by another thread
                
                if logs_processed_count == 0:
                    # No more batches to process (or no sources met thresholds)
                    break
                    
                # Small sleep to let daemons breathe and check for more logs
                await asyncio.sleep(1)
                
        except Exception as e:
            logger.error(f"Failed to process signal: {e}", exc_info=True)
        finally:
            self.processing = False
            # Re-trigger if a signal arrived during this processing window.
            # Without this, logs from the dropped signal sit unprocessed
            # indefinitely if no further activity generates a new signal.
            if self._pending_signal:
                self._pending_signal = False
                logger.info("Processing pending signal that arrived during previous cycle")
                self._trigger_processing()


class QueryGenerationDaemon:
    """
    Main daemon for query generation from source logs.
    
    Follows proactive-IR paper methodology:
    - Monitors browser, email, filesystem logs
    - Groups new logs into context windows (size=5)
    - Generates queries using zero-shot LLM (Figure 3 prompt)
    - Stores query + source documents for proactive agent use
    """
    
    def __init__(self, config: QueryGenerationDaemonConfig):
        self.config = config
        self.running = False
        self._is_disposed = False
        
        # NOTE: PID-based singleton protection removed - daemon_manager enforces singleton
        # Running as asyncio task within daemon_manager process, so os.getpid() returns parent PID
        # This caused false "already running" errors on reload
        
        self.db = QueryGenerationDB(config.db_path)
        self.generator = QueryGenerator(
            api_base=config.llm_api_base,
            model=config.llm_model,
            api_key=config.llm_api_key or "not-needed",
            timeout_seconds=config.llm_timeout_seconds,
            max_query_terms=config.max_query_terms,
            use_lowercase=config.use_lowercase,
            remove_special_chars=config.remove_special_chars,
            temperature=config.llm_temperature,
            max_tokens=config.llm_max_tokens,
        )
        
        self.last_cleanup_time = datetime.now(timezone.utc)
        self.last_config_check = datetime.now(timezone.utc)
        self.config_check_interval = 10  # Check config every 10 seconds
        
        # Track which daemons to monitor (HIGH signal sources only)
        # NOTE: active_windows removed - too noisy, no actionable content
        self.source_daemons = ["browser", "email", "filesystem"]
        
        # Track which source daemon tables have been migrated (ALTER TABLE)
        # Prevents running ALTER TABLE on every _mark_logs_processed call
        self._migrated_tables: set = set()
        
        # Watchdog observer for signal file (event-driven)
        self.observer = Observer()
        self.signal_handler = None  # Will be initialized with event loop in start()
        
        # Poison pill protection
        self._failed_attempts: dict = {}
        self._MAX_FAILURES_PER_BATCH = 3
    
    async def start(self):
        """Start the event-driven daemon loop."""
        logger.info("🚀 Starting Query Generation Daemon (EVENT-DRIVEN Mode)")
        logger.info(f"   LLM: {self.config.llm_model} via {self.config.llm_api_base}")
        logger.info(f"   Signal File: {QUERY_GEN_SIGNAL_FILE}")
        logger.info(f"   Priority Thresholds: {self.config.priority_thresholds}")
        
        # PRO-FIX: Mark all existing unprocessed logs as stale on startup
        # Ensures we ONLY process logs generated while this daemon instance is active
        await self._mark_existing_logs_stale()

        # Get the running event loop and initialize signal handler with it
        loop = asyncio.get_running_loop()
        self.signal_handler = SignalFileHandler(self, loop)
        
        # Start watchdog observer for signal file
        self.observer.schedule(self.signal_handler, str(QUERY_GEN_SIGNAL_FILE.parent), recursive=False)
        self.observer.start()
        logger.info(f"👀 Watching for signal file: {QUERY_GEN_SIGNAL_FILE}")
        
        self.running = True
        self._last_sweep_time = datetime.now(timezone.utc)
        
        # Background maintenance loop (no polling for logs!)
        while self.running:
            try:
                now = datetime.now(timezone.utc)
                
                # 1. Check for config updates periodically
                if (now - self.last_config_check).total_seconds() >= self.config_check_interval:
                    await self._check_and_reload_config()
                    self.last_config_check = now
                
                # 2. Cleanup old queries daily (kept for 1 day as per architecture)
                if (now - self.last_cleanup_time).total_seconds() >= 86400:  # 24 hours
                    await self._cleanup_old_queries(days=1)
                    self.last_cleanup_time = now
                
                # 3. Safety-net sweep: check for unprocessed logs that were missed
                # due to failed processing or dropped signals. Prevents logs from
                # rotting in SQLite when _has_signaled stays True in source daemons
                # and no new signal arrives after a query generation failure.
                if (now - self._last_sweep_time).total_seconds() >= 120:  # Every 2 minutes
                    self._last_sweep_time = now
                    if self.signal_handler and not self.signal_handler.processing:
                        total_pending = sum(
                            self._get_fresh_count(d) for d in self.source_daemons
                        )
                        if total_pending > 0:
                            logger.info(
                                "Sweep detected %d unprocessed logs across sources — triggering processing",
                                total_pending,
                            )
                            self.signal_handler._trigger_processing()
                
                # Sleep 60s between maintenance checks (NOT processing!)
                await asyncio.sleep(60)
                
            except Exception as e:
                logger.error(f"Error in maintenance loop: {e}", exc_info=True)
                await asyncio.sleep(60)

    async def _mark_existing_logs_stale(self, reason: str = "stale_on_startup"):
        """Mark all currently unprocessed logs in source daemons as stale."""
        logger.info(f"🧹 Initializing clean slate: Marking existing unprocessed logs as stale ({reason})...")
        
        table_map = {
            "browser": "browser_logs",
            "email": "email_logs",
            "filesystem": "fs_logs"
        }
        
        for daemon_name in self.source_daemons:
            try:
                db_path = self._get_source_daemon_db_path(daemon_name)
                if not db_path:
                    continue
                
                table_name = table_map.get(daemon_name)
                if not table_name:
                    continue
                
                conn = self._open_source_db(db_path)
                
                # Mark as processed with the provided marker
                cursor = conn.execute(
                    f"UPDATE {table_name} SET query_gen_processed = 1, processed_by_query_id = '{reason}' WHERE query_gen_processed = 0"
                )
                affected = cursor.rowcount
                conn.commit()
                conn.close()
                
                if affected > 0:
                    logger.info(f"   ✓ Marked {affected} stale {daemon_name} logs")
            except Exception as e:
                logger.debug(f"   ⚠ Could not mark stale logs for {daemon_name}: {e}")
        
        logger.info("✨ Clean slate established. Ready for real-time logs.")
    
    async def stop(self):
        """Graceful shutdown -- stop observer with timeout, final index, close generator."""
        if self._is_disposed:
            return
        self._is_disposed = True
        
        logger.info("Stopping Query Generation Daemon...")
        self.running = False
        
        # Stop watchdog observer with timeout to prevent indefinite hang.
        # Guard: observer.join() raises RuntimeError if thread was never started.
        self.observer.stop()
        try:
            self.observer.join(timeout=10.0)
            if self.observer.is_alive():
                logger.warning("Signal file observer did not stop within 10s timeout")
        except RuntimeError:
            pass  # Observer was never started (e.g., stop() called before start())
        
        await self.generator.close()
    
    async def _check_and_reload_config(self):
        """Check if config has changed and reload if necessary."""
        try:
            new_config = QueryGenerationDaemonConfig.from_settings()
            
            # Compare key config values
            if (new_config.check_interval_seconds != self.config.check_interval_seconds or
                new_config.llm_model != self.config.llm_model or
                new_config.priority_thresholds != self.config.priority_thresholds):
                
                logger.info("🔄 Config changed, reloading...")
                logger.info(f"   Old: check={self.config.check_interval_seconds}s, model={self.config.llm_model}")
                logger.info(f"   New: check={new_config.check_interval_seconds}s, model={new_config.llm_model}")
                
                # Close old generator if model changed
                if new_config.llm_model != self.config.llm_model:
                    await self.generator.close()
                    self.generator = QueryGenerator(
                        api_base=new_config.llm_api_base,
                        model=new_config.llm_model,
                        api_key=new_config.llm_api_key or "not-needed",
                        timeout_seconds=new_config.llm_timeout_seconds,
                        max_query_terms=new_config.max_query_terms,
                        use_lowercase=new_config.use_lowercase,
                        remove_special_chars=new_config.remove_special_chars,
                        temperature=new_config.llm_temperature,
                        max_tokens=new_config.llm_max_tokens,
                    )
                    logger.info(f"   🔄 LLM generator reloaded with model: {new_config.llm_model}")
                
                self.config = new_config
                    
        except Exception as e:
            logger.error(f"Failed to reload config: {e}", exc_info=True)
    
    def _get_source_daemon_db_path(self, daemon_name: str) -> Optional[Path]:
        """Get the SQLite path for a source daemon."""
        db_path = self.config.app_root / "data" / "daemons" / daemon_name / "logs.db"
        if not db_path.exists():
            logger.debug(f"Daemon DB not found: {daemon_name} at {db_path}")
            return None
        return db_path
    
    def _open_source_db(self, db_path) -> sqlite3.Connection:
        """Open a source daemon DB with WAL mode and timeout for safe cross-process reads."""
        conn = sqlite3.connect(db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _infer_source_from_log(self, log: Dict[str, Any]) -> str:
        """Infer source daemon from a log payload (explicit marker first, then shape)."""
        source = log.get("_source_daemon")
        if source in {"browser", "email", "filesystem"}:
            return source

        if "sender" in log or "subject" in log:
            return "email"
        if "url" in log or "visit_count" in log or "typed_count" in log:
            return "browser"
        if "file_path" in log or "action" in log or "file_name" in log:
            return "filesystem"
        return "unknown"

    def _build_context_doc_lineage_id(self, log: Dict[str, Any]) -> str:
        """Create a stable, globally unique lineage ID for a triggering log."""
        source = self._infer_source_from_log(log)
        log_id = log.get("id")
        if log_id is not None:
            return f"{source}:{log_id}"
        timestamp = log.get("timestamp", "unknown")
        return f"{source}:unknown:{timestamp}"

    def _canonicalize_triggering_log(self, log: Dict[str, Any]) -> Dict[str, Any]:
        """
        Normalize source log into SourceDocument-like structure for Phase 2.

        Output contract:
        {
            source: "email|browser|filesystem",
            timestamp: "...",
            content: "...",
            metadata: { ...source specific fields..., _context_type, _batch }
        }
        """
        source = self._infer_source_from_log(log)
        timestamp = log.get("timestamp") or datetime.now(timezone.utc).isoformat()
        metadata = {
            k: v
            for k, v in log.items()
            if k
            not in {
                "id",
                "timestamp",
                "query_gen_processed",
                "processed_by_query_id",
                "indexed",
                "day_date",
                "_source_daemon",
            }
        }

        if log.get("id") is not None:
            metadata["log_id"] = log.get("id")
        metadata["source_daemon"] = source
        metadata["lineage_id"] = self._build_context_doc_lineage_id(log)

        content = ""
        if source == "email":
            sender = metadata.get("sender") or metadata.get("from")
            if sender:
                metadata.setdefault("sender", sender)
                metadata.setdefault("from", sender)
            content = metadata.get("body_preview") or ""
            if metadata.get("subject"):
                metadata.setdefault("title", metadata.get("subject"))
        elif source == "filesystem":
            file_path = metadata.get("file_path") or metadata.get("path")
            if file_path:
                metadata.setdefault("path", file_path)
                metadata.setdefault("file_path", file_path)
                metadata.setdefault("file_name", Path(file_path).name)
            content = metadata.get("content_preview") or ""
            if metadata.get("file_name"):
                metadata.setdefault("title", metadata.get("file_name"))
        elif source == "browser":
            content = metadata.get("search_query") or metadata.get("url") or ""
            if metadata.get("title"):
                metadata.setdefault("title", metadata.get("title"))
            elif metadata.get("url"):
                metadata.setdefault("title", metadata.get("url"))

        metadata["_context_type"] = "triggering_log"
        metadata["_batch"] = "current"

        return {
            "source": source,
            "timestamp": timestamp,
            "content": content,
            "metadata": metadata,
        }

    def _canonicalize_previous_query_doc(self, prev_q: Dict[str, Any], batch_label: str) -> Dict[str, Any]:
        """Normalize previous query context into SourceDocument-like structure."""
        query_id = prev_q.get("query_id", "")
        lineage_id = f"query_gen:{query_id}" if query_id else "query_gen:unknown"
        return {
            "source": "query_gen",
            "timestamp": prev_q.get("timestamp") or datetime.now(timezone.utc).isoformat(),
            "content": prev_q.get("query", ""),
            "metadata": {
                "_context_type": "previous_query",
                "_batch": batch_label,
                "query": prev_q.get("query", ""),
                "batch_id": prev_q.get("batch_id", "unknown"),
                "query_id": query_id,
                "title": prev_q.get("query", "Previous query"),
                "source_daemon": "query_gen",
                "lineage_id": lineage_id,
            },
        }
    
    def _get_recent_logs(self, daemon_name: str, limit: int = 5) -> List[Dict[str, Any]]:
        """
        Get the MOST RECENT unprocessed logs from a source.
        Uses query_gen_processed flag to ensure no logs are skipped.
        """
        db_path = self._get_source_daemon_db_path(daemon_name)
        if not db_path:
            return []
        
        try:
            table_map = {"browser": "browser_logs", "email": "email_logs", "filesystem": "fs_logs"}
            
            table_name = table_map[daemon_name]
            
            conn = self._open_source_db(db_path)
            conn.row_factory = sqlite3.Row
            
            # Get MOST RECENT unprocessed logs (No timestamp filtering, use processing flag only)
            cursor = conn.execute(
                f"SELECT * FROM {table_name} WHERE query_gen_processed = 0 ORDER BY timestamp DESC LIMIT ?",
                (limit,)
            )
            logs = [dict(row) for row in cursor.fetchall()]
            conn.close()
            
            return logs
            
        except Exception:
            # Silent - daemon table may not exist yet or be locked
            return []

    def _get_fresh_count(self, daemon_name: str) -> int:
        """Count how many unprocessed logs a source daemon has."""
        try:
            db_path = self._get_source_daemon_db_path(daemon_name)
            if not db_path:
                return 0
            
            table_map = {"browser": "browser_logs", "email": "email_logs", "filesystem": "fs_logs"}
            
            table = table_map[daemon_name]
            
            conn = self._open_source_db(db_path)
            count = conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE query_gen_processed = 0"
            ).fetchone()[0]
            conn.close()
            
            return count
        except Exception:
            # Silent - daemon table may not exist yet
            return 0
    
    def _ensure_table_migrated(self, conn: sqlite3.Connection, table_name: str):
        """One-time migration: add processed_by_query_id column if missing.
        
        Tracked in _migrated_tables set to avoid ALTER TABLE on every call.
        """
        if table_name in self._migrated_tables:
            return
        
        try:
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN processed_by_query_id TEXT")
            logger.info(f"Migrated {table_name}: added processed_by_query_id column")
        except sqlite3.OperationalError as e:
            # Check if error is specifically about duplicate column, else re-raise
            # e.g., "duplicate column name: processed_by_query_id"
            if "duplicate column name" in str(e).lower():
                pass  # Column already exists
            else:
                logger.error(f"Failed to migrate table {table_name}: {e}")
                raise  # Re-raise to prevent executing UPDATEs against a missing column
        
        self._migrated_tables.add(table_name)
    
    def _mark_logs_processed(self, daemon_name: str, log_ids: List[int], query_id: str = None):
        """
        Mark logs as processed for query generation and link to query_id.
        
        This creates bidirectional linking:
        - Query -> Logs (via context_doc_ids in generated_queries)
        - Logs -> Query (via processed_by_query_id in source tables)
        
        Enables proactive agent to expand context using query IDs.
        """
        db_path = self._get_source_daemon_db_path(daemon_name)
        if not db_path or not log_ids:
            return
        
        try:
            table_map = {
                "browser": "browser_logs",
                "email": "email_logs",
                "filesystem": "fs_logs"
            }
            
            table_name = table_map[daemon_name]
            
            conn = self._open_source_db(db_path)
            
            # One-time migration check (skipped after first call per table)
            self._ensure_table_migrated(conn, table_name)
            
            # Mark as processed and link to query_id
            placeholders = ','.join(['?'] * len(log_ids))
            conn.execute(
                f"UPDATE {table_name} SET query_gen_processed = 1, processed_by_query_id = ? WHERE id IN ({placeholders})",
                [query_id] + log_ids
            )
            conn.commit()
            conn.close()
            
            logger.debug(f"Marked {len(log_ids)} {daemon_name} logs as processed (query_id: {query_id})")
            
        except Exception as e:
            logger.error(f"Failed to mark logs as processed in {daemon_name}: {e}")

    async def _process_new_logs(self):
        """
        Cross-Source Activity Analysis with Linear Time-based Processing.
        
        Collects recent logs from each source, feeds ALL logs together to 
        query agent with previous batch context.
        """
        # 1. Fetch last 3 batches for rich ICL context (up to 9 queries total)
        previous_batch = self.db.get_last_batch_queries(limit=9)
        
        # Priority order for source collection (HIGH signal sources only)
        priority_order = ["email", "filesystem", "browser"]
        
        # Collect recent logs from ALL active sources
        all_recent_logs = []
        active_sources = []
        logs_to_mark = {}  # Track which logs to mark as processed {source: List[id]}
        
        # Unique batch ID for grouping
        batch_id = str(uuid.uuid4())[:8]
        
        # Two-pass source collection with cross-source aggregation.
        # Pass 1: scan all sources for fresh counts (cheap DB calls).
        # Pass 2: if ANY source exceeds its threshold, include ALL sources
        #         that have unprocessed data — prevents dropping valuable
        #         cross-source context (e.g. 1 browser visit + 1 file edit
        #         on the same topic should both reach the query generator).
        source_fresh_counts = {}
        
        for daemon_name in priority_order:
            if daemon_name not in self.source_daemons:
                continue
            try:
                db_path = self._get_source_daemon_db_path(daemon_name)
                if not db_path:
                    continue
                source_fresh_counts[daemon_name] = self._get_fresh_count(daemon_name)
            except Exception as e:
                logger.debug(f"Skipping {daemon_name} scan: {e}")
                continue
        
        # Check which sources crossed their individual threshold
        triggered_sources = [
            name for name, count in source_fresh_counts.items()
            if count >= self.config.priority_thresholds.get(name, 2)
        ]
        
        if not triggered_sources:
            return 0
        
        # Cross-source aggregation: include every source with ANY unprocessed data
        sources_to_process = [
            name for name, count in source_fresh_counts.items() if count > 0
        ]
        
        if len(sources_to_process) > len(triggered_sources):
            extras = set(sources_to_process) - set(triggered_sources)
            logger.info(
                f"Cross-source aggregation: {triggered_sources} triggered, "
                f"including {list(extras)} below-threshold sources for context"
            )
        
        for daemon_name in sources_to_process:
            try:
                fresh_count = source_fresh_counts[daemon_name]
                # Process filesystem logs 1 at a time to prevent context bloat.
                # For others, batch up to 5.
                if daemon_name == "filesystem":
                    num_to_take = min(1, fresh_count)
                else:
                    num_to_take = min(5, fresh_count)
                
                recent_logs = self._get_recent_logs(daemon_name, num_to_take)
                
                if recent_logs:
                    recent_logs = [
                        {**log, "_source_daemon": daemon_name}
                        for log in recent_logs
                    ]
                    recent_logs.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
                    all_recent_logs.extend(recent_logs)
                    active_sources.append(daemon_name)
                    logs_to_mark[daemon_name] = [log['id'] for log in recent_logs]
                    logger.info(f"📥 Collected {len(recent_logs)} recent logs from {daemon_name}")
            
            except Exception as e:
                logger.debug(f"Skipping {daemon_name}: {e}")
                continue
        
        # If no activity across all sources, skip
        if not all_recent_logs:
            return 0
        
        # Ensure overall context is sorted by timestamp DESC
        all_recent_logs.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
        
        # Build a deterministic batch key to track failures (Poison Pill protection)
        batch_key = tuple(sorted(self._build_context_doc_lineage_id(log) for log in all_recent_logs))
        
        logger.info(f"🔥 Activity Spark [Batch: {batch_id}]: {len(all_recent_logs)} total recent logs from {len(active_sources)} sources: {active_sources}")
        
        # Generate queries with Evolutionary Context (ICL)
        try:
            queries = await self.generator.generate_queries_cross_source(
                all_recent_logs, 
                active_sources,
                previous_batch=previous_batch
            )
            
            if queries:
                # Store queries with full cross-source context + evolutionary context (ICL)
                all_log_ids = [
                    self._build_context_doc_lineage_id(log)
                    for log in all_recent_logs
                ]
                source_summary = {src: len(logs_to_mark[src]) for src in logs_to_mark}
                
                # Build complete context docs: recent logs + previous batch queries with their contexts
                # This gives Phase 2 agent the FULL evolution trail for better decision-making
                complete_context_docs = []
                
                # Add recent triggering logs
                for log in all_recent_logs:
                    complete_context_docs.append(self._canonicalize_triggering_log(log))
                
                # Add evolutionary context (previous queries ONLY - not their docs)
                # ARCHITECTURE: Agent has retriever tools to fetch old docs if needed.
                # ICL feedback loop provides richer context via successful past responses.
                if previous_batch:
                    for i, prev_q in enumerate(previous_batch, 1):
                        batch_label = f'N-{len(previous_batch) - i + 1}'
                        complete_context_docs.append(
                            self._canonicalize_previous_query_doc(prev_q, batch_label)
                        )
                        # REMOVED: Old doc injection (lines 480-488)
                        # Agent can retrieve old docs via retriever tool if truly needed
                
                logger.info(
                    f"📦 Complete context for Phase 2: {len(all_recent_logs)} current logs + "
                    f"{len(previous_batch) if previous_batch else 0} previous queries (abstracted, no old docs) "
                    f"= {len(complete_context_docs)} total context documents"
                )
                
                # Generate and store each query with complete evolutionary context
                query_ids = []
                for query in queries:
                    logger.info(f"✨ PROACTIVE QUERY: {query}")
                    query_id = self.db.insert_query(
                        query=query,
                        source_daemon="cross_source",
                        context_docs=complete_context_docs,  # FULL context with evolution
                        context_doc_ids=all_log_ids,
                        generation_method=f"agentic_cross_source_{source_summary}",
                        llm_model=self.config.llm_model,
                        batch_id=batch_id
                    )
                    query_ids.append(query_id)
                
                # Mark all processed logs with query_id linking
                primary_query_id = query_ids[0] if query_ids else None
                for daemon_name, log_ids in logs_to_mark.items():
                    self._mark_logs_processed(daemon_name, log_ids, primary_query_id)
                
                logger.info(f"✅ Batch {batch_id} complete: {len(queries)} queries generated (primary: {primary_query_id})")
                
                # Clear failure tracking on success to prevent memory leaks
                self._failed_attempts.clear()
                
                return len(all_recent_logs)
            else:
                # Mark logs as processed even if no queries generated to maintain linear flow
                for daemon_name, log_ids in logs_to_mark.items():
                    self._mark_logs_processed(daemon_name, log_ids, query_id=None)
                logger.info(f"⚠️ Batch {batch_id}: No queries needed (logs marked as processed)")
                self._failed_attempts.clear()
                return len(all_recent_logs)
                
        except Exception as e:
            logger.error(f"Error in batch {batch_id}: {e}", exc_info=True)
            
            # Poison pill protection
            if len(self._failed_attempts) > 100:
                self._failed_attempts.clear()
                
            failures = self._failed_attempts.get(batch_key, 0) + 1
            self._failed_attempts[batch_key] = failures
            
            if failures >= self._MAX_FAILURES_PER_BATCH:
                logger.warning(f"POISON PILL: Batch {batch_id} failed {failures} times. Marking logs as failed to unblock queue.")
                for daemon_name, log_ids in logs_to_mark.items():
                    self._mark_logs_processed(daemon_name, log_ids, query_id='failed')
                self._failed_attempts.pop(batch_key, None)
            
            return 0

    # Remove duplicate/old definition
    def _create_context_windows(
        self,
        logs: List[Dict[str, Any]],
        window_size: int
    ) -> List[List[Dict[str, Any]]]:
        """
        Create sliding context windows from logs.
        
        Paper uses m=5 documents as context (Equation 6).
        Uses non-overlapping windows to avoid duplicate queries.
        """
        windows = []
        
        # Non-overlapping windows
        for i in range(0, len(logs), window_size):
            window = logs[i:i + window_size]
            if len(window) >= window_size:  # Only use full windows
                windows.append(window)
        
        return windows
    
    async def _cleanup_old_queries(self, days: int = 1):
        """Remove old generated queries (keep 1 day).
        
        MUST be async -- called with `await` from the maintenance loop.
        """
        try:
            self.db.cleanup_old_queries(days=days)
        except Exception as e:
            logger.error(f"Cleanup failed: {e}")


async def main():
    """Entry point for standalone daemon execution."""
    config = QueryGenerationDaemonConfig.from_settings()
    config.validate()
    
    daemon = QueryGenerationDaemon(config)
    
    # Use loop-native signal handlers (safe for async context)
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
