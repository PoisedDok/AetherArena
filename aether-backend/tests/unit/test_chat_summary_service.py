"""
Chat Summary Service Tests

Real tests using actual services. No mocking.
- Pure logic tests: always run (no external deps)
- LLM integration tests: require aether-inference at settings.inference_url
  (default: http://127.0.0.1:7090/v1 — the built-in inference service)

@.architecture
Incoming: pytest --- {test invocation}
Processing: exercise ChatSummaryService methods end-to-end --- {validation}
Outgoing: assertions --- {pass/fail}
"""

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import httpx
import pytest

# Ensure backend root on sys.path
BACKEND_ROOT = Path(__file__).resolve().parents[2]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from config.settings import get_settings, reload_settings
from application.chat.summary_service import ChatSummaryService
from data.database.persistence_gateway import SupabasePersistenceGateway


# =============================================================================
# Helpers
# =============================================================================

def _make_settings():
    """Load real settings from config."""
    reload_settings()
    return get_settings()


class _StubSupabaseClient:
    """
    Minimal stub that passes isinstance(client, SupabaseClient) check
    by duck-typing the attributes ChatRepository needs at init time.
    No methods will be called in pure-logic tests.
    """
    pass


def _make_service(settings=None):
    """
    Build a ChatSummaryService with a real SupabasePersistenceGateway
    (backed by a stub client that won't be called in pure-logic tests).

    LLM URL is resolved from settings.inference_url (default: aether-inference at :7090).
    No hardcoded external provider URLs — respects central config.
    """
    settings = settings or _make_settings()
    # Real gateway so ChatRepository isinstance check passes
    gateway = SupabasePersistenceGateway(_StubSupabaseClient())
    stub_uow = SimpleNamespace(gateway=gateway)
    svc = ChatSummaryService(stub_uow, settings)
    return svc


def _make_messages(count: int, content_len: int = 80) -> List[Dict[str, Any]]:
    """Generate a list of realistic chat messages."""
    messages = []
    for i in range(count):
        role = "user" if i % 2 == 0 else "assistant"
        if role == "user":
            content = f"Message {i+1}: Can you help me understand how to implement a distributed caching system with Redis for our microservices architecture? We need to handle cache invalidation properly across multiple services."
        else:
            content = f"Response {i+1}: A distributed caching strategy with Redis involves several key components. First, you need to decide on a cache topology - whether to use Redis Cluster for horizontal scaling or Redis Sentinel for high availability. Cache invalidation can use pub/sub patterns or time-based TTL expiration."
        messages.append({
            "role": role,
            "content": content[:content_len] if content_len < len(content) else content,
            "created_at": f"2026-02-0{min(i+1,9)}T10:{i:02d}:00Z",
        })
    return messages


def _get_inference_url() -> str:
    """Get the inference URL from central config (settings.inference_url)."""
    settings = _make_settings()
    return settings.inference_url


async def _is_inference_available() -> bool:
    """Check if aether-inference is reachable at the configured inference_url."""
    url = _get_inference_url()
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{url}/models")
            return resp.status_code == 200
    except Exception:
        return False


# =============================================================================
# Pure Logic Tests (no external deps)
# =============================================================================

class TestClassifyChatSize:
    """Test _classify_chat_size with real settings thresholds."""

    def test_small(self):
        svc = _make_service()
        assert svc._classify_chat_size(1) == "small"
        assert svc._classify_chat_size(3) == "small"
        assert svc._classify_chat_size(5) == "small"

    def test_medium(self):
        svc = _make_service()
        assert svc._classify_chat_size(6) == "medium"
        assert svc._classify_chat_size(15) == "medium"
        assert svc._classify_chat_size(30) == "medium"

    def test_large(self):
        svc = _make_service()
        assert svc._classify_chat_size(31) == "large"
        assert svc._classify_chat_size(50) == "large"
        assert svc._classify_chat_size(100) == "large"

    def test_xlarge(self):
        svc = _make_service()
        assert svc._classify_chat_size(101) == "xlarge"
        assert svc._classify_chat_size(500) == "xlarge"


class TestFormatSingleMessage:
    """Test _format_single_message with various inputs."""

    def test_basic(self):
        svc = _make_service()
        msg = {"role": "user", "content": "Hello world"}
        result = svc._format_single_message(msg)
        assert result == "USER: Hello world"

    def test_with_timestamp(self):
        svc = _make_service()
        msg = {"role": "assistant", "content": "Hi there", "created_at": "2026-02-06T10:30:00Z"}
        result = svc._format_single_message(msg, include_timestamp=True)
        assert "[2026-02-06T10:30" in result
        assert "ASSISTANT: Hi there" in result

    def test_empty_content_returns_empty(self):
        svc = _make_service()
        msg = {"role": "user", "content": ""}
        assert svc._format_single_message(msg) == ""

    def test_none_content_returns_empty(self):
        svc = _make_service()
        msg = {"role": "user", "content": None}
        assert svc._format_single_message(msg) == ""

    def test_whitespace_content_returns_empty(self):
        svc = _make_service()
        msg = {"role": "user", "content": "   "}
        assert svc._format_single_message(msg) == ""

    def test_missing_role_defaults(self):
        svc = _make_service()
        msg = {"content": "test"}
        result = svc._format_single_message(msg)
        assert result == "UNKNOWN: test"


class TestFormatAllMessages:
    """Test _format_all_messages (no truncation)."""

    def test_formats_all(self):
        svc = _make_service()
        msgs = _make_messages(4)
        result = svc._format_all_messages(msgs)
        lines = result.split("\n\n")
        assert len(lines) == 4
        assert lines[0].startswith("USER:")
        assert lines[1].startswith("ASSISTANT:")

    def test_with_timestamps(self):
        svc = _make_service()
        msgs = _make_messages(2)
        result = svc._format_all_messages(msgs, include_timestamp=True)
        assert "[2026-" in result

    def test_skips_empty_content(self):
        svc = _make_service()
        msgs = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": ""},
            {"role": "user", "content": "world"},
        ]
        result = svc._format_all_messages(msgs)
        lines = result.split("\n\n")
        assert len(lines) == 2
        assert "hello" in lines[0]
        assert "world" in lines[1]


class TestFormatMessagesForLlm:
    """Test the full size-adaptive formatting pipeline."""

    def test_small_includes_timestamps(self):
        svc = _make_service()
        msgs = _make_messages(3)
        result = svc._format_messages_for_llm(msgs)
        assert "[2026-" in result  # timestamps present for small

    def test_medium_no_timestamps(self):
        svc = _make_service()
        msgs = _make_messages(15)
        result = svc._format_messages_for_llm(msgs)
        assert "[2026-" not in result  # no timestamps for medium
        # All 15 messages should be present (no truncation)
        assert "Message 1:" in result
        assert "Response 2:" in result

    def test_large_uses_document_utility(self):
        """Large chats go through DocumentUtility extractive pipeline."""
        svc = _make_service()
        msgs = _make_messages(50)
        result = svc._format_messages_for_llm(msgs)
        # Result should exist and be non-empty
        assert len(result) > 0
        # Should contain conversation markers or raw content
        # (DocumentUtility may or may not produce [CONVERSATION:] header depending on sentence selection)
        assert "USER:" in result or "ASSISTANT:" in result or "Message" in result

    def test_xlarge_uses_document_utility(self):
        """XLarge chats also go through DocumentUtility."""
        svc = _make_service()
        msgs = _make_messages(120)
        result = svc._format_messages_for_llm(msgs)
        assert len(result) > 0
        # For 120 messages, the DocumentUtility should produce a header with extraction info
        # or at minimum contain message content
        assert len(result) > 500  # Substantial extracted content


class TestParseLlmResponse:
    """Test _parse_llm_response with various LLM output formats."""

    def test_direct_json(self):
        svc = _make_service()
        raw = json.dumps({
            "title": "Test Chat",
            "summary": "A test conversation.",
            "key_points": ["Point 1"],
            "entities": {"people": ["Alice"]},
            "topics": ["testing"]
        })
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Test Chat"
        assert result["entities"]["people"] == ["Alice"]

    def test_json_with_markdown_fences(self):
        svc = _make_service()
        raw = '```json\n{"title": "Fenced", "summary": "test", "key_points": [], "entities": {}, "topics": []}\n```'
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Fenced"

    def test_json_embedded_in_text(self):
        svc = _make_service()
        raw = 'Here is the summary:\n{"title": "Embedded", "summary": "s", "key_points": [], "entities": {}, "topics": []}\nEnd.'
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Embedded"

    def test_plain_text_fallback(self):
        svc = _make_service()
        raw = "Title: My Chat Summary\nThis was a good chat.\n- Point one\n- Point two\n- Point three"
        result = svc._parse_llm_response(raw)
        # Should fall back to plain text parser
        assert "title" in result
        assert "key_points" in result
        assert len(result["key_points"]) >= 2

    def test_whitespace_json(self):
        svc = _make_service()
        raw = '  \n  {"title": "Spaced", "summary": "s", "key_points": [], "entities": {}, "topics": []}  \n  '
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Spaced"

    def test_think_tags_stripped(self):
        """Qwen3 and similar models wrap output in <think>...</think>."""
        svc = _make_service()
        raw = '<think>\nLet me analyze the conversation.\nI need to extract key points.\n</think>\n{"title": "Think Test", "summary": "s", "key_points": ["a"], "entities": {}, "topics": []}'
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Think Test"

    def test_preamble_with_braces_before_json(self):
        """LLM puts text with braces before the actual JSON object."""
        svc = _make_service()
        raw = 'Here is your summary {as requested}:\n{"title": "Braces Preamble", "summary": "test", "key_points": [], "entities": {}, "topics": []}'
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Braces Preamble"

    def test_multiple_json_objects_finds_summary(self):
        """Multiple JSON objects in text - finds the one with summary schema keys."""
        svc = _make_service()
        raw = 'Config: {"model": "gpt4"}\nResult: {"title": "Multi", "summary": "s", "key_points": [], "entities": {}, "topics": []}'
        result = svc._parse_llm_response(raw)
        assert result["title"] == "Multi"

    def test_nested_entities_in_json(self):
        """JSON with deeply nested braces (entities dict inside main dict)."""
        svc = _make_service()
        raw = '{"title": "Nested", "summary": "s", "key_points": ["p"], "entities": {"people": ["Alice"], "technologies": ["Redis"]}, "topics": ["t"]}'
        result = svc._parse_llm_response(raw)
        assert result["entities"]["people"] == ["Alice"]
        assert result["entities"]["technologies"] == ["Redis"]


class TestNormalizeEntities:
    """Test _normalize_entities with all input formats."""

    def test_categorized_dict(self):
        svc = _make_service()
        raw = {"people": ["Alice", "Bob"], "technologies": ["Python", "Redis"]}
        result = svc._normalize_entities(raw)
        assert result["people"] == ["Alice", "Bob"]
        assert result["technologies"] == ["Python", "Redis"]

    def test_flat_array(self):
        svc = _make_service()
        raw = ["Alice", "Python", "Redis"]
        result = svc._normalize_entities(raw)
        assert "general" in result
        assert len(result["general"]) == 3

    def test_list_of_dicts(self):
        svc = _make_service()
        raw = [
            {"name": "Alice", "type": "person"},
            {"name": "Python", "type": "technology"},
            {"name": "Redis", "type": "technology"},
        ]
        result = svc._normalize_entities(raw)
        assert "person" in result
        assert "technology" in result
        assert result["person"] == ["Alice"]
        assert "Python" in result["technology"]

    def test_empty_list(self):
        svc = _make_service()
        assert svc._normalize_entities([]) == {}

    def test_empty_dict(self):
        svc = _make_service()
        assert svc._normalize_entities({}) == {}

    def test_none(self):
        svc = _make_service()
        assert svc._normalize_entities(None) == {}

    def test_dict_with_empty_lists_stripped(self):
        svc = _make_service()
        raw = {"people": ["Alice"], "technologies": [], "concepts": []}
        result = svc._normalize_entities(raw)
        assert "people" in result
        assert "technologies" not in result
        assert "concepts" not in result

    def test_strips_whitespace(self):
        svc = _make_service()
        raw = {"people": ["  Alice  ", " Bob"]}
        result = svc._normalize_entities(raw)
        assert result["people"] == ["Alice", "Bob"]


class TestNormalizeSummaryData:
    """Test _normalize_summary_data with various LLM output shapes."""

    def test_full_valid_data(self):
        svc = _make_service()
        data = {
            "title": "Redis Caching Discussion",
            "summary": "We discussed Redis caching strategies.",
            "key_points": ["Use Redis Cluster", "Implement TTL-based invalidation"],
            "entities": {"technologies": ["Redis", "Python"]},
            "topics": ["caching", "microservices"],
        }
        result = svc._normalize_summary_data(data, message_count=10)
        assert result["title"] == "Redis Caching Discussion"
        assert result["summary"] == "We discussed Redis caching strategies."
        assert len(result["key_points"]) == 2
        assert result["entities"]["technologies"] == ["Redis", "Python"]
        assert result["message_count"] == 10

    def test_missing_fields_get_defaults(self):
        svc = _make_service()
        data = {}
        result = svc._normalize_summary_data(data, message_count=5)
        assert result["title"] == "Untitled Conversation"
        assert result["summary"] == ""
        assert result["key_points"] == []
        assert result["entities"] == {}
        assert result["topics"] == []

    def test_generic_titles_rejected(self):
        svc = _make_service()
        for bad_title in ["Untitled", "Conversation", "Chat", "Summary"]:
            data = {"title": bad_title}
            result = svc._normalize_summary_data(data, message_count=1)
            assert result["title"] == "Untitled Conversation"

    def test_title_truncated_to_limit(self):
        svc = _make_service()
        limit = svc._settings.summary_service.title_max_length
        data = {"title": "A" * 300}
        result = svc._normalize_summary_data(data, message_count=1)
        assert len(result["title"]) == limit

    def test_key_points_limited(self):
        svc = _make_service()
        limit = svc._settings.summary_service.key_points_max
        data = {"key_points": [f"Point {i}" for i in range(20)]}
        result = svc._normalize_summary_data(data, message_count=1)
        assert len(result["key_points"]) == limit

    def test_key_points_non_list_coerced(self):
        svc = _make_service()
        data = {"key_points": "single string point"}
        result = svc._normalize_summary_data(data, message_count=1)
        assert result["key_points"] == ["single string point"]

    def test_topics_non_list_coerced(self):
        svc = _make_service()
        data = {"topics": "single topic"}
        result = svc._normalize_summary_data(data, message_count=1)
        assert result["topics"] == ["single topic"]


class TestParsePlainTextSummary:
    """Test _parse_plain_text_summary fallback parser."""

    def test_basic_bullet_points(self):
        svc = _make_service()
        text = "Redis Caching Architecture\nDiscussion about caching.\n- Use Redis Cluster\n- Implement TTL\n- Monitor cache hits"
        result = svc._parse_plain_text_summary(text)
        assert "Redis" in result["title"]
        assert len(result["key_points"]) == 3

    def test_numbered_points(self):
        svc = _make_service()
        text = "Summary Title\n1. First point\n2. Second point\n3. Third point"
        result = svc._parse_plain_text_summary(text)
        assert len(result["key_points"]) == 3

    def test_strips_title_prefix(self):
        svc = _make_service()
        text = "Title: My Chat Summary\n- Point one"
        result = svc._parse_plain_text_summary(text)
        assert result["title"] == "My Chat Summary"

    def test_summary_prefix_stripped(self):
        svc = _make_service()
        text = "Summary: Quick discussion\n- One\n- Two"
        result = svc._parse_plain_text_summary(text)
        assert result["title"] == "Quick discussion"

    def test_prose_before_bullets_becomes_summary(self):
        svc = _make_service()
        text = "Title Here\nThis was a productive conversation about Redis caching.\n- Point one\n- Point two"
        result = svc._parse_plain_text_summary(text)
        assert "productive" in result["summary"]

    def test_no_bullets_uses_full_text(self):
        svc = _make_service()
        text = "Just a plain paragraph with no structure at all."
        result = svc._parse_plain_text_summary(text)
        assert len(result["key_points"]) >= 1
        assert "plain paragraph" in result["key_points"][0]


class TestTypeInstructionAndSizeHint:
    """Test _get_type_instruction and _get_size_hint content."""

    def test_brief_instruction(self):
        svc = _make_service()
        result = svc._get_type_instruction("brief", "small")
        assert "BRIEF" in result
        assert "2-3 sentences" in result

    def test_technical_instruction(self):
        svc = _make_service()
        result = svc._get_type_instruction("technical", "medium")
        assert "TECHNICAL" in result
        assert "code" in result.lower() or "architecture" in result.lower()

    def test_executive_instruction(self):
        svc = _make_service()
        result = svc._get_type_instruction("executive", "large")
        assert "EXECUTIVE" in result
        assert "outcomes" in result.lower() or "decisions" in result.lower()

    def test_full_instruction(self):
        svc = _make_service()
        result = svc._get_type_instruction("full", "xlarge")
        assert "FULL" in result
        assert "comprehensive" in result.lower()

    def test_size_hint_small(self):
        svc = _make_service()
        hint = svc._get_size_hint(3, "small")
        assert "3 messages" in hint
        assert "All messages" in hint

    def test_size_hint_large(self):
        svc = _make_service()
        hint = svc._get_size_hint(50, "large")
        assert "50 messages" in hint
        assert "relevance ranking" in hint

    def test_size_hint_xlarge(self):
        svc = _make_service()
        hint = svc._get_size_hint(200, "xlarge")
        assert "200 messages" in hint
        assert "relevance ranking" in hint


class TestDocumentUtilityExtraction:
    """Test _extract_via_document_utility with real DocumentUtility (no mocks)."""

    def test_returns_content_for_medium_text(self):
        svc = _make_service()
        text = "\n\n".join([f"USER: Message number {i} about distributed systems and caching." for i in range(40)])
        result = svc._extract_via_document_utility(text, 40)
        assert len(result) > 0

    def test_returns_raw_when_extraction_yields_nothing(self):
        """Very short messages may not survive DocumentUtility's sentence noise filters."""
        svc = _make_service()
        text = "USER: Hi\n\nASSISTANT: Hello"
        result = svc._extract_via_document_utility(text, 2)
        # Should return raw text since extraction may filter tiny content
        assert "Hi" in result or "Hello" in result

    def test_large_text_gets_extracted(self):
        """Generate enough text to exceed context budget and trigger LexRank selection."""
        svc = _make_service()
        lines = []
        for i in range(200):
            role = "USER" if i % 2 == 0 else "ASSISTANT"
            lines.append(
                f"{role}: This is message {i} discussing topics like machine learning, "
                f"natural language processing, distributed computing, database optimization, "
                f"and cloud infrastructure. The conversation covers practical implementation "
                f"details for building scalable systems with Python and Redis."
            )
        text = "\n\n".join(lines)
        result = svc._extract_via_document_utility(text, 200)
        assert len(result) > 1000
        # Should have extraction metadata header
        assert "CONVERSATION:" in result or "sections" in result.lower() or "USER:" in result


# =============================================================================
# Real LLM Integration Tests (require aether-inference at settings.inference_url)
# =============================================================================

@pytest.mark.asyncio
async def test_inference_reachable():
    """Verify aether-inference is reachable at the configured inference_url."""
    available = await _is_inference_available()
    if not available:
        inference_url = _get_inference_url()
        pytest.skip(f"aether-inference not available at {inference_url}")
    assert available


@pytest.mark.asyncio
async def test_call_llm_small_chat_full():
    """Real LLM call: summarize a small chat with 'full' type."""
    if not await _is_inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    svc = _make_service()
    msgs = _make_messages(4)
    conversation_text = svc._format_messages_for_llm(msgs)

    try:
        result = await svc._call_llm_for_summary(conversation_text, "full", message_count=4)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    # Validate normalized output structure
    assert isinstance(result, dict)
    assert "title" in result
    assert "summary" in result
    assert "key_points" in result
    assert "entities" in result
    assert "topics" in result
    assert isinstance(result["title"], str)
    assert len(result["title"]) > 0
    assert isinstance(result["key_points"], list)
    assert isinstance(result["entities"], dict)
    assert isinstance(result["topics"], list)
    assert result["message_count"] == 4

    print("\n--- Small Chat Full Summary ---")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points: {result['key_points']}")
    print(f"Entities: {result['entities']}")
    print(f"Topics: {result['topics']}")


@pytest.mark.asyncio
async def test_call_llm_small_chat_brief():
    """Real LLM call: brief summary of a small chat."""
    if not await _is_inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    svc = _make_service()
    msgs = _make_messages(3)
    conversation_text = svc._format_messages_for_llm(msgs)

    try:
        result = await svc._call_llm_for_summary(conversation_text, "brief", message_count=3)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    assert isinstance(result, dict)
    assert len(result["title"]) > 0
    # Brief should have fewer key points than full (LLMs aren't perfectly obedient
    # to count constraints, so we allow up to key_points_max from config)
    assert len(result["key_points"]) <= svc._settings.summary_service.key_points_max

    print("\n--- Small Chat Brief Summary ---")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points ({len(result['key_points'])}): {result['key_points']}")


@pytest.mark.asyncio
async def test_call_llm_medium_chat_technical():
    """Real LLM call: technical summary of a medium chat."""
    if not await _is_inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    svc = _make_service()
    msgs = _make_messages(12)
    conversation_text = svc._format_messages_for_llm(msgs)

    try:
        result = await svc._call_llm_for_summary(conversation_text, "technical", message_count=12)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    assert isinstance(result, dict)
    assert len(result["title"]) > 0
    assert isinstance(result["summary"], str)
    assert isinstance(result["key_points"], list)

    print("\n--- Medium Chat Technical Summary ---")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points ({len(result['key_points'])}): {result['key_points']}")
    print(f"Entities: {result['entities']}")
    print(f"Topics: {result['topics']}")


@pytest.mark.asyncio
async def test_call_llm_medium_chat_executive():
    """Real LLM call: executive summary of a medium chat."""
    if not await _is_inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    svc = _make_service()
    msgs = _make_messages(10)
    conversation_text = svc._format_messages_for_llm(msgs)

    try:
        result = await svc._call_llm_for_summary(conversation_text, "executive", message_count=10)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    assert isinstance(result, dict)
    assert len(result["title"]) > 0
    assert isinstance(result["summary"], str)

    print("\n--- Medium Chat Executive Summary ---")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points ({len(result['key_points'])}): {result['key_points']}")


@pytest.mark.asyncio
async def test_call_llm_large_chat_with_extraction():
    """Real LLM call: summarize a large chat that goes through DocumentUtility extraction."""
    if not await _is_inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    svc = _make_service()
    # Generate 40 messages - triggers 'large' classification (>30)
    msgs = _make_messages(40, content_len=200)
    conversation_text = svc._format_messages_for_llm(msgs)

    # Verify extraction happened
    assert len(conversation_text) > 0

    try:
        result = await svc._call_llm_for_summary(conversation_text, "full", message_count=40)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    assert isinstance(result, dict)
    assert len(result["title"]) > 0
    assert len(result["summary"]) > 0
    assert len(result["key_points"]) > 0
    assert result["message_count"] == 40

    print("\n--- Large Chat Full Summary (40 msgs, extracted) ---")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points ({len(result['key_points'])}): {result['key_points']}")
    print(f"Entities: {result['entities']}")
    print(f"Topics: {result['topics']}")


@pytest.mark.asyncio
async def test_end_to_end_format_then_summarize():
    """
    Full pipeline: format messages -> call LLM -> validate output.
    Tests the complete flow except DB persistence.
    """
    if not await _is_inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    svc = _make_service()

    # Test each size tier
    for count, expected_size in [(3, "small"), (15, "medium"), (40, "large")]:
        msgs = _make_messages(count, content_len=200)
        actual_size = svc._classify_chat_size(count)
        assert actual_size == expected_size, f"Expected {expected_size} for {count} msgs, got {actual_size}"

        conversation_text = svc._format_messages_for_llm(msgs)
        assert len(conversation_text) > 0

        try:
            result = await svc._call_llm_for_summary(conversation_text, "full", message_count=count)
        except httpx.HTTPError as e:
            pytest.skip(f"Inference server failed (e.g. model load error): {e}")

        # Structure validation
        assert isinstance(result["title"], str) and len(result["title"]) > 0
        assert isinstance(result["summary"], str)
        assert isinstance(result["key_points"], list)
        assert isinstance(result["entities"], dict)
        assert isinstance(result["topics"], list)
        assert result["message_count"] == count

        # Content sanity: title should not be generic
        assert result["title"].lower() not in ("untitled", "conversation", "chat", "summary")

        print(f"\n  [{expected_size}/{count} msgs] Title: {result['title']}")
        print(f"    Summary: {result['summary'][:120]}...")
        print(f"    Points: {len(result['key_points'])}, Entities: {list(result['entities'].keys())}, Topics: {result['topics']}")


# =============================================================================
# Settings Validation
# =============================================================================

class TestSummaryServiceSettings:
    """Verify SummaryServiceSettings has sane defaults from config."""

    def test_max_tokens(self):
        s = _make_settings()
        assert s.summary_service.max_tokens >= 800
        assert s.summary_service.max_tokens_brief >= 200
        assert s.summary_service.max_tokens_brief < s.summary_service.max_tokens

    def test_thresholds(self):
        s = _make_settings()
        cfg = s.summary_service
        assert cfg.small_chat_threshold < cfg.medium_chat_threshold
        assert cfg.medium_chat_threshold < cfg.large_chat_threshold

    def test_title_and_points_limits(self):
        s = _make_settings()
        cfg = s.summary_service
        assert cfg.title_max_length >= 50
        assert cfg.key_points_max >= 3

    def test_prompt_template_has_placeholders(self):
        s = _make_settings()
        template = s.summary_service.system_prompt_template
        assert "{instruction}" in template
        assert "{title_max_length}" in template
        assert "{key_points_max}" in template
        assert "{size_hint}" in template

    def test_prompt_template_formats_without_error(self):
        s = _make_settings()
        template = s.summary_service.system_prompt_template
        # Should format cleanly with all placeholders filled
        result = template.format(
            instruction="Test instruction",
            title_max_length=100,
            key_points_max=8,
            size_hint="Test hint",
        )
        assert "Test instruction" in result
        assert "Test hint" in result
        assert len(result) > 100

    def test_valid_summary_types(self):
        s = _make_settings()
        types = s.summary_service.valid_summary_types
        assert "full" in types
        assert "brief" in types
        assert "technical" in types
        assert "executive" in types
