#!/usr/bin/env python3
"""
@.architecture
Incoming: MCP protocol (stdin), Open Interpreter tool calls --- {MCP requests, JSON-RPC}
Processing: connect to WhatsApp Web via Selenium, expose read tools --- {JOB_BROWSER_AUTOMATION, JOB_SEARCH}
Outgoing: MCP protocol (stdout), WhatsApp Web DOM --- {MCP responses, DOM interactions}
"""

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whatsapp_mcp_server")

app = Server("whatsapp-mcp")

# Global reference to hold browser during session
_driver: webdriver.Chrome = None

def get_driver() -> webdriver.Chrome:
    global _driver
    if _driver is not None:
        try:
            _driver.title
            return _driver
        except Exception:
            _driver = None
            
    options = Options()
    options.add_argument("--headless")
    options.add_argument("--headless=new")
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--window-size=1920,1080") # CRITICAL: WhatsApp Web fails to render QR if window is too small
    options.add_argument("user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    
    # Store session data so login persists
    session_dir = Path(os.environ.get("AETHER_BACKEND_ROOT", ".")) / "data" / "daemons" / "messaging" / "whatsapp_profile"
    session_dir.mkdir(parents=True, exist_ok=True)
    options.add_argument(f"user-data-dir={session_dir}")
    
    _driver = webdriver.Chrome(options=options)
    _driver.get("https://web.whatsapp.com")
    return _driver

@app.list_tools()
async def list_tools() -> List[Tool]:
    """List available WhatsApp tools."""
    return [
        Tool(
            name="whatsapp_check_auth",
            description="Check if WhatsApp is authenticated or needs a QR code scan.",
            inputSchema={"type": "object", "properties": {}}
        ),
        Tool(
            name="whatsapp_get_qr",
            description="Get the current login QR code text data if not authenticated.",
            inputSchema={"type": "object", "properties": {}}
        ),
        Tool(
            name="whatsapp_list_chats",
            description="List recent chats/contacts from the sidebar.",
            inputSchema={"type": "object", "properties": {}}
        ),
        Tool(
            name="whatsapp_read_chat",
            description="Read recent messages from a specific chat by contact/group name.",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_name": {"type": "string", "description": "Exact name of the contact or group"},
                    "limit": {"type": "integer", "description": "Maximum number of messages to retrieve", "default": 20}
                },
                "required": ["chat_name"]
            }
        )
    ]

@app.call_tool()
async def call_tool(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
    """Execute WhatsApp tools."""
    try:
        driver = get_driver()
        
        if name == "whatsapp_check_auth":
            try:
                # Fast path: check if QR is already visible
                driver.find_element(By.CSS_SELECTOR, "canvas[aria-label*='Scan']")
                return [TextContent(type="text", text="Not authenticated. Waiting for QR code scan.")]
            except NoSuchElementException:
                pass
                
            try:
                # Check if QR expired and needs reloading
                reload_btn = driver.find_element(By.CSS_SELECTOR, "span[data-icon='refresh'], span[data-testid='refresh'], span[data-testid='refresh-large']")
                # Find the clickable parent if needed, or click the span
                try:
                    reload_btn.click()
                except Exception:
                    # Sometimes the button is the parent
                    parent = reload_btn.find_element(By.XPATH, "..")
                    parent.click()
                time.sleep(2)  # Wait for new QR to render
                return [TextContent(type="text", text="Not authenticated. Waiting for QR code scan.")]
            except NoSuchElementException:
                pass

            try:
                # Wait for the chat list to appear
                WebDriverWait(driver, 5).until(EC.presence_of_element_located((By.ID, "pane-side")))
                return [TextContent(type="text", text="Authenticated successfully. Chat list is visible.")]
            except TimeoutException:
                return [TextContent(type="text", text="Loading WhatsApp Web... try again in a few seconds.")]

        elif name == "whatsapp_get_qr":
            try:
                # First check if we need to reload the QR code
                try:
                    reload_btn = driver.find_element(By.CSS_SELECTOR, "span[data-icon='refresh'], span[data-testid='refresh'], span[data-testid='refresh-large']")
                    try:
                        reload_btn.click()
                    except Exception:
                        parent = reload_btn.find_element(By.XPATH, "..")
                        parent.click()
                    time.sleep(2)
                except NoSuchElementException:
                    pass

                qr_canvas = WebDriverWait(driver, 5).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, "canvas[aria-label*='Scan']"))
                )
                qr_data = driver.execute_script("return arguments[0].toDataURL('image/png');", qr_canvas)
                # Return the full base64 string so the frontend/agent can render it
                return [TextContent(type="text", text=f"QR_CODE_DATA:{qr_data}")]
            except TimeoutException:
                # Check if it's actually logged in or just still loading
                try:
                    driver.find_element(By.ID, "pane-side")
                    return [TextContent(type="text", text="No QR code needed. You are already logged in.")]
                except NoSuchElementException:
                    return [TextContent(type="text", text="Loading WhatsApp Web... please try again in a few seconds.")]

        elif name == "whatsapp_list_chats":
            try:
                WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.ID, "pane-side")))
                chat_elements = driver.find_elements(By.CSS_SELECTOR, "#pane-side span[title]")
                
                chats = []
                for el in chat_elements[:20]:  # Limit to top 20
                    title = el.get_attribute("title")
                    if title and title not in chats:
                        chats.append(title)
                        
                result = "Recent WhatsApp Chats:\n" + "\n".join(f"- {c}" for c in chats)
                return [TextContent(type="text", text=result)]
            except TimeoutException:
                return [TextContent(type="text", text="Could not load chat list. Are you authenticated?")]

        elif name == "whatsapp_read_chat":
            chat_name = arguments.get("chat_name")
            limit = arguments.get("limit", 20)
            
            try:
                WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.ID, "pane-side")))
                # Click the chat in the sidebar
                xpath = f"//span[@title='{chat_name}']"
                chat_el = driver.find_element(By.XPATH, xpath)
                chat_el.click()
                
                # Wait for messages to load
                time.sleep(2)
                
                msg_elements = driver.find_elements(By.CSS_SELECTOR, "div.message-in, div.message-out")
                
                if not msg_elements:
                    return [TextContent(type="text", text=f"No messages found in chat '{chat_name}'.")]
                    
                result = f"Recent messages with {chat_name}:\n\n"
                
                for el in msg_elements[-limit:]:
                    # basic classification: in vs out
                    is_out = "message-out" in el.get_attribute("class")
                    sender = "You" if is_out else chat_name
                    
                    try:
                        text_el = el.find_element(By.CSS_SELECTOR, "span.selectable-text")
                        text = text_el.text
                        result += f"[{sender}]: {text}\n"
                    except NoSuchElementException:
                        result += f"[{sender}]: [Non-text message / Media]\n"
                        
                return [TextContent(type="text", text=result)]
                
            except TimeoutException:
                return [TextContent(type="text", text="Timed out waiting for WhatsApp UI.")]
            except NoSuchElementException:
                return [TextContent(type="text", text=f"Could not find chat named '{chat_name}' in the recent list.")]

        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]
            
    except Exception as e:
        logger.error(f"Error in {name}: {str(e)}", exc_info=True)
        return [TextContent(type="text", text=f"Error: {str(e)}")]

async def main():
    logger.info("Starting Native WhatsApp MCP Server...")
    try:
        async with stdio_server() as (read_stream, write_stream):
            await app.run(
                read_stream,
                write_stream,
                app.create_initialization_options()
            )
    finally:
        global _driver
        if _driver is not None:
            logger.info("Closing WhatsApp Selenium driver...")
            try:
                _driver.quit()
            except Exception as e:
                logger.error("Error closing driver: %s", e)

if __name__ == "__main__":
    asyncio.run(main())
