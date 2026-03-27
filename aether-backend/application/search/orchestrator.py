from typing import Any, Dict
from pydantic import BaseModel

from application.search.interfaces import SearchProvider, SearchContext

class SearchOrchestrator:
    """Application-layer service managing the registry of SearchProviders."""
    
    def __init__(self):
        self._providers: Dict[str, SearchProvider] = {}

    def register(self, domain: str, provider: SearchProvider) -> None:
        """Register a search provider for a specific domain."""
        self._providers[domain] = provider

    async def execute(self, domain: str, payload: BaseModel, context: SearchContext) -> Any:
        """Execute a search query using the registered provider for the domain."""
        provider = self._providers.get(domain)
        if not provider:
            raise ValueError(f"No search provider registered for domain: {domain}")
        try:
            return await provider.execute(payload, context)
        except Exception:
            # We don't have logger here, but let's just let it bubble or add logger if needed.
            # Actually, it bubbles up to the router where it is logged.
            raise
