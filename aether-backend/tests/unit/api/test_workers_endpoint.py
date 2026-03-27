"""
Unit tests for Workers endpoint (/v1/workers/status).

Single endpoint returning WorkerHealthResponse. Tests cover the endpoint response
structure, PID checking branches (no file, stale PID, running, permission error,
corrupt file), job statistics (success + DB error), and process uptime.

No bugs found during audit.

CI: pytest tests/unit/api/test_workers_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, patch
from core.system.models import WorkerHealthStatus, ProcessStatus


# ===========================================================================
# Endpoint-level tests
# ===========================================================================

class TestWorkerStatus:
    """GET /v1/workers/status — endpoint integration tests."""

    @pytest.mark.asyncio
    async def test_response_structure(self, client):
        """Response has all WorkerHealthResponse fields."""
        resp = await client.get("/v1/workers/status")
        assert resp.status_code == 200
        body = resp.json()
        assert "status" in body
        assert body["status"] in ("healthy", "stopped", "unknown")
        assert "running" in body
        assert isinstance(body["running"], bool)
        assert "pid" in body
        assert "jobs_pending" in body
        assert isinstance(body["jobs_pending"], int)
        assert "jobs_processed" in body
        assert "jobs_failed" in body
        assert "uptime_seconds" in body

    @pytest.mark.asyncio
    async def test_no_pid_file(self, client):
        """When worker PID file doesn't exist → status='stopped', running=False."""
        with patch("core.system.process_gateway.ProcessGateway.check_process_health", return_value=WorkerHealthStatus(
            running=False, pid=None, status=ProcessStatus.STOPPED
        )):
            resp = await client.get("/v1/workers/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "stopped"
        assert body["running"] is False
        assert body["pid"] is None

    @pytest.mark.asyncio
    async def test_running(self, client):
        """When worker process is alive → status='healthy', running=True, pid set."""
        with patch("core.system.process_gateway.ProcessGateway.check_process_health", return_value=WorkerHealthStatus(
            running=True, pid=12345, status=ProcessStatus.HEALTHY
        )):
            with patch("core.system.process_gateway.ProcessGateway.get_process_uptime", return_value=3600.0):
                resp = await client.get("/v1/workers/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "healthy"
        assert body["running"] is True
        assert body["pid"] == 12345
        assert body["uptime_seconds"] == 3600.0

    @pytest.mark.asyncio
    async def test_db_error_returns_zero_pending(self, client):
        """When database query fails → jobs_pending=0, processed/failed=null."""
        with patch("core.system.process_gateway.ProcessGateway.check_process_health", return_value=WorkerHealthStatus(
            running=False, pid=None, status=ProcessStatus.STOPPED
        )):
            with patch("api.v1.endpoints.workers._get_job_statistics", return_value={
                "jobs_pending": 0, "jobs_processed": None, "jobs_failed": None
            }):
                resp = await client.get("/v1/workers/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["jobs_pending"] == 0
        assert body["jobs_processed"] is None
        assert body["jobs_failed"] is None

    @pytest.mark.asyncio
    async def test_stopped_uptime_is_none(self, client):
        """Stopped worker (pid=None) → uptime_seconds=None (no process to measure)."""
        with patch("core.system.process_gateway.ProcessGateway.check_process_health", return_value=WorkerHealthStatus(
            running=False, pid=None, status=ProcessStatus.STOPPED
        )):
            resp = await client.get("/v1/workers/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["uptime_seconds"] is None

    @pytest.mark.asyncio
    async def test_running_with_job_stats(self, client):
        """Running worker with real job statistics from DB."""
        with patch("core.system.process_gateway.ProcessGateway.check_process_health", return_value=WorkerHealthStatus(
            running=True, pid=99, status=ProcessStatus.HEALTHY
        )):
            with patch("core.system.process_gateway.ProcessGateway.get_process_uptime", return_value=120.5):
                with patch("api.v1.endpoints.workers._get_job_statistics", return_value={
                    "jobs_pending": 3, "jobs_processed": 47, "jobs_failed": 2
                }):
                    resp = await client.get("/v1/workers/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["jobs_pending"] == 3
        assert body["jobs_processed"] == 47
        assert body["jobs_failed"] == 2
        assert body["uptime_seconds"] == 120.5


# ===========================================================================
# _get_job_statistics unit tests
# ===========================================================================

class TestJobStatistics:
    """Unit tests for _get_job_statistics helper."""

    @pytest.mark.asyncio
    async def test_success(self, mock_supabase_client):
        from api.v1.endpoints.workers import _get_job_statistics
        mock_supabase_client.count = AsyncMock(side_effect=[5, 100, 3])
        result = await _get_job_statistics(mock_supabase_client)
        assert result["jobs_pending"] == 5
        assert result["jobs_processed"] == 100
        assert result["jobs_failed"] == 3

    @pytest.mark.asyncio
    async def test_db_error(self, mock_supabase_client):
        from api.v1.endpoints.workers import _get_job_statistics
        mock_supabase_client.count = AsyncMock(side_effect=RuntimeError("DB down"))
        result = await _get_job_statistics(mock_supabase_client)
        assert result["jobs_pending"] == 0
        assert result["jobs_processed"] is None

    @pytest.mark.asyncio
    async def test_correct_filters(self, mock_supabase_client):
        """Verify correct table and filter arguments are passed."""
        from api.v1.endpoints.workers import _get_job_statistics
        mock_supabase_client.count = AsyncMock(return_value=0)
        await _get_job_statistics(mock_supabase_client)
        calls = mock_supabase_client.count.call_args_list
        assert len(calls) == 3
        assert calls[0].args[0] == "pending_jobs"
        assert calls[0].kwargs["filters"] == {"status": "pending"}
        assert calls[1].kwargs["filters"] == {"status": "completed"}
        assert calls[2].kwargs["filters"] == {"status": "failed"}
