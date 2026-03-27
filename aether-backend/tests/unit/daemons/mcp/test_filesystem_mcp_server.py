import pytest
import os
from unittest.mock import patch, MagicMock
from services.daemons.mcp.filesystem_mcp_server import list_tools, call_tool

class TestFilesystemMCPServer:
    @pytest.mark.asyncio
    async def test_list_tools(self):
        tools = await list_tools()
        assert len(tools) == 4
        tool_names = [t.name for t in tools]
        assert "read_file" in tool_names
        assert "list_directory" in tool_names
        assert "search_filesystem" in tool_names
        assert "get_file_info" in tool_names

    @pytest.mark.asyncio
    async def test_call_tool_list_directory_not_found(self):
        result = await call_tool("list_directory", {"path": "/nonexistent_path_xyz"})
        assert len(result) == 1
        assert "Error: Directory not found" in result[0].text

    @pytest.mark.asyncio
    async def test_call_tool_list_directory_success(self, tmp_path):
        # Create a dummy file in the temp path
        d = tmp_path / "test_dir"
        d.mkdir()
        f = d / "test_file.txt"
        f.write_text("hello")
        
        result = await call_tool("list_directory", {"path": str(d)})
        assert len(result) == 1
        assert "test_file.txt" in result[0].text

    @pytest.mark.asyncio
    async def test_call_tool_read_file_success(self, tmp_path):
        f = tmp_path / "test_file.txt"
        f.write_text("file content")
        
        result = await call_tool("read_file", {"path": str(f)})
        assert len(result) == 1
        assert "file content" in result[0].text
        
    @pytest.mark.asyncio
    async def test_call_tool_search_filesystem_success(self, tmp_path):
        d = tmp_path / "test_dir"
        d.mkdir()
        f1 = d / "test1.txt"
        f2 = d / "test2.pdf"
        f1.write_text("hello")
        f2.write_text("hello")
        
        result = await call_tool("search_filesystem", {"path": str(d), "pattern": "*.txt"})
        assert len(result) == 1
        assert "test1.txt" in result[0].text
        assert "test2.pdf" not in result[0].text
