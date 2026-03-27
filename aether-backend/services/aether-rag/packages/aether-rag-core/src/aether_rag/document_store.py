"""
@.architecture SQLite Document Store

This module implements the IDocumentStore interface using SQLite in WAL mode.
It acts as the single source of truth for:
1. Document text and metadata (for hydration)
2. Two-tier indirection mapping: string UUID -> (Segment_ID, Local_Offset)
3. Write-Ahead Log (WAL) for the Vector L0 buffer (storing raw vector BLOBs)
4. Fast boolean pre-filtering for FAISS IDSelectorBitmap injection.
"""

import sqlite3
import json
import logging
import numpy as np
import threading
from typing import List, Dict, Any, Optional, Tuple, Iterable
from pathlib import Path

from .interfaces import IDocumentStore, Document

logger = logging.getLogger(__name__)

# Global lock to serialize all writes to SQLite to prevent "database is locked" errors
_WRITE_LOCK = threading.Lock()

class SQLiteDocumentStore(IDocumentStore):
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        if not hasattr(self._local, 'conn'):
            # Add timeout=30.0 to handle brief file locks
            conn = sqlite3.connect(self.db_path, isolation_level=None, check_same_thread=False, timeout=30.0)
            conn.row_factory = sqlite3.Row
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
            except sqlite3.OperationalError as e:
                logger.warning(f"Could not configure SQLite pragmas on {self.db_path}: {e}. Proceeding with defaults.")
            
            try:
                conn.execute("PRAGMA foreign_keys=ON")
            except sqlite3.OperationalError:
                pass
            
            self._local.conn = conn
        return self._local.conn

    def _init_db(self):
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    doc_id TEXT UNIQUE NOT NULL,
                    text TEXT NOT NULL,
                    metadata JSON,
                    vector_blob BLOB
                );
            """)

    def close(self):
        """Explicitly close the database connection held by the current thread."""
        if hasattr(self._local, 'conn'):
            try:
                self._local.conn.close()
            except Exception as e:
                logger.warning(f"Error closing SQLite connection: {e}")
            finally:
                del self._local.conn

    def add(self, documents: List[Document], vector_blobs: Optional[List[bytes]] = None) -> List[int]:
        """
        Insert documents into the SQLite store.
        If vector_blobs are provided, they are stored to act as a WAL for the vector store.
        """
        if vector_blobs and len(documents) != len(vector_blobs):
            raise ValueError("Length of documents and vector_blobs must match")

        with _WRITE_LOCK:
            with self._get_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    records = []
                    for i, doc in enumerate(documents):
                        blob = vector_blobs[i] if vector_blobs else None
                        meta_json = json.dumps(doc.metadata) if doc.metadata else "{}"
                        records.append(
                            (doc.id, doc.text, meta_json, blob)
                        )

                    conn.executemany("""
                        INSERT INTO documents (doc_id, text, metadata, vector_blob)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(doc_id) DO UPDATE SET
                            text=excluded.text,
                            metadata=excluded.metadata,
                            vector_blob=COALESCE(excluded.vector_blob, documents.vector_blob)
                    """, records)
                    conn.execute("COMMIT")
                    
                    doc_ids = [d.id for d in documents]
                    # Chunk to avoid SQLite limits if adding huge batches
                    chunk_size = 900
                    id_map = {}
                    for i in range(0, len(doc_ids), chunk_size):
                        chunk = doc_ids[i:i + chunk_size]
                        placeholders = ",".join(["?"] * len(chunk))
                        cursor = conn.execute(f"SELECT doc_id, internal_id FROM documents WHERE doc_id IN ({placeholders})", chunk)
                        for row in cursor:
                            id_map[row['doc_id']] = row['internal_id']
                            
                    return [id_map[d.id] for d in documents]
                    
                except Exception as e:
                    conn.execute("ROLLBACK")
                    raise RuntimeError(f"Failed to add documents to SQLite: {e}") from e

    def get(self, doc_ids: List[str]) -> List[Document]:
        """Fetch full documents for hydration, preserving order and failing fast on drift."""
        if not doc_ids:
            return []
            
        doc_map = {}
        with self._get_connection() as conn:
            chunk_size = 900
            for i in range(0, len(doc_ids), chunk_size):
                chunk = doc_ids[i:i + chunk_size]
                placeholders = ",".join("?" * len(chunk))
                cursor = conn.execute(f"SELECT doc_id, text, metadata FROM documents WHERE doc_id IN ({placeholders})", chunk)
                for row in cursor:
                    meta = json.loads(row['metadata']) if row['metadata'] else {}
                    doc_map[row['doc_id']] = Document(id=row['doc_id'], text=row['text'], metadata=meta)
                    
        # Reconstruct exact order and enforce parity
        results = [doc_map[doc_id] for doc_id in doc_ids if doc_id in doc_map]
        
        if len(results) != len(doc_ids):
            missing = set(doc_ids) - set(doc_map.keys())
            raise RuntimeError(
                f"Index drift detected. Hydration failed for {len(missing)} doc_ids missing in SQLite. "
                f"Sample missing: {list(missing)[:5]}"
            )
            
        return results

    def get_missing_vectors(self, batch_size: int = 256) -> List[Tuple[int, Document]]:
        """Fetch documents that do not have their vector_blob populated yet."""
        with self._get_connection() as conn:
            cursor = conn.execute(
                "SELECT internal_id, doc_id, text, metadata FROM documents WHERE vector_blob IS NULL LIMIT ?",
                (batch_size,)
            )
            results = []
            for row in cursor:
                meta = json.loads(row['metadata']) if row['metadata'] else {}
                doc = Document(id=row['doc_id'], text=row['text'], metadata=meta)
                results.append((row['internal_id'], doc))
            return results

    def iter_all(self) -> Iterable[Document]:
        """Yields all active documents in the store. Essential for full index rebuilds."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT doc_id, text, metadata FROM documents")
            for row in cursor:
                meta = json.loads(row['metadata']) if row['metadata'] else {}
                yield Document(id=row['doc_id'], text=row['text'], metadata=meta)

    def update_vectors(self, internal_ids: List[int], vector_blobs: List[bytes]) -> None:
        """Update the WAL with generated vector blobs for the given internal IDs."""
        if len(internal_ids) != len(vector_blobs):
            raise ValueError("Mismatched lengths of internal_ids and vector_blobs")
            
        with _WRITE_LOCK:
            with self._get_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    records = [(blob, iid) for blob, iid in zip(vector_blobs, internal_ids)]
                    conn.executemany("UPDATE documents SET vector_blob = ? WHERE internal_id = ?", records)
                    conn.execute("COMMIT")
                except Exception as e:
                    conn.execute("ROLLBACK")
                    raise RuntimeError(f"Failed to update vectors: {e}") from e

    def get_allowed_internal_ids(self, filters: Dict[str, Any]) -> np.ndarray:
        """
        Evaluate metadata filters and return sequential internal IDs as a numpy array.
        This is for zero-copy FAISS IDSelectorBitmap injection.
        """
        if not filters:
            # If no filters, return empty array to denote "allow all" 
            # Or we could return all IDs, but FAISS handles 'None' selector as allow all
            return np.array([], dtype=np.int64)

        query, params = self._build_filter_query(filters)
        with self._get_connection() as conn:
            cursor = conn.execute(f"SELECT internal_id FROM documents WHERE {query}", params)
            # Fetch all and immediately convert to numpy array
            ids = [row[0] for row in cursor.fetchall()]
            return np.array(ids, dtype=np.int64)

    def get_allowed_docnos(self, filters: Dict[str, Any], chunk_size: int = 10000) -> List[str]:
        """
        Evaluate metadata filters and return string doc_ids (docnos).
        This is for PyTerrier candidate injection.
        """
        if not filters:
            return []
            
        query, params = self._build_filter_query(filters)
        results = []
        with self._get_connection() as conn:
            cursor = conn.execute(f"SELECT doc_id FROM documents WHERE {query}", params)
            while True:
                rows = cursor.fetchmany(chunk_size)
                if not rows:
                    break
                results.extend([row[0] for row in rows])
            return results

    def get_l0_recovery_state(self) -> Tuple[List[str], np.ndarray, np.ndarray]:
        """
        Recovers the vectors on boot.
        Returns: (List of string doc_ids, array of internal_ids, array of vector embeddings)
        """
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT doc_id, internal_id, vector_blob FROM documents WHERE vector_blob IS NOT NULL")
            doc_ids = []
            internal_ids = []
            vectors = []
            for row in cursor:
                doc_ids.append(row['doc_id'])
                internal_ids.append(row['internal_id'])
                # Assuming vectors are serialized as bytes from numpy float32 arrays
                vec = np.frombuffer(row['vector_blob'], dtype=np.float32)
                vectors.append(vec)
                
            if not vectors:
                return [], np.array([], dtype=np.int64), np.array([], dtype=np.float32)
                
            return doc_ids, np.array(internal_ids, dtype=np.int64), np.stack(vectors)

    def _build_filter_query(self, filters: Dict[str, Any]) -> Tuple[str, List[Any]]:
        """
        Translates a simple dictionary of filters into a SQLite JSON_EXTRACT query safely.
        """
        clauses = []
        params = []
        for key, value in filters.items():
            path = f"$.{key}"
            if isinstance(value, list):
                if not value:
                    clauses.append("1=0")
                    continue
                placeholders = ",".join("?" * len(value))
                clauses.append(f"json_extract(metadata, ?) IN ({placeholders})")
                params.extend([path] + value)
            else:
                clauses.append("json_extract(metadata, ?) = ?")
                params.extend([path, value])
                
        return " AND ".join(clauses), params
