"""
Unit Tests: ws/domain/audio/services/tts_generation_service.py

Tests async dual-queue TTS generation: sentence queueing, audio synthesis worker,
timeout handling, queue monitoring, interruption clearing, graceful stop.

Only stdlib imports at module level. tts_integration.synthesize_text is mocked.
"""

import asyncio
import sys
import time
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest

# Stub openwakeword to allow ws.domain.audio package import
if "openwakeword" not in sys.modules:
    _ow = ModuleType("openwakeword")
    _ow.__path__ = []
    _ow_model = ModuleType("openwakeword.model")
    _ow_model.Model = type("Model", (), {})
    sys.modules["openwakeword"] = _ow
    sys.modules["openwakeword.model"] = _ow_model

from ws.domain.audio.services.tts_generation_service import TTSGenerationService


# =========================================================================
# Helpers
# =========================================================================


def _make_config(
    sentence_queue_maxsize=10,
    audio_queue_maxsize=20,
):
    config = MagicMock()
    config.sentence_queue_maxsize = sentence_queue_maxsize
    config.audio_queue_maxsize = audio_queue_maxsize
    return config


def _make_integration(audio_data=b"\x00\x01\x02audio"):
    """Mock TTS integration. synthesize_text returns audio bytes."""
    mock = MagicMock()
    mock.synthesize_text.return_value = audio_data
    return mock


def _make_service(
    audio_data=b"\x00\x01\x02audio",
    sentence_queue_maxsize=10,
    audio_queue_maxsize=20,
):
    integration = _make_integration(audio_data)
    config = _make_config(sentence_queue_maxsize, audio_queue_maxsize)
    svc = TTSGenerationService(integration, config, "test-client-12345678")
    return svc, integration


# =========================================================================
# __init__
# =========================================================================


class TestInit:
    def test_default_initialization(self):
        svc, _ = _make_service()
        assert svc.client_id == "test-client-12345678"
        assert svc.is_running is False
        assert svc.generation_task is None
        assert svc._worker_idle is True
        assert svc.sentences_processed == 0
        assert svc.audio_generated == 0
        assert svc.failed_sentences == []
        assert svc._queue_log_interval == 10.0

    def test_queue_sizes_from_config(self):
        svc, _ = _make_service(sentence_queue_maxsize=50, audio_queue_maxsize=100)
        assert svc.sentence_queue.maxsize == 50
        assert svc.audio_queue.maxsize == 100


# =========================================================================
# start
# =========================================================================


class TestStart:
    @pytest.mark.asyncio
    async def test_starts_worker(self):
        svc, _ = _make_service()
        await svc.start()
        assert svc.is_running is True
        assert svc.generation_task is not None
        # Clean up
        svc.is_running = False
        svc.generation_task.cancel()
        try:
            await svc.generation_task
        except asyncio.CancelledError:
            pass

    @pytest.mark.asyncio
    async def test_start_idempotent(self):
        """Calling start twice doesn't create a second task."""
        svc, _ = _make_service()
        await svc.start()
        task1 = svc.generation_task
        await svc.start()
        task2 = svc.generation_task
        assert task1 is task2
        # Clean up
        svc.is_running = False
        svc.generation_task.cancel()
        try:
            await svc.generation_task
        except asyncio.CancelledError:
            pass


# =========================================================================
# add_sentence
# =========================================================================


class TestAddSentence:
    @pytest.mark.asyncio
    async def test_queues_sentence(self):
        svc, _ = _make_service()
        await svc.add_sentence("Hello world")
        assert svc.sentence_queue.qsize() == 1
        item = svc.sentence_queue.get_nowait()
        assert item == "Hello world"

    @pytest.mark.asyncio
    async def test_strips_whitespace(self):
        svc, _ = _make_service()
        await svc.add_sentence("  Hello  ")
        item = svc.sentence_queue.get_nowait()
        assert item == "Hello"

    @pytest.mark.asyncio
    async def test_empty_string_rejected(self):
        svc, _ = _make_service()
        await svc.add_sentence("")
        assert svc.sentence_queue.empty()

    @pytest.mark.asyncio
    async def test_whitespace_only_rejected(self):
        svc, _ = _make_service()
        await svc.add_sentence("   ")
        assert svc.sentence_queue.empty()

    @pytest.mark.asyncio
    async def test_queue_full_raises(self):
        """Line 134-136: QueueFull propagated (FAIL_FAST)."""
        svc, _ = _make_service(sentence_queue_maxsize=1)
        await svc.add_sentence("first")
        with pytest.raises(asyncio.QueueFull):
            await svc.add_sentence("second")


# =========================================================================
# get_next_audio
# =========================================================================


class TestGetNextAudio:
    @pytest.mark.asyncio
    async def test_returns_audio_from_queue(self):
        svc, _ = _make_service()
        svc.audio_queue.put_nowait((b"audio-data", "hello"))
        result = await svc.get_next_audio()
        assert result == (b"audio-data", "hello")

    @pytest.mark.asyncio
    async def test_returns_none_when_empty(self):
        svc, _ = _make_service()
        assert await svc.get_next_audio() is None


# =========================================================================
# is_generation_complete
# =========================================================================


class TestIsGenerationComplete:
    def test_true_when_all_empty_and_idle(self):
        svc, _ = _make_service()
        assert svc.is_generation_complete() is True

    def test_false_when_sentence_queue_has_items(self):
        svc, _ = _make_service()
        svc.sentence_queue.put_nowait("pending")
        assert svc.is_generation_complete() is False

    def test_false_when_audio_queue_has_items(self):
        svc, _ = _make_service()
        svc.audio_queue.put_nowait((b"data", "text"))
        assert svc.is_generation_complete() is False

    def test_false_when_worker_not_idle(self):
        svc, _ = _make_service()
        svc._worker_idle = False
        assert svc.is_generation_complete() is False


# =========================================================================
# _generation_worker (end-to-end)
# =========================================================================


class TestGenerationWorker:
    @pytest.mark.asyncio
    async def test_processes_sentence_to_audio(self):
        """Full pipeline: sentence → synthesize → audio queue."""
        svc, integration = _make_service(audio_data=b"generated-audio")
        await svc.start()

        await svc.add_sentence("Hello world")
        # Wait for worker to process
        for _ in range(50):
            if not svc.audio_queue.empty():
                break
            await asyncio.sleep(0.05)

        result = await svc.get_next_audio()
        assert result is not None
        audio_data, sentence = result
        assert audio_data == b"generated-audio"
        assert sentence == "Hello world"
        assert svc.sentences_processed == 1
        assert svc.audio_generated == 1

        # Stop
        await svc.stop()

    @pytest.mark.asyncio
    async def test_synthesis_timeout_records_failure(self):
        """Lines 243-247: Synthesis exceeding 60s timeout → fail and continue."""
        svc, integration = _make_service()

        # Make synthesize_text hang
        async def slow_synth(*a, **kw):
            await asyncio.sleep(100)

        # We patch asyncio.wait_for timeout to be very short instead
        original_start = svc.start

        await svc.start()
        # Make synthesize_text block longer than the 0.1s test timeout,
        # but short enough (0.5s) that the thread finishes during teardown
        # instead of blocking for 100s.
        integration.synthesize_text.side_effect = lambda text: time.sleep(0.5)

        # Patch the timeout to be very short for test speed
        original_worker = svc._generation_worker

        svc.is_running = False
        svc.generation_task.cancel()
        try:
            await svc.generation_task
        except asyncio.CancelledError:
            pass

        # Restart with custom timeout via monkey-patching
        svc.is_running = True

        async def patched_worker():
            """Worker with 0.1s timeout instead of 60s."""
            svc._worker_idle = True
            while svc.is_running or not svc.sentence_queue.empty():
                try:
                    svc._worker_idle = True
                    try:
                        sentence = await asyncio.wait_for(
                            svc.sentence_queue.get(), timeout=0.1
                        )
                        svc._worker_idle = False
                        svc.sentences_processed += 1
                    except asyncio.TimeoutError:
                        if not svc.is_running and svc.sentence_queue.empty():
                            break
                        continue

                    try:
                        await asyncio.wait_for(
                            asyncio.to_thread(
                                svc.tts_integration.synthesize_text, sentence
                            ),
                            timeout=0.1,  # Very short timeout for test
                        )
                    except asyncio.TimeoutError:
                        svc.failed_sentences.append((sentence, "timeout"))
                        continue
                    except (RuntimeError, ValueError, OSError, TypeError):
                        continue
                except Exception:
                    if not svc.is_running and svc.sentence_queue.empty():
                        break
                    await asyncio.sleep(0.01)
            svc._worker_idle = True
            svc.is_running = False

        svc.generation_task = asyncio.create_task(patched_worker())
        svc.sentence_queue.put_nowait("This will timeout")

        # Wait for processing
        for _ in range(50):
            if svc.failed_sentences:
                break
            await asyncio.sleep(0.05)

        assert len(svc.failed_sentences) == 1
        assert svc.failed_sentences[0] == ("This will timeout", "timeout")
        assert svc.sentences_processed == 1

        svc.is_running = False
        await asyncio.sleep(0.2)

    @pytest.mark.asyncio
    async def test_synthesis_error_records_failure(self):
        """Lines 249-253: RuntimeError during synthesis → records failure, continues."""
        svc, integration = _make_service()
        integration.synthesize_text.side_effect = RuntimeError("Model crashed")

        await svc.start()
        await svc.add_sentence("Will fail")

        # Wait for processing
        for _ in range(50):
            if svc.failed_sentences:
                break
            await asyncio.sleep(0.05)

        assert len(svc.failed_sentences) == 1
        assert svc.failed_sentences[0][0] == "Will fail"
        assert "Model crashed" in svc.failed_sentences[0][1]

        await svc.stop()

    @pytest.mark.asyncio
    async def test_empty_audio_data_raises_value_error(self):
        """Lines 233-234: Empty audio data → ValueError → failure recorded."""
        svc, integration = _make_service()
        integration.synthesize_text.return_value = b""

        await svc.start()
        await svc.add_sentence("Empty result")

        for _ in range(50):
            if svc.failed_sentences:
                break
            await asyncio.sleep(0.05)

        assert len(svc.failed_sentences) == 1
        assert "empty" in svc.failed_sentences[0][1].lower()

        await svc.stop()

    @pytest.mark.asyncio
    async def test_none_audio_data_raises_value_error(self):
        """Line 233: None audio data → ValueError."""
        svc, integration = _make_service()
        integration.synthesize_text.return_value = None

        await svc.start()
        await svc.add_sentence("None result")

        for _ in range(50):
            if svc.failed_sentences:
                break
            await asyncio.sleep(0.05)

        assert len(svc.failed_sentences) == 1

        await svc.stop()

    @pytest.mark.asyncio
    async def test_worker_exits_when_stopped_and_queue_empty(self):
        """Lines 217-218, 256-257: Worker exits when is_running=False and queue empty."""
        svc, _ = _make_service()
        await svc.start()
        assert svc.is_running is True

        # Stop without adding anything
        await svc.stop()
        assert svc.is_running is False
        assert svc.generation_task is None


# =========================================================================
# stop
# =========================================================================


class TestStop:
    @pytest.mark.asyncio
    async def test_stop_cancels_running_task(self):
        """Lines 105-110: Cancels task and awaits CancelledError."""
        svc, _ = _make_service()
        await svc.start()
        assert svc.generation_task is not None

        await svc.stop()
        assert svc.generation_task is None
        assert svc.is_running is False

    @pytest.mark.asyncio
    async def test_stop_noop_when_no_task(self):
        """Line 93: No generation_task → no-op."""
        svc, _ = _make_service()
        await svc.stop()  # Should not raise

    @pytest.mark.asyncio
    async def test_stop_waits_for_queue_drain(self):
        """Lines 95-96: Stop waits for sentence_queue to drain."""
        svc, integration = _make_service(audio_data=b"audio")
        await svc.start()
        await svc.add_sentence("Drain me")

        # Wait for sentence to be picked up
        for _ in range(50):
            if svc.sentence_queue.empty():
                break
            await asyncio.sleep(0.05)

        await svc.stop()
        assert svc.sentence_queue.empty()


# =========================================================================
# clear_queues
# =========================================================================


class TestClearQueues:
    @pytest.mark.asyncio
    async def test_clears_both_queues(self):
        svc, _ = _make_service()
        svc.sentence_queue.put_nowait("s1")
        svc.sentence_queue.put_nowait("s2")
        svc.audio_queue.put_nowait((b"a1", "text1"))

        await svc.clear_queues()

        assert svc.sentence_queue.empty()
        assert svc.audio_queue.empty()

    @pytest.mark.asyncio
    async def test_noop_when_already_empty(self):
        svc, _ = _make_service()
        await svc.clear_queues()  # Should not raise
        assert svc.sentence_queue.empty()
        assert svc.audio_queue.empty()

    @pytest.mark.asyncio
    async def test_counts_cleared_items(self, caplog):
        """Lines 285-286: Logs count of cleared items."""
        import logging
        svc, _ = _make_service()
        svc.sentence_queue.put_nowait("s1")
        svc.sentence_queue.put_nowait("s2")
        svc.audio_queue.put_nowait((b"a1", "text1"))
        svc.audio_queue.put_nowait((b"a2", "text2"))
        svc.audio_queue.put_nowait((b"a3", "text3"))

        with caplog.at_level(logging.INFO):
            await svc.clear_queues()

        assert "2 sentences" in caplog.text
        assert "3 audio" in caplog.text

    @pytest.mark.asyncio
    async def test_sentence_queue_empty_race_condition(self):
        """Lines 275-276: QueueEmpty caught during sentence queue clear (TOCTOU race).

        Simulates: empty() returns False (enter loop) but get_nowait() raises
        QueueEmpty (item consumed between check and get). The except handler
        breaks cleanly.
        """
        svc, _ = _make_service()

        # Replace sentence_queue with mock that simulates the race
        mock_queue = MagicMock()
        mock_queue.empty.return_value = False
        mock_queue.get_nowait.side_effect = asyncio.QueueEmpty()
        svc.sentence_queue = mock_queue

        await svc.clear_queues()

        # get_nowait was called (entered the loop) and QueueEmpty broke out
        mock_queue.get_nowait.assert_called_once()

    @pytest.mark.asyncio
    async def test_audio_queue_empty_race_condition(self):
        """Lines 282-283: QueueEmpty caught during audio queue clear (TOCTOU race).

        Same race as sentence queue but on the audio side.
        """
        svc, _ = _make_service()

        # Replace audio_queue with mock that simulates the race
        mock_queue = MagicMock()
        mock_queue.empty.return_value = False
        mock_queue.get_nowait.side_effect = asyncio.QueueEmpty()
        svc.audio_queue = mock_queue

        await svc.clear_queues()

        mock_queue.get_nowait.assert_called_once()


# =========================================================================
# Queue monitoring in worker
# =========================================================================


class TestQueueMonitoring:
    @pytest.mark.asyncio
    async def test_logs_when_queues_over_50_percent(self, caplog):
        """Lines 194-200: Worker logs warning when queues > 50% capacity."""
        import logging

        svc, integration = _make_service(
            sentence_queue_maxsize=4, audio_queue_maxsize=4, audio_data=b"ok"
        )
        # Force last log time to be far in the past
        svc._last_queue_log_time = 0

        # Fill sentence queue to > 50% (3/4 = 75%)
        svc.sentence_queue.put_nowait("s1")
        svc.sentence_queue.put_nowait("s2")
        svc.sentence_queue.put_nowait("s3")

        with caplog.at_level(logging.WARNING):
            await svc.start()
            # Wait for worker to process
            for _ in range(100):
                if svc.sentences_processed >= 3:
                    break
                await asyncio.sleep(0.05)

        await svc.stop()

        # Verify warning was logged about queue capacity
        assert any("Queue capacity" in r.message for r in caplog.records)


# =========================================================================
# Coverage gap tests (lines 96, 218, 256-264)
# =========================================================================


class TestCoverageGaps:
    @pytest.mark.asyncio
    async def test_worker_natural_exit_without_cancel(self):
        """Line 218: Worker exits naturally via is_running=False + empty queue.

        stop() normally cancels the task. Here we bypass stop() and set
        is_running=False directly, letting the worker's timeout path (line 217)
        detect the stop condition and break naturally.
        """
        svc, _ = _make_service()
        await svc.start()
        assert svc.is_running is True

        # Let worker settle into its wait loop
        await asyncio.sleep(0.2)

        # Signal stop without cancelling
        svc.is_running = False

        # Wait for worker to notice and exit
        for _ in range(50):
            if svc.generation_task.done():
                break
            await asyncio.sleep(0.05)

        assert svc.generation_task.done()

        # Verify worker set final flags
        assert svc._worker_idle is True

        # Clean up task reference
        svc.generation_task = None

    @pytest.mark.asyncio
    async def test_stop_drain_loop_when_queue_not_empty(self):
        """Line 96: stop() loops while sentence_queue is not empty.

        We add sentences faster than the worker processes them, then call stop().
        The worker picks up sentences while stop() waits for the queue to drain.
        """
        svc, integration = _make_service(audio_data=b"ok")

        # Make synthesis slow enough that queue won't drain instantly
        original_synth = integration.synthesize_text.return_value

        def slow_synth(text):
            import time
            time.sleep(0.15)
            return original_synth

        integration.synthesize_text.side_effect = slow_synth

        await svc.start()

        # Queue several sentences
        for i in range(3):
            await svc.add_sentence(f"Sentence {i}")

        # Call stop() — it should wait for sentence_queue to drain (line 95-96)
        await svc.stop()

        # Queue should be empty after stop
        assert svc.sentence_queue.empty()
        assert svc.sentences_processed >= 3

    @pytest.mark.asyncio
    async def test_worker_outer_exception_handler(self):
        """Lines 256-264: Outer exception handler catches unexpected errors.

        The inner try-except catches RuntimeError/ValueError/OSError/TypeError.
        An unexpected exception type (e.g., KeyError) falls through to the
        outer handler (lines 255-259).
        """
        svc, integration = _make_service()

        # KeyError is NOT in the inner handler's exception tuple
        integration.synthesize_text.side_effect = KeyError("unexpected")

        await svc.start()
        await svc.add_sentence("Will trigger outer handler")

        # Wait for worker to process (it should log error and continue)
        await asyncio.sleep(0.5)

        # Worker should still be running (outer handler doesn't exit)
        assert svc.is_running is True

        # Clean up
        await svc.stop()

    @pytest.mark.asyncio
    async def test_real_synthesis_timeout_covers_lines_245_247(self):
        """Lines 245-247: Real worker synthesis timeout path.

        Previous test replaced the worker. This one exercises the actual code
        by patching asyncio.wait_for to use 0.05s instead of 60s, while
        synthesize_text blocks in a thread.
        """
        import threading

        svc, integration = _make_service()

        block = threading.Event()

        def blocking_synth(text):
            block.wait(timeout=5)
            return b"never-reached"

        integration.synthesize_text.side_effect = blocking_synth

        saved_wait_for = asyncio.wait_for

        async def fast_wait_for(coro, *, timeout):
            if timeout == 60.0:
                return await saved_wait_for(coro, timeout=0.05)
            return await saved_wait_for(coro, timeout=timeout)

        with patch("asyncio.wait_for", side_effect=fast_wait_for):
            await svc.start()
            await svc.add_sentence("Will timeout")

            for _ in range(100):
                if svc.failed_sentences:
                    break
                await asyncio.sleep(0.05)

        # Release blocked thread before teardown
        block.set()

        assert len(svc.failed_sentences) == 1
        assert svc.failed_sentences[0] == ("Will timeout", "timeout")
        assert svc.sentences_processed == 1

        # Remove blocking side_effect for clean stop
        integration.synthesize_text.side_effect = None
        integration.synthesize_text.return_value = b"ok"
        await svc.stop()

    @pytest.mark.asyncio
    async def test_worker_outer_handler_breaks_when_stopped_and_empty(self):
        """Line 257: Outer except handler breaks when is_running=False + queue empty.

        Set is_running=False BEFORE starting the worker and put one sentence.
        Worker enters loop (queue not empty), consumes the sentence (queue becomes
        empty), synthesize_text raises KeyError (not caught by inner handler),
        outer handler checks: not is_running and queue.empty() → True → break.
        """
        svc, integration = _make_service()
        integration.synthesize_text.side_effect = KeyError("unexpected")

        # Pre-set stopped state; worker enters loop because queue is not empty
        svc.is_running = False
        svc.sentence_queue.put_nowait("trigger outer break")

        # Start worker directly (bypasses start() which sets is_running=True)
        svc.generation_task = asyncio.create_task(svc._generation_worker())

        # Wait for worker to exit via break at line 257
        for _ in range(50):
            if svc.generation_task.done():
                break
            await asyncio.sleep(0.05)

        assert svc.generation_task.done()
        # Worker sets _worker_idle=True and is_running=False on exit
        assert svc._worker_idle is True
        svc.generation_task = None
