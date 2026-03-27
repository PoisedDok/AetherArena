"""
Agent Prompt Loader

Loads and manages agent prompt templates from YAML files.
"""

from pathlib import Path
from typing import Dict, Any, Optional
import yaml

from monitoring import get_logger

logger = get_logger(__name__)


class PromptLoader:
    """
    Loads agent prompts from YAML template files.
    
    Prompts are versioned, templated, and separated from code.
    """
    
    def __init__(self, prompts_dir: Optional[Path] = None):
        """
        Initialize prompt loader.
        
        Args:
            prompts_dir: Path to prompts directory (defaults to services/agents/prompts/)
        """
        if prompts_dir is None:
            # PyInstaller compatible path resolution
            import sys
            import os
            
            def get_resource_path(relative_path: str) -> Path:
                if hasattr(sys, '_MEIPASS'):
                    for env_var in ('AETHER_BACKEND_ROOT', 'AETHER_INSTALL_DIR'):
                        base = os.environ.get(env_var)
                        if base:
                            candidate = Path(base) / relative_path
                            if candidate.exists():
                                return candidate
                    return Path(sys._MEIPASS) / relative_path
                return Path(__file__).parent.parent.parent / relative_path

            prompts_dir = get_resource_path("services/agents/prompts")
        
        self.prompts_dir = prompts_dir
        self._cache: Dict[str, Dict[str, Any]] = {}
    
    def load_prompt(self, agent_type: str, force_reload: bool = False) -> Dict[str, Any]:
        """
        Load prompt template for agent type.
        
        Args:
            agent_type: Agent type (memory, research)
            force_reload: Force reload from disk (bypass cache)
            
        Returns:
            Prompt data dictionary with template, variables, metadata
        """
        if agent_type in self._cache and not force_reload:
            return self._cache[agent_type]
        
        template_file = self.prompts_dir / f'{agent_type}.yaml'
        
        if not template_file.exists():
            logger.error(f"Prompt template not found: {template_file}")
            raise FileNotFoundError(f"No prompt template for agent type: {agent_type}")
        
        try:
            with open(template_file, 'r') as f:
                data = yaml.safe_load(f)
            
            # Validate required fields
            if 'prompt_template' not in data:
                raise ValueError(f"Missing 'prompt_template' in {template_file}")
            
            self._cache[agent_type] = data
            logger.info(f"Loaded prompt template for {agent_type} agent")
            return data
        
        except Exception as e:
            logger.error(f"Failed to load prompt template {template_file}: {e}")
            raise
    
    def get_template_string(self, agent_type: str) -> str:
        """
        Get raw prompt template string.
        
        Args:
            agent_type: Agent type
            
        Returns:
            Prompt template string
        """
        data = self.load_prompt(agent_type)
        return data['prompt_template']
    
    def get_default_config(self, agent_type: str) -> Dict[str, Any]:
        """
        Get default configuration for agent.
        
        Args:
            agent_type: Agent type
            
        Returns:
            Default configuration dictionary
        """
        data = self.load_prompt(agent_type)
        return data.get('default_config', {})
    
    def get_variables(self, agent_type: str) -> list:
        """
        Get required template variables.
        
        Args:
            agent_type: Agent type
            
        Returns:
            List of required variable names
        """
        data = self.load_prompt(agent_type)
        return data.get('variables', [])
    
    def list_available_agents(self) -> list:
        """
        List all available agent types with templates.
        
        Returns:
            List of agent type names
        """
        if not self.prompts_dir.exists():
            return []
        
        return [
            f.stem for f in self.prompts_dir.glob('*.yaml')
        ]


# Global instance
_prompt_loader = None

def get_prompt_loader() -> PromptLoader:
    """Get global prompt loader instance."""
    global _prompt_loader
    if _prompt_loader is None:
        _prompt_loader = PromptLoader()
    return _prompt_loader


def load_agent_prompts() -> Dict[str, str]:
    """
    Load all agent prompts.
    
    Returns:
        Dictionary mapping agent_type -> prompt_template
    """
    loader = get_prompt_loader()
    agent_types = loader.list_available_agents()
    
    return {
        agent_type: loader.get_template_string(agent_type)
        for agent_type in agent_types
    }
