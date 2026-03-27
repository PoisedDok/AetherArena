"""
Runtime Engine

Facade coordinating runtime components (coordinator, chat streamer, document processor, interpreter manager).
Provides unified interface for API endpoints and WebSocket handlers.

@.architecture
Incoming: core/runtime/coordinator.py, config/settings.py, api/dependencies.py --- {Settings, RuntimeCoordinator, session_id}
Processing: start_engine(), stream_chat(), process_message(), handle_file_chat(), cleanup_stale_resources() --- {6 jobs: JOB_CLEANUP_RESOURCE, JOB_HEALTH_CHECK, JOB_INITIALIZE_COMPONENT, JOB_MANAGE_CONNECTION, JOB_ORCHESTRATE, JOB_TRANSFORM_DATA}
Outgoing: api/v1/endpoints/chat.py, ws/hub.py, application/chat/service.py --- {RuntimeEngine instance, AsyncGenerator[Dict[str, Any], None]}
"""

from __future__ import annotations

import inspect
import uuid
from pathlib import Path
import logging
from typing import Any, AsyncGenerator, Dict, Optional, Union

from .coordinator import RuntimeCoordinator
from .config import ConfigManager, RuntimeConfig
from .document import DocumentProcessor
from .interpreter import InterpreterManager
from .request import RequestTracker
from .streaming import ChatStreamer

try:
    from config.settings import get_settings as _load_settings
except ImportError:  # pragma: no cover - optional in test contexts
    _load_settings = None

logger = logging.getLogger(__name__)


class RuntimeEngine:
    """Runtime facade — external OI server mode only (AGPL isolation)."""

    def __init__(self, settings: Optional[Any] = None):
        self._settings = settings if settings is not None else _load_default_settings()
        self._runtime_config = _build_runtime_config(self._settings)
        self._coordinator = RuntimeCoordinator(self._settings) if self._settings is not None else None
        self._config_manager = get_config_manager()
        self._request_tracker = get_request_tracker()
        self._chat_streamer = ChatStreamer(self._config_manager, self._request_tracker)
        self._document_processor = _create_document_processor(self._config_manager, self._request_tracker)
        self._interpreter_manager = get_interpreter_manager()

    @property
    def settings(self) -> Any:
        return self._settings or self._runtime_config

    @settings.setter
    def settings(self, value: Any) -> None:
        self._settings = value
        self._runtime_config = _build_runtime_config(self._settings)
        if self._coordinator:
            self._coordinator.settings = value
        else:
            self._coordinator = RuntimeCoordinator(value)

    @property
    def _initialized(self) -> bool:
        """Delegate to coordinator — used by RuntimeHealthChecker."""
        return self._coordinator is not None and self._coordinator._initialized

    @property
    def coordinator(self) -> Optional[RuntimeCoordinator]:
        return self._coordinator

    async def start(self, mcp_manager=None) -> None:
        if self._coordinator:
            await self._coordinator.start(mcp_manager=mcp_manager)

    async def stop(self) -> None:
        if self._coordinator:
            await self._coordinator.stop()
        reset_singletons()

    async def stop_generation(self, request_id: str, *, chat_id: Optional[str] = None) -> bool:
        tracker = self._request_tracker
        is_active = None
        if tracker and hasattr(tracker, "get_request_info"):
            is_active = bool(tracker.get_request_info(request_id))

        if self._coordinator:
            await self._coordinator.stop_generation(request_id, chat_id=chat_id)
            
        return True

    async def stop_session_generations(self, session_id: str) -> int:
        tracker = self._request_tracker
        if not tracker or not hasattr(tracker, "get_requests_by_client"):
            return 0
            
        active_requests = tracker.get_requests_by_client(session_id)
        stopped = 0
        for rid in active_requests.keys():
            try:
                await self.stop_generation(rid)
                stopped += 1
            except Exception as e:
                logger.warning("Failed to stop generation %s: %s", rid, e)
        return stopped

    async def register_backend_apis(self, fastapi_app: Any) -> Dict[str, Any]:
        """
        External OI mode (AGPL isolation): tools are injected by oi_server_wrapper.py
        during each per-chat server's initialization phase.  No OI server is spawned
        at startup.  No in-process ``computer`` object exists to inject into.
        """
        # OI runs exclusively as an external process (AGPL).
        # Each per-chat OI server receives tools via the wrapper script
        # (OIToolCatalogBridge + backend_tools_registry.yaml) during its init.
        # Nothing to do here — no startup-time OI spawn, no circular dependency.
        return {
            "success": True,
            "skipped": True,
            "reason": "External OI mode: tools injected per-chat by oi_server_wrapper.py",
        }

    async def reset_context(self, client_id: str, chat_id: Optional[str] = None) -> None:
        if self._coordinator:
            await self._coordinator.reset_context(client_id, chat_id=chat_id)
        elif self._request_tracker:
            client_requests = self._request_tracker.get_requests_by_client(client_id)
            for request_id in list(client_requests.keys()):
                await self._request_tracker.cancel_request(request_id)

    async def get_interpreter(
        self,
        identifier: Optional[str] = None,
        *,
        chat_id: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Optional[Any]:
        """
        Return an interpreter instance for a chat/session.

        Backwards-compat: some callers pass a single identifier positionally.
        Prefer chat_id isolation when available.
        """
        resolved_chat_id = chat_id or identifier
        resolved_session_id = session_id if session_id is not None else None
        interpreter = await _maybe_await(get_interpreter(chat_id=resolved_chat_id, session_id=resolved_session_id))
        return interpreter

    async def process_message(
        self,
        message: str,
        session_id: str,
        *,
        history: Optional[list] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        history = history or kwargs.get("history", [])
        interpreter = await _maybe_await(get_interpreter(session_id))

        if interpreter is None:
            return {"response": ""}

        if hasattr(interpreter, "process_message"):
            result = interpreter.process_message(
                message=message,
                session_id=session_id,
                history=history,
            )
            result = await _maybe_await(result)
            if inspect.isasyncgen(result):
                chunks = await _resolve_async_generator(result)
                return {"content": chunks, "history": history}
            return _normalize_response(result, history)

        if hasattr(interpreter, "chat"):
            chat_result = interpreter.chat(message)
            chat_result = await _maybe_await(chat_result)
            if inspect.isasyncgen(chat_result):
                chunks = []
                async for chunk in chat_result:
                    chunks.append(chunk)
                return {"content": chunks, "history": history}
            return _normalize_response(chat_result, history)

        return {"response": "", "history": history}

    async def process_file(
        self,
        file_input: Union[Path, str, Dict[str, Any]],
        *,
        user_prompt: str = "",
    ) -> Dict[str, Any]:
        result = await _maybe_await(
            self._document_processor.process_file(
                file_input=file_input,
                user_prompt=user_prompt,
            )
        )
        if "status" not in result and result.get("success") is True:
            result = {**result, "status": "success"}
        return result

    async def stream_chat(
        self,
        message: Optional[str] = None,
        session_id: Optional[str] = None,
        *,
        request_id: Optional[str] = None,
        image_b64: Optional[str] = None,
        client_id: Optional[str] = None,
        text: Optional[str] = None,
        chat_id: Optional[str] = None,
        show_thinking: bool = True,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        payload = message if message is not None else text
        if payload is None:
            raise ValueError("stream_chat requires 'message' or 'text'")

        session = session_id or client_id
        if session is None:
            raise ValueError("stream_chat requires 'session_id' or 'client_id'")

        client = client_id or session
        request = request_id or f"req-{uuid.uuid4().hex}"
        
        # Use chat_id for interpreter isolation, fallback to session for backward compat
        interpreter = await _maybe_await(get_interpreter(chat_id=chat_id, session_id=session))
        settings = self._settings or self._runtime_config

        supports_vision = bool(getattr(getattr(settings, "llm", None), "supports_vision", False))
        if image_b64 and not supports_vision:
            # Fail-fast: convert image to text via Docling/VLM proxy for text-only models.
            result = await _maybe_await(
                self._document_processor.process_file(
                    base64_data=image_b64,
                    filename="image.png",
                    user_prompt=payload,
                )
            )
            if not result.get("success"):
                raise RuntimeError(result.get("error") or "Vision preprocessing failed")
            combined_prompt = result.get("combined_prompt") or result.get("content") or result.get("text")
            if not combined_prompt:
                raise RuntimeError("Vision preprocessing returned empty content")
            payload = combined_prompt
            image_b64 = None

        async for chunk in self._chat_streamer.stream_chat(
            client_id=client,
            text=payload,
            image_b64=image_b64,
            request_id=request,
            interpreter=interpreter,
            settings=settings,
            chat_id=chat_id,
            show_thinking=show_thinking,
        ):
            yield chunk

    async def handle_file_chat(
        self,
        file_data: Dict[str, Any],
        prompt: str = "",
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if self._coordinator:
            return await self._coordinator.handle_file_chat(
                file_data=file_data,
                prompt=prompt,
                request_id=request_id,
            )
        chat_id = file_data.get("chat_id") or file_data.get("session_id")
        interpreter = await _maybe_await(get_interpreter(chat_id=chat_id))
        return await self._document_processor.process_file_chat(
            file_data=file_data,
            prompt=prompt,
            request_id=request_id,
            interpreter=interpreter,
        )

    async def handle_file_chat_multipart(
        self,
        file_data: Dict[str, Any],
        prompt: str = "",
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if self._coordinator:
            return await self._coordinator.handle_file_chat_multipart(
                file_data=file_data,
                prompt=prompt,
                request_id=request_id,
            )
        chat_id = file_data.get("chat_id") or file_data.get("session_id")
        interpreter = await _maybe_await(get_interpreter(chat_id=chat_id))
        return await self._document_processor.process_file_chat_multipart(
            file_data=file_data,
            prompt=prompt,
            request_id=request_id,
            interpreter=interpreter,
        )

    async def start_audio_stream(self, client_id: str) -> None:
        if self._coordinator:
            await self._coordinator.start_audio_stream(client_id)

    async def end_audio_stream(self, client_id: str) -> None:
        if self._coordinator:
            await self._coordinator.end_audio_stream(client_id)

    async def handle_audio_chunk(self, client_id: str, chunk: bytes) -> None:
        if self._coordinator:
            await self._coordinator.handle_audio_chunk(client_id, chunk)

    def get_health_status(self) -> Dict[str, Any]:
        coordinator_health = (
            self._coordinator.get_health_status() if self._coordinator else {"runtime": {"initialized": False}}
        )
        return {
            "engine": {
                "settings_loaded": self._settings is not None,
                "runtime_config": {
                    "context_window": getattr(self._runtime_config, "context_window", None),
                    "max_tokens": getattr(self._runtime_config, "max_tokens", None),
                },
            },
            "coordinator": coordinator_health,
            "request_tracker": self._request_tracker.get_health_status()
            if hasattr(self._request_tracker, "get_health_status")
            else {},
            "chat_streamer": self._chat_streamer.get_health_status()
            if hasattr(self._chat_streamer, "get_health_status")
            else {},
        }

    def is_ready(self) -> bool:
        if self._coordinator:
            return self._coordinator.is_ready()
        return True

    async def cleanup_stale_resources(self) -> int:
        if self._coordinator:
            return await self._coordinator.cleanup_stale_resources()
        return await self._request_tracker.cleanup_stale_requests()

    async def get_history(self, session_id: str) -> list:
        if self._coordinator:
            return await self._coordinator.get_history(session_id)
        return self._chat_streamer.get_history(session_id)

    def set_history(self, session_id: str, messages: list) -> None:
        if self._coordinator:
            self._coordinator.set_history(session_id, messages)
        else:
            self._chat_streamer.set_history(session_id, messages)

    def get_history_limit(self) -> int:
        if self._coordinator:
            return self._coordinator.get_history_limit()
        return self._chat_streamer.get_history_limit()

    def inject_system_context(self, session_id: str, context: str) -> None:
        """Delegate system context injection to coordinator."""
        if self._coordinator:
            self._coordinator.inject_system_context(session_id, context)


def _load_default_settings() -> Optional[Any]:
    if _load_settings is None:
        return None
    try:
        return _load_settings()
    except Exception as exc:  # noqa: BLE001 -- settings loading: return None on any failure
        logger.debug("Failed to load default settings: %s", exc)
        return None


def _build_runtime_config(settings: Optional[Any]) -> RuntimeConfig:
    if settings is None:
        return RuntimeConfig()
    try:
        return RuntimeConfig.from_settings(settings)
    except Exception as exc:  # noqa: BLE001 -- config hydration: return defaults on any failure
        logger.debug("RuntimeConfig hydration failed: %s", exc)
        return RuntimeConfig()


_CONFIG_MANAGER_SINGLETON: Optional[ConfigManager] = None
_REQUEST_TRACKER_SINGLETON: Optional[RequestTracker] = None
_INTERPRETER_MANAGER_SINGLETON: Optional[InterpreterManager] = None
def get_config_manager() -> ConfigManager:
    global _CONFIG_MANAGER_SINGLETON
    if _CONFIG_MANAGER_SINGLETON is None:
        _CONFIG_MANAGER_SINGLETON = ConfigManager()
    return _CONFIG_MANAGER_SINGLETON


def get_request_tracker() -> RequestTracker:
    global _REQUEST_TRACKER_SINGLETON
    if _REQUEST_TRACKER_SINGLETON is None:
        _REQUEST_TRACKER_SINGLETON = RequestTracker()
    return _REQUEST_TRACKER_SINGLETON


def get_interpreter_manager() -> InterpreterManager:
    global _INTERPRETER_MANAGER_SINGLETON
    if _INTERPRETER_MANAGER_SINGLETON is None:
        _INTERPRETER_MANAGER_SINGLETON = InterpreterManager()
    return _INTERPRETER_MANAGER_SINGLETON


def reset_singletons() -> None:
    """
    Clear module-level singletons so a fresh RuntimeEngine can be created.

    Called from RuntimeEngine.stop() to prevent stale instances from
    being reused across engine restarts (hot reload, test teardown).
    """
    global _CONFIG_MANAGER_SINGLETON, _REQUEST_TRACKER_SINGLETON, _INTERPRETER_MANAGER_SINGLETON
    _CONFIG_MANAGER_SINGLETON = None
    _REQUEST_TRACKER_SINGLETON = None
    _INTERPRETER_MANAGER_SINGLETON = None


def _create_document_processor(
    config_manager: ConfigManager,
    request_tracker: RequestTracker,
) -> DocumentProcessor:
    try:
        return DocumentProcessor(config_manager, request_tracker)
    except TypeError:
        return DocumentProcessor()


def get_interpreter(chat_id: Optional[str] = None, session_id: Optional[str] = None):
    """Get interpreter instance, preferring chat_id over session_id for isolation."""
    async def _resolve():
        manager = get_interpreter_manager()
        # Prefer chat_id for proper isolation, fallback to session_id for backward compat
        identifier = chat_id or session_id
        return await manager.get_interpreter(chat_id=identifier)

    return _resolve()


async def _resolve_async_generator(gen) -> list:
    items = []
    async for chunk in gen:
        items.append(chunk)
    return items


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value) or hasattr(value, "__await__"):
        return await value
    return value


def _normalize_response(result: Any, history: list) -> Dict[str, Any]:
    if isinstance(result, dict):
        return result
    if isinstance(result, list):
        return {"content": result, "history": history}
    if result is None:
        return {"response": "", "history": history}
    return {"response": result, "history": history}
