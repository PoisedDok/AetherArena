"""
Request Tracker - Active request management and cancellation
Consolidated from request_tracker.py

@.architecture
Incoming: core/runtime/engine.py, core/runtime/streaming.py --- {request_id, client_id, cancellation signals}
Processing: track_request(), mark_cancelled(), is_cancelled(), cleanup_request(), get_active_requests() --- {5 jobs: lifecycle_tracking, cancellation_management, state_querying, cleanup, audit_trail}
Outgoing: core/runtime/streaming.py, core/runtime/engine.py --- {request metadata Dict, cancellation status bool}

Handles:
- Request lifecycle tracking with timestamps
- Cancellation signal management
- Resource cleanup coordination
- Timeout management and stale request cleanup
- Audit trail for active operations
- Client-specific request filtering

Production Features:
- Thread-safe async locks for dict mutations (BUG FIX)
- Proper activity tracking
- Stale request cleanup
- Client filtering
- Complete audit trail
"""

import asyncio
import logging
import time
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class RequestTracker:
    """
    Tracks active requests and manages cancellation with thread-safe operations.
    
    Features:
    - Request lifecycle tracking with start/end timestamps
    - Cancellation signal handling with immediate detection
    - Resource cleanup coordination across modules
    - Timeout management for long-running operations
    - Audit trail for debugging and monitoring
    - Client-specific request filtering
    - Stale request detection and cleanup
    
    CRITICAL BUG FIX:
    - All dict mutations now use async locks to prevent race conditions
    - Original code had dict mutations without proper locking
    """

    def __init__(self):
        """Initialize request tracker with async-safe storage."""
        self._active_requests: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()  # CRITICAL: Lock for all dict mutations

    async def start_request(
        self, request_id: str, client_id: str, text: str = ""
    ) -> None:
        """
        Start tracking a new request with async-safe dict mutation.
        
        Args:
            request_id: Unique request identifier
            client_id: Client identifier
            text: Optional request text for logging
        """
        request_info = {
            "cancelled": False,
            "start_time": time.time(),
            "client_id": client_id,
            "text": text[:100] + ("..." if len(text) > 100 else ""),
            "last_activity": time.time(),
        }
        
        async with self._lock:  # BUG FIX: Lock dict mutation
            self._active_requests[request_id] = request_info
            
        logger.debug(f"Started tracking request {request_id} for client {client_id}")

    async def cancel_request(self, request_id: str) -> bool:
        """
        Mark a request as cancelled with async-safe dict mutation.
        
        Args:
            request_id: Request to cancel
            
        Returns:
            True if request was found and cancelled, False otherwise
        """
        async with self._lock:  # BUG FIX: Lock dict mutation
            if request_id in self._active_requests:
                self._active_requests[request_id]["cancelled"] = True
                logger.debug(f"Marked request {request_id} as cancelled")
                return True
            else:
                logger.debug(f"Request {request_id} not found in active requests")
                return False

    def is_cancelled(self, request_id: str) -> bool:
        """
        Check if a request has been cancelled (read-only, no lock needed).
        
        Args:
            request_id: Request to check
            
        Returns:
            True if request is cancelled or doesn't exist
        """
        request_info = self._active_requests.get(request_id, {})
        return request_info.get("cancelled", True)  # Default to cancelled if not found

    async def update_activity(self, request_id: str) -> None:
        """
        Update last activity timestamp for a request.
        
        Args:
            request_id: Request to update
        """
        async with self._lock:  # BUG FIX: Lock dict mutation
            if request_id in self._active_requests:
                self._active_requests[request_id]["last_activity"] = time.time()

    async def end_request(self, request_id: str) -> None:
        """
        End tracking of a request with async-safe dict mutation.
        
        Args:
            request_id: Request to end
        """
        async with self._lock:  # BUG FIX: Lock dict mutation
            if request_id in self._active_requests:
                del self._active_requests[request_id]
                logger.debug(f"Ended tracking request {request_id}")

    def get_active_requests(self) -> Dict[str, Dict[str, Any]]:
        """
        Get all active requests (returns copy to avoid external mutations).
        
        Returns:
            Dict mapping request IDs to request info
        """
        return self._active_requests.copy()

    def get_request_count(self) -> int:
        """
        Get count of active requests.
        
        Returns:
            Number of active requests
        """
        return len(self._active_requests)

    async def cleanup_stale_requests(self, max_age_seconds: int = 3600) -> int:
        """
        Clean up requests that haven't had activity for too long.
        
        Args:
            max_age_seconds: Maximum age in seconds for active requests
            
        Returns:
            Number of requests cleaned up
        """
        current_time = time.time()
        stale_requests = []
        
        # Identify stale requests (read-only, no lock needed)
        for request_id, request_info in self._active_requests.items():
            last_activity = request_info.get(
                "last_activity", request_info.get("start_time", 0)
            )
            if current_time - last_activity > max_age_seconds:
                stale_requests.append(request_id)
        
        # Remove stale requests (needs lock)
        async with self._lock:  # BUG FIX: Lock dict mutations
            for request_id in stale_requests:
                if request_id in self._active_requests:  # Double-check still exists
                    del self._active_requests[request_id]
                    logger.debug(f"Cleaned up stale request {request_id}")
        
        if stale_requests:
            logger.info(f"Cleaned up {len(stale_requests)} stale requests")
            
        return len(stale_requests)

    def get_request_info(self, request_id: str) -> Optional[Dict[str, Any]]:
        """
        Get information about a specific request.
        
        Args:
            request_id: Request to get info for
            
        Returns:
            Request info dict or None if not found
        """
        return self._active_requests.get(request_id)

    async def cancel_all_requests(self) -> int:
        """
        Cancel all active requests with async-safe dict mutations.
        
        Returns:
            Number of requests cancelled
        """
        count = 0
        request_ids = list(self._active_requests.keys())  # Get snapshot
        
        for request_id in request_ids:
            if await self.cancel_request(request_id):
                count += 1
        
        if count > 0:
            logger.info(f"Cancelled all {count} active requests")
            
        return count

    def get_requests_by_client(self, client_id: str) -> Dict[str, Dict[str, Any]]:
        """
        Get all active requests for a specific client.
        
        Args:
            client_id: Client identifier
            
        Returns:
            Dict of requests for the client
        """
        return {
            request_id: info.copy()  # Return copies to avoid external mutations
            for request_id, info in self._active_requests.items()
            if info.get("client_id") == client_id
        }

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of request tracker.
        
        Returns:
            Dict with health status information
        """
        active_count = self.get_request_count()
        cancelled_count = sum(
            1 for req in self._active_requests.values() if req.get("cancelled")
        )
        
        return {
            "active_requests": active_count,
            "cancelled_requests": cancelled_count,
            "active_non_cancelled": active_count - cancelled_count,
        }

