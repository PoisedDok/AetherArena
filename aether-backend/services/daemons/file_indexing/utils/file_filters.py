"""
@.architecture
Incoming: services/file_indexing/core/scanner.py --- {Path object, patterns list}
Processing: apply glob pattern matching for file filtering --- {1 job: JOB_FILTER}
Outgoing: services/file_indexing/core/scanner.py --- {bool, match result}
"""

from pathlib import Path
from fnmatch import fnmatch
from typing import List


def matches_pattern(file_path: Path, patterns: List[str]) -> bool:
    """
    Check if file path matches any of the glob patterns.
    
    Args:
        file_path: Path to check
        patterns: List of glob patterns
        
    Returns:
        True if path matches any pattern
    """
    path_str = str(file_path)
    
    for pattern in patterns:
        # Normalize pattern to ensure ** works correctly
        if not pattern.startswith("**/"):
            pattern = f"**/{pattern}"
        
        if fnmatch(path_str, pattern):
            return True
    
    return False


def should_exclude(file_path: Path, exclude_patterns: List[str]) -> bool:
    """
    Check if file should be excluded based on patterns.
    
    Args:
        file_path: Path to check
        exclude_patterns: List of exclusion glob patterns
        
    Returns:
        True if file should be excluded
    """
    return matches_pattern(file_path, exclude_patterns)

