"""
Unit Tests: api/middleware/security.py

Covers: SecurityHeadersConfig (CSP building, HSTS building, defaults),
SecurityHeadersMiddleware (dispatch: normal, None response, EndOfStream,
RuntimeError 'No response returned', generic exception), _add_headers,
and factory function (dev/prod).

Mock boundaries:
- call_next → AsyncMock for simulating downstream responses
- anyio.EndOfStream → raised to simulate client disconnect
"""

import pytest
import anyio
from unittest.mock import AsyncMock, MagicMock

from api.middleware.security import (
    SecurityHeadersConfig,
    SecurityHeadersMiddleware,
    create_security_headers_middleware,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_request(method="GET", path="/v1/test"):
    req = MagicMock()
    req.method = method
    req.url = MagicMock()
    req.url.path = path
    return req


def _make_response(headers=None):
    resp = MagicMock()
    resp.headers = dict(headers or {})
    return resp


# ---------------------------------------------------------------------------
# SecurityHeadersConfig
# ---------------------------------------------------------------------------

class TestConfig:

    def test_default_csp_contains_critical_directives(self):
        cfg = SecurityHeadersConfig()
        assert "default-src" in cfg.csp_directives
        assert "object-src" in cfg.csp_directives
        assert "frame-ancestors" in cfg.csp_directives

    def test_build_csp_header_joins_directives(self):
        cfg = SecurityHeadersConfig(csp_directives={
            "default-src": "'self'",
            "script-src": "'self' 'unsafe-inline'",
        })
        header = cfg.build_csp_header()
        assert "default-src 'self'" in header
        assert "script-src 'self' 'unsafe-inline'" in header

    def test_build_csp_header_bare_directive(self):
        cfg = SecurityHeadersConfig(csp_directives={"upgrade-insecure-requests": ""})
        assert cfg.build_csp_header() == "upgrade-insecure-requests"

    def test_build_hsts_default(self):
        cfg = SecurityHeadersConfig(enable_hsts=True)
        hsts = cfg.build_hsts_header()
        assert "max-age=31536000" in hsts
        assert "includeSubDomains" in hsts
        assert "preload" not in hsts

    def test_build_hsts_with_preload(self):
        cfg = SecurityHeadersConfig(enable_hsts=True, hsts_preload=True)
        assert "preload" in cfg.build_hsts_header()

    def test_build_hsts_without_subdomains(self):
        cfg = SecurityHeadersConfig(enable_hsts=True, hsts_include_subdomains=False)
        assert "includeSubDomains" not in cfg.build_hsts_header()

    def test_default_permissions_policy(self):
        cfg = SecurityHeadersConfig()
        assert "camera=()" in cfg.permissions_policy
        assert "microphone=()" in cfg.permissions_policy

    def test_custom_x_frame_options(self):
        cfg = SecurityHeadersConfig(x_frame_options="DENY")
        assert cfg.x_frame_options == "DENY"


# ---------------------------------------------------------------------------
# SecurityHeadersMiddleware — dispatch
# ---------------------------------------------------------------------------

class TestDispatchNormal:

    @pytest.mark.asyncio
    async def test_normal_response_gets_security_headers(self):
        app = MagicMock()
        mw = SecurityHeadersMiddleware(app, config=SecurityHeadersConfig())
        resp = _make_response()
        call_next = AsyncMock(return_value=resp)

        result = await mw.dispatch(_make_request(), call_next)
        assert result is resp
        assert "X-Content-Type-Options" in result.headers
        assert result.headers["X-Content-Type-Options"] == "nosniff"
        assert "X-Frame-Options" in result.headers
        assert "Referrer-Policy" in result.headers
        assert "Permissions-Policy" in result.headers

    @pytest.mark.asyncio
    async def test_csp_header_present_when_enabled(self):
        app = MagicMock()
        cfg = SecurityHeadersConfig(enable_csp=True)
        mw = SecurityHeadersMiddleware(app, config=cfg)
        resp = _make_response()
        call_next = AsyncMock(return_value=resp)

        await mw.dispatch(_make_request(), call_next)
        assert "Content-Security-Policy" in resp.headers

    @pytest.mark.asyncio
    async def test_csp_header_absent_when_disabled(self):
        app = MagicMock()
        cfg = SecurityHeadersConfig(enable_csp=False)
        mw = SecurityHeadersMiddleware(app, config=cfg)
        resp = _make_response()
        call_next = AsyncMock(return_value=resp)

        await mw.dispatch(_make_request(), call_next)
        assert "Content-Security-Policy" not in resp.headers

    @pytest.mark.asyncio
    async def test_hsts_header_when_enabled(self):
        app = MagicMock()
        cfg = SecurityHeadersConfig(enable_hsts=True)
        mw = SecurityHeadersMiddleware(app, config=cfg)
        resp = _make_response()
        call_next = AsyncMock(return_value=resp)

        await mw.dispatch(_make_request(), call_next)
        assert "Strict-Transport-Security" in resp.headers

    @pytest.mark.asyncio
    async def test_hsts_header_absent_when_disabled(self):
        app = MagicMock()
        cfg = SecurityHeadersConfig(enable_hsts=False)
        mw = SecurityHeadersMiddleware(app, config=cfg)
        resp = _make_response()
        call_next = AsyncMock(return_value=resp)

        await mw.dispatch(_make_request(), call_next)
        assert "Strict-Transport-Security" not in resp.headers


class TestDispatchNoneResponse:

    @pytest.mark.asyncio
    async def test_none_response_returns_500(self):
        app = MagicMock()
        mw = SecurityHeadersMiddleware(app, config=SecurityHeadersConfig())
        call_next = AsyncMock(return_value=None)

        result = await mw.dispatch(_make_request(), call_next)
        assert result.status_code == 500


class TestDispatchClientDisconnect:

    @pytest.mark.asyncio
    async def test_end_of_stream_returns_204(self):
        app = MagicMock()
        mw = SecurityHeadersMiddleware(app, config=SecurityHeadersConfig())
        call_next = AsyncMock(side_effect=anyio.EndOfStream())

        result = await mw.dispatch(_make_request(), call_next)
        assert result.status_code == 204

    @pytest.mark.asyncio
    async def test_no_response_runtime_error_returns_204(self):
        app = MagicMock()
        mw = SecurityHeadersMiddleware(app, config=SecurityHeadersConfig())
        call_next = AsyncMock(side_effect=RuntimeError("No response returned"))

        result = await mw.dispatch(_make_request(), call_next)
        assert result.status_code == 204

    @pytest.mark.asyncio
    async def test_other_runtime_error_reraises(self):
        app = MagicMock()
        mw = SecurityHeadersMiddleware(app, config=SecurityHeadersConfig())
        call_next = AsyncMock(side_effect=RuntimeError("Something else"))

        with pytest.raises(RuntimeError, match="Something else"):
            await mw.dispatch(_make_request(), call_next)


class TestDispatchGenericException:

    @pytest.mark.asyncio
    async def test_generic_exception_reraises(self):
        app = MagicMock()
        mw = SecurityHeadersMiddleware(app, config=SecurityHeadersConfig())
        call_next = AsyncMock(side_effect=ValueError("bad data"))

        with pytest.raises(ValueError, match="bad data"):
            await mw.dispatch(_make_request(), call_next)


# ---------------------------------------------------------------------------
# _add_headers — conditional branches
# ---------------------------------------------------------------------------

class TestAddHeaders:

    def test_no_x_frame_when_none(self):
        cfg = SecurityHeadersConfig(x_frame_options=None)
        mw = SecurityHeadersMiddleware.__new__(SecurityHeadersMiddleware)
        mw.config = cfg
        resp = _make_response()
        mw._add_headers(resp)
        assert "X-Frame-Options" not in resp.headers

    def test_no_xss_protection_when_none(self):
        cfg = SecurityHeadersConfig(x_xss_protection=None)
        mw = SecurityHeadersMiddleware.__new__(SecurityHeadersMiddleware)
        mw.config = cfg
        resp = _make_response()
        mw._add_headers(resp)
        assert "X-XSS-Protection" not in resp.headers

    def test_no_content_type_options_when_none(self):
        cfg = SecurityHeadersConfig(x_content_type_options=None)
        mw = SecurityHeadersMiddleware.__new__(SecurityHeadersMiddleware)
        mw.config = cfg
        resp = _make_response()
        mw._add_headers(resp)
        assert "X-Content-Type-Options" not in resp.headers

    def test_no_referrer_policy_when_none(self):
        cfg = SecurityHeadersConfig(referrer_policy=None)
        mw = SecurityHeadersMiddleware.__new__(SecurityHeadersMiddleware)
        mw.config = cfg
        resp = _make_response()
        mw._add_headers(resp)
        assert "Referrer-Policy" not in resp.headers

    def test_no_permissions_policy_when_falsy(self):
        cfg = SecurityHeadersConfig()
        cfg.permissions_policy = ""  # Override after init (init applies default)
        mw = SecurityHeadersMiddleware.__new__(SecurityHeadersMiddleware)
        mw.config = cfg
        resp = _make_response()
        mw._add_headers(resp)
        assert "Permissions-Policy" not in resp.headers


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

class TestFactory:

    def test_dev_config(self):
        cls, kwargs = create_security_headers_middleware(production=False)
        assert cls is SecurityHeadersMiddleware
        config = kwargs["config"]
        assert config.x_frame_options == "SAMEORIGIN"
        assert config.enable_hsts is False

    def test_prod_config(self):
        cls, kwargs = create_security_headers_middleware(production=True)
        config = kwargs["config"]
        assert config.x_frame_options == "DENY"
        assert config.enable_hsts is True
        assert "unsafe-inline" not in config.csp_directives.get("script-src", "")
        assert config.csp_directives.get("frame-ancestors") == "'self' app: aether: file:"
