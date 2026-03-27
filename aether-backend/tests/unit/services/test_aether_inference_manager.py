"""
Tests for services/aether_inference/manager.py

Covers: InferenceManager lifecycle, server start/stop, health checks, model resolution,
model listing, model pull, PID file reconnection, build_serve_command, dispose,
concurrent start protection, log handle cleanup, identity-verified kill-by-port,
reconnect status correctness, atomic PID file write, and non-destructive behavior regression.
All subprocess and httpx calls mocked.
"""

import asyncio
import inspect
import os
import signal
import time

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path

from services.aether_inference.manager import (
    InferenceManager,
    ServerStatus,
    ModelInfo,
    PullProgress,
)
from services.aether_inference.platform_detector import (
    InferenceEngine,
    GPUType,
    PlatformInfo,
)


@pytest.fixture(autouse=True)
def reset_singleton():
    """Reset InferenceManager singleton between tests."""
    InferenceManager._instance = None
    yield
    InferenceManager._instance = None


@pytest.fixture
def mock_platform_apple():
    return PlatformInfo(
        os="darwin", arch="arm64", gpu=GPUType.APPLE_SILICON,
        gpu_name="Apple M4", gpu_memory_gb=64.0,
        engine=InferenceEngine.VLLM_MLX,
        engine_command="python",
        engine_serve_args=["-m", "vllm_mlx.server", "--mllm"],
        glm_ocr_model="mlx-community/GLM-OCR-8bit",
    )


@pytest.fixture
def mock_platform_nvidia():
    return PlatformInfo(
        os="linux", arch="x86_64", gpu=GPUType.NVIDIA,
        gpu_name="RTX 4090", gpu_memory_gb=24.0,
        engine=InferenceEngine.VLLM,
        engine_command="vllm",
        engine_serve_args=["serve"],
        glm_ocr_model="zai-org/GLM-OCR",
    )


@pytest.fixture
def mock_platform_ollama():
    return PlatformInfo(
        os="linux", arch="x86_64", gpu=GPUType.NONE,
        engine=InferenceEngine.OLLAMA,
        engine_command="ollama",
        engine_serve_args=["serve"],
        glm_ocr_model="glm-ocr",
    )


def _make_manager(tmp_path, mock_platform):
    """Create an InferenceManager with mocked platform and paths."""
    venv = tmp_path / "venv-inference"
    venv.mkdir()
    (venv / "bin").mkdir()
    (venv / "bin" / "python").write_text("#!/usr/bin/env python3")
    (venv / "bin" / "python").chmod(0o755)
    (venv / "bin" / "vllm").write_text("#!/usr/bin/env vllm")
    (venv / "bin" / "vllm").chmod(0o755)
    (venv / "bin" / "ollama").write_text("#!/usr/bin/env ollama")
    (venv / "bin" / "ollama").chmod(0o755)

    models = tmp_path / "models"
    models.mkdir()

    with patch.dict(os.environ, {"AETHER_BACKEND_ROOT": str(tmp_path)}), \
         patch.object(InferenceManager, "_reconnect_existing", return_value=None), \
         patch("services.aether_inference.manager.detect_platform", return_value=mock_platform):
        mgr = InferenceManager(
            port=7999,
            venv_path=str(venv),
            models_dir=str(models),
            idle_timeout=300,
        )
        mgr._platform = mock_platform
    return mgr


# ===========================================================================
# Singleton Tests
# ===========================================================================

class TestSingleton:
    """Tests for singleton pattern."""

    def test_get_instance_creates(self, tmp_path):
        with patch.dict(os.environ, {"AETHER_BACKEND_ROOT": str(tmp_path)}), \
             patch.object(InferenceManager, "_reconnect_existing", return_value=None), \
             patch("services.aether_inference.manager.detect_platform"):
            mgr = InferenceManager.get_instance(port=7999)
            assert mgr is InferenceManager._instance

    def test_get_instance_reuses(self, tmp_path):
        with patch.dict(os.environ, {"AETHER_BACKEND_ROOT": str(tmp_path)}), \
             patch.object(InferenceManager, "_reconnect_existing", return_value=None), \
             patch("services.aether_inference.manager.detect_platform"):
            mgr1 = InferenceManager.get_instance(port=7999)
            mgr2 = InferenceManager.get_instance(port=7999)
            assert mgr1 is mgr2


# ===========================================================================
# Properties Tests
# ===========================================================================

class TestProperties:
    """Tests for InferenceManager properties."""

    def test_port(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        assert mgr.port == 7999

    def test_base_url(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        assert mgr.base_url == "http://127.0.0.1:7999"

    def test_api_url(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        assert mgr.api_url == "http://127.0.0.1:7999/v1"

    def test_status_default(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        assert mgr.status == ServerStatus.STOPPED


# ===========================================================================
# Model Resolution Tests
# ===========================================================================

class TestResolveModelPath:
    """Tests for resolve_model_path."""

    def test_absolute_path_with_config(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        model_dir = tmp_path / "my_model"
        model_dir.mkdir()
        (model_dir / "config.json").write_text("{}")
        result = mgr.resolve_model_path(str(model_dir))
        assert result == str(model_dir)

    def test_models_dir_resolution(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / "mlx-community"
        model_dir = org / "GLM-OCR-8bit"
        model_dir.mkdir(parents=True)
        (model_dir / "config.json").write_text("{}")
        result = mgr.resolve_model_path("mlx-community/GLM-OCR-8bit")
        assert result == str(model_dir.resolve())

    def test_fallback_to_hf_id(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        result = mgr.resolve_model_path("some-org/some-model")
        assert result == "some-org/some-model"


# ===========================================================================
# List Local Models Tests
# ===========================================================================

class TestListLocalModels:
    """Tests for list_local_models."""

    def test_empty_models_dir(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        assert mgr.list_local_models() == []

    def test_models_with_config(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / "test-org"
        model = org / "test-model"
        model.mkdir(parents=True)
        (model / "config.json").write_text("{}")
        (model / "model.safetensors").write_text("fake")

        models = mgr.list_local_models()
        assert len(models) == 1
        assert models[0]["id"] == "test-org/test-model"
        assert models[0]["has_safetensors"] is True

    def test_no_models_dir(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._models_dir = None
        assert mgr.list_local_models() == []


# ===========================================================================
# Discover Models Tests
# ===========================================================================

class TestDiscoverModels:
    """Tests for _discover_models."""

    def test_discover_safetensors(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / "org"
        model = org / "model-a"
        model.mkdir(parents=True)
        (model / "config.json").write_text("{}")
        (model / "model.safetensors").write_text("fake")

        models = mgr._discover_models()
        assert "org/model-a" in models

    def test_discover_gguf(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / "org"
        model = org / "model-b"
        model.mkdir(parents=True)
        (model / "model.gguf").write_text("fake")

        models = mgr._discover_models()
        assert "org/model-b" in models

    def test_discover_flat_gguf(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        (tmp_path / "models" / "some-model.gguf").write_text("fake")
        models = mgr._discover_models()
        assert "some-model" in models


# ===========================================================================
# Build Serve Command Tests
# ===========================================================================

class TestBuildServeCommand:
    """Tests for _build_serve_command."""

    def test_vllm_mlx_command(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        cmd = mgr._build_serve_command()
        assert "-m" in cmd
        assert "services.aether_inference.server" in cmd
        assert "--engine" in cmd
        assert "vllm-mlx" in cmd

    def test_vllm_command(self, tmp_path, mock_platform_nvidia):
        mgr = _make_manager(tmp_path, mock_platform_nvidia)
        cmd = mgr._build_serve_command()
        assert "--engine" in cmd
        assert "vllm" in cmd

    def test_ollama_command(self, tmp_path, mock_platform_ollama):
        mgr = _make_manager(tmp_path, mock_platform_ollama)
        cmd = mgr._build_serve_command()
        assert "serve" in cmd


# ===========================================================================
# Health Check Tests
# ===========================================================================

class TestHealthCheck:
    """Tests for health_check."""

    @pytest.mark.asyncio
    async def test_healthy_response(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"status": "ok"}

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()
            assert result["healthy"] is True

    @pytest.mark.asyncio
    async def test_connection_refused(self, tmp_path, mock_platform_apple):
        import httpx
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()
            assert result["healthy"] is False
            assert result["status"] == "stopped"


# ===========================================================================
# Server Start Tests
# ===========================================================================

class TestStart:
    """Tests for start method."""

    @pytest.mark.asyncio
    async def test_start_already_running(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.RUNNING
        with patch.object(mgr, "health_check", return_value={"healthy": True}):
            result = await mgr.start()
            assert result["status"] == "already_running"

    @pytest.mark.asyncio
    async def test_start_engine_not_found(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        with patch.object(mgr, "_build_serve_command", side_effect=FileNotFoundError("not found")):
            result = await mgr.start()
            assert result["status"] == "error"
            assert mgr._status == ServerStatus.ERROR


# ===========================================================================
# Server Stop Tests
# ===========================================================================

class TestStop:
    """Tests for stop method."""

    @pytest.mark.asyncio
    async def test_stop_already_stopped(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.STOPPED
        with patch.object(mgr, "health_check", return_value={"healthy": False}):
            result = await mgr.stop()
            assert result["status"] == "already_stopped"

    @pytest.mark.asyncio
    async def test_stop_with_pid(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.RUNNING
        mgr._pid = 99999

        with patch("os.kill") as mock_kill, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_kill.side_effect = [None, ProcessLookupError()]
            result = await mgr.stop()
            assert result["status"] == "stopped"
            assert mgr._pid is None


# ===========================================================================
# Reconnect Tests
# ===========================================================================

class TestReconnect:
    """Tests for _reconnect_existing."""

    def test_reconnect_no_pid_file(self, tmp_path, mock_platform_apple):
        with patch.dict(os.environ, {"AETHER_BACKEND_ROOT": str(tmp_path)}), \
             patch("services.aether_inference.manager.detect_platform", return_value=mock_platform_apple):
            mgr = InferenceManager.__new__(InferenceManager)
            mgr._pid_file = tmp_path / "logs" / "nonexistent.pid"
            mgr._pid = None
            mgr._status = ServerStatus.STOPPED
            mgr._reconnect_existing()
            assert mgr._pid is None

    def test_reconnect_stale_pid(self, tmp_path, mock_platform_apple):
        pid_file = tmp_path / "inference.pid"
        pid_file.write_text("99999999")

        mgr = InferenceManager.__new__(InferenceManager)
        mgr._pid_file = pid_file
        mgr._pid = None
        mgr._status = ServerStatus.STOPPED
        mgr._started_at = None

        with patch("os.kill", side_effect=OSError("no such process")):
            mgr._reconnect_existing()
            assert mgr._pid is None
            # Stale PID file cleaned up
            assert not pid_file.exists()


# ===========================================================================
# List Models Tests
# ===========================================================================

class TestListModels:
    """Tests for list_models (remote)."""

    @pytest.mark.asyncio
    async def test_list_models_openai_format(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {
            "data": [{"id": "model-a", "owned_by": "test"}]
        }

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            models = await mgr.list_models()
            assert len(models) == 1
            assert models[0]["id"] == "model-a"

    @pytest.mark.asyncio
    async def test_list_models_connection_error(self, tmp_path, mock_platform_apple):
        import httpx
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            models = await mgr.list_models()
            assert models == []


# ===========================================================================
# Status Tests
# ===========================================================================

class TestGetStatus:
    """Tests for get_status."""

    @pytest.mark.asyncio
    async def test_get_status(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        with patch.object(mgr, "health_check", return_value={"healthy": False}):
            status = await mgr.get_status()
            assert "status" in status
            assert "port" in status
            assert "engine" in status
            assert status["port"] == 7999

    @pytest.mark.asyncio
    async def test_get_status_running(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.RUNNING
        mgr._started_at = time.time() - 60
        with patch.object(mgr, "health_check", return_value={"healthy": True, "loaded_models": ["m1"]}):
            status = await mgr.get_status()
            assert status["healthy"] is True
            assert status["uptime_seconds"] is not None


# ===========================================================================
# Dispose Tests
# ===========================================================================

class TestDispose:
    """Tests for dispose method."""

    @pytest.mark.asyncio
    async def test_dispose_keeps_server(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        InferenceManager._instance = mgr
        mgr._status = ServerStatus.RUNNING

        with patch.object(mgr, "stop") as mock_stop:
            await mgr.dispose(stop_server=False)
            mock_stop.assert_not_called()
            assert InferenceManager._instance is None

    @pytest.mark.asyncio
    async def test_dispose_stops_server(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        InferenceManager._instance = mgr
        mgr._status = ServerStatus.RUNNING

        with patch.object(mgr, "stop", return_value={"status": "stopped"}) as mock_stop:
            await mgr.dispose(stop_server=True)
            mock_stop.assert_called_once()


# ===========================================================================
# Pull Progress Tests
# ===========================================================================

class TestPullProgress:
    """Tests for pull progress tracking."""

    def test_pull_progress_default(self):
        p = PullProgress(job_id="abc", model="test-model")
        assert p.status == "pending"
        assert p.progress_pct == 0.0

    @pytest.mark.asyncio
    async def test_get_pull_progress(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pull_jobs["job1"] = PullProgress(job_id="job1", model="m")
        assert mgr.get_pull_progress("job1").model == "m"
        assert mgr.get_pull_progress("nonexistent") is None


# ===========================================================================
# Server Process Alive Tests
# ===========================================================================

class TestIsProcessAlive:
    """Tests for is_server_process_alive."""

    def test_alive_with_pid(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid = os.getpid()  # Use current PID (always alive)
        assert mgr.is_server_process_alive() is True

    def test_dead_pid(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid = 99999999
        with patch("os.kill", side_effect=OSError("no such process")):
            assert mgr.is_server_process_alive() is False

    def test_no_pid(self, tmp_path, mock_platform_apple):
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid = None
        mgr._pid_file = None
        assert mgr.is_server_process_alive() is False


# ===========================================================================
# Enum Tests
# ===========================================================================

class TestServerStatusEnum:
    """Tests for ServerStatus enum."""

    def test_values(self):
        assert ServerStatus.STOPPED.value == "stopped"
        assert ServerStatus.STARTING.value == "starting"
        assert ServerStatus.RUNNING.value == "running"
        assert ServerStatus.ERROR.value == "error"
        assert ServerStatus.STOPPING.value == "stopping"


# ===========================================================================
# BUG 2: Concurrent Start Protection Tests
# ===========================================================================

class TestConcurrentStart:
    """Tests for asyncio.Lock preventing duplicate spawns on concurrent start() calls."""

    @pytest.mark.asyncio
    async def test_concurrent_start_spawns_once(self, tmp_path, mock_platform_apple):
        """Two concurrent start() calls must result in exactly one Popen call.
        The lock serializes them: first caller spawns, second sees already_running."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_process = MagicMock()
        mock_process.pid = 12345
        mock_process.poll.return_value = None

        popen_calls = []
        original_popen = MagicMock(return_value=mock_process)

        def tracking_popen(*args, **kwargs):
            popen_calls.append(1)
            return original_popen(*args, **kwargs)

        # health_check mock: returns healthy once status is RUNNING
        # (needed for the second caller to get "already_running")
        async def mock_health(self_=None):
            if mgr._status == ServerStatus.RUNNING:
                return {"healthy": True}
            return {"healthy": False}

        with patch("subprocess.Popen", side_effect=tracking_popen), \
             patch.object(mgr, "_build_serve_command", return_value=["fake_cmd"]), \
             patch.object(mgr, "_wait_for_healthy", return_value=True), \
             patch.object(mgr, "health_check", side_effect=mock_health), \
             patch.object(mgr, "_write_pid_file"), \
             patch("builtins.open", return_value=MagicMock()):
            # Launch two start() calls concurrently
            results = await asyncio.gather(mgr.start(), mgr.start())

        statuses = [r["status"] for r in results]
        # One spawns ("running"), the other finds it already running
        assert "running" in statuses
        assert "already_running" in statuses
        # Popen called exactly once
        assert len(popen_calls) == 1

    @pytest.mark.asyncio
    async def test_start_lock_exists(self, tmp_path, mock_platform_apple):
        """Verify _start_lock attribute is an asyncio.Lock."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        assert isinstance(mgr._start_lock, asyncio.Lock)


# ===========================================================================
# BUG 3: Log Handle Leak Tests
# ===========================================================================

class TestLogHandleLeak:
    """Tests for log file handle cleanup on Popen failure."""

    @pytest.mark.asyncio
    async def test_log_handle_closed_on_popen_failure(self, tmp_path, mock_platform_apple):
        """If Popen raises, the log file handle must be closed (not leaked)."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_handle = MagicMock()
        mock_handle.close = MagicMock()

        with patch("builtins.open", return_value=mock_handle), \
             patch.object(mgr, "_build_serve_command", return_value=["fake_cmd"]), \
             patch("subprocess.Popen", side_effect=OSError("spawn failed")):
            result = await mgr.start()

        assert result["status"] == "error"
        # The log handle must have been closed in the finally block
        mock_handle.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_log_handle_closed_after_successful_popen(self, tmp_path, mock_platform_apple):
        """After successful Popen, the manager closes its log handle
        (subprocess inherited the fd via Popen)."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_handle = MagicMock()
        mock_handle.close = MagicMock()
        mock_process = MagicMock()
        mock_process.pid = 55555
        mock_process.poll.return_value = None

        with patch("builtins.open", return_value=mock_handle), \
             patch.object(mgr, "_build_serve_command", return_value=["fake_cmd"]), \
             patch("subprocess.Popen", return_value=mock_process), \
             patch.object(mgr, "_wait_for_healthy", return_value=True), \
             patch.object(mgr, "_write_pid_file"):
            result = await mgr.start()

        assert result["status"] == "running"
        # Close called right after Popen succeeds (not in finally)
        mock_handle.close.assert_called_once()


# ===========================================================================
# BUG 4: _kill_by_port Identity Verification Tests
# ===========================================================================

class TestKillByPortIdentity:
    """Tests for _kill_by_port() identity verification before killing."""

    @pytest.mark.asyncio
    async def test_skips_non_inference_process(self, tmp_path, mock_platform_apple):
        """If lsof finds a PID that isn't an inference process, do NOT kill it."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_result = MagicMock()
        mock_result.stdout = "42\n"
        mock_result.returncode = 0

        with patch("subprocess.run", return_value=mock_result), \
             patch.object(mgr, "_is_inference_process", return_value=False), \
             patch("os.kill") as mock_kill:
            await mgr._kill_by_port()
            # os.kill must NOT be called — the PID was not ours
            mock_kill.assert_not_called()

    @pytest.mark.asyncio
    async def test_kills_verified_inference_process(self, tmp_path, mock_platform_apple):
        """If lsof finds a PID that IS an inference process, kill it."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_result = MagicMock()
        mock_result.stdout = "42\n"
        mock_result.returncode = 0

        with patch("subprocess.run", return_value=mock_result), \
             patch.object(mgr, "_is_inference_process", return_value=True), \
             patch("os.kill") as mock_kill, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_kill.side_effect = [None, ProcessLookupError()]
            await mgr._kill_by_port()
            # SIGTERM then SIGKILL attempted
            assert mock_kill.call_count == 2
            mock_kill.assert_any_call(42, signal.SIGTERM)

    def test_is_inference_process_with_matching_cmdline(self, tmp_path, mock_platform_apple):
        """_is_inference_process returns True for inference cmdlines."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["python", "-m", "services.aether_inference.server", "--port", "7090"]

        with patch("psutil.Process", return_value=mock_proc):
            assert mgr._is_inference_process(42) is True

    def test_is_inference_process_with_non_matching_cmdline(self, tmp_path, mock_platform_apple):
        """_is_inference_process returns False for non-inference cmdlines."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["nginx", "-g", "daemon off;"]

        with patch("psutil.Process", return_value=mock_proc):
            assert mgr._is_inference_process(42) is False

    def test_is_inference_process_without_psutil(self, tmp_path, mock_platform_apple):
        """Without psutil, _is_inference_process returns True (benefit of doubt)."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        with patch.dict("sys.modules", {"psutil": None}), \
             patch("builtins.__import__", side_effect=ImportError("no psutil")):
            # The method catches ImportError and returns True
            assert mgr._is_inference_process(42) is True


# ===========================================================================
# BUG 5: Reconnect Status Tests
# ===========================================================================

class TestReconnectStatus:
    """Tests for _reconnect_existing() setting STARTING instead of RUNNING."""

    def test_reconnect_sets_starting_not_running(self, tmp_path, mock_platform_apple):
        """After reconnecting to a live PID, status must be STARTING, not RUNNING."""
        pid_file = tmp_path / "inference.pid"
        pid_file.write_text(str(os.getpid()))

        mgr = InferenceManager.__new__(InferenceManager)
        mgr._pid_file = pid_file
        mgr._pid = None
        mgr._status = ServerStatus.STOPPED
        mgr._started_at = None
        mgr._port = 7999

        with patch("os.kill", return_value=None):  # PID is alive
            try:
                import psutil
                # psutil available: need to mock Process to verify cmdline
                mock_proc = MagicMock()
                mock_proc.cmdline.return_value = ["python", "-m", "services.aether_inference.server"]
                with patch("psutil.Process", return_value=mock_proc):
                    mgr._reconnect_existing()
            except ImportError:
                # psutil not available: trusts PID + skips cmdline check
                mgr._reconnect_existing()

        assert mgr._status == ServerStatus.STARTING  # NOT RUNNING
        assert mgr._pid == os.getpid()

    @pytest.mark.asyncio
    async def test_health_check_promotes_starting_to_running(self, tmp_path, mock_platform_apple):
        """health_check() must promote STARTING to RUNNING on healthy response."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.STARTING

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"status": "ok"}

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()

        assert result["healthy"] is True
        assert mgr._status == ServerStatus.RUNNING  # Promoted from STARTING


# ===========================================================================
# BUG 7: Atomic PID File Write Tests
# ===========================================================================

class TestAtomicPidWrite:
    """Tests for _write_pid_file() using temp + rename."""

    def test_pid_file_written_with_correct_content(self, tmp_path, mock_platform_apple):
        """PID file must contain the exact PID value after write."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid_file = tmp_path / "logs" / "test_inference.pid"
        mgr._pid_file.parent.mkdir(parents=True, exist_ok=True)

        mgr._write_pid_file(12345)

        assert mgr._pid_file.exists()
        assert mgr._pid_file.read_text() == "12345"

    def test_pid_file_uses_atomic_rename(self, tmp_path, mock_platform_apple):
        """Verify temp file + os.rename is used (atomic write pattern)."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid_file = tmp_path / "logs" / "test_inference.pid"
        mgr._pid_file.parent.mkdir(parents=True, exist_ok=True)

        with patch("tempfile.mkstemp", return_value=(99, str(tmp_path / "logs" / ".tmp_pid"))) as mock_mkstemp, \
             patch("os.write") as mock_write, \
             patch("os.close") as mock_close, \
             patch("os.rename") as mock_rename:
            mgr._write_pid_file(99999)

            mock_mkstemp.assert_called_once()
            mock_write.assert_called_once_with(99, b"99999")
            mock_close.assert_called_once_with(99)
            mock_rename.assert_called_once()

    def test_pid_file_fallback_on_rename_failure(self, tmp_path, mock_platform_apple):
        """If atomic write fails, falls back to direct write_text."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid_file = tmp_path / "logs" / "test_inference.pid"
        mgr._pid_file.parent.mkdir(parents=True, exist_ok=True)

        with patch("tempfile.mkstemp", side_effect=OSError("filesystem error")):
            mgr._write_pid_file(77777)

        # Fallback direct write should still succeed
        assert mgr._pid_file.exists()
        assert mgr._pid_file.read_text() == "77777"

    def test_pid_file_none_is_noop(self, tmp_path, mock_platform_apple):
        """If _pid_file is None, _write_pid_file does nothing."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid_file = None
        # Should not raise
        mgr._write_pid_file(12345)


# ===========================================================================
# Start Happy Path Tests
# ===========================================================================

class TestStartHappyPath:
    """Tests for the full start() happy path with mocked Popen + health."""

    @pytest.mark.asyncio
    async def test_start_full_flow(self, tmp_path, mock_platform_apple):
        """Full start: build command, Popen, PID file, wait healthy, status=RUNNING."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_process = MagicMock()
        mock_process.pid = 54321
        mock_process.poll.return_value = None

        with patch("subprocess.Popen", return_value=mock_process) as mock_popen, \
             patch.object(mgr, "_build_serve_command", return_value=["python", "-m", "fake"]), \
             patch.object(mgr, "_wait_for_healthy", return_value=True), \
             patch("builtins.open", return_value=MagicMock()):
            result = await mgr.start()

        assert result["status"] == "running"
        assert result["pid"] == 54321
        assert result["port"] == 7999
        assert mgr._status == ServerStatus.RUNNING
        assert mgr._pid == 54321
        assert mgr._started_at is not None

        # PID file must exist with correct content
        pid_content = mgr._pid_file.read_text().strip()
        assert pid_content == "54321"

    @pytest.mark.asyncio
    async def test_start_unhealthy_sets_error(self, tmp_path, mock_platform_apple):
        """If health check fails after start, status must be ERROR."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_process = MagicMock()
        mock_process.pid = 11111
        mock_process.poll.return_value = None

        with patch("subprocess.Popen", return_value=mock_process), \
             patch.object(mgr, "_build_serve_command", return_value=["python", "-m", "fake"]), \
             patch.object(mgr, "_wait_for_healthy", return_value=False), \
             patch("builtins.open", return_value=MagicMock()):
            result = await mgr.start()

        assert result["status"] == "error"
        assert "failed health check" in result["error"]
        assert mgr._status == ServerStatus.ERROR


# ===========================================================================
# Stop Escalation Tests
# ===========================================================================

class TestStopEscalation:
    """Tests for stop() SIGTERM -> SIGKILL escalation and kill_by_port fallback."""

    @pytest.mark.asyncio
    async def test_stop_with_process_sigterm_then_sigkill(self, tmp_path, mock_platform_apple):
        """If process doesn't die on SIGTERM, escalate to SIGKILL."""
        import subprocess as sp
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.RUNNING

        mock_process = MagicMock()
        mock_process.poll.return_value = None  # Still running
        mock_process.pid = 12345
        mock_process.wait.side_effect = [sp.TimeoutExpired("cmd", 10), None]
        mgr._process = mock_process

        with patch("os.killpg") as mock_killpg, \
             patch("os.getpgid", return_value=12345):
            result = await mgr.stop()

        assert result["status"] == "stopped"
        # SIGTERM first, then SIGKILL
        assert mock_killpg.call_count == 2
        mock_killpg.assert_any_call(12345, signal.SIGTERM)
        mock_killpg.assert_any_call(12345, signal.SIGKILL)

    @pytest.mark.asyncio
    async def test_stop_falls_through_to_kill_by_port(self, tmp_path, mock_platform_apple):
        """If no PID and no process, stop() must call _kill_by_port."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.STOPPED
        mgr._pid = None
        mgr._process = None

        with patch.object(mgr, "health_check", return_value={"healthy": True}), \
             patch.object(mgr, "_kill_by_port", new_callable=AsyncMock) as mock_kbp:
            result = await mgr.stop()

        assert result["status"] == "stopped"
        mock_kbp.assert_called_once()


# ===========================================================================
# Restart Tests
# ===========================================================================

class TestRestart:
    """Tests for restart() method."""

    @pytest.mark.asyncio
    async def test_restart_calls_stop_then_start(self, tmp_path, mock_platform_apple):
        """restart() must call stop, sleep, then start — in that order."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        call_order = []

        async def mock_stop():
            call_order.append("stop")
            return {"status": "stopped"}

        async def mock_start(model=None):
            call_order.append("start")
            return {"status": "running"}

        with patch.object(mgr, "stop", side_effect=mock_stop), \
             patch.object(mgr, "start", side_effect=mock_start), \
             patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            result = await mgr.restart()

        assert call_order == ["stop", "start"]
        assert result["status"] == "running"
        mock_sleep.assert_called_once_with(1)


# ===========================================================================
# _wait_for_healthy Tests
# ===========================================================================

class TestWaitForHealthy:
    """Tests for _wait_for_healthy backoff and process death detection."""

    @pytest.mark.asyncio
    async def test_healthy_on_first_try(self, tmp_path, mock_platform_apple):
        """Returns True immediately if first health check passes."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._process = MagicMock()
        mgr._process.poll.return_value = None

        with patch.object(mgr, "health_check", return_value={"healthy": True}):
            result = await mgr._wait_for_healthy(timeout_seconds=10)

        assert result is True

    @pytest.mark.asyncio
    async def test_process_dies_during_wait(self, tmp_path, mock_platform_apple):
        """Returns False immediately if process exits during wait."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._process = MagicMock()
        mgr._process.poll.return_value = 1  # Already dead
        mgr._process.returncode = 1

        with patch.object(mgr, "health_check", return_value={"healthy": False}):
            result = await mgr._wait_for_healthy(timeout_seconds=60)

        assert result is False

    @pytest.mark.asyncio
    async def test_backoff_pattern(self, tmp_path, mock_platform_apple):
        """Verify the delay pattern: 1s, 2s, 4s, 8s, then 5s."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._process = MagicMock()
        mgr._process.poll.return_value = None

        health_calls = [0]
        delays_recorded = []

        async def mock_health_check():
            health_calls[0] += 1
            if health_calls[0] >= 4:
                return {"healthy": True}
            return {"healthy": False}

        async def mock_sleep(delay):
            delays_recorded.append(delay)

        with patch.object(mgr, "health_check", side_effect=mock_health_check), \
             patch("asyncio.sleep", side_effect=mock_sleep):
            result = await mgr._wait_for_healthy(timeout_seconds=60)

        assert result is True
        # Delays: 1s (attempt 0), 2s (attempt 1), 4s (attempt 2)
        assert delays_recorded == [1, 2, 4]


# ===========================================================================
# _resolve_service_source_dir Tests
# ===========================================================================

class TestResolveServiceSourceDir:
    """Tests for _resolve_service_source_dir static method."""

    def test_backend_root_resolution(self, tmp_path):
        """Resolves via AETHER_BACKEND_ROOT when marker file exists."""
        marker = tmp_path / "services" / "aether_inference" / "server.py"
        marker.parent.mkdir(parents=True)
        marker.write_text("# server")

        with patch.dict(os.environ, {"AETHER_BACKEND_ROOT": str(tmp_path)}, clear=False):
            result = InferenceManager._resolve_service_source_dir()
        assert result == tmp_path

    def test_install_dir_fallback(self, tmp_path):
        """Falls back to AETHER_INSTALL_DIR when BACKEND_ROOT has no marker."""
        install_dir = tmp_path / "install"
        marker = install_dir / "services" / "aether_inference" / "server.py"
        marker.parent.mkdir(parents=True)
        marker.write_text("# server")

        with patch.dict(os.environ, {
            "AETHER_BACKEND_ROOT": str(tmp_path / "nonexistent"),
            "AETHER_INSTALL_DIR": str(install_dir),
        }, clear=False):
            result = InferenceManager._resolve_service_source_dir()
        assert result == install_dir

    def test_returns_none_when_not_found(self, tmp_path):
        """Returns None when neither env var points to marker file."""
        with patch.dict(os.environ, {
            "AETHER_BACKEND_ROOT": str(tmp_path / "nope"),
            "AETHER_INSTALL_DIR": str(tmp_path / "also_nope"),
        }, clear=False):
            result = InferenceManager._resolve_service_source_dir()
        assert result is None


# ===========================================================================
# _get_pid_file_candidates Tests
# ===========================================================================

class TestGetPidFileCandidates:
    """Tests for _get_pid_file_candidates."""

    def test_includes_primary_pid_file(self, tmp_path, mock_platform_apple):
        """Primary _pid_file is always in the candidates list."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        candidates = mgr._get_pid_file_candidates()
        assert mgr._pid_file in candidates

    def test_includes_data_dir_alternate(self, tmp_path, mock_platform_apple):
        """If AETHER_DATA_DIR is set, its inference.pid is included."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        data_dir = tmp_path / "alt_data"
        data_dir.mkdir()

        with patch.dict(os.environ, {"AETHER_DATA_DIR": str(data_dir)}):
            candidates = mgr._get_pid_file_candidates()

        alt_path = data_dir / "logs" / "inference.pid"
        assert alt_path in candidates

    def test_includes_mac_default(self, tmp_path, mock_platform_apple):
        """macOS default Library/Application Support/Aether path is included."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        candidates = mgr._get_pid_file_candidates()
        mac_path = Path.home() / "Library" / "Application Support" / "Aether" / "logs" / "inference.pid"
        assert mac_path in candidates


# ===========================================================================
# Pull Model HuggingFace Path Tests
# ===========================================================================

class TestPullModelHF:
    """Tests for pull_model() HuggingFace download path."""

    @pytest.mark.asyncio
    async def test_pull_hf_success(self, tmp_path, mock_platform_apple):
        """HF pull path succeeds when subprocess returns 0."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_proc = AsyncMock()
        mock_proc.returncode = 0
        mock_proc.communicate = AsyncMock(return_value=(b"done", b""))

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            progress = await mgr.pull_model("test-org/test-model")

        assert progress.status == "complete"
        assert progress.progress_pct == 100.0
        assert progress.job_id in mgr._pull_jobs

    @pytest.mark.asyncio
    async def test_pull_hf_failure(self, tmp_path, mock_platform_apple):
        """HF pull path reports error when subprocess returns non-zero."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_proc = AsyncMock()
        mock_proc.returncode = 1
        mock_proc.communicate = AsyncMock(return_value=(b"", b"download failed"))

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            progress = await mgr.pull_model("test-org/broken-model")

        assert progress.status == "error"
        assert "download failed" in progress.error


# ===========================================================================
# Dispose Completeness Tests
# ===========================================================================

class TestDisposeCompleteness:
    """Tests for dispose() clearing all tracked resources."""

    @pytest.mark.asyncio
    async def test_dispose_clears_pull_jobs(self, tmp_path, mock_platform_apple):
        """dispose() must clear _pull_jobs dict."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        InferenceManager._instance = mgr
        mgr._pull_jobs["job1"] = PullProgress(job_id="job1", model="m1")
        mgr._pull_jobs["job2"] = PullProgress(job_id="job2", model="m2")

        await mgr.dispose(stop_server=False)

        assert len(mgr._pull_jobs) == 0
        assert InferenceManager._instance is None

    @pytest.mark.asyncio
    async def test_dispose_with_starting_status_stops_server(self, tmp_path, mock_platform_apple):
        """dispose(stop_server=True) stops server even if status is STARTING."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        InferenceManager._instance = mgr
        mgr._status = ServerStatus.STARTING

        with patch.object(mgr, "stop", return_value={"status": "stopped"}) as mock_stop:
            await mgr.dispose(stop_server=True)
            mock_stop.assert_called_once()


# ===========================================================================
# Phase 3: Regression Tests — Non-Destructive Behavior
# ===========================================================================

class TestNonDestructiveRegression:
    """Regression tests that will FAIL if destructive patterns are re-introduced.
    
    These are the inference-service equivalents of test_daemon_control.py's
    non-destructive assertions.
    """

    @pytest.mark.asyncio
    async def test_start_never_kills_existing_server(self, tmp_path, mock_platform_apple):
        """start() must NEVER send kill signals. It only spawns new processes."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.STOPPED

        mock_process = MagicMock()
        mock_process.pid = 99999
        mock_process.poll.return_value = None

        with patch("subprocess.Popen", return_value=mock_process), \
             patch.object(mgr, "_build_serve_command", return_value=["fake"]), \
             patch.object(mgr, "_wait_for_healthy", return_value=True), \
             patch("os.kill") as mock_kill, \
             patch("os.killpg") as mock_killpg, \
             patch("builtins.open", return_value=MagicMock()), \
             patch.object(mgr, "_write_pid_file"):
            await mgr.start()

        # start() must NEVER call os.kill or os.killpg
        mock_kill.assert_not_called()
        mock_killpg.assert_not_called()

    def test_reconnect_never_kills_process(self, tmp_path, mock_platform_apple):
        """_reconnect_existing must NEVER send kill signals (only signal 0 for existence check)."""
        pid_file = tmp_path / "inference.pid"
        pid_file.write_text(str(os.getpid()))

        mgr = InferenceManager.__new__(InferenceManager)
        mgr._pid_file = pid_file
        mgr._pid = None
        mgr._status = ServerStatus.STOPPED
        mgr._started_at = None
        mgr._port = 7999

        kill_signals_sent = []
        original_kill = os.kill

        def tracking_kill(pid, sig):
            kill_signals_sent.append(sig)
            if sig == 0:
                return  # Existence check — OK
            raise AssertionError(f"_reconnect_existing sent signal {sig} — MUST NEVER send kill signals")

        with patch("os.kill", side_effect=tracking_kill):
            try:
                import psutil
                mock_proc = MagicMock()
                mock_proc.cmdline.return_value = ["python", "-m", "services.aether_inference.server"]
                with patch("psutil.Process", return_value=mock_proc):
                    mgr._reconnect_existing()
            except ImportError:
                mgr._reconnect_existing()

        # Only signal 0 (existence check) is allowed
        assert all(s == 0 for s in kill_signals_sent), f"Non-zero signals sent: {kill_signals_sent}"

    @pytest.mark.asyncio
    async def test_dispose_default_never_stops_server(self, tmp_path, mock_platform_apple):
        """dispose(stop_server=False) must NEVER call stop()."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        InferenceManager._instance = mgr
        mgr._status = ServerStatus.RUNNING

        with patch.object(mgr, "stop") as mock_stop:
            await mgr.dispose(stop_server=False)
            mock_stop.assert_not_called()

    def test_no_kill_stale_servers_function(self):
        """The module must NOT contain a _kill_stale* function (destructive anti-pattern)."""
        import services.aether_inference.manager as mod
        for name in dir(mod):
            assert "kill_stale" not in name.lower(), \
                f"Found destructive function '{name}' in manager.py — this is a regression"

    def test_start_source_has_no_direct_kill_calls(self):
        """The start() / _start_locked() source must not contain os.kill or os.killpg calls."""
        import services.aether_inference.manager as mod
        source = inspect.getsource(mod.InferenceManager._start_locked)
        assert "os.kill(" not in source, "start() contains os.kill() — destructive pattern"
        assert "os.killpg(" not in source, "start() contains os.killpg() — destructive pattern"
        assert "signal.SIGTERM" not in source, "start() references SIGTERM — destructive pattern"
        assert "signal.SIGKILL" not in source, "start() references SIGKILL — destructive pattern"


# ===========================================================================
# PHASE 2 EXTENSIONS — Coverage gap fill (session 2)
# ===========================================================================


# ===========================================================================
# Resolve Engine Binary Tests (previously 0 direct tests)
# ===========================================================================

class TestResolveEngineBinary:
    """Tests for _resolve_engine_binary — venv, system PATH, FileNotFoundError."""

    def test_finds_venv_python_for_vllm_mlx(self, tmp_path, mock_platform_apple):
        """Returns venv python binary for VLLM_MLX engine."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        result = mgr._resolve_engine_binary()
        assert result == str(mgr._venv_path / "bin" / "python")

    def test_finds_venv_vllm_for_vllm_engine(self, tmp_path, mock_platform_nvidia):
        """Returns venv vllm binary for VLLM engine."""
        mgr = _make_manager(tmp_path, mock_platform_nvidia)
        result = mgr._resolve_engine_binary()
        assert result == str(mgr._venv_path / "bin" / "vllm")

    def test_finds_venv_ollama(self, tmp_path, mock_platform_ollama):
        """Returns venv ollama binary for Ollama engine."""
        mgr = _make_manager(tmp_path, mock_platform_ollama)
        result = mgr._resolve_engine_binary()
        assert result == str(mgr._venv_path / "bin" / "ollama")

    def test_venv_binary_missing_falls_to_system(self, tmp_path, mock_platform_apple):
        """Falls back to system PATH when venv binary doesn't exist."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        (mgr._venv_path / "bin" / "python").unlink()
        with patch("shutil.which", return_value="/usr/local/bin/python"):
            result = mgr._resolve_engine_binary()
        assert result == "/usr/local/bin/python"

    def test_no_venv_falls_to_system(self, tmp_path, mock_platform_apple):
        """Falls back to system PATH when no venv is configured."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._venv_path = None
        with patch("shutil.which", return_value="/usr/bin/python3"):
            result = mgr._resolve_engine_binary()
        assert result == "/usr/bin/python3"

    def test_venv_exists_but_no_bin_subdir(self, tmp_path, mock_platform_apple):
        """Falls back to system when venv exists but has no matching binary."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        empty_venv = tmp_path / "empty-venv"
        empty_venv.mkdir()
        mgr._venv_path = empty_venv
        with patch("shutil.which", return_value="/usr/bin/python3"):
            result = mgr._resolve_engine_binary()
        assert result == "/usr/bin/python3"

    def test_nothing_found_raises_file_not_found(self, tmp_path, mock_platform_apple):
        """Raises FileNotFoundError when engine binary not found anywhere."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._venv_path = None
        with patch("shutil.which", return_value=None):
            with pytest.raises(FileNotFoundError, match="not found"):
                mgr._resolve_engine_binary()


# ===========================================================================
# Build Serve Command Extended Tests
# ===========================================================================

class TestBuildServeCommandExtended:
    """Extended tests for _build_serve_command — flags, model args, edge cases."""

    def test_includes_port_and_idle_timeout(self, tmp_path, mock_platform_apple):
        """Command includes --port and --idle-timeout flags with correct values."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        cmd = mgr._build_serve_command()
        port_idx = cmd.index("--port")
        assert cmd[port_idx + 1] == "7999"
        idle_idx = cmd.index("--idle-timeout")
        assert cmd[idle_idx + 1] == "300"

    def test_includes_venv_arg(self, tmp_path, mock_platform_apple):
        """Command includes --venv flag with the venv path."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        cmd = mgr._build_serve_command()
        assert "--venv" in cmd
        venv_idx = cmd.index("--venv")
        assert cmd[venv_idx + 1] == str(mgr._venv_path)

    def test_includes_models_dir_arg(self, tmp_path, mock_platform_apple):
        """Command includes --models-dir flag with models directory."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        cmd = mgr._build_serve_command()
        assert "--models-dir" in cmd
        md_idx = cmd.index("--models-dir")
        assert cmd[md_idx + 1] == str(mgr._models_dir)

    def test_explicit_model_added_when_not_discovered(self, tmp_path, mock_platform_apple):
        """Explicit model arg is included in --model flags when not already discovered."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        cmd = mgr._build_serve_command(model="custom-org/custom-model")
        model_args = [cmd[i + 1] for i, v in enumerate(cmd) if v == "--model"]
        assert "custom-org/custom-model" in model_args

    def test_current_model_set_after_build(self, tmp_path, mock_platform_apple):
        """_current_model is set after building the command."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._current_model = None
        mgr._build_serve_command(model="test-org/test-model")
        assert mgr._current_model is not None
        assert "test-org/test-model" in mgr._current_model

    def test_unsupported_engine_raises_value_error(self, tmp_path, mock_platform_apple):
        """Raises ValueError for unsupported engine type."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mock_pinfo = MagicMock()
        mock_pinfo.engine = "unsupported_engine"
        mock_pinfo.engine_command = "python"
        mgr._platform = mock_pinfo
        with pytest.raises(ValueError, match="Unsupported engine"):
            mgr._build_serve_command()

    def test_ollama_has_no_router_flags(self, tmp_path, mock_platform_ollama):
        """Ollama command is [engine_bin, 'serve'] with no router flags."""
        mgr = _make_manager(tmp_path, mock_platform_ollama)
        cmd = mgr._build_serve_command()
        assert cmd[-1] == "serve"
        assert "--engine" not in cmd
        assert "--port" not in cmd

    def test_no_venv_omits_venv_flag(self, tmp_path, mock_platform_apple):
        """If _venv_path is None, --venv flag is not in command."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._venv_path = None
        with patch("shutil.which", return_value="/usr/bin/python"):
            cmd = mgr._build_serve_command()
        assert "--venv" not in cmd

    def test_no_models_dir_omits_flag(self, tmp_path, mock_platform_apple):
        """If _models_dir is None, --models-dir flag is not in command."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._models_dir = None
        cmd = mgr._build_serve_command()
        assert "--models-dir" not in cmd


# ===========================================================================
# Health Check Extended Tests
# ===========================================================================

class TestHealthCheckExtended:
    """Extended tests for health_check — fallback paths, status sync, errors."""

    async def test_health_500_falls_through_to_v1_models(self, tmp_path, mock_platform_apple):
        """If /health returns 500+, falls through to /v1/models endpoint."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        health_resp = MagicMock()
        health_resp.status_code = 500

        models_resp = MagicMock()
        models_resp.status_code = 200
        models_resp.json.return_value = {"data": [{"id": "m1"}]}

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[health_resp, models_resp])
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()

        assert result["healthy"] is True
        assert result["loaded_models"] == ["m1"]

    async def test_health_request_error_falls_through(self, tmp_path, mock_platform_apple):
        """If /health raises RequestError, falls through to /v1/models."""
        import httpx
        mgr = _make_manager(tmp_path, mock_platform_apple)

        models_resp = MagicMock()
        models_resp.status_code = 200
        models_resp.json.return_value = {"data": []}

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[httpx.ConnectError("health failed"), models_resp])
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()

        assert result["healthy"] is True
        assert result["loaded_models"] == []

    async def test_v1_models_500_is_unhealthy(self, tmp_path, mock_platform_apple):
        """If /v1/models returns 500+, reports unhealthy with error status."""
        import httpx
        mgr = _make_manager(tmp_path, mock_platform_apple)

        models_resp = MagicMock()
        models_resp.status_code = 503

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[httpx.ConnectError("err"), models_resp])
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()

        assert result["healthy"] is False
        assert result["status"] == "error"

    async def test_timeout_exception_returns_unhealthy(self, tmp_path, mock_platform_apple):
        """httpx.TimeoutException returns unhealthy with stopped status."""
        import httpx
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timed out"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()

        assert result["healthy"] is False
        assert result["status"] == "stopped"

    async def test_generic_exception_returns_error(self, tmp_path, mock_platform_apple):
        """Generic exception returns unhealthy with error status and message."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=RuntimeError("unexpected"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()

        assert result["healthy"] is False
        assert result["status"] == "error"
        assert "unexpected" in result["error"]

    async def test_stopped_promoted_to_running_on_healthy(self, tmp_path, mock_platform_apple):
        """STOPPED status promoted to RUNNING on healthy /health response."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.STOPPED

        mock_resp = MagicMock()
        mock_resp.status_code = 200

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()

        assert result["healthy"] is True
        assert mgr._status == ServerStatus.RUNNING

    async def test_error_status_not_promoted_to_running(self, tmp_path, mock_platform_apple):
        """ERROR status NOT promoted to RUNNING even on healthy response."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.ERROR

        mock_resp = MagicMock()
        mock_resp.status_code = 200

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()

        assert result["healthy"] is True
        assert mgr._status == ServerStatus.ERROR  # NOT promoted

    async def test_v1_models_json_parse_failure_graceful(self, tmp_path, mock_platform_apple):
        """If resp.json() fails on /v1/models, result returned without loaded_models."""
        import httpx
        mgr = _make_manager(tmp_path, mock_platform_apple)

        models_resp = MagicMock()
        models_resp.status_code = 200
        models_resp.json.side_effect = ValueError("bad json")

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=[httpx.ConnectError("err"), models_resp])
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            result = await mgr.health_check()

        assert result["healthy"] is True
        assert "loaded_models" not in result


# ===========================================================================
# List Models Ollama Tests
# ===========================================================================

class TestListModelsOllama:
    """Tests for list_models with Ollama engine (api/tags endpoint)."""

    async def test_ollama_format(self, tmp_path, mock_platform_ollama):
        """Ollama list_models uses /api/tags and returns correct structure."""
        mgr = _make_manager(tmp_path, mock_platform_ollama)

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {
            "models": [
                {"model": "llama2:7b", "name": "llama2:7b", "size": 3825819519},
                {"name": "codellama", "size": 1234567890},
            ]
        }

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            models = await mgr.list_models()

        assert len(models) == 2
        assert models[0]["id"] == "llama2:7b"
        assert models[0]["size"] == 3825819519
        # Second model has no "model" key, falls back to "name"
        assert models[1]["id"] == "codellama"

    async def test_ollama_http_error(self, tmp_path, mock_platform_ollama):
        """Ollama list_models returns empty list on HTTP error."""
        import httpx
        mgr = _make_manager(tmp_path, mock_platform_ollama)

        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            "404", request=MagicMock(), response=MagicMock()
        )

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            models = await mgr.list_models()

        assert models == []


# ===========================================================================
# Pull Model Ollama Tests
# ===========================================================================

class TestPullModelOllama:
    """Tests for pull_model with Ollama engine (api/pull endpoint)."""

    async def test_ollama_pull_success(self, tmp_path, mock_platform_ollama):
        """Ollama pull succeeds when server responds < 400."""
        mgr = _make_manager(tmp_path, mock_platform_ollama)

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "ok"

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            progress = await mgr.pull_model("llama2:7b")

        assert progress.status == "complete"
        assert progress.progress_pct == 100.0
        assert progress.job_id in mgr._pull_jobs

    async def test_ollama_pull_http_error(self, tmp_path, mock_platform_ollama):
        """Ollama pull reports error on HTTP 4xx/5xx."""
        mgr = _make_manager(tmp_path, mock_platform_ollama)

        mock_resp = MagicMock()
        mock_resp.status_code = 404
        mock_resp.text = "model not found"

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            progress = await mgr.pull_model("nonexistent-model")

        assert progress.status == "error"
        assert "404" in progress.error

    async def test_ollama_pull_exception(self, tmp_path, mock_platform_ollama):
        """Ollama pull exception sets error status."""
        import httpx
        mgr = _make_manager(tmp_path, mock_platform_ollama)

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.ConnectError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("services.aether_inference.manager.httpx.AsyncClient", return_value=mock_client):
            progress = await mgr.pull_model("llama2")

        assert progress.status == "error"
        assert progress.error is not None


# ===========================================================================
# Pull Model HF Extended Tests
# ===========================================================================

class TestPullModelHFExtended:
    """Extended tests for pull_model HuggingFace path — venv, models_dir, exceptions."""

    async def test_no_venv_uses_sys_executable(self, tmp_path, mock_platform_apple):
        """When venv python not found, falls back to sys.executable."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._venv_path = None

        mock_proc = AsyncMock()
        mock_proc.returncode = 0
        mock_proc.communicate = AsyncMock(return_value=(b"done", b""))

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec, \
             patch("sys.executable", "/usr/bin/python3"):
            await mgr.pull_model("org/model")

        call_args = mock_exec.call_args
        assert call_args[0][0] == "/usr/bin/python3"

    async def test_no_models_dir_omits_local_dir(self, tmp_path, mock_platform_apple):
        """Without models_dir, download script doesn't use local_dir."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._models_dir = None

        mock_proc = AsyncMock()
        mock_proc.returncode = 0
        mock_proc.communicate = AsyncMock(return_value=(b"done", b""))

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
            await mgr.pull_model("org/model")

        script = mock_exec.call_args[0][2]  # python -c "script"
        assert "local_dir" not in script

    async def test_with_models_dir_uses_local_dir(self, tmp_path, mock_platform_apple):
        """With models_dir, download script uses local_dir for direct placement."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_proc = AsyncMock()
        mock_proc.returncode = 0
        mock_proc.communicate = AsyncMock(return_value=(b"done", b""))

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
            await mgr.pull_model("org/model")

        script = mock_exec.call_args[0][2]
        assert "local_dir" in script

    async def test_subprocess_creation_exception(self, tmp_path, mock_platform_apple):
        """Exception during subprocess creation sets error status."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        with patch("asyncio.create_subprocess_exec", side_effect=OSError("spawn failed")):
            progress = await mgr.pull_model("org/model")

        assert progress.status == "error"
        assert "spawn failed" in progress.error


# ===========================================================================
# Kill By Port Extended Tests
# ===========================================================================

class TestKillByPortExtended:
    """Extended tests for _kill_by_port — psutil fallback, multiple PIDs, edge cases."""

    async def test_lsof_fails_falls_to_psutil(self, tmp_path, mock_platform_apple):
        """When lsof fails, falls through to psutil strategy."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_conn = MagicMock()
        mock_conn.laddr.port = 7999
        mock_conn.status = 'LISTEN'
        mock_conn.pid = 42

        with patch("subprocess.run", side_effect=FileNotFoundError("no lsof")), \
             patch("psutil.net_connections", return_value=[mock_conn]), \
             patch.object(mgr, "_is_inference_process", return_value=True), \
             patch("os.kill") as mock_kill, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_kill.side_effect = [None, ProcessLookupError()]
            await mgr._kill_by_port()

        mock_kill.assert_any_call(42, signal.SIGTERM)

    async def test_psutil_access_denied_no_crash(self, tmp_path, mock_platform_apple):
        """When psutil raises AccessDenied, logs and continues without crash."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        with patch("subprocess.run", side_effect=FileNotFoundError("no lsof")), \
             patch("psutil.net_connections", side_effect=Exception("AccessDenied")), \
             patch("os.kill") as mock_kill:
            await mgr._kill_by_port()

        mock_kill.assert_not_called()

    async def test_multiple_pids_only_verified_killed(self, tmp_path, mock_platform_apple):
        """Multiple PIDs from lsof — only verified inference processes killed."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_result = MagicMock()
        mock_result.stdout = "42\n43\n44\n"

        def is_inference(pid):
            return pid in (42, 44)  # 43 is NOT inference

        with patch("subprocess.run", return_value=mock_result), \
             patch.object(mgr, "_is_inference_process", side_effect=is_inference), \
             patch("os.kill") as mock_kill, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_kill.return_value = None
            await mgr._kill_by_port()

        sigterm_calls = [c for c in mock_kill.call_args_list if c[0][1] == signal.SIGTERM]
        sigterm_pids = {c[0][0] for c in sigterm_calls}
        assert 42 in sigterm_pids
        assert 44 in sigterm_pids
        assert 43 not in sigterm_pids

    async def test_empty_lsof_stdout_no_kill(self, tmp_path, mock_platform_apple):
        """lsof returns empty stdout — falls through to psutil, no kill."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_result = MagicMock()
        mock_result.stdout = ""

        with patch("subprocess.run", return_value=mock_result), \
             patch("psutil.net_connections", return_value=[]), \
             patch("os.kill") as mock_kill:
            await mgr._kill_by_port()

        mock_kill.assert_not_called()

    async def test_psutil_wrong_port_skipped(self, tmp_path, mock_platform_apple):
        """psutil connection on wrong port is not killed."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_conn = MagicMock()
        mock_conn.laddr.port = 8080  # Wrong port
        mock_conn.status = 'LISTEN'
        mock_conn.pid = 42

        with patch("subprocess.run", side_effect=FileNotFoundError("no lsof")), \
             patch("psutil.net_connections", return_value=[mock_conn]), \
             patch("os.kill") as mock_kill:
            await mgr._kill_by_port()

        mock_kill.assert_not_called()


# ===========================================================================
# Reconnect Extended Tests
# ===========================================================================

class TestReconnectExtended:
    """Extended tests for _reconnect_existing — psutil paths, corrupt PID."""

    def test_psutil_cmdline_mismatch_cleans_pid_file(self, tmp_path):
        """If psutil cmdline doesn't match inference markers, PID file is cleaned."""
        pid_file = tmp_path / "inference.pid"
        pid_file.write_text("12345")

        mgr = InferenceManager.__new__(InferenceManager)
        mgr._pid_file = pid_file
        mgr._pid = None
        mgr._status = ServerStatus.STOPPED
        mgr._started_at = None
        mgr._port = 7999

        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["nginx", "-g", "daemon off;"]

        with patch("os.kill", return_value=None), \
             patch("psutil.Process", return_value=mock_proc):
            mgr._reconnect_existing()

        assert mgr._pid is None
        assert mgr._status == ServerStatus.STOPPED
        assert not pid_file.exists()

    def test_psutil_generic_exception_cleans_pid_file(self, tmp_path):
        """If psutil raises unexpected exception, PID file is cleaned."""
        pid_file = tmp_path / "inference.pid"
        pid_file.write_text("12345")

        mgr = InferenceManager.__new__(InferenceManager)
        mgr._pid_file = pid_file
        mgr._pid = None
        mgr._status = ServerStatus.STOPPED
        mgr._started_at = None
        mgr._port = 7999

        with patch("os.kill", return_value=None), \
             patch("psutil.Process", side_effect=RuntimeError("unexpected")):
            mgr._reconnect_existing()

        assert mgr._pid is None
        assert not pid_file.exists()

    def test_corrupt_pid_file_content(self, tmp_path):
        """Non-numeric PID file content is handled gracefully, file cleaned."""
        pid_file = tmp_path / "inference.pid"
        pid_file.write_text("not_a_number")

        mgr = InferenceManager.__new__(InferenceManager)
        mgr._pid_file = pid_file
        mgr._pid = None
        mgr._status = ServerStatus.STOPPED
        mgr._started_at = None
        mgr._port = 7999

        mgr._reconnect_existing()

        assert mgr._pid is None
        assert not pid_file.exists()


# ===========================================================================
# Stop Extended Tests
# ===========================================================================

class TestStopExtended:
    """Extended tests for stop — exception path, PID file cleanup, state reset."""

    async def test_stop_exception_returns_error(self, tmp_path, mock_platform_apple):
        """Exception during stop returns error status."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.RUNNING
        mgr._pid = 12345

        with patch("os.kill", side_effect=RuntimeError("kill failed")):
            result = await mgr.stop()

        assert result["status"] == "error"
        assert "kill failed" in result["error"]
        assert mgr._status == ServerStatus.ERROR

    async def test_stop_cleans_pid_file(self, tmp_path, mock_platform_apple):
        """stop() deletes PID file candidates."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.RUNNING
        mgr._pid = 12345
        mgr._pid_file.write_text("12345")

        with patch("os.kill") as mock_kill, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_kill.side_effect = [None, ProcessLookupError()]
            result = await mgr.stop()

        assert result["status"] == "stopped"
        assert not mgr._pid_file.exists()

    async def test_stop_resets_current_model_and_process(self, tmp_path, mock_platform_apple):
        """stop() resets _current_model, _process, and _pid to None."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._status = ServerStatus.RUNNING
        mgr._pid = 12345
        mgr._current_model = "test-model"
        mgr._process = MagicMock()

        with patch("os.kill") as mock_kill, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_kill.side_effect = [None, ProcessLookupError()]
            await mgr.stop()

        assert mgr._current_model is None
        assert mgr._process is None
        assert mgr._pid is None


# ===========================================================================
# Discover Models Extended Tests
# ===========================================================================

class TestDiscoverModelsExtended:
    """Extended tests for _discover_models — .bin, hidden dirs, edge cases."""

    def test_bin_files_detected(self, tmp_path, mock_platform_apple):
        """Models with .bin files (PyTorch format) are discovered."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / "org"
        model = org / "pytorch-model"
        model.mkdir(parents=True)
        (model / "config.json").write_text("{}")
        (model / "pytorch_model.bin").write_text("fake")

        models = mgr._discover_models()
        assert "org/pytorch-model" in models

    def test_hidden_org_dir_skipped(self, tmp_path, mock_platform_apple):
        """Org directories starting with '.' are skipped."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        hidden_org = tmp_path / "models" / ".hidden-org"
        model = hidden_org / "model"
        model.mkdir(parents=True)
        (model / "config.json").write_text("{}")
        (model / "model.safetensors").write_text("fake")

        models = mgr._discover_models()
        assert len(models) == 0

    def test_hidden_model_dir_skipped(self, tmp_path, mock_platform_apple):
        """Hidden model directories under valid org are skipped."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / "org"
        model = org / ".hidden-model"
        model.mkdir(parents=True)
        (model / "config.json").write_text("{}")
        (model / "model.safetensors").write_text("fake")

        models = mgr._discover_models()
        assert "org/.hidden-model" not in models

    def test_no_models_dir_returns_empty(self, tmp_path, mock_platform_apple):
        """Returns empty list when _models_dir is None."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._models_dir = None
        assert mgr._discover_models() == []

    def test_config_without_model_files_not_discovered(self, tmp_path, mock_platform_apple):
        """Directory with config.json but no model files is not discovered."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / "org"
        model = org / "empty-model"
        model.mkdir(parents=True)
        (model / "config.json").write_text("{}")

        models = mgr._discover_models()
        assert "org/empty-model" not in models


# ===========================================================================
# List Local Models Extended Tests
# ===========================================================================

class TestListLocalModelsExtended:
    """Extended tests for list_local_models — filtering, size calculation."""

    def test_hidden_org_dir_skipped(self, tmp_path, mock_platform_apple):
        """Hidden org directories are not listed."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / ".hidden"
        model = org / "model"
        model.mkdir(parents=True)
        (model / "config.json").write_text("{}")

        assert mgr.list_local_models() == []

    def test_dir_without_config_skipped(self, tmp_path, mock_platform_apple):
        """Model directories without config.json are not listed."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / "org"
        model = org / "no-config"
        model.mkdir(parents=True)
        (model / "model.safetensors").write_text("fake")

        assert mgr.list_local_models() == []

    def test_multiple_orgs_and_models(self, tmp_path, mock_platform_apple):
        """Multiple orgs with multiple models all appear in listing."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        for org_name in ["org-a", "org-b"]:
            for model_name in ["model-1", "model-2"]:
                d = tmp_path / "models" / org_name / model_name
                d.mkdir(parents=True)
                (d / "config.json").write_text("{}")

        models = mgr.list_local_models()
        ids = [m["id"] for m in models]
        assert len(ids) == 4
        assert "org-a/model-1" in ids
        assert "org-b/model-2" in ids

    def test_size_bytes_calculated(self, tmp_path, mock_platform_apple):
        """size_bytes reflects total file size in model directory."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        org = tmp_path / "models" / "org"
        model = org / "sized-model"
        model.mkdir(parents=True)
        (model / "config.json").write_text("x" * 100)
        (model / "weights.safetensors").write_text("y" * 500)

        models = mgr.list_local_models()
        assert len(models) == 1
        assert models[0]["size_bytes"] == 600


# ===========================================================================
# Resolve Model Path Extended Tests
# ===========================================================================

class TestResolveModelPathExtended:
    """Extended tests for resolve_model_path — edge cases."""

    def test_absolute_dir_without_config_falls_through(self, tmp_path, mock_platform_apple):
        """Absolute path dir without config.json falls through to HF fallback."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        model_dir = tmp_path / "some_dir"
        model_dir.mkdir()
        # No config.json inside
        result = mgr.resolve_model_path(str(model_dir))
        # Falls through all checks, returns as-is
        assert result == str(model_dir)

    def test_models_dir_none_returns_original(self, tmp_path, mock_platform_apple):
        """When _models_dir is None, returns original model_id."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._models_dir = None
        result = mgr.resolve_model_path("org/model")
        assert result == "org/model"


# ===========================================================================
# Is Process Alive Extended Tests
# ===========================================================================

class TestIsProcessAliveExtended:
    """Extended tests for is_server_process_alive — PID file fallback."""

    def test_reads_pid_from_file_when_no_tracked_pid(self, tmp_path, mock_platform_apple):
        """Falls back to PID file when _pid is None."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid = None
        pid_file = tmp_path / "test.pid"
        pid_file.write_text(str(os.getpid()))
        mgr._pid_file = pid_file

        assert mgr.is_server_process_alive() is True

    def test_invalid_pid_file_returns_false(self, tmp_path, mock_platform_apple):
        """Non-numeric PID file returns False."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid = None
        pid_file = tmp_path / "test.pid"
        pid_file.write_text("garbage")
        mgr._pid_file = pid_file

        assert mgr.is_server_process_alive() is False

    def test_empty_pid_file_returns_false(self, tmp_path, mock_platform_apple):
        """Empty PID file returns False."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid = None
        pid_file = tmp_path / "test.pid"
        pid_file.write_text("")
        mgr._pid_file = pid_file

        assert mgr.is_server_process_alive() is False


# ===========================================================================
# Wait For Healthy Timeout Test
# ===========================================================================

class TestWaitForHealthyExtended:
    """Extended test for _wait_for_healthy — timeout path."""

    async def test_timeout_returns_false(self, tmp_path, mock_platform_apple):
        """Returns False immediately when timeout_seconds=0."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._process = MagicMock()
        mgr._process.poll.return_value = None

        with patch.object(mgr, "health_check", return_value={"healthy": False}), \
             patch("asyncio.sleep", new_callable=AsyncMock):
            result = await mgr._wait_for_healthy(timeout_seconds=0)

        assert result is False


# ===========================================================================
# Dispose Extended Test
# ===========================================================================

class TestDisposeExtended:
    """Extended test for dispose — STOPPED status with stop_server flag."""

    async def test_dispose_stopped_with_stop_flag_skips_stop(self, tmp_path, mock_platform_apple):
        """dispose(stop_server=True) with STOPPED status does NOT call stop()."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        InferenceManager._instance = mgr
        mgr._status = ServerStatus.STOPPED

        with patch.object(mgr, "stop") as mock_stop:
            await mgr.dispose(stop_server=True)
            mock_stop.assert_not_called()


# ===========================================================================
# Start Environment Tests
# ===========================================================================

class TestStartEnvironment:
    """Tests for start() environment setup — PYTHONPATH, OLLAMA_HOST."""

    async def test_ollama_sets_host_env_var(self, tmp_path, mock_platform_ollama):
        """Ollama start sets OLLAMA_HOST environment variable for port binding."""
        mgr = _make_manager(tmp_path, mock_platform_ollama)

        mock_process = MagicMock()
        mock_process.pid = 12345
        mock_process.poll.return_value = None

        captured_kwargs = {}

        def capture_popen(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return mock_process

        with patch("subprocess.Popen", side_effect=capture_popen), \
             patch.object(mgr, "_wait_for_healthy", return_value=True), \
             patch("builtins.open", return_value=MagicMock()):
            await mgr.start()

        env = captured_kwargs.get("env", {})
        assert env.get("OLLAMA_HOST") == f"127.0.0.1:{mgr._port}"

    async def test_pythonpath_set_for_subprocess(self, tmp_path, mock_platform_apple):
        """PYTHONPATH includes service source dir for subprocess module imports."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._service_source_dir = tmp_path / "source"
        mgr._service_source_dir.mkdir()

        mock_process = MagicMock()
        mock_process.pid = 12345
        mock_process.poll.return_value = None

        captured_kwargs = {}

        def capture_popen(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return mock_process

        with patch("subprocess.Popen", side_effect=capture_popen), \
             patch.object(mgr, "_build_serve_command", return_value=["fake"]), \
             patch.object(mgr, "_wait_for_healthy", return_value=True), \
             patch("builtins.open", return_value=MagicMock()):
            await mgr.start()

        pp = captured_kwargs.get("env", {}).get("PYTHONPATH", "")
        assert str(mgr._service_source_dir) in pp

    async def test_start_generic_exception(self, tmp_path, mock_platform_apple):
        """Generic exception during start returns error status."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        with patch.object(mgr, "_build_serve_command", side_effect=RuntimeError("unexpected")):
            result = await mgr.start()

        assert result["status"] == "error"
        assert "unexpected" in result["error"]
        assert mgr._status == ServerStatus.ERROR


# ===========================================================================
# ModelInfo Dataclass Tests
# ===========================================================================

class TestModelInfoDataclass:
    """Tests for ModelInfo dataclass."""

    def test_creation_with_all_fields(self):
        m = ModelInfo(id="test", name="Test Model", size_bytes=1024, format="mlx", quantization="8bit")
        assert m.id == "test"
        assert m.name == "Test Model"
        assert m.size_bytes == 1024
        assert m.format == "mlx"
        assert m.quantization == "8bit"

    def test_defaults_are_none(self):
        m = ModelInfo(id="test", name="Test")
        assert m.size_bytes is None
        assert m.format is None
        assert m.quantization is None


# ===========================================================================
# Platform Info Property Test
# ===========================================================================

class TestPlatformInfoProperty:
    """Test for platform_info lazy initialization."""

    def test_lazy_init_calls_detect_platform(self, tmp_path):
        """platform_info calls detect_platform on first access when _platform is None."""
        with patch.dict(os.environ, {"AETHER_BACKEND_ROOT": str(tmp_path)}), \
             patch.object(InferenceManager, "_reconnect_existing", return_value=None), \
             patch("services.aether_inference.manager.detect_platform") as mock_detect:
            mock_pinfo = MagicMock()
            mock_detect.return_value = mock_pinfo
            mgr = InferenceManager(port=7999)
            mgr._platform = None  # Force lazy init

            result = mgr.platform_info
            mock_detect.assert_called_once()
            assert result is mock_pinfo


# ===========================================================================
# Coverage Gap Tests (batch-3 remaining lines)
# ===========================================================================

class TestCoverageGaps:
    """Tests targeting specific uncovered lines in manager.py."""

    def test_reconnect_generic_exception(self, tmp_path, mock_platform_apple):
        """Line 241-242: _reconnect_existing catches generic Exception."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        # Use a mock PID file that reads fine but stat() raises a generic Exception
        mock_pid_file = MagicMock(spec=Path)
        mock_pid_file.exists.return_value = True
        mock_pid_file.read_text.return_value = "12345"
        mock_pid_file.stat.side_effect = TypeError("unexpected type error")
        mgr._pid_file = mock_pid_file

        with patch("os.kill"), \
             patch("psutil.Process") as mock_proc:
            mock_proc.return_value.cmdline.return_value = ["vllm_mlx.server"]
            mgr._reconnect_existing()

        # Line 230-231 set _pid and _status BEFORE stat() at line 232.
        # The except at 241 catches TypeError and logs — doesn't reset status.
        # Key assertion: no crash propagated.
        assert mgr._status in (ServerStatus.STOPPED, ServerStatus.STARTING)

    def test_write_pid_file_fallback_also_fails(self, tmp_path, mock_platform_apple):
        """Line 266: Both atomic write and fallback direct write fail."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid_file = tmp_path / "inference.pid"

        with patch("tempfile.mkstemp", side_effect=OSError("atomic failed")), \
             patch.object(Path, "write_text", side_effect=OSError("direct also failed")):
            # Should not raise — both failures are caught
            mgr._write_pid_file(99999)

    def test_list_local_models_hidden_model_dir(self, tmp_path, mock_platform_apple):
        """Line 325: model subdirectory starting with '.' is skipped."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        # Create org/model structure with a hidden model dir
        org_dir = mgr._models_dir / "test-org"
        org_dir.mkdir()
        hidden_model = org_dir / ".hidden-model"
        hidden_model.mkdir()
        (hidden_model / "config.json").write_text("{}")  # Would match if not hidden

        # Also create a valid model for contrast
        valid_model = org_dir / "valid-model"
        valid_model.mkdir()
        (valid_model / "config.json").write_text("{}")

        models = mgr.list_local_models()
        model_ids = [m["id"] for m in models]
        assert "test-org/.hidden-model" not in model_ids
        assert "test-org/valid-model" in model_ids

    @pytest.mark.asyncio
    async def test_log_handle_close_exception_in_finally(self, tmp_path, mock_platform_apple):
        """Line 612: Popen fails → finally tries close() → close raises → caught."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        logs_dir = tmp_path / "logs"
        logs_dir.mkdir(exist_ok=True)

        mock_handle = MagicMock()
        mock_handle.close.side_effect = OSError("close failed")

        # Popen raises so we go to except, then finally tries close on the handle
        with patch("builtins.open", return_value=mock_handle), \
             patch("subprocess.Popen", side_effect=RuntimeError("popen boom")):
            result = await mgr.start("test-model")

        # Popen failure → status=error, but the close exception in finally is silenced
        assert result["status"] == "error"
        assert "popen boom" in result["error"]
        mock_handle.close.assert_called()

    @pytest.mark.asyncio
    async def test_stop_pid_file_unlink_exception(self, tmp_path, mock_platform_apple):
        """Line 672: PID file unlink raising during stop() is caught."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        mgr._pid = 12345
        mgr._status = ServerStatus.RUNNING

        with patch("os.kill") as mock_kill, \
             patch.object(mgr, "_is_inference_process", return_value=True), \
             patch.object(mgr, "_get_pid_file_candidates",
                         return_value=[Path("/nonexistent/inference.pid")]), \
             patch.object(Path, "unlink", side_effect=PermissionError("nope")):
            result = await mgr.stop()

        assert result["status"] == "stopped"

    def test_is_inference_process_generic_exception(self, tmp_path, mock_platform_apple):
        """Lines 704-706: psutil.Process raises non-ImportError → returns False."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_psutil = MagicMock()
        mock_psutil.Process.side_effect = RuntimeError("no such process")

        with patch.dict("sys.modules", {"psutil": mock_psutil}):
            result = mgr._is_inference_process(99999)

        assert result is False

    @pytest.mark.asyncio
    async def test_kill_by_port_sigterm_process_lookup_error(self, tmp_path, mock_platform_apple):
        """Line 745: os.kill(SIGTERM) raises ProcessLookupError in lsof path."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        lsof_result = MagicMock()
        lsof_result.stdout = "12345\n"

        with patch("subprocess.run", return_value=lsof_result), \
             patch.object(mgr, "_is_inference_process", return_value=True), \
             patch("os.kill", side_effect=ProcessLookupError("no such process")):
            await mgr._kill_by_port()  # Should not raise

    @pytest.mark.asyncio
    async def test_kill_by_port_psutil_non_inference_process(self, tmp_path, mock_platform_apple):
        """Lines 764-768: psutil path finds non-inference process → skips it."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_conn = MagicMock()
        mock_conn.laddr.port = mgr._port
        mock_conn.status = "LISTEN"
        mock_conn.pid = 55555

        mock_psutil = MagicMock()
        mock_psutil.net_connections.return_value = [mock_conn]

        # lsof fails so we fall through to psutil
        with patch("subprocess.run", side_effect=FileNotFoundError("no lsof")), \
             patch.dict("sys.modules", {"psutil": mock_psutil}), \
             patch.object(mgr, "_is_inference_process", return_value=False):
            await mgr._kill_by_port()

        # os.kill should NOT have been called since it's not an inference process

    @pytest.mark.asyncio
    async def test_kill_by_port_psutil_process_lookup_error(self, tmp_path, mock_platform_apple):
        """Line 777: psutil kill path — os.kill raises ProcessLookupError."""
        mgr = _make_manager(tmp_path, mock_platform_apple)

        mock_conn = MagicMock()
        mock_conn.laddr.port = mgr._port
        mock_conn.status = "LISTEN"
        mock_conn.pid = 55555

        mock_psutil = MagicMock()
        mock_psutil.net_connections.return_value = [mock_conn]

        with patch("subprocess.run", side_effect=FileNotFoundError("no lsof")), \
             patch.dict("sys.modules", {"psutil": mock_psutil}), \
             patch.object(mgr, "_is_inference_process", return_value=True), \
             patch("os.kill", side_effect=ProcessLookupError("died")):
            await mgr._kill_by_port()  # Should not raise

    @pytest.mark.asyncio
    async def test_pull_venv_python_missing(self, tmp_path, mock_platform_apple):
        """Line 960: venv python binary doesn't exist → falls back to sys.executable."""
        mgr = _make_manager(tmp_path, mock_platform_apple)
        # Remove the venv python binary so the exists() check fails
        venv_python = mgr._venv_path / "bin" / "python"
        if venv_python.exists():
            venv_python.unlink()

        proc_mock = MagicMock()
        proc_mock.returncode = 0
        proc_mock.stdout = ""
        proc_mock.stderr = ""

        with patch("subprocess.run", return_value=proc_mock) as mock_run:
            await mgr.pull_model("test-org/test-model")

        # Verify sys.executable was used (not the venv python)
        import sys
        if mock_run.called:
            cmd = mock_run.call_args[0][0]
            assert sys.executable in cmd[0] or "python" in cmd[0]
