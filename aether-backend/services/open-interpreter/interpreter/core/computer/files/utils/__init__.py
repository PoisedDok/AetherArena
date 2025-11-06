"""Utility modules for the file system."""

from .file_utils import (
    normalize_path, 
    get_file_info, 
    get_file_type,
    format_file_size,
    format_permissions,
    is_hidden_file,
    get_common_paths
)

from .config import FileSystemConfig
