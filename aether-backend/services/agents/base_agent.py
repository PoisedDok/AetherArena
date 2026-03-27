"""
Base Agent Class

Abstract base for all AI agents with common functionality.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any
from pathlib import Path
import yaml

from monitoring import get_logger

logger = get_logger(__name__)


class BaseAgent(ABC):
    """
    Abstract base class for all AI agents.
    
    Provides:
    - Prompt template loading
    - Configuration management
    - Standard interfaces for execution
    - Logging and monitoring
    """
    
    def __init__(self, config: Dict[str, Any]):
        """
        Initialize agent with configuration.
        
        Args:
            config: Agent configuration from agent_configs table
        """
        self.agent_name = config['agent_name']
        self.agent_type = config['agent_type']
        self.enabled = config['enabled']
        self.model_name = config['model_name']
        self.prompt_template = config['prompt_template']
        self.execution_trigger = config['execution_trigger']
        self.trigger_frequency = config.get('trigger_frequency')
        self.configuration = config.get('configuration', {})
        
        logger.info(f"Initialized {self.agent_name} agent", extra={
            "agent_type": self.agent_type,
            "model": self.model_name,
            "enabled": self.enabled
        })
    
    @abstractmethod
    async def execute(self, context: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute agent logic.
        
        Args:
            context: Execution context (chat_id, messages, attachments, etc.)
            
        Returns:
            Agent output dictionary
        """
        pass
    
    @abstractmethod
    async def validate_input(self, context: Dict[str, Any]) -> bool:
        """
        Validate input before execution.
        
        Args:
            context: Execution context
            
        Returns:
            True if valid, False otherwise
        """
        pass
    
    def format_prompt(self, **variables) -> str:
        """
        Format prompt template with variables.
        
        Args:
            **variables: Variables to substitute in prompt template
            
        Returns:
            Formatted prompt string
        """
        try:
            return self.prompt_template.format(**variables)
        except KeyError as e:
            logger.error(f"Missing variable in prompt template: {e}")
            raise ValueError(f"Missing required variable: {e}")
    
    def get_config_value(self, key: str, default: Any = None) -> Any:
        """
        Get configuration value with fallback.
        
        Args:
            key: Configuration key
            default: Default value if key not found
            
        Returns:
            Configuration value or default
        """
        return self.configuration.get(key, default)
    
    @staticmethod
    def load_prompt_template(agent_type: str) -> str:
        """
        Load prompt template from YAML file.
        
        Args:
            agent_type: Type of agent (memory, research)
            
        Returns:
            Prompt template string
        """
        prompts_dir = Path(__file__).parent / 'prompts'
        template_file = prompts_dir / f'{agent_type}.yaml'
        
        if not template_file.exists():
            logger.warning(f"Prompt template not found: {template_file}")
            return ""
        
        try:
            with open(template_file, 'r') as f:
                data = yaml.safe_load(f)
                return data.get('prompt_template', '')
        except Exception as e:
            logger.error(f"Failed to load prompt template {template_file}: {e}")
            return ""
    
    @classmethod
    def from_config(cls, config: Dict[str, Any]) -> 'BaseAgent':
        """
        Factory method to create agent from configuration.
        
        Args:
            config: Agent configuration dictionary
            
        Returns:
            Agent instance
        """
        return cls(config)
