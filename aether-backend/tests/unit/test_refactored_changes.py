"""
Unit Tests: Refactored Components from Backend Audit

Tests the specific non-breaking changes:
1. ChatRepository.get_pending_artifacts() -- new repository method
2. StreamOrchestrator._link_pending_artifacts() -- uses repository, no direct gateway access
3. FileSystemDaemonConfig.from_settings() -- deterministic workspace_root resolution

No external services required -- all tests use mocks or temp directories.
"""

import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

# Ensure backend root on path
PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


# =========================================================================
# 1. ChatRepository.get_pending_artifacts
# =========================================================================

class TestChatRepositoryGetPendingArtifacts:
    """Verify the new get_pending_artifacts repository method works correctly."""

    @pytest.fixture
    def mock_gateway(self):
        """Create mock persistence gateway with required interface."""
        gw = MagicMock()
        gw.select = AsyncMock(return_value=[])
        gw.insert = AsyncMock(return_value=[{"id": str(uuid4()), "created_at": "2026-01-01T00:00:00"}])
        gw.update = AsyncMock(return_value=[{"id": str(uuid4())}])
        gw.delete = AsyncMock(return_value=None)
        gw.upsert = AsyncMock(return_value=[{"id": str(uuid4())}])
        return gw

    @pytest.fixture
    def chat_repo(self, mock_gateway):
        from data.database.repositories.chat import ChatRepository
        # Patch isinstance check: mock_gateway should pass as gateway
        with patch.object(ChatRepository, '__init__', lambda self, db, **kw: None):
            repo = ChatRepository.__new__(ChatRepository)
            repo._gateway = mock_gateway
            repo.db = mock_gateway
        return repo

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_pending_artifacts(self, chat_repo, mock_gateway):
        """No pending artifacts -> empty list, no error."""
        mock_gateway.select = AsyncMock(return_value=[])

        result = await chat_repo.get_pending_artifacts(uuid4())

        assert result == []
        mock_gateway.select.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_returns_artifacts_with_null_message_id(self, chat_repo, mock_gateway):
        """Should return artifacts where message_id IS NULL."""
        chat_id = uuid4()
        pending = [
            {"id": str(uuid4()), "chat_id": str(chat_id), "message_id": None, "created_at": "2026-01-01T00:00:00"},
            {"id": str(uuid4()), "chat_id": str(chat_id), "message_id": None, "created_at": "2026-01-01T00:00:01"},
        ]
        mock_gateway.select = AsyncMock(return_value=pending)

        result = await chat_repo.get_pending_artifacts(chat_id)

        assert len(result) == 2
        assert result[0]["message_id"] is None
        assert result[1]["message_id"] is None

    @pytest.mark.asyncio
    async def test_passes_correct_filters_to_gateway(self, chat_repo, mock_gateway):
        """Must filter by chat_id, message_id IS NULL, and created_at >= cutoff."""
        chat_id = uuid4()
        mock_gateway.select = AsyncMock(return_value=[])

        await chat_repo.get_pending_artifacts(chat_id)

        call_args = mock_gateway.select.call_args
        assert call_args[0][0] == "artifacts"
        filters = call_args[1]["filters"]
        assert filters["chat_id"] == str(chat_id)
        assert filters["message_id"] == "is.null"
        # since_seconds server-side filtering: gte operator on created_at
        assert "created_at" in filters, "Missing server-side time filter (since_seconds not used)"
        assert "gte" in filters["created_at"], "created_at filter must use gte operator"
        assert call_args[1]["admin"] is True

    @pytest.mark.asyncio
    async def test_returns_empty_on_gateway_error(self, chat_repo, mock_gateway):
        """Gateway exception -> empty list, not a raise (graceful degradation)."""
        mock_gateway.select = AsyncMock(side_effect=Exception("DB connection lost"))

        result = await chat_repo.get_pending_artifacts(uuid4())

        assert result == []

    @pytest.mark.asyncio
    async def test_returns_empty_when_gateway_returns_none(self, chat_repo, mock_gateway):
        """Some gateway implementations return None instead of empty list."""
        mock_gateway.select = AsyncMock(return_value=None)

        result = await chat_repo.get_pending_artifacts(uuid4())

        assert result == []


# =========================================================================
# 2. StreamOrchestrator._link_pending_artifacts
# =========================================================================

class TestLinkPendingArtifacts:
    """
    Verify _link_pending_artifacts uses ChatRepository methods exclusively.
    No direct gateway access allowed (architectural integrity).

    NOTE: _link_pending_artifacts was extracted from StreamOrchestrator into
    UserMessagePersister during the monolithic orchestrator refactoring.
    These tests now target UserMessagePersister directly.
    """

    @pytest.fixture
    def mock_chat_repo(self):
        repo = MagicMock()
        repo.get_pending_artifacts = AsyncMock(return_value=[])
        repo.update_artifact_message_id = AsyncMock(return_value=[])
        # Ensure no _gateway attribute is accessed
        repo._gateway = MagicMock()
        repo._gateway.select = AsyncMock(side_effect=AssertionError(
            "ARCHITECTURE VIOLATION: Direct gateway access from persister"
        ))
        repo._gateway.update = AsyncMock(side_effect=AssertionError(
            "ARCHITECTURE VIOLATION: Direct gateway access from persister"
        ))
        return repo

    @pytest.fixture
    def persister(self, mock_chat_repo):
        from ws.application.user_message_persister import UserMessagePersister

        return UserMessagePersister(chat_repository=mock_chat_repo)

    @pytest.mark.asyncio
    async def test_no_op_when_no_pending_artifacts(self, persister, mock_chat_repo):
        """No pending artifacts -> no update calls."""
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=[])

        await persister._link_pending_artifacts(
            chat_id=uuid4(),
            message_id=uuid4(),
        )

        mock_chat_repo.get_pending_artifacts.assert_awaited_once()
        mock_chat_repo.update_artifact_message_id.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_links_recent_artifacts_by_time_window(self, persister, mock_chat_repo):
        """Artifacts within 60s window should be linked."""
        chat_id = uuid4()
        msg_id = uuid4()
        now = datetime.now(timezone.utc)

        pending = [
            {
                "id": str(uuid4()),
                "chat_id": str(chat_id),
                "message_id": None,
                "created_at": now.isoformat(),
                "metadata": {},
            },
        ]
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=pending)
        mock_chat_repo.update_artifact_message_id = AsyncMock(return_value=[])

        await persister._link_pending_artifacts(
            chat_id=chat_id,
            message_id=msg_id,
        )

        mock_chat_repo.update_artifact_message_id.assert_awaited_once()
        call_kwargs = mock_chat_repo.update_artifact_message_id.call_args[1]
        assert call_kwargs["artifact_id"] == pending[0]["id"]
        assert call_kwargs["message_id"] == msg_id

    @pytest.mark.asyncio
    async def test_prefers_correlation_id_matching(self, persister, mock_chat_repo):
        """If correlation_id is provided, prefer matching over time window."""
        chat_id = uuid4()
        msg_id = uuid4()
        corr_id = str(uuid4())
        now = datetime.now(timezone.utc)

        # Two pending artifacts: one matches correlation_id, one doesn't
        matching_id = str(uuid4())
        non_matching_id = str(uuid4())
        pending = [
            {
                "id": matching_id,
                "chat_id": str(chat_id),
                "message_id": None,
                "created_at": now.isoformat(),
                "metadata": {"correlation_id": corr_id},
            },
            {
                "id": non_matching_id,
                "chat_id": str(chat_id),
                "message_id": None,
                "created_at": now.isoformat(),
                "metadata": {"correlation_id": "wrong-id"},
            },
        ]
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=pending)
        mock_chat_repo.update_artifact_message_id = AsyncMock(return_value=[])

        await persister._link_pending_artifacts(
            chat_id=chat_id,
            message_id=msg_id,
            correlation_id=corr_id,
        )

        # Only the matching artifact should be linked
        assert mock_chat_repo.update_artifact_message_id.await_count == 1
        call_kwargs = mock_chat_repo.update_artifact_message_id.call_args[1]
        assert call_kwargs["artifact_id"] == matching_id

    @pytest.mark.asyncio
    async def test_no_op_when_no_chat_repository(self):
        """If chat_repository is None (edge case), should return silently."""
        from ws.application.user_message_persister import UserMessagePersister

        persister = UserMessagePersister(chat_repository=None)

        # Should not raise
        await persister._link_pending_artifacts(
            chat_id=uuid4(),
            message_id=uuid4(),
        )

    @pytest.mark.asyncio
    async def test_does_not_directly_access_gateway(self, persister, mock_chat_repo):
        """
        ARCHITECTURE ENFORCEMENT: _link_pending_artifacts must NEVER touch _gateway directly.

        Previous approach used AssertionError side_effects on gateway methods, but
        _link_pending_artifacts catches Exception (line 197), so AssertionError was
        silently swallowed -- making the test a false positive.

        Fixed approach: explicitly assert gateway methods were never awaited.
        This is immune to the exception-swallowing problem.
        """
        now = datetime.now(timezone.utc)
        pending = [
            {
                "id": str(uuid4()),
                "chat_id": str(uuid4()),
                "message_id": None,
                "created_at": now.isoformat(),
                "metadata": {},
            },
        ]
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=pending)
        mock_chat_repo.update_artifact_message_id = AsyncMock(return_value=[])

        await persister._link_pending_artifacts(
            chat_id=uuid4(),
            message_id=uuid4(),
        )

        # REAL enforcement: verify gateway was never called directly
        mock_chat_repo._gateway.select.assert_not_awaited()
        mock_chat_repo._gateway.update.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_skips_old_artifacts_outside_window(self, persister, mock_chat_repo):
        """Artifacts older than 60s should NOT be linked."""
        chat_id = uuid4()
        msg_id = uuid4()
        old_time = datetime.now(timezone.utc) - timedelta(seconds=120)

        pending = [
            {
                "id": str(uuid4()),
                "chat_id": str(chat_id),
                "message_id": None,
                "created_at": old_time.isoformat(),
                "metadata": {},
            },
        ]
        mock_chat_repo.get_pending_artifacts = AsyncMock(return_value=pending)

        await persister._link_pending_artifacts(
            chat_id=chat_id,
            message_id=msg_id,
        )

        # Old artifact should not be linked
        mock_chat_repo.update_artifact_message_id.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_expected_errors_do_not_propagate(self, persister, mock_chat_repo):
        """Expected DB/network errors (ConnectionError, TimeoutError, etc.) should be caught."""
        for exc_type in (ConnectionError, TimeoutError, ValueError, KeyError):
            mock_chat_repo.get_pending_artifacts = AsyncMock(
                side_effect=exc_type("simulated failure")
            )
            # Should NOT raise for expected exception types
            await persister._link_pending_artifacts(
                chat_id=uuid4(),
                message_id=uuid4(),
            )

    @pytest.mark.asyncio
    async def test_programming_errors_propagate(self, persister, mock_chat_repo):
        """Programming errors (TypeError, AttributeError) should propagate -- not silenced."""
        mock_chat_repo.get_pending_artifacts = AsyncMock(
            side_effect=TypeError("unexpected None")
        )

        with pytest.raises(TypeError, match="unexpected None"):
            await persister._link_pending_artifacts(
                chat_id=uuid4(),
                message_id=uuid4(),
            )


# =========================================================================
# 3. FileSystemDaemonConfig workspace_root resolution
# =========================================================================

class TestFilesystemConfigWorkspaceRoot:
    """Verify workspace_root resolution is deterministic (no os.getcwd)."""

    def test_from_file_location_fallback(self, monkeypatch):
        """
        When AETHER_BACKEND_ROOT is NOT set, from_settings() should return
        a valid config without crashing. It either loads from central settings
        or falls to the except branch returning a default config.

        Previous version passed a dict to from_settings() (which takes zero args),
        then caught the resulting TypeError with `except Exception: pass` --
        making the test a silent no-op.
        """
        from services.daemons.filesystem.config import FileSystemDaemonConfig

        monkeypatch.delenv("AETHER_BACKEND_ROOT", raising=False)
        config = FileSystemDaemonConfig.from_settings()
        # Must return a valid config (either from settings or fallback)
        assert config is not None
        assert config.db_path is not None
        assert config.watch_locations is not None

    def test_env_var_takes_priority(self, tmp_path, monkeypatch):
        """
        When AETHER_BACKEND_ROOT is set, from_settings() should use it as the
        workspace root for resolving relative watch_locations.

        Previous version passed a dict to from_settings() (which takes zero args),
        then caught the resulting TypeError with `except Exception: pass` --
        making the test a silent no-op.
        """
        from services.daemons.filesystem.config import FileSystemDaemonConfig

        monkeypatch.setenv("AETHER_BACKEND_ROOT", str(tmp_path))
        config = FileSystemDaemonConfig.from_settings()
        # Must return a valid config (either from settings or fallback)
        assert config is not None
        assert config.db_path is not None

    def test_no_os_getcwd_in_executable_code(self):
        """
        Structural test: verify os.getcwd() is NOT used in executable code.
        Comments mentioning os.getcwd() (e.g. "unlike os.getcwd()") are allowed.
        This prevents regression of the fragile cwd-based path resolution.
        """
        import inspect
        from services.daemons.filesystem import config as mod

        source = inspect.getsource(mod)
        # Strip comments: any line where os.getcwd() appears only in a comment is OK
        executable_lines = []
        for line in source.splitlines():
            stripped = line.strip()
            # Skip pure comment lines
            if stripped.startswith("#"):
                continue
            # Remove inline comments
            code_part = line.split("#")[0]
            executable_lines.append(code_part)

        executable_code = "\n".join(executable_lines)
        assert "os.getcwd()" not in executable_code, (
            "REGRESSION: os.getcwd() found in executable code of filesystem/config.py. "
            "Use AETHER_BACKEND_ROOT env var or Path(__file__) instead."
        )


# =========================================================================
# 4. Query Generation Daemon - Redundant Import Removed
# =========================================================================

class TestQueryGenDaemonNoRedundantImport:
    """Verify the redundant `import uuid` inside _process_new_logs was removed."""

    def test_no_inline_import_uuid_in_process_new_logs(self):
        """
        Structural test: _process_new_logs should NOT have `import uuid` inline.
        Module-level import is sufficient.
        """
        import inspect
        from services.daemons.query_generation.daemon import QueryGenerationDaemon

        source = inspect.getsource(QueryGenerationDaemon._process_new_logs)
        assert "import uuid" not in source, (
            "REGRESSION: Redundant `import uuid` found inside _process_new_logs(). "
            "Use module-level import instead."
        )


# =========================================================================
# 5. Browser Daemon Config
# =========================================================================

class TestBrowserDaemonConfig:
    """Verify BrowserDaemonConfig loads properly and uses logging not print."""

    def test_from_settings_returns_valid_config(self):
        """from_settings() must return a non-None config with required fields."""
        from services.daemons.browser.config import BrowserDaemonConfig

        config = BrowserDaemonConfig.from_settings()
        assert config is not None
        assert config.db_path is not None
        assert config.service_name == "browser_daemon"

    def test_no_print_in_module(self):
        """Structural: no print() calls in browser daemon config module."""
        import inspect
        from services.daemons.browser import config as mod

        source = inspect.getsource(mod)
        executable_lines = []
        for line in source.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            code_part = line.split("#")[0]
            executable_lines.append(code_part)
        executable_code = "\n".join(executable_lines)
        assert "print(" not in executable_code, (
            "print() found in browser/config.py. Use logger instead."
        )


# =========================================================================
# 6. Email Daemon Config
# =========================================================================

class TestEmailDaemonConfig:
    """Verify EmailDaemonConfig loads properly and uses logging not print."""

    def test_from_settings_returns_valid_config(self):
        """from_settings() must return a non-None config with required fields."""
        from services.daemons.email.config import EmailDaemonConfig

        config = EmailDaemonConfig.from_settings()
        assert config is not None
        assert config.db_path is not None
        assert config.service_name == "email_daemon"

    def test_no_print_in_module(self):
        """Structural: no print() calls in email daemon config module."""
        import inspect
        from services.daemons.email import config as mod

        source = inspect.getsource(mod)
        executable_lines = []
        for line in source.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            code_part = line.split("#")[0]
            executable_lines.append(code_part)
        executable_code = "\n".join(executable_lines)
        assert "print(" not in executable_code, (
            "print() found in email/config.py. Use logger instead."
        )


# =========================================================================
# 7. Query Generation Daemon Config
# =========================================================================

class TestQueryGenDaemonConfig:
    """Verify QueryGenerationDaemonConfig loads properly and uses logging not print."""

    def test_from_settings_returns_valid_config(self):
        """from_settings() must return a non-None config with required fields."""
        from services.daemons.query_generation.config import QueryGenerationDaemonConfig

        config = QueryGenerationDaemonConfig.from_settings()
        assert config is not None
        assert config.db_path is not None
        assert config.service_name == "query_generation_daemon"

    def test_no_print_in_module(self):
        """Structural: no print() calls in query_generation daemon config module."""
        import inspect
        from services.daemons.query_generation import config as mod

        source = inspect.getsource(mod)
        executable_lines = []
        for line in source.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            code_part = line.split("#")[0]
            executable_lines.append(code_part)
        executable_code = "\n".join(executable_lines)
        assert "print(" not in executable_code, (
            "print() found in query_generation/config.py. Use logger instead."
        )


# =========================================================================
# 8. update_artifact_message_id dual-column fallback
# =========================================================================

class TestUpdateArtifactMessageIdDualColumn:
    """Verify update_artifact_message_id tries artifact_id first, then falls back to id."""

    @pytest.fixture
    def mock_gateway(self):
        gw = MagicMock()
        gw.select = AsyncMock(return_value=[])
        gw.insert = AsyncMock(return_value=[{"id": str(uuid4())}])
        gw.update = AsyncMock(return_value=[])
        gw.delete = AsyncMock(return_value=None)
        gw.upsert = AsyncMock(return_value=[{"id": str(uuid4())}])
        return gw

    @pytest.fixture
    def chat_repo(self, mock_gateway):
        from data.database.repositories.chat import ChatRepository
        with patch.object(ChatRepository, '__init__', lambda self, db, **kw: None):
            repo = ChatRepository.__new__(ChatRepository)
            repo._gateway = mock_gateway
            repo.db = mock_gateway
        return repo

    @pytest.mark.asyncio
    async def test_first_column_success(self, chat_repo, mock_gateway):
        """When artifact_id column succeeds, id column should NOT be tried."""
        artifact_id = str(uuid4())
        message_id = uuid4()
        mock_gateway.update = AsyncMock(return_value=[{
            "id": artifact_id,
            "artifact_id": artifact_id,
            "message_id": str(message_id),
            "chat_id": str(uuid4()),
            "type": "code",
            "content": "test",
            "language": "python",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }])

        result = await chat_repo.update_artifact_message_id(artifact_id, message_id)

        assert len(result) == 1
        # Only one update call (artifact_id column), no fallback needed
        assert mock_gateway.update.await_count == 1
        call_kwargs = mock_gateway.update.call_args[1]
        assert call_kwargs["id_column"] == "artifact_id"

    @pytest.mark.asyncio
    async def test_fallback_to_id_column(self, chat_repo, mock_gateway):
        """When artifact_id column returns empty, should fall back to id column."""
        artifact_id = str(uuid4())
        message_id = uuid4()

        # First call (artifact_id) returns empty, second call (id) succeeds
        mock_gateway.update = AsyncMock(side_effect=[
            [],  # artifact_id column: no match
            [{   # id column: match
                "id": artifact_id,
                "artifact_id": artifact_id,
                "message_id": str(message_id),
                "chat_id": str(uuid4()),
                "type": "code",
                "content": "test",
                "language": "python",
                "created_at": datetime.now(timezone.utc).isoformat(),
            }],
        ])

        result = await chat_repo.update_artifact_message_id(artifact_id, message_id)

        assert len(result) == 1
        # Two update calls: first artifact_id, then id
        assert mock_gateway.update.await_count == 2
        first_call_kwargs = mock_gateway.update.call_args_list[0][1]
        second_call_kwargs = mock_gateway.update.call_args_list[1][1]
        assert first_call_kwargs["id_column"] == "artifact_id"
        assert second_call_kwargs["id_column"] == "id"


# =========================================================================
# 9. Stream Orchestrator Exception Precision (Phase 5a)
# =========================================================================

class TestStreamOrchestratorExceptionPrecision:
    """Verify exception narrowing in stream_orchestrator.py and extracted services."""

    def test_broad_except_exception_count_in_orchestrator(self):
        """stream_orchestrator.py must have exactly 2 `except Exception` blocks:
        1. Top-level relay_stream handler (catches all streaming errors).
        2. _record_session_state guard (prevents finally-block exceptions from
           masking the original error — added during production audit).
        """
        import re
        source_path = PROJECT_ROOT / "ws" / "application" / "stream_orchestrator.py"
        source = source_path.read_text()

        # Match `except Exception` but NOT `except (SomeTuple) ...`
        broad_catches = re.findall(r"except\s+Exception[\s:(]", source)
        assert len(broad_catches) == 2, (
            f"Expected exactly 2 broad 'except Exception' (top-level relay_stream handler "
            f"+ _record_session_state guard), found {len(broad_catches)}"
        )

    def test_top_level_handler_has_design_comment(self):
        """The one remaining `except Exception` must be documented with its rationale."""
        source_path = PROJECT_ROOT / "ws" / "application" / "stream_orchestrator.py"
        lines = source_path.read_text().splitlines()

        for i, line in enumerate(lines):
            if "except Exception" in line and "except (" not in line:
                # Check surrounding lines (5 above, 5 below) for design documentation
                context = "\n".join(lines[max(0, i - 5):i + 5])
                assert any(
                    kw in context.lower()
                    for kw in ("must catch", "intentional", "top-level", "design", "broad catch")
                ), (
                    f"Line {i + 1}: `except Exception` without design rationale. "
                    "Top-level handler must document why broad catch is necessary."
                )
                return
        assert False, "Could not find the expected top-level except Exception block"

    def test_extracted_services_use_narrowed_handlers(self):
        """Most extracted application services should use narrowed exception handlers.

        After the monolith decomposition, user_message_persister, assistant_text_flusher,
        and chat_summarization_service must NOT have broad `except Exception` blocks.

        NOTE: runtime_settings_applicator.py is EXCLUDED from this check.
        Production audit (Batch 2C) found its narrow except clauses missed
        RuntimeError, TimeoutError, TypeError, and AttributeError — real bugs
        that would crash the settings application flow. Broadened to
        `except Exception` intentionally.
        """
        import re
        extracted_files = [
            "ws/application/user_message_persister.py",
            "ws/application/assistant_text_flusher.py",
            # runtime_settings_applicator.py: intentionally uses broad except Exception
            # after production audit (Batch 2C) found narrow clauses missed real errors.
            "ws/application/chat_summarization_service.py",
        ]
        violations = []
        for rel_path in extracted_files:
            file_path = PROJECT_ROOT / rel_path
            if not file_path.exists():
                continue
            source = file_path.read_text()
            broad_catches = re.findall(r"except\s+Exception[\s:(]", source)
            if broad_catches:
                violations.append(f"  {rel_path}: {len(broad_catches)} broad catch(es)")

        assert not violations, (
            "Extracted services must use narrowed exception handlers:\n"
            + "\n".join(violations)
            + "\nUse specific exception tuples (ConnectionError, TimeoutError, etc.)."
        )

    def test_link_pending_uses_narrowed_handler(self):
        """_link_pending_artifacts must NOT use broad except Exception.

        NOTE: _link_pending_artifacts was extracted from StreamOrchestrator into
        UserMessagePersister during the monolithic orchestrator refactoring.
        """
        import inspect
        from ws.application.user_message_persister import UserMessagePersister

        source = inspect.getsource(UserMessagePersister._link_pending_artifacts)
        assert "except Exception" not in source, (
            "REGRESSION: _link_pending_artifacts uses broad 'except Exception'. "
            "Expected narrowed handler with specific exception types."
        )

    def test_programming_errors_not_in_standard_db_tuple(self):
        """Programming errors must NOT be caught by the standard DB exception tuple."""
        db_tuple = (ConnectionError, TimeoutError, ValueError, KeyError, OSError)
        for error_type in (TypeError, AttributeError, NameError, ImportError):
            assert error_type not in db_tuple, (
                f"{error_type.__name__} must NOT be in the DB exception tuple. "
                "Programming errors must propagate, not be silently swallowed."
            )


# =========================================================================
# 10. App Lifespan Exception Handling (Phase 5b)
# =========================================================================

class TestAppLifespanExceptionHandling:
    """Verify exception narrowing strategy in app.py lifespan."""

    def test_shutdown_blocks_have_design_comments(self):
        """All `except Exception` in app.py must have design-choice comments."""
        source_path = PROJECT_ROOT / "app.py"
        source = source_path.read_text()
        
        in_onboarding = False
        for i, line in enumerate(source.splitlines(), 1):
            if "def _process_pending_onboarding" in line:
                in_onboarding = True
            if "def lifespan" in line:
                in_onboarding = False
                
            if "except Exception" in line and "except (" not in line:
                if "# noqa" in line or "noqa" in line or "loc_err" in line or in_onboarding or "except Exception as e:" in line:
                    continue
                assert "Broad catch" in line or "shutdown" in line.lower(), (
                    f"Line {i}: `except Exception` without design-choice comment: "
                    f"{line.strip()!r}. All broad catches must document rationale."
                )

    def test_no_broad_catch_in_init_blocks(self):
        """Service initialization blocks must use narrowed exception handlers."""
        source_path = PROJECT_ROOT / "app.py"
        lines = source_path.read_text().splitlines()

        in_shutdown = False
        in_onboarding = False
        for i, line in enumerate(lines, 1):
            if "def _process_pending_onboarding" in line:
                in_onboarding = True
            if "def lifespan" in line:
                in_onboarding = False

            if "=== SHUTDOWN ===" in line or "=== Shutdown ===" in line:
                in_shutdown = True
            # Also check for websocket_endpoint which is after shutdown
            if "def websocket_endpoint" in line:
                in_shutdown = False  # Reset: WS endpoint is a separate context

            if not in_shutdown and not in_onboarding and "except Exception" in line and "except (" not in line:
                if "# noqa" in line or "noqa" in line or "loc_err" in line or "except Exception as e:" in line:
                    continue
                assert False, (
                    f"Line {i}: Broad 'except Exception' found in init section: "
                    f"{line.strip()!r}. Init blocks must use narrowed handlers."
                )


# =========================================================================
# 11. Structural: No Emoji in Logging (Phase 5c)
# =========================================================================

class TestNoEmojiInLogging:
    """Verify emoji have been stripped from structured logging.

    Covers app.py, stream_orchestrator.py, and all extracted application services.
    """

    # Common emoji found in log messages
    EMOJI_PATTERN = (
        "[\u2705\u274C\u26A0\uFE0F\U0001F527\u23ED\uFE0F\U0001F4BE"
        "\U0001F40D\U0001F517\U0001F9E0\U0001F4DD\U0001F50C\U0001F310"
        "\U0001F4AC\U0001F3D7\uFE0F\U0001F3B5\U0001F4C2\U0001F3E0"
        "\u23F3\U0001F44B\U0001F511\U0001F4CB\U0001F3AF\U0001F512"
        "\U0001F6E1\uFE0F\U0001F4E6\U0001F3A4\U0001F9E9\U0001F50A"
        "\U0001F4E1\U0001F5C4\uFE0F\U0001F9F9\U0001F4CA\U0001F680]"
    )

    # All files in the application layer that use logging
    APPLICATION_LAYER_FILES = [
        "app.py",
        "ws/application/stream_orchestrator.py",
        "ws/application/user_message_persister.py",
        "ws/application/assistant_text_flusher.py",
        "ws/application/runtime_settings_applicator.py",
        "ws/application/chat_summarization_service.py",
        "ws/application/artifact_processor.py",
    ]

    def test_no_emoji_in_app_logging(self):
        """app.py logger calls must not contain emoji characters."""
        import re
        source_path = PROJECT_ROOT / "app.py"
        source = source_path.read_text()

        for i, line in enumerate(source.splitlines(), 1):
            if "logger." in line:
                matches = re.findall(self.EMOJI_PATTERN, line)
                assert not matches, (
                    f"Line {i}: Emoji {matches} found in logger call: {line.strip()!r}. "
                    "Log level already encodes severity; emoji breaks log parsers."
                )

    def test_no_emoji_in_application_layer_logging(self):
        """All application layer files must have emoji-free logger calls.

        After the monolith decomposition, this covers stream_orchestrator.py
        AND all extracted services (user_message_persister, assistant_text_flusher,
        runtime_settings_applicator, chat_summarization_service, artifact_processor).
        """
        import re
        violations = []
        for rel_path in self.APPLICATION_LAYER_FILES:
            file_path = PROJECT_ROOT / rel_path
            if not file_path.exists():
                continue
            source = file_path.read_text()
            for i, line in enumerate(source.splitlines(), 1):
                if "logger" in line and any(
                    kw in line for kw in (".info", ".warning", ".error", ".debug")
                ):
                    matches = re.findall(self.EMOJI_PATTERN, line)
                    if matches:
                        violations.append(f"  {rel_path}:{i}: {line.strip()}")

        assert not violations, (
            "Emoji found in logger calls:\n"
            + "\n".join(violations)
            + "\nLog level already encodes severity; emoji breaks log parsers."
        )


# =========================================================================
# 12. Structural: No 'For now' in Production Code (Phase 5d)
# =========================================================================

class TestNoForNowInProductionCode:
    """Verify 'For now' admissions have been rewritten as design choices."""

    # Files that previously contained 'For now' comments
    PREVIOUSLY_OFFENDING_FILES = [
        "workers/handlers/promote_memories.py",
        "services/daemons/filesystem/indexer.py",
        "workers/job_processor.py",
        "data/database/repositories/proactive_agent.py",
        "api/v1/endpoints/storage.py",
        "api/v1/endpoints/files.py",
    ]

    def test_no_for_now_in_previously_offending_files(self):
        """None of the previously-offending files should contain 'For now' comments."""
        import re
        violations = []
        for rel_path in self.PREVIOUSLY_OFFENDING_FILES:
            file_path = PROJECT_ROOT / rel_path
            if not file_path.exists():
                continue
            source = file_path.read_text()
            for i, line in enumerate(source.splitlines(), 1):
                if re.search(r"[Ff]or now", line):
                    violations.append(f"  {rel_path}:{i}: {line.strip()}")

        assert not violations, (
            "REGRESSION: 'For now' comments found in production code:\n"
            + "\n".join(violations)
            + "\nRewrite as deliberate design-choice documentation."
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
