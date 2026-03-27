"""
Notebook Runtime API Endpoints

Provides Python runtime environment inspection and module management.
Exposes all notebook runtime capabilities via REST API.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/notebook/*, /v1/execute/notebook, SysPathAddRequest, ImportRequest, ImportFromPathRequest, ListInstalledRequest, SearchImportableRequest JSON payloads}
Processing: add_sys_path(), list_sys_path(), import_module(), import_from_path(), list_packages(), search_modules(), get_module_info(), notebook_health() --- {JOB_ROUTE}
Outgoing: core/integrations/libraries/notebook.py, Frontend (HTTP) --- {nb_* function calls, JSONResponse with sys.path, module info, package lists}
"""

from typing import Dict, Any, Optional, List
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from core.exceptions import DomainException
from api.dependencies import (
    setup_request_context,
    get_settings,
    require_local_request,
)
from core.integrations.libraries.notebook import (
    nb_sys_path_add,
    nb_import,
    nb_import_from_path,
    nb_list_sys_path,
    nb_list_installed,
    nb_module_info,
    nb_execute_code
)
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(
    tags=["notebook"],
    prefix="/notebook",
)
action_router = APIRouter(
    tags=["execute"],
    prefix="/execute",
)


# =============================================================================
# Schemas
# =============================================================================

class SysPathAddRequest(BaseModel):
    """Request to add path to sys.path."""
    path: str = Field(..., description="Filesystem path to add")
    prepend: bool = Field(True, description="Add to beginning if True, append if False")


class ImportRequest(BaseModel):
    """Request to import a module."""
    module: str = Field(..., description="Module name to import")
    alias: Optional[str] = Field(None, description="Global alias")
    fromlist: Optional[List[str]] = Field(None, description="Symbols to import from module")
    add_to_builtins: bool = Field(True, description="Add to builtins for global access")
    reload: bool = Field(False, description="Reload if already imported")


class ImportFromPathRequest(BaseModel):
    """Request to import module from file path."""
    module: str = Field(..., description="Module name to assign")
    path: str = Field(..., description="Path to .py file")
    alias: Optional[str] = Field(None, description="Global alias")
    add_to_builtins: bool = Field(True, description="Add to builtins")
    reload: bool = Field(False, description="Reload if exists")


class ListInstalledRequest(BaseModel):
    """Request to list installed packages."""
    method: str = Field("metadata", description="Discovery method (metadata, pkgutil, pip)")
    search: Optional[str] = Field(None, description="Filter by package name")
    limit: Optional[int] = Field(500, description="Maximum results")


class SearchImportableRequest(BaseModel):
    """Request to search importable modules."""
    query: str = Field(..., description="Search query")
    include_stdlib: bool = Field(True, description="Include stdlib modules")
    limit: Optional[int] = Field(200, description="Maximum results")


class ModuleInfoRequest(BaseModel):
    """Request module information."""
    module: str = Field(..., description="Module name")


# =============================================================================
# Sys Path Management
# =============================================================================

@router.post(
    "/sys-path/add",
    summary="Add path to sys.path",
    description="Add filesystem path to Python module search path",
    openapi_extra={"is_agent_tool": True})
async def add_sys_path(
    request: SysPathAddRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Add path to sys.path for module discovery."""
    try:
        result = nb_sys_path_add(request.path, request.prepend)
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result.get("error", "Failed to add path")
            )
        
        logger.info("Added path to sys.path: %s", request.path)
        return result
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to add sys path: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to add sys path"
        )


@router.get(
    "/sys-path/list",
    summary="List sys.path",
    description="Get all paths in Python module search path",
    openapi_extra={"is_agent_tool": True})
async def list_sys_path(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """List all paths in sys.path."""
    try:
        result = nb_list_sys_path()
        logger.debug("Listed %d sys.path entries", result.get('count', 0))
        return result
        
    except Exception as e:
        logger.error("Failed to list sys.path: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list sys.path"
        )


# =============================================================================
# Module Import
# =============================================================================

@router.post(
    "/import",
    summary="Import Python module",
    description="Import module and optionally expose globally",
    openapi_extra={"is_agent_tool": True})
async def import_module(
    request: ImportRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Import a Python module."""
    try:
        result = nb_import(
            module=request.module,
            alias=request.alias,
            fromlist=request.fromlist,
            add_to_builtins=request.add_to_builtins,
            reload=request.reload
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result.get("error", "Import failed")
            )
        
        logger.info("Imported module: %s", request.module)
        return result
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Import failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Import failed"
        )


@router.post(
    "/import/from-path",
    summary="Import from file path",
    description="Import module from specific file path",
    openapi_extra={"is_agent_tool": True})
async def import_from_path(
    request: ImportFromPathRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Import module from file path."""
    try:
        result = nb_import_from_path(
            module=request.module,
            path=request.path,
            alias=request.alias,
            add_to_builtins=request.add_to_builtins,
            reload=request.reload
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=result.get("error", "Import failed")
            )
        
        logger.info("Imported %s from %s", request.module, request.path)
        return result
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Import from path failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Import from path failed"
        )


# =============================================================================
# Package Discovery
# =============================================================================

@router.post(
    "/packages/list",
    summary="List installed packages",
    description="List installed Python packages with optional filtering",
    openapi_extra={"is_agent_tool": True})
async def list_packages(
    request: ListInstalledRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """List installed Python packages."""
    try:
        result = nb_list_installed(
            method=request.method,
            search=request.search,
            limit=request.limit
        )
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["error"]
            )
        
        logger.debug("Listed %d packages", result.get('count', 0))
        return result
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Package listing failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Package listing failed"
        )


@router.post(
    "/modules/info",
    summary="Get module information",
    description="Get detailed information about a specific module",
    openapi_extra={"is_agent_tool": True})
async def get_module_info(
    request: ModuleInfoRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Get module information."""
    try:
        result = nb_module_info(request.module)
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=result["error"]
            )
        
        logger.debug("Retrieved info for module: %s", request.module)
        return result
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Module info failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Module info failed"
        )


# =============================================================================
# Code Execution
# =============================================================================

class ExecuteCodeRequest(BaseModel):
    """Request to execute Python code."""
    code: str = Field(..., description="Python code to execute")
    session_id: Optional[str] = Field(None, description="Session ID for stateful execution")
    timeout: Optional[int] = Field(30, description="Execution timeout in seconds")


class ExecuteCodeResponse(BaseModel):
    """Response from code execution."""
    success: bool
    output: Optional[str] = None
    error: Optional[str] = None
    execution_time: Optional[float] = None


@action_router.post(
    "/notebook",
    response_model=ExecuteCodeResponse,
    summary="Execute notebook code",
    description="Execute Python code and return output/errors"
)
async def execute_code(
    request: ExecuteCodeRequest,
    http_request: Request,
    settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> ExecuteCodeResponse:
    """
    Execute Python code via Open Interpreter.
    
    Uses the runtime engine's interpreter for code execution.
    """
    try:
        require_local_request(http_request, settings)
        if not settings.security.allow_notebook_exec:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Notebook execution disabled by configuration"
            )
        
        from api.dependencies import get_runtime_engine
        
        # Get runtime engine
        engine = get_runtime_engine()
        
        if not engine:
            return ExecuteCodeResponse(
                success=False,
                error="Runtime engine not available"
            )
        
        result = nb_execute_code(
            code=request.code,
            session_id=request.session_id,
            timeout=request.timeout
        )
        
        return ExecuteCodeResponse(
            success=result.get("success", False),
            output=result.get("output"),
            error=result.get("error"),
            execution_time=result.get("execution_time")
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Code execution failed: %s", e, exc_info=True)
        # Return 500 status code for execution errors that aren't DomainExceptions
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Execution failed: {str(e)}"
        )


@router.get(
    "/sessions",
    summary="List active sessions",
    description="List active code execution sessions"
)
async def list_sessions(
    http_request: Request,
    settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """List active execution sessions."""
    try:
        require_local_request(http_request, settings)
        if not settings.security.allow_notebook_exec:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Notebook execution disabled by configuration"
            )
        
        return {
            "sessions": [],
            "count": 0
        }
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list sessions: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list sessions"
        )


# =============================================================================
# Health Check
# =============================================================================

@router.get(
    "/health",
    summary="Notebook runtime health check",
    description="Check notebook runtime system availability"
)
async def notebook_health(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Check notebook runtime health."""
    try:
        # Test basic operations
        sys_path_result = nb_list_sys_path()
        
        return {
            "healthy": True,
            "message": "Notebook runtime available",
            "sys_path_count": sys_path_result.get("count", 0),
            "capabilities": [
                "code_execution",
                "sys_path_management",
                "module_import",
                "package_discovery",
                "module_inspection"
            ]
        }
        
    except Exception as e:
        logger.error("Health check failed: %s", e, exc_info=True)
        return {
            "healthy": False,
            "message": "Health check failed",
            "capabilities": []
        }

