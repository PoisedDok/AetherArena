"""
Step 5: Manual Inspection and God-Level Score Scrutiny
Reads queries from TREC-COVID and dumps verbose outputs (scores, texts) for deep agent critique.
Now supports both Sparse (BM25) and Semantic (FAISS HNSW) pipelines.
"""

import json
import logging
import sys
import time
from pathlib import Path

# Add the local src directory directly to Python path
PROJECT_ROOT = Path("/Volumes/Disk-D/Aether/Aether/AetherArena")
src_path = PROJECT_ROOT / "aether-backend/services/aether_rag/packages/aether-rag-core/src"
sys.path.insert(0, str(src_path))

from aether_rag.sparse_backend import PyTerrierSparseStore
from aether_rag.document_store import SQLiteDocumentStore
from aether_rag.vector_store import DesktopFaissVectorStore
from aether_rag.zmq_clients import ZMQEmbeddingProvider
from aether_rag.retrieval_server_manager import RetrievalServerManager
from aether_rag.engine import UnifiedRetrievalEngine

def run_manual_inspection():
    base_dir = PROJECT_ROOT
    docs_dir = base_dir / "docs" / "dataset" / "trec-covid"
    queries_file = docs_dir / "queries.jsonl"
    
    sparse_index_path = base_dir / "aether-backend/services/aether-rag/packages/aether-rag-core/tests/.pytest_cache/trec-covid_bm25_index"
    semantic_index_path = base_dir / "aether-backend/services/aether-rag/packages/aether-rag-core/tests/.pytest_cache/trec-covid_semantic_index"
    
    print("[+] Initializing PyTerrierSparseStore...")
    if not sparse_index_path.exists():
        print(f"[-] Sparse Index not found at {sparse_index_path}.")
        sparse_store = None
    else:
        sparse_store = PyTerrierSparseStore(str(sparse_index_path))

    print("[+] Starting RetrievalServerManager (Dense Worker)...")
    server_manager = RetrievalServerManager()
    started, port = server_manager.start_server(
        port=None,
        model_name="BAAI/bge-small-en-v1.5",
        embedding_mode="sentence-transformers"
    )
    if not started:
        print("[-] Failed to start dense worker sidecar.")
        semantic_enabled = False
    else:
        semantic_enabled = True
        
    try:
        if semantic_enabled and (semantic_index_path / "faiss_index").exists():
            db_path = semantic_index_path / "docs.sqlite"
            vec_path = semantic_index_path / "faiss_index"
            
            doc_store = SQLiteDocumentStore(str(db_path))
            vec_store = DesktopFaissVectorStore(str(vec_path), doc_store, dimensions=384)
            provider = ZMQEmbeddingProvider(port=port)
        else:
            print("[-] Semantic Index or SQLite DB not found. Semantic search will be disabled.")
            semantic_enabled = False
            doc_store = None
            vec_store = None
            provider = None

        engine = UnifiedRetrievalEngine(
            document_store=doc_store,
            embedding_provider=provider,
            vector_store=vec_store,
            sparse_store=sparse_store
        )
        
        queries = []
        with open(queries_file, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip(): continue
                queries.append(json.loads(line))
                
        print("\n=======================================================")
        print("HOSTILE SCRUTINY: MANUAL RETRIEVAL INSPECTION")
        print("=======================================================\n")
        
        # Scrutinize first 3 queries
        for target_query in queries[:3]:
            base_text = target_query["text"]
            meta_query = target_query["metadata"].get("query", "")
            narrative = target_query["metadata"].get("narrative", "")
            
            query_id = target_query['_id']
            # Combine the fields to create a robust baseline query
            query_text_sparse = f"{base_text} {meta_query} {narrative}".strip()
            query_text_semantic = f"{meta_query} {base_text}".strip()
            
            print(f">>> QUERY ID: {query_id}")
            print(f"    BASE TEXT: '{base_text}'")
            print(f"    META: '{meta_query}'")
            print("-" * 60)
            
            if sparse_store:
                print(f"--- MODE: SPARSE (BM25) ---")
                start_time = time.time()
                # Bypass Unified Engine which requires doc_store for hydration, use sparse store directly
                results = sparse_store.search(query_text_sparse, top_k=5)
                latency = time.time() - start_time
                print(f"Latency: {latency:.4f}s | Results found: {len(results)}\n")
                
                for i, r in enumerate(results, 1):
                    print(f"  [{i}] ID: {r.id} | Score: {r.score:.4f}")
                print()
                
            if semantic_enabled:
                print(f"--- MODE: SEMANTIC (FAISS) ---")
                start_time = time.time()
                results = engine.search(query_text_semantic, mode="semantic", top_k=5)
                latency = time.time() - start_time
                print(f"Latency: {latency:.4f}s | Results found: {len(results)}\n")
                
                for i, r in enumerate(results, 1):
                    # Fetch text from doc_store for inspection
                    doc_list = doc_store.get([r.id])
                    doc = doc_list[0] if doc_list else None
                    snippet = doc.text[:150].replace('\n', ' ') + "..." if doc else "MISSING TEXT"
                    print(f"  [{i}] ID: {r.id} | Score: {r.score:.4f} | Snippet: {snippet}")
                print()
                
            if sparse_store and semantic_enabled:
                from aether_rag.fusion import RRFFusionStrategy
                engine.fusion_strategy = RRFFusionStrategy(k=60, semantic_weight=0.5, bm25_weight=0.5)
                print(f"--- MODE: HYBRID (RRF) ---")
                start_time = time.time()
                # Use semantic query text as baseline for hybrid in this test
                results = engine.search(query_text_semantic, mode="hybrid", top_k=5, rrf_depth=100)
                latency = time.time() - start_time
                print(f"Latency: {latency:.4f}s | Results found: {len(results)}\n")
                
                for i, r in enumerate(results, 1):
                    doc_list = doc_store.get([r.id])
                    doc = doc_list[0] if doc_list else None
                    snippet = doc.text[:150].replace('\n', ' ') + "..." if doc else "MISSING TEXT"
                    print(f"  [{i}] ID: {r.id} | Score: {r.score:.4f} | Snippet: {snippet}")
                print()
                
                
            print("=" * 80 + "\n")
            
    finally:
        print("\n[+] Tearing down sidecar...")
        server_manager.stop_server()

if __name__ == "__main__":
    run_manual_inspection()
