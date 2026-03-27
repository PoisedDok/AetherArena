"""
MCP Endpoint Tests

Covers all 15 routes + 3 validators in api/v1/endpoints/mcp.py:
  POST   /v1/mcp/servers                       (register)
  POST   /v1/mcp/servers/start                  (start)
  POST   /v1/mcp/servers/stop                   (stop)
  GET    /v1/mcp/servers                        (list)
  GET    /v1/mcp/servers/{id}                   (get)
  PUT    /v1/mcp/servers/{id}                   (update)
  DELETE /v1/mcp/servers/{id}                   (delete)
  POST   /v1/mcp/servers/{id}/test              (test connectivity)
  GET    /v1/mcp/servers/{id}/tools             (tools by id)
  GET    /v1/mcp/servers/by-name/{name}/tools   (tools by name)
  POST   /v1/mcp/servers/{id}/tools/{name}      (execute tool)
  GET    /v1/mcp/servers/{id}/health            (server health)
  GET    /v1/mcp/servers/{id}/stats             (server stats)
  GET    /v1/mcp/executions                     (execution history)
  GET    /v1/mcp/health                         (system health)

Mocking strategy:
  - mock_mcp_manager (from root conftest) is injected via set_mcp_manager().
  - Per-test side_effect overrides simulate error branches.
  - No real MCP servers, no real database, no real infrastructure.
"""

import pytest
from uuid import uuid4
from unittest.mock import AsyncMock
from fastapi import HTTPException

# Valid UUID for server_id params
SERVER_ID = "550e8400-e29b-41d4-a716-446655440000"

# Fully-formed registration payload matching RegisterServerRequest schema
REGISTER_PAYLOAD = {
    "name": "test-server",
    "display_name": "Test Server",
    "description": "A test MCP server",
    "server_type": "local",
    "config": {"command": "python", "args": ["-m", "test_server"]},
    "auto_start": True,
    "enabled": True,
}

# Minimal update payload matching UpdateServerRequest schema
UPDATE_PAYLOAD = {
    "display_name": "Updated Server",
    "description": "Updated description",
    "auto_start": False,
}

# Execute tool payload matching ExecuteToolRequest schema
EXECUTE_PAYLOAD = {
    "arguments": {"path": "/tmp/test.txt"},
    "timeout": 30,
}


# ═══════════════════════════════════════════════════════════════════════════════
# POST /v1/mcp/servers — register_server
# ═══════════════════════════════════════════════════════════════════════════════


class TestRegisterServer:

    @pytest.mark.asyncio
    async def test_register_success(self, client, mock_mcp_manager):
        """Valid registration returns 201 with ServerResponse."""
        resp = await client.post("/v1/mcp/servers", json=REGISTER_PAYLOAD)
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "test-server"
        assert body["server_type"] == "local"
        assert "server_id" in body
        assert "config" in body
        mock_mcp_manager.register_server.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_register_missing_name_returns_422(self, client):
        """Missing required name field returns 422."""
        resp = await client.post("/v1/mcp/servers", json={
            "config": {"command": "python", "args": []},
        })
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_register_missing_config_returns_422(self, client):
        """Missing required config field returns 422."""
        resp = await client.post("/v1/mcp/servers", json={"name": "test"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_register_invalid_server_type_returns_422(self, client):
        """Invalid server_type pattern returns 422."""
        payload = {**REGISTER_PAYLOAD, "server_type": "invalid"}
        resp = await client.post("/v1/mcp/servers", json=payload)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_register_value_error_returns_400(self, client, mock_mcp_manager):
        """ValueError from manager returns 400."""
        mock_mcp_manager.register_server = AsyncMock(side_effect=ValueError("bad config"))
        resp = await client.post("/v1/mcp/servers", json=REGISTER_PAYLOAD)
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_register_http_exception_reraised(self, client, mock_mcp_manager):
        """HTTPException from manager is re-raised directly (not wrapped in 500)."""
        mock_mcp_manager.register_server = AsyncMock(
            side_effect=HTTPException(status_code=409, detail="Server already exists")
        )
        resp = await client.post("/v1/mcp/servers", json=REGISTER_PAYLOAD)
        assert resp.status_code == 409
        assert resp.json()["detail"] == "Server already exists"

    @pytest.mark.asyncio
    async def test_register_generic_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception from manager returns 500."""
        mock_mcp_manager.register_server = AsyncMock(side_effect=RuntimeError("boom"))
        resp = await client.post("/v1/mcp/servers", json=REGISTER_PAYLOAD)
        assert resp.status_code == 500


# ═══════════════════════════════════════════════════════════════════════════════
# POST /v1/mcp/servers/start — start_server
# ═══════════════════════════════════════════════════════════════════════════════


class TestStartServer:

    @pytest.mark.asyncio
    async def test_start_success(self, client, mock_mcp_manager):
        """Valid start request returns 200 with JSON."""
        resp = await client.post("/v1/mcp/servers/start", json={"name": "test-server"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["server_name"] == "test-server"
        mock_mcp_manager.start_server_by_name.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_start_missing_name_returns_422(self, client):
        """Missing name field returns 422."""
        resp = await client.post("/v1/mcp/servers/start", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_start_empty_name_returns_422(self, client):
        """Empty name string returns 422 (min_length=1)."""
        resp = await client.post("/v1/mcp/servers/start", json={"name": ""})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_start_whitespace_only_name_returns_400(self, client):
        """Whitespace-only name passes Pydantic min_length=1 but fails validate_server_name strip check."""
        resp = await client.post("/v1/mcp/servers/start", json={"name": " "})
        assert resp.status_code == 400
        assert "empty" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_start_invalid_name_chars_returns_400(self, client):
        """Name with invalid characters returns 400 from validate_server_name."""
        resp = await client.post("/v1/mcp/servers/start", json={"name": "test server!"})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_start_not_found_returns_404(self, client, mock_mcp_manager):
        """ValueError from manager (not found) returns 404."""
        mock_mcp_manager.start_server_by_name = AsyncMock(side_effect=ValueError("not found"))
        resp = await client.post("/v1/mcp/servers/start", json={"name": "test-server"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_start_runtime_error_returns_503(self, client, mock_mcp_manager):
        """RuntimeError from manager returns 503."""
        mock_mcp_manager.start_server_by_name = AsyncMock(side_effect=RuntimeError("failed"))
        resp = await client.post("/v1/mcp/servers/start", json={"name": "test-server"})
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_start_generic_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception returns 500."""
        mock_mcp_manager.start_server_by_name = AsyncMock(side_effect=OSError("crash"))
        resp = await client.post("/v1/mcp/servers/start", json={"name": "test-server"})
        assert resp.status_code == 500


# ═══════════════════════════════════════════════════════════════════════════════
# POST /v1/mcp/servers/stop — stop_server
# ═══════════════════════════════════════════════════════════════════════════════


class TestStopServer:

    @pytest.mark.asyncio
    async def test_stop_success(self, client, mock_mcp_manager):
        """Valid stop request returns 200."""
        mock_mcp_manager.stop_server_by_name = AsyncMock()
        resp = await client.post("/v1/mcp/servers/stop", json={"name": "test-server"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["server_name"] == "test-server"

    @pytest.mark.asyncio
    async def test_stop_missing_name_returns_422(self, client):
        """Missing name returns 422."""
        resp = await client.post("/v1/mcp/servers/stop", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stop_not_found_returns_404(self, client, mock_mcp_manager):
        """ValueError from manager returns 404."""
        mock_mcp_manager.stop_server_by_name = AsyncMock(side_effect=ValueError("not found"))
        resp = await client.post("/v1/mcp/servers/stop", json={"name": "test-server"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_stop_runtime_error_returns_503(self, client, mock_mcp_manager):
        """RuntimeError from manager returns 503."""
        mock_mcp_manager.stop_server_by_name = AsyncMock(side_effect=RuntimeError("fail"))
        resp = await client.post("/v1/mcp/servers/stop", json={"name": "test-server"})
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_stop_http_exception_reraised(self, client, mock_mcp_manager):
        """HTTPException from validate_server_name is caught by except HTTPException and re-raised."""
        # Whitespace-only name passes Pydantic but fails validate_server_name → HTTPException
        resp = await client.post("/v1/mcp/servers/stop", json={"name": " "})
        assert resp.status_code == 400
        assert "empty" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_stop_generic_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception (not ValueError/RuntimeError/HTTPException) returns 500."""
        mock_mcp_manager.stop_server_by_name = AsyncMock(side_effect=OSError("crash"))
        resp = await client.post("/v1/mcp/servers/stop", json={"name": "test-server"})
        assert resp.status_code == 500


# ═══════════════════════════════════════════════════════════════════════════════
# GET /v1/mcp/servers — list_servers
# ═══════════════════════════════════════════════════════════════════════════════


class TestListServers:

    @pytest.mark.asyncio
    async def test_list_returns_array(self, client, mock_mcp_manager):
        """List returns all registered servers."""
        resp = await client.get("/v1/mcp/servers")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert len(body) == 1
        assert body[0]["name"] == "test-server"
        assert "config" in body[0]

    @pytest.mark.asyncio
    async def test_list_enabled_only_filter(self, client, mock_mcp_manager):
        """enabled_only=true filters disabled servers."""
        disabled_server = {
            "id": str(uuid4()),
            "name": "disabled-server",
            "display_name": "Disabled",
            "server_type": "local",
            "status": "stopped",
            "config": {"command": "python", "args": []},
            "enabled": False,
            "auto_start": False,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "tools_count": 0,
        }
        mock_mcp_manager.list_servers = AsyncMock(return_value=[
            mock_mcp_manager.list_servers.return_value[0],
            disabled_server,
        ])
        resp = await client.get("/v1/mcp/servers?enabled_only=true")
        assert resp.status_code == 200
        body = resp.json()
        # Only the enabled server should be returned
        assert all(s["enabled"] for s in body)

    @pytest.mark.asyncio
    async def test_list_empty(self, client, mock_mcp_manager):
        """Empty server list returns empty array."""
        mock_mcp_manager.list_servers = AsyncMock(return_value=[])
        resp = await client.get("/v1/mcp/servers")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_list_http_exception_reraised(self, client, mock_mcp_manager):
        """HTTPException from manager is re-raised directly (not wrapped in 500)."""
        mock_mcp_manager.list_servers = AsyncMock(
            side_effect=HTTPException(status_code=503, detail="DB unavailable")
        )
        resp = await client.get("/v1/mcp/servers")
        assert resp.status_code == 503
        assert resp.json()["detail"] == "DB unavailable"

    @pytest.mark.asyncio
    async def test_list_error_returns_500(self, client, mock_mcp_manager):
        """Exception from manager returns 500."""
        mock_mcp_manager.list_servers = AsyncMock(side_effect=RuntimeError("db down"))
        resp = await client.get("/v1/mcp/servers")
        assert resp.status_code == 500


# ═══════════════════════════════════════════════════════════════════════════════
# GET /v1/mcp/servers/{server_id} — get_server
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetServer:

    @pytest.mark.asyncio
    async def test_get_success(self, client, mock_mcp_manager):
        """Valid UUID returns server details."""
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["server_id"] == SERVER_ID
        assert body["name"] == "test-server"
        assert body["config"]["command"] == "python"

    @pytest.mark.asyncio
    async def test_get_invalid_uuid_returns_400(self, client):
        """Non-UUID server_id returns 400."""
        resp = await client.get("/v1/mcp/servers/not-a-uuid")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_get_not_found_returns_404(self, client, mock_mcp_manager):
        """Manager returns None for unknown server."""
        mock_mcp_manager.get_server = AsyncMock(return_value=None)
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception returns 500."""
        mock_mcp_manager.get_server = AsyncMock(side_effect=RuntimeError("boom"))
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}")
        assert resp.status_code == 500


# ═══════════════════════════════════════════════════════════════════════════════
# PUT /v1/mcp/servers/{server_id} — update_server
# ═══════════════════════════════════════════════════════════════════════════════


class TestUpdateServer:

    @pytest.mark.asyncio
    async def test_update_success(self, client, mock_mcp_manager):
        """Valid update returns updated ServerResponse."""
        resp = await client.put(f"/v1/mcp/servers/{SERVER_ID}", json=UPDATE_PAYLOAD)
        assert resp.status_code == 200
        body = resp.json()
        assert body["server_id"] == SERVER_ID
        mock_mcp_manager.update_server.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_update_invalid_uuid_returns_400(self, client):
        """Non-UUID returns 400."""
        resp = await client.put("/v1/mcp/servers/bad-id", json=UPDATE_PAYLOAD)
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_update_not_found_returns_404(self, client, mock_mcp_manager):
        """ValueError from manager returns 404."""
        mock_mcp_manager.update_server = AsyncMock(side_effect=ValueError("not found"))
        resp = await client.put(f"/v1/mcp/servers/{SERVER_ID}", json=UPDATE_PAYLOAD)
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_update_runtime_error_returns_503(self, client, mock_mcp_manager):
        """RuntimeError from manager returns 503."""
        mock_mcp_manager.update_server = AsyncMock(side_effect=RuntimeError("restart fail"))
        resp = await client.put(f"/v1/mcp/servers/{SERVER_ID}", json=UPDATE_PAYLOAD)
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_update_generic_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception returns 500."""
        mock_mcp_manager.update_server = AsyncMock(side_effect=OSError("crash"))
        resp = await client.put(f"/v1/mcp/servers/{SERVER_ID}", json=UPDATE_PAYLOAD)
        assert resp.status_code == 500


# ═══════════════════════════════════════════════════════════════════════════════
# DELETE /v1/mcp/servers/{server_id} — delete_server
# ═══════════════════════════════════════════════════════════════════════════════


class TestDeleteServer:

    @pytest.mark.asyncio
    async def test_delete_success_returns_204(self, client, mock_mcp_manager):
        """Successful deletion returns 204 No Content."""
        mock_mcp_manager.delete_server = AsyncMock(return_value=None)
        resp = await client.delete(f"/v1/mcp/servers/{SERVER_ID}")
        assert resp.status_code == 204
        mock_mcp_manager.delete_server.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_delete_invalid_uuid_returns_400(self, client):
        """Non-UUID returns 400."""
        resp = await client.delete("/v1/mcp/servers/not-uuid")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_delete_not_found_returns_404(self, client, mock_mcp_manager):
        """ValueError from manager returns 404."""
        mock_mcp_manager.delete_server = AsyncMock(side_effect=ValueError("not found"))
        resp = await client.delete(f"/v1/mcp/servers/{SERVER_ID}")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_generic_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception returns 500."""
        mock_mcp_manager.delete_server = AsyncMock(side_effect=RuntimeError("boom"))
        resp = await client.delete(f"/v1/mcp/servers/{SERVER_ID}")
        assert resp.status_code == 500


# ═══════════════════════════════════════════════════════════════════════════════
# POST /v1/mcp/servers/{server_id}/test — test_server
# ═══════════════════════════════════════════════════════════════════════════════


class TestTestServer:

    @pytest.mark.asyncio
    async def test_connectivity_success(self, client, mock_mcp_manager):
        """Successful test returns TestServerResponse."""
        mock_mcp_manager.test_server = AsyncMock(return_value={
            "success": True,
            "message": "Server is healthy. Discovered 2 tools.",
            "diagnostics": {"can_connect": True, "tools_discovered": 2},
        })
        resp = await client.post(f"/v1/mcp/servers/{SERVER_ID}/test")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "diagnostics" in body

    @pytest.mark.asyncio
    async def test_connectivity_failure(self, client, mock_mcp_manager):
        """Failed test still returns 200 with success=false."""
        mock_mcp_manager.test_server = AsyncMock(return_value={
            "success": False,
            "message": "Connection refused",
            "diagnostics": {"can_connect": False},
        })
        resp = await client.post(f"/v1/mcp/servers/{SERVER_ID}/test")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is False

    @pytest.mark.asyncio
    async def test_invalid_uuid_returns_400(self, client):
        """Non-UUID returns 400."""
        resp = await client.post("/v1/mcp/servers/bad/test")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_not_found_returns_404(self, client, mock_mcp_manager):
        """ValueError from manager returns 404."""
        mock_mcp_manager.test_server = AsyncMock(side_effect=ValueError("not found"))
        resp = await client.post(f"/v1/mcp/servers/{SERVER_ID}/test")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_generic_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception (not ValueError/HTTPException) returns 500."""
        mock_mcp_manager.test_server = AsyncMock(side_effect=OSError("crash"))
        resp = await client.post(f"/v1/mcp/servers/{SERVER_ID}/test")
        assert resp.status_code == 500
        assert "Failed to test server" in resp.json()["detail"]


# ═══════════════════════════════════════════════════════════════════════════════
# GET /v1/mcp/servers/{server_id}/tools — get_server_tools
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetServerTools:

    @pytest.mark.asyncio
    async def test_tools_success(self, client, mock_mcp_manager):
        """Returns list of ToolResponse for valid server."""
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}/tools")
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert len(body) == 2
        assert body[0]["tool_name"] == "tool1"
        assert body[0]["server_id"] == SERVER_ID
        assert "tool_schema" in body[0]

    @pytest.mark.asyncio
    async def test_tools_invalid_uuid_returns_400(self, client):
        """Non-UUID returns 400."""
        resp = await client.get("/v1/mcp/servers/invalid/tools")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_tools_not_found_returns_404(self, client, mock_mcp_manager):
        """ValueError from manager returns 404."""
        mock_mcp_manager.get_server_tools = AsyncMock(side_effect=ValueError("not found"))
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}/tools")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_tools_server_not_running_returns_503(self, client, mock_mcp_manager):
        """RuntimeError (server not running) returns 503."""
        mock_mcp_manager.get_server_tools = AsyncMock(side_effect=RuntimeError("not running"))
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}/tools")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_tools_generic_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception (not ValueError/RuntimeError) returns 500."""
        mock_mcp_manager.get_server_tools = AsyncMock(side_effect=OSError("crash"))
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}/tools")
        assert resp.status_code == 500
        assert "Failed to get tools" in resp.json()["detail"]


# ═══════════════════════════════════════════════════════════════════════════════
# GET /v1/mcp/servers/by-name/{server_name}/tools — get_server_tools_by_name
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetServerToolsByName:

    @pytest.mark.asyncio
    async def test_tools_by_name_success(self, client, mock_mcp_manager):
        """Returns tools for valid server name."""
        resp = await client.get("/v1/mcp/servers/by-name/test-server/tools")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 2
        assert body[0]["tool_name"] == "tool1"
        # server_id is the name for by-name endpoint
        assert body[0]["server_id"] == "test-server"

    @pytest.mark.asyncio
    async def test_tools_by_name_invalid_chars_returns_400(self, client):
        """Invalid characters in server name returns 400."""
        resp = await client.get("/v1/mcp/servers/by-name/test server!/tools")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_tools_by_name_not_found_returns_404(self, client, mock_mcp_manager):
        """ValueError from manager returns 404."""
        mock_mcp_manager.get_server_tools_by_name = AsyncMock(side_effect=ValueError("no"))
        resp = await client.get("/v1/mcp/servers/by-name/test-server/tools")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_tools_by_name_generic_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception (not ValueError) returns 500."""
        mock_mcp_manager.get_server_tools_by_name = AsyncMock(side_effect=OSError("crash"))
        resp = await client.get("/v1/mcp/servers/by-name/test-server/tools")
        assert resp.status_code == 500
        assert "Failed to get tools" in resp.json()["detail"]


# ═══════════════════════════════════════════════════════════════════════════════
# POST /v1/mcp/servers/{id}/tools/{name} — execute_tool
# ═══════════════════════════════════════════════════════════════════════════════


class TestExecuteTool:

    @pytest.mark.asyncio
    async def test_execute_success(self, client, mock_mcp_manager):
        """Successful execution returns ExecutionResponse."""
        resp = await client.post(
            f"/v1/mcp/servers/{SERVER_ID}/tools/tool1",
            json=EXECUTE_PAYLOAD,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "success"
        assert body["tool_name"] == "tool1"
        assert body["server_id"] == SERVER_ID
        assert body["error"] is None
        assert body["duration_ms"] >= 0
        assert "execution_id" in body

    @pytest.mark.asyncio
    async def test_execute_timeout(self, client, mock_mcp_manager):
        """TimeoutError returns ExecutionResponse with status='timeout'."""
        mock_mcp_manager.execute_tool = AsyncMock(side_effect=TimeoutError("timed out"))
        resp = await client.post(
            f"/v1/mcp/servers/{SERVER_ID}/tools/tool1",
            json=EXECUTE_PAYLOAD,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "timeout"
        assert body["error"] is not None

    @pytest.mark.asyncio
    async def test_execute_error(self, client, mock_mcp_manager):
        """Generic exception returns ExecutionResponse with status='error'."""
        mock_mcp_manager.execute_tool = AsyncMock(side_effect=RuntimeError("tool crashed"))
        resp = await client.post(
            f"/v1/mcp/servers/{SERVER_ID}/tools/tool1",
            json=EXECUTE_PAYLOAD,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "error"
        assert body["error"] is not None

    @pytest.mark.asyncio
    async def test_execute_invalid_server_uuid_returns_400(self, client):
        """Non-UUID server_id returns 400."""
        resp = await client.post(
            "/v1/mcp/servers/bad-uuid/tools/tool1",
            json=EXECUTE_PAYLOAD,
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_execute_empty_tool_name_returns_400(self, client):
        """Empty tool name returns 400."""
        resp = await client.post(
            f"/v1/mcp/servers/{SERVER_ID}/tools/%20",
            json=EXECUTE_PAYLOAD,
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_execute_default_arguments(self, client, mock_mcp_manager):
        """Execute with empty arguments body uses default empty dict."""
        resp = await client.post(
            f"/v1/mcp/servers/{SERVER_ID}/tools/tool1",
            json={},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "success"


# ═══════════════════════════════════════════════════════════════════════════════
# GET /v1/mcp/servers/{id}/health — check_server_health
# ═══════════════════════════════════════════════════════════════════════════════


class TestServerHealth:

    @pytest.mark.asyncio
    async def test_health_healthy(self, client, mock_mcp_manager):
        """Healthy server returns HealthResponse with status=healthy."""
        mock_mcp_manager.check_server_health = AsyncMock(return_value={
            "status": "healthy",
            "is_running": True,
            "tools_count": 2,
        })
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "healthy"
        assert body["is_running"] is True
        assert body["tools_available"] == 2
        assert body["server_id"] == SERVER_ID

    @pytest.mark.asyncio
    async def test_health_exception_returns_unhealthy(self, client, mock_mcp_manager):
        """Exception in health check returns HealthResponse with status=unhealthy."""
        mock_mcp_manager.check_server_health = AsyncMock(side_effect=RuntimeError("down"))
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "unhealthy"
        assert body["is_running"] is False
        assert body["error"] is not None

    @pytest.mark.asyncio
    async def test_health_invalid_uuid_returns_400(self, client):
        """Non-UUID returns 400."""
        resp = await client.get("/v1/mcp/servers/bad/health")
        assert resp.status_code == 400


# ═══════════════════════════════════════════════════════════════════════════════
# GET /v1/mcp/servers/{id}/stats — get_server_stats
# ═══════════════════════════════════════════════════════════════════════════════


class TestServerStats:

    @pytest.mark.asyncio
    async def test_stats_success(self, client, mock_mcp_manager):
        """Returns ServerStats for valid server."""
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}/stats")
        assert resp.status_code == 200
        body = resp.json()
        assert body["server_id"] == SERVER_ID
        assert "total_executions" in body
        assert "successful_executions" in body
        assert "average_duration_ms" in body

    @pytest.mark.asyncio
    async def test_stats_invalid_uuid_returns_400(self, client):
        """Non-UUID returns 400."""
        resp = await client.get("/v1/mcp/servers/bad/stats")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_stats_not_found_returns_404(self, client, mock_mcp_manager):
        """ValueError from manager returns 404."""
        mock_mcp_manager.get_server_stats = AsyncMock(side_effect=ValueError("nope"))
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}/stats")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_stats_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception returns 500."""
        mock_mcp_manager.get_server_stats = AsyncMock(side_effect=RuntimeError("db"))
        resp = await client.get(f"/v1/mcp/servers/{SERVER_ID}/stats")
        assert resp.status_code == 500


# ═══════════════════════════════════════════════════════════════════════════════
# GET /v1/mcp/executions — get_execution_history
# ═══════════════════════════════════════════════════════════════════════════════


class TestExecutionHistory:

    @pytest.mark.asyncio
    async def test_history_success(self, client, mock_mcp_manager):
        """Returns execution history with count."""
        resp = await client.get("/v1/mcp/executions")
        assert resp.status_code == 200
        body = resp.json()
        assert "executions" in body
        assert "count" in body
        assert body["count"] == 0

    @pytest.mark.asyncio
    async def test_history_with_server_filter(self, client, mock_mcp_manager):
        """Filter by server_id query parameter."""
        resp = await client.get(f"/v1/mcp/executions?server_id={SERVER_ID}")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_history_with_limit(self, client, mock_mcp_manager):
        """Custom limit parameter is accepted."""
        resp = await client.get("/v1/mcp/executions?limit=10")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_history_invalid_server_id_returns_400(self, client):
        """Invalid UUID for server_id filter returns 400."""
        resp = await client.get("/v1/mcp/executions?server_id=not-a-uuid")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_history_limit_too_high_returns_422(self, client):
        """Limit above 500 returns 422."""
        resp = await client.get("/v1/mcp/executions?limit=999")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_history_error_returns_500(self, client, mock_mcp_manager):
        """Generic exception returns 500."""
        mock_mcp_manager.get_execution_history = AsyncMock(side_effect=RuntimeError("boom"))
        resp = await client.get("/v1/mcp/executions")
        assert resp.status_code == 500


# ═══════════════════════════════════════════════════════════════════════════════
# GET /v1/mcp/health — mcp_system_health
# ═══════════════════════════════════════════════════════════════════════════════


class TestSystemHealth:

    @pytest.mark.asyncio
    async def test_system_healthy(self, client, mock_mcp_manager):
        """System health returns counts and healthy=True."""
        resp = await client.get("/v1/mcp/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is True
        assert body["manager_initialized"] is True
        assert body["total_servers"] >= 0
        assert "enabled_servers" in body
        assert "running_servers" in body
        assert "timestamp" in body

    @pytest.mark.asyncio
    async def test_system_health_exception_returns_unhealthy(self, client, mock_mcp_manager):
        """Exception in system health returns healthy=False (not 500)."""
        mock_mcp_manager.list_servers = AsyncMock(side_effect=RuntimeError("db error"))
        resp = await client.get("/v1/mcp/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is False
        assert "error" in body

    @pytest.mark.asyncio
    async def test_system_health_http_exception_reraised(self, client, mock_mcp_manager):
        """HTTPException from list_servers is re-raised (not caught by generic handler)."""
        mock_mcp_manager.list_servers = AsyncMock(
            side_effect=HTTPException(status_code=503, detail="Manager unavailable")
        )
        resp = await client.get("/v1/mcp/health")
        assert resp.status_code == 503
        assert resp.json()["detail"] == "Manager unavailable"

    @pytest.mark.asyncio
    async def test_system_health_empty_servers(self, client, mock_mcp_manager):
        """No servers registered still returns healthy."""
        mock_mcp_manager.list_servers = AsyncMock(return_value=[])
        resp = await client.get("/v1/mcp/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is True
        assert body["total_servers"] == 0
        assert body["enabled_servers"] == 0
        assert body["running_servers"] == 0
