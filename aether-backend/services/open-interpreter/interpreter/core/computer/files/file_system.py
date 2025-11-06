"""
FileSystem: A comprehensive file access and search system for AI agents

This module provides a powerful interface for AI agents to locate and access files
across an entire system with both fast path-based search and semantic content search.
"""

import os
import time
import logging
from typing import List, Dict, Any, Optional, Union, Tuple

from .searcher.fast_search import FastFileSearcher
from .extraction.content_extractor import ContentExtractor
from .cache.file_cache import FileCache
from .utils.file_utils import get_file_info, normalize_path
from .utils.config import FileSystemConfig

# Configure logging
logging.basicConfig(level=logging.INFO, 
                   format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("FileSystem")

class FileSystem:
    """
    Unified file access and search system for AI agents.

    Provides fast file search, content search, and comprehensive
    file access capabilities across an entire system.
    """
    
    def __init__(self, config: Optional[FileSystemConfig] = None):
        """
        Initialize the FileSystem with optional custom configuration.
        
        Args:
            config: Custom configuration for the file system
        """
        self.config = config or FileSystemConfig()
        
        # Initialize components
        self.file_cache = FileCache(self.config)
        self.fast_searcher = FastFileSearcher(self.config)
        self.content_extractor = ContentExtractor()
        
        logger.info("FileSystem initialized with config: %s", self.config)
        
    def find_file(self, 
                 query: str, 
                 file_type: Optional[str] = None,
                 path: Optional[str] = None,
                 use_semantic: bool = False,
                 max_results: int = 10,
                 refresh_cache: bool = False,
                 timeout: Optional[float] = None) -> List[Dict[str, Any]]:
        """
        Find files matching the given criteria using fast path-based search.
        
        Args:
            query: File name or pattern to search for
            file_type: Specific file extension to search for (e.g., '.pdf', '.py')
            path: Path to search in (defaults to entire system if None)
            use_semantic: Whether to use semantic search for file names
            max_results: Maximum number of results to return
            refresh_cache: Whether to refresh the file cache before searching
            timeout: Maximum time (in seconds) to spend searching per invocation
            
        Returns:
            List of dictionaries containing file information
        """
        start_time = time.time()
        
        if refresh_cache:
            self.file_cache.refresh()
            
        # Use the fast searcher to find files
        results = self.fast_searcher.search(
            query=query,
            file_type=file_type,
            path=path,
            max_results=max_results,
            timeout=timeout if timeout is not None else 2.0
        )
        
        logger.info(f"Found {len(results)} files matching '{query}' in {time.time() - start_time:.2f} seconds")
        return results
    
    def search_content(self,
                      query: str,
                      file_types: Optional[List[str]] = None,
                      paths: Optional[List[str]] = None,
                      max_results: int = 10) -> List[Dict[str, Any]]:
        """
        Search for content within files using keyword search.

        Args:
            query: Content to search for
            file_types: List of file extensions to search in
            paths: List of paths to search in
            max_results: Maximum number of results to return

        Returns:
            List of dictionaries containing file information and content matches
        """
        start_time = time.time()

        # Use fast searcher with content search enabled
        results = self.fast_searcher.search_content(
            query=query,
            file_types=file_types,
            paths=paths,
            max_results=max_results
        )
        
        search_time = time.time() - start_time
        logger.info(f"Found {len(results)} content matches for '{query}' in {search_time:.2f} seconds")
        
        return results
    
    def read_file(self, 
                 path: str, 
                 extract_text: bool = False,
                 start_line: Optional[int] = None,
                 end_line: Optional[int] = None) -> Dict[str, Any]:
        """
        Read a file and return its contents and metadata.
        
        Args:
            path: Path to the file to read
            extract_text: Whether to extract text from binary formats (PDF, DOCX, etc.)
            start_line: First line to read (1-indexed, for text files)
            end_line: Last line to read (1-indexed, for text files)
            
        Returns:
            Dictionary containing file contents and metadata
        """
        path = normalize_path(path)
        
        if not os.path.exists(path):
            return {"error": f"File not found: {path}"}
        
        if not os.path.isfile(path):
            return {"error": f"Path is not a file: {path}"}
            
        try:
            if extract_text:
                content = self.content_extractor.extract(path)
                return {
                    **get_file_info(path),
                    "content": content,
                    "extracted": True
                }
            else:
                # Regular file reading with line range support
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    if start_line is not None or end_line is not None:
                        lines = f.readlines()
                        start_idx = (start_line or 1) - 1
                        end_idx = end_line if end_line is not None else len(lines)
                        content = ''.join(lines[start_idx:end_idx])
                    else:
                        content = f.read()
                
                return {
                    **get_file_info(path),
                    "content": content,
                    "extracted": False
                }
                
        except Exception as e:
            logger.error(f"Error reading file {path}: {str(e)}")
            return {
                "error": f"Failed to read file: {str(e)}",
                "path": path
            }
            
    def list_directory(self, 
                      path: str, 
                      show_hidden: bool = False,
                      recursive: bool = False,
                      max_depth: int = 1) -> Dict[str, Any]:
        """
        List contents of a directory with detailed information.
        
        Args:
            path: Directory path to list
            show_hidden: Whether to show hidden files
            recursive: Whether to list subdirectories recursively
            max_depth: Maximum recursion depth
            
        Returns:
            Dictionary containing directory contents and metadata
        """
        path = normalize_path(path)
        
        if not os.path.exists(path):
            return {"error": f"Path does not exist: {path}"}
            
        if not os.path.isdir(path):
            return {"error": f"Path is not a directory: {path}"}
            
        try:
            results = {
                "path": path,
                "contents": [],
                "total_items": 0,
                "directories": 0,
                "files": 0
            }
            
            for item in os.listdir(path):
                if not show_hidden and item.startswith('.'):
                    continue
                    
                item_path = os.path.join(path, item)
                item_info = get_file_info(item_path)
                
                if os.path.isdir(item_path) and recursive and max_depth > 0:
                    # Recursively list subdirectory
                    subdir = self.list_directory(
                        item_path, 
                        show_hidden, 
                        recursive, 
                        max_depth - 1
                    )
                    item_info["contents"] = subdir.get("contents", [])
                    
                results["contents"].append(item_info)
                
                if os.path.isdir(item_path):
                    results["directories"] += 1
                else:
                    results["files"] += 1
                    
            results["total_items"] = len(results["contents"])
            
            # Sort: directories first, then files alphabetically
            results["contents"].sort(key=lambda x: (not x.get("is_directory", False), x.get("name", "").lower()))
            
            return results
            
        except Exception as e:
            logger.error(f"Error listing directory {path}: {str(e)}")
            return {
                "error": f"Failed to list directory: {str(e)}",
                "path": path
            }
            
    def get_stats(self, path: str) -> Dict[str, Any]:
        """
        Get detailed statistics about a file or directory.
        
        Args:
            path: Path to the file or directory
            
        Returns:
            Dictionary containing comprehensive stats
        """
        path = normalize_path(path)
        
        if not os.path.exists(path):
            return {"error": f"Path does not exist: {path}"}
            
        try:
            return get_file_info(path, include_stats=True)
        except Exception as e:
            logger.error(f"Error getting stats for {path}: {str(e)}")
            return {
                "error": f"Failed to get stats: {str(e)}",
                "path": path
            }
            
    def refresh_cache(self) -> Dict[str, Any]:
        """
        Refresh the file system cache to ensure up-to-date results.
        
        Returns:
            Dictionary with cache refresh statistics
        """
        start_time = time.time()
        stats = self.file_cache.refresh()
        refresh_time = time.time() - start_time
        
        return {
            "success": True,
            "refresh_time": refresh_time,
            "stats": stats
        }

# Simplified factory function to create a FileSystem instance with default config
def create_file_system(config: Optional[Dict[str, Any]] = None) -> FileSystem:
    """Create a new FileSystem instance with optional configuration."""
    if config:
        cfg = FileSystemConfig(**config)
    else:
        cfg = FileSystemConfig()
        
    return FileSystem(cfg)
