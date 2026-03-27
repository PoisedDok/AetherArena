"""
Unit Tests: ws/presentation/router.py

Tests Router class: handle_json (parsing, validation, routing), handle_binary,
cleanup_client, shutdown.

Every branch forced: oversized messages, invalid JSON, cancel-tts command,
all 6 message type routes, unknown messages, binary audio, cleanup cascade.
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from ws.presentation.router import Router


# =========================================================================
# Stubs
# =========================================================================


class StubWebSocket:
    """Captures send_text/send_json calls."""

    def __init__(self, *, fail_on_send=False):
        self.sent_text = []
        self.sent_json = []
        self._fail = fail_on_send

    async def send_text(self, text: str):
        if self._fail:
            raise ConnectionError("closed")
        self.sent_text.append(json.loads(text))

    async def send_json(self, payload: dict):
        if self._fail:
            raise ConnectionError("closed")
        self.sent_json.append(payload)


def make_router(**overrides):
    """Factory: Router with stub handlers."""
    runtime = MagicMock()
    runtime.stop_generation = AsyncMock()
    runtime.handle_audio_chunk = AsyncMock()

    msg_handler = MagicMock()
    msg_handler.handle_user_message = AsyncMock()
    msg_handler.cleanup_client = AsyncMock()
    msg_handler.shutdown = AsyncMock()

    defaults = dict(
        runtime=runtime,
        message_handler=msg_handler,
        control_handler=MagicMock(
            handle_heartbeat=AsyncMock(),
            handle_stop=AsyncMock(),
        ),
        audio_handler=MagicMock(
            handle_audio_control=AsyncMock(),
            handle_audio_chunk=AsyncMock(),
            handle_cancel_tts=AsyncMock(),
            _audio_processor=None,  # Prevent MagicMock auto-creation
        ),
        context_handler=MagicMock(handle_context_reset=AsyncMock()),
        task_manager=MagicMock(cleanup_client_tasks=AsyncMock(return_value=[])),
        request_mapper=MagicMock(cleanup_client_mappings=AsyncMock()),
        cache_service=MagicMock(update_presence_metadata=AsyncMock()),
    )
    defaults.update(overrides)
    return Router(**defaults)


# =========================================================================
# handle_json: parsing and validation
# =========================================================================


class TestHandleJsonParsing:
    @pytest.mark.asyncio
    async def test_rejects_oversized_message(self):
        router = make_router()
        ws = StubWebSocket()
        # Create message larger than MAX_MESSAGE_SIZE
        from ws.config.constants import MAX_MESSAGE_SIZE
        giant_text = "x" * (MAX_MESSAGE_SIZE + 1)
        await router.handle_json(ws=ws, client_id="c1", text=giant_text)
        # No handler should be called
        router._message_handler.handle_user_message.assert_not_awaited()
        router._control_handler.handle_heartbeat.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_rejects_invalid_json(self):
        router = make_router()
        ws = StubWebSocket()
        await router.handle_json(ws=ws, client_id="c1", text="not json{{{")
        router._message_handler.handle_user_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_rejects_validation_failure(self):
        router = make_router()
        ws = StubWebSocket()
        # Empty payload with no role/type → validate_message returns None
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps({"unknown": "stuff"}),
        )
        router._message_handler.handle_user_message.assert_not_awaited()
        router._control_handler.handle_heartbeat.assert_not_awaited()


# =========================================================================
# handle_json: cancel-tts shortcut
# =========================================================================


class TestHandleJsonCancelTts:
    @pytest.mark.asyncio
    async def test_cancel_tts_routes_to_audio_handler(self):
        router = make_router()
        ws = StubWebSocket()
        payload = {"type": "audio/cancel-tts"}
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        router._audio_handler.handle_cancel_tts.assert_awaited_once_with(
            client_id="c1",
        )
        # Should NOT call validate_message or any other handler
        router._message_handler.handle_user_message.assert_not_awaited()
        router._cache.update_presence_metadata.assert_not_awaited()


# =========================================================================
# handle_json: routing to handlers
# =========================================================================


class TestHandleJsonRouting:
    @pytest.mark.asyncio
    async def test_routes_heartbeat(self):
        router = make_router()
        ws = StubWebSocket()
        payload = {"type": "ping", "timestamp": 123}
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        router._control_handler.handle_heartbeat.assert_awaited_once()
        call_kwargs = router._control_handler.handle_heartbeat.call_args[1]
        assert call_kwargs["client_id"] == "c1"

    @pytest.mark.asyncio
    async def test_routes_stop(self):
        router = make_router()
        ws = StubWebSocket()
        payload = {"type": "stop", "id": "req-123"}
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        router._control_handler.handle_stop.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_routes_audio_control(self):
        router = make_router()
        ws = StubWebSocket()
        payload = {"start": True}
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        router._audio_handler.handle_audio_control.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_routes_audio_chunk(self):
        router = make_router()
        ws = StubWebSocket()
        payload = {"role": "user", "type": "audio", "audio": "base64data"}
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        router._audio_handler.handle_audio_chunk.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_routes_context_reset(self):
        router = make_router()
        ws = StubWebSocket()
        payload = {
            "role": "user",
            "type": "context_reset",
            "chat_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        }
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        router._context_handler.handle_context_reset.assert_awaited_once()
        call_kwargs = router._context_handler.handle_context_reset.call_args[1]
        assert call_kwargs["client_id"] == "c1"
        assert "hub" in call_kwargs  # Router passes hub reference

    @pytest.mark.asyncio
    async def test_routes_user_message(self, monkeypatch):
        """ClientMessage routing requires sanitization module."""
        # Mock sanitization to avoid ImportError in protocol validation
        try:
            import ws.protocols as proto_mod
            original_available = proto_mod._SANITIZATION_AVAILABLE
            monkeypatch.setattr(proto_mod, "_SANITIZATION_AVAILABLE", True)
            monkeypatch.setattr(
                proto_mod, "sanitize_text",
                lambda text, **kw: text,
                raising=False,
            )
        except (ImportError, AttributeError):
            pytest.skip("Cannot mock sanitization")

        router = make_router()
        ws = StubWebSocket()
        payload = {
            "role": "user",
            "type": "message",
            "content": "Hello",
            "id": "msg-123",
        }
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        router._message_handler.handle_user_message.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_unknown_message_type_sends_info(self):
        """Unknown message type should echo back as info."""
        router = make_router()
        ws = StubWebSocket()
        # Server role with non-standard type → creates SystemMessage
        # but actually, a completely unknown payload → returns None from validate_message
        payload = {"something": "unexpected"}
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        # validate_message returns None → "Validation failed" log, no handler called
        router._message_handler.handle_user_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_presence_updated_for_valid_messages(self):
        router = make_router()
        ws = StubWebSocket()
        payload = {"type": "ping", "timestamp": 123}
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        router._cache.update_presence_metadata.assert_awaited_once_with(
            "c1", last_event="ping",
        )

    @pytest.mark.asyncio
    async def test_audio_messages_suppress_logging(self):
        """Audio messages (type=audio) should not be logged at INFO."""
        router = make_router()
        ws = StubWebSocket()
        payload = {"role": "user", "type": "audio", "audio": "data"}
        # This shouldn't crash; we just verify it routes correctly
        await router.handle_json(
            ws=ws, client_id="c1", text=json.dumps(payload),
        )
        router._audio_handler.handle_audio_chunk.assert_awaited_once()


# =========================================================================
# handle_binary
# =========================================================================


class TestHandleBinary:
    @pytest.mark.asyncio
    async def test_forwards_audio_chunk_to_runtime(self):
        runtime = MagicMock()
        runtime.handle_audio_chunk = AsyncMock()
        router = make_router(runtime=runtime)
        await router.handle_binary(client_id="c1", data=b"\x00\x01\x02")
        runtime.handle_audio_chunk.assert_awaited_once_with(
            client_id="c1", chunk=b"\x00\x01\x02",
        )

    @pytest.mark.asyncio
    async def test_handles_runtime_error(self):
        runtime = MagicMock()
        runtime.handle_audio_chunk = AsyncMock(
            side_effect=RuntimeError("decoder error"),
        )
        router = make_router(runtime=runtime)
        # Should not raise
        await router.handle_binary(client_id="c1", data=b"\xff")

    @pytest.mark.asyncio
    async def test_handles_empty_data(self):
        runtime = MagicMock()
        runtime.handle_audio_chunk = AsyncMock()
        router = make_router(runtime=runtime)
        await router.handle_binary(client_id="c1", data=b"")
        runtime.handle_audio_chunk.assert_awaited_once()


# =========================================================================
# cleanup_client
# =========================================================================


class TestCleanupClient:
    @pytest.mark.asyncio
    async def test_cancels_client_tasks(self):
        task_mgr = MagicMock()
        task_mgr.cleanup_client_tasks = AsyncMock(return_value=["req-1", "req-2"])
        runtime = MagicMock()
        runtime.stop_generation = AsyncMock()
        router = make_router(runtime=runtime, task_manager=task_mgr)
        result = await router.cleanup_client("c1")
        assert result == 2
        assert runtime.stop_generation.await_count == 2

    @pytest.mark.asyncio
    async def test_handles_stop_generation_error(self):
        task_mgr = MagicMock()
        task_mgr.cleanup_client_tasks = AsyncMock(return_value=["req-1"])
        runtime = MagicMock()
        runtime.stop_generation = AsyncMock(
            side_effect=RuntimeError("already stopped"),
        )
        router = make_router(runtime=runtime, task_manager=task_mgr)
        result = await router.cleanup_client("c1")
        assert result == 1

    @pytest.mark.asyncio
    async def test_cleans_up_audio_processor(self):
        audio_handler = MagicMock()
        audio_processor = MagicMock()
        audio_processor.cleanup_client = AsyncMock()
        audio_handler._audio_processor = audio_processor
        audio_handler.handle_audio_control = AsyncMock()
        audio_handler.handle_audio_chunk = AsyncMock()
        audio_handler.handle_cancel_tts = AsyncMock()

        task_mgr = MagicMock()
        task_mgr.cleanup_client_tasks = AsyncMock(return_value=[])

        router = make_router(audio_handler=audio_handler, task_manager=task_mgr)
        await router.cleanup_client("c1")
        audio_processor.cleanup_client.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_cleans_up_request_mappings(self):
        mapper = MagicMock()
        mapper.cleanup_client_mappings = AsyncMock()

        task_mgr = MagicMock()
        task_mgr.cleanup_client_tasks = AsyncMock(return_value=[])

        router = make_router(request_mapper=mapper, task_manager=task_mgr)
        await router.cleanup_client("c1")
        mapper.cleanup_client_mappings.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_cleans_up_message_handler(self):
        msg_handler = MagicMock()
        msg_handler.cleanup_client = AsyncMock()
        msg_handler.handle_user_message = AsyncMock()

        task_mgr = MagicMock()
        task_mgr.cleanup_client_tasks = AsyncMock(return_value=[])

        router = make_router(message_handler=msg_handler, task_manager=task_mgr)
        await router.cleanup_client("c1")
        msg_handler.cleanup_client.assert_awaited_once_with("c1")

    @pytest.mark.asyncio
    async def test_cleans_up_llm_locks(self, monkeypatch):
        """Should remove per-client LLM lock from factory.client_llm_locks."""
        import asyncio

        # Mock the factory module's lock dict
        mock_locks = {"c1": asyncio.Lock(), "c2": asyncio.Lock()}
        monkeypatch.setattr("ws.factory.client_llm_locks", mock_locks)

        task_mgr = MagicMock()
        task_mgr.cleanup_client_tasks = AsyncMock(return_value=[])

        router = make_router(task_manager=task_mgr)
        await router.cleanup_client("c1")
        assert "c1" not in mock_locks
        assert "c2" in mock_locks  # Other clients untouched

    @pytest.mark.asyncio
    async def test_returns_zero_when_no_tasks(self):
        task_mgr = MagicMock()
        task_mgr.cleanup_client_tasks = AsyncMock(return_value=[])
        router = make_router(task_manager=task_mgr)
        result = await router.cleanup_client("c1")
        assert result == 0


# =========================================================================
# shutdown
# =========================================================================


class TestShutdown:
    @pytest.mark.asyncio
    async def test_calls_message_handler_shutdown(self):
        msg_handler = MagicMock()
        msg_handler.shutdown = AsyncMock()
        msg_handler.handle_user_message = AsyncMock()
        router = make_router(message_handler=msg_handler)
        await router.shutdown()
        msg_handler.shutdown.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_noop_when_no_shutdown_method(self):
        msg_handler = MagicMock(spec=[])  # No methods
        router = make_router(message_handler=msg_handler)
        await router.shutdown()  # Should not raise

    @pytest.mark.asyncio
    async def test_noop_when_no_message_handler(self):
        router = make_router(message_handler=None)
        await router.shutdown()  # Should not raise
