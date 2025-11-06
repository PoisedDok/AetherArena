"""
File utility functions for the FileSystem module.
"""

import os
import stat
import platform
import datetime
import mimetypes
from typing import Dict, Any, Optional, List

def normalize_path(path: str) -> str:
    """
    Normalize a file path to an absolute path with expanded user directory.
    
    Args:
        path: File path to normalize
        
    Returns:
        Normalized absolute path
    """
    # Expand user directory (~/...)
    path = os.path.expanduser(path)
    
    # Make path absolute if it's not already
    if not os.path.isabs(path):
        path = os.path.abspath(path)
        
    return path

def get_file_info(path: str, include_stats: bool = False) -> Dict[str, Any]:
    """
    Get detailed information about a file or directory.
    
    Args:
        path: Path to the file or directory
        include_stats: Whether to include detailed file stats
        
    Returns:
        Dictionary containing file information
    """
    try:
        # Basic information
        path = normalize_path(path)
        name = os.path.basename(path)
        parent_dir = os.path.dirname(path)
        is_dir = os.path.isdir(path)
        is_file = os.path.isfile(path)
        exists = os.path.exists(path)
        
        result = {
            "path": path,
            "name": name,
            "parent_directory": parent_dir,
            "is_directory": is_dir,
            "is_file": is_file,
            "exists": exists,
            "extension": os.path.splitext(path)[1].lower() if is_file else "",
            "type": get_file_type(path) if is_file else "directory"
        }
        
        # Add stats if requested and file exists
        if include_stats and exists:
            file_stat = os.stat(path)
            
            # Convert timestamps to datetime objects
            modified_time = datetime.datetime.fromtimestamp(file_stat.st_mtime)
            access_time = datetime.datetime.fromtimestamp(file_stat.st_atime)
            create_time = datetime.datetime.fromtimestamp(file_stat.st_ctime)
            
            stats = {
                "size_bytes": file_stat.st_size,
                "size_human": format_file_size(file_stat.st_size),
                "modified": modified_time.isoformat(),
                "accessed": access_time.isoformat(),
                "created": create_time.isoformat(),
                "permissions": format_permissions(file_stat.st_mode),
                "readable": os.access(path, os.R_OK),
                "writable": os.access(path, os.W_OK),
                "executable": os.access(path, os.X_OK),
                "hidden": is_hidden_file(path)
            }
            
            # For directories, count contents if possible
            if is_dir:
                try:
                    contents = os.listdir(path)
                    stats["item_count"] = len(contents)
                    stats["file_count"] = len([f for f in contents 
                                              if os.path.isfile(os.path.join(path, f))])
                    stats["dir_count"] = len([f for f in contents 
                                             if os.path.isdir(os.path.join(path, f))])
                except (PermissionError, OSError):
                    stats["item_count"] = -1  # Indicate permission error
            
            result.update(stats)
            
        return result
        
    except Exception as e:
        # Return limited information on error
        return {
            "path": path,
            "name": os.path.basename(path) if path else "",
            "error": str(e),
            "exists": False
        }

def get_file_type(path: str) -> str:
    """
    Determine the file type based on extension and mime type.
    
    Args:
        path: Path to the file
        
    Returns:
        Human-readable file type description
    """
    if not os.path.isfile(path):
        return "Not a file"
        
    # Get extension and mime type
    _, ext = os.path.splitext(path.lower())
    mime_type, _ = mimetypes.guess_type(path)
    
    # Map of common extensions to friendly names
    type_map = {
        '.pdf': 'PDF Document',
        '.docx': 'Word Document',
        '.doc': 'Word Document',
        '.txt': 'Text File',
        '.md': 'Markdown Document',
        '.py': 'Python Script',
        '.js': 'JavaScript File',
        '.html': 'HTML Document',
        '.css': 'CSS Stylesheet',
        '.json': 'JSON Data',
        '.xml': 'XML Document',
        '.csv': 'CSV Data',
        '.xlsx': 'Excel Spreadsheet',
        '.xls': 'Excel Spreadsheet',
        '.png': 'PNG Image',
        '.jpg': 'JPEG Image',
        '.jpeg': 'JPEG Image',
        '.gif': 'GIF Image',
        '.zip': 'ZIP Archive',
        '.tar': 'TAR Archive',
        '.gz': 'GZIP Archive',
        '.mp3': 'MP3 Audio',
        '.mp4': 'MP4 Video',
        '.avi': 'AVI Video',
        '.mov': 'QuickTime Video'
    }
    
    if ext in type_map:
        return type_map[ext]
    elif mime_type:
        # Format mime type nicely
        category, subtype = mime_type.split('/')
        if category == 'application':
            return f"{subtype.upper()} File"
        elif category in ['audio', 'video', 'image']:
            return f"{category.capitalize()} File ({subtype})"
        else:
            return f"{category.capitalize()}/{subtype.capitalize()} File"
    else:
        return "Unknown File Type"

def format_file_size(size_bytes: int) -> str:
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

def format_permissions(mode: int) -> str:
    """
    Format file permissions in a readable string.
    
    Args:
        mode: File mode/permissions integer
        
    Returns:
        String representation of permissions (e.g., "rwxr-xr--")
    """
    perms = []
    
    # User permissions
    perms.append('r' if mode & stat.S_IRUSR else '-')
    perms.append('w' if mode & stat.S_IWUSR else '-')
    perms.append('x' if mode & stat.S_IXUSR else '-')
    
    # Group permissions
    perms.append('r' if mode & stat.S_IRGRP else '-')
    perms.append('w' if mode & stat.S_IWGRP else '-')
    perms.append('x' if mode & stat.S_IXGRP else '-')
    
    # Other permissions
    perms.append('r' if mode & stat.S_IROTH else '-')
    perms.append('w' if mode & stat.S_IWOTH else '-')
    perms.append('x' if mode & stat.S_IXOTH else '-')
    
    return ''.join(perms)

def is_hidden_file(path: str) -> bool:
    """
    Check if a file is hidden.
    
    Args:
        path: Path to check
        
    Returns:
        True if the file is hidden, False otherwise
    """
    name = os.path.basename(path)
    
    # Unix-style hidden files (start with dot)
    if name.startswith('.'):
        return True
        
    # On Windows, check hidden attribute
    if platform.system() == 'Windows':
        try:
            import win32api
            import win32con
            attribute = win32api.GetFileAttributes(path)
            return (attribute & win32con.FILE_ATTRIBUTE_HIDDEN) > 0
        except (ImportError, Exception):
            # Fall back to just checking for dot files if win32api is not available
            pass
            
    return False

def get_common_paths() -> List[str]:
    """
    Get a list of common paths to search based on the current OS.
    
    Returns:
        List of common directory paths
    """
    system = platform.system().lower()
    paths = []
    
    # Always include current directory
    paths.append(os.getcwd())
    
    # Home directory
    home = os.path.expanduser("~")
    paths.append(home)
    
    # Common user directories
    user_dirs = ["Documents", "Downloads", "Desktop", "Pictures"]
    for directory in user_dirs:
        path = os.path.join(home, directory)
        if os.path.exists(path):
            paths.append(path)
    
    # OS-specific paths
    if system == "darwin":  # macOS
        mac_paths = [
            "/Applications",
            "/Users/Shared",
            "/Volumes"
        ]
        paths.extend([p for p in mac_paths if os.path.exists(p)])
        
    elif system == "windows":
        # Add drive letters
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = f"{letter}:\\"
            if os.path.exists(drive):
                paths.append(drive)
                
    elif system == "linux":
        linux_paths = [
            "/usr/local/bin",
            "/opt",
            "/var/log",
            "/etc"
        ]
        paths.extend([p for p in linux_paths if os.path.exists(p)])
    
    return paths
