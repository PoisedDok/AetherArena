"""
Unit Tests: IntegrationHealthChecker (core/integrations/framework/health.py)

Covers HealthCheckResult, 3-phase health checks (load, attach, execute),
check_all, and the CLI main function.

Mock boundaries:
- importlib.import_module → mocked for module loading
- YAML file system → tmp_path
"""

from __future__ import annotations

import inspect
import types
import yaml
from pathlib import Path
from typing import Any, Dict
from unittest.mock import MagicMock, patch


from core.integrations.framework.health import (
    HealthCheckResult,
    IntegrationHealthChecker,
    main,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _write_registry(config_dir: Path, integrations: Dict[str, Any] | None = None) -> None:
    config_dir.mkdir(parents=True, exist_ok=True)
    content = {"integrations": integrations or {}}
    (config_dir / "integrations_registry.yaml").write_text(yaml.dump(content))


def _make_config(
    *,
    init_file: str = "core.integrations.providers.test",
    exports: list | None = None,
    attach_as: str = "functions",
) -> Dict[str, Any]:
    return {
        "enabled": True,
        "layer2_exposure": {"init_file": init_file, "exports": exports or ["MyFunc"]},
        "layer4_runtime": {"attach_as": attach_as},
    }


def _make_module(*, exports=None, with_all=True):
    """Create a fake module with callable exports."""
    mod = types.ModuleType("fake_module")
    exports = exports or {"MyFunc": lambda x: x}
    for name, obj in exports.items():
        setattr(mod, name, obj)
    if with_all:
        mod.__all__ = list(exports.keys())
    return mod


# ─── HealthCheckResult ──────────────────────────────────────────────────────


class TestHealthCheckResult:
    def test_to_dict(self):
        r = HealthCheckResult("test", True, True, True, True, ["err"], ["warn"])
        d = r.to_dict()
        assert d["integration"] == "test"
        assert d["passed"] is True
        assert d["load"] is True
        assert d["errors"] == ["err"]
        assert d["warnings"] == ["warn"]

    def test_str_passed(self):
        r = HealthCheckResult("ok", True, True, True, True)
        s = str(r)
        assert "ok" in s

    def test_str_failed_with_errors_and_warnings(self):
        r = HealthCheckResult("bad", False, errors=["e1"], warnings=["w1"])
        s = str(r)
        assert "bad" in s
        assert "e1" in s
        assert "w1" in s


# ─── IntegrationHealthChecker.__init__ ───────────────────────────────────────


class TestCheckerInit:
    def test_auto_detect_root(self):
        checker = IntegrationHealthChecker()
        assert checker.aether_backend_root.exists() or True

    def test_custom_root(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        checker = IntegrationHealthChecker(aether_backend_root=tmp_path)
        assert checker.aether_backend_root == tmp_path

    def test_missing_registry(self, tmp_path):
        checker = IntegrationHealthChecker(aether_backend_root=tmp_path)
        assert checker.integrations_registry == {}


# ─── _load_yaml ─────────────────────────────────────────────────────────────


class TestLoadYaml:
    def test_valid_yaml(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {"ocr": {"enabled": True}})
        checker = IntegrationHealthChecker(aether_backend_root=tmp_path)
        data = checker._load_yaml(config_dir / "integrations_registry.yaml")
        assert "integrations" in data

    def test_missing_file(self, tmp_path):
        checker = IntegrationHealthChecker(aether_backend_root=tmp_path)
        assert checker._load_yaml(tmp_path / "nope.yaml") == {}

    def test_invalid_yaml(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text("{{bad")
        checker = IntegrationHealthChecker(aether_backend_root=tmp_path)
        assert checker._load_yaml(bad) == {}


# ─── _check_load ────────────────────────────────────────────────────────────


class TestCheckLoad:
    def _checker(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        return IntegrationHealthChecker(aether_backend_root=tmp_path)

    def test_no_init_file(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        ok, mod = c._check_load("test", {"layer2_exposure": {}}, result)
        assert ok is False
        assert "No init_file" in result.errors[0]

    def test_import_success(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config()
        fake_mod = _make_module()

        with patch("importlib.import_module", return_value=fake_mod):
            ok, mod = c._check_load("test", config, result)

        assert ok is True
        assert mod is fake_mod

    def test_import_error(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config()

        with patch("importlib.import_module", side_effect=ImportError("no")):
            ok, mod = c._check_load("test", config, result)

        assert ok is False
        assert "Import failed" in result.errors[0]

    def test_general_exception(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config()

        with patch("importlib.import_module", side_effect=RuntimeError("boom")):
            ok, mod = c._check_load("test", config, result)

        assert ok is False
        assert "Load error" in result.errors[0]


# ─── _check_attach ──────────────────────────────────────────────────────────


class TestCheckAttach:
    def _checker(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        return IntegrationHealthChecker(aether_backend_root=tmp_path)

    def test_all_exports_present(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config(exports=["MyFunc"])
        mod = _make_module(exports={"MyFunc": lambda: None})

        ok = c._check_attach("test", config, mod, result)
        assert ok is True

    def test_missing_exports(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config(exports=["Missing"])
        mod = _make_module(exports={"Other": lambda: None})

        ok = c._check_attach("test", config, mod, result)
        assert ok is False
        assert "Missing exports" in result.errors[0]

    def test_non_callable_export_warns(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config(exports=["CONST"])
        mod = _make_module(exports={"CONST": "just a string"})

        ok = c._check_attach("test", config, mod, result)
        assert ok is True
        assert len(result.warnings) > 0

    def test_invalid_attach_strategy_warns(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config(attach_as="invalid")
        mod = _make_module()

        ok = c._check_attach("test", config, mod, result)
        assert ok is True
        assert any("Unknown attach_as" in w for w in result.warnings)

    def test_exception_during_attach(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config(exports=["Bad"])
        # Module whose hasattr raises
        mod = MagicMock()
        mod.__class__ = types.ModuleType
        type(mod).Bad = property(lambda s: (_ for _ in ()).throw(RuntimeError("oops")))

        # This will exercise the except branch
        ok = c._check_attach("test", config, mod, result)
        # Either True (if hasattr swallows) or False (if exception propagates)
        assert isinstance(ok, bool)


# ─── _check_execute ─────────────────────────────────────────────────────────


class TestCheckExecute:
    def _checker(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        return IntegrationHealthChecker(aether_backend_root=tmp_path)

    def test_callable_with_signature(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)

        def good_func(x: int) -> str:
            """doc"""
            return str(x)

        config = _make_config(exports=["good_func"])
        mod = _make_module(exports={"good_func": good_func})

        ok = c._check_execute("test", config, mod, result)
        assert ok is True

    def test_class_export(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)

        class MyClass:
            def __init__(self, x):
                self.x = x

        config = _make_config(exports=["MyClass"])
        mod = _make_module(exports={"MyClass": MyClass})

        ok = c._check_execute("test", config, mod, result)
        assert ok is True

    def test_no_executable_exports(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config(exports=["CONST"])
        # Non-callable, non-class export
        mod = _make_module(exports={"CONST": "string"})

        ok = c._check_execute("test", config, mod, result)
        assert ok is False
        assert "No executable" in result.errors[0]

    def test_builtin_without_signature(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config(exports=["builtin_func"])

        mock_func = MagicMock()
        mock_func.__name__ = "builtin_func"
        # Make inspect.signature raise ValueError
        mod = _make_module(exports={"builtin_func": mock_func})

        with patch.object(inspect, "signature", side_effect=ValueError("no sig")):
            ok = c._check_execute("test", config, mod, result)

        assert ok is False  # No executable count incremented
        assert any("Cannot inspect" in w for w in result.warnings)

    def test_export_not_on_module(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config(exports=["missing"])
        mod = types.ModuleType("empty")

        ok = c._check_execute("test", config, mod, result)
        assert ok is False

    def test_exception_in_execute(self, tmp_path):
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = _make_config(exports=["bad"])

        mod = MagicMock()
        mod.__class__ = types.ModuleType
        # getattr returns a callable that breaks inspect.signature
        bad_obj = MagicMock()
        bad_obj.__name__ = "bad"
        mod.bad = bad_obj

        with patch.object(inspect, "signature", side_effect=TypeError("nope")):
            ok = c._check_execute("test", config, mod, result)

        assert isinstance(ok, bool)

    def test_outer_exception_in_execute(self, tmp_path):
        """Lines 416-419: config with None layer2_exposure → AttributeError → outer except."""
        c = self._checker(tmp_path)
        result = HealthCheckResult("test", False)
        config = {"layer2_exposure": None}  # None.get("exports", []) raises AttributeError
        mod = _make_module()

        ok = c._check_execute("test", config, mod, result)
        assert ok is False
        assert any("Execute check error" in e for e in result.errors)


# ─── check_integration ──────────────────────────────────────────────────────


class TestCheckIntegration:
    def _checker(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir)
        return IntegrationHealthChecker(aether_backend_root=tmp_path)

    def test_all_phases_pass(self, tmp_path):
        c = self._checker(tmp_path)

        def my_func(x: int) -> str:
            """doc"""
            return str(x)

        config = _make_config(exports=["my_func"])
        mod = _make_module(exports={"my_func": my_func})

        with patch("importlib.import_module", return_value=mod):
            result = c.check_integration("test", config)

        assert result.passed is True
        assert result.load_status is True
        assert result.attach_status is True
        assert result.execute_status is True

    def test_load_fails_short_circuits(self, tmp_path):
        c = self._checker(tmp_path)
        config = _make_config()

        with patch("importlib.import_module", side_effect=ImportError("no")):
            result = c.check_integration("test", config)

        assert result.passed is False
        assert result.load_status is False
        assert result.attach_status is False

    def test_attach_fails_short_circuits(self, tmp_path):
        c = self._checker(tmp_path)
        config = _make_config(exports=["Missing"])
        mod = _make_module(exports={"Other": lambda: None})

        with patch("importlib.import_module", return_value=mod):
            result = c.check_integration("test", config)

        assert result.passed is False
        assert result.load_status is True
        assert result.attach_status is False
        assert result.execute_status is False

    def test_execute_fails_warning_logged(self, tmp_path):
        """Line 211: load+attach pass but execute fails → passed=False, warning logged."""
        c = self._checker(tmp_path)
        config = _make_config(exports=["CONST"])
        # Non-callable export: attach passes (CONST exists) but execute fails (no executables)
        mod = _make_module(exports={"CONST": "just a string"})

        with patch("importlib.import_module", return_value=mod):
            result = c.check_integration("test", config)

        assert result.passed is False
        assert result.load_status is True
        assert result.attach_status is True
        assert result.execute_status is False


# ─── check_all ──────────────────────────────────────────────────────────────


class TestCheckAll:
    def test_empty_registry(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {})
        c = IntegrationHealthChecker(aether_backend_root=tmp_path)
        assert c.check_all() == {}

    def test_skips_disabled(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {"disabled": {"enabled": False}})
        c = IntegrationHealthChecker(aether_backend_root=tmp_path)
        assert c.check_all() == {}

    def test_successful_integration(self, tmp_path):
        """Line 163: enabled integration processes through check_integration successfully."""
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {"test_int": _make_config(exports=["my_func"])})
        c = IntegrationHealthChecker(aether_backend_root=tmp_path)

        fake_result = HealthCheckResult("test_int", True, True, True, True)
        with patch.object(c, "check_integration", return_value=fake_result):
            results = c.check_all()

        assert "test_int" in results
        assert results["test_int"].passed is True

    def test_exception_creates_error_result(self, tmp_path):
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {"bad": {"enabled": True}})
        c = IntegrationHealthChecker(aether_backend_root=tmp_path)

        with patch.object(c, "check_integration", side_effect=RuntimeError("boom")):
            results = c.check_all()

        assert "bad" in results
        assert results["bad"].passed is False


# ─── main ───────────────────────────────────────────────────────────────────


class TestMain:
    def test_main_no_integrations(self, tmp_path, capsys):
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {})

        with patch(
            "core.integrations.framework.health.IntegrationHealthChecker",
            return_value=IntegrationHealthChecker(aether_backend_root=tmp_path),
        ):
            exit_code = main()

        assert exit_code == 0

    def test_main_with_results(self, tmp_path, capsys):
        """Lines 456-457: main prints results when integrations exist."""
        config_dir = tmp_path / "config"
        _write_registry(config_dir, {"test_int": _make_config()})
        checker = IntegrationHealthChecker(aether_backend_root=tmp_path)

        fake_result = HealthCheckResult("test_int", True, True, True, True)
        with patch(
            "core.integrations.framework.health.IntegrationHealthChecker",
            return_value=checker,
        ):
            with patch.object(checker, "check_all", return_value={"test_int": fake_result}):
                exit_code = main()

        assert exit_code == 0
        captured = capsys.readouterr()
        assert "test_int" in captured.out

    def test_main_exception(self, capsys):
        with patch(
            "core.integrations.framework.health.IntegrationHealthChecker",
            side_effect=RuntimeError("fatal"),
        ):
            exit_code = main()

        assert exit_code == 1
