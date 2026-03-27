import logging
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional

from services.daemons.file_indexing.core.processor import DocumentProcessor

logger = logging.getLogger(__name__)

# File extensions supported by AETHER_RAG's unified DocumentProcessor
_SUPPORTED_EXTENSIONS = {
    ".txt", ".md", ".csv", ".json", ".jsonl", ".xml", ".html", ".htm",
    ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".c", ".cpp", ".h",
    ".go", ".rs", ".rb", ".php", ".sh", ".bash", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".conf", ".log", ".sql", ".r", ".m",
    ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
    ".epub", ".rtf", ".odt", ".msg", ".eml"
}

# Max file size for text ingestion (50 MB)
_MAX_FILE_BYTES = 50 * 1024 * 1024

# Default chunking parameters (consistent with file indexing daemon)
_CHUNK_SIZE = 512
_CHUNK_OVERLAP = 50

class CustomFileIngestor:
    """Handles parsing, extracting, and chunking custom file sources."""

    def __init__(self):
        self.processor = DocumentProcessor(chunk_size=_CHUNK_SIZE, chunk_overlap=_CHUNK_OVERLAP)

    def is_indexable(self, path: Path) -> bool:
        """Check if a file has a supported extension for indexing."""
        ext = path.suffix.lower()
        return ext in _SUPPORTED_EXTENSIONS

    def extract_zip(self, zip_path: Path) -> Path:
        """
        Extract a ZIP archive into a temporary directory.
        Returns the temp directory Path. Caller is responsible for cleanup.

        Validates all member paths to prevent ZIP path traversal (zip-slip) attacks
        and enforces a 1GB total extraction limit to prevent ZIP bombs.
        """
        MAX_EXTRACTION_BYTES = 1024 * 1024 * 1024  # 1GB limit
        tmp_dir = Path(tempfile.mkdtemp(prefix="aether_zip_"))
        
        try:
            total_size = 0
            with zipfile.ZipFile(zip_path, "r") as zf:
                # 1. First pass: validate safety and total size
                for info in zf.infolist():
                    # Check for path traversal
                    member_path = (tmp_dir / info.filename).resolve()
                    if not str(member_path).startswith(str(tmp_dir.resolve())):
                        raise ValueError(f"ZIP archive contains path traversal entry: {info.filename}")
                    
                    # Accumulate uncompressed size
                    total_size += info.file_size
                    if total_size > MAX_EXTRACTION_BYTES:
                        raise ValueError(f"ZIP archive exceeds extraction limit of {MAX_EXTRACTION_BYTES / (1024*1024):.0f}MB")

                # 2. Second pass: safe extraction
                zf.extractall(tmp_dir)
                
            logger.info("Extracted ZIP %s to %s (Total size: %.1f MB)", zip_path.name, tmp_dir, total_size / (1024*1024))
            return tmp_dir
            
        except Exception:
            # Clean up if extraction failed partially
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

    def resolve_input_paths(self, file_paths: List[str]) -> Tuple[List[Path], List[Path]]:
        """
        Expand directories and ZIP files into a flat list of indexable file paths.
        ZIP files are extracted into a temporary directory (cleaned up after indexing).

        Returns:
            (resolved_files: List[Path], temp_dirs: List[Path])
        """
        result: List[Path] = []
        temp_dirs: List[Path] = []
        for raw_path in file_paths:
            p = Path(raw_path).expanduser().resolve()
            if not p.exists():
                logger.warning("Custom index: path does not exist, skipping: %s", p)
                continue

            if p.is_dir():
                for child in sorted(p.rglob("*")):
                    if child.is_file() and self.is_indexable(child):
                        result.append(child)
            elif p.suffix.lower() == ".zip":
                try:
                    extracted = self.extract_zip(p)
                    temp_dirs.append(extracted)
                    for child in sorted(extracted.rglob("*")):
                        if child.is_file() and self.is_indexable(child):
                            result.append(child)
                except Exception as exc:
                    logger.warning("Custom index: failed to extract ZIP %s: %s", p, exc)
            elif p.is_file() and self.is_indexable(p):
                result.append(p)
            else:
                logger.debug("Custom index: unsupported or unreadable, skipping: %s", p)

        return result, temp_dirs

    def read_file_to_chunks(
        self,
        file_path: Path,
        chunk_size: Optional[int] = None,
        chunk_overlap: Optional[int] = None,
    ) -> Any:
        """
        Read a single file and return an iterable of text chunks with metadata.
        Uses AETHER_RAG's unified DocumentProcessor (SimpleDirectoryReader).
        For .jsonl files, streams line-by-line to avoid OOM on massive datasets.
        """
        ext = file_path.suffix.lower()
        if ext not in _SUPPORTED_EXTENSIONS:
            logger.debug("Skipping unsupported file type: %s", file_path)
            return []

        file_meta = {
            "source": "custom",
            "file_path": str(file_path),
            "file_name": file_path.name,
            "file_extension": ext,
        }

        # JSONL streaming (bypass 50MB limit)
        if ext == ".jsonl":
            return self._stream_jsonl(file_path, file_meta)

        # Check for size for other file types
        try:
            size = file_path.stat().st_size
            if size > _MAX_FILE_BYTES:
                logger.warning("File too large (%d bytes), skipping: %s", size, file_path)
                return []
            if size == 0:
                return []
        except Exception as e:
            logger.warning("Failed to stat file %s: %s", file_path, e)
            return []

        # We create a specific processor if chunks are overridden
        if chunk_size is not None or chunk_overlap is not None:
            c_size = chunk_size if chunk_size is not None else _CHUNK_SIZE
            c_overlap = chunk_overlap if chunk_overlap is not None else _CHUNK_OVERLAP
            processor = DocumentProcessor(chunk_size=c_size, chunk_overlap=c_overlap)
            return processor.process_file(file_path, file_meta)

        # Delegates to llama_index SimpleDirectoryReader + AETHER_RAG SentenceSplitter
        return self.processor.process_file(file_path, file_meta)

    def _stream_jsonl(self, file_path: Path, file_meta: Dict[str, Any]):
        """Yield chunks line-by-line from a JSONL file (e.g. BEIR datasets)."""
        import json
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                for count, line in enumerate(f):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except Exception:
                        continue
                    
                    doc_id = data.get("_id", str(count))
                    title = data.get("title", "")
                    text = data.get("text", "")
                    
                    combined_text = (f"{title} {text}").strip() if title else text.strip()
                    if not combined_text:
                        continue
                        
                    chunk_meta = {
                        **file_meta,
                        **data.get("metadata", {}),
                        "chunk_id": f"{file_meta.get('file_path', str(file_path))}::{doc_id}",
                        "chunk_index": count,
                        "doc_id": doc_id,
                    }
                    
                    yield {
                        "id": chunk_meta["chunk_id"],
                        "text": combined_text,
                        "metadata": chunk_meta,
                        "requires_chunking": True
                    }
        except Exception as e:
            logger.error("Failed to stream jsonl %s: %s", file_path, e)

