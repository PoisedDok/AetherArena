"""
Aether-RAG API Facade (Pure V2 Hexagonal Architecture)
"""

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from aether_rag.interactive_utils import create_api_session
from .chat import get_llm

from .interfaces import Document, SearchResult
from .engine import UnifiedRetrievalEngine
from .document_store import SQLiteDocumentStore
from .vector_store import DesktopFaissVectorStore
from .fusion import RRFFusionStrategy
from .zmq_clients import ZMQEmbeddingProvider, ZMQSparseStore
from .retrieval_server_manager import RetrievalServerManager

import threading

logger = logging.getLogger(__name__)

_GLOBAL_MANAGERS = {}
_GLOBAL_MANAGER_LOCK = threading.Lock()

def get_global_server_manager(model_name: str, embedding_mode: str, port: int, **kwargs) -> tuple[RetrievalServerManager, bool, int]:
    """
    Get or create a thread-safe global instance of RetrievalServerManager.
    Keys on (model_name, embedding_mode).
    Returns (manager, started_successfully, actual_port)
    """
    key = (model_name, embedding_mode)
    with _GLOBAL_MANAGER_LOCK:
        if key in _GLOBAL_MANAGERS:
            manager_info = _GLOBAL_MANAGERS[key]
            # Verify the manager is still healthy
            if manager_info["manager"].router_proc and manager_info["manager"].router_proc.is_alive():
                return manager_info["manager"], True, manager_info["port"]
            else:
                logger.warning(f"Global Retrieval Sidecar for {key} died. Restarting...")
                manager_info["manager"].stop_server()
                del _GLOBAL_MANAGERS[key]

        logger.info(f"Starting new Global Retrieval Sidecar for {key}...")
        manager = RetrievalServerManager()
        started, actual_port = manager.start_server(
            port=port,
            model_name=model_name,
            embedding_mode=embedding_mode,
            **kwargs
        )
        if started:
            _GLOBAL_MANAGERS[key] = {
                "manager": manager,
                "port": actual_port
            }
        return manager, started, actual_port

class AetherRagBuilder:
    def __init__(
        self,
        embedding_model: str = "BAAI/bge-small-en-v1.5",
        dimensions: Optional[int] = None,
        embedding_mode: str = "sentence-transformers",
        embedding_options: Optional[dict[str, Any]] = None,
        enable_bm25: bool = False,
        engine: str = "v2",
        **kwargs,
    ):
        """
        Initialize Aether-RAG V2 builder.
        """
        self.chunks: list[dict[str, Any]] = []
        self._is_v2 = True
        self.embedding_model = embedding_model
        self.dimensions = dimensions
        self.embedding_mode = embedding_mode
        self.embedding_options = embedding_options or {}
        self.enable_bm25 = enable_bm25
        self.builder_kwargs = kwargs
        
        # Resolve the strict architectural token limit for this model
        try:
            from .tokenization import get_model_token_limit
            base_url = self.embedding_options.get("base_url") if isinstance(self.embedding_options, dict) else None
            self.token_limit = get_model_token_limit(self.embedding_model, base_url=base_url)
        except ImportError:
            # Fallback if module is somehow unreachable
            self.token_limit = 2048

    def add_text(
        self,
        text: str,
        chunk_size: int = 1500,
        chunk_overlap: int = 200,
        metadata: Optional[dict[str, Any]] = None,
        doc_id: Optional[str] = None,
        chunking_strategy: str = "sentence",
        model_token_limit: Optional[int] = None,
    ):
        """Add text directly to the builder with automatic chunking."""
        import uuid
        
        # Protect against architectural drift: ensure chunk_size never exceeds model's physical token limit.
        # This prevents catastrophic data loss downstream where the provider forcefully drops tokens.
        index_mode = self.builder_kwargs.get("index_mode", "semantic")
        is_pure_bm25 = index_mode == "bm25"
        
        if metadata is None:
            metadata = {}
        if doc_id is None:
            doc_id = str(uuid.uuid4())
            
        # Only enforce model token limits on semantic embeddings when we are actually controlling the chunking.
        # When chunking_strategy is "none", the chunks are pre-computed by the caller, so we trust their size.
        if not is_pure_bm25 and chunking_strategy not in ("none", "document"):
            effective_limit = model_token_limit or getattr(self, "token_limit", 2048)
            if chunk_size > effective_limit:
                logger.warning(
                    f"Requested chunk_size ({chunk_size}) exceeds model's actual token_limit ({effective_limit}). "
                    f"Clamping chunk_size to {effective_limit} to prevent downstream data truncation/loss."
                )
                # Preserve the sliding window ratio to maintain retrieval properties
                overlap_ratio = chunk_overlap / chunk_size
                chunk_size = effective_limit
                chunk_overlap = int(chunk_size * overlap_ratio)

        if chunking_strategy == "none" or chunking_strategy == "document":
            chunks = [text]
        else:
            try:
                if chunking_strategy == "sentence":
                    from llama_index.core.node_parser import SentenceSplitter
                    splitter = SentenceSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
                    chunks = splitter.split_text(text)
                else:
                    chunks = [text[i:i+chunk_size] for i in range(0, len(text), max(1, chunk_size - chunk_overlap))]
            except ImportError:
                # Fallback if llama_index not present
                chunks = [text[i:i+chunk_size] for i in range(0, len(text), max(1, chunk_size - chunk_overlap))]

        is_single_chunk = len(chunks) == 1 and chunking_strategy in ("none", "document")
        for i, chunk_text in enumerate(chunks):
            chunk_metadata = metadata.copy()
            chunk_metadata["source_id"] = doc_id
            if not is_single_chunk:
                chunk_metadata["chunk_index"] = i
            
            # The V2 Document expects 'id' in metadata or as a primary field.
            chunk_id = doc_id if is_single_chunk else f"{doc_id}_chunk_{i}"
            if "id" not in chunk_metadata:
                chunk_metadata["id"] = chunk_id

            self.chunks.append({
                "id": chunk_id,
                "text": chunk_text,
                "metadata": chunk_metadata
            })

    def build_index(self, index_path: str, defer_sparse_build: bool = False):
        self._execute_indexing(index_path, incremental=False, defer_sparse_build=defer_sparse_build)

    def update_index(self, index_path: str, defer_sparse_build: bool = False):
        self._execute_indexing(index_path, incremental=True, defer_sparse_build=defer_sparse_build)
        
    def _execute_indexing(self, index_path: str, incremental: bool = False, defer_sparse_build: bool = False):
        if not self.chunks:
            raise ValueError("No chunks added.")

        valid_chunks: list[dict[str, Any]] = []
        skipped = 0
        for chunk in self.chunks:
            text = chunk.get("text", "")
            if isinstance(text, str) and text.strip():
                valid_chunks.append(chunk)
            else:
                skipped += 1
        if skipped > 0:
            logger.warning(f"Skipping {skipped} empty/invalid text chunk(s). Processing {len(valid_chunks)} valid chunks")
            self.chunks = valid_chunks
            if not self.chunks:
                raise ValueError("All provided chunks are empty or invalid. Nothing to index.")

        v2_docs = [
            Document(id=c["id"], text=c["text"], metadata=c.get("metadata", {}))
            for c in self.chunks
        ]
        
        mode_str = "Updating" if incremental else "Building"
        logger.info(f"{mode_str} V2 index at {index_path}")
        
        # Spin up sidecar for indexing
        v2_zmq_port = int(os.getenv("AETHER_RAG_V2_ZMQ_PORT", "0"))  # Use dynamic port by default
        server_manager, started, actual_port = get_global_server_manager(
            model_name=self.embedding_model,
            embedding_mode=self.embedding_mode,
            port=v2_zmq_port,
            **self.builder_kwargs
        )
        
        try:
            if not started:
                raise RuntimeError("Failed to start V2 Retrieval Sidecar for indexing.")
                
            if not incremental:
                import shutil
                logger.info(f"Wiping existing index at {index_path} before full build...")
                sqlite_path = Path(f"{index_path}.sqlite")
                if sqlite_path.exists(): 
                    sqlite_path.unlink()
                
                sqlite_wal_path = Path(f"{index_path}.sqlite-wal")
                if sqlite_wal_path.exists():
                    sqlite_wal_path.unlink()
                
                sqlite_shm_path = Path(f"{index_path}.sqlite-shm")
                if sqlite_shm_path.exists():
                    sqlite_shm_path.unlink()
                
                faiss_path = Path(f"{index_path}_vectors")
                if faiss_path.exists() and faiss_path.is_dir():
                    shutil.rmtree(faiss_path)
                    
                sparse_path = Path(f"{index_path}_sparse")
                if sparse_path.exists() and sparse_path.is_dir():
                    shutil.rmtree(sparse_path)
                
            v2_doc_store = SQLiteDocumentStore(f"{index_path}.sqlite")
            
            # Resolve Embedding Provider
            index_mode = self.builder_kwargs.get("index_mode", "semantic")
            if index_mode == "bm25":
                prov = None
                dimensions = None
            else:
                if self.embedding_mode == "openai":
                    from .providers.embeddings import OpenAIEmbeddingProvider
                    prov = OpenAIEmbeddingProvider(
                        model_name=self.embedding_model,
                        provider_options=self.embedding_options
                    )
                elif self.embedding_mode == "ollama":
                    from .providers.embeddings import OllamaEmbeddingProvider
                    prov = OllamaEmbeddingProvider(
                        model_name=self.embedding_model,
                        provider_options=self.embedding_options
                    )
                else:
                    prov = ZMQEmbeddingProvider(port=actual_port)
                
                # Fetch dimensions (probe)
                probe_emb = prov.embed_query("dummy")
                dimensions = len(probe_emb)
            
            v2_vector_store = DesktopFaissVectorStore(f"{index_path}_vectors", v2_doc_store, dimensions=dimensions) if prov else None
            v2_sparse_store = ZMQSparseStore(port=actual_port, index_path=f"{index_path}_sparse") if self.enable_bm25 else None
            
            engine = UnifiedRetrievalEngine(
                document_store=v2_doc_store,
                embedding_provider=prov,
                vector_store=v2_vector_store,
                sparse_store=v2_sparse_store
            )
            
            # Execute Indexing
            engine.index(v2_docs, incremental=incremental, defer_sparse_build=defer_sparse_build)
            
            # Write meta.json
            path = Path(index_path)
            index_dir = path.parent
            index_name = path.name
            
            meta_data = {
                "version": "2.0",
                "engine": "v2",
                "storage_engine": "sqlite",
                "embedding_model": self.embedding_model,
                "dimensions": dimensions,
                "embedding_mode": self.embedding_mode,
                "bm25_enabled": index_mode in ("combined", "bm25"),
                "bm25_only": index_mode == "bm25"
            }
            with open(index_dir / f"{index_name}.meta.json", "w", encoding="utf-8") as f:
                json.dump(meta_data, f, indent=2)
            
        finally:
            if 'v2_doc_store' in locals() and hasattr(v2_doc_store, 'close'):
                v2_doc_store.close()
            
        self.chunks.clear()

    def force_sparse_build(self, index_path: str):
        if not self.enable_bm25:
            return
            
        logger.info(f"Forcing deferred sparse index build at {index_path}")
        v2_zmq_port = int(os.getenv("AETHER_RAG_V2_ZMQ_PORT", "0"))
        server_manager, started, actual_port = get_global_server_manager(
            model_name=self.embedding_model,
            embedding_mode=self.embedding_mode,
            port=v2_zmq_port,
            **self.builder_kwargs
        )
        try:
            if not started:
                raise RuntimeError("Failed to start V2 Retrieval Sidecar for deferred sparse indexing.")
                
            v2_doc_store = SQLiteDocumentStore(f"{index_path}.sqlite")
            v2_sparse_store = ZMQSparseStore(port=actual_port, index_path=f"{index_path}_sparse")
            
            engine = UnifiedRetrievalEngine(
                document_store=v2_doc_store,
                embedding_provider=None,
                vector_store=None,
                sparse_store=v2_sparse_store
            )
            
            logger.info("Building Sparse Index from full SQLite corpus...")
            engine.sparse_store.build(engine.document_store.iter_all())
            
        finally:
            if 'v2_doc_store' in locals() and hasattr(v2_doc_store, 'close'):
                v2_doc_store.close()


class AetherRagSearcher:
    def __init__(self, index_path: str, enable_warmup: bool = False, enable_bm25: bool = False, **kwargs):
        if not Path(index_path).is_absolute():
            index_path = str(Path(index_path).resolve())

        self.meta_path_str = f"{index_path}.meta.json"
        if not Path(self.meta_path_str).exists():
            raise FileNotFoundError(f"Aether-RAG metadata file not found at {self.meta_path_str}")
            
        with open(self.meta_path_str, encoding="utf-8") as f:
            self.meta_data = json.load(f)

        if self.meta_data.get("engine") != "v2":
            raise RuntimeError("Legacy V1 indexes are no longer supported. Please rebuild the index.")

        self._is_v2 = True
        
        self.v2_doc_store = SQLiteDocumentStore(f"{index_path}.sqlite")
        
        bm25_only = self.meta_data.get("bm25_only", False)
        
        if not bm25_only:
            v2_dim = self.meta_data.get("dimensions")
            if v2_dim is None:
                v2_dim = 384
            self.v2_vector_store = DesktopFaissVectorStore(f"{index_path}_vectors", self.v2_doc_store, dimensions=v2_dim)
        else:
            self.v2_vector_store = None
        
        v2_zmq_port = int(os.getenv("AETHER_RAG_V2_ZMQ_PORT", "0"))  # Use dynamic port by default
        
        # Start the manager to host the sidecar first to get the actual port
        model_name = self.meta_data.get("embedding_model", "BAAI/bge-small-en-v1.5")
        embedding_mode = self.meta_data.get("embedding_mode", "sentence-transformers")
        
        server_manager, started, actual_port = get_global_server_manager(
            model_name=model_name,
            embedding_mode=embedding_mode,
            port=v2_zmq_port
        )
        
        if not started:
            raise RuntimeError("Failed to start V2 Retrieval Sidecar.")
            
        embedding_options = kwargs.get("embedding_options", {})
        
        if bm25_only:
            self.v2_embed_prov = None
        else:
            if embedding_mode == "openai":
                from .providers.embeddings import OpenAIEmbeddingProvider
                self.v2_embed_prov = OpenAIEmbeddingProvider(
                    model_name=model_name,
                    provider_options=embedding_options
                )
            elif embedding_mode == "ollama":
                from .providers.embeddings import OllamaEmbeddingProvider
                self.v2_embed_prov = OllamaEmbeddingProvider(
                    model_name=model_name,
                    provider_options=embedding_options
                )
            else:
                self.v2_embed_prov = ZMQEmbeddingProvider(port=actual_port)
            
        self.v2_sparse_store = ZMQSparseStore(port=actual_port, index_path=f"{index_path}_sparse", timeout_ms=30000)
        
        self.v2_engine = UnifiedRetrievalEngine(
            document_store=self.v2_doc_store,
            embedding_provider=self.v2_embed_prov,
            vector_store=self.v2_vector_store,
            sparse_store=self.v2_sparse_store,
            fusion_strategy=RRFFusionStrategy()
        )

    def search(
        self,
        query: str,
        top_k: int = 5,
        mode: str = "hybrid",
        metadata_filters: Optional[dict[str, Any]] = None,
        **kwargs,
    ) -> list[SearchResult]:
        """
        Search using V2 UnifiedRetrievalEngine.
        """
        if mode == "bm25":
            mode = "sparse"
        v2_mode = mode if mode in ("semantic", "sparse", "hybrid") else "semantic"
        
        v2_kwargs = kwargs.copy()
        if "complexity" in v2_kwargs:
            v2_kwargs["nprobe"] = v2_kwargs.pop("complexity")
            
        v2_results = self.v2_engine.search(
            query=query,
            mode=v2_mode,
            top_k=top_k,
            filters=metadata_filters,
            **v2_kwargs
        )
        
        return [
            SearchResult(
                id=r.id,
                score=r.score,
                text=r.text,
                metadata=r.metadata
            ) for r in v2_results
        ]

    def cleanup(self):
        """Explicitly cleanup DB handles and ZMQ sockets."""
        if hasattr(self, "v2_embed_prov") and hasattr(self.v2_embed_prov, "cleanup"):
            self.v2_embed_prov.cleanup()
        if hasattr(self, "v2_sparse_store") and hasattr(self.v2_sparse_store, "cleanup"):
            self.v2_sparse_store.cleanup()
        if hasattr(self, "v2_doc_store") and hasattr(self.v2_doc_store, "close"):
            self.v2_doc_store.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            self.cleanup()
        except Exception:
            pass

    def __del__(self):
        try:
            self.cleanup()
        except Exception:
            pass


class AetherRagChat:
    def __init__(
        self,
        index_path: str,
        llm_config: Optional[dict[str, Any]] = None,
        enable_warmup: bool = False,
        searcher: Optional[AetherRagSearcher] = None,
        **kwargs,
    ):
        if searcher is None:
            self.searcher = AetherRagSearcher(index_path, enable_warmup=enable_warmup, **kwargs)
            self._owns_searcher = True
        else:
            self.searcher = searcher
            self._owns_searcher = False
        self.llm = get_llm(llm_config)

    def ask(
        self,
        question: str,
        top_k: int = 5,
        mode: str = "hybrid",
        metadata_filters: Optional[dict[str, Any]] = None,
        llm_kwargs: Optional[dict[str, Any]] = None,
        **search_kwargs,
    ):
        if llm_kwargs is None:
            llm_kwargs = {}
            
        search_time = time.time()
        results = self.searcher.search(
            question,
            top_k=top_k,
            mode=mode,
            metadata_filters=metadata_filters,
            **search_kwargs,
        )
        search_time = time.time() - search_time
        logger.info(f"  Search time: {search_time} seconds")
        
        context = "\n\n".join([r.text for r in results])
        prompt = (
            "Here is some retrieved context that might help answer your question:\n\n"
            f"{context}\n\n"
            f"Question: {question}\n\n"
            "Please provide the best answer you can based on this context and your knowledge."
        )

        print("The context provided to the LLM is:")
        print(f"{'Relevance':<10} | {'Chunk id':<10} | {'Content':<60} | {'Source':<80}")
        print("-" * 150)
        for r in results:
            chunk_relevance = f"{r.score:.3f}"
            chunk_id = r.id
            chunk_content = r.text[:60]
            chunk_source = r.metadata.get("source", "")[:80]
            print(f"{chunk_relevance:<10} | {chunk_id:<10} | {chunk_content:<60} | {chunk_source:<80}")
            
        ask_time = time.time()
        ans = self.llm.ask(prompt, **llm_kwargs)
        ask_time = time.time() - ask_time
        logger.info(f"  Ask time: {ask_time} seconds")
        return ans

    def start_interactive(self):
        """Start interactive chat session."""
        session = create_api_session()

        def handle_query(user_input: str):
            response = self.ask(user_input)
            print(f"Aether-RAG: {response}")

        session.run_interactive_loop(handle_query)

    def cleanup(self):
        if getattr(self, "_owns_searcher", False) and hasattr(self.searcher, "cleanup"):
            self.searcher.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            self.cleanup()
        except Exception:
            pass

    def __del__(self):
        try:
            self.cleanup()
        except Exception:
            pass
