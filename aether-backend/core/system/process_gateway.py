import os
import signal
import subprocess
import platform
import sys
import time
import asyncio
from pathlib import Path
from typing import Optional
from monitoring import get_logger

logger = get_logger(__name__)

try:
    import psutil
except ImportError:
    psutil = None

from core.exceptions import DaemonControlError, ProcessLookupDomainError, PermissionDomainError
from core.system.interfaces import IProcessGateway
from core.system.models import (
    ProcessStatus,
    SystemMetrics,
    MemoryMetrics,
    DiskMetrics,
    TerminalInfo,
    WorkerHealthStatus
)

class ProcessGateway(IProcessGateway):
    """Gateway for interacting with the underlying OS process management system."""

    def launch_terminal(self, allow_local_os_tools: bool) -> TerminalInfo:
        if not allow_local_os_tools:
            return TerminalInfo(success=False, terminal="unknown", platform=platform.system())
        
        system = platform.system()
        terminal_type = "unknown"
        success = False
        
        try:
            if system == "Darwin":
                try:
                    subprocess.Popen(["open", "-a", "iTerm"], start_new_session=True)
                    terminal_type = "iTerm2"
                    success = True
                except (OSError, FileNotFoundError):
                    subprocess.Popen(["open", "-a", "Terminal"], start_new_session=True)
                    terminal_type = "Terminal.app"
                    success = True
                    
            elif system == "Windows":
                try:
                    subprocess.Popen(["wt.exe"], start_new_session=True)
                    terminal_type = "Windows Terminal"
                    success = True
                except (OSError, FileNotFoundError):
                    subprocess.Popen(["cmd.exe", "/K", "start"], start_new_session=True)
                    terminal_type = "cmd.exe"
                    success = True
                    
            elif system == "Linux":
                terminals = [
                    ("gnome-terminal", "GNOME Terminal"),
                    ("konsole", "Konsole"),
                    ("xfce4-terminal", "XFCE Terminal"),
                    ("xterm", "XTerm")
                ]
                
                for terminal_cmd, terminal_name in terminals:
                    try:
                        subprocess.Popen([terminal_cmd], start_new_session=True)
                        terminal_type = terminal_name
                        success = True
                        break
                    except FileNotFoundError:
                        continue
        except Exception as e:
            logger.error("Failed to launch terminal: %s", e, exc_info=True)
            success = False

        return TerminalInfo(
            success=success,
            terminal=terminal_type,
            platform=system
        )

    def check_process_health(self, pid_file: Path) -> WorkerHealthStatus:
        if not pid_file.exists():
            return WorkerHealthStatus(
                running=False,
                pid=None,
                status=ProcessStatus.STOPPED
            )
        
        try:
            with open(pid_file, 'r') as f:
                pid = int(f.read().strip())
            
            try:
                os.kill(pid, 0)
                return WorkerHealthStatus(
                    running=True,
                    pid=pid,
                    status=ProcessStatus.HEALTHY
                )
            except ProcessLookupError:
                return WorkerHealthStatus(
                    running=False,
                    pid=pid,
                    status=ProcessStatus.STOPPED
                )
            except PermissionError:
                return WorkerHealthStatus(
                    running=True,
                    pid=pid,
                    status=ProcessStatus.HEALTHY
                )
        except Exception as e:
            logger.error("Failed to check process health for %s: %s", pid_file, e, exc_info=True)
            return WorkerHealthStatus(
                running=False,
                pid=None,
                status=ProcessStatus.UNKNOWN
            )

    def get_process_uptime(self, pid: int) -> Optional[float]:
        try:
            if psutil is None:
                return None
            return max(0.0, time.time() - psutil.Process(pid).create_time())
        except Exception as e:
            logger.error("Failed to get process uptime for %s: %s", pid, e, exc_info=True)
            return None

    def get_system_metrics(self) -> SystemMetrics:
        cpu_percent = 0.0
        memory = MemoryMetrics(total_bytes=0, available_bytes=0, percent_used=0.0)
        disk = DiskMetrics(total_bytes=0, free_bytes=0, percent_used=0.0)

        if psutil is not None:
            try:
                cpu_percent = psutil.cpu_percent(interval=None) or 0.0
                mem_info = psutil.virtual_memory()
                memory = MemoryMetrics(
                    total_bytes=mem_info.total,
                    available_bytes=mem_info.available,
                    percent_used=mem_info.percent
                )
                disk_info = psutil.disk_usage('/')
                disk = DiskMetrics(
                    total_bytes=disk_info.total,
                    free_bytes=disk_info.free,
                    percent_used=disk_info.percent
                )
            except Exception as e:
                logger.error("Failed to collect system metrics: %s", e, exc_info=True)

        return SystemMetrics(
            cpu_percent=cpu_percent,
            memory=memory,
            disk=disk,
            platform=platform.system(),
            python_version=sys.version
        )

    def get_current_pid(self) -> int:
        return os.getpid()

    async def self_terminate(self, delay_seconds: float = 0.5) -> None:
        async def _delayed_shutdown():
            await asyncio.sleep(delay_seconds)
            os.kill(os.getpid(), signal.SIGTERM)
        
        asyncio.ensure_future(_delayed_shutdown())

    def restart_process(self, pid: int) -> None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError as e:
            raise ProcessLookupDomainError(f"Process {pid} not found.") from e
        except PermissionError as e:
            raise PermissionDomainError(f"Permission denied to restart process {pid}.") from e
        except Exception as e:
            raise DaemonControlError(f"Failed to restart process {pid}: {e}") from e

    def stop_daemon(self, daemon_name: str) -> None:
        system = platform.system()

        try:
            if system == "Darwin":
                service_name = f"com.aether.{daemon_name}"
                plist_path = Path.home() / "Library" / "LaunchAgents" / f"{service_name}.plist"

                if not plist_path.exists():
                    raise DaemonControlError(f"Service plist not found: {plist_path}")

                result = subprocess.run(
                    ["launchctl", "unload", str(plist_path)],
                    capture_output=True,
                    text=True,
                    timeout=15
                )

                if result.returncode != 0 and "Could not find specified service" not in result.stderr:
                    raise DaemonControlError(f"Unload failed: {result.stderr}")

            elif system == "Windows":
                task_name = f"Aether{daemon_name.capitalize()}"
                subprocess.run(["schtasks", "/End", "/TN", task_name], capture_output=True)

            elif system == "Linux":
                result = subprocess.run(
                    ["systemctl", "--user", "stop", f"aether-{daemon_name}"],
                    capture_output=True,
                    text=True,
                    timeout=5
                )

                if result.returncode != 0:
                    raise DaemonControlError(f"Stop failed: {result.stderr}")

            else:
                raise DaemonControlError(f"Platform {system} not supported")

        except DaemonControlError:
            raise
        except subprocess.TimeoutExpired as e:
            raise DaemonControlError(f"Command timed out stopping daemon: {e}") from e
        except Exception as e:
            raise DaemonControlError(f"Failed to stop daemon {daemon_name}: {e}") from e

    def start_daemon(self, daemon_name: str, backend_root: Path, executable_path: str, is_frozen: bool) -> None:
        system = platform.system()

        try:
            if system == "Darwin":
                service_name = f"com.aether.{daemon_name}"
                plist_path = Path.home() / "Library" / "LaunchAgents" / f"{service_name}.plist"

                if not plist_path.exists():
                    raise DaemonControlError(f"Service plist not found: {plist_path}")

                result = subprocess.run(
                    ["launchctl", "load", str(plist_path)],
                    capture_output=True,
                    text=True,
                    timeout=5
                )

                if result.returncode != 0 and "already loaded" not in result.stderr.lower():
                    raise DaemonControlError(f"Load failed: {result.stderr}")

            elif system == "Windows":
                task_name = f"Aether{daemon_name.capitalize()}"

                if is_frozen:
                    cmd = f'"{executable_path}" aether-rag-daemon'
                else:
                    main_py = backend_root / "main.py"
                    cmd = f'"{executable_path}" "{main_py}" aether-rag-daemon'

                create_cmd = [
                    "schtasks", "/Create", "/F", "/TN", task_name,
                    "/TR", cmd, "/SC", "ONLOGON"
                ]

                subprocess.run(create_cmd, capture_output=True)

                run_result = subprocess.run(
                    ["schtasks", "/Run", "/TN", task_name],
                    capture_output=True,
                    text=True
                )

                if run_result.returncode != 0:
                    raise DaemonControlError(f"Start failed: {run_result.stderr}")

            elif system == "Linux":
                result = subprocess.run(
                    ["systemctl", "--user", "start", f"aether-{daemon_name}"],
                    capture_output=True,
                    text=True,
                    timeout=5
                )

                if result.returncode != 0:
                    raise DaemonControlError(f"Start failed: {result.stderr}")

            else:
                raise DaemonControlError(f"Platform {system} not supported")

        except DaemonControlError:
            raise
        except subprocess.TimeoutExpired as e:
            raise DaemonControlError(f"Command timed out starting daemon: {e}") from e
        except Exception as e:
            raise DaemonControlError(f"Failed to start daemon {daemon_name}: {e}") from e

    def run_command(self, cmd: list[str], timeout: float = 5.0) -> 'subprocess.CompletedProcess':
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

    def run_script_background(self, cmd: list[str], log_file: Path) -> None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        # Open file without 'with' block so it stays open for the background process.
        # The OS will close the descriptor when the child process terminates.
        log_fh = open(log_file, 'a')
        subprocess.Popen(
            cmd,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

