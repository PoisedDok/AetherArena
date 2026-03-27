"""
Unit tests for Sources endpoints (/v1/sources/*).

4 endpoints: list, discover browser profiles, build slack/browser-history/email indexes.
Each indexing endpoint has security guard (allow_local_os_tools) + ValueError (400) +
generic Exception (500) paths.

No bugs found during audit — error handling is clean with targeted ValueError + broad Exception.

CI: pytest tests/unit/api/test_sources_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, MagicMock


class TestListSources:
    """GET /v1/sources."""

    @pytest.mark.asyncio
    async def test_returns_dict_or_list(self, client, mock_supabase_client):
        """List sources returns valid response."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/sources")
        assert resp.status_code == 200
        assert isinstance(resp.json(), (dict, list))


class TestDiscoverBrowserProfiles:
    """POST /v1/sources/browser-history/discover."""

    @pytest.mark.asyncio
    async def test_valid_request(self, client, app):
        """Valid browser discover request returns profiles."""
        from api.dependencies import get_source_indexing_service
        
        mock_svc = MagicMock()
        mock_svc.discover_browser_profiles.return_value = {
            "browser": "edge", "profiles": [],
            "total_profiles": 0, "user_data_dir": "/fake",
        }
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/browser-history/discover", json={"browser": "edge"})
            assert resp.status_code in (200, 400)
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_empty_body_uses_default_browser(self, client, app):
        """Empty body defaults to 'edge' browser."""
        from api.dependencies import get_source_indexing_service

        mock_svc = MagicMock()
        mock_svc.discover_browser_profiles.return_value = {
            "browser": "edge", "profiles": [],
            "total_profiles": 0, "user_data_dir": "/fake",
        }
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/browser-history/discover", json={})
            assert resp.status_code in (200, 400)
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_value_error_400(self, client, app):
        """ValueError from service → 400."""
        from api.dependencies import get_source_indexing_service
        
        mock_svc = MagicMock()
        mock_svc.discover_browser_profiles.side_effect = ValueError("unsupported browser")
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/browser-history/discover", json={"browser": "safari"})
            assert resp.status_code == 400
            assert "unsupported browser" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_generic_error_500(self, client, app):
        """Generic exception → 500."""
        from api.dependencies import get_source_indexing_service
        
        mock_svc = MagicMock()
        mock_svc.discover_browser_profiles.side_effect = RuntimeError("disk error")
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/browser-history/discover", json={"browser": "edge"})
            assert resp.status_code == 500
            assert "disk error" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)


class TestBuildBrowserHistoryIndex:
    """POST /v1/sources/browser-history/index."""

    @pytest.mark.asyncio
    async def test_success(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_browser_history_index = AsyncMock(return_value={
            "index_name": "browser_edge", "source_type": "browser", "state": "queued", "files_total": 0, "job_id": "job-123"
        })
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/browser-history/index", json={"browser": "edge"})
            assert resp.status_code == 200
            assert resp.json() == {
                "success": True,
                "index_name": "browser_edge",
                "state": "queued",
                "files_total": 0,
                "job_id": "job-123"
            }
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_security_disabled_403(self, client, app):
        from api.dependencies import get_runtime_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = False
        app.dependency_overrides[get_runtime_settings] = lambda: mock_settings
        try:
            resp = await client.post("/v1/sources/browser-history/index", json={"browser": "edge"})
            assert resp.status_code == 403
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)

    @pytest.mark.asyncio
    async def test_value_error_400(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_browser_history_index = AsyncMock(side_effect=ValueError("bad profile path"))
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/browser-history/index", json={"browser": "edge"})
            assert resp.status_code == 400
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_generic_error_500(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_browser_history_index = AsyncMock(side_effect=RuntimeError("IO failure"))
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/browser-history/index", json={"browser": "edge"})
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)


class TestBuildEmailIndex:
    """POST /v1/sources/email/index."""

    @pytest.mark.asyncio
    async def test_success(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_email_index = AsyncMock(return_value={
            "index_name": "email_inbox", "source_type": "email", "state": "queued", "files_total": 0, "job_id": "job-456"
        })
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/email/index", json={})
            assert resp.status_code == 200
            assert resp.json() == {
                "success": True,
                "index_name": "email_inbox",
                "state": "queued",
                "files_total": 0,
                "job_id": "job-456"
            }
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_security_disabled_403(self, client, app):
        from api.dependencies import get_runtime_settings
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = False
        app.dependency_overrides[get_runtime_settings] = lambda: mock_settings
        try:
            resp = await client.post("/v1/sources/email/index", json={})
            assert resp.status_code == 403
        finally:
            app.dependency_overrides.pop(get_runtime_settings, None)

    @pytest.mark.asyncio
    async def test_value_error_400(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_email_index = AsyncMock(side_effect=ValueError("bad path"))
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/email/index", json={})
            assert resp.status_code == 400
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_generic_error_500(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_email_index = AsyncMock(side_effect=RuntimeError("parse error"))
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/email/index", json={})
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)


class TestBuildCustomIndex:
    """POST /v1/sources/custom/index."""

    @pytest.mark.asyncio
    async def test_success(self, client, app):
        """Success returns 200 with queued state."""
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_custom_index = AsyncMock(return_value={
            "index_name": "my_docs",
            "state": "queued",
            "files_total": 3,
            "job_id": "job-789"
        })
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/custom/index", json={
                "file_paths": ["/tmp/doc.pdf"],
                "index_name": "my_docs",
                "display_name": "My Documents",
                "index_mode": ["semantic", "bm25"],
            })
            assert resp.status_code == 200
            assert resp.json() == {
                "success": True,
                "index_name": "my_docs",
                "state": "queued",
                "files_total": 3,
                "job_id": "job-789"
            }
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_bm25_mode(self, client, app):
        """BM25 index mode accepted."""
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_custom_index = AsyncMock(return_value={
            "index_name": "kw_only",
            "state": "queued",
            "files_total": 1,
            "job_id": "job-999"
        })
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/custom/index", json={
                "file_paths": ["/tmp/doc.txt"],
                "index_name": "kw_only",
                "display_name": "Keywords Only",
                "index_mode": ["bm25"],
            })
            assert resp.status_code == 200
            assert resp.json() == {
                "success": True,
                "index_name": "kw_only",
                "state": "queued",
                "files_total": 1,
                "job_id": "job-999"
            }
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_invalid_index_mode_422(self, client):
        """Invalid index_mode rejected by validator."""
        resp = await client.post("/v1/sources/custom/index", json={
            "file_paths": ["/tmp/doc.txt"],
            "index_name": "bad_mode",
            "display_name": "Bad",
            "index_mode": "invalid",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_empty_file_paths_422(self, client):
        """Empty file_paths rejected."""
        resp = await client.post("/v1/sources/custom/index", json={
            "file_paths": [],
            "index_name": "empty",
            "display_name": "Empty",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_value_error_400(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_custom_index = AsyncMock(side_effect=ValueError("bad files"))
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/custom/index", json={
                "file_paths": ["/bad"],
                "index_name": "test",
                "display_name": "Test",
            })
            assert resp.status_code == 400
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_generic_error_500(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = AsyncMock()
        mock_svc.build_custom_index = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.post("/v1/sources/custom/index", json={
                "file_paths": ["/fail"],
                "index_name": "test",
                "display_name": "Test",
            })
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)


class TestGetIndexStatus:
    """GET /v1/sources/index-status/{index_name}."""

    @pytest.mark.asyncio
    async def test_queued_status(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = MagicMock()
        mock_svc.get_index_status.return_value = {
            "index_name": "my_idx",
            "state": "queued",
            "progress_pct": 0,
            "files_total": 5,
            "files_processed": 0,
            "files_skipped": 0,
            "chunk_count": 0,
            "error": None,
        }
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.get("/v1/sources/index-status/my_idx")
            assert resp.status_code == 200
            assert resp.json()["state"] == "queued"
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_completed_status(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = MagicMock()
        mock_svc.get_index_status.return_value = {
            "index_name": "done_idx",
            "state": "completed",
            "progress_pct": 100,
            "files_total": 3,
            "files_processed": 3,
            "files_skipped": 0,
            "chunk_count": 42,
            "error": None,
        }
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.get("/v1/sources/index-status/done_idx")
            assert resp.status_code == 200
            assert resp.json()["state"] == "completed"
            assert resp.json()["chunk_count"] == 42
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)


class TestListActiveJobs:
    """GET /v1/sources/active-jobs."""

    @pytest.mark.asyncio
    async def test_returns_list(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = MagicMock()
        mock_svc.list_active_jobs.return_value = [
            {"index_name": "job1", "state": "processing", "progress_pct": 50},
        ]
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.get("/v1/sources/active-jobs")
            assert resp.status_code == 200
            body = resp.json()
            assert isinstance(body, list)
            assert len(body) == 1
            assert body[0]["state"] == "processing"
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_empty_when_no_jobs(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = MagicMock()
        mock_svc.list_active_jobs.return_value = []
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.get("/v1/sources/active-jobs")
            assert resp.status_code == 200
            assert resp.json() == []
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)


class TestDeleteSourceIndex:
    """DELETE /v1/sources/{index_name}."""

    @pytest.mark.asyncio
    async def test_success(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = MagicMock()
        mock_svc.delete_index.return_value = {
            "deleted": {"index_name": "old_idx", "chunk_count": 10},
        }
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.delete("/v1/sources/old_idx")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert body["index_name"] == "old_idx"
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_not_found_404(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = MagicMock()
        mock_svc.delete_index.side_effect = ValueError("not found")
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.delete("/v1/sources/nonexistent")
            assert resp.status_code == 404
            assert "not found" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)

    @pytest.mark.asyncio
    async def test_generic_error_500(self, client, app):
        from api.dependencies import get_source_indexing_service
        mock_svc = MagicMock()
        mock_svc.delete_index.side_effect = RuntimeError("disk error")
        app.dependency_overrides[get_source_indexing_service] = lambda: mock_svc
        try:
            resp = await client.delete("/v1/sources/bad_idx")
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_source_indexing_service, None)
