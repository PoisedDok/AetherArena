"""
Authentication Middleware - API Layer

Performs auth gating for non-public endpoints, while allowing upstream middleware
(CORS, security headers, error handling, request context cleanup) to run deterministically.

@.architecture
Incoming: app.py::create_app, api/dependencies.py::require_auth_context, HTTP requests --- {Request, Settings}
Processing: skip public paths and OPTIONS, enforce require_auth_context --- {JOB_AUTHORIZE}
Outgoing: downstream handlers or HTTPException(401) --- {Response, exception}
"""

import logging
from fnmatch import fnmatch
from typing import Callable, Sequence

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)


class AuthenticationMiddleware(BaseHTTPMiddleware):
    """
    Enforce authentication for non-public paths.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        enabled: bool,
        public_patterns: Sequence[str],
        settings,
    ):
        super().__init__(app)
        self._enabled = bool(enabled)
        self._public_patterns = tuple(public_patterns or ())
        self._settings = settings
        logger.info("Authentication middleware initialized (enabled=%s)", self._enabled)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        if not self._enabled:
            return await call_next(request)

        if request.method == "OPTIONS":
            return await call_next(request)

        path = request.url.path
        if self._public_patterns and any(fnmatch(path, pattern) for pattern in self._public_patterns):
            return await call_next(request)

        from api.dependencies import require_auth_context

        await require_auth_context(request, settings=self._settings)
        return await call_next(request)


def create_authentication_middleware(*, enabled: bool, public_patterns: Sequence[str], settings):
    """
    Factory for FastAPI add_middleware usage.
    """
    return (
        AuthenticationMiddleware,
        {"enabled": enabled, "public_patterns": public_patterns, "settings": settings},
    )

