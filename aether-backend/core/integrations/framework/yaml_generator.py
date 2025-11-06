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
Processing: generate_yaml(), _generate_metadata(), _generate_categories(), _generate_integration_info() --- {4 jobs: metadata_generation, openapi_parsing, tool_catalog_generation, yaml_generation}
Outgoing: backend_tools_registry.yaml file, Open Interpreter tool system --- {YAML file, Dict tool catalog}
"""

import yaml
import logging
from pathlib import Path
from typing import Dict, Any, List
from datetime import datetime

logger = logging.getLogger(__name__)


class BackendToolsYAMLGenerator:
    """Generate backend_tools_registry.yaml from backend API specs"""
    
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
    
    def _load_integrations_registry(self) -> Dict[str, Any]:
        """Load integrations_registry.yaml from backend config directory."""
        try:
            registry_path = self.settings.config_dir / "integrations_registry.yaml"
            
            if not registry_path.exists():
                logger.warning(f"Registry not found: {registry_path}")
                return {"integrations": {}}
            
            with open(registry_path, 'r') as f:
                return yaml.safe_load(f) or {"integrations": {}}
        except Exception as e:
            logger.error(f"Failed to load registry: {e}")
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
            
            logger.info(f"✅ Generated backend_tools_registry.yaml: {output_path}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to generate YAML: {e}", exc_info=True)
            return False
    
    def _generate_metadata(self) -> Dict[str, Any]:
        """Generate metadata section."""
        integrations = self._registry.get("integrations", {})
        enabled_count = sum(1 for cfg in integrations.values() if cfg.get("enabled"))
        
        return {
            "version": "1.0.0",
            "generated": datetime.now().isoformat(),
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
                
                # Skip internal endpoints
                if self._should_skip_endpoint(path):
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
                
                # Initialize category if needed
                if category_name not in categories:
                    categories[category_name] = {
                        "name": category_name,
                        "description": integration_config.get("description", ""),
                        "integration": tag,
                        "requires_service": layer3.get("requires_service", False),
                        "service_url": layer3.get("service_url"),
                        "tools": []
                    }
                
                # Generate tool metadata
                tool = self._create_tool_metadata(path, method, endpoint_spec, tag)
                if tool:
                    categories[category_name]["tools"].append(tool)
        
        return categories
    
    def _should_skip_endpoint(self, path: str) -> bool:
        """Check if endpoint should be skipped."""
        # Skip exact matches or prefix matches for system endpoints
        skip_exact = [
            "/", "/docs", "/redoc", "/openapi.json",
            "/v1/settings", "/v1/settings/reload",
            "/v1/models", "/v1/models/active", "/v1/models/capabilities"
        ]
        
        # Skip prefixes for system endpoints
        skip_prefixes = [
            "/v1/health",  # All health endpoints
        ]
        
        # Check exact match
        if path in skip_exact:
            return True
        
        # Check prefix match
        for prefix in skip_prefixes:
            if path.startswith(prefix):
                return True
        
        return False
    
    def _format_category_name(self, category_key: str) -> str:
        """Format category key to readable name."""
        category_map = {
            "web_search_extraction": "Web Search & Extraction",
            "document_processing_vision": "Files & Documents",
            "excel_automation_data_analysis": "Excel Automation",
            "system_operations": "System & Terminal",
            "browser_automation": "Web Search & Extraction",
            "mcp_tools": "MCP Tools",
            "ocr": "Files & Documents",
            "tts": "Audio & Speech",
            "xlwings": "Excel Automation",
            "omni": "Vision",
            "notebook": "System & Terminal",
            "backends": "System & Terminal",
            "chat": "AI & LLM",
            "files": "Files & Documents",
            "profiles": "System & Terminal",
            "skills": "System & Terminal",
            "storage": "Files & Documents"
        }
        return category_map.get(category_key, category_key.replace('_', ' ').title())
    
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
            "omni": "OmniParser vision and screen analysis APIs",
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
        
        # Generate tool name
        clean_path = re.sub(r'\{[^}]+\}', '', path)
        parts = [p for p in clean_path.split("/") if p and p not in ["api", "v1", "v2"]]
        tool_name = "_".join(parts)
        
        if method.upper() != "GET":
            tool_name = f"{method.lower()}_{tool_name}"
        
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
        """Extract parameters from OpenAPI spec."""
        parameters = []
        
        # Query/path parameters
        for param in spec.get("parameters", []):
            parameters.append({
                "name": param.get("name"),
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
        output_path: Optional output path (defaults to backend/config/)
        
    Returns:
        True if successful
    """
    try:
        generator = BackendToolsYAMLGenerator(fastapi_app, settings)
        
        if output_path is None:
            output_path = settings.config_dir / "backend_tools_registry.yaml"
        
        return generator.generate_yaml(output_path)
        
    except Exception as e:
        logger.error(f"Failed to generate backend tools YAML: {e}", exc_info=True)
        return False

