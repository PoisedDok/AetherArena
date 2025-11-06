"""
Settings Management

Pydantic-based settings schema with environment variable support.
Integrates with existing TOML config and provides type-safe access.

@.architecture
Incoming: utils/config.py, Environment variables, models_config.toml, api/dependencies.py --- {Dict from load_toml_config, str from os.getenv, TOML config dict, get_settings calls}
Processing: get_settings(), reload_settings(), Settings.__init__(), field_validator() --- {4 jobs: configuration_loading, environment_variable_merging, schema_validation, caching}
Outgoing: api/dependencies.py, app.py, api/v1/endpoints/*.py, core/runtime/engine.py --- {Settings Pydantic model with typed config sections}
"""

import os
from pathlib import Path
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field, field_validator
from functools import lru_cache

from utils.config import load_config as load_toml_config


# =============================================================================
# Settings Schemas
# =============================================================================

class LLMSettings(BaseModel):
    """LLM provider settings."""
    provider: str = "openai-compatible"
    api_base: str = "http://localhost:1234/v1"
    api_key: str = "not-needed"
    model: str = "qwen/qwen3-4b-2507"
    supports_vision: bool = True
    context_window: int = 100000
    max_tokens: int = 4096
    temperature: float = 0.7
    
    class Config:
        env_prefix = "LLM_"


class InterpreterSettings(BaseModel):
    """Open Interpreter settings."""
    auto_run: bool = False
    loop: bool = False
    safe_mode: str = "off"  # off|ask|auto
    system_message: str = ""
    profile: str = "GURU.py"
    offline: bool = True
    disable_telemetry: bool = True
    
    class Config:
        env_prefix = "INTERPRETER_"


class SecuritySettings(BaseModel):
    """Security configuration."""
    bind_host: str = "127.0.0.1"
    bind_port: int = 8765
    allowed_origins: List[str] = Field(
        default_factory=lambda: [
            "http://localhost",
            "http://127.0.0.1",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )
    cors_allow_credentials: bool = True
    cors_allow_methods: List[str] = Field(default_factory=lambda: ["*"])
    cors_allow_headers: List[str] = Field(default_factory=lambda: ["*"])
    
    # Authentication (future)
    auth_enabled: bool = False
    auth_secret_key: Optional[str] = None
    
    # Rate limiting
    rate_limit_enabled: bool = False
    rate_limit_requests_per_minute: int = 60
    
    class Config:
        env_prefix = "SECURITY_"


class DatabaseSettings(BaseModel):
    """Database configuration."""
    url: str = "postgresql://aether_user:aether_pass@localhost:5432/aether_dev"
    pool_size: int = 10
    max_overflow: int = 20
    pool_timeout: int = 30
    echo_sql: bool = False
    
    class Config:
        env_prefix = "DATABASE_"


class MonitoringSettings(BaseModel):
    """Monitoring and logging configuration."""
    log_level: str = "INFO"
    log_format: str = "json"  # json|text
    metrics_enabled: bool = True
    tracing_enabled: bool = True
    health_check_interval: int = 30
    
    class Config:
        env_prefix = "MONITORING_"


class IntegrationSettings(BaseModel):
    """External integration settings."""
    # Service integrations
    perplexica_url: str = "http://localhost:3000"
    perplexica_enabled: bool = True
    
    searxng_url: str = "http://127.0.0.1:4000"
    searxng_enabled: bool = True
    
    docling_url: str = "http://127.0.0.1:8000"
    docling_enabled: bool = True
    
    xlwings_url: str = "http://localhost:8080"
    xlwings_enabled: bool = True
    
    lm_studio_url: str = "http://localhost:1234/v1"
    lm_studio_enabled: bool = True
    
    # MCP settings
    mcp_enabled: bool = True
    mcp_auto_start: bool = True
    mcp_health_check_interval: int = 30
    
    class Config:
        env_prefix = "INTEGRATION_"


class MemorySettings(BaseModel):
    """Memory and retrieval settings."""
    enabled: bool = True
    type: str = "sqlite"  # sqlite|chroma|pgvector
    path: str = "./data/memory.db"
    embedder: str = "local-minilm"
    top_k: int = 5
    
    class Config:
        env_prefix = "MEMORY_"


class StorageSettings(BaseModel):
    """File storage settings."""
    base_path: Path = Field(default_factory=lambda: Path("./data/storage"))
    max_upload_size_mb: int = 100
    allowed_extensions: List[str] = Field(
        default_factory=lambda: [
            ".pdf", ".txt", ".md", ".doc", ".docx",
            ".xls", ".xlsx", ".csv", ".json", ".yaml", ".yml",
            ".png", ".jpg", ".jpeg", ".gif", ".webp"
        ]
    )
    
    class Config:
        env_prefix = "STORAGE_"


class Settings(BaseModel):
    """
    Main application settings.
    
    Loads configuration from:
    1. TOML config file (models_config.toml)
    2. Environment variables (prefixed by section)
    3. Defaults defined in schemas
    
    Priority: Environment variables > TOML config > Defaults
    """
    
    app_name: str = "Aether Backend"
    app_version: str = "2.0.0"
    environment: str = "development"  # development|production|test
    
    # Config directory (for loading YAML files)
    config_dir: Path = Field(
        default_factory=lambda: Path(__file__).parent,
        description="Directory containing config files"
    )
    
    llm: LLMSettings = Field(default_factory=LLMSettings)
    interpreter: InterpreterSettings = Field(default_factory=InterpreterSettings)
    security: SecuritySettings = Field(default_factory=SecuritySettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    monitoring: MonitoringSettings = Field(default_factory=MonitoringSettings)
    integrations: IntegrationSettings = Field(default_factory=IntegrationSettings)
    memory: MemorySettings = Field(default_factory=MemorySettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    
    @property
    def base_url(self) -> str:
        """
        Backend self-reference URL (for OI tool catalog).
        Dynamically constructed from security settings.
        """
        return f"http://{self.security.bind_host}:{self.security.bind_port}"
    
    @field_validator('environment')
    @classmethod
    def validate_environment(cls, v: str) -> str:
        """Validate environment value."""
        allowed = ['development', 'production', 'test']
        if v not in allowed:
            raise ValueError(f"Environment must be one of {allowed}")
        return v
    
    class Config:
        env_prefix = "AETHER_"
        case_sensitive = False


# =============================================================================
# Settings Loader
# =============================================================================

@lru_cache()
def get_settings() -> Settings:
    """
    Load and return application settings (cached).
    
    Merges configuration from:
    1. TOML config file (via utils.config)
    2. Environment variables
    3. Default values
    
    Returns:
        Settings: Complete application settings
    """
    # Load TOML config
    toml_config = load_toml_config()
    
    # Extract settings from TOML
    llm_settings = {}
    if "MODELS" in toml_config and "PROVIDERS" in toml_config:
        models = toml_config["MODELS"]
        providers = toml_config["PROVIDERS"]
        oi_config = toml_config.get("OPEN_INTERPRETER", {})
        
        llm_settings = {
            "provider": "openai-compatible",
            "api_base": providers.get("lm_studio_url", "http://localhost:1234/v1"),
            "api_key": providers.get("lm_studio_api_key", "not-needed"),
            "model": models.get("primary_chat_model", "qwen/qwen3-4b-2507"),
            "supports_vision": oi_config.get("supports_vision", True),
            "context_window": oi_config.get("context_window", 100000),
            "max_tokens": oi_config.get("max_tokens", 4096),
        }
    
    integration_settings = {}
    if "PROVIDERS" in toml_config:
        providers = toml_config["PROVIDERS"]
        integration_settings = {
            "perplexica_url": providers.get("perplexica_url", "http://localhost:3000"),
            "searxng_url": providers.get("searxng_url", "http://127.0.0.1:4000"),
            "docling_url": providers.get("docling_url", "http://127.0.0.1:8000"),
            "xlwings_url": providers.get("xlwings_url", "http://localhost:8080"),
            "lm_studio_url": providers.get("lm_studio_url", "http://localhost:1234/v1"),
        }
    
    interpreter_settings = {}
    if "OPEN_INTERPRETER" in toml_config:
        oi_config = toml_config["OPEN_INTERPRETER"]
        interpreter_settings = {
            "offline": oi_config.get("offline", True),
            "disable_telemetry": oi_config.get("disable_telemetry", True),
        }
    
    # Build settings dict
    settings_dict = {
        "environment": os.getenv("AETHER_ENVIRONMENT", "development"),
    }
    
    # Backend self-reference (for OI tool catalog)
    # Use bind host/port from config or env vars
    bind_host = os.getenv("SECURITY_BIND_HOST", "127.0.0.1")
    bind_port = os.getenv("SECURITY_BIND_PORT", "8765")
    settings_dict["base_url"] = os.getenv(
        "AETHER_BASE_URL", 
        f"http://{bind_host}:{bind_port}"
    )
    
    if llm_settings:
        settings_dict["llm"] = llm_settings
    
    if integration_settings:
        settings_dict["integrations"] = integration_settings
        
    if interpreter_settings:
        settings_dict["interpreter"] = interpreter_settings
    
    # Override with environment variables if present
    if db_url := os.getenv("DATABASE_URL"):
        settings_dict["database"] = {"url": db_url}
    
    if log_level := os.getenv("MONITORING_LOG_LEVEL"):
        settings_dict.setdefault("monitoring", {})["log_level"] = log_level
    
    # Create Settings instance (Pydantic will handle env vars via Config)
    return Settings(**settings_dict)


def reload_settings() -> Settings:
    """
    Reload settings (clears cache).
    
    Use this when settings need to be refreshed (e.g., after config file changes).
    
    Returns:
        Settings: Reloaded application settings
    """
    get_settings.cache_clear()
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

