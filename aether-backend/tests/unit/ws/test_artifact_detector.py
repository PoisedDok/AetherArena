"""
Unit Tests: ws.domain.builders.artifact_detector

Tests artifact type detection, normalization, and legacy format handling.
"""

from ws.domain.builders.artifact_detector import (
    is_artifact_type,
    normalize_artifact_type,
    apply_normalization,
)


class TestIsArtifactType:
    """Tests for is_artifact_type."""

    def test_code_is_artifact(self):
        assert is_artifact_type("code") is True

    def test_output_is_artifact(self):
        assert is_artifact_type("output") is True

    def test_message_is_not_artifact(self):
        assert is_artifact_type("message") is False

    def test_case_insensitive(self):
        assert is_artifact_type("Code") is True
        assert is_artifact_type("OUTPUT") is True


class TestNormalizeArtifactType:
    """Tests for normalize_artifact_type."""

    def test_computer_code_html_becomes_output(self):
        """Line 81: computer:code+html → output+html (architectural fix)."""
        result = normalize_artifact_type("code", "html", "computer")
        assert result == ("output", "html")

    def test_legacy_console_normalized(self):
        assert normalize_artifact_type("console") == ("output", "console")

    def test_legacy_html_normalized(self):
        assert normalize_artifact_type("html") == ("output", "html")

    def test_legacy_json_normalized(self):
        assert normalize_artifact_type("json") == ("output", "json")

    def test_legacy_text_normalized(self):
        assert normalize_artifact_type("text") == ("output", "text")

    def test_legacy_markdown_normalized(self):
        assert normalize_artifact_type("markdown") == ("output", "markdown")

    def test_output_without_format_gets_text(self):
        assert normalize_artifact_type("output") == ("output", "text")

    def test_code_without_format_gets_text(self):
        assert normalize_artifact_type("code") == ("code", "text")

    def test_code_with_python_preserved(self):
        assert normalize_artifact_type("code", "python") == ("code", "python")

    def test_output_with_format_preserved(self):
        assert normalize_artifact_type("output", "json") == ("output", "json")


class TestApplyNormalization:
    """Tests for apply_normalization in-place mutation."""

    def test_normalizes_legacy_console_in_place(self):
        payload = {"type": "console", "content": "log output"}
        apply_normalization(payload)
        assert payload["type"] == "output"
        assert payload["format"] == "console"

    def test_normalizes_computer_code_html_in_place(self):
        payload = {"type": "code", "format": "html", "role": "computer"}
        apply_normalization(payload)
        assert payload["type"] == "output"
        assert payload["format"] == "html"
