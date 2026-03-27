"""
Utility API Endpoints

Internal utility endpoints for cross-service text processing.
Exposes ContextRanker (query-aware) and DocumentUtility (document-centric)
as HTTP APIs so TypeScript services (Perplexica, etc.) can use them
without reimplementation.

Routing:
- /v1/utils/extractive   → ContextRanker (query-aware if query provided, centroid if not)
- /v1/utils/rank-results  → ContextRanker (always query-aware, MMR diversity)

@.architecture
Incoming: Perplexica search agents, any internal service --- {HTTP POST with text/results}
Processing: ContextRanker TF-IDF + MMR ranking + budget selection --- {JOB_RANK, JOB_SELECT}
Outgoing: Caller --- {ranked/pruned text or results within token budget}
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from monitoring import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/utils", tags=["utils"])


# ==============================================================================
# Request / Response Models
# ==============================================================================

class ExtractiveRequest(BaseModel):
    """Request for extractive text processing."""
    text: str = Field(..., description="Text to process")
    query: Optional[str] = Field(None, description="Query for relevance-aware ranking (optional)")
    budget_chars: int = Field(
        default=40000,
        ge=1000,
        le=500000,
        description="Target output size in characters"
    )
    chunk_size: int = Field(default=800, ge=100, le=5000, description="Chunk size in characters")
    chunk_overlap: int = Field(default=150, ge=0, le=1000, description="Chunk overlap in characters")
    max_chunks: int = Field(default=50, ge=5, le=200, description="Max chunks to select")


class ExtractiveResponse(BaseModel):
    """Response from extractive processing."""
    text: str
    chunks_total: int
    chunks_selected: int
    original_chars: int
    result_chars: int
    processing_ms: int


class RankResultsRequest(BaseModel):
    """Request for ranking structured search results."""
    results: List[Dict[str, Any]] = Field(
        ...,
        description="Array of search results with 'content' and optional 'title'/'url' fields"
    )
    query: str = Field(..., description="User query for relevance ranking")
    budget_chars: int = Field(
        default=40000,
        ge=1000,
        le=500000,
        description="Target combined content size in characters"
    )
    content_field: str = Field(default="content", description="Field name containing result text")
    title_field: str = Field(default="title", description="Field name containing result title")


class RankResultsResponse(BaseModel):
    """Response from result ranking."""
    results: List[Dict[str, Any]]
    total_input: int
    total_selected: int
    original_chars: int
    result_chars: int
    processing_ms: int


# ==============================================================================
# Endpoints
# ==============================================================================

@router.post(
    "/extractive",
    response_model=ExtractiveResponse,
    summary="Extractive Text Processing",
    description=(
        "Process large text using ContextRanker's TF-IDF + MMR pipeline. "
        "Chunks text, ranks by query relevance (or centrality if no query), "
        "selects diverse top chunks within budget."
    )
)
async def extractive_process(request: ExtractiveRequest):
    """
    Extractive text processing via ContextRanker.

    - With query: ranks chunks by query relevance + MMR diversity
    - Without query: ranks by centroid similarity (document importance)
    - Always: budget-aware selection, document-order reassembly
    """
    try:
        from utils.context_ranker import ContextRanker

        ranker = ContextRanker(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
        )

        result = ranker.rank_text(
            text=request.text,
            query=request.query,
            budget_chars=request.budget_chars,
            max_chunks=request.max_chunks,
        )

        return ExtractiveResponse(
            text=result["text"],
            chunks_total=result["chunks_total"],
            chunks_selected=result["chunks_selected"],
            original_chars=result["original_chars"],
            result_chars=result["result_chars"],
            processing_ms=result["processing_ms"],
        )

    except Exception as e:
        logger.error("Extractive processing failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Extractive processing failed. Check server logs for details."
        )


@router.post(
    "/rank-results",
    response_model=RankResultsResponse,
    summary="Rank and Select Search Results",
    description=(
        "Rank structured search results by query relevance using TF-IDF + MMR, "
        "then select diverse top results within a character budget. "
        "Designed for Perplexica search agent quality mode."
    )
)
async def rank_results(request: RankResultsRequest):
    """
    Rank and select search results via ContextRanker.

    TF-IDF vectorization + query cosine similarity + position boost,
    then MMR selection for diversity. Budget-aware.
    """
    try:
        from utils.context_ranker import ContextRanker

        ranker = ContextRanker()

        result = ranker.rank_results(
            results=request.results,
            query=request.query,
            budget_chars=request.budget_chars,
            content_field=request.content_field,
            title_field=request.title_field,
        )

        return RankResultsResponse(
            results=result["results"],
            total_input=result["total_input"],
            total_selected=result["total_selected"],
            original_chars=result["original_chars"],
            result_chars=result["result_chars"],
            processing_ms=result["processing_ms"],
        )

    except Exception as e:
        logger.error("Rank results failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Rank results failed. Check server logs for details."
        )
