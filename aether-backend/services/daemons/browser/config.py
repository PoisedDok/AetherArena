"""Browser daemon configuration.

@.architecture
Incoming: daemon_manager._start_daemons() --- {classmethod call}
Processing: Load from Pydantic Settings, merge config_override.json (user overrides) --- {1 job: JOB_LOAD_CONFIG}
Outgoing: BrowserDaemonConfig dataclass --- {dataclass instance}
"""
import json
import logging
from dataclasses import dataclass
from typing import List
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class BrowserDaemonConfig:
    """Configuration for Browser history logging daemon."""
    
    service_name: str = "browser_daemon"
    app_root: Path = None
    db_path: Path = None
    
    # Scanning settings (heartbeat mode for real-time detection)
    scan_interval_seconds: int = 2
    retention_days: int = 1
    bm25_index_interval_seconds: int = 30
    log_level: str = "INFO"
    
    # Browser settings
    browser: str = "edge"
    auto_detect_profiles: bool = True
    excluded_profiles: List[str] = None
    enabled: bool = True
    
    @classmethod
    def from_settings(cls) -> 'BrowserDaemonConfig':
        """Load configuration from central backend settings, then merge user overrides.
        
        Override chain: Pydantic Settings defaults → config_override.json (user values).
        The override file is written by POST /v1/file/daemon/config and carries HOW-to-run
        settings (browser selection, profiles). It does NOT carry enabled/disabled state —
        that flows through proactive_config.json via the daemon manager.
        """
        try:
            from config.settings import get_settings
            settings = get_settings()
            daemon_cfg = settings.proactive.browser
            
            app_root = settings.app_root
            db_dir = app_root / "data" / "daemons" / "browser"
            db_dir.mkdir(parents=True, exist_ok=True)
            
            config = cls(
                app_root=app_root,
                db_path=db_dir / "logs.db",
                scan_interval_seconds=daemon_cfg.scan_interval_seconds,
                retention_days=daemon_cfg.retention_days,
                bm25_index_interval_seconds=daemon_cfg.bm25_index_interval_seconds,
                log_level=daemon_cfg.log_level,
                browser=daemon_cfg.browser,
                auto_detect_profiles=daemon_cfg.auto_detect_profiles,
                excluded_profiles=daemon_cfg.excluded_profiles or [],
                enabled=daemon_cfg.enabled
            )
            
            # Merge user override file (written by POST /v1/file/daemon/config).
            # Override file is in the daemon's data directory (same as db_path).
            config._apply_override(db_dir / "config_override.json")
            
            return config
        except Exception as e:
            logger.warning("Could not load backend settings for BrowserDaemon: %s", e)
            app_root = Path.home() / ".aetherarena"
            db_dir = app_root / "data" / "daemons" / "browser"
            db_dir.mkdir(parents=True, exist_ok=True)
            return cls(
                app_root=app_root,
                db_path=db_dir / "logs.db"
            )
    
    def _apply_override(self, override_path: Path) -> None:
        """Merge user config override file into this config instance.
        
        Only overrides HOW-to-run fields (browser selection, profiles).
        Unknown keys are silently ignored for forward compatibility.
        Corrupt/missing files fall back to settings defaults (no error).
        """
        if not override_path.exists():
            return
        try:
            with open(override_path, 'r') as f:
                overrides = json.load(f)
            if not isinstance(overrides, dict):
                logger.warning("Browser config override is not a dict: %s", type(overrides).__name__)
                return
            
            if "browser" in overrides and isinstance(overrides["browser"], str):
                self.browser = overrides["browser"]
            if "auto_detect_profiles" in overrides and isinstance(overrides["auto_detect_profiles"], bool):
                self.auto_detect_profiles = overrides["auto_detect_profiles"]
            if "excluded_profiles" in overrides and isinstance(overrides["excluded_profiles"], list):
                self.excluded_profiles = overrides["excluded_profiles"]
            if "scan_interval_seconds" in overrides and isinstance(overrides["scan_interval_seconds"], int):
                self.scan_interval_seconds = max(1, overrides["scan_interval_seconds"])
            if "log_level" in overrides and isinstance(overrides["log_level"], str):
                self.log_level = overrides["log_level"]
            
            logger.info("Applied browser config override from %s (browser=%s)", override_path, self.browser)
        except (json.JSONDecodeError, OSError, TypeError) as e:
            logger.warning("Failed to read browser config override %s: %s", override_path, e)
    
    def validate(self) -> None:
        """Validate configuration."""
        if self.scan_interval_seconds < 1:
            raise ValueError("scan_interval_seconds must be >= 1")
        if not self.db_path:
            raise ValueError("db_path is required")
