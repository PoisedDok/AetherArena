"""
Proactive Agent Worker Handler

Phase 2 of DeepPlanning architecture - processes queries from Phase 1 daemon.

Architecture Flow:
1. Query gen daemon (Phase 1) → generates queries → SQLite (used_by_agent = 0)
2. THIS WORKER monitors SQLite for unprocessed queries  
3. Calls /v1/proactive/scout endpoint → Perplexica agent scouts
4. Agent stores results in Supabase → proactive_agent_runs
5. Marks queries as used_by_agent = 1 in SQLite
6. If decision = 'intervene' → emit WebSocket notification to frontend

@.architecture
Incoming: SQLite query_generation.db --- {generated_queries WHERE used_by_agent = 0}
Processing: Fetch queries → Call proactive agent → Store results → Mark processed --- {4 jobs: JOB_FETCH, JOB_CALL_AGENT, JOB_STORE, JOB_MARK}
Outgoing: Supabase proactive_agent_runs + WebSocket notifications --- {agent_run record, WS event}
"""

import asyncio
import httpx
import logging
import sqlite3
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)
HTTPX_TIMEOUT_ERRORS = (asyncio.TimeoutError, httpx.TimeoutException)


class ProactiveAgentWorker:
    """
    Worker that monitors query_generation.db and triggers proactive agent.
    
    Runs as background watchdog - similar to query generation daemon but
    operates on generated queries instead of raw logs.
    
    Lifecycle:
    - start() enters heartbeat loop
    - stop() sets running=False, waits for current processing to finish
    - _is_disposed prevents operations after stop
    """
    
    def __init__(
        self,
        app_root: Path,
        backend_url: str = None,
        settings=None,
        websocket_hub=None,
        websocket_hub_getter=None,
    ):
        self.app_root = app_root
        # Derive backend URL from central config if not explicitly provided
        if backend_url is None:
            from config.settings import get_settings as _get_settings
            _s = settings or _get_settings()
            backend_url = f"http://127.0.0.1:{_s.security.bind_port}"
        self.backend_url = backend_url.rstrip("/")
        self.settings = settings  # Central config (settings.proactive.agent_worker)
        self.websocket_hub = websocket_hub  # Phase 3: WebSocket notifications
        self._websocket_hub_getter = websocket_hub_getter
        
        # SQLite DB path (Phase 1 output)
        self.query_db_path = app_root / "data" / "daemons" / "query_generation" / "queries.db"
        
        # Runtime config path (user control)
        self.config_path = app_root / "data" / "runtime" / "proactive_config.json"
        
        # Daemon DB paths (for fetching context docs)
        self.daemon_db_paths = {
            "browser": app_root / "data" / "daemons" / "browser" / "logs.db",
            "email": app_root / "data" / "daemons" / "email" / "logs.db",
            "filesystem": app_root / "data" / "daemons" / "filesystem" / "logs.db"
        }
        
        # Lifecycle flags
        self.running = False
        self._is_disposed = False
        self.processing = False  # CRITICAL: Gate to prevent concurrent processing
        
        # Circuit breaker: exponential backoff on consecutive agent call failures.
        # Prevents tight retry loops when Perplexica is down (300s timeout per call,
        # retrying every 10s heartbeat = permanently blocked without backoff).
        self._consecutive_failures = 0
        self._backoff_until: Optional[datetime] = None
        self._BACKOFF_THRESHOLD = 3   # Start backing off after this many failures
        self._BACKOFF_BASE_SECONDS = 30
        self._BACKOFF_MAX_SECONDS = 600  # 10 minute ceiling
        
        self._failed_attempts: Dict[str, int] = {}
        self._MAX_FAILURES_PER_QUERY = 3
        
        # Configuration from settings (NO HARDCODING)
        if self.settings and hasattr(self.settings, 'proactive'):
            worker_config = self.settings.proactive.agent_worker
            self.heartbeat_interval = worker_config.heartbeat_interval_seconds
            self.max_processing_time = worker_config.max_processing_time_seconds
        else:
            # Fallback if settings not provided (shouldn't happen)
            logger.warning("Settings not provided to ProactiveAgentWorker - using defaults")
            self.heartbeat_interval = 10  # 10s default (near real-time)
            self.max_processing_time = 300
        
        logger.info(
            "ProactiveAgentWorker initialized (heartbeat: %ds)",
            self.heartbeat_interval,
        )
    
    async def start(self):
        """
        Start worker loop with smart heartbeat.
        
        Each cycle calls _process_cycle() which fetches the SINGLE most recent
        unprocessed query from SQLite and processes it through the proactive agent.
        
        Backlog prevention: _get_most_recent_unprocessed_query() marks ALL older
        unprocessed queries as stale (used_by_agent=1) atomically when fetching
        the latest one. This ensures zero backlog drift — the agent always
        processes only the freshest query, because older queries' context is
        already subsumed by newer query generation batches.
        """
        if self._is_disposed:
            logger.warning("Cannot start disposed ProactiveAgentWorker")
            return
        self.running = True
        logger.info("Proactive Agent Worker started - heartbeat every %ds", self.heartbeat_interval)
        
        try:
            while self.running:
                try:
                    await self._process_cycle()
                except Exception as e:  # noqa: BLE001 -- heartbeat loop: must catch all to keep worker alive
                    logger.error("Worker cycle failed: %s", e, exc_info=True)
                    # Ensure processing flag reset on error
                    self.processing = False
                
                # Smart heartbeat interval (5-10s for near real-time)
                # Protected by outer try/finally to handle CancelledError gracefully
                await asyncio.sleep(self.heartbeat_interval)
        except asyncio.CancelledError:
            logger.info("Proactive Agent Worker cancelled")
            raise
        finally:
            self.running = False
            self.processing = False
            logger.info("Proactive Agent Worker cleanup completed")
    
    def stop(self):
        """Stop worker loop gracefully.
        
        Sets running=False so the heartbeat loop exits on next iteration.
        Uses _is_disposed to prevent double-stop and post-stop operations.
        """
        if self._is_disposed:
            return
        self._is_disposed = True
        self.running = False
        logger.info("Proactive Agent Worker stopped")
    
    def _is_enabled(self) -> bool:
        """Check if proactive agent is enabled in runtime config.

        Uses unified ProactiveConfigReader (D3 fix) when settings is available.
        Falls back to direct file read when settings was not provided (safety net).
        """
        try:
            if self.settings and hasattr(self.settings, 'proactive'):
                from config.proactive_config_reader import read_proactive_config
                cfg = read_proactive_config(self.settings)
                self.heartbeat_interval = max(1, int(cfg.heartbeat_interval_seconds))
                self.max_processing_time = max(1, int(cfg.max_processing_time_seconds))
                return bool(cfg.enabled and cfg.worker_enabled)
            # Fallback: direct file read (no settings available)
            if not self.config_path.exists():
                return True
            with open(self.config_path, 'r') as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                self.heartbeat_interval = max(1, int(raw.get("heartbeat_interval_seconds", self.heartbeat_interval)))
                self.max_processing_time = max(1, int(raw.get("max_processing_time_seconds", self.max_processing_time)))
                return bool(raw.get("enabled", True) and raw.get("worker_enabled", True))
            return True
        except Exception as e:
            logger.error("Failed to read runtime config: %s", e)
            return True
    
    async def _process_cycle(self):
        """
        One processing cycle - check for single query and process.
        
        ARCHITECTURE: Single-query processing (not batching) for simplicity
        and freshness. Most recent query is always most relevant.
        
        CIRCUIT BREAKER: After _BACKOFF_THRESHOLD consecutive failures, skips
        cycles with exponential backoff (30s, 60s, 120s, ... up to 600s max).
        Resets on first success. Prevents tight retry loops when Perplexica
        is offline, while allowing quick recovery when it comes back.
        """
        if self._is_disposed:
            return
            
        if self.processing:
            return
            
        # --- CHAT ACTIVITY GUARD (WORKER) ---
        # If the user is chatting, do not pick up new queries from the backlog.
        # This prevents the 5.6min heavy agent from stealing compute and interrupting.
        try:
            from services.daemons import CHAT_ACTIVITY_SIGNAL_FILE
            if CHAT_ACTIVITY_SIGNAL_FILE.exists():
                last_chat_time = datetime.fromtimestamp(CHAT_ACTIVITY_SIGNAL_FILE.stat().st_mtime, tz=timezone.utc)
                if (datetime.now(timezone.utc) - last_chat_time).total_seconds() < 120:
                    logger.debug("Pipeline paused due to active chat. Worker sleeping.")
                    return
        except Exception as e:
            logger.warning(f"Worker failed to check chat activity guard: {e}")
        # --- END CHAT ACTIVITY GUARD ---
        
        # Guard: don't process if disposed
        if self._is_disposed:
            return

        # Refresh settings dynamically to respect DB preferences (invalidated via Realtime)
        try:
            from api.dependencies import get_database_connection
            from application.settings import get_runtime_settings_service
            gateway = get_database_connection()
            if gateway is None:
                # CRITICAL FIX: Skip entire cycle if database gateway is unavailable to prevent
                # infinite loops of fetching the same query and silently aborting.
                return
            self.settings = await get_runtime_settings_service().get_runtime_settings(gateway, "default_user")
        except Exception as e:
            logger.debug("Could not refresh runtime settings in ProactiveAgentWorker: %s", e)
        
        # Circuit breaker: skip cycle if in backoff period
        if self._backoff_until and datetime.now(timezone.utc) < self._backoff_until:
            remaining = (self._backoff_until - datetime.now(timezone.utc)).total_seconds()
            logger.debug(
                "Circuit breaker active (%d consecutive failures) — %.0fs until retry",
                self._consecutive_failures, remaining,
            )
            return
        
        # CRITICAL: Check if user disabled proactive agent
        if not self._is_enabled():
            logger.debug("Proactive agent disabled by user - skipping cycle")
            return
        
        # Check if query DB exists
        if not self.query_db_path.exists():
            logger.debug("Query DB not found: %s", self.query_db_path)
            return
        
        # Get SINGLE most recent unprocessed query
        query = self._get_most_recent_unprocessed_query()
        
        if not query:
            logger.debug("No unprocessed queries found")
            return
        
        logger.info("Found unprocessed query: %s...", query['query'][:80])
        
        # Process single query (with processing flag protection)
        await self._process_single_query(query)
    
    def _get_most_recent_unprocessed_query(self) -> Optional[Dict[str, Any]]:
        """
        Get SINGLE most recent unprocessed query from SQLite.
        
        CRITICAL BEHAVIOR:
        - Returns ONLY top 1 query from the most recent batch
        - Marks ALL OTHER older unprocessed queries from DIFFERENT batches as stale (used_by_agent=1)
        - This ensures we process all queries from the latest event but drop backlog batches.
        
        Rationale: Query generation generates multiple angles per event (same batch_id).
        Discarding by timestamp drops sibling queries from the same event.
        
        Returns: Single query dict or None if no queries available
        """
        conn = None
        try:
            conn = sqlite3.connect(self.query_db_path, timeout=10.0)
            conn.row_factory = sqlite3.Row
            
            # 1. Get the batch_id of the most recent unprocessed query
            cursor = conn.execute("""
                SELECT batch_id
                FROM generated_queries
                WHERE used_by_agent = 0
                ORDER BY timestamp DESC
                LIMIT 1
            """)
            
            row = cursor.fetchone()
            if not row:
                return None
                
            latest_batch_id = row["batch_id"]
            
            # 2. Select ONE query from this latest batch
            cursor = conn.execute("""
                SELECT query_id, query, source_daemon, day_date, 
                       context_docs, context_doc_ids, timestamp, batch_id
                FROM generated_queries
                WHERE used_by_agent = 0 AND batch_id = ?
                ORDER BY timestamp DESC
                LIMIT 1
            """, (latest_batch_id,))
            
            row = cursor.fetchone()
            
            if row:
                latest_query = dict(row)
                latest_id = latest_query["query_id"]
                
                # 3. Mark older unprocessed queries from DIFFERENT batches as stale
                update_sql = """
                    UPDATE generated_queries
                    SET used_by_agent = 1
                    WHERE used_by_agent = 0
                    AND (batch_id != ? OR batch_id IS NULL)
                """
                params = [latest_batch_id]
                
                # Get all query IDs in the current batch to retain their failure counts
                cursor = conn.execute(
                    "SELECT query_id FROM generated_queries WHERE batch_id = ?",
                    (latest_batch_id,)
                )
                current_batch_query_ids = {r["query_id"] for r in cursor.fetchall()}
                
                # Delete stale failing queries from memory to prevent leaks
                failing_query_ids = list(self._failed_attempts.keys())
                for qid in failing_query_ids:
                    if qid not in current_batch_query_ids:
                        del self._failed_attempts[qid]
                    
                stale_cursor = conn.execute(update_sql, params)
                
                stale_count = stale_cursor.rowcount
                if stale_count > 0:
                    logger.info("Marked %d older queries as stale (from previous batches)", stale_count)
                
                conn.commit()
                return latest_query
            else:
                return None
            
        except Exception as e:  # noqa: BLE001 -- SQLite query boundary: return None on any failure to keep worker alive
            logger.error("Failed to fetch unprocessed query: %s", e)
            return None
        finally:
            if conn:
                conn.close()

    def _parse_context_docs(self, context_docs_json: str) -> List[Dict[str, Any]]:
        """Parse context_docs JSON from SQLite."""
        try:
            parsed = json.loads(context_docs_json)
            return parsed if isinstance(parsed, list) else []
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            logger.error("Failed to parse context_docs: %s", e)
            return []

    def _infer_source_type(self, doc: Dict[str, Any], metadata: Dict[str, Any]) -> str:
        """Infer source type for legacy rows that were stored without explicit source."""
        source = doc.get("source") or metadata.get("source")
        if source:
            return str(source).lower()

        merged = {**doc, **metadata}
        context_type = merged.get("_context_type")
        if context_type == "previous_query":
            return "query_gen"
        if "sender" in merged or "subject" in merged or "from" in merged:
            return "email"
        if "url" in merged or "visit_count" in merged or "typed_count" in merged:
            return "browser"
        if "file_path" in merged or "file_name" in merged or "action" in merged:
            return "filesystem"
        return "unknown"

    def _normalize_source_doc(self, doc: Dict[str, Any], fallback_timestamp: str) -> Optional[Dict[str, Any]]:
        """Normalize context doc into stable source-doc shape for Phase 2 scout API."""
        if not isinstance(doc, dict):
            return None

        raw_metadata = doc.get("metadata")
        metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}

        # Merge legacy flat keys into metadata.
        for key, value in doc.items():
            if key not in {"source", "timestamp", "content", "metadata"}:
                metadata.setdefault(key, value)

        # Preserve context markers inside metadata for endpoint splitting logic.
        if doc.get("_context_type") and "_context_type" not in metadata:
            metadata["_context_type"] = doc.get("_context_type")
        if doc.get("_batch") and "_batch" not in metadata:
            metadata["_batch"] = doc.get("_batch")

        source = self._infer_source_type(doc, metadata)
        timestamp = doc.get("timestamp") or metadata.get("timestamp") or fallback_timestamp
        content = doc.get("content")
        if content is None:
            if source == "email":
                content = metadata.get("body_preview", "")
            elif source == "filesystem":
                content = metadata.get("content_preview", "")
            elif source == "browser":
                content = metadata.get("search_query") or metadata.get("url", "")
            elif source == "query_gen":
                content = metadata.get("query", "")
            else:
                content = ""

        # Alias normalization used by frontend context formatting.
        if source == "email":
            sender = metadata.get("sender") or metadata.get("from")
            if sender:
                metadata.setdefault("sender", sender)
                metadata.setdefault("from", sender)
            if metadata.get("subject"):
                metadata.setdefault("title", metadata.get("subject"))
        elif source == "filesystem":
            file_path = metadata.get("file_path") or metadata.get("path")
            if file_path:
                metadata.setdefault("file_path", file_path)
                metadata.setdefault("path", file_path)
                metadata.setdefault("file_name", Path(file_path).name)
            if metadata.get("file_name"):
                metadata.setdefault("title", metadata.get("file_name"))
        elif source == "browser":
            if metadata.get("title"):
                metadata.setdefault("title", metadata.get("title"))
            elif metadata.get("url"):
                metadata.setdefault("title", metadata.get("url"))

        return {
            "source": source,
            "timestamp": timestamp,
            "content": content or "",
            "metadata": metadata,
        }
    
    async def _process_single_query(self, query: Dict[str, Any]):
        """
        Process SINGLE query through proactive agent.
        
        CRITICAL: Uses try-finally to ensure processing flag is ALWAYS reset,
        even on error. This prevents stuck state where no queries can be processed.
        
        Args:
            query: Single query record from SQLite
        """
        # Set processing flag BEFORE any work
        self.processing = True
        start_time = datetime.now(timezone.utc)
        
        try:
            # Extract data for agent
            query_id = query["query_id"]
            query_text = query["query"]
            day_date = query["day_date"]
            trace_id = self._build_trace_id(query_id)
            
            # Parse context docs from query
            context_docs = self._parse_context_docs(query.get("context_docs", "[]"))
            
            # Build source docs for agent
            source_docs = []
            for doc in context_docs:
                normalized = self._normalize_source_doc(doc, query["timestamp"])
                if normalized is not None:
                    source_docs.append(normalized)
            
            logger.info(
                "Calling proactive agent [trace_id=%s] for query: %s...",
                trace_id,
                query_text[:80],
            )
            
            from services.proactive.scout_service import execute_proactive_scout
            from api.dependencies import get_database_connection
            from config.settings import get_settings
            
            # Since the worker is a daemon, use direct service invocation
            gateway = get_database_connection()
            if gateway is None:
                logger.debug("Database gateway not available. Skipping proactive agent execution.")
                # Do NOT record a failure, just skip and don't mark as processed.
                # Reset processing flag is handled in finally block.
                return

            # Use dynamically refreshed settings from _process_cycle
            settings = self.settings or get_settings()
            
            result = await execute_proactive_scout(
                query_ids=[query_id],
                queries=[query_text],
                source_docs=source_docs,
                day_date=day_date,
                settings=settings,
                gateway=gateway,
                session_id=None,
                trace_id=trace_id,
                max_processing_time_seconds=self.max_processing_time,
            )
            
            result_trace_id = (
                result.get("trace_id")
                or result.get("traceId")
                or trace_id
            )
            processing_time = (datetime.now(timezone.utc) - start_time).total_seconds()
            
            logger.info(
                "Agent decision [trace_id=%s]: %s, tool_budget: %d, time: %.1fs",
                result_trace_id,
                result['decision'],
                int(result.get("tool_budget", 0) or 0),
                processing_time,
            )
            
            # SUCCESS: reset circuit breaker
            self._consecutive_failures = 0
            self._backoff_until = None
            if query_id in self._failed_attempts:
                del self._failed_attempts[query_id]
            
            # Mark query as processed ONLY on success (proper persistence control)
            self._mark_query_processed(query_id, result["run_id"])
            
            # Phase 3: Emit WebSocket notification for interventions
            if result["decision"] == "intervene" and result.get("recommendation"):
                logger.info(
                    "INTERVENTION [trace_id=%s]: %s...",
                    result_trace_id,
                    result['recommendation'][:100],
                )
                await self._emit_proactive_notification(
                    result,
                    source_docs=source_docs,
                    queries=[query_text],
                )
                    
        except HTTPX_TIMEOUT_ERRORS:
            logger.error(
                "Processing timeout [trace_id=%s] after %ds",
                trace_id if 'trace_id' in locals() else "unknown",
                self.max_processing_time,
            )
            self._record_failure(query_id)
            # Do NOT mark as processed - timeout might be transient
        except Exception as e:  # noqa: BLE001 -- query processing boundary: must catch all to reset processing flag
            logger.error(
                "Failed to process query [trace_id=%s]: %s",
                trace_id if 'trace_id' in locals() else "unknown",
                e,
                exc_info=True,
            )
            self._record_failure(query_id)
            # Do NOT mark as processed - exception might be DB/network issue
        finally:
            # CRITICAL: ALWAYS reset processing flag (prevents stuck state)
            self.processing = False
            elapsed = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.debug("Processing flag released after %.1fs", elapsed)

    def _build_trace_id(self, query_id: str) -> str:
        """Build a correlation ID for one proactive query-processing attempt."""
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
        return f"proactive-{query_id}-{timestamp}-{uuid4().hex[:8]}"
    
    def _record_failure(self, query_id: str):
        """Record a consecutive agent call failure and compute backoff.
        
        Exponential backoff: base * 2^(failures - threshold).
        After 3 failures: 30s, 60s, 120s, 240s, 480s, 600s (capped).
        Resets to zero on first success in _process_single_query.
        """
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._BACKOFF_THRESHOLD:
            exponent = self._consecutive_failures - self._BACKOFF_THRESHOLD
            delay = min(
                self._BACKOFF_BASE_SECONDS * (2 ** exponent),
                self._BACKOFF_MAX_SECONDS,
            )
            self._backoff_until = datetime.now(timezone.utc) + timedelta(seconds=delay)
            logger.warning(
                "Circuit breaker: %d consecutive failures — backing off for %ds (next retry at %s)",
                self._consecutive_failures, delay,
                self._backoff_until.isoformat(),
            )
            
        count = self._failed_attempts.get(query_id, 0) + 1
        self._failed_attempts[query_id] = count
        if count >= self._MAX_FAILURES_PER_QUERY:
            logger.warning("POISON PILL: Query %s exceeded max failures (%d)", query_id, self._MAX_FAILURES_PER_QUERY)
            self._mark_query_failed(query_id)
            del self._failed_attempts[query_id]
            
    def _mark_query_failed(self, query_id: str):
        """Mark single query as failed (-1) in SQLite to prevent poison pill looping."""
        conn = None
        try:
            conn = sqlite3.connect(self.query_db_path, timeout=10.0)
            cursor = conn.execute("""
                UPDATE generated_queries
                SET used_by_agent = -1
                WHERE query_id = ?
            """, (query_id,))
            conn.commit()
            if cursor.rowcount > 0:
                logger.warning("POISON PILL: Marked query %s as failed (used_by_agent = -1)", query_id)
        except Exception as e:
            logger.error("Failed to mark query %s as failed: %s", query_id, e)
        finally:
            if conn:
                conn.close()
    
    def _mark_query_processed(self, query_id: str, run_id: str):
        """
        Mark single query as processed in SQLite.
        
        CRITICAL: Sets used_by_agent = 1 to prevent reprocessing.
        Includes error handling to prevent silent failures.
        
        BUG FIX: Uses cursor.rowcount (per-statement) instead of
        conn.total_changes (cumulative across connection lifetime).
        """
        conn = None
        try:
            conn = sqlite3.connect(self.query_db_path, timeout=10.0)
            
            cursor = conn.execute("""
                UPDATE generated_queries
                SET used_by_agent = 1
                WHERE query_id = ?
            """, (query_id,))
            
            conn.commit()
            affected = cursor.rowcount
            
            if affected > 0:
                logger.info("Marked query %s as processed (run_id: %s)", query_id, run_id)
            else:
                logger.warning("Query %s not found for marking (may have been staled)", query_id)
            
        except Exception as e:  # noqa: BLE001 -- SQLite boundary: marking processed is non-critical, don't crash worker
            logger.error("Failed to mark query as processed: %s", e, exc_info=True)
        finally:
            if conn:
                conn.close()

    def _normalize_doc_research_context(self, raw_context: Any) -> Any:
        """Normalize persisted scout context payload into JSON-serializable structure."""
        if raw_context is None:
            return []
        if isinstance(raw_context, (list, dict)):
            return raw_context
        if isinstance(raw_context, str):
            try:
                parsed = json.loads(raw_context)
                if isinstance(parsed, (list, dict)):
                    return parsed
            except (json.JSONDecodeError, ValueError, TypeError):
                pass
            return [{"type": "raw_context", "value": raw_context}]
        return [{"type": "raw_context", "value": str(raw_context)}]

    def _build_source_summaries(
        self,
        source_docs: Optional[List[Dict[str, Any]]],
    ) -> List[Dict[str, Any]]:
        """Build lightweight source summaries for attribution in proactive metadata."""
        summaries: List[Dict[str, Any]] = []
        for doc in (source_docs or []):
            metadata = doc.get("metadata", {})
            source_type = self._infer_source_type(doc, metadata)
            context_type = metadata.get("_context_type")

            # Keep user-facing source attribution scoped to current triggering logs.
            if context_type and context_type != "triggering_log":
                continue

            entry = {"type": source_type}
            if source_type == "email":
                entry["subject"] = metadata.get("subject", "")
                entry["from"] = metadata.get("from") or metadata.get("sender", "")
            elif source_type == "filesystem":
                entry["filename"] = (
                    metadata.get("file_name")
                    or metadata.get("filename")
                    or metadata.get("path")
                    or metadata.get("file_path", "")
                )
            elif source_type == "browser":
                entry["url"] = metadata.get("url", "")
                entry["title"] = metadata.get("title", "")
            elif source_type == "active_windows":
                entry["title"] = metadata.get("window_title", metadata.get("app_name", ""))

            summaries.append(entry)
        return summaries
    
    async def _emit_proactive_notification(
        self,
        result: Dict[str, Any],
        source_docs: Optional[List[Dict[str, Any]]] = None,
        queries: Optional[List[str]] = None,
    ):
        """
        Emit WebSocket notification for proactive intervention.
        
        Phase 3: Broadcasts to all connected clients via WebSocket hub.
        Frontend HandsfreeConversationDisplay receives and displays.
        
        CRITICAL: Includes full persisted doc-research context in payloads so the
        frontend can seed chat metadata and runtime history hydration.
        
        Args:
            result: Agent run result with recommendation, confidence, etc.
            source_docs: Original triggering activity documents (email/file/browser)
            queries: Generated queries that triggered this agent run
        """
        if not self.websocket_hub:
            try:
                if callable(self._websocket_hub_getter):
                    self.websocket_hub = self._websocket_hub_getter()
            except Exception as hub_err:
                logger.warning("[WS] WebSocket hub getter failed: %s", hub_err)
        if not self.websocket_hub:
            logger.warning("❌ [WS] WebSocket hub not available - cannot emit notification")
            return
        
        recommendation = result.get("recommendation", "")
        if not recommendation:
            logger.warning("[WS] No recommendation text in result - skipping notification")
            return
        
        run_id_str = str(result.get("run_id", ""))
        
        persisted_doc_research = self._normalize_doc_research_context(result.get("context"))
        context = {
            "version": "proactive_context_v2",
            "run_id": run_id_str,
            "queries": queries or [],
            "sources": self._build_source_summaries(source_docs),
            "source_docs": source_docs or [],
            "doc_research": persisted_doc_research,
            "executed_tools": result.get("executed_tools", []),
        }
        
        logger.info("[WS] PROACTIVE INTERVENTION: %s...", recommendation[:100])
        
        try:
            # We must emit stream-chunk and stream-end directly so HandsfreeConversationDisplay 
            # picks it up natively, even without an active chat window router.
            
            chunk_payload = {
                "role": "proactive",
                "type": "proactive:stream-chunk",
                "content": recommendation,
                "chunk": recommendation,
                "recommendation": recommendation,
                "run_id": run_id_str,
                "context": context,
            }
            await self.websocket_hub.broadcast_json(chunk_payload)
            
            end_payload = {
                "role": "proactive",
                "type": "proactive:stream-end",
                "run_id": run_id_str,
                "context": context,
            }
            await self.websocket_hub.broadcast_json(end_payload)
            
            logger.info("[WS] Proactive notification broadcast complete (run_id: %s)", run_id_str)
        except Exception as err:
            logger.error("[WS] Failed to broadcast proactive intervention: %s", err, exc_info=True)
