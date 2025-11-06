"""
Health Check Schemas

Pydantic models for health check endpoints.

@.architecture
Incoming: api/v1/endpoints/health.py, monitoring/health.py --- {health check results, component status}
Processing: Pydantic validation and serialization --- {2 jobs: data_validation, serialization}
Outgoing: api/v1/endpoints/health.py --- {HealthCheckResponse, ComponentHealth, SystemHealth, DetailedStatusResponse validated models}
"""

from typing import Dict, List, Optional, Any
from datetime import datetime
from pydantic import BaseModel, Field

from .common import HealthStatus


# =============================================================================
# Component Health Models
# =============================================================================

class ComponentHealth(BaseModel):
    """Health status of a single component."""
    component: str
    status: HealthStatus
    message: Optional[str] = None
    response_time_ms: Optional[float] = None
    details: Optional[Dict[str, Any]] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class SystemHealth(BaseModel):
    """System resource health."""
    cpu_percent: float
    memory_percent: float
    disk_percent: float
    platform: str
    python_version: str
    uptime_seconds: float


# =============================================================================
# Health Check Response Models
# =============================================================================

class HealthCheckResponse(BaseModel):
    """Comprehensive health check response."""
    status: HealthStatus
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    uptime_seconds: float
    check_duration_ms: float
    components: List[ComponentHealth]
    system: Optional[SystemHealth] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "status": "healthy",
                "timestamp": "2024-11-04T12:00:00Z",
                "uptime_seconds": 3600,
                "check_duration_ms": 150,
                "components": [
                    {
                        "component": "runtime",
                        "status": "healthy",
                        "response_time_ms": 5.2,
                        "details": {"initialized": True}
                    },
                    {
                        "component": "database",
                        "status": "healthy",
                        "response_time_ms": 12.5
                    }
                ],
                "system": {
                    "cpu_percent": 25.4,
                    "memory_percent": 45.2,
                    "disk_percent": 60.1,
                    "platform": "darwin",
                    "python_version": "3.11.5",
                    "uptime_seconds": 3600
                }
            }
        }


class SimpleHealthResponse(BaseModel):
    """Simple health check response."""
    status: str = "ok"
    timestamp: float
    uptime_seconds: float


class DetailedStatusResponse(BaseModel):
    """Detailed server status response."""
    status: str = "ok"
    system: SystemHealth
    resources: Dict[str, Any]
    uptime: Dict[str, Any]

