"""
Source Ingestion Endpoints

@.architecture
Incoming: Frontend HTTP requests --- {POST/GET /v1/sources/*}
Processing: validate settings, run local source ingestion, build AETHER_RAG indexes --- {JOB_VALIDATE_CONFIG, JOB_LOAD_DATA, JOB_BUILD_INDEX}
Outgoing: Frontend --- {JSON responses with index metadata}
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, status, Query
from pydantic import BaseModel, Field, field_validator

from api.dependencies import (
    get_runtime_settings,
    get_source_indexing_service,
    setup_request_context,
)
from application.services.source_indexing_service import SourceIndexingService
from config.settings import Settings
from monitoring import get_logger

logger = get_logger(__name__)

router = APIRouter(
    prefix="/sources",
    tags=["sources"],
)


class BrowserHistoryIndexRequest(BaseModel):
    index_name: Optional[str] = Field(None, description="Optional index name override")
    browser: str = Field("edge", description="Browser: edge|chrome|chromium")
    profile_path: Optional[str] = Field(None, description="Explicit browser profile directory (contains History DB)")
    auto_find_profiles: Optional[bool] = Field(None, description="Auto-detect browser profiles")
    max_items: Optional[int] = Field(None, ge=1, le=100000)
    force_rebuild: bool = Field(False, description="Overwrite existing index if present")
    build_semantic: bool = Field(False, description="Build semantic vector index")
    build_bm25: bool = Field(True, description="Build BM25 keyword index")


class SourceIndexResponse(BaseModel):
    success: bool
    index: Dict[str, Any]


class BrowserHistoryDiscoverRequest(BaseModel):
    browser: str = Field("edge", description="Browser: edge|chrome|chromium")
    user_data_dir: Optional[str] = Field(None, description="Optional override for browser User Data directory")


class BrowserProfileInfo(BaseModel):
    profile_name: str
    profile_path: str
    history_db_exists: bool
    estimated_entries: int
    estimated_size_mb: float
    last_modified: Optional[str]


class BrowserHistoryDiscoverResponse(BaseModel):
    success: bool
    browser: str
    user_data_dir: str
    profiles: List[BrowserProfileInfo]
    total_estimated_entries: int



class EmailIndexRequest(BaseModel):
    index_name: Optional[str] = Field(None, description="Optional index name override")
    source_path: Optional[str] = Field(None, description="Directory of .eml files or a single .mbox file")
    max_items: Optional[int] = Field(None, ge=1, le=100000)
    force_rebuild: bool = Field(False, description="Overwrite existing index if present")
    build_semantic: bool = Field(False, description="Build semantic vector index")
    build_bm25: bool = Field(True, description="Build BM25 keyword index")


class CustomIndexRequest(BaseModel):
    """Request to build a custom user source index from local file paths."""
    file_paths: List[str] = Field(..., min_length=1, description="Local file/directory/zip paths from native dialog")
    index_name: str = Field(..., min_length=1, max_length=100, description="Human-friendly source name")
    display_name: str = Field(..., min_length=1, max_length=200, description="Display name shown in UI")
    index_mode: List[str] = Field(
        default_factory=lambda: ["semantic"],
        description="Index mode array: ['semantic'], ['bm25'], or both",
    )
    chunk_size: Optional[int] = Field(None, ge=128, le=2048, description="Text chunk size")
    chunk_overlap: Optional[int] = Field(None, ge=0, le=512, description="Chunk overlap")
    force_rebuild: bool = Field(False, description="Overwrite existing index if present")

    @field_validator("index_mode")
    @classmethod
    def _validate_index_mode(cls, v: List[str]) -> List[str]:
        if not v:
            raise ValueError("index_mode must contain at least one mode")
        for mode in v:
            if mode not in ("semantic", "bm25"):
                raise ValueError(f"Invalid mode '{mode}'. Allowed: 'semantic', 'bm25'")
        return v


class CustomIndexResponse(BaseModel):
    """Response for async custom index build (returns immediately)."""
    success: bool
    index_name: str
    state: str
    files_total: int
    job_id: Optional[str] = None


class IndexStatusResponse(BaseModel):
    """Response for polling index build progress."""
    index_name: str
    state: str
    progress_pct: int
    files_total: int
    files_processed: int
    files_skipped: int = 0
    chunk_count: int
    error: Optional[str] = None


class DeleteIndexResponse(BaseModel):
    """Response for deleting a source index."""
    success: bool
    index_name: str
    deleted: Optional[Dict[str, Any]] = None


class ActivityLogRequest(BaseModel):
    url: str = Field(..., description="Structured identifier (e.g. aether://index/idx/doc or aether://notes/name)")
    title: str = Field(..., description="Title of document or note")
    text_content: str = Field(..., description="Abstract or typed note content")


class ActivityLogResponse(BaseModel):
    success: bool
    log_id: Optional[int] = None


@router.get("", summary="List Sources")
def list_sources(
    settings: Settings = Depends(get_runtime_settings),
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> Dict[str, Any]:
    """List available source integrations, registered indexes, and supported browsers.

    The ``supported_browsers`` field is the SSOT for the browser-kind dropdown
    in the frontend settings page — it must never be hardcoded in the HTML.
    """
    result = service.describe_sources()

    # Dynamic browser options — only Chromium-based browsers are actually supported
    # by chromium_history.py (edge|chrome|chromium).
    result["supported_browsers"] = [
        {"value": "edge", "label": "Microsoft Edge"},
        {"value": "chrome", "label": "Google Chrome"},
        {"value": "chromium", "label": "Chromium"},
    ]

    return result


@router.post("/browser-history/discover", response_model=BrowserHistoryDiscoverResponse, summary="Discover Browser Profiles")
def discover_browser_profiles(
    request: BrowserHistoryDiscoverRequest,
    settings: Settings = Depends(get_runtime_settings),
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> BrowserHistoryDiscoverResponse:
    """Discover available browser profiles WITHOUT indexing - preview what data exists."""
    try:
        result = service.discover_browser_profiles(
            browser=request.browser,
            user_data_dir_override=request.user_data_dir,
        )
        return BrowserHistoryDiscoverResponse(**result)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Browser profile discovery failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Browser profile discovery failed: {exc}",
        ) from exc


@router.post("/browser-history/index", response_model=CustomIndexResponse, summary="Build Browser History Index")
async def build_browser_history_index(
    request: BrowserHistoryIndexRequest,
    settings: Settings = Depends(get_runtime_settings),
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> CustomIndexResponse:
    """Build or rebuild a Chromium browser history index (Edge preferred)."""
    if not settings.security.allow_local_os_tools:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Browser history ingestion disabled by configuration",
        )

    try:
        job = await service.build_browser_history_index(
            index_name=request.index_name,
            browser=request.browser,
            profile_path=request.profile_path,
            auto_find_profiles=request.auto_find_profiles,
            max_items=request.max_items,
            force_rebuild=request.force_rebuild,
            build_semantic=request.build_semantic,
            build_bm25=request.build_bm25,
        )
        return CustomIndexResponse(
            success=True,
            index_name=job["index_name"],
            state=job["state"],
            files_total=job["files_total"],
            job_id=job.get("job_id"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Browser history index build failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Browser history index build failed: {exc}",
        ) from exc


@router.post("/email/index", response_model=CustomIndexResponse, summary="Build Email Index")
async def build_email_index(
    request: EmailIndexRequest,
    settings: Settings = Depends(get_runtime_settings),
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> CustomIndexResponse:
    """Build or rebuild an email index from local .eml/.mbox."""
    if not settings.security.allow_local_os_tools:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Email ingestion disabled by configuration",
        )

    try:
        job = await service.build_email_index(
            index_name=request.index_name,
            source_path=request.source_path,
            max_items=request.max_items,
            force_rebuild=request.force_rebuild,
            build_semantic=request.build_semantic,
            build_bm25=request.build_bm25,
        )
        return CustomIndexResponse(
            success=True,
            index_name=job["index_name"],
            state=job["state"],
            files_total=job["files_total"],
            job_id=job.get("job_id"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Email index build failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Email index build failed: {exc}",
        ) from exc


# =============================================================================
# Custom User Source Indexing (files/folders/zips from native dialog)
# =============================================================================

@router.post("/custom/index", response_model=CustomIndexResponse, summary="Build Custom Source Index")
async def build_custom_index(
    request: CustomIndexRequest,
    settings: Settings = Depends(get_runtime_settings),
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> CustomIndexResponse:
    """
    Start building a custom source index from user-selected files, folders, or ZIP archives.

    Returns immediately with job status.  Poll GET /v1/sources/index-status/{index_name}
    for progress.  Indexing runs in the background so the user is never blocked.
    """
    try:
        job = await service.build_custom_index(
            file_paths=request.file_paths,
            index_name=request.index_name,
            display_name=request.display_name,
            index_mode=request.index_mode,
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
            force_rebuild=request.force_rebuild,
        )
        return CustomIndexResponse(
            success=True,
            index_name=job["index_name"],
            state=job["state"],
            files_total=job["files_total"],
            job_id=job.get("job_id"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Custom index build failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Custom index build failed: {exc}",
        ) from exc


@router.get("/index-status/{index_name}", response_model=IndexStatusResponse, summary="Get Index Build Status")
def get_index_status(
    index_name: str = PathParam(..., description="Index name to check status for"),
    settings: Settings = Depends(get_runtime_settings),
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> IndexStatusResponse:
    """
    Poll the progress of a background indexing job.

    States: queued -> processing -> completed | failed.
    If the index_name is not found in active jobs, checks the registry
    for a previously completed index.
    """
    result = service.get_index_status(index_name)
    return IndexStatusResponse(**result)


@router.get("/active-jobs", summary="List Active Indexing Jobs")
def list_active_indexing_jobs(
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> List[Dict[str, Any]]:
    """
    Return all in-flight indexing jobs (queued or processing).

    The frontend calls this on modal open to recover progress visibility
    for jobs that were started in a previous modal session but haven't
    completed yet.
    """
    return service.list_active_jobs()


@router.delete("/{index_name}", response_model=DeleteIndexResponse, summary="Delete Source Index")
def delete_source_index(
    index_name: str = PathParam(..., description="Index name to delete"),
    settings: Settings = Depends(get_runtime_settings),
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> DeleteIndexResponse:
    """
    Delete a registered source index.  Removes both index files from disk
    and the entry from the source registry.
    """
    try:
        result = service.delete_index(index_name)
        return DeleteIndexResponse(
            success=True,
            index_name=index_name,
            deleted=result.get("deleted"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Source index deletion failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Source index deletion failed: {exc}",
        ) from exc


@router.post("/activity/log", response_model=ActivityLogResponse, summary="Log UI Activity for Proactive Agent")
def log_activity(
    request: ActivityLogRequest,
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> ActivityLogResponse:
    """
    Receive telemetry from UI (e.g. document preview, typing in notes)
    and inject it into the browser daemon's SQLite database to trigger the
    Proactive Agent.
    """
    try:
        log_id = service.log_activity(
            url=request.url,
            title=request.title,
            text_content=request.text_content
        )
        return ActivityLogResponse(success=True, log_id=log_id)
    except Exception as exc:
        logger.error("Activity logging failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Activity logging failed: {exc}"
        ) from exc


@router.get("/document", summary="Retrieve a Document by Aether URL")
def get_aether_document(
    url: str = Query(..., description="The aether:// URL to retrieve (e.g. aether://index/my_index/doc_123 or aether://notes/my_note)"),
    service: SourceIndexingService = Depends(get_source_indexing_service),
    _context: dict = Depends(setup_request_context),
) -> Dict[str, Any]:
    """
    Retrieve the full content of a document or note by its Aether URL.
    Used by the Proactive Agent's scrape_url tool to read Aether resources.
    """
    try:
        return service.get_aether_document(url=url)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Failed to retrieve aether document: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve aether document: {exc}"
        ) from exc


