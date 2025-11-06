"""
Integration Loader - YAML-driven unified system for loading all backend integrations

This module provides a production-ready, modular system for loading all integrations
and attaching them to Open Interpreter. Driven by integrations_registry.yaml.

4-LAYER ARCHITECTURE:
    Layer 1: Service Implementation (perplexica/search.py, xlwings/excel.py, etc.)
    Layer 2: Integration Exposure (clean __init__.py with __all__ exports)
    Layer 3: Registry & Metadata (integrations_registry.yaml - THIS DRIVES LOADING)
    Layer 4: Runtime Orchestration (THIS FILE - loads based on YAML config)

Benefits:
    - Single source of truth: integrations_registry.yaml
    - Automatic discovery: add to YAML, no code changes
    - YAML-driven loading: no hardcoded methods
    - Clean separation of concerns
    - Production-ready error handling

Security Improvements:
    - Fixed unsafe type() class creation (original line 227 bug)
    - Safe namespace construction with explicit SimpleNamespace

@.architecture
Incoming: core/runtime/engine.py, config/integrations_registry.yaml, core/integrations/libraries/*, core/integrations/providers/*, Open Interpreter --- {Open Interpreter instance, Dict YAML config, integration modules}
Processing: load_all(), _load_integration(), _attach_namespace(), _register_discoverable_tools(), _attach_function() --- {5 jobs: dynamic_loading, integration_orchestration, namespace_attachment, tool_discovery, yaml_parsing}
Outgoing: Open Interpreter computer, core/runtime/engine.py --- {Attached integrations to computer, Dict[str, Dict] load status, registered tools}
"""

import logging
import sys
import yaml
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
import importlib

logger = logging.getLogger(__name__)


class IntegrationLoader:
    """YAML-driven unified loader for all backend integrations"""
    
    def __init__(self, interpreter):
        """
        Initialize integration loader
        
        Args:
            interpreter: Open Interpreter instance
        """
        self.interpreter = interpreter
        self.computer = interpreter.computer
        self._loaded_integrations = {}  # name -> status dict
        
        # Ensure backend is in path
        self._ensure_backend_path()
        
        # Load registry YAML
        self._registry = self._load_registry()
    
    def _ensure_backend_path(self):
        """Ensure aether-backend directory is in Python path"""
        try:
            current_file = Path(__file__).resolve()
            # Current file is in core/integrations/framework/, go up 4 levels to aether-backend root
            aether_backend_root = current_file.parent.parent.parent.parent
            
            if str(aether_backend_root) not in sys.path:
                sys.path.insert(0, str(aether_backend_root))
                logger.debug(f"Added aether-backend path: {aether_backend_root}")
        except Exception as e:
            logger.warning(f"Failed to add aether-backend to path: {e}")
    
    def _load_registry(self) -> Dict[str, Any]:
        """Load integrations_registry.yaml from NEW backend config"""
        try:
            current_file = Path(__file__).resolve()
            # Look for registry in aether-backend/config/
            # File is in core/integrations/framework/, need to go up 4 levels
            aether_backend_root = current_file.parent.parent.parent.parent
            registry_path = aether_backend_root / "config" / "integrations_registry.yaml"
            
            if not registry_path.exists():
                logger.error(f"Registry not found: {registry_path}")
                logger.error("Expected location: aether-backend/config/integrations_registry.yaml")
                return {"integrations": {}, "runtime": {}}
            
            with open(registry_path, 'r') as f:
                registry = yaml.safe_load(f)
                logger.info(f"Loaded integration registry: {registry_path}")
                return registry or {"integrations": {}, "runtime": {}}
                
        except Exception as e:
            logger.error(f"Failed to load registry: {e}")
            return {"integrations": {}, "runtime": {}}
    
    def load_all(self) -> Dict[str, Dict[str, Any]]:
        """
        YAML-driven integration loading
        
        Loads all enabled integrations from integrations_registry.yaml
        No hardcoded integration logic - fully driven by YAML config
        
        Returns:
            Dict mapping integration name to status dict
        """
        integrations = self._registry.get("integrations", {})
        runtime_config = self._registry.get("runtime", {})
        
        # Get initialization order from YAML
        init_order = runtime_config.get("initialization", {}).get("order", [])
        
        # Load integrations in specified order
        for integration_name in init_order:
            if integration_name not in integrations:
                logger.warning(f"Integration '{integration_name}' in order but not in registry")
                continue
            
            integration_config = integrations[integration_name]
            
            # Check if enabled
            if not integration_config.get("enabled", True):
                logger.info(f"Skipping disabled integration: {integration_name}")
                self._loaded_integrations[integration_name] = {
                    "status": "disabled",
                    "enabled": False
                }
                continue
            
            # Load integration
            status = self._load_integration(integration_name, integration_config)
            self._loaded_integrations[integration_name] = status
        
        # Register discoverable tools
        self._register_discoverable_tools()
        
        # Summary
        loaded_count = sum(1 for s in self._loaded_integrations.values() if s.get("status") == "loaded")
        logger.info(f"✅ Integration loading complete: {loaded_count}/{len(self._loaded_integrations)} loaded")
        
        return self._loaded_integrations
    
    def _load_integration(self, name: str, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Dynamically load an integration based on YAML configuration
        
        Args:
            name: Integration name (perplexica, docling, etc.)
            config: Integration config from YAML
            
        Returns:
            Status dict with load result
        """
        try:
            # Extract Layer 2 exposure config
            layer2 = config.get("layer2_exposure", {})
            init_module = layer2.get("init_file", "")
            exports = layer2.get("exports", [])
            
            # Extract Layer 4 runtime config
            layer4 = config.get("layer4_runtime", {})
            namespace = layer4.get("namespace", "computer")
            attach_as = layer4.get("attach_as", "functions")
            
            if not init_module or not exports:
                return {
                    "status": "error",
                    "error": "Missing layer2_exposure config in YAML"
                }
            
            # Dynamic import from init module
            logger.debug(f"Loading {name}: importing from {init_module}")
            module = importlib.import_module(init_module)
            
            # Get exported functions/classes
            imported_items = {}
            for export_name in exports:
                if hasattr(module, export_name):
                    imported_items[export_name] = getattr(module, export_name)
                else:
                    logger.warning(f"{name}: export '{export_name}' not found in {init_module}")
            
            if not imported_items:
                return {
                    "status": "error",
                    "error": f"No exports found from {init_module}"
                }
            
            # Attach to computer based on attach_as strategy
            if attach_as == "functions":
                self._attach_as_functions(name, imported_items)
                
            elif attach_as == "namespace":
                self._attach_as_namespace(name, namespace, imported_items)
                
            elif attach_as == "builtin":
                # OI built-in, already available
                logger.debug(f"{name}: builtin integration, no attachment needed")
                
            elif attach_as == "dynamic":
                # Dynamic loading (e.g., MCP)
                logger.debug(f"{name}: dynamic integration, skipping automatic attachment")
                
            else:
                logger.warning(f"{name}: unknown attach_as strategy '{attach_as}'")
            
            logger.info(f"✅ {name} integration loaded ({len(imported_items)} exports)")
            return {
                "status": "loaded",
                "enabled": True,
                "exports": list(imported_items.keys()),
                "attach_as": attach_as,
                "namespace": namespace
            }
            
        except Exception as e:
            import traceback
            logger.warning(f"Failed to load {name}: {e}")
            logger.debug(traceback.format_exc())
            return {
                "status": "error",
                "enabled": True,
                "error": str(e)
            }
    
    def _attach_as_functions(self, name: str, imported_items: Dict[str, Any]) -> None:
        """
        Direct attachment: computer.function_name
        
        Args:
            name: Integration name
            imported_items: Dict of function_name -> function
        """
        for func_name, func in imported_items.items():
            setattr(self.computer, func_name, func)
        logger.debug(f"{name}: attached {len(imported_items)} functions directly to computer")
    
    def _attach_as_namespace(self, name: str, namespace: str, imported_items: Dict[str, Any]) -> None:
        """
        Nested namespace attachment: computer.integration.function_name
        
        SECURITY FIX: Uses SimpleNamespace instead of unsafe type() class creation
        
        Args:
            name: Integration name
            namespace: Namespace path (e.g., "computer.xlwings")
            imported_items: Dict of function_name -> function
        """
        # Extract namespace name from path (e.g., "computer.xlwings" -> "xlwings")
        ns_name = namespace.split(".")[-1] if "." in namespace else name
        
        # Check if this integration exports a class (like OmniParalegalTools, DoclingService)
        # These should be instantiated with computer parameter
        class_exports = [
            export_name for export_name, obj in imported_items.items()
            if isinstance(obj, type) and export_name.endswith(('Tools', 'Service', 'Manager'))
        ]
        
        if class_exports:
            # Class-based integration: instantiate with computer
            main_class_name = class_exports[0]
            main_class = imported_items[main_class_name]
            try:
                # Instantiate with computer parameter
                instance = main_class(self.computer)
                setattr(self.computer, ns_name, instance)
                logger.debug(f"{name}: instantiated {main_class_name} and attached to computer.{ns_name}")
            except TypeError:
                # Class doesn't accept computer parameter, instantiate without args
                try:
                    instance = main_class()
                    setattr(self.computer, ns_name, instance)
                    logger.debug(f"{name}: instantiated {main_class_name} (no args) and attached to computer.{ns_name}")
                except Exception as e:
                    logger.error(f"{name}: failed to instantiate {main_class_name}: {e}")
                    # Fallback to attaching class itself
                    setattr(self.computer, ns_name, main_class)
        else:
            # Function-based integration: create namespace with functions
            # Strip common prefix from function names if present
            # e.g., omni_screenshot -> screenshot in computer.omni namespace
            prefix = f"{ns_name}_"
            namespace_items = {}
            for func_name, func in imported_items.items():
                if func_name.startswith(prefix):
                    # Strip prefix: omni_screenshot -> screenshot
                    clean_name = func_name[len(prefix):]
                    namespace_items[clean_name] = func
                else:
                    # No prefix, use as-is
                    namespace_items[func_name] = func
            
            # SECURITY FIX: Use SimpleNamespace instead of unsafe type() class creation
            # Original code (line 227): ns_class = type(ns_name, (), namespace_items)()
            # This was a security risk as it dynamically creates a class without validation
            ns_object = SimpleNamespace(**namespace_items)
            setattr(self.computer, ns_name, ns_object)
            logger.debug(f"{name}: created namespace computer.{ns_name} with {len(namespace_items)} items")
    
    def _register_discoverable_tools(self):
        """
        Register tools for interpreter's tool discovery system
        Uses YAML config to determine which integrations need registration
        """
        try:
            integrations = self._registry.get("integrations", {})
            
            for name, status in self._loaded_integrations.items():
                if status.get("status") != "loaded":
                    continue
                
                config = integrations.get(name, {})
                layer4 = config.get("layer4_runtime", {})
                
                # Check if integration wants discoverability
                if not layer4.get("register_discoverable", False):
                    continue
                
                # Get exports and register with interpreter
                exports = status.get("exports", [])
                registered_count = 0
                for export_name in exports:
                    tool = getattr(self.computer, export_name, None)
                    if tool and callable(tool):
                        # Check if interpreter has add_tool method
                        if hasattr(self.interpreter, 'add_tool'):
                            self.interpreter.add_tool(tool)
                            registered_count += 1
                            logger.debug(f"Registered {export_name} for discovery")
                        else:
                            logger.debug(f"Interpreter doesn't support add_tool, skipping {export_name}")
                
                if registered_count > 0:
                    logger.info(f"✅ {name} tools registered for discovery ({registered_count} tools)")
                
        except Exception as e:
            logger.warning(f"Tool registration failed: {e}")
    
    # ========================================================================
    # PUBLIC QUERY METHODS
    # ========================================================================
    
    def get_loaded_integrations(self) -> Dict[str, Dict[str, Any]]:
        """Get dict of loaded integrations with status"""
        return {
            name: status 
            for name, status in self._loaded_integrations.items()
            if status.get("status") == "loaded"
        }
    
    def is_loaded(self, integration_name: str) -> bool:
        """Check if an integration is successfully loaded"""
        status = self._loaded_integrations.get(integration_name, {})
        return status.get("status") == "loaded"
    
    def get_integration_summary(self) -> str:
        """Get human-readable summary of loaded integrations"""
        loaded = [
            name for name, status in self._loaded_integrations.items()
            if status.get("status") == "loaded"
        ]
        failed = [
            name for name, status in self._loaded_integrations.items()
            if status.get("status") == "error"
        ]
        disabled = [
            name for name, status in self._loaded_integrations.items()
            if status.get("status") == "disabled"
        ]
        
        summary = f"Loaded {len(loaded)}/{len(self._loaded_integrations)} integrations"
        if loaded:
            summary += f": {', '.join(sorted(loaded))}"
        if failed:
            summary += f" | Failed: {', '.join(sorted(failed))}"
        if disabled:
            summary += f" | Disabled: {', '.join(sorted(disabled))}"
        
        return summary
    
    # ========================================================================
    # VALIDATION METHODS
    # ========================================================================
    
    def validate_layer_compliance(self) -> Dict[str, Dict[str, bool]]:
        """
        Validate all integrations for 4-layer architecture compliance
        
        Returns:
            Dict mapping integration name to layer compliance checks
        """
        integrations = self._registry.get("integrations", {})
        validation_rules = self._registry.get("validation", {})
        
        results = {}
        
        for name, config in integrations.items():
            checks = {
                "layer1_implementation": self._validate_layer1(name, config, validation_rules),
                "layer2_exposure": self._validate_layer2(name, config, validation_rules),
                "layer3_metadata": self._validate_layer3(name, config, validation_rules),
                "layer4_runtime": self._validate_layer4(name, config, validation_rules),
            }
            results[name] = checks
        
        return results
    
    def _validate_layer1(self, name: str, config: Dict, rules: Dict) -> bool:
        """Validate Layer 1: Implementation exists"""
        try:
            layer1 = config.get("layer1_implementation", {})
            module_path = layer1.get("module", "")
            
            if not module_path:
                return False
            
            # Try importing the implementation module
            importlib.import_module(module_path)
            return True
            
        except Exception as e:
            logger.debug(f"Layer 1 validation failed for {name}: {e}")
            return False
    
    def _validate_layer2(self, name: str, config: Dict, rules: Dict) -> bool:
        """Validate Layer 2: Clean exposure with __all__"""
        try:
            layer2 = config.get("layer2_exposure", {})
            init_module = layer2.get("init_file", "")
            exports = layer2.get("exports", [])
            
            if not init_module or not exports:
                return False
            
            # Import and check __all__
            module = importlib.import_module(init_module)
            
            # Check __all__ exists
            if not hasattr(module, "__all__"):
                logger.debug(f"Layer 2: {name} missing __all__ list")
                return False
            
            # Check all exports are in __all__
            module_all = getattr(module, "__all__")
            missing = set(exports) - set(module_all)
            if missing:
                logger.debug(f"Layer 2: {name} exports not in __all__: {missing}")
                return False
            
            return True
            
        except Exception as e:
            logger.debug(f"Layer 2 validation failed for {name}: {e}")
            return False
    
    def _validate_layer3(self, name: str, config: Dict, rules: Dict) -> bool:
        """Validate Layer 3: Properly registered in YAML"""
        # If we can read the config, Layer 3 is valid
        required_keys = ["layer1_implementation", "layer2_exposure", "layer3_metadata", "layer4_runtime"]
        return all(key in config for key in required_keys)
    
    def _validate_layer4(self, name: str, config: Dict, rules: Dict) -> bool:
        """Validate Layer 4: Runtime configuration complete"""
        layer4 = config.get("layer4_runtime", {})
        required = ["namespace", "attach_as"]
        return all(key in layer4 for key in required)

