import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from application.context.context_manager import ContextManager
from config.settings import reload_settings


@pytest.mark.unit
@pytest.mark.asyncio
async def test_context_export_uses_settings_summary_template(monkeypatch):
    monkeypatch.setenv("CONTEXT_EXPORT_SUMMARY_TEMPLATE", "msgs={message_count} tokens={token_count}")
    reload_settings()

    interpreter = SimpleNamespace(
        get_context_status=lambda _chat_id: {"message_count": 3, "token_count": 123},
        summarize_context=AsyncMock(),
    )
    chat_repo = SimpleNamespace(
        get_chat=AsyncMock(return_value=SimpleNamespace(title="T", created_at=None))
    )

    manager = ContextManager(
        chat_service=chat_repo, 
        interpreter_manager=interpreter
    )
    chat_id = str(uuid.uuid4())
    result = await manager.export_context(chat_id)

    assert result["summary"] == "msgs=3 tokens=123"
    assert "title" in result  # Context export includes chat metadata
    assert result["title"] == "T"

