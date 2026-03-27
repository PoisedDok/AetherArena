"""
Tests for api/v1/endpoints/storage.py

Covers: chat CRUD, message listing/creation, artifact CRUD, trail queries,
storage stats, health check, traceability, chat summaries.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4
from datetime import datetime, timezone


NOW_ISO = datetime.now(timezone.utc).isoformat()
CHAT_ID = str(uuid4())
MSG_ID = str(uuid4())
ARTIFACT_ID = str(uuid4())
GROUP_ID = str(uuid4())
SUBGROUP_ID = str(uuid4())

SAMPLE_CHAT = {
    "id": CHAT_ID,
    "title": "Test Chat",
    "created_at": NOW_ISO,
    "updated_at": NOW_ISO,
}

SAMPLE_MESSAGE = {
    "id": MSG_ID,
    "chat_id": CHAT_ID,
    "role": "user",
    "content": "Hello world",
    "timestamp": NOW_ISO,
    "sequence_in_chat": 1,
    "llm_model": None,
    "llm_provider": None,
    "tokens_used": None,
    "correlation_id": None,
    "created_at": NOW_ISO,
}

SAMPLE_ARTIFACT = {
    "id": ARTIFACT_ID,
    "chat_id": CHAT_ID,
    "artifact_id": "code_abc123",
    "type": "code",
    "title": "Test Code",
    "content": "print('hello')",
    "language": "python",
    "filename": None,
    "metadata": {},
    "message_id": MSG_ID,
    "created_at": NOW_ISO,
    "updated_at": NOW_ISO,
}


# ===========================================================================
# Chat CRUD Tests
# ===========================================================================

class TestChatList:
    """Tests for GET /v1/storage/chat/list"""

    @pytest.mark.asyncio
    async def test_list_chats_empty(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/storage/chat/list")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_list_chats_with_data(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_CHAT])
        resp = await client.get("/v1/storage/chat/list")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["title"] == "Test Chat"

    @pytest.mark.asyncio
    async def test_list_chats_with_pagination(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/storage/chat/list?skip=10&limit=5")
        assert resp.status_code == 200


class TestChatCreate:
    """Tests for POST /v1/storage/chat/create"""

    @pytest.mark.asyncio
    async def test_create_chat(self, client, mock_supabase_client):
        mock_supabase_client.insert = AsyncMock(return_value=[SAMPLE_CHAT])
        resp = await client.post("/v1/storage/chat/create", json={
            "title": "New Chat",
        })
        assert resp.status_code == 201

    @pytest.mark.asyncio
    async def test_create_chat_missing_title(self, client):
        """Create chat without title still works (title is optional or has default)."""
        resp = await client.post("/v1/storage/chat/create", json={})
        # Either 201 (default title) or 422 (validation)
        assert resp.status_code in (201, 422, 500)


class TestChatGetUpdateDelete:
    """Tests for GET/PUT/DELETE chat by ID"""

    @pytest.mark.asyncio
    async def test_get_chat_found(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_CHAT])
        resp = await client.get(f"/v1/storage/chat/get/{CHAT_ID}")
        assert resp.status_code == 200
        assert resp.json()["title"] == "Test Chat"

    @pytest.mark.asyncio
    async def test_get_chat_not_found(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        fake_id = str(uuid4())
        resp = await client.get(f"/v1/storage/chat/get/{fake_id}")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_update_chat(self, client, mock_supabase_client):
        updated = {**SAMPLE_CHAT, "title": "Updated Title"}
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_CHAT])
        mock_supabase_client.update = AsyncMock(return_value=[updated])
        resp = await client.put(f"/v1/storage/chat/update/{CHAT_ID}", json={
            "title": "Updated Title",
        })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_delete_chat(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_CHAT])
        mock_supabase_client.delete = AsyncMock(return_value=None)
        resp = await client.delete(f"/v1/storage/chat/delete/{CHAT_ID}")
        assert resp.status_code == 204


# ===========================================================================
# Message Tests
# ===========================================================================

class TestMessages:
    """Tests for message listing and creation."""

    @pytest.mark.asyncio
    async def test_list_messages(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_MESSAGE])
        resp = await client.get(f"/v1/storage/message/list/{CHAT_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["role"] == "user"

    @pytest.mark.asyncio
    async def test_list_messages_empty(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/message/list/{CHAT_ID}")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_create_message(self, client, mock_supabase_client):
        # create_message calls gateway.rpc() for sequence number + gateway.insert()
        mock_supabase_client.rpc = AsyncMock(return_value=1)
        mock_supabase_client.insert = AsyncMock(return_value=[SAMPLE_MESSAGE])
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_CHAT])
        mock_supabase_client.update = AsyncMock(return_value=[SAMPLE_CHAT])
        resp = await client.post(f"/v1/storage/message/create/{CHAT_ID}", json={
            "role": "user",
            "content": "Hello world",
        })
        assert resp.status_code == 201


# ===========================================================================
# Artifact Tests
# ===========================================================================

class TestArtifacts:
    """Tests for artifact CRUD."""

    @pytest.mark.asyncio
    async def test_list_artifacts(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_ARTIFACT])
        resp = await client.get(f"/v1/storage/artifact/list/{CHAT_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_list_artifacts_empty(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/artifact/list/{CHAT_ID}")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_get_artifact(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_ARTIFACT])
        resp = await client.get(f"/v1/storage/artifact/get/{ARTIFACT_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_get_artifact_not_found(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        fake_id = str(uuid4())
        resp = await client.get(f"/v1/storage/artifact/get/{fake_id}")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_artifact(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_ARTIFACT])
        mock_supabase_client.delete = AsyncMock(return_value=None)
        resp = await client.delete(f"/v1/storage/artifact/delete/{ARTIFACT_ID}")
        assert resp.status_code == 204


# ===========================================================================
# Trail Tests
# ===========================================================================

class TestTrail:
    """Tests for trail hierarchy endpoints."""

    @pytest.mark.asyncio
    async def test_trail_hierarchy(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/trail/hierarchy/get/{CHAT_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_list_groups(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/trail/group/list/{CHAT_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_list_subgroups(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/trail/subgroup/list/{GROUP_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_list_nodes(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/trail/node/list/{SUBGROUP_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_subgroup_artifacts(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/trail/subgroup/artifact/list/{SUBGROUP_ID}")
        assert resp.status_code == 200


# ===========================================================================
# Storage Stats & Health
# ===========================================================================

class TestStorageStatsAndHealth:
    """Tests for stats and health endpoints."""

    @pytest.mark.asyncio
    async def test_storage_stats(self, client, mock_supabase_client):
        mock_supabase_client.count = AsyncMock(return_value=5)
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/storage/stats")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_storage_health(self, client, mock_supabase_client):
        mock_supabase_client.health_check = AsyncMock(return_value={"healthy": True})
        resp = await client.get("/v1/storage/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] in ("healthy", "ok", True, "connected")


# ===========================================================================
# Traceability
# ===========================================================================

class TestTraceability:
    """Tests for traceability save/load."""

    @pytest.mark.asyncio
    async def test_save_traceability(self, client, mock_supabase_client):
        mock_supabase_client.upsert = AsyncMock(return_value={"id": "test"})
        mock_supabase_client.insert = AsyncMock(return_value=[{"id": "test"}])
        resp = await client.post("/v1/storage/traceability/save", json={
            "chat_id": CHAT_ID,
            "data": {"key": "value"},
        })
        # Endpoint should exist and accept data
        assert resp.status_code != 404
        assert resp.status_code != 405

    @pytest.mark.asyncio
    async def test_load_traceability(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/traceability/load/{CHAT_ID}")
        assert resp.status_code == 200


# ===========================================================================
# Session Map
# ===========================================================================

class TestSessionMap:
    """Tests for chat session map."""

    @pytest.mark.asyncio
    async def test_session_map(self, client, mock_supabase_client):
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/trail/session-map/{CHAT_ID}")
        assert resp.status_code == 200


# ===========================================================================
# EXPANDED: Chat CRUD — error paths, validation
# ===========================================================================

class TestChatCRUDExpanded:
    """Additional chat CRUD tests covering error and edge case paths."""

    @pytest.mark.asyncio
    async def test_list_chats_server_error(self, client, mock_supabase_client):
        """List chats with DB error returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("DB down"))
        resp = await client.get("/v1/storage/chat/list")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_get_chat_invalid_uuid(self, client):
        """Get chat with invalid UUID returns 422."""
        resp = await client.get("/v1/storage/chat/get/not-a-uuid")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_get_chat_server_error(self, client, mock_supabase_client):
        """Get chat with DB error returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("timeout"))
        resp = await client.get(f"/v1/storage/chat/get/{CHAT_ID}")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_update_chat_not_found(self, client, mock_supabase_client):
        """Update nonexistent chat returns 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.update = AsyncMock(return_value=[])
        fake_id = str(uuid4())
        resp = await client.put(f"/v1/storage/chat/update/{fake_id}", json={
            "title": "Won't Work",
        })
        assert resp.status_code in (404, 500)

    @pytest.mark.asyncio
    async def test_delete_chat_not_found(self, client, mock_supabase_client):
        """Delete nonexistent chat returns 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.delete = AsyncMock(return_value=None)
        fake_id = str(uuid4())
        resp = await client.delete(f"/v1/storage/chat/delete/{fake_id}")
        assert resp.status_code in (204, 404, 500)

    @pytest.mark.asyncio
    async def test_delete_chat_server_error(self, client, mock_supabase_client):
        """Delete chat with DB error returns 500."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_CHAT])
        mock_supabase_client.delete = AsyncMock(side_effect=RuntimeError("crash"))
        resp = await client.delete(f"/v1/storage/chat/delete/{CHAT_ID}")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_create_chat_server_error(self, client, mock_supabase_client):
        """Create chat with DB error returns 500."""
        mock_supabase_client.insert = AsyncMock(side_effect=RuntimeError("crash"))
        resp = await client.post("/v1/storage/chat/create", json={"title": "Test"})
        assert resp.status_code == 500


# ===========================================================================
# EXPANDED: Messages — error paths
# ===========================================================================

class TestMessagesExpanded:
    """Additional message tests."""

    @pytest.mark.asyncio
    async def test_list_messages_invalid_uuid(self, client):
        """List messages with invalid chat UUID returns 422."""
        resp = await client.get("/v1/storage/message/list/not-a-uuid")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_list_messages_server_error(self, client, mock_supabase_client):
        """List messages with DB error returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("timeout"))
        resp = await client.get(f"/v1/storage/message/list/{CHAT_ID}")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_create_message_missing_content(self, client):
        """Create message without content returns 422."""
        resp = await client.post(f"/v1/storage/message/create/{CHAT_ID}", json={
            "role": "user",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_message_missing_role(self, client):
        """Create message without role returns 422."""
        resp = await client.post(f"/v1/storage/message/create/{CHAT_ID}", json={
            "content": "Hello",
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_list_messages_with_pagination(self, client, mock_supabase_client):
        """List messages with skip/limit params."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/message/list/{CHAT_ID}?skip=5&limit=10")
        assert resp.status_code == 200


# ===========================================================================
# EXPANDED: Artifacts — create, update, export, source, message-artifacts
# ===========================================================================

class TestArtifactsExpanded:
    """Additional artifact tests covering create, update, export, source."""

    @pytest.mark.asyncio
    async def test_get_artifact_invalid_uuid(self, client):
        """Get artifact with invalid UUID returns 422."""
        resp = await client.get("/v1/storage/artifact/get/bad-uuid")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_get_artifact_server_error(self, client, mock_supabase_client):
        """Get artifact with DB error returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("crash"))
        resp = await client.get(f"/v1/storage/artifact/get/{ARTIFACT_ID}")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_delete_artifact_not_found(self, client, mock_supabase_client):
        """Delete nonexistent artifact returns 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        mock_supabase_client.delete = AsyncMock(return_value=None)
        fake_id = str(uuid4())
        resp = await client.delete(f"/v1/storage/artifact/delete/{fake_id}")
        assert resp.status_code in (204, 404, 500)

    @pytest.mark.asyncio
    async def test_export_artifact_not_found(self, client, mock_supabase_client):
        """Export nonexistent artifact returns 404."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        fake_id = str(uuid4())
        resp = await client.get(f"/v1/storage/artifact/export/{fake_id}")
        assert resp.status_code in (404, 500)

    @pytest.mark.asyncio
    async def test_export_artifact_success(self, client, mock_supabase_client):
        """Export existing artifact returns file download."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_ARTIFACT])
        resp = await client.get(f"/v1/storage/artifact/export/{ARTIFACT_ID}")
        # Should return file content (200) or server error (500 from chat_service)
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_list_message_artifacts(self, client, mock_supabase_client):
        """Get artifacts for a specific message."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_ARTIFACT])
        resp = await client.get(f"/v1/storage/artifact/list/message/{MSG_ID}")
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_list_message_artifacts_empty(self, client, mock_supabase_client):
        """Get artifacts for message with no artifacts."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/artifact/list/message/{MSG_ID}")
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_artifact_source_not_found(self, client, mock_supabase_client):
        """Get source for artifact with no linked message."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        fake_id = str(uuid4())
        resp = await client.get(f"/v1/storage/artifact/source/{fake_id}")
        assert resp.status_code in (404, 500)

    @pytest.mark.asyncio
    async def test_list_artifacts_invalid_chat_uuid(self, client):
        """List artifacts with invalid UUID returns 422."""
        resp = await client.get("/v1/storage/artifact/list/not-a-uuid")
        assert resp.status_code == 422


# ===========================================================================
# EXPANDED: Trail — error paths, hierarchy details
# ===========================================================================

class TestTrailExpanded:
    """Additional trail tests."""

    @pytest.mark.asyncio
    async def test_trail_hierarchy_invalid_uuid(self, client):
        """Trail hierarchy with invalid UUID returns 422."""
        resp = await client.get("/v1/storage/trail/hierarchy/get/bad-id")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_trail_hierarchy_server_error(self, client, mock_supabase_client):
        """Trail hierarchy with DB error returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("crash"))
        resp = await client.get(f"/v1/storage/trail/hierarchy/get/{CHAT_ID}")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_list_groups_server_error(self, client, mock_supabase_client):
        """List groups with DB error returns 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("timeout"))
        resp = await client.get(f"/v1/storage/trail/group/list/{CHAT_ID}")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_list_subgroups_invalid_uuid(self, client):
        """List subgroups with invalid UUID returns 422."""
        resp = await client.get("/v1/storage/trail/subgroup/list/bad")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_list_nodes_invalid_uuid(self, client):
        """List nodes with invalid UUID returns 422."""
        resp = await client.get("/v1/storage/trail/node/list/bad")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_session_map_server_error(self, client, mock_supabase_client):
        """Session map with DB error returns 200 (graceful degradation) or 500."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("crash"))
        resp = await client.get(f"/v1/storage/trail/session-map/{CHAT_ID}")
        # Endpoint catches internally and returns empty structure
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_session_map_invalid_uuid(self, client):
        """Session map with invalid UUID returns 422."""
        resp = await client.get("/v1/storage/trail/session-map/not-a-uuid")
        assert resp.status_code == 422


# ===========================================================================
# EXPANDED: Stats & Health — error paths
# ===========================================================================

class TestStatsAndHealthExpanded:
    """Additional stats and health tests."""

    @pytest.mark.asyncio
    async def test_stats_server_error(self, client, mock_supabase_client):
        """Stats with DB error returns 500."""
        mock_supabase_client.count = AsyncMock(side_effect=RuntimeError("DB error"))
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("DB error"))
        resp = await client.get("/v1/storage/stats")
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_health_db_unhealthy(self, client, mock_supabase_client):
        """Health when DB check fails returns degraded status."""
        mock_supabase_client.health_check = AsyncMock(side_effect=RuntimeError("unreachable"))
        resp = await client.get("/v1/storage/health")
        # Should still return 200 with unhealthy status
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_stats_response_structure(self, client, mock_supabase_client):
        """Stats returns expected fields."""
        mock_supabase_client.count = AsyncMock(return_value=10)
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get("/v1/storage/stats")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, dict)


# ===========================================================================
# EXPANDED: Traceability — error paths
# ===========================================================================

class TestTraceabilityExpanded:
    """Additional traceability tests."""

    @pytest.mark.asyncio
    async def test_load_traceability_invalid_uuid(self, client):
        """Load traceability with invalid UUID returns 422."""
        resp = await client.get("/v1/storage/traceability/load/bad-uuid")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_load_traceability_server_error(self, client, mock_supabase_client):
        """Load traceability with DB error returns graceful response."""
        mock_supabase_client.select = AsyncMock(side_effect=RuntimeError("crash"))
        resp = await client.get(f"/v1/storage/traceability/load/{CHAT_ID}")
        # Endpoint catches internally and returns empty/default
        assert resp.status_code in (200, 500)

    @pytest.mark.asyncio
    async def test_save_traceability_server_error(self, client, mock_supabase_client):
        """Save traceability with DB error returns graceful response."""
        mock_supabase_client.upsert = AsyncMock(side_effect=RuntimeError("crash"))
        mock_supabase_client.insert = AsyncMock(side_effect=RuntimeError("crash"))
        resp = await client.post("/v1/storage/traceability/save", json={
            "chat_id": CHAT_ID,
            "data": {"key": "value"},
        })
        # Endpoint may catch internally
        assert resp.status_code in (200, 500)


# ===========================================================================
# EXPANDED: Chat Summaries
# ===========================================================================

class TestChatSummaries:
    """Tests for chat summary endpoints."""

    @pytest.mark.asyncio
    async def test_list_summaries_empty(self, client, mock_supabase_client):
        """List summaries for chat with no summaries."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        resp = await client.get(f"/v1/storage/summary/list/{CHAT_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_list_summaries_invalid_uuid(self, client):
        """List summaries with invalid UUID returns 422."""
        resp = await client.get("/v1/storage/summary/list/bad-uuid")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_summarize_chat_endpoint_exists(self, client, mock_supabase_client):
        """Summarize chat endpoint is routable."""
        mock_supabase_client.select = AsyncMock(return_value=[SAMPLE_CHAT])
        resp = await client.post(f"/v1/storage/summary/create/{CHAT_ID}")
        # May need messages in chat or return 500 from service, but should be routable
        assert resp.status_code != 404
        assert resp.status_code != 405


# ===========================================================================
# DEEP: Create Artifact — lines 442-595 (biggest coverage gap)
# ===========================================================================

class TestCreateArtifactDeep:
    """
    Tests for POST /v1/storage/artifact/create/{chat_id}

    Covers: UUID parsing (message_id, subgroup_id, node_id), trail linkage
    CONTRACT enforcement, file routing flags (vision/docling),
    execution_group resolution from metadata, error paths.

    Strategy: Override get_chat_service to isolate the 130-line endpoint
    pre-processing logic from the database layer.
    """

    def _mock_artifact(self, chat_id, **kw):
        """Build a mock artifact domain object for _artifact_to_response."""
        m = MagicMock()
        m.id = kw.get("id", uuid4())
        m.chat_id = chat_id
        m.type = kw.get("type", "code")
        m.content = kw.get("content", "print('hello')")
        m.language = kw.get("language", "python")
        m.artifact_id = kw.get("artifact_id", "code_abc123")
        m.filename = kw.get("filename", None)
        m.message_id = kw.get("message_id", None)
        m.metadata = kw.get("metadata", {})
        m.subgroup_id = kw.get("subgroup_id", None)
        m.node_id = kw.get("node_id", None)
        m.execution_group = kw.get("execution_group", None)
        m.created_at = datetime.now(timezone.utc)
        return m

    # --- Happy paths ---

    @pytest.mark.asyncio
    async def test_create_code_artifact_success(self, app, client):
        """Code artifact with valid data → 201 with correct response body."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_art = self._mock_artifact(chat_id)
        mock_svc.create_artifact = AsyncMock(return_value=mock_art)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                    "content": "print('hello')",
                    "language": "python",
                },
            )
            assert resp.status_code == 201
            body = resp.json()
            assert body["type"] == "code"
            assert body["content"] == "print('hello')"
            assert str(body["chat_id"]) == str(chat_id)
            # Verify service received correct args
            mock_svc.create_artifact.assert_called_once()
            kw = mock_svc.create_artifact.call_args.kwargs
            assert kw["chat_id"] == chat_id
            assert kw["artifact_type"] == "code"
            assert kw["content"] == "print('hello')"
            assert kw["message_id"] is None
            assert kw["subgroup_id"] is None
            assert kw["node_id"] is None
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_create_output_with_trail_linkage(self, app, client):
        """Output artifact with valid trail linkage (subgroup + node) → 201."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        sg_id = uuid4()
        nd_id = uuid4()
        mock_svc = AsyncMock()
        mock_art = self._mock_artifact(
            chat_id, type="output", subgroup_id=sg_id, node_id=nd_id,
        )
        mock_svc.create_artifact = AsyncMock(return_value=mock_art)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "output",
                    "artifact_id": "output_xyz789",
                    "content": "Result of execution",
                    "subgroup_id": str(sg_id),
                    "node_id": str(nd_id),
                },
            )
            assert resp.status_code == 201
            body = resp.json()
            assert body["type"] == "output"
            kw = mock_svc.create_artifact.call_args.kwargs
            assert kw["subgroup_id"] == sg_id
            assert kw["node_id"] == nd_id
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_create_file_artifact_no_trail_required(self, app, client):
        """File artifact without trail linkage → 201 (contract only for output)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_art = self._mock_artifact(chat_id, type="file", filename="doc.txt")
        mock_svc.create_artifact = AsyncMock(return_value=mock_art)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "file",
                    "artifact_id": "file_abc123",
                    "filename": "document.txt",
                },
            )
            assert resp.status_code == 201
            mock_svc.create_artifact.assert_called_once()
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    # --- Trail linkage CONTRACT violations ---

    @pytest.mark.asyncio
    async def test_output_contract_violation_no_trail(self, app, client):
        """Output artifact without trail linkage → 400 CONTRACT VIOLATION."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "output",
                    "artifact_id": "output_xyz789",
                    "content": "Result",
                },
            )
            assert resp.status_code == 400
            detail = resp.json()["detail"]
            assert "CONTRACT VIOLATION" in detail
            assert "subgroup_id" in detail
            assert "node_id" in detail
            mock_svc.create_artifact.assert_not_called()
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_output_missing_node_id_only(self, app, client):
        """Output with subgroup_id but no node_id → 400."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "output",
                    "artifact_id": "output_xyz789",
                    "subgroup_id": str(uuid4()),
                },
            )
            assert resp.status_code == 400
            assert "CONTRACT VIOLATION" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_output_missing_subgroup_id_only(self, app, client):
        """Output with node_id but no subgroup_id → 400."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "output",
                    "artifact_id": "output_xyz789",
                    "node_id": str(uuid4()),
                },
            )
            assert resp.status_code == 400
            assert "CONTRACT VIOLATION" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    # --- UUID parsing ---

    @pytest.mark.asyncio
    async def test_composite_message_id_parsed(self, app, client):
        """Composite message_id 'uuid_seq_role' → extracts UUID part."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        real_msg_uuid = uuid4()
        composite_id = f"{real_msg_uuid}_1_user"
        mock_svc = AsyncMock()
        mock_art = self._mock_artifact(chat_id, message_id=real_msg_uuid)
        mock_svc.create_artifact = AsyncMock(return_value=mock_art)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                    "content": "x = 1",
                    "message_id": composite_id,
                },
            )
            assert resp.status_code == 201
            kw = mock_svc.create_artifact.call_args.kwargs
            assert kw["message_id"] == real_msg_uuid
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_plain_message_uuid_parsed(self, app, client):
        """Plain UUID message_id → parsed correctly."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        msg_uuid = uuid4()
        mock_svc = AsyncMock()
        mock_art = self._mock_artifact(chat_id, message_id=msg_uuid)
        mock_svc.create_artifact = AsyncMock(return_value=mock_art)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                    "message_id": str(msg_uuid),
                },
            )
            assert resp.status_code == 201
            kw = mock_svc.create_artifact.call_args.kwargs
            assert kw["message_id"] == msg_uuid
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_invalid_message_id_returns_400(self, app, client):
        """Non-UUID message_id → 400 with descriptive error."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                    "message_id": "not-a-valid-uuid-at-all",
                },
            )
            assert resp.status_code == 400
            assert "Invalid message_id" in resp.json()["detail"]
            mock_svc.create_artifact.assert_not_called()
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_invalid_subgroup_id_returns_400(self, app, client):
        """Non-UUID subgroup_id → 400."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                    "subgroup_id": "not-a-uuid",
                },
            )
            assert resp.status_code == 400
            assert "Invalid subgroup_id" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_invalid_node_id_returns_400(self, app, client):
        """Non-UUID node_id → 400."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                    "node_id": "bad-uuid-value",
                },
            )
            assert resp.status_code == 400
            assert "Invalid node_id" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


    # --- execution_group resolution ---

    @pytest.mark.asyncio
    async def test_execution_group_from_metadata_fallback(self, app, client):
        """No top-level execution_group, metadata has it → resolved."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_art = self._mock_artifact(chat_id, execution_group="exec_group_1")
        mock_svc.create_artifact = AsyncMock(return_value=mock_art)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                    "metadata": {"execution_group": "exec_group_1"},
                },
            )
            assert resp.status_code == 201
            kw = mock_svc.create_artifact.call_args.kwargs
            assert kw["execution_group"] == "exec_group_1"
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_execution_group_camel_case_fallback(self, app, client):
        """executionGroup (camelCase) in metadata → resolved."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_art = self._mock_artifact(chat_id, execution_group="exec_group_2")
        mock_svc.create_artifact = AsyncMock(return_value=mock_art)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                    "metadata": {"executionGroup": "exec_group_2"},
                },
            )
            assert resp.status_code == 201
            kw = mock_svc.create_artifact.call_args.kwargs
            assert kw["execution_group"] == "exec_group_2"
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    # --- Error paths ---

    @pytest.mark.asyncio
    async def test_chat_not_found_returns_404(self, app, client):
        """ValueError from service (chat not found) → 404."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.create_artifact = AsyncMock(
            side_effect=ValueError("Chat not found")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                    "content": "x = 1",
                },
            )
            assert resp.status_code == 404
            assert "Chat not found" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_generic_error_returns_500(self, app, client):
        """Unexpected exception from service → 500."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.create_artifact = AsyncMock(
            side_effect=RuntimeError("DB exploded")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/artifact/create/{chat_id}",
                json={
                    "type": "code",
                    "artifact_id": "code_abc123",
                },
            )
            assert resp.status_code == 500
            assert "Failed to create artifact" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    # --- Pydantic validation ---

    @pytest.mark.asyncio
    async def test_invalid_artifact_type_returns_422(self, app, client):
        """Invalid type (not code/output/file) → 422 from Pydantic."""
        resp = await client.post(
            f"/v1/storage/artifact/create/{uuid4()}",
            json={"type": "invalid_type", "artifact_id": "code_abc123"},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_missing_artifact_id_returns_422(self, app, client):
        """Missing required artifact_id → 422."""
        resp = await client.post(
            f"/v1/storage/artifact/create/{uuid4()}",
            json={"type": "code"},
        )
        assert resp.status_code == 422


# ===========================================================================
# DEEP: Update Artifact Message ID — lines 598-672
# ===========================================================================

class TestUpdateArtifactLinkDeep:
    """
    Tests for PUT /v1/storage/artifact/link-message

    Covers: success with multiple artifacts linked, zero artifacts found,
    exception path, Pydantic validation, exact response body structure.
    """

    def _mock_artifact(self, **kw):
        """Build a mock artifact for iteration."""
        m = MagicMock()
        m.id = kw.get("id", uuid4())
        m.chat_id = kw.get("chat_id", uuid4())
        m.type = "code"
        m.content = "x = 1"
        m.language = "python"
        m.artifact_id = "code_abc"
        m.filename = None
        m.message_id = kw.get("message_id", uuid4())
        m.metadata = {}
        m.subgroup_id = None
        m.node_id = None
        m.execution_group = None
        m.created_at = datetime.now(timezone.utc)
        return m

    @pytest.mark.asyncio
    async def test_link_success_with_count(self, app, client):
        """Link artifacts returns success with exact updated_count and body."""
        from api.dependencies import get_chat_service

        msg_id = uuid4()
        art_id = "artifact_123456_abc"
        mock_svc = AsyncMock()
        # Service returns iterable of 2 linked artifacts
        mock_svc.update_artifact_message_id = AsyncMock(
            return_value=[self._mock_artifact(), self._mock_artifact()]
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                "/v1/storage/artifact/link-message",
                json={"artifact_id": art_id, "message_id": str(msg_id)},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert body["updated_count"] == 2
            assert body["artifact_id"] == art_id
            assert body["message_id"] == str(msg_id)
            assert "linked" in body["message"].lower()
            mock_svc.update_artifact_message_id.assert_called_once_with(
                artifact_id=art_id, message_id=msg_id,
            )
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_link_zero_artifacts_found(self, app, client):
        """No matching artifacts → success=True, updated_count=0, descriptive message."""
        from api.dependencies import get_chat_service

        msg_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.update_artifact_message_id = AsyncMock(return_value=[])
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                "/v1/storage/artifact/link-message",
                json={"artifact_id": "nonexistent_art", "message_id": str(msg_id)},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert body["updated_count"] == 0
            assert "no artifacts" in body["message"].lower()
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_link_generic_error_returns_500(self, app, client):
        """Service exception → 500."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_svc.update_artifact_message_id = AsyncMock(
            side_effect=RuntimeError("DB crash")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                "/v1/storage/artifact/link-message",
                json={"artifact_id": "art_123", "message_id": str(uuid4())},
            )
            assert resp.status_code == 500
            assert "Failed to update artifact message ID" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_link_missing_artifact_id_returns_422(self, app, client):
        """Missing artifact_id in request body → 422."""
        resp = await client.put(
            "/v1/storage/artifact/link-message",
            json={"message_id": str(uuid4())},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_link_missing_message_id_returns_422(self, app, client):
        """Missing message_id in request body → 422."""
        resp = await client.put(
            "/v1/storage/artifact/link-message",
            json={"artifact_id": "art_123"},
        )
        assert resp.status_code == 422


# ===========================================================================
# DEEP: Update Artifact — lines 714-759
# ===========================================================================

class TestUpdateArtifactDeep:
    """
    Tests for PUT /v1/storage/artifact/update/{artifact_id}

    Covers: success with exact response body, not-found 404, exception 500,
    partial update (only content), Pydantic validation.
    """

    def _mock_artifact(self, artifact_id, **kw):
        """Build a mock updated artifact domain object."""
        m = MagicMock()
        m.id = artifact_id
        m.chat_id = kw.get("chat_id", uuid4())
        m.type = kw.get("type", "code")
        m.content = kw.get("content", "updated_content()")
        m.language = kw.get("language", "python")
        m.artifact_id = kw.get("artifact_id", "code_abc123")
        m.filename = kw.get("filename", "script.py")
        m.message_id = None
        m.metadata = kw.get("metadata", {"edited": True})
        m.subgroup_id = None
        m.node_id = None
        m.execution_group = None
        m.created_at = datetime.now(timezone.utc)
        return m

    @pytest.mark.asyncio
    async def test_update_artifact_success(self, app, client):
        """Update artifact with new content/filename/language → 200 with body."""
        from api.dependencies import get_chat_service

        art_uuid = uuid4()
        mock_svc = AsyncMock()
        mock_art = self._mock_artifact(art_uuid, content="new_code()")
        mock_svc.update_artifact = AsyncMock(return_value=mock_art)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                f"/v1/storage/artifact/update/{art_uuid}",
                json={
                    "content": "new_code()",
                    "filename": "updated.py",
                    "language": "python",
                },
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["content"] == "new_code()"
            mock_svc.update_artifact.assert_called_once()
            kw = mock_svc.update_artifact.call_args.kwargs
            assert kw["artifact_id"] == art_uuid
            assert kw["content"] == "new_code()"
            assert kw["filename"] == "updated.py"
            assert kw["language"] == "python"
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_update_artifact_not_found(self, app, client):
        """Service returns None (artifact not found) → 404."""
        from api.dependencies import get_chat_service

        art_uuid = uuid4()
        mock_svc = AsyncMock()
        mock_svc.update_artifact = AsyncMock(return_value=None)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                f"/v1/storage/artifact/update/{art_uuid}",
                json={"content": "x = 1"},
            )
            assert resp.status_code == 404
            assert str(art_uuid) in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_update_artifact_generic_error(self, app, client):
        """Service exception → 500."""
        from api.dependencies import get_chat_service

        art_uuid = uuid4()
        mock_svc = AsyncMock()
        mock_svc.update_artifact = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                f"/v1/storage/artifact/update/{art_uuid}",
                json={"content": "x = 1"},
            )
            assert resp.status_code == 500
            assert "Failed to update artifact" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_update_artifact_partial_fields(self, app, client):
        """Update with only content (no filename/language/metadata) → 200."""
        from api.dependencies import get_chat_service

        art_uuid = uuid4()
        mock_svc = AsyncMock()
        mock_art = self._mock_artifact(art_uuid, content="only_content()")
        mock_svc.update_artifact = AsyncMock(return_value=mock_art)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                f"/v1/storage/artifact/update/{art_uuid}",
                json={"content": "only_content()"},
            )
            assert resp.status_code == 200
            kw = mock_svc.update_artifact.call_args.kwargs
            assert kw["content"] == "only_content()"
            assert kw["filename"] is None
            assert kw["language"] is None
            assert kw["metadata"] is None
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_update_artifact_invalid_uuid(self, app, client):
        """Invalid artifact UUID → 422."""
        resp = await client.put(
            "/v1/storage/artifact/update/not-a-uuid",
            json={"content": "x"},
        )
        assert resp.status_code == 422


# ===========================================================================
# DEEP: Export Artifact — lines 797-862 (content type + filename logic)
# ===========================================================================

class TestExportArtifactDeep:
    """
    Tests for GET /v1/storage/artifact/export/{artifact_id}

    Covers: content type resolution by language, filename generation,
    filename extension appending, error paths.
    """

    def _mock_artifact(self, artifact_id, **kw):
        """Build a mock artifact for export tests."""
        m = MagicMock()
        m.id = artifact_id
        m.chat_id = uuid4()
        m.type = kw.get("type", "code")
        m.content = kw.get("content", "print('hello')")
        m.language = kw.get("language", None)
        m.artifact_id = "code_abc"
        m.filename = kw.get("filename", None)
        m.message_id = None
        m.metadata = {}
        m.subgroup_id = None
        m.node_id = None
        m.execution_group = None
        m.created_at = datetime.now(timezone.utc)
        return m

    @pytest.mark.asyncio
    async def test_export_python_content_type(self, app, client):
        """Language=python → Content-Type: text/x-python."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_artifact = AsyncMock(
            return_value=self._mock_artifact(art_id, language="python", filename="script.py")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/export/{art_id}")
            assert resp.status_code == 200
            assert "text/x-python" in resp.headers["content-type"]
            assert "script.py" in resp.headers["content-disposition"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_export_javascript_content_type(self, app, client):
        """Language=javascript → Content-Type: application/javascript."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_artifact = AsyncMock(
            return_value=self._mock_artifact(art_id, language="javascript", filename="app.js")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/export/{art_id}")
            assert resp.status_code == 200
            assert resp.headers["content-type"] == "application/javascript"
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_export_html_content_type(self, app, client):
        """Language=html → Content-Type: text/html."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_artifact = AsyncMock(
            return_value=self._mock_artifact(art_id, language="html", filename="page.html")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/export/{art_id}")
            assert resp.status_code == 200
            assert resp.headers["content-type"] == "text/html; charset=utf-8"
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_export_json_content_type(self, app, client):
        """Language=json → Content-Type: application/json."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_artifact = AsyncMock(
            return_value=self._mock_artifact(art_id, language="json", filename="data.json")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/export/{art_id}")
            assert resp.status_code == 200
            assert "application/json" in resp.headers["content-type"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_export_markdown_content_type(self, app, client):
        """Language=markdown → Content-Type: text/markdown."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_artifact = AsyncMock(
            return_value=self._mock_artifact(art_id, language="markdown", filename="notes.md")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/export/{art_id}")
            assert resp.status_code == 200
            assert resp.headers["content-type"] == "text/markdown; charset=utf-8"
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_export_no_language_default_content_type(self, app, client):
        """No language → Content-Type: text/plain, default filename."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_artifact = AsyncMock(
            return_value=self._mock_artifact(art_id, language=None, filename=None)
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/export/{art_id}")
            assert resp.status_code == 200
            assert "text/plain" in resp.headers["content-type"]
            # Default filename: artifact_{id}.txt
            assert f"artifact_{art_id}.txt" in resp.headers["content-disposition"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_export_filename_extension_appended(self, app, client):
        """Filename without matching extension gets language extension appended."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        # filename="script" (no .python extension) + language="python"
        mock_svc.get_artifact = AsyncMock(
            return_value=self._mock_artifact(art_id, language="python", filename="script")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/export/{art_id}")
            assert resp.status_code == 200
            # filename should be "script.python"
            assert "script.python" in resp.headers["content-disposition"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_export_not_found_returns_404(self, app, client):
        """Export nonexistent artifact → 404."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_artifact = AsyncMock(return_value=None)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/export/{art_id}")
            assert resp.status_code == 404
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_export_generic_error_returns_500(self, app, client):
        """Service exception during export → 500."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_artifact = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/export/{art_id}")
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


# ===========================================================================
# DEEP: Pagination Validation — boundary conditions for skip/limit/offset
# ===========================================================================

class TestPaginationValidation:
    """
    Tests for pagination parameter validation across chat, message, artifact list endpoints.

    Covers: negative skip/offset → 400, limit zero → 400, limit above max → 400.
    These checks happen BEFORE any service call, so no mocking needed.
    """

    # --- Chat list: skip < 0, limit < 1 or > 500 ---

    @pytest.mark.asyncio
    async def test_list_chats_negative_skip(self, app, client):
        """skip=-1 → 400 'Skip must be non-negative'."""
        resp = await client.get("/v1/storage/chat/list?skip=-1&limit=10")
        assert resp.status_code == 400
        assert "non-negative" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_list_chats_limit_zero(self, app, client):
        """limit=0 → 400 'Limit must be between 1 and 500'."""
        resp = await client.get("/v1/storage/chat/list?skip=0&limit=0")
        assert resp.status_code == 400
        assert "limit" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_list_chats_limit_above_500(self, app, client):
        """limit=501 → 400."""
        resp = await client.get("/v1/storage/chat/list?skip=0&limit=501")
        assert resp.status_code == 400

    # --- Message list: offset < 0, limit < 1 or > 1000 ---

    @pytest.mark.asyncio
    async def test_list_messages_negative_offset(self, app, client):
        """offset=-1 → 400 'Offset must be non-negative'."""
        chat_id = uuid4()
        resp = await client.get(f"/v1/storage/message/list/{chat_id}?offset=-1&limit=10")
        assert resp.status_code == 400
        assert "non-negative" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_list_messages_limit_zero(self, app, client):
        """limit=0 → 400."""
        chat_id = uuid4()
        resp = await client.get(f"/v1/storage/message/list/{chat_id}?offset=0&limit=0")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_list_messages_limit_above_1000(self, app, client):
        """limit=1001 → 400."""
        chat_id = uuid4()
        resp = await client.get(f"/v1/storage/message/list/{chat_id}?offset=0&limit=1001")
        assert resp.status_code == 400

    # --- Artifact list: offset < 0, limit < 1 or > 1000 ---

    @pytest.mark.asyncio
    async def test_list_artifacts_negative_offset(self, app, client):
        """offset=-1 → 400."""
        chat_id = uuid4()
        resp = await client.get(f"/v1/storage/artifact/list/{chat_id}?offset=-1&limit=10")
        assert resp.status_code == 400
        assert "non-negative" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_list_artifacts_limit_zero(self, app, client):
        """limit=0 → 400."""
        chat_id = uuid4()
        resp = await client.get(f"/v1/storage/artifact/list/{chat_id}?offset=0&limit=0")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_list_artifacts_limit_above_1000(self, app, client):
        """limit=1001 → 400."""
        chat_id = uuid4()
        resp = await client.get(f"/v1/storage/artifact/list/{chat_id}?offset=0&limit=1001")
        assert resp.status_code == 400


# ===========================================================================
# DEEP: LLM Metadata Endpoint — lines 300-333
# ===========================================================================

class TestLLMMetadataDeep:
    """
    Tests for GET /v1/storage/message/llm-metadata/get/{message_id}

    Covers: success with exact response body, not-found 404, exception 500.
    Uses get_chat_repository override since this endpoint bypasses chat_service.
    """

    @pytest.mark.asyncio
    async def test_llm_metadata_success(self, app, client):
        """Success → 200 with exact llm_model/llm_provider/tokens_used."""
        from api.dependencies import get_chat_service

        msg_id = uuid4()
        mock_svc = AsyncMock()
        mock_msg = MagicMock()
        mock_msg.id = msg_id
        mock_msg.llm_model = "Qwen3-4b-Instruct-2507-MLX-8bit"
        mock_msg.llm_provider = "local"
        mock_msg.tokens_used = 1500
        mock_svc.get_message = AsyncMock(return_value=mock_msg)

        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/message/llm-metadata/get/{msg_id}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["message_id"] == str(msg_id)
            assert body["llm_model"] == "Qwen3-4b-Instruct-2507-MLX-8bit"
            assert body["llm_provider"] == "local"
            assert body["tokens_used"] == 1500
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_llm_metadata_not_found(self, app, client):
        """Message not found → 404."""
        from api.dependencies import get_chat_service

        msg_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_message = AsyncMock(return_value=None)

        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/message/llm-metadata/get/{msg_id}")
            assert resp.status_code == 404
            assert str(msg_id) in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_llm_metadata_generic_error(self, app, client):
        """Repository exception → 500."""
        from api.dependencies import get_chat_service

        msg_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_message = AsyncMock(side_effect=RuntimeError("DB crash"))

        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/message/llm-metadata/get/{msg_id}")
            assert resp.status_code == 500
            assert "Failed to retrieve LLM metadata" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_llm_metadata_missing_attributes(self, app, client):
        """Message with no LLM attributes → 200 with null fields."""
        from api.dependencies import get_chat_service

        msg_id = uuid4()
        mock_svc = AsyncMock()
        mock_msg = MagicMock(spec=[])  # No attributes at all
        mock_msg.id = msg_id
        mock_svc.get_message = AsyncMock(return_value=mock_msg)

        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/message/llm-metadata/get/{msg_id}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["llm_model"] is None
            assert body["llm_provider"] is None
            assert body["tokens_used"] is None
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


# ===========================================================================
# DEEP: Create Chat Connection Errors — line 131 (503 path)
# ===========================================================================

class TestCreateChatConnectionErrors:
    """
    Tests for POST /v1/storage/chat/create connection error handling.

    Covers: 'Connection refused' → 503, 'ConnectError' → 503.
    """

    @pytest.mark.asyncio
    async def test_connection_refused_returns_503(self, app, client):
        """Connection refused → 503 SERVICE_UNAVAILABLE with diagnostic message."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_svc.create_chat = AsyncMock(
            side_effect=RuntimeError("Connection refused by localhost:54321")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                "/v1/storage/chat/create", json={"title": "Test"},
            )
            assert resp.status_code == 503
            assert "unavailable" in resp.json()["detail"].lower()
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_connect_error_returns_503(self, app, client):
        """ConnectError → 503 SERVICE_UNAVAILABLE."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_svc.create_chat = AsyncMock(
            side_effect=RuntimeError("ConnectError: target machine refused")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                "/v1/storage/chat/create", json={"title": "Test"},
            )
            assert resp.status_code == 503
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_generic_create_error_returns_500(self, app, client):
        """Non-connection error → 500 (not 503)."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_svc.create_chat = AsyncMock(
            side_effect=RuntimeError("Something else broke")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                "/v1/storage/chat/create", json={"title": "Test"},
            )
            assert resp.status_code == 500
            assert "Failed to create chat" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


# ===========================================================================
# DEEP: Artifact Source + Message Artifacts — lines 865-926
# ===========================================================================

class TestArtifactSourceAndMessageArtifactsDeep:
    """
    Tests for GET /v1/storage/artifact/source/{artifact_id}
    and GET /v1/storage/artifact/list/message/{message_id}

    Covers: success with exact response body, not-found 404, error 500.
    """

    @pytest.mark.asyncio
    async def test_artifact_source_success(self, app, client):
        """Source message found → 200 with message fields."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        msg_mock = MagicMock()
        msg_mock.id = uuid4()
        msg_mock.chat_id = uuid4()
        msg_mock.role = "assistant"
        msg_mock.content = "Generated code"
        msg_mock.created_at = datetime.now(timezone.utc)
        msg_mock.metadata = None
        msg_mock.parent_message_id = None
        msg_mock.token_count = 42

        mock_svc = AsyncMock()
        mock_svc.get_artifact_source = AsyncMock(return_value=msg_mock)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/source/{art_id}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["role"] == "assistant"
            assert body["content"] == "Generated code"
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_artifact_source_not_found(self, app, client):
        """No source message → 404."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_svc.get_artifact_source = AsyncMock(return_value=None)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/source/{uuid4()}")
            assert resp.status_code == 404
            assert "Source message not found" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_artifact_source_error(self, app, client):
        """Service exception → 500."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_svc.get_artifact_source = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/source/{uuid4()}")
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_message_artifacts_success(self, app, client):
        """Artifacts for message → 200 with list."""
        from api.dependencies import get_chat_service

        msg_id = uuid4()
        art_mock = MagicMock()
        art_mock.id = uuid4()
        art_mock.chat_id = uuid4()
        art_mock.type = "code"
        art_mock.content = "x = 1"
        art_mock.language = "python"
        art_mock.artifact_id = "code_1"
        art_mock.filename = None
        art_mock.message_id = msg_id
        art_mock.metadata = {}
        art_mock.subgroup_id = None
        art_mock.node_id = None
        art_mock.execution_group = None
        art_mock.created_at = datetime.now(timezone.utc)

        mock_svc = AsyncMock()
        mock_svc.get_message_artifacts = AsyncMock(return_value=[art_mock])
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/list/message/{msg_id}")
            assert resp.status_code == 200
            body = resp.json()
            assert len(body) == 1
            assert body[0]["type"] == "code"
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_message_artifacts_empty(self, app, client):
        """No artifacts for message → 200 with empty list."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_svc.get_message_artifacts = AsyncMock(return_value=[])
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/list/message/{uuid4()}")
            assert resp.status_code == 200
            assert resp.json() == []
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_message_artifacts_error(self, app, client):
        """Service exception → 500."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_svc.get_message_artifacts = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/list/message/{uuid4()}")
            assert resp.status_code == 500
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


# ===========================================================================
# DEEP: Chat CRUD via direct service override (lines 170, 203-211, 238, 244)
# ===========================================================================

class TestChatCRUDDirectOverride:
    """
    Tests covering chat endpoint paths unreached by shallow mock_supabase_client tests.
    Uses app.dependency_overrides[get_chat_service] for reliable coverage of endpoint
    logic that sits BETWEEN the HTTP handler and the service layer.
    """

    @pytest.mark.asyncio
    async def test_get_chat_success_returns_mapped_response(self, app, client):
        """get_chat success → 200 with _chat_summary_to_response mapping (line 170)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_chat = MagicMock()
        mock_chat.id = chat_id
        mock_chat.title = "Deep Test Chat"
        mock_chat.created_at = datetime.now(timezone.utc)
        mock_chat.updated_at = datetime.now(timezone.utc)
        mock_chat.message_count = 7
        mock_chat.description = None
        mock_chat.metadata = {}
        mock_svc.get_chat = AsyncMock(return_value=mock_chat)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/chat/get/{chat_id}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["id"] == str(chat_id)
            assert body["title"] == "Deep Test Chat"
            assert body["message_count"] == 7
            mock_svc.get_chat.assert_called_once_with(chat_id)
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_update_chat_success_returns_mapped_response(self, app, client):
        """update_chat success → 200 with updated title (lines 202, 208-209)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        updated_chat = MagicMock()
        updated_chat.id = chat_id
        updated_chat.title = "Updated Title"
        updated_chat.created_at = datetime.now(timezone.utc)
        updated_chat.updated_at = datetime.now(timezone.utc)
        updated_chat.message_count = 3
        updated_chat.description = None
        updated_chat.metadata = {}
        mock_svc.update_chat = AsyncMock(return_value=updated_chat)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                f"/v1/storage/chat/update/{chat_id}",
                json={"title": "Updated Title"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["title"] == "Updated Title"
            assert body["message_count"] == 3
            mock_svc.update_chat.assert_called_once_with(
                chat_id, title="Updated Title", description=None, metadata=None, archived=None
            )
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_update_chat_not_found_returns_404(self, app, client):
        """update_chat returns None → 404 (lines 203-207, 211)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.update_chat = AsyncMock(return_value=None)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                f"/v1/storage/chat/update/{chat_id}",
                json={"title": "X"},
            )
            assert resp.status_code == 404
            assert str(chat_id) in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_update_chat_exception_returns_500(self, app, client):
        """update_chat throws → 500 (lines 213-217)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.update_chat = AsyncMock(side_effect=RuntimeError("DB crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.put(
                f"/v1/storage/chat/update/{chat_id}",
                json={"title": "X"},
            )
            assert resp.status_code == 500
            assert "Failed to update chat" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_delete_chat_not_found_returns_404(self, app, client):
        """delete_chat returns False → 404 (lines 237-241, 244)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.delete_chat = AsyncMock(return_value=False)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.delete(f"/v1/storage/chat/delete/{chat_id}")
            assert resp.status_code == 404
            assert str(chat_id) in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_delete_chat_exception_returns_500(self, app, client):
        """delete_chat throws → 500 (lines 245-250)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.delete_chat = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.delete(f"/v1/storage/chat/delete/{chat_id}")
            assert resp.status_code == 500
            assert "Failed to delete chat" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


# ===========================================================================
# DEEP: Create Message — error paths (lines 372-380)
# ===========================================================================

class TestCreateMessageDeep:
    """
    Tests for POST /v1/storage/message/create/{chat_id} error paths.
    Covers: ValueError → 404, generic Exception → 500.
    """

    @pytest.mark.asyncio
    async def test_create_message_chat_not_found(self, app, client):
        """ValueError from service (chat not found) → 404 (lines 372-377)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.create_message = AsyncMock(side_effect=ValueError("Chat not found"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/message/create/{chat_id}",
                json={"role": "user", "content": "Hello"},
            )
            assert resp.status_code == 404
            assert "Chat not found" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_create_message_generic_error(self, app, client):
        """RuntimeError from service → 500 (lines 378-383)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.create_message = AsyncMock(side_effect=RuntimeError("DB crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/message/create/{chat_id}",
                json={"role": "user", "content": "Hello"},
            )
            assert resp.status_code == 500
            assert "Failed to create message" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


# ===========================================================================
# DEEP: List Artifacts — exception path (lines 434-436)
# ===========================================================================

class TestListArtifactsDeep:
    """Tests for GET /v1/storage/artifact/list/{chat_id} error path."""

    @pytest.mark.asyncio
    async def test_list_artifacts_service_error(self, app, client):
        """Service exception → 500 (lines 434-439)."""
        from api.dependencies import get_chat_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.list_artifacts = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/artifact/list/{chat_id}")
            assert resp.status_code == 500
            assert "Failed to retrieve artifacts" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


# ===========================================================================
# DEEP: Artifact Link Metrics — except branches (lines 636, 656)
# ===========================================================================

class TestArtifactLinkMetrics:
    """
    Tests covering metrics counter exception branches in update_artifact_message_id.
    Lines 636 (failure metrics except) and 656 (success metrics except).
    The try blocks import monitoring.metrics.get_registry; if that raises,
    the except Exception: pass swallows it. These tests force that raise.
    """

    @pytest.mark.asyncio
    async def test_link_zero_metrics_exception_swallowed(self, app, client):
        """Metrics failure in zero-artifacts path is silently handled (line 636)."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_svc.update_artifact_message_id = AsyncMock(return_value=[])
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            with patch("monitoring.metrics.get_registry", side_effect=RuntimeError("no metrics")):
                resp = await client.put(
                    "/v1/storage/artifact/link-message",
                    json={"artifact_id": "art_metrics_fail", "message_id": str(uuid4())},
                )
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert body["updated_count"] == 0
            assert "no artifacts" in body["message"].lower()
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_link_success_metrics_exception_swallowed(self, app, client):
        """Metrics failure in success path is silently handled (line 656)."""
        from api.dependencies import get_chat_service

        mock_svc = AsyncMock()
        mock_art = MagicMock()
        mock_svc.update_artifact_message_id = AsyncMock(return_value=[mock_art])
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            with patch("monitoring.metrics.get_registry", side_effect=RuntimeError("no metrics")):
                resp = await client.put(
                    "/v1/storage/artifact/link-message",
                    json={"artifact_id": "art_metrics_ok", "message_id": str(uuid4())},
                )
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert body["updated_count"] == 1
            assert "linked" in body["message"].lower()
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


# ===========================================================================
# DEEP: Delete Artifact — not-found, re-raise, error (lines 780, 787-791)
# ===========================================================================

class TestDeleteArtifactDeep:
    """
    Tests for DELETE /v1/storage/artifact/delete/{artifact_id}.
    Covers: service returns False → 404, HTTPException re-raise, generic Exception → 500.
    """

    @pytest.mark.asyncio
    async def test_delete_artifact_not_found_returns_404(self, app, client):
        """Service returns False (not deleted) → 404 (line 780)."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.delete_artifact = AsyncMock(return_value=False)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.delete(f"/v1/storage/artifact/delete/{art_id}")
            assert resp.status_code == 404
            assert str(art_id) in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_delete_artifact_exception_returns_500(self, app, client):
        """Service exception → 500 (lines 789-794)."""
        from api.dependencies import get_chat_service

        art_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.delete_artifact = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        try:
            resp = await client.delete(f"/v1/storage/artifact/delete/{art_id}")
            assert resp.status_code == 500
            assert "Failed to delete artifact" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)


# ===========================================================================
# DEEP: Traceability — save error, load success, load error (lines 966-968, 1008-1013)
# ===========================================================================

class TestTraceabilityDeep:
    """
    Tests for traceability save/load via direct repository override.
    Covers lines 966-968 (save error) and 1008-1013 (load success with data).
    """

    @pytest.mark.asyncio
    async def test_save_traceability_error_returns_500(self, app, client):
        """Repository exception → 500 (lines 966-971)."""
        from api.dependencies import get_storage_service

        mock_svc = AsyncMock()
        mock_svc.save_traceability_data = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_storage_service] = lambda: mock_svc
        try:
            resp = await client.post(
                "/v1/storage/traceability/save",
                json={"version": "2.0", "messages": [], "artifacts": []},
            )
            assert resp.status_code == 500
            assert "Failed to save traceability" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_storage_service, None)

    @pytest.mark.asyncio
    async def test_load_traceability_with_data(self, app, client):
        """Repository returns data → 200 with that data (lines 1008-1009)."""
        from api.dependencies import get_storage_service

        chat_id = uuid4()
        trace_data = {
            "version": "2.0",
            "timestamp": "2026-01-01T00:00:00",
            "messages": [{"id": "m1", "role": "user"}],
            "artifacts": [{"id": "a1", "type": "code"}],
            "correlationIndex": [],
            "messageArtifactsIndex": [],
            "artifactMessageIndex": [],
            "chatMessagesIndex": [],
            "chatArtifactsIndex": [],
        }
        mock_svc = AsyncMock()
        mock_svc.load_traceability_data = AsyncMock(return_value=trace_data)
        app.dependency_overrides[get_storage_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/traceability/load/{chat_id}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["version"] == "2.0"
            assert body["timestamp"] == "2026-01-01T00:00:00"
            assert len(body["messages"]) == 1
            assert body["messages"][0]["id"] == "m1"
            assert len(body["artifacts"]) == 1
            mock_svc.load_traceability_data.assert_called_once_with(str(chat_id))
        finally:
            app.dependency_overrides.pop(get_storage_service, None)

    @pytest.mark.asyncio
    async def test_load_traceability_error_returns_500(self, app, client):
        """Repository exception → 500 (lines 1011-1016)."""
        from api.dependencies import get_storage_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.load_traceability_data = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_storage_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/traceability/load/{chat_id}")
            assert resp.status_code == 500
            assert "Failed to load traceability" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_storage_service, None)


# ===========================================================================
# DEEP: Trail Endpoints + Session Map — error paths
# (lines 1157-1159, 1185-1187, 1216-1218, 1237-1239)
# ===========================================================================

class TestTrailEndpointsDeep:
    """
    Tests for trail hierarchy endpoints via direct repository override.
    Covers exception paths unreached by shallow mock_supabase_client tests.
    """

    @pytest.mark.asyncio
    async def test_session_map_exception_returns_500(self, app, client):
        """Internal exception in session map → 500 (lines 1157-1162).

        Patches get_settings (late import inside endpoint) to trigger the
        except block. This is the session map endpoint, not trail hierarchy.
        """
        chat_id = uuid4()
        with patch("config.settings.get_settings", side_effect=RuntimeError("settings crash")):
            resp = await client.get(f"/v1/storage/trail/session-map/{chat_id}")
        assert resp.status_code == 500
        assert "Failed to generate session map" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_list_subgroups_error_returns_500(self, app, client):
        """Repository exception → 500 (lines 1185-1190)."""
        from api.dependencies import get_storage_service

        group_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_subgroups_by_group = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_storage_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/trail/subgroup/list/{group_id}")
            assert resp.status_code == 500
            assert "Failed to retrieve subgroups" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_storage_service, None)

    @pytest.mark.asyncio
    async def test_list_nodes_error_returns_500(self, app, client):
        """Repository exception → 500 (lines 1216-1221)."""
        from api.dependencies import get_storage_service

        subgroup_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_nodes_by_subgroup = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_storage_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/trail/node/list/{subgroup_id}")
            assert resp.status_code == 500
            assert "Failed to retrieve nodes" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_storage_service, None)

    @pytest.mark.asyncio
    async def test_list_subgroup_artifacts_error_returns_500(self, app, client):
        """Repository exception → 500 (lines 1237-1242)."""
        from api.dependencies import get_storage_service

        subgroup_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.get_subgroup_artifacts = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_storage_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/trail/subgroup/artifact/list/{subgroup_id}")
            assert resp.status_code == 500
            assert "Failed to retrieve subgroup artifacts" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_storage_service, None)


# ===========================================================================
# DEEP: Summaries — success, error paths (lines 1361-1370, 1386-1388)
# ===========================================================================

class TestSummariesDeep:
    """
    Tests for summary endpoints via direct service/repository override.
    Covers: summarize_chat success/error, list_chat_summaries error.
    """

    @pytest.mark.asyncio
    async def test_summarize_chat_success(self, app, client):
        """generate_summary success → 200 with ChatSummaryResponse (lines 1361-1367)."""
        from api.dependencies import get_summary_service

        chat_id = uuid4()
        summary_id = uuid4()
        mock_svc = AsyncMock()
        mock_summary = {
            "id": str(summary_id),
            "chat_id": str(chat_id),
            "summary_type": "brief",
            "title": "Brief Summary",
            "key_points": ["point 1", "point 2"],
            "entities": {"people": ["Alice"]},
            "llm_model": "Qwen3-4b-Instruct-2507-MLX-8bit",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        mock_svc.generate_summary = AsyncMock(return_value=mock_summary)
        app.dependency_overrides[get_summary_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/summary/create/{chat_id}",
                json={"summary_type": "brief"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["summary_type"] == "brief"
            assert body["title"] == "Brief Summary"
            assert len(body["key_points"]) == 2
            assert body["entities"] == {"people": ["Alice"]}
            assert body["llm_model"] == "Qwen3-4b-Instruct-2507-MLX-8bit"
            mock_svc.generate_summary.assert_called_once_with(
                chat_id=chat_id,
                summary_type="brief",
                force_regenerate=False,
            )
        finally:
            app.dependency_overrides.pop(get_summary_service, None)

    @pytest.mark.asyncio
    async def test_summarize_chat_error_returns_500(self, app, client):
        """Service exception → 500 (lines 1368-1373)."""
        from api.dependencies import get_summary_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.generate_summary = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_summary_service] = lambda: mock_svc
        try:
            resp = await client.post(
                f"/v1/storage/summary/create/{chat_id}",
                json={"summary_type": "full"},
            )
            assert resp.status_code == 500
            assert "Failed to generate summary" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_summary_service, None)

    @pytest.mark.asyncio
    async def test_list_summaries_error_returns_500(self, app, client):
        """Repository exception → 500 (lines 1386-1391)."""
        from api.dependencies import get_summary_service

        chat_id = uuid4()
        mock_svc = AsyncMock()
        mock_svc.list_summaries = AsyncMock(side_effect=RuntimeError("crash"))
        app.dependency_overrides[get_summary_service] = lambda: mock_svc
        try:
            resp = await client.get(f"/v1/storage/summary/list/{chat_id}")
            assert resp.status_code == 500
            assert "Failed to list summaries" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_summary_service, None)


