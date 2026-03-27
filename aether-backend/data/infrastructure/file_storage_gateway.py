"""
File Storage Gateway

Infrastructure layer implementation for file system operations.
Isolates pathlib and os level details from domain services.
"""

from typing import List, Dict, Any
from pathlib import Path

class FileStorageGateway:
    """
    Gateway for executing local file system operations.
    """
    
    def ensure_directory(self, path_str: str) -> None:
        """Ensure a directory exists, creating parents if necessary."""
        Path(path_str).mkdir(parents=True, exist_ok=True)
        
    def list_files(self, dir_path_str: str, pattern: str) -> List[Dict[str, Any]]:
        """List files matching pattern in a directory with basic stats."""
        dir_path = Path(dir_path_str)
        if not dir_path.exists() or not dir_path.is_dir():
            return []
            
        result = []
        for file_path in dir_path.glob(pattern):
            if file_path.is_file():
                result.append({
                    "name": file_path.stem,
                    "filename": file_path.name,
                    "path": str(file_path),
                    "size_bytes": file_path.stat().st_size
                })
        return result
        
    def file_exists(self, file_path_str: str) -> bool:
        """Check if a file exists."""
        return Path(file_path_str).exists()
        
    def read_text(self, file_path_str: str) -> str:
        """Read text from a file."""
        return Path(file_path_str).read_text(encoding="utf-8")
        
    def write_text(self, file_path_str: str, content: str) -> None:
        """Write text to a file."""
        Path(file_path_str).write_text(content, encoding="utf-8")
        
    def set_permissions(self, file_path_str: str, mode: int) -> None:
        """Set file permissions (chmod)."""
        Path(file_path_str).chmod(mode)
