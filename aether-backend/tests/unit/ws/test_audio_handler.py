"""
Unit Tests: Audio Handler (Presentation Layer)

Tests audio stream control, chunk processing, and TTS cancellation.
Validates correct delegation to runtime/audio_processor/tts_coordinator.

Bugs found: 3
- Bug H (MEDIUM): handle_audio_control narrow except (missing TimeoutError, etc.)
- Bug I (MEDIUM): handle_audio_chunk narrow except
- Bug J (MEDIUM): handle_cancel_tts narrow except
All fixed: broadened to except Exception.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from ws.presentation.handlers.audio_handler import AudioHandler


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_handler(
    *,
    runtime=None,
    cache=None,
    audio_processor=None,
    tts_coordinator=None,
):
    """Create AudioHandler with mock dependencies."""
    return AudioHandler(
        runtime=runtime or AsyncMock(),
        cache_service=cache or AsyncMock(),
        audio_processor=audio_processor,
        tts_coordinator=tts_coordinator,
    )


def _audio_control_msg(*, start=False, end=False):
    """Create a mock audio control message."""
    msg = MagicMock()
    msg.start = start
    msg.end = end
    return msg


def _audio_chunk_msg(*, end=False, audio=None, has_format=True, fmt="opus"):
    """Create a mock audio chunk message."""
    msg = MagicMock()
    msg.end = end
    msg.audio = audio
    if has_format:
        msg.format = fmt
    else:
        del msg.format  # remove auto-created attribute so hasattr returns False
    return msg


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


class TestConstruction:
    """Tests for __init__ dependency storage."""

    def test_stores_all_dependencies(self):
        """All injected dependencies are stored as instance attributes."""
        runtime = MagicMock()
        cache = MagicMock()
        proc = MagicMock()
        tts = MagicMock()

        handler = AudioHandler(
            runtime=runtime,
            cache_service=cache,
            audio_processor=proc,
            tts_coordinator=tts,
        )

        assert handler._runtime is runtime
        assert handler._cache is cache
        assert handler._audio_processor is proc
        assert handler._tts_coordinator is tts

    def test_optional_dependencies_default_to_none(self):
        """audio_processor and tts_coordinator default to None."""
        handler = AudioHandler(
            runtime=MagicMock(),
            cache_service=MagicMock(),
        )
        assert handler._audio_processor is None
        assert handler._tts_coordinator is None


# ---------------------------------------------------------------------------
# handle_audio_control
# ---------------------------------------------------------------------------


class TestHandleAudioControl:
    """Tests for audio stream start/end control delegation."""

    @pytest.mark.asyncio
    async def test_start_calls_runtime_start_audio_stream(self):
        """message.start=True delegates to runtime.start_audio_stream."""
        runtime = AsyncMock()
        handler = _make_handler(runtime=runtime)

        await handler.handle_audio_control(
            client_id="client-abc",
            message=_audio_control_msg(start=True),
        )

        runtime.start_audio_stream.assert_awaited_once_with(client_id="client-abc")

    @pytest.mark.asyncio
    async def test_end_calls_runtime_end_audio_stream(self):
        """message.end=True delegates to runtime.end_audio_stream."""
        runtime = AsyncMock()
        handler = _make_handler(runtime=runtime)

        await handler.handle_audio_control(
            client_id="client-abc",
            message=_audio_control_msg(end=True),
        )

        runtime.end_audio_stream.assert_awaited_once_with(client_id="client-abc")

    @pytest.mark.asyncio
    async def test_start_presence_state_is_audio_start(self):
        """Presence metadata updated with last_event='audio_start' on start."""
        cache = AsyncMock()
        handler = _make_handler(cache=cache)

        await handler.handle_audio_control(
            client_id="client-1",
            message=_audio_control_msg(start=True),
        )

        cache.update_presence_metadata.assert_awaited_once_with(
            "client-1",
            last_event="audio_start",
        )

    @pytest.mark.asyncio
    async def test_end_presence_state_is_audio_end(self):
        """Presence metadata updated with last_event='audio_end' on end."""
        cache = AsyncMock()
        handler = _make_handler(cache=cache)

        await handler.handle_audio_control(
            client_id="client-1",
            message=_audio_control_msg(end=True),
        )

        cache.update_presence_metadata.assert_awaited_once_with(
            "client-1",
            last_event="audio_end",
        )

    @pytest.mark.asyncio
    async def test_neither_start_nor_end_state_is_audio_control(self):
        """Neither start nor end: state='audio_control', no runtime call."""
        runtime = AsyncMock()
        cache = AsyncMock()
        handler = _make_handler(runtime=runtime, cache=cache)

        await handler.handle_audio_control(
            client_id="client-1",
            message=_audio_control_msg(start=False, end=False),
        )

        cache.update_presence_metadata.assert_awaited_once_with(
            "client-1",
            last_event="audio_control",
        )
        runtime.start_audio_stream.assert_not_awaited()
        runtime.end_audio_stream.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_runtime_error_caught_and_logged(self):
        """RuntimeError from runtime is caught and warning logged."""
        runtime = AsyncMock()
        runtime.start_audio_stream.side_effect = RuntimeError("loop closed")
        handler = _make_handler(runtime=runtime)

        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_control(
                client_id="client-1",
                message=_audio_control_msg(start=True),
            )
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Audio control error: %s"
            assert str(args[1]) == "loop closed"

    @pytest.mark.asyncio
    async def test_attribute_error_caught_and_logged(self):
        """AttributeError from malformed message is caught and warning logged."""
        cache = AsyncMock()
        cache.update_presence_metadata.side_effect = AttributeError("bad field")
        handler = _make_handler(cache=cache)

        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_control(
                client_id="client-1",
                message=_audio_control_msg(start=True),
            )
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Audio control error: %s"
            assert str(args[1]) == "bad field"

    @pytest.mark.asyncio
    async def test_os_error_caught_and_logged(self):
        """OSError from runtime is caught and warning logged."""
        runtime = AsyncMock()
        runtime.end_audio_stream.side_effect = OSError("socket broken")
        handler = _make_handler(runtime=runtime)

        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_control(
                client_id="client-1",
                message=_audio_control_msg(end=True),
            )
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Audio control error: %s"
            assert str(args[1]) == "socket broken"

    @pytest.mark.asyncio
    async def test_connection_error_caught_and_logged(self):
        """ConnectionError from runtime is caught and warning logged."""
        runtime = AsyncMock()
        runtime.start_audio_stream.side_effect = ConnectionError("refused")
        handler = _make_handler(runtime=runtime)

        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_control(
                client_id="client-1",
                message=_audio_control_msg(start=True),
            )
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Audio control error: %s"
            assert str(args[1]) == "refused"


# ---------------------------------------------------------------------------
# handle_audio_chunk
# ---------------------------------------------------------------------------


class TestHandleAudioChunk:
    """Tests for audio chunk processing and end-of-stream handling."""

    @pytest.mark.asyncio
    async def test_end_marker_resets_buffer_when_processor_exists(self):
        """End marker with audio_processor resets buffer and returns."""
        proc = AsyncMock()
        handler = _make_handler(audio_processor=proc)

        await handler.handle_audio_chunk(
            client_id="client-abc-123",
            message=_audio_chunk_msg(end=True),
        )

        proc.reset_buffer.assert_awaited_once_with("client-abc-123")

    @pytest.mark.asyncio
    async def test_end_marker_without_processor_still_returns_gracefully(self):
        """End marker without audio_processor logs debug and returns."""
        handler = _make_handler(audio_processor=None)

        with patch.object(handler._logger, "debug") as mock_debug:
            await handler.handle_audio_chunk(
                client_id="client-1",
                message=_audio_chunk_msg(end=True),
            )
            mock_debug.assert_called_once_with("Audio stream ended: %s", "client-1"[:8])

    @pytest.mark.asyncio
    async def test_processes_chunk_with_format_hint(self):
        """Audio chunk with format attribute passes format_hint to processor."""
        proc = AsyncMock()
        handler = _make_handler(audio_processor=proc)

        await handler.handle_audio_chunk(
            client_id="client-1",
            message=_audio_chunk_msg(audio="base64data==", has_format=True, fmt="opus"),
        )

        proc.process_chunk.assert_awaited_once_with(
            base64_opus="base64data==",
            client_id="client-1",
            format_hint="opus",
        )

    @pytest.mark.asyncio
    async def test_processes_chunk_without_format_attribute(self):
        """Audio chunk without format attribute passes format_hint=None."""
        proc = AsyncMock()
        handler = _make_handler(audio_processor=proc)

        await handler.handle_audio_chunk(
            client_id="client-1",
            message=_audio_chunk_msg(audio="base64data==", has_format=False),
        )

        proc.process_chunk.assert_awaited_once_with(
            base64_opus="base64data==",
            client_id="client-1",
            format_hint=None,
        )

    @pytest.mark.asyncio
    async def test_no_processor_logs_warning(self):
        """Audio chunk without audio_processor logs warning."""
        handler = _make_handler(audio_processor=None)

        with patch.object(handler, "_logger") as mock_logger:
            await handler.handle_audio_chunk(
                client_id="client-1",
                message=_audio_chunk_msg(audio="base64data=="),
            )

            mock_logger.warning.assert_called_once()
            assert "not initialized" in mock_logger.warning.call_args[0][0]

    @pytest.mark.asyncio
    async def test_no_audio_no_end_does_nothing(self):
        """Message with no audio data and no end marker is a silent no-op."""
        proc = AsyncMock()
        handler = _make_handler(audio_processor=proc)

        await handler.handle_audio_chunk(
            client_id="client-1",
            message=_audio_chunk_msg(end=False, audio=None),
        )

        proc.process_chunk.assert_not_awaited()
        proc.reset_buffer.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_runtime_error_caught(self):
        """RuntimeError from audio processor is caught and warning logged."""
        proc = AsyncMock()
        proc.process_chunk.side_effect = RuntimeError("processing failed")
        handler = _make_handler(audio_processor=proc)

        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_chunk(
                client_id="client-1",
                message=_audio_chunk_msg(audio="data=="),
            )
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Audio chunk error: %s"
            assert str(args[1]) == "processing failed"

    @pytest.mark.asyncio
    async def test_os_error_caught(self):
        """OSError from audio processor is caught and warning logged."""
        proc = AsyncMock()
        proc.process_chunk.side_effect = OSError("file error")
        handler = _make_handler(audio_processor=proc)

        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_chunk(
                client_id="client-1",
                message=_audio_chunk_msg(audio="data=="),
            )
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Audio chunk error: %s"
            assert str(args[1]) == "file error"

    @pytest.mark.asyncio
    async def test_value_error_caught(self):
        """ValueError from audio processor is caught and warning logged."""
        proc = AsyncMock()
        proc.process_chunk.side_effect = ValueError("bad audio format")
        handler = _make_handler(audio_processor=proc)

        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_chunk(
                client_id="client-1",
                message=_audio_chunk_msg(audio="data=="),
            )
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Audio chunk error: %s"
            assert str(args[1]) == "bad audio format"

    @pytest.mark.asyncio
    async def test_type_error_caught(self):
        """TypeError from audio processor is caught and warning logged."""
        proc = AsyncMock()
        proc.process_chunk.side_effect = TypeError("wrong type")
        handler = _make_handler(audio_processor=proc)

        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_chunk(
                client_id="client-1",
                message=_audio_chunk_msg(audio="data=="),
            )
            mock_warn.assert_called_once()
            args = mock_warn.call_args[0]
            assert args[0] == "Audio chunk error: %s"
            assert str(args[1]) == "wrong type"

    @pytest.mark.asyncio
    async def test_end_marker_takes_priority_over_audio_data(self):
        """End marker with audio data resets buffer, does NOT process chunk."""
        proc = AsyncMock()
        handler = _make_handler(audio_processor=proc)

        await handler.handle_audio_chunk(
            client_id="client-1",
            message=_audio_chunk_msg(end=True, audio="stale-data"),
        )

        # End marker path: reset buffer, early return
        proc.reset_buffer.assert_awaited_once()
        proc.process_chunk.assert_not_awaited()


# ---------------------------------------------------------------------------
# handle_cancel_tts
# ---------------------------------------------------------------------------


class TestHandleCancelTts:
    """Tests for TTS cancellation command handling."""

    @pytest.mark.asyncio
    async def test_clears_tts_queues_on_success(self):
        """cancel_tts clears coordinator queues with client_id."""
        tts = AsyncMock()
        handler = _make_handler(tts_coordinator=tts)

        await handler.handle_cancel_tts(client_id="client-abc-12345")

        tts.clear_queues.assert_awaited_once_with("client-abc-12345")

    @pytest.mark.asyncio
    async def test_no_coordinator_logs_warning_and_returns(self):
        """cancel_tts without tts_coordinator logs warning, doesn't raise."""
        handler = _make_handler(tts_coordinator=None)

        with patch.object(handler, "_logger") as mock_logger:
            await handler.handle_cancel_tts(client_id="client-12345678")

            mock_logger.warning.assert_called_once()
            assert "not initialized" in mock_logger.warning.call_args[0][0]

    @pytest.mark.asyncio
    async def test_no_coordinator_does_not_call_clear_queues(self):
        """cancel_tts without coordinator logs warning with truncated client_id."""
        handler = _make_handler(tts_coordinator=None)
        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_cancel_tts(client_id="client-abcdef-xyz")
            mock_warn.assert_called_once_with(
                "cancel-tts received but tts_coordinator not initialized: %s",
                "client-a",
            )

    @pytest.mark.asyncio
    async def test_runtime_error_caught(self):
        """RuntimeError from clear_queues is caught and error logged."""
        tts = AsyncMock()
        tts.clear_queues.side_effect = RuntimeError("loop closed")
        handler = _make_handler(tts_coordinator=tts)

        with patch.object(handler._logger, "error") as mock_err:
            await handler.handle_cancel_tts(client_id="client-1")
            mock_err.assert_called_once()
            args = mock_err.call_args[0]
            assert args[0] == "Cancel TTS error for %s: %s"
            assert args[1] == "client-1"[:8]
            assert str(args[2]) == "loop closed"

    @pytest.mark.asyncio
    async def test_attribute_error_caught(self):
        """AttributeError from coordinator is caught and error logged."""
        tts = AsyncMock()
        tts.clear_queues.side_effect = AttributeError("missing method")
        handler = _make_handler(tts_coordinator=tts)

        with patch.object(handler._logger, "error") as mock_err:
            await handler.handle_cancel_tts(client_id="client-1")
            mock_err.assert_called_once()
            args = mock_err.call_args[0]
            assert args[0] == "Cancel TTS error for %s: %s"
            assert str(args[2]) == "missing method"

    @pytest.mark.asyncio
    async def test_os_error_caught(self):
        """OSError from coordinator is caught and error logged."""
        tts = AsyncMock()
        tts.clear_queues.side_effect = OSError("socket error")
        handler = _make_handler(tts_coordinator=tts)

        with patch.object(handler._logger, "error") as mock_err:
            await handler.handle_cancel_tts(client_id="client-1")
            mock_err.assert_called_once()
            args = mock_err.call_args[0]
            assert args[0] == "Cancel TTS error for %s: %s"
            assert str(args[2]) == "socket error"

    @pytest.mark.asyncio
    async def test_success_logs_info_with_truncated_client_id(self):
        """Successful cancel logs info with first 8 chars of client_id."""
        tts = AsyncMock()
        handler = _make_handler(tts_coordinator=tts)

        with patch.object(handler, "_logger") as mock_logger:
            await handler.handle_cancel_tts(client_id="client-abcdef-ghijk")

            mock_logger.info.assert_called_once()
            log_msg = mock_logger.info.call_args[0][0] % mock_logger.info.call_args[0][1:]
            assert "client-a" in log_msg


# ---------------------------------------------------------------------------
# Adversarial: Broad exception handling (Bug H/I/J fix verification)
# ---------------------------------------------------------------------------

class TestBroadExceptionHandling:
    """BUG FIX: All 3 handler methods had narrow except clauses.
    TimeoutError, asyncio.TimeoutError, and other unexpected exceptions
    were NOT caught. Fixed: broadened to except Exception.
    """

    @pytest.mark.asyncio
    async def test_audio_control_timeout_error(self):
        """TimeoutError in handle_audio_control is caught and warning logged."""
        runtime = AsyncMock()
        runtime.start_audio_stream.side_effect = TimeoutError("timed out")
        handler = _make_handler(runtime=runtime)
        msg = MagicMock(start=True, end=False)
        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_control(client_id="c1", message=msg)
            mock_warn.assert_called_once()
            assert str(mock_warn.call_args[0][1]) == "timed out"

    @pytest.mark.asyncio
    async def test_audio_chunk_timeout_error(self):
        """TimeoutError in handle_audio_chunk is caught and warning logged."""
        processor = AsyncMock()
        processor.process_chunk.side_effect = TimeoutError("STT timeout")
        handler = _make_handler(audio_processor=processor)
        msg = MagicMock(end=False, audio="base64data", format="pcm16")
        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_chunk(client_id="c1", message=msg)
            mock_warn.assert_called_once()
            assert str(mock_warn.call_args[0][1]) == "STT timeout"

    @pytest.mark.asyncio
    async def test_cancel_tts_timeout_error(self):
        """TimeoutError in handle_cancel_tts is caught and error logged."""
        tts = AsyncMock()
        tts.clear_queues.side_effect = TimeoutError("Redis timeout")
        handler = _make_handler(tts_coordinator=tts)
        with patch.object(handler._logger, "error") as mock_err:
            await handler.handle_cancel_tts(client_id="c1")
            mock_err.assert_called_once()
            assert str(mock_err.call_args[0][2]) == "Redis timeout"

    @pytest.mark.asyncio
    async def test_audio_control_unexpected_exception(self):
        """KeyError in handle_audio_control is caught and warning logged."""
        runtime = AsyncMock()
        runtime.start_audio_stream.side_effect = KeyError("missing_key")
        handler = _make_handler(runtime=runtime)
        msg = MagicMock(start=True, end=False)
        with patch.object(handler._logger, "warning") as mock_warn:
            await handler.handle_audio_control(client_id="c1", message=msg)
            mock_warn.assert_called_once()
            assert mock_warn.call_args[0][0] == "Audio control error: %s"
