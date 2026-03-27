import json

import pytest

from core.integrations.providers.open_interpreter.external_ws_proxy import ExternalOIWebSocketInterpreter


class _FakeWS:
    def __init__(self, incoming):
        self._incoming = list(incoming)
        self.sent = []

    async def send(self, data: str):
        self.sent.append(data)

    async def recv(self):
        if not self._incoming:
            raise RuntimeError("No more messages")
        return self._incoming.pop(0)

    async def close(self):
        return


@pytest.mark.unit
@pytest.mark.asyncio
async def test_external_oi_auth_handshake_sends_auth_when_prompted(monkeypatch):
    # _ensure_connected() auth flow:
    #   1. Sends {"auth": "<token>"} immediately
    #   2. Receives {"auth": false} → enters two-round branch
    #   3. Sends {"auth": "<token>"} again
    #   4. Receives {"auth": true} → handshake complete
    # Then output() reads the next frame (a normal chat message).
    fake = _FakeWS([
        json.dumps({"auth": False}),   # consumed by _ensure_connected (1st recv)
        json.dumps({"auth": True}),    # consumed by _ensure_connected (2nd recv)
        json.dumps({"role": "assistant", "type": "message", "content": "Hello"}),
    ])

    async def _fake_connect(*args, **kwargs):
        return fake

    monkeypatch.setattr("core.integrations.providers.open_interpreter.external_ws_proxy.websockets.connect", _fake_connect)

    interp = ExternalOIWebSocketInterpreter("ws://127.0.0.1:8000/", auth_token="dummy-api-key")
    msg = await interp.output()
    # Auth frames are consumed internally; output() returns the chat message
    assert msg.get("role") == "assistant"

    sent = [json.loads(x) for x in fake.sent]
    assert {"auth": "dummy-api-key"} in sent


@pytest.mark.unit
@pytest.mark.asyncio
async def test_external_oi_auth_handshake_fails_fast_without_token(monkeypatch):
    fake = _FakeWS([json.dumps({"auth": False})])

    async def _fake_connect(*args, **kwargs):
        return fake

    monkeypatch.setattr("core.integrations.providers.open_interpreter.external_ws_proxy.websockets.connect", _fake_connect)

    interp = ExternalOIWebSocketInterpreter("ws://127.0.0.1:8000/")
    with pytest.raises(RuntimeError, match="requires auth"):
        await interp.output()

