"""
Runtime Interpreter Adapter — External OI Server Mode Only (AGPL Isolation)

Coordinates InterpreterManager lifecycle with runtime orchestration.
Handles initialization and configuration of external per-chat OI servers.

No in-process OI code is loaded. Integrations and tools are injected per-chat
by oi_server_wrapper.py on the external server side.

@.architecture
Incoming: core/runtime/coordinator.py --- {Settings}
Processing: initialize(), configure(), get_interpreter() --- {3 jobs: JOB_INITIALIZE_COMPONENT, JOB_LOAD_CONFIG, JOB_ORCHESTRATE}
Outgoing: core/runtime/interpreter.py --- {ExternalOIWebSocketInterpreter proxy, bool}
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from .interpreter import InterpreterManager

logger = logging.getLogger(__name__)


class RuntimeInterpreterAdapter:
    """
    Coordinates InterpreterManager responsibilities with runtime orchestration.
    """

    def __init__(self) -> None:
        self._manager: Optional[InterpreterManager] = None

    async def initialize(self) -> None:
        if self._manager:
            return
        from .engine import get_interpreter_manager
        manager = get_interpreter_manager()

        # IMPORTANT: RuntimeCoordinator calls initialize() before configure().
        # To keep external Open Interpreter mode non-breaking, we must apply central config here
        # so we do not import/initialize vendored OI when external mode is requested.
        try:
            from config.settings import get_settings as _get_settings

            settings = _get_settings()
            if hasattr(settings, "interpreter"):
                manager.configure_external_server(settings.interpreter)
        except Exception as exc:  # noqa: BLE001 -- re-raises as RuntimeError, must catch all config failures
            # Fail-fast only when external mode is explicitly enabled and misconfigured.
            # Otherwise, keep startup behaviour unchanged.
            raise RuntimeError(f"Failed to initialize interpreter backend mode: {exc}") from exc

        available = await manager.initialize()
        if not available:
            raise RuntimeError("Failed to initialize interpreter manager")
        self._manager = manager

    async def configure(self, settings: Any, mcp_manager=None) -> None:
        if not self._manager:
            raise RuntimeError("Interpreter manager not initialized")

        # Configure external OI server mode from central settings (fail-fast on misconfiguration).
        try:
            if hasattr(settings, "interpreter"):
                self._manager.configure_external_server(settings.interpreter)
        except Exception as exc:  # noqa: BLE001 -- re-raises as RuntimeError, must catch all config failures
            raise RuntimeError(f"Interpreter external server configuration invalid: {exc}") from exc

        # Create the per-chat template placeholder (real proxies are per-chat).
        template = await self._manager.create_interpreter()
        if not template:
            raise RuntimeError("Failed to create interpreter template")

        # Cache settings and populate system message for context viewer.
        await self._manager.apply_settings_async(settings, init=True)
        logger.info("External OI mode configured — integrations/tools injected per-chat by oi_server_wrapper.py")

    async def stop_generation(self, request_id: str, *, chat_id: Optional[str] = None) -> None:
        # Use get_cached_interpreter to avoid spawning a new server just to stop it
        interpreter = self._manager.get_cached_interpreter(chat_id=chat_id) if self._manager else None

        # Layer 1: Send WebSocket stop signal (best-effort, non-blocking).
        if interpreter:
            try:
                if hasattr(interpreter, "stop") and asyncio.iscoroutinefunction(getattr(interpreter, "stop")):
                    await interpreter.stop()
                    logger.debug("Sent WS stop to external OI server for request %s", request_id)
            except Exception as exc:  # noqa: BLE001 -- cleanup boundary: must not raise during stop
                logger.debug("WS stop failed for request %s: %s", request_id, exc)

        # Layer 2: Hard-kill the OI server process as fallback.
        # Per-chat isolation guarantees this only terminates this chat's server.
        # Next message from the user will spawn a fresh OI server automatically.
        # DO NOT gate this on interpreter existing (process might be orphaned or spawning).
        if chat_id and self._manager:
            try:
                # Remove from cache and trigger proxy cleanup
                await self._manager.reset_interpreter(chat_id)
            except Exception as e:
                logger.debug("Failed to reset interpreter cache for chat %s: %s", chat_id[:8], e)
                
            pool = getattr(self._manager, "_external_server_pool", None)
            if pool:
                try:
                    await pool.stop_server(chat_id)
                    logger.info("Killed OI process for chat %s (stop fallback)", chat_id[:8])
                except Exception as exc:  # noqa: BLE001 -- cleanup boundary: must not raise during stop
                    logger.debug("Process kill failed for chat %s: %s", chat_id[:8], exc)

    async def reset_state(self, client_id: str, chat_id: Optional[str] = None) -> None:
        """
        Handle context_reset.  In per-chat external mode, switching chats does NOT
        destroy the OI server — it preserves continuity when the user switches back.
        """
        # context_reset with a chat_id is a chat switch — preserve state.
        if chat_id:
            return
        # No chat_id means "wipe global state" — not applicable in external mode.
        logger.debug("reset_state called without chat_id (no-op in external mode) for client %s", client_id)

    async def apply_history(self, history: List[Dict[str, Any]], chat_id: Optional[str] = None) -> None:
        """Hydrate the external OI server with chat history via the /settings HTTP API."""
        if not history:
            return
        interpreter = await self.get_interpreter(chat_id=chat_id)
        if not interpreter:
            return
        try:
            from core.integrations.providers.open_interpreter.external_ws_proxy import ExternalOIWebSocketInterpreter

            dialogue_messages = []
            for entry in history:
                if not isinstance(entry, dict):
                    continue
                role = entry.get("role")
                content = entry.get("content")
                if not content:
                    continue
                # Skip system messages — authoritative system prompt is managed via /settings.
                if role in ("user", "assistant"):
                    raw_metadata = entry.get("metadata")
                    normalized_metadata = (
                        dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
                    )

                    # PROACTIVE CONTEXT HYDRATION FIX
                    # LLM only sees 'content', not 'metadata'. Inject hidden context into text.
                    if role == "assistant" and normalized_metadata.get("source") == "proactive":
                        proactive_context = normalized_metadata.get("context")
                        if proactive_context:
                            import json
                            try:
                                if isinstance(proactive_context, str):
                                    try:
                                        parsed = json.loads(proactive_context)
                                        context_str = json.dumps(parsed, indent=2)
                                    except:
                                        context_str = proactive_context
                                else:
                                    context_str = json.dumps(proactive_context, indent=2)
                                content = f"{content}\n\n[System Note: The above proactive recommendation was generated based on this background context:\n{context_str}\n]"
                            except Exception as e:
                                logger.warning("Failed to serialize proactive context: %s", e)

                    dialogue_messages.append(
                        {
                            "role": role,
                            "type": entry.get("type") or "message",
                            "content": content,
                            "metadata": normalized_metadata,
                        }
                    )

            if not isinstance(interpreter, ExternalOIWebSocketInterpreter):
                logger.warning("apply_history called on non-external interpreter (chat=%s) — no-op", (chat_id or "")[:8])
                return

            await interpreter.set_messages(dialogue_messages)
            logger.info("Hydrated external OI messages via /settings (chat=%s, messages=%s)", (chat_id or "")[:8], len(dialogue_messages))

        except Exception as exc:  # noqa: BLE001 -- hydration boundary: non-critical, don't crash chat
            logger.warning("Failed to hydrate interpreter history: %s", exc)

    async def append_custom_instructions(
        self,
        appendix: str,
        *,
        chat_id: Optional[str] = None,
        marker: Optional[str] = None,
    ) -> None:
        """
        Append content to the active system instructions for a chat
        via the external OI server's HTTP /settings API.
        """
        appendix_text = str(appendix or "")
        if not appendix_text.strip():
            return

        interpreter = await self.get_interpreter(chat_id=chat_id)
        if not interpreter:
            return

        try:
            from core.integrations.providers.open_interpreter.external_ws_proxy import ExternalOIWebSocketInterpreter

            if isinstance(interpreter, ExternalOIWebSocketInterpreter):
                await interpreter.append_custom_instructions(appendix_text, marker=marker)
            else:
                logger.warning("append_custom_instructions called on non-external interpreter (chat=%s) — no-op", (chat_id or "")[:8])
        except Exception as exc:  # noqa: BLE001 -- instructions boundary: non-critical, don't crash chat
            logger.debug("Failed to append custom instructions (chat=%s): %s", (chat_id or "")[:8], exc)

    async def get_interpreter(self, chat_id: Optional[str] = None) -> Optional[Any]:
        if not self._manager:
            return None
        # CRITICAL: Pass chat_id for proper interpreter isolation per chat
        return await self._manager.get_interpreter(chat_id=chat_id)

    def is_available(self) -> bool:
        return bool(self._manager and self._manager.is_available())

    async def cleanup(self) -> None:
        if self._manager:
            await self._manager.cleanup()

    def get_health_status(self) -> Dict[str, Any]:
        if not self._manager:
            return {"available": False}
        return self._manager.get_health_status()

    # NOTE: In external-only OI mode, integrations and MCP tools are injected
    # per-chat by oi_server_wrapper.py.  The _load_integrations_to_template,
    # _validate_integrations, and _setup_mcp_bridge methods have been removed
    # as they were in-process-only code paths (AGPL isolation cleanup).


