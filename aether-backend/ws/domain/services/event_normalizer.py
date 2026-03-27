"""
Incoming: application/stream_orchestrator --- {Dict[str, Any], dict}
Processing: normalize, filter, and coerce stream events --- {6 jobs: JOB_FILTER_AUTH, JOB_ENFORCE_TYPE, JOB_NORMALIZE_ARTIFACT, JOB_FILTER_MARKERS, JOB_COERCE_CONTENT, JOB_DETECT_EXEC_ERROR}
Outgoing: application/stream_orchestrator --- {Optional[Dict[str, Any]]}

EventNormalizer - Pure domain service for stream event normalization

Pure business logic, NO I/O.
Consolidates 6 inline filter/normalize blocks from relay_stream into one call.

Responsibilities:
1. Filter auth handshake events (no role, "auth" key)
2. Enforce type contract (add missing type from role)
3. Filter internal progress markers (active_line, ##active_lineX##)
4. Apply artifact normalization (role/type/format triplets)
5. Coerce non-string content to string (dict->json, int->str, bool->str)
6. Detect execution errors in computer output and reclassify as server:error
"""

import json
import logging
import re
from typing import Any, Dict, Optional

from ws.protocols import MessageRole, MessageType
from ws.domain.builders.artifact_detector import apply_normalization

logger = logging.getLogger(__name__)

# Compiled patterns that identify execution errors in computer output.
# These MUST NOT match normal code (e.g. a string literal containing "Error:").
# The minimum content length check (len >= 10) in _detect_execution_error
# guards against trivially short false positives.
_ERROR_PATTERNS = [
    re.compile(r"Traceback \(most recent call last\):", re.IGNORECASE),
    re.compile(r"Cell In\[\d+\],\s*line\s*\d+"),
    re.compile(r"^[A-Z]\w*Error:", re.MULTILINE),           # SyntaxError:, TypeError:, etc.
    re.compile(r"^HTTP\w*Error:", re.MULTILINE),             # HTTPStatusError:, HTTPError:
    re.compile(r"Server error '\d{3}", re.IGNORECASE),       # Server error '502 Bad Gateway'
    re.compile(r"^ConnectionError:", re.MULTILINE),
    re.compile(r"^TimeoutError:", re.MULTILINE),
]


class EventNormalizer:
    """
    Pure domain service for stream event normalization and filtering.

    Returns normalized event dict, or None if the event should be filtered out.
    NO I/O, NO external dependencies beyond domain builders.
    """

    def normalize(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Normalize a raw stream event from the runtime.

        Steps applied in order:
        1. Filter auth handshake events
        2. Enforce type contract (add missing type based on role)
        3. Filter internal progress markers (active_line, ##active_lineX##)
           (BEFORE normalization to preserve format="active_line" signal)
        4. Apply artifact normalization (consistent role/type/format triplets)
        5. Coerce non-string content to string
        6. Detect execution errors in computer output (reclassify as server:error)

        Args:
            event: Raw event dict from runtime engine

        Returns:
            Normalized event dict, or None if the event should be filtered out
        """
        if not isinstance(event, dict):
            return None

        # Step 1: Filter auth handshake events (no role, has "auth" key)
        if self._is_auth_handshake(event):
            logger.debug("Filtering auth handshake event from runtime")
            return None

        # Step 2: Enforce type contract
        self._enforce_type_contract(event)

        # Step 3: Filter internal progress markers (BEFORE normalization)
        # Must run before apply_normalization because normalization overwrites
        # format="active_line" to format="console" (for type="console" events),
        # destroying the marker signal.
        if self._is_internal_marker(event):
            logger.debug(
                "Filtering internal progress marker: format=%s, content=%s",
                event.get("format"),
                str(event.get("content", ""))[:50],
            )
            return None

        # Step 4: Apply artifact normalization (in-place)
        apply_normalization(event)

        # Step 5: Coerce non-string content
        self._coerce_content(event)

        # Step 6: Detect execution errors in computer output
        # Reclassifies error messages (HTTP 502, tracebacks, etc.) so
        # the frontend displays them as system errors in chat, NOT as
        # executable code in the artifacts window.
        if self._detect_execution_error(event):
            logger.info(
                "Reclassified execution error: content_preview='%s'",
                str(event.get("message", ""))[:120],
            )

        return event

    @staticmethod
    def _is_auth_handshake(event: Dict[str, Any]) -> bool:
        """Check if event is an Open Interpreter auth handshake (not user-facing)."""
        return "auth" in event and not event.get("role")

    @staticmethod
    def _enforce_type_contract(event: Dict[str, Any]) -> None:
        """
        Enforce type field presence.

        Open Interpreter should provide type, but we guard to prevent schema violations.
        Uses .value to store plain strings (avoids enum __str__ issues with apply_normalization).
        """
        if event.get("type"):
            return

        event_role = event.get("role")
        if event_role == MessageRole.ASSISTANT:
            event["type"] = MessageType.MESSAGE.value
        elif event_role == MessageRole.COMPUTER:
            event["type"] = MessageType.OUTPUT.value

    @staticmethod
    def _is_internal_marker(event: Dict[str, Any]) -> bool:
        """
        Detect internal progress markers that should be filtered out.

        Markers include:
        - format='active_line'
        - content=integer with type='console'
        - content containing '##active_line'
        """
        if "content" not in event:
            return False

        event_format = event.get("format")
        content = event["content"]
        content_str = str(content) if content is not None else ""

        return (
            event_format == "active_line"
            or (isinstance(content, int) and event.get("type") == "console")
            or "##active_line" in content_str
        )

    @staticmethod
    def _coerce_content(event: Dict[str, Any]) -> None:
        """
        Coerce non-string content to string.

        Open Interpreter violates schema by sending int/bool/dict in content field.
        Convert all non-string content to string at system boundary.
        """
        if "content" not in event:
            return

        content = event["content"]
        if content is None or isinstance(content, str):
            return

        # Pretty-print dicts/lists for better UI rendering
        if isinstance(content, (dict, list)):
            try:
                event["content"] = json.dumps(content, indent=2)
            except (TypeError, ValueError):
                event["content"] = str(content)
        else:
            event["content"] = str(content)

        if event["content"]:
            logger.info(
                "Normalized non-string content: type=%s, role=%s, event_type=%s, "
                "content_preview='%s'",
                type(content).__name__,
                event.get("role"),
                event.get("type"),
                str(event["content"])[:100],
            )

    @staticmethod
    def _detect_execution_error(event: Dict[str, Any]) -> bool:
        """
        Detect execution errors in computer output and reclassify as server:error.

        When OI's tool execution hits an HTTP error (502), Python traceback, or
        similar runtime failure, the raw error text arrives as a role=computer
        event.  Without reclassification the frontend interprets it as executable
        code and displays it in the artifacts window — causing SyntaxErrors and
        confusing the user.

        Reclassifying to server:error causes the StreamOrchestrator to break the
        stream and render the error message in-chat where it belongs.

        Returns:
            True if the event was reclassified, False otherwise.
        """
        role = event.get("role")
        if role != MessageRole.COMPUTER:
            return False

        content = str(event.get("content", ""))
        if len(content) < 10:
            return False

        for pattern in _ERROR_PATTERNS:
            if pattern.search(content):
                event["role"] = MessageRole.SERVER
                event["type"] = MessageType.ERROR.value
                event["message"] = content
                event["error_source"] = "execution"
                return True

        return False
