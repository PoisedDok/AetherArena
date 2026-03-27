"""
Setup / Onboarding Endpoint Tests

Covers setup routes in api/v1/endpoints/setup.py:
  GET  /v1/setup/status
  GET  /v1/setup/requirements
  POST /v1/setup/start
  POST /v1/setup/skip (disabled by hard-block policy)
  POST /v1/setup/finalize

Mocking strategy:
  - get_app_root / get_bundle_root / get_install_root: patched to temp dirs
  - subprocess.run / subprocess.Popen: patched to avoid real system calls
  - json file I/O: uses real temp files in controlled temp directory
"""

import json
import os
import pytest
from unittest.mock import patch, MagicMock, AsyncMock


# ===================================================================
# GET /v1/setup/status
# ===================================================================


class TestSetupStatus:

    @pytest.mark.asyncio
    async def test_status_returns_default_when_no_file(self, client, temp_dir):
        """Default pending status when progress file does not exist."""
        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ):
            resp = await client.get("/v1/setup/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["current_phase"] == "idle"
        assert body["total_progress"] == 0
        assert body["repositories"]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_status_reads_progress_file(self, client, temp_dir):
        """Status reads from setup_progress.json when available."""
        logs_dir = temp_dir / "logs"
        logs_dir.mkdir()
        progress_data = {
            "repositories": {"status": "completed", "progress": 100, "message": "Done", "items": []},
            "python_packages": {"status": "in_progress", "progress": 50, "message": "Installing", "items": []},
            "oi_environment": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
            "ml_models": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
            "docker_services": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
            "total_progress": 30,
            "current_phase": "python_packages",
        }
        (logs_dir / "setup_progress.json").write_text(json.dumps(progress_data))

        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ):
            resp = await client.get("/v1/setup/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["current_phase"] == "python_packages"
        assert body["total_progress"] == 30
        assert body["repositories"]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_status_handles_partial_progress_file(self, client, temp_dir):
        """Missing keys in progress file get defaults."""
        logs_dir = temp_dir / "logs"
        logs_dir.mkdir()
        (logs_dir / "setup_progress.json").write_text(json.dumps({"current_phase": "starting"}))

        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ):
            resp = await client.get("/v1/setup/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["current_phase"] == "starting"
        # Missing keys should get defaults
        assert body["repositories"]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_status_handles_corrupt_json(self, client, temp_dir):
        """Corrupt JSON falls back to default state."""
        logs_dir = temp_dir / "logs"
        logs_dir.mkdir()
        (logs_dir / "setup_progress.json").write_text("{invalid json!!!")

        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ):
            resp = await client.get("/v1/setup/status")

        assert resp.status_code == 200
        assert resp.json()["current_phase"] == "idle"

    @pytest.mark.asyncio
    async def test_status_missing_current_phase_defaults_to_idle(self, client, temp_dir):
        """Missing current_phase key defaults to 'idle'."""
        logs_dir = temp_dir / "logs"
        logs_dir.mkdir()
        # File has category keys but missing current_phase and total_progress
        (logs_dir / "setup_progress.json").write_text(json.dumps({
            "repositories": {"status": "done", "progress": 100, "message": "OK", "items": []},
            "python_packages": {"status": "done", "progress": 100, "message": "OK", "items": []},
            "oi_environment": {"status": "done", "progress": 100, "message": "OK", "items": []},
            "ml_models": {"status": "done", "progress": 100, "message": "OK", "items": []},
            "docker_services": {"status": "done", "progress": 100, "message": "OK", "items": []},
        }))

        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ):
            resp = await client.get("/v1/setup/status")

        assert resp.status_code == 200
        body = resp.json()
        assert body["current_phase"] == "idle"
        assert body["total_progress"] == 0


# ===================================================================
# GET /v1/setup/requirements
# ===================================================================


class TestSetupRequirements:

    @pytest.mark.asyncio
    async def test_requirements_returns_checks(self, client, app, temp_dir):
        """Requirements endpoint returns all pre-flight checks."""
        mock_run = MagicMock()
        mock_run.returncode = 0
        mock_run.stdout = "Python 3.11.0"

        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ), patch(
            "application.setup.setup_service.get_bundle_root",
            return_value=temp_dir,
        ), patch(
            "application.setup.setup_service.get_install_root",
            return_value=temp_dir,
        ):
            from api.dependencies import get_process_gateway
            mock_gateway = MagicMock()
            mock_gateway.run_command.return_value = mock_run
            app.dependency_overrides[get_process_gateway] = lambda: mock_gateway
            try:
                resp = await client.get("/v1/setup/requirements")
            finally:
                app.dependency_overrides.pop(get_process_gateway, None)

        assert resp.status_code == 200
        body = resp.json()
        assert "python3" in body
        assert "docker_daemon" in body
        assert "overall_ready" in body

    @pytest.mark.asyncio
    async def test_requirements_with_bundled_services(self, client, app, temp_dir):
        """Requirements detects bundled Perplexica and external-services."""
        # Create service directories that _check_setup_requirements scans
        (temp_dir / "services" / "perplexica").mkdir(parents=True)
        (temp_dir / "services" / "perplexica" / "package.json").write_text("{}")
        (temp_dir / "services" / "external-services").mkdir(parents=True)
        (temp_dir / "services" / "external-services" / "docker-compose.yml").write_text("version: '3'")

        mock_run = MagicMock()
        mock_run.returncode = 0
        mock_run.stdout = "Python 3.11.0"

        with patch("application.setup.setup_service.get_app_root", return_value=temp_dir), \
             patch("data.database.repositories.setup_state_repository.get_app_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_bundle_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_install_root", return_value=temp_dir):
            from api.dependencies import get_process_gateway
            mock_gateway = MagicMock()
            mock_gateway.run_command.return_value = mock_run
            app.dependency_overrides[get_process_gateway] = lambda: mock_gateway
            try:
                resp = await client.get("/v1/setup/requirements")
            finally:
                app.dependency_overrides.pop(get_process_gateway, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["bundled_services"]["details"]["perplexica"]["exists"] is True
        assert body["bundled_services"]["details"]["external_services"]["exists"] is True

    @pytest.mark.asyncio
    async def test_requirements_docker_info_timeout(self, client, app, temp_dir):
        """Docker info timeout (docker installed but daemon not responding)."""
        import subprocess as real_subprocess

        def _mock_run(cmd, *args, **kwargs):
            if cmd == ["python3", "--version"]:
                m = MagicMock()
                m.returncode = 0
                m.stdout = "Python 3.11.0"
                return m
            if cmd == ["docker", "--version"]:
                m = MagicMock()
                m.returncode = 0
                return m
            if cmd[0] == "docker" and "info" in cmd:
                raise real_subprocess.TimeoutExpired(cmd, 10)
            if cmd[0] == "docker" and "images" in cmd:
                raise FileNotFoundError()
            return MagicMock(returncode=1)

        with patch("application.setup.setup_service.get_app_root", return_value=temp_dir), \
             patch("data.database.repositories.setup_state_repository.get_app_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_bundle_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_install_root", return_value=temp_dir):
            from api.dependencies import get_process_gateway
            mock_gateway = MagicMock()
            mock_gateway.run_command.side_effect = _mock_run
            app.dependency_overrides[get_process_gateway] = lambda: mock_gateway
            try:
                resp = await client.get("/v1/setup/requirements")
            finally:
                app.dependency_overrides.pop(get_process_gateway, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["docker_daemon"]["installed"] is True
        assert body["docker_daemon"]["running"] is False

    @pytest.mark.asyncio
    async def test_requirements_inference_engine_detection(self, client, app, temp_dir):
        """Inference venv engine detection (pip-only fallback when no vllm binary)."""
        mock_run = MagicMock()
        mock_run.returncode = 0
        mock_run.stdout = "Python 3.11.0"

        # Create fake inference venv with python but no vllm
        inf_venv = temp_dir / "venv-inference"
        (inf_venv / "bin").mkdir(parents=True)
        (inf_venv / "bin" / "python").write_text("#!/bin/bash")

        # Patch settings to use our temp venv path (real settings may point elsewhere)
        mock_settings = MagicMock()
        mock_settings.interpreter.external_server_venv_python = str(inf_venv / "bin" / "python")
        mock_settings.inference.venv_path = str(inf_venv)
        mock_settings.inference.models_dir = str(temp_dir / "models")

        with patch("application.setup.setup_service.get_app_root", return_value=temp_dir), \
             patch("data.database.repositories.setup_state_repository.get_app_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_bundle_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_install_root", return_value=temp_dir), \
             patch("config.settings.get_settings", return_value=mock_settings):
            from api.dependencies import get_process_gateway
            mock_gateway = MagicMock()
            mock_gateway.run_command.return_value = mock_run
            app.dependency_overrides[get_process_gateway] = lambda: mock_gateway
            try:
                resp = await client.get("/v1/setup/requirements")
            finally:
                app.dependency_overrides.pop(get_process_gateway, None)

        assert resp.status_code == 200
        body = resp.json()
        # Engine detected as pip-only since no vllm/vllm-mlx binary
        assert body["venv_inference"]["engine"] == "pip-only"

    @pytest.mark.asyncio
    async def test_requirements_inference_engine_vllm(self, client, app, temp_dir):
        """Inference venv engine detection: vllm (not mlx) binary present."""
        mock_run = MagicMock()
        mock_run.returncode = 0
        mock_run.stdout = "Python 3.11.0"

        inf_venv = temp_dir / "venv-inference"
        (inf_venv / "bin").mkdir(parents=True)
        (inf_venv / "bin" / "python").write_text("#!/bin/bash")
        (inf_venv / "bin" / "vllm").write_text("#!/bin/bash")  # vllm, not vllm-mlx

        mock_settings = MagicMock()
        mock_settings.interpreter.external_server_venv_python = str(inf_venv / "bin" / "python")
        mock_settings.inference.venv_path = str(inf_venv)
        mock_settings.inference.models_dir = str(temp_dir / "models")

        with patch("application.setup.setup_service.get_app_root", return_value=temp_dir), \
             patch("data.database.repositories.setup_state_repository.get_app_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_bundle_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_install_root", return_value=temp_dir), \
             patch("config.settings.get_settings", return_value=mock_settings):
            from api.dependencies import get_process_gateway
            mock_gateway = MagicMock()
            mock_gateway.run_command.return_value = mock_run
            app.dependency_overrides[get_process_gateway] = lambda: mock_gateway
            try:
                resp = await client.get("/v1/setup/requirements")
            finally:
                app.dependency_overrides.pop(get_process_gateway, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["venv_inference"]["engine"] == "vllm"

    @pytest.mark.asyncio
    async def test_requirements_inference_model_check_failure(self, client, app, temp_dir):
        """Inference model check exception returns graceful fallback."""
        mock_run = MagicMock()
        mock_run.returncode = 0
        mock_run.stdout = "Python 3.11.0"

        with patch("application.setup.setup_service.get_app_root", return_value=temp_dir), \
             patch("data.database.repositories.setup_state_repository.get_app_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_bundle_root", return_value=temp_dir), \
             patch("application.setup.setup_service.get_install_root", return_value=temp_dir), \
             patch("services.aether_inference.platform_detector.get_recommended_models_status",
                   side_effect=RuntimeError("model scan failed")):
            from api.dependencies import get_process_gateway
            mock_gateway = MagicMock()
            mock_gateway.run_command.return_value = mock_run
            app.dependency_overrides[get_process_gateway] = lambda: mock_gateway
            try:
                resp = await client.get("/v1/setup/requirements")
            finally:
                app.dependency_overrides.pop(get_process_gateway, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["inference_models"]["complete"] is False
        assert "error" in body["inference_models"]

    @pytest.mark.asyncio
    async def test_python_missing(self, client, app, temp_dir):
        """Python3 check handles FileNotFoundError."""
        def _mock_run(cmd, *args, **kwargs):
            if cmd[0] == "python3":
                raise FileNotFoundError("python3 not found")
            if cmd[0] == "docker":
                raise FileNotFoundError("docker not found")
            return MagicMock(returncode=1)

        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ), patch(
            "application.setup.setup_service.get_bundle_root",
            return_value=temp_dir,
        ), patch(
            "application.setup.setup_service.get_install_root",
            return_value=temp_dir,
        ):
            from api.dependencies import get_process_gateway
            mock_gateway = MagicMock()
            mock_gateway.run_command.side_effect = _mock_run
            app.dependency_overrides[get_process_gateway] = lambda: mock_gateway
            try:
                resp = await client.get("/v1/setup/requirements")
            finally:
                app.dependency_overrides.pop(get_process_gateway, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["python3"]["installed"] is False
        assert body["overall_ready"] is False


# ===================================================================
# POST /v1/setup/start
# ===================================================================


class TestSetupStart:

    @pytest.mark.asyncio
    async def test_start_script_not_found(self, client, temp_dir):
        """Missing setup script returns 500."""
        logs_dir = temp_dir / "logs"
        logs_dir.mkdir()
        # No progress file => idle phase

        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ), patch(
            "application.setup.setup_service.get_install_root",
            return_value=temp_dir,
        ), patch(
            "application.setup.setup_service.get_bundle_root",
            return_value=temp_dir,
        ):
            resp = await client.post("/v1/setup/start")

        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_start_already_in_progress_kills_old_and_restarts(self, client, app, temp_dir):
        """Setup already running returns early message."""
        logs_dir = temp_dir / "logs"
        logs_dir.mkdir()
        progress_data = {
            "repositories": {"status": "in_progress", "progress": 50, "message": "Cloning", "items": []},
            "python_packages": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
            "oi_environment": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
            "ml_models": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
            "docker_services": {"status": "pending", "progress": 0, "message": "Waiting", "items": []},
            "total_progress": 10,
            "current_phase": "repositories",
        }
        (logs_dir / "setup_progress.json").write_text(json.dumps(progress_data))
        (logs_dir / "setup_engine.pid").write_text("999999") # fake PID

        with patch("application.setup.setup_service.get_app_root", return_value=temp_dir), \
             patch("data.database.repositories.setup_state_repository.get_app_root", return_value=temp_dir), \
             patch("os.killpg") as mock_killpg, \
             patch("os.getpgid", return_value=12345):
            
            from api.dependencies import get_process_gateway
            from core.system.models import WorkerHealthStatus, ProcessStatus
            mock_gateway = MagicMock()
            mock_gateway.check_process_health.return_value = WorkerHealthStatus(
                running=True,
                pid=999999,
                status=ProcessStatus.HEALTHY
            )
            app.dependency_overrides[get_process_gateway] = lambda: mock_gateway
            try:
                resp = await client.post("/v1/setup/start")
            finally:
                app.dependency_overrides.pop(get_process_gateway, None)

        assert resp.status_code == 200
        assert "initiated" in resp.json()["message"].lower()
        mock_killpg.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_service_exception_returns_500(self, client, temp_dir):
        """Exception when triggering setup returns 500."""
        with patch(
            "application.setup.setup_service.SetupService.trigger_setup",
            side_effect=RuntimeError("queue full"),
        ):
            resp = await client.post("/v1/setup/start")

        assert resp.status_code == 500
        assert "Failed to launch setup engine" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_start_launches_script(self, client, temp_dir):
        """Setup start finds script and initiates background task."""
        logs_dir = temp_dir / "logs"
        logs_dir.mkdir()
        core_sys_dir = temp_dir / "core" / "system"
        core_sys_dir.mkdir(parents=True)
        (core_sys_dir / "setup_engine.py").write_text("print('setup')")

        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ), patch(
            "application.setup.setup_service.get_install_root",
            return_value=temp_dir,
        ), patch(
            "application.setup.setup_service.get_bundle_root",
            return_value=temp_dir,
        ):
            resp = await client.post("/v1/setup/start")

        assert resp.status_code == 200
        body = resp.json()
        assert "initiated" in body["message"].lower()
        # Progress file should be initialized
        progress_file = logs_dir / "setup_progress.json"
        assert progress_file.exists()
        data = json.loads(progress_file.read_text())
        assert data["current_phase"] == "starting"


# ===================================================================
# POST /v1/setup/skip (disabled by hard-block policy)
# ===================================================================


class TestSetupSkip:

    @pytest.mark.asyncio
    async def test_skip_is_disabled_with_403(self, client, temp_dir):
        """Skip endpoint is blocked and must not mutate progress state."""
        logs_dir = temp_dir / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)

        with patch(
            "application.setup.setup_service.get_app_root",
            return_value=temp_dir,
        ), patch(
            "data.database.repositories.setup_state_repository.get_app_root",
            return_value=temp_dir,
        ):
            resp = await client.post("/v1/setup/skip")

        assert resp.status_code == 403
        assert "disabled" in resp.json()["detail"].lower()
        progress_file = logs_dir / "setup_progress.json"
        assert not progress_file.exists()


# ===================================================================
# POST /v1/setup/finalize
# ===================================================================


class TestSetupFinalize:

    @staticmethod
    def _mock_finalize_settings():
        settings = MagicMock()
        settings.supabase.url = "http://localhost:54321"
        settings.supabase.anon_key = "test.anon.key"
        settings.supabase.service_role_key = "test.sr.key"
        settings.supabase.db_schema = "public"
        settings.supabase.realtime_enabled = False
        settings.redis = MagicMock()
        settings.redis.url = "redis://localhost:6379/0"
        settings.redis.namespace = "aether"
        return settings

    @pytest.mark.asyncio
    async def test_finalize_disables_skip_health_check_before_probe(self, client, app, monkeypatch):
        """Finalize must clear SKIP_SERVICE_HEALTH_CHECK before health probing services."""
        monkeypatch.setenv("SKIP_SERVICE_HEALTH_CHECK", "true")
        settings = self._mock_finalize_settings()

        fake_supabase = MagicMock()
        fake_supabase.initialize = AsyncMock(return_value=None)

        observed_skip = {}

        async def _ensure_supabase_running(**kwargs):
            observed_skip["value"] = os.getenv("SKIP_SERVICE_HEALTH_CHECK")
            return True

        from api.dependencies import get_settings
        app.dependency_overrides[get_settings] = lambda: settings

        try:
            with patch("api.dependencies.get_database_connection", return_value=None), \
                 patch("core.system.connection_manager.ConnectionManager.set_database_gateway") as mock_set_db, \
                 patch("core.system.connection_manager.ConnectionManager.set_file_indexing_repository") as mock_set_repo, \
                 patch("core.integrations.providers.supabase_docker.ensure_supabase_running", side_effect=_ensure_supabase_running), \
                 patch("data.database.clients.supabase.SupabaseClient.from_env", return_value=fake_supabase), \
                 patch("data.database.migration_runner.run_migrations", new=AsyncMock(return_value=True)), \
                 patch("application.agents.agent_seeder.seed_missing_agents", new=AsyncMock(return_value=None)):
                resp = await client.post("/v1/setup/finalize")

            assert resp.status_code == 200
            body = resp.json()
            assert body["status"] == "ok"
            assert observed_skip["value"] == "false"
            assert os.getenv("SKIP_SERVICE_HEALTH_CHECK") == "false"
            assert mock_set_db.call_count == 1
            assert mock_set_repo.call_count == 1
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_finalize_does_not_wire_up_globals_on_degraded_status(self, client, app, monkeypatch):
        """Finalize must NOT wire up globals if services are degraded (new policy)."""
        monkeypatch.setenv("SKIP_SERVICE_HEALTH_CHECK", "true")
        settings = self._mock_finalize_settings()

        fake_supabase = MagicMock()
        fake_supabase.initialize = AsyncMock(return_value=None)

        from api.dependencies import get_settings
        app.dependency_overrides[get_settings] = lambda: settings

        try:
            with patch("api.dependencies.get_database_connection", return_value=None), \
                 patch("core.system.connection_manager.ConnectionManager.set_database_gateway") as mock_set_db, \
                 patch("core.system.connection_manager.ConnectionManager.set_file_indexing_repository") as mock_set_repo, \
                 patch("core.integrations.providers.supabase_docker.ensure_supabase_running", return_value=False), \
                 patch("data.database.clients.supabase.SupabaseClient.from_env", return_value=fake_supabase), \
                 patch("data.database.migration_runner.run_migrations", new=AsyncMock(return_value=True)), \
                 patch("application.agents.agent_seeder.seed_missing_agents", new=AsyncMock(return_value=None)):
                resp = await client.post("/v1/setup/finalize")

            assert resp.status_code == 200
            body = resp.json()
            assert body["status"] == "degraded"
            # Crucial: globals must NOT be set if status is degraded
            assert mock_set_db.call_count == 0
            assert mock_set_repo.call_count == 0
        finally:
            app.dependency_overrides.pop(get_settings, None)

    @pytest.mark.asyncio
    async def test_complete_onboarding_endpoint(self, client, app):
        """Complete onboarding endpoint delegates to SetupService."""
        payload = {"test": "data"}
        
        mock_service = MagicMock()
        mock_service.complete_onboarding = AsyncMock(return_value=None)
        
        from api.dependencies import get_setup_service
        app.dependency_overrides[get_setup_service] = lambda: mock_service
        
        try:
            resp = await client.post("/v1/setup/complete", json=payload)
            assert resp.status_code == 200
            assert resp.json()["status"] == "ok"
            mock_service.complete_onboarding.assert_awaited_once_with(payload)
        finally:
            app.dependency_overrides.pop(get_setup_service, None)

    @pytest.mark.asyncio
    async def test_finalize_returns_503_when_migrations_fail(self, client, app, monkeypatch):
        """Migration failure is critical and must block finalize success."""
        monkeypatch.setenv("SKIP_SERVICE_HEALTH_CHECK", "true")
        settings = self._mock_finalize_settings()

        fake_supabase = MagicMock()
        fake_supabase.initialize = AsyncMock(return_value=None)

        from api.dependencies import get_settings
        app.dependency_overrides[get_settings] = lambda: settings

        try:
            with patch("api.dependencies.get_database_connection", return_value=None), \
                 patch("core.system.connection_manager.ConnectionManager.set_database_gateway") as mock_set_db, \
                 patch("core.system.connection_manager.ConnectionManager.set_file_indexing_repository") as mock_set_repo, \
                 patch("core.integrations.providers.supabase_docker.ensure_supabase_running", new=AsyncMock(return_value=True)), \
                 patch("data.database.clients.supabase.SupabaseClient.from_env", return_value=fake_supabase), \
                 patch("data.database.migration_runner.run_migrations", new=AsyncMock(return_value=False)):
                resp = await client.post("/v1/setup/finalize")

            assert resp.status_code == 503
            assert "Database migrations failed or partially applied" in resp.json()["error"]["message"]
            assert mock_set_db.call_count == 0
            assert mock_set_repo.call_count == 0
        finally:
            app.dependency_overrides.pop(get_settings, None)

