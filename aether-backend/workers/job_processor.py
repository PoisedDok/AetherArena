"""
Background Job Processor

Polls pending_jobs table and dispatches to appropriate handlers.
Follows docling_watchdog.py pattern with AsyncExitStack and graceful shutdown.

Features:
- Resource-aware scheduling (doesn't overwhelm system)
- Dependency tracking (sequential job chains)
- Priority-based ordering with starvation prevention
- Configurable resource budgets (NO HARDCODING)

@.architecture
Incoming: database (pending_jobs table) --- {Job records}
Processing: Poll jobs, dispatch to handlers, track health, manage resources --- {5 jobs: JOB_QUERY_DB, JOB_ORCHESTRATE, JOB_MANAGE_TASK, JOB_RESOURCE_MGMT, JOB_LOG}
Outgoing: handlers/*.py, database (job status updates) --- {Handler execution, job completion/failure}
"""

import asyncio
import signal
import sys
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from uuid import UUID

from workers.handlers.base_handler import BaseHandler
from workers.handlers.summarize_chat import SummarizeChatHandler
from workers.handlers.extract_memories import ExtractMemoriesHandler
from workers.handlers.promote_memories import PromoteMemoriesHandler
from data.database.clients.supabase import SupabaseClient
from data.database.persistence_gateway import SupabasePersistenceGateway
from config.settings import get_settings, WorkerSettings, JobQueueSettings
from monitoring import get_logger

logger = get_logger("workers.job_processor")


class JobProcessor:
    """
    Background worker that processes jobs from pending_jobs table.
    
    Polls database every N seconds (configurable), fetches pending jobs,
    dispatches to appropriate handlers, tracks health.
    """
    
    def __init__(
        self,
        gateway: SupabasePersistenceGateway,
        settings: WorkerSettings
    ):
        """
        Initialize job processor.
        
        Args:
            gateway: Database gateway for job queries
            settings: Worker configuration settings
        """
        self._gateway = gateway
        self._settings = settings
        self._queue_settings: JobQueueSettings = settings.job_queue
        self._running = False
        self._stop_requested = False
        
        # Health tracking
        self._jobs_processed = 0
        self._jobs_failed = 0
        self._last_health_check = datetime.now(timezone.utc)
        self._start_time = datetime.now(timezone.utc)
        self._last_stale_check = datetime.now(timezone.utc)
        
        # Resource tracking
        self._current_resource_usage = 0
        self._active_jobs: Dict[str, int] = {}  # job_id -> resource_cost
        self._active_tasks: set[asyncio.Task] = set()
        
        # Initialize handlers
        self._handlers: Dict[str, BaseHandler] = {
            "summarize_chat": SummarizeChatHandler(gateway),
            "extract_memories": ExtractMemoriesHandler(gateway),
            "promote_memories": PromoteMemoriesHandler(gateway),
        }
        
        # Resource costs per job type (from settings, NOT HARDCODED)
        self._resource_costs: Dict[str, int] = {
            "summarize_chat": self._queue_settings.resource_cost_summarize,
            "extract_memories": self._queue_settings.resource_cost_extract_memories,
            "promote_memories": self._queue_settings.resource_cost_promote_memories,
            "proactive_cleanup": self._queue_settings.resource_cost_proactive_cleanup,
        }
        
        logger.info(
            f"JobProcessor initialized with {len(self._handlers)} handlers: "
            f"{list(self._handlers.keys())}"
        )
        logger.info(
            f"Resource management: budget={self._queue_settings.max_resource_budget}, "
            f"enabled={self._queue_settings.enable_resource_management}"
        )
    
    async def start(self) -> None:
        """
        Start job processor main loop.
        
        Polls pending_jobs table and processes jobs until stop_requested.
        Handles graceful shutdown on SIGTERM/SIGINT.
        """
        if self._running:
            logger.warning("JobProcessor already running")
            return
        
        self._running = True
        self._stop_requested = False
        
        logger.info(
            f"Starting job processor (poll_interval={self._settings.poll_interval}s, "
            f"batch_size={self._settings.batch_size})"
        )
        
        async with AsyncExitStack():
            try:
                while not self._stop_requested:
                    # Poll and process jobs
                    await self._poll_and_process()
                    
                    # Log health periodically
                    await self._maybe_log_health()
                    
                    # Sleep until next poll
                    await asyncio.sleep(self._settings.poll_interval)
                    
            except asyncio.CancelledError:
                logger.info("Job processor cancelled, shutting down gracefully")
            except Exception as e:  # noqa: BLE001 -- top-level processor loop: must catch all to log and shut down gracefully
                logger.error("Job processor error: %s", e, exc_info=True)
            finally:
                self._running = False
                logger.info("Job processor stopped")
    
    async def stop(self) -> None:
        """
        Request graceful shutdown of job processor.
        
        Sets stop flag and waits for current job to complete.
        """
        if not self._running:
            logger.warning("JobProcessor not running")
            return
        
        logger.info("Requesting job processor shutdown...")
        self._stop_requested = True
        
        # Wait for graceful shutdown with timeout
        timeout = self._settings.shutdown_timeout
        for _ in range(int(timeout)):
            if not self._running:
                logger.info("Job processor stopped gracefully")
                return
            await asyncio.sleep(1.0)
        
        logger.warning(
            "Job processor did not stop within %ss timeout", timeout
        )
        
        # Explicit Task cancellation to prevent zombie jobs
        if getattr(self, "_active_tasks", None):
            logger.warning("Cancelling %d active jobs...", len(self._active_tasks))
            for task in list(self._active_tasks):  # Convert to list to avoid runtime modification issues
                task.cancel()
            try:
                await asyncio.wait_for(
                    asyncio.gather(*self._active_tasks, return_exceptions=True),
                    timeout=self._settings.shutdown_timeout
                )
                logger.info("All active jobs cancelled.")
            except asyncio.TimeoutError:
                logger.error("CRITICAL: Timed out waiting for %d active jobs to cancel during shutdown. Forcing exit.", len(self._active_tasks))
            except Exception as e:
                logger.error("Error during active jobs cancellation: %s", e)
    
    async def _poll_and_process(self) -> None:
        """
        Poll pending_jobs table and process available jobs.
        
        Uses resource-aware scheduling to:
        1. Respect resource budget (don't overwhelm system)
        2. Check job dependencies (sequential chains)
        3. Order by priority with starvation prevention
        """
        try:
            # Refresh settings dynamically to respect DB preferences (invalidated via Realtime)
            from application.settings import get_runtime_settings_service
            runtime_settings = await get_runtime_settings_service().get_runtime_settings(self._gateway, "default_user")
            self._settings = runtime_settings.workers
            self._queue_settings = self._settings.job_queue
            self._resource_costs = {
                "summarize_chat": self._queue_settings.resource_cost_summarize,
                "extract_memories": self._queue_settings.resource_cost_extract_memories,
                "promote_memories": self._queue_settings.resource_cost_promote_memories,
                "proactive_cleanup": self._queue_settings.resource_cost_proactive_cleanup,
            }
            
            # Reset stale processing jobs (robust recovery)
            await self._maybe_reset_stale_jobs()
            
            # Use global budget for resource-aware RPC (DB function handles current usage)
            max_budget = self._queue_settings.max_resource_budget
            
            # Get next pending jobs using resource-aware RPC function
            jobs = await self._get_next_jobs(max_budget)
            
            if not jobs or len(jobs) == 0:
                logger.debug("No pending jobs (or none fit within resource budget)")
                return
            
            logger.info(
                "Processing %d pending job(s) (budget: %s, local_usage: %s)",
                len(jobs), max_budget, self._current_resource_usage,
            )
            logger.info("Jobs to process: %s", [{'id': j.get('id'), 'type': j.get('job_type'), 'cost': j.get('resource_cost', 3)} for j in jobs])
            
            # Track resource usage for these jobs
            for job in jobs:
                job_id = job.get("id")
                resource_cost = job.get("resource_cost", self._queue_settings.resource_cost_default)
                self._active_jobs[job_id] = resource_cost
                self._current_resource_usage += resource_cost
            
            logger.info("Resource usage after allocation: %s/%s", self._current_resource_usage, self._queue_settings.max_resource_budget)
            
            # Process jobs concurrently (up to max_concurrent)
            batches = list(self._batch_jobs(jobs, self._settings.max_concurrent))
            logger.info("Created %d batch(es) for concurrent processing (max_concurrent=%d)", len(batches), self._settings.max_concurrent)
            
            for batch_idx, batch in enumerate(batches):
                logger.info("Processing batch %d/%d with %d job(s)", batch_idx + 1, len(batches), len(batch))
                tasks = []
                for job in batch:
                    task = asyncio.create_task(self._process_job_with_cleanup(job))
                    self._active_tasks.add(task)
                    task.add_done_callback(self._active_tasks.discard)
                    tasks.append(task)
                
                results = await asyncio.gather(*tasks, return_exceptions=True)
                logger.info("Batch %d completed, results: %s", batch_idx + 1, [type(r).__name__ if isinstance(r, Exception) else 'success' for r in results])
                
        except Exception as e:  # noqa: BLE001 -- poll cycle boundary: must catch all to keep processor alive for next cycle
            logger.error("Error polling jobs: %s", e, exc_info=True)
    
    async def _maybe_reset_stale_jobs(self) -> None:
        """Reset stale processing jobs if configured."""
        if not self._queue_settings.enable_stale_job_recovery:
            return
        
        now = datetime.now(timezone.utc)
        elapsed = (now - self._last_stale_check).total_seconds()
        if elapsed < self._queue_settings.stale_job_check_interval_seconds:
            return
        
        try:
            result = await self._gateway.rpc(
                "reset_stale_processing_jobs",
                {"p_timeout_minutes": self._queue_settings.stale_job_timeout_minutes}
            )
            logger.info("Stale job recovery ran (reset_count=%s)", result)
        except Exception as e:  # noqa: BLE001 -- DB RPC boundary: must suppress all to keep worker alive
            logger.warning("Stale job recovery failed: %s", e)
        finally:
            self._last_stale_check = now
    
    async def _process_job_with_cleanup(self, job: Dict[str, Any]) -> None:
        """Process job and release resources on completion."""
        job_id = job.get("id")
        try:
            await self._process_job(job)
        finally:
            # Release resources
            if job_id in self._active_jobs:
                released = self._active_jobs.pop(job_id, 0)
                self._current_resource_usage = max(0, self._current_resource_usage - released)
                logger.debug("Released %d resource units for job %s", released, job_id)
    
    async def _get_next_jobs(self, max_budget: int = 10) -> list[Dict[str, Any]]:
        """
        Get next pending jobs from database with resource awareness.
        
        Uses get_pending_jobs_batch() RPC function which:
        - Fetches jobs with status='pending'
        - Checks dependency satisfaction (depends_on completed)
        - Respects resource budget limit
        - Orders by priority DESC, created_at ASC
        - Uses SKIP LOCKED for concurrent workers
        - Limits to batch_size
        
        Falls back to get_next_pending_job() if v2 function not available.
        
        Args:
            max_budget: Maximum total resource budget (DB will account for current usage)
        
        Returns:
            List of job records
        """
        try:
            # Try resource-aware batch function first
            if self._queue_settings.enable_resource_management:
                try:
                    result = await self._gateway.rpc(
                        "get_pending_jobs_batch",
                        {
                            "p_batch_size": self._settings.batch_size,
                            "p_max_resource_cost": max_budget
                        }
                    )
                    if result:
                        if isinstance(result, list):
                            return result
                        return [result]
                except Exception as e:  # noqa: BLE001 -- DB RPC boundary: function may not exist yet; must fall back gracefully
                    logger.debug("get_pending_jobs_batch not available, falling back: %s", e)
            
            # Fallback: use original function (no resource awareness)
            jobs = []
            for _ in range(self._settings.batch_size):
                result = await self._gateway.rpc(
                    "get_next_pending_job_v2",
                    {}
                )
                if result:
                    # RPC returns a list with one job dict, extract it
                    if isinstance(result, list) and len(result) > 0:
                        job = result[0]
                    elif isinstance(result, dict):
                        job = result
                    else:
                        logger.warning("Unexpected result type from get_next_pending_job: %s", type(result))
                        continue
                    
                    # Add default resource cost if not present
                    if "resource_cost" not in job:
                        job_type = job.get("job_type", "")
                        job["resource_cost"] = self._resource_costs.get(
                            job_type, 
                            self._queue_settings.resource_cost_default
                        )
                    
                    jobs.append(job)
                else:
                    break  # No more pending jobs
            
            return jobs
            
        except Exception as e:  # noqa: BLE001 -- DB RPC boundary: must return empty list on any failure to keep worker alive
            logger.error("Failed to get next pending jobs: %s", e, exc_info=True)
            return []
    
    async def _process_job(self, job: Dict[str, Any]) -> None:
        """
        Process single job by dispatching to appropriate handler.
        
        Args:
            job: Job record from pending_jobs
        """
        job_id = job.get("id")
        job_type = job.get("job_type")
        
        logger.info("[_process_job] ENTRY - Processing job %s (type=%s)", job_id, job_type)
        logger.debug("[_process_job] Job data: %s", job)
        
        # Get handler for job type
        logger.debug("[_process_job] Looking for handler for type '%s' in %s", job_type, list(self._handlers.keys()))
        handler = self._handlers.get(job_type)
        if not handler:
            logger.error("[_process_job] No handler found for job type: %s", job_type)
            # Mark job as failed - unknown type
            await self._fail_unknown_job_type(job_id, job_type)
            return
        
        logger.info("[_process_job] Handler found: %s", type(handler).__name__)
        
        # Execute handler with timeout
        timeout = self._get_timeout_for_job_type(job_type)
        logger.info("[_process_job] Executing with timeout=%ss", timeout)
        
        try:
            logger.info("[_process_job] Calling handler.execute() for job %s", job_id)
            await asyncio.wait_for(
                handler.execute(job),
                timeout=timeout
            )
            
            # Handler is responsible for calling complete_job() on success
            self._jobs_processed += 1
            logger.info("[_process_job] Job %s processed successfully", job_id)
            logger.info("[_process_job] Stats: processed=%d, failed=%d", self._jobs_processed, self._jobs_failed)
            
        except asyncio.CancelledError:
            self._jobs_failed += 1
            error_msg = "Job %s cancelled (Worker shutting down)" % job_id
            logger.warning("[_process_job] %s", error_msg)
            # Requeue job so another worker can pick it up immediately
            await handler.fail_job(
                UUID(job_id),
                error_msg,
                retry=True
            )
            raise  # Re-raise to cleanly terminate the task
            
        except asyncio.TimeoutError:
            self._jobs_failed += 1
            error_msg = "Job %s timed out after %ss" % (job_id, timeout)
            logger.error("[_process_job] %s", error_msg)
            await handler.fail_job(
                UUID(job_id),
                error_msg,
                retry=True  # Timeout is retryable
            )
            
        except Exception as e:  # noqa: BLE001 -- job execution boundary: must catch all to mark job as failed and prevent stuck processing state
            self._jobs_failed += 1
            error_msg = "Job %s failed: %s" % (job_id, type(e).__name__)
            logger.error("[_process_job] %s", error_msg, exc_info=True)
            logger.error("[_process_job] Exception type: %s, args: %s", type(e).__name__, e.args)
            # Defensive fail-fast: if a handler throws without updating the job lifecycle,
            # the job can remain stuck in `processing` forever. As a fallback, mark it failed
            # ONLY if it is still `processing` after the exception.
            try:
                current = await self._gateway.select(
                    "pending_jobs",
                    columns="id,status,retry_count,max_retries,error_message",
                    filters={"id": str(job_id)},
                    single=True,
                )
                if current and current.get("status") == "processing":
                    await handler.fail_job(UUID(job_id), error_msg, retry=True)
            except Exception as lifecycle_err:  # noqa: BLE001 -- last-resort lifecycle recovery: must catch all to avoid masking original error
                logger.warning(
                    "[_process_job] Failed to apply fallback fail_job for %s: %s", job_id, lifecycle_err
                )
    
    async def _fail_unknown_job_type(self, job_id: str, job_type: str) -> None:
        """Mark job as failed due to unknown job type."""
        try:
            await self._gateway.rpc(
                "fail_job",
                {
                    "p_job_id": job_id,
                    "p_error_message": f"Unknown job type: {job_type}",
                    "p_retry": False  # Don't retry unknown types
                }
            )
            self._jobs_failed += 1
        except Exception as e:  # noqa: BLE001 -- DB RPC boundary: don't crash worker if fail-marking fails
            logger.error("Failed to mark job %s as failed: %s", job_id, e)
    
    def _get_timeout_for_job_type(self, job_type: str) -> float:
        """
        Get timeout for job type from settings.
        
        Args:
            job_type: Type of job
        
        Returns:
            Timeout in seconds (from WorkerSettings, not hardcoded)
        """
        timeouts = {
            "summarize_chat": self._settings.summarization_timeout,
            "extract_memories": self._settings.memory_extraction_timeout,
            "promote_memories": self._settings.promotion_timeout,
            "agent_memory": self._settings.agent_memory_timeout,
            "agent_research": self._settings.agent_research_timeout,
            "proactive_cleanup": self._settings.proactive_cleanup_timeout,
        }
        return timeouts.get(job_type, 300.0)  # Default 300s if not configured
    
    def _batch_jobs(self, jobs: list, batch_size: int) -> list[list]:
        """Split jobs into batches for concurrent processing."""
        return [
            jobs[i:i + batch_size]
            for i in range(0, len(jobs), batch_size)
        ]
    
    async def _maybe_log_health(self) -> None:
        """Log health status periodically."""
        now = datetime.now(timezone.utc)
        elapsed = (now - self._last_health_check).total_seconds()
        
        if elapsed >= self._settings.health_check_interval:
            uptime = (now - self._start_time).total_seconds()
            logger.info(
                f"📊 Health: processed={self._jobs_processed}, "
                f"failed={self._jobs_failed}, "
                f"uptime={uptime:.0f}s"
            )
            
            # Log to database if enabled
            if self._settings.health_log_to_db:
                await self._log_health_to_db()
            
            self._last_health_check = now
    
    async def _log_health_to_db(self) -> None:
        """Log health status to database (optional).
        
        Currently a no-op. Dedicated job audit trail deferred
        until multi-instance deployment.
        """
        pass
    
    def get_health_status(self) -> Dict[str, Any]:
        """
        Get current health status including resource usage.
        
        Returns:
            Health status dictionary
        """
        uptime = (datetime.now(timezone.utc) - self._start_time).total_seconds()
        return {
            "status": "healthy" if self._running else "stopped",
            "running": self._running,
            "jobs_processed": self._jobs_processed,
            "jobs_failed": self._jobs_failed,
            "uptime_seconds": uptime,
            "handlers": list(self._handlers.keys()),
            "resource_usage": {
                "current": self._current_resource_usage,
                "budget": self._queue_settings.max_resource_budget,
                "active_jobs": len(self._active_jobs),
                "available": self._queue_settings.max_resource_budget - self._current_resource_usage
            }
        }


async def initialize_gateway() -> Optional[SupabasePersistenceGateway]:
    """
    Initialize database gateway.
    
    Returns:
        Gateway instance or None if Supabase unavailable
    """
    settings = get_settings()
    
    if not settings.supabase.enabled:
        logger.error("Supabase disabled in settings, cannot start worker")
        return None
    
    try:
        client = SupabaseClient.from_env({
            "url": settings.supabase.url,
            "anon_key": settings.supabase.anon_key,
            "service_role_key": settings.supabase.service_role_key,
            "schema": settings.supabase.db_schema,
            "realtime_enabled": settings.supabase.realtime_enabled
        })
        await client.initialize()
        return SupabasePersistenceGateway(client)
    except Exception as e:  # noqa: BLE001 -- gateway init boundary: must return None on any failure; caller handles missing gateway
        logger.error("Failed to initialize Supabase gateway: %s", e, exc_info=True)
        return None


async def main_loop() -> None:
    """
    Main worker loop.
    
    Initializes gateway, creates processor, runs until interrupted.
    Handles graceful shutdown on SIGTERM/SIGINT.
    """
    logger.info("Starting background job worker")
    
    # Initialize database gateway
    gateway = await initialize_gateway()
    if not gateway:
        logger.error("Failed to initialize database gateway, exiting")
        sys.exit(1)
    
    # Load worker settings (NO HARDCODING - from central config + DB preferences)
    from application.settings import get_runtime_settings_service
    settings = await get_runtime_settings_service().get_runtime_settings(gateway, "default_user")
    worker_settings = settings.workers
    
    # Create job processor
    processor = JobProcessor(gateway, worker_settings)
    
    # Get running loop for native signal handlers
    loop = asyncio.get_running_loop()
    
    _background_tasks = set()
    
    def signal_handler():
        logger.info("Received shutdown signal, requesting processor stop")
        task = asyncio.create_task(processor.stop())
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, signal_handler)
    except NotImplementedError:
        # Fallback for Windows
        def win_signal_handler(signum, frame):
            logger.info("Received signal %s, requesting processor stop", signum)
            task = asyncio.create_task(processor.stop())
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)
        signal.signal(signal.SIGINT, win_signal_handler)
        signal.signal(signal.SIGTERM, win_signal_handler)
    
    try:
        # Start processor
        await processor.start()
    except asyncio.CancelledError:
        logger.info("Worker execution cancelled")
    except Exception as e:  # noqa: BLE001 -- top-level worker boundary: must catch all to enter cleanup
        logger.error("Worker failed with error: %s", e, exc_info=True)
    finally:
        # Cleanup
        await processor.stop()
        try:
            await gateway.dispose()
        except Exception as e:  # noqa: BLE001 -- cleanup boundary: must not raise during shutdown
            logger.error("Error disposing gateway: %s", e)
        
        logger.info("Job worker stopped")


if __name__ == "__main__":
    # Run worker
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        logger.info("Worker interrupted by user")
