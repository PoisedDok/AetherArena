# @.architecture
# Incoming: integration loader tool objects/functions --- {Callable, Any}
# Processing: Wrap tools with tracking proxies for safe execution context --- {3 jobs: JOB_CREATE_WRAPPER, JOB_UPDATE_STATE, JOB_DELEGATE_TO_MODULE}
# Outgoing: Wrapped tool callables/namespaces with metadata preservation --- {Any, python}

"""
Tool Wrapper - Proxy wrappers for tracking and formatting tool calls

This module provides proxy classes that wrap tool functions and methods to:
1. Track tool execution context (via ToolCallTracker)
2. Capture and format tool outputs as markdown
3. Preserve original function signatures and docstrings

Architecture:
- ToolProxy: Wraps individual callable functions
- NamespaceProxy: Wraps objects with multiple methods (e.g., computer.browser)
- Transparent proxying preserves isinstance checks and introspection
- Thread-safe via thread-local context in ToolCallTracker

Usage:
    # Wrap a function
    wrapped_func = ToolProxy(original_func, "computer.profiles_list", {})
    result = wrapped_func()  # Tracked and formatted
    
    # Wrap a namespace
    wrapped_browser = NamespaceProxy(browser_obj, "computer.browser")
    result = wrapped_browser.search("AI")  # Tracked
"""

import functools
import inspect
import time
from typing import Any, Callable, Dict, Optional
import logging

from .tool_tracker import ToolCallTracker
from .markdown_formatter import get_tool_metadata

logger = logging.getLogger(__name__)


class ToolProxy:
    """
    Transparent proxy wrapper for tool functions.
    
    Wraps a callable to track execution context without modifying behavior.
    The actual output formatting happens in jupyter_language.py based on
    the ToolCallTracker state.
    
    Features:
    - Preserves function signature, name, docstring
    - Thread-safe execution tracking
    - Automatic context cleanup (try/finally)
    - Minimal overhead for non-tool code
    """
    
    def __init__(
        self, 
        func: Callable, 
        tool_path: str, 
        metadata: Optional[Dict[str, Any]] = None
    ):
        """
        Initialize tool proxy.
        
        Args:
            func: The actual tool function to wrap
            tool_path: Full path (e.g., "computer.browser.search")
            metadata: Optional tool metadata from registry
        """
        self._func = func
        self._tool_path = tool_path
        self._metadata = metadata or {}
        
        # Preserve function attributes for introspection
        functools.update_wrapper(self, func, updated=[])
        self.__name__ = getattr(func, '__name__', tool_path.split('.')[-1])
        self.__doc__ = getattr(func, '__doc__', None)
        self.__wrapped__ = func  # Standard attribute for wrapped functions
        
        # Store signature for inspection
        try:
            self.__signature__ = inspect.signature(func)
        except (ValueError, TypeError):
            pass
    
    def __call__(self, *args, **kwargs):
        """
        Execute the wrapped tool with tracking.
        
        The tracking context allows jupyter_language.py to detect that
        we're inside a tool call and format outputs appropriately.
        """
        tool_name = self.__name__
        start_time = time.time()
        
        # Enter tracking context
        ToolCallTracker.enter_tool_call(
            self._tool_path, 
            tool_name,
            args=args,
            kwargs=kwargs
        )
        
        try:
            # Execute the actual tool
            result = self._func(*args, **kwargs)
            
            # Log successful execution
            execution_time = time.time() - start_time
            logger.debug("Tool executed: %s in %.3fs", self._tool_path, execution_time)
            
            return result
            
        except Exception as e:
            # Log error but re-raise
            execution_time = time.time() - start_time
            logger.error("Tool error: %s after %.3fs: %s", self._tool_path, execution_time, e)
            raise
            
        finally:
            # Always exit context, even if exception occurs
            ToolCallTracker.exit_tool_call()
    
    def __repr__(self):
        """String representation for debugging"""
        return f"<ToolProxy({self._tool_path})>"
    
    def __getattr__(self, name):
        """
        Proxy attribute access to wrapped function.
        
        This allows accessing attributes of the original function that
        weren't explicitly copied during initialization.
        """
        return getattr(self._func, name)


class NamespaceProxy:
    """
    Transparent proxy wrapper for tool namespace objects.
    
    Wraps objects like computer.browser, computer.files that have multiple
    methods. Each method access returns a ToolProxy for that specific method.
    
    Features:
    - Dynamic method wrapping on access
    - Preserves non-callable attributes
    - Supports nested namespaces
    - Transparent to user code
    
    Example:
        browser = NamespaceProxy(original_browser, "computer.browser")
        browser.search("AI")  # Wraps and tracks browser.search()
    """
    
    def __init__(
        self, 
        obj: Any, 
        namespace_path: str,
        metadata: Optional[Dict[str, Any]] = None
    ):
        """
        Initialize namespace proxy.
        
        Args:
            obj: The actual namespace object (e.g., Browser instance)
            namespace_path: Full path (e.g., "computer.browser")
            metadata: Optional metadata for the namespace
        """
        # Store in __dict__ to avoid infinite recursion in __getattr__
        object.__setattr__(self, '_obj', obj)
        object.__setattr__(self, '_namespace_path', namespace_path)
        object.__setattr__(self, '_metadata', metadata or {})
        object.__setattr__(self, '_method_cache', {})  # Cache wrapped methods
    
    def __getattr__(self, name):
        """
        Intercept attribute/method access.
        
        If the attribute is callable, wrap it with ToolProxy.
        Otherwise, return the attribute directly.
        """
        # Avoid wrapping private/magic methods
        if name.startswith('_'):
            return getattr(self._obj, name)
        
        # Get the attribute from wrapped object
        attr = getattr(self._obj, name)
        
        # If not callable, return as-is
        if not callable(attr):
            return attr
        
        # Check cache first
        if name in self._method_cache:
            return self._method_cache[name]
        
        # Wrap method with ToolProxy
        tool_path = f"{self._namespace_path}.{name}"
        metadata = get_tool_metadata(tool_path)
        
        wrapped_method = ToolProxy(attr, tool_path, metadata)
        
        # Cache for future calls
        self._method_cache[name] = wrapped_method
        
        return wrapped_method
    
    def __setattr__(self, name, value):
        """Forward attribute setting to wrapped object"""
        if name.startswith('_'):
            object.__setattr__(self, name, value)
        else:
            setattr(self._obj, name, value)
    
    def __repr__(self):
        """String representation for debugging"""
        return f"<NamespaceProxy({self._namespace_path})>"
    
    def __dir__(self):
        """List available attributes (for autocomplete)"""
        return dir(self._obj)


def wrap_tool(
    tool: Any, 
    tool_path: str, 
    metadata: Optional[Dict[str, Any]] = None
) -> Any:
    """
    Smart wrapper that chooses appropriate proxy type.
    
    Args:
        tool: The tool to wrap (function or object)
        tool_path: Full path (e.g., "computer.browser" or "computer.profiles_list")
        metadata: Optional tool metadata
    
    Returns:
        Wrapped tool (ToolProxy or NamespaceProxy)
    """
    # If it's a callable function, wrap with ToolProxy
    if callable(tool) and not inspect.isclass(tool):
        return ToolProxy(tool, tool_path, metadata)
    
    # If it's an object with methods/attributes, wrap with NamespaceProxy.
    # Classes, instances, SimpleNamespace — all have __dict__.
    if hasattr(tool, '__dict__'):
        return NamespaceProxy(tool, tool_path, metadata)
    
    # Fallback: primitives (int, str, None) or __slots__-only objects
    # that have no __dict__. Return unwrapped.
    logger.warning("Unknown tool type for %s: %s", tool_path, type(tool))
    return tool


def wrap_all_tools(computer: Any, tool_paths: Optional[list] = None) -> int:
    """
    Wrap all tools attached to a computer object.
    
    This is a utility function for bulk wrapping, typically called
    after all integrations are loaded.
    
    Args:
        computer: The computer instance
        tool_paths: Optional list of specific paths to wrap
                    If None, wraps all non-private attributes
    
    Returns:
        Number of tools wrapped
    """
    wrapped_count = 0
    
    # Get list of attributes to wrap
    if tool_paths:
        attrs_to_wrap = [(path.split('.')[-1], path) for path in tool_paths]
    else:
        # Wrap all non-private callable attributes
        attrs_to_wrap = [
            (attr_name, f"computer.{attr_name}") 
            for attr_name in dir(computer)
            if not attr_name.startswith('_')
        ]
    
    for attr_name, tool_path in attrs_to_wrap:
        try:
            # Skip if doesn't exist
            if not hasattr(computer, attr_name):
                continue
            
            tool = getattr(computer, attr_name)
            
            # Skip if already wrapped
            if isinstance(tool, (ToolProxy, NamespaceProxy)):
                continue
            
            # Skip non-callable non-objects
            if not callable(tool) and not hasattr(tool, '__dict__'):
                continue
            
            # Wrap and replace
            metadata = get_tool_metadata(tool_path)
            wrapped = wrap_tool(tool, tool_path, metadata)
            
            if wrapped is not tool:  # Only count if actually wrapped
                setattr(computer, attr_name, wrapped)
                wrapped_count += 1
                logger.debug("Wrapped tool: %s", tool_path)
        
        except Exception as e:
            logger.error("Failed to wrap %s: %s", tool_path, e)
    
    logger.info("Wrapped %d tools on computer object", wrapped_count)
    return wrapped_count


# Convenience decorators for manual wrapping

def tracked_tool(tool_path: str, metadata: Optional[Dict] = None):
    """
    Decorator to manually wrap a function as a tracked tool.
    
    Usage:
        @tracked_tool("computer.custom_tool")
        def my_tool():
            return "result"
    """
    def decorator(func):
        return ToolProxy(func, tool_path, metadata)
    return decorator


def tracked_namespace(namespace_path: str, metadata: Optional[Dict] = None):
    """
    Decorator to manually wrap a class as a tracked namespace.
    
    Returns a factory function that instantiates the class and wraps the
    instance in a NamespaceProxy.  The factory preserves the original class
    name and docstring so introspection still works.
    
    Usage:
        @tracked_namespace("computer.custom")
        class CustomTools:
            def method1(self):
                return "result"
        
        tools = CustomTools()  # Returns NamespaceProxy wrapping CustomTools instance
    """
    def decorator(cls):
        @functools.wraps(cls, updated=[])
        def factory(*args, **kwargs):
            instance = cls(*args, **kwargs)
            return NamespaceProxy(instance, namespace_path, metadata)
        
        # Preserve the original class for isinstance checks if needed
        factory._wrapped_class = cls
        return factory
    
    return decorator

