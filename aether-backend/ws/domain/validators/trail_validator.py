"""
@.architecture
Incoming: none --- {Dict[str, Any], dict}
Processing: validate trail constraints, check node count, enforce sequence rules --- {1 job: JOB_VALIDATE_SCHEMA}
Outgoing: none --- {bool, ValidationError}

Trail Validator - Pure trail constraint validation logic

Pure domain logic for validating trail hierarchy constraints.
NO I/O, NO external dependencies, framework-agnostic.

Features:
- Subgroup node count validation (must be exactly 3)
- Node sequence validation (must be 0, 1, 2)
- Node type validation (writing, executing, output)
- Artifact linking validation (code→writing, output→output)
"""

from typing import Any, Dict, List


class ValidationError(Exception):
    """Domain validation error."""
    pass


def validate_subgroup_node_count(nodes: List[Dict[str, Any]]) -> None:
    """
    Validate subgroup has exactly 3 nodes.
    
    Args:
        nodes: List of node dicts
        
    Raises:
        ValidationError: If node count != 3
    """
    if len(nodes) != 3:
        raise ValidationError(f"Subgroup must have exactly 3 nodes, got {len(nodes)}")


def validate_node_sequences(nodes: List[Dict[str, Any]]) -> None:
    """
    Validate nodes have correct sequences: 0, 1, 2.
    
    Args:
        nodes: List of node dicts
        
    Raises:
        ValidationError: If sequences are invalid
    """
    # node.get("sequence", -1) returns None (not -1) when key exists with
    # None value. Explicitly coalesce None to -1 so sorted() never compares
    # None with int, which would raise TypeError.
    sequences = sorted([
        node.get("sequence") if node.get("sequence") is not None else -1
        for node in nodes
    ])
    expected = [0, 1, 2]
    
    if sequences != expected:
        raise ValidationError(f"Node sequences must be [0, 1, 2], got {sequences}")


def validate_node_types(nodes: List[Dict[str, Any]]) -> None:
    """
    Validate nodes have correct types in order: writing, executing, output.
    
    Args:
        nodes: List of node dicts (must be sorted by sequence)
        
    Raises:
        ValidationError: If node types are invalid
    """
    # Same None-coalesce as validate_node_sequences — prevents TypeError
    # when sorting nodes whose "sequence" key exists but is None.
    sorted_nodes = sorted(
        nodes,
        key=lambda n: n.get("sequence") if n.get("sequence") is not None else 0,
    )
    node_types = [node.get("node_type", "") for node in sorted_nodes]
    expected = ["writing", "executing", "output"]
    
    if node_types != expected:
        raise ValidationError(f"Node types must be {expected}, got {node_types}")


def validate_artifact_linking(
    node_type: str,
    artifact_type: str,
) -> None:
    """
    Validate artifact type can be linked to node type.
    
    Args:
        node_type: Node type (writing, executing, output)
        artifact_type: Artifact type (code, output)
        
    Raises:
        ValidationError: If linking is not allowed
        
    Rules:
        - code artifacts link to writing nodes only
        - output artifacts link to output nodes only
        - executing nodes NEVER have artifacts
    """
    valid_combinations = {
        ("writing", "code"),
        ("output", "output"),
    }
    
    if (node_type, artifact_type) not in valid_combinations:
        raise ValidationError(
            f"Cannot link artifact type '{artifact_type}' to node type '{node_type}'. "
            f"Valid: code→writing, output→output"
        )


def validate_complete_subgroup(nodes: List[Dict[str, Any]]) -> None:
    """
    Validate complete subgroup structure.
    
    Combines all subgroup validations.
    
    Args:
        nodes: List of node dicts
        
    Raises:
        ValidationError: If any validation fails
    """
    validate_subgroup_node_count(nodes)
    validate_node_sequences(nodes)
    validate_node_types(nodes)

