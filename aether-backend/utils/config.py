"""
Simple config loader for backend components.
Reads directly from the centralized TOML config.

@.architecture
Incoming: config/models.toml, config/settings.py --- {Path, Dict[str, Any]}
Processing: load centralized config, derive fallback defaults, expose provider settings --- {JOB_APPLY_CONFIG, JOB_LOAD_CONFIG}
Outgoing: config/settings.py, core/runtime/engine.py, other modules --- {Dict[str, Any], str provider_url}
"""

import logging
import os
import sys
import toml
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


def _normalize_model_name(model: str, provider: str) -> str:
    """
    Ensure LiteLLM receives provider-qualified model identifiers.
    """
    provider_normalized = (provider or "").strip().lower()
    prefix_map = {
        "aether_inference": "openai/",  # Aether Inference serves OpenAI-compatible API
        "openai-compatible": "openai/",
        "openai": "openai/",
        "lmstudio": "lmstudio/",
        "ollama": "ollama/",
    }
    prefix = prefix_map.get(provider_normalized)
    if not prefix:
        return model
    if model.startswith(prefix):
        return model
    return f"{prefix}{model}"

def load_config() -> Dict[str, Any]:
    """Load configuration from the centralized TOML file."""
    try:
        # NEW BACKEND: Load from config/models.toml
        # In packaged mode, priority is CWD or next to executable
        if getattr(sys, 'frozen', False):
            # PACKAGED MODE: Check CWD first, then executable dir
            exe_dir = Path(sys.executable).parent
            cwd = Path.cwd()
            
            # Search paths for models.toml
            # AETHER_BACKEND_ROOT (writable data dir) first — start_production.sh
            # may copy config files there.  Then CWD, exe_dir, and bundle fallbacks.
            backend_root_env = os.environ.get("AETHER_BACKEND_ROOT")
            candidates = []
            if backend_root_env:
                candidates.append(Path(backend_root_env) / "config" / "models.toml")
            candidates.extend([
                cwd / "config" / "models.toml",
                cwd / "models.toml",
                exe_dir / "config" / "models.toml",
                exe_dir / "models.toml",
                # Fallback to internal bundle if not found externally
                Path(getattr(sys, '_MEIPASS', exe_dir / "_internal")) / "config" / "models.toml",
                # New standard for onedir mode in collecting datas
                exe_dir / "_internal" / "config" / "models.toml",
            ])
            
            config_file = None
            for path in candidates:
                if path.exists():
                    config_file = path
                    break
            
            if not config_file:
                # If still not found, try the relative path from bundle root
                config_file = Path(getattr(sys, '_MEIPASS', exe_dir / "_internal")) / "config" / "models.toml"
        else:
            # DEVELOPMENT MODE: Load from source tree
            config_file = Path(__file__).parent.parent / "config" / "models.toml"
            
        with open(config_file, 'r') as f:
            return toml.load(f)
    except Exception as e:
        logger.warning("Failed to load centralized config: %s", e)
        return get_fallback_config()

def get_fallback_config() -> Dict[str, Any]:
    """Fallback configuration if TOML file can't be loaded."""
    return {
        "MODELS": {
            "primary_chat_model": "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
            "fallback_chat_model": "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
            "primary_embedding_model": "text-embedding-nomic-embed-text-v1.5",
            "fallback_embedding_model": "Xenova/bge-small-en-v1.5"
        },
        "PROVIDERS": {
            "aether_inference_url": "http://127.0.0.1:7090/v1",
            "aether_inference_api_key": "not-needed",
            "lm_studio_url": "http://localhost:1234/v1",
            "lm_studio_api_key": "not-needed",
            "perplexica_url": "http://localhost:3000",
            "searxng_url": "http://127.0.0.1:4040",
            "openrouter_url": "https://openrouter.ai/api/v1",
            "openrouter_api_key": "",
        },
        "EMBEDDINGS": {
            "primary_provider": "perplexica",
            "primary_model": "Xenova/bge-small-en-v1.5",
            "primary_api_base": "http://localhost:3000/api",
            "primary_api_key": "not-needed",
            "timeout_seconds": 30.0,
            "fallback_provider": "lmstudio",
            "fallback_api_base": "http://localhost:1234/v1",
            "fallback_api_key": "not-needed",
            "fallback_app_name": "Aether Backend",
            "fallback_site_url": "http://localhost:8765",
        },
        "OPEN_INTERPRETER": {
            "context_window": 100000,
            "max_tokens": 4096,
            "supports_vision": True,
            "supports_functions": False,
            "offline": True,
            "disable_telemetry": True
        }
    }

def get_llm_settings() -> Dict[str, Any]:
    """Get LLM settings from centralized config."""
    config = load_config()
    oi_config = config["OPEN_INTERPRETER"]
    provider_config = config["PROVIDERS"]
    provider = "aether_inference"
    model_name = config["MODELS"]["primary_chat_model"]
    
    return {
        "provider": provider,
        "api_base": provider_config.get("aether_inference_url", "http://127.0.0.1:7090/v1"),
        "model": _normalize_model_name(model_name, provider),
        "supports_vision": oi_config["supports_vision"],
        "context_window": oi_config["context_window"],
        "max_tokens": oi_config["max_tokens"]
    }

def get_provider_url(provider: str) -> Optional[str]:
    """Get URL for a specific provider (None when unknown)."""
    config = load_config()
    providers = config["PROVIDERS"]
    
    url_map = {
        "aether_inference": providers.get("aether_inference_url", "http://127.0.0.1:7090/v1"),
        "lm_studio": providers["lm_studio_url"],
        "perplexica": providers["perplexica_url"],
        "searxng": providers["searxng_url"],
    }
    
    url = url_map.get(provider)
    if not url:
        return None
    return url
