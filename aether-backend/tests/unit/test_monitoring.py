"""
Unit Tests: Monitoring

Tests for monitoring module including logging, metrics, health checks, and tracing.
"""

import pytest
import logging

from monitoring.logging import configure_logging, get_logger
from monitoring.metrics import MetricsRegistry
from monitoring.health import HealthChecker, HealthStatus
from monitoring.tracing import Tracer


# =============================================================================
# Logging Tests
# =============================================================================

class TestLogging:
    """Test logging configuration and usage."""
    
    def test_setup_logging(self, test_settings):
        """Test logging setup."""
        configure_logging(level=test_settings.monitoring.log_level)
        
        logger = logging.getLogger("aether")
        assert logger is not None
        assert logger.level <= logging.WARNING  # Test uses WARNING
    
    def test_get_logger(self):
        """Test getting named logger."""
        logger = get_logger("test_module")
        
        assert logger is not None
        assert logger.name == "aether.test_module"
    
    def test_log_levels(self):
        """Test different log levels."""
        logger = get_logger("test")
        
        # Should not raise exceptions
        logger.debug("Debug message")
        logger.info("Info message")
        logger.warning("Warning message")
        logger.error("Error message")
    
    def test_structured_logging(self):
        """Test structured logging with extra fields passes through to stdlib logger."""
        from unittest.mock import patch
        structured_logger = get_logger("test_struct")
        
        with patch.object(structured_logger._logger, "log") as mock_log:
            structured_logger.info(
                "Test message",
                extra={
                    'user_id': 'test-user',
                    'request_id': 'test-request'
                }
            )
        
        mock_log.assert_called_once()
        args, kwargs = mock_log.call_args
        assert args[0] == logging.INFO
        assert args[1] == "Test message"
        assert kwargs["extra"]["user_id"] == "test-user"
        assert kwargs["extra"]["request_id"] == "test-request"


# =============================================================================
# Metrics Tests
# =============================================================================

class TestMetrics:
    """Test metrics collection."""

    def test_registry_counter_and_gauge(self):
        registry = MetricsRegistry()

        c = registry.counter("aether_test_counter_total", "test counter", labels=["kind"])
        c.inc(kind="x")
        c.inc(kind="x")
        assert c.get(kind="x") >= 2

        g = registry.gauge("aether_test_gauge", "test gauge")
        g.set(42.5)
        assert g.get() == 42.5


# =============================================================================
# Health Check Tests
# =============================================================================

class TestHealthChecker:
    """Test health check functionality."""
    
    @pytest.fixture
    def health_checker(self):
        """Create health checker."""
        return HealthChecker()
    
    @pytest.mark.asyncio
    async def test_check_component_healthy(self, health_checker):
        """Test checking system component is callable."""
        result = await health_checker.check_component("system")
        assert result is not None
        assert result.component == "system"
    
    @pytest.mark.asyncio
    async def test_check_component_unhealthy(self, health_checker):
        """Test unknown component returns None."""
        result = await health_checker.check_component("does_not_exist")
        assert result is None
    
    @pytest.mark.asyncio
    async def test_check_all_components(self, health_checker):
        """Test check_all returns aggregate structure."""
        result = await health_checker.check_all()
        assert isinstance(result, dict)
        assert "status" in result
        assert "components" in result
    
    @pytest.mark.asyncio
    async def test_health_status_aggregation(self, health_checker):
        """Test aggregating health status."""
        # Public aggregation is via _aggregate_status on HealthCheckResult list.
        # Validate behavior through a minimal synthetic set.
        from monitoring.health import HealthCheckResult

        results = [
            HealthCheckResult(component="a", status=HealthStatus.HEALTHY, message="ok"),
            HealthCheckResult(component="b", status=HealthStatus.DEGRADED, message="slow"),
        ]
        overall = health_checker._aggregate_status(results)
        assert overall == HealthStatus.DEGRADED


# =============================================================================
# Tracing Tests
# =============================================================================

class TestTracing:
    """Test tracing functionality."""
    
    @pytest.fixture
    def tracing_manager(self):
        """Create tracer."""
        return Tracer(service_name="test")
    
    def test_tracing_initialization(self, tracing_manager):
        """Test tracing manager initialization."""
        assert tracing_manager is not None
        assert tracing_manager.service_name == "test"
    
    @pytest.mark.asyncio
    async def test_create_span(self, tracing_manager):
        """Test creating trace span."""
        with tracing_manager.start_span("test_operation") as span:
            assert span is not None
            assert span.name == "test_operation"
    
    @pytest.mark.asyncio
    async def test_nested_spans(self, tracing_manager):
        """Test nested trace spans."""
        with tracing_manager.start_span("parent_operation") as parent:
            with tracing_manager.start_span("child_operation") as child:
                assert child is not None
                assert parent is not None
    
    @pytest.mark.asyncio
    async def test_span_attributes(self, tracing_manager):
        """Test adding attributes to span."""
        with tracing_manager.start_span("test_operation") as span:
            span.set_attribute("user_id", "test-user")
            span.set_attribute("request_id", "test-request")
            
            assert span.attributes['user_id'] == "test-user"
    
    @pytest.mark.asyncio
    async def test_span_events(self, tracing_manager):
        """Test adding events to span."""
        with tracing_manager.start_span("test_operation") as span:
            span.add_event("operation_started")
            span.add_event("operation_completed")
            
            assert len(span.events) >= 2
    
    def test_tracing_disabled(self):
        """Test tracing when disabled."""
        tracer = Tracer(service_name="test")
        tracer.disable()
        with tracer.start_span("test_operation"):
            pass
        assert tracer.get_spans() == []


# =============================================================================
# Integration Tests
# =============================================================================

class TestMonitoringIntegration:
    """Test monitoring primitives compose without exceptions."""

    def test_logging_with_metrics_registry(self):
        logger = get_logger("test")
        logger.info("Operation started")

        registry = MetricsRegistry()
        c = registry.counter("aether_test_ops_total", "ops", labels=["phase"])
        c.inc(phase="start")
        c.inc(phase="start")
        assert c.get(phase="start") >= 2

