import io

import os
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("SKIP_SERVICE_HEALTH_CHECK") == "1",
    reason="Requires live infrastructure"
)
from PIL import Image, ImageDraw


@pytest.mark.integration
@pytest.mark.asyncio
async def test_docling_convert_upload_failfast(client):
    """
    Fail-fast proof that the in-process Docling pipeline is wired end-to-end via HTTP.

    This replaces legacy /v1/ocr/* tests: Docling is the canonical OCR/conversion path.
    """
    # Generate a tiny image with text; Docling should return a successful conversion response.
    img = Image.new("RGB", (320, 120), "white")
    ImageDraw.Draw(img).text((10, 40), "Test Docling OCR", fill="black")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)

    files = {"file": ("test.png", buf.getvalue(), "image/png")}
    resp = await client.post("/v1/execute/convert?ocr_engine=mac-vision", files=files)
    if resp.status_code != 200:
        resp = await client.post("/v1/execute/convert?ocr_engine=easyocr", files=files)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data.get("success") is True, data
    assert isinstance(data.get("content"), str)
    assert (data.get("content") or "").strip() != "", data
