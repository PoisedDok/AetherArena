try:
    import zmq
except ImportError:
    zmq = None

import json
from typing import List, Optional, Dict, Any
import numpy as np

from .interfaces import IEmbeddingProvider, ISparseStore, Document, ScoredResult

class ZMQClientBase:
    def __init__(self, port: int, timeout_ms: int = 5000):
        if zmq is None:
            raise ImportError("zmq is required for ZMQClientBase but is not installed.")
        self.port = port
        self.timeout_ms = timeout_ms
        self.context = zmq.Context.instance()
        self._local = __import__('threading').local()

    def _get_socket(self, timeout: Optional[int] = None) -> zmq.Socket:
        if not hasattr(self._local, 'socket'):
            socket = self.context.socket(zmq.REQ)
            # REQ_RELAXED allows sending another request without receiving the previous one if it failed
            socket.setsockopt(zmq.REQ_RELAXED, 1)
            socket.setsockopt(zmq.REQ_CORRELATE, 1)
            socket.connect(f"tcp://127.0.0.1:{self.port}")
            self._local.socket = socket
            
        t = timeout or self.timeout_ms
        self._local.socket.setsockopt(zmq.RCVTIMEO, t)
        self._local.socket.setsockopt(zmq.SNDTIMEO, t)
        return self._local.socket

    def _send_request(self, task_type: str, payload: Dict[str, Any], timeout: Optional[int] = None) -> Dict[str, Any]:
        payload["task_type"] = task_type
        socket = self._get_socket(timeout=timeout)
        
        try:
            socket.send_json(payload)
            response = socket.recv_json()
            if response.get("status") == "error":
                raise RuntimeError(f"Worker Error: {response.get('message')}")
            return response
        except zmq.error.Again:
            raise TimeoutError(f"ZMQ request to {task_type} worker timed out")

    def cleanup(self):
        """Explicitly release ZMQ sockets."""
        if hasattr(self._local, 'socket') and self._local.socket:
            try:
                self._local.socket.close()
            except Exception:
                pass
            self._local.socket = None

class ZMQEmbeddingProvider(ZMQClientBase, IEmbeddingProvider):
    def embed_documents(self, texts: List[str], **kwargs) -> np.ndarray:
        if not texts:
            return np.array([])
            
        # Batching to prevent ZMQ payload crash and worker timeouts
        batch_size = 256
        all_embeddings = []
        
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            resp = self._send_request("dense", {"type": "embed_documents", "texts": batch}, timeout=300000)
            all_embeddings.extend(resp.get("embeddings", []))
            if (i // batch_size) % 10 == 0:
                print(f"[ZMQ Client] Embedded {i + len(batch)} / {len(texts)} documents...", flush=True)
            
        return np.array(all_embeddings, dtype=np.float32)

    def embed_query(self, text: str, **kwargs) -> np.ndarray:
        resp = self._send_request("dense", {"type": "embed_query", "text": text}, timeout=10000)
        return np.array(resp.get("embedding", []), dtype=np.float32)

class ZMQSparseStore(ZMQClientBase, ISparseStore):
    def __init__(self, port: int, index_path: str, timeout_ms: int = 5000):
        super().__init__(port, timeout_ms)
        self.index_path = index_path

    def build(self, documents: List[Document], **kwargs) -> None:
        import tempfile
        import os
        
        # Write to temp file to avoid huge ZMQ payloads
        fd, temp_path = tempfile.mkstemp(suffix=".jsonl")
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                for d in documents:
                    json.dump({"id": d.id, "text": d.text}, f)
                    f.write("\n")
            
            self._send_request("sparse", {
                "type": "build_from_file", 
                "file_path": temp_path, 
                "index_path": self.index_path, 
                "kwargs": kwargs
            }, timeout=300000)
        except Exception:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise

    def add(self, documents: List[Document], **kwargs) -> None:
        # Same temp file trick for additions
        import tempfile
        import os
        
        fd, temp_path = tempfile.mkstemp(suffix=".jsonl")
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                for d in documents:
                    json.dump({"id": d.id, "text": d.text}, f)
                    f.write("\n")
            
            self._send_request("sparse", {
                "type": "add_from_file", 
                "file_path": temp_path, 
                "index_path": self.index_path, 
                "kwargs": kwargs
            }, timeout=300000)
        except Exception:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise

    def search(self, query: str, top_k: int, allowed_docnos: Optional[List[str]] = None, **kwargs) -> List[ScoredResult]:
        resp = self._send_request("sparse", {
            "type": "search", 
            "query": query, 
            "top_k": top_k, 
            "index_path": self.index_path,
            "allowed_docnos": allowed_docnos
        })
        return [ScoredResult(id=r["id"], score=r["score"]) for r in resp.get("results", [])]

    def search_batch(
        self, 
        queries: List[str], 
        qids: List[str], 
        top_k: int, 
        allowed_docnos: Optional[List[str]] = None, 
        **kwargs
    ) -> Dict[str, List[ScoredResult]]:
        # For now, just implement a naive loop since ZMQ payload batching isn't fully set up for sparse.
        # This fulfills the interface contract.
        batch_results = {}
        for qid, query in zip(qids, queries):
            batch_results[qid] = self.search(query, top_k, allowed_docnos, **kwargs)
        return batch_results
