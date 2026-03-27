from abc import ABC, abstractmethod
from typing import Any, Union
from pydantic import BaseModel, ConfigDict
from core.domain.gateway_interfaces import ISearchGateway

class SearchContext(BaseModel):
    """Context passed to all search providers containing necessary dependencies."""
    model_config = ConfigDict(arbitrary_types_allowed=True)
    
    settings: Any
    gateway: ISearchGateway
    uow: Any = None  # SupabaseUnitOfWork instance
    request_context: dict
    request: Any = None

class SearchProvider(ABC):
    """Abstract base class for all search strategies."""
    
    @abstractmethod
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        """
        Execute the search strategy.
        
        Args:
            payload: The search request payload (varies by provider).
            context: The SearchContext with dependencies.
            
        Returns:
            A dictionary or a Pydantic BaseModel representing the search response.
        """
        pass
