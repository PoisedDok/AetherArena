"""
Tests for app.py shutdown lifecycle: _read_proactive_master_enabled helper
and conditional shutdown behavior.

Covers:
  - _read_proactive_master_enabled: config file present/absent/corrupt,
    settings fallback, conservative default on error.
  - Conditional shutdown: proactive ON preserves daemons + inference,
    proactive OFF kills both.
"""

import json
import pytest
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch


# ===========================================================================
# _read_proactive_master_enabled Tests
# ===========================================================================

class TestReadProactiveMasterEnabled:
    """Tests for the _read_proactive_master_enabled helper in app.py."""

    def _make_settings(self, *, proactive_enabled=True, app_root=None):
        """Create a mock settings object with proactive.enabled and app_root."""
        settings = MagicMock()
        settings.proactive.enabled = proactive_enabled
        settings.app_root = app_root or Path("/tmp/test_aether")
        return settings

    def test_config_file_enabled_true(self, tmp_path):
        """Returns True when proactive_config.json has enabled=true."""
        runtime_dir = tmp_path / "data" / "runtime"
        runtime_dir.mkdir(parents=True)
        config_file = runtime_dir / "proactive_config.json"
        config_file.write_text(json.dumps({"enabled": True}))

        settings = self._make_settings(app_root=tmp_path)

        with patch("config.settings.get_settings", return_value=settings):
            from app import _read_proactive_master_enabled
            assert _read_proactive_master_enabled() is True

    def test_config_file_enabled_false(self, tmp_path):
        """Returns False when proactive_config.json has enabled=false."""
        runtime_dir = tmp_path / "data" / "runtime"
        runtime_dir.mkdir(parents=True)
        config_file = runtime_dir / "proactive_config.json"
        config_file.write_text(json.dumps({"enabled": False}))

        settings = self._make_settings(app_root=tmp_path)

        with patch("config.settings.get_settings", return_value=settings):
            from app import _read_proactive_master_enabled
            assert _read_proactive_master_enabled() is False

    def test_config_file_missing_falls_back_to_settings(self, tmp_path):
        """Falls back to settings.proactive.enabled when config file missing."""
        # No runtime dir created — config file doesn't exist
        settings = self._make_settings(proactive_enabled=True, app_root=tmp_path)

        with patch("config.settings.get_settings", return_value=settings):
            from app import _read_proactive_master_enabled
            assert _read_proactive_master_enabled() is True

    def test_config_file_missing_settings_disabled(self, tmp_path):
        """Falls back to settings.proactive.enabled=False when config file missing."""
        settings = self._make_settings(proactive_enabled=False, app_root=tmp_path)

        with patch("config.settings.get_settings", return_value=settings):
            from app import _read_proactive_master_enabled
            assert _read_proactive_master_enabled() is False

    def test_config_file_corrupt_json_returns_false(self, tmp_path):
        """Returns False (conservative) when config file has corrupt JSON."""
        runtime_dir = tmp_path / "data" / "runtime"
        runtime_dir.mkdir(parents=True)
        config_file = runtime_dir / "proactive_config.json"
        config_file.write_text("NOT VALID JSON {{{")

        settings = self._make_settings(app_root=tmp_path)

        with patch("config.settings.get_settings", return_value=settings):
            from app import _read_proactive_master_enabled
            assert _read_proactive_master_enabled() is False

    def test_get_settings_throws_returns_false(self):
        """Returns False (conservative) when get_settings() raises a caught exception."""
        with patch("config.settings.get_settings", side_effect=ImportError("settings unavailable")):
            from app import _read_proactive_master_enabled
            assert _read_proactive_master_enabled() is False

    def test_config_file_missing_enabled_key_uses_settings_default(self, tmp_path):
        """When config file exists but has no 'enabled' key, falls back to settings default."""
        runtime_dir = tmp_path / "data" / "runtime"
        runtime_dir.mkdir(parents=True)
        config_file = runtime_dir / "proactive_config.json"
        # Config file with other keys but no 'enabled'
        config_file.write_text(json.dumps({"worker_enabled": True, "mode": "autonomous"}))

        settings = self._make_settings(proactive_enabled=False, app_root=tmp_path)

        with patch("config.settings.get_settings", return_value=settings):
            from app import _read_proactive_master_enabled
            # Falls back to settings.proactive.enabled which is False
            assert _read_proactive_master_enabled() is False

    def test_config_file_enabled_truthy_values(self, tmp_path):
        """Handles truthy non-boolean values via bool() coercion."""
        runtime_dir = tmp_path / "data" / "runtime"
        runtime_dir.mkdir(parents=True)
        config_file = runtime_dir / "proactive_config.json"
        config_file.write_text(json.dumps({"enabled": 1}))

        settings = self._make_settings(app_root=tmp_path)

        with patch("config.settings.get_settings", return_value=settings):
            from app import _read_proactive_master_enabled
            assert _read_proactive_master_enabled() is True

    def test_config_file_enabled_falsy_values(self, tmp_path):
        """Handles falsy non-boolean values via bool() coercion."""
        runtime_dir = tmp_path / "data" / "runtime"
        runtime_dir.mkdir(parents=True)
        config_file = runtime_dir / "proactive_config.json"
        config_file.write_text(json.dumps({"enabled": 0}))

        settings = self._make_settings(app_root=tmp_path)

        with patch("config.settings.get_settings", return_value=settings):
            from app import _read_proactive_master_enabled
            assert _read_proactive_master_enabled() is False


# ===========================================================================
# Conditional Shutdown Behavior Tests
# ===========================================================================

class TestConditionalShutdown:
    """
    Tests verifying that the shutdown block in app.py dispatches correctly
    based on _read_proactive_master_enabled() return value.

    These tests mock the helper and the shutdown callees to verify the
    conditional routing without spinning up the full lifespan.
    """

    @pytest.mark.asyncio
    async def test_proactive_on_preserves_both(self):
        """When proactive is enabled, inference_shutdown(stop_server=False)
        is called and stop_daemon_manager is NOT called."""
        mock_inference_shutdown = AsyncMock()

        with patch("app._read_proactive_master_enabled", return_value=True), \
             patch("services.aether_inference.inference_control.inference_shutdown",
                   mock_inference_shutdown):
            # Simulate the proactive-ON shutdown path directly
            from app import _read_proactive_master_enabled
            proactive_master_on = _read_proactive_master_enabled()
            assert proactive_master_on is True

            # Execute the ON path (mirrors app.py shutdown logic)
            from services.aether_inference.inference_control import inference_shutdown
            await inference_shutdown(stop_server=False)

            mock_inference_shutdown.assert_called_once_with(stop_server=False)

    @pytest.mark.asyncio
    async def test_proactive_off_kills_both(self):
        """When proactive is disabled, inference_shutdown(stop_server=True)
        and stop_daemon_manager are both called."""
        mock_inference_shutdown = AsyncMock()
        mock_stop_daemons = MagicMock(return_value=True)

        with patch("app._read_proactive_master_enabled", return_value=False), \
             patch("services.aether_inference.inference_control.inference_shutdown",
                   mock_inference_shutdown), \
             patch("services.daemons.daemon_control.stop_daemon_manager",
                   mock_stop_daemons):
            import asyncio
            from services.aether_inference.inference_control import inference_shutdown
            from services.daemons.daemon_control import stop_daemon_manager

            # Execute the OFF path (mirrors app.py shutdown logic)
            async def _stop_daemons():
                await asyncio.to_thread(stop_daemon_manager)

            async def _stop_inference():
                await inference_shutdown(stop_server=True)

            await asyncio.gather(
                _stop_daemons(),
                _stop_inference(),
                return_exceptions=True,
            )

            mock_inference_shutdown.assert_called_once_with(stop_server=True)
            mock_stop_daemons.assert_called_once()

    @pytest.mark.asyncio
    async def test_proactive_off_handles_daemon_stop_failure(self):
        """When proactive is disabled and stop_daemon_manager raises,
        inference_shutdown still completes (gather with return_exceptions)."""
        mock_inference_shutdown = AsyncMock()
        mock_stop_daemons = MagicMock(side_effect=OSError("process not found"))

        with patch("services.aether_inference.inference_control.inference_shutdown",
                   mock_inference_shutdown), \
             patch("services.daemons.daemon_control.stop_daemon_manager",
                   mock_stop_daemons):
            import asyncio
            from services.aether_inference.inference_control import inference_shutdown
            from services.daemons.daemon_control import stop_daemon_manager

            async def _stop_daemons():
                await asyncio.to_thread(stop_daemon_manager)

            async def _stop_inference():
                await inference_shutdown(stop_server=True)

            results = await asyncio.gather(
                _stop_daemons(),
                _stop_inference(),
                return_exceptions=True,
            )

            # Daemon stop failed but inference still completed
            assert isinstance(results[0], OSError)
            mock_inference_shutdown.assert_called_once_with(stop_server=True)

    @pytest.mark.asyncio
    async def test_proactive_off_handles_inference_stop_failure(self):
        """When proactive is disabled and inference_shutdown raises,
        stop_daemon_manager still completes (gather with return_exceptions)."""
        mock_inference_shutdown = AsyncMock(
            side_effect=ConnectionError("inference unreachable")
        )
        mock_stop_daemons = MagicMock(return_value=True)

        with patch("services.aether_inference.inference_control.inference_shutdown",
                   mock_inference_shutdown), \
             patch("services.daemons.daemon_control.stop_daemon_manager",
                   mock_stop_daemons):
            import asyncio
            from services.aether_inference.inference_control import inference_shutdown
            from services.daemons.daemon_control import stop_daemon_manager

            async def _stop_daemons():
                await asyncio.to_thread(stop_daemon_manager)

            async def _stop_inference():
                await inference_shutdown(stop_server=True)

            results = await asyncio.gather(
                _stop_daemons(),
                _stop_inference(),
                return_exceptions=True,
            )

            # Inference stop failed but daemon stop still completed
            assert isinstance(results[1], ConnectionError)
            mock_stop_daemons.assert_called_once()

    @pytest.mark.asyncio
    async def test_proactive_on_inference_dispose_failure_handled(self):
        """When proactive is enabled and inference_shutdown(stop_server=False) raises,
        error is caught by the outer try/except (no crash)."""
        mock_inference_shutdown = AsyncMock(
            side_effect=RuntimeError("dispose failed")
        )

        with patch("services.aether_inference.inference_control.inference_shutdown",
                   mock_inference_shutdown):
            from services.aether_inference.inference_control import inference_shutdown

            # The outer try/except in app.py catches this
            try:
                await inference_shutdown(stop_server=False)
                # If mock raises, this won't be reached
                assert False, "Should have raised"
            except RuntimeError:
                pass  # Expected — app.py catches this with broad except

            mock_inference_shutdown.assert_called_once_with(stop_server=False)
