"""
Research Schemas

Pydantic models for the Research API.
"""

from typing import List, Optional, Literal
from pydantic import BaseModel, Field

class ResearchRequest(BaseModel):
    """Research request payload."""
    query: str = Field(..., description="Research question or query")
    # Back-compat / explicit UX: allow callers to pass mode="fast" or mode="ai".
    # This prevents silent ignores of unknown fields (e.g. older tool prompts).
    mode: Optional[Literal["fast", "ai"]] = Field(
        default=None,
        description="Optional alias for ai_mode. fast => ai_mode=false, ai => ai_mode=true",
    )
    sources: List[Literal["web", "academic", "reddit", "wolfram", "youtube", "local", "news", "images", "videos", "discover", "legal"]] = Field(
        default=["web"],
        description="Research sources to query"
    )
    ai_mode: bool = Field(
        default=True,
        description="Use AI-enhanced search (Perplexica) vs fast search (Searxng)"
    )
    optimization_mode: Literal["speed", "balanced", "quality"] = Field(
        default="balanced",
        description="Search optimization mode"
    )
    max_results: int = Field(default=8, ge=1, le=20, description="Maximum results per source")
    model: Optional[str] = Field(None, description="LLM model override (uses agent config if not provided)")
    persist_history: bool = Field(
        default=False,
        description="Persist to agent_outputs/job history (only for manual UI invocations)"
    )
