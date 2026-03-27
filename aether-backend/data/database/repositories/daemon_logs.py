"""
Daemon Logs Repository

Persistence layer for reading raw SQLite daemon logs and stats.
No raw SQL in the API router; all SQLite connections encapsulated here.

@.architecture
Incoming: api/v1/endpoints/files.py --- {Settings, string parameters}
Processing: get_logs(), get_all_stats() --- {2 jobs: JOB_QUERY_DB, JOB_MANAGE_CONNECTION}
Outgoing: sqlite3, Local filesystem --- {Dict[str, Any], List[Dict]}
"""

from core.domain.repository_interfaces import IDaemonLogsRepository

import sqlite3
import logging
from contextlib import closing
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from pathlib import Path

from config.settings import Settings

logger = logging.getLogger(__name__)


class DaemonLogsRepository(IDaemonLogsRepository):
    """
    Repository for reading proactive daemon logs from local SQLite databases.
    Manages connection lifecycle safely.
    """
    
    _TABLE_MAP = {
        "browser": ("browser_logs", "indexed"),
        "email": ("email_logs", "indexed"),
        "filesystem": ("fs_logs", "indexed")
    }

    def __init__(self, settings: Settings):
        self.settings = settings
        self.daemons = ["browser", "email", "filesystem"]

    def _get_daemon_db_path(self, daemon_name: str) -> Path:
        """Get the SQLite database path for a daemon."""
        return self.settings.app_root / "data" / "daemons" / daemon_name / "logs.db"

    def _get_daemon_index_path(self, daemon_name: str) -> Path:
        """Get the BM25 index path for a daemon."""
        return self.settings.app_root / "data" / "indexes" / f"{daemon_name}_bm25"

    def get_logs(
        self,
        daemon_name: str,
        limit: int = 100,
        hours_back: Optional[int] = None,
        only_unindexed: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Query raw logs from a daemon's SQLite database.
        
        Args:
            daemon_name: One of 'browser', 'email', 'filesystem'
            limit: Maximum number of logs to return
            hours_back: Filter logs from last N hours
            only_unindexed: Return only unindexed logs
            
        Returns:
            List of log dictionaries
        """
        if daemon_name not in self._TABLE_MAP:
            raise ValueError(f"Invalid daemon name: {daemon_name}")

        db_path = self._get_daemon_db_path(daemon_name)
        if not db_path.exists():
            raise FileNotFoundError(f"Daemon database not found: {daemon_name}")

        table_name, index_col = self._TABLE_MAP[daemon_name]

        query = f"SELECT * FROM {table_name} WHERE 1=1"
        params = []

        if hours_back:
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours_back)).isoformat()
            query += " AND timestamp >= ?"
            params.append(cutoff)

        if only_unindexed:
            query += f" AND {index_col} = 0"

        query += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)

        try:
            with closing(sqlite3.connect(db_path)) as conn:
                conn.row_factory = sqlite3.Row
                with closing(conn.cursor()) as cursor:
                    cursor.execute(query, params)
                    logs = [dict(row) for row in cursor.fetchall()]
            
            logger.info("Retrieved %d logs from %s daemon", len(logs), daemon_name)
            return logs
        except Exception as e:
            logger.error("Failed to query %s logs: %s", daemon_name, e, exc_info=True)
            raise

    def get_all_stats(self) -> Dict[str, Dict[str, Any]]:
        """
        Get statistics from all daemon databases.
        
        Returns:
            Dictionary mapping daemon name to its statistics
        """
        stats = {}

        for daemon_name in self.daemons:
            try:
                db_path = self._get_daemon_db_path(daemon_name)

                if not db_path.exists():
                    stats[daemon_name] = {
                        "status": "not_initialized",
                        "total_logs": 0,
                        "unindexed_logs": 0
                    }
                    continue

                table_name, index_col = self._TABLE_MAP[daemon_name]

                with closing(sqlite3.connect(db_path)) as conn:
                    with closing(conn.cursor()) as cursor:
                        # Resilient check: if table doesn't exist, return initializing state
                        cursor.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{table_name}'")
                        if not cursor.fetchone():
                            stats[daemon_name] = {
                                "status": "initializing",
                                "total_logs": 0,
                                "unindexed_logs": 0
                            }
                            continue

                        cursor.execute(
                            f"SELECT COUNT(*) as total, COUNT(CASE WHEN {index_col} = 0 THEN 1 END) as unindexed FROM {table_name}"
                        )
                        row = cursor.fetchone()

                index_path = self._get_daemon_index_path(daemon_name)
                index_exists = (index_path / "data.properties").exists()

                total_logs = row[0] if row else 0
                unindexed_logs = row[1] if row else 0

                stats[daemon_name] = {
                    "status": "active",
                    "total_logs": total_logs,
                    "unindexed_logs": unindexed_logs,
                    "indexed_logs": total_logs - unindexed_logs,
                    "index_exists": index_exists,
                    "db_path": str(db_path),
                    "index_path": str(index_path) if index_exists else None
                }

            except Exception as e:
                logger.warning("Failed to get stats for %s: %s", daemon_name, e)
                stats[daemon_name] = {
                    "status": "error",
                    "error": "Internal error. Check server logs."
                }

        return stats
