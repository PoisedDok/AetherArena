"""
Perplexica Search Integration - Layer 1 Implementation

Provides AI-powered web search and research capabilities via Perplexica backend.

Features:
- Multiple focus modes (web, academic, reddit, wolfram, writing)
- Dynamic model matching with LM Studio
- Comprehensive error handling
- Source tracking and citations

Production-ready with:
- Clean error messages
- Timeout management
- Configurable endpoints (from settings)
- Structured response format

Note: All URL parameters default to None and are loaded from settings.
Override by passing explicit URLs for testing/custom deployments.

@.architecture
Incoming: api/v1/endpoints/backends.py, services/Perplexica --- {str query, str focus_mode, str chat_model, Dict search config}
Processing: perplexica_search(), perplexica_search_stream(), _match_model_to_lm_studio(), health_check() --- {4 jobs: health_checking, http_communication, model_matching, web_search}
Outgoing: api/v1/endpoints/backends.py --- {Dict[str, Any] search results with answer/sources/images, AsyncIterator streaming response}
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


def _get_perplexica_url() -> str:
    """Get Perplexica URL from settings or use default."""
    try:
        from config.settings import get_settings
        return get_settings().integrations.perplexica_url
    except Exception:
        return "http://localhost:3000"


def _get_lm_studio_url() -> str:
    """Get LM Studio URL from settings or use default."""
    try:
        from config.settings import get_settings
        return get_settings().integrations.lm_studio_url
    except Exception:
        return "http://localhost:1234/v1"


def get_perplexica_available_models(base_url: Optional[str] = None) -> tuple[Dict, Dict]:
    """
    Get available models from Perplexica API.
    
    Args:
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        Tuple of (chat_models, embedding_models) dicts
    """
    if base_url is None:
        base_url = _get_perplexica_url()
    
    endpoint = f"{base_url}/api/models"
    
    try:
        with httpx.Client(timeout=15.0) as client:
            response = client.get(endpoint)
            if response.status_code == 200:
                result = response.json()
                chat_models = result.get("chatModelProviders", {})
                embedding_models = result.get("embeddingModelProviders", {})
                logger.debug(f"Retrieved Perplexica models: {len(chat_models)} chat, {len(embedding_models)} embedding")
                return chat_models, embedding_models
            else:
                logger.warning(f"Perplexica models endpoint returned {response.status_code}")
                return {}, {}
    except httpx.RequestError as e:
        logger.warning(f"Failed to retrieve Perplexica models: {e}")
        return {}, {}
    except Exception as e:
        logger.error(f"Unexpected error retrieving Perplexica models: {e}")
        return {}, {}


def get_lm_studio_models(lm_studio_url: Optional[str] = None) -> List[str]:
    """
    Get available models directly from LM Studio API.
    
    Args:
        lm_studio_url: LM Studio API endpoint (None = load from settings)
        
    Returns:
        List of model names
    """
    if lm_studio_url is None:
        lm_studio_url = f"{_get_lm_studio_url()}/models"
    elif not lm_studio_url.endswith("/models"):
        lm_studio_url = f"{lm_studio_url}/models"
    

    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.get(lm_studio_url)
            if response.status_code == 200:
                models_data = response.json().get("data", [])
                model_names = [m.get("id", "") for m in models_data if m.get("id")]
                logger.debug(f"Retrieved {len(model_names)} models from LM Studio")
                return model_names
            else:
                logger.warning(f"LM Studio API returned {response.status_code}")
                return []
    except httpx.RequestError as e:
        logger.warning(f"Failed to connect to LM Studio: {e}")
        return []
    except Exception as e:
        logger.error(f"Unexpected error retrieving LM Studio models: {e}")
        return []


def find_best_model_match(
    base_url: Optional[str] = None,
    lm_studio_url: Optional[str] = None
) -> tuple[Optional[Dict], Optional[Dict]]:
    """
    Find best matching chat and embedding models between Perplexica and LM Studio.
    
    Args:
        base_url: Perplexica service URL (None = load from settings)
        lm_studio_url: LM Studio API endpoint (None = load from settings)
        
    Returns:
        Tuple of (chat_model_config, embedding_model_config) or (None, None) if no match
    """
    if base_url is None:
        base_url = _get_perplexica_url()
    if lm_studio_url is None:
        lm_studio_url = _get_lm_studio_url()
    

    try:
        # Get available models from both services
        perplexica_chat, perplexica_embedding = get_perplexica_available_models(base_url)
        lm_studio_models = get_lm_studio_models(lm_studio_url)
        
        if not lm_studio_models:
            logger.warning("No models available from LM Studio")
            return None, None
        
        # Find chat model match
        chat_model = None
        for model_name in lm_studio_models:
            if "embedding" not in model_name.lower():
                # Check if this model is available in Perplexica's custom_openai provider
                if "custom_openai" in perplexica_chat:
                    chat_model = {
                        "provider": "custom_openai",
                        "name": model_name
                    }
                    logger.debug(f"Matched chat model: {model_name}")
                    break
        
        # Find embedding model match
        embedding_model = None
        for model_name in lm_studio_models:
            if "embedding" in model_name.lower():
                if "custom_openai" in perplexica_embedding:
                    embedding_model = {
                        "provider": "custom_openai",
                        "name": model_name
                    }
                    logger.debug(f"Matched embedding model: {model_name}")
                    break
        
        # Fallback: use first available models if specific match not found
        if not chat_model and lm_studio_models:
            chat_models = [m for m in lm_studio_models if "embedding" not in m.lower()]
            if chat_models:
                chat_model = {"provider": "custom_openai", "name": chat_models[0]}
                logger.info(f"Using fallback chat model: {chat_models[0]}")
        
        if not embedding_model and lm_studio_models:
            embedding_models = [m for m in lm_studio_models if "embedding" in m.lower()]
            if embedding_models:
                embedding_model = {"provider": "custom_openai", "name": embedding_models[0]}
                logger.info(f"Using fallback embedding model: {embedding_models[0]}")
        
        return chat_model, embedding_model
        
    except Exception as e:
        logger.error(f"Error finding model match: {e}")
        return None, None


def perplexica_search(
    query: str,
    focus: str = "webSearch",
    mode: str = "balanced",
    base_url: Optional[str] = None,
    timeout: float = 60.0
) -> Dict[str, Any]:
    """
    Comprehensive AI-powered search using Perplexica backend.
    
    Args:
        query: Search question/query
        focus: Search focus mode
            - webSearch: General web search
            - academicSearch: Academic papers and research
            - redditSearch: Reddit discussions
            - wolframAlphaSearch: Computational knowledge
            - writingAssistant: Writing help and grammar
        mode: Optimization mode (speed, balanced, quality)
        base_url: Perplexica service URL (None = load from settings)
        timeout: Request timeout in seconds
        
    Returns:
        Dict with keys:
            - query: Original query
            - focus_mode: Focus mode used
            - answer: AI-generated answer
            - sources: List of source URLs and titles
            - source_count: Number of sources
            - timestamp: ISO timestamp
            - error: Error message (if failed)
    """
    if base_url is None:
        base_url = _get_perplexica_url()
    
    endpoint = f"{base_url}/api/search"
    
    # Try to find best model match dynamically
    chat_model, embedding_model = find_best_model_match(base_url)
    
    if not chat_model or not embedding_model:
        error_msg = "No suitable models available. Ensure LM Studio is running with models loaded."
        logger.error(error_msg)
        return {"error": error_msg, "query": query}
    
    payload = {
        "query": query,
        "focusMode": focus,
        "optimizationMode": mode,
        "chatModel": chat_model,
        "embeddingModel": embedding_model,
        "history": [],
        "systemInstructions": "",
        "stream": False
    }
    
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(endpoint, json=payload)
            
            if response.status_code == 200:
                result = response.json()
                message = result.get("message", "")
                sources = result.get("sources", [])
                
                logger.info(f"Perplexica {focus} search completed: {len(sources)} sources found")
                
                return {
                    "query": query,
                    "focus_mode": focus,
                    "answer": message,
                    "sources": sources,
                    "source_count": len(sources),
                    "timestamp": datetime.now().isoformat(),
                    "model_used": f"{chat_model['provider']}/{chat_model['name']}"
                }
            else:
                error_msg = f"Search failed: HTTP {response.status_code}"
                logger.error(f"{error_msg}: {response.text}")
                return {"error": error_msg, "query": query}
                
    except httpx.TimeoutException:
        error_msg = f"Search timed out after {timeout}s"
        logger.error(error_msg)
        return {"error": error_msg, "query": query}
    except httpx.ConnectError:
        error_msg = f"Cannot connect to Perplexica at {base_url}. Ensure service is running."
        logger.error(error_msg)
        return {"error": error_msg, "query": query}
    except Exception as e:
        error_msg = f"Search error: {str(e)}"
        logger.error(error_msg)
        return {"error": error_msg, "query": query}


def web_search(
    query: str,
    mode: str = "balanced",
    max_results: int = 8,
    base_url: Optional[str] = None
) -> Dict[str, Any]:
    """
    General web search with AI-powered results and source citations.
    
    Args:
        query: Search query string
        mode: Search mode (speed, balanced, quality)
        max_results: Maximum results (not used by Perplexica, kept for API compatibility)
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        Dict with search results and sources
    """
    return perplexica_search(query, focus="webSearch", mode=mode, base_url=base_url)


def academic_search(
    query: str,
    mode: str = "balanced",
    base_url: Optional[str] = None
) -> Dict[str, Any]:
    """
    Academic research search from arXiv, PubMed, Google Scholar.
    
    Args:
        query: Research query
        mode: Search mode (speed, balanced, quality)
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        Dict with academic results and paper sources
    """
    return perplexica_search(query, focus="academicSearch", mode=mode, base_url=base_url)


def reddit_search(
    query: str,
    mode: str = "balanced",
    base_url: Optional[str] = None
) -> Dict[str, Any]:
    """
    Search Reddit discussions and community insights.
    
    Args:
        query: Search query
        mode: Search mode (speed, balanced, quality)
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        Dict with Reddit discussion results
    """
    return perplexica_search(query, focus="redditSearch", mode=mode, base_url=base_url)


def wolfram_search(
    query: str,
    mode: str = "balanced",
    base_url: Optional[str] = None
) -> Dict[str, Any]:
    """
    Search using Wolfram Alpha for computational knowledge.
    
    Args:
        query: Computational query
        mode: Search mode (speed, balanced, quality)
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        Dict with computational results
    """
    return perplexica_search(query, focus="wolframAlphaSearch", mode=mode, base_url=base_url)


def writing_assistant(
    query: str,
    mode: str = "quality",
    base_url: Optional[str] = None
) -> Dict[str, Any]:
    """
    AI writing assistant for grammar, style, and content improvement.
    
    Args:
        query: Writing task or text to improve
        mode: Search mode (speed, balanced, quality) - defaults to quality
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        Dict with writing suggestions
    """
    return perplexica_search(query, focus="writingAssistant", mode=mode, base_url=base_url)


def quick_search(
    query: str,
    base_url: Optional[str] = None
) -> str:
    """
    Quick search with answer-only response (no sources).
    
    Args:
        query: Search query
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        String answer or error message
    """
    result = perplexica_search(query, focus="webSearch", mode="speed", base_url=base_url)
    
    if "error" in result:
        return f"Search failed: {result['error']}"
    
    return result.get("answer", "No answer available")


def answer_with_sources(
    query: str,
    base_url: Optional[str] = None
) -> Dict[str, Any]:
    """
    Get answer with full source citations and metadata.
    
    Args:
        query: Search query
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        Dict with answer, sources, and metadata
    """
    return perplexica_search(query, focus="webSearch", mode="balanced", base_url=base_url)


def perplexica_discover(
    topic: str,
    base_url: Optional[str] = None
) -> Dict[str, Any]:
    """
    Discover comprehensive information about a topic.
    
    Args:
        topic: Topic to discover
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        Dict with comprehensive topic information
    """
    query = f"Provide a comprehensive overview of: {topic}"
    return perplexica_search(query, focus="webSearch", mode="quality", base_url=base_url)


def perplexica_models(base_url: Optional[str] = None) -> Dict[str, Any]:
    """
    Get available models and current configuration.
    
    Args:
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        Dict with model information
    """
    try:
        chat_models, embedding_models = get_perplexica_available_models(base_url)
        lm_studio_models = get_lm_studio_models()
        current_chat, current_embedding = find_best_model_match(base_url)
        
        return {
            "perplexica_chat_providers": list(chat_models.keys()),
            "perplexica_embedding_providers": list(embedding_models.keys()),
            "lm_studio_models": lm_studio_models,
            "current_chat_model": current_chat,
            "current_embedding_model": current_embedding,
            "status": "connected" if current_chat and current_embedding else "no_models"
        }
    except Exception as e:
        return {"error": f"Models info error: {str(e)}"}


def show_current_model(base_url: Optional[str] = None) -> str:
    """
    Show currently configured model in human-readable format.
    
    Args:
        base_url: Perplexica service URL (None = load from settings)
        
    Returns:
        String description of current model
    """
    try:
        chat_model, embedding_model = find_best_model_match(base_url)
        
        if not chat_model or not embedding_model:
            return "No models configured. Ensure LM Studio is running with models loaded."
        
        chat_info = f"{chat_model['provider']}/{chat_model['name']}"
        embedding_info = f"{embedding_model['provider']}/{embedding_model['name']}"
        
        return f"Chat: {chat_info}\nEmbedding: {embedding_info}"
    except Exception as e:
        return f"Error: {str(e)}"

