"""
Request Context Lifecycle Middleware - API Layer

Guarantees request-scoped logging context is always cleared, even when inner middleware
raises (auth failures, rate limits, etc).

@.architecture
Incoming: app.py::create_app, api/dependencies.py, HTTP requests --- {Request, call_next}
Processing: always-run finally cleanup_request_context() --- {JOB_TRACE}
Outgoing: monitoring/logging.py --- {cleared contextvars}
"""

import logging
from typing import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)


class RequestContextLifecycleMiddleware(BaseHTTPMiddleware):
    """
    Ensure request-scoped contextvars are always cleared.

    Note: This middleware intentionally does NOT set up request context; that is handled
    by dependencies where required. It only guarantees cleanup to prevent cross-request
    contamination under concurrency.
    """

    def __init__(self, app: ASGIApp):
        super().__init__(app)
        logger.debug("Request context lifecycle middleware initialized")

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        from api.dependencies import cleanup_request_context

        try:
            return await call_next(request)
        finally:
            try:
                await cleanup_request_context()
            except Exception:
                # FAIL_FAST: cleanup must never break the request path; log and continue.
                logger.debug("Failed to cleanup request context", exc_info=True)


def create_request_context_lifecycle_middleware():
    """
    Factory for FastAPI add_middleware usage.
    """
    return (RequestContextLifecycleMiddleware, {})

