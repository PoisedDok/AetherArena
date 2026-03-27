"""
Tests for data/database/repositories/proactive_agent.py

Deep assertion tests for ProactiveAgentRepository:
- insert_agent_run: all fields propagated without legacy signal columns
- record_user_feedback: sets BOTH user_feedback AND shown_to_user=True
- mark_shown_to_user: sets shown_to_user
- get_feedback_stats: correct RPC params, error fallback returns zeroes
- search_similar_runs: correct RPC params, empty result handling
- find_similar_runs: client-side filtering
- Queue operations: queue_batch, get_pending_batches, mark_batch_processing,
  mark_batch_completed, mark_batch_failed (retry logic at count=3)
- Constructor: rejects None, accepts SupabasePersistenceGateway and SupabaseClient
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from data.database.repositories.proactive_agent import ProactiveAgentRepository
from data.database.persistence_gateway import SupabasePersistenceGateway


# ===========================================================================
# Fixtures
# ===========================================================================

def _make_gateway():
    """Create a mock SupabasePersistenceGateway with all async methods."""
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.select = AsyncMock(return_value=[])
    gw.insert = AsyncMock(return_value=[{"id": str(uuid4())}])
    gw.update = AsyncMock(return_value=[{}])
    gw.upsert = AsyncMock(return_value=[{}])
    gw.delete = AsyncMock()
    gw.count = AsyncMock(return_value=0)
    gw.rpc = AsyncMock(return_value=[])
    return gw


@pytest.fixture
def repo():
    gw = _make_gateway()
    return ProactiveAgentRepository(db=gw), gw


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_rejects_none(self):
        with pytest.raises(ValueError, match="required"):
            ProactiveAgentRepository(db=None)

    def test_rejects_invalid_type(self):
        with pytest.raises(TypeError, match="Expected"):
            ProactiveAgentRepository(db="not a gateway")

    def test_accepts_gateway(self):
        gw = _make_gateway()
        repo = ProactiveAgentRepository(db=gw)
        assert repo._gateway is gw


# ===========================================================================
# insert_agent_run
# ===========================================================================

class TestInsertAgentRun:

    @pytest.mark.asyncio
    async def test_default_agent_mode_is_budget_0(self, repo):
        """Default agent_mode is budget_0 (legacy standard mode removed)."""
        r, gw = repo
        await r.insert_agent_run(
            query_ids=["q1"], queries=["test"], source_docs=[], day_date="2026-02-09",
            decision="defer",
        )
        call_args = gw.insert.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data") or call_args[0][1]
        assert data["agent_mode"] == "budget_0"

    @pytest.mark.asyncio
    async def test_agent_mode_propagates_budget_value(self, repo):
        """Explicit budget_* agent_mode is propagated."""
        r, gw = repo
        await r.insert_agent_run(
            query_ids=["q1"], queries=["test"], source_docs=[], day_date="2026-02-09",
            decision="intervene",
            agent_mode="budget_4",
        )
        call_args = gw.insert.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data") or call_args[0][1]
        assert data["agent_mode"] == "budget_4"

    @pytest.mark.asyncio
    async def test_all_fields_propagated(self, repo):
        """Verify every field from args appears in the insert data."""
        r, gw = repo
        session_id = uuid4()
        embedding = [0.1, 0.2, 0.3]

        await r.insert_agent_run(
            query_ids=["q1", "q2"], queries=["query1", "query2"],
            source_docs=[{"source": "email", "metadata": {}}],
            day_date="2026-02-09", decision="intervene", agent_mode="budget_4",
            llm_model="qwen3", tool_calls_count=5, execution_time_ms=12000,
            relevance_score=0.85, context_gathered={"tools": ["retriever"]},
            recommendation="Check the CVE", supporting_docs=[{"url": "https://x.com"}],
            reasoning_traces=["Step 1: Checked", "Step 2: Found"], session_id=session_id,
            context_embedding=embedding,
            defer_reason=None,
        )

        call_args = gw.insert.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data") or call_args[0][1]

        assert data["query_ids"] == ["q1", "q2"]
        assert data["queries"] == ["query1", "query2"]
        assert data["source_docs"] == [{"source": "email", "metadata": {}}]
        assert data["day_date"] == "2026-02-09"
        assert data["decision"] == "intervene"
        assert data["agent_mode"] == "budget_4"
        assert data["llm_model"] == "qwen3"
        assert data["tool_calls_count"] == 5
        assert data["execution_time_ms"] == 12000
        assert data["relevance_score"] == 0.85
        assert data["context_gathered"] == {"tools": ["retriever"]}
        assert data["recommendation"] == "Check the CVE"
        assert data["supporting_docs"] == [{"url": "https://x.com"}]
        assert data["reasoning_traces"] == ["Step 1: Checked", "Step 2: Found"]
        assert data["session_id"] == str(session_id)
        assert data["context_embedding"] == embedding
        assert "processed_at" in data

    @pytest.mark.asyncio
    async def test_defaults_for_optional_fields(self, repo):
        """Optional fields default correctly (context_gathered=[], supporting_docs=[], etc.)."""
        r, gw = repo

        await r.insert_agent_run(
            query_ids=["q1"], queries=["test"], source_docs=[], day_date="2026-02-09",
            decision="defer",
        )

        call_args = gw.insert.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data") or call_args[0][1]

        assert data["context_gathered"] == []
        assert data["supporting_docs"] == []
        assert data["reasoning_traces"] == []
        assert data["session_id"] is None
        assert data["context_embedding"] is None

    @pytest.mark.asyncio
    async def test_insert_called_on_correct_table(self, repo):
        r, gw = repo
        await r.insert_agent_run(
            query_ids=["q1"], queries=["test"], source_docs=[], day_date="2026-02-09",
            decision="defer",
        )
        call_args = gw.insert.call_args
        table = call_args.args[0] if call_args.args else call_args[0][0]
        assert table == "proactive_agent_runs"

    @pytest.mark.asyncio
    async def test_returns_first_result_from_list(self, repo):
        """gateway.insert returns a list; insert_agent_run returns first element."""
        r, gw = repo
        expected_id = str(uuid4())
        gw.insert.return_value = [{"id": expected_id, "decision": "defer"}]

        result = await r.insert_agent_run(
            query_ids=["q1"], queries=["test"], source_docs=[], day_date="2026-02-09",
            decision="defer",
        )
        assert result["id"] == expected_id


# ===========================================================================
# record_user_feedback
# ===========================================================================

class TestRecordUserFeedback:

    @pytest.mark.asyncio
    async def test_sets_feedback_and_shown_to_user(self, repo):
        """CRITICAL: record_user_feedback must set BOTH user_feedback AND shown_to_user=True."""
        r, gw = repo
        run_id = uuid4()

        await r.record_user_feedback(run_id, "clicked")

        gw.update.assert_called_once()
        call_args = gw.update.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data")

        assert data["user_feedback"] == "clicked"
        assert data["shown_to_user"] is True
        assert "feedback_timestamp" in data

    @pytest.mark.asyncio
    async def test_dismissed_feedback(self, repo):
        r, gw = repo
        await r.record_user_feedback(uuid4(), "dismissed")

        call_args = gw.update.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data")
        assert data["user_feedback"] == "dismissed"
        assert data["shown_to_user"] is True

    @pytest.mark.asyncio
    async def test_timeout_feedback(self, repo):
        r, gw = repo
        await r.record_user_feedback(uuid4(), "timeout")

        call_args = gw.update.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data")
        assert data["user_feedback"] == "timeout"
        assert data["shown_to_user"] is True

    @pytest.mark.asyncio
    async def test_updates_correct_table_and_id(self, repo):
        r, gw = repo
        run_id = uuid4()
        await r.record_user_feedback(run_id, "clicked")

        call_args = gw.update.call_args
        table = call_args.args[0] if call_args.args else call_args[0][0]
        record_id = call_args.kwargs.get("record_id") or call_args[1].get("record_id")
        assert table == "proactive_agent_runs"
        assert record_id == str(run_id)


# ===========================================================================
# mark_shown_to_user
# ===========================================================================

class TestMarkShownToUser:

    @pytest.mark.asyncio
    async def test_sets_shown_to_user_true(self, repo):
        r, gw = repo
        run_id = uuid4()
        await r.mark_shown_to_user(run_id)

        call_args = gw.update.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data")
        assert data["shown_to_user"] is True


# ===========================================================================
# get_run_by_id
# ===========================================================================

class TestGetRunById:

    @pytest.mark.asyncio
    async def test_returns_first_row_when_found(self, repo):
        r, gw = repo
        run_id = uuid4()
        gw.select.return_value = [{"id": str(run_id), "decision": "intervene"}]

        result = await r.get_run_by_id(run_id)

        gw.select.assert_awaited_once_with(
            "proactive_agent_runs",
            filters={"id": str(run_id)},
            limit=1,
        )
        assert result == {"id": str(run_id), "decision": "intervene"}

    @pytest.mark.asyncio
    async def test_returns_none_when_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_run_by_id(uuid4())
        assert result is None


# ===========================================================================
# get_feedback_stats
# ===========================================================================

class TestGetFeedbackStats:

    @pytest.mark.asyncio
    async def test_correct_rpc_call(self, repo):
        r, gw = repo
        gw.rpc.return_value = [{"total_shown": 10, "clicked_count": 5, "dismissed_count": 3, "timeout_count": 2, "click_rate": 0.5}]

        result = await r.get_feedback_stats(days=14)

        gw.rpc.assert_called_once_with("get_proactive_feedback_stats", params={"days_back": 14})
        assert result["total_shown"] == 10
        assert result["clicked_count"] == 5
        assert result["dismissed_count"] == 3
        assert result["timeout_count"] == 2
        assert result["click_rate"] == 0.5

    @pytest.mark.asyncio
    async def test_error_returns_zeroes(self, repo):
        r, gw = repo
        gw.rpc.side_effect = Exception("DB down")

        result = await r.get_feedback_stats()

        assert result["total_shown"] == 0
        assert result["clicked_count"] == 0
        assert result["click_rate"] == 0.0

    @pytest.mark.asyncio
    async def test_empty_result_returns_zeroes(self, repo):
        r, gw = repo
        gw.rpc.return_value = []

        result = await r.get_feedback_stats()
        assert result["total_shown"] == 0

    @pytest.mark.asyncio
    async def test_null_values_from_db_do_not_crash(self, repo):
        """SQL NULL values for numeric fields must not raise TypeError from float(None)."""
        r, gw = repo
        gw.rpc.return_value = [{
            "total_shown": None,
            "clicked_count": None,
            "dismissed_count": None,
            "timeout_count": None,
            "click_rate": None,
        }]

        result = await r.get_feedback_stats()

        assert result["total_shown"] == 0
        assert result["clicked_count"] == 0
        assert result["dismissed_count"] == 0
        assert result["timeout_count"] == 0
        assert result["click_rate"] == 0.0


# ===========================================================================
# search_similar_runs
# ===========================================================================

class TestSearchSimilarRuns:

    @pytest.mark.asyncio
    async def test_correct_rpc_params(self, repo):
        r, gw = repo
        embedding = [0.1] * 384

        await r.search_similar_runs(
            query_embedding=embedding,
            similarity_threshold=0.8,
            require_positive_feedback=True,
            limit=3,
        )

        gw.rpc.assert_called_once_with(
            "search_similar_proactive_runs",
            params={
                "query_embedding": embedding,
                "similarity_threshold": 0.8,
                "require_positive_feedback": True,
                "limit_results": 3,
                "embedding_model_name": None,
            },
        )

    @pytest.mark.asyncio
    async def test_returns_results(self, repo):
        r, gw = repo
        gw.rpc.return_value = [
            {"run_id": "abc", "similarity_score": 0.9, "recommendation": "Check CVE"},
        ]
        result = await r.search_similar_runs(query_embedding=[0.1] * 384)
        assert len(result) == 1
        assert result[0]["similarity_score"] == 0.9

    @pytest.mark.asyncio
    async def test_empty_result(self, repo):
        r, gw = repo
        gw.rpc.return_value = []
        result = await r.search_similar_runs(query_embedding=[0.1] * 384)
        assert result == []

    @pytest.mark.asyncio
    async def test_error_returns_empty(self, repo):
        r, gw = repo
        gw.rpc.side_effect = Exception("vector search failed")
        result = await r.search_similar_runs(query_embedding=[0.1] * 384)
        assert result == []

    @pytest.mark.asyncio
    async def test_none_result_returns_empty(self, repo):
        r, gw = repo
        gw.rpc.return_value = None
        result = await r.search_similar_runs(query_embedding=[0.1] * 384)
        assert result == []


# ===========================================================================
# Queue operations
# ===========================================================================

class TestQueueBatch:

    @pytest.mark.asyncio
    async def test_inserts_with_correct_data(self, repo):
        r, gw = repo
        await r.queue_batch(query_ids=["q1", "q2"], day_date="2026-02-09", priority=8)

        call_args = gw.insert.call_args
        table = call_args.args[0] if call_args.args else call_args[0][0]
        data = call_args.kwargs.get("data") or call_args[1].get("data") or call_args[0][1]

        assert table == "proactive_agent_queue"
        assert data["query_ids"] == ["q1", "q2"]
        assert data["day_date"] == "2026-02-09"
        assert data["priority"] == 8
        assert data["status"] == "pending"


class TestMarkBatchProcessing:

    @pytest.mark.asyncio
    async def test_sets_processing_status(self, repo):
        r, gw = repo
        queue_id = uuid4()
        await r.mark_batch_processing(queue_id)

        call_args = gw.update.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data")
        assert data["status"] == "processing"
        assert "started_at" in data


class TestMarkBatchCompleted:

    @pytest.mark.asyncio
    async def test_sets_completed_with_run_id(self, repo):
        r, gw = repo
        queue_id = uuid4()
        run_id = uuid4()
        await r.mark_batch_completed(queue_id, run_id)

        call_args = gw.update.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data")
        assert data["status"] == "completed"
        assert data["agent_run_id"] == str(run_id)
        assert "completed_at" in data


class TestMarkBatchFailed:

    @pytest.mark.asyncio
    async def test_retry_under_3_sets_pending(self, repo):
        """Retry count < 3 -> status reverts to 'pending' for retry."""
        r, gw = repo
        queue_id = uuid4()
        gw.select.return_value = [{"id": str(queue_id), "retry_count": 1}]

        await r.mark_batch_failed(queue_id, "timeout error")

        # update should be called with retry_count=2 and status=pending
        call_args = gw.update.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data")
        assert data["retry_count"] == 2
        assert data["status"] == "pending"  # Still retryable
        assert data["error_message"] == "timeout error"

    @pytest.mark.asyncio
    async def test_retry_at_3_sets_failed(self, repo):
        """Retry count reaches 3 -> status becomes 'failed' (no more retries)."""
        r, gw = repo
        queue_id = uuid4()
        gw.select.return_value = [{"id": str(queue_id), "retry_count": 2}]

        await r.mark_batch_failed(queue_id, "persistent error")

        call_args = gw.update.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data")
        assert data["retry_count"] == 3
        assert data["status"] == "failed"  # Permanently failed

    @pytest.mark.asyncio
    async def test_missing_queue_entry_is_noop(self, repo):
        """If queue entry not found, does nothing."""
        r, gw = repo
        gw.select.return_value = []

        await r.mark_batch_failed(uuid4(), "error")
        gw.update.assert_not_called()

    @pytest.mark.asyncio
    async def test_first_failure_sets_retry_count_1(self, repo):
        """First failure: retry_count goes from 0 to 1."""
        r, gw = repo
        queue_id = uuid4()
        gw.select.return_value = [{"id": str(queue_id), "retry_count": 0}]

        await r.mark_batch_failed(queue_id, "first failure")

        call_args = gw.update.call_args
        data = call_args.kwargs.get("data") or call_args[1].get("data")
        assert data["retry_count"] == 1
        assert data["status"] == "pending"


class TestGetQueueStats:

    @pytest.mark.asyncio
    async def test_correct_rpc_call(self, repo):
        r, gw = repo
        gw.rpc.return_value = [{"pending_count": 2, "processing_count": 1, "failed_count": 0, "oldest_pending": "2026-02-09T10:00:00"}]

        result = await r.get_queue_stats()

        gw.rpc.assert_called_once_with("get_proactive_queue_stats", params={})
        assert result["pending_count"] == 2
        assert result["processing_count"] == 1
        assert result["failed_count"] == 0

    @pytest.mark.asyncio
    async def test_error_returns_default(self, repo):
        r, gw = repo
        gw.rpc.side_effect = Exception("DB error")

        result = await r.get_queue_stats()
        assert result["pending_count"] == 0
        assert result["oldest_pending"] is None


# ===========================================================================
# Coverage extension: constructor SupabaseClient path, insert error,
# get_recent_runs, find_similar_runs, get_pending_batches
# ===========================================================================

class TestConstructorSupabaseClient:
    """Coverage for line 48: SupabaseClient isinstance path."""

    def test_accepts_supabase_client(self):
        from data.database.clients.supabase import SupabaseClient
        mock_client = MagicMock(spec=SupabaseClient)
        # Patch only __init__ so isinstance checks still work correctly
        with patch.object(SupabasePersistenceGateway, "__init__", return_value=None):
            repo = ProactiveAgentRepository(db=mock_client)
            # Verify the SupabaseClient branch (line 48) was taken
            assert isinstance(repo._gateway, SupabasePersistenceGateway)
            # The gateway is a real SupabasePersistenceGateway (not the mock_client)
            assert repo._gateway is not mock_client


class TestInsertError:
    """Coverage for lines 161-163: insert error path."""

    @pytest.fixture
    def repo(self):
        gw = _make_gateway()
        return ProactiveAgentRepository(db=gw), gw

    @pytest.mark.asyncio
    async def test_insert_error_propagates(self, repo):
        r, gw = repo
        gw.insert.side_effect = RuntimeError("insert failed")
        with pytest.raises(RuntimeError, match="insert failed"):
            await r.insert_agent_run(
                query_ids=["q1"],
                queries=["test query"],
                source_docs=[],
                day_date="2026-02-10",
                decision="defer",
            )


class TestGetRecentRuns:
    """Coverage for lines 217-223: get_recent_runs with filters."""

    @pytest.fixture
    def repo(self):
        gw = _make_gateway()
        return ProactiveAgentRepository(db=gw), gw

    @pytest.mark.asyncio
    async def test_get_recent_runs_no_filter(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": "r1"}]
        result = await r.get_recent_runs()
        assert result == [{"id": "r1"}]
        gw.select.assert_awaited_once()
        call_kwargs = gw.select.call_args
        assert call_kwargs[0][0] == "proactive_agent_runs"
        filters = call_kwargs[1]["filters"]
        # Verify created_at filter has gte with ISO datetime string
        assert "created_at" in filters
        assert "gte" in filters["created_at"]
        assert isinstance(filters["created_at"]["gte"], str)
        # No decision filter when not provided
        assert "decision" not in filters
        assert call_kwargs[1]["order_by"] == "created_at.desc"
        assert call_kwargs[1]["limit"] == 100  # default limit

    @pytest.mark.asyncio
    async def test_get_recent_runs_with_decision_filter(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_recent_runs(decision="intervene", days=3, limit=50)
        call_kwargs = gw.select.call_args
        filters = call_kwargs[1]["filters"]
        assert filters["decision"] == "intervene"
        assert call_kwargs[1]["limit"] == 50


class TestFindSimilarRuns:
    """Coverage for line 249: find_similar_runs."""

    @pytest.fixture
    def repo(self):
        gw = _make_gateway()
        return ProactiveAgentRepository(db=gw), gw

    @pytest.mark.asyncio
    async def test_find_similar_runs(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": "r1", "queries": ["test"]}]
        result = await r.find_similar_runs(queries=["test"], limit=5)
        assert result == [{"id": "r1", "queries": ["test"]}]
        gw.select.assert_awaited_once()
        call_kwargs = gw.select.call_args
        assert call_kwargs[0][0] == "proactive_agent_runs"
        assert call_kwargs[1]["filters"] is None  # Legacy method: no server-side filter
        assert call_kwargs[1]["order_by"] == "created_at.desc"
        assert call_kwargs[1]["limit"] == 5


class TestGetPendingBatches:
    """Coverage for line 399: get_pending_batches."""

    @pytest.fixture
    def repo(self):
        gw = _make_gateway()
        return ProactiveAgentRepository(db=gw), gw

    @pytest.mark.asyncio
    async def test_get_pending_batches(self, repo):
        r, gw = repo
        gw.select.return_value = [{"id": "q1", "status": "pending", "priority": 8}]
        result = await r.get_pending_batches(limit=10)
        assert result == [{"id": "q1", "status": "pending", "priority": 8}]
        gw.select.assert_awaited_once()
        call_kwargs = gw.select.call_args
        assert call_kwargs[0][0] == "proactive_agent_queue"
        assert call_kwargs[1]["filters"] == {"status": "pending"}
        assert call_kwargs[1]["order_by"] == "priority.desc,created_at.asc"
        assert call_kwargs[1]["limit"] == 10
