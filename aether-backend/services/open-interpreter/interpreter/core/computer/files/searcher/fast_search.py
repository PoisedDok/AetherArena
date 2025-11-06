"""
Fast file searching module using optimized algorithms.

This module provides high-performance file searching capabilities using
optimized path traversal and pattern matching techniques.
"""

import os
import glob
import fnmatch
import threading
import time
import logging
from typing import List, Dict, Any, Optional, Set, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..utils.file_utils import get_file_info, normalize_path
from ..utils.config import FileSystemConfig

logger = logging.getLogger("FastFileSearcher")

class FastFileSearcher:
    """
    High-performance file searching with optimized traversal algorithms.
    """
    
    def __init__(self, config: FileSystemConfig):
        """
        Initialize the fast file searcher.
        
        Args:
            config: Configuration for the file searcher
        """
        self.config = config
        self.max_threads = min(32, os.cpu_count() * 2 + 1) if os.cpu_count() else 8
        self._search_active = False
        self._cancel_search = False
        
    def search(self,
              query: str,
              file_type: Optional[str] = None,
              path: Optional[str] = None,
              max_results: Optional[int] = None,
              include_hidden: bool = False,
              timeout: float = 2.0) -> List[Dict[str, Any]]:
        """
        Search for files using optimized pattern matching.
        
        Args:
            query: File name pattern or substring to search for
            file_type: File extension to filter by (e.g., '.pdf')
            path: Base path to search in (defaults to all default paths)
            max_results: Maximum number of results to return
            include_hidden: Whether to include hidden files in results
            
        Returns:
            List of dictionaries containing file information
        """
        start_time = time.time()
        self._cancel_search = False
        self._search_active = True

        # Set up timeout
        import threading
        timeout_timer = threading.Timer(timeout, self.cancel_search)
        timeout_timer.start()
        
        # Normalize inputs - limit results for speed
        if max_results is None:
            max_results = min(10, self.config.max_results)  # Limit to 10 for faster response
            
        # Determine search paths
        search_paths = self._determine_search_paths(path)

        # Optimize search paths for speed
        if path is None:  # If no specific path given, limit to most relevant
            search_paths = search_paths[:2]  # Limit to current dir and home for speed
        else:
            search_paths = search_paths[:1]  # If path given, just search that path

        logger.info(f"Searching in {len(search_paths)} optimized paths for '{query}'")
        
        # Handle wildcard searches - optimize the algorithm based on query
        if '*' in query or '?' in query:
            # Direct glob pattern match
            results = self._wildcard_search(query, file_type, search_paths, max_results, include_hidden)
        else:
            # Substring search
            results = self._substring_search(query, file_type, search_paths, max_results, include_hidden)
            
        # Clean up timeout timer
        timeout_timer.cancel()

        self._search_active = False
        logger.info(f"Search completed in {time.time() - start_time:.2f}s, found {len(results)} results")

        return results
    
    def search_content(self,
                      query: str,
                      file_types: Optional[List[str]] = None,
                      paths: Optional[List[str]] = None,
                      max_results: Optional[int] = None) -> List[Dict[str, Any]]:
        """
        Search for content within files.
        
        Args:
            query: Content to search for
            file_types: File types to search in
            paths: Paths to search in
            max_results: Maximum number of results to return
            
        Returns:
            List of dictionaries containing file information and content matches
        """
        # First find candidate files
        candidate_files = []
        
        if paths is None:
            search_paths = self.config.default_search_paths
        else:
            search_paths = [normalize_path(p) for p in paths if os.path.exists(normalize_path(p))]
        
        # Create file type patterns
        if file_types:
            # Find all matching files of these types
            for path in search_paths:
                for file_type in file_types:
                    if not file_type.startswith('.'):
                        file_type = f'.{file_type}'
                        
                    # Find files of this type in path recursively
                    pattern = os.path.join(path, "**", f"*{file_type}")
                    try:
                        for file_path in glob.glob(pattern, recursive=True):
                            if os.path.isfile(file_path):
                                candidate_files.append(file_path)
                                if len(candidate_files) >= 1000:  # Limit candidates for performance
                                    break
                    except Exception:
                        continue
        else:
            # Look at common text file types
            text_extensions = ['.txt', '.md', '.py', '.js', '.html', '.css', '.json', '.xml', '.csv']
            for path in search_paths:
                for ext in text_extensions:
                    pattern = os.path.join(path, "**", f"*{ext}")
                    try:
                        for file_path in glob.glob(pattern, recursive=True):
                            if os.path.isfile(file_path):
                                candidate_files.append(file_path)
                                if len(candidate_files) >= 1000:  # Limit candidates
                                    break
                    except Exception:
                        continue
        
        # Search content in candidates
        results = []
        for file_path in candidate_files[:100]:  # Limit to first 100 candidates for speed
            try:
                matches = self._search_file_content(file_path, query)
                if matches:
                    file_info = get_file_info(file_path)
                    file_info['content_matches'] = matches
                    results.append(file_info)
                    
                    if max_results and len(results) >= max_results:
                        break
            except Exception:
                continue
                
        return results
    
    def cancel_search(self):
        """Cancel any ongoing search operation."""
        if self._search_active:
            self._cancel_search = True
            logger.info("Search cancelled - stopping operation")
            
    def _determine_search_paths(self, path: Optional[str]) -> List[str]:
        """
        Determine the paths to search based on the provided path or defaults.
        
        Args:
            path: User-provided path (can be None)
            
        Returns:
            List of paths to search in
        """
        if path:
            # If specific path provided, use only that
            normalized_path = normalize_path(path)
            if os.path.exists(normalized_path):
                return [normalized_path]
            else:
                logger.warning(f"Provided path does not exist: {path}")
                return []
        
        # Otherwise use default search paths from config
        return self.config.default_search_paths
    
    def _wildcard_search(self,
                        pattern: str,
                        file_type: Optional[str] = None,
                        search_paths: Optional[List[str]] = None,
                        max_results: int = 100,
                        include_hidden: bool = False) -> List[Dict[str, Any]]:
        """
        Search using wildcard patterns with glob.
        
        Args:
            pattern: Wildcard pattern to match
            file_type: File extension to filter by
            search_paths: Paths to search in
            max_results: Maximum number of results to return
            include_hidden: Whether to include hidden files
            
        Returns:
            List of matching file information dictionaries
        """
        results = []
        
        # Add file_type to pattern if provided
        if file_type:
            if not file_type.startswith('.'):
                file_type = f'.{file_type}'
            search_pattern = f"*{pattern}*{file_type}"
        else:
            search_pattern = f"*{pattern}*"
        
        # Use ThreadPoolExecutor for parallel search
        with ThreadPoolExecutor(max_workers=self.max_threads) as executor:
            futures = []
            
            for base_path in search_paths:
                # Create futures for each search path
                future = executor.submit(
                    self._search_in_path, 
                    base_path, 
                    search_pattern,
                    max_results, 
                    include_hidden
                )
                futures.append(future)
            
            # Collect results as they complete
            for future in as_completed(futures):
                if self._cancel_search:
                    executor.shutdown(wait=False)
                    break
                    
                try:
                    path_results = future.result()
                    results.extend(path_results)
                    
                    if len(results) >= max_results:
                        self._cancel_search = True  # Signal other threads to stop
                        break
                except Exception as e:
                    logger.error(f"Error in search thread: {str(e)}")
        
        # Sort by relevance and name
        results.sort(key=lambda x: x['name'].lower())
        
        return results[:max_results]
    
    def _substring_search(self,
                         substring: str,
                         file_type: Optional[str] = None,
                         search_paths: Optional[List[str]] = None,
                         max_results: int = 100,
                         include_hidden: bool = False) -> List[Dict[str, Any]]:
        """
        Search for files with names containing the substring.
        
        Args:
            substring: Substring to search for in file names
            file_type: File extension to filter by
            search_paths: Paths to search in
            max_results: Maximum number of results to return
            include_hidden: Whether to include hidden files
            
        Returns:
            List of matching file information dictionaries
        """
        # For substring searches, we use wildcard search with * around the query
        return self._wildcard_search(
            substring,
            file_type,
            search_paths,
            max_results,
            include_hidden
        )
    
    def _search_in_path(self, 
                       base_path: str, 
                       pattern: str,
                       max_results: int,
                       include_hidden: bool) -> List[Dict[str, Any]]:
        """
        Search for files in a specific path using the given pattern.
        
        Args:
            base_path: Base path to search in
            pattern: File pattern to match
            max_results: Maximum number of results to return
            include_hidden: Whether to include hidden files
            
        Returns:
            List of matching file information dictionaries
        """
        results = []
        
        try:
            # First try same directory
            direct_matches = glob.glob(os.path.join(base_path, pattern))
            for path in direct_matches:
                if self._cancel_search:
                    break
                    
                if os.path.isfile(path) and (include_hidden or not os.path.basename(path).startswith('.')):
                    results.append(get_file_info(path))
                    if len(results) >= max_results:
                        return results
            
            # Then try one level deep
            one_level_pattern = os.path.join(base_path, "*", pattern)
            one_level_matches = glob.glob(one_level_pattern)
            for path in one_level_matches:
                if self._cancel_search:
                    break
                    
                if os.path.isfile(path) and (include_hidden or not os.path.basename(path).startswith('.')):
                    results.append(get_file_info(path))
                    if len(results) >= max_results:
                        return results
            
            # Finally, try recursive search for remaining results
            recursive_pattern = os.path.join(base_path, "**", pattern)
            for path in glob.glob(recursive_pattern, recursive=True):
                if self._cancel_search:
                    break
                    
                if os.path.isfile(path) and (include_hidden or not os.path.basename(path).startswith('.')):
                    results.append(get_file_info(path))
                    if len(results) >= max_results:
                        return results
        
        except (PermissionError, OSError) as e:
            logger.debug(f"Error searching in {base_path}: {str(e)}")
        
        return results
    
    def _search_file_content(self, file_path: str, query: str) -> List[Dict[str, Any]]:
        """
        Search for content within a text file.
        
        Args:
            file_path: Path to the file
            query: Content to search for
            
        Returns:
            List of content matches
        """
        matches = []
        
        # Check file size first
        try:
            if os.path.getsize(file_path) > self.config.max_file_size_mb * 1024 * 1024:
                return []  # Skip files that are too large
                
            # Only search in text files
            _, ext = os.path.splitext(file_path.lower())
            if ext not in ['.txt', '.md', '.py', '.js', '.html', '.css', '.json', '.xml', '.csv', '.log']:
                return []
                
            # Search the file content
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
                
            query_lower = query.lower()
            for i, line in enumerate(lines):
                if query_lower in line.lower():
                    # Find position
                    pos = line.lower().find(query_lower)
                    
                    # Get context
                    start_line = max(0, i - 2)
                    end_line = min(len(lines), i + 3)
                    context = ''.join(lines[start_line:end_line])
                    
                    matches.append({
                        'line_number': i + 1,
                        'line_content': line.strip(),
                        'match_position': pos,
                        'context': context
                    })
                    
                    if len(matches) >= 5:  # Limit matches per file
                        break
                        
            return matches
            
        except (PermissionError, OSError, UnicodeDecodeError):
            return []
