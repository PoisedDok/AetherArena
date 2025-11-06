"""
Pytest Configuration and Shared Fixtures

Provides test fixtures, database setup, mocks, and async support
for comprehensive testing across unit, integration, and e2e tests.
"""

import asyncio
import os
import tempfile
from pathlib import Path
from typing import AsyncGenerator, Generator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient

# Test environment setup
os.environ["AETHER_ENVIRONMENT"] = "test"
os.environ["TESTING"] = "1"

from app import create_app
from config.settings import get_settings, reload_settings
from data.database.connection import DatabaseConnection
from utils.http import HTTPClient, close_http_client
from api.dependencies import (
    set_runtime_engine,
    set_mcp_manager,
    set_database_connection
)


# =============================================================================
# Pytest Configuration
# =============================================================================

def pytest_configure(config):
    """Configure pytest with custom markers."""
    config.addinivalue_line(
        "markers", "unit: Unit tests that test individual components"
    )
    config.addinivalue_line(
        "markers", "integration: Integration tests that test component interactions"
    )
    config.addinivalue_line(
        "markers", "e2e: End-to-end tests that test complete workflows"
    )
    config.addinivalue_line(
        "markers", "slow: Tests that take significant time to run"
    )
    config.addinivalue_line(
        "markers", "requires_db: Tests that require database connection"
    )
    config.addinivalue_line(
        "markers", "requires_services: Tests that require external services"
    )


# =============================================================================
# Event Loop Fixtures
# =============================================================================

@pytest.fixture(scope="session")
def event_loop():
    """Create event loop for async tests."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


# =============================================================================
# Settings Fixtures
# =============================================================================

@pytest.fixture(scope="session")
def test_settings():
    """Load test settings."""
    reload_settings()  # Clear cache and reload with test environment
    return get_settings()


@pytest.fixture(autouse=True)
def reset_settings():
    """Reset settings after each test."""
    yield
    reload_settings()


# =============================================================================
# Temporary Directory Fixtures
# =============================================================================

@pytest.fixture
def temp_dir() -> Generator[Path, None, None]:
    """Create temporary directory for tests."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def temp_storage_dir(temp_dir: Path) -> Path:
    """Create temporary storage directory."""
    storage_dir = temp_dir / "storage"
    storage_dir.mkdir(parents=True, exist_ok=True)
    return storage_dir


@pytest.fixture
def temp_db_path(temp_dir: Path) -> Path:
    """Create temporary database path."""
    return temp_dir / "test.db"


# =============================================================================
# Database Fixtures
# =============================================================================

@pytest_asyncio.fixture(scope="function")
async def test_db(test_settings, temp_db_path: Path) -> AsyncGenerator[DatabaseConnection, None]:
    """Create test database connection (SQLite for testing)."""
    # Use SQLite for fast tests
    database_url = f"postgresql://localhost/{temp_db_path}"
    
    # For testing, use a simpler in-memory approach
    # In actual use, PostgreSQL would be used
    db = DatabaseConnection(database_url)
    
    try:
        await db.connect()
        # Initialize schema from SQL files
        schema_path = Path(__file__).parent.parent / "data" / "database" / "migrations" / "schema.sql"
        if schema_path.exists():
            await db.initialize_schema(schema_path)
        
        yield db
    finally:
        await db.disconnect()


@pytest_asyncio.fixture
async def db_session(test_db: DatabaseConnection):
    """Create test database session/connection."""
    async with test_db.get_connection() as conn:
        yield conn


# =============================================================================
# FastAPI App Fixtures
# =============================================================================

@pytest_asyncio.fixture
async def app(test_settings, mock_runtime_engine, mock_mcp_manager):
    """Create FastAPI app for testing with mock dependencies."""
    app = create_app()
    
    # Set up mock dependencies for testing
    set_runtime_engine(mock_runtime_engine)
    set_mcp_manager(mock_mcp_manager)
    
    # Note: Database connection is optional for most tests
    # Individual tests can set it up if needed
    
    yield app
    
    # Cleanup
    await close_http_client()
    
    # Reset dependencies
    set_runtime_engine(None)
    set_mcp_manager(None)


@pytest_asyncio.fixture
async def client(app) -> AsyncGenerator[AsyncClient, None]:
    """Create async HTTP client for API testing."""
    async with AsyncClient(app=app, base_url="http://test") as ac:
        yield ac


# =============================================================================
# HTTP Client Fixtures
# =============================================================================

@pytest_asyncio.fixture
async def http_client() -> AsyncGenerator[HTTPClient, None]:
    """Create HTTP client for testing."""
    client = HTTPClient()
    yield client
    await client.close()


@pytest.fixture
def mock_http_client():
    """Create mock HTTP client."""
    mock = AsyncMock(spec=HTTPClient)
    mock.get = AsyncMock()
    mock.post = AsyncMock()
    mock.put = AsyncMock()
    mock.delete = AsyncMock()
    mock.health_check = AsyncMock(return_value=True)
    return mock


# =============================================================================
# Integration Service Mocks
# =============================================================================

@pytest.fixture
def mock_perplexica_response():
    """Mock Perplexica search response."""
    return {
        "results": [
            {
                "title": "Test Result 1",
                "url": "https://example.com/1",
                "content": "Test content 1",
                "score": 0.95
            },
            {
                "title": "Test Result 2",
                "url": "https://example.com/2",
                "content": "Test content 2",
                "score": 0.85
            }
        ],
        "query": "test query",
        "total": 2
    }


@pytest.fixture
def mock_docling_response():
    """Mock Docling conversion response."""
    return {
        "status": "success",
        "document_id": "test-doc-123",
        "text": "Extracted document text",
        "metadata": {
            "pages": 5,
            "tables": 2,
            "images": 3
        },
        "tables": [
            {
                "page": 1,
                "data": [["Header 1", "Header 2"], ["Row 1", "Data 1"]]
            }
        ]
    }


@pytest.fixture
def mock_lm_studio_response():
    """Mock LM Studio chat completion response."""
    return {
        "id": "chatcmpl-test123",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "qwen/qwen3-4b-2507",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "This is a test response from the LLM."
                },
                "finish_reason": "stop"
            }
        ],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 20,
            "total_tokens": 30
        }
    }


@pytest.fixture
def mock_xlwings_response():
    """Mock XLWings Excel operation response."""
    return {
        "status": "success",
        "workbook_id": "test-wb-123",
        "sheet": "Sheet1",
        "data": [
            ["A1", "B1", "C1"],
            ["A2", "B2", "C2"]
        ]
    }


# =============================================================================
# MCP Mocks
# =============================================================================

@pytest.fixture
def mock_mcp_server():
    """Create mock MCP server."""
    mock = MagicMock()
    mock.server_id = "test-mcp-server"
    mock.name = "Test MCP Server"
    mock.status = "running"
    mock.tools = ["tool1", "tool2"]
    mock.start = AsyncMock()
    mock.stop = AsyncMock()
    mock.health_check = AsyncMock(return_value=True)
    return mock


@pytest.fixture
def mock_mcp_manager():
    """Create mock MCP manager."""
    mock = MagicMock()

    # Mock the database
    mock.db = MagicMock()
    mock.db.get_server_by_name = AsyncMock(return_value={"id": "test-uuid", "name": "test-server"})

    mock.list_servers = AsyncMock(return_value=[])
    mock.get_server = AsyncMock(return_value=None)
    mock.get_tools = AsyncMock(return_value=[])
    mock.get_server_tools = AsyncMock(return_value=[
        {
            "name": "tool1",
            "display_name": "Tool 1",
            "description": "A test tool",
            "schema": {"type": "object", "properties": {}}
        },
        {
            "name": "tool2",
            "display_name": "Tool 2",
            "description": "Another test tool",
            "schema": {"type": "object", "properties": {}}
        }
    ])
    mock.start_server = AsyncMock()
    mock.stop_server = AsyncMock()
    mock.execute_tool = AsyncMock(return_value={"result": "success"})
    mock.discover_tools = AsyncMock(return_value=["tool1", "tool2"])
    return mock


# =============================================================================
# Runtime Mocks
# =============================================================================

@pytest.fixture
def mock_interpreter():
    """Create mock Open Interpreter."""
    mock = MagicMock()
    mock.chat = AsyncMock(return_value=[{"type": "message", "content": "Test response"}])
    mock.reset = MagicMock()
    return mock


@pytest.fixture
def mock_runtime_engine():
    """Create mock runtime engine."""
    async def mock_stream_chat(**kwargs):
        """Mock async generator for stream_chat."""
        yield {"type": "text", "content": "Test "}
        yield {"type": "text", "content": "response"}
        yield {"type": "done"}
    
    mock = MagicMock()
    mock.process_message = AsyncMock(return_value={"response": "Test response"})
    mock.stream_chat = mock_stream_chat
    mock.process_file = AsyncMock(return_value={"status": "processed"})
    return mock


# =============================================================================
# Test Data Factories
# =============================================================================

@pytest.fixture
def chat_message_factory():
    """Factory for creating test chat messages."""
    def create(role: str = "user", content: str = "Test message", **kwargs):
        return {
            "role": role,
            "content": content,
            "timestamp": 1234567890,
            **kwargs
        }
    return create


@pytest.fixture
def file_upload_factory(temp_dir: Path):
    """Factory for creating test file uploads."""
    def create(filename: str = "test.txt", content: bytes = b"Test content", **kwargs):
        file_path = temp_dir / filename
        file_path.write_bytes(content)
        return {
            "filename": filename,
            "content": content,
            "path": file_path,
            **kwargs
        }
    return create


@pytest.fixture
def mcp_server_factory():
    """Factory for creating test MCP server configs."""
    def create(name: str = "test-server", **kwargs):
        return {
            "name": name,
            "command": "python",
            "args": ["-m", "test_mcp_server"],
            "enabled": True,
            **kwargs
        }
    return create


# =============================================================================
# Async Helpers
# =============================================================================

@pytest.fixture
def async_mock():
    """Helper to create async mock functions."""
    def create_async_mock(return_value=None):
        mock = AsyncMock()
        if return_value is not None:
            mock.return_value = return_value
        return mock
    return create_async_mock


# =============================================================================
# Cleanup Fixtures
# =============================================================================

@pytest.fixture(autouse=True)
async def cleanup_after_test():
    """Cleanup resources after each test."""
    yield
    # Close global HTTP client
    await close_http_client()

