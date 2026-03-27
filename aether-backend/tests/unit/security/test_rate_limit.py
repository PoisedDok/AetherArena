"""
Unit tests for security/rate_limit.py — TokenBucket, RateLimiter,
MultiTierRateLimiter, RedisRateLimitBackend.

Adversarial: token refill math verified, boundary capacity tested, cleanup
lifecycle traced, statistics exact, Redis fallback paths exercised.

CI: pytest tests/unit/security/test_rate_limit.py -m unit --no-cov -q
"""

import time
import asyncio

import pytest

from data.cache.redis import RedisCache
from security import rate_limit
from security.rate_limit import (
    RateLimitConfig,
    RateLimitExceeded,
    RateLimitStrategy,
    TokenBucket,
    RateLimiter,
    MultiTierRateLimiter,
    RedisRateLimitBackend,
    DEFAULT_CONFIGS,
    configure_cache_backend,
)


# ===========================================================================
# Fixtures
# ===========================================================================

class FakeRedisClient:
    """Fake Redis client for backend tests."""
    def __init__(self, responses=None, error: bool = False, hgetall_data=None):
        self.responses = responses or []
        self.error = error
        self._hgetall_data = hgetall_data

    async def eval(self, script, numkeys, keys, args):
        if self.error:
            raise RuntimeError("redis failure")
        if not self.responses:
            return [1, 0]
        return self.responses.pop(0)

    async def hgetall(self, key: str):
        if self._hgetall_data is not None:
            return self._hgetall_data
        return {}


@pytest.fixture(autouse=True)
def reset_rate_limit_globals():
    """Reset global state between tests."""
    rate_limit._global_limiter = None
    rate_limit._redis_backend = None
    yield
    rate_limit._global_limiter = None
    rate_limit._redis_backend = None


def make_cache(client) -> RedisCache:
    cache = RedisCache()
    cache._client = client
    cache._connected = True
    return cache


# ===========================================================================
# RateLimitConfig
# ===========================================================================

class TestRateLimitConfig:

    def test_defaults(self):
        """Default config values are sensible."""
        cfg = RateLimitConfig()
        assert cfg.requests_per_window == 100
        assert cfg.window_seconds == 60.0
        assert cfg.burst_size == 100  # defaults to requests_per_window
        assert cfg.cleanup_interval == 300.0
        assert cfg.strategy == RateLimitStrategy.PER_IP

    def test_burst_size_defaults_to_requests_per_window(self):
        """burst_size=None triggers __post_init__ to set it."""
        cfg = RateLimitConfig(requests_per_window=50, burst_size=None)
        assert cfg.burst_size == 50

    def test_explicit_burst_size_preserved(self):
        """Explicit burst_size is not overwritten."""
        cfg = RateLimitConfig(requests_per_window=50, burst_size=200)
        assert cfg.burst_size == 200

    def test_custom_strategy(self):
        """Custom strategy is stored."""
        cfg = RateLimitConfig(strategy=RateLimitStrategy.PER_USER)
        assert cfg.strategy == RateLimitStrategy.PER_USER


# ===========================================================================
# RateLimitExceeded
# ===========================================================================

class TestRateLimitExceeded:

    def test_retry_after_property(self):
        """RateLimitExceeded carries retry_after value."""
        exc = RateLimitExceeded("Rate limited", retry_after=5.5)
        assert exc.retry_after == 5.5
        assert "Rate limited" in str(exc)


# ===========================================================================
# TokenBucket
# ===========================================================================

class TestTokenBucket:

    @pytest.mark.asyncio
    async def test_consume_within_capacity(self):
        """Consuming within capacity succeeds."""
        bucket = TokenBucket(capacity=10, refill_rate=1.0)
        allowed, retry = await bucket.consume(1)
        assert allowed is True
        assert retry == 0.0

    @pytest.mark.asyncio
    async def test_consume_entire_capacity(self):
        """Consuming all tokens succeeds, next request fails."""
        bucket = TokenBucket(capacity=3, refill_rate=1.0)
        for _ in range(3):
            allowed, _ = await bucket.consume(1)
            assert allowed is True
        # 4th request should fail
        allowed, retry = await bucket.consume(1)
        assert allowed is False
        assert retry > 0.0

    @pytest.mark.asyncio
    async def test_consume_multiple_tokens(self):
        """Consuming multiple tokens at once works."""
        bucket = TokenBucket(capacity=5, refill_rate=1.0)
        allowed, _ = await bucket.consume(3)
        assert allowed is True
        # Only 2 left
        allowed, _ = await bucket.consume(3)
        assert allowed is False

    @pytest.mark.asyncio
    async def test_refill_over_time(self):
        """Tokens refill based on elapsed time."""
        bucket = TokenBucket(capacity=2, refill_rate=100.0)  # 100 tokens/sec
        # Drain all tokens
        await bucket.consume(2)
        allowed, _ = await bucket.consume(1)
        assert allowed is False
        # Wait for refill (100 tokens/sec → 1 token in 0.01s)
        await asyncio.sleep(0.05)
        allowed, _ = await bucket.consume(1)
        assert allowed is True

    @pytest.mark.asyncio
    async def test_refill_capped_at_capacity(self):
        """Tokens never exceed capacity even after long wait."""
        bucket = TokenBucket(capacity=5, refill_rate=100.0)
        await bucket.consume(3)
        await asyncio.sleep(0.1)  # Would refill 10 tokens but cap at 5
        assert bucket.get_remaining() <= 5

    def test_get_remaining(self):
        """get_remaining returns integer token count."""
        bucket = TokenBucket(capacity=10, refill_rate=1.0)
        assert bucket.get_remaining() == 10

    def test_is_expired_false(self):
        """Fresh bucket is not expired."""
        bucket = TokenBucket(capacity=10, refill_rate=1.0)
        assert bucket.is_expired(max_age=60.0) is False

    def test_is_expired_true(self):
        """Bucket with old last_refill is expired."""
        bucket = TokenBucket(
            capacity=10,
            refill_rate=1.0,
            last_refill=time.time() - 120.0
        )
        assert bucket.is_expired(max_age=60.0) is True

    @pytest.mark.asyncio
    async def test_retry_after_calculation(self):
        """retry_after is tokens_needed / refill_rate."""
        # 2 tokens/sec capacity 1 → drains immediately
        bucket = TokenBucket(capacity=1, refill_rate=2.0)
        await bucket.consume(1)
        allowed, retry_after = await bucket.consume(1)
        assert allowed is False
        # Need ~1 token at 2/sec → ~0.5 sec
        assert 0.0 < retry_after <= 1.0


# ===========================================================================
# RateLimiter
# ===========================================================================

class TestRateLimiter:

    @pytest.mark.asyncio
    async def test_allows_within_limit(self):
        """Requests within limit pass."""
        cfg = RateLimitConfig(requests_per_window=5, window_seconds=60)
        limiter = RateLimiter(cfg)
        for i in range(5):
            await limiter.check_rate_limit(f"client-{i}")

    @pytest.mark.asyncio
    async def test_denies_over_limit(self):
        """Request over limit raises RateLimitExceeded."""
        cfg = RateLimitConfig(requests_per_window=2, window_seconds=60)
        limiter = RateLimiter(cfg)
        await limiter.check_rate_limit("client-1")
        await limiter.check_rate_limit("client-1")
        with pytest.raises(RateLimitExceeded) as exc_info:
            await limiter.check_rate_limit("client-1")
        assert exc_info.value.retry_after > 0

    @pytest.mark.asyncio
    async def test_separate_clients_independent(self):
        """Different client IDs have independent buckets."""
        cfg = RateLimitConfig(requests_per_window=1, window_seconds=60)
        limiter = RateLimiter(cfg)
        await limiter.check_rate_limit("client-a")
        await limiter.check_rate_limit("client-b")  # different client, should pass
        with pytest.raises(RateLimitExceeded):
            await limiter.check_rate_limit("client-a")  # same client, over limit

    @pytest.mark.asyncio
    async def test_get_limit_info(self):
        """get_limit_info returns structured data."""
        cfg = RateLimitConfig(requests_per_window=100, window_seconds=60)
        limiter = RateLimiter(cfg)
        await limiter.check_rate_limit("client-1")
        info = await limiter.get_limit_info("client-1")
        assert info["limit"] == 100
        assert info["remaining"] >= 0
        assert info["window_seconds"] == 60.0
        assert "reset" in info

    @pytest.mark.asyncio
    async def test_reset_client(self):
        """reset_client removes the bucket for a client."""
        cfg = RateLimitConfig(requests_per_window=1, window_seconds=60)
        limiter = RateLimiter(cfg)
        await limiter.check_rate_limit("client-1")
        with pytest.raises(RateLimitExceeded):
            await limiter.check_rate_limit("client-1")
        await limiter.reset_client("client-1")
        # After reset, should be allowed again
        await limiter.check_rate_limit("client-1")

    @pytest.mark.asyncio
    async def test_reset_nonexistent_client_no_error(self):
        """Resetting a non-existent client doesn't raise."""
        limiter = RateLimiter()
        await limiter.reset_client("never-existed")

    def test_statistics_initial(self):
        """Initial statistics are zeroed."""
        limiter = RateLimiter()
        stats = limiter.get_statistics()
        assert stats["total_requests"] == 0
        assert stats["total_limited"] == 0
        assert stats["active_clients"] == 0
        assert stats["limit_rate"] == "0%"

    @pytest.mark.asyncio
    async def test_statistics_after_requests(self):
        """Statistics track requests and denials."""
        cfg = RateLimitConfig(requests_per_window=1, window_seconds=60)
        limiter = RateLimiter(cfg)
        await limiter.check_rate_limit("c1")
        try:
            await limiter.check_rate_limit("c1")
        except RateLimitExceeded:
            pass
        stats = limiter.get_statistics()
        assert stats["total_requests"] == 2
        assert stats["total_limited"] == 1
        assert stats["active_clients"] == 1

    @pytest.mark.asyncio
    async def test_statistics_config_section(self):
        """Statistics include config details."""
        cfg = RateLimitConfig(requests_per_window=50, window_seconds=30)
        limiter = RateLimiter(cfg)
        stats = limiter.get_statistics()
        assert stats["config"]["requests_per_window"] == 50
        assert stats["config"]["window_seconds"] == 30
        assert stats["config"]["strategy"] == "per_ip"

    @pytest.mark.asyncio
    async def test_start_stop_lifecycle(self):
        """start() and stop() manage cleanup task lifecycle."""
        limiter = RateLimiter()
        await limiter.start()
        assert limiter._running is True
        assert limiter._cleanup_task is not None
        await limiter.stop()
        assert limiter._running is False

    @pytest.mark.asyncio
    async def test_cleanup_loop_runs_and_cancels(self):
        """Cleanup loop executes iterations, CancelledError stops it cleanly."""
        cfg = RateLimitConfig(requests_per_window=10, window_seconds=1.0, cleanup_interval=0.01)
        limiter = RateLimiter(cfg)
        # Add a bucket so cleanup has something to inspect
        await limiter.check_rate_limit("loop-client")
        await limiter.start()
        # Yield to event loop so the task enters the while loop and sleeps
        await asyncio.sleep(0.05)
        await limiter.stop()
        assert limiter._running is False

    @pytest.mark.asyncio
    async def test_cleanup_loop_exception_logged_and_continues(self):
        """Generic exception in _cleanup_old_buckets is logged; loop continues."""
        cfg = RateLimitConfig(requests_per_window=10, window_seconds=1.0, cleanup_interval=0.01)
        limiter = RateLimiter(cfg)
        call_count = 0

        async def failing_cleanup():
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                raise RuntimeError("cleanup boom")

        limiter._cleanup_old_buckets = failing_cleanup
        await limiter.start()
        await asyncio.sleep(0.08)
        await limiter.stop()
        # Loop must have continued past the exception at least twice
        assert call_count >= 2

    @pytest.mark.asyncio
    async def test_cleanup_old_buckets_removes_expired(self):
        """_cleanup_old_buckets deletes buckets older than 2x window and logs."""
        cfg = RateLimitConfig(requests_per_window=10, window_seconds=1.0)
        limiter = RateLimiter(cfg)
        # Create bucket then backdate to make it expired (max_age = 2 * 1.0 = 2s)
        await limiter.check_rate_limit("expired-client")
        limiter._buckets["expired-client"].last_refill = time.time() - 10.0
        # Fresh bucket should survive
        await limiter.check_rate_limit("fresh-client")
        assert len(limiter._buckets) == 2
        await limiter._cleanup_old_buckets()
        assert "expired-client" not in limiter._buckets
        assert "fresh-client" in limiter._buckets
        assert len(limiter._buckets) == 1

    @pytest.mark.asyncio
    async def test_cleanup_old_buckets_noop_when_none_expired(self):
        """_cleanup_old_buckets is a no-op when all buckets are fresh."""
        cfg = RateLimitConfig(requests_per_window=10, window_seconds=60.0)
        limiter = RateLimiter(cfg)
        await limiter.check_rate_limit("fresh-1")
        await limiter.check_rate_limit("fresh-2")
        assert len(limiter._buckets) == 2
        await limiter._cleanup_old_buckets()
        assert len(limiter._buckets) == 2


# ===========================================================================
# MultiTierRateLimiter
# ===========================================================================

class TestMultiTierRateLimiter:

    @pytest.mark.asyncio
    async def test_add_tier_and_check(self):
        """Adding a tier and checking it works."""
        mt = MultiTierRateLimiter()
        mt.add_tier("test", RateLimitConfig(requests_per_window=2, window_seconds=60))
        await mt.check_rate_limit("c1", tier="test")
        await mt.check_rate_limit("c1", tier="test")
        with pytest.raises(RateLimitExceeded):
            await mt.check_rate_limit("c1", tier="test")

    @pytest.mark.asyncio
    async def test_unknown_tier_raises(self):
        """Checking unknown tier raises ValueError."""
        mt = MultiTierRateLimiter()
        with pytest.raises(ValueError, match="Unknown rate limit tier"):
            await mt.check_rate_limit("c1", tier="nonexistent")

    @pytest.mark.asyncio
    async def test_get_limit_info_unknown_tier(self):
        """get_limit_info for unknown tier raises ValueError."""
        mt = MultiTierRateLimiter()
        with pytest.raises(ValueError, match="Unknown rate limit tier"):
            await mt.get_limit_info("c1", tier="nonexistent")

    @pytest.mark.asyncio
    async def test_multiple_tiers_independent(self):
        """Different tiers have independent limits."""
        mt = MultiTierRateLimiter()
        mt.add_tier("low", RateLimitConfig(requests_per_window=1, window_seconds=60))
        mt.add_tier("high", RateLimitConfig(requests_per_window=100, window_seconds=60))
        await mt.check_rate_limit("c1", tier="low")
        with pytest.raises(RateLimitExceeded):
            await mt.check_rate_limit("c1", tier="low")
        # Same client on high tier should still work
        await mt.check_rate_limit("c1", tier="high")

    def test_get_statistics_all_tiers(self):
        """get_statistics returns data for all tiers."""
        mt = MultiTierRateLimiter()
        mt.add_tier("a", RateLimitConfig())
        mt.add_tier("b", RateLimitConfig())
        stats = mt.get_statistics()
        assert "a" in stats
        assert "b" in stats

    @pytest.mark.asyncio
    async def test_start_stop(self):
        """start/stop propagates to all tiers."""
        mt = MultiTierRateLimiter()
        mt.add_tier("t1", RateLimitConfig())
        await mt.start()
        assert mt._limiters["t1"]._running is True
        await mt.stop()
        assert mt._limiters["t1"]._running is False

    @pytest.mark.asyncio
    async def test_get_limit_info_uses_redis_backend(self):
        """get_limit_info delegates to Redis backend when available and returns its data."""
        mt = MultiTierRateLimiter()
        cfg = RateLimitConfig(requests_per_window=100, window_seconds=60)
        mt.add_tier("test", cfg)
        now = time.time()
        client = FakeRedisClient(hgetall_data={
            "tokens": "55",
            "timestamp": str(now),
        })
        cache = make_cache(client)
        backend = RedisRateLimitBackend(cache)
        mt.set_cache_backend(backend)
        info = await mt.get_limit_info("client-1", tier="test")
        assert info["limit"] == 100
        assert info["remaining"] == 55
        assert info["window_seconds"] == 60
        assert isinstance(info["reset"], int)

    @pytest.mark.asyncio
    async def test_get_limit_info_redis_fallback_to_memory(self):
        """get_limit_info falls back to in-memory when Redis returns None."""
        mt = MultiTierRateLimiter()
        cfg = RateLimitConfig(requests_per_window=50, window_seconds=30)
        mt.add_tier("test", cfg)
        # Disconnected cache → get_bucket_info returns None → fallback
        cache = make_cache(FakeRedisClient())
        cache._connected = False
        backend = RedisRateLimitBackend(cache)
        mt.set_cache_backend(backend)
        info = await mt.get_limit_info("client-1", tier="test")
        # Fallback to in-memory limiter info
        assert info["limit"] == 50
        assert info["window_seconds"] == 30
        assert "remaining" in info


# ===========================================================================
# RedisRateLimitBackend
# ===========================================================================

class TestRedisBackend:

    @pytest.mark.asyncio
    async def test_redis_allows_request(self):
        """Redis backend allows request when Lua returns [1, ...]."""
        cache = make_cache(FakeRedisClient(responses=[[1, 9.0]]))
        configure_cache_backend(cache, namespace="rl:test", bucket_ttl=60)
        await rate_limit.check_rate_limit("client-1")

    @pytest.mark.asyncio
    async def test_redis_denies_request(self):
        """Redis backend denies request when Lua returns [0, ...]."""
        cache = make_cache(FakeRedisClient(responses=[[0, 0.0]]))
        configure_cache_backend(cache, namespace="rl:test", bucket_ttl=60)
        with pytest.raises(RateLimitExceeded):
            await rate_limit.check_rate_limit("client-2")

    @pytest.mark.asyncio
    async def test_fallback_to_memory_on_redis_error(self):
        """Redis error → falls back to in-memory rate limiter."""
        cache = make_cache(FakeRedisClient(error=True))
        configure_cache_backend(cache, namespace="rl:test", bucket_ttl=60)

        limiter = rate_limit.get_rate_limiter()
        limiter.add_tier("test_tier", RateLimitConfig(requests_per_window=1, window_seconds=60))

        await limiter.check_rate_limit("client-3", tier="test_tier")
        with pytest.raises(RateLimitExceeded):
            await limiter.check_rate_limit("client-3", tier="test_tier")

    @pytest.mark.asyncio
    async def test_configure_cache_backend_none_cache(self):
        """configure_cache_backend with None cache is a no-op."""
        configure_cache_backend(None, namespace="test", bucket_ttl=60)
        assert rate_limit._redis_backend is None

    @pytest.mark.asyncio
    async def test_consume_disconnected_cache_returns_none(self):
        """Disconnected cache causes consume() to return None immediately."""
        cache = make_cache(FakeRedisClient())
        cache._connected = False
        backend = RedisRateLimitBackend(cache)
        cfg = RateLimitConfig(requests_per_window=10, window_seconds=60)
        result = await backend.consume(cfg, "tier", "client-1", 1)
        assert result is None

    @pytest.mark.asyncio
    async def test_get_bucket_info_disconnected_returns_none(self):
        """get_bucket_info returns None when cache is disconnected."""
        cache = make_cache(FakeRedisClient())
        cache._connected = False
        backend = RedisRateLimitBackend(cache)
        cfg = RateLimitConfig(requests_per_window=10, window_seconds=60)
        result = await backend.get_bucket_info(cfg, "tier", "client-1")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_bucket_info_empty_data_returns_none(self):
        """get_bucket_info returns None when hgetall yields no data."""
        cache = make_cache(FakeRedisClient())  # hgetall returns {}
        backend = RedisRateLimitBackend(cache)
        cfg = RateLimitConfig(requests_per_window=10, window_seconds=60)
        result = await backend.get_bucket_info(cfg, "tier", "client-1")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_bucket_info_returns_structured_data(self):
        """get_bucket_info returns limit/remaining/reset/window dict on success."""
        now = time.time()
        client = FakeRedisClient(hgetall_data={
            "tokens": "42",
            "timestamp": str(now),
        })
        cache = make_cache(client)
        backend = RedisRateLimitBackend(cache)
        cfg = RateLimitConfig(requests_per_window=100, window_seconds=60)
        result = await backend.get_bucket_info(cfg, "tier", "client-1")
        assert result is not None
        assert result["limit"] == 100
        assert result["remaining"] == 42
        assert result["window_seconds"] == 60
        assert isinstance(result["reset"], int)
        assert result["reset"] >= 0

    @pytest.mark.asyncio
    async def test_get_bucket_info_malformed_data_returns_none(self):
        """get_bucket_info catches ValueError from corrupt Redis data."""
        client = FakeRedisClient(hgetall_data={
            "tokens": "not_a_number",
            "timestamp": "also_bad",
        })
        cache = make_cache(client)
        backend = RedisRateLimitBackend(cache)
        cfg = RateLimitConfig(requests_per_window=10, window_seconds=60)
        result = await backend.get_bucket_info(cfg, "tier", "client-1")
        assert result is None


# ===========================================================================
# Default Configs
# ===========================================================================

class TestDefaultConfigs:

    def test_default_configs_exist(self):
        """All expected default tier configs exist."""
        expected_tiers = {"api_default", "api_heavy", "chat_streaming", "file_upload", "websocket"}
        assert set(DEFAULT_CONFIGS.keys()) == expected_tiers

    def test_api_default_config(self):
        """api_default tier: 100 req/60s."""
        cfg = DEFAULT_CONFIGS["api_default"]
        assert cfg.requests_per_window == 100
        assert cfg.window_seconds == 60.0

    def test_file_upload_config(self):
        """file_upload tier: 5 req/60s (strictest)."""
        cfg = DEFAULT_CONFIGS["file_upload"]
        assert cfg.requests_per_window == 5

    def test_websocket_config(self):
        """websocket tier: 1000 req/60s (highest burst)."""
        cfg = DEFAULT_CONFIGS["websocket"]
        assert cfg.requests_per_window == 1000


# ===========================================================================
# Global Functions
# ===========================================================================

class TestGlobalFunctions:

    @pytest.mark.asyncio
    async def test_get_rate_limiter_creates_default(self):
        """get_rate_limiter lazily creates with DEFAULT_CONFIGS."""
        limiter = rate_limit.get_rate_limiter()
        assert isinstance(limiter, MultiTierRateLimiter)
        # Should have default tiers
        stats = limiter.get_statistics()
        assert "api_default" in stats

    @pytest.mark.asyncio
    async def test_check_rate_limit_convenience(self):
        """Module-level check_rate_limit works end-to-end."""
        await rate_limit.check_rate_limit("test-client", tier="api_default")

    @pytest.mark.asyncio
    async def test_get_limit_info_convenience(self):
        """Module-level get_limit_info returns data."""
        info = await rate_limit.get_limit_info("test-client", tier="api_default")
        assert "limit" in info
        assert "remaining" in info

    def test_configure_rate_limits_no_reset_with_existing_limiter(self):
        """configure_rate_limits(reset=False) replaces limiter when one already exists."""
        # Pre-set a global limiter so _global_limiter is not None
        rate_limit._global_limiter = MultiTierRateLimiter()
        rate_limit._global_limiter.add_tier("old", RateLimitConfig())
        # Call with reset=False — hits the else branch (line 583)
        rate_limit.configure_rate_limits({"new_tier": RateLimitConfig()}, reset=False)
        stats = rate_limit._global_limiter.get_statistics()
        assert "new_tier" in stats
        assert "old" not in stats  # Old limiter was replaced
