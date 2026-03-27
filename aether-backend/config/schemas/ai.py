import sys
from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import SettingsConfigDict

from config.schemas.core import (
    AetherBaseSettings,
    get_app_root,
    get_bundle_root,
    _resolve_inference_venv,
    _resolve_inference_models_dir,
)

class ServiceProviderConfig(AetherBaseSettings):
    """
    Per-service LLM provider override.
    
    Each backend service (summary, query-gen, vision/OCR) carries one of
    these so users can point individual services at different providers without
    changing the global LLM config.
    
    Resolution order:
      1. If provider is set, use it (with api_base/model/api_key from this config).
      2. If provider is empty (""), use the service-specific default
         (aether_inference for built-in services).
    
    Provider values:
      "aether_inference"     -> local aether_inference server (:7090)
      "openai-compatible"    -> LM Studio / generic OpenAI endpoint
      "ollama"               -> Ollama
      ""                     -> use service default (aether_inference)
    """
    provider: str = ""          # "" = use service default (aether_inference)
    api_base: str = ""          # "" = resolve from provider
    model: str = ""             # "" = use service-specific default model
    api_key: str = "not-needed"

    model_config = SettingsConfigDict(env_prefix="SVC_PROVIDER_")


class LLMSettings(AetherBaseSettings):
    """LLM provider settings.
    
    Default provider: aether_inference (built-in, always available at port 7090).
    Fallback: openai-compatible (LM Studio at :1234) -- user must configure explicitly.
    
    Resolution in interpreter.py:
      provider="aether_inference" → api_base overridden to settings.inference_url (:7090/v1)
      provider="openai-compatible" → uses api_base as-is (user-configured)
    """
    provider: str = "aether_inference"
    api_base: str = "http://127.0.0.1:7090/v1"  # Aether Inference (built-in); LM Studio fallback: http://localhost:1234/v1
    api_key: str = "not-needed"
    model: str = "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"
    summarizer_model: str = "liquid/lfm2.5-1.2b"  # Dedicated lightweight model for chat summarization
    embedding_model: str = "text-embedding-nomic-embed-text-v1.5"
    supports_vision: bool = True
    supports_functions: bool = False  # Function calling capability
    show_thinking: bool = True  # Whether to emit AI reasoning process
    context_window: int = 100000
    max_tokens: int = 51200  # ~50K -- local models are 128K-256K context
    temperature: float = 0.7
    
    model_config = SettingsConfigDict(env_prefix="LLM_")


class ComputerAPISettings(AetherBaseSettings):
    """Computer API configuration."""
    import_computer_api: bool = True  # CRITICAL: Enable computer object in Python execution
    import_skills: bool = True
    skills_path: str = "./skills"
    
    model_config = SettingsConfigDict(env_prefix="COMPUTER_")


class ErrorHandlingSettings(AetherBaseSettings):
    """LLM Error Handling configuration."""
    enabled: bool = True  # Enable user-friendly error parsing
    show_technical_details: bool = True  # Include technical details in error messages
    show_suggestions: bool = True  # Show actionable suggestions
    
    # Error category messages (configurable per deployment)
    context_length_message: str = "The conversation is too long for the AI model. Try starting a new chat or reducing context."
    authentication_message: str = "Authentication failed. Please check your API key configuration."
    rate_limit_message: str = "Rate limit exceeded. Please wait a moment and try again."
    connection_message: str = "Connection error. Unable to reach the AI provider."
    model_error_message: str = "The requested AI model is not available."
    invalid_request_message: str = "Invalid request format. Please try rephrasing your message."
    unknown_error_message: str = "An unexpected error occurred while processing your request."
    
    model_config = SettingsConfigDict(env_prefix="ERROR_HANDLING_")


class ContextRetrievalSettings(AetherBaseSettings):
    """Agent context injection settings for LLM prompts."""
    enabled: bool = True  # Global enable/disable for agent context injection
    max_total_results: int = 20  # Maximum total chunks across all agents
    default_top_k: int = 10  # Default chunks per agent if not specified
    min_score: float = 0.65  # Minimum similarity score threshold
    timeout_ms: int = 10000  # Maximum time for all context retrieval (ms)
    max_concurrent_searches: int = 3  # Max parallel index searches
    
    model_config = SettingsConfigDict(env_prefix="CONTEXT_RETRIEVAL_")


def _get_default_oi_venv() -> str:
    if getattr(sys, 'frozen', False):
        return str(Path.home() / "Library" / "Application Support" / "Aether" / "venv-oi" / "bin" / "python")
    return str(get_app_root() / "venv-oi" / "bin" / "python")

def _get_default_oi_wrapper() -> str:
    return str(get_bundle_root() / "scripts" / "oi_server_wrapper.py")


class InterpreterSettings(AetherBaseSettings):
    """Open Interpreter settings."""
    auto_run: bool = True  # Must be True for external server mode (no confirmation protocol exists)
    loop: bool = False
    safe_mode: str = "off"  # off|ask|auto
    system_message: str = ""
    profile: str = "GURU.yaml"
    offline: bool = True
    disable_telemetry: bool = True
    # External Open Interpreter server mode (OI runs as its own process/service).
    # When enabled, Aether should connect to `interpreter --server` rather than importing OI modules in-process.
    external_server_enabled: bool = False
    # Base URL of the OI server (HTTP), e.g. "http://127.0.0.1:8000"
    external_server_url: Optional[str] = None
    # Optional auth token for OI server WebSocket handshake. Some OI server configs emit {"auth": false}
    # until the client sends {"auth": "<token>"}.
    external_server_auth: Optional[str] = None
    # Per-chat external server isolation:
    # Upstream OI server shares one global interpreter per process. To guarantee chat isolation without
    # vendor edits, Aether can spawn one OI server *process* per chat_id and route each chat to its own port.
    external_server_per_chat: bool = False
    # Optional override host for spawned OI servers. If unset, host is derived from external_server_url.
    external_server_host: Optional[str] = None
    # Port range used by per-chat OI server pool (inclusive).
    external_server_port_min: int = 8010
    external_server_port_max: int = 8079
    # Hard cap for concurrent per-chat OI servers.
    external_server_max_servers: int = 10
    # Idle eviction TTL for per-chat OI servers.
    external_server_ttl_seconds: int = 1800
    # How long to wait for a spawned OI server to pass /heartbeat.
    external_server_startup_timeout_seconds: float = 90.0
    # Path to Python executable for venv-oi (required for per-chat spawn mode).
    external_server_venv_python: Optional[str] = Field(
        default_factory=_get_default_oi_venv
    )
    # Path to the Aether-owned OI server wrapper script.
    external_server_wrapper_script: Optional[str] = Field(
        default_factory=_get_default_oi_wrapper
    )
    computer: ComputerAPISettings = Field(default_factory=ComputerAPISettings)
    error_handling: ErrorHandlingSettings = Field(default_factory=ErrorHandlingSettings)
    context_retrieval: ContextRetrievalSettings = Field(default_factory=ContextRetrievalSettings)
    
    # Context management thresholds (percentages of LLM.context_window)
    # ARCHITECTURAL NOTE: Token limit comes from LLM.context_window, not hardcoded here
    context_warning_threshold: float = 0.80  # Warn at 80%
    context_high_threshold: float = 0.90  # High warning at 90%
    context_critical_threshold: float = 0.95  # Critical at 95%
    
    model_config = SettingsConfigDict(env_prefix="INTERPRETER_")


class VisionDocumentSettings(AetherBaseSettings):
    """Vision and document processing configuration.
    
    The actual vision model URL and name are resolved at runtime via
    resolve_service_provider(provider_config, service_type="vision").
    This works with any provider: aether_inference, LM Studio, Ollama, etc.
    """
    # Per-service provider override (default: aether_inference with default_vision_model)
    provider_config: ServiceProviderConfig = Field(default_factory=ServiceProviderConfig)
    
    # Legacy fields -- model resolution now goes through provider_config.
    # Kept for backward compatibility with existing configs/YAML.
    vision_model: str = ""              # No longer used for pipeline branching
    vision_model_lmstudio: str = ""     # Deprecated: use provider_config.model instead
    
    # OCR engine selection
    ocr_engine: str = "glm-ocr"  # glm-ocr|ocrmac|easyocr|tesseract|rapidocr
    ocr_languages: str = "en"  # Comma-separated language codes
    
    # Vision generation controls (vision proxy only)
    # LFM-VL is a small model -- needs temp >= 0.55 to avoid repetition loops.
    max_tokens: int = 20480  # ~20K -- local models have 128K+ context
    temperature: float = 0.55
    
    # Processing features
    enable_code_enrichment: bool = True
    enable_formula_enrichment: bool = True
    enable_picture_classification: bool = True
    enable_picture_description: bool = True
    
    # Output format
    output_format: str = "markdown"  # markdown|json|text
    
    model_config = SettingsConfigDict(env_prefix="VISION_DOC_")


def _get_default_inference_venv() -> str:
    return str(_resolve_inference_venv(get_app_root()))

def _get_default_inference_models_dir() -> str:
    return str(_resolve_inference_models_dir(get_app_root()))

class InferenceSettings(AetherBaseSettings):
    """
    Aether Inference service configuration (vllm-mlx / vLLM / Ollama managed server).
    
    Port 7090 chosen to avoid collisions:
    - 8010-8099 (OI per-chat server range)
    - 8765 (backend API)
    - 3000/4040/6379/54321 (Docker mesh)
    - 1234/11434 (LM Studio / Ollama external)
    """
    enabled: bool = True
    port: int = 7090
    auto_start: bool = True
    default_model: str = ""  # Platform-resolved at runtime (mlx-community/GLM-OCR-8bit on Mac, zai-org/GLM-OCR on CUDA)
    # Default model identifiers for per-service resolution.
    # Empty = platform-resolved at runtime via detect_platform().
    # These are the models the inference server auto-discovers from models_dir.
    default_text_model: str = ""   # e.g. "lmstudio-community/LFM2.5-1.2B-Instruct-MLX-8bit" -- set during setup or via settings
    default_vision_model: str = "" # e.g. "mlx-community/GLM-OCR-8bit" -- platform-resolved if empty
    health_check_interval: int = 30
    venv_path: str = Field(default_factory=_get_default_inference_venv)  # Set during setup, e.g. $AETHER_BACKEND_ROOT/venv-inference
    models_dir: str = Field(default_factory=_get_default_inference_models_dir)  # Local models directory. Drop model folders here to use them.
    idle_timeout: int = 600  # Seconds of inactivity before unloading a model backend (default 10 min)

    model_config = SettingsConfigDict(env_prefix="INFERENCE_")

    def get_agent_generation_params(self, agent_role: str) -> dict:
        """
        Return smart generation defaults for a specific agent role.
        
        These are NOT exposed to the user in the frontend -- they are
        backend-controlled per-agent tuning based on the task requirements.
        Frontend only shows model name + context window slider.
        
        Args:
            agent_role: One of "summarizer", "query_gen", "ocr",
                        "main_agent", "research", "vision"
        
        Returns:
            dict with temperature, max_tokens, top_p, top_k, repeat_penalty
        """
        return dict(_AGENT_GENERATION_DEFAULTS.get(
            agent_role,
            _AGENT_GENERATION_DEFAULTS["_default"],
        ))


# ---------------------------------------------------------------------------
# Smart per-agent generation defaults (backend-controlled, not user-facing)
# These are tuned for each agent's specific task requirements.
# ---------------------------------------------------------------------------
_AGENT_GENERATION_DEFAULTS = {
    # -----------------------------------------------------------------------
    # DESIGN NOTES:
    #   - Local models are 128K-256K context, so max_tokens can be generous.
    #     10K-20K output tokens is reasonable; models can generate less if
    #     the answer is short.
    #   - LFM 1.2B is a small model: temperature MUST be >= 0.55 or it
    #     falls into degenerate repetition loops.  Keep LFM agents at 0.6+.
    #   - GLM-OCR and Qwen3 are different architectures; their temps are set
    #     independently based on task needs.
    # -----------------------------------------------------------------------

    # Summarizer (LFM text): faithful summaries but needs warmth for fluency
    # Note: SummaryServiceSettings has its own temp/max_tokens which override
    # these for the summary pipeline.  Kept here for API consumers.
    "summarizer": {
        "temperature": 0.6,
        "max_tokens": 30720,       # ~30K
        "top_p": 0.9,
        "top_k": 40,
        "repeat_penalty": 1.1,
    },
    # Query generation (LFM text): analytical pattern detection, but needs
    # enough warmth for diverse output on a small model.
    "query_gen": {
        "temperature": 0.6,
        "max_tokens": 4096,       # Increased from 1K to 4K to accommodate <think> reasoning blocks without truncation
        "top_p": 0.85,
        "top_k": 30,
        "repeat_penalty": 1.2,  # Penalise repetitive queries
    },
    # OCR (GLM-OCR vision model -- NOT LFM): zero temp for exact text repro.
    "ocr": {
        "temperature": 0.0,
        "max_tokens": 20480,       # ~20K
        "top_p": 1.0,
        "top_k": 0,  # Greedy decoding for OCR
        "repeat_penalty": 1.0,
    },
    # Main chat agent (Qwen 3.5 4B -- NOT LFM): balanced creativity + accuracy.
    "main_agent": {
        "temperature": 0.7,
        "max_tokens": 51200,       # ~50K
        "top_p": 0.9,
        "top_k": 40,
        "repeat_penalty": 1.0,
    },
    # Research / prompt enhancer (LFM text): query expansion benefits from
    # moderate creativity but small model still needs warmth.
    "research": {
        "temperature": 0.6,
        "max_tokens": 40960,       # ~40K
        "top_p": 0.9,
        "top_k": 40,
        "repeat_penalty": 1.15,
    },
    # Vision analysis (LFM-VL -- small vision model, same family as LFM)
    "vision": {
        "temperature": 0.55,
        "max_tokens": 20480,       # ~20K
        "top_p": 0.9,
        "top_k": 40,
        "repeat_penalty": 1.0,
    },
    # Fallback default (safe for any model)
    "_default": {
        "temperature": 0.7,
        "max_tokens": 30720,       # ~30K
        "top_p": 0.9,
        "top_k": 40,
        "repeat_penalty": 1.0,
    },
}
