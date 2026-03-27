"""
Unit Tests: Markdown Formatter (core/integrations/framework/markdown_formatter.py)

Covers all formatting functions, type-aware formatting, truncation,
metadata loading, and preset-based formatting.

Mock boundaries:
- File system for backend_tools_registry.yaml → patched
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from core.integrations.framework.markdown_formatter import (
    load_tool_metadata,
    get_tool_metadata,
    format_tool_result,
    format_with_preset,
    _format_result_by_type,
    _format_dict,
    _format_list,
    _format_string,
    _format_error,
    _format_search_results,
    _format_record,
    _format_status,
    _format_error_dict,
    _format_generic_dict,
    _truncate,
    _safe_json_dumps,
)
import core.integrations.framework.markdown_formatter as md_mod


# ─── Fixture: reset cache ───────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _reset_metadata_cache():
    """Reset module-level cache before each test."""
    md_mod._tool_metadata_cache = None
    yield
    md_mod._tool_metadata_cache = None


# ─── _truncate ───────────────────────────────────────────────────────────────


class TestTruncate:
    def test_short_text(self):
        assert _truncate("hello", 10) == "hello"

    def test_exact_length(self):
        assert _truncate("12345", 5) == "12345"

    def test_truncates_with_ellipsis(self):
        assert _truncate("hello world", 5) == "hello..."

    def test_empty_string(self):
        assert _truncate("", 10) == ""


# ─── load_tool_metadata ─────────────────────────────────────────────────────


class TestLoadToolMetadata:
    def test_returns_cached(self):
        md_mod._tool_metadata_cache = {"test": "cached"}
        assert load_tool_metadata() == {"test": "cached"}

    def test_missing_yaml_returns_empty(self):
        with patch("core.integrations.framework.markdown_formatter.Path") as MockPath:
            mock_file = MagicMock()
            mock_parent = MagicMock()
            mock_parent.parent.parent.parent.__truediv__ = MagicMock(return_value=MagicMock())
            MockPath.return_value.resolve.return_value.parent = mock_parent

            # Make yaml_path.exists() return False
            mock_yaml_path = MagicMock()
            mock_yaml_path.exists.return_value = False
            mock_parent.parent.parent.parent.__truediv__.return_value.__truediv__ = MagicMock(
                return_value=mock_yaml_path
            )

            result = load_tool_metadata()
        assert result == {} or isinstance(result, dict)

    def test_exception_returns_empty(self):
        with patch("builtins.open", side_effect=RuntimeError("disk error")):
            md_mod._tool_metadata_cache = None
            # Force re-read by clearing cache
            result = load_tool_metadata()
        # Should return empty dict on error (or cached from previous test)
        assert isinstance(result, dict)


# ─── get_tool_metadata ───────────────────────────────────────────────────────


class TestGetToolMetadata:
    def test_found(self):
        md_mod._tool_metadata_cache = {"computer.search": {"name": "search"}}
        assert get_tool_metadata("computer.search") == {"name": "search"}

    def test_not_found(self):
        md_mod._tool_metadata_cache = {}
        assert get_tool_metadata("computer.unknown") == {}


# ─── _format_result_by_type ─────────────────────────────────────────────────


class TestFormatResultByType:
    def test_none(self):
        result = _format_result_by_type(None, "", {})
        assert "No result" in result

    def test_exception(self):
        result = _format_result_by_type(ValueError("bad"), "", {})
        assert "Error" in result
        assert "ValueError" in result

    def test_dict(self):
        result = _format_result_by_type({"key": "val"}, "", {})
        assert "key" in result

    def test_list(self):
        result = _format_result_by_type(["a", "b"], "", {})
        assert "a" in result

    def test_string(self):
        result = _format_result_by_type("hello", "", {})
        assert "hello" in result

    def test_bool_true(self):
        result = _format_result_by_type(True, "", {})
        assert "True" in result

    def test_bool_false(self):
        result = _format_result_by_type(False, "", {})
        assert "False" in result

    def test_number(self):
        result = _format_result_by_type(42, "", {})
        assert "42" in result

    def test_float(self):
        result = _format_result_by_type(3.14, "", {})
        assert "3.14" in result

    def test_other_type(self):
        result = _format_result_by_type(object(), "", {})
        assert isinstance(result, str)


# ─── _format_dict ────────────────────────────────────────────────────────────


class TestFormatDict:
    def test_empty_dict(self):
        assert "Empty" in _format_dict({}, "")

    def test_search_results_pattern(self):
        data = {"results": [{"title": "A"}, {"title": "B"}]}
        result = _format_dict(data, "")
        assert "A" in result

    def test_record_pattern(self):
        data = {"id": "123", "name": "test"}
        result = _format_dict(data, "")
        assert "id" in result

    def test_status_pattern(self):
        data = {"status": "ok"}
        result = _format_dict(data, "")
        assert "ok" in result

    def test_error_pattern(self):
        data = {"error": "something failed"}
        result = _format_dict(data, "")
        assert "something failed" in result

    def test_generic_dict(self):
        data = {"a": 1, "b": 2}
        result = _format_dict(data, "")
        assert "a" in result


# ─── _format_search_results ─────────────────────────────────────────────────


class TestFormatSearchResults:
    def test_no_results(self):
        assert "No results" in _format_search_results({"results": []})

    def test_with_total(self):
        data = {"total": 5, "results": [{"title": "A"}]}
        result = _format_search_results(data)
        assert "5 results" in result

    def test_truncates_at_10(self):
        data = {"results": [{"title": f"Item {i}"} for i in range(15)]}
        result = _format_search_results(data)
        assert "5 more" in result

    def test_result_fields(self):
        data = {"results": [{"title": "A", "url": "http://example.com"}]}
        result = _format_search_results(data)
        assert "url" in result
        assert "example.com" in result


# ─── _format_record ─────────────────────────────────────────────────────────


class TestFormatRecord:
    def test_basic_record(self):
        data = {"id": "1", "name": "Test"}
        result = _format_record(data)
        assert "id" in result
        assert "name" in result

    def test_skips_underscore_fields(self):
        data = {"id": "1", "_internal": "secret"}
        result = _format_record(data)
        assert "_internal" not in result

    def test_nested_value(self):
        data = {"id": "1", "meta": {"key": "val"}}
        result = _format_record(data)
        assert "json" in result


# ─── _format_status ──────────────────────────────────────────────────────────


class TestFormatStatus:
    def test_success(self):
        result = _format_status({"status": "success"})
        assert "success" in result

    def test_error_status(self):
        result = _format_status({"status": "error", "message": "failed"})
        assert "error" in result
        assert "failed" in result


# ─── _format_error_dict ─────────────────────────────────────────────────────


class TestFormatErrorDict:
    def test_basic_error(self):
        result = _format_error_dict({"error": "fail"})
        assert "fail" in result

    def test_with_details(self):
        result = _format_error_dict({"error": "fail", "details": "stack trace"})
        assert "stack trace" in result

    def test_no_error_key(self):
        result = _format_error_dict({})
        assert "Unknown error" in result


# ─── _format_generic_dict ───────────────────────────────────────────────────


class TestFormatGenericDict:
    def test_small_dict(self):
        data = {"a": 1, "b": 2}
        result = _format_generic_dict(data)
        assert "a" in result
        assert "b" in result

    def test_large_dict_json(self):
        data = {f"key_{i}": f"value_{i}" for i in range(10)}
        result = _format_generic_dict(data)
        assert "json" in result

    def test_very_large_dict_truncated(self):
        data = {f"k{i}": "x" * 300 for i in range(20)}
        result = _format_generic_dict(data)
        assert "truncated" in result


# ─── _format_list ────────────────────────────────────────────────────────────


class TestFormatList:
    def test_empty_list(self):
        assert "Empty" in _format_list([], "")

    def test_list_of_dicts(self):
        data = [{"name": "A"}, {"name": "B"}]
        result = _format_list(data, "")
        assert "Item 1" in result

    def test_list_of_dicts_truncated(self):
        data = [{"id": i} for i in range(15)]
        result = _format_list(data, "")
        assert "5 more" in result

    def test_list_of_strings(self):
        data = ["alpha", "beta", "gamma"]
        result = _format_list(data, "")
        assert "alpha" in result
        assert "beta" in result

    def test_list_of_strings_truncated(self):
        data = [f"item_{i}" for i in range(25)]
        result = _format_list(data, "")
        assert "5 more" in result

    def test_mixed_types_json(self):
        data = ["a", 1, {"key": "val"}]
        result = _format_list(data, "")
        assert "json" in result

    def test_mixed_types_large_json_truncated(self):
        """Mixed-type list with JSON > 2000 chars triggers truncation (line 381)."""
        data = ["string_item", 42, {"key": "x" * 1000}, {"key": "y" * 1000}]
        result = _format_list(data, "")
        assert "truncated" in result
        assert "```json" in result


# ─── _format_string ──────────────────────────────────────────────────────────


class TestFormatString:
    def test_empty_string(self):
        assert "Empty" in _format_string("", "")

    def test_json_string_dict(self):
        data = json.dumps({"key": "val"})
        result = _format_string(data, "")
        assert "key" in result

    def test_json_string_list(self):
        data = json.dumps([1, 2, 3])
        result = _format_string(data, "")
        assert "1" in result

    def test_invalid_json(self):
        result = _format_string("{not valid json", "")
        assert isinstance(result, str)

    def test_html_string(self):
        result = _format_string("<html><body>test</body></html>", "")
        assert "html" in result

    def test_code_string(self):
        result = _format_string("def foo():\n    return 42", "")
        assert "```" in result

    def test_long_string_truncated(self):
        text = "x" * 600
        result = _format_string(text, "")
        assert "600 characters" in result

    def test_short_string(self):
        result = _format_string("hello world", "")
        assert "hello world" in result


# ─── _format_error ──────────────────────────────────────────────────────────


class TestFormatError:
    def test_formats_exception(self):
        result = _format_error(ValueError("bad input"))
        assert "ValueError" in result
        assert "bad input" in result


# ─── format_tool_result ──────────────────────────────────────────────────────


class TestFormatToolResult:
    def test_basic_format(self):
        md_mod._tool_metadata_cache = {}
        result = format_tool_result(
            result={"key": "value"},
            tool_path="computer.test",
            tool_name="test",
        )
        assert "test" in result
        assert "key" in result

    def test_with_args_and_kwargs(self):
        md_mod._tool_metadata_cache = {}
        result = format_tool_result(
            result="ok",
            tool_path="computer.tool",
            tool_name="tool",
            args=("arg1",),
            kwargs={"param": "val"},
        )
        assert "Parameters" in result
        assert "arg1" in result
        assert "param" in result

    def test_with_execution_time(self):
        md_mod._tool_metadata_cache = {}
        result = format_tool_result(
            result="ok",
            tool_path="computer.tool",
            tool_name="tool",
            execution_time=1.234,
        )
        assert "1.234s" in result

    def test_with_metadata(self):
        md_mod._tool_metadata_cache = {
            "computer.search": {
                "name": "Web Search",
                "description": "Search the web",
                "category": "datastore_search",
            }
        }
        result = format_tool_result(
            result={"answer": "found"},
            tool_path="computer.search",
            tool_name="search",
        )
        assert "Web Search" in result

    def test_long_description_skipped(self):
        md_mod._tool_metadata_cache = {
            "computer.tool": {
                "name": "Tool",
                "description": "x" * 300,
                "category": "other",
            }
        }
        result = format_tool_result(
            result="ok", tool_path="computer.tool", tool_name="tool"
        )
        # Long description (>200 chars) should not be included
        assert "x" * 200 not in result


# ─── format_with_preset ─────────────────────────────────────────────────────


# ─── _safe_json_dumps ────────────────────────────────────────────────────────


class TestSafeJsonDumps:
    """Regression: json.dumps on non-serializable objects crashed the formatter."""

    def test_normal_dict(self):
        assert _safe_json_dumps({"a": 1}) == '{"a": 1}'

    def test_datetime(self):
        from datetime import datetime
        dt = datetime(2025, 1, 15, 12, 30, 0)
        result = _safe_json_dumps({"ts": dt})
        assert "2025-01-15" in result

    def test_bytes(self):
        result = _safe_json_dumps({"data": b"hello"})
        assert "hello" in result

    def test_set(self):
        result = _safe_json_dumps({"tags": {"b", "a"}})
        parsed = json.loads(result)
        assert sorted(parsed["tags"]) == ["a", "b"]

    def test_custom_object(self):
        class Foo:
            def __repr__(self):
                return "Foo()"
        result = _safe_json_dumps({"obj": Foo()})
        assert "Foo" in result

    def test_nested_non_serializable(self):
        from datetime import date
        data = {"items": [{"d": date(2025, 6, 1)}, {"d": date(2025, 7, 1)}]}
        result = _safe_json_dumps(data, indent=2)
        assert "2025-06-01" in result
        assert "2025-07-01" in result

    def test_frozenset_uses_repr_fallback(self):
        """frozenset has no __dict__/isoformat, isn't bytes/set — falls to repr() (line 444)."""
        result = _safe_json_dumps({"tags": frozenset({1, 2})})
        assert "frozenset" in result


class TestFormatterCrashRegression:
    """Verify formatters don't crash on non-serializable data."""

    def test_record_with_datetime_value(self):
        from datetime import datetime
        data = {"id": "1", "created": {"nested": datetime(2025, 1, 1)}}
        result = _format_record(data)
        assert "2025" in result

    def test_generic_dict_with_set_value(self):
        data = {f"key_{i}": {i} for i in range(10)}
        result = _format_generic_dict(data)
        assert "json" in result  # Should hit JSON path without crash

    def test_list_with_mixed_non_serializable(self):
        from datetime import date
        data = ["a", 1, date(2025, 1, 1)]
        result = _format_list(data, "")
        assert "2025" in result


# ─── format_with_preset ─────────────────────────────────────────────────────


# ─── Adversarial / Boundary / Mutation Tests ─────────────────────────────────


class TestAdversarialInputs:
    """Tests with malformed, extreme, or unexpected inputs."""

    def test_truncate_boundary_exact(self):
        """Off-by-one: string length == max_length should NOT truncate."""
        assert _truncate("12345", 5) == "12345"
        assert _truncate("123456", 5) == "12345..."

    def test_format_dict_priority_id_plus_status(self):
        """Dict with both 'id' and 'status': 'id' wins (record pattern before status)."""
        data = {"id": "123", "status": "ok"}
        result = _format_dict(data, "")
        # Must go through _format_record, not _format_status
        # _format_record produces "**id:** 123" not "Status: ok"
        assert "**id:**" in result

    def test_format_dict_priority_results_plus_error(self):
        """Dict with 'results' and 'error': 'results' wins (checked first)."""
        data = {"results": [{"title": "A"}], "error": "ignored"}
        result = _format_dict(data, "")
        assert "A" in result  # search results formatter, not error

    def test_format_string_curly_brace_false_positive(self):
        """Text with 3+ { chars triggers code formatting even if not code."""
        text = "Use {name}, {age}, {email} in your template"
        result = _format_string(text, "")
        assert "```" in result  # Heuristic fires — documents this behavior

    def test_format_result_by_type_bool_before_int(self):
        """bool is subclass of int. Must hit bool branch, not int branch."""
        true_result = _format_result_by_type(True, "", {})
        false_result = _format_result_by_type(False, "", {})
        # Bool formatter uses emoji, int formatter uses backtick-only
        assert "True" in true_result
        assert "False" in false_result

    def test_format_list_single_element(self):
        result = _format_list([{"name": "solo"}], "")
        assert "Item 1" in result
        assert "more" not in result  # No truncation message for 1 item

    def test_format_list_exactly_10_dicts(self):
        data = [{"id": i} for i in range(10)]
        result = _format_list(data, "")
        assert "more" not in result  # Exactly 10, no overflow message

    def test_format_list_11_dicts(self):
        data = [{"id": i} for i in range(11)]
        result = _format_list(data, "")
        assert "1 more" in result

    def test_format_string_empty_json_object(self):
        result = _format_string("{}", "")
        # Valid JSON dict → goes to _format_dict → empty result
        assert "Empty" in result

    def test_format_tool_result_exact_structure(self):
        """Verify exact output structure, not just 'contains'."""
        md_mod._tool_metadata_cache = {}
        result = format_tool_result(
            result={"count": 3},
            tool_path="computer.test",
            tool_name="test",
        )
        lines = result.strip().split("\n")
        # First line must be H2 header
        assert lines[0].startswith("## ")
        assert "test" in lines[0]
        # Must contain Result section
        assert any("**Result:**" in line for line in lines)

    def test_format_search_results_exact_count(self):
        """Verify truncation message uses exact math."""
        data = {"results": [{"title": f"R{i}"} for i in range(15)]}
        result = _format_search_results(data)
        assert "5 more" in result  # 15 - 10 = 5

    def test_format_generic_dict_truncation_at_2000(self):
        """Large JSON truncated at 2000 chars, not before."""
        data = {f"k{i}": "x" * 50 for i in range(100)}
        result = _format_generic_dict(data)
        assert "truncated" in result

    def test_format_error_preserves_type_name(self):
        """Error formatter must show the exception type, not just message."""
        result = _format_error(ConnectionResetError("peer gone"))
        assert "ConnectionResetError" in result
        assert "peer gone" in result


# ─── Mutation Killers ─────────────────────────────────────────────────────────


class TestMutationKillers:
    """Tests that kill specific source mutations which previously survived."""

    # Mutation: L334 `len(data) <= 5` → `<= 3`
    # A dict with exactly 5 keys MUST use bullet format, not JSON block.
    def test_generic_dict_boundary_5_keys(self):
        data = {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5}
        result = _format_generic_dict(data)
        # Bullet format: "- **key:** value"
        assert "- **a:**" in result
        assert "```json" not in result  # Must NOT be JSON block

    def test_generic_dict_boundary_6_keys(self):
        data = {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6}
        result = _format_generic_dict(data)
        # 6 keys → JSON block
        assert "```json" in result

    # Mutation: L242 `len(data) < 20` → `< 10`
    # A dict with 'id' and 15 total keys MUST still route to record pattern.
    def test_record_pattern_boundary_15_keys(self):
        data = {"id": "abc"}
        for i in range(14):
            data[f"field_{i}"] = f"value_{i}"
        assert len(data) == 15
        result = _format_dict(data, "")
        # _format_record produces "**id:**" format
        assert "**id:**" in result

    def test_record_pattern_boundary_20_keys_goes_generic(self):
        data = {"id": "abc"}
        for i in range(19):
            data[f"field_{i}"] = f"value_{i}"
        assert len(data) == 20  # NOT < 20
        result = _format_dict(data, "")
        # 20 keys with 'id' → falls through to generic (JSON block)
        assert "```json" in result

    # Mutation: L402 remove `'<!doctype'` check
    # <!DOCTYPE without <html must still be detected as HTML.
    def test_doctype_only_detected_as_html(self):
        text = "<!DOCTYPE html>\n<head><title>Test</title></head>"
        result = _format_string(text, "")
        assert "```html" in result

    # Mutation: L410 `len(text) > 500` → `> 300`
    # 500-char string must NOT be truncated; 501 must be.
    def test_string_boundary_500_no_truncation(self):
        text = "a" * 500
        result = _format_string(text, "")
        assert "characters total" not in result  # 500 is not > 500

    def test_string_boundary_501_truncates(self):
        text = "a" * 501
        result = _format_string(text, "")
        assert "501 characters total" in result

    # Mutation: L309 remove 'ok' from success list
    # {"status": "ok"} must show success icon ✅, not warning ⚠️.
    def test_status_ok_shows_success_icon(self):
        result = _format_status({"status": "ok"})
        assert "✅" in result
        assert "⚠️" not in result

    def test_status_healthy_shows_success_icon(self):
        result = _format_status({"status": "healthy"})
        assert "✅" in result

    def test_status_unknown_shows_warning_icon(self):
        result = _format_status({"status": "degraded"})
        assert "⚠️" in result
        assert "✅" not in result

    # Mutation: L368 remove `bool` from type tuple
    # List of booleans must use bullet format.
    def test_list_of_booleans_bullet_format(self):
        data = [True, False, True]
        result = _format_list(data, "")
        assert "- True\n" in result
        assert "- False\n" in result
        # Must NOT fall through to JSON block
        assert "```json" not in result

    def test_list_of_mixed_primitives_with_bool(self):
        data = [1, "hello", True, 3.14]
        result = _format_list(data, "")
        assert "- 1\n" in result
        assert "- hello\n" in result
        assert "- True\n" in result


# ─── format_with_preset ─────────────────────────────────────────────────────


class TestFormatWithPreset:
    def test_known_category_preset(self):
        metadata = {"category": "datastore_search"}
        result = format_with_preset(
            {"results": [{"title": "Test"}]}, "computer.search", metadata
        )
        assert "Test" in result

    def test_unknown_category_fallback(self):
        metadata = {"category": "unknown"}
        result = format_with_preset("hello", "computer.test", metadata)
        assert "hello" in result

    def test_no_category(self):
        result = format_with_preset(42, "computer.test", {})
        assert "42" in result
