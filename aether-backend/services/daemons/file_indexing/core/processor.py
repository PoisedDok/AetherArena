"""
@.architecture
Incoming: services/file_indexing/daemon.py, file metadata --- {file path, chunk config}
Processing: load documents via SimpleDirectoryReader, chunk via aether_rag.chunking_utils --- {2 jobs: JOB_LOAD, JOB_CHUNK}
Outgoing: services/file_indexing/core/aether_rag_manager.py --- {List[Dict], chunked documents with metadata}

Chunking is delegated to aether_rag.chunking_utils (SentenceSplitter + AST-aware code
chunking).  This is the SINGLE chunking engine for the entire backend — no manual
character-based splitting, no duplicate SentenceSplitter instantiation.
"""

import logging
from pathlib import Path
from typing import List, Dict, Any

logger = logging.getLogger(__name__)


class DocumentProcessor:
    """Processes documents for indexing using SimpleDirectoryReader + AETHER_RAG chunking."""

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        """
        Initialize processor.

        Args:
            chunk_size: Token-level chunk size for SentenceSplitter (via aether_rag)
            chunk_overlap: Token-level overlap between chunks
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def process_file(self, file_path: Path, file_meta: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Load a file with SimpleDirectoryReader and chunk it via aether_rag.chunking_utils.

        SimpleDirectoryReader supports 40+ file types (PDF, DOCX, PPTX, HTML, CSV,
        Markdown, source code, etc.).  Chunking is handled by aether_rag's unified pipeline:
        - Text files: SentenceSplitter (token-aware sentence boundaries)
        - Code files: AST-aware chunking when astchunk is available, SentenceSplitter fallback

        Args:
            file_path: Path to file
            file_meta: File metadata dict (must contain 'file_path' key)

        Returns:
            List of chunk dicts: [{"text": str, "metadata": dict}, ...]
            Empty list if the file cannot be read or produces no content.
        """
        # Late imports: llama_index + aether_rag are installed at build time (see
        # requirements.txt and build.sh) but are NOT in the dev/test venv.
        # Keeping them function-level lets the module be importable for tests
        # while raising loudly at runtime if deps are truly missing.
        from llama_index.core import SimpleDirectoryReader
        from aether_rag.chunking_utils import create_text_chunks

        try:
            documents = SimpleDirectoryReader(
                input_files=[str(file_path)]
            ).load_data()
        except Exception as e:
            logger.error("SimpleDirectoryReader failed for %s: %s", file_path, e, exc_info=True)
            return []

        if not documents:
            logger.warning("No content extracted from %s", file_path)
            return []

        # Inject file_meta into each document's metadata so aether_rag propagates it
        for doc in documents:
            doc.metadata.update({
                "file_path": str(file_meta.get("file_path", file_path)),
                "file_name": file_meta.get("file_name", file_path.name),
            })

        try:
            chunks = create_text_chunks(
                documents,
                chunk_size=self.chunk_size,
                chunk_overlap=self.chunk_overlap,
                use_ast_chunking=True,
            )
        except Exception as e:
            logger.error("aether_rag chunking failed for %s: %s", file_path, e, exc_info=True)
            return []

        # Enrich metadata with file_meta and stable chunk IDs
        for idx, chunk in enumerate(chunks):
            chunk["metadata"] = {
                **file_meta,
                **chunk.get("metadata", {}),
                "chunk_id": f"{file_meta.get('file_path', str(file_path))}::{idx}",
                "chunk_index": idx,
            }

        logger.debug("Processed %s: %d chunks", file_path, len(chunks))
        return chunks

