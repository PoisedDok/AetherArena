"""
@.architecture

Incoming: application/stream_orchestrator --- {str, List[str], UUID, primitives}
Processing: assistant text accumulation flush and persistence --- {2 jobs: JOB_JOIN_PARTS, JOB_PERSIST_MESSAGE}
Outgoing: application/stream_orchestrator --- {Optional[EmitAssistantMessageFlushed]}

AssistantTextFlusher - Application service for assistant text segment persistence

Deduplicates the 3x-repeated flush logic in StreamOrchestrator.relay_stream().
Each call joins accumulated text parts, persists as an assistant message linked
to the user message, clears the parts list, and returns the command to yield.
"""

import logging
from datetime import datetime, timezone
from typing import Any, List, Optional
from uuid import UUID

from ws.domain.commands.trail_commands import EmitAssistantMessageFlushed

logger = logging.getLogger(__name__)


class AssistantTextFlusher:
    """
    Application service for flushing accumulated assistant text to the database.

    Consolidates the repeated pattern:
    1. Join accumulated text parts
    2. Persist as assistant message (linked to user message via parent_message_id)
    3. Clear the parts list
    4. Return EmitAssistantMessageFlushed command (or None)
    """

    def __init__(self, *, chat_repository: Optional[Any] = None):
        """
        Args:
            chat_repository: ChatRepository instance (None disables persistence)
        """
        self._chat_repository = chat_repository
        self._logger = logger

    async def flush_if_pending(
        self,
        *,
        chat_id: str,
        parts: List[str],
        user_msg_id: Optional[UUID],
        timestamp: Optional[datetime] = None,
    ) -> Optional[EmitAssistantMessageFlushed]:
        """
        Flush accumulated assistant text to database if any content exists.

        Joins all parts, persists as a single assistant message, clears the
        parts list in-place, and returns the command for the presentation layer.

        Args:
            chat_id: Chat UUID string
            parts: Mutable list of accumulated text chunks (cleared on success)
            user_msg_id: Parent user message UUID (for linking)
            timestamp: Optional explicit timestamp (defaults to UTC now)

        Returns:
            EmitAssistantMessageFlushed command if text was flushed, None otherwise
        """
        if not self._chat_repository or not parts or not user_msg_id:
            return None

        assistant_segment = "".join(parts)
        if not assistant_segment or not assistant_segment.strip():
            return None

        try:
            chat_uuid = UUID(chat_id) if isinstance(chat_id, str) else chat_id
            ts = timestamp or datetime.now(timezone.utc)

            assistant_msg = await self._chat_repository.create_message(
                chat_id=chat_uuid,
                role="assistant",
                content=assistant_segment,
                parent_message_id=user_msg_id,
                timestamp=ts,
            )

            # Clear parts in-place (caller's list is emptied)
            parts.clear()

            if assistant_msg:
                self._logger.info(
                    "Assistant text flushed: msg_id=%s, chat=%s, len=%d, seq=%s",
                    assistant_msg.id,
                    chat_id[:8] if isinstance(chat_id, str) else str(chat_id)[:8],
                    len(assistant_segment),
                    assistant_msg.sequence_in_chat,
                )
                return EmitAssistantMessageFlushed(
                    chat_id=chat_id if isinstance(chat_id, str) else str(chat_id),
                    sequence_in_chat=assistant_msg.sequence_in_chat,
                    content=assistant_segment,
                    message_id=str(assistant_msg.id),
                )

        except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
            self._logger.warning("Failed to flush assistant text: %s", e)

        return None
