"""
Profile Management Endpoint Tests

Covers all 4 routes in api/v1/endpoints/profiles.py:
  GET  /v1/profiles
  GET  /v1/profiles/active
  POST /v1/profiles/switch
  GET  /v1/profiles/{profile_name}

Mocking strategy:
  - ProfileManager: patched at module level to control profile discovery
  - aiofiles: patched for profile file reading
"""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock


MOCK_PROFILES = [
    {"name": "default.py", "type": "python", "path": "/profiles/default.py"},
    {"name": "research.yaml", "type": "yaml", "path": "/profiles/research.yaml"},
]


def _mock_profile_manager():
    """Create a mock ProfileManager."""
    mgr = MagicMock()
    mgr.discover_profiles = MagicMock(return_value=[
        dict(p) for p in MOCK_PROFILES  # Return fresh copies
    ])
    mgr.get_default_profile = MagicMock(return_value="default.py")
    mgr.get_profile_path = MagicMock(side_effect=lambda name: Path(f"/profiles/{name}") if name in ["default.py", "research.yaml"] else None)
    mgr.clear_cache = MagicMock()
    mgr.load_profile_config = MagicMock(return_value=None)
    return mgr


# ===================================================================
# GET /v1/profiles
# ===================================================================


class TestListProfiles:

    @pytest.mark.asyncio
    async def test_list_profiles_returns_array(self, client):
        """List profiles returns array with count."""
        mgr = _mock_profile_manager()
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles")

        assert resp.status_code == 200
        body = resp.json()
        assert "profiles" in body
        assert body["count"] == 2

    @pytest.mark.asyncio
    async def test_list_profiles_marks_active(self, client):
        """Active profile is marked in the list."""
        mgr = _mock_profile_manager()
        # Make get_profile_path return a Path with .name matching default.py
        mgr.get_profile_path = MagicMock(return_value=Path("/profiles/default.py"))

        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles")

        body = resp.json()
        active_profiles = [p for p in body["profiles"] if p.get("active")]
        assert len(active_profiles) == 1
        assert active_profiles[0]["name"] == "default.py"

    @pytest.mark.asyncio
    async def test_list_profiles_with_refresh(self, client):
        """Refresh=true clears cache before listing."""
        mgr = _mock_profile_manager()
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles", params={"refresh": "true"})

        assert resp.status_code == 200
        mgr.clear_cache.assert_called_once()


# ===================================================================
# GET /v1/profiles/active
# ===================================================================


class TestActiveProfile:

    @pytest.mark.asyncio
    async def test_active_profile_returns_info(self, client):
        """Active profile returns name and status."""
        mgr = _mock_profile_manager()
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles/active")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "active"
        assert "name" in body

    @pytest.mark.asyncio
    async def test_active_profile_resolves_path_name(self, client):
        """Line 112: active_profile = active_path.name when path exists."""
        mgr = _mock_profile_manager()
        # Force get_profile_path to return a real Path for ANY profile name
        mgr.get_profile_path = MagicMock(return_value=Path("/profiles/GURU.py"))
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles/active")
        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "GURU.py"
        assert body["status"] == "active"


# ===================================================================
# POST /v1/profiles/switch
# ===================================================================


class TestSwitchProfile:

    @pytest.mark.asyncio
    async def test_switch_to_valid_profile(self, client):
        """Switch to existing profile returns ok."""
        mgr = _mock_profile_manager()
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.post("/v1/profiles/switch", json={
                "profile": "research.yaml",
            })

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "research.yaml" in body["profile"]

    @pytest.mark.asyncio
    async def test_switch_to_nonexistent_profile(self, client):
        """Switch to non-existent profile returns 404."""
        mgr = _mock_profile_manager()
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.post("/v1/profiles/switch", json={
                "profile": "nonexistent.py",
            })

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_switch_empty_profile_returns_422(self, client):
        """Empty profile name returns 422."""
        mgr = _mock_profile_manager()
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.post("/v1/profiles/switch", json={
                "profile": "",
            })

        assert resp.status_code == 422


# ===================================================================
# GET /v1/profiles/{profile_name}
# ===================================================================


class TestProfileDetails:

    @pytest.mark.asyncio
    async def test_get_profile_not_found(self, client):
        """Non-existent profile returns 404."""
        mgr = _mock_profile_manager()
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles/nonexistent.py")

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_profile_details_found(self, client, temp_dir):
        """Existing profile returns details with preview."""
        profile_path = temp_dir / "test_profile.py"
        profile_path.write_text("# Test profile\nmodel = 'gpt-4'\n")

        mgr = _mock_profile_manager()
        mgr.get_profile_path = MagicMock(return_value=profile_path)

        mock_read = AsyncMock(return_value={
            "size_bytes": 100,
            "preview": "# Test profile\nmodel = 'gpt-4'\n",
            "truncated": False
        })

        with patch("api.v1.endpoints.profiles.profile_manager", mgr), \
             patch("data.database.repositories.profile_repository.ProfileRepository.read_profile_preview", mock_read):
            resp = await client.get("/v1/profiles/test_profile.py")

        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "test_profile.py"
        assert "preview" in body
        assert body["truncated"] is False


# ===================================================================
# Error paths (coverage gaps)
# ===================================================================


class TestProfileErrorPaths:
    """Error handlers and edge cases for coverage completeness."""

    @pytest.mark.asyncio
    async def test_list_profiles_exception_returns_500(self, client):
        """discover_profiles failure → 500."""
        mgr = _mock_profile_manager()
        mgr.discover_profiles.side_effect = RuntimeError("disk I/O error")
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles")
        assert resp.status_code == 500
        assert "Failed to list" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_active_profile_exception_returns_500(self, client):
        """get_active_profile failure → 500."""
        mgr = _mock_profile_manager()
        mgr.get_profile_path.side_effect = RuntimeError("path resolution failed")
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles/active")
        assert resp.status_code == 500
        assert "Failed to get active" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_switch_profile_exception_returns_500(self, client):
        """switch_profile unexpected exception → 500."""
        mgr = _mock_profile_manager()
        mgr.get_profile_path.side_effect = RuntimeError("permission denied")
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.post("/v1/profiles/switch", json={
                "profile": "default.py",
            })
        assert resp.status_code == 500
        assert "Failed to switch" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_get_profile_too_large_returns_413(self, client, temp_dir):
        """Profile file exceeding MAX_PROFILE_SIZE → 413."""
        profile_path = temp_dir / "huge.py"
        # Write more than MAX_PROFILE_SIZE (default 1MB)
        profile_path.write_bytes(b"x" * (2 * 1024 * 1024))

        mgr = _mock_profile_manager()
        mgr.get_profile_path = MagicMock(return_value=profile_path)
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles/huge.py")
        assert resp.status_code == 413

    @pytest.mark.asyncio
    async def test_get_profile_unicode_error_returns_400(self, client, temp_dir):
        """Profile with invalid UTF-8 → 400."""
        profile_path = temp_dir / "binary.py"
        profile_path.write_bytes(b"\xff\xfe\x00\x01invalid utf8")

        mgr = _mock_profile_manager()
        mgr.get_profile_path = MagicMock(return_value=profile_path)

        mock_read = AsyncMock(side_effect=ValueError("Profile file is not valid UTF-8 text"))

        with patch("api.v1.endpoints.profiles.profile_manager", mgr), \
             patch("data.database.repositories.profile_repository.ProfileRepository.read_profile_preview", mock_read):
            resp = await client.get("/v1/profiles/binary.py")
        assert resp.status_code == 400
        assert "UTF-8" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_get_profile_with_config(self, client, temp_dir):
        """Profile with config data includes config in response."""
        profile_path = temp_dir / "guru.yaml"
        profile_path.write_text("name: GURU\nmodel: gpt-4\n")

        mgr = _mock_profile_manager()
        mgr.get_profile_path = MagicMock(return_value=profile_path)
        mgr.load_profile_config = MagicMock(return_value={"name": "GURU", "model": "gpt-4"})

        mock_read = AsyncMock(return_value={
            "size_bytes": 100,
            "preview": "name: GURU\nmodel: gpt-4\n",
            "truncated": False
        })

        with patch("api.v1.endpoints.profiles.profile_manager", mgr), \
             patch("data.database.repositories.profile_repository.ProfileRepository.read_profile_preview", mock_read):
            resp = await client.get("/v1/profiles/guru.yaml")
        assert resp.status_code == 200
        body = resp.json()
        assert "config" in body
        assert body["config"]["name"] == "GURU"

    @pytest.mark.asyncio
    async def test_get_profile_generic_exception_returns_500(self, client):
        """Unexpected exception in get_profile_details → 500."""
        mgr = _mock_profile_manager()
        mgr.get_profile_path.side_effect = RuntimeError("unexpected")
        with patch("api.v1.endpoints.profiles.profile_manager", mgr):
            resp = await client.get("/v1/profiles/default.py")
        assert resp.status_code == 500
        assert "Failed to get profile" in resp.json()["detail"]
