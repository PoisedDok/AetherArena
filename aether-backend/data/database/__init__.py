"""
Database Layer - Complete database infrastructure

Provides:
- Connection management with async pooling
- Repository pattern for data access
- Pydantic models for type safety
- Schema migrations (SQL files)

Usage:
    from data.database import DatabaseConnection, ChatRepository, MCPRepository
    
    # Initialize connection
    db = DatabaseConnection(connection_url)
    await db.connect()
    
    # Initialize repositories
    chat_repo = ChatRepository(db)
    mcp_repo = MCPRepository(db)
    
    # Use repositories
    chat = await chat_repo.create_chat("New Chat")
    messages = await chat_repo.get_messages(chat.id)
    
    # Cleanup
    await db.disconnect()
"""

from .connection import DatabaseConnection
from .models import Artifact, Chat, MCPExecution, MCPServer, MCPTool, Message
from .repositories import ChatRepository, MCPRepository, StorageRepository

__all__ = [
    # Connection
    "DatabaseConnection",
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
