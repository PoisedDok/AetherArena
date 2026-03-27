"""
Unit Test Configuration

@.architecture
Incoming:  pytest collection phase → {test modules under tests/unit/}
Processing:
  1. Auto-mark all tests with @pytest.mark.unit
  2. Create a SINGLE cached FastAPI app with lifespan neutralised
  3. Inject fresh mock dependencies per-test (function-scoped)
Outgoing:  `app` and `client` fixtures → {all tests under tests/unit/}

Design decisions:
  - `create_app()` is called ONCE per process via functools.lru_cache.
    This eliminates the memory explosion from 300+ separate app instances
    that caused SIGTERM kills on combined runs.
  - The cached app is synchronous (no async fixture scope issues with
    pytest-asyncio 0.23.x).
  - Mock dependencies are injected fresh per-test for full isolation.
  - dependency_overrides is cleared before/after each test so no leaks
    between test files that use overrides (e.g. test_memories_endpoint).

CI pipeline commands:
  Fast unit run:   pytest tests/unit/ -m unit --no-cov -q
  With coverage:   pytest tests/unit/ --cov=. --cov-report=term-missing
  Single module:   pytest tests/unit/api/test_health_endpoint.py -q
"""

import os
import functools

import pytest
import pytest_asyncio
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from httpx import AsyncClient, ASGITransport

# ─── Environment lockdown ────────────────────────────────────────────────────
# Set BEFORE any app/config import.  Root conftest and pytest.ini also set
# these, but this is the belt-and-suspenders layer for isolated runs like:
#   pytest tests/unit/api/test_one.py
os.environ["SKIP_SERVICE_HEALTH_CHECK"] = "1"
os.environ["TESTING"] = "1"
os.environ["AETHER_ENVIRONMENT"] = "test"

from api.dependencies import (
    set_runtime_engine,
    set_database_connection,
    set_file_indexing_repository,
)
from core.mcp.context import set_mcp_manager
from data.network.http_client import close_http_client


# ─── Marker auto-application ────────────────────────────────────────────────

def pytest_collection_modifyitems(items):
    """Auto-apply 'unit' marker to all tests in this directory tree."""
    unit_marker = pytest.mark.unit
    for item in items:
        if "/unit/" in str(item.fspath):
            item.add_marker(unit_marker)


# ─── Null lifespan ──────────────────────────────────────────────────────────

@asynccontextmanager
async def _null_lifespan(app):
    """No-op lifespan.  Prevents Docker, inference, daemons, key-sync."""
    yield


# ─── Cached app creation (called ONCE per process) ─────────────────────────

@functools.lru_cache(maxsize=1)
def _create_unit_app():
    """
    Create and cache a single FastAPI app instance for all unit tests.

    Synchronous — no async fixture scope issues.
    Lifespan fully neutralised — no real service startup.
    """
    from app import create_app

    _app = create_app()

    # Neutralise lifespan: FastAPI stores it on router.lifespan_context.
    _app.router.lifespan_context = _null_lifespan
    # Clear old-style hooks (Starlette compat belt-and-suspenders).
    _app.router.on_startup.clear()
    _app.router.on_shutdown.clear()

    return _app


# ─── Per-test fixtures ──────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def app(test_settings, mock_runtime_engine, mock_mcp_manager, mock_supabase_client):
    """
    Function-scoped app fixture for unit tests.

    Uses a single cached app instance (no repeated create_app() calls).
    Injects fresh mock dependencies per-test.
    Clears dependency_overrides for isolation between tests.
    """
    _app = _create_unit_app()

    # ── Reset per-test state ──
    _app.dependency_overrides.clear()

    # ── Inject mock dependencies ──
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

    yield _app

    # ── Per-test cleanup ──
    _app.dependency_overrides.clear()
    await close_http_client()
    set_runtime_engine(None)
    set_mcp_manager(None)
    set_database_connection(None)
    set_file_indexing_repository(None)


@pytest_asyncio.fixture
async def client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP test client.  Lifespan disabled via the `app` fixture."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
