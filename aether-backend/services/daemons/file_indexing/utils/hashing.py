"""
@.architecture
Incoming: services/file_indexing/core/scanner.py --- {Path object, file path}
Processing: compute SHA256 hash of file content --- {1 job: JOB_HASH}
Outgoing: services/file_indexing/core/scanner.py --- {str, hex digest}
"""

import hashlib
from pathlib import Path


def compute_file_hash(file_path: Path, chunk_size: int = 8192) -> str:
    """
    Compute SHA256 hash of file content.
    
    Args:
        file_path: Path to file
        chunk_size: Size of chunks to read (for large files)
        
    Returns:
        Hex string of SHA256 hash
        
    Raises:
        IOError: If file cannot be read
    """
    sha256 = hashlib.sha256()
    
    with open(file_path, 'rb') as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            sha256.update(chunk)
    
    return sha256.hexdigest()

