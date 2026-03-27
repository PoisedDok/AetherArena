import random
import logging
from typing import Any, Dict, Union
from datetime import datetime, timezone
from pydantic import BaseModel

from application.search.interfaces import SearchProvider, SearchContext
from core.exceptions import NetworkTimeoutError, UpstreamServiceError, NetworkConnectionError
from core.integrations.providers.perplexica.search import web_search

logger = logging.getLogger(__name__)

async def search_web_fast_impl(
    query: str,
    engines: str | None,
    category: str | None,
    time_range: str | None,
    max_results: int,
    context: SearchContext
) -> Dict[str, Any]:
    """Internal implementation for SearXNG fast search with 3-engine policy."""
    settings = context.settings
    gateway = context.gateway
    
    if not settings.integrations.searxng_enabled:
        raise UpstreamServiceError(
            "SearXNG search is not enabled",
            status_code=503
        )

    DEFAULT_ENGINES = ["google", "duckduckgo", "brave"]
    
    if engines:
        requested_engines = [e.strip() for e in engines.split(",") if e.strip()]
    else:
        requested_engines = []
    
    if len(requested_engines) == 0:
        final_engines = DEFAULT_ENGINES.copy()
    elif len(requested_engines) == 1:
        remaining = [e for e in DEFAULT_ENGINES if e not in requested_engines]
        random.shuffle(remaining)
        final_engines = requested_engines + remaining[:2]
    elif len(requested_engines) == 2:
        remaining = [e for e in DEFAULT_ENGINES if e not in requested_engines]
        random.shuffle(remaining)
        final_engines = requested_engines + remaining[:1]
    else:
        final_engines = requested_engines
    
    engines_str = ",".join(final_engines)
    logger.info("Search query: '%s' using engines: %s", query, engines_str)

    params: Dict[str, Any] = {"q": query, "format": "json", "engines": engines_str}
    if category:
        params["category"] = category
    if time_range:
        params["time_range"] = time_range

    timeout = getattr(settings.http_client, "default_timeout", 30.0)
    headers = {
        "X-Forwarded-For": "127.0.0.1",
        "X-Real-IP": "127.0.0.1"
    }
    
    try:
        data = await gateway.search_searxng(
            url=settings.integrations.searxng_url,
            params=params,
            headers=headers,
            timeout=timeout
        )
    except UpstreamServiceError as e:
        raise UpstreamServiceError(f"SearXNG search error: {e.message}", status_code=e.status_code)
    except NetworkTimeoutError as e:
        raise UpstreamServiceError(f"SearXNG search timeout: {e.message}", status_code=504)
    except NetworkConnectionError as e:
        raise UpstreamServiceError(f"SearXNG network error: {e.message}", status_code=503)

    unresponsive = data.get("unresponsive_engines") or []
    unresponsive_names = []
    for row in unresponsive:
        if isinstance(row, list) and len(row) >= 2:
            unresponsive_names.append(row[0])
    
    if unresponsive_names:
        logger.warning("Unresponsive engines for query '%s': %s", query, unresponsive_names)
    
    working_engines = [e for e in final_engines if e not in unresponsive_names]
    
    # Fallback if our specific engines failed but user didn't explicitly request them
    if not working_engines and len(requested_engines) == 0:
        logger.warning("Default fast engines %s all unresponsive. Retrying with all available engines.", final_engines)
        params.pop("engines", None)
        try:
            data = await gateway.search_searxng(
                url=settings.integrations.searxng_url,
                params=params,
                headers=headers,
                timeout=timeout
            )
            unresponsive = data.get("unresponsive_engines") or []
            unresponsive_names = [row[0] for row in unresponsive if isinstance(row, list) and len(row) >= 2]
            working_engines = ["fallback_all"]
            final_engines = ["fallback_all"]
        except Exception as e:
            logger.warning("Fallback search also failed: %s", e)

    if not working_engines:
        raise UpstreamServiceError(
            f"All requested search engines are unavailable: {final_engines}. "
            f"Unresponsive: {unresponsive}. "
            "This typically indicates network issues or widespread rate-limiting.",
            status_code=503
        )

    results = data.get("results", [])[:max_results]
    if not results:
        logger.warning("Search returned 0 results for query '%s' (engines: %s, unresponsive: %s)", query, engines_str, unresponsive_names)

    formatted_results = []
    for result in results:
        formatted_results.append({
            "title": result.get("title", ""),
            "url": result.get("url", ""),
            "content": result.get("content", ""),
            "engine": result.get("engine", ""),
            "score": result.get("score", 0),
            "category": result.get("category", "general"),
        })

    return {
        "query": query,
        "results": formatted_results,
        "total_found": len(formatted_results),
        "suggestions": data.get("suggestions", []),
        "infoboxes": data.get("infoboxes", []),
        "unresponsive_engines": unresponsive,
        "engines_used": final_engines,
        "engines_working": working_engines,
        "source": "searxng",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


class WebSearchProvider(SearchProvider):
    """Provider strategy for handling web searches via SearXNG or Perplexica."""
    
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        settings = context.settings
        
        # Fast mode: Use SearXNG
        if getattr(payload, "mode", None) == "fast":
            return await search_web_fast_impl(
                query=getattr(payload, "query", ""),
                engines=getattr(payload, "engines", None),
                category=getattr(payload, "category", None),
                time_range=getattr(payload, "time_range", None),
                max_results=getattr(payload, "max_results", 8),
                context=context
            )
        
        # AI modes: Use Perplexica
        if not settings.integrations.perplexica_enabled:
            raise UpstreamServiceError(
                "Perplexica search is not enabled. Check settings.",
                status_code=503
            )
        
        raw_sources = getattr(payload, "sources", None)
        sources_list = None
        if raw_sources and isinstance(raw_sources, str):
            sources_list = [s.strip() for s in raw_sources.split(",") if s.strip()]
        
        result = await web_search(
            query=getattr(payload, "query", ""),
            mode=getattr(payload, "mode", "balanced"),
            max_results=getattr(payload, "max_results", 8),
            chat_model_override=getattr(payload, "chat_model", None),
            sources_override=sources_list,
        )
        
        if "error" in result:
            raise UpstreamServiceError(
                f"Search failed: {result['error']}",
                status_code=502
            )
        
        return result
