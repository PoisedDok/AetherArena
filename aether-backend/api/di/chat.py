import threading
from typing import Optional
from fastapi import Depends

from config.settings import Settings
from data.database.persistence_gateway import SupabasePersistenceGateway
from data.database.uow import SupabaseUnitOfWork

from .core import get_settings
from .database import get_database, get_database_connection, get_supabase_uow
from .system import get_process_gateway

_init_lock = threading.Lock()

# =============================================================================
# Chat Repository Dependencies
# =============================================================================

async def get_chat_repository(
    gateway: SupabasePersistenceGateway = Depends(get_database)
):
    """
    Provide chat repository instance.
    """
    from data.database.repositories.chat import ChatRepository
    return ChatRepository(gateway)


async def get_optional_chat_repository(
    database = Depends(get_database_connection)
):
    """Provide optional ChatRepository (returns None if DB is down)."""
    if not database:
        return None
    from data.database.repositories.chat import ChatRepository
    return ChatRepository(database)


# =============================================================================
# Chat Services
# =============================================================================

async def get_chat_service(
    uow: SupabaseUnitOfWork = Depends(get_supabase_uow),
    settings: Settings = Depends(get_settings),
):
    """
    Provide chat application service bound to the current unit-of-work.
    """
    from application.chat import ChatService
    return ChatService(uow, settings)


async def get_summary_service(
    uow: SupabaseUnitOfWork = Depends(get_supabase_uow),
    settings: Settings = Depends(get_settings),
):
    """
    Provide chat summary service for LLM-powered summarization.
    """
    from application.chat.summary_service import ChatSummaryService
    return ChatSummaryService(uow, settings)


# =============================================================================
# Setup Service Dependencies
# =============================================================================

def get_setup_state_repository():
    """Provide SetupStateRepository instance."""
    from data.database.repositories.setup_state_repository import SetupStateRepository
    return SetupStateRepository()

def get_setup_service(
    settings: Settings = Depends(get_settings),
    process_gateway = Depends(get_process_gateway),
    setup_state_repo = Depends(get_setup_state_repository)
) -> "SetupService":
    """Provide a SetupService instance."""
    from application.setup.setup_service import SetupService
    return SetupService(settings, process_gateway, setup_state_repo)

_setup_orchestrator = None

def get_setup_orchestrator(
    setup_service = Depends(get_setup_service)
):
    """Provide a singleton SetupOrchestrator instance."""
    global _setup_orchestrator
    if _setup_orchestrator is None:
        with _init_lock:
            if _setup_orchestrator is None:
                from application.setup.setup_orchestrator import SetupOrchestrator
                _setup_orchestrator = SetupOrchestrator(setup_service)
    return _setup_orchestrator

# =============================================================================
# Preferences Service Dependencies
# =============================================================================

async def get_preferences_repository(
    database = Depends(get_database_connection)
):
    """Provide PreferencesRepository instance."""
    from data.database.repositories.preferences import PreferencesRepository
    return PreferencesRepository(database)

async def get_preferences_service(
    repo = Depends(get_preferences_repository)
):
    """Provide PreferencesService instance (resilient to missing database)."""
    from application.settings.preferences_service import PreferencesService
    return PreferencesService(repo)


# =============================================================================
# Profile Repository
# =============================================================================

def get_profile_repository():
    """Provide a ProfileRepository instance."""
    from data.database.repositories.profile_repository import ProfileRepository
    return ProfileRepository()
