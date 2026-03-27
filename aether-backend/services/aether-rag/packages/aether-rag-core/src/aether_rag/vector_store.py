"""
@.architecture Monolithic Desktop Vector Store

This module implements the IVectorStore interface using a pure, in-memory FAISS HNSW approach.
- Optimized for single-user desktop performance.
- Eliminates LSM-Tree fragmentation and SQLite hot-path lookups.
- Safe Python-level post-filtering avoids FAISS C++ segfaults.
"""

import logging
from pathlib import Path
from typing import List, Optional

import numpy as np

try:
    import faiss
except ImportError:
    faiss = None

from .interfaces import IVectorStore, ScoredResult, IDocumentStore

logger = logging.getLogger(__name__)

if faiss is not None:
    # PREVENT CPU THRASHING ON DESKTOP:
    # FAISS will try to use all cores for every single query, causing massive
    # lock contention in a concurrent FastAPI app. We lock it to 1 thread per worker.
    faiss.omp_set_num_threads(1)

class DesktopFaissVectorStore(IVectorStore):
    def __init__(self, index_dir: str | Path, document_store: IDocumentStore, dimensions: int = 384, metric_type: int = None):
        if faiss is None:
            raise ImportError("faiss is required for DesktopFaissVectorStore but is not installed.")
        
        if metric_type is None:
            metric_type = faiss.METRIC_INNER_PRODUCT
            
        self.index_dir = Path(index_dir)
        self.index_dir.mkdir(parents=True, exist_ok=True)
        self.doc_store = document_store
        self.dimensions = dimensions
        self.metric_type = metric_type
        
        # BEIR defaults for HNSW
        self.hnsw_m = 32
        self.hnsw_ef_construction = 200
        self.hnsw_ef_search = 128
        
        self.index_path = self.index_dir / "index.faiss"
        self.index: Optional[faiss.IndexIDMap] = None
        self.internal_to_doc_id = {}
        
        self._init_index()

    def _init_index(self):
        """Load monolithic index from disk or create a new one. Load RAM map."""
        if self.index_path.exists():
            logger.info(f"Loading monolithic FAISS index from {self.index_path}")
            self.index = faiss.read_index(str(self.index_path))
        else:
            logger.info("Initializing new monolithic FAISS HNSW index.")
            base_index = faiss.IndexHNSWFlat(self.dimensions, self.hnsw_m, self.metric_type)
            base_index.hnsw.efConstruction = self.hnsw_ef_construction
            base_index.hnsw.efSearch = self.hnsw_ef_search
            self.index = faiss.IndexIDMap(base_index)
            
        # Initialize the RAM Dictionary to completely eliminate SQLite from the search hot-path
        # A 500k doc mapping takes ~25MB of RAM, perfectly safe for desktop.
        logger.info("Loading internal_id -> doc_id mapping into RAM...")
        with self.doc_store._get_connection() as conn:
            cursor = conn.execute("SELECT internal_id, doc_id FROM documents")
            self.internal_to_doc_id = {row['internal_id']: row['doc_id'] for row in cursor}
        logger.info(f"Loaded {len(self.internal_to_doc_id)} mappings into RAM.")

        # FAISS Crash-Recovery / Drift-Prevention mechanism
        faiss_count = self.index.ntotal
        with self.doc_store._get_connection() as conn:
            cursor = conn.execute("SELECT COUNT(*) FROM documents WHERE vector_blob IS NOT NULL")
            sqlite_count = cursor.fetchone()[0]
            
        if faiss_count < sqlite_count:
            logger.warning(f"Index drift detected on boot! FAISS ({faiss_count}) vs SQLite ({sqlite_count}). Recovering missing vectors...")
            

            with self.doc_store._get_connection() as conn:
                cursor = conn.execute("SELECT internal_id, vector_blob FROM documents WHERE vector_blob IS NOT NULL")
                internal_ids = []
                vectors = []
                for row in cursor:
                    internal_ids.append(row['internal_id'])
                    vectors.append(np.frombuffer(row['vector_blob'], dtype=np.float32))
                
            if internal_ids:
                logger.info(f"Rebuilding FAISS index from {len(internal_ids)} SQLite blobs...")
                # Re-init fresh FAISS index
                base_index = faiss.IndexHNSWFlat(self.dimensions, self.hnsw_m, self.metric_type)
                base_index.hnsw.efConstruction = self.hnsw_ef_construction
                base_index.hnsw.efSearch = self.hnsw_ef_search
                self.index = faiss.IndexIDMap(base_index)
                
                # Add with explicit normalization
                vectors_c = np.ascontiguousarray(vectors, dtype=np.float32)
                ids_c = np.ascontiguousarray(internal_ids, dtype=np.int64)
                faiss.normalize_L2(vectors_c)
                self.index.add_with_ids(vectors_c, ids_c)
                self.commit()
                logger.info("FAISS recovery complete.")

    def commit(self):
        """Explicitly save index to disk."""
        if self.index is not None:
            logger.info(f"Committing FAISS index to {self.index_path}")
            import os
            import tempfile
            # Write to temporary file in the same directory, then atomically replace
            # This prevents concurrent readers from reading a partially written index.
            dir_path = self.index_path.parent
            fd, tmp_path = tempfile.mkstemp(dir=dir_path, prefix="faiss_", suffix=".tmp")
            os.close(fd)
            try:
                faiss.write_index(self.index, tmp_path)
                os.replace(tmp_path, str(self.index_path))
            except Exception:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
                raise

    def _save(self):
        """Serialize index to a single monolithic file."""
        # Wait for shutdown signal or use explicit commit method instead
        # to avoid terabytes of SSD writes
        pass

    def build(self, ids: List[str], embeddings: np.ndarray, **kwargs) -> None:
        """
        Build a completely new index, wiping out existing data.
        """
        if self.index_path.exists():
            self.index_path.unlink()
            
        base_index = faiss.IndexHNSWFlat(self.dimensions, self.hnsw_m, self.metric_type)
        base_index.hnsw.efConstruction = self.hnsw_ef_construction
        base_index.hnsw.efSearch = self.hnsw_ef_search
        self.index = faiss.IndexIDMap(base_index)
        
        # Build is called from engine.py after vectors are embedded, but we need internal_ids.
        # Since this replaces FaissLSMVectorStore, we will sync the RAM map first.
        with self.doc_store._get_connection() as conn:
            cursor = conn.execute("SELECT internal_id, doc_id FROM documents")
            self.internal_to_doc_id = {row['internal_id']: row['doc_id'] for row in cursor}
            
        self.add(ids, embeddings, **kwargs)

    def add(self, ids: List[str], embeddings: np.ndarray, **kwargs) -> None:
        """
        Add string ids to the index. 
        Note: engine.py uses add_with_internal_ids when available.
        """
        raise NotImplementedError("Use add_with_internal_ids to maintain SQLite parity.")

    def add_with_internal_ids(self, internal_ids: np.ndarray, embeddings: np.ndarray):
        """Add to the monolithic index using pre-assigned internal IDs from SQLite."""
        if len(internal_ids) == 0:
            return
            
        vectors_c = np.ascontiguousarray(embeddings, dtype=np.float32)
        ids_c = np.ascontiguousarray(internal_ids, dtype=np.int64)
        
        # Explicit L2 Normalization required for Cosine Similarity (BGE models)
        faiss.normalize_L2(vectors_c)
        
        self.index.add_with_ids(vectors_c, ids_c)
        # ONLY save during shutdown or explicit commit, not after every batch!
        # self._save() 
        
        # Update RAM map
        with self.doc_store._get_connection() as conn:
            id_list = ",".join(str(i) for i in internal_ids)
            cursor = conn.execute(f"SELECT internal_id, doc_id FROM documents WHERE internal_id IN ({id_list})")
            for row in cursor:
                self.internal_to_doc_id[row['internal_id']] = row['doc_id']

    def search(self, query_embedding: np.ndarray, top_k: int, allowed_ids: Optional[np.ndarray] = None, **kwargs) -> List[ScoredResult]:
        """
        Search using safe Python-level post-filtering. 
        Avoids C++ IDSelectorBitmap segfaults with HNSW.
        """
        if self.index.ntotal == 0:
            return []
            
        # Dynamically set efSearch if provided (e.g. from user complexity routing)
        ef_search = kwargs.get("efSearch", self.hnsw_ef_search)
        try:
            base_idx = faiss.downcast_index(self.index.index)
            base_idx.hnsw.efSearch = int(ef_search)
        except Exception as e:
            logger.debug(f"Could not set efSearch on index: {e}")
        
        # Ensure correct shape (1, D)
        if len(query_embedding.shape) == 1:
            q_c = np.ascontiguousarray([query_embedding], dtype=np.float32)
        else:
            q_c = np.ascontiguousarray(query_embedding, dtype=np.float32)
            
        # Explicit L2 Normalization required for Cosine Similarity
        faiss.normalize_L2(q_c)
        
        # Determine fetch size for safe python-level post-filtering
        if allowed_ids is not None:
            if len(allowed_ids) == 0:
                return []
            fetch_k = max(top_k * 3, 100)  # Over-fetch for safe filtering
            allowed_set = set(allowed_ids.tolist())
        else:
            fetch_k = top_k
            allowed_set = None

        # Execute safe raw search (no IVF parameters passed to HNSW!)
        D, I = self.index.search(q_c, min(fetch_k, self.index.ntotal))
        
        distances = D[0]
        internal_ids = I[0]
        
        results = []
        for d, internal_id in zip(distances, internal_ids):
            if internal_id == -1:
                continue
                
            if allowed_set is not None and internal_id not in allowed_set:
                continue
                
            doc_id = self.internal_to_doc_id.get(internal_id)
            if doc_id:
                results.append(ScoredResult(id=doc_id, score=float(d)))
                
            if len(results) >= top_k:
                break

        # Since metric is INNER_PRODUCT, FAISS returns descending scores natively.
        return results
