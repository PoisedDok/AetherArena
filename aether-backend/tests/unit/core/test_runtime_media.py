"""
Unit Tests: RuntimeMediaService (core/runtime/media.py)

Covers initialization, delegation to DocumentProcessor, cleanup lifecycle,
and health status reporting.

Mock boundaries: core.runtime.document.DocumentProcessor (imported lazily inside initialize())
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.runtime.media import RuntimeMediaService


# ─── Constructor ──────────────────────────────────────────────────────────────


class TestRuntimeMediaServiceInit:
    def test_initial_state(self):
        svc = RuntimeMediaService()
        assert svc._document_processor is None


# ─── initialize() ─────────────────────────────────────────────────────────────


class TestInitialize:
    async def test_creates_document_processor(self):
        svc = RuntimeMediaService()
        config_mgr = MagicMock()
        req_tracker = MagicMock()

        with patch("core.runtime.document.DocumentProcessor") as MockDP:
            mock_dp_instance = MagicMock()
            MockDP.return_value = mock_dp_instance

            await svc.initialize(config_mgr, req_tracker)

            MockDP.assert_called_once_with(config_mgr, req_tracker)
            assert svc._document_processor is mock_dp_instance

    async def test_idempotent_if_already_initialized(self):
        svc = RuntimeMediaService()
        existing_dp = MagicMock()
        svc._document_processor = existing_dp

        config_mgr = MagicMock()
        req_tracker = MagicMock()

        with patch("core.runtime.document.DocumentProcessor") as MockDP:
            await svc.initialize(config_mgr, req_tracker)

            MockDP.assert_not_called()
            assert svc._document_processor is existing_dp

    async def test_raises_if_config_manager_missing(self):
        svc = RuntimeMediaService()
        with pytest.raises(RuntimeError, match="DocumentProcessor requires config manager and request tracker"):
            await svc.initialize(None, MagicMock())

    async def test_raises_if_request_tracker_missing(self):
        svc = RuntimeMediaService()
        with pytest.raises(RuntimeError, match="DocumentProcessor requires config manager and request tracker"):
            await svc.initialize(MagicMock(), None)

    async def test_raises_if_both_missing(self):
        svc = RuntimeMediaService()
        with pytest.raises(RuntimeError, match="DocumentProcessor requires config manager and request tracker"):
            await svc.initialize(None, None)


# ─── process_file_chat() ─────────────────────────────────────────────────────


class TestProcessFileChat:
    async def test_raises_if_not_initialized(self):
        svc = RuntimeMediaService()
        with pytest.raises(RuntimeError, match="Document processor not initialized"):
            await svc.process_file_chat(
                file_data={"name": "test.pdf"},
                prompt="Summarize",
                request_id="req-1",
                interpreter=None,
            )

    async def test_delegates_to_document_processor(self):
        svc = RuntimeMediaService()
        mock_dp = MagicMock()
        expected = {"result": "analysis", "pages": 3}
        mock_dp.process_file_chat = AsyncMock(return_value=expected)
        svc._document_processor = mock_dp

        file_data = {"name": "report.pdf", "content": b"data"}
        result = await svc.process_file_chat(
            file_data=file_data,
            prompt="Analyze this",
            request_id="req-42",
            interpreter=MagicMock(),
        )

        assert result == expected
        mock_dp.process_file_chat.assert_called_once_with(
            file_data=file_data,
            prompt="Analyze this",
            request_id="req-42",
            interpreter=mock_dp.process_file_chat.call_args.kwargs["interpreter"],
        )

    async def test_forwards_all_kwargs_exactly(self):
        """Verify no kwarg is dropped or mutated during delegation."""
        svc = RuntimeMediaService()
        mock_dp = MagicMock()
        mock_dp.process_file_chat = AsyncMock(return_value={})
        svc._document_processor = mock_dp

        interp = MagicMock()
        await svc.process_file_chat(
            file_data={"key": "val"},
            prompt="test prompt",
            request_id="req-99",
            interpreter=interp,
        )

        call_kwargs = mock_dp.process_file_chat.call_args.kwargs
        assert call_kwargs["file_data"] == {"key": "val"}
        assert call_kwargs["prompt"] == "test prompt"
        assert call_kwargs["request_id"] == "req-99"
        assert call_kwargs["interpreter"] is interp


# ─── process_file_chat_multipart() ───────────────────────────────────────────


class TestProcessFileChatMultipart:
    async def test_raises_if_not_initialized(self):
        svc = RuntimeMediaService()
        with pytest.raises(RuntimeError, match="Document processor not initialized"):
            await svc.process_file_chat_multipart(
                file_data={"name": "test.pdf"},
                prompt="Summarize",
                request_id="req-1",
                interpreter=None,
            )

    async def test_delegates_to_document_processor(self):
        svc = RuntimeMediaService()
        mock_dp = MagicMock()
        expected = {"parts": [{"type": "text", "content": "page 1"}]}
        mock_dp.process_file_chat_multipart = AsyncMock(return_value=expected)
        svc._document_processor = mock_dp

        file_data = {"name": "slides.pptx", "content": b"binary"}
        result = await svc.process_file_chat_multipart(
            file_data=file_data,
            prompt="Extract slides",
            request_id="req-77",
            interpreter=None,
        )

        assert result == expected
        mock_dp.process_file_chat_multipart.assert_called_once_with(
            file_data=file_data,
            prompt="Extract slides",
            request_id="req-77",
            interpreter=None,
        )

    async def test_forwards_all_kwargs_exactly(self):
        svc = RuntimeMediaService()
        mock_dp = MagicMock()
        mock_dp.process_file_chat_multipart = AsyncMock(return_value={})
        svc._document_processor = mock_dp

        interp = MagicMock()
        await svc.process_file_chat_multipart(
            file_data={"multi": True},
            prompt="multi prompt",
            request_id="req-multi",
            interpreter=interp,
        )

        call_kwargs = mock_dp.process_file_chat_multipart.call_args.kwargs
        assert call_kwargs["file_data"] == {"multi": True}
        assert call_kwargs["prompt"] == "multi prompt"
        assert call_kwargs["request_id"] == "req-multi"
        assert call_kwargs["interpreter"] is interp


# ─── cleanup() ────────────────────────────────────────────────────────────────


class TestCleanup:
    async def test_calls_cleanup_on_processor_and_nullifies(self):
        svc = RuntimeMediaService()
        mock_dp = MagicMock()
        mock_dp.cleanup = AsyncMock()
        svc._document_processor = mock_dp

        await svc.cleanup()

        mock_dp.cleanup.assert_called_once()
        assert svc._document_processor is None

    async def test_skips_cleanup_if_processor_lacks_method(self):
        """Processor without cleanup attr — just nullify, no error."""
        svc = RuntimeMediaService()
        mock_dp = MagicMock(spec=[])  # spec=[] means no attributes at all
        svc._document_processor = mock_dp

        await svc.cleanup()

        assert svc._document_processor is None

    async def test_no_error_when_no_processor(self):
        svc = RuntimeMediaService()
        assert svc._document_processor is None

        await svc.cleanup()

        assert svc._document_processor is None

    async def test_idempotent_double_cleanup(self):
        svc = RuntimeMediaService()
        mock_dp = MagicMock()
        mock_dp.cleanup = AsyncMock()
        svc._document_processor = mock_dp

        await svc.cleanup()
        await svc.cleanup()

        mock_dp.cleanup.assert_called_once()
        assert svc._document_processor is None


# ─── get_health_status() ─────────────────────────────────────────────────────


class TestGetHealthStatus:
    def test_not_initialized(self):
        svc = RuntimeMediaService()
        status = svc.get_health_status()

        assert status["available"] is False
        assert status["details"] == {}

    def test_initialized_with_health_method(self):
        svc = RuntimeMediaService()
        mock_dp = MagicMock()
        mock_dp.get_health_status.return_value = {"uptime": 120, "documents_processed": 5}
        svc._document_processor = mock_dp

        status = svc.get_health_status()

        assert status["available"] is True
        assert status["details"] == {"uptime": 120, "documents_processed": 5}
        mock_dp.get_health_status.assert_called_once()

    def test_initialized_without_health_method(self):
        """Processor exists but has no get_health_status — fallback lambda returns {}."""
        svc = RuntimeMediaService()
        mock_dp = MagicMock(spec=[])  # No attributes
        svc._document_processor = mock_dp

        status = svc.get_health_status()

        assert status["available"] is True
        assert status["details"] == {}
