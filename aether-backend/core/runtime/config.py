"""
Configuration and HTTP Client Manager
Consolidated from settings_manager.py and http_client_manager.py

@.architecture
Incoming: core/runtime/engine.py, utils/config.py --- {Settings, Dict[str, Any]}
Processing: load centralized configuration, apply runtime settings, manage shared HTTP client lifecycle, cleanup resources --- {JOB_APPLY_CONFIG, JOB_CLEANUP_RESOURCE, JOB_LOAD_CONFIG, JOB_MANAGE_CLIENT}
Outgoing: core/runtime/engine.py, external LLM APIs --- {Settings, httpx.AsyncClient}
"""

import asyncio
import logging
from dataclasses import dataclass
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

__all__ = ["RuntimeConfig", "ConfigManager"]


@dataclass
class RuntimeConfig:
    """
    Lightweight runtime configuration container with sensible defaults.
    """

    context_window: int = 100_000
    max_tokens: int = 4_096
    timeout: float = 600.0
    stream_chunk_interval: float = 0.05
    max_queue_size: int = 100
    allow_parallel_requests: bool = True

    def __post_init__(self) -> None:
        if self.context_window <= 0:
            raise ValueError("context_window must be positive")
        if self.max_tokens <= 0:
            raise ValueError("max_tokens must be positive")
        if self.timeout <= 0:
            raise ValueError("timeout must be positive")
        if self.stream_chunk_interval <= 0:
            raise ValueError("stream_chunk_interval must be positive")
        if self.max_queue_size <= 0:
            raise ValueError("max_queue_size must be positive")

    @classmethod
    def from_settings(cls, settings: Any) -> "RuntimeConfig":
        """
        Build runtime configuration from application settings.
        """
        default = cls()

        llm_settings = getattr(settings, "llm", None)
        context_window = getattr(llm_settings, "context_window", default.context_window) if llm_settings else default.context_window
        max_tokens = getattr(llm_settings, "max_tokens", default.max_tokens) if llm_settings else default.max_tokens

        embeddings_settings = getattr(settings, "embeddings", None)
        timeout_candidate = getattr(embeddings_settings, "timeout_seconds", None) if embeddings_settings else None
        timeout = float(timeout_candidate) if isinstance(timeout_candidate, (int, float)) and timeout_candidate > 0 else default.timeout

        return cls(
            context_window=context_window,
            max_tokens=max_tokens,
            timeout=timeout,
            stream_chunk_interval=default.stream_chunk_interval,
            max_queue_size=default.max_queue_size,
            allow_parallel_requests=default.allow_parallel_requests,
        )


try:  # Ensure legacy test suites referencing bare RuntimeConfig continue to work
    import builtins

    if not hasattr(builtins, "RuntimeConfig"):
        setattr(builtins, "RuntimeConfig", RuntimeConfig)
except (AttributeError, TypeError):  # pragma: no cover - defensive safeguard
    logger.debug("Unable to register RuntimeConfig in builtins", exc_info=True)


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
                
        except Exception as e:  # noqa: BLE001 -- config loading: must return defaults on any failure
            logger.warning("Failed to load centralized config, using defaults: %s", e)
            return base_settings

    def _load_centralized_config(self) -> Optional[Dict[str, Any]]:
        """Load LLM configuration from centralized TOML file."""
        if self._config_cache is not None:
            return self._config_cache
            
        try:
            from utils.config import get_llm_settings
            config = get_llm_settings()
            
            # Validate required fields
            required_fields = [
                "provider", "api_base", "model", "supports_vision",
                "context_window", "max_tokens"
            ]
            missing = [field for field in required_fields if field not in config]
            if missing:
                logger.error("Centralized config missing required fields: %s", missing)
                return None
                
            self._config_cache = config
            logger.info(
                "Loaded centralized config - Model: %s, API: %s",
                config['model'],
                config['api_base']
            )
            return config
            
        except Exception as e:  # noqa: BLE001 -- config loading: return None on any failure
            logger.warning("Failed to load centralized config: %s", e)
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
            "Applied centralized config - Model: %s, API: %s",
            config['model'],
            config['api_base']
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
                    "Created new HTTP client (SSL verify: %s, max redirects: %s)",
                    self._verify_ssl,
                    self._max_redirects
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
        except Exception:  # noqa: BLE001 -- context manager boundary: must reset client on any caller error, then re-raise
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

