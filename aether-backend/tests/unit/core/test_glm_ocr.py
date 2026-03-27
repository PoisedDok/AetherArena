"""
Tests for core.integrations.providers.aether_inference.glm_ocr

Coverage target: 100% of glm_ocr.py (211 lines, 0 existing tests).

Mock boundaries:
- Path.exists() / open() → filesystem access for image encoding
- services.aether_inference.platform_detector.detect_platform → platform detection

Real logic under test:
- MIME type resolution from file extension
- Base64 encoding of images (file and bytes)
- Prompt formatting per GLM-OCR spec (recognition and extraction)
- Response parsing from OpenAI-format dicts
- Model resolution with platform fallback
"""

import base64
from unittest.mock import MagicMock, patch

import pytest

from core.integrations.providers.aether_inference.glm_ocr import (
    GLMOCRTask,
    GlmOcrAdapter,
    _TASK_PROMPTS,
)

# ---------------------------------------------------------------------------
# GLMOCRTask enum
# ---------------------------------------------------------------------------

class TestGLMOCRTask:

    def test_enum_values(self):
        assert GLMOCRTask.TEXT == "text"
        assert GLMOCRTask.FORMULA == "formula"
        assert GLMOCRTask.TABLE == "table"
        assert GLMOCRTask.INFO_EXTRACTION == "info_extraction"

    def test_task_prompts_mapping(self):
        assert _TASK_PROMPTS[GLMOCRTask.TEXT] == "Text Recognition:"
        assert _TASK_PROMPTS[GLMOCRTask.FORMULA] == "Formula Recognition:"
        assert _TASK_PROMPTS[GLMOCRTask.TABLE] == "Table Recognition:"
        assert GLMOCRTask.INFO_EXTRACTION not in _TASK_PROMPTS


# ---------------------------------------------------------------------------
# encode_image_to_base64_url
# ---------------------------------------------------------------------------

class TestEncodeImageToBase64Url:

    def test_png_file(self, tmp_path):
        img = tmp_path / "test.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 10)

        result = GlmOcrAdapter.encode_image_to_base64_url(str(img))

        assert result.startswith("data:image/png;base64,")
        # Verify round-trip
        b64_part = result.split(",", 1)[1]
        decoded = base64.b64decode(b64_part)
        assert decoded == b"\x89PNG\r\n\x1a\n" + b"\x00" * 10

    def test_jpeg_file(self, tmp_path):
        img = tmp_path / "photo.jpg"
        img.write_bytes(b"\xff\xd8\xff" + b"\x00" * 5)

        result = GlmOcrAdapter.encode_image_to_base64_url(str(img))
        assert result.startswith("data:image/jpeg;base64,")

    def test_jpeg_extension(self, tmp_path):
        img = tmp_path / "photo.jpeg"
        img.write_bytes(b"\xff\xd8\xff")

        result = GlmOcrAdapter.encode_image_to_base64_url(str(img))
        assert result.startswith("data:image/jpeg;base64,")

    def test_file_not_found(self):
        with pytest.raises(FileNotFoundError, match="Image not found"):
            GlmOcrAdapter.encode_image_to_base64_url("/nonexistent/path.png")

    def test_unknown_extension_defaults_to_png(self, tmp_path):
        img = tmp_path / "doc.xyz"
        img.write_bytes(b"some data")

        result = GlmOcrAdapter.encode_image_to_base64_url(str(img))
        assert result.startswith("data:image/png;base64,")

    def test_bmp_extension(self, tmp_path):
        img = tmp_path / "image.bmp"
        img.write_bytes(b"BM" + b"\x00" * 10)

        result = GlmOcrAdapter.encode_image_to_base64_url(str(img))
        assert result.startswith("data:image/bmp;base64,")

    def test_tiff_extension(self, tmp_path):
        img = tmp_path / "scan.tiff"
        img.write_bytes(b"II*\x00")

        result = GlmOcrAdapter.encode_image_to_base64_url(str(img))
        assert result.startswith("data:image/tiff;base64,")

    def test_tif_extension(self, tmp_path):
        img = tmp_path / "scan.tif"
        img.write_bytes(b"II*\x00")

        result = GlmOcrAdapter.encode_image_to_base64_url(str(img))
        assert result.startswith("data:image/tiff;base64,")

    def test_webp_extension(self, tmp_path):
        img = tmp_path / "photo.webp"
        img.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")

        result = GlmOcrAdapter.encode_image_to_base64_url(str(img))
        assert result.startswith("data:image/webp;base64,")

    def test_gif_extension(self, tmp_path):
        img = tmp_path / "anim.gif"
        img.write_bytes(b"GIF89a")

        result = GlmOcrAdapter.encode_image_to_base64_url(str(img))
        assert result.startswith("data:image/gif;base64,")

    def test_accepts_path_object(self, tmp_path):
        img = tmp_path / "test.png"
        img.write_bytes(b"\x89PNG")

        result = GlmOcrAdapter.encode_image_to_base64_url(img)  # Path, not str
        assert result.startswith("data:image/png;base64,")


# ---------------------------------------------------------------------------
# encode_image_bytes_to_base64_url
# ---------------------------------------------------------------------------

class TestEncodeImageBytesToBase64Url:

    def test_default_mime_type(self):
        data = b"\x89PNG\r\n\x1a\n"
        result = GlmOcrAdapter.encode_image_bytes_to_base64_url(data)

        assert result.startswith("data:image/png;base64,")
        b64_part = result.split(",", 1)[1]
        assert base64.b64decode(b64_part) == data

    def test_custom_mime_type(self):
        data = b"\xff\xd8\xff"
        result = GlmOcrAdapter.encode_image_bytes_to_base64_url(data, mime_type="image/jpeg")
        assert result.startswith("data:image/jpeg;base64,")


# ---------------------------------------------------------------------------
# format_recognition_messages
# ---------------------------------------------------------------------------

class TestFormatRecognitionMessages:

    def test_text_task(self):
        msgs = GlmOcrAdapter.format_recognition_messages(
            image_source="data:image/png;base64,abc123",
            task=GLMOCRTask.TEXT,
        )

        assert len(msgs) == 1
        content = msgs[0]["content"]
        assert msgs[0]["role"] == "user"
        assert content[0]["type"] == "image_url"
        assert content[0]["image_url"]["url"] == "data:image/png;base64,abc123"
        assert content[1]["type"] == "text"
        assert content[1]["text"] == "Text Recognition:"

    def test_formula_task(self):
        msgs = GlmOcrAdapter.format_recognition_messages(
            image_source="https://example.com/formula.png",
            task=GLMOCRTask.FORMULA,
        )
        assert msgs[0]["content"][1]["text"] == "Formula Recognition:"

    def test_table_task(self):
        msgs = GlmOcrAdapter.format_recognition_messages(
            image_source="data:image/png;base64,x",
            task=GLMOCRTask.TABLE,
        )
        assert msgs[0]["content"][1]["text"] == "Table Recognition:"

    def test_info_extraction_raises(self):
        with pytest.raises(ValueError, match="format_extraction_messages"):
            GlmOcrAdapter.format_recognition_messages(
                image_source="data:image/png;base64,x",
                task=GLMOCRTask.INFO_EXTRACTION,
            )

    def test_default_task_is_text(self):
        msgs = GlmOcrAdapter.format_recognition_messages(
            image_source="data:image/png;base64,x",
        )
        assert msgs[0]["content"][1]["text"] == "Text Recognition:"

    def test_http_url_source(self):
        """Image source can be an HTTP URL, not just base64."""
        msgs = GlmOcrAdapter.format_recognition_messages(
            image_source="https://cdn.example.com/image.jpg",
        )
        assert msgs[0]["content"][0]["image_url"]["url"] == "https://cdn.example.com/image.jpg"


# ---------------------------------------------------------------------------
# format_extraction_messages
# ---------------------------------------------------------------------------

class TestFormatExtractionMessages:

    def test_basic_schema(self):
        schema = '{"name": "string", "age": "number"}'
        msgs = GlmOcrAdapter.format_extraction_messages(
            image_source="data:image/png;base64,abc",
            json_schema=schema,
        )

        assert len(msgs) == 1
        content = msgs[0]["content"]
        assert msgs[0]["role"] == "user"
        assert content[0]["image_url"]["url"] == "data:image/png;base64,abc"
        # Prompt must include Chinese instruction and schema
        text = content[1]["text"]
        assert "请按下列JSON格式输出图中信息:" in text
        assert schema in text

    def test_schema_in_prompt_text(self):
        schema = '{"invoice_number": "string", "total": "number"}'
        msgs = GlmOcrAdapter.format_extraction_messages(
            image_source="https://example.com/invoice.png",
            json_schema=schema,
        )
        prompt = msgs[0]["content"][1]["text"]
        assert prompt == f"请按下列JSON格式输出图中信息:\n{schema}"


# ---------------------------------------------------------------------------
# parse_response
# ---------------------------------------------------------------------------

class TestParseResponse:

    def test_success(self):
        resp = {
            "choices": [{"message": {"content": "  Hello World  "}}],
            "usage": {"total_tokens": 100},
        }
        result = GlmOcrAdapter.parse_response(resp)
        assert result == "Hello World"  # stripped

    def test_empty_choices(self):
        result = GlmOcrAdapter.parse_response({"choices": []})
        assert result == ""

    def test_missing_choices_key(self):
        result = GlmOcrAdapter.parse_response({"data": "something"})
        assert result == ""

    def test_missing_message_key(self):
        result = GlmOcrAdapter.parse_response({"choices": [{"index": 0}]})
        assert result == ""

    def test_missing_content_key(self):
        result = GlmOcrAdapter.parse_response({"choices": [{"message": {}}]})
        assert result == ""

    def test_none_input_handled(self):
        """TypeError from None.get() is caught."""
        result = GlmOcrAdapter.parse_response(None)
        assert result == ""

    def test_multiline_content_stripped(self):
        resp = {"choices": [{"message": {"content": "\n  OCR output line 1\n  line 2  \n"}}]}
        result = GlmOcrAdapter.parse_response(resp)
        assert result == "OCR output line 1\n  line 2"


# ---------------------------------------------------------------------------
# get_default_model
# ---------------------------------------------------------------------------

class TestGetDefaultModel:

    def test_from_platform_detection(self):
        mock_platform = MagicMock()
        mock_platform.glm_ocr_model = "mlx-glm-ocr-8bit"

        with patch(
            "services.aether_inference.platform_detector.detect_platform",
            return_value=mock_platform,
        ):
            result = GlmOcrAdapter.get_default_model()

        assert result == "mlx-glm-ocr-8bit"

    def test_platform_import_error_fallback(self):
        with patch(
            "services.aether_inference.platform_detector.detect_platform",
            side_effect=ImportError("no module"),
        ):
            result = GlmOcrAdapter.get_default_model()

        assert result == "glm-ocr"

    def test_platform_runtime_error_fallback(self):
        with patch(
            "services.aether_inference.platform_detector.detect_platform",
            side_effect=RuntimeError("detection failed"),
        ):
            result = GlmOcrAdapter.get_default_model()

        assert result == "glm-ocr"
