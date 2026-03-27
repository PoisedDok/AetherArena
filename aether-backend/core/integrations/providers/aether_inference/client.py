"""
Aether Inference HTTP Client

Thin httpx wrapper for OpenAI-compatible inference API.
All engines (vllm-mlx, vLLM, Ollama) expose the same /v1/* endpoints.

@.architecture
Incoming: glm_ocr.py, docling/service.py, api endpoints --- {chat_completion, list_models, health_check}
Processing: HTTP calls to aether-inference server --- {3 jobs: JOB_API_CALL, JOB_HEALTH_CHECK, JOB_LIST_MODELS}
Outgoing: aether-inference server at http://127.0.0.1:{port}/v1 --- {OpenAI-compatible JSON}
"""

import logging
import time
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

# Module-level singleton
_client: Optional["InferenceClient"] = None


class InferenceClient:
    """
    OpenAI-compatible HTTP client for the Aether Inference server.
    
    Port and timeouts sourced from central config.
    """
    
    def __init__(self, base_url: Optional[str] = None, timeout: float = 120.0):
        """
        Args:
            base_url: Full base URL including /v1 path (e.g. http://127.0.0.1:7090/v1).
                      If None, resolved from settings at call time.
            timeout: Request timeout in seconds (inference can be slow for first token).
        """
        self._base_url = base_url
        self._timeout = timeout
    
    def _get_base_url(self) -> str:
        """Resolve base URL from settings if not explicitly set."""
        if self._base_url:
            return self._base_url
        
        # Lazy import to avoid circular dependency at module level
        from config.settings import get_settings
        return get_settings().inference_url
    
    def _get_timeout(self) -> httpx.Timeout:
        """Build timeout config."""
        return httpx.Timeout(
            connect=5.0,
            read=self._timeout,
            write=10.0,
            pool=5.0,
        )
    
    def _resolve_default_model(self) -> str:
        """
        Resolve the default OCR model from settings or platform detection.
        
        vllm-mlx requires the 'model' field in all requests.
        If not explicitly provided, resolve from:
        1. Central config: vision_document.provider_config.model (GLM-OCR)
        2. Central config: inference.default_vision_model (LFM VL fallback)
        3. Platform detection (glm_ocr_model for current hardware)
        
        Role mapping:
          GLM-OCR → OCR (vision_document.provider_config.model)
          LFM VL  → Vision (inference.default_vision_model)
        """
        try:
            from config.settings import get_settings
            settings = get_settings()
            # OCR-specific model first (GLM-OCR), then vision fallback (LFM VL)
            model = (
                settings.vision_document.provider_config.model
                or settings.inference.default_vision_model
                or settings.inference.default_model
            )
            if model:
                return model
        except Exception as e:
            logger.warning("Failed to resolve default model from settings: %s", e)
        
        try:
            from services.aether_inference.platform_detector import detect_platform
            return detect_platform().glm_ocr_model
        except Exception as e:
            logger.warning("Failed to resolve default model from platform detector: %s", e)
        
        return "glm-ocr"  # Safe fallback (Ollama name)
    
    async def chat_completion(
        self,
        messages: List[Dict[str, Any]],
        model: Optional[str] = None,
        max_tokens: int = 8192,
        temperature: float = 0.0,
        stream: bool = False,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Send a chat completion request to the inference server.
        
        Uses the same OpenAI chat/completions schema used everywhere in the codebase.
        
        Args:
            messages: OpenAI-format messages (role + content)
            model: Model ID (None = use server default)
            max_tokens: Max tokens to generate
            temperature: Sampling temperature
            stream: Whether to stream (not yet supported in this client)
            **kwargs: Additional params (top_p, stop, etc.)
            
        Returns:
            OpenAI-format chat completion response
        """
        base_url = self._get_base_url()
        
        # Model is required by vllm-mlx; resolve from platform detection if not provided
        resolved_model = model
        if not resolved_model:
            resolved_model = self._resolve_default_model()
        
        payload: Dict[str, Any] = {
            "model": resolved_model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": stream,
        }
        
        # Pass through any extra params (top_p, stop, etc.)
        for k, v in kwargs.items():
            if v is not None:
                payload[k] = v
        
        try:
            async with httpx.AsyncClient(timeout=self._get_timeout()) as client:
                resp = await client.post(
                    f"{base_url}/chat/completions",
                    json=payload,
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.error("Chat completion request failed", exc_info=True, extra={
                "base_url": base_url,
                "model": resolved_model,
                "error": str(e)
            })
            raise
    
    async def list_models(self) -> List[Dict[str, Any]]:
        """
        List models available on the inference server.
        
        Returns:
            List of model info dicts from /v1/models response
        """
        base_url = self._get_base_url()
        
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                resp = await client.get(f"{base_url}/models")
                resp.raise_for_status()
                data = resp.json()
                return data.get("data", [])
        except Exception as e:
            logger.error("Failed to list models", exc_info=True, extra={
                "base_url": base_url,
                "error": str(e)
            })
            raise
    
    async def health_check(self) -> Dict[str, Any]:
        """
        Check inference server health.
        
        Returns:
            Dict with 'healthy' bool, response_time_ms, and any error message
        """
        base_url = self._get_base_url()
        start = time.time()
        
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=2.0, read=5.0, write=5.0, pool=5.0)) as client:
                # Try /health first (vLLM native)
                try:
                    resp = await client.get(base_url.removesuffix("/v1") + "/health")
                    if resp.status_code < 500:
                        elapsed_ms = (time.time() - start) * 1000
                        return {"healthy": True, "response_time_ms": round(elapsed_ms, 2)}
                except httpx.RequestError:
                    pass
                
                # Fallback: /v1/models (OpenAI-compatible, works for all engines)
                resp = await client.get(f"{base_url}/models")
                elapsed_ms = (time.time() - start) * 1000
                healthy = resp.status_code < 500
                return {
                    "healthy": healthy,
                    "response_time_ms": round(elapsed_ms, 2),
                    "status_code": resp.status_code,
                }
                
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            return {"healthy": False, "error": f"Connection failed: {type(e).__name__}"}
        except Exception as e:
            return {"healthy": False, "error": str(e)}


def get_inference_client(base_url: Optional[str] = None) -> InferenceClient:
    """
    Get or create the inference client singleton.
    
    Args:
        base_url: Override base URL (otherwise resolved from settings)
        
    Returns:
        InferenceClient instance
    """
    global _client
    if _client is None or (base_url and _client._base_url != base_url):
        _client = InferenceClient(base_url=base_url)
    return _client


async def inference_health() -> Dict[str, Any]:
    """
    Quick health check for the inference server.
    
    Used by services.py status endpoint and provider discovery.
    
    Returns:
        Dict with 'healthy' bool and details
    """
    client = get_inference_client()
    return await client.health_check()
