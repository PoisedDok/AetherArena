"""
Tests for services/agents/context_injector.py

Covers: AgentContextInjector — enabled agent discovery, parallel index search,
context formatting, timeout handling, graceful failure, priority ordering,
result quota enforcement, and convenience function.

Gateway and httpx mocked. Pure formatting logic tested without mocks.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from services.agents.context_injector import AgentContextInjector, get_agent_context


# ─── Mock Settings Helper ────────────────────────────────────────────────────

def _make_retrieval_config(**overrides):
    """Build a mock ContextRetrievalSettings with sane defaults."""
    cfg = MagicMock()
    cfg.enabled = overrides.get("enabled", True)
    cfg.max_total_results = overrides.get("max_total_results", 20)
    cfg.default_top_k = overrides.get("default_top_k", 5)
    cfg.min_score = overrides.get("min_score", 0.3)
    cfg.timeout_ms = overrides.get("timeout_ms", 10000)
    cfg.max_concurrent_searches = overrides.get("max_concurrent_searches", 3)
    return cfg


def _make_settings(retrieval_overrides=None, backend_url=None):
    """Build a mock settings object."""
    settings = MagicMock()
    settings.interpreter.context_retrieval = _make_retrieval_config(
        **(retrieval_overrides or {})
    )
    if backend_url:
        settings.backend_url = backend_url
    else:
        # Simulate missing attribute — getattr fallback triggers
        del settings.backend_url
    settings.http_client.default_timeout = 30.0
    return settings


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def mock_gateway():
    """Mock Supabase gateway with async select."""
    gw = MagicMock()
    gw.select = AsyncMock(return_value=[])
    return gw


@pytest.fixture
def mock_uow(mock_gateway):
    """Mock UnitOfWork wrapping mock gateway."""
    uow = MagicMock()
    uow.gateway = mock_gateway
    return uow


@pytest.fixture
def injector(mock_uow):
    """Standard injector with mocked settings and uow."""
    with patch("services.agents.context_injector.get_settings") as mock_gs:
        mock_gs.return_value = _make_settings()
        inj = AgentContextInjector(mock_uow)
    return inj


@pytest.fixture
def injector_disabled(mock_uow):
    """Injector with context retrieval globally disabled."""
    with patch("services.agents.context_injector.get_settings") as mock_gs:
        mock_gs.return_value = _make_settings(retrieval_overrides={"enabled": False})
        inj = AgentContextInjector(mock_uow)
    return inj


# ═══════════════════════════════════════════════════════════════════════════════
#  1. __init__  (constructor)
# ═══════════════════════════════════════════════════════════════════════════════

class TestInit:

    @patch("services.agents.context_injector.get_settings")
    def test_stores_uow_and_gateway(self, mock_gs, mock_uow, mock_gateway):
        mock_gs.return_value = _make_settings()
        inj = AgentContextInjector(mock_uow)
        assert inj._uow is mock_uow
        assert inj._gateway is mock_gateway

    @patch("services.agents.context_injector.get_settings")
    def test_backend_url_from_param(self, mock_gs, mock_uow):
        mock_gs.return_value = _make_settings()
        inj = AgentContextInjector(mock_uow, backend_url="http://custom:9000")
        assert inj._backend_url == "http://custom:9000"

    @patch("services.agents.context_injector.get_settings")
    def test_backend_url_from_settings(self, mock_gs, mock_uow):
        mock_gs.return_value = _make_settings(backend_url="http://settings:8765")
        inj = AgentContextInjector(mock_uow)
        assert inj._backend_url == "http://settings:8765"

    @patch("services.agents.context_injector.get_settings")
    def test_backend_url_fallback_default(self, mock_gs, mock_uow):
        mock_gs.return_value = _make_settings()  # No backend_url attr
        inj = AgentContextInjector(mock_uow)
        assert inj._backend_url == "http://127.0.0.1:8765"

    @patch("services.agents.context_injector.get_settings")
    def test_retrieval_config_stored(self, mock_gs, mock_uow):
        settings = _make_settings(retrieval_overrides={"enabled": False, "timeout_ms": 5000})
        mock_gs.return_value = settings
        inj = AgentContextInjector(mock_uow)
        assert inj._retrieval_config.enabled is False
        assert inj._retrieval_config.timeout_ms == 5000


# ═══════════════════════════════════════════════════════════════════════════════
#  2. _get_enabled_agents  (gateway mocked)
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetEnabledAgents:

    async def test_returns_agents_with_injection_enabled(self, injector, mock_gateway):
        mock_gateway.select.return_value = [
            {
                "agent_name": "research",
                "agent_type": "analysis",
                "configuration": {
                    "context_injection": {"enabled": True, "top_k": 3, "min_score": 0.5, "priority": 1}
                }
            },
            {
                "agent_name": "memory",
                "agent_type": "recall",
                "configuration": {
                    "context_injection": {"enabled": False}
                }
            },
            {
                "agent_name": "research_2",
                "agent_type": "research",
                "configuration": {
                    "context_injection": {"enabled": True, "priority": 5}
                }
            }
        ]
        agents = await injector._get_enabled_agents()

        assert len(agents) == 2
        # Sorted by priority (lower first)
        assert agents[0]["agent_name"] == "research"
        assert agents[0]["priority"] == 1
        assert agents[0]["top_k"] == 3
        assert agents[0]["min_score"] == 0.5
        assert agents[1]["agent_name"] == "research_2"
        assert agents[1]["priority"] == 5

    async def test_uses_config_defaults_for_missing_fields(self, injector, mock_gateway):
        mock_gateway.select.return_value = [
            {
                "agent_name": "research",
                "agent_type": "monitor",
                "configuration": {
                    "context_injection": {"enabled": True}
                }
            }
        ]
        agents = await injector._get_enabled_agents()

        assert len(agents) == 1
        # Uses defaults from retrieval_config
        assert agents[0]["top_k"] == 5  # default_top_k
        assert agents[0]["min_score"] == 0.3  # min_score
        assert agents[0]["priority"] == 10  # default priority

    async def test_no_agents_returns_empty(self, injector, mock_gateway):
        mock_gateway.select.return_value = []
        agents = await injector._get_enabled_agents()
        assert agents == []

    async def test_no_context_injection_config_skipped(self, injector, mock_gateway):
        mock_gateway.select.return_value = [
            {
                "agent_name": "orphan",
                "agent_type": "test",
                "configuration": {}  # No context_injection key
            }
        ]
        agents = await injector._get_enabled_agents()
        assert agents == []

    async def test_gateway_exception_returns_empty(self, injector, mock_gateway):
        mock_gateway.select.side_effect = RuntimeError("DB down")
        agents = await injector._get_enabled_agents()
        assert agents == []

    async def test_enabled_only_false_passes_empty_filters(self, injector, mock_gateway):
        mock_gateway.select.return_value = []
        await injector._get_enabled_agents(enabled_only=False)
        call_kwargs = mock_gateway.select.call_args
        assert call_kwargs[1]["filters"] == {}

    async def test_enabled_only_true_passes_enabled_filter(self, injector, mock_gateway):
        mock_gateway.select.return_value = []
        await injector._get_enabled_agents(enabled_only=True)
        call_kwargs = mock_gateway.select.call_args
        assert call_kwargs[1]["filters"] == {"enabled": True}


# ═══════════════════════════════════════════════════════════════════════════════
#  3. _format_context_sections  (pure logic)
# ═══════════════════════════════════════════════════════════════════════════════

class TestFormatContextSections:

    def test_empty_results_returns_empty(self, injector):
        assert injector._format_context_sections([]) == ""

    def test_single_agent_with_results(self, injector):
        results = [{
            "agent_name": "research_agent",
            "results": [
                {"score": 0.85, "content": "Risk clause identified", "metadata": {}}
            ]
        }]
        output = injector._format_context_sections(results)
        assert "## 🔍 Agent Context" in output
        assert "### From Research Agent" in output
        assert "(Score: 0.85)" in output
        assert "Risk clause identified" in output

    def test_multiple_agents_formatted(self, injector):
        results = [
            {
                "agent_name": "research",
                "results": [{"score": 0.9, "content": "Vetting content", "metadata": {}}]
            },
            {
                "agent_name": "memory",
                "results": [{"score": 0.7, "content": "Memory content", "metadata": {}}]
            }
        ]
        output = injector._format_context_sections(results)
        assert "### From Research" in output
        assert "### From Memory" in output
        assert "Vetting content" in output
        assert "Memory content" in output

    def test_date_metadata_formatted(self, injector):
        results = [{
            "agent_name": "memory",
            "results": [{
                "score": 0.8,
                "content": "Date test",
                "metadata": {"created_at": "2026-01-15T10:30:00Z"}
            }]
        }]
        output = injector._format_context_sections(results)
        assert "(2026-01-15)" in output

    def test_invalid_date_metadata_ignored(self, injector):
        results = [{
            "agent_name": "memory",
            "results": [{
                "score": 0.8,
                "content": "Bad date",
                "metadata": {"created_at": "not-a-date"}
            }]
        }]
        output = injector._format_context_sections(results)
        assert "Bad date" in output
        # No date in parentheses — silently skipped
        assert "(Score: 0.80)" in output

    def test_max_total_results_enforced(self, injector):
        # Set a low quota
        injector._retrieval_config.max_total_results = 2
        results = [{
            "agent_name": "memory",
            "results": [
                {"score": 0.9, "content": "One", "metadata": {}},
                {"score": 0.8, "content": "Two", "metadata": {}},
                {"score": 0.7, "content": "Three", "metadata": {}},
            ]
        }]
        output = injector._format_context_sections(results)
        assert "One" in output
        assert "Two" in output
        assert "Three" not in output

    def test_max_total_results_across_agents(self, injector):
        injector._retrieval_config.max_total_results = 2
        results = [
            {
                "agent_name": "research",
                "results": [
                    {"score": 0.9, "content": "Vet1", "metadata": {}},
                    {"score": 0.8, "content": "Vet2", "metadata": {}},
                ]
            },
            {
                "agent_name": "memory",
                "results": [
                    {"score": 0.7, "content": "Mem1", "metadata": {}},
                ]
            }
        ]
        output = injector._format_context_sections(results)
        # First agent gets 2, second agent gets 0 (quota exhausted)
        assert "Vet1" in output
        assert "Vet2" in output
        assert "Mem1" not in output

    def test_agent_with_empty_results_skipped(self, injector):
        results = [
            {"agent_name": "empty_agent", "results": []},
            {"agent_name": "real_agent", "results": [{"score": 0.8, "content": "Real", "metadata": {}}]}
        ]
        output = injector._format_context_sections(results)
        assert "Empty Agent" not in output
        assert "Real Agent" in output

    def test_all_empty_results_returns_empty(self, injector):
        results = [
            {"agent_name": "a", "results": []},
            {"agent_name": "b", "results": []},
        ]
        assert injector._format_context_sections(results) == ""

    def test_agent_name_formatting(self, injector):
        results = [{
            "agent_name": "research_scout",
            "results": [{"score": 0.6, "content": "test", "metadata": {}}]
        }]
        output = injector._format_context_sections(results)
        assert "### From Research Scout" in output

    def test_score_precision(self, injector):
        results = [{
            "agent_name": "x",
            "results": [{"score": 0.123456, "content": "test", "metadata": {}}]
        }]
        output = injector._format_context_sections(results)
        assert "(Score: 0.12)" in output

    def test_missing_score_defaults_to_zero(self, injector):
        results = [{
            "agent_name": "x",
            "results": [{"content": "no score", "metadata": {}}]
        }]
        output = injector._format_context_sections(results)
        assert "(Score: 0.00)" in output


# ═══════════════════════════════════════════════════════════════════════════════
#  4. _search_single_agent  (httpx mocked)
# ═══════════════════════════════════════════════════════════════════════════════

class TestSearchSingleAgent:

    async def test_successful_search(self, injector):
        agent = {"agent_name": "research", "agent_type": "analysis", "top_k": 5, "min_score": 0.3, "priority": 1}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"results": [{"score": 0.9, "content": "hit"}]}
        mock_response.raise_for_status = MagicMock()

        with patch("services.agents.context_injector.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.get.return_value = mock_response
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = await injector._search_single_agent("contract terms", agent)

        assert result["agent_name"] == "research"
        assert result["agent_type"] == "analysis"
        assert len(result["results"]) == 1
        assert result["results"][0]["score"] == 0.9

    async def test_404_returns_empty_results(self, injector):
        agent = {"agent_name": "missing", "agent_type": "x", "top_k": 5, "min_score": 0.3, "priority": 1}
        mock_response = MagicMock()
        mock_response.status_code = 404

        with patch("services.agents.context_injector.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.get.return_value = mock_response
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = await injector._search_single_agent("query", agent)

        assert result["results"] == []

    async def test_http_error_returns_empty(self, injector):
        agent = {"agent_name": "broken", "agent_type": "x", "top_k": 5, "min_score": 0.3, "priority": 1}

        with patch("services.agents.context_injector.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.get.side_effect = httpx.HTTPError("Connection refused")
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = await injector._search_single_agent("query", agent)

        assert result["agent_name"] == "broken"
        assert result["results"] == []

    async def test_generic_exception_returns_empty(self, injector):
        agent = {"agent_name": "crash", "agent_type": "x", "top_k": 5, "min_score": 0.3, "priority": 1}

        with patch("services.agents.context_injector.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.get.side_effect = RuntimeError("Unexpected")
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = await injector._search_single_agent("query", agent)

        assert result["results"] == []

    async def test_passes_correct_params(self, injector):
        agent = {"agent_name": "mem", "agent_type": "recall", "top_k": 7, "min_score": 0.5, "priority": 2}
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"results": []}
        mock_response.raise_for_status = MagicMock()

        with patch("services.agents.context_injector.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.get.return_value = mock_response
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            await injector._search_single_agent("test query", agent)

        call_kwargs = mock_client.get.call_args
        assert call_kwargs[1]["params"]["name"] == "mem"
        assert call_kwargs[1]["params"]["query"] == "test query"
        assert call_kwargs[1]["params"]["top_k"] == 7
        assert call_kwargs[1]["params"]["min_score"] == 0.5


# ═══════════════════════════════════════════════════════════════════════════════
#  5. _search_agent_indexes  (parallel search)
# ═══════════════════════════════════════════════════════════════════════════════

class TestSearchAgentIndexes:

    async def test_parallel_search_collects_results(self, injector):
        agents = [
            {"agent_name": "a", "agent_type": "x", "top_k": 5, "min_score": 0.3, "priority": 1},
            {"agent_name": "b", "agent_type": "y", "top_k": 5, "min_score": 0.3, "priority": 2},
        ]

        async def mock_search(query, agent):
            return {"agent_name": agent["agent_name"], "results": [{"score": 0.9}]}

        with patch.object(injector, "_search_single_agent", side_effect=mock_search):
            results = await injector._search_agent_indexes("query", agents)

        assert len(results) == 2

    async def test_exception_in_one_search_filtered_out(self, injector):
        agents = [
            {"agent_name": "good", "agent_type": "x", "top_k": 5, "min_score": 0.3, "priority": 1},
            {"agent_name": "bad", "agent_type": "y", "top_k": 5, "min_score": 0.3, "priority": 2},
        ]

        async def mock_search(query, agent):
            if agent["agent_name"] == "bad":
                raise RuntimeError("Index corrupted")
            return {"agent_name": "good", "results": [{"score": 0.8}]}

        with patch.object(injector, "_search_single_agent", side_effect=mock_search):
            results = await injector._search_agent_indexes("query", agents)

        assert len(results) == 1
        assert results[0]["agent_name"] == "good"

    async def test_empty_results_filtered_out(self, injector):
        agents = [
            {"agent_name": "empty", "agent_type": "x", "top_k": 5, "min_score": 0.3, "priority": 1},
        ]

        async def mock_search(query, agent):
            return {"agent_name": "empty", "results": []}

        with patch.object(injector, "_search_single_agent", side_effect=mock_search):
            results = await injector._search_agent_indexes("query", agents)

        assert results == []


# ═══════════════════════════════════════════════════════════════════════════════
#  6. get_agent_context  (full flow)
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetAgentContext:

    async def test_disabled_returns_empty(self, injector_disabled):
        result = await injector_disabled.get_agent_context("query")
        assert result == ""

    async def test_no_agents_returns_empty(self, injector):
        with patch.object(injector, "_get_enabled_agents", return_value=[]):
            result = await injector.get_agent_context("query")
        assert result == ""

    async def test_full_flow_returns_context(self, injector):
        agents = [{"agent_name": "research", "agent_type": "analysis", "top_k": 5, "min_score": 0.3, "priority": 1}]
        search_results = [{
            "agent_name": "research",
            "results": [{"score": 0.9, "content": "Risk found", "metadata": {}}]
        }]

        with patch.object(injector, "_get_enabled_agents", return_value=agents):
            with patch.object(injector, "_search_agent_indexes", return_value=search_results):
                result = await injector.get_agent_context("contract risk")

        assert "Agent Context" in result
        assert "Risk found" in result

    async def test_timeout_returns_empty(self, injector):
        # Set very short timeout
        injector._retrieval_config.timeout_ms = 1

        agents = [{"agent_name": "slow", "agent_type": "x", "top_k": 5, "min_score": 0.3, "priority": 1}]

        async def slow_search(query, agents_list):
            await asyncio.sleep(5)
            return []

        with patch.object(injector, "_get_enabled_agents", return_value=agents):
            with patch.object(injector, "_search_agent_indexes", side_effect=slow_search):
                result = await injector.get_agent_context("query")

        assert result == ""

    async def test_exception_returns_empty(self, injector):
        with patch.object(injector, "_get_enabled_agents", side_effect=RuntimeError("DB crash")):
            result = await injector.get_agent_context("query")
        assert result == ""


# ═══════════════════════════════════════════════════════════════════════════════
#  7. get_agent_context convenience function
# ═══════════════════════════════════════════════════════════════════════════════

class TestConvenienceFunction:

    async def test_with_provided_uow(self):
        mock_uow = MagicMock()
        mock_uow.gateway = MagicMock()

        with patch("services.agents.context_injector.get_settings") as mock_gs:
            settings = _make_settings(retrieval_overrides={"enabled": False})
            mock_gs.return_value = settings

            result = await get_agent_context("query", uow=mock_uow)
        assert result == ""

    async def test_without_uow_no_gateway_returns_empty(self):
        with patch("services.agents.context_injector.get_settings") as mock_gs:
            mock_gs.return_value = _make_settings()
            with patch("api.dependencies.get_database_connection", return_value=None):
                result = await get_agent_context("query")
        assert result == ""

    async def test_without_uow_with_gateway_creates_uow(self):
        """Lines 397-401: uow=None + valid gateway → creates SupabaseUnitOfWork."""
        mock_gateway = MagicMock()
        mock_inner_uow = MagicMock()
        mock_inner_uow.gateway = mock_gateway

        mock_context_cls = MagicMock()

        # Mock SupabaseUnitOfWork as async context manager
        mock_uow_cls = MagicMock()
        mock_uow_instance = AsyncMock()
        mock_uow_instance.__aenter__ = AsyncMock(return_value=mock_inner_uow)
        mock_uow_instance.__aexit__ = AsyncMock(return_value=False)
        mock_uow_cls.return_value = mock_uow_instance

        with patch("api.dependencies.get_database_connection", return_value=mock_gateway), \
             patch("data.database.uow.SupabaseRequestContext", mock_context_cls), \
             patch("services.agents.context_injector.SupabaseUnitOfWork", mock_uow_cls), \
             patch("services.agents.context_injector.get_settings") as mock_gs:
            # Disable retrieval so the injector returns "" quickly
            mock_gs.return_value = _make_settings(retrieval_overrides={"enabled": False})
            result = await get_agent_context("test query")

        assert isinstance(result, str)
        mock_uow_cls.assert_called_once()
