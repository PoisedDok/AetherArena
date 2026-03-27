"""
API Documentation Endpoints

Professional API documentation system providing comprehensive information about all endpoints,
schemas, authentication, rate limits, and usage examples.

@.architecture
Incoming: api/v1/router.py, FastAPI app instance, Frontend (HTTP GET) --- {HTTP requests to /v1/docs/*, OpenAPI schema}
Processing: get_api_documentation(), get_endpoint_details(), get_api_schema(), analyze_routes() --- {JOB_ROUTE, JOB_SERIALIZE, JOB_TRANSFORM_DATA}
Outgoing: Frontend (HTTP), API clients --- {APIDocumentationResponse, EndpointDetailsResponse, OpenAPI schema JSON}
"""

import time
from typing import Dict, Any, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel, Field

from core.exceptions import DomainException
from api.dependencies import setup_request_context
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["api-documentation"], prefix="")


# =============================================================================
# Response Schemas
# =============================================================================

class EndpointParameter(BaseModel):
    """API endpoint parameter information."""
    name: str = Field(..., description="Parameter name")
    param_type: str = Field(..., description="Parameter type (path, query, header, body)")
    data_type: str = Field(..., description="Data type (string, integer, object, etc.)")
    required: bool = Field(..., description="Whether parameter is required")
    description: Optional[str] = Field(None, description="Parameter description")
    default: Optional[Any] = Field(None, description="Default value")
    example: Optional[Any] = Field(None, description="Example value")
    json_schema: Optional[Dict[str, Any]] = Field(None, description="JSON schema for complex types", alias="schema")


class EndpointExample(BaseModel):
    """API endpoint usage example."""
    title: str = Field(..., description="Example title")
    description: Optional[str] = Field(None, description="Example description")
    request: Optional[Dict[str, Any]] = Field(None, description="Example request payload")
    response: Optional[Dict[str, Any]] = Field(None, description="Example response payload")
    curl: Optional[str] = Field(None, description="cURL command example")


class EndpointDetails(BaseModel):
    """Detailed information about an API endpoint."""
    path: str = Field(..., description="Endpoint path")
    method: str = Field(..., description="HTTP method")
    summary: Optional[str] = Field(None, description="Short summary")
    description: Optional[str] = Field(None, description="Detailed description")
    tags: List[str] = Field(default_factory=list, description="Endpoint tags")
    parameters: List[EndpointParameter] = Field(default_factory=list, description="Endpoint parameters")
    request_body: Optional[Dict[str, Any]] = Field(None, description="Request body schema")
    responses: Dict[str, Dict[str, Any]] = Field(default_factory=dict, description="Response schemas by status code")
    authentication: Optional[Dict[str, Any]] = Field(None, description="Authentication requirements")
    rate_limit: Optional[Dict[str, Any]] = Field(None, description="Rate limit information")
    examples: List[EndpointExample] = Field(default_factory=list, description="Usage examples")
    deprecated: bool = Field(False, description="Whether endpoint is deprecated")


class EndpointGroup(BaseModel):
    """Group of related API endpoints."""
    tag: str = Field(..., description="Tag name")
    description: Optional[str] = Field(None, description="Tag description")
    endpoints: List[EndpointDetails] = Field(default_factory=list, description="Endpoints in this group")


class APIDocumentation(BaseModel):
    """Complete API documentation."""
    api_name: str = Field(..., description="API name")
    version: str = Field(..., description="API version")
    description: str = Field(..., description="API description")
    base_url: str = Field(..., description="Base URL for API")
    authentication: Dict[str, Any] = Field(..., description="Authentication schemes")
    rate_limiting: Dict[str, Any] = Field(..., description="Rate limiting configuration")
    endpoint_groups: List[EndpointGroup] = Field(default_factory=list, description="Grouped endpoints")
    total_endpoints: int = Field(..., description="Total number of endpoints")
    schemas: Dict[str, Any] = Field(default_factory=dict, description="Reusable schemas")
    contact: Optional[Dict[str, str]] = Field(None, description="Contact information")
    license: Optional[Dict[str, str]] = Field(None, description="License information")


# =============================================================================
# Documentation Generation
# =============================================================================

def _get_endpoint_examples(path: str, method: str) -> List[EndpointExample]:
    """Generate examples for specific endpoints."""
    examples = []
    
    # Health endpoint examples
    if path == "/v1/health" and method == "GET":
        examples.append(EndpointExample(
            title="Basic health check",
            description="Quick health check for load balancers",
            curl="curl -X GET 'http://localhost:8765/v1/health'",
            response={
                "status": "ok",
                "timestamp": 1704729600.0,
                "uptime_seconds": 3600.5
            }
        ))
    
    # Chat endpoint examples
    elif path == "/v1/create/chat" and method == "POST":
        examples.append(EndpointExample(
            title="Send chat message",
            description="Send a message to the AI assistant",
            request={
                "message": "Hello, how can you help me?",
                "session_id": "user-session-123"
            },
            curl='curl -X POST \'http://localhost:8765/v1/create/chat\' \\\n  -H \'Content-Type: application/json\' \\\n  -d \'{"message": "Hello, how can you help me?", "session_id": "user-session-123"}\'',
            response={
                "status": "ok",
                "response": "Hello! I'm here to help you with...",
                "request_id": "req-123",
                "session_id": "user-session-123"
            }
        ))
    
    # MCP server registration example
    elif path == "/v1/api/mcp/servers" and method == "POST":
        examples.append(EndpointExample(
            title="Register local MCP server",
            description="Register a new local subprocess-based MCP server",
            request={
                "name": "my_custom_server",
                "display_name": "My Custom Server",
                "server_type": "local",
                "description": "Custom MCP server for specialized tools",
                "config": {
                    "command": "python",
                    "args": ["/path/to/server.py"],
                    "env": {"VAR": "value"}
                },
                "auto_start": True,
                "enabled": True
            },
            curl='curl -X POST \'http://localhost:8765/v1/api/mcp/servers\' \\\n  -H \'Content-Type: application/json\' \\\n  -d \'{"name": "my_custom_server", "server_type": "local", ...}\'',
            response={
                "server_id": "550e8400-e29b-41d4-a716-446655440000",
                "name": "my_custom_server",
                "status": "active",
                "tools_count": 5
            }
        ))
    
    # Models listing example
    elif path == "/v1/models" and method == "GET":
        examples.append(EndpointExample(
            title="List available models",
            description="Get all available LLM models from the configured provider",
            curl="curl -X GET 'http://localhost:8765/v1/models'",
            response={
                "models": [
                    "qwen/qwen3-vl-72b",
                    "qwen/qwen-plus",
                    "gpt-4o-mini"
                ],
                "count": 3
            }
        ))
    
    # Memory search example
    elif path == "/v1/storage/memories/search" and method == "POST":
        examples.append(EndpointExample(
            title="Search memories",
            description="Semantic search across stored memories",
            request={
                "query": "machine learning projects",
                "limit": 10,
                "threshold": 0.7
            },
            curl='curl -X POST \'http://localhost:8765/v1/storage/memories/search\' \\\n  -H \'Content-Type: application/json\' \\\n  -d \'{"query": "machine learning projects", "limit": 10}\'',
            response={
                "memories": [
                    {
                        "id": "mem-123",
                        "content": "Working on TensorFlow model optimization",
                        "importance": 0.85,
                        "created_at": "2024-01-08T10:00:00Z"
                    }
                ],
                "total": 1
            }
        ))
    
    # Browser history discovery example
    elif path == "/v1/sources/browser-history/discover" and method == "POST":
        examples.append(EndpointExample(
            title="Discover browser profiles",
            description="Scan for available browser profiles on the local system",
            request={
                "browser": "edge"
            },
            curl='curl -X POST \'http://localhost:8765/v1/sources/browser-history/discover\' \\\n  -H \'Content-Type: application/json\' \\\n  -d \'{"browser": "edge"}\'',
            response={
                "success": True,
                "browser": "edge",
                "profiles": [
                    {
                        "profile_name": "Default",
                        "profile_path": "/Users/user/Library/Application Support/Microsoft Edge/Default",
                        "estimated_entries": 15420
                    }
                ]
            }
        ))

    # Browser history indexing example
    elif path == "/v1/sources/browser-history/index" and method == "POST":
        examples.append(EndpointExample(
            title="Build browser history index",
            description="Index browser history with dual semantic and BM25 support",
            request={
                "browser": "edge",
                "profile_path": "/Users/user/Library/Application Support/Microsoft Edge/Default",
                "build_semantic": True,
                "build_bm25": True
            },
            curl='curl -X POST \'http://localhost:8765/v1/sources/browser-history/index\' \\\n  -H \'Content-Type: application/json\' \\\n  -d \'{"browser": "edge", "build_bm25": true}\'',
            response={
                "success": True,
                "index": {
                    "index_name": "browser_history",
                    "chunk_count": 15420,
                    "metadata": {
                        "semantic_enabled": True,
                        "bm25_enabled": True
                    }
                }
            }
        ))

    # Index search with mode example
    elif path == "/v1/search/index" and (method == "POST" or method == "GET"):
        examples.append(EndpointExample(
            title="Search index with hybrid mode",
            description="Search a specific index using hybrid (semantic + BM25) retrieval",
            request={
                "name": "browser_history",
                "query": "how to setup docker",
                "mode": "hybrid",
                "top_k": 5
            },
            curl='curl \'http://localhost:8765/v1/search/index?name=browser_history&query=docker&mode=hybrid\'',
            response={
                "results": [
                    {
                        "text": "To setup docker on macOS...",
                        "score": 0.92,
                        "metadata": {"url": "https://docs.docker.com/..."}
                    }
                ]
            }
        ))
    
    return examples


def _get_authentication_info() -> Dict[str, Any]:
    """Get authentication configuration information."""
    return {
        "enabled": True,
        "type": "Bearer Token (JWT)",
        "header": "Authorization",
        "format": "Bearer <token>",
        "description": "Authentication is optional for most endpoints. When enabled, include JWT token in Authorization header.",
        "public_endpoints": [
            "/",
            "/health",
            "/v1/health",
            "/v1/health/live",
            "/v1/health/ready",
            "/v1/docs",
            "/v1/docs/*",
            "/docs",
            "/redoc",
            "/openapi.json"
        ],
        "example": "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }


def _get_rate_limiting_info() -> Dict[str, Any]:
    """Get rate limiting configuration information."""
    return {
        "enabled": True,
        "strategy": "per_ip",
        "tiers": {
            "default": {
                "requests_per_window": 100,
                "window_seconds": 60,
                "burst_size": 20,
                "description": "Default rate limit for general endpoints"
            },
            "chat": {
                "requests_per_window": 30,
                "window_seconds": 60,
                "burst_size": 5,
                "description": "Rate limit for chat endpoints (stricter)"
            },
            "health": {
                "requests_per_window": 1000,
                "window_seconds": 60,
                "burst_size": 100,
                "description": "Rate limit for health check endpoints (generous)"
            }
        },
        "headers": {
            "X-RateLimit-Limit": "Maximum requests allowed per window",
            "X-RateLimit-Remaining": "Remaining requests in current window",
            "X-RateLimit-Reset": "Unix timestamp when window resets",
            "Retry-After": "Seconds to wait before retrying (on 429 responses)"
        },
        "response_codes": {
            "429": "Too Many Requests - Rate limit exceeded"
        }
    }


def _parse_endpoint_details(path: str, method: str, operation: Dict[str, Any], schemas: Dict[str, Any]) -> EndpointDetails:
    """Parse OpenAPI operation into detailed endpoint information."""
    
    # Extract parameters
    parameters = []
    for param in operation.get("parameters", []):
        param_in = param.get("in", "query")
        param_schema = param.get("schema", {})
        
        parameters.append(EndpointParameter(
            name=param["name"],
            param_type=param_in,
            data_type=param_schema.get("type", "string"),
            required=param.get("required", False),
            description=param.get("description"),
            default=param_schema.get("default"),
            example=param.get("example"),
            json_schema=param_schema if len(param_schema) > 1 else None
        ))
    
    # Extract request body
    request_body = None
    if "requestBody" in operation:
        content = operation["requestBody"].get("content", {})
        if "application/json" in content:
            request_body = content["application/json"].get("schema", {})
    
    # Extract responses
    responses = {}
    for status_code, response_info in operation.get("responses", {}).items():
        content = response_info.get("content", {})
        response_schema = None
        if "application/json" in content:
            response_schema = content["application/json"].get("schema", {})
        
        responses[status_code] = {
            "description": response_info.get("description", ""),
            "schema": response_schema
        }
    
    # Determine authentication requirements
    authentication = None
    if "security" in operation:
        authentication = {
            "required": True,
            "schemes": operation["security"]
        }
    else:
        authentication = {
            "required": False,
            "description": "This endpoint is publicly accessible"
        }
    
    # Get rate limit info based on path
    rate_limit = None
    if "/health" in path:
        rate_limit = {"tier": "health", "requests_per_minute": 1000}
    elif "/chat" in path:
        rate_limit = {"tier": "chat", "requests_per_minute": 30}
    else:
        rate_limit = {"tier": "default", "requests_per_minute": 100}
    
    # Get examples
    examples = _get_endpoint_examples(path, method)
    
    return EndpointDetails(
        path=path,
        method=method.upper(),
        summary=operation.get("summary"),
        description=operation.get("description"),
        tags=operation.get("tags", []),
        parameters=parameters,
        request_body=request_body,
        responses=responses,
        authentication=authentication,
        rate_limit=rate_limit,
        examples=examples,
        deprecated=operation.get("deprecated", False)
    )


# =============================================================================
# API Documentation Endpoints
# =============================================================================

@router.get(
    "/docs",
    response_model=APIDocumentation,
    summary="Get complete API documentation",
    description="Returns comprehensive documentation for all API endpoints, including schemas, examples, and usage information"
)
async def get_api_documentation(
    request: Request,
    include_examples: bool = Query(True, description="Include usage examples"),
    include_schemas: bool = Query(True, description="Include JSON schemas"),
    _context: dict = Depends(setup_request_context)
) -> APIDocumentation:
    """
    Get complete API documentation.
    
    Returns comprehensive information about all API endpoints including:
    - Endpoint paths and methods
    - Request/response schemas
    - Authentication requirements
    - Rate limiting information
    - Usage examples
    - cURL commands
    
    This is designed for developers to understand and integrate with the API.
    """
    try:
        # Get FastAPI app instance from request
        app = request.app
        
        # Generate OpenAPI schema
        openapi_schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        
        # Extract schemas
        schemas = openapi_schema.get("components", {}).get("schemas", {}) if include_schemas else {}
        
        # Group endpoints by tag
        endpoint_groups: Dict[str, EndpointGroup] = {}
        total_endpoints = 0
        
        # Parse paths
        for path, path_item in openapi_schema.get("paths", {}).items():
            for method, operation in path_item.items():
                if method.upper() not in ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]:
                    continue
                
                total_endpoints += 1
                
                # Parse endpoint details
                endpoint = _parse_endpoint_details(path, method, operation, schemas)
                
                if not include_examples:
                    endpoint.examples = []
                
                # Group by tag
                tags = operation.get("tags", ["default"])
                for tag in tags:
                    if tag not in endpoint_groups:
                        endpoint_groups[tag] = EndpointGroup(
                            tag=tag,
                            description=f"Endpoints related to {tag}",
                            endpoints=[]
                        )
                    endpoint_groups[tag].endpoints.append(endpoint)
        
        # Sort endpoints within each group by path
        for group in endpoint_groups.values():
            group.endpoints.sort(key=lambda e: (e.path, e.method))
        
        # Get base URL
        base_url = str(request.base_url).rstrip("/")
        
        return APIDocumentation(
            api_name=app.title,
            version=app.version,
            description=app.description or "Aether AI Backend - Production Ready API",
            base_url=base_url,
            authentication=_get_authentication_info(),
            rate_limiting=_get_rate_limiting_info(),
            endpoint_groups=list(endpoint_groups.values()),
            total_endpoints=total_endpoints,
            schemas=schemas,
            contact={
                "name": "AetherArena Support",
                "email": "info@aetherinc.xyz"
            },
            license={
                "name": "BUSL-1.1",
                "identifier": "BUSL-1.1"
            }
        )
        
    except Exception as e:
        logger.error("Failed to generate API documentation: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate API documentation"
        )


@router.get(
    "/docs/endpoint",
    response_model=EndpointDetails,
    summary="Get specific endpoint documentation",
    description="Get detailed documentation for a specific API endpoint"
)
async def get_endpoint_documentation(
    request: Request,
    path: str = Query(..., description="Endpoint path (e.g., /v1/health)"),
    method: str = Query(..., description="HTTP method (GET, POST, etc.)"),
    _context: dict = Depends(setup_request_context)
) -> EndpointDetails:
    """
    Get detailed documentation for a specific endpoint.
    
    Args:
        path: The endpoint path (e.g., /v1/health)
        method: The HTTP method (GET, POST, PUT, DELETE, etc.)
        
    Returns:
        Detailed endpoint information including parameters, schemas, and examples
    """
    try:
        app = request.app
        
        # Generate OpenAPI schema
        openapi_schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        
        # Find the endpoint
        path_item = openapi_schema.get("paths", {}).get(path)
        if not path_item:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Endpoint path '{path}' not found"
            )
        
        method_lower = method.lower()
        operation = path_item.get(method_lower)
        if not operation:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Method '{method}' not found for path '{path}'"
            )
        
        # Parse endpoint details
        schemas = openapi_schema.get("components", {}).get("schemas", {})
        endpoint = _parse_endpoint_details(path, method, operation, schemas)
        
        return endpoint
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get endpoint documentation: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get endpoint documentation"
        )


@router.get(
    "/docs/tags",
    summary="List API endpoint tags",
    description="Get all available API endpoint tags/categories"
)
async def list_api_tags(
    request: Request,
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    List all API endpoint tags.
    
    Tags are used to group related endpoints together.
    """
    try:
        app = request.app
        
        openapi_schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        
        # Collect all unique tags
        tags_set = set()
        tag_descriptions = {}
        
        for path, path_item in openapi_schema.get("paths", {}).items():
            for method, operation in path_item.items():
                if method.upper() not in ["GET", "POST", "PUT", "DELETE", "PATCH"]:
                    continue
                
                for tag in operation.get("tags", ["default"]):
                    tags_set.add(tag)
                    if tag not in tag_descriptions:
                        tag_descriptions[tag] = f"Endpoints related to {tag}"
        
        # Format response
        tags_list = [
            {
                "name": tag,
                "description": tag_descriptions.get(tag, ""),
                "endpoint_count": sum(
                    1 for path_item in openapi_schema.get("paths", {}).values()
                    for method, operation in path_item.items()
                    if method.upper() in ["GET", "POST", "PUT", "DELETE", "PATCH"]
                    and tag in operation.get("tags", [])
                )
            }
            for tag in sorted(tags_set)
        ]
        
        return JSONResponse({
            "tags": tags_list,
            "total": len(tags_list)
        })
        
    except Exception as e:
        logger.error("Failed to list API tags: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list API tags"
        )


@router.get(
    "/docs/schemas",
    summary="Get API schemas",
    description="Get all reusable JSON schemas used in the API"
)
async def get_api_schemas(
    request: Request,
    schema_name: Optional[str] = Query(None, description="Specific schema name to retrieve"),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get API schemas.
    
    Returns all reusable JSON schemas defined in the API.
    These schemas are used for request/response validation.
    """
    try:
        app = request.app
        
        openapi_schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        
        schemas = openapi_schema.get("components", {}).get("schemas", {})
        
        if schema_name:
            if schema_name not in schemas:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Schema '{schema_name}' not found"
                )
            return JSONResponse({
                "schema_name": schema_name,
                "schema": schemas[schema_name]
            })
        
        return JSONResponse({
            "schemas": schemas,
            "count": len(schemas)
        })
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get API schemas: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get API schemas"
        )


@router.get(
    "/docs/openapi",
    summary="Get OpenAPI specification",
    description="Get the complete OpenAPI 3.0 specification for this API"
)
async def get_openapi_spec(
    request: Request,
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get OpenAPI specification.
    
    Returns the complete OpenAPI 3.0 specification in JSON format.
    This can be imported into tools like Postman, Insomnia, or Swagger Editor.
    """
    try:
        app = request.app
        
        openapi_schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        
        # Add additional metadata
        openapi_schema["info"]["contact"] = {
            "name": "AetherArena Support",
            "email": "info@aetherinc.xyz"
        }
        openapi_schema["info"]["license"] = {
            "name": "BUSL-1.1",
            "identifier": "BUSL-1.1"
        }
        
        # Add server information
        base_url = str(request.base_url).rstrip("/")
        openapi_schema["servers"] = [
            {
                "url": base_url,
                "description": "Current server"
            }
        ]
        
        return JSONResponse(openapi_schema)
        
    except Exception as e:
        logger.error("Failed to get OpenAPI spec: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get OpenAPI specification"
        )


@router.get(
    "/docs/stats",
    summary="Get API statistics",
    description="Get statistics about the API (endpoint counts, etc.)"
)
async def get_api_stats(
    request: Request,
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get API statistics.
    
    Returns statistics about the API including:
    - Total number of endpoints
    - Endpoints by method
    - Endpoints by tag
    - Deprecated endpoints
    """
    try:
        app = request.app
        
        openapi_schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        
        # Count endpoints
        total_endpoints = 0
        endpoints_by_method = {}
        endpoints_by_tag = {}
        deprecated_count = 0
        
        for path, path_item in openapi_schema.get("paths", {}).items():
            for method, operation in path_item.items():
                if method.upper() not in ["GET", "POST", "PUT", "DELETE", "PATCH"]:
                    continue
                
                total_endpoints += 1
                
                # Count by method
                method_upper = method.upper()
                endpoints_by_method[method_upper] = endpoints_by_method.get(method_upper, 0) + 1
                
                # Count by tag
                for tag in operation.get("tags", ["default"]):
                    endpoints_by_tag[tag] = endpoints_by_tag.get(tag, 0) + 1
                
                # Count deprecated
                if operation.get("deprecated", False):
                    deprecated_count += 1
        
        return JSONResponse({
            "total_endpoints": total_endpoints,
            "endpoints_by_method": endpoints_by_method,
            "endpoints_by_tag": endpoints_by_tag,
            "deprecated_endpoints": deprecated_count,
            "api_version": app.version,
            "generated_at": time.time()
        })
        
    except Exception as e:
        logger.error("Failed to get API stats: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get API statistics"
        )

