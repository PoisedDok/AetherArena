"""
Tool Runner Endpoints (INTERNAL)

Why this exists:
- Open Interpreter's Python execution uses a Jupyter kernel process (`JupyterLanguage`).
- That kernel cannot access in-process Python objects like `interpreter.computer` (different process).
- Users (and agents) reasonably expect `computer.tools.*` to work inside Python cells.

Solution:
- Provide a local-only HTTP "tool runner" surface that exposes tool discovery + execution.
- The external OI server wrapper injects a lightweight `computer` proxy into the Jupyter kernel
  that calls these endpoints, so Python code can do:
    - computer.tools.search("...")  (tool discovery)
    - computer.<tool_name>(...)     (tool execution)

Security/Architecture:
- This is INTERNAL plumbing, not a user-facing public API surface.
- It should NOT be exported back into the OI tool catalog (avoid recursion).

@.architecture
Incoming: External OI kernel proxy, internal toolrunner client --- {ToolRunnerExecute, ToolRunnerList, tool_name}
Processing: validate_tool_request(), dispatch_tool_call(), sanitize payloads --- {5 jobs: JOB_VALIDATE_SCHEMA, JOB_ROUTE, JOB_TRANSFORM_DATA, JOB_SERIALIZE, JOB_ENFORCE_SECURITY}
Outgoing: core tool registry + tool results --- {JSONResponse, tool_result}
"""

from __future__ import annotations
from core.exceptions import DomainException

import re
from typing import Any, Dict, List

from data.network.service_gateway import InternalServiceGateway, get_service_gateway
from core.exceptions import NetworkTimeoutError, UpstreamServiceError, NetworkConnectionError
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel, Field

from config.settings import get_settings
from api.dependencies import get_tool_service
from monitoring import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/toolrunner", tags=["toolrunner"])
action_router = APIRouter(prefix="/execute", tags=["execute"])


class ToolRunnerRunRequest(BaseModel):
    tool: str = Field(..., description="Tool name or path (e.g., 'perplexica_search' or 'computer.perplexica_search')")
    positional: List[Any] = Field(default_factory=list, description="Positional args (JSON list)")
    kwargs: Dict[str, Any] = Field(default_factory=dict, description="Keyword args (JSON object)")


def _normalize_tool_name(tool: str) -> str:
    name = (tool or "").strip()
    if name.startswith("computer."):
        name = name[len("computer.") :]
    if not name:
        raise ValueError("tool is required")
    return name


@router.get(
    "/health",
    summary="Tool runner health check",
    description="Simple liveness probe for the tool runner subsystem.",
)
async def toolrunner_health() -> Dict[str, Any]:
    """Return tool runner health status."""
    return {"status": "ok"}


@router.get(
    "/search",
    summary="Search available tools",
    description="Fuzzy-match tool names and descriptions against a query string. "
                "Returns scored results with category and parameter metadata.",
)
async def search_tools(
    q: str,
    tool_service = Depends(get_tool_service)
) -> List[Dict[str, Any]]:
    """Search registered backend tools by keyword relevance."""
    try:
        results = await tool_service.search_tools(q)
        clean_results = []
        # Hard-cap at 4 to guarantee context safety regardless of underlying service logic
        for r in results[:4]:
            clean_results.append({
                "tool": r.get("tool"),
                "description": r.get("description"),
                "parameters": r.get("parameters")
            })
        return clean_results
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get(
    "/list-categories",
    summary="List tool categories",
    description="Returns a sorted list of unique category names from the tool registry.",
)
async def list_categories(tool_service = Depends(get_tool_service)) -> List[str]:
    """List all unique tool categories."""
    return await tool_service.list_categories()


@router.get(
    "/list-tools",
    summary="List tools in a category",
    description="Returns tool names (as computer.tool_name) filtered by the given category.",
)
async def list_tools(
    category: str,
    tool_service = Depends(get_tool_service)
) -> List[str]:
    """List tools belonging to a specific category."""
    cat = (category or "").strip().lower()
    if not cat:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="category is required")

    tools = await tool_service._get_tools()
    out = []
    for name, meta in tools.items():
        mcat = str(meta.get("category") or "").strip().lower()
        if mcat == cat:
            out.append(f"computer.{name}")
    return sorted(out)


@router.get(
    "/info",
    summary="Get tool info",
    description="Returns full metadata for a single tool including parameters.",
)
async def get_tool_info(
    tool: str,
    tool_service = Depends(get_tool_service)
) -> Dict[str, Any]:
    """Get detailed information about a specific tool."""
    name = _normalize_tool_name(tool)
    tools = await tool_service._get_tools()
    meta = tools.get(name)
    if not meta:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Tool {name} not found")
    
    return {
        "tool": f"computer.{name}",
        "name": name,
        "category": meta.get("category") or "Other",
        "description": meta.get("description"),
        "parameters": meta.get("parameters"),
    }


@action_router.post("/tool")
async def run_tool(
    payload: ToolRunnerRunRequest,
    gateway: InternalServiceGateway = Depends(get_service_gateway),
    tool_service = Depends(get_tool_service)
) -> Any:
    """
    Execute a backend tool by name, using the same OpenAPI-derived metadata the agent uses.

    NOTE: This executes via HTTP against this backend instance (end-to-end wiring check).
    """
    try:
        tool_name = _normalize_tool_name(payload.tool)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    tools = await tool_service._get_tools()
    meta = tools.get(tool_name)
    if not meta:
        # Auto-search fallback for missing tools
        hits = await tool_service.search_tools(tool_name)
        # hits structure: [(score, name, tool_dict), ...] or list of dicts (inventory fallback)
        suggestions = ""
        if hits and isinstance(hits, list) and len(hits) > 0:
            if isinstance(hits[0], tuple):
                suggestions = ", ".join([h[1] for h in hits[:3]])
            elif isinstance(hits[0], dict) and "name" in hits[0]:
                suggestions = ", ".join([h["name"] for h in hits[:3]])
        
        msg = f"Unknown tool '{tool_name}'. Tool execution failed."
        if suggestions:
            msg += f" Did you mean: {suggestions}? Hint: Use computer.search_tools(q='your intent') to find correct tools before trying again."
        else:
            msg += " Hint: Use computer.search_tools(q='your intent') to find correct tools."
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=msg)

    path = meta.get("path")
    method = str(meta.get("method") or "").upper()
    if not isinstance(path, str) or not path.startswith("/"):
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Tool metadata missing path")
    if not method:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Tool metadata missing method")

    # Prevent recursion: toolrunner must not invoke itself.
    if path.startswith("/v1/toolrunner"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Refusing to execute toolrunner endpoint via toolrunner (recursion)",
        )

    settings = get_settings()
    base_url = str(getattr(settings, "base_url", "")).rstrip("/")
    if not base_url:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="settings.base_url is required")

    # Substitute path parameters from kwargs into the URL template.
    # Extract path params (e.g., {job_id}, {agent_name}) from the path template.
    path_params = re.findall(r'\{([^}]+)\}', path)
    
    # Clone kwargs to avoid mutating the original
    remaining_kwargs = dict(payload.kwargs)
    url_path = path
    
    for param_name in path_params:
        param_value = remaining_kwargs.pop(param_name, None)
        if param_value is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Missing required path parameter: {param_name}",
            )
        # Substitute the parameter in the URL path
        url_path = url_path.replace(f"{{{param_name}}}", str(param_value))
    
    url = f"{base_url}{url_path}"
    # Use a dedicated ToolRunner timeout (internal orchestration can be long-running, e.g. /v1/research).
    # Fall back to external_service_timeout if toolrunner_timeout isn't configured.
    tool_timeout = getattr(settings.http_client, "toolrunner_timeout", None)
    timeout = float(tool_timeout) if tool_timeout is not None else float(getattr(settings.http_client, "external_service_timeout", 180.0))

    # NOTE: Positional arguments are handled via path parameter substitution above.
    # Any remaining positional arguments are ignored for OpenAPI-derived tools
    # as they don't have a stable mapping to HTTP request bodies/query params.
    if payload.positional and not path_params:
        logger.warning(
            "Tool %s called with %d positional args but no path parameters found. "
            "Positional args will be ignored.", 
            tool_name, len(payload.positional)
        )

    try:
        # Wrap payload for MCP tools which expect an ExecuteToolRequest schema
        if meta.get("is_mcp_tool"):
            remaining_kwargs = {"arguments": remaining_kwargs}
            
        if method == "GET":
            resp = await gateway.execute_request("GET", url, timeout=timeout, params=remaining_kwargs)
        elif method == "DELETE":
            resp = await gateway.execute_request("DELETE", url, timeout=timeout, params=remaining_kwargs)
        elif method in {"POST", "PUT", "PATCH"}:
            if method == "POST":
                resp = await gateway.execute_request("POST", url, timeout=timeout, json_data=remaining_kwargs)
            elif method == "PUT":
                resp = await gateway.execute_request("PUT", url, timeout=timeout, json_data=remaining_kwargs)
            else:
                resp = await gateway.execute_request("PATCH", url, timeout=timeout, json_data=remaining_kwargs)
        else:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported method: {method}")

        try:
            if resp.status_code >= 400:
                msg = f"Tool '{tool_name}' execution failed: {resp.text[:500]}. Action Required: Use computer.search_tools(q='{tool_name}') to verify the correct parameters and available alternatives before proceeding."
                raise HTTPException(status_code=resp.status_code, detail=msg)
            return resp.json()
        except (HTTPException, DomainException):
            raise
        except Exception as e:
            logger.error("Failed to parse toolrunner response: %s", e, exc_info=True)
            return {"result": resp.text}
    except UpstreamServiceError as e:
        msg = f"Tool '{tool_name}' execution failed: {e.message[:500]}. Action Required: Use computer.search_tools(q='{tool_name}') to verify the correct parameters and available alternatives before proceeding."
        raise HTTPException(status_code=e.status_code, detail=msg)
    except NetworkTimeoutError as e:
        detail = str(e) + f" (timeout={timeout}s url={url}). Action Required: Use computer.search_tools(q='{tool_name}') to verify the correct parameters and available alternatives before proceeding."
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=detail) from e
    except NetworkConnectionError as e:
        detail = str(e) + f" (timeout={timeout}s url={url}). Action Required: Use computer.search_tools(q='{tool_name}') to verify the correct parameters and available alternatives before proceeding."
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail) from e
    except (HTTPException, DomainException):
        raise
    except Exception as exc:
        logger.error("Toolrunner execution failed: %s", exc, exc_info=True)
        detail = (str(exc) or repr(exc)) + f" (timeout={timeout}s url={url}). Action Required: Use computer.search_tools(q='{tool_name}') to verify the correct parameters and available alternatives before proceeding."
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=detail) from exc

