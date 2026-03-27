"""
@.architecture
Incoming: none --- {Dict[str, str], primitives}
Processing: validate trail hierarchy structure, enforce node status transitions, verify constraints --- {3 jobs: JOB_ROUTE_BY_TYPE, JOB_TRANSFORM_DATA, JOB_VALIDATE_SCHEMA}
Outgoing: none --- {Dict[str, Any], dict}

Trail Hierarchy Entity - Pure trail hierarchy domain model

Pure domain logic for trail hierarchy structure and state machine.
NO I/O, NO external dependencies, framework-agnostic.

Architecture:
- Group contains one or more Subgroups (one per code execution cycle)
- Each Subgroup contains exactly 3 Nodes (writing, executing, output)
- Node status state machine: pending → active → completed
- Phase transitions: writing → executing → output

Constraints (see contracts/README.md):
- Group must have at least one subgroup
- Subgroup must have exactly 3 nodes
- Nodes transition in order: writing, executing, output
- Executing node NEVER has artifacts (DB constraint)
- Code artifacts link to writing node only
- Output artifacts link to output node only
"""

from dataclasses import dataclass
from typing import List, Optional


# Node status values per DB schema
NODE_STATUS = {"pending", "active", "completed", "error"}

# Node types (see contracts/README.md)
NODE_TYPES = {"writing", "executing", "output"}

# Valid phase sequence
PHASE_SEQUENCE = ["writing", "executing", "output"]


@dataclass(frozen=True)
class Node:
    """
    Immutable node entity.
    
    Represents a single node in trail hierarchy.
    """
    node_id: str
    node_type: str  # writing, executing, output
    sequence: int  # 0, 1, 2
    status: str = "pending"  # pending, active, completed, error
    
    def __post_init__(self):
        """Validate node after construction."""
        if self.node_type not in NODE_TYPES:
            raise ValueError(f"Invalid node_type: {self.node_type}. Must be one of {NODE_TYPES}")
        if self.status not in NODE_STATUS:
            raise ValueError(f"Invalid status: {self.status}. Must be one of {NODE_STATUS}")
        if not (0 <= self.sequence <= 2):
            raise ValueError(f"Invalid sequence: {self.sequence}. Must be 0, 1, or 2")


def validate_node_status_transition(
    current_status: str,
    new_status: str,
) -> bool:
    """
    Validate node status transition is allowed.
    
    Args:
        current_status: Current node status
        new_status: Target node status
        
    Returns:
        True if transition is valid, False otherwise
        
    Valid transitions:
        pending → active
        active → completed
        active → error
        pending → error (for cleanup)
    """
    if current_status == new_status:
        return True  # No-op transition
    
    valid_transitions = {
        "pending": {"active", "error"},
        "active": {"completed", "error"},
        "completed": set(),  # Terminal state
        "error": set(),  # Terminal state
    }
    
    return new_status in valid_transitions.get(current_status, set())


def validate_subgroup_structure(nodes: List[Node]) -> bool:
    """
    Validate subgroup has exactly 3 nodes in correct order.
    
    Args:
        nodes: List of nodes in subgroup
        
    Returns:
        True if structure is valid, False otherwise
        
    Requirements:
        - Exactly 3 nodes
        - Sequences: 0, 1, 2
        - Types: writing, executing, output (in order)
    """
    if len(nodes) != 3:
        return False
    
    # Sort by sequence
    sorted_nodes = sorted(nodes, key=lambda n: n.sequence)
    
    # Verify sequences
    if [n.sequence for n in sorted_nodes] != [0, 1, 2]:
        return False
    
    # Verify types
    expected_types = ["writing", "executing", "output"]
    if [n.node_type for n in sorted_nodes] != expected_types:
        return False
    
    return True


def get_node_for_artifact_type(
    nodes: List[Node],
    artifact_type: str,
) -> Optional[Node]:
    """
    Get the node that should receive an artifact of given type.
    
    Args:
        nodes: List of nodes in subgroup
        artifact_type: Artifact type (code, output)
        
    Returns:
        Node that should receive artifact, None if invalid type
        
    Rules:
        code → writing node (sequence=0)
        output → output node (sequence=2)
        executing node (sequence=1) NEVER receives artifacts
    """
    if artifact_type == "code":
        # Find writing node
        for node in nodes:
            if node.node_type == "writing":
                return node
    elif artifact_type == "output":
        # Find output node
        for node in nodes:
            if node.node_type == "output":
                return node
    
    return None


def can_link_artifact_to_node(
    node_type: str,
    artifact_type: str,
) -> bool:
    """
    Check if artifact type can be linked to node type.
    
    Args:
        node_type: Node type (writing, executing, output)
        artifact_type: Artifact type (code, output)
        
    Returns:
        True if linking is allowed, False otherwise
        
    Rules:
        writing node accepts code artifacts
        output node accepts output artifacts
        executing node accepts NO artifacts
    """
    if node_type == "writing" and artifact_type == "code":
        return True
    if node_type == "output" and artifact_type == "output":
        return True
    return False

