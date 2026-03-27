"""
@.architecture

Incoming: application/stream_orchestrator --- {str, Optional[str], UUID, primitives}
Processing: user message persistence, pending artifact linking --- {3 jobs: JOB_ENSURE_CHAT, JOB_PERSIST_MESSAGE, JOB_LINK_ARTIFACTS}
Outgoing: application/stream_orchestrator --- {PersistResult dataclass}

UserMessagePersister - Application service for user message persistence

Handles:
- Chat existence verification (race-safe upsert)
- User message creation with optional correlation_id as UUID
- Pending artifact linkage (uploaded before message creation)
- EmitControlEvent generation for user.message_persisted
"""

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

from dateutil import parser as dateutil_parser

from ws.domain.commands.stream_commands import EmitControlEvent

logger = logging.getLogger(__name__)


# Type alias matching stream_orchestrator Command union
Command = Any


@dataclass
class PersistResult:
    """Result of user message persistence."""

    user_msg_id: Optional[UUID] = None
    commands: List[Command] = field(default_factory=list)


class UserMessagePersister:
    """
    Application service for persisting user messages and linking pending artifacts.

    Extracted from StreamOrchestrator to isolate persistence concerns.
    """

    def __init__(self, *, chat_repository: Optional[Any] = None):
        """
        Args:
            chat_repository: ChatRepository instance (None disables persistence)
        """
        self._chat_repository = chat_repository
        self._logger = logger

    async def persist_user_message(
        self,
        *,
        chat_id: str,
        text: str,
        original_text: Optional[str] = None,
        correlation_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> PersistResult:
        """
        Persist user message to database and link pending artifacts.

        Steps:
        1. Ensure chat exists (race-safe upsert)
        2. Create user message (use correlation_id as UUID when valid)
        3. Emit user.message_persisted control event
        4. Link pending artifacts to the new message

        Args:
            chat_id: Chat UUID string
            text: Enriched user message text (with artifact context)
            original_text: Original user text (without artifact context, for DB)
            correlation_id: Optional frontend correlation ID
            metadata: Optional hidden message metadata/context

        Returns:
            PersistResult with user_msg_id and commands to yield
        """
        result = PersistResult()

        if not chat_id or not self._chat_repository:
            return result

        try:
            persist_start = time.time()
            chat_uuid = UUID(chat_id)

            # Ensure chat exists (race-safe upsert logic)
            await self._chat_repository.ensure_chat_exists(
                chat_id=chat_uuid,
                title="New Chat",
            )

            # Use original_text (without artifact context) for clean UI persistence
            persist_content = original_text if original_text is not None else text
            normalized_metadata = dict(metadata) if isinstance(metadata, dict) else {}

            # Try to use correlation_id as message UUID (enables artifact linkage)
            specified_uuid = None
            if correlation_id:
                try:
                    specified_uuid = UUID(correlation_id)
                    self._logger.info(
                        "Using correlation_id as message UUID: %s", correlation_id
                    )
                except (ValueError, TypeError):
                    self._logger.warning(
                        "Invalid correlation_id UUID format: %s, generating new UUID",
                        correlation_id,
                    )

            user_msg = await self._chat_repository.create_message(
                chat_id=chat_uuid,
                role="user",
                content=persist_content,
                timestamp=datetime.now(timezone.utc),
                message_id=specified_uuid,
                metadata=normalized_metadata,
            )
            result.user_msg_id = user_msg.id
            persist_time = time.time() - persist_start
            self._logger.info(
                "User message persisted: msg_id=%s, chat=%s, "
                "original_len=%d, enriched_len=%d, duration=%.1fms",
                user_msg.id,
                chat_id[:8],
                len(persist_content),
                len(text),
                persist_time * 1000,
            )

            # Emit control event so frontend can update local message with backend UUID
            is_handsfree = (
                correlation_id.startswith("handsfree-") if correlation_id else False
            )
            result.commands.append(
                EmitControlEvent(
                    event={
                        "type": "user.message_persisted",
                        "message_id": str(user_msg.id),
                        "correlation_id": correlation_id,
                        "chat_id": chat_id,
                        "role": "user",
                        "sequence_in_chat": user_msg.sequence_in_chat,
                        "content": persist_content,
                        "is_handsfree": is_handsfree,
                    }
                )
            )

            # Link pending artifacts (uploaded before message creation)
            try:
                await self._link_pending_artifacts(
                    chat_uuid,
                    user_msg.id,
                    correlation_id=correlation_id,
                )
            except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as link_error:
                self._logger.error(
                    "Failed to link pending artifacts: %s", link_error, exc_info=True
                )

        except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
            self._logger.error(
                "Failed to persist user message: %s", e, exc_info=True
            )

        return result

    async def _link_pending_artifacts(
        self,
        chat_id: UUID,
        message_id: UUID,
        correlation_id: Optional[str] = None,
    ) -> None:
        """
        Link user-uploaded artifacts (with message_id=NULL) to the newly created user message.

        Uses ChatRepository methods (no direct gateway access).

        Args:
            chat_id: Chat UUID
            message_id: Newly created user message UUID
            correlation_id: Optional correlation ID from frontend
        """
        if not self._chat_repository:
            return

        try:
            cutoff = datetime.now(timezone.utc) - timedelta(seconds=60)

            chat_uuid = UUID(str(chat_id)) if not isinstance(chat_id, UUID) else chat_id

            # Use repository method to get pending artifacts (message_id IS NULL)
            result = await self._chat_repository.get_pending_artifacts(chat_uuid)

            if not result:
                self._logger.debug("No pending artifacts found for chat %s", chat_id)
                return

            # Prefer correlation_id-based matching if provided (deterministic linkage)
            recent_artifacts: List[Dict[str, Any]] = []
            if correlation_id:

                def _get_correlation_id(artifact_row: Dict[str, Any]) -> Optional[str]:
                    metadata = artifact_row.get("metadata") or {}
                    if isinstance(metadata, str):
                        try:
                            metadata = json.loads(metadata)
                        except (json.JSONDecodeError, ValueError):
                            metadata = {}
                    return metadata.get("correlation_id")

                recent_artifacts = [
                    a for a in result if _get_correlation_id(a) == correlation_id
                ]
                if not recent_artifacts:
                    self._logger.debug(
                        "No pending artifacts matched correlation_id=%s; "
                        "falling back to time window",
                        correlation_id,
                    )

            # Fallback: filter by created_at timestamp in-memory
            if not recent_artifacts:
                recent_artifacts = [
                    a
                    for a in result
                    if a.get("created_at")
                    and dateutil_parser.parse(a["created_at"]) >= cutoff
                ]

            if not recent_artifacts:
                self._logger.debug("No recent pending artifacts for chat %s", chat_id)
                return

            # Link each artifact to the message
            updated_count = 0
            msg_uuid = (
                UUID(str(message_id)) if not isinstance(message_id, UUID) else message_id
            )
            for artifact in recent_artifacts:
                await self._chat_repository.update_artifact_message_id(
                    artifact_id=artifact["id"],
                    message_id=msg_uuid,
                )
                updated_count += 1

            if updated_count > 0:
                self._logger.info(
                    "Linked %d pending artifact(s) to message %s",
                    updated_count,
                    message_id,
                )

        except (ConnectionError, TimeoutError, ValueError, KeyError) as e:
            self._logger.error(
                "Failed to link pending artifacts: %s", e, exc_info=True
            )
            # Don't raise - expected database/network errors shouldn't break message flow
