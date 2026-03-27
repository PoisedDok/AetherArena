"""
Workers Health Endpoints

Health check endpoints for background job workers.
Returns worker status, job counts, and uptime.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET) --- {HTTP requests to /v1/workers/status}
Processing: check_worker_health(), read worker PID, query job statistics --- {3 jobs: JOB_HEALTH_CHECK, JOB_QUERY_DB, JOB_COLLECT_METRICS}
Outgoing: Frontend (HTTP), monitoring/logging.py --- {WorkerHealthResponse}
"""

from pathlib import Path
from typing import Dict, Any
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from api.dependencies import get_database, setup_request_context, get_process_gateway
from data.database.persistence_gateway import SupabasePersistenceGateway
from monitoring import get_logger
from config.settings import get_settings
from core.system.interfaces import IProcessGateway

logger = get_logger(__name__)
router = APIRouter(tags=["workers"])


class WorkerHealthResponse(BaseModel):
    """Worker health status response."""
    status: str  # healthy, stopped, unknown
    running: bool
    pid: int | None
    jobs_processed: int | None
    jobs_failed: int | None
    jobs_pending: int
    uptime_seconds: float | None


async def _get_job_statistics(gateway: SupabasePersistenceGateway) -> Dict[str, Any]:
    """
    Get job statistics from database.
    
    Args:
        gateway: Database gateway
    
    Returns:
        Dictionary with job counts
    """
    try:
        pending_count = await gateway.count(
            "pending_jobs",
            filters={"status": "pending"}
        )
        processed_count = await gateway.count(
            "pending_jobs",
            filters={"status": "completed"}
        )
        failed_count = await gateway.count(
            "pending_jobs",
            filters={"status": "failed"}
        )
        return {
            "jobs_pending": pending_count,
            "jobs_processed": processed_count,
            "jobs_failed": failed_count
        }
    except Exception as e:
        logger.error("Failed to get job statistics: %s", e, exc_info=True)
        return {
            "jobs_pending": 0,
            "jobs_processed": None,
            "jobs_failed": None
        }


@router.get(
    "/workers/status",
    response_model=WorkerHealthResponse,
    summary="Worker health status",
    description="Get health status of background job worker"
)
async def get_worker_status(
    gateway: SupabasePersistenceGateway = Depends(get_database),
    process_gateway: IProcessGateway = Depends(get_process_gateway),
    _: None = Depends(setup_request_context)
) -> WorkerHealthResponse:
    """
    Get worker health status.
    
    Returns:
        Worker health status including:
        - running: whether worker process is active
        - pid: process ID (if running)
        - jobs_pending: number of pending jobs in queue
        - jobs_processed: total processed (if available)
        - jobs_failed: total failed (if available)
    """
    logger.info("Checking worker health status")
    
    settings = get_settings()
    config_dir = settings.config_dir if hasattr(settings, 'config_dir') else Path.cwd()
    logs_dir = config_dir.parent / "logs"
    pid_file = logs_dir / "worker.pid"
    
    # Check worker process via Gateway
    worker_status = process_gateway.check_process_health(pid_file)
    
    # Get job statistics from database
    job_stats = await _get_job_statistics(gateway)
    
    uptime = None
    if worker_status.running and worker_status.pid:
        uptime = process_gateway.get_process_uptime(worker_status.pid)
    
    # Combine results
    return WorkerHealthResponse(
        status=worker_status.status.value,
        running=worker_status.running,
        pid=worker_status.pid,
        jobs_processed=job_stats.get("jobs_processed"),
        jobs_failed=job_stats.get("jobs_failed"),
        jobs_pending=job_stats.get("jobs_pending", 0),
        uptime_seconds=uptime
    )

