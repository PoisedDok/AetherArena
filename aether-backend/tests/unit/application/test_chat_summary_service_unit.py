"""
Unit Tests: ChatSummaryService (application/chat/summary_service.py)

Comprehensive coverage of LLM-powered chat summarization: generate, get, search,
size-adaptive message formatting, JSON/text response parsing, entity normalization,
and database persistence.

Mock boundaries:
- gateway (SupabasePersistenceGateway) → mock select/insert/update/rpc
- ChatRepository.create_chat_summary → reached through gateway
- httpx.AsyncClient → mock LLM calls
- Settings → mock resolve_service_provider, summary_service config, http_client
- DocumentUtility → patched for large-chat extraction tests
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from application.chat.summary_service import ChatSummaryService
from data.database.persistence_gateway import SupabasePersistenceGateway


# ─── Helpers ─────────────────────────────────────────────────────────────────

CHAT_ID = uuid4()
SUMMARY_ID = str(uuid4())


def _make_summary_service_cfg() -> MagicMock:
    """Create a mock for settings.summary_service with all required fields."""
    cfg = MagicMock()
    cfg.provider_config = MagicMock()
    cfg.default_search_limit = 10
    cfg.small_chat_threshold = 5
    cfg.medium_chat_threshold = 30
    cfg.large_chat_threshold = 100
    cfg.max_conversation_chars = 24000
    cfg.title_max_length = 100
    cfg.key_points_max = 8
    cfg.fallback_content_length = 300
    cfg.temperature = 0.6
    cfg.max_tokens = 30720
    cfg.max_tokens_brief = 8192
    cfg.system_prompt_template = (
        "Summarize. {instruction} Title max {title_max_length}. "
        "Points max {key_points_max}. {size_hint}"
    )
    return cfg


def _make_settings(
    *,
    api_base: str = "http://127.0.0.1:7090/v1",
    model: str = "test-model",
    api_key: str = "not-needed",
) -> MagicMock:
    """Create a mock Settings object with all fields ChatSummaryService uses."""
    settings = MagicMock()
    settings.resolve_service_provider.return_value = (api_base, model, api_key)
    settings.summary_service = _make_summary_service_cfg()
    settings.http_client = MagicMock()
    settings.http_client.llm_timeout = 300.0
    return settings


def _make_gateway() -> MagicMock:
    """Create a mock gateway that passes isinstance(gw, SupabasePersistenceGateway)."""
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.select = AsyncMock(return_value=[])
    gw.insert = AsyncMock(return_value=[{"id": SUMMARY_ID}])
    gw.update = AsyncMock(return_value=[{"id": SUMMARY_ID}])
    gw.rpc = AsyncMock(return_value=[])
    gw.delete = AsyncMock(return_value=None)
    return gw


def _make_service(
    gateway: MagicMock | None = None,
    settings: MagicMock | None = None,
) -> tuple[ChatSummaryService, MagicMock, MagicMock]:
    """Create ChatSummaryService with mocked dependencies.

    Returns (service, gateway, settings).
    """
    if gateway is None:
        gateway = _make_gateway()
    if settings is None:
        settings = _make_settings()
    uow = SimpleNamespace(gateway=gateway)
    svc = ChatSummaryService(uow, settings)
    return svc, gateway, settings


def _mock_httpx_response(data: dict, status_code: int = 200) -> MagicMock:
    """Create a mock httpx response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = data
    resp.text = json.dumps(data) if status_code != 200 else ""
    return resp


def _llm_summary_response(summary_json: dict) -> dict:
    """Standard LLM summary response wrapping summary_json."""
    return {
        "choices": [{
            "message": {
                "content": json.dumps(summary_json)
            }
        }]
    }


def _make_messages(count: int, *, with_timestamps: bool = True) -> List[Dict[str, Any]]:
    """Create a list of fake chat messages."""
    msgs = []
    for i in range(count):
        role = "user" if i % 2 == 0 else "assistant"
        msg = {
            "role": role,
            "content": f"Message {i} content",
        }
        if with_timestamps:
            # Use sortable timestamps
            msg["created_at"] = f"2026-02-09T10:{i:02d}:00Z"
        msgs.append(msg)
    return msgs


VALID_SUMMARY = {
    "title": "Architecture Discussion",
    "summary": "The team discussed microservices architecture and decided on gRPC.",
    "key_points": ["Chose gRPC over REST", "Deadline set for March"],
    "entities": {"technologies": ["gRPC", "REST"], "people": ["Alice"]},
    "topics": ["architecture", "microservices"],
}


# ─── __init__ ────────────────────────────────────────────────────────────────


class TestInit:
    """Tests for ChatSummaryService constructor."""

    def test_initializes_correctly(self):
        svc, gw, settings = _make_service()
        assert svc._gateway is gw
        assert svc._settings is settings
        assert svc._llm_api_base == "http://127.0.0.1:7090/v1"
        assert svc._llm_model == "test-model"
        assert svc._llm_api_key == "not-needed"

    def test_strips_trailing_slash_from_api_base(self):
        settings = _make_settings(api_base="http://127.0.0.1:7090/v1/")
        svc, _, _ = _make_service(settings=settings)
        assert svc._llm_api_base == "http://127.0.0.1:7090/v1"

    def test_resolve_service_provider_called_with_correct_args(self):
        settings = _make_settings()
        svc, _, _ = _make_service(settings=settings)
        settings.resolve_service_provider.assert_called_once_with(
            settings.summary_service.provider_config, service_type="text"
        )

    def test_creates_chat_repository_from_gateway(self):
        svc, gw, _ = _make_service()
        assert svc._chat_repository is not None
        assert svc._chat_repository._gateway is gw


# ─── generate_summary ────────────────────────────────────────────────────────


class TestGenerateSummary:
    """Tests for generate_summary (orchestrator)."""

    async def test_returns_existing_summary_when_not_force_regenerate(self):
        svc, gw, _ = _make_service()
        existing = {"id": SUMMARY_ID, "title": "Existing", "summary_type": "full"}
        gw.select = AsyncMock(return_value=[existing])

        result = await svc.generate_summary(CHAT_ID, summary_type="full")

        assert result == existing

    async def test_force_regenerate_skips_existing_check(self):
        svc, gw, settings = _make_service()
        messages = _make_messages(3)
        # First select: _get_existing_summary (would return existing)
        # But force_regenerate bypasses it, so select is for _fetch_chat_messages
        gw.select = AsyncMock(return_value=messages)

        with patch.object(svc, "_call_llm_for_summary", new_callable=AsyncMock) as mock_llm, \
             patch.object(svc, "_save_summary", new_callable=AsyncMock) as mock_save:
            mock_llm.return_value = VALID_SUMMARY
            mock_save.return_value = {"id": SUMMARY_ID, **VALID_SUMMARY}

            result = await svc.generate_summary(CHAT_ID, force_regenerate=True)

        mock_llm.assert_awaited_once()
        mock_save.assert_awaited_once()
        assert result["id"] == SUMMARY_ID

    async def test_raises_if_chat_has_no_messages(self):
        svc, gw, _ = _make_service()
        # First call: _get_existing_summary returns None
        # Second call: _fetch_chat_messages returns empty
        gw.select = AsyncMock(side_effect=[[], []])

        with pytest.raises(ValueError, match="has no messages to summarize"):
            await svc.generate_summary(CHAT_ID)

    async def test_raises_if_messages_is_none(self):
        """Edge case: gateway returns None instead of empty list."""
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(side_effect=[[], None])

        with pytest.raises(ValueError, match="has no messages to summarize"):
            await svc.generate_summary(CHAT_ID)

    async def test_full_flow_happy_path(self):
        svc, gw, _ = _make_service()
        messages = _make_messages(4)
        # Call 1: _get_existing_summary → empty
        # Call 2: _fetch_chat_messages → messages
        gw.select = AsyncMock(side_effect=[[], messages])

        with patch.object(svc, "_call_llm_for_summary", new_callable=AsyncMock) as mock_llm, \
             patch.object(svc, "_save_summary", new_callable=AsyncMock) as mock_save:
            mock_llm.return_value = VALID_SUMMARY
            saved = {"id": SUMMARY_ID, **VALID_SUMMARY}
            mock_save.return_value = saved

            result = await svc.generate_summary(CHAT_ID, summary_type="brief")

        assert result["id"] == SUMMARY_ID
        # Verify _call_llm_for_summary received formatted text and type
        call_args = mock_llm.call_args
        assert call_args.kwargs.get("summary_type") == "brief" or call_args.args[1] == "brief"
        # Verify _save_summary received chat_id, type, and data
        save_args = mock_save.call_args
        assert save_args.args[0] == CHAT_ID
        assert save_args.args[1] == "brief"


# ─── get_summary ─────────────────────────────────────────────────────────────


class TestGetSummary:
    """Tests for get_summary."""

    async def test_returns_existing(self):
        svc, gw, _ = _make_service()
        existing = {"id": SUMMARY_ID, "title": "Test", "summary_type": "full"}
        gw.select = AsyncMock(return_value=[existing])

        result = await svc.get_summary(CHAT_ID, summary_type="full")
        assert result == existing

    async def test_returns_none_when_not_found(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        result = await svc.get_summary(CHAT_ID)
        assert result is None

    async def test_default_summary_type_is_full(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        await svc.get_summary(CHAT_ID)

        gw.select.assert_awaited_once()
        call_kwargs = gw.select.call_args.kwargs if gw.select.call_args.kwargs else {}
        call_args = gw.select.call_args.args if gw.select.call_args.args else ()
        filters = call_kwargs.get("filters") or (call_args[1] if len(call_args) > 1 else {})
        assert filters.get("summary_type") == "full"


# ─── search_summaries ────────────────────────────────────────────────────────


class TestSearchSummaries:
    """Tests for search_summaries."""

    async def test_happy_path(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=[
            {"id": "1", "title": "Result", "relevance": 0.9},
        ])

        result = await svc.search_summaries("architecture")

        assert len(result) == 1
        gw.rpc.assert_awaited_once_with(
            "search_chat_summaries",
            {"p_query_text": "architecture", "p_match_count": 10},
        )

    async def test_uses_config_default_limit(self):
        svc, gw, settings = _make_service()
        settings.summary_service.default_search_limit = 25
        gw.rpc = AsyncMock(return_value=[])

        await svc.search_summaries("test")

        call_params = gw.rpc.call_args.args[1]
        assert call_params["p_match_count"] == 25

    async def test_explicit_limit_overrides_config(self):
        svc, gw, settings = _make_service()
        settings.summary_service.default_search_limit = 25
        gw.rpc = AsyncMock(return_value=[])

        await svc.search_summaries("test", limit=5)

        call_params = gw.rpc.call_args.args[1]
        assert call_params["p_match_count"] == 5

    async def test_returns_empty_list_when_rpc_returns_none(self):
        svc, gw, _ = _make_service()
        gw.rpc = AsyncMock(return_value=None)

        result = await svc.search_summaries("query")
        assert result == []


# ─── _get_existing_summary ───────────────────────────────────────────────────


class TestGetExistingSummary:
    """Tests for _get_existing_summary."""

    async def test_returns_first_result(self):
        svc, gw, _ = _make_service()
        record = {"id": SUMMARY_ID, "title": "Summary"}
        gw.select = AsyncMock(return_value=[record])

        result = await svc._get_existing_summary(CHAT_ID, "full")

        assert result == record
        gw.select.assert_awaited_once_with(
            "chat_summaries",
            filters={"chat_id": str(CHAT_ID), "summary_type": "full"},
            limit=1,
        )

    async def test_returns_none_on_empty(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        result = await svc._get_existing_summary(CHAT_ID, "brief")
        assert result is None

    async def test_returns_none_on_none_result(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=None)

        result = await svc._get_existing_summary(CHAT_ID, "full")
        assert result is None


# ─── _fetch_chat_messages ────────────────────────────────────────────────────


class TestFetchChatMessages:
    """Tests for _fetch_chat_messages."""

    async def test_returns_sorted_messages(self):
        svc, gw, _ = _make_service()
        msgs = [
            {"role": "user", "content": "second", "created_at": "2026-02-09T10:02:00Z"},
            {"role": "assistant", "content": "first", "created_at": "2026-02-09T10:01:00Z"},
        ]
        gw.select = AsyncMock(return_value=msgs)

        result = await svc._fetch_chat_messages(CHAT_ID)

        # Should be sorted by created_at ascending
        assert result[0]["content"] == "first"
        assert result[1]["content"] == "second"

    async def test_returns_empty_on_none(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=None)

        result = await svc._fetch_chat_messages(CHAT_ID)
        assert result == []

    async def test_returns_empty_on_empty_list(self):
        svc, gw, _ = _make_service()
        gw.select = AsyncMock(return_value=[])

        result = await svc._fetch_chat_messages(CHAT_ID)
        assert result == []

    async def test_handles_missing_created_at(self):
        svc, gw, _ = _make_service()
        msgs = [
            {"role": "user", "content": "no timestamp"},
            {"role": "assistant", "content": "also none"},
        ]
        gw.select = AsyncMock(return_value=msgs)

        result = await svc._fetch_chat_messages(CHAT_ID)
        assert len(result) == 2


# ─── _classify_chat_size ─────────────────────────────────────────────────────


class TestClassifyChatSize:
    """Tests for _classify_chat_size (pure function)."""

    def test_small(self):
        svc, _, _ = _make_service()
        assert svc._classify_chat_size(1) == "small"
        assert svc._classify_chat_size(5) == "small"

    def test_medium(self):
        svc, _, _ = _make_service()
        assert svc._classify_chat_size(6) == "medium"
        assert svc._classify_chat_size(30) == "medium"

    def test_large(self):
        svc, _, _ = _make_service()
        assert svc._classify_chat_size(31) == "large"
        assert svc._classify_chat_size(100) == "large"

    def test_xlarge(self):
        svc, _, _ = _make_service()
        assert svc._classify_chat_size(101) == "xlarge"
        assert svc._classify_chat_size(500) == "xlarge"

    def test_boundary_at_small_threshold(self):
        svc, _, settings = _make_service()
        settings.summary_service.small_chat_threshold = 5
        assert svc._classify_chat_size(5) == "small"
        assert svc._classify_chat_size(6) == "medium"


# ─── _format_single_message ─────────────────────────────────────────────────


class TestFormatSingleMessage:
    """Tests for _format_single_message (pure function)."""

    def test_basic_format_no_timestamp(self):
        svc, _, _ = _make_service()
        msg = {"role": "user", "content": "Hello"}
        result = svc._format_single_message(msg)
        assert result == "USER: Hello"

    def test_with_timestamp(self):
        svc, _, _ = _make_service()
        msg = {"role": "assistant", "content": "Hi there", "created_at": "2026-02-09T10:30:00Z"}
        result = svc._format_single_message(msg, include_timestamp=True)
        assert result == "[2026-02-09T10:30] ASSISTANT: Hi there"

    def test_empty_content_returns_empty(self):
        svc, _, _ = _make_service()
        msg = {"role": "user", "content": ""}
        result = svc._format_single_message(msg)
        assert result == ""

    def test_none_content_returns_empty(self):
        svc, _, _ = _make_service()
        msg = {"role": "user", "content": None}
        result = svc._format_single_message(msg)
        assert result == ""

    def test_missing_role_defaults_to_unknown(self):
        svc, _, _ = _make_service()
        msg = {"content": "Some text"}
        result = svc._format_single_message(msg)
        assert result == "UNKNOWN: Some text"

    def test_whitespace_only_content_returns_empty(self):
        svc, _, _ = _make_service()
        msg = {"role": "user", "content": "   \n  "}
        result = svc._format_single_message(msg)
        assert result == ""

    def test_timestamp_without_created_at_field(self):
        svc, _, _ = _make_service()
        msg = {"role": "user", "content": "Hello"}
        result = svc._format_single_message(msg, include_timestamp=True)
        # No timestamp → falls through to no-timestamp format
        assert result == "USER: Hello"

    def test_timestamp_with_empty_created_at(self):
        svc, _, _ = _make_service()
        msg = {"role": "user", "content": "Hello", "created_at": ""}
        result = svc._format_single_message(msg, include_timestamp=True)
        # Empty ts → falls through
        assert result == "USER: Hello"


# ─── _format_all_messages ────────────────────────────────────────────────────


class TestFormatAllMessages:
    """Tests for _format_all_messages."""

    def test_formats_multiple_messages(self):
        svc, _, _ = _make_service()
        msgs = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi"},
        ]
        result = svc._format_all_messages(msgs)
        assert "USER: Hello" in result
        assert "ASSISTANT: Hi" in result
        # Messages separated by double newline
        assert "\n\n" in result

    def test_skips_empty_content(self):
        svc, _, _ = _make_service()
        msgs = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": ""},
            {"role": "user", "content": "Still here"},
        ]
        result = svc._format_all_messages(msgs)
        lines = [l for l in result.split("\n\n") if l.strip()]
        assert len(lines) == 2

    def test_with_timestamps(self):
        svc, _, _ = _make_service()
        msgs = [
            {"role": "user", "content": "Hello", "created_at": "2026-02-09T10:00:00Z"},
        ]
        result = svc._format_all_messages(msgs, include_timestamp=True)
        assert "[2026-02-09T10:00]" in result


# ─── _format_messages_for_llm ────────────────────────────────────────────────


class TestFormatMessagesForLlm:
    """Tests for _format_messages_for_llm (size-adaptive orchestrator)."""

    def test_small_chat_includes_timestamps(self):
        svc, _, _ = _make_service()
        msgs = _make_messages(3)

        result = svc._format_messages_for_llm(msgs)

        # Small chat → timestamps included
        assert "[2026-02-09T10:00]" in result

    def test_medium_chat_no_timestamps(self):
        svc, _, _ = _make_service()
        msgs = _make_messages(10)

        result = svc._format_messages_for_llm(msgs)

        # Medium chat → no timestamps
        assert "[2026-02-09" not in result
        assert "USER:" in result

    def test_large_chat_uses_document_utility(self):
        svc, _, _ = _make_service()
        msgs = _make_messages(50)

        with patch.object(svc, "_extract_via_document_utility", return_value="[EXTRACTED]") as mock_extract:
            result = svc._format_messages_for_llm(msgs)

        mock_extract.assert_called_once()
        assert result == "[EXTRACTED]"

    def test_xlarge_chat_uses_document_utility(self):
        svc, _, _ = _make_service()
        msgs = _make_messages(150)

        with patch.object(svc, "_extract_via_document_utility", return_value="[EXTRACTED XL]") as mock_extract:
            result = svc._format_messages_for_llm(msgs)

        mock_extract.assert_called_once()
        assert result == "[EXTRACTED XL]"


# ─── _extract_via_document_utility ───────────────────────────────────────────


class TestExtractViaDocumentUtility:
    """Tests for _extract_via_document_utility.

    The method delegates to DocumentUtility.extract_from_text, so tests verify
    correct instantiation, delegation, and fallback behaviour.
    """

    def test_returns_raw_text_when_extraction_yields_nothing(self):
        svc, _, _ = _make_service()

        with patch("application.chat.summary_service.DocumentUtility") as MockDU:
            mock_instance = MockDU.return_value
            mock_instance.extract_from_text.return_value = None

            result = svc._extract_via_document_utility("Hello world", message_count=5)

        assert result == "Hello world"

    def test_returns_raw_text_when_extraction_yields_empty_string(self):
        svc, _, _ = _make_service()

        with patch("application.chat.summary_service.DocumentUtility") as MockDU:
            mock_instance = MockDU.return_value
            mock_instance.extract_from_text.return_value = ""

            result = svc._extract_via_document_utility("Original text", message_count=5)

        assert result == "Original text"

    def test_returns_extracted_text_on_success(self):
        svc, _, _ = _make_service()

        with patch("application.chat.summary_service.DocumentUtility") as MockDU:
            mock_instance = MockDU.return_value
            mock_instance.extract_from_text.return_value = "Extracted content here."

            result = svc._extract_via_document_utility("Full text...", message_count=10)

        assert result == "Extracted content here."

    def test_instantiates_with_chat_tuned_params(self):
        svc, _, _ = _make_service()

        with patch("application.chat.summary_service.DocumentUtility") as MockDU:
            mock_instance = MockDU.return_value
            mock_instance.extract_from_text.return_value = "extracted"

            svc._extract_via_document_utility("text", message_count=20)

        # cfg.max_conversation_chars = 24000 → 24000 // 5 = 4800
        MockDU.assert_called_once_with(
            max_context_tokens=4800,
            target_sentences=30,
        )

    def test_passes_correct_filename_to_extract(self):
        svc, _, _ = _make_service()
        full_text = "User: Hello\nAssistant: Hi\n" * 100

        with patch("application.chat.summary_service.DocumentUtility") as MockDU:
            mock_instance = MockDU.return_value
            mock_instance.extract_from_text.return_value = "extracted"

            svc._extract_via_document_utility(full_text, message_count=42)

        mock_instance.extract_from_text.assert_called_once_with(
            full_text, "conversation_42msgs",
        )


# ─── _parse_plain_text_summary ───────────────────────────────────────────────


class TestParsePlainTextSummary:
    """Tests for _parse_plain_text_summary (plain text fallback parser)."""

    def test_basic_parsing(self):
        svc, _, _ = _make_service()
        text = "Architecture Discussion\nThe team discussed microservices.\n- Chose gRPC\n- Set deadline"

        result = svc._parse_plain_text_summary(text)

        assert result["title"] == "Architecture Discussion"
        assert "Chose gRPC" in result["key_points"]
        assert "Set deadline" in result["key_points"]
        assert result["entities"] == {}
        assert result["topics"] == []

    def test_strips_title_prefixes(self):
        svc, _, _ = _make_service()
        for prefix in ("Title:", "title:", "Summary:", "summary:", "#"):
            text = f"{prefix} My Summary Title\nBody text"
            result = svc._parse_plain_text_summary(text)
            assert result["title"] == "My Summary Title"

    def test_empty_text(self):
        svc, _, _ = _make_service()
        result = svc._parse_plain_text_summary("")
        assert result["title"] == "Conversation Summary"
        assert result["key_points"] == [""]

    def test_bullet_point_formats(self):
        svc, _, _ = _make_service()
        text = "Title\n- Dash point\n* Star point\n• Bullet point\n1. Numbered point"
        result = svc._parse_plain_text_summary(text)
        assert len(result["key_points"]) == 4

    def test_summary_prose_from_non_bullet_lines(self):
        svc, _, _ = _make_service()
        text = "Title\nThis is prose summary line one.\nThis is line two.\n- A point"
        result = svc._parse_plain_text_summary(text)
        assert "prose summary line one" in result["summary"]
        assert "line two" in result["summary"]

    def test_title_truncated_to_max_length(self):
        svc, _, settings = _make_service()
        settings.summary_service.title_max_length = 10
        text = "A" * 200 + "\nBody"
        result = svc._parse_plain_text_summary(text)
        assert len(result["title"]) == 10

    def test_key_points_limited_to_max(self):
        svc, _, settings = _make_service()
        settings.summary_service.key_points_max = 2
        text = "Title\n- Point 1\n- Point 2\n- Point 3\n- Point 4"
        result = svc._parse_plain_text_summary(text)
        assert len(result["key_points"]) == 2

    def test_fallback_content_length_limit(self):
        svc, _, settings = _make_service()
        settings.summary_service.fallback_content_length = 20
        long_text = "Title\n" + "A" * 500
        result = svc._parse_plain_text_summary(long_text)
        assert len(result["summary"]) <= 20


# ─── _get_type_instruction ──────────────────────────────────────────────────


class TestGetTypeInstruction:
    """Tests for _get_type_instruction (pure function)."""

    def test_brief_type(self):
        svc, _, _ = _make_service()
        result = svc._get_type_instruction("brief", "small")
        assert "BRIEF SUMMARY MODE" in result
        assert "2-3 sentences" in result

    def test_technical_type(self):
        svc, _, _ = _make_service()
        result = svc._get_type_instruction("technical", "medium")
        assert "TECHNICAL SUMMARY MODE" in result
        assert "code changes" in result

    def test_executive_type(self):
        svc, _, _ = _make_service()
        result = svc._get_type_instruction("executive", "large")
        assert "EXECUTIVE SUMMARY MODE" in result
        assert "action items" in result

    def test_full_type_default(self):
        svc, _, _ = _make_service()
        result = svc._get_type_instruction("full", "xlarge")
        assert "FULL SUMMARY MODE" in result
        assert "comprehensive" in result

    def test_unknown_type_falls_through_to_full(self):
        svc, _, _ = _make_service()
        result = svc._get_type_instruction("unknown_type", "small")
        assert "FULL SUMMARY MODE" in result

    def test_size_hint_in_instruction_small(self):
        svc, _, _ = _make_service()
        result = svc._get_type_instruction("full", "small")
        assert "1-3 key points" in result

    def test_size_hint_in_instruction_medium(self):
        svc, _, _ = _make_service()
        result = svc._get_type_instruction("full", "medium")
        assert "main discussion threads" in result

    def test_size_hint_in_instruction_large(self):
        svc, _, _ = _make_service()
        result = svc._get_type_instruction("full", "large")
        assert "relevance-ranked" in result

    def test_size_hint_in_instruction_xlarge(self):
        svc, _, _ = _make_service()
        result = svc._get_type_instruction("full", "xlarge")
        assert "very long conversation" in result


# ─── _get_size_hint ──────────────────────────────────────────────────────────


class TestGetSizeHint:
    """Tests for _get_size_hint (pure function)."""

    def test_small(self):
        svc, _, _ = _make_service()
        result = svc._get_size_hint(3, "small")
        assert "short conversation" in result
        assert "3 messages" in result

    def test_medium(self):
        svc, _, _ = _make_service()
        result = svc._get_size_hint(20, "medium")
        assert "medium-length" in result
        assert "20 messages" in result

    def test_large(self):
        svc, _, _ = _make_service()
        result = svc._get_size_hint(75, "large")
        assert "long conversation" in result
        assert "relevance ranking" in result

    def test_xlarge(self):
        svc, _, _ = _make_service()
        result = svc._get_size_hint(200, "xlarge")
        assert "very long conversation" in result
        assert "200 messages" in result


# ─── _call_llm_for_summary ──────────────────────────────────────────────────


class TestCallLlmForSummary:
    """Tests for _call_llm_for_summary (HTTP call to LLM)."""

    async def test_happy_path(self):
        svc, _, settings = _make_service()
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response(_llm_summary_response(VALID_SUMMARY))
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await svc._call_llm_for_summary(
                "USER: Hello\nASSISTANT: Hi",
                summary_type="full",
                message_count=2,
            )

        assert result["title"] == "Architecture Discussion"
        assert result["message_count"] == 2
        mock_client.post.assert_awaited_once()

    async def test_sends_correct_url_and_headers(self):
        svc, _, settings = _make_service(
            settings=_make_settings(
                api_base="http://myserver:8000/v1",
                api_key="my-secret-key",
            )
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response(_llm_summary_response(VALID_SUMMARY))
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            await svc._call_llm_for_summary("text", "full", message_count=1)

        call_args = mock_client.post.call_args
        assert call_args.args[0] == "http://myserver:8000/v1/chat/completions"
        headers = call_args.kwargs.get("headers") or call_args[1].get("headers", {})
        assert headers["Authorization"] == "Bearer my-secret-key"

    async def test_no_auth_header_when_key_is_not_needed(self):
        svc, _, _ = _make_service(settings=_make_settings(api_key="not-needed"))
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response(_llm_summary_response(VALID_SUMMARY))
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            await svc._call_llm_for_summary("text", "full", message_count=1)

        call_args = mock_client.post.call_args
        headers = call_args.kwargs.get("headers") or call_args[1].get("headers", {})
        assert "Authorization" not in headers

    async def test_no_auth_header_when_key_is_empty(self):
        svc, _, _ = _make_service(settings=_make_settings(api_key=""))
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response(_llm_summary_response(VALID_SUMMARY))
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            await svc._call_llm_for_summary("text", "full", message_count=1)

        call_args = mock_client.post.call_args
        headers = call_args.kwargs.get("headers") or call_args[1].get("headers", {})
        assert "Authorization" not in headers

    async def test_brief_summary_uses_max_tokens_brief(self):
        svc, _, settings = _make_service()
        settings.summary_service.max_tokens_brief = 4096
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response(_llm_summary_response(VALID_SUMMARY))
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            await svc._call_llm_for_summary("text", "brief", message_count=3)

        body = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json", {})
        assert body["max_tokens"] == 4096

    async def test_non_brief_uses_max_tokens(self):
        svc, _, settings = _make_service()
        settings.summary_service.max_tokens = 30720
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=_mock_httpx_response(_llm_summary_response(VALID_SUMMARY))
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            await svc._call_llm_for_summary("text", "technical", message_count=10)

        body = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json", {})
        assert body["max_tokens"] == 30720

    async def test_non_200_raises_http_error(self):
        import httpx as httpx_mod

        svc, _, _ = _make_service()
        mock_client = AsyncMock()
        error_resp = _mock_httpx_response({"error": "overloaded"}, status_code=503)
        error_resp.text = '{"error": "overloaded"}'
        mock_client.post = AsyncMock(return_value=error_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(httpx_mod.HTTPError, match="503"):
                await svc._call_llm_for_summary("text", "full", message_count=1)

    async def test_empty_system_prompt_template_raises(self):
        svc, _, settings = _make_service()
        settings.summary_service.system_prompt_template = ""

        with pytest.raises(ValueError, match="system_prompt_template is empty"):
            await svc._call_llm_for_summary("text", "full", message_count=1)

    async def test_invalid_system_prompt_template_raises(self):
        svc, _, settings = _make_service()
        # Template with bad placeholder
        settings.summary_service.system_prompt_template = "Hello {nonexistent_var}"

        with pytest.raises(ValueError, match="Invalid summary_service.system_prompt_template"):
            await svc._call_llm_for_summary("text", "full", message_count=1)

    async def test_general_exception_re_raised(self):
        svc, _, _ = _make_service()
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=RuntimeError("network down"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="network down"):
                await svc._call_llm_for_summary("text", "full", message_count=1)


# ─── _parse_llm_response ────────────────────────────────────────────────────


class TestParseLlmResponse:
    """Tests for _parse_llm_response (multi-fallback parser)."""

    def test_direct_json_parse(self):
        svc, _, _ = _make_service()
        raw = json.dumps(VALID_SUMMARY)
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Architecture Discussion"

    def test_strips_markdown_code_fences(self):
        svc, _, _ = _make_service()
        raw = f"```json\n{json.dumps(VALID_SUMMARY)}\n```"
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Architecture Discussion"

    def test_strips_markdown_bare_fences(self):
        svc, _, _ = _make_service()
        raw = f"```\n{json.dumps(VALID_SUMMARY)}\n```"
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Architecture Discussion"

    def test_finds_json_in_text_with_preamble(self):
        svc, _, _ = _make_service()
        raw = f"Here is the summary:\n{json.dumps(VALID_SUMMARY)}\nDone."
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Architecture Discussion"

    def test_strips_think_tags(self):
        svc, _, _ = _make_service()
        raw = f"<think>Let me analyze this...</think>\n{json.dumps(VALID_SUMMARY)}"
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Architecture Discussion"

    def test_falls_back_to_plain_text(self):
        svc, _, _ = _make_service()
        raw = "Architecture Discussion\nThe team discussed something.\n- Point one\n- Point two"
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Architecture Discussion"
        assert len(result["key_points"]) >= 1

    def test_json_with_only_title_key_accepted(self):
        svc, _, _ = _make_service()
        raw = 'Some preamble {"title": "Only Title"} trailing'
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Only Title"

    def test_json_without_summary_keys_rejected(self):
        """JSON that doesn't have title/key_points/summary is rejected."""
        svc, _, _ = _make_service()
        raw = 'Some text {"unrelated": true, "data": [1,2,3]} more text'
        result = svc._parse_llm_response(raw)
        # Falls through to plain text parser since no summary keys
        assert "title" in result  # From plain text parser

    def test_brace_scanning_handles_nested_braces(self):
        svc, _, _ = _make_service()
        summary_with_nested = {
            "title": "Test",
            "summary": "Nested {braces} here",
            "key_points": ["Point"],
            "entities": {"people": ["Alice"]},
            "topics": [],
        }
        raw = f"Preamble {json.dumps(summary_with_nested)} end"
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Test"
        assert result["summary"] == "Nested {braces} here"

    def test_brace_scanning_handles_escaped_quotes(self):
        svc, _, _ = _make_service()
        summary = {"title": 'Test "quoted"', "key_points": ["Point"]}
        raw = f"Text {json.dumps(summary)} more"
        result = svc._parse_llm_response(raw)
        assert result["title"] == 'Test "quoted"'

    def test_invalid_json_inside_markdown_fences_falls_through(self):
        """Covers line 569: JSONDecodeError inside markdown code fence path."""
        svc, _, _ = _make_service()
        raw = "```json\n{not valid json at all\n```"
        result = svc._parse_llm_response(raw)
        # Falls through to brace scanning or plain text
        assert "title" in result

    def test_brace_scanning_with_invalid_json_candidate(self):
        """Covers line 613: balanced braces but invalid JSON content."""
        svc, _, _ = _make_service()
        # Balanced braces but not valid JSON, followed by valid summary
        raw = (
            "Some text {this is not json but has balanced braces} "
            f'more text {json.dumps(VALID_SUMMARY)}'
        )
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Architecture Discussion"

    def test_brace_scanning_all_candidates_invalid(self):
        """All balanced brace candidates are invalid JSON → falls to plain text."""
        svc, _, _ = _make_service()
        raw = "Text {not json} more {also not json} end"
        result = svc._parse_llm_response(raw)
        # Falls through to plain text parser
        assert "title" in result

    def test_empty_string_falls_to_plain_text(self):
        svc, _, _ = _make_service()
        result = svc._parse_llm_response("")
        assert "title" in result

    def test_whitespace_stripped(self):
        svc, _, _ = _make_service()
        raw = f"  \n  {json.dumps(VALID_SUMMARY)}  \n  "
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Architecture Discussion"


# ─── _normalize_summary_data ─────────────────────────────────────────────────


class TestNormalizeSummaryData:
    """Tests for _normalize_summary_data."""

    def test_happy_path(self):
        svc, _, _ = _make_service()
        result = svc._normalize_summary_data(VALID_SUMMARY, message_count=10)

        assert result["title"] == "Architecture Discussion"
        assert result["summary"] == VALID_SUMMARY["summary"]
        assert result["key_points"] == VALID_SUMMARY["key_points"]
        assert result["message_count"] == 10

    def test_missing_title_defaults(self):
        svc, _, _ = _make_service()
        result = svc._normalize_summary_data({}, message_count=5)
        assert result["title"] == "Untitled Conversation"

    def test_generic_titles_replaced(self):
        svc, _, _ = _make_service()
        for generic in ("Untitled", "Conversation", "Chat", "Summary"):
            result = svc._normalize_summary_data({"title": generic}, message_count=1)
            assert result["title"] == "Untitled Conversation"

    def test_title_truncated(self):
        svc, _, settings = _make_service()
        settings.summary_service.title_max_length = 10
        result = svc._normalize_summary_data({"title": "A" * 50}, message_count=1)
        assert len(result["title"]) == 10

    def test_key_points_non_list_wrapped(self):
        svc, _, _ = _make_service()
        result = svc._normalize_summary_data({"key_points": "single point"}, message_count=1)
        assert result["key_points"] == ["single point"]

    def test_key_points_empty_strings_filtered(self):
        svc, _, _ = _make_service()
        result = svc._normalize_summary_data({"key_points": ["valid", "", "  ", "also valid"]}, message_count=1)
        assert result["key_points"] == ["valid", "also valid"]

    def test_key_points_limited_to_max(self):
        svc, _, settings = _make_service()
        settings.summary_service.key_points_max = 2
        result = svc._normalize_summary_data(
            {"key_points": ["a", "b", "c", "d"]}, message_count=1
        )
        assert len(result["key_points"]) == 2

    def test_topics_non_list_wrapped(self):
        svc, _, _ = _make_service()
        result = svc._normalize_summary_data({"topics": "single topic"}, message_count=1)
        assert result["topics"] == ["single topic"]

    def test_topics_limited_to_10(self):
        svc, _, _ = _make_service()
        result = svc._normalize_summary_data(
            {"topics": [f"topic{i}" for i in range(15)]}, message_count=1
        )
        assert len(result["topics"]) == 10

    def test_entities_normalized(self):
        svc, _, _ = _make_service()
        result = svc._normalize_summary_data(
            {"entities": ["Alice", "gRPC"]}, message_count=1
        )
        assert result["entities"] == {"general": ["Alice", "gRPC"]}

    def test_summary_missing_returns_empty(self):
        svc, _, _ = _make_service()
        result = svc._normalize_summary_data({}, message_count=1)
        assert result["summary"] == ""


# ─── _normalize_entities ─────────────────────────────────────────────────────


class TestNormalizeEntities:
    """Tests for _normalize_entities."""

    def test_dict_passthrough(self):
        svc, _, _ = _make_service()
        raw = {"people": ["Alice", "Bob"], "technologies": ["Python"]}
        result = svc._normalize_entities(raw)
        assert result == raw

    def test_dict_filters_empty_values(self):
        svc, _, _ = _make_service()
        raw = {"people": ["Alice"], "empty": [], "blank": ["", "  "]}
        result = svc._normalize_entities(raw)
        assert "people" in result
        assert "empty" not in result
        assert "blank" not in result

    def test_flat_list_grouped_as_general(self):
        svc, _, _ = _make_service()
        raw = ["Alice", "gRPC", "Python"]
        result = svc._normalize_entities(raw)
        assert result == {"general": ["Alice", "gRPC", "Python"]}

    def test_empty_flat_list(self):
        svc, _, _ = _make_service()
        result = svc._normalize_entities([])
        assert result == {}

    def test_list_of_dicts_grouped_by_type(self):
        svc, _, _ = _make_service()
        raw = [
            {"name": "Alice", "type": "Person"},
            {"name": "Python", "type": "Technology"},
            {"name": "Bob", "type": "Person"},
        ]
        result = svc._normalize_entities(raw)
        assert result == {
            "person": ["Alice", "Bob"],
            "technology": ["Python"],
        }

    def test_list_of_dicts_missing_name_skipped(self):
        svc, _, _ = _make_service()
        raw = [
            {"name": "Alice", "type": "person"},
            {"name": "", "type": "person"},
            {"type": "person"},  # No name key → name=""
        ]
        result = svc._normalize_entities(raw)
        assert result == {"person": ["Alice"]}

    def test_list_of_dicts_missing_type_defaults_to_general(self):
        svc, _, _ = _make_service()
        raw = [{"name": "Alice"}]
        result = svc._normalize_entities(raw)
        assert result == {"general": ["Alice"]}

    def test_non_dict_non_list_returns_empty(self):
        svc, _, _ = _make_service()
        assert svc._normalize_entities("invalid") == {}
        assert svc._normalize_entities(42) == {}
        assert svc._normalize_entities(None) == {}

    def test_flat_list_with_empty_strings_filtered(self):
        svc, _, _ = _make_service()
        raw = ["Alice", "", "  ", "Bob"]
        result = svc._normalize_entities(raw)
        assert result == {"general": ["Alice", "Bob"]}

    def test_flat_list_all_empty_returns_empty(self):
        svc, _, _ = _make_service()
        raw = ["", "  "]
        result = svc._normalize_entities(raw)
        assert result == {}


# ─── _save_summary ───────────────────────────────────────────────────────────


class TestSaveSummary:
    """Tests for _save_summary (database persistence)."""

    async def test_happy_path(self):
        svc, gw, _ = _make_service()
        summary_data = {
            "title": "Test Summary",
            "summary": "Prose summary text.",
            "key_points": ["Point 1", "Point 2"],
            "entities": {"people": ["Alice"]},
            "topics": ["testing"],
            "message_count": 5,
        }

        # Mock ChatRepository.create_chat_summary
        with patch.object(svc._chat_repository, "create_chat_summary", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = {"id": SUMMARY_ID, **summary_data}
            result = await svc._save_summary(CHAT_ID, "full", summary_data)

        assert result["id"] == SUMMARY_ID
        mock_create.assert_awaited_once()
        call_kwargs = mock_create.call_args.kwargs

        assert call_kwargs["chat_id"] == CHAT_ID
        assert call_kwargs["summary_type"] == "full"
        assert call_kwargs["title"] == "Test Summary"
        assert "Point 1" in call_kwargs["summary_text"]
        assert "Point 2" in call_kwargs["summary_text"]
        assert call_kwargs["key_points"] == ["Point 1", "Point 2"]
        assert call_kwargs["llm_model"] == "test-model"
        assert call_kwargs["metadata"]["message_count"] == 5

    async def test_summary_text_built_from_prose_and_points(self):
        svc, _, _ = _make_service()
        summary_data = {
            "summary": "Overview paragraph.",
            "key_points": ["First", "Second"],
            "message_count": 3,
        }

        with patch.object(svc._chat_repository, "create_chat_summary", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = {"id": SUMMARY_ID}
            await svc._save_summary(CHAT_ID, "full", summary_data)

        call_kwargs = mock_create.call_args.kwargs
        summary_text = call_kwargs["summary_text"]
        assert "Overview paragraph." in summary_text
        assert "- First" in summary_text
        assert "- Second" in summary_text

    async def test_summary_text_fallback_when_empty(self):
        svc, _, _ = _make_service()
        summary_data = {"summary": "", "key_points": [], "message_count": 0}

        with patch.object(svc._chat_repository, "create_chat_summary", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = {"id": SUMMARY_ID}
            await svc._save_summary(CHAT_ID, "full", summary_data)

        call_kwargs = mock_create.call_args.kwargs
        assert call_kwargs["summary_text"] == "No summary available"

    async def test_entities_payload_includes_topics(self):
        svc, _, _ = _make_service()
        summary_data = {
            "entities": {"people": ["Alice"]},
            "topics": ["architecture"],
            "message_count": 1,
        }

        with patch.object(svc._chat_repository, "create_chat_summary", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = {"id": SUMMARY_ID}
            await svc._save_summary(CHAT_ID, "technical", summary_data)

        call_kwargs = mock_create.call_args.kwargs
        entities_payload = call_kwargs["entities"]
        assert entities_payload["entities"] == {"people": ["Alice"]}
        assert entities_payload["topics"] == ["architecture"]

    async def test_missing_optional_fields_default(self):
        svc, _, _ = _make_service()
        summary_data = {"message_count": 2}

        with patch.object(svc._chat_repository, "create_chat_summary", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = {"id": SUMMARY_ID}
            await svc._save_summary(CHAT_ID, "brief", summary_data)

        call_kwargs = mock_create.call_args.kwargs
        assert call_kwargs["key_points"] == []
        assert call_kwargs["entities"]["entities"] == {}
        assert call_kwargs["entities"]["topics"] == []
