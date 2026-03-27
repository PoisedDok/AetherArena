"""
@.architecture
Incoming: data/database/uow.py --- {SupabaseUnitOfWork, Dict[str, Any]}
Processing: persist normalized audit events and message-artifact links --- {JOB_MANAGE_STORAGE}
Outgoing: api/dependencies.py --- {Dict[str, Any], json}
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from data.database.uow import SupabaseUnitOfWork


async def write_event(
    uow: SupabaseUnitOfWork,
    *,
    event_type: str,
    details: Dict[str, Any],
    source: str = "http",
    severity: str = "info",
    request_id: Optional[str] = None,
    correlation_id: Optional[str] = None,
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Persist a normalized event row using the current unit-of-work."""
    ctx = uow.context
    payload = {
        "source": source,
        "event_type": event_type,
        "severity": severity,
        "request_id": request_id or ctx.request_id,
        "correlation_id": correlation_id or ctx.correlation_id,
        "session_id": session_id or ctx.session_id,
        "user_id": user_id or ctx.user_id,
        "details": details or {},
    }
    records = await uow.gateway.insert("events", payload, return_representation=True)
    if isinstance(records, list) and records:
        return records[0]
    return records


async def link_message_artifact(
    uow: SupabaseUnitOfWork,
    *,
    message_id: str,
    artifact_id: str,
    event_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Persist normalized relationship between message and artifact."""
    payload = {
        "message_id": message_id,
        "artifact_id": artifact_id,
        "event_id": event_id,
    }
    records = await uow.gateway.insert("message_artifact_link", payload, return_representation=True)
    if isinstance(records, list) and records:
        return records[0]
    return records


__all__ = ["write_event", "link_message_artifact"]
