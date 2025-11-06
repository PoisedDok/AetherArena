"""
MCP Schemas

Pydantic models for MCP (Model Context Protocol) endpoints.

@.architecture
Incoming: api/v1/endpoints/mcp.py, core/mcp/manager.py --- {MCP server configs, tool execution requests}
Processing: Pydantic validation and serialization --- {2 jobs: data_validation, serialization}
Outgoing: api/v1/endpoints/mcp.py --- {RegisterServerRequest, ServerResponse, ToolResponse, ExecuteToolRequest, ExecutionResponse validated models}
"""

from typing import Dict, List, Optional, Any
from datetime import datetime
from pydantic import BaseModel, Field
from uuid import UUID

from .common import HealthStatus


# =============================================================================
# Server Configuration Models
# =============================================================================

class ServerConfig(BaseModel):
    """MCP server configuration."""
    command: str = Field(..., description="Command to execute server")
    args: List[str] = Field(default_factory=list, description="Command arguments")
    env: Optional[Dict[str, str]] = Field(default=None, description="Environment variables")
    
    class Config:
        json_schema_extra = {
            "example": {
                "command": "python",
                "args": ["-m", "mcp_server"],
                "env": {"API_KEY": "secret"}
            }
        }


class RegisterServerRequest(BaseModel):
    """Request to register a new MCP server."""
    name: str = Field(..., min_length=1, max_length=100)
    display_name: Optional[str] = None
    description: Optional[str] = None
    server_type: str = Field(default="local", pattern="^(local|remote)$")
    config: ServerConfig
    auto_start: bool = True
    enabled: bool = True
    
    class Config:
        json_schema_extra = {
            "example": {
                "name": "filesystem-server",
                "display_name": "File System MCP",
                "description": "Provides file system operations",
                "server_type": "local",
                "config": {
                    "command": "python",
                    "args": ["-m", "mcp.server.filesystem"]
                },
                "auto_start": True,
                "enabled": True
            }
        }


# =============================================================================
# Server Response Models
# =============================================================================

class ServerResponse(BaseModel):
    """MCP server information response."""
    server_id: str
    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    server_type: str
    status: str  # running|stopped|error
    config: ServerConfig
    auto_start: bool
    enabled: bool
    created_at: datetime
    updated_at: datetime
    last_health_check: Optional[datetime] = None
    tools_count: int = 0
    
    class Config:
        json_schema_extra = {
            "example": {
                "server_id": "550e8400-e29b-41d4-a716-446655440000",
                "name": "filesystem-server",
                "display_name": "File System MCP",
                "server_type": "local",
                "status": "running",
                "config": {"command": "python", "args": ["-m", "mcp.server.filesystem"]},
                "auto_start": True,
                "enabled": True,
                "created_at": "2024-11-04T12:00:00Z",
                "updated_at": "2024-11-04T12:00:00Z",
                "tools_count": 5
            }
        }


# =============================================================================
# Tool Models
# =============================================================================

class ToolSchema(BaseModel):
    """Tool parameter schema."""
    type: str
    properties: Dict[str, Any]
    required: List[str] = Field(default_factory=list)


class ToolResponse(BaseModel):
    """MCP tool information."""
    model_config = {
        "protected_namespaces": (),  # Allow fields starting with model_
        "json_schema_extra": {
            "example": {
                "tool_name": "read_file",
                "display_name": "Read File",
                "description": "Read contents of a file",
                "tool_schema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "File path"}
                    },
                    "required": ["path"]
                },
                "server_id": "550e8400-e29b-41d4-a716-446655440000"
            }
        }
    }
    
    tool_name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    tool_schema: ToolSchema  # Renamed from 'schema'
    server_id: str


# =============================================================================
# Execution Models
# =============================================================================

class ExecuteToolRequest(BaseModel):
    """Request to execute an MCP tool."""
    arguments: Dict[str, Any] = Field(default_factory=dict)
    timeout: Optional[int] = Field(default=30, ge=1, le=300)
    
    class Config:
        json_schema_extra = {
            "example": {
                "arguments": {
                    "path": "/path/to/file.txt"
                },
                "timeout": 30
            }
        }


class ExecutionResponse(BaseModel):
    """MCP tool execution response."""
    execution_id: str
    tool_name: str
    server_id: str
    status: str  # success|error|timeout
    result: Optional[Any] = None
    error: Optional[str] = None
    duration_ms: float
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    
    class Config:
        json_schema_extra = {
            "example": {
                "execution_id": "exec-123456",
                "tool_name": "read_file",
                "server_id": "550e8400-e29b-41d4-a716-446655440000",
                "status": "success",
                "result": {"content": "file contents here"},
                "error": None,
                "duration_ms": 45.2,
                "timestamp": "2024-11-04T12:00:00Z"
            }
        }


# =============================================================================
# Health Check Models
# =============================================================================

class HealthResponse(BaseModel):
    """MCP server health check response."""
    server_id: str
    status: HealthStatus
    is_running: bool
    tools_available: int
    last_check: datetime
    response_time_ms: Optional[float] = None
    error: Optional[str] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "server_id": "550e8400-e29b-41d4-a716-446655440000",
                "status": "healthy",
                "is_running": True,
                "tools_available": 5,
                "last_check": "2024-11-04T12:00:00Z",
                "response_time_ms": 15.3,
                "error": None
            }
        }


# =============================================================================
# Statistics Models
# =============================================================================

class ServerStats(BaseModel):
    """MCP server statistics."""
    server_id: str
    total_executions: int
    successful_executions: int
    failed_executions: int
    average_duration_ms: float
    uptime_seconds: float
    last_execution: Optional[datetime] = None

