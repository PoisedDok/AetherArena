# @.architecture
# Incoming: integrations framework tool wrappers --- {python, ToolCallContext}
# Processing: Track tool execution context in thread-local stack --- {2 jobs: JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
# Outgoing: Active tool call metadata for downstream formatters/kernels --- {Dict[str, Any], dict}

"""
Tool Call Tracker - Thread-local context for detecting active tool executions

This module provides a simple context manager to track when tools are being executed
in the jupyter kernel. This allows us to distinguish tool outputs from regular code
outputs and format them appropriately.

Architecture:
- Thread-local storage ensures isolation across concurrent executions
- Stack-based tracking supports nested tool calls
- Minimal overhead for non-tool code execution

Usage:
    # In tool wrapper
    ToolCallTracker.enter_tool_call("computer.browser.search", {"query": "AI"})
    try:
        result = actual_tool_function()
    finally:
        ToolCallTracker.exit_tool_call()
    
    # In jupyter kernel
    active_tool = ToolCallTracker.get_active_tool()
    if active_tool:
        # Format output as markdown
        ...
"""

import threading
import time
from typing import Dict, List, Optional
from dataclasses import dataclass, field


@dataclass
class ToolCallInfo:
    """Information about an active tool call"""
    tool_path: str  # e.g., "computer.browser.search"
    tool_name: str  # e.g., "search"
    args: tuple = field(default_factory=tuple)
    kwargs: dict = field(default_factory=dict)
    start_time: float = field(default_factory=time.time)
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for serialization"""
        return {
            "tool_path": self.tool_path,
            "tool_name": self.tool_name,
            "args": self.args,
            "kwargs": self.kwargs,
            "start_time": self.start_time,
            "duration": time.time() - self.start_time
        }


class ToolCallTracker:
    """
    Thread-local tracker for active tool executions.
    
    Maintains a stack of active tool calls to support nested tool invocations.
    The jupyter kernel can query this to determine if current output is from a tool.
    """
    
    _context = threading.local()
    
    @classmethod
    def enter_tool_call(
        cls, 
        tool_path: str, 
        tool_name: str,
        args: tuple = (),
        kwargs: dict = None
    ) -> None:
        """
        Mark the start of a tool execution.
        
        Args:
            tool_path: Full path to tool (e.g., "computer.browser.search")
            tool_name: Tool function name (e.g., "search")
            args: Positional arguments passed to tool
            kwargs: Keyword arguments passed to tool
        """
        if not hasattr(cls._context, 'tool_stack'):
            cls._context.tool_stack = []
        
        tool_info = ToolCallInfo(
            tool_path=tool_path,
            tool_name=tool_name,
            args=args,
            kwargs=kwargs or {}
        )
        
        cls._context.tool_stack.append(tool_info)
    
    @classmethod
    def exit_tool_call(cls) -> Optional[ToolCallInfo]:
        """
        Mark the end of a tool execution.
        
        Returns:
            The tool info that was popped, or None if stack was empty
        """
        if not hasattr(cls._context, 'tool_stack'):
            return None
        
        if not cls._context.tool_stack:
            return None
        
        return cls._context.tool_stack.pop()
    
    @classmethod
    def get_active_tool(cls) -> Optional[ToolCallInfo]:
        """
        Get information about the currently executing tool.
        
        Returns the top of the stack (most recent tool call).
        Returns None if no tool is currently executing.
        
        Returns:
            ToolCallInfo if inside a tool call, None otherwise
        """
        if not hasattr(cls._context, 'tool_stack'):
            return None
        
        if not cls._context.tool_stack:
            return None
        
        return cls._context.tool_stack[-1]
    
    @classmethod
    def get_tool_stack(cls) -> List[ToolCallInfo]:
        """
        Get the full stack of active tool calls.
        
        Useful for debugging nested tool calls.
        
        Returns:
            List of ToolCallInfo objects, empty list if no tools active
        """
        if not hasattr(cls._context, 'tool_stack'):
            return []
        
        return list(cls._context.tool_stack)
    
    @classmethod
    def is_inside_tool_call(cls) -> bool:
        """
        Quick check if we're currently inside any tool execution.
        
        Returns:
            True if at least one tool is active
        """
        return cls.get_active_tool() is not None
    
    @classmethod
    def get_depth(cls) -> int:
        """
        Get the nesting depth of tool calls.
        
        Returns:
            0 if no tools active, >0 for nested calls
        """
        if not hasattr(cls._context, 'tool_stack'):
            return 0
        
        return len(cls._context.tool_stack)
    
    @classmethod
    def clear(cls) -> None:
        """
        Clear all active tool calls.
        
        Useful for cleanup in error scenarios.
        Should rarely be needed due to try/finally in wrappers.
        """
        if hasattr(cls._context, 'tool_stack'):
            cls._context.tool_stack.clear()


class ToolCallContext:
    """
    Context manager for tracking tool calls.
    
    Provides a clean way to wrap tool execution with automatic cleanup.
    
    Usage:
        with ToolCallContext("computer.browser.search", "search", args, kwargs):
            result = actual_function(*args, **kwargs)
    """
    
    def __init__(self, tool_path: str, tool_name: str, args: tuple = (), kwargs: dict = None):
        self.tool_path = tool_path
        self.tool_name = tool_name
        self.args = args
        self.kwargs = kwargs or {}
    
    def __enter__(self):
        ToolCallTracker.enter_tool_call(
            self.tool_path, 
            self.tool_name,
            self.args,
            self.kwargs
        )
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        ToolCallTracker.exit_tool_call()
        # Don't suppress exceptions
        return False

