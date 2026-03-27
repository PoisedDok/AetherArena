import threading
from fastapi import Depends
from config.settings import Settings
from core.domain.gateway_interfaces import ISearchGateway
from data.network.search_gateway import get_search_gateway

from .core import get_settings, get_runtime_settings
from .database import get_database
from .files import get_index_service

_init_lock = threading.Lock()

# =============================================================================
# Research Service Dependencies
# =============================================================================

async def get_search_indexes_repository(
    database = Depends(get_database)
):
    """Provide SearchIndexesRepository instance."""
    from data.database.repositories.search_indexes import SearchIndexesRepository
    return SearchIndexesRepository(database)


async def get_source_indexing_service(
    settings: Settings = Depends(get_runtime_settings),
    repo = Depends(get_search_indexes_repository)
):
    """Provide source indexing service instance."""
    from application.services.source_indexing_service import SourceIndexingService
    return SourceIndexingService(settings, repo)


async def get_research_service(
    settings: Settings = Depends(get_settings),
    gateway: ISearchGateway = Depends(get_search_gateway),
    index_service = Depends(get_index_service),
    db = Depends(get_database)
):
    """Provide research service instance."""
    from application.research.research_service import ResearchService
    return ResearchService(settings, gateway, index_service, db)


# =============================================================================
# Search Orchestrator Dependencies
# =============================================================================

_search_orchestrator = None

def get_search_orchestrator():
    """Provide a singleton SearchOrchestrator instance."""
    global _search_orchestrator
    if _search_orchestrator is None:
        with _init_lock:
            if _search_orchestrator is None:
                from application.search.orchestrator import SearchOrchestrator
                from application.search.providers.web_search_provider import WebSearchProvider
                from application.search.providers.unified_search_provider import UnifiedSearchProvider
                from application.search.providers.perplexica_providers import (
                    AcademicSearchProvider, RedditSearchProvider, WolframSearchProvider,
                    WritingAssistantProvider, ImageSearchProvider, VideoSearchProvider,
                    SuggestionsProvider, DiscoverProvider
                )
                from application.search.providers.local_providers import (
                    FileSearchProvider, MemorySearchProvider, ChatSearchProvider, ResearchProvider,
                    IndexSearchProvider, MultiIndexSearchProvider, AgentSearchProvider,
                    NotebookSearchProvider, ToolSearchProvider
                )
                from application.search.providers.legal_search_provider import LegalSearchProvider

                orchestrator = SearchOrchestrator()
                orchestrator.register("web", WebSearchProvider())
                orchestrator.register("unified", UnifiedSearchProvider())
                orchestrator.register("academic", AcademicSearchProvider())
                orchestrator.register("reddit", RedditSearchProvider())
                orchestrator.register("wolfram", WolframSearchProvider())
                orchestrator.register("writing", WritingAssistantProvider())
                orchestrator.register("images", ImageSearchProvider())
                orchestrator.register("videos", VideoSearchProvider())
                orchestrator.register("suggestions", SuggestionsProvider())
                orchestrator.register("discover", DiscoverProvider())
                orchestrator.register("files", FileSearchProvider())
                orchestrator.register("memories", MemorySearchProvider())
                orchestrator.register("chats", ChatSearchProvider())
                orchestrator.register("research", ResearchProvider())
                orchestrator.register("index", IndexSearchProvider())
                orchestrator.register("indexes", MultiIndexSearchProvider())
                orchestrator.register("agents", AgentSearchProvider())
                orchestrator.register("notebooks", NotebookSearchProvider())
                orchestrator.register("tools", ToolSearchProvider())
                orchestrator.register("legal", LegalSearchProvider())
                
                _search_orchestrator = orchestrator
    return _search_orchestrator
