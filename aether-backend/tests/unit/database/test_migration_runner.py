"""
Tests for data/database/migration_runner.py

Covers: MigrationRunner constructor, run_migrations orchestration,
_ensure_target_database, _ensure_migrations_table, _get_pending_migrations,
_execute_migration, _reload_schema_cache, and module-level run_migrations().

All subprocess/docker calls are mocked — no real container needed.
"""

import subprocess
import os
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from data.database.migration_runner import (
    MigrationRunner,
    run_migrations,
    TARGET_DATABASE,
)

pytestmark = pytest.mark.skipif(
    os.environ.get("SKIP_SERVICE_HEALTH_CHECK") == "1",
    reason="Requires live infrastructure"
)


# ===========================================================================
# Helpers
# ===========================================================================

def _make_runner(migrations_dir=None):
    """Create a MigrationRunner."""
    runner = MigrationRunner()
    if migrations_dir is not None:
        runner.migrations_dir = migrations_dir
    return runner


def _completed(stdout="", stderr="", returncode=0):
    """Build a CompletedProcess stub."""
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_dev_mode(self):
        runner = MigrationRunner()
        assert runner.migrations_dir == Path(__file__).resolve().parent.parent.parent.parent / "data" / "database" / "migrations"

    @patch("data.database.migration_runner.sys")
    def test_frozen_mode(self, mock_sys):
        mock_sys.frozen = True
        mock_sys._MEIPASS = "/tmp/bundle"
        runner = MigrationRunner()
        assert runner.migrations_dir == Path("/tmp/bundle/data/database/migrations")


# ===========================================================================
# _ensure_target_database
# ===========================================================================

class TestEnsureTargetDatabase:

    @patch("subprocess.run")
    async def test_database_exists(self, mock_run):
        runner = _make_runner()
        mock_run.return_value = _completed(stdout="  1\n")
        await runner._ensure_target_database()
        assert mock_run.call_count == 2  # 2 checks, no creates

    @patch("subprocess.run")
    async def test_database_created(self, mock_run):
        runner = _make_runner()
        # 1st call: aether check (empty = doesn't exist), 2nd call: aether create
        # 3rd call: _supabase check (empty), 4th call: _supabase create
        mock_run.side_effect = [
            _completed(stdout=""),
            _completed(),
            _completed(stdout=""),
            _completed(),
        ]
        await runner._ensure_target_database()
        assert mock_run.call_count == 4

    @patch("data.database.migration_runner.TARGET_DATABASE", "postgres")
    async def test_postgres_noop(self):
        runner = _make_runner()
        # Should return immediately, no subprocess
        await runner._ensure_target_database()

    @patch("subprocess.run")
    async def test_subprocess_error(self, mock_run):
        runner = _make_runner()
        mock_run.side_effect = subprocess.CalledProcessError(
            1, "psql", stderr="connection refused"
        )
        with pytest.raises(subprocess.CalledProcessError):
            await runner._ensure_target_database()

    @patch("subprocess.run")
    async def test_generic_error(self, mock_run):
        runner = _make_runner()
        mock_run.side_effect = OSError("docker not found")
        with pytest.raises(OSError):
            await runner._ensure_target_database()


# ===========================================================================
# _ensure_migrations_table
# ===========================================================================

class TestEnsureMigrationsTable:

    @patch("subprocess.run")
    async def test_success(self, mock_run):
        runner = _make_runner()
        mock_run.return_value = _completed()
        await runner._ensure_migrations_table()
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        assert "-d" in args
        idx = args.index("-d")
        assert args[idx + 1] == TARGET_DATABASE

    @patch("subprocess.run")
    async def test_called_process_error(self, mock_run):
        runner = _make_runner()
        mock_run.side_effect = subprocess.CalledProcessError(
            1, "psql", stderr="permission denied"
        )
        with pytest.raises(subprocess.CalledProcessError):
            await runner._ensure_migrations_table()

    @patch("subprocess.run")
    async def test_generic_error(self, mock_run):
        runner = _make_runner()
        mock_run.side_effect = RuntimeError("unexpected")
        with pytest.raises(RuntimeError):
            await runner._ensure_migrations_table()

    @patch("data.database.migration_runner.TARGET_DATABASE", "wrong_db")
    @patch("subprocess.run")
    async def test_invalid_target_raises(self, mock_run):
        runner = _make_runner()
        with pytest.raises(ValueError, match="CRITICAL"):
            await runner._ensure_migrations_table()


# ===========================================================================
# _get_pending_migrations
# ===========================================================================

class TestGetPendingMigrations:

    async def test_no_migrations_dir(self, tmp_path):
        runner = _make_runner(migrations_dir=tmp_path / "nonexistent")
        result = await runner._get_pending_migrations()
        assert result == []

    async def test_empty_dir(self, tmp_path):
        runner = _make_runner(migrations_dir=tmp_path)
        result = await runner._get_pending_migrations()
        assert result == []

    @patch("subprocess.run")
    async def test_all_pending(self, mock_run, tmp_path):
        # Create migration files
        (tmp_path / "001_init.sql").write_text("CREATE TABLE x;")
        (tmp_path / "002_add_col.sql").write_text("ALTER TABLE x ADD COLUMN y;")
        runner = _make_runner(migrations_dir=tmp_path)

        # No applied versions
        mock_run.return_value = _completed(stdout="")
        result = await runner._get_pending_migrations()
        assert len(result) == 2
        assert result[0][1] == "001_init"
        assert result[1][1] == "002_add_col"

    @patch("subprocess.run")
    async def test_some_already_applied(self, mock_run, tmp_path):
        (tmp_path / "001_init.sql").write_text("CREATE TABLE x;")
        (tmp_path / "002_add_col.sql").write_text("ALTER;")
        runner = _make_runner(migrations_dir=tmp_path)

        mock_run.return_value = _completed(stdout="  001_init  \n")
        result = await runner._get_pending_migrations()
        assert len(result) == 1
        assert result[0][1] == "002_add_col"

    @patch("subprocess.run")
    async def test_template_files_excluded(self, mock_run, tmp_path):
        (tmp_path / "001_init.sql").write_text("x")
        (tmp_path / "002_add.template").write_text("skip")
        (tmp_path / ".hidden.sql").write_text("skip")
        (tmp_path / "003_TEMPLATE_skip.sql").write_text("skip")
        runner = _make_runner(migrations_dir=tmp_path)

        mock_run.return_value = _completed(stdout="")
        result = await runner._get_pending_migrations()
        assert len(result) == 1

    @patch("subprocess.run")
    async def test_query_fails_returns_all(self, mock_run, tmp_path):
        (tmp_path / "001_init.sql").write_text("x")
        runner = _make_runner(migrations_dir=tmp_path)

        mock_run.return_value = _completed(stdout="", returncode=1)
        result = await runner._get_pending_migrations()
        assert len(result) == 1

    @patch("subprocess.run")
    async def test_subprocess_exception_returns_all(self, mock_run, tmp_path):
        (tmp_path / "001_init.sql").write_text("x")
        runner = _make_runner(migrations_dir=tmp_path)

        mock_run.side_effect = OSError("docker not available")
        result = await runner._get_pending_migrations()
        assert len(result) == 1

    @patch("subprocess.run")
    async def test_sorted_order(self, mock_run, tmp_path):
        (tmp_path / "003_c.sql").write_text("c")
        (tmp_path / "001_a.sql").write_text("a")
        (tmp_path / "002_b.sql").write_text("b")
        runner = _make_runner(migrations_dir=tmp_path)

        mock_run.return_value = _completed(stdout="")
        result = await runner._get_pending_migrations()
        names = [name for _, name in result]
        assert names == ["001_a", "002_b", "003_c"]


# ===========================================================================
# _execute_migration
# ===========================================================================

class TestExecuteMigration:

    @patch("subprocess.run")
    async def test_success(self, mock_run, tmp_path):
        runner = _make_runner()
        mig_file = tmp_path / "001_init.sql"
        mig_file.write_text("CREATE TABLE test;")

        mock_run.return_value = _completed(stdout="CREATE TABLE")
        await runner._execute_migration(mig_file, "001_init")
        # docker cp + psql -f + psql -c (record)
        assert mock_run.call_count == 3

    @patch("subprocess.run")
    async def test_success_no_stdout(self, mock_run, tmp_path):
        runner = _make_runner()
        mig_file = tmp_path / "001_init.sql"
        mig_file.write_text("CREATE TABLE test;")

        mock_run.return_value = _completed(stdout="")
        await runner._execute_migration(mig_file, "001_init")
        assert mock_run.call_count == 3

    @patch("subprocess.run")
    async def test_docker_cp_failure(self, mock_run, tmp_path):
        runner = _make_runner()
        mig_file = tmp_path / "001_init.sql"
        mig_file.write_text("x")

        mock_run.side_effect = subprocess.CalledProcessError(1, "docker cp", stderr="no such container")
        with pytest.raises(Exception, match="001_init failed"):
            await runner._execute_migration(mig_file, "001_init")

    @patch("subprocess.run")
    async def test_timeout(self, mock_run, tmp_path):
        runner = _make_runner()
        mig_file = tmp_path / "001_init.sql"
        mig_file.write_text("x")

        mock_run.side_effect = subprocess.TimeoutExpired("psql", 120)
        with pytest.raises(Exception, match="timed out"):
            await runner._execute_migration(mig_file, "001_init")


# ===========================================================================
# _reload_schema_cache
# ===========================================================================

class TestReloadSchemaCache:

    @patch("asyncio.sleep", new_callable=AsyncMock)
    @patch("subprocess.run")
    async def test_success(self, mock_run, mock_sleep):
        runner = _make_runner()
        mock_run.return_value = _completed()
        await runner._reload_schema_cache()
        mock_run.assert_called_once()
        mock_sleep.assert_awaited_once_with(2)

    @patch("asyncio.sleep", new_callable=AsyncMock)
    @patch("subprocess.run")
    async def test_failure_non_fatal(self, mock_run, mock_sleep):
        runner = _make_runner()
        mock_run.side_effect = subprocess.CalledProcessError(1, "psql", stderr="error")
        # Should not raise — just warns
        await runner._reload_schema_cache()


# ===========================================================================
# run_migrations (orchestration)
# ===========================================================================

class TestRunMigrations:

    @patch.object(MigrationRunner, "_reload_schema_cache", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_execute_migration", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_get_pending_migrations", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_ensure_migrations_table", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_ensure_target_database", new_callable=AsyncMock)
    async def test_no_pending(self, m_ensure_db, m_ensure_tbl, m_pending, m_exec, m_reload):
        runner = _make_runner()
        m_pending.return_value = []
        result = await runner.run_migrations()
        assert result is True
        m_reload.assert_not_awaited()

    @patch.object(MigrationRunner, "_reload_schema_cache", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_execute_migration", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_get_pending_migrations", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_ensure_migrations_table", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_ensure_target_database", new_callable=AsyncMock)
    async def test_applies_pending(self, m_ensure_db, m_ensure_tbl, m_pending, m_exec, m_reload):
        runner = _make_runner()
        m_pending.return_value = [
            (Path("001.sql"), "001_init"),
            (Path("002.sql"), "002_add"),
        ]
        result = await runner.run_migrations()
        assert result is True
        assert m_exec.await_count == 2
        m_reload.assert_awaited_once()

    @patch.object(MigrationRunner, "_reload_schema_cache", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_execute_migration", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_get_pending_migrations", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_ensure_migrations_table", new_callable=AsyncMock)
    @patch.object(MigrationRunner, "_ensure_target_database", new_callable=AsyncMock)
    async def test_migration_failure_stops(self, m_ensure_db, m_ensure_tbl, m_pending, m_exec, m_reload):
        runner = _make_runner()
        m_pending.return_value = [
            (Path("001.sql"), "001_init"),
            (Path("002.sql"), "002_add"),
        ]
        m_exec.side_effect = [None, Exception("SQL error")]
        result = await runner.run_migrations()
        assert result is False
        m_reload.assert_not_awaited()

    @patch.object(MigrationRunner, "_ensure_target_database", new_callable=AsyncMock)
    async def test_ensure_db_failure(self, m_ensure_db):
        runner = _make_runner()
        m_ensure_db.side_effect = RuntimeError("docker down")
        result = await runner.run_migrations()
        assert result is False


# ===========================================================================
# Module-level run_migrations()
# ===========================================================================

class TestModuleLevelRunMigrations:

    @patch.object(MigrationRunner, "run_migrations", new_callable=AsyncMock)
    async def test_delegates(self, mock_run):
        mock_run.return_value = True
        result = await run_migrations()
        assert result is True
        mock_run.assert_awaited_once()

    @patch.object(MigrationRunner, "run_migrations", new_callable=AsyncMock)
    async def test_failure(self, mock_run):
        mock_run.return_value = False
        result = await run_migrations()
        assert result is False
