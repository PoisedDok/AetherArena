"""
Tests for api/v1/endpoints/files.py

Covers: file upload, location CRUD, reindex operations, daemon control, health.
Pattern: Use conftest.py `client` fixture (wraps create_app() with mocked deps).
The mock_supabase_client provides: select, insert, update, delete as AsyncMock.
"""

import io
import json
import tempfile
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4
from datetime import datetime, timezone, timedelta
from pathlib import Path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

LOCATION_ID = str(uuid4())
JOB_ID = str(uuid4())
NOW_ISO = datetime.now(timezone.utc).isoformat()

SAMPLE_LOCATION = {
    "id": LOCATION_ID,
    "location_name": "My Docs",
    "root_path": "/tmp/test_docs",
    "location_type": "secondary",
    "enabled": True,
    "index_name": "my_docs",
    "index_directory": "/tmp/indexes/my_docs",
    "index_mode": "auto",
    "scan_interval_minutes": 15,
    "watch_enabled": True,
    "watch_directories": [],
    "allowed_extensions": ["pdf", "txt"],
    "exclude_patterns": [],
    "chunk_size": 512,
    "chunk_overlap": 50,
    "max_file_size_mb": 50,
    "file_count": 0,
    "chunk_count": 0,
    "index_size_bytes": 0,
    "last_scan_at": None,
    "last_scan_status": "idle",
    "last_scan_error": None,
    "last_scan_duration_seconds": None,
    "status": "idle",
    "error_message": None,
    "created_at": NOW_ISO,
    "updated_at": NOW_ISO,
}

SAMPLE_REINDEX_JOB = {
    "id": JOB_ID,
    "location_id": LOCATION_ID,
    "status": "running",
    "progress_pct": 50.0,
    "files_processed": 10,
    "files_total": 20,
    "started_at": NOW_ISO,
    "completed_at": None,
    "error_message": None,
}


# ===========================================================================
# File Upload Tests
# ===========================================================================

class TestFileUpload:
    """Tests for POST /v1/file/upload"""

    @pytest.mark.asyncio
    async def test_upload_valid_text_file(self, client, mock_supabase_client):
        """Upload a valid .txt file returns 201 with artifact metadata."""
        artifact_id = str(uuid4())
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.insert = AsyncMock(return_value=[{
            "id": str(uuid4()),
            "title": "__system_file_uploads__",
            "created_at": NOW_ISO,
            "updated_at": NOW_ISO,
        }])
        mock_supabase_client.upsert = AsyncMock(return_value=[{
            "id": artifact_id,
            "chat_id": str(uuid4()),
            "type": "file",
            "created_at": NOW_ISO,
        }])

        file_content = b"Hello, this is test content."
        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("test.txt", io.BytesIO(file_content), "text/plain")},
            data={"purpose": "attachment"},
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["filename"] == "test.txt"
        assert body["size"] == len(file_content)

    @pytest.mark.asyncio
    async def test_upload_disallowed_extension(self, client):
        """Upload a .exe file returns 400."""
        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("malware.exe", io.BytesIO(b"MZ"), "application/octet-stream")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 400
        assert "not allowed" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_upload_empty_file(self, client):
        """Upload a zero-byte file returns 400."""
        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("empty.txt", io.BytesIO(b""), "text/plain")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 400
        assert "empty" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_upload_pdf_file(self, client, mock_supabase_client):
        """Upload a valid .pdf file (stored as base64) returns 201."""
        artifact_id = str(uuid4())
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.insert = AsyncMock(return_value=[{
            "id": str(uuid4()),
            "title": "__system_file_uploads__",
            "created_at": NOW_ISO,
            "updated_at": NOW_ISO,
        }])
        mock_supabase_client.upsert = AsyncMock(return_value=[{
            "id": artifact_id,
            "chat_id": str(uuid4()),
            "type": "file",
            "created_at": NOW_ISO,
        }])

        pdf_bytes = b"%PDF-1.4 test pdf content"
        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("document.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["filename"] == "document.pdf"

    @pytest.mark.asyncio
    async def test_upload_with_existing_system_chat(self, client, mock_supabase_client):
        """Upload without chat_id reuses existing system chat."""
        system_chat_id = str(uuid4())
        artifact_id = str(uuid4())

        # First select returns system chat, second is for artifact upsert
        mock_supabase_client.select = AsyncMock(return_value=[{
            "id": system_chat_id,
            "title": "__system_file_uploads__",
            "created_at": NOW_ISO,
            "updated_at": NOW_ISO,
        }])
        mock_supabase_client.upsert = AsyncMock(return_value=[{
            "id": artifact_id,
            "chat_id": str(uuid4()),
            "type": "file",
            "created_at": NOW_ISO,
        }])

        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("readme.md", io.BytesIO(b"# Readme"), "text/markdown")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 201


# ===========================================================================
# Location Management Tests
# ===========================================================================

class TestLocationList:
    """Tests for GET /v1/file/location/list"""

    @pytest.mark.asyncio
    async def test_list_locations_empty(self, client, mock_supabase_client):
        """Returns empty list when no locations configured."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.get("/v1/file/location/list")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_list_locations_with_data(self, client, mock_supabase_client):
        """Returns locations when configured."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])

        resp = await client.get("/v1/file/location/list")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["location_name"] == "My Docs"

    @pytest.mark.asyncio
    async def test_list_locations_enabled_filter(self, client, mock_supabase_client):
        """Query param enabled_only=true filters locations."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])

        resp = await client.get("/v1/file/location/list?enabled_only=true")
        assert resp.status_code == 200


class TestLocationGet:
    """Tests for GET /v1/file/location/get/{location_id}"""

    @pytest.mark.asyncio
    async def test_get_location_found(self, client, mock_supabase_client):
        """Get existing location returns 200."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])

        resp = await client.get(f"/v1/file/location/get/{LOCATION_ID}")
        assert resp.status_code == 200
        assert resp.json()["location_name"] == "My Docs"

    @pytest.mark.asyncio
    async def test_get_location_not_found(self, client, mock_supabase_client):
        """Get nonexistent location returns 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        fake_id = str(uuid4())
        resp = await client.get(f"/v1/file/location/get/{fake_id}")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_location_invalid_uuid(self, client):
        """Get with invalid UUID returns 422."""
        resp = await client.get("/v1/file/location/get/not-a-uuid")
        assert resp.status_code == 422


class TestLocationCreate:
    """Tests for POST /v1/file/location/create"""

    @pytest.mark.asyncio
    async def test_create_location_valid(self, client, mock_supabase_client, temp_dir):
        """Create with valid directory path returns 201."""
        mock_supabase_client.insert = AsyncMock(return_value=[{
            **SAMPLE_LOCATION,
            "root_path": str(temp_dir),
        }])
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.post("/v1/file/location/create", json={
            "location_name": "Test Folder",
            "root_path": str(temp_dir),
        })
        assert resp.status_code == 201
        assert resp.json()["location_name"] == "My Docs"

    @pytest.mark.asyncio
    async def test_create_location_nonexistent_path(self, client):
        """Create with nonexistent path returns 400."""
        resp = await client.post("/v1/file/location/create", json={
            "location_name": "Ghost Folder",
            "root_path": "/nonexistent/path/that/does/not/exist",
        })
        assert resp.status_code == 400
        assert "does not exist" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_create_location_missing_name(self, client):
        """Create without location_name returns 422."""
        resp = await client.post("/v1/file/location/create", json={
            "root_path": "/tmp",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_location_existing_path_returns_existing(self, client, mock_supabase_client, temp_dir):
        """Create is idempotent: existing normalized path returns existing row and skips insert."""
        existing = {
            **SAMPLE_LOCATION,
            "id": str(uuid4()),
            "root_path": str(temp_dir.resolve()),
        }
        mock_supabase_client.select = AsyncMock(return_value=[existing])
        mock_supabase_client.insert = AsyncMock()

        resp = await client.post("/v1/file/location/create", json={
            "location_name": "Already Indexed",
            "root_path": str(temp_dir),
        })

        assert resp.status_code == 201
        body = resp.json()
        assert body["id"] == existing["id"]
        assert body["root_path"] == str(temp_dir.resolve())
        mock_supabase_client.insert.assert_not_called()

    @pytest.mark.asyncio
    async def test_create_location_normalizes_path_before_insert(self, client, mock_supabase_client, temp_dir):
        """Create stores canonical resolved root_path (no trailing slash variants)."""
        created = {
            **SAMPLE_LOCATION,
            "id": str(uuid4()),
            "root_path": str(temp_dir.resolve()),
        }
        mock_supabase_client.select = AsyncMock(side_effect=[[], []])
        mock_supabase_client.insert = AsyncMock(return_value=[created])

        resp = await client.post("/v1/file/location/create", json={
            "location_name": "Canonical Path",
            "root_path": f"{temp_dir}/",
        })

        assert resp.status_code == 201
        insert_payload = mock_supabase_client.insert.call_args[0][1]
        assert insert_payload["root_path"] == str(temp_dir.resolve())

    @pytest.mark.asyncio
    async def test_create_location_fallback_match_on_equivalent_path(self, client, mock_supabase_client, temp_dir):
        """Create detects existing location via normalized fallback comparison."""
        existing = {
            **SAMPLE_LOCATION,
            "id": str(uuid4()),
            "root_path": f"{temp_dir}/",
        }
        mock_supabase_client.select = AsyncMock(side_effect=[
            [],         # exact normalized path lookup miss
            [existing], # fallback full-scan normalized match
        ])
        mock_supabase_client.insert = AsyncMock()

        resp = await client.post("/v1/file/location/create", json={
            "location_name": "Equivalent Path",
            "root_path": str(temp_dir.resolve()),
        })

        assert resp.status_code == 201
        assert resp.json()["id"] == existing["id"]
        mock_supabase_client.insert.assert_not_called()


class TestLocationUpdate:
    """Tests for PUT /v1/file/location/update/{location_id}"""

    @pytest.mark.asyncio
    async def test_update_location(self, client, mock_supabase_client):
        """Update returns updated location."""
        updated = {**SAMPLE_LOCATION, "scan_interval_minutes": 30}
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])
        mock_supabase_client.update = AsyncMock(return_value=[updated])

        resp = await client.put(
            f"/v1/file/location/update/{LOCATION_ID}",
            json={"scan_interval_minutes": 30},
        )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_update_location_not_found(self, client, mock_supabase_client):
        """Update nonexistent location returns 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        fake_id = str(uuid4())
        resp = await client.put(
            f"/v1/file/location/update/{fake_id}",
            json={"scan_interval_minutes": 30},
        )
        assert resp.status_code == 404


class TestLocationDelete:
    """Tests for DELETE /v1/file/location/delete/{location_id}"""

    @pytest.mark.asyncio
    async def test_delete_location(self, client, mock_supabase_client):
        """Delete existing location returns 204."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])
        mock_supabase_client.delete = AsyncMock(return_value=None)

        resp = await client.delete(f"/v1/file/location/delete/{LOCATION_ID}")
        assert resp.status_code == 204

    @pytest.mark.asyncio
    async def test_delete_location_not_found(self, client, mock_supabase_client):
        """Delete nonexistent location returns 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        fake_id = str(uuid4())
        resp = await client.delete(f"/v1/file/location/delete/{fake_id}")
        assert resp.status_code == 404


# ===========================================================================
# Reindex Operations Tests
# ===========================================================================

class TestReindexOperations:
    """Tests for reindex trigger, status, pause, resume, stop, cancel."""

    @pytest.mark.asyncio
    async def test_get_active_job_found(self, client, mock_supabase_client):
        """GET active job for location returns job data."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_REINDEX_JOB])

        resp = await client.get(f"/v1/file/location/active-job/{LOCATION_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_get_active_job_none(self, client, mock_supabase_client):
        """GET active job when no active job returns empty."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.get(f"/v1/file/location/active-job/{LOCATION_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_get_reindex_status(self, client, mock_supabase_client):
        """GET reindex job status returns progress info."""
        # ReindexJobManager uses repository._gateway.select internally
        job_data = {
            "id": JOB_ID,
            "location_id": LOCATION_ID,
            "location_name": "Test Location",
            "status": "running",
            "progress_phase": "scanning",
            "files_scanned": 10,
            "files_total": 20,
            "chunks_processed": 50,
            "error_message": None,
            "started_at": NOW_ISO,
            "completed_at": None,
            "created_at": NOW_ISO,
            "updated_at": NOW_ISO,
        }
        mock_supabase_client.select = AsyncMock(return_value=[job_data])

        resp = await client.get(f"/v1/file/reindex/status/{JOB_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "running"
        assert body["progress_percent"] == 50

    @pytest.mark.asyncio
    async def test_get_reindex_status_not_found(self, client, mock_supabase_client):
        """GET reindex status for nonexistent job returns 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        fake_id = str(uuid4())
        resp = await client.get(f"/v1/file/reindex/status/{fake_id}")
        assert resp.status_code == 404


# ===========================================================================
# Service Health Tests
# ===========================================================================

class TestServiceHealth:
    """Tests for GET /v1/file/health"""

    @pytest.mark.asyncio
    async def test_health_endpoint(self, client, mock_supabase_client):
        """Health endpoint returns service status."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "running",
            "last_heartbeat": NOW_ISO,
            "process_id": 12345,
            "active_location": None,
            "current_operation": None,
            "operation_progress": {},
            "error_message": None,
            "consecutive_errors": 0,
            "uptime_seconds": 600,
        }])

        resp = await client.get("/v1/file/health")
        assert resp.status_code == 200


# ===========================================================================
# Daemon Control Tests
# ===========================================================================

class TestDaemonStatus:
    """Tests for GET /v1/file/daemon/status"""

    @pytest.mark.asyncio
    async def test_daemon_status(self, client, mock_supabase_client):
        """Daemon status returns current state."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.get("/v1/file/daemon/status")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_daemon_config_get(self, client, mock_supabase_client):
        """GET daemon config returns configuration."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.get("/v1/file/daemon/config")
        assert resp.status_code == 200


class TestDaemonStats:
    """Tests for GET /v1/file/daemon/stats"""

    @pytest.mark.asyncio
    async def test_daemon_stats(self, client):
        """Daemon stats endpoint returns aggregated data."""
        resp = await client.get("/v1/file/daemon/stats")
        assert resp.status_code == 200


class TestDaemonDataDeletion:
    """Tests for DELETE /v1/file/daemon/{daemon_name}/data"""

    @pytest.mark.asyncio
    async def test_delete_invalid_daemon(self, client):
        """Delete data for invalid daemon name returns 400."""
        resp = await client.delete("/v1/file/daemon/invalid_daemon_name/data")
        assert resp.status_code == 400
        assert "Invalid daemon name" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_delete_all_daemon_data(self, client):
        """DELETE all daemon data returns 200 with structured response."""
        resp = await client.delete("/v1/file/daemon/data/all")
        assert resp.status_code == 200
        body = resp.json()
        assert "success" in body
        assert "deleted_items" in body


# ===========================================================================
# EXPANDED: File Upload — additional branches
# ===========================================================================

class TestFileUploadExpanded:
    """Additional upload tests covering branches not in the basic suite."""

    @pytest.mark.asyncio
    async def test_upload_with_explicit_chat_id(self, client, mock_supabase_client):
        """Upload with explicit chat_id skips system-chat lookup."""
        artifact_id = str(uuid4())
        chat_id = str(uuid4())
        mock_supabase_client.upsert = AsyncMock(return_value=[{
            "id": artifact_id,
            "chat_id": str(uuid4()),
            "type": "file",
            "created_at": NOW_ISO,
        }])

        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("notes.txt", io.BytesIO(b"some notes"), "text/plain")},
            data={"purpose": "attachment", "chat_id": chat_id},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["filename"] == "notes.txt"
        assert body["size"] == len(b"some notes")
        # select should NOT have been called for system chat lookup
        mock_supabase_client.select.assert_not_called()

    @pytest.mark.asyncio
    async def test_upload_creates_system_chat_when_none_exists(self, client, mock_supabase_client):
        """Upload without chat_id and no existing system chat creates one."""
        artifact_id = str(uuid4())
        new_chat_id = str(uuid4())

        # First select: no system chat found; second insert: chat creation; third insert: artifact
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.insert = AsyncMock(return_value=[{
            "id": new_chat_id,
            "title": "__system_file_uploads__",
            "created_at": NOW_ISO,
            "updated_at": NOW_ISO,
        }])
        mock_supabase_client.upsert = AsyncMock(return_value=[{
            "id": artifact_id,
            "chat_id": str(uuid4()),
            "type": "file",
            "created_at": NOW_ISO,
        }])

        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("data.csv", io.BytesIO(b"a,b\n1,2"), "text/csv")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 201
        assert resp.json()["filename"] == "data.csv"

    @pytest.mark.asyncio
    async def test_upload_json_file(self, client, mock_supabase_client):
        """Upload a valid .json file (text decoded, not base64) returns 201."""
        artifact_id = str(uuid4())
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.insert = AsyncMock(return_value=[{
            "id": str(uuid4()),
            "title": "__system_file_uploads__",
            "created_at": NOW_ISO,
            "updated_at": NOW_ISO,
        }])
        mock_supabase_client.upsert = AsyncMock(return_value=[{
            "id": artifact_id,
            "chat_id": str(uuid4()),
            "type": "file",
            "created_at": NOW_ISO,
        }])

        json_bytes = b'{"key": "value"}'
        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("config.json", io.BytesIO(json_bytes), "application/json")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["filename"] == "config.json"
        assert body["size"] == len(json_bytes)
        assert body["content_type"] == "application/json"

    @pytest.mark.asyncio
    async def test_upload_docx_file_stored_as_base64(self, client, mock_supabase_client):
        """Upload a .docx file (binary) is stored as base64."""
        artifact_id = str(uuid4())
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.insert = AsyncMock(return_value=[{
            "id": str(uuid4()),
            "title": "__system_file_uploads__",
            "created_at": NOW_ISO,
            "updated_at": NOW_ISO,
        }])
        mock_supabase_client.upsert = AsyncMock(return_value=[{
            "id": artifact_id,
            "chat_id": str(uuid4()),
            "type": "file",
            "created_at": NOW_ISO,
        }])

        docx_bytes = b"PK\x03\x04 fake docx content"
        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("report.docx", io.BytesIO(docx_bytes),
                           "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 201
        assert resp.json()["filename"] == "report.docx"

    @pytest.mark.asyncio
    async def test_upload_server_error_returns_500(self, client, mock_supabase_client):
        """Upload that triggers unexpected exception returns 500."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.insert = AsyncMock(side_effect=RuntimeError("DB connection lost"))

        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("test.txt", io.BytesIO(b"content"), "text/plain")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 500
        assert "failed" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_upload_no_filename_rejected(self, client, mock_supabase_client):
        """Upload with no filename is rejected (422 from request validation or 400 from extension check)."""
        resp = await client.post(
            "/v1/file/upload",
            files={"file": (None, io.BytesIO(b"content"), "text/plain")},
            data={"purpose": "attachment"},
        )
        # httpx sends no filename -> FastAPI may reject at validation (422) or
        # our code sees '' extension and rejects (400). Both are correct rejections.
        assert resp.status_code in (400, 422)


# ===========================================================================
# EXPANDED: Location CRUD — additional branches
# ===========================================================================

class TestLocationCreateExpanded:
    """Additional create location tests."""

    @pytest.mark.asyncio
    async def test_create_location_path_is_file_not_dir(self, client, temp_dir):
        """Create with path pointing to a file (not directory) returns 400."""
        file_path = temp_dir / "somefile.txt"
        file_path.write_text("I'm a file")

        resp = await client.post("/v1/file/location/create", json={
            "location_name": "Not A Dir",
            "root_path": str(file_path),
        })
        assert resp.status_code == 400
        assert "not a directory" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_create_location_server_error(self, client, mock_supabase_client, temp_dir):
        """Create that triggers repo error returns 500."""
        mock_supabase_client.insert = AsyncMock(side_effect=RuntimeError("DB down"))
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.post("/v1/file/location/create", json={
            "location_name": "Broken",
            "root_path": str(temp_dir),
        })
        assert resp.status_code == 500
        assert "Failed to create location" in resp.json()["detail"]


class TestLocationListExpanded:
    """Additional list location tests."""

    @pytest.mark.asyncio
    async def test_list_locations_server_error(self, client, mock_supabase_client):
        """List locations repo exception returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("timeout"))

        resp = await client.get("/v1/file/location/list")
        assert resp.status_code == 500
        assert "Failed to retrieve locations" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_list_multiple_locations(self, client, mock_supabase_client):
        """List returns multiple locations in response body."""
        loc2 = {**SAMPLE_LOCATION, "id": str(uuid4()), "location_name": "Second"}
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION, loc2])

        resp = await client.get("/v1/file/location/list")
        assert resp.status_code == 200
        assert len(resp.json()) == 2


class TestLocationGetExpanded:
    """Additional get location tests."""

    @pytest.mark.asyncio
    async def test_get_location_server_error(self, client, mock_supabase_client):
        """Get location repo exception returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("timeout"))

        resp = await client.get(f"/v1/file/location/get/{LOCATION_ID}")
        assert resp.status_code == 500
        assert "Failed to retrieve location" in resp.json()["detail"]


class TestLocationUpdateExpanded:
    """Additional update location tests."""

    @pytest.mark.asyncio
    async def test_update_location_empty_body(self, client, mock_supabase_client):
        """Update with empty JSON body (no fields) returns 400."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])

        resp = await client.put(
            f"/v1/file/location/update/{LOCATION_ID}",
            json={},
        )
        assert resp.status_code == 400
        assert "No update fields" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_update_location_server_error(self, client, mock_supabase_client):
        """Update repo exception returns 500."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])
        mock_supabase_client.update = AsyncMock(side_effect=RuntimeError("DB crash"))

        resp = await client.put(
            f"/v1/file/location/update/{LOCATION_ID}",
            json={"scan_interval_minutes": 60},
        )
        assert resp.status_code == 500
        assert "Failed to update location" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_update_location_invalid_uuid(self, client):
        """Update with invalid UUID returns 422."""
        resp = await client.put(
            "/v1/file/location/update/bad-uuid",
            json={"scan_interval_minutes": 30},
        )
        assert resp.status_code == 422


class TestLocationDeleteExpanded:
    """Additional delete location tests."""

    @pytest.mark.asyncio
    async def test_delete_location_server_error(self, client, mock_supabase_client):
        """Delete repo exception returns 500."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])
        mock_supabase_client.delete = AsyncMock(side_effect=RuntimeError("DB crash"))

        resp = await client.delete(f"/v1/file/location/delete/{LOCATION_ID}")
        assert resp.status_code == 500
        assert "Failed to delete location" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_delete_location_invalid_uuid(self, client):
        """Delete with invalid UUID returns 422."""
        resp = await client.delete("/v1/file/location/delete/not-valid")
        assert resp.status_code == 422


# ===========================================================================
# EXPANDED: Reindex Operations — trigger, pause, resume, stop, cancel
# ===========================================================================

class TestReindexTrigger:
    """Tests for POST /v1/file/location/reindex/{location_id}"""

    @pytest.mark.asyncio
    async def test_trigger_reindex_success(self, client, mock_supabase_client):
        """Trigger reindex for existing location returns 202."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])
        mock_supabase_client.insert = AsyncMock(return_value=[{
            "id": str(uuid4()),
            "status": "queued",
        }])

        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.trigger_reindex_async = AsyncMock(return_value={
                "job_id": str(uuid4()),
                "status": "queued",
                "message": "Reindex queued",
            })
            MockManager.return_value = mock_mgr

            resp = await client.post(f"/v1/file/location/reindex/{LOCATION_ID}")
            assert resp.status_code == 202
            body = resp.json()
            assert body["status"] == "queued"
            assert "job_id" in body

    @pytest.mark.asyncio
    async def test_trigger_reindex_location_not_found(self, client, mock_supabase_client):
        """Trigger reindex for nonexistent location returns 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        fake_id = str(uuid4())
        resp = await client.post(f"/v1/file/location/reindex/{fake_id}")
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_trigger_reindex_server_error(self, client, mock_supabase_client):
        """Trigger reindex that fails returns 500."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_LOCATION])

        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.trigger_reindex_async = AsyncMock(side_effect=RuntimeError("queue full"))
            MockManager.return_value = mock_mgr

            resp = await client.post(f"/v1/file/location/reindex/{LOCATION_ID}")
            assert resp.status_code == 500
            assert "Failed to queue reindex" in resp.json()["detail"]


class TestReindexPauseResumeStopCancel:
    """Tests for reindex lifecycle: pause, resume, stop, cancel."""

    @pytest.mark.asyncio
    async def test_pause_reindex_job(self, client, mock_supabase_client):
        """POST /v1/file/reindex/pause/{job_id} returns success."""
        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.pause_job = AsyncMock(return_value=None)
            MockManager.return_value = mock_mgr

            resp = await client.post(f"/v1/file/reindex/pause/{JOB_ID}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "paused" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_pause_reindex_server_error(self, client):
        """Pause that throws returns 500."""
        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.pause_job = AsyncMock(side_effect=RuntimeError("oops"))
            MockManager.return_value = mock_mgr

            resp = await client.post(f"/v1/file/reindex/pause/{JOB_ID}")
            assert resp.status_code == 500
            assert "Failed to pause" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_resume_reindex_job(self, client, mock_supabase_client):
        """POST /v1/file/reindex/resume/{job_id} returns success."""
        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.resume_job = AsyncMock(return_value=None)
            MockManager.return_value = mock_mgr

            resp = await client.post(f"/v1/file/reindex/resume/{JOB_ID}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "resumed" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_resume_reindex_server_error(self, client):
        """Resume that throws returns 500."""
        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.resume_job = AsyncMock(side_effect=RuntimeError("oops"))
            MockManager.return_value = mock_mgr

            resp = await client.post(f"/v1/file/reindex/resume/{JOB_ID}")
            assert resp.status_code == 500
            assert "Failed to resume" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_stop_reindex_job(self, client, mock_supabase_client):
        """POST /v1/file/reindex/stop/{job_id} returns success."""
        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.stop_job = AsyncMock(return_value=None)
            MockManager.return_value = mock_mgr

            resp = await client.post(f"/v1/file/reindex/stop/{JOB_ID}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "stopped" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_stop_reindex_server_error(self, client):
        """Stop that throws returns 500."""
        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.stop_job = AsyncMock(side_effect=RuntimeError("oops"))
            MockManager.return_value = mock_mgr

            resp = await client.post(f"/v1/file/reindex/stop/{JOB_ID}")
            assert resp.status_code == 500
            assert "Failed to stop" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_cancel_reindex_job(self, client, mock_supabase_client):
        """DELETE /v1/file/reindex/cancel/{job_id} returns success."""
        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.cancel_job = AsyncMock(return_value=None)
            MockManager.return_value = mock_mgr

            resp = await client.delete(f"/v1/file/reindex/cancel/{JOB_ID}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "cancelled" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_cancel_reindex_server_error(self, client):
        """Cancel that throws returns 500."""
        with patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_mgr = MagicMock()
            mock_mgr.cancel_job = AsyncMock(side_effect=RuntimeError("oops"))
            MockManager.return_value = mock_mgr

            resp = await client.delete(f"/v1/file/reindex/cancel/{JOB_ID}")
            assert resp.status_code == 500
            assert "Failed to cancel" in resp.json()["detail"]


class TestReindexStatusExpanded:
    """Additional reindex status tests."""

    @pytest.mark.asyncio
    async def test_reindex_status_zero_files_total(self, client, mock_supabase_client):
        """When files_total is 0, progress_percent should be 0 (no division by zero)."""
        job_data = {
            "id": JOB_ID,
            "location_id": LOCATION_ID,
            "location_name": "Test",
            "status": "running",
            "progress_phase": "initializing",
            "files_scanned": 0,
            "files_total": 0,
            "chunks_processed": 0,
            "error_message": None,
            "started_at": NOW_ISO,
            "completed_at": None,
            "created_at": NOW_ISO,
            "updated_at": NOW_ISO,
        }
        mock_supabase_client.select = AsyncMock(return_value=[job_data])

        resp = await client.get(f"/v1/file/reindex/status/{JOB_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["progress_percent"] == 0
        assert body["files_total"] == 0

    @pytest.mark.asyncio
    async def test_reindex_status_completed(self, client, mock_supabase_client):
        """Completed job returns 100% progress."""
        job_data = {
            "id": JOB_ID,
            "location_id": LOCATION_ID,
            "location_name": "Test",
            "status": "completed",
            "progress_phase": "done",
            "files_scanned": 50,
            "files_total": 50,
            "chunks_processed": 200,
            "error_message": None,
            "started_at": NOW_ISO,
            "completed_at": NOW_ISO,
            "created_at": NOW_ISO,
            "updated_at": NOW_ISO,
        }
        mock_supabase_client.select = AsyncMock(return_value=[job_data])

        resp = await client.get(f"/v1/file/reindex/status/{JOB_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["progress_percent"] == 100
        assert body["status"] == "completed"
        assert body["completed_at"] is not None

    @pytest.mark.asyncio
    async def test_reindex_status_server_error(self, client, mock_supabase_client):
        """Reindex status repo exception returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("DB crash"))

        resp = await client.get(f"/v1/file/reindex/status/{JOB_ID}")
        assert resp.status_code == 500
        assert "Failed to get job status" in resp.json()["detail"]


class TestActiveJobExpanded:
    """Additional active job tests."""

    @pytest.mark.asyncio
    async def test_active_job_response_body(self, client, mock_supabase_client):
        """Active job response includes all expected fields."""
        job = {
            "id": JOB_ID,
            "status": "running",
            "progress_phase": "scanning",
            "files_scanned": 5,
            "files_total": 10,
        }
        mock_supabase_client.select = AsyncMock(return_value=[job])

        resp = await client.get(f"/v1/file/location/active-job/{LOCATION_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["job_id"] == JOB_ID
        assert body["status"] == "running"
        assert body["files_scanned"] == 5
        assert body["files_total"] == 10

    @pytest.mark.asyncio
    async def test_active_job_none_returns_null_job_id(self, client, mock_supabase_client):
        """No active job returns {job_id: null}."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.get(f"/v1/file/location/active-job/{LOCATION_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["job_id"] is None

    @pytest.mark.asyncio
    async def test_active_job_server_error(self, client, mock_supabase_client):
        """Active job repo exception returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("timeout"))

        resp = await client.get(f"/v1/file/location/active-job/{LOCATION_ID}")
        assert resp.status_code == 500
        assert "Failed to get active job" in resp.json()["detail"]


# ===========================================================================
# EXPANDED: Service Health — additional branches
# ===========================================================================

class TestServiceHealthExpanded:
    """Additional health endpoint tests."""

    @pytest.mark.asyncio
    async def test_health_service_never_started(self, client, mock_supabase_client):
        """Health returns 'stopped' when service has no health record."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.get("/v1/file/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["service_status"] == "stopped"
        assert body["last_heartbeat"] is None
        assert body["process_id"] is None

    @pytest.mark.asyncio
    async def test_health_with_active_location(self, client, mock_supabase_client):
        """Health returns active_location name when a location is being indexed."""
        active_loc_id = str(uuid4())
        health_data = {
            "service_status": "indexing",
            "last_heartbeat": NOW_ISO,
            "process_id": 99999,
            "active_location_id": active_loc_id,
            "current_operation": "scanning",
            "operation_progress": {"phase": "scan"},
            "error_message": None,
            "consecutive_errors": 0,
        }
        location_data = {**SAMPLE_LOCATION, "id": active_loc_id, "location_name": "Active Loc"}

        # First select: health, second select: location lookup
        mock_supabase_client.select = AsyncMock(side_effect=[
            [health_data],
            [location_data],
        ])

        resp = await client.get("/v1/file/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["active_location"] == "Active Loc"
        assert body["service_status"] == "indexing"

    @pytest.mark.asyncio
    async def test_health_server_error(self, client, mock_supabase_client):
        """Health endpoint with repo exception returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("DB unavailable"))

        resp = await client.get("/v1/file/health")
        assert resp.status_code == 500
        assert "Failed to retrieve health" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_health_with_naive_heartbeat(self, client, mock_supabase_client):
        """Health handles timezone-naive heartbeat string correctly."""
        naive_ts = datetime.now().isoformat()  # no tzinfo
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "idle",
            "last_heartbeat": naive_ts,
            "process_id": 111,
            "current_operation": None,
            "operation_progress": {},
            "error_message": None,
            "consecutive_errors": 0,
        }])

        resp = await client.get("/v1/file/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["uptime_seconds"] is not None


# ===========================================================================
# EXPANDED: Daemon Status — additional branches
# ===========================================================================

class TestDaemonStatusExpanded:
    """Additional daemon status tests."""

    @pytest.mark.asyncio
    async def test_daemon_status_running(self, client, mock_supabase_client):
        """Daemon status with recent heartbeat shows running=true."""
        recent = datetime.now(timezone.utc).isoformat()
        created = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "running",
            "last_heartbeat": recent,
            "process_id": 12345,
            "current_operation": "idle",
            "created_at": created,
        }])

        resp = await client.get("/v1/file/daemon/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["running"] is True
        assert body["process_id"] == 12345
        assert body["uptime_seconds"] is not None

    @pytest.mark.asyncio
    async def test_daemon_status_stale_heartbeat(self, client, mock_supabase_client):
        """Daemon status with stale heartbeat (>2min old) shows running=false."""
        stale = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "running",
            "last_heartbeat": stale,
            "process_id": 12345,
            "current_operation": None,
            "created_at": stale,
        }])

        resp = await client.get("/v1/file/daemon/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["running"] is False

    @pytest.mark.asyncio
    async def test_daemon_status_no_health(self, client, mock_supabase_client):
        """Daemon status with no health record shows running=false."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.get("/v1/file/daemon/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["running"] is False

    @pytest.mark.asyncio
    async def test_daemon_status_server_error(self, client, mock_supabase_client):
        """Daemon status with repo exception returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("DB crash"))

        resp = await client.get("/v1/file/daemon/status")
        assert resp.status_code == 500
        assert "Failed to retrieve daemon status" in resp.json()["detail"]


# ===========================================================================
# EXPANDED: Daemon Config — POST update
# ===========================================================================

class TestDaemonConfigExpanded:
    """Tests for POST /v1/file/daemon/config"""

    @pytest.fixture(autouse=True)
    def isolate_app_root(self, test_settings, tmp_path):
        """Ensure config_override.json is written to tmp_path instead of dev repo."""
        from unittest.mock import patch
        with patch.object(test_settings, "app_root", tmp_path):
            yield

    @pytest.mark.asyncio
    async def test_update_daemon_config_file_indexing(self, client, mock_supabase_client):
        """Update file_indexing config succeeds."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "id": "00000000-0000-0000-0000-000000000001",
            "heartbeat_interval_seconds": 45,
        }])
        mock_supabase_client.update = AsyncMock(return_value=[{"id": "00000000-0000-0000-0000-000000000001"}])

        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"heartbeat_interval_seconds": 60},
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "file_indexing" in body["updated_daemons"]

    @pytest.mark.asyncio
    async def test_update_daemon_config_browser(self, client, mock_supabase_client):
        """Update browser daemon config via user_preferences."""
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "test"})
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.post("/v1/file/daemon/config", json={
            "browser": {"enabled": False, "scan_interval_seconds": 120},
        })
        assert resp.status_code == 200
        body = resp.json()
        assert "browser" in body["updated_daemons"]

    @pytest.mark.asyncio
    async def test_update_daemon_config_empty(self, client, mock_supabase_client):
        """Update with empty config (no recognized daemon keys) returns 400."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.post("/v1/file/daemon/config", json={})
        assert resp.status_code == 400
        assert "No valid daemon configurations" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_update_daemon_config_multiple(self, client, mock_supabase_client):
        """Update multiple daemons at once.

        NOTE: Typed schemas (EmailDaemonConfigUpdate etc.) only accept HOW
        fields (scan_interval, log_level, etc.). The 'enabled' field is NOT
        part of daemon config — it flows through PATCH /v1/proactive/config
        (proactive_config.json). Sending only 'enabled' results in an empty
        config after Pydantic strips unrecognised fields, so the daemon is
        skipped.
        """
        mock_supabase_client.select = AsyncMock(return_value=[{
            "id": "00000000-0000-0000-0000-000000000001",
        }])
        mock_supabase_client.update = AsyncMock(return_value=[{}])
        mock_supabase_client.upsert = AsyncMock(return_value={})

        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"log_level": "INFO"},
            "email": {"log_level": "WARNING"},
        })
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["updated_daemons"]) == 2

    @pytest.mark.asyncio
    async def test_update_daemon_config_reloads_manager_when_running(self, client, mock_supabase_client, tmp_path):
        """When daemon-manager is running, config update triggers reload."""
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "test"})
        mock_supabase_client.select = AsyncMock(return_value=[])

        with patch(
            "services.daemons.daemon_control.is_daemon_manager_running",
            return_value=True,
        ), patch(
            "services.daemons.daemon_control.reload_daemon_manager",
            return_value=True,
        ) as mock_reload:
            resp = await client.post("/v1/file/daemon/config", json={
                "filesystem": {
                    "watch_locations": [str(tmp_path)],
                    "debounce_seconds": 2,
                },
            })

        assert resp.status_code == 200
        assert mock_reload.called

    @pytest.mark.asyncio
    async def test_update_daemon_config_skips_reload_when_manager_stopped(self, client, mock_supabase_client, tmp_path):
        """When daemon-manager is down, endpoint persists config without reload attempt."""
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "test"})
        mock_supabase_client.select = AsyncMock(return_value=[])

        with patch(
            "services.daemons.daemon_control.is_daemon_manager_running",
            return_value=False,
        ), patch(
            "services.daemons.daemon_control.reload_daemon_manager",
            return_value=True,
        ) as mock_reload:
            resp = await client.post("/v1/file/daemon/config", json={
                "filesystem": {
                    "watch_locations": [str(tmp_path)],
                    "debounce_seconds": 2,
                },
            })

        assert resp.status_code == 200
        mock_reload.assert_not_called()

    @pytest.mark.asyncio
    async def test_update_daemon_config_server_error(self, client, mock_supabase_client):
        """Update config with repo error returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("crash"))

        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"log_level": "DEBUG"},
        })
        assert resp.status_code == 500
        assert "Failed to update daemon configuration" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_get_daemon_config_with_preferences(self, client, mock_supabase_client):
        """GET daemon config merges user preferences with defaults."""
        # First select: file_indexing_config; second: user_preferences
        mock_supabase_client.select = AsyncMock(side_effect=[
            [{"heartbeat_interval_seconds": 30}],  # daemon config
            [{"preference_key": "daemon_browser", "preference_value": {"enabled": False}}],  # user prefs
        ])

        resp = await client.get("/v1/file/daemon/config")
        assert resp.status_code == 200
        body = resp.json()
        assert "browser" in body
        assert "email" in body
        assert "file_indexing" in body
        assert "filesystem" in body


# ===========================================================================
# FileIndexingDaemonConfigUpdate Pydantic validation
# ===========================================================================

class TestFileIndexingConfigValidation:
    """Tests that FileIndexingDaemonConfigUpdate rejects invalid input at the Pydantic level."""

    @pytest.mark.asyncio
    async def test_rejects_negative_heartbeat_interval(self, client):
        """heartbeat_interval_seconds < 1 is rejected by Pydantic (422)."""
        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"heartbeat_interval_seconds": 0},
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rejects_negative_scan_check_interval(self, client):
        """scan_check_interval_seconds < 1 is rejected by Pydantic (422)."""
        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"scan_check_interval_seconds": -5},
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rejects_max_concurrent_scans_out_of_range(self, client):
        """max_concurrent_scans outside 1-10 is rejected."""
        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"max_concurrent_scans": 50},
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rejects_zero_max_concurrent_scans(self, client):
        """max_concurrent_scans = 0 is rejected."""
        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"max_concurrent_scans": 0},
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rejects_invalid_log_level(self, client):
        """Invalid log_level string is rejected."""
        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"log_level": "TRACE"},
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rejects_empty_embedding_model(self, client):
        """Empty or whitespace-only aether_rag_embedding_model is rejected."""
        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"aether_rag_embedding_model": "   "},
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rejects_oversized_embedding_model(self, client):
        """aether_rag_embedding_model > 200 chars is rejected."""
        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"aether_rag_embedding_model": "x" * 201},
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rejects_arbitrary_keys(self, client):
        """Unknown keys (id, created_at) are stripped by Pydantic — only known fields pass through."""
        # Pydantic BaseModel ignores unknown fields by default (they are dropped).
        # Sending ONLY unknown keys results in an all-None model → empty dict → skipped.
        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"id": "injected", "created_at": "2099-01-01"},
        })
        # file_indexing model_dump(exclude_none=True) is empty → no update → 400
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_accepts_valid_file_indexing_config(self, client, mock_supabase_client):
        """Valid file_indexing fields are accepted and forwarded to DB."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "id": "00000000-0000-0000-0000-000000000001",
        }])
        mock_supabase_client.update = AsyncMock(return_value=[{}])

        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {
                "heartbeat_interval_seconds": 45,
                "scan_check_interval_seconds": 120,
                "max_concurrent_scans": 3,
                "log_level": "debug",
                "aether_rag_embedding_model": "Xenova/bge-small-en-v1.5",
            },
        })
        assert resp.status_code == 200
        body = resp.json()
        assert "file_indexing" in body["updated_daemons"]

    @pytest.mark.asyncio
    async def test_log_level_normalized_to_uppercase(self, client, mock_supabase_client):
        """log_level is normalized to uppercase before storage."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "id": "00000000-0000-0000-0000-000000000001",
        }])
        mock_supabase_client.update = AsyncMock(return_value=[{}])

        resp = await client.post("/v1/file/daemon/config", json={
            "file_indexing": {"log_level": "warning"},
        })
        assert resp.status_code == 200
        # Verify the update was called with uppercase log_level
        mock_supabase_client.update.assert_called_once()
        # gateway.update(table, data_dict, record_id=..., admin=True)
        # positional args: [0]=table, [1]=data_dict
        call_args = mock_supabase_client.update.call_args
        data_dict = call_args[0][1]
        assert isinstance(data_dict, dict), f"Expected dict, got {type(data_dict)}"
        assert "log_level" in data_dict, f"log_level missing from update data: {data_dict}"
        assert data_dict["log_level"] == "WARNING"


# ===========================================================================
# EXPANDED: Daemon Control — restart, stop, start
# ===========================================================================

class TestDaemonRestart:
    """Tests for POST /v1/file/daemon/restart"""

    @pytest.mark.asyncio
    async def test_restart_no_health(self, client, mock_supabase_client):
        """Restart when no health data returns not-running message."""
        mock_supabase_client.select = AsyncMock(return_value=[])

        resp = await client.post("/v1/file/daemon/restart")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is False
        assert "not running" in body["message"].lower() or "unavailable" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_restart_no_pid(self, client, mock_supabase_client):
        """Restart when health exists but no PID."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "idle",
            "process_id": None,
        }])

        resp = await client.post("/v1/file/daemon/restart")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is False
        assert "pid" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_restart_process_not_found(self, client, mock_supabase_client):
        """Restart when PID no longer exists returns graceful message."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "running",
            "process_id": 999999999,  # highly unlikely PID
        }])

        with patch("os.kill", side_effect=ProcessLookupError):
            resp = await client.post("/v1/file/daemon/restart")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
            assert "not found" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_restart_permission_denied(self, client, mock_supabase_client):
        """Restart when no permission returns graceful message."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "running",
            "process_id": 1,
        }])

        with patch("os.kill", side_effect=PermissionError):
            resp = await client.post("/v1/file/daemon/restart")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
            assert "permission" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_restart_success(self, client, mock_supabase_client):
        """Restart sends SIGTERM successfully."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "running",
            "process_id": 12345,
        }])

        with patch("os.kill") as mock_kill:
            mock_kill.return_value = None
            resp = await client.post("/v1/file/daemon/restart")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "12345" in body["message"]


# ===========================================================================
# EXPANDED: Daemon Logs and Search
# ===========================================================================

class TestDaemonLogs:
    """Tests for GET /v1/file/daemon/{daemon_name}/logs"""

    @pytest.mark.asyncio
    async def test_daemon_logs_invalid_name(self, client):
        """Logs for invalid daemon name returns 400."""
        resp = await client.get("/v1/file/daemon/invalid/logs")
        assert resp.status_code == 400
        assert "Invalid daemon name" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_daemon_logs_db_not_found(self, client):
        """Logs when SQLite DB doesn't exist returns 200 (empty) or 404/500."""
        resp = await client.get("/v1/file/daemon/browser/logs")
        assert resp.status_code in (200, 404, 500)


class TestDaemonSearch:
    """Tests for GET /v1/file/daemon/{daemon_name}/search"""

    @pytest.mark.asyncio
    async def test_daemon_search_invalid_name(self, client):
        """Search for invalid daemon name returns 400."""
        resp = await client.get("/v1/file/daemon/invalid/search?query=test")
        assert resp.status_code == 400
        assert "migrated to AETHER_RAG" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_daemon_search_no_index(self, client):
        """Search when index not yet created returns empty results."""
        resp = await client.get("/v1/file/daemon/query_gen/search?query=test")
        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 0
        assert body["results"] == []
        assert "not yet created" in body.get("message", "")


class TestDaemonStatsExpanded:
    """Additional daemon stats tests."""

    @pytest.mark.asyncio
    async def test_daemon_stats_response_structure(self, app, client, tmp_path):
        """Stats endpoint returns expected structure.

        Uses tmp_path as settings.app_root so daemon DB paths are controlled
        and don't depend on actual filesystem state (prevents flaky failures
        from corrupted/missing SQLite DBs on disk).
        """
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        mock_settings.app_root = tmp_path

        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            resp = await client.get("/v1/file/daemon/stats")
            assert resp.status_code == 200
            body = resp.json()
            assert "timestamp" in body
            assert "daemons" in body
            assert isinstance(body["daemons"], dict)
            for daemon_name in ["browser", "email", "filesystem"]:
                assert daemon_name in body["daemons"]
                assert "status" in body["daemons"][daemon_name]
                assert "total_logs" in body["daemons"][daemon_name]
        finally:
            app.dependency_overrides.pop(get_settings, None)


class TestDaemonDataDeletionExpanded:
    """Additional daemon data deletion tests."""

    @pytest.mark.asyncio
    async def test_delete_valid_daemon_no_data(self, client):
        """Delete data for valid daemon with no existing data returns success."""
        resp = await client.delete("/v1/file/daemon/browser/data")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True

    @pytest.mark.asyncio
    async def test_delete_all_daemon_data_response_structure(self, client):
        """Delete all daemon data returns structured response."""
        resp = await client.delete("/v1/file/daemon/data/all")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert isinstance(body["deleted_items"], list)


class TestQueryGenerationEndpoints:
    """Tests for query generation daemon endpoints."""

    @pytest.mark.asyncio
    async def test_query_generation_queries_endpoint_exists(self, client):
        """Queries endpoint is reachable and returns structured response."""
        resp = await client.get("/v1/file/daemon/query_generation/queries")
        # QueryGenerationDB creates DB if missing -> may return 200 with empty results
        assert resp.status_code == 200
        body = resp.json()
        assert "count" in body
        assert "queries" in body

    @pytest.mark.asyncio
    async def test_query_generation_stats_endpoint_exists(self, client):
        """Stats endpoint is reachable and returns structured response."""
        resp = await client.get("/v1/file/daemon/query_generation/stats")
        assert resp.status_code == 200
        body = resp.json()
        assert "status" in body


# ===========================================================================
# DEEP: File Upload — boundary conditions (413 too large, decode error)
# ===========================================================================

class TestFileUploadBoundary:
    """
    Tests for upload size validation (lines 128-133) and
    decode error handling (lines 155-160).
    """

    @pytest.mark.asyncio
    async def test_upload_too_large_returns_413(self, client, mock_supabase_client):
        """File exceeding MAX_FILE_SIZE_BYTES returns 413."""
        from security.sanitization import DEFAULT_LIMITS
        # Create content just over the limit
        oversized = b"x" * (DEFAULT_LIMITS.MAX_FILE_SIZE_BYTES + 1)
        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("big.txt", io.BytesIO(oversized), "text/plain")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 413
        assert "too large" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_upload_empty_file_returns_400(self, client, mock_supabase_client):
        """Empty file (0 bytes) returns 400."""
        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("empty.txt", io.BytesIO(b""), "text/plain")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 400
        assert "empty" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_upload_text_file_invalid_utf8_returns_400(
        self, client, mock_supabase_client,
    ):
        """Text file with invalid UTF-8 bytes returns 400 decode error."""
        # 0xff 0xfe is invalid leading byte in UTF-8
        bad_bytes = b"\xff\xfe this is not valid utf-8"
        resp = await client.post(
            "/v1/file/upload",
            files={"file": ("broken.txt", io.BytesIO(bad_bytes), "text/plain")},
            data={"purpose": "attachment"},
        )
        assert resp.status_code == 400
        assert "encoding" in resp.json()["detail"].lower()


# ===========================================================================
# DEEP: Daemon Stop — platform-specific branches (lines 1079-1152)
# ===========================================================================

class TestDaemonStop:
    """
    Tests for POST /v1/file/daemon/stop
    Covers: macOS launchctl, Windows schtasks, Linux systemctl,
    unsupported platform, plist not found, security toggle.
    """

    @pytest.mark.asyncio
    async def test_stop_disabled_by_config(self, app, client):
        """allow_local_os_tools=False returns 403."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = False
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with patch("api.v1.endpoints.files.require_local_request"):
                resp = await client.post("/v1/file/daemon/stop")
            assert resp.status_code == 403
            assert "disabled" in resp.json()["message"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stop_macos_success(self, app, client):
        """macOS: launchctl unload succeeds."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Darwin"),
                patch("pathlib.Path.exists", return_value=True),
                patch("subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=0, stderr="")
                resp = await client.post("/v1/file/daemon/stop")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "stopped" in body["message"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stop_macos_plist_not_found(self, app, client):
        """macOS: plist file missing returns success=False."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Darwin"),
                patch("pathlib.Path.exists", return_value=False),
            ):
                resp = await client.post("/v1/file/daemon/stop")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
            assert "not found" in body["message"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stop_macos_unload_fails(self, app, client):
        """macOS: launchctl unload fails."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Darwin"),
                patch("pathlib.Path.exists", return_value=True),
                patch("subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(
                    returncode=1, stderr="Operation not permitted",
                )
                resp = await client.post("/v1/file/daemon/stop")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
            assert "failed" in body["message"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stop_windows(self, app, client):
        """Windows: schtasks /End succeeds."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Windows"),
                patch("subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=0)
                resp = await client.post("/v1/file/daemon/stop")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stop_linux_success(self, app, client):
        """Linux: systemctl stop succeeds."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Linux"),
                patch("subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(
                    returncode=0, stderr="", stdout="",
                )
                resp = await client.post("/v1/file/daemon/stop")
            assert resp.status_code == 200
            assert resp.json()["success"] is True
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stop_linux_failure(self, app, client):
        """Linux: systemctl stop fails."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Linux"),
                patch("subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(
                    returncode=1, stderr="Unit not found",
                )
                resp = await client.post("/v1/file/daemon/stop")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stop_unsupported_platform(self, app, client):
        """Unsupported platform returns success=False."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="FreeBSD"),
            ):
                resp = await client.post("/v1/file/daemon/stop")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
            assert "not supported" in body["message"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stop_generic_exception(self, app, client):
        """Generic exception in stop returns success=False."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request",
                      side_effect=RuntimeError("boom")),
            ):
                resp = await client.post("/v1/file/daemon/stop")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
        finally:
            app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# DEEP: Daemon Start — platform-specific branches (lines 1162-1264)
# ===========================================================================

class TestDaemonStart:
    """
    Tests for POST /v1/file/daemon/start
    Covers: macOS launchctl load, Windows schtasks /Create + /Run,
    Linux systemctl start, unsupported platform, security toggle.
    """

    @pytest.mark.asyncio
    async def test_start_disabled_by_config(self, app, client):
        """allow_local_os_tools=False returns 403."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = False
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with patch("api.v1.endpoints.files.require_local_request"):
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 403
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_start_macos_success(self, app, client):
        """macOS: launchctl load succeeds."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Darwin"),
                patch("pathlib.Path.exists", return_value=True),
                patch("subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(returncode=0, stderr="")
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is True
            assert "started" in resp.json()["message"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_start_macos_plist_not_found(self, app, client):
        """macOS: plist missing returns success=False."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Darwin"),
                patch("pathlib.Path.exists", return_value=False),
            ):
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is False
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_start_macos_load_fails(self, app, client):
        """macOS: launchctl load fails."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Darwin"),
                patch("pathlib.Path.exists", return_value=True),
                patch("subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(
                    returncode=1, stderr="Permission denied",
                )
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is False
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_start_windows_success(self, app, client):
        """Windows: schtasks /Create + /Run succeeds."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        mock_settings.config_dir = "/fake/config"
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Windows"),
                patch("subprocess.run") as mock_run,
                patch("sys.frozen", False, create=True),
            ):
                mock_run.return_value = MagicMock(
                    returncode=0, stderr="", stdout="",
                )
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is True
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_start_linux_success(self, app, client):
        """Linux: systemctl start succeeds."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Linux"),
                patch("subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(
                    returncode=0, stderr="",
                )
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is True
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_start_linux_failure(self, app, client):
        """Linux: systemctl start fails."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Linux"),
                patch("subprocess.run") as mock_run,
            ):
                mock_run.return_value = MagicMock(
                    returncode=1, stderr="Unit not found",
                )
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is False
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_start_unsupported_platform(self, app, client):
        """Unsupported platform returns success=False."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="FreeBSD"),
            ):
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is False
            assert "not supported" in resp.json()["message"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_start_generic_exception(self, app, client):
        """Generic exception returns success=False."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with patch(
                "api.v1.endpoints.files.require_local_request",
                side_effect=RuntimeError("unexpected"),
            ):
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is False
        finally:
            app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# DEEP: Daemon Logs — SQLite query with filters (lines 1309-1341)
# ===========================================================================

class TestDaemonLogsDeep:
    """
    Tests for GET /v1/file/daemon/{daemon_name}/logs with query filters.
    Mocks sqlite3.connect to test query building without real DB.
    """

    @pytest.mark.asyncio
    async def test_logs_success_with_results(self, client):
        """Successful log query returns structured response."""
        fake_rows = [
            {"id": 1, "timestamp": "2024-01-01T00:00:00Z", "indexed": 1},
            {"id": 2, "timestamp": "2024-01-01T01:00:00Z", "indexed": 0},
        ]
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = [MagicMock(**{
            "keys.return_value": list(r.keys()),
            "__getitem__": lambda self, k, row=r: row[k],
        }) for r in fake_rows]
        mock_conn.cursor.return_value = mock_cursor
        mock_conn.row_factory = None
        
        mock_path = MagicMock()
        mock_path.exists.return_value = True

        with (
            patch("sqlite3.connect", return_value=mock_conn),
            patch(
                "data.database.repositories.daemon_logs.DaemonLogsRepository._get_daemon_db_path",
                return_value=mock_path,
            ),
        ):
            resp = await client.get("/v1/file/daemon/browser/logs")
        assert resp.status_code == 200
        body = resp.json()
        assert body["daemon"] == "browser"
        assert "count" in body
        assert "logs" in body

    @pytest.mark.asyncio
    async def test_logs_exception_returns_500(self, client):
        """SQLite failure returns 500."""
        with patch(
            "data.database.repositories.daemon_logs.DaemonLogsRepository._get_daemon_db_path",
            side_effect=RuntimeError("DB corrupted"),
        ):
            resp = await client.get("/v1/file/daemon/browser/logs")
        assert resp.status_code == 500
        assert "failed" in resp.json()["detail"].lower()


# ===========================================================================
# DEEP: Daemon Search — PyTerrier BM25 (lines 1386-1406)
# ===========================================================================

class TestDaemonSearchDeep:
    """
    Tests for GET /v1/file/daemon/{daemon_name}/search with PyTerrier.
    Mocks pyterrier to avoid external dependency.
    """

    @pytest.mark.asyncio
    async def test_search_with_index_success(self, app, client):
        """Search with existing index returns results."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.app_root = MagicMock()
        mock_index_path = MagicMock()
        mock_index_path.__truediv__ = MagicMock(return_value=mock_index_path)
        mock_index_path.exists.return_value = True  # data.properties exists
        mock_settings.app_root.__truediv__ = MagicMock(return_value=mock_index_path)
        app.dependency_overrides[get_settings] = lambda: mock_settings

        mock_df = MagicMock()
        mock_df.head.return_value.to_dict.return_value = [
            {"docno": "1", "score": 0.95, "text": "result 1"},
        ]

        mock_pt = MagicMock()
        mock_pt.started.return_value = True
        mock_bm25 = MagicMock()
        mock_bm25.search.return_value = mock_df
        mock_pt.BatchRetrieve.return_value = mock_bm25

        try:
            with (
                patch.dict("sys.modules", {"pyterrier": mock_pt}),
                patch(
                    "api.v1.endpoints.files._get_daemon_index_path",
                    return_value=mock_index_path,
                ),
            ):
                resp = await client.get(
                    "/v1/file/daemon/query_gen/search?query=test",
                )
            assert resp.status_code == 200
            body = resp.json()
            assert body["daemon"] == "query_gen"
            assert body["count"] == 1
            assert len(body["results"]) == 1
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_search_exception_returns_500(self, app, client):
        """PyTerrier failure returns 500."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_index_path = MagicMock()
        mock_index_path.__truediv__ = MagicMock(return_value=mock_index_path)
        mock_index_path.exists.return_value = True
        mock_settings.app_root.__truediv__ = MagicMock(return_value=mock_index_path)
        app.dependency_overrides[get_settings] = lambda: mock_settings

        try:
            with patch(
                "api.v1.endpoints.files._get_daemon_index_path",
                return_value=mock_index_path,
            ):
                # pyterrier import will fail -> caught by except
                with patch.dict("sys.modules", {"pyterrier": None}):
                    resp = await client.get(
                        "/v1/file/daemon/query_gen/search?query=test",
                    )
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# DEEP: Daemon Restart — security toggle (line 1025)
# ===========================================================================

class TestDaemonRestartSecurity:
    """Test the allow_local_os_tools=False branch for restart."""

    @pytest.mark.asyncio
    async def test_restart_disabled_by_config(self, app, client, mock_supabase_client):
        """allow_local_os_tools=False returns 403."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = False
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with patch("api.v1.endpoints.files.require_local_request"):
                resp = await client.post("/v1/file/daemon/restart")
            assert resp.status_code == 403
        finally:
            app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# DEEP: Daemon Config — query_generation override file (lines 975-980)
# ===========================================================================

class TestDaemonConfigOverride:
    """Test the query_generation config override file write."""

    @pytest.mark.asyncio
    async def test_config_update_query_generation_writes_override(
        self, app, client, mock_supabase_client,
    ):
        """Updating query_generation config writes override JSON file."""
        from api.dependencies import get_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        with tempfile.TemporaryDirectory() as tmpdir:
            mock_settings.app_root = Path(tmpdir)
            app.dependency_overrides[get_settings] = lambda: mock_settings
            mock_supabase_client.upsert = AsyncMock(return_value=[{"id": "1"}])
            try:
                with patch("api.v1.endpoints.files.require_local_request"):
                    resp = await client.post(
                        "/v1/file/daemon/config",
                        json={
                            "query_generation": {
                                "enabled": True,
                                "check_interval_seconds": 300,
                            }
                        },
                    )
                assert resp.status_code == 200
                body = resp.json()
                assert body["success"] is True
                assert "query_generation" in body["updated_daemons"]

                override_file = (
                    Path(tmpdir)
                    / "data"
                    / "daemons"
                    / "query_generation"
                    / "config_override.json"
                )
                assert override_file.exists()
                persisted = json.loads(override_file.read_text())
                assert persisted["enabled"] is True
                assert persisted["check_interval_seconds"] == 300
            finally:
                app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# COVERAGE: delete_indexing_location — rmtree success + exception (lines 405-407)
# ===========================================================================

class TestDeleteLocationRmtree:
    """Tests for index directory cleanup in delete_indexing_location."""

    @pytest.mark.asyncio
    async def test_delete_location_rmtree_success(self, client, mock_supabase_client):
        """Delete location where index_dir is under safe_parent triggers rmtree (line 405)."""
        import tempfile
        import os

        with tempfile.TemporaryDirectory() as tmpdir:
            root = os.path.join(tmpdir, "docs")
            index = os.path.join(root, ".aether_rag_index", "my_index")
            os.makedirs(index)

            loc = {
                **SAMPLE_LOCATION,
                "root_path": root,
                "index_directory": index,
            }
            mock_supabase_client.select = AsyncMock(return_value=[loc])
            mock_supabase_client.delete = AsyncMock(return_value=None)

            resp = await client.delete(f"/v1/file/location/delete/{LOCATION_ID}")
            assert resp.status_code == 204
            # index directory was removed
            assert not os.path.exists(index)

    @pytest.mark.asyncio
    async def test_delete_location_rmtree_exception_logged(self, client, mock_supabase_client):
        """Delete location where root_path is None triggers inner except (lines 406-407)."""
        loc = {**SAMPLE_LOCATION, "root_path": None}
        mock_supabase_client.select = AsyncMock(return_value=[loc])
        mock_supabase_client.delete = AsyncMock(return_value=None)

        # PathLib(None) raises TypeError, caught by inner except, logged and continues
        resp = await client.delete(f"/v1/file/location/delete/{LOCATION_ID}")
        assert resp.status_code == 204


# ===========================================================================
# COVERAGE: get_indexing_service_health — no last_heartbeat (line 717)
# ===========================================================================

class TestServiceHealthNoHeartbeat:
    """Test health endpoint when last_heartbeat is missing."""

    @pytest.mark.asyncio
    async def test_health_no_last_heartbeat(self, client, mock_supabase_client):
        """Health record without last_heartbeat sets uptime=None (line 717)."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "idle",
            "last_heartbeat": None,
            "process_id": None,
            "active_location_id": None,
            "current_operation": None,
            "operation_progress": {},
            "error_message": None,
            "consecutive_errors": 0,
            "uptime_seconds": None,
        }])

        resp = await client.get("/v1/file/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["uptime_seconds"] is None


# ===========================================================================
# COVERAGE: get_daemon_status — naive timestamps + no created_at (lines 791, 804, 808)
# ===========================================================================

class TestDaemonStatusNaiveTimestamps:
    """Test daemon status with timezone-naive timestamps and missing created_at."""

    @pytest.mark.asyncio
    async def test_status_naive_last_heartbeat(self, client, mock_supabase_client):
        """Naive last_heartbeat (no tzinfo) triggers replace(tzinfo=utc) (line 791)."""
        # Naive timestamp string — no +00:00 suffix
        naive_ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "running",
            "last_heartbeat": naive_ts,
            "process_id": 111,
            "current_operation": "idle",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }])

        resp = await client.get("/v1/file/daemon/status")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_status_naive_created_at(self, client, mock_supabase_client):
        """Naive created_at (no tzinfo) triggers replace(tzinfo=utc) (line 804)."""
        recent = datetime.now(timezone.utc).isoformat()
        # created_at without timezone
        naive_created = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "running",
            "last_heartbeat": recent,
            "process_id": 222,
            "current_operation": "idle",
            "created_at": naive_created,
        }])

        resp = await client.get("/v1/file/daemon/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["running"] is True
        assert body["uptime_seconds"] is not None

    @pytest.mark.asyncio
    async def test_status_running_no_created_at(self, client, mock_supabase_client):
        """Running daemon without created_at falls back to uptime_seconds=None (line 808)."""
        recent = datetime.now(timezone.utc).isoformat()
        mock_supabase_client.select = AsyncMock(return_value=[{
            "service_status": "running",
            "last_heartbeat": recent,
            "process_id": 333,
            "current_operation": "idle",
            # no "created_at" key
        }])

        resp = await client.get("/v1/file/daemon/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["running"] is True
        assert body["uptime_seconds"] is None


# ===========================================================================
# COVERAGE: get_daemon_config — user_prefs error + outer exception (lines 855-858, 916-918)
# ===========================================================================

class TestDaemonConfigDeep:
    """Deep tests for daemon config endpoint covering DB error paths."""

    @pytest.mark.asyncio
    async def test_config_user_prefs_db_exception(self, app, client, mock_supabase_client):
        """database.select('user_preferences') raises → caught by inner except (lines 856-858)."""
        from api.dependencies import get_database, require_file_indexing_repository, get_settings

        mock_repo = MagicMock()
        mock_repo.get_daemon_config = AsyncMock(return_value={"log_level": "DEBUG"})

        mock_settings = MagicMock()
        mock_settings.proactive.browser.enabled = False
        mock_settings.proactive.browser.scan_interval_seconds = 300
        mock_settings.proactive.browser.retention_days = 30
        mock_settings.proactive.browser.bm25_index_interval_seconds = 600
        mock_settings.proactive.browser.browser = "chrome"
        mock_settings.proactive.browser.excluded_profiles = []
        mock_settings.proactive.browser.log_level = "INFO"
        mock_settings.proactive.email.enabled = False
        mock_settings.proactive.email.scan_interval_seconds = 600
        mock_settings.proactive.email.retention_days = 90
        mock_settings.proactive.email.max_emails_per_scan = 100
        mock_settings.proactive.email.log_level = "INFO"
        mock_settings.proactive.filesystem.enabled = False
        mock_settings.proactive.filesystem.watch_locations = []
        mock_settings.proactive.filesystem.debounce_seconds = 5
        mock_settings.proactive.filesystem.retention_days = 30
        mock_settings.proactive.filesystem.log_level = "INFO"
        mock_settings.proactive.query_generation.enabled = False
        mock_settings.proactive.query_generation.check_interval_seconds = 300
        mock_settings.proactive.query_generation.context_size = 5
        mock_settings.proactive.query_generation.max_query_terms = 10
        mock_settings.proactive.query_generation.llm_model = None
        mock_settings.proactive.query_generation.log_level = "INFO"
        mock_settings.embedding_service.model = "text-embedding-3-small"
        mock_settings.llm.model = "gpt-4o"

        async def mock_get_db():
            mock_db = MagicMock()
            mock_db.select = AsyncMock(side_effect=RuntimeError("DB crash"))
            yield mock_db

        app.dependency_overrides[require_file_indexing_repository] = lambda: mock_repo
        app.dependency_overrides[get_database] = mock_get_db
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            resp = await client.get("/v1/file/daemon/config")
            assert resp.status_code == 200
            body = resp.json()
            # user_prefs fell back to [] → defaults from settings used
            assert "browser" in body
            assert "email" in body
        finally:
            app.dependency_overrides.pop(require_file_indexing_repository, None)
            app.dependency_overrides.pop(get_database, None)
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_config_user_prefs_non_list(self, app, client, mock_supabase_client):
        """database.select returns non-list → user_prefs = [] (line 855)."""
        from api.dependencies import get_database, require_file_indexing_repository, get_settings

        mock_repo = MagicMock()
        mock_repo.get_daemon_config = AsyncMock(return_value={"log_level": "DEBUG"})

        mock_settings = MagicMock()
        mock_settings.proactive.browser.enabled = False
        mock_settings.proactive.browser.scan_interval_seconds = 300
        mock_settings.proactive.browser.retention_days = 30
        mock_settings.proactive.browser.bm25_index_interval_seconds = 600
        mock_settings.proactive.browser.browser = "chrome"
        mock_settings.proactive.browser.excluded_profiles = []
        mock_settings.proactive.browser.log_level = "INFO"
        mock_settings.proactive.email.enabled = False
        mock_settings.proactive.email.scan_interval_seconds = 600
        mock_settings.proactive.email.retention_days = 90
        mock_settings.proactive.email.max_emails_per_scan = 100
        mock_settings.proactive.email.log_level = "INFO"
        mock_settings.proactive.filesystem.enabled = False
        mock_settings.proactive.filesystem.watch_locations = []
        mock_settings.proactive.filesystem.debounce_seconds = 5
        mock_settings.proactive.filesystem.retention_days = 30
        mock_settings.proactive.filesystem.log_level = "INFO"
        mock_settings.proactive.query_generation.enabled = False
        mock_settings.proactive.query_generation.check_interval_seconds = 300
        mock_settings.proactive.query_generation.context_size = 5
        mock_settings.proactive.query_generation.max_query_terms = 10
        mock_settings.proactive.query_generation.llm_model = None
        mock_settings.proactive.query_generation.log_level = "INFO"
        mock_settings.embedding_service.model = "text-embedding-3-small"
        mock_settings.llm.model = "gpt-4o"

        async def mock_get_db():
            mock_db = MagicMock()
            mock_db.select = AsyncMock(return_value="not-a-list")
            yield mock_db

        app.dependency_overrides[require_file_indexing_repository] = lambda: mock_repo
        app.dependency_overrides[get_database] = mock_get_db
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            resp = await client.get("/v1/file/daemon/config")
            assert resp.status_code == 200
            body = resp.json()
            assert "browser" in body
        finally:
            app.dependency_overrides.pop(require_file_indexing_repository, None)
            app.dependency_overrides.pop(get_database, None)
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_config_outer_exception(self, app, client, mock_supabase_client):
        """repository.get_daemon_config() raises → outer except (lines 916-918)."""
        from api.dependencies import require_file_indexing_repository

        mock_repo = MagicMock()
        mock_repo.get_daemon_config = AsyncMock(side_effect=RuntimeError("repo crash"))
        app.dependency_overrides[require_file_indexing_repository] = lambda: mock_repo
        try:
            resp = await client.get("/v1/file/daemon/config")
            assert resp.status_code == 500
            assert "daemon configuration" in resp.json()["detail"].lower()
        finally:
            app.dependency_overrides.pop(require_file_indexing_repository, None)


# ===========================================================================
# COVERAGE: restart_daemon — generic exception (lines 1064-1066)
# ===========================================================================

class TestDaemonRestartException:
    """Test restart_daemon outer exception handler."""

    @pytest.mark.asyncio
    async def test_restart_generic_exception(self, app, client, mock_supabase_client):
        """Unexpected error in restart triggers outer except (lines 1064-1066)."""
        from api.dependencies import require_file_indexing_repository

        mock_repo = MagicMock()
        mock_repo.get_service_health = AsyncMock(side_effect=RuntimeError("repo crash"))
        app.dependency_overrides[require_file_indexing_repository] = lambda: mock_repo
        try:
            resp = await client.post("/v1/file/daemon/restart")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
            assert "restart failed" in body["message"].lower()
        finally:
            app.dependency_overrides.pop(require_file_indexing_repository, None)


# ===========================================================================
# COVERAGE: start_daemon — frozen binary + Windows run failure (lines 1211-1212, 1244-1245)
# ===========================================================================

class TestDaemonStartDeep:
    """Deep tests for start_daemon covering frozen binary and Windows run failure."""

    @pytest.mark.asyncio
    async def test_start_windows_frozen_binary(self, app, client):
        """Windows start with sys.frozen=True uses sys.executable directly (lines 1211-1212)."""
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        mock_settings.config_dir = "/fake/config"
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Windows"),
                patch("subprocess.run") as mock_run,
            ):
                # Simulate frozen binary
                with patch("sys.frozen", True, create=True):
                    mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")
                    resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is True
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_start_windows_run_failure(self, app, client):
        """Windows schtasks /Run failure returns success=False (lines 1244-1245)."""
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = True
        mock_settings.config_dir = "/fake/config"
        app.dependency_overrides[get_settings] = lambda: mock_settings
        call_count = 0

        def mock_subprocess_run(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # First call: schtasks /Create → success
                return MagicMock(returncode=0, stderr="", stdout="")
            else:
                # Second call: schtasks /Run → failure
                return MagicMock(returncode=1, stderr="Access denied", stdout="")

        try:
            with (
                patch("api.v1.endpoints.files.require_local_request"),
                patch("platform.system", return_value="Windows"),
                patch("subprocess.run", side_effect=mock_subprocess_run),
                patch("sys.frozen", False, create=True),
            ):
                resp = await client.post("/v1/file/daemon/start")
            assert resp.status_code == 200
            assert resp.json()["success"] is False
            assert "start failed" in resp.json()["message"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# COVERAGE: get_daemon_logs — filters (lines 1322-1324, 1327)
# ===========================================================================

class TestDaemonLogsFilters:
    """Test daemon logs endpoint with hours_back and only_unindexed filters."""

    @pytest.mark.asyncio
    async def test_logs_with_hours_back_filter(self, client):
        """Logs with hours_back adds timestamp filter to query (lines 1322-1324)."""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = []
        mock_conn.cursor.return_value = mock_cursor
        
        mock_path = MagicMock()
        mock_path.exists.return_value = True

        with (
            patch("sqlite3.connect", return_value=mock_conn),
            patch("data.database.repositories.daemon_logs.DaemonLogsRepository._get_daemon_db_path", return_value=mock_path),
        ):
            resp = await client.get("/v1/file/daemon/browser/logs?hours_back=24")
        assert resp.status_code == 200
        body = resp.json()
        assert body["filters"]["hours_back"] == 24

    @pytest.mark.asyncio
    async def test_logs_with_only_unindexed_filter(self, client):
        """Logs with only_unindexed=true adds index filter to query (line 1327)."""
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = []
        mock_conn.cursor.return_value = mock_cursor

        mock_path = MagicMock()
        mock_path.exists.return_value = True

        with (
            patch("sqlite3.connect", return_value=mock_conn),
            patch("data.database.repositories.daemon_logs.DaemonLogsRepository._get_daemon_db_path", return_value=mock_path),
        ):
            resp = await client.get("/v1/file/daemon/browser/logs?only_unindexed=true")
        assert resp.status_code == 200
        body = resp.json()
        assert body["filters"]["only_unindexed"] is True


# ===========================================================================
# COVERAGE: search_daemon_index — pt.init() when not started (line 1388)
# ===========================================================================

class TestDaemonSearchPtInit:
    """Test search_daemon_index when PyTerrier needs init."""

    @pytest.mark.asyncio
    async def test_search_pyterrier_needs_init(self, app, client):
        """pt.started() returns False → pt.init() called (line 1388)."""
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        mock_index_path = MagicMock()
        mock_index_path.__truediv__ = MagicMock(return_value=mock_index_path)
        mock_index_path.exists.return_value = True
        mock_settings.app_root.__truediv__ = MagicMock(return_value=mock_index_path)
        app.dependency_overrides[get_settings] = lambda: mock_settings

        mock_df = MagicMock()
        mock_df.head.return_value.to_dict.return_value = []

        mock_pt = MagicMock()
        mock_pt.started.return_value = False  # needs init
        mock_bm25 = MagicMock()
        mock_bm25.search.return_value = mock_df
        mock_pt.BatchRetrieve.return_value = mock_bm25

        try:
            with (
                patch.dict("sys.modules", {"pyterrier": mock_pt}),
                patch(
                    "api.v1.endpoints.files._get_daemon_index_path",
                    return_value=mock_index_path,
                ),
            ):
                resp = await client.get("/v1/file/daemon/query_gen/search?query=test")
            assert resp.status_code == 200
            mock_pt.init.assert_called_once()
        finally:
            app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# COVERAGE: get_daemon_stats — table missing + per-daemon exception (lines 1449-1455, 1477-1479)
# ===========================================================================

class TestDaemonStatsDeep:
    """Deep tests for daemon stats edge cases."""

    @pytest.mark.asyncio
    async def test_stats_table_not_exists(self, app, client):
        """When SQLite table doesn't exist, returns 'initializing' status (lines 1449-1455)."""
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        # Make db_path.exists() return True for all daemons
        mock_path = MagicMock()
        mock_path.exists.return_value = True
        mock_settings.app_root.__truediv__ = MagicMock(return_value=mock_path)
        mock_path.__truediv__ = MagicMock(return_value=mock_path)
        app.dependency_overrides[get_settings] = lambda: mock_settings

        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = None  # table not found
        mock_conn.cursor.return_value = mock_cursor

        try:
            with patch("sqlite3.connect", return_value=mock_conn):
                resp = await client.get("/v1/file/daemon/stats")
            assert resp.status_code == 200
            body = resp.json()
            # At least one daemon should have "initializing" status
            has_initializing = any(
                d.get("status") == "initializing"
                for d in body["daemons"].values()
            )
            assert has_initializing
            # close() called once per daemon SQLite connection
            assert mock_conn.close.call_count >= 1
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stats_per_daemon_exception(self, app, client):
        """SQLite connect raises for a daemon → error status (lines 1477-1479)."""
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        mock_path = MagicMock()
        mock_path.exists.return_value = True
        mock_settings.app_root.__truediv__ = MagicMock(return_value=mock_path)
        mock_path.__truediv__ = MagicMock(return_value=mock_path)
        app.dependency_overrides[get_settings] = lambda: mock_settings

        try:
            with patch("sqlite3.connect", side_effect=RuntimeError("DB corrupted")):
                resp = await client.get("/v1/file/daemon/stats")
            assert resp.status_code == 200
            body = resp.json()
            has_error = any(
                d.get("status") == "error"
                for d in body["daemons"].values()
            )
            assert has_error
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_stats_db_not_initialized(self, app, client, tmp_path):
        """When db_path.exists() is False → 'not_initialized' status (lines 1429-1434).

        Uses tmp_path as settings.app_root so that
        <app_root>/data/daemons/<daemon>/logs.db does not exist for any daemon.
        """
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        mock_settings.app_root = tmp_path  # empty dir — no daemon DB files

        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            resp = await client.get("/v1/file/daemon/stats")
            assert resp.status_code == 200
            body = resp.json()
            # All 3 daemons should be "not_initialized"
            for daemon_name in ["browser", "email", "filesystem"]:
                assert daemon_name in body["daemons"], f"{daemon_name} missing from response"
                daemon_data = body["daemons"][daemon_name]
                assert daemon_data["status"] == "not_initialized"
                assert daemon_data["total_logs"] == 0
                assert daemon_data["unindexed_logs"] == 0
        finally:
            app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# COVERAGE: query generation endpoints — exception handlers (lines 1523-1525, 1548-1550)
# ===========================================================================

class TestQueryGenerationDeep:
    """Deep tests for query generation endpoint exception paths."""

    @pytest.mark.asyncio
    async def test_get_queries_exception_500(self, client):
        """QueryGenerationDB import/init failure → 500 (lines 1523-1525)."""
        with patch(
            "services.daemons.query_generation.db.QueryGenerationDB",
            side_effect=RuntimeError("DB init failed"),
        ):
            resp = await client.get("/v1/file/daemon/query_generation/queries")
        assert resp.status_code == 500
        assert "failed" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_get_stats_exception_500(self, client):
        """QueryGenerationDB stats failure → 500 (lines 1548-1550)."""
        with patch(
            "services.daemons.query_generation.db.QueryGenerationDB",
            side_effect=RuntimeError("DB init failed"),
        ):
            resp = await client.get("/v1/file/daemon/query_generation/stats")
        assert resp.status_code == 500
        assert "failed" in resp.json()["detail"].lower()


# ===========================================================================
# COVERAGE: delete_daemon_data — query_gen path, file deletion, exception
# (lines 1580, 1583-1585, 1598-1600, 1609, 1617-1619)
# ===========================================================================

class TestDeleteDaemonDataDeep:
    """Deep tests for delete_daemon_data covering file/index deletion paths."""

    @pytest.mark.asyncio
    async def test_delete_query_generation_with_files(self, app, client, tmp_path):
        """Delete query_generation data deletes queries.db + index (lines 1580, 1583-1585, 1598-1600, 1609)."""
        from api.dependencies import get_settings

        # Set up real temp files
        db_dir = tmp_path / "data" / "daemons" / "query_generation"
        db_dir.mkdir(parents=True)
        db_file = db_dir / "queries.db"
        db_file.touch()

        index_dir = tmp_path / "data" / "aether_rag_sources" / "query_gen"
        index_dir.mkdir(parents=True)
        (index_dir / "dummy.txt").touch()

        mock_settings = MagicMock()
        mock_settings.app_root = tmp_path
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            resp = await client.delete("/v1/file/daemon/query_generation/data")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert len(body["deleted_items"]) >= 1
            # Files should be deleted
            assert not db_file.exists()
            assert not index_dir.exists()
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_delete_daemon_data_no_data_found(self, app, client, tmp_path):
        """Delete daemon data with no existing files returns 'No data found' (lines 1603-1607)."""
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        mock_settings.app_root = tmp_path
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            resp = await client.delete("/v1/file/daemon/browser/data")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "no data" in body["message"].lower()
            assert body["deleted_items"] == []
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_delete_daemon_data_generic_exception(self, app, client):
        """Unexpected error during deletion triggers except (lines 1617-1619)."""
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        # Make app_root raise on path operations
        mock_settings.app_root.__truediv__ = MagicMock(side_effect=RuntimeError("path crash"))
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            resp = await client.delete("/v1/file/daemon/browser/data")
            assert resp.status_code == 500
            assert "failed" in resp.json()["detail"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)


# ===========================================================================
# COVERAGE: delete_all_daemon_data — exception handler (lines 1662-1664)
# ===========================================================================

class TestDeleteAllDaemonDataDeep:
    """Deep tests for delete_all_daemon_data exception path."""

    @pytest.mark.asyncio
    async def test_delete_all_generic_exception(self, app, client):
        """Unexpected error during delete all triggers except (lines 1662-1664)."""
        from api.dependencies import get_settings

        mock_settings = MagicMock()
        mock_settings.app_root.__truediv__ = MagicMock(side_effect=RuntimeError("path crash"))
        app.dependency_overrides[get_settings] = lambda: mock_settings
        try:
            resp = await client.delete("/v1/file/daemon/data/all")
            assert resp.status_code == 500
            assert "failed" in resp.json()["detail"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)
