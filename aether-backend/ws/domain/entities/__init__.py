"""Domain Entities - Immutable value objects and data structures"""

from ws.domain.entities.trail_hierarchy import (
    Node,
    validate_node_status_transition,
    validate_subgroup_structure,
    get_node_for_artifact_type,
    can_link_artifact_to_node,
)

from ws.domain.entities.stream_event import StreamEvent

from ws.domain.entities.session_timeline import (
    validate_sequence_integrity,
    merge_timelines,
    calculate_duration_ms,
    validate_event_has_sequence,
    get_timeline_bounds,
)

__all__ = [
    "Node",
    "validate_node_status_transition",
    "validate_subgroup_structure",
    "get_node_for_artifact_type",
    "can_link_artifact_to_node",
    "StreamEvent",
    "validate_sequence_integrity",
    "merge_timelines",
    "calculate_duration_ms",
    "validate_event_has_sequence",
    "get_timeline_bounds",
]

