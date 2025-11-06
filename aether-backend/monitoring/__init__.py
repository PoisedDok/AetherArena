"""
Monitoring & Observability Layer - Production-Ready Monitoring Framework

Provides comprehensive monitoring and observability for the Aether backend including:
- Structured logging (JSON formatting, context injection)
- Metrics collection (Prometheus-compatible counters, gauges, histograms)
- Health checks (system, runtime, integrations, database, MCP)
- Distributed tracing (OpenTelemetry-compatible)

All modules follow production best practices and are fully configurable.
"""

# Logging
from .logging import (
    JSONFormatter,
    ContextFilter,
    StructuredLogger,
    configure_logging,
    configure_from_preset,
    get_logger,
    set_request_context,
    clear_request_context,
    get_request_id,
    get_user_id,
    get_session_id,
    LOGGING_PRESETS,
)

# Metrics
from .metrics import (
    MetricType,
    Metric,
    Counter,
    Gauge,
    Histogram,
    MetricsRegistry,
    get_registry,
    counter,
    gauge,
    histogram,
    setup_standard_metrics,
)

# Health checks
from .health import (
    HealthStatus,
    HealthCheckResult,
    HealthChecker,
    RuntimeHealthChecker,
    IntegrationHealthChecker,
    DatabaseHealthChecker,
    MCPHealthChecker,
    get_health_checker,
    initialize_health_checks,
)

# Tracing
from .tracing import (
    SpanKind,
    SpanStatus,
    Span,
    Tracer,
    SpanContext,
    trace,
    get_tracer,
    get_current_span,
    get_trace_id,
    set_trace_id,
    clear_trace_context,
    export_traces_json,
)

__all__ = [
    # Logging
    'JSONFormatter',
    'ContextFilter',
    'StructuredLogger',
    'configure_logging',
    'configure_from_preset',
    'get_logger',
    'set_request_context',
    'clear_request_context',
    'get_request_id',
    'get_user_id',
    'get_session_id',
    'LOGGING_PRESETS',
    
    # Metrics
    'MetricType',
    'Metric',
    'Counter',
    'Gauge',
    'Histogram',
    'MetricsRegistry',
    'get_registry',
    'counter',
    'gauge',
    'histogram',
    'setup_standard_metrics',
    
    # Health
    'HealthStatus',
    'HealthCheckResult',
    'HealthChecker',
    'RuntimeHealthChecker',
    'IntegrationHealthChecker',
    'DatabaseHealthChecker',
    'MCPHealthChecker',
    'get_health_checker',
    'initialize_health_checks',
    
    # Tracing
    'SpanKind',
    'SpanStatus',
    'Span',
    'Tracer',
    'SpanContext',
    'trace',
    'get_tracer',
    'get_current_span',
    'get_trace_id',
    'set_trace_id',
    'clear_trace_context',
    'export_traces_json',
]

