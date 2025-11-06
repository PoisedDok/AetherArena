"""
Profile Manager - Profile discovery and loading for Open Interpreter

@.architecture
Incoming: utils/oi_paths.py, api/v1/endpoints/profiles.py, Local filesystem (OI profiles directory) --- {candidate_open_interpreter_paths(), profile discovery/loading/metadata requests, .py/.yaml/.yml profile files}
Processing: discover_profiles(), get_profile_path(), load_profile_content(), get_default_profile(), has_profile(), list_profile_names(), get_profile_metadata(), clear_cache(), _get_profiles_directory(), get_health_status() --- {6 jobs: caching, file_reading, filesystem_scanning, health_checking, metadata_extraction, path_resolution}
Outgoing: api/v1/endpoints/profiles.py --- {List[Dict[str, str]] profile metadata with name/path/type, str file content, Optional[Path] profile path}

Handles:
- Profile file discovery from OI's profiles/defaults directory
- Profile loading and application
- Profile metadata extraction
- Integration with OI's profile system

Production Features:
- Path resolution across different OI installations
- Safe profile discovery with error handling
- Support for both .py and .yaml profiles
- Profile caching for performance
"""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ProfileManager:
    """
    Manages Open Interpreter profiles with discovery and loading capabilities.
    
    Features:
    - Discovers profiles from OI installation
    - Loads .py and .yaml profile files
    - Provides profile metadata
    - Integrates with OI's profile application system
    """

    def __init__(self):
        """Initialize profile manager"""
        self._profiles_cache: Optional[List[Dict[str, str]]] = None
        self._profiles_dir: Optional[Path] = None

    def discover_profiles(self) -> List[Dict[str, str]]:
        """
        Discover all available profiles from OI installation.
        
        Returns:
            List of profile metadata dicts with name, path, type
        """
        if self._profiles_cache is not None:
            return self._profiles_cache

        profiles = []
        profiles_dir = self._get_profiles_directory()
        
        if not profiles_dir or not profiles_dir.exists():
            logger.warning("Profiles directory not found")
            return []

        try:
            for profile_file in sorted(profiles_dir.iterdir()):
                if profile_file.is_file() and profile_file.suffix.lower() in {".py", ".yaml", ".yml"}:
                    profiles.append({
                        "name": profile_file.name,
                        "path": str(profile_file),
                        "type": profile_file.suffix[1:],  # Remove leading dot
                        "basename": profile_file.stem,
                    })
            
            self._profiles_cache = profiles
            logger.info(f"Discovered {len(profiles)} profiles")
            return profiles

        except Exception as e:
            logger.error(f"Failed to discover profiles: {e}")
            return []

    def get_profile_path(self, profile_name: str) -> Optional[Path]:
        """
        Get path to a specific profile file.
        
        Args:
            profile_name: Profile filename (with or without extension)
            
        Returns:
            Path to profile file or None if not found
        """
        profiles_dir = self._get_profiles_directory()
        
        if not profiles_dir or not profiles_dir.exists():
            return None

        # Try with given name first
        profile_path = profiles_dir / profile_name
        if profile_path.exists():
            return profile_path

        # Try with .py extension
        profile_path = profiles_dir / f"{profile_name}.py"
        if profile_path.exists():
            return profile_path

        # Try with .yaml extension
        profile_path = profiles_dir / f"{profile_name}.yaml"
        if profile_path.exists():
            return profile_path

        # Try with .yml extension
        profile_path = profiles_dir / f"{profile_name}.yml"
        if profile_path.exists():
            return profile_path

        logger.warning(f"Profile not found: {profile_name}")
        return None

    def load_profile_content(self, profile_name: str) -> Optional[str]:
        """
        Load profile file content.
        
        Args:
            profile_name: Profile filename
            
        Returns:
            Profile file content or None if not found
        """
        profile_path = self.get_profile_path(profile_name)
        
        if not profile_path:
            return None

        try:
            with open(profile_path, 'r') as f:
                return f.read()
        except Exception as e:
            logger.error(f"Failed to load profile {profile_name}: {e}")
            return None

    def get_default_profile(self) -> str:
        """
        Get default profile name (GURU.py for Aether).
        
        Returns:
            Default profile filename
        """
        return "GURU.py"

    def has_profile(self, profile_name: str) -> bool:
        """
        Check if a profile exists.
        
        Args:
            profile_name: Profile filename
            
        Returns:
            True if profile exists
        """
        return self.get_profile_path(profile_name) is not None

    def list_profile_names(self) -> List[str]:
        """
        Get list of profile names.
        
        Returns:
            List of profile filenames
        """
        profiles = self.discover_profiles()
        return [p["name"] for p in profiles]

    def get_profile_metadata(self, profile_name: str) -> Optional[Dict[str, Any]]:
        """
        Get metadata for a specific profile.
        
        Args:
            profile_name: Profile filename
            
        Returns:
            Profile metadata dict or None if not found
        """
        profiles = self.discover_profiles()
        
        for profile in profiles:
            if profile["name"] == profile_name or profile["basename"] == profile_name:
                return profile

        return None

    def clear_cache(self) -> None:
        """Clear profile discovery cache"""
        self._profiles_cache = None
        logger.debug("Cleared profile cache")

    # ============================================================================
    # PRIVATE HELPERS
    # ============================================================================

    def _get_profiles_directory(self) -> Optional[Path]:
        """
        Get path to OI profiles directory.
        
        Returns:
            Path to profiles/defaults directory or None
        """
        if self._profiles_dir is not None:
            return self._profiles_dir

        try:
            from ...utils.oi_paths import candidate_open_interpreter_paths
            
            for oi_root in candidate_open_interpreter_paths():
                profiles_dir = (
                    oi_root
                    / "interpreter"
                    / "terminal_interface"
                    / "profiles"
                    / "defaults"
                )
                
                if profiles_dir.exists() and profiles_dir.is_dir():
                    self._profiles_dir = profiles_dir
                    logger.debug(f"Found profiles directory: {profiles_dir}")
                    return profiles_dir

            logger.warning("OI profiles directory not found in any candidate path")
            return None

        except Exception as e:
            logger.error(f"Error finding profiles directory: {e}")
            return None

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of profile manager.
        
        Returns:
            Dict with health status information
        """
        profiles_dir = self._get_profiles_directory()
        profiles = self.discover_profiles()

        return {
            "profiles_dir_found": profiles_dir is not None,
            "profiles_dir_path": str(profiles_dir) if profiles_dir else None,
            "profile_count": len(profiles),
            "cache_populated": self._profiles_cache is not None,
        }

