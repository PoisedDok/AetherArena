import threading
from typing import Optional
from fastapi import Depends, HTTPException

from monitoring import get_logger
from config.settings import Settings
from core.system.connection_manager import ConnectionManager

from .core import get_settings
from .database import get_database_connection, get_database
from .chat import get_chat_repository, get_optional_chat_repository

logger = get_logger(__name__)
_init_lock = threading.Lock()

# =============================================================================
# File Indexing Repository Dependencies
# =============================================================================

def set_file_indexing_repository(repository: 'FileIndexingRepository') -> None:
    """Set the global file indexing repository instance."""
    ConnectionManager.get_instance().set_file_indexing_repository(repository)


def get_file_indexing_repository() -> Optional['FileIndexingRepository']:
    """Get file indexing repository if available."""
    return ConnectionManager.get_instance().get_file_indexing_repository()


def require_file_indexing_repository() -> 'FileIndexingRepository':
    """
    Require file indexing repository (raises 503 if not initialized).
    """
    repo = ConnectionManager.get_instance().get_file_indexing_repository()

    if repo is None:
        gateway = get_database_connection()
        if gateway is not None:
            with _init_lock:
                repo = ConnectionManager.get_instance().get_file_indexing_repository()
                if repo is None:
                    try:
                        from data.database.repositories.files import FileIndexingRepository
                        repo = FileIndexingRepository(gateway)
                        ConnectionManager.get_instance().set_file_indexing_repository(repo)
                        logger.info("File indexing repository lazily initialized from active database connection")
                    except Exception as e:
                        logger.error("Failed to lazily initialize file indexing repository: %s", e, exc_info=True)

    if repo is None:
        logger.error("File indexing repository not initialized")
        raise HTTPException(
            status_code=503,
            detail="File indexing service not initialized"
        )
    return repo


async def get_optional_file_indexing_repository(
    database = Depends(get_database_connection)
):
    """Provide optional FileIndexingRepository (returns None if DB is down)."""
    if not database:
        return None
    from data.database.repositories.files import FileIndexingRepository
    return FileIndexingRepository(database)


async def get_index_service(
    settings: Settings = Depends(get_settings),
    repository: 'FileIndexingRepository' = Depends(require_file_indexing_repository)
):
    """Provide index service instance."""
    from application.indexing.index_service import IndexService
    from data.database.repositories.search_indexes import SearchIndexesRepository
    from .database import get_database_connection
    gateway = get_database_connection()
    search_indexes_repo = SearchIndexesRepository(gateway) if gateway else None
    return IndexService(settings, repository, search_indexes_repo)

async def get_notebook_service():
    """Provide notebook service instance."""
    from application.notebook.notebook_service import NotebookService
    return NotebookService()

# =============================================================================
# File Service Dependencies
# =============================================================================

async def get_file_service(
    settings: Settings = Depends(get_settings),
    file_indexing_repo = Depends(require_file_indexing_repository),
    chat_repo = Depends(get_chat_repository)
):
    """Provide FileService instance."""
    from application.files.file_service import FileService
    return FileService(settings, file_indexing_repo, chat_repo)


async def get_optional_file_service(
    settings: Settings = Depends(get_settings),
    file_indexing_repo = Depends(get_optional_file_indexing_repository),
    chat_repo = Depends(get_optional_chat_repository)
):
    """Provide optional FileService instance (returns None if DB is down)."""
    if not file_indexing_repo or not chat_repo:
        return None
    from application.files.file_service import FileService
    return FileService(settings, file_indexing_repo, chat_repo)

# =============================================================================
# Storage Service Dependencies
# =============================================================================

async def get_storage_repository(
    database = Depends(get_database)
):
    """Provide StorageRepository instance."""
    from data.database.repositories.storage import StorageRepository
    return StorageRepository(database)

async def get_trail_repository(
    database = Depends(get_database)
):
    """Provide TrailRepository instance."""
    from data.database.repositories.trail import TrailRepository
    return TrailRepository(database)

async def get_storage_service(
    storage_repo = Depends(get_storage_repository),
    trail_repo = Depends(get_trail_repository),
    chat_repo = Depends(get_chat_repository)
):
    """Provide StorageService instance."""
    from application.storage.storage_service import StorageService
    return StorageService(storage_repo, trail_repo, chat_repo)
