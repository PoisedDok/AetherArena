"""
Tests for utils/validation.py — convenience wrapper coverage.

The underlying sanitization logic is tested in tests/unit/security/test_sanitization.py.
These tests verify that the convenience wrappers correctly delegate to InputSanitizer.
"""

from unittest.mock import MagicMock, patch


class TestValidateFileSize:
    """Coverage for lines 218-219: validate_file_size wrapper."""

    def test_delegates_to_sanitizer(self):
        mock_sanitizer = MagicMock()
        with patch("utils.validation.get_sanitizer", return_value=mock_sanitizer):
            from utils.validation import validate_file_size
            validate_file_size(1024, file_type="image")
            mock_sanitizer.validate_file_size.assert_called_once_with(
                1024, file_type="image"
            )

    def test_no_file_type(self):
        mock_sanitizer = MagicMock()
        with patch("utils.validation.get_sanitizer", return_value=mock_sanitizer):
            from utils.validation import validate_file_size
            validate_file_size(2048)
            mock_sanitizer.validate_file_size.assert_called_once_with(
                2048, file_type=None
            )


class TestValidateJsonSize:
    """Coverage for lines 292-293: validate_json_size wrapper."""

    def test_delegates_to_sanitizer(self):
        mock_sanitizer = MagicMock()
        with patch("utils.validation.get_sanitizer", return_value=mock_sanitizer):
            from utils.validation import validate_json_size
            payload = b'{"key": "value"}'
            validate_json_size(payload)
            mock_sanitizer.validate_json_size.assert_called_once_with(payload)


class TestValidateBatchSize:
    """Coverage for lines 313-314: validate_batch_size wrapper."""

    def test_delegates_to_sanitizer(self):
        mock_sanitizer = MagicMock()
        with patch("utils.validation.get_sanitizer", return_value=mock_sanitizer):
            from utils.validation import validate_batch_size
            items = [1, 2, 3, 4, 5]
            validate_batch_size(items)
            mock_sanitizer.validate_batch_size.assert_called_once_with(items)


class TestCreateCustomSanitizer:
    """Coverage for line 380: create_custom_sanitizer wrapper."""

    def test_creates_with_custom_limits(self):
        from utils.validation import SizeLimits, create_custom_sanitizer
        limits = SizeLimits()
        result = create_custom_sanitizer(limits)
        # InputSanitizer is created with the provided limits
        assert result is not None
        assert hasattr(result, "sanitize_text")
        assert hasattr(result, "validate_file_size")
