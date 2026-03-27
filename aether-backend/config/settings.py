"""
@.architecture
Incoming: config.manager.get_settings()
Processing: Facade to expose typed Settings and schemas for backward compatibility
Outgoing: api/dependencies.get_settings(), runtime modules --- {Settings, Dict[str, Any]}
"""

# Import the main settings class and loaders
from config.manager import (
    TomlConfigSettingsSource,
    Settings,
    get_settings,
    reload_settings,
    is_development,
    is_production,
    is_test,
)

# Re-export AudioConfig
from config.audio_config import AudioConfig

# Re-export core schemas
from config.schemas.core import (
    _load_env_file,
    _load_local_env_defaults,
    _parse_bool_env,
    _parse_list_env,
    _parse_json_list_env,
    get_app_root,
    get_bundle_root,
    get_install_root,
    _resolve_inference_venv,
    _resolve_inference_models_dir,
    AetherBaseSettings,
    _parse_comma_list,
    _parse_json_list,
)

# Re-export AI & Inference models
from config.schemas.ai import (
    ServiceProviderConfig,
    LLMSettings,
    ComputerAPISettings,
    ErrorHandlingSettings,
    ContextRetrievalSettings,
    _get_default_oi_venv,
    _get_default_oi_wrapper,
    InterpreterSettings,
    VisionDocumentSettings,
    _get_default_inference_venv,
    _get_default_inference_models_dir,
    InferenceSettings,
    _AGENT_GENERATION_DEFAULTS,
)

# Re-export Data & Memory models
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

# Re-export Network & Security models
from config.schemas.network import (
    _build_security_overrides_from_env,
    APIKeySettings,
    RateLimitTierSettings,
    RateLimitRuleSettings,
    SecuritySettings,
    WebSocketSettings,
    HTTPClientSettings,
)

# Re-export Integrations & Sources models
from config.schemas.integrations import (
    SlackSourceSettings,
    BrowserHistorySourceSettings,
    EmailSourceSettings,
    AetherRagSearchSettings,
    AetherRagSourcesSettings,
    IntegrationSettings,
)

# Re-export Proactive & Worker models
from config.schemas.proactive import (
    JobQueueSettings,
    QueryGenerationDaemonSettings,
    ProactiveDaemonsSettings,
    ProactiveCleanupSettings,
    BrowserDaemonSettings,
    EmailDaemonSettings,
    FileSystemDaemonSettings,
    ProactiveAgentWorkerSettings,
    ProactiveSettings,
    WorkerSettings,
)

# Re-export App, UI, & Services models
from config.schemas.app import (
    AgentUiSettings,
    UiSettings,
    UserProfileSettings,
    SummaryServiceSettings,
    ResearchServiceSettings,
    ContextExportSettings,
)

__all__ = [
    # Main manager components
    "TomlConfigSettingsSource",
    "Settings",
    "get_settings",
    "reload_settings",
    "is_development",
    "is_production",
    "is_test",
    "AudioConfig",
    
    # Core
    "_load_env_file",
    "_load_local_env_defaults",
    "_parse_bool_env",
    "_parse_list_env",
    "_parse_json_list_env",
    "get_app_root",
    "get_bundle_root",
    "get_install_root",
    "_resolve_inference_venv",
    "_resolve_inference_models_dir",
    "AetherBaseSettings",
    "_parse_comma_list",
    "_parse_json_list",
    
    # AI
    "ServiceProviderConfig",
    "LLMSettings",
    "ComputerAPISettings",
    "ErrorHandlingSettings",
    "ContextRetrievalSettings",
    "_get_default_oi_venv",
    "_get_default_oi_wrapper",
    "InterpreterSettings",
    "VisionDocumentSettings",
    "_get_default_inference_venv",
    "_get_default_inference_models_dir",
    "InferenceSettings",
    "_AGENT_GENERATION_DEFAULTS",
    
    # Data
    "RedisSettings",
    "SupabaseSettings",
    "MonitoringSettings",
    "DatabaseSettings",
    "MemorySettings",
    "EmbeddingSettings",
    "EmbeddingServiceSettings",
    "MemoryServiceSettings",
    
    # Network
    "_build_security_overrides_from_env",
    "APIKeySettings",
    "RateLimitTierSettings",
    "RateLimitRuleSettings",
    "SecuritySettings",
    "WebSocketSettings",
    "HTTPClientSettings",
    
    # Integrations
    "SlackSourceSettings",
    "BrowserHistorySourceSettings",
    "EmailSourceSettings",
    "AetherRagSearchSettings",
    "AetherRagSourcesSettings",
    "IntegrationSettings",
    
    # Proactive
    "JobQueueSettings",
    "QueryGenerationDaemonSettings",
    "ProactiveDaemonsSettings",
    "ProactiveCleanupSettings",
    "BrowserDaemonSettings",
    "EmailDaemonSettings",
    "FileSystemDaemonSettings",
    "ProactiveAgentWorkerSettings",
    "ProactiveSettings",
    "WorkerSettings",
    
    # App
    "AgentUiSettings",
    "UiSettings",
    "UserProfileSettings",
    "SummaryServiceSettings",
    "ResearchServiceSettings",
    "ContextExportSettings",
]
