"""
Unit tests for Preferences endpoints (/v1/preferences/*).

4 CRUD endpoints with canonical preference auto-seeding, exact response bodies,
error paths, and HTTPException re-raise verification.

No bugs found during audit — source follows clean except HTTPException: raise
+ except Exception pattern consistently.

CI: pytest tests/unit/api/test_preferences_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock


# =============================================================================
# GET ALL PREFERENCES — GET /v1/preferences/
# =============================================================================


class TestGetAllPreferences:
    """GET /v1/preferences/ tests."""

    @pytest.mark.asyncio
    async def test_returns_preferences_and_user_id(self, client, mock_supabase_client):
        """Empty DB → {preferences: {}, user_id: str}."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/preferences/")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body["preferences"], dict)
        assert isinstance(body["user_id"], str)
        assert len(body["user_id"]) > 0

    @pytest.mark.asyncio
    async def test_repository_error_500(self, client, app):
        """Repository raises → 500 with stable error message."""
        from api.dependencies import get_preferences_service
        broken = AsyncMock()
        broken.get_all_preferences = AsyncMock(side_effect=RuntimeError("DB down"))
        app.dependency_overrides[get_preferences_service] = lambda: broken
        try:
            resp = await client.get("/v1/preferences/")
            assert resp.status_code == 500
            assert resp.json()["detail"] == "Failed to retrieve preferences. Check server logs for details."
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)


# =============================================================================
# GET PREFERENCE — GET /v1/preferences/{key}
# =============================================================================


class TestGetPreference:
    """GET /v1/preferences/{key} tests."""

    @pytest.mark.asyncio
    async def test_canonical_preference_seeds_default(self, client, mock_supabase_client):
        """Canonical preference not in DB → auto-seeded → returns default value."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "ok"})
        resp = await client.get("/v1/preferences/handsfree_enabled")
        assert resp.status_code == 200
        body = resp.json()
        assert body["preference_key"] == "handsfree_enabled"
        # Default from _PREFERENCE_DEFAULTS
        assert body["preference_value"] == {"enabled": False}

    @pytest.mark.asyncio
    async def test_canonical_preference_already_in_db(self, client, app):
        """Canonical preference exists in DB → returns DB value, no seed."""
        from api.dependencies import get_preferences_service
        mock_repo = AsyncMock()
        mock_repo.get_preference = AsyncMock(return_value={"enabled": True})
        app.dependency_overrides[get_preferences_service] = lambda: mock_repo
        try:
            resp = await client.get("/v1/preferences/handsfree_enabled")
            assert resp.status_code == 200
            body = resp.json()
            assert body["preference_key"] == "handsfree_enabled"
            assert body["preference_value"] == {"enabled": True}
            # set_preference should NOT have been called (no seeding)
            mock_repo.set_preference.assert_not_called()
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)

    @pytest.mark.asyncio
    async def test_nonexistent_noncanonical_preference_404(self, client, mock_supabase_client):
        """Non-canonical preference not in DB → 404 with key in message."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/preferences/nonexistent_key_xyz")
        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert "nonexistent_key_xyz" in detail
        assert "not found" in detail.lower()

    @pytest.mark.asyncio
    async def test_seed_failure_returns_default_200(self, client, app):
        """Auto-seed of canonical preference fails → returns default with 200 (for onboarding)."""
        from api.dependencies import get_preferences_service
        mock_repo = AsyncMock()
        mock_repo.get_preference = AsyncMock(side_effect=lambda **kw: kw.get("default_value"))
        mock_repo.set_preference = AsyncMock(return_value=False)
        app.dependency_overrides[get_preferences_service] = lambda: mock_repo
        try:
            resp = await client.get("/v1/preferences/handsfree_enabled")
            assert resp.status_code == 200
            assert resp.json()["preference_value"]["enabled"] is False
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)

    @pytest.mark.asyncio
    async def test_repository_error_500(self, client, app):
        """Repository raises → 500."""
        from api.dependencies import get_preferences_service
        broken = AsyncMock()
        broken.get_preference = AsyncMock(side_effect=RuntimeError("connection reset"))
        app.dependency_overrides[get_preferences_service] = lambda: broken
        try:
            resp = await client.get("/v1/preferences/theme")
            assert resp.status_code == 500
            assert resp.json()["detail"] == "Failed to retrieve preference. Check server logs for details."
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)

    @pytest.mark.asyncio
    async def test_http_exception_reraise(self, client, app):
        """HTTPException from repository is re-raised, not caught by generic except."""
        from fastapi import HTTPException
        from api.dependencies import get_preferences_service
        mock_repo = AsyncMock()
        mock_repo.get_preference = AsyncMock(
            side_effect=HTTPException(status_code=429, detail="rate limited")
        )
        app.dependency_overrides[get_preferences_service] = lambda: mock_repo
        try:
            resp = await client.get("/v1/preferences/theme")
            assert resp.status_code == 429
            assert resp.json()["detail"] == "rate limited"
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)


# =============================================================================
# SET PREFERENCE — POST /v1/preferences/{key}
# =============================================================================


class TestSetPreference:
    """POST /v1/preferences/{key} tests."""

    @pytest.mark.asyncio
    async def test_set_returns_exact_response(self, client, mock_supabase_client):
        """Set preference → 200 with exact response fields."""
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "ok"})
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.post("/v1/preferences/theme", json={"value": "dark"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["preference_key"] == "theme"
        assert body["preference_value"] == "dark"
        assert isinstance(body["user_id"], str)

    @pytest.mark.asyncio
    async def test_missing_value_422(self, client):
        """POST without value field → 422."""
        resp = await client.post("/v1/preferences/theme", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_set_returns_false_500(self, client, app):
        """Repository returns False → 500 with preference key in message."""
        from api.dependencies import get_preferences_service
        mock_repo = AsyncMock()
        mock_repo.set_preference = AsyncMock(return_value=False)
        app.dependency_overrides[get_preferences_service] = lambda: mock_repo
        try:
            resp = await client.post("/v1/preferences/theme", json={"value": "light"})
            assert resp.status_code == 500
            assert "Failed to set preference 'theme'" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)

    @pytest.mark.asyncio
    async def test_repository_error_500(self, client, app):
        """Repository raises → 500."""
        from api.dependencies import get_preferences_service
        broken = AsyncMock()
        broken.set_preference = AsyncMock(side_effect=RuntimeError("disk full"))
        app.dependency_overrides[get_preferences_service] = lambda: broken
        try:
            resp = await client.post("/v1/preferences/theme", json={"value": "light"})
            assert resp.status_code == 500
            assert resp.json()["detail"] == "Failed to set preference. Check server logs for details."
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)

    @pytest.mark.asyncio
    async def test_http_exception_reraise(self, client, app):
        """HTTPException from repository is re-raised."""
        from fastapi import HTTPException
        from api.dependencies import get_preferences_service
        mock_repo = AsyncMock()
        mock_repo.set_preference = AsyncMock(
            side_effect=HTTPException(status_code=503, detail="unavailable")
        )
        app.dependency_overrides[get_preferences_service] = lambda: mock_repo
        try:
            resp = await client.post("/v1/preferences/theme", json={"value": "dark"})
            assert resp.status_code == 503
            assert resp.json()["detail"] == "unavailable"
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)


# =============================================================================
# LEGAL ACCEPTANCE — /v1/preferences/legal/acceptance*
# =============================================================================


class TestLegalAcceptance:
    """Legal acceptance audit + cache endpoints."""

    @pytest.mark.asyncio
    async def test_record_legal_acceptance_success(self, client, app):
        from api.dependencies import get_database
        from api.dependencies import get_preferences_service

        mock_repo = AsyncMock()
        mock_repo.set_preference = AsyncMock(return_value=True)
        mock_db = AsyncMock()
        mock_db.insert = AsyncMock(return_value={"id": "evt-1"})

        app.dependency_overrides[get_preferences_service] = lambda: mock_repo
        app.dependency_overrides[get_database] = lambda: mock_db
        try:
            resp = await client.post(
                "/v1/preferences/legal/acceptance",
                json={
                    "terms_version": "2026-02-17",
                    "terms_hash": "4fae27d8a2be5438cf2a70c549cab2df8f22ec3ddcfcf278c99244724b2b47a3",
                    "acceptance_method": "checkbox",
                    "source": "onboarding_modal",
                    "metadata": {"ui_step": "license"},
                },
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["accepted"] is True
            assert body["terms_version"] == "2026-02-17"
            assert body["acceptance_method"] == "checkbox"

            mock_db.insert.assert_called_once()
            mock_repo.set_preference.assert_called_once()
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)
            app.dependency_overrides.pop(get_database, None)

    @pytest.mark.asyncio
    async def test_record_legal_acceptance_cache_failure_returns_500(self, client, app):
        from api.dependencies import get_database
        from api.dependencies import get_preferences_service

        mock_repo = AsyncMock()
        mock_repo.set_preference = AsyncMock(return_value=False)
        mock_db = AsyncMock()
        mock_db.insert = AsyncMock(return_value={"id": "evt-1"})

        app.dependency_overrides[get_preferences_service] = lambda: mock_repo
        app.dependency_overrides[get_database] = lambda: mock_db
        try:
            resp = await client.post(
                "/v1/preferences/legal/acceptance",
                json={
                    "terms_version": "2026-02-17",
                    "terms_hash": "4fae27d8a2be5438cf2a70c549cab2df8f22ec3ddcfcf278c99244724b2b47a3",
                },
            )
            assert resp.status_code == 500
            assert "cache update failed" in resp.json()["detail"].lower()
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)
            app.dependency_overrides.pop(get_database, None)

    @pytest.mark.asyncio
    async def test_get_latest_legal_acceptance_reads_audit_source_and_refreshes_cache(self, client, app):
        from api.dependencies import get_database
        from api.dependencies import get_preferences_service

        mock_repo = AsyncMock()
        mock_repo.get_preference = AsyncMock(return_value=None)
        mock_repo.set_preference = AsyncMock(return_value=True)
        mock_db = AsyncMock()
        mock_db.select = AsyncMock(return_value=[{
            "terms_version": "2026-02-17",
            "terms_hash": "4fae27d8a2be5438cf2a70c549cab2df8f22ec3ddcfcf278c99244724b2b47a3",
            "accepted_at": "2026-02-17T10:00:00+00:00",
            "acceptance_method": "checkbox",
            "source": "onboarding_modal",
        }])

        app.dependency_overrides[get_preferences_service] = lambda: mock_repo
        app.dependency_overrides[get_database] = lambda: mock_db
        try:
            resp = await client.get("/v1/preferences/legal/acceptance/latest")
            assert resp.status_code == 200
            body = resp.json()
            assert body["accepted"] is True
            assert body["terms_version"] == "2026-02-17"
            mock_db.select.assert_called_once()
            mock_repo.set_preference.assert_called_once()
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)
            app.dependency_overrides.pop(get_database, None)

    @pytest.mark.asyncio
    async def test_get_latest_legal_acceptance_not_found(self, client, app):
        from api.dependencies import get_database
        from api.dependencies import get_preferences_service

        mock_repo = AsyncMock()
        mock_repo.get_preference = AsyncMock(return_value=None)
        mock_db = AsyncMock()
        mock_db.select = AsyncMock(return_value=[])

        app.dependency_overrides[get_preferences_service] = lambda: mock_repo
        app.dependency_overrides[get_database] = lambda: mock_db
        try:
            resp = await client.get("/v1/preferences/legal/acceptance/latest")
            assert resp.status_code == 404
            assert "no legal acceptance found" in resp.json()["detail"].lower()
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)
            app.dependency_overrides.pop(get_database, None)


# =============================================================================
# DELETE PREFERENCE — DELETE /v1/preferences/{key}
# =============================================================================


class TestDeletePreference:
    """DELETE /v1/preferences/{key} tests."""

    @pytest.mark.asyncio
    async def test_delete_returns_exact_response(self, client, mock_supabase_client):
        """Delete existing preference → exact success response."""
        mock_supabase_client.select = AsyncMock(return_value=[{
            "id": "pref-uuid-123",
            "preference_key": "theme",
            "preference_value": "dark",
            "user_id": "default",
        }])
        mock_supabase_client.delete = AsyncMock(return_value=None)
        resp = await client.delete("/v1/preferences/theme")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {
            "success": True,
            "message": "Preference 'theme' deleted successfully",
        }

    @pytest.mark.asyncio
    async def test_delete_nonexistent_404(self, client, mock_supabase_client):
        """Delete nonexistent preference → 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.delete("/v1/preferences/nonexistent_xyz")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_repository_error_500(self, client, app):
        """Repository raises → 500."""
        from api.dependencies import get_preferences_service
        broken = AsyncMock()
        broken.delete_preference = AsyncMock(side_effect=RuntimeError("timeout"))
        app.dependency_overrides[get_preferences_service] = lambda: broken
        try:
            resp = await client.delete("/v1/preferences/theme")
            assert resp.status_code == 500
            assert resp.json()["detail"] == "Failed to delete preference. Check server logs for details."
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)

    @pytest.mark.asyncio
    async def test_http_exception_reraise(self, client, app):
        """HTTPException from repository is re-raised."""
        from fastapi import HTTPException
        from api.dependencies import get_preferences_service
        broken = AsyncMock()
        broken.delete_preference = AsyncMock(
            side_effect=HTTPException(status_code=409, detail="conflict")
        )
        app.dependency_overrides[get_preferences_service] = lambda: broken
        try:
            resp = await client.delete("/v1/preferences/theme")
            assert resp.status_code == 409
            assert resp.json()["detail"] == "conflict"
        finally:
            app.dependency_overrides.pop(get_preferences_service, None)
