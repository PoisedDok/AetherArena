from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, AsyncGenerator

class ILlmProviderGateway(ABC):
    """Interface for LlmProviderGateway."""
    @abstractmethod
    async def generate_completion(self, url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout: float) -> Dict[str, Any]: pass
    @abstractmethod
    async def generate_completion_stream(self, url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout: float) -> AsyncGenerator[str, None]: pass
    @abstractmethod
    async def generate_embeddings(self, url: str, payload: Dict[str, Any], timeout: float, headers: Optional[Dict[str, str]]=None) -> Dict[str, Any]: pass
    @abstractmethod
    async def verify_provider(self, url: str, headers: Dict[str, str], timeout: float) -> None: pass
    @abstractmethod
    async def fetch_models(self, url: str, headers: Dict[str, str], timeout: float) -> Dict[str, Any]: pass
    @abstractmethod
    def check_litellm_vision_support(self, model: str) -> bool: pass

class ISearchGateway(ABC):
    """Interface for SearchGateway."""
    @abstractmethod
    async def search_searxng(self, url: str, params: Dict[str, Any], headers: Dict[str, str], timeout: float) -> Dict[str, Any]: pass
    @abstractmethod
    async def search_perplexica(self, url: str, payload: Dict[str, Any], timeout: float, stream: bool=False) -> Any: pass
    @abstractmethod
    async def get_perplexica_models(self, url: str, timeout: float) -> Dict[str, Any]: pass

class IInternalServiceGateway(ABC):
    """Interface for InternalServiceGateway."""
    @abstractmethod
    async def check_health(self, url: str, timeout: float=5.0) -> bool: pass
    @abstractmethod
    async def invoke_agent(self, url: str, payload: Dict[str, Any], timeout: float, stream: bool=False) -> Any: pass
    @abstractmethod
    async def generate_summary(self, url: str, payload: Dict[str, Any], timeout: float) -> Dict[str, Any]: pass
    @abstractmethod
    async def upload_document(self, url: str, files: Dict[str, Any], timeout: float) -> Dict[str, Any]: pass
    @abstractmethod
    async def execute_request(self, method: str, url: str, timeout: float, params: Optional[Dict[str, Any]]=None, json_data: Optional[Dict[str, Any]]=None, headers: Optional[Dict[str, str]]=None) -> Any: pass
