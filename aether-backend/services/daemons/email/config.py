"""Email daemon configuration.

@.architecture
Incoming: daemon_manager._start_daemons() --- {classmethod call}
Processing: Load from Pydantic Settings, merge config_override.json (user overrides) --- {1 job: JOB_LOAD_CONFIG}
Outgoing: EmailDaemonConfig dataclass --- {dataclass instance}
"""
import json
import logging
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class EmailDaemonConfig:
    """Configuration for Email logging daemon."""
    
    service_name: str = "email_daemon"
    app_root: Path = None
    db_path: Path = None
    
    # Scanning settings (heartbeat mode for real-time detection)
    scan_interval_seconds: int = 2
    retention_days: int = 1
    bm25_index_interval_seconds: int = 30
    log_level: str = "INFO"
    max_emails_per_scan: int = 50
    
    @classmethod
    def from_settings(cls) -> 'EmailDaemonConfig':
        """Load configuration from central backend settings, then merge user overrides.
        
        Override chain: Pydantic Settings defaults → config_override.json (user values).
        The override file is written by POST /v1/file/daemon/config. Currently email has
        no user-configurable settings beyond enabled/disabled (which flows through
        proactive_config.json, not config_override.json). Override reading is implemented
        for forward compatibility — when email-specific settings are added.
        """
        try:
            from config.settings import get_settings
            settings = get_settings()
            daemon_cfg = settings.proactive.email
            
            app_root = settings.app_root
            db_dir = app_root / "data" / "daemons" / "email"
            db_dir.mkdir(parents=True, exist_ok=True)
            
            config = cls(
                app_root=app_root,
                db_path=db_dir / "logs.db",
                scan_interval_seconds=daemon_cfg.scan_interval_seconds,
                retention_days=daemon_cfg.retention_days,
                bm25_index_interval_seconds=daemon_cfg.bm25_index_interval_seconds,
                log_level=daemon_cfg.log_level,
                max_emails_per_scan=daemon_cfg.max_emails_per_scan
            )
            
            # Read user override file (forward-compatible — no email-specific fields yet).
            override_path = db_dir / "config_override.json"
            if override_path.exists():
                try:
                    with open(override_path, 'r') as f:
                        overrides = json.load(f)
                    if isinstance(overrides, dict):
                        if "scan_interval_seconds" in overrides and isinstance(overrides["scan_interval_seconds"], int):
                            config.scan_interval_seconds = max(1, overrides["scan_interval_seconds"])
                        if "max_emails_per_scan" in overrides and isinstance(overrides["max_emails_per_scan"], int):
                            config.max_emails_per_scan = max(1, overrides["max_emails_per_scan"])
                        if "log_level" in overrides and isinstance(overrides["log_level"], str):
                            config.log_level = overrides["log_level"]
                        logger.info("Read email config override from %s", override_path)
                except (json.JSONDecodeError, OSError, TypeError) as e:
                    logger.warning("Failed to read email config override %s: %s", override_path, e)
            
            return config
        except Exception as e:
            logger.warning("Could not load backend settings for EmailDaemon: %s", e)
            app_root = Path.home() / ".aetherarena"
            db_dir = app_root / "data" / "daemons" / "email"
            db_dir.mkdir(parents=True, exist_ok=True)
            return cls(
                app_root=app_root,
                db_path=db_dir / "logs.db"
            )
    
    def validate(self) -> None:
        """Validate configuration."""
        if self.scan_interval_seconds < 1:
            raise ValueError("scan_interval_seconds must be >= 1")
        if not self.db_path:
            raise ValueError("db_path is required")
