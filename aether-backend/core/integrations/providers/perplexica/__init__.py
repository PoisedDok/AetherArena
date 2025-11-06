"""
Perplexica Search Integration - Layer 2 Exposure

Exports all Perplexica search functions for integration loading.
"""

from .search import (
    perplexica_search,
    web_search,
    academic_search,
    reddit_search,
    wolfram_search,
    writing_assistant,
    quick_search,
    answer_with_sources,
    perplexica_discover,
    perplexica_models,
    show_current_model,
    get_perplexica_available_models,
    get_lm_studio_models,
    find_best_model_match
)

__all__ = [
    'perplexica_search',
    'web_search',
    'academic_search',
    'reddit_search',
    'wolfram_search',
    'writing_assistant',
    'quick_search',
    'answer_with_sources',
    'perplexica_discover',
    'perplexica_models',
    'show_current_model',
    'get_perplexica_available_models',
    'get_lm_studio_models',
    'find_best_model_match'
]

