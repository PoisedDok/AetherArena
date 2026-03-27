#!/usr/bin/env python3
# @.architecture
# Incoming: local prompt templates + settings --- {yaml, Settings}
# Processing: Load agent templates and seed database records --- {3 jobs: JOB_LOAD_CONFIG, JOB_EXECUTE_COMMAND, JOB_SAVE_TO_DB}
# Outgoing: agent_configs rows + CLI status output --- {none, none}

"""
Seed Agent Configurations from YAML Templates

Loads prompts from services/agents/prompts/ and seeds agent_configs table.
Run after migration 010_agent_system.sql creates the tables.

Usage:
    python data/database/scripts/seed_agents.py
"""

import sys
import subprocess
from pathlib import Path

# Add backend to path
backend_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_root))

from services.agents.prompt_loader import get_prompt_loader
from config.settings import get_settings

# Database constants (same as migration_runner.py)
TARGET_DATABASE = "aether"
DATABASE_USER = "supabase_admin"
DOCKER_CONTAINER = "supabase-db"


def exec_sql(sql: str) -> tuple[bool, str]:
    """Execute SQL via docker exec (same as migration runner)."""
    try:
        result = subprocess.run(
            ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", TARGET_DATABASE, "-c", sql],
            capture_output=True,
            text=True,
            timeout=30,
            check=True
        )
        return True, result.stdout
    except subprocess.CalledProcessError as e:
        return False, e.stderr
    except Exception as e:
        return False, str(e)


def seed_agents():
    """Seed agent configurations from YAML templates."""
    
    print("Loading agent prompt templates from YAML...")
    
    # Load prompt templates
    loader = get_prompt_loader()
    agent_types = loader.list_available_agents()
    
    print(f"Found {len(agent_types)} agent templates: {agent_types}")
    
    # Agent type mapping
    type_map = {
        'memory': 'memory',
        'research': 'research'
    }
    
    # Default model from central settings (user can override via Agents Modal)
    # Uses resolved per-service provider for text services (aether-inference by default)
    settings = get_settings()
    _api_base, default_model, _api_key = settings.resolve_service_provider(
        settings.research_service.provider_config, service_type="text"
    )
    # Fallback: if resolver returned empty (no inference model configured yet), use main LLM or summarizer
    if not default_model:
        default_model = settings.llm.summarizer_model or settings.llm.model
    
    seeded_count = 0
    
    for agent_type in agent_types:
        if agent_type not in type_map:
            print(f"⚠️  Unknown agent type: {agent_type}")
            continue
        
        # Load prompt and config from YAML
        prompt_data = loader.load_prompt(agent_type)
        prompt_template = prompt_data['prompt_template'].replace("'", "''")  # Escape single quotes for SQL
        default_config = dict(prompt_data.get('default_config', {}))
        execution_trigger = default_config.pop('execution_trigger', 'on_demand')
        trigger_frequency = default_config.pop('trigger_frequency', None)
        
        # Check if agent already exists
        check_sql = f"SELECT agent_name FROM agent_configs WHERE agent_name = '{agent_type}';"
        success, output = exec_sql(check_sql)
        
        if not success:
            print(f"❌ Failed to check existing agent '{agent_type}': {output}")
            continue
        
        if agent_type in output:
            print(f"ℹ️  Agent '{agent_type}' already exists, skipping")
            continue
        
        # Build config JSONB
        import json
        config_json = json.dumps(default_config).replace("'", "''")
        
        agent_model = default_model
        if agent_type == 'memory':
            _, mem_model, _ = settings.resolve_service_provider(
                settings.memory_service.provider_config, service_type="text"
            )
            agent_model = mem_model or settings.llm.summarizer_model or settings.llm.model
        
        # Insert agent
        insert_sql = f"""
        INSERT INTO agent_configs (agent_name, agent_type, enabled, model_name, prompt_template, execution_trigger, trigger_frequency, configuration)
        VALUES (
            '{agent_type}',
            '{type_map[agent_type]}',
            { 'true' if agent_type == 'memory' else 'false' },
            '{agent_model}',
            '{prompt_template}',
            '{execution_trigger}',
            {'NULL' if trigger_frequency is None else trigger_frequency},
            '{config_json}'::jsonb
        );
        """
        
        success, output = exec_sql(insert_sql)
        
        if success:
            print(f"✅ Seeded agent: {agent_type}")
            seeded_count += 1
        else:
            print(f"❌ Failed to seed agent '{agent_type}': {output}")
    
    print(f"\n✅ Successfully seeded {seeded_count}/{len(agent_types)} agents")
    return seeded_count > 0


if __name__ == '__main__':
    success = seed_agents()
    sys.exit(0 if success else 1)
