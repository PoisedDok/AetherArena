"""
@.architecture
Incoming: none --- {Dict[str, Any], primitives}
Processing: validate stream event structure, enforce field constraints --- {2 jobs: JOB_TRANSFORM_DATA, JOB_VALIDATE_SCHEMA}
Outgoing: none --- {Dict[str, Any], dict}

Stream Event Entity - Pure stream event data structure

Pure domain data structure for stream events.
NO I/O, NO external dependencies, framework-agnostic.

Features:
- Field validation
- Type constraints
- Required field enforcement
"""

from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class StreamEvent:
    """
    Immutable stream event entity.
    
    Represents a single stream event from runtime.
    """
    role: str  # assistant, computer, user, server
    type: str  # message, code, output, completion, stopped
    request_id: str  # Backend request ID (canonical identifier)
    sequence: int  # Event sequence number
    timestamp: str  # ISO 8601 timestamp
    
    # Optional fields
    content: Optional[str] = None
    format: Optional[str] = None
    artifact_id: Optional[str] = None
    execution_group: Optional[str] = None
    frontend_id: Optional[str] = None
    correlation_id: Optional[str] = None
    chat_id: Optional[str] = None
    recipient: Optional[str] = None
    start: bool = False
    end: bool = False
    
    def __post_init__(self):
        """Validate event after construction."""
        if not self.role:
            raise ValueError("role is required")
        if not self.type:
            raise ValueError("type is required")
        if not self.request_id:
            raise ValueError("request_id is required")
        if self.sequence < 0:
            raise ValueError(f"sequence must be non-negative, got {self.sequence}")


def validate_event_dict(event: Dict[str, Any]) -> bool:
    """
    Validate stream event dictionary has required fields.
    
    Args:
        event: Event dictionary to validate
        
    Returns:
        True if valid, False otherwise
    """
    required_fields = {"role", "type", "request_id", "sequence", "timestamp"}
    return all(field in event for field in required_fields)


def is_artifact_event(event: Dict[str, Any]) -> bool:
    """
    Check if event is an artifact-related event.
    
    Args:
        event: Event dictionary
        
    Returns:
        True if event has artifact_id, False otherwise
    """
    return "artifact_id" in event and event["artifact_id"] is not None


def is_marker_event(event: Dict[str, Any]) -> bool:
    """
    Check if event is a marker (start/end).
    
    Args:
        event: Event dictionary
        
    Returns:
        True if event is a marker, False otherwise
    """
    return event.get("start", False) or event.get("end", False)

