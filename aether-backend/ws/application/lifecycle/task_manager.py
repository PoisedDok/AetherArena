"""
@.architecture

Incoming: presentation --- {str, asyncio.Task, primitives}
Processing: task tracking, cancellation coordination, lifecycle management --- {3 jobs: JOB_TRACK_STATE, JOB_CLEANUP, JOB_LOG}
Outgoing: presentation --- {Dict[str, Any], bool, primitives}

Task Manager - Stream task lifecycle management

Application service for managing active stream tasks.
Thread-safe tracking, cancellation coordination, client cleanup.

Features:
- Track active stream tasks by request_id
- Metadata: client_id, correlation_id, frontend_id
- Task cancellation on stop/disconnect
- Client-level cleanup
"""

import asyncio
from typing import Any, Callable, Dict, List, Optional
import logging

logger = logging.getLogger(__name__)


class TaskManager:
    """
    Thread-safe stream task lifecycle manager.
    
    Tracks active stream tasks with metadata.
    Provides cancellation and cleanup coordination.
    """
    
    def __init__(self):
        """Initialize task manager."""
        self._stream_tasks: Dict[str, Dict[str, Any]] = {}
        self._orphaned_tasks: List[asyncio.Task] = []
        self._tasks_lock = asyncio.Lock()
        self._logger = logger
        
    def track_orphaned_task(self, task: asyncio.Task, request_id: str) -> None:
        """
        Track an orphaned/zombie task that refused to cancel gracefully.
        
        Args:
            task: The hung asyncio task
            request_id: Backend request identifier
        """
        self._orphaned_tasks.append(task)
        self._logger.error("Tracking orphaned task (zombie): request=%s", request_id)
        
        # Add a callback to remove it from the list when it finally completes (if ever)
        def _on_orphan_done(t: asyncio.Task) -> None:
            try:
                self._orphaned_tasks.remove(t)
                self._logger.info("Orphaned task finally completed: request=%s", request_id)
            except ValueError:
                pass
                
        task.add_done_callback(_on_orphan_done)
    
    async def register_task(
        self,
        *,
        request_id: str,
        task: asyncio.Task,
        client_id: str,
        correlation_id: Optional[str],
        frontend_id: Optional[str],
    ) -> None:
        """
        Register stream task for lifecycle tracking.
        
        Args:
            request_id: Backend request identifier
            task: Asyncio task to track
            client_id: Client identifier
            correlation_id: Optional correlation ID
            frontend_id: Optional frontend request ID
        """
        async with self._tasks_lock:
            self._stream_tasks[request_id] = {
                "task": task,
                "client_id": client_id,
                "correlation_id": correlation_id,
                "frontend_id": frontend_id,
            }
            
            self._logger.debug(
                f"Registered task: request={request_id}, client={client_id}, "
                f"correlation={correlation_id}, frontend={frontend_id}"
            )
    
    async def cancel_task(
        self,
        request_id: str,
    ) -> Optional[Dict[str, Any]]:
        """
        Cancel stream task by request ID.
        
        Args:
            request_id: Backend request identifier
            
        Returns:
            Task metadata if cancelled, None if not found
        """
        async with self._tasks_lock:
            task_info = self._stream_tasks.get(request_id)
            
            if not task_info:
                self._logger.debug("Task not found for cancellation: %s", request_id)
                return None
            
            try:
                task_info["task"].cancel()
                self._stream_tasks.pop(request_id, None)
                
                self._logger.debug(
                    f"Cancelled task: request={request_id}, client={task_info.get('client_id')}"
                )
                
                return {
                    "client_id": task_info.get("client_id"),
                    "correlation_id": task_info.get("correlation_id"),
                    "frontend_id": task_info.get("frontend_id"),
                }
            except (RuntimeError, KeyError, asyncio.CancelledError) as e:
                self._logger.warning("Failed to cancel task %s: %s", request_id, e)
                return None
    
    async def cleanup_client_tasks(self, client_id: str) -> List[str]:
        """
        Cancel all tasks for disconnected client.
        
        Args:
            client_id: Client identifier
            
        Returns:
            List of cancelled request IDs
        """
        async with self._tasks_lock:
            # Identify tasks belonging to client
            tasks_to_cancel = [
                (request_id, task_info["task"])
                for request_id, task_info in self._stream_tasks.items()
                if task_info.get("client_id") == client_id
            ]
            
            cancelled_ids: List[str] = []
            for request_id, task in tasks_to_cancel:
                try:
                    task.cancel()
                    self._stream_tasks.pop(request_id, None)
                    cancelled_ids.append(request_id)
                except (RuntimeError, KeyError) as e:
                    self._logger.warning(
                        "Failed to cancel task %s for client %s: %s", request_id, client_id, e
                    )
            
            if cancelled_ids:
                self._logger.debug(
                    f"Cleaned up {len(cancelled_ids)} tasks for client {client_id}"
                )
            
            return cancelled_ids
    
    async def forget_task(self, request_id: str) -> None:
        """
        Remove task from tracking (after completion).
        
        Args:
            request_id: Backend request identifier
        """
        async with self._tasks_lock:
            task_info = self._stream_tasks.pop(request_id, None)
            
            if task_info:
                self._logger.debug(
                    f"Forgot task: request={request_id}, client={task_info.get('client_id')}"
                )
    
    def attach_finalizer(
        self,
        task: asyncio.Task,
        *,
        request_id: str,
        cleanup_callback: Optional[Callable[[str], None]] = None,
    ) -> None:
        """
        Attach finalizer callback to task for automatic cleanup.
        
        Args:
            task: Asyncio task
            request_id: Backend request identifier
            cleanup_callback: Optional callback for additional cleanup
        """
        def _callback(completed: asyncio.Task) -> None:
            asyncio.create_task(self.forget_task(request_id))
            
            if cleanup_callback:
                try:
                    cleanup_callback(request_id)
                except (RuntimeError, TypeError, ValueError) as e:
                    self._logger.warning(
                        "Cleanup callback failed for %s: %s", request_id, e
                    )
        
        task.add_done_callback(_callback)

