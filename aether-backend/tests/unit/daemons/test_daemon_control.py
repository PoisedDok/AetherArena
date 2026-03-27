"""
Unit tests for daemon_control.py — process lifecycle management.

Tests the critical invariants:
- start_daemon_manager() NEVER kills existing daemon-manager processes
- start_daemon_manager() adopts a running daemon-manager (returns True without spawning)
- start_daemon_manager() spawns a new one only when none is running
- is_daemon_manager_running() validates PID identity via psutil, cleans stale PID files
- ensure_daemons_running() state matrix: enabled/disabled x running/stopped
- stop_daemon_manager() sends SIGTERM, waits, escalates to SIGKILL
- reload_daemon_manager() sends SIGHUP, falls back to start if not running
- DaemonManager singleton flock prevents duplicate instances

No external services required — all process interactions are mocked.
"""
import fcntl
import os
import signal
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock, PropertyMock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


# =========================================================================
# Fixtures
# =========================================================================

@pytest.fixture
def tmp_pid_file(tmp_path):
    """Provide a temporary PID file path and patch daemon_control.PID_FILE and LOCK_FILE."""
    pid_file = tmp_path / "daemon_manager.pid"
    lock_file = tmp_path / "daemon_manager.lock"
    with patch("services.daemons.daemon_control.PID_FILE", pid_file), \
         patch("services.daemons.daemon_control.LOCK_FILE", lock_file):
        yield pid_file


@pytest.fixture
def tmp_lock_file(tmp_path):
    """Provide a temporary lock file path for daemon_manager.LOCK_FILE."""
    lock_file = tmp_path / "daemon_manager.lock"
    return lock_file


# =========================================================================
# 1. is_daemon_manager_running() — PID verification
# =========================================================================

class TestIsDaemonManagerRunning:
    """Verify PID file validation logic."""

    def test_returns_false_when_no_pid_file(self, tmp_pid_file):
        from services.daemons import daemon_control
        assert tmp_pid_file.exists() is False
        # Ensure lock file also doesn't exist (isolation from other tests)
        with patch.object(daemon_control, 'LOCK_FILE') as mock_lock:
            mock_lock.exists.return_value = False
            assert daemon_control.is_daemon_manager_running() is False

    def test_returns_true_when_pid_is_daemon_manager(self, tmp_pid_file):
        from services.daemons.daemon_control import is_daemon_manager_running
        tmp_pid_file.write_text("12345")

        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["python3", "daemon_manager.py"]

        with patch("os.kill") as mock_kill, \
             patch("psutil.Process", return_value=mock_proc):
            mock_kill.return_value = None  # Process exists
            assert is_daemon_manager_running() is True

    def test_returns_true_for_frozen_binary_format(self, tmp_pid_file):
        """Prod binary uses 'aether-hub daemon-manager' (hyphen)."""
        from services.daemons.daemon_control import is_daemon_manager_running
        tmp_pid_file.write_text("12345")

        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["/path/to/aether-hub", "daemon-manager"]

        with patch("os.kill") as mock_kill, \
             patch("psutil.Process", return_value=mock_proc):
            mock_kill.return_value = None
            assert is_daemon_manager_running() is True

    def test_cleans_stale_pid_when_process_dead(self, tmp_pid_file):
        """Process doesn't exist — PID file should be cleaned."""
        from services.daemons.daemon_control import is_daemon_manager_running
        tmp_pid_file.write_text("99999")

        with patch("os.kill", side_effect=OSError("No such process")):
            assert is_daemon_manager_running() is False
        assert tmp_pid_file.exists() is False

    def test_cleans_stale_pid_when_pid_reused_by_other_process(self, tmp_pid_file):
        """PID alive but not a daemon_manager — stale file, clean it."""
        from services.daemons.daemon_control import is_daemon_manager_running
        tmp_pid_file.write_text("12345")

        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["/usr/bin/python3", "some_other_script.py"]

        with patch("os.kill") as mock_kill, \
             patch("psutil.Process", return_value=mock_proc):
            mock_kill.return_value = None
            assert is_daemon_manager_running() is False
        assert tmp_pid_file.exists() is False

    def test_corrupt_pid_file_returns_false(self, tmp_pid_file):
        """PID file with non-numeric content — ValueError caught, returns False."""
        from services.daemons import daemon_control
        tmp_pid_file.write_text("not-a-number")
        # Ensure lock file doesn't exist (isolation from other tests)
        with patch.object(daemon_control, 'LOCK_FILE') as mock_lock:
            mock_lock.exists.return_value = False
            assert daemon_control.is_daemon_manager_running() is False

    def test_psutil_access_denied_cleans_stale(self, tmp_pid_file):
        """psutil.AccessDenied during identity check — treat as stale."""
        import psutil as _psutil
        from services.daemons.daemon_control import is_daemon_manager_running
        tmp_pid_file.write_text("12345")

        with patch("os.kill") as mock_kill, \
             patch("psutil.Process", side_effect=_psutil.AccessDenied(12345)):
            mock_kill.return_value = None
            assert is_daemon_manager_running() is False
        assert tmp_pid_file.exists() is False

    def test_empty_pid_file_returns_false(self, tmp_pid_file):
        """Empty PID file — strip() gives '', int('') raises ValueError."""
        from services.daemons import daemon_control
        tmp_pid_file.write_text("")
        # Ensure lock file doesn't exist (isolation from other tests)
        with patch.object(daemon_control, 'LOCK_FILE') as mock_lock:
            mock_lock.exists.return_value = False
            assert daemon_control.is_daemon_manager_running() is False


# =========================================================================
# 2. start_daemon_manager() — CRITICAL: non-destructive lifecycle
# =========================================================================

class TestStartDaemonManager:
    """The most critical tests: start must NEVER kill existing processes."""

    def test_adopts_running_daemon_manager_without_spawning(self, tmp_pid_file):
        """If daemon-manager is already running, adopt it. No Popen. No kill."""
        from services.daemons.daemon_control import start_daemon_manager
        tmp_pid_file.write_text("12345")

        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["python3", "daemon_manager.py"]

        with patch("os.kill") as mock_kill, \
             patch("psutil.Process", return_value=mock_proc), \
             patch("subprocess.Popen") as mock_popen:
            mock_kill.return_value = None
            result = start_daemon_manager()

        assert result is True
        # CRITICAL: Popen was NEVER called — no new process spawned
        mock_popen.assert_not_called()

    def test_no_kill_calls_when_adopting(self, tmp_pid_file):
        """Verify that no signal other than 0 (existence check) is sent."""
        from services.daemons.daemon_control import start_daemon_manager
        tmp_pid_file.write_text("12345")

        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["python3", "daemon_manager.py"]

        kill_calls = []
        original_kill = os.kill

        def tracking_kill(pid, sig):
            kill_calls.append((pid, sig))
            if sig == 0:
                return None
            raise OSError("Should not send real signals in adoption path")

        with patch("os.kill", side_effect=tracking_kill), \
             patch("psutil.Process", return_value=mock_proc), \
             patch("subprocess.Popen"):
            start_daemon_manager()

        # Only signal 0 (existence check) should have been sent
        for pid, sig in kill_calls:
            assert sig == 0, f"Unexpected signal {sig} sent to PID {pid} during adoption"

    def test_spawns_new_when_none_running(self, tmp_pid_file):
        """No daemon-manager running — should spawn via Popen."""
        from services.daemons.daemon_control import start_daemon_manager

        # After Popen, simulate daemon writing PID file
        def write_pid_on_start(*args, **kwargs):
            tmp_pid_file.write_text("54321")
            mock = MagicMock()
            mock.pid = 54321
            return mock

        mock_proc_verify = MagicMock()
        mock_proc_verify.cmdline.return_value = ["python3", "daemon_manager.py"]
        mock_proc_verify.ppid.return_value = 1

        with patch("subprocess.Popen", side_effect=write_pid_on_start) as mock_popen, \
             patch("os.kill") as mock_kill, \
             patch("psutil.Process", return_value=mock_proc_verify), \
             patch("services.daemons.daemon_control.is_daemon_manager_running", side_effect=[False, True]), \
             patch("services.daemons.daemon_control.is_onboarding_setup_mode", return_value=False), \
             patch("time.sleep"):
            mock_kill.return_value = None
            result = start_daemon_manager()

        assert result is True
        mock_popen.assert_called_once()

    def test_no_kill_stale_function_exists(self):
        """Verify _kill_stale_daemon_managers was removed from the module."""
        import services.daemons.daemon_control as mod
        assert not hasattr(mod, "_kill_stale_daemon_managers"), \
            "_kill_stale_daemon_managers must not exist — it is destructive"


# =========================================================================
# 3. stop_daemon_manager() — graceful SIGTERM with SIGKILL escalation
# =========================================================================

class TestStopDaemonManager:

    def test_sends_sigterm_first(self, tmp_pid_file):
        from services.daemons.daemon_control import stop_daemon_manager
        tmp_pid_file.write_text("12345")

        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["python3", "daemon_manager.py"]

        call_log = []

        def track_kill(pid, sig):
            call_log.append((pid, sig))
            # After SIGTERM, simulate process stopping
            if sig == signal.SIGTERM:
                return None

        stop_count = [0]

        def fake_is_running():
            stop_count[0] += 1
            # First call: running. Second+: stopped.
            if stop_count[0] <= 1:
                return True
            return False

        with patch("os.kill", side_effect=track_kill), \
             patch("psutil.Process", return_value=mock_proc), \
             patch("services.daemons.daemon_control.is_daemon_manager_running",
                   side_effect=fake_is_running), \
             patch("services.daemons.daemon_control.get_daemon_manager_pid",
                   return_value=12345), \
             patch("time.sleep"):
            result = stop_daemon_manager()

        assert result is True
        # Exactly one SIGTERM to PID 12345 (source sends os.kill(pid, SIGTERM) once)
        sigterm_calls = [(p, s) for p, s in call_log if s == signal.SIGTERM]
        assert len(sigterm_calls) == 1
        assert sigterm_calls[0] == (12345, signal.SIGTERM)
        # No SIGKILL (graceful stop succeeded on second is_running check)
        sigkill_calls = [(p, s) for p, s in call_log if s == signal.SIGKILL]
        assert len(sigkill_calls) == 0

    def test_returns_true_when_not_running(self, tmp_pid_file):
        from services.daemons.daemon_control import stop_daemon_manager

        with patch("services.daemons.daemon_control.get_daemon_manager_pid",
                   return_value=None), \
             patch("os.kill") as mock_kill:
            result = stop_daemon_manager()

        assert result is True
        # No signals sent — nothing to stop
        mock_kill.assert_not_called()


# =========================================================================
# 4. reload_daemon_manager() — SIGHUP delivery
# =========================================================================

class TestReloadDaemonManager:

    def test_sends_sighup_to_running_manager(self, tmp_pid_file):
        from services.daemons.daemon_control import reload_daemon_manager

        call_log = []

        def track_kill(pid, sig):
            call_log.append((pid, sig))

        with patch("services.daemons.daemon_control.get_daemon_manager_pid",
                   return_value=12345), \
             patch("os.kill", side_effect=track_kill):
            result = reload_daemon_manager()

        assert result is True
        sighup_calls = [(p, s) for p, s in call_log if s == signal.SIGHUP]
        assert len(sighup_calls) == 1
        assert sighup_calls[0] == (12345, signal.SIGHUP)

    def test_starts_daemon_if_not_running(self, tmp_pid_file):
        from services.daemons.daemon_control import reload_daemon_manager

        with patch("services.daemons.daemon_control.get_daemon_manager_pid",
                   return_value=None), \
             patch("services.daemons.daemon_control.start_daemon_manager",
                   return_value=True) as mock_start:
            result = reload_daemon_manager()

        assert result is True
        mock_start.assert_called_once()


# =========================================================================
# 5. ensure_daemons_running() — state matrix
# =========================================================================

class TestEnsureDaemonsRunning:
    """Test all 4 states: enabled/disabled x running/stopped."""

    def _make_settings(self, *, master_enabled=True, any_daemon=True):
        """Create mock settings object."""
        settings = MagicMock()
        settings.app_root = "/tmp/fake_root"
        settings.proactive.enabled = master_enabled
        settings.proactive.daemons.browser_enabled = any_daemon
        settings.proactive.daemons.email_enabled = False
        settings.proactive.daemons.file_system_enabled = False
        settings.proactive.daemons.query_generation_enabled = False
        settings.proactive.daemons.file_indexing_enabled = False
        return settings

    @pytest.mark.asyncio
    async def test_enabled_and_running_sends_reload(self, tmp_pid_file):
        """Enabled + Running = Adopt + SIGHUP for config sync."""
        from services.daemons.daemon_control import ensure_daemons_running

        settings = self._make_settings(master_enabled=True, any_daemon=True)

        with patch("services.daemons.daemon_control.is_daemon_manager_running",
                   return_value=True), \
             patch("services.daemons.daemon_control.get_daemon_manager_pid",
                   return_value=12345), \
             patch("services.daemons.daemon_control.reload_daemon_manager",
                   return_value=True) as mock_reload, \
             patch("services.daemons.daemon_control.start_daemon_manager") as mock_start, \
             patch("time.sleep"), \
             patch("pathlib.Path.exists", return_value=False):
            result = await ensure_daemons_running(settings)

        assert result is True
        mock_reload.assert_called_once()
        mock_start.assert_not_called()

    @pytest.mark.asyncio
    async def test_enabled_and_stopped_starts_new(self, tmp_pid_file):
        """Enabled + Stopped = Start new daemon-manager."""
        from services.daemons.daemon_control import ensure_daemons_running

        settings = self._make_settings(master_enabled=True, any_daemon=True)

        with patch("services.daemons.daemon_control.is_daemon_manager_running",
                   return_value=False), \
             patch("services.daemons.daemon_control.start_daemon_manager",
                   return_value=True) as mock_start, \
             patch("pathlib.Path.exists", return_value=False):
            result = await ensure_daemons_running(settings)

        assert result is True
        mock_start.assert_called_once()

    @pytest.mark.asyncio
    async def test_disabled_and_running_stops_gracefully(self, tmp_pid_file):
        """Disabled + Running = Gracefully stop."""
        from services.daemons.daemon_control import ensure_daemons_running

        settings = self._make_settings(master_enabled=False)

        with patch("services.daemons.daemon_control.is_daemon_manager_running",
                   return_value=True), \
             patch("services.daemons.daemon_control.stop_daemon_manager",
                   return_value=True) as mock_stop, \
             patch("pathlib.Path.exists", return_value=False):
            result = await ensure_daemons_running(settings)

        assert result is True
        mock_stop.assert_called_once()

    @pytest.mark.asyncio
    async def test_disabled_and_stopped_does_nothing(self, tmp_pid_file):
        """Disabled + Stopped = No-op, return True."""
        from services.daemons.daemon_control import ensure_daemons_running

        settings = self._make_settings(master_enabled=False)

        with patch("services.daemons.daemon_control.is_daemon_manager_running",
                   return_value=False), \
             patch("services.daemons.daemon_control.start_daemon_manager") as mock_start, \
             patch("services.daemons.daemon_control.stop_daemon_manager") as mock_stop, \
             patch("pathlib.Path.exists", return_value=False):
            result = await ensure_daemons_running(settings)

        assert result is True
        mock_start.assert_not_called()
        mock_stop.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_daemons_enabled_does_not_start(self, tmp_pid_file):
        """Master enabled but all individual daemons disabled = no-op."""
        from services.daemons.daemon_control import ensure_daemons_running

        settings = self._make_settings(master_enabled=True, any_daemon=False)

        with patch("services.daemons.daemon_control.is_daemon_manager_running") as mock_running, \
             patch("services.daemons.daemon_control.start_daemon_manager") as mock_start, \
             patch("pathlib.Path.exists", return_value=False):
            result = await ensure_daemons_running(settings)

        assert result is True
        mock_start.assert_not_called()


# =========================================================================
# 6. DaemonManager flock singleton — the real duplicate preventer
# =========================================================================

class TestDaemonManagerSingletonLock:
    """Test the flock mechanism in daemon_manager.py."""

    def test_acquire_lock_succeeds_when_no_contention(self, tmp_path):
        """First instance acquires the lock."""
        lock_file = tmp_path / "daemon_manager.lock"
        pid_file = tmp_path / "daemon_manager.pid"

        with patch("services.daemons.daemon_manager.LOCK_FILE", lock_file), \
             patch("services.daemons.daemon_manager.PID_FILE", pid_file):
            from services.daemons.daemon_manager import DaemonManager
            mgr = DaemonManager()
            result = mgr._acquire_singleton_lock()

        assert result is True
        assert mgr._lock_fd is not None
        # Clean up
        fcntl.flock(mgr._lock_fd, fcntl.LOCK_UN)
        mgr._lock_fd.close()

    def test_acquire_lock_fails_when_held(self, tmp_path):
        """Second instance fails to acquire the lock (non-blocking)."""
        lock_file = tmp_path / "daemon_manager.lock"
        pid_file = tmp_path / "daemon_manager.pid"

        # First holder
        holder_fd = open(lock_file, "w")
        fcntl.flock(holder_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

        try:
            with patch("services.daemons.daemon_manager.LOCK_FILE", lock_file), \
                 patch("services.daemons.daemon_manager.PID_FILE", pid_file):
                from services.daemons.daemon_manager import DaemonManager
                mgr = DaemonManager()
                result = mgr._acquire_singleton_lock()

            assert result is False
            assert mgr._lock_fd is None
        finally:
            fcntl.flock(holder_fd, fcntl.LOCK_UN)
            holder_fd.close()

    def test_lock_released_after_remove_pid(self, tmp_path):
        """After _remove_pid(), another instance can acquire the lock."""
        lock_file = tmp_path / "daemon_manager.lock"
        pid_file = tmp_path / "daemon_manager.pid"

        with patch("services.daemons.daemon_manager.LOCK_FILE", lock_file), \
             patch("services.daemons.daemon_manager.PID_FILE", pid_file):
            from services.daemons.daemon_manager import DaemonManager

            mgr1 = DaemonManager()
            assert mgr1._acquire_singleton_lock() is True
            mgr1._write_pid()

            # Release via _remove_pid
            mgr1._remove_pid()

            # Second instance should now succeed
            mgr2 = DaemonManager()
            result = mgr2._acquire_singleton_lock()
            assert result is True

            # Clean up
            fcntl.flock(mgr2._lock_fd, fcntl.LOCK_UN)
            mgr2._lock_fd.close()


# =========================================================================
# 7. Regression: no _kill_stale_daemon_managers anywhere in codebase
# =========================================================================

class TestNoDestructivePatterns:
    """Guard against re-introduction of destructive patterns."""

    def test_daemon_control_has_no_kill_stale(self):
        """daemon_control.py must not contain _kill_stale_daemon_managers."""
        import inspect
        import services.daemons.daemon_control as mod
        source = inspect.getsource(mod)
        assert "_kill_stale_daemon_managers" not in source, \
            "Destructive _kill_stale_daemon_managers was re-introduced in daemon_control.py"

    def test_daemon_control_start_has_no_terminate(self):
        """start_daemon_manager() must not call proc.terminate() or proc.kill()."""
        import inspect
        import services.daemons.daemon_control as mod
        source = inspect.getsource(mod.start_daemon_manager)
        assert ".terminate()" not in source, \
            "start_daemon_manager() must not terminate processes"
        assert ".kill()" not in source, \
            "start_daemon_manager() must not kill processes"
        assert "SIGKILL" not in source, \
            "start_daemon_manager() must not send SIGKILL"
        assert "SIGTERM" not in source, \
            "start_daemon_manager() must not send SIGTERM"


# =========================================================================
# 8. Additional coverage: SIGKILL escalation, frozen mode, error paths
# =========================================================================

class TestStopDaemonManagerEscalation:
    """Coverage for lines 220-229: SIGKILL escalation and exception path."""

    def test_escalates_to_sigkill(self, tmp_pid_file):
        """Process ignores SIGTERM — SIGKILL sent."""
        from services.daemons.daemon_control import stop_daemon_manager

        call_log = []

        def track_kill(pid, sig):
            call_log.append((pid, sig))

        with patch("services.daemons.daemon_control.get_daemon_manager_pid",
                   return_value=12345), \
             patch("os.kill", side_effect=track_kill), \
             patch("services.daemons.daemon_control.is_daemon_manager_running",
                   return_value=True), \
             patch("time.sleep"):
            stop_daemon_manager()

        sigkill_calls = [(p, s) for p, s in call_log if s == signal.SIGKILL]
        assert len(sigkill_calls) == 1
        assert sigkill_calls[0] == (12345, signal.SIGKILL)

    def test_stop_exception_returns_false(self, tmp_pid_file):
        """Exception during stop → returns False."""
        from services.daemons.daemon_control import stop_daemon_manager

        with patch("services.daemons.daemon_control.get_daemon_manager_pid",
                   side_effect=RuntimeError("process lookup failed")):
            result = stop_daemon_manager()

        assert result is False


class TestReloadDaemonManagerErrors:
    """Coverage for reload exception path (line 248-250)."""

    def test_reload_exception_returns_false(self, tmp_pid_file):
        from services.daemons.daemon_control import reload_daemon_manager

        with patch("services.daemons.daemon_control.get_daemon_manager_pid",
                   return_value=12345), \
             patch("os.kill", side_effect=PermissionError("denied")):
            result = reload_daemon_manager()

        assert result is False


class TestStartDaemonManagerTimeout:
    """Coverage for timeout failure path (lines 188-191)."""

    def test_returns_false_on_timeout(self, tmp_pid_file):
        from services.daemons.daemon_control import start_daemon_manager

        with patch("services.daemons.daemon_control.is_daemon_manager_running",
                   return_value=False), \
             patch("subprocess.Popen") as mock_popen, \
             patch("time.sleep"):
            mock_popen.return_value = MagicMock(pid=99999)
            result = start_daemon_manager()

        assert result is False


class TestStartDaemonManagerFrozen:
    """Coverage for frozen binary path (lines 129-131)."""

    def test_uses_executable_subcommand_when_frozen(self, tmp_pid_file):
        from services.daemons.daemon_control import start_daemon_manager

        with patch.object(sys, "frozen", True, create=True), \
             patch.object(sys, "executable", "/app/aether-hub"), \
             patch("services.daemons.daemon_control.is_daemon_manager_running",
                   return_value=False), \
             patch("subprocess.Popen") as mock_popen, \
             patch("time.sleep"), \
             patch("builtins.open", MagicMock()):
            mock_popen.return_value = MagicMock(pid=99999)
            start_daemon_manager()

        if mock_popen.called:
            cmd = mock_popen.call_args[0][0]
            assert cmd == ["/app/aether-hub", "daemon-manager"]


class TestEnsureDaemonsRunningEdgeCases:
    """Coverage for runtime config reading and reload failure recovery."""

    def _make_settings(self, *, master_enabled=True, any_daemon=True):
        settings = MagicMock()
        settings.app_root = "/tmp/fake_root"
        settings.proactive.enabled = master_enabled
        settings.proactive.daemons.browser_enabled = any_daemon
        settings.proactive.daemons.email_enabled = False
        settings.proactive.daemons.file_system_enabled = False
        settings.proactive.daemons.query_generation_enabled = False
        settings.proactive.daemons.file_indexing_enabled = False
        return settings

    @pytest.mark.asyncio
    async def test_reload_failure_restarts(self, tmp_pid_file):
        """Daemon dies during reload → restart triggered."""
        from services.daemons.daemon_control import ensure_daemons_running

        settings = self._make_settings()
        call_count = [0]

        def _is_running():
            call_count[0] += 1
            if call_count[0] <= 1:
                return True  # First check: running
            return False  # After reload: dead

        with patch("services.daemons.daemon_control.is_daemon_manager_running",
                   side_effect=_is_running), \
             patch("services.daemons.daemon_control.get_daemon_manager_pid",
                   return_value=12345), \
             patch("services.daemons.daemon_control.reload_daemon_manager",
                   return_value=True), \
             patch("services.daemons.daemon_control.start_daemon_manager",
                   return_value=True) as mock_start, \
             patch("time.sleep"), \
             patch("pathlib.Path.exists", return_value=False):
            result = await ensure_daemons_running(settings)

        assert result is True
        mock_start.assert_called_once()

    @pytest.mark.asyncio
    async def test_exception_returns_false(self, tmp_pid_file):
        """Exception in ensure_daemons_running → returns False."""
        from services.daemons.daemon_control import ensure_daemons_running

        settings = MagicMock()
        settings.app_root = "/tmp/fake"
        settings.proactive.enabled = True
        type(settings.proactive).daemons = PropertyMock(side_effect=RuntimeError("broken"))

        with patch("pathlib.Path.exists", return_value=False):
            result = await ensure_daemons_running(settings)

        assert result is False

    @pytest.mark.asyncio
    async def test_runtime_config_overrides_master(self, tmp_pid_file, tmp_path):
        """Runtime config file with enabled=False overrides settings."""
        from services.daemons.daemon_control import ensure_daemons_running

        settings = self._make_settings(master_enabled=True, any_daemon=True)
        settings.app_root = str(tmp_path)

        runtime_dir = tmp_path / "data" / "runtime"
        runtime_dir.mkdir(parents=True)
        config_file = runtime_dir / "proactive_config.json"
        config_file.write_text('{"enabled": false}')

        with patch("services.daemons.daemon_control.is_daemon_manager_running",
                   return_value=False), \
             patch("services.daemons.daemon_control.start_daemon_manager") as mock_start, \
             patch("services.daemons.daemon_control.stop_daemon_manager") as mock_stop:
            result = await ensure_daemons_running(settings)

        assert result is True
        mock_start.assert_not_called()


class TestEnsureDaemonManagerHealthy:
    """Tests for periodic daemon-manager health reconciliation."""

    @staticmethod
    def _runtime_cfg(*, enabled=True, browser=False, email=False, fs=False, qgen=False, findex=False):
        cfg = MagicMock()
        cfg.enabled = enabled
        cfg.browser_enabled = browser
        cfg.email_enabled = email
        cfg.file_system_enabled = fs
        cfg.query_generation_enabled = qgen
        cfg.file_indexing_enabled = findex
        return cfg

    @pytest.mark.asyncio
    async def test_running_manager_noop_when_should_run(self):
        from services.daemons.daemon_control import ensure_daemon_manager_healthy

        runtime_cfg = self._runtime_cfg(enabled=True, browser=True)
        with patch(
            "config.proactive_config_reader.read_proactive_config",
            return_value=runtime_cfg,
        ), patch(
            "services.daemons.daemon_control.is_daemon_manager_running",
            return_value=True,
        ), patch(
            "services.daemons.daemon_control.start_daemon_manager",
        ) as mock_start:
            result = await ensure_daemon_manager_healthy(MagicMock())

        assert result is True
        mock_start.assert_not_called()

    @pytest.mark.asyncio
    async def test_starts_manager_when_enabled_and_not_running(self):
        from services.daemons.daemon_control import ensure_daemon_manager_healthy

        runtime_cfg = self._runtime_cfg(enabled=True, browser=True)
        with patch(
            "config.proactive_config_reader.read_proactive_config",
            return_value=runtime_cfg,
        ), patch(
            "services.daemons.daemon_control.is_daemon_manager_running",
            return_value=False,
        ), patch(
            "services.daemons.daemon_control.start_daemon_manager",
            return_value=True,
        ) as mock_start:
            result = await ensure_daemon_manager_healthy(MagicMock())

        assert result is True
        mock_start.assert_called_once()

    @pytest.mark.asyncio
    async def test_stops_manager_when_proactive_disabled(self):
        from services.daemons.daemon_control import ensure_daemon_manager_healthy

        runtime_cfg = self._runtime_cfg(enabled=False, browser=True)
        with patch(
            "config.proactive_config_reader.read_proactive_config",
            return_value=runtime_cfg,
        ), patch(
            "services.daemons.daemon_control.is_daemon_manager_running",
            return_value=True,
        ), patch(
            "services.daemons.daemon_control.stop_daemon_manager",
            return_value=True,
        ) as mock_stop:
            result = await ensure_daemon_manager_healthy(MagicMock())

        assert result is True
        mock_stop.assert_called_once()


class TestDaemonLogRotation:
    """Coverage for startup log rotation helper."""

    def test_rotate_oversized_log_moves_to_backup(self, tmp_path):
        from services.daemons.daemon_control import _rotate_log_if_needed

        log_file = tmp_path / "daemons.log"
        log_file.write_bytes(b"x" * 2048)

        _rotate_log_if_needed(log_file, max_bytes=1024, backup_count=3)

        assert not log_file.exists()
        assert (tmp_path / "daemons.log.1").exists()


class TestOnboardingSetupModeGating:
    """Ensure setup mode prevents daemon-manager activation/reload."""

    def test_reload_skips_when_onboarding_setup_mode(self):
        from services.daemons.daemon_control import reload_daemon_manager

        with patch(
            "services.daemons.daemon_control.is_onboarding_setup_mode",
            return_value=True,
        ), patch("os.kill") as mock_kill, patch(
            "services.daemons.daemon_control.start_daemon_manager"
        ) as mock_start:
            result = reload_daemon_manager()

        assert result is True
        mock_kill.assert_not_called()
        mock_start.assert_not_called()

    @pytest.mark.asyncio
    async def test_ensure_daemons_running_skips_start_when_not_running(self):
        from services.daemons.daemon_control import ensure_daemons_running

        settings = MagicMock()
        with patch(
            "services.daemons.daemon_control.is_onboarding_setup_mode",
            return_value=True,
        ), patch(
            "services.daemons.daemon_control.is_daemon_manager_running",
            return_value=False,
        ), patch(
            "services.daemons.daemon_control.start_daemon_manager"
        ) as mock_start, patch(
            "services.daemons.daemon_control.stop_daemon_manager"
        ) as mock_stop:
            result = await ensure_daemons_running(settings)

        assert result is True
        mock_start.assert_not_called()
        mock_stop.assert_not_called()

    @pytest.mark.asyncio
    async def test_ensure_daemons_running_stops_manager_in_setup_mode(self):
        from services.daemons.daemon_control import ensure_daemons_running

        settings = MagicMock()
        with patch(
            "services.daemons.daemon_control.is_onboarding_setup_mode",
            return_value=True,
        ), patch(
            "services.daemons.daemon_control.is_daemon_manager_running",
            return_value=True,
        ), patch(
            "services.daemons.daemon_control.stop_daemon_manager",
            return_value=True,
        ) as mock_stop:
            result = await ensure_daemons_running(settings)

        assert result is True
        mock_stop.assert_called_once()


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
