"""
Research Orchestration API

Unified research endpoint combining Perplexica (AI mode), Searxng (fast mode), and AetherRag (local).

@.architecture
Incoming: Frontend HTTP requests --- {POST /v1/research with query and options}
Processing: Route to appropriate backends based on ai_mode and sources --- {3 jobs: JOB_ROUTE, JOB_PARALLEL_SEARCH, JOB_COMBINE}
Outgoing: Combined research results --- {Dict with results from each source}
"""

from data.network.search_gateway import get_search_gateway
from core.domain.gateway_interfaces import ISearchGateway
from core.exceptions import DomainException, UpstreamServiceError
import asyncio
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from datetime import datetime, timezone

from api.dependencies import get_settings, setup_request_context, get_database, get_index_service, get_research_service
from config.settings import Settings
from core.integrations.providers.perplexica.search import perplexica_search
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/research", tags=["research"])



class ResearchResponse(BaseModel):
    """Research response with results from all sources."""
    query: str
    sources_used: List[str]
    ai_mode: bool
    results: Dict[str, Any]
    model_used: Optional[str] = None
    time_ms: int
    timestamp: str
    output_id: Optional[str] = None  # ID of persisted output in agent_outputs
    entity_id: Optional[str] = None  # Entity this output is associated with
    job_id: Optional[str] = None    # ID of the tracking job (if any)


async def _search_local_indexes(
    query: str,
    max_results: int,
    index_service
) -> Dict[str, Any]:
    """
    Search local AetherRag indexes for relevant content.
    
    Args:
        query: Search query
        max_results: Maximum results to return
        index_service: IndexService instance
        
    Returns:
        Dict with search results from local indexes
    """
    try:
        # Get all indexes
        indexes_response = await index_service.list_all_indexes()
        
        if not indexes_response.get("indexes"):
            return {"results": [], "total": 0, "indexes_searched": []}
        
        # Search all indexes in parallel
        index_names = [idx["index_name"] for idx in indexes_response["indexes"]]
        
        search_response = await index_service.search_multiple_indexes(
            index_names=index_names,
            query=query,
            top_k=max_results,
            min_score=0.3
        )
        
        return {
            "results": search_response.get("results", []),
            "total": search_response.get("total_found", 0),
            "indexes_searched": search_response.get("indexes_searched", [])
        }
            
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Local search error: %s", e, exc_info=True)
        return {"results": [], "total": 0, "error": "Search failed. Check server logs."}


async def _search_web_fast(
    query: str,
    max_results: int,
    settings: Settings,
    gateway: Optional[ISearchGateway] = None
) -> Dict[str, Any]:
    """
    Fast web search using Searxng with 3-engine policy (non-AI mode).
    
    Args:
        query: Search query
        max_results: Maximum results
        settings: Application settings
        
    Returns:
        Dict with Searxng results
    """
    if gateway is None:
        gateway = get_search_gateway()
    if not settings.integrations.searxng_enabled:
        return {"results": [], "total": 0, "error": "Searxng not enabled"}
    
    try:
        # 3-Engine Policy: Use defaults for redundancy
        DEFAULT_ENGINES = ["google", "duckduckgo", "brave"]
        engines_str = ",".join(DEFAULT_ENGINES)
        
        # Increased timeout for Searxng results (3-engine policy redundancy)
        timeout = getattr(settings.http_client, "default_timeout", 30.0)
        data = await gateway.search_searxng(
            url=settings.integrations.searxng_url,
            params={
                "q": query,
                "format": "json",
                "engines": engines_str,
            },
            headers={"X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1"},
            timeout=timeout
        )
        
        results = data.get("results", [])[:max_results]
        unresponsive = data.get("unresponsive_engines") or []
        
        # Log unresponsive engines but continue with available results
        unresponsive_names = []
        for row in unresponsive:
            try:
                # Need to handle case where row might be a tuple or custom list that raises on index access
                if hasattr(row, '__iter__') and not isinstance(row, (str, bytes)):
                    # try to get the first element safely
                    try:
                        iterator = iter(row)
                        first_element = next(iterator)
                        if isinstance(first_element, str):
                            unresponsive_names.append(first_element)
                    except Exception as e:
                        logger.warning("Failed to extract engine name from unresponsive row iteration: %s", e)
            except Exception as e:
                logger.warning("Malformed unresponsive engine payload row: %s", e)
        
        if unresponsive_names:
            logger.warning("Unresponsive engines for query '%s': %s", query, unresponsive_names)
        
        working_engines = [e for e in DEFAULT_ENGINES if e not in unresponsive_names]
        
        return {
            "results": results,
            "total": len(results),
            "suggestions": data.get("suggestions", []),
            "engines_used": DEFAULT_ENGINES,
            "engines_working": working_engines,
            "unresponsive_engines": unresponsive,
            "source": "searxng"
        }
            
    except UpstreamServiceError as e:
        logger.error("Searxng search failed: %s", e, exc_info=True)
        return {"results": [], "total": 0, "error": "Search failed. Check server logs."}
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Fast web search error: %s", e, exc_info=True)
        return {"results": [], "total": 0, "error": "Search failed. Check server logs."}


async def _get_research_agent_config(db) -> Optional[Dict[str, Any]]:
    """Get research agent configuration from database."""
    try:
        configs = await db.select(
            "agent_configs",
            filters={"agent_name": "research"},
            limit=1
        )
        return configs[0] if configs else None
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get research agent config: %s", e)
        return None


async def _search_web_fast_multi(
    queries: List[str],
    max_results: int,
    settings: Settings,
    gateway: ISearchGateway
) -> Dict[str, Any]:
    """
    Run multiple Searxng searches and combine results.
    """
    tasks = [
        _search_web_fast(query, max_results, settings, gateway)
        for query in queries
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    combined_results = []
    seen = set()
    errors = []
    
    for result in results:
        if isinstance(result, Exception):
            errors.append(str(result))
            continue
        for item in result.get("results", []):
            url = item.get("url") or item.get("link") or item.get("href") or ""
            key = url or item.get("title") or str(item)
            if key in seen:
                continue
            seen.add(key)
            combined_results.append(item)
    
    return {
        "results": combined_results[:max_results],
        "total": len(combined_results),
        "queries": queries,
        "errors": errors,
        "source": "searxng"
    }


async def research(
    query: str,
    sources: List[str] = None,
    ai_mode: bool = True,
    optimization_mode: str = "balanced",
    max_results: int = 8,
    model: Optional[str] = None,
    mode: Optional[str] = None,
    settings: Settings = Depends(get_settings),
    gateway: ISearchGateway = Depends(get_search_gateway),
    db = Depends(get_database),
    index_service = Depends(get_index_service),
    _context: dict = Depends(setup_request_context)
):
    """
    Helper function: Unified research endpoint combining multiple sources.
    
    **AI Mode (Perplexica):**
    - web: General web search with AI synthesis
    - academic: Academic papers (arXiv, PubMed, Google Scholar)
    - reddit: Reddit discussions
    - wolfram: Wolfram Alpha computational knowledge
    - youtube: YouTube videos
    - news: News articles (via Perplexica discover API)
    
    **Fast Mode (Searxng):**
    - web: Fast raw web search (< 2 seconds)
    
    **Local:**
    - Searches all AetherRag indexes (agent outputs + user files)
    
    **Model Selection:**
    1. request.model (if provided)
    2. agent_configs.configuration.model (from database)
    3. settings.llm.model (central config)
    
    **Zero hardcoded models** - always user-configurable.
    """
    start_time = datetime.now(timezone.utc)
    
    # Set defaults
    if sources is None:
        sources = ["web"]

    # Apply explicit mode alias if provided.
    if mode:
        if mode == "fast":
            ai_mode = False
        elif mode == "ai":
            ai_mode = True
        else:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid mode: {mode}")
    
    # Get research agent config
    agent_config = await _get_research_agent_config(db)
    # Determine model to use (priority: request > agent config > settings)
    model_to_use = None
    if model:
        model_to_use = model
    elif agent_config and agent_config.get("configuration", {}).get("model"):
        model_to_use = agent_config["configuration"]["model"]
    else:
        model_to_use = settings.llm.model
    
    logger.info(
        f"Research request: query='{query}', sources={sources}, "
        f"ai_mode={ai_mode}, model={model_to_use}"
    )
    
    # Build tasks for parallel execution
    tasks = {}
    backend_url = settings.base_url
    
    # Map sources to Perplexica focus modes
    focus_mode_map = {
        "web": "webSearch",
        "academic": "academicSearch",
        "reddit": "redditSearch",
        "wolfram": "wolframAlphaSearch",
        "youtube": "youtubeSearch",
        "news": "newsSearch"  # News uses newsSearch with news engines
    }
    
    if ai_mode:
        # AI mode: Use Perplexica for non-local sources
        if not settings.integrations.perplexica_enabled:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Perplexica (AI mode) not enabled"
            )
        
        for source in sources:
            if source == "local":
                continue
            
            focus_mode = focus_mode_map.get(source, "webSearch")
            
            # News search uses specific engines
            if source == "news":
                tasks[source] = perplexica_search(
                    query=query,
                    focus=focus_mode,
                    mode=optimization_mode,
                    model_name=model_to_use
                )
            else:
                tasks[source] = perplexica_search(
                    query=query,
                    focus=focus_mode,
                    mode=optimization_mode,
                    model_name=model_to_use
                )
    else:
        # Fast mode: Use Searxng for web
        if "web" in sources or "news" in sources:
            tasks["web"] = _search_web_fast_multi(
                [query],
                max_results,
                settings,
                gateway
            )
    
    # Add local search if requested
    if "local" in sources:
        tasks["local"] = _search_local_indexes(
            query,
            max_results,
            index_service
        )
    
    # Execute all searches in parallel
    try:
        results_dict = await asyncio.gather(
            *[task for task in tasks.values()],
            return_exceptions=True
        )
        
        # Map results back to source names
        combined_results = {}
        for i, source_name in enumerate(tasks.keys()):
            result = results_dict[i]
            if isinstance(result, Exception):
                logger.error("Search failed for %s: %s", source_name, result)
                combined_results[source_name] = {
                    "error": str(result),
                    "success": False
                }
            else:
                combined_results[source_name] = result
        
        # Calculate elapsed time
        elapsed_ms = int((datetime.now(timezone.utc) - start_time).total_seconds() * 1000)
        
        return ResearchResponse(
            query=query,
            sources_used=list(sources),
            ai_mode=ai_mode,
            results=combined_results,
            model_used=model_to_use if ai_mode else None,
            time_ms=elapsed_ms,
            timestamp=datetime.now(timezone.utc).isoformat()
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Research failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Research error. Check server logs for details."
        )


async def research_status(
    research_service = Depends(get_research_service),
    _context: dict = Depends(setup_request_context)
):
    """
    Helper function: Check research service status and configuration.
    
    Called by /v1/status/research endpoint in search.py (clean action_source pattern).
    """
    try:
        from application.research.research_service import ResearchError
        return await research_service.get_research_status()
    except ResearchError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get research status: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get status. Check server logs for details."
        )
