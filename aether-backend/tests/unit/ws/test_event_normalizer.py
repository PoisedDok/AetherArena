"""
Unit Tests: EventNormalizer

Pure domain service tests -- no mocks needed.
Tests event filtering, normalization, and content coercion.
"""

import json

import pytest

from ws.domain.services.event_normalizer import EventNormalizer


@pytest.fixture
def normalizer():
    return EventNormalizer()


class TestAuthHandshakeFiltering:

    def test_filters_auth_handshake_events(self, normalizer):
        """Auth handshake events (no role, has 'auth' key) are filtered."""
        event = {"auth": "token_xyz", "status": "ok"}
        assert normalizer.normalize(event) is None

    def test_passes_event_with_auth_and_role(self, normalizer):
        """Events with both 'auth' and 'role' are NOT filtered (has role)."""
        event = {"auth": "token", "role": "assistant", "type": "message", "content": "hi"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["role"] == "assistant"


class TestTypeContractEnforcement:

    def test_enforces_type_for_assistant_without_type(self, normalizer):
        """Assistant events without type get type='message'."""
        event = {"role": "assistant", "content": "hello"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["type"] == "message"

    def test_enforces_type_for_computer_without_type(self, normalizer):
        """Computer events without type get type='output'."""
        event = {"role": "computer", "content": "result"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["type"] == "output"

    def test_preserves_existing_type(self, normalizer):
        """Events with existing type are not overwritten."""
        event = {"role": "assistant", "type": "code", "content": "x = 1", "format": "python"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["type"] == "code"


class TestInternalMarkerFiltering:

    def test_filters_active_line_by_format(self, normalizer):
        """format='active_line' events are filtered."""
        event = {"role": "computer", "type": "console", "format": "active_line", "content": "3"}
        assert normalizer.normalize(event) is None

    def test_filters_active_line_by_content_pattern(self, normalizer):
        """Events with '##active_line' in content are filtered."""
        event = {"role": "computer", "type": "output", "content": "##active_line5##", "format": "text"}
        assert normalizer.normalize(event) is None

    def test_filters_integer_content_console_events(self, normalizer):
        """Integer content with type='console' is filtered (active line marker)."""
        event = {"role": "computer", "type": "console", "content": 42}
        assert normalizer.normalize(event) is None

    def test_does_not_filter_integer_content_non_console(self, normalizer):
        """Integer content with non-console type is coerced, not filtered."""
        event = {"role": "computer", "type": "output", "content": 42, "format": "text"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["content"] == "42"


class TestContentCoercion:

    def test_coerces_dict_content_to_json(self, normalizer):
        """Dict content is converted to pretty-printed JSON."""
        data = {"key": "value", "count": 3}
        event = {"role": "computer", "type": "output", "content": data, "format": "text"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        parsed = json.loads(result["content"])
        assert parsed == data

    def test_coerces_list_content_to_json(self, normalizer):
        """List content is converted to pretty-printed JSON."""
        data = [1, 2, 3]
        event = {"role": "computer", "type": "output", "content": data, "format": "text"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        parsed = json.loads(result["content"])
        assert parsed == data

    def test_coerces_integer_content_to_string(self, normalizer):
        """Integer content (non-console) is converted to string."""
        event = {"role": "assistant", "type": "message", "content": 99}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["content"] == "99"

    def test_coerces_bool_content_to_string(self, normalizer):
        """Boolean content is converted to string."""
        event = {"role": "assistant", "type": "message", "content": True}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["content"] == "True"

    def test_preserves_valid_string_content(self, normalizer):
        """String content is not modified."""
        event = {"role": "assistant", "type": "message", "content": "Hello world"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["content"] == "Hello world"

    def test_preserves_none_content(self, normalizer):
        """None content is preserved (not coerced)."""
        event = {"role": "assistant", "type": "message", "content": None}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["content"] is None


class TestArtifactNormalization:

    def test_normalizes_console_type_to_output(self, normalizer):
        """Legacy 'console' type is normalized to 'output' with format='console'."""
        event = {"role": "computer", "type": "console", "content": "log output"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["type"] == "output"
        assert result["format"] == "console"

    def test_normalizes_html_type_to_output(self, normalizer):
        """Legacy 'html' type is normalized to 'output' with format='html'."""
        event = {"role": "computer", "type": "html", "content": "<p>hello</p>"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["type"] == "output"
        assert result["format"] == "html"


class TestPassthrough:

    def test_passes_through_normal_assistant_message(self, normalizer):
        """Normal assistant message events pass through unchanged."""
        event = {"role": "assistant", "type": "message", "content": "Hello!"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["role"] == "assistant"
        assert result["type"] == "message"
        assert result["content"] == "Hello!"

    def test_passes_through_code_event(self, normalizer):
        """Code events pass through with format preserved."""
        event = {"role": "assistant", "type": "code", "content": "x = 1", "format": "python"}
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        assert result["type"] == "code"
        assert result["format"] == "python"

    def test_rejects_non_dict_input(self, normalizer):
        """Non-dict input returns None."""
        assert normalizer.normalize("not a dict") is None
        assert normalizer.normalize(None) is None
        assert normalizer.normalize(42) is None


class TestContentNormalizationJsonDumpsError:
    """Tests for json.dumps failure fallback in content normalization."""

    def test_unserializable_dict_falls_back_to_str(self, normalizer):
        """
        Lines 150-151: json.dumps raises TypeError for unserializable objects,
        falling back to str(content).
        """
        class NotSerializable:
            def __repr__(self):
                return "<NotSerializable>"

        event = {
            "role": "assistant",
            "type": "message",
            "content": {"key": NotSerializable()},
        }
        result = normalizer.normalize(event)
        assert isinstance(result, dict)
        # Should contain string representation, not crash
        assert isinstance(result["content"], str)
        assert "NotSerializable" in result["content"]
