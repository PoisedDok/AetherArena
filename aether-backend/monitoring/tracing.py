"""
Distributed Tracing - Monitoring Layer

Provides OpenTelemetry-compatible distributed tracing for:
- Request lifecycle tracking
- Cross-service correlation
- Performance profiling
- Error tracking

Optional: Can be enabled in production for detailed observability.

@.architecture
Incoming: app.py, @trace decorated functions, api/dependencies.py --- {str trace_id, str span_name, SpanKind enum, Dict[str, Any] attributes}
Processing: create_span(), start_span(), SpanContext.__enter__/__exit__(), trace(), export_traces_json() --- {5 jobs: context_management, span_creation, span_recording, trace_export, tracing}
Outgoing: Future observability backends, Decorated functions --- {Span, SpanContext, list[Dict[str, Any]] trace data, trace_id context var}
"""

import time
import functools
from typing import Any, Callable, Optional, Dict
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
import uuid


class SpanKind(str, Enum):
    """Span kinds following OpenTelemetry conventions."""
    INTERNAL = "internal"
    SERVER = "server"
    CLIENT = "client"
    PRODUCER = "producer"
    CONSUMER = "consumer"


class SpanStatus(str, Enum):
    """Span status."""
    OK = "ok"
    ERROR = "error"
    UNSET = "unset"


@dataclass
class Span:
    """
    Trace span representing a single operation.
    
    Attributes:
        trace_id: Unique trace identifier
        span_id: Unique span identifier
        parent_span_id: Parent span identifier
        name: Operation name
        kind: Span kind
        start_time: Start timestamp
        end_time: End timestamp
        duration_ms: Duration in milliseconds
        status: Span status
        attributes: Span attributes (tags)
        events: Span events (logs within span)
    """
    trace_id: str
    span_id: str
    parent_span_id: Optional[str]
    name: str
    kind: SpanKind = SpanKind.INTERNAL
    start_time: float = field(default_factory=time.time)
    end_time: Optional[float] = None
    duration_ms: Optional[float] = None
    status: SpanStatus = SpanStatus.UNSET
    attributes: Dict[str, Any] = field(default_factory=dict)
    events: list = field(default_factory=list)
    
    def set_attribute(self, key: str, value: Any) -> None:
        """Set span attribute."""
        self.attributes[key] = value
    
    def add_event(self, name: str, attributes: Optional[Dict[str, Any]] = None) -> None:
        """Add event to span."""
        self.events.append({
            'name': name,
            'timestamp': time.time(),
            'attributes': attributes or {}
        })
    
    def set_status(self, status: SpanStatus, description: Optional[str] = None) -> None:
        """Set span status."""
        self.status = status
        if description:
            self.attributes['status_description'] = description
    
    def finish(self) -> None:
        """Finish span and calculate duration."""
        if self.end_time is None:
            self.end_time = time.time()
            self.duration_ms = (self.end_time - self.start_time) * 1000


# Context variable for current span
current_span_ctx: ContextVar[Optional[Span]] = ContextVar('current_span', default=None)
trace_id_ctx: ContextVar[Optional[str]] = ContextVar('trace_id', default=None)


class Tracer:
    """
    Lightweight tracer for distributed tracing.
    
    Provides context managers and decorators for tracing operations.
    """
    
    def __init__(self, service_name: str = "aether-backend"):
        """
        Initialize tracer.
        
        Args:
            service_name: Service name for traces
        """
        self.service_name = service_name
        self._spans: list[Span] = []
        self._enabled = True
    
    def create_span(
        self,
        name: str,
        kind: SpanKind = SpanKind.INTERNAL,
        attributes: Optional[Dict[str, Any]] = None
    ) -> Span:
        """
        Create new span.
        
        Args:
            name: Span name
            kind: Span kind
            attributes: Initial attributes
            
        Returns:
            Span instance
        """
        # Get or create trace ID
        trace_id = trace_id_ctx.get()
        if trace_id is None:
            trace_id = self._generate_trace_id()
            trace_id_ctx.set(trace_id)
        
        # Get parent span if exists
        parent_span = current_span_ctx.get()
        parent_span_id = parent_span.span_id if parent_span else None
        
        # Create span
        span = Span(
            trace_id=trace_id,
            span_id=self._generate_span_id(),
            parent_span_id=parent_span_id,
            name=name,
            kind=kind,
            attributes=attributes or {}
        )
        
        # Add service name
        span.set_attribute('service.name', self.service_name)
        
        return span
    
    def start_span(
        self,
        name: str,
        kind: SpanKind = SpanKind.INTERNAL,
        attributes: Optional[Dict[str, Any]] = None
    ) -> 'SpanContext':
        """
        Start new span as context manager.
        
        Args:
            name: Span name
            kind: Span kind
            attributes: Initial attributes
            
        Returns:
            SpanContext
        """
        span = self.create_span(name, kind, attributes)
        return SpanContext(span, self)
    
    def _record_span(self, span: Span) -> None:
        """Record completed span."""
        if self._enabled:
            self._spans.append(span)
    
    def get_spans(self, trace_id: Optional[str] = None) -> list[Span]:
        """
        Get recorded spans.
        
        Args:
            trace_id: Filter by trace ID
            
        Returns:
            List of spans
        """
        if trace_id:
            return [s for s in self._spans if s.trace_id == trace_id]
        return self._spans.copy()
    
    def clear_spans(self) -> None:
        """Clear recorded spans."""
        self._spans.clear()
    
    def enable(self) -> None:
        """Enable tracing."""
        self._enabled = True
    
    def disable(self) -> None:
        """Disable tracing."""
        self._enabled = False
    
    def is_enabled(self) -> bool:
        """Check if tracing is enabled."""
        return self._enabled
    
    @staticmethod
    def _generate_trace_id() -> str:
        """Generate unique trace ID."""
        return uuid.uuid4().hex
    
    @staticmethod
    def _generate_span_id() -> str:
        """Generate unique span ID."""
        return uuid.uuid4().hex[:16]


class SpanContext:
    """
    Context manager for spans.
    
    Automatically finishes span and handles errors.
    """
    
    def __init__(self, span: Span, tracer: Tracer):
        """
        Initialize span context.
        
        Args:
            span: Span to manage
            tracer: Tracer instance
        """
        self.span = span
        self.tracer = tracer
        self._token = None
    
    def __enter__(self) -> Span:
        """Enter context and set current span."""
        self._token = current_span_ctx.set(self.span)
        return self.span
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Exit context and finish span."""
        if exc_type is not None:
            # Record error
            self.span.set_status(SpanStatus.ERROR, str(exc_val))
            self.span.add_event('exception', {
                'exception.type': exc_type.__name__,
                'exception.message': str(exc_val)
            })
        else:
            self.span.set_status(SpanStatus.OK)
        
        self.span.finish()
        self.tracer._record_span(self.span)
        
        # Reset context
        if self._token:
            current_span_ctx.reset(self._token)
        
        # Don't suppress exception
        return False


def trace(
    name: Optional[str] = None,
    kind: SpanKind = SpanKind.INTERNAL,
    attributes: Optional[Dict[str, Any]] = None
):
    """
    Decorator to trace function execution.
    
    Args:
        name: Span name (defaults to function name)
        kind: Span kind
        attributes: Initial attributes
        
    Returns:
        Decorated function
    """
    def decorator(func: Callable) -> Callable:
        span_name = name or f"{func.__module__}.{func.__name__}"
        
        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            tracer = get_tracer()
            with tracer.start_span(span_name, kind, attributes) as span:
                # Add function info
                span.set_attribute('code.function', func.__name__)
                span.set_attribute('code.namespace', func.__module__)
                
                result = func(*args, **kwargs)
                return result
        
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            tracer = get_tracer()
            with tracer.start_span(span_name, kind, attributes) as span:
                # Add function info
                span.set_attribute('code.function', func.__name__)
                span.set_attribute('code.namespace', func.__module__)
                
                result = await func(*args, **kwargs)
                return result
        
        # Return appropriate wrapper
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper
    
    return decorator


# Global tracer instance
_global_tracer: Optional[Tracer] = None


def get_tracer(service_name: str = "aether-backend") -> Tracer:
    """
    Get global tracer.
    
    Args:
        service_name: Service name
        
    Returns:
        Tracer instance
    """
    global _global_tracer
    if _global_tracer is None:
        _global_tracer = Tracer(service_name)
    return _global_tracer


def get_current_span() -> Optional[Span]:
    """
    Get current span from context.
    
    Returns:
        Current span or None
    """
    return current_span_ctx.get()


def get_trace_id() -> Optional[str]:
    """
    Get current trace ID from context.
    
    Returns:
        Trace ID or None
    """
    return trace_id_ctx.get()


def set_trace_id(trace_id: str) -> None:
    """
    Set trace ID in context.
    
    Args:
        trace_id: Trace identifier
    """
    trace_id_ctx.set(trace_id)


def clear_trace_context() -> None:
    """Clear trace context."""
    current_span_ctx.set(None)
    trace_id_ctx.set(None)


def export_traces_json(spans: list[Span]) -> list[Dict[str, Any]]:
    """
    Export spans in JSON format.
    
    Args:
        spans: List of spans to export
        
    Returns:
        List of span dicts
    """
    return [
        {
            'traceId': span.trace_id,
            'spanId': span.span_id,
            'parentSpanId': span.parent_span_id,
            'name': span.name,
            'kind': span.kind.value,
            'startTime': datetime.fromtimestamp(span.start_time).isoformat() + 'Z',
            'endTime': datetime.fromtimestamp(span.end_time).isoformat() + 'Z' if span.end_time else None,
            'durationMs': span.duration_ms,
            'status': span.status.value,
            'attributes': span.attributes,
            'events': span.events
        }
        for span in spans
    ]

