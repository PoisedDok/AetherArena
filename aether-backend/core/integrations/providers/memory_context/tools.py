"""
Memory Context Tools

Agent tools for managing memories with vector search.

@.architecture
Incoming: Open Interpreter agent, IntegrationLoader --- {tool calls from agent}
Processing: HTTP requests to memory API endpoints --- {4 jobs: JOB_HTTP_REQUEST, JOB_ORCHESTRATE, JOB_TRANSFORM_DATA, JOB_VALIDATE_CONFIG}
Outgoing: Backend API (memories endpoints) --- {Dict[str, Any], json}
"""

import httpx
from typing import List, Dict, Any, Optional


def _get_api_base() -> str:
    """Get API base URL from settings - no fallback."""
    from config.settings import get_settings
    settings = get_settings()
    return f"{settings.base_url}/v1/memory"


def _get_timeout() -> float:
    """Get HTTP timeout from settings."""
    try:
        from config.settings import get_settings
        return get_settings().http_client.default_timeout
    except Exception:
        return 30.0


def memories_add(
    content: str,
    memory_type: Optional[str] = None,
    importance: Optional[float] = None,
    source_chat_id: Optional[str] = None,
    tags: Optional[List[str]] = None,
    created_by: str = "agent"
) -> Dict[str, Any]:
    """
    Add a new memory to the global memory store.
    
    Args:
        content: The memory content
        memory_type: Type of memory (fact, decision, preference, insight, skill)
        importance: Importance score 0.0-1.0
        source_chat_id: Optional UUID of source chat
        tags: Optional list of tags
        created_by: Creator (user or agent)
    
    Returns:
        Created memory with ID and embedding
    
    Example:
        memory = memories_add(
            content="User prefers dark mode for all applications",
            memory_type="preference",
            importance=0.8,
            tags=["ui", "preferences"]
        )
    """
    # Use settings defaults if not specified
    try:
        from config.settings import get_settings
        settings = get_settings()
        memory_type = memory_type if memory_type else settings.memory_service.valid_memory_types[0]
        importance = importance if importance is not None else settings.memory_service.default_auto_importance
    except Exception:
        memory_type = memory_type if memory_type else "fact"
        importance = importance if importance is not None else 0.5
    
    payload = {
        "content": content,
        "memory_type": memory_type,
        "source_chat_id": source_chat_id,
        "metadata": {"tags": tags or []},
        "created_by": created_by
    }
    if importance is not None:
        payload["importance_score"] = importance
    
    response = httpx.post(f"{_get_api_base()}/create", json=payload, timeout=_get_timeout())
    response.raise_for_status()
    return response.json()


def memories_search(
    query: str,
    search_type: str = "vector",
    limit: Optional[int] = None,
    threshold: Optional[float] = None,
    memory_type: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Search memories using vector similarity or hybrid search.
    
    Args:
        query: Search query
        search_type: "vector" or "hybrid" (vector + keyword)
        limit: Maximum number of results
        threshold: Similarity threshold 0.0-1.0
        memory_type: Optional filter by memory type
    
    Returns:
        List of matching memories with similarity scores
    
    Example:
        results = memories_search(
            query="What are the user's preferences?",
            search_type="hybrid",
            limit=5
        )
    """
    # Use settings defaults if not specified
    try:
        from config.settings import get_settings
        settings = get_settings()
        limit = limit if limit is not None else settings.memory_service.default_search_limit
        threshold = threshold if threshold is not None else settings.memory_service.vector_match_threshold
    except Exception:
        limit = limit if limit is not None else 10
        threshold = threshold if threshold is not None else 0.5
    
    payload = {
        "query": query,
        "search_type": search_type,
        "match_count": limit,
        "match_threshold": threshold,
        "memory_type": memory_type
    }
    
    base_url = _get_api_base().rsplit("/v1/memory", 1)[0]
    response = httpx.post(f"{base_url}/v1/search/memories", json=payload, timeout=_get_timeout())
    response.raise_for_status()
    return response.json().get("results", [])


def memories_list(
    memory_type: Optional[str] = None,
    min_importance: Optional[float] = None,
    limit: int = 50
) -> List[Dict[str, Any]]:
    """
    List memories with optional filters.
    
    Args:
        memory_type: Optional filter by type
        min_importance: Optional minimum importance score
        limit: Maximum number of results
    
    Returns:
        List of memories
    
    Example:
        memories = memories_list(memory_type="decision", min_importance=0.7)
    """
    params = {"limit": limit}
    if memory_type:
        params["memory_type"] = memory_type
    if min_importance is not None:
        params["min_importance"] = min_importance
    
    response = httpx.get(f"{_get_api_base()}/list", params=params, timeout=_get_timeout())
    response.raise_for_status()
    return response.json()


def memories_get(memory_id: str) -> Dict[str, Any]:
    """
    Get a specific memory by ID.
    
    Args:
        memory_id: UUID of the memory
    
    Returns:
        Memory details
    
    Example:
        memory = memories_get("123e4567-e89b-12d3-a456-426614174000")
    """
    response = httpx.get(f"{_get_api_base()}/get/{memory_id}", timeout=_get_timeout())
    response.raise_for_status()
    return response.json()


def memories_edit(
    memory_id: str,
    content: Optional[str] = None,
    memory_type: Optional[str] = None,
    importance: Optional[float] = None,
    tags: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    Edit an existing memory.
    
    Args:
        memory_id: UUID of the memory to edit
        content: Optional new content
        memory_type: Optional new type
        importance: Optional new importance score
        tags: Optional new tags
    
    Returns:
        Updated memory
    
    Example:
        updated = memories_edit(
            memory_id="123e4567-e89b-12d3-a456-426614174000",
            importance=0.9,
            tags=["critical", "preferences"]
        )
    """
    payload = {}
    if content is not None:
        payload["content"] = content
    if memory_type is not None:
        payload["memory_type"] = memory_type
    if importance is not None:
        payload["importance_score"] = importance
    if tags is not None:
        payload["metadata"] = {"tags": tags}
    
    response = httpx.patch(f"{_get_api_base()}/update/{memory_id}", json=payload, timeout=_get_timeout())
    response.raise_for_status()
    return response.json()


def memories_delete(memory_id: str) -> Dict[str, str]:
    """
    Delete a memory.
    
    Args:
        memory_id: UUID of the memory to delete
    
    Returns:
        Success message
    
    Example:
        result = memories_delete("123e4567-e89b-12d3-a456-426614174000")
    """
    response = httpx.delete(f"{_get_api_base()}/delete/{memory_id}", timeout=_get_timeout())
    response.raise_for_status()
    return {"status": "deleted", "memory_id": memory_id}


def memories_relate(
    memory_id: str,
    related_memory_id: str,
    relation_type: str = "related_to",
    strength: float = 0.5
) -> Dict[str, Any]:
    """
    Create a relation between two memories.
    
    Args:
        memory_id: UUID of the first memory
        related_memory_id: UUID of the related memory
        relation_type: Type of relation (related_to, caused_by, depends_on, etc.)
        strength: Relation strength 0.0-1.0
    
    Returns:
        Created relation
    
    Example:
        relation = memories_relate(
            memory_id="123e4567-e89b-12d3-a456-426614174000",
            related_memory_id="223e4567-e89b-12d3-a456-426614174000",
            relation_type="caused_by",
            strength=0.8
        )
    """
    payload = {
        "related_memory_id": related_memory_id,
        "relation_type": relation_type,
        "strength": strength
    }
    
    response = httpx.post(f"{_get_api_base()}/relation/create/{memory_id}", json=payload, timeout=_get_timeout())
    response.raise_for_status()
    return response.json()


def memories_get_relations(memory_id: str) -> List[Dict[str, Any]]:
    """
    Get all relations for a memory.
    
    Args:
        memory_id: UUID of the memory
    
    Returns:
        List of relations
    
    Example:
        relations = memories_get_relations("123e4567-e89b-12d3-a456-426614174000")
    """
    response = httpx.get(f"{_get_api_base()}/relation/list/{memory_id}", timeout=_get_timeout())
    response.raise_for_status()
    return response.json()

