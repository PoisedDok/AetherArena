"""
Unit tests for Document (Docling) endpoints.

- GET /v1/document/health — calls docling_health(), returns 503 if unhealthy
- POST /v1/execute/convert — file upload, base64 encode, process via DoclingService

Tests cover health status, 503 on unhealthy, successful conversion, empty upload 400,
service failure 500, and generic exception 500.

No bugs found during audit.

CI: pytest tests/unit/api/test_document_endpoint.py -m unit --no-cov -q
"""

import io

import pytest
from unittest.mock import AsyncMock, patch


# ===========================================================================
# Health
# ===========================================================================

class TestDoclingHealth:
    """GET /v1/document/health."""

    @pytest.mark.asyncio
    async def test_healthy(self, client):
        """Healthy docling → 200."""
        with patch("api.v1.endpoints.document.docling_health", return_value={"healthy": True}):
            resp = await client.get("/v1/document/health")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_unhealthy_503(self, client):
        """Unhealthy docling → 503."""
        with patch("api.v1.endpoints.document.docling_health",
                    return_value={"healthy": False, "error": "not installed"}):
            resp = await client.get("/v1/document/health")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_status_ok_is_healthy(self, client):
        """Alternative healthy indicator: status='ok' → 200."""
        with patch("api.v1.endpoints.document.docling_health",
                    return_value={"status": "ok"}):
            resp = await client.get("/v1/document/health")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_neither_healthy_nor_ok_503(self, client):
        """No 'healthy' key AND status != 'ok' → 503."""
        with patch("api.v1.endpoints.document.docling_health",
                    return_value={"status": "degraded"}):
            resp = await client.get("/v1/document/health")
        assert resp.status_code == 503


# ===========================================================================
# Convert Upload
# ===========================================================================

class TestConvertUpload:
    """POST /v1/execute/convert."""

    @pytest.mark.asyncio
    async def test_success(self, client):
        """Valid file → 200 with DoclingConvertResponse."""
        mock_svc = AsyncMock()
        mock_svc.process_base64 = AsyncMock(return_value={
            "success": True,
            "content": "# Hello World",
            "format": "markdown",
            "engine_used": "docling",
            "processing_time": 1.5,
            "pages_processed": 1,
        })
        with patch("api.v1.endpoints.document.get_docling_service", return_value=mock_svc):
            resp = await client.post(
                "/v1/execute/convert",
                files={"file": ("test.pdf", io.BytesIO(b"fake pdf content"), "application/pdf")},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["content"] == "# Hello World"
        assert body["format"] == "markdown"
        assert body["engine_used"] == "docling"
        assert body["processing_time"] == 1.5
        assert body["pages_processed"] == 1

    @pytest.mark.asyncio
    async def test_empty_file_400(self, client):
        """Empty upload → 400."""
        resp = await client.post(
            "/v1/execute/convert",
            files={"file": ("empty.pdf", io.BytesIO(b""), "application/pdf")},
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_service_returns_failure_500(self, client):
        """Service returns success=False → 500."""
        mock_svc = AsyncMock()
        mock_svc.process_base64 = AsyncMock(return_value={
            "success": False, "error": "conversion failed"
        })
        with patch("api.v1.endpoints.document.get_docling_service", return_value=mock_svc):
            resp = await client.post(
                "/v1/execute/convert",
                files={"file": ("test.pdf", io.BytesIO(b"content"), "application/pdf")},
            )
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_generic_exception_500(self, client):
        """Generic exception in convert → 500."""
        with patch("api.v1.endpoints.document.get_docling_service",
                    side_effect=RuntimeError("boom")):
            resp = await client.post(
                "/v1/execute/convert",
                files={"file": ("test.pdf", io.BytesIO(b"content"), "application/pdf")},
            )
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_no_file_422(self, client):
        """No file in request → 422."""
        resp = await client.post("/v1/execute/convert")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_custom_output_format_passed(self, client):
        """output_format query param is forwarded to service."""
        mock_svc = AsyncMock()
        mock_svc.process_base64 = AsyncMock(return_value={
            "success": True, "content": "plain text", "format": "text",
        })
        with patch("api.v1.endpoints.document.get_docling_service", return_value=mock_svc):
            resp = await client.post(
                "/v1/execute/convert?output_format=text",
                files={"file": ("test.pdf", io.BytesIO(b"content"), "application/pdf")},
            )
        assert resp.status_code == 200
        mock_svc.process_base64.assert_called_once()
        call_kwargs = mock_svc.process_base64.call_args.kwargs
        assert call_kwargs["output_format"] == "text"

    @pytest.mark.asyncio
    async def test_custom_pipeline_passed(self, client):
        """pipeline query param is forwarded to service."""
        mock_svc = AsyncMock()
        mock_svc.process_base64 = AsyncMock(return_value={"success": True, "content": "ok"})
        with patch("api.v1.endpoints.document.get_docling_service", return_value=mock_svc):
            resp = await client.post(
                "/v1/execute/convert?pipeline=vlm",
                files={"file": ("test.pdf", io.BytesIO(b"content"), "application/pdf")},
            )
        assert resp.status_code == 200
        call_kwargs = mock_svc.process_base64.call_args.kwargs
        assert call_kwargs["pipeline"] == "vlm"

    @pytest.mark.asyncio
    async def test_filename_passed_to_service(self, client):
        """Original filename is forwarded to service."""
        mock_svc = AsyncMock()
        mock_svc.process_base64 = AsyncMock(return_value={"success": True, "content": "ok"})
        with patch("api.v1.endpoints.document.get_docling_service", return_value=mock_svc):
            resp = await client.post(
                "/v1/execute/convert",
                files={"file": ("my_document.docx", io.BytesIO(b"content"), "application/octet-stream")},
            )
        assert resp.status_code == 200
        call_kwargs = mock_svc.process_base64.call_args.kwargs
        assert call_kwargs["filename"] == "my_document.docx"
