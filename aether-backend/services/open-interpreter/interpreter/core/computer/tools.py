"""
Tools - Clean Public API for Tool Discovery

Thin facade over unified ToolEngine.
No business logic, pure delegation.

Architecture:
- Single ToolEngine handles discovery, indexing, search, formatting
- Provides clean public API for agents
- Backward-compatible legacy API
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
import inspect

from .tool_engine import ToolEngine
from .tool_metadata import CLASS_TO_CATEGORY


@dataclass
class ToolDescriptor:
    """Legacy tool descriptor for backward compatibility"""
    category: str
    path: str
    signature: str
    description: str


class Tools:
    """
    Clean, unified tool discovery and search API.
    
    Primary Interface:
        search(query)           - Semantic search for tools by functionality
        list_categories()       - Show available tool categories
        list_tools(category)    - List tools in a category
        get_info(tool_path)     - Detailed tool information
        recommend(task)         - Get tool recommendations for a task
    
    Legacy Interface (backward compatible):
        categories()            - List category names
        list(category)          - List tools as ToolDescriptor objects
        info(tool_path)         - Get tool info as dict
    """
    
    def __init__(self, computer: Any, use_whitelist: bool = False):
        """
        Initialize tools API.
        
        Args:
            computer: Computer instance with tool modules
            use_whitelist: Enable whitelist filtering (default: False)
        """
        self._computer = computer
        self._class_to_category = CLASS_TO_CATEGORY
        
        # Unified engine handles everything
        self._engine = ToolEngine(computer, use_whitelist=use_whitelist, output_format="html")
    
    # ========================================================================
    # PRIMARY API - Clean, Modern Interface
    # ========================================================================
    
    def search(self, query: str, categories: Optional[List[str]] = None) -> str:
        """
        Semantic search for tools by functionality using AI embeddings.
        
        Args:
            query: What you want to accomplish
            categories: Optional list of categories to search within
        
        Returns:
            Formatted search results
        """
        # Special routing for screenshot queries
        if self._is_screenshot_query(query):
            return self._get_screenshot_tools_info()
        
        # Perform search via unified engine
        try:
            results = self._engine.search(query, categories)
            return self._engine.format_search_results(query, results, categories)
        except Exception as e:
            return f"⚠️ Search error: {str(e)}\n\nFallback: `computer.tools.list_categories()`"
    
    def list_categories(self) -> str:
        """
        List all available tool categories with descriptions and metadata.
        
        Returns:
            Formatted string with category information
        """
        categories = self._engine.get_categories()
        
        output = ["# Available Tool Categories\n"]
        for cat in categories:
            output.append(f"## {cat['name']}")
            output.append(f"**Description:** {cat['description']}")
            output.append(f"**Tools:** {cat['tool_count']}")
            if cat.get('common_use_cases'):
                output.append(f"**Use Cases:** {', '.join(cat['common_use_cases'][:3])}")
            output.append("")
        
        output.append("💡 **Next:** `computer.tools.list_tools(category=\"Category Name\")`")
        return "\n".join(output)
    
    def list_tools(
        self, 
        category: Optional[str] = None, 
        complexity: Optional[str] = None,
        subcategory: Optional[str] = None, 
        show_details: bool = False
    ) -> str:
        """
        List tools in a specific category with optional filtering.
        
        Args:
            category: Category name (if None, shows categories instead)
            complexity: Filter by "simple", "moderate", or "advanced"
            subcategory: Filter by subcategory
            show_details: Include detailed information
        
        Returns:
            Formatted string with tool listings
        """
        if category is None:
            return self.list_categories()
        
        tools = self._engine.list_tools_by_category(category, complexity, subcategory)
        
        if not tools:
            return f"# No tools found in '{category}'\n\n**Try:** `computer.tools.list_categories()`"
        
        # Format output
        output = [f"# Tools in '{category}'\n"]
        output.append(f"**Found {len(tools)} tools**\n")
        
        for tool in tools:
            output.append(f"**{tool['name']}**")
            output.append(f"  Path: `{tool['path']}`")
            if tool.get('description'):
                output.append(f"  Description: {tool['description']}")
            output.append("")
        
        output.append("💡 **Details:** `computer.tools.get_info(tool_path=\"path\")`")
        return "\n".join(output)
    
    def get_info(self, tool_path: str) -> str:
        """
        Get detailed information about a specific tool.
        
        Args:
            tool_path: Full tool path (e.g., "computer.browser.search")
        
        Returns:
            Formatted string with comprehensive tool information
        """
        tool_info = self._engine.get_tool_info(tool_path)
        
        if "error" in tool_info:
            return f"❌ {tool_info['error']}"
        
        output = [f"# Tool: {tool_info['name']}\n"]
        output.append(f"**Path:** `{tool_info['full_path']}`")
        output.append(f"**Category:** {tool_info['category']}")
        output.append(f"**Complexity:** {tool_info['complexity']}")
        
        if tool_info.get('description'):
            output.append(f"\n## Description\n{tool_info['description']}")
        
        output.append(f"\n## Usage\n```python\n{tool_info['full_path']}{tool_info.get('signature', '')}\n```")
        
        if tool_info.get('use_cases'):
            output.append(f"\n## Use Cases")
            for uc in tool_info['use_cases']:
                output.append(f"- {uc}")
        
        return "\n".join(output)
    
    def recommend(self, task: str) -> str:
        """
        Get tool recommendations based on a task description.
        
        Args:
            task: Description of what you want to accomplish
        
        Returns:
            Formatted string with tool recommendations
        """
        recommendations = self._engine.recommend_tools_for_task(task)
        
        if not recommendations:
            return f"No recommendations for '{task}'. Try: `computer.tools.list_categories()`"
        
        output = [f"# Recommendations: {task}\n"]
        
        for i, tool in enumerate(recommendations[:5], 1):
            output.append(f"## {i}. {tool['name']}")
            output.append(f"  Path: `{tool['full_path']}`")
            output.append(f"  Relevance: {tool.get('relevance_reason', 'Match')}")
            output.append("")
        
        output.append("💡 `computer.tools.get_info(tool_path)` for details")
        return "\n".join(output)
    
    def get_category_summary(self, category: str) -> str:
        """Get a detailed summary of a specific category."""
        summary = self._engine.get_category_summary(category)
        
        if "error" in summary:
            return f"❌ {summary['error']}"
        
        output = [f"# Category: {summary['name']}\n"]
        output.append(f"**Description:** {summary['description']}")
        output.append(f"**Tools:** {summary['tool_count']}")
        
        if summary.get('common_use_cases'):
            output.append(f"\n## Use Cases")
            for uc in summary['common_use_cases'][:3]:
                output.append(f"- {uc}")
        
        output.append(f"\n💡 `computer.tools.list_tools(category=\"{category}\")`")
        return "\n".join(output)
    
    def get_usage_stats(self) -> str:
        """Get statistics about tool discovery and usage in this session."""
        return self._engine.get_usage_stats()
    
    def get_system_message(self) -> str:
        """Get the system message introducing the tool discovery system."""
        return """
# 🤖 SEMANTIC TOOL DISCOVERY SYSTEM

Powerful semantic search powered by LM Studio embeddings.
Understands intent and finds relevant tools by meaning.

## 🔍 PRIMARY WORKFLOW:
1. **Semantic Search:** `computer.tools.search(query="what you want to do")`
   - Uses AI embeddings to understand intent
   - Finds tools by meaning, not just keywords
   - Example: `computer.tools.search("send an email")` → finds mail tools
   - Example: `computer.tools.search("work with spreadsheets")` → finds Excel tools

2. **Get Recommendations:** `computer.tools.recommend(task="describe your task")`
   - AI-powered task analysis and tool suggestions

3. **Direct Tool Usage:** Use tools immediately after finding them

## 📚 FALLBACK WORKFLOW:
1. **Explore Categories:** `computer.tools.list_categories()`
2. **List Tools:** `computer.tools.list_tools(category="Category Name")`
3. **Tool Details:** `computer.tools.get_info(tool_path="computer.module.method")`

## 🎯 KEY FEATURES:
- **Semantic Understanding:** Searches by meaning using embeddings
- **Intelligent Matching:** Finds tools with different wording
- **Context Awareness:** Considers descriptions, tags, use cases
- **Robust Fallback:** Keyword search if embeddings unavailable
- **Caching:** Fast repeated searches

## ⚡ QUICK START:
```python
# Find email tools
computer.tools.search("send email")

# Find file operations
computer.tools.search("work with documents")

# Find web tools
computer.tools.search("search the web")

# Find automation tools
computer.tools.search("create workflows")
```

**IMPORTANT:** Always use semantic search first for accurate results.
        """.strip()
    
    # ========================================================================
    # LEGACY API - Backward Compatibility
    # ========================================================================
    
    def categories(self) -> List[str]:
        """Legacy: Return available tool categories (sorted)."""
        categories = set(self._class_to_category.values())
        return sorted(categories)
    
    def list(self, category: Optional[str] = None) -> List[ToolDescriptor]:
        """
        Legacy: List tools, optionally filtered by category.
        Returns ToolDescriptor with path, signature and description.
        """
        results: List[ToolDescriptor] = []
        for cls_name, tool_instance, name, attr in self._iter_tool_methods():
            cat = self._class_to_category.get(cls_name, "Other")
            if category and cat != category:
                continue
            
            try:
                sig = str(inspect.signature(attr))
            except Exception:
                sig = "(…)"
            
            path = f"computer.{cls_name.lower()}.{name}{sig}"
            desc = (getattr(attr, "__doc__", None) or "").strip()
            results.append(
                ToolDescriptor(category=cat, path=path, signature=sig, description=desc)
            )
        
        results.sort(key=lambda d: (d.category, d.path))
        return results
    
    def info(self, tool_path: str) -> Dict[str, Any]:
        """Legacy: Return detailed info for a tool given its dotted path."""
        try:
            parts = tool_path.split(".")
            if len(parts) < 3 or parts[0] != "computer":
                raise ValueError("Tool path must start with 'computer.'")
            
            cls_name = parts[1]
            method_name = parts[2]
            
            tool_instance = getattr(self._computer, cls_name, None)
            if tool_instance is None:
                tool_instance = getattr(self._computer, cls_name.lower(), None)
            if tool_instance is None:
                raise AttributeError(f"Unknown tool class: {cls_name}")
            
            method = getattr(tool_instance, method_name)
            sig = str(inspect.signature(method))
            desc = (getattr(method, "__doc__", None) or "").strip()
            category = self._class_to_category.get(
                getattr(tool_instance, "__class__", type(tool_instance)).__name__, "Other"
            )
            
            return {
                "category": category,
                "path": tool_path,
                "signature": sig,
                "description": desc,
            }
        except Exception as e:
            return {"error": str(e), "path": tool_path}
    
    def _iter_tool_methods(self):
        """Legacy: Enumerate all tool instances from the computer (delegates to engine)"""
        # For backward compatibility - delegates to engine's discovery
        for attr_name, cls_name, tool_instance, name, attr in self._engine._iter_tool_methods():
            yield cls_name, tool_instance, name, attr
    
    # ========================================================================
    # PRIVATE HELPERS
    # ========================================================================
    
    def _is_screenshot_query(self, query: str) -> bool:
        """Check if query is screenshot-related"""
        query_lower = query.lower()
        keywords = ['screenshot', 'screen', 'visual', 'analyze', 'check what']
        return any(kw in query_lower for kw in keywords)
    
    def _get_screenshot_tools_info(self) -> str:
        """Get hardcoded screenshot tools information"""
        return """## 🎯 RECOMMENDED: OmniParser Screenshot Analysis (PRIMARY)
computer.analyze_screenshot(window='AppName')
→ Takes screenshot AND analyzes with OmniParser (Apple Vision OCR + YOLO)
→ Returns structured UI element analysis: buttons, inputs, text, icons with coordinates
→ **No custom prompts needed** - automatic structured analysis
→ Perfect for GUI automation and element detection
→ **CURRENTLY ACTIVE** and working optimally

## 🔧 Advanced Screenshot Tools
computer.screenshotanalyzer.take_and_analyze_screenshot(window_target='AppName')
→ Uses OmniParser by default for structured analysis
→ Supports window targeting and fallback to InternVL

## 🪟 Window Management
computer.screenshotanalyzer.list_available_windows()
→ Lists all open windows for targeting specific applications

## 📸 Basic Screenshot (No AI Analysis)
computer.display.screenshot()
→ Takes screenshot, returns PIL Image (no AI analysis)

## 💡 QUICK USAGE:
```python
# Analyze any app with OmniParser
result = computer.analyze_screenshot(window='LM Studio')
print(result)  # Complete UI breakdown

# List available windows
windows = computer.screenshotanalyzer.list_available_windows()
```"""

