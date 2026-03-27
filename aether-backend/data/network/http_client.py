"""
Central HTTP Gateway - Infrastructure Layer

@.architecture
Incoming: Domain Gateways (llm_gateway, search_gateway, service_gateway)
Processing: Manage shared async client, execute retried HTTP requests, convert to Domain Exceptions
Outgoing: External Services
"""

import asyncio
import logging
from typing import Any, Dict, Optional, Union, AsyncGenerator
from importlib import import_module
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    before_sleep_log,
)

from core.exceptions import (
    NetworkTimeoutError,
    NetworkConnectionError,
    UpstreamServiceError,
)

logger = logging.getLogger(__name__)


@dataclass
class HTTPClientConfig:
    """HTTP client configuration."""
    
    # Timeouts
    connect_timeout: float = 5.0
    read_timeout: float = 60.0
    write_timeout: float = 30.0
    pool_timeout: float = 5.0
    
    # Retry config
    max_retries: int = 3
    retry_min_wait: float = 1.0
    retry_max_wait: float = 10.0
    
    # Connection pooling
    max_connections: int = 100
    max_keepalive_connections: int = 20
    keepalive_expiry: float = 5.0
    
    max_redirects: int = 5
    
    @classmethod
    def from_settings(cls) -> 'HTTPClientConfig':
        try:
            settings_module = import_module("config.settings")
            get_settings = getattr(settings_module, "get_settings", None)
            if callable(get_settings):
                s = get_settings()
                if hasattr(s, "http_client"):
                    return cls(
                        read_timeout=getattr(s.http_client, "default_timeout", 60.0),
                        max_retries=getattr(s.http_client, "max_retries", 3)
                    )
        except Exception:
            pass
        return cls()


class AetherHTTPClient:
    """
    Production HTTP client Gateway mapping to Domain Exceptions.
    """
    
    def __init__(self, config: Optional[HTTPClientConfig] = None):
        self.config = config or HTTPClientConfig.from_settings()
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()
    
    async def _get_or_create_client(self) -> httpx.AsyncClient:
        async with self._client_lock:
            if self._client is None or self._client.is_closed:
                timeout = httpx.Timeout(
                    connect=self.config.connect_timeout,
                    read=self.config.read_timeout,
                    write=self.config.write_timeout,
                    pool=self.config.pool_timeout,
                )
                
                limits = httpx.Limits(
                    max_connections=self.config.max_connections,
                    max_keepalive_connections=self.config.max_keepalive_connections,
                    keepalive_expiry=self.config.keepalive_expiry,
                )
                
                self._client = httpx.AsyncClient(
                    timeout=timeout,
                    limits=limits,
                    max_redirects=self.config.max_redirects,
                    follow_redirects=True,
                )
                logger.debug("Created new HTTP client")
            
            return self._client
    
    async def close(self) -> None:
        async with self._client_lock:
            if self._client and not self._client.is_closed:
                await self._client.aclose()
                logger.debug("Closed HTTP client")
            self._client = None
    
    @asynccontextmanager
    async def client_context(self):
        client = await self._get_or_create_client()
        try:
            yield client
        except Exception:
            raise
    
    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        data: Optional[Union[Dict[str, Any], bytes]] = None,
        timeout: Optional[float] = None,
        retry_request: bool = True,
        suppress_logging: bool = False,
        **kwargs
    ) -> httpx.Response:
        """
        Make an HTTP request mapped to DomainExceptions.
        """
        async with self.client_context() as client:
            if timeout is not None:
                kwargs['timeout'] = timeout
                
            try:
                if retry_request:
                    response = await self._request_with_retry(
                        client, method, url,
                        headers=headers, params=params, json=json, data=data, **kwargs
                    )
                else:
                    response = await client.request(
                        method, url,
                        headers=headers, params=params, json=json, data=data, **kwargs
                    )
                    response.raise_for_status()
                return response
            except httpx.TimeoutException as e:
                if not suppress_logging:
                    logger.error(f"HTTP Request Timeout to {url}: {e}")
                raise NetworkTimeoutError(f"Request timed out to {url}") from e
            except httpx.HTTPStatusError as e:
                if not suppress_logging:
                    logger.error(f"HTTP Status Error {e.response.status_code} from {url}")
                raise UpstreamServiceError(
                    f"Upstream service returned error: {e.response.text}",
                    status_code=e.response.status_code
                ) from e
            except httpx.RequestError as e:
                if not suppress_logging:
                    logger.error(f"HTTP Request Error to {url}: {e}")
                else:
                    logger.debug(f"HTTP Request Error (suppressed) to {url}: {e}")
                raise NetworkConnectionError(f"Failed to connect to {url}") from e
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(min=1.0, max=10.0),
        retry=retry_if_exception_type((
            httpx.TimeoutException,
            httpx.NetworkError,
            httpx.RemoteProtocolError,
        )),
        before_sleep=before_sleep_log(logger, logging.WARNING),
    )
    async def _request_with_retry(
        self,
        client: httpx.AsyncClient,
        method: str,
        url: str,
        **kwargs
    ) -> httpx.Response:
        response = await client.request(method, url, **kwargs)
        response.raise_for_status()
        return response
    
    async def get(self, url: str, **kwargs) -> httpx.Response:
        return await self.request("GET", url, **kwargs)
    
    async def post(self, url: str, **kwargs) -> httpx.Response:
        return await self.request("POST", url, **kwargs)
    
    async def put(self, url: str, **kwargs) -> httpx.Response:
        return await self.request("PUT", url, **kwargs)
    
    async def delete(self, url: str, **kwargs) -> httpx.Response:
        return await self.request("DELETE", url, **kwargs)
    
    async def patch(self, url: str, **kwargs) -> httpx.Response:
        return await self.request("PATCH", url, **kwargs)
        
    @asynccontextmanager
    async def stream(self, method: str, url: str, **kwargs) -> AsyncGenerator[httpx.Response, None]:
        async with self.client_context() as client:
            try:
                async with client.stream(method, url, **kwargs) as response:
                    response.raise_for_status()
                    yield response
            except httpx.TimeoutException as e:
                raise NetworkTimeoutError(f"Stream request timed out to {url}") from e
            except httpx.HTTPStatusError as e:
                raise UpstreamServiceError("Upstream service returned error", status_code=e.response.status_code) from e
            except httpx.RequestError as e:
                raise NetworkConnectionError(f"Failed to stream from {url}") from e

_http_client: Optional[AetherHTTPClient] = None

def get_http_client() -> AetherHTTPClient:
    """Dependency provider for FastAPI."""
    global _http_client
    if _http_client is None:
        _http_client = AetherHTTPClient()
    return _http_client

async def close_http_client() -> None:
    """Close the global HTTP client."""
    global _http_client
    if _http_client is not None:
        await _http_client.close()
        _http_client = None


