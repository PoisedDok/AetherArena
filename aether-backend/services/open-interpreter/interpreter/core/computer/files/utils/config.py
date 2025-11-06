"""
Configuration module for the FileSystem.

This module defines configuration settings for the file system components.
"""

import os
import platform
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Set


@dataclass
class FileSystemConfig:
    """Configuration for the FileSystem module."""
    
    # General configuration
    max_results: int = 100
    default_search_depth: int = 5
    enable_semantic_search: bool = True
    
    # Cache configuration
    use_cache: bool = True
    cache_dir: str = field(default_factory=lambda: os.path.expanduser("~/.filesearch_cache"))
    cache_expiry_minutes: int = 60
    
    # File search configuration
    index_hidden_files: bool = False
    index_system_files: bool = False
    max_file_size_mb: int = 100  # Max file size to index/extract in MB
    
    # File content extraction
    extract_text_from_binary: bool = True
    max_extraction_size_mb: int = 50
    
    # File type groups for better search optimization
    document_types: Set[str] = field(default_factory=lambda: {
        '.pdf', '.docx', '.doc', '.txt', '.md', '.rtf', '.odt'
    })
    
    code_types: Set[str] = field(default_factory=lambda: {
        '.py', '.js', '.html', '.css', '.java', '.cpp', '.c', '.h', 
        '.php', '.rb', '.go', '.rs', '.ts', '.jsx', '.tsx'
    })
    
    data_types: Set[str] = field(default_factory=lambda: {
        '.csv', '.json', '.xml', '.yaml', '.yml', '.xlsx', '.xls',
        '.db', '.sqlite', '.sql'
    })
    
    # Default paths to search based on OS
    default_search_paths: List[str] = field(default_factory=list)
    
    def __post_init__(self):
        """Setup platform-specific defaults after initialization."""
        if not self.default_search_paths:
            self.default_search_paths = self._get_default_search_paths()
        
        # Create cache directory if it doesn't exist
        if self.use_cache and not os.path.exists(self.cache_dir):
            os.makedirs(self.cache_dir, exist_ok=True)
    
    def _get_default_search_paths(self) -> List[str]:
        """Get default paths to search based on the operating system."""
        system = platform.system().lower()
        paths = []
        
        # Current working directory is always included
        paths.append(os.getcwd())
        
        if system == "darwin":  # macOS
            home = os.path.expanduser("~")
            paths.extend([
                home,
                os.path.join(home, "Documents"),
                os.path.join(home, "Downloads"),
                os.path.join(home, "Desktop"),
                "/Applications",
                "/Users/Shared",
                "/Volumes"
            ])
        elif system == "windows":
            home = os.path.expanduser("~")
            # Add Windows-specific paths
            drives = self._get_windows_drives()
            paths.extend(drives)
            paths.extend([
                home,
                os.path.join(home, "Documents"),
                os.path.join(home, "Downloads"),
                os.path.join(home, "Desktop"),
                os.environ.get("PROGRAMFILES", "C:\\Program Files"),
                os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
            ])
        else:  # Linux/Unix
            home = os.path.expanduser("~")
            paths.extend([
                home,
                os.path.join(home, "Documents"),
                os.path.join(home, "Downloads"),
                "/usr/local",
                "/opt",
                "/var"
            ])
        
        # Filter out non-existent paths
        return [p for p in paths if os.path.exists(p)]
    
    def _get_windows_drives(self) -> List[str]:
        """Get available Windows drives."""
        if platform.system().lower() != "windows":
            return []
            
        drives = []
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = f"{letter}:\\"
            if os.path.exists(drive):
                drives.append(drive)
        return drives
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert config to dictionary for serialization."""
        result = {}
        for key, value in self.__dict__.items():
            if isinstance(value, set):
                result[key] = list(value)
            else:
                result[key] = value
        return result
