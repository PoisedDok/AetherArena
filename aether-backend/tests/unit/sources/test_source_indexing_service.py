"""
Unit Tests: SourceIndexingService (application/services/source_indexing_service.py)

Comprehensive coverage of source index building, registry management,
and all internal helpers.

Existing tests (preserved): email_ingest formatting, chromium_history formatting,
build_email_index integration (using monkeypatch).

Mock boundaries:
- AetherRagIndexManager → patch at application.indexing.index_builder.AetherRagIndexManager
- SlackMCPReader → local import, patch at services.aether_rag.apps.slack_data.slack_mcp_reader.SlackMCPReader
- chromium_history functions → local import, patch at application.sources.chromium_history.*
- email_ingest functions → local import, patch at application.sources.email_ingest.*
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from application.services.source_indexing_service import SourceIndexingService

SIS_MODULE = "application.services.source_indexing_service"


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _make_settings(tmp_path: Path, **overrides) -> MagicMock:
    """Create a MagicMock Settings with enough real values for SourceIndexingService."""
    settings = MagicMock()

    sources = MagicMock()
    sources.enabled = overrides.get("sources_enabled", True)
    sources.index_root_dir = str(overrides.get("index_root", tmp_path / "indexes"))

    # Slack
    sources.slack.enabled = overrides.get("slack_enabled", True)
    sources.slack.mcp_command = overrides.get("slack_mcp_command", "/usr/bin/slack-mcp")
    sources.slack.default_index_name = "slack_messages"
    sources.slack.concatenate_conversations = True
    sources.slack.max_messages_per_channel = 100
    sources.slack.max_retries = 5
    sources.slack.retry_delay_seconds = 2.0

    # Browser history
    sources.browser_history.enabled = overrides.get("browser_enabled", True)
    sources.browser_history.default_index_name = "browser_history"
    sources.browser_history.max_items = 1000
    sources.browser_history.browser = "edge"
    sources.browser_history.profile_path = ""
    sources.browser_history.auto_find_profiles = True
    sources.browser_history.user_data_dir = overrides.get("browser_user_data_dir", "")

    # Email
    sources.email.enabled = overrides.get("email_enabled", True)
    sources.email.default_index_name = "email_archive"
    sources.email.source_path = overrides.get("email_source_path", str(tmp_path / "emails"))
    sources.email.max_items = 500

    settings.integrations.aether_rag_sources = sources
    settings.embedding_service.model = "test-embed-model"
    settings.embedding_service.openai_base_url = "http://localhost:8080"

    return settings


def _make_service(tmp_path: Path, **overrides) -> SourceIndexingService:
    """Create a SourceIndexingService with mock settings."""
    settings = _make_settings(tmp_path, **overrides)
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
        if "chunk_count" not in entry and len(args) > 3:
            entry["chunk_count"] = args[3]
        entry.setdefault("created_at", "2026-01-01T00:00:00")
        entry.setdefault("updated_at", "2026-01-01T00:00:00")
        return entry
        
    mock_repo.register_index.side_effect = _fake_register_index
    return SourceIndexingService(settings, mock_repo)



def _create_sqlite_history_db(db_path: Path, entry_count: int = 5) -> None:
    """Create a minimal SQLite history database (mimics Chromium History)."""
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT)")
    for i in range(entry_count):
        conn.execute("INSERT INTO urls VALUES (?, ?, ?)", (i, f"https://example.com/{i}", f"Page {i}"))
    conn.commit()
    conn.close()


# ─── Preserved existing tests ────────────────────────────────────────────────

def test_email_ingest_formats_headers_and_body():
    from application.sources.email_ingest import parse_eml_bytes, format_email_item

    raw = (
        b"From: Alice <alice@example.com>\r\n"
        b"To: Bob <bob@example.com>\r\n"
        b"Subject: Contract Update\r\n"
        b"Date: Tue, 1 Jan 2025 12:00:00 +0000\r\n"
        b"Message-ID: <msg-1@example.com>\r\n"
        b"\r\n"
        b"Here is the latest draft.\r\n"
    )
    item = parse_eml_bytes(raw)
    text = format_email_item(item)
    assert "Contract Update" in text
    assert "alice@example.com" in text
    assert "bob@example.com" in text
    assert "Here is the latest draft." in text


def test_chromium_history_formats_entry():
    from application.sources.chromium_history import format_history_entry

    entry = {
        "title": "Example",
        "url": "https://example.com",
        "last_visit_time": "2025-01-01T00:00:00+00:00",
        "visit_count": 3,
        "typed_count": 1,
        "profile": "Default",
    }
    text = format_history_entry(entry)
    assert "[URL]: https://example.com" in text
    assert "[Title]: Example" in text




# ═══════════════════════════════════════════════════════════════════════════════
# Tests: sanitize_index_name
# ═══════════════════════════════════════════════════════════════════════════════

class TestSanitizeIndexName:
    def test_lowercase_and_underscore(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.storage.sanitize_index_name("Hello World") == "hello_world"

    def test_already_clean(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.storage.sanitize_index_name("already_clean") == "already_clean"

    def test_special_chars_replaced(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.storage.sanitize_index_name("test@#$%name") == "test_name"

    def test_leading_trailing_underscores_stripped(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.storage.sanitize_index_name("  _test_  ") == "test"

    def test_empty_after_sanitization_raises(self, tmp_path):
        svc = _make_service(tmp_path)
        with pytest.raises(ValueError, match="empty after sanitization"):
            svc.storage.sanitize_index_name("---")

    def test_whitespace_only_raises(self, tmp_path):
        svc = _make_service(tmp_path)
        with pytest.raises(ValueError, match="empty after sanitization"):
            svc.storage.sanitize_index_name("   ")

    def test_numbers_preserved(self, tmp_path):
        svc = _make_service(tmp_path)
        assert svc.storage.sanitize_index_name("index_123") == "index_123"


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: get_index_dir
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetIndexDir:
    def test_creates_directory(self, tmp_path):
        svc = _make_service(tmp_path)
        result = svc.storage.get_index_dir("slack")
        assert result.exists()
        assert result.is_dir()
        assert result == svc.storage.index_root / "slack"

    def test_idempotent(self, tmp_path):
        svc = _make_service(tmp_path)
        d1 = svc.storage.get_index_dir("slack")
        d2 = svc.storage.get_index_dir("slack")
        assert d1 == d2


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: delete_index_files
# ═══════════════════════════════════════════════════════════════════════════════

class TestDeleteIndexFiles:
    def test_deletes_aether_rag_and_meta(self, tmp_path):
        svc = _make_service(tmp_path)
        index_dir = tmp_path / "idx"
        index_dir.mkdir()
        (index_dir / "test.aether_rag").write_text("data")
        (index_dir / "test.aether_rag.meta.json").write_text("{}")

        svc.storage.delete_index_files(index_dir, "test")
        assert not (index_dir / "test.aether_rag").exists()
        assert not (index_dir / "test.aether_rag.meta.json").exists()

    def test_no_files_no_error(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.storage.delete_index_files(tmp_path, "nonexistent")  # no exception


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: enforce_index_state
# ═══════════════════════════════════════════════════════════════════════════════

class TestEnforceIndexState:
    @patch(f"{SIS_MODULE}.AetherRagService")
    def test_new_index_passes(self, MockLIM, tmp_path):
        MockLIM.return_value.index_exists.return_value = False
        svc = _make_service(tmp_path)
        svc.storage.enforce_index_state(tmp_path, "new_idx", force_rebuild=False, index_exists_fn=svc.builder.index_exists)
        # No exception

    @patch(f"{SIS_MODULE}.AetherRagService")
    def test_existing_no_force_raises(self, MockLIM, tmp_path):
        MockLIM.return_value.index_exists.return_value = True
        svc = _make_service(tmp_path)
        with pytest.raises(ValueError, match="already exists"):
            svc.storage.enforce_index_state(tmp_path, "existing", force_rebuild=False, index_exists_fn=svc.builder.index_exists)

    @patch(f"{SIS_MODULE}.AetherRagService")
    def test_existing_with_force_deletes(self, MockLIM, tmp_path):
        MockLIM.return_value.index_exists.return_value = True
        svc = _make_service(tmp_path)
        index_dir = tmp_path / "idx"
        index_dir.mkdir()
        (index_dir / "old.aether_rag").write_text("data")
        (index_dir / "old.aether_rag.meta.json").write_text("{}")

        svc.storage.enforce_index_state(index_dir, "old", force_rebuild=True, index_exists_fn=svc.builder.index_exists)
        assert not (index_dir / "old.aether_rag").exists()
        assert not (index_dir / "old.aether_rag.meta.json").exists()


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: list_indexes / get_index_entry
# ═══════════════════════════════════════════════════════════════════════════════

class TestListAndGet:
    def test_list_empty(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.registry.list_indexes.return_value = []
        assert svc.list_indexes() == []

    def test_list_with_entries(self, tmp_path):
        svc = _make_service(tmp_path)
        dir_a = tmp_path / "a"
        dir_a.mkdir()
        (dir_a / "a.aether_rag.meta.json").write_text("{}")
        dir_b = tmp_path / "b"
        dir_b.mkdir()
        (dir_b / "b.aether_rag.meta.json").write_text("{}")
        
        svc.registry.list_indexes.return_value = [
            {"index_name": "a", "source_type": "slack", "index_directory": str(dir_a)},
            {"index_name": "b", "source_type": "email", "index_directory": str(dir_b)},
        ]
        result = svc.list_indexes()
        assert len(result) == 2

    def test_get_found(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.registry.get_index.return_value = {"index_name": "target", "source_type": "slack", "chunk_count": 42}
        entry = svc.get_index_entry("target")
        assert entry is not None
        assert entry["chunk_count"] == 42

    def test_get_not_found(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.registry.get_index.return_value = None
        assert svc.get_index_entry("missing") is None

# ═══════════════════════════════════════════════════════════════════════════════
# Tests: describe_sources
# ═══════════════════════════════════════════════════════════════════════════════

class TestDescribeSources:
    def test_returns_expected_structure(self, tmp_path):
        svc = _make_service(tmp_path)
        svc.registry.list_indexes.return_value = []
        result = svc.describe_sources()
        assert "enabled" in result
        assert "index_root_dir" in result
        assert "sources" in result
        assert "browser_history" in result["sources"]
        assert "email" in result["sources"]
        assert "indexes" in result

    def test_includes_index_entries(self, tmp_path):
        svc = _make_service(tmp_path)
        dir_a = tmp_path / "a"
        dir_a.mkdir()
        (dir_a / "a.aether_rag.meta.json").write_text("{}")
        
        svc.registry.list_indexes.return_value = [{"index_name": "a", "index_directory": str(dir_a)}]
        result = svc.describe_sources()
        assert len(result["indexes"]) == 1

# ═══════════════════════════════════════════════════════════════════════════════
# Tests: build_slack_index
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.skip(reason="build_slack_index removed in favor of unified indexing")
class TestBuildSlackIndex:
    @patch(f"{SIS_MODULE}.AetherRagService")
    async def test_happy_path(self, MockLIM, tmp_path):
        MockLIM.return_value.index_exists.return_value = False
        MockLIM.return_value.build_index = AsyncMock(return_value=3)

        reader_instance = MagicMock()
        reader_instance.read_slack_data = AsyncMock(return_value=["msg1", "msg2", "msg3"])

        svc = _make_service(tmp_path)
        with patch.dict("sys.modules", {
            "services.aether_rag.apps.slack_data.slack_mcp_reader": MagicMock(SlackMCPReader=MagicMock(return_value=reader_instance))
        }):
            entry = await svc.build_slack_index(
                index_name="test_slack",
                workspace_name="myworkspace",
                channels=["general"],
                max_messages_per_channel=None,
                concatenate_conversations=None,
                max_retries=None,
                retry_delay_seconds=None,
                force_rebuild=True,
            )
        assert entry["index_name"] == "test_slack"
        assert entry["source_type"] == "slack"
        assert entry["chunk_count"] == 3

    @patch(f"{SIS_MODULE}.AetherRagService")
    async def test_no_mcp_command_raises(self, MockLIM, tmp_path):
        svc = _make_service(tmp_path, slack_mcp_command="")
        with pytest.raises(ValueError, match="Slack MCP command is not configured"):
            await svc.build_slack_index(
                index_name="x", workspace_name=None, channels=["ch"],
                max_messages_per_channel=None, concatenate_conversations=None,
                max_retries=None, retry_delay_seconds=None, force_rebuild=True,
            )

    @patch(f"{SIS_MODULE}.AetherRagService")
    async def test_no_channels_raises(self, MockLIM, tmp_path):
        svc = _make_service(tmp_path)
        with pytest.raises(ValueError, match="explicit channel list"):
            await svc.build_slack_index(
                index_name="x", workspace_name=None, channels=[],
                max_messages_per_channel=None, concatenate_conversations=None,
                max_retries=None, retry_delay_seconds=None, force_rebuild=True,
            )

    @patch(f"{SIS_MODULE}.AetherRagService")
    async def test_no_texts_raises(self, MockLIM, tmp_path):
        MockLIM.return_value.index_exists.return_value = False
        reader_instance = MagicMock()
        reader_instance.read_slack_data = AsyncMock(return_value=[])

        svc = _make_service(tmp_path)
        with patch.dict("sys.modules", {
            "services.aether_rag.apps.slack_data.slack_mcp_reader": MagicMock(SlackMCPReader=MagicMock(return_value=reader_instance))
        }):
            with pytest.raises(RuntimeError, match="no messages to index"):
                await svc.build_slack_index(
                    index_name="x", workspace_name=None, channels=["ch"],
                    max_messages_per_channel=None, concatenate_conversations=None,
                    max_retries=None, retry_delay_seconds=None, force_rebuild=True,
                )

    @patch(f"{SIS_MODULE}.AetherRagService")
    async def test_disabled_logs_warning_but_proceeds(self, MockLIM, tmp_path):
        MockLIM.return_value.index_exists.return_value = False
        MockLIM.return_value.build_index = AsyncMock(return_value=1)
        reader_instance = MagicMock()
        reader_instance.read_slack_data = AsyncMock(return_value=["msg"])

        svc = _make_service(tmp_path, sources_enabled=False, slack_enabled=False)
        with patch.dict("sys.modules", {
            "services.aether_rag.apps.slack_data.slack_mcp_reader": MagicMock(SlackMCPReader=MagicMock(return_value=reader_instance))
        }):
            entry = await svc.build_slack_index(
                index_name="x", workspace_name=None, channels=["ch"],
                max_messages_per_channel=None, concatenate_conversations=None,
                max_retries=None, retry_delay_seconds=None, force_rebuild=True,
            )
        assert entry["index_name"] == "x"

    @patch(f"{SIS_MODULE}.AetherRagService")
    async def test_uses_default_index_name(self, MockLIM, tmp_path):
        MockLIM.return_value.index_exists.return_value = False
        MockLIM.return_value.build_index = AsyncMock(return_value=1)
        reader_instance = MagicMock()
        reader_instance.read_slack_data = AsyncMock(return_value=["msg"])

        svc = _make_service(tmp_path)
        with patch.dict("sys.modules", {
            "services.aether_rag.apps.slack_data.slack_mcp_reader": MagicMock(SlackMCPReader=MagicMock(return_value=reader_instance))
        }):
            entry = await svc.build_slack_index(
                index_name=None, workspace_name="ws", channels=["ch"],
                max_messages_per_channel=None, concatenate_conversations=None,
                max_retries=None, retry_delay_seconds=None, force_rebuild=True,
            )
        assert entry["index_name"] == "slack_messages"

    @patch(f"{SIS_MODULE}.AetherRagService")
    async def test_explicit_overrides_applied(self, MockLIM, tmp_path):
        MockLIM.return_value.index_exists.return_value = False
        MockLIM.return_value.build_index = AsyncMock(return_value=1)
        reader_instance = MagicMock()
        reader_instance.read_slack_data = AsyncMock(return_value=["msg"])
        MockReaderClass = MagicMock(return_value=reader_instance)

        svc = _make_service(tmp_path)
        with patch.dict("sys.modules", {
            "services.aether_rag.apps.slack_data.slack_mcp_reader": MagicMock(SlackMCPReader=MockReaderClass)
        }):
            await svc.build_slack_index(
                index_name="custom", workspace_name="ws", channels=["ch1", "ch2"],
                max_messages_per_channel=50,
                concatenate_conversations=False,
                max_retries=3,
                retry_delay_seconds=1.0,
                force_rebuild=True,
            )
        # Verify reader was created with explicit overrides
        MockReaderClass.assert_called_once()
        _, kwargs = MockReaderClass.call_args
        assert kwargs.get("concatenate_conversations") is False
        assert kwargs.get("max_messages_per_conversation") == 50
        assert kwargs.get("max_retries") == 3
        assert kwargs.get("retry_delay") == 1.0


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: build_browser_history_index
# ═══════════════════════════════════════════════════════════════════════════════

class TestBuildBrowserHistoryIndex:
    @patch("data.database.clients.supabase.SupabaseClient.from_env")
    @patch("services.daemons.file_indexing.async_reindex.ReindexJobManager")
    async def test_triggers_reindex_job(self, mock_manager_class, mock_supabase_from_env, tmp_path):
        mock_manager = MagicMock()
        mock_manager.trigger_reindex_async = AsyncMock(return_value={
            "status": "queued",
            "job_id": "12345"
        })
        mock_manager_class.return_value = mock_manager
        
        mock_supabase_client = AsyncMock()
        mock_supabase_from_env.return_value = mock_supabase_client
        
        svc = _make_service(tmp_path)
        result = await svc.build_browser_history_index(
            index_name="my_bh",
            browser="edge",
            profile_path=None,
            auto_find_profiles=True,
            max_items=None,
            force_rebuild=True
        )
        
        assert result["index_name"] == "my_bh"
        assert result["state"] == "queued"
        assert result["job_id"] == "12345"
        mock_manager.trigger_reindex_async.assert_called_once_with(
            location_name="my_bh",
            source_type="browser",
            location_id=None
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: build_email_index
# ═══════════════════════════════════════════════════════════════════════════════

class TestBuildEmailIndex:
    @patch("data.database.clients.supabase.SupabaseClient.from_env")
    @patch("services.daemons.file_indexing.async_reindex.ReindexJobManager")
    async def test_triggers_reindex_job(self, mock_manager_class, mock_supabase_from_env, tmp_path):
        mock_manager = MagicMock()
        mock_manager.trigger_reindex_async = AsyncMock(return_value={
            "status": "queued",
            "job_id": "67890"
        })
        mock_manager_class.return_value = mock_manager
        
        mock_supabase_client = AsyncMock()
        mock_supabase_from_env.return_value = mock_supabase_client
        
        svc = _make_service(tmp_path)
        result = await svc.build_email_index(
            index_name="my_email",
            source_path=None,
            max_items=None,
            force_rebuild=True
        )
        
        assert result["index_name"] == "my_email"
        assert result["state"] == "queued"
        assert result["job_id"] == "67890"
        mock_manager.trigger_reindex_async.assert_called_once_with(
            location_name="my_email",
            source_type="email",
            location_id=None
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: discover_browser_profiles
# ═══════════════════════════════════════════════════════════════════════════════

class TestDiscoverBrowserProfiles:
    @patch("application.sources.chromium_history.find_profile_dirs")
    @patch("application.sources.chromium_history.resolve_chromium_user_data_dir")
    def test_happy_path_with_real_sqlite(self, mock_resolve, mock_find, tmp_path):
        """Uses real SQLite database for accurate count testing."""
        user_data = tmp_path / "UserData"
        user_data.mkdir()
        profile1 = user_data / "Default"
        profile1.mkdir()
        _create_sqlite_history_db(profile1 / "History", entry_count=10)

        mock_resolve.return_value = user_data
        mock_find.return_value = [profile1]

        svc = _make_service(tmp_path)
        result = svc.discover_browser_profiles(browser="edge")
        assert result["success"] is True
        assert result["browser"] == "edge"
        assert len(result["profiles"]) == 1
        assert result["profiles"][0]["estimated_entries"] == 10
        assert result["total_estimated_entries"] == 10

    @patch("application.sources.chromium_history.find_profile_dirs")
    @patch("application.sources.chromium_history.resolve_chromium_user_data_dir")
    def test_override_user_data_dir(self, mock_resolve, mock_find, tmp_path):
        user_data = tmp_path / "CustomDir"
        user_data.mkdir()
        profile = user_data / "Profile1"
        profile.mkdir()
        _create_sqlite_history_db(profile / "History", entry_count=3)
        mock_find.return_value = [profile]

        svc = _make_service(tmp_path)
        result = svc.discover_browser_profiles(browser="chrome", user_data_dir_override=str(user_data))
        assert result["success"] is True
        mock_resolve.assert_not_called()

    @patch("application.sources.chromium_history.find_profile_dirs")
    @patch("application.sources.chromium_history.resolve_chromium_user_data_dir")
    def test_no_user_data_dir_raises(self, mock_resolve, mock_find, tmp_path):
        mock_resolve.return_value = None
        svc = _make_service(tmp_path)
        with pytest.raises(ValueError, match="not found"):
            svc.discover_browser_profiles(browser="edge")

    @patch("application.sources.chromium_history.find_profile_dirs")
    @patch("application.sources.chromium_history.resolve_chromium_user_data_dir")
    def test_nonexistent_override_dir_raises(self, mock_resolve, mock_find, tmp_path):
        svc = _make_service(tmp_path)
        with pytest.raises(ValueError, match="not found"):
            svc.discover_browser_profiles(browser="edge", user_data_dir_override="/nonexistent/path")

    @patch("application.sources.chromium_history.find_profile_dirs", return_value=[])
    @patch("application.sources.chromium_history.resolve_chromium_user_data_dir")
    def test_no_profiles_raises(self, mock_resolve, mock_find, tmp_path):
        user_data = tmp_path / "UserData"
        user_data.mkdir()
        mock_resolve.return_value = user_data

        svc = _make_service(tmp_path)
        with pytest.raises(ValueError, match="No edge profiles"):
            svc.discover_browser_profiles(browser="edge")

    @patch("application.sources.chromium_history.find_profile_dirs")
    @patch("application.sources.chromium_history.resolve_chromium_user_data_dir")
    def test_profile_without_history_db(self, mock_resolve, mock_find, tmp_path):
        user_data = tmp_path / "UserData"
        user_data.mkdir()
        profile = user_data / "Empty"
        profile.mkdir()
        mock_resolve.return_value = user_data
        mock_find.return_value = [profile]

        svc = _make_service(tmp_path)
        result = svc.discover_browser_profiles(browser="edge")
        assert result["profiles"][0]["history_db_exists"] is False
        assert result["profiles"][0]["estimated_entries"] == 0
        assert result["total_estimated_entries"] == 0

    @patch("application.sources.chromium_history.find_profile_dirs")
    @patch("application.sources.chromium_history.resolve_chromium_user_data_dir")
    def test_corrupt_db_handles_gracefully(self, mock_resolve, mock_find, tmp_path):
        user_data = tmp_path / "UserData"
        user_data.mkdir()
        profile = user_data / "Corrupt"
        profile.mkdir()
        (profile / "History").write_text("not a sqlite database")
        mock_resolve.return_value = user_data
        mock_find.return_value = [profile]

        svc = _make_service(tmp_path)
        result = svc.discover_browser_profiles(browser="edge")
        # Should handle exception gracefully (log warning, return 0 entries)
        assert result["profiles"][0]["estimated_entries"] == 0

    @patch("application.sources.chromium_history.find_profile_dirs")
    @patch("application.sources.chromium_history.resolve_chromium_user_data_dir")
    def test_multiple_profiles_aggregated(self, mock_resolve, mock_find, tmp_path):
        user_data = tmp_path / "UserData"
        user_data.mkdir()
        p1 = user_data / "Default"
        p1.mkdir()
        _create_sqlite_history_db(p1 / "History", entry_count=5)
        p2 = user_data / "Profile1"
        p2.mkdir()
        _create_sqlite_history_db(p2 / "History", entry_count=3)

        mock_resolve.return_value = user_data
        mock_find.return_value = [p1, p2]

        svc = _make_service(tmp_path)
        result = svc.discover_browser_profiles(browser="edge")
        assert len(result["profiles"]) == 2
        assert result["total_estimated_entries"] == 8

    @patch("application.sources.chromium_history.find_profile_dirs")
    @patch("application.sources.chromium_history.resolve_chromium_user_data_dir")
    def test_profile_metadata_populated(self, mock_resolve, mock_find, tmp_path):
        user_data = tmp_path / "UserData"
        user_data.mkdir()
        profile = user_data / "Default"
        profile.mkdir()
        _create_sqlite_history_db(profile / "History", entry_count=1)

        mock_resolve.return_value = user_data
        mock_find.return_value = [profile]

        svc = _make_service(tmp_path)
        result = svc.discover_browser_profiles(browser="edge")
        info = result["profiles"][0]
        assert info["profile_name"] == "Default"
        assert info["profile_path"] == str(profile)
        assert info["history_db_exists"] is True
        assert info["estimated_size_mb"] > 0
        assert info["last_modified"] is not None
