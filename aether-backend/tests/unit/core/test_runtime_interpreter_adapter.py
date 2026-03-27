"""
Unit Tests: RuntimeInterpreterAdapter (core/runtime/interpreter_adapter.py)

Covers initialization, configuration, stop_generation, reset_state,
apply_history, append_custom_instructions, get_interpreter, cleanup, health.

Mock boundaries:
  - core.runtime.engine.get_interpreter_manager (lazy import in initialize())
  - config.settings.get_settings (lazy import in initialize())
  - core.integrations.providers.open_interpreter.external_ws_proxy.ExternalOIWebSocketInterpreter
  For non-init tests, mocks injected directly into _manager.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.runtime.interpreter_adapter import RuntimeInterpreterAdapter


# ─── Constructor ──────────────────────────────────────────────────────────────


class TestRuntimeInterpreterAdapterInit:
    def test_initial_state(self):
        adapter = RuntimeInterpreterAdapter()
        assert adapter._manager is None


# ─── initialize() ─────────────────────────────────────────────────────────────


class TestInitialize:
    async def test_success(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.initialize = AsyncMock(return_value=True)
        mock_manager.configure_external_server = MagicMock()

        mock_settings = MagicMock()
        mock_settings.interpreter = MagicMock()

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager), \
             patch("config.settings.get_settings", return_value=mock_settings):
            await adapter.initialize()

        assert adapter._manager is mock_manager
        mock_manager.configure_external_server.assert_called_once_with(mock_settings.interpreter)
        mock_manager.initialize.assert_called_once()

    async def test_idempotent(self):
        adapter = RuntimeInterpreterAdapter()
        existing = MagicMock()
        adapter._manager = existing

        await adapter.initialize()

        assert adapter._manager is existing

    async def test_raises_if_init_fails(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.initialize = AsyncMock(return_value=False)
        mock_manager.configure_external_server = MagicMock()

        mock_settings = MagicMock()
        mock_settings.interpreter = MagicMock()

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager), \
             patch("config.settings.get_settings", return_value=mock_settings):
            with pytest.raises(RuntimeError, match="Failed to initialize interpreter manager"):
                await adapter.initialize()

    async def test_raises_on_config_failure(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.configure_external_server.side_effect = ValueError("bad config")

        mock_settings = MagicMock()
        mock_settings.interpreter = MagicMock()

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager), \
             patch("config.settings.get_settings", return_value=mock_settings):
            with pytest.raises(RuntimeError, match="Failed to initialize interpreter backend mode"):
                await adapter.initialize()

    async def test_no_interpreter_attr_on_settings(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.initialize = AsyncMock(return_value=True)
        mock_manager.configure_external_server = MagicMock()

        mock_settings = MagicMock(spec=[])  # No attributes

        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_manager), \
             patch("config.settings.get_settings", return_value=mock_settings):
            await adapter.initialize()

        mock_manager.configure_external_server.assert_not_called()
        assert adapter._manager is mock_manager


# ─── configure() ──────────────────────────────────────────────────────────────


class TestConfigure:
    async def test_success(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.configure_external_server = MagicMock()
        mock_manager.create_interpreter = AsyncMock(return_value=MagicMock())
        mock_manager.apply_settings_async = AsyncMock()
        adapter._manager = mock_manager

        settings = MagicMock()
        settings.interpreter = MagicMock()

        await adapter.configure(settings)

        mock_manager.configure_external_server.assert_called_once_with(settings.interpreter)
        mock_manager.create_interpreter.assert_called_once()
        mock_manager.apply_settings_async.assert_called_once_with(settings, init=True)

    async def test_raises_if_not_initialized(self):
        adapter = RuntimeInterpreterAdapter()
        with pytest.raises(RuntimeError, match="Interpreter manager not initialized"):
            await adapter.configure(MagicMock())

    async def test_raises_on_config_error(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.configure_external_server.side_effect = ValueError("invalid")
        adapter._manager = mock_manager

        settings = MagicMock()
        settings.interpreter = MagicMock()

        with pytest.raises(RuntimeError, match="Interpreter external server configuration invalid"):
            await adapter.configure(settings)

    async def test_raises_if_template_creation_fails(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.configure_external_server = MagicMock()
        mock_manager.create_interpreter = AsyncMock(return_value=None)
        adapter._manager = mock_manager

        settings = MagicMock()
        settings.interpreter = MagicMock()

        with pytest.raises(RuntimeError, match="Failed to create interpreter template"):
            await adapter.configure(settings)

    async def test_no_interpreter_attr(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.configure_external_server = MagicMock()
        mock_manager.create_interpreter = AsyncMock(return_value=MagicMock())
        mock_manager.apply_settings_async = AsyncMock()
        adapter._manager = mock_manager

        settings = MagicMock(spec=[])  # No interpreter attr

        await adapter.configure(settings)

        mock_manager.configure_external_server.assert_not_called()


# ─── stop_generation() ───────────────────────────────────────────────────────


class TestStopGeneration:
    async def test_with_async_stop(self):
        adapter = RuntimeInterpreterAdapter()
        mock_interp = MagicMock()
        mock_interp.stop = AsyncMock()
        mock_manager = MagicMock()
        mock_manager.get_cached_interpreter = MagicMock(return_value=mock_interp)
        adapter._manager = mock_manager

        await adapter.stop_generation("req-1", chat_id="chat-1")

        mock_interp.stop.assert_called_once()

    async def test_no_interpreter(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.get_cached_interpreter = MagicMock(return_value=None)
        adapter._manager = mock_manager

        result = await adapter.stop_generation("req-1")
        assert result is None

    async def test_no_stop_method(self):
        adapter = RuntimeInterpreterAdapter()
        mock_interp = MagicMock(spec=[])  # No stop
        mock_manager = MagicMock()
        mock_manager.get_cached_interpreter = MagicMock(return_value=mock_interp)
        adapter._manager = mock_manager

        result = await adapter.stop_generation("req-1")
        assert result is None

    async def test_exception_suppressed(self):
        adapter = RuntimeInterpreterAdapter()
        mock_interp = MagicMock()
        mock_interp.stop = AsyncMock(side_effect=ConnectionError("ws closed"))
        mock_manager = MagicMock()
        mock_manager.get_cached_interpreter = MagicMock(return_value=mock_interp)
        adapter._manager = mock_manager

        with patch("core.runtime.interpreter_adapter.logger") as mock_logger:
            await adapter.stop_generation("req-1")
            mock_logger.debug.assert_called_once()
            args = mock_logger.debug.call_args[0]
            assert "WS stop failed" in args[0]
            assert args[1] == "req-1"


# ─── reset_state() ───────────────────────────────────────────────────────────


class TestResetState:
    async def test_with_chat_id_is_noop(self):
        adapter = RuntimeInterpreterAdapter()
        result = await adapter.reset_state("client-1", chat_id="chat-1")
        assert result is None

    async def test_without_chat_id_is_noop(self):
        adapter = RuntimeInterpreterAdapter()
        with patch("core.runtime.interpreter_adapter.logger") as mock_logger:
            result = await adapter.reset_state("client-1")
            assert result is None
            mock_logger.debug.assert_called_once()
            args = mock_logger.debug.call_args[0]
            assert "reset_state called without chat_id" in args[0]
            assert args[1] == "client-1"


# ─── apply_history() ─────────────────────────────────────────────────────────


class TestApplyHistory:
    async def test_empty_history(self):
        adapter = RuntimeInterpreterAdapter()
        adapter._manager = MagicMock()
        result = await adapter.apply_history([])
        assert result is None

    async def test_no_interpreter(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=None)
        adapter._manager = mock_manager

        result = await adapter.apply_history([{"role": "user", "content": "hi"}])
        assert result is None

    async def test_external_interpreter(self):
        adapter = RuntimeInterpreterAdapter()

        # Create a mock class that isinstance can work with
        FakeExternalClass = type("ExternalOIWebSocketInterpreter", (), {
            "set_messages": AsyncMock(),
        })
        mock_interp = FakeExternalClass()
        mock_interp.set_messages = AsyncMock()

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)
        adapter._manager = mock_manager

        history = [
            {"role": "user", "content": "hello", "metadata": {"source": "user"}},
            {"role": "assistant", "content": "hi there", "metadata": None},
            {"role": "system", "content": "ignored"},
            {"role": "assistant", "content": "proactive msg", "metadata": {"source": "proactive", "context": {"docs": ["test"]}}},
        ]

        with patch(
            "core.integrations.providers.open_interpreter.external_ws_proxy.ExternalOIWebSocketInterpreter",
            new=FakeExternalClass,
        ):
            await adapter.apply_history(history, chat_id="chat-1")

        mock_interp.set_messages.assert_called_once()
        msgs = mock_interp.set_messages.call_args[0][0]
        assert len(msgs) == 3  # system message filtered out
        assert msgs[0]["role"] == "user"
        assert msgs[1]["role"] == "assistant"
        assert msgs[2]["role"] == "assistant"
        assert msgs[0]["metadata"] == {"source": "user"}
        assert msgs[1]["metadata"] == {}
        
        # Verify proactive context was injected into the content
        assert "proactive msg" in msgs[2]["content"]
        assert "[System Note: The above proactive recommendation was generated based on this background context:" in msgs[2]["content"]
        assert "docs" in msgs[2]["content"]

    async def test_non_external_interpreter(self):
        adapter = RuntimeInterpreterAdapter()

        mock_interp = MagicMock()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)
        adapter._manager = mock_manager

        history = [{"role": "user", "content": "hi"}]

        # The real ExternalOIWebSocketInterpreter isinstance check will fail
        # because mock_interp is a MagicMock, not an ExternalOI instance
        with patch(
            "core.integrations.providers.open_interpreter.external_ws_proxy.ExternalOIWebSocketInterpreter",
            new=type("FakeExternal", (), {}),
        ), patch("core.runtime.interpreter_adapter.logger") as mock_logger:
            await adapter.apply_history(history)
            mock_logger.warning.assert_called_once()
            args = mock_logger.warning.call_args[0]
            assert "apply_history called on non-external interpreter" in args[0]

    async def test_filters_invalid_entries(self):
        adapter = RuntimeInterpreterAdapter()

        FakeExternalClass = type("ExternalOIWebSocketInterpreter", (), {
            "set_messages": AsyncMock(),
        })
        mock_interp = FakeExternalClass()
        mock_interp.set_messages = AsyncMock()

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)
        adapter._manager = mock_manager

        history = [
            "not a dict",
            {"role": "user"},  # no content
            {"role": "user", "content": ""},  # empty content
            {"role": "user", "content": "valid"},
        ]

        with patch(
            "core.integrations.providers.open_interpreter.external_ws_proxy.ExternalOIWebSocketInterpreter",
            new=FakeExternalClass,
        ):
            await adapter.apply_history(history)

        msgs = mock_interp.set_messages.call_args[0][0]
        assert len(msgs) == 1
        assert msgs[0]["content"] == "valid"

    async def test_normalizes_non_dict_metadata(self):
        adapter = RuntimeInterpreterAdapter()

        FakeExternalClass = type("ExternalOIWebSocketInterpreter", (), {
            "set_messages": AsyncMock(),
        })
        mock_interp = FakeExternalClass()
        mock_interp.set_messages = AsyncMock()

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)
        adapter._manager = mock_manager

        history = [
            {"role": "user", "content": "hello", "metadata": "raw"},
            {"role": "assistant", "content": "hi", "metadata": ["bad"]},
        ]

        with patch(
            "core.integrations.providers.open_interpreter.external_ws_proxy.ExternalOIWebSocketInterpreter",
            new=FakeExternalClass,
        ):
            await adapter.apply_history(history)

        msgs = mock_interp.set_messages.call_args[0][0]
        assert len(msgs) == 2
        assert msgs[0]["metadata"] == {}
        assert msgs[1]["metadata"] == {}

    async def test_exception_suppressed(self):
        adapter = RuntimeInterpreterAdapter()

        mock_interp = MagicMock()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)
        adapter._manager = mock_manager

        # side_effect=ImportError replaces ExternalOIWebSocketInterpreter with a
        # MagicMock; isinstance(interpreter, <MagicMock>) raises TypeError —
        # this exercises the except-Exception boundary.
        with patch(
            "core.integrations.providers.open_interpreter.external_ws_proxy.ExternalOIWebSocketInterpreter",
            side_effect=ImportError("module not found"),
        ), patch("core.runtime.interpreter_adapter.logger") as mock_logger:
            await adapter.apply_history([{"role": "user", "content": "hi"}])
            mock_logger.warning.assert_called_once()
            args = mock_logger.warning.call_args[0]
            assert "Failed to hydrate interpreter history" in args[0]
            assert isinstance(args[1], Exception)


# ─── append_custom_instructions() ────────────────────────────────────────────


class TestAppendCustomInstructions:
    async def test_empty_appendix(self):
        adapter = RuntimeInterpreterAdapter()
        adapter._manager = MagicMock()
        r1 = await adapter.append_custom_instructions("")
        r2 = await adapter.append_custom_instructions("   ")
        r3 = await adapter.append_custom_instructions(None)
        assert r1 is None
        assert r2 is None
        assert r3 is None

    async def test_no_interpreter(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=None)
        adapter._manager = mock_manager

        result = await adapter.append_custom_instructions("some text")
        assert result is None

    async def test_external_interpreter(self):
        adapter = RuntimeInterpreterAdapter()

        FakeExternalClass = type("ExternalOIWebSocketInterpreter", (), {
            "append_custom_instructions": AsyncMock(),
        })
        mock_interp = FakeExternalClass()
        mock_interp.append_custom_instructions = AsyncMock()

        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)
        adapter._manager = mock_manager

        with patch(
            "core.integrations.providers.open_interpreter.external_ws_proxy.ExternalOIWebSocketInterpreter",
            new=FakeExternalClass,
        ):
            await adapter.append_custom_instructions("extra context", chat_id="c1", marker="MK")

        mock_interp.append_custom_instructions.assert_called_once_with("extra context", marker="MK")

    async def test_non_external_interpreter(self):
        adapter = RuntimeInterpreterAdapter()

        mock_interp = MagicMock()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)
        adapter._manager = mock_manager

        with patch(
            "core.integrations.providers.open_interpreter.external_ws_proxy.ExternalOIWebSocketInterpreter",
            new=type("FakeExternal", (), {}),
        ), patch("core.runtime.interpreter_adapter.logger") as mock_logger:
            await adapter.append_custom_instructions("text", chat_id="c1")
            mock_logger.warning.assert_called_once()
            args = mock_logger.warning.call_args[0]
            assert "append_custom_instructions called on non-external interpreter" in args[0]

    async def test_exception_suppressed(self):
        adapter = RuntimeInterpreterAdapter()

        mock_interp = MagicMock()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)
        adapter._manager = mock_manager

        # side_effect=ImportError replaces ExternalOIWebSocketInterpreter with a
        # MagicMock; isinstance(interpreter, <MagicMock>) raises TypeError —
        # this exercises the except-Exception boundary.
        with patch(
            "core.integrations.providers.open_interpreter.external_ws_proxy.ExternalOIWebSocketInterpreter",
            side_effect=ImportError("no module"),
        ), patch("core.runtime.interpreter_adapter.logger") as mock_logger:
            await adapter.append_custom_instructions("text")
            mock_logger.debug.assert_called_once()
            args = mock_logger.debug.call_args[0]
            assert "Failed to append custom instructions" in args[0]
            assert isinstance(args[2], Exception)


# ─── get_interpreter() ───────────────────────────────────────────────────────


class TestGetInterpreter:
    async def test_no_manager(self):
        adapter = RuntimeInterpreterAdapter()
        result = await adapter.get_interpreter()
        assert result is None

    async def test_delegates_with_chat_id(self):
        adapter = RuntimeInterpreterAdapter()
        mock_interp = MagicMock()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=mock_interp)
        adapter._manager = mock_manager

        result = await adapter.get_interpreter(chat_id="chat-99")

        assert result is mock_interp
        mock_manager.get_interpreter.assert_called_once_with(chat_id="chat-99")

    async def test_delegates_without_chat_id(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.get_interpreter = AsyncMock(return_value=None)
        adapter._manager = mock_manager

        result = await adapter.get_interpreter()
        assert result is None
        mock_manager.get_interpreter.assert_called_once_with(chat_id=None)


# ─── is_available() ──────────────────────────────────────────────────────────


class TestIsAvailable:
    def test_no_manager(self):
        adapter = RuntimeInterpreterAdapter()
        assert adapter.is_available() is False

    def test_available_manager(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.is_available.return_value = True
        adapter._manager = mock_manager
        assert adapter.is_available() is True

    def test_unavailable_manager(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.is_available.return_value = False
        adapter._manager = mock_manager
        assert adapter.is_available() is False


# ─── cleanup() ────────────────────────────────────────────────────────────────


class TestCleanup:
    async def test_with_manager(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.cleanup = AsyncMock()
        adapter._manager = mock_manager

        await adapter.cleanup()

        mock_manager.cleanup.assert_called_once()

    async def test_without_manager(self):
        adapter = RuntimeInterpreterAdapter()
        result = await adapter.cleanup()
        assert result is None


# ─── get_health_status() ─────────────────────────────────────────────────────


class TestGetHealthStatus:
    def test_no_manager(self):
        adapter = RuntimeInterpreterAdapter()
        assert adapter.get_health_status() == {"available": False}

    def test_with_manager(self):
        adapter = RuntimeInterpreterAdapter()
        mock_manager = MagicMock()
        mock_manager.get_health_status.return_value = {
            "available": True,
            "pool_size": 3,
        }
        adapter._manager = mock_manager

        status = adapter.get_health_status()
        assert status == {"available": True, "pool_size": 3}
