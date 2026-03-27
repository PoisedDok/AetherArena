"""
Tests for services/aether_inference/inference_control.py

Covers: ensure_inference_running, inference_shutdown, get_inference_status,
_get_inference_preference with all branches (disabled, user pref, auto_start, etc.)

All imports in the tested module are local (inside function bodies), so
patches target the source modules: config.settings, services.aether_inference.manager,
api.dependencies, data.database.repositories.preferences.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ===========================================================================
# ensure_inference_running Tests
# ===========================================================================

class TestEnsureInferenceRunning:
    """Tests for ensure_inference_running."""

    @pytest.mark.asyncio
    async def test_disabled_in_config(self):
        """Returns False if inference.enabled is False."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = False

        with patch("config.settings.get_settings", return_value=mock_settings):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is False

    @pytest.mark.asyncio
    async def test_user_preference_disabled_stops_running_server(self):
        """Returns False and stops running server if user preference disables inference."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager.health_check = AsyncMock(return_value={"healthy": True})
        mock_manager.stop = AsyncMock(return_value={"status": "stopped"})

        mock_pref = AsyncMock(return_value=False)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is False

    @pytest.mark.asyncio
    async def test_already_running_reconnect(self):
        """Returns True if server already running (reconnected via health check)."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager.health_check = AsyncMock(return_value={"healthy": True})
        mock_manager._pid = 12345

        mock_pref = AsyncMock(return_value=True)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is True

    @pytest.mark.asyncio
    async def test_auto_start_disabled(self):
        """Returns False if server not running and auto_start is False."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.auto_start = False
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager.health_check = AsyncMock(return_value={"healthy": False})

        mock_pref = AsyncMock(return_value=True)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is False

    @pytest.mark.asyncio
    async def test_start_success(self):
        """Returns True when server starts successfully."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.auto_start = True
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager.health_check = AsyncMock(return_value={"healthy": False})
        mock_manager.start = AsyncMock(return_value={"status": "running"})

        mock_pref = AsyncMock(return_value=True)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is True

    @pytest.mark.asyncio
    async def test_start_failure(self):
        """Returns False when server fails to start."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.auto_start = True
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager.health_check = AsyncMock(return_value={"healthy": False})
        mock_manager.start = AsyncMock(return_value={"status": "error"})

        mock_pref = AsyncMock(return_value=True)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is False

    @pytest.mark.asyncio
    async def test_exception_returns_false(self):
        """Returns False on unexpected exception."""
        with patch("config.settings.get_settings", side_effect=Exception("boom")):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is False


# ===========================================================================
# inference_shutdown Tests
# ===========================================================================

class TestInferenceShutdown:
    """Tests for inference_shutdown."""

    @pytest.mark.asyncio
    async def test_shutdown_with_instance(self):
        """Calls dispose on existing instance."""
        from services.aether_inference.manager import InferenceManager
        mock_manager = MagicMock()
        mock_manager.dispose = AsyncMock()

        original = InferenceManager._instance
        try:
            InferenceManager._instance = mock_manager
            from services.aether_inference.inference_control import inference_shutdown
            await inference_shutdown(stop_server=True)
            mock_manager.dispose.assert_called_once_with(stop_server=True)
        finally:
            InferenceManager._instance = original

    @pytest.mark.asyncio
    async def test_shutdown_no_instance(self):
        """Handles no instance gracefully."""
        from services.aether_inference.manager import InferenceManager
        original = InferenceManager._instance
        try:
            InferenceManager._instance = None
            from services.aether_inference.inference_control import inference_shutdown
            await inference_shutdown()
            # No error thrown
        finally:
            InferenceManager._instance = original

    @pytest.mark.asyncio
    async def test_shutdown_error_suppressed(self):
        """Suppresses errors during shutdown."""
        from services.aether_inference.manager import InferenceManager
        mock_manager = MagicMock()
        mock_manager.dispose = AsyncMock(side_effect=Exception("shutdown error"))

        original = InferenceManager._instance
        try:
            InferenceManager._instance = mock_manager
            from services.aether_inference.inference_control import inference_shutdown
            await inference_shutdown(stop_server=True)
        finally:
            InferenceManager._instance = original


# ===========================================================================
# get_inference_status Tests
# ===========================================================================

class TestGetInferenceStatus:
    """Tests for get_inference_status."""

    @pytest.mark.asyncio
    async def test_disabled_in_config(self):
        """Returns disabled status when inference not enabled."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = False

        with patch("config.settings.get_settings", return_value=mock_settings):
            from services.aether_inference.inference_control import get_inference_status
            result = await get_inference_status()
            assert result["status"] == "disabled"

    @pytest.mark.asyncio
    async def test_status_with_running_server(self):
        """Returns status from manager when server running."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager.get_status = AsyncMock(return_value={
            "status": "running", "healthy": True, "port": 7090
        })

        mock_pref = AsyncMock(return_value=True)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import get_inference_status
            result = await get_inference_status()
            assert result["status"] == "running"
            assert result["user_enabled"] is True

    @pytest.mark.asyncio
    async def test_status_exception(self):
        """Returns error status on exception."""
        with patch("config.settings.get_settings", side_effect=Exception("fail")):
            from services.aether_inference.inference_control import get_inference_status
            result = await get_inference_status()
            assert result["status"] == "error"


# ===========================================================================
# _get_inference_preference Tests
# ===========================================================================

class TestGetInferencePreference:
    """Tests for _get_inference_preference."""

    @pytest.mark.asyncio
    async def test_preference_enabled(self):
        """Returns True when preference is enabled."""
        mock_settings = MagicMock()
        mock_settings.security.default_user_id = "user1"

        mock_gateway = MagicMock()
        mock_repo = MagicMock()
        mock_repo.get_preference = AsyncMock(return_value=True)

        with patch("api.dependencies.get_database_connection", return_value=mock_gateway), \
             patch("data.database.repositories.preferences.PreferencesRepository", return_value=mock_repo):
            from services.aether_inference.inference_control import _get_inference_preference
            result = await _get_inference_preference(mock_settings)
            assert result is True

    @pytest.mark.asyncio
    async def test_preference_disabled(self):
        """Returns False when preference is disabled."""
        mock_settings = MagicMock()
        mock_settings.security.default_user_id = "user1"

        mock_gateway = MagicMock()
        mock_repo = MagicMock()
        mock_repo.get_preference = AsyncMock(return_value=False)

        with patch("api.dependencies.get_database_connection", return_value=mock_gateway), \
             patch("data.database.repositories.preferences.PreferencesRepository", return_value=mock_repo):
            from services.aether_inference.inference_control import _get_inference_preference
            result = await _get_inference_preference(mock_settings)
            assert result is False

    @pytest.mark.asyncio
    async def test_preference_dict_format(self):
        """Handles legacy dict format {"enabled": bool}."""
        mock_settings = MagicMock()
        mock_settings.security.default_user_id = "user1"

        mock_gateway = MagicMock()
        mock_repo = MagicMock()
        mock_repo.get_preference = AsyncMock(return_value={"enabled": False})

        with patch("api.dependencies.get_database_connection", return_value=mock_gateway), \
             patch("data.database.repositories.preferences.PreferencesRepository", return_value=mock_repo):
            from services.aether_inference.inference_control import _get_inference_preference
            result = await _get_inference_preference(mock_settings)
            assert result is False

    @pytest.mark.asyncio
    async def test_no_database_returns_none(self):
        """Returns None when database not available."""
        mock_settings = MagicMock()

        with patch("api.dependencies.get_database_connection", return_value=None):
            from services.aether_inference.inference_control import _get_inference_preference
            result = await _get_inference_preference(mock_settings)
            assert result is None

    @pytest.mark.asyncio
    async def test_exception_returns_none(self):
        """Returns None on exception (non-fatal)."""
        with patch("config.settings.get_settings", side_effect=Exception("db error")):
            from services.aether_inference.inference_control import _get_inference_preference
            result = await _get_inference_preference()
            assert result is None


# ===========================================================================
# Phase 4: inference_control.py Test Gaps
# ===========================================================================

class TestEnsureInferenceRunningGaps:
    """Additional tests for ensure_inference_running edge cases."""

    @pytest.mark.asyncio
    async def test_user_pref_none_treated_as_enabled(self):
        """When DB unavailable (_get_inference_preference returns None),
        inference should still start (None = default enabled)."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.auto_start = True
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager.health_check = AsyncMock(return_value={"healthy": False})
        mock_manager.start = AsyncMock(return_value={"status": "running"})

        # None = DB unavailable, should be treated as enabled
        mock_pref = AsyncMock(return_value=None)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is True
            # start() was called because None is treated as enabled
            mock_manager.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_user_disabled_actually_calls_manager_stop(self):
        """When user disabled inference AND server is running, manager.stop() must be called."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager.health_check = AsyncMock(return_value={"healthy": True})
        mock_manager.stop = AsyncMock(return_value={"status": "stopped"})

        mock_pref = AsyncMock(return_value=False)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is False
            # Critical: stop() must have been called to shut down the pre-existing server
            mock_manager.stop.assert_called_once()

    @pytest.mark.asyncio
    async def test_user_disabled_stop_error_still_returns_false(self):
        """Coverage for lines 58-59: exception while stopping pre-existing server.
        
        When the user disabled inference but the attempt to stop the running
        server fails, ensure_inference_running should still return False
        (not crash).
        """
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager.health_check = AsyncMock(return_value={"healthy": True})
        mock_manager.stop = AsyncMock(side_effect=ConnectionError("server unreachable"))

        mock_pref = AsyncMock(return_value=False)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            # Still returns False despite stop failing
            assert result is False
            mock_manager.stop.assert_called_once()

    @pytest.mark.asyncio
    async def test_reconnected_server_health_promotes_status(self):
        """When manager reconnects (STARTING), health check should still report True
        if the server is actually healthy."""
        mock_settings = MagicMock()
        mock_settings.inference.enabled = True
        mock_settings.inference.port = 7090
        mock_settings.inference.venv_path = None
        mock_settings.inference.models_dir = None
        mock_settings.inference.idle_timeout = 600

        mock_manager = MagicMock()
        mock_manager._pid = 12345
        mock_manager.port = 7090
        # health_check returns healthy — this is what promotes STARTING -> RUNNING
        mock_manager.health_check = AsyncMock(return_value={"healthy": True})

        mock_pref = AsyncMock(return_value=True)

        with patch("config.settings.get_settings", return_value=mock_settings), \
             patch("services.aether_inference.inference_control._get_inference_preference", mock_pref), \
             patch("services.aether_inference.manager.InferenceManager.get_instance", return_value=mock_manager):
            from services.aether_inference.inference_control import ensure_inference_running
            result = await ensure_inference_running()
            assert result is True
            # start() should NOT be called — server was already healthy
            mock_manager.start.assert_not_called()
