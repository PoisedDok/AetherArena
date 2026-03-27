import time
import logging
from typing import Union
from core.exceptions import InvalidRequestError, UpstreamServiceError
from pydantic import BaseModel

from application.search.interfaces import SearchProvider, SearchContext

logger = logging.getLogger(__name__)

class FileSearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        settings = context.settings
        
        search_mode = getattr(payload, "mode", None)
        if not search_mode:
            search_mode = getattr(settings.integrations.aether_rag_sources.search, "mode", "bm25")
            
        search_kwargs = {}
        if search_mode == "hybrid":
            search_kwargs["semantic_weight"] = getattr(settings.integrations.aether_rag_sources.search, "hybrid_semantic_weight", 1.0)
            search_kwargs["bm25_weight"] = getattr(settings.integrations.aether_rag_sources.search, "hybrid_sparse_weight", 0.5)
            search_kwargs["rrf_k"] = getattr(settings.integrations.aether_rag_sources.search, "rrf_k", 60)

        query = getattr(payload, "query", None)
        top_k = getattr(payload, "top_k", getattr(payload, "limit", 10)) or 10
        min_score = getattr(payload, "min_score", None)
        
        from api.dependencies import require_file_indexing_repository
        from application.indexing.aether_rag_service import AetherRagService
        from pathlib import Path as PathLib
        
        start_time = time.time()
        repository = require_file_indexing_repository()
        locations = await repository.get_all_locations(enabled_only=True)
        
        if not locations:
            return {
                "results": [],
                "total_found": 0,
                "search_duration_ms": int((time.time() - start_time) * 1000),
                "locations_searched": [],
                "mode": search_mode
            }
        
        aether_rag_manager = AetherRagService(
            embedding_model=settings.embedding_service.model,
            api_base=settings.embedding_service.openai_base_url,
            api_key="not-needed",
        )
        
        all_results = []
        locations_searched = []
        for location in locations:
            idx_dir_raw = location.get('index_directory')
            idx_name = location.get('index_name')
            if not idx_dir_raw or not idx_name:
                continue

            index_dir = PathLib(idx_dir_raw)
            if not aether_rag_manager.index_exists(index_dir, idx_name):
                continue
            
            search_results = await aether_rag_manager.search(
                index_directory=index_dir,
                index_name=idx_name,
                query=query,
                top_k=top_k,
                mode=search_mode,
                **search_kwargs
            )
            
            locations_searched.append(location.get('location_name', idx_name))
            
            # Avoid filtering hybrid results with semantic min_score thresholds
            effective_min = 0.0 if search_mode == "hybrid" else min_score

            for result in search_results:
                if effective_min is not None and float(result.get('score', 0)) < effective_min:
                    continue
                metadata = result.get('metadata', {})
                all_results.append({
                    "file_path": metadata.get('file_path', 'unknown'),
                    "file_name": metadata.get('file_name', 'unknown'),
                    "chunk_text": result['text'],
                    "score": float(result['score']),
                    "file_extension": metadata.get('file_extension', 'unknown'),
                    "location_name": location.get('location_name', idx_name),
                    "metadata": metadata
                })
        
        all_results.sort(key=lambda x: x['score'], reverse=True)
        all_results = all_results[:top_k]
        
        return {
            "results": all_results,
            "total_found": len(all_results),
            "search_duration_ms": int((time.time() - start_time) * 1000),
            "locations_searched": locations_searched,
            "mode": search_mode
        }


class MemorySearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        query = getattr(payload, "query", None)
        search_type = getattr(payload, "search_type", "vector") or "vector"
        limit = getattr(payload, "limit", 20) or 20
        threshold = getattr(payload, "threshold", 0.5) or 0.5
        
        if not context.uow:
            raise ValueError("UOW is required in SearchContext for MemorySearchProvider")
            
        from application.chat.memory_service import MemoryService
        
        uow = context.uow
        memory_service = MemoryService(uow, context.settings)
        
        if search_type == "hybrid":
            results = await memory_service.search_memories_hybrid(
                query_text=query,
                semantic_weight=0.7,
                keyword_weight=0.3,
                match_threshold=threshold,
                match_count=limit,
                memory_type=None
            )
        else:  # vector
            results = await memory_service.search_memories(
                query=query,
                match_threshold=threshold,
                match_count=limit,
                memory_types=None
            )
            
        return {"results": results, "total": len(results)}


class ChatSearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        query = getattr(payload, "query", None)
        limit = getattr(payload, "limit", 20) or 20
        
        if not context.uow:
            raise ValueError("UOW is required in SearchContext for ChatSearchProvider")
            
        from application.chat.service import ChatService
        
        uow = context.uow
        chat_service = ChatService(uow)
        results = await chat_service.search_chats(
            query=query,
            limit=limit,
            filters=None
        )
        return {
            "query": query,
            "results": results,
            "total_count": len(results)
        }


class ResearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        if not context.uow:
            raise ValueError("UOW is required in SearchContext for ResearchProvider")
            
        from application.agents.agent_service import AgentService
        from uuid import uuid4
        
        uow = context.uow
        
        # Re-fetch dependencies needed for ResearchService (IndexService and its repo)
        from api.dependencies import get_index_service, require_file_indexing_repository
        idx_repo = require_file_indexing_repository()
        idx_service = await get_index_service(context.settings, idx_repo)
        
        from application.research.research_service import ResearchService
        research_service = ResearchService(
            settings=context.settings,
            gateway=context.gateway,
            index_service=idx_service,
            db=uow.gateway
        )
        
        agent_service = AgentService(uow)
        entity_id = uuid4()
        
        job_id = None
        persist_history = getattr(payload, "persist_history", False)
        if persist_history:
            try:
                job_id = await agent_service.queue_agent_job(
                    agent_name="research",
                    entity_id=entity_id,
                    entity_type="research_query",
                    priority=5,
                    metadata={"query": getattr(payload, "query", "")},
                    status="processing"
                )
            except Exception as e:
                logger.warning("Failed to create research tracking job: %s", e)
        
        try:
            result_dict = await research_service.execute_research(
                query=getattr(payload, "query", ""),
                sources=getattr(payload, "sources", None),
                ai_mode=getattr(payload, "ai_mode", True),
                optimization_mode=getattr(payload, "optimization_mode", "balanced"),
                max_results=getattr(payload, "max_results", 8),
                model=getattr(payload, "model", None),
                mode=getattr(payload, "mode", "balanced")
            )
            
            output_id = None
            if persist_history:
                try:
                    output_id = await agent_service.store_agent_output(
                        agent_name="research",
                        output_type="research",
                        content={
                            "query": getattr(payload, "query", ""),
                            "sources": getattr(payload, "sources", None) or ["web"],
                            "ai_mode": getattr(payload, "ai_mode", True),
                            "results": result_dict,
                            "model_used": result_dict.get("model_used"),
                            "time_ms": result_dict.get("time_ms")
                        },
                        job_id=job_id,
                        entity_id=entity_id,
                        aether_rag_index_name=None
                    )
                    if job_id:
                        await uow.gateway.delete("pending_jobs", record_id=str(job_id))
                except Exception as persist_error:
                    logger.error("Failed to persist research output: %s", persist_error, exc_info=True)
            
            if output_id:
                result_dict["output_id"] = str(output_id)
                result_dict["entity_id"] = str(entity_id)
            if job_id:
                result_dict["job_id"] = str(job_id)
            
            from api.v1.endpoints.research import ResearchResponse
            return ResearchResponse(**result_dict)
        except Exception as research_error:
            if job_id:
                try:
                    await uow.gateway.update("pending_jobs", record_id=str(job_id), data={"status": "failed", "error_message": str(research_error)})
                except Exception as update_error:
                    logger.error("Critical: Failed to update job status to failed: %s", update_error, exc_info=True)
            raise research_error

class IndexSearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        params = payload.dict() if hasattr(payload, 'dict') else payload.model_dump()
        name = params.get("name") or params.get("index_name")
        query = params.get("query")
        top_k = params.get("top_k")
        if top_k is None:
            top_k = 10
        min_score = params.get("min_score")
        if min_score is None:
            min_score = 0.0
        mode = params.get("mode") or "bm25"
        
        if not name or not query:
            raise InvalidRequestError("name and query are required")
            
        from api.dependencies import require_file_indexing_repository, get_index_service
        
        repository = require_file_indexing_repository()
        index_service = await get_index_service(context.settings, repository)
        
        return await index_service.search_index(
            index_name=name,
            query=query,
            top_k=top_k,
            min_score=min_score,
            mode=mode
        )

class MultiIndexSearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        params = payload.dict() if hasattr(payload, 'dict') else payload.model_dump()
        query = params.get("query")
        index_names = params.get("index_names")
        top_k = params.get("top_k")
        if top_k is None:
            top_k = 10
        min_score = params.get("min_score")
        if min_score is None:
            min_score = 0.0
        mode = params.get("mode") or "bm25"
        
        if not query or not index_names:
            raise InvalidRequestError("query and index_names are required")
            
        from api.dependencies import require_file_indexing_repository, get_index_service
        
        repository = require_file_indexing_repository()
        index_service = await get_index_service(context.settings, repository)
        
        return await index_service.search_multiple_indexes(
            index_names=index_names,
            query=query,
            top_k=top_k,
            min_score=min_score,
            mode=mode
        )

class AgentSearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        agent_name = getattr(payload, "agent_name", None)
        query = getattr(payload, "query", None)
        top_k = getattr(payload, "top_k", 10)
        
        from application.indexing.aether_rag_service import AetherRagService
        settings = context.settings
        indexes_dir = settings.config_dir.parent / "data" / "aether_rag_indexes"
        
        aether_rag_manager = AetherRagService(
            embedding_model=settings.embedding_service.model,
            api_base=settings.embedding_service.openai_base_url,
            api_key="not-needed"
        )
        
        index_name = AetherRagService.index_name_for_agent(agent_name)
        if index_name:
            results = await aether_rag_manager.search(
                index_directory=indexes_dir,
                index_name=index_name,
                query=query,
                top_k=top_k
            )
        else:
            results = []
        
        serializable_results = []
        for result in results:
            # Handle both object and dict formats just in case
            if isinstance(result, dict):
                serializable_results.append({
                    "id": result.get("metadata", {}).get("id", ""),
                    "score": float(result.get("score", 0.0)),
                    "text": result.get("text", ""),
                    "metadata": result.get("metadata", {})
                })
            else:
                serializable_results.append({
                    "id": getattr(result, "id", ""),
                    "score": float(getattr(result, "score", 0.0)),
                    "text": getattr(result, "text", ""),
                    "metadata": getattr(result, "metadata", {})
                })
        
        return {
            "agent": agent_name,
            "query": query,
            "results": serializable_results,
            "total": len(serializable_results)
        }

class NotebookSearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        from api.dependencies import get_notebook_service
        from application.notebook.notebook_service import ModuleSearchError
        
        notebook_service = await get_notebook_service()
        try:
            return await notebook_service.search_modules(
                query=getattr(payload, "query", ""),
                include_stdlib=getattr(payload, "include_stdlib", True),
                limit=getattr(payload, "limit", 50)
            )
        except ModuleSearchError as e:
            raise UpstreamServiceError(str(e), status_code=500)

class ToolSearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        from api.dependencies import get_tool_service
        
        tool_service = await get_tool_service(context.request, context.settings)
        try:
            return await tool_service.search_tools(q=getattr(payload, "q", ""))
        except ValueError as e:
            raise InvalidRequestError(str(e))
