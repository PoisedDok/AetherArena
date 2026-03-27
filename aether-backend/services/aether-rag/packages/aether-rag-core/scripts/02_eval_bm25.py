"""
Evaluation of BM25 Index
Uses ir_measures to compute standard metrics (nDCG@10, MAP@100, Recall@1000).
"""

import os
import sys
import json
import time
import logging
from pathlib import Path
import ir_measures
from ir_measures import nDCG, AP, R, P, RR

# Add src to path
src_path = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(src_path))

from aether_rag.sparse_backend import PyTerrierSparseStore

# Import our unified benchmark config
try:
    from beir_config import DATASET_CONFIG
except ImportError:
    # Fallback if run from a different CWD
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from beir_config import DATASET_CONFIG

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DATASET = os.environ.get("DATASET", "trec-covid")
config = DATASET_CONFIG.get(DATASET)
if not config:
    logger.error(f"Dataset {DATASET} not found in DATASET_CONFIG.")
    sys.exit(1)

PROJECT_ROOT = Path("/Volumes/Disk-D/Aether/Aether/AetherArena")
DOCS_DIR = PROJECT_ROOT / "docs" / "dataset" / DATASET
QUERIES_PATH = DOCS_DIR / "queries.jsonl"
QRELS_PATH = DOCS_DIR / "qrels" / "test.tsv"
INDEX_PATH = Path(__file__).resolve().parent.parent / "tests" / ".pytest_cache" / f"{DATASET}_bm25_index"

def load_queries():
    queries = {}
    with open(QUERIES_PATH, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip(): continue
            data = json.loads(line)
            qid = str(data["_id"])
            # BEIR strictly evaluates on the 'text' field of the query.
            # Do not combine metadata fields as that creates an unfair baseline comparison.
            query_text = data.get("text", "").strip()
            queries[qid] = query_text
    return queries

def load_qrels():
    qrels = {}
    with open(QRELS_PATH, "r", encoding="utf-8") as f:
        # Skip header
        next(f)
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 3:
                qid = parts[0]
                docid = parts[1]
                score = int(parts[2])
                
                if qid not in qrels:
                    qrels[qid] = {}
                # Only keep positive relevance, or let ir_measures handle 0?
                # ir_measures uses the score natively for nDCG
                qrels[qid][docid] = score
    return qrels

def evaluate_bm25():
    if not INDEX_PATH.exists():
        logger.error(f"Index not found at {INDEX_PATH}. Run indexing first.")
        sys.exit(1)
        
    logger.info("Loading queries and qrels...")
    queries = load_queries()
    qrels = load_qrels()
    logger.info(f"Loaded {len(queries)} queries and qrels for {len(qrels)} queries.")
    
    logger.info("Initializing PyTerrierSparseStore...")
    store = PyTerrierSparseStore(str(INDEX_PATH), bm25_k1=0.9, bm25_b=0.4)
    
    logger.info("Executing batch search on all queries (top_k=1000)...")
    qids = list(queries.keys())
    query_texts = list(queries.values())
    
    start_time = time.time()
    batch_results = store.search_batch(queries=query_texts, qids=qids, top_k=1000)
    latency = time.time() - start_time
    logger.info(f"Batch search completed in {latency:.2f} seconds.")
    
    # Format for ir_measures: {qid: {docid: score}}
    run_dict = {}
    for qid, results in batch_results.items():
        run_dict[qid] = {}
        for r in results:
            run_dict[qid][r.id] = r.score
            
    logger.info("Computing metrics with ir_measures...")
    metrics = [
        nDCG@10, nDCG@100, 
        AP@100, AP@1000, 
        R@100, R@1000,
        RR@10, P@10
    ]
    
    agg_results = ir_measures.calc_aggregate(metrics, qrels, run_dict)
    
    print("\n" + "="*50)
    print(f"BM25 EVALUATION RESULTS ({config['name']})")
    print("="*50)
    
    # Print sorted by metric name for readability
    for metric in sorted(agg_results.keys(), key=str):
        print(f"{str(metric):<15} : {agg_results[metric]:.4f}")
    
    print("-" * 50)
    print(f"📊 BEIR BASELINE COMPARISON ({config['name']})")
    print("-" * 50)
    print(f"{'Metric':<15} | {'Our PyTerrier':<12} | {config['bm25_baseline_name']}")
    print("-" * 50)
    
    ndcg10_score = agg_results.get(nDCG@10, 0.0)
    baseline = config['bm25_baseline']
    print(f"{'nDCG@10':<15} | {ndcg10_score:<12.4f} | {baseline:.4f}")
    
    if ndcg10_score > baseline:
        print(f"\n✅ Conclusion: Our PyTerrier implementation OUTPERFORMS the {config['bm25_baseline_name']} baseline.")
    else:
        print(f"\n❌ Conclusion: Our implementation is below the {config['bm25_baseline_name']} baseline.")
        
    print("="*50)
    
if __name__ == "__main__":
    evaluate_bm25()
