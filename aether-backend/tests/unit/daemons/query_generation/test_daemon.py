"""
Unit tests for services/daemons/query_generation/daemon.py

Tests QueryGenerationDaemon: the Phase 1 orchestrator that monitors source
daemon DBs, collects unprocessed logs, generates cross-source queries,
stores them with full context, and marks source logs as processed.

Uses REAL SQLite for source DBs (browser, email, filesystem) to test
actual SQL queries and flag handling.

Covers:
  _get_recent_logs      -- reads correct table, respects processed flag, limit
  _get_fresh_count      -- counts unprocessed, missing DB returns 0
  _mark_logs_processed  -- sets flag, links query_id, auto-migrates table
  _mark_existing_logs_stale -- marks all unprocessed on startup
  _process_new_logs     -- cross-source assembly, priority, threshold gating, context building
  _create_context_windows -- non-overlapping sliding windows
  stop                  -- observer stopped, generator closed, dispose guard
  _check_and_reload_config -- detects model change, recreates generator
"""

import sqlite3
import pytest
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from services.daemons.query_generation.daemon import QueryGenerationDaemon
from services.daemons.query_generation.config import QueryGenerationDaemonConfig


# ===========================================================================
# Helpers -- create real source daemon SQLite DBs with correct schemas
# ===========================================================================

def create_source_db(db_path: Path, table_name: str, schema_type: str):
    """Create a real source daemon DB with the correct schema."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)

    if schema_type == "browser":
        conn.execute("""
            CREATE TABLE IF NOT EXISTS browser_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                url TEXT,
                title TEXT,
                visit_count INTEGER DEFAULT 1,
                typed_count INTEGER DEFAULT 0,
                query_gen_processed BOOLEAN DEFAULT 0,
                processed_by_query_id TEXT
            )
        """)
    elif schema_type == "email":
        conn.execute("""
            CREATE TABLE IF NOT EXISTS email_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                sender TEXT,
                subject TEXT,
                body_preview TEXT,
                query_gen_processed BOOLEAN DEFAULT 0,
                processed_by_query_id TEXT
            )
        """)
    elif schema_type == "filesystem":
        conn.execute("""
            CREATE TABLE IF NOT EXISTS fs_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                action TEXT,
                file_name TEXT,
                file_path TEXT,
                content_preview TEXT,
                query_gen_processed BOOLEAN DEFAULT 0,
                processed_by_query_id TEXT
            )
        """)
    conn.commit()
    conn.close()


def insert_browser_log(db_path: Path, url: str, title: str, processed: bool = False):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO browser_logs (timestamp, url, title, visit_count, typed_count, query_gen_processed) VALUES (?, ?, ?, ?, ?, ?)",
        (datetime.now(timezone.utc).isoformat(), url, title, 3, 1, int(processed))
    )
    conn.commit()
    conn.close()


def insert_email_log(db_path: Path, sender: str, subject: str, body: str = "", processed: bool = False):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO email_logs (timestamp, sender, subject, body_preview, query_gen_processed) VALUES (?, ?, ?, ?, ?)",
        (datetime.now(timezone.utc).isoformat(), sender, subject, body, int(processed))
    )
    conn.commit()
    conn.close()


def insert_fs_log(db_path: Path, action: str, file_name: str, file_path: str, content: str = "", processed: bool = False):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO fs_logs (timestamp, action, file_name, file_path, content_preview, query_gen_processed) VALUES (?, ?, ?, ?, ?, ?)",
        (datetime.now(timezone.utc).isoformat(), action, file_name, file_path, content, int(processed))
    )
    conn.commit()
    conn.close()


# ===========================================================================
# Fixtures
# ===========================================================================

@pytest.fixture
def app_root(tmp_path):
    """Create app_root with source daemon DB directories."""
    # Create dirs for source daemons
    (tmp_path / "data" / "daemons" / "browser").mkdir(parents=True)
    (tmp_path / "data" / "daemons" / "email").mkdir(parents=True)
    (tmp_path / "data" / "daemons" / "filesystem").mkdir(parents=True)
    (tmp_path / "data" / "daemons" / "query_generation").mkdir(parents=True)
    (tmp_path / "data" / "indexes" / "query_gen_bm25").mkdir(parents=True)
    return tmp_path


@pytest.fixture
def config(app_root):
    return QueryGenerationDaemonConfig(
        app_root=app_root,
        db_path=app_root / "data" / "daemons" / "query_generation" / "queries.db",
        check_interval_seconds=60,
        llm_api_base="http://localhost:7090/v1",
        llm_model="lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
        priority_thresholds={"email": 1, "filesystem": 1, "browser": 2},
    )


@pytest.fixture
def daemon(config):
    """QueryGenerationDaemon with mocked generator (no real LLM calls)."""
    d = QueryGenerationDaemon(config)
    d.generator = AsyncMock()
    d.generator.close = AsyncMock()
    d.generator.generate_queries_cross_source = AsyncMock(return_value=[])
    # No more indexer mock needed
    # d.indexer = MagicMock()
    # d.indexer.index_queries = MagicMock(return_value=0)
    return d


@pytest.fixture
def browser_db(app_root):
    path = app_root / "data" / "daemons" / "browser" / "logs.db"
    create_source_db(path, "browser_logs", "browser")
    return path


@pytest.fixture
def email_db(app_root):
    path = app_root / "data" / "daemons" / "email" / "logs.db"
    create_source_db(path, "email_logs", "email")
    return path


@pytest.fixture
def fs_db(app_root):
    path = app_root / "data" / "daemons" / "filesystem" / "logs.db"
    create_source_db(path, "fs_logs", "filesystem")
    return path


# ===========================================================================
# Canonicalization helpers
# ===========================================================================

class TestCanonicalizationHelpers:

    def test_infer_source_prefers_explicit_source_daemon(self, daemon):
        source = daemon._infer_source_from_log({"_source_daemon": "email", "url": "https://x.com"})
        assert source == "email"

    def test_canonicalize_triggering_log_email_shape(self, daemon):
        log = {
            "id": 42,
            "timestamp": "2026-02-17T00:00:00+00:00",
            "_source_daemon": "email",
            "sender": "boss@co.com",
            "subject": "Deadline",
            "body_preview": "Please send update.",
        }

        doc = daemon._canonicalize_triggering_log(log)
        assert doc["source"] == "email"
        assert doc["timestamp"] == "2026-02-17T00:00:00+00:00"
        assert doc["content"] == "Please send update."
        assert doc["metadata"]["sender"] == "boss@co.com"
        assert doc["metadata"]["from"] == "boss@co.com"
        assert doc["metadata"]["title"] == "Deadline"
        assert doc["metadata"]["log_id"] == 42
        assert doc["metadata"]["_context_type"] == "triggering_log"
        assert doc["metadata"]["_batch"] == "current"

    def test_canonicalize_previous_query_doc_shape(self, daemon):
        prev = {
            "query": "look into CI failures",
            "query_id": "qgen_abc",
            "batch_id": "b1",
            "timestamp": "2026-02-16T00:00:00+00:00",
        }

        doc = daemon._canonicalize_previous_query_doc(prev, "N-1")
        assert doc["source"] == "query_gen"
        assert doc["content"] == "look into CI failures"
        assert doc["metadata"]["_context_type"] == "previous_query"
        assert doc["metadata"]["_batch"] == "N-1"
        assert doc["metadata"]["query_id"] == "qgen_abc"
        assert doc["metadata"]["batch_id"] == "b1"


# ===========================================================================
# _get_recent_logs
# ===========================================================================

class TestGetRecentLogs:

    def test_returns_unprocessed_logs(self, daemon, browser_db):
        insert_browser_log(browser_db, "https://k8s.io", "K8s Docs", processed=False)
        insert_browser_log(browser_db, "https://old.com", "Old", processed=True)

        logs = daemon._get_recent_logs("browser", limit=10)
        assert len(logs) == 1
        assert logs[0]["url"] == "https://k8s.io"

    def test_respects_limit(self, daemon, email_db):
        for i in range(5):
            insert_email_log(email_db, f"user{i}@co.com", f"Subject {i}")

        logs = daemon._get_recent_logs("email", limit=3)
        assert len(logs) == 3

    def test_ordered_by_timestamp_desc(self, daemon, fs_db):
        insert_fs_log(fs_db, "created", "first.py", "/first.py")
        import time
        time.sleep(0.01)
        insert_fs_log(fs_db, "modified", "second.py", "/second.py")

        logs = daemon._get_recent_logs("filesystem", limit=10)
        assert logs[0]["file_name"] == "second.py"  # Most recent first

    def test_missing_db_returns_empty(self, daemon):
        logs = daemon._get_recent_logs("browser", limit=10)
        assert logs == []

    def test_correct_table_per_daemon(self, daemon, email_db):
        insert_email_log(email_db, "test@co.com", "Test")
        logs = daemon._get_recent_logs("email", limit=10)
        assert len(logs) == 1
        assert "sender" in logs[0]

    def test_returns_all_columns(self, daemon, browser_db):
        insert_browser_log(browser_db, "https://example.com", "Example")
        logs = daemon._get_recent_logs("browser", limit=1)
        assert "url" in logs[0]
        assert "title" in logs[0]
        assert "visit_count" in logs[0]
        assert "typed_count" in logs[0]


# ===========================================================================
# _get_fresh_count
# ===========================================================================

class TestGetFreshCount:

    def test_counts_unprocessed(self, daemon, email_db):
        insert_email_log(email_db, "a@b.com", "Sub 1")
        insert_email_log(email_db, "c@d.com", "Sub 2")
        insert_email_log(email_db, "e@f.com", "Sub 3", processed=True)

        count = daemon._get_fresh_count("email")
        assert count == 2

    def test_missing_db_returns_zero(self, daemon):
        count = daemon._get_fresh_count("browser")
        assert count == 0

    def test_all_processed_returns_zero(self, daemon, fs_db):
        insert_fs_log(fs_db, "created", "x.py", "/x.py", processed=True)
        count = daemon._get_fresh_count("filesystem")
        assert count == 0


# ===========================================================================
# _mark_logs_processed
# ===========================================================================

class TestMarkLogsProcessed:

    def test_sets_processed_flag(self, daemon, email_db):
        insert_email_log(email_db, "a@b.com", "Test")
        conn = sqlite3.connect(email_db)
        row_id = conn.execute("SELECT id FROM email_logs").fetchone()[0]
        conn.close()

        daemon._mark_logs_processed("email", [row_id], query_id="qgen_test_123")

        conn = sqlite3.connect(email_db)
        row = conn.execute("SELECT query_gen_processed, processed_by_query_id FROM email_logs WHERE id = ?", (row_id,)).fetchone()
        conn.close()
        assert row[0] == 1
        assert row[1] == "qgen_test_123"

    def test_empty_log_ids_is_noop(self, daemon, email_db):
        """Empty list does not raise."""
        daemon._mark_logs_processed("email", [], query_id="qgen_123")

    def test_missing_db_is_noop(self, daemon):
        """Missing source DB does not raise."""
        daemon._mark_logs_processed("browser", [1, 2, 3], query_id="qgen_123")

    def test_marks_multiple_logs(self, daemon, fs_db):
        for i in range(3):
            insert_fs_log(fs_db, "created", f"file{i}.py", f"/file{i}.py")

        conn = sqlite3.connect(fs_db)
        ids = [row[0] for row in conn.execute("SELECT id FROM fs_logs").fetchall()]
        conn.close()

        daemon._mark_logs_processed("filesystem", ids, query_id="qgen_batch")

        conn = sqlite3.connect(fs_db)
        processed = conn.execute("SELECT COUNT(*) FROM fs_logs WHERE query_gen_processed = 1").fetchone()[0]
        conn.close()
        assert processed == 3

    def test_auto_migrates_missing_column(self, daemon, app_root):
        """If processed_by_query_id column is missing, it gets auto-added."""
        # Create a table WITHOUT the processed_by_query_id column
        db_path = app_root / "data" / "daemons" / "email" / "logs.db"
        conn = sqlite3.connect(db_path)
        conn.execute("DROP TABLE IF EXISTS email_logs")
        conn.execute("""
            CREATE TABLE email_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                sender TEXT,
                subject TEXT,
                body_preview TEXT,
                query_gen_processed BOOLEAN DEFAULT 0
            )
        """)
        conn.execute(
            "INSERT INTO email_logs (timestamp, sender, subject, query_gen_processed) VALUES (?, ?, ?, ?)",
            (datetime.now(timezone.utc).isoformat(), "a@b.com", "Test", 0)
        )
        conn.commit()
        row_id = conn.execute("SELECT id FROM email_logs").fetchone()[0]
        conn.close()

        # Should auto-migrate and succeed
        daemon._mark_logs_processed("email", [row_id], query_id="qgen_migrated")

        conn = sqlite3.connect(db_path)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(email_logs)").fetchall()}
        row = conn.execute("SELECT processed_by_query_id FROM email_logs WHERE id = ?", (row_id,)).fetchone()
        conn.close()
        assert "processed_by_query_id" in columns
        assert row[0] == "qgen_migrated"

    def test_migration_tracked_prevents_repeated_alter(self, daemon, email_db):
        """After first migration, table is tracked and ALTER TABLE is not repeated."""
        insert_email_log(email_db, "a@b.com", "Test")
        conn = sqlite3.connect(email_db)
        row_id = conn.execute("SELECT id FROM email_logs").fetchone()[0]
        conn.close()

        daemon._mark_logs_processed("email", [row_id])
        assert "email_logs" in daemon._migrated_tables

        # Second call should NOT re-run ALTER TABLE
        daemon._mark_logs_processed("email", [row_id])
        # No error = migration skip worked


# ===========================================================================
# _mark_existing_logs_stale
# ===========================================================================

class TestMarkExistingLogsStale:

    @pytest.mark.asyncio
    async def test_marks_all_unprocessed_as_stale(self, daemon, browser_db, email_db, fs_db):
        """On startup, all existing unprocessed logs are marked as stale."""
        insert_browser_log(browser_db, "https://a.com", "A")
        insert_browser_log(browser_db, "https://b.com", "B")
        insert_email_log(email_db, "a@b.com", "Email 1")
        insert_fs_log(fs_db, "created", "file.py", "/file.py")

        await daemon._mark_existing_logs_stale()

        # All should be marked processed with 'stale_on_startup'
        for db_path, table in [(browser_db, "browser_logs"), (email_db, "email_logs"), (fs_db, "fs_logs")]:
            conn = sqlite3.connect(db_path)
            unprocessed = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE query_gen_processed = 0").fetchone()[0]
            stale = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE processed_by_query_id = 'stale_on_startup'").fetchone()[0]
            conn.close()
            assert unprocessed == 0
            assert stale > 0

    @pytest.mark.asyncio
    async def test_does_not_affect_already_processed(self, daemon, email_db):
        """Already processed logs are not touched."""
        insert_email_log(email_db, "a@b.com", "Old processed", processed=True)

        await daemon._mark_existing_logs_stale()

        conn = sqlite3.connect(email_db)
        row = conn.execute("SELECT processed_by_query_id FROM email_logs").fetchone()
        conn.close()
        # processed_by_query_id should remain None (not overwritten to 'stale_on_startup')
        assert row[0] is None

    @pytest.mark.asyncio
    async def test_handles_missing_source_db(self, daemon):
        """Missing source DBs do not crash the stale marking."""
        await daemon._mark_existing_logs_stale()  # Should not raise


# ===========================================================================
# _process_new_logs
# ===========================================================================

class TestProcessNewLogs:

    @pytest.mark.asyncio
    async def test_returns_zero_when_no_logs(self, daemon):
        """No source DBs -> returns 0."""
        count = await daemon._process_new_logs()
        assert count == 0

    @pytest.mark.asyncio
    async def test_threshold_gating(self, daemon, email_db):
        """Source below threshold is skipped (email threshold = 1)."""
        # Email threshold is 1, so 1 log should trigger
        insert_email_log(email_db, "a@b.com", "Important")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            return_value=["user received important email"]
        )

        count = await daemon._process_new_logs()
        assert count == 1

    @pytest.mark.asyncio
    async def test_browser_threshold_requires_2(self, daemon, browser_db):
        """Browser threshold is 2, so 1 log is not enough."""
        insert_browser_log(browser_db, "https://a.com", "A")

        count = await daemon._process_new_logs()
        assert count == 0
        daemon.generator.generate_queries_cross_source.assert_not_called()

    @pytest.mark.asyncio
    async def test_browser_2_logs_meets_threshold(self, daemon, browser_db):
        """2 browser logs meets the threshold and triggers query generation."""
        insert_browser_log(browser_db, "https://a.com", "A")
        insert_browser_log(browser_db, "https://b.com", "B")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            return_value=["user browsing A and B"]
        )

        count = await daemon._process_new_logs()
        # _process_new_logs returns the total number of logs processed, which should be 2
        assert count == 2
        daemon.generator.generate_queries_cross_source.assert_called_once()

    @pytest.mark.asyncio
    async def test_cross_source_assembly(self, daemon, email_db, fs_db):
        """Logs from multiple sources are assembled together."""
        insert_email_log(email_db, "ops@co.com", "Server down")
        insert_fs_log(fs_db, "modified", "fix.py", "/src/fix.py")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            return_value=["user fixing server issue"]
        )

        count = await daemon._process_new_logs()
        # Returns the number of logs processed, which is 2
        assert count == 2

        # Verify generator was called with docs from both sources
        call_args = daemon.generator.generate_queries_cross_source.call_args
        context_docs = call_args.args[0] if call_args.args else call_args[0][0]
        active_sources = call_args.args[1] if len(call_args.args) > 1 else call_args[0][1]
        assert len(context_docs) == 2
        assert "email" in active_sources
        assert "filesystem" in active_sources

    @pytest.mark.asyncio
    async def test_cross_source_aggregation_includes_below_threshold(
        self, daemon, email_db, browser_db
    ):
        """When email triggers (threshold 1), browser with 1 log (below threshold 2) is included."""
        insert_email_log(email_db, "prof@uni.edu", "Paper review notes")
        insert_browser_log(browser_db, "file:///papers/survey.pdf", "Multimodal Survey")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            return_value=["multimodal reasoning paper review"]
        )

        count = await daemon._process_new_logs()
        # count is the number of total logs processed, which is 2
        assert count == 2

        call_args = daemon.generator.generate_queries_cross_source.call_args
        context_docs = call_args.args[0] if call_args.args else call_args[0][0]
        active_sources = call_args.args[1] if len(call_args.args) > 1 else call_args[0][1]

        # Both sources included despite browser being below its individual threshold
        assert len(context_docs) == 2
        assert "email" in active_sources
        assert "browser" in active_sources

    @pytest.mark.asyncio
    async def test_no_source_above_threshold_skips_all(self, daemon, browser_db):
        """When only browser has 1 log (below threshold 2), nothing is processed."""
        insert_browser_log(browser_db, "https://random.com", "Random Page")

        count = await daemon._process_new_logs()
        assert count == 0
        daemon.generator.generate_queries_cross_source.assert_not_called()

    @pytest.mark.asyncio
    async def test_logs_marked_processed_after_generation(self, daemon, email_db):
        """Source logs are marked as processed after query generation."""
        insert_email_log(email_db, "a@b.com", "Test")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            return_value=["generated query"]
        )

        await daemon._process_new_logs()

        conn = sqlite3.connect(email_db)
        unprocessed = conn.execute("SELECT COUNT(*) FROM email_logs WHERE query_gen_processed = 0").fetchone()[0]
        conn.close()
        assert unprocessed == 0

    @pytest.mark.asyncio
    async def test_logs_marked_even_when_no_queries_generated(self, daemon, email_db):
        """Even if no queries generated, logs are marked to maintain linear flow."""
        insert_email_log(email_db, "a@b.com", "Routine")

        daemon.generator.generate_queries_cross_source = AsyncMock(return_value=[])

        await daemon._process_new_logs()

        conn = sqlite3.connect(email_db)
        unprocessed = conn.execute("SELECT COUNT(*) FROM email_logs WHERE query_gen_processed = 0").fetchone()[0]
        conn.close()
        assert unprocessed == 0

    @pytest.mark.asyncio
    async def test_context_docs_include_triggering_log_metadata(self, daemon, email_db):
        """Context docs sent to DB include _context_type='triggering_log' and _batch='current'."""
        insert_email_log(email_db, "a@b.com", "Critical")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            return_value=["test query"]
        )

        await daemon._process_new_logs()

        # Check what was stored in the query DB
        recent = daemon.db.get_recent_queries(hours_back=1)
        assert len(recent) == 1
        context_docs = recent[0]["context_docs"]
        triggering_logs = [
            d for d in context_docs
            if isinstance(d, dict) and d.get("metadata", {}).get("_context_type") == "triggering_log"
        ]
        assert len(triggering_logs) >= 1
        assert triggering_logs[0]["metadata"].get("_batch") == "current"

    @pytest.mark.asyncio
    async def test_evolutionary_context_included(self, daemon, email_db):
        """Previous batch queries are included as _context_type='previous_query'."""
        # Pre-populate a previous batch in the query DB
        daemon.db.insert_query(
            query="previous query about k8s",
            source_daemon="cross_source",
            context_docs=[{"url": "https://k8s.io"}],
            context_doc_ids=[1],
            batch_id="prev_batch",
        )

        insert_email_log(email_db, "a@b.com", "New email")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            return_value=["evolved query"]
        )

        await daemon._process_new_logs()

        # Verify evolutionary context was passed to generator
        call_args = daemon.generator.generate_queries_cross_source.call_args
        previous_batch = call_args.kwargs.get("previous_batch") or call_args[1].get("previous_batch")
        assert previous_batch is not None
        assert len(previous_batch) >= 1

    @pytest.mark.asyncio
    async def test_query_stored_with_batch_id(self, daemon, email_db):
        """Each batch gets a unique batch_id."""
        insert_email_log(email_db, "a@b.com", "Test")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            return_value=["test query"]
        )

        await daemon._process_new_logs()

        recent = daemon.db.get_recent_queries(hours_back=1)
        assert recent[0]["batch_id"] is not None
        assert len(recent[0]["batch_id"]) == 8  # uuid[:8]

    @pytest.mark.asyncio
    async def test_generator_exception_returns_zero(self, daemon, email_db):
        """Generator error is caught, returns 0, does not crash."""
        insert_email_log(email_db, "a@b.com", "Test")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            side_effect=Exception("LLM exploded")
        )

        count = await daemon._process_new_logs()
        assert count == 0

    @pytest.mark.asyncio
    async def test_priority_order_email_first(self, daemon, email_db, browser_db, fs_db):
        """Logs are collected in priority order: email > filesystem > browser."""
        insert_email_log(email_db, "a@b.com", "Email")
        insert_fs_log(fs_db, "modified", "f.py", "/f.py")
        # Browser needs 3 logs to meet threshold
        for i in range(3):
            insert_browser_log(browser_db, f"https://site{i}.com", f"Site {i}")

        daemon.generator.generate_queries_cross_source = AsyncMock(
            return_value=["cross source query"]
        )

        await daemon._process_new_logs()

        call_args = daemon.generator.generate_queries_cross_source.call_args
        active_sources = call_args.args[1] if len(call_args.args) > 1 else call_args[0][1]
        # All 3 sources should be present
        assert "email" in active_sources
        assert "filesystem" in active_sources
        assert "browser" in active_sources


# ===========================================================================
# _create_context_windows
# ===========================================================================

class TestCreateContextWindows:

    def test_creates_non_overlapping_windows(self, daemon):
        logs = [{"id": i} for i in range(10)]
        windows = daemon._create_context_windows(logs, window_size=5)
        assert len(windows) == 2
        assert len(windows[0]) == 5
        assert len(windows[1]) == 5

    def test_drops_partial_windows(self, daemon):
        """Incomplete windows (< window_size) are dropped."""
        logs = [{"id": i} for i in range(7)]
        windows = daemon._create_context_windows(logs, window_size=5)
        assert len(windows) == 1

    def test_empty_logs(self, daemon):
        windows = daemon._create_context_windows([], window_size=5)
        assert windows == []

    def test_exact_window_size(self, daemon):
        logs = [{"id": i} for i in range(5)]
        windows = daemon._create_context_windows(logs, window_size=5)
        assert len(windows) == 1


# ===========================================================================
# stop()
# ===========================================================================

class TestStop:

    @pytest.mark.asyncio
    async def test_stop_closes_generator(self, daemon):
        await daemon.stop()
        daemon.generator.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_stop_sets_disposed_flag(self, daemon):
        await daemon.stop()
        assert daemon._is_disposed is True
        assert daemon.running is False

    @pytest.mark.asyncio
    async def test_double_stop_is_idempotent(self, daemon):
        await daemon.stop()
        await daemon.stop()  # Should not raise
        # generator.close called only once
        daemon.generator.close.assert_called_once()


# ===========================================================================
# _check_and_reload_config
# ===========================================================================

class TestCheckAndReloadConfig:

    @pytest.mark.asyncio
    async def test_no_change_does_nothing(self, daemon):
        """If config hasn't changed, generator is not recreated."""
        with patch("services.daemons.query_generation.daemon.QueryGenerationDaemonConfig.from_settings") as mock_from:
            mock_from.return_value = daemon.config  # Same config
            await daemon._check_and_reload_config()
            daemon.generator.close.assert_not_called()

    @pytest.mark.asyncio
    async def test_model_change_recreates_generator(self, daemon):
        """If model changes, old generator is closed and new one created."""
        old_generator = daemon.generator  # Keep reference to mock

        new_config = QueryGenerationDaemonConfig(
            app_root=daemon.config.app_root,
            db_path=daemon.config.db_path,
            llm_api_base="http://localhost:7090/v1",
            llm_model="new-model-v2",  # Different model
            priority_thresholds=daemon.config.priority_thresholds,
        )

        with patch("services.daemons.query_generation.daemon.QueryGenerationDaemonConfig.from_settings") as mock_from:
            mock_from.return_value = new_config
            await daemon._check_and_reload_config()

        # Old generator mock should have been closed
        old_generator.close.assert_called_once()
        # Config updated
        assert daemon.config.llm_model == "new-model-v2"
        # Generator replaced with new instance (different object)
        assert daemon.generator is not old_generator
        assert daemon.generator.model == "new-model-v2"

    @pytest.mark.asyncio
    async def test_settings_load_failure_does_not_crash(self, daemon):
        """If from_settings() raises, daemon continues with old config."""
        with patch("services.daemons.query_generation.daemon.QueryGenerationDaemonConfig.from_settings") as mock_from:
            mock_from.side_effect = Exception("settings unavailable")
            await daemon._check_and_reload_config()  # Should not raise
            assert daemon.config.llm_model == "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"  # Unchanged
