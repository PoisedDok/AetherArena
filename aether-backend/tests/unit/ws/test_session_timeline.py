"""
Unit Tests: ws/domain/entities/session_timeline.py

Tests pure domain logic for building and validating session timelines.
No mocking needed — all functions are pure computations.

No bugs found. Well-structured domain entity.
"""


from ws.domain.entities.session_timeline import (
    calculate_duration_ms,
    get_timeline_bounds,
    merge_timelines,
    validate_event_has_sequence,
    validate_sequence_integrity,
)


# =========================================================================
# validate_sequence_integrity
# =========================================================================

class TestValidateSequenceIntegrity:
    """Tests for validate_sequence_integrity (lines 24-53)."""

    def test_empty_list_returns_none(self):
        """No events → valid (None)."""
        assert validate_sequence_integrity([]) is None

    def test_valid_contiguous_sequence(self):
        """Events with sequence 1,2,3 → valid."""
        events = [
            {"sequence": 1, "type": "a"},
            {"sequence": 2, "type": "b"},
            {"sequence": 3, "type": "c"},
        ]
        assert validate_sequence_integrity(events) is None

    def test_gap_detected(self):
        """Events with gap (1,3) → error message."""
        events = [
            {"sequence": 1},
            {"sequence": 3},
        ]
        result = validate_sequence_integrity(events)
        assert isinstance(result, str)
        assert "gap" in result.lower()
        assert "expected 2" in result
        assert "got 3" in result

    def test_missing_sequence_field(self):
        """Event without sequence field → error message."""
        events = [
            {"sequence": 1},
            {"type": "no-sequence"},
        ]
        result = validate_sequence_integrity(events)
        assert isinstance(result, str)
        assert "missing" in result.lower()

    def test_unsorted_input_sorted_before_validation(self):
        """Events arrive out of order → sorted by sequence before checking."""
        events = [
            {"sequence": 3},
            {"sequence": 1},
            {"sequence": 2},
        ]
        assert validate_sequence_integrity(events) is None

    def test_single_event(self):
        """Single event with sequence=1 → valid."""
        assert validate_sequence_integrity([{"sequence": 1}]) is None

    def test_sequence_starting_at_zero_fails(self):
        """Sequence starting at 0 → expected 1, got 0."""
        events = [{"sequence": 0}]
        result = validate_sequence_integrity(events)
        assert isinstance(result, str)
        assert "expected 1" in result
        assert "got 0" in result

    def test_duplicate_sequence_numbers(self):
        """Duplicate sequence numbers → gap detected after duplicate."""
        events = [
            {"sequence": 1},
            {"sequence": 1},
            {"sequence": 2},
        ]
        # After sorting: [1, 1, 2]. Expected 1,2,3.
        # First: expected=1, actual=1 → OK, expected=2
        # Second: expected=2, actual=1 → gap
        result = validate_sequence_integrity(events)
        assert isinstance(result, str)


# =========================================================================
# merge_timelines
# =========================================================================

class TestMergeTimelines:
    """Tests for merge_timelines (lines 56-78)."""

    def test_no_inputs_returns_empty(self):
        """No lists → empty list."""
        assert merge_timelines() == []

    def test_single_list_returned_sorted(self):
        """Single list → returned sorted by sequence."""
        events = [
            {"sequence": 3, "src": "a"},
            {"sequence": 1, "src": "b"},
        ]
        result = merge_timelines(events)
        assert result[0]["sequence"] == 1
        assert result[1]["sequence"] == 3

    def test_multiple_lists_merged_and_sorted(self):
        """Multiple lists → merged into single sorted list."""
        messages = [{"sequence": 1, "type": "msg"}, {"sequence": 3, "type": "msg"}]
        trails = [{"sequence": 2, "type": "trail"}, {"sequence": 4, "type": "trail"}]

        result = merge_timelines(messages, trails)

        assert len(result) == 4
        assert [e["sequence"] for e in result] == [1, 2, 3, 4]

    def test_events_without_sequence_default_to_zero(self):
        """Events without sequence → sorted as 0."""
        events = [
            {"sequence": 2},
            {"no_seq": True},
            {"sequence": 1},
        ]
        result = merge_timelines(events)
        assert result[0].get("sequence", 0) == 0  # no_seq event first
        assert result[1]["sequence"] == 1
        assert result[2]["sequence"] == 2

    def test_preserves_event_data(self):
        """Merge doesn't modify event data."""
        events = [{"sequence": 1, "data": {"nested": True}, "extra": "field"}]
        result = merge_timelines(events)
        assert result[0]["data"] == {"nested": True}
        assert result[0]["extra"] == "field"

    def test_empty_lists_ignored(self):
        """Empty lists among inputs → ignored."""
        events = [{"sequence": 1}]
        result = merge_timelines([], events, [])
        assert len(result) == 1


# =========================================================================
# calculate_duration_ms
# =========================================================================

class TestCalculateDurationMs:
    """Tests for calculate_duration_ms (lines 81-109)."""

    def test_valid_timestamps_with_z_suffix(self):
        """ISO timestamps with Z → duration in ms."""
        result = calculate_duration_ms(
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:00:01Z",
        )
        assert result == 1000

    def test_valid_timestamps_with_offset(self):
        """ISO timestamps with +00:00 → duration in ms."""
        result = calculate_duration_ms(
            "2024-01-01T00:00:00+00:00",
            "2024-01-01T00:00:05+00:00",
        )
        assert result == 5000

    def test_multi_second_duration(self):
        """Longer duration calculated correctly."""
        result = calculate_duration_ms(
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:01:30Z",
        )
        assert result == 90000  # 90 seconds

    def test_empty_start_returns_none(self):
        """Empty start timestamp → None."""
        assert calculate_duration_ms("", "2024-01-01T00:00:01Z") is None

    def test_empty_end_returns_none(self):
        """Empty end timestamp → None."""
        assert calculate_duration_ms("2024-01-01T00:00:00Z", "") is None

    def test_none_start_returns_none(self):
        """None start → None."""
        assert calculate_duration_ms(None, "2024-01-01T00:00:01Z") is None

    def test_none_end_returns_none(self):
        """None end → None."""
        assert calculate_duration_ms("2024-01-01T00:00:00Z", None) is None

    def test_invalid_format_returns_none(self):
        """Non-ISO format → ValueError caught, returns None."""
        assert calculate_duration_ms("not-a-date", "also-not") is None

    def test_negative_duration(self):
        """End before start → negative duration (returned as-is)."""
        result = calculate_duration_ms(
            "2024-01-01T00:00:10Z",
            "2024-01-01T00:00:00Z",
        )
        assert result == -10000

    def test_zero_duration(self):
        """Same timestamps → 0 ms."""
        result = calculate_duration_ms(
            "2024-01-01T12:00:00Z",
            "2024-01-01T12:00:00Z",
        )
        assert result == 0

    def test_sub_second_precision(self):
        """Sub-second timestamps → ms precision."""
        result = calculate_duration_ms(
            "2024-01-01T00:00:00.000Z",
            "2024-01-01T00:00:00.500Z",
        )
        assert result == 500


# =========================================================================
# validate_event_has_sequence
# =========================================================================

class TestValidateEventHasSequence:
    """Tests for validate_event_has_sequence (lines 112-123)."""

    def test_valid_positive_sequence(self):
        """Positive int sequence → True."""
        assert validate_event_has_sequence({"sequence": 1}) is True

    def test_large_sequence(self):
        """Large positive int → True."""
        assert validate_event_has_sequence({"sequence": 999}) is True

    def test_no_sequence_key(self):
        """Missing sequence key → False."""
        assert validate_event_has_sequence({"type": "msg"}) is False

    def test_none_sequence(self):
        """sequence=None → False."""
        assert validate_event_has_sequence({"sequence": None}) is False

    def test_zero_sequence(self):
        """sequence=0 → False (> 0 check)."""
        assert validate_event_has_sequence({"sequence": 0}) is False

    def test_negative_sequence(self):
        """sequence=-1 → False (> 0 check)."""
        assert validate_event_has_sequence({"sequence": -1}) is False

    def test_string_sequence(self):
        """sequence="1" → False (isinstance int check)."""
        assert validate_event_has_sequence({"sequence": "1"}) is False

    def test_float_sequence(self):
        """sequence=1.0 → False (isinstance int, float is not int)."""
        # Note: in Python, isinstance(1.0, int) is False
        # but isinstance(True, int) is True
        assert validate_event_has_sequence({"sequence": 1.0}) is False

    def test_bool_sequence(self):
        """sequence=True → technically isinstance(True, int) is True and True > 0.
        Documents this edge case behavior."""
        # bool is subclass of int in Python: isinstance(True, int) → True
        # True == 1, True > 0 → True
        assert validate_event_has_sequence({"sequence": True}) is True


# =========================================================================
# get_timeline_bounds
# =========================================================================

class TestGetTimelineBounds:
    """Tests for get_timeline_bounds (lines 126-144)."""

    def test_empty_returns_none_none(self):
        """Empty list → (None, None)."""
        assert get_timeline_bounds([]) == (None, None)

    def test_single_event(self):
        """Single event → (timestamp, timestamp)."""
        events = [{"timestamp": "2024-01-01T00:00:00Z"}]
        result = get_timeline_bounds(events)
        assert result == ("2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z")

    def test_multiple_events(self):
        """Multiple events → (first, last) timestamps."""
        events = [
            {"timestamp": "2024-01-01T00:00:00Z"},
            {"timestamp": "2024-01-01T00:00:05Z"},
            {"timestamp": "2024-01-01T00:00:10Z"},
        ]
        result = get_timeline_bounds(events)
        assert result == ("2024-01-01T00:00:00Z", "2024-01-01T00:00:10Z")

    def test_events_without_timestamp(self):
        """Events missing timestamp field → (None, None)."""
        events = [{"data": "a"}, {"data": "b"}]
        result = get_timeline_bounds(events)
        assert result == (None, None)

    def test_first_has_timestamp_last_doesnt(self):
        """First event has timestamp, last doesn't → (timestamp, None)."""
        events = [
            {"timestamp": "2024-01-01T00:00:00Z"},
            {"data": "no-ts"},
        ]
        result = get_timeline_bounds(events)
        assert result == ("2024-01-01T00:00:00Z", None)
