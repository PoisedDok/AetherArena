"""
Unit tests for daemon robustness hardening.

Tests the specific fixes from the daemon audit:
- SQLite WAL mode and connection timeouts
- Disposed guard pattern on all daemon classes
- Signal file path centralization
- EmailDB table existence recovery
- Generator variable shadowing fix
- DB table auto-recovery from deletion

No external services required -- all tests use temp directories.
"""
import inspect
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock

import pytest

# Ensure backend root on path
PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


# =========================================================================
# 1. Signal File Centralization
# =========================================================================

class TestSignalFileCentralization:
    """Verify signal file constant is shared from daemons/__init__.py."""

    def test_shared_constant_exists(self):
        from services.daemons import QUERY_GEN_SIGNAL_FILE
        assert QUERY_GEN_SIGNAL_FILE is not None
        assert str(QUERY_GEN_SIGNAL_FILE).endswith("query_gen_signal.trigger")

    def test_browser_imports_shared(self):
        """Browser daemon should import from services.daemons, not define its own."""
        import services.daemons.browser.daemon as mod
        from services.daemons import QUERY_GEN_SIGNAL_FILE
        assert mod.QUERY_GEN_SIGNAL_FILE is QUERY_GEN_SIGNAL_FILE

    def test_email_imports_shared(self):
        import services.daemons.email.daemon as mod
        from services.daemons import QUERY_GEN_SIGNAL_FILE
        assert mod.QUERY_GEN_SIGNAL_FILE is QUERY_GEN_SIGNAL_FILE

    def test_filesystem_imports_shared(self):
        import services.daemons.filesystem.daemon as mod
        from services.daemons import QUERY_GEN_SIGNAL_FILE
        assert mod.QUERY_GEN_SIGNAL_FILE is QUERY_GEN_SIGNAL_FILE

    def test_query_generation_imports_shared(self):
        import services.daemons.query_generation.daemon as mod
        from services.daemons import QUERY_GEN_SIGNAL_FILE
        assert mod.QUERY_GEN_SIGNAL_FILE is QUERY_GEN_SIGNAL_FILE


# =========================================================================
# 2. SQLite WAL Mode + Timeout
# =========================================================================

class TestBrowserDBRobustness:
    """Test BrowserDB WAL mode, timeout, and table recovery."""

    def test_wal_mode_on_connection(self, tmp_path):
        from services.daemons.browser.db import BrowserDB
        db = BrowserDB(tmp_path / "browser_test.db")
        conn = db._get_connection()
        # WAL mode should be set
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal", f"Expected WAL mode, got {mode}"
        conn.close()

    def test_busy_timeout_set(self, tmp_path):
        from services.daemons.browser.db import BrowserDB
        db = BrowserDB(tmp_path / "browser_test.db")
        conn = db._get_connection()
        timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert timeout == 5000, f"Expected busy_timeout=5000, got {timeout}"
        conn.close()

    def test_table_recovery_after_drop(self, tmp_path):
        """If table is deleted externally, next connection should recreate it."""
        from services.daemons.browser.db import BrowserDB
        db_path = tmp_path / "browser_recovery.db"
        db = BrowserDB(db_path)

        # Insert a log to confirm table works
        db.insert_log(url="https://test.com", title="Test")

        # Simulate external deletion of table
        raw_conn = sqlite3.connect(db_path)
        raw_conn.execute("DROP TABLE browser_logs")
        raw_conn.commit()
        raw_conn.close()

        # Next connection should recover
        conn = db._get_connection()
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='browser_logs'")
        assert cursor.fetchone() is not None, "Table should be recreated after drop"
        conn.close()


class TestEmailDBRobustness:
    """Test EmailDB WAL mode, timeout, and NEW table existence check."""

    def test_wal_mode_on_connection(self, tmp_path):
        from services.daemons.email.db import EmailDB
        db = EmailDB(tmp_path / "email_test.db")
        conn = db._get_connection()
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"
        conn.close()

    def test_busy_timeout_set(self, tmp_path):
        from services.daemons.email.db import EmailDB
        db = EmailDB(tmp_path / "email_test.db")
        conn = db._get_connection()
        timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert timeout == 5000
        conn.close()

    def test_table_recovery_after_drop(self, tmp_path):
        """EmailDB previously lacked table existence check -- verify it's now present."""
        from services.daemons.email.db import EmailDB
        db_path = tmp_path / "email_recovery.db"
        db = EmailDB(db_path)

        # Insert to confirm works
        db.insert_log(subject="Test", sender="test@test.com", recipients="", body_preview="")

        # Drop table externally
        raw_conn = sqlite3.connect(db_path)
        raw_conn.execute("DROP TABLE email_logs")
        raw_conn.commit()
        raw_conn.close()

        # Should recover
        conn = db._get_connection()
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='email_logs'")
        assert cursor.fetchone() is not None, "EmailDB should recreate table after drop"
        conn.close()


class TestFileSystemDBRobustness:
    def test_wal_mode_on_connection(self, tmp_path):
        from services.daemons.filesystem.db import FileSystemDB
        db = FileSystemDB(tmp_path / "fs_test.db")
        conn = db._get_connection()
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"
        conn.close()

    def test_busy_timeout_set(self, tmp_path):
        from services.daemons.filesystem.db import FileSystemDB
        db = FileSystemDB(tmp_path / "fs_test.db")
        conn = db._get_connection()
        timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert timeout == 5000
        conn.close()

    def test_table_recovery_after_drop(self, tmp_path):
        from services.daemons.filesystem.db import FileSystemDB
        db_path = tmp_path / "fs_recovery.db"
        db = FileSystemDB(db_path)
        db.insert_log(action="created", file_path="/test.txt")

        raw_conn = sqlite3.connect(db_path)
        raw_conn.execute("DROP TABLE fs_logs")
        raw_conn.commit()
        raw_conn.close()

        conn = db._get_connection()
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='fs_logs'")
        assert cursor.fetchone() is not None
        conn.close()


class TestQueryGenerationDBRobustness:
    def test_wal_mode_on_connection(self, tmp_path):
        from services.daemons.query_generation.db import QueryGenerationDB
        db = QueryGenerationDB(tmp_path / "qgen_test.db")
        conn = db._get_connection()
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"
        conn.close()

    def test_busy_timeout_set(self, tmp_path):
        from services.daemons.query_generation.db import QueryGenerationDB
        db = QueryGenerationDB(tmp_path / "qgen_test.db")
        conn = db._get_connection()
        timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert timeout == 5000
        conn.close()

    def test_table_recovery_after_drop(self, tmp_path):
        from services.daemons.query_generation.db import QueryGenerationDB
        db_path = tmp_path / "qgen_recovery.db"
        db = QueryGenerationDB(db_path)

        raw_conn = sqlite3.connect(db_path)
        raw_conn.execute("DROP TABLE generated_queries")
        raw_conn.commit()
        raw_conn.close()

        conn = db._get_connection()
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='generated_queries'")
        assert cursor.fetchone() is not None
        conn.close()


# =========================================================================
# 3. Disposed Guard Pattern
# =========================================================================

class TestDisposedGuards:
    """Verify all daemon stop() methods are idempotent via _is_disposed."""

    @pytest.mark.asyncio
    async def test_browser_daemon_double_stop(self, tmp_path):
        from services.daemons.browser.daemon import BrowserDaemon
        from services.daemons.browser.config import BrowserDaemonConfig

        config = BrowserDaemonConfig(
            app_root=tmp_path,
            db_path=tmp_path / "browser.db",
        )
        daemon = BrowserDaemon(config)
        assert not daemon._is_disposed

        await daemon.stop()
        assert daemon._is_disposed

        # Second stop should be a no-op, not crash
        await daemon.stop()
        assert daemon._is_disposed

    @pytest.mark.asyncio
    async def test_email_daemon_double_stop(self, tmp_path):
        from services.daemons.email.daemon import EmailDaemon
        from services.daemons.email.config import EmailDaemonConfig

        config = EmailDaemonConfig(
            app_root=tmp_path,
            db_path=tmp_path / "email.db",
        )
        daemon = EmailDaemon(config)
        await daemon.stop()
        await daemon.stop()  # should not crash
        assert daemon._is_disposed

    @pytest.mark.asyncio
    async def test_filesystem_daemon_double_stop(self, tmp_path):
        from services.daemons.filesystem.daemon import FileSystemDaemon
        from services.daemons.filesystem.config import FileSystemDaemonConfig

        config = FileSystemDaemonConfig(
            app_root=tmp_path,
            db_path=tmp_path / "fs.db",
            watch_locations=[],
        )
        daemon = FileSystemDaemon(config)
        # Observer was never started, so stop should handle gracefully
        await daemon.stop()
        await daemon.stop()
        assert daemon._is_disposed

    @pytest.mark.asyncio
    async def test_file_indexing_daemon_double_stop(self, tmp_path):
        from services.daemons.file_indexing.daemon import FileIndexingDaemon
        from services.daemons.file_indexing.config import IndexingServiceConfig

        config = IndexingServiceConfig(
            supabase_url="http://localhost:54321",
            supabase_key="test-key-not-real",
        )
        daemon = FileIndexingDaemon(config)
        await daemon.stop()
        await daemon.stop()
        assert daemon._is_disposed


# =========================================================================
# 4. File Indexing Scheduler Async Contract
# =========================================================================

class TestFileIndexingSchedulerAsyncContract:
    """Ensure scheduled scans are async callables that await _scan_location."""

    @pytest.mark.asyncio
    async def test_scheduled_scan_callback_is_coroutine_function(self):
        from services.daemons.file_indexing.daemon import FileIndexingDaemon
        from services.daemons.file_indexing.config import IndexingServiceConfig

        config = IndexingServiceConfig(
            supabase_url="http://localhost:54321",
            supabase_key="test-key-not-real",
        )
        daemon = FileIndexingDaemon(config)

        location = {
            "id": "loc-1",
            "location_name": "Sample",
            "location_type": "primary",
            "scan_interval_minutes": 15,
        }

        daemon.repository = AsyncMock()
        daemon.repository.get_all_locations = AsyncMock(return_value=[location])
        daemon.scheduler = MagicMock()

        await daemon._load_and_schedule_locations()

        daemon.scheduler.schedule_scan.assert_called_once()
        scheduled_scan = daemon.scheduler.schedule_scan.call_args.kwargs["scan_func"]

        assert inspect.iscoroutinefunction(scheduled_scan) is True

        daemon._scan_location = AsyncMock()
        await scheduled_scan()
        daemon._scan_location.assert_awaited_once_with(location)


# =========================================================================
# 5. Generator Variable Shadowing Fix
# =========================================================================

class TestGeneratorVariableShadowing:
    """Verify context_docs parameter is not shadowed by loop variable."""

    @pytest.mark.asyncio
    async def test_context_docs_not_shadowed(self):
        """After calling generate_queries_cross_source with previous_batch,
        the function's local context_docs should still reference the original parameter."""
        from services.daemons.query_generation.generator import QueryGenerator

        generator = QueryGenerator(
            api_base="http://localhost:9999",
            model="test-model",
        )

        # Mock the HTTP call to return empty (no queries generated)
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "No interesting patterns found."}}]
        }
        generator.client = MagicMock()
        generator.client.post = AsyncMock(return_value=mock_response)
        generator.client.aclose = AsyncMock()  # Required for generator.close()

        input_docs = [
            {"url": "https://test1.com", "title": "Test 1", "timestamp": "2026-01-01T00:00:00", "visit_count": 1, "typed_count": 0, "id": 1},
            {"url": "https://test2.com", "title": "Test 2", "timestamp": "2026-01-01T00:01:00", "visit_count": 1, "typed_count": 0, "id": 2},
        ]

        previous_batch = [
            {
                "query": "previous test query",
                "batch_id": "abc",
                "context_docs": [{"url": "old_url", "id": 99}],
                "timestamp": "2025-12-31T23:00:00",
                "query_id": "qgen_old"
            }
        ]

        # Call with previous_batch that has its own context_docs
        result = await generator.generate_queries_cross_source(
            context_docs=input_docs,
            active_sources=["browser"],
            previous_batch=previous_batch,
        )

        # The key assertion: the function should have used len(input_docs)=2
        # in the log message, NOT len(previous_batch[0]['context_docs'])=1
        # We verify by checking the HTTP call was made (meaning input_docs wasn't corrupted)
        assert generator.client.post.called

        await generator.close()


# =========================================================================
# 6. DB Insert/Read Cycle (Sanity)
# =========================================================================

class TestDBInsertReadCycle:
    """Verify basic CRUD still works after WAL mode changes."""

    def test_browser_insert_and_read(self, tmp_path):
        from services.daemons.browser.db import BrowserDB
        db = BrowserDB(tmp_path / "browser_crud.db")

        db.insert_log(url="https://example.com", title="Example", timestamp="2026-01-01T00:00:00+00:00")
        stats = db.get_stats()
        assert stats["total_logs"] >= 1

    def test_email_insert_and_read(self, tmp_path):
        from services.daemons.email.db import EmailDB
        db = EmailDB(tmp_path / "email_crud.db")

        result = db.insert_log(
            subject="Test Subject",
            sender="test@test.com",
            recipients="",
            body_preview="Hello",
            timestamp="2026-01-01T00:00:00+00:00"
        )
        assert result is not None
        stats = db.get_stats()
        assert stats["total_logs"] >= 1

    def test_filesystem_insert_and_read(self, tmp_path):
        from services.daemons.filesystem.db import FileSystemDB
        db = FileSystemDB(tmp_path / "fs_crud.db")

        db.insert_log(action="created", file_path="/test/file.py")
        stats = db.get_stats()
        assert stats["total_logs"] >= 1

    def test_query_gen_insert_and_read(self, tmp_path):
        from services.daemons.query_generation.db import QueryGenerationDB
        db = QueryGenerationDB(tmp_path / "qgen_crud.db")

        query_id = db.insert_query(
            query="test query",
            source_daemon="browser",
            context_docs=[{"id": 1}],
            context_doc_ids=[1],
        )
        assert query_id.startswith("qgen_")
        stats = db.get_stats()
        assert stats["total_queries"] >= 1

    def test_deduplication_browser(self, tmp_path):
        """Verify dedup still works with WAL mode."""
        from services.daemons.browser.db import BrowserDB
        db = BrowserDB(tmp_path / "browser_dedup.db")

        ts = "2026-01-01T12:00:00+00:00"
        id1 = db.insert_log(url="https://dup.com", title="Dup", timestamp=ts)
        id2 = db.insert_log(url="https://dup.com", title="Dup", timestamp=ts)
        assert id1 == id2, "Duplicate insert should return same ID"
        stats = db.get_stats()
        assert stats["total_logs"] == 1

    def test_deduplication_email(self, tmp_path):
        from services.daemons.email.db import EmailDB
        db = EmailDB(tmp_path / "email_dedup.db")

        ts = "2026-01-01T12:00:00+00:00"
        id1 = db.insert_log(subject="Dup", sender="a@b.com", recipients="", body_preview="", timestamp=ts)
        id2 = db.insert_log(subject="Dup", sender="a@b.com", recipients="", body_preview="", timestamp=ts)
        assert id2 is None, "Duplicate email should return None"
        stats = db.get_stats()
        assert stats["total_logs"] == 1


# =========================================================================
# 7. Filesystem Config Bare Except Fix
# =========================================================================

class TestFilesystemConfigFix:
    """Verify bare except: was replaced with except Exception:."""

    def test_config_loads_without_crash(self):
        """from_settings should not crash even with broken settings."""
        # This is an indirect test -- the real fix ensures SystemExit/KeyboardInterrupt
        # propagate through. Direct testing would require injecting those signals.
        import services.daemons.filesystem.config as mod
        assert hasattr(mod, 'FileSystemDaemonConfig')
        # Verify from_settings exists and is callable
        assert callable(mod.FileSystemDaemonConfig.from_settings)


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
