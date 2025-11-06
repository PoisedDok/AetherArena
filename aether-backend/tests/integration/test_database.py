"""
Integration Tests: Database

Tests for database operations including repositories, transactions,
queries, and connection management.
"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from data.database.repositories.chat import ChatRepository
from data.database.repositories.mcp import MCPRepository
from data.database.repositories.storage import StorageRepository


# =============================================================================
# Chat Repository Tests
# =============================================================================

class TestChatRepository:
    """Test chat repository operations."""
    
    @pytest.fixture
    async def chat_repo(self, db_session: AsyncSession):
        """Create chat repository."""
        return ChatRepository(session=db_session)
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_create_chat(self, chat_repo):
        """Test creating chat session."""
        chat_data = {
            'session_id': 'test-session-001',
            'title': 'Test Chat',
            'created_at': '2024-01-01T00:00:00Z'
        }
        
        chat = await chat_repo.create_chat(chat_data)
        
        assert chat is not None
        assert chat['session_id'] == 'test-session-001'
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_chat(self, chat_repo):
        """Test retrieving chat session."""
        # Create chat first
        chat_data = {
            'session_id': 'test-session-002',
            'title': 'Test Chat 2'
        }
        await chat_repo.create_chat(chat_data)
        
        # Retrieve it
        chat = await chat_repo.get_chat('test-session-002')
        
        assert chat is not None
        assert chat['session_id'] == 'test-session-002'
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_list_chats(self, chat_repo):
        """Test listing all chats."""
        # Create multiple chats
        for i in range(3):
            await chat_repo.create_chat({
                'session_id': f'test-session-list-{i}',
                'title': f'Test Chat {i}'
            })
        
        chats = await chat_repo.list_chats()
        
        assert len(chats) >= 3
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_add_message(self, chat_repo):
        """Test adding message to chat."""
        # Create chat
        session_id = 'test-session-messages'
        await chat_repo.create_chat({
            'session_id': session_id,
            'title': 'Message Test'
        })
        
        # Add message
        message = await chat_repo.add_message({
            'session_id': session_id,
            'role': 'user',
            'content': 'Hello!',
            'timestamp': '2024-01-01T00:00:00Z'
        })
        
        assert message is not None
        assert message['content'] == 'Hello!'
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_chat_history(self, chat_repo):
        """Test retrieving chat history."""
        session_id = 'test-session-history'
        
        # Create chat
        await chat_repo.create_chat({
            'session_id': session_id,
            'title': 'History Test'
        })
        
        # Add messages
        for i in range(5):
            await chat_repo.add_message({
                'session_id': session_id,
                'role': 'user' if i % 2 == 0 else 'assistant',
                'content': f'Message {i}'
            })
        
        # Get history
        history = await chat_repo.get_history(session_id)
        
        assert len(history) >= 5
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_delete_chat(self, chat_repo):
        """Test deleting chat."""
        session_id = 'test-session-delete'
        
        # Create chat
        await chat_repo.create_chat({
            'session_id': session_id,
            'title': 'Delete Test'
        })
        
        # Delete it
        await chat_repo.delete_chat(session_id)
        
        # Verify deleted
        chat = await chat_repo.get_chat(session_id)
        assert chat is None


# =============================================================================
# MCP Repository Tests
# =============================================================================

class TestMCPRepository:
    """Test MCP repository operations."""
    
    @pytest.fixture
    async def mcp_repo(self, db_session: AsyncSession):
        """Create MCP repository."""
        return MCPRepository(session=db_session)
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_save_server(self, mcp_repo):
        """Test saving MCP server configuration."""
        server_data = {
            'name': 'test-mcp-server-001',
            'command': 'python',
            'args': ['-m', 'test_server'],
            'enabled': True
        }
        
        server = await mcp_repo.save_server(server_data)
        
        assert server is not None
        assert server['name'] == 'test-mcp-server-001'
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_server(self, mcp_repo):
        """Test retrieving MCP server."""
        # Save server
        await mcp_repo.save_server({
            'name': 'test-mcp-server-002',
            'command': 'python',
            'enabled': True
        })
        
        # Retrieve it
        server = await mcp_repo.get_server('test-mcp-server-002')
        
        assert server is not None
        assert server['name'] == 'test-mcp-server-002'
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_list_servers(self, mcp_repo):
        """Test listing all MCP servers."""
        # Save multiple servers
        for i in range(3):
            await mcp_repo.save_server({
                'name': f'test-mcp-list-{i}',
                'command': 'python',
                'enabled': True
            })
        
        servers = await mcp_repo.list_servers()
        
        assert len(servers) >= 3
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_track_tool_execution(self, mcp_repo):
        """Test tracking tool execution."""
        execution_data = {
            'server_name': 'test-server',
            'tool_name': 'test_tool',
            'args': {'param': 'value'},
            'result': {'status': 'success'},
            'duration_ms': 150,
            'timestamp': '2024-01-01T00:00:00Z'
        }
        
        execution = await mcp_repo.track_execution(execution_data)
        
        assert execution is not None
        assert execution['tool_name'] == 'test_tool'
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_execution_history(self, mcp_repo):
        """Test retrieving execution history."""
        server_name = 'test-server-history'
        
        # Track multiple executions
        for i in range(5):
            await mcp_repo.track_execution({
                'server_name': server_name,
                'tool_name': f'tool_{i}',
                'duration_ms': 100 + i
            })
        
        history = await mcp_repo.get_execution_history(server_name)
        
        assert len(history) >= 5
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_statistics(self, mcp_repo):
        """Test getting execution statistics."""
        server_name = 'test-server-stats'
        
        # Track executions
        for i in range(10):
            await mcp_repo.track_execution({
                'server_name': server_name,
                'tool_name': 'test_tool',
                'duration_ms': 100 + i * 10
            })
        
        stats = await mcp_repo.get_statistics(server_name)
        
        assert stats is not None
        assert stats['total_executions'] >= 10


# =============================================================================
# Storage Repository Tests
# =============================================================================

class TestStorageRepository:
    """Test storage repository operations."""
    
    @pytest.fixture
    async def storage_repo(self, db_session: AsyncSession):
        """Create storage repository."""
        return StorageRepository(session=db_session)
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_save_file_metadata(self, storage_repo):
        """Test saving file metadata."""
        file_data = {
            'file_id': 'test-file-001',
            'filename': 'test.pdf',
            'size_bytes': 12345,
            'mime_type': 'application/pdf',
            'uploaded_at': '2024-01-01T00:00:00Z'
        }
        
        file_meta = await storage_repo.save_file(file_data)
        
        assert file_meta is not None
        assert file_meta['file_id'] == 'test-file-001'
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_file_metadata(self, storage_repo):
        """Test retrieving file metadata."""
        # Save file
        await storage_repo.save_file({
            'file_id': 'test-file-002',
            'filename': 'test2.pdf',
            'size_bytes': 54321
        })
        
        # Retrieve it
        file_meta = await storage_repo.get_file('test-file-002')
        
        assert file_meta is not None
        assert file_meta['file_id'] == 'test-file-002'
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_list_files(self, storage_repo):
        """Test listing files."""
        # Save multiple files
        for i in range(3):
            await storage_repo.save_file({
                'file_id': f'test-file-list-{i}',
                'filename': f'test{i}.pdf',
                'size_bytes': 1000 * (i + 1)
            })
        
        files = await storage_repo.list_files()
        
        assert len(files) >= 3
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_delete_file(self, storage_repo):
        """Test deleting file metadata."""
        file_id = 'test-file-delete'
        
        # Save file
        await storage_repo.save_file({
            'file_id': file_id,
            'filename': 'delete.pdf',
            'size_bytes': 999
        })
        
        # Delete it
        await storage_repo.delete_file(file_id)
        
        # Verify deleted
        file_meta = await storage_repo.get_file(file_id)
        assert file_meta is None
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_get_storage_stats(self, storage_repo):
        """Test getting storage statistics."""
        # Save files
        for i in range(5):
            await storage_repo.save_file({
                'file_id': f'test-file-stats-{i}',
                'filename': f'file{i}.pdf',
                'size_bytes': 10000 * (i + 1)
            })
        
        stats = await storage_repo.get_statistics()
        
        assert stats is not None
        assert stats['total_files'] >= 5
        assert stats['total_size_bytes'] > 0


# =============================================================================
# Transaction Tests
# =============================================================================

class TestTransactions:
    """Test database transactions."""
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_transaction_commit(self, db_session):
        """Test transaction commit."""
        chat_repo = ChatRepository(session=db_session)
        
        async with db_session.begin():
            await chat_repo.create_chat({
                'session_id': 'test-transaction-commit',
                'title': 'Transaction Test'
            })
        
        # Verify committed
        chat = await chat_repo.get_chat('test-transaction-commit')
        assert chat is not None
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.asyncio
    async def test_transaction_rollback(self, db_session):
        """Test transaction rollback."""
        chat_repo = ChatRepository(session=db_session)
        
        try:
            async with db_session.begin():
                await chat_repo.create_chat({
                    'session_id': 'test-transaction-rollback',
                    'title': 'Rollback Test'
                })
                # Force rollback
                raise Exception("Force rollback")
        except Exception:
            pass
        
        # Verify rolled back
        chat = await chat_repo.get_chat('test-transaction-rollback')
        assert chat is None


# =============================================================================
# Query Performance Tests
# =============================================================================

class TestQueryPerformance:
    """Test query performance."""
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_bulk_insert_performance(self, db_session):
        """Test bulk insert performance."""
        chat_repo = ChatRepository(session=db_session)
        
        # Insert 100 chats
        import time
        start = time.time()
        
        for i in range(100):
            await chat_repo.create_chat({
                'session_id': f'perf-test-{i}',
                'title': f'Performance Test {i}'
            })
        
        duration = time.time() - start
        
        # Should complete in reasonable time (< 5 seconds)
        assert duration < 5.0
    
    @pytest.mark.integration
    @pytest.mark.requires_db
    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_query_performance(self, db_session):
        """Test query performance."""
        chat_repo = ChatRepository(session=db_session)
        
        # Query many times
        import time
        start = time.time()
        
        for _ in range(50):
            await chat_repo.list_chats()
        
        duration = time.time() - start
        
        # Should complete in reasonable time (< 2 seconds)
        assert duration < 2.0

