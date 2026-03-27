"""
Unit Tests: api/middleware/error_handler.py

Covers: ErrorHandlerConfig (defaults, custom messages), ErrorHandlerMiddleware
(dispatch normal pass-through, dispatch error handling, error classification
for each exception type, response building, traceback inclusion, error logging
at each severity level, sanitize mode), and factory function (dev/prod).

Mock boundaries:
- security.sanitization, security.rate_limit, security.auth, security.permissions
  → imported inside _classify_error; real classes used when available
- call_next → AsyncMock
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from api.middleware.error_handler import (
    ErrorHandlerConfig,
    ErrorHandlerMiddleware,
    create_error_handler_middleware,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_request(method="GET", path="/v1/test", client_host="127.0.0.1"):
    req = MagicMock()
    req.method = method
    req.url = MagicMock()
    req.url.path = path
    req.client = MagicMock()
    req.client.host = client_host
    return req


# ---------------------------------------------------------------------------
# ErrorHandlerConfig
# ---------------------------------------------------------------------------

class TestConfig:

    def test_default_messages_contain_standard_codes(self):
        cfg = ErrorHandlerConfig()
        assert 400 in cfg.custom_error_messages
        assert 401 in cfg.custom_error_messages
        assert 403 in cfg.custom_error_messages
        assert 404 in cfg.custom_error_messages
        assert 429 in cfg.custom_error_messages
        assert 500 in cfg.custom_error_messages

    def test_custom_messages_override(self):
        cfg = ErrorHandlerConfig(custom_error_messages={418: "I'm a teapot"})
        assert cfg.custom_error_messages == {418: "I'm a teapot"}

    def test_defaults(self):
        cfg = ErrorHandlerConfig()
        assert cfg.include_traceback is False
        assert cfg.sanitize_errors is True
        assert cfg.log_errors is True


# ---------------------------------------------------------------------------
# ErrorHandlerMiddleware — dispatch
# ---------------------------------------------------------------------------

class TestDispatchNormal:

    @pytest.mark.asyncio
    async def test_normal_response_passes_through(self):
        app = MagicMock()
        mw = ErrorHandlerMiddleware(app, config=ErrorHandlerConfig())
        expected = MagicMock()
        call_next = AsyncMock(return_value=expected)

        result = await mw.dispatch(_make_request(), call_next)
        assert result is expected

    @pytest.mark.asyncio
    async def test_exception_returns_json_error(self):
        app = MagicMock()
        mw = ErrorHandlerMiddleware(app, config=ErrorHandlerConfig())
        call_next = AsyncMock(side_effect=RuntimeError("boom"))

        result = await mw.dispatch(_make_request(), call_next)
        assert result.status_code == 500
        body = result.body
        import json
        data = json.loads(body)
        assert "error" in data
        assert data["error"]["code"] == 500


# ---------------------------------------------------------------------------
# _classify_error — all branches
# ---------------------------------------------------------------------------

class TestClassifyError:

    def _mw(self, **kwargs):
        app = MagicMock()
        return ErrorHandlerMiddleware(app, config=ErrorHandlerConfig(**kwargs))

    def test_validation_error_returns_400(self):
        from security.sanitization import ValidationError
        mw = self._mw()
        code, msg, typ = mw._classify_error(ValidationError("bad input"))
        assert code == 400
        assert "bad input" in msg

    def test_size_exceeded_returns_413(self):
        from security.sanitization import SizeExceededError
        mw = self._mw()
        code, msg, typ = mw._classify_error(SizeExceededError("too big"))
        assert code == 413

    def test_path_traversal_returns_400(self):
        from security.sanitization import PathTraversalError
        mw = self._mw()
        code, msg, typ = mw._classify_error(PathTraversalError("../etc"))
        assert code == 400
        assert msg == "Invalid path"

    def test_authentication_error_returns_401(self):
        from security.auth import AuthenticationError
        mw = self._mw()
        code, msg, typ = mw._classify_error(AuthenticationError("no token"))
        assert code == 401

    def test_permission_error_returns_403(self):
        from security.permissions import PermissionError
        mw = self._mw()
        code, msg, typ = mw._classify_error(PermissionError("denied"))
        assert code == 403

    def test_rate_limit_exceeded_returns_429(self):
        from security.rate_limit import RateLimitExceeded
        mw = self._mw()
        code, msg, typ = mw._classify_error(RateLimitExceeded("slow", retry_after=10))
        assert code == 429

    def test_http_exception_uses_status_code(self):
        from fastapi import HTTPException
        mw = self._mw()
        exc = HTTPException(status_code=404, detail="not found")
        code, msg, typ = mw._classify_error(exc)
        assert code == 404

    def test_generic_error_sanitized(self):
        mw = self._mw(sanitize_errors=True)
        code, msg, typ = mw._classify_error(RuntimeError("internal stuff"))
        assert code == 500
        assert "internal stuff" not in msg
        assert "error occurred" in msg.lower()

    def test_generic_error_unsanitized(self):
        mw = self._mw(sanitize_errors=False)
        code, msg, typ = mw._classify_error(RuntimeError("raw message"))
        assert code == 500
        assert msg == "raw message"


# ---------------------------------------------------------------------------
# _build_error_response
# ---------------------------------------------------------------------------

class TestBuildErrorResponse:

    def _mw(self, **kwargs):
        app = MagicMock()
        return ErrorHandlerMiddleware(app, config=ErrorHandlerConfig(**kwargs))

    def test_basic_response_structure(self):
        mw = self._mw()
        resp = mw._build_error_response(400, "bad request", "ValueError")
        assert resp["error"]["code"] == 400
        assert resp["error"]["message"] == "bad request"
        assert resp["error"]["type"] == "ValueError"

    def test_hint_added_from_custom_messages(self):
        mw = self._mw()
        resp = mw._build_error_response(500, "fail", "RuntimeError")
        assert "hint" in resp["error"]
        assert resp["error"]["hint"] == "Internal server error"

    def test_no_hint_for_unknown_code(self):
        mw = self._mw(custom_error_messages={})
        resp = mw._build_error_response(599, "weird", "Error")
        assert "hint" not in resp["error"]

    def test_traceback_included_when_configured(self):
        mw = self._mw(include_traceback=True)
        try:
            raise ValueError("test")
        except ValueError as e:
            resp = mw._build_error_response(500, "fail", "ValueError", error=e)
        assert "traceback" in resp["error"]
        assert any("ValueError" in line for line in resp["error"]["traceback"])

    def test_traceback_excluded_when_no_error(self):
        mw = self._mw(include_traceback=True)
        resp = mw._build_error_response(500, "fail", "RuntimeError", error=None)
        assert "traceback" not in resp["error"]


# ---------------------------------------------------------------------------
# _log_error — all severity levels
# ---------------------------------------------------------------------------

class TestLogError:

    def _mw(self):
        app = MagicMock()
        return ErrorHandlerMiddleware(app, config=ErrorHandlerConfig(log_errors=True))

    def test_500_logs_error(self):
        mw = self._mw()
        with patch("api.middleware.error_handler.logger") as mock_logger:
            mw._log_error(_make_request(), RuntimeError("boom"), 500)
            mock_logger.error.assert_called_once()

    def test_400_logs_warning(self):
        mw = self._mw()
        with patch("api.middleware.error_handler.logger") as mock_logger:
            mw._log_error(_make_request(), ValueError("bad"), 400)
            mock_logger.warning.assert_called_once()

    def test_300_logs_info(self):
        mw = self._mw()
        with patch("api.middleware.error_handler.logger") as mock_logger:
            mw._log_error(_make_request(), Exception("redirect"), 301)
            mock_logger.info.assert_called_once()

    def test_no_client_uses_unknown(self):
        mw = self._mw()
        req = _make_request()
        req.client = None
        with patch("api.middleware.error_handler.logger"):
            # Should not raise
            mw._log_error(req, RuntimeError("x"), 500)


# ---------------------------------------------------------------------------
# Full dispatch — logging disabled
# ---------------------------------------------------------------------------

class TestDispatchLoggingDisabled:

    @pytest.mark.asyncio
    async def test_error_without_logging(self):
        app = MagicMock()
        cfg = ErrorHandlerConfig(log_errors=False)
        mw = ErrorHandlerMiddleware(app, config=cfg)
        call_next = AsyncMock(side_effect=RuntimeError("oops"))

        with patch("api.middleware.error_handler.logger") as mock_logger:
            result = await mw.dispatch(_make_request(), call_next)
            assert result.status_code == 500
            mock_logger.error.assert_not_called()
            mock_logger.warning.assert_not_called()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

class TestFactory:

    def test_development_factory(self):
        cls, kwargs = create_error_handler_middleware(development=True)
        assert cls is ErrorHandlerMiddleware
        config = kwargs["config"]
        assert config.include_traceback is True
        assert config.sanitize_errors is False

    def test_production_factory(self):
        cls, kwargs = create_error_handler_middleware(development=False)
        config = kwargs["config"]
        assert config.include_traceback is False
        assert config.sanitize_errors is True
