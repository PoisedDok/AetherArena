"""
Unit Tests: ws.protocols

Tests message schemas, validators, and validate_message dispatch.
Covers all validator branches and error handling paths.
"""

from unittest.mock import patch

import pytest

from ws.protocols import (
    ClientMessage,
    AssistantMessage,
    SystemMessage,
    StopMessage,
    HeartbeatMessage,
    AudioControlMessage,
    AudioMessage,
    ContextResetMessage,
    validate_message,
)


# =========================================================================
# ClientMessage Validators
# =========================================================================


class TestClientMessageIdValidator:
    """Tests for ClientMessage.id field_validator."""

    def test_valid_id(self):
        """Accepts a well-formed id string."""
        with patch("ws.protocols._SANITIZATION_AVAILABLE", True), \
             patch("ws.protocols.sanitize_text", side_effect=lambda v, **kw: v):
            msg = ClientMessage(id="abc-123", content="Hello", role="user", type="message")
        assert msg.id == "abc-123"

    def test_empty_string_id_raises(self):
        """Line 111: empty string id raises ValueError."""
        with pytest.raises(ValueError, match="id field is required"):
            ClientMessage(id="", content="Hello", role="user", type="message")

    def test_whitespace_only_id_raises(self):
        """Line 111: whitespace-only id raises ValueError."""
        with pytest.raises(ValueError, match="id field is required"):
            ClientMessage(id="   ", content="Hello", role="user", type="message")


class TestClientMessageContentValidator:
    """Tests for ClientMessage.content field_validator."""

    def test_empty_content_raises(self):
        """Line 118: empty content raises ValueError."""
        with pytest.raises(ValueError, match="Content cannot be empty"):
            ClientMessage(id="abc", content="", role="user", type="message")

    def test_whitespace_only_content_raises(self):
        """Line 118: whitespace-only content raises ValueError."""
        with pytest.raises(ValueError, match="Content cannot be empty"):
            ClientMessage(id="abc", content="   ", role="user", type="message")

    def test_sanitization_unavailable_raises_import_error(self):
        """Line 121: ImportError raised when sanitization module is missing."""
        with patch("ws.protocols._SANITIZATION_AVAILABLE", False):
            with pytest.raises(ImportError, match="Sanitization module required"):
                ClientMessage(id="abc", content="Hello", role="user", type="message")

    def test_sanitize_text_value_error_propagates(self):
        """Lines 124-126: ValueError from sanitize_text propagates after logging."""
        with patch("ws.protocols._SANITIZATION_AVAILABLE", True), \
             patch("ws.protocols.sanitize_text", side_effect=ValueError("Bad input")):
            with pytest.raises(ValueError, match="Bad input"):
                ClientMessage(id="abc", content="Hello", role="user", type="message")

    def test_sanitize_text_type_error_propagates(self):
        """Lines 124-126: TypeError from sanitize_text propagates."""
        with patch("ws.protocols._SANITIZATION_AVAILABLE", True), \
             patch("ws.protocols.sanitize_text", side_effect=TypeError("Wrong type")):
            with pytest.raises(TypeError, match="Wrong type"):
                ClientMessage(id="abc", content="Hello", role="user", type="message")

    def test_sanitize_text_runtime_error_propagates(self):
        """Lines 124-126: RuntimeError from sanitize_text propagates."""
        with patch("ws.protocols._SANITIZATION_AVAILABLE", True), \
             patch("ws.protocols.sanitize_text", side_effect=RuntimeError("Engine fail")):
            with pytest.raises(RuntimeError, match="Engine fail"):
                ClientMessage(id="abc", content="Hello", role="user", type="message")


# =========================================================================
# validate_message Dispatch
# =========================================================================


class TestValidateMessageDispatch:
    """Tests for validate_message routing to correct model classes."""

    def test_stop_message_parsed(self):
        """Line 267: stop type dispatches to StopMessage."""
        result = validate_message({"type": "stop", "id": "r1"})
        assert isinstance(result, StopMessage)
        assert result.id == "r1"

    def test_cancel_message_parsed(self):
        """Line 267: cancel type dispatches to StopMessage."""
        result = validate_message({"type": "cancel"})
        assert isinstance(result, StopMessage)

    def test_context_reset_parsed(self):
        """Line 271: context_reset dispatches to ContextResetMessage."""
        result = validate_message({
            "type": "context_reset",
            "role": "user",
            "chat_id": "chat-123",
        })
        assert isinstance(result, ContextResetMessage)
        assert result.chat_id == "chat-123"

    def test_heartbeat_ping_parsed(self):
        """Line 275: ping type dispatches to HeartbeatMessage."""
        result = validate_message({"type": "ping", "timestamp": 12345})
        assert isinstance(result, HeartbeatMessage)
        assert result.timestamp == 12345

    def test_heartbeat_pong_parsed(self):
        """Line 275: pong type dispatches to HeartbeatMessage."""
        result = validate_message({"type": "pong"})
        assert isinstance(result, HeartbeatMessage)

    def test_audio_control_start_parsed(self):
        """Lines 279-280: audio control with start=True dispatches."""
        result = validate_message({"start": True})
        assert isinstance(result, AudioControlMessage)
        assert result.start is True

    def test_audio_control_end_parsed(self):
        """Lines 279-280: audio control with end=True dispatches."""
        result = validate_message({"end": True})
        assert isinstance(result, AudioControlMessage)
        assert result.end is True

    def test_audio_chunk_parsed(self):
        """Line 284: audio type dispatches to AudioMessage."""
        result = validate_message({
            "role": "user",
            "type": "audio",
            "audio": "base64data",
            "format": "pcm16",
        })
        assert isinstance(result, AudioMessage)
        assert result.audio == "base64data"

    def test_user_message_metadata_parsed(self):
        """User message metadata is accepted and preserved."""
        with patch("ws.protocols._SANITIZATION_AVAILABLE", True), \
             patch("ws.protocols.sanitize_text", side_effect=lambda v, **kw: v):
            result = validate_message({
                "role": "user",
                "type": "message",
                "id": "req-1",
                "content": "Hello",
                "metadata": {"source": "proactive", "context": {"k": "v"}},
            })
        assert isinstance(result, ClientMessage)
        assert result.metadata == {"source": "proactive", "context": {"k": "v"}}

    def test_assistant_message_parsed(self):
        """Line 293: assistant role dispatches to AssistantMessage."""
        result = validate_message({
            "role": "assistant",
            "type": "message",
            "content": "Hello",
        })
        assert isinstance(result, AssistantMessage)
        assert result.content == "Hello"

    def test_system_message_parsed(self):
        """Line 297: server role dispatches to SystemMessage."""
        result = validate_message({
            "role": "server",
            "type": "completion",
        })
        assert isinstance(result, SystemMessage)
        assert result.role == "server"
        assert result.type == "completion"

    def test_system_message_with_error(self):
        """Line 297: server error message dispatches correctly."""
        result = validate_message({
            "role": "server",
            "type": "error",
            "message": "Something went wrong",
        })
        assert isinstance(result, SystemMessage)
        assert result.message == "Something went wrong"


class TestValidateMessageErrorHandling:
    """Tests for validate_message exception handling."""

    def test_invalid_role_returns_none(self):
        """Line 300: unknown role/type returns None."""
        result = validate_message({"role": "unknown", "type": "unknown"})
        assert result is None

    def test_validation_error_returns_none(self):
        """Lines 302-305: ValueError during parsing returns None."""
        # ClientMessage with invalid content type triggers ValueError
        result = validate_message({
            "role": "user",
            "type": "message",
            "id": "abc",
            "content": "",  # Empty content fails validation
        })
        assert result is None

    def test_type_error_returns_none(self):
        """Lines 302-305: TypeError during parsing returns None."""
        class TypeErrorPayload(dict):
            def get(self, key, default=None):
                if key == "type":
                    raise TypeError("Injected TypeError")
                return super().get(key, default)

        result = validate_message(TypeErrorPayload({"role": "user"}))
        assert result is None

    def test_key_error_returns_none(self):
        """Lines 302-305: KeyError during parsing returns None."""
        # Simulate KeyError via a broken payload subclass
        class BadPayload(dict):
            def get(self, key, default=None):
                if key == "type":
                    raise KeyError("Injected KeyError")
                return super().get(key, default)

        result = validate_message(BadPayload({"role": "user"}))
        assert result is None

    def test_attribute_error_returns_none(self):
        """Lines 302-305: AttributeError during parsing returns None."""
        # A payload whose .get raises AttributeError
        class NoGetPayload(dict):
            def get(self, key, default=None):
                if key == "type":
                    raise AttributeError("No attribute")
                return super().get(key, default)

        result = validate_message(NoGetPayload({"role": "user"}))
        assert result is None


# =========================================================================
# Smoke tests for models not yet exercised
# =========================================================================


class TestModelSmoke:
    """Quick construction tests for models with indirect-only coverage."""

    def test_assistant_message_with_start_end(self):
        """AssistantMessage accepts start/end markers."""
        msg = AssistantMessage(
            role="assistant", type="message", start=True,
        )
        assert msg.start is True
        assert msg.end is None

    def test_system_message_with_data(self):
        """SystemMessage accepts data dict."""
        msg = SystemMessage(
            role="server", type="info", data={"key": "value"},
        )
        assert msg.data == {"key": "value"}

    def test_audio_message_defaults(self):
        """AudioMessage has correct defaults."""
        msg = AudioMessage(audio="base64data")
        assert msg.format == "pcm16"
        assert msg.sampleRate is None
        assert msg.end is None
