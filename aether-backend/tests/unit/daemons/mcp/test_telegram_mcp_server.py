import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from services.daemons.mcp.telegram_mcp_server import list_tools, call_tool, get_client


@pytest.fixture
def mock_env(monkeypatch):
    monkeypatch.setenv("TELEGRAM_API_ID", "12345")
    monkeypatch.setenv("TELEGRAM_API_HASH", "abcdef")
    monkeypatch.setenv("AETHER_BACKEND_ROOT", "/tmp")


class TestTelegramMCPServer:
    def test_get_client_missing_env(self, monkeypatch):
        monkeypatch.delenv("TELEGRAM_API_ID", raising=False)
        with pytest.raises(ValueError, match="TELEGRAM_API_ID and TELEGRAM_API_HASH environment variables are required"):
            get_client()

    @patch("services.daemons.mcp.telegram_mcp_server.TelegramClient")
    def test_get_client_success(self, mock_telegram_client, mock_env):
        client = get_client()
        assert client is not None
        mock_telegram_client.assert_called_once()

    @pytest.mark.asyncio
    async def test_list_tools(self):
        tools = await list_tools()
        tool_names = [t.name for t in tools]
        assert "telegram_request_otp" in tool_names
        assert "telegram_submit_otp" in tool_names
        assert "telegram_list_dialogs" in tool_names
        assert "telegram_read_chat" in tool_names
        assert "telegram_health_check" in tool_names

    @pytest.mark.asyncio
    @patch("services.daemons.mcp.telegram_mcp_server.get_client")
    async def test_call_tool_health_check_unauth(self, mock_get_client, mock_env):
        mock_client = AsyncMock()
        mock_client.is_user_authorized.return_value = False
        mock_get_client.return_value = mock_client
        
        # Reset global _client
        import services.daemons.mcp.telegram_mcp_server as tmcp
        tmcp._client = None

        results = await call_tool("telegram_health_check", {})
        assert len(results) == 1
        assert "NOT authorized" in results[0].text

    @pytest.mark.asyncio
    @patch("services.daemons.mcp.telegram_mcp_server.get_client")
    async def test_call_tool_request_otp(self, mock_get_client, mock_env):
        mock_client = AsyncMock()
        mock_get_client.return_value = mock_client
        
        # Reset global _client
        import services.daemons.mcp.telegram_mcp_server as tmcp
        tmcp._client = None

        results = await call_tool("telegram_request_otp", {"phone_number": "+1234567890"})
        assert len(results) == 1
        assert "OTP code requested for +1234567890" in results[0].text
        mock_client.send_code_request.assert_called_once_with("+1234567890")
