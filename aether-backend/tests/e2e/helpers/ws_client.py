"""
WebSocket E2E Test Helpers

Provides a small WebSocket client wrapper for real-local E2E tests.
"""

import asyncio
import json
from typing import Callable, Optional


class WsTestClient:
    def __init__(self, url: str, timeout: float = 5.0):
        self.url = url
        self.timeout = timeout
        self._ws = None

    async def __aenter__(self) -> "WsTestClient":
        self._ws = await self._connect()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def _connect(self):
        try:
            import websockets
        except Exception as exc:
            raise RuntimeError("websockets library required for WS E2E tests") from exc
        return await websockets.connect(self.url)

    async def close(self) -> None:
        if self._ws:
            await self._ws.close()
            self._ws = None

    async def send_json(self, payload: dict) -> None:
        if not self._ws:
            raise RuntimeError("WebSocket not connected")
        await self._ws.send(json.dumps(payload))

    async def recv_json(self, timeout: Optional[float] = None) -> dict:
        if not self._ws:
            raise RuntimeError("WebSocket not connected")
        wait_for = timeout or self.timeout
        message = await asyncio.wait_for(self._ws.recv(), timeout=wait_for)
        return json.loads(message)

    async def recv_until(
        self,
        predicate: Callable[[dict], bool],
        timeout: float = 10.0,
    ) -> dict:
        """
        Receive messages until predicate returns True or timeout.
        """
        end_time = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = end_time - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise TimeoutError("Timed out waiting for WebSocket event")
            payload = await self.recv_json(timeout=remaining)
            if predicate(payload):
                return payload


def build_ws_url(base_url: str) -> str:
    if base_url.startswith("https://"):
        return base_url.replace("https://", "wss://", 1)
    if base_url.startswith("http://"):
        return base_url.replace("http://", "ws://", 1)
    return f"ws://{base_url.lstrip('/')}"
