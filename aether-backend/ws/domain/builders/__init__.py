"""Domain Builders - Pure transformation and enrichment functions"""

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

__all__ = [
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
]

