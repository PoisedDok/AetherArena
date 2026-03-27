"""
Unit Tests: MemoryService (application/chat/memory_service.py)

Comprehensive coverage of memory CRUD, vector search, hybrid search,
LLM extraction, promotion/demotion, auto-promotion, and relations.

Mock boundaries:
- gateway (SupabasePersistenceGateway) → mock rpc/select/insert/update/delete
- httpx.AsyncClient → mock embedding service + LLM calls
- Settings → mock with known values
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from application.chat.memory_service import MemoryService
from data.database.persistence_gateway import SupabasePersistenceGateway


# ─── Helpers ─────────────────────────────────────────────────────────────────


FAKE_EMBEDDING = [0.1, 0.2, 0.3, 0.4, 0.5]
CHAT_ID = uuid4()
MEMORY_ID = uuid4()
RELATED_ID = uuid4()
RELATION_ID = uuid4()


def _make_settings() -> MagicMock:
    """Create a mock settings object with all fields MemoryService uses."""
    settings = MagicMock()
    settings.base_url = "http://127.0.0.1:8765"

    # LLM settings
    settings.llm = MagicMock()
    settings.llm.summarizer_model = "test-summarizer"

    # Embedding service
    settings.embedding_service = MagicMock()
    settings.embedding_service.service_url = "http://localhost:3000/api/embeddings"
    settings.embedding_service.model = "test-embed-model"

    # HTTP client timeouts
    settings.http_client = MagicMock()
    settings.http_client.embedding_timeout = 60.0
    settings.http_client.llm_timeout = 300.0

    # Memory service config
    settings.memory_service = MagicMock()
    settings.memory_service.group_frequency = 5
    settings.memory_service.vector_match_threshold = 0.5
    settings.memory_service.default_search_limit = 10
    settings.memory_service.default_list_limit = 50
    settings.memory_service.semantic_weight = 0.7
    settings.memory_service.keyword_weight = 0.3
    settings.memory_service.valid_memory_types = ["fact", "decision", "preference", "insight", "skill"]
    settings.memory_service.extraction_temperature = 0.3
    settings.memory_service.extraction_max_tokens = 1000

    return settings


def _make_gateway() -> MagicMock:
    """Create a mock gateway that passes isinstance(gw, SupabasePersistenceGateway)."""
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.rpc = AsyncMock(return_value=[])
    gw.select = AsyncMock(return_value=[])
    gw.insert = AsyncMock(return_value=[{"id": str(MEMORY_ID), "content": "test"}])
    gw.update = AsyncMock(return_value=[{"id": str(MEMORY_ID), "content": "updated"}])
    gw.delete = AsyncMock(return_value=None)
    return gw


def _make_service(
    gateway: MagicMock | None = None,
    settings: MagicMock | None = None,
) -> tuple[MemoryService, MagicMock, MagicMock]:
    """Create MemoryService with mocked dependencies. Returns (service, gateway, settings)."""
    if gateway is None:
        gateway = _make_gateway()
    if settings is None:
        settings = _make_settings()
    uow = SimpleNamespace(gateway=gateway)
    svc = MemoryService(uow, settings)
    return svc, gateway, settings


def _mock_httpx_response(data: dict, status_code: int = 200) -> MagicMock:
    """Create a mock httpx response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = data
    resp.raise_for_status = MagicMock()
    if status_code >= 400:
        import httpx as httpx_mod
        resp.raise_for_status.side_effect = httpx_mod.HTTPStatusError(
            "error", request=MagicMock(), response=resp
        )
    return resp


def _embedding_response() -> dict:
    """Standard embedding API response."""
    return {"data": [{"embedding": FAKE_EMBEDDING}]}


def _llm_extraction_response(memories: list) -> dict:
    """Standard LLM extraction response."""
    return {
        "choices": [{
            "message": {
                "content": json.dumps({"memories": memories})
            }
        }]
    }


# ─── __init__ ─────────────────────────────────────────────────────────────────


class TestInit:
    def test_initializes_correctly(self):
        svc, gw, settings = _make_service()
        assert svc._gateway is gw
        assert svc._settings is settings
        assert svc._llm_url == "http://127.0.0.1:8765/v1/llm"
        assert svc._embedding_url == "http://localhost:3000/api/embeddings"
        assert svc._http_timeout == 60.0

    def test_strips_trailing_slash_from_base_url(self):
        settings = _make_settings()
        settings.base_url = "http://127.0.0.1:8765/"
        svc, _, _ = _make_service(settings=settings)
        assert svc._llm_url == "http://127.0.0.1:8765/v1/llm"


# ─── _generate_embedding ────────────────────────────────────────────────────


class TestGenerateEmbedding:
    async def test_happy_path(self):
        svc, _, _ = _make_service()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_mock_httpx_response(_embedding_response()))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await svc._generate_embedding("test text")

        assert result == FAKE_EMBEDDING
        mock_client.post.assert_awaited_once()

    async def test_http_error_raises(self):
        svc, _, _ = _make_service()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_mock_httpx_response({}, status_code=500))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(Exception):
                await svc._generate_embedding("test")

    async def test_general_exception_raises(self):
        svc, _, _ = _make_service()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=RuntimeError("network down"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="network down"):
                await svc._generate_embedding("test")


# ─── create_memory ───────────────────────────────────────────────────────────


class TestCreateMemory:
    async def test_deduplication_merges_existing(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=[
            {"id": "existing-id", "content": "same content", "memory_type": "fact", "source_chat_id": str(CHAT_ID), "importance_score": 0.5}
        ])
        gw.update = AsyncMock(return_value=[{"id": "existing-id", "importance_score": 0.55}])

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            result = await svc.create_memory(
                content="same content",
                memory_type="fact",
                importance_score=0.8,
                source_chat_id=CHAT_ID,
            )

        gw.insert.assert_not_awaited()
        gw.update.assert_awaited_once()
        assert result["importance_score"] == 0.55

    async def test_happy_path(self):
        svc, gw, _ = _make_service()

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            result = await svc.create_memory(
                content="Test memory",
                memory_type="fact",
                importance_score=0.8,
                source_chat_id=CHAT_ID,
                metadata={"tags": ["test"]},
            )

        assert result is not None
        gw.insert.assert_awaited_once()
        call_args = gw.insert.call_args
        data = call_args.args[1][0] if len(call_args.args) > 1 else call_args.kwargs.get("data", [{}])[0]
        assert data["content"] == "Test memory"
        assert data["memory_type"] == "fact"
        assert data["embedding"] == FAKE_EMBEDDING

    async def test_importance_clamped_to_0_1(self):
        svc, gw, _ = _make_service()

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            await svc.create_memory(content="x", memory_type="fact", importance_score=1.5)
            call_data = gw.insert.call_args.args[1][0] if len(gw.insert.call_args.args) > 1 else gw.insert.call_args.kwargs["data"][0]
            assert call_data["importance_score"] == 1.0

    async def test_importance_clamped_negative(self):
        svc, gw, _ = _make_service()

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            await svc.create_memory(content="x", memory_type="fact", importance_score=-0.5)
            call_data = gw.insert.call_args.args[1][0] if len(gw.insert.call_args.args) > 1 else gw.insert.call_args.kwargs["data"][0]
            assert call_data["importance_score"] == 0.0

    async def test_empty_insert_result_returns_data(self):
        svc, gw, settings = _make_service()
        gw.insert = AsyncMock(return_value=[])

        settings.memory_service.default_manual_importance = 0.5

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            result = await svc.create_memory(content="x", memory_type="fact", importance_score=None)

        # Falls back to data dict when result is empty
        assert result["content"] == "x"
        assert result["importance_score"] == 0.5
        assert result["embedding"] == FAKE_EMBEDDING

    async def test_optional_fields_default_to_none(self):
        svc, gw, settings = _make_service()

        settings.memory_service.default_manual_importance = 0.5

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            await svc.create_memory(content="x", memory_type="fact", importance_score=None)
            call_data = gw.insert.call_args.args[1][0] if len(gw.insert.call_args.args) > 1 else gw.insert.call_args.kwargs["data"][0]
            assert call_data["importance_score"] == 0.5
            assert call_data["source_chat_id"] is None
            assert call_data["source_message_id"] is None
            assert call_data["expires_at"] is None


# ─── search_memories ─────────────────────────────────────────────────────────


class TestSearchMemories:
    async def test_happy_path(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=[
            {"id": "1", "content": "mem1", "memory_type": "fact", "similarity": 0.9},
            {"id": "2", "content": "mem2", "memory_type": "insight", "similarity": 0.7},
        ])

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            result = await svc.search_memories("test query")

        assert len(result) == 2
        gw.rpc.assert_awaited_once_with(
            "search_memories",
            {
                "query_embedding": FAKE_EMBEDDING,
                "match_threshold": 0.5,
                "match_count": 10,
            },
        )

    async def test_custom_thresholds(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=[])

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            await svc.search_memories("q", match_threshold=0.8, match_count=5)

        gw.rpc.assert_awaited_once()
        call_params = gw.rpc.call_args.args[1]
        assert call_params["match_threshold"] == 0.8
        assert call_params["match_count"] == 5

    async def test_filter_by_memory_types(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=[
            {"id": "1", "memory_type": "fact"},
            {"id": "2", "memory_type": "insight"},
            {"id": "3", "memory_type": "decision"},
        ])

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            result = await svc.search_memories("q", memory_types=["fact", "decision"])

        assert len(result) == 2
        assert all(m["memory_type"] in ["fact", "decision"] for m in result)

    async def test_empty_result(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=None)

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            result = await svc.search_memories("q")

        assert result == []


# ─── search_memories_hybrid ──────────────────────────────────────────────────


class TestSearchMemoriesHybrid:
    async def test_happy_path(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=[
            {"id": "1", "content": "hybrid result", "score": 0.85},
        ])

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            result = await svc.search_memories_hybrid("test query")

        assert len(result) == 1
        gw.rpc.assert_awaited_once()
        call_params = gw.rpc.call_args.args[1]
        assert call_params["query_text"] == "test query"
        assert call_params["semantic_weight"] == 0.7
        assert call_params["keyword_weight"] == 0.3

    async def test_custom_weights(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=[])

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            await svc.search_memories_hybrid(
                "q", semantic_weight=0.9, keyword_weight=0.1,
                match_threshold=0.6, match_count=20
            )

        call_params = gw.rpc.call_args.args[1]
        assert call_params["semantic_weight"] == 0.9
        assert call_params["keyword_weight"] == 0.1
        assert call_params["match_threshold"] == 0.6
        assert call_params["match_count"] == 20

    async def test_empty_result(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=None)

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            result = await svc.search_memories_hybrid("q")

        assert result == []


# ─── update_memory ───────────────────────────────────────────────────────────


class TestUpdateMemory:
    async def test_update_content_regenerates_embedding(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[{"id": str(MEMORY_ID), "content": "old"}])

        with patch.object(svc, "_generate_embedding", new_callable=AsyncMock, return_value=FAKE_EMBEDDING):
            result = await svc.update_memory(MEMORY_ID, content="new content")

        assert result is not None
        gw.update.assert_awaited_once()
        call_data = gw.update.call_args.kwargs.get("data") or gw.update.call_args.args[1]
        assert call_data["content"] == "new content"
        assert call_data["embedding"] == FAKE_EMBEDDING

    async def test_update_type_only(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[{"id": str(MEMORY_ID)}])

        result = await svc.update_memory(MEMORY_ID, memory_type="decision")

        gw.update.assert_awaited_once()
        call_data = gw.update.call_args.kwargs.get("data") or gw.update.call_args.args[1]
        assert call_data["memory_type"] == "decision"
        assert "embedding" not in call_data

    async def test_update_importance_clamped(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[{"id": str(MEMORY_ID)}])

        await svc.update_memory(MEMORY_ID, importance_score=2.0)

        call_data = gw.update.call_args.kwargs.get("data") or gw.update.call_args.args[1]
        assert call_data["importance_score"] == 1.0

    async def test_update_metadata(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[{"id": str(MEMORY_ID)}])

        await svc.update_memory(MEMORY_ID, metadata={"key": "val"})

        call_data = gw.update.call_args.kwargs.get("data") or gw.update.call_args.args[1]
        assert call_data["metadata"] == {"key": "val"}

    async def test_not_found_raises(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        with pytest.raises(ValueError, match="not found"):
            await svc.update_memory(MEMORY_ID, content="x")

    async def test_not_found_none_result_raises(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=None)

        with pytest.raises(ValueError, match="not found"):
            await svc.update_memory(MEMORY_ID, content="x")

    async def test_update_result_list_unwrapped(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[{"id": str(MEMORY_ID)}])
        gw.update = AsyncMock(return_value=[{"id": str(MEMORY_ID), "updated": True}])

        result = await svc.update_memory(MEMORY_ID, memory_type="fact")
        assert result["updated"] is True

    async def test_update_result_not_list(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[{"id": str(MEMORY_ID)}])
        gw.update = AsyncMock(return_value={"id": str(MEMORY_ID), "direct": True})

        result = await svc.update_memory(MEMORY_ID, memory_type="fact")
        assert result["direct"] is True


# ─── delete_memory ───────────────────────────────────────────────────────────


class TestDeleteMemory:
    async def test_deletes_and_returns_true(self):
        svc, gw, _ = _make_service()

        result = await svc.delete_memory(MEMORY_ID)

        assert result is True
        gw.delete.assert_awaited_once()


# ─── list_memories ───────────────────────────────────────────────────────────


class TestListMemories:
    async def test_default_global_only(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[
            {"id": "1", "content": "global memory", "importance_score": 0.9},
        ])

        result = await svc.list_memories()

        assert len(result) == 1
        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        call_args = gw.select.call_args.args if gw.select.call_args.args else ()
        # Check filters include is.null for source_chat_id
        filters = call_kwargs.get("filters") or (call_args[1] if len(call_args) > 1 else {})
        assert filters.get("source_chat_id") == "is.null"

    async def test_specific_chat_filter(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        await svc.list_memories(source_chat_id=CHAT_ID)

        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        call_args = gw.select.call_args.args if gw.select.call_args.args else ()
        filters = call_kwargs.get("filters") or (call_args[1] if len(call_args) > 1 else {})
        assert filters.get("source_chat_id") == str(CHAT_ID)

    async def test_all_memories_no_filter(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        await svc.list_memories(source_chat_id="all")

        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        call_args = gw.select.call_args.args if gw.select.call_args.args else ()
        filters = call_kwargs.get("filters") or (call_args[1] if len(call_args) > 1 else {})
        assert "source_chat_id" not in filters

    async def test_memory_type_filter(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        await svc.list_memories(memory_type="fact")

        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        call_args = gw.select.call_args.args if gw.select.call_args.args else ()
        filters = call_kwargs.get("filters") or (call_args[1] if len(call_args) > 1 else {})
        assert filters.get("memory_type") == "fact"

    async def test_min_importance_filter(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[
            {"id": "1", "importance_score": 0.9},
            {"id": "2", "importance_score": 0.7},
        ])
    
        result = await svc.list_memories(min_importance=0.6)
    
        assert len(result) == 2
        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        call_args = gw.select.call_args.args if gw.select.call_args.args else ()
        filters = call_kwargs.get("filters") or (call_args[1] if len(call_args) > 1 else {})
        assert filters.get("importance_score") == {"gte": 0.6}

    async def test_min_importance_stops_early_on_sorted(self):
        """Passes the sort order to gateway"""
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[
            {"id": "1", "importance_score": 0.9},
        ])
    
        result = await svc.list_memories(min_importance=0.5)
    
        assert len(result) == 1
        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        assert call_kwargs.get("order_by") == "importance_score.desc,extracted_at.desc"

    async def test_min_importance_respects_limit(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[
            {"id": "1", "importance_score": 0.9},
            {"id": "2", "importance_score": 0.8},
        ])
    
        result = await svc.list_memories(min_importance=0.6, limit=2)
    
        assert len(result) == 2
        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        assert call_kwargs.get("limit") == 2

    async def test_custom_limit_and_offset(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        await svc.list_memories(limit=20, offset=10)

        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        assert call_kwargs.get("limit") == 20
        assert call_kwargs.get("offset") == 10

    async def test_empty_result(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=None)

        result = await svc.list_memories()
        assert result == []


# ─── get_memory ──────────────────────────────────────────────────────────────


class TestGetMemory:
    async def test_found(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[{"id": str(MEMORY_ID), "content": "test"}])

        result = await svc.get_memory(MEMORY_ID)
        assert result["content"] == "test"

    async def test_not_found(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        result = await svc.get_memory(MEMORY_ID)
        assert result is None

    async def test_none_result(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=None)

        result = await svc.get_memory(MEMORY_ID)
        assert result is None


# ─── promote_to_global ───────────────────────────────────────────────────────


class TestPromoteToGlobal:
    async def test_happy_path(self):
        svc, gw, _ = _make_service()

        with patch.object(svc, "get_memory", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = {
                "id": str(MEMORY_ID),
                "source_chat_id": str(CHAT_ID),
                "importance_score": 0.7,
            }
            result = await svc.promote_to_global(MEMORY_ID, boost_importance=0.1)

        gw.update.assert_awaited_once()
        call_data = gw.update.call_args.kwargs.get("data") or gw.update.call_args.args[1]
        assert call_data["source_chat_id"] is None
        assert call_data["importance_score"] == pytest.approx(0.8)

    async def test_already_global_skips(self):
        svc, gw, _ = _make_service()

        with patch.object(svc, "get_memory", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = {
                "id": str(MEMORY_ID),
                "source_chat_id": None,
                "importance_score": 0.9,
            }
            result = await svc.promote_to_global(MEMORY_ID)

        gw.update.assert_not_awaited()
        assert result["source_chat_id"] is None

    async def test_not_found_raises(self):
        svc, _, _ = _make_service()

        with patch.object(svc, "get_memory", new_callable=AsyncMock, return_value=None):
            with pytest.raises(ValueError, match="not found"):
                await svc.promote_to_global(MEMORY_ID)

    async def test_importance_capped_at_1(self):
        svc, gw, _ = _make_service()

        with patch.object(svc, "get_memory", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = {
                "id": str(MEMORY_ID),
                "source_chat_id": str(CHAT_ID),
                "importance_score": 0.95,
            }
            await svc.promote_to_global(MEMORY_ID, boost_importance=0.2)

        call_data = gw.update.call_args.kwargs.get("data") or gw.update.call_args.args[1]
        assert call_data["importance_score"] == 1.0

    async def test_result_unwrapped_from_list(self):
        svc, gw, settings = _make_service()
        settings.memory_service.promotion_boost = 0.1
        gw.update = AsyncMock(return_value=[{"id": str(MEMORY_ID), "promoted": True}])

        with patch.object(svc, "get_memory", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = {
                "id": str(MEMORY_ID),
                "source_chat_id": str(CHAT_ID),
                "importance_score": 0.5,
            }
            result = await svc.promote_to_global(MEMORY_ID)

        assert result["promoted"] is True


# ─── demote_to_chat ─────────────────────────────────────────────────────────


class TestDemoteToChat:
    async def test_happy_path(self):
        svc, gw, _ = _make_service()

        with patch.object(svc, "get_memory", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = {
                "id": str(MEMORY_ID),
                "source_chat_id": None,
            }
            result = await svc.demote_to_chat(MEMORY_ID, CHAT_ID)

        gw.update.assert_awaited_once()
        call_data = gw.update.call_args.kwargs.get("data") or gw.update.call_args.args[1]
        assert call_data["source_chat_id"] == str(CHAT_ID)

    async def test_already_chat_specific_updates(self):
        svc, gw, _ = _make_service()
        other_chat = uuid4()

        with patch.object(svc, "get_memory", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = {
                "id": str(MEMORY_ID),
                "source_chat_id": str(other_chat),
            }
            await svc.demote_to_chat(MEMORY_ID, CHAT_ID)

        gw.update.assert_awaited_once()

    async def test_not_found_raises(self):
        svc, _, _ = _make_service()

        with patch.object(svc, "get_memory", new_callable=AsyncMock, return_value=None):
            with pytest.raises(ValueError, match="not found"):
                await svc.demote_to_chat(MEMORY_ID, CHAT_ID)

    async def test_result_unwrapped_from_list(self):
        svc, gw, _ = _make_service()
        gw.update = AsyncMock(return_value=[{"id": str(MEMORY_ID), "demoted": True}])

        with patch.object(svc, "get_memory", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = {"id": str(MEMORY_ID), "source_chat_id": None}
            result = await svc.demote_to_chat(MEMORY_ID, CHAT_ID)

        assert result["demoted"] is True


# ─── auto_promote_important_memories ─────────────────────────────────────────


class TestAutoPromoteImportantMemories:
    async def test_happy_path(self):
        svc, _, _ = _make_service()
        mem1_id = str(uuid4())
        mem2_id = str(uuid4())

        with patch.object(svc, "list_memories", new_callable=AsyncMock) as mock_list, \
             patch.object(svc, "promote_to_global", new_callable=AsyncMock) as mock_promote:
            mock_list.return_value = [
                {"id": mem1_id, "importance_score": 0.9},
                {"id": mem2_id, "importance_score": 0.85},
            ]
            result = await svc.auto_promote_important_memories(CHAT_ID)

        assert len(result) == 2
        assert mock_promote.await_count == 2

    async def test_no_memories_above_threshold(self):
        svc, _, _ = _make_service()

        with patch.object(svc, "list_memories", new_callable=AsyncMock, return_value=[]):
            result = await svc.auto_promote_important_memories(CHAT_ID)

        assert result == []

    async def test_custom_threshold(self):
        svc, _, _ = _make_service()

        with patch.object(svc, "list_memories", new_callable=AsyncMock) as mock_list, \
             patch.object(svc, "promote_to_global", new_callable=AsyncMock):
            mock_list.return_value = []
            await svc.auto_promote_important_memories(CHAT_ID, importance_threshold=0.9)

        mock_list.assert_awaited_once()
        call_kwargs = mock_list.call_args.kwargs
        assert call_kwargs["min_importance"] == 0.9

    async def test_promotion_error_continues(self):
        svc, _, _ = _make_service()
        mem1_id = str(uuid4())
        mem2_id = str(uuid4())

        with patch.object(svc, "list_memories", new_callable=AsyncMock) as mock_list, \
             patch.object(svc, "promote_to_global", new_callable=AsyncMock) as mock_promote:
            mock_list.return_value = [
                {"id": mem1_id, "importance_score": 0.9},
                {"id": mem2_id, "importance_score": 0.85},
            ]
            mock_promote.side_effect = [RuntimeError("db error"), None]
            result = await svc.auto_promote_important_memories(CHAT_ID)

        # Only second one succeeded
        assert len(result) == 1
        assert result[0] == mem2_id


# ─── _format_groups_for_llm ─────────────────────────────────────────────────


class TestFormatGroupsForLlm:
    def test_formats_correctly(self):
        svc, _, _ = _make_service()

        groups = [
            {"sequence_number": 2, "user_message": "How are you?", "agent_message": "I'm well."},
            {"sequence_number": 1, "user_message": "Hello", "agent_message": "Hi there!"},
        ]

        result = svc._format_groups_for_llm(groups)

        # Groups reversed for chronological order
        assert "[Turn 1]" in result
        assert "[Turn 2]" in result
        lines = result.split("\n")
        # First turn should be sequence 1 (reversed from input)
        assert lines[0] == "[Turn 1]"
        assert lines[1] == "User: Hello"
        assert lines[2] == "Assistant: Hi there!"

    def test_missing_fields_default(self):
        svc, _, _ = _make_service()
        groups = [{"not_seq": True}]

        result = svc._format_groups_for_llm(groups)

        assert "[Turn ?]" in result
        assert "User: " in result


# ─── _call_llm_for_memory_extraction ─────────────────────────────────────────


class TestCallLlmForMemoryExtraction:
    async def test_happy_path_json_response(self):
        svc, _, _ = _make_service()
        memories = [
            {"content": "Client prefers email", "type": "preference", "importance": 0.8, "tags": ["client"]},
        ]

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_mock_httpx_response(_llm_extraction_response(memories)))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await svc._call_llm_for_memory_extraction("User: Hello\nAssistant: Hi")

        assert len(result) == 1
        assert result[0]["content"] == "Client prefers email"

    async def test_non_json_response_falls_back(self):
        svc, _, _ = _make_service()

        non_json_response = {
            "choices": [{"message": {"content": "This is not JSON"}}]
        }
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_mock_httpx_response(non_json_response))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await svc._call_llm_for_memory_extraction("conversation")

        # Falls back to single memory
        assert len(result) == 1
        assert result[0]["type"] == "insight"
        assert result[0]["importance"] == 0.5

    async def test_http_error_raises(self):
        svc, _, _ = _make_service()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_mock_httpx_response({}, status_code=500))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(Exception):
                await svc._call_llm_for_memory_extraction("conversation")

    async def test_general_exception_raises(self):
        svc, _, _ = _make_service()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=RuntimeError("network"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(RuntimeError):
                await svc._call_llm_for_memory_extraction("conversation")


# ─── extract_memories_from_groups ────────────────────────────────────────────


class TestExtractMemoriesFromGroups:
    async def test_happy_path(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[
            {"sequence_number": 1, "user_message": "Hello", "agent_message": "Hi"},
        ])

        memories_data = [{"content": "Greeting exchange", "type": "insight", "importance": 0.3, "tags": []}]

        with patch.object(svc, "_call_llm_for_memory_extraction", new_callable=AsyncMock, return_value=memories_data), \
             patch.object(svc, "create_memory", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = {"id": str(MEMORY_ID), "content": "Greeting exchange"}
            result = await svc.extract_memories_from_groups(CHAT_ID)

        assert len(result) == 1
        mock_create.assert_awaited_once()

    async def test_uses_config_default_num_groups(self):
        svc, gw, settings = _make_service()
        settings.memory_service.group_frequency = 7
        gw.select = AsyncMock(return_value=[])

        result = await svc.extract_memories_from_groups(CHAT_ID, num_groups=None)

        gw.select.assert_awaited_once()
        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        assert call_kwargs.get("limit") == 7

    async def test_explicit_num_groups(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        await svc.extract_memories_from_groups(CHAT_ID, num_groups=3)

        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        assert call_kwargs.get("limit") == 3

    async def test_with_max_sequence(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        await svc.extract_memories_from_groups(CHAT_ID, num_groups=3, max_sequence=15)

        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        assert call_kwargs.get("limit") == 3
        filters = call_kwargs.get("filters") or {}
        assert filters.get("sequence_number") == "lte.15"

    async def test_no_groups_returns_empty(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        result = await svc.extract_memories_from_groups(CHAT_ID)
        assert result == []

    async def test_none_groups_result(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=None)

        result = await svc.extract_memories_from_groups(CHAT_ID)
        assert result == []

    async def test_memory_creation_with_metadata(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[
            {"sequence_number": 1, "user_message": "Test", "agent_message": "Response"},
        ])

        memories_data = [
            {"content": "test mem", "type": "fact", "importance": 0.9, "tags": ["tag1"]}
        ]

        with patch.object(svc, "_call_llm_for_memory_extraction", new_callable=AsyncMock, return_value=memories_data), \
             patch.object(svc, "create_memory", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = {"id": "x"}
            await svc.extract_memories_from_groups(CHAT_ID, num_groups=3)

        call_kwargs = mock_create.call_args.kwargs
        assert call_kwargs["content"] == "test mem"
        assert call_kwargs["memory_type"] == "fact"
        assert call_kwargs["importance_score"] == 0.9
        assert call_kwargs["source_chat_id"] == CHAT_ID
        assert call_kwargs["metadata"]["tags"] == ["tag1"]
        assert call_kwargs["metadata"]["extracted_from_groups"] == 3


# ─── Memory Relations ────────────────────────────────────────────────────────


class TestMemoryRelations:
    async def test_get_relations(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[
            {"id": str(RELATION_ID), "memory_id": str(MEMORY_ID), "related_memory_id": str(RELATED_ID)},
        ])

        result = await svc.get_memory_relations(MEMORY_ID)
        assert len(result) == 1

    async def test_get_relations_empty(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=None)

        result = await svc.get_memory_relations(MEMORY_ID)
        assert result == []

    async def test_create_relation(self):
        svc, gw, _ = _make_service()
        gw.insert = AsyncMock(return_value=[{"id": str(RELATION_ID)}])

        result = await svc.create_memory_relation(
            MEMORY_ID, RELATED_ID, "supports", strength=0.8
        )

        assert result["id"] == str(RELATION_ID)
        gw.insert.assert_awaited_once()

    async def test_create_relation_empty_result(self):
        svc, gw, _ = _make_service()
        gw.insert = AsyncMock(return_value=[])

        result = await svc.create_memory_relation(
            MEMORY_ID, RELATED_ID, "contradicts"
        )

        # Falls back to data dict
        assert result["relation_type"] == "contradicts"

    async def test_delete_relation(self):
        svc, gw, _ = _make_service()

        result = await svc.delete_memory_relation(RELATION_ID)

        assert result is True
        gw.delete.assert_awaited_once()
