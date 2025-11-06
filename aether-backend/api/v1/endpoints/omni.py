"""
OmniParser API Endpoints

Provides vision and document parsing tools using OmniParser capabilities.
Exposes screenshot capture, screen analysis, document parsing, and batch processing.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/omni/*, ScreenshotRequest, ScreenAnalysisRequest, DocumentParseRequest, MultiOCRParseRequest, BatchParseRequest JSON payloads}
Processing: capture_screenshot(), analyze_screen(), parse_document(), multi_ocr_parse(), batch_parse_documents(), get_workflows(), omni_health() --- {7 jobs: batch_processing, document_parsing, health_checking, multi_ocr, screen_analysis, screenshot_capture, workflow_management}
Outgoing: core/integrations/libraries/omni.py, Frontend (HTTP) --- {omni_* function calls, JSONResponse with screenshots, analysis results, parsed documents}
"""

from typing import Dict, Any, Optional, List
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from api.dependencies import setup_request_context
from core.integrations.libraries.omni import (
    omni_screenshot,
    omni_analyze_screen,
    omni_parse_document,
    omni_multi_ocr_parse,
    omni_find_and_parse_documents,
    omni_workflows
)
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


class DocumentParseRequest(BaseModel):
    """Request to parse document."""
    file_path: str = Field(..., description="Path to document")
    output_format: str = Field("doctags", description="Output format (doctags, markdown, json)")


class MultiOCRParseRequest(BaseModel):
    """Request for multi-engine OCR parsing."""
    file_path: str = Field(..., description="Path to document")
    engines: Optional[List[str]] = Field(None, description="OCR engines to use")
    output_format: str = Field("doctags", description="Output format")
    include_image_analysis: bool = Field(True, description="Include vision analysis for images")


class BatchParseRequest(BaseModel):
    """Request for batch document processing."""
    query: str = Field("", description="Search query for file names")
    paths: Optional[List[str]] = Field(None, description="Directories to search")
    file_types: Optional[List[str]] = Field(None, description="File extensions to search")
    limit: int = Field(10, description="Maximum files to process")
    mode: str = Field("robust", description="Processing mode (fast, robust)")
    output_format: str = Field("doctags", description="Output format")


# =============================================================================
# Screenshot Capture
# =============================================================================

@router.post(
    "/screenshot",
    summary="Capture screenshot",
    description="Capture screenshot of current screen"
)
async def capture_screenshot(
    request: ScreenshotRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Capture screenshot."""
    try:
        result = omni_screenshot(save_path=request.save_path)
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get("error", "Screenshot capture failed")
            )
        
        logger.info(f"Screenshot captured: {result.get('path', 'base64')}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Screenshot failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# Screen Analysis
# =============================================================================

@router.post(
    "/analyze-screen",
    summary="Analyze screen",
    description="Analyze current screen using vision model"
)
async def analyze_screen(
    request: ScreenAnalysisRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Analyze screen with vision model."""
    try:
        result = omni_analyze_screen(prompt=request.prompt)
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get("error", "Screen analysis failed")
            )
        
        logger.info("Screen analysis completed")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Screen analysis failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# Document Parsing
# =============================================================================

@router.post(
    "/parse",
    summary="Parse document",
    description="Parse document using Docling service"
)
async def parse_document(
    request: DocumentParseRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Parse document with Docling."""
    try:
        result = omni_parse_document(
            file_path=request.file_path,
            output_format=request.output_format
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get("error", "Document parsing failed")
            )
        
        logger.info(f"Parsed document: {request.file_path}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Document parsing failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.post(
    "/parse/multi-ocr",
    summary="Multi-OCR parsing",
    description="Parse document using multiple OCR engines for best results"
)
async def multi_ocr_parse(
    request: MultiOCRParseRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Parse with multiple OCR engines."""
    try:
        result = omni_multi_ocr_parse(
            file_path=request.file_path,
            engines=request.engines,
            output_format=request.output_format,
            include_image_analysis=request.include_image_analysis
        )
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["error"]
            )
        
        logger.info(f"Multi-OCR parsing complete: {request.file_path}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Multi-OCR parsing failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# Batch Processing
# =============================================================================

@router.post(
    "/parse/batch",
    summary="Batch document processing",
    description="Find and parse multiple documents in batch"
)
async def batch_parse_documents(
    request: BatchParseRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Batch process documents."""
    try:
        result = omni_find_and_parse_documents(
            query=request.query,
            paths=request.paths,
            file_types=request.file_types,
            limit=request.limit,
            mode=request.mode,
            output_format=request.output_format
        )
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["error"]
            )
        
        logger.info(f"Batch processing complete: {result.get('files_processed', 0)} files")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Batch processing failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# Workflows
# =============================================================================

@router.get(
    "/workflows",
    summary="Get available workflows",
    description="Get paralegal workflow templates with examples"
)
async def get_workflows(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Get available workflows."""
    try:
        result = omni_workflows()
        logger.debug("Retrieved workflow templates")
        return result
        
    except Exception as e:
        logger.error(f"Workflow retrieval failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# Health Check
# =============================================================================

@router.get(
    "/health",
    summary="Omni tools health check",
    description="Check OmniParser integration health"
)
async def omni_health(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Check Omni integration health."""
    try:
        # Check basic functionality
        workflows = omni_workflows()
        
        return {
            "healthy": True,
            "message": "OmniParser tools available",
            "capabilities": [
                "screenshot_capture",
                "screen_analysis",
                "document_parsing",
                "multi_ocr",
                "batch_processing"
            ],
            "workflows": len(workflows)
        }
        
    except Exception as e:
        logger.error(f"Health check failed: {e}", exc_info=True)
        return {
            "healthy": False,
            "message": f"Health check failed: {str(e)}",
            "capabilities": []
        }

