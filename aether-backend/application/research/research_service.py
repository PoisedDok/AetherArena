"""
Research Application Service

Orchestrates multi-source research tasks, combining AI and local search.
"""

import asyncio
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone

from config.settings import Settings
from core.integrations.providers.perplexica.search import perplexica_search
from monitoring import get_logger
from application.indexing.index_service import IndexService
from core.domain.gateway_interfaces import ISearchGateway

logger = get_logger(__name__)

class ResearchError(Exception):
    pass

class ResearchService:
    def __init__(self, settings: Settings, gateway: ISearchGateway, index_service: IndexService, db):
        self.settings = settings
        self.gateway = gateway
        self.index_service = index_service
        self.db = db

    async def _get_research_agent_config(self) -> Optional[Dict[str, Any]]:
        try:
            configs = await self.db.select(
                "agent_configs",
                filters={"agent_name": "research"},
                limit=1
            )
            return configs[0] if configs else None
        except Exception as e:
            logger.error("Failed to get research agent config: %s", e)
            return None

    async def _search_local_indexes(self, query: str, max_results: int) -> Dict[str, Any]:
        try:
            indexes_response = await self.index_service.list_all_indexes()
            
            if not indexes_response.get("indexes"):
                return {"results": [], "total": 0, "indexes_searched": []}
            
            index_names = [idx["index_name"] for idx in indexes_response["indexes"]]
            
            search_response = await self.index_service.search_multiple_indexes(
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
                
        except Exception as e:
            logger.error("Local search error: %s", e, exc_info=True)
            return {"results": [], "total": 0, "error": "Search failed. Check server logs."}

    async def _search_web_fast(self, query: str, max_results: int) -> Dict[str, Any]:
        if not self.settings.integrations.searxng_enabled:
            return {"results": [], "total": 0, "error": "Searxng not enabled"}
        
        try:
            DEFAULT_ENGINES = ["google", "duckduckgo", "brave"]
            engines_str = ",".join(DEFAULT_ENGINES)
            
            timeout = getattr(self.settings.http_client, "default_timeout", 30.0)
            data = await self.gateway.search_searxng(
                url=self.settings.integrations.searxng_url,
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
            
            unresponsive_names = []
            for row in unresponsive:
                try:
                    if isinstance(row, list) and len(row) >= 2:
                        unresponsive_names.append(row[0])
                except Exception:
                    pass
            
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
                
        except Exception as e:
            logger.error("Fast web search error: %s", e, exc_info=True)
            return {"results": [], "total": 0, "error": "Search failed. Check server logs."}

    async def _search_web_fast_multi(self, queries: List[str], max_results: int) -> Dict[str, Any]:
        tasks = [
            self._search_web_fast(query, max_results)
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

    async def execute_research(
        self,
        query: str,
        sources: List[str] = None,
        ai_mode: bool = True,
        optimization_mode: str = "balanced",
        max_results: int = 8,
        model: Optional[str] = None,
        mode: Optional[str] = None
    ) -> Dict[str, Any]:
        start_time = datetime.now(timezone.utc)
        
        if sources is None:
            sources = ["web"]

        if mode:
            if mode == "fast":
                ai_mode = False
            elif mode == "ai":
                ai_mode = True
            else:
                raise ValueError(f"Invalid mode: {mode}")
        
        agent_config = await self._get_research_agent_config()
        model_to_use = None
        if model:
            model_to_use = model
        elif agent_config and agent_config.get("configuration", {}).get("model"):
            model_to_use = agent_config["configuration"]["model"]
        else:
            model_to_use = self.settings.llm.model
        
        logger.info(
            f"Research request: query='{query}', sources={sources}, "
            f"ai_mode={ai_mode}, model={model_to_use}"
        )
        
        tasks = {}
        
        focus_mode_map = {
            "web": "webSearch",
            "academic": "academicSearch",
            "reddit": "redditSearch",
            "wolfram": "wolframAlphaSearch",
            "youtube": "youtubeSearch",
            "news": "newsSearch"
        }
        
        if ai_mode:
            if not self.settings.integrations.perplexica_enabled:
                raise ResearchError("Perplexica (AI mode) not enabled")
            
            for source in sources:
                if source == "local":
                    continue
                
                focus_mode = focus_mode_map.get(source, "webSearch")
                tasks[source] = perplexica_search(
                    query=query,
                    focus=focus_mode,
                    mode=optimization_mode,
                    model_name=model_to_use
                )
        else:
            if "web" in sources or "news" in sources:
                tasks["web"] = self._search_web_fast_multi(
                    [query],
                    max_results
                )
        
        if "local" in sources:
            tasks["local"] = self._search_local_indexes(
                query,
                max_results
            )
        
        try:
            results_dict = await asyncio.gather(
                *[task for task in tasks.values()],
                return_exceptions=True
            )
            
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
            
            elapsed_ms = int((datetime.now(timezone.utc) - start_time).total_seconds() * 1000)
            
            return {
                "query": query,
                "sources_used": list(sources),
                "ai_mode": ai_mode,
                "results": combined_results,
                "model_used": model_to_use if ai_mode else None,
                "time_ms": elapsed_ms,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
        except Exception as e:
            logger.error("Research execution failed: %s", e)
            raise ResearchError(f"Research execution failed: {str(e)}") from e
            
    async def get_research_status(self) -> Dict[str, Any]:
        try:
            agent_config = await self._get_research_agent_config()
            
            return {
                "perplexica_enabled": self.settings.integrations.perplexica_enabled,
                "perplexica_url": self.settings.integrations.perplexica_url,
                "searxng_enabled": self.settings.integrations.searxng_enabled,
                "searxng_url": self.settings.integrations.searxng_url,
                "agent_configured": agent_config is not None,
                "agent_enabled": agent_config.get("enabled", False) if agent_config else False,
                "default_model": self.settings.llm.model,
                "available_sources": {
                    "ai_mode": ["web", "academic", "reddit", "wolfram", "youtube", "news", "images", "videos", "discover", "legal"],
                    "fast_mode": ["web"],
                    "local": ["local"]
                }
            }
        except Exception as e:
            logger.error("Failed to get research status: %s", e, exc_info=True)
            raise ResearchError("Failed to get status. Check server logs for details.")


    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
