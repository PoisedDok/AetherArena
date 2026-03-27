"""
Unit Tests: ToolCallTracker and ToolCallContext (core/integrations/framework/tool_tracker.py)

Covers ToolCallInfo, ToolCallTracker (thread-local stack), and ToolCallContext.

Mock boundaries: None (pure logic, thread-local storage)
"""

from __future__ import annotations

import threading
import time

import pytest

from core.integrations.framework.tool_tracker import (
    ToolCallInfo,
    ToolCallTracker,
    ToolCallContext,
)


@pytest.fixture(autouse=True)
def _clean_tracker():
    """Ensure tracker state is clean before and after each test."""
    ToolCallTracker.clear()
    yield
    ToolCallTracker.clear()


# ─── ToolCallInfo ─────────────────────────────────────────────────────────────


class TestToolCallInfo:
    def test_defaults(self):
        info = ToolCallInfo(tool_path="computer.browser.search", tool_name="search")
        assert info.tool_path == "computer.browser.search"
        assert info.tool_name == "search"
        assert info.args == ()
        assert info.kwargs == {}
        assert isinstance(info.start_time, float)

    def test_custom_args(self):
        info = ToolCallInfo(
            tool_path="computer.func",
            tool_name="func",
            args=(1, "two"),
            kwargs={"key": "val"},
        )
        assert info.args == (1, "two")
        assert info.kwargs == {"key": "val"}

    def test_to_dict(self):
        info = ToolCallInfo(
            tool_path="computer.test",
            tool_name="test",
            args=(42,),
            kwargs={"x": True},
        )
        d = info.to_dict()
        assert d["tool_path"] == "computer.test"
        assert d["tool_name"] == "test"
        assert d["args"] == (42,)
        assert d["kwargs"] == {"x": True}
        assert "start_time" in d
        assert "duration" in d
        assert d["duration"] >= 0


# ─── ToolCallTracker ──────────────────────────────────────────────────────────


class TestToolCallTracker:
    def test_enter_and_exit(self):
        ToolCallTracker.enter_tool_call("computer.search", "search")
        active = ToolCallTracker.get_active_tool()
        assert active is not None
        assert active.tool_name == "search"

        popped = ToolCallTracker.exit_tool_call()
        assert popped.tool_name == "search"
        assert ToolCallTracker.get_active_tool() is None

    def test_exit_empty_stack_returns_none(self):
        assert ToolCallTracker.exit_tool_call() is None

    def test_exit_no_stack_attr_returns_none(self):
        if hasattr(ToolCallTracker._context, "tool_stack"):
            del ToolCallTracker._context.tool_stack
        assert ToolCallTracker.exit_tool_call() is None

    def test_get_active_tool_no_stack(self):
        if hasattr(ToolCallTracker._context, "tool_stack"):
            del ToolCallTracker._context.tool_stack
        assert ToolCallTracker.get_active_tool() is None

    def test_get_active_tool_empty_stack(self):
        assert ToolCallTracker.get_active_tool() is None

    def test_nested_calls(self):
        ToolCallTracker.enter_tool_call("computer.a", "a")
        ToolCallTracker.enter_tool_call("computer.b", "b")

        assert ToolCallTracker.get_active_tool().tool_name == "b"
        assert ToolCallTracker.get_depth() == 2

        ToolCallTracker.exit_tool_call()
        assert ToolCallTracker.get_active_tool().tool_name == "a"
        assert ToolCallTracker.get_depth() == 1

        ToolCallTracker.exit_tool_call()
        assert ToolCallTracker.get_active_tool() is None
        assert ToolCallTracker.get_depth() == 0

    def test_get_tool_stack(self):
        ToolCallTracker.enter_tool_call("computer.a", "a")
        ToolCallTracker.enter_tool_call("computer.b", "b")

        stack = ToolCallTracker.get_tool_stack()
        assert len(stack) == 2
        assert stack[0].tool_name == "a"
        assert stack[1].tool_name == "b"

    def test_get_tool_stack_no_attr(self):
        if hasattr(ToolCallTracker._context, "tool_stack"):
            del ToolCallTracker._context.tool_stack
        assert ToolCallTracker.get_tool_stack() == []

    def test_is_inside_tool_call(self):
        assert ToolCallTracker.is_inside_tool_call() is False
        ToolCallTracker.enter_tool_call("computer.x", "x")
        assert ToolCallTracker.is_inside_tool_call() is True
        ToolCallTracker.exit_tool_call()
        assert ToolCallTracker.is_inside_tool_call() is False

    def test_get_depth(self):
        assert ToolCallTracker.get_depth() == 0
        ToolCallTracker.enter_tool_call("computer.a", "a")
        assert ToolCallTracker.get_depth() == 1
        ToolCallTracker.enter_tool_call("computer.b", "b")
        assert ToolCallTracker.get_depth() == 2

    def test_get_depth_no_attr(self):
        if hasattr(ToolCallTracker._context, "tool_stack"):
            del ToolCallTracker._context.tool_stack
        assert ToolCallTracker.get_depth() == 0

    def test_clear(self):
        ToolCallTracker.enter_tool_call("computer.a", "a")
        ToolCallTracker.enter_tool_call("computer.b", "b")
        assert ToolCallTracker.get_depth() == 2
        ToolCallTracker.clear()
        assert ToolCallTracker.get_depth() == 0

    def test_clear_no_attr(self):
        if hasattr(ToolCallTracker._context, "tool_stack"):
            del ToolCallTracker._context.tool_stack
        ToolCallTracker.clear()  # Must not raise

    def test_kwargs_default_none(self):
        ToolCallTracker.enter_tool_call("computer.x", "x", args=(1,), kwargs=None)
        active = ToolCallTracker.get_active_tool()
        assert active.kwargs == {}

    def test_thread_isolation(self):
        """Thread-local storage must isolate state between threads."""
        results = {}

        def thread_work(name):
            ToolCallTracker.enter_tool_call(f"computer.{name}", name)
            time.sleep(0.01)
            active = ToolCallTracker.get_active_tool()
            results[name] = active.tool_name if active else None
            ToolCallTracker.exit_tool_call()

        t1 = threading.Thread(target=thread_work, args=("alpha",))
        t2 = threading.Thread(target=thread_work, args=("beta",))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        assert results["alpha"] == "alpha"
        assert results["beta"] == "beta"


# ─── ToolCallContext ──────────────────────────────────────────────────────────


class TestToolCallContext:
    def test_context_manager_enters_and_exits(self):
        with ToolCallContext("computer.search", "search"):
            assert ToolCallTracker.is_inside_tool_call() is True
            assert ToolCallTracker.get_active_tool().tool_name == "search"
        assert ToolCallTracker.is_inside_tool_call() is False

    def test_context_manager_with_args(self):
        with ToolCallContext("computer.func", "func", args=(1,), kwargs={"k": "v"}):
            active = ToolCallTracker.get_active_tool()
            assert active.args == (1,)
            assert active.kwargs == {"k": "v"}

    def test_context_manager_kwargs_default(self):
        ctx = ToolCallContext("computer.x", "x")
        assert ctx.kwargs == {}

    def test_context_manager_cleans_on_exception(self):
        with pytest.raises(ValueError, match="boom"):
            with ToolCallContext("computer.bad", "bad"):
                raise ValueError("boom")
        assert ToolCallTracker.is_inside_tool_call() is False

    def test_enter_returns_self(self):
        ctx = ToolCallContext("computer.x", "x")
        result = ctx.__enter__()
        assert result is ctx
        ctx.__exit__(None, None, None)

    def test_exit_returns_false(self):
        ctx = ToolCallContext("computer.x", "x")
        ctx.__enter__()
        assert ctx.__exit__(None, None, None) is False


# ─── Adversarial ──────────────────────────────────────────────────────────────


class TestAdversarial:
    def test_exit_more_than_enter(self):
        """Exiting more times than entering must not crash."""
        ToolCallTracker.enter_tool_call("computer.x", "x")
        ToolCallTracker.exit_tool_call()
        result = ToolCallTracker.exit_tool_call()
        assert result is None

    def test_get_tool_stack_returns_copy(self):
        """Mutating returned stack must not affect internal state."""
        ToolCallTracker.enter_tool_call("computer.x", "x")
        stack = ToolCallTracker.get_tool_stack()
        stack.clear()
        assert ToolCallTracker.get_depth() == 1  # Internal state preserved

    def test_enter_initializes_stack_on_first_call(self):
        """First enter_tool_call on fresh thread-local must create stack."""
        if hasattr(ToolCallTracker._context, "tool_stack"):
            del ToolCallTracker._context.tool_stack
        ToolCallTracker.enter_tool_call("computer.x", "x")
        assert ToolCallTracker.get_depth() == 1
