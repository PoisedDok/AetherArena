"""
Unit Tests: DaemonManager

Tests the standalone daemon manager lifecycle — config state detection,
singleton lock acquisition, PID file management, daemon start/stop/reload,
crash detection and restart, and the full management loop.

All daemon imports, fcntl, and settings are mocked. No real processes spawned.

Bug-finding focus:
- Double-dispose guard (_is_disposed)
- _stopping_daemons flag suppresses restart during reload
- _acquire_singleton_lock returns False when another instance holds lock
- _restart_daemon guards against duplicate instances
- Config state change triggers reload
- start_all exits gracefully when singleton lock fails
"""

import asyncio
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest


@pytest.fixture(autouse=True)
def isolated_runtime_files(tmp_path):
    """Ensure all tests use temporary lock and PID files, protecting the host system."""
    pid_file = tmp_path / "daemon_manager.pid"
    lock_file = tmp_path / "daemon_manager.lock"
    
    with patch("services.daemons.daemon_manager.PID_FILE", pid_file), \
         patch("services.daemons.daemon_manager.LOCK_FILE", lock_file):
        yield

# =========================================================================
# Module-level patches to prevent heavy imports
# =========================================================================

# Patch all daemon imports BEFORE importing DaemonManager
_daemon_patches = {
    "services.daemons.browser.daemon": MagicMock(),
    "services.daemons.browser.config": MagicMock(),
    "services.daemons.email.daemon": MagicMock(),
    "services.daemons.email.config": MagicMock(),
    "services.daemons.filesystem.daemon": MagicMock(),
    "services.daemons.filesystem.config": MagicMock(),
    "services.daemons.query_generation.daemon": MagicMock(),
    "services.daemons.query_generation.config": MagicMock(),
    "services.daemons.file_indexing.daemon": MagicMock(),
    "services.daemons.file_indexing.config": MagicMock(),
}


# =========================================================================
# Helpers
# =========================================================================

def _make_settings(daemons_config=None, app_root=None):
    """Create mock settings with proactive.daemons config.

    app_root: real Path for tests that need file I/O via the unified config reader.
    When None, uses MagicMock (unified reader falls back to settings defaults).
    """
    settings = MagicMock()
    if app_root is not None:
        settings.app_root = Path(app_root)
    dc = settings.proactive.daemons
    cfg = daemons_config or {}
    dc.browser_enabled = cfg.get("browser_enabled", False)
    dc.email_enabled = cfg.get("email_enabled", False)
    dc.file_system_enabled = cfg.get("file_system_enabled", False)
    dc.query_generation_enabled = cfg.get("query_generation_enabled", False)
    dc.file_indexing_enabled = cfg.get("file_indexing_enabled", False)
    settings.proactive.enabled = cfg.get("enabled", True)
    # agent_worker defaults for unified reader fallback
    settings.proactive.agent_worker.enabled = False
    settings.proactive.agent_worker.heartbeat_interval_seconds = 10
    settings.proactive.agent_worker.mode = "balanced"
    settings.proactive.agent_worker.relevance_threshold = 0.6
    settings.proactive.agent_worker.max_processing_time_seconds = 300
    return settings


def _import_daemon_manager():
    """Import DaemonManager with daemon dependencies mocked."""
    import sys
    
    # Store originals
    originals = {}
    for mod_name, mock_mod in _daemon_patches.items():
        if mod_name in sys.modules:
            originals[mod_name] = sys.modules[mod_name]
        sys.modules[mod_name] = mock_mod
    
    try:
        # Force reimport
        if "services.daemons.daemon_manager" in sys.modules:
            del sys.modules["services.daemons.daemon_manager"]
        from services.daemons.daemon_manager import DaemonManager
        return DaemonManager
    finally:
        # Restore
        for mod_name in _daemon_patches:
            if mod_name in originals:
                sys.modules[mod_name] = originals[mod_name]
            elif mod_name in sys.modules:
                del sys.modules[mod_name]


# =========================================================================
# _get_config_state
# =========================================================================

class TestGetConfigState:
    """Tests for DaemonManager._get_config_state."""

    @patch("services.daemons.daemon_manager.get_settings")
    def test_all_disabled(self, mock_settings):
        """All daemons disabled → config reflects that."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        state = mgr._get_config_state()
        assert state["enabled"] is True
        assert state["browser_enabled"] is False
        assert state["email_enabled"] is False

    @patch("services.daemons.daemon_manager.get_settings")
    def test_some_enabled(self, mock_settings):
        """Some daemons enabled → config reflects that."""
        mock_settings.return_value = _make_settings({
            "browser_enabled": True,
            "email_enabled": True,
        })
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        state = mgr._get_config_state()
        assert state["browser_enabled"] is True
        assert state["email_enabled"] is True
        assert state["file_system_enabled"] is False

    @patch("services.daemons.daemon_manager.get_settings")
    def test_runtime_config_disables_all(self, mock_settings, tmp_path):
        """Runtime config file with enabled=False → all disabled."""
        mock_settings.return_value = _make_settings(
            {"browser_enabled": True}, app_root=tmp_path
        )
        from services.daemons.daemon_manager import DaemonManager
        
        # Write runtime config to the path the unified reader will check
        config_dir = tmp_path / "data" / "runtime"
        config_dir.mkdir(parents=True, exist_ok=True)
        config_file = config_dir / "proactive_config.json"
        config_file.write_text(json.dumps({"enabled": False}))
        
        mgr = DaemonManager()
        state = mgr._get_config_state()
        assert state == {"enabled": False}

    @patch("services.daemons.daemon_manager.get_settings")
    def test_error_returns_empty(self, mock_settings):
        """Exception during config read → empty dict."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        # Break the settings object so proactive.daemons raises
        mgr.settings = MagicMock()
        mgr.settings.proactive.daemons = PropertyMock(side_effect=Exception("Config error"))
        type(mgr.settings.proactive).daemons = PropertyMock(side_effect=Exception("Config error"))
        state = mgr._get_config_state()
        assert state == {}


# =========================================================================
# _write_pid / _remove_pid
# =========================================================================

class TestPidManagement:
    """Tests for DaemonManager._write_pid and _remove_pid."""

    @patch("services.daemons.daemon_manager.get_settings")
    def test_write_pid(self, mock_settings):
        """Writes current PID to PID file."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager, PID_FILE
        mgr = DaemonManager()
        mgr._write_pid()
        try:
            assert PID_FILE.exists()
            assert PID_FILE.read_text() == str(os.getpid())
        finally:
            if PID_FILE.exists():
                PID_FILE.unlink()

    @patch("services.daemons.daemon_manager.get_settings")
    def test_remove_pid(self, mock_settings):
        """Removes PID file on shutdown."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager, PID_FILE
        mgr = DaemonManager()
        mgr._lock_fd = MagicMock()  # Mock lock acquisition
        mgr._write_pid()
        assert PID_FILE.exists()
        mgr._remove_pid()
        assert not PID_FILE.exists()

    @patch("services.daemons.daemon_manager.get_settings")
    def test_remove_pid_when_not_exists(self, mock_settings):
        """Removing non-existent PID file → no error."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager, PID_FILE
        mgr = DaemonManager()
        if PID_FILE.exists():
            PID_FILE.unlink()
        mgr._remove_pid()  # Should not raise


# =========================================================================
# _acquire_singleton_lock
# =========================================================================

class TestAcquireSingletonLock:
    """Tests for DaemonManager._acquire_singleton_lock."""

    @patch("services.daemons.daemon_manager.get_settings")
    @patch("services.daemons.daemon_manager.fcntl.flock")
    def test_acquires_lock(self, mock_flock, mock_settings):
        """Successfully acquires exclusive lock."""
        mock_settings.return_value = _make_settings()
        mock_flock.return_value = None  # flock succeeds
        from services.daemons.daemon_manager import DaemonManager, LOCK_FILE
        LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
        mgr = DaemonManager()
        try:
            result = mgr._acquire_singleton_lock()
            assert result is True
            assert mgr._lock_fd is not None
        finally:
            if mgr._lock_fd:
                mgr._lock_fd.close()
                mgr._lock_fd = None

    @patch("services.daemons.daemon_manager.get_settings")
    @patch("services.daemons.daemon_manager.fcntl.flock")
    def test_lock_held_returns_false(self, mock_flock, mock_settings):
        """Lock already held → returns False."""
        mock_settings.return_value = _make_settings()
        mock_flock.side_effect = OSError("Resource temporarily unavailable")
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        result = mgr._acquire_singleton_lock()
        assert result is False
        assert mgr._lock_fd is None


# =========================================================================
# _on_daemon_task_done
# =========================================================================

class TestOnDaemonTaskDone:
    """Tests for DaemonManager._on_daemon_task_done."""

    @patch("services.daemons.daemon_manager.get_settings")
    def test_not_running_no_restart(self, mock_settings):
        """Manager not running → no restart scheduled."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = False

        task = MagicMock()
        task.cancelled.return_value = False
        task.exception.return_value = None
        mgr._daemon_tasks["browser"] = task

        with patch("asyncio.create_task") as mock_create:
            mgr._on_daemon_task_done("browser", task)
            mock_create.assert_not_called()

    @patch("services.daemons.daemon_manager.get_settings")
    def test_stopping_daemons_suppresses_restart(self, mock_settings):
        """During _stop_daemons → restart suppressed."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr._stopping_daemons = True

        task = MagicMock()
        task.cancelled.return_value = False
        task.exception.return_value = RuntimeError("crash")
        mgr._daemon_tasks["email"] = task

        with patch("asyncio.create_task") as mock_create:
            mgr._on_daemon_task_done("email", task)
            mock_create.assert_not_called()

    @patch("services.daemons.daemon_manager.get_settings")
    def test_crash_schedules_restart(self, mock_settings):
        """Daemon crash while running → restart scheduled."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = True
        mgr._stopping_daemons = False

        task = MagicMock()
        task.cancelled.return_value = False
        task.exception.return_value = RuntimeError("crash")
        mgr._daemon_tasks["browser"] = task

        with patch("asyncio.create_task") as mock_create:
            mgr._on_daemon_task_done("browser", task)
            mock_create.assert_called_once()

    @patch("services.daemons.daemon_manager.get_settings")
    def test_crash_stops_restarting_after_retry_budget(self, mock_settings):
        """Crash loops stop after max retry budget is exhausted."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = True
        mgr._stopping_daemons = False
        mgr._restart_max_retries = 2
        mgr._restart_base_seconds = 1
        mgr._restart_max_seconds = 8
        mgr._restart_reset_after_seconds = 9999

        with patch("asyncio.create_task") as mock_create:
            for _ in range(3):
                task = MagicMock()
                task.cancelled.return_value = False
                task.exception.return_value = RuntimeError("crash")
                mgr._daemon_tasks["browser"] = task
                mgr._on_daemon_task_done("browser", task)

        # First 2 crashes schedule restart, third exceeds budget and is suppressed.
        assert mock_create.call_count == 2

    @patch("services.daemons.daemon_manager.get_settings")
    def test_removes_from_daemon_tasks(self, mock_settings):
        """Completed task is removed from _daemon_tasks."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = False

        task = MagicMock()
        task.cancelled.return_value = True
        mgr._daemon_tasks["browser"] = task

        mgr._on_daemon_task_done("browser", task)
        assert "browser" not in mgr._daemon_tasks


# =========================================================================
# _restart_daemon
# =========================================================================

class TestRestartDaemon:
    """Tests for DaemonManager._restart_daemon."""

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_not_running_skips(self, mock_settings):
        """Manager not running during cooldown → skip restart."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = False

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await mgr._restart_daemon("browser")
        assert "browser" not in mgr._daemon_tasks

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_already_tracked_skips(self, mock_settings):
        """Daemon already recreated (tracked) → skip restart."""
        mock_settings.return_value = _make_settings({"browser_enabled": True})
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = True
        mgr._daemon_tasks["browser"] = MagicMock()  # Already tracked

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await mgr._restart_daemon("browser")
        # Should not have added a second entry

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_unknown_daemon_logged(self, mock_settings):
        """Unknown daemon name → logged, no crash."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = True

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await mgr._restart_daemon("unknown_daemon")
        assert "unknown_daemon" not in mgr._daemon_tasks

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_disabled_daemon_skips(self, mock_settings):
        """Daemon disabled in config → skip restart."""
        mock_settings.return_value = _make_settings({"browser_enabled": False})
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = True

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await mgr._restart_daemon("browser")
        assert "browser" not in mgr._daemon_tasks


class TestRestartDelayPolicy:
    """Tests for bounded exponential restart delay policy."""

    @patch("services.daemons.daemon_manager.get_settings")
    def test_delay_grows_exponentially_and_caps(self, mock_settings):
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr._restart_base_seconds = 10
        mgr._restart_max_seconds = 15
        mgr._restart_max_retries = 5

        delays = [
            mgr._compute_restart_delay("browser", runtime_seconds=0),
            mgr._compute_restart_delay("browser", runtime_seconds=0),
            mgr._compute_restart_delay("browser", runtime_seconds=0),
        ]

        assert delays == [10, 15, 15]

    @patch("services.daemons.daemon_manager.get_settings")
    def test_stable_runtime_resets_failure_counter(self, mock_settings):
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr._restart_base_seconds = 5
        mgr._restart_max_seconds = 60
        mgr._restart_max_retries = 5
        mgr._restart_reset_after_seconds = 120
        mgr._restart_failures["browser"] = 4

        delay = mgr._compute_restart_delay("browser", runtime_seconds=240)
        assert delay == 5
        assert mgr._restart_failures["browser"] == 1


# =========================================================================
# _start_daemons
# =========================================================================

class TestStartDaemons:
    """Tests for DaemonManager._start_daemons."""

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_disabled_system_no_start(self, mock_settings):
        """Proactive system disabled → no daemons started."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.config_state = {"enabled": False}
        await mgr._start_daemons()
        assert len(mgr.daemons) == 0

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_no_daemons_enabled(self, mock_settings):
        """All daemons disabled → empty list, warning logged."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.config_state = {"enabled": True}
        await mgr._start_daemons()
        assert len(mgr.daemons) == 0


# =========================================================================
# _stop_daemons
# =========================================================================

class TestStopDaemons:
    """Tests for DaemonManager._stop_daemons."""

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_stops_all_daemons(self, mock_settings):
        """All daemons stopped and cleared."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()

        daemon1 = AsyncMock()
        daemon2 = AsyncMock()
        mgr.daemons = [("browser", daemon1), ("email", daemon2)]
        mgr._daemon_tasks = {}

        await mgr._stop_daemons()

        daemon1.stop.assert_awaited_once()
        daemon2.stop.assert_awaited_once()
        assert len(mgr.daemons) == 0
        assert len(mgr._daemon_tasks) == 0
        assert mgr._stopping_daemons is False

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_sets_stopping_flag(self, mock_settings):
        """_stopping_daemons flag set during stop, cleared after."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.daemons = []
        mgr._daemon_tasks = {}

        # Track flag state during execution
        flag_during = None
        original_clear = mgr.daemons.clear

        await mgr._stop_daemons()
        assert mgr._stopping_daemons is False

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_stop_error_handled(self, mock_settings):
        """Error stopping a daemon doesn't prevent others from stopping."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()

        daemon1 = AsyncMock()
        daemon1.stop.side_effect = RuntimeError("stop failed")
        daemon2 = AsyncMock()
        mgr.daemons = [("browser", daemon1), ("email", daemon2)]
        mgr._daemon_tasks = {}

        await mgr._stop_daemons()
        daemon2.stop.assert_awaited_once()
        assert len(mgr.daemons) == 0

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_cancels_pending_tasks(self, mock_settings):
        """Pending daemon tasks are cancelled."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()

        # Create a real-ish task that asyncio.shield/wait_for can handle
        async def _dummy():
            await asyncio.sleep(100)

        real_task = asyncio.create_task(_dummy())
        mgr.daemons = []
        mgr._daemon_tasks = {"browser": real_task}

        await mgr._stop_daemons()
        assert real_task.cancelled()
        assert len(mgr._daemon_tasks) == 0


# =========================================================================
# stop_all
# =========================================================================

class TestStopAll:
    """Tests for DaemonManager.stop_all."""

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_sets_flags(self, mock_settings):
        """Sets running=False, _is_disposed=True."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.daemons = []
        mgr._daemon_tasks = {}
        mgr._config_watcher_task = None

        await mgr.stop_all()
        assert mgr.running is False
        assert mgr._is_disposed is True

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_double_dispose_guard(self, mock_settings):
        """Calling stop_all twice → second call is no-op."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.daemons = []
        mgr._daemon_tasks = {}
        mgr._config_watcher_task = None

        await mgr.stop_all()
        first_disposed = mgr._is_disposed
        await mgr.stop_all()  # Should not raise
        assert first_disposed is True

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_cancels_config_watcher(self, mock_settings):
        """Config watcher task is cancelled during stop_all."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.daemons = []
        mgr._daemon_tasks = {}

        # Create a real task that asyncio.shield/wait_for can handle
        async def _dummy():
            await asyncio.sleep(100)

        watcher = asyncio.create_task(_dummy())
        mgr._config_watcher_task = watcher

        await mgr.stop_all()
        assert watcher.cancelled()
        assert mgr._config_watcher_task is None


# =========================================================================
# start_all (integration-level)
# =========================================================================

class TestStartAll:
    """Tests for DaemonManager.start_all."""

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_lock_fails_exits_gracefully(self, mock_settings):
        """Singleton lock failure → exits without error."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        
        with patch.object(mgr, "_acquire_singleton_lock", return_value=False):
            await mgr.start_all()
            # Should have exited cleanly, not started daemons
            assert len(mgr.daemons) == 0

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_exception_during_start_removes_pid(self, mock_settings):
        """Exception during startup → PID file still cleaned up in finally."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        
        with patch.object(mgr, "_acquire_singleton_lock", return_value=True), \
             patch.object(mgr, "_write_pid"), \
             patch.object(mgr, "_start_daemons", side_effect=RuntimeError("startup crash")), \
             patch.object(mgr, "_remove_pid") as mock_remove:
            with pytest.raises(RuntimeError):
                await mgr.start_all()
            mock_remove.assert_called_once()


# =========================================================================
# Constructor
# =========================================================================

class TestConstructor:
    """Tests for DaemonManager.__init__."""

    @patch("services.daemons.daemon_manager.get_settings")
    def test_initial_state(self, mock_settings):
        """Fresh manager has correct initial state."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        assert mgr.running is True
        assert mgr._is_disposed is False
        assert mgr._stopping_daemons is False
        assert mgr.reload_requested is False
        assert mgr.daemons == []
        assert mgr._daemon_tasks == {}
        assert mgr._config_watcher_task is None
        assert mgr._lock_fd is None


# =========================================================================
# Additional coverage: _remove_pid flock release
# =========================================================================

class TestRemovePidFlockRelease:
    """Coverage for _remove_pid releasing the flock (lines 154-160)."""

    @patch("services.daemons.daemon_manager.get_settings")
    @patch("services.daemons.daemon_manager.fcntl")
    def test_remove_pid_releases_flock(self, mock_fcntl, mock_settings):
        """_remove_pid releases flock and closes fd."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager, PID_FILE
        mgr = DaemonManager()
        # Simulate having a lock fd
        mock_fd = MagicMock()
        mgr._lock_fd = mock_fd

        # Create a PID file to satisfy the first part of _remove_pid
        PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(str(os.getpid()))

        mgr._remove_pid()

        mock_fcntl.flock.assert_called_once_with(mock_fd, mock_fcntl.LOCK_UN)
        mock_fd.close.assert_called_once()
        assert mgr._lock_fd is None

        # Cleanup
        if PID_FILE.exists():
            PID_FILE.unlink()

    @patch("services.daemons.daemon_manager.get_settings")
    @patch("services.daemons.daemon_manager.fcntl")
    def test_remove_pid_flock_error_handled(self, mock_fcntl, mock_settings):
        """flock release failure is logged, not raised."""
        mock_settings.return_value = _make_settings()
        mock_fcntl.flock.side_effect = OSError("lock release failed")
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr._lock_fd = MagicMock()

        mgr._remove_pid()  # Should not raise

    @patch("services.daemons.daemon_manager.get_settings")
    def test_write_pid_error_handled(self, mock_settings):
        """_write_pid error when parent dir missing — logged, not raised."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()

        with patch("services.daemons.daemon_manager.PID_FILE") as mock_pid:
            mock_pid.write_text.side_effect = PermissionError("denied")
            mgr._write_pid()  # Should not raise


# =========================================================================
# Additional coverage: _watch_config
# =========================================================================

class TestWatchConfig:
    """Coverage for _watch_config loop (lines 162-179)."""

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_config_change_triggers_reload(self, mock_settings):
        """Config change sets reload_requested = True."""
        mock_settings.return_value = _make_settings({"browser_enabled": False})
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.config_state = {"enabled": True, "browser_enabled": False}

        call_count = 0

        async def _mock_sleep(n):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                mgr.running = False  # Stop the loop after one check

        # On second call, settings change
        def _new_settings():
            s = _make_settings({"browser_enabled": True})
            mock_settings.return_value = s
            return s

        mock_settings.side_effect = [
            _make_settings({"browser_enabled": True}),  # Changed config
        ]

        with patch("asyncio.sleep", side_effect=_mock_sleep):
            await mgr._watch_config()

        assert mgr.reload_requested is True

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_config_watch_error_continues(self, mock_settings):
        """Exception in watch_config is caught, loop continues."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()

        call_count = 0

        async def _mock_sleep(n):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise Exception("transient error")
            mgr.running = False

        with patch("asyncio.sleep", side_effect=_mock_sleep):
            await mgr._watch_config()


# =========================================================================
# Additional coverage: _start_daemons with enabled daemons
# =========================================================================

class TestStartDaemonsWithEnabled:
    """Coverage for lines 273-344: actually starting enabled daemons."""

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_starts_browser_daemon(self, mock_settings):
        """Browser daemon enabled — creates and tracks task."""
        mock_settings.return_value = _make_settings({"browser_enabled": True})
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.config_state = {"enabled": True, "browser_enabled": True}

        mock_config_cls = MagicMock()
        mock_daemon_cls = MagicMock()
        mock_daemon_instance = AsyncMock()
        mock_daemon_cls.return_value = mock_daemon_instance

        with patch("services.daemons.daemon_manager.BrowserDaemonConfig", mock_config_cls), \
             patch("services.daemons.daemon_manager.BrowserDaemon", mock_daemon_cls):

            await mgr._start_daemons()

        assert len(mgr.daemons) >= 1
        names = [n for n, _ in mgr.daemons]
        assert "browser" in names
        assert "browser" in mgr._daemon_tasks

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_daemon_start_error_continues(self, mock_settings):
        """One daemon fails to start — others still start."""
        mock_settings.return_value = _make_settings({
            "browser_enabled": True,
            "email_enabled": True,
        })
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.config_state = {"enabled": True, "browser_enabled": True, "email_enabled": True}

        mock_email_daemon = AsyncMock()

        with patch("services.daemons.daemon_manager.BrowserDaemonConfig") as mock_bc, \
             patch("services.daemons.daemon_manager.BrowserDaemon", side_effect=Exception("browser init failed")), \
             patch("services.daemons.daemon_manager.EmailDaemonConfig") as mock_ec, \
             patch("services.daemons.daemon_manager.EmailDaemon", return_value=mock_email_daemon):

            await mgr._start_daemons()

        # Browser failed but email should have been added
        names = [n for n, _ in mgr.daemons]
        assert "browser" not in names
        assert "email" in names


# =========================================================================
# Additional coverage: _on_daemon_task_done clean exit
# =========================================================================

class TestOnDaemonTaskDoneCleanExit:
    """Coverage for line 204: clean exit (no exception, not cancelled)."""

    @patch("services.daemons.daemon_manager.get_settings")
    def test_clean_exit_schedules_restart(self, mock_settings):
        """Daemon exits cleanly (no exception) while running — schedules restart."""
        mock_settings.return_value = _make_settings()
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = True
        mgr._stopping_daemons = False

        task = MagicMock()
        task.cancelled.return_value = False
        task.exception.return_value = None  # Clean exit — no exception
        mgr._daemon_tasks["browser"] = task

        with patch("asyncio.create_task") as mock_create:
            mgr._on_daemon_task_done("browser", task)
            mock_create.assert_called_once()  # Restart scheduled


# =========================================================================
# Config state-based enabled checks (_start_daemons + _restart_daemon)
#
# Verifies CHANGE 2 Part E: per-daemon enabled checks use
# self.config_state (runtime, from proactive_config.json) NOT
# self.settings.proactive.daemons (static, from Pydantic Settings).
# =========================================================================

class TestConfigStateEnabledChecks:
    """Tests that _start_daemons and _restart_daemon respect config_state over settings."""

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_start_daemons_uses_config_state_not_settings(self, mock_settings):
        """config_state says browser disabled, settings says enabled → browser NOT started.

        This is the core test for CHANGE 2 Part E. Before the fix, _start_daemons()
        used self.settings.proactive.daemons.browser_enabled directly, ignoring runtime
        toggles written by PATCH /v1/proactive/config.
        """
        mock_settings.return_value = _make_settings({
            "browser_enabled": True,  # Settings says ON
            "email_enabled": True,    # Settings says ON
        })
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        # Runtime config overrides: browser OFF, email ON
        mgr.config_state = {
            "enabled": True,
            "browser_enabled": False,   # Runtime says OFF — should win
            "email_enabled": True,
        }

        mock_email_daemon = AsyncMock()
        with patch("services.daemons.daemon_manager.BrowserDaemonConfig") as mock_bc, \
             patch("services.daemons.daemon_manager.BrowserDaemon") as mock_bd, \
             patch("services.daemons.daemon_manager.EmailDaemonConfig") as mock_ec, \
             patch("services.daemons.daemon_manager.EmailDaemon", return_value=mock_email_daemon):

            await mgr._start_daemons()

        # Browser should NOT have been instantiated (config_state says False)
        mock_bd.assert_not_called()
        # Email SHOULD have been started (config_state says True)
        names = [n for n, _ in mgr.daemons]
        assert "browser" not in names
        assert "email" in names

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_start_daemons_falls_back_to_settings_when_key_missing(self, mock_settings):
        """config_state missing a key → falls back to settings.proactive.daemons.

        This tests the fallback path: self.config_state.get('X', settings_daemons.X).
        When config_state doesn't have the key, settings is the authority.
        """
        mock_settings.return_value = _make_settings({"browser_enabled": True})
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        # config_state has enabled but NOT browser_enabled — should fall back
        mgr.config_state = {"enabled": True}

        mock_browser_daemon = AsyncMock()
        with patch("services.daemons.daemon_manager.BrowserDaemonConfig") as mock_bc, \
             patch("services.daemons.daemon_manager.BrowserDaemon", return_value=mock_browser_daemon):

            await mgr._start_daemons()

        # Should fall back to settings which says browser_enabled=True
        names = [n for n, _ in mgr.daemons]
        assert "browser" in names

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_restart_daemon_uses_config_state(self, mock_settings):
        """_restart_daemon respects config_state for the target daemon.

        If runtime config disables a daemon, crash-restart should NOT revive it.
        This was the pre-existing bug: _restart_daemon used settings, so a daemon
        disabled at runtime via PATCH would zombie-restart after crashes.
        """
        mock_settings.return_value = _make_settings({"browser_enabled": True})
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.running = True
        # Runtime config says browser is disabled (user toggled off via UI).
        # _restart_daemon refreshes config_state via _get_config_state(), so
        # mock that method to return the runtime-disabled state.
        desired_state = {
            "enabled": True,
            "browser_enabled": False,  # Disabled at runtime
        }

        with patch("asyncio.sleep", new_callable=AsyncMock), \
             patch.object(mgr, "_get_config_state", return_value=desired_state):
            await mgr._restart_daemon("browser")

        # Browser should NOT have been restarted despite settings saying enabled
        assert "browser" not in mgr._daemon_tasks

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_config_state_enables_previously_disabled_daemon(self, mock_settings):
        """Runtime config can ENABLE a daemon that settings has disabled.

        This verifies bidirectional override: config_state=True overrides settings=False.
        """
        mock_settings.return_value = _make_settings({
            "browser_enabled": False,  # Settings says OFF
        })
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        mgr.config_state = {
            "enabled": True,
            "browser_enabled": True,  # Runtime says ON — should win
        }

        mock_browser_daemon = AsyncMock()
        with patch("services.daemons.daemon_manager.BrowserDaemonConfig") as mock_bc, \
             patch("services.daemons.daemon_manager.BrowserDaemon", return_value=mock_browser_daemon):

            await mgr._start_daemons()

        names = [n for n, _ in mgr.daemons]
        assert "browser" in names

    @patch("services.daemons.daemon_manager.get_settings")
    async def test_start_daemons_all_five_respect_config_state(self, mock_settings):
        """All 5 daemon types respect config_state independently.

        Verifies that each daemon's enabled check reads from config_state,
        not from a shared flag or settings-only path.
        """
        mock_settings.return_value = _make_settings({
            "browser_enabled": False,
            "email_enabled": False,
            "file_system_enabled": False,
            "query_generation_enabled": False,
            "file_indexing_enabled": False,
        })
        from services.daemons.daemon_manager import DaemonManager
        mgr = DaemonManager()
        # Runtime enables browser and filesystem ONLY
        mgr.config_state = {
            "enabled": True,
            "browser_enabled": True,
            "email_enabled": False,
            "file_system_enabled": True,
            "query_generation_enabled": False,
            "file_indexing_enabled": False,
        }

        mock_browser_daemon = AsyncMock()
        mock_fs_daemon = AsyncMock()

        with patch("services.daemons.daemon_manager.BrowserDaemonConfig"), \
             patch("services.daemons.daemon_manager.BrowserDaemon", return_value=mock_browser_daemon), \
             patch("services.daemons.daemon_manager.EmailDaemonConfig"), \
             patch("services.daemons.daemon_manager.EmailDaemon") as mock_ed, \
             patch("services.daemons.daemon_manager.FileSystemDaemonConfig"), \
             patch("services.daemons.daemon_manager.FileSystemDaemon", return_value=mock_fs_daemon), \
             patch("services.daemons.daemon_manager.QueryGenerationDaemonConfig"), \
             patch("services.daemons.daemon_manager.QueryGenerationDaemon") as mock_qd, \
             patch("services.daemons.daemon_manager.IndexingServiceConfig"), \
             patch("services.daemons.daemon_manager.FileIndexingDaemon") as mock_fid:

            await mgr._start_daemons()

        names = [n for n, _ in mgr.daemons]
        assert "browser" in names
        assert "filesystem" in names
        assert "email" not in names
        assert "query_generation" not in names
        assert "file_indexing" not in names
        # Verify email, query_gen, file_indexing constructors never called
        mock_ed.assert_not_called()
        mock_qd.assert_not_called()
        mock_fid.assert_not_called()
