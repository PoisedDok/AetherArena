import uuid

import pytest


@pytest.mark.asyncio
async def test_external_oi_history_hydration_via_settings_messages() -> None:
    """
    Real integration test (no mocks):
    - Spawns a per-chat external Open Interpreter server (if enabled in central config)
    - Sets conversation messages via HTTP /settings {messages:[...]}
    - Verifies /settings/messages reflects the hydrated history
    """
    from config.settings import get_settings
    from core.runtime.engine import get_interpreter_manager
    from core.runtime.interpreter_adapter import RuntimeInterpreterAdapter
    from core.integrations.providers.open_interpreter.external_ws_proxy import ExternalOIWebSocketInterpreter

    settings = get_settings()
    assert settings.interpreter.external_server_enabled is True, "external OI server mode must be enabled for this test"
    assert settings.interpreter.external_server_per_chat is True, "per-chat external OI mode must be enabled for this test"

    chat_id = str(uuid.uuid4())
    adapter = RuntimeInterpreterAdapter()
    await adapter.initialize()

    manager = get_interpreter_manager()

    try:
        interpreter = await adapter.get_interpreter(chat_id=chat_id)
        assert isinstance(interpreter, ExternalOIWebSocketInterpreter)
        assert interpreter.http_url, "external interpreter must expose http_url for settings API"

        # Apply via adapter.apply_history (the production path used by WS context hydration).
        history = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        await adapter.apply_history(history, chat_id=chat_id)

        got = await interpreter.get_setting("messages")
        messages = got.get("messages")
        assert isinstance(messages, list)
        assert len(messages) == 2
        assert messages[0].get("role") == "user"
        assert messages[1].get("role") == "assistant"
    finally:
        # Hard cleanup: terminate the per-chat server process and release the port.
        await manager.reset_interpreter(chat_id=chat_id)

