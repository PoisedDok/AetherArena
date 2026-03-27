"""
Unit Tests: TraceGenerator

Tests the trace generation pipeline — helper methods for JSON extraction,
caption sanitization, coordinate coercion, modifier text building,
action delta selection, prompt construction, and API call wrappers.

Constructor requires file I/O (default_prompt.json, api_keys.json).
All tests bypass the constructor by creating instances with mock file reads.

Bug-finding focus:
- _extract_json returns {} on None/empty input
- _sanitize_caption forces "Cropped image shows" prefix
- _coerce_release_to_click converts orphaned mouseup to click
- _val case-insensitive key lookup
- _call_openai/_call_claude raise RuntimeError on missing keys
- generate_trace skips CONFIG and Active Window items
"""

import json
import os
import tempfile
from unittest.mock import patch, MagicMock

import pytest

from services.proactive.logic.trace_generator import TraceGenerator


# =========================================================================
# Helpers
# =========================================================================

def _make_generator(**overrides):
    """Create a TraceGenerator bypassing file I/O in __init__.
    
    Writes temporary prompt and API key files, creates the generator,
    then cleans up.
    """
    prompt_data = overrides.get("prompt", {
        "Base Prompt": "You are an AI assistant analyzing GUI actions.",
        "Deltas": {
            "Click": "Delta for click action. <MODIFIER_GUIDE>",
            "Drag": "Delta for drag action. <MODIFIER_GUIDE>",
            "RClick": "Delta for right-click. <MODIFIER_GUIDE>",
            "DblClick": "Delta for double-click. <MODIFIER_GUIDE>",
            "MouseWheel": "Delta for scroll. <MODIFIER_GUIDE>",
            "Type": "Delta for typing. <MODIFIER_GUIDE>",
            "Scroll": "Delta for scroll. <MODIFIER_GUIDE>",
        },
        "Modifier_Guide": "Hold modifier keys for special behavior.",
    })
    api_keys = overrides.get("api_keys", {
        "OPENAI_API_KEY": "test-openai-key",
        "CLAUDE_API_KEY": "test-claude-key",
    })

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as pf:
        json.dump(prompt_data, pf)
        prompt_path = pf.name

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as kf:
        json.dump(api_keys, kf)
        keys_path = kf.name

    try:
        tg = TraceGenerator(
            default_prompt_path=prompt_path,
            api_provider=overrides.get("api_provider", "openai"),
            openai_model=overrides.get("openai_model", "gpt-4o"),
            claude_model=overrides.get("claude_model", "claude-sonnet-4-20250514"),
            api_keys_path=keys_path,
        )
    finally:
        os.unlink(prompt_path)
        os.unlink(keys_path)

    return tg


# =========================================================================
# __init__
# =========================================================================

class TestInit:
    """Tests for TraceGenerator.__init__."""

    def test_loads_prompt_and_keys(self):
        """Constructor loads prompt data and API keys from files."""
        tg = _make_generator()
        assert "Base Prompt" in tg.default_prompt
        assert tg.openai_key == "test-openai-key"
        assert tg.claude_key == "test-claude-key"

    def test_missing_prompt_file_raises(self):
        """Missing prompt file → FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            TraceGenerator(
                default_prompt_path="/nonexistent/prompt.json",
                api_keys_path="/nonexistent/keys.json",
            )

    def test_missing_keys_file_uses_env(self):
        """Missing API keys file → falls back to env vars."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as pf:
            json.dump({"Base Prompt": "test"}, pf)
            prompt_path = pf.name

        try:
            with patch.dict(os.environ, {"OPENAI_API_KEY": "env-key", "ANTHROPIC_API_KEY": "env-claude"}):
                tg = TraceGenerator(
                    default_prompt_path=prompt_path,
                    api_keys_path="/nonexistent/keys.json",
                )
                assert tg.openai_key == "env-key"
                assert tg.claude_key == "env-claude"
        finally:
            os.unlink(prompt_path)

    def test_no_keys_anywhere_raises(self):
        """No API keys in file or env → RuntimeError."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as pf:
            json.dump({"Base Prompt": "test"}, pf)
            prompt_path = pf.name

        try:
            with patch.dict(os.environ, {}, clear=True):
                # Remove all API key env vars
                for key in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]:
                    os.environ.pop(key, None)
                with pytest.raises(RuntimeError, match="No API keys found"):
                    TraceGenerator(
                        default_prompt_path=prompt_path,
                        api_keys_path="/nonexistent/keys.json",
                    )
        finally:
            os.unlink(prompt_path)

    def test_provider_stored(self):
        """API provider is stored lowercase."""
        tg = _make_generator(api_provider="Claude")
        assert tg.api_provider == "claude"


# =========================================================================
# _val
# =========================================================================

class TestVal:
    """Tests for TraceGenerator._val (case-insensitive dict lookup)."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_exact_key(self):
        """Exact key match."""
        assert self.tg._val({"Name": "Alice"}, "Name") == "Alice"

    def test_case_insensitive(self):
        """Case-insensitive key match."""
        assert self.tg._val({"name": "Alice"}, "Name") == "Alice"

    def test_missing_key_returns_default(self):
        """Missing key → default value."""
        assert self.tg._val({"foo": "bar"}, "baz") == ""

    def test_custom_default(self):
        """Custom default value."""
        assert self.tg._val({"foo": "bar"}, "baz", default="N/A") == "N/A"

    def test_first_matching_key_wins(self):
        """First matching key in args wins."""
        d = {"Observation": "obs", "observation": "lower"}
        assert self.tg._val(d, "Observation") == "obs"

    def test_multiple_keys_tried(self):
        """Multiple keys tried in order."""
        d = {"think": "deep thought"}
        assert self.tg._val(d, "Think", "think") == "deep thought"

    def test_empty_dict(self):
        """Empty dict → default."""
        assert self.tg._val({}, "key") == ""


# =========================================================================
# _extract_json
# =========================================================================

class TestExtractJson:
    """Tests for TraceGenerator._extract_json."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_valid_json_string(self):
        """Plain JSON string → parsed dict."""
        result = self.tg._extract_json('{"key": "value"}')
        assert result == {"key": "value"}

    def test_json_in_markdown_block(self):
        """JSON embedded in markdown code block."""
        text = 'Here is the output:\n```json\n{"action": "click"}\n```'
        result = self.tg._extract_json(text)
        assert result == {"action": "click"}

    def test_json_with_surrounding_text(self):
        """JSON with surrounding non-JSON text."""
        text = 'Some text before {"result": 42} and after'
        result = self.tg._extract_json(text)
        assert result == {"result": 42}

    def test_empty_string_returns_empty(self):
        """Empty string → empty dict."""
        assert self.tg._extract_json("") == {}

    def test_none_returns_empty(self):
        """None → empty dict."""
        assert self.tg._extract_json(None) == {}

    def test_no_json_returns_empty(self):
        """String with no JSON → empty dict."""
        assert self.tg._extract_json("no json here") == {}

    def test_invalid_json_returns_empty(self):
        """Invalid JSON → empty dict."""
        assert self.tg._extract_json("{invalid: json}") == {}

    def test_nested_json(self):
        """Nested JSON object."""
        text = '{"outer": {"inner": "value"}}'
        result = self.tg._extract_json(text)
        assert result["outer"]["inner"] == "value"

    def test_multiple_json_blocks_greedy_regex(self):
        """Multiple JSON blocks in same string: greedy regex matches entire span.
        
        The regex r'\\{.*\\}' with re.S matches from first { to LAST },
        resulting in an invalid JSON blob. Falls back to json.loads(text),
        which also fails. Returns {}.
        """
        text = '{"first": 1} some text {"second": 2}'
        result = self.tg._extract_json(text)
        # Greedy match captures the entire span as one invalid block
        assert result == {}

    def test_single_json_extracted_from_text(self):
        """Single JSON object surrounded by text → extracted."""
        text = 'Here is the result: {"answer": 42} end.'
        result = self.tg._extract_json(text)
        assert result == {"answer": 42}


# =========================================================================
# _sanitize_caption
# =========================================================================

class TestSanitizeCaption:
    """Tests for TraceGenerator._sanitize_caption."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_strips_coordinates(self):
        """Coordinate patterns are stripped from all fields."""
        cap = {
            "observation": "Button at coordinates [100, 200]",
            "think": "Need to click x=100 y=200",
            "action": "Click at [150, 250]",
            "expectation": "Dialog opens",
        }
        result = self.tg._sanitize_caption(cap)
        assert "[100, 200]" not in result["observation"]
        assert "x=100" not in result["think"]
        assert "[150, 250]" not in result["action"]

    def test_enforces_crop_prefix(self):
        """Observation must start with 'Cropped image shows'."""
        cap = {
            "observation": "A button is visible",
            "think": "",
            "action": "",
            "expectation": "",
        }
        result = self.tg._sanitize_caption(cap)
        assert result["observation"].startswith("Cropped image shows")

    def test_already_has_prefix(self):
        """Observation already starting with 'cropped image shows' → preserved."""
        cap = {
            "observation": "cropped image shows a button",
            "think": "",
            "action": "",
            "expectation": "",
        }
        result = self.tg._sanitize_caption(cap)
        assert result["observation"].lower().startswith("cropped image shows")

    def test_release_title_bar_coercion(self):
        """Action mentioning 'release' + 'title bar' → coerced to click."""
        cap = {
            "observation": "Something",
            "think": "Original think",
            "action": "Release the title bar control",
            "expectation": "",
        }
        result = self.tg._sanitize_caption(cap)
        assert result["action"] == "Click the control shown in the cropped image"

    def test_missing_keys_filled(self):
        """Missing keys get empty string default."""
        cap = {}
        result = self.tg._sanitize_caption(cap)
        assert "observation" in result
        assert "think" in result
        assert "action" in result
        assert "expectation" in result

    def test_collapses_extra_spaces(self):
        """Multiple spaces after coordinate removal → collapsed."""
        cap = {
            "observation": "Button   at  coordinates  [100, 200]  here",
            "think": "",
            "action": "",
            "expectation": "",
        }
        result = self.tg._sanitize_caption(cap)
        assert "  " not in result["observation"]


# =========================================================================
# _coerce_release_to_click
# =========================================================================

class TestCoerceReleaseToClick:
    """Tests for TraceGenerator._coerce_release_to_click."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_orphaned_mouseup_becomes_click(self):
        """Mouse-up without recent mouse-down → converted to LClick."""
        items = [
            {"timestamp": 1.0, "action": "LButtonUp at", "coords": [{"x": 100, "y": 200}]},
        ]
        result = self.tg._coerce_release_to_click(items)
        assert result[0]["action"] == "LClick"

    def test_paired_down_up_not_converted(self):
        """Mouse-down followed by close mouse-up → not converted."""
        items = [
            {"timestamp": 1.0, "action": "LButtonDown at", "coords": [{"x": 100, "y": 200}]},
            {"timestamp": 1.1, "action": "LButtonUp at", "coords": [{"x": 102, "y": 201}]},
        ]
        result = self.tg._coerce_release_to_click(items)
        # up is recent and near → NOT converted
        assert result[1]["action"] == "LButtonUp at"

    def test_distant_up_converted(self):
        """Mouse-down far from mouse-up → up converted to click."""
        items = [
            {"timestamp": 1.0, "action": "LButtonDown at", "coords": [{"x": 100, "y": 200}]},
            {"timestamp": 1.1, "action": "LButtonUp at", "coords": [{"x": 500, "y": 600}]},
        ]
        result = self.tg._coerce_release_to_click(items)
        assert result[1]["action"] == "LClick"

    def test_timed_out_up_converted(self):
        """Mouse-down too long before mouse-up → up converted."""
        items = [
            {"timestamp": 0.0, "action": "LButtonDown at", "coords": [{"x": 100, "y": 200}]},
            {"timestamp": 5.0, "action": "LButtonUp at", "coords": [{"x": 100, "y": 200}]},
        ]
        result = self.tg._coerce_release_to_click(items, ms_window=500)
        assert result[1]["action"] == "LClick"

    def test_right_click_coercion(self):
        """Right mouse-up → RClick."""
        items = [
            {"timestamp": 1.0, "action": "right LButtonUp at", "coords": [{"x": 100, "y": 200}]},
        ]
        result = self.tg._coerce_release_to_click(items)
        assert result[0]["action"] == "RClick"

    def test_non_mouse_events_unchanged(self):
        """Non-mouse events are not modified."""
        items = [
            {"timestamp": 1.0, "action": "Key Press: a", "coords": None},
        ]
        result = self.tg._coerce_release_to_click(items)
        assert result[0]["action"] == "Key Press: a"

    def test_empty_list(self):
        """Empty list → empty."""
        assert self.tg._coerce_release_to_click([]) == []


# =========================================================================
# _modifiers_text
# =========================================================================

class TestModifiersText:
    """Tests for TraceGenerator._modifiers_text."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_no_modifiers(self):
        """No modifiers → empty string."""
        assert self.tg._modifiers_text({}, "guide") == ""

    def test_shift_modifier(self):
        """Shift modifier present → includes shift guidance."""
        action = {"modifiers": ["Shift"]}
        result = self.tg._modifiers_text(action, "guide")
        assert "Shift" in result

    def test_ctrl_modifier(self):
        """Ctrl modifier present."""
        action = {"modifiers": ["ctrl"]}
        result = self.tg._modifiers_text(action, "guide")
        assert "Ctrl" in result

    def test_multiple_modifiers(self):
        """Multiple modifiers."""
        action = {"modifiers": ["Shift", "Ctrl"]}
        result = self.tg._modifiers_text(action, "guide")
        assert "Shift" in result
        assert "Ctrl" in result

    def test_string_modifier(self):
        """Single string modifier (not list) → handled."""
        action = {"modifiers": "Alt"}
        result = self.tg._modifiers_text(action, "guide")
        assert "Alt" in result

    def test_empty_modifiers(self):
        """Empty modifier list → empty string."""
        action = {"modifiers": []}
        result = self.tg._modifiers_text(action, "guide") 
        assert result == ""

    def test_modifier_key_alternative(self):
        """'modifier' key (singular) also checked."""
        action = {"modifier": ["Shift"]}
        result = self.tg._modifiers_text(action, "guide")
        assert "Shift" in result


# =========================================================================
# _action_delta
# =========================================================================

class TestActionDelta:
    """Tests for TraceGenerator._action_delta."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_click_action(self):
        """Click action → Click delta."""
        result = self.tg._action_delta("LClick at", {}, self.tg.default_prompt.get("Deltas", {}), "")
        assert "Delta for click" in result

    def test_drag_action(self):
        """DragStart → Drag delta."""
        result = self.tg._action_delta("DragStart at", {}, self.tg.default_prompt.get("Deltas", {}), "")
        assert "Delta for drag" in result

    def test_rclick_action(self):
        """RClick → RClick delta."""
        result = self.tg._action_delta("RClick at", {}, self.tg.default_prompt.get("Deltas", {}), "")
        assert "Delta for right-click" in result

    def test_dblclick_action(self):
        """DblClick → DblClick delta."""
        result = self.tg._action_delta("DblClick at", {}, self.tg.default_prompt.get("Deltas", {}), "")
        assert "Delta for double-click" in result

    def test_scroll_action(self):
        """ScrollDown → MouseWheel delta."""
        result = self.tg._action_delta("ScrollDown at", {}, self.tg.default_prompt.get("Deltas", {}), "")
        assert "Delta for scroll" in result

    def test_type_action(self):
        """Type: hello → Type delta."""
        result = self.tg._action_delta("Type: hello", {}, self.tg.default_prompt.get("Deltas", {}), "")
        assert "Delta for typing" in result

    def test_unknown_action(self):
        """Unknown action → no delta."""
        result = self.tg._action_delta("SomethingUnknown", {}, self.tg.default_prompt.get("Deltas", {}), "")
        assert "none" in result.lower()

    def test_empty_action(self):
        """Empty action → no delta."""
        result = self.tg._action_delta("", {}, self.tg.default_prompt.get("Deltas", {}), "")
        assert "none" in result.lower()

    def test_modifier_guide_replaced(self):
        """<MODIFIER_GUIDE> placeholder is replaced with modifier text."""
        action = {"modifiers": ["Shift"]}
        result = self.tg._action_delta("LClick at", action, self.tg.default_prompt.get("Deltas", {}), "guide")
        assert "<MODIFIER_GUIDE>" not in result


# =========================================================================
# _encode_image
# =========================================================================

class TestEncodeImage:
    """Tests for TraceGenerator._encode_image."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_valid_image(self):
        """Valid image file → base64 data URI."""
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            f.write(b"\xff\xd8\xff\xe0test image data")
            path = f.name
        try:
            result = self.tg._encode_image(path)
            assert result.startswith("data:image/jpeg;base64,")
        finally:
            os.unlink(path)

    def test_missing_file(self):
        """Non-existent file → None."""
        assert self.tg._encode_image("/nonexistent/image.jpg") is None

    def test_empty_path(self):
        """Empty string → None."""
        assert self.tg._encode_image("") is None

    def test_none_path(self):
        """None → None."""
        assert self.tg._encode_image(None) is None


# =========================================================================
# _prompt
# =========================================================================

class TestPrompt:
    """Tests for TraceGenerator._prompt."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_includes_base_prompt(self):
        """Prompt includes base prompt text."""
        action = {"action": "LClick at", "current_software": "Chrome", "timestamp": 1.5}
        result = self.tg._prompt(action, "Open browser", 1, [])
        assert "You are an AI assistant" in result

    def test_includes_action_info(self):
        """Prompt includes action, software, timestamp, task."""
        action = {"action": "Key Press: a", "current_software": "VSCode", "timestamp": 3.0}
        result = self.tg._prompt(action, "Write code", 2, [])
        assert "Key Press: a" in result
        assert "VSCode" in result
        assert "Write code" in result
        assert "Step Index: 2" in result

    def test_includes_recent_steps(self):
        """Prompt includes recent steps as JSON."""
        recent = [{"step_idx": 1, "Observation": "Button visible"}]
        action = {"action": "Click", "current_software": "App", "timestamp": 2.0}
        result = self.tg._prompt(action, "Task", 2, recent)
        assert "Button visible" in result

    def test_includes_action_delta(self):
        """Prompt includes the appropriate action-type delta."""
        action = {"action": "DragStart at", "current_software": "App", "timestamp": 1.0}
        result = self.tg._prompt(action, "Task", 1, [])
        assert "Delta for drag" in result


# =========================================================================
# _call_openai
# =========================================================================

class TestCallOpenai:
    """Tests for TraceGenerator._call_openai."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_missing_key_raises(self):
        """No OpenAI key → RuntimeError."""
        self.tg.openai_key = ""
        with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
            self.tg._call_openai("prompt", None, None)

    @patch("services.proactive.logic.trace_generator.requests.post")
    def test_successful_call(self, mock_post):
        """Successful API call returns content text."""
        mock_post.return_value.json.return_value = {
            "choices": [{"message": {"content": '{"action": "click"}'}}]
        }
        mock_post.return_value.raise_for_status = MagicMock()
        result = self.tg._call_openai("test prompt", None, None)
        assert result == '{"action": "click"}'

    @patch("services.proactive.logic.trace_generator.requests.post")
    def test_sends_images_when_provided(self, mock_post):
        """Crop and full images are included in request."""
        mock_post.return_value.json.return_value = {
            "choices": [{"message": {"content": "response"}}]
        }
        mock_post.return_value.raise_for_status = MagicMock()
        self.tg._call_openai("prompt", "data:image/jpeg;base64,crop", "data:image/jpeg;base64,full")

        call_data = mock_post.call_args.kwargs["json"]
        content = call_data["messages"][0]["content"]
        assert len(content) == 3  # text + crop + full
        assert content[1]["type"] == "image_url"
        assert content[2]["type"] == "image_url"


# =========================================================================
# _call_claude
# =========================================================================

class TestCallClaude:
    """Tests for TraceGenerator._call_claude."""

    def setup_method(self):
        self.tg = _make_generator(api_provider="claude")

    def test_missing_key_raises(self):
        """No Claude key → RuntimeError."""
        self.tg.claude_key = ""
        with pytest.raises(RuntimeError, match="CLAUDE_API_KEY"):
            self.tg._call_claude("prompt", None, None)

    @patch("services.proactive.logic.trace_generator.requests.post")
    def test_successful_call(self, mock_post):
        """Successful API call returns content text."""
        mock_post.return_value.json.return_value = {
            "content": [{"text": '{"observation": "button visible"}'}]
        }
        mock_post.return_value.raise_for_status = MagicMock()
        result = self.tg._call_claude("test prompt", None, None)
        assert result == '{"observation": "button visible"}'

    @patch("services.proactive.logic.trace_generator.requests.post")
    def test_sends_images_when_provided(self, mock_post):
        """Crop and full images are included in request."""
        mock_post.return_value.json.return_value = {
            "content": [{"text": "response"}]
        }
        mock_post.return_value.raise_for_status = MagicMock()
        self.tg._call_claude("prompt", "data:image/jpeg;base64,CROPDATA", "data:image/jpeg;base64,FULLDATA")

        call_data = mock_post.call_args.kwargs["json"]
        content = call_data["messages"][0]["content"]
        assert len(content) == 3  # text + crop + full
        assert content[1]["type"] == "image"
        assert content[1]["source"]["data"] == "CROPDATA"
        assert content[2]["source"]["data"] == "FULLDATA"


# =========================================================================
# _coerce_release_to_click near() error path (lines 103-104)
# =========================================================================

class TestCoerceNearError:
    """Tests for the near() nested function exception handler."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_near_with_bad_coords_returns_false(self):
        """near() with bad coords (no x/y) → exception caught, returns False → up converted."""
        items = [
            {"timestamp": 1.0, "action": "LButtonDown at", "coords": [{"bad": True}]},
            {"timestamp": 1.1, "action": "LButtonUp at", "coords": [{"bad": True}]},
        ]
        result = self.tg._coerce_release_to_click(items)
        # near() raises exception → returns False → not recent → converted
        assert result[1]["action"] == "LClick"

    def test_near_with_none_coords(self):
        """near() with None coords → False (line 105-106)."""
        items = [
            {"timestamp": 1.0, "action": "LButtonDown at", "coords": None},
            {"timestamp": 1.1, "action": "LButtonUp at", "coords": None},
        ]
        result = self.tg._coerce_release_to_click(items)
        # coords are None → near can't compare → not recent → converted
        assert result[1]["action"] == "LClick"


# =========================================================================
# _action_delta: unreachable "Scroll" key (line 169)
# =========================================================================

class TestActionDeltaEdge:
    """Line 169 is unreachable because 'scroll' is already caught by 'wheel' or 'scroll' at line 162.
    This test documents this dead code."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_wheel_action_hits_mousewheel(self):
        """'wheel scroll' matches MouseWheel at line 162, never reaches line 168."""
        result = self.tg._action_delta("wheel action", {}, self.tg.default_prompt["Deltas"], "")
        assert "Delta for scroll" in result


# =========================================================================
# generate_trace (lines 245-332) — Full pipeline with mocked LLM
# =========================================================================

class TestGenerateTrace:
    """Tests for TraceGenerator.generate_trace."""

    def setup_method(self):
        self.tg = _make_generator()

    def test_full_pipeline_with_mocked_llm(self):
        """End-to-end generate_trace: reads JSON, calls LLM, writes output."""
        # Create test recording JSON
        recording_data = [
            {"timestamp": 0.0, "action": "CONFIG", "coords": None},
            {"timestamp": 1.0, "action": "Active Window: Chrome", "coords": None},
            {
                "timestamp": 2.0,
                "action": "LClick at",
                "coords": [{"x": 100, "y": 200}],
                "screenshot_crop": "crop.jpg",
                "screenshot_full": "full.jpg",
                "current_software": "Chrome",
            },
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            recording_path = os.path.join(tmpdir, "recording.json")
            with open(recording_path, "w") as f:
                json.dump(recording_data, f)

            screenshots_dir = os.path.join(tmpdir, "screenshots")
            os.makedirs(screenshots_dir)
            # Create fake screenshot files
            with open(os.path.join(screenshots_dir, "crop.jpg"), "wb") as f:
                f.write(b"\xff\xd8\xff\xe0fake crop")
            with open(os.path.join(screenshots_dir, "full.jpg"), "wb") as f:
                f.write(b"\xff\xd8\xff\xe0fake full")

            output_path = os.path.join(tmpdir, "trace.json")

            # Mock LLM call
            llm_response = json.dumps({
                "Observation": "Cropped image shows a search button",
                "Think": "Need to click the button",
                "Action": "Click the search button",
                "Expectation": "Search results appear",
            })
            with patch.object(self.tg, "_call_openai", return_value=llm_response):
                self.tg.generate_trace(recording_path, screenshots_dir, output_path, "Search for items")

            # Verify output file was written
            assert os.path.exists(output_path)
            with open(output_path) as f:
                trace = json.load(f)
            assert "trajectory" in trace
            assert len(trace["trajectory"]) == 1
            step = trace["trajectory"][0]
            assert step["step_idx"] == 1
            assert "search button" in step["caption"]["observation"]

    def test_skips_items_without_screenshots(self):
        """Items without screenshot_crop or screenshot → skipped."""
        recording_data = [
            {"timestamp": 1.0, "action": "Key Press: a", "coords": None, "current_software": "App"},
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            recording_path = os.path.join(tmpdir, "recording.json")
            with open(recording_path, "w") as f:
                json.dump(recording_data, f)

            output_path = os.path.join(tmpdir, "trace.json")
            self.tg.generate_trace(recording_path, tmpdir, output_path, "Task")

            # No steps should be generated (no screenshots)
            if os.path.exists(output_path):
                with open(output_path) as f:
                    trace = json.load(f)
                assert trace["trajectory"] == []
            # else: file not created because no items were processed

    def test_screenshots_prefix_stripped(self):
        """Screenshot paths starting with 'screenshots/' get prefix stripped."""
        recording_data = [
            {
                "timestamp": 1.0,
                "action": "LClick at",
                "coords": [{"x": 50, "y": 60}],
                "screenshot_crop": "screenshots/crop.jpg",
                "screenshot_full": "screenshots/full.jpg",
                "current_software": "App",
            },
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            recording_path = os.path.join(tmpdir, "recording.json")
            with open(recording_path, "w") as f:
                json.dump(recording_data, f)

            screenshots_dir = os.path.join(tmpdir)
            # Create screenshot at the stripped path
            with open(os.path.join(screenshots_dir, "crop.jpg"), "wb") as f:
                f.write(b"\xff\xd8\xff\xe0crop")
            with open(os.path.join(screenshots_dir, "full.jpg"), "wb") as f:
                f.write(b"\xff\xd8\xff\xe0full")

            output_path = os.path.join(tmpdir, "trace.json")
            llm_response = json.dumps({
                "Observation": "Button visible",
                "Think": "Click it",
                "Action": "Click",
                "Expectation": "Done",
            })
            with patch.object(self.tg, "_call_openai", return_value=llm_response):
                self.tg.generate_trace(recording_path, screenshots_dir, output_path, "Task")

            assert os.path.exists(output_path)
            with open(output_path) as f:
                trace = json.load(f)
            assert len(trace["trajectory"]) == 1

    def test_claude_provider_used(self):
        """api_provider='claude' → _call_claude is called instead of _call_openai."""
        self.tg.api_provider = "claude"
        recording_data = [
            {
                "timestamp": 1.0,
                "action": "Click",
                "coords": [{"x": 10, "y": 20}],
                "screenshot": "shot.jpg",
                "current_software": "App",
            },
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            recording_path = os.path.join(tmpdir, "recording.json")
            with open(recording_path, "w") as f:
                json.dump(recording_data, f)

            with open(os.path.join(tmpdir, "shot.jpg"), "wb") as f:
                f.write(b"\xff\xd8\xff\xe0img")

            output_path = os.path.join(tmpdir, "trace.json")
            llm_response = json.dumps({"Observation": "Ok", "Think": "Go", "Action": "Do", "Expectation": "Done"})
            with patch.object(self.tg, "_call_claude", return_value=llm_response) as mock_claude:
                self.tg.generate_trace(recording_path, tmpdir, output_path, "Task")
            mock_claude.assert_called_once()

    def test_recent_steps_populated(self):
        """After multiple steps, recent_steps includes previous captions."""
        recording_data = [
            {
                "timestamp": 1.0,
                "action": "Click",
                "coords": [{"x": 10, "y": 20}],
                "screenshot": "shot1.jpg",
                "current_software": "App",
            },
            {
                "timestamp": 2.0,
                "action": "Type: hello",
                "coords": [{"x": 10, "y": 20}],
                "screenshot": "shot2.jpg",
                "current_software": "App",
            },
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            recording_path = os.path.join(tmpdir, "recording.json")
            with open(recording_path, "w") as f:
                json.dump(recording_data, f)

            for name in ["shot1.jpg", "shot2.jpg"]:
                with open(os.path.join(tmpdir, name), "wb") as f:
                    f.write(b"\xff\xd8\xff\xe0img")

            output_path = os.path.join(tmpdir, "trace.json")
            llm_response = json.dumps({"Observation": "Ok", "Think": "Go", "Action": "Do", "Expectation": "Done"})

            prompt_calls = []
            original_prompt = self.tg._prompt

            def capture_prompt(action, task, step_idx, recent):
                prompt_calls.append({"step_idx": step_idx, "recent_count": len(recent)})
                return original_prompt(action, task, step_idx, recent)

            with patch.object(self.tg, "_call_openai", return_value=llm_response), \
                 patch.object(self.tg, "_prompt", side_effect=capture_prompt):
                self.tg.generate_trace(recording_path, tmpdir, output_path, "Task")

            # Second step should have 1 recent step
            assert len(prompt_calls) == 2
            assert prompt_calls[0]["recent_count"] == 0
            assert prompt_calls[1]["recent_count"] == 1
