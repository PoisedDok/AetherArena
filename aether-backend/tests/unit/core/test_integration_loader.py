"""
Unit Tests: IntegrationLoader (core/integrations/framework/loader.py)

Covers YAML-driven loading, 4-layer attachment strategies, lifecycle shutdown,
tool registration, and layer compliance validation.

Mock boundaries:
- interpreter.computer → MagicMock
- importlib.import_module → patched for dynamic imports
- Path.__file__ / YAML filesystem → tmp_path + patches
"""

from __future__ import annotations

import sys
import types
import yaml
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


from core.integrations.framework.loader import IntegrationLoader


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_interpreter():
    interp = MagicMock()
    interp.computer = MagicMock(spec=[])
    return interp


def _make_registry(integrations=None, runtime=None, validation=None):
    reg = {"integrations": integrations or {}, "runtime": runtime or {}}
    if validation:
        reg["validation"] = validation
    return reg


def _make_integration_config(
    *,
    init_file="core.integrations.providers.test",
    exports=None,
    attach_as="functions",
    namespace="computer",
    enabled=True,
    register_discoverable=False,
    module_path="",
    namespace_alias=None,
    namespace_alias_prefix=None,
    namespace_alias_strip_prefix=True,
):
    config = {
        "enabled": enabled,
        "layer1_implementation": {"module": module_path},
        "layer2_exposure": {"init_file": init_file, "exports": exports or ["my_func"]},
        "layer3_metadata": {"category": "test"},
        "layer4_runtime": {
            "namespace": namespace,
            "attach_as": attach_as,
            "register_discoverable": register_discoverable,
        },
    }
    if namespace_alias:
        config["layer4_runtime"]["namespace_alias"] = namespace_alias
    if namespace_alias_prefix is not None:
        config["layer4_runtime"]["namespace_alias_prefix"] = namespace_alias_prefix
    return config


def _make_module(exports=None, with_all=True):
    mod = types.ModuleType("fake_module")
    exports = exports or {"my_func": lambda x: x}
    for name, obj in exports.items():
        setattr(mod, name, obj)
    if with_all:
        mod.__all__ = list(exports.keys())
    return mod


def _build_loader(registry=None):
    """Build loader with mocked registry (skips filesystem)."""
    interp = _make_interpreter()
    with patch.object(IntegrationLoader, "_load_registry", return_value=registry or _make_registry()):
        loader = IntegrationLoader(interp)
    return loader


# ─── __init__ ────────────────────────────────────────────────────────────────


class TestInit:
    def test_sets_interpreter_and_computer(self):
        loader = _build_loader()
        assert loader.interpreter is not None
        assert loader.computer is not None
        assert loader._loaded_integrations == {}

    def test_calls_ensure_backend_path(self):
        with patch.object(IntegrationLoader, "_ensure_backend_path") as mock_ebp:
            with patch.object(IntegrationLoader, "_load_registry", return_value=_make_registry()):
                IntegrationLoader(_make_interpreter())
        mock_ebp.assert_called_once()


# ─── _ensure_backend_path ────────────────────────────────────────────────────


class TestEnsureBackendPath:
    def test_adds_path_if_not_present(self):
        loader = _build_loader()
        # _ensure_backend_path is called during __init__, so it's already run
        # Just verify no crash occurred

    def test_adds_path_when_missing(self):
        """Lines 72-73: path not in sys.path → insert it."""
        loader = _build_loader()
        # Temporarily remove the backend root from sys.path and call again
        from core.integrations.framework.loader import Path as LPath

        current_file = LPath(__file__).resolve()
        backend_root = current_file.parent.parent.parent.parent
        root_str = str(backend_root)

        original_path = sys.path[:]
        try:
            # Remove all instances of the backend root
            sys.path = [p for p in sys.path if p != root_str]
            loader._ensure_backend_path()
            assert root_str in sys.path
        finally:
            sys.path = original_path

    def test_exception_handled(self):
        with patch("core.integrations.framework.loader.Path", side_effect=OSError("no")):
            loader = _build_loader()  # Must not crash


# ─── _load_registry ──────────────────────────────────────────────────────────


class TestLoadRegistry:
    def test_real_load_registry_valid(self, tmp_path):
        """Lines 79-94: real _load_registry with valid YAML file."""
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        registry_content = {"integrations": {"test": {"enabled": True}}, "runtime": {}}
        (config_dir / "integrations_registry.yaml").write_text(yaml.dump(registry_content))

        # Create fake __file__ path so parent x4 resolves to tmp_path
        fake_file = tmp_path / "core" / "integrations" / "framework" / "loader.py"
        fake_file.parent.mkdir(parents=True, exist_ok=True)
        fake_file.touch()

        interp = _make_interpreter()
        with patch.object(IntegrationLoader, "_ensure_backend_path"):
            with patch("core.integrations.framework.loader.__file__", str(fake_file)):
                loader = IntegrationLoader(interp)

        assert "test" in loader._registry.get("integrations", {})

    def test_real_load_registry_missing_file(self, tmp_path):
        """Lines 86-89: registry file doesn't exist → defaults."""
        # NO config dir → registry_path.exists() returns False
        fake_file = tmp_path / "core" / "integrations" / "framework" / "loader.py"
        fake_file.parent.mkdir(parents=True, exist_ok=True)
        fake_file.touch()

        interp = _make_interpreter()
        with patch.object(IntegrationLoader, "_ensure_backend_path"):
            with patch("core.integrations.framework.loader.__file__", str(fake_file)):
                loader = IntegrationLoader(interp)

        assert loader._registry == {"integrations": {}, "runtime": {}}

    def test_real_load_registry_exception(self, tmp_path):
        """Lines 96-98: exception during registry loading → defaults."""
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        (config_dir / "integrations_registry.yaml").write_text("valid: yaml")

        fake_file = tmp_path / "core" / "integrations" / "framework" / "loader.py"
        fake_file.parent.mkdir(parents=True, exist_ok=True)
        fake_file.touch()

        interp = _make_interpreter()
        with patch.object(IntegrationLoader, "_ensure_backend_path"):
            with patch("core.integrations.framework.loader.__file__", str(fake_file)):
                with patch("core.integrations.framework.loader.yaml.safe_load", side_effect=RuntimeError("corrupt")):
                    loader = IntegrationLoader(interp)

        assert loader._registry == {"integrations": {}, "runtime": {}}


# ─── load_all ────────────────────────────────────────────────────────────────


class TestLoadAll:
    def test_empty_registry(self):
        loader = _build_loader()
        result = loader.load_all()
        assert result == {}

    def test_loads_in_order(self):
        registry = _make_registry(
            integrations={"a": _make_integration_config(), "b": _make_integration_config()},
            runtime={"initialization": {"order": ["b", "a"]}},
        )
        loader = _build_loader(registry)
        mod = _make_module()

        with patch("importlib.import_module", return_value=mod):
            result = loader.load_all()

        assert "b" in result
        assert "a" in result

    def test_skips_disabled(self):
        registry = _make_registry(
            integrations={"disabled_int": _make_integration_config(enabled=False)},
            runtime={"initialization": {"order": ["disabled_int"]}},
        )
        loader = _build_loader(registry)
        result = loader.load_all()
        assert result["disabled_int"]["status"] == "disabled"

    def test_warns_missing_from_registry(self):
        registry = _make_registry(
            integrations={},
            runtime={"initialization": {"order": ["nonexistent"]}},
        )
        loader = _build_loader(registry)
        result = loader.load_all()
        assert "nonexistent" not in result

    def test_counts_loaded(self):
        registry = _make_registry(
            integrations={"a": _make_integration_config()},
            runtime={"initialization": {"order": ["a"]}},
        )
        loader = _build_loader(registry)
        mod = _make_module()

        with patch("importlib.import_module", return_value=mod):
            result = loader.load_all()

        assert result["a"]["status"] == "loaded"


# ─── _load_integration ──────────────────────────────────────────────────────


class TestLoadIntegration:
    def test_success_functions(self):
        loader = _build_loader()
        config = _make_integration_config()
        mod = _make_module()

        with patch("importlib.import_module", return_value=mod):
            status = loader._load_integration("test", config)

        assert status["status"] == "loaded"
        assert "my_func" in status["exports"]

    def test_missing_layer2_config(self):
        loader = _build_loader()
        config = {"layer2_exposure": {}, "layer4_runtime": {}}
        status = loader._load_integration("test", config)
        assert status["status"] == "error"
        assert "Missing" in status["error"]

    def test_missing_exports_from_module(self):
        loader = _build_loader()
        config = _make_integration_config(exports=["nonexistent"])
        mod = _make_module(exports={"other": lambda: None})

        with patch("importlib.import_module", return_value=mod):
            status = loader._load_integration("test", config)

        assert status["status"] == "error"
        assert "No exports found" in status["error"]

    def test_import_error(self):
        loader = _build_loader()
        config = _make_integration_config()

        with patch("importlib.import_module", side_effect=ImportError("no module")):
            status = loader._load_integration("test", config)

        assert status["status"] == "error"
        assert status["error"] == "ImportError"

    def test_namespace_attach(self):
        loader = _build_loader()
        config = _make_integration_config(attach_as="namespace", namespace="computer.myns")
        mod = _make_module()

        with patch("importlib.import_module", return_value=mod):
            status = loader._load_integration("test", config)

        assert status["status"] == "loaded"
        assert status["attach_as"] == "namespace"

    def test_builtin_attach(self):
        loader = _build_loader()
        config = _make_integration_config(attach_as="builtin")
        mod = _make_module()

        with patch("importlib.import_module", return_value=mod):
            status = loader._load_integration("test", config)

        assert status["status"] == "loaded"

    def test_dynamic_attach(self):
        loader = _build_loader()
        config = _make_integration_config(attach_as="dynamic")
        mod = _make_module()

        with patch("importlib.import_module", return_value=mod):
            status = loader._load_integration("test", config)

        assert status["status"] == "loaded"

    def test_unknown_attach_strategy(self):
        loader = _build_loader()
        config = _make_integration_config(attach_as="weird")
        mod = _make_module()

        with patch("importlib.import_module", return_value=mod):
            status = loader._load_integration("test", config)

        assert status["status"] == "loaded"

    def test_partial_exports(self):
        """Some exports found, some missing — loads with what's available."""
        loader = _build_loader()
        config = _make_integration_config(exports=["exists", "missing"])
        mod = _make_module(exports={"exists": lambda: None})

        with patch("importlib.import_module", return_value=mod):
            status = loader._load_integration("test", config)

        assert status["status"] == "loaded"
        assert "exists" in status["exports"]


# ─── _attach_as_functions ────────────────────────────────────────────────────


class TestAttachAsFunctions:
    def test_basic_attachment(self):
        loader = _build_loader()
        items = {"my_func": lambda: "result"}
        loader._attach_as_functions("test", items)
        assert hasattr(loader.computer, "my_func")

    def test_with_namespace_alias(self):
        loader = _build_loader()
        items = {"search_web": lambda: "result", "search_images": lambda: "images"}
        layer4 = {"namespace_alias": "computer.search", "namespace_alias_strip_prefix": True}
        loader._attach_as_functions("test", items, layer4)
        assert hasattr(loader.computer, "search")

    def test_invalid_namespace_alias(self):
        loader = _build_loader()
        items = {"my_func": lambda: None}
        layer4 = {"namespace_alias": "invalid_path"}
        loader._attach_as_functions("test", items, layer4)
        # Should not crash, just log warning

    def test_empty_namespace_alias(self):
        loader = _build_loader()
        items = {"my_func": lambda: None}
        layer4 = {"namespace_alias": "computer."}
        loader._attach_as_functions("test", items, layer4)
        # Empty ns_name derived from "computer." → skip

    def test_namespace_alias_prefix_stripping(self):
        loader = _build_loader()
        items = {"ns_func1": lambda: 1, "ns_func2": lambda: 2}
        layer4 = {
            "namespace_alias": "computer.ns",
            "namespace_alias_prefix": "ns_",
            "namespace_alias_strip_prefix": True,
        }
        loader._attach_as_functions("test", items, layer4)
        assert hasattr(loader.computer, "ns")

    def test_namespace_alias_no_strip(self):
        loader = _build_loader()
        items = {"ns_func": lambda: 1}
        layer4 = {
            "namespace_alias": "computer.ns",
            "namespace_alias_strip_prefix": False,
        }
        loader._attach_as_functions("test", items, layer4)
        assert hasattr(loader.computer, "ns")

    def test_namespace_alias_duplicate_clean_name(self):
        loader = _build_loader()
        # Both would strip to "func" → second should be skipped
        items = {"ns_func": lambda: 1, "func": lambda: 2}
        layer4 = {
            "namespace_alias": "computer.ns",
            "namespace_alias_prefix": "ns_",
            "namespace_alias_strip_prefix": True,
        }
        loader._attach_as_functions("test", items, layer4)

    def test_namespace_alias_already_exists(self):
        loader = _build_loader()
        setattr(loader.computer, "existing_ns", "already here")
        items = {"my_func": lambda: None}
        layer4 = {"namespace_alias": "computer.existing_ns"}
        loader._attach_as_functions("test", items, layer4)
        # Should skip alias creation because namespace already exists
        assert getattr(loader.computer, "existing_ns") == "already here"

    def test_no_layer4_config(self):
        loader = _build_loader()
        items = {"my_func": lambda: None}
        loader._attach_as_functions("test", items, None)
        assert hasattr(loader.computer, "my_func")

    def test_namespace_alias_fallback_prefix(self):
        """When func doesn't start with alias_prefix, try ns_name_ prefix."""
        loader = _build_loader()
        items = {"myns_action": lambda: "ok"}
        layer4 = {
            "namespace_alias": "computer.myns",
            "namespace_alias_prefix": "other_",
            "namespace_alias_strip_prefix": True,
        }
        loader._attach_as_functions("test", items, layer4)
        assert hasattr(loader.computer, "myns")


# ─── _attach_as_namespace ───────────────────────────────────────────────────


class TestAttachAsNamespace:
    def test_function_based_namespace(self):
        loader = _build_loader()
        items = {"ns_action": lambda: "result", "ns_query": lambda: "data"}
        loader._attach_as_namespace("test", "computer.ns", items)
        assert hasattr(loader.computer, "ns")

    def test_function_based_no_prefix(self):
        loader = _build_loader()
        items = {"action": lambda: "result"}
        loader._attach_as_namespace("test", "computer.ns", items)
        assert hasattr(loader.computer, "ns")

    def test_class_based_with_computer(self):
        class MyTools:
            def __init__(self, computer):
                self.computer = computer

        loader = _build_loader()
        items = {"MyTools": MyTools}
        loader._attach_as_namespace("test", "computer.tools", items)
        assert hasattr(loader.computer, "tools")

    def test_class_based_without_computer(self):
        class MyService:
            def __init__(self):
                pass

        loader = _build_loader()
        items = {"MyService": MyService}
        loader._attach_as_namespace("test", "computer.svc", items)
        assert hasattr(loader.computer, "svc")

    def test_class_instantiation_failure(self):
        class BadManager:
            def __init__(self):
                raise RuntimeError("init failed")

        loader = _build_loader()
        items = {"BadManager": BadManager}
        loader._attach_as_namespace("test", "computer.bad", items)
        # Falls back to attaching class directly
        assert hasattr(loader.computer, "bad")

    def test_namespace_without_dot(self):
        loader = _build_loader()
        items = {"func": lambda: None}
        loader._attach_as_namespace("test", "nodot", items)
        # ns_name derived from name parameter when no dot in namespace
        assert hasattr(loader.computer, "test")


# ─── _register_discoverable_tools ──────────────────────────────────────────


class TestRegisterDiscoverableTools:
    def test_registers_callable_tools(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(register_discoverable=True)},
        )
        loader = _build_loader(registry)
        loader._loaded_integrations = {
            "test": {"status": "loaded", "exports": ["my_func"]}
        }

        func = lambda: "result"
        setattr(loader.computer, "my_func", func)
        loader.interpreter.add_tool = MagicMock()

        loader._register_discoverable_tools()
        loader.interpreter.add_tool.assert_called_once_with(func)

    def test_skips_non_loaded(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(register_discoverable=True)},
        )
        loader = _build_loader(registry)
        loader._loaded_integrations = {"test": {"status": "error"}}
        loader._register_discoverable_tools()

    def test_skips_non_discoverable(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(register_discoverable=False)},
        )
        loader = _build_loader(registry)
        loader._loaded_integrations = {"test": {"status": "loaded", "exports": ["x"]}}
        loader._register_discoverable_tools()

    def test_no_add_tool_method(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(register_discoverable=True)},
        )
        loader = _build_loader(registry)
        loader._loaded_integrations = {"test": {"status": "loaded", "exports": ["my_func"]}}
        setattr(loader.computer, "my_func", lambda: None)

        # Remove add_tool from interpreter
        del loader.interpreter.add_tool
        loader._register_discoverable_tools()  # Must not crash

    def test_exception_handled(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(register_discoverable=True)},
        )
        loader = _build_loader(registry)
        loader._loaded_integrations = {"test": {"status": "loaded", "exports": ["my_func"]}}
        setattr(loader.computer, "my_func", lambda: None)
        loader.interpreter.add_tool = MagicMock(side_effect=RuntimeError("boom"))
        loader._register_discoverable_tools()  # Must not crash


# ─── _cleanup_with_timeout ──────────────────────────────────────────────────


class TestCleanupWithTimeout:
    def test_cleanup_success(self):
        loader = _build_loader()
        ns = MagicMock()
        ns.cleanup = MagicMock()
        loader._cleanup_with_timeout("test", ns)
        ns.cleanup.assert_called_once()

    def test_cleanup_exception(self):
        loader = _build_loader()
        ns = MagicMock()
        ns.cleanup.side_effect = RuntimeError("cleanup failed")
        loader._cleanup_with_timeout("test", ns)  # Must not crash

    def test_cleanup_timeout(self):
        loader = _build_loader()
        loader._CLEANUP_TIMEOUT_S = 0.1  # Very short timeout

        ns = MagicMock()

        def slow_cleanup():
            import time
            time.sleep(5)

        ns.cleanup = slow_cleanup
        loader._cleanup_with_timeout("test", ns)  # Must not hang


# ─── shutdown ────────────────────────────────────────────────────────────────


class TestShutdown:
    def test_shutdown_namespace_with_cleanup(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(attach_as="namespace", namespace="computer.myns")},
        )
        loader = _build_loader(registry)
        loader._loaded_integrations = {
            "test": {"status": "loaded", "exports": ["x"], "attach_as": "namespace"}
        }

        ns_obj = MagicMock()
        ns_obj.cleanup = MagicMock()
        setattr(loader.computer, "myns", ns_obj)

        loader.shutdown()
        ns_obj.cleanup.assert_called_once()
        assert loader._loaded_integrations == {}

    def test_shutdown_functions(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(attach_as="functions")},
        )
        loader = _build_loader(registry)
        loader._loaded_integrations = {
            "test": {"status": "loaded", "exports": ["my_func"]}
        }
        setattr(loader.computer, "my_func", lambda: None)

        loader.shutdown()
        assert loader._loaded_integrations == {}

    def test_shutdown_skips_non_loaded(self):
        loader = _build_loader()
        loader._loaded_integrations = {"test": {"status": "error"}}
        loader.shutdown()
        assert loader._loaded_integrations == {}

    def test_shutdown_handles_missing_attr(self):
        """Line 479: delattr on nonexistent function export → except AttributeError."""
        registry = _make_registry(
            integrations={"test": _make_integration_config(attach_as="functions")},
        )
        loader = _build_loader(registry)
        # Use real object so delattr raises properly
        loader.computer = SimpleNamespace()
        loader._loaded_integrations = {
            "test": {"status": "loaded", "exports": ["nonexistent"]}
        }
        loader.shutdown()  # delattr raises AttributeError → caught

    def test_shutdown_exception_handled(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(attach_as="namespace", namespace="computer.bad")},
        )
        loader = _build_loader(registry)
        loader._loaded_integrations = {
            "test": {"status": "loaded", "exports": ["x"]}
        }
        # Make getattr raise on the ns_name
        type(loader.computer).bad = property(
            lambda self: (_ for _ in ()).throw(RuntimeError("boom"))
        )
        loader.shutdown()  # Must not crash

    def test_shutdown_namespace_no_cleanup_method(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(attach_as="namespace", namespace="computer.myns")},
        )
        loader = _build_loader(registry)
        loader._loaded_integrations = {
            "test": {"status": "loaded", "exports": ["x"]}
        }
        # Object without cleanup method
        ns_obj = SimpleNamespace(data="value")
        setattr(loader.computer, "myns", ns_obj)
        loader.shutdown()

    def test_shutdown_delattr_raises(self):
        """Line 471: delattr on namespace raises AttributeError → caught."""
        registry = _make_registry(
            integrations={"test": _make_integration_config(attach_as="namespace", namespace="computer.myns")},
        )
        loader = _build_loader(registry)
        # Use real object so delattr raises AttributeError for nonexistent attrs
        loader.computer = SimpleNamespace()
        # Set ns_obj so we enter the cleanup path, but then delattr will
        # raise because SimpleNamespace allows it but we'll delete first
        ns_obj = SimpleNamespace(data="value")
        loader.computer.myns = ns_obj
        # Now manually delete it so the delattr inside shutdown raises
        del loader.computer.myns
        loader._loaded_integrations = {
            "test": {"status": "loaded", "exports": ["x"]}
        }
        # getattr(self.computer, "myns", None) → None, so cleanup is skipped
        # We need a different approach: make getattr return non-None but delattr fails
        # Use a class where delattr raises
        class ProtectedComputer:
            def __init__(self):
                self._ns = SimpleNamespace(data="value")

            def __getattr__(self, name):
                if name == "myns":
                    return self._ns
                raise AttributeError(name)

            def __delattr__(self, name):
                if name == "myns":
                    raise AttributeError("cannot delete myns")
                super().__delattr__(name)

        loader.computer = ProtectedComputer()
        loader.shutdown()


# ─── Query Methods ──────────────────────────────────────────────────────────


class TestQueryMethods:
    def test_get_loaded_integrations(self):
        loader = _build_loader()
        loader._loaded_integrations = {
            "a": {"status": "loaded"},
            "b": {"status": "error"},
            "c": {"status": "loaded"},
        }
        loaded = loader.get_loaded_integrations()
        assert "a" in loaded
        assert "c" in loaded
        assert "b" not in loaded

    def test_is_loaded(self):
        loader = _build_loader()
        loader._loaded_integrations = {"test": {"status": "loaded"}}
        assert loader.is_loaded("test") is True
        assert loader.is_loaded("other") is False

    def test_get_integration_summary_all_types(self):
        loader = _build_loader()
        loader._loaded_integrations = {
            "ok": {"status": "loaded"},
            "bad": {"status": "error"},
            "off": {"status": "disabled"},
        }
        summary = loader.get_integration_summary()
        assert "ok" in summary
        assert "bad" in summary
        assert "off" in summary
        assert "Failed" in summary
        assert "Disabled" in summary

    def test_get_integration_summary_empty(self):
        loader = _build_loader()
        summary = loader.get_integration_summary()
        assert "0/0" in summary


# ─── Validation Methods ─────────────────────────────────────────────────────


class TestValidation:
    def test_validate_layer_compliance(self):
        registry = _make_registry(
            integrations={"test": _make_integration_config(module_path="json")},
        )
        loader = _build_loader(registry)
        results = loader.validate_layer_compliance()
        assert "test" in results
        assert "layer1_implementation" in results["test"]

    def test_validate_layer1_success(self):
        loader = _build_loader()
        config = _make_integration_config(module_path="json")
        assert loader._validate_layer1("test", config, {}) is True

    def test_validate_layer1_missing_module(self):
        loader = _build_loader()
        config = {"layer1_implementation": {}}
        assert loader._validate_layer1("test", config, {}) is False

    def test_validate_layer1_import_error(self):
        loader = _build_loader()
        config = _make_integration_config(module_path="nonexistent_module_xyz")
        assert loader._validate_layer1("test", config, {}) is False

    def test_validate_layer2_success(self):
        loader = _build_loader()
        mod = _make_module(exports={"my_func": lambda: None}, with_all=True)
        config = _make_integration_config(exports=["my_func"])

        with patch("importlib.import_module", return_value=mod):
            result = loader._validate_layer2("test", config, {})

        assert result is True

    def test_validate_layer2_no_all(self):
        loader = _build_loader()
        mod = _make_module(exports={"my_func": lambda: None}, with_all=False)
        config = _make_integration_config(exports=["my_func"])

        with patch("importlib.import_module", return_value=mod):
            result = loader._validate_layer2("test", config, {})

        assert result is False

    def test_validate_layer2_missing_from_all(self):
        loader = _build_loader()
        mod = _make_module(exports={"other": lambda: None})
        config = _make_integration_config(exports=["my_func"])

        with patch("importlib.import_module", return_value=mod):
            result = loader._validate_layer2("test", config, {})

        assert result is False

    def test_validate_layer2_missing_config(self):
        loader = _build_loader()
        config = {"layer2_exposure": {}}
        assert loader._validate_layer2("test", config, {}) is False

    def test_validate_layer2_import_error(self):
        loader = _build_loader()
        config = _make_integration_config()

        with patch("importlib.import_module", side_effect=ImportError("no")):
            result = loader._validate_layer2("test", config, {})

        assert result is False

    def test_validate_layer3_complete(self):
        loader = _build_loader()
        config = _make_integration_config()
        assert loader._validate_layer3("test", config, {}) is True

    def test_validate_layer3_missing_keys(self):
        loader = _build_loader()
        config = {"layer1_implementation": {}}
        assert loader._validate_layer3("test", config, {}) is False

    def test_validate_layer4_complete(self):
        loader = _build_loader()
        config = _make_integration_config()
        assert loader._validate_layer4("test", config, {}) is True

    def test_validate_layer4_missing_keys(self):
        loader = _build_loader()
        config = {"layer4_runtime": {}}
        assert loader._validate_layer4("test", config, {}) is False
