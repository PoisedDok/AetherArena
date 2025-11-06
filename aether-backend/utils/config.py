"""
Simple config loader for backend components.
Reads directly from the centralized TOML config.

@.architecture
Incoming: config/models.toml, config/settings.py --- {TOML file, load_config calls}
Processing: load_config(), get_fallback_config(), get_llm_settings(), get_provider_url() --- {3 jobs: config_loading, fallback_generation, setting_extraction}
Outgoing: config/settings.py, core/runtime/engine.py, Other modules --- {Dict[str, Any] config data, str provider URLs, Dict[str, Any] LLM settings}
"""

import toml
from pathlib import Path
from typing import Dict, Any, Optional

def load_config() -> Dict[str, Any]:
    """Load configuration from the centralized TOML file."""
    try:
        # NEW BACKEND: Load from config/models.toml
        config_file = Path(__file__).parent.parent / "config" / "models.toml"
        with open(config_file, 'r') as f:
            return toml.load(f)
    except Exception as e:
        print(f"⚠️  Failed to load centralized config: {e}")
        return get_fallback_config()

def get_fallback_config() -> Dict[str, Any]:
    """Fallback configuration if TOML file can't be loaded."""
    return {
        "MODELS": {
            "primary_chat_model": "qwen/qwen3-4b-2507",
            "fallback_chat_model": "qwen/qwen3-14b",
            "primary_embedding_model": "text-embedding-nomic-embed-text-v1.5",
            "fallback_embedding_model": "xenova-bge-small-en-v1.5"
        },
        "PROVIDERS": {
            "lm_studio_url": "http://localhost:1234/v1",
            "lm_studio_api_key": "not-needed",
            "perplexica_url": "http://localhost:3000",
            "searxng_url": "http://127.0.0.1:4000",
            "docling_url": "http://127.0.0.1:8000",
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
    
    return {
        "provider": "openai-compatible",
        "api_base": provider_config["lm_studio_url"],
        "model": config["MODELS"]["primary_chat_model"],
        "supports_vision": oi_config["supports_vision"],
        "context_window": oi_config["context_window"],
        "max_tokens": oi_config["max_tokens"]
    }

def get_provider_url(provider: str) -> str:
    """Get URL for a specific provider."""
    config = load_config()
    providers = config["PROVIDERS"]
    
    url_map = {
        "lm_studio": providers["lm_studio_url"],
        "perplexica": providers["perplexica_url"],
        "searxng": providers["searxng_url"],
        "docling": providers.get("docling_url", "http://127.0.0.1:8000"),
    }
    
    return url_map.get(provider, "")
