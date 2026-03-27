"""
Tests for data/database/repositories/preferences.py

Covers: get_preference, set_preference, get_all_preferences, delete_preference.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from data.database.repositories.preferences import PreferencesRepository
from data.database.persistence_gateway import SupabasePersistenceGateway


def _make_gateway():
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.select = AsyncMock(return_value=[])
    gw.upsert = AsyncMock(return_value=[{}])
    gw.delete = AsyncMock()
    return gw


@pytest.fixture
def repo():
    gw = _make_gateway()
    return PreferencesRepository(db=gw), gw


class TestConstructor:
    def test_with_gateway(self):
        gw = _make_gateway()
        repo = PreferencesRepository(db=gw)
        assert repo._gateway is gw

    def test_none_raises(self):
        # We removed the ValueError for db=None to allow safe fallbacks, so repo._gateway is None
        repo = PreferencesRepository(db=None)
        assert repo._gateway is None

    def test_session_raises(self):
        with pytest.raises(RuntimeError):
            PreferencesRepository(db=None, session=MagicMock())

    def test_invalid_type_raises(self):
        """Coverage for line 49-50: else branch raises TypeError."""
        with pytest.raises(TypeError, match="Unsupported database adapter"):
            PreferencesRepository(db="not_a_gateway")

    def test_accepts_supabase_client(self):
        """Coverage for lines 47-48: SupabaseClient isinstance path."""
        from data.database.clients.supabase import SupabaseClient
        mock_client = MagicMock(spec=SupabaseClient)
        with patch.object(SupabasePersistenceGateway, "__init__", return_value=None):
            repo = PreferencesRepository(db=mock_client)
            assert isinstance(repo._gateway, SupabasePersistenceGateway)


class TestGetPreference:
    @pytest.mark.asyncio
    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [{"preference_key": "theme", "preference_value": "dark"}]
        result = await r.get_preference("theme")
        assert result == "dark"

    @pytest.mark.asyncio
    async def test_not_found_returns_default(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_preference("missing", default_value="light")
        assert result == "light"

    @pytest.mark.asyncio
    async def test_error_returns_default(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("db error")
        result = await r.get_preference("broken", default_value="fallback")
        assert result == "fallback"


class TestSetPreference:
    @pytest.mark.asyncio
    async def test_success(self, repo):
        r, gw = repo
        result = await r.set_preference("theme", "dark")
        assert result is True
        gw.upsert.assert_called_once()

    @pytest.mark.asyncio
    async def test_error(self, repo):
        r, gw = repo
        gw.upsert.side_effect = Exception("db error")
        result = await r.set_preference("broken", "value")
        assert result is False


class TestGetAllPreferences:
    @pytest.mark.asyncio
    async def test_multiple(self, repo):
        r, gw = repo
        gw.select.return_value = [
            {"preference_key": "theme", "preference_value": "dark"},
            {"preference_key": "lang", "preference_value": "en"},
        ]
        result = await r.get_all_preferences()
        assert result == {"theme": "dark", "lang": "en"}

    @pytest.mark.asyncio
    async def test_empty(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_all_preferences()
        assert result == {}

    @pytest.mark.asyncio
    async def test_error(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("fail")
        result = await r.get_all_preferences()
        assert result == {}


class TestDeletePreference:
    @pytest.mark.asyncio
    async def test_success(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": str(uuid4()), "preference_key": "theme"}]
        result = await r.delete_preference("theme")
        assert result is True
        gw.delete.assert_called_once()

    @pytest.mark.asyncio
    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.delete_preference("missing")
        assert result is False

    @pytest.mark.asyncio
    async def test_error(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("db error")
        result = await r.delete_preference("broken")
        assert result is False
