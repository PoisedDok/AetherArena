"""
Proactive Configuration Service

Domain service for managing proactive agent configuration overrides and checking
status of related daemons (filesystem).
"""

from core.domain.repository_interfaces import IConfigurationRepository
import sys
from typing import Dict, Any, List

from config.settings import Settings
from config.proactive_config_reader import read_proactive_config
from monitoring import get_logger

logger = get_logger(__name__)

class ProactiveConfigService:
    """Service to handle proactive configuration updates and status checks."""

    def __init__(self, settings: Settings, config_repo: IConfigurationRepository):
        self._settings = settings
        self._config_repo = config_repo

    def get_current_config(self) -> Any:
        """Get the current unified proactive configuration."""
        return read_proactive_config(self._settings)

    def update_config(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Update proactive agent configuration.
        Takes the incoming partial request and merges it with current config,
        then safely writes to disk.
        """
        config_file = self._settings.app_root / "data" / "runtime" / "proactive_config.json"
        
        # Current config serves as base
        current_config = self._config_repo.read_config(config_file) or {}
        
        # Apply master switch
        if "enabled" in request_data and request_data["enabled"] is not None:
            current_config["enabled"] = request_data["enabled"]
            logger.info("User %s proactive agent (master switch)", "enabled" if request_data["enabled"] else "disabled")
            
        if "worker_enabled" in request_data and request_data["worker_enabled"] is not None:
            current_config["worker_enabled"] = request_data["worker_enabled"]
            logger.info("User %s proactive worker", "enabled" if request_data["worker_enabled"] else "disabled")
            
        if "heartbeat_interval_seconds" in request_data and request_data["heartbeat_interval_seconds"] is not None:
            current_config["heartbeat_interval_seconds"] = request_data["heartbeat_interval_seconds"]
            logger.info("User set worker heartbeat to %ds", request_data["heartbeat_interval_seconds"])
            
        daemon_changed = False
        for daemon_field in ("browser_enabled", "email_enabled", "file_system_enabled",
                             "query_generation_enabled", "file_indexing_enabled"):
            if daemon_field in request_data and request_data[daemon_field] is not None:
                current_config[daemon_field] = request_data[daemon_field]
                logger.info("User %s %s daemon", "enabled" if request_data[daemon_field] else "disabled", daemon_field.replace('_enabled', ''))
                daemon_changed = True

        # Defensive normalization: email daemon is macOS-only.
        if sys.platform != "darwin" and current_config.get("email_enabled", False):
            current_config["email_enabled"] = False
            daemon_changed = True
            logger.info("Forced email daemon disabled on unsupported platform: %s", sys.platform)
            
        # Write config safely
        success = self._config_repo.write_config(config_file, current_config)
        if not success:
            raise RuntimeError("Failed to persist configuration.")
            
        logger.info("Proactive config updated: %s", current_config)
        
        # Handle daemon manager reload
        daemon_reload_status = "not_requested"
        if daemon_changed or ("enabled" in request_data and request_data["enabled"] is not None):
            try:
                from services.daemons.daemon_control import is_onboarding_setup_mode, reload_daemon_manager
                if is_onboarding_setup_mode():
                    daemon_reload_status = "skipped_onboarding_setup_mode"
                    logger.info("Skipping daemon manager reload during onboarding setup mode")
                else:
                    reload_daemon_manager()
                    daemon_reload_status = "signaled"
                    logger.info("Daemon manager reload signal sent")
            except Exception as daemon_error:
                daemon_reload_status = "failed"
                logger.warning("Failed to reload daemons: %s", daemon_error)
                
        daemon_reload_note = {
            "signaled": "daemons reloaded immediately.",
            "skipped_onboarding_setup_mode": "daemon reload skipped during onboarding setup mode.",
            "failed": "daemon reload failed; changes apply on next manager restart.",
            "not_requested": "daemon reload not required."
        }.get(daemon_reload_status, "daemon reload state unknown.")
        
        return {
            "success": True,
            "message": (
                f"Configuration updated. Worker reloads on next heartbeat "
                f"(~{self._settings.proactive.agent_worker.heartbeat_interval_seconds}s), "
                f"{daemon_reload_note}"
            ),
            "config": current_config
        }

    def get_filesystem_watch_locations(self) -> List[str]:
        """
        Read watch_locations from the SAME source daemons use: settings + config_override.json.
        """
        watch_locations = list(self._settings.proactive.filesystem.watch_locations)

        override_path = self._settings.app_root / "data" / "daemons" / "filesystem" / "config_override.json"
        overrides = self._config_repo.read_config(override_path)
        
        if overrides and isinstance(overrides, dict) and "watch_locations" in overrides:
            override_locs = overrides["watch_locations"]
            if isinstance(override_locs, list):
                watch_locations = [
                    loc for loc in override_locs
                    if loc and isinstance(loc, str)
                ]
                
        return watch_locations



    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
