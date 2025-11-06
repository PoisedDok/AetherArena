"""
API V1 Schemas

Pydantic models for request/response validation.
"""

from .common import (
    SuccessResponse,
    ErrorResponse,
    PaginatedResponse,
    HealthStatus,
    StatusResponse,
)

from .health import (
    HealthCheckResponse,
    ComponentHealth,
    SystemHealth,
)

from .models import (
    ModelInfo,
    ModelsListResponse,
    ModelCapabilitiesResponse,
)

from .mcp import (
    ServerConfig,
    ServerResponse,
    ToolResponse,
    ExecutionResponse,
    HealthResponse,
    RegisterServerRequest,
    ExecuteToolRequest,
)

from .chat import (
    ChatCreate,
    ChatUpdate,
    ChatResponse,
    MessageCreate,
    MessageResponse,
    ArtifactCreate,
    ArtifactResponse,
)

from .files import (
    FileUploadResponse,
    FileChatRequest,
    FileChatResponse,
)

from .settings import (
    SettingsResponse,
    SettingsUpdateRequest,
)

__all__ = [
    # Common
    "SuccessResponse",
    "ErrorResponse",
    "PaginatedResponse",
    "HealthStatus",
    "StatusResponse",
    
    # Health
    "HealthCheckResponse",
    "ComponentHealth",
    "SystemHealth",
    
    # Models
    "ModelInfo",
    "ModelsListResponse",
    "ModelCapabilitiesResponse",
    
    # MCP
    "ServerConfig",
    "ServerResponse",
    "ToolResponse",
    "ExecutionResponse",
    "HealthResponse",
    "RegisterServerRequest",
    "ExecuteToolRequest",
    
    # Chat
    "ChatCreate",
    "ChatUpdate",
    "ChatResponse",
    "MessageCreate",
    "MessageResponse",
    "ArtifactCreate",
    "ArtifactResponse",
    
    # Files
    "FileUploadResponse",
    "FileChatRequest",
    "FileChatResponse",
    
    # Settings
    "SettingsResponse",
    "SettingsUpdateRequest",
]

