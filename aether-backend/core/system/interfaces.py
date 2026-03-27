from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from core.system.models import SystemMetrics, TerminalInfo, WorkerHealthStatus

class IProcessGateway(ABC):
    """Gateway interface for interacting with the underlying OS process management system."""

    @abstractmethod
    def launch_terminal(self, allow_local_os_tools: bool) -> TerminalInfo:
        """Launch the system terminal application."""
        pass

    @abstractmethod
    def check_process_health(self, pid_file: Path) -> WorkerHealthStatus:
        """Check if a process is running based on its PID file."""
        pass

    @abstractmethod
    def get_process_uptime(self, pid: int) -> Optional[float]:
        """Get the uptime of a process in seconds."""
        pass

    @abstractmethod
    def get_system_metrics(self) -> SystemMetrics:
        """Get system resource metrics (CPU, Memory, Disk, etc.)."""
        pass

    @abstractmethod
    def get_current_pid(self) -> int:
        """Get the current process ID."""
        pass

    @abstractmethod
    async def self_terminate(self, delay_seconds: float = 0.5) -> None:
        """Initiate a graceful shutdown by signaling the current process."""
        pass

    @abstractmethod
    def run_command(self, cmd: list[str], timeout: float = 5.0) -> 'subprocess.CompletedProcess':
        """Run a command synchronously and capture output."""
        pass

    @abstractmethod
    def run_script_background(self, cmd: list[str], log_file: Path) -> None:
        """Launch a script in the background, redirecting output to a log file."""
        pass
