"""
Rate Limiter Middleware - API Layer

FastAPI middleware for rate limiting API requests per client.

@.architecture
Incoming: app.py (middleware registration), security/rate_limit.py --- {FastAPI Request objects, rate limit configuration}
Processing: dispatch(), _get_client_id(), _get_tier_for_path(), _add_rate_limit_headers() --- {4 jobs: request_identification, tier_classification, limit_checking, header_injection}
Outgoing: Frontend (HTTP), security/rate_limit.py --- {HTTP Response with X-RateLimit-* headers, HTTP 429 on limit exceeded, rate limit check requests}
"""

import logging
from typing import Callable, Optional
from fastapi import Request, Response, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)


class RateLimiterMiddleware(BaseHTTPMiddleware):
    """
    Middleware to apply rate limiting to API endpoints.
    
    Features:
    - Per-IP rate limiting
    - Configurable limits per endpoint
    - Rate limit headers in responses
    - Graceful handling of exceeded limits
    """
    
    def __init__(
        self,
        app: ASGIApp,
        enabled: bool = True
    ):
        """
        Initialize rate limiter middleware.
        
        Args:
            app: ASGI application
            enabled: Whether rate limiting is enabled
        """
        super().__init__(app)
        self.enabled = enabled
        
        if enabled:
            # Import here to avoid circular dependencies
            from security.rate_limit import get_rate_limiter
            self._limiter = get_rate_limiter()
            logger.info("Rate limiter middleware initialized")
        else:
            self._limiter = None
            logger.info("Rate limiter middleware disabled")
    
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """
        Process request with rate limiting.
        
        Args:
            request: Incoming request
            call_next: Next middleware/handler
            
        Returns:
            Response (with rate limit headers)
            
        Raises:
            HTTPException: 429 if rate limit exceeded
        """
        if not self.enabled or self._limiter is None:
            # Rate limiting disabled, pass through
            return await call_next(request)
        
        # Get client identifier (IP address)
        client_id = self._get_client_id(request)
        
        # Determine tier based on endpoint
        tier = self._get_tier_for_path(request.url.path)
        
        # Import rate limit exception
        from security.rate_limit import RateLimitExceeded
        
        try:
            # Check rate limit
            await self._limiter.check_rate_limit(client_id, tier)
            
            # Get limit info for headers
            limit_info = await self._limiter.get_limit_info(client_id, tier)
            
            # Process request
            response = await call_next(request)
            
            # Add rate limit headers
            self._add_rate_limit_headers(response, limit_info)
            
            return response
            
        except RateLimitExceeded as e:
            # Rate limit exceeded - return 429
            logger.warning(
                f"Rate limit exceeded for {client_id} on {request.url.path} "
                f"(tier: {tier})"
            )
            
            # Get limit info for headers
            limit_info = await self._limiter.get_limit_info(client_id, tier)
            
            # Create 429 response
            response = Response(
                content=str(e),
                status_code=429,
                media_type="text/plain"
            )
            
            # Add rate limit headers
            self._add_rate_limit_headers(response, limit_info)
            response.headers["Retry-After"] = str(int(e.retry_after))
            
            return response
        
        except Exception as e:
            # Unexpected error in rate limiting - log and continue
            logger.error(f"Error in rate limiter: {e}", exc_info=True)
            return await call_next(request)
    
    def _get_client_id(self, request: Request) -> str:
        """
        Extract client identifier from request.
        
        Args:
            request: HTTP request
            
        Returns:
            Client identifier (IP address)
        """
        # Try X-Forwarded-For header first (for proxies)
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            # Take first IP in chain
            return forwarded_for.split(",")[0].strip()
        
        # Try X-Real-IP header
        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            return real_ip.strip()
        
        # Fall back to direct client IP
        if request.client:
            return request.client.host
        
        # Default if no client info available
        return "unknown"
    
    def _get_tier_for_path(self, path: str) -> str:
        """
        Determine rate limit tier based on request path.
        
        Args:
            path: Request path
            
        Returns:
            Rate limit tier name
        """
        # Map paths to tiers
        if path.startswith("/chat") and "stream" in path:
            return "chat_streaming"
        elif path.startswith("/chat/file") or path.startswith("/file"):
            return "file_upload"
        elif path.startswith("/chat"):
            return "api_heavy"
        elif path == "/" or path.startswith("/health"):
            return "api_default"
        else:
            return "api_default"
    
    def _add_rate_limit_headers(
        self,
        response: Response,
        limit_info: dict
    ) -> None:
        """
        Add rate limit information to response headers.
        
        Args:
            response: HTTP response
            limit_info: Rate limit info from limiter
        """
        response.headers["X-RateLimit-Limit"] = str(limit_info['limit'])
        response.headers["X-RateLimit-Remaining"] = str(limit_info['remaining'])
        response.headers["X-RateLimit-Reset"] = str(limit_info['reset'])


def create_rate_limiter_middleware(
    enabled: bool = True
):
    """
    Create rate limiter middleware factory.
    
    Args:
        enabled: Whether to enable rate limiting
        
    Returns:
        Middleware class and kwargs for FastAPI
    """
    return (RateLimiterMiddleware, {"enabled": enabled})

