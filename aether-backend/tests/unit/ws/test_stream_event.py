"""
Unit tests for ws.domain.entities.stream_event

Tests:
- StreamEvent dataclass: construction, immutability, __post_init__ validation
- validate_event_dict: required field presence check
- is_artifact_event: artifact_id detection
- is_marker_event: start/end marker detection

Pure domain logic — no mocks needed.

Bugs found: 0
"""

import pytest

from ws.domain.entities.stream_event import (
    StreamEvent,
    validate_event_dict,
    is_artifact_event,
    is_marker_event,
)


def _valid_kwargs(**overrides):
    """Return valid StreamEvent kwargs, with optional overrides."""
    base = {
        "role": "assistant",
        "type": "message",
        "request_id": "req-001",
        "sequence": 0,
        "timestamp": "2026-02-09T12:00:00Z",
    }
    base.update(overrides)
    return base


def _valid_event_dict(**overrides):
    """Return valid event dict for validate_event_dict."""
    base = {
        "role": "assistant",
        "type": "message",
        "request_id": "req-001",
        "sequence": 0,
        "timestamp": "2026-02-09T12:00:00Z",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# StreamEvent construction
# ---------------------------------------------------------------------------

class TestStreamEventConstruction:
    """Tests for StreamEvent creation and field defaults."""

    def test_minimal_valid_event(self):
        """Minimal required fields produce a valid event."""
        event = StreamEvent(**_valid_kwargs())
        assert event.role == "assistant"
        assert event.type == "message"
        assert event.request_id == "req-001"
        assert event.sequence == 0
        assert event.timestamp == "2026-02-09T12:00:00Z"

    def test_optional_fields_default_none(self):
        """Optional string fields default to None."""
        event = StreamEvent(**_valid_kwargs())
        assert event.content is None
        assert event.format is None
        assert event.artifact_id is None
        assert event.execution_group is None
        assert event.frontend_id is None
        assert event.correlation_id is None
        assert event.chat_id is None
        assert event.recipient is None

    def test_boolean_fields_default_false(self):
        """start and end default to False."""
        event = StreamEvent(**_valid_kwargs())
        assert event.start is False
        assert event.end is False

    def test_all_optional_fields_set(self):
        """All optional fields can be set."""
        event = StreamEvent(**_valid_kwargs(
            content="Hello",
            format="text",
            artifact_id="art-001",
            execution_group="group-1",
            frontend_id="fe-001",
            correlation_id="cor-001",
            chat_id="chat-001",
            recipient="user-001",
            start=True,
            end=True,
        ))
        assert event.content == "Hello"
        assert event.format == "text"
        assert event.artifact_id == "art-001"
        assert event.execution_group == "group-1"
        assert event.frontend_id == "fe-001"
        assert event.correlation_id == "cor-001"
        assert event.chat_id == "chat-001"
        assert event.recipient == "user-001"
        assert event.start is True
        assert event.end is True

    def test_sequence_zero_valid(self):
        """Sequence 0 is valid."""
        event = StreamEvent(**_valid_kwargs(sequence=0))
        assert event.sequence == 0

    def test_large_sequence_valid(self):
        """Large sequence number is valid."""
        event = StreamEvent(**_valid_kwargs(sequence=999999))
        assert event.sequence == 999999

    def test_different_roles(self):
        """Various role values are accepted."""
        for role in ("assistant", "computer", "user", "server"):
            event = StreamEvent(**_valid_kwargs(role=role))
            assert event.role == role

    def test_different_types(self):
        """Various type values are accepted."""
        for typ in ("message", "code", "output", "completion", "stopped"):
            event = StreamEvent(**_valid_kwargs(type=typ))
            assert event.type == typ


# ---------------------------------------------------------------------------
# StreamEvent immutability (frozen=True)
# ---------------------------------------------------------------------------

class TestStreamEventImmutability:
    """Verify frozen dataclass prevents mutation."""

    def test_cannot_set_role(self):
        """Assigning to role raises FrozenInstanceError."""
        event = StreamEvent(**_valid_kwargs())
        with pytest.raises(AttributeError):
            event.role = "user"

    def test_cannot_set_content(self):
        """Assigning to content raises FrozenInstanceError."""
        event = StreamEvent(**_valid_kwargs())
        with pytest.raises(AttributeError):
            event.content = "new content"

    def test_cannot_set_sequence(self):
        """Assigning to sequence raises."""
        event = StreamEvent(**_valid_kwargs())
        with pytest.raises(AttributeError):
            event.sequence = 5


# ---------------------------------------------------------------------------
# StreamEvent __post_init__ validation
# ---------------------------------------------------------------------------

class TestStreamEventValidation:
    """Tests for __post_init__ validation logic."""

    def test_empty_role_raises(self):
        """Empty string role raises ValueError."""
        with pytest.raises(ValueError, match="role is required"):
            StreamEvent(**_valid_kwargs(role=""))

    def test_empty_type_raises(self):
        """Empty string type raises ValueError."""
        with pytest.raises(ValueError, match="type is required"):
            StreamEvent(**_valid_kwargs(type=""))

    def test_empty_request_id_raises(self):
        """Empty string request_id raises ValueError."""
        with pytest.raises(ValueError, match="request_id is required"):
            StreamEvent(**_valid_kwargs(request_id=""))

    def test_negative_sequence_raises(self):
        """Negative sequence raises ValueError."""
        with pytest.raises(ValueError, match="sequence must be non-negative, got -1"):
            StreamEvent(**_valid_kwargs(sequence=-1))

    def test_large_negative_sequence_raises(self):
        """Very negative sequence raises with correct value."""
        with pytest.raises(ValueError, match="got -999"):
            StreamEvent(**_valid_kwargs(sequence=-999))

    def test_none_role_raises(self):
        """None role raises ValueError (not None is True)."""
        with pytest.raises(ValueError, match="role is required"):
            StreamEvent(**_valid_kwargs(role=None))

    def test_none_type_raises(self):
        """None type raises ValueError."""
        with pytest.raises(ValueError, match="type is required"):
            StreamEvent(**_valid_kwargs(type=None))

    def test_none_request_id_raises(self):
        """None request_id raises ValueError."""
        with pytest.raises(ValueError, match="request_id is required"):
            StreamEvent(**_valid_kwargs(request_id=None))

    def test_whitespace_role_passes(self):
        """Whitespace-only role passes (not stripped, not empty)."""
        event = StreamEvent(**_valid_kwargs(role="  "))
        assert event.role == "  "

    def test_whitespace_type_passes(self):
        """Whitespace-only type passes."""
        event = StreamEvent(**_valid_kwargs(type="  "))
        assert event.type == "  "

    def test_error_validation_order(self):
        """Role validated first, then type, then request_id, then sequence."""
        # All invalid — role error should surface first
        with pytest.raises(ValueError, match="role is required"):
            StreamEvent(
                role="", type="", request_id="", sequence=-1,
                timestamp="2026-01-01T00:00:00Z",
            )


# ---------------------------------------------------------------------------
# validate_event_dict
# ---------------------------------------------------------------------------

class TestValidateEventDict:
    """Tests for validate_event_dict."""

    def test_valid_dict_returns_true(self):
        """Dict with all 5 required fields returns True."""
        assert validate_event_dict(_valid_event_dict()) is True

    def test_extra_fields_allowed(self):
        """Extra fields don't affect validation."""
        assert validate_event_dict(_valid_event_dict(content="hi", extra="field")) is True

    def test_missing_role_returns_false(self):
        """Missing role returns False."""
        d = _valid_event_dict()
        del d["role"]
        assert validate_event_dict(d) is False

    def test_missing_type_returns_false(self):
        """Missing type returns False."""
        d = _valid_event_dict()
        del d["type"]
        assert validate_event_dict(d) is False

    def test_missing_request_id_returns_false(self):
        """Missing request_id returns False."""
        d = _valid_event_dict()
        del d["request_id"]
        assert validate_event_dict(d) is False

    def test_missing_sequence_returns_false(self):
        """Missing sequence returns False."""
        d = _valid_event_dict()
        del d["sequence"]
        assert validate_event_dict(d) is False

    def test_missing_timestamp_returns_false(self):
        """Missing timestamp returns False."""
        d = _valid_event_dict()
        del d["timestamp"]
        assert validate_event_dict(d) is False

    def test_empty_dict_returns_false(self):
        """Empty dict returns False."""
        assert validate_event_dict({}) is False

    def test_none_values_still_valid(self):
        """Fields present with None values still count as 'present'."""
        d = _valid_event_dict()
        d["role"] = None
        d["type"] = None
        assert validate_event_dict(d) is True

    def test_multiple_missing_returns_false(self):
        """Multiple missing fields returns False."""
        assert validate_event_dict({"role": "assistant"}) is False


# ---------------------------------------------------------------------------
# is_artifact_event
# ---------------------------------------------------------------------------

class TestIsArtifactEvent:
    """Tests for is_artifact_event."""

    def test_with_artifact_id_returns_true(self):
        """Event with non-None artifact_id returns True."""
        assert is_artifact_event({"artifact_id": "art-001"}) is True

    def test_without_artifact_id_returns_false(self):
        """Event without artifact_id key returns False."""
        assert is_artifact_event({"role": "assistant"}) is False

    def test_none_artifact_id_returns_false(self):
        """Event with artifact_id=None returns False."""
        assert is_artifact_event({"artifact_id": None}) is False

    def test_empty_string_artifact_id_returns_true(self):
        """Event with artifact_id="" returns True (key present, not None)."""
        assert is_artifact_event({"artifact_id": ""}) is True

    def test_empty_dict(self):
        """Empty dict returns False."""
        assert is_artifact_event({}) is False


# ---------------------------------------------------------------------------
# is_marker_event
# ---------------------------------------------------------------------------

class TestIsMarkerEvent:
    """Tests for is_marker_event."""

    def test_start_true_returns_true(self):
        """Event with start=True is a marker."""
        assert is_marker_event({"start": True}) is True

    def test_end_true_returns_true(self):
        """Event with end=True is a marker."""
        assert is_marker_event({"end": True}) is True

    def test_both_true_returns_true(self):
        """Event with both start and end True is a marker."""
        assert is_marker_event({"start": True, "end": True}) is True

    def test_both_false_returns_false(self):
        """Event with both False returns False."""
        assert is_marker_event({"start": False, "end": False}) is False

    def test_missing_keys_returns_false(self):
        """Missing start/end keys default to False."""
        assert is_marker_event({}) is False

    def test_start_only_missing_end(self):
        """Only start present and True."""
        assert is_marker_event({"start": True}) is True

    def test_end_only_missing_start(self):
        """Only end present and True."""
        assert is_marker_event({"end": True}) is True

    def test_truthy_non_bool_start(self):
        """Truthy non-bool value for start (e.g., 1) counts as marker."""
        assert is_marker_event({"start": 1})

    def test_falsy_non_bool_values(self):
        """Falsy non-bool values (0, '', None) don't make it a marker."""
        assert not is_marker_event({"start": 0, "end": 0})
        assert not is_marker_event({"start": "", "end": ""})
        assert not is_marker_event({"start": None, "end": None})
