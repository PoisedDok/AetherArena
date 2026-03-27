"""
@.architecture
Incoming: application --- {UUID, str, Dict[str, Any], primitives}
Processing: database operations, error translation, Supabase abstraction --- {3 jobs: JOB_EXTERNAL_CALL, JOB_TRANSFORM_DATA, JOB_LOG}
Outgoing: application --- {Dict[str, Any], List[Dict], primitives}

Trail Repository Adapter - Clean database persistence interface

Infrastructure adapter wrapping TrailRepository.
Hides Supabase implementation details, provides clean interface.

Features:
- Group/subgroup/node CRUD operations
- Sequence number calculation
- Error translation to domain exceptions
- NO business logic
"""

from typing import Any, Dict, List, Optional
from uuid import UUID
import logging

logger = logging.getLogger(__name__)


class TrailRepositoryAdapter:
    """
    Clean adapter for trail persistence operations.
    
    Wraps TrailRepository and hides Supabase details.
    """
    
    def __init__(self, trail_repository: Optional[Any] = None):
        """
        Initialize adapter.
        
        Args:
            trail_repository: TrailRepository instance
        """
        self._repo = trail_repository
        self._logger = logger
    
    def is_available(self) -> bool:
        """
        Check if persistence is available.
        
        Returns:
            True if repository configured, False otherwise
        """
        return self._repo is not None
    
    @property
    def db(self):
        """
        Expose underlying DB for complex queries.
        
        NOTE: This is a temporary bridge until all queries are properly abstracted.
        Coordinator should NOT access this directly.
        """
        return self._repo.db if self._repo else None
    
    async def find_recent_user_message(self, chat_id: str) -> Optional[UUID]:
        """
        Find most recent user message in chat.
        
        Args:
            chat_id: Chat identifier
            
        Returns:
            User message UUID if found, None otherwise
        """
        if not self._repo or not self._repo.db:
            return None
        
        try:
            user_messages = await self._repo.db.select(
                "messages",
                filters={"chat_id": chat_id, "role": "user"},
                order_by="timestamp.desc",
                limit=1,
                admin=True,
            )
            
            if user_messages:
                return UUID(user_messages[0]["id"])
            
            return None
        except Exception as e:
            self._logger.warning("Could not find user message: %s", e)
            return None
    
    async def get_group_by_user_message_id(self, user_message_id: UUID) -> Optional[Dict[str, Any]]:
        """
        Find group by user_message_id.
        
        Args:
            user_message_id: User message UUID
            
        Returns:
            Group dict if found, None otherwise
        """
        if not self._repo or not self._repo.db:
            return None
        
        try:
            groups = await self._repo.db.select(
                "groups",
                filters={"user_message_id": str(user_message_id)},
                limit=1,
                admin=True,
            )
            
            if groups:
                return groups[0]
            
            return None
        except Exception as e:
            self._logger.warning("Could not find group by user_message_id: %s", e)
            return None
    
    async def create_group(
        self,
        chat_id: UUID,
        user_message: str,
        agent_message: str,
        sequence_number: int,
        frontend_id: Optional[str] = None,
        backend_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        user_message_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """
        Create trail group.
        
        Args:
            chat_id: Chat UUID
            user_message: User message content
            agent_message: Agent message content
            sequence_number: Group sequence in chat
            frontend_id: Optional frontend ID
            backend_id: Optional backend ID
            correlation_id: Optional correlation ID
            user_message_id: Optional user message UUID
            
        Returns:
            Created group dict
            
        Raises:
            RuntimeError: If creation fails
        """
        if not self._repo:
            raise RuntimeError("Trail repository not available")
        
        try:
            group = await self._repo.create_group(
                chat_id=chat_id,
                user_message=user_message,
                agent_message=agent_message,
                sequence_number=sequence_number,
                frontend_id=frontend_id,
                backend_id=backend_id,
                correlation_id=correlation_id,
                user_message_id=user_message_id,
            )
            return group
        except Exception as e:
            self._logger.error("Failed to create group: %s", e, exc_info=True)
            raise RuntimeError(f"Group creation failed: {e}")
    
    async def create_subgroup_with_nodes(
        self,
        group_id: UUID,
        sequence_number: int,
        sequence_in_chat: int,
        execution_group: str,
        status: str = "running",
    ) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """
        Create subgroup with 3 nodes.
        
        Args:
            group_id: Parent group UUID
            sequence_number: Subgroup sequence
            sequence_in_chat: Timeline sequence
            execution_group: Execution group ID
            status: Initial status (default "running")
            
        Returns:
            Tuple of (subgroup_dict, nodes_list)
            
        Raises:
            RuntimeError: If creation fails
        """
        if not self._repo:
            raise RuntimeError("Trail repository not available")
        
        try:
            subgroup, nodes = await self._repo.create_subgroup_with_nodes(
                group_id=group_id,
                sequence_number=sequence_number,
                sequence_in_chat=sequence_in_chat,
                execution_group=execution_group,
                status=status,
            )
            return (subgroup, nodes)
        except Exception as e:
            self._logger.error("Failed to create subgroup: %s", e, exc_info=True)
            raise RuntimeError(f"Subgroup creation failed: {e}")
    
    async def get_groups_by_chat(self, chat_id: UUID) -> List[Dict[str, Any]]:
        """
        Get all groups for a chat.
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            List of group dicts
        """
        if not self._repo:
            return []
        
        try:
            groups = await self._repo.get_groups_by_chat(chat_id)
            return groups
        except Exception as e:
            self._logger.warning("Failed to fetch groups: %s", e)
            return []
    
    async def get_subgroups_by_group(self, group_id: UUID) -> List[Dict[str, Any]]:
        """
        Get all subgroups for a group.
        
        Args:
            group_id: Group UUID
            
        Returns:
            List of subgroup dicts
        """
        if not self._repo:
            return []
        
        try:
            subgroups = await self._repo.get_subgroups_by_group(group_id)
            return subgroups
        except Exception as e:
            self._logger.warning("Failed to fetch subgroups: %s", e)
            return []
    
    async def get_next_chat_sequence(self, chat_id: str) -> int:
        """
        Get next timeline sequence for chat.
        
        Args:
            chat_id: Chat ID string
            
        Returns:
            Next sequence number
            
        Raises:
            RuntimeError: If sequence fetch fails
        """
        if not self._repo:
            raise RuntimeError("Trail repository not available")
        
        try:
            sequence = await self._repo.db.rpc(
                'get_next_chat_sequence',
                {'p_chat_id': chat_id},
                admin=True
            )
            return sequence
        except Exception as e:
            self._logger.error("Failed to get chat sequence: %s", e, exc_info=True)
            raise RuntimeError(f"Sequence fetch failed: {e}")
    
    async def update_node_status(
        self,
        node_id: UUID,
        status: str,
    ) -> Dict[str, Any]:
        """
        Update node status (pending → active → completed).
        
        Args:
            node_id: Node UUID
            status: New status (pending, active, completed, error)
            
        Returns:
            Updated node dict
            
        Raises:
            RuntimeError: If update fails
        """
        if not self._repo:
            raise RuntimeError("Trail repository not available")
        
        try:
            updated = await self._repo.update_node_status(node_id, status)
            return updated
        except Exception as e:
            self._logger.error("Failed to update node status: %s", e, exc_info=True)
            raise RuntimeError(f"Node status update failed: {e}")
    
    async def update_node(
        self,
        node_id: UUID,
        updates: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Update node fields (artifact_id, artifact_type, etc.).
        
        Args:
            node_id: Node UUID
            updates: Fields to update
            
        Returns:
            Updated node dict
            
        Raises:
            RuntimeError: If update fails
        """
        if not self._repo:
            raise RuntimeError("Trail repository not available")
        
        try:
            updated = await self._repo.update_node(node_id, updates)
            return updated
        except Exception as e:
            self._logger.error("Failed to update node: %s", e, exc_info=True)
            raise RuntimeError(f"Node update failed: {e}")
    
    async def update_subgroup(
        self,
        subgroup_id: UUID,
        updates: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Update subgroup fields (status, completed_at, etc.).
        
        Args:
            subgroup_id: Subgroup UUID
            updates: Fields to update
            
        Returns:
            Updated subgroup dict
            
        Raises:
            RuntimeError: If update fails
        """
        if not self._repo:
            raise RuntimeError("Trail repository not available")
        
        try:
            updated = await self._repo.update_subgroup(subgroup_id, updates)
            return updated
        except Exception as e:
            self._logger.error("Failed to update subgroup: %s", e, exc_info=True)
            raise RuntimeError(f"Subgroup update failed: {e}")
    
    async def get_trail_hierarchy(
        self,
        chat_id: UUID,
    ) -> List[Dict[str, Any]]:
        """
        Get complete trail hierarchy for a chat.
        
        Returns groups with nested subgroups and nodes.
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            List of group records with subgroups and nodes nested
            
        Raises:
            RuntimeError: If fetch fails
        """
        if not self._repo:
            raise RuntimeError("Trail repository not available")
        
        try:
            hierarchy = await self._repo.get_trail_hierarchy(chat_id)
            return hierarchy
        except Exception as e:
            self._logger.error("Failed to get trail hierarchy: %s", e, exc_info=True)
            raise RuntimeError(f"Trail hierarchy fetch failed: {e}")

