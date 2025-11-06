"""
Services Status Endpoints

Aggregate service status, ports, and health information.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET) --- {HTTP requests to /v1/services/status}
Processing: get_services_status() --- {5 jobs: http_communication, integration_health_checking, service_discovery, data_aggregation, error_handling}
Outgoing: Frontend (HTTP), integrations_registry.yaml --- {ServicesStatusResponse with service health, ports, and metadata}
"""

import httpx
import yaml
from pathlib import Path
from typing import Dict, Any, List
from fastapi import APIRouter, Depends, HTTPException, status

from api.dependencies import get_settings, setup_request_context
from config.settings import Settings
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["services"])


async def check_service_health(url: str, timeout: float = 2.0) -> Dict[str, Any]:
    """Check if a service is healthy."""
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url)
            is_healthy = response.status_code in [200, 204, 301, 302]
            return {
                "status": "online" if is_healthy else "degraded",
                "status_code": response.status_code,
                "response_time_ms": response.elapsed.total_seconds() * 1000,
                "error": None if is_healthy else f"HTTP {response.status_code}"
            }
    except httpx.TimeoutException:
        return {"status": "timeout", "error": "Service timed out", "status_code": None}
    except httpx.ConnectError:
        return {"status": "offline", "error": "Connection refused", "status_code": None}
    except Exception as e:
        return {"status": "error", "error": str(e), "status_code": None}


def load_integrations_registry() -> Dict[str, Any]:
    """Load integrations registry from YAML."""
    try:
        config_dir = Path(__file__).parent.parent.parent.parent / "config"
        registry_path = config_dir / "integrations_registry.yaml"
        
        if not registry_path.exists():
            logger.warning(f"Integrations registry not found: {registry_path}")
            return {}
        
        with open(registry_path, 'r') as f:
            return yaml.safe_load(f)
    except Exception as e:
        logger.error(f"Failed to load integrations registry: {e}")
        return {}


@router.get(
    "/services/status",
    summary="Get services status",
    description="Get status of all backend services including health and port information"
)
async def get_services_status(
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Get comprehensive services status.
    
    Returns:
        - Backend core service info
        - All integration services with health checks
        - Port information
        - Configuration status
    """
    try:
        # Load integrations registry
        registry = load_integrations_registry()
        integrations_config = registry.get("integrations", {})
        
        # Build service list
        services = []
        
        # 1. Backend Core (WebSocket + API)
        services.append({
            "name": "Aether Backend",
            "type": "core",
            "status": "online",
            "port": settings.security.bind_port,
            "host": settings.security.bind_host,
            "url": f"http://{settings.security.bind_host}:{settings.security.bind_port}",
            "protocols": ["HTTP", "WebSocket"],
            "description": "Main backend API and WebSocket server"
        })
        
        # 2. LM Studio (LLM Provider)
        lm_studio_url = settings.llm.api_base
        lm_studio_port = None
        if "localhost" in lm_studio_url or "127.0.0.1" in lm_studio_url:
            try:
                lm_studio_port = int(lm_studio_url.split(":")[2].split("/")[0])
            except:
                lm_studio_port = 1234
        
        lm_studio_health = await check_service_health(f"{lm_studio_url}/models")
        services.append({
            "name": "LM Studio",
            "type": "llm_provider",
            "status": lm_studio_health.get("status", "unknown"),
            "port": lm_studio_port,
            "url": lm_studio_url,
            "enabled": True,
            "description": "Local LLM inference server",
            "response_time_ms": lm_studio_health.get("response_time_ms"),
            "error": lm_studio_health.get("error")
        })
        
        # 3. Perplexica (Web Search)
        if settings.integrations.perplexica_enabled:
            perplexica_url = settings.integrations.perplexica_url
            perplexica_port = None
            try:
                perplexica_port = int(perplexica_url.split(":")[2])
            except:
                perplexica_port = 3000
            
            # Try multiple health check endpoints
            perplexica_health = await check_service_health(f"{perplexica_url}/api/health")
            if perplexica_health.get("status") == "degraded":
                # Fallback: just ping the root URL
                root_check = await check_service_health(perplexica_url)
                if root_check.get("status") == "online":
                    perplexica_health = root_check
            
            services.append({
                "name": "Perplexica",
                "type": "search",
                "status": perplexica_health.get("status", "unknown"),
                "port": perplexica_port,
                "url": perplexica_url,
                "enabled": settings.integrations.perplexica_enabled,
                "description": "Web search and research engine",
                "response_time_ms": perplexica_health.get("response_time_ms"),
                "error": perplexica_health.get("error"),
                "status_code": perplexica_health.get("status_code")
            })
        
        # 4. SearXNG (Search Backend)
        if settings.integrations.searxng_enabled:
            searxng_url = settings.integrations.searxng_url
            searxng_port = None
            try:
                searxng_port = int(searxng_url.split(":")[2])
            except:
                searxng_port = 4000
            
            searxng_health = await check_service_health(f"{searxng_url}/healthz")
            services.append({
                "name": "SearXNG",
                "type": "search_backend",
                "status": searxng_health.get("status", "unknown"),
                "port": searxng_port,
                "url": searxng_url,
                "enabled": settings.integrations.searxng_enabled,
                "description": "Metasearch engine backend",
                "response_time_ms": searxng_health.get("response_time_ms"),
                "error": searxng_health.get("error")
            })
        
        # 5. Docling (Document Processing)
        if settings.integrations.docling_enabled:
            docling_url = settings.integrations.docling_url
            docling_port = None
            try:
                docling_port = int(docling_url.split(":")[2])
            except:
                docling_port = 8000
            
            docling_health = await check_service_health(f"{docling_url}/health")
            services.append({
                "name": "Docling",
                "type": "document_processing",
                "status": docling_health.get("status", "unknown"),
                "port": docling_port,
                "url": docling_url,
                "enabled": settings.integrations.docling_enabled,
                "description": "Document parsing and conversion",
                "response_time_ms": docling_health.get("response_time_ms"),
                "error": docling_health.get("error")
            })
        
        # 6. xlwings (if enabled)
        if settings.integrations.xlwings_enabled:
            xlwings_url = settings.integrations.xlwings_url
            xlwings_port = None
            try:
                xlwings_port = int(xlwings_url.split(":")[2])
            except:
                xlwings_port = 8080
            
            services.append({
                "name": "xlwings",
                "type": "excel_automation",
                "status": "library",
                "port": xlwings_port,
                "url": xlwings_url,
                "enabled": settings.integrations.xlwings_enabled,
                "description": "Excel workbook automation"
            })
        
        # 7. MCP Servers
        if settings.integrations.mcp_enabled:
            services.append({
                "name": "MCP Manager",
                "type": "mcp",
                "status": "online",
                "port": None,
                "url": None,
                "enabled": settings.integrations.mcp_enabled,
                "description": "Model Context Protocol servers",
                "auto_start": settings.integrations.mcp_auto_start
            })
        
        # Summary statistics
        total_services = len(services)
        online_services = len([s for s in services if s.get("status") == "online"])
        offline_services = len([s for s in services if s.get("status") == "offline"])
        enabled_services = len([s for s in services if s.get("enabled", True)])
        
        return {
            "services": services,
            "summary": {
                "total": total_services,
                "online": online_services,
                "offline": offline_services,
                "enabled": enabled_services
            },
            "integrations_loaded": len(integrations_config),
            "environment": settings.environment
        }
        
    except Exception as e:
        logger.error(f"Failed to get services status: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve services status"
        )

