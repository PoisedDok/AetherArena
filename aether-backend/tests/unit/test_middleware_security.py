"""
Unit tests for security headers middleware and rate limiter middleware.

Tests the pure logic of:
- SecurityHeadersConfig default generation and CSP building
- SecurityHeadersMiddleware header injection
- RateLimiterMiddleware client ID extraction and tier routing
- create_security_headers_middleware() factory for dev/prod
"""

import pytest
from unittest.mock import MagicMock, AsyncMock

from api.middleware.security import (
    SecurityHeadersConfig,
    SecurityHeadersMiddleware,
    create_security_headers_middleware,
)
from api.middleware.rate_limiter import (
    RateLimiterMiddleware,
    create_rate_limiter_middleware,
)


# =============================================================================
# SecurityHeadersConfig Tests
# =============================================================================

class TestSecurityHeadersConfig:
    """Test SecurityHeadersConfig default generation and CSP building."""

    def test_default_csp_directives(self):
        """Default CSP directives must contain critical security entries."""
        cfg = SecurityHeadersConfig()
        assert "default-src" in cfg.csp_directives
        assert "'self'" in cfg.csp_directives["default-src"]
        assert "object-src" in cfg.csp_directives
        assert "'none'" in cfg.csp_directives["object-src"]
        assert "frame-ancestors" in cfg.csp_directives

    def test_build_csp_header_format(self):
        """CSP header must be semicolon-separated directive string."""
        cfg = SecurityHeadersConfig(
            csp_directives={
                "default-src": "'self'",
                "script-src": "'self' 'unsafe-inline'",
                "object-src": "'none'",
            }
        )
        header = cfg.build_csp_header()
        assert "default-src 'self'" in header
        assert "script-src 'self' 'unsafe-inline'" in header
        assert "object-src 'none'" in header
        # Directives separated by "; "
        parts = [p.strip() for p in header.split(";")]
        assert len(parts) == 3

    def test_build_csp_header_empty_value_directive(self):
        """Directives with empty value (e.g. upgrade-insecure-requests) appear bare."""
        cfg = SecurityHeadersConfig(
            csp_directives={"upgrade-insecure-requests": ""}
        )
        header = cfg.build_csp_header()
        assert header == "upgrade-insecure-requests"

    def test_default_permissions_policy(self):
        """Default permissions policy restricts sensitive browser features."""
        cfg = SecurityHeadersConfig()
        assert "camera=()" in cfg.permissions_policy
        assert "microphone=()" in cfg.permissions_policy
        assert "geolocation=()" in cfg.permissions_policy
        assert "payment=()" in cfg.permissions_policy

    def test_hsts_header_default(self):
        """HSTS header with default settings."""
        cfg = SecurityHeadersConfig(enable_hsts=True)
        hsts = cfg.build_hsts_header()
        assert "max-age=31536000" in hsts
        assert "includeSubDomains" in hsts
        assert "preload" not in hsts

    def test_hsts_header_with_preload(self):
        """HSTS header includes preload when enabled."""
        cfg = SecurityHeadersConfig(
            enable_hsts=True, hsts_preload=True
        )
        hsts = cfg.build_hsts_header()
        assert "preload" in hsts

    def test_hsts_header_without_subdomains(self):
        """HSTS header omits includeSubDomains when disabled."""
        cfg = SecurityHeadersConfig(
            enable_hsts=True, hsts_include_subdomains=False
        )
        hsts = cfg.build_hsts_header()
        assert "includeSubDomains" not in hsts

    def test_custom_x_frame_options(self):
        """Custom X-Frame-Options is stored correctly."""
        cfg = SecurityHeadersConfig(x_frame_options="DENY")
        assert cfg.x_frame_options == "DENY"


# =============================================================================
# SecurityHeadersMiddleware Factory Tests
# =============================================================================

class TestSecurityHeadersFactory:
    """Test create_security_headers_middleware for dev vs production."""

    def test_dev_config_has_sameorigin(self):
        """Dev mode uses SAMEORIGIN for frame options."""
        cls, kwargs = create_security_headers_middleware(production=False)
        assert cls is SecurityHeadersMiddleware
        config = kwargs["config"]
        assert config.x_frame_options == "SAMEORIGIN"
        assert config.enable_hsts is False

    def test_prod_config_has_deny_and_hsts(self):
        """Production mode uses DENY and enables HSTS."""
        cls, kwargs = create_security_headers_middleware(production=True)
        config = kwargs["config"]
        assert config.x_frame_options == "DENY"
        assert config.enable_hsts is True
        assert config.hsts_max_age == 31536000

    def test_prod_csp_no_unsafe_inline(self):
        """Production CSP must NOT contain unsafe-inline for scripts."""
        cls, kwargs = create_security_headers_middleware(production=True)
        config = kwargs["config"]
        assert "unsafe-inline" not in config.csp_directives.get("script-src", "")


# =============================================================================
# RateLimiterMiddleware Unit Tests (no Redis required)
# =============================================================================

class TestRateLimiterClientId:
    """Test client identification logic in rate limiter."""

    def _make_request(self, headers=None, client_host="127.0.0.1"):
        """Create a minimal mock request."""
        req = MagicMock()
        req.headers = headers or {}
        req.client = MagicMock()
        req.client.host = client_host
        req.url = MagicMock()
        req.url.path = "/v1/test"
        return req

    def test_x_forwarded_for_takes_priority(self):
        """X-Forwarded-For header should be used first."""
        mw = RateLimiterMiddleware.__new__(RateLimiterMiddleware)
        req = self._make_request(
            headers={"X-Forwarded-For": "203.0.113.50, 70.41.3.18"},
            client_host="10.0.0.1",
        )
        assert mw._get_client_id(req) == "203.0.113.50"

    def test_x_real_ip_fallback(self):
        """X-Real-IP is used when X-Forwarded-For is absent."""
        mw = RateLimiterMiddleware.__new__(RateLimiterMiddleware)
        req = self._make_request(
            headers={"X-Real-IP": "198.51.100.23"},
            client_host="10.0.0.1",
        )
        assert mw._get_client_id(req) == "198.51.100.23"

    def test_direct_client_host(self):
        """Falls back to direct client.host when no proxy headers."""
        mw = RateLimiterMiddleware.__new__(RateLimiterMiddleware)
        req = self._make_request(client_host="192.168.1.100")
        assert mw._get_client_id(req) == "192.168.1.100"

    def test_unknown_when_no_client(self):
        """Returns 'unknown' when no client info available."""
        mw = RateLimiterMiddleware.__new__(RateLimiterMiddleware)
        req = MagicMock()
        req.headers = {}
        req.client = None
        assert mw._get_client_id(req) == "unknown"


class TestRateLimiterTierRouting:
    """Test path-to-tier routing logic."""

    def _make_mw(self, tier_overrides=None):
        mw = RateLimiterMiddleware.__new__(RateLimiterMiddleware)
        mw._tier_overrides = list(tier_overrides or [])
        return mw

    def test_chat_streaming_tier(self):
        mw = self._make_mw()
        assert mw._get_tier_for_path("/chat/stream/abc") == "chat_streaming"

    def test_chat_file_upload_tier(self):
        mw = self._make_mw()
        assert mw._get_tier_for_path("/chat/file/upload") == "file_upload"

    def test_file_upload_tier(self):
        mw = self._make_mw()
        assert mw._get_tier_for_path("/file/upload") == "file_upload"

    def test_chat_heavy_tier(self):
        mw = self._make_mw()
        assert mw._get_tier_for_path("/chat/message") == "api_heavy"

    def test_health_default_tier(self):
        mw = self._make_mw()
        assert mw._get_tier_for_path("/health") == "api_default"

    def test_root_default_tier(self):
        mw = self._make_mw()
        assert mw._get_tier_for_path("/") == "api_default"

    def test_arbitrary_path_default_tier(self):
        mw = self._make_mw()
        assert mw._get_tier_for_path("/v1/settings") == "api_default"

    def test_tier_override_takes_priority(self):
        mw = self._make_mw(tier_overrides=[("/v1/llm/*", "api_heavy")])
        assert mw._get_tier_for_path("/v1/llm/chat/completions") == "api_heavy"

    def test_tier_override_no_match_falls_through(self):
        mw = self._make_mw(tier_overrides=[("/v1/llm/*", "api_heavy")])
        assert mw._get_tier_for_path("/v1/settings") == "api_default"


class TestRateLimiterMiddlewareDisabled:
    """Test rate limiter bypass when disabled."""

    @pytest.mark.asyncio
    async def test_disabled_passes_through(self):
        """When disabled, requests pass straight through."""
        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=False)

        mock_response = MagicMock()
        call_next = AsyncMock(return_value=mock_response)
        request = MagicMock()
        request.url = MagicMock()
        request.url.path = "/test"

        result = await mw.dispatch(request, call_next)
        assert result is mock_response
        call_next.assert_awaited_once_with(request)


class TestRateLimiterFactory:
    """Test create_rate_limiter_middleware factory."""

    def test_factory_returns_class_and_kwargs(self):
        cls, kwargs = create_rate_limiter_middleware(enabled=True)
        assert cls is RateLimiterMiddleware
        assert kwargs["enabled"] is True

    def test_factory_disabled(self):
        cls, kwargs = create_rate_limiter_middleware(enabled=False)
        assert kwargs["enabled"] is False

    def test_factory_with_tier_overrides(self):
        overrides = [("/v1/chat/*", "chat_streaming")]
        cls, kwargs = create_rate_limiter_middleware(
            enabled=True, tier_overrides=overrides
        )
        assert kwargs["tier_overrides"] == overrides
