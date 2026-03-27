"""Query generation daemon SQLite database handler."""
import sqlite3
import logging
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)
UNKNOWN_CONTEXT_TIMESTAMP = "1970-01-01T00:00:00+00:00"


class QueryGenerationDB:
    """SQLite handler for generated queries and their source documents."""
    
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._init_db()
    
    def _get_connection(self):
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode=WAL")  # Allow concurrent reads + single writer
        conn.execute("PRAGMA busy_timeout=5000")  # Wait up to 5s on lock instead of failing immediately
        # Verify table exists on every connection to handle external deletions
        self._ensure_table_exists(conn)
        return conn
    
    def _ensure_table_exists(self, conn):
        """Check if generated_queries table exists, and create if not."""
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='generated_queries'")
        if not cursor.fetchone():
            logger.info(f"Re-initializing missing table: generated_queries in {self.db_path}")
            self._init_db_with_connection(conn)

    def _init_db(self):
        """Initialize SQLite schema (Initial call)."""
        with sqlite3.connect(self.db_path, timeout=10.0) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            self._init_db_with_connection(conn)

    def _init_db_with_connection(self, conn):
        """Internal method to initialize schema using an existing connection."""
        # Create base table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS generated_queries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                query TEXT NOT NULL,
                source_daemon TEXT NOT NULL,
                context_docs TEXT NOT NULL,
                context_doc_ids TEXT NOT NULL,
                generation_method TEXT DEFAULT 'zero_shot',
                llm_model TEXT,
                validated BOOLEAN DEFAULT 0,
                used_by_agent BOOLEAN DEFAULT 0,
                indexed BOOLEAN DEFAULT 0,
                day_date TEXT NOT NULL,
                batch_id TEXT
            )
        """)
        
        # Auto-migration: Check and add missing columns
        cursor = conn.execute("PRAGMA table_info(generated_queries)")
        columns = [row[1] for row in cursor.fetchall()]
        
        if 'query_id' not in columns:
            logger.info("Migrating: Adding query_id column")
            conn.execute("ALTER TABLE generated_queries ADD COLUMN query_id TEXT")
            # Backfill query_id for existing rows
            conn.execute("""
                UPDATE generated_queries 
                SET query_id = 'qgen_' || substr(timestamp, 1, 10) || '_' || id 
                WHERE query_id IS NULL
            """)
        
        if 'batch_id' not in columns:
            logger.info("Migrating: Adding batch_id column")
            conn.execute("ALTER TABLE generated_queries ADD COLUMN batch_id TEXT")
            
        if 'indexed' not in columns:
            logger.info("Migrating: Adding indexed column")
            conn.execute("ALTER TABLE generated_queries ADD COLUMN indexed BOOLEAN DEFAULT 0")
        
        # Create indexes (after columns exist)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_queries_query_id ON generated_queries(query_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_queries_timestamp ON generated_queries(timestamp);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_queries_source_daemon ON generated_queries(source_daemon);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_queries_validated ON generated_queries(validated);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_queries_day_date ON generated_queries(day_date);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_queries_batch_id ON generated_queries(batch_id);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_queries_indexed ON generated_queries(indexed);")
        
        logger.info(f"✅ Query Generation SQLite initialized at {self.db_path}")

    def _infer_context_doc_source(self, doc: Dict[str, Any], metadata: Dict[str, Any]) -> str:
        """Infer source for legacy context docs that were stored without explicit source."""
        source = doc.get("source") or metadata.get("source")
        if source:
            return self._normalize_context_doc_source(str(source))

        merged = {**doc, **metadata}
        context_type = merged.get("_context_type")
        if context_type == "previous_query":
            return "query_gen"
        if "sender" in merged or "subject" in merged or "from" in merged:
            return "email"
        if "url" in merged or "visit_count" in merged or "typed_count" in merged:
            return "browser"
        if "file_path" in merged or "file_name" in merged or "action" in merged:
            return "filesystem"
        return "unknown"

    def _normalize_context_doc_source(self, source: str) -> str:
        """Normalize source aliases to canonical proactive source names."""
        normalized = source.strip().lower()
        aliases = {
            "query_generation": "query_gen",
            "query-gen": "query_gen",
            "active_windows": "browser",
        }
        return aliases.get(normalized, normalized or "unknown")

    def _normalize_context_doc(self, doc: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize context-doc shape for backward/forward compatibility."""
        if not isinstance(doc, dict):
            return {
                "source": "unknown",
                "timestamp": "",
                "content": "",
                "metadata": {},
            }

        raw_metadata = doc.get("metadata")
        metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}

        # Merge legacy flat fields into metadata.
        for key, value in doc.items():
            if key not in {"source", "timestamp", "content", "metadata"}:
                metadata.setdefault(key, value)

        source = self._infer_context_doc_source(doc, metadata)
        timestamp = (
            doc.get("timestamp")
            or metadata.get("timestamp")
            or UNKNOWN_CONTEXT_TIMESTAMP
        )
        content = doc.get("content")

        if content is None:
            if source == "email":
                content = metadata.get("body_preview", "")
            elif source == "filesystem":
                content = metadata.get("content_preview", "")
            elif source == "browser":
                content = metadata.get("search_query") or metadata.get("url", "")
            elif source == "query_gen":
                content = metadata.get("query", "")
            else:
                content = ""

        # Ensure context markers stay inside metadata.
        if doc.get("_context_type") and not metadata.get("_context_type"):
            metadata["_context_type"] = doc.get("_context_type")
        if doc.get("_batch") and not metadata.get("_batch"):
            metadata["_batch"] = doc.get("_batch")

        # Alias normalization for downstream consumers.
        if source == "email":
            sender = metadata.get("sender") or metadata.get("from")
            if sender:
                metadata.setdefault("sender", sender)
                metadata.setdefault("from", sender)
            if metadata.get("subject"):
                metadata.setdefault("title", metadata.get("subject"))
        elif source == "filesystem":
            file_path = metadata.get("file_path") or metadata.get("path")
            if file_path:
                metadata.setdefault("file_path", file_path)
                metadata.setdefault("path", file_path)
                metadata.setdefault("file_name", Path(file_path).name)
            if metadata.get("file_name"):
                metadata.setdefault("title", metadata.get("file_name"))
        elif source == "browser":
            if metadata.get("title"):
                metadata.setdefault("title", metadata.get("title"))
            elif metadata.get("url"):
                metadata.setdefault("title", metadata.get("url"))
        elif source == "query_gen":
            metadata.setdefault("_context_type", "previous_query")
            if metadata.get("query"):
                metadata.setdefault("title", metadata.get("query"))

        metadata.setdefault("source_daemon", source)
        if metadata.get("lineage_id"):
            metadata["lineage_id"] = str(metadata.get("lineage_id"))
        elif source == "query_gen" and metadata.get("query_id"):
            metadata["lineage_id"] = f"query_gen:{metadata.get('query_id')}"
        elif metadata.get("log_id") is not None:
            metadata["lineage_id"] = f"{source}:{metadata.get('log_id')}"

        return {
            "source": source,
            "timestamp": timestamp,
            "content": content or "",
            "metadata": metadata,
        }

    def insert_query(
        self,
        query: str,
        source_daemon: str,
        context_docs: List[Dict[str, Any]],
        context_doc_ids: List[Any],
        generation_method: str = "zero_shot",
        llm_model: str = None,
        batch_id: str = None
    ) -> str:
        """
        Insert a generated query with its source context.
        Returns the generated query_id for linking to source logs.
        """
        now = datetime.now(timezone.utc)
        day_date = now.strftime('%Y-%m-%d')
        normalized_context_docs = [
            self._normalize_context_doc(doc) for doc in context_docs
        ]
        
        # Generate unique query ID: qgen_{timestamp}_{hash}
        import hashlib
        query_hash = hashlib.sha256(f"{query}{now.isoformat()}".encode()).hexdigest()[:12]
        query_id = f"qgen_{now.strftime('%Y%m%d%H%M%S')}_{query_hash}"
        
        with self._get_connection() as conn:
            conn.execute(
                """INSERT INTO generated_queries 
                   (query_id, timestamp, query, source_daemon, context_docs, context_doc_ids, 
                    generation_method, llm_model, day_date, batch_id) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    query_id,
                    now.isoformat(),
                    query,
                    source_daemon,
                    json.dumps(normalized_context_docs),
                    json.dumps(context_doc_ids),
                    generation_method,
                    llm_model,
                    day_date,
                    batch_id
                )
            )
        
        return query_id

    def get_last_batch_queries(self, limit: int = 5) -> List[Dict[str, Any]]:
        """Fetch queries from the last 3 batches for richer ICL context."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            # Get the 3 most recent batch_ids
            cursor = conn.execute(
                "SELECT DISTINCT batch_id FROM generated_queries WHERE batch_id IS NOT NULL ORDER BY timestamp DESC LIMIT 3"
            )
            batch_ids = [row[0] for row in cursor.fetchall()]
            
            if not batch_ids:
                return []
            
            # Fetch queries from these 3 batches
            placeholders = ','.join('?' * len(batch_ids))
            cursor = conn.execute(
                f"SELECT * FROM generated_queries WHERE batch_id IN ({placeholders}) ORDER BY timestamp DESC LIMIT ?",
                (*batch_ids, limit)
            )
            results = []
            for row in cursor.fetchall():
                result = dict(row)
                parsed_docs = json.loads(result['context_docs'])
                result['context_docs'] = [
                    self._normalize_context_doc(doc) for doc in parsed_docs
                ]
                results.append(result)
            return results
    
    def get_recent_queries(
        self,
        hours_back: int = 24,
        source_daemon: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Get recent generated queries with optional daemon filter."""
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours_back)).isoformat()
        
        query = "SELECT * FROM generated_queries WHERE timestamp >= ?"
        params = [cutoff]
        
        if source_daemon:
            query += " AND source_daemon = ?"
            params.append(source_daemon)
        
        query += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)
        
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(query, params)
            results = []
            for row in cursor.fetchall():
                result = dict(row)
                # Parse JSON fields
                parsed_docs = json.loads(result['context_docs'])
                result['context_docs'] = [
                    self._normalize_context_doc(doc) for doc in parsed_docs
                ]
                result['context_doc_ids'] = json.loads(result['context_doc_ids'])
                results.append(result)
            return results

    def get_unindexed_queries(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """Get queries that haven't been indexed into BM25 yet."""
        query = "SELECT * FROM generated_queries WHERE indexed = 0 ORDER BY timestamp ASC LIMIT ?"
        
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(query, (limit,))
            results = []
            for row in cursor.fetchall():
                result = dict(row)
                # Parse JSON fields
                parsed_docs = json.loads(result['context_docs'])
                result['context_docs'] = [
                    self._normalize_context_doc(doc) for doc in parsed_docs
                ]
                result['context_doc_ids'] = json.loads(result['context_doc_ids'])
                results.append(result)
            return results
    
    def mark_as_indexed(self, query_ids: List[int]):
        """Mark queries as indexed."""
        if not query_ids:
            return
        with self._get_connection() as conn:
            placeholders = ",".join("?" for _ in query_ids)
            conn.execute(
                f"UPDATE generated_queries SET indexed = 1 WHERE id IN ({placeholders})",
                query_ids
            )
    
    def mark_as_validated(self, query_ids: List[int]):
        """Mark queries as validated after user interaction."""
        if not query_ids:
            return
        with self._get_connection() as conn:
            placeholders = ",".join("?" for _ in query_ids)
            conn.execute(
                f"UPDATE generated_queries SET validated = 1 WHERE id IN ({placeholders})",
                query_ids
            )
    
    def mark_as_used(self, query_ids: List[int]):
        """Mark queries as used by proactive agent."""
        if not query_ids:
            return
        with self._get_connection() as conn:
            placeholders = ",".join("?" for _ in query_ids)
            conn.execute(
                f"UPDATE generated_queries SET used_by_agent = 1 WHERE id IN ({placeholders})",
                query_ids
            )
    
    def cleanup_old_queries(self, days: int):
        """Delete queries older than N days."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._get_connection() as conn:
            deleted = conn.execute(
                "DELETE FROM generated_queries WHERE timestamp < ?",
                (cutoff,)
            ).rowcount
            logger.info(f"Cleaned up {deleted} old generated queries")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics."""
        with self._get_connection() as conn:
            cursor = conn.execute("""
                SELECT 
                    COUNT(*) as total,
                    COUNT(CASE WHEN validated = 1 THEN 1 END) as validated,
                    COUNT(CASE WHEN used_by_agent = 1 THEN 1 END) as used,
                    COUNT(DISTINCT source_daemon) as source_daemons
                FROM generated_queries
            """)
            row = cursor.fetchone()
            return {
                "total_queries": row[0],
                "validated_queries": row[1],
                "used_queries": row[2],
                "source_daemons": row[3]
            }
