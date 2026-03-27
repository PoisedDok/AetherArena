"""
Background Job Scheduler

APScheduler-based cron jobs for periodic agent tasks.
Runs alongside the main API server.

@.architecture
Incoming: app.py startup --- {startup_event trigger}
Processing: APScheduler with AsyncIOScheduler --- {2 jobs: JOB_SCHEDULE_CRON, JOB_CREATE_JOBS}
Outgoing: pending_jobs table --- {Job records for worker processing}
"""

from datetime import timezone
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from data.database.persistence_gateway import SupabasePersistenceGateway
from config.settings import get_settings
from monitoring import get_logger

logger = get_logger(__name__)


class AgentScheduler:
    """
    Manages periodic background jobs for AI agents.
    
    Responsibilities:
    - Create job records in pending_jobs table
    - Handle scheduler lifecycle
    """
    
    def __init__(self, gateway: SupabasePersistenceGateway):
        self.gateway = gateway
        self.scheduler: Optional[AsyncIOScheduler] = None
        self._running = False
    
    async def start(self) -> None:
        """Start the scheduler with all registered jobs."""
        if self._running:
            logger.warning("Scheduler already running")
            return
        
        logger.info("Initializing agent scheduler...")
        settings = get_settings()
        proactive_settings = settings.proactive
        
        # Create scheduler with asyncio event loop
        self.scheduler = AsyncIOScheduler(timezone=timezone.utc)
        
        # Start scheduler
        self.scheduler.start()
        self._running = True
        
        logger.info("Agent scheduler started with %d jobs", len(self.scheduler.get_jobs()))
        
        # Log next run times
        for job in self.scheduler.get_jobs():
            next_run = job.next_run_time
            logger.info("   - %s: next run at %s", job.name, next_run)
    
    async def shutdown(self) -> None:
        """Gracefully shutdown the scheduler."""
        if not self._running or not self.scheduler:
            return
        
        logger.info("Shutting down agent scheduler...")
        self.scheduler.shutdown(wait=True)
        self._running = False
        logger.info("✅ Agent scheduler stopped")
    
    def get_status(self) -> dict:
        """Get current scheduler status and job info."""
        if not self._running or not self.scheduler:
            return {
                "running": False,
                "jobs": []
            }
        
        jobs = []
        for job in self.scheduler.get_jobs():
            jobs.append({
                "id": job.id,
                "name": job.name,
                "next_run_time": job.next_run_time.isoformat() if job.next_run_time else None,
                "trigger": str(job.trigger)
            })
        
        return {
            "running": True,
            "jobs": jobs,
            "timezone": str(self.scheduler.timezone)
        }
    
# Global scheduler instance (initialized at startup)
_scheduler: Optional[AgentScheduler] = None


async def get_scheduler(gateway: SupabasePersistenceGateway) -> AgentScheduler:
    """Get or create the global scheduler instance."""
    global _scheduler
    if _scheduler is None:
        _scheduler = AgentScheduler(gateway)
    return _scheduler


async def start_scheduler(gateway: SupabasePersistenceGateway) -> None:
    """Start the global scheduler (called from app startup)."""
    scheduler = await get_scheduler(gateway)
    await scheduler.start()


async def shutdown_scheduler() -> None:
    """Shutdown the global scheduler (called from app shutdown)."""
    global _scheduler
    if _scheduler:
        await _scheduler.shutdown()
