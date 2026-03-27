"""Filesystem daemon SQLite database handler."""
import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any

logger = logging.getLogger(__name__)


class FileSystemDB:
    """SQLite handler for filesystem event logs."""
    
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
        """Check if fs_logs table exists, and create if not."""
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='fs_logs'")
        if not cursor.fetchone():
            logger.info(f"Re-initializing missing table: fs_logs in {self.db_path}")
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
            CREATE TABLE IF NOT EXISTS fs_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                action TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_name TEXT,
                file_extension TEXT,
                content_preview TEXT,
                location_name TEXT,
                day_date TEXT NOT NULL,
                indexed BOOLEAN DEFAULT 0
            )
        """)
        
        # Auto-migration: Check and add missing columns
        cursor = conn.execute("PRAGMA table_info(fs_logs)")
        columns = [row[1] for row in cursor.fetchall()]
        
        if 'file_extension' not in columns:
            conn.execute("ALTER TABLE fs_logs ADD COLUMN file_extension TEXT")
        
        if 'content_preview' not in columns:
            conn.execute("ALTER TABLE fs_logs ADD COLUMN content_preview TEXT")
        
        if 'query_gen_processed' not in columns:
            conn.execute("ALTER TABLE fs_logs ADD COLUMN query_gen_processed BOOLEAN DEFAULT 0")
        
        if 'processed_by_query_id' not in columns:
            conn.execute("ALTER TABLE fs_logs ADD COLUMN processed_by_query_id TEXT")
        
        # Create indexes
        conn.execute("CREATE INDEX IF NOT EXISTS idx_fs_logs_timestamp ON fs_logs(timestamp);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_fs_logs_day_date ON fs_logs(day_date);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_fs_logs_action ON fs_logs(action);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_fs_logs_indexed ON fs_logs(indexed);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_fs_logs_query_gen ON fs_logs(query_gen_processed);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_fs_logs_query_id ON fs_logs(processed_by_query_id);")
        
        logger.info(f"✅ FileSystem SQLite initialized at {self.db_path}")
    
    def insert_log(self, action: str, file_path: str, location_name: str = None, content_preview: str = None, timestamp: str = None):
        """
        Insert a filesystem event log with deduplication.
        
        CRITICAL: Prevents duplicate inserts by checking (file_path, action, timestamp).
        Only inserts if filesystem event doesn't already exist in database.
        """
        now = datetime.fromisoformat(timestamp) if timestamp else datetime.now(timezone.utc)
        day_date = now.strftime('%Y-%m-%d')
        ts_iso = now.isoformat()
        
        path_obj = Path(file_path)
        file_name = path_obj.name
        file_extension = path_obj.suffix.lower()
        
        with self._get_connection() as conn:
            # DEDUPLICATION: Check if this event already logged (file_path + action + timestamp = unique event)
            cursor = conn.execute(
                "SELECT id FROM fs_logs WHERE file_path = ? AND action = ? AND timestamp = ? LIMIT 1",
                (file_path, action, ts_iso)
            )
            existing = cursor.fetchone()
            
            if existing:
                # Already logged - skip insert
                logger.debug(f"⏭️  Filesystem event already logged: {action} {file_path}")
                return existing[0]
            
            # New event - insert it
            conn.execute(
                """INSERT INTO fs_logs 
                   (timestamp, action, file_path, file_name, file_extension, content_preview, location_name, day_date) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (ts_iso, action, file_path, file_name, file_extension, content_preview, location_name, day_date)
            )
            return conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    
    def get_unprocessed_count(self) -> int:
        """Get count of logs not yet processed by query generation."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT COUNT(*) FROM fs_logs WHERE query_gen_processed = 0")
            return cursor.fetchone()[0]
    
    def get_unindexed_logs(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """
        Fetch PROCESSED logs that haven't been synced to BM25 index yet.
        Only processes logs that have been marked as processed by query generation.
        """
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM fs_logs WHERE indexed = 0 AND query_gen_processed = 1 ORDER BY timestamp ASC LIMIT ?",
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
                f"UPDATE fs_logs SET indexed = 1 WHERE id IN ({placeholders})",
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
                f"DELETE FROM fs_logs WHERE id IN ({placeholders})",
                log_ids
            ).rowcount
            return deleted
    
    def cleanup_old_logs(self, days: int):
        """Delete logs older than N days."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._get_connection() as conn:
            deleted = conn.execute(
                "DELETE FROM fs_logs WHERE timestamp < ?",
                (cutoff,)
            ).rowcount
            logger.info(f"Cleaned up {deleted} old filesystem logs")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT COUNT(*) as total, COUNT(CASE WHEN indexed = 0 THEN 1 END) as unindexed FROM fs_logs")
            row = cursor.fetchone()
            return {"total_logs": row[0], "unindexed_logs": row[1]}
