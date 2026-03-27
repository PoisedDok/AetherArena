"""
@.architecture

Incoming: application/presentation --- {str, UUID, Dict[str, Any], primitives}
Processing: trail hierarchy orchestration, sequence calculation, node lifecycle --- {5 jobs: JOB_ORCHESTRATE, JOB_VALIDATE, JOB_PERSISTENCE, JOB_CALCULATE, JOB_LOG}
Outgoing: application/presentation --- {Dict[str, Any], Optional[Dict], primitives}

Trail Coordinator - Trail hierarchy orchestration

Application service for trail hierarchy lifecycle.
Orchestrates group/subgroup/node creation, status updates, artifact linking.

Architecture:
- NO WebSocket emission (delegates to presentation emitters)
- Uses infrastructure persistence adapter
- Uses domain validators
- Coordinates multi-step DB operations

Contract:
- 1 group per user-agent turn with artifacts
- N subgroups per group (1 per code execution)
- 3 nodes per subgroup (writing → executing → output)
"""

from typing import Any, Dict, Optional
from uuid import UUID
import logging

logger = logging.getLogger(__name__)


def _utc_now_iso() -> str:
    """Get current UTC timestamp in ISO format."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


class TrailCoordinator:
    """
    Trail hierarchy lifecycle coordinator.
    
    Orchestrates trail creation without presentation concerns.
    Delegates to infrastructure and domain layers.
    """
    
    def __init__(
        self,
        *,
        trail_repository_adapter: Optional[Any] = None,
    ):
        """
        Initialize trail coordinator.
        
        Args:
            trail_repository_adapter: Infrastructure persistence adapter
        """
        self._trail_repo = trail_repository_adapter
        self._logger = logger
    
    async def create_hierarchy(
        self,
        *,
        chat_id: str,
        user_message: str,
        agent_message: str,
        execution_group: str,
        backend_id: str,
        frontend_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        user_message_id: Optional[UUID] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Create trail hierarchy (group → subgroup → 3 nodes).
        
        Args:
            chat_id: Chat identifier
            user_message: User message text (first 500 chars)
            agent_message: Agent message text (first 500 chars)
            execution_group: Execution group identifier
            backend_id: Backend request identifier
            frontend_id: Optional frontend identifier
            correlation_id: Optional correlation identifier
            user_message_id: Optional user message UUID (if not provided, finds most recent)
            
        Returns:
            Hierarchy data: group_id, subgroup_id, node IDs, sequence info
        """
        if not self._trail_repo:
            self._logger.debug("Trail repository unavailable, hierarchy disabled")
            return None
        
        try:
            # Calculate group sequence
            existing_groups = await self._trail_repo.get_groups_by_chat(UUID(chat_id))
            sequence_number = len(existing_groups) + 1
            
            # Use provided user_message_id or find most recent
            if not user_message_id:
                user_message_id = await self._find_recent_user_message(chat_id)
            
            # Create group
            group = await self._trail_repo.create_group(
                chat_id=UUID(chat_id),
                user_message=user_message,
                agent_message=agent_message,
                sequence_number=sequence_number,
                frontend_id=frontend_id,
                backend_id=backend_id,
                correlation_id=correlation_id,
                user_message_id=user_message_id,
            )
            group_id = str(group["id"])
            
            # Get timeline sequence atomically
            sequence_in_chat = await self._trail_repo.get_next_chat_sequence(chat_id)
            
            # Calculate subgroup sequence globally per chat
            subgroup_sequence_number = await self._calculate_subgroup_sequence(chat_id)
            
            # Create subgroup with 3 nodes
            subgroup, nodes = await self._trail_repo.create_subgroup_with_nodes(
                group_id=UUID(group_id),
                sequence_number=subgroup_sequence_number,
                sequence_in_chat=sequence_in_chat,
                execution_group=execution_group,
                status="running",
            )
            subgroup_id = str(subgroup["id"])
            
            # Extract node IDs (ordered: writing, executing, output)
            writing_node_id = str(nodes[0]["id"])
            executing_node_id = str(nodes[1]["id"])
            output_node_id = str(nodes[2]["id"])
            
            self._logger.info(
                f"Created trail hierarchy: group={group_id[:8]}, subgroup={subgroup_id[:8]}, nodes=3"
            )
            
            return {
                "chat_id": chat_id,
                "group_id": group_id,
                "subgroup_id": subgroup_id,
                "writing_node_id": writing_node_id,
                "executing_node_id": executing_node_id,
                "output_node_id": output_node_id,
                "sequence_number": sequence_number,
                "subgroup_sequence_number": subgroup["sequence_number"],
                "sequence_in_chat": sequence_in_chat,
                "backend_id": backend_id,
                "frontend_id": frontend_id,
                "correlation_id": correlation_id,
                "execution_group": execution_group,
            }
        
        except Exception as e:
            self._logger.error(
                "Failed to create trail hierarchy: %s",
                e,
                exc_info=True,
                extra={"chat_id": chat_id, "backend_id": backend_id},
            )
            return None
    
    async def create_subgroup(
        self,
        *,
        chat_id: str,
        group_id: str,
        execution_group: str,
        backend_id: str,
        frontend_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Create additional subgroup within existing group.
        
        Args:
            chat_id: Chat identifier
            group_id: Existing group UUID
            execution_group: Execution group identifier
            backend_id: Backend request identifier
            frontend_id: Optional frontend identifier
            
        Returns:
            Subgroup data: group_id, subgroup_id, node IDs, sequence info
        """
        if not self._trail_repo:
            return None
        
        try:
            # Calculate subgroup sequence globally per chat
            subgroup_sequence_number = await self._calculate_subgroup_sequence(chat_id)
            
            # Get timeline sequence atomically
            sequence_in_chat = await self._trail_repo.get_next_chat_sequence(chat_id)
            
            # Create subgroup with 3 nodes
            subgroup, nodes = await self._trail_repo.create_subgroup_with_nodes(
                group_id=UUID(group_id),
                sequence_number=subgroup_sequence_number,
                execution_group=execution_group,
                status="running",
                sequence_in_chat=sequence_in_chat,
            )
            subgroup_id = str(subgroup["id"])
            
            # Extract node IDs
            writing_node_id = str(nodes[0]["id"])
            executing_node_id = str(nodes[1]["id"])
            output_node_id = str(nodes[2]["id"])
            
            self._logger.info(
                f"Created subgroup: group={group_id[:8]}, subgroup={subgroup_id[:8]}, nodes=3"
            )
            
            return {
                "chat_id": chat_id,
                "group_id": group_id,
                "subgroup_id": subgroup_id,
                "writing_node_id": writing_node_id,
                "executing_node_id": executing_node_id,
                "output_node_id": output_node_id,
                "subgroup_sequence_number": subgroup["sequence_number"],
                "sequence_in_chat": sequence_in_chat,
                "backend_id": backend_id,
                "frontend_id": frontend_id,
                "execution_group": execution_group,
            }
        
        except Exception as e:
            self._logger.error("Failed to create subgroup: %s", e, exc_info=True)
            return None
    
    async def update_node_status(
        self,
        *,
        node_id: str,
        status: str,
    ) -> bool:
        """
        Update node status.
        
        Args:
            node_id: Node identifier
            status: New status (pending, active, completed)
            
        Returns:
            True if updated, False otherwise
        """
        if not self._trail_repo:
            return False
        
        try:
            await self._trail_repo.update_node_status(UUID(node_id), status)
            self._logger.debug("Updated node %s status to %s", node_id[:8], status)
            return True
        except Exception as e:
            self._logger.warning("Failed to update node status: %s", e)
            return False
    
    async def link_artifact_to_node(
        self,
        *,
        node_id: str,
        artifact_id: str,
        artifact_type: str,
    ) -> bool:
        """
        Link artifact to node (persist to database).
        
        Args:
            node_id: Node UUID
            artifact_id: Artifact identifier
            artifact_type: Artifact type (code, output, etc.)
            
        Returns:
            True if linked, False otherwise
        """
        if not self._trail_repo:
            return False
        
        try:
            await self._trail_repo.update_node(
                node_id=UUID(node_id),
                updates={
                    "artifact_id": artifact_id,
                    "artifact_type": artifact_type,
                },
            )
            self._logger.info(
                "Linked artifact to node: %s -> %s", artifact_id[:32], node_id[:8]
            )
            return True
        except Exception as e:
            self._logger.error(
                "Failed to link artifact to node %s: %s", node_id[:8], e,
                exc_info=True,
            )
            return False
    
    async def complete_hierarchy(
        self,
        *,
        subgroup_id: str,
        output_node_id: str,
    ) -> bool:
        """
        Complete trail hierarchy (mark subgroup and output node as completed).
        
        Args:
            subgroup_id: Subgroup identifier
            output_node_id: Output node identifier
            
        Returns:
            True if completed, False otherwise
        """
        if not self._trail_repo:
            return False
        
        try:
            # Complete output node
            await self._trail_repo.update_node_status(UUID(output_node_id), "completed")
            
            # Complete subgroup
            await self._trail_repo.update_subgroup(
                UUID(subgroup_id),
                {
                    "status": "completed",
                    "completed_at": _utc_now_iso(),
                },
            )
            
            self._logger.info("Completed hierarchy: subgroup=%s", subgroup_id[:8])
            return True
        
        except Exception as e:
            self._logger.warning("Failed to complete hierarchy: %s", e)
            return False
    
    # Private helpers
    
    async def _find_recent_user_message(self, chat_id: str) -> Optional[UUID]:
        """
        Find most recent user message in chat.
        
        Args:
            chat_id: Chat identifier
            
        Returns:
            User message UUID if found, None otherwise
        """
        try:
            return await self._trail_repo.find_recent_user_message(chat_id)
        except Exception as e:
            self._logger.warning("Could not find user message: %s", e)
            return None
    
    async def _calculate_subgroup_sequence(self, chat_id: str) -> int:
        """
        Calculate global subgroup sequence number per chat.
        
        Trail numbers increment across ALL groups in chat (Trail 1, 2, 3...).
        
        Args:
            chat_id: Chat identifier
            
        Returns:
            Next subgroup sequence number
        """
        all_groups = await self._trail_repo.get_groups_by_chat(UUID(chat_id))
        total_subgroups = 0
        
        for group in all_groups:
            subgroups = await self._trail_repo.get_subgroups_by_group(
                UUID(str(group["id"]))
            )
            total_subgroups += len(subgroups)
        
        return total_subgroups + 1

