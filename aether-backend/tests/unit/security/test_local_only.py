import os

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from api.dependencies import require_local_request
from config.settings import get_settings


def _make_request(host: str) -> Request:
    async def _receive():
        return {"type": "http.request"}

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [],
        "client": (host, 12345),
        "server": ("127.0.0.1", 8765),
        "scheme": "http",
    }
    return Request(scope, _receive)


@pytest.mark.unit
def test_require_local_request_allows_loopback():
    settings = get_settings()
    require_local_request(_make_request("127.0.0.1"), settings)
    require_local_request(_make_request("::1"), settings)


@pytest.mark.unit
def test_require_local_request_blocks_non_local():
    settings = get_settings()
    with pytest.raises(HTTPException) as exc:
        require_local_request(_make_request("8.8.8.8"), settings)
    assert exc.value.status_code == 403
    assert exc.value.detail == "Local-only endpoint: access denied"


@pytest.mark.unit
def test_require_local_request_allows_docker_network_ips(monkeypatch):
    """Docker internal network IPs (172.x, 192.168.x, 10.x) must be allowed if AETHER_ALLOW_EXTERNAL_BIND is true."""
    monkeypatch.setenv("AETHER_ALLOW_EXTERNAL_BIND", "true")
    settings = get_settings()
    require_local_request(_make_request("172.18.0.1"), settings)
    require_local_request(_make_request("192.168.1.100"), settings)
    require_local_request(_make_request("10.0.0.5"), settings)

@pytest.mark.unit
def test_require_local_request_blocks_docker_network_ips_by_default(monkeypatch):
    """Docker internal network IPs are allowed by default now for mesh support."""
    monkeypatch.setenv("AETHER_ALLOW_EXTERNAL_BIND", "false")
    settings = get_settings()
    # Now it allows it, so it shouldn't raise
    require_local_request(_make_request("172.18.0.1"), settings)


@pytest.mark.unit
def test_require_local_request_allows_inprocess_clients_in_test_env():
    # conftest sets TESTING=1 and AETHER_ENVIRONMENT=test for unit/integration runs.
    assert os.getenv("TESTING") == "1"
    settings = get_settings()
    require_local_request(_make_request("test"), settings)
    require_local_request(_make_request("testclient"), settings)
    require_local_request(_make_request("testserver"), settings)

