import logging
import os
from typing import Any, Optional

import tiktoken

logger = logging.getLogger(__name__)

# Token limit registry for embedding models
# Used as fallback when dynamic discovery fails
EMBEDDING_MODEL_LIMITS = {
    # Nomic models
    "nomic-embed-text": 2048,
    "nomic-embed-text-v1.5": 2048,
    "nomic-embed-text-v2": 512,
    # Other embedding models
    "mxbai-embed-large": 512,
    "all-minilm": 512,
    "bge-small": 512,
    "bge-base": 512,
    "bge-large": 512,
    "bge-m3": 8192,
    "snowflake-arctic-embed": 512,
    # OpenAI models
    "text-embedding-3-small": 8192,
    "text-embedding-3-large": 8192,
    "text-embedding-ada-002": 8192,
}

_token_limit_cache: dict[tuple[str, str], int] = {}


def _query_ollama_context_limit(model_name: str, base_url: str) -> Optional[int]:
    """Query Ollama /api/show for model context limit."""
    try:
        import requests

        response = requests.post(
            f"{base_url}/api/show",
            json={"name": model_name},
            timeout=5,
        )
        if response.status_code == 200:
            data = response.json()
            if "model_info" in data:
                for key, value in data["model_info"].items():
                    if "context_length" in key and isinstance(value, int):
                        logger.info(f"Detected {model_name} context limit: {value} tokens")
                        return value
    except Exception as e:
        logger.debug(f"Failed to query Ollama context limit: {e}")
    return None


def _query_lmstudio_context_limit(model_name: str, base_url: str) -> Optional[int]:
    """Query LM Studio API for model context length."""
    try:
        import requests

        http_url = base_url.replace("ws://", "http://").replace("wss://", "https://")
        if not http_url.endswith("/v1") and not http_url.endswith("/v1/"):
            http_url = f"{http_url.rstrip('/')}/v1"

        response = requests.get(f"{http_url}/models", timeout=5)
        response.raise_for_status()
        
        data = response.json()
        models = data.get("data", [])
        
        for model in models:
            if model.get("id") == model_name:
                context_length = model.get("max_context_length") or model.get("context_window")
                if context_length and isinstance(context_length, int) and context_length > 0:
                    logger.info(f"LM Studio API detected {model_name} context length: {context_length}")
                    return context_length
                    
    except requests.exceptions.RequestException as e:
        logger.debug(f"LM Studio API request failed: {e}")
    except ValueError as e:
        logger.debug(f"LM Studio API returned invalid JSON: {e}")
    except Exception as e:
        logger.exception(f"Unexpected error querying LM Studio API: {e}")

    return None


def get_model_token_limit(
    model_name: str,
    base_url: Optional[str] = None,
    default: int = 2048,
) -> int:
    """Get token limit for a given embedding model."""
    cache_key = (model_name, base_url or "")
    if cache_key in _token_limit_cache:
        return _token_limit_cache[cache_key]

    if base_url:
        if "11434" in base_url or "ollama" in base_url.lower():
            limit = _query_ollama_context_limit(model_name, base_url)
            if limit:
                _token_limit_cache[cache_key] = limit
                return limit

        if "1234" in base_url or "lmstudio" in base_url.lower() or "lm.studio" in base_url.lower():
            ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://")
            if ws_url.endswith("/v1"):
                ws_url = ws_url[:-3]

            limit = _query_lmstudio_context_limit(model_name, ws_url)
            if limit:
                _token_limit_cache[cache_key] = limit
                return limit

    base_model_name = model_name.split(":")[0]

    if model_name in EMBEDDING_MODEL_LIMITS:
        limit = EMBEDDING_MODEL_LIMITS[model_name]
        _token_limit_cache[cache_key] = limit
        return limit

    if base_model_name in EMBEDDING_MODEL_LIMITS:
        limit = EMBEDDING_MODEL_LIMITS[base_model_name]
        _token_limit_cache[cache_key] = limit
        return limit

    for known_model, registry_limit in EMBEDDING_MODEL_LIMITS.items():
        if known_model in base_model_name or base_model_name in known_model:
            _token_limit_cache[cache_key] = registry_limit
            return registry_limit

    logger.warning(f"Unknown model '{model_name}', using default {default} token limit")
    _token_limit_cache[cache_key] = default
    return default


def truncate_to_token_limit(texts: list[str], token_limit: int, model_name: str = "text-embedding-ada-002") -> list[str]:
    """
    Truncate texts to fit within token limit using purely tiktoken for speed and zero ML dependencies.
    """
    if not texts:
        return []

    # Use tiktoken purely for all models as a fast approximation
    try:
        try:
            tokenizer = tiktoken.encoding_for_model(model_name)
        except KeyError:
            tokenizer = tiktoken.get_encoding("cl100k_base")

        truncated_texts = []
        truncation_count = 0
        total_tokens_removed = 0

        for text in texts:
            tokens = tokenizer.encode(text, disallowed_special=())
            if len(tokens) > token_limit:
                truncated_tokens = tokens[:token_limit]
                truncated_text = tokenizer.decode(truncated_tokens)
                truncated_texts.append(truncated_text)
                
                truncation_count += 1
                total_tokens_removed += (len(tokens) - len(truncated_tokens))
            else:
                truncated_texts.append(text)
                
        if truncation_count > 0:
            logger.warning(
                f"Truncation summary: {truncation_count}/{len(texts)} texts truncated "
                f"(removed {total_tokens_removed} tokens total)"
            )
        return truncated_texts
        
    except Exception as e:
        logger.exception(f"Truncation failed with tiktoken: {e}")
        # Fallback string slicing
        return [text[:token_limit * 4] if len(text) > token_limit * 4 else text for text in texts]
