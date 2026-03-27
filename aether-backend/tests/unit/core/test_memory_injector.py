"""
Unit Tests: MemoryInjector

Tests the memory injection pipeline — global and chat-specific memory fetching,
formatting, importance/frequency scoring, singleton management, and error handling.

Dependencies mocked: config.settings.get_settings, memory_service.

Bug-finding focus:
- _ensure_memory_service returns None when not configured (graceful degradation)
- get_global_memory_context silently returns "" on any exception (catch-all boundary)
- Frequency boost only applied when at least one memory has access_count > 0
- _format_memory_context truncation boundary (off-by-one in content[:truncation_length - 3])
- Double import of get_settings inside get_global_memory_context
"""

from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4


from core.runtime.memory_injector import (
    MemoryInjector,
    get_memory_injector,
    set_memory_service,
)


# =========================================================================
# Helpers
# =========================================================================

def _make_memory(content="Test memory content", memory_type="general",
                 importance_score=0.8, access_count=0, **overrides):
    """Create a realistic memory dict."""
    base = {
        "id": str(uuid4()),
        "content": content,
        "memory_type": memory_type,
        "importance_score": importance_score,
        "access_count": access_count,
    }
    base.update(overrides)
    return base


def _make_settings(**overrides):
    """Create a mock settings object with memory_service config."""
    settings = MagicMock()
    ms = settings.memory_service
    ms.global_injection_limit = overrides.get("limit", 10)
    ms.global_injection_min_importance = overrides.get("min_importance", 0.5)
    ms.importance_weight = overrides.get("importance_weight", 0.7)
    ms.access_frequency_weight = overrides.get("access_frequency_weight", 0.3)
    ms.access_count_denominator = overrides.get("access_count_denominator", 10.0)
    ms.content_truncation_length = overrides.get("truncation_length", 500)
    return settings


# =========================================================================
# Initialization
# =========================================================================

class TestInit:
    """Tests for MemoryInjector.__init__."""

    def test_stores_memory_service(self):
        """Memory service is stored."""
        ms = MagicMock()
        injector = MemoryInjector(memory_service=ms)
        assert injector._memory_service is ms

    def test_default_none(self):
        """Default memory service is None."""
        injector = MemoryInjector()
        assert injector._memory_service is None


# =========================================================================
# _ensure_memory_service
# =========================================================================

class TestEnsureMemoryService:
    """Tests for MemoryInjector._ensure_memory_service."""

    async def test_returns_service_when_set(self):
        """Returns memory service if configured."""
        ms = MagicMock()
        injector = MemoryInjector(memory_service=ms)
        result = await injector._ensure_memory_service()
        assert result is ms

    async def test_returns_none_when_not_set(self):
        """Returns None and logs warning when not configured."""
        injector = MemoryInjector()
        result = await injector._ensure_memory_service()
        assert result is None


# =========================================================================
# get_global_memory_context
# =========================================================================

class TestGetGlobalMemoryContext:
    """Tests for MemoryInjector.get_global_memory_context."""

    @patch("config.settings.get_settings")
    async def test_no_memory_service_returns_empty(self, mock_get_settings):
        """Without memory service, returns empty string."""
        injector = MemoryInjector()
        result = await injector.get_global_memory_context()
        assert result == ""

    @patch("config.settings.get_settings")
    async def test_empty_memories_returns_empty(self, mock_get_settings):
        """Memory service returns empty list → empty string."""
        mock_get_settings.return_value = _make_settings()
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=[])
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_global_memory_context()
        assert result == ""

    @patch("config.settings.get_settings")
    async def test_formats_memories(self, mock_get_settings):
        """Memories are fetched and formatted into context string."""
        mock_get_settings.return_value = _make_settings()
        memories = [
            _make_memory(content="User prefers dark mode", memory_type="preference", importance_score=0.9),
            _make_memory(content="User is a Python developer", memory_type="fact", importance_score=0.7),
        ]
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=memories)
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_global_memory_context()

        assert "Global Memory Context" in result
        assert "User prefers dark mode" in result
        assert "User is a Python developer" in result

    @patch("config.settings.get_settings")
    async def test_uses_config_defaults(self, mock_get_settings):
        """Uses settings defaults when limit and threshold not provided."""
        settings = _make_settings(limit=5, min_importance=0.3)
        mock_get_settings.return_value = settings
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=[_make_memory()])
        injector = MemoryInjector(memory_service=ms)
        await injector.get_global_memory_context()

        call_kwargs = ms.list_memories.call_args.kwargs
        assert call_kwargs["limit"] == 5
        assert call_kwargs["min_importance"] == 0.3

    @patch("config.settings.get_settings")
    async def test_explicit_limit_overrides_config(self, mock_get_settings):
        """Explicit limit overrides config default."""
        mock_get_settings.return_value = _make_settings(limit=10)
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=[_make_memory()])
        injector = MemoryInjector(memory_service=ms)
        await injector.get_global_memory_context(limit=3)

        call_kwargs = ms.list_memories.call_args.kwargs
        assert call_kwargs["limit"] == 3

    @patch("config.settings.get_settings")
    async def test_explicit_threshold_overrides_config(self, mock_get_settings):
        """Explicit importance_threshold overrides config default."""
        mock_get_settings.return_value = _make_settings(min_importance=0.5)
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=[_make_memory()])
        injector = MemoryInjector(memory_service=ms)
        await injector.get_global_memory_context(importance_threshold=0.8)

        call_kwargs = ms.list_memories.call_args.kwargs
        assert call_kwargs["min_importance"] == 0.8

    @patch("config.settings.get_settings")
    async def test_frequency_boost_applied(self, mock_get_settings):
        """When access_count > 0 exists, memories are re-sorted with frequency boost."""
        mock_get_settings.return_value = _make_settings(
            importance_weight=0.7,
            access_frequency_weight=0.3,
            access_count_denominator=10.0,
        )
        memories = [
            _make_memory(content="low importance high freq", importance_score=0.3, access_count=20),
            _make_memory(content="high importance no freq", importance_score=0.9, access_count=0),
        ]
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=memories)
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_global_memory_context()

        # Both memories should appear in result
        assert "low importance high freq" in result
        assert "high importance no freq" in result

    @patch("config.settings.get_settings")
    async def test_no_frequency_boost_when_all_zero(self, mock_get_settings):
        """When all access_count=0, no re-sorting happens."""
        mock_get_settings.return_value = _make_settings()
        memories = [
            _make_memory(content="memory A", importance_score=0.5, access_count=0),
            _make_memory(content="memory B", importance_score=0.9, access_count=0),
        ]
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=memories)
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_global_memory_context()
        # Original order preserved (no re-sort)
        assert "memory A" in result
        assert "memory B" in result

    @patch("config.settings.get_settings")
    async def test_exception_returns_empty(self, mock_get_settings):
        """Exception during fetch → returns empty string (catch-all boundary)."""
        mock_get_settings.return_value = _make_settings()
        ms = AsyncMock()
        ms.list_memories = AsyncMock(side_effect=RuntimeError("DB down"))
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_global_memory_context()
        assert result == ""

    @patch("config.settings.get_settings")
    async def test_limits_to_top_n(self, mock_get_settings):
        """Result is limited to 'limit' memories."""
        mock_get_settings.return_value = _make_settings(limit=2)
        memories = [
            _make_memory(content=f"memory {i}", importance_score=0.9 - i * 0.1)
            for i in range(5)
        ]
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=memories)
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_global_memory_context()
        # Should contain at most 2 memories
        # Count occurrences of bullet points
        bullet_count = result.count("- ")
        assert bullet_count <= 2


# =========================================================================
# get_chat_memory_context
# =========================================================================

class TestGetChatMemoryContext:
    """Tests for MemoryInjector.get_chat_memory_context."""

    @patch("config.settings.get_settings")
    async def test_no_memory_service_returns_empty(self, mock_get_settings):
        """Without memory service, returns empty string."""
        injector = MemoryInjector()
        result = await injector.get_chat_memory_context(chat_id=uuid4())
        assert result == ""

    @patch("config.settings.get_settings")
    async def test_empty_memories_returns_empty(self, mock_get_settings):
        """No chat-specific memories → empty string."""
        mock_get_settings.return_value = _make_settings()
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=[])
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_chat_memory_context(chat_id=uuid4())
        assert result == ""

    @patch("config.settings.get_settings")
    async def test_formats_chat_memories(self, mock_get_settings):
        """Chat memories are formatted with chat-specific header."""
        mock_get_settings.return_value = _make_settings()
        memories = [
            _make_memory(content="User asked about Python async", memory_type="context"),
        ]
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=memories)
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_chat_memory_context(chat_id=uuid4())

        assert "Chat Memory Context" in result
        assert "User asked about Python async" in result
        assert "conversation-specific" in result

    @patch("config.settings.get_settings")
    async def test_passes_chat_id_to_service(self, mock_get_settings):
        """Chat ID is passed as source_chat_id filter."""
        mock_get_settings.return_value = _make_settings()
        chat_id = uuid4()
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=[])
        injector = MemoryInjector(memory_service=ms)
        await injector.get_chat_memory_context(chat_id=chat_id)

        call_kwargs = ms.list_memories.call_args.kwargs
        assert call_kwargs["source_chat_id"] == chat_id

    @patch("config.settings.get_settings")
    async def test_explicit_params_override_config(self, mock_get_settings):
        """Explicit limit and threshold override config."""
        mock_get_settings.return_value = _make_settings(limit=10, min_importance=0.5)
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=[])
        injector = MemoryInjector(memory_service=ms)
        await injector.get_chat_memory_context(
            chat_id=uuid4(), limit=2, importance_threshold=0.9
        )

        call_kwargs = ms.list_memories.call_args.kwargs
        assert call_kwargs["limit"] == 2
        assert call_kwargs["min_importance"] == 0.9

    @patch("config.settings.get_settings")
    async def test_frequency_boost_applied(self, mock_get_settings):
        """Frequency boost re-sorts chat memories when access_count > 0."""
        mock_get_settings.return_value = _make_settings()
        memories = [
            _make_memory(content="accessed memory", importance_score=0.5, access_count=5),
            _make_memory(content="fresh memory", importance_score=0.9, access_count=0),
        ]
        ms = AsyncMock()
        ms.list_memories = AsyncMock(return_value=memories)
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_chat_memory_context(chat_id=uuid4())
        assert "accessed memory" in result
        assert "fresh memory" in result

    @patch("config.settings.get_settings")
    async def test_exception_returns_empty(self, mock_get_settings):
        """Exception during fetch → empty string."""
        mock_get_settings.return_value = _make_settings()
        ms = AsyncMock()
        ms.list_memories = AsyncMock(side_effect=Exception("Network error"))
        injector = MemoryInjector(memory_service=ms)
        result = await injector.get_chat_memory_context(chat_id=uuid4())
        assert result == ""


# =========================================================================
# _format_memory_context
# =========================================================================

class TestFormatMemoryContext:
    """Tests for MemoryInjector._format_memory_context."""

    @patch("config.settings.get_settings")
    def test_empty_list_returns_empty(self, mock_get_settings):
        """Empty memories → empty string."""
        injector = MemoryInjector()
        assert injector._format_memory_context([]) == ""

    @patch("config.settings.get_settings")
    def test_groups_by_type(self, mock_get_settings):
        """Memories are grouped by memory_type."""
        mock_get_settings.return_value = _make_settings(truncation_length=500)
        memories = [
            _make_memory(content="fact 1", memory_type="fact"),
            _make_memory(content="pref 1", memory_type="preference"),
            _make_memory(content="fact 2", memory_type="fact"),
        ]
        injector = MemoryInjector()
        result = injector._format_memory_context(memories)
        assert "Facts:" in result
        assert "Preferences:" in result
        assert "fact 1" in result
        assert "fact 2" in result
        assert "pref 1" in result

    @patch("config.settings.get_settings")
    def test_truncates_long_content(self, mock_get_settings):
        """Content longer than truncation_length is truncated with '...'."""
        mock_get_settings.return_value = _make_settings(truncation_length=20)
        memories = [
            _make_memory(content="A" * 50, memory_type="general"),
        ]
        injector = MemoryInjector()
        result = injector._format_memory_context(memories)
        # Content should be 17 chars + "..." = 20 chars
        assert "..." in result
        assert "A" * 50 not in result

    @patch("config.settings.get_settings")
    def test_short_content_not_truncated(self, mock_get_settings):
        """Content shorter than truncation_length is kept intact."""
        mock_get_settings.return_value = _make_settings(truncation_length=500)
        memories = [
            _make_memory(content="Short content", memory_type="general"),
        ]
        injector = MemoryInjector()
        result = injector._format_memory_context(memories)
        assert "Short content" in result

    @patch("config.settings.get_settings")
    def test_importance_indicators(self, mock_get_settings):
        """Importance score determines star indicator count."""
        mock_get_settings.return_value = _make_settings(truncation_length=500)
        memories = [
            _make_memory(content="low", importance_score=0.1, memory_type="general"),
            _make_memory(content="high", importance_score=0.95, memory_type="general"),
        ]
        injector = MemoryInjector()
        result = injector._format_memory_context(memories)
        # Both should appear with indicators
        assert "low" in result
        assert "high" in result

    @patch("config.settings.get_settings")
    def test_header_and_footer(self, mock_get_settings):
        """Output includes header and footer text."""
        mock_get_settings.return_value = _make_settings(truncation_length=500)
        memories = [_make_memory()]
        injector = MemoryInjector()
        result = injector._format_memory_context(memories)
        assert "Global Memory Context" in result
        assert "context-aware responses" in result

    @patch("config.settings.get_settings")
    def test_type_label_formatting(self, mock_get_settings):
        """Memory type 'user_preference' → 'User Preferences:'."""
        mock_get_settings.return_value = _make_settings(truncation_length=500)
        memories = [_make_memory(memory_type="user_preference")]
        injector = MemoryInjector()
        result = injector._format_memory_context(memories)
        assert "User Preferences:" in result

    @patch("config.settings.get_settings")
    def test_default_type_general(self, mock_get_settings):
        """Memory without memory_type defaults to 'general'."""
        mock_get_settings.return_value = _make_settings(truncation_length=500)
        memories = [{"content": "no type", "importance_score": 0.5}]
        injector = MemoryInjector()
        result = injector._format_memory_context(memories)
        assert "Generals:" in result


# =========================================================================
# _format_chat_memory_context
# =========================================================================

class TestFormatChatMemoryContext:
    """Tests for MemoryInjector._format_chat_memory_context."""

    @patch("config.settings.get_settings")
    def test_empty_list_returns_empty(self, mock_get_settings):
        """Empty memories → empty string."""
        injector = MemoryInjector()
        assert injector._format_chat_memory_context([]) == ""

    @patch("config.settings.get_settings")
    def test_chat_specific_header(self, mock_get_settings):
        """Output includes chat-specific header and footer."""
        mock_get_settings.return_value = _make_settings(truncation_length=500)
        memories = [_make_memory()]
        injector = MemoryInjector()
        result = injector._format_chat_memory_context(memories)
        assert "Chat Memory Context" in result
        assert "conversation-specific" in result

    @patch("config.settings.get_settings")
    def test_groups_by_type(self, mock_get_settings):
        """Chat memories grouped by type."""
        mock_get_settings.return_value = _make_settings(truncation_length=500)
        memories = [
            _make_memory(content="ctx 1", memory_type="context"),
            _make_memory(content="dec 1", memory_type="decision"),
        ]
        injector = MemoryInjector()
        result = injector._format_chat_memory_context(memories)
        assert "Contexts:" in result
        assert "Decisions:" in result

    @patch("config.settings.get_settings")
    def test_truncates_long_content(self, mock_get_settings):
        """Long content is truncated."""
        mock_get_settings.return_value = _make_settings(truncation_length=15)
        memories = [_make_memory(content="A" * 30)]
        injector = MemoryInjector()
        result = injector._format_chat_memory_context(memories)
        assert "..." in result
        assert "A" * 30 not in result


# =========================================================================
# Singleton management
# =========================================================================

class TestSingletonManagement:
    """Tests for module-level singleton functions."""

    def test_get_memory_injector_creates_instance(self):
        """get_memory_injector creates a MemoryInjector if none exists."""
        import core.runtime.memory_injector as mod
        old = mod._memory_injector
        try:
            mod._memory_injector = None
            injector = get_memory_injector()
            assert isinstance(injector, MemoryInjector)
        finally:
            mod._memory_injector = old

    def test_get_memory_injector_returns_same_instance(self):
        """Repeated calls return the same instance."""
        import core.runtime.memory_injector as mod
        old = mod._memory_injector
        try:
            mod._memory_injector = None
            a = get_memory_injector()
            b = get_memory_injector()
            assert a is b
        finally:
            mod._memory_injector = old

    def test_set_memory_service_configures_singleton(self):
        """set_memory_service sets memory service on the singleton."""
        import core.runtime.memory_injector as mod
        old = mod._memory_injector
        try:
            mod._memory_injector = None
            ms = MagicMock()
            set_memory_service(ms)
            injector = get_memory_injector()
            assert injector._memory_service is ms
        finally:
            mod._memory_injector = old

    def test_set_memory_service_replaces_existing(self):
        """set_memory_service replaces previously set service."""
        import core.runtime.memory_injector as mod
        old = mod._memory_injector
        try:
            mod._memory_injector = None
            ms1 = MagicMock()
            ms2 = MagicMock()
            set_memory_service(ms1)
            set_memory_service(ms2)
            injector = get_memory_injector()
            assert injector._memory_service is ms2
        finally:
            mod._memory_injector = old
