"""
Configuration Repository

Abstracts the safe reading and writing of JSON configuration files (e.g. config overrides, proactive_config.json).
"""

from core.domain.repository_interfaces import IConfigurationRepository

import json
import os
import tempfile
from pathlib import Path
from typing import Dict, Any, Optional

from monitoring import get_logger

logger = get_logger(__name__)


class ConfigurationRepository(IConfigurationRepository):
    """Repository for reading and writing local JSON configuration files safely."""

    def read_config(self, file_path: Path) -> Optional[Dict[str, Any]]:
        """Read a JSON configuration file."""
        if not file_path.exists():
            return None
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if not isinstance(data, dict):
                    logger.warning("Configuration file %s is not a dictionary", file_path)
                    return None
                return data
        except Exception as e:
            logger.warning("Failed to read configuration file %s: %s", file_path, e)
            return None

    def write_config(self, file_path: Path, config_data: Dict[str, Any]) -> bool:
        """Write a JSON configuration file safely using atomic replace."""
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Atomic write: dump to temp file, then os.replace (POSIX atomic rename).
        fd, tmp_path = tempfile.mkstemp(
            dir=str(file_path.parent),
            suffix=".tmp",
            prefix=".config_",
        )
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump(config_data, f, indent=2)
            os.replace(tmp_path, str(file_path))
            return True
        except BaseException as e:
            try:
                os.unlink(tmp_path)
            except OSError as unlink_e:
                logger.debug("Failed to unlink temp file %s: %s", tmp_path, unlink_e)
            logger.error("Failed to write configuration to %s: %s", file_path, e)
            return False
