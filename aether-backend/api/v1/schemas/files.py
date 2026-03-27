"""
@.architecture
Incoming: api/v1/endpoints/files.py, Frontend requests --- {dict, JSON}
Processing: validate request/response data --- {1 job: JOB_VALIDATE_SCHEMA}
Outgoing: api/v1/endpoints/files.py --- {validated Pydantic models}
"""

from pydantic import BaseModel, Field, validator
from typing import List, Optional, Dict, Any
from datetime import datetime
from uuid import UUID


# ========================================
# Location Management Schemas
# ========================================

class IndexingLocationCreate(BaseModel):
    """Request to create new indexing location."""
    location_name: str = Field(..., min_length=1, max_length=200, description="Display name for location")
    root_path: str = Field(..., min_length=1, description="Absolute path to root directory")
    location_type: str = Field("secondary", description="Location type: 'primary' (indexed first) or 'secondary'")
    scan_interval_minutes: int = Field(15, ge=5, le=1440, description="Scan interval (5-1440 minutes)")
    watch_enabled: bool = Field(True, description="Enable real-time file watching")
    watch_directories: List[str] = Field(default_factory=list, description="High-priority directories for watching")
    allowed_extensions: List[str] = Field(
        default_factory=lambda: ["pdf", "txt", "md", "docx", "xlsx", "pptx", "json", "yaml", "csv"],
        description="Allowed file extensions"
    )
    exclude_patterns: List[str] = Field(
        default_factory=lambda: ["**/.git/**", "**/node_modules/**"],
        description="Exclusion glob patterns"
    )
    chunk_size: int = Field(512, ge=128, le=2048, description="Text chunk size")
    chunk_overlap: int = Field(50, ge=0, le=512, description="Chunk overlap")
    index_mode: str = Field("combined", description="Indexing mode: 'semantic', 'bm25', or 'combined'")
    
    @validator('location_type')
    def validate_location_type(cls, v):
        """Validate location type."""
        if v not in ['primary', 'secondary']:
            raise ValueError("location_type must be 'primary' or 'secondary'")
        return v
    
    @validator('location_name')
    def validate_location_name(cls, v):
        """Sanitize location name."""
        if not v or not v.strip():
            raise ValueError("Location name cannot be empty")
        # Allow alphanumeric, spaces, hyphens, underscores
        clean = v.strip()
        if not all(c.isalnum() or c in ' -_' for c in clean):
            raise ValueError("Location name contains invalid characters")
        return clean
    
    @validator('root_path')
    def validate_root_path(cls, v):
        """Validate root path is absolute."""
        from pathlib import Path
        path = Path(v)
        if not path.is_absolute():
            raise ValueError("Root path must be absolute")
        return str(path)
    
    class Config:
        json_schema_extra = {
            "example": {
                "location_name": "My Documents",
                "root_path": "/Users/username/Documents",
                "scan_interval_minutes": 15,
                "watch_enabled": True,
                "allowed_extensions": ["pdf", "txt", "md"],
                "chunk_size": 512
            }
        }


class IndexingLocationUpdate(BaseModel):
    """Request to update indexing location."""
    location_name: Optional[str] = Field(None, min_length=1, max_length=200)
    location_type: Optional[str] = Field(None, description="Location type: 'primary' or 'secondary'")
    enabled: Optional[bool] = None
    scan_interval_minutes: Optional[int] = Field(None, ge=5, le=1440)
    watch_enabled: Optional[bool] = None
    watch_directories: Optional[List[str]] = None
    allowed_extensions: Optional[List[str]] = None
    exclude_patterns: Optional[List[str]] = None
    chunk_size: Optional[int] = Field(None, ge=128, le=2048)
    chunk_overlap: Optional[int] = Field(None, ge=0, le=512)
    index_mode: Optional[str] = Field(None, description="Indexing mode: 'semantic', 'bm25', or 'combined'")
    
    @validator('location_type')
    def validate_location_type(cls, v):
        """Validate location type."""
        if v is not None and v not in ['primary', 'secondary']:
            raise ValueError("location_type must be 'primary' or 'secondary'")
        return v


class IndexingLocationResponse(BaseModel):
    """Response with location details."""
    id: UUID
    location_name: str
    root_path: str
    location_type: str
    enabled: bool
    index_name: str
    index_directory: str
    scan_interval_minutes: int
    watch_enabled: bool
    watch_directories: List[str]
    allowed_extensions: List[str]
    exclude_patterns: List[str]
    chunk_size: int
    chunk_overlap: int
    index_mode: str
    last_scan_at: Optional[datetime]
    last_scan_status: str
    last_scan_error: Optional[str]
    last_scan_duration_seconds: Optional[int]
    file_count: int
    chunk_count: int
    index_size_bytes: int
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True


# ========================================
# Search Schemas
# ========================================

class FileSearchRequest(BaseModel):
    """Request to search indexed files."""
    query: str = Field(..., min_length=3, max_length=500, description="Search query")
    location_ids: Optional[List[UUID]] = Field(None, description="Filter by locations")
    file_extensions: Optional[List[str]] = Field(None, description="Filter by file types")
    date_from: Optional[datetime] = Field(None, description="Filter by modification date (from)")
    date_to: Optional[datetime] = Field(None, description="Filter by modification date (to)")
    top_k: int = Field(10, ge=1, le=2000, description="Number of results")


class FileSearchResult(BaseModel):
    """Single search result."""
    file_path: str
    file_name: str
    chunk_text: str
    score: float
    file_size: int
    file_extension: str
    creation_date: Optional[datetime]
    modification_date: Optional[datetime]
    location_name: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class FileSearchResponse(BaseModel):
    """Response with search results."""
    results: List[FileSearchResult]
    total_found: int
    search_duration_ms: int
    locations_searched: List[str]


# ========================================
# Health Schemas
# ========================================

class ServiceHealthResponse(BaseModel):
    """Response with service health status."""
    service_status: str
    last_heartbeat: Optional[datetime]
    process_id: Optional[int]
    active_location: Optional[str]
    current_operation: Optional[str]
    operation_progress: Dict[str, Any] = Field(default_factory=dict)
    error_message: Optional[str]
    consecutive_errors: int
    uptime_seconds: Optional[int]


# ========================================
# File Upload Schemas
# ========================================

class FileUploadResponse(BaseModel):
    """Response after file upload."""
    attachment_id: UUID = Field(..., description="ID of created artifact")
    filename: str = Field(..., description="Original filename")
    size: int = Field(..., description="File size in bytes")
    content_type: str = Field(..., description="MIME type")
    created_at: datetime = Field(..., description="Upload timestamp")
    
    class Config:
        from_attributes = True
        json_schema_extra = {
            "example": {
                "attachment_id": "123e4567-e89b-12d3-a456-426614174000",
                "filename": "contract.pdf",
                "size": 1048576,
                "content_type": "application/pdf",
                "created_at": "2026-01-23T00:00:00Z"
            }
        }

