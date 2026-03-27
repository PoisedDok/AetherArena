"""
Services Status Endpoints

Aggregate service status, ports, and health information.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET) --- {HTTP requests to /v1/services/status}
Processing: get_services_status() --- {JOB_DISCOVER_TOOLS, JOB_HTTP_REQUEST, JOB_LOAD_CONFIG}
Outgoing: Frontend (HTTP), integrations_registry.yaml --- {ServicesStatusResponse with service health, ports, and metadata}
"""

from urllib.parse import urlparse
from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status

from api.dependencies import get_settings, setup_request_context, get_research_service, get_registry_gateway
from config.settings import Settings
from data.network.service_gateway import InternalServiceGateway, get_service_gateway
from data.infrastructure.registry_gateway import RegistryGateway
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["services"])


async def check_service_health(
    url: str,
    gateway: Optional[InternalServiceGateway] = None,
    timeout: float = 2.0,
    headers: Dict[str, str] | None = None,
    ok_status_codes: set[int] | None = None,
) -> Dict[str, Any]:
    """Check if a service is healthy."""
    from core.exceptions import NetworkTimeoutError, NetworkConnectionError
    
    if gateway is None:
        from api.dependencies import get_http_client
        gateway = InternalServiceGateway(get_http_client())
    
    try:
        ok_codes = ok_status_codes or {200, 204, 301, 302}
        response = await gateway.execute_request("GET", url, timeout=timeout, headers=headers)
        is_healthy = response.status_code in ok_codes
        return {
            "status": "online" if is_healthy else "degraded",
            "status_code": response.status_code,
            "response_time_ms": response.elapsed.total_seconds() * 1000,
            "error": None if is_healthy else f"HTTP {response.status_code}"
        }
    except NetworkTimeoutError:
        return {"status": "timeout", "error": "Service timed out", "status_code": None}
    except NetworkConnectionError:
        return {"status": "offline", "error": "Connection refused", "status_code": None}
    except Exception as e:
        logger.warning("Service health check failed: %s", e)
        return {"status": "error", "error": "Service check failed. Check server logs.", "status_code": None}


async def check_file_indexing_health(url: str, gateway: Optional[InternalServiceGateway] = None, timeout: float = 2.0) -> Dict[str, Any]:
    """Check file indexing health and interpret service_status when available."""
    from core.exceptions import NetworkTimeoutError, NetworkConnectionError
    
    if gateway is None:
        from api.dependencies import get_http_client
        gateway = InternalServiceGateway(get_http_client())
    try:
        response = await gateway.execute_request("GET", url, timeout=timeout)
        response_time_ms = response.elapsed.total_seconds() * 1000
        status_code = response.status_code
        if status_code not in [200, 204, 301, 302]:
            return {
                "status": "degraded",
                "status_code": status_code,
                "response_time_ms": response_time_ms,
                "error": f"HTTP {status_code}",
            }

        service_status = None
        error_message = None
        try:
            payload = response.json()
            if isinstance(payload, dict):
                service_status = payload.get("service_status")
                error_message = payload.get("error_message")
        except Exception:
            payload = None

        if service_status in {"running", "idle"}:
            status_value = "online"
            error_value = None
        elif service_status == "stopped":
            status_value = "offline"
            error_value = "Service stopped"
        elif service_status == "error":
            status_value = "degraded"
            error_value = error_message or "Service error"
        else:
            status_value = "degraded"
            error_value = "Missing or unknown service_status"

        return {
            "status": status_value,
            "status_code": status_code,
            "response_time_ms": response_time_ms,
            "error": error_value,
            "service_status": service_status,
        }
    except NetworkTimeoutError:
        return {"status": "timeout", "error": "Service timed out", "status_code": None}
    except NetworkConnectionError:
        return {"status": "offline", "error": "Connection refused", "status_code": None}
    except Exception as e:
        logger.warning("File indexing health check failed: %s", e)
        return {"status": "error", "error": "Service check failed. Check server logs.", "status_code": None}


@router.get(
    "/services/status",
    summary="Get services status",
    description="Get status of all backend services including health and port information"
)
async def get_services_status(
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    gateway: InternalServiceGateway = Depends(get_service_gateway),
    registry_gateway: RegistryGateway = Depends(get_registry_gateway)
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
        registry = registry_gateway.get_raw_registry()
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
        lm_studio_port = urlparse(lm_studio_url).port
        
        lm_studio_health = await check_service_health(f"{lm_studio_url}/models", gateway)
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
        
        # 2a. Aether Inference (Native Inference Server)
        if settings.inference.enabled:
            inference_url = settings.inference_url
            inference_port = settings.inference.port
            
            inference_health = await check_service_health(f"{inference_url}/models", gateway)
            services.append({
                "name": "Aether Inference",
                "type": "inference_server",
                "status": inference_health.get("status", "unknown"),
                "port": inference_port,
                "url": inference_url,
                "enabled": settings.inference.enabled,
                "description": "Native model inference server (vllm-mlx / vLLM / Ollama)",
                "response_time_ms": inference_health.get("response_time_ms"),
                "error": inference_health.get("error"),
            })
        
        # 2b. Supabase (Database)
        # CONTRACT: Supabase is the only database backend in this codebase.
        # Show it unconditionally (fail-fast into error/degraded if misconfigured).
        supabase_url = (getattr(settings.supabase, "url", "") or "").rstrip("/")
        supabase_port = urlparse(supabase_url).port if supabase_url else None

        # Supabase REST is protected; treat reachability as "online" when auth is required.
        # Use anon key (public) for a real check; fail-fast into degraded if missing.
        supabase_headers: Dict[str, str] | None = None
        supabase_anon = getattr(settings.supabase, "anon_key", "") or ""
        if isinstance(supabase_anon, str) and supabase_anon.strip():
            anon = supabase_anon.strip()
            supabase_headers = {
                "apikey": anon,
                "Authorization": f"Bearer {anon}",
            }

        if not supabase_url:
            services.append({
                "name": "Supabase",
                "type": "database",
                "status": "error",
                "port": None,
                "url": None,
                "enabled": True,
                "description": "Local Supabase stack (missing SUPABASE_URL)",
                "error": "SUPABASE_URL is empty",
            })
        else:
            if not supabase_headers:
                services.append({
                    "name": "Supabase",
                    "type": "database",
                    "status": "degraded",
                    "port": supabase_port,
                    "url": supabase_url,
                    "enabled": True,
                    "description": "Local Supabase stack (anon key missing; cannot perform authenticated health probe)",
                    "error": "SUPABASE_ANON_KEY is empty",
                })
            else:
                supabase_health = await check_service_health(
                    f"{supabase_url}/rest/v1/",
                    gateway,
                    headers=supabase_headers,
                    ok_status_codes={200, 204, 301, 302, 401, 403},
                )
                services.append({
                    "name": "Supabase",
                    "type": "database",
                    "status": supabase_health.get("status", "unknown"),
                    "port": supabase_port,
                    "url": supabase_url,
                    "enabled": True,
                    "description": "Local Supabase stack (database + REST API)",
                    "response_time_ms": supabase_health.get("response_time_ms"),
                    "error": supabase_health.get("error"),
                    "status_code": supabase_health.get("status_code"),
                })

        # 3. Perplexica (Web Search)
        if settings.integrations.perplexica_enabled:
            perplexica_url = settings.integrations.perplexica_url
            perplexica_port = urlparse(perplexica_url).port
            
            # Perplexica is a Next.js app — root "/" returns 200.
            # There is no /api/health endpoint.
            perplexica_health = await check_service_health(perplexica_url, gateway)
            
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
            searxng_port = urlparse(searxng_url).port
            
            searxng_health = await check_service_health(f"{searxng_url}/healthz", gateway)
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
            from core.integrations.providers.docling import docling_health
            docling_health_result = docling_health()
            docling_status = "online" if docling_health_result.get("healthy") else "error"
            services.append({
                "name": "Docling",
                "type": "document_processing",
                "status": docling_status,
                "port": None,
                "url": None,
                "enabled": settings.integrations.docling_enabled,
                "description": "Document parsing and conversion (on-demand, in-process)",
                "response_time_ms": docling_health_result.get("response_time_ms"),
                "error": docling_health_result.get("error"),
                "details": docling_health_result,
            })
        
        # 6. xlwings (if enabled)
        if settings.integrations.xlwings_enabled:
            services.append({
                "name": "xlwings",
                "type": "excel_automation",
                "status": "on_demand",
                "port": None,
                "url": None,
                "enabled": settings.integrations.xlwings_enabled,
                "description": "Excel workbook automation (on-demand, in-process)",
                "base_dir": settings.integrations.xlwings_base_dir,
            })
        
        # 7. AETHER_RAG MCP (On-device Retrieval)
        try:
            from core.integrations.providers.aether_rag import aether_rag_health
            aether_rag_status = await aether_rag_health()
            
            # Map AETHER_RAG detailed status to service status
            if aether_rag_status.get("healthy"):
                service_status = "online"
            elif aether_rag_status.get("status") == "degraded":
                service_status = "degraded"
            else:
                service_status = "offline"
            
            services.append({
                "name": "AETHER_RAG MCP",
                "type": "retrieval_mcp",
                "status": service_status,
                "port": None,  # MCP stdio protocol, no port
                "url": None,
                "enabled": True,
                "description": "On-device semantic retrieval (MCP)",
                "details": {
                    "server_registered": aether_rag_status.get("server_registered", False),
                    "server_connected": aether_rag_status.get("server_connected", False),
                    "tools_count": aether_rag_status.get("tools_count", 0),
                    "test_search_ok": aether_rag_status.get("test_search_ok", False),
                },
                "error": aether_rag_status.get("error")
            })
        except Exception as e:
            logger.warning("AETHER_RAG health check failed: %s", e)
            services.append({
                "name": "AETHER_RAG MCP",
                "type": "retrieval_mcp",
                "status": "error",
                "enabled": True,
                "description": "On-device semantic retrieval (MCP)",
                "error": "Health check failed. Check server logs."
            })
        
        # 9. Embedding Service (hosted inside Perplexica Docker container)
        if settings.embedding_service.enabled:
            embedding_health = await check_service_health(settings.embedding_service.service_url, gateway)
            services.append({
                "name": "Embedding Service",
                "type": "embedding",
                "status": embedding_health.get("status", "unknown"),
                "url": settings.embedding_service.service_url,
                "enabled": settings.embedding_service.enabled,
                "description": f"Local ONNX embedding ({settings.embedding_service.model})",
                "response_time_ms": embedding_health.get("response_time_ms"),
                "error": embedding_health.get("error"),
                "model": settings.embedding_service.model,
                "quality_model": settings.embedding_service.quality_model,
                "dimensions": settings.embedding_service.dimensions
            })
        
        # 10. File Indexing (via Backend API)
        if settings.integrations.file_indexing_enabled:
            # Canonical file-indexing API lives at /v1/file/* (no legacy /v1/api/files alias).
            file_indexing_base = settings.integrations.file_indexing_backend_url or settings.base_url
            fi_health = await check_file_indexing_health(
                f"{file_indexing_base}/v1/file/health",
                gateway
            )
            services.append({
                "name": "File Indexing",
                "type": "file_indexing",
                "status": fi_health.get("status", "unknown"),
                "port": None,  # Runs as part of backend
                "url": f"{file_indexing_base}/v1/file",
                "enabled": settings.integrations.file_indexing_enabled,
                "description": "File system indexing with AETHER_RAG semantic search",
                "response_time_ms": fi_health.get("response_time_ms"),
                "error": fi_health.get("error"),
                "service_status": fi_health.get("service_status"),
            })
        
        # 11. MCP Manager
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
        logger.error("Failed to get services status: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve services status"
        )


@router.get(
    "/status/research",
    summary="Research Service Status",
    description="Check research service status and configuration"
)
async def get_research_status(
    research_service = Depends(get_research_service),
    _context: dict = Depends(setup_request_context)
):
    """
    Check research service status.
    Clean endpoint: /v1/status/research
    """
    try:
        from application.research.research_service import ResearchError
        return await research_service.get_research_status()
    except ResearchError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
    except Exception as e:
        logger.error("Research status failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Research status error. Check server logs for details."
        )

