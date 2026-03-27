import logging
import os
from pathlib import Path
from typing import Dict, Any

from pydantic import Field, field_validator, model_validator
from pydantic_settings import SettingsConfigDict, PydanticBaseSettingsSource

from utils.config import load_config as load_toml_config
from config.audio_config import AudioConfig

# Core imports
from config.schemas.core import (
    _load_local_env_defaults,
    AetherBaseSettings,
    get_app_root,
    get_bundle_root,
)

# AI schemas
from config.schemas.ai import (
    LLMSettings,
    InterpreterSettings,
    VisionDocumentSettings,
    InferenceSettings,
    ServiceProviderConfig,
)

# Network schemas
from config.schemas.network import (
    SecuritySettings,
    WebSocketSettings,
    HTTPClientSettings,
)

# Data schemas
from config.schemas.data import (
    RedisSettings,
    SupabaseSettings,
    MonitoringSettings,
    DatabaseSettings,
    MemorySettings,
    EmbeddingSettings,
    EmbeddingServiceSettings,
    MemoryServiceSettings,
)

# Integrations schemas
from config.schemas.integrations import IntegrationSettings

# Proactive schemas
from config.schemas.proactive import (
    ProactiveSettings,
    WorkerSettings,
)

# App schemas
from config.schemas.app import (
    AgentUiSettings,
    UiSettings,
    UserProfileSettings,
    SummaryServiceSettings,
    ResearchServiceSettings,
    ContextExportSettings,
)

class TomlConfigSettingsSource(PydanticBaseSettingsSource):
    def get_field_value(self, field, field_name, field_alias):
        return None, None, False

    def prepare_field_value(self, field_name, field, value, value_is_complex):
        return value

    def __call__(self) -> Dict[str, Any]:
        try:
            toml_config = load_toml_config()
        except Exception:
            toml_config = {}

        models = toml_config.get("MODELS", {})
        providers = toml_config.get("PROVIDERS", {})
        oi_config = toml_config.get("OPEN_INTERPRETER", {})
        vision_cfg = toml_config.get("VISION_DOCUMENT", {})
        embeddings_cfg = toml_config.get("EMBEDDINGS", {})
        inference_cfg = toml_config.get("INFERENCE", {})

        mapped = {}

        if models and providers:
            mapped["llm"] = {
                "provider": "aether_inference",
                "api_base": providers.get("aether_inference_url"),
                "api_key": providers.get("aether_inference_api_key"),
                "model": models.get("primary_chat_model"),
                "embedding_model": models.get("primary_embedding_model"),
                "supports_vision": oi_config.get("supports_vision"),
                "context_window": oi_config.get("context_window"),
                "max_tokens": oi_config.get("max_tokens"),
            }

        if vision_cfg or models.get("vision_model"):
            mapped["vision_document"] = {
                "vision_model": vision_cfg.get("vision_model"),
                "vision_model_lmstudio": vision_cfg.get("vision_model_lmstudio") or models.get("vision_model"),
                "ocr_engine": vision_cfg.get("ocr_engine"),
                "ocr_languages": vision_cfg.get("ocr_languages"),
                "enable_code_enrichment": vision_cfg.get("enable_code_enrichment"),
                "enable_formula_enrichment": vision_cfg.get("enable_formula_enrichment"),
                "enable_picture_classification": vision_cfg.get("enable_picture_classification"),
                "enable_picture_description": vision_cfg.get("enable_picture_description"),
                "output_format": vision_cfg.get("output_format"),
                "max_tokens": vision_cfg.get("max_tokens"),
                "temperature": vision_cfg.get("temperature"),
            }

        if providers:
            mapped["integrations"] = {
                "perplexica_url": providers.get("perplexica_url"),
                "searxng_url": providers.get("searxng_url"),
                "xlwings_base_dir": providers.get("xlwings_base_dir"),
                "lm_studio_url": providers.get("lm_studio_url"),
                "openrouter_url": providers.get("openrouter_url"),
                "aether_rag_mcp_command": providers.get("aether_rag_mcp_command"),
                "aether_rag_mcp_args": providers.get("aether_rag_mcp_args"),
                "aether_rag_sources": {
                    "enabled": providers.get("aether_rag_sources_enabled"),
                    "index_root_dir": providers.get("aether_rag_sources_index_root_dir"),
                    "slack": {
                        "enabled": providers.get("slack_enabled"),
                        "mcp_command": providers.get("slack_mcp_command"),
                        "default_index_name": providers.get("slack_default_index_name"),
                        "concatenate_conversations": providers.get("slack_concatenate_conversations"),
                        "max_messages_per_channel": providers.get("slack_max_messages_per_channel"),
                        "max_retries": providers.get("slack_max_retries"),
                        "retry_delay_seconds": providers.get("slack_retry_delay_seconds"),
                    },
                    "browser_history": {
                        "enabled": providers.get("browser_history_enabled"),
                        "default_index_name": providers.get("browser_history_default_index_name"),
                        "browser": providers.get("browser_history_browser"),
                        "profile_path": providers.get("browser_history_profile_path"),
                        "auto_find_profiles": providers.get("browser_history_auto_find_profiles"),
                        "user_data_dir": providers.get("browser_history_user_data_dir") or providers.get("browser_history_chrome_base_path"),
                        "max_items": providers.get("browser_history_max_items"),
                    },
                    "email": {
                        "enabled": providers.get("email_enabled"),
                        "default_index_name": providers.get("email_default_index_name"),
                        "source_path": providers.get("email_source_path"),
                        "max_items": providers.get("email_max_items"),
                    },
                    "search": {
                        "mode": providers.get("search_mode"),
                        "hybrid_semantic_weight": providers.get("search_hybrid_semantic_weight"),
                        "hybrid_sparse_weight": providers.get("search_hybrid_sparse_weight"),
                        "rrf_k": providers.get("search_rrf_k"),
                    },
                }
            }

        if oi_config:
            mapped["interpreter"] = {
                "auto_run": oi_config.get("auto_run"),
                "loop": oi_config.get("loop"),
                "safe_mode": oi_config.get("safe_mode"),
                "offline": oi_config.get("offline"),
                "disable_telemetry": oi_config.get("disable_telemetry"),
                "external_server_enabled": oi_config.get("external_server_enabled"),
                "external_server_url": oi_config.get("external_server_url"),
                "external_server_auth": oi_config.get("external_server_auth"),
                "external_server_per_chat": oi_config.get("external_server_per_chat"),
                "external_server_host": oi_config.get("external_server_host"),
                "external_server_port_min": oi_config.get("external_server_port_min"),
                "external_server_port_max": oi_config.get("external_server_port_max"),
                "external_server_max_servers": oi_config.get("external_server_max_servers"),
                "external_server_ttl_seconds": oi_config.get("external_server_ttl_seconds"),
                "external_server_startup_timeout_seconds": oi_config.get("external_server_startup_timeout_seconds"),
                "external_server_venv_python": oi_config.get("external_server_venv_python"),
                "external_server_wrapper_script": oi_config.get("external_server_wrapper_script"),
            }
            # Load GURU.yaml system message
            try:
                import yaml
                guru_path = (Path(__file__).resolve().parent.parent / "core" / "profiles" / "templates" / "GURU.yaml").resolve()
                if guru_path.exists():
                    with open(guru_path, "r", encoding="utf-8") as f:
                        data = yaml.safe_load(f) or {}
                    if sys_msg := data.get("system_message"):
                        mapped["interpreter"]["system_message"] = sys_msg.strip()
            except Exception:
                pass

        if embeddings_cfg:
            mapped["embeddings"] = {
                "provider": embeddings_cfg.get("primary_provider"),
                "model": embeddings_cfg.get("primary_model"),
                "api_base": embeddings_cfg.get("primary_api_base"),
                "api_key": embeddings_cfg.get("primary_api_key"),
                "dimensions": embeddings_cfg.get("primary_dimensions"),
                "timeout_seconds": embeddings_cfg.get("timeout_seconds"),
                "fallback_provider": embeddings_cfg.get("fallback_provider"),
                "fallback_model": embeddings_cfg.get("fallback_model"),
                "fallback_api_base": embeddings_cfg.get("fallback_api_base"),
                "fallback_api_key": embeddings_cfg.get("fallback_api_key"),
                "fallback_dimensions": embeddings_cfg.get("fallback_dimensions"),
                "fallback_app_name": embeddings_cfg.get("fallback_app_name"),
                "fallback_site_url": embeddings_cfg.get("fallback_site_url"),
            }

        if inference_cfg:
            mapped["inference"] = {
                "enabled": inference_cfg.get("enabled"),
                "port": inference_cfg.get("port"),
                "auto_start": inference_cfg.get("auto_start"),
                "default_model": inference_cfg.get("default_model"),
                "default_text_model": inference_cfg.get("default_text_model"),
                "default_vision_model": inference_cfg.get("default_vision_model"),
                "health_check_interval": inference_cfg.get("health_check_interval"),
                "venv_path": inference_cfg.get("venv_path"),
                "models_dir": inference_cfg.get("models_dir"),
                "idle_timeout": inference_cfg.get("idle_timeout"),
            }

        # Strip None values at all nested levels
        def strip_nones(d):
            if isinstance(d, dict):
                return {k: strip_nones(v) for k, v in d.items() if v is not None and strip_nones(v) is not None}
            return d
            
        return strip_nones(mapped)


class Settings(AetherBaseSettings):

    """
    Main application settings.
    
    Loads configuration from:
    1. TOML config file (models_config.toml)
    2. Environment variables (prefixed by section)
    3. Defaults defined in schemas
    
    Priority: Environment variables > TOML config > Defaults
    """
    @classmethod
    def settings_customise_sources(
        cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
    ):
        return (
            env_settings,
            dotenv_settings,
            TomlConfigSettingsSource(settings_cls),
            init_settings,
        )

    app_name: str = "Aether Backend"
    app_version: str = "2.0.0"
    environment: str = "development"  # development|production|test
    
    # Application root directory (for logs, data, local.env)
    app_root: Path = Field(default_factory=get_app_root)
    
    # Bundle root directory (for models.toml, bundled assets)
    bundle_root: Path = Field(default_factory=get_bundle_root)
    
    # Config directory (for loading YAML files)
    config_dir: Path = Field(
        default_factory=lambda: Path(__file__).parent,
        description="Directory containing config files"
    )
    
    llm: LLMSettings = Field(default_factory=LLMSettings)
    interpreter: InterpreterSettings = Field(default_factory=InterpreterSettings)
    security: SecuritySettings = Field(default_factory=SecuritySettings)
    redis: RedisSettings = Field(default_factory=RedisSettings)
    supabase: SupabaseSettings = Field(default_factory=SupabaseSettings)
    monitoring: MonitoringSettings = Field(default_factory=MonitoringSettings)
    integrations: IntegrationSettings = Field(default_factory=IntegrationSettings)
    memory: MemorySettings = Field(default_factory=MemorySettings)
    embeddings: EmbeddingSettings = Field(default_factory=EmbeddingSettings)
    workers: WorkerSettings = Field(default_factory=WorkerSettings)
    agent_ui: AgentUiSettings = Field(default_factory=AgentUiSettings)
    ui: UiSettings = Field(default_factory=UiSettings)
    
    # New comprehensive service configurations
    vision_document: VisionDocumentSettings = Field(default_factory=VisionDocumentSettings)
    websocket: WebSocketSettings = Field(default_factory=WebSocketSettings)
    embedding_service: EmbeddingServiceSettings = Field(default_factory=EmbeddingServiceSettings)
    http_client: HTTPClientSettings = Field(default_factory=HTTPClientSettings)
    memory_service: MemoryServiceSettings = Field(default_factory=MemoryServiceSettings)
    summary_service: SummaryServiceSettings = Field(default_factory=SummaryServiceSettings)
    research_service: ResearchServiceSettings = Field(default_factory=ResearchServiceSettings)
    context_export: ContextExportSettings = Field(default_factory=ContextExportSettings)
    audio: AudioConfig = Field(default_factory=AudioConfig)
    inference: InferenceSettings = Field(default_factory=InferenceSettings)
    proactive: ProactiveSettings = Field(default_factory=ProactiveSettings)
    user_profile: UserProfileSettings = Field(default_factory=UserProfileSettings)
    
    @property
    def base_url(self) -> str:
        """
        Backend self-reference URL (for internal service-to-service calls).
        
        ARCHITECTURE:
        - bind_host (127.0.0.1): Where server LISTENS (loopback only for desktop)
        - base_url (127.0.0.1): Where services make INTERNAL calls (must be routable)
        
        If bind_host is 0.0.0.0 or ::, internal calls MUST use 127.0.0.1.
        Otherwise use the actual bind_host (for specific interface binding).
        """
        # For internal calls, 0.0.0.0 and :: are non-routable - map to 127.0.0.1
        host = self.security.bind_host
        if host in {"0.0.0.0", "::"}:
            host = "127.0.0.1"
        return f"http://{host}:{self.security.bind_port}"

    @property
    def mesh_base_url(self) -> str:
        """
        Backend reference URL for services running inside Docker MESH.
        
        ARCHITECTURE:
        - Inside Docker, 'localhost' or '127.0.0.1' refers to the container.
        - To reach the host machine, we MUST use 'host.docker.internal'.
        """
        host = self.security.bind_host
        # If bound to localhost or all interfaces, swap to mesh-aware hostname
        if host in {"0.0.0.0", "::", "127.0.0.1", "localhost"}:
            host = "host.docker.internal"
        return f"http://{host}:{self.security.bind_port}"

    @property
    def inference_url(self) -> str:
        """
        Aether Inference server URL (for internal service-to-service calls).
        
        Uses 127.0.0.1 (not localhost) for consistency with base_url pattern.
        Port from central config (default 7090).
        """
        return f"http://127.0.0.1:{self.inference.port}/v1"

    def resolve_service_provider(
        self,
        config: "ServiceProviderConfig",
        service_type: str = "text",
    ) -> tuple:
        """
        Resolve a per-service provider config into (api_base, model, api_key).

        Args:
            config: The ServiceProviderConfig for the service.
            service_type: Controls default model selection:
                "agent"  — Main agent model (Qwen3): chat, proactive pipeline, query gen
                "text"   — Lightweight text model (LFM): summarization, simple extraction
                "vision" — Vision model (LFM VL / GLM-OCR): image understanding, OCR

        Returns:
            (api_base: str, model: str, api_key: str) ready for HTTP calls.

        Resolution:
          provider=""                  -> aether_inference defaults from central config
          provider="aether_inference"  -> aether_inference with explicit overrides
          provider="openai-compatible" -> config.api_base or settings.llm.api_base
          provider="ollama"            -> config.api_base or settings.integrations.ollama_url fallback
        
        Model selection (NO hardcoded model names):
          agent:  inference.default_model -> llm.model (Qwen3 — primary reasoning)
          text:   inference.default_text_model -> llm.summarizer_model -> llm.model (LFM)
          vision: inference.default_vision_model -> inference.default_model (platform-resolved)
        """
        provider = (config.provider or "").strip().lower()

        # Resolve default model from central config -- NEVER hardcode model names
        if service_type == "vision":
            _default_model = (
                self.inference.default_vision_model
                or self.inference.default_model
                or ""
            )
        elif service_type == "agent":
            # Main agent model (Qwen3) — for primary chat, proactive pipeline,
            # query generation, and any task requiring strong reasoning.
            _default_model = (
                self.inference.default_model
                or self.llm.model
            )
        else:
            # Lightweight text model (LFM) — for summarization and other
            # simple text tasks where speed matters more than reasoning depth.
            _default_model = (
                self.inference.default_text_model
                or self.llm.summarizer_model
                or self.llm.model
            )

        if provider in ("", "aether_inference"):
            api_base = config.api_base or self.inference_url
            model = config.model or _default_model
            api_key = config.api_key or "not-needed"
            return (api_base, model, api_key)

        if provider == "ollama":
            api_base = config.api_base or "http://127.0.0.1:11434/v1"
            model = config.model or self.llm.model
            api_key = config.api_key or "not-needed"
            return (api_base, model, api_key)

        # openai-compatible or any other string -> fall through to LLM settings
        api_base = config.api_base or self.llm.api_base
        model = config.model or self.llm.model
        api_key = config.api_key or self.llm.api_key
        return (api_base, model, api_key)

    @property
    def database(self) -> DatabaseSettings:
        """
        Sanitized database settings derived from Supabase configuration.

        Exposes only metadata required by frontend clients without leaking credentials.
        """
        pool_size = int(os.getenv("DATABASE_POOL_SIZE", "10"))
        max_overflow = int(os.getenv("DATABASE_MAX_OVERFLOW", "20"))
        pool_timeout = int(os.getenv("DATABASE_POOL_TIMEOUT", "30"))
        echo_sql = os.getenv("DATABASE_ECHO_SQL", "false").lower() == "true"

        return DatabaseSettings(
            provider="supabase",
            url=self.supabase.url,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_timeout=pool_timeout,
            echo_sql=echo_sql,
        )
    
    @field_validator('environment')
    @classmethod
    def validate_environment(cls, v: str) -> str:
        """Validate environment value."""
        allowed = ['development', 'production', 'test']
        if v not in allowed:
            raise ValueError(f"Environment must be one of {allowed}")
        return v
    
    @model_validator(mode='after')
    def apply_inference_defaults(self) -> 'Settings':
        # Propagate the resolved inference model name to llm.model so the
        # settings API returns a model name that matches the inference server's /models output.
        if self.inference and self.inference.default_model:
            self.llm.model = self.inference.default_model

        # -- Auto-resolve default model names from models_dir (dev-mode fallback) --
        # In production, start_production.sh exports INFERENCE_DEFAULT_*_MODEL.
        # In dev mode, scan models_dir for known patterns if not explicitly set.
        if self.inference and self.inference.models_dir:
            models_dir = Path(self.inference.models_dir)
            if models_dir.is_dir():
                _local_models = []
                for org_dir in models_dir.iterdir():
                    if org_dir.is_dir() and not org_dir.name.startswith("."):
                        for model_dir in org_dir.iterdir():
                            if model_dir.is_dir() and not model_dir.name.startswith("."):
                                has_hf = (model_dir / "config.json").exists() and (
                                    any(model_dir.glob("*.safetensors")) or any(model_dir.glob("*.bin"))
                                )
                                has_gguf = any(model_dir.glob("*.gguf"))
                                if has_hf or has_gguf:
                                    _local_models.append(f"{org_dir.name}/{model_dir.name}")
                
                for mid in _local_models:
                    if "GLM-OCR" in mid:
                        if not self.vision_document.provider_config.model:
                            self.vision_document.provider_config.model = mid
                    elif "VL" in mid and ("LFM" in mid or "lfm" in mid):
                        if not self.inference.default_vision_model:
                            self.inference.default_vision_model = mid
                    elif ("LFM2.5-1.2B" in mid or "LFM2-1.2B" in mid):
                        if not self.inference.default_text_model:
                            self.inference.default_text_model = mid
                    elif ("qwen3" in mid.lower() and "4b" in mid.lower() and "3.5" not in mid):
                        if not self.inference.default_model:
                            self.inference.default_model = mid
                            self.llm.model = mid  # Apply propagation immediately

        return self

    model_config = SettingsConfigDict(env_prefix="AETHER_", case_sensitive=False)


# =============================================================================
# Settings Loader
# =============================================================================

# CRITICAL: No @lru_cache() here - settings must reload on file changes.
# Caching is handled at runtime level in runtime_settings_service.py with explicit invalidation.

def get_settings() -> Settings:
    """
    Load and return application settings.
    
    Priority: Environment variables > TOML config > Defaults
    """
    logger = logging.getLogger(__name__)
    logger.debug("get_settings() called - loading fresh from disk")
    
    # Load local env defaults first (dev/test) so env overrides are present.
    _load_local_env_defaults()
    
    # Expose inference OCR model dynamically to VISION_DOC_SVC_PROVIDER_MODEL if present
    # This allows it to cleanly cascade without tight coupling.
    ocr_model = os.getenv("INFERENCE_DEFAULT_OCR_MODEL")
    if ocr_model:
        os.environ.setdefault("VISION_DOC_SVC_PROVIDER_MODEL", ocr_model)
    
    return Settings()

def reload_settings() -> Settings:
    return get_settings()

# =============================================================================
# Environment-specific Helpers
# =============================================================================

def is_development() -> bool:
    """Check if running in development environment."""
    return get_settings().environment == "development"


def is_production() -> bool:
    """Check if running in production environment."""
    return get_settings().environment == "production"


def is_test() -> bool:
    """Check if running in test environment."""
    return get_settings().environment == "test"
