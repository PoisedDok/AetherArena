"""
HTTP Client Utilities - Production-ready HTTP helpers.

Provides async HTTP client with automatic retry logic, timeout management,
connection pooling, and error handling for reliable external API communication.

@.architecture
Incoming: core/integrations/*, api/v1/endpoints/*, External services --- {str url, Dict[str, Any] json body, Dict[str, str] headers, Dict[str, Any] params}
Processing: request(), _request_with_retry(), get(), post(), stream(), health_check(), close(), _get_or_create_client(), get_http_client() --- {8 jobs: cleanup, connection_pooling, error_handling, health_checking, http_client_management, initialization, request_retry, streaming}
Outgoing: External services (Perplexica, SearxNG, Docling, LM Studio, MCP), Callers --- {httpx.Response, streaming async generator}
"""

import asyncio
import logging
from typing import Any, Dict, Optional, Union
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

logger = logging.getLogger(__name__)


# =============================================================================
# Configuration
# =============================================================================

@dataclass
class HTTPClientConfig:
    """HTTP client configuration."""
    
    # Timeouts
    connect_timeout: float = 5.0       # Connection establishment
    read_timeout: float = 60.0         # Read operations
    write_timeout: float = 30.0        # Write operations
    pool_timeout: float = 5.0          # Connection pool
    
    # Retry configuration
    max_retries: int = 3
    retry_min_wait: float = 1.0        # Exponential backoff min
    retry_max_wait: float = 10.0       # Exponential backoff max
    
    # Connection pooling
    max_connections: int = 100
    max_keepalive_connections: int = 20
    keepalive_expiry: float = 5.0
    
    # Limits
    max_redirects: int = 5
    
    @classmethod
    def from_settings(cls) -> 'HTTPClientConfig':
        """Create config from application settings."""
        # Lazy import to avoid circular dependency
        try:
            from config.settings import get_settings
            settings = get_settings()
            # Use defaults for now, can be extended with settings
            return cls()
        except ImportError:
            # During initialization, just use defaults
            return cls()


# =============================================================================
# HTTP Client Manager
# =============================================================================

class HTTPClient:
    """
    Production HTTP client with automatic retry, timeout, and error handling.
    
    Features:
    - Automatic retry with exponential backoff
    - Configurable timeouts for different operations
    - Connection pooling for performance
    - Graceful cleanup and error handling
    - Context manager support
    """
    
    def __init__(self, config: Optional[HTTPClientConfig] = None):
        """
        Initialize HTTP client.
        
        Args:
            config: Client configuration (uses defaults if None)
        """
        self.config = config or HTTPClientConfig.from_settings()
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()
    
    async def _get_or_create_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client with proper configuration."""
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
        """Close HTTP client and cleanup resources."""
        async with self._client_lock:
            if self._client and not self._client.is_closed:
                await self._client.aclose()
                logger.debug("Closed HTTP client")
            self._client = None
    
    @asynccontextmanager
    async def client_context(self):
        """
        Context manager for HTTP client access.
        
        Usage:
            async with http_client.client_context() as client:
                response = await client.get(url)
        """
        client = await self._get_or_create_client()
        try:
            yield client
        except Exception:
            # Don't reset on error to allow retry mechanism to work
            raise
    
    # =========================================================================
    # Request Methods with Retry
    # =========================================================================
    
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
        retry: bool = True,
        **kwargs
    ) -> httpx.Response:
        """
        Make HTTP request with automatic retry.
        
        Args:
            method: HTTP method (GET, POST, etc.)
            url: Request URL
            headers: Request headers
            params: Query parameters
            json: JSON body
            data: Request body
            timeout: Override timeout for this request
            retry: Whether to retry on failure
            **kwargs: Additional httpx request arguments
            
        Returns:
            httpx.Response object
            
        Raises:
            httpx.HTTPError: If request fails after retries
        """
        async with self.client_context() as client:
            # Apply custom timeout if provided
            if timeout is not None:
                kwargs['timeout'] = timeout
            
            if retry:
                # Use retry decorator
                return await self._request_with_retry(
                    client, method, url,
                    headers=headers,
                    params=params,
                    json=json,
                    data=data,
                    **kwargs
                )
            else:
                # Single attempt
                response = await client.request(
                    method, url,
                    headers=headers,
                    params=params,
                    json=json,
                    data=data,
                    **kwargs
                )
                response.raise_for_status()
                return response
    
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
        """Internal request method with retry logic."""
        response = await client.request(method, url, **kwargs)
        response.raise_for_status()
        return response
    
    async def get(
        self,
        url: str,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        **kwargs
    ) -> httpx.Response:
        """
        Make GET request.
        
        Example:
            >>> client = HTTPClient()
            >>> response = await client.get("http://localhost:3000/api")
            >>> data = response.json()
        """
        return await self.request("GET", url, params=params, headers=headers, **kwargs)
    
    async def post(
        self,
        url: str,
        json: Optional[Dict[str, Any]] = None,
        data: Optional[Union[Dict[str, Any], bytes]] = None,
        headers: Optional[Dict[str, str]] = None,
        **kwargs
    ) -> httpx.Response:
        """
        Make POST request.
        
        Example:
            >>> client = HTTPClient()
            >>> response = await client.post("http://localhost:3000/api", json={"key": "value"})
        """
        return await self.request("POST", url, json=json, data=data, headers=headers, **kwargs)
    
    async def put(
        self,
        url: str,
        json: Optional[Dict[str, Any]] = None,
        data: Optional[Union[Dict[str, Any], bytes]] = None,
        headers: Optional[Dict[str, str]] = None,
        **kwargs
    ) -> httpx.Response:
        """Make PUT request."""
        return await self.request("PUT", url, json=json, data=data, headers=headers, **kwargs)
    
    async def delete(
        self,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        **kwargs
    ) -> httpx.Response:
        """Make DELETE request."""
        return await self.request("DELETE", url, headers=headers, **kwargs)
    
    async def patch(
        self,
        url: str,
        json: Optional[Dict[str, Any]] = None,
        data: Optional[Union[Dict[str, Any], bytes]] = None,
        headers: Optional[Dict[str, str]] = None,
        **kwargs
    ) -> httpx.Response:
        """Make PATCH request."""
        return await self.request("PATCH", url, json=json, data=data, headers=headers, **kwargs)
    
    # =========================================================================
    # Streaming Support
    # =========================================================================
    
    @asynccontextmanager
    async def stream(
        self,
        method: str,
        url: str,
        **kwargs
    ):
        """
        Stream HTTP response.
        
        Usage:
            async with client.stream("GET", url) as response:
                async for chunk in response.aiter_bytes():
                    process(chunk)
        """
        async with self.client_context() as client:
            async with client.stream(method, url, **kwargs) as response:
                response.raise_for_status()
                yield response
    
    # =========================================================================
    # Health Check
    # =========================================================================
    
    async def health_check(self, url: str, timeout: float = 5.0) -> bool:
        """
        Check if service is healthy.
        
        Args:
            url: Health check URL
            timeout: Request timeout
            
        Returns:
            True if service is healthy, False otherwise
        """
        try:
            response = await self.get(url, timeout=timeout, retry=False)
            return response.status_code == 200
        except Exception as e:
            logger.debug(f"Health check failed for {url}: {e}")
            return False


# =============================================================================
# Global Client Instance
# =============================================================================

_global_http_client: Optional[HTTPClient] = None


def get_http_client(config: Optional[HTTPClientConfig] = None) -> HTTPClient:
    """
    Get global HTTP client instance.
    
    Args:
        config: Optional custom configuration
        
    Returns:
        HTTPClient instance
    """
    global _global_http_client
    if _global_http_client is None:
        _global_http_client = HTTPClient(config=config)
    return _global_http_client


async def close_http_client() -> None:
    """Close global HTTP client."""
    global _global_http_client
    if _global_http_client is not None:
        await _global_http_client.close()
        _global_http_client = None


# =============================================================================
# Convenience Functions
# =============================================================================

async def get(url: str, **kwargs) -> httpx.Response:
    """Convenience function for GET request using global client."""
    client = get_http_client()
    return await client.get(url, **kwargs)


async def post(url: str, **kwargs) -> httpx.Response:
    """Convenience function for POST request using global client."""
    client = get_http_client()
    return await client.post(url, **kwargs)


async def put(url: str, **kwargs) -> httpx.Response:
    """Convenience function for PUT request using global client."""
    client = get_http_client()
    return await client.put(url, **kwargs)


async def delete(url: str, **kwargs) -> httpx.Response:
    """Convenience function for DELETE request using global client."""
    client = get_http_client()
    return await client.delete(url, **kwargs)

