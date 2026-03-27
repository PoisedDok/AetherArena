"""
Redis Session Context

Structured key building and availability guards around RedisCache with namespace scoping.
Provides request-scoped metadata propagation for rate limiting, presence tracking, etc.

@.architecture
Incoming: api/dependencies.py, data/cache/__init__.py --- {RedisCache instance, request_id, correlation_id}
Processing: namespaced_key(), get(), set(), delete() --- {1 jobs: JOB_MANAGE_SESSIONS}
Outgoing: api/dependencies.py, middleware --- {RedisSessionContext, RedisRequestContext}
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Optional

from monitoring import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True)
class RedisRequestContext:
    """Immutable metadata propagated to Redis namespaces."""

    request_id: str
    correlation_id: Optional[str] = None
    session_id: Optional[str] = None
    user_id: Optional[str] = None
    extras: Dict[str, Any] = field(default_factory=dict)

    def to_attributes(self) -> Dict[str, Any]:
        attributes: Dict[str, Any] = {
            "request.id": self.request_id,
            "correlation.id": self.correlation_id,
            "session.id": self.session_id,
            "user.id": self.user_id,
        }
        attributes.update(self.extras or {})
        return {k: v for k, v in attributes.items() if v is not None}


class RedisSessionContext:
    """
    Adds structured key building and availability guards around RedisCache.

    The context does not mutate the underlying cache namespace; instead it
    prepends an additional prefix (e.g., `rate`, `presence`) before deferring
    to RedisCache's own namespace handling.
    """

    def __init__(
        self,
        cache: Optional[Any],
        *,
        namespace: str,
        context: RedisRequestContext,
    ) -> None:
        self._cache = cache
        self._local_namespace = namespace.strip(":") if namespace else "runtime"
        self.context = context

    def is_available(self) -> bool:
        return bool(self._cache and getattr(self._cache, "is_connected", lambda: False)())

    def namespaced_key(self, *segments: str) -> str:
        cleaned: Iterable[str] = [
            self._local_namespace,
            *((segment or "").strip(":") for segment in segments if segment),
        ]
        return ":".join(filter(None, cleaned))

    async def set(self, key: str, value: Any, ttl: Optional[int] = None) -> bool:
        if not self.is_available():
            return False
        namespaced = self.namespaced_key(key)
        return await self._cache.set(namespaced, value, ttl=ttl)

    async def get(self, key: str) -> Optional[Any]:
        if not self.is_available():
            return None
        namespaced = self.namespaced_key(key)
        return await self._cache.get(namespaced)

    async def delete(self, key: str) -> bool:
        if not self.is_available():
            return False
        namespaced = self.namespaced_key(key)
        return await self._cache.delete(namespaced)

    async def increment(self, key: str, amount: int = 1, ttl: Optional[int] = None) -> Optional[int]:
        if not self.is_available():
            return None
        namespaced = self.namespaced_key(key)
        return await self._cache.increment(namespaced, amount=amount, ttl=ttl)

    @property
    def cache(self) -> Optional[Any]:
        return self._cache

