"""
Unit tests for ws.domain.builders.event_enricher

Tests:
- generate_artifact_id: stable ID format
- get_artifact_key: cache key generation
- enrich_event: full metadata injection logic
- should_assign_execution_group: artifact type delegation

Pure domain logic — minimal mocking (only _utc_now_iso for deterministic timestamps,
and should_assign_execution_group which has a lazy import).

Bugs found: 0
"""

from unittest.mock import patch

from ws.domain.builders.event_enricher import (
    generate_artifact_id,
    get_artifact_key,
    enrich_event,
    should_assign_execution_group,
)


# ---------------------------------------------------------------------------
# generate_artifact_id
# ---------------------------------------------------------------------------

class TestGenerateArtifactId:
    """Tests for generate_artifact_id."""

    def test_standard_format(self):
        """Generates {backend_id}:{type}:{counter} format."""
        result = generate_artifact_id("req_123", "code", 1)
        assert result == "req_123:code:1"

    def test_output_type(self):
        """Works with output type."""
        result = generate_artifact_id("req_456", "output", 2)
        assert result == "req_456:output:2"

    def test_counter_zero(self):
        """Counter 0 produces valid ID."""
        result = generate_artifact_id("req_789", "code", 0)
        assert result == "req_789:code:0"

    def test_large_counter(self):
        """Large counter works."""
        result = generate_artifact_id("req_001", "output", 999)
        assert result == "req_001:output:999"

    def test_different_backends_produce_different_ids(self):
        """Different backend IDs produce different artifact IDs."""
        id1 = generate_artifact_id("req_a", "code", 1)
        id2 = generate_artifact_id("req_b", "code", 1)
        assert id1 != id2

    def test_deterministic(self):
        """Same inputs always produce same output."""
        id1 = generate_artifact_id("req_001", "code", 1)
        id2 = generate_artifact_id("req_001", "code", 1)
        assert id1 == id2


# ---------------------------------------------------------------------------
# get_artifact_key
# ---------------------------------------------------------------------------

class TestGetArtifactKey:
    """Tests for get_artifact_key."""

    def test_standard_key(self):
        """Generates {role_lower}:{type_lower} key."""
        result = get_artifact_key("assistant", "code")
        assert result == "assistant:code"

    def test_case_insensitive(self):
        """Both role and type are lowercased."""
        result = get_artifact_key("ASSISTANT", "CODE")
        assert result == "assistant:code"

    def test_mixed_case(self):
        """Mixed case inputs are lowered."""
        result = get_artifact_key("Computer", "Output")
        assert result == "computer:output"

    def test_different_roles_produce_different_keys(self):
        """Different roles produce different keys for same type."""
        k1 = get_artifact_key("assistant", "code")
        k2 = get_artifact_key("computer", "code")
        assert k1 != k2


# ---------------------------------------------------------------------------
# enrich_event — core behavior
# ---------------------------------------------------------------------------

class TestEnrichEvent:
    """Tests for enrich_event core behavior."""

    @patch("ws.domain.builders.event_enricher._utc_now_iso", return_value="2026-02-09T00:00:00+00:00")
    def test_minimal_enrichment(self, _mock_ts):
        """Minimal call sets request_id, sequence, timestamp."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0)

        assert result["request_id"] == "req-001"
        assert result["sequence"] == 0
        assert result["timestamp"] == "2026-02-09T00:00:00+00:00"
        assert result["role"] == "assistant"
        assert result["type"] == "message"

    def test_does_not_mutate_input(self):
        """Original event dict is not modified."""
        event = {"role": "assistant", "type": "message"}
        original = dict(event)
        enrich_event(event, backend_id="req-001", sequence=0)
        assert event == original

    def test_returns_new_dict(self):
        """Result is a new dict, not the input."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0)
        assert result is not event


# ---------------------------------------------------------------------------
# enrich_event — Open Interpreter ID stripping
# ---------------------------------------------------------------------------

class TestEnrichEventIdStripping:
    """Tests for Open Interpreter 'id' field removal."""

    def test_strips_oi_id(self):
        """Removes Open Interpreter's 'id' field."""
        event = {"role": "assistant", "type": "message", "id": "oi-id-123"}
        result = enrich_event(event, backend_id="req-001", sequence=0)
        assert "id" not in result
        assert result["request_id"] == "req-001"

    def test_no_id_field_no_error(self):
        """Events without 'id' field work fine."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0)
        assert "id" not in result

    def test_backend_id_forced_over_existing_request_id(self):
        """Backend's request_id overrides any pre-existing request_id."""
        event = {"role": "assistant", "type": "message", "request_id": "foreign-id"}
        result = enrich_event(event, backend_id="req-001", sequence=0)
        assert result["request_id"] == "req-001"


# ---------------------------------------------------------------------------
# enrich_event — optional metadata
# ---------------------------------------------------------------------------

class TestEnrichEventOptionalMetadata:
    """Tests for optional metadata fields."""

    def test_frontend_id_set_if_not_present(self):
        """frontend_id injected via setdefault."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0, frontend_id="fe-001")
        assert result["frontend_id"] == "fe-001"

    def test_frontend_id_not_overwritten(self):
        """Pre-existing frontend_id is preserved (setdefault)."""
        event = {"role": "assistant", "type": "message", "frontend_id": "existing-fe"}
        result = enrich_event(event, backend_id="req-001", sequence=0, frontend_id="fe-001")
        assert result["frontend_id"] == "existing-fe"

    def test_correlation_id_set(self):
        """correlation_id injected."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0, correlation_id="cor-001")
        assert result["correlation_id"] == "cor-001"

    def test_chat_id_set(self):
        """chat_id injected."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0, chat_id="chat-001")
        assert result["chat_id"] == "chat-001"

    def test_none_frontend_id_skipped(self):
        """None frontend_id does not add field."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0, frontend_id=None)
        assert "frontend_id" not in result

    def test_empty_string_frontend_id_skipped(self):
        """Empty string frontend_id is falsy, so skipped."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0, frontend_id="")
        assert "frontend_id" not in result


# ---------------------------------------------------------------------------
# enrich_event — sequence and timestamp
# ---------------------------------------------------------------------------

class TestEnrichEventSequenceTimestamp:
    """Tests for sequence and timestamp behavior."""

    def test_sequence_set(self):
        """Sequence is set via setdefault."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=5)
        assert result["sequence"] == 5

    def test_pre_existing_sequence_preserved(self):
        """Pre-existing sequence preserved via setdefault."""
        event = {"role": "assistant", "type": "message", "sequence": 99}
        result = enrich_event(event, backend_id="req-001", sequence=5)
        assert result["sequence"] == 99

    @patch("ws.domain.builders.event_enricher._utc_now_iso", return_value="2026-02-09T12:00:00+00:00")
    def test_timestamp_generated(self, _mock_ts):
        """Timestamp auto-generated if not present."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0)
        assert result["timestamp"] == "2026-02-09T12:00:00+00:00"

    def test_pre_existing_timestamp_preserved(self):
        """Pre-existing timestamp preserved via setdefault."""
        event = {"role": "assistant", "type": "message", "timestamp": "pre-existing"}
        result = enrich_event(event, backend_id="req-001", sequence=0)
        assert result["timestamp"] == "pre-existing"


# ---------------------------------------------------------------------------
# enrich_event — execution_group
# ---------------------------------------------------------------------------

class TestEnrichEventExecutionGroup:
    """Tests for execution_group behavior."""

    def test_execution_group_set(self):
        """execution_group is force-set (not setdefault)."""
        event = {"role": "assistant", "type": "code"}
        result = enrich_event(event, backend_id="req-001", sequence=0, execution_group="eg-001")
        assert result["execution_group"] == "eg-001"

    def test_execution_group_overrides_existing(self):
        """Backend's execution_group overrides any pre-existing value."""
        event = {"role": "assistant", "type": "code", "execution_group": "foreign-eg"}
        result = enrich_event(event, backend_id="req-001", sequence=0, execution_group="eg-001")
        assert result["execution_group"] == "eg-001"

    def test_none_execution_group_not_added(self):
        """None execution_group does not add the field."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0, execution_group=None)
        assert "execution_group" not in result


# ---------------------------------------------------------------------------
# enrich_event — artifact_id
# ---------------------------------------------------------------------------

class TestEnrichEventArtifactId:
    """Tests for artifact_id handling (CRITICAL: backend owns artifact_id)."""

    def test_artifact_id_force_set(self):
        """Backend's artifact_id is force-set."""
        event = {"role": "assistant", "type": "code"}
        result = enrich_event(event, backend_id="req-001", sequence=0, artifact_id="art-001")
        assert result["artifact_id"] == "art-001"

    def test_artifact_id_overrides_foreign(self):
        """Backend's artifact_id overrides foreign artifact_id from Open Interpreter."""
        event = {"role": "assistant", "type": "code", "artifact_id": "oi-art-foreign"}
        result = enrich_event(event, backend_id="req-001", sequence=0, artifact_id="art-001")
        assert result["artifact_id"] == "art-001"

    def test_foreign_artifact_id_stripped_when_none(self):
        """Foreign artifact_id is STRIPPED when no backend artifact_id provided."""
        event = {"role": "computer", "type": "output", "artifact_id": "foreign-id"}
        result = enrich_event(event, backend_id="req-001", sequence=0, artifact_id=None)
        assert "artifact_id" not in result

    def test_no_artifact_id_added_when_none(self):
        """No artifact_id field when not provided and event has none."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0)
        assert "artifact_id" not in result


# ---------------------------------------------------------------------------
# enrich_event — message_id
# ---------------------------------------------------------------------------

class TestEnrichEventMessageId:
    """Tests for message_id behavior."""

    def test_message_id_set(self):
        """message_id injected via setdefault."""
        event = {"role": "assistant", "type": "code"}
        result = enrich_event(event, backend_id="req-001", sequence=0, message_id="msg-001")
        assert result["message_id"] == "msg-001"

    def test_message_id_not_overwritten(self):
        """Pre-existing message_id preserved via setdefault."""
        event = {"role": "assistant", "type": "code", "message_id": "existing-msg"}
        result = enrich_event(event, backend_id="req-001", sequence=0, message_id="msg-001")
        assert result["message_id"] == "existing-msg"

    def test_none_message_id_skipped(self):
        """None message_id does not add field."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0, message_id=None)
        assert "message_id" not in result


# ---------------------------------------------------------------------------
# enrich_event — recipient preservation
# ---------------------------------------------------------------------------

class TestEnrichEventRecipient:
    """Tests for recipient field preservation."""

    def test_recipient_preserved(self):
        """Recipient field from original event is preserved."""
        event = {"role": "server", "type": "message", "recipient": "user-001"}
        result = enrich_event(event, backend_id="req-001", sequence=0)
        assert result["recipient"] == "user-001"

    def test_no_recipient_no_field(self):
        """No recipient in event = no recipient in result."""
        event = {"role": "assistant", "type": "message"}
        result = enrich_event(event, backend_id="req-001", sequence=0)
        assert "recipient" not in result


# ---------------------------------------------------------------------------
# should_assign_execution_group
# ---------------------------------------------------------------------------

class TestShouldAssignExecutionGroup:
    """Tests for should_assign_execution_group."""

    def test_code_type_returns_true(self):
        """'code' is an artifact type — should get execution_group."""
        assert should_assign_execution_group("code") is True

    def test_output_type_returns_true(self):
        """'output' is an artifact type — should get execution_group."""
        assert should_assign_execution_group("output") is True

    def test_message_type_returns_false(self):
        """'message' is NOT an artifact type."""
        assert should_assign_execution_group("message") is False

    def test_completion_type_returns_false(self):
        """'completion' is NOT an artifact type."""
        assert should_assign_execution_group("completion") is False

    def test_case_insensitive(self):
        """'Code' (mixed case) is still recognized via is_artifact_type."""
        assert should_assign_execution_group("Code") is True

    def test_empty_string_returns_false(self):
        """Empty string is not an artifact type."""
        assert should_assign_execution_group("") is False
