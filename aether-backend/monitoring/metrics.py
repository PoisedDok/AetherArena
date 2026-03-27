"""
Metrics Collection - Monitoring Layer

@.architecture
Incoming: app.py, api/v1/endpoints/*.py, core runtime services --- {MetricRegistry, float sample}
Processing: register metric primitives, aggregate samples, export Prometheus payloads --- {JOB_METRIC}
Outgoing: monitoring endpoints, observability backends --- {Dict[str, Any], str prometheus_text}
"""

import threading
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, field
from enum import Enum
from collections import defaultdict


class MetricType(str, Enum):
    """Metric types following Prometheus conventions."""
    COUNTER = "counter"
    GAUGE = "gauge"
    HISTOGRAM = "histogram"
    SUMMARY = "summary"


@dataclass
class Metric:
    """Base metric metadata."""
    name: str
    help_text: str
    metric_type: MetricType
    labels: Dict[str, str] = field(default_factory=dict)


class Counter:
    """
    Counter metric - monotonically increasing value.
    
    Use for: request counts, error counts, bytes processed, etc.
    """
    
    def __init__(self, name: str, help_text: str, labels: Optional[List[str]] = None):
        """
        Initialize counter.
        
        Args:
            name: Metric name
            help_text: Description
            labels: Label names for metric dimensions
        """
        self.name = name
        self.help_text = help_text
        self.label_names = labels or []
        self._lock = threading.Lock()
        self._values: Dict[Tuple[str, ...], float] = defaultdict(float)
    
    def inc(self, value: float = 1.0, **labels: str) -> None:
        """
        Increment counter.
        
        Args:
            value: Amount to increment (must be >= 0)
            **labels: Label values
        """
        if value < 0:
            raise ValueError("Counter can only be incremented by non-negative values")
        
        label_values = self._validate_labels(labels)
        
        with self._lock:
            self._values[label_values] += value
    
    def get(self, **labels: str) -> float:
        """
        Get counter value.
        
        Args:
            **labels: Label values
            
        Returns:
            Current value
        """
        label_values = self._validate_labels(labels)
        return self._values.get(label_values, 0.0)
    
    def _validate_labels(self, labels: Dict[str, str]) -> Tuple[str, ...]:
        """Validate and order labels."""
        if set(labels.keys()) != set(self.label_names):
            raise ValueError(f"Expected labels {self.label_names}, got {list(labels.keys())}")
        return tuple(labels[name] for name in self.label_names)
    
    def collect(self) -> List[Tuple[Dict[str, str], float]]:
        """
        Collect all metric values for export.
        
        Returns:
            List of (label_dict, value) tuples
        """
        with self._lock:
            results = []
            for label_values, value in self._values.items():
                label_dict = dict(zip(self.label_names, label_values))
                results.append((label_dict, value))
            return results


class Gauge:
    """
    Gauge metric - can go up or down.
    
    Use for: current connections, memory usage, queue size, etc.
    """
    
    def __init__(self, name: str, help_text: str, labels: Optional[List[str]] = None):
        """
        Initialize gauge.
        
        Args:
            name: Metric name
            help_text: Description
            labels: Label names for metric dimensions
        """
        self.name = name
        self.help_text = help_text
        self.label_names = labels or []
        self._lock = threading.Lock()
        self._values: Dict[Tuple[str, ...], float] = defaultdict(float)
    
    def set(self, value: float, **labels: str) -> None:
        """
        Set gauge value.
        
        Args:
            value: New value
            **labels: Label values
        """
        label_values = self._validate_labels(labels)
        
        with self._lock:
            self._values[label_values] = value
    
    def inc(self, value: float = 1.0, **labels: str) -> None:
        """
        Increment gauge.
        
        Args:
            value: Amount to add
            **labels: Label values
        """
        label_values = self._validate_labels(labels)
        
        with self._lock:
            self._values[label_values] += value
    
    def dec(self, value: float = 1.0, **labels: str) -> None:
        """
        Decrement gauge.
        
        Args:
            value: Amount to subtract
            **labels: Label values
        """
        self.inc(-value, **labels)
    
    def get(self, **labels: str) -> float:
        """
        Get gauge value.
        
        Args:
            **labels: Label values
            
        Returns:
            Current value
        """
        label_values = self._validate_labels(labels)
        return self._values.get(label_values, 0.0)
    
    def _validate_labels(self, labels: Dict[str, str]) -> Tuple[str, ...]:
        """Validate and order labels."""
        if set(labels.keys()) != set(self.label_names):
            raise ValueError(f"Expected labels {self.label_names}, got {list(labels.keys())}")
        return tuple(labels[name] for name in self.label_names)
    
    def collect(self) -> List[Tuple[Dict[str, str], float]]:
        """
        Collect all metric values for export.
        
        Returns:
            List of (label_dict, value) tuples
        """
        with self._lock:
            results = []
            for label_values, value in self._values.items():
                label_dict = dict(zip(self.label_names, label_values))
                results.append((label_dict, value))
            return results


class Histogram:
    """
    Histogram metric - distribution of values into buckets.
    
    Use for: request duration, response size, etc.
    """
    
    # Default buckets for response time (seconds)
    DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0]
    
    def __init__(
        self,
        name: str,
        help_text: str,
        labels: Optional[List[str]] = None,
        buckets: Optional[List[float]] = None
    ):
        """
        Initialize histogram.
        
        Args:
            name: Metric name
            help_text: Description
            labels: Label names for metric dimensions
            buckets: Bucket boundaries (sorted)
        """
        self.name = name
        self.help_text = help_text
        self.label_names = labels or []
        self.buckets = sorted(buckets or self.DEFAULT_BUCKETS)
        self._lock = threading.RLock()  # RLock: collect() re-enters via get_stats()
        
        # Store bucket counts and sum/count
        self._bucket_counts: Dict[Tuple[str, ...], List[int]] = defaultdict(
            lambda: [0] * (len(self.buckets) + 1)
        )
        self._sum: Dict[Tuple[str, ...], float] = defaultdict(float)
        self._count: Dict[Tuple[str, ...], int] = defaultdict(int)
    
    def observe(self, value: float, **labels: str) -> None:
        """
        Observe a value.
        
        Args:
            value: Value to observe
            **labels: Label values
        """
        label_values = self._validate_labels(labels)
        
        with self._lock:
            # Update sum and count
            self._sum[label_values] += value
            self._count[label_values] += 1
            
            # Update buckets
            bucket_counts = self._bucket_counts[label_values]
            for i, bucket in enumerate(self.buckets):
                if value <= bucket:
                    bucket_counts[i] += 1
            # +Inf bucket
            bucket_counts[-1] += 1
    
    def get_stats(self, **labels: str) -> Dict[str, Any]:
        """
        Get histogram statistics.
        
        Args:
            **labels: Label values
            
        Returns:
            Dict with count, sum, average, buckets
        """
        label_values = self._validate_labels(labels)
        
        with self._lock:
            count = self._count.get(label_values, 0)
            sum_value = self._sum.get(label_values, 0.0)
            avg = sum_value / count if count > 0 else 0.0
            
            bucket_counts = self._bucket_counts.get(label_values, [0] * (len(self.buckets) + 1))
            
            return {
                'count': count,
                'sum': sum_value,
                'average': avg,
                'buckets': dict(zip(
                    [*self.buckets, float('inf')],
                    bucket_counts
                ))
            }
    
    def _validate_labels(self, labels: Dict[str, str]) -> Tuple[str, ...]:
        """Validate and order labels."""
        if set(labels.keys()) != set(self.label_names):
            raise ValueError(f"Expected labels {self.label_names}, got {list(labels.keys())}")
        return tuple(labels[name] for name in self.label_names)
    
    def collect(self) -> List[Tuple[Dict[str, str], Dict[str, Any]]]:
        """
        Collect all histogram data for export.
        
        Returns:
            List of (label_dict, stats_dict) tuples
        """
        with self._lock:
            results = []
            for label_values in self._count.keys():
                label_dict = dict(zip(self.label_names, label_values))
                stats = self.get_stats(**label_dict)
                results.append((label_dict, stats))
            return results


class MetricsRegistry:
    """
    Central registry for all metrics.
    
    Manages metric creation and collection for export.
    """
    
    def __init__(self):
        """Initialize metrics registry."""
        self._lock = threading.Lock()
        self._counters: Dict[str, Counter] = {}
        self._gauges: Dict[str, Gauge] = {}
        self._histograms: Dict[str, Histogram] = {}
    
    def counter(
        self,
        name: str,
        help_text: str,
        labels: Optional[List[str]] = None
    ) -> Counter:
        """
        Get or create counter metric.
        
        Args:
            name: Metric name
            help_text: Description
            labels: Label names
            
        Returns:
            Counter instance
        """
        with self._lock:
            if name not in self._counters:
                self._counters[name] = Counter(name, help_text, labels)
            return self._counters[name]
    
    def gauge(
        self,
        name: str,
        help_text: str,
        labels: Optional[List[str]] = None
    ) -> Gauge:
        """
        Get or create gauge metric.
        
        Args:
            name: Metric name
            help_text: Description
            labels: Label names
            
        Returns:
            Gauge instance
        """
        with self._lock:
            if name not in self._gauges:
                self._gauges[name] = Gauge(name, help_text, labels)
            return self._gauges[name]
    
    def histogram(
        self,
        name: str,
        help_text: str,
        labels: Optional[List[str]] = None,
        buckets: Optional[List[float]] = None
    ) -> Histogram:
        """
        Get or create histogram metric.
        
        Args:
            name: Metric name
            help_text: Description
            labels: Label names
            buckets: Bucket boundaries
            
        Returns:
            Histogram instance
        """
        with self._lock:
            if name not in self._histograms:
                self._histograms[name] = Histogram(name, help_text, labels, buckets)
            return self._histograms[name]
    
    def collect_all(self) -> Dict[str, Any]:
        """
        Collect all metrics for export.
        
        Thread-safe: snapshots metric dicts under lock before iterating.
        
        Returns:
            Dict mapping metric names to their values
        """
        # Snapshot under lock to prevent RuntimeError from concurrent dict modification
        with self._lock:
            counters = dict(self._counters)
            gauges = dict(self._gauges)
            histograms = dict(self._histograms)
        
        result = {}
        
        # Iterate snapshots (each metric's collect() has its own lock)
        for name, counter in counters.items():
            result[name] = {
                'type': 'counter',
                'help': counter.help_text,
                'values': counter.collect()
            }
        
        for name, gauge in gauges.items():
            result[name] = {
                'type': 'gauge',
                'help': gauge.help_text,
                'values': gauge.collect()
            }
        
        for name, histogram in histograms.items():
            result[name] = {
                'type': 'histogram',
                'help': histogram.help_text,
                'buckets': histogram.buckets,
                'values': histogram.collect()
            }
        
        return result
    
    def export_prometheus(self) -> str:
        """
        Export metrics in Prometheus text format.
        
        Thread-safe: snapshots metric dicts under lock before iterating.
        
        Returns:
            Prometheus-formatted metrics string
        """
        # Snapshot under lock to prevent RuntimeError from concurrent dict modification
        with self._lock:
            counters = dict(self._counters)
            gauges = dict(self._gauges)
            histograms = dict(self._histograms)
        
        lines = []
        
        # Export counters
        for name, counter in counters.items():
            lines.append(f"# HELP {name} {counter.help_text}")
            lines.append(f"# TYPE {name} counter")
            for label_dict, value in counter.collect():
                label_str = self._format_labels(label_dict)
                lines.append(f"{name}{label_str} {value}")
        
        # Export gauges
        for name, gauge in gauges.items():
            lines.append(f"# HELP {name} {gauge.help_text}")
            lines.append(f"# TYPE {name} gauge")
            for label_dict, value in gauge.collect():
                label_str = self._format_labels(label_dict)
                lines.append(f"{name}{label_str} {value}")
        
        # Export histograms
        for name, histogram in histograms.items():
            lines.append(f"# HELP {name} {histogram.help_text}")
            lines.append(f"# TYPE {name} histogram")
            for label_dict, stats in histogram.collect():
                label_str = self._format_labels(label_dict)
                # Export buckets
                for bucket, count in stats['buckets'].items():
                    bucket_label = dict(label_dict, le=str(bucket))
                    bucket_str = self._format_labels(bucket_label)
                    lines.append(f"{name}_bucket{bucket_str} {count}")
                # Export sum and count
                lines.append(f"{name}_sum{label_str} {stats['sum']}")
                lines.append(f"{name}_count{label_str} {stats['count']}")
        
        return '\n'.join(lines) + '\n'
    
    def _format_labels(self, labels: Dict[str, str]) -> str:
        """Format labels for Prometheus output."""
        if not labels:
            return ""
        label_pairs = [f'{k}="{v}"' for k, v in labels.items()]
        return "{" + ",".join(label_pairs) + "}"


# Global registry instance
_global_registry: Optional[MetricsRegistry] = None


def get_registry() -> MetricsRegistry:
    """
    Get global metrics registry.
    
    Returns:
        MetricsRegistry instance
    """
    global _global_registry
    if _global_registry is None:
        _global_registry = MetricsRegistry()
    return _global_registry


# Convenience functions for common metrics
def counter(name: str, help_text: str, labels: Optional[List[str]] = None) -> Counter:
    """Get or create counter from global registry."""
    return get_registry().counter(name, help_text, labels)


def gauge(name: str, help_text: str, labels: Optional[List[str]] = None) -> Gauge:
    """Get or create gauge from global registry."""
    return get_registry().gauge(name, help_text, labels)


def histogram(
    name: str,
    help_text: str,
    labels: Optional[List[str]] = None,
    buckets: Optional[List[float]] = None
) -> Histogram:
    """Get or create histogram from global registry."""
    return get_registry().histogram(name, help_text, labels, buckets)


# Standard application metrics
def setup_standard_metrics() -> Dict[str, Any]:
    """
    Create standard application metrics.
    
    Returns:
        Dict of metric objects
    """
    registry = get_registry()
    
    return {
        # HTTP metrics
        'http_requests_total': registry.counter(
            'aether_http_requests_total',
            'Total HTTP requests',
            labels=['method', 'endpoint', 'status_code']
        ),
        'http_request_duration_seconds': registry.histogram(
            'aether_http_request_duration_seconds',
            'HTTP request duration in seconds',
            labels=['method', 'endpoint']
        ),
        'http_request_size_bytes': registry.histogram(
            'aether_http_request_size_bytes',
            'HTTP request size in bytes',
            labels=['method', 'endpoint'],
            buckets=[100, 1000, 10000, 100000, 1000000, 10000000]
        ),
        'http_response_size_bytes': registry.histogram(
            'aether_http_response_size_bytes',
            'HTTP response size in bytes',
            labels=['method', 'endpoint'],
            buckets=[100, 1000, 10000, 100000, 1000000, 10000000]
        ),
        
        # Chat metrics
        'chat_messages_total': registry.counter(
            'aether_chat_messages_total',
            'Total chat messages processed',
            labels=['type', 'status']
        ),
        'chat_tokens_total': registry.counter(
            'aether_chat_tokens_total',
            'Total tokens processed',
            labels=['type']
        ),
        'chat_duration_seconds': registry.histogram(
            'aether_chat_duration_seconds',
            'Chat response duration in seconds'
        ),
        
        # Integration metrics
        'integration_calls_total': registry.counter(
            'aether_integration_calls_total',
            'Total integration calls',
            labels=['integration', 'status']
        ),
        'integration_duration_seconds': registry.histogram(
            'aether_integration_duration_seconds',
            'Integration call duration in seconds',
            labels=['integration']
        ),
        
        # MCP metrics
        'mcp_servers_active': registry.gauge(
            'aether_mcp_servers_active',
            'Number of active MCP servers'
        ),
        'mcp_tool_executions_total': registry.counter(
            'aether_mcp_tool_executions_total',
            'Total MCP tool executions',
            labels=['server', 'tool', 'status']
        ),
        'mcp_execution_duration_seconds': registry.histogram(
            'aether_mcp_execution_duration_seconds',
            'MCP tool execution duration in seconds',
            labels=['server', 'tool']
        ),
        
        # System metrics
        'runtime_errors_total': registry.counter(
            'aether_runtime_errors_total',
            'Total runtime errors',
            labels=['component', 'error_type']
        ),
        'active_connections': registry.gauge(
            'aether_active_connections',
            'Number of active connections',
            labels=['type']
        ),
        'database_queries_total': registry.counter(
            'aether_database_queries_total',
            'Total database queries',
            labels=['operation', 'status']
        ),
        'database_query_duration_seconds': registry.histogram(
            'aether_database_query_duration_seconds',
            'Database query duration in seconds',
            labels=['operation']
        ),
        
        # TTS / Handsfree metrics
        'tts_synthesis_duration_seconds': registry.histogram(
            'aether_tts_synthesis_duration_seconds',
            'TTS synthesis duration per sentence (seconds)',
            labels=['engine', 'voice'],
            buckets=[0.5, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0, 15.0, 30.0, 60.0]
        ),
        'tts_synthesis_total': registry.counter(
            'aether_tts_synthesis_total',
            'Total TTS synthesis operations',
            labels=['engine', 'voice', 'status']
        ),
        'tts_model_load_duration_seconds': registry.histogram(
            'aether_tts_model_load_duration_seconds',
            'TTS model load/preload duration (seconds)',
            labels=['engine'],
            buckets=[1.0, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0]
        ),
        'tts_audio_duration_seconds': registry.histogram(
            'aether_tts_audio_duration_seconds',
            'Generated audio duration per sentence (seconds)',
            labels=['engine', 'voice'],
            buckets=[0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 15.0, 30.0]
        ),
        'tts_engine_switches_total': registry.counter(
            'aether_tts_engine_switches_total',
            'Total TTS engine switch events',
            labels=['from_engine', 'to_engine']
        ),
        'tts_queue_overflow_total': registry.counter(
            'aether_tts_queue_overflow_total',
            'Total TTS queue overflow events (sentences lost)',
            labels=['client_id_prefix']
        ),
        'handsfree_sessions_total': registry.counter(
            'aether_handsfree_sessions_total',
            'Total handsfree mode activations',
            labels=['action']
        ),
        'stt_transcriptions_total': registry.counter(
            'aether_stt_transcriptions_total',
            'Total STT transcriptions completed',
            labels=['model', 'device']
        ),
        
        # Contract enforcement and reliability
        'artifact_link_events_total': registry.counter(
            'aether_artifact_link_events_total',
            'Artifact link events (success/failure)',
            labels=['result']
        ),
        'websocket_reconnects_total': registry.counter(
            'aether_websocket_reconnects_total',
            'WebSocket reconnect events',
            labels=['reason']
        ),
        'send_validation_failures_total': registry.counter(
            'aether_send_validation_failures_total',
            'User send validation failures',
            labels=['rule']
        ),
    }

