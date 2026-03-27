# @.architecture
# Incoming: tool execution outputs + tool registry metadata --- {Any, Dict[str, Any]}
# Processing: Load tool metadata + format tool results as markdown --- {3 jobs: JOB_READ_CONFIG, JOB_TRANSFORM_DATA, JOB_RENDER_MARKDOWN}
# Outgoing: Markdown string for renderer display --- {str, markdown}

"""
Markdown Formatter - Convert tool outputs to markdown format

This module provides intelligent formatting of tool execution results into
markdown format for better presentation in the frontend.

Features:
- Type-aware formatting (dict, list, string, etc.)
- Tool metadata integration
- Truncation for large outputs
- Error formatting
- Customizable templates per tool type

Architecture:
- Load tool metadata from backend_tools_registry.yaml
- Apply type-specific formatting rules
- Generate rich markdown with headers, tables, code blocks
- Handle edge cases (None, empty, errors)
"""

import json
import yaml
from pathlib import Path
from typing import Any, Dict, List, Optional
import logging

logger = logging.getLogger(__name__)

# Cache for tool metadata
_tool_metadata_cache: Optional[Dict[str, Any]] = None


def load_tool_metadata() -> Dict[str, Any]:
    """
    Load tool metadata from backend_tools_registry.yaml.
    
    Cached after first load for performance.
    
    Returns:
        Dictionary mapping tool paths to metadata
    """
    global _tool_metadata_cache
    
    if _tool_metadata_cache is not None:
        return _tool_metadata_cache
    
    try:
        # Find backend_tools_registry.yaml
        current_file = Path(__file__).resolve()
        # We're in core/integrations/framework/, need to go up 4 levels to aether-backend/
        backend_root = current_file.parent.parent.parent.parent
        yaml_path = backend_root / "config" / "backend_tools_registry.yaml"
        
        if not yaml_path.exists():
            logger.warning("Tool registry not found: %s", yaml_path)
            _tool_metadata_cache = {}
            return _tool_metadata_cache
        
        with open(yaml_path, 'r') as f:
            data = yaml.safe_load(f)
        
        # Build path -> metadata mapping
        metadata_map = {}
        for cat_name, cat_data in data.get('categories', {}).items():
            for tool in cat_data.get('tools', []):
                tool_path = tool.get('path', '')
                metadata_map[tool_path] = {
                    'name': tool.get('name', ''),
                    'description': tool.get('description', ''),
                    'category': cat_name,
                    'http_method': tool.get('http_method', ''),
                    'api_endpoint': tool.get('api_endpoint', '')
                }
        
        _tool_metadata_cache = metadata_map
        logger.info("Loaded metadata for %d tools", len(metadata_map))
        return _tool_metadata_cache
        
    except Exception as e:
        logger.error("Failed to load tool metadata: %s", e)
        _tool_metadata_cache = {}
        return _tool_metadata_cache


def get_tool_metadata(tool_path: str) -> Dict[str, Any]:
    """
    Get metadata for a specific tool.
    
    Args:
        tool_path: Full tool path (e.g., "computer.browser.search")
    
    Returns:
        Tool metadata dict, or empty dict if not found
    """
    metadata = load_tool_metadata()
    return metadata.get(tool_path, {})


def format_tool_result(
    result: Any, 
    tool_path: str, 
    tool_name: str,
    args: tuple = (),
    kwargs: dict = None,
    execution_time: float = None
) -> str:
    """
    Convert tool execution result to markdown format.
    
    Args:
        result: The return value from the tool
        tool_path: Full path (e.g., "computer.browser.search")
        tool_name: Display name (e.g., "search")
        args: Positional arguments passed to tool
        kwargs: Keyword arguments passed to tool
        execution_time: Tool execution duration in seconds
    
    Returns:
        Markdown-formatted string
    """
    kwargs = kwargs or {}
    
    # Get tool metadata
    metadata = get_tool_metadata(tool_path)
    display_name = metadata.get('name', tool_name)
    description = metadata.get('description', '')
    category = metadata.get('category', 'unknown')
    
    # Build markdown
    md_parts = []
    
    # Header
    emoji_map = {
        'chat_management': '💬',
        'profiles_skills': '👤',
        'excel_automation': '📊',
        'document_processing': '📄',
        'context_memory': '🧠',
        'datastore_search': '🔍',
        'trails_hierarchy': '🌲',
        'artifacts_traceability': '📦',
        'text_to_speech': '🔊',
        'mcp_servers': '🔌',
        'notebook_python': '🐍',
        'system_health': '💚',
    }
    emoji = emoji_map.get(category, '🔧')
    
    md_parts.append(f"## {emoji} {display_name}\n")
    
    # Description (if available and not too long)
    if description and len(description) < 200:
        md_parts.append(f"*{description}*\n")
    
    # Arguments summary (if any)
    if args or kwargs:
        md_parts.append("**Parameters:**\n")
        if args:
            for i, arg in enumerate(args):
                arg_str = _truncate(str(arg), 100)
                md_parts.append(f"- arg{i}: `{arg_str}`\n")
        if kwargs:
            for key, value in kwargs.items():
                value_str = _truncate(str(value), 100)
                md_parts.append(f"- {key}: `{value_str}`\n")
        md_parts.append("\n")
    
    # Result formatting (type-aware)
    md_parts.append("**Result:**\n\n")
    result_md = _format_result_by_type(result, tool_path, metadata)
    md_parts.append(result_md)
    
    # Execution time footer
    if execution_time is not None:
        md_parts.append(f"\n\n---\n*Executed in {execution_time:.3f}s*")
    
    return "".join(md_parts)


def _format_result_by_type(result: Any, tool_path: str, metadata: Dict) -> str:
    """
    Format result based on its type.
    
    Args:
        result: Tool result
        tool_path: Tool path for context
        metadata: Tool metadata
    
    Returns:
        Markdown string
    """
    # Handle None
    if result is None:
        return "*No result returned*\n"
    
    # Handle errors/exceptions (if tool wrapper catches them)
    if isinstance(result, Exception):
        return _format_error(result)
    
    # Handle dict
    if isinstance(result, dict):
        return _format_dict(result, tool_path)
    
    # Handle list
    if isinstance(result, list):
        return _format_list(result, tool_path)
    
    # Handle string
    if isinstance(result, str):
        return _format_string(result, tool_path)
    
    # Handle bool
    if isinstance(result, bool):
        icon = "✅" if result else "❌"
        return f"{icon} `{result}`\n"
    
    # Handle numbers
    if isinstance(result, (int, float)):
        return f"`{result}`\n"
    
    # Fallback: stringify
    return _format_string(str(result), tool_path)


def _format_dict(data: Dict, tool_path: str) -> str:
    """Format dictionary as markdown"""
    if not data:
        return "*Empty result*\n"
    
    # Check for special structures
    
    # Pattern 1: Search results with 'results' key
    if 'results' in data and isinstance(data['results'], list):
        return _format_search_results(data)
    
    # Pattern 2: Single record with 'id' and other fields
    if 'id' in data and len(data) < 20:
        return _format_record(data)
    
    # Pattern 3: Status response with 'status' key
    if 'status' in data:
        return _format_status(data)
    
    # Pattern 4: Error response with 'error' key
    if 'error' in data:
        return _format_error_dict(data)
    
    # Default: Format as table or key-value pairs
    return _format_generic_dict(data)


def _format_search_results(data: Dict) -> str:
    """Format search results with numbered items"""
    results = data.get('results', [])
    
    if not results:
        return "*No results found*\n"
    
    md = []
    
    # Metadata
    if 'total' in data:
        md.append(f"*Found {data['total']} results*\n\n")
    
    # Results
    for idx, item in enumerate(results[:10], 1):  # Limit to 10
        md.append(f"### {idx}. {item.get('title', 'Result')}\n\n")
        
        for key, value in item.items():
            if key == 'title':
                continue
            value_str = _truncate(str(value), 200)
            md.append(f"**{key}:** {value_str}\n\n")
    
    if len(results) > 10:
        md.append(f"\n*... and {len(results) - 10} more results*\n")
    
    return "".join(md)


def _format_record(data: Dict) -> str:
    """Format single record as key-value pairs"""
    md = []
    
    for key, value in data.items():
        # Skip internal/metadata fields
        if key.startswith('_'):
            continue
        
        # Format value
        if isinstance(value, (dict, list)):
            value_str = f"\n```json\n{_safe_json_dumps(value, indent=2)}\n```"
        else:
            value_str = _truncate(str(value), 300)
        
        md.append(f"**{key}:** {value_str}\n\n")
    
    return "".join(md)


def _format_status(data: Dict) -> str:
    """Format status response"""
    status = data.get('status', 'unknown')
    icon = "✅" if status in ['success', 'ok', 'healthy'] else "⚠️"
    
    md = [f"{icon} **Status:** {status}\n\n"]
    
    for key, value in data.items():
        if key == 'status':
            continue
        md.append(f"**{key}:** {value}\n\n")
    
    return "".join(md)


def _format_error_dict(data: Dict) -> str:
    """Format error response"""
    error = data.get('error', 'Unknown error')
    md = [f"❌ **Error:** {error}\n\n"]
    
    if 'details' in data:
        md.append(f"```\n{data['details']}\n```\n")
    
    return "".join(md)


def _format_generic_dict(data: Dict) -> str:
    """Format dictionary as markdown table"""
    if len(data) <= 5:
        # Small dict: key-value pairs
        md = []
        for key, value in data.items():
            value_str = _truncate(str(value), 200)
            md.append(f"- **{key}:** {value_str}\n")
        return "".join(md)
    else:
        # Large dict: JSON code block
        json_str = _safe_json_dumps(data, indent=2)
        if len(json_str) > 2000:
            json_str = json_str[:2000] + "\n... (truncated)"
        return f"```json\n{json_str}\n```\n"


def _format_list(data: List, tool_path: str) -> str:
    """Format list as markdown"""
    if not data:
        return "*Empty list*\n"
    
    # Check if list of dicts (e.g., query results)
    if all(isinstance(item, dict) for item in data):
        md = []
        for idx, item in enumerate(data[:10], 1):
            md.append(f"### Item {idx}\n\n")
            md.append(_format_dict(item, tool_path))
            md.append("\n")
        
        if len(data) > 10:
            md.append(f"*... and {len(data) - 10} more items*\n")
        
        return "".join(md)
    
    # List of strings/numbers: bullet points
    if all(isinstance(item, (str, int, float, bool)) for item in data):
        md = []
        for item in data[:20]:
            md.append(f"- {item}\n")
        
        if len(data) > 20:
            md.append(f"- ... and {len(data) - 20} more items\n")
        
        return "".join(md)
    
    # Mixed types: JSON
    json_str = _safe_json_dumps(data, indent=2)
    if len(json_str) > 2000:
        json_str = json_str[:2000] + "\n... (truncated)"
    return f"```json\n{json_str}\n```\n"


def _format_string(text: str, tool_path: str) -> str:
    """Format string result"""
    if not text:
        return "*Empty string*\n"
    
    # Check if it's JSON
    if text.strip().startswith(('{', '[')):
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                return _format_dict(obj, tool_path)
            elif isinstance(obj, list):
                return _format_list(obj, tool_path)
        except json.JSONDecodeError:
            pass
    
    # Check if it's HTML
    if '<html' in text.lower() or '<!doctype' in text.lower():
        return f"```html\n{_truncate(text, 1000)}\n```\n"
    
    # Check if it's code (has indentation or brackets)
    if '\n    ' in text or text.count('{') > 2:
        return f"```\n{_truncate(text, 1000)}\n```\n"
    
    # Plain text
    if len(text) > 500:
        return f"{text[:500]}...\n\n*({len(text)} characters total)*\n"
    
    return f"{text}\n"


def _format_error(error: Exception) -> str:
    """Format exception/error"""
    return f"❌ **Error:** {type(error).__name__}\n\n```\n{str(error)}\n```\n"


def _truncate(text: str, max_length: int) -> str:
    """Truncate text with ellipsis"""
    if len(text) <= max_length:
        return text
    return text[:max_length] + "..."


def _safe_json_dumps(obj: Any, **kwargs) -> str:
    """json.dumps with a fallback serializer for non-JSON-native types.

    Prevents TypeError crashes when tool output contains datetime, bytes,
    sets, custom objects, or any other non-serializable value.
    """
    def _default(o: Any) -> Any:
        # Handle common non-serializable types gracefully
        if isinstance(o, bytes):
            return o.decode("utf-8", errors="replace")
        if isinstance(o, set):
            return sorted(o, key=str)
        if hasattr(o, "isoformat"):        # datetime / date / time
            return o.isoformat()
        if hasattr(o, "__dict__"):
            return str(o)
        return repr(o)

    return json.dumps(obj, default=_default, **kwargs)


# Formatting presets for specific tool categories
CATEGORY_FORMATTERS = {
    'datastore_search': lambda result, tool_path, metadata: _format_search_results(result) if isinstance(result, dict) else _format_result_by_type(result, tool_path, metadata),
    'document_processing': lambda result, tool_path, metadata: _format_string(result, tool_path) if isinstance(result, str) else _format_result_by_type(result, tool_path, metadata),
}


def format_with_preset(result: Any, tool_path: str, metadata: Dict) -> str:
    """
    Apply category-specific formatting preset if available.
    
    Args:
        result: Tool result
        tool_path: Tool path
        metadata: Tool metadata with 'category' key
    
    Returns:
        Markdown string
    """
    category = metadata.get('category')
    
    if category in CATEGORY_FORMATTERS:
        return CATEGORY_FORMATTERS[category](result, tool_path, metadata)
    
    return _format_result_by_type(result, tool_path, metadata)

