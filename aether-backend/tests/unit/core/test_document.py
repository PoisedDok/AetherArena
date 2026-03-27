"""
Unit Tests: DocumentProcessor (core/runtime/document.py)

Comprehensive coverage of file processing, type detection, vision model routing,
Docling pipeline integration, file chat, multipart uploads, and health status.

Mock boundaries:
- get_settings() → mock settings
- get_docling_service() → mock Docling service
- httpx.AsyncClient → mock HTTP client (for vision model)
- ConfigManager / RequestTracker → mock dependencies
- interpreter.display_message / interpreter.chat → mock UI
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.runtime.document import DocumentProcessor, _maybe_await


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_settings(
    *,
    base_url: str = "http://127.0.0.1:8765",
    supports_vision: bool = False,
    vision_model: str = "test-vision-model",
    ocr_engine: str = "easyocr",
    ocr_languages: str = "en",
    output_format: str = "markdown",
    enable_code_enrichment: bool = True,
    enable_formula_enrichment: bool = True,
    enable_picture_classification: bool = True,
    enable_picture_description: bool = True,
    max_tokens_llm: int = 4096,
    temperature_llm: float = 0.7,
    max_tokens_vision: int = 20480,
    temperature_vision: float = 0.55,
    image_processing_timeout: float = 120.0,
) -> MagicMock:
    """Create a mock settings object with all fields DocumentProcessor uses."""
    settings = MagicMock()
    settings.base_url = base_url

    # LLM settings
    settings.llm = MagicMock()
    settings.llm.supports_vision = supports_vision
    settings.llm.max_tokens = max_tokens_llm
    settings.llm.temperature = temperature_llm

    # Vision document settings
    settings.vision_document = MagicMock()
    settings.vision_document.provider_config = MagicMock()
    settings.vision_document.ocr_engine = ocr_engine
    settings.vision_document.ocr_languages = ocr_languages
    settings.vision_document.output_format = output_format
    settings.vision_document.enable_code_enrichment = enable_code_enrichment
    settings.vision_document.enable_formula_enrichment = enable_formula_enrichment
    settings.vision_document.enable_picture_classification = enable_picture_classification
    settings.vision_document.enable_picture_description = enable_picture_description
    settings.vision_document.max_tokens = max_tokens_vision
    settings.vision_document.temperature = temperature_vision

    # WebSocket settings (for timeout)
    settings.websocket = MagicMock()
    settings.websocket.image_processing_timeout = image_processing_timeout

    # resolve_service_provider default return
    settings.resolve_service_provider = MagicMock(
        return_value=("http://localhost:7090/v1", vision_model, "not-needed")
    )

    return settings


def _make_docling_service(
    *,
    process_file_result: Dict[str, Any] | None = None,
    process_base64_result: Dict[str, Any] | None = None,
) -> MagicMock:
    """Create a mock Docling service."""
    service = MagicMock()
    if process_file_result is None:
        process_file_result = {
            "success": True,
            "content": "Extracted content from file",
            "format": "markdown",
            "engine_used": "docling-standard",
            "processing_time": 1.23,
            "pages_processed": 3,
        }
    if process_base64_result is None:
        process_base64_result = {
            "success": True,
            "content": "Extracted content from base64",
            "format": "markdown",
            "engine_used": "docling-vlm",
            "processing_time": 0.87,
            "pages_processed": 1,
        }
    service.process_file = AsyncMock(return_value=process_file_result)
    service.process_base64 = AsyncMock(return_value=process_base64_result)
    return service


def _make_processor(
    config_manager: Any = None,
    request_tracker: Any = None,
) -> DocumentProcessor:
    """Create a DocumentProcessor with mocked dependencies."""
    if config_manager is None:
        config_manager = MagicMock()
    if request_tracker is None:
        request_tracker = MagicMock()
        request_tracker.start_request = AsyncMock()
        request_tracker.end_request = AsyncMock()
    return DocumentProcessor(
        config_manager=config_manager,
        request_tracker=request_tracker,
    )


def _make_interpreter() -> MagicMock:
    """Create a mock interpreter with display_message and chat."""
    interp = MagicMock()
    interp.display_message = MagicMock()
    interp.chat = AsyncMock()
    return interp


# ─── Constructor ──────────────────────────────────────────────────────────────


class TestDocumentProcessorInit:
    """Tests for __init__."""

    def test_init_with_explicit_deps(self):
        cm = MagicMock()
        rt = MagicMock()
        dp = DocumentProcessor(config_manager=cm, request_tracker=rt)
        assert dp._config_manager is cm
        assert dp._request_tracker is rt

    def test_init_default_deps_uses_factory(self):
        """Default constructor imports ConfigManager and RequestTracker."""
        mock_cm = MagicMock()
        mock_rt = MagicMock()
        with patch("core.runtime.document.ConfigManager", create=True, return_value=mock_cm), \
             patch("core.runtime.document.RequestTracker", create=True, return_value=mock_rt):
            dp = DocumentProcessor(config_manager=None, request_tracker=None)
        assert dp._config_manager is not None
        assert dp._request_tracker is not None


# ─── _resolve_llm_proxy_url ──────────────────────────────────────────────────


class TestResolveLlmProxyUrl:
    """Tests for _resolve_llm_proxy_url."""

    @patch("core.runtime.document.get_settings")
    def test_happy_path(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="http://127.0.0.1:8765")
        dp = _make_processor()
        url = dp._resolve_llm_proxy_url()
        assert url == "http://127.0.0.1:8765/v1/llm/chat/completions"

    @patch("core.runtime.document.get_settings")
    def test_trailing_slash_stripped(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="http://127.0.0.1:8765/")
        dp = _make_processor()
        url = dp._resolve_llm_proxy_url()
        assert url == "http://127.0.0.1:8765/v1/llm/chat/completions"

    @patch("core.runtime.document.get_settings")
    def test_empty_base_url_raises(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="")
        dp = _make_processor()
        with pytest.raises(RuntimeError, match="settings.base_url is empty"):
            dp._resolve_llm_proxy_url()

    @patch("core.runtime.document.get_settings")
    def test_invalid_url_no_scheme_raises(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="not-a-url")
        dp = _make_processor()
        with pytest.raises(RuntimeError, match="not a valid URL"):
            dp._resolve_llm_proxy_url()

    @patch("core.runtime.document.get_settings")
    def test_non_routable_host_0000_raises(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="http://0.0.0.0:8765")
        dp = _make_processor()
        with pytest.raises(RuntimeError, match="non-routable host"):
            dp._resolve_llm_proxy_url()

    @patch("core.runtime.document.get_settings")
    def test_non_routable_host_ipv6_raises(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="http://[::]:8765")
        dp = _make_processor()
        with pytest.raises(RuntimeError, match="non-routable host"):
            dp._resolve_llm_proxy_url()


# ─── detect_file_type ────────────────────────────────────────────────────────


class TestDetectFileType:
    """Tests for detect_file_type."""

    async def test_pdf_by_extension(self, tmp_path):
        f = tmp_path / "doc.pdf"
        f.write_bytes(b"some data here")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "pdf"

    async def test_pdf_by_signature(self, tmp_path):
        f = tmp_path / "doc.bin"
        f.write_bytes(b"%PDF-1.4 rest of data")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "pdf"

    async def test_image_png(self, tmp_path):
        f = tmp_path / "pic.png"
        f.write_bytes(b"\x89PNG\r\n\x1a\n")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "image"

    async def test_image_jpg(self, tmp_path):
        f = tmp_path / "pic.jpg"
        f.write_bytes(b"\xff\xd8\xff some data")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "image"

    async def test_image_jpeg(self, tmp_path):
        f = tmp_path / "pic.jpeg"
        f.write_bytes(b"data")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "image"

    async def test_image_gif(self, tmp_path):
        f = tmp_path / "pic.gif"
        f.write_bytes(b"GIF89a")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "image"

    async def test_image_bmp(self, tmp_path):
        f = tmp_path / "pic.bmp"
        f.write_bytes(b"BM data")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "image"

    async def test_image_tiff(self, tmp_path):
        f = tmp_path / "pic.tiff"
        f.write_bytes(b"MM data")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "image"

    async def test_text_txt(self, tmp_path):
        f = tmp_path / "readme.txt"
        f.write_bytes(b"hello world")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "text"

    async def test_text_md(self, tmp_path):
        f = tmp_path / "readme.md"
        f.write_bytes(b"# Title")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "text"

    async def test_text_csv(self, tmp_path):
        f = tmp_path / "data.csv"
        f.write_bytes(b"a,b,c")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "text"

    async def test_archive_by_signature(self, tmp_path):
        f = tmp_path / "file.bin"
        f.write_bytes(b"PK\x03\x04" + b"rest")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "archive"

    async def test_archive_by_docx_extension(self, tmp_path):
        f = tmp_path / "doc.docx"
        f.write_bytes(b"some data")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "archive"

    async def test_archive_by_xlsx_extension(self, tmp_path):
        f = tmp_path / "data.xlsx"
        f.write_bytes(b"some data")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "archive"

    async def test_binary_fallback(self, tmp_path):
        f = tmp_path / "unknown.dat"
        f.write_bytes(b"\x00\x01\x02\x03")
        dp = _make_processor()
        assert await dp.detect_file_type(f) == "binary"


# ─── process_file (routing) ──────────────────────────────────────────────────


class TestProcessFile:
    """Tests for process_file routing logic."""

    @patch("core.runtime.document.get_settings")
    async def test_file_input_pdf_routes_to_docling(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings()
        dp = _make_processor()
        f = tmp_path / "test.pdf"
        f.write_bytes(b"%PDF-1.4 content")

        svc = _make_docling_service()
        with patch("core.integrations.providers.docling.get_docling_service", return_value=svc):
            result = await dp.process_file(file_input=f, user_prompt="analyze this")

        assert result["success"] is True
        svc.process_file.assert_awaited_once()

    @patch("core.runtime.document.get_settings")
    async def test_file_input_image_text_only_llm_routes_to_vision(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings(supports_vision=False)
        dp = _make_processor()
        f = tmp_path / "photo.png"
        f.write_bytes(b"\x89PNG\r\n\x1a\n fake image")

        with patch.object(dp, "_process_with_vision_model", new_callable=AsyncMock) as mock_vm:
            mock_vm.return_value = {"success": True, "text": "description"}
            result = await dp.process_file(file_input=f, user_prompt="describe this")

        assert result["success"] is True
        mock_vm.assert_awaited_once()

    @patch("core.runtime.document.get_settings")
    async def test_file_input_image_vision_llm_routes_to_docling(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings(supports_vision=True)
        dp = _make_processor()
        f = tmp_path / "photo.png"
        f.write_bytes(b"\x89PNG\r\n\x1a\n fake image")

        with patch.object(dp, "_process_docling_base64", new_callable=AsyncMock) as mock_db:
            mock_db.return_value = {"success": True, "text": "vlm result"}
            result = await dp.process_file(file_input=f, user_prompt="describe this")

        assert result["success"] is True
        mock_db.assert_awaited_once()

    @patch("core.runtime.document.get_settings")
    async def test_file_input_archive_routes_to_docling(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings()
        dp = _make_processor()
        f = tmp_path / "doc.docx"
        f.write_bytes(b"PK\x03\x04 fake office doc")

        svc = _make_docling_service()
        with patch("core.integrations.providers.docling.get_docling_service", return_value=svc):
            result = await dp.process_file(file_input=f, user_prompt="extract")

        assert result["success"] is True
        svc.process_file.assert_awaited_once()

    async def test_file_input_text_direct_read(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "readme.txt"
        f.write_text("Hello World", encoding="utf-8")

        result = await dp.process_file(file_input=f, user_prompt="summarize")

        assert result["success"] is True
        assert result["type"] == "text"
        assert result["text"] == "Hello World"
        assert result["engine_used"] == "direct_read"
        assert "combined_prompt" in result

    async def test_file_input_not_found_raises(self):
        dp = _make_processor()
        with pytest.raises(FileNotFoundError, match="does not exist"):
            await dp.process_file(file_input=Path("/nonexistent/file.pdf"))

    @patch("core.runtime.document.get_settings")
    async def test_base64_image_text_only_routes_to_vision(self, mock_gs):
        mock_gs.return_value = _make_settings(supports_vision=False)
        dp = _make_processor()

        with patch.object(dp, "_process_with_vision_model", new_callable=AsyncMock) as mock_vm:
            mock_vm.return_value = {"success": True, "text": "vision desc"}
            result = await dp.process_file(
                base64_data="aGVsbG8=",
                filename="photo.jpg",
                user_prompt="describe",
            )

        assert result["success"] is True
        mock_vm.assert_awaited_once()

    @patch("core.runtime.document.get_settings")
    async def test_base64_image_vision_llm_routes_to_docling(self, mock_gs):
        mock_gs.return_value = _make_settings(supports_vision=True)
        dp = _make_processor()

        with patch.object(dp, "_process_docling_base64", new_callable=AsyncMock) as mock_db:
            mock_db.return_value = {"success": True, "text": "docling result"}
            result = await dp.process_file(
                base64_data="aGVsbG8=",
                filename="photo.png",
                user_prompt="describe",
            )

        assert result["success"] is True
        mock_db.assert_awaited_once()

    @patch("core.runtime.document.get_settings")
    async def test_base64_pdf_routes_to_docling(self, mock_gs):
        mock_gs.return_value = _make_settings(supports_vision=False)
        dp = _make_processor()

        with patch.object(dp, "_process_docling_base64", new_callable=AsyncMock) as mock_db:
            mock_db.return_value = {"success": True, "text": "pdf content"}
            result = await dp.process_file(
                base64_data="aGVsbG8=",
                filename="report.pdf",
                user_prompt="extract",
            )

        assert result["success"] is True
        mock_db.assert_awaited_once()

    async def test_no_input_raises_value_error(self):
        dp = _make_processor()
        with pytest.raises(ValueError, match="Either file_input or"):
            await dp.process_file()

    async def test_base64_without_filename_raises(self):
        dp = _make_processor()
        with pytest.raises(ValueError, match="Either file_input or"):
            await dp.process_file(base64_data="aGVsbG8=")


# ─── extract_tables ──────────────────────────────────────────────────────────


class TestExtractTables:
    async def test_returns_empty_list(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.txt"
        f.write_text("data")
        result = await dp.extract_tables(f)
        assert result == []


# ─── _process_with_vision_model ──────────────────────────────────────────────


class TestProcessWithVisionModel:
    """Tests for _process_with_vision_model."""

    @patch("core.runtime.document.get_settings")
    async def test_happy_path(self, mock_gs):
        settings = _make_settings(vision_model="test-vision")
        mock_gs.return_value = settings
        dp = _make_processor()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "A cat sitting on a mat."}}]
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await dp._process_with_vision_model(
                base64_data="aGVsbG8=",
                filename="cat.jpg",
                user_prompt="What is in this image?",
            )

        assert result["success"] is True
        assert result["text"] == "A cat sitting on a mat."
        assert result["format"] == "vision_description"
        assert "vision-test-vision" in result["engine_used"]
        assert "combined_prompt" in result

    @patch("core.runtime.document.get_settings")
    async def test_no_vision_model_resolved(self, mock_gs):
        settings = _make_settings()
        settings.resolve_service_provider.return_value = ("http://localhost:7090/v1", "", "not-needed")
        mock_gs.return_value = settings
        dp = _make_processor()

        result = await dp._process_with_vision_model(
            base64_data="aGVsbG8=",
            filename="img.jpg",
            user_prompt="describe",
        )

        assert result["success"] is False
        assert "error" in result

    @patch("core.runtime.document.get_settings")
    async def test_http_status_error(self, mock_gs):
        import httpx

        settings = _make_settings(vision_model="test-vision")
        mock_gs.return_value = settings
        dp = _make_processor()

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"
        http_err = httpx.HTTPStatusError(
            "Server error", request=MagicMock(), response=mock_response
        )

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=http_err)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await dp._process_with_vision_model(
                base64_data="aGVsbG8=",
                filename="img.jpg",
                user_prompt="",
            )

        assert result["success"] is False
        assert "500" in result["error"]

    @patch("core.runtime.document.get_settings")
    async def test_empty_response_returns_error(self, mock_gs):
        settings = _make_settings(vision_model="test-vision")
        mock_gs.return_value = settings
        dp = _make_processor()

        mock_response = MagicMock()
        mock_response.json.return_value = {"choices": [{"message": {"content": ""}}]}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await dp._process_with_vision_model(
                base64_data="aGVsbG8=",
                filename="img.jpg",
                user_prompt="describe",
            )

        assert result["success"] is False

    @patch("core.runtime.document.get_settings")
    async def test_general_exception_returns_error(self, mock_gs):
        settings = _make_settings(vision_model="test-vision")
        settings.resolve_service_provider.side_effect = RuntimeError("provider down")
        mock_gs.return_value = settings
        dp = _make_processor()

        result = await dp._process_with_vision_model(
            base64_data="aGVsbG8=",
            filename="img.jpg",
            user_prompt="describe",
        )

        assert result["success"] is False

    @patch("core.runtime.document.get_settings")
    async def test_default_prompt_when_empty(self, mock_gs):
        """When user_prompt is empty, default analysis prompt is used."""
        settings = _make_settings(vision_model="test-vision")
        mock_gs.return_value = settings
        dp = _make_processor()

        mock_response = MagicMock()
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "A landscape photo."}}]
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await dp._process_with_vision_model(
                base64_data="aGVsbG8=",
                filename="landscape.jpg",
                user_prompt="",
            )

        assert result["success"] is True
        # Verify the default prompt was used in the payload
        call_args = mock_client.post.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        content_items = payload["messages"][0]["content"]
        text_item = [c for c in content_items if c["type"] == "text"][0]
        assert "Analyze this image in detail" in text_item["text"]

    @patch("core.runtime.document.get_settings")
    async def test_api_key_not_needed_no_auth_header(self, mock_gs):
        """When api_key is 'not-needed', no Authorization header is sent."""
        settings = _make_settings(vision_model="test-vision")
        settings.resolve_service_provider.return_value = (
            "http://localhost:7090/v1", "test-vision", "not-needed"
        )
        mock_gs.return_value = settings
        dp = _make_processor()

        mock_response = MagicMock()
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "result"}}]
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await dp._process_with_vision_model(
                base64_data="aGVsbG8=",
                filename="img.jpg",
                user_prompt="test",
            )

        assert result["success"] is True
        call_args = mock_client.post.call_args
        headers = call_args.kwargs.get("headers") or call_args[1].get("headers")
        assert "Authorization" not in headers

    @patch("core.runtime.document.get_settings")
    async def test_api_key_present_adds_auth_header(self, mock_gs):
        """When api_key is a real key, Authorization header is set."""
        settings = _make_settings(vision_model="test-vision")
        settings.resolve_service_provider.return_value = (
            "http://api.example.com/v1", "test-vision", "sk-real-key-123"
        )
        mock_gs.return_value = settings
        dp = _make_processor()

        mock_response = MagicMock()
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "result"}}]
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await dp._process_with_vision_model(
                base64_data="aGVsbG8=",
                filename="img.jpg",
                user_prompt="test",
            )

        assert result["success"] is True
        call_args = mock_client.post.call_args
        headers = call_args.kwargs.get("headers") or call_args[1].get("headers")
        assert headers["Authorization"] == "Bearer sk-real-key-123"


# ─── _process_docling_filepath ────────────────────────────────────────────────


class TestProcessDoclingFilepath:
    """Tests for _process_docling_filepath."""

    @patch("core.runtime.document.get_settings")
    async def test_happy_path(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings()
        dp = _make_processor()
        f = tmp_path / "test.pdf"
        f.write_bytes(b"%PDF content")

        svc = _make_docling_service()
        with patch("core.integrations.providers.docling.get_docling_service", return_value=svc):
            result = await dp._process_docling_filepath(f, "analyze this")

        assert result["success"] is True
        assert result["text"] == "Extracted content from file"
        assert "combined_prompt" in result
        svc.process_file.assert_awaited_once()

    @patch("core.runtime.document.get_settings")
    async def test_docling_returns_error(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings()
        dp = _make_processor()
        f = tmp_path / "bad.pdf"
        f.write_bytes(b"%PDF corrupted")

        svc = _make_docling_service(
            process_file_result={"success": False, "error": "Corrupt PDF"}
        )
        with patch("core.integrations.providers.docling.get_docling_service", return_value=svc):
            result = await dp._process_docling_filepath(f, "")

        assert result["success"] is False
        assert "Corrupt PDF" in result["error"]

    @patch("core.runtime.document.get_settings")
    async def test_exception_returns_error(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings()
        dp = _make_processor()
        f = tmp_path / "test.pdf"
        f.write_bytes(b"%PDF content")

        with patch("core.integrations.providers.docling.get_docling_service", side_effect=RuntimeError("boom")):
            result = await dp._process_docling_filepath(f, "")

        assert result["success"] is False
        assert "Failed to process file" in result["error"]


# ─── _process_image_filepath ──────────────────────────────────────────────────


class TestProcessImageFilepath:
    """Tests for _process_image_filepath."""

    @patch("core.runtime.document.get_settings")
    async def test_text_only_llm_routes_to_vision_model(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings(supports_vision=False)
        dp = _make_processor()
        f = tmp_path / "photo.png"
        f.write_bytes(b"\x89PNG fake image bytes")

        with patch.object(dp, "_process_with_vision_model", new_callable=AsyncMock) as mock_vm:
            mock_vm.return_value = {"success": True, "text": "cat photo"}
            result = await dp._process_image_filepath(f, "describe")

        assert result["success"] is True
        mock_vm.assert_awaited_once()
        # Verify base64 encoding of file bytes
        call_kwargs = mock_vm.call_args.kwargs
        expected_b64 = base64.b64encode(b"\x89PNG fake image bytes").decode("utf-8")
        assert call_kwargs["base64_data"] == expected_b64

    @patch("core.runtime.document.get_settings")
    async def test_vision_llm_routes_to_docling(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings(supports_vision=True)
        dp = _make_processor()
        f = tmp_path / "photo.png"
        f.write_bytes(b"\x89PNG fake")

        with patch.object(dp, "_process_docling_base64", new_callable=AsyncMock) as mock_db:
            mock_db.return_value = {"success": True, "text": "vlm result"}
            result = await dp._process_image_filepath(f, "describe")

        assert result["success"] is True
        mock_db.assert_awaited_once()

    @patch("core.runtime.document.get_settings")
    async def test_exception_returns_error(self, mock_gs, tmp_path):
        mock_gs.return_value = _make_settings(supports_vision=False)
        dp = _make_processor()
        f = tmp_path / "photo.png"
        # Don't write file → read_bytes will fail
        f.write_bytes(b"data")

        with patch.object(
            dp, "_process_with_vision_model",
            new_callable=AsyncMock,
            side_effect=RuntimeError("vision failed"),
        ):
            result = await dp._process_image_filepath(f, "describe")

        assert result["success"] is False
        assert "Failed to process image" in result["error"]


# ─── _process_docling_base64 ─────────────────────────────────────────────────


class TestProcessDoclingBase64:
    """Tests for _process_docling_base64."""

    @patch("core.runtime.document.get_settings")
    async def test_happy_path(self, mock_gs):
        mock_gs.return_value = _make_settings()
        dp = _make_processor()

        svc = _make_docling_service()
        with patch("core.integrations.providers.docling.get_docling_service", return_value=svc):
            result = await dp._process_docling_base64(
                base64_data="aGVsbG8=",
                filename="doc.pdf",
                user_prompt="summarize",
            )

        assert result["success"] is True
        assert "combined_prompt" in result
        svc.process_base64.assert_awaited_once()

    @patch("core.runtime.document.get_settings")
    async def test_docling_error_result(self, mock_gs):
        mock_gs.return_value = _make_settings()
        dp = _make_processor()

        svc = _make_docling_service(
            process_base64_result={"success": False, "error": "Unsupported format"}
        )
        with patch("core.integrations.providers.docling.get_docling_service", return_value=svc):
            result = await dp._process_docling_base64(
                base64_data="aGVsbG8=",
                filename="weird.xyz",
                user_prompt="",
            )

        assert result["success"] is False
        assert "Unsupported format" in result["error"]

    @patch("core.runtime.document.get_settings")
    async def test_exception_returns_error(self, mock_gs):
        mock_gs.return_value = _make_settings()
        dp = _make_processor()

        with patch("core.integrations.providers.docling.get_docling_service", side_effect=ImportError("no docling")):
            result = await dp._process_docling_base64(
                base64_data="aGVsbG8=",
                filename="doc.pdf",
                user_prompt="",
            )

        assert result["success"] is False
        assert "Failed to process file with Docling" in result["error"]


# ─── _get_pipeline_config ────────────────────────────────────────────────────


class TestGetPipelineConfig:
    """Tests for _get_pipeline_config."""

    @patch("core.runtime.document.get_settings")
    def test_image_file_uses_vlm_pipeline(self, mock_gs):
        mock_gs.return_value = _make_settings()
        dp = _make_processor()

        for ext in [".jpg", ".jpeg", ".png", ".tiff", ".bmp", ".webp"]:
            config = dp._get_pipeline_config(f"image{ext}")
            assert config["pipeline"] == "vlm"

    @patch("core.runtime.document.get_settings")
    def test_non_image_uses_standard_pipeline(self, mock_gs):
        mock_gs.return_value = _make_settings(ocr_engine="tesseract")
        dp = _make_processor()

        for ext in [".pdf", ".docx", ".txt", ".csv"]:
            config = dp._get_pipeline_config(f"file{ext}")
            assert config["pipeline"] == "standard"
            assert config["ocr_engine"] == "tesseract"

    @patch("core.runtime.document.get_settings")
    def test_enrichment_flags_present(self, mock_gs):
        mock_gs.return_value = _make_settings(
            enable_code_enrichment=False,
            enable_formula_enrichment=True,
        )
        dp = _make_processor()

        config = dp._get_pipeline_config("test.pdf")
        assert config["enable_code_enrichment"] is False
        assert config["enable_formula_enrichment"] is True
        assert "enable_picture_classification" in config
        assert "enable_picture_description" in config
        assert "ocr_languages" in config


# ─── _build_api_payload ──────────────────────────────────────────────────────


class TestBuildApiPayload:
    """Tests for _build_api_payload."""

    @patch("core.runtime.document.get_settings")
    def test_builds_correct_payload(self, mock_gs):
        mock_gs.return_value = _make_settings(
            ocr_engine="rapidocr",
            output_format="json",
        )
        dp = _make_processor()

        config = {"pipeline": "standard", "ocr_engine": "rapidocr", "output_format": "json"}
        payload = dp._build_api_payload(config, "analyze this")

        assert payload["pipeline"] == "standard"
        assert payload["ocr_engine"] == "rapidocr"
        assert payload["output_format"] == "json"
        assert "enable_code_enrichment" in payload


# ─── _build_success_response / _build_error_response ─────────────────────────


class TestBuildResponses:
    """Tests for _build_success_response and _build_error_response."""

    def test_success_response(self):
        dp = _make_processor()
        api_result = {
            "content": "Extracted text here",
            "format": "markdown",
            "engine_used": "docling-standard",
            "processing_time": 2.5,
            "pages_processed": 5,
        }
        resp = dp._build_success_response(api_result, "analyze", "report.pdf")

        assert resp["success"] is True
        assert resp["text"] == "Extracted text here"
        assert resp["content"] == "Extracted text here"
        assert resp["format"] == "markdown"
        assert resp["engine_used"] == "docling-standard"
        assert resp["processing_time"] == 2.5
        assert resp["pages_processed"] == 5
        assert "combined_prompt" in resp

    def test_success_response_defaults(self):
        dp = _make_processor()
        api_result = {"content": "text"}
        resp = dp._build_success_response(api_result, "", "file.txt")

        assert resp["format"] == "markdown"  # default
        assert resp["engine_used"] == "docling-api"  # default
        assert resp["processing_time"] == 0  # default
        assert resp["pages_processed"] == 1  # default

    def test_error_response(self):
        dp = _make_processor()
        resp = dp._build_error_response("Something went wrong")

        assert resp["success"] is False
        assert resp["error"] == "Something went wrong"


# ─── _create_combined_prompt ─────────────────────────────────────────────────


class TestCreateCombinedPrompt:
    """Tests for _create_combined_prompt."""

    def test_with_content_and_user_prompt(self):
        dp = _make_processor()
        prompt = dp._create_combined_prompt("extracted text", "summarize this", "doc.pdf")

        assert "File: doc.pdf" in prompt
        assert "Extracted Content:\nextracted text" in prompt
        assert "User Request: summarize this" in prompt
        assert "respond to the user's request" in prompt

    def test_with_content_no_user_prompt(self):
        dp = _make_processor()
        prompt = dp._create_combined_prompt("extracted text", "", "doc.pdf")

        assert "File: doc.pdf" in prompt
        assert "Extracted Content:\nextracted text" in prompt
        assert "provide insights about its content" in prompt
        assert "User Request" not in prompt

    def test_no_content_returns_user_prompt(self):
        dp = _make_processor()
        prompt = dp._create_combined_prompt("", "my question", "doc.pdf")

        assert prompt == "my question"


# ─── process_file_chat ───────────────────────────────────────────────────────


class TestProcessFileChat:
    """Tests for process_file_chat."""

    async def test_happy_path(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        with patch.object(dp, "process_file", new_callable=AsyncMock) as mock_pf:
            mock_pf.return_value = {
                "success": True,
                "content": "extracted",
                "processing_time": 1.0,
                "engine_used": "docling",
                "pages_processed": 2,
                "format": "markdown",
                "combined_prompt": "File: ...",
            }
            result = await dp.process_file_chat(
                file_data={"name": "test.pdf", "base64": "aGVsbG8=", "chat_id": "c1"},
                prompt="summarize",
                request_id="req-1",
                interpreter=interp,
            )

        assert result["status"] == "ok"
        assert result["request_id"] == "req-1"
        rt.start_request.assert_awaited_once()
        rt.end_request.assert_awaited_once_with("req-1")
        # display_message called for: start message + success result messages
        assert interp.display_message.call_count >= 2
        first_msg = interp.display_message.call_args_list[0][0][0]
        assert first_msg["role"] == "computer"
        assert first_msg["request_id"] == "req-1"

    async def test_invalid_file_data_returns_error(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        result = await dp.process_file_chat(
            file_data={"name": "test.pdf"},  # missing base64
            prompt="summarize",
            request_id="req-2",
            interpreter=interp,
        )

        assert result["status"] == "error"
        assert "Invalid file data" in result["message"]
        rt.end_request.assert_awaited_once_with("req-2")

    async def test_no_interpreter_returns_error(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)

        result = await dp.process_file_chat(
            file_data={"name": "test.pdf", "base64": "aGVsbG8="},
            prompt="summarize",
            request_id="req-3",
            interpreter=None,
        )

        assert result["status"] == "error"
        assert "Interpreter not available" in result["message"]
        rt.end_request.assert_awaited_once_with("req-3")

    async def test_processing_error_result(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        with patch.object(dp, "process_file", new_callable=AsyncMock) as mock_pf:
            mock_pf.return_value = {"success": False, "error": "Corrupt file"}
            result = await dp.process_file_chat(
                file_data={"name": "bad.pdf", "base64": "aGVsbG8="},
                prompt="extract",
                request_id="req-4",
                interpreter=interp,
            )

        assert result["status"] == "error"
        assert "Corrupt file" in result["error"]
        rt.end_request.assert_awaited_once_with("req-4")

    async def test_exception_returns_error_and_sends_message(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        with patch.object(dp, "process_file", new_callable=AsyncMock, side_effect=RuntimeError("boom")):
            result = await dp.process_file_chat(
                file_data={"name": "test.pdf", "base64": "aGVsbG8="},
                prompt="extract",
                request_id="req-5",
                interpreter=interp,
            )

        assert result["status"] == "error"
        # error message sent to UI — last call is the generic error (internal details hidden)
        last_msg = interp.display_message.call_args_list[-1][0][0]
        assert last_msg["role"] == "server"
        assert last_msg["type"] == "error"
        assert "File processing failed" in last_msg["message"]
        assert last_msg["request_id"] == "req-5"
        # request tracking always cleaned up
        rt.end_request.assert_awaited_once_with("req-5")

    async def test_auto_generates_request_id(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        with patch.object(dp, "process_file", new_callable=AsyncMock) as mock_pf:
            mock_pf.return_value = {
                "success": True,
                "content": "ok",
                "processing_time": 0,
                "engine_used": "test",
                "pages_processed": 1,
                "format": "text",
                "combined_prompt": "",
            }
            result = await dp.process_file_chat(
                file_data={"name": "t.txt", "base64": "aGVsbG8="},
                prompt="test",
                request_id=None,
                interpreter=interp,
            )

        assert result["status"] == "ok"
        # Request ID was auto-generated (starts with "file_")
        assert result["request_id"].startswith("file_")

    async def test_chat_id_fallback_to_session_id(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        with patch.object(dp, "_validate_file_data", return_value=False):
            await dp.process_file_chat(
                file_data={"name": "x", "base64": "y", "session_id": "s1"},
                prompt="test",
                request_id="r1",
                interpreter=interp,
            )

        # start_request called with session_id as chat_id fallback
        rt.start_request.assert_awaited_once()
        call_kwargs = rt.start_request.call_args.kwargs
        assert call_kwargs.get("chat_id") == "s1"


# ─── process_file_chat_multipart ─────────────────────────────────────────────


class TestProcessFileChatMultipart:
    """Tests for process_file_chat_multipart."""

    async def test_happy_path(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        mock_file = AsyncMock()
        mock_file.read = AsyncMock(return_value=b"file content bytes")

        with patch.object(dp, "process_file", new_callable=AsyncMock) as mock_pf:
            mock_pf.return_value = {
                "success": True,
                "content": "extracted",
                "processing_time": 0.5,
                "engine_used": "docling",
                "pages_processed": 1,
                "format": "markdown",
                "combined_prompt": "combined",
            }
            result = await dp.process_file_chat_multipart(
                file_data={"name": "doc.pdf", "file_object": mock_file, "chat_id": "c1"},
                prompt="analyze",
                request_id="req-m1",
                interpreter=interp,
            )

        assert result["status"] == "ok"
        mock_file.read.assert_awaited_once()
        # process_file called with base64 encoded content
        call_kwargs = mock_pf.call_args.kwargs
        expected_b64 = base64.b64encode(b"file content bytes").decode("utf-8")
        assert call_kwargs["base64_data"] == expected_b64

    async def test_no_file_object_returns_error(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        result = await dp.process_file_chat_multipart(
            file_data={"name": "doc.pdf"},
            prompt="analyze",
            request_id="req-m2",
            interpreter=interp,
        )

        assert result["status"] == "error"
        assert "No file object" in result["message"]
        rt.end_request.assert_awaited_once_with("req-m2")

    async def test_no_interpreter_returns_error(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)

        result = await dp.process_file_chat_multipart(
            file_data={"name": "doc.pdf", "file_object": AsyncMock()},
            prompt="analyze",
            request_id="req-m3",
            interpreter=None,
        )

        assert result["status"] == "error"
        assert "Interpreter not available" in result["message"]

    async def test_processing_error_result(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        mock_file = AsyncMock()
        mock_file.read = AsyncMock(return_value=b"data")

        with patch.object(dp, "process_file", new_callable=AsyncMock) as mock_pf:
            mock_pf.return_value = {"success": False, "error": "Bad format"}
            result = await dp.process_file_chat_multipart(
                file_data={"name": "bad.xyz", "file_object": mock_file},
                prompt="process",
                request_id="req-m4",
                interpreter=interp,
            )

        assert result["status"] == "error"
        assert "Bad format" in result["error"]

    async def test_exception_returns_error(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        mock_file = AsyncMock()
        mock_file.read = AsyncMock(side_effect=IOError("disk error"))

        result = await dp.process_file_chat_multipart(
            file_data={"name": "doc.pdf", "file_object": mock_file},
            prompt="analyze",
            request_id="req-m5",
            interpreter=interp,
        )

        assert result["status"] == "error"
        rt.end_request.assert_awaited_once_with("req-m5")

    async def test_auto_generates_request_id(self):
        rt = MagicMock()
        rt.start_request = AsyncMock()
        rt.end_request = AsyncMock()
        dp = _make_processor(request_tracker=rt)
        interp = _make_interpreter()

        mock_file = AsyncMock()
        mock_file.read = AsyncMock(return_value=b"data")

        with patch.object(dp, "process_file", new_callable=AsyncMock) as mock_pf:
            mock_pf.return_value = {
                "success": True,
                "content": "ok",
                "processing_time": 0,
                "engine_used": "test",
                "pages_processed": 1,
                "format": "text",
                "combined_prompt": "",
            }
            result = await dp.process_file_chat_multipart(
                file_data={"name": "t.txt", "file_object": mock_file},
                prompt="test",
                request_id=None,
                interpreter=interp,
            )

        assert result["status"] == "ok"
        assert result["request_id"].startswith("file-")


# ─── Helper methods ──────────────────────────────────────────────────────────


class TestHelperMethods:
    """Tests for internal helper methods."""

    async def test_read_file_head(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.bin"
        f.write_bytes(b"ABCDEFGHIJKLMNOP")

        head = await dp._read_file_head(f, 8)
        assert head == b"ABCDEFGH"

    async def test_read_file_head_smaller_file(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "small.bin"
        f.write_bytes(b"ABC")

        head = await dp._read_file_head(f, 8)
        assert head == b"ABC"

    async def test_extract_text_utf8(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.txt"
        f.write_text("Hello UTF-8 world", encoding="utf-8")

        text = await dp._extract_text(f)
        assert text == "Hello UTF-8 world"

    async def test_extract_text_unicode_fallback(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.txt"
        # Write bytes that are valid latin-1 but invalid UTF-8
        f.write_bytes(b"Hello \xe9\xe8\xea world")

        text = await dp._extract_text(f)
        assert "Hello" in text
        assert "world" in text

    async def test_extract_image_text_returns_empty(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "img.png"
        f.write_bytes(b"\x89PNG")

        text = await dp._extract_image_text(f)
        assert text == ""

    async def test_extract_tables_returns_empty(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.pdf"
        f.write_bytes(b"data")

        tables = await dp._extract_tables(f)
        assert tables == []

    def test_validate_file_data_valid(self):
        dp = _make_processor()
        assert dp._validate_file_data({"name": "test.pdf", "base64": "aGVsbG8="}) is True

    def test_validate_file_data_missing_name(self):
        dp = _make_processor()
        assert dp._validate_file_data({"base64": "aGVsbG8="}) is False

    def test_validate_file_data_missing_base64(self):
        dp = _make_processor()
        assert dp._validate_file_data({"name": "test.pdf"}) is False

    def test_validate_file_data_empty_name(self):
        dp = _make_processor()
        assert dp._validate_file_data({"name": "", "base64": "aGVsbG8="}) is False

    def test_validate_file_data_empty_base64(self):
        dp = _make_processor()
        assert dp._validate_file_data({"name": "test.pdf", "base64": ""}) is False


# ─── _send_processing_start_message ──────────────────────────────────────────


class TestSendProcessingStartMessage:
    async def test_sends_message(self):
        dp = _make_processor()
        interp = _make_interpreter()

        await dp._send_processing_start_message(interp, "test.pdf", "analyze", "req-1")

        interp.display_message.assert_called_once()
        msg = interp.display_message.call_args[0][0]
        assert msg["role"] == "computer"
        assert "test.pdf" in msg["content"]

    async def test_exception_suppressed(self):
        dp = _make_processor()
        interp = _make_interpreter()
        interp.display_message.side_effect = RuntimeError("ws disconnect")

        # Should not raise
        await dp._send_processing_start_message(interp, "test.pdf", "analyze", "req-1")


# ─── _handle_success_result ──────────────────────────────────────────────────


class TestHandleSuccessResult:
    async def test_happy_path_with_llm_analysis(self):
        dp = _make_processor()
        interp = _make_interpreter()

        result = {
            "content": "Document content here",
            "processing_time": 1.5,
            "engine_used": "docling-standard",
            "pages_processed": 3,
            "format": "markdown",
            "combined_prompt": "File: doc.pdf\n\nContent...",
        }

        resp = await dp._handle_success_result(
            result, "doc.pdf", "summarize this", "req-1", interp
        )

        assert resp["status"] == "ok"
        # 3 display_message calls: code tab, artifacts, chat
        assert interp.display_message.call_count == 3
        # LLM analysis triggered because combined_prompt and prompt both present
        interp.chat.assert_awaited_once()

    async def test_no_llm_analysis_without_prompt(self):
        dp = _make_processor()
        interp = _make_interpreter()

        result = {
            "content": "Content",
            "processing_time": 0.5,
            "engine_used": "docling",
            "pages_processed": 1,
            "format": "text",
            "combined_prompt": "File: ...",
        }

        resp = await dp._handle_success_result(
            result, "file.txt", "", "req-1", interp
        )

        assert resp["status"] == "ok"
        # No LLM analysis because prompt is empty
        interp.chat.assert_not_awaited()

    async def test_no_llm_analysis_without_combined_prompt(self):
        dp = _make_processor()
        interp = _make_interpreter()

        result = {
            "content": "Content",
            "processing_time": 0.5,
            "engine_used": "docling",
            "pages_processed": 1,
            "format": "text",
            "combined_prompt": None,
        }

        resp = await dp._handle_success_result(
            result, "file.txt", "analyze", "req-1", interp
        )

        assert resp["status"] == "ok"
        interp.chat.assert_not_awaited()

    async def test_exception_in_handling(self):
        dp = _make_processor()
        interp = _make_interpreter()
        interp.display_message.side_effect = RuntimeError("ws disconnect")

        result = {
            "content": "Content",
            "processing_time": 0.5,
            "engine_used": "docling",
            "pages_processed": 1,
            "format": "text",
        }

        resp = await dp._handle_success_result(
            result, "file.txt", "analyze", "req-1", interp
        )

        assert resp["status"] == "error"


# ─── _handle_error_result ────────────────────────────────────────────────────


class TestHandleErrorResult:
    async def test_sends_error_message(self):
        dp = _make_processor()
        interp = _make_interpreter()

        result = {"error": "Corrupt PDF"}
        resp = await dp._handle_error_result(result, "bad.pdf", "req-1", interp)

        assert resp["status"] == "error"
        assert resp["error"] == "Corrupt PDF"
        interp.display_message.assert_called_once()
        msg = interp.display_message.call_args[0][0]
        assert msg["type"] == "error"

    async def test_default_error_message(self):
        dp = _make_processor()
        interp = _make_interpreter()

        result = {}  # no error key
        resp = await dp._handle_error_result(result, "bad.pdf", "req-1", interp)

        assert resp["error"] == "Unknown processing error"

    async def test_display_message_exception_suppressed(self):
        dp = _make_processor()
        interp = _make_interpreter()
        interp.display_message.side_effect = RuntimeError("ws disconnect")

        result = {"error": "test error"}
        resp = await dp._handle_error_result(result, "bad.pdf", "req-1", interp)

        # Should still return the error response despite display failure
        assert resp["status"] == "error"


# ─── _analyze_with_llm ──────────────────────────────────────────────────────


class TestAnalyzeWithLlm:
    async def test_happy_path(self):
        dp = _make_processor()
        interp = _make_interpreter()

        await dp._analyze_with_llm(interp, "combined prompt text", "req-1")
        interp.chat.assert_awaited_once_with("combined prompt text", stream=True)

    async def test_chat_exception_sends_error(self):
        dp = _make_processor()
        interp = _make_interpreter()
        interp.chat = AsyncMock(side_effect=RuntimeError("LLM down"))

        # Should not raise
        await dp._analyze_with_llm(interp, "prompt", "req-1")
        # Error message sent
        interp.display_message.assert_called_once()
        msg = interp.display_message.call_args[0][0]
        assert msg["type"] == "error"

    async def test_chat_exception_and_display_exception(self):
        dp = _make_processor()
        interp = _make_interpreter()
        interp.chat = AsyncMock(side_effect=RuntimeError("LLM down"))
        interp.display_message.side_effect = RuntimeError("ws dead")

        # Should not raise even with double exception
        await dp._analyze_with_llm(interp, "prompt", "req-1")


# ─── _send_error_message ────────────────────────────────────────────────────


class TestSendErrorMessage:
    async def test_sends_error(self):
        dp = _make_processor()
        interp = _make_interpreter()

        await dp._send_error_message(interp, "Something failed", "req-1")

        interp.display_message.assert_called_once()
        msg = interp.display_message.call_args[0][0]
        assert msg["role"] == "server"
        assert msg["type"] == "error"
        assert "Something failed" in msg["message"]

    async def test_display_exception_suppressed(self):
        dp = _make_processor()
        interp = _make_interpreter()
        interp.display_message.side_effect = RuntimeError("client disconnected")

        # Should not raise
        await dp._send_error_message(interp, "error", "req-1")


# ─── _create_error_response ─────────────────────────────────────────────────


class TestCreateErrorResponse:
    def test_structure(self):
        dp = _make_processor()
        resp = dp._create_error_response("Bad input", "req-123")

        assert resp["status"] == "error"
        assert resp["message"] == "Bad input"
        assert resp["request_id"] == "req-123"


# ─── get_health_status ───────────────────────────────────────────────────────


class TestGetHealthStatus:
    def test_healthy(self):
        dp = _make_processor()

        mock_health = {"status": "healthy", "converters_loaded": True}
        with patch("core.runtime.document.docling_health", create=True) as mock_fn:
            # The import is inside the method, so we need to patch at module level
            pass

        # Patch the import inside get_health_status
        with patch.dict(
            "sys.modules",
            {"core.integrations.providers.docling": MagicMock(
                docling_health=MagicMock(return_value={"status": "healthy"})
            )},
        ):
            result = dp.get_health_status()

        assert result["docling"]["status"] == "healthy"
        assert result["config_manager_available"] is True
        assert result["request_tracker_available"] is True

    def test_docling_health_exception(self):
        dp = _make_processor()

        with patch.dict(
            "sys.modules",
            {"core.integrations.providers.docling": MagicMock(
                docling_health=MagicMock(side_effect=RuntimeError("docling down"))
            )},
        ):
            result = dp.get_health_status()

        assert result["docling"]["status"] == "error"
        assert result["config_manager_available"] is True

    def test_none_dependencies(self):
        dp = DocumentProcessor(config_manager=None, request_tracker=None)
        # config_manager will be auto-created by __init__, so let's set to None after
        dp._config_manager = None
        dp._request_tracker = None

        with patch.dict(
            "sys.modules",
            {"core.integrations.providers.docling": MagicMock(
                docling_health=MagicMock(return_value={"status": "healthy"})
            )},
        ):
            result = dp.get_health_status()

        assert result["config_manager_available"] is False
        assert result["request_tracker_available"] is False


# ─── _extract_pdf_text (fallback) ────────────────────────────────────────────


class TestExtractPdfText:
    """Tests for the fallback PDF text extraction."""

    async def test_pymupdf_available_and_works(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.pdf"
        f.write_bytes(b"%PDF-1.4")

        mock_page = MagicMock()
        mock_page.get_text.return_value = "Page 1 text"
        mock_doc = MagicMock()
        mock_doc.__iter__ = MagicMock(return_value=iter([mock_page]))
        mock_doc.close = MagicMock()

        mock_fitz = MagicMock()
        mock_fitz.open.return_value = mock_doc

        with patch.dict("sys.modules", {"fitz": mock_fitz}):
            text = await dp._extract_pdf_text(f)

        assert text == "Page 1 text"
        mock_doc.close.assert_called_once()

    async def test_pymupdf_import_error_falls_to_pdfplumber(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.pdf"
        f.write_bytes(b"%PDF-1.4")

        # Remove fitz from modules to simulate ImportError
        import sys
        saved = sys.modules.get("fitz")
        sys.modules["fitz"] = None  # Forces ImportError on import

        mock_page = MagicMock()
        mock_page.extract_text.return_value = "Plumber page 1"
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__ = MagicMock(return_value=mock_pdf)
        mock_pdf.__exit__ = MagicMock(return_value=False)

        mock_pdfplumber = MagicMock()
        mock_pdfplumber.open.return_value = mock_pdf

        try:
            with patch.dict("sys.modules", {"fitz": None, "pdfplumber": mock_pdfplumber}):
                text = await dp._extract_pdf_text(f)
        finally:
            if saved is not None:
                sys.modules["fitz"] = saved
            elif "fitz" in sys.modules:
                del sys.modules["fitz"]

        assert "Plumber page 1" in text

    async def test_both_unavailable_returns_empty(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.pdf"
        f.write_bytes(b"%PDF-1.4")

        with patch.dict("sys.modules", {"fitz": None, "pdfplumber": None}):
            text = await dp._extract_pdf_text(f)

        assert text == ""

    async def test_pymupdf_runtime_error_falls_through(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.pdf"
        f.write_bytes(b"%PDF-1.4")

        mock_fitz = MagicMock()
        mock_fitz.open.side_effect = RuntimeError("corrupt")

        with patch.dict("sys.modules", {"fitz": mock_fitz, "pdfplumber": None}):
            text = await dp._extract_pdf_text(f)

        assert text == ""

    async def test_pdfplumber_runtime_error_falls_through(self, tmp_path):
        dp = _make_processor()
        f = tmp_path / "test.pdf"
        f.write_bytes(b"%PDF-1.4")

        # fitz ImportError, pdfplumber RuntimeError
        mock_pdfplumber = MagicMock()
        mock_pdfplumber.open.side_effect = RuntimeError("corrupt pdf")

        with patch.dict("sys.modules", {"fitz": None, "pdfplumber": mock_pdfplumber}):
            text = await dp._extract_pdf_text(f)

        assert text == ""


# ─── _maybe_await (module-level function) ────────────────────────────────────


class TestMaybeAwait:
    """Tests for the module-level _maybe_await helper."""

    async def test_awaitable_value(self):
        async def coro():
            return "async result"

        result = await _maybe_await(coro())
        assert result == "async result"

    async def test_non_awaitable_value(self):
        result = await _maybe_await("sync result")
        assert result == "sync result"

    async def test_none_value(self):
        result = await _maybe_await(None)
        assert result is None

    async def test_integer_value(self):
        result = await _maybe_await(42)
        assert result == 42
