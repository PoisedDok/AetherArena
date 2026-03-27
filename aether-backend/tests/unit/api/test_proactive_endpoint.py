"""
Unit tests for proactive endpoint (api/v1/endpoints/proactive.py).

7 routes:
  GET  /v1/proactive/config
  PATCH /v1/proactive/config
  GET  /v1/proactive/stats
  GET  /v1/proactive/source-status
  POST /v1/proactive/scout
  POST /v1/proactive/{run_id}/feedback
  POST /v1/proactive/test/inject

CI: pytest tests/unit/api/test_proactive_endpoint.py -m unit --no-cov -q
"""

import httpx
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4


# ===========================================================================
# GET /proactive/config
# ===========================================================================

class TestGetConfig:
    """Tests for GET /v1/proactive/config."""

    @pytest.mark.asyncio
    async def test_config_returns_200_with_all_fields(self, client):
        """Response contains every field from ProactiveConfigResponse."""
        resp = await client.get("/v1/proactive/config")
        assert resp.status_code == 200
        body = resp.json()
        required = [
            "enabled", "worker_enabled", "heartbeat_interval_seconds",
            "max_processing_time_seconds",
            "browser_enabled", "email_enabled", "file_system_enabled",
            "query_generation_enabled", "file_indexing_enabled",
        ]
        for field in required:
            assert field in body, f"Missing field: {field}"

    @pytest.mark.asyncio
    async def test_config_does_not_expose_legacy_mode(self, client):
        """Legacy mode field is removed from config response."""
        resp = await client.get("/v1/proactive/config")
        assert resp.status_code == 200
        assert "mode" not in resp.json()

    @pytest.mark.asyncio
    async def test_config_does_not_expose_legacy_threshold(self, client):
        """Legacy relevance_threshold field is removed from config response."""
        resp = await client.get("/v1/proactive/config")
        assert resp.status_code == 200
        assert "relevance_threshold" not in resp.json()

    @pytest.mark.asyncio
    async def test_config_boolean_fields_are_bool(self, client):
        """All boolean fields must be actual booleans."""
        resp = await client.get("/v1/proactive/config")
        body = resp.json()
        for field in (
            "enabled", "worker_enabled", "browser_enabled",
            "email_enabled", "file_system_enabled",
            "query_generation_enabled", "file_indexing_enabled",
        ):
            assert isinstance(body[field], bool), f"{field} is {type(body[field])}, expected bool"

    @pytest.mark.asyncio
    async def test_config_heartbeat_is_positive_int(self, client):
        """heartbeat_interval_seconds must be a positive integer."""
        resp = await client.get("/v1/proactive/config")
        hb = resp.json()["heartbeat_interval_seconds"]
        assert isinstance(hb, int) and hb > 0


# ===========================================================================
# PATCH /proactive/config
# ===========================================================================

class TestUpdateConfig:
    """Tests for PATCH /v1/proactive/config."""

    def _override_settings(self, app, tmp_path):
        """Override get_settings so app_root points to tmp_path."""
        from api.dependencies import get_settings as _real_gs

        real = _real_gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.app_root = tmp_path
        mock_settings.proactive = real.proactive

        app.dependency_overrides[_real_gs] = lambda: mock_settings
        (tmp_path / "data" / "runtime").mkdir(parents=True, exist_ok=True)
        return mock_settings

    def _clear_override(self, app):
        from api.dependencies import get_settings as _real_gs
        app.dependency_overrides.pop(_real_gs, None)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.proactive.reload_daemon_manager", create=True)
    async def test_update_enabled_field(self, _mock_reload, client, app, tmp_path):
        """PATCH enabled=false writes to runtime config file."""
        self._override_settings(app, tmp_path)
        try:
            resp = await client.patch("/v1/proactive/config", json={"enabled": False})
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert body["config"]["enabled"] is False

            # Verify file was written
            config_file = tmp_path / "data" / "runtime" / "proactive_config.json"
            assert config_file.exists()
            written = json.loads(config_file.read_text())
            assert written["enabled"] is False
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.proactive.reload_daemon_manager", create=True)
    async def test_update_legacy_mode_field_is_ignored(self, _mock_reload, client, app, tmp_path):
        """PATCH mode should be ignored (legacy field removed)."""
        self._override_settings(app, tmp_path)
        try:
            resp = await client.patch("/v1/proactive/config", json={"mode": "deep"})
            assert resp.status_code == 200
            assert "mode" not in resp.json()["config"]
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    async def test_update_daemon_toggle_triggers_reload(self, client, app, tmp_path):
        """Changing a daemon toggle calls reload_daemon_manager."""
        self._override_settings(app, tmp_path)
        try:
            with patch(
                "services.daemons.daemon_control.reload_daemon_manager"
            ) as mock_reload:
                resp = await client.patch(
                    "/v1/proactive/config", json={"browser_enabled": False}
                )
                assert resp.status_code == 200
                assert resp.json()["config"]["browser_enabled"] is False
                mock_reload.assert_called_once()
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.proactive.reload_daemon_manager", create=True)
    async def test_update_empty_body_succeeds(self, _mock_reload, client, app, tmp_path):
        """Empty update body is valid (no-op)."""
        self._override_settings(app, tmp_path)
        try:
            resp = await client.patch("/v1/proactive/config", json={})
            assert resp.status_code == 200
            assert resp.json()["success"] is True
        finally:
            self._clear_override(app)


# ===========================================================================
# GET /proactive/stats
# ===========================================================================

class TestGetStats:
    """Tests for GET /v1/proactive/stats."""

    @pytest.mark.asyncio
    async def test_stats_with_data(self, client):
        """Stats returns aggregated data when runs exist."""
        mock_runs = [
            {"decision": "intervene", "tool_calls_count": 4},
            {"decision": "defer", "tool_calls_count": 2},
        ]
        mock_feedback = {"clicked": 5, "dismissed": 2, "timeout": 1}

        mock_repo = MagicMock()
        mock_repo.get_recent_runs = AsyncMock(return_value=mock_runs)
        mock_repo.get_feedback_stats = AsyncMock(return_value=mock_feedback)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.get("/v1/proactive/stats")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_runs"] == 2
        assert body["intervene_count"] == 1
        assert body["defer_count"] == 1
        assert body["avg_tool_calls"] == 3.0
        assert body["period_days"] == 7
        assert body["feedback"] == mock_feedback
        assert "timestamp" in body

    @pytest.mark.asyncio
    async def test_stats_empty_returns_zeros(self, client):
        """Stats with no runs returns zero counts."""
        mock_repo = MagicMock()
        mock_repo.get_recent_runs = AsyncMock(return_value=[])
        mock_repo.get_feedback_stats = AsyncMock(return_value={})

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.get("/v1/proactive/stats")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_runs"] == 0
        assert body["intervene_count"] == 0
        assert body["defer_count"] == 0
        assert body["avg_tool_calls"] == 0

    @pytest.mark.asyncio
    async def test_stats_custom_days_param(self, client):
        """days query parameter is forwarded to repository."""
        mock_repo = MagicMock()
        mock_repo.get_recent_runs = AsyncMock(return_value=[])
        mock_repo.get_feedback_stats = AsyncMock(return_value={})

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.get("/v1/proactive/stats?days=30")

        assert resp.status_code == 200
        assert resp.json()["period_days"] == 30
        mock_repo.get_recent_runs.assert_called_once_with(days=30, limit=1000)
        mock_repo.get_feedback_stats.assert_called_once_with(days=30)

    @pytest.mark.asyncio
    async def test_stats_db_error_returns_500(self, client):
        """Database failure returns 500."""
        mock_repo = MagicMock()
        mock_repo.get_recent_runs = AsyncMock(side_effect=RuntimeError("db down"))

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.get("/v1/proactive/stats")

        assert resp.status_code == 500
        assert "Stats error" in resp.json()["detail"]


# ===========================================================================
# POST /proactive/{run_id}/feedback
# ===========================================================================

class TestFeedback:
    """Tests for POST /v1/proactive/{run_id}/feedback."""

    @pytest.mark.asyncio
    async def test_feedback_clicked_success(self, client):
        """Valid UUID run_id with clicked feedback succeeds."""
        run_id = str(uuid4())
        mock_repo = MagicMock()
        mock_repo.record_user_feedback = AsyncMock()

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.post(f"/v1/proactive/{run_id}/feedback?feedback=clicked")

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["run_id"] == run_id
        assert body["feedback"] == "clicked"

    @pytest.mark.asyncio
    async def test_feedback_timeout(self, client):
        """timeout feedback type is accepted."""
        run_id = str(uuid4())
        mock_repo = MagicMock()
        mock_repo.record_user_feedback = AsyncMock()

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.post(f"/v1/proactive/{run_id}/feedback?feedback=timeout")

        assert resp.status_code == 200
        assert resp.json()["feedback"] == "timeout"

    @pytest.mark.asyncio
    async def test_feedback_dismissed(self, client):
        """dismissed feedback type is accepted."""
        run_id = str(uuid4())
        mock_repo = MagicMock()
        mock_repo.record_user_feedback = AsyncMock()

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.post(f"/v1/proactive/{run_id}/feedback?feedback=dismissed")

        assert resp.status_code == 200
        assert resp.json()["feedback"] == "dismissed"

    @pytest.mark.asyncio
    async def test_feedback_default_is_clicked(self, client):
        """No feedback param defaults to clicked."""
        run_id = str(uuid4())
        mock_repo = MagicMock()
        mock_repo.record_user_feedback = AsyncMock()

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.post(f"/v1/proactive/{run_id}/feedback")

        assert resp.status_code == 200
        assert resp.json()["feedback"] == "clicked"

    @pytest.mark.asyncio
    async def test_feedback_non_uuid_run_id_accepted(self, client):
        """Non-UUID run_id (test run) is accepted without DB persist."""
        mock_repo = MagicMock()
        # record_user_feedback should NOT be called for non-UUID

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.post("/v1/proactive/test-run-123/feedback?feedback=clicked")

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["run_id"] == "test-run-123"
        mock_repo.record_user_feedback.assert_not_called()

    @pytest.mark.asyncio
    async def test_feedback_db_error_returns_500(self, client):
        """Database error during feedback recording returns 500."""
        run_id = str(uuid4())
        mock_repo = MagicMock()
        mock_repo.record_user_feedback = AsyncMock(side_effect=RuntimeError("db fail"))

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.post(f"/v1/proactive/{run_id}/feedback?feedback=clicked")

        assert resp.status_code == 500
        assert "Failed to record feedback" in resp.json()["detail"]


# ===========================================================================
# POST /proactive/{run_id}/feedback — ICL refresh integration
# ===========================================================================

class TestFeedbackICLRefresh:
    """Tests for feedback-driven proactive ICL refresh behavior."""

    @pytest.mark.asyncio
    async def test_feedback_refreshes_icl_with_incremental_append(self, client):
        run_id = str(uuid4())
        mock_repo = MagicMock()
        mock_repo.record_user_feedback = AsyncMock()
        mock_repo.get_run_by_id = AsyncMock(
            return_value={
                "id": run_id,
                "decision": "intervene",
                "recommendation": "Check this source",
                "queries": ["query one"],
                "created_at": "2026-02-17T00:00:00+00:00",
            }
        )

        mock_icl_manager = MagicMock()
        mock_icl_manager.ensure_index = AsyncMock(return_value=True)
        mock_icl_manager.append_run = MagicMock(return_value=True)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.agents.proactive_icl_manager.get_proactive_icl_manager",
            return_value=mock_icl_manager,
        ):
            resp = await client.post(f"/v1/proactive/{run_id}/feedback?feedback=clicked")

        assert resp.status_code == 200
        mock_repo.record_user_feedback.assert_awaited_once()
        mock_repo.get_run_by_id.assert_awaited_once()
        mock_icl_manager.ensure_index.assert_awaited_once_with(mock_repo)
        mock_icl_manager.append_run.assert_called_once()

    @pytest.mark.asyncio
    async def test_feedback_forces_rebuild_when_append_fails(self, client):
        run_id = str(uuid4())
        mock_repo = MagicMock()
        mock_repo.record_user_feedback = AsyncMock()
        mock_repo.get_run_by_id = AsyncMock(
            return_value={
                "id": run_id,
                "decision": "intervene",
                "recommendation": "Check this source",
                "queries": ["query one"],
                "created_at": "2026-02-17T00:00:00+00:00",
            }
        )

        mock_icl_manager = MagicMock()
        mock_icl_manager.ensure_index = AsyncMock(side_effect=[True, True])
        mock_icl_manager.append_run = MagicMock(return_value=False)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.agents.proactive_icl_manager.get_proactive_icl_manager",
            return_value=mock_icl_manager,
        ):
            resp = await client.post(f"/v1/proactive/{run_id}/feedback?feedback=dismissed")

        assert resp.status_code == 200
        assert mock_icl_manager.ensure_index.await_count == 2
        first_call = mock_icl_manager.ensure_index.await_args_list[0]
        second_call = mock_icl_manager.ensure_index.await_args_list[1]
        assert first_call.args == (mock_repo,)
        assert second_call.args == (mock_repo,)
        assert second_call.kwargs.get("force_rebuild") is True


# ===========================================================================
# POST /proactive/scout
# ===========================================================================

VALID_SCOUT_BODY = {
    "query_ids": ["q1", "q2"],
    "queries": ["test query 1", "test query 2"],
    "source_docs": [
        {
            "source": "email",
            "content": "Test email content",
            "metadata": {"_context_type": "triggering_log", "_batch": "current"},
        }
    ],
    "day_date": "2026-02-08",
}

MOCK_AGENT_OUTPUT = {
    "decision": "intervene",
    "recommendation": "Check the quarterly report.",
    "supportingDocs": [{"title": "Q4 Report"}],
    "context": {"key": "value"},
    "reasoning": ["step 1", "step 2"],
    "toolBudget": 3,
    "tool_calls_count": 5,
    "llm_model": "test-model",
}


class TestScout:
    """Tests for POST /v1/proactive/scout."""

    @pytest.mark.asyncio
    async def test_scout_missing_query_ids_returns_422(self, client):
        """Missing query_ids field returns 422."""
        body = {**VALID_SCOUT_BODY}
        del body["query_ids"]
        resp = await client.post("/v1/proactive/scout", json=body)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_scout_missing_queries_returns_422(self, client):
        """Missing queries field returns 422."""
        body = {**VALID_SCOUT_BODY}
        del body["queries"]
        resp = await client.post("/v1/proactive/scout", json=body)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_scout_missing_source_docs_returns_422(self, client):
        """Missing source_docs field returns 422."""
        body = {**VALID_SCOUT_BODY}
        del body["source_docs"]
        resp = await client.post("/v1/proactive/scout", json=body)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_scout_missing_day_date_returns_422(self, client):
        """Missing day_date field returns 422."""
        body = {**VALID_SCOUT_BODY}
        del body["day_date"]
        resp = await client.post("/v1/proactive/scout", json=body)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_scout_invalid_max_processing_time_too_high_returns_422(self, client):
        """max_processing_time_seconds > 600 returns 422."""
        body = {**VALID_SCOUT_BODY, "max_processing_time_seconds": 1000}
        resp = await client.post("/v1/proactive/scout", json=body)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_scout_invalid_max_processing_time_too_low_returns_422(self, client):
        """max_processing_time_seconds < 5 returns 422."""
        body = {**VALID_SCOUT_BODY, "max_processing_time_seconds": 1}
        resp = await client.post("/v1/proactive/scout", json=body)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_scout_success(self, client):
        """Full scout flow returns ProactiveScoutResponse."""
        run_id = str(uuid4())
        mock_repo = MagicMock()
        mock_repo.search_similar_runs = AsyncMock(return_value=[])
        mock_repo.insert_agent_run = AsyncMock(return_value={"id": run_id})

        # Mock the embedding call (httpx to self at /v1/llm/embeddings)
        mock_embed_response = MagicMock()
        mock_embed_response.status_code = 200
        mock_embed_response.raise_for_status = MagicMock()
        mock_embed_response.json.return_value = {
            "data": [{"embedding": [0.1] * 384}]
        }

        mock_http_client = AsyncMock()
        mock_http_client.post = AsyncMock(return_value=mock_embed_response)
        mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
        mock_http_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=MOCK_AGENT_OUTPUT,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http_client,
        ):
            resp = await client.post("/v1/proactive/scout", json=VALID_SCOUT_BODY)

        assert resp.status_code == 200
        body = resp.json()
        assert body["decision"] == "intervene"
        assert body["recommendation"] == "Check the quarterly report."
        assert body["tool_budget"] == 3
        assert body["run_id"] == run_id
        assert body["tool_calls_count"] == 5
        assert "timestamp" in body

    @pytest.mark.asyncio
    async def test_scout_agent_unavailable_returns_503(self, client):
        """Perplexica agent unavailable returns 503."""
        from fastapi import HTTPException, status

        mock_repo = MagicMock()
        mock_repo.search_similar_runs = AsyncMock(return_value=[])

        mock_http_client = AsyncMock()
        mock_http_client.post = AsyncMock(side_effect=Exception("embed fail"))
        mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
        mock_http_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            side_effect=HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Proactive agent unavailable.",
            ),
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http_client,
        ):
            resp = await client.post("/v1/proactive/scout", json=VALID_SCOUT_BODY)

        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_scout_generic_error_returns_500(self, client):
        """Unexpected error returns 500."""
        mock_repo = MagicMock()
        mock_repo.search_similar_runs = AsyncMock(return_value=[])

        mock_http_client = AsyncMock()
        mock_http_client.post = AsyncMock(side_effect=Exception("embed fail"))
        mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
        mock_http_client.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            side_effect=RuntimeError("unexpected"),
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http_client,
        ):
            resp = await client.post("/v1/proactive/scout", json=VALID_SCOUT_BODY)

        assert resp.status_code == 500
        detail = resp.json()["detail"]
        assert detail["error"] == "Proactive scout execution error"
        assert "trace_id" in detail


# ===========================================================================
# POST /proactive/test/inject
# ===========================================================================

class TestInjectTestResponse:
    """Tests for POST /v1/proactive/test/inject."""

    @pytest.mark.asyncio
    async def test_inject_no_websocket_hub_returns_503(self, client, app):
        """Missing websocket_hub on app.state returns 503."""
        # Ensure no hub is set
        if hasattr(app.state, "websocket_hub"):
            delattr(app.state, "websocket_hub")
        resp = await client.post("/v1/proactive/test/inject")
        assert resp.status_code == 503
        assert "WebSocket hub not available" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_inject_success_with_hub(self, client, app):
        """With a mock hub, inject streams chunks and returns success."""
        mock_hub = MagicMock()
        mock_hub.broadcast_json = AsyncMock()
        app.state.websocket_hub = mock_hub

        try:
            resp = await client.post("/v1/proactive/test/inject")
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "run_id" in body
            assert body["run_id"].startswith("test-")
            # broadcast_json called 3 times (chunk, end, intervention)
            assert mock_hub.broadcast_json.call_count == 3
        finally:
            delattr(app.state, "websocket_hub")

    @pytest.mark.asyncio
    async def test_inject_broadcast_error_returns_500(self, client, app):
        """Exception during broadcast returns 500."""
        mock_hub = MagicMock()
        mock_hub.broadcast_json = AsyncMock(side_effect=RuntimeError("ws crash"))
        app.state.websocket_hub = mock_hub

        try:
            resp = await client.post("/v1/proactive/test/inject")
            assert resp.status_code == 500
        finally:
            if hasattr(app.state, "websocket_hub"):
                delattr(app.state, "websocket_hub")


# ===========================================================================
# EXPANDED: Scout — source doc context splitting & ICL paths
# ===========================================================================

class TestScoutExpanded:
    """Additional scout tests covering context split, ICL, and edge cases."""

    def _mock_scout_deps(self, agent_output=None, embed_ok=True, icl_runs=None):
        """Helper to build patched context for scout tests."""
        if agent_output is None:
            agent_output = MOCK_AGENT_OUTPUT.copy()

        mock_repo = MagicMock()
        mock_repo.search_similar_runs = AsyncMock(return_value=icl_runs or [])
        mock_repo.insert_agent_run = AsyncMock(return_value={"id": str(uuid4())})

        mock_embed_resp = MagicMock()
        mock_embed_resp.raise_for_status = MagicMock()
        if embed_ok:
            mock_embed_resp.json.return_value = {"data": [{"embedding": [0.1] * 384}]}
        else:
            mock_embed_resp.raise_for_status.side_effect = Exception("embed fail")

        mock_http = AsyncMock()
        mock_http.post = AsyncMock(return_value=mock_embed_resp)
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)

        return mock_repo, mock_http, agent_output

    @pytest.mark.asyncio
    async def test_scout_with_filesystem_source(self, client):
        """Scout with FILESYSTEM source doc triggers file context path."""
        mock_repo, mock_http, agent_output = self._mock_scout_deps()
        body = {
            **VALID_SCOUT_BODY,
            "source_docs": [{
                "source": "FILESYSTEM",
                "content": "Spreadsheet data",
                "metadata": {
                    "_context_type": "triggering_log",
                    "_batch": "current",
                    "file_name": "data.xlsx",
                },
            }],
        }

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=body)

        assert resp.status_code == 200
        assert resp.json()["decision"] == "intervene"

    @pytest.mark.asyncio
    async def test_scout_with_browser_source(self, client):
        """Scout with BROWSER source doc triggers browser context path."""
        mock_repo, mock_http, agent_output = self._mock_scout_deps()
        body = {
            **VALID_SCOUT_BODY,
            "source_docs": [{
                "source": "BROWSER",
                "content": "Page content",
                "metadata": {
                    "_context_type": "triggering_log",
                    "_batch": "current",
                    "title": "Stack Overflow",
                    "url": "https://stackoverflow.com",
                },
            }],
        }

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=body)

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_scout_with_active_windows_source(self, client):
        """Scout with ACTIVE_WINDOWS source doc triggers window context path."""
        mock_repo, mock_http, agent_output = self._mock_scout_deps()
        body = {
            **VALID_SCOUT_BODY,
            "source_docs": [{
                "source": "ACTIVE_WINDOWS",
                "content": "Window activity",
                "metadata": {
                    "_context_type": "triggering_log",
                    "_batch": "current",
                    "window_title": "VS Code",
                    "app_name": "Code",
                },
            }],
        }

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=body)

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_scout_with_previous_query_context(self, client):
        """Scout with previous_query source docs goes to background history."""
        mock_repo, mock_http, agent_output = self._mock_scout_deps()
        body = {
            **VALID_SCOUT_BODY,
            "source_docs": [
                {
                    "source": "email",
                    "content": "Current email",
                    "metadata": {"_context_type": "triggering_log", "_batch": "current"},
                },
                {
                    "source": "query",
                    "content": "Previous query abstract",
                    "metadata": {"_context_type": "previous_query"},
                },
            ],
        }

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=body)

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_scout_with_unknown_source_type(self, client):
        """Scout with unknown source type uses fallback metadata string."""
        mock_repo, mock_http, agent_output = self._mock_scout_deps()
        body = {
            **VALID_SCOUT_BODY,
            "source_docs": [{
                "source": "CUSTOM_SOURCE",
                "content": "Custom data",
                "metadata": {
                    "_context_type": "triggering_log",
                    "_batch": "current",
                    "custom_field": "test_value",
                },
            }],
        }

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=body)

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_scout_embedding_failure_continues(self, client):
        """When embedding call fails, scout continues without ICL."""
        mock_repo = MagicMock()
        mock_repo.search_similar_runs = AsyncMock(return_value=[])
        mock_repo.insert_agent_run = AsyncMock(return_value={"id": str(uuid4())})

        # Embedding call raises
        mock_http = AsyncMock()
        mock_http.post = AsyncMock(side_effect=Exception("embed service down"))
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=MOCK_AGENT_OUTPUT,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=VALID_SCOUT_BODY)

        # Should succeed - embedding failure is non-fatal
        assert resp.status_code == 200
        body = resp.json()
        assert body["decision"] == "intervene"

    @pytest.mark.asyncio
    async def test_scout_with_icl_examples_found(self, client):
        """When similar past runs exist, ICL examples are passed to agent."""
        icl_runs = [
            {
                "recommendation": "Check the report",
                "user_feedback": "clicked",
                "similarity_score": 0.85,
            },
            {
                "recommendation": "Review the data",
                "user_feedback": "clicked",
                "similarity_score": 0.78,
            },
        ]
        mock_repo, mock_http, agent_output = self._mock_scout_deps(icl_runs=icl_runs)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=VALID_SCOUT_BODY)

        assert resp.status_code == 200
        # Verify ICL search was called
        mock_repo.search_similar_runs.assert_called_once()

    @pytest.mark.asyncio
    async def test_scout_icl_search_failure_continues(self, client):
        """When ICL search fails, scout continues without examples."""
        mock_repo = MagicMock()
        mock_repo.search_similar_runs = AsyncMock(side_effect=RuntimeError("search fail"))
        mock_repo.insert_agent_run = AsyncMock(return_value={"id": str(uuid4())})

        mock_embed_resp = MagicMock()
        mock_embed_resp.raise_for_status = MagicMock()
        mock_embed_resp.json.return_value = {"data": [{"embedding": [0.1] * 384}]}

        mock_http = AsyncMock()
        mock_http.post = AsyncMock(return_value=mock_embed_resp)
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=MOCK_AGENT_OUTPUT,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=VALID_SCOUT_BODY)

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_scout_defer_decision(self, client):
        """Agent defer decision returns no recommendation."""
        defer_output = {
            **MOCK_AGENT_OUTPUT,
            "decision": "defer",
            "recommendation": None,
            "supportingDocs": [],
        }
        mock_repo, mock_http, _ = self._mock_scout_deps(agent_output=defer_output)

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=defer_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=VALID_SCOUT_BODY)

        assert resp.status_code == 200
        body = resp.json()
        assert body["decision"] == "defer"
        assert body["recommendation"] is None

    @pytest.mark.asyncio
    async def test_scout_with_session_id(self, client):
        """Scout with optional session_id parameter."""
        session_id = str(uuid4())
        body = {**VALID_SCOUT_BODY, "session_id": session_id}
        mock_repo, mock_http, agent_output = self._mock_scout_deps()

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=body)

        assert resp.status_code == 200
        # session_id passed to insert_agent_run
        mock_repo.insert_agent_run.assert_called_once()

    @pytest.mark.asyncio
    async def test_scout_tool_budget_passthrough(self, client):
        """Scout response exposes classifier tool_budget from agent output."""
        body = {**VALID_SCOUT_BODY}
        mock_repo, mock_http, agent_output = self._mock_scout_deps(
            agent_output={**MOCK_AGENT_OUTPUT, "toolBudget": 4}
        )

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=body)

        assert resp.status_code == 200
        assert resp.json()["tool_budget"] == 4

    @pytest.mark.asyncio
    async def test_scout_empty_source_docs(self, client):
        """Scout with empty source_docs list still works."""
        body = {**VALID_SCOUT_BODY, "source_docs": []}
        mock_repo, mock_http, agent_output = self._mock_scout_deps()

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=body)

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_scout_legacy_relevance_threshold_ignored(self, client):
        """Legacy relevance_threshold field is ignored by the scout request model."""
        body = {**VALID_SCOUT_BODY, "relevance_threshold": 0.9}
        mock_repo, mock_http, agent_output = self._mock_scout_deps()

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ), patch(
            "services.proactive.scout_service.call_perplexica_proactive_agent",
            new_callable=AsyncMock,
            return_value=agent_output,
        ), patch(
            "services.proactive.scout_service.httpx.AsyncClient",
            return_value=mock_http,
        ):
            resp = await client.post("/v1/proactive/scout", json=body)

        assert resp.status_code == 200


# ===========================================================================
# EXPANDED: _call_perplexica_proactive_agent direct paths
# ===========================================================================

class TestCallPerplexicaAgent:
    """Tests for _call_perplexica_proactive_agent internal function."""

    @pytest.mark.asyncio
    async def test_httpx_error_raises_503(self):
        """httpx.HTTPError from agent call raises 503."""
        from services.proactive.scout_service import call_perplexica_proactive_agent as _call_perplexica_proactive_agent
        from fastapi import HTTPException

        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_url = "http://localhost:3001"
        mock_settings.mesh_base_url = "http://localhost:8765"
        mock_settings.inference.default_model = "test-model-id"

        mock_upstream_response = MagicMock()
        mock_upstream_response.status_code = 502
        mock_upstream_response.text = "Bad Gateway"
        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "502 Bad Gateway", request=MagicMock(), response=mock_upstream_response
        )

        mock_http = AsyncMock()
        mock_http.post = AsyncMock(return_value=mock_response)
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_http):
            with pytest.raises(HTTPException) as exc_info:
                await _call_perplexica_proactive_agent(
                    queries=["test"],
                    source_docs=[],
                    settings=mock_settings,
                )
            assert exc_info.value.status_code == 503

    @pytest.mark.asyncio
    async def test_generic_error_raises_500(self):
        """Non-httpx error from agent call raises 500."""
        from services.proactive.scout_service import call_perplexica_proactive_agent as _call_perplexica_proactive_agent
        from fastapi import HTTPException

        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_url = "http://localhost:3001"
        mock_settings.mesh_base_url = "http://localhost:8765"
        mock_settings.inference.default_model = "test-model-id"

        mock_http = AsyncMock()
        mock_http.post = AsyncMock(side_effect=ValueError("bad json"))
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_http):
            with pytest.raises(HTTPException) as exc_info:
                await _call_perplexica_proactive_agent(
                    queries=["test"],
                    source_docs=[],
                    settings=mock_settings,
                )
            assert exc_info.value.status_code == 500

    @pytest.mark.asyncio
    async def test_success_returns_parsed_json(self):
        """Successful agent call returns parsed JSON response."""
        from services.proactive.scout_service import call_perplexica_proactive_agent as _call_perplexica_proactive_agent

        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_url = "http://localhost:3001"
        mock_settings.mesh_base_url = "http://localhost:8765"
        mock_settings.inference.default_model = "test-model-id"

        expected = {"decision": "defer", "toolBudget": 0}
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = expected

        mock_http = AsyncMock()
        mock_http.post = AsyncMock(return_value=mock_response)
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_http):
            result = await _call_perplexica_proactive_agent(
                queries=["test"],
                source_docs=[{"source": "email", "metadata": {"_context_type": "triggering_log", "_batch": "current"}}],
                settings=mock_settings,
                icl_examples=[{"recommendation": "past rec", "similarity": 0.9}],
            )

        assert result == expected

    @pytest.mark.asyncio
    async def test_context_split_current_vs_background(self):
        """Verify source docs are properly split into current and background."""
        from services.proactive.scout_service import call_perplexica_proactive_agent as _call_perplexica_proactive_agent

        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_url = "http://localhost:3001"
        mock_settings.mesh_base_url = "http://localhost:8765"
        mock_settings.inference.default_model = "test-model-id"

        captured_payload = {}

        async def capture_post(url, json=None, **kwargs):
            captured_payload.update(json or {})
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_resp.json.return_value = {"decision": "defer", "toolBudget": 0}
            return mock_resp

        mock_http = AsyncMock()
        mock_http.post = AsyncMock(side_effect=capture_post)
        mock_http.__aenter__ = AsyncMock(return_value=mock_http)
        mock_http.__aexit__ = AsyncMock(return_value=False)

        source_docs = [
            {"source": "email", "metadata": {"_context_type": "triggering_log", "_batch": "current"}, "content": "now"},
            {"source": "query", "metadata": {"_context_type": "previous_query"}, "content": "old"},
            {"source": "old", "metadata": {"_context_type": "unknown_type"}, "content": "skip"},
        ]

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_http):
            await _call_perplexica_proactive_agent(
                queries=["test"],
                source_docs=source_docs,
                settings=mock_settings,
            )

        # 1 current, 1 background, 1 skipped
        assert len(captured_payload["currentActivity"]) == 1
        assert len(captured_payload["backgroundHistory"]) == 1


# ===========================================================================
# EXPANDED: Config GET — runtime config file paths
# ===========================================================================

class TestGetConfigExpanded:
    """Additional config GET tests."""

    @pytest.mark.asyncio
    async def test_config_reads_runtime_file(self, client, app, tmp_path):
        """GET config reads from runtime config file when it exists."""
        from api.dependencies import get_settings as _real_gs

        real = _real_gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.app_root = tmp_path
        mock_settings.proactive = real.proactive

        # Write a runtime config file
        config_dir = tmp_path / "data" / "runtime"
        config_dir.mkdir(parents=True, exist_ok=True)
        config_file = config_dir / "proactive_config.json"
        config_file.write_text(json.dumps({"enabled": False, "worker_enabled": False}))

        app.dependency_overrides[_real_gs] = lambda: mock_settings
        try:
            resp = await client.get("/v1/proactive/config")
            assert resp.status_code == 200
            body = resp.json()
            assert body["enabled"] is False
            assert body["worker_enabled"] is False
        finally:
            app.dependency_overrides.pop(_real_gs, None)

    @pytest.mark.asyncio
    async def test_config_corrupt_file_falls_back(self, client, app, tmp_path):
        """GET config with corrupt config file falls back to in-memory defaults."""
        from api.dependencies import get_settings as _real_gs

        real = _real_gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.app_root = tmp_path
        mock_settings.proactive = real.proactive

        # Write corrupt JSON
        config_dir = tmp_path / "data" / "runtime"
        config_dir.mkdir(parents=True, exist_ok=True)
        (config_dir / "proactive_config.json").write_text("{invalid json")

        app.dependency_overrides[_real_gs] = lambda: mock_settings
        try:
            resp = await client.get("/v1/proactive/config")
            assert resp.status_code == 200
            # Should still return valid response (from defaults)
            body = resp.json()
            assert "enabled" in body
            assert "worker_enabled" in body
        finally:
            app.dependency_overrides.pop(_real_gs, None)


# ===========================================================================
# EXPANDED: Config PATCH — additional field updates
# ===========================================================================

class TestUpdateConfigExpanded:
    """Additional config PATCH tests."""

    def _override_settings(self, app, tmp_path):
        from api.dependencies import get_settings as _real_gs
        real = _real_gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.app_root = tmp_path
        mock_settings.proactive = real.proactive
        app.dependency_overrides[_real_gs] = lambda: mock_settings
        (tmp_path / "data" / "runtime").mkdir(parents=True, exist_ok=True)
        return mock_settings

    def _clear_override(self, app):
        from api.dependencies import get_settings as _real_gs
        app.dependency_overrides.pop(_real_gs, None)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.proactive.reload_daemon_manager", create=True)
    async def test_update_legacy_threshold_ignored(self, _mock_reload, client, app, tmp_path):
        """PATCH relevance_threshold is ignored (legacy field removed)."""
        self._override_settings(app, tmp_path)
        try:
            resp = await client.patch("/v1/proactive/config", json={"relevance_threshold": 0.8})
            assert resp.status_code == 200
            assert "relevance_threshold" not in resp.json()["config"]
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.proactive.reload_daemon_manager", create=True)
    async def test_update_heartbeat(self, _mock_reload, client, app, tmp_path):
        """PATCH heartbeat_interval_seconds writes to config."""
        self._override_settings(app, tmp_path)
        try:
            resp = await client.patch("/v1/proactive/config", json={"heartbeat_interval_seconds": 30})
            assert resp.status_code == 200
            assert resp.json()["config"]["heartbeat_interval_seconds"] == 30
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.proactive.reload_daemon_manager", create=True)
    async def test_update_multiple_fields(self, _mock_reload, client, app, tmp_path):
        """PATCH with multiple fields updates all of them."""
        self._override_settings(app, tmp_path)
        try:
            payload = {
                "enabled": True,
                "email_enabled": False,
                "browser_enabled": True,
            }
            resp = await client.patch("/v1/proactive/config", json=payload)
            assert resp.status_code == 200
            config = resp.json()["config"]
            assert config["enabled"] is True
            assert config["email_enabled"] is False
            assert config["browser_enabled"] is True
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    async def test_update_forces_email_disabled_on_non_darwin(self, client, app, tmp_path):
        """PATCH email_enabled=true is normalized to false outside macOS."""
        self._override_settings(app, tmp_path)
        try:
            with patch("sys.platform", "linux"), patch(
                "services.daemons.daemon_control.reload_daemon_manager"
            ) as mock_reload:
                resp = await client.patch(
                    "/v1/proactive/config",
                    json={"email_enabled": True},
                )
                assert resp.status_code == 200
                config = resp.json()["config"]
                assert config["email_enabled"] is False
                mock_reload.assert_called_once()
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    async def test_update_keeps_email_enabled_on_darwin(self, client, app, tmp_path):
        """PATCH email_enabled=true stays true on macOS."""
        self._override_settings(app, tmp_path)
        try:
            with patch("sys.platform", "darwin"), patch(
                "services.daemons.daemon_control.reload_daemon_manager"
            ) as mock_reload:
                resp = await client.patch(
                    "/v1/proactive/config",
                    json={"email_enabled": True},
                )
                assert resp.status_code == 200
                config = resp.json()["config"]
                assert config["email_enabled"] is True
                mock_reload.assert_called_once()
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    async def test_update_daemon_reload_failure_still_succeeds(self, client, app, tmp_path):
        """PATCH succeeds even when daemon reload fails (warning logged)."""
        self._override_settings(app, tmp_path)
        try:
            with patch(
                "services.daemons.daemon_control.reload_daemon_manager",
                side_effect=RuntimeError("reload crash"),
            ):
                resp = await client.patch(
                    "/v1/proactive/config",
                    json={"file_system_enabled": False},
                )
                assert resp.status_code == 200
                assert resp.json()["success"] is True
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.proactive.reload_daemon_manager", create=True)
    async def test_update_worker_enabled(self, _mock_reload, client, app, tmp_path):
        """PATCH worker_enabled writes to config."""
        self._override_settings(app, tmp_path)
        try:
            resp = await client.patch("/v1/proactive/config", json={"worker_enabled": False})
            assert resp.status_code == 200
            assert resp.json()["config"]["worker_enabled"] is False
        finally:
            self._clear_override(app)

    @pytest.mark.asyncio
    @patch("api.v1.endpoints.proactive.reload_daemon_manager", create=True)
    async def test_update_preserves_existing_config(self, _mock_reload, client, app, tmp_path):
        """PATCH merges with existing config file, not overwrites."""
        self._override_settings(app, tmp_path)
        config_file = tmp_path / "data" / "runtime" / "proactive_config.json"
        config_file.write_text(json.dumps({"enabled": True, "worker_enabled": True}))

        try:
            resp = await client.patch("/v1/proactive/config", json={"worker_enabled": False})
            assert resp.status_code == 200
            config = resp.json()["config"]
            assert config["enabled"] is True  # preserved
            assert config["worker_enabled"] is False  # updated
        finally:
            self._clear_override(app)


# ===========================================================================
# EXPANDED: Stats — edge cases
# ===========================================================================

class TestGetStatsExpanded:
    """Additional stats tests."""

    @pytest.mark.asyncio
    async def test_stats_all_intervene(self, client):
        """Stats with all intervene decisions."""
        mock_runs = [
            {"decision": "intervene", "tool_calls_count": 4},
            {"decision": "intervene", "tool_calls_count": 2},
        ]
        mock_repo = MagicMock()
        mock_repo.get_recent_runs = AsyncMock(return_value=mock_runs)
        mock_repo.get_feedback_stats = AsyncMock(return_value={})

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.get("/v1/proactive/stats")

        assert resp.status_code == 200
        body = resp.json()
        assert body["intervene_count"] == 2
        assert body["defer_count"] == 0
        assert body["avg_tool_calls"] == 3.0

    @pytest.mark.asyncio
    async def test_stats_feedback_stats_error_returns_500(self, client):
        """Error in get_feedback_stats returns 500."""
        mock_repo = MagicMock()
        mock_repo.get_recent_runs = AsyncMock(return_value=[])
        mock_repo.get_feedback_stats = AsyncMock(side_effect=RuntimeError("db"))

        with patch(
            "data.database.repositories.proactive_agent.ProactiveAgentRepository",
            return_value=mock_repo,
        ):
            resp = await client.get("/v1/proactive/stats")

        assert resp.status_code == 500


# ===========================================================================
# EXPANDED: Feedback — additional edge cases
# ===========================================================================

class TestFeedbackExpanded:
    """Additional feedback edge cases."""

    @pytest.mark.asyncio
    async def test_feedback_invalid_type_returns_422(self, client):
        """Invalid feedback type returns 422."""
        run_id = str(uuid4())
        resp = await client.post(f"/v1/proactive/{run_id}/feedback?feedback=invalid_type")
        assert resp.status_code == 422


# ===========================================================================
# Coverage Gap: Lines 683-685 — update_proactive_config exception handler
# ===========================================================================


class TestUpdateConfigException:
    """Test generic exception path in update_proactive_config."""

    @pytest.mark.asyncio
    async def test_update_config_generic_exception_returns_500(self, client):
        """Lines 683-685: non-HTTPException during config update → 500."""
        with patch(
            "pathlib.Path.mkdir",
            side_effect=PermissionError("read-only filesystem"),
        ):
            resp = await client.patch("/v1/proactive/config", json={"enabled": True})
        assert resp.status_code == 500
        assert "Failed to update config" in resp.json()["detail"]


# ===========================================================================
# GET /proactive/source-status (CHANGE 3)
# ===========================================================================

class TestGetSourceStatus:
    """Tests for GET /v1/proactive/source-status.

    The endpoint detects browser installations, tests email accessibility,
    and reports filesystem watch state. All three checks run in parallel
    with per-source error isolation.
    """

    @pytest.mark.asyncio
    async def test_source_status_returns_200_with_all_sections(self, client):
        """Response contains browser, email, and filesystem sections."""
        resp = await client.get("/v1/proactive/source-status")

        assert resp.status_code == 200
        body = resp.json()
        assert "browser" in body
        assert "email" in body
        assert "filesystem" in body

    @pytest.mark.asyncio
    async def test_source_status_database_unavailable_still_returns_200(self, client):
        """DB-unavailable state must not fail the whole source-status endpoint."""
        from api import dependencies as deps

        original_get_optional_file_service = deps.get_optional_file_service
        try:
            deps.get_optional_file_service = lambda: None
            resp = await client.get("/v1/proactive/source-status")
            assert resp.status_code == 200
            fs = resp.json()["filesystem"]
            assert fs["indexing_locations"] == []
        finally:
            deps.get_optional_file_service = original_get_optional_file_service

    @pytest.mark.asyncio
    async def test_source_status_browser_section_fields(self, client):
        """Browser section has required fields."""
        mock_udd = MagicMock()
        mock_udd.exists.return_value = True

        with patch(
            "application.sources.chromium_history.resolve_chromium_user_data_dir",
            return_value=mock_udd,
            create=True,
        ), patch(
            "application.sources.chromium_history.find_profile_dirs",
            return_value=["Default", "Profile 1"],
            create=True,
        ):
            resp = await client.get("/v1/proactive/source-status")

        assert resp.status_code == 200
        browser = resp.json()["browser"]
        assert "installed" in browser
        assert "current" in browser
        assert "recommended" in browser
        assert "error" in browser

    @pytest.mark.asyncio
    async def test_source_status_email_section_fields(self, client):
        """Email section has required fields."""
        with patch(
            "application.sources.macos_mail.test_mail_access",
            return_value=True,
            create=True,
        ):
            resp = await client.get("/v1/proactive/source-status")

        assert resp.status_code == 200
        email = resp.json()["email"]
        assert "platform" in email
        assert "accessible" in email
        assert "method" in email
        assert "permission_instructions" in email
        assert "error" in email

    @pytest.mark.asyncio
    async def test_source_status_filesystem_section_fields(self, client):
        """Filesystem section has required fields."""
        resp = await client.get("/v1/proactive/source-status")
        assert resp.status_code == 200
        fs = resp.json()["filesystem"]
        assert "watch_locations" in fs
        assert "valid_count" in fs
        assert "indexing_locations" in fs
        assert "error" in fs

    @pytest.mark.asyncio
    async def test_source_status_browser_error_isolated(self, client):
        """Browser detection failure does not break email/filesystem."""
        with patch(
            "application.sources.chromium_history.resolve_chromium_user_data_dir",
            side_effect=RuntimeError("Chrome registry corrupt"),
            create=True,
        ):
            resp = await client.get("/v1/proactive/source-status")

        assert resp.status_code == 200
        body = resp.json()
        # Browser has error, but email and filesystem still present
        assert body["browser"]["error"] is not None or body["browser"]["installed"] == []
        assert "email" in body
        assert "filesystem" in body

    @pytest.mark.asyncio
    async def test_source_status_email_not_accessible_has_instructions(self, client):
        """When email is not accessible, permission_instructions is populated."""
        with patch(
            "application.sources.macos_mail.test_mail_access",
            return_value=False,
            create=True,
        ):
            resp = await client.get("/v1/proactive/source-status")

        assert resp.status_code == 200
        email = resp.json()["email"]
        if email.get("error") is None and email.get("platform") == "darwin":
            assert email["accessible"] is False
            assert email["permission_instructions"] is not None
            assert "System Settings" in email["permission_instructions"]
            assert email["restart_note"] is not None
            assert "Check Again" in email["restart_note"]

    @pytest.mark.asyncio
    async def test_source_status_email_accessible_no_instructions(self, client):
        """When email is accessible, permission_instructions is None."""
        with patch(
            "application.sources.macos_mail.test_mail_access",
            return_value=True,
            create=True,
        ):
            resp = await client.get("/v1/proactive/source-status")

        assert resp.status_code == 200
        email = resp.json()["email"]
        if email.get("error") is None and email.get("platform") == "darwin":
            assert email["accessible"] is True
            assert email["permission_instructions"] is None
            assert email["restart_note"] is None

    @pytest.mark.asyncio
    async def test_source_status_email_non_darwin(self, client):
        """Non-darwin platform returns not_supported for email."""
        import sys as _sys
        with patch.object(_sys, "platform", "linux"):
            resp = await client.get("/v1/proactive/source-status")

        assert resp.status_code == 200
        email = resp.json()["email"]
        if email.get("error") is None:
            assert email["method"] == "not_supported"
            assert email["accessible"] is False

    @pytest.mark.asyncio
    async def test_source_status_filesystem_valid_count(self, client, app, tmp_path):
        """Filesystem section counts valid (existing) watch locations."""
        from api.dependencies import get_settings as _real_gs

        real = _real_gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.app_root = tmp_path
        mock_settings.proactive = real.proactive

        # Override watch_locations to include an existing path
        mock_settings.proactive.filesystem.watch_locations = [str(tmp_path)]

        app.dependency_overrides[_real_gs] = lambda: mock_settings
        try:
            resp = await client.get("/v1/proactive/source-status")
            assert resp.status_code == 200
            fs = resp.json()["filesystem"]
            assert isinstance(fs["valid_count"], int)
            assert fs["valid_count"] >= 1  # tmp_path exists
            assert str(tmp_path) in fs["watch_locations"]
        finally:
            app.dependency_overrides.pop(_real_gs, None)
