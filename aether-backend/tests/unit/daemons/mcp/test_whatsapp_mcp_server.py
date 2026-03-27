import pytest
from unittest.mock import patch, MagicMock

from services.daemons.mcp.whatsapp_mcp_server import list_tools, call_tool, get_driver

# Note: whatsapp_mcp_server uses selenium heavily. For unit testing, we mock get_driver.
# We also have to mock selenium components inside the module.

@pytest.fixture
def mock_env(monkeypatch):
    monkeypatch.setenv("AETHER_BACKEND_ROOT", "/tmp")

class TestWhatsAppMCPServer:

    @pytest.mark.asyncio
    async def test_list_tools(self):
        tools = await list_tools()
        tool_names = [t.name for t in tools]
        assert "whatsapp_check_auth" in tool_names
        assert "whatsapp_get_qr" in tool_names
        assert "whatsapp_list_chats" in tool_names
        assert "whatsapp_read_chat" in tool_names

    @pytest.mark.asyncio
    @patch("services.daemons.mcp.whatsapp_mcp_server.get_driver")
    @patch("services.daemons.mcp.whatsapp_mcp_server.WebDriverWait")
    @patch("services.daemons.mcp.whatsapp_mcp_server.EC")
    async def test_call_tool_check_auth_success(self, mock_ec, mock_webdriver_wait, mock_get_driver):
        from selenium.common.exceptions import NoSuchElementException
        mock_driver = MagicMock()
        mock_driver.find_element.side_effect = NoSuchElementException("Mock element not found")
        mock_get_driver.return_value = mock_driver
        
        # Make WebDriverWait.until succeed
        mock_wait_instance = MagicMock()
        mock_wait_instance.until.return_value = True
        mock_webdriver_wait.return_value = mock_wait_instance

        results = await call_tool("whatsapp_check_auth", {})
        assert len(results) == 1
        assert "Authenticated successfully" in results[0].text

    @pytest.mark.asyncio
    @patch("services.daemons.mcp.whatsapp_mcp_server.get_driver")
    @patch("services.daemons.mcp.whatsapp_mcp_server.WebDriverWait")
    @patch("services.daemons.mcp.whatsapp_mcp_server.EC")
    async def test_call_tool_get_qr_success(self, mock_ec, mock_webdriver_wait, mock_get_driver):
        mock_driver = MagicMock()
        mock_driver.execute_script.return_value = "data:image/png;base64,mockdata"
        mock_get_driver.return_value = mock_driver
        
        # Make WebDriverWait.until succeed
        mock_wait_instance = MagicMock()
        mock_wait_instance.until.return_value = True
        mock_webdriver_wait.return_value = mock_wait_instance

        results = await call_tool("whatsapp_get_qr", {})
        assert len(results) == 1
        assert "data:image/png;base64,mockdata" in results[0].text
