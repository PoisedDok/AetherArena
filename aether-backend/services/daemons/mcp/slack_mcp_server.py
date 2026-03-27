#!/usr/bin/env python3
"""
@.architecture
Incoming: MCP protocol (stdin), Open Interpreter tool calls --- {MCP requests, JSON-RPC}
Processing: connect to Slack via slack_sdk, expose read/search tools --- {JOB_API_CALL, JOB_SEARCH}
Outgoing: MCP protocol (stdout), Slack API --- {MCP responses, HTTP requests}
"""

import asyncio
import logging
import os
from typing import Any, Dict, List
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent
from slack_sdk.web.async_client import AsyncWebClient
from slack_sdk.errors import SlackApiError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("slack_mcp_server")

app = Server("slack-mcp")

def get_client() -> AsyncWebClient:
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        raise ValueError("SLACK_BOT_TOKEN environment variable is required")
    return AsyncWebClient(token=token)

@app.list_tools()
async def list_tools() -> List[Tool]:
    """List available Slack tools."""
    return [
        Tool(
            name="slack_list_channels",
            description="List available public and private channels the bot is in.",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Maximum number of channels to return", "default": 100}
                }
            }
        ),
        Tool(
            name="slack_read_channel_history",
            description="Read recent messages from a specific channel.",
            inputSchema={
                "type": "object",
                "properties": {
                    "channel_id": {"type": "string", "description": "The ID of the channel to read"},
                    "limit": {"type": "integer", "description": "Maximum number of messages to retrieve", "default": 50}
                },
                "required": ["channel_id"]
            }
        ),
        Tool(
            name="slack_search_messages",
            description="Search messages in Slack. Requires a user token (xoxp-) for full search capabilities.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "limit": {"type": "integer", "description": "Maximum number of results to return", "default": 20}
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="slack_send_message",
            description="Send a message to a specific Slack channel. The message will appear to come from the Aether Agent bot.",
            inputSchema={
                "type": "object",
                "properties": {
                    "channel_id": {"type": "string", "description": "The ID of the channel to send the message to"},
                    "text": {"type": "string", "description": "The message content to send"}
                },
                "required": ["channel_id", "text"]
            }
        ),
        Tool(
            name="slack_health_check",
            description="Check the health and connection status of the Slack bot.",
            inputSchema={"type": "object", "properties": {}}
        )
    ]

@app.call_tool()
async def call_tool(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
    """Execute Slack tools."""
    try:
        client = get_client()
        
        if name == "slack_health_check":
            auth_test = await client.auth_test()
            return [TextContent(type="text", text=f"Connected successfully as {auth_test.get('user', 'unknown')} on team {auth_test.get('team', 'unknown')}")]
            
        elif name == "slack_list_channels":
            limit = arguments.get("limit", 100)
            response = await client.conversations_list(
                types="public_channel,private_channel",
                exclude_archived=True,
                limit=limit
            )
            channels = response.get("channels", [])
            if not channels:
                return [TextContent(type="text", text="No channels found. Ensure the bot is invited to channels.")]
            
            result = "Slack Channels:\n"
            for c in channels:
                result += f"- #{c.get('name')} (ID: {c.get('id')})\n"
            return [TextContent(type="text", text=result)]
            
        elif name == "slack_read_channel_history":
            channel_id = arguments.get("channel_id")
            limit = arguments.get("limit", 50)
            
            response = await client.conversations_history(channel=channel_id, limit=limit)
            messages = response.get("messages", [])
            
            if not messages:
                return [TextContent(type="text", text=f"No messages found in channel {channel_id}.")]
                
            result = f"Recent messages in channel {channel_id}:\n\n"
            for m in reversed(messages):  # chronological order
                user = m.get("user", "unknown_user")
                text = m.get("text", "")
                result += f"[{user}]: {text}\n"
            return [TextContent(type="text", text=result)]
            
        elif name == "slack_search_messages":
            query = arguments.get("query")
            limit = arguments.get("limit", 20)
            
            response = await client.search_messages(query=query, count=limit)
            messages = response.get("messages", {}).get("matches", [])
            
            if not messages:
                return [TextContent(type="text", text=f"No messages found matching '{query}'.")]
                
            result = f"Search results for '{query}':\n\n"
            for m in messages:
                user = m.get("username", m.get("user", "unknown_user"))
                text = m.get("text", "")
                channel = m.get("channel", {}).get("name", "unknown_channel")
                result += f"[#{channel} - {user}]: {text}\n"
            return [TextContent(type="text", text=result)]
            
        elif name == "slack_send_message":
            channel_id = arguments.get("channel_id")
            text = arguments.get("text")
            
            response = await client.chat_postMessage(
                channel=channel_id,
                text=text
            )
            return [TextContent(type="text", text=f"Message successfully sent to channel {channel_id}.")]
            
        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]
            
    except SlackApiError as e:
        logger.error(f"Slack API error: {e.response['error']}")
        return [TextContent(type="text", text=f"Slack API Error: {e.response['error']}")]
    except Exception as e:
        logger.error(f"Error in {name}: {str(e)}", exc_info=True)
        return [TextContent(type="text", text=f"Error: {str(e)}")]

async def main():
    logger.info("Starting Native Slack MCP Server...")
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options()
        )

if __name__ == "__main__":
    asyncio.run(main())
