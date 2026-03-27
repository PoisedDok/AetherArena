"""
@.architecture

Incoming: application/stream_orchestrator --- {str chat_id, Any chat_repository}
Processing: auto-generate/update chat summary after user-agent turn --- {2 jobs: JOB_CHECK_PREFERENCE, JOB_SUMMARIZE}
Outgoing: none (HTTP call to summarization API, background operation)

ChatSummarizationService - Application service for background chat summarization

Checks user preference and triggers auto-summarization via the summarization API.
Runs as a non-blocking background task after each completed user-agent turn.
Uses lightweight LLM (liquid/lfm2.5-1.2b) for cumulative summary updates.
"""

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


class ChatSummarizationService:
    """
    Application service for background chat auto-summarization.

    Extracted from StreamOrchestrator to isolate summarization concern.
    """

    def __init__(self, *, chat_repository: Optional[Any] = None):
        """
        Args:
            chat_repository: ChatRepository instance (None disables summarization)
        """
        self._chat_repository = chat_repository
        self._logger = logger

    async def check_and_summarize(self, chat_id: str) -> None:
        """
        Check user preference and trigger auto-summarization if enabled.

        Args:
            chat_id: Chat UUID string to summarize
        """
        try:
            if not self._chat_repository:
                return

            from data.database.repositories.preferences import PreferencesRepository

            gateway = getattr(self._chat_repository, "_gateway", None)
            if not gateway:
                return

            preferences_repo = PreferencesRepository(gateway)

            # Check if auto_summarize is enabled.
            # Settings UI persists under preference_key="summary" (NOT "auto_summarize").
            # The toggle value lives in the "auto_summarize" field of the preference JSONB.
            # The "enabled" field is always True when any summary settings have been saved
            # (it indicates the section was visited, NOT whether auto-summarize is on).
            # This must match the worker handler's _check_user_preference logic.
            summary_pref = await preferences_repo.get_preference(
                preference_key="summary",
                default_value={"auto_summarize": False},
            )

            is_enabled = (
                bool(summary_pref.get("auto_summarize", False))
                if isinstance(summary_pref, dict)
                else False
            )

            if is_enabled:
                self._logger.info(
                    "Auto-summarization enabled, triggering for chat %s...",
                    chat_id[:8],
                )
                await self._summarize(chat_id)
            else:
                self._logger.debug(
                    "Auto-summarization disabled by user preference for chat %s",
                    chat_id[:8],
                )

        except (ConnectionError, TimeoutError, ValueError, KeyError, ImportError, AttributeError) as e:
            self._logger.error(
                "Failed to check auto_summarize preference for chat %s: %s",
                chat_id[:8],
                e,
                exc_info=False,
            )
            self._logger.debug(
                "Skipping auto-summarization due to preference check failure"
            )

    async def _summarize(self, chat_id: str) -> None:
        """
        Auto-generate/update chat summary.

        Runs in background (non-blocking) by queuing a summarization job via AgentService.

        Args:
            chat_id: Chat UUID string to summarize
        """
        try:
            from application.agents.agent_service import AgentService
            
            # Since we only have _chat_repository and need the gateway for AgentService
            gateway = getattr(self._chat_repository, "_gateway", None)
            if not gateway:
                self._logger.error("Cannot queue auto-summary: no database gateway available")
                return
                
            agent_service = AgentService(gateway)
            
            from uuid import UUID
            try:
                chat_uuid = UUID(chat_id)
            except ValueError:
                self._logger.error("Cannot queue auto-summary: invalid chat_id format")
                return
                
            job_id = await agent_service.queue_agent_job(
                job_type="summarize_chat",
                payload={
                    "chat_id": str(chat_uuid),
                    "summary_type": "full",
                    "force_regenerate": True
                },
                priority=50
            )
            
            if job_id:
                self._logger.info(
                    "Auto-summary job queued: chat=%s, job_id=%s",
                    chat_id[:8],
                    job_id
                )
            else:
                self._logger.warning(
                    "Failed to queue auto-summary job: chat=%s",
                    chat_id[:8]
                )

        except (ConnectionError, TimeoutError, OSError, ValueError, ImportError, AttributeError) as e:
            self._logger.error(
                "Auto-summarization error for chat %s: %s",
                chat_id[:8],
                e,
                exc_info=False,
            )
