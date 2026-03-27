"""
Tests for data/database/repositories/files.py (FileIndexingRepository)

Covers: constructor, Location CRUD (create, get, get_all, update, delete,
update_status, update_stats), File operations (upsert_indexed_file,
get_files_by_location, filter_changed_files), Health operations
(register_service, update_heartbeat, update_service_status, get_service_health),
and misc operations (get_active_reindex_job, get_daemon_config, update_daemon_config).
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from data.database.repositories.files import FileIndexingRepository
from data.database.persistence_gateway import SupabasePersistenceGateway


# ===========================================================================
# Helpers
# ===========================================================================

LOC_ID = uuid4()
FILE_ID = uuid4()
HEALTH_ID = uuid4()

SAMPLE_LOCATION = {
    "id": str(LOC_ID),
    "location_name": "Documents",
    "root_path": "/home/user/docs",
    "location_type": "primary",
    "enabled": True,
    "index_name": "documents",
    "index_directory": "/home/user/docs/.aether_rag_index/documents",
}

SAMPLE_FILE = {
    "id": str(FILE_ID),
    "location_id": str(LOC_ID),
    "file_path": "/home/user/docs/readme.md",
    "file_name": "readme.md",
    "file_size": 1024,
    "file_extension": ".md",
    "mime_type": "text/markdown",
    "content_hash": "abc123",
    "file_modified_at": "2025-01-01T00:00:00",
    "chunk_count": 3,
    "status": "indexed",
}

SAMPLE_HEALTH = {
    "id": str(HEALTH_ID),
    "service_status": "running",
    "last_heartbeat": "2025-01-01T00:00:00",
    "process_id": 12345,
    "consecutive_errors": 0,
    "created_at": "2025-01-01T00:00:00",
}


def _make_gateway():
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.insert = AsyncMock()
    gw.select = AsyncMock(return_value=[])
    gw.update = AsyncMock()
    gw.delete = AsyncMock()
    gw.upsert = AsyncMock()
    return gw


@pytest.fixture
def repo():
    gw = _make_gateway()
    return FileIndexingRepository(db=gw), gw


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_with_gateway(self):
        gw = _make_gateway()
        r = FileIndexingRepository(db=gw)
        assert r._gateway is gw

    def test_with_supabase_client(self):
        from data.database.clients.supabase import SupabaseClient
        mock_client = MagicMock(spec=SupabaseClient)
        r = FileIndexingRepository(db=mock_client)
        assert r._gateway is not None

    def test_none_raises(self):
        with pytest.raises(ValueError):
            FileIndexingRepository(db=None)

    def test_unsupported_type_raises(self):
        with pytest.raises(TypeError):
            FileIndexingRepository(db="invalid")


# ===========================================================================
# Location Operations
# ===========================================================================

class TestCreateLocation:

    async def test_create_basic(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_LOCATION]
        loc = await r.create_location({
            "location_name": "Documents",
            "root_path": "/home/user/docs",
        })
        assert loc["location_name"] == "Documents"

    async def test_index_name_generated(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_LOCATION]
        await r.create_location({
            "location_name": "My-Test Location",
            "root_path": "/tmp",
        })
        call_data = gw.insert.call_args[0][1]
        assert call_data["index_name"] == "my_test_location"

    async def test_index_name_special_chars_stripped(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_LOCATION]
        await r.create_location({
            "location_name": "docs@v2!",
            "root_path": "/tmp",
        })
        call_data = gw.insert.call_args[0][1]
        assert call_data["index_name"] == "docsv2"

    async def test_index_directory_generated(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_LOCATION]
        await r.create_location({
            "location_name": "docs",
            "root_path": "/home/user",
        })
        call_data = gw.insert.call_args[0][1]
        assert "aether_rag_sources/filesystem/docs" in call_data["index_directory"]

    async def test_result_not_list(self, repo):
        """When gateway returns a dict instead of a list."""
        r, gw = repo
        gw.insert.return_value = SAMPLE_LOCATION  # not a list
        loc = await r.create_location({
            "location_name": "docs",
            "root_path": "/tmp",
        })
        assert loc["location_name"] == "Documents"


    async def test_missing_location_name_raises_key_error(self, repo):
        """Malformed input: missing required 'location_name' key."""
        r, gw = repo
        with pytest.raises(KeyError, match="location_name"):
            await r.create_location({"root_path": "/tmp"})

    async def test_missing_root_path_raises_key_error(self, repo):
        """Malformed input: missing required 'root_path' key."""
        r, gw = repo
        with pytest.raises(KeyError, match="root_path"):
            await r.create_location({"location_name": "test"})


class TestGetLocation:

    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_LOCATION]
        loc = await r.get_location(LOC_ID)
        assert loc["id"] == str(LOC_ID)

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        assert await r.get_location(uuid4()) is None


class TestGetLocationByRootPath:

    async def test_exact_match_fast_path(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_LOCATION]
        loc = await r.get_location_by_root_path("/home/user/docs")
        assert loc["id"] == str(LOC_ID)
        call_kwargs = gw.select.call_args.kwargs
        assert call_kwargs["filters"]["root_path"] == "/home/user/docs"
        assert call_kwargs["limit"] == 1

    async def test_normalized_fallback_match(self, repo):
        r, gw = repo
        trailing_slash_loc = {**SAMPLE_LOCATION, "root_path": "/home/user/docs/"}
        gw.select.side_effect = [
            [],  # exact normalized match miss
            [trailing_slash_loc],  # fallback full scan
        ]
        loc = await r.get_location_by_root_path("/home/user/docs")
        assert loc["id"] == str(LOC_ID)
        assert gw.select.await_count == 2

    async def test_fallback_ignores_malformed_rows(self, repo):
        r, gw = repo
        good_loc = {**SAMPLE_LOCATION, "id": str(uuid4()), "root_path": "/tmp/valid/"}
        gw.select.side_effect = [
            [],
            [
                {"id": str(uuid4()), "root_path": None},
                {"id": str(uuid4()), "root_path": ""},
                good_loc,
            ],
        ]
        loc = await r.get_location_by_root_path("/tmp/valid")
        assert loc["id"] == good_loc["id"]


class TestGetAllLocations:

    async def test_no_filter(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_LOCATION]
        result = await r.get_all_locations()
        assert len(result) == 1

    async def test_enabled_only(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_LOCATION]
        await r.get_all_locations(enabled_only=True)
        call_kwargs = gw.select.call_args[1]
        assert call_kwargs["filters"]["enabled"] is True

    async def test_sorts_primary_first(self, repo):
        r, gw = repo
        secondary = {**SAMPLE_LOCATION, "id": str(uuid4()), "location_type": "secondary"}
        primary = {**SAMPLE_LOCATION, "location_type": "primary"}
        gw.select.return_value = [secondary, primary]
        result = await r.get_all_locations()
        assert result[0]["location_type"] == "primary"
        assert result[1]["location_type"] == "secondary"


class TestUpdateLocation:

    async def test_update_success(self, repo):
        r, gw = repo
        gw.update.return_value = [{**SAMPLE_LOCATION, "enabled": False}]
        result = await r.update_location(LOC_ID, {"enabled": False})
        assert result["enabled"] is False

    async def test_update_dict_result(self, repo):
        """When gateway returns a dict instead of a list."""
        r, gw = repo
        gw.update.return_value = {**SAMPLE_LOCATION, "enabled": False}
        result = await r.update_location(LOC_ID, {"enabled": False})
        assert result["enabled"] is False

    async def test_not_found_raises(self, repo):
        r, gw = repo
        gw.update.return_value = []
        with pytest.raises(ValueError, match="not found"):
            await r.update_location(LOC_ID, {"enabled": False})


class TestDeleteLocation:

    async def test_delete_success(self, repo):
        r, gw = repo
        await r.delete_location(LOC_ID)
        gw.delete.assert_awaited_once()


class TestUpdateLocationStatus:

    async def test_status_with_error(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_LOCATION]
        await r.update_location_status(LOC_ID, "failed", error="disk full")
        call_data = gw.update.call_args[0][1]
        assert call_data["last_scan_status"] == "failed"
        assert call_data["last_scan_error"] == "disk full"

    async def test_status_completed_clears_error(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_LOCATION]
        await r.update_location_status(LOC_ID, "completed")
        call_data = gw.update.call_args[0][1]
        assert call_data["last_scan_error"] is None

    async def test_status_other(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_LOCATION]
        await r.update_location_status(LOC_ID, "scanning")
        call_data = gw.update.call_args[0][1]
        assert "last_scan_error" not in call_data


class TestUpdateLocationStats:

    async def test_updates_all_fields(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_LOCATION]
        await r.update_location_stats(LOC_ID, "completed", 100, 500, 1024, 30)
        call_data = gw.update.call_args[0][1]
        assert call_data["file_count"] == 100
        assert call_data["chunk_count"] == 500
        assert call_data["index_size_bytes"] == 1024
        assert call_data["last_scan_duration_seconds"] == 30
        assert call_data["last_scan_error"] is None


# ===========================================================================
# File Operations
# ===========================================================================

class TestUpsertIndexedFile:

    async def test_insert_new(self, repo):
        r, gw = repo
        gw.select.return_value = []  # not existing
        gw.insert.return_value = [SAMPLE_FILE]
        meta = {
            "file_path": "/home/user/docs/readme.md",
            "file_name": "readme.md",
            "file_size": 1024,
            "file_extension": ".md",
            "content_hash": "abc123",
            "file_modified_at": "2025-01-01T00:00:00",
        }
        result = await r.upsert_indexed_file(LOC_ID, meta, 3)
        gw.insert.assert_awaited_once()
        assert result["file_name"] == "readme.md"

    async def test_insert_new_non_list(self, repo):
        r, gw = repo
        gw.select.return_value = []
        gw.insert.return_value = SAMPLE_FILE  # not a list
        meta = {
            "file_path": "/a", "file_name": "a",
            "file_size": 1, "file_extension": ".txt",
            "content_hash": "x", "file_modified_at": "2025-01-01",
        }
        result = await r.upsert_indexed_file(LOC_ID, meta, 1)
        assert result == SAMPLE_FILE

    async def test_update_existing(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_FILE]  # existing
        gw.update.return_value = SAMPLE_FILE
        meta = {
            "file_path": "/home/user/docs/readme.md",
            "file_name": "readme.md",
            "file_size": 2048,
            "file_extension": ".md",
            "content_hash": "def456",
            "file_modified_at": "2025-06-01T00:00:00",
        }
        result = await r.upsert_indexed_file(LOC_ID, meta, 5)
        gw.update.assert_awaited_once()
        gw.insert.assert_not_awaited()

    async def test_optional_meta_fields(self, repo):
        r, gw = repo
        gw.select.return_value = []
        gw.insert.return_value = [SAMPLE_FILE]
        meta = {
            "file_path": "/a", "file_name": "a",
            "file_size": 1, "file_extension": ".txt",
            "content_hash": "x", "file_modified_at": "2025-01-01",
            "mime_type": "text/plain",
            "creation_date": "2025-01-01",
            "modification_date": "2025-06-01",
        }
        await r.upsert_indexed_file(LOC_ID, meta, 2)
        call_data = gw.insert.call_args[0][1]
        assert call_data["mime_type"] == "text/plain"
        assert call_data["creation_date"] == "2025-01-01"


class TestGetFilesByLocation:

    async def test_returns_files(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_FILE]
        result = await r.get_files_by_location(LOC_ID)
        assert len(result) == 1
        assert result[0]["file_path"] == SAMPLE_FILE["file_path"]
        # Verify correct table and filter
        call_args = gw.select.call_args
        assert call_args[0][0] == "indexed_files"
        assert call_args[1]["filters"]["location_id"] == str(LOC_ID)

    async def test_empty(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_files_by_location(LOC_ID)
        assert result == []


class TestFilterChangedFiles:

    async def test_new_file(self, repo):
        r, gw = repo
        gw.select.return_value = []  # no existing files
        scanned = [{"file_path": "/new.txt", "content_hash": "h1"}]
        result = await r.filter_changed_files(LOC_ID, scanned)
        assert len(result) == 1

    async def test_unchanged_file(self, repo):
        r, gw = repo
        gw.select.return_value = [{"file_path": "/a.txt", "content_hash": "h1"}]
        scanned = [{"file_path": "/a.txt", "content_hash": "h1"}]
        result = await r.filter_changed_files(LOC_ID, scanned)
        assert len(result) == 0

    async def test_changed_hash(self, repo):
        r, gw = repo
        gw.select.return_value = [{"file_path": "/a.txt", "content_hash": "old"}]
        scanned = [{"file_path": "/a.txt", "content_hash": "new"}]
        result = await r.filter_changed_files(LOC_ID, scanned)
        assert len(result) == 1

    async def test_mixed(self, repo):
        r, gw = repo
        gw.select.return_value = [
            {"file_path": "/unchanged.txt", "content_hash": "h1"},
            {"file_path": "/changed.txt", "content_hash": "old"},
        ]
        scanned = [
            {"file_path": "/unchanged.txt", "content_hash": "h1"},
            {"file_path": "/changed.txt", "content_hash": "new"},
            {"file_path": "/new.txt", "content_hash": "x"},
        ]
        result = await r.filter_changed_files(LOC_ID, scanned)
        assert len(result) == 2


# ===========================================================================
# Health Operations
# ===========================================================================

class TestRegisterService:

    async def test_register_cleans_old(self, repo):
        r, gw = repo
        old = [{"id": "old-1"}, {"id": "old-2"}]
        gw.select.return_value = old
        gw.insert.return_value = [SAMPLE_HEALTH]
        result = await r.register_service(12345)
        assert gw.delete.await_count == 2
        assert result["process_id"] == 12345

    async def test_register_no_old_records(self, repo):
        r, gw = repo
        gw.select.return_value = []
        gw.insert.return_value = [SAMPLE_HEALTH]
        await r.register_service(99)
        gw.delete.assert_not_awaited()

    async def test_register_non_list_result(self, repo):
        r, gw = repo
        gw.select.return_value = []
        gw.insert.return_value = SAMPLE_HEALTH  # not a list
        result = await r.register_service(99)
        assert result["process_id"] == 12345


class TestUpdateHeartbeat:

    async def test_update_existing(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_HEALTH]
        await r.update_heartbeat()
        gw.update.assert_awaited_once()
        call_data = gw.update.call_args[0][1]
        assert call_data["service_status"] == "idle"

    async def test_no_health_record(self, repo):
        r, gw = repo
        gw.select.return_value = []
        await r.update_heartbeat()
        gw.update.assert_not_awaited()


class TestUpdateServiceStatus:

    async def test_status_with_error(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_HEALTH]
        await r.update_service_status("error", error="crash")
        call_data = gw.update.call_args[0][1]
        assert call_data["service_status"] == "error"
        assert call_data["error_message"] == "crash"
        assert call_data["consecutive_errors"] == 1

    async def test_status_without_error_resets(self, repo):
        r, gw = repo
        gw.select.return_value = [{**SAMPLE_HEALTH, "consecutive_errors": 5}]
        await r.update_service_status("running")
        call_data = gw.update.call_args[0][1]
        assert call_data["consecutive_errors"] == 0
        assert "error_message" not in call_data

    async def test_no_health_record(self, repo):
        r, gw = repo
        gw.select.return_value = []
        await r.update_service_status("running")
        gw.update.assert_not_awaited()


class TestGetServiceHealth:

    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_HEALTH]
        result = await r.get_service_health()
        assert result["service_status"] == "running"

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_service_health()
        assert result is None


# ===========================================================================
# Misc Operations
# ===========================================================================

class TestGetActiveReindexJob:

    async def test_found(self, repo):
        r, gw = repo
        job = {"id": "j1", "location_id": str(LOC_ID), "status": "running"}
        gw.select.return_value = [job]
        result = await r.get_active_reindex_job(LOC_ID)
        assert result["status"] == "running"

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_active_reindex_job(LOC_ID)
        assert result is None

    async def test_in_filters_used(self, repo):
        r, gw = repo
        gw.select.return_value = []
        await r.get_active_reindex_job(LOC_ID)
        call_kwargs = gw.select.call_args[1]
        assert set(call_kwargs["in_filters"]["status"]) == {"running", "queued", "paused"}


class TestGetDaemonConfig:

    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": "cfg", "scan_interval": 300}]
        result = await r.get_daemon_config()
        assert result["scan_interval"] == 300

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_daemon_config()
        assert result is None


class TestUpdateDaemonConfig:

    async def test_create_new(self, repo):
        r, gw = repo
        # get_daemon_config returns None
        gw.select.return_value = []
        await r.update_daemon_config({"scan_interval": 600})
        gw.insert.assert_awaited_once()
        call_data = gw.insert.call_args[0][1]
        assert call_data["id"] == "00000000-0000-0000-0000-000000000001"
        assert call_data["scan_interval"] == 600

    async def test_update_existing(self, repo):
        r, gw = repo
        # get_daemon_config returns existing
        gw.select.return_value = [{"id": "00000000-0000-0000-0000-000000000001", "scan_interval": 300}]
        await r.update_daemon_config({"scan_interval": 600, "id": "should-be-stripped"})
        gw.update.assert_awaited_once()
        call_data = gw.update.call_args[0][1]
        assert "id" not in call_data
        assert call_data["scan_interval"] == 600
