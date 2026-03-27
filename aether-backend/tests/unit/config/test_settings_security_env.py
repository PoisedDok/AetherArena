"""
Unit Tests: config/settings.py security env parsing helpers.

Covers strict parsing using Pydantic BaseSettings and custom field validators.
"""


from config.settings import (
    _parse_comma_list,
    _parse_json_list,
    SecuritySettings,
)

class TestCustomValidators:
    def test_parses_csv_list(self):
        parsed = _parse_comma_list("http://a, http://b ,,http://c")
        assert parsed == ["http://a", "http://b", "http://c"]

    def test_parses_json_list_as_strings(self):
        parsed = _parse_comma_list('["/health", "/docs", ""]')
        assert parsed == ["/health", "/docs"]

    def test_parses_json_list(self):
        parsed = _parse_json_list('[{"name":"default"}]')
        assert parsed == [{"name": "default"}]

class TestSecuritySettingsEnv:
    def test_builds_typed_overrides(self, monkeypatch):
        monkeypatch.setenv("SECURITY_BIND_HOST", "127.0.0.1")
        monkeypatch.setenv("SECURITY_BIND_PORT", "9000")
        monkeypatch.setenv("SECURITY_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
        monkeypatch.setenv("SECURITY_CORS_ALLOW_CREDENTIALS", "true")
        monkeypatch.setenv("SECURITY_API_KEY_REQUIRED", "1")
        monkeypatch.setenv("SECURITY_PUBLIC_PATHS", '["/health", "/docs"]')
        monkeypatch.setenv("SECURITY_ALLOW_LOCAL_OS_TOOLS", "false")
        monkeypatch.setenv("SECURITY_RATE_LIMIT_REQUESTS_PER_MINUTE", "240")
        monkeypatch.setenv("SECURITY_RATE_LIMIT_TIERS", '[{"name":"default","requests_per_window":120,"window_seconds":60.0,"strategy":"per_ip"}]')
        monkeypatch.setenv("SECURITY_RATE_LIMIT_RULES", '[{"pattern":"/v1/*","tier":"default"}]')

        settings = SecuritySettings()
        assert settings.bind_host == "127.0.0.1"
        assert settings.bind_port == 9000
        assert settings.allowed_origins == ["http://localhost:3000", "http://127.0.0.1:3000"]
        assert settings.cors_allow_credentials is True
        assert settings.api_key_required is True
        assert settings.public_paths == ["/health", "/docs"]
        assert settings.allow_local_os_tools is False
        assert settings.rate_limit_requests_per_minute == 240
        assert len(settings.rate_limit_tiers) == 1
        assert settings.rate_limit_tiers[0].name == "default"
        assert settings.rate_limit_tiers[0].requests_per_window == 120
        assert len(settings.rate_limit_rules) == 1
        assert settings.rate_limit_rules[0].pattern == "/v1/*"
        assert settings.rate_limit_rules[0].tier == "default"
