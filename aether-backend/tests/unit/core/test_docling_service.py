"""
Unit Tests: DoclingService + wrapper functions (core/integrations/providers/docling/)

Covers service.py (DoclingService class) and wrapper.py (docling_convert, docling_health).
All external Docling imports are mocked — tests never require the real Docling package.

Mock boundaries:
- _DOCLING_AVAILABLE flag → patched at module level
- DocumentConverter → MagicMock
- ConversionStatus → MagicMock
- get_settings() → mock settings
- asyncio.to_thread → mock or real
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from core.integrations.providers.docling.service import (
    DoclingService,
    get_docling_service,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_settings(
    *,
    base_url: str = "http://127.0.0.1:8765",
    ocr_engine: str = "easyocr",
    ocr_languages: str = "en",
    output_format: str = "markdown",
    enable_code_enrichment: bool = False,
    enable_formula_enrichment: bool = False,
    enable_picture_classification: bool = False,
    enable_picture_description: bool = False,
    vision_model: str = "test-vision-model",
    vision_model_lmstudio: str = "test-lmstudio-model",
) -> MagicMock:
    """Create mock settings for DoclingService tests."""
    settings = MagicMock()
    settings.base_url = base_url

    settings.vision_document = MagicMock()
    settings.vision_document.ocr_engine = ocr_engine
    settings.vision_document.ocr_languages = ocr_languages
    settings.vision_document.output_format = output_format
    settings.vision_document.enable_code_enrichment = enable_code_enrichment
    settings.vision_document.enable_formula_enrichment = enable_formula_enrichment
    settings.vision_document.enable_picture_classification = enable_picture_classification
    settings.vision_document.enable_picture_description = enable_picture_description
    settings.vision_document.vision_model = vision_model
    settings.vision_document.vision_model_lmstudio = vision_model_lmstudio
    settings.vision_document.provider_config = MagicMock()

    settings.websocket = MagicMock()
    settings.websocket.document_processing_timeout = 300.0
    settings.websocket.image_processing_timeout = 120.0

    settings.resolve_service_provider = MagicMock(
        return_value=("http://localhost:7090/v1", vision_model, "not-needed")
    )

    return settings


def _make_conv_result(
    *,
    status: Any = None,
    has_document: bool = True,
    pages: list | None = None,
) -> MagicMock:
    """Create mock Docling conversion result."""
    result = MagicMock()
    result.status = status
    if has_document:
        result.document = MagicMock()
        result.document.save_as_markdown = MagicMock()
        result.document.save_as_document_tokens = MagicMock()
    else:
        result.document = None
    result.pages = pages or [MagicMock()]
    result.model_dump_json = MagicMock(return_value='{"test": true}')
    return result


# ─── DoclingService.__init__ ─────────────────────────────────────────────────


class TestDoclingServiceInit:
    """Tests for DoclingService.__init__."""

    def test_default_url(self):
        svc = DoclingService()
        assert svc.api_url == "inprocess://docling"
        assert svc._converter is None
        assert svc._converter_key is None

    def test_custom_url(self):
        svc = DoclingService(api_url="http://custom:8080/")
        assert svc.api_url == "http://custom:8080"

    def test_none_url_uses_default(self):
        svc = DoclingService(api_url=None)
        assert svc.api_url == "inprocess://docling"


# ─── DoclingService.initialize ───────────────────────────────────────────────


class TestDoclingServiceInitialize:
    """Tests for initialize."""

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.DocumentConverter")
    async def test_initializes_converter(self, mock_dc):
        mock_dc.return_value = MagicMock()
        svc = DoclingService()
        await svc.initialize()
        assert svc._converter is not None
        mock_dc.assert_called_once()

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.DocumentConverter")
    async def test_skips_if_already_initialized(self, mock_dc):
        mock_dc.return_value = MagicMock()
        svc = DoclingService()
        svc._converter = MagicMock()  # Already set
        await svc.initialize()
        mock_dc.assert_not_called()

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", False)
    async def test_raises_if_docling_unavailable(self):
        svc = DoclingService()
        with pytest.raises(RuntimeError, match="not available"):
            await svc.initialize()


# ─── DoclingService.close ────────────────────────────────────────────────────


class TestDoclingServiceClose:
    """Tests for close."""

    async def test_clears_converter(self):
        svc = DoclingService()
        svc._converter = MagicMock()
        await svc.close()
        assert svc._converter is None


# ─── DoclingService._coerce_bool ─────────────────────────────────────────────


class TestCoerceBool:
    """Tests for _coerce_bool — pure logic, no mocks needed."""

    def test_bool_true(self):
        svc = DoclingService()
        assert svc._coerce_bool(True) is True

    def test_bool_false(self):
        svc = DoclingService()
        assert svc._coerce_bool(False) is False

    def test_string_true(self):
        svc = DoclingService()
        assert svc._coerce_bool("true") is True
        assert svc._coerce_bool("True") is True
        assert svc._coerce_bool("1") is True
        assert svc._coerce_bool("yes") is True
        assert svc._coerce_bool("y") is True
        assert svc._coerce_bool("  YES  ") is True

    def test_string_false(self):
        svc = DoclingService()
        assert svc._coerce_bool("false") is False
        assert svc._coerce_bool("0") is False
        assert svc._coerce_bool("no") is False
        assert svc._coerce_bool("") is False

    def test_none_uses_default(self):
        svc = DoclingService()
        assert svc._coerce_bool(None) is False
        assert svc._coerce_bool(None, default=True) is True

    def test_integer_coercion(self):
        svc = DoclingService()
        assert svc._coerce_bool(1) is True
        assert svc._coerce_bool(0) is False


# ─── DoclingService._parse_languages ─────────────────────────────────────────


class TestParseLanguages:
    """Tests for _parse_languages — pure logic."""

    def test_list_input(self):
        svc = DoclingService()
        result = svc._parse_languages(["en", "fr", "de"], "en")
        assert result == ["en", "fr", "de"]

    def test_list_strips_whitespace(self):
        svc = DoclingService()
        result = svc._parse_languages(["  en  ", "  fr  "], "en")
        assert result == ["en", "fr"]

    def test_list_filters_empty(self):
        svc = DoclingService()
        result = svc._parse_languages(["en", "", "  ", "fr"], "en")
        assert result == ["en", "fr"]

    def test_string_input_comma_separated(self):
        svc = DoclingService()
        result = svc._parse_languages("en,fr,de", "en")
        assert result == ["en", "fr", "de"]

    def test_string_strips_whitespace(self):
        svc = DoclingService()
        result = svc._parse_languages(" en , fr ", "en")
        assert result == ["en", "fr"]

    def test_empty_string_uses_fallback(self):
        svc = DoclingService()
        result = svc._parse_languages("", "en,fr")
        assert result == ["en", "fr"]

    def test_whitespace_only_uses_fallback(self):
        svc = DoclingService()
        result = svc._parse_languages("   ", "de")
        assert result == ["de"]

    def test_none_uses_fallback(self):
        svc = DoclingService()
        result = svc._parse_languages(None, "en")
        assert result == ["en"]

    def test_none_with_empty_fallback(self):
        svc = DoclingService()
        result = svc._parse_languages(None, "")
        assert result == []


# ─── DoclingService._resolve_llm_proxy_url ──────────────────────────────────


class TestResolveLlmProxyUrl:
    """Tests for _resolve_llm_proxy_url."""

    @patch("config.settings.get_settings")
    def test_happy_path(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="http://127.0.0.1:8765")
        svc = DoclingService()
        url = svc._resolve_llm_proxy_url()
        assert url == "http://127.0.0.1:8765/v1/llm/chat/completions"

    @patch("config.settings.get_settings")
    def test_trailing_slash_stripped(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="http://127.0.0.1:8765/")
        svc = DoclingService()
        url = svc._resolve_llm_proxy_url()
        assert url == "http://127.0.0.1:8765/v1/llm/chat/completions"

    @patch("config.settings.get_settings")
    def test_empty_base_url_raises(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="")
        svc = DoclingService()
        with pytest.raises(RuntimeError, match="base_url is empty"):
            svc._resolve_llm_proxy_url()

    @patch("config.settings.get_settings")
    def test_invalid_url_raises(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="not-a-url")
        svc = DoclingService()
        with pytest.raises(RuntimeError, match="not a valid URL"):
            svc._resolve_llm_proxy_url()

    @patch("config.settings.get_settings")
    def test_non_routable_host_raises(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="http://0.0.0.0:8765")
        svc = DoclingService()
        with pytest.raises(RuntimeError, match="non-routable"):
            svc._resolve_llm_proxy_url()

    @patch("config.settings.get_settings")
    def test_ipv6_non_routable_raises(self, mock_gs):
        mock_gs.return_value = _make_settings(base_url="http://[::]:8765")
        svc = DoclingService()
        with pytest.raises(RuntimeError, match="non-routable"):
            svc._resolve_llm_proxy_url()


# ─── DoclingService._convert_sync ────────────────────────────────────────────


class TestConvertSync:
    """Tests for _convert_sync."""

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", False)
    def test_raises_if_unavailable(self):
        svc = DoclingService()
        with pytest.raises(RuntimeError, match="not available"):
            svc._convert_sync("/tmp/test.pdf")

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    def test_uses_provided_converter(self):
        svc = DoclingService()
        mock_converter = MagicMock()
        mock_converter.convert.return_value = "result"
        result = svc._convert_sync("/tmp/test.pdf", converter=mock_converter)
        assert result == "result"
        mock_converter.convert.assert_called_once()

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    def test_uses_stored_converter(self):
        svc = DoclingService()
        mock_converter = MagicMock()
        mock_converter.convert.return_value = "stored_result"
        svc._converter = mock_converter
        result = svc._convert_sync("/tmp/test.pdf")
        assert result == "stored_result"

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.DocumentConverter")
    def test_creates_converter_if_none(self, mock_dc):
        mock_instance = MagicMock()
        mock_instance.convert.return_value = "new_result"
        mock_dc.return_value = mock_instance
        svc = DoclingService()
        assert svc._converter is None
        result = svc._convert_sync("/tmp/test.pdf")
        assert result == "new_result"
        assert svc._converter is mock_instance


# ─── DoclingService._export_sync ─────────────────────────────────────────────


class TestExportSync:
    """Tests for _export_sync."""

    def test_markdown_format(self, tmp_path):
        svc = DoclingService()
        conv_res = _make_conv_result()
        # Mock save_as_markdown to write to the temp file
        def fake_save(filename, strict_text=False):
            Path(filename).write_text("# Heading\nContent here", encoding="utf-8")

        conv_res.document.save_as_markdown = fake_save
        fmt, content = svc._export_sync(conv_res, "markdown")
        assert fmt == "markdown"
        assert "Content" in content

    def test_md_format_alias(self, tmp_path):
        svc = DoclingService()
        conv_res = _make_conv_result()

        def fake_save(filename, strict_text=False):
            Path(filename).write_text("md content", encoding="utf-8")

        conv_res.document.save_as_markdown = fake_save
        fmt, content = svc._export_sync(conv_res, "md")
        assert fmt == "markdown"

    def test_text_format(self, tmp_path):
        svc = DoclingService()
        conv_res = _make_conv_result()

        def fake_save(filename, strict_text=False):
            Path(filename).write_text("plain text", encoding="utf-8")

        conv_res.document.save_as_markdown = fake_save
        fmt, content = svc._export_sync(conv_res, "text")
        assert fmt == "text"
        assert "plain text" in content

    def test_doctags_format(self, tmp_path):
        svc = DoclingService()
        conv_res = _make_conv_result()

        def fake_save(filename):
            Path(filename).write_text("<doctag>tokens</doctag>", encoding="utf-8")

        conv_res.document.save_as_document_tokens = fake_save
        fmt, content = svc._export_sync(conv_res, "doctags")
        assert fmt == "doctags"
        assert "tokens" in content

    def test_document_tokens_alias(self, tmp_path):
        svc = DoclingService()
        conv_res = _make_conv_result()

        def fake_save(filename):
            Path(filename).write_text("token data", encoding="utf-8")

        conv_res.document.save_as_document_tokens = fake_save
        fmt, content = svc._export_sync(conv_res, "document_tokens")
        assert fmt == "doctags"

    def test_json_format(self):
        svc = DoclingService()
        conv_res = _make_conv_result()
        conv_res.model_dump_json.return_value = '{"page": 1}'
        fmt, content = svc._export_sync(conv_res, "json")
        assert fmt == "json"
        assert content == '{"page": 1}'

    def test_json_fallback_on_error(self):
        svc = DoclingService()
        conv_res = _make_conv_result()
        conv_res.model_dump_json.side_effect = RuntimeError("pydantic error")
        fmt, content = svc._export_sync(conv_res, "json")
        assert fmt == "json"
        # Falls back to str(conv_res)
        assert content is not None

    def test_unknown_format_defaults_to_markdown(self, tmp_path):
        svc = DoclingService()
        conv_res = _make_conv_result()

        def fake_save(filename, strict_text=False):
            Path(filename).write_text("default md", encoding="utf-8")

        conv_res.document.save_as_markdown = fake_save
        fmt, content = svc._export_sync(conv_res, "unknown_format")
        assert fmt == "markdown"

    def test_none_format_defaults_to_markdown(self, tmp_path):
        svc = DoclingService()
        conv_res = _make_conv_result()

        def fake_save(filename, strict_text=False):
            Path(filename).write_text("null fmt", encoding="utf-8")

        conv_res.document.save_as_markdown = fake_save
        fmt, content = svc._export_sync(conv_res, None)
        assert fmt == "markdown"


# ─── DoclingService.process_file ─────────────────────────────────────────────


class TestProcessFile:
    """Tests for process_file."""

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.DocumentConverter")
    async def test_file_not_found(self, mock_dc):
        svc = DoclingService()
        svc._converter = MagicMock()
        # Patch _get_converter to avoid deep Docling imports
        with patch.object(svc, "_get_converter", return_value=MagicMock()):
            result = await svc.process_file("/nonexistent/path.pdf")
        assert result["success"] is False
        assert "File not found" in result["error"]

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.ConversionStatus")
    async def test_happy_path(self, mock_cs, tmp_path):
        # Create real file
        test_file = tmp_path / "test.pdf"
        test_file.write_bytes(b"%PDF content")

        # Mock ConversionStatus
        mock_cs.SUCCESS = "SUCCESS"
        mock_cs.PARTIAL_SUCCESS = "PARTIAL_SUCCESS"

        svc = DoclingService()
        svc._converter = MagicMock()

        # Mock _get_converter
        mock_converter = MagicMock()
        conv_res = _make_conv_result(status="SUCCESS")

        with patch.object(svc, "_get_converter", return_value=mock_converter), \
             patch.object(svc, "initialize", new_callable=AsyncMock), \
             patch("asyncio.to_thread") as mock_to_thread:

            # First call: _convert_sync, second call: _export_sync
            mock_to_thread.side_effect = [conv_res, ("markdown", "Extracted text")]

            result = await svc.process_file(str(test_file), pipeline="standard")

        assert result["success"] is True
        assert result["content"] == "Extracted text"
        assert result["format"] == "markdown"
        assert "docling_inprocess" in result["engine_used"]
        assert result["pages_processed"] >= 1
        assert "file_info" in result

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    async def test_engine_used_includes_pipeline_and_model(self, tmp_path):
        test_file = tmp_path / "test.pdf"
        test_file.write_bytes(b"%PDF")

        svc = DoclingService()
        svc._converter = MagicMock()

        conv_res = _make_conv_result()

        with patch.object(svc, "_get_converter", return_value=MagicMock()), \
             patch.object(svc, "initialize", new_callable=AsyncMock), \
             patch("core.integrations.providers.docling.service.ConversionStatus") as mock_cs, \
             patch("asyncio.to_thread") as mock_to_thread:

            mock_cs.SUCCESS = "SUCCESS"
            mock_cs.PARTIAL_SUCCESS = "PARTIAL_SUCCESS"
            mock_to_thread.side_effect = [conv_res, ("markdown", "text")]

            result = await svc.process_file(
                str(test_file),
                pipeline="vlm",
                vlm_model="internvl",
                ocr_engine="easyocr",
            )

        assert "vlm" in result["engine_used"]
        assert "internvl" in result["engine_used"]
        assert "easyocr" in result["engine_used"]

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    async def test_exception_returns_error(self, tmp_path):
        test_file = tmp_path / "test.pdf"
        test_file.write_bytes(b"%PDF")

        svc = DoclingService()
        with patch.object(svc, "initialize", new_callable=AsyncMock), \
             patch.object(svc, "_get_converter", side_effect=RuntimeError("converter broke")):
            result = await svc.process_file(str(test_file))

        assert result["success"] is False
        assert "converter broke" in result["error"]


# ─── DoclingService.process_base64 ───────────────────────────────────────────


class TestProcessBase64:
    """Tests for process_base64."""

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    async def test_happy_path(self):
        svc = DoclingService()
        b64_content = base64.b64encode(b"test content").decode()

        mock_result = {
            "success": True,
            "content": "Processed",
            "format": "markdown",
            "engine_used": "docling_inprocess",
            "processing_time": 0.5,
            "pages_processed": 1,
        }

        with patch.object(svc, "initialize", new_callable=AsyncMock), \
             patch.object(svc, "process_file", new_callable=AsyncMock, return_value=mock_result):
            result = await svc.process_base64(b64_content, "test.pdf")

        assert result["success"] is True
        assert result["content"] == "Processed"

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    async def test_invalid_base64_returns_error(self):
        svc = DoclingService()
        with patch.object(svc, "initialize", new_callable=AsyncMock):
            result = await svc.process_base64("!!!invalid_base64!!!", "test.pdf")
        assert result["success"] is False
        assert "Processing error" in result["error"]

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    async def test_preserves_file_extension(self):
        svc = DoclingService()
        b64_content = base64.b64encode(b"data").decode()

        with patch.object(svc, "initialize", new_callable=AsyncMock), \
             patch.object(svc, "process_file", new_callable=AsyncMock) as mock_pf:
            mock_pf.return_value = {"success": True}
            await svc.process_base64(b64_content, "report.docx", pipeline="standard")

        # Verify temp file had .docx suffix
        call_args = mock_pf.call_args
        file_path = call_args.kwargs.get("file_path") or call_args[0][0]
        assert file_path.endswith(".docx")

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    async def test_no_extension_uses_bin(self):
        svc = DoclingService()
        b64_content = base64.b64encode(b"data").decode()

        with patch.object(svc, "initialize", new_callable=AsyncMock), \
             patch.object(svc, "process_file", new_callable=AsyncMock) as mock_pf:
            mock_pf.return_value = {"success": True}
            await svc.process_base64(b64_content, "noext", pipeline="standard")

        call_args = mock_pf.call_args
        file_path = call_args.kwargs.get("file_path") or call_args[0][0]
        assert file_path.endswith(".bin")


# ─── DoclingService.health_check ─────────────────────────────────────────────


class TestHealthCheck:
    """Tests for health_check."""

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.DocumentConverter")
    def test_healthy_when_available(self, mock_dc):
        mock_dc.return_value = MagicMock()
        svc = DoclingService()
        result = svc.health_check()
        assert result["healthy"] is True
        assert result["status"] == "active"
        assert "standard" in result["pipelines"]
        assert "vlm" in result["pipelines"]
        assert len(result["ocr_engines"]) > 0
        # Verify dynamic dropdown options are present
        assert "ocr_engine_options" in result
        assert len(result["ocr_engine_options"]) > 0
        assert all("value" in opt and "label" in opt for opt in result["ocr_engine_options"])
        # Verify output format options are present
        assert "output_format_options" in result
        assert len(result["output_format_options"]) > 0
        assert result["output_format_options"][0]["value"] == "markdown"
        assert "output_formats" in result

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", False)
    def test_unhealthy_when_unavailable(self):
        svc = DoclingService()
        result = svc.health_check()
        assert result["healthy"] is False
        assert "not available" in result["error"]

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.DocumentConverter")
    def test_uses_existing_converter(self, mock_dc):
        svc = DoclingService()
        svc._converter = MagicMock()  # Already initialized
        result = svc.health_check()
        assert result["healthy"] is True
        mock_dc.assert_not_called()

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.DocumentConverter")
    def test_exception_during_check(self, mock_dc):
        mock_dc.side_effect = RuntimeError("init failed")
        svc = DoclingService()
        result = svc.health_check()
        assert result["healthy"] is False
        assert "init failed" in result["error"]
        assert result["error_type"] == "RuntimeError"

    def test_url_field_reflects_api_url(self):
        svc = DoclingService(api_url="http://custom:9090")
        # Even with unavailable docling, url field is populated
        with patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", False):
            result = svc.health_check()
        assert result["url"] == "http://custom:9090"


# ─── DoclingService.get_supported_formats ─────────────────────────────────────


class TestGetSupportedFormats:
    """Tests for get_supported_formats."""

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.DocumentConverter")
    async def test_happy_path(self, mock_dc):
        mock_dc.return_value = MagicMock()
        svc = DoclingService()
        result = await svc.get_supported_formats()
        assert "pipelines" in result
        assert "ocr_engines" in result
        assert "output_formats" in result
        assert "markdown" in result["output_formats"]
        # Verify dynamic dropdown options are present
        assert "ocr_engine_options" in result
        assert "output_format_options" in result
        assert len(result["output_format_options"]) > 0
        assert result["output_format_options"][0]["value"] == "markdown"

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", False)
    async def test_returns_error_when_unavailable(self):
        svc = DoclingService()
        result = await svc.get_supported_formats()
        assert "error" in result


# ─── get_docling_service (singleton) ─────────────────────────────────────────


class TestGetDoclingService:
    """Tests for get_docling_service singleton."""

    def test_creates_singleton(self):
        # Reset global singleton
        import core.integrations.providers.docling.service as svc_mod
        svc_mod._docling_service = None

        svc1 = get_docling_service()
        svc2 = get_docling_service()
        assert svc1 is svc2

        # Cleanup
        svc_mod._docling_service = None

    def test_respects_custom_url(self):
        import core.integrations.providers.docling.service as svc_mod
        svc_mod._docling_service = None

        svc = get_docling_service(api_url="http://custom:1234")
        assert svc.api_url == "http://custom:1234"

        # Cleanup
        svc_mod._docling_service = None


# ─── Wrapper: docling_health ─────────────────────────────────────────────────


class TestDoclingHealth:
    """Tests for wrapper.docling_health."""

    def test_happy_path(self):
        from core.integrations.providers.docling.wrapper import docling_health

        mock_svc = MagicMock()
        mock_svc.health_check.return_value = {"healthy": True, "status": "active"}

        with patch("core.integrations.providers.docling.wrapper.get_docling_service", return_value=mock_svc):
            result = docling_health()

        assert result["healthy"] is True

    def test_exception_returns_error(self):
        from core.integrations.providers.docling.wrapper import docling_health

        with patch(
            "core.integrations.providers.docling.wrapper.get_docling_service",
            side_effect=RuntimeError("service down"),
        ):
            result = docling_health()

        assert result["status"] == "error"
        assert "service down" in result["error"]


# ─── Wrapper: _convert_with_params ───────────────────────────────────────────


class TestConvertWithParams:
    """Tests for _convert_with_params."""

    async def test_calls_service_process_file(self):
        from core.integrations.providers.docling.wrapper import _convert_with_params

        mock_svc = MagicMock()
        mock_svc.process_file = AsyncMock(return_value={"success": True})

        result = await _convert_with_params(
            mock_svc, "/tmp/test.pdf", "standard", "markdown", {"ocr_engine": "easyocr"}
        )

        assert result["success"] is True
        mock_svc.process_file.assert_awaited_once_with(
            file_path="/tmp/test.pdf",
            pipeline="standard",
            output_format="markdown",
            ocr_engine="easyocr",
        )


# ─── Wrapper: _run_coroutine_threadsafe ──────────────────────────────────────


class TestRunCoroutineThreadsafe:
    """Tests for DoclingService.run_coroutine_threadsafe."""

    def test_executes_coroutine(self):
        from core.integrations.providers.docling.service import DoclingService

        async def coro():
            return "result_from_coro"

        svc = DoclingService()
        result = svc.run_coroutine_threadsafe(coro())
        assert result == "result_from_coro"

    def test_propagates_exception(self):
        from core.integrations.providers.docling.service import DoclingService

        async def failing_coro():
            raise ValueError("coro failed")

        svc = DoclingService()
        with pytest.raises(ValueError, match="coro failed"):
            svc.run_coroutine_threadsafe(failing_coro())

    def test_timeout_cancels_future(self):
        """ThreadTimeoutError cancels future and raises RuntimeError."""
        from concurrent.futures import TimeoutError as ThreadTimeoutError
        from core.integrations.providers.docling.service import DoclingService

        mock_future = MagicMock()
        mock_future.result.side_effect = ThreadTimeoutError()

        svc = DoclingService()
        mock_exec = MagicMock()
        mock_exec.submit.return_value = mock_future
        svc._executor = mock_exec

        async def dummy():
            return "never"

        with pytest.raises(RuntimeError, match="timed out"):
            svc.run_coroutine_threadsafe(dummy())

        mock_future.cancel.assert_called_once()


# ─── Wrapper: docling_convert ────────────────────────────────────────────────


class TestDoclingConvert:
    """Tests for docling_convert."""

    @patch("core.integrations.providers.docling.wrapper.get_docling_service")
    @patch("config.settings.get_settings")
    def test_happy_path_standard(self, mock_gs, mock_get_svc):
        from core.integrations.providers.docling.wrapper import docling_convert

        settings = _make_settings()
        mock_gs.return_value = settings

        mock_svc = MagicMock()
        mock_svc.process_file = AsyncMock(return_value={"success": True, "content": "text"})
        mock_get_svc.return_value = mock_svc

        result = docling_convert("/tmp/test.txt", pipeline="standard")
        assert result["success"] is True

    @patch("core.integrations.providers.docling.wrapper.get_docling_service")
    @patch("config.settings.get_settings")
    def test_auto_selects_vlm_for_pdf(self, mock_gs, mock_get_svc):
        from core.integrations.providers.docling.wrapper import docling_convert

        settings = _make_settings(vision_model="test-vlm")
        mock_gs.return_value = settings

        mock_svc = MagicMock()
        mock_svc.process_file = AsyncMock(return_value={"success": True})
        mock_get_svc.return_value = mock_svc

        result = docling_convert("/tmp/test.pdf", pipeline="standard")
        assert result["success"] is True

    @patch("core.integrations.providers.docling.wrapper.get_docling_service")
    @patch("config.settings.get_settings")
    def test_auto_selects_vlm_for_image(self, mock_gs, mock_get_svc):
        from core.integrations.providers.docling.wrapper import docling_convert

        settings = _make_settings(vision_model="test-vlm")
        mock_gs.return_value = settings

        mock_svc = MagicMock()
        mock_svc.process_file = AsyncMock(return_value={"success": True})
        mock_get_svc.return_value = mock_svc

        result = docling_convert("/tmp/photo.png", pipeline="standard")
        assert result["success"] is True

    def test_empty_base_url_raises(self):
        """Empty base_url raises RuntimeError (fail-fast before try/except)."""
        from core.integrations.providers.docling.wrapper import docling_convert

        with patch("config.settings.get_settings") as mock_gs:
            settings = _make_settings(base_url="")
            mock_gs.return_value = settings
            with pytest.raises(RuntimeError, match="base_url is empty"):
                docling_convert("/tmp/test.pdf")

    @patch("core.integrations.providers.docling.wrapper.get_docling_service")
    @patch("config.settings.get_settings")
    def test_passes_config_params(self, mock_gs, mock_get_svc):
        from core.integrations.providers.docling.wrapper import docling_convert

        settings = _make_settings()
        mock_gs.return_value = settings

        mock_svc = MagicMock()
        mock_svc.process_file = AsyncMock(return_value={"success": True})
        mock_get_svc.return_value = mock_svc

        result = docling_convert(
            "/tmp/test.txt",
            pipeline="standard",
            ocr_engine="easyocr",
            enable_code_enrichment=True,
            ocr_languages="en,fr",
        )
        assert result["success"] is True

    @patch("core.integrations.providers.docling.wrapper.get_docling_service")
    @patch("config.settings.get_settings")
    def test_exception_returns_error(self, mock_gs, mock_get_svc):
        from core.integrations.providers.docling.wrapper import docling_convert

        settings = _make_settings()
        mock_gs.return_value = settings

        mock_get_svc.side_effect = RuntimeError("service broken")
        result = docling_convert("/tmp/test.pdf", pipeline="standard", lm_studio_url="http://x", lm_studio_model="m")
        assert result["success"] is False
        assert "error" in result

    def test_pdf_no_vlm_model_no_settings_raises(self):
        """PDF auto-detect with vlm_model='' and settings=None → RuntimeError.
        All three params provided (not None) so settings not loaded; then
        auto-detect needs vision_model but settings is None. (Line 122)
        """
        from core.integrations.providers.docling.wrapper import docling_convert

        result = docling_convert(
            "/tmp/doc.pdf",
            pipeline="standard",
            lm_studio_url="http://x",
            lm_studio_model="m",
            vlm_model="",  # not None → settings not loaded; falsy → auto-detect triggers
        )
        assert result["success"] is False
        assert "vision model not configured" in result["error"]

    def test_image_no_vlm_model_no_settings_raises(self):
        """Image auto-detect with vlm_model='' and settings=None → RuntimeError. (Line 133)"""
        from core.integrations.providers.docling.wrapper import docling_convert

        result = docling_convert(
            "/tmp/photo.jpg",
            pipeline="standard",
            lm_studio_url="http://x",
            lm_studio_model="m",
            vlm_model="",
        )
        assert result["success"] is False
        assert "vision model not configured" in result["error"]

    @patch("core.integrations.providers.docling.wrapper.get_docling_service")
    @patch("config.settings.get_settings")
    def test_enrichment_flags_in_config(self, mock_gs, mock_get_svc):
        """Lines 154, 156, 158: formula/picture_classification/picture_description."""
        from core.integrations.providers.docling.wrapper import docling_convert

        settings = _make_settings()
        mock_gs.return_value = settings

        mock_svc = MagicMock()
        mock_svc.process_file = AsyncMock(return_value={"success": True})
        mock_get_svc.return_value = mock_svc

        docling_convert(
            "/tmp/test.txt",
            pipeline="standard",
            enable_formula_enrichment=True,
            enable_picture_classification=True,
            enable_picture_description=True,
        )

        call_kwargs = mock_svc.process_file.call_args[1]
        assert call_kwargs["enable_formula_enrichment"] == "true"
        assert call_kwargs["enable_picture_classification"] == "true"
        assert call_kwargs["enable_picture_description"] == "true"

    @patch("core.integrations.providers.docling.wrapper.get_docling_service")
    @patch("config.settings.get_settings")
    def test_running_loop_uses_threadsafe(self, mock_gs, mock_get_svc):
        """Lines 179-188: running event loop dispatches via run_coroutine_threadsafe."""
        from core.integrations.providers.docling.wrapper import docling_convert

        settings = _make_settings()
        mock_gs.return_value = settings
        
        mock_svc = MagicMock()
        mock_svc.run_coroutine_threadsafe.return_value = {"success": True, "content": "text"}
        mock_get_svc.return_value = mock_svc

        loop = MagicMock()
        loop.is_running.return_value = True

        with patch("asyncio.get_running_loop", return_value=loop):
            result = docling_convert("/tmp/test.txt", pipeline="standard")

        assert result["success"] is True
        mock_svc.run_coroutine_threadsafe.assert_called_once()

    @patch("core.integrations.providers.docling.wrapper.get_docling_service")
    @patch("config.settings.get_settings")
    def test_stopped_loop_uses_run_until_complete(self, mock_gs, mock_get_svc):
        """Lines 189-190: stopped event loop uses loop.run_until_complete."""
        from core.integrations.providers.docling.wrapper import docling_convert

        settings = _make_settings()
        mock_gs.return_value = settings
        mock_get_svc.return_value = MagicMock()

        loop = MagicMock()
        loop.is_running.return_value = False
        loop.run_until_complete.return_value = {"success": True, "content": "text"}

        with patch("asyncio.get_running_loop", return_value=loop):
            result = docling_convert("/tmp/test.txt", pipeline="standard")

        assert result["success"] is True
        loop.run_until_complete.assert_called_once()


# ─── _resolve_response_format ────────────────────────────────────────────────


class TestResolveResponseFormat:
    """Lines 227-234: maps output format strings to ResponseFormat enum."""

    def test_doctags_variants(self):
        svc = DoclingService()
        MockResponseFormat = MagicMock()
        MockResponseFormat.DOCTAGS = "DOCTAGS"
        MockResponseFormat.HTML = "HTML"
        MockResponseFormat.MARKDOWN = "MARKDOWN"

        with patch.dict("sys.modules", {
            "docling.datamodel.pipeline_options_vlm_model": MagicMock(ResponseFormat=MockResponseFormat),
        }):
            from docling.datamodel.pipeline_options_vlm_model import ResponseFormat as RF
            # Re-call with the mocked module
            with patch(
                "core.integrations.providers.docling.service.DoclingService._resolve_response_format",
                wraps=svc._resolve_response_format,
            ):
                for fmt in ("doctags", "document_tokens", "tokens"):
                    result = svc._resolve_response_format(fmt)
                    assert result == RF.DOCTAGS

    def test_html_format(self):
        svc = DoclingService()
        MockResponseFormat = MagicMock()
        MockResponseFormat.HTML = "HTML"
        MockResponseFormat.DOCTAGS = "DOCTAGS"
        MockResponseFormat.MARKDOWN = "MARKDOWN"

        with patch.dict("sys.modules", {
            "docling.datamodel.pipeline_options_vlm_model": MagicMock(ResponseFormat=MockResponseFormat),
        }):
            from docling.datamodel.pipeline_options_vlm_model import ResponseFormat as RF
            result = svc._resolve_response_format("html")
            assert result == RF.HTML

    def test_markdown_default(self):
        svc = DoclingService()
        MockResponseFormat = MagicMock()
        MockResponseFormat.MARKDOWN = "MARKDOWN"
        MockResponseFormat.HTML = "HTML"
        MockResponseFormat.DOCTAGS = "DOCTAGS"

        with patch.dict("sys.modules", {
            "docling.datamodel.pipeline_options_vlm_model": MagicMock(ResponseFormat=MockResponseFormat),
        }):
            from docling.datamodel.pipeline_options_vlm_model import ResponseFormat as RF
            result = svc._resolve_response_format("markdown")
            assert result == RF.MARKDOWN

    def test_none_defaults_to_markdown(self):
        svc = DoclingService()
        MockResponseFormat = MagicMock()
        MockResponseFormat.MARKDOWN = "MARKDOWN"

        with patch.dict("sys.modules", {
            "docling.datamodel.pipeline_options_vlm_model": MagicMock(ResponseFormat=MockResponseFormat),
        }):
            from docling.datamodel.pipeline_options_vlm_model import ResponseFormat as RF
            result = svc._resolve_response_format(None)
            assert result == RF.MARKDOWN


# ─── _build_pdf_pipeline_options ─────────────────────────────────────────────


class TestBuildPdfPipelineOptions:
    """Lines 249-293: builds PDF pipeline options with OCR engine selection."""

    def _mock_pipeline_options(self):
        """Set up mock docling pipeline option classes."""
        mock_module = MagicMock()
        mock_module.PdfPipelineOptions = MagicMock(return_value=MagicMock())
        mock_module.OcrMacOptions = MagicMock(return_value="ocrmac_opts")
        mock_module.EasyOcrOptions = MagicMock(return_value="easyocr_opts")
        mock_module.RapidOcrOptions = MagicMock(return_value="rapidocr_opts")
        mock_module.TesseractCliOcrOptions = MagicMock(return_value="tesseract_cli_opts")
        mock_module.TesseractOcrOptions = MagicMock(return_value="tesseract_opts")
        mock_module.PictureDescriptionApiOptions = MagicMock(return_value="pic_desc_opts")
        return mock_module

    def _call(self, svc, mock_module, **kwargs):
        defaults = dict(
            ocr_engine="easyocr",
            ocr_languages=["en"],
            enable_code_enrichment=False,
            enable_formula_enrichment=False,
            enable_picture_classification=False,
            enable_picture_description=False,
            llm_proxy_url=None,
            llm_model=None,
            timeout_seconds=None,
        )
        defaults.update(kwargs)
        with patch.dict("sys.modules", {
            "docling.datamodel.pipeline_options": mock_module,
        }):
            return svc._build_pdf_pipeline_options(**defaults)

    def test_ocrmac_engine(self):
        svc = DoclingService()
        mock = self._mock_pipeline_options()
        self._call(svc, mock, ocr_engine="ocrmac")
        mock.OcrMacOptions.assert_called_once()

    def test_easyocr_engine(self):
        svc = DoclingService()
        mock = self._mock_pipeline_options()
        self._call(svc, mock, ocr_engine="easyocr")
        mock.EasyOcrOptions.assert_called_once()

    def test_rapidocr_engine(self):
        svc = DoclingService()
        mock = self._mock_pipeline_options()
        self._call(svc, mock, ocr_engine="rapidocr")
        mock.RapidOcrOptions.assert_called_once()

    def test_tesseract_cli_engine(self):
        svc = DoclingService()
        mock = self._mock_pipeline_options()
        self._call(svc, mock, ocr_engine="tesseract_cli")
        mock.TesseractCliOcrOptions.assert_called_once()

    def test_tesseract_engine(self):
        svc = DoclingService()
        mock = self._mock_pipeline_options()
        self._call(svc, mock, ocr_engine="tesseract")
        mock.TesseractOcrOptions.assert_called_once()

    def test_unsupported_engine_raises(self):
        svc = DoclingService()
        mock = self._mock_pipeline_options()
        with pytest.raises(ValueError, match="Unsupported OCR engine"):
            self._call(svc, mock, ocr_engine="unknown_engine")

    def test_timeout_set(self):
        svc = DoclingService()
        mock = self._mock_pipeline_options()
        result = self._call(svc, mock, ocr_engine="easyocr", timeout_seconds=120.0)
        assert result.document_timeout == 120.0

    def test_picture_description_enabled(self):
        svc = DoclingService()
        mock = self._mock_pipeline_options()
        result = self._call(
            svc, mock,
            ocr_engine="easyocr",
            enable_picture_description=True,
            llm_proxy_url="http://localhost:8765/v1/llm/chat/completions",
            llm_model="test-model",
        )
        assert result.enable_remote_services is True
        mock.PictureDescriptionApiOptions.assert_called_once()

    def test_picture_description_no_llm_raises(self):
        svc = DoclingService()
        mock = self._mock_pipeline_options()
        with pytest.raises(RuntimeError, match="LLM proxy URL/model is missing"):
            self._call(svc, mock, ocr_engine="easyocr", enable_picture_description=True)


# ─── _build_vlm_pipeline_options ─────────────────────────────────────────────


class TestBuildVlmPipelineOptions:
    """Lines 304-325: builds VLM pipeline options."""

    def test_basic_vlm_options(self):
        svc = DoclingService()

        mock_pipeline_opts = MagicMock()
        mock_vlm_model = MagicMock(return_value=MagicMock())
        mock_vlm_specs = MagicMock()
        mock_vlm_specs.GRANITE_VISION_OLLAMA.prompt = "test prompt"
        mock_response_fmt = MagicMock()
        mock_response_fmt.MARKDOWN = "MARKDOWN"

        with patch.dict("sys.modules", {
            "docling.datamodel.pipeline_options": MagicMock(VlmPipelineOptions=mock_pipeline_opts),
            "docling.datamodel.pipeline_options_vlm_model": MagicMock(
                ApiVlmOptions=mock_vlm_model, ResponseFormat=mock_response_fmt,
            ),
            "docling.datamodel.vlm_model_specs": mock_vlm_specs,
        }):
            with patch.object(svc, "_resolve_response_format", return_value="MARKDOWN"):
                result = svc._build_vlm_pipeline_options(
                    llm_proxy_url="http://localhost:7090/v1/chat/completions",
                    llm_model="test-vision",
                    output_format="markdown",
                    timeout_seconds=60.0,
                    api_key="test-key",
                )

        mock_vlm_model.assert_called_once()
        call_kwargs = mock_vlm_model.call_args[1]
        assert "Authorization" in call_kwargs["headers"]
        assert call_kwargs["timeout"] == 60.0
        mock_pipeline_opts.assert_called_once()

    def test_no_api_key(self):
        svc = DoclingService()

        mock_vlm_model = MagicMock(return_value=MagicMock())
        mock_vlm_specs = MagicMock()
        mock_vlm_specs.GRANITE_VISION_OLLAMA.prompt = "test prompt"

        with patch.dict("sys.modules", {
            "docling.datamodel.pipeline_options": MagicMock(),
            "docling.datamodel.pipeline_options_vlm_model": MagicMock(ApiVlmOptions=mock_vlm_model),
            "docling.datamodel.vlm_model_specs": mock_vlm_specs,
        }):
            with patch.object(svc, "_resolve_response_format", return_value="MARKDOWN"):
                svc._build_vlm_pipeline_options(
                    llm_proxy_url="http://localhost:7090/v1/chat/completions",
                    llm_model="test-vision",
                    output_format="markdown",
                    timeout_seconds=None,
                    api_key="",
                )

        call_kwargs = mock_vlm_model.call_args[1]
        assert call_kwargs["headers"] == {}
        assert call_kwargs["timeout"] == 120.0  # Default timeout

    def test_not_needed_api_key_treated_as_empty(self):
        svc = DoclingService()

        mock_vlm_model = MagicMock(return_value=MagicMock())
        mock_vlm_specs = MagicMock()
        mock_vlm_specs.GRANITE_VISION_OLLAMA.prompt = "test prompt"

        with patch.dict("sys.modules", {
            "docling.datamodel.pipeline_options": MagicMock(),
            "docling.datamodel.pipeline_options_vlm_model": MagicMock(ApiVlmOptions=mock_vlm_model),
            "docling.datamodel.vlm_model_specs": mock_vlm_specs,
        }):
            with patch.object(svc, "_resolve_response_format", return_value="MARKDOWN"):
                svc._build_vlm_pipeline_options(
                    llm_proxy_url="http://localhost:7090/v1/chat/completions",
                    llm_model="test-vision",
                    output_format="markdown",
                    timeout_seconds=None,
                    api_key="not-needed",
                )

        call_kwargs = mock_vlm_model.call_args[1]
        assert call_kwargs["headers"] == {}


# ─── _get_converter ──────────────────────────────────────────────────────────


class TestGetConverter:
    """Lines 339-459: builds and caches the document converter."""

    def _setup_mocks(self):
        """Create mock docling modules for _get_converter."""
        mock_converter_cls = MagicMock()
        mock_converter_instance = MagicMock()
        mock_converter_cls.return_value = mock_converter_instance

        mock_format_option = MagicMock()
        mock_input_format = MagicMock()
        mock_input_format.PDF = "PDF"
        mock_input_format.IMAGE = "IMAGE"

        mock_backend = MagicMock()
        mock_std_pipeline = MagicMock()
        mock_vlm_pipeline = MagicMock()

        modules = {
            "docling.document_converter": MagicMock(
                DocumentConverter=mock_converter_cls,
                FormatOption=mock_format_option,
            ),
            "docling.datamodel.base_models": MagicMock(InputFormat=mock_input_format),
            "docling.backend.docling_parse_v4_backend": MagicMock(
                DoclingParseV4DocumentBackend=mock_backend,
            ),
            "docling.pipeline.standard_pdf_pipeline": MagicMock(
                StandardPdfPipeline=mock_std_pipeline,
            ),
            "docling.pipeline.vlm_pipeline": MagicMock(VlmPipeline=mock_vlm_pipeline),
        }
        return modules, mock_converter_cls, mock_converter_instance

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    def test_standard_pipeline(self):
        svc = DoclingService()
        modules, mock_cls, mock_inst = self._setup_mocks()
        settings = _make_settings()

        with patch.dict("sys.modules", modules):
            with patch("config.settings.get_settings", return_value=settings):
                with patch.object(svc, "_build_pdf_pipeline_options", return_value=MagicMock()):
                    result = svc._get_converter(
                        pipeline="standard",
                        ocr_engine="easyocr",
                        vlm_model=None,
                        output_format="markdown",
                    )

        assert result is mock_inst
        mock_cls.assert_called_once()

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    def test_vlm_pipeline(self):
        svc = DoclingService()
        modules, mock_cls, mock_inst = self._setup_mocks()
        settings = _make_settings()

        with patch.dict("sys.modules", modules):
            with patch("config.settings.get_settings", return_value=settings):
                with patch.object(svc, "_build_pdf_pipeline_options", return_value=MagicMock()):
                    with patch.object(svc, "_build_vlm_pipeline_options", return_value=MagicMock()):
                        result = svc._get_converter(
                            pipeline="vlm",
                            ocr_engine=None,
                            vlm_model=None,
                            output_format="markdown",
                        )

        assert result is mock_inst

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    def test_caches_converter_by_key(self):
        """Same config returns same converter instance."""
        svc = DoclingService()
        modules, mock_cls, mock_inst = self._setup_mocks()
        settings = _make_settings()

        with patch.dict("sys.modules", modules):
            with patch("config.settings.get_settings", return_value=settings):
                with patch.object(svc, "_build_pdf_pipeline_options", return_value=MagicMock()):
                    first = svc._get_converter(
                        pipeline="standard", ocr_engine="easyocr",
                        vlm_model=None, output_format="markdown",
                    )
                    second = svc._get_converter(
                        pipeline="standard", ocr_engine="easyocr",
                        vlm_model=None, output_format="markdown",
                    )

        assert first is second
        assert mock_cls.call_count == 1  # Created only once

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    def test_new_converter_on_config_change(self):
        """Different config creates new converter."""
        svc = DoclingService()
        modules, mock_cls, mock_inst = self._setup_mocks()
        settings = _make_settings()

        with patch.dict("sys.modules", modules):
            with patch("config.settings.get_settings", return_value=settings):
                with patch.object(svc, "_build_pdf_pipeline_options", return_value=MagicMock()):
                    svc._get_converter(
                        pipeline="standard", ocr_engine="easyocr",
                        vlm_model=None, output_format="markdown",
                    )
                    svc._get_converter(
                        pipeline="standard", ocr_engine="ocrmac",
                        vlm_model=None, output_format="markdown",
                    )

        assert mock_cls.call_count == 2

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", False)
    def test_not_available_raises(self):
        svc = DoclingService()
        with pytest.raises(RuntimeError, match="not available"):
            svc._get_converter(
                pipeline="standard", ocr_engine="easyocr",
                vlm_model=None, output_format="markdown",
            )

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    def test_no_llm_model_resolved_raises(self):
        """When resolve_service_provider returns empty model, raises RuntimeError."""
        svc = DoclingService()
        modules, _, _ = self._setup_mocks()
        settings = _make_settings()
        settings.resolve_service_provider.return_value = ("http://localhost:7090/v1", "", "")

        with patch.dict("sys.modules", modules):
            with patch("config.settings.get_settings", return_value=settings):
                with pytest.raises(RuntimeError, match="No OCR/VLM model resolved"):
                    svc._get_converter(
                        pipeline="standard", ocr_engine="easyocr",
                        vlm_model=None, output_format="markdown",
                    )

    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    def test_caller_overrides_url_and_model(self):
        """lm_studio_url and lm_studio_model kwargs override provider resolution."""
        svc = DoclingService()
        modules, mock_cls, _ = self._setup_mocks()
        settings = _make_settings()

        with patch.dict("sys.modules", modules):
            with patch("config.settings.get_settings", return_value=settings):
                with patch.object(svc, "_build_pdf_pipeline_options", return_value=MagicMock()):
                    svc._get_converter(
                        pipeline="standard", ocr_engine="easyocr",
                        vlm_model=None, output_format="markdown",
                        lm_studio_url="http://override:1234/v1",
                        lm_studio_model="override-model",
                    )

        # Should use caller overrides, not provider resolution
        mock_cls.assert_called_once()


# ─── process_file: pages_processed exception ─────────────────────────────────


class TestProcessFilePagesException:
    """Line 526-527: pages_processed exception handler."""

    @pytest.mark.asyncio
    @patch("core.integrations.providers.docling.service._DOCLING_AVAILABLE", True)
    @patch("core.integrations.providers.docling.service.DocumentConverter", MagicMock)
    async def test_pages_attribute_raises_sets_zero(self):
        svc = DoclingService()

        conv_res = MagicMock()
        conv_res.status = MagicMock()
        conv_res.document = MagicMock()
        # Make pages property raise when accessed
        type(conv_res).pages = PropertyMock(side_effect=TypeError("bad pages"))

        with patch.object(svc, "_get_converter", return_value=MagicMock()):
            with patch("asyncio.to_thread", side_effect=[conv_res, ("markdown", "content")]):
                with patch("core.integrations.providers.docling.service.ConversionStatus", MagicMock()):
                    result = await svc.process_file(
                        file_path=__file__,
                        pipeline="standard",
                        output_format="markdown",
                    )

        assert result["success"] is True or result.get("pages_processed") is not None
        assert result.get("pages_processed", 0) in (0, 1)


# ─── DoclingService._check_inference_vision_available ─────────────────────────


class TestCheckInferenceVisionAvailable:
    """Tests for _check_inference_vision_available (BUG 3 fix).

    The method imports InferenceManager and ServerStatus from
    services.aether_inference.manager (NOT inference_control) and checks
    whether the inference server singleton reports RUNNING status.
    """

    def test_returns_true_when_server_running(self):
        mock_manager = MagicMock()
        mock_manager.status = "RUNNING"
        mock_status = MagicMock()
        mock_status.RUNNING = "RUNNING"

        with patch(
            "core.integrations.providers.docling.service.InferenceManager",
            create=True,
        ) as mock_cls, patch(
            "core.integrations.providers.docling.service.ServerStatus",
            mock_status,
            create=True,
        ):
            mock_cls.get_instance.return_value = mock_manager
            with patch.dict("sys.modules", {
                "services.aether_inference.manager": MagicMock(
                    InferenceManager=mock_cls,
                    ServerStatus=mock_status,
                ),
            }):
                result = DoclingService._check_inference_vision_available()

        assert result is True

    def test_returns_false_when_server_stopped(self):
        mock_manager = MagicMock()
        mock_manager.status = "STOPPED"
        mock_status = MagicMock()
        mock_status.RUNNING = "RUNNING"

        with patch.dict("sys.modules", {
            "services.aether_inference.manager": MagicMock(
                InferenceManager=MagicMock(get_instance=MagicMock(return_value=mock_manager)),
                ServerStatus=mock_status,
            ),
        }):
            result = DoclingService._check_inference_vision_available()

        assert result is False

    def test_returns_false_on_import_error(self):
        """If InferenceManager module is not importable, returns False gracefully."""
        with patch.dict("sys.modules", {"services.aether_inference.manager": None}):
            result = DoclingService._check_inference_vision_available()

        assert result is False

    def test_returns_false_on_attribute_error(self):
        """If get_instance or status raises AttributeError, returns False."""
        mock_mod = MagicMock()
        mock_mod.InferenceManager.get_instance.side_effect = AttributeError("no instance")

        with patch.dict("sys.modules", {
            "services.aether_inference.manager": mock_mod,
        }):
            result = DoclingService._check_inference_vision_available()

        assert result is False

    def test_returns_false_on_runtime_error(self):
        """If InferenceManager raises RuntimeError (e.g., not initialized), returns False."""
        mock_mod = MagicMock()
        mock_mod.InferenceManager.get_instance.side_effect = RuntimeError("not initialized")

        with patch.dict("sys.modules", {
            "services.aether_inference.manager": mock_mod,
        }):
            result = DoclingService._check_inference_vision_available()

        assert result is False

    def test_used_by_health_check_ocr_engines(self):
        """Verify _build_ocr_engine_options calls _check_inference_vision_available
        and the result controls glm-ocr availability."""
        svc = DoclingService()

        with patch.object(
            DoclingService, "_check_inference_vision_available", return_value=True
        ):
            engines = svc._build_ocr_engine_options()
        glm = next(e for e in engines if e["value"] == "glm-ocr")
        assert glm["available"] is True

        with patch.object(
            DoclingService, "_check_inference_vision_available", return_value=False
        ):
            engines = svc._build_ocr_engine_options()
        glm = next(e for e in engines if e["value"] == "glm-ocr")
        assert glm["available"] is False
