"""
@.architecture
Incoming: application --- {str, Dict[str, Any], primitives}
Processing: WebSocket emission, JSON serialization, timeout handling --- {3 jobs: JOB_SERIALIZE, JOB_EXTERNAL_CALL, JOB_LOG}
Outgoing: WebSocket --- {str, json}

Trail Emitter - Trail hierarchy event emission

Presentation layer emitter for trail WebSocket events.
NO business logic, pure emission with error recovery.

Events:
- trail.group_created
- trail.subgroup_created
- trail.node_status_updated
- trail.artifact_linked
- trail.subgroup_completed
"""

import asyncio
import json
from typing import Any, Dict, Optional
from fastapi import WebSocket
import logging

from ws.protocols import MessageRole, WS_SEND_TIMEOUT

logger = logging.getLogger(__name__)


class TrailEmitter:
    """
    Trail hierarchy event emitter.
    
    Emits trail events to WebSocket with timeout protection.
    """
    
    def __init__(self, timeout: float = WS_SEND_TIMEOUT):
        """
        Initialize trail emitter.
        
        Args:
            timeout: Send timeout in seconds (default WS_SEND_TIMEOUT)
        """
        self._timeout = timeout
        self._logger = logger
    
    async def emit_group_created(
        self,
        *,
        ws: WebSocket,
        group_id: str,
        chat_id: str,
        sequence_number: int,
        backend_id: str,
        frontend_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> None:
        """
        Emit group_created event.
        
        Args:
            ws: WebSocket connection
            group_id: Group UUID
            chat_id: Chat UUID
            sequence_number: Group sequence number
            backend_id: Backend request identifier
            frontend_id: Optional frontend identifier
            correlation_id: Optional correlation identifier
        """
        event = {
            "role": MessageRole.SERVER,
            "type": "trail.group_created",
            "group_id": group_id,
            "chat_id": chat_id,
            "sequence_number": sequence_number,
            "backend_id": backend_id,
            "frontend_id": frontend_id,
            "correlation_id": correlation_id,
        }
        
        await self._send_event(ws, event, "group_created")
    
    async def emit_subgroup_created(
        self,
        *,
        ws: WebSocket,
        chat_id: str,
        subgroup_id: str,
        group_id: str,
        execution_group: str,
        writing_node_id: str,
        executing_node_id: str,
        output_node_id: str,
        backend_id: str,
        subgroup_sequence_number: int,
        sequence_in_chat: int,
        frontend_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> None:
        """
        Emit subgroup_created event with node definitions.
        
        Args:
            ws: WebSocket connection
            chat_id: Chat UUID
            subgroup_id: Subgroup UUID
            group_id: Group UUID
            execution_group: Execution group identifier
            writing_node_id: Writing node UUID
            executing_node_id: Executing node UUID
            output_node_id: Output node UUID
            backend_id: Backend request identifier
            subgroup_sequence_number: Subgroup sequence number
            sequence_in_chat: Timeline position for DOM ordering
            frontend_id: Optional frontend identifier
        """
        event = {
            "role": MessageRole.SERVER,
            "type": "trail.subgroup_created",
            "chat_id": chat_id,
            "subgroup_id": subgroup_id,
            "group_id": group_id,
            "sequence_number": subgroup_sequence_number,
            "subgroup_sequence": subgroup_sequence_number,  # Alias for frontend
            "sequence_in_chat": sequence_in_chat,
            "execution_group": execution_group,
            "nodes": [
                {
                    "node_id": writing_node_id,
                    "type": "writing",
                    "sequence": 1,
                    "clickable": True,
                    "status": "pending",
                },
                {
                    "node_id": executing_node_id,
                    "type": "executing",
                    "sequence": 2,
                    "clickable": False,
                    "status": "pending",
                },
                {
                    "node_id": output_node_id,
                    "type": "output",
                    "sequence": 3,
                    "clickable": True,
                    "status": "pending",
                },
            ],
            "backend_id": backend_id,
            "frontend_id": frontend_id,
            "correlation_id": correlation_id,
        }
        
        await self._send_event(ws, event, "subgroup_created")
    
    async def emit_node_status_updated(
        self,
        *,
        ws: WebSocket,
        chat_id: str,
        group_id: str,
        node_id: str,
        status: str,
        subgroup_id: str,
    ) -> None:
        """
        Emit node_status_updated event.
        
        Args:
            ws: WebSocket connection
            chat_id: Chat UUID
            group_id: Group UUID
            node_id: Node UUID
            status: Node status (pending, active, completed)
            subgroup_id: Subgroup UUID
        """
        event = {
            "role": MessageRole.SERVER,
            "type": "trail.node_status_updated",
            "chat_id": chat_id,
            "group_id": group_id,
            "node_id": node_id,
            "status": status,
            "subgroup_id": subgroup_id,
        }
        
        await self._send_event(ws, event, "node_status_updated")
    
    async def emit_artifact_linked(
        self,
        *,
        ws: WebSocket,
        chat_id: str,
        group_id: str,
        artifact_id: str,
        subgroup_id: str,
        node_id: str,
        artifact_type: str,
        backend_id: str,
    ) -> None:
        """
        Emit artifact_linked event.
        
        Args:
            ws: WebSocket connection
            chat_id: Chat UUID
            group_id: Group UUID
            artifact_id: Artifact identifier
            subgroup_id: Subgroup UUID
            node_id: Node UUID
            artifact_type: Artifact type (code, output, etc.)
            backend_id: Backend request identifier
        """
        event = {
            "role": MessageRole.SERVER,
            "type": "trail.artifact_linked",
            "chat_id": chat_id,
            "group_id": group_id,
            "artifact_id": artifact_id,
            "subgroup_id": subgroup_id,
            "node_id": node_id,
            "artifact_type": artifact_type,
            "backend_id": backend_id,
        }
        
        await self._send_event(ws, event, "artifact_linked")
    
    async def emit_subgroup_completed(
        self,
        *,
        ws: WebSocket,
        chat_id: str,
        group_id: str,
        subgroup_id: str,
    ) -> None:
        """
        Emit subgroup_completed event.
        
        Args:
            ws: WebSocket connection
            chat_id: Chat UUID
            group_id: Group UUID
            subgroup_id: Subgroup UUID
        """
        event = {
            "role": MessageRole.SERVER,
            "type": "trail.subgroup_completed",
            "chat_id": chat_id,
            "group_id": group_id,
            "subgroup_id": subgroup_id,
            "status": "completed",
        }
        
        await self._send_event(ws, event, "subgroup_completed")
    
    async def emit_agent_message_sequence(
        self,
        *,
        ws: WebSocket,
        chat_id: str,
        sequence_in_chat: int,
        backend_id: str,
    ) -> None:
        """
        Emit trail.agent_message_sequence event.
        
        Args:
            ws: WebSocket connection
            chat_id: Chat UUID
            sequence_in_chat: Timeline sequence number
            backend_id: Backend request identifier
        """
        event = {
            "role": MessageRole.SERVER,
            "type": "trail.agent_message_sequence",
            "chat_id": chat_id,
            "sequence_in_chat": sequence_in_chat,
            "backend_id": backend_id,
        }
        
        await self._send_event(ws, event, "agent_message_sequence")
    
    async def emit_assistant_message_flushed(
        self,
        *,
        ws: WebSocket,
        chat_id: str,
        sequence_in_chat: int,
        content: str,
        message_id: Optional[str] = None,
    ) -> None:
        """
        Emit assistant.message_flushed event.
        
        Instructs frontend to flush accumulated assistant text into a positioned
        message element with the given sequence number.
        
        Args:
            ws: WebSocket connection
            chat_id: Chat UUID
            sequence_in_chat: Timeline sequence number
            content: Message content
            message_id: Optional message UUID from database
        """
        event = {
            "role": MessageRole.ASSISTANT,
            "type": "assistant.message_flushed",
            "chat_id": chat_id,
            "sequence_in_chat": sequence_in_chat,
            "content": content,
            "message_id": message_id,
        }
        
        await self._send_event(ws, event, "assistant_message_flushed")
    
    # Private helper
    
    async def _send_event(
        self,
        ws: WebSocket,
        event: Dict[str, Any],
        event_name: str,
    ) -> None:
        """
        Internal: Send event with timeout and error recovery.
        
        Args:
            ws: WebSocket connection
            event: Event payload
            event_name: Event name for logging
        """
        try:
            await asyncio.wait_for(
                ws.send_text(json.dumps(event)),
                timeout=self._timeout,
            )
        except asyncio.TimeoutError:
            self._logger.warning("Timeout emitting %s event", event_name)
        except Exception as e:
            self._logger.warning("Failed to emit %s event: %s", event_name, e)

