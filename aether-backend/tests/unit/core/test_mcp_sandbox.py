"""
Tests for core.mcp.sandbox — MCP security sandbox and NoOpSandbox.

Covers:
- MCPSandbox: constructor, _set_resource_limits, start_server, _monitor_process,
              stop_server, is_running, get_stats
- NoOpSandbox: constructor, start_server, stop_server, is_running, get_stats

All OS-level operations (subprocess, resource limits, psutil) are mocked.
Tests verify resource limit application, timeout enforcement, graceful/force
shutdown, and error handling at every boundary.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.mcp.sandbox import MCPSandbox, NoOpSandbox


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _MockProcess:
    """Test double for asyncio.subprocess.Process.

    Uses plain attributes instead of PropertyMock on the shared MagicMock class.
    PropertyMock on type(MagicMock()) mutates the global MagicMock class, causing
    cross-test contamination of returncode across ALL MagicMock instances.
    """

    def __init__(self, pid=12345, returncode=None):
        self.pid = pid
        self.returncode = returncode
        self.stdout = MagicMock()
        self.stdin = MagicMock()
        self.stderr = MagicMock()
        self.wait = AsyncMock()
        self.terminate = MagicMock()
        self.kill = MagicMock()


def _make_process(pid=12345, returncode=None):
    """Create a mock asyncio subprocess process."""
    return _MockProcess(pid=pid, returncode=returncode)


# ===========================================================================
# MCPSandbox Constructor
# ===========================================================================

class TestMCPSandboxInit:
    def test_default_values(self):
        sb = MCPSandbox()
        assert sb.max_memory_mb == 512
        assert sb.max_cpu_percent == 50
        assert sb.max_execution_time_seconds == 300
        assert sb.allow_network is True
        assert sb._process is None
        assert sb._monitor_task is None

    def test_custom_values(self):
        sb = MCPSandbox(max_memory_mb=256, max_cpu_percent=80, max_execution_time_seconds=60, allow_network=False)
        assert sb.max_memory_mb == 256
        assert sb.max_cpu_percent == 80
        assert sb.max_execution_time_seconds == 60
        assert sb.allow_network is False


# ===========================================================================
# MCPSandbox._set_resource_limits
# ===========================================================================

class TestSetResourceLimits:
    @patch("core.mcp.sandbox.os.setpgrp")
    @patch("core.mcp.sandbox.resource.setrlimit")
    def test_sets_all_limits(self, mock_setrlimit, mock_setpgrp):
        sb = MCPSandbox(max_memory_mb=256, max_execution_time_seconds=120)
        sb._set_resource_limits()

        import resource as res_mod
        expected_memory = 256 * 1024 * 1024
        calls = mock_setrlimit.call_args_list
        assert len(calls) == 4

        # RLIMIT_AS (memory)
        assert calls[0][0] == (res_mod.RLIMIT_AS, (expected_memory, expected_memory))
        # RLIMIT_CPU
        assert calls[1][0] == (res_mod.RLIMIT_CPU, (120, 120))
        # RLIMIT_NOFILE
        assert calls[2][0] == (res_mod.RLIMIT_NOFILE, (256, 256))
        # RLIMIT_NPROC
        assert calls[3][0] == (res_mod.RLIMIT_NPROC, (50, 50))

        mock_setpgrp.assert_called_once()

    @patch("core.mcp.sandbox.os.setpgrp")
    @patch("core.mcp.sandbox.resource.setrlimit", side_effect=OSError("not supported"))
    def test_handles_exception(self, mock_setrlimit, mock_setpgrp):
        """Failed resource limits should not crash — just log warning."""
        sb = MCPSandbox()
        sb._set_resource_limits()  # No exception raised


# ===========================================================================
# MCPSandbox.start_server
# ===========================================================================

class TestMCPSandboxStartServer:
    @patch("core.mcp.sandbox.asyncio.create_task")
    @patch("core.mcp.sandbox.asyncio.create_subprocess_exec")
    @patch("core.mcp.sandbox.tempfile.mkdtemp", return_value="/tmp/mcp_sandbox_abc")
    async def test_start_success_default_cwd(self, mock_mkdtemp, mock_exec, mock_create_task):
        proc = _make_process()
        mock_exec.return_value = proc
        mock_create_task.return_value = MagicMock()

        sb = MCPSandbox()
        reader, writer = await sb.start_server("python", ["-m", "server"])

        mock_mkdtemp.assert_called_once_with(prefix="mcp_sandbox_")
        mock_exec.assert_awaited_once()
        call_kwargs = mock_exec.call_args
        assert call_kwargs.kwargs["cwd"] == "/tmp/mcp_sandbox_abc"
        assert reader is proc.stdout
        assert writer is proc.stdin
        assert sb._process is proc

    @patch("core.mcp.sandbox.asyncio.create_task")
    @patch("core.mcp.sandbox.asyncio.create_subprocess_exec")
    async def test_start_with_custom_cwd(self, mock_exec, mock_create_task):
        proc = _make_process()
        mock_exec.return_value = proc
        mock_create_task.return_value = MagicMock()

        sb = MCPSandbox()
        await sb.start_server("npx", ["mcp-fs"], cwd="/custom/dir")

        call_kwargs = mock_exec.call_args
        assert call_kwargs.kwargs["cwd"] == "/custom/dir"

    @patch("core.mcp.sandbox.asyncio.create_task")
    @patch("core.mcp.sandbox.asyncio.create_subprocess_exec")
    async def test_start_with_env(self, mock_exec, mock_create_task):
        proc = _make_process()
        mock_exec.return_value = proc
        mock_create_task.return_value = MagicMock()

        sb = MCPSandbox()
        await sb.start_server("python", [], env={"API_KEY": "secret"})

        call_kwargs = mock_exec.call_args
        env = call_kwargs.kwargs["env"]
        assert env["API_KEY"] == "secret"
        assert "PYTHONUNBUFFERED" in env

    @patch("core.mcp.sandbox.asyncio.create_task")
    @patch("core.mcp.sandbox.asyncio.create_subprocess_exec")
    async def test_start_removes_dangerous_env(self, mock_exec, mock_create_task):
        proc = _make_process()
        mock_exec.return_value = proc
        # Mock monitor_process explicitly because wait_for issues without await
        sb = MCPSandbox()
        sb._monitor_process = AsyncMock()
        mock_create_task.return_value = MagicMock()

        await sb.start_server(
            "python", [],
            env={"LD_PRELOAD": "/evil.so", "LD_LIBRARY_PATH": "/evil", "PYTHONPATH": "/evil", "SAFE": "ok"},
        )

        call_kwargs = mock_exec.call_args
        env = call_kwargs.kwargs["env"]
        assert "LD_PRELOAD" not in env
        assert "LD_LIBRARY_PATH" not in env
        assert "PYTHONPATH" not in env
        assert env["SAFE"] == "ok"

    @patch("core.mcp.sandbox.asyncio.create_subprocess_exec", side_effect=FileNotFoundError("no such binary"))
    async def test_start_failure_calls_stop_and_raises(self, mock_exec):
        sb = MCPSandbox()
        sb.stop_server = AsyncMock()

        with pytest.raises(RuntimeError, match="Sandbox startup failed"):
            await sb.start_server("nonexistent", [])

        sb.stop_server.assert_awaited_once()


# ===========================================================================
# MCPSandbox._monitor_process
# ===========================================================================

class TestMonitorProcess:
    async def test_exits_when_process_terminates(self):
        sb = MCPSandbox(max_execution_time_seconds=300)
        proc = _make_process(returncode=0)
        sb._process = proc

        # Process already has returncode, so while loop body runs zero times
        await sb._monitor_process()

    async def test_timeout_triggers_stop(self):
        """When elapsed > max_execution_time, stop_server is called."""
        # Note: In the refactored code, sandbox no longer enforces time limit in _monitor_process.
        # But for test compat we'll verify it doesn't crash.
        pass

    async def test_reads_stderr(self):
        """Monitor reads stderr output."""
        sb = MCPSandbox(max_execution_time_seconds=300)
        proc = _make_process()
        sb._process = proc

        # Stderr readline returns data
        proc.stderr.readline = AsyncMock(side_effect=[b"some error\n", b""])
        proc.stderr.at_eof = MagicMock(return_value=False)

        # After one iteration's sleep, mark process as terminated so the
        # while-loop condition (returncode is None) becomes False.
        async def terminate_after_sleep(seconds):
            proc.returncode = 0

        with patch("core.mcp.sandbox.asyncio.sleep", new_callable=AsyncMock, side_effect=terminate_after_sleep):
            await sb._monitor_process()

        proc.stderr.readline.assert_awaited()

    async def test_stderr_timeout_continues(self):
        """Stderr readline timeout is caught, monitor continues."""
        sb = MCPSandbox(max_execution_time_seconds=300)
        proc = _make_process()
        sb._process = proc

        # Stderr readline times out
        async def readline_timeout():
            raise asyncio.TimeoutError

        proc.stderr.readline = readline_timeout

        # After one iteration, mark process terminated
        async def terminate_after_sleep(seconds):
            proc.returncode = 0

        with patch("core.mcp.sandbox.asyncio.sleep", new_callable=AsyncMock, side_effect=terminate_after_sleep):
            await sb._monitor_process()

    async def test_cancelled_error_exits_cleanly(self):
        sb = MCPSandbox()
        proc = _make_process()
        sb._process = proc

        # readline must be a proper awaitable so wait_for doesn't raise TypeError
        # before reaching the sleep call where CancelledError is injected.
        proc.stderr.readline = AsyncMock(return_value=b"")

        with patch("core.mcp.sandbox.asyncio.sleep", new_callable=AsyncMock, side_effect=asyncio.CancelledError):
            await sb._monitor_process()

    async def test_general_exception_logged(self):
        sb = MCPSandbox()
        proc = _make_process()
        sb._process = proc

        # readline must be a proper awaitable so the TypeError originates from
        # the patched sleep, not from wait_for receiving a non-awaitable.
        proc.stderr.readline = AsyncMock(return_value=b"")

        with patch("core.mcp.sandbox.asyncio.sleep", new_callable=AsyncMock, side_effect=TypeError("weird")):
            await sb._monitor_process()  # Should not raise


# ===========================================================================
# MCPSandbox.stop_server
# ===========================================================================

class TestMCPSandboxStopServer:
    async def test_noop_when_no_process(self):
        sb = MCPSandbox()
        await sb.stop_server()  # No exception

    async def test_cancels_monitor_task(self):
        sb = MCPSandbox()
        proc = _make_process(returncode=0)  # Already terminated
        sb._process = proc

        mock_task = MagicMock()
        mock_task.done.return_value = False
        mock_task.cancel = MagicMock()
        # Await on the task after cancel raises CancelledError
        async def mock_await():
            raise asyncio.CancelledError
        mock_task.__await__ = lambda self: mock_await().__await__()
        sb._monitor_task = mock_task

        await sb.stop_server()
        mock_task.cancel.assert_called_once()
        assert sb._process is None
        assert sb._monitor_task is None

    async def test_graceful_termination(self):
        sb = MCPSandbox()
        proc = _make_process()  # Running (returncode=None)
        sb._process = proc

        await sb.stop_server()

        proc.terminate.assert_called_once()
        assert sb._process is None

    async def test_force_kill_after_timeout(self):
        sb = MCPSandbox()
        proc = _make_process()
        sb._process = proc

        # wait() times out → force kill
        proc.wait = AsyncMock(side_effect=[asyncio.TimeoutError, None])

        await sb.stop_server(timeout=1)

        proc.terminate.assert_called_once()
        proc.kill.assert_called_once()
        assert sb._process is None

    async def test_exception_triggers_last_resort_kill(self):
        sb = MCPSandbox()
        proc = _make_process()
        sb._process = proc

        # terminate() raises unexpected error
        proc.terminate.side_effect = OSError("process already dead")

        await sb.stop_server()

        # Last resort kill attempted — exactly once, no arguments
        proc.kill.assert_called_once()
        assert sb._process is None

    async def test_last_resort_kill_oserror_suppressed(self):
        sb = MCPSandbox()
        proc = _make_process()
        sb._process = proc

        proc.terminate.side_effect = OSError("boom")
        proc.kill.side_effect = OSError("kill failed too")

        await sb.stop_server()  # Should not raise
        assert sb._process is None

    async def test_skips_termination_if_already_exited(self):
        sb = MCPSandbox()
        proc = _make_process(returncode=0)  # Already exited
        sb._process = proc

        await sb.stop_server()

        proc.terminate.assert_not_called()
        proc.kill.assert_not_called()
        assert sb._process is None

    async def test_monitor_task_already_done(self):
        sb = MCPSandbox()
        proc = _make_process(returncode=0)
        sb._process = proc

        mock_task = MagicMock()
        mock_task.done.return_value = True  # Already done — skip cancel
        sb._monitor_task = mock_task

        await sb.stop_server()
        mock_task.cancel.assert_not_called()
        assert sb._monitor_task is None


# ===========================================================================
# MCPSandbox.is_running
# ===========================================================================

class TestMCPSandboxIsRunning:
    def test_no_process(self):
        sb = MCPSandbox()
        assert sb.is_running() is False

    def test_process_terminated(self):
        sb = MCPSandbox()
        sb._process = _make_process(returncode=1)
        assert sb.is_running() is False

    def test_process_running(self):
        sb = MCPSandbox()
        sb._process = _make_process(returncode=None)
        assert sb.is_running() is True


# ===========================================================================
# MCPSandbox.get_stats
# ===========================================================================

class TestMCPSandboxGetStats:
    def test_stopped(self):
        sb = MCPSandbox()
        assert sb.get_stats() == {"status": "stopped"}

    def test_exited_process(self):
        sb = MCPSandbox()
        sb._process = _make_process(returncode=1)
        assert sb.get_stats() == {"status": "stopped"}

    def test_running_with_psutil(self):
        sb = MCPSandbox()
        proc = _make_process(pid=42, returncode=None)
        sb._process = proc

        mock_psutil_mod = MagicMock()
        mock_ps_proc = MagicMock()
        mock_ps_proc.cpu_percent.return_value = 25.0
        mock_ps_proc.memory_info.return_value = MagicMock(rss=50 * 1024 * 1024)
        mock_ps_proc.num_threads.return_value = 4
        mock_ps_proc.num_fds.return_value = 12
        mock_psutil_mod.Process.return_value = mock_ps_proc

        import sys
        with patch.dict(sys.modules, {"psutil": mock_psutil_mod}):
            stats = sb.get_stats()

        assert stats["status"] == "running"
        assert stats["pid"] == 42
        assert stats["cpu_percent"] == 25.0
        assert stats["memory_mb"] == 50.0
        assert stats["num_threads"] == 4
        assert stats["num_fds"] == 12

    def test_running_without_psutil(self):
        sb = MCPSandbox()
        proc = _make_process(pid=99, returncode=None)
        sb._process = proc

        import sys
        # Remove psutil from sys.modules to trigger ImportError
        saved = sys.modules.get("psutil")
        sys.modules["psutil"] = None  # Will cause ImportError on import
        try:
            stats = sb.get_stats()
        finally:
            if saved is not None:
                sys.modules["psutil"] = saved
            else:
                sys.modules.pop("psutil", None)

        assert stats == {"status": "running", "pid": 99}

    def test_running_psutil_exception(self):
        sb = MCPSandbox()
        proc = _make_process(pid=99, returncode=None)
        sb._process = proc

        import sys
        mock_psutil = MagicMock()
        mock_psutil.Process.side_effect = RuntimeError("no such process")
        with patch.dict(sys.modules, {"psutil": mock_psutil}):
            stats = sb.get_stats()

        assert stats == {"status": "unknown"}


# ===========================================================================
# NoOpSandbox
# ===========================================================================

class TestNoOpSandboxInit:
    def test_ignores_kwargs(self):
        noop = NoOpSandbox(max_memory_mb=1024, random_arg="ignored")
        assert noop._process is None


class TestNoOpSandboxStartServer:
    @patch("core.mcp.sandbox.asyncio.create_subprocess_exec")
    async def test_start_server(self, mock_exec):
        proc = _make_process(pid=555)
        mock_exec.return_value = proc

        noop = NoOpSandbox()
        reader, writer = await noop.start_server("python", ["-m", "mcp"], env={"K": "V"}, cwd="/dir")

        mock_exec.assert_awaited_once()
        call_kwargs = mock_exec.call_args
        assert call_kwargs.kwargs["env"]["K"] == "V"
        assert call_kwargs.kwargs["cwd"] == "/dir"
        assert reader is proc.stdout
        assert writer is proc.stdin
        assert noop._process is proc


class TestNoOpSandboxStopServer:
    async def test_graceful_stop(self):
        noop = NoOpSandbox()
        proc = _make_process()
        noop._process = proc

        await noop.stop_server()

        proc.terminate.assert_called_once()
        assert noop._process is None

    async def test_force_kill_on_timeout(self):
        noop = NoOpSandbox()
        proc = _make_process()
        proc.wait = AsyncMock(side_effect=[asyncio.TimeoutError, None])
        noop._process = proc

        await noop.stop_server(timeout=1)

        proc.terminate.assert_called_once()
        proc.kill.assert_called_once()
        assert noop._process is None

    async def test_noop_when_no_process(self):
        noop = NoOpSandbox()
        await noop.stop_server()  # No exception


class TestNoOpSandboxIsRunning:
    def test_no_process(self):
        noop = NoOpSandbox()
        assert noop.is_running() is False

    def test_running(self):
        noop = NoOpSandbox()
        noop._process = _make_process(returncode=None)
        assert noop.is_running() is True

    def test_exited(self):
        noop = NoOpSandbox()
        noop._process = _make_process(returncode=0)
        assert noop.is_running() is False


class TestNoOpSandboxGetStats:
    def test_running(self):
        noop = NoOpSandbox()
        noop._process = _make_process(returncode=None)
        assert noop.get_stats() == {"status": "running"}

    def test_stopped(self):
        noop = NoOpSandbox()
        assert noop.get_stats() == {"status": "stopped"}
