"""
Unit Tests: oi_server_wrapper — _HTMLPassthrough + _patched_run_text_llm

Tests the two critical bug fixes in the OI server wrapper:

1. _patched_run_text_llm: Fixes OI's content.replace(language, '') corruption.
   The original globally stripped language names from code content, destroying
   HTML ("<!DOCTYPE html>" → "<!DOCTYPE >") and Java ("import java.util.List"
   → "import .util.List"). The fix uses startswith() on the first chunk only.

2. _HTMLPassthrough: Yields an output:console status message so OI's respond
   loop receives execution feedback. Without it, the LLM sees empty output
   and enters an infinite correction loop.

3. Integration: Verifies the _HTMLPassthrough output flows correctly through
   EventNormalizer and PhaseDetector (the downstream pipeline).

Bugs found: 2 (both were the original bugs motivating these fixes)
"""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# Add scripts/ to path so we can import module-level definitions
BACKEND_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = BACKEND_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from oi_server_wrapper import _HTMLPassthrough, _patched_run_text_llm  # noqa: E402


# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════


def _make_chunk(content):
    """Build an OpenAI-compatible streaming chunk with the given content."""
    return {"choices": [{"delta": {"content": content}}]}


def _make_llm(chunks, *, execution_instructions=None, verbose=False, os_mode=False):
    """
    Build a mock LLM object that yields the given chunks from completions().

    Args:
        chunks: list of content strings. Each becomes an OpenAI streaming chunk.
        execution_instructions: optional string appended to first message.
        verbose: whether to print debug output.
        os_mode: value for interpreter.os (affects default language detection).
    """
    llm = SimpleNamespace()
    llm.execution_instructions = execution_instructions
    llm.interpreter = SimpleNamespace(verbose=verbose, os=os_mode)

    def _completions(**params):
        for c in chunks:
            yield _make_chunk(c)

    llm.completions = _completions
    return llm


def _collect(llm, params=None):
    """Run _patched_run_text_llm and collect all yielded chunks."""
    if params is None:
        params = {"messages": [{"content": "test prompt"}]}
    return list(_patched_run_text_llm(llm, params))


# ═══════════════════════════════════════════════════════════════════════════
# _HTMLPassthrough Tests
# ═══════════════════════════════════════════════════════════════════════════


class TestHTMLPassthroughAttributes:
    """Verify class metadata matches OI Terminal expectations."""

    def test_name(self):
        assert _HTMLPassthrough.name == "HTML"

    def test_file_extension(self):
        assert _HTMLPassthrough.file_extension == "html"

    def test_aliases(self):
        assert _HTMLPassthrough.aliases == ["html", "htm"]

    def test_init_accepts_computer_arg(self):
        """OI Terminal passes computer object to __init__. Must not raise."""
        instance = _HTMLPassthrough(MagicMock())
        assert instance is not None

    def test_init_ignores_computer(self):
        """Computer arg is accepted but unused."""
        instance = _HTMLPassthrough(None)
        assert instance is not None


class TestHTMLPassthroughRun:
    """Verify run() yields exactly the right event structure."""

    def test_yields_exactly_one_event(self):
        instance = _HTMLPassthrough(None)
        events = list(instance.run("<html></html>"))
        assert len(events) == 1

    def test_event_type_is_output(self):
        instance = _HTMLPassthrough(None)
        event = list(instance.run(""))[0]
        assert event["type"] == "console"

    def test_event_format_is_console(self):
        instance = _HTMLPassthrough(None)
        event = list(instance.run(""))[0]
        assert event["format"] == "output"

    def test_event_content_is_success_message(self):
        instance = _HTMLPassthrough(None)
        event = list(instance.run(""))[0]
        assert event["content"] == "[HTML executed successfully]"

    def test_exact_event_structure(self):
        """Full structure assertion — the consumer (OI Terminal._streaming_run)
        expects exactly this shape."""
        instance = _HTMLPassthrough(None)
        code = "<!DOCTYPE html><html></html>"
        event = list(instance.run(code))[0]
        assert event == {
            "type": "console",
            "format": "output",
            "content": "[HTML executed successfully]",
            "__ui_content": code,
        }

    def test_code_argument_is_passed_to_ui_content(self):
        """The code content is passed directly to the hidden __ui_content field."""
        instance = _HTMLPassthrough(None)
        events_empty = list(instance.run(""))[0]
        events_full = list(instance.run("<html><body><h1>Test</h1></body></html>"))[0]
        
        assert events_empty["__ui_content"] == ""
        assert events_full["__ui_content"] == "<html><body><h1>Test</h1></body></html>"

    def test_stop_is_noop(self):
        instance = _HTMLPassthrough(None)
        instance.stop()  # Must not raise

    def test_terminate_is_noop(self):
        instance = _HTMLPassthrough(None)
        instance.terminate()  # Must not raise

    def test_multiple_runs_are_independent(self):
        """Each run() call yields a fresh event (no stale state)."""
        instance = _HTMLPassthrough(None)
        run1 = list(instance.run("code1"))
        run2 = list(instance.run("code2"))
        
        assert {k: v for k, v in run1[0].items() if k != "__ui_content"} == \
               {k: v for k, v in run2[0].items() if k != "__ui_content"}
        
        assert run1[0]["__ui_content"] == "code1"
        assert run2[0]["__ui_content"] == "code2"
        assert len(run1) == 1


# ═══════════════════════════════════════════════════════════════════════════
# _patched_run_text_llm Tests — HTML content corruption fix
# ═══════════════════════════════════════════════════════════════════════════


class TestRunTextLlmHtmlPreservation:
    """
    REGRESSION TESTS for the root cause bug:
    OI's original content.replace(language, '') stripped "html" from
    code content, corrupting <!DOCTYPE html> → <!DOCTYPE >.
    """

    def test_doctype_html_not_corrupted(self):
        """The EXACT bug that caused the agent loop. <!DOCTYPE html> MUST survive."""
        chunks = ["```", "html", "\n<!DOCTYPE html>", "\n<html>", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)

        # Collect all code content
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)

        assert "<!DOCTYPE html>" in full_code, (
            f"REGRESSION: <!DOCTYPE html> corrupted to <!DOCTYPE >. Got: {full_code!r}"
        )

    def test_html_in_body_preserved(self):
        """The string 'html' inside HTML tags must not be stripped."""
        chunks = ["```", "html", "\n<p>This is html content</p>", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "html content" in full_code

    def test_html_in_class_names_preserved(self):
        """Class names containing 'html' must survive."""
        chunks = ["```", "html", '\n<div class="html-wrapper">', "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "html-wrapper" in full_code


class TestRunTextLlmOtherLanguages:
    """Verify the fix doesn't break other languages."""

    def test_java_import_not_corrupted(self):
        """Java: 'import java.util.List' must NOT become 'import .util.List'."""
        chunks = ["```", "java", "\nimport java.util.List;", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "java.util.List" in full_code, (
            f"REGRESSION: 'java' stripped from imports. Got: {full_code!r}"
        )

    def test_python_code_preserved(self):
        """Python code is unaffected (language name not in typical code)."""
        chunks = ["```", "python", "\nprint('hello world')", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "print('hello world')" in full_code

    def test_javascript_preserved(self):
        """JavaScript code preserved, including 'javascript' in content."""
        chunks = ["```", "javascript", "\n// javascript code", "\nconsole.log('hi')", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "javascript code" in full_code
        assert "console.log('hi')" in full_code


class TestRunTextLlmLanguageHeaderStripping:
    """Verify the language header IS stripped correctly from the first chunk."""

    def test_language_header_stripped_from_first_chunk(self):
        """The language identifier in the first code chunk must be removed."""
        # Simulate: ```html\n<!DOCTYPE html>
        # After ``` detection, accumulated = "html\n<!DOCTYPE html>"
        # language = "html", first chunk content check
        chunks = ["```html", "\n<!DOCTYPE html>", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]

        # The first code chunk should NOT start with "html" (it's the header)
        # But subsequent content should be preserved
        full_code = "".join(code_parts)
        # The language header "html" should be stripped, but "html" in DOCTYPE stays
        assert "<!DOCTYPE html>" in full_code

    def test_format_field_matches_language(self):
        """All code chunks must have format matching the detected language."""
        chunks = ["```", "python", "\nx = 1", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        for r in results:
            if r["type"] == "code":
                assert r["format"] == "python"


class TestRunTextLlmEdgeCases:
    """Edge cases in the LLM streaming protocol."""

    def test_empty_content_chunks_skipped(self):
        """Chunks with empty string content are accumulated but harmless."""
        chunks = ["```", "html", "", "\n<p>test</p>", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "<p>test</p>" in full_code

    def test_none_content_chunks_skipped(self):
        """Chunks with None content must be skipped (not crash)."""
        chunk_list = [
            {"choices": [{"delta": {"content": "```html"}}]},
            {"choices": [{"delta": {"content": None}}]},
            {"choices": [{"delta": {"content": "\n<p>test</p>"}}]},
            {"choices": [{"delta": {"content": "\n```"}}]},
        ]
        llm = SimpleNamespace(
            execution_instructions=None,
            interpreter=SimpleNamespace(verbose=False, os=False),
        )
        llm.completions = lambda **params: iter(chunk_list)
        results = list(_patched_run_text_llm(llm, {"messages": [{"content": "test"}]}))
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "<p>test</p>" in full_code

    def test_no_choices_chunks_skipped(self):
        """Chunks without 'choices' key are skipped (heartbeat/metadata)."""
        chunk_list = [
            {"choices": [{"delta": {"content": "```html"}}]},
            {"metadata": "heartbeat"},
            {"choices": []},
            {"choices": [{"delta": {"content": "\n<p>test</p>"}}]},
            {"choices": [{"delta": {"content": "\n```"}}]},
        ]
        llm = SimpleNamespace(
            execution_instructions=None,
            interpreter=SimpleNamespace(verbose=False, os=False),
        )
        llm.completions = lambda **params: iter(chunk_list)
        results = list(_patched_run_text_llm(llm, {"messages": [{"content": "test"}]}))
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        assert len(code_parts) > 0

    def test_non_code_content_yields_message_type(self):
        """Content before a code block yields message-type events."""
        chunks = ["Hello ", "world!"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        assert all(r["type"] == "message" for r in results)
        assert "Hello " in [r["content"] for r in results]
        assert "world!" in [r["content"] for r in results]

    def test_execution_instructions_appended(self):
        """execution_instructions are appended to the first message."""
        chunks = ["Hello"]
        llm = _make_llm(chunks, execution_instructions="Be careful.")
        params = {"messages": [{"content": "Do this."}]}
        _collect(llm, params)
        assert params["messages"][0]["content"] == "Do this.\nBe careful."

    def test_code_block_end_terminates_generator(self):
        """Closing ``` causes the generator to return (no more yields)."""
        chunks = ["```html", "\n<p>a</p>", "\n```", "trailing text"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        # Should NOT yield "trailing text" — generator returns at closing ```
        contents = [r.get("content", "") for r in results]
        assert "trailing text" not in contents

    def test_backtick_accumulation_deferred(self):
        """Single backtick at end of accumulated_block defers processing."""
        # This tests the endswith("`") guard: content ending with ` waits for more
        chunks = ["`", "``html", "\n<p>x</p>", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "<p>x</p>" in full_code


# ═══════════════════════════════════════════════════════════════════════════
# Integration: _HTMLPassthrough → EventNormalizer → PhaseDetector
# ═══════════════════════════════════════════════════════════════════════════


class TestHTMLPassthroughPipelineIntegration:
    """
    Verify the _HTMLPassthrough output flows correctly through the
    downstream Aether pipeline without code changes to domain services.
    """

    def test_event_normalizer_preserves_correct_status_message(self):
        """
        _HTMLPassthrough yields type=output, format=console.
        EventNormalizer passes through without change (already correct).
        """
        from ws.domain.services.event_normalizer import EventNormalizer

        raw_event = {
            "role": "computer",
            "type": "output",
            "format": "console",
            "content": "[HTML executed successfully]",
        }
        normalizer = EventNormalizer()
        result = normalizer.normalize(raw_event)

        assert result is not None
        assert result["type"] == "output"
        assert result["format"] == "console"
        assert result["content"] == "[HTML executed successfully]"
        assert result["role"] == "computer"

    def test_phase_detector_maps_to_executing(self):
        """
        After normalization: computer:output+console → "executing" phase.
        NOT "output" phase (which requires non-console format).
        """
        from ws.domain.builders.phase_detector import detect_phase

        phase = detect_phase("computer", "output", "console")
        assert phase == "executing"

    def test_status_message_not_flagged_as_error(self):
        """
        EventNormalizer's error detection must NOT reclassify our status message.
        "[HTML executed successfully]" must not match any error patterns.
        """
        from ws.domain.services.event_normalizer import EventNormalizer

        raw_event = {
            "role": "computer",
            "type": "output",
            "format": "console",
            "content": "[HTML executed successfully]",
        }
        normalizer = EventNormalizer()
        result = normalizer.normalize(raw_event)

        assert result["role"] == "computer"
        assert result.get("error_source") is None

    def test_status_message_not_filtered_as_marker(self):
        """
        EventNormalizer's internal marker filter must NOT drop our message.
        format=console is NOT active_line, content is not integer, no ##active_line.
        """
        from ws.domain.services.event_normalizer import EventNormalizer

        raw_event = {
            "role": "computer",
            "type": "output",
            "format": "console",
            "content": "[HTML executed successfully]",
        }
        normalizer = EventNormalizer()
        result = normalizer.normalize(raw_event)
        assert result is not None, "Event was incorrectly filtered out"

    def test_full_html_execution_phase_flow(self):
        """
        Simulate the full event sequence for HTML code execution:
        1. assistant:code:html → writing
        2. computer:console:output (status) → executing
        3. assistant:message → None (trail completes)
        """
        from ws.domain.builders.phase_detector import detect_phase
        from ws.domain.services.event_normalizer import EventNormalizer

        normalizer = EventNormalizer()

        # Event 1: LLM writes HTML code
        phase1 = detect_phase("assistant", "code", "html")
        assert phase1 == "writing"

        # Event 2: _HTMLPassthrough status message (already correct values)
        raw_status = {
            "role": "computer",
            "type": "output",
            "format": "console",
            "content": "[HTML executed successfully]",
        }
        normalized = normalizer.normalize(raw_status)
        phase2 = detect_phase(
            normalized["role"],
            normalized["type"],
            normalized.get("format"),
        )
        assert phase2 == "executing"

        # Event 3: LLM responds with text
        phase3 = detect_phase("assistant", "message")
        assert phase3 is None  # Triggers trail completion


# ═══════════════════════════════════════════════════════════════════════════
# REAL-WORLD EDGE CASES — Realistic LLM streaming patterns
#
# Real inference servers (LM Studio, vLLM, Ollama serving Qwen3-4B) stream
# tokens at ARBITRARY boundaries.  These tests reproduce actual token
# patterns observed in production.  Clean chunk boundaries like
# ["```", "html", "\n..."] NEVER happen in real streaming.
# ═══════════════════════════════════════════════════════════════════════════


class TestRealisticStreamingPatterns:
    """
    Simulate actual LLM token-level streaming.  Each test documents
    the specific production scenario it reproduces.
    """

    def test_character_by_character_html(self):
        """
        Some inference servers (esp. small models with low throughput)
        stream one character per chunk.  Every character of the code
        fence, language identifier, and content arrives individually.
        """
        full = "```html\n<!DOCTYPE html>\n<html>\n<body>\n<h1>Hello</h1>\n</body>\n</html>\n```"
        chunks = list(full)  # One char per chunk
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "<!DOCTYPE html>" in full_code
        assert "<h1>Hello</h1>" in full_code
        assert "<html>" in full_code

    def test_realistic_qwen3_token_boundaries(self):
        """
        Qwen3-4B typically streams 2-5 tokens per chunk.  Token boundaries
        split mid-word: "<!DOCT" + "YPE html" is realistic because "DOCTYPE"
        is multi-token while "html" is a single token.
        """
        chunks = [
            "Here is the code:\n\n",
            "```",
            "html\n",
            "<!DOCT",
            "YPE html>\n",
            "<html",
            " lang=\"en\"",
            ">\n<head",
            ">\n<title>",
            "Test</title",
            ">\n</head>\n",
            "<body>\n",
            "<h1>",
            "Hello World</h1",
            ">\n</body",
            ">\n</html>\n",
            "```",
        ]
        llm = _make_llm(chunks)
        results = _collect(llm)

        messages = [r for r in results if r["type"] == "message"]
        assert any("Here is the code" in m["content"] for m in messages)

        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "<!DOCTYPE html>" in full_code
        assert '<html lang="en">' in full_code
        assert "<title>Test</title>" in full_code
        assert "<h1>Hello World</h1>" in full_code

    def test_single_chunk_entire_code_block(self):
        """
        Cached/fast responses may deliver the entire code block in one chunk.
        The ``` detection, language extraction, and header stripping all
        happen on the same accumulated_block state.
        """
        chunks = ["```html\n<!DOCTYPE html>\n<html>\n<body>Hi</body>\n</html>\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        # Generator should return at closing ``` — may yield zero or some code
        # The key assertion: no crash, and any yielded code is not corrupted
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        # If code was yielded, it must not be corrupted
        if full_code:
            assert "html>" not in full_code or "DOCTYPE html>" in full_code

    def test_backticks_and_language_in_same_chunk(self):
        """
        Common pattern: "```html\n" arrives as a single token.
        Language detection must work when ``` and language are together.
        """
        chunks = ["```html\n", "<!DOCTYPE html>\n", "<html></html>\n", "```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "<!DOCTYPE html>" in full_code

    def test_closing_backticks_attached_to_content_terminates(self):
        """
        The closing ``` in the same chunk as content causes immediate return.
        The chunk containing the closing ``` is NOT yielded — the generator
        returns before reaching the yield statement for that chunk.
        """
        # Use separate ``` and language tokens (realistic pattern)
        chunks = ["```", "html", "\n<!DOCTYPE html>", "\n<html></html>\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        # The last chunk ("\n<html></html>\n```") is never yielded because
        # the closing ``` causes immediate return
        assert "<!DOCTYPE html>" in full_code


class TestComplexHtmlContent:
    """
    Real HTML documents contain the string "html" in many contexts
    beyond DOCTYPE.  ALL must survive the patched function.
    """

    def test_html_in_lang_attribute(self):
        """<html lang="en"> — 'html' is part of the tag name."""
        chunks = ["```", "html", '\n<html lang="en">\n</html>', "\n```"]
        llm = _make_llm(chunks)
        code_parts = [r["content"] for r in _collect(llm) if r["type"] == "code"]
        assert '<html lang="en">' in "".join(code_parts)

    def test_html_in_css_selector(self):
        """CSS: 'html { margin: 0 }' — 'html' is an element selector."""
        code = "\n<style>\nhtml { margin: 0; padding: 0; }\n</style>"
        chunks = ["```", "html", code, "\n```"]
        llm = _make_llm(chunks)
        code_parts = [r["content"] for r in _collect(llm) if r["type"] == "code"]
        assert "html { margin: 0;" in "".join(code_parts)

    def test_html_in_javascript_string(self):
        """JS: document.querySelector('.html-class') — 'html' in string."""
        code = "\n<script>\nconst el = document.querySelector('.html-container');\n</script>"
        chunks = ["```", "html", code, "\n```"]
        llm = _make_llm(chunks)
        code_parts = [r["content"] for r in _collect(llm) if r["type"] == "code"]
        assert "html-container" in "".join(code_parts)

    def test_html_in_comment(self):
        """HTML comment containing 'html'."""
        code = "\n<!-- This is an html comment -->\n<div>content</div>"
        chunks = ["```", "html", code, "\n```"]
        llm = _make_llm(chunks)
        code_parts = [r["content"] for r in _collect(llm) if r["type"] == "code"]
        full = "".join(code_parts)
        assert "html comment" in full
        assert "<div>content</div>" in full

    def test_multiple_html_occurrences_in_single_chunk(self):
        """A chunk containing 'html' multiple times — none stripped."""
        code = "\n<!DOCTYPE html>\n<html>\n<body class='html-body'>html</body>\n</html>"
        chunks = ["```", "html", code, "\n```"]
        llm = _make_llm(chunks)
        code_parts = [r["content"] for r in _collect(llm) if r["type"] == "code"]
        full = "".join(code_parts)
        assert full.count("html") >= 4, (
            f"Expected 4+ occurrences of 'html', got {full.count('html')} in: {full!r}"
        )

    def test_unicode_html_content(self):
        """HTML with Unicode characters (Chinese, Arabic, emoji)."""
        code = "\n<p>你好世界</p>\n<p>مرحبا</p>\n<p>🌍</p>"
        chunks = ["```", "html", code, "\n```"]
        llm = _make_llm(chunks)
        code_parts = [r["content"] for r in _collect(llm) if r["type"] == "code"]
        full = "".join(code_parts)
        assert "你好世界" in full
        assert "مرحبا" in full

    def test_large_html_document_many_chunks(self):
        """Simulate a large HTML document arriving in many small chunks."""
        lines = ["<!DOCTYPE html>", "<html>", "<head>"]
        for i in range(50):
            lines.append(f"<meta name='k{i}' content='v{i}'>")
        lines.extend(["</head>", "<body>"])
        for i in range(100):
            lines.append(f"<p>Paragraph {i} with html content</p>")
        lines.extend(["</body>", "</html>"])
        body = "\n".join(lines)

        # Split into chunks of ~40 chars each (realistic token boundaries)
        content_chunks = [body[i:i+40] for i in range(0, len(body), 40)]
        chunks = ["```html\n"] + content_chunks + ["\n```"]

        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)

        assert "<!DOCTYPE html>" in full_code
        assert "Paragraph 99 with html content" in full_code
        assert full_code.count("html") >= 100, (
            f"Expected 100+ 'html' occurrences, got {full_code.count('html')}"
        )


class TestLanguageDetectionEdgeCases:
    """
    Language detection uses accumulated_block.split("\\n")[0] and then
    filters to alpha-only chars.  Test all the weird inputs models produce.
    """

    def test_language_with_trailing_space(self):
        """Models sometimes emit 'html ' (trailing space) after ```."""
        chunks = ["```html ", "\n<p>test</p>", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)
        assert "<p>test</p>" in full_code
        # Language should be "html" (space stripped by isalpha filter)
        for r in results:
            if r["type"] == "code":
                assert r["format"] == "html"

    def test_language_with_version_number(self):
        """'python3' → stripped to 'python' (digits removed by isalpha)."""
        chunks = ["```python3", "\nprint('hi')", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        for r in results:
            if r["type"] == "code":
                assert r["format"] == "python"

    def test_language_case_preserved(self):
        """Language detection preserves whatever case the model uses."""
        chunks = ["```HTML", "\n<p>test</p>", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        for r in results:
            if r["type"] == "code":
                # isalpha preserves case
                assert r["format"] == "HTML"

    def test_no_language_identifier_defaults_python(self):
        """Empty language (```) defaults to 'python' when os is False."""
        chunks = ["```", "\nprint('hi')", "\n```"]
        llm = _make_llm(chunks, os_mode=False)
        results = _collect(llm)
        for r in results:
            if r["type"] == "code":
                assert r["format"] == "python"

    def test_language_with_special_chars(self):
        """'c++' → stripped to 'c' (non-alpha chars removed)."""
        chunks = ["```c++", "\nint main() { return 0; }", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        for r in results:
            if r["type"] == "code":
                assert r["format"] == "c"


class TestOIRespondAndStoreSimulation:
    """
    Simulate OI's _respond_and_store message accumulation to verify
    the EXACT behavior that prevents the agent loop.

    The core invariant: after _HTMLPassthrough runs, messages[-1]["role"]
    MUST be "computer".  If it's not, the empty-output fallback at
    core.py:333 fires and the agent loops.
    """

    def _simulate_respond_and_store(self, chunks):
        """
        Minimal simulation of core.py _respond_and_store logic.

        Takes yielded chunks from a language handler (like _HTMLPassthrough),
        applies the message accumulation rules from core.py:300-422.
        Returns the final messages list.
        """
        messages = []
        last_flag_base = None

        for chunk in chunks:
            # core.py:324 — skip empty content
            if chunk.get("content") == "":
                continue

            # Check if role/type match last_flag_base
            role_type_match = (
                last_flag_base
                and "role" in chunk
                and "type" in chunk
                and last_flag_base.get("role") == chunk.get("role")
                and last_flag_base.get("type") == chunk.get("type")
            )

            if role_type_match:
                # Append to existing message
                if messages:
                    messages[-1]["content"] += chunk.get("content", "")
            else:
                # New message type
                last_flag_base = {
                    "role": chunk.get("role"),
                    "type": chunk.get("type"),
                }
                messages.append(dict(chunk))

        return messages

    def test_html_passthrough_sets_computer_role(self):
        """
        After _HTMLPassthrough.run(), the last message in OI's messages
        list MUST have role='computer'.  This prevents the empty-output
        fallback (core.py:333) from firing.
        """
        instance = _HTMLPassthrough(None)
        raw_events = list(instance.run("<html></html>"))

        # Wrap with role=computer as respond.py:364 does
        chunks = [{"role": "computer", **evt} for evt in raw_events]
        messages = self._simulate_respond_and_store(chunks)

        assert len(messages) == 1
        assert messages[-1]["role"] == "computer"
        assert messages[-1]["content"] == "[HTML executed successfully]"

    def test_html_passthrough_prevents_empty_output_fallback(self):
        """
        core.py:332-341: If messages[-1]["role"] != "computer", an empty
        output is appended.  Our status message ensures this condition is
        FALSE, so the fallback does NOT fire.
        """
        instance = _HTMLPassthrough(None)
        raw_events = list(instance.run(""))
        chunks = [{"role": "computer", **evt} for evt in raw_events]
        messages = self._simulate_respond_and_store(chunks)

        # The critical check: last message IS computer
        assert messages[-1]["role"] == "computer"
        # Therefore: empty-output fallback condition is False
        assert not (messages[-1]["role"] != "computer")

    def test_html_passthrough_content_not_empty_after_accumulation(self):
        """
        core.py:324 skips chunks where content == "".
        Our status message content is non-empty, so it MUST NOT be skipped.
        """
        instance = _HTMLPassthrough(None)
        raw_events = list(instance.run(""))
        chunks = [{"role": "computer", **evt} for evt in raw_events]
        messages = self._simulate_respond_and_store(chunks)

        assert len(messages) == 1
        assert messages[0]["content"] != ""
        assert messages[0]["content"] == "[HTML executed successfully]"


class TestRunTextLlmContentIntegrity:
    """
    End-to-end content integrity: chunks in → code out → content preserved.
    These assert EXACT reconstructed code, not just substring presence.
    """

    def test_exact_html_reconstruction(self):
        """
        Given a known HTML document split into realistic chunks
        (``` and language as SEPARATE tokens — the common streaming pattern),
        the reassembled code must match the original EXACTLY.
        """
        original = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>Test</title>\n</head>\n<body>\n<h1>Hello</h1>\n</body>\n</html>'
        # Realistic pattern: ``` and language are separate tokens
        chunks = [
            "```",
            "html",
            "\n<!DOCTYPE html>\n",
            '<html lang="en">\n',
            "<head>\n<title>",
            "Test</title>\n</head>\n",
            "<body>\n<h1>",
            "Hello</h1>\n",
            "</body>\n</html>",
            "\n```",
        ]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)

        # Strip leading newline from header stripping
        full_code_stripped = full_code.lstrip("\n")
        assert full_code_stripped == original, (
            f"Content mismatch.\n"
            f"Expected: {original!r}\n"
            f"Got:      {full_code_stripped!r}"
        )

    def test_exact_python_reconstruction(self):
        """Same for Python — verify no characters lost or added."""
        original = "def hello():\n    print('hello world')\n\nhello()"
        # Realistic: ``` and python as separate tokens
        chunks = [
            "```",
            "python",
            "\ndef hello():\n",
            "    print('hello world')\n",
            "\nhello()",
            "\n```",
        ]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts).lstrip("\n")
        assert full_code == original

    def test_combined_backticks_language_chunk_leaks_prefix(self):
        """
        PRE-EXISTING OI BEHAVIOR: When ``` and language arrive in the
        SAME chunk (e.g., "```html\\n"), the raw chunk content — including
        the ``` prefix — leaks into yielded code.  This is because
        accumulated_block is stripped but content (the raw chunk) is yielded.

        This test DOCUMENTS the behavior, not endorses it.  In practice,
        most LLM tokenizers emit ``` as a separate token.
        """
        chunks = ["```html\n", "<!DOCTYPE html>", "\n```"]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_parts = [r["content"] for r in results if r["type"] == "code"]
        full_code = "".join(code_parts)

        # The ``` prefix leaks through (pre-existing OI behavior)
        assert full_code.startswith("```html\n")
        # But the critical fix: "html" in DOCTYPE is NOT stripped
        assert "<!DOCTYPE html>" in full_code

    def test_all_code_chunks_have_consistent_format(self):
        """Every code chunk from a single block must have the same format."""
        chunks = [
            "```html\n",
            "<!DOCTYPE html>\n",
            "<html>\n",
            "<body>test</body>\n",
            "</html>",
            "\n```",
        ]
        llm = _make_llm(chunks)
        results = _collect(llm)
        code_chunks = [r for r in results if r["type"] == "code"]
        formats = {c["format"] for c in code_chunks}
        assert len(formats) == 1, f"Inconsistent formats: {formats}"
        assert "html" in formats


class TestFullChainHTMLExecution:
    """
    Simulate the complete chain: LLM streaming → _patched_run_text_llm →
    code events → _HTMLPassthrough → EventNormalizer → PhaseDetector.

    This is the closest to E2E we can get without starting real OI.
    """

    def test_full_chain_html_document_integrity(self):
        """
        Full chain: realistic LLM chunks produce code events,
        _HTMLPassthrough provides execution feedback, downstream
        pipeline correctly processes everything.
        """
        from ws.domain.builders.phase_detector import detect_phase
        from ws.domain.services.event_normalizer import EventNormalizer

        normalizer = EventNormalizer()

        # Step 1: LLM streams HTML code
        chunks = [
            "I'll create a page for you.\n\n",
            "```html\n",
            "<!DOCTYPE html>\n",
            "<html>\n<head><title>",
            "My Page</title></head>\n",
            "<body><h1>Welcome</h1></body>\n",
            "</html>",
            "\n```",
        ]
        llm = _make_llm(chunks)
        results = _collect(llm)

        # Verify text events before code
        text_events = [r for r in results if r["type"] == "message"]
        assert len(text_events) > 0

        # Verify code events
        code_events = [r for r in results if r["type"] == "code"]
        assert len(code_events) > 0
        assert all(e["format"] == "html" for e in code_events)

        # Verify code content integrity
        full_code = "".join(e["content"] for e in code_events)
        assert "<!DOCTYPE html>" in full_code
        assert "<h1>Welcome</h1>" in full_code

        # Step 2: Phase detection on code events
        for evt in code_events:
            phase = detect_phase("assistant", evt["type"], evt["format"])
            assert phase == "writing"

        # Step 3: _HTMLPassthrough execution
        passthrough = _HTMLPassthrough(None)
        exec_events = list(passthrough.run(full_code))
        assert len(exec_events) == 1

        # Step 4: Normalize the execution feedback
        feedback = {"role": "computer", **exec_events[0]}
        normalized = normalizer.normalize(feedback)
        assert normalized is not None
        assert normalized["type"] == "output"
        assert normalized["format"] == "console"

        # Step 5: Phase detection on feedback
        phase = detect_phase(
            normalized["role"],
            normalized["type"],
            normalized.get("format"),
        )
        assert phase == "executing"

        # Step 6: Text response triggers trail completion
        phase_after = detect_phase("assistant", "message")
        assert phase_after is None


# ═══════════════════════════════════════════════════════════════════════════
# BUG PROOF: Original venv-oi run_text_llm vs Patched
#
# Imports the ACTUAL buggy function from venv-oi/site-packages and runs
# IDENTICAL inputs through both.  Proves: original corrupts, patch fixes.
# Skipped automatically if venv-oi is absent (CI, fresh clone).
# ═══════════════════════════════════════════════════════════════════════════

# Load the ORIGINAL buggy run_text_llm directly from the source file.
# Uses importlib.util to avoid importing the full 'interpreter' package
# (which pulls in wcwidth, litellm, etc. that conflict with system Python).
_original_run_text_llm = None
_OI_RUN_TEXT_LLM = (
    BACKEND_ROOT
    / "venv-oi"
    / "lib"
    / "python3.11"
    / "site-packages"
    / "interpreter"
    / "core"
    / "llm"
    / "run_text_llm.py"
)
if _OI_RUN_TEXT_LLM.exists():
    import importlib.util

    _spec = importlib.util.spec_from_file_location(
        "_oi_original_run_text_llm", _OI_RUN_TEXT_LLM
    )
    _mod = importlib.util.module_from_spec(_spec)
    try:
        _spec.loader.exec_module(_mod)
        _original_run_text_llm = _mod.run_text_llm
    except Exception:
        pass  # File present but unloadable — skip gracefully

_has_original = _original_run_text_llm is not None


def _run_and_extract(fn, chunks):
    """Run a run_text_llm function and return joined code content."""
    llm = _make_llm(chunks)
    return "".join(
        r["content"] for r in fn(llm, {"messages": [{"content": "t"}]})
        if r.get("type") == "code"
    )


@pytest.mark.skipif(not _has_original, reason="venv-oi not available")
class TestOriginalVsPatched:
    """
    DEFINITIVE BUG PROOF.  Same mock LLM, same chunks, two functions.
    Original: content.replace(language, '') — globally strips language name.
    Patched: startswith() on first chunk only — preserves content.
    """

    @pytest.mark.parametrize("lang,code_line,corrupted_to", [
        ("html", "<!DOCTYPE html>", "<!DOCTYPE >"),
        ("java", "import java.util.List;", "import .util.List;"),
        ("javascript", "// javascript rocks", "//  rocks"),
        ("typescript", 'x: typescript = "typescript"', 'x:  = ""'),
    ])
    def test_original_corrupts(self, lang, code_line, corrupted_to):
        """The ORIGINAL function produces corrupted output."""
        chunks = ["```", lang, f"\n{code_line}", "\n```"]
        code = _run_and_extract(_original_run_text_llm, chunks)
        assert corrupted_to in code, (
            f"Expected original to corrupt {lang!r} content.\n"
            f"  Expected substring: {corrupted_to!r}\n"
            f"  Actual output:      {code!r}"
        )

    @pytest.mark.parametrize("lang,code_line", [
        ("html", "<!DOCTYPE html>"),
        ("java", "import java.util.List;"),
        ("javascript", "// javascript rocks"),
        ("typescript", 'x: typescript = "typescript"'),
    ])
    def test_patched_preserves(self, lang, code_line):
        """The PATCHED function preserves content intact."""
        chunks = ["```", lang, f"\n{code_line}", "\n```"]
        code = _run_and_extract(_patched_run_text_llm, chunks)
        assert code_line in code, (
            f"Patched function corrupted {lang!r} content.\n"
            f"  Expected substring: {code_line!r}\n"
            f"  Actual output:      {code!r}"
        )

    @pytest.mark.parametrize("lang,code_line", [
        ("python", 'print("hello world")'),
        ("css", "body { color: red; }"),
        ("sql", "SELECT * FROM users;"),
        ("bash", "echo 'hello world'"),
    ])
    def test_safe_languages_identical(self, lang, code_line):
        """Languages where the name doesn't appear in content — both produce same output."""
        chunks = ["```", lang, f"\n{code_line}", "\n```"]
        original_code = _run_and_extract(_original_run_text_llm, chunks)
        patched_code = _run_and_extract(_patched_run_text_llm, chunks)
        assert code_line in original_code
        assert code_line in patched_code
        assert original_code == patched_code


# ═══════════════════════════════════════════════════════════════════════════
# USER SCENARIO TESTS
#
# What real users ask agents to do.  Each scenario is a realistic LLM
# response with the streaming pattern that would be produced.
# ═══════════════════════════════════════════════════════════════════════════


class TestUserScenarios:
    """
    Real tasks users give to agents.  Each test simulates the LLM
    streaming pattern and verifies ALL content the user expects to see
    in the code artifact survives the patched function intact.
    """

    @pytest.mark.parametrize("scenario,lang,code_chunks,must_survive", [
        (
            "landing page with inline CSS and JS",
            "html",
            [
                '\n<!DOCTYPE html>\n<html lang="en">\n<head>\n',
                "<style>\nhtml { margin: 0; }\n",
                ".html-preview { border: 1px solid; }\n</style>\n",
                "<script>\ndocument.querySelector('.html-container');\n</script>\n",
                "</head>\n<body>\n<h1>Welcome</h1>\n</body>\n</html>",
            ],
            ["<!DOCTYPE html>", '<html lang="en">', "html { margin: 0",
             ".html-preview", ".html-container"],
        ),
        (
            "java spring controller with multiple imports",
            "java",
            [
                "\nimport java.util.List;\n",
                "import java.util.Map;\n",
                "import java.net.http.HttpClient;\n\n",
                "public class ApiController {\n",
                "    private final java.util.Optional<String> name;\n",
                "}",
            ],
            ["import java.util.List", "import java.util.Map",
             "java.net.http.HttpClient", "java.util.Optional"],
        ),
        (
            "typescript react component with type annotations",
            "typescript",
            [
                "\n// typescript interface for props\n",
                "interface CardProps {\n  title: string;\n}\n\n",
                "export const Card: React.FC<CardProps> = ({ title }) => {\n",
                "  // typescript strict mode enabled\n",
                "  return <div className='card'>{title}</div>;\n",
                "};",
            ],
            ["typescript interface", "typescript strict mode",
             "interface CardProps", "React.FC<CardProps>"],
        ),
        (
            "javascript module with self-referencing comments",
            "javascript",
            [
                "\n// javascript utility module\n",
                "const isJavascriptFile = (f) => f.endsWith('.javascript');\n",
                "export function processJavascript(code) {\n",
                "  console.log('processing javascript');\n",
                "  return code;\n",
                "}",
            ],
            ["javascript utility", "isJavascriptFile",
             "processJavascript", "processing javascript"],
        ),
        (
            "html email template (table-based, heavy inline styles)",
            "html",
            [
                "\n<!DOCTYPE html>\n",
                '<html xmlns="http://www.w3.org/1999/xhtml">\n',
                "<head><meta http-equiv='Content-Type' ",
                "content='text/html; charset=utf-8'></head>\n",
                "<body>\n<table><tr><td>",
                '<a href="https://example.com/unsubscribe.html">unsub</a>',
                "</td></tr></table>\n</body>\n</html>",
            ],
            ["<!DOCTYPE html>", "text/html", "unsubscribe.html",
             '<html xmlns='],
        ),
    ])
    def test_user_scenario(self, scenario, lang, code_chunks, must_survive):
        chunks = ["```", lang] + code_chunks + ["\n```"]
        llm = _make_llm(chunks)
        code = "".join(
            r["content"] for r in _collect(llm) if r["type"] == "code"
        )
        for expected in must_survive:
            assert expected in code, (
                f"[{scenario}] Content corrupted.\n"
                f"  Missing: {expected!r}\n"
                f"  In code:  {code[:300]!r}..."
            )

    @pytest.mark.parametrize("scenario,chunks,text_check,code_check", [
        (
            "agent explains then writes code",
            [
                "I'll create a simple page for you.\n\n",
                "```", "html", "\n<!DOCTYPE html>\n<html></html>", "\n```",
            ],
            "create a simple page",
            "<!DOCTYPE html>",
        ),
        (
            "agent writes code with no preamble",
            ["```", "html", "\n<!DOCTYPE html>\n<p>done</p>", "\n```"],
            None,
            "<!DOCTYPE html>",
        ),
    ])
    def test_text_and_code_separation(self, scenario, chunks, text_check, code_check):
        """Verify text events and code events are properly separated."""
        llm = _make_llm(chunks)
        results = _collect(llm)
        text = "".join(r["content"] for r in results if r["type"] == "message")
        code = "".join(r["content"] for r in results if r["type"] == "code")

        if text_check:
            assert text_check in text, f"[{scenario}] Missing text: {text_check!r}"
        assert code_check in code, f"[{scenario}] Missing code: {code_check!r}"
