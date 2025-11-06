"""
Unit Tests: Monitoring

Tests for monitoring module including logging, metrics, health checks, and tracing.
"""

import pytest
from unittest.mock import MagicMock, patch
import logging

from monitoring.logging import configure_logging, get_logger
from monitoring.metrics import MetricsRegistry, Counter, Gauge, Histogram
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
        """Test structured logging."""
        logger = get_logger("test")
        
        # Log with extra fields
        logger.info(
            "Test message",
            extra={
                'user_id': 'test-user',
                'request_id': 'test-request'
            }
        )
        
        assert True  # No exception raised


# =============================================================================
# Metrics Tests
# =============================================================================

class TestMetrics:
    """Test metrics collection."""
    
    @pytest.fixture
    def metrics_collector(self):
        """Create metrics collector."""
        return MetricsCollector()
    
    def test_collector_initialization(self, metrics_collector):
        """Test metrics collector initialization."""
        assert metrics_collector is not None
        assert hasattr(metrics_collector, 'increment_counter')
        assert hasattr(metrics_collector, 'record_gauge')
    
    def test_increment_counter(self, metrics_collector):
        """Test incrementing counter."""
        metric_name = "test_counter"
        
        metrics_collector.increment_counter(metric_name)
        metrics_collector.increment_counter(metric_name)
        
        value = metrics_collector.get_counter(metric_name)
        assert value >= 2
    
    def test_record_gauge(self, metrics_collector):
        """Test recording gauge value."""
        metric_name = "test_gauge"
        
        metrics_collector.record_gauge(metric_name, 42.5)
        
        value = metrics_collector.get_gauge(metric_name)
        assert value == 42.5
    
    def test_record_histogram(self, metrics_collector):
        """Test recording histogram."""
        metric_name = "test_histogram"
        
        metrics_collector.record_histogram(metric_name, 100)
        metrics_collector.record_histogram(metric_name, 200)
        metrics_collector.record_histogram(metric_name, 150)
        
        stats = metrics_collector.get_histogram_stats(metric_name)
        assert stats is not None
    
    def test_track_metric_decorator(self):
        """Test metric tracking decorator."""
        @track_metric("test_function_calls")
        def test_function():
            return "success"
        
        result = test_function()
        assert result == "success"
    
    def test_metric_labels(self, metrics_collector):
        """Test metrics with labels."""
        metric_name = "test_labeled_counter"
        
        metrics_collector.increment_counter(
            metric_name,
            labels={'endpoint': '/api/chat', 'method': 'POST'}
        )
        
        value = metrics_collector.get_counter(
            metric_name,
            labels={'endpoint': '/api/chat', 'method': 'POST'}
        )
        assert value >= 1


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
        """Test checking healthy component."""
        async def healthy_check():
            return HealthStatus.HEALTHY
        
        result = await health_checker.check_component(
            "test_component",
            healthy_check
        )
        
        assert result['status'] == HealthStatus.HEALTHY
        assert result['component'] == 'test_component'
    
    @pytest.mark.asyncio
    async def test_check_component_unhealthy(self, health_checker):
        """Test checking unhealthy component."""
        async def unhealthy_check():
            raise Exception("Component failed")
        
        result = await health_checker.check_component(
            "test_component",
            unhealthy_check
        )
        
        assert result['status'] == HealthStatus.UNHEALTHY
        assert 'error' in result
    
    @pytest.mark.asyncio
    async def test_check_all_components(self, health_checker):
        """Test checking all components."""
        checks = {
            'database': lambda: HealthStatus.HEALTHY,
            'cache': lambda: HealthStatus.HEALTHY,
            'external_api': lambda: HealthStatus.DEGRADED
        }
        
        result = await health_checker.check_all(checks)
        
        assert 'database' in result
        assert 'cache' in result
        assert 'external_api' in result
    
    @pytest.mark.asyncio
    async def test_health_status_aggregation(self, health_checker):
        """Test aggregating health status."""
        statuses = [
            HealthStatus.HEALTHY,
            HealthStatus.HEALTHY,
            HealthStatus.DEGRADED
        ]
        
        overall = health_checker.aggregate_status(statuses)
        
        assert overall == HealthStatus.DEGRADED  # One degraded = overall degraded
    
    @pytest.mark.asyncio
    async def test_database_health_check(self, health_checker, db_session):
        """Test database health check."""
        result = await health_checker.check_database(db_session)
        
        assert result['status'] in [HealthStatus.HEALTHY, HealthStatus.UNHEALTHY]
    
    @pytest.mark.asyncio
    async def test_service_health_check(self, health_checker, mock_http_client):
        """Test external service health check."""
        mock_http_client.get.return_value = MagicMock(status_code=200)
        
        result = await health_checker.check_service(
            "test_service",
            "http://localhost:8000/health",
            client=mock_http_client
        )
        
        assert result['status'] == HealthStatus.HEALTHY


# =============================================================================
# Tracing Tests
# =============================================================================

class TestTracing:
    """Test tracing functionality."""
    
    @pytest.fixture
    def tracing_manager(self):
        """Create tracing manager."""
        return TracingManager(enabled=True)
    
    def test_tracing_initialization(self, tracing_manager):
        """Test tracing manager initialization."""
        assert tracing_manager is not None
        assert tracing_manager.enabled is True
    
    @pytest.mark.asyncio
    async def test_create_span(self, tracing_manager):
        """Test creating trace span."""
        with tracing_manager.create_span("test_operation") as span:
            assert span is not None
            assert span.name == "test_operation"
    
    @pytest.mark.asyncio
    async def test_nested_spans(self, tracing_manager):
        """Test nested trace spans."""
        with tracing_manager.create_span("parent_operation") as parent:
            with tracing_manager.create_span("child_operation") as child:
                assert child is not None
                assert parent is not None
    
    @pytest.mark.asyncio
    async def test_span_attributes(self, tracing_manager):
        """Test adding attributes to span."""
        with tracing_manager.create_span("test_operation") as span:
            span.set_attribute("user_id", "test-user")
            span.set_attribute("request_id", "test-request")
            
            assert span.attributes['user_id'] == "test-user"
    
    @pytest.mark.asyncio
    async def test_span_events(self, tracing_manager):
        """Test adding events to span."""
        with tracing_manager.create_span("test_operation") as span:
            span.add_event("operation_started")
            span.add_event("operation_completed")
            
            assert len(span.events) >= 2
    
    def test_tracing_disabled(self):
        """Test tracing when disabled."""
        tracing_manager = TracingManager(enabled=False)
        
        with tracing_manager.create_span("test_operation") as span:
            # Should be no-op span
            assert span is not None


# =============================================================================
# Integration Tests
# =============================================================================

class TestMonitoringIntegration:
    """Test monitoring system integration."""
    
    @pytest.mark.asyncio
    async def test_logging_with_metrics(self):
        """Test logging with metrics collection."""
        logger = get_logger("test")
        metrics = MetricsCollector()
        
        # Log and track metric
        logger.info("Operation started")
        metrics.increment_counter("operations_started")
        
        logger.info("Operation completed")
        metrics.increment_counter("operations_completed")
        
        started = metrics.get_counter("operations_started")
        completed = metrics.get_counter("operations_completed")
        
        assert started >= 1
        assert completed >= 1
    
    @pytest.mark.asyncio
    async def test_health_with_tracing(self):
        """Test health checks with tracing."""
        health_checker = HealthChecker()
        tracing_manager = TracingManager(enabled=True)
        
        with tracing_manager.create_span("health_check"):
            result = await health_checker.check_component(
                "test_component",
                lambda: HealthStatus.HEALTHY
            )
        
        assert result['status'] == HealthStatus.HEALTHY
    
    @pytest.mark.asyncio
    async def test_full_monitoring_stack(self):
        """Test complete monitoring stack."""
        logger = get_logger("test")
        metrics = MetricsCollector()
        health_checker = HealthChecker()
        tracing_manager = TracingManager(enabled=True)
        
        with tracing_manager.create_span("test_operation") as span:
            # Log
            logger.info("Starting operation")
            
            # Metrics
            metrics.increment_counter("test_operations")
            
            # Health check
            health = await health_checker.check_component(
                "test",
                lambda: HealthStatus.HEALTHY
            )
            
            # Add trace attribute
            span.set_attribute("health_status", health['status'])
            
            logger.info("Operation completed")
        
        assert metrics.get_counter("test_operations") >= 1
        assert health['status'] == HealthStatus.HEALTHY

