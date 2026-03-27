"""
Unit Tests: Cache Service (Application Layer)

Tests cache operations with Redis adapter and fallback behavior.
Validates application layer cache coordination.

Bugs found and fixed: 2
- shutdown: iscoroutine branch was never tested. MagicMock adapters
  return MagicMock (not coroutine) from stop_cleanup(), so the await
  path was invisible. Real MemoryFallbackCache returns a coroutine.
  Fixed: added tests with real async adapters and MemoryFallbackCache.
- shutdown + __init__: narrow except clause caught only 4 exception types.
  A ValueError or generic Exception from stop_cleanup/start_cleanup would
  propagate and crash the shutdown/init sequence. Fixed: widened to
  catch Exception in both __init__ and shutdown.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from ws.application.cache_service import CacheService


class TestCacheAvailability:
    """Test cache availability checking."""
    
    def test_is_available_returns_true_when_adapter_connected(self):
        """REAL TEST: is_available() returns True when adapter is connected."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        
        cache = CacheService(cache_adapter=adapter)
        
        assert cache.is_available() is True
    
    def test_is_available_returns_false_when_adapter_disconnected(self):
        """REAL TEST: is_available() returns False when adapter not connected."""
        adapter = MagicMock()
        adapter.is_connected.return_value = False
        
        cache = CacheService(cache_adapter=adapter)
        
        assert cache.is_available() is False
    
    def test_is_available_returns_false_when_no_adapter(self):
        """REAL TEST: is_available() returns False when no adapter provided."""
        cache = CacheService(cache_adapter=None)
        
        assert cache.is_available() is False


class TestPresenceOperations:
    """Test client presence tracking."""
    
    @pytest.mark.asyncio
    async def test_initialize_presence_sets_connected_status(self):
        """REAL TEST: initialize_presence() creates presence record with connected status."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock(return_value=True)
        
        cache = CacheService(cache_adapter=adapter)
        
        await cache.initialize_presence("client-123")
        
        # Verify presence record set
        adapter.set.assert_awaited_once()
        call_args = adapter.set.call_args
        assert call_args[0][0] == "ws:presence:client-123"
        assert call_args[0][1]["status"] == "connected"
        assert "connected_at" in call_args[0][1]
    
    @pytest.mark.asyncio
    async def test_mark_presence_disconnected_updates_status(self):
        """REAL TEST: mark_presence_disconnected() updates presence with disconnected status."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value={"client_id": "client-123", "connected_at": "2026-01-01"})
        adapter.set = AsyncMock(return_value=True)
        
        cache = CacheService(cache_adapter=adapter)
        
        await cache.mark_presence_disconnected("client-123")
        
        # Verify disconnected status set
        adapter.set.assert_awaited_once()
        call_args = adapter.set.call_args
        record = call_args[0][1]
        assert record["status"] == "disconnected"
        assert "last_seen" in record
    
    @pytest.mark.asyncio
    async def test_presence_operations_graceful_when_unavailable(self):
        """REAL TEST: Presence operations don't error when cache unavailable."""
        cache = CacheService(cache_adapter=None)
        
        # Should not raise
        await cache.initialize_presence("client-123")
        await cache.mark_presence_disconnected("client-123")


class TestSessionStateOperations:
    """Test session state recording."""
    
    @pytest.mark.asyncio
    async def test_record_session_state_stores_payload(self):
        """REAL TEST: record_session_state() stores payload with updated_at."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock(return_value=True)
        
        cache = CacheService(cache_adapter=adapter)
        
        payload = {
            "client_id": "client-123",
            "state": "active",
            "chat_id": "chat-456",
        }
        
        await cache.record_session_state("request-789", payload)
        
        # Verify session stored
        adapter.set.assert_awaited_once()
        call_args = adapter.set.call_args
        assert call_args[0][0] == "ws:session:request-789"
        record = call_args[0][1]
        assert record["client_id"] == "client-123"
        assert record["state"] == "active"
        assert "updated_at" in record
    
    @pytest.mark.asyncio
    async def test_session_state_graceful_when_unavailable(self):
        """REAL TEST: Session state operations don't error when cache unavailable."""
        cache = CacheService(cache_adapter=None)
        
        await cache.record_session_state("request-123", {"state": "active"})


class TestCounterOperations:
    """Test counter and gauge operations."""
    
    @pytest.mark.asyncio
    async def test_increment_counter_calls_adapter_increment(self):
        """REAL TEST: increment_counter() calls adapter.increment() with correct key."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.increment = AsyncMock(return_value=5)
        
        cache = CacheService(cache_adapter=adapter)
        
        await cache.increment_counter("connections_total")
        
        adapter.increment.assert_awaited_once()
        call_args = adapter.increment.call_args
        assert call_args[0][0] == "ws:counters:connections_total"
        assert call_args[0][1] == 1  # default amount
    
    @pytest.mark.asyncio
    async def test_set_active_gauge_stores_value(self):
        """REAL TEST: set_active_gauge() stores gauge value with metadata."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.set = AsyncMock(return_value=True)
        
        cache = CacheService(cache_adapter=adapter)
        
        await cache.set_active_gauge("active", 42)
        
        adapter.set.assert_awaited_once()
        call_args = adapter.set.call_args
        assert call_args[0][0] == "ws:gauges:active"
        assert call_args[0][1]["value"] == 42
        assert "updated_at" in call_args[0][1]
    
    @pytest.mark.asyncio
    async def test_counter_operations_graceful_when_unavailable(self):
        """REAL TEST: Counter operations don't error when cache unavailable."""
        cache = CacheService(cache_adapter=None)
        
        await cache.increment_counter("test")
        await cache.set_active_gauge("active", 5)


class TestErrorHandling:
    """Test error handling and resilience."""
    
    @pytest.mark.asyncio
    async def test_operations_handle_adapter_exceptions(self):
        """REAL TEST: Operations handle adapter exceptions gracefully."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(side_effect=Exception("Redis timeout"))
        adapter.set = AsyncMock(side_effect=Exception("Redis timeout"))
        adapter.increment = AsyncMock(side_effect=Exception("Redis timeout"))
        
        cache = CacheService(cache_adapter=adapter)
        
        # All operations should handle exceptions without raising
        await cache.initialize_presence("client-123")
        await cache.mark_presence_disconnected("client-123")
        await cache.record_session_state("req-123", {"state": "active"})
        await cache.increment_counter("test")
        await cache.set_active_gauge("active", 1)


# ---------------------------------------------------------------------------
# Constructor & cleanup lifecycle (lines 58-62)
# ---------------------------------------------------------------------------


class TestConstructorCleanupStart:
    """Tests for __init__ cache cleanup initialization."""

    def test_start_cleanup_called_on_adapter_with_method(self):
        """start_cleanup() invoked when adapter supports it."""
        adapter = MagicMock()
        CacheService(cache_adapter=adapter)
        adapter.start_cleanup.assert_called_once()

    def test_start_cleanup_runtime_error_swallowed(self):
        """RuntimeError from start_cleanup is caught and logged, not propagated."""
        adapter = MagicMock()
        adapter.start_cleanup.side_effect = RuntimeError("no event loop running")
        svc = CacheService(cache_adapter=adapter)
        adapter.start_cleanup.assert_called_once()
        assert svc._cache is adapter

    def test_start_cleanup_os_error_swallowed(self):
        """OSError from start_cleanup is caught and logged."""
        adapter = MagicMock()
        adapter.start_cleanup.side_effect = OSError("socket broken")
        svc = CacheService(cache_adapter=adapter)
        assert svc._cache is adapter

    def test_start_cleanup_connection_error_swallowed(self):
        """ConnectionError from start_cleanup is caught and logged."""
        adapter = MagicMock()
        adapter.start_cleanup.side_effect = ConnectionError("connection refused")
        svc = CacheService(cache_adapter=adapter)
        assert svc._cache is adapter

    def test_start_cleanup_attribute_error_swallowed(self):
        """AttributeError from start_cleanup is caught and logged."""
        adapter = MagicMock()
        adapter.start_cleanup.side_effect = AttributeError("broken descriptor")
        svc = CacheService(cache_adapter=adapter)
        assert svc._cache is adapter

    def test_adapter_without_start_cleanup_skips_call(self):
        """Adapter without start_cleanup attribute skips cleanup initialization."""
        class _MinimalAdapter:
            def is_connected(self):
                return True

        adapter = _MinimalAdapter()
        svc = CacheService(cache_adapter=adapter)
        assert svc._cache is adapter

    def test_none_adapter_skips_cleanup_start(self):
        """None adapter skips the cleanup start entirely."""
        svc = CacheService(cache_adapter=None)
        assert svc._cache is None

    def test_custom_ttl_values_stored(self):
        """Non-default TTL values are stored in instance attributes."""
        svc = CacheService(
            cache_adapter=None,
            presence_ttl=60,
            session_ttl=300,
            counter_ttl=7200,
        )
        assert svc._presence_ttl == 60
        assert svc._session_ttl == 300
        assert svc._counter_ttl == 7200


# ---------------------------------------------------------------------------
# update_presence_metadata — both branches (lines 117-123)
# ---------------------------------------------------------------------------


class TestUpdatePresenceMetadata:
    """Tests for update_presence_metadata if/else branches."""

    @pytest.mark.asyncio
    async def test_with_fields_passes_custom_fields_to_record(self):
        """When fields provided, they are forwarded to _set_presence_record."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.update_presence_metadata(
            "client-1",
            status="active",
            last_event="user_message",
        )

        adapter.set.assert_awaited_once()
        record = adapter.set.call_args[0][1]
        assert record["status"] == "active"
        assert record["last_event"] == "user_message"
        assert record["client_id"] == "client-1"
        assert "updated_at" in record
        assert "last_seen" in record

    @pytest.mark.asyncio
    async def test_without_fields_sends_heartbeat_with_last_seen(self):
        """When no fields provided, sends heartbeat with generated last_seen only."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.update_presence_metadata("client-1")

        adapter.set.assert_awaited_once()
        record = adapter.set.call_args[0][1]
        assert record["client_id"] == "client-1"
        assert "last_seen" in record
        assert "updated_at" in record
        # Heartbeat record should only contain standard fields (no custom metadata)
        allowed_keys = {"client_id", "connected_at", "last_seen", "updated_at"}
        for key in record:
            assert key in allowed_keys, f"Unexpected key in heartbeat: {key}"

    @pytest.mark.asyncio
    async def test_unavailable_cache_returns_early(self):
        """update_presence_metadata with unavailable cache does nothing."""
        svc = CacheService(cache_adapter=None)
        # Should not raise — early return before _set_presence_record
        await svc.update_presence_metadata("client-1", status="active")


# ---------------------------------------------------------------------------
# shutdown (lines 239-246)
# ---------------------------------------------------------------------------


class TestShutdown:
    """Tests for shutdown method."""

    @pytest.mark.asyncio
    async def test_calls_stop_cleanup_on_adapter(self):
        """shutdown() calls stop_cleanup when adapter supports it."""
        adapter = MagicMock()
        svc = CacheService(cache_adapter=adapter)
        await svc.shutdown()
        adapter.stop_cleanup.assert_called_once()

    @pytest.mark.asyncio
    async def test_no_adapter_skips_shutdown(self):
        """shutdown() with None adapter completes silently."""
        svc = CacheService(cache_adapter=None)
        await svc.shutdown()

    @pytest.mark.asyncio
    async def test_adapter_without_stop_cleanup_skips(self):
        """shutdown() skips stop_cleanup when adapter lacks the method."""
        class _AdapterNoStop:
            def is_connected(self):
                return True
            def start_cleanup(self):
                pass

        adapter = _AdapterNoStop()
        svc = CacheService(cache_adapter=adapter)
        await svc.shutdown()  # No AttributeError

    @pytest.mark.asyncio
    async def test_runtime_error_in_stop_cleanup_swallowed(self):
        """RuntimeError from stop_cleanup is caught, not propagated."""
        adapter = MagicMock()
        adapter.stop_cleanup.side_effect = RuntimeError("event loop closed")
        svc = CacheService(cache_adapter=adapter)
        await svc.shutdown()
        adapter.stop_cleanup.assert_called_once()

    @pytest.mark.asyncio
    async def test_os_error_in_stop_cleanup_swallowed(self):
        """OSError from stop_cleanup is caught, not propagated."""
        adapter = MagicMock()
        adapter.stop_cleanup.side_effect = OSError("socket error")
        svc = CacheService(cache_adapter=adapter)
        await svc.shutdown()

    @pytest.mark.asyncio
    async def test_connection_error_in_stop_cleanup_swallowed(self):
        """ConnectionError from stop_cleanup is caught, not propagated."""
        adapter = MagicMock()
        adapter.stop_cleanup.side_effect = ConnectionError("refused")
        svc = CacheService(cache_adapter=adapter)
        await svc.shutdown()

    @pytest.mark.asyncio
    async def test_attribute_error_in_stop_cleanup_swallowed(self):
        """AttributeError from stop_cleanup is caught, not propagated."""
        adapter = MagicMock()
        adapter.stop_cleanup.side_effect = AttributeError("broken")
        svc = CacheService(cache_adapter=adapter)
        await svc.shutdown()


# ---------------------------------------------------------------------------
# Presence record merge details + TTL verification
# ---------------------------------------------------------------------------


class TestPresenceRecordMergeDetails:
    """Deep tests for _set_presence_record merge behavior and TTL."""

    @pytest.mark.asyncio
    async def test_existing_record_connected_at_preserved(self):
        """connected_at from existing record is preserved via setdefault."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        existing = {
            "client_id": "client-1",
            "connected_at": "2026-01-01T00:00:00+00:00",
            "status": "connected",
        }
        adapter.get = AsyncMock(return_value=existing)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.mark_presence_disconnected("client-1")

        record = adapter.set.call_args[0][1]
        # connected_at MUST be preserved from existing record, not overwritten
        assert record["connected_at"] == "2026-01-01T00:00:00+00:00"
        assert record["status"] == "disconnected"

    @pytest.mark.asyncio
    async def test_new_record_gets_client_id_from_argument(self):
        """New record (cache miss) includes client_id from method argument."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.initialize_presence("client-xyz")

        record = adapter.set.call_args[0][1]
        assert record["client_id"] == "client-xyz"

    @pytest.mark.asyncio
    async def test_record_always_includes_last_seen_and_updated_at_utc(self):
        """Every presence update includes last_seen and updated_at as UTC ISO."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.initialize_presence("client-1")

        record = adapter.set.call_args[0][1]
        assert "last_seen" in record
        assert "updated_at" in record
        assert "+00:00" in record["last_seen"]
        assert "+00:00" in record["updated_at"]

    @pytest.mark.asyncio
    async def test_presence_ttl_passed_to_cache_set(self):
        """Presence operations use custom presence_ttl in cache set call."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter, presence_ttl=300)
        await svc.initialize_presence("client-1")

        _, kwargs = adapter.set.call_args
        assert kwargs["ttl"] == 300

    @pytest.mark.asyncio
    async def test_initialize_creates_complete_presence_record(self):
        """initialize_presence produces record with all required fields."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.initialize_presence("client-full")

        record = adapter.set.call_args[0][1]
        # Must have all standard fields
        assert record["client_id"] == "client-full"
        assert record["status"] == "connected"
        assert "connected_at" in record
        assert "last_seen" in record
        assert "updated_at" in record
        # Key must be correctly namespaced
        assert adapter.set.call_args[0][0] == "ws:presence:client-full"


# ---------------------------------------------------------------------------
# Session state merge details + TTL
# ---------------------------------------------------------------------------


class TestSessionStateDetails:
    """Deep tests for session state merge behavior and TTL."""

    @pytest.mark.asyncio
    async def test_merges_into_existing_session_record(self):
        """Existing session record fields are preserved when new payload merges."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        existing = {
            "request_id": "req-1",
            "started_at": "2026-01-01T00:00:00+00:00",
            "client_id": "client-1",
        }
        adapter.get = AsyncMock(return_value=existing)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.record_session_state("req-1", {"state": "streaming", "tokens": 42})

        record = adapter.set.call_args[0][1]
        # New fields merged in
        assert record["state"] == "streaming"
        assert record["tokens"] == 42
        # Existing fields preserved
        assert record["started_at"] == "2026-01-01T00:00:00+00:00"
        assert record["client_id"] == "client-1"
        assert "updated_at" in record

    @pytest.mark.asyncio
    async def test_new_session_includes_request_id_from_argument(self):
        """New session record (cache miss) includes request_id from argument."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.record_session_state("req-abc", {"state": "active"})

        record = adapter.set.call_args[0][1]
        assert record["request_id"] == "req-abc"

    @pytest.mark.asyncio
    async def test_session_ttl_passed_to_cache_set(self):
        """Session operations use custom session_ttl in cache set call."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.get = AsyncMock(return_value=None)
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter, session_ttl=1200)
        await svc.record_session_state("req-1", {"state": "active"})

        _, kwargs = adapter.set.call_args
        assert kwargs["ttl"] == 1200


# ---------------------------------------------------------------------------
# Counter / gauge deep assertions + TTL
# ---------------------------------------------------------------------------


class TestCounterDetails:
    """Deep tests for counter/gauge operations with custom amounts and TTL."""

    @pytest.mark.asyncio
    async def test_custom_increment_amount(self):
        """increment_counter with custom amount passes it to adapter."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.increment = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.increment_counter("messages_total", amount=5)

        args = adapter.increment.call_args[0]
        assert args[0] == "ws:counters:messages_total"
        assert args[1] == 5

    @pytest.mark.asyncio
    async def test_counter_ttl_passed_to_increment(self):
        """Counter operations use custom counter_ttl in adapter increment call."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.increment = AsyncMock()

        svc = CacheService(cache_adapter=adapter, counter_ttl=7200)
        await svc.increment_counter("test_metric")

        _, kwargs = adapter.increment.call_args
        assert kwargs["ttl"] == 7200

    @pytest.mark.asyncio
    async def test_gauge_ttl_passed_to_set(self):
        """Gauge operations use counter_ttl in cache set call."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter, counter_ttl=3600)
        await svc.set_active_gauge("active_connections", 10)

        _, kwargs = adapter.set.call_args
        assert kwargs["ttl"] == 3600

    @pytest.mark.asyncio
    async def test_gauge_payload_structure_complete(self):
        """Gauge payload contains exact value and UTC ISO updated_at only."""
        adapter = MagicMock()
        adapter.is_connected.return_value = True
        adapter.set = AsyncMock()

        svc = CacheService(cache_adapter=adapter)
        await svc.set_active_gauge("active", 25)

        payload = adapter.set.call_args[0][1]
        assert payload["value"] == 25
        assert "+00:00" in payload["updated_at"]
        # Gauge payload should contain exactly these two keys
        assert set(payload.keys()) == {"value", "updated_at"}


# ---------------------------------------------------------------------------
# Adversarial: shutdown coroutine path (regression)
# ---------------------------------------------------------------------------


class TestShutdownCoroutinePath:
    """Regression: shutdown() must correctly await async stop_cleanup.

    Root cause: MagicMock adapters return MagicMock from stop_cleanup(),
    which is not a coroutine. The iscoroutine branch was invisible to all
    existing tests. MemoryFallbackCache.stop_cleanup is async and returns
    a coroutine that MUST be awaited — otherwise the task is abandoned.
    """

    @pytest.mark.asyncio
    async def test_async_stop_cleanup_is_awaited(self):
        """When stop_cleanup returns a coroutine, shutdown awaits it."""
        call_log = []

        class _AsyncCleanupAdapter:
            def is_connected(self):
                return True

            def start_cleanup(self):
                pass

            async def stop_cleanup(self):
                call_log.append("stop_cleanup_executed")

        adapter = _AsyncCleanupAdapter()
        svc = CacheService(cache_adapter=adapter)
        await svc.shutdown()

        # Coroutine must have been awaited, executing the body
        assert "stop_cleanup_executed" in call_log

    @pytest.mark.asyncio
    async def test_sync_stop_cleanup_is_called_without_await(self):
        """When stop_cleanup is synchronous, it's called normally (no await)."""
        call_log = []

        class _SyncCleanupAdapter:
            def is_connected(self):
                return True

            def start_cleanup(self):
                pass

            def stop_cleanup(self):
                call_log.append("sync_stop_called")

        adapter = _SyncCleanupAdapter()
        svc = CacheService(cache_adapter=adapter)
        await svc.shutdown()

        assert "sync_stop_called" in call_log

    @pytest.mark.asyncio
    async def test_async_stop_cleanup_error_caught(self):
        """RuntimeError from an async stop_cleanup is caught."""

        class _FailingAsyncAdapter:
            def is_connected(self):
                return True

            def start_cleanup(self):
                pass

            async def stop_cleanup(self):
                raise RuntimeError("event loop closing")

        adapter = _FailingAsyncAdapter()
        svc = CacheService(cache_adapter=adapter)
        # Must not raise
        await svc.shutdown()

    @pytest.mark.asyncio
    async def test_real_memory_fallback_cache_shutdown(self):
        """Integration: CacheService with real MemoryFallbackCache shuts down cleanly.

        This is the EXACT scenario that was broken: MemoryFallbackCache.stop_cleanup
        is async, returning a coroutine. CacheService.shutdown must await it.
        """
        from ws.infrastructure.cache.memory_fallback import MemoryFallbackCache

        cache = MemoryFallbackCache(cleanup_interval=9999)
        cache.start_cleanup()
        assert cache._cleanup_task is not None

        svc = CacheService.__new__(CacheService)
        svc._cache = cache
        svc._logger = __import__("logging").getLogger("test")

        await svc.shutdown()

        # Task must be fully resolved — not "destroyed but pending"
        assert cache._cleanup_task is None


# ---------------------------------------------------------------------------
# Adversarial: shutdown narrow except clause (documents behavior)
# ---------------------------------------------------------------------------


class TestShutdownExceptionBoundary:
    """Shutdown catches all Exception types from stop_cleanup.

    shutdown is a cleanup path — it must never propagate exceptions
    to its caller. Any exception from stop_cleanup is logged and
    swallowed, ensuring the shutdown sequence completes.
    """

    @pytest.mark.asyncio
    async def test_value_error_swallowed(self):
        """ValueError from stop_cleanup is caught and swallowed."""
        adapter = MagicMock()
        adapter.stop_cleanup.side_effect = ValueError("unexpected")

        svc = CacheService(cache_adapter=adapter)
        # Must NOT raise
        await svc.shutdown()

    @pytest.mark.asyncio
    async def test_generic_exception_swallowed(self):
        """Generic Exception from stop_cleanup is caught and swallowed."""
        adapter = MagicMock()
        adapter.stop_cleanup.side_effect = Exception("generic failure")

        svc = CacheService(cache_adapter=adapter)
        # Must NOT raise
        await svc.shutdown()


# ---------------------------------------------------------------------------
# Adversarial: __init__ exception boundary
# ---------------------------------------------------------------------------


class TestInitExceptionBoundary:
    """__init__ catches all Exception types from start_cleanup.

    Initialization must not crash if the cleanup task fails to start.
    Any exception from start_cleanup is logged and swallowed.
    """

    def test_value_error_swallowed_from_start_cleanup(self):
        """ValueError from start_cleanup is caught and swallowed."""
        adapter = MagicMock()
        adapter.start_cleanup.side_effect = ValueError("bad state")

        svc = CacheService(cache_adapter=adapter)
        assert svc._cache is adapter  # Service still initialized

    def test_type_error_swallowed_from_start_cleanup(self):
        """TypeError from start_cleanup is caught and swallowed."""
        adapter = MagicMock()
        adapter.start_cleanup.side_effect = TypeError("wrong type")

        svc = CacheService(cache_adapter=adapter)
        assert svc._cache is adapter  # Service still initialized
