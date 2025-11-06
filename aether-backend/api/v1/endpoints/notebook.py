"""
Notebook Runtime API Endpoints

Provides Python runtime environment inspection and module management.
Exposes all notebook runtime capabilities via REST API.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/notebook/*, SysPathAddRequest, ImportRequest, ImportFromPathRequest, ListInstalledRequest, SearchImportableRequest JSON payloads}
Processing: add_sys_path(), list_sys_path(), import_module(), import_from_path(), list_packages(), search_modules(), get_module_info(), notebook_health() --- {5 jobs: health_checking, module_import, module_inspection, package_discovery, sys_path_management}
Outgoing: core/integrations/libraries/notebook.py, Frontend (HTTP) --- {nb_* function calls, JSONResponse with sys.path, module info, package lists}
"""

from typing import Dict, Any, Optional, List
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from api.dependencies import setup_request_context
from core.integrations.libraries.notebook import (
    nb_sys_path_add,
    nb_import,
    nb_import_from_path,
    nb_list_sys_path,
    nb_list_installed,
    nb_search_importable,
    nb_module_info
)
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["notebook"], prefix="/notebook")


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
    description="Add filesystem path to Python module search path"
)
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
        
        logger.info(f"Added path to sys.path: {request.path}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to add sys path: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to add sys path"
        )


@router.get(
    "/sys-path/list",
    summary="List sys.path",
    description="Get all paths in Python module search path"
)
async def list_sys_path(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """List all paths in sys.path."""
    try:
        result = nb_list_sys_path()
        logger.debug(f"Listed {result.get('count', 0)} sys.path entries")
        return result
        
    except Exception as e:
        logger.error(f"Failed to list sys.path: {e}", exc_info=True)
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
    description="Import module and optionally expose globally"
)
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
        
        logger.info(f"Imported module: {request.module}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Import failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Import failed"
        )


@router.post(
    "/import/from-path",
    summary="Import from file path",
    description="Import module from specific file path"
)
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
        
        logger.info(f"Imported {request.module} from {request.path}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Import from path failed: {e}", exc_info=True)
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
    description="List installed Python packages with optional filtering"
)
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
        
        logger.debug(f"Listed {result.get('count', 0)} packages")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Package listing failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Package listing failed"
        )


@router.post(
    "/modules/search",
    summary="Search importable modules",
    description="Search for importable modules by name"
)
async def search_modules(
    request: SearchImportableRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Search for importable modules."""
    try:
        result = nb_search_importable(
            query=request.query,
            include_stdlib=request.include_stdlib,
            limit=request.limit
        )
        
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["error"]
            )
        
        logger.debug(f"Found {result.get('count', 0)} modules matching '{request.query}'")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Module search failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Module search failed"
        )


@router.post(
    "/modules/info",
    summary="Get module information",
    description="Get detailed information about a specific module"
)
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
        
        logger.debug(f"Retrieved info for module: {request.module}")
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Module info failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Module info failed"
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
                "sys_path_management",
                "module_import",
                "package_discovery",
                "module_inspection"
            ]
        }
        
    except Exception as e:
        logger.error(f"Health check failed: {e}", exc_info=True)
        return {
            "healthy": False,
            "message": "Health check failed",
            "capabilities": []
        }

