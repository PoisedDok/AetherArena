"""Email daemon SQLite database handler."""
import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any

logger = logging.getLogger(__name__)


class EmailDB:
    """SQLite handler for email logs."""
    
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
        """Check if email_logs table exists, and create if not."""
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='email_logs'")
        if not cursor.fetchone():
            logger.info(f"Re-initializing missing table: email_logs in {self.db_path}")
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
            CREATE TABLE IF NOT EXISTS email_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipients TEXT,
                body_preview TEXT,
                file_path TEXT,
                day_date TEXT NOT NULL,
                indexed BOOLEAN DEFAULT 0
            )
        """)
        
        # Auto-migration: Check and add missing columns
        cursor = conn.execute("PRAGMA table_info(email_logs)")
        columns = [row[1] for row in cursor.fetchall()]
        
        if 'query_gen_processed' not in columns:
            conn.execute("ALTER TABLE email_logs ADD COLUMN query_gen_processed BOOLEAN DEFAULT 0")
        
        if 'processed_by_query_id' not in columns:
            conn.execute("ALTER TABLE email_logs ADD COLUMN processed_by_query_id TEXT")
        
        # Create indexes
        conn.execute("CREATE INDEX IF NOT EXISTS idx_email_logs_timestamp ON email_logs(timestamp);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_email_logs_day_date ON email_logs(day_date);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_email_logs_indexed ON email_logs(indexed);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_email_logs_query_gen ON email_logs(query_gen_processed);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_email_logs_query_id ON email_logs(processed_by_query_id);")
        
        logger.info(f"Email SQLite initialized at {self.db_path}")
    
    def insert_log(self, subject: str, sender: str, recipients: str, body_preview: str, file_path: str = None, timestamp: str = None):
        """
        Insert an email log with deduplication.
        
        CRITICAL: Prevents duplicate inserts by checking (subject, sender, timestamp).
        Only inserts if email doesn't already exist in database.
        """
        try:
            # Use provided timestamp or current time
            dt_obj = datetime.fromisoformat(timestamp) if timestamp else datetime.now(timezone.utc)
            # Normalize to UTC for string comparison consistency
            if dt_obj.tzinfo is None:
                dt_obj = dt_obj.replace(tzinfo=timezone.utc)
            else:
                dt_obj = dt_obj.astimezone(timezone.utc)
                
            ts_iso = dt_obj.isoformat()
            day_date = dt_obj.strftime('%Y-%m-%d')
            
            with self._get_connection() as conn:
                # DEDUPLICATION: Check if this email already exists
                # Use subject+sender+timestamp as composite key
                cursor = conn.execute(
                    "SELECT id FROM email_logs WHERE subject = ? AND sender = ? AND timestamp = ? LIMIT 1",
                    (subject, sender, ts_iso)
                )
                existing = cursor.fetchone()
                
                if existing:
                    # Email already logged - skip insert
                    logger.debug(f"⏭️  Email already logged: {subject[:50]}...")
                    return None  # Return None to indicate no NEW record inserted
                
                # New email - insert it
                cursor = conn.execute(
                    "INSERT INTO email_logs (timestamp, subject, sender, recipients, body_preview, file_path, day_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (ts_iso, subject, sender, recipients, body_preview, file_path, day_date)
                )
                return cursor.lastrowid
        except Exception as e:
            logger.error(f"Failed to insert email log: {e}")
            return None
    
    def get_unprocessed_count(self) -> int:
        """Get count of logs not yet processed by query generation."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT COUNT(*) FROM email_logs WHERE query_gen_processed = 0")
            return cursor.fetchone()[0]
    
    def get_unindexed_logs(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """
        Fetch PROCESSED logs that haven't been synced to BM25 index yet.
        Only processes logs that have been marked as processed by query generation.
        """
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM email_logs WHERE indexed = 0 AND query_gen_processed = 1 ORDER BY timestamp ASC LIMIT ?",
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
                f"UPDATE email_logs SET indexed = 1 WHERE id IN ({placeholders})",
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
                f"DELETE FROM email_logs WHERE id IN ({placeholders})",
                log_ids
            ).rowcount
            return deleted
    
    def cleanup_old_logs(self, days: int):
        """Delete logs older than N days."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._get_connection() as conn:
            deleted = conn.execute(
                "DELETE FROM email_logs WHERE timestamp < ?",
                (cutoff,)
            ).rowcount
            logger.info(f"Cleaned up {deleted} old email logs")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT COUNT(*) as total, COUNT(CASE WHEN indexed = 0 THEN 1 END) as unindexed FROM email_logs")
            row = cursor.fetchone()
            return {"total_logs": row[0], "unindexed_logs": row[1]}
