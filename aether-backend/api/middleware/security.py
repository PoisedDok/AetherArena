"""
Security Headers Middleware - API Layer

Adds security headers to all HTTP responses to protect against common web vulnerabilities.

@.architecture
Incoming: app.py (middleware registration), HTTP requests --- {FastAPI Request objects, HTTP responses from endpoints}
Processing: dispatch(), _add_headers(), build_csp_header(), build_hsts_header() --- {2 jobs: header_injection, response_interception}
Outgoing: Frontend (HTTP) --- {HTTP Response with security headers: CSP, X-Frame-Options, X-XSS-Protection, HSTS, Referrer-Policy, Permissions-Policy}
"""

import logging
from typing import Callable, Dict, Optional
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)


class SecurityHeadersConfig:
    """Configuration for security headers."""
    
    def __init__(
        self,
        # Content Security Policy
        enable_csp: bool = True,
        csp_directives: Optional[Dict[str, str]] = None,
        
        # Frame protection
        x_frame_options: str = "SAMEORIGIN",  # DENY, SAMEORIGIN, or None
        
        # XSS protection
        x_xss_protection: str = "1; mode=block",
        
        # Content type sniffing
        x_content_type_options: str = "nosniff",
        
        # Referrer policy
        referrer_policy: str = "strict-origin-when-cross-origin",
        
        # Permissions policy
        permissions_policy: Optional[str] = None,
        
        # HSTS (only enable in production with HTTPS)
        enable_hsts: bool = False,
        hsts_max_age: int = 31536000,  # 1 year in seconds
        hsts_include_subdomains: bool = True,
        hsts_preload: bool = False,
    ):
        """
        Initialize security headers configuration.
        
        Args:
            enable_csp: Enable Content Security Policy
            csp_directives: Custom CSP directives
            x_frame_options: X-Frame-Options value
            x_xss_protection: X-XSS-Protection value
            x_content_type_options: X-Content-Type-Options value
            referrer_policy: Referrer-Policy value
            permissions_policy: Permissions-Policy value
            enable_hsts: Enable HSTS (only use with HTTPS)
            hsts_max_age: HSTS max-age in seconds
            hsts_include_subdomains: Include subdomains in HSTS
            hsts_preload: Enable HSTS preload
        """
        self.enable_csp = enable_csp
        self.csp_directives = csp_directives or self._default_csp_directives()
        self.x_frame_options = x_frame_options
        self.x_xss_protection = x_xss_protection
        self.x_content_type_options = x_content_type_options
        self.referrer_policy = referrer_policy
        self.permissions_policy = permissions_policy or self._default_permissions_policy()
        self.enable_hsts = enable_hsts
        self.hsts_max_age = hsts_max_age
        self.hsts_include_subdomains = hsts_include_subdomains
        self.hsts_preload = hsts_preload
    
    @staticmethod
    def _default_csp_directives() -> Dict[str, str]:
        """Default Content Security Policy directives."""
        return {
            "default-src": "'self'",
            "script-src": "'self' 'unsafe-inline'",  # unsafe-inline needed for dev
            "style-src": "'self' 'unsafe-inline'",
            "img-src": "'self' data: blob:",
            "font-src": "'self' data:",
            "connect-src": "'self' ws: wss:",  # Allow WebSocket
            "media-src": "'self' blob:",
            "object-src": "'none'",
            "base-uri": "'self'",
            "form-action": "'self'",
            "frame-ancestors": "'self'",
            "upgrade-insecure-requests": "",  # Upgrade HTTP to HTTPS
        }
    
    @staticmethod
    def _default_permissions_policy() -> str:
        """Default Permissions Policy."""
        # Restrict access to sensitive browser features
        return (
            "accelerometer=(), "
            "camera=(), "
            "geolocation=(), "
            "gyroscope=(), "
            "magnetometer=(), "
            "microphone=(), "
            "payment=(), "
            "usb=()"
        )
    
    def build_csp_header(self) -> str:
        """Build Content-Security-Policy header value."""
        directives = []
        for key, value in self.csp_directives.items():
            if value:
                directives.append(f"{key} {value}")
            else:
                directives.append(key)
        return "; ".join(directives)
    
    def build_hsts_header(self) -> str:
        """Build Strict-Transport-Security header value."""
        parts = [f"max-age={self.hsts_max_age}"]
        if self.hsts_include_subdomains:
            parts.append("includeSubDomains")
        if self.hsts_preload:
            parts.append("preload")
        return "; ".join(parts)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Middleware to add security headers to all responses.
    
    Protects against:
    - XSS (Cross-Site Scripting)
    - Clickjacking
    - MIME-sniffing attacks
    - Protocol downgrade attacks (with HSTS)
    - Unauthorized feature access
    """
    
    def __init__(
        self,
        app: ASGIApp,
        config: Optional[SecurityHeadersConfig] = None
    ):
        """
        Initialize security headers middleware.
        
        Args:
            app: ASGI application
            config: Security headers configuration
        """
        super().__init__(app)
        self.config = config or SecurityHeadersConfig()
        logger.info("Security headers middleware initialized")
    
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """
        Process request and add security headers to response.
        
        Args:
            request: Incoming request
            call_next: Next middleware/handler
            
        Returns:
            Response with security headers added
        """
        # Process request
        response = await call_next(request)
        
        # Add security headers
        self._add_headers(response)
        
        return response
    
    def _add_headers(self, response: Response) -> None:
        """Add security headers to response."""
        
        # Content Security Policy
        if self.config.enable_csp:
            csp_header = self.config.build_csp_header()
            response.headers["Content-Security-Policy"] = csp_header
        
        # X-Frame-Options
        if self.config.x_frame_options:
            response.headers["X-Frame-Options"] = self.config.x_frame_options
        
        # X-XSS-Protection (legacy, but still useful for older browsers)
        if self.config.x_xss_protection:
            response.headers["X-XSS-Protection"] = self.config.x_xss_protection
        
        # X-Content-Type-Options
        if self.config.x_content_type_options:
            response.headers["X-Content-Type-Options"] = self.config.x_content_type_options
        
        # Referrer-Policy
        if self.config.referrer_policy:
            response.headers["Referrer-Policy"] = self.config.referrer_policy
        
        # Permissions-Policy
        if self.config.permissions_policy:
            response.headers["Permissions-Policy"] = self.config.permissions_policy
        
        # HSTS (only if enabled and HTTPS)
        if self.config.enable_hsts:
            hsts_header = self.config.build_hsts_header()
            response.headers["Strict-Transport-Security"] = hsts_header


def create_security_headers_middleware(
    production: bool = False
):
    """
    Create security headers middleware factory with environment-appropriate config.
    
    Args:
        production: Whether running in production
        
    Returns:
        Middleware class and kwargs for FastAPI
    """
    if production:
        # Production configuration (stricter)
        config = SecurityHeadersConfig(
            enable_csp=True,
            csp_directives={
                "default-src": "'self'",
                "script-src": "'self'",  # No unsafe-inline in production
                "style-src": "'self'",
                "img-src": "'self' data: blob:",
                "font-src": "'self' data:",
                "connect-src": "'self' ws: wss:",
                "media-src": "'self' blob:",
                "object-src": "'none'",
                "base-uri": "'self'",
                "form-action": "'self'",
                "frame-ancestors": "'none'",  # Stricter in production
                "upgrade-insecure-requests": "",
            },
            x_frame_options="DENY",  # Stricter in production
            enable_hsts=True,  # Enable HSTS in production
            hsts_max_age=31536000,
            hsts_include_subdomains=True,
        )
    else:
        # Development configuration (more permissive)
        config = SecurityHeadersConfig(
            enable_csp=True,
            x_frame_options="SAMEORIGIN",
            enable_hsts=False,  # No HSTS in development
        )
    
    return (SecurityHeadersMiddleware, {"config": config})

