from __future__ import annotations

"""
Runtime Settings Service (DB-backed user preferences)

Owns the lifecycle of "runtime settings" = central defaults + user preferences from DB.

@.architecture
Incoming: config/settings.get_settings (defaults), data/database/repositories/preferences.IPreferencesRepository --- {Settings, Dict[str, Any]}
Processing: load preferences, merge into Settings, cache/invalidate --- {JOB_LOAD_CONFIG, JOB_QUERY_DB, JOB_MERGE_SETTINGS}
Outgoing: api/dependencies.get_runtime_settings, ws handlers --- {Settings}
"""


from typing import Any, Dict, Tuple

from config.dynamic_settings import _apply_integrations_overrides
from config.settings import (
    APIKeySettings,
    ComputerAPISettings,
    ContextRetrievalSettings,
    ErrorHandlingSettings,
    LLMSettings,
    RateLimitRuleSettings,
    RateLimitTierSettings,
    ServiceProviderConfig,
    Settings,
)
from data.database.repositories.preferences import PreferencesRepository
from monitoring import get_logger

logger = get_logger(__name__)

def _should_apply_str_pref(base_value: Any, new_value: Any) -> bool:
    """Return True if a DB preference should override the base value.

    When the base value is a non-empty string (i.e. the config has a
    meaningful default), reject overrides that are empty, whitespace-only,
    or non-string.  This prevents stale/corrupt DB preferences from
    clobbering valid defaults (e.g. memory.type="" overriding "supabase",
    or interpreter.profile="" overriding "GURU.yaml").

    Non-string base values (bool, int, float, None) are always allowed
    through — their validation is handled elsewhere.
    """
    if not isinstance(base_value, str) or not base_value:
        # Base is not a meaningful string default — allow any override.
        return True
    # Base has a non-empty string default.  Only override with a
    # non-empty string.
    return isinstance(new_value, str) and bool(new_value.strip())

class RuntimeSettingsService:
    def __init__(self) -> None:
        self._cache_version: int = 0
        self._cache: Dict[Tuple[int, int, str], Settings] = {}
        self._is_initialized: bool = True
        self._is_disposed: bool = False
        self._subscribed: bool = False

    def dispose(self) -> None:
        if self._is_disposed:
            return
        self._cache.clear()
        self._is_initialized = False
        self._is_disposed = True

    def invalidate_cache(self) -> None:
        """Invalidate cached runtime settings to force reload from DB."""
        self._cache_version += 1
        self._cache.clear()
        logger.info("Runtime settings cache invalidated (version=%s)", self._cache_version)

    async def get_runtime_settings(self, gateway: Any, user_id: str, force_refresh: bool = False) -> Settings:
        """
        Async entrypoint for runtime settings (DB-backed overrides).

        Args:
            gateway: Database gateway
            user_id: User ID
            force_refresh: If True, bypass cache and reload from disk+DB
        """
        # Subscribe to Supabase Realtime for cross-process cache invalidation
        # if not already subscribed and gateway is capable.
        if not self._subscribed and gateway is not None and hasattr(gateway, 'subscribe_realtime'):
            self._subscribed = True
            try:
                await gateway.subscribe_realtime(
                    "user_preferences",
                    event="*",
                    on_insert=lambda payload: self.invalidate_cache(),
                    on_update=lambda payload: self.invalidate_cache(),
                    on_delete=lambda payload: self.invalidate_cache()
                )
                logger.info("Subscribed to user_preferences realtime changes for cross-process cache invalidation")
            except Exception as e:
                self._subscribed = False
                logger.warning("Failed to subscribe to user_preferences for realtime invalidation: %s", e)

        try:
            resolved_user_id = (user_id or "").strip() or "default_user"
            key = (self._cache_version, id(gateway), resolved_user_id)
        
            if not force_refresh:
                cached = self._cache.get(key)
                if cached is not None:
                    return cached

            settings = await self._load_runtime_settings_async(gateway, resolved_user_id)
            self._cache[key] = settings
            return settings
        except Exception as e:
            logger.error("Failed to get runtime settings for user %s: %s", user_id, e, exc_info=True)
            raise

    async def _load_runtime_settings_async(self, gateway: Any, user_id: str) -> Settings:
        """
        Load settings from DB asynchronously and merge into central defaults.

        Fail-fast behavior:
        - If DB access fails in a context that requested runtime settings, raise.
          (Caller chooses whether to treat that as fatal for the request.)
        """
        # Prefer central config defaults (cached by config.settings).
        from config.settings import get_settings as _get_settings
        base_settings = _get_settings()

        prefs_repo = PreferencesRepository(gateway)
        all_prefs = await prefs_repo.get_all_preferences(user_id)
        if not all_prefs:
            return base_settings

        # 1) LLM settings override
        llm_prefs = all_prefs.get("llm_settings")
        if llm_prefs:
            base_settings.llm = LLMSettings(
                provider=llm_prefs.get("provider", base_settings.llm.provider),
                api_base=llm_prefs.get("api_base", base_settings.llm.api_base),
                api_key=llm_prefs.get("api_key", base_settings.llm.api_key),
                model=llm_prefs.get("model", base_settings.llm.model),
                max_tokens=llm_prefs.get("max_tokens", base_settings.llm.max_tokens),
                context_window=llm_prefs.get("context_window", base_settings.llm.context_window),
                supports_vision=llm_prefs.get("supports_vision", base_settings.llm.supports_vision),
                supports_functions=llm_prefs.get("supports_functions", base_settings.llm.supports_functions),
            )

        # 2) Interpreter error handling overrides
        error_handling_prefs = all_prefs.get("error_handling")
        if error_handling_prefs:
            base_settings.interpreter.error_handling = ErrorHandlingSettings(
                enabled=error_handling_prefs.get("enabled", base_settings.interpreter.error_handling.enabled),
                show_technical_details=error_handling_prefs.get(
                    "show_technical_details",
                    base_settings.interpreter.error_handling.show_technical_details,
                ),
                show_suggestions=error_handling_prefs.get(
                    "show_suggestions",
                    base_settings.interpreter.error_handling.show_suggestions,
                ),
                context_length_message=error_handling_prefs.get(
                    "context_length_message",
                    base_settings.interpreter.error_handling.context_length_message,
                ),
                authentication_message=error_handling_prefs.get(
                    "authentication_message",
                    base_settings.interpreter.error_handling.authentication_message,
                ),
                rate_limit_message=error_handling_prefs.get(
                    "rate_limit_message",
                    base_settings.interpreter.error_handling.rate_limit_message,
                ),
                connection_message=error_handling_prefs.get(
                    "connection_message",
                    base_settings.interpreter.error_handling.connection_message,
                ),
                model_error_message=error_handling_prefs.get(
                    "model_error_message",
                    base_settings.interpreter.error_handling.model_error_message,
                ),
                invalid_request_message=error_handling_prefs.get(
                    "invalid_request_message",
                    base_settings.interpreter.error_handling.invalid_request_message,
                ),
                unknown_error_message=error_handling_prefs.get(
                    "unknown_error_message",
                    base_settings.interpreter.error_handling.unknown_error_message,
                ),
            )

        # 3) Vision overrides
        vision_prefs = all_prefs.get("vision_document")
        if vision_prefs:
            for key, value in vision_prefs.items():
                if hasattr(base_settings.vision_document, key):
                    if _should_apply_str_pref(getattr(base_settings.vision_document, key), value):
                        setattr(base_settings.vision_document, key, value)

        # 4) Handsfree overrides (NOTE: preserves existing mapping behavior)
        handsfree_prefs = all_prefs.get("handsfree")
        if handsfree_prefs:
            if "stt_model" in handsfree_prefs:
                stt_model = handsfree_prefs["stt_model"]
                if isinstance(stt_model, str) and stt_model and not stt_model.startswith("openai/"):
                    stt_model = f"openai/{stt_model}"
                base_settings.audio.stt.model_id = stt_model
            if "stt_language" in handsfree_prefs:
                base_settings.audio.stt.language = handsfree_prefs["stt_language"]
            if "wake_word_model" in handsfree_prefs:
                base_settings.audio.wake_word.model_name = handsfree_prefs["wake_word_model"]
            if "wake_word_threshold" in handsfree_prefs:
                base_settings.audio.wake_word.threshold = handsfree_prefs["wake_word_threshold"]
            if "conversation_timeout" in handsfree_prefs:
                base_settings.audio.handsfree.conversation_timeout_seconds = float(handsfree_prefs["conversation_timeout"])
            if "silence_timeout" in handsfree_prefs:
                # Frontend stores silence timeout in ms, VAD expects min_duration_off in seconds
                base_settings.audio.vad.min_duration_off = float(handsfree_prefs["silence_timeout"]) / 1000.0
            if "vad_threshold" in handsfree_prefs:
                base_settings.audio.vad.threshold = handsfree_prefs["vad_threshold"]
            if "interruption_threshold" in handsfree_prefs:
                base_settings.audio.handsfree.interruption_threshold = handsfree_prefs["interruption_threshold"]
            if "interruption_cooldown" in handsfree_prefs:
                base_settings.audio.handsfree.interruption_cooldown_ms = handsfree_prefs["interruption_cooldown"]
            if "auto_loop" in handsfree_prefs:
                base_settings.audio.handsfree.auto_loop = handsfree_prefs["auto_loop"]
            # TTS overrides — engine, voice, speed, language
            if "tts_engine" in handsfree_prefs:
                base_settings.audio.tts.engine = handsfree_prefs["tts_engine"]
            if "tts_voice" in handsfree_prefs:
                base_settings.audio.tts.voice = handsfree_prefs["tts_voice"]
            if "tts_speed" in handsfree_prefs:
                base_settings.audio.tts.speed = float(handsfree_prefs["tts_speed"])
            if "tts_language" in handsfree_prefs:
                base_settings.audio.tts.qwen3_language = handsfree_prefs["tts_language"]

        # 5) Memory overrides
        # NOTE: The "memory" DB preference stores MemorySettings fields (enabled, type, path, embedder).
        # MemoryServiceSettings fields (global_injection_enabled, etc.) are a separate object.
        # Apply to the correct target based on which class owns the attribute.
        # Guard: empty strings must not clobber valid defaults (e.g. type="" over "supabase").
        memory_prefs = all_prefs.get("memory")
        if memory_prefs:
            for key, value in memory_prefs.items():
                if hasattr(base_settings.memory, key):
                    if _should_apply_str_pref(getattr(base_settings.memory, key), value):
                        setattr(base_settings.memory, key, value)
                elif hasattr(base_settings.memory_service, key):
                    if _should_apply_str_pref(getattr(base_settings.memory_service, key), value):
                        setattr(base_settings.memory_service, key, value)

        # 6) Summary overrides
        summary_prefs = all_prefs.get("summary")
        if summary_prefs:
            for key, value in summary_prefs.items():
                if hasattr(base_settings.summary_service, key):
                    if _should_apply_str_pref(getattr(base_settings.summary_service, key), value):
                        setattr(base_settings.summary_service, key, value)

        # 7) UI overrides
        ui_prefs = all_prefs.get("ui")
        if ui_prefs:
            for key, value in ui_prefs.items():
                if hasattr(base_settings.ui, key):
                    if _should_apply_str_pref(getattr(base_settings.ui, key), value):
                        setattr(base_settings.ui, key, value)

        # 8) Interpreter overrides (back-compat: interpreter_settings)
        interpreter_prefs = all_prefs.get("interpreter") or all_prefs.get("interpreter_settings")
        if interpreter_prefs:
            # Fail-fast: never clobber nested Pydantic models (computer/error_handling/context_retrieval)
            # with raw dicts from DB preferences.
            for key, value in interpreter_prefs.items():
                if key == "computer" and isinstance(value, dict):
                    base_settings.interpreter.computer = ComputerAPISettings(
                        import_computer_api=value.get("import_computer_api", base_settings.interpreter.computer.import_computer_api),
                        import_skills=value.get("import_skills", base_settings.interpreter.computer.import_skills),
                        skills_path=value.get("skills_path", base_settings.interpreter.computer.skills_path),
                    )
                    continue
                if key == "error_handling" and isinstance(value, dict):
                    base_settings.interpreter.error_handling = ErrorHandlingSettings(
                        enabled=value.get("enabled", base_settings.interpreter.error_handling.enabled),
                        show_technical_details=value.get("show_technical_details", base_settings.interpreter.error_handling.show_technical_details),
                        show_suggestions=value.get("show_suggestions", base_settings.interpreter.error_handling.show_suggestions),
                        context_length_message=value.get("context_length_message", base_settings.interpreter.error_handling.context_length_message),
                        authentication_message=value.get("authentication_message", base_settings.interpreter.error_handling.authentication_message),
                        rate_limit_message=value.get("rate_limit_message", base_settings.interpreter.error_handling.rate_limit_message),
                        connection_message=value.get("connection_message", base_settings.interpreter.error_handling.connection_message),
                        model_error_message=value.get("model_error_message", base_settings.interpreter.error_handling.model_error_message),
                        invalid_request_message=value.get("invalid_request_message", base_settings.interpreter.error_handling.invalid_request_message),
                        unknown_error_message=value.get("unknown_error_message", base_settings.interpreter.error_handling.unknown_error_message),
                    )
                    continue
                if key == "context_retrieval" and isinstance(value, dict):
                    base_settings.interpreter.context_retrieval = ContextRetrievalSettings(
                        enabled=value.get("enabled", base_settings.interpreter.context_retrieval.enabled),
                        max_total_results=value.get("max_total_results", base_settings.interpreter.context_retrieval.max_total_results),
                        default_top_k=value.get("default_top_k", base_settings.interpreter.context_retrieval.default_top_k),
                        min_score=value.get("min_score", base_settings.interpreter.context_retrieval.min_score),
                        timeout_ms=value.get("timeout_ms", base_settings.interpreter.context_retrieval.timeout_ms),
                        max_concurrent_searches=value.get("max_concurrent_searches", base_settings.interpreter.context_retrieval.max_concurrent_searches),
                    )
                    continue

                # Scalars: only apply if the attribute exists and the preference isn't trying to replace a model with a dict.
                if hasattr(base_settings.interpreter, key):
                    if isinstance(getattr(base_settings.interpreter, key), (ComputerAPISettings, ErrorHandlingSettings, ContextRetrievalSettings)):
                        # Caller attempted to set nested model incorrectly (e.g., "computer": {...} handled above).
                        # Ignore to prevent runtime type corruption.
                        continue
                
                    # CRITICAL: system_message from YAML profile (GURU) is authoritative.
                    # Only allow DB to override if it provides non-empty value.
                    # This prevents empty DB preference from clobbering YAML-loaded profile.
                    if key == "system_message":
                        db_value = value
                        base_value = getattr(base_settings.interpreter, key, "")
                        logger.info("system_message merge: base_len=%d, db_len=%s, db_has_content=%s", len(base_value), len(db_value) if isinstance(db_value, str) else "not-str", bool(isinstance(db_value, str) and db_value.strip()))
                        if isinstance(db_value, str) and db_value.strip():
                            # DB has explicit override - use it
                            setattr(base_settings.interpreter, key, db_value)
                            logger.info("Using DB system_message (%d chars)", len(db_value))
                        else:
                            logger.info("Keeping YAML system_message (%d chars)", len(base_value))
                        # else: keep YAML-loaded value (don't overwrite with empty string)
                        continue
                
                    # Guard: empty strings must not clobber valid defaults
                    # (e.g. profile="" over "GURU.yaml").
                    if not _should_apply_str_pref(getattr(base_settings.interpreter, key), value):
                        continue
                    setattr(base_settings.interpreter, key, value)

        # 9) Integrations overrides (validated)
        integrations_prefs = all_prefs.get("integrations")
        if integrations_prefs:
            _apply_integrations_overrides(base_settings, integrations_prefs)

        # 10) Security overrides
        security_prefs = all_prefs.get("security")
        if security_prefs and isinstance(security_prefs, dict):
            for key, value in security_prefs.items():
                if not hasattr(base_settings.security, key):
                    continue

                if key == "static_api_keys":
                    if not isinstance(value, list):
                        logger.warning("Ignoring invalid security.%s preference payload type: %s", key, type(value).__name__)
                        continue
                    parsed_keys = []
                    for item in value:
                        if not isinstance(item, dict):
                            continue
                        try:
                            parsed_keys.append(APIKeySettings(**item))
                        except Exception:
                            continue
                    setattr(base_settings.security, key, parsed_keys)
                    continue

                if key == "rate_limit_tiers":
                    if not isinstance(value, list):
                        logger.warning("Ignoring invalid security.%s preference payload type: %s", key, type(value).__name__)
                        continue
                    parsed_tiers = []
                    for item in value:
                        if not isinstance(item, dict):
                            continue
                        try:
                            parsed_tiers.append(RateLimitTierSettings(**item))
                        except Exception:
                            continue
                    setattr(base_settings.security, key, parsed_tiers)
                    continue

                if key == "rate_limit_rules":
                    if not isinstance(value, list):
                        logger.warning("Ignoring invalid security.%s preference payload type: %s", key, type(value).__name__)
                        continue
                    parsed_rules = []
                    for item in value:
                        if not isinstance(item, dict):
                            continue
                        try:
                            parsed_rules.append(RateLimitRuleSettings(**item))
                        except Exception:
                            continue
                    setattr(base_settings.security, key, parsed_rules)
                    continue

                if _should_apply_str_pref(getattr(base_settings.security, key), value):
                    setattr(base_settings.security, key, value)

        # 11) Embedding service overrides (model selection from frontend)
        embedding_prefs = all_prefs.get("embedding_service")
        if embedding_prefs:
            for key, value in embedding_prefs.items():
                if hasattr(base_settings.embedding_service, key):
                    if _should_apply_str_pref(getattr(base_settings.embedding_service, key), value):
                        setattr(base_settings.embedding_service, key, value)

        # 12) Per-service AI provider overrides (user can change provider/model per service)
        svc_prefs = all_prefs.get("service_providers")
        if svc_prefs and isinstance(svc_prefs, dict):
            for svc_key, config_dict in svc_prefs.items():
                if not isinstance(config_dict, dict):
                    continue
                spc = ServiceProviderConfig(
                    provider=config_dict.get("provider", ""),
                    api_base=config_dict.get("api_base", ""),
                    model=config_dict.get("model", ""),
                    api_key=config_dict.get("api_key", "not-needed"),
                )
                if svc_key == "summary":
                    base_settings.summary_service.provider_config = spc
                elif svc_key == "query_generation":
                    base_settings.proactive.query_generation.provider_config = spc
                elif svc_key == "vision_ocr":
                    base_settings.vision_document.provider_config = spc
                elif svc_key == "research":
                    base_settings.research_service.provider_config = spc

        # 13) User profile overrides
        user_profile_prefs = all_prefs.get("user_profile")
        if user_profile_prefs:
            for key, value in user_profile_prefs.items():
                if hasattr(base_settings.user_profile, key):
                    if _should_apply_str_pref(getattr(base_settings.user_profile, key), value):
                        setattr(base_settings.user_profile, key, value)

        return base_settings
