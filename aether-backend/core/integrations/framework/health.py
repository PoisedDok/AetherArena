"""
Integration Health Check System - Complete lifecycle testing for all integrations

Tests each integration's complete lifecycle:
1. Load - Can integration be loaded and imported?
2. Attach - Are functions/namespaces available as expected?
3. Execute - Can integration functions be inspected and potentially called?

Production Features:
- Comprehensive 3-phase health checks
- Detailed error and warning reporting
- Safe testing without actual execution
- Signature validation
- Export verification

Usage:
    from core.integrations.framework.health import IntegrationHealthChecker
    
    checker = IntegrationHealthChecker()
    results = checker.check_all()
    for name, result in results.items():
        print(result)

@.architecture
Incoming: config/integrations_registry.yaml, core/integrations/libraries/*, core/integrations/providers/*, Open Interpreter computer --- {Dict YAML config, integration modules, computer instance}
Processing: check_all(), _check_load(), _check_attach(), _check_execute(), _validate_signature() --- {5 jobs: health_checking, import_validation, integration_testing, lifecycle_testing, signature_validation}
Outgoing: Testing/monitoring tools, Scripts --- {HealthCheckResult, Dict[str, HealthCheckResult], bool validation status}
"""

import inspect
import importlib
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field
import yaml

logger = logging.getLogger(__name__)


# ============================================================================
# DATA CLASSES
# ============================================================================


@dataclass
class HealthCheckResult:
    """Result of a single integration health check"""
    integration_name: str
    passed: bool
    load_status: bool = False
    attach_status: bool = False
    execute_status: bool = False
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization"""
        return {
            "integration": self.integration_name,
            "passed": self.passed,
            "load": self.load_status,
            "attach": self.attach_status,
            "execute": self.execute_status,
            "errors": self.errors,
            "warnings": self.warnings
        }
    
    def __str__(self) -> str:
        """Human-readable report"""
        emoji = "✅" if self.passed else "❌"
        lines = [
            f"{emoji} {self.integration_name}",
            f"   Load: {'✅' if self.load_status else '❌'}",
            f"   Attach: {'✅' if self.attach_status else '❌'}",
            f"   Execute: {'✅' if self.execute_status else '❌'}"
        ]
        
        if self.errors:
            lines.append("   Errors:")
            for error in self.errors:
                lines.append(f"      - {error}")
        
        if self.warnings:
            lines.append("   Warnings:")
            for warning in self.warnings:
                lines.append(f"      - {warning}")
        
        return "\n".join(lines)


# ============================================================================
# HEALTH CHECKER
# ============================================================================


class IntegrationHealthChecker:
    """
    Health check system for all integrations
    
    Performs 3-phase testing:
    - Phase 1 (Load): Can the integration module be imported?
    - Phase 2 (Attach): Are all expected exports available?
    - Phase 3 (Execute): Can functions be inspected and validated?
    """
    
    def __init__(self, aether_backend_root: Optional[Path] = None):
        """
        Initialize health checker
        
        Args:
            aether_backend_root: Path to aether-backend directory (auto-detects if None)
        """
        if aether_backend_root is None:
            # Auto-detect: we're in core/integrations/framework/, go up 4 levels to aether-backend root
            current_file = Path(__file__).resolve()
            aether_backend_root = current_file.parent.parent.parent.parent
        
        self.aether_backend_root = Path(aether_backend_root)
        self.integrations_registry_path = self.aether_backend_root / "config" / "integrations_registry.yaml"
        
        # Load registry
        self.integrations_registry = self._load_yaml(self.integrations_registry_path)
        
        logger.info(f"IntegrationHealthChecker initialized (aether-backend: {self.aether_backend_root})")
    
    def _load_yaml(self, path: Path) -> Dict[str, Any]:
        """Load YAML file"""
        try:
            if not path.exists():
                logger.error(f"YAML file not found: {path}")
                return {}
            
            with open(path, 'r') as f:
                return yaml.safe_load(f) or {}
        except Exception as e:
            logger.error(f"Failed to load {path}: {e}")
            return {}
    
    # ========================================================================
    # PUBLIC API
    # ========================================================================
    
    def check_all(self) -> Dict[str, HealthCheckResult]:
        """
        Check all enabled integrations
        
        Returns:
            Dict mapping integration name to health check result
        """
        results = {}
        integrations = self.integrations_registry.get("integrations", {})
        
        for name, config in integrations.items():
            if not config.get("enabled", True):
                # Skip disabled integrations
                logger.debug(f"Skipping disabled integration: {name}")
                continue
            
            try:
                result = self.check_integration(name, config)
                results[name] = result
            except Exception as e:
                logger.error(f"Health check failed for {name}: {e}")
                results[name] = HealthCheckResult(
                    integration_name=name,
                    passed=False,
                    errors=[f"Health check exception: {str(e)}"]
                )
        
        return results
    
    def check_integration(self, name: str, config: Dict[str, Any]) -> HealthCheckResult:
        """
        Check a single integration's health (3-phase testing)
        
        Args:
            name: Integration name
            config: Integration config from YAML
            
        Returns:
            HealthCheckResult with complete lifecycle test results
        """
        result = HealthCheckResult(integration_name=name, passed=False)
        
        # PHASE 1: CHECK LOAD
        load_success, load_module = self._check_load(name, config, result)
        result.load_status = load_success
        
        if not load_success:
            return result
        
        # PHASE 2: CHECK ATTACH
        attach_success = self._check_attach(name, config, load_module, result)
        result.attach_status = attach_success
        
        if not attach_success:
            return result
        
        # PHASE 3: CHECK EXECUTE
        execute_success = self._check_execute(name, config, load_module, result)
        result.execute_status = execute_success
        
        # Overall pass - all 3 phases must succeed
        result.passed = load_success and attach_success and execute_success
        
        if result.passed:
            logger.info(f"✅ {name} health check passed")
        else:
            logger.warning(f"❌ {name} health check failed")
        
        return result
    
    # ========================================================================
    # PHASE 1: LOAD CHECK
    # ========================================================================
    
    def _check_load(
        self, 
        name: str, 
        config: Dict[str, Any], 
        result: HealthCheckResult
    ) -> Tuple[bool, Any]:
        """
        Phase 1: Check if integration can be loaded
        
        Verifies:
        - Module import path is specified
        - Module can be imported without errors
        - Module loads without side effects
        
        Args:
            name: Integration name
            config: Integration config from YAML
            result: HealthCheckResult to populate with errors/warnings
        
        Returns:
            (success: bool, module: Any) - Success flag and loaded module
        """
        try:
            layer2_config = config.get("layer2_exposure", {})
            init_module = layer2_config.get("init_file", "")
            
            if not init_module:
                result.errors.append("No init_file specified in config")
                return False, None
            
            # Ensure aether-backend is in path
            if str(self.aether_backend_root) not in sys.path:
                sys.path.insert(0, str(self.aether_backend_root))
            
            # Import module
            module = importlib.import_module(init_module)
            
            logger.debug(f"{name}: module loaded successfully ({init_module})")
            return True, module
            
        except ImportError as e:
            result.errors.append(f"Import failed: {str(e)}")
            logger.debug(f"{name}: import failed - {e}")
            return False, None
        except Exception as e:
            result.errors.append(f"Load error: {str(e)}")
            logger.debug(f"{name}: load error - {e}")
            return False, None
    
    # ========================================================================
    # PHASE 2: ATTACH CHECK
    # ========================================================================
    
    def _check_attach(
        self, 
        name: str, 
        config: Dict[str, Any], 
        module: Any, 
        result: HealthCheckResult
    ) -> bool:
        """
        Phase 2: Check if integration can be attached to computer namespace
        
        Verifies:
        - All expected exports are available in module
        - Exports are callable or valid classes
        - Attachment strategy is valid
        
        Args:
            name: Integration name
            config: Integration config from YAML
            module: Loaded module from Phase 1
            result: HealthCheckResult to populate with errors/warnings
        
        Returns:
            success: bool - Whether attach check passed
        """
        try:
            layer2_config = config.get("layer2_exposure", {})
            layer4_config = config.get("layer4_runtime", {})
            
            exports = layer2_config.get("exports", [])
            attach_as = layer4_config.get("attach_as", "functions")
            
            # Check all exports are available
            missing_exports = []
            for export_name in exports:
                if not hasattr(module, export_name):
                    missing_exports.append(export_name)
            
            if missing_exports:
                result.errors.append(f"Missing exports: {', '.join(missing_exports)}")
                logger.debug(f"{name}: missing exports - {missing_exports}")
                return False
            
            # Verify exports are callable or valid classes
            invalid_exports = []
            for export_name in exports:
                export_obj = getattr(module, export_name)
                
                # Must be callable (function) or a class
                if not callable(export_obj) and not isinstance(export_obj, type):
                    invalid_exports.append(export_name)
            
            if invalid_exports:
                result.warnings.append(
                    f"Non-callable/non-class exports: {', '.join(invalid_exports)}"
                )
            
            # Validate attachment strategy
            valid_strategies = ["functions", "namespace", "builtin", "dynamic"]
            if attach_as not in valid_strategies:
                result.warnings.append(f"Unknown attach_as strategy: {attach_as}")
            
            logger.debug(f"{name}: attach check passed ({len(exports)} exports)")
            return True
            
        except Exception as e:
            result.errors.append(f"Attach check error: {str(e)}")
            logger.debug(f"{name}: attach check error - {e}")
            return False
    
    # ========================================================================
    # PHASE 3: EXECUTE CHECK
    # ========================================================================
    
    def _check_execute(
        self, 
        name: str, 
        config: Dict[str, Any], 
        module: Any, 
        result: HealthCheckResult
    ) -> bool:
        """
        Phase 3: Check if integration functions can be executed
        
        Verifies:
        - Functions can be inspected (valid signatures)
        - Functions have proper structure
        - Functions appear executable (not broken)
        
        Note: Does NOT actually execute functions (no side effects)
        
        Args:
            name: Integration name
            config: Integration config from YAML
            module: Loaded module from Phase 1
            result: HealthCheckResult to populate with errors/warnings
        
        Returns:
            success: bool - Whether execute check passed
        """
        try:
            layer2_config = config.get("layer2_exposure", {})
            exports = layer2_config.get("exports", [])
            
            # Basic execution test: Check if functions accept inspection
            executable_count = 0
            non_executable = []
            
            for export_name in exports:
                export_obj = getattr(module, export_name, None)
                
                if export_obj is None:
                    continue
                
                if callable(export_obj):
                    try:
                        # Try to get signature (validates function structure)
                        sig = inspect.signature(export_obj)
                        executable_count += 1
                        logger.debug(f"{name}.{export_name}: signature OK - {sig}")
                    except ValueError as e:
                        # Built-in function without signature
                        result.warnings.append(f"Cannot inspect {export_name} (built-in?): {e}")
                    except TypeError as e:
                        # Invalid callable
                        non_executable.append(export_name)
                        result.warnings.append(f"Cannot inspect {export_name}: {e}")
                elif isinstance(export_obj, type):
                    # Class export - check if it can be inspected
                    try:
                        sig = inspect.signature(export_obj.__init__)
                        executable_count += 1
                        logger.debug(f"{name}.{export_name}: class OK - {sig}")
                    except Exception as e:
                        result.warnings.append(f"Cannot inspect class {export_name}: {e}")
            
            # If we have exports but none are executable, that's an error
            if len(exports) > 0 and executable_count == 0:
                result.errors.append("No executable functions or classes found")
                logger.debug(f"{name}: no executable exports")
                return False
            
            logger.debug(f"{name}: execute check passed ({executable_count}/{len(exports)} inspectable)")
            return True
            
        except Exception as e:
            result.errors.append(f"Execute check error: {str(e)}")
            logger.debug(f"{name}: execute check error - {e}")
            return False


# ============================================================================
# CLI ENTRY POINT
# ============================================================================


def main():
    """CLI entry point for testing health checks"""
    print("=" * 80)
    print("INTEGRATION HEALTH CHECK SYSTEM")
    print("=" * 80)
    print()
    
    try:
        checker = IntegrationHealthChecker()
        
        integrations = checker.integrations_registry.get("integrations", {})
        enabled_count = sum(1 for c in integrations.values() if c.get("enabled", True))
        
        print(f"Checking {enabled_count} enabled integrations...")
        print()
        
        results = checker.check_all()
        
        # Summary
        passed = sum(1 for r in results.values() if r.passed)
        total = len(results)
        
        print(f"{'=' * 80}")
        print(f"HEALTH CHECK SUMMARY: {passed}/{total} passed")
        print(f"{'=' * 80}")
        print()
        
        # Detailed results
        for result_name, result in sorted(results.items()):
            print(result)
            print()
        
        print(f"{'=' * 80}")
        
        return 0 if passed == total else 1
        
    except Exception as e:
        import traceback
        print(f"❌ Health check failed: {e}")
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    import sys
    sys.exit(main())

