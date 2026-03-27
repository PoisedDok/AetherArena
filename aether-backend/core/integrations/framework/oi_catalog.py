"""
Open Interpreter Tool Catalog Bridge

Clean, modular bridge that generates OI tool definitions from backend APIs.
Uses OpenAPI spec + integrations registry - NO HARDCODING.

Architecture:
1. Read integrations_registry.yaml for backend metadata
2. Query FastAPI OpenAPI spec for actual endpoint definitions
3. Generate tool wrappers dynamically
4. Register with OI tool_engine

Clean separation of concerns:
- Config from settings
- Metadata from registry
- API spec from FastAPI
- No hardcoded data

@.architecture
Incoming: FastAPI app, config/settings.py, config/integrations_registry.yaml, OpenAPI spec, Open Interpreter tool_engine --- {FastAPI instance, Settings, Dict YAML config, Dict OpenAPI spec, tool_engine}
Processing: generate_tools_from_openapi(), _create_tool_from_endpoint(), register_with_oi(), _generate_wrapper_function() --- {JOB_DISCOVER_TOOLS, JOB_LOAD_CONFIG, JOB_REGISTER_PROVIDER, JOB_TRANSFORM_DATA}
Outgoing: Open Interpreter tool_engine --- {List[Dict] tool definitions, Callable wrapper functions, registered tools}
"""

import logging
import urllib.parse
from typing import Dict, Any, List, Optional, Callable
import yaml

logger = logging.getLogger(__name__)


class OIToolCatalogBridge:
    """
    Clean bridge between backend APIs and Open Interpreter tool catalog.
    
    Generates tools dynamically from:
    - integrations_registry.yaml (metadata)
    - FastAPI OpenAPI spec (endpoint definitions)
    - Settings config (URLs, paths)
    """
    
    def __init__(self, fastapi_app: Any, settings: Any):
        """
        Initialize catalog bridge.
        
        Args:
            fastapi_app: FastAPI application instance (for OpenAPI spec)
            settings: Settings instance (for URLs, config)
        """
        self.app = fastapi_app
        self.settings = settings
        self._registry = self._load_registry()
        from core.integrations.framework.yaml_generator import BackendToolsYAMLGenerator
        self._yaml_generator = BackendToolsYAMLGenerator(fastapi_app, settings)
        self._openapi_cache: Optional[Dict[str, Any]] = None
    
    def _load_registry(self) -> Dict[str, Any]:
        """Load integrations_registry.yaml from backend config directory."""
        try:
            # Use settings to get config directory
            registry_path = self.settings.config_dir / "integrations_registry.yaml"
            
            if not registry_path.exists():
                logger.warning("Registry not found: %s", registry_path)
                return {"integrations": {}}
            
            with open(registry_path, 'r') as f:
                return yaml.safe_load(f) or {"integrations": {}}
        except Exception as e:
            logger.error("Failed to load registry: %s", e)
            return {"integrations": {}}
    
    def generate_tools_from_openapi(self) -> List[Dict[str, Any]]:
        """
        Generate tool definitions from OpenAPI spec.
        
        Returns:
            List of tool metadata dicts for OI tool_engine
        """
        try:
            # Get OpenAPI spec from FastAPI when available; otherwise fetch from running backend.
            openapi_spec = None
            if self.app is not None and hasattr(self.app, "openapi"):
                openapi_spec = self.app.openapi()
            else:
                openapi_spec = self._fetch_openapi_spec()
            paths = openapi_spec.get("paths", {})
            
            tools = []
            
            for path, methods in paths.items():
                for method, endpoint_spec in methods.items():
                    if method.upper() not in ["GET", "POST", "PUT", "DELETE", "PATCH"]:
                        continue
                    
                    # Generate tool from endpoint
                    tool = self._create_tool_from_endpoint(
                        path, method, endpoint_spec
                    )
                    if tool:
                        tools.append(tool)
            
            logger.info("Generated %d tools from OpenAPI spec", len(tools))
            return tools
            
        except Exception as e:
            logger.error("Failed to generate tools from OpenAPI: %s", e)
            return []

    def _fetch_openapi_spec(self) -> Dict[str, Any]:
        """
        Fetch OpenAPI spec from a running backend instance.

        This supports the legal-clean external OI server architecture where tool injection happens
        in an external wrapper process and there is no FastAPI app object available.
        """
        if self._openapi_cache is not None:
            return self._openapi_cache

        import httpx

        base_url = str(getattr(self.settings, "base_url", "")).rstrip("/")
        if not base_url:
            raise RuntimeError("settings.base_url is required to fetch OpenAPI spec")

        url = f"{base_url}/openapi.json"
        timeout = 10.0
        try:
            timeout = float(getattr(getattr(self.settings, "http_client", None), "external_service_timeout", 10.0))
        except Exception:
            timeout = 10.0

        resp = httpx.get(url, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, dict):
            raise RuntimeError("OpenAPI spec response is not a JSON object")
        self._openapi_cache = data
        return data

    def _create_tool_from_endpoint(
        self,
        path: str,
        method: str,
        spec: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Create tool metadata from OpenAPI endpoint spec.
        
        Args:
            path: API path
            method: HTTP method
            spec: OpenAPI endpoint specification
            
        Returns:
            Tool metadata dict or None
        """
        # Enforce explicit agent tool whitelist
        if not spec.get("is_agent_tool"):
            return None
        
        tags = spec.get("tags", [])
        tag = tags[0] if tags else "other"

        tool_meta = self._yaml_generator._create_tool_metadata(path, method, spec, tag)
        if not tool_meta:
            return None

        category = self._map_tag_to_category(tag)

        return {
            "name": tool_meta["name"],
            "path": path,
            "method": method.upper(),
            "category": category,
            "description": tool_meta.get("description") or f"{method.upper()} {path}",
            "parameters": tool_meta.get("parameters", []),
            "tags": list(set(tags)),
            "full_path": tool_meta["path"]
        }
    
    
    def _map_tag_to_category(self, tag: str) -> str:
        """
        Map API tag to OI tool category.
        
        Uses registry metadata for accurate categorization.
        """
        # Try to get category from registry first
        integrations = self._registry.get("integrations", {})
        
        for name, config in integrations.items():
            # Check if tag matches integration name
            if tag.lower() == name.lower():
                layer3 = config.get("layer3_metadata", {})
                category_key = layer3.get("category", "")
                # Convert category key to readable format
                return self._format_category(category_key)
        
        # Fallback mapping
        tag_map = {
            "ocr": "Files & Documents",
            "tts": "Audio & Speech",
            "notebook": "System & Terminal",
            "omni": "Vision",
            "xlwings": "Excel Automation",
            "backends": "System & Terminal",
            "chat": "AI & LLM",
            "mcp": "System & Terminal",
            "storage": "Files & Documents",
            "profiles": "System & Terminal",
            "skills": "System & Terminal",
            "files": "Files & Documents"
        }
        return tag_map.get(tag.lower(), "Other")
    
    def _format_category(self, category_key: str) -> str:
        """Format category key to readable name."""
        category_map = {
            "web_search_extraction": "Web & Search",
            "document_processing_vision": "Files & Documents",
            "excel_automation_data_analysis": "Excel Automation",
            "system_operations": "System & Terminal",
            "browser_automation": "Web & Search",
            "mcp_tools": "System & Terminal"
        }
        return category_map.get(category_key, "Other")
    
    def _extract_parameters(self, spec: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Extract parameters from OpenAPI spec."""
        parameters = []
        
        # Query parameters
        for param in spec.get("parameters", []):
            name = param.get("name")
            # Skip parameters with missing name (malformed spec entry)
            if not name:
                continue
            # Skip internal Aether tracking headers that should be handled by the infrastructure
            if name.lower().startswith("x-") or name.lower() in ("authorization", "cookie", "referer", "user-agent"):
                continue
                
            parameters.append({
                "name": name,
                "type": param.get("schema", {}).get("type", "string"),
                "required": param.get("required", False),
                "description": param.get("description", "")
            })
        
        # Request body parameters
        request_body = spec.get("requestBody", {})
        content = request_body.get("content", {})
        
        for content_type, content_spec in content.items():
            schema = content_spec.get("schema", {})
            properties = schema.get("properties", {})
            required = schema.get("required", [])
            
            for prop_name, prop_spec in properties.items():
                parameters.append({
                    "name": prop_name,
                    "type": prop_spec.get("type", "string"),
                    "required": prop_name in required,
                    "description": prop_spec.get("description", "")
                })
        
        return parameters
    
    def register_with_oi(self, interpreter: Any) -> Dict[str, int]:
        """
        Register generated tools with Open Interpreter.
        
        Args:
            interpreter: OI interpreter instance
            
        Returns:
            Registration statistics
        """
        try:
            # Generate tools from OpenAPI
            tools = self.generate_tools_from_openapi()
            
            if not tools:
                logger.warning("No tools generated from OpenAPI spec")
                return {"tools_generated": 0, "tools_attached": 0, "success": False}
            
            # Create callable wrappers
            computer = interpreter.computer
            attached_count = 0
            
            for tool_meta in tools:
                wrapper = self._create_tool_wrapper(tool_meta)
                if wrapper:
                    # Attach to computer
                    setattr(computer, tool_meta["name"], wrapper)
                    attached_count += 1
            
            # Register with tool_engine if available
            registered_count = 0
            if hasattr(computer, 'tools'):
                try:
                    # Try to import ToolMetadata - may not be available in all OI versions
                    try:
                        from interpreter.core.computer.tool_metadata import (
                            ToolMetadata, ToolComplexity
                        )
                        has_tool_metadata = True
                    except ImportError:
                        logger.debug("ToolMetadata not available, skipping tool_engine registration")
                        has_tool_metadata = False
                    
                    if has_tool_metadata:
                        metadata_list = []
                        for tool in tools:
                            param_count = len(tool["parameters"])
                            complexity = (
                                ToolComplexity.SIMPLE if param_count <= 2
                                else ToolComplexity.MODERATE if param_count <= 5
                                else ToolComplexity.ADVANCED
                            )
                            
                            metadata = ToolMetadata(
                                name=tool["name"],
                                category=tool["category"],
                                subcategory="Backend API",
                                description=tool["description"],
                                complexity=complexity,
                                parameters=tool["parameters"],
                                use_cases=[f"Use {tool['name']} API"],
                                tags=tool["tags"],
                                signature=self._format_signature(tool["parameters"]),
                                full_path=tool["full_path"]
                            )
                            metadata_list.append(metadata)
                        
                        # Register with tool engine
                        if hasattr(computer.tools, '_engine'):
                            computer.tools._engine.register_dynamic_tools(metadata_list)
                            registered_count = len(metadata_list)
                            logger.info("Registered %d tools with tool_engine", registered_count)
                
                except Exception as e:
                    logger.debug("Tool engine registration skipped: %s", e)
            
            logger.info(
                f"✅ OI catalog bridge: {len(tools)} generated, "
                f"{attached_count} attached, {registered_count} registered"
            )
            
            return {
                "tools_generated": len(tools),
                "tools_attached": attached_count,
                "tools_registered": registered_count,
                "success": True
            }
            
        except Exception as e:
            logger.error("Failed to register with OI: %s", e, exc_info=True)
            return {"tools_generated": 0, "tools_attached": 0, "success": False}
    
    def _create_tool_wrapper(self, tool_meta: Dict[str, Any]) -> Optional[Callable]:
        """
        Create callable wrapper for API endpoint.
        
        Handles path parameters, query params, and request bodies properly.
        """
        import httpx
        import re
        
        path = tool_meta["path"]
        method = tool_meta["method"]
        raw_url = getattr(self.settings, "base_url", None) or ""
        if not raw_url:
            logger.error("Cannot create tool wrapper: settings.base_url is empty/None")
            return None
        base_url = str(raw_url).rstrip("/")
        
        # Find path parameters
        path_params = re.findall(r'\{([^}]+)\}', path)
        
        def wrapper(**kwargs) -> Dict[str, Any]:
            """Generated API wrapper for backend endpoint."""
            try:
                # Separate path params from other params
                path_values = {}
                other_params = {}
                
                for key, value in kwargs.items():
                    if key in path_params:
                        path_values[key] = value
                    else:
                        other_params[key] = value

                # Request-body support: allow callers to pass `body` as a dict.
                # This is critical for endpoints defined with Pydantic models where
                # OpenAPI request bodies may not flatten cleanly into parameters.
                body = None
                if "body" in other_params and method in ("POST", "PUT", "PATCH"):
                    body = other_params.pop("body")
                    if body is not None and not isinstance(body, dict):
                        return {"error": "Invalid body type", "detail": f"Expected object, got {type(body)}"}
                
                # Build URL with path parameters (URL-encode values to prevent injection)
                url = f"{base_url}{path}"
                for param_name, param_value in path_values.items():
                    url = url.replace(
                        f"{{{param_name}}}",
                        urllib.parse.quote(str(param_value), safe=""),
                    )
                
                # Make request
                with httpx.Client(timeout=30.0) as client:
                    if method == "GET":
                        response = client.get(url, params=other_params)
                    elif method == "POST":
                        response = client.post(url, json=(body if body is not None else other_params))
                    elif method == "PUT":
                        response = client.put(url, json=(body if body is not None else other_params))
                    elif method == "DELETE":
                        response = client.delete(url, params=other_params)
                    elif method == "PATCH":
                        response = client.patch(url, json=(body if body is not None else other_params))
                    else:
                        return {"error": f"Unsupported method: {method}"}
                    
                    response.raise_for_status()
                    
                    # Try to parse JSON response
                    try:
                        return response.json()
                    except Exception:
                        # Return text if not JSON
                        return {"result": response.text}
            
            except httpx.HTTPStatusError as e:
                return {
                    "error": f"HTTP {e.response.status_code}",
                    "detail": e.response.text[:200]
                }
            except Exception as e:
                return {"error": str(e)}
        
        wrapper.__name__ = tool_meta["name"]
        wrapper.__doc__ = tool_meta["description"]
        
        return wrapper
    
    def _format_signature(self, parameters: List[Dict]) -> str:
        """Format parameter signature."""
        params = []
        for p in parameters:
            if p["required"]:
                params.append(p["name"])
            else:
                params.append(f"{p['name']}=None")
        return f"({', '.join(params)})"


# =============================================================================
# Integration Hook
# =============================================================================

def register_backend_tools_with_oi(
    interpreter: Any,
    fastapi_app: Any,
    settings: Any
) -> Dict[str, Any]:
    """
    Clean integration: Register backend APIs with Open Interpreter.
    
    Args:
        interpreter: OI interpreter instance
        fastapi_app: FastAPI app (for OpenAPI spec)
        settings: Settings instance (for config)
        
    Returns:
        Registration statistics
    """
    try:
        bridge = OIToolCatalogBridge(fastapi_app, settings)
        return bridge.register_with_oi(interpreter)
    except Exception as e:
        logger.error("Tool registration failed: %s", e, exc_info=True)
        return {"success": False, "error": str(e)}

