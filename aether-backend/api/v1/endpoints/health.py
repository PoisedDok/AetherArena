"""
Health Check Endpoints

Comprehensive health checks integrating with monitoring layer.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET), Load Balancers --- {HTTP requests to /v1/health, /v1/health/detailed, /v1/health/ready, /v1/health/live, /api/status}
Processing: health_check(), detailed_health_check(), readiness_probe(), liveness_probe(), check_component_health() --- {JOB_COLLECT_METRICS, JOB_HEALTH_CHECK}
Outgoing: monitoring/health.py, api/dependencies.py, Frontend (HTTP) --- {health check results, HealthCheckResponse, SimpleHealthResponse, ComponentHealth schemas}
"""

import time
from fastapi import APIRouter, Depends, HTTPException, Response, status

from api.dependencies import (
    get_runtime_engine,
    setup_request_context,
    get_process_gateway,
)
from api.v1.schemas.health import (
    HealthCheckResponse,
    SimpleHealthResponse,
    DetailedStatusResponse,
    ComponentHealth,
    SystemHealth
)
from api.v1.schemas.common import HealthStatus
from monitoring import get_health_checker, get_logger
from core.exceptions import DomainException
from core.system.interfaces import IProcessGateway

logger = get_logger(__name__)
router = APIRouter(tags=["health"])

# Track startup time
START_TIME = time.time()


# =============================================================================
# Simple Health Check
# =============================================================================

@router.get(
    "/health",
    response_model=SimpleHealthResponse,
    summary="Simple health check",
    description="Quick health check endpoint for load balancers and monitoring",
)
async def health_check() -> SimpleHealthResponse:
    """
    Simple health check.
    
    Returns basic status and uptime. Use for load balancer health checks.
    Includes the active LLM model name for frontend status bar display.
    """
    model_name = None
    try:
        from config.settings import get_settings
        settings = get_settings()
        model_name = settings.llm.model
    except Exception:
        pass  # Settings not yet loaded — model stays None
    
    return SimpleHealthResponse(
        status="ok",
        timestamp=time.time(),
        uptime_seconds=time.time() - START_TIME,
        model=model_name,
    )


# =============================================================================
# Comprehensive Health Check
# =============================================================================

@router.get(
    "/health/detailed",
    response_model=HealthCheckResponse,
    summary="Detailed health check",
    description="Comprehensive health check of all system components"
)
async def detailed_health_check(
    _context: dict = Depends(setup_request_context)
) -> HealthCheckResponse:
    """
    Comprehensive health check.
    
    Checks all components:
    - System resources (CPU, memory, disk)
    - Runtime engine
    - Database connection
    - MCP servers
    - Integrations
    
    Returns detailed status for each component.
    """
    start_time = time.time()
    
    try:
        # Get health checker
        checker = get_health_checker()
        
        if checker is None:
            # Health checker not initialized yet, return basic response
            logger.warning("Health checker not initialized, returning basic status")
            return HealthCheckResponse(
                status=HealthStatus.UNKNOWN,
                timestamp=time.time(),
                uptime_seconds=time.time() - START_TIME,
                check_duration_ms=(time.time() - start_time) * 1000,
                components=[
                    ComponentHealth(
                        component="system",
                        status=HealthStatus.UNKNOWN,
                        message="Health checker not initialized"
                    )
                ]
            )
        
        # Run comprehensive health check
        health_data = await checker.check_all()
        
        # Convert to response model
        components = [
            ComponentHealth(
                component=comp["component"],
                status=HealthStatus(comp["status"]),
                message=comp.get("message"),
                response_time_ms=comp.get("response_time_ms"),
                details=comp.get("details"),
                timestamp=comp.get("timestamp")
            )
            for comp in health_data.get("components", [])
        ]
        
        # Extract system health if present
        system = None
        for comp in components:
            if comp.component == "system" and comp.details:
                # We retain the dict lookup here because it comes from the health_data payload which uses dicts.
                system = SystemHealth(
                    cpu_percent=comp.details.get("cpu_percent", 0),
                    memory_percent=comp.details.get("memory_percent", 0),
                    disk_percent=comp.details.get("disk_percent", 0),
                    platform=comp.details.get("platform", "unknown"),
                    python_version=comp.details.get("python_version", "unknown"),
                    uptime_seconds=comp.details.get("uptime_seconds", time.time() - START_TIME)
                )
                break
        
        return HealthCheckResponse(
            status=HealthStatus(health_data["status"]),
            timestamp=health_data["timestamp"],
            uptime_seconds=health_data.get("uptime_seconds", time.time() - START_TIME),
            check_duration_ms=health_data.get("check_duration_ms", (time.time() - start_time) * 1000),
            components=components,
            system=system
        )
        
    except Exception as e:
        logger.error("Health check failed: %s", e, exc_info=True)
        
        return HealthCheckResponse(
            status=HealthStatus.UNHEALTHY,
            timestamp=time.time(),
            uptime_seconds=time.time() - START_TIME,
            check_duration_ms=(time.time() - start_time) * 1000,
            components=[
                ComponentHealth(
                    component="system",
                    status=HealthStatus.UNHEALTHY,
                    message="Health check error"
                )
            ]
        )


# =============================================================================
# Component-Specific Health Checks
# =============================================================================

@router.get(
    "/health/component/{component_name}",
    response_model=ComponentHealth,
    summary="Check specific component",
    description="Check health of a specific system component"
)
async def check_component_health(
    component_name: str,
    _context: dict = Depends(setup_request_context)
) -> ComponentHealth:
    """
    Check specific component health.
    
    Args:
        component_name: Component to check (runtime, database, mcp, integrations, system)
        
    Returns:
        ComponentHealth: Health status of the component
        
    Raises:
        HTTPException: If component not found or check fails
    """
    # Validate component_name to prevent injection
    allowed_components = {'runtime', 'database', 'mcp', 'integrations', 'system'}
    if component_name not in allowed_components:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid component name. Allowed: {', '.join(allowed_components)}"
        )
    
    try:
        checker = get_health_checker()
        
        if checker is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Health checker not initialized"
            )
        
        result = await checker.check_component(component_name)
        
        if result is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Component '{component_name}' not found"
            )
        
        return ComponentHealth(
            component=result.component,
            status=HealthStatus(result.status),
            message=result.message,
            response_time_ms=result.response_time_ms,
            details=result.details
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Component health check failed for %s: %s", component_name, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to check component health"
        )


# =============================================================================
# Readiness and Liveness Probes (Kubernetes-style)
# =============================================================================

@router.get(
    "/health/ready",
    summary="Readiness probe",
    description="Check if application is ready to serve traffic"
)
async def readiness_probe(response: Response) -> dict:
    """
    Readiness probe for Kubernetes.
    
    Returns 200 if application is ready to serve traffic.
    Returns 503 if not ready.
    """
    try:
        # Check critical components
        checker = get_health_checker()
        
        if checker is None:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            return {"ready": False, "reason": "Health checker not initialized"}
        
        # Check runtime engine
        try:
            runtime = get_runtime_engine()
            if runtime is None:
                response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
                return {"ready": False, "reason": "Runtime engine not initialized"}
        except Exception as e:
            logger.warning("Runtime engine readiness error: %s", e)
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            return {"ready": False, "reason": "Service not ready. Check server logs."}
        
        return {"ready": True}
        
    except Exception as e:
        logger.error("Readiness probe failed: %s", e)
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"ready": False, "reason": "Service not ready. Check server logs."}


@router.get(
    "/health/live",
    summary="Liveness probe",
    description="Check if application is alive"
)
async def liveness_probe() -> dict:
    """
    Liveness probe for Kubernetes.
    
    Returns 200 if application is alive.
    Simple check that doesn't depend on external services.
    """
    return {
        "alive": True,
        "uptime_seconds": time.time() - START_TIME
    }


# =============================================================================
# Detailed Status (Legacy Compatibility)
# =============================================================================

@router.get(
    "/api/status",
    response_model=DetailedStatusResponse,
    summary="Detailed server status (legacy)",
    description="Detailed server status endpoint for legacy compatibility"
)
async def status_check(
    gateway: IProcessGateway = Depends(get_process_gateway),
    _context: dict = Depends(setup_request_context)
) -> DetailedStatusResponse:
    """
    Detailed server status (legacy endpoint).
    
    Provides system information and resource usage.
    Maintained for backward compatibility with old frontend.
    """
    try:
        metrics = gateway.get_system_metrics()
        
        system = SystemHealth(
            cpu_percent=metrics.cpu_percent,
            memory_percent=metrics.memory.percent_used,
            disk_percent=metrics.disk.percent_used,
            platform=metrics.platform,
            python_version=metrics.python_version,
            uptime_seconds=time.time() - START_TIME
        )
        
        resources = {
            "cpu_percent": metrics.cpu_percent,
            "memory": {
                "total_gb": metrics.memory.total_bytes / (1024**3),
                "available_gb": metrics.memory.available_bytes / (1024**3),
                "percent_used": metrics.memory.percent_used
            },
            "disk": {
                "total_gb": metrics.disk.total_bytes / (1024**3),
                "free_gb": metrics.disk.free_bytes / (1024**3),
                "percent_used": metrics.disk.percent_used
            }
        }
        
        uptime = {
            "seconds": time.time() - START_TIME,
            "formatted": format_uptime(time.time() - START_TIME)
        }
        
        return DetailedStatusResponse(
            status="ok",
            system=system,
            resources=resources,
            uptime=uptime
        )
        
    except Exception as e:
        logger.error("Status check failed: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get status"
        )


# =============================================================================
# Helper Functions
# =============================================================================

# =============================================================================
# Graceful Shutdown
# =============================================================================

@router.post(
    "/system/shutdown",
    summary="Initiate graceful backend shutdown",
    description="Triggers a clean backend shutdown sequence. "
                "Called by the frontend before app quit to ensure clean exit. "
                "The backend will signal its process to terminate after returning this response.",
)
async def initiate_shutdown(
    gateway: IProcessGateway = Depends(get_process_gateway),
    _context: dict = Depends(setup_request_context)
):
    """
    Initiate graceful backend shutdown.
    
    Returns 200 immediately, then the backend process begins teardown.
    The frontend should poll /v1/health to detect when the backend is truly down.
    """
    logger.info("=== GRACEFUL SHUTDOWN REQUESTED BY FRONTEND ===")

    await gateway.self_terminate(delay_seconds=0.5)

    return {
        "status": "shutting_down",
        "message": "Graceful shutdown initiated. Backend will terminate shortly.",
        "pid": gateway.get_current_pid(),
    }


def format_uptime(seconds: float) -> str:
    """Format uptime in human readable format."""
    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, seconds = divmod(remainder, 60)
    
    parts = []
    if days > 0:
        parts.append(f"{int(days)}d")
    if hours > 0 or days > 0:
        parts.append(f"{int(hours)}h")
    if minutes > 0 or hours > 0 or days > 0:
        parts.append(f"{int(minutes)}m")
    parts.append(f"{int(seconds)}s")
    
    return " ".join(parts)
