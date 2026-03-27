"""
Chat Summarization Handler

Processes 'summarize_chat' jobs by calling ChatSummaryService.
Triggered automatically after N messages (configured in database triggers).

@.architecture
Incoming: job_processor.py --- {job with chat_id in metadata}
Processing: Fetch chat, generate summary via LLM, save to database --- {3 jobs: JOB_QUERY_DB, JOB_HTTP_REQUEST, JOB_MANAGE_STORAGE}
Outgoing: ChatSummaryService, database --- {ChatSummary record}
"""

from typing import Dict, Any
from uuid import UUID

from workers.handlers.base_handler import BaseHandler
from application.chat.summary_service import ChatSummaryService
from data.database.uow import SupabaseUnitOfWork
from data.database.persistence_gateway import SupabasePersistenceGateway
from config.settings import get_settings


class SummarizeChatHandler(BaseHandler):
    """
    Handler for chat summarization jobs.
    
    Job metadata expected:
        - chat_id: UUID of chat to summarize
        - summary_type: Optional[str] = "full"
        - force_regenerate: Optional[bool] = False
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
        
        # Initialize ChatSummaryService
        self._summary_service = ChatSummaryService(self._uow, self._settings)
    
    async def execute(self, job: Dict[str, Any]) -> None:
        """
        Execute chat summarization job.
        
        Args:
            job: Job record with metadata containing chat_id
        
        Raises:
            ValueError: If chat_id missing or invalid
            Exception: If summarization fails
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
        
        # Extract optional parameters
        summary_type = metadata.get("summary_type", "full")
        force_regenerate = metadata.get("force_regenerate", False)
        
        # Check if auto-summarization is enabled.
        # ALWAYS check, even when user_id is absent (DB trigger jobs have no user_id).
        # Without this guard, every assistant message would trigger summarization
        # even when auto_summarize is disabled (the default).
        user_id = metadata.get("user_id")
        if user_id:
            # User-specific preference (falls back to central config default internally)
            auto_summarize_enabled = await self._check_user_preference(user_id)
        else:
            # No user_id in metadata (common for DB trigger-created jobs).
            # Fall back to central config default directly.
            auto_summarize_enabled = bool(
                getattr(self._settings.summary_service, "auto_summarize", False)
            )
        
        if not auto_summarize_enabled:
            self._logger.info(
                "Auto-summarization disabled (user_id=%s), skipping job %s",
                user_id or "N/A", job_id,
            )
            await self.complete_job(job_id, {"status": "skipped", "reason": "auto_summarize_disabled"})
            return
        
        try:
            # Generate summary
            self._logger.info(
                "Generating %s summary for chat %s", summary_type, chat_id
            )
            
            summary_record = await self._summary_service.generate_summary(
                chat_id=chat_id,
                summary_type=summary_type,
                force_regenerate=force_regenerate
            )
            
            # Mark job as completed with result
            await self.complete_job(
                job_id,
                result={
                    "summary_id": str(summary_record["id"]),
                    "chat_id": str(chat_id),
                    "summary_type": summary_type,
                    "title": summary_record.get("title")
                }
            )
            
            self._logger.info("Chat %s summarized successfully", chat_id)
            
        except Exception as e:  # noqa: BLE001 -- handler execute boundary: must catch all to mark job failed before re-raising
            error_msg = "Failed to summarize chat %s: %s" % (chat_id, type(e).__name__)
            self._logger.error(error_msg, exc_info=True)
            
            # Retry on transient errors (network, temporary LLM failure)
            retry = self._should_retry_error(e)
            await self.fail_job(job_id, error_msg, retry=retry)
            
            # Re-raise to signal failure to job processor
            raise
    
    async def _check_user_preference(self, user_id: str) -> bool:
        """
        Check if user has auto-summarization enabled.
        
        Args:
            user_id: User ID to check preferences for
        
        Returns:
            True if auto-summarization explicitly enabled by user preference.
            False if disabled or no preference set (falls back to central config
            default, which is auto_summarize=False — user must opt in).
        """
        try:
            # Single source of truth: settings UI persists to preference_key="summary"
            result = await self._gateway.select(
                "user_preferences",
                filters={
                    "user_id": user_id,
                    "preference_key": "summary",
                },
                limit=1,
            )

            # If no preference set, fall back to central config default (NOT "always enabled").
            if not result or len(result) == 0:
                return bool(getattr(self._settings.summary_service, "auto_summarize", False))

            preference_value = result[0].get("preference_value", {}) or {}
            return bool(preference_value.get("auto_summarize", False))
            
        except Exception as e:  # noqa: BLE001 -- preference lookup boundary: default to central config on any failure
            self._logger.warning(
                "Failed to check user preference for %s, defaulting to central config: %s", user_id, e
            )
            # Default to central config on errors (fail-soft, but not 'always enabled').
            return bool(getattr(self._settings.summary_service, "auto_summarize", False))
    
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
