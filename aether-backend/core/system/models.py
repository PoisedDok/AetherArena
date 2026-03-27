from enum import Enum
from pydantic import BaseModel
from typing import Optional

class ProcessStatus(str, Enum):
    """Status of a process."""
    HEALTHY = "healthy"
    STOPPED = "stopped"
    UNKNOWN = "unknown"

class WorkerHealthStatus(BaseModel):
    """Domain model for worker health."""
    running: bool
    pid: Optional[int]
    status: ProcessStatus

class TerminalInfo(BaseModel):
    """Domain model for launched terminal info."""
    success: bool
    terminal: str
    platform: str

class MemoryMetrics(BaseModel):
    """Domain model for memory metrics."""
    total_bytes: int
    available_bytes: int
    percent_used: float

class DiskMetrics(BaseModel):
    """Domain model for disk metrics."""
    total_bytes: int
    free_bytes: int
    percent_used: float

class SystemMetrics(BaseModel):
    """Domain model for system metrics."""
    cpu_percent: float
    memory: MemoryMetrics
    disk: DiskMetrics
    platform: str
    python_version: str
