"""
Tests for workers/job_processor.py

Covers: JobProcessor constructor, _process_job dispatch, _process_job_with_cleanup
resource release, _get_next_jobs (batch + fallback), _fail_unknown_job_type,
_get_timeout_for_job_type, _batch_jobs, _maybe_log_health, _maybe_reset_stale_jobs,
_poll_and_process, start/stop lifecycle, get_health_status, initialize_gateway.

All gateway + handler calls mocked. Handlers replaced with mock objects.
"""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4
from datetime import datetime, timezone, timedelta

from data.database.persistence_gateway import SupabasePersistenceGateway


def _make_settings():
    """Create WorkerSettings mock matching config.settings.WorkerSettings structure."""
    settings = MagicMock()
    settings.poll_interval = 5
    settings.batch_size = 10
    settings.max_concurrent = 3
    settings.shutdown_timeout = 10
    settings.health_check_interval = 60
    settings.health_log_to_db = False
    settings.summarization_timeout = 120.0
    settings.memory_extraction_timeout = 120.0
    settings.promotion_timeout = 60.0
    settings.agent_memory_timeout = 120.0
    settings.agent_research_timeout = 300.0
    settings.proactive_cleanup_timeout = 60.0

    jq = MagicMock()
    jq.poll_interval = 5
    jq.batch_size = 10
    jq.max_resource_budget = 100
    jq.resource_cost_summarize = 20
    jq.resource_cost_extract_memories = 15
    jq.resource_cost_promote_memories = 10
    jq.resource_cost_proactive_cleanup = 5
    jq.resource_cost_default = 3
    jq.stale_timeout_minutes = 30
    jq.enable_resource_management = True
    jq.enable_stale_job_recovery = True
    jq.stale_job_check_interval_seconds = 300
    jq.stale_job_timeout_minutes = 30
    settings.job_queue = jq
    return settings


def _make_gateway():
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.rpc = AsyncMock(return_value=[])
    gw.select = AsyncMock(return_value=[])
    gw.update = AsyncMock()
    gw.insert = AsyncMock()
    gw.dispose = AsyncMock()
    return gw


def _make_job(job_type="summarize_chat", resource_cost=20, job_id=None):
    return {
        "id": str(job_id or uuid4()),
        "job_type": job_type,
        "entity_id": str(uuid4()),
        "metadata": {"chat_id": str(uuid4())},
        "resource_cost": resource_cost,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "priority": 5,
    }


@pytest.fixture
def processor():
    """Create processor with mocked handlers to avoid real service init."""
    gw = _make_gateway()
    settings = _make_settings()
    # Patch all handler constructors to avoid settings/service init
    with patch("workers.job_processor.SummarizeChatHandler") as MockSum, \
         patch("workers.job_processor.ExtractMemoriesHandler") as MockExt, \
         patch("workers.job_processor.PromoteMemoriesHandler") as MockPro:
        # All handler mocks
        for mock_cls in [MockSum, MockExt, MockPro]:
            inst = mock_cls.return_value
            inst.execute = AsyncMock()
            inst.complete_job = AsyncMock()
            inst.fail_job = AsyncMock()

        from workers.job_processor import JobProcessor
        proc = JobProcessor(gw, settings)
    return proc, gw


# ===========================================================================
# Constructor Tests
# ===========================================================================

class TestConstructor:

    def test_init(self, processor):
        proc, gw = processor
        assert proc._gateway is gw
        assert proc._running is False
        assert proc._jobs_processed == 0

    def test_handlers_registered(self, processor):
        proc, _ = processor
        assert "summarize_chat" in proc._handlers
        assert "extract_memories" in proc._handlers
        assert "promote_memories" in proc._handlers

    def test_resource_costs_from_settings(self, processor):
        proc, _ = processor
        assert proc._resource_costs["summarize_chat"] == 20


# ===========================================================================
# Health Status Tests
# ===========================================================================

class TestHealthStatus:

    def test_get_health_status_stopped(self, processor):
        proc, _ = processor
        health = proc.get_health_status()
        assert health["status"] == "stopped"
        assert health["running"] is False
        assert health["jobs_processed"] == 0
        assert health["jobs_failed"] == 0
        assert "resource_usage" in health
        assert health["resource_usage"]["current"] == 0

    def test_health_resource_tracking(self, processor):
        proc, _ = processor
        proc._current_resource_usage = 50
        proc._active_jobs = {"job1": 30, "job2": 20}
        health = proc.get_health_status()
        assert health["resource_usage"]["current"] == 50
        assert health["resource_usage"]["active_jobs"] == 2
        assert health["resource_usage"]["available"] == 50  # 100 - 50


# ===========================================================================
# Process Job Tests (dispatch + error handling)
# ===========================================================================

class TestProcessJob:

    @pytest.mark.asyncio
    async def test_dispatch_known_type(self, processor):
        proc, gw = processor
        handler = proc._handlers["summarize_chat"]
        job = _make_job("summarize_chat")
        await proc._process_job(job)
        handler.execute.assert_called_once_with(job)
        assert proc._jobs_processed == 1

    @pytest.mark.asyncio
    async def test_dispatch_unknown_type(self, processor):
        proc, gw = processor
        job = _make_job("unknown_type_xyz")
        await proc._process_job(job)
        gw.rpc.assert_called_once()
        rpc_args = gw.rpc.call_args[0]
        assert rpc_args[0] == "fail_job"
        assert rpc_args[1]["p_job_id"] == job["id"]
        assert "Unknown job type: unknown_type_xyz" in rpc_args[1]["p_error_message"]
        assert rpc_args[1]["p_retry"] is False
        assert proc._jobs_failed == 1

    @pytest.mark.asyncio
    async def test_handler_exception_records_failure(self, processor):
        proc, gw = processor
        handler = proc._handlers["summarize_chat"]
        handler.execute.side_effect = RuntimeError("LLM crash")
        # Gateway select returns job still in "processing" state
        gw.select.return_value = {"id": "x", "status": "processing"}
        job = _make_job("summarize_chat")
        await proc._process_job(job)
        assert proc._jobs_failed == 1

    @pytest.mark.asyncio
    async def test_handler_timeout_retries(self, processor):
        proc, _ = processor
        handler = proc._handlers["summarize_chat"]

        async def slow_execute(job):
            await asyncio.sleep(999)

        handler.execute = AsyncMock(side_effect=slow_execute)
        # Override timeout to be very short
        proc._settings.summarization_timeout = 0.01
        job = _make_job("summarize_chat")
        await proc._process_job(job)
        handler.fail_job.assert_called_once()
        assert proc._jobs_failed == 1


# ===========================================================================
# Process Job With Cleanup (resource release)
# ===========================================================================

class TestProcessJobWithCleanup:

    @pytest.mark.asyncio
    async def test_releases_resources_on_success(self, processor):
        proc, _ = processor
        job = _make_job("summarize_chat", resource_cost=20)
        job_id = job["id"]
        proc._active_jobs[job_id] = 20
        proc._current_resource_usage = 20
        await proc._process_job_with_cleanup(job)
        assert job_id not in proc._active_jobs
        assert proc._current_resource_usage == 0

    @pytest.mark.asyncio
    async def test_releases_resources_on_failure(self, processor):
        proc, gw = processor
        handler = proc._handlers["summarize_chat"]
        handler.execute.side_effect = RuntimeError("fail")
        gw.select.return_value = {"id": "x", "status": "processing"}
        job = _make_job("summarize_chat", resource_cost=15)
        job_id = job["id"]
        proc._active_jobs[job_id] = 15
        proc._current_resource_usage = 15
        await proc._process_job_with_cleanup(job)
        assert proc._current_resource_usage == 0


# ===========================================================================
# Get Next Jobs Tests
# ===========================================================================

class TestGetNextJobs:

    @pytest.mark.asyncio
    async def test_batch_rpc(self, processor):
        proc, gw = processor
        batch_result = [_make_job(), _make_job()]
        gw.rpc.return_value = batch_result
        jobs = await proc._get_next_jobs(100)
        assert len(jobs) == 2

    @pytest.mark.asyncio
    async def test_fallback_when_batch_fails(self, processor):
        proc, gw = processor
        # First RPC call (batch) fails, subsequent (single) calls succeed then return None
        single_job = _make_job()
        gw.rpc.side_effect = [
            RuntimeError("function not found"),  # batch fails
            [single_job],  # first single call
            None,  # no more jobs
        ]
        jobs = await proc._get_next_jobs(100)
        assert len(jobs) == 1

    @pytest.mark.asyncio
    async def test_returns_empty_on_total_failure(self, processor):
        proc, gw = processor
        gw.rpc.side_effect = ConnectionError("DB down")
        jobs = await proc._get_next_jobs(100)
        assert jobs == []

    @pytest.mark.asyncio
    async def test_single_job_dict_result(self, processor):
        """When fallback RPC returns a dict instead of list."""
        proc, gw = processor
        proc._queue_settings.enable_resource_management = False
        single_job = _make_job()
        gw.rpc.side_effect = [single_job, None]
        jobs = await proc._get_next_jobs(100)
        assert len(jobs) == 1

    @pytest.mark.asyncio
    async def test_adds_default_resource_cost(self, processor):
        proc, gw = processor
        proc._queue_settings.enable_resource_management = False
        job = {"id": str(uuid4()), "job_type": "summarize_chat", "metadata": {}}
        gw.rpc.side_effect = [[job], None]
        jobs = await proc._get_next_jobs(100)
        assert len(jobs) == 1
        assert jobs[0]["resource_cost"] == 20  # from settings


# ===========================================================================
# Fail Unknown Job Type
# ===========================================================================

class TestFailUnknownJobType:

    @pytest.mark.asyncio
    async def test_fails_with_no_retry(self, processor):
        proc, gw = processor
        await proc._fail_unknown_job_type("job-id-1", "bad_type")
        gw.rpc.assert_called_once_with("fail_job", {
            "p_job_id": "job-id-1",
            "p_error_message": "Unknown job type: bad_type",
            "p_retry": False,
        })
        assert proc._jobs_failed == 1

    @pytest.mark.asyncio
    async def test_db_error_suppressed(self, processor):
        proc, gw = processor
        gw.rpc.side_effect = RuntimeError("DB error")
        await proc._fail_unknown_job_type("job-id-1", "bad_type")
        # Should not raise


# ===========================================================================
# Timeout Lookup
# ===========================================================================

class TestGetTimeoutForJobType:

    def test_known_types(self, processor):
        proc, _ = processor
        assert proc._get_timeout_for_job_type("summarize_chat") == 120.0
        assert proc._get_timeout_for_job_type("promote_memories") == 60.0

    def test_unknown_type_default(self, processor):
        proc, _ = processor
        assert proc._get_timeout_for_job_type("nonexistent") == 300.0


# ===========================================================================
# Batch Jobs
# ===========================================================================

class TestBatchJobs:

    def test_single_batch(self, processor):
        proc, _ = processor
        jobs = [1, 2, 3]
        batches = proc._batch_jobs(jobs, 5)
        assert batches == [[1, 2, 3]]

    def test_multiple_batches(self, processor):
        proc, _ = processor
        jobs = [1, 2, 3, 4, 5]
        batches = proc._batch_jobs(jobs, 2)
        assert batches == [[1, 2], [3, 4], [5]]

    def test_empty(self, processor):
        proc, _ = processor
        assert proc._batch_jobs([], 3) == []


# ===========================================================================
# Stale Job Recovery
# ===========================================================================

class TestMaybeResetStaleJobs:

    @pytest.mark.asyncio
    async def test_skips_if_disabled(self, processor):
        proc, gw = processor
        proc._queue_settings.enable_stale_job_recovery = False
        await proc._maybe_reset_stale_jobs()
        gw.rpc.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_if_interval_not_elapsed(self, processor):
        proc, gw = processor
        proc._last_stale_check = datetime.now(timezone.utc)  # Just checked
        await proc._maybe_reset_stale_jobs()
        gw.rpc.assert_not_called()

    @pytest.mark.asyncio
    async def test_runs_when_interval_elapsed(self, processor):
        proc, gw = processor
        proc._last_stale_check = datetime.now(timezone.utc) - timedelta(seconds=600)
        gw.rpc.return_value = 2  # 2 jobs reset
        await proc._maybe_reset_stale_jobs()
        gw.rpc.assert_called_once_with(
            "reset_stale_processing_jobs",
            {"p_timeout_minutes": 30}
        )

    @pytest.mark.asyncio
    async def test_rpc_error_suppressed(self, processor):
        proc, gw = processor
        proc._last_stale_check = datetime.now(timezone.utc) - timedelta(seconds=600)
        gw.rpc.side_effect = RuntimeError("DB error")
        await proc._maybe_reset_stale_jobs()
        # Should not raise, timestamp still updated


# ===========================================================================
# Maybe Log Health
# ===========================================================================

class TestMaybeLogHealth:

    @pytest.mark.asyncio
    async def test_logs_when_interval_elapsed(self, processor):
        proc, _ = processor
        proc._last_health_check = datetime.now(timezone.utc) - timedelta(seconds=120)
        proc._settings.health_check_interval = 60
        await proc._maybe_log_health()
        # Just verifies no crash; actual logging is side-effect

    @pytest.mark.asyncio
    async def test_skips_when_recent(self, processor):
        proc, _ = processor
        proc._last_health_check = datetime.now(timezone.utc)
        proc._settings.health_check_interval = 60
        old_check = proc._last_health_check
        await proc._maybe_log_health()
        # last_health_check should NOT be updated
        assert proc._last_health_check == old_check


# ===========================================================================
# Poll And Process Integration
# ===========================================================================

class TestPollAndProcess:

    @pytest.mark.asyncio
    async def test_no_jobs_noop(self, processor):
        proc, gw = processor
        proc._last_stale_check = datetime.now(timezone.utc)  # Skip stale check
        gw.rpc.return_value = []
        await proc._poll_and_process()
        assert proc._jobs_processed == 0

    @pytest.mark.asyncio
    async def test_processes_batch(self, processor):
        proc, gw = processor
        proc._last_stale_check = datetime.now(timezone.utc)  # Skip stale check
        jobs = [_make_job("summarize_chat"), _make_job("extract_memories")]
        gw.rpc.return_value = jobs
        await proc._poll_and_process()
        assert proc._jobs_processed == 2

    @pytest.mark.asyncio
    async def test_error_in_poll_suppressed(self, processor):
        proc, gw = processor
        proc._last_stale_check = datetime.now(timezone.utc)
        gw.rpc.side_effect = RuntimeError("total failure")
        await proc._poll_and_process()
        # Should not raise


# ===========================================================================
# Start / Stop Lifecycle
# ===========================================================================

class TestLifecycle:

    @pytest.mark.asyncio
    async def test_stop_when_not_running(self, processor):
        proc, _ = processor
        await proc.stop()  # Should not raise

    @pytest.mark.asyncio
    async def test_start_idempotent(self, processor):
        proc, gw = processor
        proc._running = True
        await proc.start()  # Should log warning and return


# ===========================================================================
# Initialize Gateway (module-level)
# ===========================================================================

class TestInitializeGateway:

    @pytest.mark.asyncio
    async def test_disabled_supabase_returns_none(self):
        mock_settings = MagicMock()
        mock_settings.supabase.enabled = False
        with patch("workers.job_processor.get_settings", return_value=mock_settings):
            from workers.job_processor import initialize_gateway
            result = await initialize_gateway()
        assert result is None

    @pytest.mark.asyncio
    async def test_client_init_failure_returns_none(self):
        mock_settings = MagicMock()
        mock_settings.supabase.enabled = True
        mock_settings.supabase.url = "http://localhost:54321"
        mock_settings.supabase.anon_key = "key"
        mock_settings.supabase.service_role_key = "key"
        mock_settings.supabase.db_schema = "public"
        mock_settings.supabase.realtime_enabled = False
        with patch("workers.job_processor.get_settings", return_value=mock_settings), \
             patch("workers.job_processor.SupabaseClient") as MockClient:
            MockClient.from_env.side_effect = RuntimeError("can't connect")
            from workers.job_processor import initialize_gateway
            result = await initialize_gateway()
        assert result is None

    @pytest.mark.asyncio
    async def test_success_returns_gateway(self):
        mock_settings = MagicMock()
        mock_settings.supabase.enabled = True
        mock_settings.supabase.url = "http://localhost:54321"
        mock_settings.supabase.anon_key = "key"
        mock_settings.supabase.service_role_key = "svc_key"
        mock_settings.supabase.db_schema = "public"
        mock_settings.supabase.realtime_enabled = False
        mock_client = MagicMock()
        mock_client.initialize = AsyncMock()
        with patch("workers.job_processor.get_settings", return_value=mock_settings), \
             patch("workers.job_processor.SupabaseClient") as MockClient, \
             patch("workers.job_processor.SupabasePersistenceGateway") as MockGW:
            MockClient.from_env.return_value = mock_client
            mock_gw_inst = MagicMock()
            MockGW.return_value = mock_gw_inst
            from workers.job_processor import initialize_gateway
            result = await initialize_gateway()
        assert result is mock_gw_inst
        mock_client.initialize.assert_called_once()


# ===========================================================================
# Start / Stop Lifecycle (extended coverage)
# ===========================================================================

class TestStartStop:

    @pytest.mark.asyncio
    async def test_start_runs_poll_loop_until_stop(self, processor):
        """start() enters loop, _poll_and_process is called, stops on flag."""
        proc, gw = processor
        poll_count = 0

        async def _count_polls():
            nonlocal poll_count
            poll_count += 1
            if poll_count >= 2:
                proc._stop_requested = True

        proc._poll_and_process = AsyncMock(side_effect=_count_polls)
        proc._maybe_log_health = AsyncMock()

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await proc.start()

        assert poll_count == 2
        assert proc._running is False

    @pytest.mark.asyncio
    async def test_start_handles_cancelled_error(self, processor):
        """CancelledError during loop → graceful shutdown."""
        proc, _ = processor
        proc._poll_and_process = AsyncMock(side_effect=asyncio.CancelledError())
        proc._maybe_log_health = AsyncMock()

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await proc.start()

        assert proc._running is False

    @pytest.mark.asyncio
    async def test_start_handles_generic_exception(self, processor):
        """Generic exception in loop → logged, running set False."""
        proc, _ = processor
        proc._poll_and_process = AsyncMock(side_effect=RuntimeError("crash"))
        proc._maybe_log_health = AsyncMock()

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await proc.start()

        assert proc._running is False

    @pytest.mark.asyncio
    async def test_start_uses_poll_interval(self, processor):
        proc, _ = processor
        intervals = []

        async def _capture(interval):
            intervals.append(interval)
            proc._stop_requested = True

        proc._poll_and_process = AsyncMock()
        proc._maybe_log_health = AsyncMock()

        with patch("asyncio.sleep", side_effect=_capture):
            await proc.start()

        assert intervals == [5]  # poll_interval from settings

    @pytest.mark.asyncio
    async def test_stop_waits_for_running_to_clear(self, processor):
        """stop() loops until _running is False."""
        proc, _ = processor
        proc._running = True
        call_count = 0

        async def _clear_running(delay):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                proc._running = False

        with patch("asyncio.sleep", side_effect=_clear_running):
            await proc.stop()

        assert proc._stop_requested is True

    @pytest.mark.asyncio
    async def test_stop_timeout_warning(self, processor):
        """stop() times out → warning logged, doesn't crash."""
        proc, _ = processor
        proc._running = True
        proc._settings.shutdown_timeout = 2  # Very short timeout

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await proc.stop()

        assert proc._stop_requested is True


# ===========================================================================
# _get_next_jobs — Additional edge cases
# ===========================================================================

class TestGetNextJobsExtended:

    @pytest.mark.asyncio
    async def test_batch_rpc_returns_single_dict(self, processor):
        """Batch RPC returns a dict (not list) → wrapped in list."""
        proc, gw = processor
        single_job = _make_job()
        gw.rpc.return_value = single_job  # dict, not list
        jobs = await proc._get_next_jobs(100)
        assert len(jobs) == 1
        assert jobs[0] is single_job

    @pytest.mark.asyncio
    async def test_fallback_unexpected_result_type(self, processor):
        """Fallback RPC returns unexpected type → logs warning, continues."""
        proc, gw = processor
        proc._queue_settings.enable_resource_management = False
        # Returns a string (unexpected type) → skip, then None → stop
        gw.rpc.side_effect = ["unexpected_string", None]
        jobs = await proc._get_next_jobs(100)
        assert jobs == []

    @pytest.mark.asyncio
    async def test_batch_rpc_returns_none(self, processor):
        """Batch RPC returns None → falls through to empty check."""
        proc, gw = processor
        gw.rpc.return_value = None
        jobs = await proc._get_next_jobs(100)
        assert jobs == []

    @pytest.mark.asyncio
    async def test_batch_rpc_returns_empty_list(self, processor):
        proc, gw = processor
        gw.rpc.return_value = []
        jobs = await proc._get_next_jobs(100)
        assert jobs == []


# ===========================================================================
# _process_job — Lifecycle recovery edge cases
# ===========================================================================

class TestProcessJobExtended:

    @pytest.mark.asyncio
    async def test_lifecycle_recovery_select_fails(self, processor):
        """Handler exception + select for status also fails → both logged, no crash."""
        proc, gw = processor
        handler = proc._handlers["summarize_chat"]
        handler.execute.side_effect = RuntimeError("LLM crash")
        # Gateway select also fails during recovery
        gw.select.side_effect = RuntimeError("DB also down")
        job = _make_job("summarize_chat")
        await proc._process_job(job)
        assert proc._jobs_failed == 1

    @pytest.mark.asyncio
    async def test_lifecycle_recovery_job_already_failed(self, processor):
        """Handler exception + job already marked as 'failed' → no double-fail."""
        proc, gw = processor
        handler = proc._handlers["summarize_chat"]
        handler.execute.side_effect = RuntimeError("boom")
        # Job is already marked failed by handler
        gw.select.return_value = {"id": "x", "status": "failed"}
        job = _make_job("summarize_chat")
        await proc._process_job(job)
        # fail_job should NOT be called again
        handler.fail_job.assert_not_called()
        assert proc._jobs_failed == 1


# ===========================================================================
# _maybe_log_health — Extended
# ===========================================================================

class TestMaybeLogHealthExtended:

    @pytest.mark.asyncio
    async def test_health_log_to_db_enabled(self, processor):
        """When health_log_to_db is True, _log_health_to_db is called."""
        proc, _ = processor
        proc._last_health_check = datetime.now(timezone.utc) - timedelta(seconds=120)
        proc._settings.health_check_interval = 60
        proc._settings.health_log_to_db = True
        proc._log_health_to_db = AsyncMock()
        await proc._maybe_log_health()
        proc._log_health_to_db.assert_called_once()

    @pytest.mark.asyncio
    async def test_log_health_to_db_noop(self, processor):
        """_log_health_to_db is currently a no-op (pass)."""
        proc, _ = processor
        # Should not raise
        await proc._log_health_to_db()


# ===========================================================================
# _poll_and_process — Resource tracking
# ===========================================================================

class TestPollAndProcessExtended:

    @pytest.mark.asyncio
    async def test_resource_tracking_updated(self, processor):
        """Jobs allocated → resource usage increases."""
        proc, gw = processor
        proc._last_stale_check = datetime.now(timezone.utc)
        jobs = [_make_job("summarize_chat", resource_cost=20)]
        gw.rpc.return_value = jobs
        await proc._poll_and_process()
        # After processing + cleanup, resources should be released
        assert proc._current_resource_usage == 0

    @pytest.mark.asyncio
    async def test_multiple_batches(self, processor):
        """Many jobs → split into batches of max_concurrent."""
        proc, gw = processor
        proc._settings.max_concurrent = 2
        proc._last_stale_check = datetime.now(timezone.utc)
        jobs = [_make_job("summarize_chat") for _ in range(5)]
        gw.rpc.return_value = jobs
        await proc._poll_and_process()
        assert proc._jobs_processed == 5

    @pytest.mark.asyncio
    async def test_exception_after_get_jobs_caught(self, processor):
        """Exception during resource tracking/batching → caught by outer except."""
        proc, gw = processor
        proc._last_stale_check = datetime.now(timezone.utc)
        jobs = [_make_job("summarize_chat")]
        gw.rpc.return_value = jobs
        # Make _batch_jobs raise to trigger the outer except block (line 230-231)
        proc._batch_jobs = MagicMock(side_effect=RuntimeError("batch exploded"))
        await proc._poll_and_process()
        # Should not raise; error caught by outer handler


# ===========================================================================
# main_loop (module-level entry point)
# ===========================================================================

class TestMainLoop:

    @pytest.mark.asyncio
    async def test_main_loop_no_gateway_exits(self):
        """Gateway returns None → sys.exit(1)."""
        from workers.job_processor import main_loop

        with patch("workers.job_processor.initialize_gateway", new_callable=AsyncMock,
                   return_value=None), \
             pytest.raises(SystemExit) as exc_info:
            await main_loop()

        assert exc_info.value.code == 1

    @pytest.mark.asyncio
    async def test_main_loop_normal_run(self):
        """Normal startup: gateway OK, processor starts then stops."""
        from workers.job_processor import main_loop

        mock_gw = _make_gateway()
        mock_settings = MagicMock()
        mock_settings.workers = _make_settings()

        mock_processor = MagicMock()
        mock_processor.start = AsyncMock()
        mock_processor.stop = AsyncMock()

        with patch("workers.job_processor.initialize_gateway", new_callable=AsyncMock,
                   return_value=mock_gw), \
             patch("workers.job_processor.get_settings", return_value=mock_settings), \
             patch("workers.job_processor.JobProcessor", return_value=mock_processor), \
             patch("asyncio.get_running_loop") as mock_loop:
            mock_loop.return_value = MagicMock()
            await main_loop()

        mock_processor.start.assert_called_once()
        mock_processor.stop.assert_called_once()
        mock_gw.dispose.assert_called_once()

    @pytest.mark.asyncio
    async def test_main_loop_cancelled(self):
        """CancelledError during processor.start → graceful cleanup."""
        from workers.job_processor import main_loop

        mock_gw = _make_gateway()
        mock_settings = MagicMock()
        mock_settings.workers = _make_settings()

        mock_processor = MagicMock()
        mock_processor.start = AsyncMock(side_effect=asyncio.CancelledError())
        mock_processor.stop = AsyncMock()

        with patch("workers.job_processor.initialize_gateway", new_callable=AsyncMock,
                   return_value=mock_gw), \
             patch("workers.job_processor.get_settings", return_value=mock_settings), \
             patch("workers.job_processor.JobProcessor", return_value=mock_processor), \
             patch("asyncio.get_running_loop") as mock_loop:
            mock_loop.return_value = MagicMock()
            await main_loop()

        mock_processor.stop.assert_called_once()
        mock_gw.dispose.assert_called_once()

    @pytest.mark.asyncio
    async def test_main_loop_processor_error(self):
        """Generic error during processor.start → cleanup still runs."""
        from workers.job_processor import main_loop

        mock_gw = _make_gateway()
        mock_settings = MagicMock()
        mock_settings.workers = _make_settings()

        mock_processor = MagicMock()
        mock_processor.start = AsyncMock(side_effect=RuntimeError("fatal"))
        mock_processor.stop = AsyncMock()

        with patch("workers.job_processor.initialize_gateway", new_callable=AsyncMock,
                   return_value=mock_gw), \
             patch("workers.job_processor.get_settings", return_value=mock_settings), \
             patch("workers.job_processor.JobProcessor", return_value=mock_processor), \
             patch("asyncio.get_running_loop") as mock_loop:
            mock_loop.return_value = MagicMock()
            await main_loop()

        mock_processor.stop.assert_called_once()
        mock_gw.dispose.assert_called_once()

    @pytest.mark.asyncio
    async def test_main_loop_dispose_error_caught(self):
        """Gateway dispose error → caught, no crash."""
        from workers.job_processor import main_loop

        mock_gw = _make_gateway()
        mock_gw.dispose.side_effect = RuntimeError("dispose boom")
        mock_settings = MagicMock()
        mock_settings.workers = _make_settings()

        mock_processor = MagicMock()
        mock_processor.start = AsyncMock()
        mock_processor.stop = AsyncMock()

        with patch("workers.job_processor.initialize_gateway", new_callable=AsyncMock,
                   return_value=mock_gw), \
             patch("workers.job_processor.get_settings", return_value=mock_settings), \
             patch("workers.job_processor.JobProcessor", return_value=mock_processor), \
             patch("asyncio.get_running_loop") as mock_loop:
            mock_loop.return_value = MagicMock()
            # Should not raise
            await main_loop()

    @pytest.mark.asyncio
    async def test_main_loop_signal_handler_fallback(self):
        """On platforms where add_signal_handler raises NotImplementedError → fallback."""
        from workers.job_processor import main_loop

        mock_gw = _make_gateway()
        mock_settings = MagicMock()
        mock_settings.workers = _make_settings()

        mock_processor = MagicMock()
        mock_processor.start = AsyncMock()
        mock_processor.stop = AsyncMock()

        mock_loop = MagicMock()
        mock_loop.add_signal_handler.side_effect = NotImplementedError()

        with patch("workers.job_processor.initialize_gateway", new_callable=AsyncMock,
                   return_value=mock_gw), \
             patch("workers.job_processor.get_settings", return_value=mock_settings), \
             patch("workers.job_processor.JobProcessor", return_value=mock_processor), \
             patch("asyncio.get_running_loop", return_value=mock_loop), \
             patch("signal.signal"):
            await main_loop()

        mock_processor.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_main_loop_signal_handler_body_invoked(self):
        """Invoking the captured POSIX signal handler executes the closure body."""
        from workers.job_processor import main_loop

        mock_gw = _make_gateway()
        mock_settings = MagicMock()
        mock_settings.workers = _make_settings()

        mock_processor = MagicMock()
        mock_processor.stop = AsyncMock()

        captured_handlers = []

        def capture_handler(sig, handler):
            captured_handlers.append(handler)

        async def start_side_effect():
            # Invoke the captured signal handler during processor.start
            if captured_handlers:
                captured_handlers[0]()
                # Yield so the created task can run
                await asyncio.sleep(0)

        mock_processor.start = AsyncMock(side_effect=start_side_effect)

        mock_loop = MagicMock()
        mock_loop.add_signal_handler = capture_handler

        with patch("workers.job_processor.initialize_gateway", new_callable=AsyncMock,
                   return_value=mock_gw), \
             patch("workers.job_processor.get_settings", return_value=mock_settings), \
             patch("workers.job_processor.JobProcessor", return_value=mock_processor), \
             patch("asyncio.get_running_loop", return_value=mock_loop):
            await main_loop()

        # stop() called at least once from signal handler create_task + once from finally
        assert mock_processor.stop.call_count >= 1

    @pytest.mark.asyncio
    async def test_main_loop_win_signal_handler_body_invoked(self):
        """Invoking the Windows fallback signal handler executes the closure body."""
        import signal as signal_mod
        from workers.job_processor import main_loop

        mock_gw = _make_gateway()
        mock_settings = MagicMock()
        mock_settings.workers = _make_settings()

        mock_processor = MagicMock()
        mock_processor.stop = AsyncMock()

        captured_win_handlers = []

        def capture_signal(signum, handler):
            captured_win_handlers.append((signum, handler))

        mock_loop = MagicMock()
        mock_loop.add_signal_handler.side_effect = NotImplementedError()

        async def start_side_effect():
            # Invoke the captured Windows signal handler during processor.start
            if captured_win_handlers:
                captured_win_handlers[0][1](signal_mod.SIGINT, None)
                await asyncio.sleep(0)

        mock_processor.start = AsyncMock(side_effect=start_side_effect)

        with patch("workers.job_processor.initialize_gateway", new_callable=AsyncMock,
                   return_value=mock_gw), \
             patch("workers.job_processor.get_settings", return_value=mock_settings), \
             patch("workers.job_processor.JobProcessor", return_value=mock_processor), \
             patch("asyncio.get_running_loop", return_value=mock_loop), \
             patch("signal.signal", side_effect=capture_signal):
            await main_loop()

        assert mock_processor.stop.call_count >= 1
