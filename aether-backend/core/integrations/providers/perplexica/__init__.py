"""
Perplexica Search Integration - Clean Wrapper Exposure

Exports thin wrapper functions for Perplexica integration.

@.architecture
Incoming: Backend API endpoints, Agent tools --- {import statements}
Processing: Re-export search functions --- {0 jobs: passthrough}
Outgoing: API layer, Agent service layer --- {function references}
"""

from .search import (
    perplexica_search,
    web_search,
    academic_search,
    reddit_search,
    wolfram_search,
    writing_assistant,
    quick_search,
    image_search,
    video_search,
    suggestions,
    discover_news,
    legal_search,
    get_legal_databases_for_jurisdiction,
    LEGAL_DATABASES,
    perplexica_models,
    show_current_model,
    PerplexicaClient
)

__all__ = [
    'perplexica_search',
    'web_search',
    'academic_search',
    'reddit_search',
    'wolfram_search',
    'writing_assistant',
    'quick_search',
    'image_search',
    'video_search',
    'suggestions',
    'discover_news',
    'legal_search',
    'get_legal_databases_for_jurisdiction',
    'LEGAL_DATABASES',
    'perplexica_models',
    'show_current_model',
    'PerplexicaClient'
]

