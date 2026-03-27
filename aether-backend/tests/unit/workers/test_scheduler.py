"""
Tests for workers/scheduler.py

Covers: AgentScheduler lifecycle (start, shutdown, get_status),
module-level helpers (get_scheduler, start_scheduler, shutdown_scheduler),
and scheduler state transitions.

All APScheduler and gateway calls mocked.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from data.database.persistence_gateway import SupabasePersistenceGateway


def _make_gateway():
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.insert = AsyncMock(return_value=[{"id": "job-uuid-001"}])
    return gw


def _make_settings():
    """Create minimal settings mock matching config.settings structure."""
    settings = MagicMock()
    settings.proactive = MagicMock()
    return settings


@pytest.fixture
def scheduler():
    from workers.scheduler import AgentScheduler
    gw = _make_gateway()
    sched = AgentScheduler(gw)
    return sched, gw


# ===========================================================================
# Constructor Tests
# ===========================================================================

class TestConstructor:

    def test_init_sets_gateway(self, scheduler):
        sched, gw = scheduler
        assert sched.gateway is gw

    def test_init_not_running(self, scheduler):
        sched, _ = scheduler
        assert sched._running is False

    def test_init_scheduler_none(self, scheduler):
        sched, _ = scheduler
        assert sched.scheduler is None


# ===========================================================================
# Start Tests
# ===========================================================================

class TestStart:

    @pytest.mark.asyncio
    async def test_start_creates_scheduler(self, scheduler):
        sched, _ = scheduler
        with patch("workers.scheduler.get_settings", return_value=_make_settings()):
            await sched.start()
        assert sched._running is True
        assert sched.scheduler is not None

    @pytest.mark.asyncio
    async def test_start_registers_zero_jobs(self, scheduler):
        sched, _ = scheduler
        with patch("workers.scheduler.get_settings", return_value=_make_settings()):
            await sched.start()
        jobs = sched.scheduler.get_jobs()
        assert len(jobs) == 0

    @pytest.mark.asyncio
    async def test_start_idempotent(self, scheduler):
        """Calling start twice does not re-create scheduler."""
        sched, _ = scheduler
        with patch("workers.scheduler.get_settings", return_value=_make_settings()):
            await sched.start()
            original = sched.scheduler
            await sched.start()  # second call
        assert sched.scheduler is original


# ===========================================================================
# Shutdown Tests
# ===========================================================================

class TestShutdown:

    @pytest.mark.asyncio
    async def test_shutdown_after_start(self, scheduler):
        sched, _ = scheduler
        with patch("workers.scheduler.get_settings", return_value=_make_settings()):
            await sched.start()
        await sched.shutdown()
        assert sched._running is False

    @pytest.mark.asyncio
    async def test_shutdown_before_start_noop(self, scheduler):
        sched, _ = scheduler
        await sched.shutdown()  # should not raise
        assert sched._running is False


# ===========================================================================
# Get Status Tests
# ===========================================================================

class TestGetStatus:

    def test_status_when_not_running(self, scheduler):
        sched, _ = scheduler
        status = sched.get_status()
        assert status["running"] is False
        assert status["jobs"] == []

    @pytest.mark.asyncio
    async def test_status_when_running(self, scheduler):
        sched, _ = scheduler
        with patch("workers.scheduler.get_settings", return_value=_make_settings()):
            await sched.start()
        status = sched.get_status()
        assert status["running"] is True
        assert len(status["jobs"]) == 0
        assert "timezone" in status


# ===========================================================================
# Module-Level Helper Tests
# ===========================================================================

class TestModuleLevelHelpers:

    @pytest.mark.asyncio
    async def test_get_scheduler_creates_singleton(self):
        import workers.scheduler as mod
        mod._scheduler = None  # reset global
        gw = _make_gateway()
        s1 = await mod.get_scheduler(gw)
        s2 = await mod.get_scheduler(gw)
        assert s1 is s2
        mod._scheduler = None  # cleanup

    @pytest.mark.asyncio
    async def test_start_scheduler_starts(self):
        import workers.scheduler as mod
        mod._scheduler = None
        gw = _make_gateway()
        with patch("workers.scheduler.get_settings", return_value=_make_settings()):
            await mod.start_scheduler(gw)
        assert mod._scheduler is not None
        assert mod._scheduler._running is True
        await mod.shutdown_scheduler()
        mod._scheduler = None

    @pytest.mark.asyncio
    async def test_shutdown_scheduler_global(self):
        import workers.scheduler as mod
        mod._scheduler = None
        gw = _make_gateway()
        with patch("workers.scheduler.get_settings", return_value=_make_settings()):
            await mod.start_scheduler(gw)
        await mod.shutdown_scheduler()
        assert mod._scheduler._running is False
        mod._scheduler = None

    @pytest.mark.asyncio
    async def test_shutdown_when_no_scheduler_noop(self):
        import workers.scheduler as mod
        mod._scheduler = None
        await mod.shutdown_scheduler()  # should not raise
