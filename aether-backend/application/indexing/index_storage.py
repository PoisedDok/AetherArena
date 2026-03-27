import re
import shutil
from pathlib import Path
from typing import Callable

class IndexStorageManager:
    """Manages file system operations for AETHER_RAG index directories."""

    def __init__(self, index_root: Path):
        self.index_root = index_root

    def sanitize_index_name(self, name: str) -> str:
        """Sanitize an index name for file system safety."""
        sanitized = re.sub(r"[^a-zA-Z0-9_]+", "_", name.strip().lower())
        sanitized = sanitized.strip("_")
        if not sanitized:
            raise ValueError("Index name is empty after sanitization")
        return sanitized

    def get_index_dir(self, source_type: str) -> Path:
        """Get and ensure creation of the directory for a source type."""
        index_dir = self.index_root / source_type
        index_dir.mkdir(parents=True, exist_ok=True)
        return index_dir

    def delete_index_files(self, index_dir: Path, index_name: str) -> None:
        """
        Remove ALL AETHER_RAG index artifacts for *index_name* from *index_dir*.
        Must be comprehensive — leftover BM25 directories or stale passage files
        can corrupt a subsequent build.
        """
        # Core index artifacts
        for suffix in (".aether_rag", ".aether_rag.meta.json"):
            target = index_dir / f"{index_name}{suffix}"
            if target.exists():
                target.unlink()
                
        # BM25 directory (created by combined or bm25-only builds)
        bm25_dir = index_dir / f"{index_name}.aether_rag.bm25"
        if bm25_dir.exists():
            shutil.rmtree(bm25_dir, ignore_errors=True)
            
        # Passage, offset, and ID-map files
        for suffix in (
            ".aether_rag.passages.jsonl",
            ".aether_rag.passages.idx",
            ".aether_rag.ids.txt",
            ".ids.txt",
        ):
            aux = index_dir / f"{index_name}{suffix}"
            if aux.exists():
                aux.unlink()

    def enforce_index_state(
        self, 
        index_dir: Path, 
        index_name: str, 
        force_rebuild: bool, 
        index_exists_fn: Callable[[Path, str], bool]
    ) -> None:
        """
        Ensure the index state is valid before building.
        Raises ValueError if it exists and force_rebuild is False.
        Deletes existing files if force_rebuild is True.
        """
        if index_exists_fn(index_dir, index_name):
            if not force_rebuild:
                raise ValueError(f"Index '{index_name}' already exists. Use force_rebuild to overwrite.")
            self.delete_index_files(index_dir, index_name)
