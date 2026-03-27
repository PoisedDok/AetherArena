"""
E2E Tests: Sample Attachments + Vision Paths

Goals:
- Exercise Docling conversion end-to-end using real sample files (pdf/xlsx/pptx/png).
- Exercise chat image ingestion path (image_b64) using the sample PNG.
- Exercise Omni wiring (health + workflows) without relying on screen capture.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

import os
import pytest
import pytest_asyncio
from httpx import AsyncClient

pytestmark = pytest.mark.skipif(
    os.environ.get("SKIP_SERVICE_HEALTH_CHECK") == "1",
    reason="Requires live infrastructure"
)

from config.settings import get_settings
from tests.e2e.helpers.http_wait import wait_for_endpoint


def _repo_root() -> Path:
    # tests/e2e/<file> -> tests -> aether-backend -> AetherArena (repo root)
    return Path(__file__).resolve().parents[3]


def _sample_path(name: str) -> Path:
    path = _repo_root() / "sample" / name
    if not path.exists():
        raise RuntimeError(f"Missing required sample file: {path}")
    return path


@pytest_asyncio.fixture
async def real_client() -> AsyncClient:
    base_url = os.getenv("AETHER_E2E_BASE_URL", "http://127.0.0.1:8765")
    settings = get_settings()
    doc_timeout = getattr(getattr(settings, "websocket", None), "document_processing_timeout", 120.0)
    timeout_seconds = max(120.0, float(doc_timeout))
    async with AsyncClient(base_url=base_url, timeout=timeout_seconds) as client:
        status = await wait_for_endpoint(client, "/v1/health")
        if status != 200:
            pytest.fail(f"Backend not reachable at {base_url}")
        yield client


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_docling_convert_upload_sample_files(real_client: AsyncClient) -> None:
    """
    Convert multiple real sample attachments through Docling, end-to-end.
    """
    samples = [
        "equity_investment_slip-1.pdf",
        "taxpnl-DKH999-2024_2025-Q1-Q4.xlsx",
        "AetherInc_AI_Paralegal_Pitch.pptx",
        "unnamed.png",
    ]

    for name in samples:
        path = _sample_path(name)
        raw = path.read_bytes()
        files = {"file": (path.name, raw, "application/octet-stream")}
        resp = await real_client.post(
            "/v1/execute/convert",
            params={"output_format": "markdown", "pipeline": "standard"},
            files=files,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body.get("success") is True, body
        content = body.get("content") or ""
        assert isinstance(content, str)
        assert len(content.strip()) > 20, f"Docling returned empty content for {name}: {body}"


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.slow
@pytest.mark.asyncio
async def test_chat_with_sample_png_image_b64(real_client: AsyncClient) -> None:
    """
    Ensure the main chat endpoint accepts image_b64 and produces a response.
    This validates the ingestion plumbing even when the active model is not vision-capable.
    """
    png_bytes = _sample_path("unnamed.png").read_bytes()
    image_b64 = base64.b64encode(png_bytes).decode("utf-8")

    payload = {
        "message": "Describe the image briefly.",
        "session_id": "e2e-image-b64",
        "image_b64": image_b64,
        "history": [],
    }
    resp = await real_client.post("/v1/create/chat", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("status") == "ok", body
    assert isinstance(body.get("response"), str)


@pytest.mark.e2e
@pytest.mark.requires_services
@pytest.mark.asyncio
async def test_omni_health_and_workflows(real_client: AsyncClient) -> None:
    """
    Validate Omni is wired and returns workflow metadata.
    This deliberately avoids screenshot capture (can be flaky in headless environments).
    """
    health = await real_client.get("/v1/omni/health")
    assert health.status_code == 200, health.text
    health_body = health.json()
    assert "healthy" in health_body

    workflows = await real_client.get("/v1/omni/workflows")
    assert workflows.status_code == 200, workflows.text
    wf_body = workflows.json()
    assert isinstance(wf_body, dict)

