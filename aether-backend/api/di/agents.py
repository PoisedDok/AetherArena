import threading
from typing import Optional
from fastapi import Depends, HTTPException, Request

from monitoring import get_logger
from config.settings import Settings
from core.mcp.manager import MCPServerManager
from core.mcp.context import get_mcp_manager as _get_mcp_manager
from application.omni import OmniService

from .core import get_settings
from .database import get_database
from .files import require_file_indexing_repository

logger = get_logger(__name__)
_init_lock = threading.Lock()

# =============================================================================
# MCP Manager Dependencies
# =============================================================================

def get_mcp_manager() -> Optional[MCPServerManager]:
    """Proxy access to the shared MCP manager registry."""
    return _get_mcp_manager()


def require_mcp_manager() -> MCPServerManager:
    """
    Get the MCP server manager instance (required).
    """
    manager = _get_mcp_manager()
    if manager is None:
        logger.error("MCP manager not initialized")
        raise HTTPException(
            status_code=503,
            detail="MCP functionality not available. MCP manager not initialized."
        )
    return manager

# =============================================================================
# Tool Service Dependencies
# =============================================================================

_tool_service = None

async def get_tool_service(
    request: Request,
    settings: Settings = Depends(get_settings)
):
    """Provide tool service instance."""
    global _tool_service
    if _tool_service is None:
        with _init_lock:
            if _tool_service is None:
                from application.tools.tool_service import ToolService
                _tool_service = ToolService(settings, request.app)
    return _tool_service

def shutdown_tool_service():
    global _tool_service
    if _tool_service is not None:
        if hasattr(_tool_service, 'dispose'):
            _tool_service.dispose()
        _tool_service = None

# =============================================================================
# Daemon Service Dependencies
# =============================================================================

async def get_daemon_logs_repository(
    settings: Settings = Depends(get_settings)
):
    """Provide daemon logs repository instance."""
    from data.database.repositories.daemon_logs import DaemonLogsRepository
    return DaemonLogsRepository(settings)

async def get_daemon_service(
    settings: Settings = Depends(get_settings),
    file_indexing_repo = Depends(require_file_indexing_repository),
    daemon_logs_repo = Depends(get_daemon_logs_repository),
    database = Depends(get_database)
):
    """Provide DaemonService instance."""
    from application.daemons.daemon_service import DaemonService
    return DaemonService(settings, file_indexing_repo, daemon_logs_repo, database)

# =============================================================================
# Proactive Service Dependencies
# =============================================================================

async def get_proactive_agent_repository(
    database = Depends(get_database)
):
    """Provide ProactiveAgentRepository instance."""
    from data.database.repositories.proactive_agent import ProactiveAgentRepository
    return ProactiveAgentRepository(database)

async def get_proactive_service(
    settings: Settings = Depends(get_settings),
    proactive_repo = Depends(get_proactive_agent_repository)
):
    """Provide ProactiveService instance."""
    from application.agents.proactive_service import ProactiveService
    return ProactiveService(settings, proactive_repo)

def get_proactive_service_for_background(database) -> 'ProactiveService':
    """Provide ProactiveService instance for background tasks."""
    from config.settings import get_settings as load_settings
    from data.database.repositories.proactive_agent import ProactiveAgentRepository
    from application.agents.proactive_service import ProactiveService
    
    settings = load_settings()
    proactive_repo = ProactiveAgentRepository(database)
    return ProactiveService(settings, proactive_repo)

def get_configuration_repository():
    """Provide ConfigurationRepository instance."""
    from data.database.repositories.configuration_repository import ConfigurationRepository
    return ConfigurationRepository()

def get_proactive_config_service(
    settings: Settings = Depends(get_settings),
    config_repo = Depends(get_configuration_repository)
):
    """Provide ProactiveConfigService instance."""
    from application.agents.proactive_config_service import ProactiveConfigService
    return ProactiveConfigService(settings, config_repo)

# =============================================================================
# Skill Service Dependencies
# =============================================================================

def get_file_storage_gateway():
    """Provide FileStorageGateway instance."""
    from data.infrastructure.file_storage_gateway import FileStorageGateway
    return FileStorageGateway()

def get_skill_service(
    settings = Depends(get_settings),
    storage_gateway = Depends(get_file_storage_gateway)
):
    """Provide a SkillService instance."""
    from application.skills.skill_service import SkillService
    return SkillService(settings, storage_gateway)

# =============================================================================
# Omni Service Dependencies
# =============================================================================

_omni_service: Optional[OmniService] = None

def get_omni_service() -> OmniService:
    """Provide a singleton OmniService instance."""
    global _omni_service
    if _omni_service is None:
        with _init_lock:
            if _omni_service is None:
                from core.integrations.libraries.omni.tools import OmniParalegalTools
                _omni_service = OmniService(OmniParalegalTools(None))
    return _omni_service

async def shutdown_omni_service() -> None:
    """Dispose OmniService resources."""
    global _omni_service
    if _omni_service is not None:
        await _omni_service.shutdown()
        _omni_service = None
