import logging
from typing import List, Dict, Any, Optional, Literal
import numpy as np

from .interfaces import (
    Document,
    ScoredResult,
    EnrichedResult,
    RetrievalEngine
)

logger = logging.getLogger(__name__)

class UnifiedRetrievalEngine(RetrievalEngine):
    """
    The orchestrator. Dispatches to Hexagonal ports.
    Handles strict SQLite metadata pre-filtering, batch ZMQ embedding, and RRF ranking.
    """
    def index(self, documents: List[Document], incremental: bool = False, batch_size: int = 256, defer_sparse_build: bool = False) -> None:
        if not documents:
            return

        logger.info(f"STAGE 1: Writing {len(documents)} documents to SQLite Store (without vectors)...")
        # Write to SQLite in batches to avoid extreme memory overhead and large transactions
        chunk_size = 5000
        for i in range(0, len(documents), chunk_size):
            batch_docs = documents[i:i + chunk_size]
            self.document_store.add(batch_docs, vector_blobs=None)

        if self.embedding_provider and self.vector_store:
            logger.info("STAGE 2: Semantic Vector Store Checkpoint-based Embedding...")
            if not hasattr(self.document_store, "get_missing_vectors"):
                logger.warning("Document store lacks get_missing_vectors. Skipping batch embedding.")
            else:
                processed_count = 0
                while True:
                    missing_batch = self.document_store.get_missing_vectors(batch_size=batch_size)
                    if not missing_batch:
                        break
                        
                    internal_ids = [m[0] for m in missing_batch]
                    docs = [m[1] for m in missing_batch]
                    texts = [d.text for d in docs]
                    
                    embeddings = self.embedding_provider.embed_documents(texts)
                    vector_blobs = [vec.tobytes() for vec in embeddings]
                    
                    # Checkpoint to SQLite
                    if hasattr(self.document_store, "update_vectors"):
                        self.document_store.update_vectors(internal_ids, vector_blobs)
                        
                    # Load into FAISS Buffer
                    if hasattr(self.vector_store, "add_with_internal_ids"):
                        internal_ids_arr = np.array(internal_ids, dtype=np.int64)
                        self.vector_store.add_with_internal_ids(internal_ids_arr, embeddings)
                    else:
                        self.vector_store.add([d.id for d in docs], embeddings)
                        
                    processed_count += len(docs)
                    if processed_count % (batch_size * 10) == 0:
                        logger.info(f"Embedded and checkpointed {processed_count} missing vectors...")
                        
                # Ensure the monolithic index is committed to disk after all batches
                if hasattr(self.vector_store, "commit"):
                    self.vector_store.commit()
                logger.info("All semantic vectors are embedded and loaded.")

        if self.sparse_store and not defer_sparse_build:
            logger.info("STAGE 3: Building Sparse Index...")
            if incremental:
                # To support streaming ingestion safely without OOM, we pull ALL documents from SQLite 
                # and fully rebuild the sparse index! PyTerrier does not support incremental appends.
                self.sparse_store.build(self.document_store.iter_all())
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
        
        if top_k is None:
            top_k = 10
            
        # 1. Fast Pre-Filtering via SQLite
        # For vector: dense numpy array of FAISS internal IDs
        # For sparse: list of string docnos
        allowed_internal_ids = None
        allowed_docnos = None
        
        if filters:
            if mode in ("semantic", "hybrid") and self.vector_store:
                allowed_internal_ids = self.document_store.get_allowed_internal_ids(filters)
                if len(allowed_internal_ids) == 0:
                    return [] # Fast exit if filters allow nothing
                    
            if mode in ("sparse", "hybrid") and self.sparse_store:
                allowed_docnos = self.document_store.get_allowed_docnos(filters)
                if len(allowed_docnos) == 0:
                    return []

        # Because both PyTerrier and FAISS handle RBAC pre-filtering natively and there is no incremental
        # version drifting, we do NOT need to artificially over-fetch to account for missing documents.
        # We fetch exactly what the user asks for.
        # EXCEPT for RRF Fusion, where we need a deep candidate pool from both backends to find consensus.
        if mode == "hybrid":
            # Fetch a deeper pool to ensure mathematically sound RRF (standard TREC depth is 100-1000)
            rrf_depth = kwargs.get("rrf_depth", 100)
            fetch_k = max(top_k * 5, rrf_depth)
        else:
            fetch_k = top_k

        vector_results: List[ScoredResult] = []
        sparse_results: List[ScoredResult] = []

        # 2. Execute Searches
        # Isolate kwargs to prevent cross-contamination (kwargs bleeding) between backends
        vector_kwargs = {k: v for k, v in kwargs.items() if not k.startswith("bm25_")}
        sparse_kwargs = {k: v for k, v in kwargs.items() if not k.startswith("ef_") and not k.startswith("vector_")}

        if mode in ("semantic", "hybrid") and self.vector_store and self.embedding_provider:
            query_embedding = self.embedding_provider.embed_query(query)
            vector_results = self.vector_store.search(
                query_embedding=query_embedding, 
                top_k=fetch_k, 
                allowed_ids=allowed_internal_ids, 
                **vector_kwargs
            )

        if mode in ("sparse", "hybrid") and self.sparse_store:
            sparse_results = self.sparse_store.search(
                query=query, 
                top_k=fetch_k, 
                allowed_docnos=allowed_docnos, 
                **sparse_kwargs
            )

        # 3. Hybrid Fusion
        final_results = []
        if mode == "hybrid" and self.fusion_strategy:
            # We don't need exact scores. The IFusionStrategy operates on ranks.
            final_results = self.fusion_strategy.fuse(
                vector_results, 
                sparse_results, 
                top_k=fetch_k, 
                vector_store=self.vector_store, 
                sparse_store=self.sparse_store, 
                query=query, 
                query_embedding=np.array([]), # Unused
                **kwargs
            )
        elif mode == "sparse":
            final_results = sparse_results
        else:
            final_results = vector_results

        # 4. Fault-Tolerant Hydration
        return self._hydrate_results(final_results, top_k)

    def _hydrate_results(self, results: List[ScoredResult], target_k: int) -> List[EnrichedResult]:
        """
        Hydrate text and metadata from SQLite.
        Expects KeyError/missing documents due to index drift. 
        Over-fetches until target_k is met or candidates exhausted.
        """
        hydrated = []
        # REMOVED: results.sort(key=lambda x: x.score, reverse=True)
        # Re-sorting here destroys the rank order carefully computed by fusion_strategy 
        # or the inherent ordering from backends (e.g. L2 distance where lower is better).
        
        # Batch get
        doc_ids = [r.id for r in results]
        docs = self.document_store.get(doc_ids)
        doc_map = {d.id: d for d in docs}

        for r in results:
            if len(hydrated) >= target_k:
                break
                
            doc = doc_map.get(r.id)
            if doc:
                hydrated.append(EnrichedResult(
                    id=r.id,
                    score=r.score,
                    text=doc.text,
                    metadata=doc.metadata
                ))
            else:
                # Local environment: If the index drifts from SQLite, it's a critical fault, not a silent skip.
                # In a local desktop app, we enforce strict hydration parity.
                logger.error(f"FATAL Index Drift: Document {r.id} found in Vector/Sparse index but missing in DocumentStore SQLite WAL.")
                raise RuntimeError(f"Index drift detected. DocumentStore is missing ID: {r.id}. Please rebuild the index.")

        return hydrated
