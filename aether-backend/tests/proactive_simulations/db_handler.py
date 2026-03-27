import sqlite3
import time
from pathlib import Path
from datetime import datetime, timezone

class SimulationDBHandler:
    """Manages connections to daemon SQLite databases."""
    
    def __init__(self, workspace_root: Path):
        from config.settings import get_settings
        self.app_root = get_settings().app_root
        self.email_db = self.app_root / "data" / "daemons" / "email" / "logs.db"
        self.browser_db = self.app_root / "data" / "daemons" / "browser" / "logs.db"
        self.fs_db = self.app_root / "data" / "daemons" / "filesystem" / "logs.db"
        self.query_db = self.app_root / "data" / "daemons" / "query_generation" / "queries.db"
        
        # Ensure directories exist
        for db_path in [self.email_db, self.browser_db, self.fs_db, self.query_db]:
            db_path.parent.mkdir(parents=True, exist_ok=True)

    def inject_email(self, subject: str, sender: str, body: str, timestamp: float = None):
        if timestamp is None:
            timestamp = time.time()
        ts_str = datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
        day_date = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")
        
        with sqlite3.connect(self.email_db) as conn:
            conn.execute(
                """INSERT INTO email_logs (timestamp, subject, sender, body_preview, day_date, query_gen_processed) 
                   VALUES (?, ?, ?, ?, ?, 0)""",
                (ts_str, subject, sender, body, day_date)
            )
            print(f"  [Email] Injected: {subject}")

    def inject_browser(self, url: str, title: str, visit_count: int = 1, timestamp: float = None):
        if timestamp is None:
            timestamp = time.time()
        ts_str = datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
        day_date = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")
        
        with sqlite3.connect(self.browser_db) as conn:
            conn.execute(
                """INSERT INTO browser_logs (timestamp, url, title, visit_count, day_date, query_gen_processed) 
                   VALUES (?, ?, ?, ?, ?, 0)""",
                (ts_str, url, title, visit_count, day_date)
            )
            print(f"  [Browser] Injected: {title} ({url})")

    def inject_fs(self, action: str, file_path: str, content_preview: str = "", timestamp: float = None):
        if timestamp is None:
            timestamp = time.time()
        ts_str = datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
        day_date = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")
        path_obj = Path(file_path)
        
        with sqlite3.connect(self.fs_db) as conn:
            conn.execute(
                """INSERT INTO fs_logs (timestamp, action, file_path, file_name, file_extension, content_preview, day_date, query_gen_processed) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, 0)""",
                (ts_str, action, str(path_obj), path_obj.name, path_obj.suffix, content_preview, day_date)
            )
            print(f"  [FS] Injected: {action} on {path_obj.name}")

    def clear_all(self):
        """Clear all daemon logs to start fresh."""
        for db_path in [self.email_db, self.browser_db, self.fs_db, self.query_db]:
            if db_path.exists():
                with sqlite3.connect(db_path) as conn:
                    # Get table names
                    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
                    tables = [row[0] for row in cursor.fetchall()]
                    for table in tables:
                        conn.execute(f"DELETE FROM {table}")
                print(f"  [DB] Cleared {db_path.name}")
