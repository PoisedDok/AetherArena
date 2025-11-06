"""
Dual YAML Tool Loader for Open Interpreter

Loads tools from TWO registries:
1. tools_registry.yaml - OI built-in tools (browser, files, terminal, etc.)
2. backend_tools_registry.yaml - Aether backend tools (auto-generated)

Clean separation: No hardcoded backend data in OI's YAML.
"""

import yaml
import logging
from pathlib import Path
from typing import Dict, Any, List

logger = logging.getLogger(__name__)


class DualRegistryLoader:
    """Load tools from both OI and backend registries"""
    
    def __init__(self):
        self.oi_registry_path = Path(__file__).parent / "tools_registry.yaml"
        self.backend_registry_path = self._find_backend_registry()
    
    def _find_backend_registry(self) -> Path:
        """Find backend_tools_registry.yaml"""
        # From open-interpreter/interpreter/core/computer/tools_loader.py
        # Go up to find aether-backend/config/backend_tools_registry.yaml
        
        candidates = [
            # If running from aether-backend
            Path(__file__).parent.parent.parent.parent.parent / "config" / "backend_tools_registry.yaml",
            # If running from services/open-interpreter
            Path(__file__).parent.parent.parent.parent.parent.parent / "config" / "backend_tools_registry.yaml",
        ]
        
        for path in candidates:
            if path.exists():
                logger.debug(f"Found backend registry: {path}")
                return path
        
        logger.warning("backend_tools_registry.yaml not found")
        return None
    
    def load_combined_registry(self) -> Dict[str, Any]:
        """
        Load and merge both registries.
        
        Returns:
            Combined registry with both OI and backend tools
        """
        # Load OI tools registry
        oi_data = self._load_oi_registry()
        
        # Load backend tools registry
        backend_data = self._load_backend_registry()
        
        # Merge
        combined = self._merge_registries(oi_data, backend_data)
        
        logger.info(
            f"Loaded tool registries: "
            f"OI categories={len(oi_data.get('categories', {}))}, "
            f"Backend categories={len(backend_data.get('categories', {}))}, "
            f"Combined categories={len(combined.get('categories', {}))}"
        )
        
        return combined
    
    def _load_oi_registry(self) -> Dict[str, Any]:
        """Load OI's tools_registry.yaml"""
        try:
            if not self.oi_registry_path.exists():
                logger.warning(f"OI registry not found: {self.oi_registry_path}")
                return {"categories": {}}
            
            with open(self.oi_registry_path, 'r') as f:
                data = yaml.safe_load(f) or {}
            
            logger.debug(f"Loaded OI registry with {len(data.get('categories', {}))} categories")
            return data
            
        except Exception as e:
            logger.error(f"Failed to load OI registry: {e}")
            return {"categories": {}}
    
    def _load_backend_registry(self) -> Dict[str, Any]:
        """Load backend_tools_registry.yaml"""
        try:
            if not self.backend_registry_path or not self.backend_registry_path.exists():
                logger.debug("Backend registry not available")
                return {"categories": {}}
            
            with open(self.backend_registry_path, 'r') as f:
                data = yaml.safe_load(f) or {}
            
            logger.debug(f"Loaded backend registry with {len(data.get('categories', {}))} categories")
            return data
            
        except Exception as e:
            logger.warning(f"Failed to load backend registry: {e}")
            return {"categories": {}}
    
    def _merge_registries(self, oi_data: Dict, backend_data: Dict) -> Dict[str, Any]:
        """
        Merge OI and backend registries.
        
        Backend tools are prefixed to avoid naming conflicts.
        """
        combined = {
            "metadata": {
                "version": "1.0.0",
                "combined": True,
                "oi_categories": len(oi_data.get("categories", {})),
                "backend_categories": len(backend_data.get("categories", {}))
            },
            "categories": {}
        }
        
        # Add OI categories
        oi_categories = oi_data.get("categories", {})
        for cat_name, cat_data in oi_categories.items():
            combined["categories"][cat_name] = cat_data
        
        # Add backend categories (with "Backend: " prefix if name conflicts)
        backend_categories = backend_data.get("categories", {})
        for cat_name, cat_data in backend_categories.items():
            # Check for conflicts
            if cat_name in combined["categories"]:
                # Prefix backend category
                prefixed_name = f"Backend: {cat_name}"
                combined["categories"][prefixed_name] = cat_data
                logger.debug(f"Renamed backend category '{cat_name}' to '{prefixed_name}'")
            else:
                combined["categories"][cat_name] = cat_data
        
        return combined


# Module-level function for easy use
def load_tool_registry() -> Dict[str, Any]:
    """
    Load combined tool registry from both OI and backend YAMLs.
    
    Returns:
        Merged tool registry
    """
    loader = DualRegistryLoader()
    return loader.load_combined_registry()

