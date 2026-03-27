"""
Internal Service Gateway - Infrastructure Layer

@.architecture
Incoming: api/v1/endpoints/services.py, toolrunner.py, agents.py, proactive.py, backends.py
Processing: Execute HTTP health checks and internal service-to-service orchestration
Outgoing: data/network/http_client.py
"""

import logging
from typing import Any, AsyncGenerator, Dict, Optional

from data.network.http_client import AetherHTTPClient
from core.exceptions import UpstreamServiceError
from core.domain.gateway_interfaces import IInternalServiceGateway

logger = logging.getLogger(__name__)


class InternalServiceGateway(IInternalServiceGateway):
    """
    Gateway for executing internal backend orchestration and service health checks.
    """
    
    def __init__(self, http_client: AetherHTTPClient):
        self._http_client = http_client
        
    async def check_health(self, url: str, timeout: float = 5.0) -> bool:
        """
        Verify if an external or internal service is healthy.
        Returns True if 200 OK, otherwise False.
        """
        try:
            response = await self._http_client.get(
                url,
                timeout=timeout,
                retry_request=False
            )
            return response.status_code == 200
        except Exception as e:
            logger.debug(f"Health check failed for {url}: {e}")
            return False
            
    async def invoke_agent(
        self,
        url: str,
        payload: Dict[str, Any],
        timeout: float,
        stream: bool = False
    ) -> Any:
        """
        Invoke an internal Aether Agent over HTTP (e.g. from toolrunner).
        """
        if stream:
            return self._stream_agent(url, payload, timeout)
            
        response = await self._http_client.post(
            url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=timeout,
            retry_request=False
        )
        try:
            return response.json()
        except Exception as e:
            raise UpstreamServiceError(f"Internal service returned invalid JSON: {e}", status_code=502)
        
    async def _stream_agent(
        self,
        url: str,
        payload: Dict[str, Any],
        timeout: float
    ) -> AsyncGenerator[str, None]:
        async with self._http_client.stream(
            "POST",
            url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=timeout
        ) as response:
            async for chunk in response.aiter_lines():
                if chunk:
                    yield chunk

    async def generate_summary(
        self,
        url: str,
        payload: Dict[str, Any],
        timeout: float
    ) -> Dict[str, Any]:
        """Call internal summarize endpoint."""
        response = await self._http_client.post(
            url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=timeout,
            retry_request=False
        )
        try:
            return response.json()
        except Exception as e:
            raise UpstreamServiceError(f"Internal service returned invalid JSON: {e}", status_code=502)
        
    async def upload_document(
        self,
        url: str,
        files: Dict[str, Any],
        timeout: float
    ) -> Dict[str, Any]:
        """Upload a document to an internal processing endpoint."""
        response = await self._http_client.post(
            url,
            # Pass data directly to bypass strict JSON serialization
            data=files,
            timeout=timeout,
            retry_request=False
        )
        try:
            return response.json()
        except Exception as e:
            raise UpstreamServiceError(f"Internal service returned invalid JSON: {e}", status_code=502)
        
    async def execute_request(
        self,
        method: str,
        url: str,
        timeout: float,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None
    ) -> Any:
        """Execute arbitrary internal tool request."""
        response = await self._http_client.request(
            method=method,
            url=url,
            params=params,
            json=json_data,
            headers=headers,
            timeout=timeout,
            retry_request=False
        )
        return response


from fastapi import Depends
from data.network.http_client import AetherHTTPClient, get_http_client

def get_service_gateway(http_client: AetherHTTPClient = Depends(get_http_client)) -> IInternalServiceGateway:
    """Dependency provider for FastAPI."""
    return InternalServiceGateway(http_client)

