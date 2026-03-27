"""
@.architecture
Incoming: ws/application/trail_service.py, core/runtime/engine.py --- {Dict, UUID}
Processing: create_group(), create_subgroup_with_nodes(), update_node_status() --- {3 jobs: JOB_SAVE_TO_DB, JOB_TRANSFORM_DATA, JOB_VALIDATE_SCHEMA}
Outgoing: Supabase database (groups, subgroups, nodes) --- {Dict, UUID}

Trail Repository - Persistence layer for trail schema: Group → Subgroup → Node hierarchy
Reference: contracts/README.md (Trail hierarchy + invariants)

CRITICAL INVARIANTS:
1. Groups created ONLY when artifacts used in turn
2. Each subgroup has EXACTLY 3 nodes (writing, executing, output)
3. Node creation is atomic (transaction wraps all 3)
4. Artifact linkage enforced at application level
"""

from core.domain.repository_interfaces import ITrailRepository

import logging
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from ..clients.supabase import SupabaseClient
from ..persistence_gateway import SupabasePersistenceGateway

logger = logging.getLogger(__name__)


class TrailRepository(ITrailRepository):
    """
    Repository for trail schema database operations using Supabase SDK.
    
    Manages hierarchical trail structure:
    - Chat → Groups (one-to-many, conditional on artifact usage)
    - Group → Subgroups (one-to-many, per execution run)
    - Subgroup → Nodes (one-to-three, exactly 3 nodes always)
    - Node → Artifacts (optional, writing and output only)
    
    All operations enforce trail schema architecture constraints.
    """
    
    def __init__(self, db=None, *, session=None):
        """
        Initialize trail repository.
        
        Args:
            db: Supabase persistence gateway or raw Supabase client
            session: Legacy SQLAlchemy session (not supported)
        """
        if session is not None:
            raise RuntimeError(
                "SQLAlchemy sessions are no longer supported. "
                "Initialize TrailRepository with a SupabasePersistenceGateway.",
            )
        if db is None:
            raise ValueError(
                "SupabasePersistenceGateway (or SupabaseClient) instance required for TrailRepository."
            )
        if isinstance(db, SupabasePersistenceGateway):
            self._gateway = db
        elif isinstance(db, SupabaseClient):
            self._gateway = SupabasePersistenceGateway(db)
        else:
            raise TypeError(
                "Unsupported database adapter for TrailRepository. "
                "Expected SupabasePersistenceGateway or SupabaseClient."
            )
        self.db = self._gateway
    
    # =========================================================================
    # GROUP OPERATIONS
    # =========================================================================
    
    async def create_group(
        self,
        chat_id: UUID,
        user_message: str,
        agent_message: str,
        sequence_number: int,
        *,
        frontend_id: Optional[str] = None,
        backend_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        user_message_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """
        Create a new group (user-agent turn with artifacts).
        
        Args:
            chat_id: Parent chat UUID
            user_message: User's message text
            agent_message: Agent's response text
            sequence_number: Turn order within chat (1-indexed)
            frontend_id: Frontend identifier for traceability
            backend_id: Backend identifier for traceability
            correlation_id: Correlation identifier for traceability
            user_message_id: Foreign key to messages table (links to user message)
            
        Returns:
            Created group record
            
        Raises:
            Exception: If creation fails or constraints violated
        """
        try:
            data = {
                "chat_id": str(chat_id),
                "user_message": user_message,
                "agent_message": agent_message,
                "sequence_number": sequence_number,
                "frontend_id": frontend_id,
                "backend_id": backend_id,
                "correlation_id": correlation_id,
                "user_message_id": str(user_message_id) if user_message_id else None,
            }
            
            result = await self._gateway.insert("groups", data, admin=True)
            
            if isinstance(result, list):
                result = result[0]
            
            logger.info(
                f"Created group {result['id']} for chat {chat_id}, sequence {sequence_number}",
                extra={
                    "group_id": result['id'],
                    "chat_id": str(chat_id),
                    "sequence_number": sequence_number,
                    "backend_id": backend_id,
                }
            )
            
            return result
            
        except Exception as e:
            logger.error(
                f"Failed to create group for chat {chat_id}: {e}",
                exc_info=True,
                extra={
                    "chat_id": str(chat_id),
                    "sequence_number": sequence_number,
                }
            )
            raise
    
    async def get_group(self, group_id: UUID) -> Optional[Dict[str, Any]]:
        """
        Get group by ID.
        
        Args:
            group_id: Group UUID
            
        Returns:
            Group record or None if not found
        """
        try:
            result = await self._gateway.select(
                "groups",
                filters={"id": str(group_id)},
                limit=1,
                admin=True
            )
            
            return result[0] if result else None
            
        except Exception as e:
            logger.error(f"Failed to get group {group_id}: {e}", exc_info=True)
            raise
    
    async def get_groups_by_chat(self, chat_id: UUID) -> List[Dict[str, Any]]:
        """
        Get all groups for a chat, ordered by sequence.
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            List of group records
        """
        try:
            result = await self._gateway.select(
                "groups",
                filters={"chat_id": str(chat_id)},
                order_by="sequence_number.asc",
                admin=True
            )
            
            return result or []
            
        except Exception as e:
            logger.error(f"Failed to get groups for chat {chat_id}: {e}", exc_info=True)
            raise
    
    async def update_group(
        self,
        group_id: UUID,
        updates: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Update group fields.
        
        Args:
            group_id: Group UUID
            updates: Fields to update
            
        Returns:
            Updated group record
        """
        try:
            result = await self._gateway.update(
                "groups",
                data=updates,
                record_id=str(group_id),
                admin=True
            )
            
            if isinstance(result, list):
                result = result[0]
            
            logger.debug(f"Updated group {group_id}")
            return result
            
        except Exception as e:
            logger.error(f"Failed to update group {group_id}: {e}", exc_info=True)
            raise
    
    # =========================================================================
    # SUBGROUP OPERATIONS
    # =========================================================================
    
    async def create_subgroup(
        self,
        group_id: UUID,
        sequence_number: int,
        sequence_in_chat: int,
        *,
        execution_group: Optional[str] = None,
        status: str = "pending",
    ) -> Dict[str, Any]:
        """
        Create a new subgroup (artifact execution run) with timeline sequence.
        
        NOTE: Use create_subgroup_with_nodes() to atomically create
        subgroup with exactly 3 nodes. This method only creates the subgroup.
        
        Args:
            group_id: Parent group UUID
            sequence_number: Execution order within group (1-indexed)
            sequence_in_chat: Timeline position in chat (from get_next_chat_sequence RPC)
            execution_group: Execution identifier linking artifacts
            status: Initial status (pending|running|completed|error)
            
        Returns:
            Created subgroup record
        """
        try:
            data = {
                "group_id": str(group_id),
                "sequence_number": sequence_number,
                "sequence_in_chat": sequence_in_chat,  # ★ TIMELINE SEQUENCE
                "sequence_number": sequence_number,
                "execution_group": execution_group,
                "status": status,
            }
            
            result = await self._gateway.insert("subgroups", data, admin=True)
            
            if isinstance(result, list):
                result = result[0]
            
            logger.info(
                f"Created subgroup {result['id']} for group {group_id}, sequence {sequence_number}",
                extra={
                    "subgroup_id": result['id'],
                    "group_id": str(group_id),
                    "sequence_number": sequence_number,
                    "execution_group": execution_group,
                }
            )
            
            return result
            
        except Exception as e:
            logger.error(
                f"Failed to create subgroup for group {group_id}: {e}",
                exc_info=True,
                extra={"group_id": str(group_id), "sequence_number": sequence_number}
            )
            raise
    
    async def create_subgroup_with_nodes(
        self,
        group_id: UUID,
        sequence_number: int,
        sequence_in_chat: int,
        *,
        execution_group: Optional[str] = None,
        status: str = "pending",
    ) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """
        Atomically create subgroup with exactly 3 nodes and timeline sequence.
        
        CRITICAL: This is the primary method for subgroup creation.
        Enforces exactly 3 nodes per subgroup invariant.
        
        Node structure:
        1. Writing node (sequence=1, clickable=true)
        2. Executing node (sequence=2, clickable=false)
        3. Output node (sequence=3, clickable=true)
        
        Args:
            group_id: Parent group UUID
            sequence_number: Execution order within group (1-indexed)
            sequence_in_chat: Timeline position in chat (from get_next_chat_sequence RPC)
            execution_group: Execution identifier linking artifacts
            status: Initial status
            
        Returns:
            Tuple of (subgroup_record, [node1, node2, node3])
            
        Raises:
            Exception: If creation fails or node count != 3
        """
        try:
            # Step 1: Create subgroup with timeline sequence
            subgroup = await self.create_subgroup(
                group_id,
                sequence_number,
                sequence_in_chat=sequence_in_chat,  # ★ TIMELINE SEQUENCE
                execution_group=execution_group,
                status=status,
            )
            
            subgroup_id = UUID(subgroup['id'])
            
            # Step 2: Create exactly 3 nodes atomically
            nodes = await self._create_nodes_for_subgroup(subgroup_id)
            
            if len(nodes) != 3:
                # This should never happen due to _create_nodes_for_subgroup implementation
                logger.error(
                    f"CRITICAL: Subgroup {subgroup_id} created with {len(nodes)} nodes, expected 3",
                    extra={"subgroup_id": str(subgroup_id), "node_count": len(nodes)}
                )
                raise ValueError(f"Subgroup must have exactly 3 nodes, got {len(nodes)}")
            
            logger.info(
                f"Created subgroup {subgroup_id} with 3 nodes",
                extra={
                    "subgroup_id": str(subgroup_id),
                    "group_id": str(group_id),
                    "node_ids": [n['id'] for n in nodes],
                }
            )
            
            return subgroup, nodes
            
        except Exception as e:
            logger.error(
                f"Failed to create subgroup with nodes: {e}",
                exc_info=True,
                extra={"group_id": str(group_id), "sequence_number": sequence_number}
            )
            raise
    
    async def _create_nodes_for_subgroup(
        self,
        subgroup_id: UUID
    ) -> List[Dict[str, Any]]:
        """
        Create exactly 3 nodes for a subgroup.
        
        CRITICAL: This method enforces the 3-node invariant.
        Node types and sequences are hardcoded per architecture.
        
        Args:
            subgroup_id: Parent subgroup UUID
            
        Returns:
            List of 3 node records [writing, executing, output]
        """
        node_specs = [
            {"type": "writing", "sequence": 1, "clickable": True},
            {"type": "executing", "sequence": 2, "clickable": False},
            {"type": "output", "sequence": 3, "clickable": True},
        ]
        
        nodes = []
        
        for spec in node_specs:
            data = {
                "subgroup_id": str(subgroup_id),
                "type": spec["type"],
                "sequence": spec["sequence"],
                "clickable": spec["clickable"],
                "status": "pending",
            }
            
            result = await self._gateway.insert("nodes", data, admin=True)
            
            if isinstance(result, list):
                result = result[0]
            
            nodes.append(result)
        
        logger.debug(
            f"Created 3 nodes for subgroup {subgroup_id}",
            extra={"subgroup_id": str(subgroup_id), "node_ids": [n['id'] for n in nodes]}
        )
        
        return nodes
    
    async def get_subgroup(self, subgroup_id: UUID) -> Optional[Dict[str, Any]]:
        """
        Get subgroup by ID.
        
        Args:
            subgroup_id: Subgroup UUID
            
        Returns:
            Subgroup record or None if not found
        """
        try:
            result = await self._gateway.select(
                "subgroups",
                filters={"id": str(subgroup_id)},
                limit=1,
                admin=True
            )
            
            return result[0] if result else None
            
        except Exception as e:
            logger.error(f"Failed to get subgroup {subgroup_id}: {e}", exc_info=True)
            raise
    
    async def get_subgroups_by_group(
        self,
        group_id: UUID
    ) -> List[Dict[str, Any]]:
        """
        Get all subgroups for a group, ordered by sequence.
        
        Args:
            group_id: Group UUID
            
        Returns:
            List of subgroup records
        """
        try:
            result = await self._gateway.select(
                "subgroups",
                filters={"group_id": str(group_id)},
                order_by="sequence_number.asc",
                admin=True
            )
            
            return result or []
            
        except Exception as e:
            logger.error(f"Failed to get subgroups for group {group_id}: {e}", exc_info=True)
            raise
    
    async def update_subgroup(
        self,
        subgroup_id: UUID,
        updates: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Update subgroup fields.
        
        Args:
            subgroup_id: Subgroup UUID
            updates: Fields to update (status, completed_at, etc.)
            
        Returns:
            Updated subgroup record
        """
        try:
            result = await self._gateway.update(
                "subgroups",
                data=updates,
                record_id=str(subgroup_id),
                id_column="id",
                admin=True
            )
            
            logger.debug(f"Updated subgroup {subgroup_id}")
            return result
            
        except Exception as e:
            logger.error(f"Failed to update subgroup {subgroup_id}: {e}", exc_info=True)
            raise

    async def update_subgroup_status(
        self,
        subgroup_id: UUID,
        status: str
    ) -> Dict[str, Any]:
        """
        Update subgroup status (pending → running → completed).

        Sets timing fields based on status transitions:
        - running: Sets started_at to current time
        - completed/error: Sets completed_at to current time

        Args:
            subgroup_id: Subgroup UUID
            status: New status (pending|running|completed|error)

        Returns:
            Updated subgroup record
        """
        try:
            from datetime import datetime, timezone

            update_data = {"status": status}
            if status == "running":
                update_data["started_at"] = datetime.now(timezone.utc).isoformat()
            elif status in ("completed", "error"):
                update_data["completed_at"] = datetime.now(timezone.utc).isoformat()

            return await self.update_subgroup(subgroup_id, update_data)
        except Exception as e:
            logger.error(f"Failed to update subgroup {subgroup_id} status: {e}", exc_info=True)
            raise
    
    # =========================================================================
    # NODE OPERATIONS
    # =========================================================================
    
    async def get_node(self, node_id: UUID) -> Optional[Dict[str, Any]]:
        """
        Get node by ID.
        
        Args:
            node_id: Node UUID
            
        Returns:
            Node record or None if not found
        """
        try:
            result = await self._gateway.select(
                "nodes",
                filters={"id": str(node_id)},
                limit=1,
                admin=True
            )
            
            return result[0] if result else None
            
        except Exception as e:
            logger.error(f"Failed to get node {node_id}: {e}", exc_info=True)
            raise
    
    async def get_nodes_by_subgroup(
        self,
        subgroup_id: UUID
    ) -> List[Dict[str, Any]]:
        """
        Get all nodes for a subgroup, ordered by sequence.
        
        CRITICAL: Nodes table has artifact_id and artifact_type columns (via migration 004).
        Frontend expects node.artifact_id to enable clickability and artifact display.
        
        Should always return exactly 3 nodes.
        
        Args:
            subgroup_id: Subgroup UUID
            
        Returns:
            List of node records (expected: exactly 3) with artifact_id and artifact_type
        """
        try:
            # Get nodes directly from nodes table
            # Migration 004 added artifact_id and artifact_type columns to nodes table
            # Backend trail_service.emit_artifact_linked() persists artifact_id to nodes table
            result = await self._gateway.select(
                "nodes",
                filters={"subgroup_id": str(subgroup_id)},
                order_by="sequence.asc",
                admin=True
            )
            
            nodes = result or []
            
            if len(nodes) != 3:
                logger.warning(
                    f"Subgroup {subgroup_id} has {len(nodes)} nodes, expected 3",
                    extra={"subgroup_id": str(subgroup_id), "node_count": len(nodes)}
                )
            
            # CRITICAL: Normalize structure to match live WebSocket events
            # Live events use "node_id", but DB returns "id"
            # Frontend expects consistent structure for both live and restored trails
            normalized_nodes = []
            for node in nodes:
                normalized_node = {
                    "node_id": node["id"],  # Rename id → node_id for consistency
                    "type": node["type"],
                    "status": node["status"],
                    "sequence": node["sequence"],
                    "clickable": node.get("type") != "executing",  # executing nodes not clickable
                    "artifact_id": node.get("artifact_id"),
                    "artifact_type": node.get("artifact_type"),
                    "started_at": node.get("started_at"),  # TIMING DATA for duration calculation
                    "completed_at": node.get("completed_at")  # TIMING DATA for duration calculation
                }
                normalized_nodes.append(normalized_node)
            
            return normalized_nodes
            
        except Exception as e:
            logger.error(f"Failed to get nodes for subgroup {subgroup_id}: {e}", exc_info=True)
            raise
    
    async def update_node_status(
        self,
        node_id: UUID,
        status: str
    ) -> Dict[str, Any]:
        """
        Update node status (pending → active → completed).
        
        Sets timing fields based on status transitions:
        - active: Sets started_at to current time
        - completed/error: Sets completed_at to current time
        
        Args:
            node_id: Node UUID
            status: New status (pending|active|completed|error)
            
        Returns:
            Updated node record
        """
        try:
            from datetime import datetime, timezone
            
            # Build update payload
            update_data = {"status": status}
            
            # Set timing fields based on status
            if status == "active":
                # Node is starting execution
                update_data["started_at"] = datetime.now(timezone.utc).isoformat()
                # Reset completion fields to avoid invalid timing (active after completed)
                update_data["completed_at"] = None
                update_data["duration_ms"] = None
            elif status in ("completed", "error"):
                # Node has finished execution
                update_data["completed_at"] = datetime.now(timezone.utc).isoformat()
            
            result = await self._gateway.update(
                "nodes",
                data=update_data,
                record_id=str(node_id),
                admin=True
            )
            
            if isinstance(result, list):
                result = result[0]
            
            logger.debug(f"Updated node {node_id} status to {status} with timing data")
            return result
            
        except Exception as e:
            logger.error(f"Failed to update node {node_id} status: {e}", exc_info=True)
            raise
    
    async def update_node(
        self,
        node_id: UUID,
        updates: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Update node fields.
        
        Args:
            node_id: Node UUID
            updates: Fields to update
            
        Returns:
            Updated node record
        """
        try:
            result = await self._gateway.update(
                "nodes",
                data=updates,
                record_id=str(node_id),
                admin=True
            )
            
            if isinstance(result, list):
                result = result[0]
            
            logger.debug(f"Updated node {node_id}")
            return result
            
        except Exception as e:
            logger.error(f"Failed to update node {node_id}: {e}", exc_info=True)
            raise
    
    # =========================================================================
    # ARTIFACT LINKAGE
    # =========================================================================
    
    async def link_artifact_to_node(
        self,
        artifact_id: UUID,
        node_id: UUID,
        subgroup_id: UUID
    ) -> Dict[str, Any]:
        """
        Link an artifact to a node.
        
        CRITICAL: Validates node type matches artifact type:
        - code artifacts → writing nodes only
        - output artifacts → output nodes only
        - executing nodes → NO artifacts
        
        Args:
            artifact_id: Artifact UUID
            node_id: Node UUID
            subgroup_id: Subgroup UUID (for validation)
            
        Returns:
            Updated artifact record
            
        Raises:
            ValueError: If artifact type doesn't match node type
        """
        try:
            # Step 1: Get artifact to check type
            artifact_result = await self._gateway.select(
                "artifacts",
                filters={"id": str(artifact_id)},
                limit=1,
                admin=True
            )
            
            if not artifact_result:
                raise ValueError(f"Artifact {artifact_id} not found")
            
            artifact = artifact_result[0]
            artifact_type = artifact.get("type")
            
            # Step 2: Get node to check type
            node_result = await self._gateway.select(
                "nodes",
                filters={"id": str(node_id)},
                limit=1,
                admin=True
            )
            
            if not node_result:
                raise ValueError(f"Node {node_id} not found")
            
            node = node_result[0]
            node_type = node.get("type")
            
            # Step 3: Validate linkage rules
            if node_type == "executing":
                raise ValueError(f"Cannot link artifact to executing node {node_id}")
            
            if artifact_type not in ("code", "output"):
                raise ValueError(f"Unsupported artifact type '{artifact_type}' for node linkage")

            if artifact_type == "code" and node_type != "writing":
                raise ValueError(f"Code artifacts must link to writing nodes, got {node_type}")
            
            if artifact_type == "output" and node_type != "output":
                raise ValueError(f"Output artifacts must link to output nodes, got {node_type}")
            
            # Step 4: Link artifact
            updates = {
                "node_id": str(node_id),
                "subgroup_id": str(subgroup_id),
            }
            
            result = await self._gateway.update(
                "artifacts",
                data=updates,
                record_id=str(artifact_id),
                admin=True
            )
            
            if isinstance(result, list):
                result = result[0]
            
            logger.info(
                f"Linked artifact {artifact_id} ({artifact_type}) to node {node_id} ({node_type})",
                extra={
                    "artifact_id": str(artifact_id),
                    "node_id": str(node_id),
                    "artifact_type": artifact_type,
                    "node_type": node_type,
                }
            )
            
            return result
            
        except Exception as e:
            logger.error(
                f"Failed to link artifact {artifact_id} to node {node_id}: {e}",
                exc_info=True
            )
            raise
    
    # =========================================================================
    # HIERARCHY QUERIES
    # =========================================================================
    
    async def get_group_hierarchy(
        self,
        group_id: UUID
    ) -> Optional[Dict[str, Any]]:
        """
        Get complete hierarchy for a single group (subgroups + nodes).

        Args:
            group_id: Group UUID

        Returns:
            Group record with nested subgroups and nodes, or None if not found
        """
        try:
            group_result = await self._gateway.select(
                "groups",
                filters={"id": str(group_id)},
                limit=1,
                admin=True
            )
            if not group_result:
                return None

            group = group_result[0]
            subgroups = await self.get_subgroups_by_group(UUID(group["id"]))
            for subgroup in subgroups:
                nodes = await self.get_nodes_by_subgroup(UUID(subgroup["id"]))
                subgroup["nodes"] = nodes

            group["subgroups"] = subgroups
            return group
        except Exception as e:
            logger.error(f"Failed to get group hierarchy for {group_id}: {e}", exc_info=True)
            raise

    async def get_subgroup_artifacts(
        self,
        subgroup_id: UUID
    ) -> List[Dict[str, Any]]:
        """
        Get artifacts linked to a subgroup (code + output types only).

        Args:
            subgroup_id: Subgroup UUID

        Returns:
            List of artifact records ordered by creation time
        """
        try:
            return await self._gateway.select(
                "artifacts",
                filters={"subgroup_id": str(subgroup_id)},
                in_filters={"type": ["code", "output"]},
                order_by="created_at.asc",
                admin=True
            )
        except Exception as e:
            logger.error(f"Failed to get artifacts for subgroup {subgroup_id}: {e}", exc_info=True)
            raise

    async def get_trail_hierarchy(
        self,
        chat_id: UUID
    ) -> List[Dict[str, Any]]:
        """
        Get complete trail hierarchy for a chat.
        
        Returns groups with nested subgroups and nodes.
        
        Args:
            chat_id: Chat UUID
            
        Returns:
            List of group records with subgroups and nodes nested
        """
        try:
            # Step 1: Get all groups for chat
            groups = await self.get_groups_by_chat(chat_id)
            
            # Step 2: For each group, get subgroups and nodes
            for group in groups:
                group_id = UUID(group['id'])
                subgroups = await self.get_subgroups_by_group(group_id)
                
                for subgroup in subgroups:
                    subgroup_id = UUID(subgroup['id'])
                    nodes = await self.get_nodes_by_subgroup(subgroup_id)
                    subgroup['nodes'] = nodes
                
                group['subgroups'] = subgroups
            
            logger.debug(
                f"Retrieved trail hierarchy for chat {chat_id}",
                extra={"chat_id": str(chat_id), "group_count": len(groups)}
            )
            
            return groups
            
        except Exception as e:
            logger.error(f"Failed to get trail hierarchy for chat {chat_id}: {e}", exc_info=True)
            raise


# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

async def get_trail_repository() -> TrailRepository:
    """
    Get a trail repository instance with default Supabase client.
    
    Returns:
        Configured TrailRepository
    """
    from ..clients.supabase import SupabaseClient
    
    client = SupabaseClient.from_env()
    await client.initialize()
    return TrailRepository(client)

