"""
Unit Tests: Inter-daemon signal mechanism (FILE_INDEX_SIGNAL_FILE).

Covers:
- Constant definition in services.daemons.__init__
- FileSystemDaemon._signal_file_index_daemon (emit side)
- FileIndexingDaemon._check_file_index_signal (consume side)
- FileIndexingDaemon._scan_primary_locations (primary-only filter)
- Rate-limiting and concurrency guards on both sides

All filesystem + database interactions are mocked -- tests never touch real files or Supabase.
"""

import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from services.daemons import FILE_INDEX_SIGNAL_FILE, QUERY_GEN_SIGNAL_FILE


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def fs_daemon():
    """Create a FileSystemDaemon with fully mocked dependencies."""
    from services.daemons.filesystem.daemon import FileSystemDaemon

    config = MagicMock()
    config.watch_locations = ["/tmp/primary"]
    config.db_path = Path("/tmp/test_fs.db")
    config.app_root = Path("/tmp/test_app")
    config.debounce_seconds = 2
    config.retention_days = 1
    config.bm25_index_interval_seconds = 30

    with patch("services.daemons.filesystem.daemon.FileSystemDB"):
        with patch("services.daemons.filesystem.daemon.Observer"):
            daemon = FileSystemDaemon(config)

    return daemon


@pytest.fixture
def fi_daemon():
    """Create a FileIndexingDaemon with mocked config and repository."""
    from services.daemons.file_indexing.daemon import FileIndexingDaemon

    config = MagicMock()
    config.heartbeat_interval_seconds = 30
    config.log_file = None
    config.log_level = "INFO"
    config.aether_rag_embedding_model = "test-model"
    config.aether_rag_embedding_api_base = "http://localhost:3000/api"
    config.aether_rag_embedding_api_key = "not-needed"
    config.aether_rag_enable_bm25 = True

    daemon = FileIndexingDaemon(config)
    daemon.repository = AsyncMock()
    daemon.aether_rag_manager = MagicMock()
    daemon.scheduler = MagicMock()
    return daemon


# ─── Constants ───────────────────────────────────────────────────────────────


class TestSignalFileConstants:
    """Verify signal file constants are defined and distinct."""

    def test_file_index_signal_file_is_path(self):
        assert isinstance(FILE_INDEX_SIGNAL_FILE, Path)

    def test_query_gen_signal_file_is_path(self):
        assert isinstance(QUERY_GEN_SIGNAL_FILE, Path)

    def test_signal_files_are_distinct(self):
        assert FILE_INDEX_SIGNAL_FILE != QUERY_GEN_SIGNAL_FILE

    def test_file_index_signal_resolves_to_absolute(self):
        assert FILE_INDEX_SIGNAL_FILE.is_absolute()

    def test_file_index_signal_has_expected_name(self):
        assert "file_index_signal" in FILE_INDEX_SIGNAL_FILE.name


# ─── FileSystemDaemon._signal_file_index_daemon ─────────────────────────────


class TestFileSystemDaemonSignalEmit:
    """Tests for the filesystem daemon's signal emission to file indexing daemon."""

    def test_signals_when_unprocessed_above_threshold(self, fs_daemon):
        fs_daemon.db.get_unprocessed_count.return_value = 3
        fs_daemon._has_signaled_file_index = False
        fs_daemon._last_file_index_signal_ts = 0.0

        mock_path = MagicMock()
        with patch("services.daemons.filesystem.daemon.FILE_INDEX_SIGNAL_FILE", mock_path):
            fs_daemon._signal_file_index_daemon()

        mock_path.touch.assert_called_once()
        assert fs_daemon._has_signaled_file_index is True

    def test_does_not_signal_within_rate_limit(self, fs_daemon):
        fs_daemon.db.get_unprocessed_count.return_value = 5
        fs_daemon._has_signaled_file_index = False
        fs_daemon._last_file_index_signal_ts = time.monotonic()

        mock_path = MagicMock()
        with patch("services.daemons.filesystem.daemon.FILE_INDEX_SIGNAL_FILE", mock_path):
            fs_daemon._signal_file_index_daemon()

        mock_path.touch.assert_not_called()

    def test_does_not_signal_when_already_signaled(self, fs_daemon):
        fs_daemon.db.get_unprocessed_count.return_value = 2
        fs_daemon._has_signaled_file_index = True
        fs_daemon._last_file_index_signal_ts = 0.0

        mock_path = MagicMock()
        with patch("services.daemons.filesystem.daemon.FILE_INDEX_SIGNAL_FILE", mock_path):
            fs_daemon._signal_file_index_daemon()

        mock_path.touch.assert_not_called()

    def test_resets_flag_when_count_drops_below_threshold(self, fs_daemon):
        fs_daemon.db.get_unprocessed_count.return_value = 0
        fs_daemon._has_signaled_file_index = True
        fs_daemon._last_file_index_signal_ts = 0.0

        with patch("services.daemons.filesystem.daemon.FILE_INDEX_SIGNAL_FILE", MagicMock()):
            fs_daemon._signal_file_index_daemon()

        assert fs_daemon._has_signaled_file_index is False

    def test_does_not_signal_when_zero_unprocessed(self, fs_daemon):
        fs_daemon.db.get_unprocessed_count.return_value = 0
        fs_daemon._has_signaled_file_index = False
        fs_daemon._last_file_index_signal_ts = 0.0

        mock_path = MagicMock()
        with patch("services.daemons.filesystem.daemon.FILE_INDEX_SIGNAL_FILE", mock_path):
            fs_daemon._signal_file_index_daemon()

        mock_path.touch.assert_not_called()

    def test_handles_exception_gracefully(self, fs_daemon):
        fs_daemon.db.get_unprocessed_count.side_effect = RuntimeError("db down")
        fs_daemon._has_signaled_file_index = False
        fs_daemon._last_file_index_signal_ts = 0.0

        with patch("services.daemons.filesystem.daemon.FILE_INDEX_SIGNAL_FILE", MagicMock()):
            fs_daemon._signal_file_index_daemon()

    def test_records_timestamp_after_signal(self, fs_daemon):
        fs_daemon.db.get_unprocessed_count.return_value = 1
        fs_daemon._has_signaled_file_index = False
        fs_daemon._last_file_index_signal_ts = 0.0
        before = time.monotonic()

        with patch("services.daemons.filesystem.daemon.FILE_INDEX_SIGNAL_FILE", MagicMock()):
            fs_daemon._signal_file_index_daemon()

        assert fs_daemon._last_file_index_signal_ts >= before


# ─── FileIndexingDaemon._check_file_index_signal ────────────────────────────


class TestFileIndexingDaemonSignalConsume:
    """Tests for the file indexing daemon's signal consumption."""

    @pytest.mark.asyncio
    async def test_triggers_scan_when_signal_exists(self, fi_daemon):
        fi_daemon._last_signal_scan_ts = 0.0

        mock_path = MagicMock()
        mock_path.exists.return_value = True

        with patch("services.daemons.file_indexing.daemon.FILE_INDEX_SIGNAL_FILE", mock_path), \
             patch.object(fi_daemon, "_scan_primary_locations", new_callable=AsyncMock) as mock_scan:
            await fi_daemon._check_file_index_signal()

        mock_scan.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_skips_when_no_signal_file(self, fi_daemon):
        mock_path = MagicMock()
        mock_path.exists.return_value = False

        with patch("services.daemons.file_indexing.daemon.FILE_INDEX_SIGNAL_FILE", mock_path), \
             patch.object(fi_daemon, "_scan_primary_locations", new_callable=AsyncMock) as mock_scan:
            await fi_daemon._check_file_index_signal()

        mock_scan.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_skips_within_rate_limit(self, fi_daemon):
        fi_daemon._last_signal_scan_ts = time.monotonic()

        mock_path = MagicMock()
        mock_path.exists.return_value = True

        with patch("services.daemons.file_indexing.daemon.FILE_INDEX_SIGNAL_FILE", mock_path), \
             patch.object(fi_daemon, "_scan_primary_locations", new_callable=AsyncMock) as mock_scan:
            await fi_daemon._check_file_index_signal()

        mock_scan.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unlinks_signal_file_before_scan(self, fi_daemon):
        fi_daemon._last_signal_scan_ts = 0.0
        call_order = []

        mock_path = MagicMock()
        mock_path.exists.return_value = True
        mock_path.unlink = MagicMock(side_effect=lambda **kw: call_order.append("unlink"))

        async def fake_scan():
            call_order.append("scan")

        with patch("services.daemons.file_indexing.daemon.FILE_INDEX_SIGNAL_FILE", mock_path), \
             patch.object(fi_daemon, "_scan_primary_locations", new_callable=AsyncMock,
                         side_effect=fake_scan):
            await fi_daemon._check_file_index_signal()

        assert call_order == ["unlink", "scan"]

    @pytest.mark.asyncio
    async def test_updates_timestamp_after_scan(self, fi_daemon):
        fi_daemon._last_signal_scan_ts = 0.0
        before = time.monotonic()

        mock_path = MagicMock()
        mock_path.exists.return_value = True

        with patch("services.daemons.file_indexing.daemon.FILE_INDEX_SIGNAL_FILE", mock_path), \
             patch.object(fi_daemon, "_scan_primary_locations", new_callable=AsyncMock):
            await fi_daemon._check_file_index_signal()

        assert fi_daemon._last_signal_scan_ts >= before

    @pytest.mark.asyncio
    async def test_skips_when_lock_held(self, fi_daemon):
        fi_daemon._last_signal_scan_ts = 0.0

        mock_path = MagicMock()
        mock_path.exists.return_value = True

        async with fi_daemon._signal_scan_lock:
            with patch("services.daemons.file_indexing.daemon.FILE_INDEX_SIGNAL_FILE", mock_path), \
                 patch.object(fi_daemon, "_scan_primary_locations", new_callable=AsyncMock) as mock_scan:
                await fi_daemon._check_file_index_signal()

        mock_scan.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_handles_exception_gracefully(self, fi_daemon):
        fi_daemon._last_signal_scan_ts = 0.0

        mock_path = MagicMock()
        mock_path.exists.side_effect = OSError("permission denied")

        with patch("services.daemons.file_indexing.daemon.FILE_INDEX_SIGNAL_FILE", mock_path):
            await fi_daemon._check_file_index_signal()


# ─── FileIndexingDaemon._scan_primary_locations ──────────────────────────────


class TestScanPrimaryLocations:
    """Tests for primary-only location filtering in signal-triggered scans."""

    @pytest.mark.asyncio
    async def test_scans_only_primary_locations(self, fi_daemon):
        fi_daemon.repository.get_all_locations.return_value = [
            {"id": "loc-1", "location_name": "Primary", "location_type": "primary",
             "root_path": "/tmp/primary", "allowed_extensions": [], "exclude_patterns": [],
             "scan_interval_minutes": 60, "chunk_size": 512, "chunk_overlap": 50,
             "chunk_count": 0, "index_size_bytes": 0, "index_directory": "/tmp/idx",
             "index_name": "primary"},
            {"id": "loc-2", "location_name": "Secondary", "location_type": "secondary",
             "root_path": "/tmp/secondary", "allowed_extensions": [], "exclude_patterns": [],
             "scan_interval_minutes": 120, "chunk_size": 512, "chunk_overlap": 50,
             "chunk_count": 0, "index_size_bytes": 0, "index_directory": "/tmp/idx",
             "index_name": "secondary"},
        ]

        with patch.object(fi_daemon, "_scan_location", new_callable=AsyncMock) as mock_scan:
            await fi_daemon._scan_primary_locations()

        mock_scan.assert_awaited_once()
        scanned_loc = mock_scan.call_args[0][0]
        assert scanned_loc["location_type"] == "primary"
        assert scanned_loc["id"] == "loc-1"

    @pytest.mark.asyncio
    async def test_handles_no_primary_locations(self, fi_daemon):
        fi_daemon.repository.get_all_locations.return_value = [
            {"id": "loc-2", "location_name": "Secondary", "location_type": "secondary"},
        ]

        with patch.object(fi_daemon, "_scan_location", new_callable=AsyncMock) as mock_scan:
            await fi_daemon._scan_primary_locations()

        mock_scan.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_handles_empty_locations(self, fi_daemon):
        fi_daemon.repository.get_all_locations.return_value = []

        with patch.object(fi_daemon, "_scan_location", new_callable=AsyncMock) as mock_scan:
            await fi_daemon._scan_primary_locations()

        mock_scan.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_handles_repository_failure(self, fi_daemon):
        fi_daemon.repository.get_all_locations.side_effect = RuntimeError("db error")

        await fi_daemon._scan_primary_locations()

    @pytest.mark.asyncio
    async def test_scans_multiple_primary_locations(self, fi_daemon):
        fi_daemon.repository.get_all_locations.return_value = [
            {"id": "loc-1", "location_name": "Primary 1", "location_type": "primary",
             "root_path": "/a", "allowed_extensions": [], "exclude_patterns": [],
             "scan_interval_minutes": 60, "chunk_size": 512, "chunk_overlap": 50,
             "chunk_count": 0, "index_size_bytes": 0, "index_directory": "/tmp",
             "index_name": "idx1"},
            {"id": "loc-3", "location_name": "Primary 2", "location_type": "primary",
             "root_path": "/b", "allowed_extensions": [], "exclude_patterns": [],
             "scan_interval_minutes": 60, "chunk_size": 512, "chunk_overlap": 50,
             "chunk_count": 0, "index_size_bytes": 0, "index_directory": "/tmp",
             "index_name": "idx2"},
            {"id": "loc-2", "location_name": "Secondary", "location_type": "secondary"},
        ]

        with patch.object(fi_daemon, "_scan_location", new_callable=AsyncMock) as mock_scan:
            await fi_daemon._scan_primary_locations()

        assert mock_scan.await_count == 2
        scanned_types = [call.args[0]["location_type"] for call in mock_scan.call_args_list]
        assert all(t == "primary" for t in scanned_types)
