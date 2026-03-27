"""
MCP (Model Context Protocol) Management Endpoints

Endpoints for managing MCP servers, tools, and execution.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP POST/GET/DELETE) --- {HTTP requests to /v1/api/mcp/*, RegisterServerRequest, ExecuteToolRequest JSON payloads}
Processing: register_server(), start_server(), list_servers(), get_server(), delete_server(), get_server_tools(), execute_tool(), check_server_health(), get_server_stats(), get_execution_history(), mcp_system_health() --- {JOB_ROUTE, JOB_SANITIZE}
Outgoing: core/mcp/manager.py, Frontend (HTTP) --- {MCPServerManager method calls, ServerResponse, ToolResponse, ExecutionResponse, HealthResponse schemas}
"""

import time
import uuid
from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from fastapi.responses import JSONResponse

from core.exceptions import DomainException
from api.dependencies import (
    require_mcp_manager,
    setup_request_context,
)
from api.v1.schemas.mcp import (
    RegisterServerRequest,
    UpdateServerRequest,
    ServerResponse,
    ToolResponse,
    ExecuteToolRequest,
    ExecutionResponse,
    HealthResponse,
    TestServerResponse,
    ServerStats,
    ServerConfig
)
from core.mcp.manager import MCPServerManager
from monitoring import get_logger, counter, histogram
from security.sanitization import sanitize_text
from pydantic import BaseModel, Field

logger = get_logger(__name__)
router = APIRouter(
    tags=["mcp"],
    prefix="/mcp",
)

# Metrics
mcp_requests = counter('aether_mcp_api_requests_total', 'Total MCP API requests', ['endpoint', 'status'])
mcp_execution_duration = histogram('aether_mcp_execution_duration_seconds', 'MCP execution duration', ['server', 'tool'])


class StartServerRequest(BaseModel):
    """Request to start MCP server."""
    name: str = Field(..., description="Server name", min_length=1, max_length=255)


class StopServerRequest(BaseModel):
    """Request to stop MCP server."""
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
    
    # sanitize_text raises SizeExceededError if input > max_length,
    # so no post-sanitization length check is needed.
    server_name = sanitize_text(server_name.strip(), max_length=255, allow_html=False)
    
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
    
    # sanitize_text raises SizeExceededError if input > max_length,
    # so no post-sanitization length check is needed.
    tool_name = sanitize_text(tool_name.strip(), max_length=255, allow_html=False)
    
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
            enabled=request.enabled,
            sandbox_enabled=request.sandbox_enabled,
            resource_limits=request.resource_limits,
        )
        
        mcp_requests.inc(endpoint='register_server', status='success')
        logger.info("Registered MCP server: %s", request.name)
        
        return ServerResponse(
            server_id=str(server_record["id"]),
            name=server_record["name"],
            display_name=server_record["display_name"],
            description=server_record.get("description"),
            server_type=server_record["server_type"],
            status=server_record.get("status", "stopped"),
            error_message=server_record.get("error_message"),
            config=ServerConfig(**server_record["config"]),
            auto_start=server_record.get("auto_start", False),
            enabled=server_record.get("enabled", True),
            sandbox_enabled=server_record.get("sandbox_enabled", True),
            resource_limits=server_record.get("resource_limits"),
            created_at=server_record["created_at"],
            updated_at=server_record["updated_at"],
            last_health_check=server_record.get("last_health_check"),
            tools_count=server_record.get("tools_count", 0)
        )
        
    except ValueError as e:
        mcp_requests.inc(endpoint='register_server', status='error')
        logger.warning("Invalid server registration request: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid server configuration"
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='register_server', status='error')
        logger.error("Failed to register server: %s", e, exc_info=True)
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
        
        # Start server by name
        await manager.start_server_by_name(server_name)
        
        logger.info("Started MCP server: %s", server_name)
        
        mcp_requests.inc(endpoint='start_server', status='success')
        
        return JSONResponse({
            "status": "ok",
            "message": f"Server {server_name} started",
            "server_name": server_name
        })
        
    except ValueError as e:
        mcp_requests.inc(endpoint='start_server', status='error')
        logger.warning("Invalid server name: %s", e)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="MCP server not found."
        )
    except RuntimeError as e:
        mcp_requests.inc(endpoint='start_server', status='error')
        logger.error("Runtime error starting server: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to start server. Check server logs for details."
        )
    except (HTTPException, DomainException):
        mcp_requests.inc(endpoint='start_server', status='error')
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='start_server', status='error')
        logger.error("Failed to start server: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to start server. Check server logs for details."
        )


# =============================================================================
# Stop Server
# =============================================================================

@router.post(
    "/servers/stop",
    summary="Stop MCP server",
    description="Stop a registered MCP server"
)
async def stop_server(
    request: StopServerRequest,
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Stop an MCP server by name.
    """
    try:
        server_name = validate_server_name(request.name)
        await manager.stop_server_by_name(server_name)
        
        logger.info("Stopped MCP server: %s", server_name)
        mcp_requests.inc(endpoint='stop_server', status='success')
        
        return JSONResponse({
            "status": "ok",
            "message": f"Server {server_name} stopped",
            "server_name": server_name
        })
        
    except ValueError as e:
        mcp_requests.inc(endpoint='stop_server', status='error')
        logger.warning("Invalid server name: %s", e)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="MCP server not found."
        )
    except RuntimeError as e:
        mcp_requests.inc(endpoint='stop_server', status='error')
        logger.error("Runtime error stopping server: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to stop server. Check server logs for details."
        )
    except (HTTPException, DomainException):
        mcp_requests.inc(endpoint='stop_server', status='error')
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='stop_server', status='error')
        logger.error("Failed to stop server: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to stop server. Check server logs for details."
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
                error_message=server.get("error_message"),
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
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='list_servers', status='error')
        logger.error("Failed to list servers: %s", e, exc_info=True)
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
            error_message=server.get("error_message"),
            config=ServerConfig(**server["config"]),
            auto_start=server.get("auto_start", False),
            enabled=server.get("enabled", True),
            sandbox_enabled=server.get("sandbox_enabled", True),
            resource_limits=server.get("resource_limits"),
            created_at=server["created_at"],
            updated_at=server["updated_at"],
            last_health_check=server.get("last_health_check"),
            tools_count=server.get("tools_count", 0)
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='get_server', status='error')
        logger.error("Failed to get server %s: %s", server_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get server"
        )


# =============================================================================
# Update Server
# =============================================================================

@router.put(
    "/servers/{server_id}",
    response_model=ServerResponse,
    summary="Update MCP server",
    description="Update server configuration. Server will be restarted if running."
)
async def update_server(
    update: UpdateServerRequest,
    server_id: str = Path(..., description="Server UUID"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> ServerResponse:
    """
    Update server configuration.
    
    If server is running, it will be stopped and restarted with new config.
    """
    try:
        # Validate server ID
        server_id = validate_server_id(server_id)
        
        # Update via manager (handles restart if needed)
        updated_server = await manager.update_server(
            server_id=server_id,
            display_name=update.display_name,
            description=update.description,
            config=update.config.dict(exclude_none=True) if update.config else None,
            auto_start=update.auto_start,
            enabled=update.enabled,
            sandbox_enabled=update.sandbox_enabled,
            resource_limits=update.resource_limits,
        )
        
        mcp_requests.inc(endpoint='update_server', status='success')
        logger.info("Updated MCP server: %s", server_id)
        
        return ServerResponse(
            server_id=str(updated_server["id"]),
            name=updated_server["name"],
            display_name=updated_server["display_name"],
            description=updated_server.get("description"),
            server_type=updated_server["server_type"],
            status=updated_server.get("status", "stopped"),
            error_message=updated_server.get("error_message"),
            config=ServerConfig(**updated_server["config"]),
            auto_start=updated_server.get("auto_start", False),
            enabled=updated_server.get("enabled", True),
            sandbox_enabled=updated_server.get("sandbox_enabled", True),
            resource_limits=updated_server.get("resource_limits"),
            created_at=updated_server["created_at"],
            updated_at=updated_server["updated_at"],
            last_health_check=updated_server.get("last_health_check"),
            tools_count=updated_server.get("tools_count", 0)
        )
        
    except ValueError as e:
        mcp_requests.inc(endpoint='update_server', status='error')
        logger.warning("MCP server not found for update: %s", e)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="MCP server not found."
        )
    except RuntimeError as e:
        mcp_requests.inc(endpoint='update_server', status='error')
        logger.error("Runtime error updating server %s: %s", server_id, e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to update server. Check server logs for details."
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='update_server', status='error')
        logger.error("Failed to update server %s: %s", server_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update server. Check server logs for details."
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
        logger.info("Deleted MCP server: %s", server_id)
        
        return None
        
    except ValueError:
        mcp_requests.inc(endpoint='delete_server', status='error')
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Server not found"
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='delete_server', status='error')
        logger.error("Failed to delete server %s: %s", server_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete server"
        )


# =============================================================================
# Test Server
# =============================================================================

@router.post(
    "/servers/{server_id}/test",
    response_model=TestServerResponse,
    summary="Test MCP server",
    description="Test server connectivity and discover tools without starting permanently"
)
async def test_server(
    server_id: str = Path(..., description="Server UUID"),
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> TestServerResponse:
    """
    Test MCP server connectivity and health.
    
    Creates a temporary connection to validate configuration and discover tools.
    """
    try:
        # Validate server ID
        server_id = validate_server_id(server_id)
        
        # Run diagnostic test (temporary connection)
        result = await manager.test_server(server_id)
        
        mcp_requests.inc(endpoint='test_server', status='success' if result["success"] else 'error')
        logger.info("Tested MCP server %s: %s", server_id, result['message'])
        
        return TestServerResponse(
            success=result["success"],
            message=result["message"],
            diagnostics=result.get("diagnostics", {})
        )
        
    except ValueError:
        mcp_requests.inc(endpoint='test_server', status='error')
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Server not found"
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='test_server', status='error')
        logger.error("Failed to test server %s: %s", server_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to test server"
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
                tool_name=tool["function"]["name"],
                display_name=tool["function"].get("display_name"),
                description=tool["function"].get("description"),
                tool_schema=tool["function"].get("parameters", {}),
                server_id=str(server_id)
            )
            for tool in tools
        ]
        
    except ValueError as e:
        mcp_requests.inc(endpoint='get_server_tools', status='error')
        logger.warning("MCP server not found for tools listing: %s", e)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="MCP server not found."
        )
    except RuntimeError as e:
        mcp_requests.inc(endpoint='get_server_tools', status='error')
        logger.warning("Server %s not running and no cache available: %s", server_id, e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server is not running. Please start the server first."
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='get_server_tools', status='error')
        logger.error("Failed to get tools for %s: %s", server_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get tools"
        )


# =============================================================================
# Get Server Tools by Name
# =============================================================================

@router.get(
    "/servers/by-name/{server_name}/tools",
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
                tool_name=tool["function"]["name"],
                display_name=tool["function"].get("display_name"),
                description=tool["function"].get("description"),
                tool_schema=tool["function"].get("parameters", {}),
                server_id=server_name  # Use server name instead of UUID
            )
            for tool in tools
        ]

    except ValueError:
        mcp_requests.inc(endpoint='get_server_tools_by_name', status='error')
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Server not found"
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='get_server_tools_by_name', status='error')
        logger.error("Failed to get tools for %s: %s", server_name, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get tools"
        )


# =============================================================================
# Execute Tool
# =============================================================================

@router.post(
    "/servers/by-name/{server_name}/tools/{tool_name}",
    response_model=ExecutionResponse,
    summary="Execute tool by server name",
    description="Execute a specific tool on a server by its name"
)
async def execute_tool_by_name(
    server_name: str = Path(..., description="Server name"),
    tool_name: str = Path(..., description="Tool name"),
    request: ExecuteToolRequest = ...,
    manager: MCPServerManager = Depends(require_mcp_manager),
    _context: dict = Depends(setup_request_context)
) -> ExecutionResponse:
    """
    Execute tool by server name.
    
    Executes a tool on the specified server with given arguments.
    Includes timeout and monitoring.
    """
    # Validate inputs
    server_name = validate_server_name(server_name)
    tool_name = validate_tool_name(tool_name)
    
    execution_id = str(uuid.uuid4())
    start_time = time.time()
    
    try:
        # Get server by name
        server = await manager.get_server(server_name)
        if not server:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Server '{server_name}' not found"
            )
            
        server_id = str(server["id"])
        
        # Execute tool
        result = await manager.execute_tool(
            server_id=server_id,
            tool_name=tool_name,
            arguments=request.arguments
        )
        
        duration_ms = (time.time() - start_time) * 1000
        
        mcp_requests.inc(endpoint='execute_tool_by_name', status='success')
        mcp_execution_duration.observe(duration_ms / 1000, server=server_id, tool=tool_name)
        
        logger.info("Executed tool %s on %s (by name %s): %.2fms", tool_name, server_id, server_name, duration_ms)
        
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
        mcp_requests.inc(endpoint='execute_tool_by_name', status='timeout')
        logger.warning("Tool execution timed out: %s on %s", tool_name, server_name)
        
        return ExecutionResponse(
            execution_id=execution_id,
            tool_name=tool_name,
            server_id=server_name,
            status="timeout",
            result=None,
            error="Execution timed out",
            duration_ms=duration_ms,
            timestamp=datetime.utcnow()
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        mcp_requests.inc(endpoint='execute_tool_by_name', status='error')
        logger.error("Tool execution failed: %s on %s: %s", tool_name, server_name, e, exc_info=True)
        
        return ExecutionResponse(
            execution_id=execution_id,
            tool_name=tool_name,
            server_id=server_name,
            status="error",
            result=None,
            error="Tool execution failed. Check server logs for details.",
            duration_ms=duration_ms,
            timestamp=datetime.utcnow()
        )


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
            arguments=request.arguments
        )
        
        duration_ms = (time.time() - start_time) * 1000
        
        mcp_requests.inc(endpoint='execute_tool', status='success')
        mcp_execution_duration.observe(duration_ms / 1000, server=server_id, tool=tool_name)
        
        logger.info("Executed tool %s on %s: %.2fms", tool_name, server_id, duration_ms)
        
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
        logger.warning("Tool execution timed out: %s on %s", tool_name, server_id)
        
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
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        mcp_requests.inc(endpoint='execute_tool', status='error')
        logger.error("Tool execution failed: %s on %s: %s", tool_name, server_id, e, exc_info=True)
        
        return ExecutionResponse(
            execution_id=execution_id,
            tool_name=tool_name,
            server_id=server_id,
            status="error",
            result=None,
            error="Tool execution failed. Check server logs for details.",
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
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='check_server_health', status='error')
        logger.error("Health check failed for %s: %s", server_id, e, exc_info=True)
        
        return HealthResponse(
            server_id=server_id,
            status="unhealthy",
            is_running=False,
            tools_available=0,
            last_check=datetime.utcnow(),
            error="Health check failed. Check server logs for details."
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
        
    except ValueError:
        mcp_requests.inc(endpoint='get_server_stats', status='error')
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Server not found"
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='get_server_stats', status='error')
        logger.error("Failed to get stats for %s: %s", server_id, e, exc_info=True)
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
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        mcp_requests.inc(endpoint='get_execution_history', status='error')
        logger.error("Failed to get execution history: %s", e, exc_info=True)
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
        running_servers = [s for s in servers if s.get("status") == "active" or s.get("is_running")]
        
        return {
            "healthy": True,
            "manager_initialized": True,
            "total_servers": len(servers),
            "enabled_servers": len(enabled_servers),
            "running_servers": len(running_servers),
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("MCP health check failed: %s", e, exc_info=True)
        return {
            "healthy": False,
            "error": "MCP health check failed. Check server logs for details.",
            "timestamp": datetime.utcnow().isoformat()
        }


# =============================================================================
# System Dependencies
# =============================================================================

@router.get(
    "/system/dependencies",
    summary="System dependencies",
    description="Check availability of system dependencies for MCP servers"
)
def get_system_dependencies(
    _context: dict = Depends(setup_request_context)
):
    """
    Check if required system binaries are available.
    Used by frontend to determine which MCPs can be installed.
    """
    import shutil
    
    dependencies = {
        "node": shutil.which("node") is not None,
        "npm": shutil.which("npm") is not None,
        "npx": shutil.which("npx") is not None,
        "python": shutil.which("python") is not None or shutil.which("python3") is not None,
        "uv": shutil.which("uv") is not None,
        "uvx": shutil.which("uvx") is not None,
        "docker": shutil.which("docker") is not None,
    }
    
    return dependencies

