"""
Runtime Coordinator

Orchestrates runtime modules: config manager, interpreter adapter, media service, session manager.
Manages initialization sequencing, lifecycle, and graceful shutdown.

@.architecture
Incoming: app.py, api/dependencies.py, core/runtime/engine.py --- {Settings, mcp_manager}
Processing: start(), initialize_all_modules(), cleanup_all_modules(), handle_file_chat() --- {6 jobs: JOB_CLEANUP_RESOURCE, JOB_HEALTH_CHECK, JOB_INITIALIZE_COMPONENT, JOB_MANAGE_SESSIONS, JOB_MANAGE_TASK, JOB_ORCHESTRATE}
Outgoing: core/runtime/engine.py, ws/handlers.py --- {RuntimeCoordinator instance, health_status Dict}
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncGenerator, Dict, Optional

from .interpreter_adapter import RuntimeInterpreterAdapter
from .media import RuntimeMediaService
from .session import RuntimeSessionManager

logger = logging.getLogger(__name__)


class RuntimeCoordinator:
    """
    Orchestrates runtime modules (config, interpreter adapter, media service, sessions).
    """

    def __init__(self, settings: Any):
        self.settings = settings
        self._config_manager: Optional[Any] = None
        self._session_manager: Optional[RuntimeSessionManager] = None
        self._interpreter_adapter: Optional[RuntimeInterpreterAdapter] = None
        self._media_service: Optional[RuntimeMediaService] = None
        self._initialized = False
        self._startup_complete = False
        self._is_disposed = False
        self._background_tasks: set[asyncio.Task] = set()

    async def start(self, mcp_manager=None) -> None:
        if self._is_disposed:
            raise RuntimeError("Cannot start a disposed RuntimeCoordinator")
        try:
            logger.info("[Runtime] Initializing production runtime coordinator...")
            
            # PHASE 1: Initialize Config Manager FIRST
            await self._init_config_manager()
            if not self._config_manager:
                raise RuntimeError("Critical module (ConfigManager) failed to initialize")
            
            # PHASE 2: Load and Apply Settings before initializing other modules
            # This ensures InterpreterManager has external OI server config before first use.
            self.settings = self._config_manager.load_and_apply_settings(self.settings)
            logger.info("✅ Runtime settings loaded and applied to environment")

            # PHASE 3: Initialize remaining modules in correct order
            await self._initialize_remaining_modules()
            
            if self._interpreter_adapter:
                try:
                    await self._interpreter_adapter.configure(self.settings, mcp_manager)
                except Exception as exc:  # noqa: BLE001 -- interpreter config: non-critical for startup
                    logger.warning("Interpreter configuration failed: %s", exc)
            
            self._startup_complete = True
            logger.info("[Runtime] Runtime coordinator startup complete")
        except Exception:  # noqa: BLE001 -- top-level startup boundary: must cleanup all modules on any failure
            logger.error("[Runtime] Startup failed", exc_info=True)
            await self._cleanup_all_modules()
            raise

    async def _initialize_remaining_modules(self) -> bool:
        """Initialize all modules except config_manager (already initialized in PHASE 1)."""
        if self._initialized:
            return True
        
        logger.info("Initializing remaining runtime modules...")
        initialization_results = {}
        
        # Define remaining initialization tasks in order
        init_tasks = [
            ("session_manager", self._init_session_manager),
            ("interpreter_adapter", self._init_interpreter_adapter),
            ("media_service", self._init_media_service),
        ]
        
        for name, init_fn in init_tasks:
            try:
                await init_fn()
                initialization_results[name] = True
                logger.info("Module initialized: %s", name)
            except Exception as exc:  # noqa: BLE001 -- module init boundary: must catch all to continue initializing other modules
                logger.error("Failed to initialize module %s: %s", name, exc, exc_info=True)
                initialization_results[name] = False
                if name in ["session_manager"]:
                    logger.critical("CRITICAL MODULE FAILURE: %s", name)
                    await self._cleanup_all_modules()
                    return False
        
        self._initialized = True
        return True

    async def _init_config_manager(self) -> None:
        if self._config_manager:
            return
        from .config import ConfigManager

        self._config_manager = ConfigManager()
        logger.debug("Config manager initialized")

    async def _init_session_manager(self) -> None:
        if self._session_manager:
            return
        if not self._config_manager:
            raise RuntimeError("Config manager required before session manager initialization")
        session_manager = RuntimeSessionManager()
        await session_manager.initialize(self._config_manager)
        self._session_manager = session_manager
        logger.debug("Session manager initialized")

    async def _init_interpreter_adapter(self) -> None:
        if self._interpreter_adapter:
            return
        adapter = RuntimeInterpreterAdapter()
        await adapter.initialize()
        self._interpreter_adapter = adapter
        logger.debug("Interpreter adapter initialized")

    async def _init_media_service(self) -> None:
        if self._media_service:
            return
        if not self._config_manager or not self._session_manager or not self._session_manager.request_tracker:
            raise RuntimeError("Session manager and config manager required before media service initialization")
        media_service = RuntimeMediaService()
        await media_service.initialize(self._config_manager, self._session_manager.request_tracker)
        self._media_service = media_service
        logger.debug("Media service initialized")

    async def stop(self) -> None:
        if self._is_disposed:
            return
        logger.info("[Runtime] Shutting down runtime coordinator...")
        # Cancel tracked background tasks before module cleanup
        if self._background_tasks:
            tasks = list(self._background_tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self._background_tasks.clear()
        await self._cleanup_all_modules()
        self._startup_complete = False
        self._is_disposed = True
        logger.info("[Runtime] Runtime coordinator shutdown complete")

    async def _cleanup_all_modules(self) -> None:
        logger.info("Cleaning up runtime modules...")
        cleanup_steps = [
            ("media_service", getattr(self._media_service, "cleanup", None)),
            ("session_manager", getattr(self._session_manager, "cleanup", None)),
            ("interpreter_adapter", getattr(self._interpreter_adapter, "cleanup", None)),
            ("config_manager", getattr(self._config_manager, "cleanup", None)),
        ]
        for name, cleanup_fn in cleanup_steps:
            if cleanup_fn:
                try:
                    await cleanup_fn()
                    logger.debug("Cleaned up %s", name)
                except Exception as exc:  # noqa: BLE001 -- cleanup loop: must catch all to continue cleaning remaining modules
                    logger.warning("Error cleaning up %s: %s", name, exc)
        self._media_service = None
        self._session_manager = None
        self._interpreter_adapter = None
        self._config_manager = None
        self._initialized = False
        logger.info("✅ Runtime modules cleanup complete")

    async def stop_generation(self, request_id: str, *, chat_id: Optional[str] = None) -> None:
        logger.info("Stop request received for request %s (chat_id provided: %s)", request_id, chat_id)
        if not self._session_manager:
            logger.debug("Session manager unavailable; cannot cancel request %s", request_id)
            return

        # ---------------------------------------------------------------
        # Step 1: Resolve chat_id SYNCHRONOUSLY before any await.
        #
        # Race condition context:
        #   control_handler calls task_manager.cancel_task() which fires
        #   asyncio.Task.cancel() on the streaming task.  At the next await
        #   (which may happen inside cancel_request below), the streaming
        #   task's CancelledError can fire, running its finally block which
        #   calls request_tracker.end_request() — removing the entry.
        #   We MUST capture chat_id before that can happen.
        # ---------------------------------------------------------------
        if not chat_id:
            try:
                tracker = getattr(self._session_manager, "request_tracker", None)
                if tracker and hasattr(tracker, "get_request_info"):
                    info = tracker.get_request_info(request_id)
                    if isinstance(info, dict):
                        chat_id = info.get("chat_id")
            except (AttributeError, KeyError, TypeError):
                pass

        # ---------------------------------------------------------------
        # Step 2: Set the cancelled flag in the RequestTracker.
        #
        # Best-effort: if the streaming task already ended (race), this
        # returns False.  That is fine — we still proceed to kill the
        # interpreter process below if requested.  The cancelled flag is 
        # the soft signal; the process kill (Step 3) is the hard guarantee.
        # ---------------------------------------------------------------
        cancelled = await self._session_manager.cancel_request(request_id)
        if cancelled:
            logger.info("Marked request %s as cancelled in tracker", request_id)
        else:
            logger.info(
                "Request %s not in active tracker (may have ended via race); "
                "proceeding to interpreter stop anyway",
                request_id,
            )

        # ---------------------------------------------------------------
        # Step 3: ALWAYS stop the interpreter process.
        #
        # DO NOT gate this on `cancelled`.  The streaming task may have
        # already cleared the tracker entry, but the external OI server
        # process can still be running.  Interpreter adapter performs:
        #   Layer 1: WebSocket stop signal (best-effort)
        #   Layer 2: Hard-kill the OI server process (guaranteed)
        # ---------------------------------------------------------------
        if self._interpreter_adapter:
            await self._interpreter_adapter.stop_generation(request_id, chat_id=chat_id)

        if self._config_manager:
            await self._config_manager.reset_client()

    async def reset_context(self, client_id: str, chat_id: Optional[str] = None) -> None:
        logger.info("🔄 Context reset for client %s", client_id)
        try:
            if self._interpreter_adapter:
                await self._interpreter_adapter.reset_state(client_id, chat_id=chat_id)
            if self._session_manager:
                await self._session_manager.reset_context(client_id, chat_id=chat_id)
            if self._config_manager:
                await self._config_manager.reset_client()
                logger.info("✅ Reset HTTP client for client %s", client_id)
            logger.info("✅ Context reset complete for client %s - clean slate established", client_id)
        except Exception as exc:  # noqa: BLE001 -- context reset boundary: must not crash on reset failure
            logger.error("Error resetting context for client %s: %s", client_id, exc, exc_info=True)

    async def handle_file_chat(
        self,
        file_data: Dict[str, Any],
        prompt: str = "",
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not self._media_service or not self._interpreter_adapter:
            raise RuntimeError("Runtime media service not initialized")
        chat_id = file_data.get("chat_id") or file_data.get("session_id")
        interpreter = await self._interpreter_adapter.get_interpreter(chat_id=chat_id)
        return await self._media_service.process_file_chat(
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
        if not self._media_service or not self._interpreter_adapter:
            raise RuntimeError("Runtime media service not initialized")
        chat_id = file_data.get("chat_id") or file_data.get("session_id")
        interpreter = await self._interpreter_adapter.get_interpreter(chat_id=chat_id)
        return await self._media_service.process_file_chat_multipart(
            file_data=file_data,
            prompt=prompt,
            request_id=request_id,
            interpreter=interpreter,
        )

    async def start_audio_stream(self, client_id: str) -> None:
        if not self._session_manager:
            logger.debug("Session manager unavailable; cannot start audio stream")
            return
        await self._session_manager.start_audio_stream(client_id)

    async def end_audio_stream(self, client_id: str) -> None:
        if not self._session_manager:
            return
        await self._session_manager.end_audio_stream(client_id)

    async def handle_audio_chunk(self, client_id: str, chunk: bytes) -> None:
        if not self._session_manager:
            return
        await self._session_manager.handle_audio_chunk(client_id, chunk)

    async def stream_chat(
        self,
        *,
        client_id: str,
        text: str,
        image_b64: Optional[str],
        request_id: str,
        chat_id: Optional[str] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        if not self._startup_complete:
            logger.warning("Waiting for runtime startup to complete...")
            for _ in range(30):
                if self._startup_complete:
                    break
                await asyncio.sleep(1)
            else:
                logger.error("Startup did not complete in time!")
                return
        if not self._session_manager or not self._interpreter_adapter:
            logger.error("Runtime session or interpreter adapter missing; cannot stream chat")
            return
        interpreter = await self._interpreter_adapter.get_interpreter(chat_id=chat_id)
        async for chunk in self._session_manager.stream_chat(
            client_id=client_id,
            text=text,
            image_b64=image_b64,
            request_id=request_id,
            interpreter=interpreter,
            settings=self.settings,
            chat_id=chat_id,
        ):
            yield chunk

    def get_health_status(self) -> Dict[str, Any]:
        session_health = self._session_manager.get_health_status() if self._session_manager else {"available": False}
        active_requests = self._session_manager.get_request_count() if self._session_manager else 0
        active_audio_sessions = (
            session_health.get("audio_sessions", 0) if isinstance(session_health, dict) else 0
        )
        modules = {
            "config_manager": {"available": self._config_manager is not None},
            "session_manager": session_health,
            "interpreter_adapter": (
                self._interpreter_adapter.get_health_status() if self._interpreter_adapter else {"available": False}
            ),
            "media_service": (
                self._media_service.get_health_status() if self._media_service else {"available": False}
            ),
        }
        return {
            "runtime": {
                "initialized": self._initialized,
                "startup_complete": self._startup_complete,
                "module_count": sum(
                    1
                    for module in [
                        self._config_manager,
                        self._session_manager,
                        self._interpreter_adapter,
                        self._media_service,
                    ]
                    if module is not None
                ),
            },
            "modules": modules,
            "active_requests": active_requests,
            "active_audio_sessions": active_audio_sessions,
        }

    def is_ready(self) -> bool:
        """
        Check if the coordinator is ready to handle requests.
        Requires at least config and session managers to be functional.
        """
        return bool(
            self._startup_complete
            and self._config_manager
            and self._session_manager
        )

    async def cleanup_stale_resources(self) -> int:
        if not self._session_manager:
            return 0
        return await self._session_manager.cleanup_stale_resources()

    async def get_history(self, session_id: str) -> list:
        if not self._session_manager:
            return []
        return self._session_manager.get_history(session_id)

    def _track_task(self, task: asyncio.Task) -> None:
        """Track a background task so exceptions are logged and cleanup is possible."""
        self._background_tasks.add(task)

        def _on_done(done_task: asyncio.Task) -> None:
            self._background_tasks.discard(done_task)
            if done_task.cancelled():
                return
            exc = done_task.exception()
            if exc:
                logger.error("Background task failed: %s", exc, exc_info=exc)

        task.add_done_callback(_on_done)

    def set_history(self, session_id: str, messages: list) -> None:
        if not self._session_manager:
            return
        normalized_history = self._session_manager.set_history(session_id, messages)
        if normalized_history and self._interpreter_adapter:
            self._track_task(
                asyncio.create_task(self._interpreter_adapter.apply_history(normalized_history, chat_id=session_id))
            )

    def inject_system_context(self, session_id: str, context: str) -> None:
        """
        Append system-level context to the active interpreter for this chat/session.

        NOTE: This is intentionally sync (called from WS handlers). We schedule the async work
        to avoid blocking the event loop during context reset.
        """
        sid = (session_id or "").strip()
        if not sid:
            return
        text = str(context or "")
        if not text.strip():
            return
        if not self._interpreter_adapter:
            return
        self._track_task(
            asyncio.create_task(
                self._interpreter_adapter.append_custom_instructions(
                    text,
                    chat_id=sid,
                )
            )
        )

    def get_history_limit(self) -> int:
        if not self._session_manager:
            return 0
        return self._session_manager.get_history_limit()

    @property
    def config_manager(self):
        return self._config_manager

    @property
    def session_manager(self):
        return self._session_manager

    @property
    def interpreter_adapter(self):
        return self._interpreter_adapter

    @property
    def media_service(self):
        return self._media_service


