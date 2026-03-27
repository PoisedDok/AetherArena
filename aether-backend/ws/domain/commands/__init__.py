"""
Domain Commands - Pure data structures for orchestrator → presentation communication

Architecture:
- NO logic, pure DTOs
- NO I/O, NO external dependencies
- Orchestrators return these
- Presentation executes them
"""

from .stream_commands import (
    StreamCommand,
    EmitStreamEvent,
    EmitStreamEnd,
    EmitStreamCompletion,
    EmitStreamStop,
    EmitStreamError,
    EmitControlEvent,
)

from .trail_commands import (
    TrailCommand,
    EmitGroupCreated,
    EmitSubgroupCreated,
    EmitNodeStatusUpdated,
    EmitArtifactLinked,
    EmitSubgroupCompleted,
    EmitAssistantMessageFlushed,
    EmitAgentMessageSequence,
)

__all__ = [
    # Stream commands
    "StreamCommand",
    "EmitStreamEvent",
    "EmitStreamEnd",
    "EmitStreamCompletion",
    "EmitStreamStop",
    "EmitStreamError",
    "EmitControlEvent",
    # Trail commands
    "TrailCommand",
    "EmitGroupCreated",
    "EmitSubgroupCreated",
    "EmitNodeStatusUpdated",
    "EmitArtifactLinked",
    "EmitSubgroupCompleted",
    "EmitAssistantMessageFlushed",
    "EmitAgentMessageSequence",
]

