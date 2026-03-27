"""
Chat Context Tools

Agent tools for managing cross-chat references and searching chat summaries.

@.architecture
Incoming: Open Interpreter agent --- {tool_call with chat_id, query, etc.}
Processing: call backend API endpoints, format responses --- {2 jobs: JOB_HTTP_REQUEST, JOB_TRANSFORM_DATA}
Outgoing: Open Interpreter agent --- {Dict/List results in markdown-friendly format}
"""

import httpx
from typing import List, Dict, Any, Optional


def _get_backend_url() -> str:
    """Get backend URL from settings - no fallback."""
    from config.settings import get_settings
    return get_settings().base_url


def _get_api_base() -> str:
    """Get API base URL from settings."""
    return f"{_get_backend_url()}/v1/storage"


def _get_timeout() -> float:
    """Get HTTP timeout from settings."""
    try:
        from config.settings import get_settings
        return get_settings().http_client.default_timeout
    except Exception:
        return 10.0


def _get_llm_timeout() -> float:
    """Get LLM-specific timeout from settings."""
    try:
        from config.settings import get_settings
        return get_settings().http_client.llm_timeout
    except Exception:
        return 60.0


def chats_search(query: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
    """
    Search chat summaries using full-text search.
    
    Searches across chat titles and key points to find relevant conversations.
    
    Args:
        query: Search query text
        limit: Maximum number of results (default: 10, max: 50)
        
    Returns:
        List of matching chats with titles, key points, and relevance scores
        
    Example:
        >>> results = computer.chats.search("python code examples", limit=5)
        >>> for chat in results:
        ...     print(f"{chat['title']} (score: {chat['relevance_score']})")
    """
    # Use settings defaults if not specified
    try:
        from config.settings import get_settings
        settings = get_settings()
        limit = limit if limit is not None else settings.summary_service.default_search_limit
    except Exception:
        limit = limit if limit is not None else 10
    
    try:
        response = httpx.post(
            f"{_get_api_base()}/chats/search",
            json={"query": query, "limit": min(limit, 50)},
            timeout=_get_timeout()
        )
        
        if response.status_code == 200:
            data = response.json()
            return data.get("results", [])
        else:
            return [{"error": f"Search failed: {response.status_code}", "detail": response.text}]
            
    except Exception as e:
        return [{"error": f"Search request failed: {str(e)}"}]


def chats_summarize(chat_id: str, summary_type: str = "full", force_regenerate: bool = False) -> Dict[str, Any]:
    """
    Generate an LLM-powered summary for a chat.
    
    Extracts title, key points, entities, and topics from the conversation.
    
    Args:
        chat_id: UUID of the chat to summarize
        summary_type: Type of summary - 'full', 'brief', 'technical', 'executive' (default: 'full')
        force_regenerate: Force regeneration even if summary exists (default: False)
        
    Returns:
        Generated summary with title, key_points, entities, and metadata
        
    Example:
        >>> summary = computer.chats.summarize(
        ...     chat_id="123e4567-e89b-12d3-a456-426614174000",
        ...     summary_type="brief"
        ... )
        >>> print(f"Title: {summary['title']}")
        >>> print(f"Key Points: {summary['key_points']}")
    """
    try:
        response = httpx.post(
            f"{_get_api_base()}/chats/{chat_id}/summarize",
            json={
                "summary_type": summary_type,
                "force_regenerate": force_regenerate
            },
            timeout=_get_llm_timeout()  # Longer timeout for LLM processing
        )
        
        if response.status_code in (200, 201):
            return response.json()
        elif response.status_code == 404:
            return {"error": "Chat not found or has no messages", "detail": response.text}
        elif response.status_code == 503:
            return {"error": "LLM service unavailable", "detail": "Cannot generate summary at this time"}
        else:
            return {"error": f"Summarization failed: {response.status_code}", "detail": response.text}
            
    except httpx.TimeoutException:
        return {"error": "Summarization timed out", "detail": "LLM took too long to respond"}
    except Exception as e:
        return {"error": f"Request failed: {str(e)}"}


def chats_list(limit: int = 50, skip: int = 0) -> List[Dict[str, Any]]:
    """
    List recent chats with metadata.
    
    Retrieves a list of chats ordered by most recent activity.
    
    Args:
        limit: Maximum number of chats to return (default: 50, max: 100)
        skip: Number of chats to skip for pagination (default: 0)
        
    Returns:
        List of chats with IDs, titles, and metadata
        
    Example:
        >>> chats = computer.chats.list(limit=10)
        >>> for chat in chats:
        ...     print(f"{chat['title']} - {chat['message_count']} messages")
    """
    try:
        # Use settings defaults if not specified
        try:
            from config.settings import get_settings
            settings = get_settings()
            limit = limit if limit is not None else settings.summary_service.default_search_limit
        except Exception:
            limit = limit if limit is not None else 10
        
        response = httpx.get(
            f"{_get_api_base()}/chats",
            params={"limit": min(limit, 100), "skip": skip},
            timeout=_get_timeout()
        )
        
        if response.status_code == 200:
            return response.json()
        else:
            return [{"error": f"Failed to list chats: {response.status_code}", "detail": response.text}]
            
    except Exception as e:
        return [{"error": f"Request failed: {str(e)}"}]


def chats_attach(
    source_chat_id: str,
    target_chat_id: str,
    reference_type: str = "context",
    metadata: Optional[Dict[str, Any]] = None,
    created_by: str = "user"
) -> Dict[str, Any]:
    """
    Create a reference from one chat to another.
    """
    try:
        response = httpx.post(
            f"{_get_api_base()}/chats/{source_chat_id}/references",
            json={
                "target_chat_id": target_chat_id,
                "reference_type": reference_type,
                "metadata": metadata or {},
                "created_by": created_by
            },
            timeout=_get_timeout()
        )
        if response.status_code in (200, 201):
            return response.json()
        return {"error": f"Attach failed: {response.status_code}", "detail": response.text}
    except Exception as e:
        return {"error": f"Attach request failed: {str(e)}"}


def chats_list_references(
    chat_id: str,
    direction: str = "both",
    limit: int = 100,
    offset: int = 0
) -> List[Dict[str, Any]]:
    """
    List references connected to a chat.
    """
    try:
        response = httpx.get(
            f"{_get_api_base()}/chats/{chat_id}/references",
            params={"direction": direction, "limit": limit, "offset": offset},
            timeout=_get_timeout()
        )
        if response.status_code == 200:
            data = response.json()
            if isinstance(data, dict):
                return data.get("references", data)
            return data
        return [{"error": f"List references failed: {response.status_code}", "detail": response.text}]
    except Exception as e:
        return [{"error": f"List references request failed: {str(e)}"}]


def chats_unlink(reference_id: str) -> Dict[str, Any]:
    """
    Remove a chat reference by ID.
    """
    try:
        response = httpx.delete(
            f"{_get_api_base()}/chats/references/{reference_id}",
            timeout=_get_timeout()
        )
        if response.status_code == 200:
            return response.json()
        return {"error": f"Unlink failed: {response.status_code}", "detail": response.text}
    except Exception as e:
        return {"error": f"Unlink request failed: {str(e)}"}

