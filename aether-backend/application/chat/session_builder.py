"""
Session Builder - Chat session map generation (Application Layer)

This module provides an application-layer orchestrator for building a complete chat "session map"
for restoration/export/debugging.

Key rule:
- This code MUST NOT import WebSocket layer modules. API/WS layers may import this module.

@.architecture
Incoming: api/v1/endpoints/storage.py, ws/application/* --- {chat_id, repository adapters}
Processing: Fetch messages/artifacts/trails, build linear timeline + indexes + metadata --- {5 jobs: JOB_ORCHESTRATE, JOB_FETCH, JOB_MERGE, JOB_SORT, JOB_INDEX}
Outgoing: API/WS callers --- {Dict[str, Any], json}
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

logger = logging.getLogger(__name__)


class SessionBuilder:
    """
    Session map builder orchestrator.

    Aggregates chat data from multiple sources into a complete session map.
    """

    def __init__(
        self,
        *,
        trail_repository: Optional[Any] = None,
        chat_repository: Optional[Any] = None,
        settings: Optional[Any] = None,
    ) -> None:
        self._trail_repo = trail_repository
        self._chat_repo = chat_repository
        self._settings = settings
        self._logger = logger

    async def build_session_map(self, chat_id: str) -> Dict[str, Any]:
        chat_uuid = UUID(chat_id)

        # Fetch all data sources in parallel (500ms → 200ms)
        messages, artifacts, trails = await asyncio.gather(
            self._fetch_messages(chat_uuid),
            self._fetch_artifacts(chat_uuid),
            self._fetch_trails(chat_uuid),
        )

        # Build timeline events
        timeline: List[Dict[str, Any]] = []
        timeline.extend(self._build_message_events(messages))
        timeline.extend(self._build_trail_events(trails))

        # Sort by sequence
        timeline.sort(key=lambda e: e["sequence"])

        # Verify sequence integrity
        self._verify_sequence_integrity(timeline)

        # Build indexes
        indexes = self._build_indexes(timeline)

        # Calculate metadata
        metadata = self._calculate_metadata(timeline, messages)

        # Compute context status from persisted messages (no runtime interpreter dependency)
        context_status = self._estimate_context_status(messages)
        if context_status:
            metadata["context"] = context_status

        chat_info = messages[0] if messages else {}

        session_map = {
            "chat_id": chat_id,
            "title": chat_info.get("chat_title", "Untitled Chat"),
            "created_at": chat_info.get("created_at") if messages else self._now_iso(),
            "updated_at": self._now_iso(),
            "user_id": chat_info.get("user_id"),
            "metadata": metadata,
            "timeline": timeline,
            "indexes": indexes,
        }

        self._logger.info("Built session map: chat=%s, events=%s", chat_id[:8], len(timeline))
        return session_map

    # Data fetching

    async def _fetch_messages(self, chat_id: UUID) -> List[Dict[str, Any]]:
        if not self._chat_repo:
            return []
        try:
            messages = await self._chat_repo.get_messages(chat_id)
            return [
                {
                    "id": str(msg.id),
                    "chat_id": str(msg.chat_id),
                    "role": msg.role,
                    "content": msg.content,
                    "sequence_in_chat": msg.sequence_in_chat,
                    "created_at": msg.created_at.isoformat()
                    if hasattr(msg.created_at, "isoformat")
                    else str(msg.created_at),
                    "chat_title": getattr(msg, "chat_title", None),
                    "user_id": getattr(msg, "user_id", None),
                    "model": getattr(msg, "llm_model", None),
                    "input_tokens": getattr(msg, "input_tokens", None),
                    "output_tokens": getattr(msg, "output_tokens", None),
                }
                for msg in messages
            ]
        except Exception as e:
            self._logger.error("Failed to fetch messages: %s", e, exc_info=True)
            return []

    async def _fetch_artifacts(self, chat_id: UUID) -> List[Dict[str, Any]]:
        if not self._chat_repo:
            return []
        try:
            artifacts = await self._chat_repo.get_artifacts(chat_id)
            return [
                {
                    "id": str(art.id),
                    "chat_id": str(art.chat_id),
                    "type": art.type,
                    "content": art.content,
                    "language": getattr(art, "language", None),
                    "dedup_id": getattr(art, "artifact_id", None),
                    "execution_group": getattr(art, "execution_group", None),
                    "created_at": art.created_at.isoformat()
                    if hasattr(art.created_at, "isoformat")
                    else str(art.created_at),
                    "message_id": str(art.message_id)
                    if hasattr(art, "message_id") and art.message_id
                    else None,
                    "node_id": str(art.node_id) if hasattr(art, "node_id") and art.node_id else None,
                    "subgroup_id": str(art.subgroup_id)
                    if hasattr(art, "subgroup_id") and art.subgroup_id
                    else None,
                }
                for art in artifacts
            ]
        except Exception as e:
            self._logger.error("Failed to fetch artifacts: %s", e, exc_info=True)
            return []

    async def _fetch_trails(self, chat_id: UUID) -> List[Dict[str, Any]]:
        if not self._trail_repo:
            return []
        try:
            return await self._trail_repo.get_trail_hierarchy(chat_id)
        except Exception as e:
            self._logger.error("Failed to fetch trails: %s", e, exc_info=True)
            return []

    # Timeline building

    def _build_message_events(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        events: List[Dict[str, Any]] = []
        for msg in messages:
            sequence = msg.get("sequence_in_chat")
            if sequence is None:
                raise ValueError(f"Message {msg.get('id')} missing sequence_in_chat")

            event: Dict[str, Any] = {
                "type": "message",
                "sequence": sequence,
                "timestamp": msg.get("created_at") or self._now_iso(),
                "role": msg.get("role", "assistant"),
                "message_id": str(msg.get("id")),
                "content": msg.get("content", ""),
                "model": msg.get("model"),
            }

            if msg.get("input_tokens") or msg.get("output_tokens"):
                event["tokens"] = {
                    "input": msg.get("input_tokens"),
                    "output": msg.get("output_tokens"),
                }

            events.append(event)

        return events

    def _build_trail_events(self, trails: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        events: List[Dict[str, Any]] = []
        for group in trails:
            group_id = group.get("id") or group.get("group_id")
            if not group_id:
                continue

            for subgroup in group.get("subgroups", []):
                subgroup_id = subgroup.get("id") or subgroup.get("subgroup_id")
                if not subgroup_id:
                    continue

                sequence = subgroup.get("sequence_in_chat")
                if sequence is None:
                    raise ValueError(f"Subgroup {subgroup_id} missing sequence_in_chat")

                event: Dict[str, Any] = {
                    "type": "trail",
                    "sequence": sequence,
                    "timestamp": subgroup.get("completed_at")
                    or subgroup.get("created_at")
                    or self._now_iso(),
                    "group_id": group_id,
                    "group_sequence": group.get("sequence_number"),
                    "subgroup_id": subgroup_id,
                    "subgroup_sequence": subgroup.get("sequence_number"),
                    "execution_group": subgroup.get("execution_group"),
                    "status": subgroup.get("status", "completed"),
                    "user_message_id": group.get("user_message_id"),
                    "agent_message_id": group.get("agent_message_id"),
                    "nodes": [
                        {
                            "node_id": node.get("id") or node.get("node_id"),
                            "type": node.get("type"),
                            "status": node.get("status", "completed"),
                            "artifact_id": node.get("artifact_id"),
                            "started_at": node.get("started_at"),
                            "completed_at": node.get("completed_at"),
                            "duration_ms": self._calculate_duration(
                                node.get("started_at"), node.get("completed_at")
                            ),
                        }
                        for node in subgroup.get("nodes", [])
                    ],
                }

                if subgroup.get("completed_at") and subgroup.get("created_at"):
                    event["duration_ms"] = self._calculate_duration(
                        subgroup["created_at"], subgroup["completed_at"]
                    )

                events.append(event)

        return events

    # Helpers

    def _verify_sequence_integrity(self, timeline: List[Dict[str, Any]]) -> None:
        expected = 1
        for event in timeline:
            if event["sequence"] != expected:
                raise ValueError(f"Sequence gap: expected {expected}, got {event['sequence']}")
            expected += 1

    def _build_indexes(self, timeline: List[Dict[str, Any]]) -> Dict[str, Any]:
        indexes: Dict[str, Any] = {
            "messages_by_id": {},
            "artifacts_by_id": {},
            "trails_by_group": {},
        }

        for event in timeline:
            if event["type"] == "message":
                indexes["messages_by_id"][event["message_id"]] = event["sequence"]
            elif event["type"] == "trail":
                group_id = event["group_id"]
                indexes["trails_by_group"].setdefault(group_id, []).append(event["sequence"])

        return indexes

    def _calculate_metadata(
        self, timeline: List[Dict[str, Any]], messages: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        message_count = sum(1 for e in timeline if e["type"] == "message")
        trail_count = sum(1 for e in timeline if e["type"] == "trail")

        total_tokens = sum(
            (msg.get("input_tokens") or 0) + (msg.get("output_tokens") or 0) for msg in messages
        )

        return {
            "total_events": len(timeline),
            "message_count": message_count,
            "trail_count": trail_count,
            "total_tokens": total_tokens,
        }

    def _estimate_context_status(self, messages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not messages:
            return None

        token_limit = 100000
        thresholds = {"warning": 0.80, "high": 0.90, "critical": 0.95}
        try:
            if self._settings and hasattr(self._settings, "llm"):
                token_limit = int(getattr(self._settings.llm, "context_window", token_limit))
            if self._settings and hasattr(self._settings, "interpreter"):
                interp = self._settings.interpreter
                thresholds = {
                    "warning": float(getattr(interp, "context_warning_threshold", thresholds["warning"])),
                    "high": float(getattr(interp, "context_high_threshold", thresholds["high"])),
                    "critical": float(getattr(interp, "context_critical_threshold", thresholds["critical"])),
                }
        except Exception:
            pass

        # Prefer persisted token counts when available; otherwise estimate ~4 chars/token.
        token_count = 0
        for msg in messages:
            inp = msg.get("input_tokens")
            out = msg.get("output_tokens")
            if isinstance(inp, int) or isinstance(out, int):
                token_count += int(inp or 0) + int(out or 0)
                continue
            content = msg.get("content") or ""
            token_count += len(str(content)) // 4

        usage_percent = (token_count / token_limit) if token_limit else 0.0
        if usage_percent >= thresholds["critical"]:
            status = "critical"
        elif usage_percent >= thresholds["high"]:
            status = "high"
        elif usage_percent >= thresholds["warning"]:
            status = "warning"
        else:
            status = "normal"

        return {
            "message_count": len(messages),
            "token_count": token_count,
            "token_limit": token_limit,
            "usage_percent": round(usage_percent * 100, 1),
            "status": status,
            "needs_summarization": usage_percent >= thresholds["high"],
            "recommend_new_chat": usage_percent >= thresholds["critical"],
            "thresholds": {
                "warning": int(token_limit * thresholds["warning"]),
                "high": int(token_limit * thresholds["high"]),
                "critical": int(token_limit * thresholds["critical"]),
            },
        }

    def _calculate_duration(self, started: Optional[str], completed: Optional[str]) -> Optional[int]:
        if not started or not completed:
            return None
        try:
            started_dt = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
            completed_dt = datetime.fromisoformat(str(completed).replace("Z", "+00:00"))
            return int((completed_dt - started_dt).total_seconds() * 1000)
        except (ValueError, AttributeError) as e:
            self._logger.warning("Failed to calculate duration: %s", e)
            return None

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

