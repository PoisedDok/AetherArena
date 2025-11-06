"""
Integration Validator - Comprehensive validation for 4-layer integration architecture

Validates all layers of integration compliance:
- Layer 1: Service implementation integrity (no OI deps, type hints, docs)
- Layer 2: Clean exposure with __all__ exports
- Layer 3: Complete YAML metadata
- Layer 4: Correct runtime orchestration

Production Features:
- Comprehensive validation checks
- Detailed validation reports
- Warning vs error distinction
- Type hint and docstring coverage analysis
- Separation of concerns enforcement

Usage:
    from core/integrations.framework.validator import IntegrationValidator
    
    validator = IntegrationValidator()
    reports = validator.validate_all()
    for name, report in reports.items():
        print(report)

@.architecture
Incoming: config/integrations_registry.yaml, core/integrations/libraries/*, core/integrations/providers/*, Python modules --- {Dict YAML config, integration source code, module AST}
Processing: validate_all(), _validate_layer1(), _validate_layer2(), _validate_layer3(), _validate_layer4() --- {5 jobs: architecture_validation, compliance_checking, metadata_validation, separation_validation, validation}
Outgoing: Development/CI tools, Scripts --- {IntegrationValidationReport, Dict[str, LayerValidation], bool compliance status}
"""

import importlib
import inspect
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field
import yaml

logger = logging.getLogger(__name__)


# ============================================================================
# DATA CLASSES
# ============================================================================


@dataclass
class LayerValidation:
    """Validation result for a single layer"""
    layer: int
    passed: bool
    checks: Dict[str, bool] = field(default_factory=dict)
    issues: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


@dataclass
class IntegrationValidationReport:
    """Complete validation report for an integration"""
    integration_name: str
    enabled: bool
    overall_compliant: bool
    layer1: LayerValidation
    layer2: LayerValidation
    layer3: LayerValidation
    layer4: LayerValidation
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization"""
        return {
            "integration": self.integration_name,
            "enabled": self.enabled,
            "compliant": self.overall_compliant,
            "layers": {
                "layer1": {
                    "passed": self.layer1.passed,
                    "checks": self.layer1.checks,
                    "issues": self.layer1.issues,
                    "warnings": self.layer1.warnings
                },
                "layer2": {
                    "passed": self.layer2.passed,
                    "checks": self.layer2.checks,
                    "issues": self.layer2.issues,
                    "warnings": self.layer2.warnings
                },
                "layer3": {
                    "passed": self.layer3.passed,
                    "checks": self.layer3.checks,
                    "issues": self.layer3.issues,
                    "warnings": self.layer3.warnings
                },
                "layer4": {
                    "passed": self.layer4.passed,
                    "checks": self.layer4.checks,
                    "issues": self.layer4.issues,
                    "warnings": self.layer4.warnings
                }
            }
        }
    
    def __str__(self) -> str:
        """Human-readable report"""
        emoji = "✅" if self.overall_compliant else "❌"
        status = "COMPLIANT" if self.overall_compliant else "NON-COMPLIANT"
        
        lines = [
            f"\n{emoji} {self.integration_name} - {status}",
            f"   Enabled: {self.enabled}",
            f"   Layer 1 (Implementation): {'✅' if self.layer1.passed else '❌'}",
            f"   Layer 2 (Exposure): {'✅' if self.layer2.passed else '❌'}",
            f"   Layer 3 (Metadata): {'✅' if self.layer3.passed else '❌'}",
            f"   Layer 4 (Runtime): {'✅' if self.layer4.passed else '❌'}",
        ]
        
        # Add issues
        all_issues = []
        all_issues.extend([f"L1: {issue}" for issue in self.layer1.issues])
        all_issues.extend([f"L2: {issue}" for issue in self.layer2.issues])
        all_issues.extend([f"L3: {issue}" for issue in self.layer3.issues])
        all_issues.extend([f"L4: {issue}" for issue in self.layer4.issues])
        
        if all_issues:
            lines.append("   Issues:")
            for issue in all_issues:
                lines.append(f"      - {issue}")
        
        return "\n".join(lines)


# ============================================================================
# INTEGRATION VALIDATOR
# ============================================================================


class IntegrationValidator:
    """
    Validates all integrations for 4-layer architecture compliance
    """
    
    def __init__(self, aether_backend_root: Optional[Path] = None):
        """
        Initialize validator
        
        Args:
            aether_backend_root: Path to aether-backend directory (auto-detects if None)
        """
        if aether_backend_root is None:
            # Auto-detect: we're in core/integrations/framework/, go up 4 levels to aether-backend root
            current_file = Path(__file__).resolve()
            aether_backend_root = current_file.parent.parent.parent.parent
        
        self.aether_backend_root = Path(aether_backend_root)
        self.config_dir = self.aether_backend_root / "config"
        self.integrations_registry_path = self.config_dir / "integrations_registry.yaml"
        
        # Load registry
        self.integrations_registry = self._load_yaml(self.integrations_registry_path)
        
        # Validation rules from YAML
        self.validation_rules = self.integrations_registry.get("validation", {})
        
        logger.info(f"IntegrationValidator initialized (aether-backend: {self.aether_backend_root})")
    
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
    
    def validate_all(self) -> Dict[str, IntegrationValidationReport]:
        """
        Validate all integrations
        
        Returns:
            Dict mapping integration name to validation report
        """
        reports = {}
        integrations = self.integrations_registry.get("integrations", {})
        
        for name, config in integrations.items():
            try:
                report = self.validate_integration(name, config)
                reports[name] = report
            except Exception as e:
                logger.error(f"Failed to validate {name}: {e}")
                # Create error report
                reports[name] = IntegrationValidationReport(
                    integration_name=name,
                    enabled=config.get("enabled", True),
                    overall_compliant=False,
                    layer1=LayerValidation(1, False, issues=[f"Validation error: {e}"]),
                    layer2=LayerValidation(2, False),
                    layer3=LayerValidation(3, False),
                    layer4=LayerValidation(4, False)
                )
        
        return reports
    
    def validate_integration(self, name: str, config: Dict[str, Any]) -> IntegrationValidationReport:
        """
        Validate a single integration
        
        Args:
            name: Integration name
            config: Integration config from YAML
            
        Returns:
            IntegrationValidationReport
        """
        enabled = config.get("enabled", True)
        
        # Validate each layer
        layer1 = self._validate_layer1(name, config)
        layer2 = self._validate_layer2(name, config)
        layer3 = self._validate_layer3(name, config)
        layer4 = self._validate_layer4(name, config)
        
        # Overall compliance - all layers must pass
        overall_compliant = all([
            layer1.passed,
            layer2.passed,
            layer3.passed,
            layer4.passed
        ])
        
        return IntegrationValidationReport(
            integration_name=name,
            enabled=enabled,
            overall_compliant=overall_compliant,
            layer1=layer1,
            layer2=layer2,
            layer3=layer3,
            layer4=layer4
        )
    
    # ========================================================================
    # LAYER VALIDATION METHODS
    # ========================================================================
    
    def _validate_layer1(self, name: str, config: Dict[str, Any]) -> LayerValidation:
        """
        Validate Layer 1: Service Implementation
        
        Checks:
        - Implementation files exist
        - Module can be imported
        - Functions have type hints
        - Functions have docstrings
        - No direct OI dependencies
        """
        result = LayerValidation(layer=1, passed=True)
        
        layer1_config = config.get("layer1_implementation", {})
        module_path = layer1_config.get("module", "")
        files = layer1_config.get("files", [])
        
        # Check 1: Module path specified
        if not module_path:
            result.issues.append("No module path specified in layer1_implementation")
            result.passed = False
            return result
        
        result.checks["module_path_specified"] = True
        
        # Check 2: Files exist (if specified)
        if files:
            for file in files:
                # Convert module path to file path
                module_parts = module_path.split(".")
                file_path = self.aether_backend_root / "/".join(module_parts[:-1]) / file
                
                if not file_path.exists():
                    result.issues.append(f"File not found: {file}")
                    result.passed = False
                else:
                    result.checks[f"file_exists_{file}"] = True
        
        # Check 3: Module can be imported
        try:
            import sys
            if str(self.aether_backend_root) not in sys.path:
                sys.path.insert(0, str(self.aether_backend_root))
            
            module = importlib.import_module(module_path)
            result.checks["module_importable"] = True
            
            # Check 4: Functions have type hints and docstrings
            exported_functions = [
                fname for fname in dir(module)
                if callable(getattr(module, fname)) and not fname.startswith("_")
            ]
            
            if exported_functions:
                functions_with_hints = 0
                functions_with_docs = 0
                
                for func_name in exported_functions:
                    func = getattr(module, func_name)
                    
                    # Skip if not a real function
                    if not hasattr(func, '__code__'):
                        continue
                    
                    # Check type hints
                    try:
                        sig = inspect.signature(func)
                        has_hints = any(
                            param.annotation != param.empty 
                            for param in sig.parameters.values()
                        )
                        if has_hints or sig.return_annotation != sig.empty:
                            functions_with_hints += 1
                    except (ValueError, TypeError):
                        pass
                    
                    # Check docstring
                    if func.__doc__ and len(func.__doc__.strip()) > 0:
                        functions_with_docs += 1
                
                if len(exported_functions) > 0:
                    hint_ratio = functions_with_hints / len(exported_functions)
                    doc_ratio = functions_with_docs / len(exported_functions)
                    
                    result.checks["has_type_hints"] = hint_ratio >= 0.5
                    result.checks["has_docstrings"] = doc_ratio >= 0.5
                    
                    if hint_ratio < 0.5:
                        result.warnings.append(f"Only {hint_ratio*100:.0f}% of functions have type hints")
                    if doc_ratio < 0.5:
                        result.warnings.append(f"Only {doc_ratio*100:.0f}% of functions have docstrings")
            
            # Check 5: No direct OI dependencies (separation of concerns)
            try:
                module_source = inspect.getsource(module)
                forbidden_imports = ["from interpreter", "import interpreter", "from open_interpreter"]
                
                has_oi_deps = any(forbidden in module_source for forbidden in forbidden_imports)
                result.checks["no_oi_dependencies"] = not has_oi_deps
                
                if has_oi_deps:
                    result.issues.append("Layer 1 has direct Open Interpreter dependencies (violates separation)")
                    result.passed = False
            except (TypeError, OSError):
                # Can't get source (built-in module), skip this check
                result.checks["no_oi_dependencies"] = True
                
        except ImportError as e:
            result.issues.append(f"Cannot import module: {e}")
            result.checks["module_importable"] = False
            result.passed = False
        except Exception as e:
            result.warnings.append(f"Error analyzing module: {e}")
        
        return result
    
    def _validate_layer2(self, name: str, config: Dict[str, Any]) -> LayerValidation:
        """
        Validate Layer 2: Integration Exposure
        
        Checks:
        - __init__.py exists
        - __all__ list defined
        - All exports in __all__
        - Exports match YAML config
        """
        result = LayerValidation(layer=2, passed=True)
        
        layer2_config = config.get("layer2_exposure", {})
        init_module = layer2_config.get("init_file", "")
        expected_exports = layer2_config.get("exports", [])
        
        # Check 1: init_file specified
        if not init_module:
            result.issues.append("No init_file specified in layer2_exposure")
            result.passed = False
            return result
        
        result.checks["init_module_specified"] = True
        
        # Check 2: Module can be imported
        try:
            import sys
            if str(self.aether_backend_root) not in sys.path:
                sys.path.insert(0, str(self.aether_backend_root))
            
            module = importlib.import_module(init_module)
            result.checks["init_module_importable"] = True
            
            # Check 3: __all__ defined
            if not hasattr(module, "__all__"):
                result.issues.append("__init__.py missing __all__ list")
                result.checks["has_all_list"] = False
                result.passed = False
            else:
                result.checks["has_all_list"] = True
                module_all = getattr(module, "__all__")
                
                # Check 4: All YAML exports are in __all__
                missing_in_all = set(expected_exports) - set(module_all)
                if missing_in_all:
                    result.issues.append(f"Exports not in __all__: {', '.join(missing_in_all)}")
                    result.checks["exports_in_all"] = False
                    result.passed = False
                else:
                    result.checks["exports_in_all"] = True
                
                # Check 5: All exports exist as attributes
                missing_attrs = []
                for export in expected_exports:
                    if not hasattr(module, export):
                        missing_attrs.append(export)
                
                if missing_attrs:
                    result.issues.append(f"Exports not found: {', '.join(missing_attrs)}")
                    result.checks["exports_exist"] = False
                    result.passed = False
                else:
                    result.checks["exports_exist"] = True
                
        except ImportError as e:
            result.issues.append(f"Cannot import init module: {e}")
            result.checks["init_module_importable"] = False
            result.passed = False
        except Exception as e:
            result.warnings.append(f"Error analyzing exposure: {e}")
        
        return result
    
    def _validate_layer3(self, name: str, config: Dict[str, Any]) -> LayerValidation:
        """
        Validate Layer 3: Metadata Registry
        
        Checks:
        - All required keys present
        - Metadata complete
        - Dependencies specified
        """
        result = LayerValidation(layer=3, passed=True)
        
        # Check: All layer configs present
        required_keys = ["layer1_implementation", "layer2_exposure", "layer3_metadata", "layer4_runtime"]
        missing_keys = [key for key in required_keys if key not in config]
        
        if missing_keys:
            result.issues.append(f"Missing config keys: {', '.join(missing_keys)}")
            result.checks["all_layers_present"] = False
            result.passed = False
        else:
            result.checks["all_layers_present"] = True
        
        # Check: Layer 3 metadata has required fields
        layer3_config = config.get("layer3_metadata", {})
        recommended_fields = ["tool_count", "category", "requires_service"]
        
        missing_metadata = [field for field in recommended_fields if field not in layer3_config]
        if missing_metadata:
            result.warnings.append(f"Missing recommended metadata: {', '.join(missing_metadata)}")
        
        result.checks["has_metadata"] = len(missing_metadata) < len(recommended_fields)
        
        # Check: Dependencies specified (if any)
        if "dependencies" in config:
            result.checks["has_dependencies_info"] = True
        
        return result
    
    def _validate_layer4(self, name: str, config: Dict[str, Any]) -> LayerValidation:
        """
        Validate Layer 4: Runtime Configuration
        
        Checks:
        - Runtime config complete
        - Attachment strategy valid
        - Namespace specified
        """
        result = LayerValidation(layer=4, passed=True)
        
        layer4_config = config.get("layer4_runtime", {})
        
        # Check 1: Required fields present
        required_fields = ["namespace", "attach_as"]
        missing_fields = [field for field in required_fields if field not in layer4_config]
        
        if missing_fields:
            result.issues.append(f"Missing runtime config: {', '.join(missing_fields)}")
            result.checks["runtime_config_complete"] = False
            result.passed = False
        else:
            result.checks["runtime_config_complete"] = True
        
        # Check 2: Valid attachment strategy
        attach_as = layer4_config.get("attach_as", "")
        valid_strategies = ["functions", "namespace", "builtin", "dynamic"]
        
        if attach_as not in valid_strategies:
            result.issues.append(f"Invalid attach_as strategy: {attach_as}")
            result.checks["valid_attach_strategy"] = False
            result.passed = False
        else:
            result.checks["valid_attach_strategy"] = True
        
        # Check 3: Namespace format valid
        namespace = layer4_config.get("namespace", "")
        if namespace and not namespace.startswith("computer"):
            result.warnings.append(f"Namespace doesn't start with 'computer': {namespace}")
        
        result.checks["valid_namespace"] = bool(namespace)
        
        return result

