"""
Settings Management Endpoints

Provides read-only access to system settings and user-configurable preferences.

@.architecture
Incoming: Frontend UI, Admin tools --- {GET requests}
Processing: Load settings, expose configuration --- {2 jobs: JOB_LOAD_CONFIG, JOB_VALIDATE_SCHEMA}
Outgoing: Frontend --- {Settings schemas}
"""

from fastapi import APIRouter, Depends, HTTPException, status
from typing import Dict, Any, List
from pydantic import BaseModel, Field

from config.settings import Settings, get_settings
from core.exceptions import DomainException
from api.dependencies import get_database, get_runtime_settings, setup_request_context, get_preferences_service
from application.settings.preferences_service import PreferencesService
from api.v1.schemas.settings import SettingsPatchRequest
from monitoring import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


# ========================================
# Helper Functions
# ========================================

async def _build_settings_response(
    settings: Settings,
    prefs_service: PreferencesService,
    user_id: str
) -> Dict[str, Any]:
    """
    Build complete settings response with DB overrides.
    
    Shared logic for GET and POST endpoints to avoid duplication.
    
    Args:
        settings: Settings instance (with or without DB overrides)
        prefs_service: Service for fetching preferences
        
    Returns:
        Complete settings dictionary
    """
    resolved_user_id = user_id or settings.security.default_user_id
    all_prefs = await prefs_service.get_all_preferences(resolved_user_id)
    
    return {
        "app_name": settings.app_name,
        "app_version": settings.app_version,
        "environment": settings.environment,
        # Interpreter settings (Open Interpreter)
        "interpreter": {
            "auto_run": settings.interpreter.auto_run,
            "loop": settings.interpreter.loop,
            "safe_mode": settings.interpreter.safe_mode,
            "profile": settings.interpreter.profile,
            "system_message": settings.interpreter.system_message,
            "offline": settings.interpreter.offline,
            "disable_telemetry": settings.interpreter.disable_telemetry,
            # External server mode (per-chat isolation)
            "external_server_enabled": settings.interpreter.external_server_enabled,
            "external_server_url": settings.interpreter.external_server_url,
            "external_server_auth": settings.interpreter.external_server_auth,
            "external_server_per_chat": settings.interpreter.external_server_per_chat,
            "external_server_host": settings.interpreter.external_server_host,
            "external_server_port_min": settings.interpreter.external_server_port_min,
            "external_server_port_max": settings.interpreter.external_server_port_max,
            "external_server_max_servers": settings.interpreter.external_server_max_servers,
            "external_server_ttl_seconds": settings.interpreter.external_server_ttl_seconds,
            "external_server_startup_timeout_seconds": settings.interpreter.external_server_startup_timeout_seconds,
            "external_server_venv_python": settings.interpreter.external_server_venv_python,
            "external_server_wrapper_script": settings.interpreter.external_server_wrapper_script,
            # Note: context_token_limit removed - use settings.llm.context_window instead
            "context_warning_threshold": settings.interpreter.context_warning_threshold,
            "context_high_threshold": settings.interpreter.context_high_threshold,
            "context_critical_threshold": settings.interpreter.context_critical_threshold,
            "computer": {
                "import_computer_api": settings.interpreter.computer.import_computer_api,
                "import_skills": settings.interpreter.computer.import_skills,
                "skills_path": settings.interpreter.computer.skills_path,
            },
            "error_handling": {
                "enabled": settings.interpreter.error_handling.enabled,
                "show_technical_details": settings.interpreter.error_handling.show_technical_details,
                "show_suggestions": settings.interpreter.error_handling.show_suggestions,
                "context_length_message": settings.interpreter.error_handling.context_length_message,
                "authentication_message": settings.interpreter.error_handling.authentication_message,
                "rate_limit_message": settings.interpreter.error_handling.rate_limit_message,
                "connection_message": settings.interpreter.error_handling.connection_message,
                "model_error_message": settings.interpreter.error_handling.model_error_message,
                "invalid_request_message": settings.interpreter.error_handling.invalid_request_message,
                "unknown_error_message": settings.interpreter.error_handling.unknown_error_message,
            }
        },
        # LLM settings (OpenAI-compatible providers)
        "llm": {
            "provider": settings.llm.provider,
            "api_base": settings.llm.api_base,
            "api_key": settings.llm.api_key,
            "model": settings.llm.model,
            "summarizer_model": settings.llm.summarizer_model,
            "embedding_model": settings.llm.embedding_model,
            "supports_vision": settings.llm.supports_vision,
            "temperature": settings.llm.temperature,
            "max_tokens": settings.llm.max_tokens,
            "context_window": settings.llm.context_window,
        },
        # Vision & Document settings
        "vision_document": {
            "vision_model": settings.vision_document.vision_model,
            "vision_model_lmstudio": settings.vision_document.vision_model_lmstudio,
            "ocr_engine": settings.vision_document.ocr_engine,
            "ocr_languages": settings.vision_document.ocr_languages,
            "enable_code_enrichment": settings.vision_document.enable_code_enrichment,
            "enable_formula_enrichment": settings.vision_document.enable_formula_enrichment,
            "enable_picture_classification": settings.vision_document.enable_picture_classification,
            "enable_picture_description": settings.vision_document.enable_picture_description,
            "output_format": settings.vision_document.output_format,
        },
        # Handsfree settings (audio I/O) - mapped from nested audio config + DB prefs
        "handsfree": {
            # STT settings (from AudioConfig)
            "stt_model": settings.audio.stt.model_id,
            "stt_language": settings.audio.stt.language or "en",
            # TTS settings (from DB preferences + config defaults)
            "tts_enabled": all_prefs.get("handsfree", {}).get("tts_enabled", False),
            "tts_engine": all_prefs.get("handsfree", {}).get("tts_engine", settings.audio.tts.engine),
            "tts_voice": all_prefs.get("handsfree", {}).get("tts_voice", settings.audio.tts.voice),
            "tts_language": all_prefs.get("handsfree", {}).get("tts_language", settings.audio.tts.qwen3_language),
            "tts_speed": all_prefs.get("handsfree", {}).get("tts_speed", settings.audio.tts.speed),
            "tts_volume": all_prefs.get("handsfree", {}).get("tts_volume", 1.0),
            "tts_first_sentence_target_words": settings.audio.tts.first_sentence_target_words,
            "tts_chunk_target_words": settings.audio.tts.chunk_target_words,
            # Wake word settings (from AudioConfig.wake_word)
            "wake_word_model": settings.audio.wake_word.model_name,
            "wake_word_threshold": settings.audio.wake_word.threshold,
            # Handsfree mode settings (from AudioConfig.handsfree)
            "conversation_timeout": settings.audio.handsfree.conversation_timeout_seconds,
            "auto_loop": settings.audio.handsfree.auto_loop,
            "auto_loop_debounce_ms": settings.audio.handsfree.auto_loop_debounce_ms,
            "vad_timeout_ms": settings.audio.handsfree.vad_timeout_ms,
            "interruption_threshold": settings.audio.handsfree.interruption_threshold,
            "interruption_cooldown": settings.audio.handsfree.interruption_cooldown_ms,
            # VAD settings (from AudioConfig.vad)
            "vad_enabled": settings.audio.wake_word.enable_vad,  # Wake word internal VAD
            "vad_threshold": settings.audio.vad.threshold,
            "vad_min_duration_on": settings.audio.vad.min_duration_on,
            "vad_min_duration_off": settings.audio.vad.min_duration_off,
            # User-configurable fields from DB prefs
            "interruption_enabled": all_prefs.get("handsfree", {}).get("interruption_enabled", True),
            "push_to_talk": all_prefs.get("handsfree", {}).get("push_to_talk", False),
            "silence_timeout": all_prefs.get("handsfree", {}).get("silence_timeout", 2.0),
            # Proactive Agent TTS (independent of handsfree TTS)
            "proactive_tts_enabled": all_prefs.get("handsfree", {}).get("proactive_tts_enabled", False),
            "proactive_tts_voice": all_prefs.get("handsfree", {}).get("proactive_tts_voice", settings.audio.tts.voice),
            "proactive_tts_language": all_prefs.get("handsfree", {}).get("proactive_tts_language", ""),
        },
        # Memory settings
        "memory": {
            "enabled": settings.memory.enabled,
            "type": settings.memory.type,
        },
        # Agent system defaults (frontend uses as UI defaults)
        "workers": {
            "enabled": settings.workers.enabled,
            "poll_interval": settings.workers.poll_interval,
            "max_concurrent": settings.workers.max_concurrent,
        },
        "agents": {
            "context_retrieval": {
                "enabled": settings.interpreter.context_retrieval.enabled,
                "max_total_results": settings.interpreter.context_retrieval.max_total_results,
                "default_top_k": settings.interpreter.context_retrieval.default_top_k,
                "min_score": settings.interpreter.context_retrieval.min_score,
                "timeout_ms": settings.interpreter.context_retrieval.timeout_ms,
                "max_concurrent_searches": settings.interpreter.context_retrieval.max_concurrent_searches,
            },
            "ui_polling": {
                "jobs_poll_interval_ms": settings.agent_ui.jobs_poll_interval_ms,
                "index_health_poll_interval_ms": settings.agent_ui.index_health_poll_interval_ms,
            }
        },
        # Summary settings
        "summary": all_prefs.get("summary", {
            "enabled": True,
            "trigger": "auto",
            "model": settings.llm.summarizer_model,
        }),
        # Integration URLs
        "integrations": {
            "perplexica_url": settings.integrations.perplexica_url,
            "searxng_url": settings.integrations.searxng_url,
            "xlwings_base_dir": settings.integrations.xlwings_base_dir,
            "lm_studio_url": settings.integrations.lm_studio_url,
            "file_indexing_enabled": settings.integrations.file_indexing_enabled,
            "file_indexing_backend_url": settings.integrations.file_indexing_backend_url,
            "aether_rag_sources": {
                "enabled": settings.integrations.aether_rag_sources.enabled,
                "index_root_dir": settings.integrations.aether_rag_sources.index_root_dir,
                "slack": {
                    "enabled": settings.integrations.aether_rag_sources.slack.enabled,
                    "configured": bool(settings.integrations.aether_rag_sources.slack.mcp_command),
                    "default_index_name": settings.integrations.aether_rag_sources.slack.default_index_name,
                    "max_messages_per_channel": settings.integrations.aether_rag_sources.slack.max_messages_per_channel,
                    "max_retries": settings.integrations.aether_rag_sources.slack.max_retries,
                    "retry_delay_seconds": settings.integrations.aether_rag_sources.slack.retry_delay_seconds,
                },
                "browser_history": {
                    "enabled": settings.integrations.aether_rag_sources.browser_history.enabled,
                    "default_index_name": settings.integrations.aether_rag_sources.browser_history.default_index_name,
                    "browser": settings.integrations.aether_rag_sources.browser_history.browser,
                    "profile_path": settings.integrations.aether_rag_sources.browser_history.profile_path,
                    "auto_find_profiles": settings.integrations.aether_rag_sources.browser_history.auto_find_profiles,
                    "user_data_dir": settings.integrations.aether_rag_sources.browser_history.user_data_dir,
                    "max_items": settings.integrations.aether_rag_sources.browser_history.max_items,
                },
                "email": {
                    "enabled": settings.integrations.aether_rag_sources.email.enabled,
                    "default_index_name": settings.integrations.aether_rag_sources.email.default_index_name,
                    "source_path": settings.integrations.aether_rag_sources.email.source_path,
                    "max_items": settings.integrations.aether_rag_sources.email.max_items,
                },
                "search": {
                    "mode": settings.integrations.aether_rag_sources.search.mode,
                    "hybrid_semantic_weight": settings.integrations.aether_rag_sources.search.hybrid_semantic_weight,
                    "hybrid_sparse_weight": settings.integrations.aether_rag_sources.search.hybrid_sparse_weight,
                    "rrf_k": settings.integrations.aether_rag_sources.search.rrf_k,
                },
            },
        },
        # Embedding service (Perplexica ONNX)
        "embedding_service": {
            "enabled": settings.embedding_service.enabled,
            "url": settings.embedding_service.service_url,
            "model": settings.embedding_service.model,
            "quality_model": settings.embedding_service.quality_model,
            "dimensions": settings.embedding_service.dimensions,
            "quality_dimensions": settings.embedding_service.quality_dimensions,
        },
        # Memory service configuration
        "memory_service": {
            "global_injection_enabled": settings.memory_service.global_injection_enabled,
            "global_injection_limit": settings.memory_service.global_injection_limit,
            "global_injection_min_importance": settings.memory_service.global_injection_min_importance,
            "content_truncation_length": settings.memory_service.content_truncation_length,
            "importance_weight": settings.memory_service.importance_weight,
            "access_frequency_weight": settings.memory_service.access_frequency_weight,
            "default_search_limit": settings.memory_service.default_search_limit,
            "default_list_limit": settings.memory_service.default_list_limit,
            "vector_match_threshold": settings.memory_service.vector_match_threshold,
            "semantic_weight": settings.memory_service.semantic_weight,
            "keyword_weight": settings.memory_service.keyword_weight,
            "valid_memory_types": settings.memory_service.valid_memory_types,
        },
        # Summary service configuration (with DB overrides)
        "summary_service": {
            "enabled": all_prefs.get("summary", {}).get("enabled", settings.summary_service.enabled),
            "auto_summarize": all_prefs.get("summary", {}).get("auto_summarize", settings.summary_service.auto_summarize),
            "temperature": all_prefs.get("summary", {}).get("temperature", settings.summary_service.temperature),
            "max_tokens": all_prefs.get("summary", {}).get("max_tokens", settings.summary_service.max_tokens),
            "title_max_length": all_prefs.get("summary", {}).get("title_max_length", settings.summary_service.title_max_length),
            "key_points_max": all_prefs.get("summary", {}).get("key_points_max", settings.summary_service.key_points_max),
            "system_prompt_template": all_prefs.get("summary", {}).get(
                "system_prompt_template",
                settings.summary_service.system_prompt_template,
            ),
            "default_search_limit": all_prefs.get("summary", {}).get("default_search_limit", settings.summary_service.default_search_limit),
            "valid_summary_types": all_prefs.get("summary", {}).get("valid_summary_types", settings.summary_service.valid_summary_types),
        },
        # HTTP client settings
        "http_client": {
            "default_timeout": settings.http_client.default_timeout,
            "llm_timeout": settings.http_client.llm_timeout,
            "embedding_timeout": settings.http_client.embedding_timeout,
            "max_retries": settings.http_client.max_retries,
        },
        # WebSocket settings
        "websocket": {
            "connection_timeout": settings.websocket.connection_timeout,
            "document_processing_timeout": settings.websocket.document_processing_timeout,
            "image_processing_timeout": settings.websocket.image_processing_timeout,
            "max_message_size": settings.websocket.max_message_size,
            "max_binary_size": settings.websocket.max_binary_size,
        },
        # Security settings
        "security": {
            "bind_host": settings.security.bind_host,
            "bind_port": settings.security.bind_port,
            "allowed_origins": settings.security.allowed_origins,
            "cors_allow_credentials": settings.security.cors_allow_credentials,
            "cors_allow_methods": settings.security.cors_allow_methods,
            "cors_allow_headers": settings.security.cors_allow_headers,
            "auth_enabled": settings.security.auth_enabled,
            "api_key_required": settings.security.api_key_required,
            "allow_anonymous": settings.security.allow_anonymous,
            "allow_bearer_tokens": settings.security.allow_bearer_tokens,
            "default_role": settings.security.default_role,
            "default_user_id": settings.security.default_user_id,
            "allow_local_os_tools": settings.security.allow_local_os_tools,
            "allow_notebook_exec": settings.security.allow_notebook_exec,
            "rate_limit_enabled": settings.security.rate_limit_enabled,
            "rate_limit_requests_per_minute": settings.security.rate_limit_requests_per_minute,
            "public_paths": settings.security.public_paths,
        },
        # Voice/Audio settings (legacy stub)
        "voice": {
            "mic_button_enabled": True,
            "stt": {"provider": "dsm", "language": "auto"},
            "tts": {"provider": "dsm", "voice": "en_US/jenny"},
        },
        # UI settings (frontend can override with local config)
        "ui": {
            "widget_size": settings.ui.widget_size,
            "normal_width": settings.ui.normal_width,
            "normal_height": settings.ui.normal_height,
            "widget_margin": settings.ui.widget_margin,
            "update_interval": settings.ui.update_interval,
            "effects_mode": settings.ui.effects_mode,
            "visualizer_mode": settings.ui.visualizer_mode,
        },
        # Logging settings
        "logging": {
            "level": settings.monitoring.log_level,
            "console": True,
        },
        # Per-service AI provider overrides (user-configurable per service)
        # Each service: {provider, api_base, model, api_key}
        # Empty strings = use defaults (aether-inference for built-in services)
        "service_providers": all_prefs.get("service_providers", {
            "summary": {
                "provider": settings.summary_service.provider_config.provider,
                "api_base": settings.summary_service.provider_config.api_base,
                "model": settings.summary_service.provider_config.model,
                "api_key": settings.summary_service.provider_config.api_key,
            },
            "query_generation": {
                "provider": settings.proactive.query_generation.provider_config.provider,
                "api_base": settings.proactive.query_generation.provider_config.api_base,
                "model": settings.proactive.query_generation.provider_config.model,
                "api_key": settings.proactive.query_generation.provider_config.api_key,
            },
            "vision_ocr": {
                "provider": settings.vision_document.provider_config.provider,
                "api_base": settings.vision_document.provider_config.api_base,
                "model": settings.vision_document.provider_config.model,
                "api_key": settings.vision_document.provider_config.api_key,
            },
            "research": {
                "provider": settings.research_service.provider_config.provider,
                "api_base": settings.research_service.provider_config.api_base,
                "model": settings.research_service.provider_config.model,
                "api_key": settings.research_service.provider_config.api_key,
            },
        }),
        # User Profile settings
        "user_profile": {
            "name": settings.user_profile.name,
            "username": settings.user_profile.username,
        },
    }


# ========================================
# Response Schemas
# ========================================

class ServiceConfigResponse(BaseModel):
    """Service configuration (infrastructure settings)."""
    embedding_service: Dict[str, Any]
    http_client: Dict[str, Any]


class UserPreferencesResponse(BaseModel):
    """User-configurable preferences."""
    memory_injection: Dict[str, Any] = Field(
        description="Global memory injection settings"
    )
    search_defaults: Dict[str, Any] = Field(
        description="Search and retrieval defaults"
    )
    llm_generation: Dict[str, Any] = Field(
        description="LLM generation parameters"
    )
    summary: Dict[str, Any] = Field(
        description="Chat summarization settings"
    )


class SettingsMetadataResponse(BaseModel):
    """Metadata about settings (for UI rendering)."""
    field_name: str
    field_type: str
    current_value: Any
    default_value: Any
    description: str
    validation_rules: Dict[str, Any] = Field(default_factory=dict)
    ui_hints: Dict[str, Any] = Field(default_factory=dict)


# ========================================
# Endpoints
# ========================================

@router.post(
    "/",
    summary="Update user settings",
    description="Accepts partial updates and persists to database as JSONB. Only provided fields are saved.",
)
async def update_settings(
    updates: SettingsPatchRequest,
    settings: Settings = Depends(get_settings),
    gateway=Depends(get_database),
    _context: dict = Depends(setup_request_context),
    prefs_service: PreferencesService = Depends(get_preferences_service)
) -> Dict[str, Any]:
    """
    Update user settings (persists to database).
    
    Accepts partial updates - only provided fields are saved.
    Stored in user_preferences table as JSONB for flexibility.
    
    Args:
        updates: Settings updates (nested dict)
        
    Returns:
        Updated settings after merge
        
    Example payload:
        {
            "llm": {
                "model": "internvl3_5-2b",
                "api_base": "http://localhost:1234/v1"
            },
            "vision_document": {
                "vision_model": "internvl",
                "ocr_engine": "ocrmac"
            }
        }
    """
    try:
        updates_dict = updates.model_dump(exclude_none=True)
        user_id = _context.get("user_id") or settings.security.default_user_id
        
        # PRE-FLIGHT VALIDATION: Check all updates BEFORE persisting any
        # Fail-fast to prevent partial persistence on validation errors
        if (
            isinstance(updates_dict.get("integrations"), dict)
            and "aether_rag_sources" in updates_dict["integrations"]
            and not settings.security.allow_local_os_tools
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="aether_rag_sources settings updates are disabled by configuration (security.allow_local_os_tools=false)",
            )
        
        # Persist each top-level settings group to user_preferences
        saved_groups = []
        
        if "llm" in updates_dict:
            await prefs_service.set_preference(
                preference_key="llm_settings",
                preference_value=updates_dict["llm"],
                user_id=user_id
            )
            saved_groups.append("llm_settings")
            logger.info("Saved LLM settings: %s", updates_dict['llm'])
        
        if "vision_document" in updates_dict:
            await prefs_service.set_preference(
                preference_key="vision_document",
                preference_value=updates_dict["vision_document"],
                user_id=user_id
            )
            saved_groups.append("vision_document")
            logger.info("Saved vision settings: %s", updates_dict['vision_document'])
        
        if "interpreter" in updates_dict:
            await prefs_service.set_preference(
                preference_key="interpreter",
                preference_value=updates_dict["interpreter"],
                user_id=user_id
            )
            saved_groups.append("interpreter")
        
        # CRITICAL FIX: Save handsfree settings
        if "handsfree" in updates_dict:
            await prefs_service.set_preference(
                preference_key="handsfree",
                preference_value=updates_dict["handsfree"],
                user_id=user_id
            )
            saved_groups.append("handsfree")
            logger.info("Saved handsfree settings: %s", updates_dict['handsfree'])
        
        # CRITICAL FIX: Save memory settings
        if "memory" in updates_dict:
            await prefs_service.set_preference(
                preference_key="memory",
                preference_value=updates_dict["memory"],
                user_id=user_id
            )
            saved_groups.append("memory")
            logger.info("Saved memory settings: %s", updates_dict['memory'])
        
        # CRITICAL FIX: Save summary settings
        if "summary" in updates_dict:
            await prefs_service.set_preference(
                preference_key="summary",
                preference_value=updates_dict["summary"],
                user_id=user_id
            )
            saved_groups.append("summary")
            logger.info("Saved summary settings: %s", updates_dict['summary'])
        
        # CRITICAL FIX: Save integration settings (validation already done at function start)
        if "integrations" in updates_dict:
            await prefs_service.set_preference(
                preference_key="integrations",
                preference_value=updates_dict["integrations"],
                user_id=user_id
            )
            saved_groups.append("integrations")
            logger.info("Saved integration settings: %s", updates_dict['integrations'])

        # CRITICAL FIX: Save UI settings
        if "ui" in updates_dict:
            await prefs_service.set_preference(
                preference_key="ui",
                preference_value=updates_dict["ui"],
                user_id=user_id
            )
            saved_groups.append("ui")
            logger.info("Saved UI settings: %s", updates_dict['ui'])
        
        # Save embedding service settings (model selection from frontend)
        if "embedding_service" in updates_dict:
            await prefs_service.set_preference(
                preference_key="embedding_service",
                preference_value=updates_dict["embedding_service"],
                user_id=user_id
            )
            saved_groups.append("embedding_service")
            logger.info("Saved embedding service settings: %s", updates_dict['embedding_service'])

        # AGENT-FRIENDLY: Save security settings (allow_local_os_tools, etc.)
        # Required for browser history indexing, file indexing daemon
        if "security" in updates_dict:
            await prefs_service.set_preference(
                preference_key="security",
                preference_value=updates_dict["security"],
                user_id=user_id
            )
            saved_groups.append("security")
            logger.info("Saved security settings: %s", updates_dict['security'])
        
        # Per-service AI provider overrides (summary, query_gen, vision/ocr)
        # Each sub-key maps to a ServiceProviderConfig: {provider, api_base, model, api_key}
        if "service_providers" in updates_dict:
            await prefs_service.set_preference(
                preference_key="service_providers",
                preference_value=updates_dict["service_providers"],
                user_id=user_id
            )
            saved_groups.append("service_providers")
            logger.info("Saved service provider settings: %s", list(updates_dict['service_providers'].keys()))
            
        # User profile settings
        if "user_profile" in updates_dict:
            await prefs_service.set_preference(
                preference_key="user_profile",
                preference_value=updates_dict["user_profile"],
                user_id=user_id
            )
            saved_groups.append("user_profile")
            logger.info("Saved user profile settings: %s", updates_dict['user_profile'])
        
        # CRITICAL: Invalidate runtime settings cache to force reload
        from application.settings import get_runtime_settings_service
        get_runtime_settings_service().invalidate_cache()
        
        logger.info("Settings persisted: %s", saved_groups)
        
        # Return merged settings (with DB overrides applied)
        updated_settings = await get_runtime_settings_service().get_runtime_settings(gateway, user_id)
        return await _build_settings_response(updated_settings, prefs_service, user_id)
        
    except (HTTPException, DomainException):
        raise  # Re-raise HTTP exceptions (e.g. 403 from aether_rag_sources check) as-is
    except Exception as e:
        logger.error("Failed to persist settings: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save settings. Check server logs for details."
        )


@router.post("", include_in_schema=False)
async def update_settings_no_slash(
    updates: SettingsPatchRequest,
    settings: Settings = Depends(get_settings),
    gateway=Depends(get_database),
    _context: dict = Depends(setup_request_context),
    prefs_service: PreferencesService = Depends(get_preferences_service)
) -> Dict[str, Any]:
    """
    Back-compat: allow POST /v1/settings without trailing slash.
    """
    return await update_settings(updates, settings, gateway, _context, prefs_service)


async def _get_all_settings_response(
    settings: Settings,
    prefs_service: PreferencesService,
    user_id: str
) -> Dict[str, Any]:
    """
    Build and return the full settings response.
    """
    return await _build_settings_response(settings, prefs_service, user_id)


@router.get("", include_in_schema=False)
async def get_all_settings_no_slash(
    settings: Settings = Depends(get_runtime_settings),
    _context: dict = Depends(setup_request_context),
    prefs_service: PreferencesService = Depends(get_preferences_service)
) -> Dict[str, Any]:
    """
    Back-compat: allow /v1/settings without trailing slash.
    """
    try:
        user_id = _context.get("user_id") or settings.security.default_user_id
        return await _get_all_settings_response(settings, prefs_service, user_id)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get all settings: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get settings. Check server logs for details."
        )


@router.get("/", response_model=Dict[str, Any])
async def get_all_settings(
    settings: Settings = Depends(get_runtime_settings),
    _context: dict = Depends(setup_request_context),
    prefs_service: PreferencesService = Depends(get_preferences_service)
) -> Dict[str, Any]:
    """
    Get all settings (with DB overrides applied).
    
    Returns complete configuration including infrastructure and user preferences.
    
    CRITICAL FIX: Now loads ALL user preferences from DB (handsfree, memory, summary, etc.)
    not just llm_settings and vision_document.
    
    NOTE: Runtime settings cache is invalidated on startup/shutdown via
    invalidate_runtime_settings_cache() in application/settings/runtime_settings_service.py
    """
    try:
        user_id = _context.get("user_id") or settings.security.default_user_id
        return await _get_all_settings_response(settings, prefs_service, user_id)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get all settings: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get settings. Check server logs for details."
        )


@router.get("/user", response_model=UserPreferencesResponse)
async def get_user_preferences(
    settings: Settings = Depends(get_settings)
) -> UserPreferencesResponse:
    """
    Get user-configurable preferences.
    
    These settings can be modified by the user through the UI.
    """
    return UserPreferencesResponse(
        memory_injection={
            "enabled": settings.memory_service.global_injection_enabled,
            "limit": settings.memory_service.global_injection_limit,
            "min_importance": settings.memory_service.global_injection_min_importance,
            "content_truncation": settings.memory_service.content_truncation_length,
            "enabled_types": settings.memory_service.valid_memory_types,
        },
        search_defaults={
            "search_limit": settings.memory_service.default_search_limit,
            "list_limit": settings.memory_service.default_list_limit,
            "vector_threshold": settings.memory_service.vector_match_threshold,
            "semantic_weight": settings.memory_service.semantic_weight,
            "keyword_weight": settings.memory_service.keyword_weight,
        },
        llm_generation={
            "model": settings.llm.model,
            "summarizer_model": settings.llm.summarizer_model,
            "temperature": settings.llm.temperature,
            "max_tokens": settings.llm.max_tokens,
        },
        summary={
            "enabled": settings.summary_service.enabled,
            "auto_summarize": settings.summary_service.auto_summarize,
            "temperature": settings.summary_service.temperature,
            "max_tokens": settings.summary_service.max_tokens,
        }
    )


@router.get("/user/metadata", response_model=List[SettingsMetadataResponse])
async def get_user_settings_metadata(
    settings: Settings = Depends(get_settings)
) -> List[SettingsMetadataResponse]:
    """
    Get metadata about user settings (for UI rendering).
    
    Includes field types, validation rules, and UI hints for building the settings interface.
    """
    return [
        # Memory Injection Settings
        SettingsMetadataResponse(
            field_name="memory_injection_enabled",
            field_type="boolean",
            current_value=settings.memory_service.global_injection_enabled,
            default_value=True,
            description="Enable automatic injection of global memories into chat context",
            ui_hints={"widget": "toggle"}
        ),
        SettingsMetadataResponse(
            field_name="memory_injection_limit",
            field_type="integer",
            current_value=settings.memory_service.global_injection_limit,
            default_value=20,
            description="Maximum number of memories to inject",
            validation_rules={"min": 5, "max": 100},
            ui_hints={"widget": "slider", "step": 5}
        ),
        SettingsMetadataResponse(
            field_name="memory_importance_threshold",
            field_type="float",
            current_value=settings.memory_service.global_injection_min_importance,
            default_value=0.6,
            description="Minimum importance score for memory injection (0.0-1.0)",
            validation_rules={"min": 0.0, "max": 1.0},
            ui_hints={"widget": "slider", "step": 0.1, "precision": 1}
        ),
        SettingsMetadataResponse(
            field_name="memory_content_truncation",
            field_type="integer",
            current_value=settings.memory_service.content_truncation_length,
            default_value=200,
            description="Maximum character length for displayed memory content",
            validation_rules={"min": 50, "max": 500},
            ui_hints={"widget": "input"}
        ),
        
        # Search Settings
        SettingsMetadataResponse(
            field_name="search_default_limit",
            field_type="integer",
            current_value=settings.memory_service.default_search_limit,
            default_value=10,
            description="Default number of search results",
            validation_rules={"min": 5, "max": 50},
            ui_hints={"widget": "slider", "step": 5}
        ),
        SettingsMetadataResponse(
            field_name="vector_match_threshold",
            field_type="float",
            current_value=settings.memory_service.vector_match_threshold,
            default_value=0.5,
            description="Minimum similarity score for vector search (0.0-1.0)",
            validation_rules={"min": 0.0, "max": 1.0},
            ui_hints={"widget": "slider", "step": 0.1, "precision": 1}
        ),
        SettingsMetadataResponse(
            field_name="semantic_weight",
            field_type="float",
            current_value=settings.memory_service.semantic_weight,
            default_value=0.7,
            description="Weight for semantic similarity in hybrid search (0.0-1.0)",
            validation_rules={"min": 0.0, "max": 1.0},
            ui_hints={"widget": "slider", "step": 0.1, "precision": 1}
        ),
        
        # Summary Settings
        SettingsMetadataResponse(
            field_name="summary_auto_enabled",
            field_type="boolean",
            current_value=settings.summary_service.auto_summarize,
            default_value=False,  # Central config default: auto_summarize=False (user must opt in)
            description="Automatically summarize chats after each conversation turn",
            ui_hints={"widget": "toggle"}
        ),
        SettingsMetadataResponse(
            field_name="summary_temperature",
            field_type="float",
            current_value=settings.summary_service.temperature,
            default_value=0.3,
            description="LLM temperature for summary generation (0.0-2.0)",
            validation_rules={"min": 0.0, "max": 2.0},
            ui_hints={"widget": "slider", "step": 0.1, "precision": 1}
        ),
        SettingsMetadataResponse(
            field_name="summary_max_tokens",
            field_type="integer",
            current_value=settings.summary_service.max_tokens,
            default_value=500,
            description="Maximum tokens for summary generation",
            validation_rules={"min": 100, "max": 2000},
            ui_hints={"widget": "slider", "step": 100}
        ),
        
        # LLM Settings
        SettingsMetadataResponse(
            field_name="llm_supports_vision",
            field_type="boolean",
            current_value=settings.llm.supports_vision,
            default_value=True,
            description="Enable vision capabilities for the LLM (images sent directly to model)",
            ui_hints={"widget": "toggle"}
        ),
        SettingsMetadataResponse(
            field_name="llm_temperature",
            field_type="float",
            current_value=settings.llm.temperature,
            default_value=0.7,
            description="Default LLM temperature for generation (0.0-2.0)",
            validation_rules={"min": 0.0, "max": 2.0},
            ui_hints={"widget": "slider", "step": 0.1, "precision": 1}
        ),
        SettingsMetadataResponse(
            field_name="llm_max_tokens",
            field_type="integer",
            current_value=settings.llm.max_tokens,
            default_value=4096,
            description="Maximum tokens for LLM generation",
            validation_rules={"min": 100, "max": 4096},
            ui_hints={"widget": "slider", "step": 256}
        ),
        
        # Vision & Document Processing Settings
        SettingsMetadataResponse(
            field_name="vision_model",
            field_type="string",
            current_value=settings.vision_document.vision_model,
            default_value="internvl",
            description="Vision model identifier for image analysis (used when LLM doesn't support vision)",
            ui_hints={"widget": "select", "options_source": "/v1/models", "options_key": "models"}
        ),
        SettingsMetadataResponse(
            field_name="vision_model_lmstudio",
            field_type="string",
            current_value=settings.vision_document.vision_model_lmstudio,
            default_value="internvl3_5-2b",
            description="LM Studio model name for vision processing",
            ui_hints={"widget": "input"}
        ),
        SettingsMetadataResponse(
            field_name="ocr_engine",
            field_type="string",
            current_value=settings.vision_document.ocr_engine,
            default_value=settings.vision_document.ocr_engine,
            description="OCR engine for document text extraction (fetch options from /v1/document/health)",
            ui_hints={"widget": "select", "options_source": "/v1/document/health", "options_key": "ocr_engine_options"}
        ),
        SettingsMetadataResponse(
            field_name="ocr_languages",
            field_type="string",
            current_value=settings.vision_document.ocr_languages,
            default_value="en",
            description="Comma-separated language codes for OCR (e.g., 'en,fr,de')",
            ui_hints={"widget": "input"}
        ),
        SettingsMetadataResponse(
            field_name="enable_picture_description",
            field_type="boolean",
            current_value=settings.vision_document.enable_picture_description,
            default_value=True,
            description="Enable automatic image description in documents",
            ui_hints={"widget": "toggle"}
        ),
        SettingsMetadataResponse(
            field_name="doc_output_format",
            field_type="string",
            current_value=settings.vision_document.output_format,
            default_value="markdown",
            description="Output format for processed documents",
            ui_hints={"widget": "select", "options_source": "/v1/document/health", "options_key": "output_format_options"}
        ),
    ]


@router.get("/infrastructure", response_model=ServiceConfigResponse)
async def get_infrastructure_settings(
    settings: Settings = Depends(get_settings)
) -> ServiceConfigResponse:
    """
    Get infrastructure settings (read-only, rarely changed).
    
    These settings are typically configured via environment variables or config files.
    """
    # Build dynamic embedding model options from config (SSOT)
    embedding_model_options = [
        {
            "value": settings.embedding_service.model,
            "label": f"{settings.embedding_service.model.split('/')[-1]} — Fast (default)",
            "dimensions": settings.embedding_service.dimensions,
            "description": "Primary ONNX embedding model (Perplexica Docker)",
        },
    ]
    # Add quality model if different from primary
    if settings.embedding_service.quality_model != settings.embedding_service.model:
        embedding_model_options.append({
            "value": settings.embedding_service.quality_model,
            "label": f"{settings.embedding_service.quality_model.split('/')[-1]} — Higher quality",
            "dimensions": settings.embedding_service.quality_dimensions,
            "description": "Quality ONNX embedding model (higher dimensions)",
        })

    return ServiceConfigResponse(
        embedding_service={
            "enabled": settings.embedding_service.enabled,
            "url": settings.embedding_service.service_url,
            "model": settings.embedding_service.model,
            "quality_model": settings.embedding_service.quality_model,
            "dimensions": settings.embedding_service.dimensions,
            "quality_dimensions": settings.embedding_service.quality_dimensions,
            "timeout_seconds": settings.embedding_service.timeout_seconds,
            "embedding_model_options": embedding_model_options,
        },
        http_client={
            "default_timeout": settings.http_client.default_timeout,
            "llm_timeout": settings.http_client.llm_timeout,
            "embedding_timeout": settings.http_client.embedding_timeout,
            "external_service_timeout": settings.http_client.external_service_timeout,
            "max_retries": settings.http_client.max_retries,
            "retry_backoff_factor": settings.http_client.retry_backoff_factor,
        }
    )


@router.get(
    "/profiles",
    summary="List Open Interpreter profiles",
    description="Returns available profile names and the current default profile.",
)
async def list_profiles() -> Dict[str, Any]:
    """List available Open Interpreter profiles."""
    from core.profiles.manager import ProfileManager
    
    try:
        pm = ProfileManager()
        profiles = pm.list_profile_names()
        return {
            "profiles": profiles,
            "default": pm.get_default_profile()
        }
    except Exception as e:
        logger.error("Failed to list profiles: %s", e)
        return {
            "profiles": ["GURU.yaml"],  # Fallback to default
            "default": "GURU.yaml"
        }


@router.get(
    "/health",
    summary="Settings health check",
    description="Validates that all critical settings are loaded correctly.",
)
async def settings_health_check(
    settings: Settings = Depends(get_settings)
) -> Dict[str, Any]:
    """
    Health check for settings system.
    
    Validates that all settings are loaded correctly.
    """
    try:
        # Validate critical settings
        critical_checks = {
            "settings_loaded": True,
            "embedding_service_configured": settings.embedding_service.service_url is not None,
            "memory_service_configured": settings.memory_service.valid_memory_types is not None,
            "summary_service_configured": settings.summary_service.enabled is not None,
            "llm_configured": settings.llm.model is not None,
        }
        
        all_healthy = all(critical_checks.values())
        
        return {
            "status": "healthy" if all_healthy else "degraded",
            "checks": critical_checks,
            "environment": settings.environment,
            "app_version": settings.app_version,
        }
    except Exception as e:
        logger.error("Settings health check failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Settings health check failed. Check server logs for details."
        )
