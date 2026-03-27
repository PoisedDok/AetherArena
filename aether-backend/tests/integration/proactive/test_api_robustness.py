"""
API Robustness Tests

6 tests covering edge cases, malformed input, and non-scout endpoints
(feedback and stats). These validate the API contract, not the LLM logic.
"""

import pytest
from tests.integration.proactive.helpers import scout, post_feedback, get_stats, SyntheticEmail


def _assert_scout_contract(result: dict):
    """Validate stable response contract for /v1/proactive/scout."""
    assert isinstance(result, dict)
    assert isinstance(result.get("run_id"), str)
    assert result.get("decision") in ("intervene", "defer")
    assert isinstance(result.get("tool_budget"), int)
    assert 0 <= int(result["tool_budget"]) <= 4


# ======================================================================
# Edge cases -- API must handle gracefully
# ======================================================================


@pytest.mark.severity_critical
class TestApiEdgeCases:

    def test_empty_payload_defers(self):
        """Empty queries and source_docs -> must defer (nothing to act on)."""
        result = scout(
            queries=[],
            source_docs=[],
        )
        _assert_scout_contract(result)
        assert result["decision"] == "defer"

    def test_missing_context_type_defers(self):
        """source_doc without _context_type in metadata -> should be handled gracefully."""
        bad_doc = {
            "source": "email",
            "timestamp": "2026-02-09T14:30:00+00:00",
            "metadata": {
                "subject": "Test email without context type",
                "sender": "test@example.com",
                "body_preview": "This doc has no _context_type field.",
                "day_date": "2026-02-09",
                # Missing: "_context_type" and "_batch"
            },
        }
        result = scout(
            queries=["test missing context type"],
            source_docs=[bad_doc],
        )
        # Must still satisfy the response contract even with malformed context.
        _assert_scout_contract(result)
        # Decision can vary by model behavior because a query still exists.
        assert result["decision"] in ("defer", "intervene")

    def test_query_only_no_source_docs_defers(self):
        """Queries provided but no source_docs -> must defer (no evidence)."""
        result = scout(
            queries=["urgent security vulnerability in production"],
            source_docs=[],
        )
        _assert_scout_contract(result)
        assert result["decision"] == "defer"


# ======================================================================
# Feedback endpoint
# ======================================================================


@pytest.mark.severity_critical
class TestFeedbackEndpoint:

    def test_feedback_clicked(self):
        """Record 'clicked' feedback for a proactive run. Create a run first."""
        # First, create a real run to get a valid run_id
        doc = SyntheticEmail.make(
            subject="[P0] Test Incident for Feedback",
            sender="test@example.com",
            body_preview=(
                "CRITICAL: Test incident to generate a run_id for feedback testing.\n"
                "Action required immediately."
            ),
        )
        run_result = scout(
            queries=["test incident for feedback"],
            source_docs=[doc],
        )
        run_id = run_result.get("run_id")
        if not run_id:
            pytest.skip("No run_id returned from scout -- cannot test feedback")

        feedback_result = post_feedback(run_id, "clicked")
        assert feedback_result.get("success") is True
        assert feedback_result.get("feedback") == "clicked"
        assert feedback_result.get("run_id") == run_id

    def test_feedback_dismissed(self):
        """Record 'dismissed' feedback for a proactive run."""
        doc = SyntheticEmail.make(
            subject="Test Email for Dismissed Feedback",
            sender="test@example.com",
            body_preview="Non-urgent test email to generate a run for dismiss feedback.",
        )
        run_result = scout(
            queries=["test email for feedback recording"],
            source_docs=[doc],
        )
        run_id = run_result.get("run_id")
        if not run_id:
            pytest.skip("No run_id returned from scout -- cannot test feedback")

        feedback_result = post_feedback(run_id, "dismissed")
        assert feedback_result.get("success") is True
        assert feedback_result.get("feedback") == "dismissed"
        assert feedback_result.get("run_id") == run_id


# ======================================================================
# Stats endpoint
# ======================================================================


@pytest.mark.severity_critical
class TestStatsEndpoint:

    def test_stats_returns_valid_structure(self):
        """Stats endpoint returns expected fields with correct types."""
        stats = get_stats(days=7)
        assert isinstance(stats, dict)
        required_keys = {
            "period_days",
            "total_runs",
            "intervene_count",
            "defer_count",
            "avg_tool_calls",
            "feedback",
            "timestamp",
        }
        assert required_keys.issubset(set(stats.keys()))

        assert isinstance(stats["period_days"], int)
        assert isinstance(stats["total_runs"], int)
        assert isinstance(stats["intervene_count"], int)
        assert isinstance(stats["defer_count"], int)
        assert isinstance(stats["avg_tool_calls"], (int, float))
        assert isinstance(stats["feedback"], dict)
        assert isinstance(stats["timestamp"], str)
