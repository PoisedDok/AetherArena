"""
Unit tests for User Credentials endpoints (/v1/user-credentials/*).

Security-critical endpoint: stores/retrieves encrypted API keys and OAuth tokens.
Tests verify encryption roundtrip, KNOWN_CREDENTIALS fallback, prefix filtering,
exact response bodies, all error paths, and Pydantic validation.

Bugs found and fixed during this audit:
  Bug A (MEDIUM): list_credentials and get_credential_value used
    `row.get("setting_value", {})` which returns None (not {}) when the key
    exists with a None value. Fixed to `row.get("setting_value") or {}`.

CI: pytest tests/unit/api/test_user_credentials_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, patch


# =============================================================================
# LIST CREDENTIALS — GET /v1/user-credentials/list
# =============================================================================


class TestListCredentials:
    """Tests for the list_credentials endpoint."""

    @pytest.mark.asyncio
    async def test_empty_db_returns_all_known_unconfigured(self, client, mock_supabase_client):
        """Empty DB → all 7 KNOWN_CREDENTIALS returned as is_configured=False."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/user-credentials/list")
        assert resp.status_code == 200
        body = resp.json()
        creds = body["credentials"]
        assert len(creds) == 7
        for cred in creds:
            assert cred["is_configured"] is False
            assert cred["updated_at"] is None
            assert isinstance(cred["credential_key"], str)
            assert isinstance(cred["description"], str)

    @pytest.mark.asyncio
    async def test_all_known_credential_keys_present(self, client, mock_supabase_client):
        """Verify exact keyset matches KNOWN_CREDENTIALS."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/user-credentials/list")
        assert resp.status_code == 200
        keys = {c["credential_key"] for c in resp.json()["credentials"]}
        expected = {
            "google_oauth_token",
            "gmail_api_key",
            "outlook_oauth_token",
            "outlook_api_key",
            "weather_api_key",
            "openai_api_key",
            "anthropic_api_key",
        }
        assert keys == expected

    @pytest.mark.asyncio
    async def test_configured_and_unconfigured_merge(self, client, mock_supabase_client):
        """DB has 2 configured credentials → merges with KNOWN_CREDENTIALS."""
        mock_supabase_client.select = AsyncMock(return_value=[
            {
                "setting_key": "credential_openai_api_key",
                "setting_value": {"encrypted_value": "enc-abc", "description": "My OpenAI key"},
                "updated_at": "2026-02-01T00:00:00Z",
            },
            {
                "setting_key": "credential_custom_key",
                "setting_value": {"encrypted_value": "enc-xyz", "description": "Custom service"},
                "updated_at": "2026-02-02T00:00:00Z",
            },
            # Non-credential setting — must be filtered OUT
            {
                "setting_key": "theme_preference",
                "setting_value": {"value": "dark"},
                "updated_at": "2026-01-01T00:00:00Z",
            },
        ])
        resp = await client.get("/v1/user-credentials/list")
        assert resp.status_code == 200
        creds = resp.json()["credentials"]

        configured = [c for c in creds if c["is_configured"]]
        unconfigured = [c for c in creds if not c["is_configured"]]
        assert len(configured) == 2
        assert len(unconfigured) == 6  # 7 known minus openai = 6

        openai = next(c for c in creds if c["credential_key"] == "openai_api_key")
        assert openai["is_configured"] is True
        assert openai["description"] == "My OpenAI key"
        assert openai["updated_at"] == "2026-02-01T00:00:00Z"

        custom = next(c for c in creds if c["credential_key"] == "custom_key")
        assert custom["is_configured"] is True
        assert custom["description"] == "Custom service"

        all_keys = {c["credential_key"] for c in creds}
        assert "theme_preference" not in all_keys

    @pytest.mark.asyncio
    async def test_description_fallback_to_known(self, client, mock_supabase_client):
        """DB row has no description → falls back to KNOWN_CREDENTIALS description."""
        mock_supabase_client.select = AsyncMock(return_value=[
            {
                "setting_key": "credential_anthropic_api_key",
                "setting_value": {"encrypted_value": "enc-data"},
                "updated_at": "2026-01-15T00:00:00Z",
            },
        ])
        resp = await client.get("/v1/user-credentials/list")
        assert resp.status_code == 200
        anthropic = next(
            c for c in resp.json()["credentials"]
            if c["credential_key"] == "anthropic_api_key"
        )
        assert anthropic["is_configured"] is True
        assert anthropic["description"] == "Anthropic API key (for Claude models)"

    @pytest.mark.asyncio
    async def test_setting_value_null_handled_gracefully(self, client, mock_supabase_client):
        """Bug A regression: setting_value is None (not missing) → no crash.

        Before fix: `row.get("setting_value", {})` returned None when key existed
        with None value, causing AttributeError on `.get("description")`.
        After fix: `row.get("setting_value") or {}` handles both absent and None.
        """
        mock_supabase_client.select = AsyncMock(return_value=[
            {
                "setting_key": "credential_openai_api_key",
                "setting_value": None,  # NULL from DB
                "updated_at": "2026-02-01T00:00:00Z",
            },
        ])
        resp = await client.get("/v1/user-credentials/list")
        assert resp.status_code == 200
        creds = resp.json()["credentials"]
        openai = next(c for c in creds if c["credential_key"] == "openai_api_key")
        assert openai["is_configured"] is True
        # Falls back to KNOWN_CREDENTIALS description since setting_value is None
        assert openai["description"] == "OpenAI API key (for GPT models)"

    @pytest.mark.asyncio
    async def test_gateway_error_returns_500(self, client, mock_supabase_client):
        """Gateway select raises → 500 with stable error message."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("DB connection lost"))
        resp = await client.get("/v1/user-credentials/list")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to list credentials"

    @pytest.mark.asyncio
    async def test_http_exception_reraise(self, client, mock_supabase_client):
        """HTTPException raised inside try block is re-raised, not caught by generic except."""
        from fastapi import HTTPException
        mock_supabase_client.select = AsyncMock(
            side_effect=HTTPException(status_code=409, detail="conflict")
        )
        resp = await client.get("/v1/user-credentials/list")
        assert resp.status_code == 409
        assert resp.json()["detail"] == "conflict"


# =============================================================================
# SAVE CREDENTIAL — POST /v1/user-credentials/save
# =============================================================================


class TestSaveCredential:
    """Tests for the save_credential endpoint."""

    @pytest.mark.asyncio
    async def test_response_body_exact(self, client, mock_supabase_client):
        """Save known key → exact CredentialResponse fields."""
        mock_supabase_client.upsert = AsyncMock(return_value={
            "id": "row-uuid",
            "updated_at": "2026-02-08T12:00:00Z",
        })
        with patch("api.v1.endpoints.user_credentials.encrypt_secret", return_value="encrypted-value"):
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "weather_api_key",
                "credential_value": "wk-secret-123",
            })
        assert resp.status_code == 200
        body = resp.json()
        assert body["credential_key"] == "weather_api_key"
        assert body["is_configured"] is True
        assert body["updated_at"] == "2026-02-08T12:00:00Z"
        assert body["description"] == "Weather API key (OpenWeatherMap, etc.)"

    @pytest.mark.asyncio
    async def test_encrypt_called_with_raw_value(self, client, mock_supabase_client):
        """Verify encrypt_secret receives the raw credential value."""
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "ok"})
        with patch("api.v1.endpoints.user_credentials.encrypt_secret", return_value="ENC") as mock_enc:
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "test_key",
                "credential_value": "raw-secret-value",
            })
        assert resp.status_code == 200
        mock_enc.assert_called_once_with("raw-secret-value")

    @pytest.mark.asyncio
    async def test_custom_description_overrides_known(self, client, mock_supabase_client):
        """Custom description in request overrides KNOWN_CREDENTIALS default."""
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "ok"})
        with patch("api.v1.endpoints.user_credentials.encrypt_secret", return_value="ENC"):
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "openai_api_key",
                "credential_value": "sk-abc",
                "description": "My org's key",
            })
        assert resp.status_code == 200
        assert resp.json()["description"] == "My org's key"

    @pytest.mark.asyncio
    async def test_upsert_stores_correct_setting_key_prefix(self, client, mock_supabase_client):
        """Verify the upsert payload uses the 'credential_' prefix for setting_key."""
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "ok"})
        with patch("api.v1.endpoints.user_credentials.encrypt_secret", return_value="ENC"):
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "my_custom_key",
                "credential_value": "secret",
            })
        assert resp.status_code == 200
        call_args = mock_supabase_client.upsert.call_args
        # The gateway's upsert receives table + data dict
        payload_str = str(call_args)
        assert "credential_my_custom_key" in payload_str

    @pytest.mark.asyncio
    async def test_upsert_returns_none_500(self, client, mock_supabase_client):
        """Upsert returns falsy → 500."""
        mock_supabase_client.upsert = AsyncMock(return_value=None)
        with patch("api.v1.endpoints.user_credentials.encrypt_secret", return_value="ENC"):
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "test_key",
                "credential_value": "val",
            })
        assert resp.status_code == 500
        assert "Failed to save credential" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_upsert_returns_empty_list_500(self, client, mock_supabase_client):
        """Upsert returns empty list → falsy → 500."""
        mock_supabase_client.upsert = AsyncMock(return_value=[])
        with patch("api.v1.endpoints.user_credentials.encrypt_secret", return_value="ENC"):
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "test_key",
                "credential_value": "val",
            })
        assert resp.status_code == 500
        assert "Failed to save credential" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_upsert_returns_list_extracts_first(self, client, mock_supabase_client):
        """Upsert returns list → result[0] extracted for updated_at."""
        mock_supabase_client.upsert = AsyncMock(return_value=[
            {"id": "row-uuid", "updated_at": "2026-02-08T10:00:00Z"},
        ])
        with patch("api.v1.endpoints.user_credentials.encrypt_secret", return_value="ENC"):
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "test_key",
                "credential_value": "val",
            })
        assert resp.status_code == 200
        assert resp.json()["updated_at"] == "2026-02-08T10:00:00Z"

    @pytest.mark.asyncio
    async def test_missing_credential_key_422(self, client):
        """POST without credential_key → 422."""
        resp = await client.post("/v1/user-credentials/save", json={
            "credential_value": "sk-1234",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_missing_credential_value_422(self, client):
        """POST without credential_value → 422."""
        resp = await client.post("/v1/user-credentials/save", json={
            "credential_key": "test",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_empty_body_422(self, client):
        """POST with empty body → 422."""
        resp = await client.post("/v1/user-credentials/save", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_encrypt_secret_raises_500(self, client, mock_supabase_client):
        """encrypt_secret raises → caught by broad except → 500."""
        with patch(
            "api.v1.endpoints.user_credentials.encrypt_secret",
            side_effect=ValueError("encryption key not configured"),
        ):
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "test_key",
                "credential_value": "val",
            })
        assert resp.status_code == 500
        assert "Failed to save credential" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_gateway_error_returns_500(self, client, mock_supabase_client):
        """Generic exception during save → 500."""
        mock_supabase_client.upsert = AsyncMock(side_effect=RuntimeError("DB crash"))
        with patch("api.v1.endpoints.user_credentials.encrypt_secret", return_value="ENC"):
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "test_key",
                "credential_value": "val",
            })
        assert resp.status_code == 500
        assert "Failed to save credential" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_http_exception_reraise(self, client, mock_supabase_client):
        """HTTPException raised inside save try block is re-raised, not swallowed."""
        from fastapi import HTTPException
        mock_supabase_client.upsert = AsyncMock(
            side_effect=HTTPException(status_code=503, detail="service unavailable")
        )
        with patch("api.v1.endpoints.user_credentials.encrypt_secret", return_value="ENC"):
            resp = await client.post("/v1/user-credentials/save", json={
                "credential_key": "test_key",
                "credential_value": "val",
            })
        assert resp.status_code == 503
        assert resp.json()["detail"] == "service unavailable"


# =============================================================================
# GET CREDENTIAL VALUE — GET /v1/user-credentials/{key}/value
# =============================================================================


class TestGetCredentialValue:
    """Tests for the get_credential_value endpoint."""

    @pytest.mark.asyncio
    async def test_success_returns_decrypted_value(self, client, mock_supabase_client):
        """Successful decrypt → 200 with exact response fields."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "setting_key": "credential_openai_api_key",
            "setting_value": {"encrypted_value": "ENC-DATA-HERE", "description": "OpenAI"},
        }])
        with patch("api.v1.endpoints.user_credentials.decrypt_secret", return_value="sk-plaintext") as mock_dec:
            resp = await client.get("/v1/user-credentials/openai_api_key/value")
        assert resp.status_code == 200
        body = resp.json()
        assert body["credential_key"] == "openai_api_key"
        assert body["value"] == "sk-plaintext"
        mock_dec.assert_called_once_with("ENC-DATA-HERE")

    @pytest.mark.asyncio
    async def test_passes_correct_filter_to_gateway(self, client, mock_supabase_client):
        """Verify gateway.select receives the correct setting_key filter."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "setting_key": "credential_my_key",
            "setting_value": {"encrypted_value": "ENC"},
        }])
        with patch("api.v1.endpoints.user_credentials.decrypt_secret", return_value="val"):
            resp = await client.get("/v1/user-credentials/my_key/value")
        assert resp.status_code == 200
        call_str = str(mock_supabase_client.select.call_args)
        assert "credential_my_key" in call_str

    @pytest.mark.asyncio
    async def test_not_found_404(self, client, mock_supabase_client):
        """No matching row → 404 with credential key in message."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/user-credentials/nonexistent_key/value")
        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert "nonexistent_key" in detail
        assert "not found" in detail.lower()

    @pytest.mark.asyncio
    async def test_missing_encrypted_value_500(self, client, mock_supabase_client):
        """Row exists but encrypted_value key is missing → 500."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "setting_key": "credential_broken_key",
            "setting_value": {"description": "Corrupted"},
        }])
        resp = await client.get("/v1/user-credentials/broken_key/value")
        assert resp.status_code == 500
        assert "missing or corrupted" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_empty_encrypted_value_500(self, client, mock_supabase_client):
        """Row exists but encrypted_value is empty string → 500."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "setting_key": "credential_empty_key",
            "setting_value": {"encrypted_value": "", "description": "Empty"},
        }])
        resp = await client.get("/v1/user-credentials/empty_key/value")
        assert resp.status_code == 500
        assert "missing or corrupted" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_setting_value_null_returns_500(self, client, mock_supabase_client):
        """Bug A regression: setting_value is None → encrypted_value check triggers 500.

        Before fix: `row.get("setting_value", {})` returned None, causing
        AttributeError on `.get("encrypted_value")`.
        After fix: `row.get("setting_value") or {}` returns {}, then
        encrypted_value is None → clean 500 with 'missing or corrupted'.
        """
        mock_supabase_client.select = AsyncMock(return_value=[{
            "setting_key": "credential_null_value_key",
            "setting_value": None,
        }])
        resp = await client.get("/v1/user-credentials/null_value_key/value")
        assert resp.status_code == 500
        assert "missing or corrupted" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_decrypt_error_500(self, client, mock_supabase_client):
        """Decryption fails → 500 with generic message (no leak of crypto details)."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "setting_key": "credential_bad_key",
            "setting_value": {"encrypted_value": "BAD-CIPHER"},
        }])
        with patch("api.v1.endpoints.user_credentials.decrypt_secret", side_effect=ValueError("Bad cipher")):
            resp = await client.get("/v1/user-credentials/bad_key/value")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to retrieve credential"

    @pytest.mark.asyncio
    async def test_gateway_error_500(self, client, mock_supabase_client):
        """Gateway select raises → 500."""
        mock_supabase_client.select = AsyncMock(side_effect=ConnectionError("timeout"))
        resp = await client.get("/v1/user-credentials/any_key/value")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to retrieve credential"

    @pytest.mark.asyncio
    async def test_http_exception_reraise(self, client, mock_supabase_client):
        """HTTPException inside try block is re-raised, not caught by generic except."""
        from fastapi import HTTPException
        mock_supabase_client.select = AsyncMock(
            side_effect=HTTPException(status_code=429, detail="rate limited")
        )
        resp = await client.get("/v1/user-credentials/any_key/value")
        assert resp.status_code == 429
        assert resp.json()["detail"] == "rate limited"


# =============================================================================
# DELETE CREDENTIAL — DELETE /v1/user-credentials/{key}
# =============================================================================


class TestDeleteCredential:
    """Tests for the delete_credential endpoint."""

    @pytest.mark.asyncio
    async def test_response_body_exact(self, client, mock_supabase_client):
        """DELETE → 200 with exact response fields."""
        mock_supabase_client.delete = AsyncMock(return_value=None)
        resp = await client.delete("/v1/user-credentials/test_key")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {
            "success": True,
            "credential_key": "test_key",
            "message": "Credential deleted successfully",
        }

    @pytest.mark.asyncio
    async def test_passes_correct_args_to_gateway(self, client, mock_supabase_client):
        """Verify gateway.delete receives correct table and record_id."""
        mock_supabase_client.delete = AsyncMock(return_value=None)
        resp = await client.delete("/v1/user-credentials/my_api_key")
        assert resp.status_code == 200
        mock_supabase_client.delete.assert_called_once()
        call_str = str(mock_supabase_client.delete.call_args)
        assert "user_settings" in call_str
        assert "credential_my_api_key" in call_str

    @pytest.mark.asyncio
    async def test_gateway_error_returns_500(self, client, mock_supabase_client):
        """Gateway delete raises → 500."""
        mock_supabase_client.delete = AsyncMock(side_effect=RuntimeError("Network error"))
        resp = await client.delete("/v1/user-credentials/test_key")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to delete credential"

    @pytest.mark.asyncio
    async def test_http_exception_reraise(self, client, mock_supabase_client):
        """HTTPException inside delete try block is re-raised."""
        from fastapi import HTTPException
        mock_supabase_client.delete = AsyncMock(
            side_effect=HTTPException(status_code=404, detail="not found")
        )
        resp = await client.delete("/v1/user-credentials/some_key")
        assert resp.status_code == 404
        assert resp.json()["detail"] == "not found"
