"""
Common Schemas

Shared Pydantic models used across API endpoints.

@.architecture
Incoming: api/v1/endpoints/*.py --- {JSON payloads, error data, pagination params}
Processing: Pydantic validation and serialization --- {2 jobs: data_validation, serialization}
Outgoing: api/v1/endpoints/*.py --- {SuccessResponse, ErrorResponse, PaginatedResponse, StatusResponse, ValidationErrorResponse validated models}
"""

from typing import Any, Dict, List, Optional, Generic, TypeVar
from datetime import datetime
from enum import Enum
from pydantic import BaseModel, Field


# =============================================================================
# Response Models
# =============================================================================

class SuccessResponse(BaseModel):
    """Generic success response."""
    success: bool = True
    message: Optional[str] = None
    data: Optional[Dict[str, Any]] = None


class ErrorResponse(BaseModel):
    """Error response model."""
    success: bool = False
    error: str
    detail: Optional[str] = None
    code: Optional[str] = None


T = TypeVar('T')

class PaginatedResponse(BaseModel, Generic[T]):
    """Paginated response model."""
    items: List[T]
    total: int
    skip: int
    limit: int
    has_more: bool = False
    
    class Config:
        arbitrary_types_allowed = True


# =============================================================================
# Status Models
# =============================================================================

class HealthStatus(str, Enum):
    """Health status levels."""
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"
    UNKNOWN = "unknown"


class StatusResponse(BaseModel):
    """Generic status response."""
    status: HealthStatus
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    message: Optional[str] = None
    details: Optional[Dict[str, Any]] = None


# =============================================================================
# Request Models
# =============================================================================

class PaginationParams(BaseModel):
    """Pagination parameters."""
    skip: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=1000)


class SearchParams(BaseModel):
    """Search parameters."""
    query: str = Field(..., min_length=1, max_length=500)
    filters: Optional[Dict[str, Any]] = None
    sort_by: Optional[str] = None
    sort_order: str = Field(default="asc", pattern="^(asc|desc)$")


# =============================================================================
# Metadata Models
# =============================================================================

class TimestampMixin(BaseModel):
    """Mixin for timestamp fields."""
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class IdentifierMixin(BaseModel):
    """Mixin for identifier fields."""
    id: str
    name: Optional[str] = None


# =============================================================================
# Validation Models
# =============================================================================

class ValidationError(BaseModel):
    """Validation error detail."""
    field: str
    message: str
    type: str


class ValidationErrorResponse(BaseModel):
    """Validation error response."""
    success: bool = False
    error: str = "Validation Error"
    errors: List[ValidationError]

