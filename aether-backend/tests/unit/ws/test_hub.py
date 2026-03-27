"""
Unit Tests: WebSocket Hub (Presentation Layer)

Tests client lifecycle, message delegation, broadcasting,
cleanup_all, shutdown, and error recovery.
Validates presentation layer responsibilities ONLY.

Bugs found: 3
- send_to_client: unregister() was called without try-except,
  meaning cache/router errors during cleanup would propagate
  instead of returning False. Fixed: wrapped in try-except
  to match broadcast_json._send pattern.
- cleanup_all: accessed client.id directly — if a client object
  lacked .id (e.g. SimpleNamespace), AttributeError in the except
  handler caused a double-fault that propagated out. Fixed: use
  getattr(client, "id", None) with fallback to str(client).
- shutdown: cleanup_all() failure prevented cache.shutdown() from
  ever running. Fixed: wrapped cleanup_all() in try/except so
  cache shutdown ALWAYS executes.
"""

import asyncio
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import WebSocket

from ws.presentation.hub import WebSocketHub, Client


@pytest.fixture
def mock_router():
    """Mock router with all required methods."""
    router = MagicMock()
    router.handle_json = AsyncMock()
    router.handle_binary = AsyncMock()
    router.cleanup_client = AsyncMock()
    return router


@pytest.fixture
def mock_cache():
    """Mock cache service with all required methods."""
    cache = MagicMock()
    cache.initialize_presence = AsyncMock()
    cache.mark_presence_disconnected = AsyncMock()
    cache.increment_counter = AsyncMock()
    cache.set_active_gauge = AsyncMock()
    return cache


@pytest.fixture
def hub(mock_router, mock_cache):
    """Create hub instance."""
    return WebSocketHub(router=mock_router, cache_service=mock_cache)


@pytest.fixture
def mock_websocket():
    """Mock WebSocket connection."""
    ws = MagicMock(spec=WebSocket)
    ws.send_text = AsyncMock()
    return ws


class TestClientLifecycle:
    """Test client registration and cleanup."""
    
    @pytest.mark.asyncio
    async def test_register_creates_client_and_updates_metrics(self, hub, mock_websocket, mock_cache):
        """REAL TEST: Registration creates client, initializes presence, updates metrics."""
        client = await hub.register(mock_websocket)
        
        # Verify client created with UUID and stored
        assert client.id is not None
        assert len(client.id) == 36  # UUID format
        assert client.ws == mock_websocket
        assert client.id in hub.clients
        assert hub.get_client_count() == 1
        
        # Verify presence initialized
        mock_cache.initialize_presence.assert_awaited_once_with(client.id)
        
        # Verify metrics updated
        assert mock_cache.increment_counter.call_count == 1
        assert mock_cache.set_active_gauge.call_count == 1
    
    @pytest.mark.asyncio
    async def test_unregister_removes_client_and_cleans_up(self, hub, mock_websocket, mock_router, mock_cache):
        """REAL TEST: Unregister removes client, cleans up resources, updates metrics."""
        client = await hub.register(mock_websocket)
        mock_cache.reset_mock()  # Reset to isolate unregister calls
        
        await hub.unregister(client)
        
        # Verify client removed
        assert client.id not in hub.clients
        assert hub.get_client_count() == 0
        
        # Verify router cleanup called
        mock_router.cleanup_client.assert_awaited_once_with(client.id)
        
        # Verify presence marked disconnected
        mock_cache.mark_presence_disconnected.assert_awaited_once_with(client.id)
        
        # Verify metrics updated
        mock_cache.increment_counter.assert_awaited_once_with("disconnects_total")
        mock_cache.set_active_gauge.assert_awaited_once_with("active", 0)
    
    @pytest.mark.asyncio
    async def test_multiple_clients_tracked_independently(self, hub):
        """REAL TEST: Multiple clients can be registered and tracked separately."""
        ws1 = MagicMock(spec=WebSocket)
        ws2 = MagicMock(spec=WebSocket)
        ws3 = MagicMock(spec=WebSocket)
        
        client1 = await hub.register(ws1)
        client2 = await hub.register(ws2)
        client3 = await hub.register(ws3)
        
        # Verify all clients tracked
        assert hub.get_client_count() == 3
        ids = hub.get_client_ids()
        assert client1.id in ids
        assert client2.id in ids
        assert client3.id in ids
        
        # Verify unique IDs
        assert len(set([client1.id, client2.id, client3.id])) == 3


class TestMessageDelegation:
    """Test message delegation to router."""
    
    @pytest.mark.asyncio
    async def test_json_messages_delegated_to_router(self, hub, mock_websocket, mock_router):
        """REAL TEST: JSON messages passed to router with correct parameters."""
        client = await hub.register(mock_websocket)
        text = '{"type": "user.message", "content": "test"}'
        
        await hub.handle_json(client, text)
        
        mock_router.handle_json.assert_awaited_once_with(
            ws=mock_websocket,
            client_id=client.id,
            text=text,
        )
    
    @pytest.mark.asyncio
    async def test_binary_data_delegated_to_router(self, hub, mock_websocket, mock_router):
        """REAL TEST: Binary data passed to router with correct parameters."""
        client = await hub.register(mock_websocket)
        audio_data = b'\x00\x01\x02\x03audio_chunk_data'
        
        await hub.handle_binary(client, audio_data)
        
        mock_router.handle_binary.assert_awaited_once_with(
            client_id=client.id,
            data=audio_data,
        )


class TestBroadcasting:
    """Test broadcasting to all clients."""
    
    @pytest.mark.asyncio
    async def test_broadcast_sends_to_all_clients(self, hub):
        """REAL TEST: Broadcast sends same message to all connected clients."""
        ws1 = MagicMock(spec=WebSocket)
        ws1.send_text = AsyncMock()
        ws2 = MagicMock(spec=WebSocket)
        ws2.send_text = AsyncMock()
        ws3 = MagicMock(spec=WebSocket)
        ws3.send_text = AsyncMock()
        
        await hub.register(ws1)
        await hub.register(ws2)
        await hub.register(ws3)
        
        payload = {"type": "system.notification", "message": "Server restarting"}
        await hub.broadcast_json(payload)
        
        # Verify all clients received broadcast
        ws1.send_text.assert_awaited_once()
        ws2.send_text.assert_awaited_once()
        ws3.send_text.assert_awaited_once()
        
        # Verify correct payload serialization
        import json
        expected_text = json.dumps(payload)
        ws1.send_text.assert_awaited_with(expected_text)
    
    @pytest.mark.asyncio
    async def test_broadcast_with_no_clients_doesnt_error(self, hub):
        """REAL TEST: Broadcasting with no clients is safe operation."""
        await hub.broadcast_json({"type": "test"})
        # Should complete without error
    
    @pytest.mark.asyncio
    async def test_send_to_client_returns_false_on_failure(self, hub):
        """REAL TEST: Failed sends return False and trigger unregister."""
        ws = MagicMock(spec=WebSocket)
        ws.send_text = AsyncMock(side_effect=Exception("Connection broken"))
        
        client = await hub.register(ws)
        result = await hub.send_to_client(client, {"type": "test"})
        
        assert result is False
        # Client should be auto-unregistered on failure
        assert client.id not in hub.clients


# ---------------------------------------------------------------------------
# send_to_client (extended)
# ---------------------------------------------------------------------------

class TestSendToClient:
    """Extended tests for send_to_client success and edge cases."""

    @pytest.mark.asyncio
    async def test_returns_true_on_success(self, hub, mock_websocket):
        """Success path returns True and keeps client registered."""
        client = await hub.register(mock_websocket)

        result = await hub.send_to_client(client, {"type": "ping"})

        assert result is True
        assert client.id in hub.clients
        mock_websocket.send_text.assert_awaited_once()
        sent = json.loads(mock_websocket.send_text.call_args[0][0])
        assert sent == {"type": "ping"}

    @pytest.mark.asyncio
    async def test_serializes_message_as_json(self, hub, mock_websocket):
        """Message dict is JSON-serialized before sending."""
        client = await hub.register(mock_websocket)
        message = {"role": "server", "type": "info", "data": [1, 2, 3]}

        await hub.send_to_client(client, message)

        raw = mock_websocket.send_text.call_args[0][0]
        assert json.loads(raw) == message

    @pytest.mark.asyncio
    async def test_unregister_failure_still_returns_false(self, hub, mock_cache):
        """If unregister itself fails, send_to_client still returns False (bug fix)."""
        ws = MagicMock(spec=WebSocket)
        ws.send_text = AsyncMock(side_effect=RuntimeError("connection lost"))

        client = await hub.register(ws)

        # Make unregister fail by making cache operation blow up
        mock_cache.mark_presence_disconnected.side_effect = Exception("cache down")

        result = await hub.send_to_client(client, {"type": "test"})

        # Must return False, not propagate the cache exception
        assert result is False

    @pytest.mark.asyncio
    async def test_timeout_triggers_failure_path(self, hub):
        """Timeout on send_text triggers the failure path."""
        ws = MagicMock(spec=WebSocket)

        async def slow_send(_text):
            await asyncio.sleep(100)

        ws.send_text = AsyncMock(side_effect=slow_send)
        client = await hub.register(ws)

        # Patch timeout to be very short
        with patch("ws.presentation.hub.WS_SEND_TIMEOUT", 0.001):
            result = await hub.send_to_client(client, {"type": "test"})

        assert result is False
        assert client.id not in hub.clients


# ---------------------------------------------------------------------------
# broadcast_json (extended - error handling and timeout)
# ---------------------------------------------------------------------------

class TestBroadcastErrorHandling:
    """Tests for broadcast error recovery and timeout."""

    @pytest.mark.asyncio
    async def test_failing_client_unregistered_during_broadcast(self, hub, mock_router):
        """A client that fails during broadcast is unregistered."""
        ws_good = MagicMock(spec=WebSocket)
        ws_good.send_text = AsyncMock()
        ws_bad = MagicMock(spec=WebSocket)
        ws_bad.send_text = AsyncMock(side_effect=RuntimeError("connection reset"))

        client_good = await hub.register(ws_good)
        client_bad = await hub.register(ws_bad)
        assert hub.get_client_count() == 2

        await hub.broadcast_json({"type": "test"})

        # Good client still registered, bad client removed
        assert client_good.id in hub.clients
        assert client_bad.id not in hub.clients
        assert hub.get_client_count() == 1

        # Good client received the message
        ws_good.send_text.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_failing_client_unregister_error_swallowed(self, hub, mock_cache):
        """If unregister fails during broadcast, the error is swallowed."""
        ws_bad = MagicMock(spec=WebSocket)
        ws_bad.send_text = AsyncMock(side_effect=OSError("broken pipe"))

        await hub.register(ws_bad)

        # Make unregister blow up
        mock_cache.mark_presence_disconnected.side_effect = Exception("cache down")

        # Should not raise
        await hub.broadcast_json({"type": "test"})

    @pytest.mark.asyncio
    async def test_broadcast_timeout_caught(self, hub):
        """Overall broadcast timeout is caught and logged, not raised."""
        ws_slow = MagicMock(spec=WebSocket)

        async def slow_send(_text):
            await asyncio.sleep(100)

        ws_slow.send_text = AsyncMock(side_effect=slow_send)
        await hub.register(ws_slow)

        with patch("ws.presentation.hub.WS_BROADCAST_TIMEOUT", 0.001):
            # Should not raise
            await hub.broadcast_json({"type": "test"})

    @pytest.mark.asyncio
    async def test_broadcast_timeout_logs_warning(self, hub):
        """Broadcast timeout logs a warning."""
        ws_slow = MagicMock(spec=WebSocket)

        async def slow_send(_text):
            await asyncio.sleep(100)

        ws_slow.send_text = AsyncMock(side_effect=slow_send)
        await hub.register(ws_slow)

        with patch("ws.presentation.hub.WS_BROADCAST_TIMEOUT", 0.001):
            with patch.object(hub._logger, "warning") as mock_warn:
                await hub.broadcast_json({"type": "test"})
                mock_warn.assert_called_once()
                assert "timeout" in mock_warn.call_args[0][0].lower()


# ---------------------------------------------------------------------------
# cleanup_all
# ---------------------------------------------------------------------------

class TestCleanupAll:
    """Tests for cleanup_all (shutdown helper)."""

    @pytest.mark.asyncio
    async def test_clears_all_clients(self, hub, mock_router):
        """All clients removed and router cleanup called for each."""
        ws1 = MagicMock(spec=WebSocket)
        ws2 = MagicMock(spec=WebSocket)

        client1 = await hub.register(ws1)
        client2 = await hub.register(ws2)
        assert hub.get_client_count() == 2

        await hub.cleanup_all()

        assert hub.get_client_count() == 0
        assert mock_router.cleanup_client.await_count == 2
        cleanup_ids = [
            call.args[0] for call in mock_router.cleanup_client.call_args_list
        ]
        assert client1.id in cleanup_ids
        assert client2.id in cleanup_ids

    @pytest.mark.asyncio
    async def test_empty_clients_is_safe(self, hub, mock_router):
        """cleanup_all with no clients does not error."""
        assert hub.get_client_count() == 0
        await hub.cleanup_all()
        mock_router.cleanup_client.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_router_error_does_not_stop_cleanup(self, hub, mock_router):
        """If router.cleanup_client fails for one client, others still cleaned."""
        ws1 = MagicMock(spec=WebSocket)
        ws2 = MagicMock(spec=WebSocket)
        ws3 = MagicMock(spec=WebSocket)

        await hub.register(ws1)
        await hub.register(ws2)
        await hub.register(ws3)

        # First call fails, rest succeed
        mock_router.cleanup_client.side_effect = [
            Exception("router error"),
            None,
            None,
        ]

        await hub.cleanup_all()

        # All clients removed from dict despite error
        assert hub.get_client_count() == 0
        # All three cleanup attempts were made
        assert mock_router.cleanup_client.await_count == 3

    @pytest.mark.asyncio
    async def test_clients_dict_cleared_before_cleanup(self, hub, mock_router):
        """Clients dict is cleared atomically before per-client cleanup runs."""
        ws = MagicMock(spec=WebSocket)
        await hub.register(ws)

        # During cleanup_client, the clients dict should already be empty
        async def check_clients_empty(client_id):
            assert hub.get_client_count() == 0

        mock_router.cleanup_client.side_effect = check_clients_empty

        await hub.cleanup_all()


# ---------------------------------------------------------------------------
# shutdown
# ---------------------------------------------------------------------------

class TestShutdown:
    """Tests for shutdown method."""

    @pytest.mark.asyncio
    async def test_calls_cleanup_all(self, hub, mock_router):
        """Shutdown calls cleanup_all to remove all clients."""
        ws = MagicMock(spec=WebSocket)
        client = await hub.register(ws)

        await hub.shutdown()

        assert hub.get_client_count() == 0
        mock_router.cleanup_client.assert_awaited_once_with(client.id)

    @pytest.mark.asyncio
    async def test_calls_cache_shutdown(self, hub, mock_cache):
        """Shutdown calls cache_service.shutdown if method exists."""
        mock_cache.shutdown = AsyncMock()

        await hub.shutdown()

        mock_cache.shutdown.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_skips_cache_shutdown_if_no_method(self, hub, mock_cache):
        """If cache has no shutdown method, it's skipped gracefully."""
        # Remove shutdown if it exists
        if hasattr(mock_cache, "shutdown"):
            del mock_cache.shutdown

        # Should not raise
        await hub.shutdown()

    @pytest.mark.asyncio
    async def test_cache_shutdown_error_swallowed(self, hub, mock_cache):
        """If cache.shutdown() fails, error is caught and logged."""
        mock_cache.shutdown = AsyncMock(side_effect=Exception("cache cleanup failed"))

        # Should not raise
        await hub.shutdown()

    @pytest.mark.asyncio
    async def test_cache_shutdown_error_logged(self, hub, mock_cache):
        """Cache shutdown failure is logged at debug level."""
        mock_cache.shutdown = AsyncMock(side_effect=Exception("redis gone"))

        with patch.object(hub._logger, "debug") as mock_debug:
            await hub.shutdown()
            # At least one debug call should mention cache
            cache_calls = [
                c for c in mock_debug.call_args_list
                if "cache" in str(c).lower() or "shutdown" in str(c).lower()
            ]
            assert len(cache_calls) >= 1

    @pytest.mark.asyncio
    async def test_full_shutdown_sequence(self, hub, mock_router, mock_cache):
        """Full shutdown: clients cleaned, cache shutdown called."""
        mock_cache.shutdown = AsyncMock()
        ws1 = MagicMock(spec=WebSocket)
        ws2 = MagicMock(spec=WebSocket)

        await hub.register(ws1)
        await hub.register(ws2)

        await hub.shutdown()

        # All clients gone
        assert hub.get_client_count() == 0
        # Router cleanup called for each client
        assert mock_router.cleanup_client.await_count == 2
        # Cache shutdown called
        mock_cache.shutdown.assert_awaited_once()


# ---------------------------------------------------------------------------
# Client dataclass
# ---------------------------------------------------------------------------

class TestClientDataclass:
    """Tests for Client dataclass."""

    def test_default_active_chat_id_is_none(self):
        """active_chat_id defaults to None."""
        ws = MagicMock(spec=WebSocket)
        client = Client(id="test-id", ws=ws)
        assert client.active_chat_id is None

    def test_active_chat_id_can_be_set(self):
        """active_chat_id can be set at construction."""
        ws = MagicMock(spec=WebSocket)
        client = Client(id="test-id", ws=ws, active_chat_id="chat-001")
        assert client.active_chat_id == "chat-001"


# ---------------------------------------------------------------------------
# Adversarial: shutdown guarantees cache cleanup (regression)
# ---------------------------------------------------------------------------

class TestShutdownGuaranteeCacheCleanup:
    """Regression: shutdown() MUST call cache.shutdown() even when cleanup_all() raises.

    Root cause: cleanup_all() accessed client.id which AttributeError'd on
    non-standard client objects. The except handler also accessed client.id,
    causing a double-fault that escaped cleanup_all(). shutdown() had no
    try/except around cleanup_all(), so cache.shutdown() was never reached.
    """

    @pytest.mark.asyncio
    async def test_cache_shutdown_called_when_cleanup_all_raises(self, mock_router, mock_cache):
        """If cleanup_all() itself raises, cache.shutdown() MUST still be called."""
        hub = WebSocketHub(router=mock_router, cache_service=mock_cache)
        mock_cache.shutdown = AsyncMock()

        # Register a real client, then make router.cleanup_client raise
        # an exception that cleanup_all's try/except does NOT catch
        # (to simulate cleanup_all raising)
        ws = MagicMock(spec=WebSocket)
        await hub.register(ws)

        # Patch cleanup_all to raise directly
        async def exploding_cleanup():
            raise RuntimeError("catastrophic cleanup failure")

        hub.cleanup_all = exploding_cleanup

        await hub.shutdown()

        # cache.shutdown MUST have been called despite cleanup_all raising
        mock_cache.shutdown.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cache_shutdown_called_when_cleanup_all_raises_type_error(self, mock_router, mock_cache):
        """TypeError during cleanup_all still allows cache shutdown."""
        hub = WebSocketHub(router=mock_router, cache_service=mock_cache)
        mock_cache.shutdown = AsyncMock()

        async def type_error_cleanup():
            raise TypeError("unexpected None")

        hub.cleanup_all = type_error_cleanup

        await hub.shutdown()
        mock_cache.shutdown.assert_awaited_once()


# ---------------------------------------------------------------------------
# Adversarial: cleanup_all with malformed clients (regression)
# ---------------------------------------------------------------------------

class TestCleanupAllMalformedClients:
    """Regression: cleanup_all() must handle clients without .id attribute.

    Root cause: callback tests in test_ws_factory.py injected
    SimpleNamespace(ws=..., active_chat_id=...) into hub.clients without
    an .id attribute. cleanup_all() accessed client.id directly, causing
    AttributeError. The except handler also accessed client.id, causing
    a second AttributeError that escaped the try/except.
    """

    @pytest.mark.asyncio
    async def test_client_without_id_attribute(self, mock_router, mock_cache):
        """cleanup_all survives clients lacking .id attribute."""
        from types import SimpleNamespace
        hub = WebSocketHub(router=mock_router, cache_service=mock_cache)

        # Inject a client WITHOUT .id (as callback tests do)
        fake_client = SimpleNamespace(ws=MagicMock(), active_chat_id="chat-1")
        hub.clients["c1"] = fake_client

        # Must NOT raise
        await hub.cleanup_all()

        # Dict should be cleared
        assert hub.get_client_count() == 0
        # Router cleanup should have been attempted with the client ID
        mock_router.cleanup_client.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_mixed_real_and_malformed_clients(self, mock_router, mock_cache):
        """cleanup_all handles mix of proper Client objects and raw dicts/namespaces."""
        from types import SimpleNamespace
        hub = WebSocketHub(router=mock_router, cache_service=mock_cache)

        # One proper client
        ws = MagicMock(spec=WebSocket)
        real_client = await hub.register(ws)

        # One malformed client
        fake = SimpleNamespace(ws=MagicMock())
        hub.clients["fake-1"] = fake

        assert hub.get_client_count() == 2

        await hub.cleanup_all()

        assert hub.get_client_count() == 0
        # Both should have had cleanup attempted
        assert mock_router.cleanup_client.await_count == 2

    @pytest.mark.asyncio
    async def test_cleanup_all_router_error_on_malformed_client_swallowed(self, mock_router, mock_cache):
        """Router error during malformed-client cleanup is swallowed."""
        from types import SimpleNamespace
        hub = WebSocketHub(router=mock_router, cache_service=mock_cache)

        fake = SimpleNamespace(ws=MagicMock())
        hub.clients["c1"] = fake

        mock_router.cleanup_client.side_effect = RuntimeError("unknown client")

        # Must NOT raise
        await hub.cleanup_all()
        assert hub.get_client_count() == 0


# ---------------------------------------------------------------------------
# Adversarial: shutdown idempotency and edge cases
# ---------------------------------------------------------------------------

class TestShutdownEdgeCases:
    """Edge cases for shutdown."""

    @pytest.mark.asyncio
    async def test_double_shutdown_is_safe(self, hub, mock_cache):
        """Calling shutdown() twice does not raise."""
        mock_cache.shutdown = AsyncMock()

        ws = MagicMock(spec=WebSocket)
        await hub.register(ws)

        await hub.shutdown()
        await hub.shutdown()

        # Should be called twice (idempotent)
        assert mock_cache.shutdown.await_count == 2
        assert hub.get_client_count() == 0

    @pytest.mark.asyncio
    async def test_shutdown_with_no_cache(self, mock_router):
        """Shutdown with None cache_service is safe."""
        hub = WebSocketHub(router=mock_router, cache_service=None)

        # Should not raise
        await hub.shutdown()

    @pytest.mark.asyncio
    async def test_unregister_already_removed_client(self, hub, mock_router, mock_cache):
        """Unregistering a client that was already removed is safe."""
        ws = MagicMock(spec=WebSocket)
        client = await hub.register(ws)

        # Unregister twice
        await hub.unregister(client)
        mock_router.cleanup_client.reset_mock()
        mock_cache.reset_mock()

        # Second unregister — client already gone from dict
        await hub.unregister(client)

        # Router cleanup still called (it's the router's job to handle duplicates)
        mock_router.cleanup_client.assert_awaited_once_with(client.id)
        # Client count stays at 0
        assert hub.get_client_count() == 0


# ---------------------------------------------------------------------------
# Adversarial: serialization edge cases
# ---------------------------------------------------------------------------

class TestSerializationEdgeCases:
    """Edge cases for JSON serialization in send/broadcast."""

    @pytest.mark.asyncio
    async def test_send_non_serializable_message_returns_false(self, hub, mock_websocket):
        """Non-JSON-serializable message triggers failure path."""
        client = await hub.register(mock_websocket)

        # datetime is not JSON serializable
        from datetime import datetime
        non_serializable = {"time": datetime.now()}

        result = await hub.send_to_client(client, non_serializable)
        assert result is False

    @pytest.mark.asyncio
    async def test_broadcast_non_serializable_raises(self, hub):
        """Non-serializable broadcast payload raises TypeError."""
        ws = MagicMock(spec=WebSocket)
        ws.send_text = AsyncMock()
        await hub.register(ws)

        from datetime import datetime
        # json.dumps at the START of broadcast_json raises TypeError
        with pytest.raises(TypeError):
            await hub.broadcast_json({"time": datetime.now()})
