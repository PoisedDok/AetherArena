"""
Perplexica Search Integration - Thin Clean Wrapper

This module provides a clean interface for interacting with Perplexica search services.
It uses central configuration from the backend and routes requests with optimized payloads.

@.architecture
Incoming: Agent web_search tools, Backend API search endpoints --- {str query, Dict params}
Processing: Build optimized Perplexica payload, execute HTTP request --- {JOB_HTTP_REQUEST, JOB_TRANSFORM}
Outgoing: Perplexica API --- {Dict search results}
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from config.settings import get_settings

logger = logging.getLogger(__name__)

class PerplexicaClient:
    """Thin wrapper for Perplexica search backend."""
    
    def __init__(self, base_url: Optional[str] = None):
        settings = get_settings()
        self.base_url = (base_url or settings.integrations.perplexica_url).rstrip("/")
        self.timeout = getattr(settings.http_client, "external_service_timeout", 600.0)
        self._settings = settings

    def _resolve_inference_model_id(self, canonical_name: str, model_type: str = "text") -> str:
        """Resolve a canonical model name to the actual model ID on the inference server.
        
        The inference server uses local directory names as model IDs (e.g.
        'lmstudio-community/LFM2.5-1.2B-Instruct-MLX-8bit') while the backend
        config uses canonical names (e.g. 'liquid/lfm2.5-1.2b').
        
        Perplexica validates the model key against the inference server's /v1/models
        response, so we MUST send the actual model ID -- not the canonical name.
        
        Resolution order:
        1. Exact match (unlikely but handled)
        2. Substring match (canonical name appears in server model ID, case-insensitive)
        3. Fallback: first model of matching type (text/vision)
        """
        try:
            inference_url = self._settings.inference_url  # http://127.0.0.1:7090/v1
            import httpx as _httpx
            resp = _httpx.get(f"{inference_url}/models", timeout=5.0)
            if resp.status_code >= 400:
                logger.warning("Inference server /v1/models returned %d, using canonical name", resp.status_code)
                return canonical_name
            
            data = resp.json()
            models = data.get("data", [])
            if not models:
                return canonical_name
            
            import re
            # Extract the base model name (e.g. "lfm2.5-1.2b" from "liquid/lfm2.5-1.2b")
            canon_base = canonical_name.split("/")[-1].lower()
            # Split into significant tokens for multi-token matching
            # e.g. "Qwen3-4b-Instruct-2507-MLX-8bit" -> ["qwen3", "4b", "instruct", "2507", "mlx", "8bit"]
            # e.g. "lfm2.5-1.2b" -> ["lfm2", "5", "1", "2b"]
            canon_tokens = [t for t in re.split(r'[-_./]', canon_base) if t]
            
            # 1. Exact match
            for m in models:
                if m.get("id") == canonical_name:
                    return canonical_name
            
            # 2. Multi-token match: ALL significant tokens from canonical name
            #    must appear in the server model ID (case-insensitive)
            for m in models:
                mid = m.get("id", "")
                mid_lower = mid.lower()
                if all(tok in mid_lower for tok in canon_tokens):
                    logger.info("Resolved model '%s' -> '%s' (token match)", canonical_name, mid)
                    return mid
            
            # 3. Fallback: first model matching the requested type
            for m in models:
                if m.get("model_type", "text") == model_type:
                    logger.info("Resolved model '%s' -> '%s' (type fallback)", canonical_name, m["id"])
                    return m["id"]
            
            # 4. Any model
            fallback = models[0]["id"]
            logger.warning("Could not match '%s', falling back to first model: %s", canonical_name, fallback)
            return fallback
            
        except Exception as e:
            logger.warning("Failed to resolve inference model ID for '%s': %s", canonical_name, e)
            return canonical_name

    def _get_model_config(self, chat_model_override: Optional[str] = None) -> tuple[Dict[str, Any], Dict[str, Any]]:
        """Get model configuration for Perplexica chat and embedding.
        
        Provider IDs are deterministic and enforced at the Perplexica source level
        (src/lib/config/index.ts — BUILTIN_PROVIDER_IDS).  Both fresh installs and
        upgraded installs converge on the same IDs via initializeFromEnv() and
        migrateConfig().  No runtime resolution needed for provider IDs.
        
        Chat:      aether-inference-default  (local inference at :7090)
                   Model key resolved to the ACTUAL server model ID via
                   _resolve_inference_model_id() because Perplexica validates
                   against the server's /v1/models list.
        Embedding: transformers-default      (ONNX, runs inside Docker)
                   Model: Xenova/bge-small-en-v1.5 (pre-loaded in image)
        
        Args:
            chat_model_override: Optional canonical model name to use instead of
                the default summarizer_model. Allows callers to specify a different
                LLM for Perplexica's chat/synthesis (e.g., a larger model for
                quality mode).
        """
        # Chat: resolve canonical name to actual inference server model ID
        if chat_model_override:
            canonical_chat = chat_model_override
        else:
            canonical_chat = getattr(self._settings.llm, "summarizer_model", self._settings.llm.model)
        # Strip "openai/" prefix if present (LiteLLM artifact, not needed for direct inference)
        if canonical_chat.startswith("openai/"):
            canonical_chat = canonical_chat[7:]
        
        resolved_chat_key = self._resolve_inference_model_id(canonical_chat, model_type="text")
        
        chat_model = {
            "providerId": "aether-inference-default",
            "key": resolved_chat_key
        }

        # Embedding: Transformers.js ONNX (runs inside Perplexica container, no external dependency)
        embedding_model = {
            "providerId": "transformers-default",
            "key": getattr(self._settings.embedding_service, "model", "Xenova/bge-small-en-v1.5")
        }
        
        return chat_model, embedding_model

    async def search(
        self,
        query: str,
        focus: str = "webSearch",
        mode: str = "balanced",
        history: Optional[List[Any]] = None,
        system_instructions: Optional[str] = None,
        chat_model_override: Optional[str] = None,
        sources_override: Optional[List[str]] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """Execute a search request to Perplexica.
        
        Args:
            query: The search query.
            focus: Focus mode (webSearch, academicSearch, etc.). Determines default sources.
            mode: Optimization mode (speed, balanced, quality).
            history: Chat history for context.
            system_instructions: Custom system prompt for the writer.
            chat_model_override: Optional canonical model name to override the default
                LLM used by Perplexica for classification and synthesis.
            sources_override: Optional list of source types to search. Overrides the
                default source derived from focus mode. Valid values:
                'web', 'academic', 'discussions', 'legal'.
        """
        endpoint = f"{self.base_url}/api/search"
        
        chat_model, embedding_model = self._get_model_config(
            chat_model_override=chat_model_override,
        )
        
        # Default system instructions if not provided
        if not system_instructions:
            system_instructions = (
                "You are the Aether Search Synthesis Engine. "
                "Provide a definitive, structured response based on the search results. "
                "Cite sources using [number]. Do NOT hallucinate."
            )

        # Map optimization mode: Perplexica supports speed/balanced/quality
        perplexica_mode = mode if mode in ("speed", "balanced", "quality") else "balanced"

        # Resolve sources: explicit override > focus mode mapping
        if sources_override and len(sources_override) > 0:
            # Validate and use caller-specified sources
            valid_sources = {"web", "academic", "discussions", "legal"}
            perplexica_sources = [s for s in sources_override if s in valid_sources]
            if not perplexica_sources:
                perplexica_sources = ["web"]
        else:
            # Map backend focus modes to Perplexica internal sources
            source_map = {
                "webSearch": ["web"],
                "academicSearch": ["academic"],
                "redditSearch": ["discussions"],
                "legalSearch": ["legal"],
                "wolframAlphaSearch": ["web"],
                "writingAssistant": ["web"],
                "youtubeSearch": ["web"],
                "web": ["web"],
                "academic": ["academic"],
                "discussions": ["discussions"],
                "legal": ["legal"],
            }
            perplexica_sources = source_map.get(focus, ["web"])

        payload = {
            "query": query,
            "sources": perplexica_sources,
            "optimizationMode": perplexica_mode,
            "chatModel": chat_model,
            "embeddingModel": embedding_model,
            "history": history or [],
            "systemInstructions": system_instructions,
            "stream": False
        }

        # Add optional engines if provided
        if "engines" in kwargs:
            payload["engines"] = kwargs["engines"]

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(endpoint, json=payload)
                response.raise_for_status()
                
                result = response.json()
                sources = result.get("sources", [])
                
                return {
                    "query": query,
                    "focus_mode": focus,
                    "answer": result.get("message", ""),
                    "sources": sources,
                    "source_count": len(sources),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "model_used": f"{chat_model['providerId']}/{chat_model['key']}"
                }
                
        except Exception as e:
            logger.error("Perplexica search failed: %s", e)
            return {"error": str(e), "query": query}

# Convenience functions for easy integration

async def perplexica_search(query: str, **kwargs) -> Dict[str, Any]:
    """Base search function."""
    client = PerplexicaClient(base_url=kwargs.pop("base_url", None))
    # Map focus_mode alias if present
    focus = kwargs.pop("focus", kwargs.pop("focus_mode", "webSearch"))
    return await client.search(query, focus=focus, **kwargs)

async def web_search(query: str, **kwargs) -> Dict[str, Any]:
    """Web search convenience wrapper.
    
    Accepts optional chat_model_override and sources_override kwargs
    which are passed through to PerplexicaClient.search().
    """
    return await perplexica_search(query, focus="webSearch", **kwargs)

async def academic_search(query: str, **kwargs) -> Dict[str, Any]:
    """Academic search convenience wrapper."""
    return await perplexica_search(query, focus="academicSearch", **kwargs)

async def reddit_search(query: str, **kwargs) -> Dict[str, Any]:
    """Reddit search convenience wrapper."""
    return await perplexica_search(query, focus="redditSearch", **kwargs)

async def wolfram_search(query: str, **kwargs) -> Dict[str, Any]:
    """Wolfram search convenience wrapper."""
    return await perplexica_search(query, focus="wolframAlphaSearch", **kwargs)

async def writing_assistant(query: str, **kwargs) -> Dict[str, Any]:
    """Writing assistant convenience wrapper."""
    kwargs.setdefault("mode", "quality")
    return await perplexica_search(query, focus="writingAssistant", **kwargs)

async def quick_search(query: str, **kwargs) -> str:
    """Returns only the answer string."""
    kwargs.setdefault("mode", "speed")
    res = await web_search(query, **kwargs)
    return res.get("answer", res.get("error", "No answer available"))

async def image_search(query: str, history: Optional[List[Any]] = None, **kwargs) -> Dict[str, Any]:
    """Image search convenience wrapper (Perplexica /api/images)."""
    settings = get_settings()
    base_url = kwargs.pop("base_url", None) or settings.integrations.perplexica_url
    endpoint = f"{base_url.rstrip('/')}/api/images"
    
    client = PerplexicaClient(base_url=base_url)
    chat_model, _ = client._get_model_config()
    
    payload = {
        "query": query,
        "chatHistory": history or [],
        "chatModel": chat_model
    }
    
    try:
        timeout = getattr(settings.http_client, "external_service_timeout", 600.0)
        async with httpx.AsyncClient(timeout=timeout) as http_client:
            response = await http_client.post(endpoint, json=payload)
            response.raise_for_status()
            result = response.json()
            
            images = result.get("images", [])
            return {
                "query": query,
                "images": images,
                "count": len(images),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "model_used": f"{chat_model['providerId']}/{chat_model['key']}"
            }
    except Exception as e:
        logger.error("Perplexica image search failed: %s", e)
        return {"error": str(e), "query": query, "images": []}

async def video_search(query: str, history: Optional[List[Any]] = None, **kwargs) -> Dict[str, Any]:
    """Video search convenience wrapper (Perplexica /api/videos)."""
    settings = get_settings()
    base_url = kwargs.pop("base_url", None) or settings.integrations.perplexica_url
    endpoint = f"{base_url.rstrip('/')}/api/videos"
    
    client = PerplexicaClient(base_url=base_url)
    chat_model, _ = client._get_model_config()
    
    payload = {
        "query": query,
        "chatHistory": history or [],
        "chatModel": chat_model
    }
    
    try:
        timeout = getattr(settings.http_client, "external_service_timeout", 600.0)
        async with httpx.AsyncClient(timeout=timeout) as http_client:
            response = await http_client.post(endpoint, json=payload)
            response.raise_for_status()
            result = response.json()
            
            videos = result.get("videos", [])
            return {
                "query": query,
                "videos": videos,
                "count": len(videos),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "model_used": f"{chat_model['providerId']}/{chat_model['key']}"
            }
    except Exception as e:
        logger.error("Perplexica video search failed: %s", e)
        return {"error": str(e), "query": query, "videos": []}

async def suggestions(history: List[Any], **kwargs) -> Dict[str, Any]:
    """Generate follow-up suggestions from chat history (Perplexica /api/suggestions)."""
    settings = get_settings()
    base_url = kwargs.pop("base_url", None) or settings.integrations.perplexica_url
    endpoint = f"{base_url.rstrip('/')}/api/suggestions"
    
    client = PerplexicaClient(base_url=base_url)
    chat_model, _ = client._get_model_config()
    
    payload = {
        "chatHistory": history or [],
        "chatModel": chat_model
    }
    
    try:
        timeout = getattr(settings.http_client, "external_service_timeout", 600.0)
        async with httpx.AsyncClient(timeout=timeout) as http_client:
            response = await http_client.post(endpoint, json=payload)
            response.raise_for_status()
            result = response.json()
            
            suggestions_list = result.get("suggestions", [])
            return {
                "suggestions": suggestions_list,
                "count": len(suggestions_list),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "model_used": f"{chat_model['providerId']}/{chat_model['key']}"
            }
    except Exception as e:
        logger.error("Perplexica suggestions failed: %s", e)
        # Instead of failing the entire chain if Perplexica returns 500 (often due to generateObject JSON parsing failing on local LLMs), 
        # return empty suggestions gracefully.
        return {"suggestions": []}

async def discover_news(topic: str = "tech", mode: str = "normal", **kwargs) -> Dict[str, Any]:
    """Discover curated news by topic (Perplexica /api/discover)."""
    settings = get_settings()
    base_url = kwargs.pop("base_url", None) or settings.integrations.perplexica_url
    endpoint = f"{base_url.rstrip('/')}/api/discover"
    
    valid_topics = ["tech", "finance", "art", "sports", "entertainment"]
    if topic not in valid_topics:
        topic = "tech"
    
    valid_modes = ["normal", "preview"]
    if mode not in valid_modes:
        mode = "normal"
    
    try:
        timeout = getattr(settings.http_client, "external_service_timeout", 600.0)
        async with httpx.AsyncClient(timeout=timeout) as http_client:
            response = await http_client.get(
                endpoint,
                params={"topic": topic, "mode": mode}
            )
            response.raise_for_status()
            result = response.json()
            
            blogs = result.get("blogs", [])
            return {
                "topic": topic,
                "mode": mode,
                "articles": blogs,
                "count": len(blogs),
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
    except Exception as e:
        logger.error("Perplexica discover failed: %s", e)
        return {"error": str(e), "articles": []}

# ==============================================================================
# Legal Search Configuration
# ==============================================================================

LEGAL_DATABASES = {
    "uk": {
        "bailii": {
            "name": "BAILII (UK)",
            "url": "bailii.org",
            "jurisdictions": ["england", "wales", "scotland", "northern_ireland", "uk"],
            "types": ["cases", "legislation"],
            "description": "British and Irish Legal Information Institute"
        }
    },
    "us": {
        "courtlistener": {
            "name": "CourtListener (US)",
            "url": "courtlistener.com",
            "jurisdictions": ["federal", "state", "us"],
            "types": ["cases", "opinions", "dockets"],
            "description": "Free Law Project - US Courts"
        },
        "justia": {
            "name": "Justia (US)",
            "url": "law.justia.com",
            "jurisdictions": ["federal", "state", "us"],
            "types": ["cases", "codes", "regulations"],
            "description": "Free US Legal Resources"
        }
    },
    "commonwealth": {
        "austlii": {
            "name": "AustLII",
            "url": "austlii.edu.au",
            "jurisdictions": ["australia"],
            "types": ["cases", "legislation"],
            "description": "Australasian Legal Information Institute"
        },
        "canlii": {
            "name": "CanLII",
            "url": "canlii.org",
            "jurisdictions": ["canada"],
            "types": ["cases", "legislation"],
            "description": "Canadian Legal Information Institute"
        },
        "nzlii": {
            "name": "NZLII",
            "url": "nzlii.org",
            "jurisdictions": ["new_zealand"],
            "types": ["cases", "legislation"],
            "description": "New Zealand Legal Information Institute"
        },
        "commonlii": {
            "name": "CommonLII",
            "url": "commonlii.org",
            "jurisdictions": ["commonwealth"],
            "types": ["cases", "legislation"],
            "description": "Commonwealth Legal Information Institute"
        }
    },
    "eu": {
        "eur_lex": {
            "name": "EUR-Lex",
            "url": "eur-lex.europa.eu",
            "jurisdictions": ["eu", "european_union"],
            "types": ["cases", "legislation", "treaties"],
            "description": "European Union Law"
        }
    },
    "international": {
        "icj": {
            "name": "ICJ",
            "url": "icj-cij.org",
            "jurisdictions": ["international"],
            "types": ["cases", "opinions"],
            "description": "International Court of Justice"
        },
        "worldlii": {
            "name": "WorldLII",
            "url": "worldlii.org",
            "jurisdictions": ["international"],
            "types": ["cases", "treaties"],
            "description": "World Legal Information Institute"
        }
    }
}

def get_legal_databases_for_jurisdiction(jurisdiction: str) -> List[Dict[str, Any]]:
    """Get applicable legal databases for a jurisdiction."""
    databases = []
    jurisdiction_lower = jurisdiction.lower().replace(" ", "_")
    
    for region, dbs in LEGAL_DATABASES.items():
        for db_key, db_info in dbs.items():
            if jurisdiction_lower in db_info["jurisdictions"] or jurisdiction_lower == "all":
                databases.append({
                    "key": db_key,
                    "region": region,
                    **db_info
                })
    
    return databases

async def legal_search(
    query: str,
    jurisdiction: str = "all",
    document_type: str = "cases",
    **kwargs
) -> Dict[str, Any]:
    """
    Legal database search across multiple jurisdictions.
    
    Args:
        query: Search query (case name, citation, keywords)
        jurisdiction: 'uk', 'us', 'commonwealth', 'eu', 'international', 'all'
        document_type: 'cases', 'legislation', 'statutes', 'regulations', 'treaties'
        **kwargs: Additional search parameters
    
    Returns:
        Dict with legal search results from applicable databases
    """
    settings = get_settings()
    
    # Get applicable databases
    databases = get_legal_databases_for_jurisdiction(jurisdiction)
    
    if not databases:
        return {
            "error": f"No databases found for jurisdiction: {jurisdiction}",
            "query": query,
            "results": []
        }
    
    # Build site-restricted search query
    sites = [db["url"] for db in databases]
    site_query = " OR ".join([f"site:{site}" for site in sites])
    full_query = f"({site_query}) {query}"
    
    # Add document type filters
    if document_type == "cases":
        full_query += " (case OR judgment OR opinion OR decision)"
    elif document_type in ["legislation", "statutes"]:
        full_query += " (act OR statute OR code OR legislation)"
    elif document_type == "regulations":
        full_query += " (regulation OR rule OR order)"
    elif document_type == "treaties":
        full_query += " (treaty OR convention OR agreement)"
    
    # Use SearXNG for search (respects terms of service)
    try:
        searxng_url = settings.integrations.searxng_url
        if not searxng_url:
            return {"error": "SearXNG not configured", "query": query, "results": []}
        
        timeout = getattr(settings.http_client, "external_service_timeout", 60.0)
        
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(
                f"{searxng_url}/search",
                params={
                    "q": full_query,
                    "format": "json",
                    "engines": "google,duckduckgo,brave",
                    "safesearch": "0"
                }
            )
            response.raise_for_status()
            data = response.json()
            
            results = data.get("results", [])
            
            # Enrich results with database metadata
            enriched_results = []
            for result in results:
                url = result.get("url", "")
                # Find matching database
                db_info = None
                for db in databases:
                    if db["url"] in url:
                        db_info = db
                        break
                
                enriched_results.append({
                    **result,
                    "database": db_info["name"] if db_info else "Unknown",
                    "jurisdiction": db_info["region"] if db_info else "unknown",
                    "database_url": db_info["url"] if db_info else ""
                })
            
            return {
                "query": query,
                "jurisdiction": jurisdiction,
                "document_type": document_type,
                "databases_searched": [db["name"] for db in databases],
                "results": enriched_results,
                "count": len(enriched_results),
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            
    except Exception as e:
        logger.error("Legal search failed: %s", e)
        return {
            "error": str(e),
            "query": query,
            "jurisdiction": jurisdiction,
            "results": []
        }

def perplexica_models() -> Dict[str, Any]:
    """Returns current model configuration info."""
    settings = get_settings()
    return {
        "chat_model": settings.llm.model,
        "embedding_model": settings.llm.embedding_model,
        "perplexica_url": settings.integrations.perplexica_url
    }

def show_current_model() -> str:
    """Returns a string description of current models."""
    info = perplexica_models()
    return f"Chat: {info['chat_model']} | Embedding: {info['embedding_model']}"
