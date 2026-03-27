"""
Unified AetherRag Service
Provides a slim, single conduit between the application layer and the aether_rag core package.
"""

import json
import logging
import re
import asyncio
import threading
from pathlib import Path
from typing import List, Dict, Any, Optional

import cachetools

logger = logging.getLogger(__name__)

# Dynamically scale cache size based on available system memory
try:
    import psutil
    total_ram_gb = psutil.virtual_memory().total / (1024**3)
    # Estimate 1 item per 2GB RAM, cap between 3 and 12
    _CACHE_SIZE = max(3, min(12, int(total_ram_gb / 2)))
except ImportError:
    _CACHE_SIZE = 5

class SearcherCache(cachetools.LRUCache):
    """LRU Cache that explicitly cleans up resources upon eviction."""
    def popitem(self):
        key, value = super().popitem()
        try:
            if hasattr(value, "cleanup"):
                value.cleanup()
        except Exception as e:
            logger.error(f"Error cleaning up evicted searcher: {e}")
        return key, value

    def __delitem__(self, key):
        value = self[key]
        try:
            if hasattr(value, "cleanup"):
                value.cleanup()
        except Exception as e:
            logger.error(f"Error cleaning up deleted searcher: {e}")
        super().__delitem__(key)

# Global LRU cache for searchers to prevent OOM loops
_SEARCHER_CACHE = SearcherCache(maxsize=_CACHE_SIZE)
_SEARCHER_MTIMES = cachetools.LRUCache(maxsize=_CACHE_SIZE)

# Lock for thread-safe cache mutations
_SEARCHER_LOCK = threading.Lock()

# Semaphore to prevent thrashing and OOM during concurrent multi-index loading
_LOAD_SEMAPHORE = threading.Semaphore(2)


def _sanitize_index_name(name: str) -> str:
    """Sanitize index name to prevent path traversal and ReDoS."""
    if not name or not isinstance(name, str):
        raise ValueError("Index name must be a non-empty string.")
    if not re.match(r"^[a-zA-Z0-9_\-]+$", name):
        raise ValueError(f"Invalid index name format (must be alphanumeric/dash/underscore): {name}")
    return name


class AetherRagService:
    """
    Unified manager for all AetherRag indexes (agent outputs, file locations).
    This manager talks ONLY to the aether_rag public API, wrapping all blocking
    operations in asyncio.to_thread().
    """

    def __init__(
        self,
        embedding_model: str,
        api_base: str = "http://localhost:3000/api",
        api_key: str = "not-needed"
    ):
        self.embedding_model = embedding_model
        self.api_base = api_base
        self.api_key = api_key

    def _get_provider_options(self) -> Optional[Dict[str, str]]:
        if self.api_base:
            import os
            key = os.getenv("OPENAI_API_KEY", self.api_key)
            return {
                "base_url": self.api_base,
                "api_key": key if key else "not-needed"
            }
        return None

    def _get_index_paths(self, index_directory: Path, index_name: str) -> List[str]:
        """Find the main index and any pooled shards."""
        index_dir = Path(index_directory)
        paths = []
        
        # 1. Main index
        main_meta = index_dir / f"{index_name}.aether_rag.meta.json"
        if main_meta.exists():
            paths.append(index_name)
            
        # 2. Shards (e.g., index_name__shard__1.aether_rag.meta.json)
        for meta_file in index_dir.glob(f"{index_name}__shard__*.aether_rag.meta.json"):
            shard_name = meta_file.name.replace(".aether_rag.meta.json", "")
            if shard_name not in paths:
                paths.append(shard_name)
                
        return paths

    def index_exists(self, index_directory: Path, index_name: str) -> bool:
        """Check if AETHER_RAG index or any of its shards exist."""
        try:
            index_name = _sanitize_index_name(index_name)
        except ValueError:
            return False

        # Check for Aether-RAG V2 indexes (including shards)
        if self._get_index_paths(index_directory, index_name):
            return True
        
        bm25_dir = Path(index_directory) / f"{index_name}.aether_rag.bm25"
        if bm25_dir.exists():
            return True
        
        logical_to_daemon = {
            "email": "email_bm25",
            "browser_history": "browser_bm25"
        }
        
        paths_to_check = [Path(index_directory) / index_name]
        if index_name in logical_to_daemon:
            paths_to_check.append(Path(index_directory) / logical_to_daemon[index_name])
        
        for pyterrier_index_path in paths_to_check:
            if (pyterrier_index_path / "data.properties").exists():
                return True
        
        return False

    @staticmethod
    def calculate_index_size(index_directory: Path, index_name: str) -> int:
        try:
            index_name = _sanitize_index_name(index_name)
        except ValueError:
            return 0

        index_dir = Path(index_directory)
        if not index_dir.exists():
            return 0
        total = 0
        # Include main index and shards
        for file_path in index_dir.glob(f"{index_name}*.aether_rag*"):
            # Ensure it only matches main index or valid shards, not distinct indexes sharing a prefix
            name_part = file_path.name.split('.aether_rag')[0]
            if name_part == index_name or name_part.startswith(f"{index_name}__shard__"):
                if file_path.is_file():
                    total += file_path.stat().st_size
                elif file_path.is_dir():
                    for child in file_path.rglob("*"):
                        if child.is_file():
                            total += child.stat().st_size
        return total

    def _build_index_sync(
        self,
        index_directory: Path,
        index_name: str,
        chunks: List[Dict[str, Any]],
        index_mode: str = "semantic",
        incremental: bool = False,
        builder_instance: Optional[Any] = None,
        defer_sparse_build: bool = False,
        disable_sharding: bool = False
    ) -> int:
        index_name = _sanitize_index_name(index_name)
        from aether_rag import AetherRagBuilder
        
        if not chunks:
            logger.warning(f"No chunks to index for {index_name}")
            return 0
            
        index_dir_path = Path(index_directory)
        index_dir_path.mkdir(parents=True, exist_ok=True)
        
        index_file_path = index_dir_path / f"{index_name}.aether_rag"
        
        # Auto-sharding logic: prevent massive BM25 index rebuilds
        base_sqlite = Path(f"{index_file_path}.sqlite")
        if incremental and base_sqlite.exists() and not disable_sharding:
            import time
            import shutil
            active_size = 0
            for child in index_dir_path.glob(f"{index_name}.aether_rag*"):
                if child.name.startswith(f"{index_name}__shard__"):
                    continue
                if child.is_file():
                    active_size += child.stat().st_size
                elif child.is_dir():
                    for sub in child.rglob("*"):
                        if sub.is_file():
                            active_size += sub.stat().st_size
            
            # If active index > 50MB, seal it into a shard
            if active_size > 50 * 1024 * 1024:
                shard_id = int(time.time())
                shard_name = f"{index_name}__shard__{shard_id}"
                shard_path_base = str(index_dir_path / f"{shard_name}.aether_rag")
                idx_path_base = str(index_file_path)
                
                try:
                    for ext in [".sqlite", ".sqlite-shm", ".sqlite-wal", ".meta.json"]:
                        src = Path(f"{idx_path_base}{ext}")
                        if src.exists():
                            shutil.move(str(src), f"{shard_path_base}{ext}")
                            
                    for suffix in ["_sparse", "_vectors"]:
                        src_dir = Path(f"{idx_path_base}{suffix}")
                        if src_dir.exists():
                            shutil.move(str(src_dir), f"{shard_path_base}{suffix}")
                            
                    logger.info(f"Sealed active index {index_name} (size {active_size} bytes) to shard {shard_name}")
                    incremental = False  # Start a fresh active index
                except Exception as e:
                    logger.error(f"Failed to seal index {index_name} to shard: {e}", exc_info=True)
        
        builder = builder_instance
        if builder is None:
            builder = AetherRagBuilder(
                embedding_model=self.embedding_model,
                embedding_mode="openai",
                embedding_options=self._get_provider_options(),
                is_recompute=False,
                enable_bm25=index_mode in ("bm25", "combined"),
                index_mode=index_mode,
                engine="v2"
            )
        
        for chunk in chunks:
            text = chunk.get('text', '')
            metadata = chunk.get('metadata', {})
            doc_id = chunk.get('id') or metadata.get('doc_id')
            
            # Use 'sentence' chunking if the ingestor yielded a full document and requested it.
            # Otherwise use 'none' because ingestors like DocumentProcessor already chunk the file.
            requires_chunking = chunk.pop("requires_chunking", False)
            strategy = "sentence" if requires_chunking else "none"
            
            if text:
                builder.add_text(text, metadata=metadata, doc_id=doc_id, chunking_strategy=strategy)
                
        index_file_path = index_dir_path / f"{index_name}.aether_rag"
        
        if incremental:
            builder.update_index(str(index_file_path), defer_sparse_build=defer_sparse_build)
        else:
            builder.build_index(str(index_file_path), defer_sparse_build=defer_sparse_build)
            
        return len(chunks)

    def _force_sparse_build_sync(self, index_path: str) -> None:
        from aether_rag import AetherRagBuilder
        builder = AetherRagBuilder(
            embedding_model=self.embedding_model,
            embedding_mode="openai",
            embedding_options=self._get_provider_options(),
            is_recompute=False,
            enable_bm25=True,
            engine="v2"
        )
        builder.force_sparse_build(index_path)

    async def force_sparse_build(self, index_path: str) -> None:
        await asyncio.to_thread(self._force_sparse_build_sync, index_path)

    async def build_index(
        self,
        index_directory: Path,
        index_name: str,
        chunks: List[Dict[str, Any]],
        index_mode: str = "semantic",
        incremental: bool = False,
        builder_instance: Optional[Any] = None,
        defer_sparse_build: bool = False,
        disable_sharding: bool = False
    ) -> int:
        return await asyncio.to_thread(
            self._build_index_sync,
            index_directory, index_name, chunks, index_mode, incremental, builder_instance, defer_sparse_build, disable_sharding
        )

    def _search_sync(
        self,
        index_directory: Path,
        index_name: str,
        query: str,
        top_k: int = 10,
        mode: str = "semantic",
        **kwargs
    ) -> List[Dict[str, Any]]:
        index_name = _sanitize_index_name(index_name)
        from aether_rag import AetherRagSearcher
        
        index_paths = self._get_index_paths(index_directory, index_name)
        
        if not index_paths:
            # Support raw PyTerrier indexes for daemon compatibility
            logical_to_daemon = {
                "email": "email_bm25",
                "browser_history": "browser_bm25"
            }
            paths_to_check = [Path(index_directory) / index_name]
            if index_name in logical_to_daemon:
                paths_to_check.append(Path(index_directory) / logical_to_daemon[index_name])
            
            for pyterrier_index_path in paths_to_check:
                if (pyterrier_index_path / "data.properties").exists():
                    from aether_rag.api import get_global_server_manager
                    from aether_rag.zmq_clients import ZMQSparseStore
                    
                    _, _, actual_port = get_global_server_manager(
                        model_name=self.embedding_model,
                        embedding_mode=self.embedding_mode,
                        port=0
                    )
                    
                    searcher = ZMQSparseStore(port=actual_port, index_path=str(pyterrier_index_path), timeout_ms=30000)
                    results = searcher.search(query, top_k=top_k)
                    return [{'text': r.text if r.text else f"Document {r.id}", 'score': r.score, 'metadata': r.metadata if r.metadata else {'docno': r.id}} for r in results]
            
            return []

        shard_results_list = []
        
        for shard_name in index_paths:
            index_base_path = Path(index_directory) / shard_name
            index_meta_file = Path(str(index_base_path) + ".aether_rag.meta.json")
            
            bm25_only = False
            bm25_enabled = False
            try:
                with open(index_meta_file, 'r') as f:
                    meta = json.load(f)
                    bm25_only = meta.get('bm25_only', False)
                    bm25_enabled = meta.get('bm25_enabled', False) or meta.get('enable_bm25', False)
            except Exception:
                pass

            shard_mode = mode
            if bm25_only and shard_mode != 'bm25':
                shard_mode = 'bm25'
            if not bm25_only and not bm25_enabled and shard_mode in ('bm25', 'hybrid'):
                shard_mode = 'semantic'

            cache_key = f"{index_base_path}_{bm25_enabled}_{bm25_only}"
            current_mtime = index_meta_file.stat().st_mtime if index_meta_file.exists() else 0
            
            with _SEARCHER_LOCK:
                needs_load = cache_key not in _SEARCHER_CACHE or _SEARCHER_MTIMES.get(cache_key) != current_mtime
                if not needs_load:
                    searcher = _SEARCHER_CACHE[cache_key]

            if needs_load:
                with _LOAD_SEMAPHORE:
                    # Double-checked locking
                    with _SEARCHER_LOCK:
                        needs_load = cache_key not in _SEARCHER_CACHE or _SEARCHER_MTIMES.get(cache_key) != current_mtime
                        if not needs_load:
                            searcher = _SEARCHER_CACHE[cache_key]
                    
                    if needs_load:
                        searcher = AetherRagSearcher(
                            str(index_base_path) + ".aether_rag",
                            enable_bm25=bm25_enabled or bm25_only,
                            embedding_options=self._get_provider_options()
                        )
                        with _SEARCHER_LOCK:
                            if cache_key in _SEARCHER_CACHE:
                                old_searcher = _SEARCHER_CACHE.pop(cache_key)
                                try:
                                    if hasattr(old_searcher, "cleanup"):
                                        old_searcher.cleanup()
                                except Exception as e:
                                    logger.error(f"Error cleaning up replaced searcher: {e}")
                            _SEARCHER_CACHE[cache_key] = searcher
                            _SEARCHER_MTIMES[cache_key] = current_mtime

            try:
                shard_results = searcher.search(query, top_k=top_k, mode=shard_mode, **kwargs)
                if shard_results:
                    shard_results_list.append((shard_name, shard_results))
            except Exception as e:
                logger.error(f"Search failed for shard {shard_name}: {e}")

        all_results = []
        if len(shard_results_list) == 1:
            # Single shard: use exact raw scores (maintains BEIR research grade for single datasets)
            all_results = shard_results_list[0][1]
            all_results.sort(key=lambda r: getattr(r, 'score', 0) if hasattr(r, 'score') else (r.get('score', 0) if isinstance(r, dict) else 0), reverse=True)
        elif len(shard_results_list) > 1:
            # Multiple shards: apply Reciprocal Rank Fusion (RRF) across the pool.
            # This fixes the issue of uncalibrated BM25 IDFs across chronological shards.
            doc_scores = {}
            doc_objects = {}
            k_rrf = 60
            
            for shard_name, shard_res in shard_results_list:
                # Ensure they are sorted by their local score first
                shard_res.sort(key=lambda r: getattr(r, 'score', 0) if hasattr(r, 'score') else (r.get('score', 0) if isinstance(r, dict) else 0), reverse=True)
                
                for rank, r in enumerate(shard_res):
                    doc_id = None
                    if hasattr(r, 'metadata') and r.metadata:
                        doc_id = r.metadata.get('doc_id') or r.metadata.get('id')
                    elif isinstance(r, dict) and 'metadata' in r:
                        doc_id = r['metadata'].get('doc_id') or r['metadata'].get('id')
                        
                    if not doc_id:
                        if hasattr(r, 'text'):
                            doc_id = hash(r.text)
                        elif isinstance(r, dict) and 'text' in r:
                            doc_id = hash(r['text'])
                            
                    if doc_id not in doc_scores:
                        doc_scores[doc_id] = 0.0
                        doc_objects[doc_id] = r
                        
                    # Accumulate RRF score
                    doc_scores[doc_id] += 1.0 / (k_rrf + rank + 1)
            
            # Reassign scores and build flat list
            for doc_id, r in doc_objects.items():
                rrf_score = doc_scores[doc_id]
                if hasattr(r, 'score'):
                    r.score = rrf_score
                elif isinstance(r, dict):
                    r['score'] = rrf_score
                all_results.append(r)
                
            all_results.sort(key=lambda r: getattr(r, 'score', 0) if hasattr(r, 'score') else r.get('score', 0), reverse=True)

        # Deduplicate and slice top_k
        deduped_results = []
        seen_docs = set()
        for r in all_results:
            doc_id = None
            if hasattr(r, 'metadata') and r.metadata:
                doc_id = r.metadata.get('doc_id') or r.metadata.get('id')
            elif isinstance(r, dict) and 'metadata' in r:
                doc_id = r['metadata'].get('doc_id') or r['metadata'].get('id')
                
            if not doc_id:
                if hasattr(r, 'text'):
                    doc_id = hash(r.text)
                elif isinstance(r, dict) and 'text' in r:
                    doc_id = hash(r['text'])
            
            if doc_id and doc_id in seen_docs:
                continue
                
            if doc_id:
                seen_docs.add(doc_id)
                
            deduped_results.append(r)
            if len(deduped_results) >= top_k:
                break
                
        formatted = []
        for r in deduped_results:
            if hasattr(r, 'text'):
                formatted.append({'text': r.text, 'score': r.score, 'metadata': r.metadata})
            else:
                formatted.append(r)
        return formatted

    async def search(
        self,
        index_directory: Path,
        index_name: str,
        query: str,
        top_k: int = 10,
        mode: str = "semantic",
        filters: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> List[Dict[str, Any]]:
        results = await asyncio.to_thread(
            self._search_sync,
            index_directory, index_name, query, top_k, mode, **kwargs
        )
        
        if filters:
            filtered = []
            for result in results:
                metadata = result.get('metadata', {})
                match = True
                for key, value in filters.items():
                    if metadata.get(key) != value:
                        match = False
                        break
                if match:
                    filtered.append(result)
            return filtered
        return results

    # =========================================================================
    # Agent Specific Utilities
    # =========================================================================

    @staticmethod
    def index_name_for_agent(agent_name: str) -> Optional[str]:
        if not agent_name:
            return None
        sanitized = "".join(
            c if c.isalnum() or c == "_" else "_"
            for c in agent_name.strip().lower()
        ).strip("_")
        if not sanitized:
            return None
        return f"agent_{sanitized}_index"
        
    def _extract_text_from_content(self, content: Dict[str, Any], text_field: str) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, dict):
            if text_field in content:
                value = content[text_field]
                if isinstance(value, str):
                    return value
                elif isinstance(value, dict):
                    return json.dumps(value, indent=2)
            text_parts = []
            for key, value in content.items():
                if isinstance(value, str) and len(value) > 0:
                    text_parts.append(f"{key}: {value}")
                elif isinstance(value, (list, dict)):
                    text_parts.append(f"{key}: {json.dumps(value)}")
            return "\n".join(text_parts)
        return str(content)
        
    def _extract_searchable_metadata(self, content: Dict[str, Any]) -> Dict[str, Any]:
        metadata = {}
        for key in ['chunk_index', 'attachment_id', 'chat_id', 'priority', 'due_date', 'jurisdiction']:
            if key in content:
                metadata[key] = content[key]
        return metadata

    async def index_agent_output(
        self,
        index_directory: Path,
        agent_name: str,
        output_id: Any,
        content: Dict[str, Any],
        text_field: str = "content"
    ) -> bool:
        index_name = self.index_name_for_agent(agent_name)
        if not index_name:
            return False
            
        text = self._extract_text_from_content(content, text_field)
        if not text or len(text.strip()) < 10:
            return False
            
        metadata = {
            "output_id": str(output_id),
            "agent_name": agent_name,
            "output_type": agent_name,
            **self._extract_searchable_metadata(content)
        }
        
        index_path = index_directory / f"{index_name}.aether_rag"
        is_incremental = index_path.exists()
        
        def _build():
            from aether_rag import AetherRagBuilder
            builder = AetherRagBuilder(
                embedding_model=self.embedding_model,
                embedding_mode="openai",
                embedding_options=self._get_provider_options(),
                is_recompute=False,
                is_compact=False,
                enable_bm25=True,
                engine="v2"
            )
            builder.add_text(text, metadata=metadata, doc_id=metadata.get("output_id"))
            if is_incremental:
                builder.update_index(str(index_path))
            else:
                builder.build_index(str(index_path))
                
        try:
            await asyncio.to_thread(_build)
            return True
        except Exception as e:
            logger.error(f"Failed to index output {output_id}: {e}", exc_info=True)
            return False

    async def batch_index_agent_outputs(
        self,
        index_directory: Path,
        agent_name: str,
        outputs: List[Dict[str, Any]],
        text_field: str = "content"
    ) -> int:
        index_name = self.index_name_for_agent(agent_name)
        if not index_name or not outputs:
            return 0
            
        index_path = index_directory / f"{index_name}.aether_rag"
        
        def _build():
            from aether_rag import AetherRagBuilder
            builder = AetherRagBuilder(
                embedding_model=self.embedding_model,
                embedding_mode="openai",
                embedding_options=self._get_provider_options(),
                is_recompute=False,
                is_compact=False,
                enable_bm25=True,
                engine="v2"
            )
            
            indexed_count = 0
            for output in outputs:
                text = self._extract_text_from_content(output, text_field)
                if text and len(text.strip()) >= 10:
                    metadata = {
                        "output_id": str(output.get('id', '')),
                        "agent_name": agent_name,
                        **self._extract_searchable_metadata(output)
                    }
                    builder.add_text(text, metadata=metadata, doc_id=metadata.get("output_id"))
                    indexed_count += 1
            
            builder.build_index(str(index_path))
            return indexed_count
            
        try:
            return await asyncio.to_thread(_build)
        except Exception as e:
            logger.error(f"Batch indexing failed: {e}", exc_info=True)
            return 0

    def get_agent_index_stats(self, index_directory: Path, agent_name: str) -> Dict[str, Any]:
        """Get statistics for an agent index."""
        index_name = self.index_name_for_agent(agent_name)
        if not index_name:
            return {"exists": False, "error": "unknown_agent"}
            
        index_path = index_directory / f"{index_name}.aether_rag"
        
        if not index_path.exists():
            return {"exists": False, "path": str(index_path)}
            
        try:
            def _get_dir_size(path: Path) -> int:
                total = 0
                for p in path.rglob('*'):
                    if p.is_file():
                        total += p.stat().st_size
                return total
                
            total_size = 0
            if index_path.is_file():
                total_size += index_path.stat().st_size
            elif index_path.is_dir():
                total_size += _get_dir_size(index_path)
                
            vectors_dir = Path(f"{index_path}_vectors")
            if vectors_dir.exists():
                total_size += _get_dir_size(vectors_dir)
                
            sparse_dir = Path(f"{index_path}_sparse")
            if sparse_dir.exists():
                total_size += _get_dir_size(sparse_dir)
                
            doc_count = "unknown"
            meta_path = Path(f"{index_path}.meta.json")
            if meta_path.exists():
                with open(meta_path, 'r') as f:
                    meta = json.load(f)
                    if "indexed_count" in meta:
                        doc_count = meta["indexed_count"]
            
            return {
                "exists": True,
                "path": str(index_path),
                "size_bytes": total_size,
                "doc_count": doc_count,
                "embedding_model": self.embedding_model
            }
        except Exception as e:
            return {
                "exists": True,
                "path": str(index_path),
                "error": str(e)
            }


def dispose_aether_rag_service():
    """Clear the searcher cache and force garbage collection to release FAISS memory arrays."""
    with _SEARCHER_LOCK:
        _SEARCHER_CACHE.clear()
        _SEARCHER_MTIMES.clear()
    
    import gc
    gc.collect()

def get_aether_rag_service(
    embedding_model: Optional[str] = None,
    api_base: Optional[str] = None,
    api_key: Optional[str] = None
) -> AetherRagService:
    from config.settings import get_settings
    settings = get_settings()
    
    return AetherRagService(
        embedding_model=embedding_model or settings.embedding_service.model,
        api_base=api_base or settings.embedding_service.openai_base_url,
        api_key=api_key or "not-needed"
    )
