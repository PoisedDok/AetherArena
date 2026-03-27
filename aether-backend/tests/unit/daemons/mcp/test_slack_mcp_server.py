import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from services.daemons.mcp.slack_mcp_server import list_tools, call_tool, get_client


@pytest.fixture
def mock_env(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test-token")


class TestSlackMCPServer:
    def test_get_client_missing_token(self, monkeypatch):
        monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
        with pytest.raises(ValueError, match="SLACK_BOT_TOKEN environment variable is required"):
            get_client()

    def test_get_client_success(self, mock_env):
        client = get_client()
        assert client is not None
        assert client.token == "xoxb-test-token"

    @pytest.mark.asyncio
    async def test_list_tools(self):
        tools = await list_tools()
        tool_names = [t.name for t in tools]
        assert "slack_list_channels" in tool_names
        assert "slack_read_channel_history" in tool_names
        assert "slack_search_messages" in tool_names
        assert "slack_health_check" in tool_names

    @pytest.mark.asyncio
    @patch("services.daemons.mcp.slack_mcp_server.get_client")
    async def test_call_tool_health_check(self, mock_get_client, mock_env):
        mock_client = AsyncMock()
        mock_client.auth_test.return_value = {"user": "testbot", "team": "testteam"}
        mock_get_client.return_value = mock_client

        results = await call_tool("slack_health_check", {})
        assert len(results) == 1
        assert "Connected successfully as testbot on team testteam" in results[0].text

    @pytest.mark.asyncio
    @patch("services.daemons.mcp.slack_mcp_server.get_client")
    async def test_call_tool_list_channels(self, mock_get_client, mock_env):
        mock_client = AsyncMock()
        mock_client.conversations_list.return_value = {
            "channels": [
                {"name": "general", "id": "C123"},
                {"name": "random", "id": "C456"}
            ]
        }
        mock_get_client.return_value = mock_client

        results = await call_tool("slack_list_channels", {})
        assert len(results) == 1
        assert "- #general (ID: C123)" in results[0].text
        assert "- #random (ID: C456)" in results[0].text

    @pytest.mark.asyncio
    @patch("services.daemons.mcp.slack_mcp_server.get_client")
    async def test_call_tool_read_channel_history(self, mock_get_client, mock_env):
        mock_client = AsyncMock()
        mock_client.conversations_history.return_value = {
            "messages": [
                {"user": "U1", "text": "Hello"},
                {"user": "U2", "text": "World"}
            ]
        }
        mock_get_client.return_value = mock_client

        results = await call_tool("slack_read_channel_history", {"channel_id": "C123"})
        assert len(results) == 1
        assert "[U1]: Hello" in results[0].text
        assert "[U2]: World" in results[0].text
