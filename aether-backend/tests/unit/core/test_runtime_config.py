"""
Unit Tests: RuntimeConfig and ConfigManager (core/runtime/config.py)

Covers RuntimeConfig validation + from_settings, ConfigManager config loading,
HTTP client lifecycle, context manager, health status.

Mock boundaries:
  - utils.config.get_llm_settings (lazy import in _load_centralized_config)
  - httpx.AsyncClient real instances used where possible
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest

from core.runtime.config import RuntimeConfig, ConfigManager


# ═══════════════════════════════════════════════════════════════════════════════
# RuntimeConfig
# ═══════════════════════════════════════════════════════════════════════════════


class TestRuntimeConfigDefaults:
    def test_default_values(self):
        cfg = RuntimeConfig()
        assert cfg.context_window == 100_000
        assert cfg.max_tokens == 4_096
        assert cfg.timeout == 600.0
        assert cfg.stream_chunk_interval == 0.05
        assert cfg.max_queue_size == 100
        assert cfg.allow_parallel_requests is True

    def test_custom_values(self):
        cfg = RuntimeConfig(
            context_window=50_000,
            max_tokens=2_048,
            timeout=300.0,
            stream_chunk_interval=0.1,
            max_queue_size=50,
            allow_parallel_requests=False,
        )
        assert cfg.context_window == 50_000
        assert cfg.max_tokens == 2_048
        assert cfg.timeout == 300.0
        assert cfg.stream_chunk_interval == 0.1
        assert cfg.max_queue_size == 50
        assert cfg.allow_parallel_requests is False


class TestRuntimeConfigValidation:
    def test_invalid_context_window(self):
        with pytest.raises(ValueError, match="context_window must be positive"):
            RuntimeConfig(context_window=0)

    def test_negative_context_window(self):
        with pytest.raises(ValueError, match="context_window must be positive"):
            RuntimeConfig(context_window=-1)

    def test_invalid_max_tokens(self):
        with pytest.raises(ValueError, match="max_tokens must be positive"):
            RuntimeConfig(max_tokens=0)

    def test_invalid_timeout(self):
        with pytest.raises(ValueError, match="timeout must be positive"):
            RuntimeConfig(timeout=0)

    def test_invalid_stream_chunk_interval(self):
        with pytest.raises(ValueError, match="stream_chunk_interval must be positive"):
            RuntimeConfig(stream_chunk_interval=-0.01)

    def test_invalid_max_queue_size(self):
        with pytest.raises(ValueError, match="max_queue_size must be positive"):
            RuntimeConfig(max_queue_size=0)


class TestRuntimeConfigFromSettings:
    def test_with_full_settings(self):
        settings = MagicMock()
        settings.llm.context_window = 200_000
        settings.llm.max_tokens = 8_192
        settings.embeddings.timeout_seconds = 120

        cfg = RuntimeConfig.from_settings(settings)

        assert cfg.context_window == 200_000
        assert cfg.max_tokens == 8_192
        assert cfg.timeout == 120.0
        # Defaults preserved for fields not in settings
        assert cfg.stream_chunk_interval == 0.05
        assert cfg.max_queue_size == 100

    def test_with_no_llm_settings(self):
        settings = MagicMock()
        settings.llm = None
        settings.embeddings = None

        cfg = RuntimeConfig.from_settings(settings)

        assert cfg.context_window == 100_000
        assert cfg.max_tokens == 4_096
        assert cfg.timeout == 600.0

    def test_with_invalid_timeout(self):
        """Negative or zero timeout falls back to default."""
        settings = MagicMock()
        settings.llm = None
        settings.embeddings.timeout_seconds = -5

        cfg = RuntimeConfig.from_settings(settings)
        assert cfg.timeout == 600.0

    def test_with_none_timeout(self):
        settings = MagicMock()
        settings.llm = None
        settings.embeddings.timeout_seconds = None

        cfg = RuntimeConfig.from_settings(settings)
        assert cfg.timeout == 600.0

    def test_with_string_timeout_falls_back(self):
        """Non-numeric timeout falls back to default."""
        settings = MagicMock()
        settings.llm = None
        settings.embeddings.timeout_seconds = "not_a_number"

        cfg = RuntimeConfig.from_settings(settings)
        assert cfg.timeout == 600.0


# ═══════════════════════════════════════════════════════════════════════════════
# ConfigManager
# ═══════════════════════════════════════════════════════════════════════════════


class TestConfigManagerInit:
    def test_defaults(self):
        cm = ConfigManager()
        assert cm._connect_timeout == 5.0
        assert cm._read_timeout == 600.0
        assert cm._write_timeout == 30.0
        assert cm._pool_timeout == 5.0
        assert cm._verify_ssl is True
        assert cm._max_redirects == 5
        assert cm._config_cache is None
        assert cm._client is None

    def test_custom_params(self):
        cm = ConfigManager(
            connect_timeout=10.0,
            read_timeout=120.0,
            write_timeout=60.0,
            pool_timeout=10.0,
            verify_ssl=False,
            max_redirects=3,
        )
        assert cm._connect_timeout == 10.0
        assert cm._read_timeout == 120.0
        assert cm._write_timeout == 60.0
        assert cm._pool_timeout == 10.0
        assert cm._verify_ssl is False
        assert cm._max_redirects == 3


# ─── Configuration Management ────────────────────────────────────────────────


class TestLoadAndApplySettings:
    def test_applies_centralized_config(self):
        cm = ConfigManager()
        config = {
            "provider": "lm-studio",
            "api_base": "http://localhost:1234/v1",
            "model": "qwen3-4b",
            "supports_vision": True,
            "context_window": 128_000,
            "max_tokens": 4096,
        }

        with patch.object(cm, "_load_centralized_config", return_value=config):
            settings = MagicMock()
            result = cm.load_and_apply_settings(settings)

            assert result is settings
            assert settings.llm.provider == "lm-studio"
            assert settings.llm.model == "qwen3-4b"

    def test_returns_base_when_no_config(self):
        cm = ConfigManager()

        with patch.object(cm, "_load_centralized_config", return_value=None):
            settings = MagicMock()
            result = cm.load_and_apply_settings(settings)
            assert result is settings

    def test_returns_base_on_exception(self):
        cm = ConfigManager()

        with patch.object(cm, "_load_centralized_config", side_effect=Exception("disk error")):
            settings = MagicMock()
            result = cm.load_and_apply_settings(settings)
            assert result is settings


class TestLoadCentralizedConfig:
    def test_returns_cached_if_available(self):
        cm = ConfigManager()
        cached = {"provider": "cached", "api_base": "x", "model": "y",
                  "supports_vision": False, "context_window": 1, "max_tokens": 1}
        cm._config_cache = cached

        result = cm._load_centralized_config()
        assert result is cached

    def test_loads_fresh_config(self):
        cm = ConfigManager()
        config = {
            "provider": "lm-studio",
            "api_base": "http://localhost:1234/v1",
            "model": "qwen3-4b",
            "supports_vision": True,
            "context_window": 128_000,
            "max_tokens": 4096,
        }

        with patch("core.runtime.config.get_llm_settings", return_value=config, create=True):
            with patch("utils.config.get_llm_settings", return_value=config):
                result = cm._load_centralized_config()

        assert result == config
        assert cm._config_cache == config

    def test_returns_none_on_missing_fields(self):
        cm = ConfigManager()
        incomplete = {"provider": "lm-studio"}  # Missing required fields

        with patch("utils.config.get_llm_settings", return_value=incomplete):
            result = cm._load_centralized_config()

        assert result is None
        assert cm._config_cache is None

    def test_returns_none_on_exception(self):
        cm = ConfigManager()

        with patch("utils.config.get_llm_settings", side_effect=ImportError("no module")):
            result = cm._load_centralized_config()

        assert result is None


class TestApplyLlmConfig:
    def test_sets_all_fields(self):
        cm = ConfigManager()
        settings = MagicMock()
        config = {
            "provider": "openai",
            "api_base": "https://api.openai.com/v1",
            "model": "gpt-4",
            "supports_vision": True,
            "context_window": 128_000,
            "max_tokens": 4096,
        }

        result = cm._apply_llm_config(settings, config)

        assert result is settings
        assert settings.llm.provider == "openai"
        assert settings.llm.api_base == "https://api.openai.com/v1"
        assert settings.llm.model == "gpt-4"
        assert settings.llm.supports_vision is True
        assert settings.llm.context_window == 128_000
        assert settings.llm.max_tokens == 4096


class TestClearCache:
    def test_clears_config_cache(self):
        cm = ConfigManager()
        cm._config_cache = {"some": "config"}

        cm.clear_cache()

        assert cm._config_cache is None


# ─── HTTP Client Management ──────────────────────────────────────────────────


class TestGetClient:
    async def test_creates_client(self):
        cm = ConfigManager()
        try:
            client = await cm.get_client()

            assert isinstance(client, httpx.AsyncClient)
            assert not client.is_closed
            assert cm._client is client
        finally:
            await cm.close()

    async def test_returns_existing_client(self):
        cm = ConfigManager()
        try:
            client1 = await cm.get_client()
            client2 = await cm.get_client()

            assert client1 is client2
        finally:
            await cm.close()

    async def test_recreates_if_closed(self):
        cm = ConfigManager()
        try:
            client1 = await cm.get_client()
            await client1.aclose()

            client2 = await cm.get_client()
            assert client2 is not client1
            assert not client2.is_closed
        finally:
            await cm.close()


class TestResetClient:
    async def test_closes_and_recreates(self):
        cm = ConfigManager()
        try:
            original = await cm.get_client()
            assert not original.is_closed

            await cm.reset_client()

            assert original.is_closed
            assert cm._client is not None
            assert not cm._client.is_closed
            assert cm._client is not original
        finally:
            await cm.close()

    async def test_creates_fresh_when_no_client(self):
        cm = ConfigManager()
        try:
            await cm.reset_client()

            assert cm._client is not None
            assert not cm._client.is_closed
        finally:
            await cm.close()


class TestClientContext:
    async def test_success_path(self):
        cm = ConfigManager()
        try:
            async with cm.client_context() as client:
                assert isinstance(client, httpx.AsyncClient)
                assert not client.is_closed
        finally:
            await cm.close()

    async def test_resets_on_exception(self):
        cm = ConfigManager()
        try:
            original = await cm.get_client()

            with pytest.raises(ValueError, match="test error"):
                async with cm.client_context() as client:
                    raise ValueError("test error")

            # Client should have been reset
            assert original.is_closed
            assert cm._client is not None
            assert not cm._client.is_closed
        finally:
            await cm.close()


class TestIsClientAvailable:
    def test_no_client(self):
        cm = ConfigManager()
        assert cm.is_client_available() is False

    async def test_open_client(self):
        cm = ConfigManager()
        try:
            await cm.get_client()
            assert cm.is_client_available() is True
        finally:
            await cm.close()

    async def test_closed_client(self):
        cm = ConfigManager()
        try:
            client = await cm.get_client()
            await client.aclose()
            assert cm.is_client_available() is False
        finally:
            cm._client = None  # already closed


class TestClose:
    async def test_closes_client(self):
        cm = ConfigManager()
        client = await cm.get_client()
        assert not client.is_closed

        await cm.close()

        assert client.is_closed
        assert cm._client is None

    async def test_no_error_when_no_client(self):
        cm = ConfigManager()
        await cm.close()
        assert cm._client is None

    async def test_no_error_when_already_closed(self):
        cm = ConfigManager()
        client = await cm.get_client()
        await client.aclose()

        await cm.close()
        assert cm._client is None


# ─── Health Status ────────────────────────────────────────────────────────────


class TestGetHealthStatus:
    def test_initial_state(self):
        cm = ConfigManager()
        status = cm.get_health_status()

        assert status["config_loaded"] is False
        assert status["http_client_available"] is False
        assert status["http_client_closed"] is True

    async def test_with_config_and_client(self):
        cm = ConfigManager()
        cm._config_cache = {"some": "config"}
        try:
            await cm.get_client()

            status = cm.get_health_status()

            assert status["config_loaded"] is True
            assert status["http_client_available"] is True
            assert status["http_client_closed"] is False
        finally:
            await cm.close()

    async def test_with_closed_client(self):
        cm = ConfigManager()
        client = await cm.get_client()
        await client.aclose()

        status = cm.get_health_status()

        assert status["http_client_available"] is False
        assert status["http_client_closed"] is True
        cm._client = None  # cleanup
