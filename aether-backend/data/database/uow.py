"""
Supabase Unit of Work

Lightweight UoW wrapper attaching request metadata and tracing spans to persistence operations.
Provides context propagation, child UoW creation, and observability hooks.

@.architecture
Incoming: api/dependencies.py, application/chat/service.py --- {SupabasePersistenceGateway, SupabaseRequestContext}
Processing: __aenter__(), __aexit__(), child(), to_attributes() --- {2 jobs: JOB_ORCHESTRATE, JOB_TRACE}
Outgoing: data/database/repositories/chat.py, monitoring/tracing.py --- {SupabaseUnitOfWork, span attributes}
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from data.database.persistence_gateway import SupabasePersistenceGateway
from monitoring import get_logger, get_tracer, SpanKind

logger = get_logger(__name__)


@dataclass(frozen=True)
class SupabaseRequestContext:
    """Immutable request-scoped metadata propagated to Supabase operations."""

    request_id: str
    correlation_id: Optional[str] = None
    session_id: Optional[str] = None
    user_id: Optional[str] = None
    actor_id: Optional[str] = None
    extras: Dict[str, Any] = field(default_factory=dict)

    def to_attributes(self) -> Dict[str, Any]:
        """Return tracing-friendly attribute map."""
        attributes: Dict[str, Any] = {
            "request.id": self.request_id,
            "correlation.id": self.correlation_id,
            "session.id": self.session_id,
            "user.id": self.user_id,
            "actor.id": self.actor_id,
        }
        attributes.update(self.extras or {})
        return {k: v for k, v in attributes.items() if v is not None}

    def with_extras(self, **extras: Any) -> "SupabaseRequestContext":
        """Return a cloned context with merged extras."""
        merged = dict(self.extras or {})
        for key, value in extras.items():
            if value is not None:
                merged[key] = value
        return SupabaseRequestContext(
            request_id=self.request_id,
            correlation_id=self.correlation_id,
            session_id=self.session_id,
            user_id=self.user_id,
            actor_id=self.actor_id,
            extras=merged,
        )


class SupabaseUnitOfWork:
    """
    Lightweight unit-of-work wrapper that ties Supabase persistence to request metadata.

    - Provides consistent tracing spans around repository operations.
    - Exposes accessor for the underlying `SupabasePersistenceGateway`.
    - Allows downstream layers to clone contexts without mutating global state.
    """

    def __init__(
        self,
        gateway: SupabasePersistenceGateway,
        context: SupabaseRequestContext,
        span_name: str = "supabase.uow",
    ) -> None:
        if gateway is None:
            raise ValueError("SupabaseUnitOfWork requires a persistence gateway instance")
        self._gateway = gateway
        self.context = context
        self._span_name = span_name
        self._span_ctx = None
        self._tracer = get_tracer()

    async def __aenter__(self) -> "SupabaseUnitOfWork":
        self._start_span()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self._finish_span(exc_type, exc, tb)

    async def close(self) -> None:
        """Explicitly finish the active span (useful from dependencies)."""
        await self.__aexit__(None, None, None)

    @property
    def gateway(self) -> SupabasePersistenceGateway:
        """Expose raw persistence gateway."""
        return self._gateway

    def child(self, **extras: Any) -> "SupabaseUnitOfWork":
        """Create a child unit-of-work sharing the same gateway but extended metadata."""
        return SupabaseUnitOfWork(
            gateway=self._gateway,
            context=self.context.with_extras(**extras),
            span_name=self._span_name,
        )

    def _start_span(self) -> None:
        if self._tracer is None:
            return
        attributes = self.context.to_attributes()
        self._span_ctx = self._tracer.start_span(
            self._span_name,
            kind=SpanKind.INTERNAL,
            attributes=attributes,
        )
        self._span_ctx.__enter__()

    def _finish_span(self, exc_type, exc, tb) -> None:
        if not self._span_ctx:
            return
        try:
            self._span_ctx.__exit__(exc_type, exc, tb)
        except Exception as span_error:
            logger.warning("Failed to finish Supabase span: %s", span_error)
        finally:
            self._span_ctx = None


__all__ = ["SupabaseUnitOfWork", "SupabaseRequestContext"]
