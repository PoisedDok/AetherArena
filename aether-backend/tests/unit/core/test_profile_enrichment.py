"""
Tests for core.profiles.enrichment — ProfileEnricher

Strategy:
- Mock filesystem for _load_tool_registry (YAML path resolution).
- Use real registry data structures to test generation/formatting logic.
- Minimal mocking: interpreter/computer are simple attribute containers.
- Deep assertions on output shape, content, and edge cases.
"""

import logging
from unittest.mock import MagicMock, patch

import pytest

from core.profiles.enrichment import ProfileEnricher


# ---------------------------------------------------------------------------
# Fixtures / Helpers
# ---------------------------------------------------------------------------

def _make_interpreter():
    """Create a minimal mock interpreter with computer attribute."""
    interp = MagicMock()
    interp.computer = MagicMock()
    interp.system_message = "original"
    return interp


def _sample_registry(core_tools=2, integration_tools=3, extra_categories=None):
    """
    Build a realistic tool registry dict.

    Categories with 'artifact', 'chat', 'trail', or 'memory' in the name
    are classified as core by the enricher; everything else is integration.
    """
    registry = {"categories": {}}

    # Core category (keyword: "artifact")
    if core_tools > 0:
        registry["categories"]["artifact_storage"] = {
            "description": "Artifact management tools",
            "tools": [
                {
                    "name": f"artifact_tool_{i}",
                    "path": f"computer.artifact_tool_{i}",
                    "description": f"Artifact tool {i} description",
                }
                for i in range(core_tools)
            ],
        }

    # Integration category (no keywords)
    if integration_tools > 0:
        registry["categories"]["web_search"] = {
            "description": "Web search tools",
            "tools": [
                {
                    "name": f"search_tool_{i}",
                    "path": f"computer.search_tool_{i}",
                    "description": f"Search tool {i} description",
                }
                for i in range(integration_tools)
            ],
        }

    if extra_categories:
        registry["categories"].update(extra_categories)

    return registry


def _create_enricher(registry_data=None, registry_loaded=True):
    """Create a ProfileEnricher with controlled registry state."""
    interp = _make_interpreter()
    with patch.object(ProfileEnricher, "_load_tool_registry"):
        enricher = ProfileEnricher(interp)

    if registry_data is not None:
        enricher._registry_data = registry_data
        enricher._registry_loaded = registry_loaded
    else:
        enricher._registry_data = None
        enricher._registry_loaded = False

    return enricher


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:
    def test_sets_interpreter_and_computer(self):
        interp = _make_interpreter()
        with patch.object(ProfileEnricher, "_load_tool_registry"):
            enricher = ProfileEnricher(interp)
        assert enricher.interpreter is interp
        assert enricher.computer is interp.computer

    def test_initializes_registry_fields(self):
        interp = _make_interpreter()
        with patch.object(ProfileEnricher, "_load_tool_registry"):
            enricher = ProfileEnricher(interp)
        assert enricher._registry_data is None
        assert enricher._registry_loaded is False

    def test_calls_load_tool_registry(self):
        interp = _make_interpreter()
        with patch.object(ProfileEnricher, "_load_tool_registry") as mock_load:
            ProfileEnricher(interp)
        mock_load.assert_called_once()


# ===========================================================================
# _load_tool_registry
# ===========================================================================

class TestLoadToolRegistry:
    def test_success(self, tmp_path):
        """Registry loads from YAML and sets metadata."""
        registry_file = tmp_path / "config" / "backend_tools_registry.yaml"
        registry_file.parent.mkdir(parents=True)
        registry_file.write_text(
            "categories:\n"
            "  test_cat:\n"
            "    description: Test\n"
            "    tools:\n"
            "      - name: tool1\n"
            "        path: computer.tool1\n"
            "        description: A tool\n"
        )

        interp = _make_interpreter()
        # Patch Path(__file__).parent.parent.parent to point to tmp_path
        # enrichment.py: current_dir.parent.parent / "config" / "backend_tools_registry.yaml"
        # current_dir = Path(__file__).parent = core/profiles/
        # parent.parent = project root
        fake_enrichment_dir = tmp_path / "core" / "profiles"
        fake_enrichment_dir.mkdir(parents=True)

        with patch("core.profiles.enrichment.__file__", str(fake_enrichment_dir / "enrichment.py")):
            enricher = ProfileEnricher(interp)

        assert enricher._registry_loaded is True
        assert enricher._registry_data is not None
        assert "categories" in enricher._registry_data
        assert len(enricher._registry_data["categories"]["test_cat"]["tools"]) == 1

    def test_file_not_found(self, tmp_path, caplog):
        """Non-existent registry logs warning and leaves unloaded."""
        fake_dir = tmp_path / "core" / "profiles"
        fake_dir.mkdir(parents=True)
        # No config directory created — registry won't exist

        interp = _make_interpreter()
        with patch("core.profiles.enrichment.__file__", str(fake_dir / "enrichment.py")):
            with caplog.at_level(logging.WARNING):
                enricher = ProfileEnricher(interp)

        assert enricher._registry_loaded is False
        assert enricher._registry_data is None
        assert "Tool registry not found" in caplog.text

    def test_yaml_parse_error(self, tmp_path, caplog):
        """Malformed YAML logs error and sets loaded=False."""
        registry_file = tmp_path / "config" / "backend_tools_registry.yaml"
        registry_file.parent.mkdir(parents=True)
        registry_file.write_text(":\n  bad: [\n")

        fake_dir = tmp_path / "core" / "profiles"
        fake_dir.mkdir(parents=True)

        interp = _make_interpreter()
        with patch("core.profiles.enrichment.__file__", str(fake_dir / "enrichment.py")):
            with caplog.at_level(logging.ERROR):
                enricher = ProfileEnricher(interp)

        assert enricher._registry_loaded is False
        assert "Failed to load tool registry" in caplog.text


# ===========================================================================
# enrich_profile_prompt
# ===========================================================================

class TestEnrichProfilePrompt:
    def test_none_strategy_returns_original(self):
        enricher = _create_enricher(_sample_registry())
        result = enricher.enrich_profile_prompt("hello", strategy="none")
        assert result == "hello"

    def test_registry_not_loaded_returns_original(self, caplog):
        enricher = _create_enricher(registry_loaded=False)
        with caplog.at_level(logging.DEBUG):
            result = enricher.enrich_profile_prompt("hello", strategy="capabilities")
        assert result == "hello"
        assert "Tool registry not loaded" in caplog.text

    def test_capabilities_strategy_includes_overview_and_discovery(self):
        enricher = _create_enricher(_sample_registry())
        result = enricher.enrich_profile_prompt("hello", strategy="capabilities")
        assert "hello" in result
        assert "Tool Capabilities" in result
        assert "Tool Discovery Workflow" in result
        # Sections joined by separator
        assert "---" in result

    def test_minimal_strategy_includes_only_discovery(self):
        enricher = _create_enricher(_sample_registry())
        result = enricher.enrich_profile_prompt("hello", strategy="minimal")
        assert "hello" in result
        assert "Tool Discovery Workflow" in result
        # Should NOT include capabilities overview
        assert "Tool Capabilities" not in result

    def test_unknown_strategy_returns_original(self, caplog):
        enricher = _create_enricher(_sample_registry())
        with caplog.at_level(logging.WARNING):
            result = enricher.enrich_profile_prompt("hello", strategy="unknown_xyz")
        assert result == "hello"
        assert "Unknown enrichment strategy" in caplog.text

    def test_exception_in_generation_returns_original(self, caplog):
        enricher = _create_enricher(_sample_registry())
        with patch.object(enricher, "_generate_capabilities_overview", side_effect=RuntimeError("boom")):
            with caplog.at_level(logging.ERROR):
                result = enricher.enrich_profile_prompt("hello", strategy="capabilities")
        assert result == "hello"
        assert "Failed to enrich profile prompt" in caplog.text

    def test_preserves_original_prompt_content(self):
        """Original prompt appears as the first section, unmodified."""
        enricher = _create_enricher(_sample_registry())
        original = "You are a helpful agent.\nDo great things."
        result = enricher.enrich_profile_prompt(original, strategy="capabilities")
        sections = result.split("\n\n---\n\n")
        assert sections[0] == original


# ===========================================================================
# inject_profile_tools
# ===========================================================================

class TestInjectProfileTools:
    def test_updates_interpreter_system_message(self):
        enricher = _create_enricher(_sample_registry())
        enricher.interpreter.system_message = "original prompt"
        enricher.inject_profile_tools("GURU", enrichment_strategy="capabilities")
        # System message should now be enriched
        new_msg = enricher.interpreter.system_message
        assert "original prompt" in new_msg
        assert "Tool Capabilities" in new_msg

    def test_exception_propagates(self):
        enricher = _create_enricher(_sample_registry())
        enricher.interpreter.system_message = None  # Will cause issues
        with patch.object(enricher, "enrich_profile_prompt", side_effect=TypeError("nope")):
            with pytest.raises(TypeError, match="nope"):
                enricher.inject_profile_tools("GURU")

    def test_logs_profile_and_strategy(self, caplog):
        enricher = _create_enricher(_sample_registry())
        enricher.interpreter.system_message = "msg"
        with caplog.at_level(logging.INFO):
            enricher.inject_profile_tools("TestProfile", enrichment_strategy="minimal")
        assert "TestProfile" in caplog.text
        assert "minimal" in caplog.text


# ===========================================================================
# _generate_capabilities_overview
# ===========================================================================

class TestGenerateCapabilitiesOverview:
    def test_not_loaded_returns_empty(self):
        enricher = _create_enricher(registry_loaded=False)
        assert enricher._generate_capabilities_overview() == ""

    def test_loaded_but_none_data_returns_empty(self):
        enricher = _create_enricher()
        enricher._registry_loaded = True
        enricher._registry_data = None
        assert enricher._generate_capabilities_overview() == ""

    def test_contains_core_and_integration_sections(self):
        enricher = _create_enricher(_sample_registry(core_tools=2, integration_tools=3))
        result = enricher._generate_capabilities_overview()
        assert "Core Capabilities" in result
        assert "Integration Tools" in result

    def test_core_only(self):
        enricher = _create_enricher(_sample_registry(core_tools=2, integration_tools=0))
        result = enricher._generate_capabilities_overview()
        assert "Core Capabilities" in result
        assert "Integration Tools" not in result

    def test_integration_only(self):
        enricher = _create_enricher(_sample_registry(core_tools=0, integration_tools=3))
        result = enricher._generate_capabilities_overview()
        assert "Core Capabilities" not in result
        assert "Integration Tools" in result

    def test_empty_categories(self):
        registry = {"categories": {}}
        enricher = _create_enricher(registry)
        result = enricher._generate_capabilities_overview()
        assert "Total: 0 categories, 0 tools available" in result

    def test_skips_empty_tool_categories(self):
        """Categories with 0 tools are not rendered."""
        registry = {"categories": {
            "empty_cat": {"description": "Empty", "tools": []},
            "web_search": {
                "description": "Search",
                "tools": [{"name": "t1", "path": "computer.t1", "description": "d"}],
            },
        }}
        enricher = _create_enricher(registry)
        result = enricher._generate_capabilities_overview()
        assert "empty_cat" not in result
        assert "web_search" in result

    def test_summary_counts_all_tools(self):
        enricher = _create_enricher(_sample_registry(core_tools=3, integration_tools=5))
        result = enricher._generate_capabilities_overview()
        assert "2 categories, 8 tools available" in result

    def test_tool_paths_in_output(self):
        enricher = _create_enricher(_sample_registry(core_tools=1, integration_tools=1))
        result = enricher._generate_capabilities_overview()
        assert "`computer.artifact_tool_0`" in result
        assert "`computer.search_tool_0`" in result

    def test_exception_returns_empty(self, caplog):
        enricher = _create_enricher(_sample_registry())
        # Break registry_data to cause an exception
        enricher._registry_data = "not a dict"
        with caplog.at_level(logging.WARNING):
            result = enricher._generate_capabilities_overview()
        assert result == ""
        assert "Failed to generate capabilities overview" in caplog.text

    def test_core_keyword_detection(self):
        """Categories with 'chat', 'trail', 'memory' in name are core."""
        registry = {"categories": {
            "chat_history": {
                "description": "Chat tools",
                "tools": [{"name": "t1", "path": "p1", "description": "d1"}],
            },
            "memory_store": {
                "description": "Memory tools",
                "tools": [{"name": "t2", "path": "p2", "description": "d2"}],
            },
            "trail_log": {
                "description": "Trail tools",
                "tools": [{"name": "t3", "path": "p3", "description": "d3"}],
            },
        }}
        enricher = _create_enricher(registry)
        result = enricher._generate_capabilities_overview()
        assert "Core Capabilities" in result
        # All three should be under core
        assert "chat_history" in result
        assert "memory_store" in result
        assert "trail_log" in result
        assert "Integration Tools" not in result


# ===========================================================================
# _format_category_tools
# ===========================================================================

class TestFormatCategoryTools:
    def test_basic_format(self):
        enricher = _create_enricher(_sample_registry())
        cat = {
            "name": "TestCat",
            "description": "Test category",
            "tool_count": 1,
            "tools": [{"name": "tool1", "path": "computer.tool1", "description": "A tool"}],
        }
        lines = enricher._format_category_tools(cat)
        text = "\n".join(lines)
        assert "### TestCat (1 tools)" in text
        assert "*Test category*" in text
        assert "`computer.tool1`" in text
        assert "A tool" in text

    def test_tool_without_path_uses_name(self):
        enricher = _create_enricher(_sample_registry())
        cat = {
            "name": "NP",
            "description": "No path",
            "tool_count": 1,
            "tools": [{"name": "bare_tool", "path": "", "description": "Bare"}],
        }
        lines = enricher._format_category_tools(cat)
        text = "\n".join(lines)
        assert "`bare_tool`" in text

    def test_truncates_long_descriptions(self):
        """Descriptions over 80 chars are truncated with '...'."""
        enricher = _create_enricher(_sample_registry())
        long_desc = "A" * 100  # 100 chars, well over 80
        cat = {
            "name": "Long",
            "description": "Long desc cat",
            "tool_count": 1,
            "tools": [{"name": "t", "path": "computer.t", "description": long_desc}],
        }
        lines = enricher._format_category_tools(cat)
        text = "\n".join(lines)
        # Truncated to 77 chars + "..."
        assert "..." in text
        assert "A" * 78 not in text  # Should be cut at 77

    def test_description_with_newlines_cleaned(self):
        enricher = _create_enricher(_sample_registry())
        cat = {
            "name": "NL",
            "description": "Newline test",
            "tool_count": 1,
            "tools": [{"name": "t", "path": "computer.t", "description": "line1\nline2\nline3"}],
        }
        lines = enricher._format_category_tools(cat)
        text = "\n".join(lines)
        assert "line1 line2 line3" in text

    def test_max_8_tools_shown(self):
        """Only first 8 tools are displayed; overflow shows 'and N more'."""
        enricher = _create_enricher(_sample_registry())
        tools = [
            {"name": f"tool_{i}", "path": f"computer.tool_{i}", "description": f"Tool {i}"}
            for i in range(12)
        ]
        cat = {
            "name": "Many",
            "description": "Many tools",
            "tool_count": 12,
            "tools": tools,
        }
        lines = enricher._format_category_tools(cat)
        text = "\n".join(lines)
        # First 8 should appear
        for i in range(8):
            assert f"tool_{i}" in text
        # Last 4 should NOT appear individually
        assert "tool_8" not in text
        assert "...and 4 more" in text

    def test_exactly_8_tools_no_overflow(self):
        enricher = _create_enricher(_sample_registry())
        tools = [
            {"name": f"t_{i}", "path": f"computer.t_{i}", "description": f"D {i}"}
            for i in range(8)
        ]
        cat = {
            "name": "Eight",
            "description": "Exact eight",
            "tool_count": 8,
            "tools": tools,
        }
        lines = enricher._format_category_tools(cat)
        text = "\n".join(lines)
        assert "...and" not in text

    def test_empty_description(self):
        """Tool with no description still formats correctly."""
        enricher = _create_enricher(_sample_registry())
        cat = {
            "name": "ED",
            "description": "Empty desc",
            "tool_count": 1,
            "tools": [{"name": "t", "path": "computer.t", "description": ""}],
        }
        lines = enricher._format_category_tools(cat)
        text = "\n".join(lines)
        assert "`computer.t`" in text

    def test_missing_tool_fields_use_defaults(self):
        """Missing name/path/description use defaults."""
        enricher = _create_enricher(_sample_registry())
        cat = {
            "name": "Missing",
            "description": "Missing fields",
            "tool_count": 1,
            "tools": [{}],
        }
        lines = enricher._format_category_tools(cat)
        text = "\n".join(lines)
        assert "`unknown`" in text  # Default name when path is empty


# ===========================================================================
# _generate_discovery_instructions
# ===========================================================================

class TestGenerateDiscoveryInstructions:
    def test_returns_nonempty_string(self):
        enricher = _create_enricher(_sample_registry())
        result = enricher._generate_discovery_instructions()
        assert isinstance(result, str)
        assert len(result) > 100

    def test_contains_key_sections(self):
        enricher = _create_enricher(_sample_registry())
        result = enricher._generate_discovery_instructions()
        assert "Tool Discovery Workflow" in result
        assert "Semantic Search" in result
        assert "Best Practices" in result
        assert "Artifact Management Workflow" in result

    def test_contains_code_examples(self):
        enricher = _create_enricher(_sample_registry())
        result = enricher._generate_discovery_instructions()
        assert "computer.tools.search(" in result
        assert "computer.tools.get_info(" in result
        assert "computer.tools.list_categories()" in result


# ===========================================================================
# get_profile_tool_summary
# ===========================================================================

class TestGetProfileToolSummary:
    def test_not_loaded_returns_minimal_dict(self):
        enricher = _create_enricher(registry_loaded=False)
        result = enricher.get_profile_tool_summary()
        assert result == {
            "registry_loaded": False,
            "category_count": 0,
            "total_tool_count": 0,
        }

    def test_loaded_but_none_data_returns_minimal(self):
        enricher = _create_enricher()
        enricher._registry_loaded = True
        enricher._registry_data = None
        result = enricher.get_profile_tool_summary()
        assert result["registry_loaded"] is False  # guard: not loaded OR not data

    def test_loaded_returns_full_summary(self):
        enricher = _create_enricher(_sample_registry(core_tools=2, integration_tools=3))
        result = enricher.get_profile_tool_summary()
        assert result["registry_loaded"] is True
        assert result["category_count"] == 2
        assert result["total_tool_count"] == 5
        assert len(result["categories"]) == 2
        assert isinstance(result["discovery_methods"], list)
        assert len(result["discovery_methods"]) == 5

    def test_category_summary_shape(self):
        enricher = _create_enricher(_sample_registry(core_tools=1, integration_tools=2))
        result = enricher.get_profile_tool_summary()
        for cat in result["categories"]:
            assert "name" in cat
            assert "description" in cat
            assert "tool_count" in cat
            assert isinstance(cat["tool_count"], int)

    def test_exception_returns_error_dict(self, caplog):
        enricher = _create_enricher()
        enricher._registry_loaded = True
        enricher._registry_data = "bad"  # Will fail on .get('categories', {})
        with caplog.at_level(logging.ERROR):
            result = enricher.get_profile_tool_summary()
        assert "error" in result
        assert "Failed to get tool summary" in caplog.text


# ===========================================================================
# get_health_status
# ===========================================================================

class TestGetHealthStatus:
    def test_with_registry_loaded(self):
        enricher = _create_enricher(_sample_registry(core_tools=1, integration_tools=1))
        result = enricher.get_health_status()
        assert result["interpreter_available"] is True
        assert result["computer_available"] is True
        assert result["registry_loaded"] is True
        assert result["registry_categories"] == 2

    def test_without_registry(self):
        enricher = _create_enricher(registry_loaded=False)
        result = enricher.get_health_status()
        assert result["registry_loaded"] is False
        assert result["registry_categories"] == 0

    def test_none_registry_data(self):
        enricher = _create_enricher()
        enricher._registry_loaded = False
        enricher._registry_data = None
        result = enricher.get_health_status()
        assert result["registry_categories"] == 0
