import pytest


@pytest.mark.unit
@pytest.mark.asyncio
async def test_dynamic_settings_applies_integrations_aether_rag_sources_and_interpreter_backcompat(monkeypatch):
    """
    Ensures user-configurable aether_rag_sources settings saved under the "integrations" preference
    are applied to runtime settings (GET /v1/settings via get_runtime_settings()).

    Also verifies back-compat for legacy "interpreter_settings" preference key.
    """
    from application.settings import runtime_settings_service as rss

    class FakePreferencesRepository:
        def __init__(self, _gateway):
            pass

        async def get_all_preferences(self, _user_id):
            return {
                "integrations": {
                    "aether_rag_sources": {
                        "enabled": True,
                        "index_root_dir": "/tmp/aether_rag_sources",
                        "browser_history": {
                            "enabled": True,
                            "browser": "edge",
                            "user_data_dir": "/tmp/edge-user-data",
                            "auto_find_profiles": False,
                            "max_items": 123,
                        },
                        "email": {
                            "enabled": True,
                            "source_path": "/tmp/mail.mbox",
                            "max_items": 321,
                        },
                        "slack": {
                            "enabled": True,
                            "mcp_command": "fake-mcp-command",
                            "max_messages_per_channel": 42,
                        },
                    },
                    # Unknown keys should not crash runtime settings loading.
                    "unknown_future_field": {"x": 1},
                },
                # Legacy key name (older versions wrote interpreter prefs here).
                "interpreter_settings": {
                    "loop": True,
                },
            }

    monkeypatch.setattr(rss, "PreferencesRepository", FakePreferencesRepository)

    svc = rss.RuntimeSettingsService()
    settings = await svc.get_runtime_settings(object(), "default_user")

    assert settings.interpreter.loop is True
    assert settings.integrations.aether_rag_sources.enabled is True
    assert settings.integrations.aether_rag_sources.index_root_dir == "/tmp/aether_rag_sources"

    assert settings.integrations.aether_rag_sources.browser_history.enabled is True
    assert settings.integrations.aether_rag_sources.browser_history.browser == "edge"
    assert settings.integrations.aether_rag_sources.browser_history.user_data_dir == "/tmp/edge-user-data"
    assert settings.integrations.aether_rag_sources.browser_history.auto_find_profiles is False
    assert settings.integrations.aether_rag_sources.browser_history.max_items == 123

    assert settings.integrations.aether_rag_sources.email.enabled is True
    assert settings.integrations.aether_rag_sources.email.source_path == "/tmp/mail.mbox"
    assert settings.integrations.aether_rag_sources.email.max_items == 321

    assert settings.integrations.aether_rag_sources.slack.enabled is True
    assert settings.integrations.aether_rag_sources.slack.mcp_command == "fake-mcp-command"
    assert settings.integrations.aether_rag_sources.slack.max_messages_per_channel == 42

