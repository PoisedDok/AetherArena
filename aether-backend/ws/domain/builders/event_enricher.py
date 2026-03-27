"""
@.architecture
Incoming: none --- {Dict[str, Any], dict}
Processing: inject metadata, generate artifact IDs, normalize event structure --- {3 jobs: JOB_GENERATE_ID, JOB_TRANSFORM_DATA, JOB_VALIDATE_SCHEMA}
Outgoing: none --- {Dict[str, Any], dict}

Event Enricher - Pure event enrichment and metadata injection

Pure domain logic for enriching stream events with metadata.
NO I/O, NO external dependencies, framework-agnostic.

Features:
- Metadata injection (backend_id, frontend_id, correlation_id, chat_id)
- Artifact ID generation (stable per role:type pair)
- Sequence number tracking
- Execution group assignment
- Timestamp injection
"""

from datetime import datetime, timezone
from typing import Any, Dict, Optional


def _utc_now_iso() -> str:
    """Get current UTC timestamp in ISO format."""
    return datetime.now(timezone.utc).isoformat()


def generate_artifact_id(
    backend_id: str,
    event_type: str,
    artifact_counter: int,
) -> str:
    """
    Generate stable artifact ID for persistence.
    
    Args:
        backend_id: Backend request ID
        event_type: Artifact type (code, output)
        artifact_counter: Counter for this artifact type in current request
        
    Returns:
        Stable artifact ID: {backend_id}:{type}:{counter}
        
    Examples:
        generate_artifact_id("req_123", "code", 1) → "req_123:code:1"
        generate_artifact_id("req_123", "output", 2) → "req_123:output:2"
    """
    return f"{backend_id}:{event_type}:{artifact_counter}"


def get_artifact_key(role: str, event_type: str) -> str:
    """
    Generate cache key for artifact ID lookup.
    
    Ensures one artifact ID per (role, type) pair within a request.
    
    Args:
        role: Event role (assistant, computer)
        event_type: Event type (code, output)
        
    Returns:
        Cache key string
    """
    return f"{role.lower()}:{event_type.lower()}"


def enrich_event(
    event: Dict[str, Any],
    *,
    backend_id: str,
    frontend_id: Optional[str] = None,
    correlation_id: Optional[str] = None,
    chat_id: Optional[str] = None,
    sequence: int,
    artifact_id: Optional[str] = None,
    execution_group: Optional[str] = None,
    message_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Enrich stream event with metadata.
    
    Pure function that injects backend metadata into stream events.
    Does NOT mutate input event.
    
    Args:
        event: Raw stream event
        backend_id: Backend-generated request identifier
        frontend_id: Optional frontend-generated identifier
        correlation_id: Optional correlation identifier
        chat_id: Optional chat identifier
        sequence: Sequence number for this event
        artifact_id: Optional artifact identifier (if artifact type)
        execution_group: Optional execution group identifier
        
    Returns:
        New dict with enriched event data
    """
    payload = dict(event)
    
    # CRITICAL: Backend OWNS request_id - FORCE it, don't use setdefault
    # Open Interpreter may send its own 'id' which we ignore - frontend uses request_id only
    # Remove Open Interpreter's id if present to prevent confusion
    if "id" in payload:
        del payload["id"]
    payload["request_id"] = backend_id
    
    # Optional metadata
    if frontend_id:
        payload.setdefault("frontend_id", frontend_id)
    if correlation_id:
        payload.setdefault("correlation_id", correlation_id)
    if chat_id:
        payload.setdefault("chat_id", chat_id)
    
    # Sequence and timestamp
    payload.setdefault("sequence", sequence)
    payload.setdefault("timestamp", _utc_now_iso())
    
    # Execution group for artifact grouping
    if execution_group:
        payload["execution_group"] = execution_group
    
    # Artifact ID if provided
    # CRITICAL: Backend OWNS artifact_id - FORCE it to ensure trail linkage consistency.
    # Open Interpreter may send its own artifact IDs which would break our trail registry.
    if artifact_id:
        payload["artifact_id"] = artifact_id
    elif "artifact_id" in payload:
        # Strip foreign artifact IDs to maintain contract integrity
        del payload["artifact_id"]
    
    # Message ID for artifact foreign key linkage
    # CRITICAL: Artifacts need message_id to satisfy database foreign key constraint
    if message_id:
        payload.setdefault("message_id", message_id)
    
    # CRITICAL: Preserve recipient field for frontend filtering
    # (assistant-targeted messages should not be shown to user)
    if "recipient" in event:
        payload["recipient"] = event["recipient"]
    
    return payload


def should_assign_execution_group(event_type: str) -> bool:
    """
    Determine if event should have execution_group assigned.
    
    Execution groups are assigned to artifact types for grouping
    related artifacts from the same execution.
    
    Args:
        event_type: Event type
        
    Returns:
        True if execution_group should be assigned
    """
    from .artifact_detector import is_artifact_type
    return is_artifact_type(event_type)

