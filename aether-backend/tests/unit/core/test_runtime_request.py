"""
Unit Tests: RequestTracker (core/runtime/request.py)

Covers request lifecycle (start/complete/fail/cancel/end), context manager,
stale cleanup, client filtering, health status, and async-safe concurrency.

Mock boundaries: None — pure logic with asyncio.Lock.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from core.runtime.request import RequestTracker


# ─── Constructor ──────────────────────────────────────────────────────────────


class TestRequestTrackerInit:
    def test_initial_state(self):
        tracker = RequestTracker()
        assert tracker._active_requests == {}
        assert isinstance(tracker._lock, asyncio.Lock)

    def test_initial_counts(self):
        tracker = RequestTracker()
        assert tracker.get_request_count() == 0
        assert tracker.get_active_requests() == {}


# ─── start_request() ─────────────────────────────────────────────────────────


class TestStartRequest:
    async def test_basic_start(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1", "client-A", text="hello")

        info = tracker._active_requests["req-1"]
        assert info["cancelled"] is False
        assert info["state"] == "running"
        assert info["client_id"] == "client-A"
        assert info["text"] == "hello"
        assert info["result"] is None
        assert info["error"] is None
        assert info["completed_at"] is None
        assert isinstance(info["start_time"], float)
        assert isinstance(info["last_activity"], float)
        assert info["start_time"] == info["last_activity"]

    async def test_default_client_id(self):
        tracker = RequestTracker()
        await tracker.start_request("req-2")
        assert tracker._active_requests["req-2"]["client_id"] == "anonymous"

    async def test_text_truncation(self):
        tracker = RequestTracker()
        long_text = "x" * 200
        await tracker.start_request("req-3", text=long_text)

        stored_text = tracker._active_requests["req-3"]["text"]
        assert len(stored_text) == 103  # 100 chars + "..."
        assert stored_text.endswith("...")

    async def test_short_text_no_truncation(self):
        tracker = RequestTracker()
        await tracker.start_request("req-4", text="short")
        assert tracker._active_requests["req-4"]["text"] == "short"

    async def test_chat_id_stored(self):
        tracker = RequestTracker()
        await tracker.start_request("req-5", chat_id="chat-42")
        assert tracker._active_requests["req-5"]["chat_id"] == "chat-42"

    async def test_chat_id_default_none(self):
        tracker = RequestTracker()
        await tracker.start_request("req-6")
        assert tracker._active_requests["req-6"]["chat_id"] is None


# ─── get_status() ─────────────────────────────────────────────────────────────


class TestGetStatus:
    async def test_returns_copy(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1", "client-A")

        status = await tracker.get_status("req-1")
        assert status is not None
        assert status["client_id"] == "client-A"
        assert status["state"] == "running"

        # Mutating the copy must not affect the original
        status["state"] = "hacked"
        original = tracker._active_requests["req-1"]
        assert original["state"] == "running"

    async def test_returns_none_for_unknown(self):
        tracker = RequestTracker()
        assert await tracker.get_status("nonexistent") is None


# ─── complete_request() ──────────────────────────────────────────────────────


class TestCompleteRequest:
    async def test_marks_completed(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")

        await tracker.complete_request("req-1", result={"status": "ok"})

        info = tracker._active_requests["req-1"]
        assert info["state"] == "completed"
        assert info["cancelled"] is False
        assert info["result"] == {"status": "ok"}
        assert info["completed_at"] is not None
        assert info["last_activity"] == info["completed_at"]

    async def test_unknown_request_ignored(self):
        tracker = RequestTracker()
        await tracker.complete_request("nonexistent", result={"x": 1})
        assert tracker.get_request_count() == 0

    async def test_result_default_none(self):
        tracker = RequestTracker()
        await tracker.start_request("req-2")
        await tracker.complete_request("req-2")
        assert tracker._active_requests["req-2"]["result"] is None


# ─── fail_request() ──────────────────────────────────────────────────────────


class TestFailRequest:
    async def test_marks_failed(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")

        await tracker.fail_request("req-1", error="Something broke")

        info = tracker._active_requests["req-1"]
        assert info["state"] == "failed"
        assert info["cancelled"] is False
        assert info["error"] == "Something broke"
        assert info["completed_at"] is not None

    async def test_unknown_request_ignored(self):
        tracker = RequestTracker()
        await tracker.fail_request("nonexistent", error="boom")
        assert tracker.get_request_count() == 0


# ─── cancel_request() ────────────────────────────────────────────────────────


class TestCancelRequest:
    async def test_cancels_existing(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")

        result = await tracker.cancel_request("req-1")

        assert result is True
        info = tracker._active_requests["req-1"]
        assert info["cancelled"] is True
        assert info["state"] == "cancelled"
        assert info["completed_at"] is not None

    async def test_returns_false_for_unknown(self):
        tracker = RequestTracker()
        result = await tracker.cancel_request("nonexistent")
        assert result is False


# ─── is_cancelled() ──────────────────────────────────────────────────────────


class TestIsCancelled:
    async def test_running_is_not_cancelled(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")
        assert tracker.is_cancelled("req-1") is False

    async def test_cancelled_is_cancelled(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")
        await tracker.cancel_request("req-1")
        assert tracker.is_cancelled("req-1") is True

    def test_unknown_defaults_to_cancelled(self):
        tracker = RequestTracker()
        assert tracker.is_cancelled("nonexistent") is True


# ─── update_activity() ───────────────────────────────────────────────────────


class TestUpdateActivity:
    async def test_updates_timestamp(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")
        original_time = tracker._active_requests["req-1"]["last_activity"]

        await asyncio.sleep(0.01)
        await tracker.update_activity("req-1")

        new_time = tracker._active_requests["req-1"]["last_activity"]
        assert new_time > original_time

    async def test_unknown_ignored(self):
        tracker = RequestTracker()
        await tracker.update_activity("nonexistent")
        assert tracker.get_request_count() == 0


# ─── end_request() ───────────────────────────────────────────────────────────


class TestEndRequest:
    async def test_removes_request(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")
        assert tracker.get_request_count() == 1

        await tracker.end_request("req-1")
        assert tracker.get_request_count() == 0
        assert "req-1" not in tracker._active_requests

    async def test_unknown_ignored(self):
        tracker = RequestTracker()
        await tracker.end_request("nonexistent")
        assert tracker.get_request_count() == 0


# ─── get_active_requests() ───────────────────────────────────────────────────


class TestGetActiveRequests:
    async def test_returns_copy(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")

        active = tracker.get_active_requests()
        assert "req-1" in active

        # Mutating returned dict must not affect tracker
        del active["req-1"]
        assert "req-1" in tracker._active_requests

    async def test_empty_when_nothing_tracked(self):
        tracker = RequestTracker()
        assert tracker.get_active_requests() == {}


# ─── get_request_count() ─────────────────────────────────────────────────────


class TestGetRequestCount:
    async def test_counts_correctly(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")
        await tracker.start_request("req-2")
        assert tracker.get_request_count() == 2

        await tracker.end_request("req-1")
        assert tracker.get_request_count() == 1


# ─── cleanup_stale_requests() ────────────────────────────────────────────────


class TestCleanupStaleRequests:
    async def test_removes_stale_requests(self):
        tracker = RequestTracker()
        await tracker.start_request("req-old")

        # Manually backdate the request
        tracker._active_requests["req-old"]["last_activity"] = time.time() - 7200
        tracker._active_requests["req-old"]["start_time"] = time.time() - 7200

        await tracker.start_request("req-new")

        cleaned = await tracker.cleanup_stale_requests(max_age_seconds=3600)

        assert cleaned == 1
        assert "req-old" not in tracker._active_requests
        assert "req-new" in tracker._active_requests

    async def test_no_stale_requests(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")

        cleaned = await tracker.cleanup_stale_requests(max_age_seconds=3600)
        assert cleaned == 0

    async def test_empty_tracker(self):
        tracker = RequestTracker()
        cleaned = await tracker.cleanup_stale_requests()
        assert cleaned == 0

    async def test_uses_start_time_fallback(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")

        # Remove last_activity to test fallback to start_time
        info = tracker._active_requests["req-1"]
        del info["last_activity"]
        info["start_time"] = time.time() - 7200

        cleaned = await tracker.cleanup_stale_requests(max_age_seconds=3600)
        assert cleaned == 1


# ─── get_request_info() ──────────────────────────────────────────────────────


class TestGetRequestInfo:
    async def test_returns_info(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1", "client-A")

        info = tracker.get_request_info("req-1")
        assert info is not None
        assert info["client_id"] == "client-A"

    def test_returns_none_for_unknown(self):
        tracker = RequestTracker()
        assert tracker.get_request_info("nonexistent") is None


# ─── cancel_all_requests() ───────────────────────────────────────────────────


class TestCancelAllRequests:
    async def test_cancels_all(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")
        await tracker.start_request("req-2")
        await tracker.start_request("req-3")

        count = await tracker.cancel_all_requests()

        assert count == 3
        for rid in ["req-1", "req-2", "req-3"]:
            assert tracker._active_requests[rid]["cancelled"] is True
            assert tracker._active_requests[rid]["state"] == "cancelled"

    async def test_returns_zero_when_empty(self):
        tracker = RequestTracker()
        count = await tracker.cancel_all_requests()
        assert count == 0


# ─── get_requests_by_client() ────────────────────────────────────────────────


class TestGetRequestsByClient:
    async def test_filters_by_client(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1", "client-A")
        await tracker.start_request("req-2", "client-B")
        await tracker.start_request("req-3", "client-A")

        result = tracker.get_requests_by_client("client-A")
        assert set(result.keys()) == {"req-1", "req-3"}

    async def test_returns_copies(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1", "client-A")

        result = tracker.get_requests_by_client("client-A")
        result["req-1"]["state"] = "hacked"
        assert tracker._active_requests["req-1"]["state"] == "running"

    async def test_no_matching_client(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1", "client-A")
        assert tracker.get_requests_by_client("client-Z") == {}


# ─── get_health_status() ─────────────────────────────────────────────────────


class TestGetHealthStatus:
    async def test_empty_tracker(self):
        tracker = RequestTracker()
        status = tracker.get_health_status()
        assert status == {
            "active_requests": 0,
            "cancelled_requests": 0,
            "active_non_cancelled": 0,
        }

    async def test_mixed_requests(self):
        tracker = RequestTracker()
        await tracker.start_request("req-1")
        await tracker.start_request("req-2")
        await tracker.start_request("req-3")
        await tracker.cancel_request("req-2")

        status = tracker.get_health_status()
        assert status["active_requests"] == 3
        assert status["cancelled_requests"] == 1
        assert status["active_non_cancelled"] == 2


# ─── request_context() ───────────────────────────────────────────────────────


class TestRequestContext:
    async def test_success_path(self):
        tracker = RequestTracker()

        async with tracker.request_context("req-1", client_id="c1", text="test"):
            status = await tracker.get_status("req-1")
            assert status["state"] == "running"

        info = tracker._active_requests["req-1"]
        assert info["state"] == "completed"

    async def test_exception_marks_failed(self):
        tracker = RequestTracker()

        with pytest.raises(ValueError, match="boom"):
            async with tracker.request_context("req-2"):
                raise ValueError("boom")

        info = tracker._active_requests["req-2"]
        assert info["state"] == "failed"
        assert info["error"] == "boom"

    async def test_cancelled_error_re_raised(self):
        tracker = RequestTracker()

        with pytest.raises(asyncio.CancelledError):
            async with tracker.request_context("req-3"):
                raise asyncio.CancelledError()

    async def test_timeout_exceeded(self):
        tracker = RequestTracker()

        with pytest.raises(TimeoutError, match="exceeded timeout"):
            async with tracker.request_context("req-4", timeout=0.0):
                await asyncio.sleep(0.01)

        info = tracker._active_requests["req-4"]
        assert info["state"] == "failed"
        assert "timeout" in info["error"].lower()

    async def test_within_timeout(self):
        tracker = RequestTracker()

        async with tracker.request_context("req-5", timeout=10.0):
            pass

        info = tracker._active_requests["req-5"]
        assert info["state"] == "completed"
