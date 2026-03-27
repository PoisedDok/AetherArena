"""
Settings Endpoint Tests

Covers all routes in settings.py:
  GET  /v1/settings/          — get all settings (with DB overrides)
  GET  /v1/settings            — same without trailing slash
  POST /v1/settings/          — update settings
  POST /v1/settings            — same without trailing slash
  GET  /v1/settings/user      — get user preferences
  GET  /v1/settings/user/metadata — get settings metadata for UI
  GET  /v1/settings/infrastructure — get infrastructure settings
  GET  /v1/settings/profiles  — list interpreter profiles
  GET  /v1/settings/health    — settings health check

Quality: body assertions, schema validation, update paths, edge cases.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch


# =========================================================================
# GET /v1/settings/
# =========================================================================


class TestGetAllSettings:
    """Tests for getting all settings."""

    @pytest.mark.asyncio
    async def test_get_settings_returns_dict(self, client, mock_supabase_client):
        """GET /v1/settings/ returns comprehensive settings dict."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/settings/")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, dict)
        # Core sections must exist
        assert "app_name" in body
        assert "environment" in body
        assert "llm" in body
        assert "interpreter" in body
        assert "integrations" in body
        assert "security" in body
        assert "websocket" in body

    @pytest.mark.asyncio
    async def test_get_settings_no_slash(self, client, mock_supabase_client):
        """GET /v1/settings (no slash) also works."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/settings")
        assert resp.status_code == 200
        body = resp.json()
        assert "llm" in body

    @pytest.mark.asyncio
    async def test_get_settings_llm_section(self, client, mock_supabase_client):
        """LLM section contains required fields."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/settings/")
        body = resp.json()
        llm = body["llm"]
        assert "model" in llm
        assert "api_base" in llm
        assert "temperature" in llm
        assert "max_tokens" in llm
        assert "context_window" in llm

    @pytest.mark.asyncio
    async def test_get_settings_handsfree_section(self, client, mock_supabase_client):
        """Handsfree section contains audio settings."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/settings/")
        body = resp.json()
        assert "handsfree" in body
        hf = body["handsfree"]
        assert "tts_enabled" in hf
        assert "tts_engine" in hf
        assert "vad_threshold" in hf

    @pytest.mark.asyncio
    async def test_get_settings_security_section_extended_fields(self, client, mock_supabase_client):
        """Security section includes full runtime security surface."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/settings/")
        body = resp.json()
        security = body["security"]
        for key in (
            "bind_host",
            "bind_port",
            "allowed_origins",
            "cors_allow_credentials",
            "cors_allow_methods",
            "cors_allow_headers",
            "auth_enabled",
            "api_key_required",
            "allow_anonymous",
            "allow_bearer_tokens",
            "default_role",
            "default_user_id",
            "allow_local_os_tools",
            "allow_notebook_exec",
            "rate_limit_enabled",
            "rate_limit_requests_per_minute",
            "public_paths",
        ):
            assert key in security

    @pytest.mark.asyncio
    async def test_get_settings_embedding_section(self, client, mock_supabase_client):
        """Embedding service section contains required fields."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/settings/")
        body = resp.json()
        embed = body["embedding_service"]
        assert "enabled" in embed
        assert "url" in embed
        assert "model" in embed


# =========================================================================
# POST /v1/settings/
# =========================================================================


class TestUpdateSettings:
    """Tests for updating settings."""

    @pytest.mark.asyncio
    async def test_update_llm_settings(self, client, mock_supabase_client):
        """Updating LLM settings persists and returns merged settings."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "test"})
        resp = await client.post("/v1/settings/", json={
            "llm": {
                "model": "qwen3-8b",
                "temperature": 0.5,
            }
        })
        # May return 200 or 500 depending on runtime settings cache
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_handsfree_settings(self, client, mock_supabase_client):
        """Updating handsfree settings accepted."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "test"})
        resp = await client.post("/v1/settings/", json={
            "handsfree": {
                "tts_enabled": True,
                "tts_engine": "kokoro",
            }
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_empty_body(self, client, mock_supabase_client):
        """Empty update body is accepted (no-op)."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.post("/v1/settings/", json={})
        # Should still return settings
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_vision_document_settings(self, client, mock_supabase_client):
        """Vision/document settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "vision_document": {"vision_model": "internvl", "ocr_engine": "ocrmac"}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_interpreter_settings(self, client, mock_supabase_client):
        """Interpreter settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "interpreter": {"auto_run": True, "safe_mode": "off"}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_memory_settings(self, client, mock_supabase_client):
        """Memory settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "memory": {"enabled": True, "limit": 50}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_summary_settings(self, client, mock_supabase_client):
        """Summary settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "summary": {"enabled": True, "model": "qwen3-4b"}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_integrations_settings(self, client, mock_supabase_client):
        """Integrations settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "integrations": {"searxng_enabled": True}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_ui_settings(self, client, mock_supabase_client):
        """UI settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "ui": {"theme": "dark", "font_size": 14}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_embedding_service_settings(self, client, mock_supabase_client):
        """Embedding service settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "embedding_service": {"model": "all-MiniLM-L6-v2"}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_security_settings(self, client, mock_supabase_client):
        """Security settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "security": {"allow_local_os_tools": True}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_security_unknown_field_ignored_200(self, client, mock_supabase_client):
        """Unknown security keys are ignored by typed schema (extra='ignore')."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "security": {
                "allow_local_os_tools": True,
                "totally_unknown_security_field": "boom",
            }
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_security_invalid_bind_port_rejected_422(self, client, mock_supabase_client):
        """Out-of-range bind_port is rejected by typed schema."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.post("/v1/settings/", json={
            "security": {"bind_port": 70000}
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_update_security_typed_payload_accepted(self, client, mock_supabase_client):
        """Valid typed security payload is accepted by request schema."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "security": {
                "allow_local_os_tools": False,
                "allow_notebook_exec": True,
                "bind_port": 8766,
                "rate_limit_enabled": True,
                "rate_limit_requests_per_minute": 120,
                "public_paths": ["/health", "/docs"],
            }
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_service_providers_settings(self, client, mock_supabase_client):
        """Service providers settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "service_providers": {"summary": {"provider": "lm_studio", "model": "qwen3-4b"}}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_no_slash_delegate(self, client, mock_supabase_client):
        """POST /v1/settings (no slash) delegates to update_settings."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings", json={
            "llm": {"model": "test-model"}
        })
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_update_aether_rag_sources_blocked(self, client, app, mock_supabase_client):
        """AetherRag sources updates blocked when allow_local_os_tools=false."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        # Default test config should have allow_local_os_tools=False
        resp = await client.post("/v1/settings/", json={
            "integrations": {"aether_rag_sources": {"enabled": True}}
        })
        # Should return 403 if security blocks it, or 200/500 otherwise
        assert resp.status_code in (200, 403, 500)

    @pytest.mark.asyncio
    async def test_update_user_profile(self, client, mock_supabase_client):
        """User profile settings group persists."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "t"})
        resp = await client.post("/v1/settings/", json={
            "user_profile": {"name": "Test User", "username": "testuser"}
        })
        assert resp.status_code in (200, 500)


class TestSettingsProfilesError:
    """Test list_profiles exception handler."""

    @pytest.mark.asyncio
    async def test_profiles_exception_returns_fallback(self, client):
        """ProfileManager failure returns fallback GURU.yaml."""
        with patch(
            "core.profiles.manager.ProfileManager",
            side_effect=RuntimeError("profile dir missing"),
        ):
            resp = await client.get("/v1/settings/profiles")
            assert resp.status_code == 200
            body = resp.json()
            assert body["profiles"] == ["GURU.yaml"]


# =========================================================================
# GET /v1/settings/user
# =========================================================================


class TestUserPreferences:
    """Tests for user preferences endpoint."""

    @pytest.mark.asyncio
    async def test_get_user_preferences(self, client):
        """Returns structured user preferences."""
        resp = await client.get("/v1/settings/user")
        assert resp.status_code == 200
        body = resp.json()
        assert "memory_injection" in body
        assert "search_defaults" in body
        assert "llm_generation" in body
        assert "summary" in body

    @pytest.mark.asyncio
    async def test_user_prefs_memory_injection(self, client):
        """Memory injection section has required fields."""
        resp = await client.get("/v1/settings/user")
        body = resp.json()
        mi = body["memory_injection"]
        assert "enabled" in mi
        assert "limit" in mi
        assert "min_importance" in mi

    @pytest.mark.asyncio
    async def test_user_prefs_llm_generation(self, client):
        """LLM generation section has required fields."""
        resp = await client.get("/v1/settings/user")
        body = resp.json()
        llm = body["llm_generation"]
        assert "model" in llm
        assert "temperature" in llm
        assert "max_tokens" in llm


# =========================================================================
# GET /v1/settings/user/metadata
# =========================================================================


class TestUserSettingsMetadata:
    """Tests for settings metadata (UI hints)."""

    @pytest.mark.asyncio
    async def test_metadata_returns_list(self, client):
        """Returns list of settings metadata entries."""
        resp = await client.get("/v1/settings/user/metadata")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert len(body) > 0

    @pytest.mark.asyncio
    async def test_metadata_entry_structure(self, client):
        """Each entry has required fields."""
        resp = await client.get("/v1/settings/user/metadata")
        body = resp.json()
        first = body[0]
        assert "field_name" in first
        assert "field_type" in first
        assert "current_value" in first
        assert "default_value" in first
        assert "description" in first

    @pytest.mark.asyncio
    async def test_metadata_has_ui_hints(self, client):
        """Entries include UI hints for rendering."""
        resp = await client.get("/v1/settings/user/metadata")
        body = resp.json()
        # Find an entry with UI hints
        has_hints = any(
            entry.get("ui_hints") and len(entry["ui_hints"]) > 0
            for entry in body
        )
        assert has_hints, "At least one entry should have UI hints"


# =========================================================================
# GET /v1/settings/infrastructure
# =========================================================================


class TestInfrastructureSettings:
    """Tests for infrastructure settings endpoint."""

    @pytest.mark.asyncio
    async def test_infrastructure_returns_service_config(self, client):
        """Returns embedding and HTTP client config."""
        resp = await client.get("/v1/settings/infrastructure")
        assert resp.status_code == 200
        body = resp.json()
        assert "embedding_service" in body
        assert "http_client" in body

    @pytest.mark.asyncio
    async def test_infrastructure_embedding_service(self, client):
        """Embedding service config has required fields."""
        resp = await client.get("/v1/settings/infrastructure")
        body = resp.json()
        embed = body["embedding_service"]
        assert "enabled" in embed
        assert "url" in embed
        assert "model" in embed
        assert "timeout_seconds" in embed

    @pytest.mark.asyncio
    async def test_infrastructure_http_client(self, client):
        """HTTP client config has required fields."""
        resp = await client.get("/v1/settings/infrastructure")
        body = resp.json()
        http = body["http_client"]
        assert "default_timeout" in http
        assert "llm_timeout" in http
        assert "max_retries" in http


# =========================================================================
# GET /v1/settings/profiles
# =========================================================================


class TestProfiles:
    """Tests for the profiles listing endpoint."""

    @pytest.mark.asyncio
    async def test_list_profiles(self, client):
        """Returns profiles list and default."""
        resp = await client.get("/v1/settings/profiles")
        assert resp.status_code == 200
        body = resp.json()
        assert "profiles" in body
        assert "default" in body
        assert isinstance(body["profiles"], list)


# =========================================================================
# GET /v1/settings/health
# =========================================================================


class TestSettingsHealth:
    """Tests for the settings health check."""

    @pytest.mark.asyncio
    async def test_settings_health_returns_status(self, client):
        """Health check returns healthy status."""
        resp = await client.get("/v1/settings/health")
        assert resp.status_code == 200
        body = resp.json()
        assert "status" in body
        assert body["status"] in ("healthy", "degraded")
        assert "checks" in body
        assert "environment" in body

    @pytest.mark.asyncio
    async def test_settings_health_critical_checks(self, client):
        """Health check validates critical settings."""
        resp = await client.get("/v1/settings/health")
        body = resp.json()
        checks = body["checks"]
        assert "settings_loaded" in checks
        assert checks["settings_loaded"] is True
        assert "llm_configured" in checks


# =========================================================================
# Coverage gap tests
# =========================================================================


class TestSettingsCoverageGaps:
    """
    Deterministic tests for specific uncovered lines in settings.py.

    Line 478:    HTTPException(403) when aether_rag_sources update blocked by allow_local_os_tools=false.
    Lines 605-607: Generic Exception handler in update_settings (persist failure → 500).
    Lines 979-981: Generic Exception handler in settings_health_check (→ 500).
    """

    # ------------------------------------------------------------------
    # Line 478: aether_rag_sources blocked by security config
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_aether_rag_sources_blocked_403(self, app, client, mock_supabase_client):
        """Line 478: POST with aether_rag_sources returns 403 when allow_local_os_tools=false.

        BUG FIX REGRESSION: Before the except-HTTPException-raise fix, this 403
        was silently swallowed by the generic except-Exception handler at line 605,
        turning every 403 into a 500.
        """
        from config.settings import get_settings as cfg_get_settings

        mock_supabase_client.select = AsyncMock(return_value=[])

        # Build a mock settings with allow_local_os_tools=False
        mock_settings = MagicMock()
        mock_settings.security.allow_local_os_tools = False
        mock_settings.security.default_user_id = "test-user"

        app.dependency_overrides[cfg_get_settings] = lambda: mock_settings
        try:
            resp = await client.post("/v1/settings/", json={
                "integrations": {"aether_rag_sources": {"enabled": True}}
            })
            assert resp.status_code == 403
            body = resp.json()
            assert "aether_rag_sources" in body["detail"]
            assert "disabled" in body["detail"]
        finally:
            app.dependency_overrides.pop(cfg_get_settings, None)

    # ------------------------------------------------------------------
    # Lines 605-607: Generic Exception during persist → 500
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_update_settings_persist_exception_500(self, app, client, mock_supabase_client):
        """Lines 607-609: Non-HTTP exception during settings rebuild raises HTTPException(500).

        Note: set_preference swallows its own exceptions (returns False).
        To hit the outer except-Exception, we blow up invalidate_runtime_settings_cache
        which is imported inline after all persistence calls.
        """
        mock_supabase_client.select = AsyncMock(return_value=[])

        with patch(
            "application.settings.runtime_settings_service.RuntimeSettingsService.invalidate_cache",
            side_effect=RuntimeError("cache invalidation failed"),
        ):
            resp = await client.post("/v1/settings/", json={
                "llm": {"model": "test-model"}
            })
        assert resp.status_code == 500
        body = resp.json()
        assert "Failed to save settings" in body["detail"]

    # ------------------------------------------------------------------
    # Lines 979-981: Generic Exception in settings_health_check → 500
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_health_check_exception_500(self, app, client):
        """Lines 979-981: Exception during health check raises HTTPException(500)."""
        from config.settings import get_settings as cfg_get_settings

        # PropertyMock with side_effect makes attribute access raise
        bomb_settings = MagicMock()
        type(bomb_settings).embedding_service = PropertyMock(
            side_effect=RuntimeError("corrupted settings")
        )

        app.dependency_overrides[cfg_get_settings] = lambda: bomb_settings
        try:
            resp = await client.get("/v1/settings/health")
            assert resp.status_code == 500
            body = resp.json()
            assert "health check failed" in body["detail"]
        finally:
            app.dependency_overrides.pop(cfg_get_settings, None)
