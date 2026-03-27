#!/usr/bin/env python3
"""
@.architecture
Incoming: MCP protocol (stdin), Open Interpreter tool calls --- {MCP requests, JSON-RPC}
Processing: expose file search tool, call backend API --- {2 jobs: JOB_HTTP_REQUEST, JOB_SEARCH_INDEX}
Outgoing: MCP protocol (stdout), Backend API /v1/search/files --- {MCP responses, search results}
"""

import asyncio
import httpx
import logging
import os
from typing import Any, Dict, List
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("file_indexing_mcp")

# Backend API endpoint from environment.
# Canonical API paths are used for each tool call.
BACKEND_URL = os.getenv("INTEGRATION_FILE_INDEXING_BACKEND_URL", "http://127.0.0.1:8765").rstrip("/")
logger.info(f"File Indexing MCP using backend base: {BACKEND_URL}")

app = Server("file-indexing-mcp")


@app.list_tools()
async def list_tools() -> List[Tool]:
    """List available file indexing tools."""
    return [
        Tool(
            name="search_files",
            description="Search indexed files using semantic search. Returns relevant file chunks with metadata.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query to find relevant files"
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Number of results to return (1-50)",
                        "default": 10,
                        "minimum": 1,
                        "maximum": 50
                    },
                    "file_extensions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Filter by file extensions (e.g., ['pdf', 'txt'])",
                        "default": []
                    }
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="list_locations",
            description="List all indexed file locations with their statistics.",
            inputSchema={
                "type": "object",
                "properties": {
                    "enabled_only": {
                        "type": "boolean",
                        "description": "Only return enabled locations",
                        "default": False
                    }
                }
            }
        ),
        Tool(
            name="get_indexing_health",
            description="Get the health status of the file indexing service.",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        )
    ]


@app.call_tool()
async def call_tool(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
    """Execute file indexing tools."""
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            
            if name == "search_files":
                query = arguments.get("query", "")
                top_k = arguments.get("top_k", 10)
                file_extensions = arguments.get("file_extensions", [])
                
                # Call backend search API (clean endpoint: /v1/search/files)
                params = {"query": query, "top_k": top_k}
                if file_extensions:
                    params["file_extensions"] = file_extensions
                
                response = await client.get(
                    f"{BACKEND_URL}/v1/search/files",
                    params=params
                )
                response.raise_for_status()
                
                result = response.json()
                
                # Format results
                if not result["results"]:
                    return [TextContent(
                        type="text",
                        text=f"No results found for query: {query}\n"
                             f"Searched {len(result['locations_searched'])} locations in {result['search_duration_ms']}ms"
                    )]
                
                formatted_results = f"Found {result['total_found']} results in {result['search_duration_ms']}ms\n\n"
                
                for idx, item in enumerate(result["results"], 1):
                    formatted_results += f"{idx}. {item['file_name']} ({item['file_extension']})\n"
                    formatted_results += f"   Path: {item['file_path']}\n"
                    formatted_results += f"   Score: {item['score']:.3f}\n"
                    formatted_results += f"   Content: {item['chunk_text'][:200]}...\n\n"
                
                return [TextContent(type="text", text=formatted_results)]
            
            elif name == "list_locations":
                enabled_only = arguments.get("enabled_only", False)
                
                params = {"enabled_only": enabled_only} if enabled_only else {}
                # Clean endpoint: /v1/file/location/list
                response = await client.get(f"{BACKEND_URL}/v1/file/location/list", params=params)
                response.raise_for_status()
                
                locations = response.json()
                
                if not locations:
                    return [TextContent(
                        type="text",
                        text="No indexed locations found. Add locations via the settings panel."
                    )]
                
                formatted = f"Found {len(locations)} indexed location(s):\n\n"
                
                for loc in locations:
                    status_text = "✓ Enabled" if loc.get('enabled') else "✗ Disabled"
                    formatted += f"• {loc.get('location_name', 'Unknown')} ({status_text})\n"
                    formatted += f"  Path: {loc.get('root_path', 'unknown')}\n"
                    formatted += f"  Files: {loc.get('file_count', 0)}, Chunks: {loc.get('chunk_count', 0)}\n"
                    formatted += f"  Last scan: {loc.get('last_scan_at') or 'Never'} ({loc.get('last_scan_status', 'None')})\n\n"
                
                return [TextContent(type="text", text=formatted)]
            
            elif name == "get_indexing_health":
                # Clean endpoint: /v1/file/health
                response = await client.get(f"{BACKEND_URL}/v1/file/health")
                response.raise_for_status()
                
                health = response.json()
                
                formatted = "File Indexing Service Health\n"
                formatted += f"{'='*40}\n"
                formatted += f"Status: {health['service_status'].upper()}\n"
                formatted += f"Process ID: {health['process_id'] or 'N/A'}\n"
                formatted += f"Last Heartbeat: {health['last_heartbeat'] or 'N/A'}\n"
                formatted += f"Errors: {health['consecutive_errors']}\n"
                
                if health['error_message']:
                    formatted += f"Error: {health['error_message']}\n"
                
                return [TextContent(type="text", text=formatted)]
            
            else:
                return [TextContent(
                    type="text",
                    text=f"Unknown tool: {name}"
                )]
                
    except httpx.HTTPError as e:
        logger.error(f"HTTP error calling {name}: {e}")
        return [TextContent(
            type="text",
            text=f"Error calling backend API: {str(e)}"
        )]
    except Exception as e:
        logger.error(f"Error executing {name}: {e}", exc_info=True)
        return [TextContent(
            type="text",
            text=f"Error: {str(e)}"
        )]


async def main():
    """Run the MCP server."""
    logger.info("Starting File Indexing MCP Server...")
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options()
        )


if __name__ == "__main__":
    asyncio.run(main())

