"""
Platform Detection for Aether Inference

Detects OS, architecture, GPU availability, and selects the optimal inference engine.
Also provides recommended model sets per platform for onboarding.

@.architecture
Incoming: manager.py, setup.py, inference.py endpoints --- {function calls for platform detection}
Processing: detect_platform(), get_recommended_models() --- {2 jobs: JOB_DISCOVER_TOOLS, JOB_RECOMMEND_MODELS}
Outgoing: manager.py, setup.py, inference.py --- {PlatformInfo dataclass with engine choice and model format, recommended models list}
"""

import platform
import shutil
import subprocess
import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class InferenceEngine(str, Enum):
    """Supported inference engines."""
    VLLM_MLX = "vllm-mlx"     # Apple Silicon via vllm-mlx (mlx-lm + mlx-vlm, Metal GPU)
    VLLM = "vllm"              # NVIDIA CUDA via official vLLM
    OLLAMA = "ollama"          # Fallback: llama.cpp-based (Metal/CUDA/CPU)


class GPUType(str, Enum):
    """Detected GPU type."""
    APPLE_SILICON = "apple_silicon"  # M1/M2/M3/M4 unified memory + Metal
    NVIDIA = "nvidia"               # CUDA-capable GPU
    NONE = "none"                   # CPU only


@dataclass
class PlatformInfo:
    """Platform detection result with engine recommendation."""
    os: str                          # darwin, linux, windows
    arch: str                        # arm64, x86_64
    gpu: GPUType                     # apple_silicon, nvidia, none
    gpu_name: Optional[str] = None   # e.g. "Apple M4 Max", "NVIDIA RTX 4090"
    gpu_memory_gb: Optional[float] = None
    engine: InferenceEngine = InferenceEngine.OLLAMA
    
    # Model identifiers for GLM-OCR per engine
    glm_ocr_model: str = "glm-ocr"  # Ollama default
    
    # Engine binary/command
    engine_command: str = "ollama"
    engine_serve_args: list = field(default_factory=list)
    
    # pip install target for venv setup
    pip_install_target: Optional[str] = None
    
    @property
    def is_apple_silicon(self) -> bool:
        return self.os == "darwin" and self.arch == "arm64"
    
    @property
    def is_nvidia(self) -> bool:
        return self.gpu == GPUType.NVIDIA
    
    @property
    def engine_display_name(self) -> str:
        return {
            InferenceEngine.VLLM_MLX: "vLLM-MLX (Apple Silicon Metal)",
            InferenceEngine.VLLM: "vLLM (NVIDIA CUDA)",
            InferenceEngine.OLLAMA: "Ollama",
        }.get(self.engine, str(self.engine))


def _detect_gpu() -> tuple[GPUType, Optional[str], Optional[float]]:
    """
    Detect GPU type, name, and available memory.
    
    Returns:
        Tuple of (gpu_type, gpu_name, gpu_memory_gb)
    """
    system = platform.system().lower()
    machine = platform.machine().lower()
    
    # Apple Silicon detection (M-series chips)
    if system == "darwin" and machine == "arm64":
        gpu_name = None
        gpu_memory_gb = None
        try:
            # Get chip name
            result = subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                gpu_name = result.stdout.strip()
        except Exception:
            gpu_name = "Apple Silicon"
        
        try:
            # Get total unified memory
            result = subprocess.run(
                ["sysctl", "-n", "hw.memsize"],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                gpu_memory_gb = int(result.stdout.strip()) / (1024 ** 3)
        except Exception:
            pass
        
        return GPUType.APPLE_SILICON, gpu_name, gpu_memory_gb
    
    # NVIDIA GPU detection (Linux/Windows)
    if shutil.which("nvidia-smi"):
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0 and result.stdout.strip():
                parts = result.stdout.strip().split(",")
                gpu_name = parts[0].strip() if len(parts) > 0 else "NVIDIA GPU"
                gpu_memory_mb = float(parts[1].strip()) if len(parts) > 1 else None
                gpu_memory_gb = gpu_memory_mb / 1024 if gpu_memory_mb else None
                return GPUType.NVIDIA, gpu_name, gpu_memory_gb
        except Exception as e:
            logger.debug(f"nvidia-smi query failed: {e}")
    
    return GPUType.NONE, None, None


def detect_platform() -> PlatformInfo:
    """
    Detect platform capabilities and select optimal inference engine.
    
    Decision tree:
    1. macOS + arm64 → vllm-mlx (native Metal GPU acceleration)
    2. Linux + NVIDIA GPU → vLLM (CUDA acceleration)
    3. Everything else → Ollama (llama.cpp with auto-detected acceleration)
    
    Returns:
        PlatformInfo with engine selection and model identifiers
    """
    system = platform.system().lower()
    machine = platform.machine().lower()
    gpu_type, gpu_name, gpu_memory_gb = _detect_gpu()
    
    info = PlatformInfo(
        os=system,
        arch=machine,
        gpu=gpu_type,
        gpu_name=gpu_name,
        gpu_memory_gb=gpu_memory_gb,
    )
    
    # Engine selection
    if gpu_type == GPUType.APPLE_SILICON:
        info.engine = InferenceEngine.VLLM_MLX
        info.glm_ocr_model = "mlx-community/GLM-OCR-8bit"
        # IMPORTANT: Use `python -m vllm_mlx.server` (NOT `vllm-mlx serve`).
        # The CLI `vllm-mlx serve` does NOT expose the --mllm flag needed for VLM models like GLM-OCR.
        # The `vllm_mlx.server` module has full argparse support including --mllm.
        info.engine_command = "python"
        info.engine_serve_args = ["-m", "vllm_mlx.server", "--mllm"]
        # Install from git for mlx-lm 0.30.6+ compat; PyPI 0.2.5 is stale
        info.pip_install_target = "vllm-mlx[vision] @ git+https://github.com/waybarrios/vllm-mlx.git"
        
    elif gpu_type == GPUType.NVIDIA and system == "linux":
        info.engine = InferenceEngine.VLLM
        info.glm_ocr_model = "zai-org/GLM-OCR"
        info.engine_command = "vllm"
        info.engine_serve_args = ["serve"]
        info.pip_install_target = "vllm"
        
    else:
        # Fallback: Ollama (works on Mac Intel, Windows, Linux without NVIDIA)
        info.engine = InferenceEngine.OLLAMA
        info.glm_ocr_model = "glm-ocr"
        info.engine_command = "ollama"
        info.engine_serve_args = ["serve"]
        info.pip_install_target = None  # Ollama is a standalone binary, not pip-installed
    
    logger.info(
        "Platform detected: os=%s arch=%s gpu=%s engine=%s model=%s",
        info.os, info.arch, info.gpu.value, info.engine.value, info.glm_ocr_model
    )
    
    return info


# ---------------------------------------------------------------------------
# Recommended Models
# ---------------------------------------------------------------------------

@dataclass
class RecommendedModel:
    """A recommended model for a specific role in the Aether pipeline."""
    model_id: str              # HuggingFace-style ID (org/model)
    role: str                  # "text", "ocr", "main_agent", "vision"
    display_name: str          # Human-readable name for UI
    description: str           # Short description of what it does
    size_hint: str             # e.g. "~1.2 GB", "~2.4 GB"
    default_for: List[str]     # Which settings keys this is default for
    required: bool = False     # Whether this model is required for core features
    context_window: int = 0    # Context window size (0 = unknown)


def get_recommended_models(pinfo: Optional[PlatformInfo] = None) -> List[RecommendedModel]:
    """
    Return the recommended set of models for onboarding.
    
    Platform-adaptive: returns MLX quantized models for Apple Silicon,
    full-precision models for NVIDIA, and GGUF-compatible options for others.
    
    The 4 core recommended models:
      1. Text (summary/query-gen): Lightweight fast text model
      2. OCR: GLM-OCR for document understanding
      3. Main Agent: Qwen3-4B for primary chat
      4. Vision: LFM2.5-VL for image understanding
    """
    if pinfo is None:
        pinfo = detect_platform()
    
    if pinfo.gpu == GPUType.APPLE_SILICON:
        return _recommended_mlx()
    elif pinfo.gpu == GPUType.NVIDIA:
        return _recommended_cuda()
    else:
        return _recommended_cpu()


def _recommended_mlx() -> List[RecommendedModel]:
    """Recommended models for Apple Silicon (MLX format)."""
    return [
        RecommendedModel(
            model_id="lmstudio-community/LFM2.5-1.2B-Instruct-MLX-8bit",
            role="text",
            display_name="LFM 2.5 1.2B",
            description="Fast lightweight text model for summaries and query generation",
            size_hint="~1.2 GB",
            default_for=["inference.default_text_model", "llm.summarizer_model"],
            required=True,
            context_window=128000,
        ),
        RecommendedModel(
            model_id="mlx-community/GLM-OCR-8bit",
            role="ocr",
            display_name="GLM-OCR",
            description="State-of-the-art document OCR for text, tables, and formulas",
            size_hint="~1.0 GB",
            default_for=["vision_document.provider_config.model"],
            required=True,
            context_window=131072,
        ),
        RecommendedModel(
            model_id="lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
            role="main_agent",
            display_name="Qwen 3.5 4B (Multimodal)",
            description="Primary chat model for the main AI assistant with strong reasoning and early-fusion vision capabilities",
            size_hint="~4.0 GB",
            default_for=["llm.model"],
            required=True,
            context_window=262144,
        ),
        RecommendedModel(
            model_id="lmstudio-community/LFM2.5-VL-1.6B-MLX-6bit",
            role="vision",
            display_name="LFM 2.5 Vision 1.6B",
            description="Lightweight vision-language model for image understanding and analysis",
            size_hint="~1.8 GB",
            default_for=["inference.default_vision_model"],
            required=False,
            context_window=128000,
        ),
    ]


def _recommended_cuda() -> List[RecommendedModel]:
    """Recommended models for NVIDIA CUDA (full precision safetensors)."""
    return [
        RecommendedModel(
            model_id="LiquidAI/LFM2.5-1.2B-Instruct",
            role="text",
            display_name="LFM 2.5 1.2B",
            description="Fast lightweight text model for summaries and query generation",
            size_hint="~2.4 GB",
            default_for=["inference.default_text_model", "llm.summarizer_model"],
            required=True,
            context_window=128000,
        ),
        RecommendedModel(
            model_id="zai-org/GLM-OCR",
            role="ocr",
            display_name="GLM-OCR",
            description="State-of-the-art document OCR for text, tables, and formulas",
            size_hint="~1.8 GB",
            default_for=["vision_document.provider_config.model"],
            required=True,
            context_window=131072,
        ),
        RecommendedModel(
            model_id="Qwen/Qwen3-4B",
            role="main_agent",
            display_name="Qwen 3.5 4B",
            description="Primary chat model for the main AI assistant with strong reasoning",
            size_hint="~8.0 GB",
            default_for=["llm.model"],
            required=True,
            context_window=262144,
        ),
        RecommendedModel(
            model_id="LiquidAI/LFM2.5-VL-1.6B",
            role="vision",
            display_name="LFM 2.5 Vision 1.6B",
            description="Lightweight vision-language model for image understanding and analysis",
            size_hint="~3.2 GB",
            default_for=["inference.default_vision_model"],
            required=False,
            context_window=128000,
        ),
    ]


def _recommended_cpu() -> List[RecommendedModel]:
    """Recommended models for CPU/Ollama (GGUF where available, or Ollama pull names).
    
    IMPORTANT: Model IDs here MUST be Ollama-compatible pull names or HuggingFace GGUF
    repos. MLX-quantized model IDs (lmstudio-community/*-MLX-*) will NOT work on
    llama-cpp or Ollama — they require Metal GPU via vllm-mlx.
    """
    return [
        RecommendedModel(
            model_id="LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
            role="text",
            display_name="LFM 2.5 1.2B",
            description="Fast lightweight text model for summaries, query generation, and agents (GGUF)",
            size_hint="~1.2 GB",
            default_for=["inference.default_text_model", "llm.summarizer_model"],
            required=True,
            context_window=32768,
        ),
        RecommendedModel(
            model_id="glm-ocr",
            role="ocr",
            display_name="GLM-OCR",
            description="State-of-the-art document OCR for text, tables, and formulas (via Ollama)",
            size_hint="~1.0 GB",
            default_for=["vision_document.provider_config.model"],
            required=True,
            context_window=131072,
        ),
        RecommendedModel(
            model_id="qwen3:4b",
            role="main_agent",
            display_name="Qwen 3.5 4B",
            description="Primary chat model for the main AI assistant with strong reasoning",
            size_hint="~2.6 GB",
            default_for=["llm.model"],
            required=True,
            context_window=262144,
        ),
        RecommendedModel(
            model_id="LiquidAI/LFM2.5-VL-1.6B-GGUF",
            role="vision",
            display_name="LFM 2.5 Vision 1.6B",
            description="Lightweight vision-language model for image understanding and analysis (GGUF)",
            size_hint="~1.8 GB",
            default_for=["inference.default_vision_model"],
            required=False,
            context_window=32768,
        ),
    ]


def get_recommended_models_status(
    pinfo: Optional[PlatformInfo] = None,
    models_dir: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Return recommended models with their download status.
    
    Checks the local models_dir to determine which models are already
    downloaded and ready to use.
    
    Returns:
        List of dicts with model info + "downloaded" boolean.
    """
    from pathlib import Path
    
    if pinfo is None:
        pinfo = detect_platform()
    
    models = get_recommended_models(pinfo)
    result = []
    
    models_path = Path(models_dir) if models_dir else None
    
    for model in models:
        downloaded = False
        local_path = None
        
        if models_path and models_path.exists():
            # Check for model directory in models_dir (org/name structure)
            candidate = models_path / model.model_id.replace("/", "/")
            if candidate.is_dir() and (candidate / "config.json").exists():
                downloaded = True
                local_path = str(candidate)
        
        result.append({
            "model_id": model.model_id,
            "role": model.role,
            "display_name": model.display_name,
            "description": model.description,
            "size_hint": model.size_hint,
            "default_for": model.default_for,
            "required": model.required,
            "context_window": model.context_window,
            "downloaded": downloaded,
            "local_path": local_path,
        })
    
    return result
