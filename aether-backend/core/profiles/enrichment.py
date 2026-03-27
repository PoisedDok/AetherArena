"""
Profile Enrichment System - Tool Discovery for Open Interpreter Profiles

@.architecture
Incoming: core/runtime/interpreter.py, core/profiles/manager.py, config/backend_tools_registry.yaml --- {Open Interpreter instance, original profile prompt str, enrichment strategy, tool registry YAML}
Processing: enrich_profile_prompt(), _load_tool_registry(), _generate_capabilities_overview(), _generate_discovery_instructions(), _format_category_tools() --- {JOB_GENERATE_CONTENT, JOB_PARSE_CONFIG, JOB_ORCHESTRATE}
Outgoing: core/runtime/interpreter.py, core/profiles/manager.py --- {enriched system_message str with tool capabilities and discovery instructions}

Provides clean, scannable tool capabilities overview from authoritative registry.
Agent sees what it can do, then uses semantic search for detailed usage.

Key Features:
- Reads from backend_tools_registry.yaml (single source of truth)
- Generates minimal but complete capabilities overview
- Instruction-based format with clear examples
- Semantic search workflow for detailed tool context
- Scales to 1000+ tools without prompt bloat

Architecture:
- ProfileEnricher loads registry on init
- Generates structured capabilities by category
- Injects discovery workflow instructions
- Agent scans capabilities → searches for details → uses tools

Production Features:
- YAML parsing with error handling
- Multiple enrichment strategies
- Graceful degradation
- Zero external dependencies beyond stdlib
"""

import logging
import yaml
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ProfileEnricher:
    """
    Enriches Open Interpreter profiles with tool capabilities from registry.
    
    Provides profiles with:
    1. Clean capabilities overview (category-organized tool list)
    2. Discovery workflow instructions (semantic search, category browsing)
    3. Example-driven guidance (how to find and use tools)
    
    Does NOT:
    - Dump full tool documentation into prompts
    - Include detailed signatures in overview
    - Bloat system prompts with redundant info
    
    Workflow:
        Agent reads capabilities → knows what exists
        Agent searches semantically → gets detailed context
        Agent uses tool → executes workflow
    
    Usage:
        enricher = ProfileEnricher(interpreter)
        enriched_prompt = enricher.enrich_profile_prompt(
            original_prompt,
            strategy="capabilities"  # clean overview
        )
    """

    def __init__(self, interpreter: Any):
        """
        Initialize profile enricher.
        
        Args:
            interpreter: Open Interpreter instance
        """
        self.interpreter = interpreter
        self.computer = interpreter.computer
        self._registry_data: Optional[Dict[str, Any]] = None
        self._registry_loaded = False
        
        # Load tool registry
        self._load_tool_registry()

    def _load_tool_registry(self) -> None:
        """Load backend tools registry from YAML."""
        try:
            # Find registry relative to this file
            current_dir = Path(__file__).parent
            registry_path = current_dir.parent.parent / "config" / "backend_tools_registry.yaml"
            
            if not registry_path.exists():
                logger.warning("Tool registry not found at %s", registry_path)
                return
            
            with open(registry_path, 'r') as f:
                self._registry_data = yaml.safe_load(f)
                self._registry_loaded = True
                
                # Extract metadata
                categories_count = len(self._registry_data.get('categories', {}))
                total_tools = sum(
                    len(cat.get('tools', []))
                    for cat in self._registry_data.get('categories', {}).values()
                )
                
                logger.info("Tool registry loaded: %d categories, %d tools", categories_count, total_tools)
                
        except Exception as e:
            logger.error("Failed to load tool registry: %s", e, exc_info=True)
            self._registry_loaded = False

    def enrich_profile_prompt(
        self,
        original_prompt: str,
        strategy: str = "capabilities"
    ) -> str:
        """
        Enrich profile prompt with tool capabilities and discovery workflow.
        
        Args:
            original_prompt: Original system message
            strategy: Enrichment strategy
                - "capabilities": Full capabilities overview + discovery instructions
                - "minimal": Just discovery instructions
                - "none": No enrichment
            
        Returns:
            Enriched system message
        """
        if strategy == "none" or not self._registry_loaded:
            if not self._registry_loaded:
                logger.debug("Tool registry not loaded, returning original prompt")
            return original_prompt

        try:
            sections = [original_prompt]

            if strategy == "minimal":
                # Just discovery instructions
                sections.append(self._generate_discovery_instructions())
                
            elif strategy == "capabilities":
                # Capabilities overview + discovery instructions
                sections.append(self._generate_capabilities_overview())
                sections.append(self._generate_discovery_instructions())
                
            else:
                logger.warning("Unknown enrichment strategy: %s", strategy)
                return original_prompt

            return "\n\n---\n\n".join(sections)

        except Exception as e:
            logger.error("Failed to enrich profile prompt: %s", e, exc_info=True)
            return original_prompt

    def inject_profile_tools(
        self,
        profile_name: str,
        enrichment_strategy: str = "capabilities"
    ) -> None:
        """
        Inject tool capabilities into active interpreter profile.
        
        Args:
            profile_name: Name of profile to enrich
            enrichment_strategy: Enrichment strategy to use
        """
        try:
            # Get current system message
            current_message = self.interpreter.system_message or ""
            
            # Enrich based on strategy
            enriched = self.enrich_profile_prompt(current_message, enrichment_strategy)
            
            # Update interpreter system message
            self.interpreter.system_message = enriched
            
            logger.info("Enriched profile '%s' with strategy '%s'", profile_name, enrichment_strategy)
            
        except Exception as e:
            logger.error("Failed to enrich profile '%s': %s", profile_name, e)
            raise

    # ============================================================================
    # CAPABILITIES OVERVIEW GENERATION
    # ============================================================================

    def _generate_capabilities_overview(self) -> str:
        """Generate clean, scannable tool capabilities overview."""
        if not self._registry_loaded or not self._registry_data:
            return ""

        try:
            categories = self._registry_data.get('categories', {})
            
            lines = [
                "# 🔧 Tool Capabilities",
                "",
                "You have access to a comprehensive tool ecosystem. Scan categories below to understand your capabilities,",
                "then use semantic search to get detailed usage information for specific tools.",
                ""
            ]
            
            # Group categories by functional area
            core_categories = []
            integration_categories = []
            
            for cat_name, cat_data in categories.items():
                tool_count = len(cat_data.get('tools', []))
                if tool_count == 0:
                    continue
                    
                category_info = {
                    'name': cat_name,
                    'description': cat_data.get('description', ''),
                    'tool_count': tool_count,
                    'tools': cat_data.get('tools', [])
                }
                
                # Categorize
                if any(keyword in cat_name.lower() for keyword in ['artifact', 'chat', 'trail', 'memory']):
                    core_categories.append(category_info)
                else:
                    integration_categories.append(category_info)
            
            # Render core categories
            if core_categories:
                lines.append("## Core Capabilities")
                lines.append("")
                for cat in core_categories:
                    lines.extend(self._format_category_tools(cat))
                lines.append("")
            
            # Render integration categories
            if integration_categories:
                lines.append("## Integration Tools")
                lines.append("")
                for cat in integration_categories:
                    lines.extend(self._format_category_tools(cat))
                lines.append("")
            
            # Summary
            total_tools = sum(len(cat.get('tools', [])) for cat in categories.values())
            total_categories = len(categories)
            lines.append(f"**Total: {total_categories} categories, {total_tools} tools available**")
            
            return "\n".join(lines)

        except Exception as e:
            logger.warning("Failed to generate capabilities overview: %s", e, exc_info=True)
            return ""

    def _format_category_tools(self, category: Dict[str, Any]) -> List[str]:
        """Format a category's tools in scannable format."""
        lines = []
        
        cat_name = category['name']
        description = category['description']
        tool_count = category['tool_count']
        tools = category['tools']
        
        # Category header
        lines.append(f"### {cat_name} ({tool_count} tools)")
        lines.append(f"*{description}*")
        lines.append("")
        
        # Show representative tools (max 8 per category for scannability)
        display_tools = tools[:8]
        
        for tool in display_tools:
            tool_name = tool.get('name', 'unknown')
            tool_path = tool.get('path', '')
            tool_desc = tool.get('description', '')
            
            # Clean description
            if tool_desc:
                tool_desc = tool_desc.replace('\n', ' ').strip()
                if len(tool_desc) > 80:
                    tool_desc = tool_desc[:77] + "..."
            
            # Format: - computer.tool_name — brief description
            if tool_path:
                lines.append(f"- `{tool_path}` — {tool_desc}")
            else:
                lines.append(f"- `{tool_name}` — {tool_desc}")
        
        # If more tools exist, indicate how to find them
        if len(tools) > 8:
            remaining = len(tools) - 8
            lines.append(f"- *...and {remaining} more (use semantic search to discover)*")
        
        lines.append("")
        return lines

    # ============================================================================
    # DISCOVERY INSTRUCTIONS
    # ============================================================================

    def _generate_discovery_instructions(self) -> str:
        """Generate tool discovery workflow instructions."""
        return """# 🔍 Tool Discovery Workflow

## How to Find and Use Tools

**Step 1: Scan Capabilities (above)**
Get a high-level view of what tools exist and their categories.

**Step 2: Semantic Search for Details**
When you need a specific capability, use semantic search:

```python
# Search by intent/task description
# NOTE: Tool discovery functions auto-print output to prevent execution deadlocks
print(computer.tools.search("send email to contacts"))
print(computer.tools.search("analyze PDF document structure"))
print(computer.tools.search("manage generated artifacts"))
print(computer.tools.search("create Excel spreadsheet with charts"))
```

**Step 3: Get Tool Details**
Once you find the right tool, get its full signature and documentation:

```python
# Get complete tool information
print(computer.tools.get_info("computer.perplexica_search"))
print(computer.tools.get_info("computer.storage_artifacts_get"))
```

**Step 4: Execute Tool**
Use the tool with proper parameters:

```python
# Example: Search the web
results = computer.perplexica_search(
    query="latest AI research papers",
    focus_mode="academic",
    max_results=10
)

# Example: Retrieve artifact
artifact = computer.storage_artifacts_get(artifact_id="uuid-here")
```

## Alternative Discovery Methods

**Browse by Category:**
```python
# List all categories
print(computer.tools.list_categories())

# List tools in a specific category (use actual category names from tools_registry.yaml)
print(computer.tools.list_tools(category="browser"))
print(computer.tools.list_tools(category="files_documents"))
```

**Get Recommendations:**
```python
# Get tool recommendations for a task
print(computer.tools.recommend(task="I need to parse legal documents"))
```

## Best Practices

1. **Scan First, Search Second**: Review capabilities overview to understand scope
2. **Search by Intent**: Use natural language descriptions, not tool names
3. **Load Context Lazily**: Only fetch detailed tool info when you're ready to use it
4. **Combine Tools**: Chain multiple tools for complex workflows
5. **Check Execution Context**: Artifact IDs and other metadata appear after tool execution

## Artifact Management Workflow

Artifacts (generated code, HTML, files) are automatically tracked:

1. **Generate Content**: When you create code/HTML/output, it's stored as an artifact
2. **Check Context**: After execution, see artifact IDs in "Execution Context" section
3. **Retrieve Artifacts**: Use artifact tools to fetch previous outputs
   ```python
   # List all artifacts in current chat
   artifacts = computer.storage_chats_artifacts_get(current_chat_id)
   
   # Get specific artifact content
   content = computer.storage_artifacts_get(artifact_id)
   ```

This workflow scales efficiently to 1000+ tools without prompt bloat.""".strip()

    # ============================================================================
    # UTILITY METHODS
    # ============================================================================

    def get_profile_tool_summary(self) -> Dict[str, Any]:
        """
        Get summary of tool capabilities from registry.
        
        Returns:
            Dict with tool summary
        """
        if not self._registry_loaded or not self._registry_data:
            return {
                "registry_loaded": False,
                "category_count": 0,
                "total_tool_count": 0,
            }

        try:
            categories = self._registry_data.get('categories', {})
            total_tools = sum(
                len(cat.get('tools', []))
                for cat in categories.values()
            )
            
            category_summary = []
            for cat_name, cat_data in categories.items():
                category_summary.append({
                    "name": cat_name,
                    "description": cat_data.get('description', ''),
                    "tool_count": len(cat_data.get('tools', []))
                })

            return {
                "registry_loaded": True,
                "category_count": len(categories),
                "total_tool_count": total_tools,
                "categories": category_summary,
                "discovery_methods": [
                    'computer.tools.search(query)',
                    'computer.tools.list_categories()',
                    'computer.tools.list_tools(category)',
                    'computer.tools.get_info(tool_path)',
                    'computer.tools.recommend(task)'
                ]
            }

        except Exception as e:
            logger.error("Failed to get tool summary: %s", e)
            return {"error": str(e)}

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of profile enricher.
        
        Returns:
            Dict with health status information
        """
        return {
            "interpreter_available": self.interpreter is not None,
            "computer_available": self.computer is not None,
            "registry_loaded": self._registry_loaded,
            "registry_categories": len(self._registry_data.get('categories', {})) if self._registry_data else 0,
        }
