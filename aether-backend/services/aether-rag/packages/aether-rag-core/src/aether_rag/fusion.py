"""
@.architecture Reciprocal Rank Fusion (RRF) Algorithm

Implements IFusionStrategy for the Hexagonal pipeline.
"""

import logging
from typing import List
import numpy as np

from .interfaces import ScoredResult, IFusionStrategy, IVectorStore, ISparseStore

logger = logging.getLogger(__name__)

class RRFFusionStrategy(IFusionStrategy):
    def __init__(self, k: int = 60, semantic_weight: float = 0.5, bm25_weight: float = 0.5):
        self.k = k
        self.semantic_weight = semantic_weight
        self.bm25_weight = bm25_weight

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
        Combine semantic and sparse results using Reciprocal Rank Fusion.
        RRF operates entirely on ranks. Disjoint results do not require exact score lookups.
        To strictly match standard ranx formulation, a missing document contributes 0.0.
        """
        # Extract weights and k from kwargs for dynamic per-query configuration
        semantic_weight = kwargs.get("semantic_weight", self.semantic_weight)
        bm25_weight = kwargs.get("bm25_weight", self.bm25_weight)
        k_param = kwargs.get("rrf_k", self.k)

        # Build rank maps: doc_id -> rank (1-based)
        semantic_ranks = {res.id: rank for rank, res in enumerate(vector_results, start=1)}
        sparse_ranks = {res.id: rank for rank, res in enumerate(sparse_results, start=1)}

        # Create a stable, deterministic list of unique doc IDs while preserving order.
        # We process semantic first, then sparse.
        all_doc_ids_list = []
        seen_docs = set()
        
        for res in vector_results:
            if res.id not in seen_docs:
                seen_docs.add(res.id)
                all_doc_ids_list.append(res.id)
                
        for res in sparse_results:
            if res.id not in seen_docs:
                seen_docs.add(res.id)
                all_doc_ids_list.append(res.id)

        fused_results = []
        for doc_id in all_doc_ids_list:
            score = 0.0

            rank_s = semantic_ranks.get(doc_id)
            if rank_s is not None:
                score += semantic_weight * (1.0 / (k_param + rank_s))

            rank_b = sparse_ranks.get(doc_id)
            if rank_b is not None:
                score += bm25_weight * (1.0 / (k_param + rank_b))

            fused_results.append(ScoredResult(id=doc_id, score=score))

        # Sort by RRF score descending. 
        # Python's sort is stable, so original rank order acts as a deterministic tie-breaker.
        fused_results.sort(key=lambda x: x.score, reverse=True)

        return fused_results[:top_k]
