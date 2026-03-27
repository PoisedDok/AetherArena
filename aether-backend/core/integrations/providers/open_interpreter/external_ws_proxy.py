"""
External Open Interpreter WebSocket Proxy

Purpose:
- Provide an "interpreter-like" object (async `input()` / `output()`) backed by an external
  Open Interpreter server (`interpreter --server`).
- This preserves the existing streaming/tool pipeline (ChatStreamer -> interpreter.input/output)
  while moving Open Interpreter behind a process/network boundary (Option 1 trajectory).

Protocol reference (upstream / external vendor checkout):
- `external-vendors/open-interpreter/docs/server/usage.mdx`

@.architecture
Incoming: core/runtime/streaming.py, core/runtime/interpreter_adapter.py --- {Dict[str, Any] LMC messages, stop signals}
Processing: WebSocket connect, JSON send/recv, optional ack, stop command framing --- {4 jobs: JOB_MANAGE_CONNECTION, JOB_VALIDATE_SCHEMA, JOB_WEBSOCKET_SEND, JOB_WEBSOCKET_RECV}
Outgoing: Open Interpreter external server --- {ws://... messages, Dict[str, Any] events}
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Optional, List

import websockets
import websockets.exceptions
import httpx

logger = logging.getLogger(__name__)

# websockets 14+ uses protocol.State; import it once.
try:
    from websockets.protocol import State as _WsState
except ImportError:
    _WsState = None  # type: ignore[assignment,misc]


def _is_ws_open(ws: Any) -> bool:
    """
    Check if a websockets connection is open.

    websockets 14+ (ClientConnection) exposes ``protocol.state`` instead of the
    legacy ``.closed`` boolean.  This helper handles both API generations safely.
    """
    if ws is None:
        return False
    # websockets 14+: ClientConnection.protocol.state
    if _WsState is not None and hasattr(ws, "protocol"):
        try:
            return ws.protocol.state is _WsState.OPEN
        except Exception:
            return False
    # Legacy websockets < 14: WebSocketClientProtocol.closed
    if hasattr(ws, "closed"):
        try:
            return not ws.closed
        except Exception:
            return False
    # Unknown implementation — assume alive to avoid reconnect storm.
    return True


class ExternalOIWebSocketInterpreter:
    """
    Minimal interpreter proxy that matches the subset of the AsyncInterpreter interface used by Aether:
    - async input(dict)
    - async output() -> dict

    It talks to an Open Interpreter server WebSocket endpoint (`ws://host:port/`).
    """

    def __init__(
        self,
        ws_url: str,
        *,
        http_url: Optional[str] = None,
        auth_token: Optional[str] = None,
        connect_timeout_seconds: float = 5.0,
        ping_interval_seconds: float = 20.0,
    ) -> None:
        self._ws_url = ws_url
        self._http_url = (http_url or "").strip().rstrip("/") or None
        self._auth_token = auth_token.strip() if isinstance(auth_token, str) else None
        self._connect_timeout_seconds = float(connect_timeout_seconds)
        self._ping_interval_seconds = float(ping_interval_seconds)

        self._ws: Optional[Any] = None
        self._send_lock = asyncio.Lock()
        self._recv_lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()  # Serializes reconnection attempts
        self._closed = False
        self._auth_done = False  # True once the full auth handshake (send + ack) completes
        # Aether-owned flag: used to avoid re-hydrating history repeatedly on context resets.
        self._history_hydrated = False

    @property
    def ws_url(self) -> str:
        return self._ws_url

    @property
    def http_url(self) -> Optional[str]:
        return self._http_url

    def _http_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        if self._auth_token:
            # Upstream OI server HTTP middleware uses X-API-KEY (same token as WS auth).
            headers["X-API-KEY"] = self._auth_token
        return headers

    async def get_messages(self) -> List[Dict[str, Any]]:
        """Fetch the full conversation history from the external OI server."""
        data = await self.get_setting("messages")
        messages = data.get("messages")
        if isinstance(messages, list):
            return messages
        return []

    async def set_messages(self, messages: List[Dict[str, Any]]) -> None:
        """
        Set the OI server's conversation messages deterministically via HTTP.

        This is the preferred way to hydrate persisted chat history in external-server mode:
        - Avoids relying on websocket "history replay" semantics.
        - Keeps the external server state consistent with DB-persisted messages.
        """
        if not self._http_url:
            raise RuntimeError("ExternalOIWebSocketInterpreter.http_url is not set; cannot set messages")
        if not isinstance(messages, list):
            raise ValueError("messages must be a list")
        url = f"{self._http_url}/settings"
        payload = {"messages": messages}
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=self._http_headers())
            if resp.status_code >= 400:
                raise RuntimeError(f"External OI server rejected messages ({resp.status_code}): {resp.text}")
        self._history_hydrated = True

    async def get_setting(self, setting: str) -> Dict[str, Any]:
        """
        Fetch a server setting via HTTP.

        NOTE: Upstream currently returns a JSON *string* containing JSON (double-encoded);
        this method normalizes to a dict.
        """
        key = (setting or "").strip()
        if not key:
            raise ValueError("setting is required")
        if not self._http_url:
            raise RuntimeError("ExternalOIWebSocketInterpreter.http_url is not set; cannot query settings")
        url = f"{self._http_url}/settings/{key}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=self._http_headers())
            if resp.status_code >= 400:
                raise RuntimeError(f"External OI server rejected get_setting ({resp.status_code}): {resp.text}")
            data = resp.json()
        if isinstance(data, str):
            try:
                decoded = json.loads(data)
                if isinstance(decoded, dict):
                    return decoded
            except Exception as e:
                logger.debug("Failed to decode setting %s JSON: %s", key, e)
                return {key: data}
        if isinstance(data, dict):
            return data
        return {key: data}

    async def set_custom_instructions(self, custom_instructions: str) -> None:
        if not self._http_url:
            raise RuntimeError("ExternalOIWebSocketInterpreter.http_url is not set; cannot set custom_instructions")
        url = f"{self._http_url}/settings"
        payload = {"custom_instructions": str(custom_instructions or "")}
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=self._http_headers())
            if resp.status_code >= 400:
                raise RuntimeError(f"External OI server rejected custom_instructions ({resp.status_code}): {resp.text}")

    async def append_custom_instructions(self, appendix: str, *, marker: Optional[str] = None) -> None:
        """
        Append content to custom_instructions safely (idempotent by marker or content substring).
        """
        appendix_text = str(appendix or "")
        if not appendix_text.strip():
            return
        current = await self.get_setting("custom_instructions")
        existing = str(current.get("custom_instructions") or "")
        if marker and marker in existing:
            return
        if appendix_text.strip() in existing:
            return
        await self.set_custom_instructions(existing + appendix_text)

    async def _ensure_connected(self) -> None:
        """
        Establish (or reuse) a single WebSocket connection to the OI server.

        CRITICAL: Serialized via ``_connect_lock`` to prevent concurrent reconnections
        from creating duplicate WS connections.  Each zombie WS spawns its own
        ``send_output()`` task on the OI server, competing for the shared output
        queue and stealing chunks from the real client.
        """
        if self._closed:
            raise RuntimeError("ExternalOIWebSocketInterpreter is closed")

        # Fast path (no lock): connection is alive.
        if _is_ws_open(self._ws):
            return

        # Slow path: need to (re)connect — serialize to prevent storm.
        async with self._connect_lock:
            # Re-check under lock (another coroutine may have reconnected while we waited).
            if _is_ws_open(self._ws):
                return

            # Close stale/dead socket handle if any (best effort).
            old_ws = self._ws
            self._ws = None
            self._auth_done = False
            if old_ws is not None:
                try:
                    await old_ws.close()
                except Exception as e:
                    logger.debug("Failed to close old WebSocket: %s", e)
                logger.info("OI WebSocket was closed; reconnecting to %s", self._ws_url)

            try:
                self._ws = await asyncio.wait_for(
                    websockets.connect(
                        self._ws_url,
                        ping_interval=self._ping_interval_seconds,
                    ),
                    timeout=self._connect_timeout_seconds,
                )
                logger.info("Connected to external Open Interpreter server (%s)", self._ws_url)
            except Exception as exc:
                self._ws = None
                raise RuntimeError(
                    f"Failed to connect to external Open Interpreter server: {self._ws_url}"
                ) from exc

            # Complete the auth handshake inline so the WS is ready for chat I/O.
            # OI server sends {"auth": false} immediately on connect when auth is required.
            # We send {"auth": "<token>"}, server replies {"auth": true}, handshake done.
            if self._auth_token:
                try:
                    # 1. Send auth token
                    await self._ws.send(json.dumps({"auth": self._auth_token}))
                    # 2. Consume auth response (blocks until server replies)
                    raw = await asyncio.wait_for(self._ws.recv(), timeout=5.0)
                    auth_resp = json.loads(raw) if isinstance(raw, str) else {}
                    if isinstance(auth_resp, dict) and auth_resp.get("auth") is True:
                        self._auth_done = True
                        logger.debug("OI WebSocket auth handshake completed")
                    elif isinstance(auth_resp, dict) and auth_resp.get("auth") is False:
                        # Server rejected — send token again (some OI versions require two rounds).
                        await self._ws.send(json.dumps({"auth": self._auth_token}))
                        raw2 = await asyncio.wait_for(self._ws.recv(), timeout=5.0)
                        auth_resp2 = json.loads(raw2) if isinstance(raw2, str) else {}
                        if isinstance(auth_resp2, dict) and auth_resp2.get("auth") is True:
                            self._auth_done = True
                            logger.debug("OI WebSocket auth handshake completed (2nd round)")
                        else:
                            logger.warning("OI WebSocket auth failed after 2 rounds: %s", auth_resp2)
                    else:
                        logger.debug("OI WebSocket auth response unexpected: %s", auth_resp)
                except asyncio.TimeoutError:
                    logger.warning("OI WebSocket auth handshake timed out (non-fatal)")
                except Exception as exc:
                    logger.warning("OI WebSocket auth handshake error (non-fatal): %s", exc)

    async def input(self, payload: Dict[str, Any]) -> None:
        await self._ensure_connected()
        if self._ws is None:
            raise RuntimeError("WebSocket not connected")

        data = json.dumps(payload)
        async with self._send_lock:
            await self._ws.send(data)

    async def output(self) -> Dict[str, Any]:
        """
        Read the next message from the OI server.

        Auth handshake frames are consumed internally and never returned to callers.
        """
        await self._ensure_connected()
        if self._ws is None:
            raise RuntimeError("WebSocket not connected")

        # Loop to transparently consume auth/internal frames.
        while True:
            try:
                async with self._recv_lock:
                    raw = await self._ws.recv()
            except websockets.exceptions.ConnectionClosed as cc:
                # OI server closed the connection — normal end-of-response.
                logger.info(
                    "OI WebSocket closed (code=%s, reason=%r) — treating as completion",
                    getattr(cc, "code", "N/A"),
                    getattr(cc, "reason", ""),
                )
                self._ws = None
                return {"role": "server", "type": "completion", "_ws_closed": True}

            try:
                message = json.loads(raw)
                logger.info("RAW OI MSG: %s", raw)
            except Exception as exc:
                raise RuntimeError(
                    f"Invalid JSON from external Open Interpreter server: {raw!r}"
                ) from exc

            if not isinstance(message, dict):
                raise RuntimeError(
                    f"Unexpected message type from external Open Interpreter server: {type(message)}"
                )

            # --- Auth frames: handle internally, never leak to caller ---
            if "auth" in message and not message.get("role"):
                if message.get("auth") is False:
                    # Server demands auth — send token.
                    if not self._auth_token:
                        raise RuntimeError(
                            "External Open Interpreter server requires auth but no token is configured. "
                            "Set INTERPRETER_EXTERNAL_SERVER_AUTH."
                        )
                    try:
                        async with self._send_lock:
                            await self._ws.send(json.dumps({"auth": self._auth_token}))
                    except Exception as exc:
                        raise RuntimeError(
                            f"Failed to authenticate to external OI server: {exc}"
                        ) from exc
                # {"auth": true} or {"auth": false} — consume and read the next frame.
                continue

            # --- Ack (optional reliability) ---
            msg_id = message.get("id")
            if msg_id is not None:
                try:
                    async with self._send_lock:
                        await self._ws.send(json.dumps({"ack": msg_id}))
                except Exception as e:
                    logger.debug("Failed to send ack for msg %s: %s", msg_id, e)

            return message

    async def stop(self) -> None:
        """
        Request the external Open Interpreter server to stop execution.

        Uses the documented command message framing (start/content/end) for maximum compatibility.
        Also sends a raw JSON interrupt signal.
        """
        if not _is_ws_open(self._ws):
            return

        try:
            # 1. Best-effort interrupt signals
            # Use direct send to avoid _ensure_connected() overhead/reconnect
            async with self._send_lock:
                await self._ws.send(json.dumps({"role": "user", "type": "command", "start": True}))
                await self._ws.send(json.dumps({"role": "user", "type": "command", "content": "stop"}))
                await self._ws.send(json.dumps({"role": "user", "type": "command", "end": True}))
                await self._ws.send(json.dumps({"type": "interrupt", "content": "stop"}))
            
            logger.info("Stop signals sent to external OI server")
        except Exception as exc:
            logger.debug("Failed to send stop signals to external OI server: %s", exc)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        ws = self._ws
        self._ws = None
        if ws is None:
            return
        try:
            await ws.close()
        except Exception as e:
            logger.debug("Failed to close WebSocket: %s", e)

