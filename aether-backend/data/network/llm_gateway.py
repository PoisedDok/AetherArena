"""
LLM Provider Gateway - Infrastructure Layer

@.architecture
Incoming: api/v1/endpoints/llm.py, llm_providers.py, models.py
Processing: Make HTTP calls to OpenAI-compatible LLM backends using shared connection pool
Outgoing: data/network/http_client.py
"""

import logging
from typing import Any, AsyncGenerator, Dict, Optional

from data.network.http_client import AetherHTTPClient
from core.exceptions import UpstreamServiceError
from core.domain.gateway_interfaces import ILlmProviderGateway

logger = logging.getLogger(__name__)


class LlmProviderGateway(ILlmProviderGateway):
    """
    Gateway for executing LLM operations, abstracting HTTP requests
    to provider backends.
    """
    
    def __init__(self, http_client: AetherHTTPClient):
        self._http_client = http_client
        
    async def generate_completion(
        self,
        url: str,
        payload: Dict[str, Any],
        headers: Dict[str, str],
        timeout: float
    ) -> Dict[str, Any]:
        """
        Execute a standard chat completion request.
        """
        response = await self._http_client.post(
            url,
            json=payload,
            headers=headers,
            timeout=timeout,
            retry_request=False
        )
        
        response_text = response.text
        if not response_text or response_text.strip() == "":
            raise UpstreamServiceError("LLM provider returned empty response", status_code=502)
            
        try:
            return response.json()
        except Exception as e:
            logger.error(f"Failed to parse JSON: {e}")
            raise UpstreamServiceError(f"LLM provider returned invalid JSON: {e}", status_code=502)
            
    async def generate_completion_stream(
        self,
        url: str,
        payload: Dict[str, Any],
        headers: Dict[str, str],
        timeout: float
    ) -> AsyncGenerator[str, None]:
        """
        Execute a streaming chat completion request.
        """
        try:
            async with self._http_client.stream(
                "POST", url, json=payload, headers=headers, timeout=timeout
            ) as response:
                async for chunk in response.aiter_lines():
                    yield chunk
        except UpstreamServiceError as e:
            # For streaming, we yield the error as an SSE event
            import json
            error_data = json.dumps({"error": str(e), "status_code": e.status_code})
            yield f"data: {error_data}\n\n"
                
    async def generate_embeddings(
        self,
        url: str,
        payload: Dict[str, Any],
        timeout: float,
        headers: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """
        Execute an embeddings request.
        """
        req_headers = headers or {"Content-Type": "application/json"}
        response = await self._http_client.post(
            url,
            json=payload,
            headers=req_headers,
            timeout=timeout,
            retry_request=False
        )
        return response.json()
        
    async def verify_provider(self, url: str, headers: Dict[str, str], timeout: float) -> None:
        """
        Verify provider by calling models endpoint.
        """
        await self._http_client.get(
            url,
            headers=headers,
            timeout=timeout,
            retry_request=False,
            suppress_logging=True
        )
        
    async def fetch_models(self, url: str, headers: Dict[str, str], timeout: float) -> Dict[str, Any]:
        """
        Fetch models catalog from a provider.
        """
        response = await self._http_client.get(
            url,
            headers=headers,
            timeout=timeout,
            retry_request=False,
            suppress_logging=True
        )
        return response.json()

    def check_litellm_vision_support(self, model: str) -> bool:
        """
        Check if a model supports vision using litellm.
        """
        import os
        # Redirect litellm's local model cost map write to a writable location
        # to avoid [Errno 30] on read-only DMG mounts (PyInstaller production).
        os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
        try:
            import litellm
            try:
                return bool(litellm.supports_vision(model))
            except Exception:
                return False
        except ImportError:
            pass
        except Exception as e:
            logger.warning("litellm detection failed: %s", e)
        return False

from fastapi import Depends
from data.network.http_client import AetherHTTPClient, get_http_client

def get_llm_gateway(http_client: AetherHTTPClient = Depends(get_http_client)) -> ILlmProviderGateway:
    """Dependency provider for FastAPI."""
    return LlmProviderGateway(http_client)

