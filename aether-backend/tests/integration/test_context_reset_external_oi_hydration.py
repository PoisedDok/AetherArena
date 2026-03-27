import asyncio
import time
import uuid
from uuid import UUID

import pytest


@pytest.mark.asyncio
async def test_context_reset_hydrates_full_history_into_external_oi(
    supabase_gateway,
) -> None:
    """
    Real integration test (no mocks for persistence or external OI):

    Repro target:
    - Chat has persisted history in DB
    - Switching back to that chat triggers `context_reset`
    - Backend must hydrate the external Open Interpreter server with the full history (not "fresh 2 messages")
    """
    from config.settings import get_settings
    from core.runtime.engine import RuntimeEngine, get_interpreter_manager
    from core.integrations.providers.open_interpreter.external_ws_proxy import ExternalOIWebSocketInterpreter
    from ws.presentation.handlers.context_handler import ContextHandler
    from ws.protocols import ContextResetMessage
    from application.chat.history_service import ChatHistoryService
    from data.database.uow import SupabaseRequestContext, SupabaseUnitOfWork
    from data.database.repositories.chat import ChatRepository

    settings = get_settings()
    assert settings.interpreter.external_server_enabled is True, "external OI server mode must be enabled for this test"
    assert settings.interpreter.external_server_per_chat is True, "per-chat external OI mode must be enabled for this test"

    chat_id = UUID(str(uuid.uuid4()))
    client_id = "test-client-context-reset"

    # Persist a real chat + messages (DB is source of truth for history hydration).
    context = SupabaseRequestContext(
        request_id=f"test-ws-history-{uuid.uuid4().hex}",
        correlation_id=None,
        extras={"source": "tests.integration.context_reset"},
    )
    async with SupabaseUnitOfWork(supabase_gateway, context) as uow:
        repo = ChatRepository(uow.gateway)
        await repo.create_chat_with_id(chat_id, title="Context Reset Hydration Test")
        await repo.create_message(chat_id, role="user", content="m1")
        await repo.create_message(chat_id, role="assistant", content="m2")
        await repo.create_message(chat_id, role="user", content="m3")
        await repo.create_message(chat_id, role="assistant", content="m4")

    engine = RuntimeEngine(settings)
    manager = get_interpreter_manager()

    try:
        await engine.start(mcp_manager=None)

        # Real history loader (no mocks).
        history_service = ChatHistoryService(supabase_gateway)

        # Minimal cache + ws stubs.
        class _Cache:
            async def update_presence_metadata(self, *_args, **_kwargs) -> None:
                return None

        class _WS:
            async def send_text(self, _text: str) -> None:
                return None

        handler = ContextHandler(runtime=engine, history_service=history_service, cache_service=_Cache())

        # Simulate the frontend chat switch → context_reset.
        msg = ContextResetMessage(chat_id=str(chat_id))
        await handler.handle_context_reset(ws=_WS(), client_id=client_id, message=msg, hub=None)

        # `set_history()` schedules async hydration; poll until the external OI server reports the full history.
        deadline = time.monotonic() + 20.0
        last_err: Exception | None = None
        messages = None
        while time.monotonic() < deadline:
            try:
                interpreter = await engine.get_interpreter(chat_id=str(chat_id))
                assert isinstance(interpreter, ExternalOIWebSocketInterpreter)
                got = await interpreter.get_setting("messages")
                messages = got.get("messages")
                if isinstance(messages, list) and len(messages) == 4:
                    break
            except Exception as e:  # noqa: BLE001 - intentional polling
                last_err = e
            await asyncio.sleep(0.25)

        assert isinstance(messages, list)
        assert len(messages) == 4
        assert [m.get("role") for m in messages] == ["user", "assistant", "user", "assistant"]
        assert [m.get("content") for m in messages] == ["m1", "m2", "m3", "m4"]
    finally:
        # Terminate per-chat OI server process + cleanup interpreter.
        await manager.reset_interpreter(chat_id=str(chat_id))
        await engine.stop()

        # Cleanup DB chat (best-effort).
        context2 = SupabaseRequestContext(
            request_id=f"test-ws-history-cleanup-{uuid.uuid4().hex}",
            correlation_id=None,
            extras={"source": "tests.integration.context_reset.cleanup"},
        )
        async with SupabaseUnitOfWork(supabase_gateway, context2) as uow2:
            repo2 = ChatRepository(uow2.gateway)
            try:
                await repo2.delete_chat(chat_id)
            except Exception:
                # Best-effort cleanup; don't mask test failures.
                pass

