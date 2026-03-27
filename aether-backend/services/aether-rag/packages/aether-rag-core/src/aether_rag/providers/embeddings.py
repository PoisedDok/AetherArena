"""
@.architecture Hexagonal Core Adapters

This module contains implementations of the IEmbeddingProvider interface
for remote/HTTP-based inference APIs, keeping heavy local ML dependencies
like PyTorch out of the main execution thread.
"""

import logging
import os
from typing import Any, List, Optional
import numpy as np

from ..interfaces import IEmbeddingProvider
from ..settings import resolve_openai_api_key, resolve_openai_base_url, resolve_ollama_host
from ..tokenization import get_model_token_limit, truncate_to_token_limit

logger = logging.getLogger(__name__)


def normalize_embeddings(embeddings: np.ndarray) -> np.ndarray:
    """L2 normalize embeddings for cosine similarity with Inner Product index."""
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    # Avoid division by zero
    norms[norms == 0] = 1e-10
    return embeddings / norms


class OpenAIEmbeddingProvider(IEmbeddingProvider):
    """
    Provider for OpenAI and OpenAI-compatible endpoints (Perplexica ONNX, LMStudio, Aether Inference).
    """

    def __init__(
        self,
        model_name: str,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        provider_options: Optional[dict[str, Any]] = None,
    ):
        self.model_name = model_name
        self.provider_options = provider_options or {}
        
        self.effective_base_url = base_url or self.provider_options.get("base_url")
        self.effective_api_key = api_key or self.provider_options.get("api_key")

        self.resolved_base_url = resolve_openai_base_url(self.effective_base_url)
        self.resolved_api_key = resolve_openai_api_key(self.effective_api_key)

        if not self.resolved_api_key:
            raise RuntimeError("OPENAI_API_KEY environment variable not set")

        try:
            import openai
            self.client = openai.OpenAI(api_key=self.resolved_api_key, base_url=self.resolved_base_url)
        except ImportError as e:
            raise ImportError(f"OpenAI package not installed: {e}")

        # Fetch token limit once on init
        self.token_limit = get_model_token_limit(self.model_name, base_url=self.effective_base_url)
        logger.info(f"OpenAIEmbeddingProvider initialized. Model: {self.model_name}, Token limit: {self.token_limit}")

    def embed_documents(self, texts: List[str], **kwargs) -> np.ndarray:
        if not texts:
            raise ValueError("Cannot compute embeddings for empty text list")

        invalid_count = sum(1 for t in texts if not isinstance(t, str) or not t.strip())
        if invalid_count > 0:
            raise ValueError(f"Found {invalid_count} empty/invalid text(s) in input.")

        # Apply prompt template if provided
        prompt_template = self.provider_options.get("prompt_template")
        if prompt_template:
            texts = [f"{prompt_template}{text}" for text in texts]

        # Truncate texts
        texts = truncate_to_token_limit(texts, self.token_limit, model_name=self.model_name)

        is_local = False
        if self.resolved_base_url:
            base_url_lower = self.resolved_base_url.lower()
            is_local = any(x in base_url_lower for x in ["localhost", "127.0.0.1", "host.docker.internal", "11434", "3000"])

        if is_local:
            # Local ONNX/node.js inference crashes if V8 heap limit is exceeded.
            # E.g. Perplexica Transformers.js on Nomic (2048-token limit) batch size 8 = OOM.
            # Force ultra-conservative small batch size for local mesh endpoints.
            if self.token_limit >= 2048:
                max_batch_size = 4
            elif self.token_limit >= 1024:
                max_batch_size = 8
            else:
                max_batch_size = 32
        else:
            avg_len = sum(len(text) for text in texts) / len(texts)
            max_batch_size = 500 if avg_len > 300 else 800

        all_embeddings = []
        for i in range(0, len(texts), max_batch_size):
            batch_texts = texts[i : i + max_batch_size]
            try:
                response = self.client.embeddings.create(model=self.model_name, input=batch_texts)
                batch_embeddings = [embedding.embedding for embedding in response.data]
                all_embeddings.extend(batch_embeddings[: len(batch_texts)])
            except Exception as e:
                logger.error(f"Batch {i} failed: {e}")
                raise

        embeddings = np.array(all_embeddings, dtype=np.float32)
        return normalize_embeddings(embeddings)

    def embed_query(self, text: str, **kwargs) -> np.ndarray:
        prompt_template = self.provider_options.get("prompt_template", "")
        # Query usually has the template prepended if configured for queries? 
        # Actually, in old compute_embeddings, query vs documents wasn't cleanly separated at the provider level.
        # We will assume prompt_template is applied by the caller or we can apply it here if it's generic.
        if prompt_template:
            text = f"{prompt_template}{text}"
            
        truncated = truncate_to_token_limit([text], self.token_limit, model_name=self.model_name)[0]
        response = self.client.embeddings.create(model=self.model_name, input=[truncated])
        embedding = np.array([response.data[0].embedding], dtype=np.float32)
        return normalize_embeddings(embedding)[0]


class OllamaEmbeddingProvider(IEmbeddingProvider):
    """
    Provider for direct Ollama HTTP API interactions.
    """

    def __init__(
        self,
        model_name: str,
        host: Optional[str] = None,
        provider_options: Optional[dict[str, Any]] = None,
    ):
        self.model_name = model_name
        self.provider_options = provider_options or {}
        self.resolved_host = resolve_ollama_host(host)

        try:
            import requests
            self.requests = requests
        except ImportError:
            raise ImportError("The 'requests' library is required for Ollama embeddings.")

        self._check_ollama()
        self.token_limit = get_model_token_limit(self.model_name, base_url=self.resolved_host)
        
    def _check_ollama(self):
        try:
            response = self.requests.get(f"{self.resolved_host}/api/version", timeout=5)
            response.raise_for_status()
        except Exception as e:
            raise RuntimeError(f"Could not connect to Ollama at {self.resolved_host}: {e}")

    def embed_documents(self, texts: List[str], **kwargs) -> np.ndarray:
        if not texts:
            raise ValueError("Cannot compute embeddings for empty text list")

        prompt_template = self.provider_options.get("prompt_template")
        if prompt_template:
            texts = [f"{prompt_template}{text}" for text in texts]

        texts = truncate_to_token_limit(texts, self.token_limit, model_name=self.model_name)

        batch_size = 32
        all_embeddings = []

        for start_idx in range(0, len(texts), batch_size):
            batch_texts = texts[start_idx : start_idx + batch_size]
            try:
                response = self.requests.post(
                    f"{self.resolved_host}/api/embed",
                    json={"model": self.model_name, "input": batch_texts},
                    timeout=60,
                )
                response.raise_for_status()
                batch_embeddings = response.json().get("embeddings")
                if not batch_embeddings:
                    raise ValueError("No embeddings returned from Ollama API")
                all_embeddings.extend(batch_embeddings)
            except Exception as e:
                logger.error(f"Failed to get embeddings from Ollama: {e}")
                raise

        embeddings = np.array(all_embeddings, dtype=np.float32)
        return normalize_embeddings(embeddings)

    def embed_query(self, text: str, **kwargs) -> np.ndarray:
        prompt_template = self.provider_options.get("prompt_template", "")
        if prompt_template:
            text = f"{prompt_template}{text}"
            
        truncated = truncate_to_token_limit([text], self.token_limit, model_name=self.model_name)[0]
        try:
            response = self.requests.post(
                f"{self.resolved_host}/api/embed",
                json={"model": self.model_name, "input": [truncated]},
                timeout=60,
            )
            response.raise_for_status()
            emb = response.json().get("embeddings")[0]
            embedding = np.array([emb], dtype=np.float32)
            return normalize_embeddings(embedding)[0]
        except Exception as e:
            raise RuntimeError(f"Ollama query embedding failed: {e}")
