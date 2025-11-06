"""
End-to-End Tests: Chat Flow

Complete chat workflow testing from file upload through processing
to chat interaction and response streaming.
"""

import pytest
from httpx import AsyncClient
from pathlib import Path


# =============================================================================
# Complete Chat Workflow Tests
# =============================================================================

class TestCompleteChatFlow:
    """Test complete chat flow end-to-end."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_basic_chat_interaction(self, client: AsyncClient):
        """Test basic chat interaction."""
        # Send initial message
        response = await client.post(
            "/api/v1/chat",
            json={
                'message': 'Hello, assistant! How can you help me?',
                'session_id': 'e2e-test-001'
            }
        )
        
        assert response.status_code in [200, 201]
        data = response.json()
        assert 'response' in data or 'content' in data
        
        # Send follow-up message
        follow_up = await client.post(
            "/api/v1/chat",
            json={
                'message': 'Can you explain more?',
                'session_id': 'e2e-test-001'
            }
        )
        
        assert follow_up.status_code in [200, 201]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_file_upload_and_chat(self, client: AsyncClient, temp_dir: Path):
        """Test uploading file and chatting about it."""
        # Create test file
        test_file = temp_dir / "document.txt"
        test_file.write_text(
            "This is a test document. It contains important information about AI."
        )
        
        # Upload file
        files = {'file': ('document.txt', open(test_file, 'rb'), 'text/plain')}
        upload_response = await client.post("/api/v1/files/upload", files=files)
        
        assert upload_response.status_code in [200, 201]
        file_id = upload_response.json().get('file_id') or upload_response.json().get('id')
        
        # Process file
        process_response = await client.post(f"/api/v1/files/process/{file_id}")
        assert process_response.status_code == 200
        
        # Chat about the file
        chat_response = await client.post(
            "/api/v1/chat",
            json={
                'message': 'What does the document say about AI?',
                'session_id': 'e2e-test-002',
                'file_id': file_id
            }
        )
        
        assert chat_response.status_code in [200, 201]
        data = chat_response.json()
        assert 'response' in data or 'content' in data
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_streaming_chat_flow(self, client: AsyncClient):
        """Test streaming chat response."""
        payload = {
            'message': 'Tell me a story about AI',
            'session_id': 'e2e-test-003',
            'stream': True
        }
        
        async with client.stream("POST", "/api/v1/chat/stream", json=payload) as response:
            assert response.status_code == 200
            
            chunks = []
            async for chunk in response.aiter_bytes():
                if chunk:
                    chunks.append(chunk)
            
            assert len(chunks) > 0
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_multi_turn_conversation(self, client: AsyncClient):
        """Test multi-turn conversation."""
        session_id = 'e2e-test-004'
        
        # Turn 1
        response1 = await client.post(
            "/api/v1/chat",
            json={
                'message': 'What is 2 + 2?',
                'session_id': session_id
            }
        )
        assert response1.status_code in [200, 201]
        
        # Turn 2
        response2 = await client.post(
            "/api/v1/chat",
            json={
                'message': 'What about 3 + 3?',
                'session_id': session_id
            }
        )
        assert response2.status_code in [200, 201]
        
        # Turn 3
        response3 = await client.post(
            "/api/v1/chat",
            json={
                'message': 'Can you summarize what we discussed?',
                'session_id': session_id
            }
        )
        assert response3.status_code in [200, 201]
        
        # Get full history
        history_response = await client.get(f"/api/v1/chat/history/{session_id}")
        assert history_response.status_code == 200
        
        history = history_response.json()
        assert isinstance(history, list) or 'messages' in history


# =============================================================================
# File Processing Workflow Tests
# =============================================================================

class TestFileProcessingFlow:
    """Test file processing workflows."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_pdf_processing_flow(self, client: AsyncClient, temp_dir: Path):
        """Test complete PDF processing flow."""
        # Create test PDF
        pdf_file = temp_dir / "test.pdf"
        pdf_file.write_bytes(b"%PDF-1.4\nTest PDF content")
        
        # Upload
        files = {'file': ('test.pdf', open(pdf_file, 'rb'), 'application/pdf')}
        upload_response = await client.post("/api/v1/files/upload", files=files)
        assert upload_response.status_code in [200, 201]
        
        file_id = upload_response.json().get('file_id') or upload_response.json().get('id')
        
        # Process
        process_response = await client.post(f"/api/v1/files/process/{file_id}")
        assert process_response.status_code == 200
        
        # Get file info
        info_response = await client.get(f"/api/v1/files/{file_id}")
        assert info_response.status_code == 200
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_multiple_files_workflow(self, client: AsyncClient, temp_dir: Path):
        """Test processing multiple files."""
        file_ids = []
        
        # Upload multiple files
        for i in range(3):
            test_file = temp_dir / f"file{i}.txt"
            test_file.write_text(f"Content of file {i}")
            
            files = {'file': (f'file{i}.txt', open(test_file, 'rb'), 'text/plain')}
            response = await client.post("/api/v1/files/upload", files=files)
            assert response.status_code in [200, 201]
            
            file_ids.append(response.json().get('file_id') or response.json().get('id'))
        
        # Process all files
        for file_id in file_ids:
            process_response = await client.post(f"/api/v1/files/process/{file_id}")
            assert process_response.status_code == 200
        
        # List all files
        list_response = await client.get("/api/v1/files")
        assert list_response.status_code == 200


# =============================================================================
# Error Scenario Tests
# =============================================================================

class TestErrorScenarios:
    """Test error handling in complete workflows."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_invalid_file_upload(self, client: AsyncClient, temp_dir: Path):
        """Test handling invalid file upload."""
        # Create invalid file (if executable)
        bad_file = temp_dir / "malicious.exe"
        bad_file.write_bytes(b"MZ\x90\x00")  # EXE signature
        
        files = {'file': ('malicious.exe', open(bad_file, 'rb'), 'application/x-msdownload')}
        response = await client.post("/api/v1/files/upload", files=files)
        
        # Should reject or handle gracefully
        assert response.status_code in [400, 415, 422]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_chat_with_nonexistent_file(self, client: AsyncClient):
        """Test chatting with reference to nonexistent file."""
        response = await client.post(
            "/api/v1/chat",
            json={
                'message': 'Tell me about the file',
                'session_id': 'e2e-error-001',
                'file_id': 'nonexistent-file-id'
            }
        )
        
        # Should handle gracefully
        assert response.status_code in [200, 400, 404]
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_malformed_chat_request(self, client: AsyncClient):
        """Test handling malformed chat request."""
        response = await client.post(
            "/api/v1/chat",
            json={
                # Missing required fields
                'invalid_field': 'value'
            }
        )
        
        assert response.status_code in [400, 422]


# =============================================================================
# Integration Workflow Tests
# =============================================================================

class TestIntegrationWorkflows:
    """Test workflows involving external integrations."""
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_chat_with_search(self, client: AsyncClient):
        """Test chat with search integration."""
        response = await client.post(
            "/api/v1/chat",
            json={
                'message': 'Search for information about quantum computing',
                'session_id': 'e2e-integration-001',
                'use_search': True
            }
        )
        
        # In test environment, search may be mocked
        assert response.status_code in [200, 201, 503]  # 503 if service unavailable
    
    @pytest.mark.e2e
    @pytest.mark.asyncio
    async def test_chat_with_document_processing(self, client: AsyncClient, temp_dir: Path):
        """Test chat with document processing integration."""
        # Upload document
        doc_file = temp_dir / "research.pdf"
        doc_file.write_bytes(b"%PDF-1.4\nResearch content here")
        
        files = {'file': ('research.pdf', open(doc_file, 'rb'), 'application/pdf')}
        upload_response = await client.post("/api/v1/files/upload", files=files)
        
        if upload_response.status_code in [200, 201]:
            file_id = upload_response.json().get('file_id') or upload_response.json().get('id')
            
            # Process with document service
            process_response = await client.post(
                f"/api/v1/files/process/{file_id}",
                json={'extract_tables': True, 'use_ocr': True}
            )
            
            # May work or fail if docling service unavailable
            assert process_response.status_code in [200, 503]


# =============================================================================
# Performance Tests
# =============================================================================

class TestPerformanceWorkflows:
    """Test performance of complete workflows."""
    
    @pytest.mark.e2e
    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_concurrent_chat_sessions(self, client: AsyncClient):
        """Test multiple concurrent chat sessions."""
        import asyncio
        
        async def chat_session(session_id: str):
            response = await client.post(
                "/api/v1/chat",
                json={
                    'message': f'Hello from session {session_id}',
                    'session_id': session_id
                }
            )
            return response.status_code in [200, 201]
        
        # Run 10 concurrent sessions
        results = await asyncio.gather(
            *[chat_session(f'e2e-perf-{i}') for i in range(10)]
        )
        
        # All should succeed
        assert all(results)
    
    @pytest.mark.e2e
    @pytest.mark.slow
    @pytest.mark.asyncio
    async def test_large_file_processing(self, client: AsyncClient, temp_dir: Path):
        """Test processing large file."""
        # Create 10MB file
        large_file = temp_dir / "large.txt"
        large_file.write_text("x" * (10 * 1024 * 1024))
        
        files = {'file': ('large.txt', open(large_file, 'rb'), 'text/plain')}
        response = await client.post("/api/v1/files/upload", files=files)
        
        # Should handle or reject gracefully based on limits
        assert response.status_code in [200, 201, 413]

