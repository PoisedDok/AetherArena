"""
Proactive Agent API - DeepPlanning-Inspired Intelligent Notifications

Orchestrates proactive information delivery using two-phase architecture:
- Phase 1: Query Generation Daemon (SQLite) - background process
- Phase 2: ReAct Scouting Agent (Perplexica) - decision making

@.architecture
Incoming: Frontend/Worker requests --- {POST /v1/proactive/scout with query_ids, queries, source_docs}
Processing: Call Perplexica proactive agent → Store results in Supabase --- {3 jobs: JOB_CALL_AGENT, JOB_STORE_RUN, JOB_EMIT_NOTIFICATION}
Outgoing: Proactive decision + recommendation --- {Dict with decision, recommendation, context}
"""

import asyncio
from typing import List, Optional, Dict, Any, Literal
from core.exceptions import DomainException
from fastapi import APIRouter, Depends, HTTPException, Request, status, BackgroundTasks
from pydantic import BaseModel, Field
from datetime import datetime, timezone
from uuid import UUID, uuid4

from api.dependencies import (
    get_proactive_config_service,
    get_settings,
    setup_request_context,
    get_database,
    get_proactive_service,
    get_optional_file_service,
)
from config.settings import Settings
from data.database.persistence_gateway import SupabasePersistenceGateway
from application.agents.proactive_config_service import ProactiveConfigService
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/proactive", tags=["proactive"])


class ProactiveScoutRequest(BaseModel):
    """Request payload for proactive agent scouting."""
    
    # Phase 1 inputs
    query_ids: List[str] = Field(..., description="Query IDs from SQLite query_generation DB")
    queries: List[str] = Field(..., description="Generated queries from Phase 1 daemon")
    source_docs: List[Dict[str, Any]] = Field(..., description="Source documents that triggered queries")
    day_date: str = Field(..., description="Date queries were generated (YYYY-MM-DD)")
    
    # Agent configuration
    session_id: Optional[UUID] = Field(None, description="Optional session ID for tracking")
    trace_id: Optional[str] = Field(
        None,
        description="Optional correlation ID propagated across worker/backend/perplexica",
    )
    max_processing_time_seconds: Optional[int] = Field(
        None,
        ge=5,
        le=600,
        description="Upper bound timeout for this proactive run (seconds)",
    )


class ProactiveScoutResponse(BaseModel):
    """Response from proactive agent scouting."""
    
    run_id: UUID = Field(..., description="ID of stored agent run")
    
    # Agent decision
    decision: Literal["intervene", "defer"] = Field(..., description="Agent decision")
    
    # Output (if intervene)
    recommendation: Optional[str] = Field(None, description="Proactive recommendation text")
    supporting_docs: Optional[List[Dict[str, Any]]] = Field(None, description="Supporting documents")
    context: Optional[List[Dict[str, Any]]] = Field(
        None,
        description="Full doc-research context gathered by scout tools",
    )
    
    # Classifier planning metadata
    tool_budget: int = Field(..., description="Classifier-approved max tool calls for this run")
    
    # Metadata
    tool_calls_count: int = Field(..., description="Number of tool calls made")
    executed_tools: Optional[List[Any]] = Field(None, description="Tools used during the research phase")
    execution_time_ms: int = Field(..., description="Execution time in milliseconds")
    timestamp: str = Field(..., description="Timestamp of completion")
    trace_id: str = Field(..., description="Correlation ID for end-to-end traceability")


@router.post("/scout", response_model=ProactiveScoutResponse)
async def scout_proactive(
    request: ProactiveScoutRequest,
    settings: Settings = Depends(get_settings),
    gateway: SupabasePersistenceGateway = Depends(get_database),
    _context: dict = Depends(setup_request_context),
):
    """
    Execute proactive agent scouting (Phase 2 of DeepPlanning architecture).
    
    This endpoint receives queries from Phase 1 (query generation daemon) and orchestrates:
    1. Call Perplexica proactive ReAct agent for decision-making
    2. Store results in proactive_agent_runs table
    3. Return decision + recommendation for frontend display
    
    **Workflow:**
    - Phase 1 daemon generates queries from user activity (background)
    - Worker calls this endpoint with unprocessed queries
    - Agent scouts for relevant information and decides intervene/defer
    - If intervene: recommendation displayed in proactive container
    - Store all runs for learning (user feedback + context)
    
    **Returns:**
    - `decision`: "intervene" or "defer"
    - `recommendation`: Text to display (if intervene)
    - `supporting_docs`: Evidence documents (if intervene)
    - `tool_budget`: Classifier-approved tool budget for this run
    - `run_id`: UUID for feedback tracking
    """
    trace_id = request.trace_id or f"proactive-{uuid4().hex}"
    logger.info(
        "Proactive scout request received [trace_id=%s, query_count=%d, source_docs=%d]",
        trace_id,
        len(request.queries),
        len(request.source_docs),
    )
    
    try:
        from services.proactive.scout_service import execute_proactive_scout
        
        result = await execute_proactive_scout(
            query_ids=request.query_ids,
            queries=request.queries,
            source_docs=request.source_docs,
            day_date=request.day_date,
            settings=settings,
            gateway=gateway,
            session_id=request.session_id,
            trace_id=trace_id,
            max_processing_time_seconds=request.max_processing_time_seconds,
        )
        
        return ProactiveScoutResponse(**result)
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Proactive scout failed [trace_id=%s]: %s", trace_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "Proactive scout error",
                "trace_id": trace_id,
            },
        )


async def _rebuild_icl_index_bg():
    """Background task to rebuild ICL index."""
    try:
        from api.dependencies import get_database_connection
        db = get_database_connection()
        if not db:
            logger.error("Failed to get database connection for background ICL index rebuild")
            return
        
        # Instantiate a new DB connection for the background task
        # We need a new service instance because background tasks outlive the request
        from api.dependencies import get_proactive_service_for_background
        proactive_service = get_proactive_service_for_background(db)
        await proactive_service.rebuild_icl_index_bg()
    except Exception as e:
        logger.error("Background ICL index rebuild failed: %s", e)


@router.post(
    "/{run_id}/feedback",
    summary="Record proactive notification feedback",
    description="Tracks user engagement with a proactive notification: clicked, timeout, or dismissed.",
)
async def record_proactive_feedback(
    run_id: str,
    background_tasks: BackgroundTasks,
    feedback: Literal["clicked", "timeout", "dismissed"] = "clicked",
    proactive_service = Depends(get_proactive_service),
    _context: dict = Depends(setup_request_context)
):
    """
    Record user feedback for a proactive notification (Phase 3 - Final Feedback).
    """
    try:
        # Try UUID first, fall back to test run
        try:
            run_uuid = UUID(run_id)
            await proactive_service.record_user_feedback(run_id, feedback)

            # Phase 4: Keep ICL index fresh as soon as feedback lands.
            try:
                run_record = await proactive_service.get_run_by_id(run_uuid)
                if run_record and run_record.get("decision") == "intervene" and run_record.get("recommendation"):
                    from services.agents.proactive_icl_manager import get_proactive_icl_manager
                    
                    # We still need the repository instance for the ICL manager currently
                    proactive_repo = proactive_service._proactive_repo

                    icl_manager = get_proactive_icl_manager()
                    index_ready = await icl_manager.ensure_index(proactive_repo)
                    append_ok = False
                    if index_ready:
                        run_queries = run_record.get("queries")
                        import asyncio
                        append_ok = await asyncio.to_thread(
                            icl_manager.append_run,
                            recommendation=run_record.get("recommendation", ""),
                            queries=run_queries if isinstance(run_queries, list) else [],
                            feedback=feedback,
                            timestamp=run_record.get("created_at") or run_record.get("processed_at") or datetime.now(timezone.utc).isoformat(),
                            run_id=str(run_uuid),
                        )

                    if not append_ok:
                        background_tasks.add_task(_rebuild_icl_index_bg)
            except Exception as icl_err:
                logger.warning("ICL refresh on feedback failed for run %s: %s", run_id, icl_err)
        except ValueError:
            # Test run ID (not in database)
            logger.info("Test run feedback '%s' for %s (not persisted)", feedback, run_id)
        
        return {
            "success": True,
            "run_id": run_id,
            "feedback": feedback
        }
        
    except Exception as e:
        logger.error("Failed to record feedback for %s: %s", run_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to record feedback. Check server logs for details."
        )


class LatestUnseenResponse(BaseModel):
    has_unseen: bool
    run_id: Optional[str] = None
    recommendation: Optional[str] = None
    context: Optional[dict] = None
    timestamp: Optional[str] = None
    trace_id: Optional[str] = None


@router.get(
    "/latest-unseen",
    response_model=LatestUnseenResponse,
    summary="Get latest unseen proactive notification",
    description="Returns the most recent proactive intervention (from the last hour) that the user hasn't interacted with.",
)
async def get_latest_unseen(
    proactive_service = Depends(get_proactive_service),
    _context: dict = Depends(setup_request_context),
):
    """
    Recover missed notifications on startup or reconnect (Phase 3).
    """
    try:
        run = await proactive_service.get_latest_unseen()
        
        if not run:
            return LatestUnseenResponse(has_unseen=False)
            
        return LatestUnseenResponse(
            has_unseen=True,
            run_id=str(run["id"]),
            recommendation=run.get("recommendation"),
            context={"sources": run.get("source_docs", []), "queries": run.get("queries", [])},
            timestamp=run.get("created_at"),
            trace_id=f"recovered-{run['id']}",
        )
    except Exception as e:
        logger.error("Failed to get latest unseen notification: %s", e, exc_info=True)
        return LatestUnseenResponse(has_unseen=False)


@router.get(
    "/stats",
    summary="Get proactive agent statistics",
    description="Returns run counts and user feedback rates for the proactive agent over a given period.",
)
async def get_proactive_stats(
    days: int = 7,
    proactive_service = Depends(get_proactive_service),
    _context: dict = Depends(setup_request_context),
):
    """
    Get proactive agent statistics for monitoring and tuning.
    """
    try:
        return await proactive_service.get_stats(days=days)
    except Exception as e:
        logger.error("Failed to get proactive stats: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Stats error. Check server logs for details."
        )


# ==============================================================================
# NOTE: /search endpoint REMOVED in Phase 4
# ICL search now happens server-side BEFORE agent call (pre-fetch pattern)
# Repository method search_similar_runs() is still available for direct use
# ==============================================================================


# =============================================================================
# Source Status API - Data Source Readiness Detection
# =============================================================================


class SourceBrowserEntry(BaseModel):
    """A detected browser with profile details."""
    value: str
    label: str
    profiles_count: int
    profiles: List[str] = []


class BrowserSourceStatus(BaseModel):
    """Browser data source readiness."""
    installed: List[SourceBrowserEntry] = []
    current: str = "edge"
    recommended: Optional[str] = None
    error: Optional[str] = None


class EmailSourceStatus(BaseModel):
    """Email data source readiness."""
    platform: str
    accessible: bool = False
    method: str = "not_supported"
    permission_instructions: Optional[str] = None
    restart_note: Optional[str] = None
    error: Optional[str] = None


class FilesystemSourceStatus(BaseModel):
    """Filesystem data source readiness."""
    watch_locations: List[str] = []
    valid_count: int = 0
    indexing_locations: List[str] = []
    error: Optional[str] = None


class SourceStatusResponse(BaseModel):
    """Response for GET /v1/proactive/source-status."""
    browser: BrowserSourceStatus
    email: EmailSourceStatus
    filesystem: FilesystemSourceStatus


@router.get(
    "/source-status",
    response_model=SourceStatusResponse,
    summary="Get proactive data source readiness status",
    description="Returns detection results for browser, email, and filesystem sources. "
                "Used by onboarding to pre-configure data sources. "
                "All three checks run in parallel with per-source error isolation.",
)
async def get_proactive_source_status(
    settings: Settings = Depends(get_settings),
    file_service = Depends(get_optional_file_service),
    proactive_config_service: ProactiveConfigService = Depends(get_proactive_config_service),
    _context: dict = Depends(setup_request_context)
):
    """
    Get proactive data source readiness status.

    Detects installed browsers (Chromium-family), tests macOS Mail.app accessibility,
    and reports filesystem watch state. Each source check is isolated — one failure
    does not block others.

    All blocking I/O (subprocess, filesystem) is wrapped in asyncio.to_thread().
    """
    import sys

    # --- Browser detection ---
    async def _check_browsers() -> BrowserSourceStatus:
        try:
            from application.sources.chromium_history import (
                resolve_chromium_user_data_dir,
                find_profile_dirs,
            )

            browser_labels = {
                "chrome": "Google Chrome",
                "edge": "Microsoft Edge",
                "chromium": "Chromium",
            }
            installed = []

            for browser_key, label in browser_labels.items():
                try:
                    user_data_dir = await asyncio.to_thread(
                        resolve_chromium_user_data_dir, browser_key
                    )
                    if user_data_dir and user_data_dir.exists():
                        profiles = await asyncio.to_thread(
                            find_profile_dirs, user_data_dir
                        )
                        installed.append(SourceBrowserEntry(
                            value=browser_key,
                            label=label,
                            profiles_count=len(profiles),
                            profiles=[p.name for p in profiles],
                        ))
                except ValueError:
                    # Invalid browser string — skip
                    continue
                except Exception as e:
                    logger.warning("Browser detection error for %s: %s", browser_key, e)

            current = settings.proactive.browser.browser
            recommended = None
            if installed:
                by_profiles = sorted(
                    installed, key=lambda b: b.profiles_count, reverse=True
                )
                if by_profiles[0].profiles_count > 0:
                    recommended = by_profiles[0].value
                else:
                    recommended = installed[0].value

            return BrowserSourceStatus(
                installed=installed,
                current=current,
                recommended=recommended,
            )
        except Exception as e:
            logger.error("Browser source status check failed: %s", e, exc_info=True)
            return BrowserSourceStatus(
                error=f"Browser detection failed: {str(e)}"
            )

    # --- Email detection ---
    async def _check_email() -> EmailSourceStatus:
        try:
            platform = sys.platform

            if platform != "darwin":
                return EmailSourceStatus(
                    platform=platform,
                    accessible=False,
                    method="not_supported",
                )

            from application.sources.macos_mail import test_mail_access

            accessible = await asyncio.to_thread(test_mail_access)

            return EmailSourceStatus(
                platform=platform,
                accessible=accessible,
                method="applescript",
                permission_instructions=(
                    "System Settings > Privacy & Security > Automation > AetherArena > Mail"
                    if not accessible else None
                ),
                restart_note=(
                    "If you just granted permission, click 'Check Again' — the detection "
                    "re-runs the permission test. The running daemon will pick up the new "
                    "permission on next reload."
                    if not accessible else None
                ),
            )
        except Exception as e:
            logger.error("Email source status check failed: %s", e, exc_info=True)
            return EmailSourceStatus(
                platform=sys.platform,
                error=f"Email access check failed: {str(e)}",
            )

    # --- Filesystem detection ---
    async def _check_filesystem() -> FilesystemSourceStatus:
        try:
            from pathlib import Path as _Path

            # Read watch_locations from the SAME source daemons use via domain service.
            watch_locations = await asyncio.to_thread(proactive_config_service.get_filesystem_watch_locations)

            valid_count = 0
            for loc in watch_locations:
                if loc and _Path(loc).expanduser().resolve().exists():
                    valid_count += 1

            # Get user's configured indexing locations from FileService
            indexing_locations = []
            if file_service is not None:
                try:
                    locations = await file_service.get_indexing_locations(enabled_only=False)
                    indexing_locations = [
                        loc.get("root_path", "") for loc in locations
                        if loc.get("root_path")
                    ]
                except Exception as e:
                    logger.warning("Could not fetch indexing locations: %s", e)
            else:
                logger.debug(
                    "Skipping indexing location lookup: file_service not injected"
                )

            return FilesystemSourceStatus(
                watch_locations=watch_locations,
                valid_count=valid_count,
                indexing_locations=indexing_locations,
            )
        except Exception as e:
            logger.error("Filesystem source status check failed: %s", e, exc_info=True)
            return FilesystemSourceStatus(
                error=f"Filesystem status check failed: {str(e)}",
            )

    # Run all three checks in parallel — worst-case latency is max(), not sum()
    browser_result, email_result, fs_result = await asyncio.gather(
        _check_browsers(),
        _check_email(),
        _check_filesystem(),
    )

    return SourceStatusResponse(
        browser=browser_result,
        email=email_result,
        filesystem=fs_result,
    )


# =============================================================================
# User Control API - Enable/Disable Proactive Agent
# =============================================================================

class ProactiveConfigResponse(BaseModel):
    """Current proactive agent configuration (Phase 2 Worker + Phase 1 Daemons)."""
    # Master switch
    enabled: bool
    
    # Phase 2 Worker (in-app)
    worker_enabled: bool
    heartbeat_interval_seconds: int
    max_processing_time_seconds: int
    
    # Phase 1 Daemons (all 5 unified)
    browser_enabled: bool
    email_enabled: bool
    file_system_enabled: bool
    query_generation_enabled: bool
    file_indexing_enabled: bool


class ProactiveConfigUpdateRequest(BaseModel):
    """Update proactive agent configuration."""
    enabled: Optional[bool] = None
    worker_enabled: Optional[bool] = None
    heartbeat_interval_seconds: Optional[int] = None
    browser_enabled: Optional[bool] = None
    email_enabled: Optional[bool] = None
    file_system_enabled: Optional[bool] = None
    query_generation_enabled: Optional[bool] = None
    file_indexing_enabled: Optional[bool] = None


@router.get("/config", response_model=ProactiveConfigResponse)
async def get_proactive_config(
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
):
    """
    Get current proactive agent configuration (Phase 2 Worker).
    
    Returns Phase 2 worker settings (heartbeat, processing time) and Phase 1 daemon status.
    Uses unified ProactiveConfigReader (D3 fix) for consistent fallback chain.
    """
    from config.proactive_config_reader import read_proactive_config
    cfg = read_proactive_config(settings)

    return ProactiveConfigResponse(
        enabled=cfg.enabled,
        worker_enabled=cfg.worker_enabled,
        heartbeat_interval_seconds=cfg.heartbeat_interval_seconds,
        max_processing_time_seconds=cfg.max_processing_time_seconds,
        browser_enabled=cfg.browser_enabled,
        email_enabled=cfg.email_enabled,
        file_system_enabled=cfg.file_system_enabled,
        query_generation_enabled=cfg.query_generation_enabled,
        file_indexing_enabled=cfg.file_indexing_enabled,
    )


@router.patch(
    "/config",
    summary="Update proactive agent configuration",
    description="Writes to the runtime config file monitored by the proactive worker and daemons. "
                "Worker picks up changes on next heartbeat; daemon_manager reloads immediately.",
)
async def update_proactive_config(
    request: ProactiveConfigUpdateRequest,
    settings: Settings = Depends(get_settings),
    proactive_config_service: ProactiveConfigService = Depends(get_proactive_config_service),
    _context: dict = Depends(setup_request_context)
):
    """
    Update proactive agent configuration (Phase 2 Worker + Phase 1 Daemons).
    
    This writes to runtime config file that both worker and daemons monitor.
    - Worker changes: effect on next heartbeat (~10s)
    - Daemon changes: daemon_manager reloads daemons immediately
    
    **CRITICAL:** This is the proper way to configure proactive system.
    Do NOT modify settings.py directly - use this API.
    """
    try:
        return proactive_config_service.update_config(request.model_dump(exclude_unset=True))
    except Exception as e:
        logger.error("Failed to update proactive config: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update config. Check server logs for details."
        )


@router.post(
    "/test/inject",
    summary="Inject test proactive response",
    description="TEST ONLY: Injects a fake proactive agent response via WebSocket for UI testing.",
)
async def inject_test_proactive_response(
    request: Request,
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
):
    """
    TEST ONLY: Inject a fake proactive response for UI testing.
    
    Simulates a proactive agent response with realistic content.
    Used to test:
    - Frontend streaming display
    - Click handler (open chat with context)
    - Feedback tracking
    - Container layout and styling
    """
    try:
        # Get WebSocket hub from app state
        websocket_hub = getattr(request.app.state, "websocket_hub", None)
        
        if not websocket_hub:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="WebSocket hub not available"
            )
        
        # Generate test run ID
        test_run_id = f"test-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        
        # Realistic test response
        test_response = (
            "Based on your recent email about the quarterly report, "
            "you might want to review the financial data spreadsheet you opened earlier today. "
            "The Q4 projections need updating before the presentation."
        )
        
        # Test context that will be passed to chat
        test_context = {
            "sources": [
                {
                    "type": "email",
                    "subject": "Q4 Report Review - Action Required",
                    "from": "manager@company.com",
                    "timestamp": "2026-02-02T10:30:00Z"
                },
                {
                    "type": "filesystem",
                    "filename": "Q4_Financial_Data.xlsx",
                    "path": "/Documents/Finance/Q4_Financial_Data.xlsx",
                    "timestamp": "2026-02-02T09:15:00Z"
                }
            ],
            "queries": [
                "quarterly report financial data",
                "Q4 projections review"
            ]
        }
        
        logger.info("[TEST] Broadcasting test response for UI")
        
        # 1. Stream chunk
        chunk_payload = {
            "role": "proactive",
            "type": "proactive:stream-chunk",
            "content": test_response,
            "chunk": test_response,
            "recommendation": test_response,
            "run_id": test_run_id,
            "context": test_context,
        }
        await websocket_hub.broadcast_json(chunk_payload)
        
        # 2. Stream end
        end_payload = {
            "role": "proactive",
            "type": "proactive:stream-end",
            "run_id": test_run_id,
            "context": test_context,
        }
        await websocket_hub.broadcast_json(end_payload)
        
        # 3. Fallback intervention
        intervention_payload = {
            "role": "proactive",
            "type": "proactive:intervention",
            "content": test_response,
            "recommendation": test_response,
            "run_id": test_run_id,
            "context": test_context,
        }
        await websocket_hub.broadcast_json(intervention_payload)
        
        logger.info("Injected test proactive response: %s", test_run_id)
        
        return {
            "success": True,
            "run_id": test_run_id,
            "message": "Test response injected - check frontend"
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to inject test response: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to inject test response. Check server logs for details."
        )
