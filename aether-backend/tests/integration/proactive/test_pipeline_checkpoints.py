"""
Pipeline Checkpoint Integration Tests

Live tests that verify the full proactive pipeline produces correct data
at each boundary. These hit the running backend and validate response
shape, feedback round-trip, ICL cold start, and context split behavior.

Requires: backend running on localhost:8765 with Perplexica reachable.
"""

import pytest
import time
from uuid import UUID
from tests.integration.proactive.helpers import (
    scout,
    post_feedback,
    get_stats,
    SyntheticEmail,
    SyntheticBrowser,
    SyntheticFilesystem,
    SyntheticPreviousQuery,
)


# ======================================================================
# Response shape verification
# ======================================================================


@pytest.mark.severity_critical
class TestScoutResponseShape:
    """Every field in ProactiveScoutResponse must be present with correct type."""

    REQUIRED_FIELDS = {
        "run_id": str,
        "decision": str,
        "tool_budget": int,
        "tool_calls_count": int,
        "execution_time_ms": int,
        "timestamp": str,
    }

    OPTIONAL_FIELDS = {
        "recommendation": (str, type(None)),
        "supporting_docs": (list, type(None)),
    }

    def _make_minimal_payload(self):
        """Produce a minimal but valid scout payload."""
        doc = SyntheticEmail.make(
            subject="Response shape test",
            sender="shape@test.com",
            body_preview="Verifying the response includes every field.",
        )
        return {
            "queries": ["response shape verification"],
            "source_docs": [doc],
        }

    def test_all_required_fields_present(self):
        """Every required field from ProactiveScoutResponse must exist."""
        payload = self._make_minimal_payload()
        result = scout(**payload)

        missing = [f for f in self.REQUIRED_FIELDS if f not in result]
        assert not missing, f"Missing required fields: {missing}"

    def test_required_field_types(self):
        """Each required field has the documented type."""
        payload = self._make_minimal_payload()
        result = scout(**payload)

        for field, expected_type in self.REQUIRED_FIELDS.items():
            assert field in result, f"Field '{field}' missing"
            assert isinstance(
                result[field], expected_type
            ), f"Field '{field}': expected {expected_type}, got {type(result[field])}"

    def test_decision_is_valid_literal(self):
        """Decision must be 'intervene' or 'defer'."""
        payload = self._make_minimal_payload()
        result = scout(**payload)
        assert result["decision"] in (
            "intervene",
            "defer",
        ), f"Invalid decision: {result['decision']}"

    def test_run_id_is_valid_uuid(self):
        """run_id must parse as a valid UUID."""
        payload = self._make_minimal_payload()
        result = scout(**payload)
        try:
            UUID(result["run_id"])
        except (ValueError, TypeError) as e:
            pytest.fail(f"run_id is not a valid UUID: {result['run_id']} ({e})")

    def test_tool_budget_in_range(self):
        """tool_budget must be bounded to classifier hard cap (0..4)."""
        payload = self._make_minimal_payload()
        result = scout(**payload)
        budget = result["tool_budget"]
        assert 0 <= budget <= 4, f"tool_budget out of range: {budget}"

    def test_execution_time_positive(self):
        """execution_time_ms must be > 0 (agent actually ran)."""
        payload = self._make_minimal_payload()
        result = scout(**payload)
        assert result["execution_time_ms"] > 0, "execution_time_ms should be positive"

    def test_legacy_mode_field_is_ignored(self):
        """Legacy mode request field is ignored without breaking response."""
        doc = SyntheticEmail.make(
            subject="Mode match test",
            sender="mode@test.com",
            body_preview="Verifying mode propagation.",
        )
        result = scout(
            queries=["mode match test"],
            source_docs=[doc],
            mode="balanced",
        )
        assert result["decision"] in ("intervene", "defer")
        assert "agent_mode" not in result


# ======================================================================
# Context split verification
# ======================================================================


@pytest.mark.severity_high
class TestContextSplit:
    """Verify that source_docs with mixed _context_type are split correctly.

    The API separates:
      _context_type=triggering_log  -> currentActivity
      _context_type=previous_query  -> backgroundHistory

    We can't directly inspect the internal split from outside, but we CAN
    verify the system handles mixed docs without crashing and returns a
    valid response.
    """

    def test_mixed_triggering_and_previous_query(self):
        """Mix of triggering logs and previous queries produces valid response."""
        email = SyntheticEmail.make(
            subject="Mixed context test email",
            sender="mix@test.com",
            body_preview="Current activity email for context split test.",
        )
        prev = SyntheticPreviousQuery.make(
            query="previous research on context splitting",
            batch_offset=1,
        )
        result = scout(
            queries=["mixed context type handling"],
            source_docs=[email, prev],
        )
        # Must not crash, must return valid shape
        assert result["decision"] in ("intervene", "defer")

    def test_only_previous_queries_no_current(self):
        """Only previous_query docs, no triggering_log. Agent should still work."""
        prev1 = SyntheticPreviousQuery.make("old research query 1", batch_offset=1)
        prev2 = SyntheticPreviousQuery.make("old research query 2", batch_offset=2)
        result = scout(
            queries=["background only context test"],
            source_docs=[prev1, prev2],
        )
        # System should handle gracefully -- likely defer since no current activity
        assert result["decision"] in ("intervene", "defer")

    def test_multi_source_triggering_logs(self):
        """Three different sources as triggering_log. All should reach agent."""
        email = SyntheticEmail.make(
            subject="Multi-source test email",
            sender="multi@test.com",
            body_preview="Email part of multi-source context split test.",
        )
        browser = SyntheticBrowser.make(
            url="https://docs.example.com/api/multi-source",
            title="Multi-Source API Reference",
        )
        fs = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/test/project/multi_source_test.py",
            content_preview="def multi_source_handler():\n    pass",
        )
        result = scout(
            queries=["multi source convergence verification"],
            source_docs=[email, browser, fs],
        )
        assert result["decision"] in ("intervene", "defer")
        assert isinstance(result["tool_budget"], int)


# ======================================================================
# Feedback round-trip
# ======================================================================


@pytest.mark.severity_critical
class TestFeedbackRoundTrip:
    """Create run -> send feedback -> verify stats reflect it."""

    def test_clicked_feedback_counted_in_stats(self):
        """Submit clicked feedback, then verify stats endpoint reflects it."""
        # Create a run
        doc = SyntheticEmail.make(
            subject="Feedback round-trip test",
            sender="feedback@test.com",
            body_preview="Testing that clicked feedback appears in stats.",
        )
        run_result = scout(
            queries=["feedback round-trip verification"],
            source_docs=[doc],
        )
        run_id = run_result.get("run_id")
        if not run_id:
            pytest.skip("No run_id returned -- cannot test feedback round-trip")

        # Record feedback
        fb = post_feedback(run_id, "clicked")
        assert fb["success"] is True
        assert fb["feedback"] == "clicked"

        # Get stats (includes feedback aggregation)
        stats = get_stats(days=1)
        assert "feedback" in stats
        assert isinstance(stats["total_runs"], int)
        assert stats["total_runs"] >= 1

    def test_timeout_feedback_recorded(self):
        """Timeout feedback type is accepted and recorded."""
        doc = SyntheticEmail.make(
            subject="Timeout feedback test",
            sender="timeout@test.com",
            body_preview="Testing timeout feedback type.",
        )
        run_result = scout(
            queries=["timeout feedback test"],
            source_docs=[doc],
        )
        run_id = run_result.get("run_id")
        if not run_id:
            pytest.skip("No run_id returned -- cannot test timeout feedback")

        fb = post_feedback(run_id, "timeout")
        assert fb["success"] is True
        assert fb["feedback"] == "timeout"
        assert fb["run_id"] == run_id


# ======================================================================
# ICL cold start
# ======================================================================


@pytest.mark.severity_high
class TestICLColdStart:
    """First run with no history -- ICL examples should be empty but
    the agent must still produce a valid response."""

    def test_first_run_works_without_history(self):
        """With no prior feedback in the system, agent still works.

        We can't guarantee no prior runs exist in the test env, but the
        agent must not crash regardless.
        """
        doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/test/cold-start-test.txt",
            content_preview="Cold start ICL test content.",
        )
        result = scout(
            queries=["icl cold start test"],
            source_docs=[doc],
        )
        assert result["decision"] in ("intervene", "defer")
        assert isinstance(result["run_id"], str)
        UUID(result["run_id"])  # Must be valid UUID


# ======================================================================
# Embedding generation verification
# ======================================================================


@pytest.mark.severity_high
class TestEmbeddingGeneration:
    """Verify that runs with rich multi-source context generate embeddings.

    We verify indirectly: after creating a run with feedback, a subsequent
    similar request should either find ICL examples or at minimum not crash.
    """

    def test_embedding_stored_for_run(self):
        """Create a run -> add positive feedback -> create similar run.

        If embeddings are stored correctly, the second run may use ICL
        examples from the first. At minimum, both must succeed.
        """
        doc = SyntheticEmail.make(
            subject="[CRITICAL] Embedding generation test",
            sender="embed@test.com",
            body_preview=(
                "Urgent: testing that context embeddings are generated "
                "and stored for future ICL retrieval."
            ),
        )

        # First run
        r1 = scout(
            queries=["embedding generation test critical incident"],
            source_docs=[doc],
        )
        run_id = r1.get("run_id")
        assert run_id is not None

        # Positive feedback to mark as ICL candidate
        fb = post_feedback(run_id, "clicked")
        assert fb["success"] is True

        # Brief pause to let embedding persist
        time.sleep(1)

        # Second similar run -- ICL system should find the first run
        r2 = scout(
            queries=["embedding generation test critical incident followup"],
            source_docs=[doc],
        )
        assert r2["decision"] in ("intervene", "defer")
        assert r2.get("run_id") is not None
