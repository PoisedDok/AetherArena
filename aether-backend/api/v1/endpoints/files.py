"""
@.architecture
Incoming: FastAPI router, Frontend requests --- {HTTP GET/POST/PUT/DELETE to /v1/files/*}
Processing: validate requests, manage file indexing locations, execute searches --- {5 jobs: JOB_HTTP_REQUEST, JOB_QUERY_DB, JOB_ROUTE, JOB_SANITIZE, JOB_SEARCH_INDEX}
Outgoing: Frontend (HTTP), services/daemons/file_indexing/core --- {JSON responses, search results}
"""

from pathlib import Path as PathLib
from typing import List, Optional
from uuid import UUID
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status, UploadFile, File, Form
from fastapi.responses import JSONResponse

from api.dependencies import (
    get_file_service,
    get_daemon_service,
    setup_request_context,
    get_settings,
    require_local_request,
)
from config.settings import Settings
from core.exceptions import DomainException
from application.files.file_service import FileService
from application.daemons.daemon_service import DaemonService
from api.v1.schemas.files import (
    IndexingLocationCreate,
    IndexingLocationUpdate,
    IndexingLocationResponse,
    ServiceHealthResponse,
    FileUploadResponse,
)
from monitoring import get_logger, counter, histogram

logger = get_logger(__name__)
router = APIRouter(
    tags=["files"],
    prefix="/files",
)
# Action-style endpoints for nested context
action_router = APIRouter(
    tags=["file-actions"],
    prefix="/file",
)

# Metrics
file_indexing_requests = counter('aether_file_indexing_requests_total', 'File indexing API requests', ['endpoint', 'status'])
file_search_duration = histogram('aether_file_search_duration_seconds', 'File search duration', ['location'])
file_upload_requests = counter('aether_file_upload_requests_total', 'File upload requests', ['status'])
file_upload_size = histogram('aether_file_upload_size_bytes', 'File upload size distribution')


# ========================================
# File Upload Endpoint
# ========================================

@action_router.post("/upload", response_model=FileUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_file(
    file: UploadFile = File(..., description="File to upload"),
    purpose: str = Form("attachment", description="Purpose: 'attachment', 'document'"),
    chat_id: Optional[str] = Form(None, description="Optional chat ID to associate file with"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> FileUploadResponse:
    """
    Upload a file for processing (attachment, etc).
    """
    try:
        content_bytes = await file.read()
        filename = file.filename or "untitled"
        
        # Record file size metric
        file_size = len(content_bytes)
        file_upload_size.observe(file_size)
        
        result = await file_service.upload_file(
            filename=filename,
            content_bytes=content_bytes,
            content_type=file.content_type or "application/octet-stream",
            purpose=purpose,
            chat_id=chat_id
        )
        
        file_upload_requests.inc(status='success')
        
        return FileUploadResponse(
            attachment_id=UUID(str(result["attachment_id"])),
            filename=result["filename"],
            size=result["size"],
            content_type=result["content_type"],
            created_at=result["created_at"]
        )
        
    except ValueError as e:
        err_msg = str(e)
        if "too large" in err_msg.lower():
            file_upload_requests.inc(status='too_large')
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=err_msg
            )
        elif "empty" in err_msg.lower():
            file_upload_requests.inc(status='empty')
        elif "type not allowed" in err_msg.lower():
            file_upload_requests.inc(status='invalid_type')
        elif "encoding" in err_msg.lower():
            file_upload_requests.inc(status='decode_error')
        else:
            file_upload_requests.inc(status='error')
            
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=err_msg
        )
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        file_upload_requests.inc(status='error')
        logger.error("File upload failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="File upload failed. Check server logs for details."
        )


# ========================================
# Location Management Endpoints
# ========================================

@action_router.get("/location/list", response_model=List[IndexingLocationResponse])
async def get_indexing_locations(
    enabled_only: bool = Query(False, description="Filter to enabled locations only"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> List[IndexingLocationResponse]:
    """
    Get all configured indexing locations.
    
    Returns list of locations with statistics (file count, last scan, etc).
    """
    try:
        locations = await file_service.get_indexing_locations(enabled_only=enabled_only)
        file_indexing_requests.inc(endpoint='get_locations', status='success')
        return [IndexingLocationResponse(**loc) for loc in locations]
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        file_indexing_requests.inc(endpoint='get_locations', status='error')
        logger.error("Failed to get locations: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve locations. Check server logs for details."
        )


@action_router.post("/location/create", response_model=IndexingLocationResponse, status_code=status.HTTP_201_CREATED)
async def create_indexing_location(
    location: IndexingLocationCreate,
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> IndexingLocationResponse:
    """
    Create new indexing location.
    
    User selects directory via frontend file picker, which provides root_path.
    Backend generates index_name and index_directory automatically.
    """
    try:
        create_payload = location.model_dump()
        result = await file_service.create_indexing_location(create_payload)
        
        file_indexing_requests.inc(endpoint='create_location', status='success')
        
        return IndexingLocationResponse(**result)
    
    except ValueError as ve:
        file_indexing_requests.inc(endpoint='create_location', status='error')
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(ve)
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        file_indexing_requests.inc(endpoint='create_location', status='error')
        logger.error("Failed to create location: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create location. Check server logs for details."
        )


@action_router.get("/location/get/{location_id}", response_model=IndexingLocationResponse)
async def get_indexing_location(
    location_id: UUID = Path(..., description="Location ID"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> IndexingLocationResponse:
    """Get single indexing location by ID."""
    try:
        location = await file_service.get_indexing_location(location_id)
        
        if not location:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Location not found: {location_id}"
            )
        
        file_indexing_requests.inc(endpoint='get_location', status='success')
        return IndexingLocationResponse(**location)
    
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        file_indexing_requests.inc(endpoint='get_location', status='error')
        logger.error("Failed to get location %s: %s", location_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve location. Check server logs for details."
        )


@action_router.put("/location/update/{location_id}", response_model=IndexingLocationResponse)
async def update_indexing_location(
    location_id: UUID = Path(..., description="Location ID"),
    updates: IndexingLocationUpdate = None,
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> IndexingLocationResponse:
    """Update indexing location configuration."""
    try:
        # Update only provided fields
        update_data = updates.model_dump(exclude_unset=True)
        if not update_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No update fields provided"
            )
        
        result = await file_service.update_indexing_location(location_id, update_data)
        
        file_indexing_requests.inc(endpoint='update_location', status='success')
        
        return IndexingLocationResponse(**result)
    
    except ValueError as ve:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(ve)
        )
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        file_indexing_requests.inc(endpoint='update_location', status='error')
        logger.error("Failed to update location %s: %s", location_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update location. Check server logs for details."
        )


@action_router.delete("/location/delete/{location_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_indexing_location(
    location_id: UUID = Path(..., description="Location ID"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> None:
    """Delete indexing location (cascades to indexed files)."""
    try:
        await file_service.delete_indexing_location(location_id)
        
        file_indexing_requests.inc(endpoint='delete_location', status='success')
        
    except ValueError as ve:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(ve)
        )
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        file_indexing_requests.inc(endpoint='delete_location', status='error')
        logger.error("Failed to delete location %s: %s", location_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete location. Check server logs for details."
        )


@action_router.get("/location/active-job/{location_id}")
async def get_active_job_for_location(
    location_id: UUID = Path(..., description="Location ID"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get active reindex job for a location.
    Returns job info if there's a running/queued/paused job.
    """
    try:
        job = await file_service.get_active_reindex_job(location_id)
        jobs = [job] if job else []
        
        if jobs and len(jobs) > 0:
            job = jobs[0]  # Get most recent
            return JSONResponse(
                status_code=status.HTTP_200_OK,
                content={
                    "job_id": job['id'],
                    "status": job['status'],
                    "progress_phase": job.get('progress_phase'),
                    "files_scanned": job.get('files_scanned', 0),
                    "files_total": job.get('files_total', 0)
                }
            )
        # No active job is a normal state; return 200 with a null job_id so clients
        # can poll without creating noisy 404s in devtools/network logs.
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"job_id": None}
        )
            
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get active job for location %s: %s", location_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get active job. Check server logs for details."
        )

@action_router.post("/location/reindex/{location_id}")
async def trigger_manual_reindex(
    location_id: UUID = Path(..., description="Location ID"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> JSONResponse:
    """
    Trigger async reindex for a location.
    Returns job_id for progress tracking immediately.
    """
    try:
        result = await file_service.trigger_manual_reindex(location_id)
        
        file_indexing_requests.inc(endpoint='reindex', status='queued')
        
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content=result
        )
        
    except ValueError as ve:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(ve)
        )
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        file_indexing_requests.inc(endpoint='reindex', status='error')
        logger.error("Failed to queue reindex for location %s: %s", location_id, e, exc_info=True)
        
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to queue reindex. Check server logs for details."
        )


@action_router.get("/reindex/status/{job_id}")
async def get_reindex_job_status(
    job_id: UUID = Path(..., description="Job ID"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> JSONResponse:
    """Get real-time status of a reindex job."""
    try:
        job_status = await file_service.get_reindex_job_status(job_id)
        
        if not job_status:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Job not found: {job_id}"
            )
        
        # Calculate progress percentage
        progress_percent = 0
        if job_status.get('files_total', 0) > 0:
            progress_percent = int(
                (job_status.get('files_scanned', 0) / job_status['files_total']) * 100
            )
        
        return JSONResponse(content={
            "job_id": job_status['id'],
            "location_id": job_status['location_id'],
            "location_name": job_status['location_name'],
            "status": job_status['status'],
            "progress_phase": job_status['progress_phase'],
            "progress_percent": progress_percent,
            "files_scanned": job_status.get('files_scanned', 0),
            "files_total": job_status.get('files_total', 0),
            "chunks_processed": job_status.get('chunks_processed', 0),
            "error_message": job_status.get('error_message'),
            "started_at": job_status.get('started_at'),
            "completed_at": job_status.get('completed_at'),
            "created_at": job_status.get('created_at'),
            "updated_at": job_status.get('updated_at')
        })
        
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get job status for %s: %s", job_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get job status. Check server logs for details."
        )


@action_router.post("/reindex/pause/{job_id}")
async def pause_reindex_job(
    job_id: UUID = Path(..., description="Job ID"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> JSONResponse:
    """Pause a running reindex job (saves checkpoint)."""
    try:
        await file_service.pause_reindex_job(job_id)
        
        return JSONResponse(content={
            "success": True,
            "message": "Job paused successfully"
        })
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to pause job %s: %s", job_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to pause job. Check server logs for details."
        )

@action_router.post("/reindex/resume/{job_id}")
async def resume_reindex_job(
    job_id: UUID = Path(..., description="Job ID"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> JSONResponse:
    """Resume a paused reindex job (restores from checkpoint)."""
    try:
        await file_service.resume_reindex_job(job_id)
        
        return JSONResponse(content={
            "success": True,
            "message": "Job resumed successfully"
        })
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to resume job %s: %s", job_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to resume job. Check server logs for details."
        )

@action_router.post("/reindex/stop/{job_id}")
async def stop_reindex_job(
    job_id: UUID = Path(..., description="Job ID"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> JSONResponse:
    """Stop a reindex job (saves checkpoint, can be resumed later)."""
    try:
        await file_service.stop_reindex_job(job_id)
        
        return JSONResponse(content={
            "success": True,
            "message": "Job stopped successfully (can be resumed)"
        })
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to stop job %s: %s", job_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to stop job. Check server logs for details."
        )

@action_router.delete("/reindex/cancel/{job_id}")
async def cancel_reindex_job(
    job_id: UUID = Path(..., description="Job ID"),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> JSONResponse:
    """Cancel a running reindex job (discards progress, cannot be resumed)."""
    try:
        await file_service.cancel_reindex_job(job_id)
        
        return JSONResponse(content={
            "success": True,
            "message": "Job cancelled (progress discarded)"
        })
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to cancel job %s: %s", job_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to cancel job. Check server logs for details."
        )


# ========================================
# Health Endpoint
# ========================================

@action_router.get("/health", response_model=ServiceHealthResponse)
async def get_indexing_service_health(
    daemon_service: DaemonService = Depends(get_daemon_service),
    file_service: FileService = Depends(get_file_service),
    _context = Depends(setup_request_context)
) -> ServiceHealthResponse:
    """Get indexing service health status."""
    try:
        health = await daemon_service.get_service_health()
        
        if not health:
            # Service never started
            return ServiceHealthResponse(
                service_status="stopped",
                last_heartbeat=None,
                process_id=None,
                active_location=None,
                current_operation=None,
                error_message=None,
                consecutive_errors=0,
                uptime_seconds=None
            )
        
        # Calculate uptime
        from datetime import datetime, timezone
        if health.get('last_heartbeat'):
            last_heartbeat = datetime.fromisoformat(health['last_heartbeat'])
            now = datetime.now(timezone.utc)
            # Make both timezone-aware for comparison
            if last_heartbeat.tzinfo is None:
                last_heartbeat = last_heartbeat.replace(tzinfo=timezone.utc)
            uptime = (now - last_heartbeat).total_seconds()
        else:
            uptime = None
        
        file_indexing_requests.inc(endpoint='health', status='success')
        
        active_location = None
        active_location_id = health.get("active_location_id")
        if active_location_id:
            location = await file_service.get_indexing_location(UUID(active_location_id))
            if location:
                active_location = location.get("location_name")
        
        return ServiceHealthResponse(
            service_status=health['service_status'],
            last_heartbeat=health.get('last_heartbeat'),
            process_id=health.get('process_id'),
            active_location=active_location,
            current_operation=health.get('current_operation'),
            operation_progress=health.get('operation_progress', {}),
            error_message=health.get('error_message'),
            consecutive_errors=health.get('consecutive_errors', 0),
            uptime_seconds=int(uptime) if uptime else None
        )
    
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        file_indexing_requests.inc(endpoint='health', status='error')
        logger.error("Failed to get health: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve health status. Check server logs for details."
        )


# ========================================
# Daemon Control Endpoints
# ========================================

@action_router.get("/daemon/status")
async def get_daemon_status(
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """
    Get file indexing daemon status.
    """
    try:
        health = await daemon_service.get_service_health()
        
        if not health:
            return JSONResponse({
                "running": False,
                "error": "Daemon not initialized or never started"
            })
        
        # Check if daemon is running (heartbeat within last 2 minutes)
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        last_heartbeat = health.get('last_heartbeat')
        
        is_running = False
        uptime_seconds = None
        
        if last_heartbeat:
            # Handle string timestamps from database
            if isinstance(last_heartbeat, str):
                from dateutil.parser import parse as parse_date
                last_heartbeat = parse_date(last_heartbeat)
            
            if last_heartbeat.tzinfo is None:
                last_heartbeat = last_heartbeat.replace(tzinfo=timezone.utc)
            
            time_since_heartbeat = (now - last_heartbeat).total_seconds()
            is_running = time_since_heartbeat < 120  # 2 minutes threshold
            
            if is_running:
                # Calculate uptime from daemon start (created_at) not last heartbeat
                created_at = health.get('created_at')
                if created_at:
                    if isinstance(created_at, str):
                        from dateutil.parser import parse as parse_date
                        created_at = parse_date(created_at)
                    if created_at.tzinfo is None:
                        created_at = created_at.replace(tzinfo=timezone.utc)
                    uptime_seconds = int((now - created_at).total_seconds())
                else:
                    # Fallback if no created_at
                    uptime_seconds = None
        
        return JSONResponse({
            "running": is_running,
            "uptime_seconds": uptime_seconds,
            "process_id": health.get('process_id'),
            "last_heartbeat": last_heartbeat.isoformat() if last_heartbeat else None,
            "service_status": health.get('service_status'),
            "current_operation": health.get('current_operation'),
        })
    
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get daemon status: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve daemon status. Check server logs for details."
        )


@action_router.get("/daemon/config")
async def get_daemon_config(
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """
    Get all proactive daemon configurations.
    """
    try:
        return JSONResponse(await daemon_service.get_daemon_config())
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get daemon config: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve daemon configuration. Check server logs for details."
        )


from pydantic import BaseModel as PydanticBaseModel, field_validator

# --- Pydantic schemas for daemon config update (typed + validated) ---

_ALLOWED_BROWSERS = {"chrome", "edge", "chromium"}
_ALLOWED_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
_MAX_WATCH_LOCATIONS = 20
# System-critical path prefixes that must never be watched
_FORBIDDEN_WATCH_PREFIXES = (
    "/System", "/Library/LaunchDaemons", "/Library/LaunchAgents",
    "/usr/bin", "/usr/sbin", "/usr/lib", "/bin", "/sbin",
    "/private/var/db", "/private/var/run", "/private/etc",
    "/private/tmp", "/tmp", "/var/tmp",
    "/etc", "/var/run", "/proc", "/sys", "/dev",
)


class BrowserDaemonConfigUpdate(PydanticBaseModel):
    browser: Optional[str] = None
    auto_detect_profiles: Optional[bool] = None
    excluded_profiles: Optional[List[str]] = None
    scan_interval_seconds: Optional[int] = None
    log_level: Optional[str] = None

    @field_validator("browser")
    @classmethod
    def validate_browser(cls, v):
        if v is not None and v not in _ALLOWED_BROWSERS:
            raise ValueError(f"browser must be one of {_ALLOWED_BROWSERS}, got '{v}'")
        return v

    @field_validator("scan_interval_seconds")
    @classmethod
    def validate_interval(cls, v):
        if v is not None and v < 1:
            raise ValueError("scan_interval_seconds must be >= 1")
        return v

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, v):
        if v is not None and v.upper() not in _ALLOWED_LOG_LEVELS:
            raise ValueError(f"log_level must be one of {_ALLOWED_LOG_LEVELS}")
        return v.upper() if v else v


class EmailDaemonConfigUpdate(PydanticBaseModel):
    scan_interval_seconds: Optional[int] = None
    max_emails_per_scan: Optional[int] = None
    log_level: Optional[str] = None

    @field_validator("scan_interval_seconds")
    @classmethod
    def validate_interval(cls, v):
        if v is not None and v < 1:
            raise ValueError("scan_interval_seconds must be >= 1")
        return v

    @field_validator("max_emails_per_scan")
    @classmethod
    def validate_max_emails(cls, v):
        if v is not None and (v < 1 or v > 500):
            raise ValueError("max_emails_per_scan must be between 1 and 500")
        return v


class FilesystemDaemonConfigUpdate(PydanticBaseModel):
    watch_locations: Optional[List[str]] = None
    debounce_seconds: Optional[int] = None
    log_level: Optional[str] = None

    @field_validator("watch_locations")
    @classmethod
    def validate_watch_locations(cls, v):
        if v is None:
            return v
        if len(v) > _MAX_WATCH_LOCATIONS:
            raise ValueError(f"Maximum {_MAX_WATCH_LOCATIONS} watch locations allowed")
        validated = []
        for loc in v:
            if not isinstance(loc, str) or not loc.strip():
                continue
            resolved = PathLib(loc).expanduser().resolve()
            resolved_str = str(resolved)
            # Reject system-critical paths
            for prefix in _FORBIDDEN_WATCH_PREFIXES:
                if resolved_str == prefix or resolved_str.startswith(prefix + "/"):
                    raise ValueError(f"Cannot watch system path: {loc}")
            # Reject root directory
            if resolved_str == "/":
                raise ValueError("Cannot watch root filesystem")
            validated.append(loc)
        return validated


class QueryGenerationDaemonConfigUpdate(PydanticBaseModel):
    enabled: Optional[bool] = None
    check_interval_seconds: Optional[int] = None
    context_size: Optional[int] = None
    log_level: Optional[str] = None

    @field_validator("check_interval_seconds")
    @classmethod
    def validate_interval(cls, v):
        if v is not None and v < 1:
            raise ValueError("check_interval_seconds must be >= 1")
        return v


class FileIndexingDaemonConfigUpdate(PydanticBaseModel):
    """Typed config for the file_indexing_config singleton table.

    Schema mirrors migration 006 columns (minus id, created_at, updated_at
    which are system-managed and must never be set by the client).
    """
    aether_rag_embedding_model: Optional[str] = None
    heartbeat_interval_seconds: Optional[int] = None
    scan_check_interval_seconds: Optional[int] = None
    max_concurrent_scans: Optional[int] = None
    log_level: Optional[str] = None

    @field_validator("aether_rag_embedding_model")
    @classmethod
    def validate_embedding_model(cls, v):
        if v is not None:
            v = v.strip()
            if not v:
                raise ValueError("aether_rag_embedding_model must be a non-empty string")
            if len(v) > 200:
                raise ValueError("aether_rag_embedding_model exceeds 200 character limit")
        return v

    @field_validator("heartbeat_interval_seconds")
    @classmethod
    def validate_heartbeat(cls, v):
        if v is not None and v < 1:
            raise ValueError("heartbeat_interval_seconds must be >= 1")
        return v

    @field_validator("scan_check_interval_seconds")
    @classmethod
    def validate_scan_interval(cls, v):
        if v is not None and v < 1:
            raise ValueError("scan_check_interval_seconds must be >= 1")
        return v

    @field_validator("max_concurrent_scans")
    @classmethod
    def validate_max_scans(cls, v):
        if v is not None and (v < 1 or v > 10):
            raise ValueError("max_concurrent_scans must be between 1 and 10")
        return v

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, v):
        if v is not None and v.upper() not in _ALLOWED_LOG_LEVELS:
            raise ValueError(f"log_level must be one of {_ALLOWED_LOG_LEVELS}")
        return v.upper() if v else v


class DaemonConfigUpdateRequest(PydanticBaseModel):
    """Typed request for updating daemon configurations.

    Each daemon section is optional — only provided daemons are updated.
    All fields are validated at the Pydantic level before reaching business logic.
    """
    browser: Optional[BrowserDaemonConfigUpdate] = None
    email: Optional[EmailDaemonConfigUpdate] = None
    filesystem: Optional[FilesystemDaemonConfigUpdate] = None
    file_indexing: Optional[FileIndexingDaemonConfigUpdate] = None
    query_generation: Optional[QueryGenerationDaemonConfigUpdate] = None


@action_router.post("/daemon/config")
async def update_daemon_config(
    config: DaemonConfigUpdateRequest,
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """
    Update proactive daemon configurations.
    """
    try:
        # Convert request body to dictionary
        config_dict = config.model_dump(exclude_none=True)
        result = await daemon_service.update_daemon_config(config_dict)
        return JSONResponse(result)
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to update daemon config: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update daemon configuration. Check server logs for details."
        )


@action_router.post("/daemon/restart")
async def restart_daemon(
    request: Request,
    daemon_service: DaemonService = Depends(get_daemon_service),
    settings = Depends(get_settings),
    _context = Depends(setup_request_context)
):
    """
    Request daemon restart by sending SIGTERM signal.
    """
    from core.exceptions import ProcessLookupDomainError, PermissionDomainError, DaemonControlError
    
    try:
        require_local_request(request, settings)
        if not settings.security.allow_local_os_tools:
            return JSONResponse({
                "success": False,
                "message": "Daemon control disabled by configuration"
            }, status_code=403)
        
        # Get daemon PID from health table
        health = await daemon_service.get_service_health()
        if not health:
            return JSONResponse({
                "success": False,
                "message": "Daemon not running or health data unavailable"
            }, status_code=200)
        
        pid = health.get('process_id')
        if not pid:
            return JSONResponse({
                "success": False,
                "message": "Daemon PID not found in health data"
            }, status_code=200)
        
        # Try to send SIGTERM to the daemon process
        try:
            await daemon_service.restart_daemon(pid)
            logger.info("Sent SIGTERM to daemon process %s", pid)
            return JSONResponse({
                "success": True,
                "message": f"Restart signal sent to daemon (PID {pid}). If managed by launchd/systemd, it will restart automatically in a few seconds."
            })
        except ProcessLookupDomainError:
            return JSONResponse({
                "success": False,
                "message": f"Process {pid} not found. Daemon may have already stopped."
            }, status_code=200)
        except PermissionDomainError:
            return JSONResponse({
                "success": False,
                "message": f"Permission denied to restart daemon (PID {pid}). May need elevated privileges."
            }, status_code=200)
        except DaemonControlError as e:
            return JSONResponse({
                "success": False,
                "message": f"Restart failed: {str(e)}"
            }, status_code=200)
            
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Restart failed: %s", e, exc_info=True)
        return JSONResponse({
            "success": False,
            "message": "Restart failed. Check server logs for details."
        }, status_code=200)


@action_router.post("/daemon/stop")
async def stop_daemon(
    request: Request,
    daemon_service: DaemonService = Depends(get_daemon_service),
    settings = Depends(get_settings),
    _context = Depends(setup_request_context)
):
    """Stop the daemon by unloading the launchd service (macOS) or stopping the process (Windows)."""
    from core.exceptions import DaemonControlError
    
    try:
        require_local_request(request, settings)
        if not settings.security.allow_local_os_tools:
            return JSONResponse({
                "success": False,
                "message": "Daemon control disabled by configuration"
            }, status_code=403)
        
        try:
            await daemon_service.stop_daemon("fileindexing")
            return JSONResponse({"success": True, "message": "Daemon stopped successfully"})
        except DaemonControlError as e:
            return JSONResponse({"success": False, "message": f"Stop failed: {str(e)}"}, status_code=200)
            
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Stop failed: %s", e, exc_info=True)
        return JSONResponse({"success": False, "message": "Stop failed. Check server logs for details."}, status_code=200)


@action_router.post("/daemon/start")
async def start_daemon(
    request: Request,
    daemon_service: DaemonService = Depends(get_daemon_service),
    settings = Depends(get_settings),
    _context = Depends(setup_request_context)
):
    """Start the daemon by loading the launchd service (macOS) or creating a task (Windows)."""
    import sys
    from pathlib import Path
    from core.exceptions import DaemonControlError
    
    try:
        require_local_request(request, settings)
        if not settings.security.allow_local_os_tools:
            return JSONResponse({
                "success": False,
                "message": "Daemon control disabled by configuration"
            }, status_code=403)
        
        backend_root = Path(settings.config_dir).parent
        is_frozen = getattr(sys, 'frozen', False)
        executable_path = sys.executable
        
        try:
            await daemon_service.start_daemon("fileindexing", backend_root, executable_path, is_frozen)
            return JSONResponse({"success": True, "message": "Daemon started successfully"})
        except DaemonControlError as e:
            return JSONResponse({"success": False, "message": f"Start failed: {str(e)}"}, status_code=200)
            
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Start failed: %s", e, exc_info=True)
        return JSONResponse({"success": False, "message": "Start failed. Check server logs for details."}, status_code=200)


# ========================================
# Daemon Data Access Endpoints
# ========================================

def _normalize_daemon_search_name(daemon_name: str) -> str:
    """Normalize daemon search aliases to canonical BM25 daemon keys."""
    _DAEMON_SEARCH_NAME_ALIASES = {
        "query_generation": "query_gen",
    }
    normalized = daemon_name.strip().lower()
    return _DAEMON_SEARCH_NAME_ALIASES.get(normalized, normalized)


def _get_daemon_index_path(settings: Settings, daemon_name: str) -> PathLib:
    """Get the BM25 index path for a daemon."""
    canonical_daemon_name = _normalize_daemon_search_name(daemon_name)
    index_path = settings.app_root / "data" / "indexes" / f"{canonical_daemon_name}_bm25"
    return index_path


@action_router.get("/daemon/{daemon_name}/logs")
async def get_daemon_logs(
    daemon_name: str,
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of logs to return"),
    hours_back: Optional[int] = Query(None, ge=1, le=168, description="Filter logs from last N hours"),
    only_unindexed: bool = Query(False, description="Return only unindexed logs"),
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """
    Query raw logs from a daemon's SQLite database.
    
    Supported daemons: browser, email, filesystem
    """
    if daemon_name not in ["browser", "email", "filesystem"]:
        raise HTTPException(status_code=400, detail=f"Invalid daemon name: {daemon_name}")
    
    try:
        logs = daemon_service.get_logs(
            daemon_name=daemon_name,
            limit=limit,
            hours_back=hours_back,
            only_unindexed=only_unindexed
        )
        
        return {
            "daemon": daemon_name,
            "count": len(logs),
            "logs": logs,
            "filters": {
                "limit": limit,
                "hours_back": hours_back,
                "only_unindexed": only_unindexed
            }
        }
        
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Daemon database not found: {daemon_name}")
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to query %s logs: %s", daemon_name, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to query logs. Check server logs for details.")


@action_router.get("/daemon/{daemon_name}/search")
async def search_daemon_index(
    daemon_name: str,
    query: str = Query(..., min_length=1, description="Search query"),
    top_k: int = Query(10, ge=1, le=100, description="Number of results to return"),
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """
    Search a daemon's BM25 index.
    """
    try:
        return await daemon_service.search_legacy_daemon_index(daemon_name, query, top_k)
    except (HTTPException, DomainException):
        raise
    except ValueError as e:
        logger.warning("Invalid search request in search_daemon_index: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Failed to search %s index: %s", daemon_name, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Search failed. Check server logs for details."
        )


@action_router.get("/daemon/stats")
async def get_all_daemon_stats(
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """
    Get statistics from all daemon databases.
    """
    try:
        stats = daemon_service.get_all_stats()
        
        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "daemons": stats
        }
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get all daemon stats: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve daemon stats. Check server logs for details.")


@action_router.get("/daemon/query_generation/queries")
async def get_generated_queries(
    hours_back: int = Query(24, ge=1, le=168, description="Get queries from last N hours"),
    source_daemon: Optional[str] = Query(None, description="Filter by source daemon"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of queries to return"),
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """
    Get generated queries from query generation daemon.
    """
    try:
        results = await daemon_service.get_generated_queries(hours_back=hours_back, source_daemon=source_daemon, limit=limit)
        
        return {
            "count": len(results),
            "queries": results,
            "filters": {
                "hours_back": hours_back,
                "source_daemon": source_daemon,
                "limit": limit
            }
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to query generated queries: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to query. Check server logs for details.")


@action_router.get("/daemon/query_generation/stats")
async def get_query_generation_stats(
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """Get statistics from query generation daemon."""
    try:
        return await daemon_service.get_query_generation_stats()
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get query generation stats: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to get stats. Check server logs for details.")


@action_router.delete("/daemon/{daemon_name}/data")
async def delete_daemon_data(
    daemon_name: str,
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """
    Delete all data for a specific daemon (logs + BM25 index).
    """
    try:
        valid_daemons = ["browser", "email", "filesystem", "query_generation"]
        if daemon_name not in valid_daemons:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid daemon name. Must be one of: {valid_daemons}"
            )
        
        deleted_items = await daemon_service.delete_daemon_data(daemon_name)
        
        if not deleted_items:
            return JSONResponse({
                "success": True,
                "message": f"No data found for {daemon_name}",
                "deleted_items": []
            })
        
        return JSONResponse({
            "success": True,
            "message": f"Deleted all data for {daemon_name}",
            "deleted_items": deleted_items
        })
        
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to delete daemon data: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete data. Check server logs for details.")


@action_router.delete("/daemon/data/all")
async def delete_all_daemon_data(
    daemon_service: DaemonService = Depends(get_daemon_service),
    _context = Depends(setup_request_context)
):
    """
    Delete ALL daemon data (logs + BM25 indexes for all daemons).
    Use with caution - this is a full reset.
    """
    try:
        deleted_items = await daemon_service.delete_all_daemon_data()
        
        return JSONResponse({
            "success": True,
            "message": f"Deleted all daemon data ({len(deleted_items)} items)",
            "deleted_items": deleted_items
        })
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to delete all daemon data: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete all daemon data. Check server logs for details.")

