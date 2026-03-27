"""
Unit tests for ws.domain.validators.trail_validator

Tests all 5 public functions:
- validate_subgroup_node_count: exactly 3 nodes required
- validate_node_sequences: must be [0, 1, 2]
- validate_node_types: must be [writing, executing, output]
- validate_artifact_linking: code→writing, output→output only
- validate_complete_subgroup: combined validation

Pure domain logic — no mocks needed.

Bugs found and fixed: 2
  1. validate_node_sequences: node.get("sequence", -1) returned None (not -1) when
     key existed with None value, causing sorted() to crash with TypeError.
     Fixed: explicit None coalescing to -1.
  2. validate_node_types: same root cause with node.get("sequence", 0) returning
     None, crashing sorted() lambda key function.
     Fixed: explicit None coalescing to 0.
"""

import pytest

from ws.domain.validators.trail_validator import (
    ValidationError,
    validate_subgroup_node_count,
    validate_node_sequences,
    validate_node_types,
    validate_artifact_linking,
    validate_complete_subgroup,
)


def _make_nodes(sequences=None, types=None):
    """Helper: build a list of node dicts."""
    if sequences is None:
        sequences = [0, 1, 2]
    if types is None:
        types = ["writing", "executing", "output"]
    return [
        {"sequence": s, "node_type": t}
        for s, t in zip(sequences, types)
    ]


# ---------------------------------------------------------------------------
# validate_subgroup_node_count
# ---------------------------------------------------------------------------

class TestValidateSubgroupNodeCount:
    """Tests for validate_subgroup_node_count."""

    def test_exactly_three_passes(self):
        """3 nodes passes without error."""
        validate_subgroup_node_count(_make_nodes())

    def test_zero_nodes_raises(self):
        """Empty list raises."""
        with pytest.raises(ValidationError, match="exactly 3 nodes, got 0"):
            validate_subgroup_node_count([])

    def test_one_node_raises(self):
        """1 node raises."""
        with pytest.raises(ValidationError, match="exactly 3 nodes, got 1"):
            validate_subgroup_node_count([{"sequence": 0}])

    def test_two_nodes_raises(self):
        """2 nodes raises."""
        with pytest.raises(ValidationError, match="exactly 3 nodes, got 2"):
            validate_subgroup_node_count([{"sequence": 0}, {"sequence": 1}])

    def test_four_nodes_raises(self):
        """4 nodes raises."""
        nodes = [{"sequence": i} for i in range(4)]
        with pytest.raises(ValidationError, match="exactly 3 nodes, got 4"):
            validate_subgroup_node_count(nodes)

    def test_large_list_raises(self):
        """Large list raises with correct count."""
        nodes = [{"sequence": i} for i in range(100)]
        with pytest.raises(ValidationError, match="got 100"):
            validate_subgroup_node_count(nodes)


# ---------------------------------------------------------------------------
# validate_node_sequences
# ---------------------------------------------------------------------------

class TestValidateNodeSequences:
    """Tests for validate_node_sequences."""

    def test_valid_ordered_sequences(self):
        """[0, 1, 2] in order passes."""
        validate_node_sequences(_make_nodes())

    def test_valid_unordered_sequences(self):
        """[2, 0, 1] passes (function sorts before comparing)."""
        validate_node_sequences(_make_nodes(sequences=[2, 0, 1]))

    def test_duplicate_sequences_raises(self):
        """[0, 0, 2] raises."""
        with pytest.raises(ValidationError, match=r"must be \[0, 1, 2\]"):
            validate_node_sequences(_make_nodes(sequences=[0, 0, 2]))

    def test_wrong_start_raises(self):
        """[1, 2, 3] raises."""
        with pytest.raises(ValidationError, match=r"must be \[0, 1, 2\]"):
            validate_node_sequences(_make_nodes(sequences=[1, 2, 3]))

    def test_negative_sequences_raises(self):
        """[-1, 0, 1] raises."""
        with pytest.raises(ValidationError, match=r"must be \[0, 1, 2\]"):
            validate_node_sequences(_make_nodes(sequences=[-1, 0, 1]))

    def test_missing_sequence_key_uses_default(self):
        """Nodes missing 'sequence' key get -1 default, which fails validation."""
        nodes = [{"node_type": "writing"}, {"node_type": "executing"}, {"node_type": "output"}]
        with pytest.raises(ValidationError, match=r"must be \[0, 1, 2\]"):
            validate_node_sequences(nodes)

    def test_none_sequence_value_caught(self):
        """BUG FIXED: node with sequence=None now raises ValidationError.

        Previously dict.get("sequence", -1) returned None (not -1) when key existed
        with None value, causing sorted() to crash with TypeError. Fixed by explicit
        None coalescing.
        """
        nodes = [
            {"sequence": 0, "node_type": "writing"},
            {"sequence": None, "node_type": "executing"},
            {"sequence": 2, "node_type": "output"},
        ]
        # Fixed: now correctly raises ValidationError (None coalesced to -1)
        with pytest.raises(ValidationError, match=r"must be \[0, 1, 2\]"):
            validate_node_sequences(nodes)

    def test_error_message_includes_actual_sequences(self):
        """Error message shows the actual sequences found."""
        with pytest.raises(ValidationError) as exc_info:
            validate_node_sequences(_make_nodes(sequences=[0, 0, 0]))
        assert "[0, 0, 0]" in str(exc_info.value)

    def test_float_sequences_pass(self):
        """Float 0.0, 1.0, 2.0 passes (Python float==int comparison)."""
        validate_node_sequences(_make_nodes(sequences=[0.0, 1.0, 2.0]))


# ---------------------------------------------------------------------------
# validate_node_types
# ---------------------------------------------------------------------------

class TestValidateNodeTypes:
    """Tests for validate_node_types."""

    def test_valid_types_in_order(self):
        """[writing, executing, output] in correct order passes."""
        validate_node_types(_make_nodes())

    def test_valid_types_unordered(self):
        """Types are sorted by sequence before checking, so unordered input passes."""
        nodes = [
            {"sequence": 2, "node_type": "output"},
            {"sequence": 0, "node_type": "writing"},
            {"sequence": 1, "node_type": "executing"},
        ]
        validate_node_types(nodes)

    def test_wrong_types_raises(self):
        """Wrong type names raise."""
        with pytest.raises(ValidationError, match="must be"):
            validate_node_types(_make_nodes(types=["reading", "running", "result"]))

    def test_swapped_types_raises(self):
        """Types in wrong order (but correct names) raises."""
        nodes = [
            {"sequence": 0, "node_type": "output"},
            {"sequence": 1, "node_type": "writing"},
            {"sequence": 2, "node_type": "executing"},
        ]
        with pytest.raises(ValidationError, match="must be"):
            validate_node_types(nodes)

    def test_missing_node_type_key(self):
        """Missing node_type defaults to empty string, which fails."""
        nodes = [
            {"sequence": 0},
            {"sequence": 1},
            {"sequence": 2},
        ]
        with pytest.raises(ValidationError, match="must be"):
            validate_node_types(nodes)

    def test_empty_string_types_raises(self):
        """All empty string types raises."""
        with pytest.raises(ValidationError, match="must be"):
            validate_node_types(_make_nodes(types=["", "", ""]))

    def test_case_sensitive(self):
        """Type check is case-sensitive."""
        with pytest.raises(ValidationError, match="must be"):
            validate_node_types(_make_nodes(types=["Writing", "Executing", "Output"]))

    def test_none_sequence_value_caught(self):
        """BUG FIXED: node with sequence=None now sorts correctly.

        Previously dict.get("sequence", 0) returned None when key existed with
        None value, crashing sorted() key function. Fixed by explicit None coalescing.
        """
        nodes = [
            {"sequence": 0, "node_type": "writing"},
            {"sequence": None, "node_type": "executing"},
            {"sequence": 2, "node_type": "output"},
        ]
        # Fixed: None coalesced to 0, sort succeeds, types validated normally.
        # With None→0, node order is [writing(0), executing(0), output(2)]
        # which is [writing, executing, output] — passes validation.
        validate_node_types(nodes)

    def test_error_message_includes_actual_types(self):
        """Error message shows actual types found."""
        nodes = _make_nodes(types=["a", "b", "c"])
        with pytest.raises(ValidationError) as exc_info:
            validate_node_types(nodes)
        assert "['a', 'b', 'c']" in str(exc_info.value)


# ---------------------------------------------------------------------------
# validate_artifact_linking
# ---------------------------------------------------------------------------

class TestValidateArtifactLinking:
    """Tests for validate_artifact_linking."""

    def test_code_to_writing_passes(self):
        """code artifact → writing node is valid."""
        validate_artifact_linking("writing", "code")

    def test_output_to_output_passes(self):
        """output artifact → output node is valid."""
        validate_artifact_linking("output", "output")

    def test_code_to_executing_raises(self):
        """code → executing is invalid."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking("executing", "code")

    def test_code_to_output_raises(self):
        """code → output node is invalid."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking("output", "code")

    def test_output_to_writing_raises(self):
        """output → writing node is invalid."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking("writing", "output")

    def test_output_to_executing_raises(self):
        """output → executing node is invalid."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking("executing", "output")

    def test_unknown_artifact_type_raises(self):
        """Unknown artifact type raises."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking("writing", "image")

    def test_unknown_node_type_raises(self):
        """Unknown node type raises."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking("rendering", "code")

    def test_both_unknown_raises(self):
        """Both unknown types raises."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking("foo", "bar")

    def test_empty_strings_raise(self):
        """Empty strings for both params raise."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking("", "")

    def test_none_node_type_raises(self):
        """None node_type raises ValidationError (not TypeError)."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking(None, "code")

    def test_none_artifact_type_raises(self):
        """None artifact_type raises ValidationError (not TypeError)."""
        with pytest.raises(ValidationError, match="Cannot link"):
            validate_artifact_linking("writing", None)

    def test_error_message_contains_types(self):
        """Error message includes the actual types attempted."""
        with pytest.raises(ValidationError) as exc_info:
            validate_artifact_linking("executing", "code")
        msg = str(exc_info.value)
        assert "code" in msg
        assert "executing" in msg

    def test_error_message_contains_valid_combos(self):
        """Error message references valid combinations."""
        with pytest.raises(ValidationError) as exc_info:
            validate_artifact_linking("executing", "code")
        assert "code→writing" in str(exc_info.value) or "Valid" in str(exc_info.value)


# ---------------------------------------------------------------------------
# validate_complete_subgroup
# ---------------------------------------------------------------------------

class TestValidateCompleteSubgroup:
    """Tests for validate_complete_subgroup."""

    def test_valid_subgroup_passes(self):
        """Complete valid subgroup passes all 3 checks."""
        validate_complete_subgroup(_make_nodes())

    def test_valid_subgroup_unordered(self):
        """Valid subgroup with nodes in random order passes."""
        nodes = [
            {"sequence": 2, "node_type": "output"},
            {"sequence": 0, "node_type": "writing"},
            {"sequence": 1, "node_type": "executing"},
        ]
        validate_complete_subgroup(nodes)

    def test_wrong_count_fails_first(self):
        """Count check runs first — 2 nodes rejected before sequence check."""
        nodes = [
            {"sequence": 0, "node_type": "writing"},
            {"sequence": 1, "node_type": "executing"},
        ]
        with pytest.raises(ValidationError, match="exactly 3 nodes"):
            validate_complete_subgroup(nodes)

    def test_wrong_sequences_caught(self):
        """3 nodes with wrong sequences caught by second check."""
        nodes = _make_nodes(sequences=[0, 0, 0])
        with pytest.raises(ValidationError, match=r"must be \[0, 1, 2\]"):
            validate_complete_subgroup(nodes)

    def test_wrong_types_caught(self):
        """3 nodes with correct sequences but wrong types caught by third check."""
        nodes = _make_nodes(types=["output", "output", "output"])
        with pytest.raises(ValidationError, match="must be"):
            validate_complete_subgroup(nodes)

    def test_empty_list_fails(self):
        """Empty list fails at count check."""
        with pytest.raises(ValidationError, match="exactly 3 nodes, got 0"):
            validate_complete_subgroup([])


# ---------------------------------------------------------------------------
# ValidationError type identity
# ---------------------------------------------------------------------------

class TestTrailValidationErrorIdentity:
    """Verify trail_validator's ValidationError."""

    def test_is_exception_subclass(self):
        """ValidationError inherits from Exception."""
        assert issubclass(ValidationError, Exception)

    def test_separate_from_message_validator_error(self):
        """trail_validator defines its own ValidationError, distinct from message_validator's."""
        from ws.domain.validators.message_validator import (
            ValidationError as MsgValidationError,
        )
        # They are separate classes (even if identical structure)
        err_trail = ValidationError("trail error")
        err_msg = MsgValidationError("message error")
        assert type(err_trail).__module__ != type(err_msg).__module__
