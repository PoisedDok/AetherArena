"""
Tests for services/aether_inference/platform.py

Covers: GPU detection, platform detection, engine selection, recommended models,
model status with download checks. All subprocess calls mocked.
"""

from unittest.mock import patch, MagicMock
from services.aether_inference.platform_detector import (
    _detect_gpu,
    detect_platform,
    get_recommended_models,
    get_recommended_models_status,
    PlatformInfo,
    GPUType,
    InferenceEngine,
    _recommended_mlx,
    _recommended_cuda,
    _recommended_cpu,
)


# ===========================================================================
# GPU Detection Tests
# ===========================================================================

class TestDetectGPU:
    """Tests for _detect_gpu function."""

    @patch("services.aether_inference.platform_detector.platform")
    @patch("services.aether_inference.platform_detector.subprocess")
    def test_apple_silicon_detection(self, mock_subprocess, mock_platform):
        """Apple Silicon detection on darwin arm64."""
        mock_platform.system.return_value = "Darwin"
        mock_platform.machine.return_value = "arm64"

        # Mock sysctl for chip name
        chip_result = MagicMock()
        chip_result.returncode = 0
        chip_result.stdout = "Apple M4 Max"

        # Mock sysctl for memory
        mem_result = MagicMock()
        mem_result.returncode = 0
        mem_result.stdout = str(64 * 1024**3)  # 64GB

        mock_subprocess.run.side_effect = [chip_result, mem_result]

        gpu_type, gpu_name, gpu_memory = _detect_gpu()
        assert gpu_type == GPUType.APPLE_SILICON
        assert gpu_name == "Apple M4 Max"
        assert gpu_memory == 64.0

    @patch("services.aether_inference.platform_detector.platform")
    @patch("services.aether_inference.platform_detector.subprocess")
    def test_apple_silicon_subprocess_failure(self, mock_subprocess, mock_platform):
        """Apple Silicon detected even if subprocess fails."""
        mock_platform.system.return_value = "Darwin"
        mock_platform.machine.return_value = "arm64"
        mock_subprocess.run.side_effect = Exception("sysctl not found")

        gpu_type, gpu_name, gpu_memory = _detect_gpu()
        assert gpu_type == GPUType.APPLE_SILICON
        assert gpu_name == "Apple Silicon"

    @patch("services.aether_inference.platform_detector.platform")
    @patch("services.aether_inference.platform_detector.shutil")
    @patch("services.aether_inference.platform_detector.subprocess")
    def test_nvidia_detection(self, mock_subprocess, mock_shutil, mock_platform):
        """NVIDIA GPU detection via nvidia-smi."""
        mock_platform.system.return_value = "Linux"
        mock_platform.machine.return_value = "x86_64"
        mock_shutil.which.return_value = "/usr/bin/nvidia-smi"

        result = MagicMock()
        result.returncode = 0
        result.stdout = "NVIDIA RTX 4090, 24576"
        mock_subprocess.run.return_value = result

        gpu_type, gpu_name, gpu_memory = _detect_gpu()
        assert gpu_type == GPUType.NVIDIA
        assert "4090" in gpu_name
        assert gpu_memory == 24.0

    @patch("services.aether_inference.platform_detector.platform")
    @patch("services.aether_inference.platform_detector.shutil")
    def test_no_gpu(self, mock_shutil, mock_platform):
        """No GPU detected on Linux without nvidia-smi."""
        mock_platform.system.return_value = "Linux"
        mock_platform.machine.return_value = "x86_64"
        mock_shutil.which.return_value = None

        gpu_type, gpu_name, gpu_memory = _detect_gpu()
        assert gpu_type == GPUType.NONE
        assert gpu_name is None

    @patch("services.aether_inference.platform_detector.platform")
    @patch("services.aether_inference.platform_detector.shutil")
    @patch("services.aether_inference.platform_detector.subprocess")
    def test_nvidia_smi_exception_falls_through(self, mock_subprocess, mock_shutil, mock_platform):
        """Lines 126-127: nvidia-smi found but subprocess.run raises → falls through to NONE."""
        mock_platform.system.return_value = "Linux"
        mock_platform.machine.return_value = "x86_64"
        mock_shutil.which.return_value = "/usr/bin/nvidia-smi"
        mock_subprocess.run.side_effect = Exception("nvidia-smi segfault")

        gpu_type, gpu_name, gpu_memory = _detect_gpu()
        assert gpu_type == GPUType.NONE
        assert gpu_name is None
        assert gpu_memory is None


# ===========================================================================
# Platform Detection Tests
# ===========================================================================

class TestDetectPlatform:
    """Tests for detect_platform function."""

    @patch("services.aether_inference.platform_detector._detect_gpu")
    @patch("services.aether_inference.platform_detector.platform")
    def test_apple_silicon_selects_vllm_mlx(self, mock_platform, mock_gpu):
        """Apple Silicon selects vllm-mlx engine."""
        mock_platform.system.return_value = "Darwin"
        mock_platform.machine.return_value = "arm64"
        mock_gpu.return_value = (GPUType.APPLE_SILICON, "Apple M4", 64.0)

        info = detect_platform()
        assert info.engine == InferenceEngine.VLLM_MLX
        assert info.is_apple_silicon
        assert info.engine_command == "python"
        assert "vllm_mlx.server" in info.engine_serve_args[1]

    @patch("services.aether_inference.platform_detector._detect_gpu")
    @patch("services.aether_inference.platform_detector.platform")
    def test_nvidia_linux_selects_vllm(self, mock_platform, mock_gpu):
        """NVIDIA on Linux selects vLLM engine."""
        mock_platform.system.return_value = "Linux"
        mock_platform.machine.return_value = "x86_64"
        mock_gpu.return_value = (GPUType.NVIDIA, "RTX 4090", 24.0)

        info = detect_platform()
        assert info.engine == InferenceEngine.VLLM
        assert info.is_nvidia
        assert info.engine_command == "vllm"

    @patch("services.aether_inference.platform_detector._detect_gpu")
    @patch("services.aether_inference.platform_detector.platform")
    def test_no_gpu_selects_ollama(self, mock_platform, mock_gpu):
        """No GPU falls back to Ollama."""
        mock_platform.system.return_value = "Linux"
        mock_platform.machine.return_value = "x86_64"
        mock_gpu.return_value = (GPUType.NONE, None, None)

        info = detect_platform()
        assert info.engine == InferenceEngine.OLLAMA
        assert info.engine_command == "ollama"
        assert info.pip_install_target is None


# ===========================================================================
# PlatformInfo Dataclass Tests
# ===========================================================================

class TestPlatformInfo:
    """Tests for PlatformInfo properties."""

    def test_is_apple_silicon(self):
        info = PlatformInfo(os="darwin", arch="arm64", gpu=GPUType.APPLE_SILICON)
        assert info.is_apple_silicon is True
        assert info.is_nvidia is False

    def test_is_nvidia(self):
        info = PlatformInfo(os="linux", arch="x86_64", gpu=GPUType.NVIDIA)
        assert info.is_nvidia is True
        assert info.is_apple_silicon is False

    def test_engine_display_name(self):
        info = PlatformInfo(
            os="darwin", arch="arm64", gpu=GPUType.APPLE_SILICON,
            engine=InferenceEngine.VLLM_MLX
        )
        assert "Apple Silicon" in info.engine_display_name

    def test_default_values(self):
        info = PlatformInfo(os="linux", arch="x86_64", gpu=GPUType.NONE)
        assert info.engine == InferenceEngine.OLLAMA
        assert info.glm_ocr_model == "glm-ocr"


# ===========================================================================
# Recommended Models Tests
# ===========================================================================

class TestRecommendedModels:
    """Tests for model recommendation functions."""

    def test_mlx_models(self):
        models = _recommended_mlx()
        assert len(models) == 4
        roles = {m.role for m in models}
        assert roles == {"text", "ocr", "main_agent", "vision"}
        # All have required set
        required = [m for m in models if m.required]
        assert len(required) == 3

    def test_cuda_models(self):
        models = _recommended_cuda()
        assert len(models) == 4
        roles = {m.role for m in models}
        assert roles == {"text", "ocr", "main_agent", "vision"}

    def test_cpu_models(self):
        models = _recommended_cpu()
        assert len(models) == 4

    def test_cpu_models_no_mlx_ids(self):
        """CPU/Ollama models must NOT contain MLX-quantized model IDs.
        
        MLX models require Apple Silicon Metal GPU via vllm-mlx.
        CPU path uses Ollama pull names or HuggingFace GGUF repos.
        Regression: previously used 'lmstudio-community/*-MLX-*' IDs that
        can't be loaded by llama-cpp or Ollama.
        """
        models = _recommended_cpu()
        for model in models:
            assert "-MLX-" not in model.model_id, (
                f"CPU model {model.model_id} contains MLX-specific quantization "
                f"that won't work on Ollama/llama-cpp"
            )
            # GGUF context window is 32K, not 128K (MLX extends it)
            if "GGUF" in model.model_id:
                assert model.context_window <= 32768, (
                    f"GGUF model {model.model_id} has context_window={model.context_window} "
                    f"but GGUF LFM supports max 32768"
                )

    def test_mlx_models_all_mlx_format(self):
        """MLX recommended models should be MLX-quantized or MLX-compatible."""
        models = _recommended_mlx()
        for model in models:
            # MLX models from lmstudio-community or mlx-community
            assert any(prefix in model.model_id for prefix in ("lmstudio-community/", "mlx-community/")), (
                f"MLX model {model.model_id} doesn't appear to be from an MLX community"
            )

    def test_cuda_models_no_mlx_ids(self):
        """CUDA models should use full-precision HuggingFace IDs, not MLX."""
        models = _recommended_cuda()
        for model in models:
            assert "-MLX-" not in model.model_id, (
                f"CUDA model {model.model_id} contains MLX-specific quantization"
            )

    @patch("services.aether_inference.platform_detector.detect_platform")
    def test_get_recommended_models_auto(self, mock_detect):
        """get_recommended_models auto-detects when no pinfo given."""
        mock_detect.return_value = PlatformInfo(
            os="darwin", arch="arm64", gpu=GPUType.APPLE_SILICON,
            engine=InferenceEngine.VLLM_MLX
        )
        models = get_recommended_models()
        assert len(models) == 4

    def test_get_recommended_models_explicit_platform(self):
        """get_recommended_models with explicit platform info."""
        pinfo = PlatformInfo(os="linux", arch="x86_64", gpu=GPUType.NVIDIA)
        models = get_recommended_models(pinfo)
        assert len(models) == 4

    def test_get_recommended_models_cpu(self):
        pinfo = PlatformInfo(os="linux", arch="x86_64", gpu=GPUType.NONE)
        models = get_recommended_models(pinfo)
        assert len(models) == 4


# ===========================================================================
# Model Status Tests
# ===========================================================================

class TestRecommendedModelsStatus:
    """Tests for get_recommended_models_status."""

    def test_status_no_models_dir(self):
        """Status with no models_dir shows all as not downloaded."""
        pinfo = PlatformInfo(os="linux", arch="x86_64", gpu=GPUType.NONE)
        result = get_recommended_models_status(pinfo, models_dir=None)
        assert len(result) == 4
        assert all(not m["downloaded"] for m in result)

    def test_status_nonexistent_dir(self, tmp_path):
        """Status with nonexistent dir shows all as not downloaded."""
        pinfo = PlatformInfo(os="linux", arch="x86_64", gpu=GPUType.NONE)
        result = get_recommended_models_status(pinfo, models_dir=str(tmp_path / "nonexistent"))
        assert all(not m["downloaded"] for m in result)

    @patch("services.aether_inference.platform_detector.detect_platform")
    def test_status_auto_detect_when_pinfo_none(self, mock_detect):
        """Line 391: pinfo=None triggers detect_platform() internally."""
        mock_detect.return_value = PlatformInfo(
            os="linux", arch="x86_64", gpu=GPUType.NONE
        )
        result = get_recommended_models_status(pinfo=None, models_dir=None)
        mock_detect.assert_called_once()
        assert len(result) == 4
        assert all(not m["downloaded"] for m in result)

    def test_status_with_downloaded_model(self, tmp_path):
        """Status detects downloaded models."""
        pinfo = PlatformInfo(os="linux", arch="x86_64", gpu=GPUType.NONE)
        
        # Create a fake model directory structure matching the CPU/GGUF recommended text model.
        # _recommended_cpu() returns "LiquidAI/LFM2.5-1.2B-Instruct-GGUF" for the text role.
        model_dir = tmp_path / "LiquidAI" / "LFM2.5-1.2B-Instruct-GGUF"
        model_dir.mkdir(parents=True)
        (model_dir / "config.json").write_text("{}")
        
        result = get_recommended_models_status(pinfo, models_dir=str(tmp_path))
        downloaded = [m for m in result if m["downloaded"]]
        assert len(downloaded) >= 1
        assert downloaded[0]["local_path"] is not None


# ===========================================================================
# Enum Tests
# ===========================================================================

class TestEnums:
    """Tests for InferenceEngine and GPUType enums."""

    def test_inference_engine_values(self):
        assert InferenceEngine.VLLM_MLX.value == "vllm-mlx"
        assert InferenceEngine.VLLM.value == "vllm"
        assert InferenceEngine.OLLAMA.value == "ollama"

    def test_gpu_type_values(self):
        assert GPUType.APPLE_SILICON.value == "apple_silicon"
        assert GPUType.NVIDIA.value == "nvidia"
        assert GPUType.NONE.value == "none"
