"""Filesystem daemon configuration.

@.architecture
Incoming: daemon_manager._start_daemons() --- {classmethod call}
Processing: Load from Pydantic Settings, merge config_override.json (user overrides) --- {1 job: JOB_LOAD_CONFIG}
Outgoing: FileSystemDaemonConfig dataclass --- {dataclass instance}
"""
import json
import logging
import os
from dataclasses import dataclass, field
from typing import List
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class FileSystemDaemonConfig:
    """Configuration for Filesystem event logging daemon."""
    
    service_name: str = "filesystem_daemon"
    app_root: Path = None
    db_path: Path = None
    
    # Settings
    retention_days: int = 1
    bm25_index_interval_seconds: int = 30
    log_level: str = "INFO"
    
    # Watch settings
    watch_locations: List[str] = field(default_factory=list)
    debounce_seconds: int = 2
    
    # Event types
    track_created: bool = True
    track_modified: bool = True
    track_deleted: bool = True
    track_moved: bool = True
    
    @classmethod
    def from_settings(cls) -> 'FileSystemDaemonConfig':
        """Load configuration from central backend settings, then merge user overrides.
        
        Override chain: Pydantic Settings defaults → config_override.json (user values).
        The override file is written by POST /v1/file/daemon/config and carries HOW-to-run
        settings (watch_locations). It does NOT carry enabled/disabled state —
        that flows through proactive_config.json via the daemon manager.
        """
        try:
            from config.settings import get_settings
            settings = get_settings()
            daemon_cfg = settings.proactive.filesystem
            
            app_root = settings.app_root
            db_dir = app_root / "data" / "daemons" / "filesystem"
            db_dir.mkdir(parents=True, exist_ok=True)
            
            # Start with settings watch_locations, then check override file
            watch_locations = list(daemon_cfg.watch_locations)
            
            # Read user override file (written by POST /v1/file/daemon/config).
            # Override file takes priority over settings for watch_locations.
            override_path = db_dir / "config_override.json"
            if override_path.exists():
                try:
                    with open(override_path, 'r') as f:
                        overrides = json.load(f)
                    if isinstance(overrides, dict) and "watch_locations" in overrides:
                        override_locs = overrides["watch_locations"]
                        if isinstance(override_locs, list):
                            watch_locations = [
                                loc for loc in override_locs
                                if loc and isinstance(loc, str)
                            ]
                            logger.info(
                                "Applied filesystem config override: %d watch locations from %s",
                                len(watch_locations), override_path
                            )
                except (json.JSONDecodeError, OSError, TypeError) as e:
                    logger.warning("Failed to read filesystem config override %s: %s", override_path, e)
            
            # Resolve watch_locations relative to backend root
            # AETHER_BACKEND_ROOT is stable (set in app.py at startup), unlike os.getcwd()
            resolved_watch_locations = []
            
            backend_root_env = os.getenv("AETHER_BACKEND_ROOT")
            if backend_root_env:
                workspace_root = Path(backend_root_env)
            else:
                # Dev fallback: resolve from this file's location (deterministic)
                workspace_root = Path(__file__).resolve().parents[3]
            
            # BUG FIX: Previously used daemon_cfg.watch_locations here instead of the
            # local watch_locations variable, making the override/fallback logic dead code.
            for loc in watch_locations:
                if loc:
                    loc_path = Path(loc)
                    if not loc_path.is_absolute():
                        # Relative to workspace root
                        loc_path = workspace_root / loc
                    
                    # Expand and resolve
                    loc_path = loc_path.expanduser().resolve()
                    
                    if loc_path.exists():
                        resolved_watch_locations.append(str(loc_path))
                    else:
                        logger.warning("Watch location does not exist: %s", loc_path)
            
            if not resolved_watch_locations:
                logger.warning("No valid watch locations configured")
            
            return cls(
                app_root=app_root,
                db_path=db_dir / "logs.db",
                retention_days=daemon_cfg.retention_days,
                bm25_index_interval_seconds=daemon_cfg.bm25_index_interval_seconds,
                log_level=daemon_cfg.log_level,
                watch_locations=resolved_watch_locations,
                debounce_seconds=daemon_cfg.debounce_seconds,
                track_created=daemon_cfg.track_created,
                track_modified=daemon_cfg.track_modified,
                track_deleted=daemon_cfg.track_deleted,
                track_moved=daemon_cfg.track_moved
            )
        except Exception as e:
            logger.warning("Could not load backend settings for FileSystemDaemon: %s", e)
            app_root = Path.home() / ".aetherarena"
            db_dir = app_root / "data" / "daemons" / "filesystem"
            db_dir.mkdir(parents=True, exist_ok=True)
            return cls(
                app_root=app_root,
                db_path=db_dir / "logs.db"
            )
    
    def validate(self) -> None:
        """Validate configuration."""
        if not self.db_path:
            raise ValueError("db_path is required")
