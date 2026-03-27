"""
Backend Tools Registry YAML Generator

Generates backend_tools_registry.yaml automatically from:
- FastAPI OpenAPI spec (actual endpoints)
- integrations_registry.yaml (backend metadata)
- Settings config (URLs, paths)

Clean pipeline:
1. Backend generates backend_tools_registry.yaml on startup
2. OI tool system loads both tools_registry.yaml (OI built-in) and backend_tools_registry.yaml
3. No runtime dynamic registration - everything pre-defined in YAML

@.architecture
Incoming: FastAPI app, config/settings.py, config/integrations_registry.yaml, OpenAPI spec --- {FastAPI instance, Settings, Dict YAML config, Dict OpenAPI spec}
Processing: generate_yaml(), _generate_metadata(), _generate_categories(), _generate_integration_info() --- {JOB_DISCOVER_TOOLS, JOB_LOAD_CONFIG, JOB_SERIALIZE, JOB_TRANSFORM_DATA}
Outgoing: backend_tools_registry.yaml file, Open Interpreter tool system --- {YAML file, Dict tool catalog}
"""

import yaml
import logging
from pathlib import Path
from typing import Dict, Any, List
from datetime import datetime, timezone
import re

logger = logging.getLogger(__name__)


class BackendToolsYAMLGenerator:
    """Generate backend_tools_registry.yaml from backend API specs"""

    def _sanitize_identifier_segment(self, value: str) -> str:
        """
        Sanitize an OpenAPI path/tag segment into a valid Python identifier segment.

        - Converts '-' to '_'
        - Replaces any non [0-9A-Za-z_] characters with '_'
        - Collapses repeated underscores
        - Strips leading/trailing underscores

        NOTE: This is required because backend API paths legitimately contain hyphens
        (e.g. 'session-map'), but tool names must be valid Python identifiers so
        agents can call them as `computer.<tool_name>(...)`.
        """
        s = (value or "").strip().replace("-", "_")
        s = re.sub(r"[^0-9A-Za-z_]", "_", s)
        s = re.sub(r"_+", "_", s).strip("_")
        return s
    
    def __init__(self, fastapi_app: Any, settings: Any):
        """
        Initialize YAML generator.
        
        Args:
            fastapi_app: FastAPI application instance (for OpenAPI spec)
            settings: Settings instance (for config)
        """
        self.app = fastapi_app
        self.settings = settings
        self._registry = self._load_integrations_registry()
        # Cache OpenAPI spec for schema dereferencing ($ref)
        try:
            self._openapi_spec: Dict[str, Any] = self.app.openapi()
        except Exception:
            self._openapi_spec = {}

    def _resolve_schema_ref(self, schema: Dict[str, Any]) -> Dict[str, Any]:
        """
        Resolve a local OpenAPI $ref like "#/components/schemas/Foo" into the target schema dict.
        Returns the original schema if not resolvable.
        """
        ref = schema.get("$ref")
        if not ref or not isinstance(ref, str):
            return schema
        if not ref.startswith("#/"):
            return schema
        parts = ref.lstrip("#/").split("/")
        target: Any = self._openapi_spec
        try:
            for part in parts:
                target = target[part]
            if isinstance(target, dict):
                return target
        except Exception:
            return schema
        return schema
    
    def _load_integrations_registry(self) -> Dict[str, Any]:
        """Load integrations_registry.yaml from backend config directory."""
        try:
            registry_path = self.settings.config_dir / "integrations_registry.yaml"
            
            if not registry_path.exists():
                logger.warning("Registry not found: %s", registry_path)
                return {"integrations": {}}
            
            with open(registry_path, 'r') as f:
                return yaml.safe_load(f) or {"integrations": {}}
        except Exception as e:
            logger.error("Failed to load registry: %s", e)
            return {"integrations": {}}
    
    def generate_yaml(self, output_path: Path) -> bool:
        """
        Generate backend_tools_registry.yaml.
        
        Args:
            output_path: Path to write YAML file
            
        Returns:
            True if successful
        """
        try:
            logger.info("Generating backend_tools_registry.yaml...")
            
            # Build YAML structure
            yaml_data = {
                "metadata": self._generate_metadata(),
                "categories": self._generate_categories(),
                "integration_info": self._generate_integration_info()
            }
            
            # Write YAML file
            with open(output_path, 'w') as f:
                yaml.dump(
                    yaml_data,
                    f,
                    default_flow_style=False,
                    sort_keys=False,
                    allow_unicode=True
                )
            
            logger.info("Generated backend_tools_registry.yaml: %s", output_path)
            return True
            
        except Exception as e:
            logger.error("Failed to generate YAML: %s", e, exc_info=True)
            return False
    
    def _generate_metadata(self) -> Dict[str, Any]:
        """Generate metadata section."""
        integrations = self._registry.get("integrations", {})
        enabled_count = sum(1 for cfg in integrations.values() if cfg.get("enabled"))
        
        return {
            "version": "1.0.0",
            "generated": datetime.now(timezone.utc).isoformat(),
            "source": "Aether Backend API",
            "backend_version": self.settings.app_version,
            "backend_url": self.settings.base_url,
            "total_integrations": len(integrations),
            "enabled_integrations": enabled_count,
            "note": "Auto-generated from OpenAPI spec + integrations_registry.yaml"
        }
    
    def _generate_categories(self) -> Dict[str, Any]:
        """Generate categories with tools from OpenAPI spec."""
        categories = {}
        integrations = self._registry.get("integrations", {})
        
        # Get OpenAPI spec
        openapi_spec = self.app.openapi()
        paths = openapi_spec.get("paths", {})
        
        # Group endpoints by integration/tag
        for path, methods in paths.items():
            for method, endpoint_spec in methods.items():
                if method.upper() not in ["GET", "POST", "PUT", "DELETE", "PATCH"]:
                    continue
                
                # Enforce explicit agent tool whitelist
                if not endpoint_spec.get("is_agent_tool"):
                    continue
                
                # Extract tags (integration name)
                tags = endpoint_spec.get("tags", [])
                if not tags:
                    continue
                
                tag = tags[0]
                
                # Get integration config - tag may not directly match integration name
                # Backend API tags (ocr, tts, etc.) are API categories, not integration names
                integration_config = integrations.get(tag, {})
                
                # If no direct match, these are backend API endpoints
                # Map common API tags to descriptions
                if not integration_config:
                    integration_config = {
                        "description": self._get_api_description(tag),
                        "enabled": True,  # Backend APIs are always enabled
                        "layer3_metadata": {
                            "category": self._map_api_tag_to_category(tag),
                            "requires_service": False
                        }
                    }
                elif not integration_config.get("enabled"):
                    continue
                
                # Get category info
                layer3 = integration_config.get("layer3_metadata", {})
                category_key = layer3.get("category", "other")
                category_name = self._format_category_name(category_key)
                
                # Generate tool metadata first (to get tool path for refinement)
                tool = self._create_tool_metadata(path, method, endpoint_spec, tag)
                if not tool:
                    continue
                
                # Refine category based on specific tool path
                refined_category = self._refine_category_by_tool_path(category_name, path)
                
                # Initialize category if needed
                if refined_category not in categories:
                    categories[refined_category] = {
                        "name": refined_category,
                        "description": integration_config.get("description", ""),
                        "integration": tag,
                        "requires_service": layer3.get("requires_service", False),
                        "service_url": layer3.get("service_url"),
                        "tools": []
                    }
                
                # Add tool to refined category
                categories[refined_category]["tools"].append(tool)
        
        return categories
    
    def _format_category_name(self, category_key: str) -> str:
        """
        Format category key to readable name using 12 functionality-based categories.
        
        New Structure:
        1. System & Health - health checks, system status, backend registry
        2. Chat Management - chat CRUD, history, messages  
        3. Context & Memory - context tracking, summarization, export
        4. Artifacts & Traceability - artifact CRUD, message linking
        5. Trails & Hierarchy - groups/subgroups/nodes, session mapping
        6. Document Processing - Omni (screen tools), OCR, screen analysis
        7. Datastore & Search - Document parsing, vector search, AETHER-RAG
        8. Profiles & Skills - profile/skill management
        9. Notebook & Python - module management, imports
        10. MCP Servers - MCP lifecycle, tool discovery
        11. Text-to-Speech - TTS engines, synthesis
        12. Excel Automation - XLWings operations
        """
        category_map = {
            # Legacy integrations
            "web_search_extraction": "Web Search & Extraction",
            "document_processing_vision": "Document Processing",
            "excel_automation_data_analysis": "Excel Automation",
            "browser_automation": "Web Search & Extraction",
            
            # Backend API tags -> new categories
            "health": "System & Health",
            "services": "System & Health",
            "backends": "System & Health",
            "terminal": "System & Health",
            
            "chat": "Chat Management",
            
            "context": "Context & Memory",
            
            "storage": "Artifacts & Traceability",  # Will be further refined by tool path
            
            "omni": "Document Processing",
            "ocr": "Document Processing",
            
            "datastore": "Datastore & Search",
            
            "profiles": "Profiles & Skills",
            "skills": "Profiles & Skills",
            
            "notebook": "Notebook & Python",
            
            "mcp": "MCP Servers",
            "mcp_tools": "MCP Servers",
            
            "tts": "Text-to-Speech",
            
            "xlwings": "Excel Automation"
        }
        
        # Return mapped category or title-case fallback
        return category_map.get(category_key, category_key.replace('_', ' ').title())
    
    def _refine_category_by_tool_path(self, category_name: str, tool_path: str) -> str:
        """
        Refine category based on specific tool path for better granularity.
        
        This handles cases where a single API tag (e.g., "storage") maps to
        multiple functional categories based on the specific endpoint.
        """
        # Storage API refinement
        if category_name == "Artifacts & Traceability":
            if 'storage/chats' in tool_path and 'context' in tool_path:
                return "Context & Memory"
            elif 'storage/chats' in tool_path and ('groups' in tool_path or 'subgroups' in tool_path or 'nodes' in tool_path or 'session-map' in tool_path or 'stats' in tool_path):
                return "Trails & Hierarchy"
            elif 'storage/chats' in tool_path and 'messages' not in tool_path and 'artifacts' not in tool_path:
                return "Chat Management"
            elif 'storage' in tool_path and 'health' in tool_path:
                return "System & Health"
            # Keep "Artifacts & Traceability" for artifact and traceability endpoints
        
        return category_name
    
    def _map_api_tag_to_category(self, tag: str) -> str:
        """Map FastAPI tag to category key."""
        tag_to_category = {
            "ocr": "ocr",
            "tts": "tts",
            "notebook": "notebook",
            "omni": "omni",
            "xlwings": "xlwings",
            "backends": "backends",
            "chat": "chat",
            "files": "files",
            "profiles": "profiles",
            "skills": "skills",
            "storage": "storage",
            "mcp": "mcp_tools"
        }
        return tag_to_category.get(tag, "other")
    
    def _get_api_description(self, tag: str) -> str:
        """Get description for API tag."""
        descriptions = {
            "ocr": "OCR and document processing APIs",
            "tts": "Text-to-speech synthesis APIs",
            "notebook": "Python notebook and runtime APIs",
            "omni": "Omni screen tools (screenshot + vision analysis) APIs",
            "xlwings": "Excel automation APIs",
            "backends": "Backend registry and management APIs",
            "chat": "Chat and conversation APIs",
            "files": "File management APIs",
            "profiles": "Profile management APIs",
            "skills": "Skills management APIs",
            "storage": "Storage management APIs",
            "mcp": "MCP server management APIs"
        }
        return descriptions.get(tag, f"{tag.title()} APIs")
    
    def _create_tool_metadata(
        self,
        path: str,
        method: str,
        spec: Dict[str, Any],
        integration: str
    ) -> Dict[str, Any]:
        """Create tool metadata from OpenAPI endpoint."""
        import re
        
        # Extract path parameters for disambiguation
        path_params = re.findall(r'\{([^}]+)\}', path)
        # Universal detection: any path parameter indicates specific resource retrieval
        # This handles all current and future endpoint patterns without maintaining whitelist
        has_id_param = bool(path_params)
        
        # Clean path (remove parameters but track if we need disambiguation)
        clean_path = re.sub(r'\{[^}]+\}', '', path)
        raw_parts = [p for p in clean_path.split("/") if p and p not in ["api", "v1", "v2"]]
        parts = [self._sanitize_identifier_segment(p) for p in raw_parts if self._sanitize_identifier_segment(p)]
        
        # For endpoints with parameters, include last param name for disambiguation
        # This handles cases like /servers/{server_id}/tools vs /servers/{server_name}/tools
        if path_params:
            # Only include param name if it's not a common ID pattern
            last_param = path_params[-1]
            common_id_params = [
                'id',
                'chat_id',
                'server_id',
                'message_id',
                'artifact_id',
                'group_id',
                'user_id',
                'agent_name',
                'job_id'
            ]
            if last_param not in common_id_params:
                # Insert param name before last path segment for clarity
                if len(parts) > 0:
                    parts.insert(-1, self._sanitize_identifier_segment(last_param))
        
        # Generate base tool name
        base_name = "_".join([p for p in parts if p])
        
        # Apply semantic action naming (instead of HTTP method prefix)
        tool_name = self._apply_semantic_action(base_name, method, path, spec, has_id_param)
        
        # Extract metadata
        summary = spec.get("summary", "")
        description = spec.get("description", summary) or f"{method.upper()} {path}"
        
        # Extract parameters
        parameters = self._extract_parameters(spec)
        
        # Determine complexity
        param_count = len(parameters)
        complexity = (
            "simple" if param_count <= 2
            else "moderate" if param_count <= 5
            else "advanced"
        )
        
        return {
            "name": tool_name,
            "path": f"computer.{tool_name}",
            "api_endpoint": path,
            "http_method": method.upper(),
            "complexity": complexity,
            "description": description,
            "signature": self._format_signature(tool_name, parameters),
            "parameters": parameters,
            "use_cases": [f"Use {integration} backend API: {summary or path}"],
            "examples": [f"computer.{tool_name}(...)"],
            "tags": [integration, "backend_api", "aether"],
            "integration": integration
        }
    
    def _extract_parameters(self, spec: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Extract parameters from OpenAPI spec with defaults/enums."""
        parameters = []
        
        # Query/path parameters
        for param in spec.get("parameters", []):
            name = param.get("name")
            # Skip internal Aether tracking headers that should be handled by the infrastructure
            if name and (name.lower().startswith("x-") or name.lower() in ("authorization", "cookie", "referer", "user-agent")):
                continue

            schema = param.get("schema", {}) if isinstance(param, dict) else {}
            parameters.append({
                "name": name,
                "type": schema.get("type", "string"),
                "required": param.get("required", False),
                "description": param.get("description", ""),
                "default": schema.get("default"),
                "enum": schema.get("enum"),
            })
        
        # Request body parameters
        request_body = spec.get("requestBody", {})
        content = request_body.get("content", {})
        body_fields_extracted = False
        
        for content_type, content_spec in content.items():
            schema = content_spec.get("schema", {})
            # Dereference $ref schemas so we can extract fields for Pydantic models
            schema = self._resolve_schema_ref(schema)
            properties = schema.get("properties", {})
            required = schema.get("required", [])
            
            for prop_name, prop_spec in properties.items():
                prop_spec = prop_spec if isinstance(prop_spec, dict) else {}
                parameters.append({
                    "name": prop_name,
                    "type": prop_spec.get("type", "string"),
                    "required": prop_name in required,
                    "description": prop_spec.get("description", ""),
                    "default": prop_spec.get("default"),
                    "enum": prop_spec.get("enum"),
                })
                body_fields_extracted = True

        # If a requestBody exists but we couldn't extract properties (e.g. $ref or complex schema),
        # expose a single `body` parameter so tools remain callable.
        if request_body and not any(p.get("name") == "body" for p in parameters):
            has_any_body_schema = any(
                isinstance(ct.get("schema", {}), dict) and ct.get("schema", {})
                for ct in content.values()
            )
            if has_any_body_schema and not body_fields_extracted:
                parameters.append({
                    "name": "body",
                    "type": "object",
                    "required": bool(request_body.get("required", False)),
                    "description": "JSON request body (object)",
                    "default": None,
                    "enum": None,
                })
        
        return parameters
    
    def _apply_semantic_action(
        self,
        base_name: str,
        method: str,
        path: str,
        spec: Dict[str, Any],
        has_id_param: bool
    ) -> str:
        """
        Apply action_source naming: action + source.
        """
        method_upper = method.upper()
        summary = spec.get("summary", "").lower()

        action_verbs = {
            "search",
            "list",
            "get",
            "create",
            "update",
            "delete",
            "execute",
            "start",
            "stop",
            "status",
            "health",
            "configure",
            "config",
            "jobs",
            "cancel",
            "retry",
            "connect",
            "disconnect",
            "export",
            "summarize",
            "test",
            "run",
            "stream",
            "send",
            "add",
            "save",
            "import",
            "close",
            "analyze",
            "screenshot",
            "capture",
            "info",
            "read",
            "write",
            "format",
            "convert",
            "upload",
            "synthesize"
        }

        # Build clean path segments without params or version prefixes.
        clean_path = re.sub(r"\{[^}]+\}", "", path)
        raw_parts = [p for p in clean_path.split("/") if p and p not in ["api", "v1", "v2"]]
        parts = [self._sanitize_identifier_segment(p) for p in raw_parts if self._sanitize_identifier_segment(p)]

        def _source_from_segments(segments: List[str]) -> str:
            return "_".join([s for s in segments if s]) or base_name

        if parts:
            first = parts[0]
            last = parts[-1]

            if first in action_verbs and len(parts) > 1:
                return f"{first}_{_source_from_segments(parts[1:])}"
            if last in action_verbs and len(parts) > 1:
                return f"{last}_{_source_from_segments(parts[:-1])}"

            for idx, segment in enumerate(parts):
                if segment in action_verbs:
                    source_segments = parts[:idx] + parts[idx + 1 :]
                    return f"{segment}_{_source_from_segments(source_segments or ['system'])}"

            if first in action_verbs and len(parts) == 1:
                return f"{first}_system"

        # HTTP method fallback for non-action paths
        if method_upper == "GET":
            action = "get" if has_id_param else "list"
        elif method_upper == "PUT":
            action = "update"
        elif method_upper == "DELETE":
            action = "delete"
        elif method_upper == "PATCH":
            action = "update"
        elif method_upper == "POST":
            action = self._determine_post_action(path.lower(), summary, base_name) or "create"
        else:
            action = "call"

        return f"{action}_{base_name}"
    
    def _determine_post_action(self, path_lower: str, summary: str, base_name: str) -> str:
        """Determine semantic action for POST operations."""
        
        # Chat operations - distinguish storage vs live chat
        if 'chat' in path_lower or 'chat' in base_name:
            # Storage API - use "create" for CRUD operations
            if 'storage' in path_lower:
                return 'create'
            # Live chat API - use "send" or "stream"
            if 'stream' in path_lower or 'stream' in summary:
                return 'stream'
            return 'send'
        
        # MCP server operations
        if 'mcp' in path_lower and 'servers' in path_lower:
            if 'start' in path_lower or 'start' in summary:
                return 'start'
            if path_lower.endswith('/servers') or path_lower.endswith('mcp_servers'):
                return 'register'
            if 'tools' in path_lower and ('execute' in summary or 'call' in summary):
                return 'execute'
        
        # Storage operations (after chat check to avoid conflicts)
        if 'storage' in path_lower or 'storage' in base_name:
            if 'traceability' in path_lower:
                return 'save'
            if 'context' in path_lower and 'summarize' in path_lower:
                return 'create'  # Changed from 'summarize' - action in path already
            if 'artifacts' in path_lower and 'update-message-id' in path_lower:
                return 'link'
            if 'messages' in path_lower or 'artifacts' in path_lower:
                return 'create'
            return 'create'
        
        # Datastore operations - keep specific action
        if 'datastore' in path_lower:
            parts = path_lower.split('/')
            last_part = parts[-1] if parts else ''
            if last_part in ['ingest', 'query', 'search', 'convert', 'upload']:
                return ''  # Action already in base_name
            return 'create'
        
        # Document/vision operations - keep specific action
        if any(action in path_lower for action in ['screenshot', 'parse', 'analyze', 'ocr', 'convert']):
            return ''  # Action already in base_name
        
        # Excel/XLWings operations - keep specific action
        if 'xlwings' in path_lower or 'xlwings' in base_name:
            parts = path_lower.split('/')
            last_part = parts[-1] if parts else ''
            if last_part in ['create', 'save', 'close', 'write', 'read', 'format']:
                return ''  # Action already in base_name
            return 'create'
        
        # TTS operations - keep specific action
        if 'tts' in path_lower:
            if any(action in path_lower for action in ['synthesize', 'stream', 'initialize']):
                return ''  # Action already in base_name
            return 'synthesize'
        
        # Profile operations
        if 'profiles' in path_lower and 'switch' in path_lower:
            return 'switch'
        
        # Skills operations
        if 'skills' in path_lower:
            if 'import' in path_lower:
                return 'import'
            return 'create'
        
        # Notebook operations - keep specific action
        if 'notebook' in path_lower:
            parts = path_lower.split('/')
            last_part = parts[-1] if parts else ''
            if last_part in ['add', 'import', 'search', 'list']:
                return ''  # Action already in base_name
            return 'execute'
        
        # Default: create
        return 'create'
    
    def _format_signature(self, tool_name: str, parameters: List[Dict]) -> str:
        """Format parameter signature."""
        params = []
        for p in parameters:
            param_str = f"{p['name']}: {p['type']}"
            if not p["required"]:
                param_str += " = None"
            params.append(param_str)
        
        return f"{tool_name}({', '.join(params)})"
    
    def _generate_integration_info(self) -> Dict[str, Any]:
        """Generate integration information section."""
        integrations = self._registry.get("integrations", {})
        info = {}
        
        for name, config in integrations.items():
            if not config.get("enabled"):
                continue
            
            layer3 = config.get("layer3_metadata", {})
            layer4 = config.get("layer4_runtime", {})
            
            info[name] = {
                "type": config.get("type", "unknown"),
                "description": config.get("description", ""),
                "priority": config.get("priority", 999),
                "category": layer3.get("category", ""),
                "tool_count": layer3.get("tool_count", 0),
                "requires_service": layer3.get("requires_service", False),
                "service_url": layer3.get("service_url"),
                "namespace": layer4.get("namespace", "computer"),
                "api_prefix": self._get_api_prefix(name)
            }
        
        return info
    
    def _get_api_prefix(self, integration_name: str) -> str:
        """Get API prefix for integration."""
        prefix_map = {
            "ocr": "/v1/ocr",
            "tts": "/v1/tts",
            "notebook": "/v1/notebook",
            "omni": "/v1/omni",
            "xlwings": "/v1/xlwings",
            "backends": "/v1/backends"
        }
        return prefix_map.get(integration_name, f"/v1/{integration_name}")


def generate_backend_tools_yaml(
    fastapi_app: Any,
    settings: Any,
    output_path: Path = None
) -> bool:
    """
    Generate backend_tools_registry.yaml.
    
    Args:
        fastapi_app: FastAPI app instance
        settings: Settings instance
        output_path: Optional output path (defaults to writable config dir)
        
    Returns:
        True if successful
    """
    try:
        generator = BackendToolsYAMLGenerator(fastapi_app, settings)
        
        if output_path is None:
            # In production (frozen binary), settings.config_dir resolves to
            # _internal/config/ which is read-only. Use AETHER_BACKEND_ROOT
            # (writable data dir) instead.
            import os
            import sys
            if getattr(sys, 'frozen', False):
                backend_root = os.environ.get("AETHER_BACKEND_ROOT")
                if backend_root:
                    writable_config = Path(backend_root) / "config"
                    writable_config.mkdir(parents=True, exist_ok=True)
                    output_path = writable_config / "backend_tools_registry.yaml"
                else:
                    output_path = settings.config_dir / "backend_tools_registry.yaml"
            else:
                output_path = settings.config_dir / "backend_tools_registry.yaml"
        
        return generator.generate_yaml(output_path)
        
    except Exception as e:
        logger.error("Failed to generate backend tools YAML: %s", e, exc_info=True)
        return False

