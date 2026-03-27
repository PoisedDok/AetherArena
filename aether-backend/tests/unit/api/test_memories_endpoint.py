"""
Memory Management Endpoint Tests

Covers all 10 routes in api/v1/endpoints/memories.py:
  POST   /v1/memory/create
  GET    /v1/memory/list
  GET    /v1/memory/get/{memory_id}
  PATCH  /v1/memory/update/{memory_id}
  DELETE /v1/memory/delete/{memory_id}
  POST   /v1/memory/promote/{memory_id}
  POST   /v1/memory/demote/{memory_id}
  GET    /v1/memory/relation/list/{memory_id}
  POST   /v1/memory/relation/create/{memory_id}
  DELETE /v1/memory/relation/delete/{relation_id}

Mocking strategy:
  - MemoryService: injected via app.dependency_overrides on get_memory_service
  - Ensures FastAPI actually resolves the mock instead of the real dependency chain
"""

import pytest
import pytest_asyncio
from uuid import uuid4
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone

from httpx import AsyncClient, ASGITransport


NOW_ISO = datetime.now(timezone.utc).isoformat()
MEM_ID = str(uuid4())
REL_ID = str(uuid4())
CHAT_ID = str(uuid4())

MOCK_MEMORY = {
    "id": MEM_ID,
    "content": "The user prefers dark mode",
    "memory_type": "preference",
    "importance_score": 0.8,
    "source_chat_id": None,
    "source_message_id": None,
    "extracted_at": NOW_ISO,
    "last_accessed_at": None,
    "access_count": 0,
    "metadata": {},
    "created_by": "system",
    "updated_at": NOW_ISO,
    "expires_at": None,
}

MOCK_RELATION = {
    "id": REL_ID,
    "memory_id": MEM_ID,
    "related_memory_id": str(uuid4()),
    "relation_type": "similar",
    "strength": 0.9,
    "created_at": NOW_ISO,
}


def _make_memory_service():
    """Create a fully-mocked MemoryService."""
    svc = AsyncMock()
    svc.create_memory = AsyncMock(return_value=MOCK_MEMORY)
    svc.list_memories = AsyncMock(return_value=[MOCK_MEMORY])
    svc.get_memory = AsyncMock(return_value=MOCK_MEMORY)
    svc.update_memory = AsyncMock(return_value=MOCK_MEMORY)
    svc.delete_memory = AsyncMock(return_value=None)
    svc.promote_to_global = AsyncMock(return_value=MOCK_MEMORY)
    svc.demote_to_chat = AsyncMock(return_value=MOCK_MEMORY)
    svc.get_memory_relations = AsyncMock(return_value=[MOCK_RELATION])
    svc.create_memory_relation = AsyncMock(return_value=MOCK_RELATION)
    svc.delete_memory_relation = AsyncMock(return_value=None)
    return svc


@pytest_asyncio.fixture
async def memory_client(app):
    """Client with MemoryService dependency overridden."""
    from api.v1.endpoints.memories import get_memory_service

    mock_svc = _make_memory_service()

    app.dependency_overrides[get_memory_service] = lambda: mock_svc

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, mock_svc

    app.dependency_overrides.pop(get_memory_service, None)


# ===================================================================
# POST /v1/memory/create
# ===================================================================


class TestCreateMemory:

    @pytest.mark.asyncio
    async def test_create_memory_success(self, memory_client):
        client, svc = memory_client
        resp = await client.post("/v1/memory/create", json={
            "content": "The user prefers dark mode",
            "memory_type": "preference",
            "importance_score": 0.8,
        })

        assert resp.status_code == 201
        body = resp.json()
        assert body["content"] == "The user prefers dark mode"
        assert body["memory_type"] == "preference"

    @pytest.mark.asyncio
    async def test_create_memory_missing_content(self, memory_client):
        client, _ = memory_client
        resp = await client.post("/v1/memory/create", json={
            "memory_type": "preference",
        })

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_memory_service_error(self, memory_client):
        client, svc = memory_client
        svc.create_memory = AsyncMock(side_effect=RuntimeError("DB down"))
        resp = await client.post("/v1/memory/create", json={
            "content": "test",
            "memory_type": "fact",
        })

        assert resp.status_code == 500


# ===================================================================
# GET /v1/memory/list
# ===================================================================


class TestListMemories:

    @pytest.mark.asyncio
    async def test_list_memories_default(self, memory_client):
        client, _ = memory_client
        resp = await client.get("/v1/memory/list")

        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert len(body) == 1

    @pytest.mark.asyncio
    async def test_list_memories_with_filters(self, memory_client):
        client, _ = memory_client
        resp = await client.get("/v1/memory/list", params={
            "memory_type": "preference",
            "min_importance": 0.5,
            "limit": 10,
            "offset": 0,
        })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_list_memories_invalid_chat_id(self, memory_client):
        client, _ = memory_client
        resp = await client.get("/v1/memory/list", params={
            "source_chat_id": "not-a-uuid",
        })

        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_list_memories_all_sources(self, memory_client):
        client, _ = memory_client
        resp = await client.get("/v1/memory/list", params={
            "source_chat_id": "all",
        })

        assert resp.status_code == 200


# ===================================================================
# GET /v1/memory/get/{memory_id}
# ===================================================================


class TestGetMemory:

    @pytest.mark.asyncio
    async def test_get_memory_found(self, memory_client):
        client, _ = memory_client
        resp = await client.get(f"/v1/memory/get/{MEM_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == MEM_ID

    @pytest.mark.asyncio
    async def test_get_memory_not_found(self, memory_client):
        client, svc = memory_client
        svc.get_memory = AsyncMock(return_value=None)
        resp = await client.get(f"/v1/memory/get/{uuid4()}")

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_memory_invalid_id(self, memory_client):
        client, _ = memory_client
        resp = await client.get("/v1/memory/get/not-a-uuid")

        assert resp.status_code == 422


# ===================================================================
# PATCH /v1/memory/update/{memory_id}
# ===================================================================


class TestUpdateMemory:

    @pytest.mark.asyncio
    async def test_update_memory_success(self, memory_client):
        client, _ = memory_client
        resp = await client.patch(f"/v1/memory/update/{MEM_ID}", json={
            "content": "Updated preference",
            "importance_score": 0.9,
        })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_update_nonexistent_memory_returns_404(self, memory_client):
        """Update of non-existent memory returns 404, not 500.

        Regression: service.update_memory raises ValueError for missing IDs,
        but the endpoint caught it as generic Exception → 500.
        """
        client, svc = memory_client
        fake_id = str(uuid4())
        svc.update_memory = AsyncMock(side_effect=ValueError(f"Memory {fake_id} not found"))
        resp = await client.patch(f"/v1/memory/update/{fake_id}", json={
            "content": "Should not work",
        })

        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()


# ===================================================================
# DELETE /v1/memory/delete/{memory_id}
# ===================================================================


class TestDeleteMemory:

    @pytest.mark.asyncio
    async def test_delete_memory_success(self, memory_client):
        client, _ = memory_client
        resp = await client.delete(f"/v1/memory/delete/{MEM_ID}")

        assert resp.status_code == 204

    @pytest.mark.asyncio
    async def test_delete_nonexistent_memory_returns_404(self, memory_client):
        """Delete of non-existent memory returns 404, not silent success.

        Regression: service.delete_memory silently succeeded on non-existent IDs
        with no existence check at the endpoint level.
        """
        client, svc = memory_client
        fake_id = str(uuid4())
        svc.get_memory = AsyncMock(return_value=None)
        resp = await client.delete(f"/v1/memory/delete/{fake_id}")

        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()


# ===================================================================
# POST /v1/memory/promote/{memory_id}
# ===================================================================


class TestPromoteMemory:

    @pytest.mark.asyncio
    async def test_promote_success(self, memory_client):
        client, _ = memory_client
        resp = await client.post(f"/v1/memory/promote/{MEM_ID}", json={
            "boost_importance": 0.1,
        })

        assert resp.status_code == 200
        body = resp.json()
        assert "memory" in body
        assert "promoted" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_promote_not_found(self, memory_client):
        client, svc = memory_client
        svc.promote_to_global = AsyncMock(side_effect=ValueError("Memory not found"))
        resp = await client.post(f"/v1/memory/promote/{uuid4()}")

        assert resp.status_code == 404


# ===================================================================
# POST /v1/memory/demote/{memory_id}
# ===================================================================


class TestDemoteMemory:

    @pytest.mark.asyncio
    async def test_demote_success(self, memory_client):
        client, _ = memory_client
        resp = await client.post(f"/v1/memory/demote/{MEM_ID}", json={
            "chat_id": CHAT_ID,
        })

        assert resp.status_code == 200
        body = resp.json()
        assert "demoted" in body["message"].lower()

    @pytest.mark.asyncio
    async def test_demote_not_found(self, memory_client):
        client, svc = memory_client
        svc.demote_to_chat = AsyncMock(side_effect=ValueError("Memory not found"))
        resp = await client.post(f"/v1/memory/demote/{uuid4()}", json={
            "chat_id": CHAT_ID,
        })

        assert resp.status_code == 404


# ===================================================================
# GET /v1/memory/relation/list/{memory_id}
# ===================================================================


class TestGetMemoryRelations:

    @pytest.mark.asyncio
    async def test_list_relations(self, memory_client):
        client, _ = memory_client
        resp = await client.get(f"/v1/memory/relation/list/{MEM_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert len(body) == 1


# ===================================================================
# POST /v1/memory/relation/create/{memory_id}
# ===================================================================


class TestCreateMemoryRelation:

    @pytest.mark.asyncio
    async def test_create_relation(self, memory_client):
        client, _ = memory_client
        resp = await client.post(f"/v1/memory/relation/create/{MEM_ID}", json={
            "related_memory_id": str(uuid4()),
            "relation_type": "related_to",
            "strength": 0.85,
        })

        assert resp.status_code == 201


# ===================================================================
# DELETE /v1/memory/relation/delete/{relation_id}
# ===================================================================


class TestDeleteMemoryRelation:

    @pytest.mark.asyncio
    async def test_delete_relation(self, memory_client):
        client, _ = memory_client
        resp = await client.delete(f"/v1/memory/relation/delete/{REL_ID}")

        assert resp.status_code == 204


# ===================================================================
# Deep Coverage: Error paths for all endpoints
# ===================================================================


class TestMemoryErrorPaths:
    """Cover all except blocks that return 500."""

    async def test_list_memories_exception(self, memory_client):
        client, svc = memory_client
        svc.list_memories = AsyncMock(side_effect=RuntimeError("DB crash"))
        resp = await client.get("/v1/memory/list")
        assert resp.status_code == 500

    async def test_get_memory_exception(self, memory_client):
        client, svc = memory_client
        svc.get_memory = AsyncMock(side_effect=RuntimeError("DB crash"))
        resp = await client.get(f"/v1/memory/get/{MEM_ID}")
        assert resp.status_code == 500

    async def test_update_memory_exception(self, memory_client):
        client, svc = memory_client
        svc.update_memory = AsyncMock(side_effect=RuntimeError("DB crash"))
        resp = await client.patch(f"/v1/memory/update/{MEM_ID}", json={
            "content": "new content",
        })
        assert resp.status_code == 500

    async def test_delete_memory_exception(self, memory_client):
        client, svc = memory_client
        svc.delete_memory = AsyncMock(side_effect=RuntimeError("DB crash"))
        resp = await client.delete(f"/v1/memory/delete/{MEM_ID}")
        assert resp.status_code == 500

    async def test_promote_generic_exception(self, memory_client):
        client, svc = memory_client
        svc.promote_to_global = AsyncMock(side_effect=RuntimeError("unexpected"))
        resp = await client.post(f"/v1/memory/promote/{MEM_ID}")
        assert resp.status_code == 500

    async def test_demote_generic_exception(self, memory_client):
        client, svc = memory_client
        svc.demote_to_chat = AsyncMock(side_effect=RuntimeError("unexpected"))
        resp = await client.post(f"/v1/memory/demote/{MEM_ID}", json={
            "chat_id": CHAT_ID,
        })
        assert resp.status_code == 500

    async def test_get_relations_exception(self, memory_client):
        client, svc = memory_client
        svc.get_memory_relations = AsyncMock(side_effect=RuntimeError("DB crash"))
        resp = await client.get(f"/v1/memory/relation/list/{MEM_ID}")
        assert resp.status_code == 500

    async def test_create_relation_exception(self, memory_client):
        client, svc = memory_client
        svc.create_memory_relation = AsyncMock(side_effect=RuntimeError("DB crash"))
        resp = await client.post(f"/v1/memory/relation/create/{MEM_ID}", json={
            "related_memory_id": str(uuid4()),
            "relation_type": "related_to",
            "strength": 0.5,
        })
        assert resp.status_code == 500

    async def test_delete_relation_exception(self, memory_client):
        client, svc = memory_client
        svc.delete_memory_relation = AsyncMock(side_effect=RuntimeError("DB crash"))
        resp = await client.delete(f"/v1/memory/relation/delete/{REL_ID}")
        assert resp.status_code == 500


# ===================================================================
# Deep Coverage: search_memories helper
# ===================================================================


class TestSearchMemoriesHelper:

    async def test_vector_search(self):
        from application.search.providers.local_providers import MemorySearchProvider
        from application.search.interfaces import SearchContext
        from config.settings import Settings

        mock_svc = AsyncMock()
        mock_svc.search_memories.return_value = [{"id": 1}]

        # Setup mocked dependencies
        from core.domain.gateway_interfaces import ISearchGateway
        mock_settings = MagicMock(spec=Settings)
        mock_gateway = MagicMock(spec=ISearchGateway)
        mock_request = MagicMock()
        mock_uow = MagicMock()

        # Build context
        context = SearchContext(
            settings=mock_settings,
            gateway=mock_gateway,
            request_context={},
            request=mock_request,
            uow=mock_uow
        )

        with patch("api.dependencies.get_supabase_uow") as mock_get_uow:
            async def _uow_gen(*args, **kwargs):
                yield mock_uow
            mock_get_uow.return_value = _uow_gen()
            
            with patch("application.chat.memory_service.MemoryService", return_value=mock_svc):
                provider = MemorySearchProvider()
                payload = MagicMock()
                payload.query = "test query"
                payload.limit = 10
                payload.threshold = 0.6
                payload.search_type = "vector"
                
                result = await provider.execute(payload, context)

        assert result["total"] == 1
        assert result["results"] == [{"id": 1}]
        mock_svc.search_memories.assert_called_once_with(
            query="test query",
            match_threshold=0.6,
            match_count=10,
            memory_types=None
        )

    async def test_hybrid_search(self):
        from application.search.providers.local_providers import MemorySearchProvider
        from application.search.interfaces import SearchContext
        from config.settings import Settings

        mock_svc = AsyncMock()
        mock_svc.search_memories_hybrid.return_value = [{"id": 1}]

        # Setup mocked dependencies
        from core.domain.gateway_interfaces import ISearchGateway
        mock_settings = MagicMock(spec=Settings)
        mock_gateway = MagicMock(spec=ISearchGateway)
        mock_request = MagicMock()
        mock_uow = MagicMock()

        # Build context
        context = SearchContext(
            settings=mock_settings,
            gateway=mock_gateway,
            request_context={},
            request=mock_request,
            uow=mock_uow
        )

        with patch("api.dependencies.get_supabase_uow") as mock_get_uow:
            async def _uow_gen(*args, **kwargs):
                yield mock_uow
            mock_get_uow.return_value = _uow_gen()
            
            with patch("application.chat.memory_service.MemoryService", return_value=mock_svc):
                provider = MemorySearchProvider()
                payload = MagicMock()
                payload.query = "test query"
                payload.limit = 10
                payload.threshold = 0.6
                payload.search_type = "hybrid"
                
                result = await provider.execute(payload, context)

        assert result["total"] == 1
        mock_svc.search_memories_hybrid.assert_called_once_with(
            query_text="test query",
            semantic_weight=0.7,
            keyword_weight=0.3,
            match_threshold=0.6,
            match_count=10,
            memory_type=None
        )

    async def test_search_with_memory_type_filter(self):
        from application.search.providers.local_providers import MemorySearchProvider
        from application.search.interfaces import SearchContext
        from config.settings import Settings

        mock_svc = AsyncMock()
        mock_svc.search_memories.return_value = [{"id": 1}]

        # Setup mocked dependencies
        from core.domain.gateway_interfaces import ISearchGateway
        mock_settings = MagicMock(spec=Settings)
        mock_gateway = MagicMock(spec=ISearchGateway)
        mock_request = MagicMock()
        mock_uow = MagicMock()

        # Build context
        context = SearchContext(
            settings=mock_settings,
            gateway=mock_gateway,
            request_context={},
            request=mock_request,
            uow=mock_uow
        )

        with patch("api.dependencies.get_supabase_uow") as mock_get_uow:
            async def _uow_gen(*args, **kwargs):
                yield mock_uow
            mock_get_uow.return_value = _uow_gen()
            
            with patch("application.chat.memory_service.MemoryService", return_value=mock_svc):
                provider = MemorySearchProvider()
                payload = MagicMock()
                payload.query = "test query"
                payload.limit = 10
                payload.threshold = 0.6
                payload.search_type = "vector"
                # Note: MemorySearchProvider doesn't currently support passing memory_types through execute,
                # so this tests the default behavior
                
                result = await provider.execute(payload, context)

        assert result["total"] == 1
        mock_svc.search_memories.assert_called_once_with(
            query="test query",
            match_threshold=0.6,
            match_count=10,
            memory_types=None
        )

    async def test_search_exception(self):
        from application.search.providers.local_providers import MemorySearchProvider
        from application.search.interfaces import SearchContext
        from config.settings import Settings

        mock_svc = AsyncMock()
        mock_svc.search_memories.side_effect = RuntimeError("db down")

        # Setup mocked dependencies
        from core.domain.gateway_interfaces import ISearchGateway
        mock_settings = MagicMock(spec=Settings)
        mock_gateway = MagicMock(spec=ISearchGateway)
        mock_request = MagicMock()
        mock_uow = MagicMock()

        # Build context
        context = SearchContext(
            settings=mock_settings,
            gateway=mock_gateway,
            request_context={},
            request=mock_request,
            uow=mock_uow
        )

        with patch("api.dependencies.get_supabase_uow") as mock_get_uow:
            async def _uow_gen(*args, **kwargs):
                yield mock_uow
            mock_get_uow.return_value = _uow_gen()
            
            with patch("application.chat.memory_service.MemoryService", return_value=mock_svc):
                provider = MemorySearchProvider()
                payload = MagicMock()
                payload.query = "test query"
                payload.limit = 10
                payload.threshold = 0.6
                payload.search_type = "vector"
                
                import pytest
                with pytest.raises(RuntimeError) as exc_info:
                    await provider.execute(payload, context)
                
                assert "db down" in str(exc_info.value)


# ===================================================================
# Coverage Gap: Line 54 — get_memory_service dependency function
# ===================================================================


class TestGetMemoryServiceDependency:
    """Direct test for the get_memory_service dependency."""

    async def test_get_memory_service_returns_instance(self):
        """Line 54: get_memory_service creates MemoryService from uow + settings."""
        from unittest.mock import patch
        from api.v1.endpoints.memories import get_memory_service
        from application.chat.memory_service import MemoryService

        mock_uow = MagicMock()
        mock_settings = MagicMock()
        mock_settings.base_url = "http://localhost:8765"

        with patch("application.chat.memory_service.ChatRepository"):
            svc = await get_memory_service(uow=mock_uow, settings=mock_settings)
        assert isinstance(svc, MemoryService)
