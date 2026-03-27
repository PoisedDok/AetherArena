"""
Infrastructure Layer - External system adapters

This layer contains:
- cache/: Redis and memory cache adapters
- persistence/: Database repository adapters

ALL code in this layer:
- Implements clean interfaces for external systems
- Translates errors to domain exceptions
- Hides implementation details (Supabase, Redis)
- NO business logic
"""

from ws.infrastructure.cache.redis_adapter import RedisAdapter
from ws.infrastructure.cache.memory_fallback import MemoryFallbackCache
from ws.infrastructure.persistence.trail_repository_adapter import TrailRepositoryAdapter

__all__ = [
    "RedisAdapter",
    "MemoryFallbackCache",
    "TrailRepositoryAdapter",
]

