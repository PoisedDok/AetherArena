"""
Profile Repository

Abstracts file system operations for Open Interpreter profiles.
"""

from core.domain.repository_interfaces import IProfileRepository

from typing import Dict, Any
from pathlib import Path
import aiofiles

from monitoring import get_logger

logger = get_logger(__name__)

# Max profile file size for preview (1MB)
MAX_PROFILE_SIZE = 1024 * 1024


class ProfileRepository(IProfileRepository):
    """Repository for reading profile files from disk asynchronously."""

    async def read_profile_preview(self, profile_path: Path) -> Dict[str, Any]:
        """
        Read the profile file content and return a preview.
        
        Returns a dictionary with 'content', 'preview' and 'truncated' status.
        Raises ValueError if the file is too large or not valid UTF-8.
        """
        if not profile_path.exists():
            raise FileNotFoundError(f"Profile not found: {profile_path}")
            
        stat = profile_path.stat()
        if stat.st_size > MAX_PROFILE_SIZE:
            raise ValueError(f"Profile file too large (max {MAX_PROFILE_SIZE} bytes)")
            
        try:
            async with aiofiles.open(profile_path, 'r', encoding="utf-8") as f:
                content = await f.read()
        except UnicodeDecodeError:
            raise ValueError("Profile file is not valid UTF-8 text")
            
        preview = content[:1000] if len(content) > 1000 else content
        
        return {
            "size_bytes": stat.st_size,
            "preview": preview,
            "truncated": len(content) > 1000
        }
