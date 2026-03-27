import pytest


@pytest.mark.asyncio
async def test_runtime_engine_get_interpreter_delegates(monkeypatch):
    from core.runtime import engine as engine_module

    sentinel = object()

    async def fake_get_interpreter(*, chat_id=None, session_id=None):
        return sentinel

    # The RuntimeEngine method calls the module-level get_interpreter symbol.
    monkeypatch.setattr(
        engine_module,
        "get_interpreter",
        lambda chat_id=None, session_id=None: fake_get_interpreter(chat_id=chat_id, session_id=session_id),
    )

    runtime = engine_module.RuntimeEngine(settings=None)
    result = await runtime.get_interpreter("chat-123")
    assert result is sentinel

