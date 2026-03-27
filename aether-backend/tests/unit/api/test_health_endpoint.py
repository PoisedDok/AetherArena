"""
Health Endpoint Tests

Covers all 7 routes:
  GET  /v1/health                       — simple health check (local-only)
  GET  /v1/health/detailed              — comprehensive health check
  GET  /v1/health/component/{name}      — component-specific health
  GET  /v1/health/ready                 — readiness probe
  GET  /v1/health/live                  — liveness probe
  GET  /v1/api/status                   — detailed status (legacy)
  POST /v1/system/shutdown              — graceful shutdown (local-only)

Quality: body assertions, response schema validation, edge cases.
"""

import pytest
import time
from unittest.mock import patch, MagicMock, AsyncMock


# =========================================================================
# GET /v1/health
# =========================================================================


class TestSimpleHealth:
    """Tests for the simple health endpoint."""

    @pytest.mark.asyncio
    async def test_health_returns_ok(self, client):
        """Simple health check returns status ok."""
        resp = await client.get("/v1/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "timestamp" in body
        assert "uptime_seconds" in body
        assert body["uptime_seconds"] >= 0

    @pytest.mark.asyncio
    async def test_health_includes_model(self, client):
        """Health check includes active model name."""
        resp = await client.get("/v1/health")
        assert resp.status_code == 200
        body = resp.json()
        # model may be None if settings not loaded, but key should exist
        assert "model" in body


# =========================================================================
# GET /v1/health/detailed
# =========================================================================


class TestDetailedHealth:
    """Tests for the detailed health check endpoint."""

    @pytest.mark.asyncio
    async def test_detailed_health_returns_response(self, client):
        """Detailed health check returns structured response."""
        resp = await client.get("/v1/health/detailed")
        assert resp.status_code == 200
        body = resp.json()
        assert "status" in body
        assert "timestamp" in body
        assert "uptime_seconds" in body
        assert "components" in body
        assert isinstance(body["components"], list)

    @pytest.mark.asyncio
    async def test_detailed_health_with_checker(self, client):
        """When health checker is available, returns component data."""
        from datetime import datetime, timezone

        mock_checker = MagicMock()
        mock_checker.check_all = AsyncMock(return_value={
            "status": "healthy",
            "timestamp": time.time(),
            "uptime_seconds": 100,
            "check_duration_ms": 5.0,
            "components": [
                {
                    "component": "system",
                    "status": "healthy",
                    "message": "All systems normal",
                    "response_time_ms": 1.5,
                    # Provide a valid datetime string for timestamp
                    # (ComponentHealth.timestamp is datetime, not Optional)
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "details": {
                        "cpu_percent": 25.0,
                        "memory_percent": 60.0,
                        "disk_percent": 45.0,
                        "platform": "Darwin",
                        "python_version": "3.12",
                        "uptime_seconds": 100,
                    },
                }
            ],
        })

        with patch("api.v1.endpoints.health.get_health_checker", return_value=mock_checker):
            resp = await client.get("/v1/health/detailed")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "healthy"
        assert len(body["components"]) == 1
        assert body["components"][0]["component"] == "system"

    @pytest.mark.asyncio
    async def test_detailed_health_checker_not_initialized(self, client):
        """When health checker is None, returns unknown status."""
        with patch("api.v1.endpoints.health.get_health_checker", return_value=None):
            resp = await client.get("/v1/health/detailed")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "unknown"


# =========================================================================
# GET /v1/health/component/{name}
# =========================================================================


class TestComponentHealth:
    """Tests for component-specific health checks."""

    @pytest.mark.asyncio
    async def test_invalid_component_returns_400(self, client):
        """Unknown component name returns 400."""
        resp = await client.get("/v1/health/component/nonexistent")
        assert resp.status_code == 400
        body = resp.json()
        assert "Invalid component" in body["detail"]

    @pytest.mark.asyncio
    async def test_valid_component_names_accepted(self, client):
        """Valid component names are not rejected with 400."""
        valid_names = ["runtime", "database", "mcp", "integrations", "system"]
        for name in valid_names:
            resp = await client.get(f"/v1/health/component/{name}")
            # Should not be 400 (invalid name) or 422 (path param issue)
            # 503 (not initialized), 404 (component check returned None), or 500 are acceptable
            assert resp.status_code != 400, f"Component '{name}' should be valid but got 400"

    @pytest.mark.asyncio
    async def test_component_checker_not_initialized(self, client):
        """Returns 503 when health checker is not initialized."""
        with patch("api.v1.endpoints.health.get_health_checker", return_value=None):
            resp = await client.get("/v1/health/component/system")
        assert resp.status_code == 503


# =========================================================================
# GET /v1/health/ready
# =========================================================================


class TestReadinessProbe:
    """Tests for the readiness probe."""

    @pytest.mark.asyncio
    async def test_ready_when_runtime_available(self, client, mock_runtime_engine):
        """Returns ready=True when runtime engine is available."""
        mock_checker = MagicMock()
        with patch("api.v1.endpoints.health.get_health_checker", return_value=mock_checker):
            resp = await client.get("/v1/health/ready")

        assert resp.status_code == 200
        body = resp.json()
        assert body["ready"] is True

    @pytest.mark.asyncio
    async def test_not_ready_when_checker_missing(self, client):
        """Returns 503 when health checker is None."""
        with patch("api.v1.endpoints.health.get_health_checker", return_value=None):
            resp = await client.get("/v1/health/ready")
        assert resp.status_code == 503
        body = resp.json()
        assert body["ready"] is False


# =========================================================================
# GET /v1/health/live
# =========================================================================


class TestLivenessProbe:
    """Tests for the liveness probe."""

    @pytest.mark.asyncio
    async def test_alive(self, client):
        """Liveness probe always returns alive=True."""
        resp = await client.get("/v1/health/live")
        assert resp.status_code == 200
        body = resp.json()
        assert body["alive"] is True
        assert "uptime_seconds" in body
        assert body["uptime_seconds"] >= 0


# =========================================================================
# GET /v1/api/status
# =========================================================================


class TestStatusCheck:
    """Tests for the legacy status endpoint."""

    @pytest.mark.asyncio
    async def test_status_returns_system_info(self, client):
        """Legacy status check returns system information."""
        resp = await client.get("/v1/api/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "system" in body
        assert "resources" in body
        assert "uptime" in body
        # System info
        assert "cpu_percent" in body["system"]
        assert "memory_percent" in body["system"]
        assert "platform" in body["system"]
        # Resources
        assert "cpu_percent" in body["resources"]
        assert "memory" in body["resources"]
        assert "disk" in body["resources"]
        # Uptime
        assert "seconds" in body["uptime"]
        assert "formatted" in body["uptime"]


# =========================================================================
# POST /v1/system/shutdown (structural test only)
# =========================================================================


class TestShutdown:
    """Tests for the shutdown endpoint."""

    @pytest.mark.asyncio
    async def test_shutdown_returns_status(self, client):
        """Shutdown endpoint returns shutting_down status.

        CRITICAL: The endpoint schedules _delayed_shutdown() via
        asyncio.ensure_future which calls os.kill(os.getpid(), SIGTERM)
        after a 500ms sleep.  The os.kill mock MUST stay active past
        that 500ms or the delayed task will SIGTERM the pytest process
        when running the full suite (shared event loop keeps ticking).
        """
        import asyncio

        with patch("os.kill") as mock_kill:
            resp = await client.post("/v1/system/shutdown")
            # _delayed_shutdown sleeps 500ms then calls os.kill.
            # Keep the mock active until that future completes.
            await asyncio.sleep(0.7)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "shutting_down"
        assert "pid" in body
        assert "message" in body
        # Verify the mock intercepted the self-kill
        mock_kill.assert_called_once()


# =========================================================================
# Deep Coverage: detailed_health_check branches
# =========================================================================


class TestDetailedHealthDeep:
    """Cover detailed_health_check exception path and system health extraction."""

    @pytest.mark.asyncio
    async def test_detailed_health_exception_returns_unhealthy(self, client):
        """Generic exception in detailed health check → status unhealthy."""
        mock_checker = MagicMock()
        mock_checker.check_all = AsyncMock(side_effect=RuntimeError("boom"))
        with patch("api.v1.endpoints.health.get_health_checker", return_value=mock_checker):
            resp = await client.get("/v1/health/detailed")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "unhealthy"
        assert body["components"][0]["component"] == "system"

    @pytest.mark.asyncio
    async def test_detailed_health_no_system_component(self, client):
        """Checker returns components but none is 'system' → system=None."""
        mock_checker = MagicMock()
        mock_checker.check_all = AsyncMock(return_value={
            "status": "healthy",
            "timestamp": time.time(),
            "uptime_seconds": 50,
            "check_duration_ms": 2.0,
            "components": [
                {"component": "database", "status": "healthy", "message": "ok"},
            ],
        })
        with patch("api.v1.endpoints.health.get_health_checker", return_value=mock_checker):
            resp = await client.get("/v1/health/detailed")
        assert resp.status_code == 200
        body = resp.json()
        assert body["system"] is None


# =========================================================================
# Deep Coverage: component health paths
# =========================================================================


class TestComponentHealthDeep:
    """Cover component health success, None result, and generic exception."""

    @pytest.mark.asyncio
    async def test_component_health_success(self, client):
        """Checker returns valid component → 200."""
        mock_result = MagicMock()
        mock_result.component = "database"
        mock_result.status = "healthy"
        mock_result.message = "DB connected"
        mock_result.response_time_ms = 5.0
        mock_result.details = {"connections": 3}

        mock_checker = MagicMock()
        mock_checker.check_component = AsyncMock(return_value=mock_result)
        with patch("api.v1.endpoints.health.get_health_checker", return_value=mock_checker):
            resp = await client.get("/v1/health/component/database")
        assert resp.status_code == 200
        body = resp.json()
        assert body["component"] == "database"
        assert body["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_component_health_returns_none_404(self, client):
        """Checker returns None for component → 404."""
        mock_checker = MagicMock()
        mock_checker.check_component = AsyncMock(return_value=None)
        with patch("api.v1.endpoints.health.get_health_checker", return_value=mock_checker):
            resp = await client.get("/v1/health/component/mcp")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_component_health_generic_exception_500(self, client):
        """Generic exception → 500."""
        mock_checker = MagicMock()
        mock_checker.check_component = AsyncMock(side_effect=RuntimeError("check failed"))
        with patch("api.v1.endpoints.health.get_health_checker", return_value=mock_checker):
            resp = await client.get("/v1/health/component/runtime")
        assert resp.status_code == 500


# =========================================================================
# Deep Coverage: readiness probe branches
# =========================================================================


class TestReadinessProbeDeep:
    """Cover readiness probe edge cases."""

    @pytest.mark.asyncio
    async def test_readiness_runtime_none_503(self, client):
        """Runtime engine is None → 503."""
        mock_checker = MagicMock()
        with patch("api.v1.endpoints.health.get_health_checker", return_value=mock_checker):
            with patch("api.v1.endpoints.health.get_runtime_engine", return_value=None):
                resp = await client.get("/v1/health/ready")
        assert resp.status_code == 503
        assert resp.json()["ready"] is False

    @pytest.mark.asyncio
    async def test_readiness_runtime_exception_503(self, client):
        """get_runtime_engine raises → 503."""
        mock_checker = MagicMock()
        with patch("api.v1.endpoints.health.get_health_checker", return_value=mock_checker):
            with patch("api.v1.endpoints.health.get_runtime_engine",
                        side_effect=RuntimeError("not loaded")):
                resp = await client.get("/v1/health/ready")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_readiness_generic_exception_503(self, client):
        """Generic exception in readiness → 503."""
        with patch("api.v1.endpoints.health.get_health_checker",
                    side_effect=RuntimeError("crash")):
            resp = await client.get("/v1/health/ready")
        assert resp.status_code == 503
        assert resp.json()["ready"] is False


# =========================================================================
# Deep Coverage: legacy status exception
# =========================================================================


class TestStatusCheckDeep:
    """Cover status check exception path."""

    @pytest.mark.asyncio
    async def test_status_exception_500(self, client):
        """psutil failure → 500."""
        with patch("core.system.process_gateway.ProcessGateway.get_system_metrics", side_effect=RuntimeError("no access")):
            resp = await client.get("/v1/api/status")
        assert resp.status_code == 500

    def test_format_uptime_days(self):
        """format_uptime with days."""
        from api.v1.endpoints.health import format_uptime
        result = format_uptime(90061)  # 1d 1h 1m 1s
        assert "1d" in result
        assert "1h" in result
        assert "1m" in result
        assert "1s" in result

    def test_format_uptime_hours(self):
        """format_uptime with hours only."""
        from api.v1.endpoints.health import format_uptime
        result = format_uptime(3661)  # 1h 1m 1s
        assert "1h" in result
        assert "1m" in result

    def test_format_uptime_seconds_only(self):
        """format_uptime with seconds only."""
        from api.v1.endpoints.health import format_uptime
        result = format_uptime(42)
        assert "42s" in result
        assert "h" not in result
        assert "d" not in result


class TestSimpleHealthDeep:
    """Cover settings exception path in health_check."""

    @pytest.mark.asyncio
    async def test_health_settings_exception_model_none(self, client):
        """get_settings raises → model stays None (late import patched at source)."""
        with patch("config.settings.get_settings",
                    side_effect=RuntimeError("settings load fail")):
            resp = await client.get("/v1/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        # model should be None when settings fail
        assert body["model"] is None
