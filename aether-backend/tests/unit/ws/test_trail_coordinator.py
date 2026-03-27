"""
Unit Tests: TrailCoordinator

Tests the trail hierarchy lifecycle coordinator — group/subgroup/node creation,
status updates, artifact linking, completion, and sequence calculation.

Uses AsyncMock for the trail_repository_adapter. No DB, no network.

Bug-finding focus:
- IndexError when repository returns fewer than 3 nodes (BUG FOUND)
- Partial update in complete_hierarchy (node completed, subgroup not)
- Invalid UUID propagation
- Sequence calculation across groups
"""

from unittest.mock import AsyncMock
from uuid import UUID, uuid4


from ws.application.trail_coordinator import TrailCoordinator, _utc_now_iso


# =========================================================================
# Helpers
# =========================================================================

def _make_group(group_id=None, **overrides):
    """Create a realistic group dict."""
    gid = group_id or str(uuid4())
    base = {
        "id": gid,
        "chat_id": str(uuid4()),
        "user_message": "test user message",
        "agent_message": "test agent message",
        "sequence_number": 1,
        "frontend_id": None,
        "backend_id": "backend-123",
        "correlation_id": None,
        "user_message_id": None,
    }
    base.update(overrides)
    return base


def _make_subgroup(subgroup_id=None, **overrides):
    """Create a realistic subgroup dict."""
    sid = subgroup_id or str(uuid4())
    base = {
        "id": sid,
        "group_id": str(uuid4()),
        "sequence_number": 1,
        "sequence_in_chat": 1,
        "execution_group": "exec-group-1",
        "status": "running",
    }
    base.update(overrides)
    return base


def _make_nodes(count=3):
    """Create N node dicts (writing, executing, output)."""
    labels = ["writing", "executing", "output"]
    return [
        {
            "id": str(uuid4()),
            "subgroup_id": str(uuid4()),
            "label": labels[i] if i < len(labels) else f"extra-{i}",
            "status": "pending",
        }
        for i in range(count)
    ]


def _make_repo():
    """Create a fully-mocked trail repository adapter."""
    repo = AsyncMock()
    repo.get_groups_by_chat = AsyncMock(return_value=[])
    repo.find_recent_user_message = AsyncMock(return_value=None)
    repo.create_group = AsyncMock()
    repo.get_next_chat_sequence = AsyncMock(return_value=1)
    repo.create_subgroup_with_nodes = AsyncMock()
    repo.get_subgroups_by_group = AsyncMock(return_value=[])
    repo.update_node_status = AsyncMock()
    repo.update_node = AsyncMock()
    repo.update_subgroup = AsyncMock()
    return repo


# Fixed IDs for deterministic assertions
CHAT_ID = str(uuid4())
GROUP_ID = str(uuid4())
SUBGROUP_ID = str(uuid4())
BACKEND_ID = "backend-req-001"
FRONTEND_ID = "frontend-req-001"
CORRELATION_ID = "corr-001"
EXECUTION_GROUP = "exec-group-1"
USER_MSG_ID = uuid4()


# =========================================================================
# _utc_now_iso
# =========================================================================

class TestUtcNowIso:
    """Tests for the module-level _utc_now_iso helper."""

    def test_returns_iso_string(self):
        """Must return a parseable ISO 8601 UTC timestamp."""
        from datetime import datetime
        result = _utc_now_iso()
        parsed = datetime.fromisoformat(result)
        assert parsed.tzinfo is not None

    def test_is_utc(self):
        """Timestamp must be in UTC."""
        from datetime import datetime, timezone
        result = _utc_now_iso()
        parsed = datetime.fromisoformat(result)
        assert parsed.tzinfo == timezone.utc


# =========================================================================
# Initialization
# =========================================================================

class TestInit:
    """Tests for TrailCoordinator.__init__."""

    def test_stores_repo(self):
        """Repo is stored as _trail_repo."""
        repo = _make_repo()
        coord = TrailCoordinator(trail_repository_adapter=repo)
        assert coord._trail_repo is repo

    def test_none_repo(self):
        """Default is None trail_repo."""
        coord = TrailCoordinator()
        assert coord._trail_repo is None


# =========================================================================
# create_hierarchy
# =========================================================================

class TestCreateHierarchy:
    """Tests for TrailCoordinator.create_hierarchy."""

    async def test_no_repo_returns_none(self):
        """Without trail repo, returns None immediately."""
        coord = TrailCoordinator()
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="hello",
            agent_message="hi",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )
        assert result is None

    async def test_successful_full_hierarchy(self):
        """Happy path: creates group, subgroup, 3 nodes, returns full hierarchy dict."""
        repo = _make_repo()
        group = _make_group(group_id=GROUP_ID)
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID, sequence_number=1)
        nodes = _make_nodes(3)

        repo.get_groups_by_chat.return_value = []
        repo.create_group.return_value = group
        repo.get_next_chat_sequence.return_value = 42
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="test user",
            agent_message="test agent",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            frontend_id=FRONTEND_ID,
            correlation_id=CORRELATION_ID,
            user_message_id=USER_MSG_ID,
        )

        assert isinstance(result, dict)
        assert result["chat_id"] == CHAT_ID
        assert result["group_id"] == GROUP_ID
        assert result["subgroup_id"] == SUBGROUP_ID
        assert result["writing_node_id"] == nodes[0]["id"]
        assert result["executing_node_id"] == nodes[1]["id"]
        assert result["output_node_id"] == nodes[2]["id"]
        assert result["sequence_number"] == 1  # 0 existing + 1
        assert result["subgroup_sequence_number"] == subgroup["sequence_number"]
        assert result["sequence_in_chat"] == 42
        assert result["backend_id"] == BACKEND_ID
        assert result["frontend_id"] == FRONTEND_ID
        assert result["correlation_id"] == CORRELATION_ID
        assert result["execution_group"] == EXECUTION_GROUP

    async def test_sequence_number_from_existing_groups(self):
        """Sequence number = len(existing_groups) + 1."""
        repo = _make_repo()
        # 3 existing groups → sequence should be 4
        repo.get_groups_by_chat.return_value = [
            _make_group(),
            _make_group(),
            _make_group(),
        ]
        group = _make_group(group_id=GROUP_ID)
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID)
        nodes = _make_nodes(3)

        repo.create_group.return_value = group
        repo.get_next_chat_sequence.return_value = 10
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )

        assert isinstance(result, dict)
        assert result["sequence_number"] == 4
        # Verify create_group was called with sequence_number=4
        call_kwargs = repo.create_group.call_args.kwargs
        assert call_kwargs["sequence_number"] == 4

    async def test_uses_provided_user_message_id(self):
        """When user_message_id is provided, does NOT call _find_recent_user_message."""
        repo = _make_repo()
        group = _make_group(group_id=GROUP_ID)
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID)
        nodes = _make_nodes(3)

        repo.create_group.return_value = group
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            user_message_id=USER_MSG_ID,
        )

        assert isinstance(result, dict)
        # find_recent_user_message should NOT have been called
        repo.find_recent_user_message.assert_not_called()
        # create_group should have been called with the provided UUID
        call_kwargs = repo.create_group.call_args.kwargs
        assert call_kwargs["user_message_id"] == USER_MSG_ID

    async def test_finds_user_message_when_not_provided(self):
        """When user_message_id is None, calls _find_recent_user_message."""
        repo = _make_repo()
        found_id = uuid4()
        repo.find_recent_user_message.return_value = found_id

        group = _make_group(group_id=GROUP_ID)
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID)
        nodes = _make_nodes(3)

        repo.create_group.return_value = group
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )

        assert isinstance(result, dict)
        repo.find_recent_user_message.assert_awaited_once_with(CHAT_ID)
        call_kwargs = repo.create_group.call_args.kwargs
        assert call_kwargs["user_message_id"] == found_id

    async def test_db_error_on_create_group_returns_none(self):
        """RuntimeError from create_group → returns None."""
        repo = _make_repo()
        repo.create_group.side_effect = RuntimeError("DB down")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            user_message_id=USER_MSG_ID,
        )
        assert result is None

    async def test_db_error_on_get_groups_returns_none(self):
        """OSError from get_groups_by_chat → returns None."""
        repo = _make_repo()
        repo.get_groups_by_chat.side_effect = OSError("Connection lost")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )
        assert result is None

    async def test_invalid_chat_id_returns_none(self):
        """Non-UUID chat_id → ValueError caught, returns None."""
        repo = _make_repo()
        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id="not-a-uuid",
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )
        assert result is None

    async def test_missing_id_key_in_group_response(self):
        """Group response without 'id' key → KeyError caught, returns None."""
        repo = _make_repo()
        repo.create_group.return_value = {"no_id_here": "oops"}

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            user_message_id=USER_MSG_ID,
        )
        assert result is None

    async def test_fewer_than_3_nodes_returns_none(self):
        """
        BUG FIX: Repository returns fewer than 3 nodes → IndexError now caught.
        Previously IndexError was NOT in the except clause. Fixed by adding IndexError.
        """
        repo = _make_repo()
        group = _make_group(group_id=GROUP_ID)
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID)
        nodes = _make_nodes(1)  # Only 1 node instead of 3

        repo.create_group.return_value = group
        repo.get_next_chat_sequence.return_value = 1
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)

        # IndexError is now caught — returns None instead of propagating
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            user_message_id=USER_MSG_ID,
        )
        assert result is None

    async def test_empty_nodes_list_returns_none(self):
        """BUG FIX: Empty nodes list → IndexError now caught, returns None."""
        repo = _make_repo()
        group = _make_group(group_id=GROUP_ID)
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID)

        repo.create_group.return_value = group
        repo.get_next_chat_sequence.return_value = 1
        repo.create_subgroup_with_nodes.return_value = (subgroup, [])

        coord = TrailCoordinator(trail_repository_adapter=repo)

        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            user_message_id=USER_MSG_ID,
        )
        assert result is None

    async def test_create_group_called_with_correct_args(self):
        """Verify all arguments passed to create_group."""
        repo = _make_repo()
        group = _make_group(group_id=GROUP_ID)
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID)
        nodes = _make_nodes(3)

        repo.create_group.return_value = group
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)
        await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="test user msg",
            agent_message="test agent msg",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            frontend_id=FRONTEND_ID,
            correlation_id=CORRELATION_ID,
            user_message_id=USER_MSG_ID,
        )

        call_kwargs = repo.create_group.call_args.kwargs
        assert call_kwargs["chat_id"] == UUID(CHAT_ID)
        assert call_kwargs["user_message"] == "test user msg"
        assert call_kwargs["agent_message"] == "test agent msg"
        assert call_kwargs["sequence_number"] == 1
        assert call_kwargs["frontend_id"] == FRONTEND_ID
        assert call_kwargs["backend_id"] == BACKEND_ID
        assert call_kwargs["correlation_id"] == CORRELATION_ID
        assert call_kwargs["user_message_id"] == USER_MSG_ID

    async def test_create_subgroup_with_nodes_called_with_correct_args(self):
        """Verify args passed to create_subgroup_with_nodes."""
        repo = _make_repo()
        group = _make_group(group_id=GROUP_ID)
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID)
        nodes = _make_nodes(3)

        repo.create_group.return_value = group
        repo.get_next_chat_sequence.return_value = 7
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)
        await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            user_message_id=USER_MSG_ID,
        )

        call_kwargs = repo.create_subgroup_with_nodes.call_args.kwargs
        assert call_kwargs["group_id"] == UUID(GROUP_ID)
        assert call_kwargs["sequence_number"] == 1  # 0 existing subgroups + 1
        assert call_kwargs["sequence_in_chat"] == 7
        assert call_kwargs["execution_group"] == EXECUTION_GROUP
        assert call_kwargs["status"] == "running"

    async def test_attribute_error_returns_none(self):
        """AttributeError in pipeline → caught, returns None."""
        repo = _make_repo()
        repo.create_group.side_effect = AttributeError("missing attr")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            user_message_id=USER_MSG_ID,
        )
        assert result is None

    async def test_connection_error_returns_none(self):
        """BUG FIX: ConnectionError was NOT in narrow except tuple. Now caught."""
        repo = _make_repo()
        repo.get_groups_by_chat.side_effect = ConnectionError("refused")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )
        assert result is None

    async def test_timeout_error_returns_none(self):
        """BUG FIX: TimeoutError was NOT in narrow except tuple. Now caught."""
        repo = _make_repo()
        repo.create_group.side_effect = TimeoutError("DB timeout")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_hierarchy(
            chat_id=CHAT_ID,
            user_message="u",
            agent_message="a",
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            user_message_id=USER_MSG_ID,
        )
        assert result is None


# =========================================================================
# create_subgroup
# =========================================================================

class TestCreateSubgroup:
    """Tests for TrailCoordinator.create_subgroup."""

    async def test_no_repo_returns_none(self):
        """Without trail repo, returns None immediately."""
        coord = TrailCoordinator()
        result = await coord.create_subgroup(
            chat_id=CHAT_ID,
            group_id=GROUP_ID,
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )
        assert result is None

    async def test_successful_subgroup_creation(self):
        """Happy path: creates subgroup with 3 nodes, returns dict."""
        repo = _make_repo()
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID, sequence_number=2)
        nodes = _make_nodes(3)

        repo.get_next_chat_sequence.return_value = 5
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_subgroup(
            chat_id=CHAT_ID,
            group_id=GROUP_ID,
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
            frontend_id=FRONTEND_ID,
        )

        assert isinstance(result, dict)
        assert result["chat_id"] == CHAT_ID
        assert result["group_id"] == GROUP_ID
        assert result["subgroup_id"] == SUBGROUP_ID
        assert result["writing_node_id"] == nodes[0]["id"]
        assert result["executing_node_id"] == nodes[1]["id"]
        assert result["output_node_id"] == nodes[2]["id"]
        assert result["subgroup_sequence_number"] == subgroup["sequence_number"]
        assert result["sequence_in_chat"] == 5
        assert result["backend_id"] == BACKEND_ID
        assert result["frontend_id"] == FRONTEND_ID
        assert result["execution_group"] == EXECUTION_GROUP

    async def test_calculates_subgroup_sequence_across_groups(self):
        """Subgroup sequence counts across ALL groups in chat."""
        repo = _make_repo()
        group1_id = str(uuid4())
        group2_id = str(uuid4())

        # 2 groups, group1 has 2 subgroups, group2 has 1 = total 3, next = 4
        repo.get_groups_by_chat.return_value = [
            _make_group(group_id=group1_id),
            _make_group(group_id=group2_id),
        ]
        repo.get_subgroups_by_group.side_effect = [
            [_make_subgroup(), _make_subgroup()],  # group1: 2 subgroups
            [_make_subgroup()],                      # group2: 1 subgroup
        ]

        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID, sequence_number=4)
        nodes = _make_nodes(3)
        repo.get_next_chat_sequence.return_value = 10
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_subgroup(
            chat_id=CHAT_ID,
            group_id=GROUP_ID,
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )

        assert isinstance(result, dict)
        # Verify create_subgroup_with_nodes was called with sequence_number=4
        call_kwargs = repo.create_subgroup_with_nodes.call_args.kwargs
        assert call_kwargs["sequence_number"] == 4

    async def test_db_error_returns_none(self):
        """RuntimeError in pipeline → returns None."""
        repo = _make_repo()
        repo.get_next_chat_sequence.side_effect = RuntimeError("DB error")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_subgroup(
            chat_id=CHAT_ID,
            group_id=GROUP_ID,
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )
        assert result is None

    async def test_fewer_than_3_nodes_returns_none(self):
        """BUG FIX: Repository returns fewer than 3 nodes → IndexError now caught."""
        repo = _make_repo()
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID)
        nodes = _make_nodes(2)  # Only 2 nodes

        repo.get_next_chat_sequence.return_value = 1
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)

        result = await coord.create_subgroup(
            chat_id=CHAT_ID,
            group_id=GROUP_ID,
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )
        assert result is None

    async def test_create_subgroup_with_nodes_called_correctly(self):
        """Verify args passed to create_subgroup_with_nodes."""
        repo = _make_repo()
        subgroup = _make_subgroup(subgroup_id=SUBGROUP_ID)
        nodes = _make_nodes(3)

        repo.get_next_chat_sequence.return_value = 3
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        coord = TrailCoordinator(trail_repository_adapter=repo)
        await coord.create_subgroup(
            chat_id=CHAT_ID,
            group_id=GROUP_ID,
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )

        call_kwargs = repo.create_subgroup_with_nodes.call_args.kwargs
        assert call_kwargs["group_id"] == UUID(GROUP_ID)
        assert call_kwargs["execution_group"] == EXECUTION_GROUP
        assert call_kwargs["status"] == "running"
        assert call_kwargs["sequence_in_chat"] == 3

    async def test_value_error_returns_none(self):
        """ValueError in pipeline → caught, returns None."""
        repo = _make_repo()
        repo.get_groups_by_chat.side_effect = ValueError("bad uuid")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.create_subgroup(
            chat_id=CHAT_ID,
            group_id=GROUP_ID,
            execution_group=EXECUTION_GROUP,
            backend_id=BACKEND_ID,
        )
        assert result is None


# =========================================================================
# update_node_status
# =========================================================================

class TestUpdateNodeStatus:
    """Tests for TrailCoordinator.update_node_status."""

    async def test_no_repo_returns_false(self):
        """Without trail repo, returns False immediately."""
        coord = TrailCoordinator()
        result = await coord.update_node_status(
            node_id=str(uuid4()),
            status="active",
        )
        assert result is False

    async def test_successful_update(self):
        """Happy path: updates node status, returns True."""
        repo = _make_repo()
        node_id = str(uuid4())

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.update_node_status(
            node_id=node_id,
            status="completed",
        )

        assert result is True
        repo.update_node_status.assert_awaited_once_with(UUID(node_id), "completed")

    async def test_db_error_returns_false(self):
        """RuntimeError from repo → returns False."""
        repo = _make_repo()
        repo.update_node_status.side_effect = RuntimeError("DB down")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.update_node_status(
            node_id=str(uuid4()),
            status="active",
        )
        assert result is False

    async def test_invalid_uuid_returns_false(self):
        """Non-UUID node_id → ValueError caught, returns False."""
        repo = _make_repo()
        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.update_node_status(
            node_id="not-a-valid-uuid",
            status="active",
        )
        assert result is False

    async def test_os_error_returns_false(self):
        """OSError from repo → returns False."""
        repo = _make_repo()
        repo.update_node_status.side_effect = OSError("Connection refused")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.update_node_status(
            node_id=str(uuid4()),
            status="active",
        )
        assert result is False


# =========================================================================
# link_artifact_to_node
# =========================================================================

class TestLinkArtifactToNode:
    """Tests for TrailCoordinator.link_artifact_to_node."""

    async def test_no_repo_returns_false(self):
        """Without trail repo, returns False immediately."""
        coord = TrailCoordinator()
        result = await coord.link_artifact_to_node(
            node_id=str(uuid4()),
            artifact_id="artifact-123",
            artifact_type="code",
        )
        assert result is False

    async def test_successful_link(self):
        """Happy path: links artifact to node, returns True."""
        repo = _make_repo()
        node_id = str(uuid4())

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.link_artifact_to_node(
            node_id=node_id,
            artifact_id="artifact-abc",
            artifact_type="code",
        )

        assert result is True
        repo.update_node.assert_awaited_once_with(
            node_id=UUID(node_id),
            updates={
                "artifact_id": "artifact-abc",
                "artifact_type": "code",
            },
        )

    async def test_db_error_returns_false(self):
        """RuntimeError from repo → returns False."""
        repo = _make_repo()
        repo.update_node.side_effect = RuntimeError("DB error")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.link_artifact_to_node(
            node_id=str(uuid4()),
            artifact_id="artifact-123",
            artifact_type="output",
        )
        assert result is False

    async def test_invalid_uuid_returns_false(self):
        """Non-UUID node_id → ValueError caught, returns False."""
        repo = _make_repo()
        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.link_artifact_to_node(
            node_id="not-valid",
            artifact_id="artifact-123",
            artifact_type="code",
        )
        assert result is False

    async def test_attribute_error_returns_false(self):
        """AttributeError from repo → returns False."""
        repo = _make_repo()
        repo.update_node.side_effect = AttributeError("missing method")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.link_artifact_to_node(
            node_id=str(uuid4()),
            artifact_id="artifact-123",
            artifact_type="code",
        )
        assert result is False


# =========================================================================
# complete_hierarchy
# =========================================================================

class TestCompleteHierarchy:
    """Tests for TrailCoordinator.complete_hierarchy."""

    async def test_no_repo_returns_false(self):
        """Without trail repo, returns False immediately."""
        coord = TrailCoordinator()
        result = await coord.complete_hierarchy(
            subgroup_id=str(uuid4()),
            output_node_id=str(uuid4()),
        )
        assert result is False

    async def test_successful_completion(self):
        """Happy path: completes output node and subgroup, returns True."""
        repo = _make_repo()
        subgroup_id = str(uuid4())
        output_node_id = str(uuid4())

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.complete_hierarchy(
            subgroup_id=subgroup_id,
            output_node_id=output_node_id,
        )

        assert result is True
        # Node status updated first
        repo.update_node_status.assert_awaited_once_with(
            UUID(output_node_id), "completed"
        )
        # Subgroup updated second
        repo.update_subgroup.assert_awaited_once()
        call_args = repo.update_subgroup.call_args
        assert call_args[0][0] == UUID(subgroup_id)
        updates = call_args[0][1]
        assert updates["status"] == "completed"
        assert "completed_at" in updates

    async def test_node_update_fails_returns_false(self):
        """RuntimeError from update_node_status → returns False."""
        repo = _make_repo()
        repo.update_node_status.side_effect = RuntimeError("DB error")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.complete_hierarchy(
            subgroup_id=str(uuid4()),
            output_node_id=str(uuid4()),
        )
        assert result is False
        # Subgroup update should NOT have been called
        repo.update_subgroup.assert_not_awaited()

    async def test_subgroup_update_fails_after_node_succeeds(self):
        """
        Design concern: update_node_status succeeds but update_subgroup fails.
        Node is left as 'completed' but subgroup is not. Partial state.
        Returns False but the node update is NOT rolled back.
        """
        repo = _make_repo()
        repo.update_subgroup.side_effect = RuntimeError("Subgroup update failed")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.complete_hierarchy(
            subgroup_id=str(uuid4()),
            output_node_id=str(uuid4()),
        )

        assert result is False
        # Node WAS updated (not rolled back)
        repo.update_node_status.assert_awaited_once()

    async def test_invalid_output_node_uuid_returns_false(self):
        """Non-UUID output_node_id → ValueError caught, returns False."""
        repo = _make_repo()
        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.complete_hierarchy(
            subgroup_id=str(uuid4()),
            output_node_id="not-valid-uuid",
        )
        assert result is False

    async def test_invalid_subgroup_uuid_returns_false(self):
        """Non-UUID subgroup_id → ValueError caught, returns False."""
        repo = _make_repo()
        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord.complete_hierarchy(
            subgroup_id="not-valid-uuid",
            output_node_id=str(uuid4()),
        )
        # Note: update_node_status is called first with a valid UUID,
        # but update_subgroup gets called with invalid UUID.
        # The ValueError is caught by the except clause.
        assert result is False

    async def test_completed_at_is_iso_timestamp(self):
        """The completed_at field must be a parseable ISO timestamp."""
        from datetime import datetime

        repo = _make_repo()
        coord = TrailCoordinator(trail_repository_adapter=repo)
        await coord.complete_hierarchy(
            subgroup_id=str(uuid4()),
            output_node_id=str(uuid4()),
        )

        call_args = repo.update_subgroup.call_args
        updates = call_args[0][1]
        completed_at = updates["completed_at"]
        # Must be parseable
        parsed = datetime.fromisoformat(completed_at)
        assert parsed is not None


# =========================================================================
# _find_recent_user_message (private helper)
# =========================================================================

class TestFindRecentUserMessage:
    """Tests for TrailCoordinator._find_recent_user_message."""

    async def test_successful_find(self):
        """Returns UUID from repo."""
        repo = _make_repo()
        expected = uuid4()
        repo.find_recent_user_message.return_value = expected

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord._find_recent_user_message(CHAT_ID)

        assert result == expected
        repo.find_recent_user_message.assert_awaited_once_with(CHAT_ID)

    async def test_repo_error_returns_none(self):
        """Repo raises → returns None."""
        repo = _make_repo()
        repo.find_recent_user_message.side_effect = RuntimeError("DB error")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord._find_recent_user_message(CHAT_ID)
        assert result is None

    async def test_value_error_returns_none(self):
        """ValueError from repo → returns None."""
        repo = _make_repo()
        repo.find_recent_user_message.side_effect = ValueError("bad data")

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord._find_recent_user_message(CHAT_ID)
        assert result is None

    async def test_repo_returns_none(self):
        """Repo returns None (no user message found) → returns None."""
        repo = _make_repo()
        repo.find_recent_user_message.return_value = None

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord._find_recent_user_message(CHAT_ID)
        assert result is None


# =========================================================================
# _calculate_subgroup_sequence (private helper)
# =========================================================================

class TestCalculateSubgroupSequence:
    """Tests for TrailCoordinator._calculate_subgroup_sequence."""

    async def test_empty_chat_returns_1(self):
        """No groups → no subgroups → sequence = 1."""
        repo = _make_repo()
        repo.get_groups_by_chat.return_value = []

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord._calculate_subgroup_sequence(CHAT_ID)
        assert result == 1

    async def test_single_group_single_subgroup(self):
        """1 group with 1 subgroup → next = 2."""
        repo = _make_repo()
        group_id = str(uuid4())
        repo.get_groups_by_chat.return_value = [_make_group(group_id=group_id)]
        repo.get_subgroups_by_group.return_value = [_make_subgroup()]

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord._calculate_subgroup_sequence(CHAT_ID)
        assert result == 2

    async def test_multiple_groups_multiple_subgroups(self):
        """2 groups: 3 + 2 subgroups = 5, next = 6."""
        repo = _make_repo()
        g1 = str(uuid4())
        g2 = str(uuid4())
        repo.get_groups_by_chat.return_value = [
            _make_group(group_id=g1),
            _make_group(group_id=g2),
        ]
        repo.get_subgroups_by_group.side_effect = [
            [_make_subgroup(), _make_subgroup(), _make_subgroup()],  # 3
            [_make_subgroup(), _make_subgroup()],                     # 2
        ]

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord._calculate_subgroup_sequence(CHAT_ID)
        assert result == 6

    async def test_groups_with_no_subgroups(self):
        """Groups exist but all empty → next = 1."""
        repo = _make_repo()
        repo.get_groups_by_chat.return_value = [_make_group(), _make_group()]
        repo.get_subgroups_by_group.return_value = []

        coord = TrailCoordinator(trail_repository_adapter=repo)
        result = await coord._calculate_subgroup_sequence(CHAT_ID)
        assert result == 1

    async def test_queries_each_group_for_subgroups(self):
        """Must call get_subgroups_by_group once per group."""
        repo = _make_repo()
        g1 = str(uuid4())
        g2 = str(uuid4())
        g3 = str(uuid4())
        repo.get_groups_by_chat.return_value = [
            _make_group(group_id=g1),
            _make_group(group_id=g2),
            _make_group(group_id=g3),
        ]
        repo.get_subgroups_by_group.return_value = []

        coord = TrailCoordinator(trail_repository_adapter=repo)
        await coord._calculate_subgroup_sequence(CHAT_ID)

        assert repo.get_subgroups_by_group.await_count == 3
        # Verify called with correct UUIDs
        calls = repo.get_subgroups_by_group.call_args_list
        called_uuids = [str(c[0][0]) for c in calls]
        assert g1 in called_uuids
        assert g2 in called_uuids
        assert g3 in called_uuids
