"""
@.architecture
Incoming: none --- {Dict[str, Any], dict}
Processing: detect artifact types, normalize legacy formats, validate against artifact type registry --- {2 jobs: JOB_TRANSFORM_DATA, JOB_VALIDATE_SCHEMA}
Outgoing: none --- {Dict[str, Any], dict}

Artifact Detector - Pure artifact type detection and normalization

Pure domain logic for detecting and normalizing artifact types.
NO I/O, NO external dependencies, framework-agnostic.

Features:
- Artifact type validation (code, output only)
- Legacy format normalization (console→output+format)
- Format field enforcement
"""

from typing import Any, Dict, Optional, Set


# ARCHITECTURAL ENFORCEMENT: See contracts/README.md (Artifact types and trail invariants)
# ONLY "code" and "output" are artifact types
# Other types (html, console, json, markdown) are OUTPUT FORMATS, not artifact types
ARTIFACT_TYPES: Set[str] = {
    "code",    # Writing node artifact (assistant:code)
    "output",  # Output node artifact (computer:output with format: html/json/console/text)
}

# Legacy types that should be normalized to output+format
LEGACY_OUTPUT_TYPES: Set[str] = {"console", "html", "markdown", "json", "text"}


def is_artifact_type(event_type: str) -> bool:
    """
    Check if event type is a valid artifact type.
    
    Args:
        event_type: Event type to validate
        
    Returns:
        True if valid artifact type, False otherwise
    """
    return event_type.lower() in ARTIFACT_TYPES


def normalize_artifact_type(
    event_type: str,
    event_format: Optional[str] = None,
    event_role: Optional[str] = None
) -> tuple[str, Optional[str]]:
    """
    Normalize artifact type and format.
    
    Transforms legacy output types (console, html, json, text) to output+format.
    Ensures code and output artifacts have proper format field.
    CRITICAL: Transform computer:code with format=html to output (HTML execution result)
    
    Args:
        event_type: Raw event type from runtime
        event_format: Optional format field
        event_role: Optional role field (computer/assistant)
        
    Returns:
        Tuple of (normalized_type, format_field)
        
    Examples:
        normalize_artifact_type("console", None) → ("output", "console")
        normalize_artifact_type("html", None) → ("output", "html")
        normalize_artifact_type("code", "python") → ("code", "python")
        normalize_artifact_type("code", "html", "computer") → ("output", "html")
        normalize_artifact_type("output", None) → ("output", "text")
    """
    event_type_lower = event_type.lower()
    format_field = event_format.lower() if event_format else None
    role = event_role.lower() if event_role else None
    
    # CRITICAL ARCHITECTURAL FIX: computer:code with format=html is HTML execution output
    # Open Interpreter's html.py sends executed HTML as computer:code+format:html (line 13)
    # This should be treated as output (visual result), NOT code (source)
    if event_type_lower == "code" and format_field == "html" and role == "computer":
        return ("output", "html")
    
    # Normalize legacy output types → output+format
    if event_type_lower in LEGACY_OUTPUT_TYPES:
        return ("output", event_type_lower)
    
    # Ensure output has format
    if event_type_lower == "output" and not format_field:
        return ("output", "text")
    
    # Ensure code has format (language)
    if event_type_lower == "code" and not format_field:
        return ("code", "text")
    
    return (event_type_lower, format_field)


def apply_normalization(payload: Dict[str, Any]) -> None:
    """
    Apply artifact type normalization to event payload in-place.
    
    Modifies payload dict to normalize legacy types and ensure format fields.
    
    Args:
        payload: Event payload to normalize (modified in-place)
    """
    raw_type = str(payload.get("type", "")).lower()
    raw_format = str(payload.get("format", "")).lower() if payload.get("format") else None
    raw_role = str(payload.get("role", "")).lower() if payload.get("role") else None
    
    normalized_type, format_field = normalize_artifact_type(raw_type, raw_format, raw_role)
    
    # Update payload with normalized values
    payload["type"] = normalized_type
    if format_field:
        payload["format"] = format_field

