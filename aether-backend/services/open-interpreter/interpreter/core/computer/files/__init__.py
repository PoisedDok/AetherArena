"""
FileSystem: A comprehensive file access and search system for AI agents.

This module provides powerful interfaces for file search and access across an entire system.
"""

from .file_system import FileSystem, create_file_system
from .interfaces.agent_api import (
    AgentFileAPI,
    agent_file_api,
    find_file,
    search_content,
    read_file,
    list_directory
)

# Backwards compatibility
class Files:
    """Legacy Files class for backwards compatibility."""

    def __init__(self, computer=None):
        """Initialize the Files class."""
        self.computer = computer
        self.file_api = agent_file_api
        
    def search(self, query, paths=None, file_types=None, content_search=True, 
               case_sensitive=False, max_depth=None, fast_mode=None):
        """Search for files and content."""
        results = {}
        
        if not content_search:
            # Just search for files by name
            file_type = file_types[0] if file_types and len(file_types) > 0 else None
            files = self.file_api.find(query, file_type)
            results['files'] = files
            results['total_files_found'] = len(files)
            results['content_matches'] = []
            results['total_content_matches'] = 0
        else:
            # Search for content as well
            if file_types:
                content_results = self.file_api.search(query, file_types)
            else:
                content_results = self.file_api.search(query)
                
            results['content_matches'] = content_results
            results['total_content_matches'] = len(content_results)
            results['files'] = [r for r in content_results if 'content_matches' not in r]
            results['total_files_found'] = len(results['files'])
            
        return results
    
    def read_file(self, path, lines=None, start_line=1, encoding='utf-8'):
        """Read a file."""
        result = self.file_api.read(path, extract_text=True)
        
        # Format the result for backwards compatibility
        if 'error' in result:
            return result
            
        content = result.get('content', '')
        
        # Handle line limits if specified
        if lines is not None:
            content_lines = content.splitlines()
            start_idx = start_line - 1
            end_idx = min(start_idx + lines, len(content_lines))
            content = '\n'.join(content_lines[start_idx:end_idx])
            
        return {
            'path': path,
            'content': content,
            'size': result.get('size_bytes', 0),
            'type': result.get('type', 'unknown'),
            'encoding': encoding,
            'lines_read': lines,
            'start_line': start_line,
            'total_lines': content.count('\n') + 1 if content else 0
        }
    
    def list_directory(self, path, show_hidden=False, recursive=False, max_depth=2):
        """List contents of a directory with metadata."""
        return self.file_api.list(path, show_hidden)
    
    def get_file_stats(self, path):
        """Get statistics about a file or directory (size, timestamps, permissions)."""
        return self.file_api.get_stats(path)

    # New ergonomic wrappers (exposed to tool catalog)

    def find_file(self, query: str, file_type: str | None = None):
        """Quickly locate files by name pattern across default search paths.

        Example:
            computer.files.find_file("budget", file_type=".pdf")
        """
        return self.file_api.find(query, file_type)

    def search_content(self, text: str, file_types: list[str] | None = None):
        """Search for text within files.

        Example:
            computer.files.search_content("import numpy", file_types=[".py"])
        """
        return self.file_api.search(text, file_types)


    def refresh_cache(self):
        """Refresh the internal file index for up-to-date results."""
        return self.file_api.file_system.refresh_cache()
