from typing import Any, Union
from core.exceptions import UpstreamServiceError
from pydantic import BaseModel

from application.search.interfaces import SearchProvider, SearchContext
from core.integrations.providers.perplexica.search import (
    academic_search,
    reddit_search,
    wolfram_search,
    writing_assistant,
    image_search,
    video_search,
    suggestions,
    discover_news,
)

class DiscoverRequest(BaseModel):
    """Payload model for discover endpoint."""
    topic: str
    mode: str

class PerplexicaBaseProvider(SearchProvider):
    """Base provider for all Perplexica-dependent searches."""
    
    def check_enabled(self, context: SearchContext):
        if not context.settings.integrations.perplexica_enabled:
            raise UpstreamServiceError(
                "Perplexica search is not enabled",
                status_code=503
            )

    def handle_error(self, result: Any, provider_name: str):
        if isinstance(result, dict) and "error" in result:
            raise UpstreamServiceError(
                f"{provider_name} failed: {result['error']}",
                status_code=502
            )

class AcademicSearchProvider(PerplexicaBaseProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        self.check_enabled(context)
        result = await academic_search(
            query=getattr(payload, "query", ""),
            mode=getattr(payload, "mode", "balanced")
        )
        self.handle_error(result, "Academic search")
        return result

class RedditSearchProvider(PerplexicaBaseProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        self.check_enabled(context)
        result = await reddit_search(
            query=getattr(payload, "query", ""),
            mode=getattr(payload, "mode", "balanced")
        )
        self.handle_error(result, "Reddit search")
        return result

class WolframSearchProvider(PerplexicaBaseProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        self.check_enabled(context)
        result = await wolfram_search(
            query=getattr(payload, "query", ""),
            mode=getattr(payload, "mode", "balanced")
        )
        self.handle_error(result, "Wolfram search")
        return result

class WritingAssistantProvider(PerplexicaBaseProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        self.check_enabled(context)
        result = await writing_assistant(
            query=getattr(payload, "query", ""),
            mode=getattr(payload, "mode", "balanced")
        )
        self.handle_error(result, "Writing assist")
        return result

class ImageSearchProvider(PerplexicaBaseProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        self.check_enabled(context)
        result = await image_search(query=getattr(payload, "query", ""))
        self.handle_error(result, "Image search")
        return result

class VideoSearchProvider(PerplexicaBaseProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        self.check_enabled(context)
        result = await video_search(query=getattr(payload, "query", ""))
        self.handle_error(result, "Video search")
        return result

class SuggestionsProvider(PerplexicaBaseProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        self.check_enabled(context)
        result = await suggestions(history=getattr(payload, "history", []))
        self.handle_error(result, "Suggestions")
        return result

class DiscoverProvider(PerplexicaBaseProvider):
    async def execute(self, payload: BaseModel, context: SearchContext) -> Union[dict, BaseModel]:
        self.check_enabled(context)
        result = await discover_news(
            topic=getattr(payload, "topic", "tech"),
            mode=getattr(payload, "mode", "normal")
        )
        self.handle_error(result, "Discover")
        return result
