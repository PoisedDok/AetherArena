"""
Global Error Handler Middleware - API Layer

Provides centralized error handling with sanitized error responses and logging.

@.architecture
Incoming: app.py (middleware registration), Exception objects from endpoints --- {FastAPI Request objects, Python exceptions}
Processing: dispatch(), _handle_error(), _classify_error(), _build_error_response(), _log_error() --- {5 jobs: exception_catching, error_classification, response_formatting, sanitization, logging}
Outgoing: monitoring/logging.py, Frontend (HTTP) --- {structured error logs, JSONResponse with standardized error format: code/message/type}
"""

import logging
import traceback
from typing import Callable, Optional, Dict, Any
from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)


class ErrorHandlerConfig:
    """Configuration for error handler."""
    
    def __init__(
        self,
        include_traceback: bool = False,
        sanitize_errors: bool = True,
        log_errors: bool = True,
        custom_error_messages: Optional[Dict[int, str]] = None
    ):
        """
        Initialize error handler configuration.
        
        Args:
            include_traceback: Include traceback in response (dev only)
            sanitize_errors: Sanitize error messages before sending
            log_errors: Log errors to logger
            custom_error_messages: Custom messages for HTTP status codes
        """
        self.include_traceback = include_traceback
        self.sanitize_errors = sanitize_errors
        self.log_errors = log_errors
        self.custom_error_messages = custom_error_messages or self._default_messages()
    
    @staticmethod
    def _default_messages() -> Dict[int, str]:
        """Default error messages for common status codes."""
        return {
            400: "Invalid request",
            401: "Authentication required",
            403: "Access forbidden",
            404: "Resource not found",
            405: "Method not allowed",
            408: "Request timeout",
            409: "Conflict",
            410: "Resource gone",
            413: "Request entity too large",
            415: "Unsupported media type",
            422: "Validation error",
            429: "Too many requests",
            500: "Internal server error",
            501: "Not implemented",
            502: "Bad gateway",
            503: "Service unavailable",
            504: "Gateway timeout",
        }


class ErrorHandlerMiddleware(BaseHTTPMiddleware):
    """
    Middleware for global error handling.
    
    Features:
    - Catches and formats all exceptions
    - Sanitizes error messages
    - Logs errors with context
    - Provides consistent error responses
    - Prevents sensitive information leakage
    """
    
    def __init__(
        self,
        app: ASGIApp,
        config: Optional[ErrorHandlerConfig] = None
    ):
        """
        Initialize error handler middleware.
        
        Args:
            app: ASGI application
            config: Error handler configuration
        """
        super().__init__(app)
        self.config = config or ErrorHandlerConfig()
        logger.info("Error handler middleware initialized")
    
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """
        Process request with error handling.
        
        Args:
            request: Incoming request
            call_next: Next middleware/handler
            
        Returns:
            Response (or error response if exception caught)
        """
        try:
            response = await call_next(request)
            return response
            
        except Exception as e:
            # Handle error
            return await self._handle_error(request, e)
    
    async def _handle_error(self, request: Request, error: Exception) -> JSONResponse:
        """
        Handle exception and return formatted error response.
        
        Args:
            request: Request that caused the error
            error: Exception that was raised
            
        Returns:
            JSONResponse with error details
        """
        # Determine status code and message
        status_code, error_message, error_type = self._classify_error(error)
        
        # Log error
        if self.config.log_errors:
            self._log_error(request, error, status_code)
        
        # Build error response
        error_response = self._build_error_response(
            status_code=status_code,
            error_message=error_message,
            error_type=error_type,
            error=error if self.config.include_traceback else None
        )
        
        return JSONResponse(
            status_code=status_code,
            content=error_response
        )
    
    def _classify_error(self, error: Exception) -> tuple[int, str, str]:
        """
        Classify error and determine status code and message.
        
        Args:
            error: Exception to classify
            
        Returns:
            Tuple of (status_code, message, error_type)
        """
        error_type = type(error).__name__
        
        # Import security exceptions
        try:
            from security.sanitization import (
                ValidationError, SizeExceededError, PathTraversalError
            )
            from security.rate_limit import RateLimitExceeded
            from security.auth import AuthenticationError
            from security.permissions import PermissionError
        except ImportError:
            # Fallback if security modules not available
            ValidationError = type('ValidationError', (Exception,), {})
            SizeExceededError = type('SizeExceededError', (Exception,), {})
            PathTraversalError = type('PathTraversalError', (Exception,), {})
            RateLimitExceeded = type('RateLimitExceeded', (Exception,), {})
            AuthenticationError = type('AuthenticationError', (Exception,), {})
            PermissionError = type('PermissionError', (Exception,), {})
        
        # Map exceptions to status codes
        if isinstance(error, ValidationError):
            return 400, str(error), error_type
        elif isinstance(error, SizeExceededError):
            return 413, str(error), error_type
        elif isinstance(error, PathTraversalError):
            return 400, "Invalid path", error_type
        elif isinstance(error, AuthenticationError):
            return 401, str(error), error_type
        elif isinstance(error, PermissionError):
            return 403, str(error), error_type
        elif isinstance(error, RateLimitExceeded):
            return 429, str(error), error_type
        elif hasattr(error, 'status_code'):
            # HTTPException or similar
            return error.status_code, str(error), error_type
        else:
            # Generic server error
            if self.config.sanitize_errors:
                message = "An error occurred processing your request"
            else:
                message = str(error)
            return 500, message, error_type
    
    def _build_error_response(
        self,
        status_code: int,
        error_message: str,
        error_type: str,
        error: Optional[Exception] = None
    ) -> Dict[str, Any]:
        """
        Build formatted error response.
        
        Args:
            status_code: HTTP status code
            error_message: Error message
            error_type: Error type name
            error: Original exception (if including traceback)
            
        Returns:
            Error response dictionary
        """
        response = {
            "error": {
                "code": status_code,
                "message": error_message,
                "type": error_type
            }
        }
        
        # Add custom message if available
        if status_code in self.config.custom_error_messages:
            response["error"]["hint"] = self.config.custom_error_messages[status_code]
        
        # Add traceback if configured (dev only)
        if self.config.include_traceback and error:
            response["error"]["traceback"] = traceback.format_exception(
                type(error), error, error.__traceback__
            )
        
        return response
    
    def _log_error(
        self,
        request: Request,
        error: Exception,
        status_code: int
    ) -> None:
        """
        Log error with request context.
        
        Args:
            request: Request that caused error
            error: Exception that was raised
            status_code: HTTP status code
        """
        # Build context
        context = {
            "method": request.method,
            "path": str(request.url.path),
            "status_code": status_code,
            "error_type": type(error).__name__,
            "client": request.client.host if request.client else "unknown"
        }
        
        # Log with appropriate level
        if status_code >= 500:
            logger.error(
                f"Server error: {error}",
                extra=context,
                exc_info=True
            )
        elif status_code >= 400:
            logger.warning(
                f"Client error: {error}",
                extra=context
            )
        else:
            logger.info(
                f"Request error: {error}",
                extra=context
            )


def create_error_handler_middleware(
    development: bool = False
):
    """
    Create error handler middleware factory with environment-appropriate config.
    
    Args:
        development: Whether running in development mode
        
    Returns:
        Middleware class and kwargs for FastAPI
    """
    if development:
        # Development configuration - more verbose
        config = ErrorHandlerConfig(
            include_traceback=True,
            sanitize_errors=False,
            log_errors=True
        )
    else:
        # Production configuration - sanitized
        config = ErrorHandlerConfig(
            include_traceback=False,
            sanitize_errors=True,
            log_errors=True
        )
    
    return (ErrorHandlerMiddleware, {"config": config})

