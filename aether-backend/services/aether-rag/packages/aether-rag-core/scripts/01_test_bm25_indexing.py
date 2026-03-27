import os
import sys
import json
import time
import pytest
from pathlib import Path
from typing import Iterator

# Setup path so aether_rag package is found correctly
PROJECT_ROOT = Path("/Volumes/Disk-D/Aether/Aether/AetherArena")
SRC_PATH = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC_PATH))

from aether_rag.sparse_backend import PyTerrierSparseStore
from aether_rag.interfaces import Document

DATASET = os.environ.get("DATASET", "trec-covid")
CORPUS_PATH = PROJECT_ROOT / f"docs/dataset/{DATASET}/corpus.jsonl"
INDEX_PATH = Path(__file__).resolve().parent.parent / "tests" / ".pytest_cache" / f"{DATASET}_bm25_index"

# We only run this if the corpus exists
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

@pytest.fixture(scope="module")
def sparse_store():
    # Setup
    store = PyTerrierSparseStore(index_path=INDEX_PATH)
    yield store

def test_01_build_entire_corpus(sparse_store):
    """
    Test that the iterable streaming build mechanism correctly indexes the corpus
    without causing OOM or crashing.
    """
    start_time = time.time()
    # Read entire corpus
    limit_env = int(os.environ.get("INDEX_LIMIT", 0))
    limit_arg = limit_env if limit_env > 0 else None
    generator = doc_iterator(CORPUS_PATH, limit=limit_arg)
    sparse_store.build(generator)
    build_time = time.time() - start_time
    
    # Assert index files exist
    assert (INDEX_PATH / "data.properties").exists()
    assert (INDEX_PATH / "data.lexicon.fsomapfile").exists()
    
    # Check that retriever pipeline is populated
    assert sparse_store._base_retr is not None
    print(f"\nIndexed entire {DATASET} corpus in {build_time:.2f} seconds.")

def test_02_search_retrieval_and_latency(sparse_store):
    """
    Test standard single search retrieval performance and correctness.
    """
    queries = [
        "what is the origin of COVID-19",
        "coronavirus response to weather changes",
        "immunity and antibodies for sars cov 2"
    ]
    
    for q in queries:
        start = time.time()
        results = sparse_store.search(q, top_k=10)
        latency = (time.time() - start) * 1000
        
        assert len(results) > 0, f"Query '{q}' returned no results"
        assert latency < 1500, f"Query '{q}' was too slow: {latency:.2f}ms"
        
        # Results should be sorted by score
        scores = [r.score for r in results]
        assert scores == sorted(scores, reverse=True), "Results are not sorted by score"

def test_03_batch_search_correctness(sparse_store):
    """
    Test batch retrieval using transform to avoid JNI bottlenecks.
    """
    queries = [
        "origin of COVID-19",
        "weather changes coronavirus"
    ]
    qids = ["q1", "q2"]
    
    batch_results = sparse_store.search_batch(queries=queries, qids=qids, top_k=5)
    
    assert "q1" in batch_results
    assert "q2" in batch_results
    
    assert len(batch_results["q1"]) > 0
    assert len(batch_results["q2"]) > 0
    
    # Assert sorting per group
    for qid, results in batch_results.items():
        scores = [r.score for r in results]
        assert scores == sorted(scores, reverse=True), f"Batch results for {qid} not sorted"

def test_04_add_disabled(sparse_store):
    """
    Verify that add() raises NotImplementedError, as incremental appends 
    are architecturally disabled for PyTerrier.
    """
    dummy_doc = Document(id="dummy", text="dummy text")
    with pytest.raises(NotImplementedError):
        sparse_store.add([dummy_doc])

def test_05_prefiltering_rbac(sparse_store):
    """
    Verify that allowed_docnos correctly filters results at the python layer.
    """
    # Use a highly common word to guarantee results across different domains
    query = "what"
    unfiltered_results = sparse_store.search(query, top_k=10)
    
    if len(unfiltered_results) < 3:
        print("Skipping RBAC test due to insufficient results in limited index.")
        return

    # Allow only the 2nd and 3rd document
    allowed_ids = [unfiltered_results[1].id, unfiltered_results[2].id]
    
    filtered_results = sparse_store.search(query, top_k=10, allowed_docnos=allowed_ids)
    
    assert len(filtered_results) <= 2
    for r in filtered_results:
        assert r.id in allowed_ids, f"Doc {r.id} returned but wasn't in allowed_ids"

def test_06_build_overwrite(sparse_store):
    """
    Verify that calling build() a second time completely overwrites the existing index
    without throwing the ValueError from PyTerrier.
    """
    # Create a tiny subset of documents
    mini_docs = [
        Document(id="dummy1", text="some generic test text"),
        Document(id="dummy2", text="another test text document")
    ]
    
    # Rebuild the index completely
    sparse_store.build(mini_docs)
    
    # Search should only return from the mini index
    results = sparse_store.search("test text", top_k=5)
    assert len(results) > 0
    assert results[0].id == "dummy1" or results[0].id == "dummy2"
    
    # Original queries should fail (return 0) on the new overwritten index
    results = sparse_store.search("coronavirus", top_k=5)
    assert len(results) == 0

if __name__ == "__main__":
    print("Initializing sparse store...")
    store = PyTerrierSparseStore(index_path=INDEX_PATH)
    
    print("\n--- Running test_01_build_entire_corpus ---")
    test_01_build_entire_corpus(store)
    
    print("\n--- Running test_02_search_retrieval_and_latency ---")
    test_02_search_retrieval_and_latency(store)
    print("test_02_search_retrieval_and_latency passed.")
    
    print("\n--- Running test_03_batch_search_correctness ---")
    test_03_batch_search_correctness(store)
    print("test_03_batch_search_correctness passed.")
    
    print("\n--- Running test_04_add_disabled ---")
    test_04_add_disabled(store)
    print("test_04_add_disabled passed.")
    
    print("\n--- Running test_05_prefiltering_rbac ---")
    test_05_prefiltering_rbac(store)
    print("test_05_prefiltering_rbac passed.")
    
    print("\n--- Running test_06_build_overwrite ---")
    test_06_build_overwrite(store)
    print("test_06_build_overwrite passed.")
    
    print("\nRestoring the index back to full for manual testing...")
    test_01_build_entire_corpus(store)
    
    print("\nALL TESTS PASSED SUCCESSFULLY!")

