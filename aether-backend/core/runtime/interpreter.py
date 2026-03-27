"""
Interpreter Manager — External OI Server Mode Only (AGPL Isolation)

Manages per-chat Open Interpreter server lifecycle via external process spawning.
OI is AGPL-licensed and runs exclusively as an external process to respect the license boundary.
No in-process OI code is loaded or executed by this module.

@.architecture
Incoming: core/runtime/engine.py, config/settings.py --- {Settings, session_id, chat_id}
Processing: get_interpreter(), apply_settings_async(), configure_external_server() --- {3 jobs: JOB_INITIALIZE_COMPONENT, JOB_MANAGE_SESSIONS, JOB_LOAD_CONFIG}
Outgoing: core/runtime/streaming.py, core/runtime/engine.py --- {ExternalOIWebSocketInterpreter proxy, Dict[str, Any]}
"""

import asyncio
import inspect
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


from core.integrations.providers.open_interpreter.external_server_pool import (
    ExternalOIServerPool,
)
from core.integrations.providers.open_interpreter.external_ws_proxy import (
    ExternalOIWebSocketInterpreter,
)
from core.profiles.manager import ProfileManager

logger = logging.getLogger(__name__)


class InterpreterManager:
    """
    Manages per-chat external Open Interpreter server lifecycle (AGPL isolation).

    OI runs exclusively as an external process (spawned by oi_server_wrapper.py).
    Each chat gets its own OI server instance with isolated state.
    Communication is via WebSocket proxy (ExternalOIWebSocketInterpreter).

    No in-process OI code is loaded. No ``OpenInterpreterClient`` is used.
    """

    def __init__(self):
        """Initialize interpreter manager for external-only OI mode."""
        self._profile_manager = ProfileManager()
        self._chat_interpreters: Dict[str, Any] = {}  # chat_id -> ExternalOIWebSocketInterpreter proxy
        self._chat_last_used: Dict[str, float] = {}  # chat_id -> timestamp
        # Prevent duplicate per-chat interpreter creation under concurrent access
        # (WS context_reset schedules multiple tasks).
        self._chat_create_lock = asyncio.Lock()

        # External Open Interpreter server config (populated by configure_external_server).
        self._external_server_enabled: bool = False
        self._external_server_http_url: Optional[str] = None
        self._external_server_auth: Optional[str] = None
        self._external_server_per_chat: bool = False
        self._external_server_host: Optional[str] = None
        self._external_server_port_min: int = 0
        self._external_server_port_max: int = 0
        self._external_server_max_servers: int = 0
        self._external_server_ttl_seconds: int = 0
        self._external_server_startup_timeout_seconds: float = 0.0
        self._external_server_venv_python: Optional[str] = None
        self._external_server_wrapper_script: Optional[str] = None
        self._external_server_pool: Optional[ExternalOIServerPool] = None

        # Cached enriched system message (loaded from GURU profile during init)
        self._enriched_system_message: Optional[str] = None

        # Cached settings for per-chat server spawns (populated by apply_settings_async)
        self._last_settings: Optional[Any] = None

        # Resource limits
        self._max_chat_instances = 10  # Max concurrent OI instances
        self._chat_ttl_seconds = 1800  # 30 min idle timeout

        # Token-based context limits (loaded from settings during apply_settings)
        self._context_token_limit = 100000  # Default fallback, overridden by settings.llm.context_window
        self._context_thresholds = {
            "warning": 0.80,
            "high": 0.90,
            "critical": 0.95,
        }

        # Lifecycle management
        self._is_running = False
        self._cleanup_task: Optional[asyncio.Task] = None

    async def initialize(self) -> bool:
        """
        Initialize interpreter manager.  In external-only mode this just starts
        the background cleanup loop — no OI vendor code is imported.

        Returns:
            True (always succeeds in external mode)
        """
        if not self._is_running:
            self._is_running = True
        if not self._cleanup_task:
            self._cleanup_task = asyncio.create_task(self._periodic_cleanup_loop())
            logger.debug("Started periodic cleanup loop for interpreter manager")
        return True

    async def create_interpreter(self) -> Optional[Any]:
        """
        Return a per-chat external template placeholder.

        Real traffic goes through ``get_interpreter(chat_id=...)``, which spawns
        a dedicated OI server per chat.  This method satisfies the
        ``RuntimeInterpreterAdapter.configure()`` bootstrap contract.
        """
        if not self._external_server_per_chat:
            raise RuntimeError("External Open Interpreter must run in per-chat isolation mode")

        class _PerChatExternalTemplate:
            """Placeholder — real proxies are created in get_interpreter(chat_id=...)."""
            ws_url = "per-chat"

            async def input(self, payload: Dict[str, Any]) -> None:
                raise RuntimeError("Per-chat external OI template cannot be used directly; provide chat_id")

            async def output(self) -> Dict[str, Any]:
                raise RuntimeError("Per-chat external OI template cannot be used directly; provide chat_id")

            async def stop(self, **kwargs: Any) -> None:
                return

            async def close(self) -> None:
                return

        logger.info("Created per-chat external Open Interpreter template (no shared server)")
        return _PerChatExternalTemplate()

    @property
    def initialized(self) -> bool:
        """Always True in external-only mode (no in-process OI to initialise)."""
        return True

    def has_cached_interpreter(self) -> bool:
        """Whether at least one chat interpreter is active."""
        return len(self._chat_interpreters) > 0

    async def ensure_initialized(self) -> None:
        """No-op in external-only mode."""
        return

    def configure_external_server(self, interpreter_settings: Any) -> None:
        """
        Configure external Open Interpreter server mode from central settings.

        Expected settings fields (see config/settings.py):
        - interpreter.external_server_enabled: bool
        - interpreter.external_server_url: Optional[str] (http://127.0.0.1:8000)
        - interpreter.external_server_per_chat: bool (spawn per-chat OI server process for true isolation)
        """
        enabled = bool(getattr(interpreter_settings, "external_server_enabled", False))
        url = getattr(interpreter_settings, "external_server_url", None)
        url = url.strip() if isinstance(url, str) else None
        auth = getattr(interpreter_settings, "external_server_auth", None)
        auth = auth.strip() if isinstance(auth, str) else None
        per_chat = bool(getattr(interpreter_settings, "external_server_per_chat", False))
        host_override = getattr(interpreter_settings, "external_server_host", None)
        host_override = host_override.strip() if isinstance(host_override, str) else None
        port_min = getattr(interpreter_settings, "external_server_port_min", 0)
        port_max = getattr(interpreter_settings, "external_server_port_max", 0)
        max_servers = getattr(interpreter_settings, "external_server_max_servers", 0)
        ttl_seconds = getattr(interpreter_settings, "external_server_ttl_seconds", 0)
        startup_timeout = getattr(interpreter_settings, "external_server_startup_timeout_seconds", 0.0)
        venv_python = getattr(interpreter_settings, "external_server_venv_python", None)
        venv_python = venv_python.strip() if isinstance(venv_python, str) else None
        wrapper_script = getattr(interpreter_settings, "external_server_wrapper_script", None)
        wrapper_script = wrapper_script.strip() if isinstance(wrapper_script, str) else None

        # External Open Interpreter server mode (OI runs as its own process/service).
        # When enabled, interpreter objects are proxies backed by WebSocket connections.
        self._external_server_enabled = enabled
        self._external_server_http_url = url
        self._external_server_auth = auth
        self._external_server_per_chat = per_chat
        self._external_server_host = host_override
        self._external_server_port_min = int(port_min or 0)
        self._external_server_port_max = int(port_max or 0)
        self._external_server_max_servers = int(max_servers or 0)
        self._external_server_ttl_seconds = int(ttl_seconds or 0)
        try:
            self._external_server_startup_timeout_seconds = float(startup_timeout or 0.0)
        except (ValueError, TypeError):
            self._external_server_startup_timeout_seconds = 0.0
        self._external_server_venv_python = venv_python
        self._external_server_wrapper_script = wrapper_script
        # Pool is created lazily once we have full Settings (need Settings.base_url for --backend-url).
        self._external_server_pool = None

        if not enabled:
            return

        if not url:
            raise RuntimeError("external_server_enabled=true but interpreter.external_server_url is empty")

        # Isolation mode check removed - allowing shared external server for mesh support.
        # if enabled and not per_chat:
        #     raise RuntimeError(...)

        if not (url.startswith("http://") or url.startswith("https://")):
            raise RuntimeError(
                f"external_server_url must start with http(s):// (got {url!r})"
            )

        if per_chat:
            # Validate per-chat requirements early (fail-fast).
            if self._external_server_port_min <= 0 or self._external_server_port_max <= 0:
                raise RuntimeError("external_server_per_chat=true but port range is not configured")
            if self._external_server_port_min > self._external_server_port_max:
                raise RuntimeError(
                    f"Invalid per-chat OI port range: {self._external_server_port_min}-{self._external_server_port_max}"
                )
            if self._external_server_max_servers <= 0:
                raise RuntimeError("external_server_per_chat=true but external_server_max_servers must be >= 1")
            if self._external_server_ttl_seconds <= 0:
                raise RuntimeError("external_server_per_chat=true but external_server_ttl_seconds must be >= 1")
            if not self._external_server_wrapper_script or not Path(self._external_server_wrapper_script).exists():
                raise RuntimeError(
                    f"external_server_wrapper_script is missing or invalid: {self._external_server_wrapper_script!r}"
                )
            if not self._external_server_venv_python or not Path(self._external_server_venv_python).exists():
                raise RuntimeError(
                    f"external_server_venv_python is missing or invalid: {self._external_server_venv_python!r}"
                )
            logger.info(
                "External Open Interpreter per-chat server mode enabled (url=%s port_range=%s-%s max=%s ttl=%ss)",
                url,
                self._external_server_port_min,
                self._external_server_port_max,
                self._external_server_max_servers,
                self._external_server_ttl_seconds,
            )
            return

    def _ensure_external_server_pool(self, settings: Any) -> ExternalOIServerPool:
        if self._external_server_pool:
            return self._external_server_pool
        if not self._external_server_enabled or not self._external_server_per_chat:
            raise RuntimeError("External server pool requested but per-chat external mode is not enabled")
        if not self._external_server_http_url:
            raise RuntimeError("external_server_url is required for per-chat server pool")
        backend_url = ""
        try:
            backend_url = str(getattr(settings, "base_url", "")).strip()
        except (AttributeError, TypeError):
            backend_url = ""
        if not backend_url:
            raise RuntimeError("settings.base_url is required to spawn per-chat OI servers")

        from config.settings import get_app_root
        backend_root = get_app_root()
        logs_dir = str((backend_root / "logs").resolve())

        pool = ExternalOIServerPool(
            base_external_url=self._external_server_http_url,
            host_override=self._external_server_host,
            port_min=self._external_server_port_min,
            port_max=self._external_server_port_max,
            max_servers=self._external_server_max_servers,
            ttl_seconds=self._external_server_ttl_seconds,
            startup_timeout_seconds=self._external_server_startup_timeout_seconds or 30.0,
            venv_python=self._external_server_venv_python or "",
            wrapper_script=self._external_server_wrapper_script or "",
            backend_url=backend_url,
            auth_token=self._external_server_auth,
            logs_dir=logs_dir,
        )
        self._external_server_pool = pool
        return pool

    def get_cached_interpreter(self, chat_id: Optional[str] = None) -> Optional[Any]:
        """
        Return the cached interpreter proxy for *chat_id* without spawning.

        Unlike ``get_interpreter()``, this never creates a new OI server
        process.  Returns ``None`` on cache miss.  Intended for read-only
        callers (context viewer, status endpoints) that must never trigger
        side-effects.
        """
        if not chat_id:
            return None
        existing = self._chat_interpreters.get(chat_id)
        if existing is not None:
            self._chat_last_used[chat_id] = time.time()
        return existing

    async def get_interpreter(self, chat_id: Optional[str] = None) -> Optional[Any]:
        """
        Get or create interpreter instance scoped to chat_id.
        
        Args:
            chat_id: Chat identifier for conversation isolation
            
        Returns:
            Chat-scoped interpreter instance or None
        """
        await self.ensure_initialized()
        
        logger.debug("get_interpreter called with chat_id=%s...", chat_id[:16] if chat_id else None)

        if not chat_id:
            raise RuntimeError("chat_id is required in external per-chat interpreter mode")

        # Cleanup stale instances before creating new ones
        await self._cleanup_stale_instances()

        # Fast-path: return existing chat-scoped interpreter
        existing = self._chat_interpreters.get(chat_id)
        if existing is not None:
            logger.debug("Returning existing interpreter for chat: %s", chat_id[:8])
            self._chat_last_used[chat_id] = time.time()
            return existing

        # Slow-path: serialize creation to avoid spawning multiple per-chat OI servers for the same chat_id.
        async with self._chat_create_lock:
            # Re-check under lock (another coroutine may have created it while we awaited the lock).
            existing2 = self._chat_interpreters.get(chat_id)
            if existing2 is not None:
                logger.debug("Returning existing interpreter for chat (post-lock): %s", chat_id[:8])
                self._chat_last_used[chat_id] = time.time()
                return existing2

            # Enforce max instances limit
            if len(self._chat_interpreters) >= self._max_chat_instances:
                logger.warning("Max chat instances (%s) reached, evicting LRU", self._max_chat_instances)
                await self._evict_lru_instance()

            try:
                logger.info("Creating chat-scoped interpreter: %s", chat_id[:8])

                if self._external_server_per_chat:
                    if not hasattr(self, "_last_settings") or not self._last_settings:
                        from config.settings import get_settings as _get_settings
                        self._last_settings = _get_settings()
                    pool = self._ensure_external_server_pool(self._last_settings)
                    rec, started_new = await pool.ensure_server(chat_id)
                    # The wrapper script (oi_server_wrapper.py) applies settings + tools
                    # during its initialization phase.  The pool's _wait_healthy() blocks
                    # until the wrapper writes a readiness sentinel, so the server is fully
                    # configured by the time we reach this point.
                    await pool.touch(chat_id)
                    ws_url = rec.ws_url
                    http_url = rec.http_url
                else:
                    # Shared external server mode (single external OI server)
                    ws_url = self._external_server_http_url.replace("http://", "ws://").replace("https://", "wss://")
                    if not ws_url.endswith("/"):
                        ws_url += "/"
                    http_url = self._external_server_http_url

                chat_interpreter = ExternalOIWebSocketInterpreter(
                    ws_url,
                    http_url=http_url,
                    auth_token=self._external_server_auth,
                )

                self._chat_interpreters[chat_id] = chat_interpreter
                self._chat_last_used[chat_id] = time.time()
                logger.info("Chat interpreter created: %s, total=%s", chat_id[:8], len(self._chat_interpreters))
                return chat_interpreter

            except Exception as e:  # noqa: BLE001 -- last-resort defensive boundary for interpreter creation
                logger.error("Failed to create chat interpreter: %s", e, exc_info=True)
                # FAIL-FAST: never fall back to a shared singleton (reintroduces leakage).
                return None

    async def load_profile(self, profile_name: str) -> None:
        """No-op in external mode — profiles are applied by oi_server_wrapper.py per-chat."""
        logger.debug("load_profile(%s) is a no-op in external-only OI mode", profile_name)

    def refresh_integration_template_attrs(self) -> int:
        """No-op in external mode — integrations are injected per-chat by wrapper."""
        return 0

    async def reset_interpreter(self, chat_id: Optional[str] = None) -> None:
        """
        Reset interpreter for a specific chat (destroys the OI server + proxy).

        Args:
            chat_id: Chat to reset.  None resets all chats.
        """
        if chat_id and chat_id in self._chat_interpreters:
            await self._cleanup_chat_instance(chat_id)
            logger.info("Reset chat interpreter: %s", chat_id[:8])
        elif not chat_id:
            for cid in list(self._chat_interpreters.keys()):
                await self._cleanup_chat_instance(cid)
            logger.info("Reset all chat interpreters")

    async def _cleanup_chat_instance(self, chat_id: str) -> None:
        """Safely cleanup a single chat interpreter instance."""
        if chat_id not in self._chat_interpreters:
            return
        
        try:
            interpreter = self._chat_interpreters.pop(chat_id)
            self._chat_last_used.pop(chat_id, None)

            # Per-chat external OI server: stop the backing process first to guarantee isolation teardown.
            if self._external_server_enabled and self._external_server_per_chat and self._external_server_pool:
                try:
                    await self._external_server_pool.stop_server(chat_id)
                except Exception as exc:  # noqa: BLE001 -- cleanup: must not raise during session teardown
                    logger.debug("Failed to stop external server for %s: %s", chat_id[:8], exc)

            # External OI proxy sessions should close their socket.
            if hasattr(interpreter, "close") and asyncio.iscoroutinefunction(getattr(interpreter, "close")):
                try:
                    await interpreter.close()
                except Exception as exc:  # noqa: BLE001 -- cleanup: must not raise during session teardown
                    logger.debug("Failed to close interpreter for %s: %s", chat_id[:8], exc)
            
            # Stop any active generation
            if hasattr(interpreter, 'stop_event'):
                interpreter.stop_event.set()
            
            # Wait briefly for threads to stop
            await asyncio.sleep(0.1)
            
            # Cleanup output queue safely
            if hasattr(interpreter, 'output_queue') and interpreter.output_queue is not None:
                try:
                    # Close queue if possible
                    if hasattr(interpreter.output_queue, 'close'):
                        await interpreter.output_queue.close()
                except Exception as e:  # noqa: BLE001 -- cleanup: must not raise during session teardown
                    logger.debug("Error closing output queue: %s", e)
                finally:
                    interpreter.output_queue = None
            
            # Reset if available
            if hasattr(interpreter, 'reset'):
                try:
                    await _maybe_await(interpreter.reset())
                except Exception as e:  # noqa: BLE001 -- cleanup: must not raise during session teardown
                    logger.debug("Error resetting interpreter: %s", e)
            
            logger.debug("Cleaned up chat instance: %s", chat_id[:8])
            
        except Exception as e:  # noqa: BLE001 -- outer defensive boundary for cleanup
            logger.error("Error during chat cleanup %s: %s", chat_id[:8], e, exc_info=True)

    async def _cleanup_stale_instances(self) -> None:
        """Remove chat instances that haven't been used recently."""
        now = time.time()
        stale_chats = [
            chat_id
            for chat_id, last_used in self._chat_last_used.items()
            if (now - last_used) > self._chat_ttl_seconds
        ]
        
        for chat_id in stale_chats:
            logger.info("Evicting stale chat instance: %s (idle %ss)", chat_id[:8], int(now - self._chat_last_used[chat_id]))
            await self._cleanup_chat_instance(chat_id)
        
        # LIFECYCLE FIX: Also clean up stale OI servers from the pool
        # The pool has its own TTL, but cleanup only runs when ensure_server() is called.
        # Trigger it here to ensure orphaned servers are properly terminated.
        if self._external_server_enabled and self._external_server_per_chat and self._external_server_pool:
            try:
                async with self._external_server_pool._lock:
                    await self._external_server_pool._cleanup_stale_locked()
            except Exception as cleanup_err:  # noqa: BLE001 -- pool cleanup: non-critical, don't crash
                logger.warning("Failed to cleanup stale OI servers from pool: %s", cleanup_err)

    async def _evict_lru_instance(self) -> None:
        """Evict least recently used chat instance."""
        if not self._chat_last_used:
            return
        
        # Find oldest
        lru_chat_id = min(self._chat_last_used.items(), key=lambda x: x[1])[0]
        logger.info("Evicting LRU chat instance: %s", lru_chat_id[:8])
        await self._cleanup_chat_instance(lru_chat_id)

    def current_interpreter(self) -> Optional[Any]:
        """Return None — no global in-process interpreter exists in external mode."""
        return None

    async def apply_settings_async(self, settings: Any, init: bool = False) -> None:
        """
        Apply runtime settings.  In external mode this:
        1. Caches settings for future per-chat server spawns.
        2. Loads the GURU system message for the context viewer.
        3. Pushes settings to any already-running per-chat OI servers.

        Args:
            settings: Runtime settings object
            init: Whether this is initial setup
        """
        self._last_settings = settings  # Cache for chat-scoped instances

        # Context management config from settings
        if hasattr(settings, 'llm'):
            raw_limit = getattr(settings.llm, 'context_window', 100000) or 100000
            self._context_token_limit = max(int(raw_limit), 1)  # Guard against ZeroDivisionError
            logger.info("Context limit from LLM settings: %s tokens", self._context_token_limit)

        if hasattr(settings, 'interpreter'):
            interp_settings = settings.interpreter
            self._context_thresholds = {
                "warning": getattr(interp_settings, 'context_warning_threshold', 0.80),
                "high": getattr(interp_settings, 'context_high_threshold', 0.90),
                "critical": getattr(interp_settings, 'context_critical_threshold', 0.95),
            }
            logger.info("Context thresholds: %s", self._context_thresholds)

        # Cache enriched system message for the context viewer (no OI import needed)
        if init and not self._enriched_system_message:
            self._populate_system_message_cache()

        # Push settings to any already-running per-chat OI servers
        if self._external_server_per_chat:
            pool = self._ensure_external_server_pool(settings)
            applied = 0
            for rec in pool.list_servers():
                try:
                    await self._apply_settings_to_external_server(settings, base_http_url=rec.http_url)
                    applied += 1
                except Exception as exc:  # noqa: BLE001 -- settings apply: non-critical, continue with other servers
                    logger.error(
                        "Failed to apply settings to per-chat OI server %s:%s: %s",
                        rec.host, rec.port, exc,
                    )
            logger.info("External OI per-chat settings applied (servers=%s)", applied)
        elif self._external_server_http_url:
            # Shared external server mode
            await self._apply_settings_to_external_server(settings)
            logger.info("External OI shared-server settings applied")

    def _populate_system_message_cache(self) -> None:
        """Load the GURU profile system message into memory for the context viewer."""
        try:
            profile_name = "GURU"
            profile_path = self._profile_manager.get_profile_path(profile_name)

            if not profile_path or not profile_path.exists():
                logger.error("Profile file not found: %s", profile_name)
                return

            profile_content = profile_path.read_text(encoding='utf-8')

            if profile_path.suffix.lower() in ['.yaml', '.yml']:
                import yaml
                profile_data = yaml.safe_load(profile_content)
                if profile_data and 'system_message' in profile_data:
                    self._enriched_system_message = profile_data['system_message']
                    logger.info("Cached system message from YAML profile (%s chars)", len(self._enriched_system_message))
                else:
                    logger.error("YAML profile loaded but system_message key not found")
            elif profile_path.suffix.lower() == '.py':
                profile_globals: Dict[str, Any] = {}
                exec(profile_content, profile_globals)  # noqa: S102
                if 'system_message' in profile_globals:
                    self._enriched_system_message = profile_globals['system_message']
                    logger.info("Cached system message from Python profile (%s chars)", len(self._enriched_system_message))
                else:
                    logger.error("Python profile loaded but system_message variable not found")
            else:
                logger.error("Unsupported profile format: %s", profile_path.suffix)

        except Exception as cache_error:  # noqa: BLE001 -- cache population: non-critical, don't crash startup
            logger.error("Failed to populate system message cache: %s", cache_error, exc_info=True)

    async def _apply_settings_to_external_server(self, settings: Any, *, base_http_url: Optional[str] = None) -> None:
        """
        Apply runtime settings to an external Open Interpreter server via HTTP.

        Docs reference: external-vendors/open-interpreter/docs/server/usage.mdx
        Endpoint: POST {server_url}/settings
        """
        base_http = (base_http_url or self._external_server_http_url or "").strip()
        if not base_http:
            raise RuntimeError("External OI server enabled but interpreter.external_server_url is missing")

        # Normalize model naming similar to _apply_llm_settings().
        model = getattr(settings.llm, "model", "")
        provider = getattr(settings.llm, "provider", "")
        api_base = getattr(settings.llm, "api_base", "")
        api_key = getattr(settings.llm, "api_key", "")

        # Route to aether-inference when it is the main provider
        if provider.strip().lower() == "aether_inference":
            api_base = getattr(settings, "inference_url", api_base)
            api_key = "not-needed"

        # Litellm requires "openai/" prefix for openai-compatible endpoints  
        # This tells litellm to use OpenAI client with custom api_base
        # LM Studio, Ollama, aether-inference, and other OpenAI-compatible providers all need this prefix
        if isinstance(model, str) and model and not model.startswith("openai/"):
            model = f"openai/{model}"

        # FORCED: auto_run must be True in external server mode.
        # External OI servers have no user-facing confirmation UI.
        # Code execution safety is handled at Aether's trail layer, not OI's.
        config_auto_run = bool(getattr(settings.interpreter, "auto_run", True))
        if not config_auto_run:
            logger.warning(
                "auto_run=False in config, but external server mode requires auto_run=True "
                "(no OI-level confirmation protocol exists). Forcing auto_run=True."
            )

        base_system_message = getattr(settings.interpreter, "system_message", "") or ""
        
        # Inject user profile personalization
        user_profile = getattr(settings, "user_profile", None)
        if user_profile and (getattr(user_profile, "name", "") or getattr(user_profile, "username", "")):
            profile_lines = []
            if getattr(user_profile, "name", ""):
                profile_lines.append(f"Name: {user_profile.name}")
            if getattr(user_profile, "username", ""):
                profile_lines.append(f"Username: {user_profile.username}")
                
            personalization = "\n## User Profile\n" + "\n".join(profile_lines) + "\n"
            base_system_message = base_system_message + personalization

        payload: Dict[str, Any] = {
            "auto_run": True,  # Always True for external server mode
            "loop": bool(getattr(settings.interpreter, "loop", False)),
            "offline": bool(getattr(settings.interpreter, "offline", True)),
            "disable_telemetry": bool(getattr(settings.interpreter, "disable_telemetry", True)),
            "safe_mode": getattr(settings.interpreter, "safe_mode", "off"),
            # CRITICAL: Use system_message, NOT custom_instructions  
            # OI's respond.py uses system_message as base, custom_instructions is appended
            # Setting custom_instructions alone doesn't override the default system_message
            "system_message": base_system_message,
            "custom_instructions": "",  # Clear to avoid double-append
            "llm": {
                "model": model,
                "api_base": api_base,
                "api_key": api_key,
                "context_window": int(getattr(settings.llm, "context_window", 0) or 0),
                "max_tokens": int(getattr(settings.llm, "max_tokens", 0) or 0),
                "supports_vision": bool(getattr(settings.llm, "supports_vision", False)),
            },
        }
        
        system_msg_len = len(payload.get("system_message", ""))
        logger.info("Sending system_message to OI: %s chars, contains_GURU=%s", system_msg_len, 'GURU' in payload.get('system_message', ''))

        import httpx

        base = base_http.rstrip("/")
        url = f"{base}/settings"
        timeout = 10.0
        try:
            timeout = float(getattr(getattr(settings, "http_client", None), "external_service_timeout", 10.0))
        except (ValueError, TypeError, AttributeError):
            timeout = 10.0

        logger.info(
            "Applying external OI settings: oi=%s model=%s provider=%s timeout=%ss",
            base,
            model,
            provider,
            timeout,
        )

        async with httpx.AsyncClient(timeout=timeout) as client:
            headers: Dict[str, str] = {}
            # External OI server HTTP middleware authenticates using X-API-KEY (same token as WS auth).
            if self._external_server_auth:
                headers["X-API-KEY"] = self._external_server_auth
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                raise RuntimeError(f"External OI server rejected settings ({resp.status_code}): {resp.text}")
    
    def add_web_search_capability(self) -> None:
        """No-op in external mode — web search is injected per-chat by wrapper."""
        logger.debug("add_web_search_capability() is a no-op in external-only OI mode")

    def cached_interpreter(self) -> Optional[Any]:
        """Return None — no global in-process interpreter exists in external mode."""
        return None

    def is_available(self) -> bool:
        """Check if external OI mode is configured."""
        return self._external_server_enabled

    def is_initialized(self) -> bool:
        """Check if interpreter manager is initialized (always True in external mode)."""
        return self._external_server_enabled

    async def _periodic_cleanup_loop(self) -> None:
        """Background task for proactive resource cleanup (instances and pool)."""
        while self._is_running:
            try:
                # Proactive cleanup every 60 seconds
                await asyncio.sleep(60)
                if not self._is_running:
                    break
                await self._cleanup_stale_instances()
            except asyncio.CancelledError:
                break
            except Exception as e:  # noqa: BLE001 -- defensive loop boundary, must not crash
                logger.error("Error in periodic cleanup loop: %s", e, exc_info=True)

    async def cleanup(self) -> None:
        """Cleanup all interpreter resources (chat proxies, OI servers, pool)."""
        self._is_running = False
        
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
            logger.debug("Stopped periodic cleanup loop")

        for chat_id in list(self._chat_interpreters.keys()):
            await self._cleanup_chat_instance(chat_id)

        if self._external_server_pool:
            try:
                await self._external_server_pool.stop_all()
            except Exception as exc:  # noqa: BLE001 -- cleanup boundary: must not raise during shutdown
                logger.debug("Failed to stop all external servers: %s", exc)
            self._external_server_pool = None

        self._chat_interpreters.clear()

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    async def get_context_status(self, chat_id: str) -> Dict[str, Any]:
        """
        Get conversation context status for chat based on token usage.
        
        Args:
            chat_id: Chat identifier
            
        Returns:
            Dict with token count, threshold status, recommendation
        """
        if chat_id not in self._chat_interpreters:
            return {
                "chat_id": chat_id,
                "message_count": 0,
                "token_count": 0,
                "token_limit": self._context_token_limit,
                "usage_percent": 0.0,
                "status": "new",
                "needs_summarization": False,
                "recommend_new_chat": False,
                "thresholds": {
                    "warning": int(self._context_token_limit * self._context_thresholds["warning"]),
                    "high": int(self._context_token_limit * self._context_thresholds["high"]),
                    "critical": int(self._context_token_limit * self._context_thresholds["critical"]),
                },
            }
        
        interp = self._chat_interpreters[chat_id]
        
        # External OI mode: fetch messages via HTTP proxy if needed
        messages = []
        if hasattr(interp, "get_messages") and inspect.iscoroutinefunction(interp.get_messages):
            try:
                messages = await interp.get_messages()
            except Exception as exc:
                logger.warning("Failed to fetch messages from external OI for status: %s", exc)
                messages = []
        elif hasattr(interp, "messages"):
            messages = interp.messages
        
        message_count = len(messages)
        
        # Estimate tokens: rough estimate ~4 chars per token
        token_count = 0
        for msg in messages:
            if isinstance(msg, dict) and 'content' in msg:
                content = str(msg['content'])
                token_count += len(content) // 4  # Rough estimate
        
        usage_percent = token_count / self._context_token_limit
        thresholds = self._context_thresholds
        
        # Determine status based on token usage percentage
        if usage_percent >= thresholds["critical"]:
            status = "critical"
        elif usage_percent >= thresholds["high"]:
            status = "high"
        elif usage_percent >= thresholds["warning"]:
            status = "warning"
        else:
            status = "normal"
        
        return {
            "chat_id": chat_id,
            "message_count": message_count,
            "token_count": token_count,
            "token_limit": self._context_token_limit,
            "usage_percent": round(usage_percent * 100, 1),
            "status": status,
            "needs_summarization": usage_percent >= thresholds["high"],
            "recommend_new_chat": usage_percent >= thresholds["critical"],
            "thresholds": {
                "warning": int(self._context_token_limit * thresholds["warning"]),
                "high": int(self._context_token_limit * thresholds["high"]),
                "critical": int(self._context_token_limit * thresholds["critical"]),
            },
        }
    
    async def summarize_context(self, chat_id: str) -> Optional[str]:
        """
        Summarize conversation context to reduce length.
        
        Args:
            chat_id: Chat identifier
            
        Returns:
            Summary text or None if failed
        """
        if chat_id not in self._chat_interpreters:
            logger.warning("No interpreter for chat: %s", chat_id[:8])
            return None
        
        interp = self._chat_interpreters[chat_id]
        
        # External OI mode: fetch messages via HTTP proxy if needed
        messages = []
        is_external = False
        if hasattr(interp, "get_messages") and inspect.iscoroutinefunction(interp.get_messages):
            try:
                messages = await interp.get_messages()
                is_external = True
            except Exception as exc:
                logger.warning("Failed to fetch messages from external OI for summary: %s", exc)
                return None
        elif hasattr(interp, "messages"):
            messages = interp.messages
        
        # Get token estimate
        status = await self.get_context_status(chat_id)
        if status.get("usage_percent", 0) < self._context_thresholds["high"]:
            # Only summarize if we are actually approaching the token limit
            # This fixes the "Context Window Suicide" bug where large single messages caused crashes
            return None
        
        if not messages or len(messages) < 3:
            return None  # Not enough messages to summarize, even if token count is high
        
        try:
            # Keep first 2 messages (system + initial user)
            # Summarize middle messages
            # Keep last 5 messages for continuity
            
            if len(messages) <= 5:
                # If we have very few messages but are over budget, we must aggressively truncate
                # the single huge message that caused the blowout.
                logger.warning("Context budget exceeded with only %s messages. Large output detected.", len(messages))
                # For this surgical fix, we'll let the user know, but won't rewrite the list in-place 
                # to avoid destroying the current message structure unexpectedly.
                # In a full refactor, this would truncate the largest message.
                return None
            
            system_msg = messages[0] if messages and messages[0].get('role') == 'system' else None
            initial_msgs = messages[:2]
            middle_msgs = messages[2:-5]
            recent_msgs = messages[-5:]
            
            # Build extractive summary of middle messages using DocumentUtility
            # to preserve key decisions, outputs, and context without hard truncation.
            logger.info("Summarizing %s messages for chat: %s", len(middle_msgs), chat_id[:8])
            
            # Concatenate all middle messages with role labels
            all_middle_text_parts = []
            for msg in middle_msgs:
                if isinstance(msg, dict) and msg.get('content'):
                    role = msg.get('role', 'unknown')
                    content = msg.get('content', '')
                    if content.strip():
                        all_middle_text_parts.append(f"[{role.upper()}]: {content}")
            
            full_middle_text = "\n\n".join(all_middle_text_parts)
            
            # Apply DocumentUtility extractive processing to preserve signal.
            # Small conversations pass through the gate in full (zero loss);
            # large conversations get sentence-level LexRank extraction automatically.
            try:
                from utils.document_processing import DocumentUtility
                util = DocumentUtility(max_context_tokens=10_000)
                result = util.extract_from_text(full_middle_text, "conversation_context")
                summary_text = result or full_middle_text
            except Exception as e:  # noqa: BLE001 -- summarization fallback: use full text on any failure
                logger.warning("DocumentUtility summarization failed, using full text: %s", e)
                summary_text = full_middle_text
            
            summary = f"CONVERSATION SUMMARY:\n{summary_text}"
            
            # Replace middle messages with summary
            new_messages = []
            if system_msg:
                new_messages.append(system_msg)
            
            new_messages.append({
                'role': 'assistant',
                'type': 'message',
                'content': summary,
            })
            
            new_messages.extend(recent_msgs)
            
            # Update interpreter messages
            if is_external and hasattr(interp, "set_messages"):
                await interp.set_messages(new_messages)
            elif hasattr(interp, "messages"):
                interp.messages = new_messages
            
            logger.info(
                "Context summarized: %s, %s → %s messages",
                chat_id[:8], len(messages), len(new_messages)
            )
            
            return summary
            
        except Exception as e:  # noqa: BLE001 -- top-level API boundary, must never crash
            logger.error("Failed to summarize context: %s", e, exc_info=True)
            return None
    
    def get_chat_interpreter_count(self) -> int:
        """Get number of active chat interpreters."""
        return len(self._chat_interpreters)
    
    def list_active_chats(self) -> List[str]:
        """Get list of chat IDs with active interpreters."""
        return list(self._chat_interpreters.keys())

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of interpreter manager (external-only mode).

        Returns:
            Dict with health status information
        """
        pool_servers = 0
        if self._external_server_pool:
            try:
                pool_servers = len(self._external_server_pool.list_servers())
            except Exception as e:
                logger.debug("Failed to list pool servers for health status: %s", e)

        return {
            "oi_available": self._external_server_enabled,
            "initialized": self._external_server_enabled,
            "mode": "external_per_chat" if self._external_server_per_chat else "external_shared",
            "active_chats": len(self._chat_interpreters),
            "pool_servers": pool_servers,
            "chat_ids": list(self._chat_interpreters.keys())[:10],
        }


# Global singleton accessor
def get_interpreter_manager() -> "InterpreterManager":
    """
    Get the singleton InterpreterManager instance.

    Returns:
        InterpreterManager: The global interpreter manager instance
    """
    from core.runtime.engine import get_interpreter_manager as get_manager
    return get_manager()


async def _maybe_await(value: Any) -> Any:
    """Await if awaitable, otherwise return directly."""
    if inspect.isawaitable(value):
        return await value
    return value

