"""
Interpreter Manager - Open Interpreter lifecycle and configuration
Consolidated from interpreter_manager.py

@.architecture
Incoming: core/runtime/engine.py --- {Settings object, profile configurations, integration modules}
Processing: initialize(), create_interpreter(), apply_profile(), apply_settings(), _import_oi_components(), add_web_search_capability() --- {6 jobs: dynamic_loading, initialization, integration_loading, oi_initialization, profile_application, settings_configuration}
Outgoing: core/runtime/engine.py, core/runtime/streaming.py --- {AsyncInterpreter instance configured with settings, profiles, and integrations}

Handles:
- Open Interpreter instance lifecycle with lazy initialization
- Profile application with fallback handling
- Settings configuration and validation
- Integration loading orchestration
- Secure defaults and privacy settings
- Environment-specific configuration
- Web search capability injection
- Computer API configuration

Production Features:
- Lazy initialization for faster startup
- Comprehensive error handling
- Platform-specific configuration
- Privacy-first defaults (offline, no telemetry)
- Proper sys.path management for local OI
"""

import asyncio
import logging
import platform
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class InterpreterManager:
    """
    Manages Open Interpreter lifecycle and configuration with production-ready features.
    
    Features:
    - Lazy interpreter initialization for fast startup
    - Profile application with fallback handling
    - Settings application with secure defaults
    - Integration loading orchestration
    - Privacy-preserving configuration
    - Environment-aware setup
    - Web search capability injection
    - Computer API and skills configuration
    
    Security Features:
    - Offline-first operation
    - Telemetry disabled by default
    - Safe mode support
    - Controlled OS access
    """

    def __init__(self):
        """Initialize interpreter manager with lazy loading."""
        self._interpreter: Optional[Any] = None
        self._AsyncInterpreter: Optional[type] = None
        self._apply_profile: Optional[callable] = None
        self._oi_available = False
        self._initialized = False

    async def initialize(self) -> bool:
        """
        Initialize Open Interpreter components.
        
        Returns:
            True if initialization successful
        """
        if self._initialized:
            return True
            
        try:
            # Import Open Interpreter components
            await self._import_oi_components()
            
            # Mark as available
            self._oi_available = True
            self._initialized = True
            logger.info("Open Interpreter components initialized successfully")
            return True
            
        except Exception as e:
            logger.warning(f"Failed to initialize Open Interpreter: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return False

    async def _import_oi_components(self) -> None:
        """Import and validate Open Interpreter components."""
        import os
        
        # Add local open-interpreter package to path
        oi_candidates = self._get_oi_path_candidates()
        logger.debug(
            f"Open Interpreter lookup candidates: {[str(path) for path in oi_candidates]}"
        )
        
        oi_path = next((path for path in oi_candidates if path.exists()), None)
        
        if oi_path:
            sys.path.insert(0, str(oi_path))
            # CRITICAL: Set OPEN_INTERPRETER_PATH for computer API import
            os.environ["OPEN_INTERPRETER_PATH"] = str(oi_path)
            logger.debug(f"Added {oi_path} to sys.path and OPEN_INTERPRETER_PATH")
        
        # Import AsyncInterpreter
        logger.debug("Attempting to import AsyncInterpreter...")
        from interpreter import AsyncInterpreter  # type: ignore
        logger.debug("AsyncInterpreter imported successfully")
        
        # Import profiles
        logger.debug("Attempting to import profiles...")
        from interpreter.terminal_interface.profiles.profiles import (  # type: ignore
            profile as oi_apply_profile,
        )
        logger.debug("Profiles imported successfully")
        
        self._AsyncInterpreter = AsyncInterpreter
        self._apply_profile = oi_apply_profile

    def _get_oi_path_candidates(self) -> List[Path]:
        """Get candidate paths for Open Interpreter package."""
        try:
            # Use absolute import to ensure it works
            from utils.oi_paths import candidate_open_interpreter_paths
            return candidate_open_interpreter_paths()
        except ImportError as e:
            # Fallback to common paths
            logger.debug(f"Could not import oi_paths utility: {e}")
            aether_backend_path = Path(__file__).parent.parent.parent
            return [
                aether_backend_path / "open-interpreter",
                Path.home() / ".local" / "open-interpreter",
                Path("/usr/local/lib/open-interpreter"),
            ]

    async def create_interpreter(self) -> Optional[Any]:
        """
        Create and configure new interpreter instance.
        
        Returns:
            Configured interpreter instance or None on failure
        """
        if not self._oi_available:
            logger.warning("Open Interpreter not available")
            return None
            
        try:
            logger.info("Creating interpreter instance...")
            self._interpreter = self._AsyncInterpreter()
            logger.info("Interpreter instance created")
            return self._interpreter
            
        except Exception as e:
            logger.error(f"Failed to create interpreter: {e}", exc_info=True)
            return None

    def apply_settings(self, settings: Any, init: bool = False) -> None:
        """
        Apply runtime settings to interpreter instance.
        
        Args:
            settings: Runtime settings object
            init: Whether this is initial setup
        """
        if not self._interpreter:
            logger.warning("No interpreter instance to configure")
            return
            
        self._apply_privacy_settings()
        self._apply_profile_settings(settings, init)
        self._apply_llm_settings(settings.llm)
        self._apply_interpreter_settings(settings.interpreter)
        self._apply_environment_settings()
        
        logger.info("Interpreter settings applied successfully")

    def _apply_privacy_settings(self) -> None:
        """Apply privacy and security settings."""
        interp = self._interpreter
        
        # Offline-first and privacy preserving
        interp.offline = True
        interp.disable_telemetry = True

    def _apply_profile_settings(self, settings: Any, init: bool) -> None:
        """Apply GURU profile from our templates directory."""
        interp = self._interpreter
        
        # Use our custom GURU profile from templates
        desired_profile = settings.interpreter.profile or "GURU"
        
        # Try loading our custom GURU.yaml from templates first
        try:
            from pathlib import Path
            import yaml
            
            # Get path to our custom GURU template
            backend_root = Path(__file__).parent.parent.parent  # core/runtime -> core -> aether-backend
            guru_template = backend_root / "core" / "profiles" / "templates" / "GURU.yaml"
            
            if guru_template.exists():
                logger.info(f"Loading custom GURU profile from: {guru_template}")
                with open(guru_template, 'r') as f:
                    profile_data = yaml.safe_load(f)
                
                # Apply system message (most critical for personality)
                if 'system_message' in profile_data:
                    interp.system_message = profile_data['system_message']
                    logger.info(f"✅ Applied GURU system message ({len(profile_data['system_message'])} chars)")
                
                # Apply interpreter settings from YAML
                if 'interpreter' in profile_data:
                    for key, value in profile_data['interpreter'].items():
                        if hasattr(interp, key):
                            setattr(interp, key, value)
                            logger.debug(f"Set interpreter.{key} = {value}")
                
                # Apply computer settings from YAML  
                if 'computer' in profile_data:
                    for key, value in profile_data['computer'].items():
                        if hasattr(interp.computer, key):
                            setattr(interp.computer, key, value)
                            logger.debug(f"Set computer.{key} = {value}")
                
                logger.info("✅ Applied custom GURU profile from templates")
                return
                
        except Exception as e:
            logger.warning(f"Failed to load custom GURU template: {e}")
        
        # Fallback to OI's built-in profile loader
        if self._apply_profile is not None:
            try:
                self._apply_profile(interp, desired_profile + ".py")
                logger.info(f"✅ Applied OI profile: {desired_profile}.py")
                return
            except Exception as e:
                logger.debug(f"OI profile loading failed: {e}")
        
        # Final fallback to basic settings
        logger.warning("Using minimal fallback profile settings")
        self._apply_basic_profile_settings(interp, desired_profile)

    def _apply_basic_profile_settings(self, interp: Any, profile_name: str) -> None:
        """Apply basic profile settings directly without profile file."""
        try:
            # For GURU profile, set basic settings
            if "GURU" in profile_name.upper():
                interp.computer.import_computer_api = True
                interp.computer.import_skills = True
                interp.auto_run = False  # Require confirmation
                interp.conversation_history = True
                interp.conversation_history_path = None
                
                # CRITICAL: Reset import flags to ensure re-import
                # This is necessary because OI checks these flags before importing
                interp.computer._has_imported_computer_api = False
                interp.computer._has_imported_skills = False
                
                logger.info(f"✅ Applied basic profile settings for: {profile_name}")
            else:
                logger.debug(f"No fallback settings for profile: {profile_name}")
        except Exception as e:
            logger.debug(f"Basic profile settings failed: {e}")
    
    def _apply_llm_settings(self, llm_settings: Any) -> None:
        """Apply LLM configuration settings."""
        interp = self._interpreter
        
        # Model configuration
        model = llm_settings.model
        if llm_settings.provider == "openai-compatible" and not model.startswith("openai/"):
            model = f"openai/{model}"
        interp.llm.model = model
        
        # LLM parameters
        interp.llm.max_tokens = llm_settings.max_tokens
        interp.llm.context_window = llm_settings.context_window
        interp.llm.supports_functions = False  # Default to False for local providers
        interp.llm.supports_vision = llm_settings.supports_vision
        
        # Vision settings
        if getattr(interp, "offline", False) or not llm_settings.supports_vision:
            interp.llm.vision_renderer = None
        
        # API configuration
        interp.llm.api_base = llm_settings.api_base
        
        # API key placeholder
        try:
            interp.llm.api_key = "not-needed"
        except Exception:
            pass

    def _apply_interpreter_settings(self, interpreter_settings: Any) -> None:
        """Apply interpreter behavior settings."""
        interp = self._interpreter
        
        # Behavior settings
        interp.auto_run = True
        interp.loop = False
        
        # Clear generic execution instructions
        try:
            interp.llm.execution_instructions = ""
        except Exception:
            pass
        
        # Custom settings
        if hasattr(interpreter_settings, 'loop_message') and interpreter_settings.loop_message:
            interp.loop_message = interpreter_settings.loop_message
        interp.safe_mode = interpreter_settings.safe_mode
        
        if interpreter_settings.system_message:
            interp.system_message = interpreter_settings.system_message
            logger.debug("⚠️  System message overridden from settings")
        
        # Computer API settings - CRITICAL for computer object availability in Python execution
        # ALWAYS enable for GURU profile if not explicitly configured
        if hasattr(interpreter_settings, "computer"):
            interp.computer.import_computer_api = interpreter_settings.computer.import_computer_api
            interp.computer.import_skills = interpreter_settings.computer.import_skills
            
            # Reset import flags to ensure re-import if settings changed
            interp.computer._has_imported_computer_api = False
            interp.computer._has_imported_skills = False
            
            logger.debug(
                f"Computer API settings: "
                f"import_computer_api={interpreter_settings.computer.import_computer_api}, "
                f"import_skills={interpreter_settings.computer.import_skills}"
            )
            
            # Set skills path if specified
            if interpreter_settings.computer.skills_path:
                skills_path = Path(interpreter_settings.computer.skills_path)
                skills_path.mkdir(parents=True, exist_ok=True)
                interp.computer.skills.path = str(skills_path)
                logger.debug(f"Skills path set to: {skills_path}")
        else:
            # Fallback: ALWAYS enable computer API for GURU profile
            logger.warning("No computer settings found - applying GURU defaults")
            interp.computer.import_computer_api = True
            interp.computer.import_skills = True
            interp.computer._has_imported_computer_api = False
            interp.computer._has_imported_skills = False
            logger.info("✅ Forced computer API import for GURU profile")
        
        # Force OS control mode for browser and GUI actions
        try:
            interp.os = True
        except Exception:
            pass

    def _apply_environment_settings(self) -> None:
        """Apply environment-specific settings."""
        interp = self._interpreter
        
        # Append OS/environment info to system message
        try:
            os_name = platform.system()
            os_release = platform.release()
            os_version = platform.version()
            
            env_info = (
                f"\n\n[ENVIRONMENT]\n"
                f"OS: {os_name} {os_release}\n"
                f"Version: {os_version}"
            )
            interp.system_message = (interp.system_message or "") + env_info
            
        except Exception as e:
            logger.debug(f"Failed to append environment info: {e}")

    def add_web_search_capability(self) -> None:
        """Add basic web search capability to computer API."""
        if not self._interpreter:
            return
            
        async def basic_web_search(query: str, max_results: int = 5) -> str:
            """Basic web search using DuckDuckGo API (no API key required)"""
            try:
                import aiohttp
                
                params = {
                    "q": query,
                    "format": "json",
                    "no_html": "1",
                    "skip_disambig": "1",
                }
                
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        "https://api.duckduckgo.com/",
                        params=params,
                        timeout=aiohttp.ClientTimeout(total=10),
                    ) as response:
                        if response.status == 200:
                            data = await response.json()
                            result = f"Search results for '{query}':\n\n"
                            
                            if data.get("AbstractText"):
                                result += f"Summary: {data.get('AbstractText')}\n"
                                if data.get("AbstractURL"):
                                    result += f"Source: {data.get('AbstractURL')}\n"
                            
                            for topic in data.get("RelatedTopics", [])[:max_results]:
                                if isinstance(topic, dict) and topic.get("Text"):
                                    result += f"• {topic.get('Text')}\n"
                                    if topic.get("FirstURL"):
                                        result += f"  Link: {topic.get('FirstURL')}\n"
                            
                            return result if result.strip() else f"No detailed results found for: {query}"
                        else:
                            return f"Search failed for: {query}"
                    
            except Exception as e:
                return f"Search error: {str(e)}. Query was: {query}"
        
        # Add to computer API if available
        if hasattr(self._interpreter, "computer"):
            self._interpreter.computer.web_search = basic_web_search
            logger.info("✅ Basic web search capability added to computer API")

    def get_interpreter(self) -> Optional[Any]:
        """Get current interpreter instance."""
        return self._interpreter

    def is_available(self) -> bool:
        """Check if Open Interpreter is available."""
        return self._oi_available

    def is_initialized(self) -> bool:
        """Check if interpreter manager is initialized."""
        return self._initialized

    async def cleanup(self) -> None:
        """Cleanup interpreter resources."""
        if self._interpreter:
            # OI doesn't require special cleanup
            self._interpreter = None
            logger.debug("Interpreter cleaned up")

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of interpreter manager.
        
        Returns:
            Dict with health status information
        """
        return {
            "oi_available": self._oi_available,
            "initialized": self._initialized,
            "interpreter_created": self._interpreter is not None,
        }

