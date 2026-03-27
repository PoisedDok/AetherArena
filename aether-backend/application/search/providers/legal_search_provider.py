from typing import Union
from core.exceptions import UpstreamServiceError
from pydantic import BaseModel, Field

from application.search.interfaces import SearchProvider, SearchContext
from core.integrations.providers.perplexica.search import (
    legal_search,
    get_legal_databases_for_jurisdiction,
    LEGAL_DATABASES
)


class LegalSearchRequest(BaseModel):
    """Legal search request."""
    query: str = Field(..., description="Search query (case name, citation, keywords)")
    jurisdiction: str = Field(default="all", description="uk, us, commonwealth, eu, international, all")
    document_type: str = Field(default="cases", description="cases, legislation, statutes, regulations, treaties")


class LegalDatabasesRequest(BaseModel):
    jurisdiction: str = Field(default="all", description="Filter by jurisdiction")


class LegalSearchProvider(SearchProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        settings = context.settings
        
        # Determine operation type based on payload
        if isinstance(payload, LegalDatabasesRequest) or hasattr(payload, "jurisdiction") and not hasattr(payload, "query"):
            jurisdiction = getattr(payload, "jurisdiction", "all")
            if jurisdiction == "all":
                return {
                    "databases": LEGAL_DATABASES,
                    "regions": list(LEGAL_DATABASES.keys()),
                    "total_databases": sum(len(dbs) for dbs in LEGAL_DATABASES.values())
                }
            else:
                databases = get_legal_databases_for_jurisdiction(jurisdiction)
                return {
                    "jurisdiction": jurisdiction,
                    "databases": databases,
                    "count": len(databases)
                }
                
        # Normal legal search
        if not settings.integrations.searxng_enabled:
            raise UpstreamServiceError(
                "SearXNG is not enabled",
                status_code=503
            )
            
        result = await legal_search(
            query=getattr(payload, "query", ""),
            jurisdiction=getattr(payload, "jurisdiction", "all"),
            document_type=getattr(payload, "document_type", "cases")
        )
        
        if isinstance(result, dict) and "error" in result:
            raise UpstreamServiceError(
                f"Legal search failed: {result['error']}",
                status_code=502
            )
            
        return result
