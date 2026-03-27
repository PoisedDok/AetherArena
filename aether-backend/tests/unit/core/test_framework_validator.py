"""
Unit Tests: IntegrationValidator (core/integrations/framework/validator.py)

Covers all 4 layers of validation, data classes, and report generation.

Mock boundaries:
- File system for integrations_registry.yaml → tmp_path
- importlib.import_module → mocked for module validation
"""

from __future__ import annotations

import inspect
import types
import yaml
from pathlib import Path
from typing import Any, Dict
from unittest.mock import patch


from core.integrations.framework.validator import (
    LayerValidation,
    IntegrationValidationReport,
    IntegrationValidator,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _write_registry(config_dir: Path, integrations: Dict[str, Any] | None = None) -> None:
    config_dir.mkdir(parents=True, exist_ok=True)
    content = {"integrations": integrations or {}}
    (config_dir / "integrations_registry.yaml").write_text(yaml.dump(content))


def _make_config(
    *,
    module: str = "core.integrations.providers.docling.service",
    init_file: str = "core.integrations.providers.docling",
    exports: list | None = None,
    category: str = "document_processing_vision",
    namespace: str = "computer",
    attach_as: str = "functions",
) -> Dict[str, Any]:
    return {
        "enabled": True,
        "type": "service",
        "description": "Test integration",
        "layer1_implementation": {"module": module, "files": []},
        "layer2_exposure": {"init_file": init_file, "exports": exports or ["DoclingService"]},
        "layer3_metadata": {
            "tool_count": 2,
            "category": category,
            "requires_service": True,
        },
        "layer4_runtime": {"namespace": namespace, "attach_as": attach_as},
    }


# ─── LayerValidation ────────────────────────────────────────────────────────


class TestLayerValidation:
    def test_defaults(self):
        lv = LayerValidation(layer=1, passed=True)
        assert lv.layer == 1
        assert lv.passed is True
        assert lv.checks == {}
        assert lv.issues == []
        assert lv.warnings == []

    def test_with_data(self):
        lv = LayerValidation(
            layer=2,
            passed=False,
            checks={"test": True},
            issues=["bad"],
            warnings=["warn"],
        )
        assert lv.layer == 2
        assert lv.passed is False
        assert lv.checks == {"test": True}
        assert lv.issues == ["bad"]
        assert lv.warnings == ["warn"]


# ─── IntegrationValidationReport ─────────────────────────────────────────────


class TestIntegrationValidationReport:
    def _make_report(self, *, compliant=True):
        return IntegrationValidationReport(
            integration_name="test",
            enabled=True,
            overall_compliant=compliant,
            layer1=LayerValidation(1, compliant),
            layer2=LayerValidation(2, compliant),
            layer3=LayerValidation(3, compliant),
            layer4=LayerValidation(4, compliant),
        )

    def test_to_dict(self):
        report = self._make_report()
        d = report.to_dict()
        assert d["integration"] == "test"
        assert d["enabled"] is True
        assert d["compliant"] is True
        # All 4 layers present in dict
        assert set(d["layers"].keys()) == {"layer1", "layer2", "layer3", "layer4"}
        # Each layer dict has exact keys
        for layer_key in ("layer1", "layer2", "layer3", "layer4"):
            assert set(d["layers"][layer_key].keys()) == {"passed", "checks", "issues", "warnings"}
            assert d["layers"][layer_key]["passed"] is True

    def test_str_compliant(self):
        report = self._make_report(compliant=True)
        s = str(report)
        assert "COMPLIANT" in s
        assert "test" in s

    def test_str_non_compliant(self):
        report = IntegrationValidationReport(
            integration_name="bad",
            enabled=True,
            overall_compliant=False,
            layer1=LayerValidation(1, False, issues=["Missing module"]),
            layer2=LayerValidation(2, True),
            layer3=LayerValidation(3, True),
            layer4=LayerValidation(4, True),
        )
        s = str(report)
        assert "NON-COMPLIANT" in s
        assert "Missing module" in s


# ─── IntegrationValidator.__init__ ───────────────────────────────────────────


class TestValidatorInit:
    def test_auto_detect_root(self):
        validator = IntegrationValidator()
        # Auto-detected root is 4 levels up from validator.py — verify it's a Path
        assert isinstance(validator.aether_backend_root, Path)

    def test_custom_root(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)
        assert validator.aether_backend_root == tmp_path

    def test_missing_registry(self, tmp_path):
        validator = IntegrationValidator(aether_backend_root=tmp_path)
        assert validator.integrations_registry == {}


# ─── _load_yaml ──────────────────────────────────────────────────────────────


class TestLoadYaml:
    def test_valid_yaml(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {"ocr": {"enabled": True}})
        validator = IntegrationValidator(aether_backend_root=tmp_path)
        data = validator._load_yaml(config_dir / "integrations_registry.yaml")
        assert data == {"integrations": {"ocr": {"enabled": True}}}

    def test_missing_file(self, tmp_path):
        validator = IntegrationValidator(aether_backend_root=tmp_path)
        result = validator._load_yaml(tmp_path / "nonexistent.yaml")
        assert result == {}

    def test_invalid_yaml(self, tmp_path):
        bad_file = tmp_path / "bad.yaml"
        bad_file.write_text("{{invalid")
        validator = IntegrationValidator(aether_backend_root=tmp_path)
        result = validator._load_yaml(bad_file)
        assert result == {}


# ─── _validate_layer3 ───────────────────────────────────────────────────────


class TestValidateLayer3:
    def test_all_keys_present(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        config = _make_config()
        result = validator._validate_layer3("test", config)
        assert result.passed is True
        assert result.checks["all_layers_present"] is True

    def test_missing_keys(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        config = {"enabled": True}  # Missing all layer configs
        result = validator._validate_layer3("test", config)
        assert result.checks["all_layers_present"] is False
        assert result.passed is False

    def test_missing_recommended_metadata(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        config = _make_config()
        config["layer3_metadata"] = {}  # Empty metadata
        result = validator._validate_layer3("test", config)
        assert len(result.warnings) == 1
        assert "Missing recommended metadata: tool_count, category, requires_service" in result.warnings[0]

    def test_has_dependencies(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        config = _make_config()
        config["dependencies"] = ["httpx"]
        result = validator._validate_layer3("test", config)
        assert result.checks.get("has_dependencies_info") is True


# ─── _validate_layer4 ───────────────────────────────────────────────────────


class TestValidateLayer4:
    def test_valid_config(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        config = _make_config(namespace="computer", attach_as="functions")
        result = validator._validate_layer4("test", config)
        assert result.passed is True
        assert result.checks["runtime_config_complete"] is True
        assert result.checks["valid_attach_strategy"] is True

    def test_missing_runtime_fields(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        config = {"layer4_runtime": {}}
        result = validator._validate_layer4("test", config)
        assert result.passed is False

    def test_invalid_attach_strategy(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        config = {"layer4_runtime": {"namespace": "computer", "attach_as": "invalid"}}
        result = validator._validate_layer4("test", config)
        assert result.passed is False
        assert result.checks["valid_attach_strategy"] is False

    def test_namespace_warning(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        config = {"layer4_runtime": {"namespace": "something", "attach_as": "functions"}}
        result = validator._validate_layer4("test", config)
        assert len(result.warnings) == 1
        assert "Namespace doesn't start with 'computer': something" in result.warnings[0]
        # Still passes — it's a warning, not a failure
        assert result.passed is True

    def test_empty_namespace(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        config = {"layer4_runtime": {"namespace": "", "attach_as": "functions"}}
        result = validator._validate_layer4("test", config)
        assert result.checks["valid_namespace"] is False


# ─── _validate_layer1 ────────────────────────────────────────────────────────


def _make_mock_module(*, functions=None, has_oi_import=False, source=None):
    """Build a fake module object for importlib.import_module mocking."""
    mod = types.ModuleType("fake_module")

    if functions:
        for name, func in functions.items():
            setattr(mod, name, func)

    # Default source text unless overridden
    if source is None:
        source = "import os\n" if not has_oi_import else "from interpreter import foo\n"
    mod.__source__ = source
    return mod, source


class TestValidateLayer1:
    def _validator(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        return IntegrationValidator(aether_backend_root=tmp_path)

    def test_no_module_path(self, tmp_path):
        v = self._validator(tmp_path)
        config = {"layer1_implementation": {"module": "", "files": []}}
        result = v._validate_layer1("test", config)
        assert result.passed is False
        assert "No module path" in result.issues[0]

    def test_file_not_found(self, tmp_path):
        v = self._validator(tmp_path)
        config = {
            "layer1_implementation": {
                "module": "core.integrations.providers.docling.service",
                "files": ["nonexistent.py"],
            }
        }
        result = v._validate_layer1("test", config)
        assert result.passed is False
        assert any("not found" in i for i in result.issues)

    def test_file_exists(self, tmp_path):
        v = self._validator(tmp_path)
        # Create directory structure and file
        mod_dir = tmp_path / "core" / "integrations" / "providers" / "docling"
        mod_dir.mkdir(parents=True)
        (mod_dir / "service.py").write_text("# ok")
        config = {
            "layer1_implementation": {
                "module": "core.integrations.providers.docling.service",
                "files": ["service.py"],
            }
        }
        mod, src = _make_mock_module()
        with patch("importlib.import_module", return_value=mod), \
             patch.object(inspect, "getsource", return_value=src):
            result = v._validate_layer1("test", config)
        assert result.checks.get("file_exists_service.py") is True

    def test_module_importable(self, tmp_path):
        v = self._validator(tmp_path)
        config = _make_config()

        def typed_func(x: int) -> str:
            """Documented."""
            return str(x)

        mod, src = _make_mock_module(functions={"typed_func": typed_func})

        with patch("importlib.import_module", return_value=mod), \
             patch.object(inspect, "getsource", return_value=src):
            result = v._validate_layer1("test", config)

        assert result.checks["module_importable"] is True
        assert result.checks["no_oi_dependencies"] is True

    def test_has_oi_dependencies(self, tmp_path):
        v = self._validator(tmp_path)
        config = _make_config()

        mod, src = _make_mock_module(has_oi_import=True)

        with patch("importlib.import_module", return_value=mod), \
             patch.object(inspect, "getsource", return_value=src):
            result = v._validate_layer1("test", config)

        assert result.checks["no_oi_dependencies"] is False
        assert result.passed is False

    def test_import_error(self, tmp_path):
        v = self._validator(tmp_path)
        config = _make_config()

        with patch("importlib.import_module", side_effect=ImportError("no such module")):
            result = v._validate_layer1("test", config)

        assert result.passed is False
        assert result.checks["module_importable"] is False

    def test_general_exception(self, tmp_path):
        v = self._validator(tmp_path)
        config = _make_config()

        with patch("importlib.import_module", side_effect=RuntimeError("boom")):
            result = v._validate_layer1("test", config)

        assert len(result.warnings) == 1
        assert "Error analyzing module: boom" in result.warnings[0]

    def test_no_layer1_config(self, tmp_path):
        v = self._validator(tmp_path)
        config = {}  # No layer1_implementation at all
        result = v._validate_layer1("test", config)
        assert result.passed is False

    def test_type_hints_and_docstrings_low_ratio(self, tmp_path):
        v = self._validator(tmp_path)
        config = _make_config()

        # Function without hints or docstring
        def bare_func(x, y):
            return x + y

        mod, src = _make_mock_module(functions={"bare_func": bare_func})

        with patch("importlib.import_module", return_value=mod), \
             patch.object(inspect, "getsource", return_value=src):
            result = v._validate_layer1("test", config)

        # Should warn about low type hint / docstring ratio
        assert result.checks.get("module_importable") is True

    def test_getsource_raises_type_error(self, tmp_path):
        v = self._validator(tmp_path)
        config = _make_config()

        mod, _ = _make_mock_module()

        with patch("importlib.import_module", return_value=mod), \
             patch.object(inspect, "getsource", side_effect=TypeError("builtin")):
            result = v._validate_layer1("test", config)

        # Should set no_oi_dependencies to True (skip check)
        assert result.checks.get("no_oi_dependencies") is True

    def test_signature_raises_value_error(self, tmp_path):
        """inspect.signature raises ValueError → caught, skipped (line 325)."""
        v = self._validator(tmp_path)
        config = _make_config()

        def some_func(x):
            """Has docstring."""
            return x

        mod, src = _make_mock_module(functions={"some_func": some_func})

        with patch("importlib.import_module", return_value=mod), \
             patch.object(inspect, "getsource", return_value=src), \
             patch.object(inspect, "signature", side_effect=ValueError("no sig")):
            result = v._validate_layer1("test", config)

        assert result.checks["module_importable"] is True


# ─── _validate_layer2 ────────────────────────────────────────────────────────


class TestValidateLayer2:
    def _validator(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        return IntegrationValidator(aether_backend_root=tmp_path)

    def test_no_init_file(self, tmp_path):
        v = self._validator(tmp_path)
        config = {"layer2_exposure": {"init_file": "", "exports": []}}
        result = v._validate_layer2("test", config)
        assert result.passed is False
        assert "No init_file" in result.issues[0]

    def test_no_layer2_config(self, tmp_path):
        v = self._validator(tmp_path)
        config = {}
        result = v._validate_layer2("test", config)
        assert result.passed is False

    def test_module_with_all_and_exports(self, tmp_path):
        v = self._validator(tmp_path)
        config = {"layer2_exposure": {
            "init_file": "core.integrations.providers.docling",
            "exports": ["DoclingService"],
        }}

        mod = types.ModuleType("fake_init")
        mod.__all__ = ["DoclingService"]
        mod.DoclingService = type("DoclingService", (), {})

        with patch("importlib.import_module", return_value=mod):
            result = v._validate_layer2("test", config)

        assert result.passed is True
        assert result.checks["has_all_list"] is True
        assert result.checks["exports_in_all"] is True
        assert result.checks["exports_exist"] is True

    def test_missing_all_list(self, tmp_path):
        v = self._validator(tmp_path)
        config = {"layer2_exposure": {
            "init_file": "core.integrations.providers.docling",
            "exports": ["DoclingService"],
        }}

        mod = types.ModuleType("fake_init")
        # No __all__ attribute

        with patch("importlib.import_module", return_value=mod):
            result = v._validate_layer2("test", config)

        assert result.passed is False
        assert result.checks["has_all_list"] is False

    def test_exports_not_in_all(self, tmp_path):
        v = self._validator(tmp_path)
        config = {"layer2_exposure": {
            "init_file": "core.integrations.providers.docling",
            "exports": ["DoclingService", "MissingExport"],
        }}

        mod = types.ModuleType("fake_init")
        mod.__all__ = ["DoclingService"]
        mod.DoclingService = type("DoclingService", (), {})

        with patch("importlib.import_module", return_value=mod):
            result = v._validate_layer2("test", config)

        assert result.passed is False
        assert result.checks["exports_in_all"] is False

    def test_export_attr_missing(self, tmp_path):
        v = self._validator(tmp_path)
        config = {"layer2_exposure": {
            "init_file": "core.integrations.providers.docling",
            "exports": ["DoclingService"],
        }}

        mod = types.ModuleType("fake_init")
        mod.__all__ = ["DoclingService"]
        # DoclingService NOT set as attribute

        with patch("importlib.import_module", return_value=mod):
            result = v._validate_layer2("test", config)

        assert result.passed is False
        assert result.checks["exports_exist"] is False

    def test_import_error(self, tmp_path):
        v = self._validator(tmp_path)
        config = {"layer2_exposure": {
            "init_file": "core.integrations.nonexistent",
            "exports": [],
        }}

        with patch("importlib.import_module", side_effect=ImportError("no module")):
            result = v._validate_layer2("test", config)

        assert result.passed is False
        assert result.checks["init_module_importable"] is False

    def test_general_exception(self, tmp_path):
        v = self._validator(tmp_path)
        config = {"layer2_exposure": {
            "init_file": "core.integrations.providers.docling",
            "exports": [],
        }}

        with patch("importlib.import_module", side_effect=RuntimeError("boom")):
            result = v._validate_layer2("test", config)

        assert len(result.warnings) == 1
        assert "Error analyzing exposure: boom" in result.warnings[0]


# ─── validate_all ────────────────────────────────────────────────────────────


class TestValidateAll:
    def test_empty_registry(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {})
        validator = IntegrationValidator(aether_backend_root=tmp_path)
        reports = validator.validate_all()
        assert reports == {}

    def test_validates_integration_successfully(self, tmp_path):
        """validate_all stores successful report (line 195)."""
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {"good": _make_config()})
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        mock_report = IntegrationValidationReport(
            integration_name="good",
            enabled=True,
            overall_compliant=True,
            layer1=LayerValidation(1, True),
            layer2=LayerValidation(2, True),
            layer3=LayerValidation(3, True),
            layer4=LayerValidation(4, True),
        )
        with patch.object(validator, "validate_integration", return_value=mock_report):
            reports = validator.validate_all()

        assert "good" in reports
        assert reports["good"].overall_compliant is True

    def test_exception_creates_error_report(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {"bad": {"enabled": True}})
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        with patch.object(validator, "validate_integration", side_effect=RuntimeError("boom")):
            reports = validator.validate_all()

        assert "bad" in reports
        assert reports["bad"].overall_compliant is False


# ─── validate_integration ────────────────────────────────────────────────────


class TestValidateIntegration:
    def test_all_layers_pass(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        with patch.object(validator, "_validate_layer1", return_value=LayerValidation(1, True)), \
             patch.object(validator, "_validate_layer2", return_value=LayerValidation(2, True)), \
             patch.object(validator, "_validate_layer3", return_value=LayerValidation(3, True)), \
             patch.object(validator, "_validate_layer4", return_value=LayerValidation(4, True)):
            report = validator.validate_integration("test", {"enabled": True})

        assert report.overall_compliant is True

    def test_one_layer_fails(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        validator = IntegrationValidator(aether_backend_root=tmp_path)

        with patch.object(validator, "_validate_layer1", return_value=LayerValidation(1, False, issues=["fail"])), \
             patch.object(validator, "_validate_layer2", return_value=LayerValidation(2, True)), \
             patch.object(validator, "_validate_layer3", return_value=LayerValidation(3, True)), \
             patch.object(validator, "_validate_layer4", return_value=LayerValidation(4, True)):
            report = validator.validate_integration("test", {"enabled": True})

        assert report.overall_compliant is False
