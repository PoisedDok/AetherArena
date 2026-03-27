"""
XLWings Excel Automation API Endpoints

Provides Excel workbook creation, manipulation, and automation.
Exposes xlwings capabilities via on-demand, in-process execution.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/xlwings/*, WorkbookCreateRequest, WorkbookSaveRequest, SheetCreateRequest, DataWriteRequest, DataReadRequest, ChartCreateRequest, FormatRangeRequest JSON payloads}
Processing: create_workbook(), save_workbook(), get_workbook_info(), close_workbook(), create_sheet(), write_data(), read_data(), create_chart(), format_range(), xlwings_health() --- {JOB_ROUTE}
Outgoing: core/integrations/libraries/xlwings.py, Frontend (HTTP) --- {excel.* function calls, JSONResponse with workbook paths, data, and operation results}
"""

from typing import Dict, Any, Optional, List, Union
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from core.exceptions import DomainException
from api.dependencies import setup_request_context
from core.integrations.libraries.xlwings import excel
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(
    tags=["xlwings"],
    prefix="/xlwings",
)


# =============================================================================
# Schemas
# =============================================================================

class WorkbookCreateRequest(BaseModel):
    """Request to create workbook."""
    filename: Optional[str] = Field(None, description="Optional filename or path (base dir scoped)")


class WorkbookSaveRequest(BaseModel):
    """Request to save workbook."""
    workbook_id: str = Field(..., description="Workbook path")
    filename: str = Field("workbook.xlsx", description="Output filename or path")


class SheetCreateRequest(BaseModel):
    """Request to create sheet."""
    workbook_id: str = Field(..., description="Workbook path")
    name: str = Field("Sheet1", description="Sheet name")


class DataWriteRequest(BaseModel):
    """Request to write data."""
    workbook_id: str = Field(..., description="Workbook path")
    sheet_name: str = Field(..., description="Sheet name")
    data: Union[str, int, float, List, Dict] = Field(..., description="Data to write")
    range_address: str = Field("A1", description="Start position")


class DataReadRequest(BaseModel):
    """Request to read data."""
    workbook_id: str = Field(..., description="Workbook path")
    sheet_name: str = Field(..., description="Sheet name")
    range_address: Optional[str] = Field(None, description="Range to read")


class ChartCreateRequest(BaseModel):
    """Request to create chart."""
    workbook_id: str = Field(..., description="Workbook path")
    sheet_name: str = Field(..., description="Sheet name")
    chart_type: str = Field(..., description="Chart type")
    data_range: str = Field(..., description="Data range")
    position: str = Field("E2", description="Chart position")


class FormatRangeRequest(BaseModel):
    """Request to format range."""
    workbook_id: str = Field(..., description="Workbook path")
    sheet_name: str = Field(..., description="Sheet name")
    range_address: str = Field(..., description="Range to format")
    format_options: Dict[str, Any] = Field(..., description="Format options")


# =============================================================================
# Workbook Management
# =============================================================================

@router.post(
    "/workbook/create",
    summary="Create workbook",
    description="Create new Excel workbook",
    openapi_extra={"is_agent_tool": True})
async def create_workbook(
    request: WorkbookCreateRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Create new workbook."""
    try:
        result = excel.create_workbook(request.filename)
        
        if "error" in result:
            error_msg = result["error"].lower()
            logger.warning(f"XLWings operation error: {result['error']}")
            
            # Map specific error messages to appropriate HTTP status codes
            if "not found" in error_msg or "does not exist" in error_msg:
                status_code = status.HTTP_404_NOT_FOUND
            elif "invalid" in error_msg or "bad request" in error_msg or "cannot" in error_msg or "failed" in error_msg:
                # Based on the test expectations for most errors to be 400
                status_code = status.HTTP_400_BAD_REQUEST
            else:
                # Default for create_workbook and unexpected errors
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
                
            raise HTTPException(
                status_code=status_code,
                detail=result["error"]
            )
        
        logger.info(f"Created workbook: {result.get('workbook_id')}")
        return result
        
    except (HTTPException, DomainException):
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
    description="Save workbook to file",
    openapi_extra={"is_agent_tool": True})
async def save_workbook(
    request: WorkbookSaveRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Save workbook."""
    try:
        result = excel.save_workbook(request.workbook_id, request.filename)
        
        if "error" in result:
            error_msg = result["error"].lower()
            logger.warning(f"XLWings operation error: {result['error']}")
            
            # Map specific error messages to appropriate HTTP status codes
            if "not found" in error_msg or "does not exist" in error_msg:
                status_code = status.HTTP_404_NOT_FOUND
            elif "invalid" in error_msg or "bad request" in error_msg or "cannot" in error_msg or "failed" in error_msg:
                # Based on the test expectations for most errors to be 400
                status_code = status.HTTP_400_BAD_REQUEST
            else:
                # Default for create_workbook and unexpected errors
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
                
            raise HTTPException(
                status_code=status_code,
                detail=result["error"]
            )
        
        logger.info(f"Saved workbook: {request.workbook_id} -> {request.filename}")
        return result
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error(f"Workbook save failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Workbook save failed"
        )


@router.get(
    "/workbook/{workbook_id:path}/info",
    summary="Get workbook info",
    description="Get workbook metadata",
    openapi_extra={"is_agent_tool": True})
async def get_workbook_info(
    workbook_id: str,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Get workbook information."""
    try:
        result = excel.get_workbook_info(workbook_id)
        
        if "error" in result:
            error_msg = result["error"].lower()
            logger.warning(f"XLWings operation error: {result['error']}")
            
            # Map specific error messages to appropriate HTTP status codes
            if "not found" in error_msg or "does not exist" in error_msg:
                status_code = status.HTTP_404_NOT_FOUND
            elif "invalid" in error_msg or "bad request" in error_msg or "cannot" in error_msg or "failed" in error_msg:
                # Based on the test expectations for most errors to be 400
                status_code = status.HTTP_400_BAD_REQUEST
            else:
                # Default for create_workbook and unexpected errors
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
                
            raise HTTPException(
                status_code=status_code,
                detail=result["error"]
            )
        
        return result
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error(f"Get workbook info failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Get workbook info failed"
        )


@router.post(
    "/workbook/{workbook_id:path}/close",
    summary="Close workbook",
    description="Close workbook and release resources",
    openapi_extra={"is_agent_tool": True})
async def close_workbook(
    workbook_id: str,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Close workbook."""
    try:
        result = excel.close_workbook(workbook_id)
        
        if "error" in result:
            error_msg = result["error"].lower()
            logger.warning(f"XLWings operation error: {result['error']}")
            
            # Map specific error messages to appropriate HTTP status codes
            if "not found" in error_msg or "does not exist" in error_msg:
                status_code = status.HTTP_404_NOT_FOUND
            elif "invalid" in error_msg or "bad request" in error_msg or "cannot" in error_msg or "failed" in error_msg:
                # Based on the test expectations for most errors to be 400
                status_code = status.HTTP_400_BAD_REQUEST
            else:
                # Default for create_workbook and unexpected errors
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
                
            raise HTTPException(
                status_code=status_code,
                detail=result["error"]
            )
        
        logger.info(f"Closed workbook: {workbook_id}")
        return result
        
    except (HTTPException, DomainException):
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
    description="Create new sheet in workbook",
    openapi_extra={"is_agent_tool": True})
async def create_sheet(
    request: SheetCreateRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Create new sheet."""
    try:
        result = excel.create_sheet(request.workbook_id, request.name)
        
        if "error" in result:
            error_msg = result["error"].lower()
            logger.warning(f"XLWings operation error: {result['error']}")
            
            # Map specific error messages to appropriate HTTP status codes
            if "not found" in error_msg or "does not exist" in error_msg:
                status_code = status.HTTP_404_NOT_FOUND
            elif "invalid" in error_msg or "bad request" in error_msg or "cannot" in error_msg or "failed" in error_msg:
                # Based on the test expectations for most errors to be 400
                status_code = status.HTTP_400_BAD_REQUEST
            else:
                # Default for create_workbook and unexpected errors
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
                
            raise HTTPException(
                status_code=status_code,
                detail=result["error"]
            )
        
        logger.info(f"Created sheet: {request.name} in {request.workbook_id}")
        return result
        
    except (HTTPException, DomainException):
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
    description="Write data to Excel sheet",
    openapi_extra={"is_agent_tool": True})
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
            error_msg = result["error"].lower()
            logger.warning(f"XLWings operation error: {result['error']}")
            
            # Map specific error messages to appropriate HTTP status codes
            if "not found" in error_msg or "does not exist" in error_msg:
                status_code = status.HTTP_404_NOT_FOUND
            elif "invalid" in error_msg or "bad request" in error_msg or "cannot" in error_msg or "failed" in error_msg:
                # Based on the test expectations for most errors to be 400
                status_code = status.HTTP_400_BAD_REQUEST
            else:
                # Default for create_workbook and unexpected errors
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
                
            raise HTTPException(
                status_code=status_code,
                detail=result["error"]
            )
        
        logger.info(f"Wrote data to {request.sheet_name}!{request.range_address}")
        return result
        
    except (HTTPException, DomainException):
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
    description="Read data from Excel sheet",
    openapi_extra={"is_agent_tool": True})
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
            error_msg = result["error"].lower()
            logger.warning(f"XLWings operation error: {result['error']}")
            
            # Map specific error messages to appropriate HTTP status codes
            if "not found" in error_msg or "does not exist" in error_msg:
                status_code = status.HTTP_404_NOT_FOUND
            elif "invalid" in error_msg or "bad request" in error_msg or "cannot" in error_msg or "failed" in error_msg:
                # Based on the test expectations for most errors to be 400
                status_code = status.HTTP_400_BAD_REQUEST
            else:
                # Default for create_workbook and unexpected errors
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
                
            raise HTTPException(
                status_code=status_code,
                detail=result["error"]
            )
        
        return result
        
    except (HTTPException, DomainException):
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
    description="Create chart in worksheet",
    openapi_extra={"is_agent_tool": True})
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
            error_msg = result["error"].lower()
            logger.warning(f"XLWings operation error: {result['error']}")
            
            # Map specific error messages to appropriate HTTP status codes
            if "not found" in error_msg or "does not exist" in error_msg:
                status_code = status.HTTP_404_NOT_FOUND
            elif "invalid" in error_msg or "bad request" in error_msg or "cannot" in error_msg or "failed" in error_msg:
                # Based on the test expectations for most errors to be 400
                status_code = status.HTTP_400_BAD_REQUEST
            else:
                # Default for create_workbook and unexpected errors
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
                
            raise HTTPException(
                status_code=status_code,
                detail=result["error"]
            )
        
        logger.info(f"Created {request.chart_type} chart in {request.sheet_name}")
        return result
        
    except (HTTPException, DomainException):
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
    description="Apply formatting to range",
    openapi_extra={"is_agent_tool": True})
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
            error_msg = result["error"].lower()
            logger.warning(f"XLWings operation error: {result['error']}")
            
            # Map specific error messages to appropriate HTTP status codes
            if "not found" in error_msg or "does not exist" in error_msg:
                status_code = status.HTTP_404_NOT_FOUND
            elif "invalid" in error_msg or "bad request" in error_msg or "cannot" in error_msg or "failed" in error_msg:
                # Based on the test expectations for most errors to be 400
                status_code = status.HTTP_400_BAD_REQUEST
            else:
                # Default for create_workbook and unexpected errors
                status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
                
            raise HTTPException(
                status_code=status_code,
                detail=result["error"]
            )
        
        logger.info(f"Formatted range: {request.range_address}")
        return result
        
    except (HTTPException, DomainException):
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

