"""
Omni API Endpoints

Provides screenshot capture + vision analysis tools for agent consumption.

IMPORTANT:
- Omni is for screenshot capture + screen analysis (agent-facing structured output).
- Docling owns document parsing/conversion; do not expose doc parsing here.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/omni/*, ScreenshotRequest, ScreenAnalysisRequest JSON payloads}
Processing: capture_screenshot(), analyze_screen(), get_workflows(), omni_health() --- {JOB_ROUTE}
Outgoing: application/omni/service.py, Frontend (HTTP) --- {JSONResponse with screenshot + analysis}
"""

from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from api.dependencies import setup_request_context, get_omni_service
from application.omni import OmniService, OmniServiceError
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["omni"], prefix="/omni")


# =============================================================================
# Schemas
# =============================================================================

class ScreenshotRequest(BaseModel):
    """Request to capture screenshot."""
    save_path: Optional[str] = Field(None, description="Path to save screenshot")


class ScreenAnalysisRequest(BaseModel):
    """Request to analyze screen."""
    prompt: str = Field("Describe this screen.", description="Analysis prompt")


# =============================================================================
# Screenshot Capture
# =============================================================================

@router.post(
    "/screenshot",
    summary="Capture screenshot",
    description="Capture screenshot of current screen",
    openapi_extra={"is_agent_tool": True})
async def capture_screenshot(
    request: ScreenshotRequest,
    _context: dict = Depends(setup_request_context),
    service: OmniService = Depends(get_omni_service),
) -> Dict[str, Any]:
    """Capture screenshot."""
    try:
        result = await service.capture_screenshot(save_path=request.save_path)
        logger.info("Screenshot captured via Omni service")
        return result
    except OmniServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


# =============================================================================
# Screen Analysis
# =============================================================================

@router.post(
    "/analyze-screen",
    summary="Analyze screen",
    description="Analyze current screen using vision model",
    openapi_extra={"is_agent_tool": True})
async def analyze_screen(
    request: ScreenAnalysisRequest,
    _context: dict = Depends(setup_request_context),
    service: OmniService = Depends(get_omni_service),
) -> Dict[str, Any]:
    """Analyze screen with vision model."""
    try:
        return await service.analyze_screen(prompt=request.prompt)
    except OmniServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


# =============================================================================
# Workflows
# =============================================================================

@router.get(
    "/workflows",
    summary="Get available workflows",
    description="Get paralegal workflow templates with examples",
    openapi_extra={"is_agent_tool": True})
async def get_workflows(
    _context: dict = Depends(setup_request_context),
    service: OmniService = Depends(get_omni_service),
) -> Dict[str, Any]:
    """Get available workflows."""
    try:
        return service.get_workflows()
    except OmniServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


# =============================================================================
# Health Check
# =============================================================================

@router.get(
    "/health",
    summary="Omni tools health check",
    description="Check Omni integration health"
)
async def omni_health(
    _context: dict = Depends(setup_request_context),
    service: OmniService = Depends(get_omni_service),
) -> Dict[str, Any]:
    """Check Omni integration health."""
    try:
        return await service.health()
    except Exception as exc:
        logger.error("Omni health check failed: %s", exc, exc_info=True)
        return {
            "healthy": False,
            "message": "Health check failed",
            "capabilities": [],
        }

