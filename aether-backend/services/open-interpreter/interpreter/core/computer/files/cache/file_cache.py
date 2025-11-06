"""
File caching system for faster file operations and searching.

This module provides file caching capabilities to speed up file searches
and other file operations by maintaining an index of files.
"""

import os
import json
import time
import logging
import threading
import hashlib
from typing import Dict, List, Any, Optional, Set, Tuple
from datetime import datetime, timedelta
from pathlib import Path

from ..utils.config import FileSystemConfig

logger = logging.getLogger("FileCache")

class FileCache:
    """
    File caching system for faster file operations.
    
    This class maintains a cache of file information to speed up searches
    and other file operations by avoiding repeated filesystem traversal.
    """
    
    def __init__(self, config: FileSystemConfig):
        """
        Initialize the file cache.
        
        Args:
            config: Configuration for the file cache
        """
        self.config = config
        self.cache_dir = config.cache_dir
        self.cache_path = os.path.join(self.cache_dir, "file_cache.json")
        self.index_lock = threading.RLock()
        self.file_index = {}  # Path -> file info
        self.last_refresh = 0
        
        # Create cache directory if it doesn't exist
        os.makedirs(self.cache_dir, exist_ok=True)
        
        # Load existing cache
        self._load_cache()
    
    def refresh(self) -> Dict[str, Any]:
        """
        Refresh the file cache by reindexing files.
        
        Returns:
            Statistics about the refresh operation
        """
        start_time = time.time()
        with self.index_lock:
            stats = {
                'total_files': 0,
                'new_files': 0,
                'removed_files': 0,
                'updated_files': 0,
                'paths_indexed': len(self.config.default_search_paths),
                'time_taken': 0
            }
            
            # Remember previous paths to detect removed files
            previous_paths = set(self.file_index.keys())
            current_paths = set()
            
            # Traverse default search paths and update index
            for search_path in self.config.default_search_paths:
                if not os.path.exists(search_path) or not os.path.isdir(search_path):
                    continue
                    
                stats['total_files'] += self._index_path(
                    search_path, 
                    current_paths,
                    stats
                )
            
            # Find removed files
            removed_paths = previous_paths - current_paths
            for path in removed_paths:
                if path in self.file_index:
                    del self.file_index[path]
                    stats['removed_files'] += 1
            
            # Update last refresh time
            self.last_refresh = time.time()
            stats['time_taken'] = time.time() - start_time
            
            # Save cache
            self._save_cache()
            
            logger.info(f"Cache refresh completed in {stats['time_taken']:.2f}s. "
                       f"Total files: {stats['total_files']}, "
                       f"New: {stats['new_files']}, "
                       f"Updated: {stats['updated_files']}, "
                       f"Removed: {stats['removed_files']}")
            
            return stats
    
    def get_file_info(self, path: str, refresh_if_missing: bool = True) -> Optional[Dict[str, Any]]:
        """
        Get cached file information.
        
        Args:
            path: Path to the file
            refresh_if_missing: Whether to refresh the cache if the file is not found
            
        Returns:
            File information dictionary or None if not found
        """
        with self.index_lock:
            # Check if cache needs refreshing
            cache_ttl = self.config.cache_expiry_minutes * 60
            if time.time() - self.last_refresh > cache_ttl:
                logger.debug("Cache expired, refreshing...")
                self.refresh()
            
            # Check if file is in cache
            if path in self.file_index:
                return self.file_index[path]
            
            # If not in cache and exists, add it
            if os.path.exists(path) and refresh_if_missing:
                file_info = self._get_file_info(path)
                self.file_index[path] = file_info
                return file_info
                
            return None
    
    def search(self, 
              name_pattern: Optional[str] = None,
              file_type: Optional[str] = None,
              max_results: int = 100) -> List[Dict[str, Any]]:
        """
        Search the cache for files matching criteria.
        
        Args:
            name_pattern: Pattern to match in file names
            file_type: File extension to filter by
            max_results: Maximum number of results to return
            
        Returns:
            List of matching file information dictionaries
        """
        results = []
        
        with self.index_lock:
            # If cache is old, refresh it
            cache_ttl = self.config.cache_expiry_minutes * 60
            if time.time() - self.last_refresh > cache_ttl:
                logger.debug("Cache expired, refreshing...")
                self.refresh()
            
            # Search in the cache
            for path, file_info in self.file_index.items():
                if len(results) >= max_results:
                    break
                    
                # Check if file matches criteria
                name = file_info.get('name', '')
                extension = file_info.get('extension', '')
                
                # Filter by name pattern
                if name_pattern and name_pattern.lower() not in name.lower():
                    continue
                    
                # Filter by file type
                if file_type:
                    if not file_type.startswith('.'):
                        file_type = f'.{file_type}'
                    if extension.lower() != file_type.lower():
                        continue
                
                # Add to results
                results.append(file_info)
        
        return results
    
    def clear(self):
        """Clear the file cache."""
        with self.index_lock:
            self.file_index = {}
            self.last_refresh = 0
            
            # Remove cache file
            if os.path.exists(self.cache_path):
                try:
                    os.remove(self.cache_path)
                    logger.info("Cache cleared")
                except Exception as e:
                    logger.error(f"Error clearing cache: {str(e)}")
    
    def _index_path(self, 
                   path: str, 
                   current_paths: Set[str],
                   stats: Dict[str, int],
                   depth: int = 0) -> int:
        """
        Index a path and its subdirectories.
        
        Args:
            path: Path to index
            current_paths: Set of current paths being indexed
            stats: Statistics dictionary to update
            depth: Current recursion depth
            
        Returns:
            Number of files indexed
        """
        if depth > self.config.default_search_depth:
            return 0
            
        files_indexed = 0
        
        try:
            for item in os.listdir(path):
                # Skip hidden files/dirs if configured to do so
                if not self.config.index_hidden_files and item.startswith('.'):
                    continue
                    
                item_path = os.path.join(path, item)
                current_paths.add(item_path)
                
                if os.path.isdir(item_path):
                    # Recurse into subdirectory
                    files_indexed += self._index_path(
                        item_path, 
                        current_paths,
                        stats,
                        depth + 1
                    )
                elif os.path.isfile(item_path):
                    # Index file
                    self._index_file(item_path, stats)
                    files_indexed += 1
        
        except (PermissionError, OSError) as e:
            logger.debug(f"Error indexing {path}: {str(e)}")
            
        return files_indexed
    
    def _index_file(self, path: str, stats: Dict[str, int]):
        """
        Index a single file.
        
        Args:
            path: Path to the file
            stats: Statistics dictionary to update
        """
        try:
            # Check if file is already in index
            if path in self.file_index:
                # Check if file has changed
                current_mtime = os.path.getmtime(path)
                cached_mtime = self.file_index[path].get('modified_timestamp', 0)
                
                if current_mtime > cached_mtime:
                    # File has changed, update it
                    self.file_index[path] = self._get_file_info(path)
                    stats['updated_files'] += 1
            else:
                # New file, add it
                self.file_index[path] = self._get_file_info(path)
                stats['new_files'] += 1
                
        except (PermissionError, OSError) as e:
            logger.debug(f"Error indexing file {path}: {str(e)}")
    
    def _get_file_info(self, path: str) -> Dict[str, Any]:
        """
        Get information about a file.
        
        Args:
            path: Path to the file
            
        Returns:
            File information dictionary
        """
        try:
            stat_info = os.stat(path)
            name = os.path.basename(path)
            _, extension = os.path.splitext(path)
            
            return {
                'path': path,
                'name': name,
                'directory': os.path.dirname(path),
                'extension': extension.lower(),
                'size': stat_info.st_size,
                'modified_timestamp': stat_info.st_mtime,
                'modified': datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
                'is_directory': False
            }
            
        except (PermissionError, OSError):
            # Minimal information if we can't access the file
            return {
                'path': path,
                'name': os.path.basename(path),
                'directory': os.path.dirname(path),
                'extension': os.path.splitext(path)[1].lower(),
                'size': 0,
                'modified_timestamp': 0,
                'modified': '',
                'is_directory': False,
                'error': 'Access error'
            }
    
    def _load_cache(self):
        """Load the file cache from disk."""
        if os.path.exists(self.cache_path):
            try:
                with open(self.cache_path, 'r') as f:
                    cache_data = json.load(f)
                    
                self.file_index = cache_data.get('file_index', {})
                self.last_refresh = cache_data.get('last_refresh', 0)
                
                logger.info(f"Loaded {len(self.file_index)} files from cache")
                
                # Check if cache is stale
                cache_ttl = self.config.cache_expiry_minutes * 60
                if time.time() - self.last_refresh > cache_ttl:
                    logger.info("Cache is stale, scheduling refresh")
                    threading.Thread(target=self.refresh).start()
                    
            except Exception as e:
                logger.error(f"Error loading cache: {str(e)}")
                self.file_index = {}
                self.last_refresh = 0
        else:
            logger.info("No cache file found, starting with empty cache")
            self.file_index = {}
            self.last_refresh = 0
    
    def _save_cache(self):
        """Save the file cache to disk."""
        try:
            cache_data = {
                'file_index': self.file_index,
                'last_refresh': self.last_refresh,
                'version': 1
            }
            
            with open(self.cache_path, 'w') as f:
                json.dump(cache_data, f)
                
            logger.debug(f"Saved {len(self.file_index)} files to cache")
            
        except Exception as e:
            logger.error(f"Error saving cache: {str(e)}")

    def get_stats(self) -> Dict[str, Any]:
        """
        Get statistics about the file cache.
        
        Returns:
            Statistics dictionary
        """
        with self.index_lock:
            # Count file types
            file_types = {}
            for path, info in self.file_index.items():
                ext = info.get('extension', '').lower()
                if ext:
                    file_types[ext] = file_types.get(ext, 0) + 1
            
            # Calculate total size
            total_size = sum(info.get('size', 0) for info in self.file_index.values())
            
            return {
                'total_files': len(self.file_index),
                'total_size': total_size,
                'total_size_human': self._format_size(total_size),
                'file_types': file_types,
                'last_refresh': datetime.fromtimestamp(self.last_refresh).isoformat() 
                                if self.last_refresh else 'Never',
                'cache_age_seconds': int(time.time() - self.last_refresh) if self.last_refresh else 0
            }
    
    @staticmethod
    def _format_size(size_bytes: int) -> str:
        """
        Format file size in human-readable format.
        
        Args:
            size_bytes: File size in bytes
            
        Returns:
            Human-readable file size (e.g., "4.2 MB")
        """
        if size_bytes < 1024:
            return f"{size_bytes} B"
            
        size_kb = size_bytes / 1024
        if size_kb < 1024:
            return f"{size_kb:.1f} KB"
            
        size_mb = size_kb / 1024
        if size_mb < 1024:
            return f"{size_mb:.1f} MB"
            
        size_gb = size_mb / 1024
        return f"{size_gb:.2f} GB"
