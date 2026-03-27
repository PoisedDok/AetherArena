"""
Profile Manager - Profile discovery and loading for Open Interpreter

@.architecture
Incoming: api/v1/endpoints/profiles.py, Local filesystem (Aether-owned profiles directory) --- {profile discovery/loading/metadata requests, .yaml profile files}
Processing: discover_profiles(), get_profile_path(), load_profile_content(), get_default_profile(), has_profile(), list_profile_names(), get_profile_metadata(), clear_cache(), _get_profiles_directories(), _get_profiles_directory(), get_health_status() --- {JOB_CACHE_WRITE, JOB_FILE_READ, JOB_RESOLVE_PATH}
Outgoing: api/v1/endpoints/profiles.py --- {List[Dict[str, str]] profile metadata with name/path/type, str file content, Optional[Path] profile path}

Handles:
- Profile file discovery from Aether-owned profile templates
- Profile loading and application
- Profile metadata extraction
- Profile previews for UI selection

Production Features:
- Deterministic profile discovery (no legacy path hunting)
- Safe profile discovery with error handling
- Support for .yaml profiles (Aether-owned)
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
    - Discovers profiles from Aether-owned templates
    - Loads .yaml profile files
    - Provides profile metadata
    - Supports UI previewing and selection
    """

    def __init__(self):
        """Initialize profile manager"""
        self._profiles_cache: Optional[List[Dict[str, str]]] = None
        self._profile_dirs: Optional[List[Path]] = None

    def discover_profiles(self) -> List[Dict[str, str]]:
        """
        Discover all available profiles from OI installation.
        
        Returns:
            List of profile metadata dicts with name, path, type
        """
        if self._profiles_cache is not None:
            return self._profiles_cache

        profiles = []
        profile_dirs = self._get_profiles_directories()
        
        if not profile_dirs:
            logger.warning("Profiles directory not found")
            return []

        try:
            seen: set[str] = set()
            for profiles_dir in profile_dirs:
                for profile_file in sorted(profiles_dir.iterdir()):
                    if not profile_file.is_file():
                        continue
                    if profile_file.suffix.lower() not in {".py", ".yaml", ".yml"}:
                        continue
                    key = profile_file.name.lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    profiles.append({
                        "name": profile_file.name,
                        "path": str(profile_file.resolve()),
                        "type": profile_file.suffix[1:],  # Remove leading dot
                        "basename": profile_file.stem,
                        "display_name": profile_file.stem.replace("_", " "),
                        "source": str(profiles_dir),
                    })

            self._profiles_cache = profiles
            logger.info("Discovered %d profiles", len(profiles))
            return profiles

        except Exception as e:
            logger.error("Failed to discover profiles: %s", e)
            return []

    def get_profile_path(self, profile_name: str) -> Optional[Path]:
        """
        Get path to a specific profile file.
        
        Args:
            profile_name: Profile filename (with or without extension)
            
        Returns:
            Path to profile file or None if not found
        """
        from pathlib import Path as _Path

        candidates = []
        if profile_name:
            candidates.append(profile_name)
            candidates.append(_Path(profile_name).name)
            # Add basename without extension
            candidates.append(_Path(profile_name).stem)

        extensions = ["", ".py", ".yaml", ".yml"]

        for profiles_dir in self._get_profiles_directories():
            for candidate in candidates:
                if not candidate:
                    continue
                for ext in extensions:
                    candidate_name = candidate if candidate.endswith(ext) else candidate + ext
                    candidate_path = profiles_dir / candidate_name
                    if candidate_path.exists():
                        return candidate_path.resolve()

        logger.warning("Profile not found: %s", profile_name)
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
            with open(profile_path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            logger.error("Failed to load profile %s: %s", profile_name, e)
            return None

    def get_default_profile(self) -> str:
        """
        Get default profile name (Aether-owned).
        
        Returns:
            Default profile filename
        """
        return "GURU.yaml"

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
        self._profile_dirs = None
        logger.debug("Cleared profile cache")

    # ============================================================================
    # PRIVATE HELPERS
    # ============================================================================

    def _get_profiles_directories(self) -> List[Path]:
        """
        Get list of directories to search for profiles.
        
        Returns:
            List of profile directories (may be empty)
        """
        if self._profile_dirs is not None:
            return self._profile_dirs

        directories: List[Path] = []
        seen: set[Path] = set()

        # Legal-clean rule: do NOT scan for vendored/legacy Open Interpreter trees.
        # Aether owns its profiles as plain data in `core/profiles/templates`.
        
        # Packaged-aware path resolution
        import sys
        if hasattr(sys, '_MEIPASS'):
            templates_dir = Path(sys._MEIPASS) / "core" / "profiles" / "templates"
        else:
            templates_dir = Path(__file__).parent / "templates"

        if templates_dir.exists() and templates_dir.is_dir():
            resolved_templates = templates_dir.resolve()
            if resolved_templates not in seen:
                directories.append(resolved_templates)
                seen.add(resolved_templates)
                logger.debug("Added profile templates directory: %s", resolved_templates)

        self._profile_dirs = directories
        return directories

    def _get_profiles_directory(self) -> Optional[Path]:
        """Return the first profiles directory (if any)."""
        dirs = self._get_profiles_directories()
        return dirs[0] if dirs else None

    def load_profile_config(self, profile_name: str) -> Optional[Dict[str, Any]]:
        """
        Load structured configuration for a profile if available.
        
        Supports YAML/YML profiles. Returns parsed dict or None.
        """
        profile_path = self.get_profile_path(profile_name)
        if not profile_path:
            return None

        suffix = profile_path.suffix.lower()
        if suffix not in {".yaml", ".yml"}:
            return None

        try:
            import yaml

            with open(profile_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
                if isinstance(data, dict):
                    return data
                logger.warning("Profile %s YAML is not a dict; ignoring", profile_name)
        except Exception as exc:
            logger.error("Failed to parse profile config %s: %s", profile_name, exc)
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

