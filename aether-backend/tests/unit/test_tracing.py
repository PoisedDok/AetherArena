"""
Unit Tests: Tracing — monitoring/tracing.py

Comprehensive coverage of Tracer, SpanContext, trace() decorator (sync+async),
export_traces_json, and context variable management.

Coverage targets: lines 82, 192, 197, 201, 205, 209, 250-254, 285-316,
346, 356, 366, 371-372, 385-401.
"""

import pytest

from monitoring.tracing import (
    Tracer,
    Span,
    SpanContext,
    SpanKind,
    SpanStatus,
    trace,
    get_tracer,
    get_current_span,
    get_trace_id,
    set_trace_id,
    clear_trace_context,
    export_traces_json,
)


# =============================================================================
# Span dataclass
# =============================================================================


class TestSpan:

    def test_set_attribute(self):
        span = Span(trace_id="t1", span_id="s1", parent_span_id=None, name="test")
        span.set_attribute("key", "value")
        assert span.attributes["key"] == "value"

    def test_add_event(self):
        span = Span(trace_id="t1", span_id="s1", parent_span_id=None, name="test")
        span.add_event("started", {"detail": 42})

        assert len(span.events) == 1
        evt = span.events[0]
        assert evt["name"] == "started"
        assert evt["attributes"]["detail"] == 42
        assert isinstance(evt["timestamp"], float)

    def test_add_event_no_attributes(self):
        span = Span(trace_id="t1", span_id="s1", parent_span_id=None, name="test")
        span.add_event("simple")
        assert span.events[0]["attributes"] == {}

    def test_set_status_ok(self):
        span = Span(trace_id="t1", span_id="s1", parent_span_id=None, name="test")
        span.set_status(SpanStatus.OK)
        assert span.status == SpanStatus.OK

    def test_set_status_error_with_description(self):
        span = Span(trace_id="t1", span_id="s1", parent_span_id=None, name="test")
        span.set_status(SpanStatus.ERROR, "Connection refused")
        assert span.status == SpanStatus.ERROR
        assert span.attributes["status_description"] == "Connection refused"

    def test_finish(self):
        span = Span(trace_id="t1", span_id="s1", parent_span_id=None, name="test")
        assert span.end_time is None
        assert span.duration_ms is None

        span.finish()
        assert span.end_time is not None
        assert isinstance(span.duration_ms, float)
        assert span.duration_ms >= 0

    def test_finish_idempotent(self):
        span = Span(trace_id="t1", span_id="s1", parent_span_id=None, name="test")
        span.finish()
        first_end = span.end_time
        span.finish()
        # end_time unchanged because it's already set
        assert span.end_time == first_end

    def test_default_values(self):
        span = Span(trace_id="t1", span_id="s1", parent_span_id=None, name="test")
        assert span.kind == SpanKind.INTERNAL
        assert span.status == SpanStatus.UNSET
        assert span.attributes == {}
        assert span.events == []


# =============================================================================
# Tracer
# =============================================================================


class TestTracer:

    @pytest.fixture(autouse=True)
    def _clear_context(self):
        """Clear context vars between tests."""
        clear_trace_context()
        yield
        clear_trace_context()

    @pytest.fixture(autouse=True)
    def _reset_global(self):
        import monitoring.tracing as _mod
        _mod._global_tracer = None
        yield
        _mod._global_tracer = None

    def test_create_span_generates_ids(self):
        tracer = Tracer("svc")
        span = tracer.create_span("op1")

        assert span.trace_id is not None
        assert len(span.trace_id) == 32  # hex UUID
        assert span.span_id is not None
        assert len(span.span_id) == 16
        assert span.parent_span_id is None
        assert span.name == "op1"
        assert span.attributes["service.name"] == "svc"

    def test_create_span_reuses_trace_id(self):
        tracer = Tracer("svc")
        s1 = tracer.create_span("op1")
        s2 = tracer.create_span("op2")
        assert s1.trace_id == s2.trace_id

    def test_create_span_respects_parent(self):
        tracer = Tracer("svc")
        with tracer.start_span("parent") as parent:
            child = tracer.create_span("child")
            assert child.parent_span_id == parent.span_id

    def test_start_span_returns_context(self):
        tracer = Tracer("svc")
        ctx = tracer.start_span("op")
        assert isinstance(ctx, SpanContext)

    def test_record_span_when_enabled(self):
        tracer = Tracer("svc")
        with tracer.start_span("op"):
            pass
        spans = tracer.get_spans()
        assert len(spans) == 1
        assert spans[0].name == "op"
        assert spans[0].status == SpanStatus.OK

    def test_record_span_when_disabled(self):
        tracer = Tracer("svc")
        tracer.disable()
        with tracer.start_span("op"):
            pass
        assert tracer.get_spans() == []

    def test_enable_after_disable(self):
        tracer = Tracer("svc")
        tracer.disable()
        assert tracer.is_enabled() is False
        tracer.enable()
        assert tracer.is_enabled() is True
        with tracer.start_span("op"):
            pass
        assert len(tracer.get_spans()) == 1

    def test_get_spans_filter_by_trace_id(self):
        tracer = Tracer("svc")
        # Create span with one trace context
        with tracer.start_span("op1") as s1:
            tid1 = s1.trace_id
        # Force new trace context
        clear_trace_context()
        with tracer.start_span("op2") as s2:
            tid2 = s2.trace_id

        assert tid1 != tid2
        filtered = tracer.get_spans(trace_id=tid1)
        assert len(filtered) == 1
        assert filtered[0].name == "op1"

    def test_clear_spans(self):
        tracer = Tracer("svc")
        with tracer.start_span("op"):
            pass
        assert len(tracer.get_spans()) == 1
        tracer.clear_spans()
        assert tracer.get_spans() == []


# =============================================================================
# SpanContext — error handling
# =============================================================================


class TestSpanContext:

    @pytest.fixture(autouse=True)
    def _clear(self):
        clear_trace_context()
        yield
        clear_trace_context()

    def test_exception_sets_error_status(self):
        tracer = Tracer("svc")
        with pytest.raises(ValueError, match="boom"):
            with tracer.start_span("bad_op"):
                raise ValueError("boom")

        spans = tracer.get_spans()
        assert len(spans) == 1
        span = spans[0]
        assert span.status == SpanStatus.ERROR
        assert span.attributes["status_description"] == "boom"
        # Must have exception event
        assert len(span.events) == 1
        evt = span.events[0]
        assert evt["name"] == "exception"
        assert evt["attributes"]["exception.type"] == "ValueError"
        assert evt["attributes"]["exception.message"] == "boom"

    def test_context_var_reset_after_exit(self):
        tracer = Tracer("svc")
        assert get_current_span() is None
        with tracer.start_span("op") as span:
            assert get_current_span() is span
        assert get_current_span() is None

    def test_nested_context_vars(self):
        tracer = Tracer("svc")
        with tracer.start_span("outer") as outer:
            assert get_current_span() is outer
            with tracer.start_span("inner") as inner:
                assert get_current_span() is inner
            assert get_current_span() is outer
        assert get_current_span() is None


# =============================================================================
# trace() decorator
# =============================================================================


class TestTraceDecorator:

    @pytest.fixture(autouse=True)
    def _clear(self):
        clear_trace_context()
        import monitoring.tracing as _mod
        _mod._global_tracer = None
        yield
        clear_trace_context()
        _mod._global_tracer = None

    def test_sync_function(self):
        @trace(name="sync_op")
        def my_func(x, y):
            return x + y

        result = my_func(3, 4)
        assert result == 7

        spans = get_tracer().get_spans()
        assert len(spans) == 1
        assert spans[0].name == "sync_op"
        assert spans[0].status == SpanStatus.OK
        assert spans[0].attributes["code.function"] == "my_func"

    @pytest.mark.asyncio
    async def test_async_function(self):
        @trace(name="async_op")
        async def my_async_func(x):
            return x * 2

        result = await my_async_func(5)
        assert result == 10

        spans = get_tracer().get_spans()
        assert len(spans) == 1
        assert spans[0].name == "async_op"
        assert spans[0].status == SpanStatus.OK

    def test_sync_function_default_name(self):
        @trace()
        def some_helper():
            return 42

        result = some_helper()
        assert result == 42

        spans = get_tracer().get_spans()
        assert len(spans) == 1
        # Default name includes module.function
        assert "some_helper" in spans[0].name

    def test_sync_function_error(self):
        @trace(name="failing_op")
        def fail():
            raise RuntimeError("kaboom")

        with pytest.raises(RuntimeError, match="kaboom"):
            fail()

        spans = get_tracer().get_spans()
        assert len(spans) == 1
        assert spans[0].status == SpanStatus.ERROR

    @pytest.mark.asyncio
    async def test_async_function_error(self):
        @trace(name="async_fail")
        async def async_fail():
            raise IOError("disk error")

        with pytest.raises(IOError, match="disk error"):
            await async_fail()

        spans = get_tracer().get_spans()
        assert len(spans) == 1
        assert spans[0].status == SpanStatus.ERROR

    def test_custom_kind_and_attributes(self):
        @trace(name="client_call", kind=SpanKind.CLIENT, attributes={"peer": "db"})
        def call_db():
            return True

        call_db()
        spans = get_tracer().get_spans()
        assert spans[0].kind == SpanKind.CLIENT
        assert spans[0].attributes["peer"] == "db"


# =============================================================================
# Context var helpers
# =============================================================================


class TestContextHelpers:

    @pytest.fixture(autouse=True)
    def _clear(self):
        clear_trace_context()
        yield
        clear_trace_context()

    def test_get_trace_id_none_initially(self):
        assert get_trace_id() is None

    def test_set_and_get_trace_id(self):
        set_trace_id("abc123")
        assert get_trace_id() == "abc123"

    def test_clear_trace_context(self):
        set_trace_id("abc")
        clear_trace_context()
        assert get_trace_id() is None
        assert get_current_span() is None


# =============================================================================
# export_traces_json
# =============================================================================


class TestExportTracesJson:

    def test_export_completed_spans(self):
        s1 = Span(
            trace_id="t1",
            span_id="s1",
            parent_span_id=None,
            name="root",
            kind=SpanKind.SERVER,
        )
        s1.set_status(SpanStatus.OK)
        s1.finish()

        s2 = Span(
            trace_id="t1",
            span_id="s2",
            parent_span_id="s1",
            name="child",
        )
        s2.add_event("log", {"msg": "hello"})
        s2.set_status(SpanStatus.ERROR, "failed")
        s2.finish()

        result = export_traces_json([s1, s2])

        assert len(result) == 2

        r1 = result[0]
        assert r1["traceId"] == "t1"
        assert r1["spanId"] == "s1"
        assert r1["parentSpanId"] is None
        assert r1["name"] == "root"
        assert r1["kind"] == "server"
        assert r1["status"] == "ok"
        assert r1["startTime"].endswith("Z")
        assert r1["endTime"].endswith("Z")
        assert isinstance(r1["durationMs"], float)
        assert r1["events"] == []

        r2 = result[1]
        assert r2["parentSpanId"] == "s1"
        assert r2["status"] == "error"
        assert len(r2["events"]) == 1

    def test_export_unfinished_span(self):
        s = Span(trace_id="t", span_id="s", parent_span_id=None, name="pending")
        result = export_traces_json([s])
        assert result[0]["endTime"] is None
        assert result[0]["durationMs"] is None

    def test_export_empty_list(self):
        assert export_traces_json([]) == []


# =============================================================================
# get_tracer singleton
# =============================================================================


class TestGetTracer:

    @pytest.fixture(autouse=True)
    def _reset(self):
        import monitoring.tracing as _mod
        _mod._global_tracer = None
        yield
        _mod._global_tracer = None

    def test_singleton(self):
        t1 = get_tracer()
        t2 = get_tracer()
        assert t1 is t2

    def test_default_service_name(self):
        t = get_tracer()
        assert t.service_name == "aether-backend"

    def test_custom_service_name(self):
        t = get_tracer("custom-svc")
        assert t.service_name == "custom-svc"
