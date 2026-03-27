"""
Unified Index API Endpoints

Provides a single interface for ALL AetherRag vector indexes in the system:
- Agent output indexes (memory, research)
- User file location indexes (Downloads, AetherArena, etc.)
- Future index types

@.architecture
Incoming: Frontend HTTP requests --- {HTTP GET/POST to /v1/index/*}
Processing: discover indexes, route to appropriate manager, search, merge results --- {4 jobs: JOB_HTTP_REQUEST, JOB_DISCOVER_INDEXES, JOB_ROUTE_SEARCH, JOB_MERGE_RESULTS}
Outgoing: Frontend, AgentAetherRagManager, AetherRagIndexManager --- {JSON responses, unified search results}
"""

from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, status
from pydantic import BaseModel, Field

from api.dependencies import (
    setup_request_context
)
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/index", tags=["indexes"])


# =============================================================================
# Schemas
# =============================================================================

class IndexInfo(BaseModel):
    """Information about a single AetherRag index."""
    index_name: str = Field(..., description="Unique index identifier")
    index_type: str = Field(..., description="Type: agent_output, file_location, source")
    display_name: str = Field(..., description="Human-readable name")
    description: Optional[str] = Field(None, description="Index description")
    chunk_count: Optional[int] = Field(None, description="Number of chunks indexed")
    index_size_bytes: Optional[int] = Field(None, description="Index file size")
    last_updated: Optional[str] = Field(None, description="Last update timestamp")
    is_searchable: bool = Field(..., description="Whether index can be searched")
    index_path: Optional[str] = Field(None, description="File system path")
    supported_modes: List[str] = Field(default=["semantic"], description="Supported search modes (semantic, bm25, hybrid)")
    source_type: Optional[str] = Field(None, description="Source type: custom, slack, browser_history, email, etc.")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional index metadata")


class IndexListResponse(BaseModel):
    """Response for listing all indexes."""
    indexes: List[IndexInfo]
    total_count: int
    by_type: Dict[str, int]


class SearchRequest(BaseModel):
    """Request for multi-index search."""
    query: str = Field(..., min_length=1, max_length=500, description="Search query")
    index_names: List[str] = Field(..., description="List of indexes to search")
    top_k: int = Field(default=10, ge=1, le=2000, description="Results per index")
    min_score: float = Field(default=0.0, ge=0.0, le=1.0, description="Minimum relevance score")


class SearchResult(BaseModel):
    """Single search result."""
    index_name: str
    index_type: str
    score: float
    text: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class SearchResponse(BaseModel):
    """Response for search operations."""
    results: List[SearchResult]
    total_found: int
    indexes_searched: List[str]
    search_duration_ms: int


# =============================================================================
# Endpoints
# =============================================================================

from application.indexing.index_service import IndexService
from api.dependencies import get_index_service

@router.get("/list", response_model=IndexListResponse, summary="List all indexes")
async def list_all_indexes(
    index_service: IndexService = Depends(get_index_service),
    _context: dict = Depends(setup_request_context)
) -> IndexListResponse:
    """
    List all available AetherRag vector indexes.
    
    Returns both agent output indexes and user file location indexes.
    Provides metadata including chunk counts, sizes, and last updated times.
    """
    try:
        result = await index_service.list_all_indexes()
        
        return IndexListResponse(
            indexes=[IndexInfo(**idx) for idx in result["indexes"]],
            total_count=result["total_count"],
            by_type=result["by_type"]
        )
    except Exception as e:
        logger.error("Failed to list indexes: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list indexes. Check server logs for details."
        )


@router.get(
    "/health/{index_name}",
    summary="Check index health"
)
async def check_index_health(
    index_name: str = PathParam(..., description="Name of the index"),
    index_service: IndexService = Depends(get_index_service),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Check if an index exists and is searchable.
    
    Returns health status and basic statistics.
    """
    try:
        result = await index_service.list_all_indexes()
        all_indexes = result["indexes"]
        index_info = next((idx for idx in all_indexes if idx["index_name"] == index_name), None)
        
        if not index_info:
            return {
                "index_name": index_name,
                "status": "not_found",
                "exists": False,
                "is_searchable": False
            }
        
        return {
            "index_name": index_name,
            "status": "healthy" if index_info["is_searchable"] else "disabled",
            "exists": True,
            "is_searchable": index_info["is_searchable"],
            "chunk_count": index_info.get("chunk_count"),
            "size_bytes": index_info.get("index_size_bytes"),
            "last_updated": index_info.get("last_updated"),
            "index_type": index_info["index_type"],
            "index_path": index_info.get("index_path")
        }
    
    except Exception as e:
        logger.error("Health check failed for '%s': %s", index_name, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Health check failed. Check server logs for details."
        )

