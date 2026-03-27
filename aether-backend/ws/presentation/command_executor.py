"""
@.architecture
Incoming: application (command list) --- {List[Command], dataclasses}
Processing: command execution, WebSocket emission coordination --- {2 jobs: JOB_ROUTE_BY_TYPE, JOB_EXTERNAL_CALL}
Outgoing: WebSocket (via emitters) --- {str, json}

Command Executor - Executes commands from orchestrator

Presentation layer component.
Receives commands from application layer, executes via emitters.
NO business logic, pure command execution.

Architecture:
- Receives List[Command] from orchestrator
- Dispatches to appropriate emitter based on command type
- Handles WebSocket at presentation layer only
"""

import logging
from typing import List, Union
from dataclasses import asdict
from fastapi import WebSocket

from ws.domain.commands import (
    EmitStreamEvent,
    EmitStreamEnd,
    EmitStreamCompletion,
    EmitStreamStop,
    EmitStreamError,
    EmitControlEvent,
    EmitGroupCreated,
    EmitSubgroupCreated,
    EmitNodeStatusUpdated,
    EmitArtifactLinked,
    EmitSubgroupCompleted,
    EmitAssistantMessageFlushed,
    EmitAgentMessageSequence,
)
from ws.domain.commands.audio_commands import (
    EmitTTSAudio,
    EmitTTSQueued,
    EmitTTSCompleted,
    EmitSleepWordDetected,
    EmitTTSError,
)

logger = logging.getLogger(__name__)

# Type alias
Command = Union[
    EmitStreamEvent,
    EmitStreamEnd,
    EmitStreamCompletion,
    EmitStreamStop,
    EmitStreamError,
    EmitControlEvent,
    EmitGroupCreated,
    EmitSubgroupCreated,
    EmitNodeStatusUpdated,
    EmitArtifactLinked,
    EmitSubgroupCompleted,
    EmitAssistantMessageFlushed,
    EmitAgentMessageSequence,
    # Audio commands (handsfree TTS)
    EmitTTSAudio,
    EmitTTSQueued,
    EmitTTSCompleted,
    EmitSleepWordDetected,
    EmitTTSError,
]


class CommandExecutor:
    """
    Command executor for WebSocket emissions.
    
    Receives commands from application layer, executes via emitters.
    NO business logic - pure command dispatch.
    """
    
    def __init__(
        self,
        *,
        stream_emitter: any,
        trail_emitter: any,
    ):
        """
        Initialize command executor.
        
        Args:
            stream_emitter: Stream event emitter
            trail_emitter: Trail event emitter
        """
        self._stream_emitter = stream_emitter
        self._trail_emitter = trail_emitter
        self._logger = logger
    
    async def execute(
        self,
        ws: WebSocket,
        commands: Union[Command, List[Command]],
    ) -> None:
        """
        Execute command(s).
        
        Args:
            ws: WebSocket connection
            commands: Single command or list of commands to execute
        """
        # Normalize to list
        if not isinstance(commands, list):
            commands = [commands]
        
        for cmd in commands:
            await self._execute_single(ws, cmd)
    
    async def _execute_single(
        self,
        ws: WebSocket,
        cmd: Command,
    ) -> None:
        """Execute single command."""
        # Stream commands
        if isinstance(cmd, EmitStreamEvent):
            await self._stream_emitter.emit_event(ws, cmd.event)
        
        elif isinstance(cmd, EmitStreamEnd):
            await self._stream_emitter.emit_end(ws, cmd.end_message)
        
        elif isinstance(cmd, EmitStreamCompletion):
            await self._stream_emitter.emit_completion(ws, cmd.completion_message)
        
        elif isinstance(cmd, EmitStreamStop):
            await self._stream_emitter.emit_stop(
                ws,
                cmd.request_id,
                cmd.correlation_id,
                cmd.chat_id,
            )
        
        elif isinstance(cmd, EmitStreamError):
            await self._stream_emitter.emit_error(
                ws,
                cmd.request_id,
                cmd.correlation_id,
                cmd.chat_id,
            )
        
        elif isinstance(cmd, EmitControlEvent):
            await self._stream_emitter.emit_event(ws, cmd.event)
        
        # Trail commands
        elif isinstance(cmd, EmitGroupCreated):
            await self._trail_emitter.emit_group_created(
                ws=ws,
                **asdict(cmd),
            )
        
        elif isinstance(cmd, EmitSubgroupCreated):
            await self._trail_emitter.emit_subgroup_created(
                ws=ws,
                **asdict(cmd),
            )
        
        elif isinstance(cmd, EmitNodeStatusUpdated):
            await self._trail_emitter.emit_node_status_updated(
                ws=ws,
                **asdict(cmd),
            )
        
        elif isinstance(cmd, EmitArtifactLinked):
            await self._trail_emitter.emit_artifact_linked(
                ws=ws,
                **asdict(cmd),
            )
        
        elif isinstance(cmd, EmitSubgroupCompleted):
            await self._trail_emitter.emit_subgroup_completed(
                ws=ws,
                **asdict(cmd),
            )
        
        elif isinstance(cmd, EmitAssistantMessageFlushed):
            await self._trail_emitter.emit_assistant_message_flushed(
                ws=ws,
                **asdict(cmd),
            )
        
        elif isinstance(cmd, EmitAgentMessageSequence):
            await self._trail_emitter.emit_agent_message_sequence(
                ws=ws,
                **asdict(cmd),
            )
        
        # Audio commands (handsfree TTS)
        elif isinstance(cmd, EmitTTSAudio):
            await ws.send_json({
                'role': 'assistant',  # REQUIRED by frontend validation
                'type': 'tts-audio',
                'audio': cmd.audio_data,
                'format': cmd.format,
                'sample_rate': cmd.sample_rate,
                'chat_id': cmd.chat_id,  # REQUIRED by ArtifactsStreamOrchestrator contract
            })
        
        elif isinstance(cmd, EmitTTSQueued):
            await ws.send_json({
                'role': 'assistant',  # REQUIRED by frontend validation
                'type': 'tts-queued',
                'client_id': cmd.client_id,
                'chat_id': cmd.chat_id,  # REQUIRED by ArtifactsStreamOrchestrator contract
            })
        
        elif isinstance(cmd, EmitTTSCompleted):
            await ws.send_json({
                'role': 'assistant',  # REQUIRED by frontend validation
                'type': 'tts-completed',
                'client_id': cmd.client_id,
                'chat_id': cmd.chat_id,  # REQUIRED by ArtifactsStreamOrchestrator contract
            })
        
        elif isinstance(cmd, EmitSleepWordDetected):
            await ws.send_json({
                'role': 'assistant',  # REQUIRED by frontend validation
                'type': 'sleep-word-detected',
                'client_id': cmd.client_id,
                'text': cmd.text,
                'chat_id': cmd.chat_id,  # REQUIRED by ArtifactsStreamOrchestrator contract
            })
        
        elif isinstance(cmd, EmitTTSError):
            await ws.send_json({
                'role': 'assistant',  # REQUIRED by frontend validation
                'type': 'tts-error',
                'client_id': cmd.client_id,
                'error_type': cmd.error_type,
                'message': cmd.message,
                'chat_id': cmd.chat_id,  # REQUIRED by ArtifactsStreamOrchestrator contract
            })
        
        else:
            self._logger.warning("Unknown command type: %s", type(cmd))

