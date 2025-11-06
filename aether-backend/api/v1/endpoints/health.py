"""
Health Check Endpoints

Comprehensive health checks integrating with monitoring layer.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET), Load Balancers --- {HTTP requests to /v1/health, /v1/health/detailed, /v1/health/ready, /v1/health/live, /api/status}
Processing: health_check(), detailed_health_check(), readiness_probe(), liveness_probe(), check_component_health() --- {3 jobs: component_checking, health_monitoring, resource_monitoring}
Outgoing: monitoring/health.py, api/dependencies.py, Frontend (HTTP) --- {health check results, HealthCheckResponse, SimpleHealthResponse, ComponentHealth schemas}
"""

import time
import platform
import sys
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Response, status

from api.dependencies import (
    get_runtime_engine,
    get_mcp_manager,
    get_database,
    setup_request_context
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
from core.runtime.engine import RuntimeEngine
from core.mcp.manager import MCPServerManager
from data.database.connection import DatabaseConnection

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
    description="Quick health check endpoint for load balancers and monitoring"
)
async def health_check() -> SimpleHealthResponse:
    """
    Simple health check.
    
    Returns basic status and uptime. Use for load balancer health checks.
    """
    return SimpleHealthResponse(
        status="ok",
        timestamp=time.time(),
        uptime_seconds=time.time() - START_TIME
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
                system = SystemHealth(
                    cpu_percent=comp.details.get("cpu_percent", 0),
                    memory_percent=comp.details.get("memory_percent", 0),
                    disk_percent=comp.details.get("disk_percent", 0),
                    platform=comp.details.get("platform", platform.system()),
                    python_version=comp.details.get("python_version", sys.version),
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
        logger.error(f"Health check failed: {e}", exc_info=True)
        
        return HealthCheckResponse(
            status=HealthStatus.UNHEALTHY,
            timestamp=time.time(),
            uptime_seconds=time.time() - START_TIME,
            check_duration_ms=(time.time() - start_time) * 1000,
            components=[
                ComponentHealth(
                    component="system",
                    status=HealthStatus.UNHEALTHY,
                    message=f"Health check error: {str(e)}"
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
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Component health check failed for {component_name}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to check component health: {str(e)}"
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
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            return {"ready": False, "reason": f"Runtime engine error: {str(e)}"}
        
        return {"ready": True}
        
    except Exception as e:
        logger.error(f"Readiness probe failed: {e}")
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"ready": False, "reason": str(e)}


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
    _context: dict = Depends(setup_request_context)
) -> DetailedStatusResponse:
    """
    Detailed server status (legacy endpoint).
    
    Provides system information and resource usage.
    Maintained for backward compatibility with old frontend.
    """
    try:
        import psutil
        
        # Get system info
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage('/')
        
        system = SystemHealth(
            cpu_percent=psutil.cpu_percent(interval=None) or 0,
            memory_percent=memory.percent,
            disk_percent=disk.percent,
            platform=platform.system(),
            python_version=sys.version,
            uptime_seconds=time.time() - START_TIME
        )
        
        resources = {
            "cpu_percent": system.cpu_percent,
            "memory": {
                "total_gb": memory.total / (1024**3),
                "available_gb": memory.available / (1024**3),
                "percent_used": memory.percent
            },
            "disk": {
                "total_gb": disk.total / (1024**3),
                "free_gb": disk.free / (1024**3),
                "percent_used": disk.percent
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
        logger.error(f"Status check failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get status: {str(e)}"
        )


# =============================================================================
# Helper Functions
# =============================================================================

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

