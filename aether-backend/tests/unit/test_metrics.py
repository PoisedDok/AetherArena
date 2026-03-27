"""
Unit Tests: Metrics — monitoring/metrics.py

Comprehensive coverage of Counter, Gauge, Histogram, MetricsRegistry,
Prometheus export, and standard metrics setup.

Coverage targets: monitoring/metrics.py lines 66, 89, 99-104, 150-153, 163,
181, 191-196, 271-280, 293, 303-309, 401-428, 437-470, 474-477, 505, 526-528.
"""

import threading
import pytest

from monitoring.metrics import (
    Counter,
    Gauge,
    Histogram,
    MetricsRegistry,
    get_registry,
    counter as global_counter,
    gauge as global_gauge,
    histogram as global_histogram,
    setup_standard_metrics,
)


# =============================================================================
# Counter
# =============================================================================


class TestCounter:

    def test_inc_default(self):
        c = Counter("req_total", "Total requests")
        c.inc()
        assert c.get() == 1.0

    def test_inc_custom_value(self):
        c = Counter("bytes_total", "Total bytes")
        c.inc(42.5)
        assert c.get() == 42.5

    def test_inc_multiple(self):
        c = Counter("ops", "Operations")
        c.inc(3.0)
        c.inc(7.0)
        assert c.get() == 10.0

    def test_inc_negative_raises(self):
        c = Counter("bad", "Should fail")
        with pytest.raises(ValueError, match="non-negative"):
            c.inc(-1.0)

    def test_inc_with_labels(self):
        c = Counter("http_total", "HTTP requests", labels=["method", "status"])
        c.inc(method="GET", status="200")
        c.inc(method="GET", status="200")
        c.inc(method="POST", status="201")

        assert c.get(method="GET", status="200") == 2.0
        assert c.get(method="POST", status="201") == 1.0
        assert c.get(method="DELETE", status="404") == 0.0

    def test_label_validation_wrong_labels(self):
        c = Counter("x", "x", labels=["a", "b"])
        with pytest.raises(ValueError, match="Expected labels"):
            c.inc(a="1")  # missing b

    def test_label_validation_extra_labels(self):
        c = Counter("x", "x", labels=["a"])
        with pytest.raises(ValueError, match="Expected labels"):
            c.inc(a="1", b="2")

    def test_collect(self):
        c = Counter("c", "c", labels=["env"])
        c.inc(env="prod")
        c.inc(2.0, env="dev")

        collected = c.collect()
        assert len(collected) == 2
        for label_dict, value in collected:
            assert isinstance(label_dict, dict)
            assert "env" in label_dict
            if label_dict["env"] == "prod":
                assert value == 1.0
            elif label_dict["env"] == "dev":
                assert value == 2.0

    def test_collect_no_labels(self):
        c = Counter("c", "c")
        c.inc(5.0)
        collected = c.collect()
        assert len(collected) == 1
        assert collected[0] == ({}, 5.0)


# =============================================================================
# Gauge
# =============================================================================


class TestGauge:

    def test_set_and_get(self):
        g = Gauge("temp", "Temperature")
        g.set(72.5)
        assert g.get() == 72.5

    def test_inc(self):
        g = Gauge("conns", "Connections")
        g.inc()
        g.inc()
        assert g.get() == 2.0

    def test_inc_custom(self):
        g = Gauge("q", "Queue size")
        g.inc(5.0)
        assert g.get() == 5.0

    def test_dec(self):
        g = Gauge("conns", "Connections")
        g.set(10.0)
        g.dec(3.0)
        assert g.get() == 7.0

    def test_dec_default(self):
        g = Gauge("q", "Queue")
        g.set(5.0)
        g.dec()
        assert g.get() == 4.0

    def test_with_labels(self):
        g = Gauge("mem", "Memory", labels=["host"])
        g.set(80.0, host="a")
        g.set(60.0, host="b")
        assert g.get(host="a") == 80.0
        assert g.get(host="b") == 60.0

    def test_label_validation(self):
        g = Gauge("x", "x", labels=["region"])
        with pytest.raises(ValueError, match="Expected labels"):
            g.set(1.0, zone="us")

    def test_collect(self):
        g = Gauge("g", "g", labels=["dc"])
        g.set(1.0, dc="east")
        g.set(2.0, dc="west")
        collected = g.collect()
        assert len(collected) == 2
        values = {d["dc"]: v for d, v in collected}
        assert values["east"] == 1.0
        assert values["west"] == 2.0


# =============================================================================
# Histogram
# =============================================================================


class TestHistogram:

    def test_observe_and_stats(self):
        h = Histogram("duration", "Duration", buckets=[0.1, 0.5, 1.0])
        h.observe(0.05)
        h.observe(0.3)
        h.observe(0.8)
        h.observe(2.0)

        stats = h.get_stats()
        assert stats["count"] == 4
        assert stats["sum"] == pytest.approx(3.15)
        assert stats["average"] == pytest.approx(3.15 / 4)

        # Bucket counts: le=0.1 has 1, le=0.5 has 2, le=1.0 has 3, +inf has 4
        buckets = stats["buckets"]
        assert buckets[0.1] == 1
        assert buckets[0.5] == 2
        assert buckets[1.0] == 3
        assert buckets[float("inf")] == 4

    def test_default_buckets(self):
        h = Histogram("x", "x")
        assert len(h.buckets) == len(Histogram.DEFAULT_BUCKETS)
        assert h.buckets == sorted(Histogram.DEFAULT_BUCKETS)

    def test_custom_buckets_sorted(self):
        h = Histogram("x", "x", buckets=[5.0, 1.0, 10.0])
        assert h.buckets == [1.0, 5.0, 10.0]

    def test_observe_with_labels(self):
        h = Histogram("lat", "Latency", labels=["endpoint"], buckets=[0.5, 1.0])
        h.observe(0.2, endpoint="/api")
        h.observe(0.8, endpoint="/api")
        h.observe(0.1, endpoint="/health")

        api_stats = h.get_stats(endpoint="/api")
        assert api_stats["count"] == 2
        assert api_stats["sum"] == pytest.approx(1.0)

        health_stats = h.get_stats(endpoint="/health")
        assert health_stats["count"] == 1

    def test_label_validation(self):
        h = Histogram("x", "x", labels=["a"])
        with pytest.raises(ValueError, match="Expected labels"):
            h.observe(1.0, b="wrong")

    def test_get_stats_empty(self):
        h = Histogram("x", "x")
        stats = h.get_stats()
        assert stats["count"] == 0
        assert stats["sum"] == 0.0
        assert stats["average"] == 0.0

    def test_collect(self):
        h = Histogram("h", "h", labels=["region"], buckets=[1.0])
        h.observe(0.5, region="us")
        h.observe(1.5, region="eu")

        collected = h.collect()
        assert len(collected) == 2
        for label_dict, stats in collected:
            assert "region" in label_dict
            assert "count" in stats
            assert "sum" in stats
            assert "buckets" in stats


# =============================================================================
# MetricsRegistry
# =============================================================================


class TestMetricsRegistry:

    def test_counter_creation(self):
        r = MetricsRegistry()
        c = r.counter("test_counter", "Test")
        assert isinstance(c, Counter)

    def test_gauge_creation(self):
        r = MetricsRegistry()
        g = r.gauge("test_gauge", "Test")
        assert isinstance(g, Gauge)

    def test_histogram_creation(self):
        r = MetricsRegistry()
        h = r.histogram("test_hist", "Test", buckets=[1.0, 5.0])
        assert isinstance(h, Histogram)

    def test_idempotent_counter(self):
        r = MetricsRegistry()
        c1 = r.counter("same", "Test")
        c2 = r.counter("same", "Test")
        assert c1 is c2

    def test_idempotent_gauge(self):
        r = MetricsRegistry()
        g1 = r.gauge("same_g", "Test")
        g2 = r.gauge("same_g", "Test")
        assert g1 is g2

    def test_idempotent_histogram(self):
        r = MetricsRegistry()
        h1 = r.histogram("same_h", "Test")
        h2 = r.histogram("same_h", "Test")
        assert h1 is h2

    def test_collect_all(self):
        r = MetricsRegistry()
        c = r.counter("c1", "Counter")
        g = r.gauge("g1", "Gauge")
        h = r.histogram("h1", "Histogram")

        c.inc()
        g.set(42.0)
        h.observe(1.5)

        result = r.collect_all()

        assert "c1" in result
        assert result["c1"]["type"] == "counter"
        assert result["c1"]["help"] == "Counter"
        assert len(result["c1"]["values"]) == 1

        assert "g1" in result
        assert result["g1"]["type"] == "gauge"

        assert "h1" in result
        assert result["h1"]["type"] == "histogram"
        assert result["h1"]["buckets"] == h.buckets

    def test_collect_all_empty(self):
        r = MetricsRegistry()
        result = r.collect_all()
        assert result == {}

    def test_export_prometheus_format(self):
        r = MetricsRegistry()
        c = r.counter("http_requests_total", "Total HTTP requests", labels=["method"])
        c.inc(method="GET")
        c.inc(method="GET")
        c.inc(method="POST")

        g = r.gauge("active_conns", "Active connections")
        g.set(5.0)

        h = r.histogram("req_duration", "Request duration", buckets=[0.1, 1.0])
        h.observe(0.05)
        h.observe(0.5)

        output = r.export_prometheus()

        assert isinstance(output, str)
        assert output.endswith("\n")

        # Counter lines
        assert "# HELP http_requests_total Total HTTP requests" in output
        assert "# TYPE http_requests_total counter" in output
        assert 'http_requests_total{method="GET"} 2.0' in output
        assert 'http_requests_total{method="POST"} 1.0' in output

        # Gauge lines
        assert "# HELP active_conns Active connections" in output
        assert "# TYPE active_conns gauge" in output
        assert "active_conns 5.0" in output

        # Histogram lines
        assert "# HELP req_duration Request duration" in output
        assert "# TYPE req_duration histogram" in output
        assert "req_duration_sum" in output
        assert "req_duration_count" in output
        assert "req_duration_bucket" in output

    def test_format_labels_empty(self):
        r = MetricsRegistry()
        assert r._format_labels({}) == ""

    def test_format_labels_with_values(self):
        r = MetricsRegistry()
        result = r._format_labels({"method": "GET", "status": "200"})
        assert result.startswith("{")
        assert result.endswith("}")
        assert 'method="GET"' in result
        assert 'status="200"' in result


# =============================================================================
# Global convenience functions
# =============================================================================


class TestGlobalFunctions:

    @pytest.fixture(autouse=True)
    def _reset_global(self):
        import monitoring.metrics as _mod
        _mod._global_registry = None
        yield
        _mod._global_registry = None

    def test_get_registry_singleton(self):
        r1 = get_registry()
        r2 = get_registry()
        assert r1 is r2
        assert isinstance(r1, MetricsRegistry)

    def test_global_counter(self):
        c = global_counter("global_c", "Global counter")
        assert isinstance(c, Counter)

    def test_global_gauge(self):
        g = global_gauge("global_g", "Global gauge")
        assert isinstance(g, Gauge)

    def test_global_histogram(self):
        h = global_histogram("global_h", "Global histogram", buckets=[1.0])
        assert isinstance(h, Histogram)


# =============================================================================
# setup_standard_metrics
# =============================================================================


class TestSetupStandardMetrics:

    @pytest.fixture(autouse=True)
    def _reset_global(self):
        import monitoring.metrics as _mod
        _mod._global_registry = None
        yield
        _mod._global_registry = None

    def test_returns_expected_keys(self):
        metrics = setup_standard_metrics()

        expected_keys = [
            "http_requests_total",
            "http_request_duration_seconds",
            "http_request_size_bytes",
            "http_response_size_bytes",
            "chat_messages_total",
            "chat_tokens_total",
            "chat_duration_seconds",
            "integration_calls_total",
            "integration_duration_seconds",
            "mcp_servers_active",
            "mcp_tool_executions_total",
            "mcp_execution_duration_seconds",
            "runtime_errors_total",
            "active_connections",
            "database_queries_total",
            "database_query_duration_seconds",
            "tts_synthesis_duration_seconds",
            "tts_synthesis_total",
            "tts_model_load_duration_seconds",
            "tts_audio_duration_seconds",
            "tts_engine_switches_total",
            "tts_queue_overflow_total",
            "handsfree_sessions_total",
            "stt_transcriptions_total",
            "artifact_link_events_total",
            "websocket_reconnects_total",
            "send_validation_failures_total",
        ]

        for key in expected_keys:
            assert key in metrics, f"Missing standard metric: {key}"

    def test_metric_types_correct(self):
        metrics = setup_standard_metrics()

        assert isinstance(metrics["http_requests_total"], Counter)
        assert isinstance(metrics["mcp_servers_active"], Gauge)
        assert isinstance(metrics["http_request_duration_seconds"], Histogram)


# =============================================================================
# Thread safety
# =============================================================================


class TestThreadSafety:

    def test_counter_concurrent_inc(self):
        """Concurrent increments from 10 threads — final value is deterministic."""
        c = Counter("threaded_c", "Threaded counter")
        iterations = 1000

        def _worker():
            for _ in range(iterations):
                c.inc()

        threads = [threading.Thread(target=_worker) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert c.get() == 10 * iterations

    def test_gauge_concurrent_set(self):
        """Concurrent sets — final value is from one of the threads."""
        g = Gauge("threaded_g", "Threaded gauge")

        def _worker(val):
            for _ in range(100):
                g.set(val)

        threads = [threading.Thread(target=_worker, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Final value must be one of 0-4
        assert g.get() in [0.0, 1.0, 2.0, 3.0, 4.0]
