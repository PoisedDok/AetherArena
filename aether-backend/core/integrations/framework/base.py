"""
Base Integration Classes - Foundation for all Aether integrations

Provides abstract base classes, protocols, and data structures for building
production-ready integrations with standardized interfaces.

Architecture:
- IntegrationProtocol: Protocol defining integration interface
- BaseIntegration: Abstract base class with complete lifecycle management
- ServiceIntegration: Convenience class for service-based integrations
- LibraryIntegration: Convenience class for library integrations
- IntegrationHealth: Health check result data structure
- IntegrationMetadata: Integration metadata structure

Production Features:
- Complete lifecycle management (load, health_check, cleanup)
- State tracking (NOT_LOADED, LOADING, LOADED, FAILED, DISABLED)
- Error handling and logging
- Health monitoring
- Metadata management
- Tool registration

@.architecture
Incoming: core/integrations/framework/loader.py, core/integrations/libraries/*, core/integrations/providers/*, Open Interpreter computer --- {Any computer instance, str name, IntegrationType enum, str service_url}
Processing: load(), health_check(), get_metadata(), cleanup(), _attach_function(), _register_tool() --- {6 jobs: health_checking, integration_loading, lifecycle_management, metadata_management, state_management, tool_registration}
Outgoing: Integration implementations, core/integrations/framework/loader.py --- {bool load success, IntegrationHealth, IntegrationMetadata, List[str] tools, IntegrationStatus enum}
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol


logger = logging.getLogger(__name__)


# ============================================================================
# ENUMS AND STATUS
# ============================================================================


class IntegrationStatus(Enum):
    """Integration status states"""
    NOT_LOADED = "not_loaded"
    LOADING = "loading"
    LOADED = "loaded"
    FAILED = "failed"
    DISABLED = "disabled"


class IntegrationType(Enum):
    """Integration types"""
    SERVICE = "service"      # External service (Perplexica, Docling)
    LIBRARY = "library"      # Python library (xlwings, notebook)
    BRIDGE = "bridge"        # Bridge to another system (Omni, MCP)
    BUILTIN = "builtin"      # OI built-in (browser, files)
    DYNAMIC = "dynamic"      # Dynamically loaded (MCP servers)


# ============================================================================
# DATA CLASSES
# ============================================================================


@dataclass
class IntegrationMetadata:
    """Standard metadata for all integrations"""
    name: str
    version: str = "1.0.0"
    description: str = ""
    integration_type: IntegrationType = IntegrationType.LIBRARY
    category: str = ""
    tool_count: int = 0
    requires_service: bool = False
    service_url: Optional[str] = None
    health_check_url: Optional[str] = None
    dependencies: List[str] = field(default_factory=list)
    optional_dependencies: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)
    author: str = "Aether"
    documentation_url: Optional[str] = None


@dataclass
class IntegrationHealth:
    """Health check result"""
    healthy: bool
    status_code: Optional[int] = None
    message: str = ""
    response_time_ms: Optional[float] = None
    last_checked: Optional[str] = None
    details: Dict[str, Any] = field(default_factory=dict)


# ============================================================================
# PROTOCOL
# ============================================================================


class IntegrationProtocol(Protocol):
    """Protocol defining integration interface"""
    
    def load(self, computer: Any) -> bool:
        """Load integration and attach to computer instance"""
        ...
    
    def health_check(self) -> IntegrationHealth:
        """Check integration health"""
        ...
    
    def get_metadata(self) -> IntegrationMetadata:
        """Get integration metadata"""
        ...
    
    def get_tools(self) -> List[str]:
        """Get list of tool names provided by integration"""
        ...
    
    def cleanup(self) -> None:
        """Cleanup resources"""
        ...


# ============================================================================
# BASE INTEGRATION
# ============================================================================


class BaseIntegration(ABC):
    """
    Abstract base class for all Aether integrations.
    
    Provides:
    - Standard loading interface
    - Health check functionality
    - Metadata management
    - Error handling and logging
    - State management
    - Tool registration
    
    Usage:
        class MyIntegration(BaseIntegration):
            def __init__(self):
                super().__init__(name="my_integration")
            
            def _do_load(self, computer) -> bool:
                # Implementation
                return True
            
            def _do_health_check(self) -> IntegrationHealth:
                # Implementation
                return IntegrationHealth(healthy=True)
    """
    
    def __init__(
        self,
        name: str,
        version: str = "1.0.0",
        integration_type: IntegrationType = IntegrationType.LIBRARY,
        requires_service: bool = False,
    ):
        """
        Initialize base integration
        
        Args:
            name: Integration name
            version: Version string
            integration_type: Type of integration
            requires_service: Whether integration requires external service
        """
        self.name = name
        self.version = version
        self.integration_type = integration_type
        self.requires_service = requires_service
        self.status = IntegrationStatus.NOT_LOADED
        self._computer: Optional[Any] = None
        self._tools: List[str] = []
        self._load_error: Optional[str] = None
        
        # Initialize logger
        self.logger = logging.getLogger(f"integration.{name}")
    
    # ========================================================================
    # PUBLIC API
    # ========================================================================
    
    def load(self, computer: Any) -> bool:
        """
        Load integration and attach to computer instance.
        
        Args:
            computer: Open Interpreter computer instance
            
        Returns:
            True if loaded successfully, False otherwise
        """
        if self.status == IntegrationStatus.LOADED:
            self.logger.info(f"{self.name} already loaded")
            return True
        
        self.status = IntegrationStatus.LOADING
        self.logger.info(f"Loading {self.name} integration...")
        
        try:
            # Validate computer instance
            if computer is None:
                raise ValueError("Computer instance cannot be None")
            
            self._computer = computer
            
            # Call implementation-specific load method
            success = self._do_load(computer)
            
            if success:
                self.status = IntegrationStatus.LOADED
                self.logger.info(f"✅ {self.name} loaded successfully")
                return True
            else:
                self.status = IntegrationStatus.FAILED
                self._load_error = "Load method returned False"
                self.logger.error(f"❌ {self.name} load failed")
                return False
                
        except Exception as e:
            self.status = IntegrationStatus.FAILED
            self._load_error = str(e)
            self.logger.error(f"❌ {self.name} load error: {e}")
            import traceback
            self.logger.debug(traceback.format_exc())
            return False
    
    def health_check(self) -> IntegrationHealth:
        """
        Check integration health.
        
        Returns:
            IntegrationHealth object with status
        """
        try:
            if self.status != IntegrationStatus.LOADED:
                return IntegrationHealth(
                    healthy=False,
                    message=f"Integration not loaded (status: {self.status.value})",
                )
            
            # Call implementation-specific health check
            return self._do_health_check()
            
        except Exception as e:
            self.logger.error(f"Health check error: {e}")
            return IntegrationHealth(
                healthy=False, message=f"Health check failed: {str(e)}"
            )
    
    def get_metadata(self) -> IntegrationMetadata:
        """
        Get integration metadata.
        
        Returns:
            IntegrationMetadata object
        """
        try:
            # Get base metadata
            metadata = IntegrationMetadata(
                name=self.name,
                version=self.version,
                integration_type=self.integration_type,
                requires_service=self.requires_service,
                tool_count=len(self._tools),
            )
            
            # Call implementation-specific metadata enrichment
            return self._enrich_metadata(metadata)
            
        except Exception as e:
            self.logger.error(f"Metadata retrieval error: {e}")
            return IntegrationMetadata(
                name=self.name, version=self.version, description=f"Error: {str(e)}"
            )
    
    def get_tools(self) -> List[str]:
        """
        Get list of tool names provided by integration.
        
        Returns:
            List of tool names
        """
        return self._tools.copy()
    
    def cleanup(self) -> None:
        """Cleanup resources."""
        try:
            self._do_cleanup()
            self.logger.info(f"{self.name} cleanup complete")
        except Exception as e:
            self.logger.error(f"Cleanup error: {e}")
    
    def is_loaded(self) -> bool:
        """Check if integration is loaded"""
        return self.status == IntegrationStatus.LOADED
    
    def get_load_error(self) -> Optional[str]:
        """Get load error message if load failed"""
        return self._load_error
    
    # ========================================================================
    # ABSTRACT METHODS - Must be implemented by subclasses
    # ========================================================================
    
    @abstractmethod
    def _do_load(self, computer: Any) -> bool:
        """
        Implementation-specific loading logic.
        
        Args:
            computer: Open Interpreter computer instance
            
        Returns:
            True if loaded successfully, False otherwise
        """
        pass
    
    @abstractmethod
    def _do_health_check(self) -> IntegrationHealth:
        """
        Implementation-specific health check.
        
        Returns:
            IntegrationHealth object
        """
        pass
    
    # ========================================================================
    # OPTIONAL METHODS - Can be overridden by subclasses
    # ========================================================================
    
    def _enrich_metadata(self, metadata: IntegrationMetadata) -> IntegrationMetadata:
        """
        Enrich metadata with integration-specific information.
        Override to add custom metadata.
        
        Args:
            metadata: Base metadata object
            
        Returns:
            Enriched metadata object
        """
        return metadata
    
    def _do_cleanup(self) -> None:
        """
        Implementation-specific cleanup logic.
        Override if cleanup is needed.
        """
        pass
    
    # ========================================================================
    # PROTECTED HELPERS
    # ========================================================================
    
    def _register_tool(self, tool_name: str) -> None:
        """Register a tool name"""
        if tool_name not in self._tools:
            self._tools.append(tool_name)
    
    def _register_tools(self, tool_names: List[str]) -> None:
        """Register multiple tool names"""
        for tool_name in tool_names:
            self._register_tool(tool_name)
    
    def _attach_function(self, name: str, func: Any) -> None:
        """Attach function to computer instance"""
        if self._computer is None:
            raise RuntimeError("Cannot attach function: computer not initialized")
        setattr(self._computer, name, func)
        self._register_tool(name)
        self.logger.debug(f"Attached function: {name}")
    
    def _attach_namespace(self, namespace: str, obj: Any) -> None:
        """Attach namespace object to computer instance"""
        if self._computer is None:
            raise RuntimeError("Cannot attach namespace: computer not initialized")
        setattr(self._computer, namespace, obj)
        self.logger.debug(f"Attached namespace: {namespace}")
    
    def _validate_dependencies(self, dependencies: List[str]) -> Dict[str, bool]:
        """
        Validate dependencies are available.
        
        Args:
            dependencies: List of module names
            
        Returns:
            Dict mapping module name to availability
        """
        import importlib.util
        
        results = {}
        for dep in dependencies:
            spec = importlib.util.find_spec(dep)
            available = spec is not None
            results[dep] = available
            
            if not available:
                self.logger.warning(f"Dependency not available: {dep}")
        
        return results


# ============================================================================
# CONVENIENCE BASE CLASSES
# ============================================================================


class ServiceIntegration(BaseIntegration):
    """
    Base class for service-based integrations (Perplexica, Docling, etc.)
    
    Provides HTTP health check functionality.
    """
    
    def __init__(
        self,
        name: str,
        service_url: str,
        health_check_url: Optional[str] = None,
        version: str = "1.0.0",
    ):
        super().__init__(
            name=name,
            version=version,
            integration_type=IntegrationType.SERVICE,
            requires_service=True,
        )
        self.service_url = service_url
        self.health_check_url = health_check_url or f"{service_url}/health"
    
    def _do_health_check(self) -> IntegrationHealth:
        """HTTP-based health check"""
        import time
        import httpx
        
        start_time = time.time()
        
        try:
            with httpx.Client(timeout=5.0) as client:
                response = client.get(self.health_check_url)
                response_time = (time.time() - start_time) * 1000
                
                return IntegrationHealth(
                    healthy=response.status_code == 200,
                    status_code=response.status_code,
                    message=f"Service responded with {response.status_code}",
                    response_time_ms=response_time,
                    details={"url": self.health_check_url},
                )
        except Exception as e:
            return IntegrationHealth(
                healthy=False,
                message=f"Health check failed: {str(e)}",
                details={"url": self.health_check_url, "error": str(e)},
            )


class LibraryIntegration(BaseIntegration):
    """
    Base class for library-based integrations (xlwings, notebook, etc.)
    
    No external service required.
    """
    
    def __init__(self, name: str, version: str = "1.0.0"):
        super().__init__(
            name=name,
            version=version,
            integration_type=IntegrationType.LIBRARY,
            requires_service=False,
        )
    
    def _do_health_check(self) -> IntegrationHealth:
        """Library health check - just verify loaded"""
        return IntegrationHealth(
            healthy=self.is_loaded(),
            message="Library loaded" if self.is_loaded() else "Library not loaded",
        )

