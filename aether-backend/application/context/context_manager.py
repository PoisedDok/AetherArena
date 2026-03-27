"""
Context Manager Application Service

Orchestrates context management operations: status retrieval, summarization, export.

@.architecture
Incoming: api/v1/endpoints/context.py --- {chat_id, str}
Processing: get_context_status(), summarize_context(), export_context() --- {3 jobs: JOB_ORCHESTRATE, JOB_TRANSFORM_DATA, JOB_QUERY_DB}
Outgoing: core/runtime/interpreter.py, data/database/repositories/chat.py --- {Dict[str, Any], json}
"""

from typing import Dict, Any
from uuid import UUID
import logging

from config.settings import get_settings
from core.runtime.interpreter import _maybe_await

logger = logging.getLogger(__name__)


class ContextManager:
    """
    Application service for context management.
    
    Coordinates between API layer and runtime/database layers to provide
    context status, summarization, and export functionality.
    """
    
    def __init__(
        self,
        *,
        interpreter_manager: Any,
        chat_service: Any,
    ):
        """
        Initialize context manager.
        
        Args:
            interpreter_manager: Runtime interpreter manager for context operations
            chat_service: Service for chat/message data access
        """
        self._interpreter_manager = interpreter_manager
        self._chat_repo = chat_service
        self._logger = logger
    
    async def get_context_status(self, chat_id: str) -> Dict[str, Any]:
        """
        Get context status for chat.
        
        Delegates to InterpreterManager to get real-time context status
        based on in-memory OI instances.
        
        Args:
            chat_id: Chat UUID string
            
        Returns:
            Dict with token count, usage percent, status, thresholds
        """
        try:
            status = await _maybe_await(self._interpreter_manager.get_context_status(chat_id))
            self._logger.debug(
                f"Retrieved context status for chat {chat_id[:8]}: "
                f"{status['status']}, {status['token_count']} tokens"
            )
            return status
        except Exception as e:
            self._logger.error("Failed to get context status for chat %s: %s", chat_id[:8], e, exc_info=True)
            raise
    
    async def summarize_context(self, chat_id: str) -> Dict[str, Any]:
        """
        Trigger context summarization for chat.
        
        Captures before/after token counts and returns summarization results.
        
        Args:
            chat_id: Chat UUID string
            
        Returns:
            Dict with success status, summary text, token metrics
        """
        try:
            # Get status before summarization
            status_before = await _maybe_await(self._interpreter_manager.get_context_status(chat_id))
            
            # Trigger summarization
            summary = await _maybe_await(self._interpreter_manager.summarize_context(chat_id))
            
            # Get status after summarization
            status_after = await _maybe_await(self._interpreter_manager.get_context_status(chat_id))
            
            result = {
                "success": summary is not None,
                "summary_text": summary,
                "tokens_before": status_before["token_count"],
                "tokens_after": status_after["token_count"],
                "tokens_saved": status_before["token_count"] - status_after["token_count"],
                "message_count": status_after["message_count"],
            }
            
            self._logger.info(
                f"Summarized context for chat {chat_id[:8]}: "
                f"saved {result['tokens_saved']} tokens"
            )
            
            return result
            
        except Exception as e:
            self._logger.error("Failed to summarize context for chat %s: %s", chat_id[:8], e, exc_info=True)
            raise
    
    async def export_context(self, chat_id: str) -> Dict[str, Any]:
        """
        Export context summary for cross-chat use.
        
        Combines runtime context status with chat metadata to produce
        a exportable context summary.
        
        Args:
            chat_id: Chat UUID string
            
        Returns:
            Dict with chat metadata, summary, token metrics
        """
        try:
            # Get runtime context status
            status = await _maybe_await(self._interpreter_manager.get_context_status(chat_id))
            
            # Get chat metadata from database
            chat_uuid = UUID(chat_id)
            chat = await self._chat_repo.get_chat(chat_uuid)
            
            # Build export response
            settings = get_settings()
            summary_template = settings.context_export.summary_template
            summary = summary_template.format(
                message_count=status["message_count"],
                token_count=status["token_count"],
            )

            result = {
                "chat_id": chat_id,
                "title": chat.title if chat else "Unknown Chat",
                "created_at": chat.created_at if chat else None,
                "summary": summary,
                "key_points": [],  # FUTURE_WORK: LLM-powered key point extraction (Section 7.2)
                "artifacts_used": [],  # FUTURE_WORK: Fetch from ArtifactRepository (Section 7.2)
                "token_count": status["token_count"],
                "message_count": status["message_count"],
            }
            
            self._logger.info("Exported context for chat %s", chat_id[:8])
            
            return result
            
        except Exception as e:
            self._logger.error("Failed to export context for chat %s: %s", chat_id[:8], e, exc_info=True)
            raise

