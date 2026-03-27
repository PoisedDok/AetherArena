#!/usr/bin/env python3
"""
@.architecture
Incoming: MCP protocol (stdin), Open Interpreter tool calls --- {MCP requests, JSON-RPC}
Processing: connect to Telegram via telethon, expose read/search tools --- {JOB_API_CALL, JOB_SEARCH}
Outgoing: MCP protocol (stdout), Telegram API --- {MCP responses, MTProto requests}
"""

import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Dict, List
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError, PhoneCodeExpiredError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("telegram_mcp_server")

app = Server("telegram-mcp")

def get_client() -> TelegramClient:
    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    
    if not api_id or not api_hash:
        raise ValueError("TELEGRAM_API_ID and TELEGRAM_API_HASH environment variables are required")
        
    session_dir = Path(os.environ.get("AETHER_BACKEND_ROOT", ".")) / "data" / "daemons" / "messaging"
    session_dir.mkdir(parents=True, exist_ok=True)
    session_file = str(session_dir / "telegram_user")
    
    return TelegramClient(session_file, int(api_id), api_hash)

# Global reference to hold client during OTP flow
_client: TelegramClient = None

@app.list_tools()
async def list_tools() -> List[Tool]:
    """List available Telegram tools."""
    return [
        Tool(
            name="telegram_request_otp",
            description="Request a login OTP code for a Telegram phone number.",
            inputSchema={
                "type": "object",
                "properties": {
                    "phone_number": {"type": "string", "description": "Phone number with country code (e.g. +1234567890)"}
                },
                "required": ["phone_number"]
            }
        ),
        Tool(
            name="telegram_submit_otp",
            description="Submit the OTP code to complete login.",
            inputSchema={
                "type": "object",
                "properties": {
                    "phone_number": {"type": "string", "description": "The phone number"},
                    "code": {"type": "string", "description": "The OTP code received"},
                    "password": {"type": "string", "description": "2FA password if required"}
                },
                "required": ["phone_number", "code"]
            }
        ),
        Tool(
            name="telegram_list_dialogs",
            description="List recent chats/dialogs.",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Maximum number of dialogs to return", "default": 20}
                }
            }
        ),
        Tool(
            name="telegram_read_chat",
            description="Read recent messages from a specific chat ID or username.",
            inputSchema={
                "type": "object",
                "properties": {
                    "entity": {"type": "string", "description": "Chat ID, username, or phone number"},
                    "limit": {"type": "integer", "description": "Maximum number of messages to retrieve", "default": 50}
                },
                "required": ["entity"]
            }
        ),
        Tool(
            name="telegram_health_check",
            description="Check the health and connection status of the Telegram client.",
            inputSchema={"type": "object", "properties": {}}
        )
    ]

@app.call_tool()
async def call_tool(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
    """Execute Telegram tools."""
    global _client
    
    try:
        if _client is None:
            _client = get_client()
            await _client.connect()
            
        if name == "telegram_health_check":
            is_auth = await _client.is_user_authorized()
            if is_auth:
                me = await _client.get_me()
                return [TextContent(type="text", text=f"Connected successfully as {me.first_name} (@{me.username})")]
            return [TextContent(type="text", text="Connected to API, but NOT authorized. Use request_otp.")]

        elif name == "telegram_request_otp":
            phone = arguments.get("phone_number")
            await _client.send_code_request(phone)
            return [TextContent(type="text", text=f"OTP code requested for {phone}. Check your Telegram app.")]

        elif name == "telegram_submit_otp":
            phone = arguments.get("phone_number")
            code = arguments.get("code")
            password = arguments.get("password")
            
            try:
                await _client.sign_in(phone, code)
            except SessionPasswordNeededError:
                if not password:
                    return [TextContent(type="text", text="2FA password is required but was not provided.")]
                await _client.sign_in(password=password)
            except PhoneCodeInvalidError:
                return [TextContent(type="text", text="Invalid OTP code.")]
            except PhoneCodeExpiredError:
                return [TextContent(type="text", text="OTP code expired.")]
                
            me = await _client.get_me()
            return [TextContent(type="text", text=f"Successfully logged in as {me.first_name}")]

        elif name == "telegram_list_dialogs":
            if not await _client.is_user_authorized():
                return [TextContent(type="text", text="Not authorized. Login first.")]
                
            limit = arguments.get("limit", 20)
            dialogs = await _client.get_dialogs(limit=limit)
            
            if not dialogs:
                return [TextContent(type="text", text="No dialogs found.")]
                
            result = "Telegram Dialogs:\n"
            for d in dialogs:
                result += f"- {d.name} (ID: {d.id})\n"
            return [TextContent(type="text", text=result)]

        elif name == "telegram_read_chat":
            if not await _client.is_user_authorized():
                return [TextContent(type="text", text="Not authorized. Login first.")]
                
            entity = arguments.get("entity")
            limit = arguments.get("limit", 50)
            
            try:
                # convert entity to int if it's purely numeric
                if str(entity).lstrip('-').isdigit():
                    entity = int(entity)
                    
                messages = await _client.get_messages(entity, limit=limit)
                
                if not messages:
                    return [TextContent(type="text", text=f"No messages found for {entity}.")]
                    
                result = f"Recent messages in {entity}:\n\n"
                for m in reversed(messages):
                    sender = "Unknown"
                    if m.sender:
                        sender = m.sender.first_name or m.sender.username or str(m.sender_id)
                    text = m.text or "[Non-text message]"
                    result += f"[{sender}]: {text}\n"
                return [TextContent(type="text", text=result)]
            except ValueError:
                return [TextContent(type="text", text=f"Could not find entity {entity}.")]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]
            
    except Exception as e:
        logger.error(f"Error in {name}: {str(e)}", exc_info=True)
        return [TextContent(type="text", text=f"Error: {str(e)}")]

async def main():
    logger.info("Starting Native Telegram MCP Server...")
    try:
        async with stdio_server() as (read_stream, write_stream):
            await app.run(
                read_stream,
                write_stream,
                app.create_initialization_options()
            )
    finally:
        global _client
        if _client is not None:
            logger.info("Disconnecting Telegram client...")
            try:
                await _client.disconnect()
            except Exception as e:
                logger.error("Error disconnecting client: %s", e)

if __name__ == "__main__":
    asyncio.run(main())
