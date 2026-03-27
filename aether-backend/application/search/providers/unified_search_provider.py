import logging
import asyncio
from typing import Any, Dict, Union
from datetime import datetime, timezone
from core.exceptions import UpstreamServiceError
from pydantic import BaseModel

from application.search.interfaces import SearchProvider, SearchContext
from application.search.providers.web_search_provider import search_web_fast_impl
from core.integrations.providers.perplexica.search import web_search

logger = logging.getLogger(__name__)

async def search_local_indexes(
    query: str,
    top_k: int,
    min_score: float,
    context: SearchContext
) -> Dict[str, Any]:
    """Search all local AetherRag indexes using the unified index API."""
    try:
        from application.indexing.index_service import IndexService
        from data.database.repositories.files import FileIndexingRepository
        
        repository = FileIndexingRepository(context.uow.gateway)
        index_service = IndexService(context.settings, repository)
        
        # Get all indexes
        indexes_response = await index_service.list_all_indexes()
        
        index_names = [idx["index_name"] for idx in indexes_response["indexes"]]
        if not index_names:
            return {"results": [], "total_results": 0, "indexes_searched": []}
        
        # Search all indexes
        search_response = await index_service.search_multiple_indexes(
            index_names=index_names,
            query=query,
            top_k=top_k,
            min_score=min_score
        )
        
        return {
            "results": search_response["results"],
            "total_results": search_response["total_found"],
            "indexes_searched": search_response["indexes_searched"]
        }
    except Exception as e:
        logger.error("Local unified search failed: %s", e, exc_info=True)
        return {"results": [], "total_results": 0, "error": "Search failed. Check server logs."}


class UnifiedSearchProvider(SearchProvider):
    """Provider strategy for unified searches combining Web and Local domains."""
    
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        settings = context.settings
        
        query = getattr(payload, "query", "")
        ai_mode = getattr(payload, "ai_mode", True)
        include_local = getattr(payload, "include_local", True)
        mode = getattr(payload, "mode", "speed")
        max_results = getattr(payload, "max_results", 8)
        local_top_k = getattr(payload, "local_top_k", None)
        local_min_score = getattr(payload, "local_min_score", None)
        
        web_task = None
        local_task = None
        
        # 1. Setup Web Search Task
        if ai_mode:
            if not settings.integrations.perplexica_enabled:
                raise UpstreamServiceError(
                    "Perplexica search is not enabled. Check settings.",
                    status_code=503
                )
            web_task = web_search(
                query=query,
                mode=mode,
                max_results=max_results
            )
        else:
            web_task = search_web_fast_impl(
                query=query,
                engines=None,
                category=None,
                time_range=None,
                max_results=max_results,
                context=context
            )
            
        # 2. Setup Local Search Task
        if include_local:
            top_k = local_top_k or settings.interpreter.context_retrieval.default_top_k
            min_score = local_min_score if local_min_score is not None else settings.interpreter.context_retrieval.min_score
            local_task = search_local_indexes(query, top_k, min_score, context)
            
        # 3. Execute Concurrently
        tasks = []
        if web_task: tasks.append(web_task)
        if local_task: tasks.append(local_task)
        
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        web_results = None
        local_results = None
        
        # 4. Map Results
        result_idx = 0
        if web_task:
            res = results[result_idx]
            if isinstance(res, Exception):
                logger.error("Web search failed in unified search: %s", res, exc_info=True)
                if isinstance(res, UpstreamServiceError):
                    raise res
            else:
                web_results = res
            result_idx += 1
            
        if local_task:
            res = results[result_idx]
            if isinstance(res, Exception):
                logger.error("Local search failed in unified search: %s", res, exc_info=True)
            else:
                local_results = res
                
        # 5. Return Unified Response
        return {
            "query": query,
            "ai_mode": ai_mode,
            "web": web_results,
            "local": local_results,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
