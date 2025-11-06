"""
Cache Layer - Optional caching infrastructure

Provides caching capabilities:
- Redis-based caching (optional)
- TTL management
- Key namespacing
- JSON serialization

Cache layer improves performance for:
- Frequently accessed data
- Expensive computations
- API responses
"""

from .redis import RedisCache

__all__ = ["RedisCache"]

