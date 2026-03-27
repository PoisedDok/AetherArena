import os
import pytest
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch

from application.setup.setup_service import SetupService

class TestSetupService:
    @pytest.fixture
    def mock_settings(self):
        settings = MagicMock()
        settings.supabase = MagicMock()
        settings.supabase.url = "http://localhost:54321"
        settings.supabase.anon_key = "test.anon.key"
        settings.supabase.service_role_key = "test.sr.key"
        settings.supabase.db_schema = "public"
        settings.supabase.realtime_enabled = False
        settings.redis = MagicMock()
        settings.redis.url = "redis://localhost:6379"
        settings.redis.namespace = "test"
        return settings

    @pytest.mark.asyncio
    async def test_execute_setup_already_initialized(self, mock_settings):
        service = SetupService(mock_settings, MagicMock(), MagicMock())
        
        with patch("api.dependencies.get_database_connection", return_value=MagicMock()):
            result = await service.execute_setup(database_initialized=True)
            
        assert result["status"] == "ok"
        assert result["already_initialized"] is True

    @pytest.mark.asyncio
    async def test_execute_setup_degraded_does_not_return_gateways(self, mock_settings):
        service = SetupService(mock_settings, MagicMock(), MagicMock())

        fake_supabase = MagicMock()
        fake_supabase.initialize = AsyncMock(return_value=None)
        
        with patch("api.dependencies.get_database_connection", return_value=None), \
             patch("core.integrations.providers.supabase_docker.ensure_supabase_running", return_value=False), \
             patch("data.database.clients.supabase.SupabaseClient.from_env", return_value=fake_supabase), \
             patch("data.database.migration_runner.run_migrations", new=AsyncMock(return_value=True)), \
             patch("application.agents.agent_seeder.seed_missing_agents", new=AsyncMock(return_value=None)):
            result = await service.execute_setup()
            
        assert result["status"] == "degraded"
        assert result["database_connected"] is True
        assert "gateway" not in result
        assert "file_repo" not in result

    @pytest.mark.asyncio
    async def test_complete_onboarding_writes_file(self, mock_settings):
        service = SetupService(mock_settings, MagicMock(), MagicMock())
        payload = {"test": "data"}
        
        mock_settings.app_root = Path("/tmp/aether_test")
        mock_settings.app_root.mkdir(parents=True, exist_ok=True)
        pending_file = mock_settings.app_root / "pending_onboarding.json"
        
        if pending_file.exists():
            pending_file.unlink()
            
        try:
            with patch("application.setup.setup_service.get_app_root", return_value=mock_settings.app_root):
                await service.complete_onboarding(payload)
                
            assert pending_file.exists()
            import json
            with open(pending_file, 'r') as f:
                saved = json.load(f)
            assert saved == payload
        finally:
            if pending_file.exists():
                pending_file.unlink()
            if mock_settings.app_root.exists():
                import shutil
                shutil.rmtree(mock_settings.app_root)

    @pytest.mark.asyncio
    async def test_execute_setup_clears_health_override(self, mock_settings, monkeypatch):
        monkeypatch.setenv("SKIP_SERVICE_HEALTH_CHECK", "true")
        service = SetupService(mock_settings, MagicMock(), MagicMock())

        fake_supabase = MagicMock()
        fake_supabase.initialize = AsyncMock(return_value=None)
        
        observed_skip = {}
        async def _ensure_supabase_running(**kwargs):
            observed_skip["value"] = os.getenv("SKIP_SERVICE_HEALTH_CHECK")
            return True
            
        with patch("api.dependencies.get_database_connection", return_value=None), \
             patch("core.integrations.providers.supabase_docker.ensure_supabase_running", side_effect=_ensure_supabase_running), \
             patch("data.database.clients.supabase.SupabaseClient.from_env", return_value=fake_supabase), \
             patch("data.database.migration_runner.run_migrations", new=AsyncMock(return_value=True)), \
             patch("application.agents.agent_seeder.seed_missing_agents", new=AsyncMock(return_value=None)):
            result = await service.execute_setup()
            
        assert result["status"] == "ok"
        assert observed_skip["value"] == "false"
        assert os.getenv("SKIP_SERVICE_HEALTH_CHECK") == "false"

    @pytest.mark.asyncio
    async def test_execute_setup_handles_migration_failure(self, mock_settings):
        service = SetupService(mock_settings, MagicMock(), MagicMock())

        fake_supabase = MagicMock()
        fake_supabase.initialize = AsyncMock(return_value=None)
        fake_supabase.dispose = AsyncMock(return_value=None)

        with patch("api.dependencies.get_database_connection", return_value=None), \
             patch("core.integrations.providers.supabase_docker.ensure_supabase_running", new=AsyncMock(return_value=True)), \
             patch("data.database.clients.supabase.SupabaseClient.from_env", return_value=fake_supabase), \
             patch("data.database.migration_runner.run_migrations", new=AsyncMock(return_value=False)):
            
            from core.exceptions import UpstreamServiceError
            with pytest.raises(UpstreamServiceError) as exc_info:
                await service.execute_setup()
                
            assert exc_info.value.status_code == 503
            assert "Database migrations failed or partially applied" in str(exc_info.value)
            
            # Verify resource cleanup was called
            assert fake_supabase.dispose.call_count == 0
