"""
@.architecture

Incoming: api/v1/endpoints/*.py, core/mcp/*.py, app.py --- {repository method calls, entity IDs, data dicts}
Processing: Re-export ChatRepository, MCPRepository, StorageRepository for centralized import --- {JOB_DELEGATE_TO_MODULE}
Outgoing: All modules requiring data access --- {repository classes}


Database Repositories - Data access layer for database operations
==================================================================
Repository pattern implementation for Supabase database operations.

Provides:
- ChatRepository: Chat, message, and artifact operations
- MCPRepository: MCP server, tool, and execution operations
- StorageRepository: File metadata operations
- TrailRepository: Trail schema (Group → Subgroup → Node) operations

Each repository:
- Encapsulates Supabase queries
- Provides domain-focused API
- Handles concurrency/race conditions
- Uses optimistic locking where needed
- Implements retry logic for transient failures

See Also:
- data/database/clients/supabase.py: Database client
- data/database/concurrency.py: Race condition protection
"""

from .chat import ChatRepository
from .mcp import MCPRepository
from .storage import StorageRepository
from .trail import TrailRepository
from .preferences import PreferencesRepository
from .search_indexes import SearchIndexesRepository

__all__ = [
    "ChatRepository",
    "MCPRepository",
    "StorageRepository",
    "TrailRepository",
    "PreferencesRepository",
    "SearchIndexesRepository",
]

