import sys
import time
import json
import os
import pandas as pd
import ir_measures
from ir_measures import *
from pathlib import Path
import numpy as np

# Setup path
PROJECT_ROOT = Path("/Volumes/Disk-D/Aether/Aether/AetherArena")
sys.path.insert(0, str(PROJECT_ROOT / "aether-backend/services/aether_rag/packages/aether-rag-core/src"))

from aether_rag.document_store import SQLiteDocumentStore
from aether_rag.vector_store import DesktopFaissVectorStore
from aether_rag.sparse_backend import PyTerrierSparseStore
from aether_rag.zmq_clients import ZMQEmbeddingProvider
from aether_rag.retrieval_server_manager import RetrievalServerManager
from aether_rag.engine import UnifiedRetrievalEngine
from aether_rag.fusion import RRFFusionStrategy

try:
    from beir_config import DATASET_CONFIG
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from beir_config import DATASET_CONFIG

DATASET = os.environ.get("DATASET", "trec-covid")
config = DATASET_CONFIG.get(DATASET)
if not config:
    print(f"Error: Dataset {DATASET} not found in DATASET_CONFIG.")
    sys.exit(1)

# Paths
DATASET_DIR = PROJECT_ROOT / "docs/dataset" / DATASET
SPARSE_INDEX_DIR = Path(__file__).resolve().parent.parent / "tests" / ".pytest_cache" / f"{DATASET}_bm25_index"
SEMANTIC_INDEX_DIR = Path(__file__).resolve().parent.parent / "tests" / ".pytest_cache" / f"{DATASET}_semantic_index"

QRELS_PATH = DATASET_DIR / "qrels" / "test.tsv"
QUERIES_PATH = DATASET_DIR / "queries.jsonl"
OUTPUT_FILE = PROJECT_ROOT / "docs/dissertation/drafts" / f"{DATASET}_hybrid_evaluation_results.txt"

def load_queries(queries_path: Path) -> pd.DataFrame:
    """Load queries exactly matching the BEIR TREC-COVID baseline."""
    queries = []
    with open(queries_path, 'r', encoding='utf-8') as f:
        for line in f:
            data = json.loads(line)
            qid = data['_id']
            # BEIR strictly evaluates on the 'text' field of the query.
            # Do not combine metadata fields as that creates an unfair baseline comparison.
            query_text = data.get('text', '').strip()
            
            queries.append({'qid': str(qid), 'query': query_text})
    return pd.DataFrame(queries)

def load_qrels(qrels_path: Path) -> pd.DataFrame:
    """Load relevance judgments."""
    qrels = []
    with open(qrels_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip() == "query-id\tcorpus-id\tscore":
                continue
            parts = line.strip().split()
            if len(parts) == 3:
                qid, doc_id, score = parts
                qrels.append({'query_id': str(qid), 'doc_id': str(doc_id), 'relevance': int(score)})
            elif len(parts) == 4:
                qid, _, doc_id, score = parts
                qrels.append({'query_id': str(qid), 'doc_id': str(doc_id), 'relevance': int(score)})
    return pd.DataFrame(qrels)

def run_hybrid_evaluation():
    print("==================================================")
    print(f"HYBRID (W-RRF) EVALUATION ({config['name']})")
    print("==================================================")
    
    if not SEMANTIC_INDEX_DIR.exists() or not SPARSE_INDEX_DIR.exists():
        print("ERROR: Missing indexes.")
        print("Please build both full semantic and sparse indexes first.")
        return

    # Load Dataset
    print(f"[*] Loading queries from {QUERIES_PATH}...")
    queries_df = load_queries(QUERIES_PATH)
    print(f"    Loaded {len(queries_df)} queries.")
    
    print(f"[*] Loading qrels from {QRELS_PATH}...")
    qrels_df = load_qrels(QRELS_PATH)
    print(f"    Loaded {len(qrels_df)} relevance judgments.")

    # Initialize Engine
    print("\n[*] Starting Hybrid Pipeline...")
    server_manager = RetrievalServerManager()
    started, port = server_manager.start_server(
        port=None,
        model_name="BAAI/bge-small-en-v1.5",
        embedding_mode="sentence-transformers"
    )
    if not started:
        raise RuntimeError("Failed to start dense worker sidecar.")

    try:
        db_path = SEMANTIC_INDEX_DIR / "docs.sqlite"
        vec_path = SEMANTIC_INDEX_DIR / "faiss_index"
        
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
        
        print("\n[*] Generating run file...")
        run_data = []
        
        start_time = time.time()
        for idx, row in queries_df.iterrows():
            qid = row['qid']
            query_text = row['query']
            
            # Retrieve top 1000 for standard MAP/Recall metrics. rrf_depth=1000 ensures deep fusion pool.
            results = engine.search(
                query=query_text, 
                mode="hybrid", 
                top_k=1000,
                rrf_depth=1000,
                semantic_weight=0.5,
                bm25_weight=0.5
            )
            
            for rank, res in enumerate(results):
                run_data.append({
                    'query_id': qid,
                    'doc_id': res.id,
                    'score': res.score
                })
                
            if (idx + 1) % 10 == 0:
                print(f"    Processed {idx + 1} / {len(queries_df)} queries")
                
        eval_time = time.time() - start_time
        print(f"[*] Search completed in {eval_time:.2f}s ({len(queries_df)/eval_time:.2f} q/s)")

        run_df = pd.DataFrame(run_data)
        
        # Define Metrics (matching BEIR paper)
        metrics = [
            nDCG@10, nDCG@100,
            AP@100, AP@1000,
            P@10,
            R@100, R@1000,
            RR@10
        ]
        
        print("\n[*] Computing Metrics...")
        results = ir_measures.calc_aggregate(metrics, qrels_df, run_df)
        
        # Sort and Format Output
        sorted_results = {str(k): v for k, v in sorted(results.items(), key=lambda x: str(x[0]))}
        
        print("\n==================================================")
        print("RESULTS (Hybrid W-RRF: BM25 + BGE-Small-EN-v1.5)")
        print("==================================================")
        
        output_lines = [
            "==================================================",
            "HYBRID EVALUATION RESULTS",
            "Model: Hybrid W-RRF (BM25 + BAAI/bge-small-en-v1.5)",
            f"Dataset: {config['name']}",
            "Weights: semantic=0.5, bm25=0.5, k=60",
            "=================================================="
        ]
        
        for metric, score in sorted_results.items():
            line = f"{metric.ljust(15)} : {score:.4f}"
            print(line)
            output_lines.append(line)
            
        print("-" * 50)
        print(f"📊 HYBRID VS BASELINES COMPARISON ({config['name']})")
        print("-" * 50)
        print(f"{'Metric':<15} | {'Our Hybrid RRF':<15} | {config['bm25_baseline_name']:<15} | {config['semantic_baseline_name']:<15}")
        print("-" * 65)
        
        output_lines.append("-" * 50)
        output_lines.append(f"📊 HYBRID VS BASELINES COMPARISON ({config['name']})")
        output_lines.append("-" * 50)
        output_lines.append(f"{'Metric':<15} | {'Our Hybrid RRF':<15} | {config['bm25_baseline_name']:<15} | {config['semantic_baseline_name']:<15}")
        output_lines.append("-" * 65)
        
        ndcg10_score = sorted_results.get(str(nDCG@10), 0.0)
        
        bm25_baseline = config['bm25_baseline']
        sem_baseline = config['semantic_baseline']
        
        comp_line = f"{'nDCG@10':<15} | {ndcg10_score:<15.4f} | {bm25_baseline:<15.4f} | {sem_baseline:<15.4f}"
        print(comp_line)
        output_lines.append(comp_line)
        
        output_lines.append("==================================================\n")
        
        with open(OUTPUT_FILE, 'w') as f:
            f.write('\n'.join(output_lines))
            
        print(f"\n[*] Results saved to {OUTPUT_FILE}")
        
    finally:
        print("[*] Tearing down sidecar...")
        server_manager.stop_server()

if __name__ == "__main__":
    run_hybrid_evaluation()