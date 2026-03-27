"""
Tests for data/cache/redis.py  (RedisCache)
and   data/cache/redis_session.py  (RedisSessionContext, RedisRequestContext)

All Redis I/O is mocked — no real Redis server needed.
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

from data.cache.redis import RedisCache
from data.cache.redis_session import RedisSessionContext, RedisRequestContext


# ===========================================================================
# Helpers
# ===========================================================================

def _connected_cache() -> RedisCache:
    """Return a RedisCache with a mocked _client in 'connected' state."""
    cache = RedisCache(redis_url="redis://mock:6379/0", namespace="test")
    mock_client = AsyncMock()
    cache._client = mock_client
    cache._connected = True
    return cache


# ===========================================================================
# RedisCache — Constructor
# ===========================================================================

class TestRedisCacheConstructor:

    def test_defaults(self):
        cache = RedisCache()
        assert cache.redis_url == "redis://localhost:6379/0"
        assert cache.namespace == "aether"
        assert cache.encoding == "utf-8"
        assert cache._client is None
        assert cache._connected is False

    def test_custom_params(self):
        cache = RedisCache(redis_url="redis://custom:1234/2", namespace="ns", encoding="ascii")
        assert cache.redis_url == "redis://custom:1234/2"
        assert cache.namespace == "ns"
        assert cache.encoding == "ascii"

    def test_redis_unavailable_warning(self, monkeypatch, caplog):
        monkeypatch.setattr("data.cache.redis.REDIS_AVAILABLE", False)
        with caplog.at_level("WARNING"):
            RedisCache()
        assert "not available" in caplog.text


# ===========================================================================
# RedisCache — Connection Management
# ===========================================================================

class TestConnect:

    async def test_connect_success(self, monkeypatch):
        monkeypatch.setattr("data.cache.redis.REDIS_AVAILABLE", True)
        mock_from_url = MagicMock()
        mock_client = AsyncMock()
        mock_from_url.return_value = mock_client
        monkeypatch.setattr("data.cache.redis.redis.from_url", mock_from_url)

        cache = RedisCache()
        result = await cache.connect()
        assert result is True
        assert cache.is_connected() is True
        mock_client.ping.assert_awaited_once()

    async def test_connect_redis_unavailable(self, monkeypatch):
        monkeypatch.setattr("data.cache.redis.REDIS_AVAILABLE", False)
        cache = RedisCache()
        result = await cache.connect()
        assert result is False
        assert cache.is_connected() is False

    async def test_connect_already_connected(self):
        cache = _connected_cache()
        result = await cache.connect()
        assert result is True

    async def test_connect_failure(self, monkeypatch):
        monkeypatch.setattr("data.cache.redis.REDIS_AVAILABLE", True)
        mock_from_url = MagicMock()
        mock_client = AsyncMock()
        mock_client.ping.side_effect = ConnectionError("refused")
        mock_from_url.return_value = mock_client
        monkeypatch.setattr("data.cache.redis.redis.from_url", mock_from_url)

        cache = RedisCache()
        result = await cache.connect()
        assert result is False
        assert cache._client is None


class TestDisconnect:

    async def test_disconnect_success(self):
        cache = _connected_cache()
        await cache.disconnect()
        assert cache._client is None
        assert cache._connected is False

    async def test_disconnect_not_connected(self):
        cache = RedisCache()
        await cache.disconnect()  # no-op, should not raise
        assert cache._client is None

    async def test_disconnect_error(self, caplog):
        cache = _connected_cache()
        cache._client.close.side_effect = OSError("broken pipe")
        with caplog.at_level("ERROR"):
            await cache.disconnect()
        assert "Error disconnecting" in caplog.text
        # Regression: state MUST be reset even on error
        assert cache._client is None
        assert cache._connected is False
        assert cache.is_connected() is False


class TestIsConnected:

    def test_disconnected(self):
        cache = RedisCache()
        assert cache.is_connected() is False

    def test_connected(self):
        cache = _connected_cache()
        assert cache.is_connected() is True

    def test_connected_no_client(self):
        cache = RedisCache()
        cache._connected = True  # flag set, but no client
        assert cache.is_connected() is False


# ===========================================================================
# RedisCache — Key Operations
# ===========================================================================

class TestMakeKey:

    def test_namespace_prefix(self):
        cache = RedisCache(namespace="app")
        assert cache._make_key("session:123") == "app:session:123"


class TestRawClient:

    def test_raw_client_returns_internal(self):
        cache = _connected_cache()
        assert cache.raw_client is cache._client

    def test_raw_client_none_when_disconnected(self):
        cache = RedisCache()
        assert cache.raw_client is None


# ===========================================================================
# RedisCache — set
# ===========================================================================

class TestSet:

    async def test_set_without_ttl(self):
        cache = _connected_cache()
        result = await cache.set("k", {"a": 1})
        assert result is True
        cache._client.set.assert_awaited_once_with("test:k", json.dumps({"a": 1}))

    async def test_set_with_ttl(self):
        cache = _connected_cache()
        result = await cache.set("k", "v", ttl=60)
        assert result is True
        cache._client.setex.assert_awaited_once_with("test:k", 60, json.dumps("v"))

    async def test_set_with_ttl_zero(self):
        """Regression: ttl=0 must call setex (expire immediately), not set."""
        cache = _connected_cache()
        result = await cache.set("k", "v", ttl=0)
        assert result is True
        cache._client.setex.assert_awaited_once_with("test:k", 0, json.dumps("v"))
        cache._client.set.assert_not_awaited()

    async def test_set_non_serializable_raises_returns_false(self):
        """Value that can't be JSON-serialized should return False, not crash."""
        cache = _connected_cache()
        result = await cache.set("k", object())
        assert result is False

    async def test_set_disconnected(self):
        cache = RedisCache()
        result = await cache.set("k", "v")
        assert result is False

    async def test_set_error(self):
        cache = _connected_cache()
        cache._client.set.side_effect = RuntimeError("write fail")
        result = await cache.set("k", "v")
        assert result is False


# ===========================================================================
# RedisCache — get
# ===========================================================================

class TestGet:

    async def test_get_found(self):
        cache = _connected_cache()
        cache._client.get.return_value = json.dumps({"x": 1})
        result = await cache.get("k")
        assert result == {"x": 1}

    async def test_get_not_found(self):
        cache = _connected_cache()
        cache._client.get.return_value = None
        result = await cache.get("k")
        assert result is None

    async def test_get_disconnected(self):
        cache = RedisCache()
        result = await cache.get("k")
        assert result is None

    async def test_get_error(self):
        cache = _connected_cache()
        cache._client.get.side_effect = RuntimeError("read fail")
        result = await cache.get("k")
        assert result is None


# ===========================================================================
# RedisCache — delete
# ===========================================================================

class TestDelete:

    async def test_delete_found(self):
        cache = _connected_cache()
        cache._client.delete.return_value = 1
        result = await cache.delete("k")
        assert result is True

    async def test_delete_not_found(self):
        cache = _connected_cache()
        cache._client.delete.return_value = 0
        result = await cache.delete("k")
        assert result is False

    async def test_delete_disconnected(self):
        cache = RedisCache()
        result = await cache.delete("k")
        assert result is False

    async def test_delete_error(self):
        cache = _connected_cache()
        cache._client.delete.side_effect = RuntimeError("del fail")
        result = await cache.delete("k")
        assert result is False


# ===========================================================================
# RedisCache — increment
# ===========================================================================

class TestIncrement:

    async def test_increment_default(self):
        cache = _connected_cache()
        cache._client.incrby.return_value = 5
        result = await cache.increment("counter")
        assert result == 5

    async def test_increment_custom_amount(self):
        cache = _connected_cache()
        cache._client.incrby.return_value = 10
        result = await cache.increment("counter", amount=5)
        assert result == 10
        cache._client.incrby.assert_awaited_once_with("test:counter", 5)

    async def test_increment_with_ttl(self):
        cache = _connected_cache()
        cache._client.incrby.return_value = 1
        result = await cache.increment("counter", ttl=300)
        assert result == 1
        cache._client.expire.assert_awaited_once_with("test:counter", 300)

    async def test_increment_with_ttl_zero(self):
        """Regression: ttl=0 must still call expire."""
        cache = _connected_cache()
        cache._client.incrby.return_value = 1
        result = await cache.increment("counter", ttl=0)
        assert result == 1
        cache._client.expire.assert_awaited_once_with("test:counter", 0)

    async def test_increment_no_ttl_no_expire(self):
        cache = _connected_cache()
        cache._client.incrby.return_value = 1
        await cache.increment("counter")
        cache._client.expire.assert_not_awaited()

    async def test_increment_disconnected(self):
        cache = RedisCache()
        result = await cache.increment("counter")
        assert result is None

    async def test_increment_error(self):
        cache = _connected_cache()
        cache._client.incrby.side_effect = RuntimeError("incr fail")
        result = await cache.increment("counter")
        assert result is None


# ===========================================================================
# RedisCache — hset
# ===========================================================================

class TestHset:

    async def test_hset_success(self):
        cache = _connected_cache()
        result = await cache.hset("hash", {"field": "val"})
        assert result is True
        cache._client.hset.assert_awaited_once_with("test:hash", mapping={"field": "val"})

    async def test_hset_with_ttl(self):
        cache = _connected_cache()
        await cache.hset("hash", {"f": "v"}, ttl=120)
        cache._client.expire.assert_awaited_once_with("test:hash", 120)

    async def test_hset_with_ttl_zero(self):
        """Regression: ttl=0 must still call expire."""
        cache = _connected_cache()
        await cache.hset("hash", {"f": "v"}, ttl=0)
        cache._client.expire.assert_awaited_once_with("test:hash", 0)

    async def test_hset_no_ttl_no_expire(self):
        cache = _connected_cache()
        await cache.hset("hash", {"f": "v"})
        cache._client.expire.assert_not_awaited()

    async def test_hset_disconnected(self):
        cache = RedisCache()
        result = await cache.hset("hash", {"f": "v"})
        assert result is False

    async def test_hset_error(self):
        cache = _connected_cache()
        cache._client.hset.side_effect = RuntimeError("hset fail")
        result = await cache.hset("hash", {"f": "v"})
        assert result is False


# ===========================================================================
# RedisCache — hgetall
# ===========================================================================

class TestHgetall:

    async def test_hgetall_data(self):
        cache = _connected_cache()
        cache._client.hgetall.return_value = {"a": "1", "b": "2"}
        result = await cache.hgetall("hash")
        assert result == {"a": "1", "b": "2"}

    async def test_hgetall_empty(self):
        cache = _connected_cache()
        cache._client.hgetall.return_value = {}
        result = await cache.hgetall("hash")
        assert result == {}

    async def test_hgetall_none(self):
        cache = _connected_cache()
        cache._client.hgetall.return_value = None
        result = await cache.hgetall("hash")
        assert result == {}

    async def test_hgetall_disconnected(self):
        cache = RedisCache()
        result = await cache.hgetall("hash")
        assert result == {}

    async def test_hgetall_error(self):
        cache = _connected_cache()
        cache._client.hgetall.side_effect = RuntimeError("hgetall fail")
        result = await cache.hgetall("hash")
        assert result == {}


# ===========================================================================
# RedisCache — exists
# ===========================================================================

class TestExists:

    async def test_exists_true(self):
        cache = _connected_cache()
        cache._client.exists.return_value = 1
        result = await cache.exists("k")
        assert result is True

    async def test_exists_false(self):
        cache = _connected_cache()
        cache._client.exists.return_value = 0
        result = await cache.exists("k")
        assert result is False

    async def test_exists_disconnected(self):
        cache = RedisCache()
        result = await cache.exists("k")
        assert result is False

    async def test_exists_error(self):
        cache = _connected_cache()
        cache._client.exists.side_effect = RuntimeError("exists fail")
        result = await cache.exists("k")
        assert result is False


# ===========================================================================
# RedisCache — expire
# ===========================================================================

class TestExpire:

    async def test_expire_success(self):
        cache = _connected_cache()
        cache._client.expire.return_value = 1
        result = await cache.expire("k", 300)
        assert result is True

    async def test_expire_key_missing(self):
        cache = _connected_cache()
        cache._client.expire.return_value = 0
        result = await cache.expire("k", 300)
        assert result is False

    async def test_expire_disconnected(self):
        cache = RedisCache()
        result = await cache.expire("k", 300)
        assert result is False

    async def test_expire_error(self):
        cache = _connected_cache()
        cache._client.expire.side_effect = RuntimeError("expire fail")
        result = await cache.expire("k", 300)
        assert result is False


# ===========================================================================
# RedisCache — clear_namespace
# ===========================================================================

class TestClearNamespace:

    async def test_clear_with_keys(self):
        cache = _connected_cache()

        async def _scan_iter(match=None):
            for k in ["test:a", "test:b"]:
                yield k

        cache._client.scan_iter = _scan_iter
        cache._client.delete.return_value = 2
        result = await cache.clear_namespace()
        assert result == 2

    async def test_clear_no_keys(self):
        cache = _connected_cache()

        async def _scan_iter(match=None):
            return
            yield  # make it an async generator

        cache._client.scan_iter = _scan_iter
        result = await cache.clear_namespace()
        assert result == 0

    async def test_clear_disconnected(self):
        cache = RedisCache()
        result = await cache.clear_namespace()
        assert result == 0

    async def test_clear_error(self):
        cache = _connected_cache()

        async def _scan_iter(match=None):
            raise RuntimeError("scan fail")
            yield  # noqa: make async generator

        cache._client.scan_iter = _scan_iter
        result = await cache.clear_namespace()
        assert result == 0


# ===========================================================================
# RedisCache — health_check
# ===========================================================================

class TestHealthCheck:

    async def test_healthy(self):
        cache = _connected_cache()
        cache._client.info.return_value = {
            "redis_version": "7.0.0",
            "used_memory_human": "1.5M",
            "connected_clients": 5,
        }
        result = await cache.health_check()
        assert result["healthy"] is True
        assert result["connected"] is True
        assert result["redis_available"] is True
        assert result["error"] is None
        assert result["server_version"] == "7.0.0"
        assert result["used_memory_human"] == "1.5M"
        assert result["connected_clients"] == 5

    async def test_redis_unavailable(self, monkeypatch):
        monkeypatch.setattr("data.cache.redis.REDIS_AVAILABLE", False)
        cache = RedisCache()
        result = await cache.health_check()
        assert result["healthy"] is False
        assert "not installed" in result["error"]

    async def test_not_connected(self):
        cache = RedisCache()
        result = await cache.health_check()
        assert result["healthy"] is False
        assert "Not connected" in result["error"]

    async def test_ping_failure(self):
        cache = _connected_cache()
        cache._client.ping.side_effect = ConnectionError("timeout")
        result = await cache.health_check()
        assert result["healthy"] is False
        assert "timeout" in result["error"]


# ===========================================================================
# RedisRequestContext
# ===========================================================================

class TestRedisRequestContext:

    def test_to_attributes_full(self):
        ctx = RedisRequestContext(
            request_id="req-1",
            correlation_id="corr-1",
            session_id="sess-1",
            user_id="user-1",
            extras={"custom": "val"},
        )
        attrs = ctx.to_attributes()
        assert attrs["request.id"] == "req-1"
        assert attrs["correlation.id"] == "corr-1"
        assert attrs["session.id"] == "sess-1"
        assert attrs["user.id"] == "user-1"
        assert attrs["custom"] == "val"

    def test_to_attributes_none_excluded(self):
        ctx = RedisRequestContext(request_id="req-1")
        attrs = ctx.to_attributes()
        assert "correlation.id" not in attrs
        assert "session.id" not in attrs
        assert "user.id" not in attrs

    def test_to_attributes_empty_extras(self):
        ctx = RedisRequestContext(request_id="req-1", extras={})
        attrs = ctx.to_attributes()
        assert "request.id" in attrs

    def test_frozen(self):
        ctx = RedisRequestContext(request_id="req-1")
        with pytest.raises(AttributeError):
            ctx.request_id = "other"


# ===========================================================================
# RedisSessionContext
# ===========================================================================

class TestRedisSessionContext:

    def _make_ctx(self, cache=None, namespace="rate"):
        req = RedisRequestContext(request_id="req-1")
        return RedisSessionContext(cache, namespace=namespace, context=req)

    def test_is_available_true(self):
        mock_cache = MagicMock()
        mock_cache.is_connected.return_value = True
        ctx = self._make_ctx(cache=mock_cache)
        assert ctx.is_available() is True

    def test_is_available_false_no_cache(self):
        ctx = self._make_ctx(cache=None)
        assert ctx.is_available() is False

    def test_is_available_false_disconnected(self):
        mock_cache = MagicMock()
        mock_cache.is_connected.return_value = False
        ctx = self._make_ctx(cache=mock_cache)
        assert ctx.is_available() is False

    def test_namespaced_key_basic(self):
        ctx = self._make_ctx()
        assert ctx.namespaced_key("user:123") == "rate:user:123"

    def test_namespaced_key_multiple_segments(self):
        ctx = self._make_ctx(namespace="presence")
        key = ctx.namespaced_key("room", "abc")
        assert key == "presence:room:abc"

    def test_namespaced_key_strips_colons(self):
        ctx = self._make_ctx(namespace=":rate:")
        key = ctx.namespaced_key(":key:")
        assert key == "rate:key"

    def test_namespaced_key_empty_segments_filtered(self):
        ctx = self._make_ctx()
        key = ctx.namespaced_key("", None, "x")
        assert key == "rate:x"

    def test_namespace_default_runtime(self):
        ctx = self._make_ctx(namespace="")
        assert ctx._local_namespace == "runtime"

    async def test_set_delegates(self):
        mock_cache = AsyncMock()
        mock_cache.is_connected.return_value = True
        ctx = self._make_ctx(cache=mock_cache)
        await ctx.set("k", "v", ttl=60)
        mock_cache.set.assert_awaited_once_with("rate:k", "v", ttl=60)

    async def test_set_unavailable(self):
        ctx = self._make_ctx(cache=None)
        result = await ctx.set("k", "v")
        assert result is False

    async def test_get_delegates(self):
        mock_cache = AsyncMock()
        mock_cache.is_connected.return_value = True
        mock_cache.get.return_value = "val"
        ctx = self._make_ctx(cache=mock_cache)
        result = await ctx.get("k")
        assert result == "val"
        mock_cache.get.assert_awaited_once_with("rate:k")

    async def test_get_unavailable(self):
        ctx = self._make_ctx(cache=None)
        result = await ctx.get("k")
        assert result is None

    async def test_delete_delegates(self):
        mock_cache = AsyncMock()
        mock_cache.is_connected.return_value = True
        mock_cache.delete.return_value = True
        ctx = self._make_ctx(cache=mock_cache)
        result = await ctx.delete("k")
        assert result is True

    async def test_delete_unavailable(self):
        ctx = self._make_ctx(cache=None)
        result = await ctx.delete("k")
        assert result is False

    async def test_increment_delegates(self):
        mock_cache = AsyncMock()
        mock_cache.is_connected.return_value = True
        mock_cache.increment.return_value = 3
        ctx = self._make_ctx(cache=mock_cache)
        result = await ctx.increment("counter", amount=2, ttl=60)
        assert result == 3
        mock_cache.increment.assert_awaited_once_with("rate:counter", amount=2, ttl=60)

    async def test_increment_unavailable(self):
        ctx = self._make_ctx(cache=None)
        result = await ctx.increment("counter")
        assert result is None

    def test_cache_property(self):
        mock_cache = MagicMock()
        ctx = self._make_ctx(cache=mock_cache)
        assert ctx.cache is mock_cache

    def test_cache_property_none(self):
        ctx = self._make_ctx(cache=None)
        assert ctx.cache is None
