"""
Tool Service

Provides search and catalog functionality for available tools.
"""
import time
import re
import math
import httpx
from typing import Any, Dict, List, Optional, Tuple

from config.settings import Settings
from core.integrations.framework.oi_catalog import OIToolCatalogBridge
from monitoring import get_logger

logger = get_logger(__name__)

def _cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    if not vec1 or not vec2:
        return 0.0
    dot = sum(a * b for a, b in zip(vec1, vec2))
    mag1 = math.sqrt(sum(a * a for a in vec1))
    mag2 = math.sqrt(sum(b * b for b in vec2))
    if mag1 == 0 or mag2 == 0:
        return 0.0
    return dot / (mag1 * mag2)

class ToolService:
    def __init__(self, settings: Settings, app: Any):
        self.settings = settings
        self.app = app
        self._tool_cache: Optional[Dict[str, Dict[str, Any]]] = None
        self._tool_cache_at: float = 0.0
        self._tool_cache_ttl_seconds: float = 15.0
        self._tool_embeddings_cache: Dict[str, List[float]] = {}
        self._is_initialized: bool = True
        self._is_disposed: bool = False

    def dispose(self) -> None:
        if self._is_disposed:
            return
        self._tool_cache = None
        self._tool_cache_at = 0.0
        self._tool_embeddings_cache = {}
        self._is_initialized = False
        self._is_disposed = True

    def invalidate_cache(self) -> None:
        """Invalidate tool cache (e.g., on startup, profile switch, or manual refresh)."""
        self._tool_cache = None
        self._tool_cache_at = 0.0
        self._tool_embeddings_cache = {}
        logger.info("Tool cache invalidated")

    async def _generate_embedding(self, text: str) -> List[float]:
        """Generate embedding for semantic tool matching using configured embedding service."""
        try:
            url = self.settings.embedding_service.service_url
            model = self.settings.embedding_service.model
            timeout = self.settings.http_client.embedding_timeout
            
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    url,
                    json={
                        "input": text,
                        "model": model,
                    }
                )
                response.raise_for_status()
                data = response.json()
                return data['data'][0]['embedding']
        except Exception as e:
            logger.error("Error generating embedding for tool search: %s", e)
            return []

    async def _get_tools(self) -> Dict[str, Dict[str, Any]]:
        now = time.time()
        if self._tool_cache is not None and (now - self._tool_cache_at) <= self._tool_cache_ttl_seconds:
            return self._tool_cache

        bridge = OIToolCatalogBridge(self.app, self.settings)
        tools = bridge.generate_tools_from_openapi()

        # Add active MCP tools
        try:
            from core.mcp.context import get_mcp_manager
            mcp_manager = get_mcp_manager()
            if mcp_manager:
                servers = await mcp_manager.list_servers()
                for srv in servers:
                    if not srv.get("enabled", True) or srv.get("status") != "active":
                        continue
                    
                    try:
                        srv_id = str(srv["id"])
                        srv_tools = await mcp_manager.get_server_tools(srv_id, refresh=False)
                        for t in srv_tools:
                            func = t.get("function", {})
                            name = func.get("name")
                            if not name:
                                continue
                            
                            # Clean up redundant 'mcp' strings for a professional tool name
                            clean_srv = re.sub(r'_mcp$|^mcp_', '', srv['name'])
                            clean_name = re.sub(r'^mcp_|_mcp$', '', name)
                            
                            # Construct unified tool name without duplicating prefix
                            if clean_name.startswith(f"{clean_srv}_"):
                                tool_name = clean_name
                            else:
                                tool_name = f"{clean_srv}_{clean_name}"
                            
                            # Extract parameters safely
                            parameters = []
                            props = func.get("parameters", {}).get("properties", {})
                            req = func.get("parameters", {}).get("required", [])
                            for p_name, p_info in props.items():
                                parameters.append({
                                    "name": p_name,
                                    "type": p_info.get("type", "any"),
                                    "description": p_info.get("description", ""),
                                    "required": p_name in req,
                                })
                                
                            tool_def = {
                                "name": tool_name,
                                "path": f"/v1/mcp/servers/by-name/{srv['name']}/tools/{name}",
                                "method": "POST",
                                "category": "MCP Servers",
                                "description": func.get("description", f"MCP tool {name} from {srv['name']}"),
                                "parameters": parameters,
                                "is_mcp_tool": True,
                            }
                            tools.append(tool_def)
                    except Exception as e:
                        logger.error(f"Failed to load tools for MCP server {srv['name']}: {e}")
        except Exception as e:
            logger.error(f"Failed to query MCP servers: {e}")

        # Index by tool name for fast lookup.
        out: Dict[str, Dict[str, Any]] = {}
        for t in tools:
            name = t.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            out[name.strip()] = t

        self._tool_cache = out
        self._tool_cache_at = now
        return out

    async def _ensure_tool_embeddings(self, tools: Dict[str, Dict[str, Any]]):
        missing = []
        for name, meta in tools.items():
            if name not in self._tool_embeddings_cache:
                desc = str(meta.get("description") or "")
                cat = str(meta.get("category") or "")
                text = f"Tool: {name}. Category: {cat}. Description: {desc}"
                missing.append((name, text))
        
        if not missing:
            return
            
        try:
            url = self.settings.embedding_service.service_url
            model = self.settings.embedding_service.model
            timeout = self.settings.http_client.embedding_timeout
            
            # Send batch to embedding endpoint
            texts = [m[1] for m in missing]
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    url,
                    json={
                        "input": texts,
                        "model": model,
                    }
                )
                response.raise_for_status()
                data = response.json()
                
                # Cache the results
                for i, item in enumerate(data.get('data', [])):
                    self._tool_embeddings_cache[missing[i][0]] = item['embedding']
        except Exception as e:
            logger.error("Failed to generate batch embeddings for tools: %s", e)

    async def search_tools(self, q: str) -> List[Dict[str, Any]]:
        query = (q or "").strip()
        if not query:
            raise ValueError("q is required")

        tools = await self._get_tools()
        await self._ensure_tool_embeddings(tools)
        
        query_emb = await self._generate_embedding(query)
        
        # Clean tokenize for keyword scoring
        query_tokens = set(re.findall(r'\w+', query.lower()))
        wants_inventory = any(t in {"available", "list", "tools", "tool", "categories"} for t in query_tokens) or "available tools" in query.lower()

        scored: List[Tuple[float, str, Dict[str, Any]]] = []
        for name, meta in tools.items():
            desc = str(meta.get("description") or "")
            cat = str(meta.get("category") or "")
            
            # Semantic Score (Cosine Similarity)
            tool_emb = self._tool_embeddings_cache.get(name)
            semantic_score = 0.0
            if query_emb and tool_emb:
                semantic_score = _cosine_similarity(query_emb, tool_emb)
                
            # Keyword Score (Jaccard-like overlap)
            tool_text = f"{name} {cat} {desc}".lower()
            tool_tokens = set(re.findall(r'\w+', tool_text))
            
            overlap = len(query_tokens.intersection(tool_tokens))
            keyword_score = overlap / max(len(query_tokens), 1)
            
            # Hybrid Score formula: Semantic is heavily weighted, keyword helps with exact names
            hybrid_score = (max(0.0, semantic_score) * 0.8) + (keyword_score * 0.2)
            
            # Absolute exact match boost for tool names (e.g. if user types exactly 'whatsapp_read_chat')
            if any(qt == name.lower() for qt in query_tokens):
                hybrid_score += 0.5
                
            if hybrid_score > 0.3:
                tool_dict = {
                    "tool": f"computer.{name}",
                    "name": name,
                    "category": cat or "Other",
                    "description": desc,
                    "parameters": meta.get("parameters"),
                    "path": meta.get("path"),
                    "method": meta.get("method"),
                }
                if meta.get("is_mcp_tool"):
                    tool_dict["is_mcp_tool"] = True
                    
                scored.append((hybrid_score, name, tool_dict))

        scored.sort(key=lambda x: (-x[0], x[1]))
        
        # Limit hits. To avoid flooding the LLM context, we only return the top 5 most relevant tools.
        hits = [row for _, _, row in scored[:5]]

        # Helpful fallback: if the user asks for "available tools", return a small inventory
        if not hits and wants_inventory:
            cats = await self.list_categories()
            sample: List[Dict[str, Any]] = [{"type": "info", "categories": cats}]
            for c in cats[:10]:
                picks = []
                for n, m in tools.items():
                    if str(m.get("category") or "").strip().lower() != str(c).strip().lower():
                        continue
                    picks.append(f"computer.{n}")
                    if len(picks) >= 5:
                        break
                sample.append({"type": "category", "category": c, "tools": picks})
            return sample

        return hits

    async def list_categories(self) -> List[str]:
        tools = await self._get_tools()
        cats = sorted(
            {
                str(meta.get("category") or "Other").strip()
                for meta in tools.values()
                if isinstance(meta, dict)
            }
        )
        return [c for c in cats if c]
