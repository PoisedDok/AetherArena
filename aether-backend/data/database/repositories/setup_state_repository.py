"""
Setup State Repository

Abstracts the persistence of setup progress state (e.g., logs/setup_progress.json).
"""

from core.domain.repository_interfaces import ISetupStateRepository

import json
from pathlib import Path
from typing import Dict, Any, Optional

from config.settings import get_app_root
from monitoring import get_logger

logger = get_logger(__name__)


class SetupStateRepository(ISetupStateRepository):
    """Repository for reading and writing setup progress state."""

    def __init__(self, backend_root: Optional[Path] = None):
        self._backend_root = backend_root or get_app_root()
        self._progress_file = self._backend_root / "logs" / "setup_progress.json"
        self._onboarding_state_file = self._backend_root / "logs" / "onboarding_state.json"

    def get_progress(self) -> Optional[Dict[str, Any]]:
        """Read the current setup progress from disk."""
        if not self._progress_file.exists():
            return None
        
        try:
            with open(self._progress_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logger.warning("Failed to read setup progress file: %s", e)
            return None

    def save_progress(self, progress_data: Dict[str, Any]) -> bool:
        """Write the setup progress to disk."""
        try:
            self._progress_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self._progress_file, 'w', encoding='utf-8') as f:
                json.dump(progress_data, f)
            return True
        except Exception as e:
            logger.error("Failed to write setup progress file: %s", e)
            return False

    def get_onboarding_state(self) -> Optional[Dict[str, Any]]:
        """Read the current onboarding UI state from disk."""
        if not self._onboarding_state_file.exists():
            return None
        
        try:
            with open(self._onboarding_state_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logger.warning("Failed to read onboarding state file: %s", e)
            return None

    def save_onboarding_state(self, state_data: Dict[str, Any]) -> bool:
        """Write the onboarding UI state to disk."""
        try:
            self._onboarding_state_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self._onboarding_state_file, 'w', encoding='utf-8') as f:
                json.dump(state_data, f)
            return True
        except Exception as e:
            logger.error("Failed to write onboarding state file: %s", e)
            return False

    def get_log_file_path(self) -> Path:
        """Get the path to the setup log file."""
        return self._backend_root / "logs" / "setup_script.log"
