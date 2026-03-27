"""
Unit Tests: Runtime Engine

Tests for core runtime components including engine, interpreter,
streaming, document processing, and request tracking.
"""

import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from contextlib import asynccontextmanager
from types import SimpleNamespace

from core.runtime.engine import RuntimeEngine
from core.runtime.interpreter import InterpreterManager
from core.runtime.streaming import ChatStreamer
from core.runtime.document import DocumentProcessor
from core.runtime.request import RequestTracker


# =============================================================================
# Runtime Engine Tests
# =============================================================================

class TestRuntimeEngine:
    """Test RuntimeEngine functionality."""
    
    @pytest.fixture
    def mock_dependencies(self):
        """Create mock dependencies for RuntimeEngine."""
        return {
            'interpreter_manager': MagicMock(spec=InterpreterManager),
            'document_processor': MagicMock(spec=DocumentProcessor),
            'request_tracker': MagicMock(spec=RequestTracker),
            'chat_streamer': MagicMock(spec=ChatStreamer),
        }
    
    @pytest.mark.asyncio
    async def test_engine_initialization(self, mock_dependencies):
        """Test runtime engine initialization."""
        with patch.multiple(
            'core.runtime.engine',
            InterpreterManager=lambda: mock_dependencies['interpreter_manager'],
            DocumentProcessor=lambda: mock_dependencies['document_processor'],
        ):
            engine = RuntimeEngine()
            
            assert engine is not None
            assert hasattr(engine, 'process_message')
            assert hasattr(engine, 'process_file')
    
    @pytest.mark.asyncio
    async def test_process_message_basic(self, mock_interpreter):
        """Test basic message processing."""
        with patch('core.runtime.engine.get_interpreter', return_value=mock_interpreter):
            engine = RuntimeEngine()
            
            result = await engine.process_message(
                message="Hello, assistant!",
                session_id="test-session"
            )
            
            assert isinstance(result, dict)
            assert 'response' in result or 'content' in result
    
    @pytest.mark.asyncio
    async def test_process_message_with_context(self, mock_interpreter):
        """Test message processing with context."""
        with patch('core.runtime.engine.get_interpreter', return_value=mock_interpreter):
            engine = RuntimeEngine()
            
            history = [
                {"role": "user", "content": "Previous message"},
                {"role": "assistant", "content": "Previous response"}
            ]
            
            result = await engine.process_message(
                message="Follow-up question",
                session_id="test-session",
                history=history
            )
            
            assert isinstance(result, dict)
    
    @pytest.mark.asyncio
    async def test_process_file(self, temp_dir: Path):
        """Test file processing."""
        test_file = temp_dir / "test.pdf"
        test_file.write_bytes(b"%PDF-1.4 test content")
        
        with patch('core.runtime.engine.DocumentProcessor') as mock_proc:
            mock_proc.return_value.process_file = AsyncMock(
                return_value={"text": "Extracted text", "status": "success"}
            )
            
            engine = RuntimeEngine()
            result = await engine.process_file(test_file)
            
            assert isinstance(result, dict)
            assert result['status'] == 'success'
    
    @pytest.mark.asyncio
    async def test_streaming_response(self, mock_interpreter):
        """Test streaming response generation."""
        async def mock_stream():
            yield {"type": "message", "content": "Hello"}
            yield {"type": "message", "content": " World"}
        
        mock_interpreter.chat = mock_stream
        
        with patch('core.runtime.engine.get_interpreter', return_value=mock_interpreter):
            engine = RuntimeEngine()
            
            chunks = []
            async for chunk in engine.stream_chat("Test message", "test-session"):
                chunks.append(chunk)
            
            assert len(chunks) > 0


# =============================================================================
# Interpreter Manager Tests
# =============================================================================

class TestInterpreterManager:
    """Test InterpreterManager functionality (external-only OI mode)."""

    @pytest.mark.asyncio
    async def test_manager_initialization(self):
        """Test interpreter manager initialization."""
        manager = InterpreterManager()

        assert manager is not None
        assert hasattr(manager, 'get_interpreter')
        assert hasattr(manager, 'reset_interpreter')

    @pytest.mark.asyncio
    async def test_initialized_always_true(self):
        """In external-only mode, initialized is always True."""
        manager = InterpreterManager()
        assert manager.initialized is True

    @pytest.mark.asyncio
    async def test_get_interpreter_requires_chat_id(self):
        """get_interpreter must raise if chat_id is missing (external mode)."""
        manager = InterpreterManager()
        manager._external_server_enabled = True
        with pytest.raises(RuntimeError, match="chat_id is required"):
            await manager.get_interpreter(chat_id=None)

    @pytest.mark.asyncio
    async def test_load_profile_noop(self):
        """load_profile is a no-op in external mode."""
        manager = InterpreterManager()
        await manager.load_profile("GURU.py")
        # No error, no side effects

    @pytest.mark.asyncio
    async def test_reset_interpreter(self):
        """Test interpreter reset with no active chats."""
        manager = InterpreterManager()
        await manager.reset_interpreter("test-session")
        # No error when chat doesn't exist


# =============================================================================
# Chat Streamer Tests
# =============================================================================

class TestChatStreamer:
    """Test ChatStreamer functionality."""
    
    @pytest.mark.asyncio
    async def test_streamer_initialization(self):
        """Test chat streamer initialization."""
        streamer = ChatStreamer()
        
        assert streamer is not None
        assert hasattr(streamer, 'stream_response')
    
    @pytest.mark.asyncio
    async def test_stream_response(self):
        """Test streaming response."""
        async def mock_generator():
            yield {"type": "message", "content": "Test"}
        
        streamer = ChatStreamer()
        
        chunks = []
        async for chunk in streamer.stream_response(mock_generator()):
            chunks.append(chunk)
        
        assert len(chunks) > 0
        assert chunks[0]['type'] == 'message'
    
    @pytest.mark.asyncio
    async def test_chunk_processing(self):
        """Test chunk processing."""
        streamer = ChatStreamer()
        
        chunk = {"type": "message", "content": "Test content"}
        processed = await streamer.process_chunk(chunk)
        
        assert processed is not None
        assert 'type' in processed
    
    @pytest.mark.asyncio
    async def test_backpressure_handling(self):
        """Test backpressure handling."""
        async def slow_generator():
            for i in range(10):
                yield {"type": "message", "content": f"Chunk {i}"}
        
        streamer = ChatStreamer()
        
        chunks = []
        async for chunk in streamer.stream_response(slow_generator()):
            chunks.append(chunk)
        
        assert len(chunks) == 10

    @pytest.mark.asyncio
    async def test_history_uses_chat_id(self):
        """Ensure chat_id isolates HTTP fallback history from client_id."""
        class DummyResponse:
            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            def raise_for_status(self):
                return None

            async def aiter_lines(self):
                yield 'data: {"choices":[{"delta":{"content":"Hi"}}]}'
                yield "data: [DONE]"

        class DummyClient:
            def stream(self, method, url, json=None, headers=None):
                return DummyResponse()

        class DummyConfig:
            @asynccontextmanager
            async def client_context(self):
                yield DummyClient()

        settings = SimpleNamespace(
            llm=SimpleNamespace(
                api_base="http://localhost:1234/v1",
                model="test-model",
                max_tokens=32,
                supports_vision=False,
                api_key=None,
                provider=None,
            )
        )

        streamer = ChatStreamer(DummyConfig(), RequestTracker())

        chunks = []
        async for chunk in streamer.stream_chat(
            client_id="client-1",
            text="Hello",
            image_b64=None,
            request_id="req-1",
            interpreter=None,
            settings=settings,
            chat_id="chat-123",
        ):
            chunks.append(chunk)

        assert len(chunks) > 0
        assert streamer.get_history("chat-123")
        assert streamer.get_history("client-1") == []


# =============================================================================
# Document Processor Tests
# =============================================================================

class TestDocumentProcessor:
    """Test DocumentProcessor functionality."""
    
    @pytest.fixture
    def processor(self):
        """Create document processor instance."""
        return DocumentProcessor()
    
    @pytest.mark.asyncio
    async def test_detect_file_type(self, processor, temp_dir: Path):
        """Test file type detection."""
        # PDF
        pdf_file = temp_dir / "test.pdf"
        pdf_file.write_bytes(b"%PDF-1.4")
        assert await processor.detect_file_type(pdf_file) == "pdf"
        
        # Text
        txt_file = temp_dir / "test.txt"
        txt_file.write_text("Test content")
        assert await processor.detect_file_type(txt_file) == "text"
    
    @pytest.mark.asyncio
    async def test_process_pdf(self, processor, temp_dir: Path):
        """Test PDF processing routes through Docling pipeline."""
        pdf_file = temp_dir / "test.pdf"
        pdf_file.write_bytes(b"%PDF-1.4 Test PDF content")
        
        docling_result = {
            "success": True, "text": "Extracted text", "content": "Extracted text",
            "format": "markdown", "engine_used": "docling_inprocess:standard",
            "processing_time": 0.5, "pages_processed": 1,
            "combined_prompt": "File: test.pdf\n\nExtracted Content:\nExtracted text",
        }
        with patch.object(processor, '_process_docling_filepath', return_value=docling_result):
            result = await processor.process_file(pdf_file)
            
            assert isinstance(result, dict)
            assert 'text' in result
            assert result['text'] == "Extracted text"
    
    @pytest.mark.asyncio
    async def test_process_image(self, processor, temp_dir: Path):
        """Test image processing routes through vision pipeline."""
        img_file = temp_dir / "test.png"
        img_file.write_bytes(b"\x89PNG\r\n\x1a\n")  # PNG signature
        
        vision_result = {
            "success": True, "text": "OCR text", "content": "OCR text",
            "format": "vision_description", "engine_used": "vision-glm-ocr",
        }
        with patch.object(processor, '_process_image_filepath', return_value=vision_result):
            result = await processor.process_file(img_file)
            
            assert isinstance(result, dict)
    
    @pytest.mark.asyncio
    async def test_table_extraction(self, processor, temp_dir: Path):
        """Test table extraction."""
        doc_file = temp_dir / "test.docx"
        doc_file.write_bytes(b"PK\x03\x04")  # ZIP signature (docx)
        
        with patch.object(processor, '_extract_tables', return_value=[]):
            result = await processor.extract_tables(doc_file)
            
            assert isinstance(result, list)

    @pytest.mark.asyncio
    async def test_base64_image_uses_llm_proxy(self, processor):
        """Verify base64 image uses backend LLM proxy and returns combined prompt."""
        captured = {}

        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"choices": [{"message": {"content": "Image description"}}]}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                captured["instance"] = self
                self.last_url = None
                self.last_payload = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def post(self, url, json, headers):
                self.last_url = url
                self.last_payload = json
                return FakeResponse()

        def mock_resolve(provider_config, service_type="vision"):
            return ("http://127.0.0.1:8765/v1/llm", "internvl3_5-2b", "not-needed")

        settings = SimpleNamespace(
            base_url="http://127.0.0.1:8765",
            llm=SimpleNamespace(max_tokens=64, temperature=0.2, supports_vision=False),
            vision_document=SimpleNamespace(
                vision_model_lmstudio="internvl3_5-2b",
                provider_config=SimpleNamespace(model="internvl3_5-2b"),
            ),
            websocket=SimpleNamespace(image_processing_timeout=5.0),
            resolve_service_provider=mock_resolve,
        )

        with patch("core.runtime.document.get_settings", return_value=settings), \
             patch("httpx.AsyncClient", FakeAsyncClient):
            result = await processor.process_file(
                base64_data="aGVsbG8=",
                filename="image.png",
                user_prompt="Describe the image",
            )

        assert result.get("success") is True
        assert result.get("combined_prompt")
        assert captured["instance"].last_url == "http://127.0.0.1:8765/v1/llm/chat/completions"
        assert captured["instance"].last_payload["model"] == "internvl3_5-2b"


# =============================================================================
# Request Tracker Tests
# =============================================================================

class TestRequestTracker:
    """Test RequestTracker functionality."""
    
    @pytest.fixture
    def tracker(self):
        """Create request tracker instance."""
        return RequestTracker()
    
    @pytest.mark.asyncio
    async def test_track_request(self, tracker):
        """Test request tracking."""
        request_id = "test-request-123"
        
        await tracker.start_request(request_id)
        
        status = await tracker.get_status(request_id)
        assert status is not None
        assert status['state'] in ['pending', 'running']
    
    @pytest.mark.asyncio
    async def test_complete_request(self, tracker):
        """Test request completion."""
        request_id = "test-request-456"
        
        await tracker.start_request(request_id)
        await tracker.complete_request(request_id, result={"status": "success"})
        
        status = await tracker.get_status(request_id)
        assert status['state'] == 'completed'
    
    @pytest.mark.asyncio
    async def test_fail_request(self, tracker):
        """Test request failure."""
        request_id = "test-request-789"
        
        await tracker.start_request(request_id)
        await tracker.fail_request(request_id, error="Test error")
        
        status = await tracker.get_status(request_id)
        assert status['state'] == 'failed'
        assert 'error' in status
    
    @pytest.mark.asyncio
    async def test_request_timeout(self, tracker):
        """Test request timeout handling."""
        request_id = "test-request-timeout"
        
        with pytest.raises(TimeoutError):
            async with tracker.request_context(request_id, timeout=0.1):
                import asyncio
                await asyncio.sleep(0.2)  # Exceed timeout
    
    @pytest.mark.asyncio
    async def test_concurrent_requests(self, tracker):
        """Test concurrent request tracking."""
        request_ids = [f"test-request-{i}" for i in range(5)]
        
        # Start all requests
        for req_id in request_ids:
            await tracker.start_request(req_id)
        
        # All should be tracked
        for req_id in request_ids:
            status = await tracker.get_status(req_id)
            assert status is not None


# =============================================================================
# Runtime Config Tests
# =============================================================================

class TestRuntimeConfig:
    """Test RuntimeConfig functionality."""
    
    def test_config_initialization(self):
        """Test runtime config initialization."""
        config = RuntimeConfig()
        
        assert config is not None
        assert hasattr(config, 'timeout')
        assert hasattr(config, 'max_tokens')
    
    def test_config_from_settings(self, test_settings):
        """Test config creation from settings."""
        config = RuntimeConfig.from_settings(test_settings)
        
        assert config is not None
        assert config.context_window > 0
        assert config.max_tokens > 0
    
    def test_config_validation(self):
        """Test config validation."""
        config = RuntimeConfig(
            context_window=100000,
            max_tokens=4096,
            timeout=600
        )
        
        assert config.context_window == 100000
        assert config.max_tokens == 4096
        assert config.timeout == 600

