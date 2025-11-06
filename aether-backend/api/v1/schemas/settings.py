"""
Settings Schemas

Pydantic models for settings management endpoints.

@.architecture
Incoming: api/v1/endpoints/settings.py, config/settings.py --- {settings update requests, Settings object}
Processing: Pydantic validation and serialization --- {2 jobs: data_validation, serialization}
Outgoing: api/v1/endpoints/settings.py --- {SettingsResponse, SettingsUpdateRequest, LLMSettingsUpdate, InterpreterSettingsUpdate validated models}
"""

from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field


# =============================================================================
# Settings Models
# =============================================================================

class LLMSettingsResponse(BaseModel):
    """LLM settings response."""
    provider: str
    api_base: str
    model: str
    supports_vision: bool
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


class StorageSettingsResponse(BaseModel):
    """Storage settings response."""
    base_path: str
    max_upload_size_mb: int
    allowed_extensions: List[str]


class IntegrationSettingsResponse(BaseModel):
    """Integration settings response."""
    perplexica_url: str
    perplexica_enabled: bool
    searxng_url: str
    searxng_enabled: bool
    docling_url: str
    docling_enabled: bool
    xlwings_url: str
    xlwings_enabled: bool
    lm_studio_url: str
    lm_studio_enabled: bool
    mcp_enabled: bool
    mcp_auto_start: bool
    mcp_health_check_interval: int


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
    storage: StorageSettingsResponse
    integrations: IntegrationSettingsResponse
    
    class Config:
        json_schema_extra = {
            "example": {
                "app_name": "Aether Backend",
                "app_version": "2.0.0",
                "environment": "development",
                "llm": {
                    "provider": "openai-compatible",
                    "api_base": "http://localhost:1234/v1",
                    "model": "qwen/qwen3-4b-2507",
                    "supports_vision": True,
                    "context_window": 100000,
                    "max_tokens": 4096,
                    "temperature": 0.7
                },
                "interpreter": {
                    "auto_run": False,
                    "loop": False,
                    "safe_mode": "off",
                    "system_message": "",
                    "profile": "GURU.py",
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
                    "searxng_url": "http://127.0.0.1:4000",
                    "searxng_enabled": True,
                    "docling_url": "http://127.0.0.1:8000",
                    "docling_enabled": True,
                    "mcp_enabled": True,
                    "mcp_auto_start": True
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


class StorageSettingsUpdate(BaseModel):
    """Storage settings update request."""
    max_upload_size_mb: Optional[int] = Field(None, ge=1, le=1000)


class IntegrationSettingsUpdate(BaseModel):
    """Integration settings update request."""
    perplexica_url: Optional[str] = None
    perplexica_enabled: Optional[bool] = None
    searxng_url: Optional[str] = None
    searxng_enabled: Optional[bool] = None
    docling_url: Optional[str] = None
    docling_enabled: Optional[bool] = None
    xlwings_url: Optional[str] = None
    xlwings_enabled: Optional[bool] = None
    lm_studio_url: Optional[str] = None
    lm_studio_enabled: Optional[bool] = None
    mcp_enabled: Optional[bool] = None
    mcp_auto_start: Optional[bool] = None
    mcp_health_check_interval: Optional[int] = Field(None, ge=10, le=300)


class SettingsUpdateRequest(BaseModel):
    """Settings update request."""
    llm: Optional[LLMSettingsUpdate] = None
    interpreter: Optional[InterpreterSettingsUpdate] = None
    database: Optional[DatabaseSettingsUpdate] = None
    monitoring: Optional[MonitoringSettingsUpdate] = None
    memory: Optional[MemorySettingsUpdate] = None
    storage: Optional[StorageSettingsUpdate] = None
    integrations: Optional[IntegrationSettingsUpdate] = None
    
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

