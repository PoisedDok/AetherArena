"""
Tests for data/database/concurrency.py

Covers: with_retry (success, retry on transient, exhaustion, conflict passthrough,
non-retryable), with_optimistic_lock (success, conflict detection, conflict retry,
record not found), concurrent_safe decorator, safe_upsert.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from datetime import datetime, timezone

from data.database.concurrency import (
    with_retry,
    with_optimistic_lock,
    concurrent_safe,
    safe_upsert,
    ConflictError,
    RetryableError,
)


# ===========================================================================
# with_retry
# ===========================================================================

class TestWithRetry:

    @pytest.mark.asyncio
    async def test_success_first_attempt(self):
        op = AsyncMock(return_value="ok")
        result = await with_retry(op, max_retries=3, initial_delay=0.01)
        assert result == "ok"
        assert op.call_count == 1

    @pytest.mark.asyncio
    async def test_retry_on_retryable_error(self):
        op = AsyncMock(side_effect=[RetryableError("transient"), "ok"])
        result = await with_retry(op, max_retries=3, initial_delay=0.01)
        assert result == "ok"
        assert op.call_count == 2

    @pytest.mark.asyncio
    async def test_retry_on_connection_error(self):
        op = AsyncMock(side_effect=[ConnectionError("fail"), "ok"])
        result = await with_retry(op, max_retries=3, initial_delay=0.01)
        assert result == "ok"

    @pytest.mark.asyncio
    async def test_retry_on_timeout_error(self):
        op = AsyncMock(side_effect=[TimeoutError("timed out"), "ok"])
        result = await with_retry(op, max_retries=3, initial_delay=0.01)
        assert result == "ok"

    @pytest.mark.asyncio
    async def test_exhausted_retries_raises(self):
        op = AsyncMock(side_effect=RetryableError("always fails"))
        with pytest.raises(RetryableError):
            await with_retry(op, max_retries=2, initial_delay=0.01)
        assert op.call_count == 3  # 1 initial + 2 retries

    @pytest.mark.asyncio
    async def test_conflict_not_retried(self):
        op = AsyncMock(side_effect=ConflictError("concurrent mod"))
        with pytest.raises(ConflictError):
            await with_retry(op, max_retries=3, initial_delay=0.01)
        assert op.call_count == 1  # No retry

    @pytest.mark.asyncio
    async def test_non_retryable_raises_immediately(self):
        op = AsyncMock(side_effect=ValueError("bad data"))
        with pytest.raises(ValueError):
            await with_retry(op, max_retries=3, initial_delay=0.01)
        assert op.call_count == 1

    @pytest.mark.asyncio
    async def test_backoff_respects_max_delay(self):
        op = AsyncMock(side_effect=[RetryableError("1"), RetryableError("2"), "ok"])
        result = await with_retry(
            op, max_retries=3, initial_delay=0.01, max_delay=0.02, backoff_factor=10.0
        )
        assert result == "ok"


# ===========================================================================
# with_optimistic_lock
# ===========================================================================

class TestWithOptimisticLock:

    @pytest.mark.asyncio
    async def test_success(self):
        db = MagicMock()
        now = datetime.now(timezone.utc).isoformat()
        db.select = AsyncMock(return_value=[{"id": "r1", "updated_at": now}])
        db.update = AsyncMock(return_value={"id": "r1", "title": "New"})
        result = await with_optimistic_lock(
            db, "chats", "r1", expected_version=now, updates={"title": "New"}
        )
        assert result["title"] == "New"

    @pytest.mark.asyncio
    async def test_conflict_detected(self):
        db = MagicMock()
        db.select = AsyncMock(return_value=[{"id": "r1", "updated_at": "2026-01-02"}])
        with pytest.raises(ConflictError, match="Concurrent modification"):
            await with_optimistic_lock(
                db, "chats", "r1",
                expected_version="2026-01-01",  # Mismatch
                updates={"title": "X"},
                max_retries=1,
            )

    @pytest.mark.asyncio
    async def test_record_not_found(self):
        db = MagicMock()
        db.select = AsyncMock(return_value=[])
        with pytest.raises(ValueError, match="Record not found"):
            await with_optimistic_lock(
                db, "chats", "r1", expected_version=None, updates={"title": "X"}
            )

    @pytest.mark.asyncio
    async def test_none_expected_version_skips_check(self):
        db = MagicMock()
        db.select = AsyncMock(return_value=[{"id": "r1", "updated_at": "2026-01-01"}])
        db.update = AsyncMock(return_value={"id": "r1"})
        result = await with_optimistic_lock(
            db, "chats", "r1", expected_version=None, updates={"title": "Y"}
        )
        assert result is not None

    @pytest.mark.asyncio
    async def test_conflict_retry_succeeds_on_second_attempt(self):
        """Coverage for lines 215-228: conflict retry with re-read.
        
        First attempt: DB returns version "v2" but we expected "v1" -> ConflictError.
        Retry path re-reads fresh version "v2", second attempt matches -> success.
        """
        db = MagicMock()
        db.select = AsyncMock(side_effect=[
            [{"id": "r1", "updated_at": "v2"}],   # 1st attempt: expected v1, got v2 -> conflict
            [{"id": "r1", "updated_at": "v2"}],   # re-read after conflict (line 222-228)
            [{"id": "r1", "updated_at": "v2"}],   # 2nd attempt: now expected v2, got v2 -> match
        ])
        db.update = AsyncMock(return_value={"id": "r1", "updated_at": "v3"})
        result = await with_optimistic_lock(
            db, "chats", "r1",
            expected_version="v1",  # Mismatches v2 -> triggers ConflictError on 1st attempt
            updates={"title": "Z"},
            max_retries=2,
        )
        assert result == {"id": "r1", "updated_at": "v3"}
        # select called 3 times: initial check, re-read after conflict, 2nd attempt check
        assert db.select.call_count == 3
        # update called once (on successful 2nd attempt)
        db.update.assert_called_once()


# ===========================================================================
# concurrent_safe decorator
# ===========================================================================

class TestConcurrentSafe:

    @pytest.mark.asyncio
    async def test_wraps_with_retry(self):
        call_count = 0

        @concurrent_safe(max_retries=2)
        async def flaky():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise RetryableError("transient")
            return "ok"

        result = await flaky()
        assert result == "ok"
        assert call_count == 2


# ===========================================================================
# safe_upsert
# ===========================================================================

class TestSafeUpsert:

    @pytest.mark.asyncio
    async def test_success(self):
        db = MagicMock()
        db.upsert = AsyncMock(return_value={"id": "r1"})
        result = await safe_upsert(
            db, "tools", {"name": "t1"}, conflict_columns=["name"]
        )
        assert result == {"id": "r1"}
        db.upsert.assert_called_once()

    @pytest.mark.asyncio
    async def test_retry_on_failure(self):
        db = MagicMock()
        db.upsert = AsyncMock(side_effect=[RetryableError("fail"), {"id": "r2"}])
        result = await safe_upsert(
            db, "tools", {"name": "t1"}, conflict_columns=["name"], max_retries=2
        )
        assert result == {"id": "r2"}
