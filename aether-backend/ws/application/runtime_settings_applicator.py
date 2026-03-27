"""
@.architecture

Incoming: application/stream_orchestrator --- {Any runtime, Any chat_repository, str chat_id}
Processing: resolve DB-backed runtime settings and apply to runtime engine --- {2 jobs: JOB_RESOLVE_SETTINGS, JOB_APPLY_SETTINGS}
Outgoing: none (mutates runtime in-place)

RuntimeSettingsApplicator - Application service for pre-stream settings resolution

Resolves DB-backed runtime settings BEFORE streaming starts.
Ensures WebSocket chat uses UI-selected llm_settings (model, capabilities)
instead of static config defaults (models.toml).

FAIL_FAST: Raises RuntimeError if settings cannot be resolved when DB is present.
This prevents streaming with wrong model + wrong capabilities.
"""

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


class RuntimeSettingsApplicator:
    """
    Application service for resolving and applying runtime settings before streaming.

    Extracted from StreamOrchestrator to isolate settings resolution concern.
    """

    async def apply(
        self,
        *,
        runtime: Any,
        chat_repository: Optional[Any],
        chat_id: Optional[str],
    ) -> None:
        """
        Resolve DB-backed runtime settings and apply to runtime + interpreter manager.

        Steps:
        1. Get persistence gateway from chat_repository
        2. Resolve effective settings via runtime_settings_service
        3. Apply to runtime.settings facade
        4. Apply to interpreter_manager (for per-chat OI servers)

        Args:
            runtime: RuntimeEngine instance
            chat_repository: ChatRepository instance (None skips resolution)
            chat_id: Chat UUID string (None skips resolution)

        Raises:
            RuntimeError: If DB is present but settings cannot be resolved
                (streaming with wrong model is unsafe)
        """
        if not chat_id or not chat_repository:
            return

        gateway = getattr(chat_repository, "_gateway", None)
        if gateway is None:
            return

        try:
            from application.settings import get_runtime_settings_service

            # Single-user mode: default_user is authoritative
            effective_settings = await get_runtime_settings_service().get_runtime_settings(
                gateway, "default_user"
            )

            # Update runtime facade so downstream checks see correct settings
            try:
                if hasattr(runtime, "settings"):
                    runtime.settings = effective_settings
            except Exception:
                pass

            # Apply to interpreter manager (per-chat external OI servers)
            try:
                manager = getattr(runtime, "_interpreter_manager", None)
                if manager and hasattr(manager, "apply_settings_async"):
                    await manager.apply_settings_async(
                        effective_settings, init=False
                    )
            except Exception:
                pass

        except Exception as exc:
            raise RuntimeError(
                f"Failed to resolve/apply runtime settings for WebSocket stream: {exc}"
            ) from exc
