#!/usr/bin/env python3
"""
@.architecture
Incoming: MCP protocol (stdin), Open Interpreter tool calls --- {MCP requests, JSON-RPC}
Processing: OS-level file system access using python pathlib/os --- {JOB_FS_ACCESS}
Outgoing: MCP protocol (stdout) --- {MCP responses, File contents}
"""

import asyncio
import logging
import os
import glob
import fnmatch
from pathlib import Path
from typing import Any, Dict, List

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("filesystem_mcp_server")

app = Server("filesystem-mcp")

# Security: In a production desktop app, we usually allow access to the whole user home dir, 
# or specific workspaces. Since Aether is a local AI desktop app, we can allow full read/write 
# but log it, or restrict to a base dir. For now, we allow access to the system but resolve absolute paths.

def _normalize_path(path_str: str) -> Path:
    p = Path(path_str).expanduser().resolve()
    return p

@app.list_tools()
async def list_tools() -> List[Tool]:
    """List available Filesystem tools."""
    return [
        Tool(
            name="read_file",
            description="Read the complete contents of a file at the specified path.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute or relative path to the file"}
                },
                "required": ["path"]
            }
        ),
        Tool(
            name="list_directory",
            description="List contents of a directory. Returns file and folder names.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the directory"}
                },
                "required": ["path"]
            }
        ),
        Tool(
            name="search_filesystem",
            description="Search for files by name/pattern within a directory.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Base directory to search in"},
                    "pattern": {"type": "string", "description": "Glob pattern (e.g. '*.pdf', 'report_*')"},
                    "recursive": {"type": "boolean", "description": "Search recursively", "default": True}
                },
                "required": ["path", "pattern"]
            }
        ),
        Tool(
            name="get_file_info",
            description="Get metadata for a file or directory (size, modified time, etc).",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file or directory"}
                },
                "required": ["path"]
            }
        )
    ]

@app.call_tool()
async def call_tool(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
    """Execute filesystem tools."""
    try:
        if name == "read_file":
            path = _normalize_path(arguments.get("path"))
            if not path.is_file():
                return [TextContent(type="text", text=f"Error: File not found or is a directory: {path}")]
            try:
                content = path.read_text(encoding="utf-8")
                return [TextContent(type="text", text=content)]
            except UnicodeDecodeError:
                return [TextContent(type="text", text=f"Error: File is binary or not UTF-8 encoded: {path}")]

        elif name == "list_directory":
            path = _normalize_path(arguments.get("path"))
            if not path.is_dir():
                return [TextContent(type="text", text=f"Error: Directory not found: {path}")]
            
            entries = []
            for item in path.iterdir():
                type_str = "DIR" if item.is_dir() else "FILE"
                entries.append(f"[{type_str}] {item.name}")
            
            result = f"Contents of {path}:\n" + "\n".join(entries)
            if not entries:
                result += "(Empty directory)"
            return [TextContent(type="text", text=result)]

        elif name == "search_filesystem":
            path = _normalize_path(arguments.get("path"))
            pattern = arguments.get("pattern", "*")
            recursive = arguments.get("recursive", True)
            
            if not path.is_dir():
                return [TextContent(type="text", text=f"Error: Base directory not found: {path}")]
            
            matches = []
            try:
                if recursive:
                    for root, _, files in os.walk(path):
                        for filename in fnmatch.filter(files, pattern):
                            matches.append(os.path.join(root, filename))
                else:
                    for item in path.iterdir():
                        if item.is_file() and fnmatch.fnmatch(item.name, pattern):
                            matches.append(str(item))
            except Exception as e:
                return [TextContent(type="text", text=f"Error during search: {e}")]
                
            if not matches:
                return [TextContent(type="text", text=f"No matches found for '{pattern}' in {path}")]
                
            # Limit results to avoid massive outputs
            MAX_RESULTS = 100
            result = f"Found {len(matches)} matches (showing top {min(len(matches), MAX_RESULTS)}):\n"
            result += "\n".join(matches[:MAX_RESULTS])
            return [TextContent(type="text", text=result)]

        elif name == "get_file_info":
            path = _normalize_path(arguments.get("path"))
            if not path.exists():
                return [TextContent(type="text", text=f"Error: Path not found: {path}")]
                
            stat = path.stat()
            is_dir = path.is_dir()
            
            info = f"Path: {path}\n"
            info += f"Type: {'Directory' if is_dir else 'File'}\n"
            info += f"Size: {stat.st_size} bytes\n"
            from datetime import datetime
            info += f"Created: {datetime.fromtimestamp(stat.st_ctime)}\n"
            info += f"Modified: {datetime.fromtimestamp(stat.st_mtime)}\n"
            return [TextContent(type="text", text=info)]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]
            
    except PermissionError:
        return [TextContent(type="text", text="Error: Permission denied. Access restricted.")]
    except Exception as e:
        logger.error(f"Error in {name}: {str(e)}", exc_info=True)
        return [TextContent(type="text", text=f"Error: {str(e)}")]

async def main():
    logger.info("Starting Native Filesystem MCP Server...")
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options()
        )

if __name__ == "__main__":
    asyncio.run(main())
