"""Browser daemon SQLite database handler."""
import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any

logger = logging.getLogger(__name__)


class BrowserDB:
    """SQLite handler for browser history logs."""
    
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
        """Check if browser_logs table exists, and create if not."""
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='browser_logs'")
        if not cursor.fetchone():
            logger.info(f"Re-initializing missing table: browser_logs in {self.db_path}")
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
            CREATE TABLE IF NOT EXISTS browser_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT,
                visit_count INTEGER DEFAULT 1,
                profile TEXT,
                day_date TEXT NOT NULL,
                indexed BOOLEAN DEFAULT 0
            )
        """)
        
        # Auto-migration: Check and add missing columns
        cursor = conn.execute("PRAGMA table_info(browser_logs)")
        columns = [row[1] for row in cursor.fetchall()]
        
        if 'query_gen_processed' not in columns:
            conn.execute("ALTER TABLE browser_logs ADD COLUMN query_gen_processed BOOLEAN DEFAULT 0")
        
        if 'processed_by_query_id' not in columns:
            conn.execute("ALTER TABLE browser_logs ADD COLUMN processed_by_query_id TEXT")
        
        if 'typed_count' not in columns:
            conn.execute("ALTER TABLE browser_logs ADD COLUMN typed_count INTEGER DEFAULT 0")
        
        if 'search_query' not in columns:
            conn.execute("ALTER TABLE browser_logs ADD COLUMN search_query TEXT")
        
        # Create indexes
        conn.execute("CREATE INDEX IF NOT EXISTS idx_browser_logs_timestamp ON browser_logs(timestamp);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_browser_logs_day_date ON browser_logs(day_date);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_browser_logs_indexed ON browser_logs(indexed);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_browser_logs_query_gen ON browser_logs(query_gen_processed);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_browser_logs_query_id ON browser_logs(processed_by_query_id);")
        
        logger.info(f"✅ Browser SQLite initialized at {self.db_path}")
    
    def insert_log(self, url: str, title: str = None, visit_count: int = 1, typed_count: int = 0, profile: str = None, timestamp: str = None, search_query: str = None):
        """
        Insert a browser visit log with deduplication.
        
        CRITICAL: Prevents duplicate inserts by checking (url, timestamp).
        Only inserts if browser visit doesn't already exist in database.
        
        Args:
            search_query: Extracted search query from URL params (e.g., "attention mechanisms"
                from google.com/search?q=attention+mechanisms). Highest-signal text for BM25.
        """
        now = datetime.fromisoformat(timestamp) if timestamp else datetime.now(timezone.utc)
        day_date = now.strftime('%Y-%m-%d')
        ts_iso = now.isoformat()
        
        with self._get_connection() as conn:
            # DEDUPLICATION: Check if this visit already logged (url + timestamp = unique event)
            cursor = conn.execute(
                "SELECT id FROM browser_logs WHERE url = ? AND timestamp = ? LIMIT 1",
                (url, ts_iso)
            )
            existing = cursor.fetchone()
            
            if existing:
                # Already logged - skip insert
                logger.debug(f"⏭️  Browser visit already logged: {url[:50]}...")
                return existing[0]
            
            # New visit - insert it
            conn.execute(
                "INSERT INTO browser_logs (timestamp, url, title, visit_count, typed_count, profile, day_date, search_query) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (ts_iso, url, title, visit_count, typed_count, profile, day_date, search_query)
            )
            return conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    
    def get_unindexed_logs(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """
        Fetch PROCESSED logs that haven't been synced to BM25 index yet.
        Only processes logs that have been marked as processed by query generation.
        """
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM browser_logs WHERE indexed = 0 AND query_gen_processed = 1 ORDER BY timestamp ASC LIMIT ?",
                (limit,)
            )
            return [dict(row) for row in cursor.fetchall()]
    
    def mark_as_indexed(self, log_ids: List[int]):
        """Mark logs as indexed after adding to BM25."""
        if not log_ids:
            return
        with self._get_connection() as conn:
            placeholders = ",".join("?" for _ in log_ids)
            conn.execute(
                f"UPDATE browser_logs SET indexed = 1 WHERE id IN ({placeholders})",
                log_ids
            )
    
    def delete_indexed_logs(self, log_ids: List[int]) -> int:
        """
        Delete logs that have been synced to BM25 index.
        Called immediately after successful BM25 indexing.
        Returns count of deleted logs.
        """
        if not log_ids:
            return 0
        with self._get_connection() as conn:
            placeholders = ",".join("?" for _ in log_ids)
            deleted = conn.execute(
                f"DELETE FROM browser_logs WHERE id IN ({placeholders})",
                log_ids
            ).rowcount
            return deleted
    
    def cleanup_old_logs(self, days: int):
        """Delete logs older than N days."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._get_connection() as conn:
            deleted = conn.execute(
                "DELETE FROM browser_logs WHERE timestamp < ?",
                (cutoff,)
            ).rowcount
            logger.info(f"Cleaned up {deleted} old browser logs")
    
    def get_unprocessed_count(self) -> int:
        """Get count of logs not yet processed by query generation."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT COUNT(*) FROM browser_logs WHERE query_gen_processed = 0")
            return cursor.fetchone()[0]
    
    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT COUNT(*) as total, COUNT(CASE WHEN indexed = 0 THEN 1 END) as unindexed FROM browser_logs")
            row = cursor.fetchone()
            return {"total_logs": row[0], "unindexed_logs": row[1]}
