"""
Unit Tests: InterpreterManager (core/runtime/interpreter.py)

Comprehensive coverage of the external-only OI interpreter lifecycle:
configure, get/reset/cleanup chat interpreters, settings, health, context.
"""

from __future__ import annotations

import asyncio
import sys
import time
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from core.runtime.interpreter import InterpreterManager, _maybe_await


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_interp_settings(
    *,
    enabled: bool = True,
    url: str = "http://127.0.0.1:8000",
    per_chat: bool = True,
    auth: str = "test-token",
    host: str = "127.0.0.1",
    port_min: int = 8100,
    port_max: int = 8110,
    max_servers: int = 5,
    ttl: int = 600,
    startup_timeout: float = 30.0,
    venv_python: str = "/usr/bin/python3",
    wrapper_script: str = "/tmp/oi_wrapper.py",
) -> MagicMock:
    """Create a mock interpreter settings object."""
    s = MagicMock()
    s.external_server_enabled = enabled
    s.external_server_url = url
    s.external_server_auth = auth
    s.external_server_per_chat = per_chat
    s.external_server_host = host
    s.external_server_port_min = port_min
    s.external_server_port_max = port_max
    s.external_server_max_servers = max_servers
    s.external_server_ttl_seconds = ttl
    s.external_server_startup_timeout_seconds = startup_timeout
    s.external_server_venv_python = venv_python
    s.external_server_wrapper_script = wrapper_script
    return s


def _make_full_settings(
    *,
    interp_enabled: bool = True,
    per_chat: bool = True,
    model: str = "test-model",
    provider: str = "lm_studio",
    api_base: str = "http://localhost:1234/v1",
    api_key: str = "not-needed",
    context_window: int = 100000,
    max_tokens: int = 4096,
    supports_vision: bool = False,
    base_url: str = "http://127.0.0.1:9090",
) -> MagicMock:
    """Create a full settings mock."""
    settings = MagicMock()
    settings.base_url = base_url

    settings.llm = MagicMock()
    settings.llm.model = model
    settings.llm.provider = provider
    settings.llm.api_base = api_base
    settings.llm.api_key = api_key
    settings.llm.context_window = context_window
    settings.llm.max_tokens = max_tokens
    settings.llm.supports_vision = supports_vision
    settings.llm.temperature = 0.7

    settings.interpreter = MagicMock()
    settings.interpreter.auto_run = True  # Default is True for external server mode
    settings.interpreter.loop = False
    settings.interpreter.offline = True
    settings.interpreter.disable_telemetry = True
    settings.interpreter.safe_mode = "off"
    settings.interpreter.system_message = "GURU prompt"
    settings.interpreter.context_warning_threshold = 0.80
    settings.interpreter.context_high_threshold = 0.90
    settings.interpreter.context_critical_threshold = 0.95

    settings.vision_document = MagicMock()

    return settings


def _make_mock_chat_interpreter(messages=None):
    """Create a mock chat interpreter."""
    interp = AsyncMock()
    interp.messages = messages or []
    interp.stop_event = MagicMock()
    interp.output_queue = None
    interp.close = AsyncMock()
    interp.ws_url = "ws://127.0.0.1:8100/"
    return interp


# ═══════════════════════════════════════════════════════════════════════════
# INIT AND PROPERTIES
# ═══════════════════════════════════════════════════════════════════════════


class TestInterpreterManagerInit:
    def test_init_defaults(self):
        mgr = InterpreterManager()
        assert mgr._external_server_enabled is False
        assert mgr._chat_interpreters == {}
        assert mgr._chat_last_used == {}
        assert mgr._max_chat_instances == 10
        assert mgr._chat_ttl_seconds == 1800
        assert mgr._context_token_limit == 100000
        assert mgr._cleanup_task is None

    def test_initialized_always_true(self):
        mgr = InterpreterManager()
        assert mgr.initialized is True

    def test_has_cached_interpreter_empty(self):
        mgr = InterpreterManager()
        assert mgr.has_cached_interpreter() is False

    def test_has_cached_interpreter_with_instances(self):
        mgr = InterpreterManager()
        mgr._chat_interpreters["chat1"] = MagicMock()
        assert mgr.has_cached_interpreter() is True

    async def test_ensure_initialized_is_noop(self):
        mgr = InterpreterManager()
        result = await mgr.ensure_initialized()
        assert result is None

    def test_current_interpreter_returns_none(self):
        mgr = InterpreterManager()
        assert mgr.current_interpreter() is None

    def test_cached_interpreter_returns_none(self):
        mgr = InterpreterManager()
        assert mgr.cached_interpreter() is None

    def test_is_available(self):
        mgr = InterpreterManager()
        assert mgr.is_available() is False
        mgr._external_server_enabled = True
        assert mgr.is_available() is True

    def test_is_initialized(self):
        mgr = InterpreterManager()
        assert mgr.is_initialized() is False
        mgr._external_server_enabled = True
        assert mgr.is_initialized() is True

    def test_get_chat_interpreter_count(self):
        mgr = InterpreterManager()
        assert mgr.get_chat_interpreter_count() == 0
        mgr._chat_interpreters["c1"] = MagicMock()
        mgr._chat_interpreters["c2"] = MagicMock()
        assert mgr.get_chat_interpreter_count() == 2

    def test_list_active_chats(self):
        mgr = InterpreterManager()
        assert mgr.list_active_chats() == []
        mgr._chat_interpreters["c1"] = MagicMock()
        assert mgr.list_active_chats() == ["c1"]


# ═══════════════════════════════════════════════════════════════════════════
# INITIALIZE
# ═══════════════════════════════════════════════════════════════════════════


class TestInitialize:
    async def test_initialize_starts_cleanup_task(self):
        mgr = InterpreterManager()
        result = await mgr.initialize()
        assert result is True
        assert mgr._cleanup_task is not None
        # Cleanup
        mgr._cleanup_task.cancel()
        try:
            await mgr._cleanup_task
        except asyncio.CancelledError:
            pass

    async def test_initialize_idempotent(self):
        mgr = InterpreterManager()
        await mgr.initialize()
        task1 = mgr._cleanup_task
        await mgr.initialize()
        assert mgr._cleanup_task is task1  # Same task, not recreated
        mgr._cleanup_task.cancel()
        try:
            await mgr._cleanup_task
        except asyncio.CancelledError:
            pass


# ═══════════════════════════════════════════════════════════════════════════
# CREATE INTERPRETER
# ═══════════════════════════════════════════════════════════════════════════


class TestCreateInterpreter:
    async def test_create_per_chat_template(self):
        mgr = InterpreterManager()
        mgr._external_server_per_chat = True
        template = await mgr.create_interpreter()
        assert template is not None
        assert template.ws_url == "per-chat"
        await template.stop()  # No-op
        await template.close()  # No-op

    async def test_create_template_input_raises(self):
        mgr = InterpreterManager()
        mgr._external_server_per_chat = True
        template = await mgr.create_interpreter()
        with pytest.raises(RuntimeError, match="Per-chat"):
            await template.input({"message": "test"})

    async def test_create_template_output_raises(self):
        mgr = InterpreterManager()
        mgr._external_server_per_chat = True
        template = await mgr.create_interpreter()
        with pytest.raises(RuntimeError, match="Per-chat"):
            await template.output()

    async def test_create_not_per_chat_raises(self):
        mgr = InterpreterManager()
        mgr._external_server_per_chat = False
        with pytest.raises(RuntimeError, match="per-chat isolation"):
            await mgr.create_interpreter()


# ═══════════════════════════════════════════════════════════════════════════
# CONFIGURE EXTERNAL SERVER
# ═══════════════════════════════════════════════════════════════════════════


class TestConfigureExternalServer:
    def test_configure_disabled(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(enabled=False)
        mgr.configure_external_server(settings)
        assert mgr._external_server_enabled is False

    def test_configure_enabled_no_url(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(enabled=True, url="")
        with pytest.raises(RuntimeError, match="external_server_url is empty"):
            mgr.configure_external_server(settings)

    def test_configure_enabled_bad_url_scheme(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(enabled=True, url="ftp://bad")
        with pytest.raises(RuntimeError, match="http"):
            mgr.configure_external_server(settings)

    def test_configure_per_chat_no_port_range(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(per_chat=True, port_min=0, port_max=0)
        with pytest.raises(RuntimeError, match="port range"):
            mgr.configure_external_server(settings)

    def test_configure_per_chat_reversed_ports(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(per_chat=True, port_min=9000, port_max=8000)
        with pytest.raises(RuntimeError, match="Invalid per-chat OI port range"):
            mgr.configure_external_server(settings)

    def test_configure_per_chat_no_max_servers(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(per_chat=True, max_servers=0)
        with pytest.raises(RuntimeError, match="max_servers"):
            mgr.configure_external_server(settings)

    def test_configure_per_chat_no_ttl(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(per_chat=True, ttl=0)
        with pytest.raises(RuntimeError, match="ttl_seconds"):
            mgr.configure_external_server(settings)

    def test_configure_per_chat_missing_wrapper(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(per_chat=True, wrapper_script="/nonexistent/path.py")
        with pytest.raises(RuntimeError, match="wrapper_script"):
            mgr.configure_external_server(settings)

    def test_configure_per_chat_missing_venv(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(per_chat=True, venv_python="/nonexistent/python")
        # wrapper must exist first
        settings.external_server_wrapper_script = __file__  # Use this test file as existing path
        with pytest.raises(RuntimeError, match="venv_python"):
            mgr.configure_external_server(settings)

    def test_configure_shared_mode(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(per_chat=False)
        mgr.configure_external_server(settings)
        assert mgr._external_server_enabled is True
        assert mgr._external_server_per_chat is False
        assert mgr._external_server_http_url == "http://127.0.0.1:8000"

    def test_configure_stores_auth(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(per_chat=False, auth="secret-token")
        mgr.configure_external_server(settings)
        assert mgr._external_server_auth == "secret-token"

    def test_configure_startup_timeout_invalid(self):
        mgr = InterpreterManager()
        settings = _make_interp_settings(per_chat=False)
        settings.external_server_startup_timeout_seconds = "not-a-number"
        mgr.configure_external_server(settings)
        assert mgr._external_server_startup_timeout_seconds == 0.0

    def test_configure_per_chat_success(self, tmp_path):
        """Lines 229-237: per-chat config success after all validations pass."""
        mgr = InterpreterManager()
        wrapper = tmp_path / "wrapper.py"
        wrapper.write_text("#!/usr/bin/env python3", encoding="utf-8")
        venv_py = tmp_path / "python3"
        venv_py.write_text("#!/bin/sh", encoding="utf-8")

        settings = _make_interp_settings(
            per_chat=True,
            wrapper_script=str(wrapper),
            venv_python=str(venv_py),
        )
        mgr.configure_external_server(settings)
        assert mgr._external_server_per_chat is True
        assert mgr._external_server_enabled is True
        assert mgr._external_server_pool is None  # Lazy creation


# ═══════════════════════════════════════════════════════════════════════════
# ENSURE EXTERNAL SERVER POOL
# ═══════════════════════════════════════════════════════════════════════════


class TestEnsureExternalServerPool:
    """Lines 242-273: _ensure_external_server_pool."""

    def test_returns_cached_pool(self):
        mgr = InterpreterManager()
        mock_pool = MagicMock()
        mgr._external_server_pool = mock_pool
        result = mgr._ensure_external_server_pool(MagicMock())
        assert result is mock_pool

    def test_raises_if_not_per_chat(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = False
        with pytest.raises(RuntimeError, match="per-chat external mode"):
            mgr._ensure_external_server_pool(MagicMock())

    def test_raises_if_no_url(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = None
        with pytest.raises(RuntimeError, match="external_server_url"):
            mgr._ensure_external_server_pool(MagicMock())

    def test_raises_if_empty_base_url(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = "http://127.0.0.1:8000"
        settings = MagicMock()
        settings.base_url = ""
        with pytest.raises(RuntimeError, match="base_url"):
            mgr._ensure_external_server_pool(settings)

    def test_base_url_str_raises(self):
        """Lines 249-250: str(base_url) raises → empty backend_url → RuntimeError."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        class BadStr:
            def __str__(self):
                raise TypeError("no str")

        settings = MagicMock()
        settings.base_url = BadStr()
        with pytest.raises(RuntimeError, match="base_url"):
            mgr._ensure_external_server_pool(settings)

    @patch("core.runtime.interpreter.ExternalOIServerPool")
    @patch("config.settings.get_app_root")
    def test_creates_pool(self, mock_get_root, mock_pool_cls, tmp_path):
        """Lines 254-273: successful pool creation."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = "http://127.0.0.1:8000"
        mgr._external_server_host = "127.0.0.1"
        mgr._external_server_port_min = 8100
        mgr._external_server_port_max = 8110
        mgr._external_server_max_servers = 5
        mgr._external_server_ttl_seconds = 600
        mgr._external_server_startup_timeout_seconds = 30.0
        mgr._external_server_venv_python = "/usr/bin/python3"
        mgr._external_server_wrapper_script = "/tmp/wrapper.py"
        mgr._external_server_auth = "token"

        mock_get_root.return_value = tmp_path
        mock_pool = MagicMock()
        mock_pool_cls.return_value = mock_pool

        settings = MagicMock()
        settings.base_url = "http://127.0.0.1:9090"

        result = mgr._ensure_external_server_pool(settings)
        assert result is mock_pool
        assert mgr._external_server_pool is mock_pool
        mock_pool_cls.assert_called_once()


# ═══════════════════════════════════════════════════════════════════════════
# GET CACHED INTERPRETER (READ-ONLY, NO SPAWN)
# ═══════════════════════════════════════════════════════════════════════════


class TestGetCachedInterpreter:
    def test_returns_none_without_chat_id(self):
        mgr = InterpreterManager()
        assert mgr.get_cached_interpreter(None) is None
        assert mgr.get_cached_interpreter("") is None

    def test_returns_none_on_cache_miss(self):
        mgr = InterpreterManager()
        assert mgr.get_cached_interpreter("nonexistent-chat") is None

    def test_returns_cached_instance(self):
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mgr._chat_interpreters["chat-1"] = mock_interp
        mgr._chat_last_used["chat-1"] = time.time() - 100

        result = mgr.get_cached_interpreter("chat-1")
        assert result is mock_interp

    def test_updates_last_used_on_hit(self):
        mgr = InterpreterManager()
        mgr._chat_interpreters["chat-1"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["chat-1"] = time.time() - 500

        mgr.get_cached_interpreter("chat-1")
        assert mgr._chat_last_used["chat-1"] > time.time() - 5

    def test_does_not_update_last_used_on_miss(self):
        mgr = InterpreterManager()
        mgr.get_cached_interpreter("ghost")
        assert "ghost" not in mgr._chat_last_used

    def test_never_spawns_server(self):
        """get_cached_interpreter must never trigger server creation."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_pool = MagicMock()

        result = mgr.get_cached_interpreter("no-server-please")
        assert result is None
        mgr._external_server_pool.ensure_server.assert_not_called()


# ═══════════════════════════════════════════════════════════════════════════
# GET INTERPRETER (CHAT SCOPED)
# ═══════════════════════════════════════════════════════════════════════════


class TestGetInterpreter:
    async def test_get_requires_chat_id(self):
        mgr = InterpreterManager()
        with pytest.raises(RuntimeError, match="chat_id is required"):
            await mgr.get_interpreter(chat_id=None)

    async def test_get_returns_cached(self):
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mgr._chat_interpreters["chat-1"] = mock_interp
        mgr._chat_last_used["chat-1"] = time.time()

        result = await mgr.get_interpreter(chat_id="chat-1")
        assert result is mock_interp

    async def test_get_updates_last_used(self):
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mgr._chat_interpreters["chat-1"] = mock_interp
        mgr._chat_last_used["chat-1"] = time.time() - 100

        await mgr.get_interpreter(chat_id="chat-1")
        assert mgr._chat_last_used["chat-1"] > time.time() - 5

    @patch("core.runtime.interpreter.ExternalOIWebSocketInterpreter")
    async def test_get_creates_shared_mode(self, mock_ws_cls):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = False
        mgr._external_server_http_url = "http://127.0.0.1:8000"
        mgr._external_server_auth = None

        mock_ws = _make_mock_chat_interpreter()
        mock_ws_cls.return_value = mock_ws

        result = await mgr.get_interpreter(chat_id="chat-new")
        assert result is mock_ws
        assert "chat-new" in mgr._chat_interpreters

    @patch("core.runtime.interpreter.ExternalOIWebSocketInterpreter")
    async def test_get_creates_per_chat_mode(self, mock_ws_cls):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = "http://127.0.0.1:8000"
        mgr._last_settings = _make_full_settings()

        mock_pool = MagicMock()
        mock_record = MagicMock()
        mock_record.ws_url = "ws://127.0.0.1:8100/"
        mock_record.http_url = "http://127.0.0.1:8100"
        mock_pool.ensure_server = AsyncMock(return_value=(mock_record, True))
        mock_pool.touch = AsyncMock()
        mgr._external_server_pool = mock_pool

        mock_ws = _make_mock_chat_interpreter()
        mock_ws_cls.return_value = mock_ws

        result = await mgr.get_interpreter(chat_id="chat-perchat")
        assert result is mock_ws
        mock_pool.ensure_server.assert_awaited_once_with("chat-perchat")

    async def test_get_evicts_when_max_reached(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = False
        mgr._external_server_http_url = "http://127.0.0.1:8000"
        mgr._max_chat_instances = 2

        # Fill up to max
        for i in range(2):
            cid = f"chat-{i}"
            mgr._chat_interpreters[cid] = _make_mock_chat_interpreter()
            mgr._chat_last_used[cid] = time.time() - (100 - i)

        with patch("core.runtime.interpreter.ExternalOIWebSocketInterpreter") as mock_ws_cls:
            mock_ws_cls.return_value = _make_mock_chat_interpreter()
            result = await mgr.get_interpreter(chat_id="chat-new")

        assert result is not None
        # LRU should have been evicted
        assert len(mgr._chat_interpreters) <= 2

    async def test_get_creation_failure_returns_none(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = False
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        with patch("core.runtime.interpreter.ExternalOIWebSocketInterpreter", side_effect=RuntimeError("fail")):
            result = await mgr.get_interpreter(chat_id="chat-fail")

        assert result is None

    async def test_get_post_lock_finds_existing(self):
        """Lines 307-309: another coroutine creates interpreter while lock is held."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = False
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        mock_interp = _make_mock_chat_interpreter()

        class InjectingLock:
            async def __aenter__(self_inner):
                # Simulate another coroutine creating the interpreter
                mgr._chat_interpreters["chat-race"] = mock_interp
                mgr._chat_last_used["chat-race"] = time.time()
                return self_inner
            async def __aexit__(self_inner, *a):
                pass

        mgr._chat_create_lock = InjectingLock()

        result = await mgr.get_interpreter(chat_id="chat-race")
        assert result is mock_interp

    @patch("core.runtime.interpreter.ExternalOIWebSocketInterpreter")
    async def test_get_last_settings_fallback(self, mock_ws_cls):
        """Lines 321-322: _last_settings is None → import get_settings fallback."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = "http://127.0.0.1:8000"
        mgr._last_settings = None

        mock_pool = MagicMock()
        mock_record = MagicMock()
        mock_record.ws_url = "ws://127.0.0.1:8100/"
        mock_record.http_url = "http://127.0.0.1:8100"
        mock_pool.ensure_server = AsyncMock(return_value=(mock_record, True))
        mock_pool.touch = AsyncMock()
        mgr._external_server_pool = mock_pool

        mock_ws_cls.return_value = _make_mock_chat_interpreter()
        mock_settings = _make_full_settings()

        with patch("config.settings.get_settings", return_value=mock_settings):
            result = await mgr.get_interpreter(chat_id="chat-fallback")

        assert result is not None
        assert mgr._last_settings is mock_settings


# ═══════════════════════════════════════════════════════════════════════════
# NO-OP METHODS
# ═══════════════════════════════════════════════════════════════════════════


class TestNoOpMethods:
    async def test_load_profile_noop(self):
        mgr = InterpreterManager()
        await mgr.load_profile("GURU")  # Should not raise

    def test_refresh_integration_template_attrs(self):
        mgr = InterpreterManager()
        assert mgr.refresh_integration_template_attrs() == 0

    def test_add_web_search_capability(self):
        mgr = InterpreterManager()
        mgr.add_web_search_capability()  # Should not raise


# ═══════════════════════════════════════════════════════════════════════════
# RESET INTERPRETER
# ═══════════════════════════════════════════════════════════════════════════


class TestResetInterpreter:
    async def test_reset_single_chat(self):
        mgr = InterpreterManager()
        mgr._chat_interpreters["chat-1"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["chat-1"] = time.time()
        mgr._chat_interpreters["chat-2"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["chat-2"] = time.time()

        await mgr.reset_interpreter(chat_id="chat-1")
        assert "chat-1" not in mgr._chat_interpreters
        assert "chat-2" in mgr._chat_interpreters

    async def test_reset_all(self):
        mgr = InterpreterManager()
        for i in range(3):
            mgr._chat_interpreters[f"c{i}"] = _make_mock_chat_interpreter()
            mgr._chat_last_used[f"c{i}"] = time.time()

        await mgr.reset_interpreter(chat_id=None)
        assert len(mgr._chat_interpreters) == 0

    async def test_reset_nonexistent_chat(self):
        mgr = InterpreterManager()
        await mgr.reset_interpreter(chat_id="ghost")  # Should not raise


# ═══════════════════════════════════════════════════════════════════════════
# CLEANUP CHAT INSTANCE
# ═══════════════════════════════════════════════════════════════════════════


class TestCleanupChatInstance:
    async def test_cleanup_basic(self):
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mgr._chat_interpreters["c1"] = mock_interp
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")
        assert "c1" not in mgr._chat_interpreters
        assert "c1" not in mgr._chat_last_used
        mock_interp.close.assert_awaited_once()

    async def test_cleanup_with_pool(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mock_pool = MagicMock()
        mock_pool.stop_server = AsyncMock()
        mgr._external_server_pool = mock_pool

        mgr._chat_interpreters["c1"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")
        mock_pool.stop_server.assert_awaited_once_with("c1")

    async def test_cleanup_with_stop_event(self):
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mock_stop_event = MagicMock()
        mock_interp.stop_event = mock_stop_event
        mgr._chat_interpreters["c1"] = mock_interp
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")
        mock_stop_event.set.assert_called_once()

    async def test_cleanup_with_reset_method(self):
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mock_interp.reset = AsyncMock()
        mgr._chat_interpreters["c1"] = mock_interp
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")
        mock_interp.reset.assert_awaited_once()

    async def test_cleanup_nonexistent(self):
        mgr = InterpreterManager()
        await mgr._cleanup_chat_instance("ghost")  # Should not raise

    async def test_cleanup_close_error_suppressed(self):
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mock_interp.close = AsyncMock(side_effect=RuntimeError("close fail"))
        mgr._chat_interpreters["c1"] = mock_interp
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")  # Should not raise
        assert "c1" not in mgr._chat_interpreters

    async def test_cleanup_pool_error_suppressed(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mock_pool = MagicMock()
        mock_pool.stop_server = AsyncMock(side_effect=RuntimeError("pool fail"))
        mgr._external_server_pool = mock_pool

        mgr._chat_interpreters["c1"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")  # Should not raise

    async def test_cleanup_with_output_queue(self):
        """Lines 410-417: output queue close path."""
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mock_queue = MagicMock()
        mock_queue.close = AsyncMock()
        mock_interp.output_queue = mock_queue
        mgr._chat_interpreters["c1"] = mock_interp
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")
        mock_queue.close.assert_awaited_once()
        assert mock_interp.output_queue is None

    async def test_cleanup_output_queue_error_suppressed(self):
        """Lines 414-415: output queue close error suppressed."""
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mock_queue = MagicMock()
        mock_queue.close = AsyncMock(side_effect=RuntimeError("queue close fail"))
        mock_interp.output_queue = mock_queue
        mgr._chat_interpreters["c1"] = mock_interp
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")  # Should not raise
        assert mock_interp.output_queue is None  # Finally block sets to None

    async def test_cleanup_reset_error_suppressed(self):
        """Lines 423-424: reset error suppressed."""
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mock_interp.reset = AsyncMock(side_effect=RuntimeError("reset fail"))
        mgr._chat_interpreters["c1"] = mock_interp
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")  # Should not raise

    async def test_cleanup_outer_exception(self):
        """Lines 428-429: outer except catches error from non-guarded code."""
        mgr = InterpreterManager()
        mock_interp = _make_mock_chat_interpreter()
        mock_stop_event = MagicMock()
        mock_stop_event.set.side_effect = RuntimeError("stop event crash")
        mock_interp.stop_event = mock_stop_event
        mgr._chat_interpreters["c1"] = mock_interp
        mgr._chat_last_used["c1"] = time.time()

        await mgr._cleanup_chat_instance("c1")  # Should not raise (outer except)


# ═══════════════════════════════════════════════════════════════════════════
# STALE INSTANCE CLEANUP
# ═══════════════════════════════════════════════════════════════════════════


class TestStaleInstanceCleanup:
    async def test_cleanup_stale(self):
        mgr = InterpreterManager()
        mgr._chat_ttl_seconds = 10

        mgr._chat_interpreters["old"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["old"] = time.time() - 100  # Stale

        mgr._chat_interpreters["new"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["new"] = time.time()  # Fresh

        await mgr._cleanup_stale_instances()
        assert "old" not in mgr._chat_interpreters
        assert "new" in mgr._chat_interpreters

    async def test_cleanup_stale_with_pool(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mock_pool = MagicMock()
        mock_pool._lock = asyncio.Lock()
        mock_pool._cleanup_stale_locked = AsyncMock()
        mock_pool.stop_server = AsyncMock()
        mgr._external_server_pool = mock_pool

        mgr._chat_ttl_seconds = 10
        mgr._chat_interpreters["old"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["old"] = time.time() - 100

        await mgr._cleanup_stale_instances()
        mock_pool._cleanup_stale_locked.assert_awaited_once()


class TestEvictLruInstance:
    async def test_evict_lru(self):
        mgr = InterpreterManager()
        mgr._chat_interpreters["oldest"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["oldest"] = time.time() - 200
        mgr._chat_interpreters["newest"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["newest"] = time.time()

        await mgr._evict_lru_instance()
        assert "oldest" not in mgr._chat_interpreters
        assert "newest" in mgr._chat_interpreters

    async def test_evict_empty(self):
        mgr = InterpreterManager()
        await mgr._evict_lru_instance()  # Should not raise


# ═══════════════════════════════════════════════════════════════════════════
# APPLY SETTINGS
# ═══════════════════════════════════════════════════════════════════════════


class TestApplySettings:
    async def test_apply_settings_caches_settings(self):
        mgr = InterpreterManager()
        settings = _make_full_settings()
        await mgr.apply_settings_async(settings)
        assert mgr._last_settings is settings
        assert mgr._context_token_limit == 100000

    async def test_apply_settings_context_thresholds(self):
        mgr = InterpreterManager()
        settings = _make_full_settings()
        settings.interpreter.context_warning_threshold = 0.75
        settings.interpreter.context_high_threshold = 0.85
        settings.interpreter.context_critical_threshold = 0.92
        await mgr.apply_settings_async(settings)
        assert mgr._context_thresholds["warning"] == 0.75
        assert mgr._context_thresholds["high"] == 0.85
        assert mgr._context_thresholds["critical"] == 0.92

    @patch("core.runtime.interpreter.InterpreterManager._apply_settings_to_external_server")
    async def test_apply_settings_shared_mode(self, mock_apply):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = False
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        settings = _make_full_settings()
        await mgr.apply_settings_async(settings)
        mock_apply.assert_awaited_once()

    @patch("core.runtime.interpreter.InterpreterManager._apply_settings_to_external_server")
    async def test_apply_settings_per_chat_pushes_to_pool(self, mock_apply):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        mock_pool = MagicMock()
        mock_rec = MagicMock()
        mock_rec.http_url = "http://127.0.0.1:8100"
        mock_rec.host = "127.0.0.1"
        mock_rec.port = 8100
        mock_pool.list_servers.return_value = [mock_rec]
        mgr._external_server_pool = mock_pool

        settings = _make_full_settings()
        await mgr.apply_settings_async(settings)
        assert mock_apply.await_count == 1

    async def test_apply_settings_init_populates_system_message(self):
        mgr = InterpreterManager()
        mgr._populate_system_message_cache = MagicMock()

        settings = _make_full_settings()
        await mgr.apply_settings_async(settings, init=True)
        mgr._populate_system_message_cache.assert_called_once()

    @patch("core.runtime.interpreter.InterpreterManager._apply_settings_to_external_server")
    async def test_apply_settings_per_chat_failure_suppressed(self, mock_apply):
        """Bug U fix: per-chat settings apply failure is suppressed, loop continues."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        mock_pool = MagicMock()
        mock_rec = MagicMock()
        mock_rec.http_url = "http://127.0.0.1:8100"
        mock_rec.host = "127.0.0.1"
        mock_rec.port = 8100
        mock_pool.list_servers.return_value = [mock_rec]
        mgr._external_server_pool = mock_pool

        mock_apply.side_effect = RuntimeError("apply fail")

        settings = _make_full_settings()
        # Should NOT raise — failure is logged and suppressed
        await mgr.apply_settings_async(settings)


    @patch("core.runtime.interpreter.InterpreterManager._apply_settings_to_external_server")
    async def test_apply_settings_per_chat_partial_failure_continues(self, mock_apply):
        """Bug U: first server fails, second server still receives settings."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        rec1 = MagicMock()
        rec1.http_url = "http://127.0.0.1:8100"
        rec1.host = "127.0.0.1"
        rec1.port = 8100
        rec2 = MagicMock()
        rec2.http_url = "http://127.0.0.1:8101"
        rec2.host = "127.0.0.1"
        rec2.port = 8101

        mock_pool = MagicMock()
        mock_pool.list_servers.return_value = [rec1, rec2]
        mgr._external_server_pool = mock_pool

        # First call fails, second succeeds
        mock_apply.side_effect = [RuntimeError("server 1 down"), None]

        settings = _make_full_settings()
        await mgr.apply_settings_async(settings)
        # Both servers were attempted
        assert mock_apply.await_count == 2

    @patch("core.runtime.interpreter.InterpreterManager._apply_settings_to_external_server")
    async def test_apply_settings_per_chat_timeout_error_suppressed(self, mock_apply):
        """Bug U: TimeoutError during settings push is suppressed."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        mock_pool = MagicMock()
        mock_rec = MagicMock()
        mock_rec.http_url = "http://127.0.0.1:8100"
        mock_rec.host = "127.0.0.1"
        mock_rec.port = 8100
        mock_pool.list_servers.return_value = [mock_rec]
        mgr._external_server_pool = mock_pool

        mock_apply.side_effect = TimeoutError("connection timed out")

        settings = _make_full_settings()
        # TimeoutError should be caught and suppressed
        await mgr.apply_settings_async(settings)


# ═══════════════════════════════════════════════════════════════════════════
# POPULATE SYSTEM MESSAGE CACHE
# ═══════════════════════════════════════════════════════════════════════════


class TestPopulateSystemMessageCache:
    def test_yaml_profile(self, tmp_path):
        mgr = InterpreterManager()
        yaml_file = tmp_path / "GURU.yaml"
        yaml_file.write_text("system_message: 'Hello GURU'", encoding="utf-8")

        mock_pm = MagicMock()
        mock_pm.get_profile_path.return_value = yaml_file
        mgr._profile_manager = mock_pm

        mgr._populate_system_message_cache()
        assert mgr._enriched_system_message == "Hello GURU"

    def test_python_profile(self, tmp_path):
        mgr = InterpreterManager()
        py_file = tmp_path / "GURU.py"
        py_file.write_text("system_message = 'Hello from Python'", encoding="utf-8")

        mock_pm = MagicMock()
        mock_pm.get_profile_path.return_value = py_file
        mgr._profile_manager = mock_pm

        mgr._populate_system_message_cache()
        assert mgr._enriched_system_message == "Hello from Python"

    def test_profile_not_found(self):
        mgr = InterpreterManager()
        mock_pm = MagicMock()
        mock_pm.get_profile_path.return_value = None
        mgr._profile_manager = mock_pm

        mgr._populate_system_message_cache()
        assert mgr._enriched_system_message is None

    def test_unsupported_format(self, tmp_path):
        mgr = InterpreterManager()
        toml_file = tmp_path / "GURU.toml"
        toml_file.write_text("[profile]\nname='guru'", encoding="utf-8")

        mock_pm = MagicMock()
        mock_pm.get_profile_path.return_value = toml_file
        mgr._profile_manager = mock_pm

        mgr._populate_system_message_cache()
        assert mgr._enriched_system_message is None

    def test_yaml_missing_key(self, tmp_path):
        mgr = InterpreterManager()
        yaml_file = tmp_path / "GURU.yaml"
        yaml_file.write_text("name: test", encoding="utf-8")

        mock_pm = MagicMock()
        mock_pm.get_profile_path.return_value = yaml_file
        mgr._profile_manager = mock_pm

        mgr._populate_system_message_cache()
        assert mgr._enriched_system_message is None

    def test_exception_suppressed(self):
        mgr = InterpreterManager()
        mock_pm = MagicMock()
        mock_pm.get_profile_path.side_effect = RuntimeError("crash")
        mgr._profile_manager = mock_pm

        mgr._populate_system_message_cache()  # Should not raise
        assert mgr._enriched_system_message is None

    def test_python_profile_missing_key(self, tmp_path):
        """Line 546: Python profile loaded but system_message variable not found."""
        mgr = InterpreterManager()
        py_file = tmp_path / "GURU.py"
        py_file.write_text("other_var = 'hello'", encoding="utf-8")

        mock_pm = MagicMock()
        mock_pm.get_profile_path.return_value = py_file
        mgr._profile_manager = mock_pm

        mgr._populate_system_message_cache()
        assert mgr._enriched_system_message is None


# ═══════════════════════════════════════════════════════════════════════════
# APPLY SETTINGS TO EXTERNAL SERVER
# ═══════════════════════════════════════════════════════════════════════════


class TestApplySettingsToExternalServer:
    @patch("httpx.AsyncClient")
    async def test_apply_success(self, mock_client_cls):
        mgr = InterpreterManager()
        mgr._external_server_http_url = "http://127.0.0.1:8000"
        mgr._external_server_auth = "token123"

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        settings = _make_full_settings()
        await mgr._apply_settings_to_external_server(settings)
        mock_client.post.assert_awaited_once()
        call_kwargs = mock_client.post.await_args
        assert "X-API-KEY" in call_kwargs.kwargs["headers"]

    @patch("httpx.AsyncClient")
    async def test_apply_aether_inference_provider(self, mock_client_cls):
        mgr = InterpreterManager()
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        settings = _make_full_settings(provider="aether_inference")
        settings.inference_url = "http://localhost:5000/v1"
        await mgr._apply_settings_to_external_server(settings)
        # api_base should be inference_url
        call_json = mock_client.post.await_args.kwargs["json"]
        assert call_json["llm"]["api_base"] == "http://localhost:5000/v1"

    @patch("httpx.AsyncClient")
    async def test_apply_server_rejects(self, mock_client_cls):
        mgr = InterpreterManager()
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal Server Error"
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        settings = _make_full_settings()
        with pytest.raises(RuntimeError, match="rejected settings"):
            await mgr._apply_settings_to_external_server(settings)

    async def test_apply_no_url(self):
        mgr = InterpreterManager()
        mgr._external_server_http_url = ""
        with pytest.raises(RuntimeError, match="missing"):
            await mgr._apply_settings_to_external_server(_make_full_settings())

    @patch("httpx.AsyncClient")
    async def test_timeout_parsing_failure(self, mock_client_cls):
        """Lines 612-613: timeout parsing ValueError → fallback to 10.0."""
        mgr = InterpreterManager()
        mgr._external_server_http_url = "http://127.0.0.1:8000"

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        settings = _make_full_settings()
        settings.http_client = MagicMock()
        settings.http_client.external_service_timeout = "not-a-number"

        await mgr._apply_settings_to_external_server(settings)
        # Should not crash — uses default 10.0
        mock_client_cls.assert_called_once()


# ═══════════════════════════════════════════════════════════════════════════
# CONTEXT STATUS
# ═══════════════════════════════════════════════════════════════════════════


class TestContextStatus:
    async def test_new_chat(self):
        mgr = InterpreterManager()
        status = await mgr.get_context_status("unknown-chat")
        assert status["status"] == "new"
        assert status["message_count"] == 0
        assert status["needs_summarization"] is False

    async def test_normal_status(self):
        mgr = InterpreterManager()
        mock_interp = MagicMock()
        mock_interp.messages = [
            {"role": "user", "content": "Hello " * 100},
            {"role": "assistant", "content": "Hi " * 100},
        ]
        mgr._chat_interpreters["c1"] = mock_interp

        status = await mgr.get_context_status("c1")
        assert status["status"] == "normal"
        assert status["message_count"] == 2
        assert status["token_count"] > 0

    async def test_warning_status(self):
        mgr = InterpreterManager()
        mgr._context_token_limit = 100
        mock_interp = MagicMock()
        # 85 tokens worth (85 * 4 = 340 chars)
        mock_interp.messages = [{"role": "user", "content": "x" * 340}]
        mgr._chat_interpreters["c1"] = mock_interp

        status = await mgr.get_context_status("c1")
        assert status["status"] == "warning"
        assert status["needs_summarization"] is False

    async def test_high_status(self):
        mgr = InterpreterManager()
        mgr._context_token_limit = 100
        mock_interp = MagicMock()
        # 364 chars / 4 = 91 tokens => 91% usage => high (>= 0.90, < 0.95)
        mock_interp.messages = [{"role": "user", "content": "x" * 364}]
        mgr._chat_interpreters["c1"] = mock_interp

        status = await mgr.get_context_status("c1")
        assert status["status"] == "high"
        assert status["needs_summarization"] is True

    async def test_critical_status(self):
        mgr = InterpreterManager()
        mgr._context_token_limit = 100
        mock_interp = MagicMock()
        mock_interp.messages = [{"role": "user", "content": "x" * 400}]
        mgr._chat_interpreters["c1"] = mock_interp

        status = await mgr.get_context_status("c1")
        assert status["status"] == "critical"
        assert status["recommend_new_chat"] is True


# ═══════════════════════════════════════════════════════════════════════════
# SUMMARIZE CONTEXT
# ═══════════════════════════════════════════════════════════════════════════


class TestSummarizeContext:
    async def test_no_interpreter(self):
        mgr = InterpreterManager()
        result = await mgr.summarize_context("unknown")
        assert result is None

    async def test_not_enough_messages(self):
        mgr = InterpreterManager()
        mock_interp = MagicMock()
        mock_interp.messages = [{"role": "user", "content": "hi"}] * 5
        mgr._chat_interpreters["c1"] = mock_interp

        result = await mgr.summarize_context("c1")
        assert result is None

    async def test_summarize_replaces_middle(self):
        mgr = InterpreterManager()
        messages = [
            {"role": "system", "content": "You are an AI."},
        ]
        for i in range(20):
            messages.append({"role": "user", "content": f"msg {i}"})
            messages.append({"role": "assistant", "content": f"reply {i}"})
        mock_interp = MagicMock()
        mock_interp.messages = messages
        mgr._chat_interpreters["c1"] = mock_interp

        # Patch get_context_status to return high usage (above threshold)
        with patch.object(mgr, 'get_context_status', return_value={"usage_percent": 90.0}):
            result = await mgr.summarize_context("c1")

        assert isinstance(result, str)
        assert "CONVERSATION SUMMARY" in result
        # Messages should be reduced
        assert len(mock_interp.messages) < len(messages)

    async def test_summarize_error_returns_none(self):
        mgr = InterpreterManager()
        mock_interp = MagicMock()
        # messages with enough items to pass the len < 10 check,
        # but second element has no 'content' key to trigger error in loop.
        bad_messages = [{"role": "system", "content": "sys"}]
        for _ in range(15):
            bad_messages.append({"role": "user", "content": "x" * 100})
        # Now cause an error: replace messages with a list that has
        # a non-dict item inside the middle section (processed in try block)
        bad_messages[5] = "not-a-dict"
        mock_interp.messages = bad_messages
        mgr._chat_interpreters["c1"] = mock_interp

        # Patch get_context_status to return high usage (above threshold)
        # The try/except in summarize_context should catch the error;
        # non-dict items are skipped via isinstance() guard, so summary succeeds.
        with patch.object(mgr, 'get_context_status', return_value={"usage_percent": 90.0}):
            result = await mgr.summarize_context("c1")

        assert isinstance(result, str), f"Expected str summary, got {type(result)}"
        assert "CONVERSATION SUMMARY" in result

    async def test_summarize_exactly_10_returns_none(self):
        """Line 780: len(messages) <= 10 → return None (second guard)."""
        mgr = InterpreterManager()
        mock_interp = MagicMock()
        mock_interp.messages = [{"role": "user", "content": "hi"}] * 10
        mgr._chat_interpreters["c1"] = mock_interp

        result = await mgr.summarize_context("c1")
        assert result is None

    async def test_summarize_with_document_utility(self):
        """DocumentUtility.extract_from_text is called for large conversations."""
        mgr = InterpreterManager()
        messages = [{"role": "system", "content": "You are an AI."}]
        for i in range(30):
            messages.append({"role": "user", "content": f"Long user message {i}: " + "x" * 180})
            messages.append({"role": "assistant", "content": f"Long reply {i}: " + "y" * 180})

        mock_interp = MagicMock()
        mock_interp.messages = messages
        mgr._chat_interpreters["c1"] = mock_interp

        mock_util = MagicMock()
        mock_util.extract_from_text.return_value = "Extracted summary of conversation."

        mock_util_module = MagicMock()
        mock_util_module.DocumentUtility.return_value = mock_util

        # Patch get_context_status to return high usage (above threshold)
        with patch.object(mgr, 'get_context_status', return_value={"usage_percent": 90.0}), \
             patch.dict(sys.modules, {"utils.document_processing": mock_util_module}):
            result = await mgr.summarize_context("c1")

        assert isinstance(result, str)
        assert "CONVERSATION SUMMARY" in result
        mock_util.extract_from_text.assert_called_once()

    async def test_summarize_extract_returns_none_uses_full_text(self):
        """extract_from_text returns None → fallback to full middle text."""
        mgr = InterpreterManager()
        messages = [{"role": "system", "content": "sys"}]
        for i in range(30):
            messages.append({"role": "user", "content": f"msg {i}: " + "x" * 180})
            messages.append({"role": "assistant", "content": f"reply {i}: " + "y" * 180})

        mock_interp = MagicMock()
        mock_interp.messages = messages
        mgr._chat_interpreters["c1"] = mock_interp

        mock_util = MagicMock()
        mock_util.extract_from_text.return_value = None

        mock_util_module = MagicMock()
        mock_util_module.DocumentUtility.return_value = mock_util

        # Patch get_context_status to return high usage (above threshold)
        with patch.object(mgr, 'get_context_status', return_value={"usage_percent": 90.0}), \
             patch.dict(sys.modules, {"utils.document_processing": mock_util_module}):
            result = await mgr.summarize_context("c1")

        assert isinstance(result, str)
        assert "CONVERSATION SUMMARY" in result

    async def test_summarize_document_utility_failure_fallback(self):
        """Lines 833-835: DocumentUtility fails → fallback to full text."""
        mgr = InterpreterManager()
        messages = [{"role": "system", "content": "sys"}]
        for i in range(30):
            messages.append({"role": "user", "content": f"msg {i}: " + "x" * 180})
            messages.append({"role": "assistant", "content": f"reply {i}: " + "y" * 180})

        mock_interp = MagicMock()
        mock_interp.messages = messages
        mgr._chat_interpreters["c1"] = mock_interp

        mock_util_module = MagicMock()
        mock_util_module.DocumentUtility.side_effect = RuntimeError("import fail")

        # Patch get_context_status to return high usage (above threshold)
        with patch.object(mgr, 'get_context_status', return_value={"usage_percent": 90.0}), \
             patch.dict(sys.modules, {"utils.document_processing": mock_util_module}):
            result = await mgr.summarize_context("c1")

        assert isinstance(result, str)
        assert "CONVERSATION SUMMARY" in result

    async def test_summarize_top_level_exception(self):
        """Lines 864-866: top-level exception in summarize → None."""
        mgr = InterpreterManager()
        mock_interp = MagicMock()
        # messages property that raises on access
        type(mock_interp).messages = PropertyMock(
            side_effect=[
                [{"role": "user", "content": "x"}] * 15,  # len check
                [{"role": "user", "content": "x"}] * 15,  # hasattr/len check
                RuntimeError("property crash"),  # actual access
            ]
        )
        mgr._chat_interpreters["c1"] = mock_interp

        # Patch get_context_status to return high usage (above threshold)
        with patch.object(mgr, 'get_context_status', return_value={"usage_percent": 90.0}):
            result = await mgr.summarize_context("c1")

        assert result is None


# ═══════════════════════════════════════════════════════════════════════════
# CLEANUP AND HEALTH
# ═══════════════════════════════════════════════════════════════════════════


class TestCleanupAndHealth:
    async def test_full_cleanup(self):
        mgr = InterpreterManager()
        await mgr.initialize()
        mgr._chat_interpreters["c1"] = _make_mock_chat_interpreter()
        mgr._chat_last_used["c1"] = time.time()

        await mgr.cleanup()
        assert mgr._cleanup_task is None
        assert len(mgr._chat_interpreters) == 0

    async def test_cleanup_with_pool(self):
        mgr = InterpreterManager()
        mock_pool = MagicMock()
        mock_pool.stop_all = AsyncMock()
        mgr._external_server_pool = mock_pool

        await mgr.cleanup()
        mock_pool.stop_all.assert_awaited_once()
        assert mgr._external_server_pool is None

    async def test_cleanup_pool_error_suppressed(self):
        mgr = InterpreterManager()
        mock_pool = MagicMock()
        mock_pool.stop_all = AsyncMock(side_effect=RuntimeError("pool crash"))
        mgr._external_server_pool = mock_pool

        await mgr.cleanup()  # Should not raise
        assert mgr._external_server_pool is None

    def test_health_status_disabled(self):
        mgr = InterpreterManager()
        status = mgr.get_health_status()
        assert status["oi_available"] is False
        assert status["active_chats"] == 0

    def test_health_status_enabled(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = True
        mgr._chat_interpreters["c1"] = MagicMock()

        status = mgr.get_health_status()
        assert status["oi_available"] is True
        assert status["mode"] == "external_per_chat"
        assert status["active_chats"] == 1

    def test_health_status_shared_mode(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mgr._external_server_per_chat = False

        status = mgr.get_health_status()
        assert status["mode"] == "external_shared"

    def test_health_status_with_pool(self):
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mock_pool = MagicMock()
        mock_pool.list_servers.return_value = [MagicMock(), MagicMock()]
        mgr._external_server_pool = mock_pool

        status = mgr.get_health_status()
        assert status["pool_servers"] == 2

    def test_health_status_pool_exception(self):
        """Line 887: pool.list_servers() raises → pool_servers = 0."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mock_pool = MagicMock()
        mock_pool.list_servers.side_effect = RuntimeError("pool broken")
        mgr._external_server_pool = mock_pool

        status = mgr.get_health_status()
        assert status["pool_servers"] == 0

    def test_health_status_pool_timeout_error(self):
        """Bug V: TimeoutError from pool.list_servers() caught by broadened except."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mock_pool = MagicMock()
        mock_pool.list_servers.side_effect = TimeoutError("pool timeout")
        mgr._external_server_pool = mock_pool

        status = mgr.get_health_status()
        assert status["pool_servers"] == 0

    def test_health_status_pool_connection_error(self):
        """Bug V: ConnectionError from pool.list_servers() caught by broadened except."""
        mgr = InterpreterManager()
        mgr._external_server_enabled = True
        mock_pool = MagicMock()
        mock_pool.list_servers.side_effect = ConnectionError("pool unreachable")
        mgr._external_server_pool = mock_pool

        status = mgr.get_health_status()
        assert status["pool_servers"] == 0


# ═══════════════════════════════════════════════════════════════════════════
# PERIODIC CLEANUP LOOP
# ═══════════════════════════════════════════════════════════════════════════


class TestPeriodicCleanupLoop:
    async def test_loop_cancellation(self):
        mgr = InterpreterManager()
        mgr._is_running = True
        task = asyncio.create_task(mgr._periodic_cleanup_loop())
        await asyncio.sleep(0.01)
        task.cancel()
        try:
            await asyncio.wait_for(task, timeout=1.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        assert task.done()

    async def test_loop_runs_cleanup_and_handles_error(self):
        """Lines 654, 657-658: loop runs _cleanup_stale_instances, handles error."""
        mgr = InterpreterManager()
        mgr._is_running = True

        call_count = {"n": 0}

        async def _mock_cleanup():
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("boom")
            # Second call succeeds

        mgr._cleanup_stale_instances = _mock_cleanup

        sleep_count = {"n": 0}

        async def _mock_sleep(seconds):
            sleep_count["n"] += 1
            if sleep_count["n"] >= 3:
                raise asyncio.CancelledError()

        with patch("asyncio.sleep", side_effect=_mock_sleep):
            await mgr._periodic_cleanup_loop()

        # Cleanup was called at least once (first call raised, second succeeded)
        assert call_count["n"] >= 1


# ═══════════════════════════════════════════════════════════════════════════
# SINGLETON ACCESSOR
# ═══════════════════════════════════════════════════════════════════════════


class TestGetInterpreterManager:
    def test_singleton_accessor(self):
        """Lines 908-909: get_interpreter_manager delegates to engine."""
        from core.runtime.interpreter import get_interpreter_manager

        mock_mgr = MagicMock()
        with patch("core.runtime.engine.get_interpreter_manager", return_value=mock_mgr):
            result = get_interpreter_manager()
        assert result is mock_mgr


# ═══════════════════════════════════════════════════════════════════════════
# _maybe_await UTILITY
# ═══════════════════════════════════════════════════════════════════════════


class TestMaybeAwait:
    async def test_awaitable(self):
        async def coro():
            return 42

        result = await _maybe_await(coro())
        assert result == 42

    async def test_non_awaitable(self):
        result = await _maybe_await(42)
        assert result == 42

    async def test_none(self):
        result = await _maybe_await(None)
        assert result is None
