"""
Search API Endpoints

Web search, academic search, and specialized research tools via Perplexica.

@.architecture
Incoming: Frontend HTTP requests, api/v1/router.py --- {HTTP POST /v1/search with query params}
Processing: search() routes to Perplexica integration --- {2 jobs: JOB_HTTP_REQUEST, JOB_TRANSFORM_DATA}
Outgoing: Frontend, Perplexica service --- {Dict search results with answer and sources}
"""

from typing import Optional, Literal, Dict, Any, List
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from data.network.search_gateway import get_search_gateway
from core.domain.gateway_interfaces import ISearchGateway
from core.exceptions import DomainException

from api.dependencies import (
    get_settings, 
    setup_request_context, 
    get_supabase_uow,
    get_search_orchestrator
)
from data.database.uow import SupabaseUnitOfWork
from config.settings import Settings
from core.integrations.providers.perplexica.search import (
    perplexica_models,
    show_current_model
)
from application.indexing.index_service import IndexNotFoundError, IndexingError
from core.exceptions import ResourceNotFoundError
from monitoring import get_logger

# Import research request model (defined in research.py)
from api.v1.schemas.research import ResearchRequest

# --- Search Strategy Orchestrator Setup ---
from application.search.interfaces import SearchContext
from application.search.orchestrator import SearchOrchestrator
from application.search.providers.perplexica_providers import DiscoverRequest
from application.search.providers.legal_search_provider import LegalSearchRequest, LegalDatabasesRequest

def get_search_orchestrator():
    """DEPRECATED: Use Dependency Injection instead. Kept only for backwards compatibility."""
    from api.dependencies import get_search_orchestrator as get_di_search_orchestrator
    return get_di_search_orchestrator()

def build_search_context(
    request: Request,
    settings: Settings = Depends(get_settings),
    gateway: ISearchGateway = Depends(get_search_gateway),
    _context: dict = Depends(setup_request_context),
    uow: SupabaseUnitOfWork = Depends(get_supabase_uow)
) -> SearchContext:
    return SearchContext(
        settings=settings, 
        gateway=gateway, 
        uow=uow,
        request_context=_context, 
        request=request
    )
# ------------------------------------------

logger = get_logger(__name__)
router = APIRouter(prefix="/search", tags=["search"])


# ==============================================================================
# Helper: Merge JSON body with Query params (JSON takes precedence)
# ==============================================================================

def merge_body_and_query(body: Optional[BaseModel], **query_params) -> Dict[str, Any]:
    """
    Merge JSON body with Query parameters, with JSON body taking precedence.
    
    Args:
        body: Optional Pydantic model from request body
        **query_params: Query parameters as kwargs
    
    Returns:
        Merged dictionary with JSON body values overriding query params
    """
    result = {}
    
    # Start with query params (filter out None values)
    for key, value in query_params.items():
        if value is not None:
            result[key] = value
    
    # Override with body values (filter out None values)
    if body:
        body_dict = body.dict(exclude_unset=True)
        for key, value in body_dict.items():
            if value is not None:
                result[key] = value
    
    return result


class SearchRequest(BaseModel):
    """Search request payload (supports both JSON body and Query params)."""
    query: Optional[str] = Field(None, description="Search query or question")
    mode: Optional[Literal["fast", "speed", "balanced", "quality"]] = Field(
        None,
        description="Search mode: fast=SearXNG raw results, speed/balanced/quality=Perplexica AI"
    )
    max_results: Optional[int] = Field(None, description="Maximum results to return")
    engines: Optional[str] = Field(None, description="Comma-separated engine names (fast mode only)")
    category: Optional[str] = Field(None, description="Search category (fast mode only)")
    time_range: Optional[str] = Field(None, description="Time range filter (fast mode only)")
    sources: Optional[str] = Field(
        None,
        description="Comma-separated source types to search: web,academic,discussions,legal. "
                    "Overrides default source from focus mode. Example: 'web,academic'"
    )
    chat_model: Optional[str] = Field(
        None,
        description="Optional canonical model name to use for Perplexica synthesis. "
                    "Default: LFM 1.2B (summarizer_model from config)."
    )


class SearchResponse(BaseModel):
    """Search response with answer and sources."""
    query: str
    answer: str
    sources: list
    source_count: int
    focus_mode: str
    model_used: Optional[str] = None
    timestamp: str


class UnifiedSearchRequest(BaseModel):
    """Unified search request (supports both JSON body and Query params)."""
    query: Optional[str] = Field(None, description="Search query")
    ai_mode: Optional[bool] = Field(None, description="Use AI-powered web search")
    include_local: Optional[bool] = Field(None, description="Include local index search")
    mode: Optional[Literal["speed", "balanced", "quality"]] = Field(None, description="Search mode")
    max_results: Optional[int] = Field(None, ge=1, le=20, description="Max web results")
    local_top_k: Optional[int] = Field(None, ge=1, le=2000, description="Local top_k override")
    local_min_score: Optional[float] = Field(None, ge=0.0, le=1.0, description="Local min_score override")


class ChatSearchRequest(BaseModel):
    """Chat search request (supports both JSON body and Query params)."""
    query: Optional[str] = Field(None, description="Search query")
    limit: Optional[int] = Field(None, ge=1, le=100, description="Max results")


class UnifiedSearchResponse(BaseModel):
    """Unified search response (web + local)."""
    query: str
    ai_mode: bool
    web: Optional[Dict[str, Any]] = None
    local: Optional[Dict[str, Any]] = None
    timestamp: str


class MultiIndexSearchRequest(BaseModel):
    """Multi-index search request payload (supports both JSON body and Query params)."""
    query: Optional[str] = Field(None, min_length=1, max_length=500, description="Search query")
    index_names: Optional[List[str]] = Field(None, description="List of index names to search")
    top_k: Optional[int] = Field(None, ge=1, le=2000, description="Results per index")
    min_score: Optional[float] = Field(None, ge=0.0, le=1.0, description="Minimum relevance score")
    mode: Optional[Literal["semantic", "bm25", "hybrid"]] = Field("bm25", description="Search mode")


@router.post(
    "/web",
    summary="Web Search",
    description="Web search with AI (Perplexica) or fast raw results (SearXNG)",
    openapi_extra={"is_agent_tool": True})
async def search_web(
    body: SearchRequest = None,
    query: Optional[str] = Query(None, description="Search query or question"),
    mode: Optional[Literal["fast", "speed", "balanced", "quality"]] = Query(None, description="Search mode"),
    max_results: Optional[int] = Query(None, description="Maximum results to return"),
    engines: Optional[str] = Query(None, description="Comma-separated engine names (fast mode only)"),
    category: Optional[str] = Query(None, description="Search category (fast mode only)"),
    time_range: Optional[str] = Query(None, description="Time range filter (fast mode only)"),
    sources: Optional[str] = Query(None, description="Comma-separated sources: web,academic,discussions,legal"),
    chat_model: Optional[str] = Query(None, description="Optional model name for Perplexica synthesis"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Unified web search endpoint.
    
    Modes:
    - fast: SearXNG raw results (no AI, < 2s)
    - speed/balanced/quality: Perplexica AI synthesis (slower, better answers)
    
    Supports BOTH formats:
    1. JSON body: {"query": "...", "mode": "balanced", ...}
    2. Query params: ?query=...&mode=balanced&...
    
    Optional advanced parameters:
    - sources: Comma-separated source types to search (web,academic,discussions,legal).
      Default: auto-detected from query intent.
    - chat_model: Canonical model name to use for Perplexica synthesis.
      Default: LFM 1.2B (summarizer_model).
    
    Tool signature: search_web(query, mode="balanced", max_results=8, engines=None, category=None, time_range=None, sources=None, chat_model=None)
    """
    try:
        # Merge JSON body and Query params (JSON takes precedence)
        params = merge_body_and_query(
            body,
            query=query,
            mode=mode,
            max_results=max_results,
            engines=engines,
            category=category,
            time_range=time_range,
            sources=sources,
            chat_model=chat_model
        )
        
        # Validate required fields
        if not params.get("query"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="query is required (provide in JSON body or Query param)"
            )
        
        # Apply defaults
        params.setdefault("mode", "speed")
        params.setdefault("max_results", 8)
        
        # Build command and route
        command = SearchRequest(**params)
        return await orchestrator.execute("web", command, context)
    
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Web search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal search error. Check server logs for details."
        )


@router.post(
    "/academic",
    response_model=SearchResponse,
    summary="Academic Search",
    description="Search academic papers from arXiv, PubMed, Google Scholar",
    openapi_extra={"is_agent_tool": True})
async def search_academic(
    request: SearchRequest,
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Search academic research papers and publications."""
    try:
        return await orchestrator.execute("academic", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Academic search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal search error. Check server logs for details."
        )


@router.post(
    "/reddit",
    response_model=SearchResponse,
    summary="Reddit Search",
    description="Search Reddit discussions and community insights",
    openapi_extra={"is_agent_tool": True})
async def search_reddit(
    request: SearchRequest,
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Search Reddit for community discussions and insights."""
    try:
        return await orchestrator.execute("reddit", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Reddit search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal search error. Check server logs for details."
        )


@router.post(
    "/wolfram",
    response_model=SearchResponse,
    summary="Wolfram Alpha Search",
    description="Computational knowledge search via Wolfram Alpha",
    openapi_extra={"is_agent_tool": True})
async def search_wolfram(
    request: SearchRequest,
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Search using Wolfram Alpha for computational knowledge."""
    try:
        return await orchestrator.execute("wolfram", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Wolfram search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal search error. Check server logs for details."
        )


@router.post(
    "/writing",
    response_model=SearchResponse,
    summary="Writing Assistant",
    description="AI writing assistant for grammar, style, and content",
    openapi_extra={"is_agent_tool": True})
async def writing_assist(
    request: SearchRequest,
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """AI writing assistant for grammar, style, and content improvement."""
    try:
        return await orchestrator.execute("writing", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Writing assist failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error. Check server logs for details."
        )


class ImageSearchRequest(BaseModel):
    """Image search request."""
    query: str = Field(..., description="Image search query")


class VideoSearchRequest(BaseModel):
    """Video search request."""
    query: str = Field(..., description="Video search query")


class SuggestionsRequest(BaseModel):
    """Suggestions generation request."""
    history: List[List[str]] = Field(..., description="Chat history as [[role, content], ...]")


@router.post(
    "/images",
    summary="Image Search",
    description="Search for images using Perplexica",
    openapi_extra={"is_agent_tool": True})
async def search_images(
    request: ImageSearchRequest,
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Search for images using Perplexica."""
    try:
        return await orchestrator.execute("images", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Image search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error. Check server logs for details."
        )


@router.post(
    "/videos",
    summary="Video Search",
    description="Search for videos using Perplexica",
    openapi_extra={"is_agent_tool": True})
async def search_videos(
    request: VideoSearchRequest,
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Search for videos using Perplexica."""
    try:
        return await orchestrator.execute("videos", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Video search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error. Check server logs for details."
        )


@router.post(
    "/suggestions",
    summary="Generate Suggestions",
    description="Generate follow-up question suggestions from chat history",
    openapi_extra={"is_agent_tool": True})
async def generate_suggestions(
    request: SuggestionsRequest,
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Generate follow-up suggestions from chat history."""
    try:
        return await orchestrator.execute("suggestions", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Suggestions failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error. Check server logs for details."
        )


@router.get(
    "/discover",
    summary="Discover News",
    description="Get curated news articles by topic",
    openapi_extra={"is_agent_tool": True})
async def discover(
    topic: str = Query("tech", description="News topic: tech, finance, art, sports, entertainment"),
    mode: str = Query("normal", description="Mode: normal (full) or preview (quick)"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Get curated news articles by topic."""
    try:
        request = DiscoverRequest(topic=topic, mode=mode)
        return await orchestrator.execute("discover", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Discover failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error. Check server logs for details."
        )


class LegalSearchRequest(BaseModel):
    """Legal search request."""
    query: str = Field(..., description="Search query (case name, citation, keywords)")
    jurisdiction: str = Field(default="all", description="uk, us, commonwealth, eu, international, all")
    document_type: str = Field(default="cases", description="cases, legislation, statutes, regulations, treaties")


@router.post(
    "/legal",
    summary="Legal Database Search",
    description="Search legal databases across UK, US, Commonwealth, EU, and International jurisdictions",
    openapi_extra={"is_agent_tool": True})
async def search_legal(
    request: LegalSearchRequest,
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Multi-jurisdiction legal database search."""
    try:
        return await orchestrator.execute("legal", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Legal search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error. Check server logs for details."
        )


@router.get(
    "/legal/databases",
    summary="List Legal Databases",
    description="Get available legal databases by jurisdiction"
)
async def list_legal_databases(
    jurisdiction: str = Query("all", description="Filter by jurisdiction"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """List available legal databases."""
    try:
        request = LegalDatabasesRequest(jurisdiction=jurisdiction)
        return await orchestrator.execute("legal", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list legal databases: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error. Check server logs for details."
        )


@router.post(
    "/legal/cases",
    summary="Search Case Law",
    description="Search case law across jurisdictions",
    openapi_extra={"is_agent_tool": True})
async def search_legal_cases(
    query: str = Query(..., description="Case name, citation, or keywords"),
    jurisdiction: str = Query("all", description="uk, us, commonwealth, eu, international, all"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Search case law."""
    try:
        request = LegalSearchRequest(query=query, jurisdiction=jurisdiction, document_type="cases")
        return await orchestrator.execute("legal", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Case search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error. Check server logs for details."
        )


@router.post(
    "/legal/legislation",
    summary="Search Legislation",
    description="Search statutes, acts, and codes",
    openapi_extra={"is_agent_tool": True})
async def search_legal_legislation(
    query: str = Query(..., description="Statute name, code section, or keywords"),
    jurisdiction: str = Query("all", description="uk, us, commonwealth, eu, international, all"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """Search legislation and statutes."""
    try:
        request = LegalSearchRequest(query=query, jurisdiction=jurisdiction, document_type="legislation")
        return await orchestrator.execute("legal", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Legislation search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error. Check server logs for details."
        )


@router.get(
    "/models",
    summary="Get Search Models",
    description="Get current model configuration for search"
)
async def get_search_models(
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ISearchGateway = Depends(get_search_gateway)
):
    """Get current model configuration from backend."""
    try:
        models_info = perplexica_models()
        return {
            "models": models_info,
            "perplexica_enabled": settings.integrations.perplexica_enabled,
            "perplexica_url": settings.integrations.perplexica_url
        }
    except Exception as e:
        logger.error("Failed to get models: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get models. Check server logs for details."
        )


@router.get(
    "/unified",
    response_model=UnifiedSearchResponse,
    summary="Unified Search (Web + Local) - GET",
    description="Search web and local indexes in one request (Query params)",
    openapi_extra={"is_agent_tool": True})
@router.post(
    "/unified",
    response_model=UnifiedSearchResponse,
    summary="Unified Search (Web + Local) - POST",
    description="Search web and local indexes in one request (JSON body or Query params)",
    openapi_extra={"is_agent_tool": True})
async def search_unified(
    body: UnifiedSearchRequest = None,
    query: Optional[str] = Query(None, description="Search query"),
    ai_mode: Optional[bool] = Query(None, description="Use AI-powered web search"),
    include_local: Optional[bool] = Query(None, description="Include local index search"),
    mode: Optional[Literal["speed", "balanced", "quality"]] = Query(None),
    max_results: Optional[int] = Query(None, ge=1, le=20, description="Max web results"),
    local_top_k: Optional[int] = Query(None, ge=1, le=2000, description="Local top_k override"),
    local_min_score: Optional[float] = Query(None, ge=0.0, le=1.0, description="Local min_score override"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Unified search across web (Perplexica or Searxng) and local AetherRag indexes.
    
    Supports BOTH GET and POST methods:
    - GET with Query params: ?query=...&ai_mode=true&...
    - POST with JSON body: {"query": "...", "ai_mode": true, ...}
    - POST with Query params: ?query=...&ai_mode=true&...
    """
    try:
        params = merge_body_and_query(
            body,
            query=query,
            ai_mode=ai_mode,
            include_local=include_local,
            mode=mode,
            max_results=max_results,
            local_top_k=local_top_k,
            local_min_score=local_min_score
        )
        
        if not params.get("query"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="query is required"
            )
        
        params.setdefault("ai_mode", True)
        params.setdefault("include_local", True)
        params.setdefault("mode", "speed")
        params.setdefault("max_results", 8)
        
        command = UnifiedSearchRequest(**params)
        return await orchestrator.execute("unified", command, context)
        
    except (HTTPException, DomainException):
        raise
    except IndexNotFoundError as e:
        logger.warning("Index not found in search_unified: %s", e)
        raise ResourceNotFoundError(str(e))
    except IndexingError as e:
        logger.warning("Indexing error in search_unified: %s", e)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("Unified search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unified search error. Check server logs for details."
        )


# ============================================================================
# Nested Context Discovery Endpoints
# ============================================================================

@router.get(
    "",
    summary="Discover Search Sources",
    description="List all available search sources for nested discovery"
)
async def discover_sources(
    request: Request,
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ISearchGateway = Depends(get_search_gateway)
):
    """
    Discovery endpoint - lists all available search sources.
    
    Supports GURU agent's nested context pattern:
    1. Agent discovers available sources
    2. Agent chooses appropriate source
    3. Agent executes search with source-specific params
    """
    try:
        # Build discovery response from OpenAPI so agents get:
        # - exact API paths/methods
        # - full param list (including defaults/enums) for action_source(params)
        spec = request.app.openapi()
        paths = (spec or {}).get("paths") or {}

        sources = []
        for path, methods in paths.items():
            if not isinstance(path, str) or not path.startswith("/v1/search"):
                continue
            if not isinstance(methods, dict):
                continue

            # /v1/search or /v1/search/<source>
            parts = [p for p in path.split("/") if p]
            source_name = parts[2] if len(parts) >= 3 else "search"

            for http_method, op in methods.items():
                m = str(http_method).upper()
                if m not in {"GET", "POST"}:
                    continue
                if not isinstance(op, dict):
                    continue

                params = []
                for p in op.get("parameters") or []:
                    if not isinstance(p, dict):
                        continue
                    schema = p.get("schema") or {}
                    params.append(
                        {
                            "name": p.get("name"),
                            "in": p.get("in"),
                            "required": bool(p.get("required")),
                            "description": p.get("description") or "",
                            "type": (schema.get("type") if isinstance(schema, dict) else None),
                            "default": (schema.get("default") if isinstance(schema, dict) else None),
                            "enum": (schema.get("enum") if isinstance(schema, dict) else None),
                        }
                    )

                rb = op.get("requestBody") or {}
                content = rb.get("content") or {}
                app_json = content.get("application/json") or {}
                body_schema = (app_json.get("schema") or {}) if isinstance(app_json, dict) else {}
                if body_schema:
                    body_fields = None
                    ref = body_schema.get("$ref")
                    if isinstance(ref, str) and ref.startswith("#/"):
                        # Resolve local schema refs for agent-friendly param listing.
                        # Example: {"$ref": "#/components/schemas/SearchRequest"}
                        try:
                            parts = ref[2:].split("/")  # drop "#/"
                            if len(parts) >= 3 and parts[0] == "components" and parts[1] == "schemas":
                                schema_name = parts[2]
                                schema_def = (((spec or {}).get("components") or {}).get("schemas") or {}).get(schema_name) or {}
                                if isinstance(schema_def, dict):
                                    required_fields = set(schema_def.get("required") or [])
                                    props = schema_def.get("properties") or {}
                                    if isinstance(props, dict):
                                        body_fields = []
                                        for fname, fdef in props.items():
                                            if not isinstance(fdef, dict):
                                                continue
                                            body_fields.append(
                                                {
                                                    "name": fname,
                                                    "required": fname in required_fields,
                                                    "description": fdef.get("description") or "",
                                                    "type": fdef.get("type"),
                                                    "default": fdef.get("default"),
                                                    "enum": fdef.get("enum"),
                                                }
                                            )
                                        body_fields.sort(key=lambda x: (not x["required"], x["name"]))
                        except Exception:
                            body_fields = None

                    params.append(
                        {
                            "name": "body",
                            "in": "body",
                            "required": bool(rb.get("required")),
                            "description": rb.get("description") or "",
                            "schema_ref": body_schema.get("$ref"),
                            "fields": body_fields,
                        }
                    )

                sources.append(
                    {
                        "name": source_name,
                        "tool": f"search_{source_name.replace('-', '_')}",
                        "path": path,
                        "method": m,
                        "summary": op.get("summary") or "",
                        "description": op.get("description") or "",
                        "params": params,
                        "enabled": True,
                    }
                )

        # Policy: hide Perplexica-only sources when integration disabled
        if not settings.integrations.perplexica_enabled:
            sources = [
                s
                for s in sources
                if s.get("name") not in {"web", "academic", "reddit", "wolfram", "writing", "research"}
            ]

        # Stable ordering for deterministic agent UX
        sources.sort(key=lambda s: (s.get("name") or "", s.get("method") or "", s.get("path") or ""))

        return {"sources": sources, "total": len(sources)}
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to discover sources: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to discover sources. Check server logs for details."
        )


class FileSearchRequest(BaseModel):
    """File search request (supports both JSON body and Query params)."""
    query: Optional[str] = Field(None, min_length=3, max_length=500, description="Search query")
    top_k: Optional[int] = Field(None, ge=1, le=2000, description="Max results")
    limit: Optional[int] = Field(None, ge=1, le=2000, description="Alias of top_k")
    mode: Optional[Literal["semantic", "bm25", "hybrid"]] = Field(
        "bm25",
        description="Search mode: semantic (vector), bm25 (keyword), hybrid (RRF fusion)"
    )
    min_score: Optional[float] = Field(None, ge=0.0, le=1.0, description="Minimum relevance score")


@router.get(
    "/files",
    summary="Search Files - GET",
    description="Search indexed files (Query params)",
    openapi_extra={"is_agent_tool": True})
@router.post(
    "/files",
    summary="Search Files - POST",
    description="Search indexed files (JSON body or Query params)",
    openapi_extra={"is_agent_tool": True})
async def search_files(
    body: FileSearchRequest = None,
    query: Optional[str] = Query(None, min_length=3, max_length=500, description="Search query"),
    top_k: Optional[int] = Query(None, ge=1, le=2000, description="Max results"),
    limit: Optional[int] = Query(None, ge=1, le=2000, description="Alias of top_k"),
    mode: Optional[Literal["semantic", "bm25", "hybrid"]] = Query(
        "bm25", description="Search mode: semantic (vector), bm25 (keyword), hybrid (RRF fusion)"
    ),
    min_score: Optional[float] = Query(None, ge=0.0, le=1.0, description="Minimum relevance score"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Search indexed files across all file indexes.
    Clean endpoint: /v1/search/files
    
    Supports BOTH GET and POST methods:
    - GET with Query params: ?query=search text&top_k=10&mode=bm25&min_score=0.5
    - POST with JSON body: {"query": "search text", "top_k": 10, "mode": "hybrid", "min_score": 0.5}
    - POST with Query params: ?query=search text&top_k=10&mode=bm25
    
    Modes:
    - semantic: Vector similarity search
    - bm25: Keyword-based search (default, best for exact phrases)
    - hybrid: RRF fusion of semantic + BM25 (best overall quality)
    """
    try:
        params = merge_body_and_query(body, query=query, top_k=top_k, limit=limit, mode=mode, min_score=min_score)
        if not params.get("query"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="query is required")
        
        if params.get("top_k") is None and params.get("limit") is not None:
            params["top_k"] = params["limit"]
            
        command = FileSearchRequest(**params)
        return await orchestrator.execute("files", command, context)
    except (HTTPException, DomainException):
        raise
    except IndexNotFoundError as e:
        logger.warning("Index not found in search_files: %s", e)
        raise ResourceNotFoundError(str(e))
    except IndexingError as e:
        logger.warning("Indexing error in search_files: %s", e)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("File search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="File search error. Check server logs for details."
        )


class MemorySearchRequest(BaseModel):
    """Memory search request (supports both JSON body and Query params)."""
    query: Optional[str] = Field(None, description="Search query")
    search_type: Optional[Literal["vector", "hybrid"]] = Field(None, description="Search type")
    limit: Optional[int] = Field(None, ge=1, le=100, description="Max results")
    threshold: Optional[float] = Field(None, ge=0.0, le=1.0, description="Min threshold")


@router.get(
    "/memories",
    summary="Search Memories - GET",
    description="Search semantic memories using vector/hybrid search (Query params)",
    openapi_extra={"is_agent_tool": True})
@router.post(
    "/memories",
    summary="Search Memories - POST",
    description="Search semantic memories using vector/hybrid search (JSON body or Query params)",
    openapi_extra={"is_agent_tool": True})
async def search_memories_endpoint(
    request: Request,
    body: MemorySearchRequest = None,
    query: Optional[str] = Query(None, description="Search query"),
    search_type: Optional[Literal["vector", "hybrid"]] = Query(None),
    limit: Optional[int] = Query(None, ge=1, le=100),
    threshold: Optional[float] = Query(None, ge=0.0, le=1.0),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Search semantic memories.
    Clean endpoint: /v1/search/memories
    
    Supports BOTH GET and POST methods:
    - GET with Query params: ?query=test&search_type=vector&limit=20
    - POST with JSON body: {"query": "test", "search_type": "vector", "limit": 20}
    - POST with Query params: ?query=test&search_type=vector&limit=20
    """
    try:
        params = merge_body_and_query(body, query=query, search_type=search_type, limit=limit, threshold=threshold)
        if not params.get("query"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="query is required")
        
        command = MemorySearchRequest(**params)
        return await orchestrator.execute("memories", command, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Memory search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Memory search error. Check server logs for details."
        )


class AgentSearchRequest(BaseModel):
    agent_name: str
    query: str
    top_k: int = 10


@router.get(
    "/chats",
    summary="Search Chats - GET",
    description="Search chat histories (Query params)",
    openapi_extra={"is_agent_tool": True})
@router.post(
    "/chats",
    summary="Search Chats - POST",
    description="Search chat histories (JSON body or Query params)",
    openapi_extra={"is_agent_tool": True})
async def search_chats_endpoint(
    request: Request,
    body: ChatSearchRequest = None,
    query: Optional[str] = Query(None, description="Search query"),
    limit: Optional[int] = Query(None, ge=1, le=100),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Search semantic chat histories.
    Clean endpoint: /v1/search/chats
    """
    try:
        params = merge_body_and_query(body, query=query, limit=limit)
        if not params.get("query"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="query is required")
        
        command = ChatSearchRequest(**params)
        return await orchestrator.execute("chats", command, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Chat search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Chat search error. Check server logs for details."
        )


@router.get(
    "/agents",
    summary="Search Agents",
    description="Search agent outputs by agent name",
    openapi_extra={"is_agent_tool": True})
async def search_agents_endpoint(
    agent_name: str = Query(..., description="Agent name"),
    query: str = Query(..., description="Search query"),
    top_k: int = Query(default=10, ge=1, le=2000, description="Max results"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Search agent outputs using semantic search (AetherRag).
    Clean endpoint: /v1/search/agents
    """
    try:
        request = AgentSearchRequest(agent_name=agent_name, query=query, top_k=top_k)
        return await orchestrator.execute("agents", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Agent search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Agent search error. Check server logs for details."
        )


class NotebookSearchRequest(BaseModel):
    query: str
    include_stdlib: bool = True
    limit: int = 50


@router.post(
    "/notebooks",
    summary="Search Notebooks",
    description="Search notebook modules",
    openapi_extra={"is_agent_tool": True})
async def search_notebooks_endpoint(
    query: str = Query(..., description="Search query"),
    include_stdlib: bool = Query(default=True, description="Include standard library modules"),
    limit: int = Query(default=50, ge=1, le=200, description="Max results"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Search notebook modules.
    Clean endpoint: /v1/search/notebooks
    """
    try:
        request = NotebookSearchRequest(query=query, include_stdlib=include_stdlib, limit=limit)
        return await orchestrator.execute("notebooks", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Notebook search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Notebook search error. Check server logs for details."
        )


class ToolSearchRequest(BaseModel):
    q: str


@router.get(
    "/tools",
    summary="Search Tools",
    description="Discover available tools via toolrunner"
)
async def search_tools_endpoint(
    q: str = Query(..., description="Search query for tool discovery"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Discover tools.
    Clean endpoint: /v1/search/tools
    """
    try:
        request = ToolSearchRequest(q=q)
        return await orchestrator.execute("tools", request, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Tool search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Tool search error. Check server logs for details."
        )


class SingleIndexSearchRequest(BaseModel):
    """Single index search request (supports both JSON body and Query params)."""
    name: Optional[str] = Field(None, description="Index name")
    index_name: Optional[str] = Field(None, description="Alias of name")
    query: Optional[str] = Field(None, description="Search query")
    top_k: Optional[int] = Field(None, ge=1, le=2000, description="Max results")
    min_score: Optional[float] = Field(None, ge=0.0, le=1.0, description="Minimum score")
    mode: Optional[Literal["semantic", "bm25", "hybrid"]] = Field("bm25", description="Search mode")


@router.get(
    "/index",
    summary="Search Index - GET",
    description="Search a specific file index by name (Query params)",
    openapi_extra={"is_agent_tool": True})
@router.post(
    "/index",
    summary="Search Index - POST",
    description="Search a specific file index by name (JSON body or Query params)",
    openapi_extra={"is_agent_tool": True})
async def search_index_endpoint(
    body: SingleIndexSearchRequest = None,
    name: Optional[str] = Query(None, description="Index name"),
    index_name: Optional[str] = Query(None, description="Alias of name"),
    query: Optional[str] = Query(None, description="Search query"),
    top_k: Optional[int] = Query(None, ge=1, le=2000),
    min_score: Optional[float] = Query(None, ge=0.0, le=1.0),
    mode: Optional[str] = Query("bm25", description="Search mode: semantic|bm25|hybrid"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Search specific file index.
    """
    try:
        params = merge_body_and_query(
            body,
            name=name,
            index_name=index_name,
            query=query,
            top_k=top_k,
            min_score=min_score,
            mode=mode,
        )
        if not params.get("name") and params.get("index_name"):
            params["name"] = params["index_name"]
            
        command = SingleIndexSearchRequest(**params)
        return await orchestrator.execute("index", command, context)
    except (HTTPException, DomainException):
        raise
    except IndexNotFoundError as e:
        logger.warning("Index not found in search_index_endpoint: %s", e)
        raise ResourceNotFoundError(str(e))
    except IndexingError as e:
        logger.warning("Indexing error in search_index_endpoint: %s", e)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("Index search failed in search_index_endpoint: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Index search error. Check server logs for details."
        )


class MultiIndexSearchRequest(BaseModel):
    """Multi-index search request (supports both JSON body and Query params)."""
    query: Optional[str] = Field(None, min_length=1, max_length=500, description="Search query")
    index_names: Optional[List[str]] = Field(None, description="List of index names to search")
    top_k: Optional[int] = Field(None, ge=1, le=2000, description="Results per index")
    min_score: Optional[float] = Field(None, ge=0.0, le=1.0, description="Minimum relevance score")
    mode: Optional[Literal["semantic", "bm25", "hybrid"]] = Field("bm25", description="Search mode")


@router.post(
    "/indexes",
    summary="Search Multiple Indexes",
    description="Search across multiple file indexes simultaneously",
    openapi_extra={"is_agent_tool": True})
async def search_indexes_endpoint(
    body: MultiIndexSearchRequest = None,
    index_names: Optional[List[str]] = Query(None, description="List of index names to search"),
    query: Optional[str] = Query(None, min_length=1, max_length=500, description="Search query"),
    top_k: Optional[int] = Query(None, ge=1, le=2000, description="Results per index"),
    min_score: Optional[float] = Query(None, ge=0.0, le=1.0, description="Minimum relevance score"),
    mode: Optional[str] = Query("bm25", description="Search mode: semantic|bm25|hybrid"),
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Search across multiple indexes simultaneously.
    """
    try:
        final_query = (body.query if body and body.query else query) if body else query
        final_index_names = (body.index_names if body and body.index_names else index_names) if body else index_names
        final_top_k = (body.top_k if body and body.top_k is not None else top_k) if body else top_k
        final_min_score = (body.min_score if body and body.min_score is not None else min_score) if body else min_score
        final_mode = (body.mode if body and body.mode else mode) if body else mode
        
        command = MultiIndexSearchRequest(
            query=final_query,
            index_names=final_index_names,
            top_k=final_top_k,
            min_score=final_min_score,
            mode=final_mode
        )
        return await orchestrator.execute("indexes", command, context)
    except (HTTPException, DomainException):
        raise
    except IndexNotFoundError as e:
        logger.warning("Index not found in search_indexes_endpoint: %s", e)
        raise ResourceNotFoundError(str(e))
    except IndexingError as e:
        logger.warning("Indexing error in search_indexes_endpoint: %s", e)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("Multi-index search failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Multi-index search error. Check server logs for details."
        )


@router.post(
    "/research",
    summary="Unified Research",
    description="Multi-source research with AI or fast mode",
    openapi_extra={"is_agent_tool": True})
async def search_research_endpoint(
    payload: ResearchRequest,
    request: Request,
    orchestrator: SearchOrchestrator = Depends(get_search_orchestrator),
    context: SearchContext = Depends(build_search_context)
):
    """
    Unified research combining web, academic, and local searches.
    Clean endpoint: /v1/search/research
    
    Accepts POST body with ResearchRequest model (not Query params).
    """
    try:
        return await orchestrator.execute("research", payload, context)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Research failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Research error. Check server logs for details."
        )


# ============================================================================
# Status & Health
# ============================================================================

@router.get(
    "/status",
    summary="Search Service Status",
    description="Check Perplexica search service status"
)
async def search_status(
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ISearchGateway = Depends(get_search_gateway)
):
    """Check search service status and configuration."""
    try:
        model_info = show_current_model()
        
        return {
            "enabled": settings.integrations.perplexica_enabled,
            "url": settings.integrations.perplexica_url,
            "searxng_enabled": settings.integrations.searxng_enabled,
            "searxng_url": settings.integrations.searxng_url,
            "model_info": model_info,
            "available_endpoints": [
                "/v1/search",
                "/v1/search/web",
                "/v1/search/unified",
                "/v1/search/files",
                "/v1/search/memories",
                "/v1/search/agents",
                "/v1/search/chats",
                "/v1/search/notebooks",
                "/v1/search/tools",
                "/v1/search/index",
                "/v1/search/indexes",
                "/v1/search/research",
                "/v1/search/academic",
                "/v1/search/reddit",
                "/v1/search/wolfram",
                "/v1/search/writing"
            ]
        }
    except Exception as e:
        logger.error("Failed to get search status: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get status. Check server logs for details."
        )
