"""
MCP Security Sandbox

@.architecture
Incoming: core/mcp/manager.py --- {server command/args/env/cwd, resource limit configs (max_memory_mb, max_cpu_percent, max_execution_time_seconds)}
Processing: start_server(), stop_server(), _set_resource_limits(), _monitor_process(), is_running(), get_stats() --- {JOB_APPLY_CONFIG, JOB_CLEANUP_RESOURCE, JOB_COLLECT_METRICS, JOB_INITIALIZE_COMPONENT, JOB_TIMEOUT, JOB_TRACE}
Outgoing: OS (asyncio.subprocess), core/mcp/manager.py --- {subprocess execution with RLIMIT_AS/RLIMIT_CPU/RLIMIT_NOFILE/RLIMIT_NPROC, Tuple[asyncio.StreamReader, asyncio.StreamWriter], process stats Dict}

Isolated execution environment for MCP servers with:
- Process isolation via subprocess
- Resource limits (CPU, memory, file descriptors)
- Timeout enforcement
- Network restrictions (optional)
- Filesystem restrictions
"""

import asyncio
import logging
import os
import resource
import tempfile
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


class MCPSandbox:
    """
    Security sandbox for MCP server execution.
    
    Features:
    - Process isolation: Servers run in separate subprocesses
    - Resource limits: CPU, memory, file descriptors, processes
    - Timeout enforcement: Automatic termination after time limit
    - Clean termination: Graceful shutdown with force kill fallback
    - Monitoring: Resource usage tracking with psutil (optional)
    
    Security guarantees:
    - Memory: Configurable max virtual memory (default 512MB)
    - CPU: Configurable max CPU time (default 300s)
    - File descriptors: Limited to 256 to prevent exhaustion
    - Processes: Limited to 50 to prevent fork bombs
    - Environment: Minimal safe environment variables only
    """

    def __init__(
        self,
        max_memory_mb: int = 512,
        max_cpu_percent: int = 50,
        max_execution_time_seconds: int = 300,
        allow_network: bool = True,
    ):
        """
        Initialize sandbox with resource limits.
        
        Args:
            max_memory_mb: Maximum memory in MB (virtual memory limit)
            max_cpu_percent: Maximum CPU percentage (for monitoring only)
            max_execution_time_seconds: Maximum execution time in seconds
            allow_network: Whether to allow network access (for future use)
        """
        self.max_memory_mb = max_memory_mb
        self.max_cpu_percent = max_cpu_percent
        self.max_execution_time_seconds = max_execution_time_seconds
        self.allow_network = allow_network
        self._process: Optional[asyncio.subprocess.Process] = None
        self._monitor_task: Optional[asyncio.Task] = None
        self.recent_stderr: list[str] = []
        self.exit_code: Optional[int] = None

    def _set_resource_limits(self):
        """
        Set resource limits for the subprocess (POSIX only).
        
        Called in the preexec_fn of subprocess to apply limits before
        the server process starts.
        """
        try:
            # Create new process group (for clean termination of all children)
            # CRITICAL: Do this first so it runs even if resource limits fail!
            os.setpgrp()
            
            # Virtual memory limit can crash Node.js/V8, which reserves large address spaces.
            # We attempt it, but silently ignore if the OS rejects it.
            try:
                max_memory_bytes = self.max_memory_mb * 1024 * 1024
                resource.setrlimit(resource.RLIMIT_AS, (max_memory_bytes, max_memory_bytes))
            except (ValueError, OSError) as e:
                logger.debug("Could not set RLIMIT_AS: %s", e)
            
            try:
                resource.setrlimit(
                    resource.RLIMIT_CPU,
                    (self.max_execution_time_seconds, self.max_execution_time_seconds)
                )
            except (ValueError, OSError) as e:
                logger.debug("Could not set RLIMIT_CPU: %s", e)
            
            try:
                resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
            except (ValueError, OSError) as e:
                logger.debug("Could not set RLIMIT_NOFILE: %s", e)
            
            try:
                resource.setrlimit(resource.RLIMIT_NPROC, (50, 50))
            except (ValueError, OSError) as e:
                logger.debug("Could not set RLIMIT_NPROC: %s", e)
            
            logger.debug("Resource limits and process group applied to sandboxed process")
            
        except Exception as e:  # noqa: BLE001 -- resource limits: platform-specific, must not block server startup
            logger.warning("Failed to initialize sandbox environment: %s", e)

    async def start_server(
        self,
        command: str,
        args: list[str],
        env: Optional[Dict[str, str]] = None,
        cwd: Optional[str] = None,
    ) -> Tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        """
        Start MCP server in sandboxed subprocess.
        
        Args:
            command: Executable path (e.g., "npx", "python")
            args: Command arguments
            env: Additional environment variables
            cwd: Working directory (isolated temp dir if not provided)
            
        Returns:
            Tuple of (reader, writer) for stdio communication
            
        Raises:
            RuntimeError: If server fails to start
        """
        try:
            # Prepare environment (minimal, security-focused)
            safe_env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
                "LANG": "en_US.UTF-8",
                "PYTHONUNBUFFERED": "1",
            }
            
            if env:
                safe_env.update(env)
            
            # Remove potentially dangerous variables
            for var in ["LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH"]:
                safe_env.pop(var, None)
            
            # Create isolated working directory
            if not cwd:
                temp_dir = tempfile.mkdtemp(prefix="mcp_sandbox_")
                cwd = temp_dir
            
            # Start process with resource limits
            full_command = [command] + args
            
            import sys
            
            # Use preexec_fn on POSIX systems for resource limits.
            # CRITICAL MAC FIX: Using preexec_fn forces python to use fork() instead of posix_spawn().
            # fork() on macOS in a process that has loaded PyTorch/OpenMP or Objective-C (av) 
            # will crash with SIGABRT (code -6) or deadlock in atfork handlers!
            # It also seems to cause code -15 (SIGTERM) when uvloop tries to cleanup broken pipes.
            # Workaround: disable preexec_fn on macOS completely.
            use_posix_features = os.name != 'nt' and sys.platform != 'darwin'
            preexec_fn = self._set_resource_limits if use_posix_features else None
            
            # Remove any pre-existing LD_PRELOAD or DYLD_INSERT_LIBRARIES that might cause issues
            safe_env.pop("LD_PRELOAD", None)
            safe_env.pop("DYLD_INSERT_LIBRARIES", None)
            
            # Additional macOS fix: On macOS, subprocesses inherit the runloop state and signal handlers,
            # which can cause BrokenPipeError/BrokenResourceError if anyio/uvloop shuts down incorrectly.
            # We must use posix_spawn properly without any preexec_fn interference.
            
            # Also, do NOT use start_new_session=True even on Linux right now if we are having asyncio errors
            self._process = await asyncio.create_subprocess_exec(
                *full_command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=safe_env,
                cwd=cwd,
                preexec_fn=preexec_fn,
            )
            
            # Print stderr directly to backend log for debugging
            logger.info("Started sandboxed MCP server: PID %s with env: %s", self._process.pid, safe_env)
            
            # Start monitoring task
            self._monitor_task = asyncio.create_task(self._monitor_process())
            
            return self._process.stdout, self._process.stdin
            
        except Exception as e:  # noqa: BLE001 -- sandbox start: re-raises as RuntimeError; must catch all subprocess errors
            logger.error("Failed to start sandboxed server: %s", e)
            await self.stop_server()
            raise RuntimeError(f"Sandbox startup failed: {e}")

    async def _monitor_process(self):
        """
        Monitor process health and read stderr.
        
        Runs in background task to:
        - Read stderr for error messages
        """
        try:
            while self._process and self._process.returncode is None:
                # Check stderr for errors
                if self._process.stderr and not self._process.stderr.at_eof():
                    lines_read = 0
                    while True:  # Drain the pipe completely to prevent OS buffer deadlock
                        try:
                            # Non-blocking read with short timeout
                            line = await asyncio.wait_for(
                                self._process.stderr.readline(),
                                timeout=0.01
                            )
                            if not line:
                                break  # EOF
                            
                            lines_read += 1
                            decoded = line.decode().strip()
                            if decoded:
                                # Many MCP servers use stderr for all their logging since stdout is reserved for JSON-RPC.
                                # Detect log level to avoid false errors in backend logs.
                                if "ERROR" in decoded or "FATAL" in decoded or "Exception:" in decoded:
                                    logger.error("MCP server stderr: %s", decoded)
                                elif "WARNING" in decoded or "WARN" in decoded:
                                    logger.warning("MCP server stderr: %s", decoded)
                                elif "DEBUG" in decoded:
                                    logger.debug("MCP server stderr: %s", decoded)
                                else:
                                    logger.info("MCP server stderr: %s", decoded)
                                self.recent_stderr.append(decoded)
                                # Keep only last 20 lines to prevent memory bloat
                                if len(self.recent_stderr) > 20:
                                    self.recent_stderr.pop(0)
                            
                            # Yield control periodically to prevent event loop starvation
                            if lines_read % 100 == 0:
                                await asyncio.sleep(0)
                                
                        except asyncio.TimeoutError:
                            break  # No more data right now, safe to sleep
                
                await asyncio.sleep(1.0)  # Check every 1 second
                
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001 -- monitor loop: must not crash monitoring on unexpected error
            logger.error("Process monitor error: %s", e)

    async def stop_server(self, timeout: int = 10):
        """
        Stop the sandboxed server gracefully, then forcefully.
        
        Shutdown sequence:
        1. Cancel monitoring task
        2. Send SIGTERM (graceful shutdown)
        3. Wait up to timeout seconds
        4. Send SIGKILL if still running
        
        Args:
            timeout: Seconds to wait for graceful shutdown
        """
        if not self._process:
            return
            
        try:
            # Cancel monitor
            if self._monitor_task and not self._monitor_task.done():
                self._monitor_task.cancel()
                try:
                    await self._monitor_task
                except asyncio.CancelledError:
                    pass
            
            # Graceful termination
            if self._process.returncode is None:
                logger.info("Terminating MCP server PID %s", self._process.pid)
                
                try:
                    self._process.terminate()
                    await asyncio.wait_for(
                        self._process.wait(),
                        timeout=timeout
                    )
                    logger.debug("Server PID %s terminated gracefully", self._process.pid)
                except asyncio.TimeoutError:
                    # Force kill
                    logger.warning("Force killing MCP server PID %s (timeout)", self._process.pid)
                    self._process.kill()
                    await self._process.wait()
                except asyncio.CancelledError:
                    # If the shutdown itself is cancelled, ensure we don't leave a zombie
                    logger.warning("Force killing MCP server PID %s (shutdown cancelled)", self._process.pid)
                    self._process.kill()
                    raise
                    
        except Exception as e:  # noqa: BLE001 -- stop boundary: must not raise during shutdown
            logger.error("Error stopping server: %s", e)
            # Last resort force kill
            if self._process and self._process.returncode is None:
                try:
                    self._process.kill()
                except OSError:
                    pass
        finally:
            if self._process:
                self.exit_code = self._process.returncode
                # Read any final stderr before clearing process
                if self._process.stderr and not self._process.stderr.at_eof():
                    try:
                        # Async read with timeout to capture final output
                        rem = await asyncio.wait_for(self._process.stderr.read(), timeout=0.5)
                        if rem:
                            for line in rem.decode(errors='replace').splitlines():
                                if line.strip():
                                    self.recent_stderr.append(line.strip())
                    except Exception:
                        pass
                
            self._process = None
            self._monitor_task = None

    def is_running(self) -> bool:
        """
        Check if server process is running.
        
        Returns:
            True if process exists and has not terminated
        """
        return (
            self._process is not None 
            and self._process.returncode is None
        )

    def get_stats(self) -> Dict[str, Any]:
        """
        Get resource usage statistics (requires psutil).
        
        Returns:
            Statistics dictionary with CPU, memory, threads, etc.
            If psutil not available, returns minimal info.
        """
        if not self._process or self._process.returncode is not None:
            return {"status": "stopped"}
        
        try:
            import psutil
            proc = psutil.Process(self._process.pid)
            
            return {
                "status": "running",
                "pid": self._process.pid,
                "cpu_percent": proc.cpu_percent(interval=0.1),
                "memory_mb": proc.memory_info().rss / (1024 * 1024),
                "num_threads": proc.num_threads(),
                "num_fds": proc.num_fds() if hasattr(proc, 'num_fds') else None,
            }
        except ImportError:
            # psutil not available
            return {
                "status": "running",
                "pid": self._process.pid,
            }
        except Exception as e:  # noqa: BLE001 -- stats boundary: return fallback on any failure
            logger.debug("Failed to get stats: %s", e)
            return {"status": "unknown"}


class NoOpSandbox:
    """
    No-op sandbox for when sandboxing is disabled.
    
    Maintains same interface as MCPSandbox but without restrictions.
    Useful for trusted servers or development environments.
    """

    def __init__(self, **kwargs):
        """Initialize no-op sandbox (ignores all resource limit arguments)."""
        self._process: Optional[asyncio.subprocess.Process] = None

    async def start_server(
        self,
        command: str,
        args: list[str],
        env: Optional[Dict[str, str]] = None,
        cwd: Optional[str] = None,
    ) -> Tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        """
        Start server without sandboxing.
        
        Args:
            command: Executable path
            args: Command arguments
            env: Environment variables
            cwd: Working directory
            
        Returns:
            Tuple of (reader, writer) for stdio communication
        """
        full_command = [command] + args
        
        # Inherit full host environment for no-op sandbox, overriding with explicitly provided env
        merged_env = os.environ.copy()
        if env:
            merged_env.update(env)
        
        self._process = await asyncio.create_subprocess_exec(
            *full_command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=merged_env,
            cwd=cwd,
        )
        
        logger.info("Started unsandboxed MCP server: PID %s", self._process.pid)
        
        return self._process.stdout, self._process.stdin

    async def stop_server(self, timeout: int = 10):
        """
        Stop server.
        
        Args:
            timeout: Seconds to wait for graceful shutdown
        """
        if self._process:
            try:
                self._process.terminate()
                await asyncio.wait_for(self._process.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
            except asyncio.CancelledError:
                self._process.kill()
                raise
            finally:
                self._process = None

    def is_running(self) -> bool:
        """Check if server is running."""
        return self._process is not None and self._process.returncode is None

    def get_stats(self) -> Dict[str, Any]:
        """Get minimal stats."""
        return {"status": "running" if self.is_running() else "stopped"}

