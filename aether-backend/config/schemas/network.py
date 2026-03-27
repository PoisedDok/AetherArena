import os
from typing import List, Optional, Any, Union, Dict
from pydantic import BaseModel, Field, field_validator
from pydantic_settings import SettingsConfigDict

from config.schemas.core import (
    AetherBaseSettings,
    _parse_list_env,
    _parse_bool_env,
    _parse_json_list_env,
    _parse_comma_list,
    _parse_json_list,
)


def _build_security_overrides_from_env() -> Dict[str, Any]:
    """Build explicit SECURITY_* overrides for nested SecuritySettings."""
    overrides: Dict[str, Any] = {}

    env_bind_host = os.getenv("SECURITY_BIND_HOST", os.getenv("AETHER_BIND_IP"))
    if env_bind_host is not None:
        bind_host = env_bind_host.strip()
        if not bind_host:
            raise ValueError("SECURITY_BIND_HOST (or AETHER_BIND_IP) cannot be empty")
        if bind_host == "0.0.0.0" and os.getenv("AETHER_ALLOW_EXTERNAL_BIND", "false").lower() != "true":
            raise ValueError("SECURITY_BIND_HOST/AETHER_BIND_IP cannot be 0.0.0.0 (must bind strictly to loopback unless AETHER_ALLOW_EXTERNAL_BIND=true)")
        overrides["bind_host"] = bind_host

    env_bind_port = os.getenv("SECURITY_BIND_PORT")
    if env_bind_port is not None:
        overrides["bind_port"] = int(env_bind_port)

    env_allowed_origins = os.getenv("SECURITY_ALLOWED_ORIGINS")
    if env_allowed_origins is not None:
        overrides["allowed_origins"] = _parse_list_env(env_allowed_origins, "SECURITY_ALLOWED_ORIGINS")

    env_cors_creds = os.getenv("SECURITY_CORS_ALLOW_CREDENTIALS")
    if env_cors_creds is not None:
        overrides["cors_allow_credentials"] = _parse_bool_env(env_cors_creds)

    env_cors_methods = os.getenv("SECURITY_CORS_ALLOW_METHODS")
    if env_cors_methods is not None:
        overrides["cors_allow_methods"] = _parse_list_env(env_cors_methods, "SECURITY_CORS_ALLOW_METHODS")

    env_cors_headers = os.getenv("SECURITY_CORS_ALLOW_HEADERS")
    if env_cors_headers is not None:
        overrides["cors_allow_headers"] = _parse_list_env(env_cors_headers, "SECURITY_CORS_ALLOW_HEADERS")

    env_auth_enabled = os.getenv("SECURITY_AUTH_ENABLED")
    if env_auth_enabled is not None:
        overrides["auth_enabled"] = _parse_bool_env(env_auth_enabled)

    env_auth_secret = os.getenv("SECURITY_AUTH_SECRET_KEY")
    if env_auth_secret is not None:
        overrides["auth_secret_key"] = env_auth_secret.strip() or None

    env_api_key_required = os.getenv("SECURITY_API_KEY_REQUIRED")
    if env_api_key_required is not None:
        overrides["api_key_required"] = _parse_bool_env(env_api_key_required)

    env_api_key_header = os.getenv("SECURITY_API_KEY_HEADER")
    if env_api_key_header is not None:
        api_key_header = env_api_key_header.strip()
        if not api_key_header:
            raise ValueError("SECURITY_API_KEY_HEADER cannot be empty")
        overrides["api_key_header"] = api_key_header

    env_allow_anonymous = os.getenv("SECURITY_ALLOW_ANONYMOUS")
    if env_allow_anonymous is not None:
        overrides["allow_anonymous"] = _parse_bool_env(env_allow_anonymous)

    env_allow_bearer_tokens = os.getenv("SECURITY_ALLOW_BEARER_TOKENS")
    if env_allow_bearer_tokens is not None:
        overrides["allow_bearer_tokens"] = _parse_bool_env(env_allow_bearer_tokens)

    env_default_role = os.getenv("SECURITY_DEFAULT_ROLE")
    if env_default_role is not None:
        default_role = env_default_role.strip()
        if not default_role:
            raise ValueError("SECURITY_DEFAULT_ROLE cannot be empty")
        overrides["default_role"] = default_role

    env_static_api_keys = os.getenv("SECURITY_STATIC_API_KEYS")
    if env_static_api_keys is not None:
        overrides["static_api_keys"] = _parse_json_list_env(env_static_api_keys, "SECURITY_STATIC_API_KEYS")

    env_public_paths = os.getenv("SECURITY_PUBLIC_PATHS")
    if env_public_paths is not None:
        overrides["public_paths"] = _parse_list_env(env_public_paths, "SECURITY_PUBLIC_PATHS")

    env_default_user_id = os.getenv("SECURITY_DEFAULT_USER_ID")
    if env_default_user_id is not None:
        default_user_id = env_default_user_id.strip()
        if not default_user_id:
            raise ValueError("SECURITY_DEFAULT_USER_ID cannot be empty")
        overrides["default_user_id"] = default_user_id

    env_allow_os_tools = os.getenv("SECURITY_ALLOW_LOCAL_OS_TOOLS")
    if env_allow_os_tools is not None:
        overrides["allow_local_os_tools"] = _parse_bool_env(env_allow_os_tools)

    env_allow_notebook = os.getenv("SECURITY_ALLOW_NOTEBOOK_EXEC")
    if env_allow_notebook is not None:
        overrides["allow_notebook_exec"] = _parse_bool_env(env_allow_notebook)

    env_rate_limit_enabled = os.getenv("SECURITY_RATE_LIMIT_ENABLED")
    if env_rate_limit_enabled is not None:
        overrides["rate_limit_enabled"] = _parse_bool_env(env_rate_limit_enabled)

    env_rate_limit_rpm = os.getenv("SECURITY_RATE_LIMIT_REQUESTS_PER_MINUTE")
    if env_rate_limit_rpm is not None:
        overrides["rate_limit_requests_per_minute"] = int(env_rate_limit_rpm)

    env_rate_limit_tiers = os.getenv("SECURITY_RATE_LIMIT_TIERS")
    if env_rate_limit_tiers is not None:
        overrides["rate_limit_tiers"] = _parse_json_list_env(env_rate_limit_tiers, "SECURITY_RATE_LIMIT_TIERS")

    env_rate_limit_rules = os.getenv("SECURITY_RATE_LIMIT_RULES")
    if env_rate_limit_rules is not None:
        overrides["rate_limit_rules"] = _parse_json_list_env(env_rate_limit_rules, "SECURITY_RATE_LIMIT_RULES")

    return overrides


class APIKeySettings(BaseModel):
    """Static API key definition (for bootstrap/import)."""
    key: str
    user_id: str = "service"
    role: str = "user"
    description: Optional[str] = None


class RateLimitTierSettings(BaseModel):
    """Per-tier rate limit configuration."""
    name: str
    requests_per_window: int = 60
    window_seconds: float = 60.0
    burst_size: Optional[int] = None
    strategy: str = "per_ip"


class RateLimitRuleSettings(BaseModel):
    """Mapping of path patterns to rate limit tiers."""
    pattern: str
    tier: str


class SecuritySettings(AetherBaseSettings):
    """Security configuration."""
    # SECURITY: Default to loopback (localhost only). Desktop app has no reason
    # to accept connections from other network devices. Docker services communicate
    # outbound (backend → Supabase/Redis), not inbound.
    # Override via SECURITY_BIND_HOST env var if needed for specific deployments.
    bind_host: str = "127.0.0.1"
    bind_port: int = 8765
    allowed_origins: Union[str, List[str]] = Field(
        default_factory=lambda: [
            "http://localhost",
            "http://127.0.0.1",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "null",
            "file://",
            "app://",
            "app://.",
            "aether://",
            "aether://.",
        ]
    )
    cors_allow_credentials: bool = True
    cors_allow_methods: Union[str, List[str]] = Field(default_factory=lambda: ["*"])
    cors_allow_headers: Union[str, List[str]] = Field(default_factory=lambda: ["*"])
    
    # Authentication
    # Desktop single-user mode: auth disabled by default (backend bound to 127.0.0.1).
    # production.yaml overrides to True for multi-user / cloud deployment.
    auth_enabled: bool = False
    auth_secret_key: Optional[str] = None
    api_key_required: bool = False
    api_key_header: str = "X-API-Key"
    # Desktop mode: anonymous access allowed (single local user).
    # production.yaml overrides to False.
    allow_anonymous: bool = True
    allow_bearer_tokens: bool = True
    default_role: str = "user"
    static_api_keys: Union[str, List[APIKeySettings]] = Field(default_factory=list)
    public_paths: Union[str, List[str]] = Field(
        default_factory=lambda: [
            "/",
            "/health",
            "/v1/health",
            "/v1/setup/status",
            "/v1/setup/start",
            "/v1/setup/check",
            "/docs",
            "/openapi.json",
            "/redoc",
        ]
    )

    # Single-user defaults
    default_user_id: str = "default_user"

    # Local-only OS/exec controls
    # CRITICAL: Enabled by default for core features (browser history, file indexing)
    allow_local_os_tools: bool = True
    allow_notebook_exec: bool = False
    
    # Rate limiting
    # Desktop single-user mode: rate limiting disabled (no external clients).
    # production.yaml overrides to True.
    rate_limit_enabled: bool = False
    rate_limit_requests_per_minute: int = 60
    rate_limit_tiers: List[RateLimitTierSettings] = Field(default_factory=list)
    rate_limit_rules: List[RateLimitRuleSettings] = Field(default_factory=list)
    
    
    model_config = SettingsConfigDict(env_prefix="SECURITY_")

    @field_validator('allowed_origins', 'cors_allow_methods', 'cors_allow_headers', 'public_paths', mode='before')
    @classmethod
    def parse_lists(cls, v):
        return _parse_comma_list(v)

    @field_validator('static_api_keys', 'rate_limit_tiers', 'rate_limit_rules', mode='before')
    @classmethod
    def parse_json_lists(cls, v):
        return _parse_json_list(v)


class WebSocketSettings(AetherBaseSettings):
    """WebSocket layer configuration."""
    send_timeout: float = 3.0
    broadcast_timeout: float = 5.0
    heartbeat_interval: float = 30.0
    connection_timeout: float = 600.0  # 10 minutes for long document processing
    
    # Document processing timeouts (for artifact processing during message send)
    document_processing_timeout: float = 300.0  # 5 minutes for PDFs/docs (Docling)
    image_processing_timeout: float = 120.0  # 2 minutes for images (InternVL)
    
    # Cache TTLs (seconds)
    presence_ttl: int = 180  # 3 minutes
    session_ttl: int = 900  # 15 minutes
    counter_ttl: int = 3600  # 1 hour
    
    # Size limits (bytes)
    max_message_size: int = 1024 * 1024  # 1MB
    max_binary_size: int = 50 * 1024 * 1024  # 50MB
    
    model_config = SettingsConfigDict(env_prefix="WS_")


class HTTPClientSettings(AetherBaseSettings):
    """HTTP client configuration for service-to-service calls."""
    default_timeout: float = 60.0
    llm_timeout: float = 300.0
    embedding_timeout: float = 60.0
    external_service_timeout: float = 600.0
    # Toolrunner calls are internal (backend -> itself) but can orchestrate long-running work
    # (e.g., /v1/research aggregates multiple Perplexica searches). Keep separate from
    # external_service_timeout to avoid globally inflating every service call.
    toolrunner_timeout: float = 600.0
    
    # Retry behavior
    max_retries: int = 3
    retry_backoff_factor: float = 0.5
    retry_on_status_codes: List[int] = Field(
        default_factory=lambda: [429, 500, 502, 503, 504]
    )
    
    model_config = SettingsConfigDict(env_prefix="HTTP_CLIENT_")
