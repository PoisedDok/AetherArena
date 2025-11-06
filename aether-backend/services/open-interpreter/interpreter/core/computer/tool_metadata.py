"""
Tool Metadata Structures - YAML as Single Source of Truth

Pure data structures for tool categorization and metadata.
No hardcoded dictionaries - loads from tools_registry.yaml.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set
from enum import Enum
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

# YAML is loaded once at module import
_YAML_LOADED = False
_CATEGORY_DEFINITIONS = {}
_CLASS_TO_CATEGORY = {}


def _normalize_category_name(snake_case_name: str) -> str:
    """
    Normalize category name from snake_case to Title Case with proper formatting.
    
    Examples:
        web_search_extraction -> Web Search & Extraction
        files_documents -> Files & Documents
        ai_llm -> AI & LLM
    """
    # Special cases for proper formatting
    special_cases = {
        'web_search_extraction': 'Web Search & Extraction',
        'files_documents': 'Files & Documents',
        'gui_system_control': 'GUI & System Control',
        'vision': 'Vision',
        'excel_automation': 'Excel Automation',
        'mcp_tools': 'MCP Tools',
        'system_terminal': 'System & Terminal',
        'ai_llm': 'AI & LLM',
        'communication': 'Communication',
        'productivity': 'Productivity',
        'clipboard': 'Clipboard',
        'skills_automation': 'Skills & Automation',
        'other': 'Other',
    }
    
    if snake_case_name.lower() in special_cases:
        return special_cases[snake_case_name.lower()]
    
    # Fallback: convert snake_case to Title Case
    return ' '.join(word.capitalize() for word in snake_case_name.split('_'))


class ToolComplexity(Enum):
    """Tool complexity levels for better categorization"""
    SIMPLE = "simple"      # Basic operations, minimal parameters
    MODERATE = "moderate"  # Multiple parameters, some configuration
    ADVANCED = "advanced"  # Complex operations, many parameters, expert usage


@dataclass
class ToolMetadata:
    """Enhanced metadata for tools"""
    name: str
    category: str
    subcategory: Optional[str] = None
    description: str = ""
    complexity: ToolComplexity = ToolComplexity.SIMPLE
    parameters: List[Dict[str, Any]] = field(default_factory=list)
    examples: List[str] = field(default_factory=list)
    use_cases: List[str] = field(default_factory=list)
    dependencies: List[str] = field(default_factory=list)
    tags: Set[str] = field(default_factory=set)
    signature: str = ""
    full_path: str = ""
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            'name': self.name,
            'category': self.category,
            'subcategory': self.subcategory,
            'description': self.description,
            'complexity': self.complexity.value,
            'parameters': self.parameters,
            'examples': self.examples,
            'use_cases': self.use_cases,
            'dependencies': self.dependencies,
            'tags': list(self.tags),
            'signature': self.signature,
            'full_path': self.full_path
        }


@dataclass 
class ToolCategory:
    """Represents a tool category with metadata"""
    name: str
    description: str
    subcategories: List[str] = field(default_factory=list)
    tool_count: int = 0
    complexity_distribution: Dict[str, int] = field(default_factory=dict)
    common_use_cases: List[str] = field(default_factory=list)


def _load_yaml_definitions():
    """Load category definitions and mappings from YAML - single source of truth"""
    global _YAML_LOADED, _CATEGORY_DEFINITIONS, _CLASS_TO_CATEGORY
    
    if _YAML_LOADED:
        return
    
    try:
        import yaml
        
        # Find tools_registry.yaml
        registry_path = Path(__file__).parent / "tools_registry.yaml"
        
        if not registry_path.exists():
            logger.warning(f"tools_registry.yaml not found at {registry_path}, using fallback")
            _load_fallback_definitions()
            return
        
        with open(registry_path, 'r') as f:
            registry = yaml.safe_load(f)
        
        # Extract category definitions
        # Use normalized names as keys (Title Case with spaces and &)
        categories = registry.get('categories', {})
        for cat_name, cat_data in categories.items():
            # Convert snake_case to Title Case (web_search_extraction -> Web Search & Extraction)
            normalized_name = _normalize_category_name(cat_name)
            _CATEGORY_DEFINITIONS[normalized_name] = {
                "description": cat_data.get('description', ''),
                "subcategories": cat_data.get('subcategories', []),
                "common_use_cases": cat_data.get('common_use_cases', [])
            }
        
        # Build class to category mapping from YAML metadata
        # This is inferred from tool paths (e.g., computer.xlwings.* → Excel Automation)
        for cat_name, cat_data in categories.items():
            tools = cat_data.get('tools', [])
            for tool in tools:
                path = tool.get('path', '')
                if path.startswith('computer.'):
                    parts = path.split('.')
                    if len(parts) >= 2:
                        class_name = parts[1]
                        # Map various casing variants
                        _CLASS_TO_CATEGORY[class_name] = cat_name
                        _CLASS_TO_CATEGORY[class_name.capitalize()] = cat_name
                        _CLASS_TO_CATEGORY[class_name.upper()] = cat_name
                        _CLASS_TO_CATEGORY[class_name.lower()] = cat_name
        
        # Add known class name mappings (supplement YAML inference)
        _add_known_class_mappings()
        
        _YAML_LOADED = True
        logger.info(f"Loaded {len(_CATEGORY_DEFINITIONS)} categories from YAML")
        
    except Exception as e:
        logger.error(f"Failed to load YAML definitions: {e}")
        _load_fallback_definitions()


def _add_known_class_mappings():
    """Add known class name to category mappings"""
    # Open Interpreter built-in classes
    known_mappings = {
        "Files": "Files & Documents",
        "Docs": "Files & Documents",
        "FileSystem": "Files & Documents",
        "Browser": "Web Search & Extraction",
        "Display": "GUI & System Control",
        "Mouse": "GUI & System Control",
        "Keyboard": "GUI & System Control",
        "Os": "GUI & System Control",
        "Vision": "Vision",
        "ScreenshotAnalyzer": "Vision",
        "Clipboard": "Clipboard",
        "Mail": "Communication",
        "SMS": "Communication",
        "Calendar": "Productivity",
        "Contacts": "Productivity",
        "Skills": "Skills & Automation",
        "Terminal": "System & Terminal",
        "Notebook": "System & Terminal",
        "Ai": "AI & LLM",
        "Agents": "AI & LLM",
        "MCPToolsClass": "MCP Tools",
        "DiffMem": "AI & LLM",
        "DiffMemWrapper": "AI & LLM",
        # Integration-specific classes (from integrations_registry.yaml)
        "xlwings": "Excel Automation",
        "omni": "Vision",
        "OmniParalegalTools": "Vision",
        "DoclingService": "Files & Documents",
        "DirectFunction": "Other",  # Special marker for direct functions
    }
    _CLASS_TO_CATEGORY.update(known_mappings)


def _load_fallback_definitions():
    """Fallback definitions if YAML loading fails"""
    global _YAML_LOADED, _CATEGORY_DEFINITIONS, _CLASS_TO_CATEGORY
    
    _CATEGORY_DEFINITIONS = {
        "Files & Documents": {
            "description": "File management and document processing",
            "subcategories": ["File Operations", "Document Processing", "Document Conversion"],
            "common_use_cases": ["File operations", "Document processing", "PDF conversion"]
        },
        "Web Search & Extraction": {
            "description": "Web search and content extraction",
            "subcategories": ["Search", "Extraction", "Browser Automation"],
            "common_use_cases": ["Web search", "Content extraction", "Research"]
        },
        "GUI & System Control": {
            "description": "System and GUI automation",
            "subcategories": ["Mouse", "Keyboard", "System"],
            "common_use_cases": ["GUI automation", "System control"]
        },
        "Vision": {
            "description": "Screenshot analysis and vision",
            "subcategories": ["Screenshot Analysis", "OCR", "UI Analysis"],
            "common_use_cases": ["Screenshot analysis", "Visual understanding", "UI element detection"]
        },
        "MCP Tools": {
            "description": "Model Context Protocol integrations",
            "subcategories": ["External Services"],
            "common_use_cases": ["External tool integration"]
        },
        "Excel Automation": {
            "description": "Excel workbook creation and automation",
            "subcategories": ["Workbook Management", "Data Operations", "Charts"],
            "common_use_cases": ["Excel automation", "Data analysis", "Spreadsheet creation"]
        },
        "System & Terminal": {
            "description": "System operations and runtime management",
            "subcategories": ["Module Management", "Path Operations"],
            "common_use_cases": ["Module imports", "System path management", "Runtime inspection"]
        },
        "Other": {
            "description": "Other tools and utilities",
            "subcategories": [],
            "common_use_cases": ["Miscellaneous operations"]
        }
    }
    
    _add_known_class_mappings()
    _YAML_LOADED = True
    logger.warning("Using fallback definitions")


# Load YAML on module import
_load_yaml_definitions()

# Export as module-level constants for backward compatibility
CATEGORY_DEFINITIONS = _CATEGORY_DEFINITIONS
CLASS_TO_CATEGORY = _CLASS_TO_CATEGORY

