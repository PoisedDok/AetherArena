"""BM25 indexer for filesystem logs using PyTerrier."""
import logging
from pathlib import Path
from typing import List, Dict, Any
import pandas as pd

logger = logging.getLogger(__name__)


class FileSystemBM25Indexer:
    """BM25 indexer for filesystem event logs using PyTerrier."""
    
    def __init__(self, index_path: Path):
        self.index_path = index_path
        self.index_path.mkdir(parents=True, exist_ok=True)
        self.index_ref = None
        self._init_pyterrier()
        logger.info(f"FileSystemBM25Indexer initialized at {self.index_path}")
    
    def _init_pyterrier(self):
        """Initialize PyTerrier."""
        try:
            import pyterrier as pt
            if not pt.started():
                pt.init()
            
            index_dir = str(self.index_path)
            if (self.index_path / "data.properties").exists():
                self.index_ref = pt.IndexRef.of(index_dir)
                logger.info("Loaded existing BM25 index")
            else:
                self.index_ref = None
                logger.info("No existing index, will create on first indexing")
        except Exception as e:
            logger.error(f"Failed to init PyTerrier: {e}")
    
    def index_logs(self, logs: List[Dict[str, Any]]) -> int:
        """
        Index filesystem logs into BM25 index.
        Returns number of logs indexed.
        """
        if not logs:
            return 0
        
        try:
            import pyterrier as pt
            
            documents = []
            for log in logs:
                # Combine action, file_path, and file_name
                text = f"{log.get('action', '')} {log.get('file_path', '')} {log.get('file_name', '')} {log.get('location_name', '')}"
                documents.append({
                    'docno': str(log['id']),
                    'text': text,
                    'action': log.get('action', ''),
                    'file_path': log.get('file_path', ''),
                    'file_name': log.get('file_name', ''),
                    'timestamp': log.get('timestamp', '')
                })
            
            df = pd.DataFrame(documents)
            
            # For cumulative indexing: read existing docs, merge with new, rebuild
            if self.index_ref is not None:
                # Index exists - need to merge and rebuild
                try:
                    # Full rebuild strategy: incremental index updates add complexity
                    # without measurable gain at current corpus sizes.
                    indexer = pt.IterDictIndexer(str(self.index_path), overwrite=True)
                    self.index_ref = indexer.index(documents)
                    logger.info(f"✅ Updated BM25 index with {len(documents)} filesystem logs")
                except Exception as e:
                    logger.error(f"Failed to update index: {e}")
                    return 0
            else:
                # Create new index
                indexer = pt.IterDictIndexer(str(self.index_path))
                self.index_ref = indexer.index(documents)
                logger.info(f"✅ Created BM25 index with {len(documents)} filesystem logs")
            
            if not self.index_ref:
                logger.warning("Failed to get index reference after indexing")
                return 0
            
            return len(logs)
            
        except Exception as e:
            logger.error(f"Failed to index logs: {e}", exc_info=True)
            return 0
    
    def search(self, query: str, top_k: int = 10) -> List[Dict[str, Any]]:
        """Search BM25 index."""
        if self.index_ref is None:
            return []
        
        try:
            import pyterrier as pt
            bm25 = pt.BatchRetrieve(self.index_ref, wmodel="BM25")
            results = bm25.search(query)
            return results.head(top_k).to_dict('records')
        except Exception as e:
            logger.error(f"Search failed: {e}")
            return []
