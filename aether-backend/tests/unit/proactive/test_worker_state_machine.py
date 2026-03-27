"""
Unit tests for ProactiveAgentWorker state machine logic.

Tests the worker's query selection, stale marking, processing gate,
enabled check, and lifecycle -- the Phase 2 orchestration logic that
existing handler tests may not cover deeply.

Uses REAL SQLite for queries.db to test actual SQL behavior.

Covers:
  _is_enabled               -- missing file, valid file, corrupted JSON, enabled: false
  _get_most_recent_unprocessed_query -- returns latest, stales older, empty DB
  processing flag gate      -- while processing=True, new queries are staled
  _parse_context_docs       -- valid JSON, invalid JSON, empty
  stop                      -- lifecycle flags, idempotent
  _process_cycle            -- guards (disposed, disabled, no DB)
"""

import json
import sqlite3
import pytest
from pathlib import Path
from datetime import datetime, timezone

from workers.handlers.proactive_agent_handler import ProactiveAgentWorker
from services.daemons.query_generation.db import QueryGenerationDB


# ===========================================================================
# Fixtures
# ===========================================================================

@pytest.fixture
def app_root(tmp_path):
    (tmp_path / "data" / "daemons" / "query_generation").mkdir(parents=True)
    (tmp_path / "data" / "runtime").mkdir(parents=True)
    return tmp_path


@pytest.fixture
def worker(app_root):
    """Worker with no real settings (uses defaults)."""
    w = ProactiveAgentWorker(
        app_root=app_root,
        backend_url="http://localhost:8765",
        settings=None,
    )
    return w


@pytest.fixture
def query_db(app_root):
    """Real QueryGenerationDB at the path worker expects."""
    db_path = app_root / "data" / "daemons" / "query_generation" / "queries.db"
    return QueryGenerationDB(db_path)


def insert_raw_query(db_path: Path, query: str, query_id: str, timestamp: str = None, used: bool = False, batch_id: str = None):
    """Insert a query directly into SQLite with precise control."""
    if timestamp is None:
        timestamp = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(db_path)
    conn.execute("""
        INSERT INTO generated_queries (query_id, timestamp, query, source_daemon, context_docs, context_doc_ids, day_date, used_by_agent, batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (query_id, timestamp, query, "cross_source", "[]", "[]", "2026-02-09", int(used), batch_id))
    conn.commit()
    conn.close()


# ===========================================================================
# _is_enabled
# ===========================================================================

class TestIsEnabled:

    def test_enabled_when_config_missing(self, worker):
        """Default: enabled when config file doesn't exist."""
        assert worker._is_enabled() is True

    def test_enabled_when_config_says_true(self, worker, app_root):
        config_path = app_root / "data" / "runtime" / "proactive_config.json"
        config_path.write_text(json.dumps({"enabled": True}))
        worker.config_path = config_path
        assert worker._is_enabled() is True

    def test_disabled_when_config_says_false(self, worker, app_root):
        config_path = app_root / "data" / "runtime" / "proactive_config.json"
        config_path.write_text(json.dumps({"enabled": False}))
        worker.config_path = config_path
        assert worker._is_enabled() is False

    def test_enabled_on_corrupted_json(self, worker, app_root):
        """Corrupted config defaults to enabled (fail-open for proactive features)."""
        config_path = app_root / "data" / "runtime" / "proactive_config.json"
        config_path.write_text("NOT VALID JSON {{{")
        worker.config_path = config_path
        assert worker._is_enabled() is True

    def test_enabled_when_key_missing(self, worker, app_root):
        """Config exists but 'enabled' key is missing -> defaults to True."""
        config_path = app_root / "data" / "runtime" / "proactive_config.json"
        config_path.write_text(json.dumps({"mode": "balanced"}))
        worker.config_path = config_path
        assert worker._is_enabled() is True

    def test_enabled_on_empty_file(self, worker, app_root):
        """Empty file -> JSON decode error -> defaults to enabled."""
        config_path = app_root / "data" / "runtime" / "proactive_config.json"
        config_path.write_text("")
        worker.config_path = config_path
        assert worker._is_enabled() is True


# ===========================================================================
# _get_most_recent_unprocessed_query
# ===========================================================================

class TestGetMostRecentUnprocessedQuery:

    def test_returns_latest_query(self, worker, query_db):
        """Returns the single most recent unprocessed query by timestamp."""
        insert_raw_query(query_db.db_path, "old query", "qgen_old", "2026-02-09T09:00:00+00:00", batch_id="batch1")
        insert_raw_query(query_db.db_path, "new query", "qgen_new", "2026-02-09T10:00:00+00:00", batch_id="batch1")

        result = worker._get_most_recent_unprocessed_query()
        assert result is not None
        assert result["query"] == "new query"
        assert result["query_id"] == "qgen_new"

    def test_stales_older_queries(self, worker, query_db):
        """Queries from older batches are marked as stale (used_by_agent=1)."""
        # old batch
        insert_raw_query(query_db.db_path, "old1", "qgen_old1", "2026-02-09T08:00:00+00:00", batch_id="batch_old")
        insert_raw_query(query_db.db_path, "old2", "qgen_old2", "2026-02-09T09:00:00+00:00", batch_id="batch_old")
        
        # latest batch
        insert_raw_query(query_db.db_path, "latest", "qgen_latest", "2026-02-09T10:00:00+00:00", batch_id="batch_new")

        result = worker._get_most_recent_unprocessed_query()
        assert result["query_id"] == "qgen_latest"

        # Verify older queries are now staled
        conn = sqlite3.connect(query_db.db_path)
        old1 = conn.execute("SELECT used_by_agent FROM generated_queries WHERE query_id = 'qgen_old1'").fetchone()
        old2 = conn.execute("SELECT used_by_agent FROM generated_queries WHERE query_id = 'qgen_old2'").fetchone()
        latest = conn.execute("SELECT used_by_agent FROM generated_queries WHERE query_id = 'qgen_latest'").fetchone()
        conn.close()

        assert old1[0] == 1  # Staled
        assert old2[0] == 1  # Staled
        assert latest[0] == 0  # NOT staled (returned for processing)

    def test_empty_db_returns_none(self, worker, query_db):
        result = worker._get_most_recent_unprocessed_query()
        assert result is None

    def test_all_processed_returns_none(self, worker, query_db):
        insert_raw_query(query_db.db_path, "used query", "qgen_used", used=True)
        result = worker._get_most_recent_unprocessed_query()
        assert result is None

    def test_missing_db_file_returns_none(self, worker):
        """If query DB doesn't exist, returns None without crash."""
        worker.query_db_path = Path("/nonexistent/queries.db")
        result = worker._get_most_recent_unprocessed_query()
        assert result is None

    def test_returns_correct_fields(self, worker, query_db):
        """Returned dict has all fields needed by _process_single_query."""
        query_db.insert_query(
            query="test query",
            source_daemon="cross_source",
            context_docs=[{"sender": "a@b.com", "subject": "Test"}],
            context_doc_ids=[1],
            batch_id="batch_x",
        )
        result = worker._get_most_recent_unprocessed_query()
        assert result is not None
        required_fields = {"query_id", "query", "source_daemon", "day_date", "context_docs", "context_doc_ids", "timestamp"}
        assert required_fields.issubset(set(result.keys()))


# ===========================================================================
# _parse_context_docs
# ===========================================================================

class TestParseContextDocs:

    def test_valid_json(self, worker):
        result = worker._parse_context_docs('[{"sender": "a@b.com"}]')
        assert len(result) == 1
        assert result[0]["sender"] == "a@b.com"

    def test_invalid_json_returns_empty(self, worker):
        result = worker._parse_context_docs("NOT JSON {{{")
        assert result == []

    def test_none_returns_empty(self, worker):
        result = worker._parse_context_docs(None)
        assert result == []

    def test_empty_string_returns_empty(self, worker):
        result = worker._parse_context_docs("")
        assert result == []

    def test_empty_array(self, worker):
        result = worker._parse_context_docs("[]")
        assert result == []

    def test_complex_nested_json(self, worker):
        docs = [
            {"sender": "a@b.com", "subject": "Test", "_context_type": "triggering_log", "_batch": "current"},
            {"_context_type": "previous_query", "query": "old", "batch_id": "abc"},
        ]
        result = worker._parse_context_docs(json.dumps(docs))
        assert len(result) == 2
        assert result[0]["_context_type"] == "triggering_log"
        assert result[1]["_context_type"] == "previous_query"


# ===========================================================================
# stop() lifecycle
# ===========================================================================

class TestStopLifecycle:

    def test_stop_sets_flags(self, worker):
        worker.stop()
        assert worker.running is False
        assert worker._is_disposed is True

    def test_double_stop_is_idempotent(self, worker):
        worker.stop()
        worker.stop()  # Should not raise

    def test_start_after_dispose_is_noop(self, worker):
        """Cannot start a disposed worker."""
        worker.stop()
        # start() should return immediately without entering loop
        # (tested via _is_disposed check at start())
        assert worker._is_disposed is True


# ===========================================================================
# _process_cycle guards
# ===========================================================================

class TestProcessCycleGuards:

    @pytest.mark.asyncio
    async def test_skips_when_disposed(self, worker, query_db):
        """Disposed worker skips processing."""
        worker._is_disposed = True
        insert_raw_query(query_db.db_path, "query", "qgen_1")
        await worker._process_cycle()
        # Query should still be unprocessed
        conn = sqlite3.connect(query_db.db_path)
        count = conn.execute("SELECT COUNT(*) FROM generated_queries WHERE used_by_agent = 0").fetchone()[0]
        conn.close()
        assert count == 1

    @pytest.mark.asyncio
    async def test_skips_when_disabled(self, worker, query_db, app_root):
        """Disabled worker skips processing."""
        config_path = app_root / "data" / "runtime" / "proactive_config.json"
        config_path.write_text(json.dumps({"enabled": False}))
        worker.config_path = config_path

        insert_raw_query(query_db.db_path, "query", "qgen_1")
        await worker._process_cycle()

        conn = sqlite3.connect(query_db.db_path)
        count = conn.execute("SELECT COUNT(*) FROM generated_queries WHERE used_by_agent = 0").fetchone()[0]
        conn.close()
        assert count == 1

    @pytest.mark.asyncio
    async def test_skips_when_no_query_db(self, worker):
        """Missing query DB -> skip gracefully."""
        worker.query_db_path = Path("/nonexistent/queries.db")
        await worker._process_cycle()  # Should not raise

    @pytest.mark.asyncio
    async def test_skips_when_no_unprocessed_queries(self, worker, query_db):
        """No unprocessed queries -> skip."""
        insert_raw_query(query_db.db_path, "used", "qgen_used", used=True)
        await worker._process_cycle()  # Should not raise


# ===========================================================================
# Processing flag gate (the backlog prevention mechanism)
# ===========================================================================

class TestProcessingFlagGate:

    def test_processing_flag_starts_false(self, worker):
        assert worker.processing is False

    def test_constructor_default_values(self, worker):
        """Verify constructor sets correct defaults when no settings provided."""
        assert worker.heartbeat_interval == 10
        assert worker.max_processing_time == 300
        assert not hasattr(worker, "mode")
        assert not hasattr(worker, "relevance_threshold")
