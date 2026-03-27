"""
Unit Tests: Stream Event Builder (Domain Layer)

Tests pure domain logic for event enrichment and artifact tracking.
NO external dependencies - validates domain rules ONLY.
"""

from uuid import uuid4

from ws.domain.event_builder import StreamEventBuilder


class TestEventEnrichment:
    """Test event enrichment with request metadata."""
    
    def test_enrich_injects_backend_identifiers(self):
        """REAL TEST: enrich() injects backend_id, request_id, and metadata."""
        backend_id = str(uuid4())
        frontend_id = "frontend-abc-123"
        chat_id = str(uuid4())
        
        builder = StreamEventBuilder(
            backend_id=backend_id,
            frontend_id=frontend_id,
            chat_id=chat_id,
            correlation_id="corr-456",
        )
        
        event = {"role": "assistant", "type": "message", "content": "Hello"}
        enriched = builder.enrich(event, assign_artifact=False)
        
        # Verify backend IDs injected (only request_id is set, not 'id' or 'backend_id')
        assert enriched["request_id"] == backend_id
        assert enriched["frontend_id"] == frontend_id
        assert enriched["chat_id"] == chat_id
        assert enriched["correlation_id"] == "corr-456"
        
        # Verify original content preserved
        assert enriched["role"] == "assistant"
        assert enriched["type"] == "message"
        assert enriched["content"] == "Hello"
    
    def test_enrich_adds_sequence_and_timestamp(self):
        """REAL TEST: enrich() adds sequence numbers and timestamps."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        event1 = builder.enrich({"role": "assistant", "type": "message"}, assign_artifact=False)
        event2 = builder.enrich({"role": "assistant", "type": "message"}, assign_artifact=False)
        event3 = builder.enrich({"role": "assistant", "type": "message"}, assign_artifact=False)
        
        # Verify sequences increment
        assert event1["sequence"] == 1
        assert event2["sequence"] == 2
        assert event3["sequence"] == 3
        
        # Verify timestamps present
        assert "timestamp" in event1
        assert "timestamp" in event2
        assert event1["timestamp"].endswith("Z") or "+" in event1["timestamp"]  # ISO format


class TestArtifactHandling:
    """Test artifact detection, ID assignment, and phase tracking."""
    
    def test_code_artifacts_get_stable_artifact_id(self):
        """REAL TEST: Code artifacts get stable artifact_id for all chunks."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        # Multiple chunks of same code artifact
        chunk1 = builder.enrich(
            {"role": "assistant", "type": "code", "language": "python", "content": "def"},
            assign_artifact=True,
        )
        chunk2 = builder.enrich(
            {"role": "assistant", "type": "code", "language": "python", "content": " hello():"},
            assign_artifact=True,
        )
        chunk3 = builder.enrich(
            {"role": "assistant", "type": "code", "language": "python", "content": "\n    pass"},
            assign_artifact=True,
        )
        
        # Verify same artifact_id for all chunks
        assert "artifact_id" in chunk1
        assert chunk1["artifact_id"] == chunk2["artifact_id"]
        assert chunk2["artifact_id"] == chunk3["artifact_id"]
        
        # Verify artifact_id format: backend_id:type:counter
        assert chunk1["artifact_id"].startswith(backend_id)
        assert ":code:" in chunk1["artifact_id"]
    
    def test_output_artifacts_get_different_id_from_code(self):
        """REAL TEST: Output artifacts have different IDs from code artifacts."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        code = builder.enrich(
            {"role": "assistant", "type": "code", "content": "print('hi')"},
            assign_artifact=True,
        )
        output = builder.enrich(
            {"role": "computer", "type": "output", "content": "hi"},
            assign_artifact=True,
        )
        
        assert code["artifact_id"] != output["artifact_id"]
        assert ":code:" in code["artifact_id"]
        assert ":output:" in output["artifact_id"]
    
    def test_console_output_normalized_to_output_with_format(self):
        """REAL TEST: Legacy console type normalized to output + format field."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        console_event = builder.enrich(
            {"role": "computer", "type": "console", "content": "Running..."},
            assign_artifact=True,
        )
        
        # Verify normalization
        assert console_event["type"] == "output"
        assert console_event["format"] == "console"
        assert ":output:" in console_event["artifact_id"]
    
    def test_phase_detection_for_code_artifacts(self):
        """REAL TEST: Code artifacts assigned 'write' phase."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        code = builder.enrich(
            {"role": "assistant", "type": "code", "language": "python", "content": "code"},
            assign_artifact=True,
        )
        
        assert code.get("phase") == "write"
    
    def test_phase_detection_for_console_output(self):
        """REAL TEST: Console output assigned 'execute' phase."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        console = builder.enrich(
            {"role": "computer", "type": "console", "content": "Running..."},
            assign_artifact=True,
        )
        
        assert console.get("phase") == "execute"
    
    def test_phase_detection_for_non_console_output(self):
        """REAL TEST: Non-console output assigned 'output' phase."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        html_output = builder.enrich(
            {"role": "computer", "type": "html", "content": "<div>Result</div>"},
            assign_artifact=True,
        )
        
        assert html_output.get("phase") == "output"
        assert html_output["type"] == "output"
        assert html_output["format"] == "html"
    
    def test_execution_group_assigned_to_artifacts(self):
        """REAL TEST: Artifacts get execution_group set to backend_id."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        code = builder.enrich(
            {"role": "assistant", "type": "code", "content": "code"},
            assign_artifact=True,
        )
        output = builder.enrich(
            {"role": "computer", "type": "output", "content": "result"},
            assign_artifact=True,
        )
        
        # Both artifacts from same request share execution_group
        assert code["execution_group"] == backend_id
        assert output["execution_group"] == backend_id
    
    def test_non_artifacts_dont_get_artifact_metadata(self):
        """REAL TEST: Message events don't get artifact_id or phase."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        message = builder.enrich(
            {"role": "assistant", "type": "message", "content": "I will write code"},
            assign_artifact=True,
        )
        
        assert "artifact_id" not in message
        assert "phase" not in message
        assert "execution_group" not in message


class TestRecipientPreservation:
    """Test preservation of recipient field for frontend filtering."""
    
    def test_recipient_field_preserved(self):
        """REAL TEST: Recipient field preserved for assistant-targeted messages."""
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)
        
        assistant_message = builder.enrich(
            {"role": "user", "type": "message", "content": "internal", "recipient": "assistant"},
            assign_artifact=False,
        )
        
        assert assistant_message["recipient"] == "assistant"


class TestOIIdRemoval:
    """Tests for OI 'id' field removal during enrichment."""

    def test_oi_id_removed_from_payload(self):
        """
        Line 180: del payload["id"] removes Open Interpreter's id field.

        Backend owns request_id; OI's 'id' must be stripped to prevent confusion.
        """
        backend_id = str(uuid4())
        builder = StreamEventBuilder(backend_id=backend_id)

        event = {
            "role": "assistant",
            "type": "message",
            "content": "Hello",
            "id": "oi-internal-id-12345",
        }
        result = builder.enrich(event, assign_artifact=False)

        assert "id" not in result
        assert result["request_id"] == backend_id
