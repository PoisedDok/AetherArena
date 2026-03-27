import sys
import json
import time
import os
import pytest
import numpy as np
from pathlib import Path

# Setup path
PROJECT_ROOT = Path("/Volumes/Disk-D/Aether/Aether/AetherArena")
src_path = PROJECT_ROOT / "aether-backend/services/aether_rag/packages/aether-rag-core/src"
sys.path.insert(0, str(src_path))

from aether_rag.document_store import SQLiteDocumentStore
from aether_rag.vector_store import DesktopFaissVectorStore
from aether_rag.sparse_backend import PyTerrierSparseStore
from aether_rag.zmq_clients import ZMQEmbeddingProvider
from aether_rag.retrieval_server_manager import RetrievalServerManager
from aether_rag.engine import UnifiedRetrievalEngine
from aether_rag.fusion import RRFFusionStrategy

DATASET = os.environ.get("DATASET", "trec-covid")
SPARSE_INDEX_DIR = Path(__file__).resolve().parent.parent / "tests" / ".pytest_cache" / f"{DATASET}_bm25_index"
SEMANTIC_INDEX_DIR = Path(__file__).resolve().parent.parent / "tests" / ".pytest_cache" / f"{DATASET}_semantic_index"

def hybrid_engine():
    print("\n[+] Starting RetrievalServerManager (Dense Worker)...")
    server_manager = RetrievalServerManager()
    started, port = server_manager.start_server(
        port=None,
        model_name="BAAI/bge-small-en-v1.5",
        embedding_mode="sentence-transformers"
    )
    
    if not started:
        raise RuntimeError("Failed to start dense worker sidecar.")
        
    db_path = SEMANTIC_INDEX_DIR / "docs.sqlite"
    vec_path = SEMANTIC_INDEX_DIR / "faiss_index"
    
    # We require the indexes to be pre-built from previous tests
    if not db_path.exists() or not vec_path.exists() or not SPARSE_INDEX_DIR.exists():
        server_manager.stop_server()
        pytest.skip("Required indexes for Hybrid test not found. Please run sparse and semantic tests first.")
        
    doc_store = SQLiteDocumentStore(str(db_path))
    vec_store = DesktopFaissVectorStore(str(vec_path), doc_store, dimensions=384)
    sparse_store = PyTerrierSparseStore(str(SPARSE_INDEX_DIR))
    provider = ZMQEmbeddingProvider(port=port)
    fusion_strategy = RRFFusionStrategy(k=60, semantic_weight=0.5, bm25_weight=0.5)
    
    engine = UnifiedRetrievalEngine(
        document_store=doc_store,
        embedding_provider=provider,
        vector_store=vec_store,
        sparse_store=sparse_store,
        fusion_strategy=fusion_strategy
    )
    
    yield engine
    
    print("\n[+] Tearing down sidecar...")
    server_manager.stop_server()

def test_01_hybrid_search(hybrid_engine):
    engine = hybrid_engine
    
    queries = [
        "what is the origin of COVID-19",
        "coronavirus response to weather changes"
    ]
    
    print("\n[+] Running Hybrid Searches (RRF)...")
    for q in queries:
        start = time.time()
        # Ensure we request a deeper RRF pool for math accuracy, e.g., rrf_depth=100
        results = engine.search(q, mode="hybrid", top_k=10, rrf_depth=100)
        latency = (time.time() - start) * 1000
        
        print(f"\nQuery: '{q}' | Latency: {latency:.2f}ms")
        for i, r in enumerate(results, 1):
            print(f"  [{i}] ID: {r.id}, Score: {r.score:.4f}")
            
        assert len(results) > 0
        
        # Test score monotonicity
        scores = [r.score for r in results]
        assert scores == sorted(scores, reverse=True), "Hybrid RRF results are not sorted properly."

def test_02_hybrid_prefiltering_rbac(hybrid_engine):
    engine = hybrid_engine
    query = "what"
    
    # Unfiltered
    unfiltered = engine.search(query, mode="hybrid", top_k=10, rrf_depth=100)
    
    if len(unfiltered) < 3:
        pytest.skip("Not enough unfiltered results to test RBAC filtering properly.")
        
    allowed_docs = [unfiltered[1].id, unfiltered[2].id]
    
    # Mock DocumentStore's filters for both Sparse and Semantic to simulate RBAC 
    original_get_internal = engine.document_store.get_allowed_internal_ids
    original_get_docnos = engine.document_store.get_allowed_docnos
    
    try:
        import numpy as np
        
        # Map string IDs to internal IDs for vector store mockup
        internal_ids = []
        for doc_id in allowed_docs:
            with engine.document_store._get_connection() as conn:
                cursor = conn.execute("SELECT internal_id FROM documents WHERE doc_id = ?", (doc_id,))
                row = cursor.fetchone()
                if row:
                    internal_ids.append(row["internal_id"])
                    
        engine.document_store.get_allowed_internal_ids = lambda filters: np.array(internal_ids, dtype=np.int64)
        engine.document_store.get_allowed_docnos = lambda filters: allowed_docs
        
        filtered = engine.search(query, mode="hybrid", top_k=10, rrf_depth=100, filters={"dummy": "filter"})
        
        assert len(filtered) <= 2
        for r in filtered:
            assert r.id in allowed_docs, f"Doc ID {r.id} bypasses the RBAC filter!"
            
    finally:
        engine.document_store.get_allowed_internal_ids = original_get_internal
        engine.document_store.get_allowed_docnos = original_get_docnos

if __name__ == "__main__":
    print("Running Hybrid Retrieval Tests Manually...")
    
    gen = hybrid_engine()
    engine = next(gen)
    
    try:
        print("\n--- Running test_01_hybrid_search ---")
        test_01_hybrid_search(engine)
        print("test_01_hybrid_search passed.")
        
        print("\n--- Running test_02_hybrid_prefiltering_rbac ---")
        test_02_hybrid_prefiltering_rbac(engine)
        print("test_02_hybrid_prefiltering_rbac passed.")
        
        print("\nALL HYBRID TESTS PASSED SUCCESSFULLY!")
    finally:
        try:
            next(gen)
        except StopIteration:
            pass
