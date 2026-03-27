"""
Memory Promotion Handler

Processes 'promote_memories' jobs by auto-promoting high-importance chat memories to global.
DEPRECATED: Memory promotion is now handled synchronously by ExtractMemoriesHandler.
This handler is retained only for backward compatibility to drain any pending jobs.

@.architecture
Incoming: job_processor.py --- {job with chat_id in metadata}
Processing: Query chat memories, check importance, promote to global (set source_chat_id=NULL) --- {2 jobs: JOB_QUERY_DB, JOB_MANAGE_STORAGE}
Outgoing: MemoryService, database (memories table) --- {Updated memories with source_chat_id=NULL}
"""

from typing import Dict, Any, List
from uuid import UUID

from workers.handlers.base_handler import BaseHandler
from application.chat.memory_service import MemoryService
from data.database.uow import SupabaseUnitOfWork
from data.database.persistence_gateway import SupabasePersistenceGateway
from config.settings import get_settings


class PromoteMemoriesHandler(BaseHandler):
    """
    Handler for memory promotion jobs.
    
    Auto-promotes high-importance chat-specific memories to global scope.
    
    Job metadata expected:
        - chat_id: UUID of chat to scan for promotable memories
        - importance_threshold: Optional[float] = 0.8 (minimum importance for promotion)
    
    CRITICAL: Sets source_chat_id=NULL on promoted memories for global visibility.
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
        
        self._logger.warning(
            "PromoteMemoriesHandler is deprecated. "
            "Memory promotion is now handled inline by ExtractMemoriesHandler. "
            "This handler exists only for backward compatibility."
        )
    
    async def execute(self, job: Dict[str, Any]) -> None:
        """
        Execute memory promotion job.
        
        Args:
            job: Job record with metadata containing chat_id
        
        Raises:
            ValueError: If chat_id missing or invalid
            Exception: If promotion fails
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
        
        # Extract importance threshold (default 0.8 from config)
        importance_threshold = metadata.get(
            "importance_threshold",
            self._settings.memory_service.promotion_threshold if hasattr(self._settings, 'memory_service') else 0.8
        )
        
        try:
            # Inline implementation: memory promotion is tightly coupled to the handler's
            # context; extraction to a separate service gains nothing at current scale.
            self._logger.info(
                "Scanning chat %s for memories with importance >= %s", chat_id, importance_threshold
            )
            
            # Query chat-specific memories with high importance
            promoted_ids = await self._find_and_promote_memories(
                chat_id,
                importance_threshold
            )
            
            # Mark job as completed with result
            await self.complete_job(
                job_id,
                result={
                    "chat_id": str(chat_id),
                    "memories_promoted": len(promoted_ids),
                    "promoted_ids": [str(mid) for mid in promoted_ids],
                    "importance_threshold": importance_threshold
                }
            )
            
            self._logger.info(
                "Promoted %d memories from chat %s to global", len(promoted_ids), chat_id
            )
            
        except Exception as e:  # noqa: BLE001 -- handler execute boundary: must catch all to mark job failed before re-raising
            error_msg = "Failed to promote memories from chat %s: %s" % (chat_id, type(e).__name__)
            self._logger.error(error_msg, exc_info=True)
            
            # Retry on transient errors
            retry = self._should_retry_error(e)
            await self.fail_job(job_id, error_msg, retry=retry)
            
            # Re-raise to signal failure to job processor
            raise
    
    async def _find_and_promote_memories(
        self,
        chat_id: UUID,
        importance_threshold: float
    ) -> List[UUID]:
        """
        Find high-importance chat memories and promote them to global.
        
        Args:
            chat_id: Chat to scan for promotable memories
            importance_threshold: Minimum importance score for promotion
        
        Returns:
            List of promoted memory IDs
        """
        # Query memories from this chat with high importance
        # Direct gateway query: source_chat_id filtering at the gateway level avoids
        # an unnecessary service-layer round-trip for this single-filter operation.
        memories = await self._gateway.select(
            "memories",
            filters={
                "source_chat_id": str(chat_id),
                "importance_score": {"gte": importance_threshold}
            },
            limit=100  # Process up to 100 high-importance memories per job
        )
        
        if not memories:
            self._logger.info("No memories found for promotion in chat %s", chat_id)
            return []
        
        self._logger.info(
            "Found %d candidate memories for promotion (importance >= %s)",
            len(memories), importance_threshold,
        )
        
        promoted_ids = []
        
        for memory in memories:
            memory_id = UUID(memory["id"])
            importance = memory.get("importance_score", 0.0)
            
            try:
                # Promote to global: set source_chat_id=NULL, optionally boost importance
                await self._gateway.update(
                    table="memories",
                    record_id=str(memory_id),
                    data={
                        "source_chat_id": None  # NULL = global
                        # Note: importance boost can be added if needed
                    },
                    admin=True
                )
                
                promoted_ids.append(memory_id)
                self._logger.info(
                    "Promoted memory %s to global (importance=%.2f)", memory_id, importance
                )
                
            except Exception as e:  # noqa: BLE001 -- DB boundary: continue with other memories on any failure
                self._logger.error(
                    "Failed to promote memory %s: %s", memory_id, e,
                    exc_info=True,
                )
        
        return promoted_ids
    
    def _should_retry_error(self, error: Exception) -> bool:
        """
        Determine if error is retryable.
        
        Args:
            error: Exception that occurred
        
        Returns:
            True if error is transient and job should be retried
        """
        # Retry on network errors, database timeouts
        error_type = type(error).__name__
        error_str = str(error).lower()
        
        retryable_patterns = [
            "timeout",
            "connection",
            "network",
            "temporarily unavailable",
            "502",
            "503",
            "504"
        ]
        
        for pattern in retryable_patterns:
            if pattern in error_type.lower() or pattern in error_str:
                return True
        
        # Don't retry on validation errors
        non_retryable = ["valueerror", "keyerror"]
        for pattern in non_retryable:
            if pattern in error_type.lower():
                return False
        
        # Default: retry unknown errors once
        return True
