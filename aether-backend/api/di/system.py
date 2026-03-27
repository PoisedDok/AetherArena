import threading
from typing import Optional
from fastapi import Depends, HTTPException

from monitoring import get_logger
from config.settings import Settings
from core.runtime.engine import RuntimeEngine
from core.system.interfaces import IProcessGateway

from .core import get_settings

logger = get_logger(__name__)

# We use this lock for singletons in this module and possibly others
_init_lock = threading.Lock()

# =============================================================================
# Runtime Engine Dependencies
# =============================================================================

_runtime_engine: Optional[RuntimeEngine] = None


def set_runtime_engine(engine: RuntimeEngine) -> None:
    """Set the global runtime engine instance."""
    global _runtime_engine
    _runtime_engine = engine


def get_runtime_engine() -> RuntimeEngine:
    """
    Get the runtime engine instance.
    
    The runtime engine handles Open Interpreter interactions,
    chat streaming, and integration coordination.
    
    Returns:
        RuntimeEngine: The runtime engine instance
        
    Raises:
        HTTPException: If runtime engine is not initialized
    """
    if _runtime_engine is None:
        logger.error("Runtime engine not initialized")
        raise HTTPException(
            status_code=503,
            detail="Runtime engine not initialized. Server is starting up."
        )
    return _runtime_engine


# =============================================================================
# Process Gateway Dependencies
# =============================================================================

_process_gateway = None

def get_process_gateway():
    """Provide a singleton ProcessGateway instance."""
    global _process_gateway
    if _process_gateway is None:
        with _init_lock:
            if _process_gateway is None:
                from core.system.process_gateway import ProcessGateway
                _process_gateway = ProcessGateway()
    return _process_gateway


# =============================================================================
# Terminal Service Dependencies
# =============================================================================

def get_terminal_service(
    settings: Settings = Depends(get_settings),
    gateway: IProcessGateway = Depends(get_process_gateway)
) -> "TerminalService":
    """Provide a TerminalService instance."""
    from application.terminal.terminal_service import TerminalService
    return TerminalService(
        gateway=gateway,
        allow_local_os_tools=settings.security.allow_local_os_tools
    )


# =============================================================================
# Registry Gateway Dependencies
# =============================================================================

_registry_gateway = None

def get_registry_gateway():
    """Provide a singleton RegistryGateway instance."""
    global _registry_gateway
    if _registry_gateway is None:
        with _init_lock:
            if _registry_gateway is None:
                from data.infrastructure.registry_gateway import RegistryGateway
                from pathlib import Path
                # Go up 4 levels from api/di/system.py to reach the root
                registry_path = Path(__file__).parent.parent.parent.parent / "config" / "integrations_registry.yaml"
                _registry_gateway = RegistryGateway(registry_path)
    return _registry_gateway


# =============================================================================
# HTTP Client Dependencies
# =============================================================================

def get_http_client():
    """Provide a singleton AetherHTTPClient instance."""
    from data.network.http_client import get_http_client as fetch_client
    return fetch_client()

async def close_http_client() -> None:
    """Close the singleton AetherHTTPClient instance."""
    from data.network.http_client import close_http_client as shutdown_client
    await shutdown_client()
