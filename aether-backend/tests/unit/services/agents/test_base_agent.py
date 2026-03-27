"""
Tests for services/agents/base_agent.py

Covers: BaseAgent constructor, format_prompt, get_config_value,
load_prompt_template (static method), and from_config (classmethod).
BaseAgent is abstract — tests use a concrete subclass.
"""

from typing import Dict, Any
from unittest.mock import patch, mock_open, MagicMock

import pytest
import yaml

from services.agents.base_agent import BaseAgent


# ─── Concrete test subclass ──────────────────────────────────────────────────

class ConcreteAgent(BaseAgent):
    """Minimal concrete implementation for testing."""

    async def execute(self, context: Dict[str, Any]) -> Dict[str, Any]:
        return {"status": "done"}

    async def validate_input(self, context: Dict[str, Any]) -> bool:
        return bool(context)


# ─── Fixtures ────────────────────────────────────────────────────────────────

def _make_config(**overrides):
    defaults = {
        "agent_name": "test_agent",
        "agent_type": "analysis",
        "enabled": True,
        "model_name": "lfm-2.5",
        "prompt_template": "Analyze: {input}",
        "execution_trigger": "on_message",
        "trigger_frequency": "always",
        "configuration": {"max_tokens": 500, "temperature": 0.7}
    }
    defaults.update(overrides)
    return defaults


@pytest.fixture
def agent():
    return ConcreteAgent(_make_config())


# ═══════════════════════════════════════════════════════════════════════════════
#  1. __init__  (constructor)
# ═══════════════════════════════════════════════════════════════════════════════

class TestInit:

    def test_stores_required_fields(self, agent):
        assert agent.agent_name == "test_agent"
        assert agent.agent_type == "analysis"
        assert agent.enabled is True
        assert agent.model_name == "lfm-2.5"
        assert agent.prompt_template == "Analyze: {input}"
        assert agent.execution_trigger == "on_message"

    def test_optional_trigger_frequency(self, agent):
        assert agent.trigger_frequency == "always"

    def test_missing_trigger_frequency_defaults_none(self):
        config = _make_config()
        del config["trigger_frequency"]
        a = ConcreteAgent(config)
        assert a.trigger_frequency is None

    def test_configuration_defaults_to_empty_dict(self):
        config = _make_config()
        del config["configuration"]
        a = ConcreteAgent(config)
        assert a.configuration == {}

    def test_missing_required_field_raises(self):
        config = _make_config()
        del config["agent_name"]
        with pytest.raises(KeyError):
            ConcreteAgent(config)


# ═══════════════════════════════════════════════════════════════════════════════
#  2. format_prompt
# ═══════════════════════════════════════════════════════════════════════════════

class TestFormatPrompt:

    def test_simple_substitution(self, agent):
        result = agent.format_prompt(input="test data")
        assert result == "Analyze: test data"

    def test_missing_variable_raises_value_error(self, agent):
        with pytest.raises(ValueError, match="Missing required variable"):
            agent.format_prompt(wrong_key="test")

    def test_multiple_variables(self):
        config = _make_config(prompt_template="Agent {name} processing {count} items")
        a = ConcreteAgent(config)
        result = a.format_prompt(name="research", count=5)
        assert result == "Agent research processing 5 items"

    def test_extra_variables_ignored(self, agent):
        # Python str.format ignores extra kwargs
        result = agent.format_prompt(input="data", extra="ignored")
        assert result == "Analyze: data"

    def test_empty_template(self):
        config = _make_config(prompt_template="")
        a = ConcreteAgent(config)
        assert a.format_prompt() == ""


# ═══════════════════════════════════════════════════════════════════════════════
#  3. get_config_value
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetConfigValue:

    def test_returns_existing_value(self, agent):
        assert agent.get_config_value("max_tokens") == 500

    def test_returns_default_for_missing(self, agent):
        assert agent.get_config_value("nonexistent", "fallback") == "fallback"

    def test_default_is_none(self, agent):
        assert agent.get_config_value("missing") is None


# ═══════════════════════════════════════════════════════════════════════════════
#  4. load_prompt_template  (static method — filesystem mocked)
# ═══════════════════════════════════════════════════════════════════════════════

class TestLoadPromptTemplate:

    def test_loads_yaml_from_real_prompts_dir(self):
        """Uses real prompts directory — memory.yaml known to exist."""
        result = BaseAgent.load_prompt_template("memory")
        assert isinstance(result, str)
        assert len(result) > 0

    def test_missing_template_returns_empty(self):
        result = BaseAgent.load_prompt_template("nonexistent_agent_type_xyz")
        assert result == ""

    def test_open_error_returns_empty(self):
        """Simulate I/O error during file read."""
        mock_template = MagicMock()
        mock_template.exists.return_value = True

        with patch("services.agents.base_agent.Path") as MockPath:
            mock_chain = MagicMock()
            MockPath.return_value = mock_chain
            mock_chain.parent.__truediv__.return_value.__truediv__.return_value = mock_template

            with patch("builtins.open", side_effect=OSError("Disk error")):
                result = BaseAgent.load_prompt_template("anything")
            assert result == ""

    def test_missing_prompt_template_key_returns_empty(self):
        """YAML is valid but has no prompt_template key."""
        mock_template = MagicMock()
        mock_template.exists.return_value = True

        with patch("services.agents.base_agent.Path") as MockPath:
            mock_chain = MagicMock()
            MockPath.return_value = mock_chain
            mock_chain.parent.__truediv__.return_value.__truediv__.return_value = mock_template

            yaml_data = yaml.dump({"no_template_here": True})
            with patch("builtins.open", mock_open(read_data=yaml_data)):
                result = BaseAgent.load_prompt_template("test")
            # data.get('prompt_template', '') returns '' for missing key
            assert result == ""


# ═══════════════════════════════════════════════════════════════════════════════
#  5. from_config  (classmethod)
# ═══════════════════════════════════════════════════════════════════════════════

class TestFromConfig:

    def test_creates_instance(self):
        config = _make_config()
        agent = ConcreteAgent.from_config(config)
        assert isinstance(agent, ConcreteAgent)
        assert agent.agent_name == "test_agent"

    def test_preserves_type(self):
        """from_config on subclass returns subclass instance."""
        config = _make_config()
        agent = ConcreteAgent.from_config(config)
        assert type(agent) is ConcreteAgent


# ═══════════════════════════════════════════════════════════════════════════════
#  6. Abstract methods  (execute / validate_input)
# ═══════════════════════════════════════════════════════════════════════════════

class TestAbstractMethods:

    async def test_execute_returns_dict(self, agent):
        result = await agent.execute({"chat_id": "123"})
        assert result == {"status": "done"}

    async def test_validate_input_returns_bool(self, agent):
        assert await agent.validate_input({"data": "test"}) is True
        assert await agent.validate_input({}) is False

    def test_cannot_instantiate_abstract_directly(self):
        with pytest.raises(TypeError):
            BaseAgent(_make_config())
