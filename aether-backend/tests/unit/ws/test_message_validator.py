"""
Unit tests for ws.domain.validators.message_validator

Tests all 4 public functions:
- validate_required_field: field presence and emptiness checks
- validate_message_type: message type recognition
- validate_user_message: full user message structure validation
- validate_control_message: control message structure + request_id rules

Pure domain logic — no mocks needed.

Bugs found: 0
"""

import pytest

from ws.domain.validators.message_validator import (
    ValidationError,
    validate_required_field,
    validate_message_type,
    validate_user_message,
    validate_control_message,
)


# ---------------------------------------------------------------------------
# validate_required_field
# ---------------------------------------------------------------------------

class TestValidateRequiredField:
    """Tests for validate_required_field."""

    def test_field_present_with_value(self):
        """Valid field passes without error."""
        assert validate_required_field({"name": "Alice"}, "name") is None

    def test_field_missing_raises(self):
        """Missing field raises ValidationError with field name."""
        with pytest.raises(ValidationError, match="Missing required field: age"):
            validate_required_field({"name": "Alice"}, "age")

    def test_field_none_raises(self):
        """None value raises 'cannot be empty'."""
        with pytest.raises(ValidationError, match="Field 'name' cannot be empty"):
            validate_required_field({"name": None}, "name")

    def test_field_empty_string_raises(self):
        """Empty string raises 'cannot be empty'."""
        with pytest.raises(ValidationError, match="Field 'content' cannot be empty"):
            validate_required_field({"content": ""}, "content")

    def test_field_whitespace_only_raises(self):
        """Whitespace-only string raises 'cannot be empty'."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_required_field({"content": "   \t\n "}, "content")

    def test_field_numeric_zero_passes(self):
        """Numeric zero is a valid value (not None, not empty string)."""
        assert validate_required_field({"count": 0}, "count") is None

    def test_field_false_passes(self):
        """Boolean False is a valid value."""
        assert validate_required_field({"flag": False}, "flag") is None

    def test_field_empty_list_passes(self):
        """Empty list is a valid value (only None and empty strings fail)."""
        assert validate_required_field({"items": []}, "items") is None

    def test_field_empty_dict_passes(self):
        """Empty dict is a valid value."""
        assert validate_required_field({"meta": {}}, "meta") is None

    def test_field_with_spaces_in_name(self):
        """Field name with spaces works correctly."""
        with pytest.raises(ValidationError, match="Missing required field: first name"):
            validate_required_field({}, "first name")

    def test_field_valid_nonempty_string(self):
        """Non-empty string passes."""
        assert validate_required_field({"msg": "hello"}, "msg") is None

    def test_error_message_includes_field_name_for_missing(self):
        """Error message contains exact field name when missing."""
        with pytest.raises(ValidationError) as exc_info:
            validate_required_field({}, "request_id")
        assert "request_id" in str(exc_info.value)

    def test_error_message_includes_field_name_for_empty(self):
        """Error message contains exact field name when empty."""
        with pytest.raises(ValidationError) as exc_info:
            validate_required_field({"request_id": None}, "request_id")
        assert "request_id" in str(exc_info.value)


# ---------------------------------------------------------------------------
# validate_message_type
# ---------------------------------------------------------------------------

class TestValidateMessageType:
    """Tests for validate_message_type."""

    @pytest.mark.parametrize("msg_type", [
        "user_message",
        "stop",
        "cancel",
        "audio_start",
        "audio_end",
        "context_reset",
        "heartbeat",
        "ping",
        "pong",
    ])
    def test_valid_types_pass(self, msg_type):
        """All 9 valid message types pass validation."""
        assert validate_message_type(msg_type) is None

    def test_invalid_type_raises(self):
        """Unknown type raises ValidationError."""
        with pytest.raises(ValidationError, match="Invalid message type: unknown"):
            validate_message_type("unknown")

    def test_empty_string_raises(self):
        """Empty string is not a valid type."""
        with pytest.raises(ValidationError, match="Invalid message type:"):
            validate_message_type("")

    def test_case_sensitive(self):
        """Type validation is case-sensitive (uppercase variants rejected)."""
        with pytest.raises(ValidationError):
            validate_message_type("STOP")

    def test_whitespace_variant_rejected(self):
        """Whitespace-padded variant rejected."""
        with pytest.raises(ValidationError):
            validate_message_type(" stop ")

    def test_none_type_raises(self):
        """None as message type raises ValidationError (not TypeError)."""
        with pytest.raises(ValidationError, match="Invalid message type: None"):
            validate_message_type(None)

    def test_numeric_type_raises(self):
        """Numeric value raises ValidationError."""
        with pytest.raises(ValidationError):
            validate_message_type(42)

    def test_error_message_includes_invalid_type(self):
        """Error message contains the invalid type value."""
        with pytest.raises(ValidationError) as exc_info:
            validate_message_type("bogus_type")
        assert "bogus_type" in str(exc_info.value)


# ---------------------------------------------------------------------------
# validate_user_message
# ---------------------------------------------------------------------------

class TestValidateUserMessage:
    """Tests for validate_user_message."""

    def test_valid_message(self):
        """Valid user message passes all checks."""
        assert validate_user_message({"type": "user_message", "content": "Hello"}) is None

    def test_missing_type_raises(self):
        """Missing type field raises."""
        with pytest.raises(ValidationError, match="Missing required field: type"):
            validate_user_message({"content": "Hello"})

    def test_missing_content_raises(self):
        """Missing content field raises."""
        with pytest.raises(ValidationError, match="Missing required field: content"):
            validate_user_message({"type": "user_message"})

    def test_empty_content_raises(self):
        """Empty string content raises."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_user_message({"type": "user_message", "content": ""})

    def test_whitespace_content_raises(self):
        """Whitespace-only content raises."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_user_message({"type": "user_message", "content": "   \t "})

    def test_none_content_raises(self):
        """None content raises."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_user_message({"type": "user_message", "content": None})

    def test_numeric_content_raises(self):
        """Non-string content raises 'must be a string'."""
        with pytest.raises(ValidationError, match="must be a string"):
            validate_user_message({"type": "user_message", "content": 42})

    def test_list_content_raises(self):
        """List content raises 'must be a string'."""
        with pytest.raises(ValidationError, match="must be a string"):
            validate_user_message({"type": "user_message", "content": ["a", "b"]})

    def test_dict_content_raises(self):
        """Dict content raises 'must be a string'."""
        with pytest.raises(ValidationError, match="must be a string"):
            validate_user_message({"type": "user_message", "content": {"text": "hi"}})

    def test_bool_content_raises(self):
        """Boolean content raises 'must be a string'."""
        with pytest.raises(ValidationError, match="must be a string"):
            validate_user_message({"type": "user_message", "content": True})

    def test_extra_fields_ignored(self):
        """Extra fields do not cause failure."""
        assert validate_user_message({
            "type": "user_message",
            "content": "Hello",
            "request_id": "abc-123",
            "metadata": {"key": "value"},
        }) is None

    def test_content_with_special_characters(self):
        """Content with unicode/special characters passes."""
        assert validate_user_message({
            "type": "user_message",
            "content": "Hello \U0001f600 \u2603 \u00e9\u00e8\u00ea",
        }) is None

    def test_long_content_passes(self):
        """Very long content string passes."""
        assert validate_user_message({
            "type": "user_message",
            "content": "x" * 100_000,
        }) is None

    def test_single_char_content_passes(self):
        """Single character content passes."""
        assert validate_user_message({"type": "user_message", "content": "a"}) is None

    def test_empty_dict_raises(self):
        """Empty message dict raises (missing type)."""
        with pytest.raises(ValidationError, match="Missing required field: type"):
            validate_user_message({})


# ---------------------------------------------------------------------------
# validate_control_message
# ---------------------------------------------------------------------------

class TestValidateControlMessage:
    """Tests for validate_control_message."""

    def test_stop_with_request_id(self):
        """Stop message with request_id passes."""
        assert validate_control_message({"type": "stop", "request_id": "req-001"}) is None

    def test_cancel_with_request_id(self):
        """Cancel message with request_id passes."""
        assert validate_control_message({"type": "cancel", "request_id": "req-002"}) is None

    def test_stop_without_request_id_raises(self):
        """Stop message without request_id raises."""
        with pytest.raises(ValidationError, match="Missing required field: request_id"):
            validate_control_message({"type": "stop"})

    def test_cancel_without_request_id_raises(self):
        """Cancel message without request_id raises."""
        with pytest.raises(ValidationError, match="Missing required field: request_id"):
            validate_control_message({"type": "cancel"})

    def test_stop_with_none_request_id_raises(self):
        """Stop message with None request_id raises."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_control_message({"type": "stop", "request_id": None})

    def test_stop_with_empty_request_id_raises(self):
        """Stop message with empty string request_id raises."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_control_message({"type": "stop", "request_id": ""})

    def test_heartbeat_no_request_id_required(self):
        """Non-stop/cancel types don't require request_id."""
        assert validate_control_message({"type": "heartbeat"}) is None

    def test_ping_no_request_id_required(self):
        """Ping doesn't require request_id."""
        assert validate_control_message({"type": "ping"}) is None

    def test_pong_no_request_id_required(self):
        """Pong doesn't require request_id."""
        assert validate_control_message({"type": "pong"}) is None

    def test_missing_type_raises(self):
        """Missing type raises ValidationError."""
        with pytest.raises(ValidationError, match="Missing required field: type"):
            validate_control_message({})

    def test_none_type_raises(self):
        """None type raises."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_control_message({"type": None})

    def test_empty_type_raises(self):
        """Empty string type raises."""
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_control_message({"type": ""})

    def test_extra_fields_allowed(self):
        """Extra fields don't cause failure."""
        assert validate_control_message({
            "type": "stop",
            "request_id": "req-003",
            "reason": "user requested",
        }) is None


# ---------------------------------------------------------------------------
# ValidationError type identity
# ---------------------------------------------------------------------------

class TestValidationErrorIdentity:
    """Verify ValidationError is a proper Exception subclass."""

    def test_is_exception_subclass(self):
        """ValidationError inherits from Exception."""
        assert issubclass(ValidationError, Exception)

    def test_can_be_instantiated_with_message(self):
        """Can create with a string message."""
        err = ValidationError("test error")
        assert str(err) == "test error"

    def test_can_be_caught_as_exception(self):
        """Can be caught as Exception."""
        with pytest.raises(Exception):
            raise ValidationError("test")
