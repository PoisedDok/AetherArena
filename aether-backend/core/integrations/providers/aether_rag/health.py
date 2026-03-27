"""
@.architecture
Incoming: core/integrations/providers/aether_rag/mcp_client.py, core/mcp/manager.MCPServerManager --- {str server_name, Dict settings}
Processing: aether_rag_health(), validate MCP server registration, check tool availability --- {3 jobs: JOB_HEALTH_CHECK, JOB_ROUTE, JOB_VALIDATE_SCHEMA}
Outgoing: api/v1/endpoints/datastore.py --- {Dict[str, Any] health status}
"""

import logging
from typing import Any, Dict, List
from uuid import UUID

from core.mcp.context import get_mcp_manager

logger = logging.getLogger(__name__)


async def aether_rag_health(server_name: str = "file_indexing_mcp") -> Dict[str, Any]:
    """
    Comprehensive AETHER-RAG MCP health check.
    
    Validates:
    - MCP manager availability
    - AETHER-RAG MCP server registration
    - Server connection status
    - Tool availability
    - Tool execution capability
    
    Returns:
        Dict with:
            - healthy: bool (overall health status)
            - status: str (active, degraded, error)
            - server_registered: bool
            - server_connected: bool
            - tools_count: int
            - tools_available: list[str]
            - test_search_ok: bool (if search tool is available and executable)
            - error: str (if failed)
            - degradation_reason: str (if degraded)
    """
    result: Dict[str, Any] = {
        "healthy": False,
        "status": "error",
        "server_registered": False,
        "server_connected": False,
        "tools_count": 0,
        "tools_available": [],
        "test_search_ok": False,
    }
    
    try:
        manager = get_mcp_manager()
        if manager is None:
            result["error"] = "MCP manager not initialized"
            return result
        
        server = await manager.get_server(server_name)
        if not server:
            result["error"] = f"AETHER-RAG MCP server '{server_name}' not registered"
            return result
        
        result["server_registered"] = True
        server_id = server.get("id")
        
        # Check if server is connected/running
        server_status = server.get("status", "unknown")
        result["server_status"] = server_status
        
        if server_status in ("running", "connected", "ready", "active"):
            result["server_connected"] = True
        else:
            result["degradation_reason"] = f"Server status: {server_status}"
        
        try:
            tools: List[Dict[str, Any]] = []
            if server_id:
                tools = await manager.get_server_tools(UUID(str(server_id)), refresh=True)
            result["tools_count"] = len(tools)
            result["tools_available"] = [
                tool.get("function", {}).get("name", "unknown") for tool in tools
            ]
            
            has_search = any(
                tool.get("function", {}).get("name") == "aether_rag_search" for tool in tools
            )
            
            if not has_search:
                result["degradation_reason"] = "Search tool not available"
                result["status"] = "degraded"
                result["healthy"] = True
            elif result["server_connected"] and server_id:
                try:
                    exec_result = await manager.execute_tool(
                        UUID(str(server_id)),
                        "aether_rag_search",
                        {"query": "test", "top_k": 1}
                    )
                    result["test_search_ok"] = bool(exec_result.get("success"))
                    if exec_result.get("success"):
                        result["status"] = "active"
                        result["healthy"] = True
                    else:
                        result["status"] = "degraded"
                        result["degradation_reason"] = exec_result.get("error", "Unknown error")
                        result["healthy"] = True
                except Exception as test_exc:
                    logger.warning("AETHER-RAG test search failed: %s", test_exc)
                    result["test_search_ok"] = False
                    result["degradation_reason"] = f"Search execution failed: {test_exc}"
                    result["status"] = "degraded"
                    result["healthy"] = True
            else:
                result["status"] = "degraded"
                result["healthy"] = True
        except Exception as tools_exc:
            logger.warning("AETHER-RAG tools listing failed: %s", tools_exc)
            result["degradation_reason"] = f"Tools listing failed: {tools_exc}"
            result["status"] = "degraded"
            result["healthy"] = True
        
    except Exception as exc:
        result["error"] = str(exc)
        result["error_type"] = type(exc).__name__
        logger.error("AETHER-RAG health check error: %s", exc, exc_info=True)
    
    return result

