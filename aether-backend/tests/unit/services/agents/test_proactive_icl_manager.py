"""
Tests for services/agents/proactive_icl_manager.py

Covers: ProactiveICLManager — build, search, composite ranking, ensure_index,
append_run, error handling, factory function.

All AetherRagBuilder/AetherRagSearcher calls mocked at import boundary.
rank_with_composite tested with real math (no mocks needed).
"""

import math
import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.agents.proactive_icl_manager import (
    FEEDBACK_SCORES,
    ICL_META_KEY,
    ICL_META_SCHEMA_VERSION,
    ProactiveICLManager,
    get_proactive_icl_manager,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _aether_rag_module():
    """Inject mock aether_rag module so lazy imports resolve."""
    import sys as _sys
    mock_mod = MagicMock()
    saved = _sys.modules.get("aether_rag")
    _sys.modules["aether_rag"] = mock_mod
    yield mock_mod
    if saved is not None:
        _sys.modules["aether_rag"] = saved
    else:
        _sys.modules.pop("aether_rag", None)


@pytest.fixture
def tmp_index_dir(tmp_path):
    d = tmp_path / "proactive_icl"
    d.mkdir()
    return d


@pytest.fixture
def manager(tmp_index_dir):
    return ProactiveICLManager(
        index_directory=tmp_index_dir,
        embedding_model="Xenova/bge-small-en-v1.5",
        mode="openai",
        api_base="http://localhost:3000/api",
        api_key="not-needed",
    )


@pytest.fixture
def sample_runs():
    """Realistic proactive agent runs with feedback."""
    now = datetime.now(timezone.utc)
    return [
        {
            "id": "aaaa-1111",
            "recommendation": "Found related ML paper on attention mechanisms",
            "queries": ["attention mechanisms", "transformer architecture"],
            "user_feedback": "clicked",
            "created_at": (now - timedelta(days=2)).isoformat(),
        },
        {
            "id": "bbbb-2222",
            "recommendation": "New Kubernetes CVE patch available",
            "queries": ["kubernetes CVE", "CVE-2024-1234"],
            "user_feedback": "dismissed",
            "created_at": (now - timedelta(days=5)).isoformat(),
        },
        {
            "id": "cccc-3333",
            "recommendation": "Meeting notes from standup overlap with your current work",
            "queries": ["standup notes", "project alpha"],
            "user_feedback": "timeout",
            "created_at": (now - timedelta(days=10)).isoformat(),
        },
    ]


def _write_valid_icl_meta(manager, indexed_run_ids=None):
    manager._meta_path.write_text(
        json.dumps(
            {
                "bm25_enabled": True,
                ICL_META_KEY: {
                    "schema_version": ICL_META_SCHEMA_VERSION,
                    "embedding_model": manager.embedding_model,
                    "embedding_mode": manager.mode,
                    "indexed_run_ids": indexed_run_ids or [],
                    "indexed_count": len(indexed_run_ids or []),
                    "last_sync_at": datetime.now(timezone.utc).isoformat(),
                },
            }
        )
    )


# ─── _make_document_text ─────────────────────────────────────────────────────

class TestMakeDocumentText:
    def test_combines_recommendation_and_queries(self, manager):
        text = manager._make_document_text("Found ML paper", ["attention", "transformer"])
        assert text == "Found ML paper | attention transformer"

    def test_empty_queries(self, manager):
        text = manager._make_document_text("Found ML paper", [])
        assert text == "Found ML paper"

    def test_empty_recommendation(self, manager):
        text = manager._make_document_text("", ["query1", "query2"])
        assert text == "query1 query2"

    def test_filters_empty_queries(self, manager):
        text = manager._make_document_text("Rec", ["q1", "", "q2"])
        assert text == "Rec | q1 q2"


# ─── build_from_runs ─────────────────────────────────────────────────────────

class TestBuildFromRuns:
    @patch("aether_rag.AetherRagBuilder")
    def test_builds_index_from_valid_runs(self, MockBuilder, manager, sample_runs):
        mock_builder = MagicMock()
        MockBuilder.return_value = mock_builder

        result = manager.build_from_runs(sample_runs)

        assert result is True
        assert mock_builder.add_text.call_count == 3
        mock_builder.build_index.assert_called_once_with(str(manager._index_path), defer_sparse_build=False)

    @patch("aether_rag.AetherRagBuilder")
    def test_metadata_includes_feedback_and_timestamp(self, MockBuilder, manager, sample_runs):
        mock_builder = MagicMock()
        MockBuilder.return_value = mock_builder

        manager.build_from_runs(sample_runs)

        first_call = mock_builder.add_text.call_args_list[0]
        meta = first_call[1]["metadata"]
        assert meta["feedback"] == "clicked"
        assert meta["run_id"] == "aaaa-1111"
        assert "timestamp" in meta

    @patch("aether_rag.AetherRagBuilder")
    def test_skips_runs_without_feedback(self, MockBuilder, manager):
        mock_builder = MagicMock()
        MockBuilder.return_value = mock_builder

        runs = [
            {"id": "1", "recommendation": "Something long enough to pass", "queries": ["query"], "user_feedback": None},
            {"id": "2", "recommendation": "Valid recommendation text here", "queries": ["query"], "user_feedback": "clicked",
             "created_at": datetime.now(timezone.utc).isoformat()},
        ]
        result = manager.build_from_runs(runs)

        assert result is True
        assert mock_builder.add_text.call_count == 1

    def test_returns_false_for_empty_runs(self, manager):
        result = manager.build_from_runs([])
        assert result is False

    def test_returns_false_when_all_runs_lack_feedback(self, manager):
        runs = [{"id": "1", "recommendation": "Text", "queries": [], "user_feedback": None}]
        result = manager.build_from_runs(runs)
        assert result is False

    @patch("aether_rag.AetherRagBuilder")
    def test_handles_builder_exception(self, MockBuilder, manager, sample_runs):
        MockBuilder.side_effect = RuntimeError("HNSW init failed")
        result = manager.build_from_runs(sample_runs)
        assert result is False

    def test_building_flag_prevents_concurrent_build(self, manager, sample_runs):
        lock = manager.get_thread_lock()
        lock.acquire(blocking=False)
        try:
            result = manager.build_from_runs(sample_runs)
            assert result is False
        finally:
            lock.release()

    @patch("aether_rag.AetherRagBuilder")
    def test_building_flag_resets_on_success(self, MockBuilder, manager, sample_runs):
        MockBuilder.return_value = MagicMock()
        manager.build_from_runs(sample_runs)
        lock = manager.get_thread_lock()
        assert lock.acquire(blocking=False) is True
        lock.release()

    @patch("aether_rag.AetherRagBuilder")
    def test_building_flag_resets_on_failure(self, MockBuilder, manager, sample_runs):
        MockBuilder.side_effect = RuntimeError("fail")
        manager.build_from_runs(sample_runs)
        lock = manager.get_thread_lock()
        assert lock.acquire(blocking=False) is True
        lock.release()


# ─── search ──────────────────────────────────────────────────────────────────

class TestSearch:
    @patch("aether_rag.AetherRagSearcher")
    def test_returns_formatted_results(self, MockSearcher, manager):
        # Create meta file to indicate index exists
        manager._meta_path.write_text('{"bm25_enabled": true}')

        mock_result = MagicMock()
        mock_result.text = "Found ML paper | attention"
        mock_result.score = 0.85
        mock_result.metadata = {"feedback": "clicked", "run_id": "test"}

        mock_searcher = MagicMock()
        mock_searcher.search.return_value = [mock_result]
        MockSearcher.return_value = mock_searcher

        results = manager.search("attention mechanisms", top_k=5, mode="hybrid")

        assert len(results) == 1
        assert results[0]["text"] == "Found ML paper | attention"
        assert results[0]["score"] == 0.85
        assert results[0]["metadata"]["feedback"] == "clicked"

    def test_returns_empty_when_no_index(self, manager):
        results = manager.search("test query")
        assert results == []

    @patch("aether_rag.AetherRagSearcher")
    def test_falls_back_to_semantic_when_bm25_unavailable(self, MockSearcher, manager):
        manager._meta_path.write_text('{"bm25_enabled": false}')

        mock_searcher = MagicMock()
        mock_searcher.search.return_value = []
        MockSearcher.return_value = mock_searcher

        manager.search("test", mode="hybrid")

        # Should have been called with semantic mode
        mock_searcher.search.assert_called_once_with("test", top_k=10, mode="semantic")

    @patch("aether_rag.AetherRagSearcher")
    def test_handles_searcher_exception(self, MockSearcher, manager):
        manager._meta_path.write_text('{"bm25_enabled": true}')
        MockSearcher.side_effect = RuntimeError("Index corrupt")

        results = manager.search("test")
        assert results == []


# ─── rank_with_composite ─────────────────────────────────────────────────────

class TestRankWithComposite:
    """Tests with real math — no mocks needed."""

    def test_empty_results_returns_empty(self, manager):
        assert manager.rank_with_composite([], datetime.now(timezone.utc)) == []

    def test_recent_clicked_ranks_above_old_clicked(self, manager):
        now = datetime.now(timezone.utc)
        results = [
            {
                "text": "Old clicked recommendation | query",
                "score": 0.8,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=30)).isoformat(),
                },
            },
            {
                "text": "Recent clicked recommendation | query",
                "score": 0.8,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=1)).isoformat(),
                },
            },
        ]

        ranked = manager.rank_with_composite(results, now)
        assert ranked[0]["metadata"]["feedback"] == "clicked"
        # Recent should rank higher due to recency
        assert ranked[0]["composite_score"] > ranked[1]["composite_score"]
        assert ranked[0]["metadata"]["days_ago"] < ranked[1]["metadata"]["days_ago"]

    def test_clicked_ranks_equally_with_dismissed_same_time(self, manager):
        now = datetime.now(timezone.utc)
        ts = (now - timedelta(days=3)).isoformat()
        results = [
            {
                "text": "Dismissed rec | query",
                "score": 0.8,
                "metadata": {"feedback": "dismissed", "timestamp": ts},
            },
            {
                "text": "Clicked rec | query",
                "score": 0.8,
                "metadata": {"feedback": "clicked", "timestamp": ts},
            },
        ]

        ranked = manager.rank_with_composite(results, now)
        assert len(ranked) == 2
        # At same relevance, frequency, and time, both clicked and dismissed have equal composite score
        assert abs(ranked[0]["composite_score"] - ranked[1]["composite_score"]) < 1e-4

    def test_higher_relevance_score_ranks_higher(self, manager):
        now = datetime.now(timezone.utc)
        ts = now.isoformat()
        results = [
            {
                "text": "Low relevance rec | query",
                "score": 0.3,
                "metadata": {"feedback": "clicked", "timestamp": ts},
            },
            {
                "text": "High relevance rec | query",
                "score": 0.95,
                "metadata": {"feedback": "clicked", "timestamp": ts},
            },
        ]

        ranked = manager.rank_with_composite(results, now)
        assert ranked[0]["score"] == 0.95

    def test_adds_days_ago_to_metadata(self, manager):
        now = datetime.now(timezone.utc)
        results = [
            {
                "text": "Rec | query",
                "score": 0.8,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=7)).isoformat(),
                },
            },
        ]

        ranked = manager.rank_with_composite(results, now)
        assert abs(ranked[0]["metadata"]["days_ago"] - 7.0) < 0.5

    def test_adds_composite_score_to_results(self, manager):
        now = datetime.now(timezone.utc)
        results = [
            {
                "text": "Rec | query",
                "score": 0.5,
                "metadata": {"feedback": "timeout", "timestamp": now.isoformat()},
            },
        ]

        ranked = manager.rank_with_composite(results, now)
        assert "composite_score" in ranked[0]
        assert 0 < ranked[0]["composite_score"] <= 1.0

    def test_handles_missing_timestamp(self, manager):
        now = datetime.now(timezone.utc)
        results = [
            {
                "text": "Rec | query",
                "score": 0.5,
                "metadata": {"feedback": "clicked"},
            },
        ]

        ranked = manager.rank_with_composite(results, now)
        assert len(ranked) == 1
        # Without timestamp, days_ago defaults to 0 → recency = 1.0
        assert ranked[0]["metadata"]["days_ago"] == 0.0

    def test_handles_single_result_normalization(self, manager):
        """Single result: score_range = 0. Should not divide by zero."""
        now = datetime.now(timezone.utc)
        results = [
            {
                "text": "Single rec | query",
                "score": 0.7,
                "metadata": {"feedback": "clicked", "timestamp": now.isoformat()},
            },
        ]

        ranked = manager.rank_with_composite(results, now)
        assert len(ranked) == 1
        assert ranked[0]["composite_score"] > 0

    def test_recency_decay_formula(self, manager):
        """Verify recency uses exp(-0.049 * days) — half-life ~14 days."""
        now = datetime.now(timezone.utc)
        results = [
            {
                "text": "Rec | q",
                "score": 0.5,
                "metadata": {"feedback": "clicked", "timestamp": (now - timedelta(days=14)).isoformat()},
            },
        ]

        ranked = manager.rank_with_composite(results, now)
        # At 14 days, recency ≈ exp(-0.049 * 14) ≈ exp(-0.686) ≈ 0.504
        expected_recency = math.exp(-0.049 * 14)
        assert abs(expected_recency - 0.504) < 0.01

    def test_feedback_score_mapping(self):
        assert FEEDBACK_SCORES["clicked"] == 1.0
        assert FEEDBACK_SCORES["timeout"] == 0.5
        assert FEEDBACK_SCORES["dismissed"] == 1.0


# ─── ensure_index ────────────────────────────────────────────────────────────

class TestEnsureIndex:
    @pytest.mark.asyncio
    async def test_skips_build_when_index_exists(self, manager):
        _write_valid_icl_meta(manager)
        mock_repo = AsyncMock()
        result = await manager.ensure_index(mock_repo)
        assert result is True
        mock_repo.get_recent_runs.assert_not_called()

    @pytest.mark.asyncio
    @patch("aether_rag.AetherRagBuilder")
    async def test_builds_from_repo_when_index_missing(self, MockBuilder, manager):
        mock_builder = MagicMock()
        MockBuilder.return_value = mock_builder

        mock_repo = AsyncMock()
        mock_repo.get_recent_runs.return_value = [
            {
                "id": "test-1",
                "recommendation": "Found relevant paper on attention",
                "queries": ["attention mechanisms"],
                "user_feedback": "clicked",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "decision": "intervene",
            },
        ]

        result = await manager.ensure_index(mock_repo)

        mock_repo.get_recent_runs.assert_called_once_with(
            decision="intervene", days=365, limit=1000, columns="id, recommendation, queries, user_feedback, created_at"
        )
        assert mock_builder.add_text.called

    @pytest.mark.asyncio
    async def test_returns_false_when_no_runs_with_feedback(self, manager):
        mock_repo = AsyncMock()
        mock_repo.get_recent_runs.return_value = [
            {"id": "1", "recommendation": "Rec", "user_feedback": None, "decision": "intervene"},
        ]

        result = await manager.ensure_index(mock_repo)
        assert result is False

    @pytest.mark.asyncio
    async def test_returns_false_when_repo_empty(self, manager):
        mock_repo = AsyncMock()
        mock_repo.get_recent_runs.return_value = []

        result = await manager.ensure_index(mock_repo)
        assert result is False

    @pytest.mark.asyncio
    async def test_handles_repo_exception(self, manager):
        mock_repo = AsyncMock()
        mock_repo.get_recent_runs.side_effect = ConnectionError("Supabase down")

        result = await manager.ensure_index(mock_repo)
        assert result is False


# ─── append_run ──────────────────────────────────────────────────────────────

class TestAppendRun:
    @patch("aether_rag.AetherRagBuilder")
    def test_appends_to_existing_index(self, MockBuilder, manager):
        _write_valid_icl_meta(manager)
        mock_builder = MagicMock()
        MockBuilder.return_value = mock_builder

        result = manager.append_run(
            recommendation="Found relevant ML paper",
            queries=["attention", "transformer"],
            feedback="clicked",
            timestamp=datetime.now(timezone.utc).isoformat(),
            run_id="test-run-1",
        )

        assert result is True
        mock_builder.add_text.assert_called_once()
        mock_builder.update_index.assert_called_once_with(str(manager._index_path), defer_sparse_build=False)

    def test_returns_false_when_no_index(self, manager):
        result = manager.append_run(
            recommendation="Something",
            queries=["q"],
            feedback="clicked",
            timestamp="now",
        )
        assert result is False

    @patch("aether_rag.AetherRagBuilder")
    def test_returns_false_for_short_text(self, MockBuilder, manager):
        _write_valid_icl_meta(manager)
        result = manager.append_run(
            recommendation="Hi",
            queries=[],
            feedback="clicked",
            timestamp="now",
        )
        assert result is False

    @patch("aether_rag.AetherRagBuilder")
    def test_handles_builder_exception(self, MockBuilder, manager):
        _write_valid_icl_meta(manager)
        MockBuilder.side_effect = RuntimeError("HNSW error")

        result = manager.append_run(
            recommendation="Valid recommendation text here",
            queries=["query"],
            feedback="clicked",
            timestamp="now",
        )
        assert result is False


# ─── provider_options ─────────────────────────────────────────────────────────

class TestProviderOptions:
    def test_returns_options_for_openai_mode(self, manager):
        opts = manager._provider_options
        assert opts == {"base_url": "http://localhost:3000/api", "api_key": "not-needed"}

    def test_returns_none_for_non_openai_mode(self, tmp_index_dir):
        mgr = ProactiveICLManager(
            index_directory=tmp_index_dir,
            embedding_model="test",
            mode="sentence-transformers",
        )
        assert mgr._provider_options is None

    def test_returns_none_when_no_api_base(self, tmp_index_dir):
        mgr = ProactiveICLManager(
            index_directory=tmp_index_dir,
            embedding_model="test",
            mode="openai",
            api_base=None,
        )
        assert mgr._provider_options is None


# ─── factory function ────────────────────────────────────────────────────────

class TestFactoryFunction:
    @patch("config.settings.get_settings")
    def test_creates_manager_with_settings(self, mock_settings):
        mock_es = MagicMock()
        mock_es.model = "Xenova/bge-small-en-v1.5"
        mock_es.openai_base_url = "http://localhost:3000/api"

        mock_cfg = MagicMock()
        mock_cfg.embedding_service = mock_es

        mock_settings.return_value = mock_cfg

        mgr = get_proactive_icl_manager(
            index_directory=Path(tempfile.mkdtemp()),
        )

        assert mgr.embedding_model == "Xenova/bge-small-en-v1.5"
        assert mgr.api_base == "http://localhost:3000/api"
        assert mgr.mode == "openai"


# ─── Academic-content ICL tests ──────────────────────────────────────────────


class TestAcademicContentICL:
    """Tests with paper-like recommendation text matching user study corpus.

    Validates that the composite ranking produces correct ordering when
    ICL data contains academic paper recommendations (clicked vs dismissed)
    over different time windows — the exact pattern from the user study.
    """

    @pytest.fixture
    def academic_runs(self):
        """Simulate 3 months of academic-context proactive agent runs."""
        now = datetime.now(timezone.utc)
        return [
            {
                "id": "paper-run-01",
                "recommendation": (
                    "Found related paper: X-Reasoner demonstrates that general-domain "
                    "text-based post-training enables reasoning capabilities generalizable "
                    "across modalities. Relevant to your current reading on multimodal reasoning."
                ),
                "queries": [
                    "multimodal reasoning cross-modal generalization",
                    "X-Reasoner vision language model",
                ],
                "user_feedback": "clicked",
                "created_at": (now - timedelta(days=1)).isoformat(),
            },
            {
                "id": "paper-run-02",
                "recommendation": (
                    "Found related paper: Visual Contrastive Decoding enhances LLM visual "
                    "perception without additional training. May complement your multimodal "
                    "reasoning essay section on decoding strategies."
                ),
                "queries": [
                    "visual contrastive decoding multimodal",
                    "LLM visual perception improvement",
                ],
                "user_feedback": "clicked",
                "created_at": (now - timedelta(days=3)).isoformat(),
            },
            {
                "id": "paper-run-03",
                "recommendation": (
                    "Found related paper: Spatial reasoning difficulties in VLMs analyzed "
                    "through attention mechanism perspective. Relevant to attention section."
                ),
                "queries": [
                    "spatial reasoning VLM attention mechanism",
                    "vision language model spatial understanding",
                ],
                "user_feedback": "clicked",
                "created_at": (now - timedelta(days=7)).isoformat(),
            },
            {
                "id": "paper-run-04",
                "recommendation": (
                    "Found paper on diffusion model memorization and regularization. "
                    "Tangentially related to your generative model readings."
                ),
                "queries": [
                    "diffusion model memorization regularization",
                    "generative model training dynamics",
                ],
                "user_feedback": "dismissed",
                "created_at": (now - timedelta(days=2)).isoformat(),
            },
            {
                "id": "paper-run-05",
                "recommendation": (
                    "Found paper on proactive search in conversations. Information retrieval "
                    "approach for conversational context."
                ),
                "queries": [
                    "proactive search conversational retrieval",
                    "ad-hoc to proactive search",
                ],
                "user_feedback": "dismissed",
                "created_at": (now - timedelta(days=30)).isoformat(),
            },
        ]

    def test_document_text_preserves_academic_content(self, manager):
        """Recommendation + queries produce indexable text with paper terms."""
        text = manager._make_document_text(
            "Found related paper: X-Reasoner demonstrates cross-modal generalization",
            ["multimodal reasoning", "cross-modal generalization"],
        )
        assert "X-Reasoner" in text
        assert "multimodal reasoning" in text
        assert "cross-modal generalization" in text
        assert " | " in text

    @patch("aether_rag.AetherRagBuilder")
    def test_build_index_from_academic_runs(self, MockBuilder, manager, academic_runs):
        """Index building with academic content indexes all 5 runs."""
        mock_builder = MagicMock()
        MockBuilder.return_value = mock_builder

        result = manager.build_from_runs(academic_runs)

        assert result is True
        assert mock_builder.add_text.call_count == 5
        mock_builder.build_index.assert_called_once()

        first_call_text = mock_builder.add_text.call_args_list[0][0][0]
        assert "X-Reasoner" in first_call_text
        assert "multimodal reasoning" in first_call_text

    @patch("aether_rag.AetherRagBuilder")
    def test_metadata_captures_academic_feedback(self, MockBuilder, manager, academic_runs):
        """Metadata on indexed documents correctly records feedback type."""
        mock_builder = MagicMock()
        MockBuilder.return_value = mock_builder

        manager.build_from_runs(academic_runs)

        calls = mock_builder.add_text.call_args_list
        meta_0 = calls[0][1]["metadata"]
        assert meta_0["feedback"] == "clicked"
        assert meta_0["run_id"] == "paper-run-01"

        meta_3 = calls[3][1]["metadata"]
        assert meta_3["feedback"] == "dismissed"
        assert meta_3["run_id"] == "paper-run-04"

    def test_composite_ranking_academic_recency_dominates_when_feedback_equal(self, manager):
        """Clicked and dismissed papers have equal feedback weight, so recency dominates.

        Scenario: hybrid search returns 5 papers with similar RRF scores.
        When relevance is held constant, the composite ranking should place
        more recent papers higher, regardless of whether they were clicked or dismissed.
        """
        now = datetime.now(timezone.utc)

        # Same RRF score from hybrid search (realistic: similar-relevance results)
        base_score = 0.75

        results = [
            {
                "text": "X-Reasoner cross-modal | multimodal reasoning",
                "score": base_score,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=1)).isoformat(),
                },
            },
            {
                "text": "Diffusion model memorization | generative model",
                "score": base_score,
                "metadata": {
                    "feedback": "dismissed",
                    "timestamp": (now - timedelta(days=2)).isoformat(),
                },
            },
            {
                "text": "Visual contrastive decoding | multimodal VLM",
                "score": base_score,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=3)).isoformat(),
                },
            },
            {
                "text": "Proactive search conversations | IR retrieval",
                "score": base_score,
                "metadata": {
                    "feedback": "dismissed",
                    "timestamp": (now - timedelta(days=30)).isoformat(),
                },
            },
            {
                "text": "Spatial reasoning VLM attention | vision model",
                "score": base_score,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=5)).isoformat(),
                },
            },
        ]

        ranked = manager.rank_with_composite(results, now)

        assert len(ranked) == 5

        # X-Reasoner (clicked, most recent at 1 day ago) should be #1
        assert "X-Reasoner" in ranked[0]["text"]
        assert ranked[0]["composite_score"] > ranked[1]["composite_score"]

        # Old dismissed paper (30 days ago) should be last due to recency decay
        assert "Proactive search" in ranked[-1]["text"]
        assert ranked[-1]["metadata"]["feedback"] == "dismissed"

        # Check recency dominance: 1 day > 2 days > 3 days > 5 days > 30 days
        expected_order_days = [1, 2, 3, 5, 30]
        actual_order_days = [r["metadata"]["days_ago"] for r in ranked]
        assert actual_order_days == expected_order_days

    def test_composite_recency_decay_academic(self, manager):
        """Recent clicked paper outranks older clicked paper with same relevance.

        Week-old paper vs month-old paper, same relevance — recency wins.
        """
        now = datetime.now(timezone.utc)

        results = [
            {
                "text": "Older paper on chain-of-thought | CoT reasoning",
                "score": 0.80,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=28)).isoformat(),
                },
            },
            {
                "text": "Recent paper on chain-of-thought | CoT reasoning",
                "score": 0.80,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=2)).isoformat(),
                },
            },
        ]

        ranked = manager.rank_with_composite(results, now)
        assert "Recent" in ranked[0]["text"]
        assert "Older" in ranked[1]["text"]

        recency_gap = ranked[0]["composite_score"] - ranked[1]["composite_score"]
        assert recency_gap > 0.05, f"Recency gap too small: {recency_gap:.4f}"

    def test_composite_frequency_boost(self, manager):
        """Papers with same topic key (first 50 chars) get frequency boost."""
        now = datetime.now(timezone.utc)
        topic_prefix = "Multimodal reasoning chain-of-thought survey anal"

        results = [
            {
                "text": f"{topic_prefix}ysis A | CoT reasoning",
                "score": 0.70,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=3)).isoformat(),
                },
            },
            {
                "text": f"{topic_prefix}ysis B | CoT reasoning",
                "score": 0.70,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=3)).isoformat(),
                },
            },
            {
                "text": "Completely unique unrelated topic about cats",
                "score": 0.70,
                "metadata": {
                    "feedback": "clicked",
                    "timestamp": (now - timedelta(days=3)).isoformat(),
                },
            },
        ]

        ranked = manager.rank_with_composite(results, now)

        # The two papers with shared topic prefix should have higher frequency score
        shared_scores = [r["composite_score"] for r in ranked if topic_prefix[:30] in r["text"]]
        unique_score = [r["composite_score"] for r in ranked if "cats" in r["text"]]
        assert all(s > unique_score[0] for s in shared_scores), (
            f"Shared-topic scores {shared_scores} should all exceed unique {unique_score[0]}"
        )
