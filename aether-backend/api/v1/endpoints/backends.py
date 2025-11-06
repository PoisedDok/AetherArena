"""
Sub-Backends Registry API

Unified API for discovering, inspecting, and managing all backend sub-systems.
Provides comprehensive metadata and health status for all integrated backends.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET), config/integrations_registry.yaml --- {HTTP requests to /v1/backends/*, YAML registry data}
Processing: list_backends(), get_backend_details(), check_backend_health(), get_registry_info(), check_all_backends_health() --- {5 jobs: registry_loading, backend_discovery, health_aggregation, metadata_extraction}
Outgoing: core/integrations/libraries/*, Frontend (HTTP) --- {backend integration health checks, BackendInfo, JSONResponse with registry metadata and health status}
"""

from typing import Dict, Any, List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
import yaml
from pathlib import Path

from api.dependencies import setup_request_context
from monitoring import get_logger

# Import all backend integrations for health checks
from core.integrations.libraries.ocr import registry as ocr_registry
from core.integrations.libraries.tts import realtime_tts
from core.integrations.libraries.notebook import runtime as notebook_runtime
from core.integrations.libraries.omni import tools as omni_tools
from core.integrations.libraries.xlwings import excel as xlwings_excel

logger = get_logger(__name__)
router = APIRouter(tags=["backends"], prefix="/backends")


# =============================================================================
# Schemas
# =============================================================================

class BackendInfo(BaseModel):
    """Information about a sub-backend."""
    name: str
    type: str
    description: str
    category: str
    enabled: bool
    available: bool
    health_status: Optional[Dict[str, Any]] = None
    capabilities: List[str]
    tool_count: int
    api_endpoints: List[str]
    requires_service: bool
    service_url: Optional[str] = None


class BackendHealthRequest(BaseModel):
    """Request to check backend health."""
    backend_name: str = Field(..., description="Backend name to check")


# =============================================================================
# Load Backend Registry
# =============================================================================

def _load_integrations_registry() -> Dict[str, Any]:
    """Load integrations_registry.yaml."""
    try:
        registry_path = Path(__file__).parent.parent.parent.parent / "config" / "integrations_registry.yaml"
        
        if not registry_path.exists():
            logger.error(f"Registry not found: {registry_path}")
            return {"integrations": {}}
        
        with open(registry_path, 'r') as f:
            return yaml.safe_load(f) or {"integrations": {}}
    except Exception as e:
        logger.error(f"Failed to load registry: {e}")
        return {"integrations": {}}


# =============================================================================
# List All Backends
# =============================================================================

@router.get(
    "/list",
    summary="List all sub-backends",
    description="Get comprehensive list of all backend integrations with metadata"
)
async def list_backends(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    List all available sub-backends with comprehensive metadata.
    
    Returns information about each backend including:
    - Type and category
    - Enabled/available status
    - Capabilities
    - API endpoints
    - Tool count
    - Service requirements
    """
    try:
        registry = _load_integrations_registry()
        integrations = registry.get("integrations", {})
        
        backends = {}
        
        for name, config in integrations.items():
            layer3 = config.get("layer3_metadata", {})
            layer4 = config.get("layer4_runtime", {})
            
            # Determine API endpoints based on backend
            api_endpoints = _get_api_endpoints_for_backend(name)
            
            # Determine capabilities
            capabilities = _get_capabilities_for_backend(name, config)
            
            backends[name] = {
                "name": name,
                "type": config.get("type", "unknown"),
                "description": config.get("description", ""),
                "category": layer3.get("category", "other"),
                "enabled": config.get("enabled", False),
                "available": _check_backend_available(name),
                "capabilities": capabilities,
                "tool_count": layer3.get("tool_count", 0),
                "api_endpoints": api_endpoints,
                "requires_service": layer3.get("requires_service", False),
                "service_url": layer3.get("service_url"),
                "namespace": layer4.get("namespace", "computer"),
                "attach_as": layer4.get("attach_as", "functions"),
                "priority": config.get("priority", 999)
            }
        
        # Sort by priority
        sorted_backends = dict(sorted(backends.items(), key=lambda x: x[1]["priority"]))
        
        return {
            "total": len(sorted_backends),
            "backends": sorted_backends,
            "categories": _group_by_category(sorted_backends)
        }
        
    except Exception as e:
        logger.error(f"Failed to list backends: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


def _get_api_endpoints_for_backend(name: str) -> List[str]:
    """Get API endpoints for a backend."""
    endpoint_map = {
        "ocr": [
            "/v1/ocr/backends",
            "/v1/ocr/health",
            "/v1/ocr/load",
            "/v1/ocr/unload",
            "/v1/ocr/process/file",
            "/v1/ocr/process/upload",
            "/v1/ocr/formats"
        ],
        "tts": [
            "/v1/tts/engines",
            "/v1/tts/health",
            "/v1/tts/synthesize",
            "/v1/tts/stream",
            "/v1/tts/initialize"
        ],
        "notebook": [
            "/v1/notebook/sys-path/add",
            "/v1/notebook/sys-path/list",
            "/v1/notebook/import",
            "/v1/notebook/import/from-path",
            "/v1/notebook/packages/list",
            "/v1/notebook/modules/search",
            "/v1/notebook/modules/info",
            "/v1/notebook/health"
        ],
        "omni": [
            "/v1/omni/screenshot",
            "/v1/omni/analyze-screen",
            "/v1/omni/parse",
            "/v1/omni/parse/multi-ocr",
            "/v1/omni/parse/batch",
            "/v1/omni/workflows",
            "/v1/omni/health"
        ],
        "xlwings": [
            "/v1/xlwings/workbook/create",
            "/v1/xlwings/workbook/save",
            "/v1/xlwings/workbook/{id}/info",
            "/v1/xlwings/workbook/{id}/close",
            "/v1/xlwings/sheet/create",
            "/v1/xlwings/data/write",
            "/v1/xlwings/data/read",
            "/v1/xlwings/chart/create",
            "/v1/xlwings/format/range",
            "/v1/xlwings/health"
        ],
        "perplexica": [
            "/v1/search/*"  # Exposed through search endpoints
        ],
        "docling": [
            "/v1/document/*"  # Exposed through document endpoints
        ]
    }
    
    return endpoint_map.get(name, [])


def _get_capabilities_for_backend(name: str, config: Dict) -> List[str]:
    """Extract capabilities for a backend."""
    capabilities_map = {
        "ocr": ["document_ocr", "pdf_parsing", "image_text_extraction", "table_detection", "formula_recognition"],
        "tts": ["text_synthesis", "audio_generation", "multiple_engines", "streaming", "voice_selection"],
        "notebook": ["module_import", "package_discovery", "sys_path_management", "runtime_inspection"],
        "omni": ["screenshot_capture", "screen_analysis", "document_parsing", "multi_ocr", "batch_processing", "vision_analysis"],
        "xlwings": ["workbook_creation", "data_manipulation", "chart_creation", "formatting", "formula_calculation", "excel_automation"],
        "perplexica": ["web_search", "academic_search", "reddit_search", "wolfram_alpha", "deep_research", "sourced_answers"],
        "docling": ["document_conversion", "smart_parsing", "layout_analysis", "multi_format_output", "vlm_integration"],
        "browser": ["web_scraping", "automation", "element_interaction", "page_navigation"],
        "mcp": ["dynamic_tools", "server_management", "protocol_bridge", "tool_discovery"]
    }
    
    return capabilities_map.get(name, [])


def _check_backend_available(name: str) -> bool:
    """Check if a backend is currently available."""
    try:
        if name == "ocr":
            # Check OCR backends
            backends = ocr_registry.OCRBackendRegistry.list_available_backends()
            return any(b.get("available") for b in backends.values())
        
        elif name == "tts":
            # Check TTS integration
            tts = realtime_tts.get_tts_integration()
            return tts.is_available()
        
        elif name == "notebook":
            # Notebook always available (builtin Python)
            return True
        
        elif name == "omni":
            # Omni tools always available
            return True
        
        elif name == "xlwings":
            # Check xlwings health
            result = xlwings_excel.xlwings_health()
            return result.get("status") == "active"
        
        else:
            # Default: assume available if enabled
            return True
    
    except Exception as e:
        logger.debug(f"Availability check failed for {name}: {e}")
        return False


def _group_by_category(backends: Dict) -> Dict[str, List[str]]:
    """Group backends by category."""
    categories = {}
    
    for name, info in backends.items():
        category = info["category"]
        if category not in categories:
            categories[category] = []
        categories[category].append(name)
    
    return categories


# =============================================================================
# Get Backend Details
# =============================================================================

@router.get(
    "/{backend_name}",
    summary="Get backend details",
    description="Get detailed information about a specific backend"
)
async def get_backend_details(
    backend_name: str,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Get detailed information about a specific backend."""
    try:
        registry = _load_integrations_registry()
        integrations = registry.get("integrations", {})
        
        if backend_name not in integrations:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Backend '{backend_name}' not found"
            )
        
        config = integrations[backend_name]
        
        # Build detailed response
        return {
            "name": backend_name,
            "enabled": config.get("enabled", False),
            "type": config.get("type", "unknown"),
            "description": config.get("description", ""),
            "priority": config.get("priority", 999),
            "layer1_implementation": config.get("layer1_implementation", {}),
            "layer2_exposure": config.get("layer2_exposure", {}),
            "layer3_metadata": config.get("layer3_metadata", {}),
            "layer4_runtime": config.get("layer4_runtime", {}),
            "dependencies": config.get("dependencies", {}),
            "tools_reference": config.get("tools_reference", {}),
            "api_endpoints": _get_api_endpoints_for_backend(backend_name),
            "available": _check_backend_available(backend_name)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get backend details: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# Health Checks
# =============================================================================

@router.get(
    "/{backend_name}/health",
    summary="Check backend health",
    description="Perform health check on specific backend"
)
async def check_backend_health(
    backend_name: str,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Check health of a specific backend."""
    try:
        health_status = {}
        
        if backend_name == "ocr":
            backends = ocr_registry.OCRBackendRegistry.list_available_backends()
            health_status = {
                "healthy": any(b.get("available") for b in backends.values()),
                "backends": backends
            }
        
        elif backend_name == "tts":
            tts = realtime_tts.get_tts_integration()
            health_status = await tts.check_health()
        
        elif backend_name == "notebook":
            result = notebook_runtime.nb_list_sys_path()
            health_status = {
                "healthy": True,
                "sys_path_count": result.get("count", 0)
            }
        
        elif backend_name == "omni":
            workflows = omni_tools.omni_workflows()
            health_status = {
                "healthy": True,
                "workflows": len(workflows)
            }
        
        elif backend_name == "xlwings":
            health_status = xlwings_excel.xlwings_health()
        
        else:
            health_status = {
                "healthy": False,
                "message": f"Health check not implemented for {backend_name}"
            }
        
        return {
            "backend": backend_name,
            **health_status
        }
        
    except Exception as e:
        logger.error(f"Health check failed for {backend_name}: {e}", exc_info=True)
        return {
            "backend": backend_name,
            "healthy": False,
            "error": str(e)
        }


# =============================================================================
# Registry Info
# =============================================================================

@router.get(
    "/registry/info",
    summary="Get registry information",
    description="Get metadata about the integrations registry"
)
async def get_registry_info(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Get registry metadata."""
    try:
        registry = _load_integrations_registry()
        metadata = registry.get("metadata", {})
        runtime = registry.get("runtime", {})
        
        return {
            "metadata": metadata,
            "runtime_config": runtime,
            "total_integrations": len(registry.get("integrations", {})),
            "architecture": "4-layer modular abstraction"
        }
        
    except Exception as e:
        logger.error(f"Failed to get registry info: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# Bulk Health Check
# =============================================================================

@router.get(
    "/health/all",
    summary="Check all backends health",
    description="Perform health checks on all backends"
)
async def check_all_backends_health(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """Check health of all backends."""
    try:
        registry = _load_integrations_registry()
        integrations = registry.get("integrations", {})
        
        health_results = {}
        
        for name in integrations.keys():
            try:
                health_results[name] = await check_backend_health(name, _context)
            except Exception as e:
                health_results[name] = {
                    "backend": name,
                    "healthy": False,
                    "error": str(e)
                }
        
        # Count healthy backends
        healthy_count = sum(1 for h in health_results.values() if h.get("healthy", False))
        
        return {
            "total_backends": len(health_results),
            "healthy_backends": healthy_count,
            "unhealthy_backends": len(health_results) - healthy_count,
            "health_checks": health_results
        }
        
    except Exception as e:
        logger.error(f"Bulk health check failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )

