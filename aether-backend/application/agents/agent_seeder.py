"""
Agent Seeder

Ensures agent_configs contains an entry for each prompt template.

@.architecture
Incoming: app.py startup, services/agents/prompts/*.yaml --- {Settings, YAML templates}
Processing: compare templates to agent_configs, insert missing --- {JOB_QUERY_DB, JOB_SAVE_TO_DB}
Outgoing: agent_configs table --- {agent configs}
"""

from typing import List

from monitoring import get_logger
from services.agents.prompt_loader import get_prompt_loader

logger = get_logger(__name__)


async def seed_missing_agents(gateway, settings) -> List[str]:
    """
    Seed agent configs for any missing prompt templates.
    
    Returns list of agent names that were seeded.
    """
    loader = get_prompt_loader()
    agent_types = loader.list_available_agents()
    
    existing = await gateway.select("agent_configs", columns="agent_name")
    existing_names = {row.get("agent_name") for row in existing or []}
    
    seeded = []
    
    for agent_type in agent_types:
        if agent_type in existing_names:
            continue
        
        prompt_data = loader.load_prompt(agent_type)
        default_config = dict(prompt_data.get("default_config", {}))
        execution_trigger = default_config.pop("execution_trigger", "on_demand")
        trigger_frequency = default_config.pop("trigger_frequency", None)
        enabled_by_default = default_config.pop("enabled", False)
        
        payload = {
            "agent_name": agent_type,
            "agent_type": prompt_data.get("agent_type", agent_type),
            "enabled": enabled_by_default,
            "model_name": settings.llm.model,
            "prompt_template": prompt_data["prompt_template"],
            "execution_trigger": execution_trigger,
            "trigger_frequency": trigger_frequency,
            "configuration": default_config,
        }
        
        await gateway.insert("agent_configs", payload)
        seeded.append(agent_type)
    
    if seeded:
        logger.info("Seeded agent configs: %s", seeded)
    else:
        logger.info("No agent configs to seed")
    
    return seeded
