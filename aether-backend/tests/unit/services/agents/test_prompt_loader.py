"""
Tests for services/agents/prompt_loader.py

Covers: PromptLoader — loading YAML templates, caching, validation,
listing agents, helper methods, singleton, and load_agent_prompts.
All filesystem operations use tmp_path for isolation.
"""

from unittest.mock import patch

import pytest
import yaml

from services.agents.prompt_loader import (
    PromptLoader,
    get_prompt_loader,
    load_agent_prompts,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def prompts_dir(tmp_path):
    """Create a temporary prompts directory with sample YAML files."""
    d = tmp_path / "prompts"
    d.mkdir()

    # memory agent
    (d / "memory.yaml").write_text(yaml.dump({
        "prompt_template": "Extract memories from: {messages}",
        "variables": ["messages"],
        "default_config": {"max_memories": 10}
    }))

    # research agent
    (d / "research.yaml").write_text(yaml.dump({
        "prompt_template": "Research this: {content}",
        "variables": ["content"],
        "default_config": {}
    }))

    return d


@pytest.fixture
def loader(prompts_dir):
    """PromptLoader pointed at temp prompts directory."""
    return PromptLoader(prompts_dir=prompts_dir)


# ═══════════════════════════════════════════════════════════════════════════════
#  1. __init__
# ═══════════════════════════════════════════════════════════════════════════════

class TestInit:

    def test_uses_provided_prompts_dir(self, prompts_dir):
        loader = PromptLoader(prompts_dir=prompts_dir)
        assert loader.prompts_dir == prompts_dir

    def test_default_prompts_dir(self):
        loader = PromptLoader()
        assert loader.prompts_dir.name == "prompts"
        assert "agents" in str(loader.prompts_dir)

    def test_empty_cache_on_init(self, loader):
        assert loader._cache == {}


# ═══════════════════════════════════════════════════════════════════════════════
#  2. load_prompt
# ═══════════════════════════════════════════════════════════════════════════════

class TestLoadPrompt:

    def test_loads_valid_template(self, loader):
        data = loader.load_prompt("memory")
        assert data["prompt_template"] == "Extract memories from: {messages}"
        assert data["variables"] == ["messages"]
        assert data["default_config"]["max_memories"] == 10

    def test_caches_result(self, loader):
        data1 = loader.load_prompt("memory")
        data2 = loader.load_prompt("memory")
        assert data1 is data2  # Same object (cached)

    def test_force_reload_bypasses_cache(self, loader, prompts_dir):
        data1 = loader.load_prompt("memory")
        # Modify the file
        (prompts_dir / "memory.yaml").write_text(yaml.dump({
            "prompt_template": "UPDATED: {messages}",
            "variables": ["messages"]
        }))
        data2 = loader.load_prompt("memory", force_reload=True)
        assert data2["prompt_template"] == "UPDATED: {messages}"
        assert data1 is not data2

    def test_file_not_found_raises(self, loader):
        with pytest.raises(FileNotFoundError, match="No prompt template for agent type: nonexistent"):
            loader.load_prompt("nonexistent")

    def test_missing_prompt_template_key_raises(self, loader, prompts_dir):
        (prompts_dir / "bad.yaml").write_text(yaml.dump({"no_template": True}))
        with pytest.raises(ValueError, match="Missing 'prompt_template'"):
            loader.load_prompt("bad")

    def test_invalid_yaml_raises(self, loader, prompts_dir):
        (prompts_dir / "corrupt.yaml").write_text("{{invalid:: [[yaml")
        with pytest.raises(Exception):
            loader.load_prompt("corrupt")

    def test_io_error_raises(self, loader, prompts_dir):
        (prompts_dir / "locked.yaml").write_text("prompt_template: test")
        with patch("builtins.open", side_effect=OSError("Permission denied")):
            with pytest.raises(OSError, match="Permission denied"):
                loader.load_prompt("locked")


# ═══════════════════════════════════════════════════════════════════════════════
#  3. get_template_string
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetTemplateString:

    def test_returns_template_string(self, loader):
        result = loader.get_template_string("memory")
        assert result == "Extract memories from: {messages}"

    def test_missing_agent_raises(self, loader):
        with pytest.raises(FileNotFoundError):
            loader.get_template_string("missing")


# ═══════════════════════════════════════════════════════════════════════════════
#  4. get_default_config
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetDefaultConfig:

    def test_returns_config_dict(self, loader):
        config = loader.get_default_config("memory")
        assert config == {"max_memories": 10}

    def test_missing_default_config_returns_empty(self, loader, prompts_dir):
        (prompts_dir / "minimal.yaml").write_text(yaml.dump({
            "prompt_template": "Test"
        }))
        config = loader.get_default_config("minimal")
        assert config == {}


# ═══════════════════════════════════════════════════════════════════════════════
#  5. get_variables
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetVariables:

    def test_returns_variable_list(self, loader):
        variables = loader.get_variables("memory")
        assert variables == ["messages"]

    def test_missing_variables_returns_empty(self, loader, prompts_dir):
        (prompts_dir / "novars.yaml").write_text(yaml.dump({
            "prompt_template": "No vars here"
        }))
        variables = loader.get_variables("novars")
        assert variables == []


# ═══════════════════════════════════════════════════════════════════════════════
#  6. list_available_agents
# ═══════════════════════════════════════════════════════════════════════════════

class TestListAvailableAgents:

    def test_lists_yaml_files(self, loader):
        agents = loader.list_available_agents()
        assert set(agents) == {"memory", "research"}

    def test_nonexistent_dir_returns_empty(self, tmp_path):
        loader = PromptLoader(prompts_dir=tmp_path / "nonexistent")
        assert loader.list_available_agents() == []


# ═══════════════════════════════════════════════════════════════════════════════
#  7. get_prompt_loader  (singleton)
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetPromptLoader:

    def test_returns_prompt_loader(self):
        with patch("services.agents.prompt_loader._prompt_loader", None):
            loader = get_prompt_loader()
            assert isinstance(loader, PromptLoader)

    def test_returns_same_instance(self):
        with patch("services.agents.prompt_loader._prompt_loader", None):
            loader1 = get_prompt_loader()
            # Reset so next call returns cached instance
            with patch("services.agents.prompt_loader._prompt_loader", loader1):
                loader2 = get_prompt_loader()
            assert loader1 is loader2


# ═══════════════════════════════════════════════════════════════════════════════
#  8. load_agent_prompts  (convenience function)
# ═══════════════════════════════════════════════════════════════════════════════

class TestLoadAgentPrompts:

    def test_loads_all_prompts(self, prompts_dir):
        with patch("services.agents.prompt_loader.get_prompt_loader") as mock_get:
            loader = PromptLoader(prompts_dir=prompts_dir)
            mock_get.return_value = loader

            result = load_agent_prompts()

        assert "memory" in result
        assert "research" in result
        assert result["memory"] == "Extract memories from: {messages}"
        assert result["research"] == "Research this: {content}"

    def test_empty_dir_returns_empty(self, tmp_path):
        empty_dir = tmp_path / "empty_prompts"
        empty_dir.mkdir()

        with patch("services.agents.prompt_loader.get_prompt_loader") as mock_get:
            loader = PromptLoader(prompts_dir=empty_dir)
            mock_get.return_value = loader

            result = load_agent_prompts()

        assert result == {}
