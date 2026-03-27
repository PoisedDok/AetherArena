import pytest
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_auth_error_includes_cors_and_security_headers(monkeypatch, test_settings):
    """
    Regression test:
    Auth failures must still include CORS + security headers, and must not bypass
    outer middleware that should apply to all responses.
    """
    import app as app_module

    # Clone settings to avoid mutating session-scoped fixture.
    settings = test_settings.model_copy(deep=True)
    settings.security.auth_enabled = True
    settings.security.api_key_required = True
    settings.security.public_paths = []
    settings.security.allowed_origins = ["http://localhost:3000"]

    monkeypatch.setattr(app_module, "get_settings", lambda: settings)

    app = app_module.create_app()
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/v1/create/chat",
            headers={"Origin": "http://localhost:3000"},
            json={"message": "ping", "session_id": "test"},
        )

    assert response.status_code == 401
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"
    assert "content-security-policy" in {k.lower(): v for k, v in response.headers.items()}

