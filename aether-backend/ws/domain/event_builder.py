"""
@.architecture
Incoming: ws/application/stream_orchestrator.py::StreamOrchestrator --- {Dict[str, Any], dict}
Processing: normalize stream events, inject metadata, assign artifact identifiers, apply phase detection rules --- {3 jobs: JOB_GENERATE_ID, JOB_TRANSFORM_DATA, JOB_VALIDATE_SCHEMA}
Outgoing: ws/application/stream_orchestrator.py::StreamOrchestrator --- {Dict[str, Any], dict}

Stream Event Builder - Pure domain logic for event normalization

This module provides pure transformation logic for normalizing and enriching
runtime stream events with backend metadata.

Features:
- Artifact type detection and validation
- Stable artifact ID generation per (role, type) pair
- Phase detection (write, execute, output)
- Metadata injection (backend_id, frontend_id, correlation_id, chat_id)
- Sequence number tracking
- Execution group assignment

Architecture:
- Pure domain logic (no framework dependencies)
- Stateless transformations
- No I/O operations
- Framework-agnostic
"""

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, Optional


def _utc_now_iso() -> str:
    """Get current UTC timestamp in ISO format"""
    return datetime.now(timezone.utc).isoformat()


class StreamEventBuilder:
    """
    Normalizes and enriches runtime stream events with backend metadata.
    
    Pure domain logic with no external dependencies. Provides stateless
    transformations for stream event normalization.
    
    Features:
    - Artifact type validation
    - Stable artifact ID generation
    - Phase detection
    - Metadata injection
    - Sequence tracking
    """

    # ARCHITECTURAL ENFORCEMENT: See contracts/README.md (Artifact types and trail invariants)
    # ONLY "code" and "output" are artifact types
    # Other types (html, console, json, markdown) are OUTPUT FORMATS, not artifact types
    # Format should be conveyed via "format" field on output artifacts
    _ARTIFACT_TYPES = {
        "code",    # Writing node artifact (assistant:code)
        "output",  # Output node artifact (computer:output with format: html/json/console/text)
    }

    def __init__(
        self,
        backend_id: str,
        *,
        frontend_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        chat_id: Optional[str] = None,
    ) -> None:
        """
        Initialize event builder with request metadata.
        
        Args:
            backend_id: Backend-generated request identifier
            frontend_id: Optional frontend-generated identifier
            correlation_id: Optional correlation identifier
            chat_id: Optional chat identifier
        """
        self._backend_id = backend_id
        self._frontend_id = frontend_id
        self._correlation_id = correlation_id
        self._chat_id = chat_id
        self._sequence = 0
        self._artifact_counters: Dict[str, int] = defaultdict(int)
        self._artifact_ids: Dict[str, str] = {}  # Cache stable artifact IDs by (role, type) key

    def _next_sequence(self) -> int:
        """Get next sequence number"""
        self._sequence += 1
        return self._sequence

    def _assign_artifact_metadata(self, payload: Dict[str, Any]) -> None:
        """
        Assign artifact metadata (artifact_id, phase) to event payload.
        
        Generates ONE stable artifact_id per (role, type) pair for this message.
        This ensures all chunks of the same artifact get the same ID for proper persistence.
        
        Architecture Compliance:
        - Transforms legacy types (html, console, json, markdown) → output type + format field
        - Ensures ONLY code + output artifacts are created (see contracts/README.md)
        - Assigns format field for output rendering differentiation
        
        Args:
            payload: Event payload to enrich
        """
        role = str(payload.get("role", "")).lower()
        raw_type = str(payload.get("type", "")).lower()
        raw_format = str(payload.get("format", "")).lower() if payload.get("format") else None
        
        # ARCHITECTURAL CONTRACT: Only 2 artifact types exist
        # - code: Assistant writes (any language: python, html, js, etc)
        # - output: Computer produces (console logs, execution results, renders)
        # Format field specifies the language/rendering type within these categories
        event_type = raw_type
        format_field = raw_format
        
        # Normalize legacy output types (console, html, json, text) → output+format
        # These come from COMPUTER execution, not assistant code writing
        if raw_type in {"console", "html", "markdown", "json", "text"}:
            event_type = "output"
            format_field = raw_type
            payload["type"] = "output"
            payload["format"] = format_field
        # Ensure output has format
        elif raw_type == "output" and not format_field:
            payload["format"] = "text"
            format_field = "text"
        # Ensure code has format (language)
        elif raw_type == "code" and not format_field:
            # Default to text if OI doesn't specify language
            payload["format"] = "text"
            format_field = "text"

        if event_type not in self._ARTIFACT_TYPES:
            return

        # Generate ONE stable artifact_id per (role, type) pair for this message
        # This ensures all chunks of the same artifact get the same ID for proper persistence
        artifact_key = f"{role}:{event_type}"
        if artifact_key not in self._artifact_ids:
            self._artifact_counters[event_type] += 1
            self._artifact_ids[artifact_key] = f"{self._backend_id}:{event_type}:{self._artifact_counters[event_type]}"
        
        artifact_id = self._artifact_ids[artifact_key]
        payload.setdefault("artifact_id", artifact_id)

        # Phase detection (simplified to code/output only)
        phase = None
        if role == "assistant" and event_type == "code":
            phase = "write"
        elif role == "computer" and event_type == "output":
            # Differentiate execute phase (console logs) from output phase (results)
            if format_field == "console" or raw_type == "console":
                phase = "execute"
            else:
                phase = "output"

        if phase:
            payload.setdefault("phase", phase)

    def enrich(self, event: Dict[str, Any], *, assign_artifact: bool) -> Dict[str, Any]:
        """
        Enrich stream event with backend metadata.
        
        Injects backend_id, frontend_id, correlation_id, chat_id, sequence,
        timestamp, and execution_group. Optionally assigns artifact metadata.
        
        Args:
            event: Raw stream event
            assign_artifact: Whether to assign artifact metadata (artifact_id, phase)
            
        Returns:
            Enriched event dictionary
        """
        payload = dict(event)
        # CRITICAL: Backend OWNS request_id - FORCE it, don't use setdefault
        # Open Interpreter may send its own 'id' which we ignore - frontend uses request_id only
        # Remove Open Interpreter's id if present to prevent confusion
        if "id" in payload:
            del payload["id"]
        payload["request_id"] = self._backend_id
        
        # CRITICAL: Backend must send execution_group explicitly
        # All artifacts from same execution share backend_id as execution_group
        # Frontend reads this directly, no inference needed
        event_type = str(event.get("type", "")).lower()
        if event_type in self._ARTIFACT_TYPES:
            payload["execution_group"] = self._backend_id
        
        if self._frontend_id:
            payload.setdefault("frontend_id", self._frontend_id)
        if self._correlation_id:
            payload.setdefault("correlation_id", self._correlation_id)
        if self._chat_id:
            payload.setdefault("chat_id", self._chat_id)
        payload.setdefault("sequence", self._next_sequence())
        payload.setdefault("timestamp", _utc_now_iso())
        
        # CRITICAL: Preserve recipient field for frontend filtering
        # (assistant-targeted messages should not be shown to user)
        if "recipient" in event:
            payload["recipient"] = event["recipient"]

        if assign_artifact:
            self._assign_artifact_metadata(payload)

        return payload

