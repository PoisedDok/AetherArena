"""
Tests for core.integrations.providers.open_interpreter.external_ws_proxy.

Covers:
- _is_ws_open() helper for websockets 14+ and legacy APIs
- ExternalOIWebSocketInterpreter: init, properties, headers
- HTTP methods: set_messages, get_setting, set_custom_instructions, append_custom_instructions
- WebSocket lifecycle: connect, reconnect, auth handshake (1-round and 2-round)
- I/O: input(), output() with auth frames, ack, connection close
- stop() command framing, close()
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from core.integrations.providers.open_interpreter.external_ws_proxy import (
    ExternalOIWebSocketInterpreter,
    _is_ws_open,
    _WsState,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _proxy(ws_url="ws://127.0.0.1:9100/", http_url="http://127.0.0.1:9100", auth="tok"):
    return ExternalOIWebSocketInterpreter(
        ws_url, http_url=http_url, auth_token=auth,
        connect_timeout_seconds=1.0, ping_interval_seconds=5.0,
    )


def _mock_http_response(status=200, json_data=None, text="ok"):
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = json_data or {}
    resp.text = text
    return resp


def _mock_http_client(response=None):
    resp = response or _mock_http_response()
    client = AsyncMock()
    client.get = AsyncMock(return_value=resp)
    client.post = AsyncMock(return_value=resp)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    return client


def _mock_ws():
    ws = AsyncMock()
    ws.send = AsyncMock()
    ws.recv = AsyncMock(return_value='{}')
    ws.close = AsyncMock()
    return ws


# ---------------------------------------------------------------------------
# _is_ws_open
# ---------------------------------------------------------------------------

class TestIsWsOpen:
    def test_none_returns_false(self):
        assert _is_ws_open(None) is False

    def test_ws14_open(self):
        """websockets 14+ with protocol.state == OPEN."""
        if _WsState is None:
            pytest.skip("websockets 14+ not installed")
        ws = MagicMock()
        ws.protocol.state = _WsState.OPEN
        assert _is_ws_open(ws) is True

    def test_ws14_closed(self):
        if _WsState is None:
            pytest.skip("websockets 14+ not installed")
        ws = MagicMock()
        ws.protocol.state = MagicMock()  # Not OPEN
        assert _is_ws_open(ws) is False

    def test_ws14_exception(self):
        if _WsState is None:
            pytest.skip("websockets 14+ not installed")
        ws = MagicMock()
        type(ws.protocol).state = PropertyMock(side_effect=RuntimeError)
        assert _is_ws_open(ws) is False

    def test_legacy_open(self):
        ws = MagicMock(spec=["closed"])
        ws.closed = False
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._WsState", None):
            assert _is_ws_open(ws) is True

    def test_legacy_closed(self):
        ws = MagicMock(spec=["closed"])
        ws.closed = True
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._WsState", None):
            assert _is_ws_open(ws) is False

    def test_legacy_exception(self):
        """Property raises on second access (hasattr succeeds, actual read fails)."""
        _calls = {"n": 0}
        class FlickerWS:
            @property
            def closed(self):
                _calls["n"] += 1
                if _calls["n"] > 1:
                    raise RuntimeError("disconnected")
                return False  # hasattr sees this
        ws = FlickerWS()
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._WsState", None):
            result = _is_ws_open(ws)
        assert result is False  # Exception caught → returns False

    def test_unknown_impl(self):
        ws = MagicMock(spec=[])
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._WsState", None):
            assert _is_ws_open(ws) is True


# ---------------------------------------------------------------------------
# Init / properties / headers
# ---------------------------------------------------------------------------

class TestInit:
    def test_attributes(self):
        p = _proxy()
        assert p._ws_url == "ws://127.0.0.1:9100/"
        assert p._http_url == "http://127.0.0.1:9100"
        assert p._auth_token == "tok"
        assert p._closed is False
        assert p._auth_done is False
        assert p._history_hydrated is False

    def test_no_auth(self):
        p = ExternalOIWebSocketInterpreter("ws://h:1/")
        assert p._auth_token is None
        assert p._http_url is None

    def test_http_url_stripped(self):
        p = ExternalOIWebSocketInterpreter("ws://h:1/", http_url="  http://h:1/  ")
        assert p._http_url == "http://h:1"

    def test_ws_url_property(self):
        assert _proxy().ws_url == "ws://127.0.0.1:9100/"

    def test_http_url_property(self):
        assert _proxy().http_url == "http://127.0.0.1:9100"

    def test_headers_with_auth(self):
        h = _proxy(auth="secret")._http_headers()
        assert h["X-API-KEY"] == "secret"

    def test_headers_no_auth(self):
        p = ExternalOIWebSocketInterpreter("ws://h:1/")
        assert p._http_headers() == {}


# ---------------------------------------------------------------------------
# HTTP methods
# ---------------------------------------------------------------------------

class TestSetMessages:
    @pytest.mark.asyncio
    async def test_success(self):
        p = _proxy()
        client = _mock_http_client()
        with patch("httpx.AsyncClient", return_value=client):
            await p.set_messages([{"role": "user", "content": "hi"}])
        client.post.assert_awaited_once()
        assert p._history_hydrated is True

    @pytest.mark.asyncio
    async def test_no_http_url(self):
        p = ExternalOIWebSocketInterpreter("ws://h:1/")
        with pytest.raises(RuntimeError, match="http_url"):
            await p.set_messages([])

    @pytest.mark.asyncio
    async def test_invalid_messages_type(self):
        p = _proxy()
        with pytest.raises(ValueError, match="list"):
            await p.set_messages("not a list")

    @pytest.mark.asyncio
    async def test_server_rejects(self):
        p = _proxy()
        client = _mock_http_client(_mock_http_response(status=400, text="bad"))
        with patch("httpx.AsyncClient", return_value=client):
            with pytest.raises(RuntimeError, match="rejected"):
                await p.set_messages([])


class TestGetSetting:
    @pytest.mark.asyncio
    async def test_dict_response(self):
        p = _proxy()
        client = _mock_http_client(_mock_http_response(json_data={"model": "gpt"}))
        with patch("httpx.AsyncClient", return_value=client):
            result = await p.get_setting("model")
        assert result == {"model": "gpt"}

    @pytest.mark.asyncio
    async def test_string_response_json(self):
        """Upstream double-encodes: returns JSON string containing JSON."""
        p = _proxy()
        resp = _mock_http_response(json_data='{"model":"gpt"}')
        client = _mock_http_client(resp)
        with patch("httpx.AsyncClient", return_value=client):
            result = await p.get_setting("model")
        assert result == {"model": "gpt"}

    @pytest.mark.asyncio
    async def test_string_response_plain(self):
        p = _proxy()
        resp = _mock_http_response(json_data="plain-value")
        client = _mock_http_client(resp)
        with patch("httpx.AsyncClient", return_value=client):
            result = await p.get_setting("key")
        assert result == {"key": "plain-value"}

    @pytest.mark.asyncio
    async def test_non_dict_non_string(self):
        p = _proxy()
        resp = _mock_http_response(json_data=42)
        client = _mock_http_client(resp)
        with patch("httpx.AsyncClient", return_value=client):
            result = await p.get_setting("num")
        assert result == {"num": 42}

    @pytest.mark.asyncio
    async def test_empty_key_raises(self):
        p = _proxy()
        with pytest.raises(ValueError, match="setting"):
            await p.get_setting("")

    @pytest.mark.asyncio
    async def test_no_http_url(self):
        p = ExternalOIWebSocketInterpreter("ws://h:1/")
        with pytest.raises(RuntimeError, match="http_url"):
            await p.get_setting("x")

    @pytest.mark.asyncio
    async def test_server_error(self):
        p = _proxy()
        client = _mock_http_client(_mock_http_response(status=500, text="err"))
        with patch("httpx.AsyncClient", return_value=client):
            with pytest.raises(RuntimeError, match="rejected"):
                await p.get_setting("x")


class TestSetCustomInstructions:
    @pytest.mark.asyncio
    async def test_success(self):
        p = _proxy()
        client = _mock_http_client()
        with patch("httpx.AsyncClient", return_value=client):
            await p.set_custom_instructions("Be helpful")
        payload = client.post.call_args[1]["json"]
        assert payload["custom_instructions"] == "Be helpful"

    @pytest.mark.asyncio
    async def test_no_http_url(self):
        p = ExternalOIWebSocketInterpreter("ws://h:1/")
        with pytest.raises(RuntimeError, match="http_url"):
            await p.set_custom_instructions("x")

    @pytest.mark.asyncio
    async def test_server_rejects(self):
        p = _proxy()
        client = _mock_http_client(_mock_http_response(status=400))
        with patch("httpx.AsyncClient", return_value=client):
            with pytest.raises(RuntimeError, match="rejected"):
                await p.set_custom_instructions("x")


class TestAppendCustomInstructions:
    @pytest.mark.asyncio
    async def test_appends(self):
        p = _proxy()
        with patch.object(p, "get_setting", new_callable=AsyncMock,
                          return_value={"custom_instructions": "base "}), \
             patch.object(p, "set_custom_instructions", new_callable=AsyncMock) as mock_set:
            await p.append_custom_instructions("extra")
        mock_set.assert_awaited_once_with("base extra")

    @pytest.mark.asyncio
    async def test_empty_appendix_skips(self):
        p = _proxy()
        with patch.object(p, "get_setting", new_callable=AsyncMock) as mock_get:
            await p.append_custom_instructions("   ")
        mock_get.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_marker_duplicate_skips(self):
        p = _proxy()
        with patch.object(p, "get_setting", new_callable=AsyncMock,
                          return_value={"custom_instructions": "base [MARKER] more"}), \
             patch.object(p, "set_custom_instructions", new_callable=AsyncMock) as mock_set:
            await p.append_custom_instructions("extra", marker="[MARKER]")
        mock_set.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_content_duplicate_skips(self):
        p = _proxy()
        with patch.object(p, "get_setting", new_callable=AsyncMock,
                          return_value={"custom_instructions": "base extra more"}), \
             patch.object(p, "set_custom_instructions", new_callable=AsyncMock) as mock_set:
            await p.append_custom_instructions("extra")
        mock_set.assert_not_awaited()


# ---------------------------------------------------------------------------
# WebSocket connection
# ---------------------------------------------------------------------------

class TestEnsureConnected:
    @pytest.mark.asyncio
    async def test_reuses_open_ws(self):
        p = _proxy()
        p._ws = _mock_ws()
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=True):
            await p._ensure_connected()
        # No reconnection

    @pytest.mark.asyncio
    async def test_closed_raises(self):
        p = _proxy()
        p._closed = True
        with pytest.raises(RuntimeError, match="closed"):
            await p._ensure_connected()

    @pytest.mark.asyncio
    async def test_connects_and_auth(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value=json.dumps({"auth": True}))
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=ws)):
            await p._ensure_connected()
        assert p._ws is ws
        assert p._auth_done is True

    @pytest.mark.asyncio
    async def test_auth_two_rounds(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(side_effect=[
            json.dumps({"auth": False}),  # First round: rejected
            json.dumps({"auth": True}),   # Second round: accepted
        ])
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=ws)):
            await p._ensure_connected()
        assert p._auth_done is True

    @pytest.mark.asyncio
    async def test_auth_both_rounds_fail(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(side_effect=[
            json.dumps({"auth": False}),
            json.dumps({"auth": False}),
        ])
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=ws)):
            await p._ensure_connected()
        assert p._auth_done is False

    @pytest.mark.asyncio
    async def test_auth_unexpected_response(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value=json.dumps({"unexpected": True}))
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=ws)):
            await p._ensure_connected()
        assert p._auth_done is False

    @pytest.mark.asyncio
    async def test_auth_timeout(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(side_effect=asyncio.TimeoutError)
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=ws)):
            await p._ensure_connected()
        assert p._auth_done is False

    @pytest.mark.asyncio
    async def test_auth_exception(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(side_effect=RuntimeError("ws error"))
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=ws)):
            await p._ensure_connected()
        assert p._auth_done is False

    @pytest.mark.asyncio
    async def test_no_auth_token(self):
        p = ExternalOIWebSocketInterpreter("ws://h:1/", connect_timeout_seconds=1.0)
        ws = _mock_ws()
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=ws)):
            await p._ensure_connected()
        ws.send.assert_not_awaited()  # No auth handshake

    @pytest.mark.asyncio
    async def test_connect_failure(self):
        p = _proxy()
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", side_effect=ConnectionRefusedError):
            with pytest.raises(RuntimeError, match="Failed to connect"):
                await p._ensure_connected()

    @pytest.mark.asyncio
    async def test_reconnect_closes_old(self):
        p = _proxy()
        old_ws = _mock_ws()
        p._ws = old_ws
        p._auth_done = True
        new_ws = _mock_ws()
        new_ws.recv = AsyncMock(return_value=json.dumps({"auth": True}))
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=new_ws)):
            await p._ensure_connected()
        old_ws.close.assert_awaited_once()
        assert p._ws is new_ws

    @pytest.mark.asyncio
    async def test_under_lock_recheck_returns_early(self):
        """Another coroutine reconnected while we waited for the lock."""
        p = _proxy()
        p._ws = _mock_ws()
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open",
                    side_effect=[False, True]):
            await p._ensure_connected()
        # No reconnect — second check under lock saw the ws is open

    @pytest.mark.asyncio
    async def test_reconnect_old_close_exception(self):
        """old_ws.close() raises during reconnect — swallowed gracefully."""
        p = _proxy()
        old_ws = _mock_ws()
        old_ws.close = AsyncMock(side_effect=ConnectionError("close fail"))
        p._ws = old_ws
        p._auth_done = True
        new_ws = _mock_ws()
        new_ws.recv = AsyncMock(return_value=json.dumps({"auth": True}))
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=new_ws)):
            await p._ensure_connected()
        old_ws.close.assert_awaited_once()
        assert p._ws is new_ws

    @pytest.mark.asyncio
    async def test_auth_recv_bytes(self):
        """recv returns bytes instead of str — should not parse as JSON."""
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value=b'{"auth": true}')
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=False), \
             patch("websockets.connect", new=AsyncMock(return_value=ws)):
            await p._ensure_connected()
        # Bytes: isinstance(raw, str) is False → auth_resp = {}
        assert p._auth_done is False


# ---------------------------------------------------------------------------
# Input / Output
# ---------------------------------------------------------------------------

class TestInput:
    @pytest.mark.asyncio
    async def test_sends_json(self):
        p = _proxy()
        ws = _mock_ws()
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            await p.input({"role": "user", "content": "hi"})
        ws.send.assert_awaited_once()
        sent = json.loads(ws.send.call_args[0][0])
        assert sent["role"] == "user"

    @pytest.mark.asyncio
    async def test_not_connected_raises(self):
        p = _proxy()
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            p._ws = None
            with pytest.raises(RuntimeError, match="not connected"):
                await p.input({"role": "user"})


class TestOutput:
    @pytest.mark.asyncio
    async def test_returns_message(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value=json.dumps({"role": "assistant", "content": "hi"}))
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            msg = await p.output()
        assert msg["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_ack_sent(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value=json.dumps({"role": "assistant", "id": "msg-1"}))
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            await p.output()
        # Ack sent
        ack_call = ws.send.call_args_list[-1]
        ack = json.loads(ack_call[0][0])
        assert ack["ack"] == "msg-1"

    @pytest.mark.asyncio
    async def test_ack_failure_silent(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value=json.dumps({"role": "assistant", "id": "msg-1"}))
        ws.send = AsyncMock(side_effect=RuntimeError("send fail"))
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            msg = await p.output()
        assert msg["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_connection_closed(self):
        import websockets.exceptions
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(side_effect=websockets.exceptions.ConnectionClosed(None, None))
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            msg = await p.output()
        assert msg["_ws_closed"] is True
        assert p._ws is None

    @pytest.mark.asyncio
    async def test_auth_frame_consumed(self):
        """Auth frames are consumed internally, not returned."""
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(side_effect=[
            json.dumps({"auth": True}),  # Auth frame — consumed
            json.dumps({"role": "assistant", "content": "real"}),
        ])
        p._ws = ws
        p._auth_token = "tok"
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            msg = await p.output()
        assert msg["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_auth_false_sends_token(self):
        """Server demands auth during output — sends token."""
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(side_effect=[
            json.dumps({"auth": False}),
            json.dumps({"role": "assistant", "content": "ok"}),
        ])
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            msg = await p.output()
        # Token sent
        sent = json.loads(ws.send.call_args_list[0][0][0])
        assert sent["auth"] == "tok"

    @pytest.mark.asyncio
    async def test_auth_false_no_token_raises(self):
        p = ExternalOIWebSocketInterpreter("ws://h:1/", connect_timeout_seconds=1.0)
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value=json.dumps({"auth": False}))
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="requires auth"):
                await p.output()

    @pytest.mark.asyncio
    async def test_auth_send_failure(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value=json.dumps({"auth": False}))
        ws.send = AsyncMock(side_effect=RuntimeError("send fail"))
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="authenticate"):
                await p.output()

    @pytest.mark.asyncio
    async def test_invalid_json_raises(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value="not-json{{{")
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="Invalid JSON"):
                await p.output()

    @pytest.mark.asyncio
    async def test_non_dict_message_raises(self):
        p = _proxy()
        ws = _mock_ws()
        ws.recv = AsyncMock(return_value=json.dumps([1, 2, 3]))
        p._ws = ws
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="Unexpected message type"):
                await p.output()

    @pytest.mark.asyncio
    async def test_not_connected_raises(self):
        p = _proxy()
        with patch.object(p, "_ensure_connected", new_callable=AsyncMock):
            p._ws = None
            with pytest.raises(RuntimeError, match="not connected"):
                await p.output()


# ---------------------------------------------------------------------------
# Stop / Close
# ---------------------------------------------------------------------------

class TestStop:
    @pytest.mark.asyncio
    async def test_sends_stop_signals(self):
        p = _proxy()
        p._ws = _mock_ws()
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=True):
            await p.stop()
        
        # Verify 4 signals were sent
        assert p._ws.send.call_count == 4
        calls = [json.loads(c[0][0]) for c in p._ws.send.call_args_list]
        assert calls[0] == {"role": "user", "type": "command", "start": True}
        assert calls[1] == {"role": "user", "type": "command", "content": "stop"}
        assert calls[2] == {"role": "user", "type": "command", "end": True}
        assert calls[3] == {"type": "interrupt", "content": "stop"}

    @pytest.mark.asyncio
    async def test_exception_logged(self):
        p = _proxy()
        p._ws = _mock_ws()
        p._ws.send.side_effect = RuntimeError
        with patch("core.integrations.providers.open_interpreter.external_ws_proxy._is_ws_open", return_value=True):
            await p.stop()  # Should not raise


class TestClose:
    @pytest.mark.asyncio
    async def test_closes_ws(self):
        p = _proxy()
        ws = _mock_ws()
        p._ws = ws
        await p.close()
        assert p._closed is True
        assert p._ws is None
        ws.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_double_close(self):
        p = _proxy()
        p._ws = _mock_ws()
        await p.close()
        await p.close()  # Second close is no-op

    @pytest.mark.asyncio
    async def test_close_no_ws(self):
        p = _proxy()
        await p.close()
        assert p._closed is True

    @pytest.mark.asyncio
    async def test_close_exception_swallowed(self):
        p = _proxy()
        ws = _mock_ws()
        ws.close = AsyncMock(side_effect=RuntimeError)
        p._ws = ws
        await p.close()
        assert p._closed is True
