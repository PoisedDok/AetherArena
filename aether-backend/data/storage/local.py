"""
Local File Storage - File system storage management

@.architecture
Incoming: api/v1/endpoints/files.py, Local filesystem (base_dir) --- {file save/read/delete/exists requests, filename, content, artifact_type, subdirectory}
Processing: save_file(), read_file(), delete_file(), file_exists(), get_file_path(), _get_subdirectory(), _validate_path(), _ensure_directories(), get_storage_stats() --- {9 jobs: file_crud, type_categorization, path_validation, directory_management, statistics_collection}
Outgoing: Local filesystem (Path.write_text/read_text/unlink), api/v1/endpoints/files.py --- {filesystem I/O in organized subdirectories (code/html/images/documents/output), str file paths, str file content, storage stats dict}

Provides local file storage with:
- Type-based directory organization
- Safe path handling
- File CRUD operations
- Metadata tracking

Files are organized by type:
- code/ - Programming files (.py, .js, .ts, etc)
- html/ - HTML previews
- images/ - Image files
- documents/ - Documents (.pdf, .docx, etc)
- output/ - Execution outputs
- files/ - Other files (root)
"""

import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class LocalFileStorage:
    """
    Local file storage manager with type-based organization.
    
    Features:
    - Safe path handling (prevents directory traversal)
    - Type-based directory organization
    - File CRUD operations
    - Size tracking
    
    Directory Structure:
        files/
        ├── code/          # .py, .js, .ts, etc
        ├── html/          # .html, .htm
        ├── images/        # .png, .jpg, etc
        ├── documents/     # .pdf, .docx, etc
        └── output/        # execution outputs
    """
    
    # File type mappings
    CODE_EXTENSIONS = {'.py', '.js', '.ts', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.php', '.rb', '.swift'}
    HTML_EXTENSIONS = {'.html', '.htm'}
    IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp'}
    DOCUMENT_EXTENSIONS = {'.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.md'}
    
    def __init__(self, base_dir: str = "./data/storage/files"):
        """
        Initialize local file storage.
        
        Args:
            base_dir: Base directory for file storage
        """
        self.base_dir = Path(base_dir).resolve()
        self._ensure_directories()
    
    def _ensure_directories(self) -> None:
        """Create storage directories if they don't exist."""
        directories = [
            self.base_dir,
            self.base_dir / "code",
            self.base_dir / "html",
            self.base_dir / "images",
            self.base_dir / "documents",
            self.base_dir / "output",
        ]
        
        for directory in directories:
            directory.mkdir(parents=True, exist_ok=True)
            
        logger.debug(f"Storage directories ensured at {self.base_dir}")
    
    def _get_subdirectory(self, filename: str, artifact_type: Optional[str] = None) -> Path:
        """
        Determine subdirectory based on file extension or artifact type.
        
        Args:
            filename: Filename to categorize
            artifact_type: Optional artifact type hint
            
        Returns:
            Subdirectory path
        """
        # Use artifact type if provided
        if artifact_type:
            type_to_dir = {
                "code": "code",
                "html": "html",
                "output": "output",
                "file": "files",
            }
            subdir_name = type_to_dir.get(artifact_type, "files")
            if subdir_name != "files":
                return self.base_dir / subdir_name
        
        # Fall back to extension-based categorization
        ext = Path(filename).suffix.lower()
        
        if ext in self.CODE_EXTENSIONS:
            return self.base_dir / "code"
        elif ext in self.HTML_EXTENSIONS:
            return self.base_dir / "html"
        elif ext in self.IMAGE_EXTENSIONS:
            return self.base_dir / "images"
        elif ext in self.DOCUMENT_EXTENSIONS:
            return self.base_dir / "documents"
        else:
            return self.base_dir
    
    def _validate_path(self, path: Path) -> None:
        """
        Validate that path is within storage directory.
        
        Prevents directory traversal attacks.
        
        Args:
            path: Path to validate
            
        Raises:
            ValueError: If path is outside storage directory
        """
        try:
            path.resolve().relative_to(self.base_dir)
        except ValueError:
            raise ValueError(f"Invalid path: {path} is outside storage directory")
    
    # =========================================================================
    # FILE OPERATIONS
    # =========================================================================
    
    def save_file(
        self,
        filename: str,
        content: str,
        artifact_type: Optional[str] = None,
        subdirectory: Optional[str] = None
    ) -> str:
        """
        Save file to storage.
        
        Args:
            filename: Filename
            content: File content
            artifact_type: Optional artifact type for directory selection
            subdirectory: Optional explicit subdirectory override
            
        Returns:
            Absolute path to saved file
            
        Raises:
            ValueError: If path is invalid
            Exception: If save fails
        """
        try:
            # Determine target directory
            if subdirectory:
                target_dir = self.base_dir / subdirectory
                target_dir.mkdir(parents=True, exist_ok=True)
            else:
                target_dir = self._get_subdirectory(filename, artifact_type)
            
            # Build file path
            file_path = target_dir / filename
            
            # Validate path
            self._validate_path(file_path)
            
            # Save file
            file_path.write_text(content, encoding='utf-8')
            
            logger.debug(f"Saved file: {file_path} ({len(content)} bytes)")
            return str(file_path)
            
        except Exception as e:
            logger.error(f"Failed to save file {filename}: {e}")
            raise
    
    def read_file(self, filename: str, subdirectory: Optional[str] = None) -> str:
        """
        Read file from storage.
        
        Args:
            filename: Filename
            subdirectory: Optional subdirectory
            
        Returns:
            File content
            
        Raises:
            FileNotFoundError: If file doesn't exist
            ValueError: If path is invalid
        """
        try:
            if subdirectory:
                file_path = self.base_dir / subdirectory / filename
            else:
                # Try to find file in categorized directories
                search_dirs = [
                    self.base_dir,
                    self.base_dir / "code",
                    self.base_dir / "html",
                    self.base_dir / "images",
                    self.base_dir / "documents",
                    self.base_dir / "output",
                ]
                
                file_path = None
                for search_dir in search_dirs:
                    candidate = search_dir / filename
                    if candidate.exists():
                        file_path = candidate
                        break
                
                if not file_path:
                    raise FileNotFoundError(f"File not found: {filename}")
            
            # Validate path
            self._validate_path(file_path)
            
            # Read file
            content = file_path.read_text(encoding='utf-8')
            logger.debug(f"Read file: {file_path} ({len(content)} bytes)")
            return content
            
        except FileNotFoundError:
            raise
        except Exception as e:
            logger.error(f"Failed to read file {filename}: {e}")
            raise
    
    def delete_file(self, filename: str, subdirectory: Optional[str] = None) -> bool:
        """
        Delete file from storage.
        
        Args:
            filename: Filename
            subdirectory: Optional subdirectory
            
        Returns:
            True if file was deleted, False if not found
            
        Raises:
            ValueError: If path is invalid
        """
        try:
            if subdirectory:
                file_path = self.base_dir / subdirectory / filename
            else:
                # Try to find and delete from any categorized directory
                search_dirs = [
                    self.base_dir,
                    self.base_dir / "code",
                    self.base_dir / "html",
                    self.base_dir / "images",
                    self.base_dir / "documents",
                    self.base_dir / "output",
                ]
                
                for search_dir in search_dirs:
                    candidate = search_dir / filename
                    if candidate.exists():
                        self._validate_path(candidate)
                        candidate.unlink()
                        logger.info(f"Deleted file: {candidate}")
                        return True
                
                return False
            
            # Validate path
            self._validate_path(file_path)
            
            # Delete file
            if file_path.exists():
                file_path.unlink()
                logger.info(f"Deleted file: {file_path}")
                return True
            return False
            
        except Exception as e:
            logger.error(f"Failed to delete file {filename}: {e}")
            raise
    
    def file_exists(self, filename: str, subdirectory: Optional[str] = None) -> bool:
        """
        Check if file exists in storage.
        
        Args:
            filename: Filename
            subdirectory: Optional subdirectory
            
        Returns:
            True if file exists, False otherwise
        """
        try:
            if subdirectory:
                file_path = self.base_dir / subdirectory / filename
                return file_path.exists()
            else:
                # Search in all categorized directories
                search_dirs = [
                    self.base_dir,
                    self.base_dir / "code",
                    self.base_dir / "html",
                    self.base_dir / "images",
                    self.base_dir / "documents",
                    self.base_dir / "output",
                ]
                
                for search_dir in search_dirs:
                    if (search_dir / filename).exists():
                        return True
                return False
                
        except Exception:
            return False
    
    def get_file_path(
        self,
        filename: str,
        artifact_type: Optional[str] = None
    ) -> str:
        """
        Get full path for a file (without saving).
        
        Args:
            filename: Filename
            artifact_type: Optional artifact type for directory selection
            
        Returns:
            Absolute path where file would be stored
        """
        target_dir = self._get_subdirectory(filename, artifact_type)
        file_path = target_dir / filename
        return str(file_path)
    
    # =========================================================================
    # STATISTICS
    # =========================================================================
    
    def get_storage_stats(self) -> dict:
        """
        Get storage statistics.
        
        Returns:
            Dict with file counts and sizes by type
        """
        stats = {
            "total_files": 0,
            "total_size_bytes": 0,
            "by_type": {},
        }
        
        type_dirs = {
            "code": self.base_dir / "code",
            "html": self.base_dir / "html",
            "images": self.base_dir / "images",
            "documents": self.base_dir / "documents",
            "output": self.base_dir / "output",
            "other": self.base_dir,
        }
        
        for type_name, type_dir in type_dirs.items():
            if not type_dir.exists():
                continue
                
            files = list(type_dir.glob("*")) if type_name == "other" else list(type_dir.rglob("*"))
            files = [f for f in files if f.is_file()]
            
            type_count = len(files)
            type_size = sum(f.stat().st_size for f in files)
            
            stats["by_type"][type_name] = {
                "count": type_count,
                "size_bytes": type_size,
            }
            
            stats["total_files"] += type_count
            stats["total_size_bytes"] += type_size
        
        return stats

