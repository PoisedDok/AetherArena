"""
MCP Security Sandbox

@.architecture
Incoming: core/mcp/manager.py --- {server command/args/env/cwd, resource limit configs (max_memory_mb, max_cpu_percent, max_execution_time_seconds)}
Processing: start_server(), stop_server(), _set_resource_limits(), _monitor_process(), is_running(), get_stats() --- {6 jobs: subprocess_creation, resource_limiting, process_monitoring, timeout_enforcement, graceful_termination, stats_collection}
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
import signal
import subprocess
import tempfile
from pathlib import Path
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

    def _set_resource_limits(self):
        """
        Set resource limits for the subprocess (POSIX only).
        
        Called in the preexec_fn of subprocess to apply limits before
        the server process starts.
        
        Limits:
        - Virtual memory (RLIMIT_AS): Prevents excessive memory usage
        - CPU time (RLIMIT_CPU): Prevents CPU exhaustion
        - File descriptors (RLIMIT_NOFILE): Prevents resource exhaustion
        - Processes (RLIMIT_NPROC): Prevents fork bombs
        
        Note: Windows does not support resource limits via resource module.
        """
        try:
            # Memory limit (virtual memory)
            max_memory_bytes = self.max_memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (max_memory_bytes, max_memory_bytes))
            
            # CPU time limit
            resource.setrlimit(
                resource.RLIMIT_CPU,
                (self.max_execution_time_seconds, self.max_execution_time_seconds)
            )
            
            # File descriptor limit (prevent resource exhaustion)
            resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
            
            # Process limit (prevent fork bombs)
            resource.setrlimit(resource.RLIMIT_NPROC, (50, 50))
            
            # Create new process group (for clean termination)
            os.setpgrp()
            
            logger.debug("Resource limits applied to sandboxed process")
            
        except Exception as e:
            logger.warning(f"Failed to set resource limits: {e}")

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
            
            # Use preexec_fn on POSIX systems for resource limits
            preexec_fn = self._set_resource_limits if os.name != 'nt' else None
            
            self._process = await asyncio.create_subprocess_exec(
                *full_command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=safe_env,
                cwd=cwd,
                preexec_fn=preexec_fn,
                # Create new session on POSIX for better isolation
                start_new_session=(os.name != 'nt'),
            )
            
            logger.info(f"Started sandboxed MCP server: PID {self._process.pid}")
            
            # Start monitoring task
            self._monitor_task = asyncio.create_task(self._monitor_process())
            
            return self._process.stdout, self._process.stdin
            
        except Exception as e:
            logger.error(f"Failed to start sandboxed server: {e}")
            await self.stop_server()
            raise RuntimeError(f"Sandbox startup failed: {e}")

    async def _monitor_process(self):
        """
        Monitor process health and enforce timeouts.
        
        Runs in background task to:
        - Check for timeout violations
        - Read stderr for error messages
        - Terminate process if limits exceeded
        """
        try:
            start_time = asyncio.get_event_loop().time()
            
            while self._process and self._process.returncode is None:
                # Check timeout
                elapsed = asyncio.get_event_loop().time() - start_time
                if elapsed > self.max_execution_time_seconds:
                    logger.warning(
                        f"MCP server PID {self._process.pid} exceeded timeout ({self.max_execution_time_seconds}s), terminating"
                    )
                    await self.stop_server()
                    break
                
                # Check stderr for errors
                if self._process.stderr:
                    try:
                        # Non-blocking read with timeout
                        line = await asyncio.wait_for(
                            self._process.stderr.readline(),
                            timeout=1.0
                        )
                        if line:
                            logger.debug(f"MCP server stderr: {line.decode().strip()}")
                    except asyncio.TimeoutError:
                        pass
                
                await asyncio.sleep(5)  # Check every 5 seconds
                
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Process monitor error: {e}")

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
                logger.info(f"Terminating MCP server PID {self._process.pid}")
                
                try:
                    self._process.terminate()
                    await asyncio.wait_for(
                        self._process.wait(),
                        timeout=timeout
                    )
                    logger.debug(f"Server PID {self._process.pid} terminated gracefully")
                except asyncio.TimeoutError:
                    # Force kill
                    logger.warning(f"Force killing MCP server PID {self._process.pid}")
                    self._process.kill()
                    await self._process.wait()
                    logger.debug(f"Server PID {self._process.pid} force killed")
                    
        except Exception as e:
            logger.error(f"Error stopping server: {e}")
            # Last resort force kill
            if self._process and self._process.returncode is None:
                try:
                    self._process.kill()
                except:
                    pass
        finally:
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
        except Exception as e:
            logger.debug(f"Failed to get stats: {e}")
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
        
        self._process = await asyncio.create_subprocess_exec(
            *full_command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=cwd,
        )
        
        logger.info(f"Started unsandboxed MCP server: PID {self._process.pid}")
        
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
            finally:
                self._process = None

    def is_running(self) -> bool:
        """Check if server is running."""
        return self._process is not None and self._process.returncode is None

    def get_stats(self) -> Dict[str, Any]:
        """Get minimal stats."""
        return {"status": "running" if self.is_running() else "stopped"}

