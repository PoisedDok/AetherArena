"""
@.architecture

Incoming: app.py startup, api/v1/endpoints/*.py, core/mcp/*.py --- {settings dict, repository requests}
Processing: Export SupabaseClient, repositories (Chat/Storage/MCP), models (Chat/Message/Artifact/MCP), concurrency utilities --- {JOB_DELEGATE_TO_MODULE}
Outgoing: All modules requiring database access --- {SupabaseClient instance, repository classes, model classes}


Database Layer - Supabase-powered data infrastructure
======================================================
ONLY database backend: Supabase (PostgreSQL + realtime + auth)

Provides:
- SupabaseClient: Wrapper for Supabase Python SDK
- Repository pattern: ChatRepository, MCPRepository, StorageRepository
- Pydantic models: Type-safe domain entities
- Real-time subscriptions: Live UI updates via Supabase realtime
- Concurrency protection: Optimistic locking, retry logic

Usage:
    from data.database import SupabaseClient, ChatRepository, StorageRepository
    from data.database.models import Chat, Message, Artifact
    
    # Initialize Supabase client (app.py handles this)
    supabase = SupabaseClient.from_env({
        "url": "http://localhost:54321",
        "anon_key": "...",
        "service_role_key": "...",
        "schema": "public",
        "realtime_enabled": True
    })
    await supabase.initialize()
    
    # Initialize repositories
    chat_repo = ChatRepository(supabase)
    storage_repo = StorageRepository(supabase)
    
    # Use repositories
    chat = await chat_repo.create_chat("New Chat")
    messages = await chat_repo.get_messages(chat.id)
    
    # Cleanup
    await supabase.dispose()
"""

from .clients.supabase import SupabaseClient
from .persistence_gateway import SupabasePersistenceGateway
from .models import Artifact, Chat, MCPExecution, MCPServer, MCPTool, Message
from .repositories import ChatRepository, MCPRepository, StorageRepository

__all__ = [
    # Client
    "SupabaseClient",
    "SupabasePersistenceGateway",
    # Models
    "Chat",
    "Message",
    "Artifact",
    "MCPServer",
    "MCPTool",
    "MCPExecution",
    # Repositories
    "ChatRepository",
    "MCPRepository",
    "StorageRepository",
]
