"""
@.architecture
Incoming: services/file_indexing/daemon.py, location config from DB --- {Path, config dict}
Processing: scan filesystem, apply filters, compute hashes --- {3 jobs: JOB_FILTER, JOB_HASH, JOB_SCAN}
Outgoing: services/file_indexing/daemon.py --- {List[Dict], file metadata}
"""

import logging
import mimetypes
from pathlib import Path
from typing import List, Dict, Any
from datetime import datetime

from ..utils.hashing import compute_file_hash
from ..utils.file_filters import should_exclude

logger = logging.getLogger(__name__)


class FileSystemScanner:
    """Scans filesystem and collects file metadata."""
    
    def __init__(self, root_path: Path, allowed_extensions: List[str], exclude_patterns: List[str]):
        """
        Initialize scanner.
        
        Args:
            root_path: Root directory to scan
            allowed_extensions: List of allowed file extensions
            exclude_patterns: List of glob patterns to exclude
        """
        self.root_path = Path(root_path)
        self.allowed_extensions = [ext.lower().lstrip('.') for ext in allowed_extensions]
        self.exclude_patterns = exclude_patterns
    
    def scan(self) -> List[Dict[str, Any]]:
        """
        Scan filesystem and collect file metadata.
        
        Returns:
            List of file metadata dicts
        """
        files = []
        
        logger.info(f"Scanning: {self.root_path}")
        
        for file_path in self._iterate_files():
            try:
                if not self._should_index(file_path):
                    continue
                
                metadata = self._collect_metadata(file_path)
                files.append(metadata)
                
            except Exception as e:
                logger.warning(f"Failed to process {file_path}: {e}")
                continue
        
        logger.info(f"Found {len(files)} files")
        return files
    
    def _iterate_files(self):
        """Iterate all files in root directory using a memory-efficient generator."""
        logger.info(f"[Scanner] _iterate_files START: root={self.root_path}")
        
        if not self.root_path.exists() or not self.root_path.is_dir():
            logger.warning(f"[Scanner] Invalid root path: {self.root_path}")
            return

        file_count = 0
        dir_count = 0
        try:
            # Use rglob() as an iterator instead of list() to avoid memory spikes on massive folders
            for item in self.root_path.rglob("*"):
                try:
                    if item.is_file():
                        file_count += 1
                        yield item
                    else:
                        dir_count += 1
                except (PermissionError, OSError) as e:
                    logger.debug(f"[Scanner] Skipping item due to error: {item} - {e}")
                    continue
            
            logger.info(f"[Scanner] _iterate_files END: yielded {file_count} files, skipped {dir_count} dirs")
            
        except Exception as e:
            logger.error(f"[Scanner] Unexpected error in _iterate_files: {e}", exc_info=True)
    
    def _should_index(self, file_path: Path) -> bool:
        """Check if file should be indexed."""
        # Check extension
        ext = file_path.suffix.lstrip('.').lower()
        if ext not in self.allowed_extensions:
            logger.debug(f"[Scanner] SKIP {file_path.name}: ext '{ext}' not in allowed {self.allowed_extensions}")
            return False
        
        # Check exclusion patterns
        if should_exclude(file_path, self.exclude_patterns):
            logger.debug(f"[Scanner] SKIP {file_path.name}: matched exclusion pattern")
            return False
        
        logger.debug(f"[Scanner] ACCEPT {file_path.name}: ext='{ext}'")
        return True
    
    def _collect_metadata(self, file_path: Path) -> Dict[str, Any]:
        """Collect file metadata."""
        stat = file_path.stat()
        
        # Compute content hash
        content_hash = compute_file_hash(file_path)
        
        # Get MIME type
        mime_type, _ = mimetypes.guess_type(str(file_path))
        
        return {
            'file_path': str(file_path),
            'file_name': file_path.name,
            'file_size': stat.st_size,
            'file_extension': file_path.suffix.lstrip('.').lower(),
            'mime_type': mime_type,
            'content_hash': content_hash,
            'file_modified_at': datetime.fromtimestamp(stat.st_mtime).isoformat(),
            'creation_date': datetime.fromtimestamp(stat.st_ctime).isoformat(),
            'modification_date': datetime.fromtimestamp(stat.st_mtime).isoformat()
        }

