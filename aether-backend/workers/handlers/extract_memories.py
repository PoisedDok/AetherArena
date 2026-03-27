"""
Memory Extraction Handler

Processes 'extract_memories' jobs by calling MemoryService.
Extracts memories from chat summaries using LLM analysis.
Sets source_chat_id correctly for chat-specific memories.

@.architecture
Incoming: job_processor.py --- {job with chat_id, summary_id in metadata}
Processing: Fetch summary, extract memories via LLM, save to database with source_chat_id --- {3 jobs: JOB_QUERY_DB, JOB_HTTP_REQUEST, JOB_MANAGE_STORAGE}
Outgoing: MemoryService, database (memories table) --- {Memory records with source_chat_id}
"""

from typing import Dict, Any
from uuid import UUID

from workers.handlers.base_handler import BaseHandler
from application.chat.memory_service import MemoryService
from data.database.uow import SupabaseUnitOfWork
from data.database.persistence_gateway import SupabasePersistenceGateway
from config.settings import get_settings


class ExtractMemoriesHandler(BaseHandler):
    """
    Handler for memory extraction jobs.
    
    Job metadata expected:
        - chat_id: UUID of chat to extract memories from
        - summary_id: Optional[UUID] of specific summary (uses latest if not provided)
    
    CRITICAL: Sets source_chat_id on created memories to enable chat-specific scoping.
    """
    
    def __init__(self, gateway: SupabasePersistenceGateway):
        """
        Initialize handler with dependencies.
        
        Args:
            gateway: Database gateway for service initialization
        """
        super().__init__(gateway)
        
        # Initialize dependencies (NO HARDCODING - from settings)
        self._settings = get_settings()
        
        # Create UnitOfWork for service (worker context)
        from data.database.uow import SupabaseRequestContext
        context = SupabaseRequestContext(request_id="worker")
        self._uow = SupabaseUnitOfWork(gateway, context)
        
        # Initialize MemoryService
        self._memory_service = MemoryService(self._uow, self._settings)
    
    async def execute(self, job: Dict[str, Any]) -> None:
        """
        Execute memory extraction job.
        
        Args:
            job: Job record with metadata containing chat_id
        
        Raises:
            ValueError: If chat_id missing or invalid
            Exception: If extraction fails
        """
        self._log_job_start(job)
        job_id = UUID(job["id"])
        metadata = self._extract_job_metadata(job)
        
        # Extract chat_id (metadata is canonical; entity_id is defense-in-depth)
        chat_id_str = self._extract_entity_chat_id(job, metadata)
        if not chat_id_str:
            error_msg = "Missing chat_id in both job metadata and entity_id"
            self._logger.error(error_msg)
            await self.fail_job(job_id, error_msg, retry=False)
            raise ValueError(error_msg)
        
        try:
            chat_id = UUID(chat_id_str)
        except (ValueError, TypeError) as e:
            error_msg = f"Invalid chat_id format: {chat_id_str}"
            self._logger.error(error_msg)
            await self.fail_job(job_id, error_msg, retry=False)
            raise ValueError(error_msg) from e
        
        # Extract groups_to_process from metadata (default from config)
        groups_to_process = metadata.get("groups_to_process", 5)
        group_sequence = metadata.get("group_sequence")
        
        triggered_msg = " (triggered at group %s)" % group_sequence if group_sequence else ""
        self._logger.info(
            "Extracting memories from chat %s: processing %d groups%s",
            chat_id, groups_to_process, triggered_msg,
        )
        
        try:
        # Extract memories from recent chat groups (raw messages)
        # This is the correct approach - processes messages directly, not summaries
        # MemoryService.extract_memories_from_groups() sets source_chat_id=chat_id
        # We pass group_sequence to bound the extraction and prevent duplicate processing
            memories = await self._memory_service.extract_memories_from_groups(
                chat_id=chat_id,
                num_groups=groups_to_process,
                max_sequence=group_sequence
            )
            
            # Log memory details
            self._logger.info(
                "Extracted %d memories from chat %s", len(memories), chat_id
            )
            
            # Verify source_chat_id was set correctly
            for memory in memories:
                if memory.get("source_chat_id") != str(chat_id):
                    self._logger.warning(
                        "Memory %s source_chat_id mismatch: expected %s, got %s",
                        memory['id'], chat_id, memory.get('source_chat_id'),
                    )
            
            # Auto-promote important memories to global scope
            promoted_ids = []
            try:
                threshold = self._settings.memory_service.global_injection_min_importance
                promoted_ids = await self._memory_service.auto_promote_important_memories(
                    chat_id=chat_id,
                    importance_threshold=threshold
                )
                if promoted_ids:
                    self._logger.info(
                        "Auto-promoted %d memories to global scope for chat %s", 
                        len(promoted_ids), chat_id
                    )
            except Exception as e:
                self._logger.error("Failed to auto-promote memories for chat %s: %s", chat_id, e, exc_info=True)
            
            # Mark job as completed with result
            await self.complete_job(
                job_id,
                result={
                    "chat_id": str(chat_id),
                    "memories_extracted": len(memories),
                    "memories_promoted": len(promoted_ids),
                    "memory_ids": [str(m["id"]) for m in memories[:10]],  # First 10 IDs
                    "importance_scores": [m.get("importance_score", 0.0) for m in memories]
                }
            )
            
            self._logger.info("Memory extraction job completed for chat %s", chat_id)
            
        except ValueError as e:
            # ValueError: No summary found, validation errors
            error_msg = "Failed to extract memories from chat %s: %s" % (chat_id, e)
            self._logger.error(error_msg)
            await self.fail_job(job_id, error_msg, retry=False)
            raise
            
        except Exception as e:  # noqa: BLE001 -- handler execute boundary: must catch all to mark job failed before re-raising
            # Other errors: network, LLM failures
            error_msg = "Failed to extract memories from chat %s: %s" % (chat_id, type(e).__name__)
            self._logger.error(error_msg, exc_info=True)
            
            # Retry on transient errors
            retry = self._should_retry_error(e)
            await self.fail_job(job_id, error_msg, retry=retry)
            
            # Re-raise to signal failure to job processor
            raise
    
    def _should_retry_error(self, error: Exception) -> bool:
        """
        Determine if error is retryable.
        
        Args:
            error: Exception that occurred
        
        Returns:
            True if error is transient and job should be retried
        """
        # Retry on network errors, LLM timeouts
        error_type = type(error).__name__
        error_str = str(error).lower()
        
        retryable_patterns = [
            "timeout",
            "connection",
            "network",
            "temporarily unavailable",
            "service unavailable",
            "502",
            "503",
            "504"
        ]
        
        for pattern in retryable_patterns:
            if pattern in error_type.lower() or pattern in error_str:
                return True
        
        # Don't retry on validation errors, missing data
        non_retryable = ["valueerror", "keyerror", "notfound"]
        for pattern in non_retryable:
            if pattern in error_type.lower():
                return False
        
        # Default: retry unknown errors once
        return True
