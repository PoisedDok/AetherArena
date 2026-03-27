"""
Runtime Session Manager

Provides request tracking, chat streaming, and session lifecycle management.
Wraps RequestTracker and ChatStreamer with cleanup and cancellation coordination.

@.architecture
Incoming: core/runtime/coordinator.py, core/runtime/config.py --- {ConfigManager, client_id, request_id}
Processing: initialize(), cancel_request(), reset_context(), cleanup_stale_resources() --- {3 jobs: JOB_CLEANUP_RESOURCE, JOB_MANAGE_SESSIONS, JOB_ORCHESTRATE}
Outgoing: core/runtime/coordinator.py, ws/handlers.py --- {AsyncGenerator[Dict[str, Any], None], bool}
"""

from __future__ import annotations

import logging
from typing import Any, AsyncGenerator, Dict, Optional

logger = logging.getLogger(__name__)


class RuntimeSessionManager:
    """
    Provides request tracking, chat streaming, and session lifecycle helpers.
    """

    def __init__(self) -> None:
        self._request_tracker: Optional[Any] = None
        self._chat_streamer: Optional[Any] = None
        self._audio_sessions: Dict[str, bool] = {}

    async def initialize(self, config_manager: Any) -> None:
        if self._request_tracker and self._chat_streamer:
            return
        if not config_manager:
            raise RuntimeError("Config manager required for session manager initialization")

        from .engine import get_request_tracker
        from .streaming import ChatStreamer

        self._request_tracker = get_request_tracker()
        self._chat_streamer = ChatStreamer(config_manager, self._request_tracker)
        logger.debug("Session manager initialized request tracker and chat streamer")

    async def cleanup(self) -> None:
        if self._chat_streamer and hasattr(self._chat_streamer, "cleanup"):
            await self._chat_streamer.cleanup()
        if self._request_tracker and hasattr(self._request_tracker, "cleanup"):
            await self._request_tracker.cleanup()
        self._chat_streamer = None
        self._request_tracker = None
        self._audio_sessions.clear()

    async def cancel_request(self, request_id: str) -> bool:
        if not self._request_tracker:
            return False
        return await self._request_tracker.cancel_request(request_id)

    async def reset_context(self, client_id: str, chat_id: Optional[str] = None) -> None:
        if self._chat_streamer:
            # IMPORTANT: context_reset is used for chat switching. Do NOT clear per-chat history
            # or you will lose continuity when switching back to an existing chat.
            #
            # We only clear client-scoped history (legacy/no-chat-id sessions) to prevent
            # cross-chat bleed in fallback paths.
            history_keys = [client_id]
            for key in history_keys:
                existing_history = self._chat_streamer.get_history(key)
                if existing_history:
                    self._chat_streamer.clear_history(key)
                    logger.info(
                        "✅ Cleared %s HTTP fallback messages for client %s",
                        len(existing_history),
                        key,
                    )
        if self._request_tracker:
            client_requests = self._request_tracker.get_requests_by_client(client_id)
            for request_id in list(client_requests.keys()):
                await self._request_tracker.cancel_request(request_id)
            logger.debug("Cancelled %s active requests for client %s", len(client_requests), client_id)
        if client_id in self._audio_sessions:
            self._audio_sessions.pop(client_id, None)

    async def cleanup_stale_resources(self) -> int:
        if not self._request_tracker:
            return 0
        return await self._request_tracker.cleanup_stale_requests()

    async def stream_chat(
        self,
        *,
        client_id: str,
        text: str,
        image_b64: Optional[str],
        request_id: str,
        interpreter: Optional[Any],
        settings: Any,
        chat_id: Optional[str] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        if not self._chat_streamer:
            raise RuntimeError("Chat streamer not initialized")
        async for chunk in self._chat_streamer.stream_chat(
            client_id=client_id,
            text=text,
            image_b64=image_b64,
            request_id=request_id,
            interpreter=interpreter,
            settings=settings,
            chat_id=chat_id,
        ):
            yield chunk

    async def start_audio_stream(self, client_id: str) -> None:
        self._audio_sessions[client_id] = True

    async def end_audio_stream(self, client_id: str) -> None:
        self._audio_sessions.pop(client_id, None)

    async def handle_audio_chunk(self, client_id: str, chunk: bytes) -> None:
        # Placeholder for future streaming STT integration
        return None

    def get_history(self, session_id: str) -> list:
        if not self._chat_streamer:
            return []
        return self._chat_streamer.get_history(session_id)

    def set_history(self, session_id: str, messages: list) -> list:
        if not self._chat_streamer:
            return []
        self._chat_streamer.set_history(session_id, messages)
        return self._chat_streamer.get_history(session_id) or []

    def get_history_limit(self) -> int:
        if not self._chat_streamer:
            return 0
        return self._chat_streamer.get_history_limit()

    def get_request_count(self) -> int:
        if not self._request_tracker:
            return 0
        return self._request_tracker.get_request_count()

    def get_health_status(self) -> Dict[str, Any]:
        return {
            "request_tracker": (
                self._request_tracker.get_health_status()
                if self._request_tracker and hasattr(self._request_tracker, "get_health_status")
                else {"available": self._request_tracker is not None}
            ),
            "chat_streamer": (
                self._chat_streamer.get_health_status()
                if self._chat_streamer and hasattr(self._chat_streamer, "get_health_status")
                else {"available": self._chat_streamer is not None}
            ),
            "audio_sessions": len(self._audio_sessions),
        }

    @property
    def request_tracker(self) -> Optional[Any]:
        return self._request_tracker

    @property
    def chat_streamer(self) -> Optional[Any]:
        return self._chat_streamer


