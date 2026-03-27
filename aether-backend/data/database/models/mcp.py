"""
MCP Data Models - Pydantic models for MCP entities

@.architecture
Incoming: data/database/repositories/mcp.py, core/mcp/database.py, api/v1/endpoints/mcp.py --- {database row dicts, API request payloads for validation}
Processing: Pydantic BaseModel validation (MCPServer, MCPTool, MCPExecution) --- {JOB_SERIALIZE, JOB_VALIDATE, JOB_VALIDATE_SCHEMA}
Outgoing: data/database/repositories/mcp.py, core/mcp/database.py, api/v1/endpoints/mcp.py --- {validated Pydantic model instances: MCPServer, MCPTool, MCPExecution}

Models for:
- MCPServer: MCP server registration and configuration
- MCPTool: Tool definitions cached from servers
- MCPExecution: Tool execution audit log
"""

from datetime import datetime
from typing import Any, Dict, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class MCPServer(BaseModel):
    """
    MCP Server model representing a registered MCP server.
    
    Attributes:
        id: Unique server identifier (UUID)
        name: Server name (unique)
        display_name: Human-readable name
        description: Optional description
        server_type: Server type (local, remote)
        config: Server configuration (JSONB)
        status: Server status (active, inactive, error, starting, stopping)
        error_message: Optional error message
        created_at: Creation timestamp
        updated_at: Last update timestamp
        last_health_check: Last health check timestamp
        health_status: Health status (healthy, unhealthy, unknown)
        enabled: Whether server is enabled
        sandbox_enabled: Whether execution is sandboxed
        resource_limits: Resource limits (JSONB)
        total_tool_calls: Total number of tool executions
        total_errors: Total number of errors
        last_used_at: Last usage timestamp
    """
    
    id: UUID
    name: str
    display_name: str
    description: Optional[str] = None
    server_type: str = Field(..., pattern="^(local|remote)$")
    config: Dict[str, Any]
    status: str = Field(
        default="inactive",
        pattern="^(active|inactive|error|starting|stopping)$"
    )
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    last_health_check: Optional[datetime] = None
    health_status: Optional[str] = Field(
        None,
        pattern="^(healthy|unhealthy|unknown)$"
    )
    enabled: bool = True
    auto_start: bool = False
    sandbox_enabled: bool = True
    resource_limits: Dict[str, Any] = Field(
        default_factory=lambda: {
            "max_memory_mb": 512,
            "max_cpu_percent": 50,
            "max_execution_time_seconds": 300,
        }
    )
    total_tool_calls: int = 0
    total_errors: int = 0
    last_used_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


class MCPTool(BaseModel):
    """
    MCP Tool model representing a cached tool definition from a server.
    
    Attributes:
        id: Unique tool identifier (UUID)
        server_id: Parent server ID
        name: Tool name (unique per server) - mapped from tool_name in DB
        description: Optional tool description
        input_schema: Tool input parameters schema (JSONB) - mapped from parameters in DB
        openai_schema: Full OpenAI function calling format schema (JSONB)
        enabled: Whether tool is enabled
        created_at: Creation timestamp
        updated_at: Last update timestamp
    """
    
    id: UUID
    server_id: UUID
    name: str  # Mapped from tool_name column in DB
    description: Optional[str] = None
    input_schema: Dict[str, Any] = Field(default_factory=dict)  # Mapped from parameters column in DB
    openai_schema: Dict[str, Any] = Field(default_factory=dict)  # Full OpenAI format from DB
    enabled: bool = True
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True


class MCPExecution(BaseModel):
    """
    MCP Execution model representing a tool execution audit log entry.
    
    Attributes:
        id: Unique execution identifier (UUID)
        server_id: Server that executed the tool
        tool_name: Name of tool that was executed
        arguments: Tool arguments (JSONB)
        result: Execution result (text)
        status: Execution status (success, error, timeout, cancelled)
        error_message: Optional error message
        executed_at: Execution timestamp
        duration_ms: Execution duration in milliseconds
        execution_context: Optional execution context (JSONB)
        sandboxed: Whether execution was sandboxed
    """
    
    id: UUID
    server_id: UUID
    tool_name: str
    arguments: Dict[str, Any]
    result: Optional[str] = None
    status: str = Field(..., pattern="^(success|error|timeout|cancelled)$")
    error_message: Optional[str] = None
    executed_at: datetime
    duration_ms: Optional[int] = None
    execution_context: Optional[Dict[str, Any]] = None
    sandboxed: bool = True
    
    class Config:
        from_attributes = True

