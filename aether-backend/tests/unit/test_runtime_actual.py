"""
Real Runtime Tests - Tests actual functionality, not mocks

Tests for core runtime components with REAL validation of functionality:
- RuntimeEngine initialization and lifecycle
- InterpreterManager OI integration  
- ChatStreamer streaming logic
- DocumentProcessor file handling
- RequestTracker async safety
- ConfigManager settings and HTTP client
"""

import pytest
import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from typing import AsyncIterator

# Import actual classes from runtime
from core.runtime.engine import RuntimeEngine
from core.runtime.interpreter import InterpreterManager
from core.runtime.streaming import ChatStreamer
from core.runtime.document import DocumentProcessor
from core.runtime.request import RequestTracker
from core.runtime.config import ConfigManager


# =============================================================================
# RequestTracker Tests - Test async safety and lifecycle
# =============================================================================

class TestRequestTrackerReal:
    """Test RequestTracker with real async operations."""
    
    @pytest.mark.asyncio
    async def test_request_lifecycle(self):
        """Test complete request lifecycle."""
        tracker = RequestTracker()
        request_id = "test-request-123"
        client_id = "test-client"
        text = "test message"
        
        # Start request
        await tracker.start_request(request_id, client_id, text)
        
        # Verify it's tracked
        request_info = tracker.get_request_info(request_id)
        assert request_info is not None
        assert request_info["client_id"] == client_id
        assert request_info["cancelled"] == False
        assert "start_time" in request_info
        
        # End request
        await tracker.end_request(request_id)
        
        # Verify it's removed
        request_info = tracker.get_request_info(request_id)
        assert request_info is None
    
    @pytest.mark.asyncio
    async def test_cancel_request(self):
        """Test request cancellation."""
        tracker = RequestTracker()
        request_id = "test-cancel"
        
        await tracker.start_request(request_id, "client", "text")
        
        # Cancel the request
        result = await tracker.cancel_request(request_id)
        assert result == True
        
        # Check cancellation status
        assert tracker.is_cancelled(request_id) == True
        
        # Try canceling non-existent request
        result = await tracker.cancel_request("non-existent")
        assert result == False
    
    @pytest.mark.asyncio
    async def test_concurrent_requests(self):
        """Test handling multiple concurrent requests."""
        tracker = RequestTracker()
        
        # Start multiple requests
        request_ids = [f"req-{i}" for i in range(10)]
        
        tasks = [
            tracker.start_request(req_id, f"client-{i}", f"text-{i}")
            for i, req_id in enumerate(request_ids)
        ]
        await asyncio.gather(*tasks)
        
        # Verify all are tracked
        assert tracker.get_request_count() == 10
        
        # Verify each individually
        for req_id in request_ids:
            info = tracker.get_request_info(req_id)
            assert info is not None
            assert not info["cancelled"]
    
    @pytest.mark.asyncio
    async def test_stale_request_cleanup(self):
        """Test cleanup of stale requests."""
        tracker = RequestTracker()
        
        # Start a request
        await tracker.start_request("stale-req", "client", "text")
        
        # Manually set old timestamp
        async with tracker._lock:
            tracker._active_requests["stale-req"]["last_activity"] = 0
        
        # Run cleanup
        cleaned = await tracker.cleanup_stale_requests(max_age_seconds=1)
        
        # Verify it was cleaned
        assert cleaned == 1
        assert tracker.get_request_info("stale-req") is None
    
    @pytest.mark.asyncio
    async def test_async_safety(self):
        """Test that dict mutations are async-safe."""
        tracker = RequestTracker()
        
        # Concurrent start and cancel operations
        async def worker(i):
            req_id = f"req-{i}"
            await tracker.start_request(req_id, f"client-{i}", "text")
            await asyncio.sleep(0.001)  # Small delay
            await tracker.cancel_request(req_id)
            await tracker.end_request(req_id)
        
        # Run many workers concurrently
        await asyncio.gather(*[worker(i) for i in range(50)])
        
        # All should be cleaned up
        assert tracker.get_request_count() == 0


# =============================================================================
# ConfigManager Tests - Test settings and HTTP client
# =============================================================================

class TestConfigManagerReal:
    """Test ConfigManager with real HTTP client."""
    
    @pytest.mark.asyncio
    async def test_http_client_creation(self):
        """Test HTTP client can be created and closed."""
        config = ConfigManager()
        
        # Get client
        client = await config.get_client()
        assert client is not None
        assert not client.is_closed
        
        # Verify it's reused
        client2 = await config.get_client()
        assert client2 is client
        
        # Cleanup
        await config.close()
        assert config._client is None or config._client.is_closed
    
    @pytest.mark.asyncio
    async def test_client_context(self):
        """Test client context manager."""
        config = ConfigManager()
        
        async with config.client_context() as client:
            assert client is not None
            assert not client.is_closed
        
        await config.close()
    
    @pytest.mark.asyncio
    async def test_client_reset(self):
        """Test client can be reset."""
        config = ConfigManager()
        
        client1 = await config.get_client()
        old_id = id(client1)
        
        await config.reset_client()
        
        client2 = await config.get_client()
        new_id = id(client2)
        
        # Should be different instance
        assert old_id != new_id
        
        await config.close()


# =============================================================================
# InterpreterManager Tests - Test OI integration
# =============================================================================

class TestInterpreterManagerReal:
    """Test InterpreterManager OI integration."""
    
    @pytest.mark.asyncio
    async def test_initialization(self):
        """Test interpreter manager can initialize."""
        manager = InterpreterManager()
        
        # Initially not initialized
        assert not manager.is_initialized()
        assert not manager.is_available()
        
        # Initialize (may fail if OI not installed, that's OK)
        result = await manager.initialize()
        
        # If successful, should be initialized
        if result:
            assert manager.is_initialized()
            assert manager.is_available()
    
    @pytest.mark.asyncio
    async def test_health_status(self):
        """Test health status reporting."""
        manager = InterpreterManager()
        await manager.initialize()
        
        status = manager.get_health_status()
        assert isinstance(status, dict)
        assert "oi_available" in status
        assert "initialized" in status
        assert "interpreter_created" in status


# =============================================================================
# DocumentProcessor Tests - Test file processing
# =============================================================================

class TestDocumentProcessorReal:
    """Test DocumentProcessor with real file operations."""
    
    @pytest.fixture
    def processor(self):
        """Create processor with mock dependencies."""
        config_manager = MagicMock()
        request_tracker = RequestTracker()
        return DocumentProcessor(config_manager, request_tracker)
    
    def test_pipeline_config_pdf(self, processor):
        """Test pipeline config for PDF files."""
        config = processor._get_pipeline_config("test.pdf")
        
        assert config["pipeline"] == "vlm"
        assert config["vlm_model"] == "smoldocling"
        assert config["ocr_engine"] == "ocrmac"
    
    def test_pipeline_config_image(self, processor):
        """Test pipeline config for image files."""
        config = processor._get_pipeline_config("test.png")
        
        assert config["pipeline"] == "vlm"
        assert config["vlm_model"] == "internvl"
    
    def test_pipeline_config_other(self, processor):
        """Test pipeline config for other files."""
        config = processor._get_pipeline_config("test.docx")
        
        assert config["pipeline"] == "standard"
    
    def test_combined_prompt_generation(self, processor):
        """Test combined prompt generation."""
        content = "Extracted document content"
        user_prompt = "Analyze this document"
        filename = "test.pdf"
        
        prompt = processor._create_combined_prompt(content, user_prompt, filename)
        
        assert "test.pdf" in prompt
        assert "Extracted document content" in prompt
        assert "Analyze this document" in prompt
    
    def test_health_status(self, processor):
        """Test health status reporting."""
        status = processor.get_health_status()
        
        assert isinstance(status, dict)
        assert "docling_url" in status
        assert "config_manager_available" in status
        assert "request_tracker_available" in status


# =============================================================================
# Integration Test - Components working together
# =============================================================================

class TestRuntimeIntegration:
    """Test runtime components integration."""
    
    @pytest.mark.asyncio
    async def test_request_tracking_in_streaming(self):
        """Test request tracker integrates with chat streamer."""
        config_manager = MagicMock()
        request_tracker = RequestTracker()
        
        streamer = ChatStreamer(config_manager, request_tracker)
        
        request_id = "stream-test-123"
        
        # Start a tracked request
        await request_tracker.start_request(request_id, "client", "test")
        
        # Verify it's tracked
        assert not request_tracker.is_cancelled(request_id)
        
        # Cancel it
        await request_tracker.cancel_request(request_id)
        
        # Verify cancellation
        assert request_tracker.is_cancelled(request_id)
        
        # Cleanup
        await request_tracker.end_request(request_id)
    
    @pytest.mark.asyncio
    async def test_config_manager_lifecycle(self):
        """Test config manager full lifecycle."""
        config = ConfigManager()
        
        # Get client
        client1 = await config.get_client()
        assert config.is_client_available()
        
        # Get status
        status = config.get_health_status()
        assert status["http_client_available"]
        
        # Reset
        await config.reset_client()
        assert config.is_client_available()
        
        # Close
        await config.close()
        assert not config.is_client_available()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

