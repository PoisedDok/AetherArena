"""
Tests for workers/handlers/proactive_agent_handler.py

Covers: ProactiveAgentWorker constructor, start/stop lifecycle, _is_enabled,
_process_cycle, _get_most_recent_unprocessed_query,
_parse_context_docs, _process_single_query, _mark_query_processed,
_emit_proactive_notification.
"""

import asyncio
import json
import sqlite3
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

@pytest.fixture(autouse=True)
def mock_db_connection():
    with patch("api.dependencies.get_database_connection") as mock_get_db:
        mock_get_db.return_value = MagicMock()
        yield mock_get_db

@pytest.fixture(autouse=True)
def mock_chat_activity_signal():
    # Prevent tests from failing intermittently if the dev server touches the real /tmp/chat_activity.trigger
    with patch("services.daemons.CHAT_ACTIVITY_SIGNAL_FILE") as mock_file:
        mock_file.exists.return_value = False
        yield mock_file

from uuid import uuid4


# ===========================================================================
# Helpers
# ===========================================================================

def _create_query_db(db_path, rows=None):
    """Create a real SQLite database with the generated_queries schema."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS generated_queries (
            query_id TEXT PRIMARY KEY,
            query TEXT NOT NULL,
            source_daemon TEXT,
            day_date TEXT,
            context_docs TEXT DEFAULT '[]',
            context_doc_ids TEXT DEFAULT '',
            timestamp TEXT NOT NULL,
            used_by_agent INTEGER DEFAULT 0,
            batch_id TEXT
        )
    """)
    for row in (rows or []):
        conn.execute(
            "INSERT INTO generated_queries"
            " (query_id, query, source_daemon, day_date, context_docs,"
            "  context_doc_ids, timestamp, used_by_agent, batch_id)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                row.get("query_id", str(uuid4())),
                row.get("query", "test query"),
                row.get("source_daemon", "browser"),
                row.get("day_date", "2026-02-08"),
                row.get("context_docs", "[]"),
                row.get("context_doc_ids", ""),
                row.get("timestamp", "2026-02-08T12:00:00"),
                row.get("used_by_agent", 0),
                row.get("batch_id", "b1"),
            ),
        )
    conn.commit()
    conn.close()


def _read_rows(db_path):
    """Read all rows from generated_queries for verification."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM generated_queries ORDER BY timestamp DESC"
    )]
    conn.close()
    return rows


def _make_settings(app_root=None):
    """Create mock settings with proactive.agent_worker config.

    app_root: real Path for tests that need file I/O via the unified config reader.
    When None, settings.app_root is MagicMock (unified reader falls back to defaults).
    """
    settings = MagicMock()
    worker_config = MagicMock()
    worker_config.heartbeat_interval_seconds = 5
    worker_config.max_processing_time_seconds = 120
    worker_config.enabled = True
    settings.proactive.agent_worker = worker_config
    settings.proactive.enabled = True
    settings.proactive.daemons.browser_enabled = False
    settings.proactive.daemons.email_enabled = False
    settings.proactive.daemons.file_system_enabled = False
    settings.proactive.daemons.query_generation_enabled = False
    settings.proactive.daemons.file_indexing_enabled = False
    settings.security.bind_port = 8765
    if app_root is not None:
        settings.app_root = Path(app_root)
    return settings


def _make_worker(tmp_path, settings=None, websocket_hub=None, backend_url=None):
    """Create ProactiveAgentWorker with tmp_path as app_root."""
    from workers.handlers.proactive_agent_handler import ProactiveAgentWorker

    s = settings if settings is not None else _make_settings(app_root=tmp_path)
    return ProactiveAgentWorker(
        app_root=tmp_path,
        backend_url=backend_url or "http://127.0.0.1:8765",
        settings=s,
        websocket_hub=websocket_hub,
    )


def _make_httpx_response(status_code=200, json_data=None, text=""):
    """Create mock httpx response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    resp.text = text or json.dumps(json_data or {})
    return resp


def _make_httpx_client(response):
    """Create mock httpx.AsyncClient supporting async context manager."""
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(return_value=response)
    return client


def _agent_result(decision="defer", recommendation="", run_id=None, tool_budget=0):
    """Build a proactive agent response payload."""
    return {
        "decision": decision,
        "recommendation": recommendation,
        "run_id": run_id or str(uuid4()),
        "tool_budget": tool_budget,
    }


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_init_with_settings_reads_worker_config(self, tmp_path):
        """Settings with proactive.agent_worker → reads config values."""
        settings = _make_settings()
        worker = _make_worker(tmp_path, settings=settings)
        assert worker.heartbeat_interval == 5
        assert worker.max_processing_time == 120

    def test_init_without_proactive_attr_uses_defaults(self, tmp_path):
        """Settings without proactive attribute → fallback defaults + warning."""
        settings = MagicMock(spec=[])  # No attributes
        worker = _make_worker(tmp_path, settings=settings)
        assert worker.heartbeat_interval == 10
        assert worker.max_processing_time == 300

    def test_init_none_settings_uses_defaults(self, tmp_path):
        """settings=None → fallback defaults."""
        from workers.handlers.proactive_agent_handler import ProactiveAgentWorker
        worker = ProactiveAgentWorker(
            app_root=tmp_path,
            backend_url="http://localhost:8765",
            settings=None,
        )
        assert worker.heartbeat_interval == 10

    def test_init_backend_url_from_settings_when_none(self, tmp_path):
        """backend_url=None + settings provided → derives from bind_port."""
        settings = _make_settings()
        settings.security.bind_port = 9999
        from workers.handlers.proactive_agent_handler import ProactiveAgentWorker
        worker = ProactiveAgentWorker(
            app_root=tmp_path,
            backend_url=None,
            settings=settings,
        )
        assert worker.backend_url == "http://127.0.0.1:9999"

    def test_init_backend_url_none_no_settings_calls_get_settings(self, tmp_path):
        """backend_url=None + settings=None → imports and calls get_settings()."""
        mock_settings = _make_settings()
        mock_settings.security.bind_port = 7777
        with patch(
            "config.settings.get_settings", return_value=mock_settings
        ):
            from workers.handlers.proactive_agent_handler import ProactiveAgentWorker
            worker = ProactiveAgentWorker(
                app_root=tmp_path,
                backend_url=None,
                settings=None,
            )
        assert worker.backend_url == "http://127.0.0.1:7777"

    def test_init_strips_trailing_slash(self, tmp_path):
        worker = _make_worker(tmp_path, backend_url="http://localhost:8765/")
        assert worker.backend_url == "http://localhost:8765"

    def test_init_lifecycle_flags(self, tmp_path):
        worker = _make_worker(tmp_path)
        assert worker.running is False
        assert worker._is_disposed is False
        assert worker.processing is False

    def test_init_paths(self, tmp_path):
        worker = _make_worker(tmp_path)
        assert worker.query_db_path == tmp_path / "data" / "daemons" / "query_generation" / "queries.db"
        assert worker.config_path == tmp_path / "data" / "runtime" / "proactive_config.json"

    def test_init_websocket_hub_stored(self, tmp_path):
        hub = MagicMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)
        assert worker.websocket_hub is hub


# ===========================================================================
# start()
# ===========================================================================

class TestStart:

    async def test_start_disposed_returns_immediately(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker._is_disposed = True
        worker._process_cycle = AsyncMock()
        await worker.start()
        worker._process_cycle.assert_not_called()

    async def test_start_processes_cycle_when_not_busy(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker._process_cycle = AsyncMock()
        call_count = 0

        async def _stop_loop(_interval):
            nonlocal call_count
            call_count += 1
            worker.running = False

        with patch("asyncio.sleep", side_effect=_stop_loop):
            await worker.start()
        worker._process_cycle.assert_called_once()
        assert worker.running is False

    async def test_start_always_calls_process_cycle(self, tmp_path):
        """Heartbeat always calls _process_cycle regardless of processing flag.
        
        Backlog prevention is handled inside _get_most_recent_unprocessed_query()
        which atomically stales older queries when fetching the latest one.
        The start() loop is unconditional — no branch on self.processing.
        """
        worker = _make_worker(tmp_path)
        worker._process_cycle = AsyncMock()

        async def _stop_loop(_interval):
            worker.running = False

        worker.processing = True  # Should NOT prevent _process_cycle from being called
        with patch("asyncio.sleep", side_effect=_stop_loop):
            await worker.start()

        worker._process_cycle.assert_called_once()

    async def test_start_catches_exception_resets_processing(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker.processing = False
        worker._process_cycle = AsyncMock(side_effect=RuntimeError("boom"))

        async def _stop_loop(_interval):
            worker.running = False

        with patch("asyncio.sleep", side_effect=_stop_loop):
            await worker.start()

        # processing should be reset to False by the exception handler
        assert worker.processing is False

    async def test_start_uses_heartbeat_interval(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker._process_cycle = AsyncMock()
        intervals = []

        async def _capture_interval(interval):
            intervals.append(interval)
            worker.running = False

        with patch("asyncio.sleep", side_effect=_capture_interval):
            await worker.start()

        assert intervals == [5]  # heartbeat_interval from settings


# ===========================================================================
# stop()
# ===========================================================================

class TestStop:

    def test_stop_sets_flags(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker.running = True
        worker.stop()
        assert worker.running is False
        assert worker._is_disposed is True

    def test_stop_double_stop_is_noop(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker.stop()
        assert worker._is_disposed is True
        # Second stop should do nothing (no error)
        worker.stop()
        assert worker._is_disposed is True


# ===========================================================================
# _is_enabled()
# ===========================================================================

class TestIsEnabled:

    def test_enabled_config_missing(self, tmp_path):
        """No config file → default enabled."""
        worker = _make_worker(tmp_path)
        assert worker._is_enabled() is True

    def test_enabled_config_true(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker.config_path.parent.mkdir(parents=True, exist_ok=True)
        worker.config_path.write_text(json.dumps({"enabled": True}))
        assert worker._is_enabled() is True

    def test_enabled_config_false(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker.config_path.parent.mkdir(parents=True, exist_ok=True)
        worker.config_path.write_text(json.dumps({"enabled": False}))
        assert worker._is_enabled() is False

    def test_enabled_config_no_key_defaults_true(self, tmp_path):
        """Config exists but no 'enabled' key → defaults to True."""
        worker = _make_worker(tmp_path)
        worker.config_path.parent.mkdir(parents=True, exist_ok=True)
        worker.config_path.write_text(json.dumps({"other_key": 42}))
        assert worker._is_enabled() is True

    def test_enabled_config_corrupt_json(self, tmp_path):
        """Corrupt JSON → error caught, returns True (default)."""
        worker = _make_worker(tmp_path)
        worker.config_path.parent.mkdir(parents=True, exist_ok=True)
        worker.config_path.write_text("{{{not valid json")
        assert worker._is_enabled() is True

    def test_enabled_config_os_error(self, tmp_path):
        """OSError reading config → returns True (default)."""
        worker = _make_worker(tmp_path)
        with patch.object(Path, "exists", return_value=True), \
             patch("builtins.open", side_effect=OSError("permission denied")):
            assert worker._is_enabled() is True

    def test_disabled_when_worker_enabled_false(self, tmp_path):
        """enabled=true but worker_enabled=false disables worker loop."""
        worker = _make_worker(tmp_path)
        worker.config_path.parent.mkdir(parents=True, exist_ok=True)
        worker.config_path.write_text(json.dumps({"enabled": True, "worker_enabled": False}))
        assert worker._is_enabled() is False

    def test_runtime_refresh_updates_worker_fields(self, tmp_path):
        """Runtime config refresh mutates interval/max time."""
        worker = _make_worker(tmp_path)
        worker.config_path.parent.mkdir(parents=True, exist_ok=True)
        worker.config_path.write_text(
            json.dumps(
                {
                    "enabled": True,
                    "worker_enabled": True,
                    "heartbeat_interval_seconds": 13,
                    "max_processing_time_seconds": 42,
                }
            )
        )

        assert worker._is_enabled() is True
        assert worker.heartbeat_interval == 13
        assert worker.max_processing_time == 42


# ===========================================================================
# _process_cycle()
# ===========================================================================

class TestProcessCycle:

    async def test_cycle_returns_if_disposed(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker._is_disposed = True
        worker._get_most_recent_unprocessed_query = MagicMock()
        await worker._process_cycle()
        worker._get_most_recent_unprocessed_query.assert_not_called()

    async def test_cycle_returns_if_disabled(self, tmp_path):
        worker = _make_worker(tmp_path)
        worker._is_enabled = MagicMock(return_value=False)
        worker._get_most_recent_unprocessed_query = MagicMock()
        await worker._process_cycle()
        worker._get_most_recent_unprocessed_query.assert_not_called()

    async def test_cycle_returns_if_no_query_db(self, tmp_path):
        worker = _make_worker(tmp_path)
        # query_db_path does not exist (no directory created)
        worker._get_most_recent_unprocessed_query = MagicMock()
        await worker._process_cycle()
        worker._get_most_recent_unprocessed_query.assert_not_called()

    async def test_cycle_returns_if_no_unprocessed_queries(self, tmp_path):
        worker = _make_worker(tmp_path)
        _create_query_db(worker.query_db_path, rows=[])
        worker._process_single_query = AsyncMock()
        await worker._process_cycle()
        worker._process_single_query.assert_not_called()

    async def test_cycle_processes_found_query(self, tmp_path):
        worker = _make_worker(tmp_path)
        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "query": "important query", "timestamp": "2026-02-08T12:00:00"},
        ])
        worker._process_single_query = AsyncMock()
        await worker._process_cycle()
        worker._process_single_query.assert_called_once()
        # Verify the query dict passed
        query_arg = worker._process_single_query.call_args[0][0]
        assert query_arg["query_id"] == "q1"
        assert query_arg["query"] == "important query"


# ===========================================================================
# _get_most_recent_unprocessed_query()
# ===========================================================================

class TestGetMostRecentUnprocessedQuery:

    def test_no_unprocessed_queries(self, tmp_path):
        worker = _make_worker(tmp_path)
        _create_query_db(worker.query_db_path, rows=[])
        result = worker._get_most_recent_unprocessed_query()
        assert result is None

    def test_all_already_processed(self, tmp_path):
        worker = _make_worker(tmp_path)
        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "used_by_agent": 1, "timestamp": "2026-02-08T12:00:00"},
        ])
        result = worker._get_most_recent_unprocessed_query()
        assert result is None

    def test_single_unprocessed_returns_it(self, tmp_path):
        worker = _make_worker(tmp_path)
        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "query": "test query", "timestamp": "2026-02-08T12:00:00", "batch_id": "b1"},
        ])
        result = worker._get_most_recent_unprocessed_query()
        assert result is not None
        assert result["query_id"] == "q1"
        assert result["query"] == "test query"

    def test_multiple_returns_latest_marks_others_stale(self, tmp_path):
        worker = _make_worker(tmp_path)
        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "old1", "query": "old query 1", "timestamp": "2026-02-08T10:00:00", "batch_id": "b1"},
            {"query_id": "old2", "query": "old query 2", "timestamp": "2026-02-08T11:00:00", "batch_id": "b2"},
            {"query_id": "latest", "query": "latest query", "timestamp": "2026-02-08T12:00:00", "batch_id": "b3"},
        ])

        result = worker._get_most_recent_unprocessed_query()
        assert result["query_id"] == "latest"

        # Verify older queries are marked stale (used_by_agent=1)
        rows = _read_rows(worker.query_db_path)
        for row in rows:
            if row["query_id"] != "latest":
                assert row["used_by_agent"] == 1, f"Query {row['query_id']} should be stale"
            else:
                assert row["used_by_agent"] == 0, "Latest query should NOT be stale"

    def test_sqlite_error_returns_none(self, tmp_path):
        worker = _make_worker(tmp_path)
        # Point to a path that will cause a connect error
        worker.query_db_path = tmp_path / "nonexistent_dir" / "nope.db"
        result = worker._get_most_recent_unprocessed_query()
        assert result is None

    def test_returns_all_columns(self, tmp_path):
        worker = _make_worker(tmp_path)
        docs = json.dumps([{"source": "email", "subject": "test"}])
        _create_query_db(worker.query_db_path, rows=[
            {
                "query_id": "q1",
                "query": "check email",
                "source_daemon": "email",
                "day_date": "2026-02-08",
                "context_docs": docs,
                "context_doc_ids": "d1,d2",
                "timestamp": "2026-02-08T14:00:00",
                "batch_id": "b1"
            },
        ])
        result = worker._get_most_recent_unprocessed_query()
        assert result["source_daemon"] == "email"
        assert result["day_date"] == "2026-02-08"
        assert result["context_docs"] == docs
        assert result["context_doc_ids"] == "d1,d2"


# ===========================================================================
# _parse_context_docs()
# ===========================================================================

class TestParseContextDocs:

    def test_valid_json(self, tmp_path):
        worker = _make_worker(tmp_path)
        docs = [{"source": "email", "subject": "test"}]
        result = worker._parse_context_docs(json.dumps(docs))
        assert result == docs

    def test_empty_array(self, tmp_path):
        worker = _make_worker(tmp_path)
        result = worker._parse_context_docs("[]")
        assert result == []

    def test_invalid_json(self, tmp_path):
        worker = _make_worker(tmp_path)
        result = worker._parse_context_docs("{{{invalid")
        assert result == []

    def test_none_input(self, tmp_path):
        worker = _make_worker(tmp_path)
        result = worker._parse_context_docs(None)
        assert result == []

    def test_empty_string(self, tmp_path):
        worker = _make_worker(tmp_path)
        result = worker._parse_context_docs("")
        assert result == []


# ===========================================================================
# _process_single_query()
# ===========================================================================

class TestProcessSingleQuery:

    def _make_query(self, **overrides):
        base = {
            "query_id": "q1",
            "query": "important research question",
            "day_date": "2026-02-08",
            "context_docs": "[]",
            "timestamp": "2026-02-08T12:00:00",
        }
        base.update(overrides)
        return base

    async def test_success_200_defer_decision(self, tmp_path):
        worker = _make_worker(tmp_path)
        result = _agent_result(decision="defer")

        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "timestamp": "2026-02-08T12:00:00", "batch_id": "b1"},
        ])

        worker._emit_proactive_notification = AsyncMock()

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, return_value=result):
            await worker._process_single_query(self._make_query())

        assert worker.processing is False
        worker._emit_proactive_notification.assert_not_called()
        rows = _read_rows(worker.query_db_path)
        assert rows[0]["used_by_agent"] == 1

    async def test_success_200_intervene_emits_notification(self, tmp_path):
        worker = _make_worker(tmp_path, websocket_hub=MagicMock())
        result = _agent_result(
            decision="intervene",
            recommendation="You should check your email about the deadline.",
        )

        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "timestamp": "2026-02-08T12:00:00", "batch_id": "b1"},
        ])

        worker._emit_proactive_notification = AsyncMock()

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, return_value=result):
            await worker._process_single_query(self._make_query())

        assert worker.processing is False
        worker._emit_proactive_notification.assert_called_once()
        call_kwargs = worker._emit_proactive_notification.call_args
        assert call_kwargs[0][0]["decision"] == "intervene"

    async def test_success_200_intervene_no_recommendation_skips_emit(self, tmp_path):
        worker = _make_worker(tmp_path, websocket_hub=MagicMock())
        result = _agent_result(decision="intervene", recommendation="")

        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "timestamp": "2026-02-08T12:00:00", "batch_id": "b1"},
        ])

        worker._emit_proactive_notification = AsyncMock()

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, return_value=result):
            await worker._process_single_query(self._make_query())

        worker._emit_proactive_notification.assert_not_called()

    async def test_non_200_does_not_mark_processed(self, tmp_path):
        worker = _make_worker(tmp_path)

        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "timestamp": "2026-02-08T12:00:00", "batch_id": "b1"},
        ])

        from fastapi import HTTPException, status
        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, side_effect=HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)):
            await worker._process_single_query(self._make_query())

        assert worker.processing is False
        rows = _read_rows(worker.query_db_path)
        assert rows[0]["used_by_agent"] == 0

    async def test_timeout_does_not_mark_processed(self, tmp_path):
        worker = _make_worker(tmp_path)

        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "timestamp": "2026-02-08T12:00:00", "batch_id": "b1"},
        ])

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, side_effect=asyncio.TimeoutError()):
            await worker._process_single_query(self._make_query())

        assert worker.processing is False
        rows = _read_rows(worker.query_db_path)
        assert rows[0]["used_by_agent"] == 0

    async def test_generic_exception_does_not_mark_processed(self, tmp_path):
        worker = _make_worker(tmp_path)

        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "timestamp": "2026-02-08T12:00:00", "batch_id": "b1"},
        ])

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, side_effect=RuntimeError("connection refused")):
            await worker._process_single_query(self._make_query())

        assert worker.processing is False
        rows = _read_rows(worker.query_db_path)
        assert rows[0]["used_by_agent"] == 0

    async def test_processing_flag_set_during_execution(self, tmp_path):
        worker = _make_worker(tmp_path)
        flags_during = []

        result = _agent_result(decision="defer")

        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "timestamp": "2026-02-08T12:00:00", "batch_id": "b1"},
        ])

        original_mark = worker._mark_query_processed

        def capture_flag(*args, **kwargs):
            flags_during.append(worker.processing)
            return original_mark(*args, **kwargs)

        worker._mark_query_processed = capture_flag

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, return_value=result):
            await worker._process_single_query(self._make_query())

        assert flags_during == [True]
        assert worker.processing is False

    async def test_context_docs_parsed_and_sent(self, tmp_path):
        worker = _make_worker(tmp_path)
        docs = [{"source": "email", "subject": "deadline", "timestamp": "2026-02-08T10:00:00"}]
        query = self._make_query(context_docs=json.dumps(docs))

        result = _agent_result(decision="defer")

        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "timestamp": "2026-02-08T12:00:00", "batch_id": "b1"},
        ])

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, return_value=result) as mock_scout:
            await worker._process_single_query(query)

        call_kwargs = mock_scout.call_args.kwargs
        assert call_kwargs["queries"] == ["important research question"]
        assert len(call_kwargs["source_docs"]) == 1
        assert call_kwargs["source_docs"][0]["source"] == "email"

    async def test_posts_to_correct_endpoint(self, tmp_path):
        # N/A anymore because it calls the service directly
        pass


# ===========================================================================
# _mark_query_processed()
# ===========================================================================

class TestMarkQueryProcessed:

    def test_success_marks_processed(self, tmp_path):
        worker = _make_worker(tmp_path)
        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "q1", "used_by_agent": 0, "timestamp": "2026-02-08T12:00:00"},
        ])
        worker._mark_query_processed("q1", "run-abc")
        rows = _read_rows(worker.query_db_path)
        assert rows[0]["used_by_agent"] == 1

    def test_query_not_found_logs_warning(self, tmp_path):
        """Non-existent query_id → rowcount=0 → warning logged."""
        worker = _make_worker(tmp_path)
        _create_query_db(worker.query_db_path, rows=[])
        # Should not raise
        worker._mark_query_processed("nonexistent", "run-xyz")

    def test_sqlite_error_caught(self, tmp_path):
        """SQLite error → caught, no crash."""
        worker = _make_worker(tmp_path)
        worker.query_db_path = tmp_path / "bad_dir" / "nope.db"
        # Should not raise
        worker._mark_query_processed("q1", "run-abc")


# ===========================================================================
# _emit_proactive_notification()
# ===========================================================================

class TestEmitProactiveNotification:

    async def test_no_hub_returns_early(self, tmp_path):
        worker = _make_worker(tmp_path, websocket_hub=None)
        result = _agent_result(recommendation="something important")
        # Should not raise
        await worker._emit_proactive_notification(result)

    async def test_lazy_hub_getter_resolves_and_broadcasts(self, tmp_path):
        """When websocket_hub is None, getter is used at emit time."""
        resolved_hub = MagicMock()
        resolved_hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=None)
        worker._websocket_hub_getter = MagicMock(return_value=resolved_hub)
        result = _agent_result(recommendation="hello world", run_id="r-getter")

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result)

        worker._websocket_hub_getter.assert_called_once()
        assert worker.websocket_hub is resolved_hub
        assert resolved_hub.broadcast_json.call_count == 2
        last_payload = resolved_hub.broadcast_json.call_args_list[-1][0][0]
        assert last_payload["type"] == "proactive:stream-end"

    async def test_no_recommendation_returns_early(self, tmp_path):
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)
        result = _agent_result(recommendation="")
        await worker._emit_proactive_notification(result)
        hub.broadcast_json.assert_not_called()

    async def test_successful_broadcast(self, tmp_path):
        """Full broadcast: 1 single proactive:intervention payload."""
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        recommendation = "Check your email."
        result = _agent_result(recommendation=recommendation, run_id="run-1")

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result)

        calls = hub.broadcast_json.call_args_list
        assert len(calls) == 2
        payload = calls[0][0][0]
        assert payload["type"] == "proactive:stream-chunk"
        assert payload["content"] == recommendation
        assert payload["recommendation"] == recommendation
        
        payload2 = calls[1][0][0]
        assert payload2["type"] == "proactive:stream-end"
        assert payload2["role"] == "proactive"

    async def test_context_email_source(self, tmp_path):
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="Check email", run_id="r1")
        source_docs = [
            {"source": "email", "metadata": {"subject": "Deadline", "from": "boss@co.com"}},
        ]

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result, source_docs=source_docs)

        # Check context in chunk payload
        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        ctx = chunk_payload["context"]
        assert len(ctx["sources"]) == 1
        assert ctx["sources"][0]["type"] == "email"
        assert ctx["sources"][0]["subject"] == "Deadline"
        assert ctx["sources"][0]["from"] == "boss@co.com"

    async def test_context_filesystem_source(self, tmp_path):
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="File changed", run_id="r1")
        source_docs = [
            {"source": "filesystem", "metadata": {"file_name": "report.pdf"}},
        ]

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result, source_docs=source_docs)

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        assert chunk_payload["context"]["sources"][0]["filename"] == "report.pdf"

    async def test_context_filesystem_path_fallback(self, tmp_path):
        """filesystem with path instead of file_name → uses path."""
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="File changed", run_id="r1")
        source_docs = [
            {"source": "filesystem", "metadata": {"path": "/home/user/doc.txt"}},
        ]

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result, source_docs=source_docs)

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        assert chunk_payload["context"]["sources"][0]["filename"] == "/home/user/doc.txt"

    async def test_context_browser_source(self, tmp_path):
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="Check site", run_id="r1")
        source_docs = [
            {"source": "browser", "metadata": {"url": "https://news.com", "title": "News"}},
        ]

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result, source_docs=source_docs)

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        assert chunk_payload["context"]["sources"][0]["url"] == "https://news.com"
        assert chunk_payload["context"]["sources"][0]["title"] == "News"

    async def test_context_active_windows_source(self, tmp_path):
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="Window activity", run_id="r1")
        source_docs = [
            {"source": "active_windows", "metadata": {"window_title": "VS Code"}},
        ]

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result, source_docs=source_docs)

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        assert chunk_payload["context"]["sources"][0]["title"] == "VS Code"

    async def test_context_active_windows_app_name_fallback(self, tmp_path):
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="Window activity", run_id="r1")
        source_docs = [
            {"source": "active_windows", "metadata": {"app_name": "Safari"}},
        ]

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result, source_docs=source_docs)

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        assert chunk_payload["context"]["sources"][0]["title"] == "Safari"

    async def test_context_unknown_source_type(self, tmp_path):
        """Unknown source type → entry has only 'type' key."""
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="Something", run_id="r1")
        source_docs = [
            {"source": "custom_source", "metadata": {"key": "val"}},
        ]

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result, source_docs=source_docs)

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        assert chunk_payload["context"]["sources"][0]["type"] == "custom_source"
        # No url/title/filename/subject/from keys for unknown types
        assert "url" not in chunk_payload["context"]["sources"][0]

    async def test_queries_included_in_context(self, tmp_path):
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="Check this", run_id="r1")

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(
                result, queries=["query1", "query2"],
            )

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        assert chunk_payload["context"]["queries"] == ["query1", "query2"]

    async def test_broadcast_error_caught(self, tmp_path):
        """If broadcast fails, the error is caught gracefully."""
        hub = MagicMock()
        hub.broadcast_json = AsyncMock(side_effect=RuntimeError("WS broadcast failed"))
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="test", run_id="r1")

        with patch("asyncio.sleep", new_callable=AsyncMock):
            # Should not raise exception
            await worker._emit_proactive_notification(result)

        calls = hub.broadcast_json.call_args_list
        assert len(calls) == 1

    async def test_none_source_docs_and_queries(self, tmp_path):
        """source_docs=None and queries=None → empty context."""
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(recommendation="test", run_id="r1")

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(
                result, source_docs=None, queries=None,
            )

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        assert chunk_payload["context"]["sources"] == []
        assert chunk_payload["context"]["queries"] == []

    async def test_previous_query_context_filtered_from_frontend_payload(self, tmp_path):
        """Only triggering logs should be exposed to frontend context."""
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)
        result = _agent_result(recommendation="test", run_id="r1")
        source_docs = [
            {
                "source": "email",
                "metadata": {"_context_type": "triggering_log", "subject": "Now", "from": "a@b.com"},
            },
            {
                "source": "query_gen",
                "metadata": {"_context_type": "previous_query", "query": "old query"},
            },
        ]

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result, source_docs=source_docs)

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        sources = chunk_payload["context"]["sources"]
        assert len(sources) == 1
        assert sources[0]["type"] == "email"

    async def test_legacy_score_fields_not_in_payload(self, tmp_path):
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        result = _agent_result(
            recommendation="test",
            run_id="r1",
        )

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await worker._emit_proactive_notification(result)

        chunk_payload = hub.broadcast_json.call_args_list[0][0][0]
        assert "relevance_score" not in chunk_payload
        assert "high_signal_count" not in chunk_payload


# ===========================================================================
# Integration-style: full _process_cycle with real SQLite
# ===========================================================================

class TestProcessCycleIntegration:

    async def test_full_cycle_with_real_db(self, tmp_path):
        """End-to-end: query in DB → execute_proactive_scout call → mark processed."""
        worker = _make_worker(tmp_path)
        docs = [{"source": "browser", "url": "https://example.com"}]
        _create_query_db(worker.query_db_path, rows=[
            {
                "query_id": "q1",
                "query": "What deadline is coming?",
                "source_daemon": "browser",
                "day_date": "2026-02-08",
                "context_docs": json.dumps(docs),
                "timestamp": "2026-02-08T14:30:00",
            },
        ])

        result = _agent_result(decision="defer")

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, return_value=result):
            await worker._process_cycle()

        # Query should be marked processed
        rows = _read_rows(worker.query_db_path)
        assert len(rows) == 1
        assert rows[0]["used_by_agent"] == 1
        assert worker.processing is False

    async def test_full_cycle_intervene_with_ws(self, tmp_path):
        """End-to-end: intervene decision → WS notification emitted."""
        hub = MagicMock()
        hub.broadcast_json = AsyncMock()
        worker = _make_worker(tmp_path, websocket_hub=hub)

        _create_query_db(worker.query_db_path, rows=[
            {
                "query_id": "q1",
                "query": "What deadline is coming?",
                "timestamp": "2026-02-08T14:30:00",
                "batch_id": "b1"
            },
        ])

        result = _agent_result(
            decision="intervene",
            recommendation="Deadline tomorrow!",
        )

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, return_value=result):
            await worker._process_cycle()

        # WS notifications should have been sent
        assert hub.broadcast_json.call_count > 0
        last_call = hub.broadcast_json.call_args_list[-1][0][0]
        assert last_call["type"] == "proactive:stream-end"

    async def test_multiple_queries_only_latest_processed(self, tmp_path):
        """Multiple unprocessed queries → only latest is used, others staled."""
        worker = _make_worker(tmp_path)
        _create_query_db(worker.query_db_path, rows=[
            {"query_id": "old", "query": "old query", "timestamp": "2026-02-08T10:00:00", "batch_id": "b1"},
            {"query_id": "mid", "query": "mid query", "timestamp": "2026-02-08T11:00:00", "batch_id": "b2"},
            {"query_id": "new", "query": "new query", "timestamp": "2026-02-08T12:00:00", "batch_id": "b3"},
        ])

        result = _agent_result(decision="defer")

        with patch("services.proactive.scout_service.execute_proactive_scout", new_callable=AsyncMock, return_value=result) as mock_scout:
            await worker._process_cycle()

        # Verify the call with the latest query
        call_kwargs = mock_scout.call_args.kwargs
        assert call_kwargs["queries"] == ["new query"]

        # ALL should be marked as used now (old/mid staled, new processed)
        rows = _read_rows(worker.query_db_path)
        assert all(r["used_by_agent"] == 1 for r in rows)
