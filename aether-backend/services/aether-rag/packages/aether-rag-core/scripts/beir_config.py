DATASET_CONFIG = {
    "trec-covid": {
        "bm25_baseline": 0.6560, 
        "semantic_baseline": 0.7590,
        "name": "TREC-COVID",
        "bm25_baseline_name": "BEIR BM25 (Multifield)",
        "semantic_baseline_name": "MTEB BGE-Small"
    },
    "scifact": {
        "bm25_baseline": 0.6650, 
        "semantic_baseline": 0.7127,
        "name": "SciFact",
        "bm25_baseline_name": "BEIR BM25",
        "semantic_baseline_name": "MTEB BGE-Small"
    },
    "fiqa": {
        "bm25_baseline": 0.2360, 
        "semantic_baseline": 0.3000,
        "name": "FiQA",
        "bm25_baseline_name": "BEIR BM25",
        "semantic_baseline_name": "BEIR TAS-B"
    }
}
