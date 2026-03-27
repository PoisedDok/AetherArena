"""
Aether Inference Service

Native process-managed inference server for on-device model hosting.
Supports vllm-mlx (Apple Silicon), vLLM (NVIDIA CUDA), and Ollama (fallback).

@.architecture
Incoming: api/v1/endpoints/inference.py, core/integrations/providers/aether_inference/ --- {API calls, health checks}
Processing: platform detection, process lifecycle management, model management --- {3 jobs: JOB_INITIALIZE_COMPONENT, JOB_MANAGE_TASK, JOB_HEALTH_CHECK}
Outgoing: Native inference process (vllm-mlx/vllm/ollama) on port from central config --- {OpenAI-compatible API}
"""

from .platform_detector import detect_platform, PlatformInfo
from .manager import InferenceManager
from .inference_control import ensure_inference_running, inference_shutdown, get_inference_status

__all__ = [
    "detect_platform",
    "PlatformInfo",
    "InferenceManager",
    "ensure_inference_running",
    "inference_shutdown",
    "get_inference_status",
]
