"""
Unit tests for smaller API endpoints that lack dedicated test files.

Remaining: skills, chat_references, utils, schema validators.

Moved to dedicated files:
 - inference → test_inference_endpoint.py
 - user_credentials → test_user_credentials_endpoint.py
 - preferences → test_preferences_endpoint.py
 - sources → test_sources_endpoint.py
 - workers → test_workers_endpoint.py
 - omni → test_omni_endpoint.py
 - terminal → test_terminal_endpoint.py
 - document → test_document_endpoint.py

CI: pytest tests/unit/api/test_smaller_endpoints.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4


# ===========================================================================
# Inference Endpoints — Moved to test_inference_endpoint.py
# ===========================================================================


# ===========================================================================
# User Credentials — Moved to test_user_credentials_endpoint.py
# ===========================================================================


# ===========================================================================
# Preferences — Moved to test_preferences_endpoint.py
# ===========================================================================


# ===========================================================================
# Skills (/v1/skills/*)
# ===========================================================================

class TestChatReferences:
    """Tests for chat reference endpoints — body + validation checks."""

    @pytest.mark.asyncio
    async def test_list_references_empty(self, client, mock_supabase_client):
        """GET /v1/storage/chat/reference/list/{id} with no refs → 200 + empty list."""
        mock_supabase_client.select = AsyncMock(return_value=[])
        chat_id = str(uuid4())
        resp = await client.get(f"/v1/storage/chat/reference/list/{chat_id}")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, (dict, list))

    @pytest.mark.asyncio
    async def test_list_references_invalid_uuid_422(self, client):
        """Invalid UUID path parameter → 422 validation error."""
        resp = await client.get("/v1/storage/chat/reference/list/bad-uuid")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_reference(self, client, app):
        """POST /v1/storage/chat/reference/create/{id} with correct ChatReferenceCreate."""
        from api.dependencies import get_chat_service
        target_id = str(uuid4())
        chat_id = str(uuid4())
        ref_id = str(uuid4())
        ref_data = {
            "id": ref_id,
            "source_chat_id": chat_id,
            "target_chat_id": target_id,
            "reference_type": "context",
            "metadata": {},
            "created_by": "user",
            "created_at": "2026-01-01T00:00:00Z",
        }
        mock_svc = MagicMock()
        mock_svc.get_chat_reference_by_chats = AsyncMock(return_value=None)
        mock_svc.create_chat_reference = AsyncMock(return_value=ref_data)
        app.dependency_overrides[get_chat_service] = lambda: mock_svc
        
        resp = await client.post(f"/v1/storage/chat/reference/create/{chat_id}", json={
            "target_chat_id": target_id,
            "reference_type": "context",
        })
        assert resp.status_code == 201
        body = resp.json()
        assert body["reference_type"] == "context"

    @pytest.mark.asyncio
    async def test_delete_reference(self, client, mock_supabase_client):
        """DELETE /v1/storage/chat/reference/delete/{id} → 200 on success."""
        mock_supabase_client.select = AsyncMock(return_value=[{"id": "ref-uuid"}])
        mock_supabase_client.delete = AsyncMock(return_value=None)
        ref_id = str(uuid4())
        resp = await client.delete(f"/v1/storage/chat/reference/delete/{ref_id}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_create_reference_existing_returns_existing(self, client, app):
        """Existing reference → returns it without creating duplicate (via repo mock)."""
        from api.dependencies import get_chat_service
        chat_id = str(uuid4())
        target_id = str(uuid4())
        ref_id = str(uuid4())
        existing = {
            "id": ref_id,
            "source_chat_id": chat_id,
            "target_chat_id": target_id,
            "reference_type": "context",
            "metadata": {},
            "created_by": "user",
            "created_at": "2026-01-01T00:00:00Z",
        }
        mock_chat_service = AsyncMock()
        mock_chat_service.get_chat_reference_by_chats = AsyncMock(return_value=existing)
        app.dependency_overrides[get_chat_service] = lambda: mock_chat_service
        try:
            resp = await client.post(f"/v1/storage/chat/reference/create/{chat_id}", json={
                "target_chat_id": target_id,
                "reference_type": "context",
            })
            assert resp.status_code == 201
            assert resp.json()["id"] == ref_id
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_create_reference_exception_500(self, client, app):
        """Generic exception in create → 500."""
        from api.dependencies import get_chat_service
        chat_id = str(uuid4())
        target_id = str(uuid4())
        mock_chat_service = AsyncMock()
        mock_chat_service.get_chat_reference_by_chats = AsyncMock(side_effect=RuntimeError("DB crash"))
        app.dependency_overrides[get_chat_service] = lambda: mock_chat_service
        try:
            resp = await client.post(f"/v1/storage/chat/reference/create/{chat_id}", json={
                "target_chat_id": target_id,
                "reference_type": "context",
            })
            assert resp.status_code == 500
            assert "Failed to create" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_list_references_exception_500(self, client, app):
        """Generic exception in list → 500."""
        from api.dependencies import get_chat_service
        chat_id = str(uuid4())
        mock_chat_service = AsyncMock()
        mock_chat_service.list_chat_references = AsyncMock(side_effect=RuntimeError("timeout"))
        app.dependency_overrides[get_chat_service] = lambda: mock_chat_service
        try:
            resp = await client.get(f"/v1/storage/chat/reference/list/{chat_id}")
            assert resp.status_code == 500
            assert "Failed to list" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_delete_reference_not_found_404(self, client, app):
        """Delete non-existent reference → 404."""
        from api.dependencies import get_chat_service
        mock_chat_service = AsyncMock()
        mock_chat_service.delete_chat_reference = AsyncMock(return_value=None)
        app.dependency_overrides[get_chat_service] = lambda: mock_chat_service
        try:
            ref_id = str(uuid4())
            resp = await client.delete(f"/v1/storage/chat/reference/delete/{ref_id}")
            assert resp.status_code == 404
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_delete_reference_exception_500(self, client, app):
        """Database error during delete → 500 with structured detail.

        Regression: previously, delete_chat_reference had no try/except
        for generic exceptions, causing unhandled errors to propagate as
        opaque 500s without a clean error message.
        """
        from api.dependencies import get_chat_service
        mock_chat_service = AsyncMock()
        mock_chat_service.delete_chat_reference = AsyncMock(
            side_effect=RuntimeError("DB connection lost")
        )
        app.dependency_overrides[get_chat_service] = lambda: mock_chat_service
        try:
            ref_id = str(uuid4())
            resp = await client.delete(f"/v1/storage/chat/reference/delete/{ref_id}")
            assert resp.status_code == 500
            assert "Failed to delete chat reference" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_delete_reference_returns_false_404(self, client, app):
        """repo.delete_chat_reference returns False (not None) → still 404."""
        from api.dependencies import get_chat_service
        ref_id = str(uuid4())
        mock_chat_service = AsyncMock()
        mock_chat_service.delete_chat_reference = AsyncMock(return_value=False)
        app.dependency_overrides[get_chat_service] = lambda: mock_chat_service
        try:
            ref_id = str(uuid4())
            resp = await client.delete(f"/v1/storage/chat/reference/delete/{ref_id}")
            assert resp.status_code == 404
            assert "not found" in resp.json()["detail"]
        finally:
            app.dependency_overrides.pop(get_chat_service, None)

    @pytest.mark.asyncio
    async def test_delete_reference_invalid_uuid_422(self, client):
        """Invalid UUID in delete path → 422."""
        resp = await client.delete("/v1/storage/chat/reference/delete/not-a-uuid")
        assert resp.status_code == 422


# ===========================================================================
# Document — Moved to test_document_endpoint.py
# ===========================================================================


# ===========================================================================
# Deep Coverage: Omni — Moved to test_omni_endpoint.py
# ===========================================================================


# ===========================================================================
# Deep Coverage: Workers — Moved to test_workers_endpoint.py
# ===========================================================================


# ===========================================================================
# Deep Coverage: Omni screenshot — Moved to test_omni_endpoint.py
# ===========================================================================


# ===========================================================================
# Deep Coverage: Sources — Moved to test_sources_endpoint.py
# ===========================================================================


# ===========================================================================
# Deep Coverage: Utils endpoints
# ===========================================================================

class TestUtilsDeep:
    """Cover extractive_process and rank_results endpoints."""

    @pytest.mark.asyncio
    async def test_extractive_process_success(self, client):
        """Success path with mocked ContextRanker (late import via sys.modules)."""
        mock_ranker = MagicMock()
        mock_ranker.rank_text.return_value = {
            "text": "Selected content here.",
            "chunks_total": 10,
            "chunks_selected": 3,
            "original_chars": 5000,
            "result_chars": 300,
            "processing_ms": 42,
        }
        mock_module = MagicMock()
        mock_module.ContextRanker = MagicMock(return_value=mock_ranker)
        with patch.dict("sys.modules", {"utils.context_ranker": mock_module}):
            resp = await client.post("/v1/utils/extractive", json={
                "text": "Long document text " * 100,
                "query": "relevant query",
                "budget_chars": 5000,
            })
        assert resp.status_code == 200
        body = resp.json()
        assert body["chunks_total"] == 10
        assert body["chunks_selected"] == 3

    @pytest.mark.asyncio
    async def test_extractive_process_exception_500(self, client):
        """Exception in ContextRanker constructor → 500."""
        mock_module = MagicMock()
        mock_module.ContextRanker = MagicMock(side_effect=RuntimeError("ranker init failed"))
        with patch.dict("sys.modules", {"utils.context_ranker": mock_module}):
            resp = await client.post("/v1/utils/extractive", json={
                "text": "Some text content",
                "budget_chars": 5000,
            })
        assert resp.status_code == 500
        assert "Extractive processing failed" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_rank_results_success(self, client):
        """Success path for rank_results."""
        mock_ranker = MagicMock()
        mock_ranker.rank_results.return_value = {
            "results": [{"content": "result1", "title": "t1"}],
            "total_input": 5,
            "total_selected": 1,
            "original_chars": 2000,
            "result_chars": 200,
            "processing_ms": 15,
        }
        mock_module = MagicMock()
        mock_module.ContextRanker = MagicMock(return_value=mock_ranker)
        with patch.dict("sys.modules", {"utils.context_ranker": mock_module}):
            resp = await client.post("/v1/utils/rank-results", json={
                "results": [
                    {"content": "result text", "title": "title1"},
                ],
                "query": "test query",
                "budget_chars": 5000,
            })
        assert resp.status_code == 200
        body = resp.json()
        assert body["total_input"] == 5
        assert body["total_selected"] == 1

    @pytest.mark.asyncio
    async def test_rank_results_exception_500(self, client):
        """Exception in ContextRanker constructor → 500."""
        mock_module = MagicMock()
        mock_module.ContextRanker = MagicMock(side_effect=ImportError("module not found"))
        with patch.dict("sys.modules", {"utils.context_ranker": mock_module}):
            resp = await client.post("/v1/utils/rank-results", json={
                "results": [{"content": "text"}],
                "query": "q",
                "budget_chars": 5000,
            })
        assert resp.status_code == 500
        assert "Rank results failed" in resp.json()["detail"]


# ===========================================================================
# Schema Validation: files.py (lines 40-42, 48, 52, 61, 93-95)
# ===========================================================================


class TestFilesSchemaValidation:
    """Test Pydantic validators in api/v1/schemas/files.py."""

    def test_create_invalid_location_type(self):
        """Lines 40-42: location_type not in ['primary', 'secondary'] raises."""
        from pydantic import ValidationError
        from api.v1.schemas.files import IndexingLocationCreate
        with pytest.raises(ValidationError, match="location_type"):
            IndexingLocationCreate(
                location_name="Test",
                root_path="/tmp",
                location_type="invalid",
            )

    def test_create_empty_location_name(self):
        """Line 48: Empty location_name raises."""
        from pydantic import ValidationError
        from api.v1.schemas.files import IndexingLocationCreate
        with pytest.raises(ValidationError):
            IndexingLocationCreate(
                location_name="   ",
                root_path="/tmp",
            )

    def test_create_invalid_chars_location_name(self):
        """Line 52: Location name with invalid characters raises."""
        from pydantic import ValidationError
        from api.v1.schemas.files import IndexingLocationCreate
        with pytest.raises(ValidationError, match="invalid characters"):
            IndexingLocationCreate(
                location_name="Test<>Location",
                root_path="/tmp",
            )

    def test_create_relative_root_path(self):
        """Line 61: Relative root_path raises."""
        from pydantic import ValidationError
        from api.v1.schemas.files import IndexingLocationCreate
        with pytest.raises(ValidationError, match="absolute"):
            IndexingLocationCreate(
                location_name="Test",
                root_path="relative/path",
            )

    def test_update_invalid_location_type(self):
        """Lines 93-95: IndexingLocationUpdate invalid location_type raises."""
        from pydantic import ValidationError
        from api.v1.schemas.files import IndexingLocationUpdate
        with pytest.raises(ValidationError, match="location_type"):
            IndexingLocationUpdate(location_type="bogus")

    def test_update_none_location_type_allowed(self):
        """Lines 93-95: None location_type passes (optional field)."""
        from api.v1.schemas.files import IndexingLocationUpdate
        update = IndexingLocationUpdate(location_type=None)
        assert update.location_type is None

    def test_create_valid_passes(self):
        """Line 42: Valid location_type passes through validator."""
        from api.v1.schemas.files import IndexingLocationCreate
        loc = IndexingLocationCreate(
            location_name="My Docs",
            root_path="/tmp/docs",
            location_type="primary",
        )
        assert loc.location_name == "My Docs"
        assert loc.root_path == "/tmp/docs"
        assert loc.location_type == "primary"


# ===========================================================================
# Schema Validation: agent.py (lines 42-44, 48-50, 82, 88)
# ===========================================================================


class TestAgentSchemaValidation:
    """Test Pydantic validators in api/v1/schemas/agent.py."""

    def test_config_update_invalid_trigger(self):
        """Lines 42-44: Invalid execution_trigger raises."""
        from pydantic import ValidationError
        from api.v1.schemas.agent import AgentConfigUpdate
        with pytest.raises(ValidationError, match="execution_trigger"):
            AgentConfigUpdate(execution_trigger="invalid_trigger")

    def test_config_update_non_positive_frequency(self):
        """Lines 48-50: trigger_frequency <= 0 raises."""
        from pydantic import ValidationError
        from api.v1.schemas.agent import AgentConfigUpdate
        with pytest.raises(ValidationError, match="trigger_frequency"):
            AgentConfigUpdate(trigger_frequency=0)

    def test_config_update_negative_frequency(self):
        """Lines 48-50: Negative trigger_frequency raises."""
        from pydantic import ValidationError
        from api.v1.schemas.agent import AgentConfigUpdate
        with pytest.raises(ValidationError, match="trigger_frequency"):
            AgentConfigUpdate(trigger_frequency=-5)

    def test_job_create_sequential_no_depends_on(self):
        """Line 82: Sequential strategy without depends_on raises."""
        from pydantic import ValidationError
        from api.v1.schemas.agent import AgentJobCreate
        from uuid import uuid4
        with pytest.raises(ValidationError, match="depends_on"):
            AgentJobCreate(
                agent_name="memory",
                entity_id=uuid4(),
                entity_type="chat",
                execution_strategy="sequential",
            )

    def test_job_create_batch_no_batch_group(self):
        """Line 88: Batch strategy without batch_group raises."""
        from pydantic import ValidationError
        from api.v1.schemas.agent import AgentJobCreate
        from uuid import uuid4
        with pytest.raises(ValidationError, match="batch_group"):
            AgentJobCreate(
                agent_name="memory",
                entity_id=uuid4(),
                entity_type="chat",
                execution_strategy="batch",
            )

    def test_config_update_valid_trigger(self):
        """Line 44: Valid execution_trigger passes through validator."""
        from api.v1.schemas.agent import AgentConfigUpdate
        update = AgentConfigUpdate(execution_trigger="background")
        assert update.execution_trigger == "background"

    def test_config_update_valid_frequency(self):
        """Line 50: Valid positive trigger_frequency passes through validator."""
        from api.v1.schemas.agent import AgentConfigUpdate
        update = AgentConfigUpdate(trigger_frequency=10)
        assert update.trigger_frequency == 10

    def test_job_create_parallel_no_depends_on_ok(self):
        """Happy path: parallel strategy doesn't need depends_on."""
        from api.v1.schemas.agent import AgentJobCreate
        from uuid import uuid4
        job = AgentJobCreate(
            agent_name="memory",
            entity_id=uuid4(),
            entity_type="chat",
            execution_strategy="parallel",
        )
        assert job.depends_on is None
        assert job.batch_group is None


# ===========================================================================
# User Credential HTTPException re-raise — Moved to test_user_credentials_endpoint.py
# ===========================================================================


# ===========================================================================
# Coverage Gap: schemas/chat.py line 186 — empty_str_to_none validator
# ===========================================================================


class TestChatSchemaValidator:
    """Test Pydantic field_validator empty_str_to_none in api/v1/schemas/chat.py (ArtifactCreate)."""

    def test_empty_string_content_becomes_none(self):
        """Line 186: empty string content → None via empty_str_to_none validator."""
        from api.v1.schemas.chat import ArtifactCreate
        art = ArtifactCreate(type="code", artifact_id="test-id", content="")
        assert art.content is None

    def test_whitespace_only_content_becomes_none(self):
        """Line 186: whitespace-only content → None via empty_str_to_none validator."""
        from api.v1.schemas.chat import ArtifactCreate
        art = ArtifactCreate(type="code", artifact_id="test-id", content="   ")
        assert art.content is None

    def test_non_empty_content_preserved(self):
        """Non-empty content passes through unchanged."""
        from api.v1.schemas.chat import ArtifactCreate
        art = ArtifactCreate(type="code", artifact_id="test-id", content="hello")
        assert art.content == "hello"
