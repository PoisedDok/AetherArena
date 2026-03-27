"""
Pytest Configuration and Shared Fixtures

Provides test fixtures, database setup, mocks, and async support
for comprehensive testing across unit, integration, and e2e tests.
"""

import asyncio
import os
import sys
import tempfile
import subprocess
from urllib.parse import urlparse
from pathlib import Path
from typing import AsyncGenerator, Generator
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# Test environment setup
# CRITICAL: These must be set BEFORE any app/config imports to prevent real service startup.
os.environ["AETHER_ENVIRONMENT"] = "test"
os.environ["TESTING"] = "1"
os.environ["SKIP_SERVICE_HEALTH_CHECK"] = "1"

# Ensure backend root is on sys.path for imports
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import create_app
from config.settings import get_settings, reload_settings, _load_local_env_defaults
from data.network.http_client import AetherHTTPClient as HTTPClient, close_http_client
from api.dependencies import (
    set_runtime_engine,
    set_database_connection,
    set_file_indexing_repository,
)
from core.mcp.context import set_mcp_manager

_load_local_env_defaults()


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
# Event Loop Configuration
# =============================================================================
# REMOVED: Custom event_loop fixture (was session-scoped).
# ROOT CAUSE of 1600+ "no current event loop" failures in combined runs.
#
# pytest-asyncio 0.23+ manages event loops internally via asyncio_mode=auto.
# A custom event_loop fixture CONFLICTS with the framework's loop management:
#   - Framework expects function-scoped loops (one per test)
#   - Custom session-scoped fixture overrides this, causing loop closure/absence
#     for tests that run after the first fixture teardown cycle.
#
# Migration path per pytest-asyncio 0.23 docs:
#   - Remove custom event_loop fixture
#   - Use loop_scope config if session scope needed (not needed for unit tests)
# =============================================================================


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
# Database Fixtures (Supabase)
# =============================================================================

@pytest_asyncio.fixture(scope="function")
async def test_supabase_client(test_settings):
    """
    Create test Supabase client.
    
    For unit tests, this should be mocked.
    For integration tests with real Supabase, use localhost:54321.
    """
    from data.database.clients.supabase import SupabaseClient
    
    # Create client but don't initialize (allows mocking in tests)
    client = SupabaseClient.from_env({
        "url": "http://localhost:54321",
        "anon_key": "test-anon-key",
        "service_role_key": "test-service-key",
        "schema": "public",
        "realtime_enabled": False
    })
    
    yield client
    
    # Cleanup if initialized
    if client.is_initialized():
        await client.dispose()


@pytest.fixture
def mock_supabase_client():
    """Create mock Supabase client for unit tests."""
    from unittest.mock import AsyncMock, MagicMock
    
    mock = MagicMock()
    mock.insert = AsyncMock(return_value={"id": "test-uuid", "created_at": "2024-01-01T00:00:00"})
    mock.select = AsyncMock(return_value=[])
    mock.count = AsyncMock(return_value=0)
    mock.update = AsyncMock(return_value={"id": "test-uuid", "updated_at": "2024-01-01T00:00:00"})
    mock.delete = AsyncMock(return_value=None)
    mock.upsert = AsyncMock(return_value={"id": "test-uuid"})
    mock.health_check = AsyncMock(return_value={"healthy": True})
    mock.is_initialized = MagicMock(return_value=True)
    mock.dispose = AsyncMock()
    
    return mock


# =============================================================================
# FastAPI App Fixtures
# =============================================================================

@pytest_asyncio.fixture
async def app(test_settings, mock_runtime_engine, mock_mcp_manager, mock_supabase_client):
    """
    Create FastAPI app for testing with mock dependencies.

    SAFETY: The lifespan is replaced with a no-op to prevent the app from
    starting Docker, inference server, daemons, or any real infrastructure.
    Integration tests that need real services should use dedicated fixtures
    (requires_supabase, supabase_gateway, etc.) — NOT this app fixture.
    """
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _null_lifespan(_app):
        yield

    app = create_app()

    # Neutralise lifespan — prevent real service startup
    app.router.lifespan_context = _null_lifespan
    app.router.on_startup.clear()
    app.router.on_shutdown.clear()

    # Set up mock dependencies for testing
    set_runtime_engine(mock_runtime_engine)
    set_mcp_manager(mock_mcp_manager)
    from data.database.persistence_gateway import SupabasePersistenceGateway
    gateway = SupabasePersistenceGateway(mock_supabase_client)
    set_database_connection(gateway)
    try:
        from data.database.repositories.files import FileIndexingRepository
        set_file_indexing_repository(FileIndexingRepository(gateway))
    except Exception:
        set_file_indexing_repository(None)
    
    yield app
    
    # Cleanup
    await close_http_client()
    
    # Reset dependencies
    set_runtime_engine(None)
    set_mcp_manager(None)
    set_database_connection(None)
    set_file_indexing_repository(None)


@pytest_asyncio.fixture
async def client(app) -> AsyncGenerator[AsyncClient, None]:
    """Create async HTTP client for API testing."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
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
# Service Availability Fixtures (Real Local E2E)
# =============================================================================

async def _is_tcp_available(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        conn = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


async def _is_http_available(url: str, timeout: float = 5.0) -> bool:
    try:
        async with AsyncClient(timeout=timeout) as client:
            response = await client.get(url)
            return response.status_code < 500
    except Exception:
        return False


def _is_http_available_sync(url: str, timeout: float = 5.0) -> bool:
    """Synchronous HTTP availability check. Used by session-scoped fixtures to
    avoid asyncio event-loop binding issues with pytest-asyncio 0.23.x."""
    import requests as _requests
    try:
        response = _requests.get(url, timeout=timeout)
        return response.status_code < 500
    except Exception:
        return False


def _is_tcp_available_sync(host: str, port: int, timeout: float = 2.0) -> bool:
    """Synchronous TCP availability check."""
    import socket
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def _terminate_process(proc: subprocess.Popen, timeout_seconds: float = 5.0) -> None:
    """
    Best-effort process termination for session-scoped helper services.
    Never raise from cleanup.
    """
    try:
        if proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=timeout_seconds)
        except Exception:
            proc.kill()
    except Exception:
        return


async def _wait_for_http_ready(url: str, timeout_seconds: float = 60.0, interval_seconds: float = 0.5) -> bool:
    """
    Wait for an HTTP endpoint to become reachable.
    """
    deadline = asyncio.get_event_loop().time() + timeout_seconds
    while asyncio.get_event_loop().time() < deadline:
        if await _is_http_available(url):
            return True
        await asyncio.sleep(interval_seconds)
    return False


def _parse_host_port(url: str, default_port: int) -> tuple[str, int]:
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or default_port
    return host, port


@pytest.fixture(scope="session")
def requires_redis(test_settings):
    """Fail fast if Redis is unavailable."""
    redis_url = getattr(test_settings.redis, "url", "redis://localhost:6379/0")
    host, port = _parse_host_port(redis_url, 6379)
    if not _is_tcp_available_sync(host, port):
        pytest.skip(f"Redis not available at {host}:{port}")
    return redis_url


@pytest_asyncio.fixture(scope="session")
async def requires_supabase(test_settings):
    """Fail fast by ensuring local Supabase is up with the configured credentials."""
    supabase_url = getattr(test_settings.supabase, "url", "http://localhost:54321")
    anon_key = getattr(test_settings.supabase, "anon_key", "")
    redis_url = getattr(test_settings.redis, "url", "redis://localhost:6379/0")
    redis_namespace = getattr(test_settings.redis, "namespace", "aether")

    from core.integrations.providers import supabase_docker

    ok = await supabase_docker.ensure_supabase_running(
        url=supabase_url,
        anon_key=anon_key,
        redis_url=redis_url,
        redis_namespace=redis_namespace,
        max_wait_seconds=60,
    )
    if not ok:
        pytest.skip("Supabase failed to start or become healthy (docker + API + redis)")
    return supabase_url


@pytest_asyncio.fixture(scope="session")
async def supabase_gateway(requires_supabase):
    """
    Real Supabase persistence gateway for integration tests.

    Fail-fast: requires a reachable local Supabase instance.
    """
    from data.database.clients.supabase import SupabaseClient
    from data.database.persistence_gateway import SupabasePersistenceGateway

    client = SupabaseClient.from_env()
    try:
        await client.initialize()
    except RuntimeError as e:
        pytest.skip(f"Supabase connection failed: {e}")
    from data.database.migration_runner import run_migrations
    migrations_ok = await run_migrations()
    if not migrations_ok:
        pytest.skip("Supabase migrations failed to apply before tests")
    gateway = SupabasePersistenceGateway(client)
    try:
        yield gateway
    finally:
        await gateway.dispose()


@pytest.fixture(scope="session")
def requires_searxng(test_settings):
    """Fail fast if Searxng is unavailable."""
    url = test_settings.integrations.searxng_url
    if not _is_http_available_sync(url):
        pytest.skip(f"Searxng not available at {url}")
    return url


@pytest.fixture(scope="session")
def requires_perplexica(test_settings):
    """Fail fast if Perplexica is unavailable."""
    url = test_settings.integrations.perplexica_url
    if not _is_http_available_sync(url):
        pytest.skip(f"Perplexica not available at {url}")
    return url


@pytest.fixture(scope="session")
def requires_embeddings(test_settings):
    """
    Ensure embeddings service is available for E2E tests.

    The embedding service runs inside Perplexica's Docker container
    (ONNX via Transformers.js). It must be running before these tests execute.
    There is no auto-start — Docker mesh must be up.
    """
    url = test_settings.embedding_service.service_url

    if not _is_http_available_sync(url):
        pytest.skip(
            f"Embedding service not available at {url}. "
            "Ensure the Docker mesh is running (Perplexica serves POST /api/embeddings on port 3000)."
        )

    return url


@pytest.fixture(scope="session")
def requires_file_indexing(test_settings):
    """Fail fast if file indexing backend is unavailable."""
    url = test_settings.integrations.file_indexing_backend_url
    if not _is_http_available_sync(url):
        pytest.skip(f"File indexing backend not available at {url}")
    return url


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
        "model": "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
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

    server_id = "550e8400-e29b-41d4-a716-446655440000"
    server_record = {
        "id": server_id,
        "name": "test-server",
        "display_name": "Test Server",
        "server_type": "local",
        "status": "stopped",
        "config": {"command": "python", "args": ["-m", "test_mcp_server"]},
        "auto_start": False,
        "enabled": True,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "tools_count": 2,
    }

    tool_list = [
        {
            "function": {
                "name": "tool1",
                "description": "A test tool",
                "parameters": {"type": "object", "properties": {}}
            }
        },
        {
            "function": {
                "name": "tool2",
                "description": "Another test tool",
                "parameters": {"type": "object", "properties": {}}
            }
        }
    ]

    mock.list_servers = AsyncMock(return_value=[server_record])
    mock.get_server = AsyncMock(return_value=server_record)
    mock.get_tools = AsyncMock(return_value=[])
    mock.get_server_tools = AsyncMock(return_value=tool_list)
    mock.get_server_tools_by_name = AsyncMock(return_value=tool_list)
    mock.register_server = AsyncMock(return_value=server_record)
    mock.update_server = AsyncMock(return_value=server_record)
    mock.start_server_by_name = AsyncMock()
    async def _execute_tool(*, server_id: str, tool_name: str, arguments: dict, timeout: int | None = None):
        if tool_name == "failing_tool":
            raise RuntimeError("Tool execution failed")
        return {"result": "success", "arguments": arguments}

    mock.execute_tool = AsyncMock(side_effect=_execute_tool)
    mock.discover_tools = AsyncMock(return_value=["tool1", "tool2"])
    mock.get_server_stats = AsyncMock(return_value={
        "total_executions": 0,
        "successful_executions": 0,
        "failed_executions": 0,
        "average_duration_ms": 0,
        "uptime_seconds": 0,
        "last_execution": None
    })
    mock.get_execution_history = AsyncMock(return_value=[])
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
    mock.get_history = AsyncMock(return_value=[])
    mock.stop_generation = AsyncMock(return_value=None)
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

