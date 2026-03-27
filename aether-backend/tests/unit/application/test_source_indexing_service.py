import json
from pathlib import Path
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from application.services.source_indexing_service import SourceIndexingService


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_slack_cfg() -> MagicMock:
    cfg = MagicMock()
    cfg.enabled = True
    cfg.mcp_command = "npx slack-mcp"
    cfg.default_index_name = "slack_default"
    cfg.max_messages_per_channel = 100
    cfg.max_retries = 3
    cfg.retry_delay_seconds = 1.0
    cfg.concatenate_conversations = True
    return cfg


def _make_browser_cfg() -> MagicMock:
    cfg = MagicMock()
    cfg.enabled = True
    cfg.default_index_name = "browser_default"
    cfg.max_items = 5000
    cfg.browser = "edge"
    cfg.profile_path = ""
    cfg.auto_find_profiles = True
    cfg.user_data_dir = ""
    return cfg


def _make_email_cfg() -> MagicMock:
    cfg = MagicMock()
    cfg.enabled = True
    cfg.default_index_name = "email_default"
    cfg.source_path = "/path/to/emails"
    cfg.max_items = 10000
    return cfg


def _make_sources_cfg(tmp_path: Path) -> MagicMock:
    cfg = MagicMock()
    cfg.enabled = True
    cfg.index_root_dir = str(tmp_path / "indexes")
    cfg.slack = _make_slack_cfg()
    cfg.browser_history = _make_browser_cfg()
    cfg.email = _make_email_cfg()
    return cfg


def _make_settings(tmp_path: Path) -> MagicMock:
    settings = MagicMock()
    settings.integrations.aether_rag_sources = _make_sources_cfg(tmp_path)
    settings.embedding_service = MagicMock()
    settings.embedding_service.model = "test-embed-model"
    settings.embedding_service.openai_base_url = "http://localhost:8080"
    return settings


def _make_service(tmp_path: Path, settings: MagicMock | None = None) -> SourceIndexingService:
    if settings is None:
        settings = _make_settings(tmp_path)
    mock_repo = AsyncMock()
    mock_repo.list_indexes.return_value = []
    mock_repo.get_index.return_value = None
    
    async def _fake_register_index(*args, **kwargs):
        # Merge args/kwargs into a dict like the real DB would return
        entry = dict(kwargs)
        if "index_name" not in entry and len(args) > 0:
            entry["index_name"] = args[0]
        if "source_type" not in entry and len(args) > 1:
            entry["source_type"] = args[1]
        entry.setdefault("created_at", "2026-01-01T00:00:00")
        entry.setdefault("updated_at", "2026-01-01T00:00:00")
        return entry
        
    mock_repo.register_index.side_effect = _fake_register_index
    return SourceIndexingService(settings, mock_repo)




# ─── __init__ ────────────────────────────────────────────────────────────────


class TestInit:
    def test_initializes_correctly(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.settings is not None
        assert svc.storage.index_root == (tmp_path / "indexes").resolve()
        assert svc.registry is not None


# ─── list_indexes ────────────────────────────────────────────────────────────


class TestListIndexes:
    def test_returns_empty(self, tmp_path):
        svc = _make_service(tmp_path)
        result = svc.list_indexes()
        assert result == []

    def test_returns_indexes_from_registry(self, tmp_path):
        svc = _make_service(tmp_path)
        
        dir1 = tmp_path / "slack_main"
        dir1.mkdir()
        (dir1 / "slack_main.aether_rag.meta.json").write_text("{}")
        
        dir2 = tmp_path / "browser_hist"
        dir2.mkdir()
        (dir2 / "browser_hist.aether_rag.meta.json").write_text("{}")
        
        svc.registry.list_indexes.return_value = [
            {"index_name": "slack_main", "source_type": "slack", "index_directory": str(dir1)},
            {"index_name": "browser_hist", "source_type": "browser_history", "index_directory": str(dir2)},
        ]

        result = svc.list_indexes()
        assert len(result) == 2
        assert result[0]["index_name"] == "slack_main"


# ─── get_index_entry ─────────────────────────────────────────────────────────


class TestGetIndexEntry:
    def test_found(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.registry.get_index.return_value = {"index_name": "my_index", "chunk_count": 42}

        result = svc.get_index_entry("my_index")
        assert result is not None
        assert result["chunk_count"] == 42

    def test_not_found(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.registry.get_index.return_value = None

        result = svc.get_index_entry("nonexistent")
        assert result is None


# ─── describe_sources ────────────────────────────────────────────────────────


class TestDescribeSources:
    def test_returns_complete_structure(self, tmp_path):
        svc = _make_service(tmp_path)

        result = svc.describe_sources()

        assert result["enabled"] is True
        assert "index_root_dir" in result
        assert "browser_history" in result["sources"]
        assert "email" in result["sources"]
        assert "slack" not in result["sources"]
        assert isinstance(result["indexes"], list)


# ─── _sanitize_index_name ────────────────────────────────────────────────────


class TestSanitizeIndexName:
    def test_lowercase_and_underscores(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.storage.sanitize_index_name("My Index Name") == "my_index_name"

    def test_strips_special_chars(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.storage.sanitize_index_name("index@#$%test!") == "index_test"

    def test_strips_leading_trailing_underscores(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.storage.sanitize_index_name("__test__") == "test"

    def test_empty_after_sanitization_raises(self, tmp_path):
        svc = _make_service(tmp_path)
        with pytest.raises(ValueError, match="empty after sanitization"):
            svc.storage.sanitize_index_name("@#$%")

    def test_preserves_valid_chars(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.storage.sanitize_index_name("valid_name_123") == "valid_name_123"


# ─── _get_index_dir ─────────────────────────────────────────────────────────


class TestGetIndexDir:
    def test_creates_directory(self, tmp_path):
        svc = _make_service(tmp_path)
        result = svc.storage.get_index_dir("slack")
        assert result.exists()
        assert result.is_dir()
        assert result.name == "slack"

    def test_nested_in_index_root(self, tmp_path):
        svc = _make_service(tmp_path)
        result = svc.storage.get_index_dir("browser_history")
        assert result.parent == svc.storage.index_root


# ─── _enforce_index_state ────────────────────────────────────────────────────


class TestEnforceIndexState:
    def test_no_existing_index_passes(self, tmp_path):
        svc = _make_service(tmp_path)
        index_dir = tmp_path / "test_dir"
        index_dir.mkdir()

        with patch("application.indexing.aether_rag_service.AetherRagService.index_exists") as MockExists:
            MockExists.return_value = False
            svc.storage.enforce_index_state(index_dir, "test_index", force_rebuild=False, index_exists_fn=MockExists)

    def test_existing_index_no_force_raises(self, tmp_path):
        svc = _make_service(tmp_path)
        index_dir = tmp_path / "test_dir"
        index_dir.mkdir()

        with patch("application.indexing.aether_rag_service.AetherRagService.index_exists") as MockExists:
            MockExists.return_value = True
            with pytest.raises(ValueError, match="already exists"):
                svc.storage.enforce_index_state(index_dir, "test_index", force_rebuild=False, index_exists_fn=MockExists)

    def test_existing_index_force_rebuild_deletes(self, tmp_path):
        svc = _make_service(tmp_path)
        index_dir = tmp_path / "test_dir"
        index_dir.mkdir()
        # Create fake index files
        (index_dir / "test_index.aether_rag").write_text("data")
        (index_dir / "test_index.aether_rag.meta.json").write_text("{}")

        with patch("application.indexing.aether_rag_service.AetherRagService.index_exists") as MockExists:
            MockExists.return_value = True
            svc.storage.enforce_index_state(index_dir, "test_index", force_rebuild=True, index_exists_fn=MockExists)

        assert not (index_dir / "test_index.aether_rag").exists()
        assert not (index_dir / "test_index.aether_rag.meta.json").exists()


# ─── _delete_index_files ─────────────────────────────────────────────────────


class TestDeleteIndexFiles:
    def test_deletes_both_files(self, tmp_path):
        svc = _make_service(tmp_path)
        index_dir = tmp_path / "indexes" / "slack"
        index_dir.mkdir(parents=True)
        (index_dir / "myindex.aether_rag").write_text("data")
        (index_dir / "myindex.aether_rag.meta.json").write_text("{}")

        svc.storage.delete_index_files(index_dir, "myindex")

        assert not (index_dir / "myindex.aether_rag").exists()
        assert not (index_dir / "myindex.aether_rag.meta.json").exists()

    def test_handles_missing_files(self, tmp_path):
        svc = _make_service(tmp_path)
        index_dir = tmp_path / "indexes" / "slack"
        index_dir.mkdir(parents=True)
        # No files to delete — should not raise
        svc.storage.delete_index_files(index_dir, "nonexistent")






# ─── discover_browser_profiles ────────────────────────────────────────────────


class TestDiscoverBrowserProfiles:
    def test_happy_path(self, tmp_path):
        svc = _make_service(tmp_path)
        profile_dir = tmp_path / "Profile1"
        profile_dir.mkdir()
        import sqlite3
        history_db = profile_dir / "History"
        conn = sqlite3.connect(str(history_db))
        conn.execute("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT)")
        conn.execute("INSERT INTO urls VALUES (1, 'http://example.com')")
        conn.execute("INSERT INTO urls VALUES (2, 'http://test.com')")
        conn.commit()
        conn.close()

        with patch("application.services.source_indexing_service.SourceIndexingService.discover_browser_profiles") as mock_discover:
            mock_discover.side_effect = None

        with patch.dict("sys.modules", {
            "application.sources.chromium_history": MagicMock(
                resolve_chromium_user_data_dir=MagicMock(return_value=tmp_path),
                find_profile_dirs=MagicMock(return_value=[profile_dir]),
            )
        }):
            result = svc.discover_browser_profiles("edge")

        assert result["success"] is True
        assert result["browser"] == "edge"
        assert len(result["profiles"]) == 1
        assert result["profiles"][0]["profile_name"] == "Profile1"
        assert result["profiles"][0]["estimated_entries"] == 2
        assert result["total_estimated_entries"] == 2

    def test_no_user_data_dir_raises(self, tmp_path):
        svc = _make_service(tmp_path)
        with patch.dict("sys.modules", {
            "application.sources.chromium_history": MagicMock(
                resolve_chromium_user_data_dir=MagicMock(return_value=None),
                find_profile_dirs=MagicMock(),
            )
        }):
            with pytest.raises(ValueError, match="not found"):
                svc.discover_browser_profiles("edge")

    def test_no_profiles_raises(self, tmp_path):
        svc = _make_service(tmp_path)
        with patch.dict("sys.modules", {
            "application.sources.chromium_history": MagicMock(
                resolve_chromium_user_data_dir=MagicMock(return_value=tmp_path),
                find_profile_dirs=MagicMock(return_value=[]),
            )
        }):
            with pytest.raises(ValueError, match="No .* profiles"):
                svc.discover_browser_profiles("chrome")

    def test_user_data_dir_override(self, tmp_path):
        svc = _make_service(tmp_path)
        custom_dir = tmp_path / "custom"
        custom_dir.mkdir()
        profile_dir = custom_dir / "Default"
        profile_dir.mkdir()
        with patch.dict("sys.modules", {
            "application.sources.chromium_history": MagicMock(
                resolve_chromium_user_data_dir=MagicMock(),
                find_profile_dirs=MagicMock(return_value=[profile_dir]),
            )
        }):
            result = svc.discover_browser_profiles("edge", user_data_dir_override=str(custom_dir))

        assert result["success"] is True
        assert str(custom_dir) in result["user_data_dir"]

    def test_profile_without_history_db(self, tmp_path):
        svc = _make_service(tmp_path)
        profile_dir = tmp_path / "EmptyProfile"
        profile_dir.mkdir()
        with patch.dict("sys.modules", {
            "application.sources.chromium_history": MagicMock(
                resolve_chromium_user_data_dir=MagicMock(return_value=tmp_path),
                find_profile_dirs=MagicMock(return_value=[profile_dir]),
            )
        }):
            result = svc.discover_browser_profiles("edge")

        assert result["profiles"][0]["history_db_exists"] is False
        assert result["profiles"][0]["estimated_entries"] == 0

    def test_corrupted_history_db_handled(self, tmp_path):
        svc = _make_service(tmp_path)
        profile_dir = tmp_path / "CorruptProfile"
        profile_dir.mkdir()
        (profile_dir / "History").write_text("not a sqlite database")
        with patch.dict("sys.modules", {
            "application.sources.chromium_history": MagicMock(
                resolve_chromium_user_data_dir=MagicMock(return_value=tmp_path),
                find_profile_dirs=MagicMock(return_value=[profile_dir]),
            )
        }):
            result = svc.discover_browser_profiles("edge")

        assert result["profiles"][0]["estimated_entries"] == 0


# ─── build_email_index ───────────────────────────────────────────────────────


class TestBuildEmailIndex:
    async def test_build_email_index_queues_job(self, tmp_path):
        svc = _make_service(tmp_path)
        eml_dir = tmp_path / "emails"
        eml_dir.mkdir()

        with patch("data.database.clients.supabase.SupabaseClient") as mock_supa, \
             patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_supa.from_env.return_value.initialize = AsyncMock()
            MockManager.return_value.trigger_reindex_async = AsyncMock(return_value={"job_id": "mock_job", "status": "queued"})
            
            result = await svc.build_email_index(
                index_name="email_test",
                source_path=str(eml_dir),
                max_items=None,
                force_rebuild=False,
            )

        assert result["index_name"] == "email_test"
        assert result["job_id"] == "mock_job"
        MockManager.return_value.trigger_reindex_async.assert_called_once()


# ─── build_browser_history_index ─────────────────────────────────────────────


class TestBuildBrowserHistoryIndex:
    async def test_happy_path_with_profile_path(self, tmp_path):
        svc = _make_service(tmp_path)
        profile_dir = tmp_path / "Profile1"
        profile_dir.mkdir()

        with patch("data.database.clients.supabase.SupabaseClient") as mock_supa, \
             patch("services.daemons.file_indexing.async_reindex.ReindexJobManager") as MockManager:
            mock_supa.from_env.return_value.initialize = AsyncMock()
            MockManager.return_value.trigger_reindex_async = AsyncMock(return_value={"job_id": "mock_job_id", "status": "queued"})
            
            result = await svc.build_browser_history_index(
                index_name="browser_test",
                browser="edge",
                profile_path=str(profile_dir),
                auto_find_profiles=None,
                max_items=100,
                force_rebuild=False,
            )

        assert result["index_name"] == "browser_test"
        assert result["job_id"] == "mock_job_id"
        MockManager.return_value.trigger_reindex_async.assert_called_once()


# ─── list_active_jobs ────────────────────────────────────────────────────────


class TestListActiveJobs:
    """Tests for list_active_jobs()."""

    def test_returns_empty_when_no_jobs(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.tracker.clear_all()
        result = svc.list_active_jobs()
        assert result == []

    def test_returns_queued_and_processing(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.tracker.clear_all()
        
        svc.tracker.add_job("job_a", {"index_name": "job_a", "state": "queued", "display_name": "Job A"})
        svc.tracker.add_job("job_b", {"index_name": "job_b", "state": "processing", "display_name": "Job B"})
        svc.tracker.add_job("job_c", {"index_name": "job_c", "state": "completed", "display_name": "Job C"})
        
        result = svc.list_active_jobs()
        names = {j["index_name"] for j in result}
        assert names == {"job_a", "job_b"}
        assert len(result) == 2

    def test_excludes_completed_and_failed(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.tracker.clear_all()
        svc.tracker.add_job("done", {"state": "completed"})
        svc.tracker.add_job("fail", {"state": "failed"})
        
        result = svc.list_active_jobs()
        assert result == []


# ─── build_custom_index ──────────────────────────────────────────────────────


class TestBuildCustomIndex:
    async def test_happy_path_folder(self, tmp_path):
        svc = _make_service(tmp_path)
        source_dir = tmp_path / "my_source"
        source_dir.mkdir()
        (source_dir / "file1.txt").write_text("content 1")
        (source_dir / "file2.md").write_text("content 2")

        with patch("application.indexing.aether_rag_service.AetherRagService.index_exists") as MockExists, \
             patch("application.indexing.aether_rag_service.AetherRagService.build_index") as mock_build:
            MockExists.return_value = False
            mock_build.return_value = 10 

            svc.custom_ingestor.processor = MagicMock()
            svc.custom_ingestor.processor.process_file.return_value = [{"text": "chunk", "metadata": {}}]
            
            with patch("asyncio.get_running_loop") as mock_loop:
                result = await svc.build_custom_index(
                    index_name="custom_test",
                    display_name="Custom Test",
                    file_paths=[str(source_dir)],
                    index_mode=["semantic"],
                )

        assert result["index_name"] == "custom_test"
        assert result["state"] == "queued"
        
        assert svc.tracker.get_job("custom_test") is not None

    async def test_invalid_path_raises(self, tmp_path):
        svc = _make_service(tmp_path)
        with pytest.raises(ValueError, match="No indexable files found"):
            await svc.build_custom_index(
                index_name="test",
                display_name="Test",
                file_paths=[str(tmp_path / "nonexistent")],
                index_mode=["semantic"]
            )

    async def test_zip_extraction(self, tmp_path):
        svc = _make_service(tmp_path)
        zip_path = tmp_path / "test.zip"
        import zipfile
        with zipfile.ZipFile(zip_path, 'w') as zf:
            zf.writestr("inner.txt", "inner content")
        
        with patch("application.services.source_indexing_service.SourceIndexingService._run_custom_index_build") as mock_run:
            result = await svc.build_custom_index(
                index_name="zip_test",
                display_name="Zip Test",
                file_paths=[str(zip_path)],
                index_mode=["semantic"]
            )
        
        assert result["index_name"] == "zip_test"
