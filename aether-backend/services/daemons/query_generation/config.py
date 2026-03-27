"""Query generation daemon configuration."""
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict

logger = logging.getLogger(__name__)



@dataclass
class QueryGenerationDaemonConfig:
    """Configuration for Query Generation daemon."""
    
    service_name: str = "query_generation_daemon"
    app_root: Path = None
    db_path: Path = None
    
    # Processing settings
    check_interval_seconds: int = 60  # Check for new logs every minute
    batch_size: int = 100  # Process up to 100 logs at a time
    context_size: int = 5  # Number of documents to use as context (paper optimal: 5)
    log_level: str = "INFO"
    bm25_index_interval_seconds: int = 300  # Index to BM25 every 5 minutes
    
    # LLM settings (auto-detected from main app)
    llm_provider: str = None  # Loaded from backend settings
    llm_model: str = None  # Loaded from backend settings
    llm_api_base: str = None  # Loaded from backend settings
    llm_api_key: str = None  # Loaded from backend settings
    llm_timeout_seconds: float = 300.0
    llm_temperature: float = 0.6   # From _AGENT_GENERATION_DEFAULTS["query_gen"]
    llm_max_tokens: int = 4096    # 4K -- give reasoning models room to think
    
    # Query generation settings (from proactive-IR paper)
    max_query_terms: int = 100  # Increased to prevent truncation of LLM output
    use_lowercase: bool = True  # Paper spec: lowercase
    remove_special_chars: bool = True  # Paper spec: no special chars
    
    # Priority thresholds (per-source minimum to count as active)
    # email/fs: 1 log triggers (every email/file change is significant)
    # browser: 2 logs trigger (matches coherent-engagement minimum: 2+ related visits)
    # active_windows: REMOVED from pipeline (too noisy - 720 logs/hour vs ~50/day for filesystem)
    # NOTE: cross-source aggregation in daemon.py includes below-threshold sources
    # when ANY source is above its threshold, so mixed-source context is never lost.
    priority_thresholds: Dict[str, int] = field(default_factory=lambda: {
        "email": 1,
        "filesystem": 1,
        "browser": 2
    })
    
    @classmethod
    def from_settings(cls) -> 'QueryGenerationDaemonConfig':
        """Load configuration from central backend settings + user preferences."""
        try:
            from config.settings import get_settings
            settings = get_settings()
            daemon_cfg = settings.proactive.query_generation
            
            app_root = settings.app_root
            db_dir = app_root / "data" / "daemons" / "query_generation"
            db_dir.mkdir(parents=True, exist_ok=True)
            
            # Resolve per-service provider from central config (defaults to aether-inference).
            # Query generation is part of the proactive pipeline — uses the main agent
            # model (Qwen3) for strong cross-source pattern detection, NOT the lightweight
            # text model (LFM) which is reserved for summarization only.
            api_base, model, api_key = settings.resolve_service_provider(
                daemon_cfg.provider_config, service_type="agent"
            )
            
            # Allow llm_model override from daemon-specific config (backward compat)
            if daemon_cfg.llm_model:
                model = daemon_cfg.llm_model
            
            # Try to load user preferences from local override file (written by API)
            try:
                import json
                override_path = app_root / "data" / "daemons" / "query_generation" / "config_override.json"
                if override_path.exists():
                    with open(override_path, 'r') as f:
                        overrides = json.load(f)
                        if overrides.get("llm_model"):
                            model = overrides["llm_model"]
            except Exception:
                pass  # Fallback to resolved provider if override file unavailable
            
            # Determine provider string for logging/identification
            provider_str = (daemon_cfg.provider_config.provider or "aether_inference").strip() or "aether_inference"
            
            # Pull smart generation defaults from central config
            gen_params = settings.inference.get_agent_generation_params("query_gen")

            return cls(
                app_root=app_root,
                db_path=db_dir / "queries.db",
                check_interval_seconds=daemon_cfg.check_interval_seconds,
                batch_size=daemon_cfg.batch_size,
                context_size=daemon_cfg.context_size,
                log_level=daemon_cfg.log_level,
                llm_provider=provider_str,
                llm_model=model,
                llm_api_base=api_base,
                llm_api_key=api_key,
                llm_timeout_seconds=daemon_cfg.llm_timeout_seconds,
                llm_temperature=gen_params["temperature"],
                llm_max_tokens=gen_params["max_tokens"],
                max_query_terms=daemon_cfg.max_query_terms,
                use_lowercase=daemon_cfg.use_lowercase,
                remove_special_chars=daemon_cfg.remove_special_chars
            )
        except Exception as e:
            logger.warning("Could not load backend settings for QueryGenerationDaemon: %s", e)
            # Fallback: read from centralized TOML config (no hardcoded values)
            from utils.config import load_config
            fallback_cfg = load_config()
            providers = fallback_cfg.get("PROVIDERS", {})
            models = fallback_cfg.get("MODELS", {})
            
            app_root = Path.home() / ".aetherarena"
            db_dir = app_root / "data" / "daemons" / "query_generation"
            db_dir.mkdir(parents=True, exist_ok=True)
            return cls(
                app_root=app_root,
                db_path=db_dir / "queries.db",
                llm_api_base=providers.get("aether_inference_url", "http://127.0.0.1:7090/v1"),
                llm_model=models.get("primary_chat_model", "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"),
                llm_provider="aether_inference"
            )
    
    def validate(self) -> None:
        """Validate configuration."""
        if self.check_interval_seconds < 1:
            raise ValueError("check_interval_seconds must be >= 1")
        if not self.db_path:
            raise ValueError("db_path is required")
        if self.context_size < 1:
            raise ValueError("context_size must be >= 1")
        if self.max_query_terms < 1:
            raise ValueError("max_query_terms must be >= 1")
