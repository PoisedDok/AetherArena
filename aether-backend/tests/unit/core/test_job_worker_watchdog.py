"""
Unit Tests: job_worker_watchdog.py

Tests the worker watchdog module functions:
- PID file management (ensure_single_instance, _pid_is_running)
- Worker health check (check_worker_health)
- Worker lifecycle (launch_worker, stop_process)
- Gateway initialization (initialize_gateway)
- Configuration (configure_logging, parse_args)
- Watchdog loop internals (_health_loop, _restart_worker, _record_health)

Uses mocks for subprocess, filesystem, and database operations.
"""

import argparse
import asyncio
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import (
    AsyncMock,
    MagicMock,
    mock_open,
    patch,
    PropertyMock,
)

import pytest

# Import target module functions
from core.runtime.workers.job_worker_watchdog import (
    _pid_is_running,
    ensure_single_instance,
    check_worker_health,
    launch_worker,
    stop_process,
    initialize_gateway,
    configure_logging,
    parse_args,
    watchdog_loop,
)


# =========================================================================
# Helpers
# =========================================================================


def _make_settings(**overrides):
    """Create a mock settings object with sensible defaults."""
    supabase = SimpleNamespace(
        enabled=False,
        url="http://localhost:54321",
        anon_key="test-anon-key",
        service_role_key="test-service-key",
        db_schema="public",
        realtime_enabled=False,
    )
    defaults = {
        "supabase": supabase,
        "config_dir": Path("/tmp/test_config"),
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_mock_process(poll_return=None, pid=12345):
    """Create a mock subprocess.Popen."""
    proc = MagicMock(spec=subprocess.Popen)
    proc.poll.return_value = poll_return
    proc.pid = pid
    proc.stdout = None
    proc.stderr = None
    proc.send_signal = MagicMock()
    proc.wait = MagicMock()
    proc.kill = MagicMock()
    return proc


# =========================================================================
# TestPidIsRunning
# =========================================================================


class TestPidIsRunning:
    """Tests for _pid_is_running helper."""

    @patch("core.runtime.workers.job_worker_watchdog.os.kill")
    def test_returns_true_when_process_alive(self, mock_kill):
        """os.kill(pid, 0) succeeds -> process is running."""
        mock_kill.return_value = None
        assert _pid_is_running(1234) is True
        mock_kill.assert_called_once_with(1234, 0)

    @patch("core.runtime.workers.job_worker_watchdog.os.kill")
    def test_returns_false_when_process_not_found(self, mock_kill):
        """os.kill raises ProcessLookupError -> process not running."""
        mock_kill.side_effect = ProcessLookupError("No such process")
        assert _pid_is_running(9999) is False

    @patch("core.runtime.workers.job_worker_watchdog.os.kill")
    def test_returns_false_on_permission_error(self, mock_kill):
        """os.kill raises PermissionError -> still catches (broad except)."""
        mock_kill.side_effect = PermissionError("Operation not permitted")
        assert _pid_is_running(1) is False

    @patch("core.runtime.workers.job_worker_watchdog.os.kill")
    def test_returns_false_on_os_error(self, mock_kill):
        """os.kill raises OSError -> returns False."""
        mock_kill.side_effect = OSError("Generic OS error")
        assert _pid_is_running(42) is False


# =========================================================================
# TestEnsureSingleInstance
# =========================================================================


class TestEnsureSingleInstance:
    """Tests for ensure_single_instance function."""

    def test_creates_pid_file_when_none_exists(self, tmp_path):
        """No existing PID file -> creates new one with current PID."""
        pid_file = tmp_path / "watchdog.pid"
        ensure_single_instance(pid_file)
        assert pid_file.exists()
        assert pid_file.read_text() == str(os.getpid())

    def test_overwrites_stale_pid_file(self, tmp_path):
        """PID file exists with dead process -> overwrites with current PID."""
        pid_file = tmp_path / "watchdog.pid"
        pid_file.write_text("99999")

        with patch("core.runtime.workers.job_worker_watchdog._pid_is_running", return_value=False):
            ensure_single_instance(pid_file)

        assert pid_file.read_text() == str(os.getpid())

    def test_exits_when_existing_instance_running(self, tmp_path):
        """PID file exists with live process (different PID) -> SystemExit."""
        pid_file = tmp_path / "watchdog.pid"
        pid_file.write_text("12345")

        with patch("core.runtime.workers.job_worker_watchdog._pid_is_running", return_value=True):
            with patch("core.runtime.workers.job_worker_watchdog.os.getpid", return_value=99999):
                with pytest.raises(SystemExit):
                    ensure_single_instance(pid_file)

    def test_ignores_own_pid(self, tmp_path):
        """PID file contains own PID -> overwrites (not a conflict)."""
        pid_file = tmp_path / "watchdog.pid"
        current_pid = os.getpid()
        pid_file.write_text(str(current_pid))

        # Should not raise SystemExit
        ensure_single_instance(pid_file)
        assert pid_file.read_text() == str(current_pid)

    def test_handles_non_numeric_pid_file(self, tmp_path):
        """PID file contains non-numeric content -> ignores and overwrites."""
        pid_file = tmp_path / "watchdog.pid"
        pid_file.write_text("not_a_pid")

        ensure_single_instance(pid_file)
        assert pid_file.read_text() == str(os.getpid())

    def test_handles_empty_pid_file(self, tmp_path):
        """PID file is empty -> ignores and overwrites."""
        pid_file = tmp_path / "watchdog.pid"
        pid_file.write_text("")

        ensure_single_instance(pid_file)
        assert pid_file.read_text() == str(os.getpid())

    def test_creates_parent_directory(self, tmp_path):
        """PID file parent doesn't exist -> creates it."""
        pid_file = tmp_path / "nested" / "dir" / "watchdog.pid"
        ensure_single_instance(pid_file)
        assert pid_file.exists()
        assert pid_file.read_text() == str(os.getpid())


# =========================================================================
# TestCheckWorkerHealth
# =========================================================================


class TestCheckWorkerHealth:
    """Tests for check_worker_health function."""

    @pytest.mark.asyncio
    async def test_returns_false_when_proc_is_none(self):
        """None process -> unhealthy."""
        assert await check_worker_health(None) is False

    @pytest.mark.asyncio
    async def test_returns_false_when_process_terminated(self):
        """Process terminated (poll returns code) -> unhealthy."""
        proc = _make_mock_process(poll_return=1)
        assert await check_worker_health(proc) is False

    @pytest.mark.asyncio
    async def test_returns_true_when_process_running(self):
        """Process still running (poll returns None) -> healthy."""
        proc = _make_mock_process(poll_return=None)
        assert await check_worker_health(proc) is True

    @pytest.mark.asyncio
    async def test_returns_false_with_zero_exit_code(self):
        """Process exited cleanly (code 0) -> still unhealthy (not running)."""
        proc = _make_mock_process(poll_return=0)
        assert await check_worker_health(proc) is False


# =========================================================================
# TestStopProcess
# =========================================================================


class TestStopProcess:
    """Tests for stop_process function."""

    def test_graceful_stop(self):
        """Running process stops gracefully on SIGTERM."""
        proc = _make_mock_process(poll_return=None)
        stop_process(proc, None)

        proc.send_signal.assert_called_once_with(signal.SIGTERM)
        proc.wait.assert_called_once_with(timeout=10)

    def test_force_kill_on_timeout(self):
        """Process that doesn't respond to SIGTERM gets killed."""
        proc = _make_mock_process(poll_return=None)
        # First wait (after SIGTERM) times out; second wait (after kill) succeeds
        proc.wait.side_effect = [
            subprocess.TimeoutExpired(cmd="test", timeout=10),
            None,
        ]

        stop_process(proc, None)

        proc.send_signal.assert_called_once_with(signal.SIGTERM)
        proc.kill.assert_called_once()

    def test_error_during_stop_kills_process(self):
        """Error during graceful stop -> force kill attempted."""
        proc = _make_mock_process(poll_return=None)
        proc.send_signal.side_effect = RuntimeError("signal failed")

        stop_process(proc, None)
        proc.kill.assert_called_once()

    def test_noop_when_process_already_stopped(self):
        """Process already terminated -> no SIGTERM sent."""
        proc = _make_mock_process(poll_return=0)
        stop_process(proc, None)

        proc.send_signal.assert_not_called()

    def test_noop_when_proc_is_none(self):
        """None process -> no crash."""
        stop_process(None, None)  # Should not raise

    def test_closes_stdout_stderr_streams(self):
        """Streams are closed after process stop."""
        proc = _make_mock_process(poll_return=0)
        mock_stdout = MagicMock()
        mock_stderr = MagicMock()
        proc.stdout = mock_stdout
        proc.stderr = mock_stderr

        stop_process(proc, None)

        mock_stdout.close.assert_called_once()
        mock_stderr.close.assert_called_once()

    def test_stream_close_error_swallowed(self):
        """Error closing stream is swallowed."""
        proc = _make_mock_process(poll_return=0)
        mock_stdout = MagicMock()
        mock_stdout.close.side_effect = OSError("close failed")
        proc.stdout = mock_stdout
        proc.stderr = None

        stop_process(proc, None)  # Should not raise

    def test_kill_error_in_fallback_swallowed(self):
        """If kill() also fails after send_signal error, swallowed."""
        proc = _make_mock_process(poll_return=None)
        proc.send_signal.side_effect = RuntimeError("signal failed")
        proc.kill.side_effect = OSError("kill also failed")

        stop_process(proc, None)  # Should not raise

    def test_log_path_logged_when_provided(self):
        """Log path presence is logged at debug level."""
        proc = _make_mock_process(poll_return=0)
        log_path = Path("/tmp/test.log")

        # Should not raise
        stop_process(proc, log_path)


# =========================================================================
# TestLaunchWorker
# =========================================================================


class TestLaunchWorker:
    """Tests for launch_worker function."""

    @patch("core.runtime.workers.job_worker_watchdog.subprocess.Popen")
    @patch("core.runtime.workers.job_worker_watchdog.BACKEND_ROOT", new_callable=lambda: PropertyMock)
    def test_dev_mode_launch(self, mock_root_prop, mock_popen, tmp_path):
        """Development mode: launches python -m workers."""
        mock_root = tmp_path
        mock_root_prop.return_value = mock_root

        # Create required directories
        (mock_root / "workers").mkdir()
        (mock_root / "logs").mkdir()
        (mock_root / "main.py").touch()

        mock_proc = MagicMock()
        mock_proc.pid = 42
        mock_popen.return_value = mock_proc

        with patch("core.runtime.workers.job_worker_watchdog.BACKEND_ROOT", mock_root):
            with patch("builtins.open", mock_open()):
                with patch.object(sys, "frozen", False, create=True):
                    settings = _make_settings()
                    proc, log_path = launch_worker(settings)

        assert proc.pid == 42
        mock_popen.assert_called_once()
        call_args = mock_popen.call_args
        # Command should use sys.executable and main.py worker
        assert "worker" in str(call_args)

    @patch("core.runtime.workers.job_worker_watchdog.subprocess.Popen")
    def test_frozen_mode_launch(self, mock_popen, tmp_path):
        """Frozen mode: uses sys.executable directly."""
        mock_proc = MagicMock()
        mock_proc.pid = 99
        mock_popen.return_value = mock_proc

        with patch("core.runtime.workers.job_worker_watchdog.BACKEND_ROOT", tmp_path):
            (tmp_path / "logs").mkdir()
            with patch("builtins.open", mock_open()):
                with patch.object(sys, "frozen", True, create=True):
                    settings = _make_settings()
                    proc, log_path = launch_worker(settings)

        assert proc.pid == 99
        call_kwargs = mock_popen.call_args
        cmd = call_kwargs[0][0]
        assert cmd[-1] == "worker"

    def test_raises_when_workers_module_missing(self, tmp_path):
        """Development mode without workers/ -> FileNotFoundError."""
        with patch("core.runtime.workers.job_worker_watchdog.BACKEND_ROOT", tmp_path):
            (tmp_path / "logs").mkdir()
            with patch.object(sys, "frozen", False, create=True):
                settings = _make_settings()
                with pytest.raises(FileNotFoundError, match="Workers module not found"):
                    launch_worker(settings)

    @patch("core.runtime.workers.job_worker_watchdog.subprocess.Popen")
    def test_pid_file_write_failure_handled(self, mock_popen, tmp_path):
        """PID file write failure logged but not fatal."""
        mock_proc = MagicMock()
        mock_proc.pid = 55
        mock_popen.return_value = mock_proc

        with patch("core.runtime.workers.job_worker_watchdog.BACKEND_ROOT", tmp_path):
            (tmp_path / "workers").mkdir()
            (tmp_path / "logs").mkdir()
            (tmp_path / "main.py").touch()
            # Make PID file path read-only directory to force write failure
            pid_file_path = tmp_path / "logs" / "worker.pid"
            with patch("builtins.open", mock_open()):
                with patch.object(sys, "frozen", False, create=True):
                    with patch.object(Path, "write_text", side_effect=PermissionError("no write")):
                        settings = _make_settings()
                        proc, log_path = launch_worker(settings)

        # Should succeed despite PID file failure
        assert proc.pid == 55


# =========================================================================
# TestInitializeGateway
# =========================================================================


class TestInitializeGateway:
    """Tests for initialize_gateway function."""

    @pytest.mark.asyncio
    async def test_returns_none_when_supabase_disabled(self):
        """Supabase disabled -> returns None."""
        settings = _make_settings()
        settings.supabase.enabled = False
        result = await initialize_gateway(settings)
        assert result is None

    @pytest.mark.asyncio
    @patch("core.runtime.workers.job_worker_watchdog.SupabaseClient")
    async def test_returns_gateway_on_success(self, mock_client_cls):
        """Supabase enabled -> initializes and returns gateway."""
        settings = _make_settings()
        settings.supabase.enabled = True

        mock_client = MagicMock()
        mock_client.initialize = AsyncMock()
        mock_client_cls.from_env.return_value = mock_client

        with patch("core.runtime.workers.job_worker_watchdog.SupabasePersistenceGateway") as mock_gw_cls:
            mock_gw = MagicMock()
            mock_gw_cls.return_value = mock_gw

            result = await initialize_gateway(settings)

        assert result is mock_gw
        mock_client.initialize.assert_awaited_once()

    @pytest.mark.asyncio
    @patch("core.runtime.workers.job_worker_watchdog.SupabaseClient")
    async def test_returns_none_on_connection_error(self, mock_client_cls):
        """Supabase init fails -> returns None, does not crash."""
        settings = _make_settings()
        settings.supabase.enabled = True
        mock_client_cls.from_env.side_effect = ConnectionError("cannot reach supabase")

        result = await initialize_gateway(settings)
        assert result is None


# =========================================================================
# TestConfigureLogging
# =========================================================================


class TestConfigureLogging:
    """Tests for configure_logging function."""

    def test_default_level_is_info(self):
        """Default (verbose=False) -> INFO level."""
        with patch("core.runtime.workers.job_worker_watchdog.logging.basicConfig") as mock_bc:
            configure_logging(verbose=False)
            mock_bc.assert_called_once()
            assert mock_bc.call_args[1]["level"] == logging.INFO

    def test_verbose_level_is_debug(self):
        """verbose=True -> DEBUG level."""
        with patch("core.runtime.workers.job_worker_watchdog.logging.basicConfig") as mock_bc:
            configure_logging(verbose=True)
            mock_bc.assert_called_once()
            assert mock_bc.call_args[1]["level"] == logging.DEBUG


# =========================================================================
# TestParseArgs
# =========================================================================


class TestParseArgs:
    """Tests for parse_args function."""

    def test_defaults(self):
        """No arguments -> default values."""
        with patch("sys.argv", ["watchdog"]):
            args = parse_args()
        assert args.health_interval == 30.0
        assert args.watch_code is True
        assert args.verbose is False

    def test_custom_interval(self):
        """--health-interval flag sets interval."""
        with patch("sys.argv", ["watchdog", "--health-interval", "10.5"]):
            args = parse_args()
        assert args.health_interval == 10.5

    def test_no_watch_code(self):
        """--no-watch-code flag disables code watching."""
        with patch("sys.argv", ["watchdog", "--no-watch-code"]):
            args = parse_args()
        assert args.watch_code is False

    def test_verbose_flag(self):
        """--verbose flag enables verbose logging."""
        with patch("sys.argv", ["watchdog", "--verbose"]):
            args = parse_args()
        assert args.verbose is True

    def test_all_flags_combined(self):
        """All flags together."""
        with patch("sys.argv", ["watchdog", "--health-interval", "5", "--no-watch-code", "--verbose"]):
            args = parse_args()
        assert args.health_interval == 5.0
        assert args.watch_code is False
        assert args.verbose is True


# =========================================================================
# TestWatchdogLoop — Internal Functions
# =========================================================================


class TestWatchdogLoopInternals:
    """
    Tests for watchdog_loop internal behaviors.

    These tests verify the loop's key behaviors by:
    - Making the stop_event fire immediately
    - Mocking all I/O (subprocess, gateway, settings)
    """

    @pytest.mark.asyncio
    @patch("core.runtime.workers.job_worker_watchdog.launch_worker")
    @patch("core.runtime.workers.job_worker_watchdog.stop_process")
    @patch("core.runtime.workers.job_worker_watchdog.initialize_gateway")
    @patch("core.runtime.workers.job_worker_watchdog.get_settings")
    async def test_launches_worker_and_shuts_down(
        self, mock_settings, mock_init_gw, mock_stop, mock_launch
    ):
        """Watchdog launches worker, then shuts down on stop_event."""
        mock_settings.return_value = _make_settings()
        mock_init_gw.return_value = None
        mock_proc = _make_mock_process()
        mock_launch.return_value = (mock_proc, Path("/tmp/test.log"))

        # Immediately trigger shutdown via signal handler patching
        original_add_signal = asyncio.get_event_loop().add_signal_handler

        def immediate_stop_handler(sig, callback, *args):
            # Call the callback immediately to trigger stop_event
            callback()

        with patch.object(
            asyncio.get_event_loop(),
            "add_signal_handler",
            side_effect=immediate_stop_handler,
        ):
            await watchdog_loop(health_interval=0.1, watch_code=False)

        mock_launch.assert_called_once()
        mock_stop.assert_called_once_with(mock_proc, Path("/tmp/test.log"))

    @pytest.mark.asyncio
    @patch("core.runtime.workers.job_worker_watchdog.launch_worker")
    @patch("core.runtime.workers.job_worker_watchdog.stop_process")
    @patch("core.runtime.workers.job_worker_watchdog.initialize_gateway")
    @patch("core.runtime.workers.job_worker_watchdog.get_settings")
    async def test_launch_failure_records_unhealthy(
        self, mock_settings, mock_init_gw, mock_stop, mock_launch
    ):
        """If launch_worker fails, error is logged and watchdog exits."""
        mock_settings.return_value = _make_settings()
        mock_init_gw.return_value = None
        mock_launch.side_effect = FileNotFoundError("workers module gone")

        await watchdog_loop(health_interval=0.1, watch_code=False)

        mock_stop.assert_called_once()

    @pytest.mark.asyncio
    @patch("core.runtime.workers.job_worker_watchdog.launch_worker")
    @patch("core.runtime.workers.job_worker_watchdog.stop_process")
    @patch("core.runtime.workers.job_worker_watchdog.initialize_gateway")
    @patch("core.runtime.workers.job_worker_watchdog.get_settings")
    async def test_gateway_disposed_on_shutdown(
        self, mock_settings, mock_init_gw, mock_stop, mock_launch
    ):
        """Gateway.dispose() is called during shutdown."""
        mock_gw = MagicMock()
        mock_gw.dispose = AsyncMock()
        mock_settings.return_value = _make_settings()
        mock_init_gw.return_value = mock_gw
        mock_proc = _make_mock_process()
        mock_launch.return_value = (mock_proc, None)

        def immediate_stop(sig, callback, *args):
            callback()

        with patch.object(
            asyncio.get_event_loop(),
            "add_signal_handler",
            side_effect=immediate_stop,
        ):
            await watchdog_loop(health_interval=0.1, watch_code=False)

        mock_gw.dispose.assert_awaited_once()

    @pytest.mark.asyncio
    @patch("core.runtime.workers.job_worker_watchdog.launch_worker")
    @patch("core.runtime.workers.job_worker_watchdog.stop_process")
    @patch("core.runtime.workers.job_worker_watchdog.initialize_gateway")
    @patch("core.runtime.workers.job_worker_watchdog.get_settings")
    async def test_gateway_dispose_error_swallowed(
        self, mock_settings, mock_init_gw, mock_stop, mock_launch
    ):
        """Gateway.dispose() failure doesn't crash shutdown."""
        mock_gw = MagicMock()
        mock_gw.dispose = AsyncMock(side_effect=RuntimeError("dispose failed"))
        mock_settings.return_value = _make_settings()
        mock_init_gw.return_value = mock_gw
        mock_proc = _make_mock_process()
        mock_launch.return_value = (mock_proc, None)

        def immediate_stop(sig, callback, *args):
            callback()

        with patch.object(
            asyncio.get_event_loop(),
            "add_signal_handler",
            side_effect=immediate_stop,
        ):
            await watchdog_loop(health_interval=0.1, watch_code=False)

        mock_gw.dispose.assert_awaited_once()


# =========================================================================
# TestHealthCheckIntegration
# =========================================================================


class TestHealthCheckIntegration:
    """Tests for the health check loop behavior via check_worker_health."""

    @pytest.mark.asyncio
    async def test_healthy_worker_returns_true(self):
        """Process with poll()=None -> healthy."""
        proc = _make_mock_process(poll_return=None)
        assert await check_worker_health(proc) is True

    @pytest.mark.asyncio
    async def test_crashed_worker_returns_false(self):
        """Process with poll()=137 (killed) -> unhealthy."""
        proc = _make_mock_process(poll_return=137)
        result = await check_worker_health(proc)
        assert result is False

    @pytest.mark.asyncio
    async def test_segfault_worker_returns_false(self):
        """Process with poll()=-11 (SIGSEGV) -> unhealthy."""
        proc = _make_mock_process(poll_return=-11)
        assert await check_worker_health(proc) is False


# =========================================================================
# TestMainEntryPoint
# =========================================================================


class TestMainEntryPoint:
    """Tests for main() entry point."""

    @patch("core.runtime.workers.job_worker_watchdog.asyncio.run")
    @patch("core.runtime.workers.job_worker_watchdog.ensure_single_instance")
    @patch("core.runtime.workers.job_worker_watchdog.configure_logging")
    @patch("core.runtime.workers.job_worker_watchdog.parse_args")
    def test_main_calls_expected_functions(
        self, mock_args, mock_logging, mock_single, mock_run
    ):
        """main() calls parse_args, configure_logging, ensure_single_instance, asyncio.run."""
        mock_args.return_value = argparse.Namespace(
            health_interval=30.0,
            watch_code=True,
            verbose=False,
        )
        from core.runtime.workers.job_worker_watchdog import main
        main()

        mock_args.assert_called_once()
        mock_logging.assert_called_once_with(verbose=False)
        mock_single.assert_called_once()
        mock_run.assert_called_once()

    @patch("core.runtime.workers.job_worker_watchdog.asyncio.run")
    @patch("core.runtime.workers.job_worker_watchdog.ensure_single_instance")
    @patch("core.runtime.workers.job_worker_watchdog.configure_logging")
    @patch("core.runtime.workers.job_worker_watchdog.parse_args")
    def test_main_keyboard_interrupt_handled(
        self, mock_args, mock_logging, mock_single, mock_run
    ):
        """KeyboardInterrupt during asyncio.run -> handled gracefully."""
        mock_args.return_value = argparse.Namespace(
            health_interval=30.0, watch_code=True, verbose=False
        )
        mock_run.side_effect = KeyboardInterrupt()

        from core.runtime.workers.job_worker_watchdog import main
        # Should not raise
        main()

    @patch("core.runtime.workers.job_worker_watchdog.asyncio.run")
    @patch("core.runtime.workers.job_worker_watchdog.ensure_single_instance")
    @patch("core.runtime.workers.job_worker_watchdog.configure_logging")
    @patch("core.runtime.workers.job_worker_watchdog.parse_args")
    def test_main_error_exits_with_code_1(
        self, mock_args, mock_logging, mock_single, mock_run
    ):
        """Unhandled exception in asyncio.run -> sys.exit(1)."""
        mock_args.return_value = argparse.Namespace(
            health_interval=30.0, watch_code=True, verbose=False
        )
        mock_run.side_effect = RuntimeError("fatal")

        from core.runtime.workers.job_worker_watchdog import main
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 1
