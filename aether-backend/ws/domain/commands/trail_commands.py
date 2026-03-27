"""
@.architecture
Incoming: none (pure data structures)
Processing: none (DTOs only)
Outgoing: application → presentation

Trail Commands - Command DTOs for trail event emission

Pure data structures, NO logic.
Orchestrator returns these, presentation executes them.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class TrailCommand:
    """Base class for trail commands."""
    pass


@dataclass(frozen=True)
class EmitGroupCreated(TrailCommand):
    """
    Command to emit trail.group_created event.
    
    Attributes:
        group_id: Group UUID
        chat_id: Chat UUID
        sequence_number: Group sequence number
        backend_id: Backend request identifier
        frontend_id: Optional frontend identifier
        correlation_id: Optional correlation identifier
    """
    group_id: str
    chat_id: str
    sequence_number: int
    backend_id: str
    frontend_id: Optional[str] = None
    correlation_id: Optional[str] = None


@dataclass(frozen=True)
class EmitSubgroupCreated(TrailCommand):
    """
    Command to emit trail.subgroup_created event.
    
    Attributes:
        chat_id: Chat UUID
        subgroup_id: Subgroup UUID
        group_id: Group UUID
        execution_group: Execution group identifier
        writing_node_id: Writing node UUID
        executing_node_id: Executing node UUID
        output_node_id: Output node UUID
        backend_id: Backend request identifier
        subgroup_sequence_number: Subgroup sequence number
        sequence_in_chat: Timeline position
        frontend_id: Optional frontend identifier
    """
    chat_id: str
    subgroup_id: str
    group_id: str
    execution_group: str
    writing_node_id: str
    executing_node_id: str
    output_node_id: str
    backend_id: str
    subgroup_sequence_number: int
    sequence_in_chat: int
    frontend_id: Optional[str] = None
    correlation_id: Optional[str] = None


@dataclass(frozen=True)
class EmitAgentMessageSequence(TrailCommand):
    """
    Command to emit trail.agent_message_sequence event.
    
    Reserved sequence for the assistant message container.
    
    Attributes:
        chat_id: Chat UUID
        sequence_in_chat: Timeline sequence number
        backend_id: Backend request identifier
    """
    chat_id: str
    sequence_in_chat: int
    backend_id: str


@dataclass(frozen=True)
class EmitAssistantMessageFlushed(TrailCommand):
    """
    Command to emit assistant.message_flushed event.
    
    Instructs frontend to flush accumulated assistant text into a positioned
    message element with the given sequence number.
    
    Attributes:
        chat_id: Chat UUID
        sequence_in_chat: Timeline sequence number
        content: Message content
        message_id: Optional message UUID from database
    """
    chat_id: str
    sequence_in_chat: int
    content: str
    message_id: Optional[str] = None


@dataclass(frozen=True)
class EmitNodeStatusUpdated(TrailCommand):
    """
    Command to emit trail.node_status_updated event.
    
    Attributes:
        chat_id: Chat UUID
        group_id: Group UUID
        node_id: Node UUID
        status: Node status (pending, active, completed)
        subgroup_id: Subgroup UUID
    """
    chat_id: str
    group_id: str
    node_id: str
    status: str
    subgroup_id: str


@dataclass(frozen=True)
class EmitArtifactLinked(TrailCommand):
    """
    Command to emit trail.artifact_linked event.
    
    Attributes:
        chat_id: Chat UUID
        group_id: Group UUID
        artifact_id: Artifact identifier
        subgroup_id: Subgroup UUID
        node_id: Node UUID
        artifact_type: Artifact type (code, output)
        backend_id: Backend request identifier
    """
    chat_id: str
    group_id: str
    artifact_id: str
    subgroup_id: str
    node_id: str
    artifact_type: str
    backend_id: str


@dataclass(frozen=True)
class EmitSubgroupCompleted(TrailCommand):
    """
    Command to emit trail.subgroup_completed event.
    
    Attributes:
        chat_id: Chat UUID
        group_id: Group UUID
        subgroup_id: Subgroup UUID
    """
    chat_id: str
    group_id: str
    subgroup_id: str

