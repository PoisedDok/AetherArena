"""
Registry Gateway

Abstracts the loading and parsing of integrations_registry.yaml into strict Pydantic models.
"""

from typing import Dict, Any, List, Optional
from pathlib import Path
import yaml
from pydantic import BaseModel, Field

from monitoring import get_logger

logger = get_logger(__name__)


class RegistryMetadata(BaseModel):
    version: str
    updated: str
    total_integrations: int
    architecture: str


class Layer1Implementation(BaseModel):
    module: str
    files: List[str] = Field(default_factory=list)


class Layer2Exposure(BaseModel):
    init_file: str
    exports: List[str] = Field(default_factory=list)


class Layer3Metadata(BaseModel):
    tool_count: Any = Field(default=0)
    category: str = Field(default="other")
    requires_service: bool = Field(default=False)
    service_url: Optional[str] = None
    health_check: Optional[str] = None
    api_integration: Optional[str] = None
    dynamic_registration: Optional[bool] = None
    auto_register: Optional[bool] = None
    backend_api: Optional[bool] = None
    api_base: Optional[str] = None


class Layer4Runtime(BaseModel):
    namespace: str
    loader_method: Optional[str] = None
    initialization_order: int = Field(default=999)
    attach_as: str = Field(default="functions")
    namespace_alias: Optional[str] = None
    namespace_alias_prefix: Optional[str] = None
    namespace_alias_strip_prefix: Optional[bool] = None
    register_discoverable: Optional[bool] = None
    bridge_file: Optional[str] = None


class IntegrationConfig(BaseModel):
    enabled: bool = Field(default=False)
    priority: int = Field(default=999)
    type: str = Field(default="unknown")
    description: str = Field(default="")
    layer1_implementation: Layer1Implementation
    layer2_exposure: Layer2Exposure
    layer3_metadata: Layer3Metadata
    layer4_runtime: Layer4Runtime
    dependencies: Dict[str, Any] = Field(default_factory=dict)
    tools_reference: Dict[str, Any] = Field(default_factory=dict)
    layer3_registry: Optional[Dict[str, Any]] = None  # Legacy support


class IntegrationsRegistry(BaseModel):
    metadata: RegistryMetadata
    integrations: Dict[str, IntegrationConfig] = Field(default_factory=dict)
    runtime: Dict[str, Any] = Field(default_factory=dict)
    validation: Dict[str, Any] = Field(default_factory=dict)
    extension_guide: Dict[str, Any] = Field(default_factory=dict)


class RegistryGateway:
    """Gateway to access the integrations registry."""

    def __init__(self, registry_path: Optional[Path] = None):
        if registry_path is None:
            # We look in the config directory next to the root
            # Since this file is in aether-backend/data/infrastructure, we can resolve relative to app root
            self._registry_path = Path(__file__).parent.parent.parent.parent / "config" / "integrations_registry.yaml"
        else:
            self._registry_path = registry_path

    def get_registry(self) -> IntegrationsRegistry:
        """Load and parse the registry YAML into Pydantic models."""
        try:
            if not self._registry_path.exists():
                logger.error("Registry not found: %s", self._registry_path)
                return self._get_empty_registry()
            
            with open(self._registry_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f) or {}
                
            # Handle empty structures gracefully
            if "integrations" not in data:
                data["integrations"] = {}
                
            return IntegrationsRegistry(**data)
        except Exception as e:
            logger.error("Failed to load integrations registry: %s", e, exc_info=True)
            return self._get_empty_registry()

    def get_raw_registry(self) -> Dict[str, Any]:
        """Load the registry YAML as a raw dictionary (for compatibility)."""
        try:
            if not self._registry_path.exists():
                return {"integrations": {}}
            with open(self._registry_path, 'r', encoding='utf-8') as f:
                return yaml.safe_load(f) or {"integrations": {}}
        except Exception as e:
            logger.error("Failed to load raw registry: %s", e)
            return {"integrations": {}}

    def _get_empty_registry(self) -> IntegrationsRegistry:
        return IntegrationsRegistry(
            metadata=RegistryMetadata(version="0.0.0", updated="", total_integrations=0, architecture=""),
            integrations={}
        )
