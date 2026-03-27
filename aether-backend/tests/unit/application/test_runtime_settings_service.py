"""
Unit Tests: RuntimeSettingsService (application/settings/runtime_settings_service.py)

Comprehensive coverage of runtime settings loading, caching, invalidation,
and all 12 preference override categories.

Mock boundaries:
- config.settings.get_settings → returns controlled Settings() instance (local import inside _load)
- PreferencesRepository → mock constructor + get_all_preferences (AsyncMock)
- _apply_integrations_overrides → mock (tested separately in config/dynamic_settings)
"""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from application.settings.runtime_settings_service import (RuntimeSettingsService,
    _should_apply_str_pref,
)
from config.settings import (
    APIKeySettings,
    Settings,
    ErrorHandlingSettings,
    ComputerAPISettings,
    ContextRetrievalSettings,
    RateLimitRuleSettings,
    RateLimitTierSettings,
    ServiceProviderConfig,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _make_mock_repo(all_prefs: Dict[str, Any] | None = None) -> MagicMock:
    """Create a mock PreferencesRepository with controllable get_all_preferences."""
    repo = MagicMock()
    repo.get_all_preferences = AsyncMock(return_value=all_prefs if all_prefs is not None else {})
    return repo


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def gateway():
    """Mock gateway passed to runtime_settings_service functions."""
    return MagicMock()


@pytest.fixture
def base_settings():
    """Fresh Settings instance with defaults for each test."""
    return Settings()


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: invalidate_runtime_settings_cache
# ═══════════════════════════════════════════════════════════════════════════════

class TestInvalidateCache:
    def test_increments_version(self):
        service = RuntimeSettingsService()
        assert service._cache_version == 0
        service.invalidate_cache()
        assert service._cache_version == 1
        service.invalidate_cache()
        assert service._cache_version == 2

    def test_clears_cache_entries(self):
        service = RuntimeSettingsService()
        service._cache[(0, 123, "user1")] = MagicMock()
        service._cache[(0, 456, "user2")] = MagicMock()
        assert len(service._cache) == 2
        service.invalidate_cache()
        assert len(service._cache) == 0

    def test_increments_and_clears_atomically(self):
        service = RuntimeSettingsService()
        service._cache[(0, 99, "u")] = MagicMock()
        service.invalidate_cache()
        assert service._cache_version == 1
        assert len(service._cache) == 0


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: get_runtime_settings (SYNC entrypoint)
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetRuntimeSettingsSync:
    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_returns_settings_on_empty_prefs(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        result = await service.get_runtime_settings(gateway, "user1")
        assert isinstance(result, Settings)
        repo.get_all_preferences.assert_awaited_once_with("user1")

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_cache_hit_returns_cached(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        r1 = await service.get_runtime_settings(gateway, "user1")
        r2 = await service.get_runtime_settings(gateway, "user1")
        assert r1 is r2
        # Only one DB call (second is cache hit)
        assert repo.get_all_preferences.await_count == 1

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_force_refresh_bypasses_cache(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        await service.get_runtime_settings(gateway, "user1")
        await service.get_runtime_settings(gateway, "user1", force_refresh=True)
        assert repo.get_all_preferences.await_count == 2

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_empty_user_id_resolves_to_default(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        await service.get_runtime_settings(gateway, "")
        repo.get_all_preferences.assert_awaited_once_with("default_user")

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_none_user_id_resolves_to_default(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        await service.get_runtime_settings(gateway, None)
        repo.get_all_preferences.assert_awaited_once_with("default_user")

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_whitespace_user_id_resolves_to_default(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        await service.get_runtime_settings(gateway, "   ")
        repo.get_all_preferences.assert_awaited_once_with("default_user")

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_stores_result_in_cache(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        MockRepo.return_value = _make_mock_repo({})

        result = await service.get_runtime_settings(gateway, "user1")
        # Verify cache was populated
        assert len(service._cache) == 1
        cached = list(service._cache.values())[0]
        assert cached is result


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: get_runtime_settings (ASYNC entrypoint)
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetRuntimeSettingsAsync:
    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_returns_settings(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        MockRepo.return_value = _make_mock_repo({})

        result = await service.get_runtime_settings(gateway, "user1")
        assert isinstance(result, Settings)

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_cache_hit(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        r1 = await service.get_runtime_settings(gateway, "user1")
        r2 = await service.get_runtime_settings(gateway, "user1")
        assert r1 is r2
        assert repo.get_all_preferences.await_count == 1

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_force_refresh(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        await service.get_runtime_settings(gateway, "user1")
        await service.get_runtime_settings(gateway, "user1", force_refresh=True)
        assert repo.get_all_preferences.await_count == 2

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_empty_user_id(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        await service.get_runtime_settings(gateway, "")
        repo.get_all_preferences.assert_awaited_once_with("default_user")

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_none_user_id(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        await service.get_runtime_settings(gateway, None)
        repo.get_all_preferences.assert_awaited_once_with("default_user")

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_different_gateway_different_cache_key(self, MockRepo, mock_get_settings, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        gw1, gw2 = MagicMock(), MagicMock()
        await service.get_runtime_settings(gw1, "user1")
        await service.get_runtime_settings(gw2, "user1")
        # Different gateways → different cache keys → both load
        assert repo.get_all_preferences.await_count == 2

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_invalidation_busts_cache(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        repo = _make_mock_repo({})
        MockRepo.return_value = repo

        await service.get_runtime_settings(gateway, "user1")
        service.invalidate_cache()
        await service.get_runtime_settings(gateway, "user1")
        # Invalidation changed version → old cache key misses → reload
        assert repo.get_all_preferences.await_count == 2

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_stores_result_in_cache(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        MockRepo.return_value = _make_mock_repo({})

        result = await service.get_runtime_settings(gateway, "user1")
        assert len(service._cache) == 1
        assert list(service._cache.values())[0] is result


# ═══════════════════════════════════════════════════════════════════════════════
# Tests: _load_runtime_settings_async (core preference merging)
# ═══════════════════════════════════════════════════════════════════════════════

class TestLoadNoPrefs:
    """No preferences → return base settings unchanged."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_empty_prefs_returns_base(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        MockRepo.return_value = _make_mock_repo({})

        result = await service._load_runtime_settings_async(gateway, "user1")
        assert result is base_settings

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_none_value_prefs_returns_base(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """get_all_preferences returns empty dict (falsy) → early return."""
        mock_get_settings.return_value = base_settings
        repo = MagicMock()
        repo.get_all_preferences = AsyncMock(return_value=None)
        MockRepo.return_value = repo

        result = await service._load_runtime_settings_async(gateway, "user1")
        assert result is base_settings


class TestLLMOverride:
    """Category 1: llm_settings."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_full_override(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "llm_settings": {
                "provider": "openai-compatible",
                "api_base": "http://custom:1234/v1",
                "api_key": "sk-test",
                "model": "gpt-4",
                "max_tokens": 8192,
                "context_window": 128000,
                "supports_vision": False,
                "supports_functions": True,
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.llm.provider == "openai-compatible"
        assert result.llm.api_base == "http://custom:1234/v1"
        assert result.llm.api_key == "sk-test"
        assert result.llm.model == "gpt-4"
        assert result.llm.max_tokens == 8192
        assert result.llm.context_window == 128000
        assert result.llm.supports_vision is False
        assert result.llm.supports_functions is True

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_partial_override_preserves_defaults(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        original_api_key = base_settings.llm.api_key
        original_provider = base_settings.llm.provider
        prefs = {"llm_settings": {"model": "gpt-3.5-turbo"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.llm.model == "gpt-3.5-turbo"
        assert result.llm.api_key == original_api_key
        assert result.llm.provider == original_provider


class TestErrorHandlingOverride:
    """Category 2: error_handling (top-level key)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_override_applied(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "error_handling": {
                "enabled": False,
                "show_technical_details": False,
                "context_length_message": "Custom: context too long",
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.error_handling.enabled is False
        assert result.interpreter.error_handling.show_technical_details is False
        assert result.interpreter.error_handling.context_length_message == "Custom: context too long"
        # Unset fields keep defaults
        assert result.interpreter.error_handling.show_suggestions is True

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_all_error_messages_overridden(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "error_handling": {
                "authentication_message": "Auth fail",
                "rate_limit_message": "Rate limit",
                "connection_message": "Connection lost",
                "model_error_message": "Model error",
                "invalid_request_message": "Bad request",
                "unknown_error_message": "Unknown",
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        eh = result.interpreter.error_handling
        assert eh.authentication_message == "Auth fail"
        assert eh.rate_limit_message == "Rate limit"
        assert eh.connection_message == "Connection lost"
        assert eh.model_error_message == "Model error"
        assert eh.invalid_request_message == "Bad request"
        assert eh.unknown_error_message == "Unknown"


class TestVisionDocumentOverride:
    """Category 3: vision_document (setattr loop)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_known_key_applied(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"vision_document": {"ocr_engine": "tesseract", "max_tokens": 1024}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.vision_document.ocr_engine == "tesseract"
        assert result.vision_document.max_tokens == 1024

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_unknown_key_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"vision_document": {"nonexistent_key_xyz": "value"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert not hasattr(result.vision_document, "nonexistent_key_xyz")


class TestHandsfreeOverride:
    """Category 4: handsfree (complex key-by-key mapping)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_stt_model_gets_openai_prefix(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"stt_model": "whisper-large-v3"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.stt.model_id == "openai/whisper-large-v3"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_stt_model_already_prefixed_no_double(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"stt_model": "openai/whisper-small"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.stt.model_id == "openai/whisper-small"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_stt_model_empty_string_no_prefix(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """Empty string is falsy → prefix condition short-circuits."""
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"stt_model": ""}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.stt.model_id == ""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_stt_model_none_no_prefix(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """None fails isinstance(stt_model, str) → no prefix."""
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"stt_model": None}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.stt.model_id is None

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_stt_language(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"stt_language": "fr"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.stt.language == "fr"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_wake_word_model(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"wake_word_model": "alexa"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.wake_word.model_name == "alexa"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_wake_word_threshold(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"wake_word_threshold": 0.8}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.wake_word.threshold == 0.8

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_conversation_timeout(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"conversation_timeout": 120}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.handsfree.conversation_timeout_seconds == 120.0

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_vad_threshold(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"vad_threshold": 0.7}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.vad.threshold == 0.7

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_interruption_threshold(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"interruption_threshold": 0.05}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.handsfree.interruption_threshold == 0.05

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_interruption_cooldown(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"interruption_cooldown": 2000}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.handsfree.interruption_cooldown_ms == 2000

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_auto_loop(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"auto_loop": False}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.handsfree.auto_loop is False

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_tts_engine(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"tts_engine": "edge"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.tts.engine == "edge"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_tts_voice(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"tts_voice": "af_heart"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.tts.voice == "af_heart"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_tts_speed(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"tts_speed": "1.5"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.tts.speed == 1.5

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_tts_language(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"handsfree": {"tts_language": "chinese"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.tts.qwen3_language == "chinese"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_all_handsfree_fields_combined(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "handsfree": {
                "stt_model": "whisper-medium",
                "stt_language": "de",
                "wake_word_model": "hey_mycroft",
                "wake_word_threshold": 0.6,
                "conversation_timeout": 60,
                "vad_threshold": 0.4,
                "interruption_threshold": 0.02,
                "interruption_cooldown": 1500,
                "auto_loop": False,
                "tts_engine": "kokoro",
                "tts_voice": "af_sky",
                "tts_speed": "0.8",
                "tts_language": "english",
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.audio.stt.model_id == "openai/whisper-medium"
        assert result.audio.stt.language == "de"
        assert result.audio.wake_word.model_name == "hey_mycroft"
        assert result.audio.wake_word.threshold == 0.6
        assert result.audio.handsfree.conversation_timeout_seconds == 60.0
        assert result.audio.vad.threshold == 0.4
        assert result.audio.handsfree.interruption_threshold == 0.02
        assert result.audio.handsfree.interruption_cooldown_ms == 1500
        assert result.audio.handsfree.auto_loop is False
        assert result.audio.tts.engine == "kokoro"
        assert result.audio.tts.voice == "af_sky"
        assert result.audio.tts.speed == 0.8
        assert result.audio.tts.qwen3_language == "english"


class TestMemoryOverride:
    """Category 5: memory (setattr loop on memory_service)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_known_attribute_applied(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"memory": {"global_injection_enabled": False, "global_injection_limit": 5}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.memory_service.global_injection_enabled is False
        assert result.memory_service.global_injection_limit == 5

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_unknown_attribute_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"memory": {"totally_fake_memory_field_xyz": 999}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert not hasattr(result.memory_service, "totally_fake_memory_field_xyz")


class TestSummaryOverride:
    """Category 6: summary (setattr loop on summary_service)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_known_attribute_applied(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"summary": {"auto_summarize": True, "temperature": 0.9}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.summary_service.auto_summarize is True
        assert result.summary_service.temperature == 0.9

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_unknown_attribute_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"summary": {"fake_summary_field_xyz": True}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert not hasattr(result.summary_service, "fake_summary_field_xyz")


class TestUIOverride:
    """Category 7: ui (setattr loop on ui)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_known_attribute_applied(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"ui": {"widget_size": 500, "effects_mode": "reduced"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.ui.widget_size == 500
        assert result.ui.effects_mode == "reduced"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_unknown_attribute_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"ui": {"fake_ui_field_xyz": "dark"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert not hasattr(result.ui, "fake_ui_field_xyz")


class TestInterpreterOverride:
    """Category 8: interpreter (complex nested model handling)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_computer_dict_override(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "interpreter": {
                "computer": {
                    "import_computer_api": False,
                    "import_skills": False,
                    "skills_path": "/custom/skills",
                }
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.computer.import_computer_api is False
        assert result.interpreter.computer.import_skills is False
        assert result.interpreter.computer.skills_path == "/custom/skills"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_error_handling_dict_override(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "interpreter": {
                "error_handling": {
                    "enabled": False,
                    "unknown_error_message": "Custom unknown error",
                }
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.error_handling.enabled is False
        assert result.interpreter.error_handling.unknown_error_message == "Custom unknown error"
        # Unset fields preserve defaults
        assert result.interpreter.error_handling.show_suggestions is True

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_context_retrieval_dict_override(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "interpreter": {
                "context_retrieval": {
                    "enabled": False,
                    "max_total_results": 10,
                    "min_score": 0.5,
                }
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.context_retrieval.enabled is False
        assert result.interpreter.context_retrieval.max_total_results == 10
        assert result.interpreter.context_retrieval.min_score == 0.5
        # Defaults preserved for unset fields
        assert result.interpreter.context_retrieval.default_top_k == 10

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_scalar_override(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"interpreter": {"auto_run": True, "loop": True}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.auto_run is True
        assert result.interpreter.loop is True

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_system_message_nonempty_overrides(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        base_settings.interpreter.system_message = "Original GURU message"
        prefs = {"interpreter": {"system_message": "Custom system prompt."}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.system_message == "Custom system prompt."

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_system_message_empty_keeps_base(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        base_settings.interpreter.system_message = "GURU system message"
        prefs = {"interpreter": {"system_message": ""}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.system_message == "GURU system message"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_system_message_whitespace_keeps_base(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        base_settings.interpreter.system_message = "GURU system message"
        prefs = {"interpreter": {"system_message": "   "}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.system_message == "GURU system message"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_system_message_none_keeps_base(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        base_settings.interpreter.system_message = "GURU system message"
        prefs = {"interpreter": {"system_message": None}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.system_message == "GURU system message"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_nested_model_as_non_dict_scalar_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """Setting computer/error_handling/context_retrieval as non-dict scalar is ignored."""
        mock_get_settings.return_value = base_settings
        prefs = {"interpreter": {"computer": "not-a-dict"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        # Falls through to hasattr+isinstance check which catches ComputerAPISettings → skip
        assert isinstance(result.interpreter.computer, ComputerAPISettings)

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_error_handling_as_non_dict_scalar_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"interpreter": {"error_handling": "string-value"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert isinstance(result.interpreter.error_handling, ErrorHandlingSettings)

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_context_retrieval_as_non_dict_scalar_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"interpreter": {"context_retrieval": 42}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert isinstance(result.interpreter.context_retrieval, ContextRetrievalSettings)

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_interpreter_settings_back_compat(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """interpreter_settings key works as alias for interpreter (back-compat)."""
        mock_get_settings.return_value = base_settings
        prefs = {"interpreter_settings": {"auto_run": True}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.auto_run is True

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_interpreter_key_takes_priority_over_alias(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """If both interpreter and interpreter_settings present, interpreter wins (or operator)."""
        mock_get_settings.return_value = base_settings
        prefs = {
            "interpreter": {"auto_run": True},
            "interpreter_settings": {"auto_run": False},  # this is ignored because 'or' short-circuits
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.auto_run is True

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_unknown_interpreter_attribute_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"interpreter": {"totally_unknown_field_xyz": 42}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert not hasattr(result.interpreter, "totally_unknown_field_xyz")


class TestIntegrationsOverride:
    """Category 9: integrations (delegates to _apply_integrations_overrides)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    @patch("application.settings.runtime_settings_service._apply_integrations_overrides")
    async def test_delegates_to_apply_function(self, mock_apply, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"integrations": {"perplexica_enabled": False}}
        MockRepo.return_value = _make_mock_repo(prefs)

        await service._load_runtime_settings_async(gateway, "u")
        mock_apply.assert_called_once_with(base_settings, {"perplexica_enabled": False})

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    @patch("application.settings.runtime_settings_service._apply_integrations_overrides")
    async def test_not_called_when_absent(self, mock_apply, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"llm_settings": {"model": "x"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        await service._load_runtime_settings_async(gateway, "u")
        mock_apply.assert_not_called()


class TestSecurityOverride:
    """Category 10: security (typed nested/security settings merge)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_scalar_security_fields_applied(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "security": {
                "allow_local_os_tools": False,
                "allow_notebook_exec": True,
                "rate_limit_enabled": True,
                "rate_limit_requests_per_minute": 1234,
                "bind_port": 6001,
                "default_role": "admin",
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.security.allow_local_os_tools is False
        assert result.security.allow_notebook_exec is True
        assert result.security.rate_limit_enabled is True
        assert result.security.rate_limit_requests_per_minute == 1234
        assert result.security.bind_port == 6001
        assert result.security.default_role == "admin"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_empty_string_security_field_preserves_default(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        original_default_user_id = base_settings.security.default_user_id
        prefs = {"security": {"default_user_id": ""}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.security.default_user_id == original_default_user_id

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_static_api_keys_parsed_as_typed_models(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "security": {
                "static_api_keys": [
                    {"key": "k1", "user_id": "svc-a", "role": "admin"},
                    {"key": "k2"},
                    "invalid-entry",
                    {"not_key": "missing-required-field"},
                ]
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert len(result.security.static_api_keys) == 2
        assert all(isinstance(item, APIKeySettings) for item in result.security.static_api_keys)
        assert result.security.static_api_keys[0].key == "k1"
        assert result.security.static_api_keys[0].user_id == "svc-a"
        assert result.security.static_api_keys[0].role == "admin"
        assert result.security.static_api_keys[1].key == "k2"
        assert result.security.static_api_keys[1].user_id == "service"
        assert result.security.static_api_keys[1].role == "user"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_rate_limit_tiers_and_rules_parsed_as_typed_models(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "security": {
                "rate_limit_tiers": [
                    {"name": "default", "requests_per_window": 100, "window_seconds": 60},
                    {"name": "burst", "requests_per_window": 20, "window_seconds": 10, "burst_size": 10},
                    {"requests_per_window": 1},  # invalid: missing required name
                ],
                "rate_limit_rules": [
                    {"pattern": "/v1/search*", "tier": "default"},
                    {"pattern": "/v1/admin*", "tier": "burst"},
                    {"pattern": "/v1/bad*"},  # invalid: missing required tier
                ],
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert len(result.security.rate_limit_tiers) == 2
        assert all(isinstance(item, RateLimitTierSettings) for item in result.security.rate_limit_tiers)
        assert result.security.rate_limit_tiers[0].name == "default"
        assert result.security.rate_limit_tiers[1].name == "burst"
        assert len(result.security.rate_limit_rules) == 2
        assert all(isinstance(item, RateLimitRuleSettings) for item in result.security.rate_limit_rules)
        assert result.security.rate_limit_rules[0].pattern == "/v1/search*"
        assert result.security.rate_limit_rules[0].tier == "default"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_non_list_security_structured_fields_are_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        base_settings.security.static_api_keys = [APIKeySettings(key="preserve-me")]
        base_settings.security.rate_limit_tiers = [RateLimitTierSettings(name="base-tier")]
        base_settings.security.rate_limit_rules = [RateLimitRuleSettings(pattern="/", tier="base-tier")]
        prefs = {
            "security": {
                "static_api_keys": {"key": "invalid-type"},
                "rate_limit_tiers": "invalid-type",
                "rate_limit_rules": 123,
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert len(result.security.static_api_keys) == 1
        assert result.security.static_api_keys[0].key == "preserve-me"
        assert len(result.security.rate_limit_tiers) == 1
        assert result.security.rate_limit_tiers[0].name == "base-tier"
        assert len(result.security.rate_limit_rules) == 1
        assert result.security.rate_limit_rules[0].tier == "base-tier"


class TestEmbeddingServiceOverride:
    """Category 11: embedding_service (setattr loop)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_known_attribute_applied(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"embedding_service": {"model": "custom-embed-model", "dimensions": 512}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.embedding_service.model == "custom-embed-model"
        assert result.embedding_service.dimensions == 512

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_unknown_attribute_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"embedding_service": {"nonexistent_embed_field_xyz": 42}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert not hasattr(result.embedding_service, "nonexistent_embed_field_xyz")


class TestServiceProvidersOverride:
    """Category 12: service_providers (per-service ServiceProviderConfig)."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_summary_provider(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "service_providers": {
                "summary": {
                    "provider": "openai-compatible",
                    "api_base": "http://lmstudio:1234/v1",
                    "model": "llama-3",
                    "api_key": "sk-custom",
                }
            }
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        spc = result.summary_service.provider_config
        assert isinstance(spc, ServiceProviderConfig)
        assert spc.provider == "openai-compatible"
        assert spc.api_base == "http://lmstudio:1234/v1"
        assert spc.model == "llama-3"
        assert spc.api_key == "sk-custom"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_query_generation_provider(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"service_providers": {"query_generation": {"provider": "ollama", "model": "qwen"}}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        spc = result.proactive.query_generation.provider_config
        assert spc.provider == "ollama"
        assert spc.model == "qwen"


    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_vision_ocr_provider(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"service_providers": {"vision_ocr": {"provider": "openai-compatible", "model": "gpt-4-vision"}}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.vision_document.provider_config.model == "gpt-4-vision"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_research_provider(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"service_providers": {"research": {"api_base": "http://custom:5000"}}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.research_service.provider_config.api_base == "http://custom:5000"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_non_dict_value_for_service_skipped(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"service_providers": {"summary": "not-a-dict"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        # summary provider_config should remain default (not overwritten)
        assert result.summary_service.provider_config.provider == ""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_non_dict_container_skipped(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"service_providers": "not-a-dict"}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        # No crash, defaults preserved
        assert isinstance(result.summary_service.provider_config, ServiceProviderConfig)

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_unknown_service_key_ignored(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"service_providers": {"unknown_service_xyz": {"provider": "ollama"}}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert isinstance(result, Settings)

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_missing_keys_use_defaults(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {"service_providers": {"summary": {"provider": "ollama"}}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        spc = result.summary_service.provider_config
        assert spc.provider == "ollama"
        assert spc.api_base == ""
        assert spc.model == ""
        assert spc.api_key == "not-needed"


class TestShouldApplyStrPref:
    """Unit tests for the _should_apply_str_pref guard function."""

    def test_non_string_base_allows_any(self):
        service = RuntimeSettingsService()
        """Non-string base (bool, int, None) → always allow override."""
        assert _should_apply_str_pref(True, False) is True
        assert _should_apply_str_pref(42, 0) is True
        assert _should_apply_str_pref(None, "anything") is True
        assert _should_apply_str_pref(3.14, "") is True

    def test_empty_base_allows_any(self):
        service = RuntimeSettingsService()
        """Empty string base → allow any override (no meaningful default to protect)."""
        assert _should_apply_str_pref("", "value") is True
        assert _should_apply_str_pref("", "") is True
        assert _should_apply_str_pref("", None) is True

    def test_nonempty_base_accepts_nonempty_string(self):
        service = RuntimeSettingsService()
        """Non-empty base + non-empty new string → allow override."""
        assert _should_apply_str_pref("supabase", "pgvector") is True
        assert _should_apply_str_pref("GURU.yaml", "custom.py") is True

    def test_nonempty_base_rejects_empty_string(self):
        service = RuntimeSettingsService()
        """Non-empty base + empty string → reject (stale DB preference)."""
        assert _should_apply_str_pref("supabase", "") is False

    def test_nonempty_base_rejects_whitespace_string(self):
        service = RuntimeSettingsService()
        """Non-empty base + whitespace-only → reject."""
        assert _should_apply_str_pref("supabase", "   ") is False

    def test_nonempty_base_rejects_none(self):
        service = RuntimeSettingsService()
        """Non-empty base + None → reject (corrupt DB value)."""
        assert _should_apply_str_pref("supabase", None) is False

    def test_nonempty_base_rejects_non_string(self):
        service = RuntimeSettingsService()
        """Non-empty base + non-string → reject."""
        assert _should_apply_str_pref("supabase", 42) is False
        assert _should_apply_str_pref("GURU.yaml", True) is False


class TestEmptyStringGuards:
    """Verify empty-string DB preferences don't clobber valid defaults."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_empty_memory_type_preserves_default(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """memory.type="" from DB must not override the config default."""
        mock_get_settings.return_value = base_settings
        original_type = base_settings.memory.type
        assert original_type  # config default is non-empty
        prefs = {"memory": {"type": "", "enabled": False}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        # Type preserved (empty string rejected), but enabled was applied (bool → allowed)
        assert result.memory.type == original_type
        assert result.memory.enabled is False

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_valid_memory_type_override_applied(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """Non-empty memory.type from DB should override the default."""
        mock_get_settings.return_value = base_settings
        prefs = {"memory": {"type": "pgvector"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.memory.type == "pgvector"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_empty_interpreter_profile_preserves_default(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """interpreter.profile="" from DB must not override the config default."""
        mock_get_settings.return_value = base_settings
        original_profile = base_settings.interpreter.profile
        assert original_profile  # config default is non-empty
        prefs = {"interpreter": {"profile": "", "auto_run": True}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        # Profile preserved (empty string rejected), but auto_run applied (bool → allowed)
        assert result.interpreter.profile == original_profile
        assert result.interpreter.auto_run is True

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_valid_interpreter_profile_override_applied(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """Non-empty interpreter.profile from DB should override the default."""
        mock_get_settings.return_value = base_settings
        prefs = {"interpreter": {"profile": "custom_profile.py"}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.interpreter.profile == "custom_profile.py"

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_none_memory_type_preserves_default(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """memory.type=None from DB must not override the config default."""
        mock_get_settings.return_value = base_settings
        original_type = base_settings.memory.type
        prefs = {"memory": {"type": None}}
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.memory.type == original_type

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    async def test_empty_ui_string_preserves_default(self, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        """Empty string for UI string fields should not clobber non-empty defaults."""
        mock_get_settings.return_value = base_settings
        original_effects = base_settings.ui.effects_mode
        # effects_mode has a non-empty default (e.g. "full")
        if original_effects:
            prefs = {"ui": {"effects_mode": ""}}
            MockRepo.return_value = _make_mock_repo(prefs)

            result = await service._load_runtime_settings_async(gateway, "u")
            assert result.ui.effects_mode == original_effects


class TestAllCategoriesCombined:
    """Integration: all 12 categories applied in a single call."""

    @patch("config.settings.get_settings")
    @patch("application.settings.runtime_settings_service.PreferencesRepository")
    @patch("application.settings.runtime_settings_service._apply_integrations_overrides")
    async def test_all_categories(self, mock_apply, MockRepo, mock_get_settings, gateway, base_settings):
        service = RuntimeSettingsService()
        service = RuntimeSettingsService()
        mock_get_settings.return_value = base_settings
        prefs = {
            "llm_settings": {"model": "combo-model"},
            "error_handling": {"enabled": False},
            "vision_document": {"ocr_engine": "tesseract"},
            "handsfree": {"stt_model": "whisper-tiny", "tts_engine": "gtts"},
            "memory": {"global_injection_enabled": False},
            "summary": {"auto_summarize": True},
            "ui": {"widget_size": 400},
            "interpreter": {"system_message": "Custom GURU", "auto_run": True},
            "integrations": {"perplexica_enabled": True},
            "security": {"allow_local_os_tools": False},
            "embedding_service": {"model": "custom-embed"},
            "service_providers": {"summary": {"provider": "ollama"}},
        }
        MockRepo.return_value = _make_mock_repo(prefs)

        result = await service._load_runtime_settings_async(gateway, "u")
        assert result.llm.model == "combo-model"
        assert result.interpreter.error_handling.enabled is False
        assert result.vision_document.ocr_engine == "tesseract"
        assert result.audio.stt.model_id == "openai/whisper-tiny"
        assert result.audio.tts.engine == "gtts"
        assert result.memory_service.global_injection_enabled is False
        assert result.summary_service.auto_summarize is True
        assert result.ui.widget_size == 400
        assert result.interpreter.system_message == "Custom GURU"
        assert result.interpreter.auto_run is True
        mock_apply.assert_called_once()
        assert result.security.allow_local_os_tools is False
        assert result.embedding_service.model == "custom-embed"
        assert result.summary_service.provider_config.provider == "ollama"
