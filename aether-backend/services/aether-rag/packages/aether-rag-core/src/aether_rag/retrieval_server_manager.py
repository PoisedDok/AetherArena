import json
import logging
import os
import sys
import atexit
import time
import multiprocessing as mp
import zmq
from typing import Optional

LOG_LEVEL = os.getenv("AETHER_RAG_LOG_LEVEL", "WARNING").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

def _is_colab_environment() -> bool:
    """Check if we're running in Google Colab environment."""
    return "COLAB_GPU" in os.environ or "COLAB_TPU" in os.environ

def run_sparse_worker(worker_url: str):
    """
    Isolated JVM/PyTerrier Process.
    The JVM boots ONLY in this process.
    """
    import signal
    import platform
    
    def graceful_shutdown(signum, frame):
        logger.info("Received SIGTERM. Tearing down JVM/ZMQ...")
        sys.exit(0)
        
    signal.signal(signal.SIGTERM, graceful_shutdown)
    if platform.system() == "Linux":
        try:
            import ctypes
            libc = ctypes.CDLL("libc.so.6")
            libc.prctl(1, signal.SIGTERM)
        except Exception:
            pass

    if os.environ.get("CI") == "true":
        sys.stdout = open(os.devnull, 'w')
        
    try:
        import pyterrier as pt
        if not pt.started():
            # Init JVM with explicit memory limits to prevent host OOM. 
            # 3GB is safe for local operation alongside heavy models.
            jvm_mem = os.getenv("PYTERRIER_MEM", "2048")
            pt.init(mem=int(jvm_mem))
            
        context = zmq.Context()
        socket = context.socket(zmq.REP)
        # Timeout to prevent zombies if parent dies
        socket.setsockopt(zmq.RCVTIMEO, 60000) 
        socket.connect(worker_url)
        
        logger.info(f"Sparse Worker (JVM) connected to {worker_url}")
        
        # Cache for loaded PyTerrier stores mapped by their index_path
        stores = {}

        while True:
            try:
                msg = socket.recv_json()
            except zmq.error.Again:
                if os.getppid() == 1:
                    logger.warning("Sparse Worker orphaned (PPID=1). Committing suicide.")
                    sys.exit(0)
                continue
            
            msg_type = msg.get("type")
            
            # Ping response for readiness probe
            if msg_type == "ping":
                socket.send_json({"status": "pong", "worker": "sparse"})
                continue
                
            try:
                if msg_type in ["build_from_file", "add_from_file"]:
                    file_path = msg.get("file_path")
                    index_path = msg.get("index_path")
                    
                    if not file_path or not index_path:
                        raise ValueError(f"Missing file_path or index_path for {msg_type}")
                        
                    # Lazy instantiate and cache the store
                    from .sparse_backend import PyTerrierSparseStore
                    if index_path not in stores:
                        stores[index_path] = PyTerrierSparseStore(index_path)
                    
                    store = stores[index_path]
                    
                    # Parse the .jsonl payload sent by the ZMQ client
                    from .interfaces import Document
                    import json
                    documents = []
                    with open(file_path, 'r', encoding='utf-8') as f:
                        for line in f:
                            if not line.strip(): continue
                            data = json.loads(line)
                            documents.append(Document(id=str(data["id"]), text=data["text"]))
                            
                    # Route to correct PyTerrier operation
                    try:
                        if msg_type == "build_from_file":
                            store.build(documents)
                        else:
                            store.add(documents)
                    finally:
                        if os.path.exists(file_path):
                            try:
                                os.remove(file_path)
                            except Exception:
                                pass
                        
                    socket.send_json({"status": "success", "type": msg_type})
                    
                elif msg_type == "search":
                    index_path = msg.get("index_path")
                    query = msg.get("query", "")
                    top_k = msg.get("top_k", 10)
                    allowed_docnos = msg.get("allowed_docnos")
                    
                    if not index_path:
                        raise ValueError("Missing index_path for search")
                        
                    from .sparse_backend import PyTerrierSparseStore
                    if index_path not in stores:
                        stores[index_path] = PyTerrierSparseStore(index_path)
                        
                    store = stores[index_path]
                    results = store.search(query, top_k, allowed_docnos)
                    
                    socket.send_json({
                        "status": "success", 
                        "type": "search", 
                        "results": [{"id": r.id, "score": r.score} for r in results]
                    })
                    
                else:
                    socket.send_json({"status": "error", "message": f"Unknown sparse task type: {msg_type}"})
                    
            except Exception as e:
                logger.error(f"Sparse Worker error processing {msg_type}: {e}")
                socket.send_json({"status": "error", "message": str(e)})
            
    except KeyboardInterrupt:
        logger.info("Sparse Worker shutting down cleanly.")
    except Exception as e:
        logger.error(f"Sparse Worker fatal error: {e}")


def run_dense_worker(worker_url: str, model_name: str, embedding_mode: str):
    """
    Isolated PyTorch/CUDA Process.
    CUDA context initializes ONLY in this process.
    """
    if os.environ.get("CI") == "true":
        sys.stdout = open(os.devnull, 'w')
        
    try:
        # Import heavy ML libraries only in this child process
        if embedding_mode == "sentence-transformers":
            from sentence_transformers import SentenceTransformer
            model = SentenceTransformer(model_name)
            is_bge = "bge-" in model_name.lower()
        else:
            model = None # Placeholder for other modes
            is_bge = False
            
        context = zmq.Context()
        socket = context.socket(zmq.REP)
        socket.setsockopt(zmq.RCVTIMEO, 60000)
        socket.connect(worker_url)
        
        logger.info(f"Dense Worker (CUDA) connected to {worker_url} loaded {model_name}")
        
        while True:
            try:
                msg = socket.recv_json()
            except zmq.error.Again:
                if os.getppid() == 1:
                    logger.warning("Dense Worker orphaned (PPID=1). Committing suicide.")
                    sys.exit(0)
                continue
            
            # Ping response for readiness probe
            if msg.get("type") == "ping":
                socket.send_json({"status": "pong", "worker": "dense"})
                continue
                
            try:
                msg_type = msg.get("type")
                if msg_type == "embed_documents":
                    texts = msg.get("texts", [])
                    if model is not None:
                        # normalize_embeddings=True is REQUIRED for Cosine Similarity (BGE Models)
                        embeddings = model.encode(texts, normalize_embeddings=True)
                        embeddings_list = embeddings.tolist()
                    else:
                        embeddings_list = []
                    socket.send_json({"status": "success", "type": "dense", "embeddings": embeddings_list})
                elif msg_type == "embed_query":
                    text = msg.get("text", "")
                    if model is not None:
                        if is_bge and not text.startswith("Represent this sentence"):
                            text = f"Represent this sentence for searching relevant passages: {text}"
                        # normalize_embeddings=True is REQUIRED for Cosine Similarity (BGE Models)
                        embedding = model.encode(text, normalize_embeddings=True)
                        embedding_list = embedding.tolist()
                    else:
                        embedding_list = []
                    socket.send_json({"status": "success", "type": "dense", "embedding": embedding_list})
                else:
                    socket.send_json({"status": "error", "message": f"Unknown dense type: {msg_type}"})
            except Exception as inner_e:
                socket.send_json({"status": "error", "message": str(inner_e)})
            
    except KeyboardInterrupt:
        logger.info("Dense Worker shutting down cleanly.")
    except Exception as e:
        logger.error(f"Dense Worker fatal error: {e}")


class RetrievalServerManager:
    """
    The Main Process Manager.
    Zero compute. Zero JVM. Zero CUDA. Pure ZMQ I/O routing to isolated children.
    """
    def __init__(self):
        self.context: Optional[zmq.Context] = None
        self.router_socket: Optional[zmq.Socket] = None
        self.sparse_dealer: Optional[zmq.Socket] = None
        self.dense_dealer: Optional[zmq.Socket] = None
        
        self.sparse_proc: Optional[mp.Process] = None
        self.dense_proc: Optional[mp.Process] = None
        self.router_proc: Optional[mp.Process] = None
        
        self._atexit_registered = False

    def start_server(
        self,
        port: Optional[int] = None,
        model_name: str = "sentence-transformers/all-MiniLM-L6-v2",
        embedding_mode: str = "sentence-transformers",
        **kwargs,
    ) -> tuple[bool, int]:
        """Start the unified sidecar topology."""
        import uuid
        run_id = uuid.uuid4().hex
        
        # Use IPC for workers to avoid TCP stack overhead and port collisions
        sparse_ipc = f"ipc:///tmp/aether_rag_sparse_{run_id}.ipc"
        dense_ipc = f"ipc:///tmp/aether_rag_dense_{run_id}.ipc"

        try:
            # We spawn the router as a process so it doesn't block the caller's thread
            # We will communicate the bound port back via a Queue
            port_queue = mp.Queue()
            self.router_proc = mp.Process(
                target=self._run_router,
                args=(port_queue, sparse_ipc, dense_ipc, port),
                daemon=True
            )
            self.router_proc.start()
            
            # Get the bound port from the router
            router_port = port_queue.get(timeout=10)

            bind_address = f"tcp://127.0.0.1:{router_port}"
            logger.info(f"Starting Unified Retrieval Sidecar on {bind_address}")

            # Spawn strictly isolated memory domains
            ctx = mp.get_context("spawn")
            self.sparse_proc = ctx.Process(
                target=run_sparse_worker, 
                args=(sparse_ipc,), 
                daemon=True
            )
            self.dense_proc = ctx.Process(
                target=run_dense_worker, 
                args=(dense_ipc, model_name, embedding_mode), 
                daemon=True
            )
            
            self.sparse_proc.start()
            self.dense_proc.start()

            if not self._atexit_registered:
                atexit.register(self.stop_server)
                self._atexit_registered = True

            # Readiness probe
            timeout = 60 if _is_colab_environment() else 30
            start_time = time.time()
            
            probe_context = zmq.Context()
            probe_socket = probe_context.socket(zmq.REQ)
            probe_socket.setsockopt(zmq.REQ_RELAXED, 1)
            probe_socket.setsockopt(zmq.REQ_CORRELATE, 1)
            probe_socket.connect(bind_address)
            probe_socket.setsockopt(zmq.RCVTIMEO, 2000)
            probe_socket.setsockopt(zmq.SNDTIMEO, 2000)
            
            ready = False
            while time.time() - start_time < timeout:
                try:
                    probe_socket.send_json({"task_type": "dense", "type": "ping"})
                    dense_reply = probe_socket.recv_json()
                    
                    probe_socket.send_json({"task_type": "sparse", "type": "ping"})
                    sparse_reply = probe_socket.recv_json()
                    
                    if dense_reply.get("status") == "pong" and sparse_reply.get("status") == "pong":
                        ready = True
                        break
                except zmq.error.Again:
                    pass
                time.sleep(0.5)
                
            probe_socket.close()
            probe_context.term()
            
            if not ready:
                logger.error("Unified sidecar workers failed to become ready in time.")
                self.stop_server()
                return False, router_port

            return True, router_port

        except Exception as e:
            logger.error(f"Failed to start unified sidecar: {e}")
            self.stop_server()
            return False, router_port

    def _run_router(self, port_queue: mp.Queue, sparse_ipc: str, dense_ipc: str, requested_port: Optional[int]):
        """The pure ZMQ Poller running in its own process."""
        context = zmq.Context()
        
        frontend = context.socket(zmq.ROUTER)
        if requested_port:
            frontend.bind(f"tcp://127.0.0.1:{requested_port}")
            port = requested_port
        else:
            port = frontend.bind_to_random_port("tcp://127.0.0.1")
            
        port_queue.put(port)
        
        backend_sparse = context.socket(zmq.DEALER)
        backend_sparse.bind(sparse_ipc)
        
        backend_dense = context.socket(zmq.DEALER)
        backend_dense.bind(dense_ipc)
        
        poller = zmq.Poller()
        poller.register(frontend, zmq.POLLIN)
        poller.register(backend_sparse, zmq.POLLIN)
        poller.register(backend_dense, zmq.POLLIN)

        logger.info("Router Poller active.")

        try:
            while True:
                socks = dict(poller.poll())
                
                # Route INCOMING requests from client to the correct worker
                if socks.get(frontend) == zmq.POLLIN:
                    msg_parts = frontend.recv_multipart()
                    payload = msg_parts[-1]
                    
                    try:
                        msg = json.loads(payload.decode('utf-8'))
                        task_type = msg.get("task_type", "dense") # 'dense' or 'sparse'
                        
                        if task_type == "dense":
                            backend_dense.send_multipart(msg_parts)
                        else:
                            backend_sparse.send_multipart(msg_parts)
                    except Exception as e:
                        logger.error(f"Router parse error: {e}")
                
                # Route OUTGOING responses from Sparse back to client
                if socks.get(backend_sparse) == zmq.POLLIN:
                    msg_parts = backend_sparse.recv_multipart()
                    frontend.send_multipart(msg_parts)

                # Route OUTGOING responses from Dense back to client
                if socks.get(backend_dense) == zmq.POLLIN:
                    msg_parts = backend_dense.recv_multipart()
                    frontend.send_multipart(msg_parts)

        except KeyboardInterrupt:
            logger.info("Router process shutting down.")
        finally:
            frontend.close()
            backend_sparse.close()
            backend_dense.close()
            context.term()

    def stop_server(self):
        """Gracefully terminate all isolated processes."""
        logger.info("Terminating Unified Retrieval Sidecar...")
        
        timeout = 3 if os.environ.get("CI") == "true" or _is_colab_environment() else 10
        
        for proc in (self.sparse_proc, self.dense_proc, self.router_proc):
            if proc and proc.is_alive():
                proc.terminate()
                proc.join(timeout=timeout)
                if proc.is_alive():
                    proc.kill()
        
        self.sparse_proc = None
        self.dense_proc = None
        self.router_proc = None
