"""
Unit Tests: TaskManager

Tests the stream task lifecycle manager — registration, cancellation,
client cleanup, forget, and finalizer attachment.

Uses real asyncio.Task objects where possible, MagicMock for edge cases.
"""

import asyncio
from unittest.mock import MagicMock


from ws.application.lifecycle.task_manager import TaskManager


# =========================================================================
# Helpers
# =========================================================================

CLIENT_1 = "client-001"
CLIENT_2 = "client-002"
REQ_1 = "req-001"
REQ_2 = "req-002"
REQ_3 = "req-003"
FRONTEND_1 = "fe-001"
CORR_1 = "corr-001"


async def _noop():
    """Infinite-wait coroutine that can be cancelled."""
    try:
        await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass


def _make_task():
    """Create a real asyncio.Task that waits indefinitely."""
    return asyncio.create_task(_noop())


# =========================================================================
# Init
# =========================================================================

class TestInit:
    """Tests for TaskManager.__init__."""

    def test_default_state(self):
        """Starts with empty tracking dict."""
        mgr = TaskManager()
        assert len(mgr._stream_tasks) == 0


# =========================================================================
# register_task
# =========================================================================

class TestRegisterTask:
    """Tests for TaskManager.register_task."""

    async def test_register_stores_task_info(self):
        """Registers task with full metadata."""
        mgr = TaskManager()
        task = _make_task()
        try:
            await mgr.register_task(
                request_id=REQ_1,
                task=task,
                client_id=CLIENT_1,
                correlation_id=CORR_1,
                frontend_id=FRONTEND_1,
            )
            assert REQ_1 in mgr._stream_tasks
            info = mgr._stream_tasks[REQ_1]
            assert info["task"] is task
            assert info["client_id"] == CLIENT_1
            assert info["correlation_id"] == CORR_1
            assert info["frontend_id"] == FRONTEND_1
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_register_with_none_optionals(self):
        """Registers task with None correlation and frontend IDs."""
        mgr = TaskManager()
        task = _make_task()
        try:
            await mgr.register_task(
                request_id=REQ_1,
                task=task,
                client_id=CLIENT_1,
                correlation_id=None,
                frontend_id=None,
            )
            info = mgr._stream_tasks[REQ_1]
            assert info["correlation_id"] is None
            assert info["frontend_id"] is None
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_register_multiple_tasks(self):
        """Multiple tasks tracked independently."""
        mgr = TaskManager()
        task1 = _make_task()
        task2 = _make_task()
        try:
            await mgr.register_task(
                request_id=REQ_1, task=task1, client_id=CLIENT_1,
                correlation_id=None, frontend_id=None,
            )
            await mgr.register_task(
                request_id=REQ_2, task=task2, client_id=CLIENT_1,
                correlation_id=None, frontend_id=None,
            )
            assert len(mgr._stream_tasks) == 2
            assert mgr._stream_tasks[REQ_1]["task"] is task1
            assert mgr._stream_tasks[REQ_2]["task"] is task2
        finally:
            task1.cancel()
            task2.cancel()
            for t in (task1, task2):
                try:
                    await t
                except asyncio.CancelledError:
                    pass

    async def test_register_overwrites_existing(self):
        """Re-registering same request_id overwrites previous entry."""
        mgr = TaskManager()
        task1 = _make_task()
        task2 = _make_task()
        try:
            await mgr.register_task(
                request_id=REQ_1, task=task1, client_id=CLIENT_1,
                correlation_id=None, frontend_id=None,
            )
            await mgr.register_task(
                request_id=REQ_1, task=task2, client_id=CLIENT_2,
                correlation_id=CORR_1, frontend_id=FRONTEND_1,
            )
            assert len(mgr._stream_tasks) == 1
            info = mgr._stream_tasks[REQ_1]
            assert info["task"] is task2
            assert info["client_id"] == CLIENT_2
        finally:
            task1.cancel()
            task2.cancel()
            for t in (task1, task2):
                try:
                    await t
                except asyncio.CancelledError:
                    pass


# =========================================================================
# cancel_task
# =========================================================================

class TestCancelTask:
    """Tests for TaskManager.cancel_task."""

    async def test_cancel_existing_task(self):
        """Cancel registered task → returns metadata."""
        mgr = TaskManager()
        task = _make_task()
        await mgr.register_task(
            request_id=REQ_1, task=task, client_id=CLIENT_1,
            correlation_id=CORR_1, frontend_id=FRONTEND_1,
        )
        result = await mgr.cancel_task(REQ_1)

        assert result is not None
        assert result["client_id"] == CLIENT_1
        assert result["correlation_id"] == CORR_1
        assert result["frontend_id"] == FRONTEND_1
        # Must await the task for it to process the cancellation
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert task.cancelled()

    async def test_cancel_nonexistent_returns_none(self):
        """Cancel non-existent request → returns None."""
        mgr = TaskManager()
        result = await mgr.cancel_task("nonexistent")
        assert result is None

    async def test_cancel_removes_from_tracking(self):
        """After cancellation, task is no longer tracked."""
        mgr = TaskManager()
        task = _make_task()
        await mgr.register_task(
            request_id=REQ_1, task=task, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        await mgr.cancel_task(REQ_1)

        assert REQ_1 not in mgr._stream_tasks
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def test_cancel_task_cancel_raises_runtime_error(self):
        """Task.cancel() raises RuntimeError → caught, returns None."""
        mgr = TaskManager()
        mock_task = MagicMock()
        mock_task.cancel.side_effect = RuntimeError("event loop closed")

        await mgr.register_task(
            request_id=REQ_1, task=mock_task, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        result = await mgr.cancel_task(REQ_1)
        assert result is None


# =========================================================================
# cleanup_client_tasks
# =========================================================================

class TestCleanupClientTasks:
    """Tests for TaskManager.cleanup_client_tasks."""

    async def test_cleanup_cancels_all_client_tasks(self):
        """Cancels all tasks for given client."""
        mgr = TaskManager()
        task1 = _make_task()
        task2 = _make_task()
        await mgr.register_task(
            request_id=REQ_1, task=task1, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        await mgr.register_task(
            request_id=REQ_2, task=task2, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )

        cancelled = await mgr.cleanup_client_tasks(CLIENT_1)

        assert set(cancelled) == {REQ_1, REQ_2}
        # Must await tasks for cancellation to process
        for t in (task1, task2):
            try:
                await t
            except asyncio.CancelledError:
                pass
        assert task1.cancelled()
        assert task2.cancelled()

    async def test_cleanup_preserves_other_client_tasks(self):
        """Cleanup for one client doesn't affect another."""
        mgr = TaskManager()
        task1 = _make_task()
        task2 = _make_task()
        try:
            await mgr.register_task(
                request_id=REQ_1, task=task1, client_id=CLIENT_1,
                correlation_id=None, frontend_id=None,
            )
            await mgr.register_task(
                request_id=REQ_2, task=task2, client_id=CLIENT_2,
                correlation_id=None, frontend_id=None,
            )

            cancelled = await mgr.cleanup_client_tasks(CLIENT_1)

            assert cancelled == [REQ_1]
            assert REQ_2 in mgr._stream_tasks
            assert not task2.cancelled()
        finally:
            task1.cancel()
            task2.cancel()
            for t in (task1, task2):
                try:
                    await t
                except asyncio.CancelledError:
                    pass

    async def test_cleanup_nonexistent_client_returns_empty(self):
        """Cleanup for non-existent client → empty list."""
        mgr = TaskManager()
        cancelled = await mgr.cleanup_client_tasks("no-such-client")
        assert cancelled == []

    async def test_cleanup_returns_cancelled_ids(self):
        """Returns exact list of cancelled request IDs."""
        mgr = TaskManager()
        task1 = _make_task()
        task2 = _make_task()
        task3 = _make_task()
        await mgr.register_task(
            request_id=REQ_1, task=task1, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        await mgr.register_task(
            request_id=REQ_2, task=task2, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        await mgr.register_task(
            request_id=REQ_3, task=task3, client_id=CLIENT_2,
            correlation_id=None, frontend_id=None,
        )

        cancelled = await mgr.cleanup_client_tasks(CLIENT_1)
        assert set(cancelled) == {REQ_1, REQ_2}
        assert REQ_3 not in cancelled

        task3.cancel()
        for t in (task1, task2, task3):
            try:
                await t
            except asyncio.CancelledError:
                pass

    async def test_cleanup_handles_cancel_error(self):
        """Task.cancel() raises RuntimeError during cleanup → skips, continues."""
        mgr = TaskManager()
        mock_task1 = MagicMock()
        mock_task1.cancel.side_effect = RuntimeError("event loop closed")
        task2 = _make_task()

        await mgr.register_task(
            request_id=REQ_1, task=mock_task1, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        await mgr.register_task(
            request_id=REQ_2, task=task2, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )

        cancelled = await mgr.cleanup_client_tasks(CLIENT_1)
        # REQ_1 failed, REQ_2 should still cancel
        assert REQ_2 in cancelled
        assert REQ_1 not in cancelled

        task2.cancel()
        try:
            await task2
        except asyncio.CancelledError:
            pass


# =========================================================================
# forget_task
# =========================================================================

class TestForgetTask:
    """Tests for TaskManager.forget_task."""

    async def test_forget_removes_task(self):
        """Forget removes task from tracking without cancelling."""
        mgr = TaskManager()
        task = _make_task()
        try:
            await mgr.register_task(
                request_id=REQ_1, task=task, client_id=CLIENT_1,
                correlation_id=None, frontend_id=None,
            )
            await mgr.forget_task(REQ_1)

            assert REQ_1 not in mgr._stream_tasks
            # Task is NOT cancelled by forget
            assert not task.cancelled()
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_forget_nonexistent_no_error(self):
        """Forget non-existent request → no error."""
        mgr = TaskManager()
        await mgr.forget_task("nonexistent")
        # Should not raise


# =========================================================================
# attach_finalizer
# =========================================================================

class TestAttachFinalizer:
    """Tests for TaskManager.attach_finalizer."""

    async def test_finalizer_forgets_task_on_completion(self):
        """When task completes, finalizer removes it from tracking."""
        mgr = TaskManager()

        async def quick_task():
            return "done"

        task = asyncio.create_task(quick_task())
        await mgr.register_task(
            request_id=REQ_1, task=task, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        mgr.attach_finalizer(task, request_id=REQ_1)

        # Wait for task to complete
        await task
        # Give event loop a chance to run callbacks
        await asyncio.sleep(0.05)

        assert REQ_1 not in mgr._stream_tasks

    async def test_finalizer_calls_cleanup_callback(self):
        """Finalizer invokes cleanup_callback with request_id."""
        mgr = TaskManager()
        callback = MagicMock()

        async def quick_task():
            return "done"

        task = asyncio.create_task(quick_task())
        await mgr.register_task(
            request_id=REQ_1, task=task, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        mgr.attach_finalizer(task, request_id=REQ_1, cleanup_callback=callback)

        await task
        await asyncio.sleep(0.05)

        callback.assert_called_once_with(REQ_1)

    async def test_finalizer_handles_callback_error(self):
        """Cleanup callback raises → logged, no crash."""
        mgr = TaskManager()
        callback = MagicMock(side_effect=RuntimeError("callback failed"))

        async def quick_task():
            return "done"

        task = asyncio.create_task(quick_task())
        await mgr.register_task(
            request_id=REQ_1, task=task, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        mgr.attach_finalizer(task, request_id=REQ_1, cleanup_callback=callback)

        await task
        await asyncio.sleep(0.05)

        # Should not raise; task still forgotten
        assert REQ_1 not in mgr._stream_tasks

    async def test_finalizer_no_callback(self):
        """Finalizer works without cleanup_callback."""
        mgr = TaskManager()

        async def quick_task():
            return "done"

        task = asyncio.create_task(quick_task())
        await mgr.register_task(
            request_id=REQ_1, task=task, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        mgr.attach_finalizer(task, request_id=REQ_1)

        await task
        await asyncio.sleep(0.05)

        assert REQ_1 not in mgr._stream_tasks

    async def test_finalizer_on_cancelled_task(self):
        """Finalizer fires even when task is cancelled."""
        mgr = TaskManager()
        task = _make_task()
        await mgr.register_task(
            request_id=REQ_1, task=task, client_id=CLIENT_1,
            correlation_id=None, frontend_id=None,
        )
        mgr.attach_finalizer(task, request_id=REQ_1)

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(0.05)

        assert REQ_1 not in mgr._stream_tasks
