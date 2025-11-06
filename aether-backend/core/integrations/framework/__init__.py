"""
Integration Framework - Production-ready integration system for Aether

This framework provides a complete, YAML-driven integration system with:
- Base classes and protocols for standardized integrations
- Dynamic loader for YAML-driven integration loading
- Comprehensive validator for 4-layer architecture compliance
- Health checker for complete lifecycle testing

4-LAYER ARCHITECTURE:
    Layer 1: Service Implementation (perplexica/search.py, xlwings/excel.py)
    Layer 2: Integration Exposure (clean __init__.py with __all__ exports)
    Layer 3: Registry & Metadata (integrations_registry.yaml - SINGLE SOURCE OF TRUTH)
    Layer 4: Runtime Orchestration (loader.py - YAML-driven loading)

Components:
    - base.py: BaseIntegration, ServiceIntegration, LibraryIntegration
    - loader.py: IntegrationLoader - YAML-driven loading system
    - validator.py: IntegrationValidator - 4-layer compliance checks
    - health.py: IntegrationHealthChecker - Lifecycle testing

Usage:
    from core.integrations.framework import (
        IntegrationLoader,
        IntegrationValidator,
        IntegrationHealthChecker,
        BaseIntegration,
        ServiceIntegration,
        LibraryIntegration,
    )
    
    # In RuntimeEngine:
    loader = IntegrationLoader(interpreter)
    results = loader.load_all()
    
    # Validation:
    validator = IntegrationValidator()
    reports = validator.validate_all()
    
    # Health checks:
    checker = IntegrationHealthChecker()
    health = checker.check_all()
"""

from .base import (
    BaseIntegration,
    ServiceIntegration,
    LibraryIntegration,
    IntegrationStatus,
    IntegrationType,
    IntegrationMetadata,
    IntegrationHealth,
    IntegrationProtocol,
)

from .loader import IntegrationLoader

from .validator import (
    IntegrationValidator,
    IntegrationValidationReport,
    LayerValidation,
)

from .health import (
    IntegrationHealthChecker,
    HealthCheckResult,
)

from .yaml_generator import (
    BackendToolsYAMLGenerator,
    generate_backend_tools_yaml,
)


__all__ = [
    # Base Classes
    "BaseIntegration",
    "ServiceIntegration",
    "LibraryIntegration",
    
    # Enums and Types
    "IntegrationStatus",
    "IntegrationType",
    
    # Data Classes
    "IntegrationMetadata",
    "IntegrationHealth",
    "IntegrationProtocol",
    
    # Loader
    "IntegrationLoader",
    
    # Validator
    "IntegrationValidator",
    "IntegrationValidationReport",
    "LayerValidation",
    
    # Health Checker
    "IntegrationHealthChecker",
    "HealthCheckResult",
    
    # YAML Generator
    "BackendToolsYAMLGenerator",
    "generate_backend_tools_yaml",
]

