"""
Chat History Service

Loads sanitized chat history for WebSocket context resets.
Provides hydration for runtime context with tracing support.

@.architecture
Incoming: ws/handlers.py, data/database/persistence_gateway.py --- {SupabasePersistenceGateway, chat_id, client_id}
Processing: load_history() --- {1 jobs: JOB_MANAGE_STORAGE}
Outgoing: ws/handlers.py --- {List[Dict[str, Any]]}
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional
from uuid import UUID

from data.database.uow import SupabaseRequestContext, SupabaseUnitOfWork
from data.database.persistence_gateway import SupabasePersistenceGateway
from data.database.repositories.chat import ChatRepository
from monitoring import get_logger

logger = get_logger(__name__)

class ChatHistoryService:
    """Provide safe chat history hydration for runtime context resets."""

    def __init__(self, gateway: SupabasePersistenceGateway) -> None:
        if gateway is None:
            raise ValueError("ChatHistoryService requires a SupabasePersistenceGateway")
        self._gateway = gateway

    async def load_history(
        self,
        chat_id: UUID,
        *,
        limit: Optional[int] = None,
        client_id: Optional[str] = None,
        frontend_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch sanitized message history for the given chat."""
        try:
            context = SupabaseRequestContext(
                request_id=f"ws-history-{uuid.uuid4().hex}",
                correlation_id=correlation_id,
                extras={
                    "ws.client_id": client_id,
                    "ws.frontend_id": frontend_id,
                    "chat.id": str(chat_id),
                    "source": "ws.handlers.context_reset",
                },
            )

            from data.database.repositories.proactive_agent import ProactiveAgentRepository
            
            async with SupabaseUnitOfWork(self._gateway, context) as uow:
                repository = ChatRepository(uow.gateway)
                proactive_repo = ProactiveAgentRepository(uow.gateway)
                messages = await repository.get_messages(chat_id, limit=limit)

            history: List[Dict[str, Any]] = []
            for message in messages:
                if not message.content or message.role not in {"user", "assistant", "system"}:
                    continue
                raw_metadata = getattr(message, "metadata", None)
                normalized_metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
                
                # HYDRATE PROACTIVE CONTEXT
                # Fetch full RAG context from proactive_agent_runs to avoid storing massive JSON in messages table
                if normalized_metadata.get("source") == "proactive" and "run_id" in normalized_metadata:
                    try:
                        run_id = normalized_metadata["run_id"]
                        run_data = await proactive_repo.get_run_by_id(run_id)
                        if run_data and run_data.get("context_gathered"):
                            normalized_metadata["context"] = run_data["context_gathered"]
                    except Exception as e:
                        logger.warning("Failed to hydrate proactive context for message %s: %s", message.id, e)

                history.append(
                    {
                        "role": message.role,
                        "content": message.content,
                        "metadata": normalized_metadata,
                    }
                )

            logger.debug("Loaded %s messages for chat %s", len(history), chat_id)
            return history
        except Exception as e:
            logger.error("Failed to load history for chat %s: %s", chat_id, e, exc_info=True)
            raise

    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass

__all__ = ["ChatHistoryService"]
