"""
Domain Layer - Pure business logic without dependencies

This layer contains:
- entities/: Immutable value objects and data structures
- builders/: Pure transformation functions
- validators/: Business rule validation functions
- services/: Pure state management services (NO I/O)
- commands/: Command/Event DTOs for orchestrator → presentation

ALL code in this layer is:
- Framework-agnostic (NO FastAPI, NO WebSocket)
- I/O-free (NO database, NO HTTP, NO file system)
- Pure functions and immutable data structures
- Testable in isolation
"""

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

from ws.domain.builders.artifact_detector import (
    is_artifact_type,
    normalize_artifact_type,
    apply_normalization,
)

from ws.domain.builders.phase_detector import (
    detect_phase,
    is_phase_transition,
    validate_phase,
)

from ws.domain.builders.event_enricher import (
    enrich_event,
    generate_artifact_id,
    get_artifact_key,
    should_assign_execution_group,
)

from ws.domain.validators.message_validator import (
    ValidationError as MessageValidationError,
    validate_required_field,
    validate_message_type,
    validate_user_message,
    validate_control_message,
)

from ws.domain.validators.trail_validator import (
    ValidationError as TrailValidationError,
    validate_subgroup_node_count,
    validate_node_sequences,
    validate_node_types,
    validate_artifact_linking,
    validate_complete_subgroup,
)

from ws.domain.services import (
    ArtifactTracker,
    PhaseStateMachine,
    MessageAccumulator,
    EventNormalizer,
)

from ws.domain.commands import (
    # Stream commands
    StreamCommand,
    EmitStreamEvent,
    EmitStreamEnd,
    EmitStreamCompletion,
    EmitStreamStop,
    EmitStreamError,
    # Trail commands
    TrailCommand,
    EmitGroupCreated,
    EmitSubgroupCreated,
    EmitNodeStatusUpdated,
    EmitArtifactLinked,
    EmitSubgroupCompleted,
    EmitAgentMessageSequence,
)

__all__ = [
    # Entities
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
    # Builders
    "is_artifact_type",
    "normalize_artifact_type",
    "apply_normalization",
    "detect_phase",
    "is_phase_transition",
    "validate_phase",
    "enrich_event",
    "generate_artifact_id",
    "get_artifact_key",
    "should_assign_execution_group",
    # Validators
    "MessageValidationError",
    "validate_required_field",
    "validate_message_type",
    "validate_user_message",
    "validate_control_message",
    "TrailValidationError",
    "validate_subgroup_node_count",
    "validate_node_sequences",
    "validate_node_types",
    "validate_artifact_linking",
    "validate_complete_subgroup",
    # Services
    "ArtifactTracker",
    "PhaseStateMachine",
    "MessageAccumulator",
    "EventNormalizer",
    # Commands
    "StreamCommand",
    "EmitStreamEvent",
    "EmitStreamEnd",
    "EmitStreamCompletion",
    "EmitStreamStop",
    "EmitStreamError",
    "TrailCommand",
    "EmitGroupCreated",
    "EmitSubgroupCreated",
    "EmitNodeStatusUpdated",
    "EmitArtifactLinked",
    "EmitSubgroupCompleted",
    "EmitAgentMessageSequence",
]
