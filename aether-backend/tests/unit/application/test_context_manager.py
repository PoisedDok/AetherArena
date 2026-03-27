"""
Unit Tests: ContextManager (application/context/context_manager.py)

Comprehensive coverage of context status retrieval, summarization,
and export functionality.

Mock boundaries:
- interpreter_manager → mock (typed as Any, dynamic method calls)
- ChatRepository → mock get_chat
- config.settings.get_settings → mock for export_context
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

import pytest

from application.context.context_manager import ContextManager


# ─── Helpers ─────────────────────────────────────────────────────────────────

CHAT_ID = str(uuid4())
CHAT_UUID = UUID(CHAT_ID)
NOW = datetime(2026, 2, 9, 12, 0, 0, tzinfo=timezone.utc)


def _make_interpreter_manager(
    *,
    status: Dict[str, Any] | None = None,
    summary: str | None = "Context summarized successfully.",
) -> MagicMock:
    """Create a mock interpreter_manager with expected methods."""
    mgr = MagicMock()
    mgr.get_context_status.return_value = status or {
        "status": "normal",
        "token_count": 1000,
        "message_count": 10,
        "usage_percent": 25.0,
    }
    mgr.summarize_context = AsyncMock(return_value=summary)
    return mgr


def _make_chat_repository() -> MagicMock:
    """Create a mock ChatRepository."""
    repo = MagicMock(spec=["get_chat"])
    repo.get_chat = AsyncMock()
    return repo


def _make_chat_model(
    *,
    chat_id: UUID | None = None,
    title: str = "Test Chat",
) -> MagicMock:
    """Create a mock Chat model object."""
    chat = MagicMock()
    chat.id = chat_id or CHAT_UUID
    chat.title = title
    chat.created_at = NOW
    chat.updated_at = NOW
    return chat


def _make_service(
    interpreter_manager: MagicMock | None = None,
    chat_service: MagicMock | None = None,
) -> tuple[ContextManager, MagicMock, MagicMock]:
    """Create ContextManager with mocked dependencies. Returns (service, interpreter_manager, chat_repo)."""
    if interpreter_manager is None:
        interpreter_manager = _make_interpreter_manager()
    if chat_service is None:
        chat_service = _make_chat_repository()
    svc = ContextManager(
        interpreter_manager=interpreter_manager,
        chat_service=chat_service,
    )
    return svc, interpreter_manager, chat_service


# ─── __init__ ────────────────────────────────────────────────────────────────


class TestInit:
    def test_stores_dependencies(self):
        svc, mgr, repo = _make_service()
        assert svc._interpreter_manager is mgr
        assert svc._chat_repo is repo


# ─── get_context_status ──────────────────────────────────────────────────────


class TestGetContextStatus:
    async def test_happy_path(self):
        svc, mgr, _ = _make_service()
        mgr.get_context_status.return_value = {
            "status": "warning",
            "token_count": 5000,
            "message_count": 50,
            "usage_percent": 75.0,
        }

        result = await svc.get_context_status(CHAT_ID)

        assert result["status"] == "warning"
        assert result["token_count"] == 5000
        assert result["message_count"] == 50
        mgr.get_context_status.assert_called_once_with(CHAT_ID)

    async def test_exception_re_raised(self):
        svc, mgr, _ = _make_service()
        mgr.get_context_status.side_effect = RuntimeError("interpreter down")

        with pytest.raises(RuntimeError, match="interpreter down"):
            await svc.get_context_status(CHAT_ID)


# ─── summarize_context ───────────────────────────────────────────────────────


class TestSummarizeContext:
    async def test_happy_path(self):
        status_before = {"status": "warning", "token_count": 5000, "message_count": 50}
        status_after = {"status": "normal", "token_count": 2000, "message_count": 50}

        svc, mgr, _ = _make_service()
        mgr.get_context_status.side_effect = [status_before, status_after]
        mgr.summarize_context.return_value = "Summary text"

        result = await svc.summarize_context(CHAT_ID)

        assert result["success"] is True
        assert result["summary_text"] == "Summary text"
        assert result["tokens_before"] == 5000
        assert result["tokens_after"] == 2000
        assert result["tokens_saved"] == 3000
        assert result["message_count"] == 50

    async def test_summary_none_sets_success_false(self):
        status = {"status": "normal", "token_count": 1000, "message_count": 10}
        svc, mgr, _ = _make_service()
        mgr.get_context_status.return_value = status
        mgr.summarize_context.return_value = None

        result = await svc.summarize_context(CHAT_ID)

        assert result["success"] is False
        assert result["summary_text"] is None

    async def test_exception_re_raised(self):
        svc, mgr, _ = _make_service()
        mgr.get_context_status.side_effect = RuntimeError("failed")

        with pytest.raises(RuntimeError, match="failed"):
            await svc.summarize_context(CHAT_ID)

    async def test_summarize_exception_re_raised(self):
        svc, mgr, _ = _make_service()
        mgr.summarize_context.side_effect = RuntimeError("summarize failed")

        with pytest.raises(RuntimeError, match="summarize failed"):
            await svc.summarize_context(CHAT_ID)


# ─── export_context ──────────────────────────────────────────────────────────


class TestExportContext:
    async def test_happy_path(self):
        svc, mgr, repo = _make_service()
        mgr.get_context_status.return_value = {
            "status": "normal",
            "token_count": 3000,
            "message_count": 30,
        }
        repo.get_chat.return_value = _make_chat_model(title="Architecture Chat")

        mock_settings = MagicMock()
        mock_settings.context_export.summary_template = (
            "Chat with {message_count} messages, {token_count} tokens"
        )

        with patch("application.context.context_manager.get_settings", return_value=mock_settings):
            result = await svc.export_context(CHAT_ID)

        assert result["chat_id"] == CHAT_ID
        assert result["title"] == "Architecture Chat"
        assert result["created_at"] == NOW
        assert result["summary"] == "Chat with 30 messages, 3000 tokens"
        assert result["token_count"] == 3000
        assert result["message_count"] == 30
        assert result["key_points"] == []
        assert result["artifacts_used"] == []

    async def test_chat_not_found(self):
        svc, mgr, repo = _make_service()
        mgr.get_context_status.return_value = {
            "status": "normal", "token_count": 100, "message_count": 5,
        }
        repo.get_chat.return_value = None

        mock_settings = MagicMock()
        mock_settings.context_export.summary_template = "{message_count} msgs"

        with patch("application.context.context_manager.get_settings", return_value=mock_settings):
            result = await svc.export_context(CHAT_ID)

        assert result["title"] == "Unknown Chat"
        assert result["created_at"] is None

    async def test_exception_re_raised(self):
        svc, mgr, repo = _make_service()
        mgr.get_context_status.side_effect = RuntimeError("context error")

        with pytest.raises(RuntimeError, match="context error"):
            await svc.export_context(CHAT_ID)

    async def test_repo_exception_re_raised(self):
        svc, mgr, repo = _make_service()
        mgr.get_context_status.return_value = {
            "status": "normal", "token_count": 100, "message_count": 5,
        }
        repo.get_chat.side_effect = RuntimeError("db error")

        with pytest.raises(RuntimeError, match="db error"):
            await svc.export_context(CHAT_ID)
