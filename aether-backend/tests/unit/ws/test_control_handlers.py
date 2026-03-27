"""
Unit Tests: ws/presentation/control_handlers.py

Tests all 4 handler functions: handle_heartbeat, handle_audio_control,
handle_stop, handle_context_reset.

Written against source code line-by-line: every branch forced,
every error path exercised, every callback verified.
"""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ws.presentation.control_handlers import (
    handle_heartbeat,
    handle_audio_control,
    handle_stop,
    handle_context_reset,
)
from ws.protocols import (
    HeartbeatMessage,
    StopMessage,
    ContextResetMessage,
    AudioControlMessage,
    MessageType,
    MessageRole,
)


# =========================================================================
# Stubs
# =========================================================================


class StubWebSocket:
    """Captures send_text calls for assertion."""

    def __init__(self, *, fail_on_send=False):
        self.sent = []
        self._fail_on_send = fail_on_send

    async def send_text(self, text: str):
        if self._fail_on_send:
            raise RuntimeError("connection closed")
        self.sent.append(json.loads(text))


# =========================================================================
# handle_heartbeat
# =========================================================================


class TestHandleHeartbeat:
    @pytest.mark.asyncio
    async def test_sends_pong_with_timestamp(self):
        ws = StubWebSocket()
        msg = HeartbeatMessage(type="ping", timestamp=1700000000)
        await handle_heartbeat(ws, "client-1", msg)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == MessageType.PONG
        assert ws.sent[0]["timestamp"] == 1700000000

    @pytest.mark.asyncio
    async def test_sends_pong_without_timestamp(self):
        ws = StubWebSocket()
        msg = HeartbeatMessage(type="ping", timestamp=None)
        await handle_heartbeat(ws, "client-1", msg)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == MessageType.PONG
        assert ws.sent[0]["timestamp"] is None

    @pytest.mark.asyncio
    async def test_calls_presence_callback(self):
        ws = StubWebSocket()
        msg = HeartbeatMessage(type="ping", timestamp=123)
        callback = AsyncMock()
        await handle_heartbeat(ws, "client-1", msg, presence_callback=callback)
        callback.assert_awaited_once_with("client-1", last_event="heartbeat")
        assert len(ws.sent) == 1

    @pytest.mark.asyncio
    async def test_skips_callback_when_none(self):
        ws = StubWebSocket()
        msg = HeartbeatMessage(type="ping", timestamp=123)
        await handle_heartbeat(ws, "client-1", msg, presence_callback=None)
        assert len(ws.sent) == 1

    @pytest.mark.asyncio
    async def test_handles_send_error(self):
        ws = StubWebSocket(fail_on_send=True)
        msg = HeartbeatMessage(type="ping", timestamp=123)
        # Should not raise -- error caught internally
        await handle_heartbeat(ws, "client-1", msg)

    @pytest.mark.asyncio
    async def test_handles_heartbeat_type(self):
        ws = StubWebSocket()
        msg = HeartbeatMessage(type="heartbeat", timestamp=999)
        await handle_heartbeat(ws, "client-1", msg)
        assert ws.sent[0]["type"] == MessageType.PONG


# =========================================================================
# handle_audio_control
# =========================================================================


class TestHandleAudioControl:
    @pytest.mark.asyncio
    async def test_start_audio_stream(self):
        runtime = MagicMock()
        runtime.start_audio_stream = AsyncMock()
        msg = AudioControlMessage(start=True)
        await handle_audio_control("client-1", msg, runtime)
        runtime.start_audio_stream.assert_awaited_once_with(client_id="client-1")

    @pytest.mark.asyncio
    async def test_end_audio_stream(self):
        runtime = MagicMock()
        runtime.end_audio_stream = AsyncMock()
        msg = AudioControlMessage(end=True)
        await handle_audio_control("client-1", msg, runtime)
        runtime.end_audio_stream.assert_awaited_once_with(client_id="client-1")

    @pytest.mark.asyncio
    async def test_neither_start_nor_end(self):
        runtime = MagicMock()
        runtime.start_audio_stream = AsyncMock()
        runtime.end_audio_stream = AsyncMock()
        msg = AudioControlMessage()
        await handle_audio_control("client-1", msg, runtime)
        runtime.start_audio_stream.assert_not_awaited()
        runtime.end_audio_stream.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_calls_presence_callback_start(self):
        runtime = MagicMock()
        runtime.start_audio_stream = AsyncMock()
        callback = AsyncMock()
        msg = AudioControlMessage(start=True)
        await handle_audio_control("client-1", msg, runtime, presence_callback=callback)
        callback.assert_awaited_once_with("client-1", last_event="audio_start")

    @pytest.mark.asyncio
    async def test_calls_presence_callback_end(self):
        runtime = MagicMock()
        runtime.end_audio_stream = AsyncMock()
        callback = AsyncMock()
        msg = AudioControlMessage(end=True)
        await handle_audio_control("client-1", msg, runtime, presence_callback=callback)
        callback.assert_awaited_once_with("client-1", last_event="audio_end")

    @pytest.mark.asyncio
    async def test_calls_presence_callback_control(self):
        runtime = MagicMock()
        callback = AsyncMock()
        msg = AudioControlMessage()
        await handle_audio_control("client-1", msg, runtime, presence_callback=callback)
        callback.assert_awaited_once_with("client-1", last_event="audio_control")

    @pytest.mark.asyncio
    async def test_handles_runtime_error(self):
        runtime = MagicMock()
        runtime.start_audio_stream = AsyncMock(side_effect=RuntimeError("broken"))
        msg = AudioControlMessage(start=True)
        # Should not raise
        await handle_audio_control("client-1", msg, runtime)


# =========================================================================
# handle_stop
# =========================================================================


class TestHandleStop:
    def _make_args(self, *, stop_id="req-123", stream_tasks=None, ws=None):
        ws = ws or StubWebSocket()
        return dict(
            ws=ws,
            client_id="client-1",
            message=StopMessage(type="stop", id=stop_id),
            runtime=MagicMock(stop_generation=AsyncMock()),
            stream_tasks=stream_tasks or {},
            tasks_lock=asyncio.Lock(),
            resolve_backend_id_func=lambda cid, fid: fid,
            forget_mapping_func=MagicMock(),
            presence_callback=AsyncMock(),
        )

    @pytest.mark.asyncio
    async def test_returns_early_without_stop_id(self):
        args = self._make_args(stop_id=None)
        args["message"] = StopMessage(type="stop", id=None)
        await handle_stop(**args)
        args["runtime"].stop_generation.assert_not_awaited()
        assert args["ws"].sent == []

    @pytest.mark.asyncio
    async def test_cancels_task_in_stream_tasks(self):
        mock_task = MagicMock()
        mock_task.cancel = MagicMock()
        tasks = {
            "req-123": {
                "task": mock_task,
                "correlation_id": "corr-1",
                "frontend_id": "fe-1",
            }
        }
        args = self._make_args(stream_tasks=tasks)
        await handle_stop(**args)
        mock_task.cancel.assert_called_once()
        assert "req-123" not in tasks
        args["forget_mapping_func"].assert_called_once_with(
            client_id="client-1",
            frontend_id="fe-1",
            backend_id="req-123",
        )

    @pytest.mark.asyncio
    async def test_task_not_in_stream_tasks(self):
        args = self._make_args(stream_tasks={})
        await handle_stop(**args)
        # Should still call stop_generation
        args["runtime"].stop_generation.assert_awaited_once_with("req-123")

    @pytest.mark.asyncio
    async def test_sends_stop_acknowledgment(self):
        args = self._make_args()
        await handle_stop(**args)
        ws = args["ws"]
        assert len(ws.sent) == 1
        assert ws.sent[0]["role"] == MessageRole.SERVER
        assert ws.sent[0]["type"] == MessageType.STOPPED
        assert ws.sent[0]["request_id"] == "req-123"
        assert "Generation stopped" in ws.sent[0]["message"]

    @pytest.mark.asyncio
    async def test_ack_includes_frontend_and_correlation_id(self):
        mock_task = MagicMock()
        mock_task.cancel = MagicMock()
        tasks = {
            "req-123": {
                "task": mock_task,
                "correlation_id": "corr-abc",
                "frontend_id": "fe-xyz",
            }
        }
        args = self._make_args(stream_tasks=tasks)
        await handle_stop(**args)
        ws = args["ws"]
        assert ws.sent[0]["frontend_id"] == "fe-xyz"
        assert ws.sent[0]["correlation_id"] == "corr-abc"

    @pytest.mark.asyncio
    async def test_calls_presence_callback(self):
        args = self._make_args()
        await handle_stop(**args)
        args["presence_callback"].assert_awaited_once_with(
            "client-1", status="stopping", last_event="stop",
        )

    @pytest.mark.asyncio
    async def test_handles_stop_generation_error(self):
        args = self._make_args()
        args["runtime"].stop_generation = AsyncMock(
            side_effect=RuntimeError("generation already done"),
        )
        # Should not raise
        await handle_stop(**args)
        assert len(args["ws"].sent) == 1

    @pytest.mark.asyncio
    async def test_handles_send_ack_error(self):
        ws = StubWebSocket(fail_on_send=True)
        args = self._make_args(ws=ws)
        # Should not raise
        await handle_stop(**args)

    @pytest.mark.asyncio
    async def test_handles_task_cancel_error(self):
        mock_task = MagicMock()
        mock_task.cancel = MagicMock(side_effect=RuntimeError("cancel failed"))
        tasks = {"req-123": {"task": mock_task, "correlation_id": None, "frontend_id": None}}
        args = self._make_args(stream_tasks=tasks)
        # Should not raise -- error caught
        await handle_stop(**args)

    @pytest.mark.asyncio
    async def test_ack_omits_none_frontend_id(self):
        """Stop ack should NOT include frontend_id/correlation_id keys when None."""
        args = self._make_args()
        await handle_stop(**args)
        ws = args["ws"]
        # frontend_id and correlation_id not in tasks → None → not in ack
        assert "frontend_id" not in ws.sent[0]
        assert "correlation_id" not in ws.sent[0]


# =========================================================================
# handle_context_reset
# =========================================================================


class TestHandleContextReset:
    def _make_msg(self, chat_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"):
        return ContextResetMessage(
            role="user",
            type="context_reset",
            chat_id=chat_id,
            timestamp=1700000000,
        )

    def _make_runtime(self, *, has_reset_context=True, has_interpreter_manager=False):
        runtime = MagicMock()
        if has_reset_context:
            runtime.reset_context = AsyncMock()
        else:
            del runtime.reset_context
        if has_interpreter_manager:
            runtime._interpreter_manager = MagicMock()
            runtime._interpreter_manager.reset_interpreter = AsyncMock()
        else:
            # hasattr check should return False
            if hasattr(runtime, "_interpreter_manager"):
                del runtime._interpreter_manager
        runtime.get_interpreter = AsyncMock(return_value=None)
        return runtime

    @pytest.mark.asyncio
    async def test_basic_reset_sends_ack(self):
        ws = StubWebSocket()
        runtime = self._make_runtime()
        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == MessageType.CONTEXT_RESET_ACK
        assert ws.sent[0]["chat_id"] == msg.chat_id
        assert ws.sent[0]["timestamp"] == 1700000000
        assert ws.sent[0]["history_count"] == 0

    @pytest.mark.asyncio
    async def test_calls_reset_context(self):
        ws = StubWebSocket()
        runtime = self._make_runtime()
        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        runtime.reset_context.assert_awaited_once_with(
            "client-1", chat_id=msg.chat_id,
        )

    @pytest.mark.asyncio
    async def test_handles_no_reset_context_method(self):
        ws = StubWebSocket()
        runtime = self._make_runtime(has_reset_context=False)
        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        # Should still send ack
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == MessageType.CONTEXT_RESET_ACK

    @pytest.mark.asyncio
    async def test_cleans_up_interpreter_manager(self):
        ws = StubWebSocket()
        runtime = self._make_runtime(has_interpreter_manager=True)
        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        runtime._interpreter_manager.reset_interpreter.assert_awaited_once_with(
            chat_id=msg.chat_id,
        )

    @pytest.mark.asyncio
    async def test_interpreter_manager_cleanup_error(self):
        ws = StubWebSocket()
        runtime = self._make_runtime(has_interpreter_manager=True)
        runtime._interpreter_manager.reset_interpreter = AsyncMock(
            side_effect=RuntimeError("OI cleanup failed"),
        )
        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        # Should still send ack (error caught)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == MessageType.CONTEXT_RESET_ACK

    @pytest.mark.asyncio
    async def test_hydrates_history(self):
        ws = StubWebSocket()
        runtime = self._make_runtime()
        runtime.set_history = MagicMock()
        history = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi"},
        ]
        history_service = MagicMock()
        history_service.load_history = AsyncMock(return_value=history)
        msg = self._make_msg()
        await handle_context_reset(
            ws, "client-1", msg, runtime, history_service=history_service,
        )
        history_service.load_history.assert_awaited_once()
        runtime.set_history.assert_called_once()
        assert ws.sent[0]["history_count"] == 2

    @pytest.mark.asyncio
    async def test_history_with_limit(self):
        ws = StubWebSocket()
        runtime = self._make_runtime()
        runtime.get_history_limit = MagicMock(return_value=50)
        runtime.set_history = MagicMock()
        history_service = MagicMock()
        history_service.load_history = AsyncMock(return_value=[])
        msg = self._make_msg()
        await handle_context_reset(
            ws, "client-1", msg, runtime, history_service=history_service,
        )
        call_kwargs = history_service.load_history.call_args[1]
        assert call_kwargs["limit"] == 50

    @pytest.mark.asyncio
    async def test_history_limit_error_defaults_none(self):
        ws = StubWebSocket()
        runtime = self._make_runtime()
        runtime.get_history_limit = MagicMock(side_effect=AttributeError("no limit"))
        runtime.set_history = MagicMock()
        history_service = MagicMock()
        history_service.load_history = AsyncMock(return_value=[])
        msg = self._make_msg()
        await handle_context_reset(
            ws, "client-1", msg, runtime, history_service=history_service,
        )
        call_kwargs = history_service.load_history.call_args[1]
        assert call_kwargs["limit"] is None

    @pytest.mark.asyncio
    async def test_history_load_error(self):
        ws = StubWebSocket()
        runtime = self._make_runtime()
        history_service = MagicMock()
        history_service.load_history = AsyncMock(
            side_effect=RuntimeError("DB error"),
        )
        msg = self._make_msg()
        await handle_context_reset(
            ws, "client-1", msg, runtime, history_service=history_service,
        )
        # Should still send ack with history_count=0
        assert ws.sent[0]["history_count"] == 0

    @pytest.mark.asyncio
    async def test_invalid_chat_id_skips_history(self):
        ws = StubWebSocket()
        runtime = self._make_runtime()
        history_service = MagicMock()
        history_service.load_history = AsyncMock()
        msg = self._make_msg(chat_id="not-a-uuid")
        await handle_context_reset(
            ws, "client-1", msg, runtime, history_service=history_service,
        )
        history_service.load_history.assert_not_awaited()
        assert ws.sent[0]["history_count"] == 0

    @pytest.mark.asyncio
    async def test_no_history_service_skips_hydration(self):
        ws = StubWebSocket()
        runtime = self._make_runtime()
        msg = self._make_msg()
        await handle_context_reset(
            ws, "client-1", msg, runtime, history_service=None,
        )
        assert ws.sent[0]["history_count"] == 0

    @pytest.mark.asyncio
    async def test_calls_presence_callback(self):
        ws = StubWebSocket()
        runtime = self._make_runtime()
        callback = AsyncMock()
        msg = self._make_msg()
        await handle_context_reset(
            ws, "client-1", msg, runtime, presence_callback=callback,
        )
        callback.assert_awaited_once_with("client-1", last_event="context_reset")

    @pytest.mark.asyncio
    async def test_memory_injection_import_error(self, monkeypatch):
        """ImportError for memory_injector caught gracefully."""
        ws = StubWebSocket()
        runtime = self._make_runtime()
        msg = self._make_msg()

        # The import of core.runtime.memory_injector will fail naturally
        # in test env (no such module). Verify it doesn't crash.
        await handle_context_reset(ws, "client-1", msg, runtime)
        assert len(ws.sent) == 1

    @pytest.mark.asyncio
    async def test_memory_injection_with_context(self, monkeypatch):
        """Global memory context injected into system message (fallback path)."""
        ws = StubWebSocket()
        # Use a real object (not MagicMock) to control hasattr precisely.
        # MagicMock auto-creates attributes, making hasattr always True.
        interpreter = SimpleNamespace(system_message="Base system message.")

        class FakeRuntime:
            reset_context = AsyncMock()
            get_interpreter = AsyncMock(return_value=interpreter)
            # Deliberately NO inject_system_context → forces fallback path

        runtime = FakeRuntime()

        # Mock memory injector
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nSome memory.",
        )
        mock_injector.get_chat_memory_context = AsyncMock(
            return_value="## 💬 Chat Memory Context\nChat memory.",
        )

        mock_get_injector = MagicMock(return_value=mock_injector)

        # Pre-register the module
        import sys
        from types import ModuleType

        mod = ModuleType("core.runtime.memory_injector")
        mod.get_memory_injector = mock_get_injector
        monkeypatch.setitem(sys.modules, "core.runtime.memory_injector", mod)
        for parent in ["core", "core.runtime"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        assert "Global Memory Context" in interpreter.system_message
        assert "Chat Memory Context" in interpreter.system_message

    @pytest.mark.asyncio
    async def test_memory_injection_skip_empty_context(self, monkeypatch):
        """Empty memory context should NOT be injected."""
        ws = StubWebSocket()
        runtime = self._make_runtime()

        interpreter = SimpleNamespace(system_message="Original.")
        runtime.get_interpreter = AsyncMock(return_value=interpreter)

        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(return_value="")

        mock_get_injector = MagicMock(return_value=mock_injector)

        import sys
        from types import ModuleType

        mod = ModuleType("core.runtime.memory_injector")
        mod.get_memory_injector = mock_get_injector
        monkeypatch.setitem(sys.modules, "core.runtime.memory_injector", mod)
        for parent in ["core", "core.runtime"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        assert interpreter.system_message == "Original."

    @pytest.mark.asyncio
    async def test_memory_injection_dedup(self, monkeypatch):
        """Memory injection should not duplicate if already present."""
        ws = StubWebSocket()
        runtime = self._make_runtime()

        interpreter = SimpleNamespace(
            system_message="Base. ## Global Memory Context\nAlready here.",
        )
        runtime.get_interpreter = AsyncMock(return_value=interpreter)

        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nNew memory.",
        )

        import sys
        from types import ModuleType

        mod = ModuleType("core.runtime.memory_injector")
        mod.get_memory_injector = MagicMock(return_value=mock_injector)
        monkeypatch.setitem(sys.modules, "core.runtime.memory_injector", mod)
        for parent in ["core", "core.runtime"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        # Should NOT append again
        assert interpreter.system_message.count("Global Memory Context") == 1

    @pytest.mark.asyncio
    async def test_api_docs_injection(self, monkeypatch):
        """API docs reference injected when backend_url configured."""
        ws = StubWebSocket()
        runtime = self._make_runtime()

        interpreter = SimpleNamespace(system_message="Base system message.")
        runtime.get_interpreter = AsyncMock(return_value=interpreter)

        # Mock settings
        mock_settings = SimpleNamespace(backend_url="http://localhost:8765")
        monkeypatch.setattr(
            "ws.presentation.control_handlers.json",
            json,  # Keep real json
        )

        import sys
        from types import ModuleType

        # Mock config.settings
        config_mod = ModuleType("config.settings")
        config_mod.get_settings = lambda: mock_settings
        monkeypatch.setitem(sys.modules, "config.settings", config_mod)
        for parent in ["config"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        assert "Backend API Access" in interpreter.system_message
        assert "http://localhost:8765" in interpreter.system_message

    @pytest.mark.asyncio
    async def test_api_docs_dedup(self, monkeypatch):
        """API docs reference not duplicated if already present."""
        ws = StubWebSocket()
        runtime = self._make_runtime()

        interpreter = SimpleNamespace(
            system_message="Base. ## 🔌 Backend API Access\nAlready here.",
        )
        runtime.get_interpreter = AsyncMock(return_value=interpreter)

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        assert interpreter.system_message.count("Backend API Access") == 1

    @pytest.mark.asyncio
    async def test_api_docs_no_backend_url(self, monkeypatch):
        """No backend_url → no API docs injection."""
        ws = StubWebSocket()
        runtime = self._make_runtime()

        interpreter = SimpleNamespace(system_message="Base.")
        runtime.get_interpreter = AsyncMock(return_value=interpreter)

        mock_settings = SimpleNamespace(backend_url=None)

        import sys
        from types import ModuleType

        config_mod = ModuleType("config.settings")
        config_mod.get_settings = lambda: mock_settings
        monkeypatch.setitem(sys.modules, "config.settings", config_mod)
        for parent in ["config"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        assert "Backend API Access" not in interpreter.system_message

    @pytest.mark.asyncio
    async def test_top_level_error_sends_error_response(self):
        """Unexpected error in handler body sends error to client."""
        ws = StubWebSocket()
        runtime = MagicMock()
        # Make reset_context raise unexpected error (not caught by inner try)
        runtime.reset_context = AsyncMock(
            side_effect=TypeError("completely unexpected"),
        )
        # hasattr for _interpreter_manager
        del runtime._interpreter_manager

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        # Should send error message
        assert len(ws.sent) >= 1
        error_msg = ws.sent[-1]
        assert error_msg["type"] == MessageType.ERROR
        assert "Context reset failed" in error_msg["message"]

    @pytest.mark.asyncio
    async def test_error_response_send_failure(self):
        """If sending error response also fails, should not crash."""
        ws = StubWebSocket(fail_on_send=True)
        runtime = MagicMock()
        runtime.reset_context = AsyncMock(
            side_effect=TypeError("unexpected"),
        )
        del runtime._interpreter_manager

        msg = self._make_msg()
        # Should not raise
        await handle_context_reset(ws, "client-1", msg, runtime)

    @pytest.mark.asyncio
    async def test_runtime_inject_system_context_path(self, monkeypatch):
        """If runtime has inject_system_context, uses that instead of fallback."""
        ws = StubWebSocket()
        runtime = self._make_runtime()
        runtime.inject_system_context = MagicMock()
    
        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nMemory data.",
        )
        mock_injector.get_chat_memory_context = AsyncMock(
            return_value="## 💬 Chat Memory Context\nChat memory data.",
        )
    
        import sys
        from types import ModuleType
    
        mod = ModuleType("core.runtime.memory_injector")
        mod.get_memory_injector = MagicMock(return_value=mock_injector)
        monkeypatch.setitem(sys.modules, "core.runtime.memory_injector", mod)
        for parent in ["core", "core.runtime"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)
    
        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        runtime.inject_system_context.assert_called_once_with(
            "client-1", "## Global Memory Context\nMemory data.## \U0001f4ac Chat Memory Context\nChat memory data.",
        )

    @pytest.mark.asyncio
    async def test_interpreter_none_skips_injections(self):
        """If runtime.get_interpreter returns None, injections are skipped."""
        ws = StubWebSocket()
        runtime = self._make_runtime()
        runtime.get_interpreter = AsyncMock(return_value=None)
        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        # Should still send ack
        assert ws.sent[0]["type"] == MessageType.CONTEXT_RESET_ACK

    @pytest.mark.asyncio
    async def test_memory_dedup_fallback_no_inject_system_context(self, monkeypatch):
        """
        Line 299: Runtime WITHOUT inject_system_context takes fallback path.
        When system_message already contains '## Global Memory Context',
        the else branch logs dedup and skips re-injection.
        """
        ws = StubWebSocket()
        interpreter = SimpleNamespace(
            system_message="Base. ## Global Memory Context\nAlready here.",
        )

        class FakeRuntime:
            reset_context = AsyncMock()
            get_interpreter = AsyncMock(return_value=interpreter)
            # Deliberately NO inject_system_context → forces fallback path (line 289)

        runtime = FakeRuntime()

        mock_injector = MagicMock()
        mock_injector.get_global_memory_context = AsyncMock(
            return_value="## Global Memory Context\nNew memory.",
        )

        import sys
        from types import ModuleType

        mod = ModuleType("core.runtime.memory_injector")
        mod.get_memory_injector = MagicMock(return_value=mock_injector)
        monkeypatch.setitem(sys.modules, "core.runtime.memory_injector", mod)
        for parent in ["core", "core.runtime"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        # Dedup: system_message must NOT be modified
        assert interpreter.system_message == "Base. ## Global Memory Context\nAlready here."
        assert ws.sent[0]["type"] == MessageType.CONTEXT_RESET_ACK

    @pytest.mark.asyncio
    async def test_memory_injection_get_injector_raises_error(self, monkeypatch):
        """
        Lines 300-301: RuntimeError from get_memory_injector() caught
        by except (ImportError, ..., RuntimeError) handler.
        Context reset continues and sends ack.
        """
        ws = StubWebSocket()
        runtime = self._make_runtime()

        def bad_get_injector():
            raise RuntimeError("injector initialization failed")

        import sys
        from types import ModuleType

        mod = ModuleType("core.runtime.memory_injector")
        mod.get_memory_injector = bad_get_injector
        monkeypatch.setitem(sys.modules, "core.runtime.memory_injector", mod)
        for parent in ["core", "core.runtime"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        assert ws.sent[0]["type"] == MessageType.CONTEXT_RESET_ACK

    @pytest.mark.asyncio
    async def test_api_docs_injection_error_caught(self, monkeypatch):
        """
        Lines 343-344: RuntimeError from get_settings() caught by
        API docs injection except handler. Context reset still sends ack.
        """
        ws = StubWebSocket()
        interpreter = SimpleNamespace(system_message="Base.")

        class FakeRuntime:
            reset_context = AsyncMock()
            get_interpreter = AsyncMock(return_value=interpreter)
            # NO inject_system_context — memory block takes fallback,
            # but memory content empty → skips memory injection body

        runtime = FakeRuntime()

        import sys
        from types import ModuleType

        # Make config.settings.get_settings raise RuntimeError
        def bad_settings():
            raise RuntimeError("settings broken")

        config_mod = ModuleType("config.settings")
        config_mod.get_settings = bad_settings
        monkeypatch.setitem(sys.modules, "config.settings", config_mod)
        for parent in ["config"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        msg = self._make_msg()
        await handle_context_reset(ws, "client-1", msg, runtime)
        assert ws.sent[0]["type"] == MessageType.CONTEXT_RESET_ACK
