"""
Unit tests for Omni endpoints (/v1/omni/*).

4 endpoints: screenshot, analyze-screen, workflows, health.
Tests cover success paths, OmniServiceError handling, health degradation,
and argument passthrough verification.

No bugs found during audit.

CI: pytest tests/unit/api/test_omni_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, MagicMock


# ===========================================================================
# Health
# ===========================================================================

class TestOmniHealth:
    """GET /v1/omni/health."""

    @pytest.mark.asyncio
    async def test_healthy(self, client):
        """Health returns 200."""
        resp = await client.get("/v1/omni/health")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_health_error_returns_degraded(self, client, app):
        """Service raises → 200 with healthy=False (graceful degradation, not 500)."""
        from api.dependencies import get_omni_service
        mock_svc = AsyncMock()
        mock_svc.health = AsyncMock(side_effect=RuntimeError("health crash"))
        app.dependency_overrides[get_omni_service] = lambda: mock_svc
        try:
            resp = await client.get("/v1/omni/health")
            assert resp.status_code == 200
            body = resp.json()
            assert body["healthy"] is False
            assert body["message"] == "Health check failed"
            assert body["capabilities"] == []
        finally:
            app.dependency_overrides.pop(get_omni_service, None)


# ===========================================================================
# Screenshot
# ===========================================================================

class TestOmniScreenshot:
    """POST /v1/omni/screenshot."""

    @pytest.mark.asyncio
    async def test_routable(self, client):
        """Endpoint is registered (not 404/405)."""
        resp = await client.post("/v1/omni/screenshot")
        assert resp.status_code != 404
        assert resp.status_code != 405

    @pytest.mark.asyncio
    async def test_success_returns_result(self, client, app):
        """capture_screenshot returns valid result → 200 with result dict."""
        from api.dependencies import get_omni_service
        mock_svc = AsyncMock()
        mock_svc.capture_screenshot = AsyncMock(return_value={
            "path": "/tmp/screenshot.png",
            "width": 1920,
            "height": 1080,
        })
        app.dependency_overrides[get_omni_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/omni/screenshot", json={"save_path": "/tmp/test.png"})
            assert resp.status_code == 200
            body = resp.json()
            assert body["path"] == "/tmp/screenshot.png"
            assert body["width"] == 1920
            assert body["height"] == 1080
        finally:
            app.dependency_overrides.pop(get_omni_service, None)

    @pytest.mark.asyncio
    async def test_save_path_passed_through(self, client, app):
        """Verify save_path from request is passed to service."""
        from api.dependencies import get_omni_service
        mock_svc = AsyncMock()
        mock_svc.capture_screenshot = AsyncMock(return_value={"path": "/custom/path.png"})
        app.dependency_overrides[get_omni_service] = lambda: mock_svc
        try:
            await client.post("/v1/omni/screenshot", json={"save_path": "/custom/path.png"})
            mock_svc.capture_screenshot.assert_called_once_with(save_path="/custom/path.png")
        finally:
            app.dependency_overrides.pop(get_omni_service, None)

    @pytest.mark.asyncio
    async def test_null_save_path(self, client, app):
        """Null save_path passes None to service."""
        from api.dependencies import get_omni_service
        mock_svc = AsyncMock()
        mock_svc.capture_screenshot = AsyncMock(return_value={"path": "/tmp/auto.png"})
        app.dependency_overrides[get_omni_service] = lambda: mock_svc
        try:
            await client.post("/v1/omni/screenshot", json={})
            mock_svc.capture_screenshot.assert_called_once_with(save_path=None)
        finally:
            app.dependency_overrides.pop(get_omni_service, None)

    @pytest.mark.asyncio
    async def test_service_error_500(self, client, app):
        """OmniServiceError → 500."""
        from api.dependencies import get_omni_service
        from application.omni import OmniServiceError
        mock_svc = AsyncMock()
        mock_svc.capture_screenshot = AsyncMock(side_effect=OmniServiceError("capture failed"))
        app.dependency_overrides[get_omni_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/omni/screenshot", json={})
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_omni_service, None)


# ===========================================================================
# Analyze Screen
# ===========================================================================

class TestOmniAnalyzeScreen:
    """POST /v1/omni/analyze-screen."""

    @pytest.mark.asyncio
    async def test_success(self, client, app):
        """Successful analysis returns exact result."""
        from api.dependencies import get_omni_service
        mock_svc = AsyncMock()
        mock_svc.analyze_screen = AsyncMock(return_value={
            "analysis": "Screen shows a dashboard",
            "confidence": 0.92,
        })
        app.dependency_overrides[get_omni_service] = lambda: mock_svc
        try:
            resp = await client.post(
                "/v1/omni/analyze-screen",
                json={"prompt": "Describe this screen"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["analysis"] == "Screen shows a dashboard"
            assert body["confidence"] == 0.92
            mock_svc.analyze_screen.assert_called_once_with(
                prompt="Describe this screen"
            )
        finally:
            app.dependency_overrides.pop(get_omni_service, None)

    @pytest.mark.asyncio
    async def test_default_prompt(self, client, app):
        """Empty body uses default prompt 'Describe this screen.'."""
        from api.dependencies import get_omni_service
        mock_svc = AsyncMock()
        mock_svc.analyze_screen = AsyncMock(return_value={"analysis": "ok"})
        app.dependency_overrides[get_omni_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/omni/analyze-screen", json={})
            assert resp.status_code == 200
            mock_svc.analyze_screen.assert_called_once_with(
                prompt="Describe this screen."
            )
        finally:
            app.dependency_overrides.pop(get_omni_service, None)

    @pytest.mark.asyncio
    async def test_service_error_500(self, client, app):
        """OmniServiceError → 500."""
        from api.dependencies import get_omni_service
        from application.omni import OmniServiceError
        mock_svc = AsyncMock()
        mock_svc.analyze_screen = AsyncMock(side_effect=OmniServiceError("vision failed"))
        app.dependency_overrides[get_omni_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/omni/analyze-screen", json={"prompt": "test"})
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_omni_service, None)


# ===========================================================================
# Workflows
# ===========================================================================

class TestOmniWorkflows:
    """GET /v1/omni/workflows."""

    @pytest.mark.asyncio
    async def test_returns_200(self, client):
        """Workflows returns 200."""
        resp = await client.get("/v1/omni/workflows")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_service_error_500(self, client, app):
        """OmniServiceError → 500."""
        from api.dependencies import get_omni_service
        from application.omni import OmniServiceError
        mock_svc = MagicMock()
        mock_svc.get_workflows = MagicMock(side_effect=OmniServiceError("no workflows"))
        app.dependency_overrides[get_omni_service] = lambda: mock_svc
        try:
            resp = await client.get("/v1/omni/workflows")
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_omni_service, None)
