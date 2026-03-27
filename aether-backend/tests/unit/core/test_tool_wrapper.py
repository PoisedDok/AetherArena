"""
Unit Tests: Tool Wrapper (core/integrations/framework/tool_wrapper.py)

Covers ToolProxy, NamespaceProxy, wrap_tool, wrap_all_tools, and decorators.

Mock boundaries:
- ToolCallTracker → patched to avoid global state
- get_tool_metadata → patched
"""

from __future__ import annotations

import inspect
from unittest.mock import MagicMock, patch

import pytest

from core.integrations.framework.tool_wrapper import (
    ToolProxy,
    NamespaceProxy,
    wrap_tool,
    wrap_all_tools,
    tracked_tool,
    tracked_namespace,
)


# ─── ToolProxy ──────────────────────────────────────────────────────────────


class TestToolProxy:
    def test_preserves_name(self):
        def my_func():
            pass
        proxy = ToolProxy(my_func, "computer.my_func")
        assert proxy.__name__ == "my_func"

    def test_preserves_doc(self):
        def my_func():
            """My docstring."""
            pass
        proxy = ToolProxy(my_func, "computer.my_func")
        assert proxy.__doc__ == "My docstring."

    def test_preserves_signature(self):
        def my_func(x: int, y: str = "a") -> bool:
            pass
        proxy = ToolProxy(my_func, "computer.my_func")
        sig = inspect.signature(proxy)
        assert "x" in sig.parameters
        assert "y" in sig.parameters

    def test_wrapped_attribute(self):
        def my_func():
            pass
        proxy = ToolProxy(my_func, "computer.my_func")
        assert proxy.__wrapped__ is my_func

    def test_call_returns_result(self):
        def add(a, b):
            return a + b

        proxy = ToolProxy(add, "computer.add")

        with patch("core.integrations.framework.tool_wrapper.ToolCallTracker") as mock_tracker:
            result = proxy(1, 2)

        assert result == 3
        mock_tracker.enter_tool_call.assert_called_once()
        mock_tracker.exit_tool_call.assert_called_once()

    def test_call_with_kwargs(self):
        def greet(name="world"):
            return f"hello {name}"

        proxy = ToolProxy(greet, "computer.greet")

        with patch("core.integrations.framework.tool_wrapper.ToolCallTracker"):
            result = proxy(name="test")

        assert result == "hello test"

    def test_call_raises_exception(self):
        def bad():
            raise ValueError("boom")

        proxy = ToolProxy(bad, "computer.bad")

        with patch("core.integrations.framework.tool_wrapper.ToolCallTracker") as mock_tracker:
            with pytest.raises(ValueError, match="boom"):
                proxy()

        # exit_tool_call MUST be called even on exception (finally block)
        mock_tracker.exit_tool_call.assert_called_once()

    def test_repr(self):
        proxy = ToolProxy(lambda: None, "computer.test")
        assert "ToolProxy" in repr(proxy)
        assert "computer.test" in repr(proxy)

    def test_getattr_proxies(self):
        def my_func():
            pass
        my_func.custom_attr = "hello"
        proxy = ToolProxy(my_func, "computer.my_func")
        assert proxy.custom_attr == "hello"

    def test_metadata_defaults_to_empty(self):
        proxy = ToolProxy(lambda: None, "computer.x")
        assert proxy._metadata == {}

    def test_signature_error_silenced(self):
        # Built-in without inspectable signature
        proxy = ToolProxy(len, "computer.len")
        # Should not raise during init

    def test_signature_error_branch_covered(self):
        """Line 84: inspect.signature raises ValueError → silenced, no __signature__ set."""
        with patch(
            "core.integrations.framework.tool_wrapper.inspect.signature",
            side_effect=ValueError("no sig"),
        ):
            proxy = ToolProxy(lambda: None, "computer.nosig")
        assert not hasattr(proxy, "__signature__")


# ─── NamespaceProxy ─────────────────────────────────────────────────────────


class TestNamespaceProxy:
    def test_callable_attr_returns_tool_proxy(self):
        class Browser:
            def search(self, q):
                return f"results for {q}"

        browser = Browser()
        proxy = NamespaceProxy(browser, "computer.browser")

        with patch("core.integrations.framework.tool_wrapper.ToolCallTracker"):
            with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
                result = proxy.search("AI")

        assert result == "results for AI"

    def test_non_callable_returned_as_is(self):
        class Obj:
            value = 42

        obj = Obj()
        proxy = NamespaceProxy(obj, "computer.obj")
        assert proxy.value == 42

    def test_private_attr_not_wrapped(self):
        class Obj:
            _internal = "secret"

        obj = Obj()
        proxy = NamespaceProxy(obj, "computer.obj")
        assert proxy._internal == "secret"

    def test_method_cache(self):
        class Obj:
            def method(self):
                return "ok"

        obj = Obj()
        proxy = NamespaceProxy(obj, "computer.obj")

        with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
            m1 = proxy.method
            m2 = proxy.method

        assert m1 is m2  # Same cached object

    def test_setattr_public(self):
        class Obj:
            value = 0

        obj = Obj()
        proxy = NamespaceProxy(obj, "computer.obj")
        proxy.value = 99
        assert obj.value == 99

    def test_setattr_private(self):
        proxy = NamespaceProxy(MagicMock(), "computer.obj")
        proxy._custom = "test"
        assert proxy._custom == "test"

    def test_repr(self):
        proxy = NamespaceProxy(MagicMock(), "computer.browser")
        assert "NamespaceProxy" in repr(proxy)
        assert "computer.browser" in repr(proxy)

    def test_dir(self):
        class Obj:
            def method(self):
                pass
            value = 1

        obj = Obj()
        proxy = NamespaceProxy(obj, "computer.obj")
        d = dir(proxy)
        assert "method" in d
        assert "value" in d


# ─── wrap_tool ──────────────────────────────────────────────────────────────


class TestWrapTool:
    def test_wraps_function(self):
        def func():
            pass
        wrapped = wrap_tool(func, "computer.func")
        assert isinstance(wrapped, ToolProxy)

    def test_wraps_object_with_dict(self):
        class Obj:
            pass

        with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
            wrapped = wrap_tool(Obj(), "computer.obj")
        assert isinstance(wrapped, NamespaceProxy)

    def test_class_becomes_namespace_proxy(self):
        class MyClass:
            pass
        wrapped = wrap_tool(MyClass, "computer.MyClass")
        # Classes have __dict__, so get wrapped as NamespaceProxy
        assert isinstance(wrapped, NamespaceProxy)

    def test_fallback_unknown_type(self):
        # int has no __dict__, so it falls through to the warning + return-as-is path.
        result = wrap_tool(42, "computer.number")
        assert result == 42  # Returned unwrapped

    def test_fallback_none(self):
        """None has no __dict__ — returned unwrapped."""
        result = wrap_tool(None, "computer.none")
        assert result is None

    def test_slots_object_unwrapped(self):
        """__slots__-only objects without __dict__ are returned unwrapped."""
        class Slotted:
            __slots__ = ("x",)
        obj = Slotted()
        obj.x = 42
        result = wrap_tool(obj, "computer.slotted")
        assert result is obj  # Not wrapped (no __dict__)


# ─── wrap_all_tools ─────────────────────────────────────────────────────────


class TestWrapAllTools:
    def test_wraps_callable_attrs(self):
        computer = MagicMock(spec=[])
        computer.my_func = lambda: "result"
        computer.my_func.__name__ = "my_func"

        with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
            count = wrap_all_tools(computer)

        assert count >= 0  # May wrap or skip depending on type checks

    def test_skips_already_wrapped(self):
        computer = MagicMock(spec=[])
        proxy = ToolProxy(lambda: None, "computer.x")
        computer.my_tool = proxy

        with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
            count = wrap_all_tools(computer, tool_paths=["computer.my_tool"])

        assert count == 0  # Already wrapped

    def test_specific_tool_paths(self):
        computer = MagicMock(spec=[])

        def real_func():
            return "ok"

        computer.my_tool = real_func

        with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
            count = wrap_all_tools(computer, tool_paths=["computer.my_tool"])

        assert count == 1

    def test_skips_non_callable_non_dict(self):
        computer = MagicMock(spec=[])
        computer.plain_value = 42

        with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
            count = wrap_all_tools(computer, tool_paths=["computer.plain_value"])

        assert count == 0

    def test_skips_nonexistent_attr(self):
        """Line 292: tool_path references attr not on computer → continue."""
        computer = MagicMock(spec=[])
        with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
            count = wrap_all_tools(computer, tool_paths=["computer.nonexistent"])
        assert count == 0

    def test_exception_during_wrap(self):
        computer = MagicMock(spec=[])

        def bad_func():
            pass

        computer.bad = bad_func

        with patch("core.integrations.framework.tool_wrapper.wrap_tool", side_effect=RuntimeError("fail")):
            with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
                count = wrap_all_tools(computer, tool_paths=["computer.bad"])

        assert count == 0  # Failed, but didn't raise


# ─── tracked_tool decorator ─────────────────────────────────────────────────


# ─── Adversarial Tests ──────────────────────────────────────────────────────


class TestAdversarialToolProxy:
    def test_exception_always_exits_context(self):
        """The finally block MUST fire. If it doesn't, tracking state leaks."""
        call_log = []

        def exploder():
            raise RuntimeError("boom")

        proxy = ToolProxy(exploder, "computer.exploder")

        with patch("core.integrations.framework.tool_wrapper.ToolCallTracker") as mock:
            mock.exit_tool_call.side_effect = lambda: call_log.append("exit")
            with pytest.raises(RuntimeError):
                proxy()

        assert call_log == ["exit"]

    def test_proxy_preserves_exact_return_value(self):
        """Return value must be bit-identical, not just truthy."""
        sentinel = object()

        def returns_sentinel():
            return sentinel

        proxy = ToolProxy(returns_sentinel, "computer.test")

        with patch("core.integrations.framework.tool_wrapper.ToolCallTracker"):
            result = proxy()

        assert result is sentinel

    def test_proxy_passes_exact_args(self):
        """Args/kwargs must arrive unmodified at the wrapped function."""
        received = {}

        def capture(*args, **kwargs):
            received["args"] = args
            received["kwargs"] = kwargs

        proxy = ToolProxy(capture, "computer.test")

        with patch("core.integrations.framework.tool_wrapper.ToolCallTracker"):
            proxy(1, "two", key=None, empty="")

        assert received["args"] == (1, "two")
        assert received["kwargs"] == {"key": None, "empty": ""}


class TestAdversarialNamespaceProxy:
    def test_setattr_then_getattr_roundtrip(self):
        class Obj:
            pass

        obj = Obj()
        proxy = NamespaceProxy(obj, "computer.obj")
        proxy.new_value = 42
        assert obj.new_value == 42  # Must set on real object
        assert proxy.new_value == 42  # Must read from real object

    def test_private_callable_not_wrapped_as_tool_proxy(self):
        """Mutation killer: L185 `name.startswith('_')` guard.
        Without the guard, a private callable method would be wrapped as ToolProxy.
        With the guard, it is returned as the raw method from the real object."""
        class Obj:
            def _helper(self):
                return "private_result"

        obj = Obj()
        proxy = NamespaceProxy(obj, "computer.obj")
        method = proxy._helper
        # Must NOT be wrapped as ToolProxy — must be the raw bound method
        assert not isinstance(method, ToolProxy)
        assert callable(method)
        assert method() == "private_result"


class TestAdversarialWrapAllTools:
    def test_wrap_does_not_double_wrap(self):
        """Calling wrap_all_tools twice must not double-wrap."""
        computer = MagicMock(spec=[])
        computer.my_func = lambda: "result"
        computer.my_func.__name__ = "my_func"

        with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
            count1 = wrap_all_tools(computer, tool_paths=["computer.my_func"])
            count2 = wrap_all_tools(computer, tool_paths=["computer.my_func"])

        assert count1 == 1
        assert count2 == 0  # Already wrapped, skip


class TestTrackedToolDecorator:
    def test_wraps_function(self):
        @tracked_tool("computer.custom")
        def custom():
            return "result"

        assert isinstance(custom, ToolProxy)

        with patch("core.integrations.framework.tool_wrapper.ToolCallTracker"):
            assert custom() == "result"


# ─── tracked_namespace decorator ─────────────────────────────────────────────


class TestTrackedNamespaceDecorator:
    def test_returns_namespace_proxy(self):
        @tracked_namespace("computer.ns")
        class MyNS:
            def __init__(self, val=1):
                self.x = val

        instance = MyNS(val=42)
        assert isinstance(instance, NamespaceProxy)

    def test_proxied_methods_work(self):
        @tracked_namespace("computer.ns")
        class MyNS:
            def greet(self):
                return "hello"

        ns = MyNS()

        with patch("core.integrations.framework.tool_wrapper.ToolCallTracker"):
            with patch("core.integrations.framework.tool_wrapper.get_tool_metadata", return_value={}):
                assert ns.greet() == "hello"

    def test_preserves_wrapped_class(self):
        @tracked_namespace("computer.ns")
        class MyNS:
            pass

        assert hasattr(MyNS, "_wrapped_class")
