"""
@.architecture
Incoming: services/file_indexing/daemon.py, scan interval config --- {APScheduler, cron config}
Processing: schedule and execute periodic file scans --- {2 jobs: JOB_ORCHESTRATE, JOB_SCHEDULE}
Outgoing: services/file_indexing/daemon.py --- {scheduled job triggers}
"""

import logging
from typing import Callable
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

logger = logging.getLogger(__name__)


class IndexingScheduler:
    """Manages scheduled file indexing jobs."""
    
    def __init__(self):
        """Initialize scheduler."""
        self.scheduler = AsyncIOScheduler()
        self.jobs = {}
    
    def start(self):
        """Start scheduler."""
        self.scheduler.start()
        logger.info("Scheduler started")
    
    def shutdown(self):
        """Shutdown scheduler."""
        self.scheduler.shutdown(wait=True)
        logger.info("Scheduler shutdown")
    
    def schedule_scan(
        self,
        location_id: str,
        scan_func: Callable,
        interval_seconds: int
    ):
        """
        Schedule periodic scan for a location.
        
        Args:
            location_id: Location ID
            scan_func: Async function to call for scanning
            interval_seconds: Scan interval in seconds
        """
        job_id = f"scan_{location_id}"
        
        # Remove existing job if present
        if job_id in self.jobs:
            self.scheduler.remove_job(job_id)
        
        # Add new job
        job = self.scheduler.add_job(
            scan_func,
            trigger=IntervalTrigger(seconds=interval_seconds),
            id=job_id,
            name=f"Scan location {location_id}",
            replace_existing=True
        )
        
        self.jobs[job_id] = job
        logger.info(f"Scheduled scan for {location_id} every {interval_seconds}s")
    
    def remove_scan(self, location_id: str):
        """
        Remove scheduled scan for a location.
        
        Args:
            location_id: Location ID
        """
        job_id = f"scan_{location_id}"
        
        if job_id in self.jobs:
            self.scheduler.remove_job(job_id)
            del self.jobs[job_id]
            logger.info(f"Removed scan schedule for {location_id}")

