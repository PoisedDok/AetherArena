"""
Unit Tests: ws/presentation/handlers/context_handler.py

Tests the ContextHandler class — context reset coordination,
history loading, memory injection, API docs injection.

Written against source code line-by-line: every branch forced,
every error path exercised, every callback verified.

Bugs found and fixed:
1. Line 195: API docs deduplication check used "## Backend API Access"
   but injected string contains "## 🔌 Backend API Access". The emoji
   between "## " and "Backend" meant the substring check never matched,
   causing duplicate injection on every context reset.
   → Fixed: check now includes emoji to match injected string.
   → Regression test: TestApiDocsInjection::test_deduplication_prevents_duplicate_injection
"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import pytest

from ws.presentation.handlers.context_handler import ContextHandler
from ws.protocols import MessageRole, MessageType


# =========================================================================
# Stubs & Helpers
# =========================================================================

VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"


class StubWebSocket:
    """Captures send_text calls for assertion."""

    def __init__(self, *, fail_on_send=False):
        self.sent_texts = []
        self._fail_on_send = fail_on_send

    async def send_text(self, text: str):
        if self._fail_on_send:
            raise RuntimeError("connection closed")
        self.sent_texts.append(json.loads(text))


class StubClient:
    """Minimal hub client with active_chat_id."""

    def __init__(self):
        self.active_chat_id = None


def make_runtime(**attrs):
    """
    Create a runtime with precise hasattr control.

    Uses SimpleNamespace so hasattr() returns False for unset attributes,
    unlike MagicMock which auto-creates any attribute on access.
    """
    ns = SimpleNamespace()
    ns.reset_context = AsyncMock()
    for key, value in attrs.items():
        setattr(ns, key, value)
    return ns


def make_handler(*, runtime=None, history_service=None, cache_service=None):
    """Create ContextHandler with mock dependencies."""
    if runtime is None:
        runtime = make_runtime()
    if cache_service is None:
        cache_service = AsyncMock()
    return ContextHandler(
        runtime=runtime,
        history_service=history_service,
        cache_service=cache_service,
    )


def make_message(*, chat_id=VALID_UUID):
    """Create a message with chat_id attribute."""
    return SimpleNamespace(chat_id=chat_id)


def make_hub(*, clients=None):
    """Create a hub stub with clients dict."""
    return SimpleNamespace(clients=clients if clients is not None else {})


# Patch targets for late imports inside handle_context_reset
PATCH_MEMORY = "core.runtime.memory_injector.get_memory_injector"
PATCH_SETTINGS = "config.settings.get_settings"
PATCH_ENGINE = "core.runtime.engine.get_interpreter"


# =========================================================================
# TestContextHandlerInit
# =========================================================================


class TestContextHandlerInit:
    """Wiring: construction and dependency injection."""

    def test_stores_all_dependencies(self):
        """All 3 deps stored on instance — verifies constructor wiring."""
        runtime = make_runtime()
        history = AsyncMock()
        cache = AsyncMock()
        handler = ContextHandler(
            runtime=runtime, history_service=history, cache_service=cache
        )
        assert handler._runtime is runtime
        assert handler._history_service is history
        assert handler._cache is cache

    def test_history_service_defaults_to_none(self):
        """history_service is Optional — must not raise when omitted."""
        handler = ContextHandler(runtime=make_runtime(), cache_service=AsyncMock())
        assert handler._history_service is None


# =========================================================================
# TestPresenceUpdate
# =========================================================================


class TestPresenceUpdate:
    """Cache presence metadata updates (lines 84-87)."""

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_updates_presence_with_correct_args(self, _s, _m):
        """update_presence_metadata called with client_id and last_event."""
        cache = AsyncMock()
        handler = make_handler(cache_service=cache)
        await handler.handle_context_reset(
            ws=StubWebSocket(), client_id="client-1", message=make_message()
        )
        cache.update_presence_metadata.assert_awaited_once_with(
            "client-1", last_event="context_reset"
        )

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_presence_called_even_without_hub(self, _s, _m):
        """Presence update runs regardless of hub presence."""
        cache = AsyncMock()
        handler = make_handler(cache_service=cache)
        await handler.handle_context_reset(
            ws=StubWebSocket(), client_id="cid", message=make_message(), hub=None
        )
        cache.update_presence_metadata.assert_awaited_once()


# =========================================================================
# TestClientState
# =========================================================================


class TestClientState:
    """Hub client active_chat_id updates (lines 77-81)."""

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_sets_active_chat_id_on_client(self, _s, _m):
        """When hub has the client, active_chat_id is set to message chat_id."""
        client = StubClient()
        hub = make_hub(clients={"c1": client})
        handler = make_handler()
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id="chat-42"),
            hub=hub,
        )
        assert client.active_chat_id == "chat-42"

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_skips_when_no_hub(self, _s, _m):
        """hub=None — no AttributeError raised."""
        handler = make_handler()
        await handler.handle_context_reset(
            ws=StubWebSocket(), client_id="c1", message=make_message(), hub=None
        )
        # Just verifying no exception raised

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_skips_when_chat_id_empty(self, _s, _m):
        """Empty chat_id — guard at line 77 prevents update."""
        client = StubClient()
        hub = make_hub(clients={"c1": client})
        handler = make_handler()
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=""),
            hub=hub,
        )
        assert client.active_chat_id is None  # unchanged from init

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_skips_when_client_not_in_hub(self, _s, _m):
        """Client ID not in hub.clients — no KeyError/AttributeError."""
        hub = make_hub(clients={})
        handler = make_handler()
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="missing",
            message=make_message(chat_id="chat-1"),
            hub=hub,
        )
        # Just verifying no exception raised


# =========================================================================
# TestRuntimeReset
# =========================================================================


class TestRuntimeReset:
    """Runtime context reset and error handling (lines 90-93)."""

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_calls_reset_context_with_correct_args(self, _s, _m):
        """reset_context receives client_id and chat_id as kwargs."""
        runtime = make_runtime()
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id="chat-7"),
        )
        runtime.reset_context.assert_awaited_once_with(
            client_id="c1", chat_id="chat-7"
        )

    @pytest.mark.parametrize(
        "exc_type",
        [RuntimeError, AttributeError, ConnectionError, OSError, ValueError],
        ids=["RuntimeError", "AttributeError", "ConnectionError", "OSError", "ValueError"],
    )
    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_handles_reset_exception(self, _s, _m, exc_type):
        """Each caught exception type sends error ack and returns early.

        Bug #10 fix: reset failure aborts context switch instead of
        continuing to load history into stale/failed context.
        """
        runtime = make_runtime()
        runtime.reset_context = AsyncMock(side_effect=exc_type("test"))
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message()
        )
        # Error ack sent (not success ack)
        assert len(ws.sent_texts) == 1
        ack = ws.sent_texts[0]
        assert ack["type"] == MessageType.CONTEXT_RESET_ACK
        assert ack["error"] is True
        assert "failed" in ack["message"].lower()

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_reset_failure_skips_history_loading(self, _s, _m):
        """Regression Bug #10: reset failure must NOT load history into stale context.

        Previously, reset_context failure was logged as a warning and the method
        continued to load history, contaminating the runtime with a mix of old
        and new conversation state.
        """
        runtime = make_runtime(
            set_history=MagicMock(),
            get_history_limit=MagicMock(return_value=100),
        )
        runtime.reset_context = AsyncMock(side_effect=RuntimeError("reset failed"))

        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=["msg1", "msg2"])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message(chat_id=VALID_UUID)
        )

        # History was NOT loaded into the failed context
        history_svc.load_history.assert_not_awaited()
        runtime.set_history.assert_not_called()

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_reset_failure_error_ack_send_fails_gracefully(self, _s, _m):
        """Reset fails AND ws.send_text fails → no unhandled exception."""
        runtime = make_runtime()
        runtime.reset_context = AsyncMock(side_effect=RuntimeError("reset failed"))

        handler = make_handler(runtime=runtime)
        ws = StubWebSocket(fail_on_send=True)
        # Must not raise
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message()
        )


# =========================================================================
# TestHistoryLoading
# =========================================================================


class TestHistoryLoading:
    """History loading with various runtime interfaces (lines 96-128)."""

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_loads_history_via_set_history(self, _s, _m):
        """Runtime has set_history (sync) — called with chat_id and messages."""
        runtime = make_runtime(
            set_history=MagicMock(),
            get_history_limit=MagicMock(return_value=50),
        )
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=["msg1", "msg2"])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.set_history.assert_called_once_with(VALID_UUID, ["msg1", "msg2"])

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_loads_history_via_load_history_async(self, _s, _m):
        """Runtime has load_history (async) but not set_history."""
        runtime = make_runtime(
            load_history=AsyncMock(),
            get_history_limit=MagicMock(return_value=None),
        )
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=["m1"])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.load_history.assert_awaited_once_with(
            client_id="c1", messages=["m1"]
        )

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_set_history_preferred_over_load_history(self, _s, _m):
        """When both set_history and load_history exist, set_history wins (line 114)."""
        runtime = make_runtime(
            set_history=MagicMock(),
            load_history=AsyncMock(),
            get_history_limit=MagicMock(return_value=100),
        )
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=["x"])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.set_history.assert_called_once()
        runtime.load_history.assert_not_awaited()

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_uses_custom_history_limit(self, _s, _m):
        """get_history_limit returns 25 — passed to load_history."""
        runtime = make_runtime(
            set_history=MagicMock(),
            get_history_limit=MagicMock(return_value=25),
        )
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=[])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        _, kwargs = history_svc.load_history.call_args
        assert kwargs["limit"] == 25

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_falls_back_to_default_limit_when_none(self, _s, _m):
        """get_history_limit returns None — falsy, `None or 100` → 100."""
        runtime = make_runtime(
            set_history=MagicMock(),
            get_history_limit=MagicMock(return_value=None),
        )
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=[])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        _, kwargs = history_svc.load_history.call_args
        assert kwargs["limit"] == 100

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_falls_back_to_default_limit_when_zero(self, _s, _m):
        """get_history_limit returns 0 — falsy, `0 or 100` → 100."""
        runtime = make_runtime(
            set_history=MagicMock(),
            get_history_limit=MagicMock(return_value=0),
        )
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=[])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        _, kwargs = history_svc.load_history.call_args
        assert kwargs["limit"] == 100

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_falls_back_to_default_limit_on_exception(self, _s, _m):
        """get_history_limit raises TypeError — caught, fallback to 100."""
        runtime = make_runtime(
            set_history=MagicMock(),
            get_history_limit=MagicMock(side_effect=TypeError("oops")),
        )
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=[])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        _, kwargs = history_svc.load_history.call_args
        assert kwargs["limit"] == 100

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_default_limit_when_no_get_history_limit(self, _s, _m):
        """Runtime has no get_history_limit method — uses default 100."""
        runtime = make_runtime(set_history=MagicMock())
        # No get_history_limit on runtime — hasattr returns False
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=[])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        _, kwargs = history_svc.load_history.call_args
        assert kwargs["limit"] == 100

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_skips_when_no_chat_id(self, _s, _m):
        """Empty chat_id — guard at line 96 skips history loading entirely."""
        history_svc = AsyncMock()
        handler = make_handler(history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=""),
        )
        history_svc.load_history.assert_not_awaited()

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_skips_when_no_history_service(self, _s, _m):
        """history_service is None — guard at line 96 skips."""
        handler = make_handler(history_service=None)
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message(chat_id=VALID_UUID)
        )
        # Just verifying no AttributeError on None
        assert len(ws.sent_texts) == 1

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_handles_invalid_uuid(self, _s, _m):
        """chat_id not a valid UUID — ValueError caught at line 127."""
        history_svc = AsyncMock()
        handler = make_handler(history_service=history_svc)
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message(chat_id="not-a-uuid")
        )
        # UUID("not-a-uuid") raises ValueError → caught → no load_history call
        history_svc.load_history.assert_not_awaited()
        # Ack still sent
        assert len(ws.sent_texts) == 1

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_handles_history_service_error(self, _s, _m):
        """load_history raises RuntimeError — caught at line 127."""
        runtime = make_runtime(
            set_history=MagicMock(),
            get_history_limit=MagicMock(return_value=100),
        )
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(side_effect=RuntimeError("db down"))

        handler = make_handler(runtime=runtime, history_service=history_svc)
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message(chat_id=VALID_UUID)
        )
        # Ack still sent despite error
        assert len(ws.sent_texts) == 1

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_converts_chat_id_to_uuid_for_service(self, _s, _m):
        """Verify UUID conversion at line 100 — service gets UUID, not str."""
        runtime = make_runtime(
            set_history=MagicMock(),
            get_history_limit=MagicMock(return_value=100),
        )
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=[])

        handler = make_handler(runtime=runtime, history_service=history_svc)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        args, _ = history_svc.load_history.call_args
        assert isinstance(args[0], UUID)
        assert str(args[0]) == VALID_UUID


# =========================================================================
# TestMemoryInjection
# =========================================================================


class TestMemoryInjection:
    """Global memory injection (lines 139-161)."""

    @patch(PATCH_SETTINGS, side_effect=ImportError)
    @patch(PATCH_MEMORY)
    async def test_injects_via_inject_system_context(self, mock_get_injector, _s):
        """Runtime has inject_system_context — called with key and context."""
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nSome memories"
        )
        mock_injector.get_chat_memory_context = AsyncMock(
            return_value="## 💬 Chat Memory Context\nChat memories here"
        )
        mock_get_injector.return_value = mock_injector

        runtime = make_runtime(inject_system_context=MagicMock())
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.inject_system_context.assert_called_once_with(
            VALID_UUID, "## Global Memory Context\nSome memories## \U0001f4ac Chat Memory Context\nChat memories here"
        )

    @patch(PATCH_SETTINGS, side_effect=ImportError)
    @patch(PATCH_MEMORY)
    async def test_injects_via_interpreter_fallback(self, mock_get_injector, _s):
        """No inject_system_context — falls back to interpreter.system_message."""
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nData"
        )
        mock_injector.get_chat_memory_context = AsyncMock(
            return_value="## 💬 Chat Memory Context\nChat Data"
        )
        mock_get_injector.return_value = mock_injector

        mock_interpreter = MagicMock()
        mock_interpreter.system_message = "Original prompt"

        # No inject_system_context, but has get_interpreter
        runtime = make_runtime(get_interpreter=AsyncMock(return_value=mock_interpreter))
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        assert "## Global Memory Context\nData" in mock_interpreter.system_message
        assert "## \U0001f4ac Chat Memory Context\nChat Data" in mock_interpreter.system_message
        assert mock_interpreter.system_message.startswith("Original prompt")

    @patch(PATCH_SETTINGS, side_effect=ImportError)
    @patch(PATCH_MEMORY)
    async def test_skips_empty_memory_context(self, mock_get_injector, _s):
        """Empty string from injector — guard at line 146 skips injection."""
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(return_value="")
        mock_get_injector.return_value = mock_injector

        runtime = make_runtime(inject_system_context=MagicMock())
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.inject_system_context.assert_not_called()

    @patch(PATCH_SETTINGS, side_effect=ImportError)
    @patch(PATCH_MEMORY)
    async def test_skips_whitespace_memory_context(self, mock_get_injector, _s):
        """Whitespace-only string — .strip() check at line 146 skips."""
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(return_value="   \n  ")
        mock_get_injector.return_value = mock_injector

        runtime = make_runtime(inject_system_context=MagicMock())
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.inject_system_context.assert_not_called()

    @patch(PATCH_SETTINGS, side_effect=ImportError)
    @patch(PATCH_MEMORY)
    async def test_skips_non_string_memory_context(self, mock_get_injector, _s):
        """Non-string return — isinstance check at line 146 skips."""
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(return_value=42)
        mock_get_injector.return_value = mock_injector

        runtime = make_runtime(inject_system_context=MagicMock())
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.inject_system_context.assert_not_called()

    @patch(PATCH_SETTINGS, side_effect=ImportError)
    @patch(PATCH_MEMORY, side_effect=ImportError("no module"))
    async def test_handles_import_error(self, _m, _s):
        """ImportError from memory_injector import — caught at line 160."""
        runtime = make_runtime(inject_system_context=MagicMock())
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message()
        )
        # Should not raise, ack still sent
        runtime.inject_system_context.assert_not_called()
        assert len(ws.sent_texts) == 1

    @patch(PATCH_SETTINGS, side_effect=ImportError)
    @patch(PATCH_MEMORY)
    async def test_deduplication_skips_when_already_injected(self, mock_get_injector, _s):
        """
        Interpreter path: if system_message already contains '## Global Memory Context',
        the guard at line 155 prevents re-injection.
        """
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nNew data"
        )
        mock_get_injector.return_value = mock_injector

        mock_interpreter = MagicMock()
        mock_interpreter.system_message = "Existing\n## Global Memory Context\nOld data"

        runtime = make_runtime(get_interpreter=AsyncMock(return_value=mock_interpreter))
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        # system_message unchanged — deduplication prevented re-injection
        assert mock_interpreter.system_message == "Existing\n## Global Memory Context\nOld data"

    @patch(PATCH_SETTINGS, side_effect=ImportError)
    @patch(PATCH_MEMORY)
    async def test_uses_client_id_when_chat_id_empty(self, mock_get_injector, _s):
        """
        `chat_id or client_id` fallback at line 148 — when chat_id is empty,
        client_id is used as history_key.
        """
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nData"
        )
        mock_get_injector.return_value = mock_injector

        runtime = make_runtime(inject_system_context=MagicMock())
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="client-99",
            message=make_message(chat_id=""),
        )
        # history_key = "" or "client-99" → "client-99"
        runtime.inject_system_context.assert_called_once_with(
            "client-99", "## Global Memory Context\nData"
        )


# =========================================================================
# TestApiDocsInjection
# =========================================================================


class TestApiDocsInjection:
    """API documentation injection (lines 163-201)."""

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS)
    async def test_injects_via_inject_system_context(self, mock_get_settings, _m):
        """Runtime has inject_system_context — API docs reference injected."""
        mock_settings = MagicMock()
        mock_settings.base_url = "http://localhost:8765"
        mock_get_settings.return_value = mock_settings

        runtime = make_runtime(inject_system_context=MagicMock())
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.inject_system_context.assert_called_once()
        injected_text = runtime.inject_system_context.call_args[0][1]
        assert "http://localhost:8765" in injected_text
        assert "Backend API Access" in injected_text
        assert "/v1/docs" in injected_text
        assert "/openapi.json" in injected_text

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS)
    async def test_injects_via_interpreter_fallback(self, mock_get_settings, _m):
        """No inject_system_context — falls back to interpreter.system_message."""
        mock_settings = MagicMock()
        mock_settings.base_url = "http://127.0.0.1:9000"
        mock_get_settings.return_value = mock_settings

        mock_interpreter = MagicMock()
        mock_interpreter.system_message = "Base system message"

        runtime = make_runtime(get_interpreter=AsyncMock(return_value=mock_interpreter))
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        assert "http://127.0.0.1:9000" in mock_interpreter.system_message
        assert mock_interpreter.system_message.startswith("Base system message")

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS)
    async def test_skips_when_no_base_url(self, mock_get_settings, _m):
        """settings.base_url is None — guard at line 168 prevents injection."""
        mock_settings = MagicMock()
        mock_settings.base_url = None
        mock_get_settings.return_value = mock_settings

        runtime = make_runtime(inject_system_context=MagicMock())
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.inject_system_context.assert_not_called()

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError("no config"))
    async def test_handles_settings_import_error(self, _s, _m):
        """ImportError from config.settings — caught at line 200."""
        runtime = make_runtime(inject_system_context=MagicMock())
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message()
        )
        runtime.inject_system_context.assert_not_called()
        assert len(ws.sent_texts) == 1

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS)
    async def test_deduplication_prevents_duplicate_injection(self, mock_get_settings, _m):
        """
        Deduplication: line 195 checks for '## 🔌 Backend API Access' in
        existing system_message. When present, re-injection is skipped.

        Regression test for emoji mismatch bug (previously checked
        '## Backend API Access' without emoji — substring never matched).
        """
        mock_settings = MagicMock()
        mock_settings.base_url = "http://localhost:8765"
        mock_get_settings.return_value = mock_settings

        mock_interpreter = MagicMock()
        # Simulate a system message that ALREADY contains the API docs
        mock_interpreter.system_message = (
            "Base prompt\n\n## 🔌 Backend API Access\n\nAlready injected"
        )

        runtime = make_runtime(get_interpreter=AsyncMock(return_value=mock_interpreter))
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        # Deduplication works: system_message unchanged, no duplicate injection
        count = mock_interpreter.system_message.count("Backend API Access")
        assert count == 1, (
            f"Expected deduplication to prevent re-injection, got {count} occurrences."
        )

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS)
    async def test_interpreter_fallback_no_system_message_attr(self, mock_get_settings, _m):
        """
        Interpreter exists but has no system_message attribute —
        the hasattr guard at line 193 skips injection silently.
        """
        mock_settings = MagicMock()
        mock_settings.base_url = "http://localhost:8765"
        mock_get_settings.return_value = mock_settings

        mock_interpreter = SimpleNamespace()  # no system_message attr

        runtime = make_runtime(get_interpreter=AsyncMock(return_value=mock_interpreter))
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws,
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        # No AttributeError, ack sent
        assert len(ws.sent_texts) == 1
        assert not hasattr(mock_interpreter, "system_message")

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS)
    async def test_interpreter_returns_none(self, mock_get_settings, _m):
        """
        _resolve_interpreter returns None — guard at line 193 skips.
        """
        mock_settings = MagicMock()
        mock_settings.base_url = "http://localhost:8765"
        mock_get_settings.return_value = mock_settings

        runtime = make_runtime(get_interpreter=AsyncMock(return_value=None))
        handler = make_handler(runtime=runtime)
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message(chat_id=VALID_UUID)
        )
        assert len(ws.sent_texts) == 1


# =========================================================================
# TestResolveInterpreter
# =========================================================================


class TestResolveInterpreter:
    """Nested _resolve_interpreter function (lines 130-136)."""

    @patch(PATCH_MEMORY)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_uses_runtime_get_interpreter(self, _s, mock_get_injector):
        """runtime.get_interpreter is callable — used directly."""
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nData"
        )
        mock_injector.get_chat_memory_context = AsyncMock(
            return_value=""
        )
        mock_get_injector.return_value = mock_injector

        mock_interpreter = MagicMock()
        mock_interpreter.system_message = ""

        runtime = make_runtime(
            get_interpreter=AsyncMock(return_value=mock_interpreter)
        )
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        runtime.get_interpreter.assert_awaited_once_with(VALID_UUID)

    @patch(PATCH_MEMORY)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    @patch(PATCH_ENGINE, new_callable=AsyncMock)
    async def test_falls_back_to_engine_get_interpreter(self, mock_engine_interp, _s, mock_get_injector):
        """
        Runtime has no get_interpreter — falls back to
        core.runtime.engine.get_interpreter (line 135-136).
        """
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nData"
        )
        mock_injector.get_chat_memory_context = AsyncMock(
            return_value=""
        )
        mock_get_injector.return_value = mock_injector

        mock_interpreter = MagicMock()
        mock_interpreter.system_message = ""
        mock_engine_interp.return_value = mock_interpreter

        # No get_interpreter on runtime — forces engine fallback
        runtime = make_runtime()
        handler = make_handler(runtime=runtime)
        await handler.handle_context_reset(
            ws=StubWebSocket(),
            client_id="c1",
            message=make_message(chat_id=VALID_UUID),
        )
        mock_engine_interp.assert_awaited_once_with(chat_id=VALID_UUID)


# =========================================================================
# TestAcknowledgment
# =========================================================================


class TestAcknowledgment:
    """WebSocket acknowledgment response (lines 203-213)."""

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_sends_ack_with_correct_fields(self, _s, _m):
        """Ack message has role=SERVER, type=CONTEXT_RESET_ACK, chat_id, message."""
        handler = make_handler()
        ws = StubWebSocket()
        await handler.handle_context_reset(
            ws=ws,
            client_id="c1",
            message=make_message(chat_id="chat-99"),
        )
        assert len(ws.sent_texts) == 1
        ack = ws.sent_texts[0]
        assert ack["role"] == MessageRole.SERVER
        assert ack["type"] == MessageType.CONTEXT_RESET_ACK
        assert ack["chat_id"] == "chat-99"
        assert ack["message"] == "Context reset complete"

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_handles_send_failure_runtime_error(self, _s, _m):
        """RuntimeError on ws.send_text — caught at line 212, no propagation."""
        handler = make_handler()
        ws = StubWebSocket(fail_on_send=True)
        # Should not raise
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message()
        )

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_handles_send_failure_os_error(self, _s, _m):
        """OSError on ws.send_text — caught at line 212."""
        ws = MagicMock()
        ws.send_text = AsyncMock(side_effect=OSError("broken pipe"))
        handler = make_handler()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message()
        )
        # No propagation

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_handles_send_failure_connection_error(self, _s, _m):
        """ConnectionError on ws.send_text — caught at line 212."""
        ws = MagicMock()
        ws.send_text = AsyncMock(side_effect=ConnectionError("reset"))
        handler = make_handler()
        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message()
        )
        # No propagation


# =========================================================================
# TestFullFlow
# =========================================================================


class TestFullFlow:
    """End-to-end integration scenarios."""

    @patch(PATCH_MEMORY)
    @patch(PATCH_SETTINGS)
    async def test_full_flow_all_services(self, mock_get_settings, mock_get_injector):
        """
        Complete flow: hub update, presence, runtime reset, history load,
        memory injection, API docs injection, ack — all succeed.
        """
        # Memory injector
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nMemories here"
        )
        mock_injector.get_chat_memory_context = AsyncMock(
            return_value="## 💬 Chat Memory Context\nChat memories here"
        )
        mock_get_injector.return_value = mock_injector

        # Settings
        mock_settings = MagicMock()
        mock_settings.base_url = "http://localhost:8765"
        mock_get_settings.return_value = mock_settings

        # Runtime with all capabilities
        runtime = make_runtime(
            set_history=MagicMock(),
            get_history_limit=MagicMock(return_value=50),
            inject_system_context=MagicMock(),
        )

        # History service
        history_svc = AsyncMock()
        history_svc.load_history = AsyncMock(return_value=["h1", "h2", "h3"])

        # Cache
        cache = AsyncMock()

        # Hub
        client = StubClient()
        hub = make_hub(clients={"c1": client})

        handler = ContextHandler(
            runtime=runtime, history_service=history_svc, cache_service=cache
        )
        ws = StubWebSocket()

        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message(chat_id=VALID_UUID), hub=hub
        )

        # 1. Client state updated
        assert client.active_chat_id == VALID_UUID
        # 2. Presence updated
        cache.update_presence_metadata.assert_awaited_once()
        # 3. Runtime reset
        runtime.reset_context.assert_awaited_once()
        # 4. History loaded
        history_svc.load_history.assert_awaited_once()
        runtime.set_history.assert_called_once_with(VALID_UUID, ["h1", "h2", "h3"])
        # 5. Memory injected
        assert runtime.inject_system_context.call_count == 2  # memory + api docs
        # 6. Ack sent
        assert len(ws.sent_texts) == 1
        assert ws.sent_texts[0]["type"] == MessageType.CONTEXT_RESET_ACK

    @patch(PATCH_MEMORY, side_effect=ImportError)
    @patch(PATCH_SETTINGS, side_effect=ImportError)
    async def test_minimal_flow_no_optional_services(self, _s, _m):
        """
        Minimal: no history_service, no hub — only presence, runtime reset, ack.
        """
        cache = AsyncMock()
        runtime = make_runtime()
        handler = ContextHandler(
            runtime=runtime, history_service=None, cache_service=cache
        )
        ws = StubWebSocket()

        await handler.handle_context_reset(
            ws=ws, client_id="c1", message=make_message(chat_id=""), hub=None
        )

        # Presence updated
        cache.update_presence_metadata.assert_awaited_once()
        # Runtime reset (even with empty chat_id)
        runtime.reset_context.assert_awaited_once_with(client_id="c1", chat_id="")
        # Ack sent
        assert len(ws.sent_texts) == 1
