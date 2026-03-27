"""
@.architecture Hexagonal Core Abstractions

This module defines the pure interfaces for the Aether-RAG indexing and retrieval pipeline.
It enforces a strict separation of concerns, decoupling the core orchestration
from implementation details like FAISS, PyTerrier, SQLite, and ZMQ.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, List, Optional, Dict, Literal, Tuple, Iterable
import numpy as np

@dataclass
class Document:
    id: str
    text: str
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class ScoredResult:
    id: str
    score: float

@dataclass
class SearchResult:
    id: str
    text: str
    metadata: Dict[str, Any]
    score: float

@dataclass
class EnrichedResult(ScoredResult):
    text: str
    metadata: Dict[str, Any]

class IEmbeddingProvider(ABC):
    """Encapsulates all inference and network boundaries (ZMQ, HuggingFace, OpenAI)."""
    @abstractmethod
    def embed_documents(self, texts: List[str], **kwargs) -> np.ndarray:
        """Generate dense vectors for a batch of document texts."""
        pass
    
    @abstractmethod
    def embed_query(self, text: str, **kwargs) -> np.ndarray:
        """Generate a dense vector for a query string."""
        pass

class IVectorStore(ABC):
    """Encapsulates FAISS indexing."""
    @abstractmethod
    def build(self, ids: List[str], embeddings: np.ndarray, **kwargs) -> None:
        """Build the initial vector index (e.g. L1 flush)."""
        pass
    
    @abstractmethod
    def add(self, ids: List[str], embeddings: np.ndarray, **kwargs) -> None:
        """Stream vectors into the mutable index buffer (L0)."""
        pass
    
    @abstractmethod
    def search(
        self, 
        query_embedding: np.ndarray, 
        top_k: int, 
        allowed_ids: Optional[np.ndarray] = None, 
        **kwargs
    ) -> List[ScoredResult]:
        """
        Search for nearest vectors. 
        `allowed_ids` is an array of internal integer IDs representing an allowlist 
        (Single-Stage Pre-Filtering via C++ IDSelectorBitmap).
        """
        pass

class ISparseStore(ABC):
    """Encapsulates PyTerrier, JVM IPC, and BM25 index manipulation."""
    @abstractmethod
    def build(self, documents: Iterable[Document], **kwargs) -> None:
        """Build the sparse inverted index, injecting MaxScore structures."""
        pass
    
    @abstractmethod
    def add(self, documents: Iterable[Document], **kwargs) -> None:
        """Incrementally update the sparse index."""
        pass
    
    @abstractmethod
    def search(
        self, 
        query: str, 
        top_k: int, 
        allowed_docnos: Optional[List[str]] = None, 
        **kwargs
    ) -> List[ScoredResult]:
        """
        Search for keywords.
        `allowed_docnos` is a list of allowed document strings to inject into the query DAG.
        """
        pass
        
    @abstractmethod
    def search_batch(
        self, 
        queries: List[str], 
        qids: List[str], 
        top_k: int, 
        allowed_docnos: Optional[List[str]] = None, 
        **kwargs
    ) -> Dict[str, List[ScoredResult]]:
        """Batch search for keywords to avoid JNI overhead."""
        pass

class IDocumentStore(ABC):
    """Encapsulates SQLite WAL storage and metadata filtering."""
    @abstractmethod
    def add(self, documents: List[Document], vector_blobs: Optional[List[bytes]] = None) -> List[int]:
        """Insert documents (and optionally raw vector BLOBs) into the store atomically. Returns internal_ids."""
        pass
    
    @abstractmethod
    def get(self, doc_ids: List[str]) -> List[Document]:
        """O(1) retrieval of document text and metadata. Must silently drop missing IDs."""
        pass
    
    @abstractmethod
    def get_allowed_internal_ids(self, filters: Dict[str, Any]) -> np.ndarray:
        """Evaluates metadata filters FIRST to generate a dense allowlist of sequential internal FAISS IDs."""
        pass
        
    @abstractmethod
    def get_allowed_docnos(self, filters: Dict[str, Any]) -> List[str]:
        """Evaluates metadata filters FIRST to generate an allowlist of document string IDs for PyTerrier."""
        pass
        
    @abstractmethod
    def get_l0_recovery_state(self) -> Tuple[List[str], np.ndarray, np.ndarray]:
        """Recovers the L0 RAM buffer on boot. Returns (doc_ids, internal_ids, vectors)."""
        pass

    @abstractmethod
    def get_missing_vectors(self, batch_size: int = 256) -> List[Tuple[int, Document]]:
        """Fetch documents that do not have their vector_blob populated yet."""
        pass

    @abstractmethod
    def iter_all(self) -> Iterable[Document]:
        """Yields all active documents in the store. Essential for full index rebuilds."""
        pass

    @abstractmethod
    def update_vectors(self, internal_ids: List[int], vector_blobs: List[bytes]) -> None:
        """Update the WAL with generated vector blobs for the given internal IDs."""
        pass


class IFusionStrategy(ABC):
    """Encapsulates the ranx fusion engine."""
    @abstractmethod
    def fuse(
        self, 
        vector_results: List[ScoredResult], 
        sparse_results: List[ScoredResult], 
        top_k: int, 
        vector_store: IVectorStore, 
        sparse_store: ISparseStore, 
        query: str,
        query_embedding: np.ndarray,
        **kwargs
    ) -> List[ScoredResult]:
        """
        Fuses results using deterministic C++ operations. 
        Will query stores for exact missing scores.
        """
        pass

class RetrievalEngine:
    """
    The pure Hexagonal Orchestrator.
    Zero knowledge of FAISS, PyTerrier, ZMQ, or specific algorithms.
    """
    def __init__(
        self,
        document_store: IDocumentStore,
        embedding_provider: Optional[IEmbeddingProvider] = None,
        vector_store: Optional[IVectorStore] = None,
        sparse_store: Optional[ISparseStore] = None,
        fusion_strategy: Optional[IFusionStrategy] = None
    ):
        self.document_store = document_store
        self.embedding_provider = embedding_provider
        self.vector_store = vector_store
        self.sparse_store = sparse_store
        self.fusion_strategy = fusion_strategy

    def index(self, documents: List[Document], incremental: bool = False, batch_size: int = 256) -> None:
        """Unifies build and update paths, treating SQLite as the WAL. Uses checkpoint-based indexing."""
        if not documents:
            return

        chunk_size = 5000
        for i in range(0, len(documents), chunk_size):
            batch_docs = documents[i:i + chunk_size]
            self.document_store.add(batch_docs, vector_blobs=None)

        if self.vector_store and self.embedding_provider:
            if hasattr(self.document_store, "get_missing_vectors"):
                while True:
                    missing = self.document_store.get_missing_vectors(batch_size=batch_size)
                    if not missing:
                        break
                    internal_ids = [m[0] for m in missing]
                    docs = [m[1] for m in missing]
                    embeddings = self.embedding_provider.embed_documents([d.text for d in docs])
                    vector_blobs = [vec.tobytes() for vec in embeddings]

                    if hasattr(self.document_store, "update_vectors"):
                        self.document_store.update_vectors(internal_ids, vector_blobs)

                    if incremental:
                        if hasattr(self.vector_store, "add_with_internal_ids"):
                            self.vector_store.add_with_internal_ids(np.array(internal_ids, dtype=np.int64), embeddings)
                        else:
                            self.vector_store.add([d.id for d in docs], embeddings)
                    else:
                        self.vector_store.build([d.id for d in docs], embeddings)
            else:
                # Fallback for naive implementations
                embeddings = self.embedding_provider.embed_documents([d.text for d in documents])
                if incremental:
                    self.vector_store.add([d.id for d in documents], embeddings)
                else:
                    self.vector_store.build([d.id for d in documents], embeddings)

        if self.sparse_store:
            if incremental:
                # Sparse stores like PyTerrier often require full rebuilds for consistency.
                if hasattr(self.document_store, "iter_all"):
                    self.sparse_store.build(self.document_store.iter_all())
                else:
                    self.sparse_store.add(documents)
            else:
                self.sparse_store.build(documents)

    def search(
        self, 
        query: str, 
        mode: Literal["semantic", "sparse", "hybrid"] = "semantic",
        top_k: int = 10,
        filters: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> List[EnrichedResult]:
        """Executes search with exact Single-Stage Pre-Filtering."""
        scored_results: List[ScoredResult] = []
        
        # Overfetch to handle index drift during hydration
        fetch_k = int(top_k * 1.5)

        if mode == "semantic":
            if not self.vector_store or not self.embedding_provider:
                raise ValueError("Semantic mode requires vector store and embedding provider")
            allowed_ids = self.document_store.get_allowed_internal_ids(filters) if filters else None
            query_emb = self.embedding_provider.embed_query(query, **kwargs)
            scored_results = self.vector_store.search(query_emb, fetch_k, allowed_ids=allowed_ids, **kwargs)
            
        elif mode == "sparse":
            if not self.sparse_store:
                raise ValueError("Sparse mode requires sparse store")
            allowed_docnos = self.document_store.get_allowed_docnos(filters) if filters else None
            scored_results = self.sparse_store.search(query, fetch_k, allowed_docnos=allowed_docnos, **kwargs)
            
        elif mode == "hybrid":
            if not self.vector_store or not self.sparse_store or not self.embedding_provider:
                raise ValueError("Hybrid mode requires all stores and providers")
            if not self.fusion_strategy:
                raise ValueError("Hybrid search requires a fusion strategy")
                
            allowed_ids = self.document_store.get_allowed_internal_ids(filters) if filters else None
            allowed_docnos = self.document_store.get_allowed_docnos(filters) if filters else None
            
            query_emb = self.embedding_provider.embed_query(query, **kwargs)
            vec_res = self.vector_store.search(query_emb, fetch_k, allowed_ids=allowed_ids, **kwargs)
            sparse_res = self.sparse_store.search(query, fetch_k, allowed_docnos=allowed_docnos, **kwargs)
            
            scored_results = self.fusion_strategy.fuse(
                vec_res, sparse_res, fetch_k, 
                self.vector_store, self.sparse_store, 
                query, query_emb, **kwargs
            )
            
        else:
            raise ValueError(f"Invalid mode: {mode}")

        return self._hydrate_results(scored_results, top_k)

    def _hydrate_results(self, results: List[ScoredResult], target_k: int) -> List[EnrichedResult]:
        """Hydrates IDs to text/metadata exactly once at the boundary. Handles drift gracefully."""
        doc_ids = [r.id for r in results]
        hydrated_docs = self.document_store.get(doc_ids)
        docs_map = {d.id: d for d in hydrated_docs}
        
        enriched = []
        for r in results:
            if r.id in docs_map:
                doc = docs_map[r.id]
                enriched.append(EnrichedResult(id=r.id, score=r.score, text=doc.text, metadata=doc.metadata))
                if len(enriched) == target_k:
                    break
                    
        return enriched
