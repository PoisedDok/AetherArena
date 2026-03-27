"""
Unit Tests: ws/infrastructure/cache/redis_adapter.py

Tests the Redis cache adapter — get, set, increment, delete operations
with mocked Redis client. No real Redis connection needed.

No bugs found. Module is well-structured with consistent error handling.

Observations:
1. is_connected lines 55-59 are dead code — try block only has return True,
   except clause can never be reached.
2. increment TTL comment claims NX flag behavior but code always resets TTL
   via expire() — misleading comment but not a behavior bug.
3. ttl=0 is treated as "no TTL" in both set and increment (falsy check).
"""

import json
from unittest.mock import AsyncMock

from redis.exceptions import RedisError

from ws.infrastructure.cache.redis_adapter import RedisAdapter


# =========================================================================
# Helpers
# =========================================================================

def _mock_redis():
    """Create a mock Redis client with standard async methods."""
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    redis.set = AsyncMock(return_value=True)
    redis.setex = AsyncMock(return_value=True)
    redis.incrby = AsyncMock(return_value=1)
    redis.expire = AsyncMock(return_value=True)
    redis.delete = AsyncMock(return_value=1)
    return redis


# =========================================================================
# Init
# =========================================================================

class TestInit:
    """Tests for RedisAdapter.__init__."""

    def test_stores_redis_client(self):
        redis = _mock_redis()
        adapter = RedisAdapter(redis_client=redis)
        assert adapter._redis is redis

    def test_default_none_client(self):
        adapter = RedisAdapter()
        assert adapter._redis is None


# =========================================================================
# is_connected
# =========================================================================

class TestIsConnected:
    """Tests for is_connected (lines 46-59)."""

    def test_no_redis_returns_false(self):
        """No redis client → False."""
        adapter = RedisAdapter()
        assert adapter.is_connected() is False

    def test_with_redis_returns_true(self):
        """Redis client present → True (simplified check)."""
        adapter = RedisAdapter(redis_client=_mock_redis())
        assert adapter.is_connected() is True


# =========================================================================
# get
# =========================================================================

class TestGet:
    """Tests for async get (lines 61-83)."""

    async def test_no_redis_returns_none(self):
        """No redis client → None."""
        adapter = RedisAdapter()
        result = await adapter.get("key")
        assert result is None

    async def test_key_not_found_returns_none(self):
        """Key doesn't exist → redis returns None → adapter returns None."""
        redis = _mock_redis()
        redis.get.return_value = None
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.get("missing-key")

        assert result is None
        redis.get.assert_awaited_once_with("missing-key")

    async def test_success_returns_parsed_json_dict(self):
        """Valid JSON dict → parsed and returned."""
        data = {"name": "test", "count": 42}
        redis = _mock_redis()
        redis.get.return_value = json.dumps(data)
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.get("my-key")

        assert result == data
        redis.get.assert_awaited_once_with("my-key")

    async def test_success_returns_parsed_json_list(self):
        """Valid JSON list → parsed and returned."""
        data = [1, 2, 3]
        redis = _mock_redis()
        redis.get.return_value = json.dumps(data)
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.get("list-key")

        assert result == data

    async def test_success_returns_parsed_json_string(self):
        """Valid JSON string → parsed and returned."""
        redis = _mock_redis()
        redis.get.return_value = json.dumps("hello")
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.get("str-key")

        assert result == "hello"

    async def test_redis_error_returns_none(self):
        """RedisError during get → caught, returns None."""
        redis = _mock_redis()
        redis.get.side_effect = RedisError("connection lost")
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.get("error-key")

        assert result is None

    async def test_json_decode_error_returns_none(self):
        """Invalid JSON in Redis → JSONDecodeError caught, returns None."""
        redis = _mock_redis()
        redis.get.return_value = "not-valid-json{{"
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.get("bad-json-key")

        assert result is None


# =========================================================================
# set
# =========================================================================

class TestSet:
    """Tests for async set (lines 85-116)."""

    async def test_no_redis_returns_false(self):
        """No redis client → False."""
        adapter = RedisAdapter()
        result = await adapter.set("key", {"data": 1})
        assert result is False

    async def test_success_without_ttl(self):
        """No TTL → uses redis.set (not setex)."""
        redis = _mock_redis()
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.set("k", {"v": 1})

        assert result is True
        redis.set.assert_awaited_once_with("k", json.dumps({"v": 1}))
        redis.setex.assert_not_awaited()

    async def test_success_with_ttl(self):
        """TTL provided → uses redis.setex."""
        redis = _mock_redis()
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.set("k", {"v": 1}, ttl=300)

        assert result is True
        redis.setex.assert_awaited_once_with("k", 300, json.dumps({"v": 1}))
        redis.set.assert_not_awaited()

    async def test_ttl_zero_uses_set_not_setex(self):
        """ttl=0 is falsy → code takes 'no TTL' branch via redis.set."""
        redis = _mock_redis()
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.set("k", {"v": 1}, ttl=0)

        assert result is True
        redis.set.assert_awaited_once()
        redis.setex.assert_not_awaited()

    async def test_redis_error_returns_false(self):
        """RedisError during set → caught, returns False."""
        redis = _mock_redis()
        redis.set.side_effect = RedisError("write failed")
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.set("k", {"v": 1})

        assert result is False

    async def test_redis_error_on_setex_returns_false(self):
        """RedisError during setex → caught, returns False."""
        redis = _mock_redis()
        redis.setex.side_effect = RedisError("write failed")
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.set("k", {"v": 1}, ttl=60)

        assert result is False

    async def test_type_error_on_serialize_returns_false(self):
        """Value that can't be JSON serialized (TypeError) → False."""
        redis = _mock_redis()
        adapter = RedisAdapter(redis_client=redis)

        # set() is a builtin that json.dumps can't serialize
        result = await adapter.set("k", {"func": set()})

        assert result is False

    async def test_value_error_on_serialize_returns_false(self):
        """ValueError during serialization → False."""
        redis = _mock_redis()
        adapter = RedisAdapter(redis_client=redis)

        # float('nan') causes ValueError in strict JSON encoding
        # Actually json.dumps(float('nan')) doesn't raise ValueError by default.
        # But a custom encoder could. Let's use a circular reference instead.
        # Circular references raise ValueError in json.dumps.
        circular = {}
        circular["self"] = circular

        result = await adapter.set("k", circular)

        assert result is False

    async def test_serializes_nested_structure(self):
        """Complex nested dict is properly serialized."""
        redis = _mock_redis()
        adapter = RedisAdapter(redis_client=redis)

        data = {"nested": {"list": [1, 2, {"deep": True}]}, "null": None}
        result = await adapter.set("complex-key", data)

        assert result is True
        stored = redis.set.call_args[0][1]
        assert json.loads(stored) == data


# =========================================================================
# increment
# =========================================================================

class TestIncrement:
    """Tests for async increment (lines 118-145)."""

    async def test_no_redis_returns_none(self):
        """No redis client → None."""
        adapter = RedisAdapter()
        result = await adapter.increment("counter")
        assert result is None

    async def test_success_default_amount(self):
        """Default amount=1 → incrby(key, 1)."""
        redis = _mock_redis()
        redis.incrby.return_value = 5
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.increment("counter")

        assert result == 5
        redis.incrby.assert_awaited_once_with("counter", 1)
        redis.expire.assert_not_awaited()

    async def test_success_custom_amount(self):
        """Custom amount → incrby(key, amount)."""
        redis = _mock_redis()
        redis.incrby.return_value = 10
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.increment("counter", amount=5)

        assert result == 10
        redis.incrby.assert_awaited_once_with("counter", 5)

    async def test_success_with_ttl(self):
        """TTL provided → calls expire after incrby."""
        redis = _mock_redis()
        redis.incrby.return_value = 1
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.increment("counter", ttl=3600)

        assert result == 1
        redis.incrby.assert_awaited_once_with("counter", 1)
        redis.expire.assert_awaited_once_with("counter", 3600)

    async def test_ttl_zero_skips_expire(self):
        """ttl=0 is falsy → expire not called."""
        redis = _mock_redis()
        redis.incrby.return_value = 1
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.increment("counter", ttl=0)

        assert result == 1
        redis.expire.assert_not_awaited()

    async def test_redis_error_returns_none(self):
        """RedisError during incrby → caught, returns None."""
        redis = _mock_redis()
        redis.incrby.side_effect = RedisError("incr failed")
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.increment("counter")

        assert result is None

    async def test_redis_error_on_expire_returns_none(self):
        """RedisError during expire (after successful incrby) → caught, returns None."""
        redis = _mock_redis()
        redis.incrby.return_value = 1
        redis.expire.side_effect = RedisError("expire failed")
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.increment("counter", ttl=60)

        assert result is None


# =========================================================================
# delete
# =========================================================================

class TestDelete:
    """Tests for async delete (lines 147-164)."""

    async def test_no_redis_returns_false(self):
        """No redis client → False."""
        adapter = RedisAdapter()
        result = await adapter.delete("key")
        assert result is False

    async def test_success_returns_true(self):
        """Successful deletion → True."""
        redis = _mock_redis()
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.delete("my-key")

        assert result is True
        redis.delete.assert_awaited_once_with("my-key")

    async def test_redis_error_returns_false(self):
        """RedisError during delete → caught, returns False."""
        redis = _mock_redis()
        redis.delete.side_effect = RedisError("delete failed")
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.delete("error-key")

        assert result is False

    async def test_delete_nonexistent_key_returns_true(self):
        """Redis delete on nonexistent key returns 0 (no error) → adapter returns True.

        Redis DELETE returns the count of deleted keys (0 if not found).
        The adapter ignores the return value and returns True on no-error.
        """
        redis = _mock_redis()
        redis.delete.return_value = 0  # Key didn't exist
        adapter = RedisAdapter(redis_client=redis)

        result = await adapter.delete("nonexistent")

        assert result is True
