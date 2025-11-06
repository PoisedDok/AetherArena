"""
Agent API interface for file system access.

This module provides a simplified API for AI agents to access the file system,
abstracting away the complexity of the underlying implementation.
"""

import os
import logging
from typing import List, Dict, Any, Optional, Union

from ..file_system import FileSystem, create_file_system

logger = logging.getLogger("AgentFileAPI")

class AgentFileAPI:
    """
    Simple, powerful file API for AI agents.
    
    This class provides a simplified interface for AI agents to access the file system,
    hiding the complexity of the underlying implementation while maintaining power.
    """
    
    def __init__(self):
        """Initialize the agent file API."""
        self.file_system = create_file_system()
    
    def find(self, query: str, file_type: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Find files matching the given query.
        
        Args:
            query: What to search for (filename or pattern)
            file_type: File extension to filter by (e.g., 'pdf', 'py')
            
        Returns:
            List of matching files with their information
        """
        # Normalize file_type
        if file_type and not file_type.startswith('.'):
            file_type = f'.{file_type}'
        
        return self.file_system.find_file(query, file_type=file_type)
    
    def search(self, text: str, file_types: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        """
        Search for content within files.

        Args:
            text: Content to search for
            file_types: List of file extensions to search in

        Returns:
            List of files containing the text with content matches
        """
        # Normalize file_types
        if file_types:
            normalized_types = []
            for ft in file_types:
                if not ft.startswith('.'):
                    normalized_types.append(f'.{ft}')
                else:
                    normalized_types.append(ft)
            file_types = normalized_types

        # Use standard content search
        return self.file_system.search_content(text, file_types=file_types)
    
    def read(self, path: str, extract_text: bool = True) -> Dict[str, Any]:
        """
        Read a file and return its contents.
        
        Args:
            path: Path to the file
            extract_text: Whether to extract text from non-text files
            
        Returns:
            Dictionary with file content and information
        """
        return self.file_system.read_file(path, extract_text=extract_text)
    
    def list(self, path: str, show_hidden: bool = False) -> Dict[str, Any]:
        """
        List contents of a directory.
        
        Args:
            path: Path to the directory
            show_hidden: Whether to show hidden files
            
        Returns:
            Dictionary with directory contents
        """
        return self.file_system.list_directory(path, show_hidden=show_hidden)
    
    
    def get_stats(self, path: str) -> Dict[str, Any]:
        """
        Get detailed statistics about a file or directory.
        
        Args:
            path: Path to the file or directory
            
        Returns:
            Dictionary with comprehensive statistics
        """
        return self.file_system.get_stats(path)

# Create a singleton instance for easy importing
agent_file_api = AgentFileAPI()

# Function shortcuts for even simpler usage
def find_file(query: str, file_type: Optional[str] = None) -> List[Dict[str, Any]]:
    """Find files matching the query."""
    return agent_file_api.find(query, file_type)

def search_content(text: str, file_types: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """Search for content within files."""
    return agent_file_api.search(text, file_types)

def read_file(path: str, extract_text: bool = True) -> Dict[str, Any]:
    """Read a file and return its contents."""
    return agent_file_api.read(path, extract_text)

def list_directory(path: str, show_hidden: bool = False) -> Dict[str, Any]:
    """List contents of a directory."""
    return agent_file_api.list(path, show_hidden)

