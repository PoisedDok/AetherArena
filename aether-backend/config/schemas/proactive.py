from typing import List, Optional
from pydantic import Field
from pydantic_settings import SettingsConfigDict

from config.schemas.core import AetherBaseSettings
from config.schemas.ai import ServiceProviderConfig


class JobQueueSettings(AetherBaseSettings):
    """Job queue resource management settings (NO HARDCODING)."""
    
    # Resource management
    max_resource_budget: int = Field(
        default=10, 
        description="Maximum total resource cost across all concurrent jobs (1-10 per job)"
    )
    enable_resource_management: bool = Field(
        default=True,
        description="Enable resource-aware job scheduling"
    )
    enable_stale_job_recovery: bool = Field(
        default=True,
        description="Auto-reset jobs stuck in processing state"
    )
    stale_job_timeout_minutes: int = Field(
        default=30,
        description="Minutes before a processing job is considered stale"
    )
    stale_job_check_interval_seconds: int = Field(
        default=60,
        description="How often to check for stale jobs (seconds)"
    )
    
    # Default resource costs by job type (configurable, not hardcoded)
    resource_cost_summarize: int = Field(default=3, ge=1, le=10, description="Resource cost for summarization")
    resource_cost_extract_memories: int = Field(default=2, ge=1, le=10, description="Resource cost for memory extraction")
    resource_cost_promote_memories: int = Field(default=2, ge=1, le=10, description="Resource cost for memory promotion")
    resource_cost_research: int = Field(default=6, ge=1, le=10, description="Resource cost for research (high)")
    resource_cost_proactive_indexing: int = Field(default=3, ge=1, le=10, description="Resource cost for proactive indexing")
    resource_cost_proactive_sync_browser: int = Field(default=2, ge=1, le=10, description="Resource cost for browser sync")
    resource_cost_proactive_sync_chat: int = Field(default=2, ge=1, le=10, description="Resource cost for chat sync")
    resource_cost_proactive_sync_memories: int = Field(default=2, ge=1, le=10, description="Resource cost for memories sync")
    resource_cost_proactive_sync_activity: int = Field(default=2, ge=1, le=10, description="Resource cost for activity sync")
    resource_cost_proactive_cleanup: int = Field(default=1, ge=1, le=10, description="Resource cost for proactive cleanup")
    resource_cost_default: int = Field(default=3, ge=1, le=10, description="Default resource cost for unknown types")
    
    model_config = SettingsConfigDict(env_prefix="JOB_QUEUE_")


class QueryGenerationDaemonSettings(AetherBaseSettings):
    """Query generation daemon configuration (proactive-IR paper)."""
    enabled: bool = True
    check_interval_seconds: int = 60  # Check for new logs every minute
    batch_size: int = 100
    context_size: int = 5  # Paper optimal: m=5
    log_level: str = "INFO"
    
    # Per-service provider override (default: aether_inference, model from central config)
    provider_config: ServiceProviderConfig = Field(default_factory=ServiceProviderConfig)
    
    # LLM settings (optional override, defaults to main LLM)
    llm_model: Optional[str] = None  # If None, uses main LLM model from settings.llm
    llm_timeout_seconds: float = 120.0  # 2 minutes for cross-source analysis
    
    # Query generation settings (from proactive-IR paper)
    max_query_terms: int = 100  # Increased to prevent truncation
    use_lowercase: bool = True  # Paper spec
    remove_special_chars: bool = True  # Paper spec
    
    model_config = SettingsConfigDict(env_prefix="DAEMON_QUERY_GENERATION_")


class ProactiveDaemonsSettings(AetherBaseSettings):
    """Proactive daemons configuration.
    
    5 unified daemons:
      Source (3): browser, email, file_system
      Processing (2): query_generation, file_indexing
    """
    browser_enabled: bool = True
    email_enabled: bool = True
    file_system_enabled: bool = True
    query_generation_enabled: bool = True
    file_indexing_enabled: bool = True
    
    # Supervisor settings
    supervisor_enabled: bool = True
    supervisor_check_interval_seconds: int = 60
    supervisor_auto_start: bool = True
    supervisor_auto_restart: bool = True
    supervisor_use_supabase_prefs: bool = True
    
    model_config = SettingsConfigDict(env_prefix="PROACTIVE_DAEMONS_")


class ProactiveCleanupSettings(AetherBaseSettings):
    """Proactive logs cleanup configuration."""
    enabled: bool = True
    retention_days: int = 1  # Delete logs older than 1 day (recent log heap only)
    cron_hour_utc: int = 3  # Run at 3:00 AM UTC
    cron_minute_utc: int = 0
    
    model_config = SettingsConfigDict(env_prefix="PROACTIVE_CLEANUP_")


class BrowserDaemonSettings(AetherBaseSettings):
    """Browser history logging daemon configuration."""
    enabled: bool = True
    scan_interval_seconds: int = 2  # Heartbeat mode: check browser every 2s for real-time detection
    retention_days: int = 1  # Recent log heap: 1 day
    bm25_index_interval_seconds: int = 30  # Index every 30 seconds
    log_level: str = "INFO"
    
    # Browser support
    browser: str = "edge"  # edge|chrome|chromium|firefox
    auto_detect_profiles: bool = True
    excluded_profiles: List[str] = []  # Profiles to exclude from indexing (e.g., ["Default", "Profile 2"])
    
    model_config = SettingsConfigDict(env_prefix="DAEMON_BROWSER_")


class EmailDaemonSettings(AetherBaseSettings):
    """Email logging daemon configuration."""
    enabled: bool = True
    scan_interval_seconds: int = 2  # Heartbeat mode: check email every 2s for real-time detection
    retention_days: int = 1  # Recent log heap: 1 day
    bm25_index_interval_seconds: int = 30  # Index every 30 seconds
    log_level: str = "INFO"
    
    # macOS: Uses AppleScript (no config needed)
    # Windows: FUTURE_WORK - Outlook COM API access (Section 7.2)
    max_emails_per_scan: int = 50  # Limit emails per scan to avoid slowdown
    
    model_config = SettingsConfigDict(env_prefix="DAEMON_EMAIL_")


class FileSystemDaemonSettings(AetherBaseSettings):
    """Filesystem event logging daemon configuration."""
    enabled: bool = True
    retention_days: int = 1  # Recent log heap: 1 day
    bm25_index_interval_seconds: int = 30  # Index every 30 seconds
    log_level: str = "INFO"
    
    # Watch settings — empty until user configures via onboarding/settings
    watch_locations: List[str] = []
    debounce_seconds: int = 1
    
    # Event types to track
    track_created: bool = True
    track_modified: bool = True
    track_deleted: bool = True
    track_moved: bool = True
    
    model_config = SettingsConfigDict(env_prefix="DAEMON_FILESYSTEM_")


class ProactiveAgentWorkerSettings(AetherBaseSettings):
    """Proactive Agent Worker configuration (Phase 2 in-app worker).
    
    Auto-summarization is disabled by default. User enables via settings.
    """
    enabled: bool = True  # Enabled for testing UI notifications
    heartbeat_interval_seconds: int = 10  # Check for queries every 10s (near real-time)
    max_processing_time_seconds: int = 300  # Max 5min per query (timeout)
    
    model_config = SettingsConfigDict(env_prefix="PROACTIVE_AGENT_WORKER_")


class ProactiveSettings(AetherBaseSettings):
    """Proactive context injection system configuration (NO HARDCODING)."""
    enabled: bool = True  # Master switch -- daemons run by default
    daemons: ProactiveDaemonsSettings = Field(default_factory=ProactiveDaemonsSettings)
    query_generation: QueryGenerationDaemonSettings = Field(default_factory=QueryGenerationDaemonSettings)
    cleanup: ProactiveCleanupSettings = Field(default_factory=ProactiveCleanupSettings)
    agent_worker: ProactiveAgentWorkerSettings = Field(default_factory=ProactiveAgentWorkerSettings)
    
    # Individual daemon configs
    browser: BrowserDaemonSettings = Field(default_factory=BrowserDaemonSettings)
    email: EmailDaemonSettings = Field(default_factory=EmailDaemonSettings)
    filesystem: FileSystemDaemonSettings = Field(default_factory=FileSystemDaemonSettings)
    
    model_config = SettingsConfigDict(env_prefix="PROACTIVE_")


class WorkerSettings(AetherBaseSettings):
    """Background worker configuration (NO HARDCODING - all from WORKER_ env vars)."""

    enabled: bool = True

    # Polling configuration
    poll_interval: float = Field(default=30.0, description="Seconds between pending_jobs polling cycles")
    batch_size: int = Field(default=5, description="Maximum jobs to process per poll cycle")
    max_concurrent: int = Field(default=3, description="Maximum concurrent job executions")

    # Health monitoring
    health_check_interval: float = Field(default=60.0, description="Seconds between health check logs")
    health_log_to_db: bool = Field(default=True, description="Whether to log health status to database")

    # Error handling
    max_retries: int = Field(default=3, description="Maximum retry attempts for failed jobs")
    retry_delay: float = Field(default=5.0, description="Seconds to wait before retrying failed job")
    shutdown_timeout: float = Field(default=30.0, description="Seconds to wait for graceful shutdown")

    # Job timeouts (seconds) - NO HARDCODING, all from WORKER_*_TIMEOUT env vars
    summarization_timeout: float = Field(default=600.0, description="Timeout for chat summarization jobs")
    memory_extraction_timeout: float = Field(default=600.0, description="Timeout for memory extraction jobs")
    promotion_timeout: float = Field(default=300.0, description="Timeout for memory promotion jobs")

    # Agent job timeouts (NO HARDCODING - configurable via WORKER_AGENT_* env vars)
    agent_memory_timeout: float = Field(default=600.0, description="Timeout for agent_memory jobs")
    agent_research_timeout: float = Field(default=1200.0, description="Timeout for agent_research jobs")
    
    # Proactive job timeouts
    proactive_cleanup_timeout: float = Field(default=60.0, description="Timeout for proactive cleanup jobs")
    
    # Job queue settings (nested for organization)
    job_queue: JobQueueSettings = Field(default_factory=JobQueueSettings)

    model_config = SettingsConfigDict(env_prefix="WORKER_")
