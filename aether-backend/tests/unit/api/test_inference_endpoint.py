"""
Unit tests for Inference endpoints (/v1/inference/*).

11 endpoints delegating to InferenceManager singleton.
Tests verify response structure, error propagation, model pull lifecycle,
platform detection, and download-all logic.

No bugs found during audit — source has clean structure with no try/except
blocks (relies on FastAPI middleware for unhandled exceptions).

CI: pytest tests/unit/api/test_inference_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# =============================================================================
# STATUS / HEALTH
# =============================================================================


class TestInferenceStatus:
    """GET /v1/inference/status and /health."""

    @pytest.mark.asyncio
    async def test_status_returns_dict(self, client):
        """GET /v1/inference/status returns dict with status info."""
        resp = await client.get("/v1/inference/status")
        assert resp.status_code == 200
        assert isinstance(resp.json(), dict)

    @pytest.mark.asyncio
    async def test_health_returns_dict(self, client):
        """GET /v1/inference/health returns dict."""
        resp = await client.get("/v1/inference/health")
        assert resp.status_code == 200
        assert isinstance(resp.json(), dict)


# =============================================================================
# START / STOP / RESTART
# =============================================================================


class TestInferenceLifecycle:
    """POST /v1/inference/start, /stop, /restart."""

    @pytest.mark.asyncio
    async def test_start_success(self, client):
        """Start returns manager's success dict."""
        mock_mgr = AsyncMock()
        mock_mgr.start = AsyncMock(return_value={"status": "started", "model": "glm-ocr"})
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.post("/v1/inference/start")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "started"
        assert body["model"] == "glm-ocr"
        mock_mgr.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_with_specific_model(self, client):
        """Start with specific model passes model kwarg to manager."""
        mock_mgr = AsyncMock()
        mock_mgr.start = AsyncMock(return_value={"status": "started", "model": "custom-model"})
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.post("/v1/inference/start", json={"model": "custom-model"})
        assert resp.status_code == 200
        mock_mgr.start.assert_called_once_with(model="custom-model")

    @pytest.mark.asyncio
    async def test_start_error_503(self, client):
        """Manager returns error dict → 503 with error detail."""
        mock_mgr = AsyncMock()
        mock_mgr.start = AsyncMock(return_value={"status": "error", "error": "GPU busy"})
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.post("/v1/inference/start")
        assert resp.status_code == 503
        assert "GPU busy" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_start_error_no_detail_fallback(self, client):
        """Manager returns error without 'error' key → 503 with fallback message."""
        mock_mgr = AsyncMock()
        mock_mgr.start = AsyncMock(return_value={"status": "error"})
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.post("/v1/inference/start")
        assert resp.status_code == 503
        assert "Failed to start" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_stop_success(self, client):
        """Stop returns manager's response."""
        mock_mgr = AsyncMock()
        mock_mgr.stop = AsyncMock(return_value={"status": "stopped"})
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.post("/v1/inference/stop")
        assert resp.status_code == 200
        assert resp.json()["status"] == "stopped"

    @pytest.mark.asyncio
    async def test_restart_success(self, client):
        """Restart returns manager's response."""
        mock_mgr = AsyncMock()
        mock_mgr.restart = AsyncMock(return_value={"status": "restarted"})
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.post("/v1/inference/restart")
        assert resp.status_code == 200
        assert resp.json()["status"] == "restarted"

    @pytest.mark.asyncio
    async def test_restart_with_specific_model(self, client):
        """Restart with model passes kwarg to manager."""
        mock_mgr = AsyncMock()
        mock_mgr.restart = AsyncMock(return_value={"status": "restarted", "model": "new-model"})
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.post("/v1/inference/restart", json={"model": "new-model"})
        assert resp.status_code == 200
        mock_mgr.restart.assert_called_once_with(model="new-model")


# =============================================================================
# MODELS — LIST / PULL / PROGRESS
# =============================================================================


class TestInferenceModels:
    """GET /v1/inference/models, POST /models/pull, GET /models/pull/{id}."""

    @pytest.mark.asyncio
    async def test_list_models_structure(self, client):
        """List models returns {models: list} with exact items."""
        mock_mgr = AsyncMock()
        mock_mgr.list_models = AsyncMock(return_value=[
            {"id": "model-a", "name": "Model A"},
        ])
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.get("/v1/inference/models")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"models": [{"id": "model-a", "name": "Model A"}]}

    @pytest.mark.asyncio
    async def test_pull_model_success(self, client):
        """Pull model returns job progress with exact fields."""
        progress = MagicMock()
        progress.job_id = "pull-job-1"
        progress.model = "mlx-community/GLM-OCR"
        progress.status = "downloading"
        progress.progress_pct = 0.0
        progress.error = None

        mock_mgr = AsyncMock()
        mock_mgr.pull_model = AsyncMock(return_value=progress)
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.post("/v1/inference/models/pull", json={"model": "mlx-community/GLM-OCR"})
        assert resp.status_code == 200
        body = resp.json()
        assert body == {
            "job_id": "pull-job-1",
            "model": "mlx-community/GLM-OCR",
            "status": "downloading",
            "progress_pct": 0.0,
            "error": None,
        }
        mock_mgr.pull_model.assert_called_once_with(model="mlx-community/GLM-OCR")

    @pytest.mark.asyncio
    async def test_pull_model_missing_model_422(self, client):
        """Pull model without model field → 422."""
        resp = await client.post("/v1/inference/models/pull", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_pull_progress_found(self, client):
        """Get pull progress for existing job returns full progress."""
        progress = MagicMock()
        progress.job_id = "job-42"
        progress.model = "model-y"
        progress.status = "downloading"
        progress.progress_pct = 65.5
        progress.downloaded_bytes = 1048576
        progress.total_bytes = 2097152
        progress.error = None

        mock_mgr = MagicMock()
        mock_mgr.get_pull_progress = MagicMock(return_value=progress)
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.get("/v1/inference/models/pull/job-42")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {
            "job_id": "job-42",
            "model": "model-y",
            "status": "downloading",
            "progress_pct": 65.5,
            "downloaded_bytes": 1048576,
            "total_bytes": 2097152,
            "error": None,
        }

    @pytest.mark.asyncio
    async def test_pull_progress_not_found_404(self, client):
        """Get pull progress for missing job → 404."""
        mock_mgr = MagicMock()
        mock_mgr.get_pull_progress = MagicMock(return_value=None)
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.get("/v1/inference/models/pull/nonexistent-job")
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()


# =============================================================================
# PLATFORM
# =============================================================================


class TestInferencePlatform:
    """GET /v1/inference/platform."""

    @pytest.mark.asyncio
    async def test_platform_info_exact_fields(self, client):
        """Platform info returns all expected fields with exact values."""
        mock_pinfo = MagicMock()
        mock_pinfo.os = "Darwin"
        mock_pinfo.arch = "arm64"
        mock_pinfo.gpu = MagicMock(value="apple_metal")
        mock_pinfo.gpu_name = "Apple M2"
        mock_pinfo.gpu_memory_gb = 16.0
        mock_pinfo.engine = MagicMock(value="vllm-mlx")
        mock_pinfo.engine_display_name = "vLLM-MLX"
        mock_pinfo.is_apple_silicon = True
        mock_pinfo.is_nvidia = False
        mock_pinfo.glm_ocr_model = "mlx-community/GLM-OCR"
        mock_pinfo.pip_install_target = "vllm-mlx"

        mock_mgr = MagicMock()
        mock_mgr.platform_info = mock_pinfo
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.get("/v1/inference/platform")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {
            "os": "Darwin",
            "arch": "arm64",
            "gpu": "apple_metal",
            "gpu_name": "Apple M2",
            "gpu_memory_gb": 16.0,
            "engine": "vllm-mlx",
            "engine_display_name": "vLLM-MLX",
            "is_apple_silicon": True,
            "is_nvidia": False,
            "glm_ocr_model": "mlx-community/GLM-OCR",
            "pip_install_target": "vllm-mlx",
        }

    @pytest.mark.asyncio
    async def test_platform_detection_failed_500(self, client):
        """Platform info is None → 500."""
        mock_mgr = MagicMock()
        mock_mgr.platform_info = None
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr):
            resp = await client.get("/v1/inference/platform")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Platform detection failed"


# =============================================================================
# RECOMMENDED MODELS / DOWNLOAD ALL
# =============================================================================


class TestInferenceRecommendedModels:
    """GET /recommended-models, POST /recommended-models/download-all."""

    @pytest.mark.asyncio
    async def test_recommended_models_structure(self, client):
        """Recommended models returns models list + platform info."""
        resp = await client.get("/v1/inference/recommended-models")
        assert resp.status_code == 200
        body = resp.json()
        assert "models" in body
        assert "platform" in body
        assert isinstance(body["models"], list)
        assert isinstance(body["platform"], dict)

    @pytest.mark.asyncio
    async def test_download_all_triggers_missing_only(self, client):
        """Download-all only pulls models not yet downloaded."""
        mock_pinfo = MagicMock()
        mock_pinfo.engine = MagicMock(value="vllm-mlx")
        mock_pinfo.engine_display_name = "vLLM-MLX"
        mock_pinfo.gpu = MagicMock(value="apple_metal")
        mock_pinfo.gpu_name = "Apple M2"

        progress = MagicMock()
        progress.job_id = "dl-1"
        progress.status = "started"
        progress.error = None

        mock_mgr = AsyncMock()
        mock_mgr.platform_info = mock_pinfo
        mock_mgr._models_dir = "/path/to/models"
        mock_mgr.pull_model = AsyncMock(return_value=progress)

        mock_models = [
            {"model_id": "model-a", "role": "text", "downloaded": True},
            {"model_id": "model-b", "role": "ocr", "downloaded": False},
        ]
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr), \
             patch("services.aether_inference.platform_detector.get_recommended_models_status", return_value=mock_models):
            resp = await client.post("/v1/inference/recommended-models/download-all")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["jobs"]) == 1
        assert body["jobs"][0] == {
            "model_id": "model-b",
            "role": "ocr",
            "job_id": "dl-1",
            "status": "started",
            "error": None,
        }
        assert body["already_downloaded"] == ["model-a"]
        mock_mgr.pull_model.assert_called_once_with("model-b")

    @pytest.mark.asyncio
    async def test_download_all_when_all_already_downloaded(self, client):
        """Download-all when all models present → empty jobs, full already_downloaded."""
        mock_pinfo = MagicMock()
        mock_pinfo.engine = MagicMock(value="vllm-mlx")
        mock_pinfo.engine_display_name = "vLLM-MLX"
        mock_pinfo.gpu = MagicMock(value="apple_metal")
        mock_pinfo.gpu_name = "Apple M2"

        mock_mgr = AsyncMock()
        mock_mgr.platform_info = mock_pinfo
        mock_mgr._models_dir = "/path/to/models"

        mock_models = [
            {"model_id": "model-a", "role": "text", "downloaded": True},
            {"model_id": "model-b", "role": "ocr", "downloaded": True},
        ]
        with patch("api.v1.endpoints.inference._get_manager", return_value=mock_mgr), \
             patch("services.aether_inference.platform_detector.get_recommended_models_status", return_value=mock_models):
            resp = await client.post("/v1/inference/recommended-models/download-all")
        assert resp.status_code == 200
        body = resp.json()
        assert body["jobs"] == []
        assert body["already_downloaded"] == ["model-a", "model-b"]
        mock_mgr.pull_model.assert_not_called()


# =============================================================================
# AGENT DEFAULTS
# =============================================================================


class TestInferenceAgentDefaults:
    """GET /v1/inference/agent-defaults."""

    @pytest.mark.asyncio
    async def test_agent_defaults_structure(self, client):
        """Agent defaults returns agent_defaults dict + fallback_default."""
        resp = await client.get("/v1/inference/agent-defaults")
        assert resp.status_code == 200
        body = resp.json()
        assert "agent_defaults" in body
        assert "fallback_default" in body
        assert isinstance(body["agent_defaults"], dict)
        assert isinstance(body["fallback_default"], dict)
        # _default key should be excluded from agent_defaults
        assert "_default" not in body["agent_defaults"]
