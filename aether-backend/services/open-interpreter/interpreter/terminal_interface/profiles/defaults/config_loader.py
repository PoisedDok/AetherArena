"""
Configuration loader for Open Interpreter GURU profile.
Reads directly from the centralized TOML config file.
"""

import sys
from pathlib import Path

# Add backend to sys.path to import integrations
backend_path = Path(__file__).parent.parent.parent.parent.parent.parent / "backend"
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

from integrations.config import load_config

def configure_interpreter(interpreter):
    """Configure Open Interpreter using centralized TOML config."""
    try:
        # Load config using centralized config loader
        config = load_config()
        
        # Model settings from config
        interpreter.llm.model = config["MODELS"]["primary_chat_model"]
        interpreter.llm.api_base = config["PROVIDERS"]["lm_studio_url"]
        interpreter.llm.api_key = config["PROVIDERS"]["lm_studio_api_key"]
        
        # Other settings from config
        oi_config = config["OPEN_INTERPRETER"]
        interpreter.llm.context_window = oi_config["context_window"]
        interpreter.llm.max_tokens = oi_config["max_tokens"]
        interpreter.llm.supports_vision = oi_config["supports_vision"]
        interpreter.llm.supports_functions = oi_config["supports_functions"]
        interpreter.offline = oi_config["offline"]
        interpreter.disable_telemetry = oi_config["disable_telemetry"]
        
        print(f"✅ Using centralized config - Model: {interpreter.llm.model}")
        
    except Exception as e:
        # Fallback configuration
        interpreter.llm.model = "qwen/qwen3-4b-2507"
        interpreter.llm.api_base = "http://localhost:1234/v1"
        interpreter.llm.api_key = "not-needed"
        interpreter.llm.context_window = 100000
        interpreter.llm.max_tokens = 4096
        interpreter.llm.supports_vision = True
        interpreter.llm.supports_functions = False
        interpreter.offline = True
        interpreter.disable_telemetry = True
        
        print(f"⚠️  Using fallback config - Model: {interpreter.llm.model}")
    
    return interpreter
