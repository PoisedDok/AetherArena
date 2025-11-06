"""
MCP (Model Context Protocol) Management Endpoints

Endpoints for managing MCP servers, tools, and execution.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP POST/GET/DELETE) --- {HTTP requests to /v1/api/mcp/*, RegisterServerRequest, ExecuteToolRequest JSON payloads}
Processing: register_server(), start_server(), list_servers(), get_server(), delete_server(), get_server_tools(), execute_tool(), check_server_health(), get_server_stats(), get_execution_history(), mcp_system_health() --- {14 jobs: data_validation, dependency_injection, error_handling, execution_logging, health_checking, http_communication, recording, sanitization, server_discovery, server_lifecycle, server_registration, statistics_collection, tool_discovery, tool_execution}
Outgoing: core/mcp/manager.py, Frontend (HTTP) --- {MCPServerManager method calls, ServerResponse, ToolResponse, ExecutionResponse, HealthResponse schemas}
"""

import time
import uuid
from typing import List, Optional, Dict, Any
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from fastapi.responses import JSONResponse

from api.dependencies import require_mcp_manager, setup_request_context
from api.v1.schemas.mcp import (
    RegisterServerRequest,
    ServerResponse,
    ToolResponse,
    ExecuteToolRequest,
    ExecutionResponse,
    HealthResponse,
    ServerStats,
    ServerConfig
)
from core.mcp.manager import MCPServerManager
from monitoring import get_logger, counter, histogram
from security.sanitization import sanitize_text, ValidationError
from pydantic import BaseModel, Field

logger = get_logger(__name__)
router = APIRouter(tags=["mcp"], prefix="/api/mcp")

# Metrics
mcp_requests = counter('aether_mcp_api_requests_total', 'Total MCP API requests', ['endpoint', 'status'])
mcp_execution_duration = histogram('aether_mcp_execution_duration_seconds', 'MCP execution duration', ['server', 'tool'])


class StartServerRequest(BaseModel):
    """Request to start MCP server."""
    name: str = Field(..., description="Server name", min_length=1, max_length=255)


def validate_server_id(server_id: str) -> str:
    """Validate server ID is UUID format."""
    server_id = server_id.strip()
    try:
        uuid.UUID(server_id)
        return server_id
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid server ID format (must be UUID)"
        )


def validate_server_name(server_name: str) -> str:
    """Validate and sanitize server name."""
    if not server_name or not server_name.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Server name cannot be empty"
        )
    
    server_name = sanitize_text(server_name.strip(), max_length=255, allow_html=False)
    
    if len(server_name) > 255:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Server name too long (max 255 characters)"
        )
    
    # Allow alphanumeric, hyphens, underscores, dots
    if not all(c.isalnum() or c in '-_.' for c in server_name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Server name contains invalid characters"
        )
    
    return server_name


def validate_tool_name(tool_name: str) -> str:
    """Validate and sanitize tool name."""
    if not tool_name or not tool_name.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tool name cannot be empty"
        )
    
    tool_name = sanitize_text(tool_name.strip(), max_length=255, allow_html=False)
    
    if len(tool_name) > 255:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tool name too long (max 255 characters)"
        )
    
    return tool_name


# =============================================================================
# Server Registration
# =============================================================================

@router.post(
    "/servers",
    response_model=ServerResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register new MCP server",
    description="Register and optionally start a new MCP server"
)
async def register_server(
    request: RegisterServerRequest,
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> ServerResponse:
    """
    Register new MCP server.
    
    Creates a new MCP server configuration and optionally starts it.
    Server types:
    - local: Subprocess-based server
    - remote: HTTP-based server
    """
    try:
        # Register server
        server_record = await manager.register_server(
            name=request.name,
            display_name=request.display_name or request.name,
            server_type=request.server_type,
            config=request.config.dict(exclude_none=True),
            description=request.description,
            auto_start=request.auto_start,
            enabled=request.enabled
        )
        
        mcp_requests.inc(endpoint='register_server', status='success')
        logger.info(f"Registered MCP server: {request.name}")
        
        return ServerResponse(
            server_id=str(server_record["id"]),
            name=server_record["name"],
            display_name=server_record["display_name"],
            description=server_record.get("description"),
            server_type=server_record["server_type"],
            status=server_record.get("status", "stopped"),
            config=ServerConfig(**server_record["config"]),
            auto_start=server_record.get("auto_start", False),
            enabled=server_record.get("enabled", True),
            created_at=server_record["created_at"],
            updated_at=server_record["updated_at"],
            last_health_check=server_record.get("last_health_check"),
            tools_count=server_record.get("tools_count", 0)
        )
        
    except ValueError as e:
        mcp_requests.inc(endpoint='register_server', status='error')
        logger.warning(f"Invalid server registration request: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid server configuration"
        )
    except Exception as e:
        mcp_requests.inc(endpoint='register_server', status='error')
        logger.error(f"Failed to register server: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server registration failed"
        )


# =============================================================================
# Start Server
# =============================================================================

@router.post(
    "/servers/start",
    summary="Start MCP server",
    description="Start a registered MCP server"
)
async def start_server(
    request: StartServerRequest,
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Start an MCP server.
    
    Can start by name or create and start new server.
    """
    try:
        # Validate server name
        server_name = validate_server_name(request.name)
        
        # Start server
        await manager.start_server(server_name)
        
        logger.info(f"Started MCP server: {server_name}")
        
        mcp_requests.inc(endpoint='start_server', status='success')
        
        return JSONResponse({
            "status": "ok",
            "message": f"Server {server_name} started",
            "server_name": server_name
        })
        
    except HTTPException:
        mcp_requests.inc(endpoint='start_server', status='error')
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='start_server', status='error')
        logger.error(f"Failed to start server: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to start server"
        )


# =============================================================================
# Server Listing
# =============================================================================

@router.get(
    "/servers",
    response_model=List[ServerResponse],
    summary="List all MCP servers",
    description="List all registered MCP servers with status"
)
async def list_servers(
    enabled_only: bool = Query(False, description="Only return enabled servers"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> List[ServerResponse]:
    """
    List all registered MCP servers.
    
    Returns runtime status and configuration for each server.
    """
    try:
        servers = await manager.list_servers()
        
        # Filter if needed
        if enabled_only:
            servers = [s for s in servers if s.get("enabled", True)]
        
        mcp_requests.inc(endpoint='list_servers', status='success')
        
        return [
            ServerResponse(
                server_id=str(server["id"]),
                name=server["name"],
                display_name=server["display_name"],
                description=server.get("description"),
                server_type=server["server_type"],
                status=server.get("status", "stopped"),
                config=ServerConfig(**server["config"]),
                auto_start=server.get("auto_start", False),
                enabled=server.get("enabled", True),
                created_at=server["created_at"],
                updated_at=server["updated_at"],
                last_health_check=server.get("last_health_check"),
                tools_count=server.get("tools_count", 0)
            )
            for server in servers
        ]
        
    except Exception as e:
        mcp_requests.inc(endpoint='list_servers', status='error')
        logger.error(f"Failed to list servers: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list servers"
        )


# =============================================================================
# Get Server Details
# =============================================================================

@router.get(
    "/servers/{server_id}",
    response_model=ServerResponse,
    summary="Get server details",
    description="Get detailed information about a specific server"
)
async def get_server(
    server_id: str = Path(..., description="Server UUID"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> ServerResponse:
    """
    Get server details.
    
    Returns complete server configuration and runtime status.
    """
    try:
        # Validate server ID
        server_id = validate_server_id(server_id)
        
        server = await manager.get_server(server_id)
        
        if not server:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Server '{server_id}' not found"
            )
        
        mcp_requests.inc(endpoint='get_server', status='success')
        
        return ServerResponse(
            server_id=str(server["id"]),
            name=server["name"],
            display_name=server["display_name"],
            description=server.get("description"),
            server_type=server["server_type"],
            status=server.get("status", "stopped"),
            config=ServerConfig(**server["config"]),
            auto_start=server.get("auto_start", False),
            enabled=server.get("enabled", True),
            created_at=server["created_at"],
            updated_at=server["updated_at"],
            last_health_check=server.get("last_health_check"),
            tools_count=server.get("tools_count", 0)
        )
        
    except HTTPException:
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='get_server', status='error')
        logger.error(f"Failed to get server {server_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get server"
        )


# =============================================================================
# Delete Server
# =============================================================================

@router.delete(
    "/servers/{server_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete server",
    description="Delete an MCP server (stops it first if running)"
)
async def delete_server(
    server_id: str = Path(..., description="Server UUID"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
):
    """
    Delete MCP server.
    
    Stops the server if running, then removes it from database.
    """
    try:
        # Validate server ID
        server_id = validate_server_id(server_id)
        
        await manager.delete_server(server_id)
        
        mcp_requests.inc(endpoint='delete_server', status='success')
        logger.info(f"Deleted MCP server: {server_id}")
        
        return None
        
    except ValueError as e:
        mcp_requests.inc(endpoint='delete_server', status='error')
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Server not found"
        )
    except Exception as e:
        mcp_requests.inc(endpoint='delete_server', status='error')
        logger.error(f"Failed to delete server {server_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete server"
        )


# =============================================================================
# Server Tools
# =============================================================================

@router.get(
    "/servers/{server_id}/tools",
    response_model=List[ToolResponse],
    summary="Get server tools",
    description="List all tools provided by a server"
)
async def get_server_tools(
    server_id: str = Path(..., description="Server UUID"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> List[ToolResponse]:
    """
    Get server tools.
    
    Returns all tools provided by the server with their schemas.
    """
    try:
        # Validate server ID
        server_id = validate_server_id(server_id)
        
        tools = await manager.get_server_tools(server_id)
        
        mcp_requests.inc(endpoint='get_server_tools', status='success')
        
        return [
            ToolResponse(
                tool_name=tool["name"],
                display_name=tool.get("display_name"),
                description=tool.get("description"),
                schema=tool.get("schema", {}),
                server_id=server_id
            )
            for tool in tools
        ]
        
    except ValueError as e:
        mcp_requests.inc(endpoint='get_server_tools', status='error')
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Server not found"
        )
    except Exception as e:
        mcp_requests.inc(endpoint='get_server_tools', status='error')
        logger.error(f"Failed to get tools for {server_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get tools"
        )


# =============================================================================
# Get Server Tools by Name
# =============================================================================

@router.get(
    "/servers/{server_name}/tools",
    response_model=List[ToolResponse],
    summary="Get server tools by name",
    description="List all tools provided by a server (by name)"
)
async def get_server_tools_by_name(
    server_name: str = Path(..., description="Server name"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> List[ToolResponse]:
    """
    Get server tools by name.

    Returns all tools provided by the server with their schemas.
    """
    try:
        # Validate server name
        server_name = validate_server_name(server_name)
        
        tools = await manager.get_server_tools_by_name(server_name)

        mcp_requests.inc(endpoint='get_server_tools_by_name', status='success')

        return [
            ToolResponse(
                tool_name=tool["name"],
                display_name=tool.get("display_name"),
                description=tool.get("description"),
                schema=tool.get("schema", {}),
                server_id=server_name  # Use server name instead of UUID
            )
            for tool in tools
        ]

    except ValueError as e:
        mcp_requests.inc(endpoint='get_server_tools_by_name', status='error')
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Server not found"
        )
    except Exception as e:
        mcp_requests.inc(endpoint='get_server_tools_by_name', status='error')
        logger.error(f"Failed to get tools for {server_name}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get tools"
        )


# =============================================================================
# Execute Tool
# =============================================================================

@router.post(
    "/servers/{server_id}/tools/{tool_name}",
    response_model=ExecutionResponse,
    summary="Execute tool",
    description="Execute a specific tool on a server"
)
async def execute_tool(
    server_id: str = Path(..., description="Server UUID"),
    tool_name: str = Path(..., description="Tool name"),
    request: ExecuteToolRequest = ...,
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> ExecutionResponse:
    """
    Execute tool.
    
    Executes a tool on the specified server with given arguments.
    Includes timeout and monitoring.
    """
    # Validate inputs
    server_id = validate_server_id(server_id)
    tool_name = validate_tool_name(tool_name)
    
    execution_id = str(uuid.uuid4())
    start_time = time.time()
    
    try:
        # Execute tool
        result = await manager.execute_tool(
            server_id=server_id,
            tool_name=tool_name,
            arguments=request.arguments,
            timeout=request.timeout
        )
        
        duration_ms = (time.time() - start_time) * 1000
        
        mcp_requests.inc(endpoint='execute_tool', status='success')
        mcp_execution_duration.observe(duration_ms / 1000, server=server_id, tool=tool_name)
        
        logger.info(f"Executed tool {tool_name} on {server_id}: {duration_ms:.2f}ms")
        
        return ExecutionResponse(
            execution_id=execution_id,
            tool_name=tool_name,
            server_id=server_id,
            status="success",
            result=result,
            error=None,
            duration_ms=duration_ms,
            timestamp=datetime.utcnow()
        )
        
    except TimeoutError:
        duration_ms = (time.time() - start_time) * 1000
        mcp_requests.inc(endpoint='execute_tool', status='timeout')
        logger.warning(f"Tool execution timed out: {tool_name} on {server_id}")
        
        return ExecutionResponse(
            execution_id=execution_id,
            tool_name=tool_name,
            server_id=server_id,
            status="timeout",
            result=None,
            error="Execution timed out",
            duration_ms=duration_ms,
            timestamp=datetime.utcnow()
        )
        
    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        mcp_requests.inc(endpoint='execute_tool', status='error')
        logger.error(f"Tool execution failed: {tool_name} on {server_id}: {e}", exc_info=True)
        
        return ExecutionResponse(
            execution_id=execution_id,
            tool_name=tool_name,
            server_id=server_id,
            status="error",
            result=None,
            error=str(e),
            duration_ms=duration_ms,
            timestamp=datetime.utcnow()
        )


# =============================================================================
# Server Health Check
# =============================================================================

@router.get(
    "/servers/{server_id}/health",
    response_model=HealthResponse,
    summary="Check server health",
    description="Check if server is healthy and responsive"
)
async def check_server_health(
    server_id: str = Path(..., description="Server UUID"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> HealthResponse:
    """
    Check server health.
    
    Performs health check on server and returns status.
    """
    try:
        # Validate server ID
        server_id = validate_server_id(server_id)
        
        start_time = time.time()
        health = await manager.check_server_health(server_id)
        response_time_ms = (time.time() - start_time) * 1000
        
        mcp_requests.inc(endpoint='check_server_health', status='success')
        
        return HealthResponse(
            server_id=server_id,
            status=health.get("status", "unknown"),
            is_running=health.get("is_running", False),
            tools_available=health.get("tools_count", 0),
            last_check=datetime.utcnow(),
            response_time_ms=response_time_ms,
            error=health.get("error")
        )
        
    except Exception as e:
        mcp_requests.inc(endpoint='check_server_health', status='error')
        logger.error(f"Health check failed for {server_id}: {e}", exc_info=True)
        
        return HealthResponse(
            server_id=server_id,
            status="unhealthy",
            is_running=False,
            tools_available=0,
            last_check=datetime.utcnow(),
            error=str(e)
        )


# =============================================================================
# Server Statistics
# =============================================================================

@router.get(
    "/servers/{server_id}/stats",
    response_model=ServerStats,
    summary="Get server statistics",
    description="Get execution statistics for a server"
)
async def get_server_stats(
    server_id: str = Path(..., description="Server UUID"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> ServerStats:
    """
    Get server statistics.
    
    Returns execution statistics including:
    - Total executions
    - Success/failure counts
    - Average duration
    - Uptime
    """
    try:
        # Validate server ID
        server_id = validate_server_id(server_id)
        
        stats = await manager.get_server_stats(server_id)
        
        mcp_requests.inc(endpoint='get_server_stats', status='success')
        
        return ServerStats(
            server_id=server_id,
            total_executions=stats.get("total_executions", 0),
            successful_executions=stats.get("successful_executions", 0),
            failed_executions=stats.get("failed_executions", 0),
            average_duration_ms=stats.get("average_duration_ms", 0),
            uptime_seconds=stats.get("uptime_seconds", 0),
            last_execution=stats.get("last_execution")
        )
        
    except ValueError as e:
        mcp_requests.inc(endpoint='get_server_stats', status='error')
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Server not found"
        )
    except Exception as e:
        mcp_requests.inc(endpoint='get_server_stats', status='error')
        logger.error(f"Failed to get stats for {server_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get server stats"
        )


# =============================================================================
# Execution History
# =============================================================================

@router.get(
    "/executions",
    summary="Get execution history",
    description="Get recent tool execution history across all servers"
)
async def get_execution_history(
    server_id: Optional[str] = Query(None, description="Filter by server UUID"),
    limit: int = Query(50, ge=1, le=500, description="Maximum number of results"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
):
    """
    Get execution history.
    
    Returns recent tool executions with status and duration.
    Can be filtered by server.
    """
    try:
        # Validate server ID if provided
        if server_id is not None:
            server_id = validate_server_id(server_id)
        
        history = await manager.get_execution_history(
            server_id=server_id,
            limit=limit
        )
        
        mcp_requests.inc(endpoint='get_execution_history', status='success')
        
        return {
            "executions": history,
            "count": len(history)
        }
        
    except Exception as e:
        mcp_requests.inc(endpoint='get_execution_history', status='error')
        logger.error(f"Failed to get execution history: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get execution history"
        )


# =============================================================================
# System Health
# =============================================================================

@router.get(
    "/health",
    summary="MCP system health",
    description="Check overall MCP system health"
)
async def mcp_system_health(
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
):
    """
    MCP system health.
    
    Returns health status of MCP system including:
    - Manager status
    - Server counts
    - Overall health
    """
    try:
        servers = await manager.list_servers()
        enabled_servers = [s for s in servers if s.get("enabled", True)]
        running_servers = [s for s in servers if s.get("status") == "running"]
        
        return {
            "healthy": True,
            "manager_initialized": True,
            "total_servers": len(servers),
            "enabled_servers": len(enabled_servers),
            "running_servers": len(running_servers),
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"MCP health check failed: {e}", exc_info=True)
        return {
            "healthy": False,
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat()
        }

