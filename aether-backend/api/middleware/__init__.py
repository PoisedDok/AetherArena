"""
API Middleware Layer

Provides middleware components for request/response processing including:
- Security headers
- Rate limiting
- Error handling
- CORS (via FastAPI)

All middleware is production-ready and configurable.
"""

from .security import (
    SecurityHeadersMiddleware,
    SecurityHeadersConfig,
    create_security_headers_middleware,
)

from .rate_limiter import (
    RateLimiterMiddleware,
    create_rate_limiter_middleware,
)

from .error_handler import (
    ErrorHandlerMiddleware,
    ErrorHandlerConfig,
    create_error_handler_middleware,
)

__all__ = [
    # Security headers
    'SecurityHeadersMiddleware',
    'SecurityHeadersConfig',
    'create_security_headers_middleware',
    
    # Rate limiting
    'RateLimiterMiddleware',
    'create_rate_limiter_middleware',
    
    # Error handling
    'ErrorHandlerMiddleware',
    'ErrorHandlerConfig',
    'create_error_handler_middleware',
]

