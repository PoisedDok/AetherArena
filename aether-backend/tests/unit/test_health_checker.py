"""
Unit Tests: Health Checker — monitoring/health.py

Adversarial coverage of all 6 health checker classes, the initialize factory,
and psutil-dependent system checks.  Every test either FINDS a bug or PREVENTS
a regression — no truthiness assertions.

Coverage targets: monitoring/health.py lines 71, 89-107, 131-161, 181-199,
218-260, 274-291, 304-337, 350-387, 400-510, 523-549, 594-611.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

from monitoring.health import (
    HealthChecker,
    HealthCheckResult,
    HealthStatus,
    RuntimeHealthChecker,
    IntegrationHealthChecker,
    DatabaseHealthChecker,
    MCPHealthChecker,
    RedisComponentHealthChecker,
    CacheHealthChecker,
    initialize_health_checks,
    get_health_checker,
)


# =============================================================================
# HealthChecker core
# =============================================================================


class TestHealthCheckerCore:
    """Core HealthChecker orchestration tests."""

    @pytest.fixture(autouse=True)
    def _reset_global(self):
        """Reset the module-level singleton between tests."""
        import monitoring.health as _mod
        _mod._global_health_checker = None
        yield
        _mod._global_health_checker = None

    @pytest.fixture
    def checker(self):
        return HealthChecker()

    # -- register & check_all happy path ------------------------------------

    @pytest.mark.asyncio
    async def test_check_all_happy_with_two_checkers(self, checker):
        """Two registered checkers both healthy — overall HEALTHY."""
        mock_a = AsyncMock()
        mock_a.check_health.return_value = {"healthy": True, "message": "A ok"}
        mock_b = AsyncMock()
        mock_b.check_health.return_value = {"healthy": True, "message": "B ok"}

        checker.register_checker("comp_a", mock_a)
        checker.register_checker("comp_b", mock_b)

        # Mock psutil so system check doesn't interfere
        with patch("monitoring.health.psutil") as mp:
            mp.virtual_memory.return_value = MagicMock(total=16e9, available=8e9, percent=50.0)
            mp.disk_usage.return_value = MagicMock(total=500e9, free=250e9, percent=50.0)
            mp.cpu_percent.return_value = 20.0
            mp.cpu_count.return_value = 8
            result = await checker.check_all()

        assert result["status"] == "healthy"
        assert isinstance(result["timestamp"], str)
        assert result["timestamp"].endswith("Z")
        assert isinstance(result["uptime_seconds"], float)
        assert isinstance(result["check_duration_ms"], float)
        assert result["check_duration_ms"] >= 0

        # Must have system + 2 registered = 3 components
        components = result["components"]
        assert len(components) == 3
        names = [c["component"] for c in components]
        assert "system" in names
        assert "comp_a" in names
        assert "comp_b" in names

        # Each component dict must have the required keys
        for comp in components:
            assert "component" in comp
            assert "status" in comp
            assert "message" in comp
            assert "details" in comp
            assert "response_time_ms" in comp
            assert "timestamp" in comp

    # -- check_all with one failing checker ---------------------------------

    @pytest.mark.asyncio
    async def test_check_all_one_checker_raises(self, checker):
        """One checker raises Exception — that component UNHEALTHY, overall UNHEALTHY."""
        ok_checker = AsyncMock()
        ok_checker.check_health.return_value = {"healthy": True, "message": "fine"}
        bad_checker = AsyncMock()
        bad_checker.check_health.side_effect = RuntimeError("db gone")

        checker.register_checker("good", ok_checker)
        checker.register_checker("bad", bad_checker)

        result = await checker.check_all()

        assert result["status"] == "unhealthy"
        bad_comp = next(c for c in result["components"] if c["component"] == "bad")
        assert bad_comp["status"] == "unhealthy"
        assert "db gone" in bad_comp["message"]
        assert bad_comp["details"]["error"] == "db gone"

    # -- check_all with checker returning unhealthy -------------------------

    @pytest.mark.asyncio
    async def test_check_all_checker_returns_unhealthy(self, checker):
        """Checker returns healthy=False — component is UNHEALTHY."""
        mock_c = AsyncMock()
        mock_c.check_health.return_value = {"healthy": False, "message": "out of space"}

        checker.register_checker("disk", mock_c)
        result = await checker.check_all()

        assert result["status"] == "unhealthy"
        disk = next(c for c in result["components"] if c["component"] == "disk")
        assert disk["status"] == "unhealthy"

    # -- check_all aggregation failure (fallback path) ----------------------

    @pytest.mark.asyncio
    async def test_check_all_aggregation_failure(self, checker):
        """If _aggregate_status itself raises, fallback response returned."""
        with patch.object(checker, "_aggregate_status", side_effect=TypeError("boom")):
            result = await checker.check_all()

        assert result["status"] == "unhealthy"
        assert isinstance(result["components"], list)
        assert len(result["components"]) >= 1
        # Must contain health_checker error component
        hc_err = next(
            (c for c in result["components"] if c["component"] == "health_checker"),
            None,
        )
        assert hc_err is not None
        assert "boom" in hc_err["message"]

    # -- check_component ----------------------------------------------------

    @pytest.mark.asyncio
    async def test_check_component_system(self, checker):
        """check_component('system') returns system metrics with exact structure."""
        with patch("monitoring.health.psutil") as mock_psutil:
            mem = MagicMock()
            mem.total = 16 * 1024**3
            mem.available = 8 * 1024**3
            mem.percent = 50.0
            mock_psutil.virtual_memory.return_value = mem

            disk = MagicMock()
            disk.total = 500 * 1024**3
            disk.free = 250 * 1024**3
            disk.percent = 50.0
            mock_psutil.disk_usage.return_value = disk

            mock_psutil.cpu_percent.return_value = 25.0
            mock_psutil.cpu_count.return_value = 8

            result = await checker.check_component("system")

        assert result.component == "system"
        assert result.status == HealthStatus.HEALTHY
        assert "healthy" in result.message.lower()
        d = result.details
        assert d["platform"] is not None
        assert d["cpu"]["percent"] == 25.0
        assert d["cpu"]["count"] == 8
        assert d["memory"]["percent_used"] == 50.0
        assert d["disk"]["percent_used"] == 50.0

    @pytest.mark.asyncio
    async def test_check_component_unknown(self, checker):
        """Unknown component returns None."""
        result = await checker.check_component("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_check_component_registered(self, checker):
        """Registered component returns correct result."""
        mock_c = AsyncMock()
        mock_c.check_health.return_value = {"healthy": True, "message": "redis ok"}
        checker.register_checker("redis", mock_c)

        result = await checker.check_component("redis")
        assert result.component == "redis"
        assert result.status == HealthStatus.HEALTHY
        assert isinstance(result.response_time_ms, float)

    @pytest.mark.asyncio
    async def test_check_component_registered_raises(self, checker):
        """Registered component that raises returns UNHEALTHY result."""
        mock_c = AsyncMock()
        mock_c.check_health.side_effect = ConnectionError("refused")
        checker.register_checker("service", mock_c)

        result = await checker.check_component("service")
        assert result.component == "service"
        assert result.status == HealthStatus.UNHEALTHY
        assert "refused" in result.message

    # -- _aggregate_status --------------------------------------------------

    def test_aggregate_all_healthy(self, checker):
        results = [
            HealthCheckResult(component="a", status=HealthStatus.HEALTHY, message="ok"),
            HealthCheckResult(component="b", status=HealthStatus.HEALTHY, message="ok"),
        ]
        assert checker._aggregate_status(results) == HealthStatus.HEALTHY

    def test_aggregate_one_degraded(self, checker):
        results = [
            HealthCheckResult(component="a", status=HealthStatus.HEALTHY, message="ok"),
            HealthCheckResult(component="b", status=HealthStatus.DEGRADED, message="slow"),
        ]
        assert checker._aggregate_status(results) == HealthStatus.DEGRADED

    def test_aggregate_one_unhealthy(self, checker):
        results = [
            HealthCheckResult(component="a", status=HealthStatus.HEALTHY, message="ok"),
            HealthCheckResult(component="b", status=HealthStatus.UNHEALTHY, message="dead"),
        ]
        assert checker._aggregate_status(results) == HealthStatus.UNHEALTHY

    def test_aggregate_empty(self, checker):
        assert checker._aggregate_status([]) == HealthStatus.UNKNOWN

    def test_aggregate_unhealthy_beats_degraded(self, checker):
        results = [
            HealthCheckResult(component="a", status=HealthStatus.DEGRADED, message="slow"),
            HealthCheckResult(component="b", status=HealthStatus.UNHEALTHY, message="dead"),
        ]
        assert checker._aggregate_status(results) == HealthStatus.UNHEALTHY

    # -- get_uptime ---------------------------------------------------------

    def test_get_uptime(self, checker):
        uptime = checker.get_uptime()
        assert isinstance(uptime, float)
        assert uptime >= 0

    # -- psutil degraded scenarios ------------------------------------------

    @pytest.mark.asyncio
    async def test_system_high_memory(self, checker):
        """Memory > 90% triggers DEGRADED."""
        with patch("monitoring.health.psutil") as mock_psutil:
            mem = MagicMock(total=16e9, available=1e9, percent=93.0)
            mock_psutil.virtual_memory.return_value = mem
            mock_psutil.disk_usage.return_value = MagicMock(
                total=500e9, free=250e9, percent=50.0
            )
            mock_psutil.cpu_percent.return_value = 10.0
            mock_psutil.cpu_count.return_value = 4

            result = await checker._check_system()

        assert result.status == HealthStatus.DEGRADED
        assert "memory" in result.message.lower()

    @pytest.mark.asyncio
    async def test_system_high_disk(self, checker):
        """Disk > 90% triggers DEGRADED."""
        with patch("monitoring.health.psutil") as mock_psutil:
            mock_psutil.virtual_memory.return_value = MagicMock(
                total=16e9, available=8e9, percent=50.0
            )
            mock_psutil.disk_usage.return_value = MagicMock(
                total=500e9, free=20e9, percent=96.0
            )
            mock_psutil.cpu_percent.return_value = 10.0
            mock_psutil.cpu_count.return_value = 4

            result = await checker._check_system()

        assert result.status == HealthStatus.DEGRADED
        assert "disk" in result.message.lower()

    @pytest.mark.asyncio
    async def test_system_high_cpu(self, checker):
        """CPU > 90% triggers DEGRADED."""
        with patch("monitoring.health.psutil") as mock_psutil:
            mock_psutil.virtual_memory.return_value = MagicMock(
                total=16e9, available=8e9, percent=50.0
            )
            mock_psutil.disk_usage.return_value = MagicMock(
                total=500e9, free=250e9, percent=50.0
            )
            mock_psutil.cpu_percent.return_value = 95.0
            mock_psutil.cpu_count.return_value = 4

            result = await checker._check_system()

        assert result.status == HealthStatus.DEGRADED
        assert "cpu" in result.message.lower()

    @pytest.mark.asyncio
    async def test_system_check_exception(self, checker):
        """psutil failure returns UNKNOWN status."""
        with patch("monitoring.health.psutil") as mock_psutil:
            mock_psutil.virtual_memory.side_effect = OSError("permission denied")

            result = await checker._check_system()

        assert result.status == HealthStatus.UNKNOWN
        assert "permission denied" in result.message


# =============================================================================
# RuntimeHealthChecker
# =============================================================================


class TestRuntimeHealthChecker:

    @pytest.mark.asyncio
    async def test_runtime_healthy_with_coordinator(self):
        """Healthy runtime: _initialized=True, coordinator returns module info."""
        coordinator = MagicMock()
        coordinator.get_health_status.return_value = {
            "runtime": {"initialized": True, "startup_complete": True, "module_count": 4},
            "modules": {
                "interpreter_adapter": {"available": True},
                "session_manager": {"available": True},
            },
        }
        runtime = MagicMock()
        runtime._initialized = True
        runtime.coordinator = coordinator

        result = await RuntimeHealthChecker(runtime).check_health()

        assert result["healthy"] is True
        assert result["message"] == "Runtime healthy"
        assert result["interpreter_loaded"] is True
        assert result["module_count"] == 4
        assert result["startup_complete"] is True

    @pytest.mark.asyncio
    async def test_runtime_healthy_no_interpreter(self):
        """Healthy but interpreter_adapter not available."""
        coordinator = MagicMock()
        coordinator.get_health_status.return_value = {
            "runtime": {"initialized": True, "startup_complete": True, "module_count": 2},
            "modules": {"interpreter_adapter": {"available": False}},
        }
        runtime = MagicMock()
        runtime._initialized = True
        runtime.coordinator = coordinator

        result = await RuntimeHealthChecker(runtime).check_health()

        assert result["healthy"] is True
        assert result["interpreter_loaded"] is False

    @pytest.mark.asyncio
    async def test_runtime_not_initialized(self):
        runtime = MagicMock()
        runtime._initialized = False

        result = await RuntimeHealthChecker(runtime).check_health()

        assert result["healthy"] is False
        assert "not initialized" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_runtime_missing_initialized_attr(self):
        """Runtime without _initialized attribute treated as not initialized."""
        runtime = MagicMock(spec=[])  # empty spec = no attributes

        result = await RuntimeHealthChecker(runtime).check_health()

        assert result["healthy"] is False

    @pytest.mark.asyncio
    async def test_runtime_check_exception(self):
        runtime = MagicMock()
        type(runtime)._initialized = PropertyMock(side_effect=RuntimeError("exploded"))

        result = await RuntimeHealthChecker(runtime).check_health()

        assert result["healthy"] is False
        assert "exploded" in result["message"]

    @pytest.mark.asyncio
    async def test_runtime_healthy_no_coordinator(self):
        """Initialized but coordinator is None — returns healthy with zero modules."""
        runtime = MagicMock()
        runtime._initialized = True
        runtime.coordinator = None

        result = await RuntimeHealthChecker(runtime).check_health()

        assert result["healthy"] is True
        assert result["module_count"] == 0


# =============================================================================
# IntegrationHealthChecker
# =============================================================================


class TestIntegrationHealthChecker:

    @pytest.mark.asyncio
    async def test_integrations_loaded(self):
        class FakeIntegration:
            pass

        loader = MagicMock()
        loader.registry = {}
        loader._loaded = {"perplexica": FakeIntegration(), "mcp": FakeIntegration()}

        result = await IntegrationHealthChecker(loader).check_health()

        assert result["healthy"] is True
        assert result["count"] == 2
        assert "perplexica" in result["integrations"]
        assert result["integrations"]["perplexica"]["loaded"] is True
        assert result["integrations"]["perplexica"]["type"] == "FakeIntegration"

    @pytest.mark.asyncio
    async def test_no_registry(self):
        loader = MagicMock(spec=[])  # no registry attr

        result = await IntegrationHealthChecker(loader).check_health()

        assert result["healthy"] is False
        assert "not initialized" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_integration_check_exception(self):
        """Force exception inside the try block after hasattr check passes."""
        loader = MagicMock()
        loader.registry = {}
        # getattr(loader, '_loaded', {}) returns a dict-like whose .items() raises
        bad_dict = MagicMock()
        bad_dict.items.side_effect = TypeError("broken iteration")
        loader._loaded = bad_dict

        result = await IntegrationHealthChecker(loader).check_health()

        assert result["healthy"] is False
        assert "broken" in result["message"]


# =============================================================================
# DatabaseHealthChecker
# =============================================================================


class TestDatabaseHealthChecker:

    @pytest.mark.asyncio
    async def test_db_has_sync_health_check(self):
        """Database with sync health_check method."""
        db = MagicMock()
        db.health_check.return_value = {"healthy": True, "message": "Connected"}

        result = await DatabaseHealthChecker(db).check_health()

        assert result["healthy"] is True
        assert result["message"] == "Connected"
        assert isinstance(result["response_time_ms"], float)

    @pytest.mark.asyncio
    async def test_db_has_async_health_check(self):
        """Database with async health_check (coroutine)."""
        db = MagicMock()

        async def _async_health():
            return {"healthy": True, "message": "Async connected"}

        db.health_check.return_value = _async_health()

        result = await DatabaseHealthChecker(db).check_health()

        assert result["healthy"] is True
        assert result["message"] == "Async connected"

    @pytest.mark.asyncio
    async def test_db_fallback_get_connection(self):
        """No health_check but has get_connection."""
        db = MagicMock(spec=["get_connection"])
        db.get_connection.return_value = MagicMock()  # non-None = connected

        result = await DatabaseHealthChecker(db).check_health()

        assert result["healthy"] is True

    @pytest.mark.asyncio
    async def test_db_fallback_get_connection_none(self):
        """get_connection returns None — unhealthy."""
        db = MagicMock(spec=["get_connection"])
        db.get_connection.return_value = None

        result = await DatabaseHealthChecker(db).check_health()

        assert result["healthy"] is False

    @pytest.mark.asyncio
    async def test_db_no_health_method(self):
        """No health_check, no get_connection — generic healthy with message."""
        db = MagicMock(spec=[])

        result = await DatabaseHealthChecker(db).check_health()

        assert result["healthy"] is True
        assert "not implemented" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_db_exception(self):
        """Database check raises — unhealthy."""
        db = MagicMock()
        db.health_check.side_effect = ConnectionError("refused")

        result = await DatabaseHealthChecker(db).check_health()

        assert result["healthy"] is False
        assert "refused" in result["message"]


# =============================================================================
# MCPHealthChecker
# =============================================================================


class TestMCPHealthChecker:

    @pytest.mark.asyncio
    async def test_mcp_no_active_servers_attr(self):
        manager = MagicMock(spec=[])

        result = await MCPHealthChecker(manager).check_health()

        assert result["healthy"] is False
        assert "not initialized" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_mcp_two_servers_healthy(self):
        server_a = AsyncMock()
        server_a.get_tools.return_value = ["tool1", "tool2"]
        server_b = AsyncMock()
        server_b.get_tools.return_value = ["tool3"]

        manager = MagicMock()
        manager._active_servers = {"s1": server_a, "s2": server_b}

        result = await MCPHealthChecker(manager).check_health()

        assert result["healthy"] is True
        assert result["total_servers"] == 2
        assert result["unhealthy_servers"] == 0
        assert result["servers"]["s1"]["tool_count"] == 2
        assert result["servers"]["s2"]["tool_count"] == 1

    @pytest.mark.asyncio
    async def test_mcp_one_server_failing(self):
        ok_server = AsyncMock()
        ok_server.get_tools.return_value = ["t1"]
        bad_server = AsyncMock()
        bad_server.get_tools.side_effect = ConnectionError("timeout")

        manager = MagicMock()
        manager._active_servers = {"ok": ok_server, "bad": bad_server}

        result = await MCPHealthChecker(manager).check_health()

        assert result["healthy"] is False
        assert result["unhealthy_servers"] == 1
        assert result["servers"]["bad"]["healthy"] is False
        assert "timeout" in result["servers"]["bad"]["error"]

    @pytest.mark.asyncio
    async def test_mcp_server_no_get_tools(self):
        """Server without get_tools still reported as active."""
        server = MagicMock(spec=[])  # no get_tools
        manager = MagicMock()
        manager._active_servers = {"basic": server}

        result = await MCPHealthChecker(manager).check_health()

        assert result["healthy"] is True
        assert result["servers"]["basic"]["healthy"] is True
        assert result["servers"]["basic"]["message"] == "Server active"

    @pytest.mark.asyncio
    async def test_mcp_empty_servers(self):
        manager = MagicMock()
        manager._active_servers = {}

        result = await MCPHealthChecker(manager).check_health()

        assert result["healthy"] is True
        assert result["total_servers"] == 0

    @pytest.mark.asyncio
    async def test_mcp_overall_exception(self):
        manager = MagicMock()
        type(manager)._active_servers = PropertyMock(side_effect=RuntimeError("kaboom"))

        result = await MCPHealthChecker(manager).check_health()

        assert result["healthy"] is False
        assert "kaboom" in result["message"]


# =============================================================================
# RedisComponentHealthChecker / CacheHealthChecker
# =============================================================================


class TestRedisComponentHealthChecker:

    @pytest.mark.asyncio
    async def test_cache_none(self):
        result = await RedisComponentHealthChecker(None).check_health()

        assert result["healthy"] is False
        assert result["status"] == "unavailable"
        assert "not configured" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_cache_connected_with_health_check(self):
        cache = MagicMock()
        cache.is_connected.return_value = True

        async def _hc():
            return {"healthy": True, "status": "healthy", "message": "OK"}

        cache.health_check = _hc

        result = await RedisComponentHealthChecker(cache).check_health()

        assert result["healthy"] is True
        assert result["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_cache_connected_no_health_check(self):
        """Connected but no health_check method — generic healthy."""
        cache = MagicMock(spec=["is_connected"])
        cache.is_connected.return_value = True

        result = await RedisComponentHealthChecker(cache).check_health()

        assert result["healthy"] is True
        assert result["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_cache_not_connected_lazy_connect_succeeds(self):
        """Not connected initially, lazy connect makes it connected."""
        call_count = 0

        def _is_connected():
            nonlocal call_count
            call_count += 1
            return call_count > 1  # False first, True second

        cache = MagicMock()
        cache.is_connected = _is_connected
        cache.connect = AsyncMock()
        cache.health_check = None  # no health_check after connect

        result = await RedisComponentHealthChecker(cache).check_health()

        cache.connect.assert_awaited_once()
        assert result["healthy"] is True

    @pytest.mark.asyncio
    async def test_cache_not_connected_no_connect(self):
        """Not connected and no connect method — unavailable."""
        cache = MagicMock(spec=["is_connected"])
        cache.is_connected.return_value = False

        result = await RedisComponentHealthChecker(cache).check_health()

        assert result["healthy"] is False
        assert "unavailable" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_cache_exception(self):
        cache = MagicMock()
        cache.is_connected.side_effect = RuntimeError("socket error")

        result = await RedisComponentHealthChecker(cache).check_health()

        assert result["healthy"] is False
        assert "socket error" in result["message"]

    def test_cache_health_checker_is_alias(self):
        """CacheHealthChecker is backward-compatible alias."""
        assert issubclass(CacheHealthChecker, RedisComponentHealthChecker)


# =============================================================================
# initialize_health_checks factory
# =============================================================================


class TestInitializeHealthChecks:

    @pytest.fixture(autouse=True)
    def _reset_global(self):
        import monitoring.health as _mod
        _mod._global_health_checker = None
        yield
        _mod._global_health_checker = None

    def test_all_components(self):
        runtime = MagicMock()
        loader = MagicMock()
        db = MagicMock()
        mcp = MagicMock()
        cache = MagicMock()

        checker = initialize_health_checks(
            runtime=runtime,
            integration_loader=loader,
            database=db,
            mcp_manager=mcp,
            cache=cache,
        )

        assert isinstance(checker, HealthChecker)
        assert "runtime" in checker._checkers
        assert "integrations" in checker._checkers
        assert "database" in checker._checkers
        assert "mcp" in checker._checkers
        assert "cache" in checker._checkers

    def test_partial_components(self):
        checker = initialize_health_checks(runtime=MagicMock())

        assert "runtime" in checker._checkers
        assert "database" not in checker._checkers
        assert "mcp" not in checker._checkers

    def test_no_components(self):
        checker = initialize_health_checks()

        assert len(checker._checkers) == 0

    def test_get_health_checker_singleton(self):
        c1 = get_health_checker()
        c2 = get_health_checker()
        assert c1 is c2


# =============================================================================
# HealthCheckResult dataclass
# =============================================================================


class TestHealthCheckResult:

    def test_default_fields(self):
        r = HealthCheckResult(
            component="test",
            status=HealthStatus.HEALTHY,
            message="all good",
        )
        assert r.component == "test"
        assert r.status == HealthStatus.HEALTHY
        assert r.message == "all good"
        assert isinstance(r.details, dict)
        assert len(r.details) == 0
        assert r.checked_at.endswith("Z")
        assert r.response_time_ms is None
