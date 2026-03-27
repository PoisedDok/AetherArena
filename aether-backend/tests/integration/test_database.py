"""
Integration Tests: Database

Tests for database operations including repositories, transactions,
queries, and connection management.
"""

import pytest
from uuid import uuid4

from data.database.repositories.chat import ChatRepository
from data.database.repositories.mcp import MCPRepository
from data.database.repositories.storage import StorageRepository
from data.database.persistence_gateway import SupabasePersistenceGateway


# =============================================================================
# Chat Repository Tests
# =============================================================================

class TestChatRepository:
    """Test chat repository operations."""
    
    @pytest.fixture
    async def chat_repo(self, supabase_gateway: SupabasePersistenceGateway):
        """Create chat repository (Supabase)."""
        return ChatRepository(db=supabase_gateway)
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_create_chat(self, chat_repo):
        """Test creating chat session."""
        chat = await chat_repo.create_chat(title="Test Chat")
        assert chat is not None
        assert getattr(chat, "id", None) is not None
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_chat(self, chat_repo):
        """Test retrieving chat session."""
        created = await chat_repo.create_chat(title="Test Chat 2")
        
        # Retrieve it
        chat = await chat_repo.get_chat(created.id)
        
        assert chat is not None
        assert chat.id == created.id
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_list_chats(self, chat_repo):
        """Test listing all chats."""
        # Create multiple chats
        for i in range(3):
            await chat_repo.create_chat(title=f"Test Chat {i}")
        
        chats = await chat_repo.list_chats()
        
        assert len(chats) >= 3
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_delete_chat(self, chat_repo):
        """Test deleting chat."""
        created = await chat_repo.create_chat(title="Delete Test")
        
        # Delete it
        await chat_repo.delete_chat(created.id)
        
        # Verify deleted
        chat = await chat_repo.get_chat(created.id)
        assert chat is None


# =============================================================================
# MCP Repository Tests
# =============================================================================

class TestMCPRepository:
    """Test MCP repository operations."""
    
    @pytest.fixture
    async def mcp_repo(self, supabase_gateway: SupabasePersistenceGateway):
        """Create MCP repository (Supabase)."""
        return MCPRepository(db=supabase_gateway)
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_save_server(self, mcp_repo):
        """Test saving MCP server configuration."""
        name = f"test-mcp-server-{uuid4().hex[:8]}"
        server = None
        try:
            # IMPORTANT: test servers must never leak into the persistent dev DB as enabled/autostart.
            # This test only validates repository persistence, not server execution.
            server = await mcp_repo.create_server(
                name=name,
                display_name="Test MCP Server",
                server_type="local",
                config={"command": "python", "args": ["-c", "print('ok')"]},
                enabled=False,
                auto_start=False,
            )
            assert server is not None
            assert server.name == name
        finally:
            if server is not None:
                await mcp_repo.delete_server(server.id)
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_server(self, mcp_repo):
        """Test retrieving MCP server."""
        name = f"test-mcp-server-{uuid4().hex[:8]}"
        created = None
        try:
            created = await mcp_repo.create_server(
                name=name,
                display_name="Test MCP Server",
                server_type="local",
                config={"command": "python", "args": ["-c", "print('ok')"]},
                enabled=False,
                auto_start=False,
            )
            fetched = await mcp_repo.get_server(created.id)
            assert fetched is not None
            assert fetched.id == created.id
        finally:
            if created is not None:
                await mcp_repo.delete_server(created.id)
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_list_servers(self, mcp_repo):
        """Test listing all MCP servers."""
        # Register multiple servers
        created_ids = []
        created_names = []
        for i in range(3):
            created = await mcp_repo.create_server(
                name=f"test-mcp-list-{uuid4().hex[:6]}-{i}",
                display_name=f"Test MCP {i}",
                server_type="local",
                config={"command": "python", "args": ["-c", "print('ok')"]},
                enabled=False,
                auto_start=False,
            )
            created_ids.append(created.id)
            created_names.append(created.name)
        
        try:
            servers = await mcp_repo.list_servers()
            server_names = {s.name for s in servers}
            for expected_name in created_names:
                assert expected_name in server_names
        finally:
            for server_id in created_ids:
                await mcp_repo.delete_server(server_id)


# =============================================================================
# Storage Repository Tests
# =============================================================================

class TestStorageRepository:
    """Test storage repository operations."""
    
    @pytest.fixture
    async def storage_repo(self, supabase_gateway: SupabasePersistenceGateway):
        """Create storage repository (Supabase)."""
        return StorageRepository(db=supabase_gateway)
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_save_and_load_trail_state(self, storage_repo):
        """Test saving and loading trail state."""
        chat_id = str(uuid4())
        payload = {"hello": "world", "version": 1}
        await storage_repo.save_trail_state(chat_id, payload)
        loaded = await storage_repo.load_trail_state(chat_id)
        assert loaded is not None
        assert loaded.get("hello") == "world"
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_delete_trail_state(self, storage_repo):
        """Test deleting trail state."""
        chat_id = str(uuid4())
        await storage_repo.save_trail_state(chat_id, {"x": 1})
        ok = await storage_repo.delete_trail_state(chat_id)
        assert ok is True
        loaded = await storage_repo.load_trail_state(chat_id)
        assert loaded is None
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_storage_statistics(self, storage_repo):
        """Test retrieving storage statistics."""
        stats = await storage_repo.get_storage_statistics()
        assert isinstance(stats, dict)
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_save_and_load_traceability_data(self, storage_repo):
        """Test saving and loading traceability data."""
        chat_id = str(uuid4())
        payload = {
            "version": "2.0",
            "timestamp": "2026-01-01T00:00:00Z",
            "messages": [],
            "artifacts": [],
            "correlationIndex": [],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "chatMessagesIndex": [[chat_id, []]],
            "chatArtifactsIndex": [[chat_id, []]],
        }
        await storage_repo.save_traceability_data(payload)
        loaded = await storage_repo.load_traceability_data(chat_id)
        assert loaded is not None
        assert loaded.get("version") == "2.0"
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_all_artifacts_returns_list(self, storage_repo):
        """Test artifacts listing returns a list."""
        results = await storage_repo.get_all_artifacts(limit=5)
        assert isinstance(results, list)


# =============================================================================
# Transaction Tests
# =============================================================================

class TestTransactions:
    """Supabase REST operations do not expose SQLAlchemy transactions here."""
    pass


# =============================================================================
# Query Performance Tests
# =============================================================================

class TestQueryPerformance:
    """Performance testing is handled in e2e benchmarks (not in integration tests)."""
    pass

