"""
@.architecture PyTerrier Sparse Store Backend

This module implements the ISparseStore interface, wrapping PyTerrier.
It is intended to be run strictly INSIDE the isolated JVM sidecar process
to prevent GIL contention and fate-sharing with PyTorch CUDA.
"""

import os
import logging
import gc
import re
from pathlib import Path
from typing import List, Optional, Iterable, Dict

try:
    import pandas as pd
except ImportError:
    pd = None

from .interfaces import ISparseStore, Document, ScoredResult

logger = logging.getLogger(__name__)

# Sanitize query for PyTerrier at module level
def sanitize_query(query: str) -> str:
    q = str(query)
    q = re.sub(r"[^a-zA-Z0-9\s]", " ", q)
    q = re.sub(r"\s+", " ", q).strip()
    return q

class PyTerrierSparseStore(ISparseStore):
    def __init__(self, index_path: str | Path, bm25_k1: float = 1.2, bm25_b: float = 0.75):
        if pd is None:
            raise ImportError("pandas is required for PyTerrierSparseStore but is not installed.")
            
        self.index_path = Path(index_path)
        self.index_path.mkdir(parents=True, exist_ok=True)
        self.bm25_k1 = bm25_k1
        self.bm25_b = bm25_b
        
        # Thread constraints BEFORE pyterrier init
        os.environ.setdefault('OMP_NUM_THREADS', '1')
        
        # Ensure PyTerrier is initialized
        import pyterrier as pt
        if not pt.started():
            pt.init(mem=8192) # 8GB limit for desktop indexing of 500k+ docs
            
        self.pt = pt
        self.indexref = None
        self._base_retr = None
        self._query_count = 0
        
        # Try loading existing index
        if (self.index_path / "data.properties").exists():
            try:
                self.indexref = self.pt.IndexRef.of(str(self.index_path / "data.properties"))
                self._base_retr = self._get_retriever()
            except Exception as e:
                logger.warning(f"Failed to load existing PyTerrier index: {e}")

    def _get_retriever(self, custom_k1: Optional[float] = None, custom_b: Optional[float] = None, custom_k3: Optional[float] = None):
        """Build or fetch pipeline dynamically based on parameters."""
        if not self.indexref:
            return None
            
        k1 = custom_k1 if custom_k1 is not None else self.bm25_k1
        b = custom_b if custom_b is not None else self.bm25_b
        
        controls = {"bm25.k_1": float(k1), "bm25.b": float(b)}
        if custom_k3 is not None:
            controls["bm25.k_3"] = float(custom_k3)
            
        # We use pt.terrier.Retriever (modern API) instead of the deprecated BatchRetrieve
        # Ensure we don't mutate num_results later; set a high maximum (e.g., 10000).
        return self.pt.terrier.Retriever(
            self.indexref, 
            wmodel="BM25",
            controls=controls,
            metadata=["docno"],
            num_results=10000
        )
        
    def _manage_jvm_gc(self):
        """Forces Python to clean up PyJNIus proxies to prevent Java heap exhaustion."""
        self._query_count += 1
        if self._query_count > 1000:
            self._base_retr = self._get_retriever() # Re-instantiate to clear JVM caches
            self._query_count = 0
            gc.collect()

    def build(self, documents: Iterable[Document], **kwargs) -> None:
        """
        Build a completely new index, wiping out existing ones.
        """
        import shutil
        if self.index_path.exists():
            shutil.rmtree(self.index_path)
        self.index_path.mkdir(parents=True, exist_ok=True)
        
        # Changed meta={'docno': 128} because a standard UUID (36 chars) + '__v' (3 chars) + time_ns (19 chars) 
        # equals 58 characters. If we used 48, PyTerrier would silently truncate the document IDs!
        indexer = self.pt.IterDictIndexer(
            str(self.index_path), 
            overwrite=True, 
            meta={'docno': 128},
            properties={"termpipelines": "Stopwords,PorterStemmer", "index.blocks": "true"}
        )
        
        def doc_generator():
            for doc in documents:
                yield {"docno": doc.id, "text": doc.text}
                
        self.indexref = indexer.index(doc_generator())
        self._base_retr = self._get_retriever()

    def add(self, documents: Iterable[Document], **kwargs) -> None:
        """
        Incremental appending is disabled.
        Because indexing is extremely fast (e.g., 14 seconds for 170k docs), and PyTerrier
        does not natively support appending to an existing index without risking statistical 
        drift or fragmenting the lexicon, the architectural decision is to ALWAYS rebuild.
        
        To update the index incrementally, the orchestrator should stream the entire corpus
        from the DocumentStore and call `build()`.
        """
        raise NotImplementedError(
            "Incremental appends are intentionally disabled for PyTerrier. "
            "Please stream the full corpus from the DocumentStore and call build() instead."
        )

    def search(self, query: str, top_k: int, allowed_docnos: Optional[List[str]] = None, **kwargs) -> List[ScoredResult]:
        """
        Search using PyTerrier DAG.
        Filters candidates in Python via Vectorized Pandas slicing to avoid `iterrows()` bottlenecks.
        """
        # Dynamic parameter injection
        k1 = kwargs.get("bm25_k1")
        b = kwargs.get("bm25_b")
        k3 = kwargs.get("bm25_k3")
        
        if k1 is not None or b is not None or k3 is not None:
            retr = self._get_retriever(k1, b, k3)
        else:
            if not self._base_retr:
                self._base_retr = self._get_retriever()
            retr = self._base_retr
            
        if not retr:
            return []
            
        q = sanitize_query(query)
        if not q:
            return []
            
        try:
            # fetch_k limit handled natively by the retr pipeline initialized at 10000
            res = retr.search(q)
            self._manage_jvm_gc()
            
            if res.empty:
                return []
                
            # Check pre-filter
            if allowed_docnos is not None:
                allowed_set = set(allowed_docnos)
                mask = res['docno'].astype(str).isin(allowed_set)
                res = res[mask]
                
            res = res.head(top_k)
            
            results = [ScoredResult(id=str(row.docno), score=float(row.score)) for row in res.itertuples()]
            return results
            
        except Exception as e:
            logger.error(f"PyTerrier search failed: {e}")
            return []

    def search_batch(self, queries: List[str], qids: List[str], top_k: int, allowed_docnos: Optional[List[str]] = None, **kwargs) -> Dict[str, List[ScoredResult]]:
        """Batch retrieval using DataFrame transform and groupby."""
        if not self._base_retr:
            self._base_retr = self._get_retriever()
        retr = self._base_retr
        if not retr:
            return {}
            
        query_df = pd.DataFrame([
            {"qid": qid, "query": sanitize_query(text)}
            for qid, text in zip(qids, queries)
            if sanitize_query(text)
        ])
        
        if query_df.empty:
            return {qid: [] for qid in qids}
            
        try:
            res_df = retr.transform(query_df)
            self._manage_jvm_gc()
            
            if res_df.empty:
                return {str(qid): [] for qid in qids}
            
            results_dict = {}
            for qid, group in res_df.groupby("qid"):
                if allowed_docnos is not None:
                    allowed_set = set(allowed_docnos)
                    group = group[group['docno'].astype(str).isin(allowed_set)]
                    
                group = group.head(top_k)
                results_dict[str(qid)] = [
                    ScoredResult(id=str(row.docno), score=float(row.score)) 
                    for row in group.itertuples()
                ]
                
            # Fill missing
            for qid in qids:
                if str(qid) not in results_dict:
                    results_dict[str(qid)] = []
                    
            return results_dict
        except Exception as e:
            logger.error(f"PyTerrier batch search failed: {e}")
            return {str(qid): [] for qid in qids}
