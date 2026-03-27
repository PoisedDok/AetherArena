"""
E2E Tests: File Indexing MCP

Validates MCP tool discovery and execution for file indexing.
"""

import os

import pytest
import pytest_asyncio
from httpx import AsyncClient

from tests.e2e.helpers.http_wait import wait_for_endpoint


@pytest_asyncio.fixture
async def real_client():
    base_url = os.getenv("AETHER_E2E_BASE_URL", "http://127.0.0.1:8765")
    async with AsyncClient(base_url=base_url, timeout=30.0) as client:
        status = await wait_for_endpoint(client, "/v1/health")
        if status != 200:
            pytest.skip(f"Backend not reachable at {base_url}")
        yield client


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_file_indexing_mcp_tools(real_client: AsyncClient):
    servers_resp = await real_client.get("/v1/mcp/servers")
    assert servers_resp.status_code == 200
    servers = servers_resp.json()
    server = next((s for s in servers if s.get("name") == "file_indexing_mcp"), None)
    if not server:
        pytest.skip("file_indexing_mcp not registered")

    server_id = server.get("server_id") or server.get("id")
    if not server_id:
        pytest.skip("file_indexing_mcp missing server_id")

    tools_resp = await real_client.get("/v1/mcp/servers/by-name/file_indexing_mcp/tools")
    assert tools_resp.status_code == 200
    tools = tools_resp.json()
    assert isinstance(tools, list)
    tool_names = {tool.get("tool_name") for tool in tools}
    assert "get_indexing_health" in tool_names

    exec_resp = await real_client.post(
        f"/v1/mcp/servers/{server_id}/tools/get_indexing_health",
        json={"arguments": {}},
    )
    assert exec_resp.status_code == 200
    body = exec_resp.json()
    assert body.get("status") == "success"
