"""
Unit Tests: TrailRepositoryAdapter

Tests the infrastructure persistence adapter for trail hierarchy.
Verifies guard behavior, delegation to underlying repo, error translation
(infrastructure exceptions → RuntimeError), and direct DB query methods.

Uses AsyncMock for the underlying TrailRepository. No DB, no network.
"""

from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest

from ws.infrastructure.persistence.trail_repository_adapter import TrailRepositoryAdapter


# =========================================================================
# Helpers
# =========================================================================

def _make_repo(with_db=True):
    """Create a fully-mocked TrailRepository."""
    repo = MagicMock()
    if with_db:
        db = AsyncMock()
        db.select = AsyncMock(return_value=[])
        db.rpc = AsyncMock(return_value=1)
        repo.db = db
    else:
        repo.db = None

    repo.create_group = AsyncMock()
    repo.create_subgroup_with_nodes = AsyncMock()
    repo.get_groups_by_chat = AsyncMock(return_value=[])
    repo.get_subgroups_by_group = AsyncMock(return_value=[])
    repo.update_node_status = AsyncMock()
    repo.update_node = AsyncMock()
    repo.update_subgroup = AsyncMock()
    repo.get_trail_hierarchy = AsyncMock(return_value=[])
    return repo


CHAT_ID = uuid4()
CHAT_ID_STR = str(CHAT_ID)
GROUP_ID = uuid4()
SUBGROUP_ID = uuid4()
NODE_ID = uuid4()
USER_MSG_ID = uuid4()


# =========================================================================
# Initialization
# =========================================================================

class TestInit:
    """Tests for TrailRepositoryAdapter.__init__."""

    def test_stores_repo(self):
        """Repo is stored."""
        repo = _make_repo()
        adapter = TrailRepositoryAdapter(trail_repository=repo)
        assert adapter._repo is repo

    def test_none_repo(self):
        """Default is None."""
        adapter = TrailRepositoryAdapter()
        assert adapter._repo is None


# =========================================================================
# is_available
# =========================================================================

class TestIsAvailable:
    """Tests for TrailRepositoryAdapter.is_available."""

    def test_available_with_repo(self):
        """Returns True when repo is set."""
        adapter = TrailRepositoryAdapter(trail_repository=_make_repo())
        assert adapter.is_available() is True

    def test_not_available_without_repo(self):
        """Returns False when repo is None."""
        adapter = TrailRepositoryAdapter()
        assert adapter.is_available() is False


# =========================================================================
# db property
# =========================================================================

class TestDbProperty:
    """Tests for TrailRepositoryAdapter.db property."""

    def test_returns_db_when_repo_exists(self):
        """Returns repo.db when repo is set."""
        repo = _make_repo()
        adapter = TrailRepositoryAdapter(trail_repository=repo)
        assert adapter.db is repo.db

    def test_returns_none_when_no_repo(self):
        """Returns None when repo is None."""
        adapter = TrailRepositoryAdapter()
        assert adapter.db is None


# =========================================================================
# find_recent_user_message
# =========================================================================

class TestFindRecentUserMessage:
    """Tests for TrailRepositoryAdapter.find_recent_user_message."""

    async def test_no_repo_returns_none(self):
        """No repo → returns None."""
        adapter = TrailRepositoryAdapter()
        result = await adapter.find_recent_user_message(CHAT_ID_STR)
        assert result is None

    async def test_no_db_returns_none(self):
        """Repo exists but db is None → returns None."""
        adapter = TrailRepositoryAdapter(trail_repository=_make_repo(with_db=False))
        result = await adapter.find_recent_user_message(CHAT_ID_STR)
        assert result is None

    async def test_found_returns_uuid(self):
        """Found message → returns UUID."""
        msg_id = uuid4()
        repo = _make_repo()
        repo.db.select.return_value = [{"id": str(msg_id)}]

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.find_recent_user_message(CHAT_ID_STR)

        assert result == msg_id
        assert isinstance(result, UUID)

    async def test_empty_result_returns_none(self):
        """No messages found → returns None."""
        repo = _make_repo()
        repo.db.select.return_value = []

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.find_recent_user_message(CHAT_ID_STR)
        assert result is None

    async def test_db_error_returns_none(self):
        """DB error → returns None."""
        repo = _make_repo()
        repo.db.select.side_effect = OSError("Connection lost")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.find_recent_user_message(CHAT_ID_STR)
        assert result is None

    async def test_invalid_uuid_in_result_returns_none(self):
        """Invalid UUID string in result → ValueError caught, returns None."""
        repo = _make_repo()
        repo.db.select.return_value = [{"id": "not-a-valid-uuid"}]

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.find_recent_user_message(CHAT_ID_STR)
        assert result is None

    async def test_correct_query_params(self):
        """Verifies correct table, filters, ordering, and admin flag."""
        repo = _make_repo()
        repo.db.select.return_value = []

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.find_recent_user_message("chat-123")

        repo.db.select.assert_awaited_once_with(
            "messages",
            filters={"chat_id": "chat-123", "role": "user"},
            order_by="timestamp.desc",
            limit=1,
            admin=True,
        )

    async def test_missing_id_key_returns_none(self):
        """Result dict missing 'id' key → KeyError caught, returns None."""
        repo = _make_repo()
        repo.db.select.return_value = [{"no_id": "oops"}]

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.find_recent_user_message(CHAT_ID_STR)
        assert result is None


# =========================================================================
# get_group_by_user_message_id
# =========================================================================

class TestGetGroupByUserMessageId:
    """Tests for TrailRepositoryAdapter.get_group_by_user_message_id."""

    async def test_no_repo_returns_none(self):
        """No repo → returns None."""
        adapter = TrailRepositoryAdapter()
        result = await adapter.get_group_by_user_message_id(USER_MSG_ID)
        assert result is None

    async def test_no_db_returns_none(self):
        """Repo exists but db is None → returns None."""
        adapter = TrailRepositoryAdapter(trail_repository=_make_repo(with_db=False))
        result = await adapter.get_group_by_user_message_id(USER_MSG_ID)
        assert result is None

    async def test_found_returns_group(self):
        """Found group → returns first result."""
        group = {"id": str(uuid4()), "chat_id": CHAT_ID_STR}
        repo = _make_repo()
        repo.db.select.return_value = [group]

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.get_group_by_user_message_id(USER_MSG_ID)
        assert result == group

    async def test_empty_result_returns_none(self):
        """No group found → returns None."""
        repo = _make_repo()
        repo.db.select.return_value = []

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.get_group_by_user_message_id(USER_MSG_ID)
        assert result is None

    async def test_db_error_returns_none(self):
        """DB error → returns None."""
        repo = _make_repo()
        repo.db.select.side_effect = RuntimeError("DB error")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.get_group_by_user_message_id(USER_MSG_ID)
        assert result is None

    async def test_correct_query_params(self):
        """Verifies correct table, filters, and admin flag."""
        repo = _make_repo()
        repo.db.select.return_value = []

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.get_group_by_user_message_id(USER_MSG_ID)

        repo.db.select.assert_awaited_once_with(
            "groups",
            filters={"user_message_id": str(USER_MSG_ID)},
            limit=1,
            admin=True,
        )


# =========================================================================
# create_group
# =========================================================================

class TestCreateGroup:
    """Tests for TrailRepositoryAdapter.create_group."""

    async def test_no_repo_raises_runtime_error(self):
        """No repo → raises RuntimeError."""
        adapter = TrailRepositoryAdapter()
        with pytest.raises(RuntimeError, match="Trail repository not available"):
            await adapter.create_group(
                chat_id=CHAT_ID,
                user_message="test",
                agent_message="test",
                sequence_number=1,
            )

    async def test_successful_creation(self):
        """Happy path: returns group dict from repo."""
        group = {"id": str(uuid4()), "sequence_number": 1}
        repo = _make_repo()
        repo.create_group.return_value = group

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.create_group(
            chat_id=CHAT_ID,
            user_message="hello",
            agent_message="hi",
            sequence_number=1,
        )
        assert result == group

    async def test_delegates_all_args(self):
        """All arguments are forwarded to repo.create_group."""
        repo = _make_repo()
        repo.create_group.return_value = {"id": str(uuid4())}

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.create_group(
            chat_id=CHAT_ID,
            user_message="user msg",
            agent_message="agent msg",
            sequence_number=3,
            frontend_id="fe-1",
            backend_id="be-1",
            correlation_id="corr-1",
            user_message_id=USER_MSG_ID,
        )

        repo.create_group.assert_awaited_once_with(
            chat_id=CHAT_ID,
            user_message="user msg",
            agent_message="agent msg",
            sequence_number=3,
            frontend_id="fe-1",
            backend_id="be-1",
            correlation_id="corr-1",
            user_message_id=USER_MSG_ID,
        )

    async def test_repo_error_raises_runtime_error(self):
        """Repo exception → translated to RuntimeError."""
        repo = _make_repo()
        repo.create_group.side_effect = ValueError("bad data")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Group creation failed"):
            await adapter.create_group(
                chat_id=CHAT_ID,
                user_message="test",
                agent_message="test",
                sequence_number=1,
            )

    async def test_os_error_raises_runtime_error(self):
        """OSError from repo → translated to RuntimeError."""
        repo = _make_repo()
        repo.create_group.side_effect = OSError("Connection refused")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Group creation failed"):
            await adapter.create_group(
                chat_id=CHAT_ID,
                user_message="t",
                agent_message="t",
                sequence_number=1,
            )

    async def test_connection_error_raises_runtime_error(self):
        """BUG FIX: ConnectionError was NOT in narrow except tuple. Now caught."""
        repo = _make_repo()
        repo.create_group.side_effect = ConnectionError("refused")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Group creation failed"):
            await adapter.create_group(
                chat_id=CHAT_ID,
                user_message="t",
                agent_message="t",
                sequence_number=1,
            )

    async def test_timeout_error_raises_runtime_error(self):
        """BUG FIX: TimeoutError was NOT in narrow except tuple. Now caught."""
        repo = _make_repo()
        repo.create_group.side_effect = TimeoutError("DB timeout")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Group creation failed"):
            await adapter.create_group(
                chat_id=CHAT_ID,
                user_message="t",
                agent_message="t",
                sequence_number=1,
            )


# =========================================================================
# create_subgroup_with_nodes
# =========================================================================

class TestCreateSubgroupWithNodes:
    """Tests for TrailRepositoryAdapter.create_subgroup_with_nodes."""

    async def test_no_repo_raises_runtime_error(self):
        """No repo → raises RuntimeError."""
        adapter = TrailRepositoryAdapter()
        with pytest.raises(RuntimeError, match="Trail repository not available"):
            await adapter.create_subgroup_with_nodes(
                group_id=GROUP_ID,
                sequence_number=1,
                sequence_in_chat=1,
                execution_group="exec-1",
            )

    async def test_successful_creation(self):
        """Happy path: returns (subgroup, nodes) tuple."""
        subgroup = {"id": str(uuid4()), "sequence_number": 1}
        nodes = [{"id": str(uuid4())} for _ in range(3)]
        repo = _make_repo()
        repo.create_subgroup_with_nodes.return_value = (subgroup, nodes)

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.create_subgroup_with_nodes(
            group_id=GROUP_ID,
            sequence_number=1,
            sequence_in_chat=5,
            execution_group="exec-1",
        )

        assert result == (subgroup, nodes)
        assert len(result[1]) == 3

    async def test_delegates_all_args(self):
        """All arguments forwarded to repo."""
        repo = _make_repo()
        repo.create_subgroup_with_nodes.return_value = ({"id": "s"}, [])

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.create_subgroup_with_nodes(
            group_id=GROUP_ID,
            sequence_number=2,
            sequence_in_chat=7,
            execution_group="exec-2",
            status="pending",
        )

        repo.create_subgroup_with_nodes.assert_awaited_once_with(
            group_id=GROUP_ID,
            sequence_number=2,
            sequence_in_chat=7,
            execution_group="exec-2",
            status="pending",
        )

    async def test_repo_error_raises_runtime_error(self):
        """Repo exception → translated to RuntimeError."""
        repo = _make_repo()
        repo.create_subgroup_with_nodes.side_effect = KeyError("missing")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Subgroup creation failed"):
            await adapter.create_subgroup_with_nodes(
                group_id=GROUP_ID,
                sequence_number=1,
                sequence_in_chat=1,
                execution_group="exec-1",
            )


# =========================================================================
# get_groups_by_chat
# =========================================================================

class TestGetGroupsByChat:
    """Tests for TrailRepositoryAdapter.get_groups_by_chat."""

    async def test_no_repo_returns_empty_list(self):
        """No repo → returns []."""
        adapter = TrailRepositoryAdapter()
        result = await adapter.get_groups_by_chat(CHAT_ID)
        assert result == []

    async def test_successful_fetch(self):
        """Returns groups from repo."""
        groups = [{"id": str(uuid4())}, {"id": str(uuid4())}]
        repo = _make_repo()
        repo.get_groups_by_chat.return_value = groups

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.get_groups_by_chat(CHAT_ID)
        assert result == groups
        assert len(result) == 2

    async def test_repo_error_returns_empty_list(self):
        """Repo error → returns []."""
        repo = _make_repo()
        repo.get_groups_by_chat.side_effect = RuntimeError("DB error")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.get_groups_by_chat(CHAT_ID)
        assert result == []

    async def test_delegates_chat_id(self):
        """Passes chat_id to repo."""
        repo = _make_repo()
        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.get_groups_by_chat(CHAT_ID)
        repo.get_groups_by_chat.assert_awaited_once_with(CHAT_ID)


# =========================================================================
# get_subgroups_by_group
# =========================================================================

class TestGetSubgroupsByGroup:
    """Tests for TrailRepositoryAdapter.get_subgroups_by_group."""

    async def test_no_repo_returns_empty_list(self):
        """No repo → returns []."""
        adapter = TrailRepositoryAdapter()
        result = await adapter.get_subgroups_by_group(GROUP_ID)
        assert result == []

    async def test_successful_fetch(self):
        """Returns subgroups from repo."""
        subgroups = [{"id": str(uuid4())}]
        repo = _make_repo()
        repo.get_subgroups_by_group.return_value = subgroups

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.get_subgroups_by_group(GROUP_ID)
        assert result == subgroups

    async def test_repo_error_returns_empty_list(self):
        """Repo error → returns []."""
        repo = _make_repo()
        repo.get_subgroups_by_group.side_effect = AttributeError("broken")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.get_subgroups_by_group(GROUP_ID)
        assert result == []

    async def test_delegates_group_id(self):
        """Passes group_id to repo."""
        repo = _make_repo()
        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.get_subgroups_by_group(GROUP_ID)
        repo.get_subgroups_by_group.assert_awaited_once_with(GROUP_ID)


# =========================================================================
# get_next_chat_sequence
# =========================================================================

class TestGetNextChatSequence:
    """Tests for TrailRepositoryAdapter.get_next_chat_sequence."""

    async def test_no_repo_raises_runtime_error(self):
        """No repo → raises RuntimeError."""
        adapter = TrailRepositoryAdapter()
        with pytest.raises(RuntimeError, match="Trail repository not available"):
            await adapter.get_next_chat_sequence(CHAT_ID_STR)

    async def test_successful_rpc_call(self):
        """Happy path: returns sequence number from RPC."""
        repo = _make_repo()
        repo.db.rpc.return_value = 42

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.get_next_chat_sequence(CHAT_ID_STR)
        assert result == 42

    async def test_correct_rpc_params(self):
        """Verifies RPC function name, params, and admin flag."""
        repo = _make_repo()
        repo.db.rpc.return_value = 1

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.get_next_chat_sequence("chat-456")

        repo.db.rpc.assert_awaited_once_with(
            'get_next_chat_sequence',
            {'p_chat_id': 'chat-456'},
            admin=True,
        )

    async def test_rpc_error_raises_runtime_error(self):
        """RPC error → translated to RuntimeError."""
        repo = _make_repo()
        repo.db.rpc.side_effect = OSError("Network error")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Sequence fetch failed"):
            await adapter.get_next_chat_sequence(CHAT_ID_STR)


# =========================================================================
# update_node_status
# =========================================================================

class TestUpdateNodeStatus:
    """Tests for TrailRepositoryAdapter.update_node_status."""

    async def test_no_repo_raises_runtime_error(self):
        """No repo → raises RuntimeError."""
        adapter = TrailRepositoryAdapter()
        with pytest.raises(RuntimeError, match="Trail repository not available"):
            await adapter.update_node_status(NODE_ID, "active")

    async def test_successful_update(self):
        """Happy path: returns updated node dict."""
        updated = {"id": str(NODE_ID), "status": "completed"}
        repo = _make_repo()
        repo.update_node_status.return_value = updated

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.update_node_status(NODE_ID, "completed")
        assert result == updated

    async def test_delegates_args(self):
        """Passes node_id and status to repo."""
        repo = _make_repo()
        repo.update_node_status.return_value = {}

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.update_node_status(NODE_ID, "active")
        repo.update_node_status.assert_awaited_once_with(NODE_ID, "active")

    async def test_repo_error_raises_runtime_error(self):
        """Repo error → translated to RuntimeError."""
        repo = _make_repo()
        repo.update_node_status.side_effect = TypeError("bad type")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Node status update failed"):
            await adapter.update_node_status(NODE_ID, "active")


# =========================================================================
# update_node
# =========================================================================

class TestUpdateNode:
    """Tests for TrailRepositoryAdapter.update_node."""

    async def test_no_repo_raises_runtime_error(self):
        """No repo → raises RuntimeError."""
        adapter = TrailRepositoryAdapter()
        with pytest.raises(RuntimeError, match="Trail repository not available"):
            await adapter.update_node(NODE_ID, {"artifact_id": "art-1"})

    async def test_successful_update(self):
        """Happy path: returns updated node dict."""
        updated = {"id": str(NODE_ID), "artifact_id": "art-1"}
        repo = _make_repo()
        repo.update_node.return_value = updated

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.update_node(NODE_ID, {"artifact_id": "art-1"})
        assert result == updated

    async def test_delegates_args(self):
        """Passes node_id and updates to repo."""
        updates = {"artifact_id": "art-2", "artifact_type": "code"}
        repo = _make_repo()
        repo.update_node.return_value = {}

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.update_node(NODE_ID, updates)
        repo.update_node.assert_awaited_once_with(NODE_ID, updates)

    async def test_repo_error_raises_runtime_error(self):
        """Repo error → translated to RuntimeError."""
        repo = _make_repo()
        repo.update_node.side_effect = KeyError("field missing")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Node update failed"):
            await adapter.update_node(NODE_ID, {"artifact_id": "art-1"})


# =========================================================================
# update_subgroup
# =========================================================================

class TestUpdateSubgroup:
    """Tests for TrailRepositoryAdapter.update_subgroup."""

    async def test_no_repo_raises_runtime_error(self):
        """No repo → raises RuntimeError."""
        adapter = TrailRepositoryAdapter()
        with pytest.raises(RuntimeError, match="Trail repository not available"):
            await adapter.update_subgroup(SUBGROUP_ID, {"status": "completed"})

    async def test_successful_update(self):
        """Happy path: returns updated subgroup dict."""
        updated = {"id": str(SUBGROUP_ID), "status": "completed"}
        repo = _make_repo()
        repo.update_subgroup.return_value = updated

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.update_subgroup(SUBGROUP_ID, {"status": "completed"})
        assert result == updated

    async def test_delegates_args(self):
        """Passes subgroup_id and updates to repo."""
        updates = {"status": "completed", "completed_at": "2026-02-09T00:00:00Z"}
        repo = _make_repo()
        repo.update_subgroup.return_value = {}

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.update_subgroup(SUBGROUP_ID, updates)
        repo.update_subgroup.assert_awaited_once_with(SUBGROUP_ID, updates)

    async def test_repo_error_raises_runtime_error(self):
        """Repo error → translated to RuntimeError."""
        repo = _make_repo()
        repo.update_subgroup.side_effect = RuntimeError("DB error")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Subgroup update failed"):
            await adapter.update_subgroup(SUBGROUP_ID, {"status": "error"})


# =========================================================================
# get_trail_hierarchy
# =========================================================================

class TestGetTrailHierarchy:
    """Tests for TrailRepositoryAdapter.get_trail_hierarchy."""

    async def test_no_repo_raises_runtime_error(self):
        """No repo → raises RuntimeError."""
        adapter = TrailRepositoryAdapter()
        with pytest.raises(RuntimeError, match="Trail repository not available"):
            await adapter.get_trail_hierarchy(CHAT_ID)

    async def test_successful_fetch(self):
        """Happy path: returns hierarchy list."""
        hierarchy = [{"id": str(uuid4()), "subgroups": []}]
        repo = _make_repo()
        repo.get_trail_hierarchy.return_value = hierarchy

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        result = await adapter.get_trail_hierarchy(CHAT_ID)
        assert result == hierarchy

    async def test_delegates_chat_id(self):
        """Passes chat_id to repo."""
        repo = _make_repo()
        adapter = TrailRepositoryAdapter(trail_repository=repo)
        await adapter.get_trail_hierarchy(CHAT_ID)
        repo.get_trail_hierarchy.assert_awaited_once_with(CHAT_ID)

    async def test_repo_error_raises_runtime_error(self):
        """Repo error → translated to RuntimeError."""
        repo = _make_repo()
        repo.get_trail_hierarchy.side_effect = AttributeError("broken")

        adapter = TrailRepositoryAdapter(trail_repository=repo)
        with pytest.raises(RuntimeError, match="Trail hierarchy fetch failed"):
            await adapter.get_trail_hierarchy(CHAT_ID)
