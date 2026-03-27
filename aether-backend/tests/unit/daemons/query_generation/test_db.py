"""
Unit tests for services/daemons/query_generation/db.py

Tests QueryGenerationDB with REAL SQLite (tmp_path fixture -- no mocks).
Every test creates a fresh DB to verify actual SQL behavior.

Covers:
  Schema creation, auto-migration (query_id, batch_id columns)
  insert_query       -- fields stored, query_id format, JSON serialization
  get_last_batch_queries -- last 3 batches, limit, empty DB
  get_recent_queries -- hours_back filter, source_daemon filter, limit, JSON parsing
  mark_as_validated / mark_as_used -- flag updates, empty list
  cleanup_old_queries -- deletes old, preserves recent
  get_stats          -- correct aggregation
  _ensure_table_exists -- re-creates table after external drop
"""

import json
import sqlite3
import pytest
from datetime import datetime, timezone, timedelta

from services.daemons.query_generation.db import QueryGenerationDB


# ===========================================================================
# Fixtures
# ===========================================================================

@pytest.fixture
def db(tmp_path):
    """Fresh QueryGenerationDB using tmp directory."""
    db_path = tmp_path / "queries.db"
    return QueryGenerationDB(db_path)


@pytest.fixture
def db_with_data(db):
    """DB pre-populated with 3 queries across 2 batches."""
    db.insert_query(
        query="user researching kubernetes networking",
        source_daemon="cross_source",
        context_docs=[{"url": "https://k8s.io"}],
        context_doc_ids=[1, 2],
        batch_id="batch_A",
        llm_model="qwen3",
    )
    db.insert_query(
        query="user editing docker compose file",
        source_daemon="cross_source",
        context_docs=[{"file_path": "/docker-compose.yml"}],
        context_doc_ids=[3],
        batch_id="batch_A",
        llm_model="qwen3",
    )
    db.insert_query(
        query="user comparing redis vs memcached",
        source_daemon="cross_source",
        context_docs=[{"sender": "alice@co.com", "subject": "Cache Decision"}],
        context_doc_ids=[4, 5],
        batch_id="batch_B",
        llm_model="qwen3",
    )
    return db


# ===========================================================================
# Schema & Init
# ===========================================================================

class TestSchemaInit:

    def test_db_file_created(self, tmp_path):
        db_path = tmp_path / "test.db"
        assert not db_path.exists()
        QueryGenerationDB(db_path)
        assert db_path.exists()

    def test_table_created_with_all_columns(self, db):
        conn = sqlite3.connect(db.db_path)
        cursor = conn.execute("PRAGMA table_info(generated_queries)")
        columns = {row[1] for row in cursor.fetchall()}
        conn.close()

        expected = {
            "id", "timestamp", "query", "source_daemon", "context_docs",
            "context_doc_ids", "generation_method", "llm_model", "validated",
            "used_by_agent", "day_date", "batch_id", "query_id"
        }
        assert expected.issubset(columns), f"Missing columns: {expected - columns}"

    def test_indexes_created(self, db):
        conn = sqlite3.connect(db.db_path)
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='index'")
        indexes = {row[0] for row in cursor.fetchall()}
        conn.close()

        expected_indexes = {
            "idx_queries_query_id", "idx_queries_timestamp",
            "idx_queries_source_daemon", "idx_queries_validated",
            "idx_queries_day_date", "idx_queries_batch_id"
        }
        assert expected_indexes.issubset(indexes), f"Missing indexes: {expected_indexes - indexes}"

    def test_wal_mode_enabled(self, db):
        conn = sqlite3.connect(db.db_path)
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        conn.close()
        assert mode == "wal"


# ===========================================================================
# insert_query
# ===========================================================================

class TestInsertQuery:

    def test_returns_query_id(self, db):
        qid = db.insert_query(
            query="test query",
            source_daemon="cross_source",
            context_docs=[{"key": "value"}],
            context_doc_ids=[1],
        )
        assert qid.startswith("qgen_")
        assert len(qid) > 20  # qgen_ + timestamp + hash

    def test_query_id_format(self, db):
        """query_id = qgen_{YYYYMMDDHHMMSS}_{12-char-hash}"""
        qid = db.insert_query(
            query="test",
            source_daemon="cross_source",
            context_docs=[],
            context_doc_ids=[],
        )
        parts = qid.split("_")
        assert parts[0] == "qgen"
        # Second part is datetime (14 chars)
        assert len(parts[1]) == 14
        # Third part is hash (12 chars)
        assert len(parts[2]) == 12

    def test_context_docs_stored_as_json(self, db):
        docs = [{"url": "https://example.com"}, {"file_path": "/src/app.py"}]
        qid = db.insert_query(
            query="test",
            source_daemon="cross_source",
            context_docs=docs,
            context_doc_ids=[1, 2],
        )
        # Read raw from DB
        conn = sqlite3.connect(db.db_path)
        row = conn.execute(
            "SELECT context_docs FROM generated_queries WHERE query_id = ?", (qid,)
        ).fetchone()
        conn.close()

        parsed = json.loads(row[0])
        assert len(parsed) == 2
        # Context docs are normalized to canonical SourceDocument shape.
        assert parsed[0]["source"] == "browser"
        assert parsed[0]["content"] == "https://example.com"
        assert parsed[0]["metadata"]["url"] == "https://example.com"
        assert parsed[1]["source"] == "filesystem"
        assert parsed[1]["metadata"]["file_path"] == "/src/app.py"
        assert parsed[1]["metadata"]["file_name"] == "app.py"

    def test_context_doc_ids_stored_as_json(self, db):
        ids = [10, 20, 30]
        qid = db.insert_query(
            query="test",
            source_daemon="cross_source",
            context_docs=[],
            context_doc_ids=ids,
        )
        conn = sqlite3.connect(db.db_path)
        row = conn.execute(
            "SELECT context_doc_ids FROM generated_queries WHERE query_id = ?", (qid,)
        ).fetchone()
        conn.close()

        parsed = json.loads(row[0])
        assert parsed == [10, 20, 30]

    def test_all_fields_persisted(self, db):
        qid = db.insert_query(
            query="kubernetes deployment",
            source_daemon="cross_source",
            context_docs=[{"k": "v"}],
            context_doc_ids=[1],
            generation_method="agentic_cross_source",
            llm_model="qwen3-4b",
            batch_id="batch_X",
        )
        conn = sqlite3.connect(db.db_path)
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute(
            "SELECT * FROM generated_queries WHERE query_id = ?", (qid,)
        ).fetchone())
        conn.close()

        assert row["query"] == "kubernetes deployment"
        assert row["source_daemon"] == "cross_source"
        assert row["generation_method"] == "agentic_cross_source"
        assert row["llm_model"] == "qwen3-4b"
        assert row["batch_id"] == "batch_X"
        assert row["validated"] == 0
        assert row["used_by_agent"] == 0

    def test_day_date_auto_set(self, db):
        qid = db.insert_query(
            query="test",
            source_daemon="cross_source",
            context_docs=[],
            context_doc_ids=[],
        )
        conn = sqlite3.connect(db.db_path)
        row = conn.execute(
            "SELECT day_date FROM generated_queries WHERE query_id = ?", (qid,)
        ).fetchone()
        conn.close()

        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        assert row[0] == today

    def test_unique_query_ids_for_same_query(self, db):
        """Two inserts of same query text produce different query_ids."""
        qid1 = db.insert_query(query="same query", source_daemon="x", context_docs=[], context_doc_ids=[])
        qid2 = db.insert_query(query="same query", source_daemon="x", context_docs=[], context_doc_ids=[])
        assert qid1 != qid2


class TestContextDocNormalization:

    def test_previous_query_legacy_doc_normalized(self, db):
        db.insert_query(
            query="new query",
            source_daemon="cross_source",
            context_docs=[{"_context_type": "previous_query", "query": "older query"}],
            context_doc_ids=[1],
        )

        recent = db.get_recent_queries(hours_back=1, limit=1)
        assert len(recent) == 1
        doc = recent[0]["context_docs"][0]
        assert doc["source"] == "query_gen"
        assert doc["content"] == "older query"
        assert doc["metadata"]["_context_type"] == "previous_query"
        assert doc["metadata"]["title"] == "older query"


# ===========================================================================
# get_last_batch_queries
# ===========================================================================

class TestGetLastBatchQueries:

    def test_returns_queries_from_last_batches(self, db_with_data):
        result = db_with_data.get_last_batch_queries(limit=10)
        assert len(result) == 3
        batch_ids = {r["batch_id"] for r in result}
        assert batch_ids == {"batch_A", "batch_B"}

    def test_limit_respected(self, db_with_data):
        result = db_with_data.get_last_batch_queries(limit=1)
        assert len(result) == 1

    def test_empty_db_returns_empty(self, db):
        result = db.get_last_batch_queries()
        assert result == []

    def test_context_docs_parsed_from_json(self, db_with_data):
        result = db_with_data.get_last_batch_queries(limit=10)
        for row in result:
            assert isinstance(row["context_docs"], list)
            # Should be the actual parsed objects, not JSON strings
            if row["context_docs"]:
                assert isinstance(row["context_docs"][0], dict)

    def test_queries_without_batch_id_excluded(self, db):
        """Queries with batch_id=NULL are not returned."""
        db.insert_query(
            query="no batch",
            source_daemon="x",
            context_docs=[],
            context_doc_ids=[],
            batch_id=None,
        )
        result = db.get_last_batch_queries()
        assert result == []

    def test_max_3_batch_ids(self, db):
        """Only last 3 distinct batch_ids returned."""
        for i in range(5):
            db.insert_query(
                query=f"query {i}",
                source_daemon="x",
                context_docs=[],
                context_doc_ids=[],
                batch_id=f"batch_{i}",
            )
        result = db.get_last_batch_queries(limit=100)
        batch_ids = {r["batch_id"] for r in result}
        # Exactly 3 batches (the 3 most recent)
        assert len(batch_ids) == 3


# ===========================================================================
# get_recent_queries
# ===========================================================================

class TestGetRecentQueries:

    def test_returns_recent_queries(self, db_with_data):
        result = db_with_data.get_recent_queries(hours_back=1)
        assert len(result) == 3

    def test_hours_back_filter(self, db):
        """Queries older than hours_back are excluded."""
        # Insert with a very old timestamp by manipulating DB directly
        old_ts = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
        conn = sqlite3.connect(db.db_path)
        conn.execute(
            """INSERT INTO generated_queries 
               (query_id, timestamp, query, source_daemon, context_docs, context_doc_ids, day_date)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("old_id", old_ts, "old query", "x", "[]", "[]", "2020-01-01")
        )
        conn.commit()
        conn.close()

        # Also insert a fresh one
        db.insert_query(query="fresh", source_daemon="x", context_docs=[], context_doc_ids=[])

        result = db.get_recent_queries(hours_back=24)
        queries = [r["query"] for r in result]
        assert "fresh" in queries
        assert "old query" not in queries

    def test_source_daemon_filter(self, db):
        db.insert_query(query="q1", source_daemon="email", context_docs=[], context_doc_ids=[])
        db.insert_query(query="q2", source_daemon="browser", context_docs=[], context_doc_ids=[])

        result = db.get_recent_queries(source_daemon="email")
        assert len(result) == 1
        assert result[0]["query"] == "q1"

    def test_limit_respected(self, db_with_data):
        result = db_with_data.get_recent_queries(limit=2)
        assert len(result) == 2

    def test_json_fields_parsed(self, db_with_data):
        result = db_with_data.get_recent_queries()
        for row in result:
            assert isinstance(row["context_docs"], list)
            assert isinstance(row["context_doc_ids"], list)

    def test_empty_db_returns_empty(self, db):
        result = db.get_recent_queries()
        assert result == []

    def test_ordered_desc_by_timestamp(self, db_with_data):
        result = db_with_data.get_recent_queries()
        timestamps = [r["timestamp"] for r in result]
        assert timestamps == sorted(timestamps, reverse=True)


# ===========================================================================
# mark_as_validated / mark_as_used
# ===========================================================================

class TestMarkFlags:

    def test_mark_as_validated(self, db):
        db.insert_query(query="q1", source_daemon="x", context_docs=[], context_doc_ids=[])
        # Get ID
        conn = sqlite3.connect(db.db_path)
        row_id = conn.execute("SELECT id FROM generated_queries").fetchone()[0]
        conn.close()

        db.mark_as_validated([row_id])

        conn = sqlite3.connect(db.db_path)
        validated = conn.execute(
            "SELECT validated FROM generated_queries WHERE id = ?", (row_id,)
        ).fetchone()[0]
        conn.close()
        assert validated == 1

    def test_mark_as_used(self, db):
        db.insert_query(query="q1", source_daemon="x", context_docs=[], context_doc_ids=[])
        conn = sqlite3.connect(db.db_path)
        row_id = conn.execute("SELECT id FROM generated_queries").fetchone()[0]
        conn.close()

        db.mark_as_used([row_id])

        conn = sqlite3.connect(db.db_path)
        used = conn.execute(
            "SELECT used_by_agent FROM generated_queries WHERE id = ?", (row_id,)
        ).fetchone()[0]
        conn.close()
        assert used == 1

    def test_mark_validated_empty_list(self, db):
        """Empty list is a no-op, does not raise."""
        db.mark_as_validated([])

    def test_mark_used_empty_list(self, db):
        db.mark_as_used([])

    def test_mark_multiple_ids(self, db):
        ids = []
        for i in range(3):
            db.insert_query(query=f"q{i}", source_daemon="x", context_docs=[], context_doc_ids=[])
        conn = sqlite3.connect(db.db_path)
        rows = conn.execute("SELECT id FROM generated_queries").fetchall()
        ids = [r[0] for r in rows]
        conn.close()

        db.mark_as_validated(ids)

        conn = sqlite3.connect(db.db_path)
        validated = conn.execute("SELECT COUNT(*) FROM generated_queries WHERE validated = 1").fetchone()[0]
        conn.close()
        assert validated == 3


# ===========================================================================
# cleanup_old_queries
# ===========================================================================

class TestCleanupOldQueries:

    def test_deletes_old_preserves_recent(self, db):
        # Insert old via raw SQL
        old_ts = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        conn = sqlite3.connect(db.db_path)
        conn.execute(
            """INSERT INTO generated_queries 
               (query_id, timestamp, query, source_daemon, context_docs, context_doc_ids, day_date)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("old_id", old_ts, "old query", "x", "[]", "[]", "2020-01-01")
        )
        conn.commit()
        conn.close()

        # Insert fresh
        db.insert_query(query="fresh", source_daemon="x", context_docs=[], context_doc_ids=[])

        db.cleanup_old_queries(days=7)

        conn = sqlite3.connect(db.db_path)
        remaining = conn.execute("SELECT query FROM generated_queries").fetchall()
        conn.close()
        queries = [r[0] for r in remaining]
        assert "fresh" in queries
        assert "old query" not in queries

    def test_cleanup_empty_db(self, db):
        """No crash on empty DB."""
        db.cleanup_old_queries(days=7)


# ===========================================================================
# get_stats
# ===========================================================================

class TestGetStats:

    def test_empty_db_stats(self, db):
        stats = db.get_stats()
        assert stats == {
            "total_queries": 0,
            "validated_queries": 0,
            "used_queries": 0,
            "source_daemons": 0,
        }

    def test_stats_correct_counts(self, db):
        db.insert_query(query="q1", source_daemon="email", context_docs=[], context_doc_ids=[])
        db.insert_query(query="q2", source_daemon="browser", context_docs=[], context_doc_ids=[])

        # Mark one as validated
        conn = sqlite3.connect(db.db_path)
        row_id = conn.execute("SELECT id FROM generated_queries LIMIT 1").fetchone()[0]
        conn.close()
        db.mark_as_validated([row_id])

        stats = db.get_stats()
        assert stats["total_queries"] == 2
        assert stats["validated_queries"] == 1
        assert stats["used_queries"] == 0
        assert stats["source_daemons"] == 2  # email + browser


# ===========================================================================
# _ensure_table_exists (recovery after external deletion)
# ===========================================================================

class TestEnsureTableExists:

    def test_recovers_after_table_drop(self, db):
        """If table is externally dropped, _get_connection re-creates it."""
        db.insert_query(query="test", source_daemon="x", context_docs=[], context_doc_ids=[])

        # Externally drop the table
        conn = sqlite3.connect(db.db_path)
        conn.execute("DROP TABLE generated_queries")
        conn.commit()
        conn.close()

        # Next operation should auto-recover
        stats = db.get_stats()
        assert stats["total_queries"] == 0  # Table recreated but empty


# ===========================================================================
# Auto-migration
# ===========================================================================

class TestAutoMigration:

    def test_migration_adds_query_id_column(self, tmp_path):
        """If DB was created without query_id column, migration adds it."""
        db_path = tmp_path / "legacy.db"
        # Create a legacy schema WITHOUT query_id
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE generated_queries (
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
                day_date TEXT NOT NULL
            )
        """)
        # Insert a row
        conn.execute(
            """INSERT INTO generated_queries 
               (timestamp, query, source_daemon, context_docs, context_doc_ids, day_date)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("2026-01-01T00:00:00", "legacy query", "x", "[]", "[]", "2026-01-01")
        )
        conn.commit()
        conn.close()

        # Open with QueryGenerationDB -- should auto-migrate
        db = QueryGenerationDB(db_path)

        # Verify query_id column exists
        conn = sqlite3.connect(db_path)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(generated_queries)").fetchall()}
        conn.close()
        assert "query_id" in columns
        assert "batch_id" in columns

    def test_migration_backfills_query_id(self, tmp_path):
        """Existing rows get backfilled query_id during migration."""
        db_path = tmp_path / "legacy.db"
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE generated_queries (
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
                day_date TEXT NOT NULL
            )
        """)
        conn.execute(
            """INSERT INTO generated_queries 
               (timestamp, query, source_daemon, context_docs, context_doc_ids, day_date)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("2026-01-15T10:30:00", "legacy", "x", "[]", "[]", "2026-01-15")
        )
        conn.commit()
        conn.close()

        db = QueryGenerationDB(db_path)

        # Verify backfilled
        conn = sqlite3.connect(db_path)
        row = conn.execute("SELECT query_id FROM generated_queries WHERE query = 'legacy'").fetchone()
        conn.close()
        assert row[0] is not None
        assert row[0].startswith("qgen_")
