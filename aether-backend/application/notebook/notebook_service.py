"""
Notebook Application Service

Orchestrates Python runtime environment inspection and module management.
"""

from typing import Dict, Any
from core.integrations.libraries.notebook import nb_search_importable
from monitoring import get_logger

logger = get_logger(__name__)

class NotebookError(Exception):
    """Base class for NotebookService exceptions."""
    pass

class ModuleSearchError(NotebookError):
    """Raised when module search fails."""
    pass

class NotebookService:
    """Application service for notebook and module operations."""
    
    async def search_modules(
        self,
        query: str,
        include_stdlib: bool = True,
        limit: int = 50
    ) -> Dict[str, Any]:
        """Search for importable modules."""
        try:
            result = nb_search_importable(
                query=query,
                include_stdlib=include_stdlib,
                limit=limit
            )
            
            if "error" in result:
                raise ModuleSearchError(result["error"])
            
            logger.debug("Found %d modules matching '%s'", result.get('count', 0), query)
            return result
            
        except ModuleSearchError:
            raise
        except Exception as e:
            logger.error("Module search failed: %s", e, exc_info=True)
            raise ModuleSearchError("Module search failed")


    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
