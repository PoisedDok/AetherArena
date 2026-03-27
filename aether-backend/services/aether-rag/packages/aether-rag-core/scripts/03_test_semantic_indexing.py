import sys
import json
import time
import pytest
import os
import numpy as np
from pathlib import Path
from typing import Iterator

src_path = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(src_path))

from aether_rag.interfaces import Document
from aether_rag.document_store import SQLiteDocumentStore
from aether_rag.vector_store import DesktopFaissVectorStore
from aether_rag.zmq_clients import ZMQEmbeddingProvider
from aether_rag.retrieval_server_manager import RetrievalServerManager
from aether_rag.engine import UnifiedRetrievalEngine

DATASET = os.environ.get("DATASET", "trec-covid")
PROJECT_ROOT = Path("/Volumes/Disk-D/Aether/Aether/AetherArena")
CORPUS_PATH = PROJECT_ROOT / f"docs/dataset/{DATASET}/corpus.jsonl"
INDEX_DIR = Path(__file__).resolve().parent.parent / "tests" / ".pytest_cache" / f"{DATASET}_semantic_index"

pytestmark = pytest.mark.skipif(
    not CORPUS_PATH.exists(),
    reason=f"{DATASET} corpus not found at {CORPUS_PATH}"
)

def doc_iterator(filepath: Path, limit: int = None) -> Iterator[Document]:
    count = 0
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            data = json.loads(line)
            doc_id = data.get("_id", str(count))
            title = data.get("title", "")
            text = data.get("text", "")
            
            # BEIR concatenates title and text with a space
            combined_text = (f"{title} {text}").strip() if title else text.strip()
            if not combined_text:
                continue
                
            yield Document(id=doc_id, text=combined_text, metadata=data.get("metadata", {}))
            count += 1
            if limit and count >= limit:
                break

def semantic_engine():
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    db_path = INDEX_DIR / "docs.sqlite"
    vec_path = INDEX_DIR / "faiss_index"
    
    # CLEAR OLD DATA for fresh tests
    import shutil
    if db_path.exists():
        db_path.unlink()
    if vec_path.exists():
        if vec_path.is_dir():
            shutil.rmtree(vec_path)
        else:
            vec_path.unlink()
    vec_path.mkdir(parents=True, exist_ok=True)
    
    print("\n[+] Starting RetrievalServerManager (Dense Worker)...")
    server_manager = RetrievalServerManager()
    started, port = server_manager.start_server(
        port=None,
        model_name="BAAI/bge-small-en-v1.5",
        embedding_mode="sentence-transformers"
    )
    
    if not started:
        raise RuntimeError("Failed to start dense worker sidecar.")
        
    doc_store = SQLiteDocumentStore(str(db_path))
    vec_store = DesktopFaissVectorStore(str(vec_path), doc_store, dimensions=384)
    provider = ZMQEmbeddingProvider(port=port)
    
    engine = UnifiedRetrievalEngine(
        document_store=doc_store,
        embedding_provider=provider,
        vector_store=vec_store,
        sparse_store=None
    )
    
    yield engine, vec_store, provider, doc_store
    
    print("\n[+] Committing FAISS index to disk...")
    vec_store.commit()
    print("[+] Tearing down sidecar...")
    server_manager.stop_server()

def test_01_build_semantic_corpus(semantic_engine):
    engine, vec_store, _, doc_store = semantic_engine
    
    print(f"\n[+] Building Semantic Index from {DATASET}...")
    start_time = time.time()
    
    # We index 5000 documents by default for the test to prove end-to-end viability without 
    # waiting hours for a full 170k dense embedding run on local hardware.
    # Set INDEX_LIMIT=0 to index the full corpus.
    limit_env = int(os.environ.get("INDEX_LIMIT", 5000))
    limit_arg = limit_env if limit_env > 0 else None
    
    generator = doc_iterator(CORPUS_PATH, limit=limit_arg)
    chunk_size = 5000 if limit_arg else 10000
    batch = []
    total_indexed = 0
    
    for doc in generator:
        batch.append(doc)
        if len(batch) >= chunk_size:
            print(f"Indexing batch of {len(batch)}... (Total: {total_indexed + len(batch)})")
            engine.index(batch, incremental=True, batch_size=256)
            total_indexed += len(batch)
            batch = []
            
    if batch:
        print(f"Indexing final batch of {len(batch)}... (Total: {total_indexed + len(batch)})")
        engine.index(batch, incremental=True, batch_size=256)
        total_indexed += len(batch)
        
    build_time = time.time() - start_time
    print(f"\n[!] Indexed {total_indexed} documents semantically in {build_time:.2f} seconds.")
    
    assert vec_store.index.ntotal == total_indexed

def test_02_semantic_search(semantic_engine):
    engine, _, _, _ = semantic_engine
    
    queries = [
        "what is the origin of COVID-19",
        "coronavirus response to weather changes"
    ]
    
    for q in queries:
        start = time.time()
        results = engine.search(q, mode="semantic", top_k=10)
        latency = (time.time() - start) * 1000
        
        print(f"\nQuery: '{q}' | Latency: {latency:.2f}ms")
        for i, r in enumerate(results, 1):
            print(f"  [{i}] ID: {r.id}, Score: {r.score:.4f}")
            
        assert len(results) > 0
        # assert latency < 500  # Semantic search should be fast!

def test_03_prefiltering_rbac(semantic_engine):
    engine, vec_store, _, doc_store = semantic_engine
    query = "what"
    
    # Raw unfiltered
    unfiltered = engine.search(query, mode="semantic", top_k=10)
    
    if len(unfiltered) < 3:
        print("Skipping RBAC test due to insufficient results in limited index.")
        return
    
    # Simulate an RBAC metadata filter that only allows the 2nd and 3rd docs
    allowed_docs = [unfiltered[1].id, unfiltered[2].id]
    
    # We directly mock the `get_allowed_internal_ids` on the doc store for the test
    import numpy as np
    internal_ids = []
    for doc_id in allowed_docs:
        with doc_store._get_connection() as conn:
            cursor = conn.execute("SELECT internal_id FROM documents WHERE doc_id = ?", (doc_id,))
            row = cursor.fetchone()
            if row:
                internal_ids.append(row["internal_id"])
                
    original_get = doc_store.get_allowed_internal_ids
    doc_store.get_allowed_internal_ids = lambda filters: np.array(internal_ids, dtype=np.int64)
    
    filtered = engine.search(query, mode="semantic", top_k=10, filters={"dummy": "filter"})
    
    # Restore original function
    doc_store.get_allowed_internal_ids = original_get
    
    assert len(filtered) <= 2
    for r in filtered:
        assert r.id in allowed_docs

if __name__ == "__main__":
    print("Running Semantic Indexing Tests Manually...")
    
    # Manually instantiate the fixture generator
    gen = semantic_engine()
    engine, vec_store, provider, doc_store = next(gen)
    
    try:
        print("\n--- Running test_01_build_semantic_corpus ---")
        test_01_build_semantic_corpus((engine, vec_store, provider, doc_store))
        print("test_01_build_semantic_corpus passed.")
        
        print("\n--- Running test_02_semantic_search ---")
        test_02_semantic_search((engine, vec_store, provider, doc_store))
        print("test_02_semantic_search passed.")
        
        print("\n--- Running test_03_prefiltering_rbac ---")
        test_03_prefiltering_rbac((engine, vec_store, provider, doc_store))
        print("test_03_prefiltering_rbac passed.")
        
        print("\nALL SEMANTIC TESTS PASSED SUCCESSFULLY!")
    finally:
        # Trigger cleanup
        try:
            next(gen)
        except StopIteration:
            pass