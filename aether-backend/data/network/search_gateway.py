"""
Search Gateway - Infrastructure Layer

@.architecture
Incoming: api/v1/endpoints/search.py, research.py
Processing: Execute search requests against SearXNG and Perplexica backends using shared connection pool
Outgoing: data/network/http_client.py
"""

import logging
from typing import Any, AsyncGenerator, Dict

from data.network.http_client import AetherHTTPClient
from core.exceptions import UpstreamServiceError
from core.domain.gateway_interfaces import ISearchGateway

logger = logging.getLogger(__name__)


class SearchGateway(ISearchGateway):
    """
    Gateway for executing external search requests via SearXNG and Perplexica.
    """
    
    def __init__(self, http_client: AetherHTTPClient):
        self._http_client = http_client
        
    async def search_searxng(
        self,
        url: str,
        params: Dict[str, Any],
        headers: Dict[str, str],
        timeout: float
    ) -> Dict[str, Any]:
        """Execute a SearXNG search."""
        response = await self._http_client.get(
            f"{url}/search",
            params=params,
            headers=headers,
            timeout=timeout,
            retry_request=False
        )
        try:
            return response.json()
        except Exception as e:
            raise UpstreamServiceError(f"Upstream service returned invalid JSON: {e}", status_code=502)
        
    async def search_perplexica(
        self,
        url: str,
        payload: Dict[str, Any],
        timeout: float,
        stream: bool = False
    ) -> Any:
        """Execute a Perplexica AI search."""
        if stream:
            return self._stream_perplexica(url, payload, timeout)
            
        response = await self._http_client.post(
            f"{url}/api/search",
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=timeout,
            retry_request=False
        )
        try:
            return response.json()
        except Exception as e:
            raise UpstreamServiceError(f"Upstream service returned invalid JSON: {e}", status_code=502)
        
    async def _stream_perplexica(
        self,
        url: str,
        payload: Dict[str, Any],
        timeout: float
    ) -> AsyncGenerator[str, None]:
        """Stream a Perplexica AI search response."""
        async with self._http_client.stream(
            "POST",
            f"{url}/api/search",
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=timeout
        ) as response:
            async for chunk in response.aiter_lines():
                if chunk:
                    yield chunk
                    
    async def get_perplexica_models(self, url: str, timeout: float) -> Dict[str, Any]:
        """Fetch Perplexica models."""
        response = await self._http_client.get(
            f"{url}/api/models",
            timeout=timeout,
            retry_request=False
        )
        try:
            return response.json()
        except Exception as e:
            raise UpstreamServiceError(f"Upstream service returned invalid JSON: {e}", status_code=502)


from data.network.http_client import AetherHTTPClient, get_http_client
from fastapi import Depends

def get_search_gateway(http_client: AetherHTTPClient = Depends(get_http_client)) -> ISearchGateway:
    """Dependency provider for FastAPI."""
    return SearchGateway(http_client)

