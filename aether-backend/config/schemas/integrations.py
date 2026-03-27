import sys
from pathlib import Path
from typing import Optional, List, Literal

from pydantic import Field
from pydantic_settings import SettingsConfigDict

from config.schemas.core import AetherBaseSettings, get_app_root


class SlackSourceSettings(AetherBaseSettings):
    """Slack MCP ingestion settings."""
    enabled: bool = False
    configured: bool = False
    mcp_command: str = ""
    default_index_name: str = "slack_messages"
    concatenate_conversations: bool = True
    max_messages_per_channel: int = 100
    max_retries: int = 5
    retry_delay_seconds: float = 2.0

    model_config = SettingsConfigDict(env_prefix="INTEGRATION_SLACK_")


class BrowserHistorySourceSettings(AetherBaseSettings):
    """Chromium browser history ingestion settings (Edge preferred)."""
    enabled: bool = False
    default_index_name: str = "browser_history"
    index_mode: Literal["semantic", "bm25", "combined"] = "bm25"
    # edge|chrome|chromium
    browser: str = "edge"
    # Explicit profile directory that contains the `History` SQLite file.
    profile_path: Optional[str] = None
    # Auto-detect profiles from browser user-data directory if profile_path is not set.
    auto_find_profiles: bool = True
    # Optional override for the browser "User Data" base directory (contains Default/Profile * directories).
    user_data_dir: Optional[str] = None
    max_items: int = 5000

    model_config = SettingsConfigDict(env_prefix="INTEGRATION_BROWSER_HISTORY_")


class EmailSourceSettings(AetherBaseSettings):
    """Email ingestion settings (local .eml directories or .mbox archives)."""
    enabled: bool = False
    default_index_name: str = "email"
    index_mode: Literal["semantic", "bm25", "combined"] = "bm25"
    # Either a directory containing .eml files or a single .mbox file.
    source_path: Optional[str] = None
    max_items: int = 5000

    model_config = SettingsConfigDict(env_prefix="INTEGRATION_EMAIL_")


class AetherRagSearchSettings(AetherBaseSettings):
    """Global search pipeline settings for AetherRag."""
    mode: Literal["semantic", "bm25", "hybrid"] = "bm25"
    hybrid_semantic_weight: float = Field(1.0, ge=0.0, le=2.0)
    hybrid_sparse_weight: float = Field(0.5, ge=0.0, le=2.0)
    rrf_k: int = Field(60, ge=1)

    model_config = SettingsConfigDict(env_prefix="INTEGRATION_AETHER_RAG_SEARCH_")


class AetherRagSourcesSettings(AetherBaseSettings):
    """Local data source ingestion settings (AetherRag-backed)."""
    enabled: bool = True  # CRITICAL: Enabled by default for browser history, file indexing
    index_root_dir: str = Field(
        default_factory=lambda: str(
            # In production (frozen binary), Path(__file__) resolves inside the read-only
            # app bundle.  AetherRag writes index data here, so use writable app_root.
            get_app_root() / "data" / "aether_rag_sources"
        )
    )
    slack: SlackSourceSettings = Field(default_factory=SlackSourceSettings)
    browser_history: BrowserHistorySourceSettings = Field(default_factory=BrowserHistorySourceSettings)
    email: EmailSourceSettings = Field(default_factory=EmailSourceSettings)
    search: AetherRagSearchSettings = Field(default_factory=AetherRagSearchSettings)

    model_config = SettingsConfigDict(env_prefix="INTEGRATION_AETHER_RAG_SOURCES_")


class IntegrationSettings(AetherBaseSettings):
    """External integration settings."""
    # Service integrations
    perplexica_url: str = "http://localhost:3000"
    perplexica_enabled: bool = True
    
    searxng_url: str = "http://127.0.0.1:4040"
    searxng_enabled: bool = True
    
    docling_enabled: bool = False
    
    xlwings_enabled: bool = True
    # On-demand Excel automation uses local files (no HTTP sub-service, no extra ports).
    # Set base dir to control where workbooks are created/opened by default.
    xlwings_base_dir: str = Field(default_factory=lambda: str(Path.home() / ".aetherarena" / "xlwings"))
    
    lm_studio_url: str = "http://localhost:1234/v1"
    lm_studio_enabled: bool = True
    
    openrouter_url: str = "https://openrouter.ai/api/v1"
    openrouter_enabled: bool = True
    
    # AETHER_RAG MCP (on-device retrieval)
    # Default to in-process Python execution rather than relying on a globally-installed console script.
    # This is critical for dev environments where `aether_rag_mcp` may not be on PATH.
    aether_rag_mcp_command: str = Field(default_factory=lambda: sys.executable)
    aether_rag_mcp_args: List[str] = Field(
        default_factory=lambda: [str(Path(__file__).parent.parent / "services" / "daemons" / "file_indexing" / "mcp_server.py")]
    )
    
    # MCP settings
    mcp_enabled: bool = True  # Enabled - now uses Supabase SDK
    mcp_auto_start: bool = True
    mcp_health_check_interval: int = 30

    # AETHER_RAG-backed source ingestion (Slack, browser history, etc.)
    aether_rag_sources: AetherRagSourcesSettings = Field(default_factory=AetherRagSourcesSettings)
    
    # File Indexing service settings (reuses EmbeddingServiceSettings for model)
    file_indexing_enabled: bool = True
    file_indexing_backend_url: Optional[str] = None

    
    model_config = SettingsConfigDict(env_prefix="INTEGRATION_")
