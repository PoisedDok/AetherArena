"""
Settings Schemas

Pydantic models for settings management endpoints.

@.architecture
Incoming: api/v1/endpoints/settings.py, config/settings.py --- {settings update requests, Settings object}
Processing: Pydantic validation and serialization --- {JOB_SERIALIZE, JOB_VALIDATE_SCHEMA}
Outgoing: api/v1/endpoints/settings.py --- {SettingsResponse, SettingsUpdateRequest, LLMSettingsUpdate, InterpreterSettingsUpdate validated models}
"""

from typing import Dict, Any, List, Optional
from pydantic import BaseModel, ConfigDict, Field


# =============================================================================
# Settings Models
# =============================================================================

class LLMSettingsResponse(BaseModel):
    """LLM settings response."""
    provider: str
    api_base: str
    model: str
    embedding_model: str
    supports_vision: bool
    show_thinking: bool
    context_window: int
    max_tokens: int
    temperature: float


class InterpreterSettingsResponse(BaseModel):
    """Interpreter settings response."""
    auto_run: bool
    loop: bool
    safe_mode: str
    system_message: str
    profile: str
    offline: bool
    disable_telemetry: bool


class SecuritySettingsResponse(BaseModel):
    """Security settings response."""
    bind_host: str
    bind_port: int
    allowed_origins: List[str]
    cors_allow_credentials: bool
    auth_enabled: bool
    rate_limit_enabled: bool


class DatabaseSettingsResponse(BaseModel):
    """Database settings response."""
    url: str
    pool_size: int
    max_overflow: int
    pool_timeout: int
    echo_sql: bool


class MonitoringSettingsResponse(BaseModel):
    """Monitoring settings response."""
    log_level: str
    log_format: str
    metrics_enabled: bool
    tracing_enabled: bool
    health_check_interval: int


class MemorySettingsResponse(BaseModel):
    """Memory settings response."""
    enabled: bool
    type: str
    path: str
    embedder: str
    top_k: int


class IntegrationSettingsResponse(BaseModel):
    """Integration settings response."""
    perplexica_url: str
    perplexica_enabled: bool
    searxng_url: str
    searxng_enabled: bool
    docling_enabled: bool
    xlwings_enabled: bool
    xlwings_base_dir: str
    lm_studio_url: str
    lm_studio_enabled: bool
    openrouter_url: str
    openrouter_enabled: bool
    mcp_enabled: bool
    mcp_auto_start: bool
    mcp_health_check_interval: int
    # User-configurable AETHER_RAG local source ingestion (Slack, browser history, email, ...)
    aether_rag_sources: Optional[Dict[str, Any]] = None


class EmbeddingSettingsResponse(BaseModel):
    """Embedding settings response."""
    provider: str
    model: str
    api_base: str
    timeout_seconds: float
    fallback_provider: Optional[str] = None
    fallback_api_base: Optional[str] = None


class UserProfileSettingsResponse(BaseModel):
    """User profile settings response."""
    name: str
    username: str


class SettingsResponse(BaseModel):
    """Complete settings response."""
    app_name: str
    app_version: str
    environment: str
    llm: LLMSettingsResponse
    interpreter: InterpreterSettingsResponse
    security: SecuritySettingsResponse
    database: DatabaseSettingsResponse
    monitoring: MonitoringSettingsResponse
    memory: MemorySettingsResponse
    integrations: IntegrationSettingsResponse
    embeddings: EmbeddingSettingsResponse
    user_profile: UserProfileSettingsResponse
    
    class Config:
        json_schema_extra = {
            "example": {
                "app_name": "Aether Backend",
                "app_version": "2.0.0",
                "environment": "development",
                "llm": {
                    "provider": "aether_inference",
                    "api_base": "http://127.0.0.1:7090/v1",
                    "model": "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
                    "embedding_model": "text-embedding-nomic-embed-text-v1.5",
                    "supports_vision": True,
                    "context_window": 100000,
                    "max_tokens": 4096,
                    "temperature": 0.7
                },
                "interpreter": {
                    "auto_run": True,
                    "loop": False,
                    "safe_mode": "off",
                    "system_message": "",
                    "profile": "GURU.yaml",
                    "offline": True,
                    "disable_telemetry": True
                },
                "security": {
                    "bind_host": "127.0.0.1",
                    "bind_port": 5002,
                    "allowed_origins": ["http://localhost:3000"],
                    "cors_allow_credentials": True,
                    "auth_enabled": False,
                    "rate_limit_enabled": False
                },
                "integrations": {
                    "perplexica_url": "http://localhost:3000",
                    "perplexica_enabled": True,
                    "searxng_url": "http://127.0.0.1:4040",
                    "searxng_enabled": True,
                    "docling_enabled": True,
                    "xlwings_enabled": True,
                    "xlwings_base_dir": "~/.aetherarena/xlwings",
                    "lm_studio_url": "http://localhost:1234/v1",
                    "lm_studio_enabled": True,
                    "openrouter_url": "https://openrouter.ai/api/v1",
                    "openrouter_enabled": True,
                    "mcp_enabled": True,
                    "mcp_auto_start": True
                },
                "embeddings": {
                    "provider": "perplexica",
                    "model": "Xenova/bge-small-en-v1.5",
                    "api_base": "http://localhost:3000/api",
                    "timeout_seconds": 30.0,
                    "fallback_provider": "lmstudio",
                    "fallback_api_base": "http://localhost:1234/v1"
                }
            }
        }


# =============================================================================
# Settings Update Models
# =============================================================================

class LLMSettingsUpdate(BaseModel):
    """LLM settings update request."""
    provider: Optional[str] = None
    api_base: Optional[str] = None
    model: Optional[str] = None
    supports_vision: Optional[bool] = None
    show_thinking: Optional[bool] = None
    context_window: Optional[int] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)


class InterpreterSettingsUpdate(BaseModel):
    """Interpreter settings update request."""
    auto_run: Optional[bool] = None
    loop: Optional[bool] = None
    safe_mode: Optional[str] = Field(None, pattern="^(off|ask|auto)$")
    system_message: Optional[str] = None
    profile: Optional[str] = None


class DatabaseSettingsUpdate(BaseModel):
    """Database settings update request."""
    pool_size: Optional[int] = Field(None, ge=1, le=100)
    max_overflow: Optional[int] = Field(None, ge=0, le=100)
    pool_timeout: Optional[int] = Field(None, ge=5, le=300)
    echo_sql: Optional[bool] = None


class MonitoringSettingsUpdate(BaseModel):
    """Monitoring settings update request."""
    log_level: Optional[str] = Field(None, pattern="^(DEBUG|INFO|WARNING|ERROR|CRITICAL)$")
    log_format: Optional[str] = Field(None, pattern="^(json|text)$")
    metrics_enabled: Optional[bool] = None
    tracing_enabled: Optional[bool] = None
    health_check_interval: Optional[int] = Field(None, ge=10, le=300)


class MemorySettingsUpdate(BaseModel):
    """Memory settings update request."""
    enabled: Optional[bool] = None
    type: Optional[str] = Field(None, pattern="^(sqlite|chroma|pgvector)$")
    embedder: Optional[str] = None
    top_k: Optional[int] = Field(None, ge=1, le=100)


class EmbeddingSettingsUpdate(BaseModel):
    """Embedding settings update request."""
    provider: Optional[str] = None
    model: Optional[str] = None
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    timeout_seconds: Optional[float] = Field(None, ge=1.0, le=120.0)
    fallback_provider: Optional[str] = None
    fallback_api_base: Optional[str] = None
    fallback_api_key: Optional[str] = None
    fallback_app_name: Optional[str] = None
    fallback_site_url: Optional[str] = None


class UserProfileSettingsUpdate(BaseModel):
    """User profile settings update request."""
    name: Optional[str] = None
    username: Optional[str] = None


class IntegrationSettingsUpdate(BaseModel):
    """Integration settings update request."""
    perplexica_url: Optional[str] = None
    perplexica_enabled: Optional[bool] = None
    searxng_url: Optional[str] = None
    searxng_enabled: Optional[bool] = None
    docling_enabled: Optional[bool] = None
    xlwings_enabled: Optional[bool] = None
    xlwings_base_dir: Optional[str] = None
    lm_studio_url: Optional[str] = None
    lm_studio_enabled: Optional[bool] = None
    openrouter_url: Optional[str] = None
    openrouter_enabled: Optional[bool] = None
    mcp_enabled: Optional[bool] = None
    mcp_auto_start: Optional[bool] = None
    mcp_health_check_interval: Optional[int] = Field(None, ge=10, le=300)
    # User-configurable AETHER_RAG local source ingestion (Slack, browser history, email, ...)
    aether_rag_sources: Optional[Dict[str, Any]] = None


class SecuritySettingsUpdate(BaseModel):
    """Strictly typed security settings update payload.

    Uses extra='ignore' so the PATCH endpoint tolerates unknown fields from
    the frontend's deep-merged default security object (e.g. legacy 'auth' key)
    while still enforcing types on declared fields.
    """
    model_config = ConfigDict(extra="ignore")

    bind_host: Optional[str] = Field(None, min_length=1, max_length=255)
    bind_port: Optional[int] = Field(None, ge=1, le=65535)
    allowed_origins: Optional[List[str]] = None
    cors_allow_credentials: Optional[bool] = None
    cors_allow_methods: Optional[List[str]] = None
    cors_allow_headers: Optional[List[str]] = None

    auth_enabled: Optional[bool] = None
    api_key_required: Optional[bool] = None
    api_key_header: Optional[str] = Field(None, min_length=1, max_length=64)
    allow_anonymous: Optional[bool] = None
    allow_bearer_tokens: Optional[bool] = None
    default_role: Optional[str] = Field(None, min_length=1, max_length=64)
    default_user_id: Optional[str] = Field(None, min_length=1, max_length=256)

    allow_local_os_tools: Optional[bool] = None
    allow_notebook_exec: Optional[bool] = None

    rate_limit_enabled: Optional[bool] = None
    rate_limit_requests_per_minute: Optional[int] = Field(None, ge=1, le=100000)
    public_paths: Optional[List[str]] = None


class SettingsPatchRequest(BaseModel):
    """PATCH-style settings payload used by /v1/settings update endpoint."""
    llm: Optional[Dict[str, Any]] = None
    vision_document: Optional[Dict[str, Any]] = None
    interpreter: Optional[Dict[str, Any]] = None
    handsfree: Optional[Dict[str, Any]] = None
    memory: Optional[Dict[str, Any]] = None
    summary: Optional[Dict[str, Any]] = None
    integrations: Optional[Dict[str, Any]] = None
    ui: Optional[Dict[str, Any]] = None
    embedding_service: Optional[Dict[str, Any]] = None
    security: Optional[SecuritySettingsUpdate] = None
    service_providers: Optional[Dict[str, Any]] = None
    user_profile: Optional[UserProfileSettingsUpdate] = None


class SettingsUpdateRequest(BaseModel):
    """Settings update request."""
    llm: Optional[LLMSettingsUpdate] = None
    interpreter: Optional[InterpreterSettingsUpdate] = None
    database: Optional[DatabaseSettingsUpdate] = None
    monitoring: Optional[MonitoringSettingsUpdate] = None
    memory: Optional[MemorySettingsUpdate] = None
    integrations: Optional[IntegrationSettingsUpdate] = None
    embeddings: Optional[EmbeddingSettingsUpdate] = None
    user_profile: Optional[UserProfileSettingsUpdate] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "llm": {
                    "model": "qwen/qwen3-14b",
                    "temperature": 0.8
                },
                "interpreter": {
                    "auto_run": True,
                    "safe_mode": "ask"
                },
                "integrations": {
                    "perplexica_enabled": False
                }
            }
        }


# =============================================================================
# Model Configuration Models
# =============================================================================

class ModelConfigData(BaseModel):
    """Model configuration data."""
    primary_chat_model: str
    fallback_chat_model: Optional[str] = None
    primary_embedding_model: str
    fallback_embedding_model: Optional[str] = None


class ModelConfigResponse(BaseModel):
    """Model configuration response."""
    config: ModelConfigData
    available_providers: List[str]
    available_models: List[str]

