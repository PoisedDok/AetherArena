"""
Base Handler Abstract Interface

All job handlers inherit from this base class.
Provides common functionality: job completion, failure, logging.

@.architecture
Incoming: job_processor.py --- {job: Dict[str, Any]}
Processing: execute job, complete/fail job, log events --- {3 jobs: JOB_EXECUTE, JOB_COMPLETE, JOB_FAIL}
Outgoing: database RPC functions (complete_job, fail_job) --- {job_status}
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional
from uuid import UUID

from data.database.persistence_gateway import SupabasePersistenceGateway
from monitoring import get_logger


class BaseHandler(ABC):
    """
    Abstract base class for all job handlers.
    
    Subclasses must implement execute() method with job-specific logic.
    Common lifecycle methods (complete_job, fail_job) provided here.
    """
    
    def __init__(self, gateway: SupabasePersistenceGateway):
        """
        Initialize handler with database gateway.
        
        Args:
            gateway: Supabase persistence gateway for database operations
        """
        self._gateway = gateway
        self._logger = get_logger(self.__class__.__name__)
    
    @abstractmethod
    async def execute(self, job: Dict[str, Any]) -> None:
        """
        Execute job-specific logic.
        
        Subclasses MUST implement this method.
        Raises exceptions on failure - caller handles complete_job/fail_job.
        
        Args:
            job: Job record from pending_jobs table with fields:
                - id: UUID
                - job_type: str
                - entity_id: Optional[UUID]
                - entity_type: Optional[str]
                - metadata: Optional[Dict]
                - created_at: timestamp
                - priority: int
        
        Raises:
            Exception: Any exception will trigger fail_job() by caller
        """
        pass
    
    async def complete_job(self, job_id: UUID, result: Dict[str, Any] = None) -> None:
        """
        Mark job as completed successfully.
        
        Calls database RPC function complete_job() which:
        - Sets status='completed'
        - Sets completed_at=NOW()
        
        Args:
            job_id: UUID of the job to complete
            result: Optional result data (logged but not stored in DB)
        """
        try:
            # Note: complete_job RPC only accepts p_job_id
            # Result data is already stored in agent_outputs table
            await self._gateway.rpc("complete_job", {"p_job_id": str(job_id)})
            self._logger.info("Job %s completed successfully", job_id)
        except Exception as e:
            self._logger.error("Failed to mark job %s as completed: %s", job_id, e, exc_info=True)
            # Don't re-raise - job was executed successfully even if DB update failed
    
    async def fail_job(
        self,
        job_id: UUID,
        error_message: str,
        retry: bool = False
    ) -> None:
        """
        Mark job as failed.
        
        Calls database RPC function fail_job() which:
        - Increments retry_count
        - Sets status='failed' if retries >= max_retries
        - Sets status='pending' if retry=True and retries < max_retries
        - Appends error_message
        
        Args:
            job_id: UUID of the job that failed
            error_message: Error description
            retry: If True, job will be retried (if attempts < max_retries)
        """
        try:
            await self._gateway.rpc(
                "fail_job",
                {
                    "p_job_id": str(job_id),
                    "p_error_message": error_message,
                    "p_retry": retry
                }
            )
            
            if retry:
                self._logger.warning("Job %s failed (will retry): %s", job_id, error_message)
            else:
                self._logger.error("Job %s failed permanently: %s", job_id, error_message)
        except Exception as e:
            self._logger.error("Failed to mark job %s as failed: %s", job_id, e, exc_info=True)
            # Don't re-raise - log the error but don't crash worker
    
    def _extract_job_metadata(self, job: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract metadata from job record.
        
        Helper method to safely extract and parse job metadata.
        
        Args:
            job: Job record
        
        Returns:
            Metadata dictionary (empty dict if none)
        """
        metadata = job.get("metadata")
        if metadata is None:
            return {}
        if isinstance(metadata, dict):
            return metadata
        # If metadata is JSON string, parse it
        if isinstance(metadata, str):
            try:
                import json
                return json.loads(metadata)
            except json.JSONDecodeError:
                self._logger.warning("Failed to parse job metadata as JSON: %s", metadata)
                return {}
        return {}
    
    def _extract_entity_chat_id(
        self, job: Dict[str, Any], metadata: Dict[str, Any]
    ) -> Optional[str]:
        """
        Extract chat_id from job, checking metadata first then entity_id.

        The DB trigger queue_chat_summarization (migration 031) stores chat_id
        in both the entity_id column and the metadata JSONB. This helper reads
        metadata first (canonical), with entity_id as defense-in-depth.

        Args:
            job: Job record from pending_jobs table
            metadata: Already-parsed metadata dict (from _extract_job_metadata)

        Returns:
            chat_id string if found, None otherwise
        """
        chat_id = metadata.get("chat_id")
        if chat_id:
            return str(chat_id)

        # Defense-in-depth: entity_id carries chat_id when entity_type='chat'
        entity_type = (job.get("entity_type") or "").lower()
        entity_id = job.get("entity_id")
        if entity_id and entity_type == "chat":
            self._logger.debug(
                "chat_id resolved from entity_id (absent in metadata): %s", entity_id
            )
            return str(entity_id)

        return None

    def _log_job_start(self, job: Dict[str, Any]) -> None:
        """Log job execution start."""
        job_id = job.get("id")
        job_type = job.get("job_type")
        entity_id = job.get("entity_id")
        
        self._logger.info(
            "Starting job %s (type=%s, entity=%s)", job_id, job_type, entity_id
        )
    
    def _log_job_end(self, job: Dict[str, Any], duration: float) -> None:
        """Log job execution end."""
        job_id = job.get("id")
        job_type = job.get("job_type")
        self._logger.info(
            "Completed job %s (type=%s) in %.2fs", job_id, job_type, duration
        )
