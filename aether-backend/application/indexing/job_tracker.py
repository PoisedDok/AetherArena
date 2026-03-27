import threading
from typing import Any, Dict, List, Optional

# Module-level tracking for background indexing jobs.
# Keys are index_name, values are dicts with state/progress/error.
# NOTE: threading.Lock (not asyncio.Lock) is intentional here because writes
# happen in a worker thread (asyncio.to_thread) while reads happen in the async
# event loop thread.
_indexing_jobs: Dict[str, Dict[str, Any]] = {}
_indexing_jobs_lock = threading.Lock()

class IndexingJobTracker:
    """Manages state and synchronization for background indexing jobs."""

    def get_job(self, index_name: str) -> Optional[Dict[str, Any]]:
        with _indexing_jobs_lock:
            job = _indexing_jobs.get(index_name)
            if job:
                return dict(job)
        return None

    def list_active_jobs(self) -> List[Dict[str, Any]]:
        with _indexing_jobs_lock:
            return [
                dict(job)
                for job in _indexing_jobs.values()
                if job.get("state") in ("queued", "processing")
            ]

    def has_active_job(self, index_name: str) -> bool:
        with _indexing_jobs_lock:
            job = _indexing_jobs.get(index_name)
            return bool(job and job.get("state") in ("queued", "processing"))

    def add_job(self, index_name: str, job_info: Dict[str, Any]) -> None:
        with _indexing_jobs_lock:
            _indexing_jobs[index_name] = job_info

    def update_job(self, index_name: str, **kwargs) -> bool:
        with _indexing_jobs_lock:
            job = _indexing_jobs.get(index_name)
            if job is None:
                return False
            job.update(kwargs)
            return True

    def remove_job(self, index_name: str) -> bool:
        with _indexing_jobs_lock:
            if index_name in _indexing_jobs:
                del _indexing_jobs[index_name]
                return True
            return False

    def clear_all(self) -> None:
        """Clear all jobs (primarily for testing)."""
        with _indexing_jobs_lock:
            _indexing_jobs.clear()
