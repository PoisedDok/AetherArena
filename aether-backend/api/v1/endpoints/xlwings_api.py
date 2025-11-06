"""
XLWings Excel Automation API Endpoints

Provides Excel workbook creation, manipulation, and automation.
Exposes all xlwings capabilities via REST API.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/xlwings/*, WorkbookCreateRequest, WorkbookSaveRequest, SheetCreateRequest, DataWriteRequest, DataReadRequest, ChartCreateRequest, FormatRangeRequest JSON payloads}
Processing: create_workbook(), save_workbook(), get_workbook_info(), close_workbook(), create_sheet(), write_data(), read_data(), create_chart(), format_range(), xlwings_health() --- {6 jobs: chart_creation, data_operations, formatting, health_checking, sheet_management, workbook_management}
Outgoing: core/integrations/libraries/xlwings.py, Frontend (HTTP) --- {excel.* function calls, JSONResponse with workbook IDs, data, and operation results}
"""

from typing import Dict, Any, Optional, List, Union
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from api.dependencies import setup_request_context
from core.integrations.libraries.xlwings import excel
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["xlwings"], prefix="/xlwings")


# =============================================================================
# Schemas
# =============================================================================

class WorkbookCreateRequest(BaseModel):
    """Request to create workbook."""
    pass  # No parameters needed


class WorkbookSaveRequest(BaseModel):
    """Request to save workbook."""
    workbook_id: str = Field(..., description="Workbook ID")
    filename: str = Field("workbook.xlsx", description="Output filename")


class SheetCreateRequest(BaseModel):
    """Request to create sheet."""
    workbook_id: str = Field(..., description="Workbook ID")
    name: str = Field("Sheet1", description="Sheet name")


class DataWriteRequest(BaseModel):
    """Request to write data."""
    workbook_id: str = Field(..., description="Workbook ID")
    sheet_name: str = Field(..., description="Sheet name")
    data: Union[str, int, float, List, Dict] = Field(..., description="Data to write")
    range_address: str = Field("A1", description="Start position")


class DataReadRequest(BaseModel):
    """Request to read data."""
    workbook_id: str = Field(..., description="Workbook ID")
    sheet_name: str = Field(..., description="Sheet name")
    range_address: Optional[str] = Field(None, description="Range to read")


class ChartCreateRequest(BaseModel):
    """Request to create chart."""
    workbook_id: str = Field(..., description="Workbook ID")
    sheet_name: str = Field(..., description="Sheet name")
    chart_type: str = Field(..., description="Chart type")
    data_range: str = Field(..., description="Data range")
    position: str = Field("E2", description="Chart position")


class FormatRangeRequest(BaseModel):
    """Request to format range."""
    workbook_id: str = Field(..., description="Workbook ID")
    sheet_name: str = Field(..., description="Sheet name")
    range_address: str = Field(..., description="Range to format")
    format_options: Dict[str, Any] = Field(..., description="Format options")


# =============================================================================
# Workbook Management
# =============================================================================

@router.post(
    "/workbook/create",
    summary="Create workbook",
    description="Create new Excel workbook"
)
async def create_workbook(
    request: WorkbookCreateRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Create new workbook."""
    try:
        result = excel.create_workbook()
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["error"]
            )
        
        logger.info(f"Created workbook: {result.get('workbook_id')}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Workbook creation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Workbook creation failed"
        )


@router.post(
    "/workbook/save",
    summary="Save workbook",
    description="Save workbook to file"
)
async def save_workbook(
    request: WorkbookSaveRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Save workbook."""
    try:
        result = excel.save_workbook(request.workbook_id, request.filename)
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result["error"]
            )
        
        logger.info(f"Saved workbook: {request.workbook_id} -> {request.filename}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Workbook save failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Workbook save failed"
        )


@router.get(
    "/workbook/{workbook_id}/info",
    summary="Get workbook info",
    description="Get workbook metadata"
)
async def get_workbook_info(
    workbook_id: str,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Get workbook information."""
    try:
        result = excel.get_workbook_info(workbook_id)
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=result["error"]
            )
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get workbook info failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Get workbook info failed"
        )


@router.post(
    "/workbook/{workbook_id}/close",
    summary="Close workbook",
    description="Close workbook and release resources"
)
async def close_workbook(
    workbook_id: str,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Close workbook."""
    try:
        result = excel.close_workbook(workbook_id)
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result["error"]
            )
        
        logger.info(f"Closed workbook: {workbook_id}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Close workbook failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Close workbook failed"
        )


# =============================================================================
# Sheet Operations
# =============================================================================

@router.post(
    "/sheet/create",
    summary="Create sheet",
    description="Create new sheet in workbook"
)
async def create_sheet(
    request: SheetCreateRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Create new sheet."""
    try:
        result = excel.create_sheet(request.workbook_id, request.name)
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result["error"]
            )
        
        logger.info(f"Created sheet: {request.name} in {request.workbook_id}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Sheet creation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Sheet creation failed"
        )


# =============================================================================
# Data Operations
# =============================================================================

@router.post(
    "/data/write",
    summary="Write data",
    description="Write data to Excel sheet"
)
async def write_data(
    request: DataWriteRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Write data to sheet."""
    try:
        result = excel.write_data(
            request.workbook_id,
            request.sheet_name,
            request.data,
            request.range_address
        )
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result["error"]
            )
        
        logger.info(f"Wrote data to {request.sheet_name}!{request.range_address}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Write data failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Write data failed"
        )


@router.post(
    "/data/read",
    summary="Read data",
    description="Read data from Excel sheet"
)
async def read_data(
    request: DataReadRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Read data from sheet."""
    try:
        result = excel.read_data(
            request.workbook_id,
            request.sheet_name,
            request.range_address
        )
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result["error"]
            )
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Read data failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Read data failed"
        )


# =============================================================================
# Chart Operations
# =============================================================================

@router.post(
    "/chart/create",
    summary="Create chart",
    description="Create chart in worksheet"
)
async def create_chart(
    request: ChartCreateRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Create chart."""
    try:
        result = excel.create_chart(
            request.workbook_id,
            request.sheet_name,
            request.chart_type,
            request.data_range,
            request.position
        )
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result["error"]
            )
        
        logger.info(f"Created {request.chart_type} chart in {request.sheet_name}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Chart creation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Chart creation failed"
        )


# =============================================================================
# Formatting
# =============================================================================

@router.post(
    "/format/range",
    summary="Format range",
    description="Apply formatting to range"
)
async def format_range(
    request: FormatRangeRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Format range."""
    try:
        result = excel.format_range(
            request.workbook_id,
            request.sheet_name,
            request.range_address,
            request.format_options
        )
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result["error"]
            )
        
        logger.info(f"Formatted range: {request.range_address}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Format range failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Format range failed"
        )


# =============================================================================
# Health Check
# =============================================================================

@router.get(
    "/health",
    summary="XLWings health check",
    description="Check XLWings service health"
)
async def xlwings_health(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Check XLWings health."""
    try:
        result = excel.xlwings_health()
        return result
        
    except Exception as e:
        logger.error(f"Health check failed: {e}", exc_info=True)
        return {
            "status": "error",
            "error": "Health check failed"
        }

