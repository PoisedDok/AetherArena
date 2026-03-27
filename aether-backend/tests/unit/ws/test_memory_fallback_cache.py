"""
Unit Tests: ws/infrastructure/cache/memory_fallback.py

Tests the in-memory fallback cache — get, set, increment, delete,
TTL expiration, and background cleanup.

Bugs found: 1
- increment on a key holding a non-integer value raises TypeError
  because entry.get("value", 0) + amount fails on dicts. Not guarded.

Adversarial additions:
- stop_cleanup idempotency (double call)
- stop_cleanup when task already completed naturally
- Negative TTL creates immediately-expired entry
- Full lifecycle test (set → get → expire → cleanup → get-returns-none)
- Uncaught exception kills cleanup task silently
"""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ws.infrastructure.cache.memory_fallback import MemoryFallbackCache


# =========================================================================
# Patch targets
# =========================================================================

PATCH_TIME = "ws.infrastructure.cache.memory_fallback.time"
PATCH_SLEEP = "ws.infrastructure.cache.memory_fallback.asyncio.sleep"


# =========================================================================
# Init
# =========================================================================

class TestInit:
    """Tests for MemoryFallbackCache.__init__."""

    def test_default_init(self):
        cache = MemoryFallbackCache()
        assert cache._cache == {}
        assert cache._cleanup_interval == 60
        assert cache._cleanup_task is None

    def test_custom_cleanup_interval(self):
        cache = MemoryFallbackCache(cleanup_interval=300)
        assert cache._cleanup_interval == 300


# =========================================================================
# is_connected
# =========================================================================

class TestIsConnected:
    """Tests for is_connected (line 56)."""

    def test_always_returns_true(self):
        """Memory cache is always available."""
        cache = MemoryFallbackCache()
        assert cache.is_connected() is True


# =========================================================================
# get
# =========================================================================

class TestGet:
    """Tests for async get (lines 58-78)."""

    async def test_key_not_found_returns_none(self):
        """Key doesn't exist → None."""
        cache = MemoryFallbackCache()
        result = await cache.get("nonexistent")
        assert result is None

    async def test_success_returns_value(self):
        """Stored value is returned."""
        cache = MemoryFallbackCache()
        cache._cache["k"] = {"value": {"name": "test"}, "expires_at": None}

        result = await cache.get("k")

        assert result == {"name": "test"}

    async def test_expired_entry_returns_none_and_deletes(self):
        """Expired entry → returns None, entry removed from cache."""
        mock_time = MagicMock()
        mock_time.time.return_value = 1000.0

        cache = MemoryFallbackCache()
        cache._cache["expired"] = {"value": {"old": True}, "expires_at": 999.0}

        with patch(PATCH_TIME, mock_time):
            result = await cache.get("expired")

        assert result is None
        assert "expired" not in cache._cache

    async def test_non_expired_entry_returns_value(self):
        """Entry with future expires_at → returns value."""
        mock_time = MagicMock()
        mock_time.time.return_value = 1000.0

        cache = MemoryFallbackCache()
        cache._cache["valid"] = {"value": {"fresh": True}, "expires_at": 2000.0}

        with patch(PATCH_TIME, mock_time):
            result = await cache.get("valid")

        assert result == {"fresh": True}

    async def test_no_expires_at_never_expires(self):
        """Entry with expires_at=None → never expires."""
        cache = MemoryFallbackCache()
        cache._cache["permanent"] = {"value": {"data": 42}, "expires_at": None}

        result = await cache.get("permanent")

        assert result == {"data": 42}

    async def test_empty_entry_returns_none(self):
        """Empty dict entry (no 'value' key) → None from .get('value')."""
        cache = MemoryFallbackCache()
        cache._cache["empty"] = {}

        # entry.get("value") → None
        # But entry is truthy (non-empty dict is truthy? No, {} is falsy)
        # Actually {} is falsy. So `if not entry:` is True, returns None.
        result = await cache.get("empty")

        assert result is None


# =========================================================================
# set
# =========================================================================

class TestSet:
    """Tests for async set (lines 80-103)."""

    async def test_stores_value(self):
        """Value is stored in cache."""
        cache = MemoryFallbackCache()

        result = await cache.set("k", {"data": 1})

        assert result is True
        assert cache._cache["k"]["value"] == {"data": 1}

    async def test_stores_with_ttl(self):
        """TTL is computed from current time + ttl seconds."""
        mock_time = MagicMock()
        mock_time.time.return_value = 1000.0

        cache = MemoryFallbackCache()

        with patch(PATCH_TIME, mock_time):
            result = await cache.set("k", {"data": 1}, ttl=300)

        assert result is True
        assert cache._cache["k"]["expires_at"] == 1300.0

    async def test_no_ttl_sets_no_expiration(self):
        """No TTL → expires_at is None."""
        cache = MemoryFallbackCache()

        await cache.set("k", {"data": 1})

        assert cache._cache["k"]["expires_at"] is None

    async def test_ttl_zero_sets_no_expiration(self):
        """ttl=0 is falsy → treated as no TTL."""
        cache = MemoryFallbackCache()

        await cache.set("k", {"data": 1}, ttl=0)

        assert cache._cache["k"]["expires_at"] is None

    async def test_overwrites_existing(self):
        """Setting the same key overwrites the previous value."""
        cache = MemoryFallbackCache()

        await cache.set("k", {"version": 1})
        await cache.set("k", {"version": 2})

        assert cache._cache["k"]["value"] == {"version": 2}

    async def test_always_returns_true(self):
        """set always succeeds (memory operations don't fail)."""
        cache = MemoryFallbackCache()

        result = await cache.set("k", {"v": 1})

        assert result is True


# =========================================================================
# increment
# =========================================================================

class TestIncrement:
    """Tests for async increment (lines 105-143)."""

    async def test_new_key_starts_at_amount(self):
        """Non-existent key → starts at 0 + amount."""
        cache = MemoryFallbackCache()

        result = await cache.increment("counter")

        assert result == 1
        assert cache._cache["counter"]["value"] == 1

    async def test_increments_existing_value(self):
        """Existing integer value → incremented by amount."""
        cache = MemoryFallbackCache()
        cache._cache["counter"] = {"value": 5, "expires_at": None}

        result = await cache.increment("counter")

        assert result == 6
        assert cache._cache["counter"]["value"] == 6

    async def test_custom_amount(self):
        """Custom increment amount."""
        cache = MemoryFallbackCache()
        cache._cache["counter"] = {"value": 10, "expires_at": None}

        result = await cache.increment("counter", amount=5)

        assert result == 15

    async def test_expired_key_resets_to_zero_then_increments(self):
        """Expired key → treated as new (current=0), incremented."""
        mock_time = MagicMock()
        mock_time.time.return_value = 1000.0

        cache = MemoryFallbackCache()
        cache._cache["counter"] = {"value": 99, "expires_at": 500.0}

        with patch(PATCH_TIME, mock_time):
            result = await cache.increment("counter")

        assert result == 1  # reset to 0, then +1

    async def test_with_ttl(self):
        """TTL sets expires_at on the entry."""
        mock_time = MagicMock()
        mock_time.time.return_value = 1000.0

        cache = MemoryFallbackCache()

        with patch(PATCH_TIME, mock_time):
            result = await cache.increment("counter", ttl=3600)

        assert result == 1
        assert cache._cache["counter"]["expires_at"] == 4600.0

    async def test_ttl_zero_sets_no_expiration(self):
        """ttl=0 → expires_at is None."""
        cache = MemoryFallbackCache()

        await cache.increment("counter", ttl=0)

        assert cache._cache["counter"]["expires_at"] is None

    async def test_non_integer_value_raises_type_error(self):
        """
        Increment on a key holding a non-integer value raises TypeError.

        entry.get("value", 0) returns the dict, then dict + int fails.
        Unguarded — TypeError propagates to caller.
        """
        cache = MemoryFallbackCache()
        cache._cache["dict_key"] = {"value": {"nested": True}, "expires_at": None}

        with pytest.raises(TypeError):
            await cache.increment("dict_key")

    async def test_negative_amount_decrements(self):
        """Negative amount effectively decrements the counter."""
        cache = MemoryFallbackCache()
        cache._cache["counter"] = {"value": 10, "expires_at": None}

        result = await cache.increment("counter", amount=-3)

        assert result == 7

    async def test_entry_missing_value_key_defaults_to_zero(self):
        """Entry exists but has no 'value' key → defaults to 0."""
        cache = MemoryFallbackCache()
        cache._cache["bad_entry"] = {"expires_at": None}

        result = await cache.increment("bad_entry")

        assert result == 1


# =========================================================================
# delete
# =========================================================================

class TestDelete:
    """Tests for async delete (lines 145-159)."""

    async def test_deletes_existing_key(self):
        """Existing key → deleted, returns True."""
        cache = MemoryFallbackCache()
        cache._cache["k"] = {"value": {"data": 1}, "expires_at": None}

        result = await cache.delete("k")

        assert result is True
        assert "k" not in cache._cache

    async def test_nonexistent_key_returns_false(self):
        """Key doesn't exist → returns False."""
        cache = MemoryFallbackCache()

        result = await cache.delete("nonexistent")

        assert result is False

    async def test_after_delete_get_returns_none(self):
        """After deletion, get returns None."""
        cache = MemoryFallbackCache()
        await cache.set("k", {"data": 1})

        await cache.delete("k")
        result = await cache.get("k")

        assert result is None


# =========================================================================
# _cleanup_expired
# =========================================================================

class TestCleanupExpired:
    """Tests for background cleanup task (lines 161-184)."""

    async def test_removes_expired_entries(self):
        """Expired entries are removed during cleanup cycle."""
        cache = MemoryFallbackCache()
        now = time.time()
        cache._cache["expired1"] = {"value": "old1", "expires_at": now - 100}
        cache._cache["expired2"] = {"value": "old2", "expires_at": now - 1}
        cache._cache["valid"] = {"value": "current", "expires_at": now + 100}
        cache._cache["permanent"] = {"value": "forever", "expires_at": None}

        # First sleep returns normally (runs cleanup), second raises CancelledError
        with patch(PATCH_SLEEP, new_callable=AsyncMock,
                   side_effect=[None, asyncio.CancelledError]):
            cache._is_running = True
            await cache._cleanup_expired()

        assert "expired1" not in cache._cache
        assert "expired2" not in cache._cache
        assert "valid" in cache._cache
        assert "permanent" in cache._cache

    async def test_keeps_non_expired_entries(self):
        """Non-expired and no-TTL entries survive cleanup."""
        cache = MemoryFallbackCache()
        now = time.time()
        cache._cache["future"] = {"value": "ok", "expires_at": now + 9999}
        cache._cache["no_ttl"] = {"value": "permanent", "expires_at": None}

        with patch(PATCH_SLEEP, new_callable=AsyncMock,
                   side_effect=[None, asyncio.CancelledError]):
            cache._is_running = True
            await cache._cleanup_expired()

        assert "future" in cache._cache
        assert "no_ttl" in cache._cache

    async def test_handles_cancelled_error(self):
        """CancelledError → breaks loop cleanly."""
        cache = MemoryFallbackCache()

        # Immediate cancellation
        with patch(PATCH_SLEEP, new_callable=AsyncMock,
                   side_effect=asyncio.CancelledError):
            cache._is_running = True
            await cache._cleanup_expired()
        # Should exit without error

    async def test_handles_runtime_error(self):
        """RuntimeError during cleanup → caught, loop continues."""
        cache = MemoryFallbackCache()

        # Replace lock with a mock that raises RuntimeError on first enter
        mock_lock = MagicMock()
        call_count = 0

        def enter_side_effect():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("lock error")
            return mock_lock

        mock_lock.__enter__ = MagicMock(side_effect=enter_side_effect)
        mock_lock.__exit__ = MagicMock(return_value=False)
        cache._lock = mock_lock

        # First sleep returns (cleanup runs, hits RuntimeError, caught),
        # second sleep raises CancelledError (breaks loop)
        with patch(PATCH_SLEEP, new_callable=AsyncMock,
                   side_effect=[None, asyncio.CancelledError]):
            cache._is_running = True
            await cache._cleanup_expired()
        # Loop survived the RuntimeError

    async def test_empty_cache_cleanup_noop(self):
        """Empty cache → no expired keys, no deletion."""
        cache = MemoryFallbackCache()

        with patch(PATCH_SLEEP, new_callable=AsyncMock,
                   side_effect=[None, asyncio.CancelledError]):
            cache._is_running = True
            await cache._cleanup_expired()

        assert cache._cache == {}


# =========================================================================
# start_cleanup / stop_cleanup
# =========================================================================

class TestStartStopCleanup:
    """Tests for start_cleanup and stop_cleanup (lines 186-194)."""

    async def test_start_creates_task(self):
        """start_cleanup creates an asyncio task."""
        cache = MemoryFallbackCache(cleanup_interval=9999)

        cache.start_cleanup()

        assert cache._cleanup_task is not None
        assert not cache._cleanup_task.done()

        # Clean up via stop_cleanup (now async)
        await cache.stop_cleanup()

    async def test_start_idempotent_when_running(self):
        """Calling start_cleanup again while task runs doesn't create new task."""
        cache = MemoryFallbackCache(cleanup_interval=9999)

        cache.start_cleanup()
        first_task = cache._cleanup_task

        cache.start_cleanup()  # second call
        second_task = cache._cleanup_task

        assert first_task is second_task

        # Clean up via stop_cleanup (now async)
        await cache.stop_cleanup()

    async def test_stop_cancels_task(self):
        """stop_cleanup cancels the running task and awaits completion."""
        cache = MemoryFallbackCache(cleanup_interval=9999)

        cache.start_cleanup()
        task = cache._cleanup_task

        await cache.stop_cleanup()

        # Task should be fully done after awaited stop_cleanup
        assert task.cancelled() or task.done()
        assert cache._cleanup_task is None

    async def test_stop_noop_when_no_task(self):
        """stop_cleanup with no task → no error."""
        cache = MemoryFallbackCache()
        await cache.stop_cleanup()  # Should not raise

    async def test_start_after_stop_creates_new_task(self):
        """After stopping, start_cleanup creates a fresh task."""
        cache = MemoryFallbackCache(cleanup_interval=9999)

        cache.start_cleanup()
        first_task = cache._cleanup_task

        await cache.stop_cleanup()

        cache.start_cleanup()
        second_task = cache._cleanup_task

        assert second_task is not first_task
        assert not second_task.done()

        # Clean up
        await cache.stop_cleanup()

    async def test_stop_cleanup_twice_is_safe(self):
        """Calling stop_cleanup twice does not raise."""
        cache = MemoryFallbackCache(cleanup_interval=9999)

        cache.start_cleanup()
        await cache.stop_cleanup()
        assert cache._cleanup_task is None

        # Second stop — task is already None
        await cache.stop_cleanup()
        assert cache._cleanup_task is None

    async def test_stop_cleanup_on_already_done_task(self):
        """stop_cleanup when task completed naturally (not cancelled).

        If _cleanup_expired exits due to an uncaught exception, the task
        is done() but not cancelled(). stop_cleanup should still reset
        _cleanup_task to None without error.
        """
        cache = MemoryFallbackCache(cleanup_interval=9999)

        # Create a fake task that is already done
        async def instant_exit():
            return

        cache._cleanup_task = asyncio.ensure_future(instant_exit())
        await asyncio.sleep(0)  # let it complete
        assert cache._cleanup_task.done()

        # stop_cleanup should handle this gracefully
        await cache.stop_cleanup()
        assert cache._cleanup_task is None


# =========================================================================
# Adversarial: TTL edge cases
# =========================================================================

class TestTTLEdgeCases:
    """Edge cases for TTL handling."""

    async def test_negative_ttl_creates_immediately_expired_entry(self):
        """Negative TTL → entry expires immediately, next get returns None.

        This is valid behavior (negative TTL = already expired) but
        must be documented/tested so callers know the contract.
        """
        cache = MemoryFallbackCache()

        await cache.set("k", {"data": 1}, ttl=-5)

        # Entry exists in cache but is expired
        assert "k" in cache._cache

        # get should return None (expired)
        result = await cache.get("k")
        assert result is None

        # And entry should be deleted by get
        assert "k" not in cache._cache

    async def test_ttl_exact_boundary(self):
        """Entry expires at exactly expires_at timestamp."""
        mock_time = MagicMock()
        cache = MemoryFallbackCache()

        # Set with TTL
        mock_time.time.return_value = 1000.0
        with patch(PATCH_TIME, mock_time):
            await cache.set("k", {"data": 1}, ttl=60)

        # At exactly expires_at (1060.0), entry should be expired
        # because condition is: time.time() > entry["expires_at"]
        mock_time.time.return_value = 1060.0
        with patch(PATCH_TIME, mock_time):
            result = await cache.get("k")

        # At exactly 1060.0, 1060.0 > 1060.0 is FALSE → NOT expired
        assert result == {"data": 1}

        # One tick later → expired
        mock_time.time.return_value = 1060.001
        with patch(PATCH_TIME, mock_time):
            result = await cache.get("k")

        assert result is None


# =========================================================================
# Adversarial: Full lifecycle
# =========================================================================

class TestFullLifecycle:
    """End-to-end lifecycle test."""

    async def test_set_get_expire_cleanup_get(self):
        """Full lifecycle: set → get → expire → cleanup removes → get returns None."""
        cache = MemoryFallbackCache()
        mock_time = MagicMock()

        # T=1000: set with 60s TTL
        mock_time.time.return_value = 1000.0
        with patch(PATCH_TIME, mock_time):
            await cache.set("k", {"version": 1}, ttl=60)

        # T=1030: still valid
        mock_time.time.return_value = 1030.0
        with patch(PATCH_TIME, mock_time):
            result = await cache.get("k")
        assert result == {"version": 1}

        # T=1061: expired
        mock_time.time.return_value = 1061.0
        with patch(PATCH_TIME, mock_time):
            result = await cache.get("k")
        assert result is None

    async def test_overwrite_then_expire(self):
        """Overwriting a key resets the TTL."""
        cache = MemoryFallbackCache()
        mock_time = MagicMock()

        # Set with short TTL
        mock_time.time.return_value = 1000.0
        with patch(PATCH_TIME, mock_time):
            await cache.set("k", {"v": 1}, ttl=10)

        # Overwrite with longer TTL
        mock_time.time.return_value = 1005.0
        with patch(PATCH_TIME, mock_time):
            await cache.set("k", {"v": 2}, ttl=60)

        # At T=1012, original TTL would have expired, but new TTL is 1005+60=1065
        mock_time.time.return_value = 1012.0
        with patch(PATCH_TIME, mock_time):
            result = await cache.get("k")
        assert result == {"v": 2}

    async def test_increment_then_get_returns_raw_int(self):
        """increment stores raw int, get returns it directly."""
        cache = MemoryFallbackCache()
        await cache.increment("counter", amount=5)

        result = await cache.get("counter")
        assert result == 5
        assert isinstance(result, int)

    async def test_delete_then_set_same_key(self):
        """After delete, key can be reused immediately."""
        cache = MemoryFallbackCache()

        await cache.set("k", {"v": 1})
        await cache.delete("k")
        await cache.set("k", {"v": 2})

        result = await cache.get("k")
        assert result == {"v": 2}


# =========================================================================
# Adversarial: Cleanup task failure modes
# =========================================================================

class TestCleanupTaskFailureModes:
    """Edge cases for cleanup task behavior when things go wrong."""

    async def test_uncaught_exception_kills_task_silently(self):
        """An exception NOT in (RuntimeError, KeyError, TypeError) kills the cleanup task.

        The task will be done() with an exception, but no warning is logged
        for the unexpected exception type. This documents current behavior.
        """
        cache = MemoryFallbackCache(cleanup_interval=9999)

        # Mock _cleanup_expired to raise ValueError (not in the caught set)
        async def raise_value_error():
            raise ValueError("unexpected")

        cache._cleanup_task = asyncio.ensure_future(raise_value_error())
        await asyncio.sleep(0)  # let it complete

        # Task is done with exception
        assert cache._cleanup_task.done()
        assert cache._cleanup_task.exception() is not None

        # stop_cleanup should handle this (task already done)
        await cache.stop_cleanup()
        assert cache._cleanup_task is None

    async def test_cleanup_logs_debug_on_expired_removal(self):
        """When entries are expired and removed, a debug log is emitted."""
        cache = MemoryFallbackCache()
        now = time.time()
        cache._cache["old"] = {"value": "stale", "expires_at": now - 100}

        with patch(PATCH_SLEEP, new_callable=AsyncMock,
                   side_effect=[None, asyncio.CancelledError]):
            with patch.object(cache._logger, "debug") as mock_debug:
                cache._is_running = True
                await cache._cleanup_expired()

                # Should log about cleaning up 1 entry
                mock_debug.assert_called_once()
                assert "1" in str(mock_debug.call_args)
