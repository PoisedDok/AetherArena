"""
@.architecture
Incoming: none --- {Dict[str, Any], dict}
Processing: validate message structure, check required fields, enforce business rules --- {1 job: JOB_VALIDATE_SCHEMA}
Outgoing: none --- {bool, ValidationError}

Message Validator - Pure message validation logic

Pure domain logic for validating WebSocket messages.
NO I/O, NO external dependencies, framework-agnostic.

Features:
- Required field validation
- Message type validation
- Content validation rules
- User message format validation
"""

from typing import Any, Dict


class ValidationError(Exception):
    """Domain validation error."""
    pass


def validate_required_field(
    message: Dict[str, Any],
    field_name: str,
) -> None:
    """
    Validate that required field exists and is not empty.
    
    Args:
        message: Message dict to validate
        field_name: Name of required field
        
    Raises:
        ValidationError: If field missing or empty
    """
    if field_name not in message:
        raise ValidationError(f"Missing required field: {field_name}")
    
    value = message[field_name]
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ValidationError(f"Field '{field_name}' cannot be empty")


def validate_message_type(message_type: str) -> None:
    """
    Validate message type is recognized.
    
    Args:
        message_type: Message type to validate
        
    Raises:
        ValidationError: If type is invalid
    """
    valid_types = {
        "user_message",
        "stop",
        "cancel",
        "audio_start",
        "audio_end",
        "context_reset",
        "heartbeat",
        "ping",
        "pong",
    }
    
    if message_type not in valid_types:
        raise ValidationError(f"Invalid message type: {message_type}")


def validate_user_message(message: Dict[str, Any]) -> None:
    """
    Validate user message structure and content.
    
    Args:
        message: User message dict
        
    Raises:
        ValidationError: If validation fails
    """
    validate_required_field(message, "type")
    validate_required_field(message, "content")
    
    # Content must be string
    content = message.get("content")
    if not isinstance(content, str):
        raise ValidationError("Message content must be a string")
    
    # Content must not be empty after stripping
    if not content.strip():
        raise ValidationError("Message content cannot be empty")


def validate_control_message(message: Dict[str, Any]) -> None:
    """
    Validate control message structure.
    
    Args:
        message: Control message dict (stop, cancel, etc.)
        
    Raises:
        ValidationError: If validation fails
    """
    validate_required_field(message, "type")
    
    # For stop/cancel, request_id is required
    message_type = message.get("type", "")
    if message_type in ("stop", "cancel"):
        validate_required_field(message, "request_id")

