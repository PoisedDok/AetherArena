"""
Agent Context Injection Service

Auto-injects relevant context from enabled agents into LLM prompts.

@.architecture
Incoming: WebSocket handlers, API endpoints --- {query: str, chat_id: UUID}
Processing: Query enabled agents, search indexes, format context --- {5 jobs: JOB_QUERY_AGENTS, JOB_SEARCH_INDEXES, JOB_MERGE_RESULTS, JOB_FORMAT_SECTIONS, JOB_INJECT}
Outgoing: Formatted context string for LLM system message --- {context_sections: str}
"""

import asyncio
import httpx
from typing import List, Dict, Any, Optional
from uuid import UUID
from datetime import datetime

from config.settings import get_settings
from data.database.uow import SupabaseUnitOfWork
from monitoring import get_logger

logger = get_logger(__name__)


class AgentContextInjector:
    """
    Service for injecting agent context into LLM prompts.
    
    Queries enabled agents with context_injection.enabled=true,
    searches their indexes for relevant context, and formats
    results into sections for LLM injection.
    
    Features:
    - Parallel index searches (respects timeout)
    - Priority-based ordering
    - Configurable result limits per agent
    - Automatic formatting into markdown sections
    
    Design:
    - Uses unified /v1/search/index?name={name} API
    - Respects per-agent configuration (top_k, min_score, priority)
    - Fails gracefully (no context better than broken context)
    """
    
    def __init__(
        self,
        uow: SupabaseUnitOfWork,
        backend_url: Optional[str] = None
    ):
        """
        Initialize context injector.
        
        Args:
            uow: Unit of work for database access
            backend_url: Backend API base URL (defaults to settings)
        """
        self._uow = uow
        self._gateway = uow.gateway
        self._settings = get_settings()
        self._backend_url = backend_url or getattr(
            self._settings,
            'backend_url',
            'http://127.0.0.1:8765'
        )
        
        # Global context retrieval settings
        self._retrieval_config = self._settings.interpreter.context_retrieval
    
    async def get_agent_context(
        self,
        query: str,
        chat_id: Optional[UUID] = None,
        enabled_only: bool = True
    ) -> str:
        """
        Get relevant context from enabled agents.
        
        Queries all enabled agents with context_injection enabled,
        searches their indexes in parallel, and formats results
        into markdown sections for LLM injection.
        
        Args:
            query: User query to find relevant context for
            chat_id: Optional chat ID for filtering
            enabled_only: Only query enabled agents (default True)
            
        Returns:
            Formatted context string (empty if no context found)
            
        Example Output:
            ## 🔍 Agent Context
            
            ### From Research Agent (Score: 0.85)
            [Relevant research results...]
            
            ### From Memory Agent (Score: 0.72)
            [Relevant memories...]
        """
        if not self._retrieval_config.enabled:
            logger.debug("Agent context injection disabled globally")
            return ""
        
        try:
            # Get agents with context injection enabled
            agents = await self._get_enabled_agents(enabled_only=enabled_only)
            
            if not agents:
                logger.debug("No agents with context injection enabled")
                return ""
            
            # Search indexes in parallel (with timeout)
            timeout_seconds = self._retrieval_config.timeout_ms / 1000.0
            
            try:
                search_results = await asyncio.wait_for(
                    self._search_agent_indexes(query, agents),
                    timeout=timeout_seconds
                )
            except asyncio.TimeoutError:
                logger.warning(
                    f"Agent context search timed out after {timeout_seconds}s"
                )
                return ""
            
            # Format results into context sections
            context = self._format_context_sections(search_results)
            
            if context:
                logger.info(
                    f"Injected context from {len(search_results)} agents",
                    extra={
                        "query": query[:100],
                        "agent_count": len(search_results),
                        "context_length": len(context)
                    }
                )
            
            return context
            
        except Exception as e:
            logger.error(f"Failed to get agent context: {e}", exc_info=True)
            # Fail gracefully - no context better than broken prompt
            return ""
    
    async def _get_enabled_agents(
        self,
        enabled_only: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Get agents with context injection enabled.
        
        Args:
            enabled_only: Only return enabled agents
            
        Returns:
            List of agent configs with context_injection settings
        """
        try:
            # Query agent_configs table
            filters = {}
            if enabled_only:
                filters["enabled"] = True
            
            configs = await self._gateway.select(
                "agent_configs",
                filters=filters,
                order_by="agent_name"
            )
            
            # Filter to only agents with context_injection enabled
            enabled_agents = []
            for config in configs:
                config_data = config.get("configuration", {})
                context_injection = config_data.get("context_injection", {})
                
                if context_injection.get("enabled", False):
                    enabled_agents.append({
                        "agent_name": config["agent_name"],
                        "agent_type": config["agent_type"],
                        "top_k": context_injection.get(
                            "top_k",
                            self._retrieval_config.default_top_k
                        ),
                        "min_score": context_injection.get(
                            "min_score",
                            self._retrieval_config.min_score
                        ),
                        "priority": context_injection.get("priority", 10)
                    })
            
            # Sort by priority (lower number = higher priority)
            enabled_agents.sort(key=lambda x: x["priority"])
            
            logger.debug(
                f"Found {len(enabled_agents)} agents with context injection enabled"
            )
            
            return enabled_agents
            
        except Exception as e:
            logger.error(f"Failed to get enabled agents: {e}", exc_info=True)
            return []
    
    async def _search_agent_indexes(
        self,
        query: str,
        agents: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Search indexes for all enabled agents in parallel.
        
        Args:
            query: Search query
            agents: List of agent configs with context_injection settings
            
        Returns:
            List of search results with agent metadata
        """
        # Limit concurrent searches
        max_concurrent = self._retrieval_config.max_concurrent_searches
        semaphore = asyncio.Semaphore(max_concurrent)
        
        async def search_with_semaphore(agent):
            async with semaphore:
                return await self._search_single_agent(query, agent)
        
        # Execute searches in parallel (with semaphore limiting concurrency)
        tasks = [search_with_semaphore(agent) for agent in agents]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Filter out exceptions and empty results
        valid_results = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.warning(
                    f"Search failed for agent {agents[i]['agent_name']}: {result}"
                )
                continue
            
            if result and result.get("results"):
                valid_results.append(result)
        
        return valid_results
    
    async def _search_single_agent(
        self,
        query: str,
        agent: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Search a single agent's index.
        
        Args:
            query: Search query
            agent: Agent config with context_injection settings
            
        Returns:
            Search results with metadata
        """
        agent_name = agent["agent_name"]
        top_k = agent["top_k"]
        min_score = agent["min_score"]
        
        try:
            # Use default timeout from settings
            timeout = getattr(self._settings.http_client, "default_timeout", 30.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    f"{self._backend_url}/v1/search/index",
                    params={
                        "name": agent_name,
                        "query": query,
                        "top_k": top_k,
                        "min_score": min_score
                    }
                )
                
                if response.status_code == 404:
                    logger.debug(
                        f"No index found for agent {agent_name}"
                    )
                    return {"agent_name": agent_name, "results": []}
                
                response.raise_for_status()
                data = response.json()
                
                return {
                    "agent_name": agent_name,
                    "agent_type": agent.get("agent_type", "unknown"),
                    "priority": agent["priority"],
                    "results": data.get("results", [])
                }
                
        except httpx.HTTPError as e:
            logger.warning(
                f"HTTP error searching {agent_name} index: {e}"
            )
            return {"agent_name": agent_name, "results": []}
        except Exception as e:
            logger.error(
                f"Failed to search {agent_name} index: {e}",
                exc_info=True
            )
            return {"agent_name": agent_name, "results": []}
    
    def _format_context_sections(
        self,
        search_results: List[Dict[str, Any]]
    ) -> str:
        """
        Format search results into markdown sections.
        
        Args:
            search_results: List of search results from agents
            
        Returns:
            Formatted context string
        """
        if not search_results:
            return ""
        
        sections = ["## 🔍 Agent Context\n"]
        
        total_results = 0
        for agent_data in search_results:
            agent_name = agent_data["agent_name"]
            results = agent_data.get("results", [])
            
            if not results:
                continue
            
            # Limit total results across all agents
            remaining_quota = self._retrieval_config.max_total_results - total_results
            if remaining_quota <= 0:
                break
            
            results_to_include = results[:remaining_quota]
            total_results += len(results_to_include)
            
            # Add agent section
            agent_display = agent_name.replace("_", " ").title()
            sections.append(f"\n### From {agent_display}")
            
            # Add results
            for i, result in enumerate(results_to_include, 1):
                score = result.get("score", 0.0)
                content = result.get("content", "")
                metadata = result.get("metadata", {})
                
                # Format metadata if available
                meta_str = ""
                if metadata:
                    created_at = metadata.get("created_at")
                    if created_at:
                        try:
                            dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                            meta_str = f" *({dt.strftime('%Y-%m-%d')})*"
                        except (ValueError, TypeError):
                            pass
                
                sections.append(
                    f"**[{i}]** (Score: {score:.2f}){meta_str}\n{content}\n"
                )
        
        if total_results == 0:
            return ""
        
        return "\n".join(sections) + "\n"


async def get_agent_context(
    query: str,
    chat_id: Optional[UUID] = None,
    uow: Optional[SupabaseUnitOfWork] = None
) -> str:
    """
    Convenience function to get agent context.
    
    Args:
        query: Search query
        chat_id: Optional chat ID
        uow: Optional unit of work (creates new if not provided)
        
    Returns:
        Formatted context string
    """
    if uow is None:
        from api.dependencies import get_database_connection
        from data.database.uow import SupabaseRequestContext
        import uuid as uuid_module
        
        gateway = get_database_connection()
        if gateway is None:
            logger.error("Database connection not initialized")
            return ""
        
        context = SupabaseRequestContext(request_id=str(uuid_module.uuid4()))
        
        async with SupabaseUnitOfWork(gateway, context) as uow:
            injector = AgentContextInjector(uow)
            return await injector.get_agent_context(query, chat_id)
    else:
        injector = AgentContextInjector(uow)
        return await injector.get_agent_context(query, chat_id)
