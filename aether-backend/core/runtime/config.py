"""
Configuration and HTTP Client Manager
Consolidated from settings_manager.py and http_client_manager.py

@.architecture
Incoming: core/runtime/engine.py, utils/config.py --- {Settings object, get_llm_settings() from centralized TOML config}
Processing: load_and_apply_settings(), get_client(), reset_client(), close() --- {5 jobs: config_loading, config_application, http_client_management, resource_cleanup}
Outgoing: core/runtime/engine.py, External LLM APIs (via HTTP) --- {enhanced Settings with centralized config, httpx.AsyncClient for HTTP requests}

Handles:
- Centralized configuration loading and validation
- HTTP client lifecycle with proper timeout management
- Connection pooling and secure defaults
- Environment-aware configuration
- Graceful fallback and error handling

Production Features:
- Thread-safe async locks
- Proper resource cleanup
- Connection pool limits
- Configurable timeouts for different operations
- Cache invalidation support
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)


class ConfigManager:
    """
    Manages centralized configuration loading and HTTP client lifecycle.
    
    Combines settings management and HTTP client management into a single,
    cohesive module with proper dependency injection and lifecycle management.
    
    Features:
    - Loads from centralized TOML config
    - Validates and applies settings with secure defaults
    - HTTP client with configurable timeouts
    - Connection pooling limits
    - Graceful cleanup and error handling
    """

    def __init__(
        self,
        connect_timeout: float = 5.0,
        read_timeout: float = 600.0,
        write_timeout: float = 30.0,
        pool_timeout: float = 5.0,
        verify_ssl: bool = True,
        max_redirects: int = 5,
    ):
        """
        Initialize config manager with HTTP client settings.
        
        Args:
            connect_timeout: Connection establishment timeout
            read_timeout: Read operation timeout (long for streaming)
            write_timeout: Write operation timeout
            pool_timeout: Connection pool timeout
            verify_ssl: Verify SSL certificates (default True for security)
            max_redirects: Maximum number of redirects to follow (default 5)
        """
        # Configuration cache
        self._config_cache: Optional[Dict[str, Any]] = None
        
        # HTTP client settings
        self._connect_timeout = connect_timeout
        self._read_timeout = read_timeout
        self._write_timeout = write_timeout
        self._pool_timeout = pool_timeout
        self._verify_ssl = verify_ssl
        self._max_redirects = max_redirects
        
        # HTTP client instance
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()

    # ============================================================================
    # CONFIGURATION MANAGEMENT
    # ============================================================================

    def load_and_apply_settings(self, base_settings: Any) -> Any:
        """
        Load settings from centralized config and apply to base settings.
        
        Args:
            base_settings: Base runtime settings to enhance
            
        Returns:
            Enhanced settings with centralized config applied
        """
        try:
            llm_config = self._load_centralized_config()
            if llm_config:
                return self._apply_llm_config(base_settings, llm_config)
            else:
                logger.warning("No centralized config available, using base settings")
                return base_settings
                
        except Exception as e:
            logger.warning(f"Failed to load centralized config, using defaults: {e}")
            return base_settings

    def _load_centralized_config(self) -> Optional[Dict[str, Any]]:
        """Load LLM configuration from centralized TOML file."""
        if self._config_cache is not None:
            return self._config_cache
            
        try:
            from ...utils.config import get_llm_settings
            config = get_llm_settings()
            
            # Validate required fields
            required_fields = [
                "provider", "api_base", "model", "supports_vision",
                "context_window", "max_tokens"
            ]
            missing = [field for field in required_fields if field not in config]
            if missing:
                logger.error(f"Centralized config missing required fields: {missing}")
                return None
                
            self._config_cache = config
            logger.info(
                f"Loaded centralized config - Model: {config['model']}, "
                f"API: {config['api_base']}"
            )
            return config
            
        except Exception as e:
            logger.warning(f"Failed to load centralized config: {e}")
            return None

    def _apply_llm_config(self, settings: Any, config: Dict[str, Any]) -> Any:
        """Apply LLM configuration to runtime settings."""
        # Update LLM settings with centralized config
        settings.llm.provider = config["provider"]
        settings.llm.api_base = config["api_base"]
        settings.llm.model = config["model"]
        settings.llm.supports_vision = config["supports_vision"]
        settings.llm.context_window = config["context_window"]
        settings.llm.max_tokens = config["max_tokens"]
        
        logger.info(
            f"Applied centralized config - Model: {config['model']}, "
            f"API: {config['api_base']}"
        )
        return settings

    def clear_cache(self) -> None:
        """Clear cached configuration for fresh reload."""
        self._config_cache = None
        logger.debug("Cleared settings cache")

    # ============================================================================
    # HTTP CLIENT MANAGEMENT
    # ============================================================================

    async def get_client(self) -> httpx.AsyncClient:
        """
        Get or create HTTP client with proper timeouts and security defaults.
        
        Returns:
            Configured httpx AsyncClient instance with secure defaults
        """
        async with self._client_lock:
            if self._client is None or self._client.is_closed:
                timeout = httpx.Timeout(
                    connect=self._connect_timeout,
                    read=self._read_timeout,
                    write=self._write_timeout,
                    pool=self._pool_timeout,
                )
                self._client = httpx.AsyncClient(
                    timeout=timeout,
                    limits=httpx.Limits(
                        max_connections=100,
                        max_keepalive_connections=20,
                    ),
                    verify=self._verify_ssl,
                    follow_redirects=True,
                    max_redirects=self._max_redirects,
                    # Security headers
                    headers={
                        'User-Agent': 'Aether/1.0',
                    },
                )
                logger.debug(
                    f"Created new HTTP client (SSL verify: {self._verify_ssl}, "
                    f"max redirects: {self._max_redirects})"
                )
                
            return self._client

    async def reset_client(self) -> None:
        """Reset HTTP client - closes current and creates fresh instance with secure defaults."""
        async with self._client_lock:
            if self._client and not self._client.is_closed:
                await self._client.aclose()
                logger.debug("Closed existing HTTP client")
                
            # Create new client with secure defaults
            timeout = httpx.Timeout(
                connect=self._connect_timeout,
                read=self._read_timeout,
                write=self._write_timeout,
                pool=self._pool_timeout,
            )
            self._client = httpx.AsyncClient(
                timeout=timeout,
                limits=httpx.Limits(
                    max_connections=100,
                    max_keepalive_connections=20,
                ),
                verify=self._verify_ssl,
                follow_redirects=True,
                max_redirects=self._max_redirects,
                headers={
                    'User-Agent': 'Aether/1.0',
                },
            )
            logger.debug("Reset HTTP client with secure defaults")

    @asynccontextmanager
    async def client_context(self):
        """
        Context manager for temporary HTTP client access.
        
        Usage:
            async with config_manager.client_context() as client:
                response = await client.get(url)
        """
        client = await self.get_client()
        try:
            yield client
        except Exception:
            # Reset client on any error to avoid corrupted state
            await self.reset_client()
            raise

    def is_client_available(self) -> bool:
        """Check if HTTP client is available and not closed."""
        return self._client is not None and not self._client.is_closed

    async def close(self) -> None:
        """Close HTTP client and cleanup resources."""
        async with self._client_lock:
            if self._client and not self._client.is_closed:
                await self._client.aclose()
                logger.debug("Closed HTTP client")
            self._client = None

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of configuration and HTTP client.
        
        Returns:
            Dict with health status information
        """
        return {
            "config_loaded": self._config_cache is not None,
            "http_client_available": self.is_client_available(),
            "http_client_closed": (
                self._client.is_closed if self._client else True
            ),
        }

