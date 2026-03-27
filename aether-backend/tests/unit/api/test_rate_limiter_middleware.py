"""
Unit Tests: api/middleware/rate_limiter.py

Covers: RateLimiterMiddleware init (enabled/disabled), full dispatch flow
(pass-through, rate-limit-exceeded, unexpected error), client ID extraction,
tier routing, header injection, and factory function.

Mock boundaries:
- security.rate_limit.get_rate_limiter → patched at import site
- security.rate_limit.RateLimitExceeded → real class or mock
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_request(headers=None, client_host="127.0.0.1", path="/v1/test"):
    """Minimal mock Request."""
    req = MagicMock()
    req.headers = headers or {}
    req.client = MagicMock()
    req.client.host = client_host
    req.url = MagicMock()
    req.url.path = path
    return req


def _make_response():
    """Minimal mock Response with real headers dict."""
    resp = MagicMock()
    resp.headers = {}
    return resp


def _make_limiter(limit_info=None, check_side_effect=None):
    """Create a mock rate limiter."""
    limiter = AsyncMock()
    limiter.check_rate_limit = AsyncMock(side_effect=check_side_effect)
    limiter.get_limit_info = AsyncMock(
        return_value=limit_info or {"limit": 100, "remaining": 99, "reset": 60}
    )
    return limiter


# ---------------------------------------------------------------------------
# Init
# ---------------------------------------------------------------------------

class TestRateLimiterInit:
    """Test __init__ for both enabled and disabled states."""

    @patch("api.middleware.rate_limiter.RateLimiterMiddleware.__init__", return_value=None)
    def test_factory_returns_class_and_kwargs(self, _mock_init):
        from api.middleware.rate_limiter import create_rate_limiter_middleware
        cls, kwargs = create_rate_limiter_middleware(enabled=True, tier_overrides=[("/a", "t")])
        from api.middleware.rate_limiter import RateLimiterMiddleware
        assert cls is RateLimiterMiddleware
        assert kwargs["enabled"] is True
        assert kwargs["tier_overrides"] == [("/a", "t")]

    def test_init_disabled(self):
        from api.middleware.rate_limiter import RateLimiterMiddleware
        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=False)
        assert mw.enabled is False
        assert mw._limiter is None

    @patch("security.rate_limit.get_rate_limiter")
    def test_init_enabled(self, mock_get_rl):
        mock_limiter = MagicMock()
        mock_get_rl.return_value = mock_limiter
        from api.middleware.rate_limiter import RateLimiterMiddleware
        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=True)
        assert mw.enabled is True
        assert mw._limiter is mock_limiter
        mock_get_rl.assert_called_once()

    @patch("security.rate_limit.get_rate_limiter")
    def test_init_enabled_with_tier_overrides(self, mock_get_rl):
        mock_get_rl.return_value = MagicMock()
        from api.middleware.rate_limiter import RateLimiterMiddleware
        overrides = [("/v1/chat/*", "chat_streaming"), ("/health", "api_default")]
        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=True, tier_overrides=overrides)
        assert mw._tier_overrides == list(overrides)


# ---------------------------------------------------------------------------
# Dispatch — disabled / passthrough
# ---------------------------------------------------------------------------

class TestDispatchDisabled:
    """When disabled, dispatch is a simple pass-through."""

    @pytest.mark.asyncio
    async def test_disabled_passes_through(self):
        from api.middleware.rate_limiter import RateLimiterMiddleware
        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=False)

        expected_resp = _make_response()
        call_next = AsyncMock(return_value=expected_resp)
        request = _make_request()

        result = await mw.dispatch(request, call_next)
        assert result is expected_resp
        call_next.assert_awaited_once_with(request)

    @pytest.mark.asyncio
    async def test_limiter_none_passes_through(self):
        """Explicitly setting _limiter to None still passes through."""
        from api.middleware.rate_limiter import RateLimiterMiddleware
        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=False)
        mw.enabled = True
        mw._limiter = None

        expected_resp = _make_response()
        call_next = AsyncMock(return_value=expected_resp)
        request = _make_request()

        result = await mw.dispatch(request, call_next)
        assert result is expected_resp


# ---------------------------------------------------------------------------
# Dispatch — enabled, request passes rate limit
# ---------------------------------------------------------------------------

class TestDispatchAllowed:
    """When rate limit is not exceeded, request flows through with headers."""

    @pytest.mark.asyncio
    async def test_allowed_request_gets_headers(self):
        from api.middleware.rate_limiter import RateLimiterMiddleware
        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=False)
        # Manually wire up an enabled limiter (bypass __init__ import)
        limiter = _make_limiter()
        mw.enabled = True
        mw._limiter = limiter
        mw._tier_overrides = []

        downstream_resp = _make_response()
        call_next = AsyncMock(return_value=downstream_resp)
        request = _make_request(path="/v1/settings")

        result = await mw.dispatch(request, call_next)

        # Rate limit was checked
        limiter.check_rate_limit.assert_awaited_once()
        limiter.get_limit_info.assert_awaited_once()
        # Headers injected
        assert result.headers["X-RateLimit-Limit"] == "100"
        assert result.headers["X-RateLimit-Remaining"] == "99"
        assert result.headers["X-RateLimit-Reset"] == "60"
        # Response is the downstream response
        call_next.assert_awaited_once_with(request)

    @pytest.mark.asyncio
    async def test_allowed_request_correct_tier_passed(self):
        from api.middleware.rate_limiter import RateLimiterMiddleware
        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=False)
        limiter = _make_limiter()
        mw.enabled = True
        mw._limiter = limiter
        mw._tier_overrides = []

        call_next = AsyncMock(return_value=_make_response())
        request = _make_request(path="/chat/stream/xyz", client_host="10.0.0.1")

        await mw.dispatch(request, call_next)

        # Verify correct client_id and tier passed
        limiter.check_rate_limit.assert_awaited_once_with("10.0.0.1", "chat_streaming")


# ---------------------------------------------------------------------------
# Dispatch — rate limit exceeded (429)
# ---------------------------------------------------------------------------

class TestDispatchExceeded:
    """When rate limit is exceeded, 429 response with Retry-After."""

    @pytest.mark.asyncio
    async def test_rate_limit_exceeded_returns_429(self):
        from api.middleware.rate_limiter import RateLimiterMiddleware
        from security.rate_limit import RateLimitExceeded

        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=False)

        exc = RateLimitExceeded("Too many requests", retry_after=30.0)
        limiter = _make_limiter(
            check_side_effect=exc,
            limit_info={"limit": 100, "remaining": 0, "reset": 30},
        )
        mw.enabled = True
        mw._limiter = limiter
        mw._tier_overrides = []

        call_next = AsyncMock()
        request = _make_request(path="/v1/test")

        result = await mw.dispatch(request, call_next)

        assert result.status_code == 429
        assert result.headers["Retry-After"] == "30"
        assert result.headers["X-RateLimit-Remaining"] == "0"
        # call_next should NOT have been called (request rejected)
        call_next.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_rate_limit_exceeded_body_contains_message(self):
        from api.middleware.rate_limiter import RateLimiterMiddleware
        from security.rate_limit import RateLimitExceeded

        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=False)

        exc = RateLimitExceeded("Slow down buddy", retry_after=10.5)
        limiter = _make_limiter(check_side_effect=exc)
        mw.enabled = True
        mw._limiter = limiter
        mw._tier_overrides = []

        call_next = AsyncMock()
        request = _make_request()

        result = await mw.dispatch(request, call_next)
        assert result.body == b"Slow down buddy"


# ---------------------------------------------------------------------------
# Dispatch — unexpected error in limiter (fallback pass-through)
# ---------------------------------------------------------------------------

class TestDispatchUnexpectedError:
    """Unexpected errors in limiter should NOT block the request."""

    @pytest.mark.asyncio
    async def test_unexpected_error_passes_through(self):
        from api.middleware.rate_limiter import RateLimiterMiddleware

        app = MagicMock()
        mw = RateLimiterMiddleware(app, enabled=False)
        limiter = _make_limiter(check_side_effect=RuntimeError("Redis down"))
        mw.enabled = True
        mw._limiter = limiter
        mw._tier_overrides = []

        expected_resp = _make_response()
        call_next = AsyncMock(return_value=expected_resp)
        request = _make_request()

        result = await mw.dispatch(request, call_next)

        # Request should still go through
        assert result is expected_resp
        call_next.assert_awaited_once_with(request)


# ---------------------------------------------------------------------------
# Client ID extraction
# ---------------------------------------------------------------------------

class TestGetClientId:
    """Test all branches of _get_client_id."""

    def _mw(self):
        from api.middleware.rate_limiter import RateLimiterMiddleware
        mw = RateLimiterMiddleware.__new__(RateLimiterMiddleware)
        return mw

    def test_x_forwarded_for_first_ip(self):
        mw = self._mw()
        req = _make_request(headers={"X-Forwarded-For": "1.2.3.4, 5.6.7.8"})
        assert mw._get_client_id(req) == "1.2.3.4"

    def test_x_forwarded_for_single_ip(self):
        mw = self._mw()
        req = _make_request(headers={"X-Forwarded-For": "9.8.7.6"})
        assert mw._get_client_id(req) == "9.8.7.6"

    def test_x_real_ip_used_when_no_forwarded(self):
        mw = self._mw()
        req = _make_request(headers={"X-Real-IP": "  100.0.0.1  "})
        assert mw._get_client_id(req) == "100.0.0.1"

    def test_direct_client_host(self):
        mw = self._mw()
        req = _make_request(client_host="192.168.1.50")
        assert mw._get_client_id(req) == "192.168.1.50"

    def test_unknown_when_no_client(self):
        mw = self._mw()
        req = MagicMock()
        req.headers = {}
        req.client = None
        assert mw._get_client_id(req) == "unknown"


# ---------------------------------------------------------------------------
# Tier routing
# ---------------------------------------------------------------------------

class TestGetTierForPath:
    """Test path → tier mapping."""

    def _mw(self, tier_overrides=None):
        from api.middleware.rate_limiter import RateLimiterMiddleware
        mw = RateLimiterMiddleware.__new__(RateLimiterMiddleware)
        mw._tier_overrides = list(tier_overrides or [])
        return mw

    def test_chat_streaming(self):
        assert self._mw()._get_tier_for_path("/chat/stream/id") == "chat_streaming"

    def test_chat_file_upload(self):
        assert self._mw()._get_tier_for_path("/chat/file/upload") == "file_upload"

    def test_file_prefix(self):
        assert self._mw()._get_tier_for_path("/file/download") == "file_upload"

    def test_chat_generic(self):
        assert self._mw()._get_tier_for_path("/chat/send") == "api_heavy"

    def test_health(self):
        assert self._mw()._get_tier_for_path("/health") == "api_default"

    def test_root(self):
        assert self._mw()._get_tier_for_path("/") == "api_default"

    def test_arbitrary_path(self):
        assert self._mw()._get_tier_for_path("/v1/models") == "api_default"

    def test_override_takes_priority(self):
        mw = self._mw(tier_overrides=[("/v1/llm/*", "api_heavy")])
        assert mw._get_tier_for_path("/v1/llm/chat/completions") == "api_heavy"

    def test_override_no_match_falls_through(self):
        mw = self._mw(tier_overrides=[("/v1/llm/*", "api_heavy")])
        assert mw._get_tier_for_path("/v1/settings") == "api_default"


# ---------------------------------------------------------------------------
# Header injection
# ---------------------------------------------------------------------------

class TestAddRateLimitHeaders:
    """Test _add_rate_limit_headers."""

    def test_headers_injected(self):
        from api.middleware.rate_limiter import RateLimiterMiddleware
        mw = RateLimiterMiddleware.__new__(RateLimiterMiddleware)
        resp = _make_response()
        mw._add_rate_limit_headers(resp, {"limit": 50, "remaining": 42, "reset": 120})
        assert resp.headers["X-RateLimit-Limit"] == "50"
        assert resp.headers["X-RateLimit-Remaining"] == "42"
        assert resp.headers["X-RateLimit-Reset"] == "120"


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

class TestFactory:
    """Test create_rate_limiter_middleware."""

    def test_factory_enabled(self):
        from api.middleware.rate_limiter import create_rate_limiter_middleware, RateLimiterMiddleware
        cls, kwargs = create_rate_limiter_middleware(enabled=True)
        assert cls is RateLimiterMiddleware
        assert kwargs["enabled"] is True

    def test_factory_disabled(self):
        from api.middleware.rate_limiter import create_rate_limiter_middleware
        cls, kwargs = create_rate_limiter_middleware(enabled=False)
        assert kwargs["enabled"] is False

    def test_factory_with_overrides(self):
        from api.middleware.rate_limiter import create_rate_limiter_middleware
        overrides = [("/chat/*", "chat_streaming")]
        cls, kwargs = create_rate_limiter_middleware(enabled=True, tier_overrides=overrides)
        assert kwargs["tier_overrides"] == overrides

    def test_factory_none_overrides(self):
        from api.middleware.rate_limiter import create_rate_limiter_middleware
        cls, kwargs = create_rate_limiter_middleware(enabled=True, tier_overrides=None)
        assert kwargs["tier_overrides"] is None
