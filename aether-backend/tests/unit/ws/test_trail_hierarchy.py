"""
Unit Tests: ws/domain/entities/trail_hierarchy.py

Tests pure domain logic for trail hierarchy structure, node validation,
status transitions, and artifact linking rules.

No bugs found. Clean domain entity with proper constraints.
"""

import pytest

from ws.domain.entities.trail_hierarchy import (
    NODE_STATUS,
    NODE_TYPES,
    PHASE_SEQUENCE,
    Node,
    can_link_artifact_to_node,
    get_node_for_artifact_type,
    validate_node_status_transition,
    validate_subgroup_structure,
)


# =========================================================================
# Constants
# =========================================================================

class TestConstants:
    """Verify domain constants are correct."""

    def test_node_status_values(self):
        assert NODE_STATUS == {"pending", "active", "completed", "error"}

    def test_node_types_values(self):
        assert NODE_TYPES == {"writing", "executing", "output"}

    def test_phase_sequence(self):
        assert PHASE_SEQUENCE == ["writing", "executing", "output"]


# =========================================================================
# Node dataclass
# =========================================================================

class TestNode:
    """Tests for Node dataclass (lines 41-60)."""

    def test_valid_writing_node(self):
        node = Node(node_id="n1", node_type="writing", sequence=0)
        assert node.node_id == "n1"
        assert node.node_type == "writing"
        assert node.sequence == 0
        assert node.status == "pending"

    def test_valid_executing_node(self):
        node = Node(node_id="n2", node_type="executing", sequence=1, status="active")
        assert node.status == "active"

    def test_valid_output_node(self):
        node = Node(node_id="n3", node_type="output", sequence=2, status="completed")
        assert node.status == "completed"

    def test_default_status_is_pending(self):
        node = Node(node_id="n1", node_type="writing", sequence=0)
        assert node.status == "pending"

    def test_invalid_node_type_raises(self):
        with pytest.raises(ValueError, match="Invalid node_type"):
            Node(node_id="n1", node_type="invalid", sequence=0)

    def test_invalid_status_raises(self):
        with pytest.raises(ValueError, match="Invalid status"):
            Node(node_id="n1", node_type="writing", sequence=0, status="unknown")

    def test_invalid_sequence_negative(self):
        with pytest.raises(ValueError, match="Invalid sequence"):
            Node(node_id="n1", node_type="writing", sequence=-1)

    def test_invalid_sequence_too_high(self):
        with pytest.raises(ValueError, match="Invalid sequence"):
            Node(node_id="n1", node_type="writing", sequence=3)

    def test_frozen_immutable(self):
        """Frozen dataclass — cannot modify after creation."""
        node = Node(node_id="n1", node_type="writing", sequence=0)
        with pytest.raises(AttributeError):
            node.status = "active"

    def test_all_valid_node_types(self):
        """Every NODE_TYPES value creates a valid node."""
        for i, ntype in enumerate(PHASE_SEQUENCE):
            node = Node(node_id=f"n{i}", node_type=ntype, sequence=i)
            assert node.node_type == ntype

    def test_all_valid_statuses(self):
        """Every NODE_STATUS value creates a valid node."""
        for status in NODE_STATUS:
            node = Node(node_id="n1", node_type="writing", sequence=0, status=status)
            assert node.status == status

    def test_error_status_node(self):
        """Error status is valid."""
        node = Node(node_id="n1", node_type="writing", sequence=0, status="error")
        assert node.status == "error"


# =========================================================================
# validate_node_status_transition
# =========================================================================

class TestValidateNodeStatusTransition:
    """Tests for validate_node_status_transition (lines 63-93)."""

    def test_same_status_always_valid(self):
        """No-op transition (same status) → True."""
        for status in NODE_STATUS:
            assert validate_node_status_transition(status, status) is True

    def test_pending_to_active(self):
        assert validate_node_status_transition("pending", "active") is True

    def test_pending_to_error(self):
        """Cleanup transition."""
        assert validate_node_status_transition("pending", "error") is True

    def test_active_to_completed(self):
        assert validate_node_status_transition("active", "completed") is True

    def test_active_to_error(self):
        assert validate_node_status_transition("active", "error") is True

    def test_completed_is_terminal(self):
        """Completed → cannot transition to anything else."""
        assert validate_node_status_transition("completed", "pending") is False
        assert validate_node_status_transition("completed", "active") is False
        assert validate_node_status_transition("completed", "error") is False

    def test_error_is_terminal(self):
        """Error → cannot transition to anything else."""
        assert validate_node_status_transition("error", "pending") is False
        assert validate_node_status_transition("error", "active") is False
        assert validate_node_status_transition("error", "completed") is False

    def test_pending_to_completed_invalid(self):
        """Cannot skip active → go straight to completed."""
        assert validate_node_status_transition("pending", "completed") is False

    def test_active_to_pending_invalid(self):
        """Cannot go back to pending."""
        assert validate_node_status_transition("active", "pending") is False

    def test_unknown_status_returns_false(self):
        """Unknown current status → empty valid transitions set."""
        assert validate_node_status_transition("unknown", "active") is False


# =========================================================================
# validate_subgroup_structure
# =========================================================================

class TestValidateSubgroupStructure:
    """Tests for validate_subgroup_structure (lines 96-126)."""

    def test_valid_structure(self):
        """3 nodes in correct order → True."""
        nodes = [
            Node(node_id="1", node_type="writing", sequence=0),
            Node(node_id="2", node_type="executing", sequence=1),
            Node(node_id="3", node_type="output", sequence=2),
        ]
        assert validate_subgroup_structure(nodes) is True

    def test_too_few_nodes(self):
        """2 nodes → False."""
        nodes = [
            Node(node_id="1", node_type="writing", sequence=0),
            Node(node_id="2", node_type="executing", sequence=1),
        ]
        assert validate_subgroup_structure(nodes) is False

    def test_too_many_nodes(self):
        """4 nodes → False."""
        nodes = [
            Node(node_id="1", node_type="writing", sequence=0),
            Node(node_id="2", node_type="executing", sequence=1),
            Node(node_id="3", node_type="output", sequence=2),
            Node(node_id="4", node_type="writing", sequence=0),
        ]
        assert validate_subgroup_structure(nodes) is False

    def test_empty_nodes(self):
        """No nodes → False."""
        assert validate_subgroup_structure([]) is False

    def test_wrong_types_order(self):
        """Correct sequences but wrong types → False."""
        nodes = [
            Node(node_id="1", node_type="output", sequence=0),
            Node(node_id="2", node_type="writing", sequence=1),
            Node(node_id="3", node_type="executing", sequence=2),
        ]
        assert validate_subgroup_structure(nodes) is False

    def test_unsorted_but_valid(self):
        """Nodes arrive unsorted but correct → sorted and validated → True."""
        nodes = [
            Node(node_id="3", node_type="output", sequence=2),
            Node(node_id="1", node_type="writing", sequence=0),
            Node(node_id="2", node_type="executing", sequence=1),
        ]
        assert validate_subgroup_structure(nodes) is True

    def test_wrong_sequences(self):
        """Right types but wrong sequence numbers → False."""
        nodes = [
            Node(node_id="1", node_type="writing", sequence=0),
            Node(node_id="2", node_type="executing", sequence=0),
            Node(node_id="3", node_type="output", sequence=2),
        ]
        assert validate_subgroup_structure(nodes) is False


# =========================================================================
# get_node_for_artifact_type
# =========================================================================

class TestGetNodeForArtifactType:
    """Tests for get_node_for_artifact_type (lines 129-159)."""

    def _make_nodes(self):
        return [
            Node(node_id="w", node_type="writing", sequence=0),
            Node(node_id="e", node_type="executing", sequence=1),
            Node(node_id="o", node_type="output", sequence=2),
        ]

    def test_code_returns_writing_node(self):
        nodes = self._make_nodes()
        result = get_node_for_artifact_type(nodes, "code")
        assert result is not None
        assert result.node_id == "w"
        assert result.node_type == "writing"

    def test_output_returns_output_node(self):
        nodes = self._make_nodes()
        result = get_node_for_artifact_type(nodes, "output")
        assert result is not None
        assert result.node_id == "o"
        assert result.node_type == "output"

    def test_executing_type_returns_none(self):
        """'executing' is not an artifact type → None."""
        nodes = self._make_nodes()
        assert get_node_for_artifact_type(nodes, "executing") is None

    def test_invalid_type_returns_none(self):
        """Unknown artifact type → None."""
        nodes = self._make_nodes()
        assert get_node_for_artifact_type(nodes, "unknown") is None

    def test_empty_nodes_returns_none(self):
        """No nodes → None."""
        assert get_node_for_artifact_type([], "code") is None


# =========================================================================
# can_link_artifact_to_node
# =========================================================================

class TestCanLinkArtifactToNode:
    """Tests for can_link_artifact_to_node (lines 162-185)."""

    def test_writing_code_allowed(self):
        assert can_link_artifact_to_node("writing", "code") is True

    def test_output_output_allowed(self):
        assert can_link_artifact_to_node("output", "output") is True

    def test_executing_code_blocked(self):
        """Executing node NEVER receives artifacts (DB constraint)."""
        assert can_link_artifact_to_node("executing", "code") is False

    def test_executing_output_blocked(self):
        assert can_link_artifact_to_node("executing", "output") is False

    def test_writing_output_blocked(self):
        """Writing node only accepts code, not output."""
        assert can_link_artifact_to_node("writing", "output") is False

    def test_output_code_blocked(self):
        """Output node only accepts output, not code."""
        assert can_link_artifact_to_node("output", "code") is False

    def test_unknown_node_type(self):
        assert can_link_artifact_to_node("unknown", "code") is False

    def test_unknown_artifact_type(self):
        assert can_link_artifact_to_node("writing", "unknown") is False
