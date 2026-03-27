"""
Integration tests for Trail Hierarchy (Group → Subgroup → Node → Artifact)

@.architecture
Incoming: TrailRepository, database fixtures --- {Object, python_objects}
Processing: Validate trail creation, enforce constraints, test relationships --- {3 jobs: JOB_CREATE_RECORD, JOB_VALIDATE_SCHEMA, JOB_QUERY}
Outgoing: pytest assertions, database state --- {Bool, assertion_results}

CRITICAL: These tests enforce architectural invariants:
- One subgroup → exactly 3 nodes
- Node type/sequence/clickable mapping
- Artifact-node linkage rules (executing node → NO artifact)
- Foreign key constraints
"""

import pytest
from uuid import uuid4, UUID

from data.database.repositories.chat import ChatRepository
from data.database.repositories.trail import TrailRepository
from data.database.persistence_gateway import SupabasePersistenceGateway


@pytest.fixture
async def trail_repo(supabase_gateway: SupabasePersistenceGateway):
    """Create trail repository instance (Supabase)."""
    return TrailRepository(db=supabase_gateway)


@pytest.fixture
async def sample_chat_id(supabase_gateway: SupabasePersistenceGateway):
    """Generate sample chat ID and ensure it exists in DB."""
    chat_id = uuid4()
    chat_repo = ChatRepository(supabase_gateway)
    await chat_repo.ensure_chat_exists(chat_id)
    return chat_id


@pytest.fixture
async def sample_group(trail_repo, sample_chat_id):
    """Create a sample group for testing"""
    group = await trail_repo.create_group(
        chat_id=sample_chat_id,
        user_message="test user message",
        agent_message="test agent message",
        sequence_number=1,
        frontend_id=str(uuid4()),
        backend_id=str(uuid4()),
        correlation_id=str(uuid4())
    )
    return group


async def _next_sequence_in_chat(trail_repo: TrailRepository, chat_id: str) -> int:
    """Get the next timeline sequence for the given chat."""
    client = trail_repo._gateway._client
    return await client.rpc("get_next_chat_sequence", {"p_chat_id": str(chat_id)}, admin=True)


async def _create_artifact(trail_repo: TrailRepository, chat_id: str, artifact_id: UUID, artifact_type: str):
    """Insert a minimal artifact row so linkage tests operate on real data."""
    data = {
        "id": str(artifact_id),
        "chat_id": str(chat_id),
        "artifact_id": str(artifact_id),
        "type": artifact_type,
        "content": "test",
    }
    result = await trail_repo._gateway.insert("artifacts", data, admin=True)
    if isinstance(result, list):
        result = result[0]
    return result


class TestGroupCreation:
    """Test group creation and validation"""
    
    @pytest.mark.asyncio
    async def test_create_group_success(self, trail_repo, sample_chat_id):
        """Test successful group creation"""
        frontend_id = str(uuid4())
        backend_id = str(uuid4())
        
        group = await trail_repo.create_group(
            chat_id=sample_chat_id,
            user_message="Hello",
            agent_message="Hi there",
            sequence_number=1,
            frontend_id=frontend_id,
            backend_id=backend_id
        )
        
        assert group is not None
        assert group["chat_id"] == str(sample_chat_id)
        assert group["user_message"] == "Hello"
        assert group["frontend_id"] == frontend_id
        assert group["backend_id"] == backend_id
        assert group["sequence_number"] == 1
    
    @pytest.mark.asyncio
    async def test_create_group_no_chat_id_fails(self, trail_repo):
        """Test that creating group without chat_id fails"""
        with pytest.raises(Exception):
            await trail_repo.create_group(
                chat_id=None,
                user_message="test",
                agent_message="test",
                sequence_number=1,
            )


class TestSubgroupCreation:
    """Test subgroup creation and 3-node invariant"""
    
    @pytest.mark.asyncio
    async def test_create_subgroup_with_exactly_3_nodes(self, trail_repo, sample_group):
        """CRITICAL: Test that subgroup is created with EXACTLY 3 nodes"""
        subgroup, nodes = await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
            execution_group=str(uuid4())
        )
        
        # CRITICAL ASSERTION: Exactly 3 nodes
        assert len(nodes) == 3, f"Expected exactly 3 nodes, got {len(nodes)}"
        
        # Validate node types
        node_types = [node["type"] for node in nodes]
        assert "writing" in node_types
        assert "executing" in node_types
        assert "output" in node_types
        
        # Validate node sequences
        assert nodes[0]["sequence"] == 1
        assert nodes[1]["sequence"] == 2
        assert nodes[2]["sequence"] == 3
        
        # Validate clickable properties
        assert nodes[0]["clickable"] == True  # writing
        assert nodes[1]["clickable"] == False  # executing
        assert nodes[2]["clickable"] == True  # output
    
    @pytest.mark.asyncio
    async def test_subgroup_node_type_sequence_mapping(self, trail_repo, sample_group):
        """CRITICAL: Test that node type → sequence → clickable mapping is correct"""
        subgroup, nodes = await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
        )
        
        # Find each node type
        writing_node = next(n for n in nodes if n["type"] == "writing")
        executing_node = next(n for n in nodes if n["type"] == "executing")
        output_node = next(n for n in nodes if n["type"] == "output")
        
        # Validate writing node
        assert writing_node["sequence"] == 1
        assert writing_node["clickable"] == True
        
        # Validate executing node
        assert executing_node["sequence"] == 2
        assert executing_node["clickable"] == False
        
        # Validate output node
        assert output_node["sequence"] == 3
        assert output_node["clickable"] == True


class TestArtifactLinkage:
    """Test artifact-node linkage rules"""
    
    @pytest.mark.asyncio
    async def test_link_artifact_to_writing_node(self, trail_repo, sample_group):
        """Test linking code artifact to writing node"""
        subgroup, nodes = await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
        )
        
        writing_node = next(n for n in nodes if n["type"] == "writing")
        artifact_id = uuid4()
        await _create_artifact(trail_repo, sample_group["chat_id"], artifact_id, "code")
        
        # This should succeed
        result = await trail_repo.link_artifact_to_node(
            artifact_id=artifact_id,
            node_id=writing_node["id"],
            subgroup_id=subgroup["id"]
        )
        
        assert result is not None
        assert result["artifact_id"] == str(artifact_id)
    
    @pytest.mark.asyncio
    async def test_link_artifact_to_output_node(self, trail_repo, sample_group):
        """Test linking output artifact to output node"""
        subgroup, nodes = await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
        )
        
        output_node = next(n for n in nodes if n["type"] == "output")
        artifact_id = uuid4()
        await _create_artifact(trail_repo, sample_group["chat_id"], artifact_id, "output")
        
        # This should succeed
        result = await trail_repo.link_artifact_to_node(
            artifact_id=artifact_id,
            node_id=output_node["id"],
            subgroup_id=subgroup["id"]
        )
        
        assert result is not None
        assert result["artifact_id"] == str(artifact_id)
    
    @pytest.mark.asyncio
    async def test_link_artifact_to_executing_node_fails(self, trail_repo, sample_group):
        """CRITICAL: Test that linking artifact to executing node fails"""
        subgroup, nodes = await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
        )
        
        executing_node = next(n for n in nodes if n["type"] == "executing")
        artifact_id = uuid4()
        await _create_artifact(trail_repo, sample_group["chat_id"], artifact_id, "code")
        
        # This should fail
        with pytest.raises(Exception) as exc_info:
            await trail_repo.link_artifact_to_node(
                artifact_id=artifact_id,
                node_id=executing_node["id"],
                subgroup_id=subgroup["id"]
            )
        
        error_text = str(exc_info.value).lower()
        assert "executing" in error_text and "artifact" in error_text


class TestHierarchicalQueries:
    """Test querying the trail hierarchy"""
    
    @pytest.mark.asyncio
    async def test_get_group_hierarchy(self, trail_repo, sample_group):
        """Test retrieving complete group hierarchy"""
        # Create subgroup
        subgroup, nodes = await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
        )
        
        # Get group with subgroups and nodes
        hierarchy = await trail_repo.get_group_hierarchy(sample_group["id"])
        
        assert hierarchy is not None
        assert len(hierarchy["subgroups"]) == 1
        assert len(hierarchy["subgroups"][0]["nodes"]) == 3
    
    @pytest.mark.asyncio
    async def test_get_subgroup_artifacts(self, trail_repo, sample_group):
        """Test retrieving artifacts for a subgroup (code + output only)"""
        subgroup, nodes = await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
        )
        
        # Link artifacts to writing and output nodes
        writing_node = next(n for n in nodes if n["type"] == "writing")
        output_node = next(n for n in nodes if n["type"] == "output")
        
        code_artifact_id = uuid4()
        output_artifact_id = uuid4()

        await _create_artifact(trail_repo, sample_group["chat_id"], code_artifact_id, "code")
        await _create_artifact(trail_repo, sample_group["chat_id"], output_artifact_id, "output")
        
        await trail_repo.link_artifact_to_node(
            artifact_id=code_artifact_id,
            node_id=writing_node["id"],
            subgroup_id=subgroup["id"]
        )
        
        await trail_repo.link_artifact_to_node(
            artifact_id=output_artifact_id,
            node_id=output_node["id"],
            subgroup_id=subgroup["id"]
        )
        
        # Query artifacts for this subgroup
        artifacts = await trail_repo.get_subgroup_artifacts(subgroup["id"])
        
        # Should return exactly 2 artifacts (code + output, NO executing)
        assert len(artifacts) == 2
        
        artifact_ids = {str(a["artifact_id"]) for a in artifacts}
        assert str(code_artifact_id) in artifact_ids
        assert str(output_artifact_id) in artifact_ids


class TestConstraintEnforcement:
    """Test database constraints and invariants"""
    
    @pytest.mark.asyncio
    async def test_foreign_key_constraint_group_to_chat(self, trail_repo):
        """Test that creating group with invalid chat_id fails"""
        invalid_chat_id = uuid4()
        
        with pytest.raises(Exception):
            await trail_repo.create_group(
                chat_id=invalid_chat_id,
                user_message="test",
                agent_message="test",
                sequence_number=1,
            )
    
    @pytest.mark.asyncio
    async def test_unique_constraint_execution_group(self, trail_repo, sample_group):
        """Test that execution_group is unique within a group"""
        execution_group = str(uuid4())
        
        # Create first subgroup
        await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
            execution_group=execution_group
        )
        
        # Attempt to create second subgroup with same execution_group
        with pytest.raises(Exception):
            await trail_repo.create_subgroup_with_nodes(
                group_id=sample_group["id"],
                sequence_number=2,
                sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
                execution_group=execution_group  # Duplicate
            )


class TestStatusUpdates:
    """Test node status transitions"""
    
    @pytest.mark.asyncio
    async def test_update_node_status(self, trail_repo, sample_group):
        """Test updating node status through lifecycle"""
        subgroup, nodes = await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
        )
        
        writing_node = next(n for n in nodes if n["type"] == "writing")
        
        # Update to active
        updated = await trail_repo.update_node_status(
            node_id=writing_node["id"],
            status="active"
        )
        assert updated["status"] == "active"
        
        # Update to completed
        updated = await trail_repo.update_node_status(
            node_id=writing_node["id"],
            status="completed"
        )
        assert updated["status"] == "completed"
    
    @pytest.mark.asyncio
    async def test_update_subgroup_status(self, trail_repo, sample_group):
        """Test updating subgroup status"""
        subgroup, nodes = await trail_repo.create_subgroup_with_nodes(
            group_id=sample_group["id"],
            sequence_number=1,
            sequence_in_chat=await _next_sequence_in_chat(trail_repo, sample_group["chat_id"]),
        )
        
        # Update to running
        result = await trail_repo.update_subgroup_status(
            subgroup_id=subgroup["id"],
            status="running"
        )
        # gateway.update returns a list; extract first record
        updated = result[0] if isinstance(result, list) else result
        assert updated["status"] == "running"
        
        # Update to completed
        result = await trail_repo.update_subgroup_status(
            subgroup_id=subgroup["id"],
            status="completed"
        )
        updated = result[0] if isinstance(result, list) else result
        assert updated["status"] == "completed"
        assert updated["completed_at"] is not None


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])

