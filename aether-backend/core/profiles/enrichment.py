"""
Profile Enrichment System - Tool Discovery for Open Interpreter Profiles

@.architecture
Incoming: core/runtime/interpreter.py, core/profiles/manager.py --- {Open Interpreter instance with computer.tools._engine, original profile prompt str, enrichment strategy}
Processing: enrich_profile_prompt(), inject_profile_tools(), _generate_category_brief(), _generate_tools_brief(), _generate_discovery_instructions(), _generate_minimal_instructions(), get_profile_tool_summary(), get_health_status() --- {8 jobs: prompt_enrichment, strategy_selection, text_generation, tool_discovery_injection, summary_generation, health_checking}
Outgoing: core/runtime/interpreter.py, core/profiles/manager.py --- {enriched system_message str with tool discovery instructions, tool summary Dict, health status Dict}

Provides just-in-time tool discovery for Open Interpreter profiles without
bloating system prompts with full tool catalogs.

Key Features:
- Tool brief generation (concise overview of all tools)
- On-demand tool query interface for profiles
- Dynamic context injection based on profile needs
- Prevents prompt bloat by keeping tool details external
- Scales to 1000+ tools without performance impact

Architecture:
- ProfileEnricher injects discovery methods into profile
- Profiles use search/list/info methods to find tools
- Tool details loaded only when needed
- Clear separation between profile logic and tool catalog

Production Features:
- Complete error handling
- Graceful degradation if tool engine unavailable
- Multiple enrichment strategies
- Safe prompt manipulation
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class ProfileEnricher:
    """
    Enriches Open Interpreter profiles with tool discovery capabilities.
    
    Provides profiles with:
    1. Tool brief overview (compact category list)
    2. Search interface (semantic tool discovery)
    3. Query methods (on-demand tool details)
    4. Discovery workflow instructions
    
    Does NOT:
    - Dump full tool catalog into prompts
    - Hardcode tool lists in profiles
    - Bloat system prompts with documentation
    
    Usage:
        enricher = ProfileEnricher(interpreter)
        enriched_prompt = enricher.enrich_profile_prompt(
            original_prompt,
            strategy="brief"
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
        self._tool_engine_available = False
        
        # Check if tool engine is available
        if hasattr(self.computer, 'tools') and hasattr(self.computer.tools, '_engine'):
            self._tool_engine_available = True
            self.tool_engine = self.computer.tools._engine
            logger.info("ProfileEnricher initialized with tool engine")
        else:
            logger.warning("ProfileEnricher initialized without tool engine - limited functionality")

    def enrich_profile_prompt(
        self,
        original_prompt: str,
        strategy: str = "brief"
    ) -> str:
        """
        Enrich profile prompt with tool discovery capabilities.
        
        Args:
            original_prompt: Original system message
            strategy: Enrichment strategy ("minimal", "brief", "detailed")
            
        Returns:
            Enriched system message
        """
        if not self._tool_engine_available:
            logger.debug("Tool engine not available, returning original prompt")
            return original_prompt

        try:
            sections = [original_prompt]

            if strategy == "minimal":
                # Just add discovery instructions
                sections.append(self._generate_minimal_instructions())
                
            elif strategy == "brief":
                # Add category brief + instructions
                sections.append(self._generate_category_brief())
                sections.append(self._generate_discovery_instructions())
                
            elif strategy == "detailed":
                # Add category brief + tool list + instructions
                sections.append(self._generate_category_brief())
                sections.append(self._generate_tools_brief(limit=30))
                sections.append(self._generate_discovery_instructions())
                
            else:
                logger.warning(f"Unknown enrichment strategy: {strategy}")
                return original_prompt

            return "\n\n---\n\n".join(sections)

        except Exception as e:
            logger.error(f"Failed to enrich profile prompt: {e}")
            return original_prompt

    def inject_profile_tools(
        self,
        profile_name: str,
        enrichment_strategy: str = "brief"
    ) -> None:
        """
        Inject tool discovery into active interpreter profile.
        
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
            
            logger.info(f"Enriched profile '{profile_name}' with strategy '{enrichment_strategy}'")
            
        except Exception as e:
            logger.error(f"Failed to enrich profile '{profile_name}': {e}")
            raise

    # ============================================================================
    # BRIEF GENERATORS
    # ============================================================================

    def _generate_category_brief(self) -> str:
        """Generate brief overview of tool categories"""
        if not self._tool_engine_available:
            return ""

        try:
            categories = self.tool_engine.get_categories()
            
            lines = [
                "# 🔧 Available Tool Categories",
                "",
                "Use `computer.tools.search(\"intent\")` to find relevant tools.",
                ""
            ]
            
            for cat in categories:
                tool_count = cat.get('tool_count', 0)
                description = cat.get('description', '')[:80]
                lines.append(f"- **{cat['name']}** ({tool_count} tools): {description}")
            
            return "\n".join(lines)

        except Exception as e:
            logger.warning(f"Failed to generate category brief: {e}")
            return ""

    def _generate_tools_brief(self, limit: int = 30) -> str:
        """Generate brief listing of top tools"""
        if not self._tool_engine_available:
            return ""

        try:
            categories = self.tool_engine.get_categories()
            
            lines = [
                "# Tool Quick Reference",
                "",
                "**Search First:** `computer.tools.search(\"what you want to do\")`",
                ""
            ]
            
            tool_count = 0
            for cat in categories:
                if tool_count >= limit:
                    break

                cat_name = cat.get('name', 'Unknown')
                tools = cat.get('tools', [])
                
                if tools:
                    lines.append(f"## {cat_name}")
                    
                    for tool in tools[:5]:  # Max 5 tools per category
                        if tool_count >= limit:
                            break
                        
                        tool_name = tool.get('name', '')
                        tool_desc = tool.get('description', '')[:60]
                        lines.append(f"- `{tool_name}`: {tool_desc}")
                        tool_count += 1
                    
                    lines.append("")

            return "\n".join(lines)

        except Exception as e:
            logger.warning(f"Failed to generate tools brief: {e}")
            return ""

    def _generate_discovery_instructions(self) -> str:
        """Generate tool discovery workflow instructions"""
        return """# 🔍 Tool Discovery Workflow

## Primary Method: Semantic Search
`computer.tools.search(query="what you want to accomplish")`

Uses AI embeddings to understand intent and find relevant tools.

**Examples:**
- `computer.tools.search("analyze PDF documents")` → docling_convert
- `computer.tools.search("search the web")` → perplexica_search
- `computer.tools.search("work with Excel")` → xlwings tools
- `computer.tools.search("take screenshots")` → display.screenshot

## Fallback Methods
1. **Browse Categories:** `computer.tools.list_categories()`
2. **List Category Tools:** `computer.tools.list_tools(category="Category Name")`
3. **Get Recommendations:** `computer.tools.recommend(task="description")`
4. **Tool Details:** `computer.tools.get_info(tool_path="computer.module.method")`

## Best Practices
- Search by intent, not by tool name
- Load tool details only when needed
- Clear context when switching workflows
- Combine tools for complex tasks

## Context Injection Strategy
1. Agent identifies task
2. Agent searches for relevant tools
3. System returns 3-5 relevant tools
4. Agent injects ONLY needed tool contexts
5. Agent executes workflow
6. Agent clears tool contexts when done

This scales to 1000+ tools without prompt bloat.""".strip()

    def _generate_minimal_instructions(self) -> str:
        """Generate minimal tool discovery instructions"""
        return """# 🔧 Tool Discovery

Use semantic search to find tools:
- `computer.tools.search("what you want to do")` - Find tools by intent
- `computer.tools.list_categories()` - Browse all categories
- `computer.tools.get_info(tool_path)` - Get tool details

Load tool context on-demand. Don't bloat prompts with full catalogs.""".strip()

    # ============================================================================
    # UTILITY METHODS
    # ============================================================================

    def get_profile_tool_summary(self) -> Dict[str, Any]:
        """
        Get summary of tool discovery capabilities.
        
        Returns:
            Dict with tool discovery summary
        """
        if not self._tool_engine_available:
            return {
                "tool_engine_available": False,
                "category_count": 0,
                "total_tool_count": 0,
            }

        try:
            categories = self.tool_engine.get_categories()
            total_tools = sum(cat.get('tool_count', 0) for cat in categories)

            return {
                "tool_engine_available": True,
                "category_count": len(categories),
                "total_tool_count": total_tools,
                "discovery_methods": [
                    'computer.tools.search(query)',
                    'computer.tools.list_categories()',
                    'computer.tools.list_tools(category)',
                    'computer.tools.get_info(tool_path)',
                    'computer.tools.recommend(task)'
                ]
            }

        except Exception as e:
            logger.error(f"Failed to get tool summary: {e}")
            return {"error": str(e)}

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of profile enricher.
        
        Returns:
            Dict with health status information
        """
        return {
            "interpreter_available": self.interpreter is not None,
            "computer_available": self.computer is not None,
            "tool_engine_available": self._tool_engine_available,
        }

