from typing import List, Optional
from pydantic import BaseModel, Field, field_validator, AliasChoices
from pydantic_settings import SettingsConfigDict

from config.schemas.core import AetherBaseSettings


class RedisSettings(AetherBaseSettings):
    """Redis cache configuration."""
    enabled: bool = True
    url: str = "redis://localhost:6379/0"
    namespace: str = "aether"
    presence_ttl_seconds: int = 180
    session_ttl_seconds: int = 900
    counter_ttl_seconds: int = 3600
    rate_limit_ttl_seconds: int = 180
    
    model_config = SettingsConfigDict(env_prefix="REDIS_")


class SupabaseSettings(AetherBaseSettings):
    """Supabase configuration."""
    enabled: bool = True
    url: str = "http://localhost:54321"
    # Loaded from env (config/local.env) - do not hardcode secrets in code.
    anon_key: str = ""
    service_role_key: str = ""
    db_schema: str = Field("public", validation_alias=AliasChoices("SUPABASE_SCHEMA", "SUPABASE_DB_SCHEMA"))
    realtime_enabled: bool = True

    model_config = SettingsConfigDict(env_prefix="SUPABASE_")


class MonitoringSettings(AetherBaseSettings):
    """Monitoring and logging configuration."""
    log_level: str = "INFO"
    log_format: str = "json"  # json|text
    metrics_enabled: bool = True
    tracing_enabled: bool = True
    health_check_interval: int = 30
    
    model_config = SettingsConfigDict(env_prefix="MONITORING_")


class DatabaseSettings(BaseModel):
    """Derived database configuration exposed to clients."""
    provider: str
    url: str
    pool_size: int
    max_overflow: int
    pool_timeout: int
    echo_sql: bool


class MemorySettings(AetherBaseSettings):
    """Memory and retrieval settings."""
    enabled: bool = True
    type: str = "supabase"  # supabase|pgvector (actual storage: Supabase PostgreSQL + pgvector)
    path: str = "./data/memory.db"
    embedder: str = "local-minilm"
    top_k: int = 5
    
    model_config = SettingsConfigDict(env_prefix="MEMORY_")


class EmbeddingSettings(AetherBaseSettings):
    """Embedding provider configuration.
    
    Primary: Perplexica ONNX (always available via Docker mesh, fast, lightweight).
    Fallback: LM Studio / OpenAI-compatible (higher quality, requires LM Studio running).
    """
    provider: str = "perplexica"
    model: str = "Xenova/bge-small-en-v1.5"
    api_base: str = "http://localhost:3000/api"
    api_key: str = "not-needed"
    dimensions: int = 384
    timeout_seconds: float = 30.0
    fallback_provider: Optional[str] = "lmstudio"
    fallback_model: Optional[str] = "text-embedding-nomic-embed-text-v1.5"
    fallback_api_base: Optional[str] = "http://localhost:1234/v1"
    fallback_api_key: Optional[str] = "not-needed"
    fallback_dimensions: Optional[int] = 768
    fallback_app_name: Optional[str] = "Aether Backend"
    fallback_site_url: Optional[str] = "http://localhost:8765"
    
    model_config = SettingsConfigDict(env_prefix="EMBEDDING_")


class EmbeddingServiceSettings(AetherBaseSettings):
    """Local embedding service hosted inside the Perplexica Docker container.
    
    Uses @huggingface/transformers (Transformers.js) with ONNX models.
    No external inference provider required — runs entirely inside the Docker mesh.
    
    The service exposes an OpenAI-compatible POST /api/embeddings endpoint
    on the same port as Perplexica (3000).
    """
    enabled: bool = True
    model: str = "Xenova/bge-small-en-v1.5"
    quality_model: str = "Xenova/nomic-embed-text-v1"
    dimensions: int = 384
    quality_dimensions: int = 768
    timeout_seconds: float = 30.0
    url: str = "http://localhost:3000/api/embeddings"
    
    model_config = SettingsConfigDict(env_prefix="EMBEDDING_SERVICE_")
    
    @property
    def service_url(self) -> str:
        """Get full embedding endpoint URL for direct HTTP calls (httpx)."""
        return self.url
    
    @property
    def openai_base_url(self) -> str:
        """Get base URL for OpenAI SDK (which appends /embeddings automatically).
        
        If url = "http://localhost:3000/api/embeddings", returns "http://localhost:3000/api".
        This is required because the openai Python SDK appends /embeddings to base_url.
        """
        if self.url.endswith("/embeddings"):
            return self.url[: -len("/embeddings")]
        return self.url


class MemoryServiceSettings(AetherBaseSettings):
    """Memory system configuration (business logic and behavior)."""
    # Global memory injection
    global_injection_enabled: bool = True
    global_injection_limit: int = 20
    global_injection_min_importance: float = 0.6
    chat_injection_min_importance: float = 0.3
    
    # Creation and Promotion Defaults
    default_manual_importance: float = 0.8
    default_auto_importance: float = 0.5
    promotion_threshold: float = 0.8
    promotion_boost: float = 0.1
    
    content_truncation_length: int = 200
    
    # Scoring weights for memory ranking
    importance_weight: float = 0.7
    access_frequency_weight: float = 0.3
    access_count_denominator: float = 100.0
    
    # Search and retrieval defaults
    default_search_limit: int = 10
    default_list_limit: int = 50
    vector_match_threshold: float = 0.5
    semantic_weight: float = 0.7
    keyword_weight: float = 0.3
    
    # Memory types (valid values for memory_type field)
    valid_memory_types: List[str] = Field(
        default_factory=lambda: ["fact", "decision", "preference", "insight", "skill"]
    )
    
    # LLM-powered memory extraction
    extraction_temperature: float = 0.3
    extraction_max_tokens: int = 1000
    group_frequency: int = Field(
        default=5,
        description="Number of recent chat groups to process for memory extraction"
    )
    
    model_config = SettingsConfigDict(env_prefix="MEMORY_SERVICE_")
    
    @field_validator(
        'global_injection_min_importance',
        'chat_injection_min_importance',
        'default_manual_importance',
        'default_auto_importance',
        'promotion_threshold',
        'promotion_boost',
        'vector_match_threshold'
    )
    @classmethod
    def validate_threshold(cls, v: float, info) -> float:
        """Validate threshold values are between 0.0 and 1.0."""
        if not 0.0 <= v <= 1.0:
            raise ValueError(f'{info.field_name} must be between 0.0 and 1.0')
        return v
    
    @field_validator('semantic_weight', 'keyword_weight')
    @classmethod
    def validate_weight(cls, v: float, info) -> float:
        """Validate weight values are between 0.0 and 1.0."""
        if not 0.0 <= v <= 1.0:
            raise ValueError(f'{info.field_name} must be between 0.0 and 1.0')
        return v

    @field_validator('group_frequency')
    @classmethod
    def validate_group_frequency(cls, v: int) -> int:
        """Validate group frequency is positive."""
        if v < 1:
            raise ValueError("group_frequency must be >= 1")
        return v
