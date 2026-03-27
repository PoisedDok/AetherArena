"""
WebSocket application shim for SessionBuilder.

Source of truth for session-map generation is the application-layer builder:
- `application/chat/session_builder.py`

This module exists only to preserve existing WS imports while ensuring the API layer
does NOT import from `ws.*` (architecture compliance).

@.architecture
Incoming: ws layer imports (legacy compatibility) --- {import}
Processing: re-export application SessionBuilder --- {1 jobs: JOB_ROUTE}
Outgoing: ws callers --- {SessionBuilder}
"""

from application.chat.session_builder import SessionBuilder

__all__ = ["SessionBuilder"]

