"""
Unit Tests: SessionBuilder (application/chat/session_builder.py)

Comprehensive coverage of session map building: parallel data fetching,
timeline construction, sequence verification, index building, metadata
calculation, context status estimation, and duration calculation.

Mock boundaries:
- chat_repository → mock get_messages / get_artifacts
- trail_repository → mock get_trail_hierarchy
- settings → mock llm / interpreter attributes
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest

from application.chat.session_builder import SessionBuilder


# ─── Helpers ─────────────────────────────────────────────────────────────────

CHAT_ID = str(uuid4())
CHAT_UUID = UUID(CHAT_ID)
MSG_ID_1 = str(uuid4())
MSG_ID_2 = str(uuid4())
ART_ID_1 = str(uuid4())
GROUP_ID = str(uuid4())
SUBGROUP_ID = str(uuid4())
NODE_ID = str(uuid4())


def _make_message(
    *,
    msg_id: str = MSG_ID_1,
    role: str = "user",
    content: str = "Hello",
    sequence: int = 1,
    chat_title: str = "Test Chat",
    user_id: str = "user-1",
    model: str = "gpt-4",
    input_tokens: int | None = 100,
    output_tokens: int | None = 50,
    created_at: datetime | None = None,
) -> SimpleNamespace:
    """Create a mock message object matching what chat_repo.get_messages returns."""
    return SimpleNamespace(
        id=UUID(msg_id),
        chat_id=CHAT_UUID,
        role=role,
        content=content,
        sequence_in_chat=sequence,
        created_at=created_at or datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
        chat_title=chat_title,
        user_id=user_id,
        llm_model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def _make_artifact(
    *,
    art_id: str = ART_ID_1,
    art_type: str = "code",
    content: str = "print('hello')",
    language: str = "python",
    artifact_id: str = "dedup-1",
    execution_group: str = "eg-1",
    message_id: str | None = None,
    node_id: str | None = None,
    subgroup_id: str | None = None,
    created_at: datetime | None = None,
) -> SimpleNamespace:
    """Create a mock artifact object."""
    return SimpleNamespace(
        id=UUID(art_id),
        chat_id=CHAT_UUID,
        type=art_type,
        content=content,
        language=language,
        artifact_id=artifact_id,
        execution_group=execution_group,
        created_at=created_at or datetime(2025, 1, 1, 12, 1, 0, tzinfo=timezone.utc),
        message_id=UUID(message_id) if message_id else None,
        node_id=UUID(node_id) if node_id else None,
        subgroup_id=UUID(subgroup_id) if subgroup_id else None,
    )


def _make_trail_hierarchy(
    *,
    group_id: str = GROUP_ID,
    subgroup_id: str = SUBGROUP_ID,
    sequence_in_chat: int = 2,
    group_sequence: int = 1,
    subgroup_sequence: int = 1,
    status: str = "completed",
    user_message_id: str | None = None,
    agent_message_id: str | None = None,
    nodes: list | None = None,
    created_at: str = "2025-01-01T12:02:00+00:00",
    completed_at: str = "2025-01-01T12:02:05+00:00",
) -> List[Dict[str, Any]]:
    """Create trail hierarchy data matching trail_repo.get_trail_hierarchy output."""
    if nodes is None:
        nodes = [
            {
                "id": NODE_ID,
                "type": "tool_call",
                "status": "completed",
                "artifact_id": ART_ID_1,
                "started_at": "2025-01-01T12:02:01+00:00",
                "completed_at": "2025-01-01T12:02:04+00:00",
            }
        ]

    return [
        {
            "id": group_id,
            "sequence_number": group_sequence,
            "user_message_id": user_message_id,
            "agent_message_id": agent_message_id,
            "subgroups": [
                {
                    "id": subgroup_id,
                    "sequence_in_chat": sequence_in_chat,
                    "sequence_number": subgroup_sequence,
                    "execution_group": "eg-1",
                    "status": status,
                    "created_at": created_at,
                    "completed_at": completed_at,
                    "nodes": nodes,
                }
            ],
        }
    ]


def _make_chat_repo(
    messages: list | None = None,
    artifacts: list | None = None,
) -> MagicMock:
    """Create a mock chat repository."""
    repo = MagicMock()
    repo.get_messages = AsyncMock(return_value=messages or [])
    repo.get_artifacts = AsyncMock(return_value=artifacts or [])
    return repo


def _make_trail_repo(
    trails: list | None = None,
) -> MagicMock:
    """Create a mock trail repository."""
    repo = MagicMock()
    repo.get_trail_hierarchy = AsyncMock(return_value=trails or [])
    return repo


def _make_settings(
    *,
    context_window: int = 100000,
    warning_threshold: float = 0.80,
    high_threshold: float = 0.90,
    critical_threshold: float = 0.95,
) -> MagicMock:
    """Create a mock settings object with llm and interpreter attributes."""
    settings = MagicMock()
    settings.llm = MagicMock()
    settings.llm.context_window = context_window
    settings.interpreter = MagicMock()
    settings.interpreter.context_warning_threshold = warning_threshold
    settings.interpreter.context_high_threshold = high_threshold
    settings.interpreter.context_critical_threshold = critical_threshold
    return settings


# ─── build_session_map orchestrator ──────────────────────────────────────────


class TestBuildSessionMap:
    """Tests for the main build_session_map orchestrator."""

    async def test_happy_path_with_messages_and_trails(self):
        msg = _make_message(sequence=1)
        trail = _make_trail_hierarchy(sequence_in_chat=2)
        chat_repo = _make_chat_repo(messages=[msg])
        trail_repo = _make_trail_repo(trails=trail)

        builder = SessionBuilder(
            chat_repository=chat_repo,
            trail_repository=trail_repo,
        )
        result = await builder.build_session_map(CHAT_ID)

        assert result["chat_id"] == CHAT_ID
        assert result["title"] == "Test Chat"
        assert result["user_id"] == "user-1"
        assert len(result["timeline"]) == 2
        assert result["timeline"][0]["type"] == "message"
        assert result["timeline"][1]["type"] == "trail"
        assert result["metadata"]["total_events"] == 2
        assert result["metadata"]["message_count"] == 1
        assert result["metadata"]["trail_count"] == 1
        assert "indexes" in result

    async def test_empty_data_no_repos(self):
        builder = SessionBuilder()
        result = await builder.build_session_map(CHAT_ID)

        assert result["chat_id"] == CHAT_ID
        assert result["title"] == "Untitled Chat"
        assert result["user_id"] is None
        assert result["timeline"] == []
        assert result["metadata"]["total_events"] == 0

    async def test_messages_only_no_trails(self):
        msg1 = _make_message(sequence=1, role="user")
        msg2 = _make_message(
            msg_id=MSG_ID_2, sequence=2, role="assistant",
            content="Hi there", input_tokens=200, output_tokens=100,
        )
        chat_repo = _make_chat_repo(messages=[msg1, msg2])
        builder = SessionBuilder(chat_repository=chat_repo)

        result = await builder.build_session_map(CHAT_ID)

        assert len(result["timeline"]) == 2
        assert result["metadata"]["message_count"] == 2
        assert result["metadata"]["trail_count"] == 0
        # Total tokens: (100+50) + (200+100) = 450
        assert result["metadata"]["total_tokens"] == 450

    async def test_invalid_chat_id_raises(self):
        builder = SessionBuilder()
        with pytest.raises(ValueError):
            await builder.build_session_map("not-a-uuid")

    async def test_context_status_included_when_messages_present(self):
        msg = _make_message(sequence=1, input_tokens=90000, output_tokens=5000)
        chat_repo = _make_chat_repo(messages=[msg])
        settings = _make_settings(context_window=100000)

        builder = SessionBuilder(
            chat_repository=chat_repo,
            settings=settings,
        )
        result = await builder.build_session_map(CHAT_ID)

        assert "context" in result["metadata"]
        assert result["metadata"]["context"]["status"] == "critical"

    async def test_context_status_omitted_when_no_messages(self):
        builder = SessionBuilder()
        result = await builder.build_session_map(CHAT_ID)

        assert "context" not in result["metadata"]


# ─── _fetch_messages ─────────────────────────────────────────────────────────


class TestFetchMessages:
    """Tests for _fetch_messages."""

    async def test_happy_path(self):
        msg = _make_message(sequence=1, content="Hello world")
        chat_repo = _make_chat_repo(messages=[msg])
        builder = SessionBuilder(chat_repository=chat_repo)

        messages = await builder._fetch_messages(CHAT_UUID)

        assert len(messages) == 1
        assert messages[0]["id"] == str(msg.id)
        assert messages[0]["role"] == "user"
        assert messages[0]["content"] == "Hello world"
        assert messages[0]["sequence_in_chat"] == 1
        assert messages[0]["chat_title"] == "Test Chat"
        assert messages[0]["model"] == "gpt-4"

    async def test_no_repo_returns_empty(self):
        builder = SessionBuilder()
        messages = await builder._fetch_messages(CHAT_UUID)
        assert messages == []

    async def test_repo_exception_returns_empty(self):
        chat_repo = _make_chat_repo()
        chat_repo.get_messages = AsyncMock(side_effect=RuntimeError("DB down"))
        builder = SessionBuilder(chat_repository=chat_repo)

        messages = await builder._fetch_messages(CHAT_UUID)
        assert messages == []

    async def test_created_at_as_string(self):
        """Messages where created_at is already a string (no isoformat method)."""
        msg = _make_message(sequence=1)
        msg.created_at = "2025-01-01T12:00:00+00:00"
        chat_repo = _make_chat_repo(messages=[msg])
        builder = SessionBuilder(chat_repository=chat_repo)

        messages = await builder._fetch_messages(CHAT_UUID)
        assert messages[0]["created_at"] == "2025-01-01T12:00:00+00:00"

    async def test_message_without_optional_attrs(self):
        """Message that lacks chat_title, user_id, llm_model attributes."""
        msg = SimpleNamespace(
            id=uuid4(),
            chat_id=CHAT_UUID,
            role="user",
            content="plain",
            sequence_in_chat=1,
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        )
        chat_repo = _make_chat_repo(messages=[msg])
        builder = SessionBuilder(chat_repository=chat_repo)

        messages = await builder._fetch_messages(CHAT_UUID)
        assert messages[0]["chat_title"] is None
        assert messages[0]["user_id"] is None
        assert messages[0]["model"] is None


# ─── _fetch_artifacts ────────────────────────────────────────────────────────


class TestFetchArtifacts:
    """Tests for _fetch_artifacts."""

    async def test_happy_path(self):
        art = _make_artifact()
        chat_repo = _make_chat_repo(artifacts=[art])
        builder = SessionBuilder(chat_repository=chat_repo)

        artifacts = await builder._fetch_artifacts(CHAT_UUID)

        assert len(artifacts) == 1
        assert artifacts[0]["id"] == str(art.id)
        assert artifacts[0]["type"] == "code"
        assert artifacts[0]["language"] == "python"
        assert artifacts[0]["dedup_id"] == "dedup-1"

    async def test_no_repo_returns_empty(self):
        builder = SessionBuilder()
        artifacts = await builder._fetch_artifacts(CHAT_UUID)
        assert artifacts == []

    async def test_repo_exception_returns_empty(self):
        chat_repo = _make_chat_repo()
        chat_repo.get_artifacts = AsyncMock(side_effect=RuntimeError("DB error"))
        builder = SessionBuilder(chat_repository=chat_repo)

        artifacts = await builder._fetch_artifacts(CHAT_UUID)
        assert artifacts == []

    async def test_artifact_with_message_id_and_node_id(self):
        mid = str(uuid4())
        nid = str(uuid4())
        sid = str(uuid4())
        art = _make_artifact(message_id=mid, node_id=nid, subgroup_id=sid)
        chat_repo = _make_chat_repo(artifacts=[art])
        builder = SessionBuilder(chat_repository=chat_repo)

        artifacts = await builder._fetch_artifacts(CHAT_UUID)
        assert artifacts[0]["message_id"] == mid
        assert artifacts[0]["node_id"] == nid
        assert artifacts[0]["subgroup_id"] == sid

    async def test_artifact_without_optional_attrs(self):
        """Artifact missing language, artifact_id, execution_group, etc."""
        art = SimpleNamespace(
            id=uuid4(),
            chat_id=CHAT_UUID,
            type="text",
            content="some text",
            created_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        )
        chat_repo = _make_chat_repo(artifacts=[art])
        builder = SessionBuilder(chat_repository=chat_repo)

        artifacts = await builder._fetch_artifacts(CHAT_UUID)
        assert artifacts[0]["language"] is None
        assert artifacts[0]["dedup_id"] is None
        assert artifacts[0]["message_id"] is None
        assert artifacts[0]["node_id"] is None


# ─── _fetch_trails ───────────────────────────────────────────────────────────


class TestFetchTrails:
    """Tests for _fetch_trails."""

    async def test_happy_path(self):
        trails = _make_trail_hierarchy()
        trail_repo = _make_trail_repo(trails=trails)
        builder = SessionBuilder(trail_repository=trail_repo)

        result = await builder._fetch_trails(CHAT_UUID)
        assert result == trails

    async def test_no_repo_returns_empty(self):
        builder = SessionBuilder()
        result = await builder._fetch_trails(CHAT_UUID)
        assert result == []

    async def test_repo_exception_returns_empty(self):
        trail_repo = _make_trail_repo()
        trail_repo.get_trail_hierarchy = AsyncMock(side_effect=RuntimeError("fail"))
        builder = SessionBuilder(trail_repository=trail_repo)

        result = await builder._fetch_trails(CHAT_UUID)
        assert result == []


# ─── _build_message_events ───────────────────────────────────────────────────


class TestBuildMessageEvents:
    """Tests for _build_message_events (sync helper)."""

    def test_happy_path(self):
        builder = SessionBuilder()
        messages = [
            {
                "id": MSG_ID_1,
                "role": "user",
                "content": "Hello",
                "sequence_in_chat": 1,
                "created_at": "2025-01-01T12:00:00",
                "model": "gpt-4",
                "input_tokens": 100,
                "output_tokens": 50,
            }
        ]
        events = builder._build_message_events(messages)

        assert len(events) == 1
        assert events[0]["type"] == "message"
        assert events[0]["sequence"] == 1
        assert events[0]["role"] == "user"
        assert events[0]["message_id"] == MSG_ID_1
        assert events[0]["tokens"]["input"] == 100
        assert events[0]["tokens"]["output"] == 50

    def test_missing_sequence_raises_value_error(self):
        builder = SessionBuilder()
        messages = [{"id": MSG_ID_1, "sequence_in_chat": None}]
        with pytest.raises(ValueError, match="missing sequence_in_chat"):
            builder._build_message_events(messages)

    def test_no_tokens_omits_tokens_field(self):
        builder = SessionBuilder()
        messages = [
            {
                "id": MSG_ID_1,
                "role": "assistant",
                "content": "reply",
                "sequence_in_chat": 1,
                "created_at": "2025-01-01T12:00:00",
                "model": None,
                "input_tokens": None,
                "output_tokens": None,
            }
        ]
        events = builder._build_message_events(messages)
        assert "tokens" not in events[0]

    def test_defaults_role_and_content(self):
        builder = SessionBuilder()
        messages = [{"id": MSG_ID_1, "sequence_in_chat": 1}]
        events = builder._build_message_events(messages)
        assert events[0]["role"] == "assistant"
        assert events[0]["content"] == ""

    def test_empty_messages_returns_empty(self):
        builder = SessionBuilder()
        assert builder._build_message_events([]) == []


# ─── _build_trail_events ────────────────────────────────────────────────────


class TestBuildTrailEvents:
    """Tests for _build_trail_events."""

    def test_happy_path_with_nodes_and_duration(self):
        builder = SessionBuilder()
        trails = _make_trail_hierarchy(
            sequence_in_chat=2,
            created_at="2025-01-01T12:02:00+00:00",
            completed_at="2025-01-01T12:02:05+00:00",
        )
        events = builder._build_trail_events(trails)

        assert len(events) == 1
        event = events[0]
        assert event["type"] == "trail"
        assert event["sequence"] == 2
        assert event["group_id"] == GROUP_ID
        assert event["subgroup_id"] == SUBGROUP_ID
        assert event["status"] == "completed"
        assert len(event["nodes"]) == 1
        assert event["nodes"][0]["node_id"] == NODE_ID
        # Duration: 5 seconds = 5000ms
        assert event["duration_ms"] == 5000

    def test_node_duration_calculated(self):
        builder = SessionBuilder()
        trails = _make_trail_hierarchy(
            nodes=[
                {
                    "id": NODE_ID,
                    "type": "tool_call",
                    "status": "completed",
                    "artifact_id": None,
                    "started_at": "2025-01-01T12:02:01+00:00",
                    "completed_at": "2025-01-01T12:02:03+00:00",
                }
            ]
        )
        events = builder._build_trail_events(trails)
        assert events[0]["nodes"][0]["duration_ms"] == 2000

    def test_group_without_id_skipped(self):
        builder = SessionBuilder()
        trails = [{"subgroups": [{"id": "sg-1", "sequence_in_chat": 1}]}]
        events = builder._build_trail_events(trails)
        assert events == []

    def test_subgroup_without_id_skipped(self):
        builder = SessionBuilder()
        trails = [
            {
                "id": GROUP_ID,
                "subgroups": [{"sequence_in_chat": 1, "nodes": []}],
            }
        ]
        events = builder._build_trail_events(trails)
        assert events == []

    def test_subgroup_missing_sequence_raises(self):
        builder = SessionBuilder()
        trails = [
            {
                "id": GROUP_ID,
                "subgroups": [
                    {"id": SUBGROUP_ID, "sequence_in_chat": None, "nodes": []}
                ],
            }
        ]
        with pytest.raises(ValueError, match="missing sequence_in_chat"):
            builder._build_trail_events(trails)

    def test_uses_group_id_fallback_key(self):
        """group_id key instead of id."""
        builder = SessionBuilder()
        trails = [
            {
                "group_id": "gid-alt",
                "subgroups": [
                    {
                        "subgroup_id": "sgid-alt",
                        "sequence_in_chat": 1,
                        "nodes": [],
                    }
                ],
            }
        ]
        events = builder._build_trail_events(trails)
        assert events[0]["group_id"] == "gid-alt"
        assert events[0]["subgroup_id"] == "sgid-alt"

    def test_subgroup_without_completed_at_no_duration(self):
        """No subgroup-level duration when completed_at is missing."""
        builder = SessionBuilder()
        trails = _make_trail_hierarchy(completed_at=None, created_at="2025-01-01T12:00:00+00:00")
        # Need to adjust — completed_at is checked for truthiness
        trails[0]["subgroups"][0]["completed_at"] = None
        events = builder._build_trail_events(trails)
        assert "duration_ms" not in events[0]

    def test_empty_trails_returns_empty(self):
        builder = SessionBuilder()
        assert builder._build_trail_events([]) == []

    def test_empty_subgroups_returns_empty(self):
        builder = SessionBuilder()
        trails = [{"id": GROUP_ID, "subgroups": []}]
        events = builder._build_trail_events(trails)
        assert events == []

    def test_empty_nodes_list(self):
        builder = SessionBuilder()
        trails = _make_trail_hierarchy(nodes=[])
        events = builder._build_trail_events(trails)
        assert events[0]["nodes"] == []


# ─── _verify_sequence_integrity ──────────────────────────────────────────────


class TestVerifySequenceIntegrity:
    """Tests for _verify_sequence_integrity."""

    def test_valid_sequence(self):
        builder = SessionBuilder()
        timeline = [{"sequence": 1}, {"sequence": 2}, {"sequence": 3}]
        # Should not raise
        builder._verify_sequence_integrity(timeline)

    def test_gap_raises_value_error(self):
        builder = SessionBuilder()
        timeline = [{"sequence": 1}, {"sequence": 3}]
        with pytest.raises(ValueError, match="Sequence gap"):
            builder._verify_sequence_integrity(timeline)

    def test_starts_at_wrong_number_raises(self):
        builder = SessionBuilder()
        timeline = [{"sequence": 2}]
        with pytest.raises(ValueError, match="Sequence gap"):
            builder._verify_sequence_integrity(timeline)

    def test_empty_timeline_passes(self):
        builder = SessionBuilder()
        builder._verify_sequence_integrity([])

    def test_single_element(self):
        builder = SessionBuilder()
        builder._verify_sequence_integrity([{"sequence": 1}])


# ─── _build_indexes ──────────────────────────────────────────────────────────


class TestBuildIndexes:
    """Tests for _build_indexes."""

    def test_indexes_message_and_trail(self):
        builder = SessionBuilder()
        timeline = [
            {"type": "message", "message_id": MSG_ID_1, "sequence": 1},
            {"type": "trail", "group_id": GROUP_ID, "sequence": 2},
        ]
        indexes = builder._build_indexes(timeline)

        assert indexes["messages_by_id"][MSG_ID_1] == 1
        assert GROUP_ID in indexes["trails_by_group"]
        assert indexes["trails_by_group"][GROUP_ID] == [2]

    def test_multiple_trails_same_group(self):
        builder = SessionBuilder()
        timeline = [
            {"type": "trail", "group_id": GROUP_ID, "sequence": 1},
            {"type": "trail", "group_id": GROUP_ID, "sequence": 2},
        ]
        indexes = builder._build_indexes(timeline)
        assert indexes["trails_by_group"][GROUP_ID] == [1, 2]

    def test_empty_timeline(self):
        builder = SessionBuilder()
        indexes = builder._build_indexes([])
        assert indexes["messages_by_id"] == {}
        assert indexes["artifacts_by_id"] == {}
        assert indexes["trails_by_group"] == {}


# ─── _calculate_metadata ────────────────────────────────────────────────────


class TestCalculateMetadata:
    """Tests for _calculate_metadata."""

    def test_counts_messages_and_trails(self):
        builder = SessionBuilder()
        timeline = [
            {"type": "message"},
            {"type": "message"},
            {"type": "trail"},
        ]
        messages = [
            {"input_tokens": 100, "output_tokens": 50},
            {"input_tokens": 200, "output_tokens": 100},
        ]
        meta = builder._calculate_metadata(timeline, messages)

        assert meta["total_events"] == 3
        assert meta["message_count"] == 2
        assert meta["trail_count"] == 1
        assert meta["total_tokens"] == 450

    def test_none_tokens_treated_as_zero(self):
        builder = SessionBuilder()
        messages = [{"input_tokens": None, "output_tokens": None}]
        meta = builder._calculate_metadata([{"type": "message"}], messages)
        assert meta["total_tokens"] == 0

    def test_empty_inputs(self):
        builder = SessionBuilder()
        meta = builder._calculate_metadata([], [])
        assert meta["total_events"] == 0
        assert meta["total_tokens"] == 0


# ─── _estimate_context_status ────────────────────────────────────────────────


class TestEstimateContextStatus:
    """Tests for _estimate_context_status."""

    def test_no_messages_returns_none(self):
        builder = SessionBuilder()
        assert builder._estimate_context_status([]) is None

    def test_normal_usage(self):
        builder = SessionBuilder()
        # 150 tokens / 100000 limit = 0.15% → normal
        messages = [{"input_tokens": 100, "output_tokens": 50}]
        result = builder._estimate_context_status(messages)
        assert result["status"] == "normal"
        assert result["needs_summarization"] is False
        assert result["recommend_new_chat"] is False

    def test_warning_threshold(self):
        builder = SessionBuilder()
        # 80000 / 100000 = 80% → warning
        messages = [{"input_tokens": 50000, "output_tokens": 30000}]
        result = builder._estimate_context_status(messages)
        assert result["status"] == "warning"
        assert result["needs_summarization"] is False

    def test_high_threshold(self):
        builder = SessionBuilder()
        # 91000 / 100000 = 91% → high
        messages = [{"input_tokens": 50000, "output_tokens": 41000}]
        result = builder._estimate_context_status(messages)
        assert result["status"] == "high"
        assert result["needs_summarization"] is True
        assert result["recommend_new_chat"] is False

    def test_critical_threshold(self):
        builder = SessionBuilder()
        # 96000 / 100000 = 96% → critical
        messages = [{"input_tokens": 50000, "output_tokens": 46000}]
        result = builder._estimate_context_status(messages)
        assert result["status"] == "critical"
        assert result["needs_summarization"] is True
        assert result["recommend_new_chat"] is True

    def test_settings_override_thresholds(self):
        settings = _make_settings(
            context_window=50000,
            warning_threshold=0.50,
            high_threshold=0.70,
            critical_threshold=0.90,
        )
        builder = SessionBuilder(settings=settings)
        # 35000 / 50000 = 70% → high (with custom thresholds)
        messages = [{"input_tokens": 20000, "output_tokens": 15000}]
        result = builder._estimate_context_status(messages)
        assert result["status"] == "high"
        assert result["token_limit"] == 50000

    def test_estimation_fallback_no_token_data(self):
        """When no input/output tokens, estimate via content length // 4."""
        builder = SessionBuilder()
        # Content length = 40 chars → 40 // 4 = 10 estimated tokens
        messages = [
            {"content": "A" * 40, "input_tokens": None, "output_tokens": None}
        ]
        result = builder._estimate_context_status(messages)
        assert result["token_count"] == 10
        assert result["status"] == "normal"

    def test_mixed_token_and_estimation(self):
        """Some messages have tokens, some don't."""
        builder = SessionBuilder()
        messages = [
            {"input_tokens": 100, "output_tokens": 50},
            {"content": "B" * 200, "input_tokens": None, "output_tokens": None},
        ]
        result = builder._estimate_context_status(messages)
        # First: 100 + 50 = 150. Second: 200 // 4 = 50. Total = 200
        assert result["token_count"] == 200

    def test_thresholds_in_result(self):
        builder = SessionBuilder()
        messages = [{"input_tokens": 10, "output_tokens": 5}]
        result = builder._estimate_context_status(messages)
        assert "thresholds" in result
        assert result["thresholds"]["warning"] == 80000
        assert result["thresholds"]["high"] == 90000
        assert result["thresholds"]["critical"] == 95000

    def test_settings_exception_uses_defaults(self):
        """If settings access raises, default thresholds used."""
        bad_settings = MagicMock()
        # Make llm.context_window a property that raises TypeError when int() called
        type(bad_settings.llm).context_window = property(
            lambda self: (_ for _ in ()).throw(TypeError("boom"))
        )
        builder = SessionBuilder(settings=bad_settings)

        messages = [{"input_tokens": 50, "output_tokens": 10}]
        result = builder._estimate_context_status(messages)
        # Should use default token_limit=100000
        assert result["token_limit"] == 100000

    def test_zero_token_limit(self):
        """Edge case: token_limit=0 avoids division by zero."""
        settings = _make_settings(context_window=0)
        builder = SessionBuilder(settings=settings)

        messages = [{"input_tokens": 100, "output_tokens": 50}]
        result = builder._estimate_context_status(messages)
        assert result["usage_percent"] == 0.0
        assert result["status"] == "normal"


# ─── _calculate_duration ─────────────────────────────────────────────────────


class TestCalculateDuration:
    """Tests for _calculate_duration."""

    def test_happy_path(self):
        builder = SessionBuilder()
        result = builder._calculate_duration(
            "2025-01-01T12:00:00+00:00",
            "2025-01-01T12:00:05+00:00",
        )
        assert result == 5000

    def test_none_started(self):
        builder = SessionBuilder()
        assert builder._calculate_duration(None, "2025-01-01T12:00:00+00:00") is None

    def test_none_completed(self):
        builder = SessionBuilder()
        assert builder._calculate_duration("2025-01-01T12:00:00+00:00", None) is None

    def test_both_none(self):
        builder = SessionBuilder()
        assert builder._calculate_duration(None, None) is None

    def test_z_suffix(self):
        builder = SessionBuilder()
        result = builder._calculate_duration(
            "2025-01-01T12:00:00Z",
            "2025-01-01T12:00:10Z",
        )
        assert result == 10000

    def test_invalid_date_returns_none(self):
        builder = SessionBuilder()
        assert builder._calculate_duration("not-a-date", "also-bad") is None

    def test_sub_second_precision(self):
        builder = SessionBuilder()
        result = builder._calculate_duration(
            "2025-01-01T12:00:00.000+00:00",
            "2025-01-01T12:00:00.500+00:00",
        )
        assert result == 500


# ─── _now_iso ────────────────────────────────────────────────────────────────


class TestNowIso:
    """Tests for _now_iso helper."""

    def test_returns_iso_string(self):
        builder = SessionBuilder()
        result = builder._now_iso()
        # Should be parseable ISO format
        parsed = datetime.fromisoformat(result)
        assert parsed.tzinfo is not None

    def test_is_utc(self):
        builder = SessionBuilder()
        result = builder._now_iso()
        assert "+00:00" in result or "Z" in result
