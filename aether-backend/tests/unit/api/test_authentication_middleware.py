"""
Unit Tests: api/middleware/authentication.py

Covers: AuthenticationMiddleware init, dispatch (disabled bypass, OPTIONS bypass,
public pattern bypass, auth enforcement), and factory function.

Mock boundaries:
- api.dependencies.require_auth_context → patched at import site inside dispatch
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_request(method="GET", path="/v1/settings"):
    req = MagicMock()
    req.method = method
    req.url = MagicMock()
    req.url.path = path
    return req


def _make_settings():
    return MagicMock()


# ---------------------------------------------------------------------------
# Init
# ---------------------------------------------------------------------------

class TestAuthMiddlewareInit:

    def test_init_enabled(self):
        from api.middleware.authentication import AuthenticationMiddleware
        app = MagicMock()
        settings = _make_settings()
        mw = AuthenticationMiddleware(
            app, enabled=True, public_patterns=["/health", "/docs/*"], settings=settings
        )
        assert mw._enabled is True
        assert mw._public_patterns == ("/health", "/docs/*")
        assert mw._settings is settings

    def test_init_disabled(self):
        from api.middleware.authentication import AuthenticationMiddleware
        app = MagicMock()
        mw = AuthenticationMiddleware(
            app, enabled=False, public_patterns=[], settings=_make_settings()
        )
        assert mw._enabled is False

    def test_init_none_patterns_becomes_empty_tuple(self):
        from api.middleware.authentication import AuthenticationMiddleware
        app = MagicMock()
        mw = AuthenticationMiddleware(
            app, enabled=True, public_patterns=None, settings=_make_settings()
        )
        assert mw._public_patterns == ()


# ---------------------------------------------------------------------------
# Dispatch — disabled bypass
# ---------------------------------------------------------------------------

class TestDispatchDisabled:

    @pytest.mark.asyncio
    async def test_disabled_passes_through(self):
        from api.middleware.authentication import AuthenticationMiddleware
        app = MagicMock()
        mw = AuthenticationMiddleware(
            app, enabled=False, public_patterns=[], settings=_make_settings()
        )
        expected_resp = MagicMock()
        call_next = AsyncMock(return_value=expected_resp)
        result = await mw.dispatch(_make_request(), call_next)
        assert result is expected_resp
        call_next.assert_awaited_once()


# ---------------------------------------------------------------------------
# Dispatch — OPTIONS bypass
# ---------------------------------------------------------------------------

class TestDispatchOptions:

    @pytest.mark.asyncio
    async def test_options_request_bypasses_auth(self):
        from api.middleware.authentication import AuthenticationMiddleware
        app = MagicMock()
        mw = AuthenticationMiddleware(
            app, enabled=True, public_patterns=[], settings=_make_settings()
        )
        expected_resp = MagicMock()
        call_next = AsyncMock(return_value=expected_resp)
        result = await mw.dispatch(_make_request(method="OPTIONS"), call_next)
        assert result is expected_resp


# ---------------------------------------------------------------------------
# Dispatch — public pattern bypass
# ---------------------------------------------------------------------------

class TestDispatchPublicPatterns:

    @pytest.mark.asyncio
    async def test_public_pattern_exact_match(self):
        from api.middleware.authentication import AuthenticationMiddleware
        app = MagicMock()
        mw = AuthenticationMiddleware(
            app, enabled=True, public_patterns=["/health"], settings=_make_settings()
        )
        expected_resp = MagicMock()
        call_next = AsyncMock(return_value=expected_resp)
        result = await mw.dispatch(_make_request(path="/health"), call_next)
        assert result is expected_resp

    @pytest.mark.asyncio
    async def test_public_pattern_glob_match(self):
        from api.middleware.authentication import AuthenticationMiddleware
        app = MagicMock()
        mw = AuthenticationMiddleware(
            app, enabled=True, public_patterns=["/docs/*"], settings=_make_settings()
        )
        expected_resp = MagicMock()
        call_next = AsyncMock(return_value=expected_resp)
        result = await mw.dispatch(_make_request(path="/docs/openapi.json"), call_next)
        assert result is expected_resp

    @pytest.mark.asyncio
    async def test_non_public_path_triggers_auth(self):
        from api.middleware.authentication import AuthenticationMiddleware
        app = MagicMock()
        settings = _make_settings()
        mw = AuthenticationMiddleware(
            app, enabled=True, public_patterns=["/health"], settings=settings
        )
        expected_resp = MagicMock()
        call_next = AsyncMock(return_value=expected_resp)

        with patch("api.dependencies.require_auth_context", new_callable=AsyncMock) as mock_auth:
            result = await mw.dispatch(_make_request(path="/v1/chat"), call_next)
            mock_auth.assert_awaited_once()
            assert result is expected_resp


# ---------------------------------------------------------------------------
# Dispatch — auth enforcement
# ---------------------------------------------------------------------------

class TestDispatchAuthEnforcement:

    @pytest.mark.asyncio
    async def test_auth_called_with_request_and_settings(self):
        from api.middleware.authentication import AuthenticationMiddleware
        app = MagicMock()
        settings = _make_settings()
        mw = AuthenticationMiddleware(
            app, enabled=True, public_patterns=[], settings=settings
        )
        call_next = AsyncMock(return_value=MagicMock())
        request = _make_request(path="/v1/protected")

        with patch("api.dependencies.require_auth_context", new_callable=AsyncMock) as mock_auth:
            await mw.dispatch(request, call_next)
            mock_auth.assert_awaited_once_with(request, settings=settings)

    @pytest.mark.asyncio
    async def test_auth_failure_propagates(self):
        from api.middleware.authentication import AuthenticationMiddleware
        from fastapi import HTTPException
        app = MagicMock()
        mw = AuthenticationMiddleware(
            app, enabled=True, public_patterns=[], settings=_make_settings()
        )
        call_next = AsyncMock()

        with patch(
            "api.dependencies.require_auth_context",
            new_callable=AsyncMock,
            side_effect=HTTPException(status_code=401, detail="Unauthorized"),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await mw.dispatch(_make_request(), call_next)
            assert exc_info.value.status_code == 401
            call_next.assert_not_awaited()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

class TestFactory:

    def test_factory_returns_class_and_kwargs(self):
        from api.middleware.authentication import (
            create_authentication_middleware,
            AuthenticationMiddleware,
        )
        settings = _make_settings()
        cls, kwargs = create_authentication_middleware(
            enabled=True, public_patterns=["/health"], settings=settings
        )
        assert cls is AuthenticationMiddleware
        assert kwargs["enabled"] is True
        assert kwargs["public_patterns"] == ["/health"]
        assert kwargs["settings"] is settings

    def test_factory_disabled(self):
        from api.middleware.authentication import create_authentication_middleware
        cls, kwargs = create_authentication_middleware(
            enabled=False, public_patterns=[], settings=_make_settings()
        )
        assert kwargs["enabled"] is False
