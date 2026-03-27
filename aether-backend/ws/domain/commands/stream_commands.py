"""
@.architecture
Incoming: none (pure data structures)
Processing: none (DTOs only)
Outgoing: application → presentation

Stream Commands - Command DTOs for stream event emission

Pure data structures, NO logic.
Orchestrator returns these, presentation executes them.
"""

from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class StreamCommand:
    """Base class for stream commands."""
    pass


@dataclass(frozen=True)
class EmitStreamEvent(StreamCommand):
    """
    Command to emit stream event (start, delta, artifact chunk).
    
    Attributes:
        event: Pre-enriched event payload
    """
    event: Dict[str, Any]


@dataclass(frozen=True)
class EmitStreamEnd(StreamCommand):
    """
    Command to emit end marker.
    
    Attributes:
        end_message: Pre-enriched end marker
    """
    end_message: Dict[str, Any]


@dataclass(frozen=True)
class EmitStreamCompletion(StreamCommand):
    """
    Command to emit completion signal.
    
    Attributes:
        completion_message: Pre-enriched completion message
    """
    completion_message: Dict[str, Any]


@dataclass(frozen=True)
class EmitStreamStop(StreamCommand):
    """
    Command to emit stop notification (user cancellation).
    
    Attributes:
        request_id: Request identifier
        correlation_id: Optional correlation ID
        chat_id: Optional chat ID
    """
    request_id: str
    correlation_id: Optional[str] = None
    chat_id: Optional[str] = None


@dataclass(frozen=True)
class EmitStreamError(StreamCommand):
    """
    Command to emit error notification.
    
    Attributes:
        request_id: Request identifier
        correlation_id: Optional correlation ID
        chat_id: Optional chat ID
    """
    request_id: str
    correlation_id: Optional[str] = None
    chat_id: Optional[str] = None


@dataclass(frozen=True)
class EmitControlEvent(StreamCommand):
    """
    Command to emit control event (user.message_persisted, etc).
    
    Attributes:
        event: Pre-enriched control event payload
    """
    event: Dict[str, Any]

