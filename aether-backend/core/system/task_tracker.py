import asyncio
from typing import Set

class TaskTracker:
    """Utility class to track and manage the lifecycle of background asyncio tasks."""
    def __init__(self):
        self._tracked_tasks: Set[asyncio.Task] = set()

    def track_task(self, task: asyncio.Task) -> asyncio.Task:
        """Track an asyncio task for cleanup and return it."""
        self._tracked_tasks.add(task)
        task.add_done_callback(self._tracked_tasks.discard)
        return task

    async def cancel_all(self, timeout: float = 5.0) -> None:
        """Cancel all tracked tasks and wait for them to finish."""
        for task in list(self._tracked_tasks):
            if not task.done():
                task.cancel()
        
        if self._tracked_tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*list(self._tracked_tasks), return_exceptions=True),
                    timeout=timeout
                )
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        self._tracked_tasks.clear()
