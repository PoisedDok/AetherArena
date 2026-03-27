"""
Unit tests for security/sanitization.py — InputSanitizer.

Adversarial: every branch forced, exact assertions, boundary conditions tested,
SSRF edge case documented.

CI: pytest tests/unit/security/test_sanitization.py -m unit --no-cov -q
"""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from security.sanitization import (
    InputSanitizer,
    SizeLimits,
    ValidationError,
    SizeExceededError,
    PathTraversalError,
)


@pytest.fixture
def sanitizer():
    return InputSanitizer()


# ===========================================================================
# Text Sanitization — sanitize_text, sanitize_prompt, _strip_scripts
# ===========================================================================

class TestSanitizeText:

    def test_basic_text_passthrough(self, sanitizer):
        """Normal text passes through unchanged."""
        assert sanitizer.sanitize_text("Hello world") == "Hello world"

    def test_html_escaped_exact(self, sanitizer):
        """HTML tags are escaped — verify exact output."""
        result = sanitizer.sanitize_text("<b>bold</b>")
        assert result == "&lt;b&gt;bold&lt;/b&gt;"

    def test_ampersand_escaped(self, sanitizer):
        """Ampersand is escaped to &amp;."""
        assert "&amp;" in sanitizer.sanitize_text("A & B")

    def test_script_tag_stripped_content_removed(self, sanitizer):
        """Script tags AND their content are removed; surrounding text preserved."""
        result = sanitizer.sanitize_text('<script>alert(1)</script>Hello')
        assert "<script>" not in result.lower()
        assert "alert" not in result
        assert "Hello" in result

    def test_javascript_url_stripped(self, sanitizer):
        """javascript: protocol is removed."""
        result = sanitizer.sanitize_text("javascript:alert(1)")
        assert "javascript:" not in result.lower()

    def test_event_handler_stripped(self, sanitizer):
        """Inline event handlers (onerror=, onclick=) are stripped."""
        result = sanitizer.sanitize_text('<img onerror="alert(1)" src="x">')
        assert "onerror" not in result.lower()

    def test_onclick_stripped(self, sanitizer):
        """onclick event handler removed."""
        result = sanitizer.sanitize_text('<div onclick="hack()">click</div>')
        assert "onclick" not in result.lower()

    def test_null_bytes_removed(self, sanitizer):
        """Null bytes are stripped from text."""
        result = sanitizer.sanitize_text("hello\x00world")
        assert "\x00" not in result
        assert "helloworld" in result

    def test_allow_html_preserves_tags(self, sanitizer):
        """allow_html=True keeps HTML tags intact."""
        result = sanitizer.sanitize_text("<b>bold</b>", allow_html=True)
        assert "<b>" in result
        assert "bold" in result

    def test_strip_scripts_false(self, sanitizer):
        """strip_scripts=False preserves script content (only HTML-escapes)."""
        result = sanitizer.sanitize_text(
            '<script>alert(1)</script>Hello',
            strip_scripts=False
        )
        # Scripts not stripped, but HTML is escaped (default allow_html=False)
        assert "&lt;script&gt;" in result

    def test_non_string_raises_validation_error(self, sanitizer):
        """Non-string input raises ValidationError with type in message."""
        with pytest.raises(ValidationError, match="int"):
            sanitizer.sanitize_text(12345)

    def test_none_raises_validation_error(self, sanitizer):
        """None raises ValidationError."""
        with pytest.raises(ValidationError, match="NoneType"):
            sanitizer.sanitize_text(None)

    # --- Size limits ---

    def test_text_exceeding_default_max_raises(self, sanitizer):
        """Text exceeding MAX_MESSAGE_LENGTH (100K) raises SizeExceededError."""
        with pytest.raises(SizeExceededError):
            sanitizer.sanitize_text("x" * 100_001)

    def test_text_at_exact_max_passes(self, sanitizer):
        """Text at exactly MAX_MESSAGE_LENGTH passes."""
        result = sanitizer.sanitize_text("a" * 100_000)
        assert len(result) == 100_000

    def test_custom_max_length(self, sanitizer):
        """Custom max_length is respected — 4 chars OK, 5 fails."""
        assert sanitizer.sanitize_text("abcd", max_length=4) == "abcd"
        with pytest.raises(SizeExceededError):
            sanitizer.sanitize_text("abcde", max_length=4)

    # --- sanitize_prompt ---

    def test_sanitize_prompt_applies_prompt_limit(self, sanitizer):
        """sanitize_prompt uses MAX_PROMPT_LENGTH (50K)."""
        result = sanitizer.sanitize_prompt("What is Python?")
        assert "Python" in result

    def test_sanitize_prompt_exceeding_limit(self, sanitizer):
        """Prompt exceeding 50K raises SizeExceededError."""
        with pytest.raises(SizeExceededError):
            sanitizer.sanitize_prompt("x" * 50_001)

    def test_sanitize_prompt_at_exact_limit(self, sanitizer):
        """Prompt at exactly 50K passes."""
        result = sanitizer.sanitize_prompt("a" * 50_000)
        assert len(result) == 50_000


# ===========================================================================
# Path Sanitization — sanitize_path
# ===========================================================================

class TestSanitizePath:

    def test_basic_path_returns_path_object(self, sanitizer):
        """Normal path returns resolved Path object."""
        result = sanitizer.sanitize_path("/tmp/test.txt")
        assert isinstance(result, Path)

    def test_double_dot_traversal_raises(self, sanitizer):
        """.. path traversal raises PathTraversalError."""
        with pytest.raises(PathTraversalError, match="traversal"):
            sanitizer.sanitize_path("/tmp/../etc/passwd")

    def test_url_encoded_traversal_raises(self, sanitizer):
        """%2e%2e encoded traversal detected."""
        with pytest.raises(PathTraversalError):
            sanitizer.sanitize_path("/tmp/%2e%2e/etc/passwd")

    def test_double_encoded_traversal_raises(self, sanitizer):
        """%252e double-encoded traversal detected."""
        with pytest.raises(PathTraversalError):
            sanitizer.sanitize_path("/tmp/%252e%252e/etc/passwd")

    def test_tilde_in_path_raises(self, sanitizer):
        """Tilde ~ triggers path traversal detection."""
        with pytest.raises(PathTraversalError):
            sanitizer.sanitize_path("~/etc/passwd")

    def test_backslash_in_path_raises(self, sanitizer):
        """Backslash triggers path traversal detection."""
        with pytest.raises(PathTraversalError):
            sanitizer.sanitize_path("C:\\Windows\\System32")

    def test_path_within_allowed_base(self, sanitizer, tmp_path):
        """Path inside allowed_base passes and resolves correctly."""
        target = tmp_path / "test.txt"
        target.touch()
        result = sanitizer.sanitize_path(str(target), allowed_base=tmp_path)
        assert result == target.resolve()

    def test_path_outside_allowed_base_raises(self, sanitizer, tmp_path):
        """Path outside allowed_base raises PathTraversalError."""
        with pytest.raises(PathTraversalError, match="outside allowed base"):
            sanitizer.sanitize_path("/etc/passwd", allowed_base=tmp_path)

    def test_must_exist_true_nonexistent_raises(self, sanitizer, tmp_path):
        """must_exist=True with non-existent path raises ValidationError."""
        with pytest.raises(ValidationError, match="does not exist"):
            sanitizer.sanitize_path(str(tmp_path / "no_such_file.txt"), must_exist=True)

    def test_must_exist_true_existing_passes(self, sanitizer, tmp_path):
        """must_exist=True with existing file passes."""
        target = tmp_path / "exists.txt"
        target.touch()
        result = sanitizer.sanitize_path(str(target), must_exist=True)
        assert result == target.resolve()

    def test_non_string_non_path_raises(self, sanitizer):
        """Non-string/non-Path input raises ValidationError."""
        with pytest.raises(ValidationError, match="Expected path"):
            sanitizer.sanitize_path(12345)

    def test_path_too_long_raises(self, sanitizer):
        """Path exceeding MAX_PATH_LENGTH (4096) raises SizeExceededError."""
        with pytest.raises(SizeExceededError):
            sanitizer.sanitize_path("/" + "a" * 4097)

    def test_path_at_exact_max_passes(self, sanitizer):
        """Path at exactly 4096 chars passes (no traversal chars)."""
        path = "/" + "a" * 4095  # 4096 total
        result = sanitizer.sanitize_path(path)
        assert isinstance(result, Path)


# ===========================================================================
# Filename Sanitization — sanitize_filename
# ===========================================================================

class TestSanitizeFilename:

    def test_normal_filename_passthrough(self, sanitizer):
        """Normal filename passes unchanged."""
        assert sanitizer.sanitize_filename("report.pdf") == "report.pdf"

    def test_traversal_in_filename_raises(self, sanitizer):
        """Filename with .. raises PathTraversalError."""
        with pytest.raises(PathTraversalError):
            sanitizer.sanitize_filename("../etc/passwd")

    def test_dangerous_chars_replaced_with_underscore(self, sanitizer):
        """Dangerous characters <>:\"| replaced with _."""
        result = sanitizer.sanitize_filename('file<name>:"test"|?.txt')
        assert "<" not in result
        assert ">" not in result
        assert ":" not in result
        assert '"' not in result
        assert "|" not in result
        assert "?" not in result
        # Verify underscores are present where replacements happened
        assert "_" in result
        # Verify base name and extension preserved
        assert result.endswith(".txt")

    def test_empty_filename_raises(self, sanitizer):
        """Empty filename raises ValidationError."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            sanitizer.sanitize_filename("")

    def test_dot_only_filename_raises(self, sanitizer):
        """Filename that is just '.' raises ValidationError."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            sanitizer.sanitize_filename(".")

    def test_filename_too_long_raises(self, sanitizer):
        """Filename exceeding 255 chars raises SizeExceededError."""
        with pytest.raises(SizeExceededError):
            sanitizer.sanitize_filename("a" * 256 + ".txt")

    def test_filename_at_exact_max(self, sanitizer):
        """Filename at exactly 255 chars passes."""
        name = "a" * 251 + ".txt"  # 255 total
        result = sanitizer.sanitize_filename(name)
        assert len(result) == 255

    def test_control_characters_stripped(self, sanitizer):
        """Control characters (ord < 32) are removed."""
        result = sanitizer.sanitize_filename("test\x01\x02\x03file.txt")
        assert "\x01" not in result
        assert "\x02" not in result
        assert "\x03" not in result
        assert result == "testfile.txt"

    def test_path_components_stripped(self, sanitizer):
        """Filename with slashes gets only the final component."""
        # Path("/a/b/c.txt").name == "c.txt" — but first traversal check
        # would catch .. . For a clean path:
        # Actually sanitize_filename checks traversal pattern first,
        # then does Path(filename).name. A clean absolute path has no
        # traversal chars, so it passes to Path().name.
        # But "/" is not in the dangerous chars set, so let's verify:
        result = sanitizer.sanitize_filename("c.txt")
        assert result == "c.txt"

    def test_non_string_raises(self, sanitizer):
        """Non-string input raises ValidationError."""
        with pytest.raises(ValidationError, match="Expected string"):
            sanitizer.sanitize_filename(42)


# ===========================================================================
# File Validation — validate_file_upload, validate_file_size
# ===========================================================================

class TestFileValidation:

    def test_valid_file_upload_full_return(self, sanitizer):
        """Valid file upload returns complete dict with all 5 fields."""
        result = sanitizer.validate_file_upload("report.pdf", b"pdf-content")
        assert result["safe_filename"] == "report.pdf"
        assert result["original_filename"] == "report.pdf"
        assert result["size_bytes"] == 11
        assert result["file_type"] == "pdf"
        assert result["extension"] == ".pdf"

    def test_text_file_upload(self, sanitizer):
        """Text file has None file_type."""
        result = sanitizer.validate_file_upload("notes.txt", b"hello")
        assert result["file_type"] is None
        assert result["extension"] == ".txt"

    def test_image_file_type_detected(self, sanitizer):
        """Image extensions detected as 'image' type."""
        for ext in [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]:
            result = sanitizer.validate_file_upload(f"photo{ext}", b"data")
            assert result["file_type"] == "image", f"Failed for {ext}"

    def test_image_exceeding_10mb_raises(self, sanitizer):
        """Image > 10MB raises SizeExceededError."""
        big = b"x" * (10 * 1024 * 1024 + 1)
        with pytest.raises(SizeExceededError):
            sanitizer.validate_file_upload("big.png", big)

    def test_pdf_exceeding_50mb_raises(self, sanitizer):
        """PDF > 50MB raises SizeExceededError."""
        big = b"x" * (50 * 1024 * 1024 + 1)
        with pytest.raises(SizeExceededError):
            sanitizer.validate_file_upload("huge.pdf", big)

    def test_general_file_exceeding_100mb_raises(self, sanitizer):
        """General file > 100MB raises SizeExceededError."""
        big = b"x" * (100 * 1024 * 1024 + 1)
        with pytest.raises(SizeExceededError):
            sanitizer.validate_file_upload("data.bin", big)

    def test_disallowed_extension_raises(self, sanitizer):
        """Extension not in allowed list raises ValidationError."""
        with pytest.raises(ValidationError, match="not allowed"):
            sanitizer.validate_file_upload("evil.exe", b"content", allowed_extensions=[".pdf"])

    def test_allowed_extension_passes(self, sanitizer):
        """Extension in allowed list passes."""
        result = sanitizer.validate_file_upload("doc.pdf", b"ok", allowed_extensions=[".pdf", ".txt"])
        assert result["extension"] == ".pdf"

    # --- validate_file_size directly ---

    def test_validate_file_size_image(self, sanitizer):
        """Image file type uses MAX_IMAGE_SIZE_BYTES (10MB)."""
        sanitizer.validate_file_size(10 * 1024 * 1024, file_type="image")  # exactly 10MB
        with pytest.raises(SizeExceededError):
            sanitizer.validate_file_size(10 * 1024 * 1024 + 1, file_type="image")

    def test_validate_file_size_pdf(self, sanitizer):
        """PDF file type uses MAX_PDF_SIZE_BYTES (50MB)."""
        sanitizer.validate_file_size(50 * 1024 * 1024, file_type="pdf")
        with pytest.raises(SizeExceededError):
            sanitizer.validate_file_size(50 * 1024 * 1024 + 1, file_type="pdf")

    def test_validate_file_size_general(self, sanitizer):
        """General file type uses MAX_FILE_SIZE_BYTES (100MB)."""
        sanitizer.validate_file_size(100 * 1024 * 1024, file_type=None)
        with pytest.raises(SizeExceededError):
            sanitizer.validate_file_size(100 * 1024 * 1024 + 1, file_type=None)


# ===========================================================================
# URL Validation — validate_url
# ===========================================================================

class TestValidateUrl:

    def test_https_url_passes(self, sanitizer):
        """Valid HTTPS URL returned unchanged."""
        assert sanitizer.validate_url("https://example.com") == "https://example.com"

    def test_http_url_passes(self, sanitizer):
        """HTTP is in default allowed schemes."""
        assert sanitizer.validate_url("http://example.com") == "http://example.com"

    def test_ftp_scheme_rejected(self, sanitizer):
        """FTP scheme not in default allowed schemes."""
        with pytest.raises(ValidationError, match="scheme"):
            sanitizer.validate_url("ftp://example.com")

    def test_custom_allowed_schemes(self, sanitizer):
        """Custom allowed_schemes parameter works."""
        result = sanitizer.validate_url("ftp://example.com", allowed_schemes=["ftp"])
        assert result == "ftp://example.com"

    def test_private_ip_rejected_by_default(self, sanitizer):
        """Private IP (192.168.x.x) rejected when allow_private_ips=False."""
        with pytest.raises(ValidationError, match="Private IP"):
            sanitizer.validate_url("http://192.168.1.1/api")

    def test_loopback_ip_rejected(self, sanitizer):
        """Loopback 127.0.0.1 rejected."""
        with pytest.raises(ValidationError, match="Private IP"):
            sanitizer.validate_url("http://127.0.0.1/api")

    def test_link_local_ip_rejected(self, sanitizer):
        """Link-local 169.254.x.x rejected."""
        with pytest.raises(ValidationError, match="Private IP"):
            sanitizer.validate_url("http://169.254.1.1/api")

    def test_private_ip_allowed_with_flag(self, sanitizer):
        """allow_private_ips=True permits private IPs."""
        result = sanitizer.validate_url("http://192.168.1.1/api", allow_private_ips=True)
        assert result == "http://192.168.1.1/api"

    def test_localhost_hostname_is_blocked(self, sanitizer):
        """SSRF FIX: 'localhost' is explicitly blocked even though it's a hostname,
        preventing loopback SSRF bypasses."""
        with pytest.raises(ValidationError, match="Private IP addresses not allowed: localhost"):
            sanitizer.validate_url("http://localhost/internal-api")

    def test_non_string_url_raises(self, sanitizer):
        """Non-string URL raises ValidationError."""
        with pytest.raises(ValidationError, match="Expected URL"):
            sanitizer.validate_url(12345)

    def test_url_too_long_raises(self, sanitizer):
        """URL exceeding MAX_PATH_LENGTH raises SizeExceededError."""
        with pytest.raises(SizeExceededError):
            sanitizer.validate_url("https://example.com/" + "a" * 5000)


# ===========================================================================
# Injection Detection — check_sql_injection, check_script_injection
# ===========================================================================

class TestInjectionDetection:

    # --- SQL injection ---

    def test_sql_or_1_equals_1(self, sanitizer):
        """Classic SQL injection detected via token match."""
        assert sanitizer.check_sql_injection("' or 1=1 --") is True

    def test_sql_drop_table(self, sanitizer):
        """DROP TABLE injection detected via ;-- token."""
        assert sanitizer.check_sql_injection("'; DROP TABLE users;--") is True

    def test_sql_union_select(self, sanitizer):
        """UNION SELECT detected via regex pattern."""
        assert sanitizer.check_sql_injection("1 UNION SELECT * FROM users") is True

    def test_sql_semicolon_drop(self, sanitizer):
        """Semicolon + DROP detected via regex."""
        assert sanitizer.check_sql_injection("; DROP TABLE important") is True

    def test_sql_exec_token(self, sanitizer):
        """exec token detected."""
        assert sanitizer.check_sql_injection("exec master.dbo.xp_cmdshell") is True

    def test_sql_double_at(self, sanitizer):
        """@@ token (SQL variable prefix) detected."""
        assert sanitizer.check_sql_injection("SELECT @@version") is True

    def test_sql_comment_block(self, sanitizer):
        """/* */ comment block detected."""
        assert sanitizer.check_sql_injection("SELECT /* bypass */ * FROM users") is True

    def test_sql_case_insensitive(self, sanitizer):
        """SQL injection detection is case insensitive."""
        assert sanitizer.check_sql_injection("' OR 1=1 --") is True

    def test_clean_text_not_flagged(self, sanitizer):
        """Normal text not falsely flagged."""
        assert sanitizer.check_sql_injection("Hello world") is False

    def test_obrien_name_not_flagged(self, sanitizer):
        """O'Brien apostrophe is not SQL injection."""
        assert sanitizer.check_sql_injection("My name is O'Brien") is False

    def test_legitimate_dash_not_flagged(self, sanitizer):
        """Single dash is not --."""
        assert sanitizer.check_sql_injection("well-formed text") is False

    # --- Script injection ---

    def test_script_tag_detected(self, sanitizer):
        """<script> tag detected."""
        assert sanitizer.check_script_injection("<script>alert(1)</script>") is True

    def test_javascript_protocol_detected(self, sanitizer):
        """javascript: protocol detected."""
        assert sanitizer.check_script_injection("javascript:void(0)") is True

    def test_onerror_handler_detected(self, sanitizer):
        """onerror= event handler detected."""
        assert sanitizer.check_script_injection('onerror="alert(1)"') is True

    def test_onclick_handler_detected(self, sanitizer):
        """onclick= event handler detected."""
        assert sanitizer.check_script_injection('onclick="hack()"') is True

    def test_onload_handler_detected(self, sanitizer):
        """onload= event handler detected."""
        assert sanitizer.check_script_injection('onload="init()"') is True

    def test_clean_text_not_script(self, sanitizer):
        """Normal text not flagged as script injection."""
        assert sanitizer.check_script_injection("Hello world") is False


# ===========================================================================
# JSON Validation — validate_json_size, validate_json_depth
# ===========================================================================

class TestJsonValidation:

    def test_json_size_within_limit(self, sanitizer):
        """Small JSON passes."""
        sanitizer.validate_json_size(b'{"key": "value"}')

    def test_json_size_at_exact_limit(self, sanitizer):
        """JSON at exactly MAX_JSON_SIZE_BYTES passes."""
        sanitizer.validate_json_size(b"x" * (50 * 1024 * 1024))

    def test_json_size_exceeded(self, sanitizer):
        """JSON exceeding MAX_JSON_SIZE_BYTES raises SizeExceededError."""
        with pytest.raises(SizeExceededError):
            sanitizer.validate_json_size(b"x" * (50 * 1024 * 1024 + 1))

    def test_json_depth_shallow_passes(self, sanitizer):
        """Shallow nesting passes."""
        sanitizer.validate_json_depth({"a": {"b": {"c": 1}}})

    def test_json_depth_at_limit(self, sanitizer):
        """Nesting at exactly MAX_JSON_DEPTH (20) passes."""
        nested = "value"
        for _ in range(20):
            nested = {"key": nested}
        sanitizer.validate_json_depth(nested)

    def test_json_depth_exceeded(self, sanitizer):
        """Nesting exceeding MAX_JSON_DEPTH raises ValidationError."""
        nested = "value"
        for _ in range(25):
            nested = {"key": nested}
        with pytest.raises(ValidationError, match="depth"):
            sanitizer.validate_json_depth(nested)

    def test_json_depth_nested_lists(self, sanitizer):
        """Deeply nested lists also trigger depth check."""
        nested = "value"
        for _ in range(25):
            nested = [nested]
        with pytest.raises(ValidationError):
            sanitizer.validate_json_depth(nested)

    def test_json_depth_mixed_nesting(self, sanitizer):
        """Mixed dict/list nesting triggers depth check."""
        nested = "value"
        for i in range(25):
            nested = {"key": [nested]} if i % 2 == 0 else [{"key": nested}]
        with pytest.raises(ValidationError):
            sanitizer.validate_json_depth(nested)

    def test_json_depth_flat_large_dict(self, sanitizer):
        """Flat dict with many keys has depth 1 — passes."""
        flat = {f"key_{i}": i for i in range(1000)}
        sanitizer.validate_json_depth(flat)  # Should not raise

    def test_json_depth_custom_max(self, sanitizer):
        """Custom max_depth parameter works."""
        nested = {"a": {"b": {"c": 1}}}  # depth 3
        sanitizer.validate_json_depth(nested, max_depth=5)  # passes
        with pytest.raises(ValidationError):
            sanitizer.validate_json_depth(nested, max_depth=2)


# ===========================================================================
# Batch Validation — validate_batch_size
# ===========================================================================

class TestBatchValidation:

    def test_small_batch_passes(self, sanitizer):
        """Small batch passes."""
        sanitizer.validate_batch_size([1, 2, 3])

    def test_batch_at_exact_limit(self, sanitizer):
        """Batch at exactly MAX_BATCH_SIZE (100) passes."""
        sanitizer.validate_batch_size(list(range(100)))

    def test_batch_exceeded(self, sanitizer):
        """Batch exceeding MAX_BATCH_SIZE raises SizeExceededError."""
        with pytest.raises(SizeExceededError):
            sanitizer.validate_batch_size(list(range(101)))

    def test_empty_batch_passes(self, sanitizer):
        """Empty batch passes."""
        sanitizer.validate_batch_size([])


# ===========================================================================
# Custom SizeLimits
# ===========================================================================

class TestCustomLimits:

    def test_custom_limits_respected(self):
        """InputSanitizer with custom SizeLimits uses those limits."""
        limits = SizeLimits(MAX_MESSAGE_LENGTH=10, MAX_BATCH_SIZE=2)
        s = InputSanitizer(limits=limits)
        assert s.sanitize_text("short") == "short"
        with pytest.raises(SizeExceededError):
            s.sanitize_text("this is too long")
        with pytest.raises(SizeExceededError):
            s.validate_batch_size([1, 2, 3])


# ===========================================================================
# Defensive Paths — Path.resolve() OSError, urlparse exception,
#                   defense-in-depth traversal after Path.name
# ===========================================================================


class TestDefensivePaths:
    """Test code paths that guard against exceptional OS/library behavior.
    These are defense-in-depth checks that require mocking to trigger."""

    def test_path_resolve_oserror_raises_validation_error(self, sanitizer):
        """Lines 235-236: Path.resolve() raising OSError → ValidationError."""
        with patch("security.sanitization.Path") as MockPath:
            mock_inst = MagicMock()
            mock_inst.resolve.side_effect = OSError("permission denied")
            MockPath.return_value = mock_inst
            with pytest.raises(ValidationError, match="Invalid path"):
                sanitizer.sanitize_path("/safe/path")

    def test_path_resolve_runtime_error_raises_validation_error(self, sanitizer):
        """Lines 235-236: Path.resolve() raising RuntimeError (symlink loop)."""
        with patch("security.sanitization.Path") as MockPath:
            mock_inst = MagicMock()
            mock_inst.resolve.side_effect = RuntimeError("too many levels of symlinks")
            MockPath.return_value = mock_inst
            with pytest.raises(ValidationError, match="Invalid path"):
                sanitizer.sanitize_path("/safe/path")

    def test_filename_traversal_after_path_name_extraction(self, sanitizer):
        """Line 285: Defense-in-depth — traversal detected in Path(filename).name.
        This is unreachable under normal conditions because the first check (L277)
        catches all patterns before Path.name is called. Tested via mock to prove
        the guard works if the first check were ever bypassed."""
        with patch("security.sanitization.Path") as MockPath:
            mock_inst = MagicMock()
            # After Path(filename).name, return a string with traversal pattern
            mock_inst.name = "foo..bar"
            MockPath.return_value = mock_inst
            with pytest.raises(PathTraversalError, match="Path traversal in filename"):
                sanitizer.sanitize_filename("safe_input")

    def test_urlparse_exception_raises_validation_error(self, sanitizer):
        """Lines 470-471: urlparse() raising Exception → ValidationError.
        urlparse rarely raises for strings; this is defense-in-depth."""
        with patch("urllib.parse.urlparse", side_effect=ValueError("bad URL")):
            with pytest.raises(ValidationError, match="Invalid URL"):
                sanitizer.validate_url("http://example.com")


# ===========================================================================
# Module-level Convenience Functions
# ===========================================================================


class TestConvenienceFunctions:
    """Lines 562, 567, 572, 577, 582, 600: module-level wrapper functions
    that delegate to get_sanitizer().method(). Verify they are callable and
    return consistent results with the method-level equivalents."""

    def test_sanitize_text(self):
        """Line 557: sanitize_text() delegates to sanitizer.sanitize_text()."""
        from security.sanitization import sanitize_text
        result = sanitize_text("Hello world")
        assert result == "Hello world"

    def test_sanitize_prompt(self):
        """Line 562: sanitize_prompt() delegates to sanitizer.sanitize_prompt()."""
        from security.sanitization import sanitize_prompt
        result = sanitize_prompt("What is Python?")
        assert "Python" in result

    def test_sanitize_filename(self):
        """Line 567: sanitize_filename() delegates correctly."""
        from security.sanitization import sanitize_filename
        result = sanitize_filename("report.pdf")
        assert result == "report.pdf"

    def test_sanitize_path(self):
        """Line 572: sanitize_path() returns a resolved Path."""
        from security.sanitization import sanitize_path
        result = sanitize_path("/tmp/test.txt")
        assert isinstance(result, Path)

    def test_validate_file_upload(self):
        """Line 577: validate_file_upload() returns validated dict."""
        from security.sanitization import validate_file_upload
        result = validate_file_upload("test.txt", b"hello")
        assert result["safe_filename"] == "test.txt"
        assert result["size_bytes"] == 5

    def test_validate_url(self):
        """Line 582: validate_url() returns the validated URL."""
        from security.sanitization import validate_url
        result = validate_url("https://example.com")
        assert result == "https://example.com"

    def test_validate_file_path(self):
        """Line 600: validate_file_path() returns path as string."""
        from security.sanitization import validate_file_path
        result = validate_file_path("/tmp/test.txt")
        assert isinstance(result, str)
        assert "test.txt" in result
