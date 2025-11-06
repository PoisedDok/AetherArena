"""
Unified Tool Engine - Single module for all tool operations

Consolidates:
- Tool discovery (from computer API)
- Tool catalog (storage and queries)
- Semantic search (LM Studio embeddings)
- Output formatting (HTML/markdown)

Single source of truth for tool indexing and retrieval.
"""

from __future__ import annotations
import asyncio
import concurrent.futures
import hashlib
import html
import inspect
import json
import logging
import pickle
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import httpx
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

from .tool_metadata import (
    ToolMetadata,
    ToolComplexity,
    ToolCategory,
    CATEGORY_DEFINITIONS,
    CLASS_TO_CATEGORY
)

logger = logging.getLogger(__name__)
httpx_logger = logging.getLogger("httpx")
httpx_logger.setLevel(logging.WARNING)


# ============================================================================
# SEARCH RESULTS
# ============================================================================

@dataclass
class SearchResult:
    """Semantic search result with metadata"""
    tool_path: str
    score: float
    match_type: str  # 'semantic', 'keyword', 'hybrid'


# ============================================================================
# UNIFIED TOOL ENGINE
# ============================================================================

class ToolEngine:
    """
    Unified tool management: discovery, indexing, search, formatting.
    
    Responsibilities:
    - Discover all tools from computer instance
    - Build semantic index with LM Studio embeddings
    - Provide search and filtering
    - Format results for display
    
    One class for all tool operations.
    """
    
    def __init__(
        self, 
        computer: Any,
        use_whitelist: bool = False,
        lm_studio_url: str = "http://localhost:1234/v1",
        embedding_model: str = "text-embedding-nomic-embed-text-v1.5",
        index_dir: Optional[Path] = None,
        output_format: str = "html"
    ):
        """
        Initialize unified tool engine.
        
        Args:
            computer: Computer instance with tool modules
            use_whitelist: Enable whitelist filtering
            lm_studio_url: LM Studio API endpoint
            embedding_model: Embedding model name
            index_dir: Directory for index persistence
            output_format: Output format ('html' or 'markdown')
        """
        self._computer = computer
        self._use_whitelist = use_whitelist
        self._output_format = output_format
        
        # Category definitions from YAML
        self._category_definitions = CATEGORY_DEFINITIONS
        self._class_to_category = CLASS_TO_CATEGORY
        
        # Tool storage
        self._tool_cache: Dict[str, ToolMetadata] = {}
        self._category_cache: Dict[str, ToolCategory] = {}
        self._initialized = False
        
        # Semantic search
        self._lm_studio_url = lm_studio_url
        self._embedding_model = embedding_model
        self._http_client: Optional[httpx.AsyncClient] = None
        
        # Index storage
        if index_dir is None:
            index_dir = Path.home() / ".oi_tools_index"
        self.index_dir = Path(index_dir)
        self.index_dir.mkdir(parents=True, exist_ok=True)
        
        self.embeddings_file = self.index_dir / "embeddings.pkl"
        self.index_info_file = self.index_dir / "index_info.json"
        
        # In-memory index
        self._tool_texts: Dict[str, str] = {}
        self._tool_embeddings: Dict[str, np.ndarray] = {}
        self._embeddings_cache: Dict[str, np.ndarray] = {}
        self._index_hash: Optional[str] = None
        self._indexed = False
        
        # Session tracking
        self._loaded_categories: set = set()
        self._loaded_tools: set = set()
    
    # ========================================================================
    # INITIALIZATION
    # ========================================================================
    
    def _ensure_initialized(self):
        """Lazy initialization"""
        if not self._initialized:
            self._build_catalog()
            self._initialized = True
    
    def _build_catalog(self):
        """Build complete tool catalog with semantic indexing"""
        logger.info("Building unified tool catalog...")
        
        # Initialize categories from definitions
        for cat_name, cat_def in self._category_definitions.items():
            self._category_cache[cat_name] = ToolCategory(
                name=cat_name,
                description=cat_def["description"],
                subcategories=cat_def["subcategories"],
                common_use_cases=cat_def["common_use_cases"]
            )
        
        # Ensure "Other" category exists as a catch-all
        if "Other" not in self._category_cache:
            self._category_cache["Other"] = ToolCategory(
                name="Other",
                description="Other tools and utilities",
                subcategories=[],
                common_use_cases=["Miscellaneous operations"]
            )
        
        # Wait briefly for MCP tools to be registered (if MCP bridge is present)
        # This ensures dynamic MCP tools are included in initial discovery
        try:
            if hasattr(self._computer, 'mcp') and hasattr(self._computer.mcp, '_bridge'):
                import time
                # Brief wait to allow MCP tool registration to complete
                time.sleep(0.5)
                logger.debug("Waited for MCP tool registration")
        except Exception:
            pass
        
        # Discover all tools from computer API
        self._tool_cache = self._discover_all_tools()
        
        # Enrich with YAML metadata from tools_registry.yaml
        self._enrich_from_tools_registry()
        
        # Generate comprehensive texts for semantic indexing
        tool_texts = {}
        for tool_path, meta in self._tool_cache.items():
            text_parts = [
                f"Name: {meta.name}",
                f"Category: {meta.category}",
                f"Description: {meta.description}",
                f"Use cases: {'; '.join(meta.use_cases)}",
                f"Tags: {', '.join(meta.tags)}",
            ]
            
            if meta.subcategory:
                text_parts.insert(2, f"Subcategory: {meta.subcategory}")
            
            if meta.parameters:
                param_names = [p['name'] for p in meta.parameters]
                text_parts.append(f"Parameters: {', '.join(param_names)}")
            
            tool_texts[tool_path] = ". ".join(text_parts)
        
        # Index tools with semantic engine
        try:
            self._index_tools(tool_texts, force=False)
        except Exception as e:
            logger.warning(f"Failed to index tools: {e}")
        
        # Update category statistics
        complexity_counts = {cat: {"simple": 0, "moderate": 0, "advanced": 0} 
                           for cat in self._category_definitions.keys()}
        
        for tool_path, tool_meta in self._tool_cache.items():
            category = tool_meta.category
            
            if category in complexity_counts:
                complexity_counts[category][tool_meta.complexity.value] += 1
                self._category_cache[category].tool_count += 1
        
        # Update complexity distributions
        for cat_name, counts in complexity_counts.items():
            if cat_name in self._category_cache:
                self._category_cache[cat_name].complexity_distribution = counts
        
        logger.info(f"✅ Tool catalog built: {len(self._tool_cache)} tools in {len(self._category_cache)} categories (YAML-enriched)")
    
    # ========================================================================
    # TOOL DISCOVERY
    # ========================================================================
    
    def _discover_all_tools(self) -> Dict[str, ToolMetadata]:
        """Discover all tools from computer instance"""
        tools: Dict[str, ToolMetadata] = {}
        
        for result in self._iter_tool_methods():
            # Handle both 5-tuple and 6-tuple returns (with optional category)
            if len(result) == 6:
                attr_name, cls_name, tool_instance, method_name, method, inferred_category = result
                category = inferred_category
            else:
                attr_name, cls_name, tool_instance, method_name, method = result
                category = self._class_to_category.get(cls_name, "Other")
            
            tool_metadata = self._create_tool_metadata(
                attr_name, cls_name, tool_instance, method_name, method, category
            )
            
            tools[tool_metadata.full_path] = tool_metadata
        
        return tools
    
    def _iter_tool_methods(self):
        """Iterate over all tool methods in computer API"""
        discovered_attrs = set()
        
        # Check __dict__ items - both class instances AND direct functions
        for attr_name, tool_instance in self._computer.__dict__.items():
            if attr_name.startswith("_"):
                continue
            discovered_attrs.add(attr_name)
            
            # Handle direct callable functions (attach_as: functions)
            if callable(tool_instance) and not isinstance(tool_instance, type):
                # This is a direct function attached to computer
                # Infer category from integrations_registry.yaml or use default
                category = self._infer_category_for_function(attr_name)
                if category:
                    # Yield as a 6-tuple with category included
                    yield attr_name, "DirectFunction", tool_instance, attr_name, tool_instance, category
                continue
            
            cls_name = getattr(tool_instance, "__class__", type(tool_instance)).__name__
            
            if cls_name not in self._class_to_category:
                continue
            
            for result in self._process_tool_instance(attr_name, tool_instance, cls_name):
                yield result
        
        # Special handling for xlwings property
        if hasattr(self._computer, 'xlwings'):
            try:
                xlwings_instance = self._computer.xlwings
                xlwings_cls_name = getattr(xlwings_instance, "__class__", 
                                          type(xlwings_instance)).__name__
                for result in self._process_tool_instance("xlwings", xlwings_instance, 
                                                         xlwings_cls_name):
                    yield result
                discovered_attrs.add("xlwings")
            except Exception:
                pass
        
        # Check for other properties not in __dict__
        for attr_name in dir(self._computer):
            if attr_name.startswith("_") or attr_name in discovered_attrs:
                continue
            try:
                tool_instance = getattr(self._computer, attr_name)
                
                # Handle direct callable functions
                if callable(tool_instance) and not isinstance(tool_instance, type):
                    category = self._infer_category_for_function(attr_name)
                    if category:
                        yield attr_name, "DirectFunction", tool_instance, attr_name, tool_instance, category
                        discovered_attrs.add(attr_name)
                    continue
                
                cls_name = getattr(tool_instance, "__class__", type(tool_instance)).__name__
                if cls_name not in self._class_to_category:
                    continue
                for result in self._process_tool_instance(attr_name, tool_instance, cls_name):
                    yield result
                discovered_attrs.add(attr_name)
            except Exception:
                continue
    
    def _infer_category_for_function(self, func_name: str) -> Optional[str]:
        """
        Infer category for a direct function by checking integrations_registry.yaml
        
        Maps function names to categories based on integration metadata
        """
        # Load registry to map function names to categories
        try:
            import yaml
            from pathlib import Path
            
            # Path from tool_engine.py: open-interpreter/interpreter/core/computer/tool_engine.py
            # Need to go up 5 levels to reach backend/, then into integrations/
            registry_path = Path(__file__).parent.parent.parent.parent.parent / "integrations" / "integrations_registry.yaml"
            if not registry_path.exists():
                logger.debug(f"Registry not found at {registry_path}, using fallback")
                return self._fallback_category_inference(func_name)
            
            with open(registry_path, 'r') as f:
                registry = yaml.safe_load(f)
            
            integrations = registry.get('integrations', {})
            
            # Check each integration's exports
            for integration_name, integration_data in integrations.items():
                layer2 = integration_data.get('layer2_exposure', {})
                exports = layer2.get('exports', [])
                
                if func_name in exports:
                    # Found it! Get the category from layer3_metadata
                    layer3 = integration_data.get('layer3_metadata', {})
                    category = layer3.get('category', '')
                    
                    # Map integration category names to tool category names
                    category_map = {
                        'web_search_extraction': 'Web Search & Extraction',
                        'document_processing_vision': 'Files & Documents',
                        'excel_automation_data_analysis': 'Excel Automation',
                        'system_operations': 'System & Terminal',
                        'browser_automation': 'Web Search & Extraction',
                        'mcp_tools': 'MCP Tools',
                    }
                    
                    return category_map.get(category, category.replace('_', ' ').title())
            
            # Not found in registry, use fallback
            return self._fallback_category_inference(func_name)
            
        except Exception as e:
            logger.debug(f"Category inference error for {func_name}: {e}")
            return self._fallback_category_inference(func_name)
    
    def _fallback_category_inference(self, func_name: str) -> Optional[str]:
        """Fallback category inference based on function name patterns"""
        name_lower = func_name.lower()
        
        if any(kw in name_lower for kw in ['search', 'web', 'perplexica', 'academic', 'reddit', 'wolfram']):
            return 'Web Search & Extraction'
        elif any(kw in name_lower for kw in ['docling', 'document', 'convert', 'parse', 'pdf']):
            return 'Files & Documents'
        elif any(kw in name_lower for kw in ['excel', 'xlwings', 'workbook', 'sheet']):
            return 'Excel Automation'
        elif any(kw in name_lower for kw in ['nb_', 'notebook', 'import', 'sys_path']):
            return 'System & Terminal'
        elif any(kw in name_lower for kw in ['omni', 'screenshot', 'vision', 'analyze']):
            return 'Vision'
        elif any(kw in name_lower for kw in ['mcp', 'server']):
            return 'MCP Tools'
        
        # Default: allow discovery but categorize as "Other"
        return 'Other'
    
    def _process_tool_instance(self, attr_name: str, tool_instance: Any, cls_name: str):
        """Process a tool instance to discover its methods"""
        for name in dir(tool_instance):
            if name.startswith("_"):
                continue
            try:
                attr = getattr(tool_instance, name)
            except Exception:
                continue
            
            if callable(attr):
                yield attr_name, cls_name, tool_instance, name, attr
    
    def _create_tool_metadata(
        self, 
        attr_name: str, 
        cls_name: str, 
        tool_instance: Any,
        method_name: str, 
        method: Callable, 
        category: str
    ) -> ToolMetadata:
        """Create comprehensive metadata for a tool method"""
        try:
            sig = str(inspect.signature(method))
            
            # Handle direct functions (attach_as: functions)
            if cls_name == "DirectFunction":
                # For direct functions, the path is just computer.function_name
                full_path = f"computer.{method_name}"
            else:
                # For class methods, the path is computer.class.method
                full_path = f"computer.{attr_name}.{method_name}"
            
            description = (getattr(method, "__doc__", None) or "").strip()
            
            # Extract parameters
            parameters = []
            try:
                sig_obj = inspect.signature(method)
                for param_name, param in sig_obj.parameters.items():
                    param_info = {
                        "name": param_name,
                        "type": str(param.annotation) if param.annotation != param.empty else "Any",
                        "default": str(param.default) if param.default != param.empty else None,
                        "required": param.default == param.empty
                    }
                    parameters.append(param_info)
            except:
                pass
            
            # Determine complexity
            param_count = len(parameters)
            if param_count <= 2:
                complexity = ToolComplexity.SIMPLE
            elif param_count <= 5:
                complexity = ToolComplexity.MODERATE
            else:
                complexity = ToolComplexity.ADVANCED
            
            # Generate use cases and tags
            use_cases = self._generate_use_cases(method_name, description, category)
            tags = self._generate_tags(method_name, description, category)
            
            return ToolMetadata(
                name=method_name,
                category=category,
                subcategory=self._determine_subcategory(method_name, category),
                description=description,
                complexity=complexity,
                parameters=parameters,
                use_cases=use_cases,
                tags=tags,
                signature=sig,
                full_path=full_path
            )
        except Exception as e:
            return ToolMetadata(
                name=method_name,
                category=category,
                description=f"Tool method (metadata error: {e})",
                full_path=f"computer.{cls_name.lower()}.{method_name}"
            )
    
    def _determine_subcategory(self, method_name: str, category: str) -> Optional[str]:
        """Determine subcategory based on method name"""
        subcategory_map = {
            "Web Search & Extraction": {
                "fast_search": "Basic Search",
                "search": "Deep Research",
                "query": "Basic Search",
                "answer": "Deep Research",
                "extract": "Content Extraction",
            },
            "Files & Documents": {
                "read": "File Operations",
                "write": "File Operations",
                "create": "File Operations",
                "process": "Document Processing",
                "parse": "Content Analysis"
            },
            "GUI & System Control": {
                "click": "Mouse Control",
                "move": "Mouse Control",
                "type": "Keyboard Input",
                "key": "Keyboard Input",
                "screenshot": "Display Management",
            }
        }
        
        if category in subcategory_map:
            for keyword, subcat in subcategory_map[category].items():
                if keyword in method_name.lower():
                    return subcat
        
        return None
    
    def _generate_use_cases(self, method_name: str, description: str, category: str) -> List[str]:
        """Generate use cases based on method characteristics"""
        use_cases = []
        
        name_patterns = {
            "search": ["Finding information", "Data discovery"],
            "create": ["Content generation", "Resource creation"],
            "read": ["Data retrieval", "Content access"],
            "write": ["Data storage", "Content creation"],
            "click": ["UI automation", "Element interaction"],
            "send": ["Data transmission", "Message delivery"],
            "get": ["Information retrieval", "Data fetching"]
        }
        
        for pattern, cases in name_patterns.items():
            if pattern in method_name.lower():
                use_cases.extend(cases)
                break
        
        return use_cases[:3]
    
    def _generate_tags(self, method_name: str, description: str, category: str) -> Set[str]:
        """Generate relevant tags for the tool"""
        tags = set()
        
        category_tags = {
            "Web Search & Extraction": {"web", "search", "internet", "data"},
            "Files & Documents": {"files", "documents", "storage"},
            "GUI & System Control": {"gui", "system", "automation"},
            "Vision": {"vision", "image", "visual", "analysis"},
            "MCP Tools": {"mcp", "external", "integration"}
        }
        
        if category in category_tags:
            tags.update(category_tags[category])
        
        name_words = method_name.lower().replace("_", " ").split()
        tags.update(name_words)
        
        return tags
    
    def _enrich_from_tools_registry(self):
        """
        Enrich auto-discovered tool metadata with definitions from YAML registries.
        
        Loads BOTH:
        - tools_registry.yaml (OI built-in tools)
        - backend_tools_registry.yaml (Aether backend tools)
        
        This merges YAML-defined metadata with runtime-discovered tools to provide
        comprehensive tool information including examples, use cases, and detailed descriptions.
        """
        try:
            # Load combined registry (OI + Backend tools)
            from .tools_loader import load_tool_registry
            
            registry = load_tool_registry()
            
            # Extract tool definitions from categories
            categories = registry.get('categories', {})
            yaml_tools = {}
            
            for cat_name, cat_data in categories.items():
                tools_list = cat_data.get('tools', [])
                for tool_def in tools_list:
                    if isinstance(tool_def, dict):
                        tool_path = tool_def.get('path', '')
                        if tool_path:
                            yaml_tools[tool_path] = tool_def
            
            # Enrich discovered tools with YAML metadata
            enriched_count = 0
            for tool_path, tool_meta in self._tool_cache.items():
                if tool_path in yaml_tools:
                    yaml_def = yaml_tools[tool_path]
                    
                    # Enrich description if YAML has better one
                    yaml_desc = yaml_def.get('description', '')
                    if yaml_desc and len(yaml_desc) > len(tool_meta.description):
                        tool_meta.description = yaml_desc
                    
                    # Enrich use cases
                    yaml_use_cases = yaml_def.get('use_cases', [])
                    if yaml_use_cases:
                        tool_meta.use_cases = yaml_use_cases
                    
                    # Enrich examples
                    yaml_examples = yaml_def.get('examples', [])
                    if yaml_examples:
                        tool_meta.examples = yaml_examples
                    
                    # Enrich tags
                    yaml_tags = yaml_def.get('tags', [])
                    if yaml_tags:
                        tool_meta.tags.update(yaml_tags)
                    
                    # Enrich complexity
                    yaml_complexity = yaml_def.get('complexity', '')
                    if yaml_complexity:
                        from .tool_metadata import ToolComplexity
                        try:
                            tool_meta.complexity = ToolComplexity(yaml_complexity)
                        except ValueError:
                            pass
                    
                    enriched_count += 1
            
            logger.info(f"Enriched {enriched_count}/{len(self._tool_cache)} tools from combined registries")
            
        except Exception as e:
            logger.warning(f"Failed to enrich from registries: {e}")
    
    # ========================================================================
    # SEMANTIC INDEXING
    # ========================================================================
    
    async def _get_embedding_async(self, text: str) -> Optional[np.ndarray]:
        """Get embedding for text via LM Studio"""
        try:
            if text in self._embeddings_cache:
                return self._embeddings_cache[text]
            
            if self._http_client is None:
                self._http_client = httpx.AsyncClient(timeout=30.0)
            
            payload = {
                "input": text,
                "model": self._embedding_model,
                "encoding_format": "float"
            }
            
            response = await self._http_client.post(
                f"{self._lm_studio_url}/embeddings",
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            
            if response.status_code == 200:
                data = response.json()
                embedding = np.array(data["data"][0]["embedding"])
                self._embeddings_cache[text] = embedding
                return embedding
            
            return None
        except Exception as e:
            logger.debug(f"Embedding generation failed: {e}")
            return None
    
    def _get_embedding_sync(self, text: str) -> Optional[np.ndarray]:
        """Synchronous wrapper for embedding generation"""
        try:
            loop = asyncio.get_running_loop()
            
            def run_in_thread():
                try:
                    new_loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(new_loop)
                    return new_loop.run_until_complete(self._get_embedding_async(text))
                finally:
                    try:
                        new_loop.close()
                    except:
                        pass
            
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(run_in_thread)
                return future.result(timeout=30)
        
        except RuntimeError:
            return asyncio.run(self._get_embedding_async(text))
        except Exception:
            return None
    
    def _compute_index_hash(self, tool_texts: Dict[str, str]) -> str:
        """Compute hash of tool texts for change detection"""
        combined = "|".join(f"{k}:{v}" for k, v in sorted(tool_texts.items()))
        return hashlib.sha256(combined.encode()).hexdigest()
    
    def _load_index(self) -> bool:
        """Load index from disk if valid"""
        try:
            if not self.index_info_file.exists():
                return False
            
            with open(self.index_info_file) as f:
                info = json.load(f)
            
            # Check age (24 hour expiry)
            indexed_at = datetime.fromisoformat(info['indexed_at'])
            age_hours = (datetime.now() - indexed_at).total_seconds() / 3600
            if age_hours > 24:
                logger.info("Index expired, will rebuild")
                return False
            
            if not self.embeddings_file.exists():
                return False
            
            with open(self.embeddings_file, 'rb') as f:
                data = pickle.load(f)
            
            self._tool_embeddings = data['embeddings']
            self._tool_texts = data['texts']
            self._index_hash = info['hash']
            
            logger.info(f"Loaded index with {len(self._tool_embeddings)} tools")
            return True
        except Exception as e:
            logger.warning(f"Failed to load index: {e}")
            return False
    
    def _save_index(self):
        """Save index to disk"""
        try:
            data = {
                'embeddings': self._tool_embeddings,
                'texts': self._tool_texts
            }
            with open(self.embeddings_file, 'wb') as f:
                pickle.dump(data, f)
            
            info = {
                'indexed_at': datetime.now().isoformat(),
                'hash': self._index_hash,
                'tool_count': len(self._tool_embeddings),
                'embedding_dim': len(next(iter(self._tool_embeddings.values()))) if self._tool_embeddings else 0
            }
            with open(self.index_info_file, 'w') as f:
                json.dump(info, f, indent=2)
            
            logger.info(f"Saved index with {len(self._tool_embeddings)} tools")
        except Exception as e:
            logger.error(f"Failed to save index: {e}")
    
    def _index_tools(self, tool_texts: Dict[str, str], force: bool = False):
        """Index tools with semantic embeddings"""
        new_hash = self._compute_index_hash(tool_texts)
        
        if not force and self._indexed and new_hash == self._index_hash:
            logger.info("Index current, skipping")
            return
        
        if not force and self._load_index():
            if new_hash == self._index_hash:
                self._indexed = True
                return
        
        logger.info(f"Indexing {len(tool_texts)} tools...")
        
        self._tool_texts = tool_texts
        self._tool_embeddings.clear()
        
        try:
            async def index_all():
                tasks = [self._get_embedding_async(text) for text in tool_texts.values()]
                return await asyncio.gather(*tasks)
            
            try:
                loop = asyncio.get_running_loop()
                
                def run_in_thread():
                    new_loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(new_loop)
                    try:
                        return new_loop.run_until_complete(index_all())
                    finally:
                        try:
                            new_loop.close()
                        except:
                            pass
                
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(run_in_thread)
                    embeddings = future.result(timeout=120)
            
            except RuntimeError:
                embeddings = asyncio.run(index_all())
            
            for tool_path, embedding in zip(tool_texts.keys(), embeddings):
                if embedding is not None:
                    self._tool_embeddings[tool_path] = embedding
            
            self._index_hash = new_hash
            self._indexed = True
            self._save_index()
            
            logger.info(f"Indexed {len(self._tool_embeddings)} tools")
        except Exception as e:
            logger.error(f"Indexing failed: {e}")
            self._indexed = True
    
    def register_dynamic_tools(self, tools: List[ToolMetadata]):
        """Register dynamically discovered tools (e.g., from MCP servers)"""
        if not tools:
            return
        
        logger.info(f"Registering {len(tools)} dynamic tools...")
        
        for tool_meta in tools:
            self._tool_cache[tool_meta.full_path] = tool_meta
            
            if tool_meta.category in self._category_cache:
                self._category_cache[tool_meta.category].tool_count += 1
        
        # Generate texts for semantic indexing
        tool_texts = {}
        for tool_meta in tools:
            text_parts = [
                f"Name: {tool_meta.name}",
                f"Category: {tool_meta.category}",
                f"Description: {tool_meta.description}",
                f"Use cases: {'; '.join(tool_meta.use_cases)}",
                f"Tags: {', '.join(tool_meta.tags)}",
            ]
            
            if tool_meta.subcategory:
                text_parts.insert(2, f"Subcategory: {tool_meta.subcategory}")
            
            tool_texts[tool_meta.full_path] = ". ".join(text_parts)
        
        # Update index
        try:
            all_tool_texts = {**self._tool_texts, **tool_texts}
            self._index_tools(all_tool_texts, force=True)
            logger.info(f"✅ Registered and indexed {len(tools)} dynamic tools")
        except Exception as e:
            logger.error(f"Failed to index dynamic tools: {e}")
    
    # ========================================================================
    # SEARCH
    # ========================================================================
    
    def search(self, query: str, categories: Optional[List[str]] = None, top_k: int = 15) -> List[Dict[str, Any]]:
        """
        Smart search - hybrid semantic + keyword with fallback.
        
        Args:
            query: Search query
            categories: Optional category filter
            top_k: Number of results
        
        Returns:
            List of tool dictionaries
        """
        self._ensure_initialized()
        
        # Try hybrid search
        results = self._hybrid_search(query, top_k * 2)
        
        # If no results, try pure keyword
        if not results:
            results = self._keyword_search(query, top_k * 2)
        
        # Filter by categories if specified
        tools = []
        for result in results:
            tool_meta = self._tool_cache.get(result.tool_path)
            if not tool_meta:
                continue
            
            if categories and tool_meta.category not in categories:
                continue
            
            tools.append(tool_meta.to_dict())
        
        return tools[:top_k]
    
    def _hybrid_search(self, query: str, top_k: int) -> List[SearchResult]:
        """Hybrid search combining semantic and keyword"""
        semantic_results = self._semantic_search(query, top_k)
        keyword_results = self._keyword_search(query, top_k)
        
        semantic_scores = {r.tool_path: r.score for r in semantic_results}
        keyword_scores = {r.tool_path: r.score for r in keyword_results}
        
        all_paths = set(semantic_scores.keys()) | set(keyword_scores.keys())
        combined = []
        
        for path in all_paths:
            sem_score = semantic_scores.get(path, 0.0)
            kw_score = keyword_scores.get(path, 0.0)
            final_score = 0.7 * sem_score + 0.3 * kw_score
            
            combined.append(SearchResult(
                tool_path=path,
                score=final_score,
                match_type='hybrid'
            ))
        
        combined.sort(key=lambda r: r.score, reverse=True)
        return combined[:top_k]
    
    def _semantic_search(self, query: str, top_k: int) -> List[SearchResult]:
        """Semantic search using embeddings"""
        if not self._indexed or not self._tool_embeddings:
            return []
        
        try:
            query_embedding = self._get_embedding_sync(query)
            if query_embedding is None:
                return []
            
            results = []
            for tool_path, tool_embedding in self._tool_embeddings.items():
                similarity = cosine_similarity(
                    query_embedding.reshape(1, -1),
                    tool_embedding.reshape(1, -1)
                )[0][0]
                
                if similarity >= 0.0:
                    results.append(SearchResult(
                        tool_path=tool_path,
                        score=float(similarity),
                        match_type='semantic'
                    ))
            
            results.sort(key=lambda r: r.score, reverse=True)
            return results[:top_k]
        except Exception as e:
            logger.error(f"Semantic search failed: {e}")
            return []
    
    def _keyword_search(self, query: str, top_k: int) -> List[SearchResult]:
        """Keyword-based fallback search"""
        query_lower = query.lower()
        query_tokens = set(query_lower.replace('-', ' ').replace('_', ' ').split())
        
        results = []
        for tool_path, tool_text in self._tool_texts.items():
            text_lower = tool_text.lower()
            text_tokens = set(text_lower.split())
            
            overlap = len(query_tokens.intersection(text_tokens))
            token_score = overlap / max(len(query_tokens), 1)
            substring_score = 0.5 if query_lower in text_lower else 0
            score = min(token_score + substring_score, 1.0)
            
            if score > 0:
                results.append(SearchResult(
                    tool_path=tool_path,
                    score=score,
                    match_type='keyword'
                ))
        
        results.sort(key=lambda r: r.score, reverse=True)
        return results[:top_k]
    
    # ========================================================================
    # CATALOG QUERIES
    # ========================================================================
    
    def get_categories(self) -> List[Dict[str, Any]]:
        """Get all available tool categories"""
        self._ensure_initialized()
        
        categories = []
        for cat_name, cat_obj in self._category_cache.items():
            categories.append({
                "name": cat_name,
                "description": cat_obj.description,
                "subcategories": cat_obj.subcategories,
                "tool_count": cat_obj.tool_count,
                "complexity_distribution": cat_obj.complexity_distribution,
                "common_use_cases": cat_obj.common_use_cases
            })
        
        return sorted(categories, key=lambda x: x["name"])
    
    def list_tools_by_category(
        self, 
        category: Optional[str] = None,
        complexity: Optional[str] = None,
        subcategory: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """List tools in a specific category with optional filtering"""
        self._ensure_initialized()
        
        if category is None:
            return self.get_categories()
        
        # Normalize category name for case-insensitive matching
        category_lower = category.lower()
        
        tools = []
        for tool_path, tool_meta in self._tool_cache.items():
            # Case-insensitive category matching
            if tool_meta.category.lower() != category_lower:
                continue
            
            if complexity and tool_meta.complexity.value != complexity:
                continue
            
            if subcategory and tool_meta.subcategory != subcategory:
                continue
            
            tools.append({
                "name": tool_meta.name,
                "path": tool_meta.full_path,
                "description": tool_meta.description[:100] + "..." if len(tool_meta.description) > 100 else tool_meta.description,
                "complexity": tool_meta.complexity.value,
                "subcategory": tool_meta.subcategory,
                "signature": tool_meta.signature,
                "use_cases": tool_meta.use_cases[:2]
            })
        
        return sorted(tools, key=lambda x: (x["complexity"], x["name"]))
    
    def get_tool_info(self, tool_path: str) -> Dict[str, Any]:
        """Get detailed information about a specific tool"""
        self._ensure_initialized()
        
        if tool_path in self._tool_cache:
            self._loaded_tools.add(tool_path)
            return self._tool_cache[tool_path].to_dict()
        else:
            return {"error": f"Tool not found: {tool_path}"}
    
    def recommend_tools_for_task(self, task_description: str) -> List[Dict[str, Any]]:
        """Recommend tools based on task description"""
        self._ensure_initialized()
        
        try:
            results = self._hybrid_search(task_description, 10)
            
            recommendations = []
            for result in results:
                tool_meta = self._tool_cache.get(result.tool_path)
                if tool_meta:
                    tool_dict = tool_meta.to_dict()
                    tool_dict['relevance_reason'] = f"Match score: {result.score:.2f}"
                    recommendations.append(tool_dict)
            
            return recommendations
        except Exception as e:
            logger.error(f"Recommendation failed: {e}")
            return []
    
    def get_category_summary(self, category: str) -> Dict[str, Any]:
        """Get detailed summary of a specific category"""
        self._ensure_initialized()
        
        if category not in self._category_cache:
            return {"error": f"Category not found: {category}"}
        
        cat_obj = self._category_cache[category]
        tools = self.list_tools_by_category(category)
        
        return {
            "name": category,
            "description": cat_obj.description,
            "subcategories": cat_obj.subcategories,
            "tool_count": cat_obj.tool_count,
            "complexity_distribution": cat_obj.complexity_distribution,
            "common_use_cases": cat_obj.common_use_cases,
            "sample_tools": tools[:5]
        }
    
    def export_catalog(self) -> Dict[str, Any]:
        """Export complete catalog"""
        self._ensure_initialized()
        
        return {
            "categories": self.get_categories(),
            "tools": {path: meta.to_dict() for path, meta in self._tool_cache.items()},
            "metadata": {
                "total_tools": len(self._tool_cache),
                "total_categories": len(self._category_cache)
            }
        }
    
    # ========================================================================
    # OUTPUT FORMATTING
    # ========================================================================
    
    def format_search_results(self, query: str, results: List[Dict[str, Any]], categories: Optional[List[str]] = None) -> str:
        """Format search results for display"""
        if not results:
            return self._format_no_results(query, categories)
        
        if self._output_format == "html":
            return self._format_search_html(query, results, categories)
        else:
            return self._format_search_markdown(query, results, categories)
    
    def _format_search_html(self, query: str, results: List[Dict[str, Any]], categories: Optional[List[str]] = None) -> str:
        """Format search results as HTML"""
        esc_query = html.escape(str(query))
        
        category_badges = ''
        if categories:
            safe_cats = [html.escape(str(c)) for c in categories]
            category_badges = (
                '<div style="margin:6px 0 10px 0; font-size:12.5px; color:#bcd;">'
                + 'Searched in: '
                + ', '.join(
                    f'<span style="border:1px solid rgba(0,212,255,0.25); padding:2px 6px; border-radius:6px; background:rgba(0,212,255,0.06);">{c}</span>'
                    for c in safe_cats
                )
                + '</div>'
            )
        
        cards = []
        for i, result in enumerate(results[:5], 1):
            name = html.escape(result.get('name', 'Unknown'))
            path = html.escape(result.get('full_path', 'unknown.path'))
            category = html.escape(result.get('category', 'Other'))
            desc = result.get('description', '') or ''
            desc_trim = (desc[:60] + '...') if len(desc) > 60 else desc
            desc_safe = html.escape(desc_trim)
            
            card = [
                '<div class="tool-card">',
                f'<div class="tool-title"><strong>{i}. {name}</strong></div>',
                f'<span class="tool-path">📍 <code style="background:none">{path}</code></span>',
                f'<div class="tool-category">📂 {category}</div>',
            ]
            
            if desc_safe:
                card.append(f'<div class="tool-description">💡 {desc_safe}</div>')
            
            card.append('</div>')
            cards.append('\n'.join(card))
        
        first_path = html.escape(results[0].get('full_path', 'computer.module.method'))
        
        quick_actions = [
            '<div class="quick-actions">',
            '🚀 <strong>Quick Actions:</strong>',
            f'<div>• <strong>Execute</strong>: <code>{first_path}(parameters)</code></div>',
            f'<div>• <strong>Details</strong>: <code>computer.tools.get_info("{first_path}")</code></div>',
            '</div>'
        ]
        
        html_output = [
            f'<div class="semantic-search-header">🔍 Search Results: <code>{esc_query}</code></div>',
            category_badges,
            *cards,
            '\n'.join(quick_actions)
        ]
        
        return '\n'.join([part for part in html_output if part])
    
    def _format_search_markdown(self, query: str, results: List[Dict[str, Any]], categories: Optional[List[str]] = None) -> str:
        """Format search results as markdown"""
        output = [f"# 🔍 Search Results: {query}\n"]
        
        if categories:
            output.append(f"**Searched in:** {', '.join(categories)}\n")
        
        for i, result in enumerate(results[:5], 1):
            name = result.get('name', 'Unknown')
            path = result.get('full_path', 'unknown.path')
            category = result.get('category', 'Other')
            desc = result.get('description', '')
            
            output.append(f"## {i}. {name}")
            output.append(f"**Path:** `{path}`")
            output.append(f"**Category:** {category}")
            
            if desc:
                desc_trim = (desc[:100] + '...') if len(desc) > 100 else desc
                output.append(f"**Description:** {desc_trim}")
            
            output.append("")
        
        return "\n".join(output)
    
    def _format_no_results(self, query: str, categories: Optional[List[str]] = None) -> str:
        """Format no results message"""
        return f"""# 🤔 No Results for: {query}

**Suggestions:**
- Try different wording
- Use broader terms
- Browse categories: `computer.tools.list_categories()`
- Get recommendations: `computer.tools.recommend("your task")`"""
    
    # ========================================================================
    # UTILITIES
    # ========================================================================
    
    def get_usage_stats(self) -> str:
        """Get statistics about tool usage"""
        output = ["# Tool Usage Statistics\n"]
        
        output.append(f"**Total Categories:** {len(self._category_cache)}")
        output.append(f"**Total Tools:** {len(self._tool_cache)}")
        output.append(f"**Categories Explored:** {len(self._loaded_categories)}")
        output.append(f"**Tools Inspected:** {len(self._loaded_tools)}")
        
        return "\n".join(output)
    
    def rebuild_index(self, force: bool = True):
        """Rebuild the semantic index"""
        try:
            self._ensure_initialized()
            
            tool_texts = {}
            for tool_path, meta in self._tool_cache.items():
                text_parts = [
                    f"Name: {meta.name}",
                    f"Category: {meta.category}",
                    f"Description: {meta.description}",
                    f"Use cases: {'; '.join(meta.use_cases)}",
                ]
                tool_texts[tool_path] = ". ".join(text_parts)
            
            self._index_tools(tool_texts, force=force)
            logger.info(f"Rebuilt index for {len(self._tool_cache)} tools")
        except Exception as e:
            logger.error(f"Failed to rebuild index: {e}")
    
    async def cleanup(self):
        """Cleanup resources"""
        if self._http_client:
            try:
                await self._http_client.aclose()
            except:
                pass

