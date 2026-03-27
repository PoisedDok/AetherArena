"""
Agents Service

Provides agent-specific logic, prompt templates, and base agent classes.

Architecture:
- prompts/ - Agent prompt templates (YAML)
- templates/ - Base agent configuration templates
- handlers/ - Agent-specific business logic
"""

from .base_agent import BaseAgent
from .prompt_loader import load_agent_prompts, get_prompt_loader

__all__ = [
    'BaseAgent',
    'load_agent_prompts',
    'get_prompt_loader'
]
