"""
Tests for data/database/repositories/trail.py

Covers: TrailRepository constructor, Group CRUD, Subgroup CRUD,
create_subgroup_with_nodes, _create_nodes_for_subgroup, Node CRUD,
update_node_status, update_subgroup_status, link_artifact_to_node,
get_group_hierarchy, get_trail_hierarchy, get_subgroup_artifacts.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from data.database.repositories.trail import TrailRepository
from data.database.persistence_gateway import SupabasePersistenceGateway


# ===========================================================================
# Helpers
# ===========================================================================

CHAT_ID = uuid4()
GROUP_ID = uuid4()
SUBGROUP_ID = uuid4()
NODE_ID = uuid4()
ART_ID = uuid4()
NOW_ISO = "2026-02-08T12:00:00+00:00"

SAMPLE_GROUP = {
    "id": str(GROUP_ID),
    "chat_id": str(CHAT_ID),
    "user_message": "Hello",
    "agent_message": "Hi there",
    "sequence_number": 1,
    "frontend_id": None,
    "backend_id": None,
    "correlation_id": None,
}

SAMPLE_SUBGROUP = {
    "id": str(SUBGROUP_ID),
    "group_id": str(GROUP_ID),
    "sequence_number": 1,
    "sequence_in_chat": 5,
    "execution_group": "exec-001",
    "status": "pending",
}

SAMPLE_NODE_WRITING = {
    "id": str(uuid4()),
    "subgroup_id": str(SUBGROUP_ID),
    "type": "writing",
    "sequence": 1,
    "clickable": True,
    "status": "pending",
    "artifact_id": None,
    "artifact_type": None,
    "started_at": None,
    "completed_at": None,
}

SAMPLE_NODE_EXECUTING = {
    "id": str(uuid4()),
    "subgroup_id": str(SUBGROUP_ID),
    "type": "executing",
    "sequence": 2,
    "clickable": False,
    "status": "pending",
    "artifact_id": None,
    "artifact_type": None,
    "started_at": None,
    "completed_at": None,
}

SAMPLE_NODE_OUTPUT = {
    "id": str(uuid4()),
    "subgroup_id": str(SUBGROUP_ID),
    "type": "output",
    "sequence": 3,
    "clickable": True,
    "status": "pending",
    "artifact_id": None,
    "artifact_type": None,
    "started_at": None,
    "completed_at": None,
}

ALL_NODES = [SAMPLE_NODE_WRITING, SAMPLE_NODE_EXECUTING, SAMPLE_NODE_OUTPUT]


def _make_gateway():
    gw = MagicMock(spec=SupabasePersistenceGateway)
    gw.insert = AsyncMock()
    gw.select = AsyncMock(return_value=[])
    gw.update = AsyncMock()
    gw.delete = AsyncMock()
    gw.upsert = AsyncMock()
    gw.count = AsyncMock(return_value=0)
    gw.rpc = AsyncMock(return_value=1)
    return gw


@pytest.fixture
def repo():
    gw = _make_gateway()
    return TrailRepository(db=gw), gw


# ===========================================================================
# Constructor
# ===========================================================================

class TestConstructor:

    def test_with_gateway(self):
        gw = _make_gateway()
        r = TrailRepository(db=gw)
        assert r._gateway is gw
        assert r.db is gw

    def test_with_supabase_client(self):
        from data.database.clients.supabase import SupabaseClient
        mock_client = MagicMock(spec=SupabaseClient)
        r = TrailRepository(db=mock_client)
        assert r._gateway is not None

    def test_with_none_raises(self):
        with pytest.raises(ValueError):
            TrailRepository(db=None)

    def test_with_session_raises(self):
        with pytest.raises(RuntimeError, match="SQLAlchemy"):
            TrailRepository(db=None, session=MagicMock())

    def test_with_unsupported_type_raises(self):
        with pytest.raises(TypeError):
            TrailRepository(db="invalid")


# ===========================================================================
# Group Operations
# ===========================================================================

class TestCreateGroup:

    async def test_create_group_basic(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_GROUP]
        result = await r.create_group(CHAT_ID, "Hello", "Hi", 1)
        assert result == SAMPLE_GROUP
        gw.insert.assert_called_once()
        call_data = gw.insert.call_args[0][1]
        assert call_data["chat_id"] == str(CHAT_ID)
        assert call_data["user_message"] == "Hello"
        assert call_data["sequence_number"] == 1

    async def test_create_group_with_optional_fields(self, repo):
        r, gw = repo
        msg_id = uuid4()
        gw.insert.return_value = [SAMPLE_GROUP]
        await r.create_group(
            CHAT_ID, "Hello", "Hi", 1,
            frontend_id="fe-1", backend_id="be-1",
            correlation_id="corr-1", user_message_id=msg_id,
        )
        call_data = gw.insert.call_args[0][1]
        assert call_data["frontend_id"] == "fe-1"
        assert call_data["backend_id"] == "be-1"
        assert call_data["correlation_id"] == "corr-1"
        assert call_data["user_message_id"] == str(msg_id)

    async def test_create_group_no_user_message_id(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_GROUP]
        await r.create_group(CHAT_ID, "Hello", "Hi", 1)
        call_data = gw.insert.call_args[0][1]
        assert call_data["user_message_id"] is None

    async def test_create_group_error_propagates(self, repo):
        r, gw = repo
        gw.insert.side_effect = Exception("Insert fail")
        with pytest.raises(Exception, match="Insert fail"):
            await r.create_group(CHAT_ID, "Hello", "Hi", 1)


class TestGetGroup:

    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_GROUP]
        result = await r.get_group(GROUP_ID)
        assert result == SAMPLE_GROUP

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_group(uuid4())
        assert result is None

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Select fail")
        with pytest.raises(Exception, match="Select fail"):
            await r.get_group(uuid4())


class TestGetGroupsByChat:

    async def test_returns_groups(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_GROUP]
        result = await r.get_groups_by_chat(CHAT_ID)
        assert len(result) == 1

    async def test_empty_result(self, repo):
        r, gw = repo
        gw.select.return_value = None
        result = await r.get_groups_by_chat(CHAT_ID)
        assert result == []

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Select fail")
        with pytest.raises(Exception, match="Select fail"):
            await r.get_groups_by_chat(CHAT_ID)


class TestUpdateGroup:

    async def test_update(self, repo):
        r, gw = repo
        updated = {**SAMPLE_GROUP, "agent_message": "Updated"}
        gw.update.return_value = [updated]
        result = await r.update_group(GROUP_ID, {"agent_message": "Updated"})
        assert result == updated

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("Update fail")
        with pytest.raises(Exception, match="Update fail"):
            await r.update_group(GROUP_ID, {"x": 1})


# ===========================================================================
# Subgroup Operations
# ===========================================================================

class TestCreateSubgroup:

    async def test_create_subgroup(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_SUBGROUP]
        result = await r.create_subgroup(
            GROUP_ID, 1, sequence_in_chat=5,
            execution_group="exec-001",
        )
        assert result == SAMPLE_SUBGROUP
        call_data = gw.insert.call_args[0][1]
        assert call_data["group_id"] == str(GROUP_ID)
        assert call_data["sequence_in_chat"] == 5

    async def test_create_subgroup_default_status(self, repo):
        r, gw = repo
        gw.insert.return_value = [SAMPLE_SUBGROUP]
        await r.create_subgroup(GROUP_ID, 1, sequence_in_chat=5)
        call_data = gw.insert.call_args[0][1]
        assert call_data["status"] == "pending"

    async def test_create_subgroup_error(self, repo):
        r, gw = repo
        gw.insert.side_effect = Exception("Insert fail")
        with pytest.raises(Exception, match="Insert fail"):
            await r.create_subgroup(GROUP_ID, 1, sequence_in_chat=5)


class TestCreateSubgroupWithNodes:

    async def test_happy_path(self, repo):
        r, gw = repo
        # create_subgroup returns subgroup, then 3 insert calls for nodes
        gw.insert.side_effect = [
            [SAMPLE_SUBGROUP],         # subgroup
            [SAMPLE_NODE_WRITING],     # node 1
            [SAMPLE_NODE_EXECUTING],   # node 2
            [SAMPLE_NODE_OUTPUT],      # node 3
        ]
        subgroup, nodes = await r.create_subgroup_with_nodes(
            GROUP_ID, 1, sequence_in_chat=5,
            execution_group="exec-001",
        )
        assert subgroup == SAMPLE_SUBGROUP
        assert len(nodes) == 3

    async def test_wrong_node_count_raises(self, repo):
        """If _create_nodes_for_subgroup returns != 3 nodes, raise ValueError."""
        r, gw = repo
        gw.insert.side_effect = [
            [SAMPLE_SUBGROUP],        # subgroup
            [SAMPLE_NODE_WRITING],    # node 1
            [SAMPLE_NODE_EXECUTING],  # node 2
            # Missing node 3
        ]
        # Patch _create_nodes_for_subgroup to return only 2 nodes
        r._create_nodes_for_subgroup = AsyncMock(
            return_value=[SAMPLE_NODE_WRITING, SAMPLE_NODE_EXECUTING]
        )
        with pytest.raises(ValueError, match="exactly 3 nodes"):
            await r.create_subgroup_with_nodes(GROUP_ID, 1, sequence_in_chat=5)

    async def test_create_subgroup_fails_propagates(self, repo):
        r, gw = repo
        gw.insert.side_effect = Exception("Subgroup insert fail")
        with pytest.raises(Exception, match="Subgroup insert fail"):
            await r.create_subgroup_with_nodes(GROUP_ID, 1, sequence_in_chat=5)


class TestCreateNodesForSubgroup:

    async def test_creates_3_nodes(self, repo):
        r, gw = repo
        gw.insert.side_effect = [
            [SAMPLE_NODE_WRITING],
            [SAMPLE_NODE_EXECUTING],
            [SAMPLE_NODE_OUTPUT],
        ]
        nodes = await r._create_nodes_for_subgroup(SUBGROUP_ID)
        assert len(nodes) == 3
        assert gw.insert.call_count == 3

        # Verify node specs
        calls = gw.insert.call_args_list
        assert calls[0][0][1]["type"] == "writing"
        assert calls[0][0][1]["sequence"] == 1
        assert calls[0][0][1]["clickable"] is True
        assert calls[1][0][1]["type"] == "executing"
        assert calls[1][0][1]["sequence"] == 2
        assert calls[1][0][1]["clickable"] is False
        assert calls[2][0][1]["type"] == "output"
        assert calls[2][0][1]["sequence"] == 3
        assert calls[2][0][1]["clickable"] is True


class TestGetSubgroup:

    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_SUBGROUP]
        result = await r.get_subgroup(SUBGROUP_ID)
        assert result == SAMPLE_SUBGROUP

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_subgroup(uuid4())
        assert result is None

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.get_subgroup(uuid4())


class TestGetSubgroupsByGroup:

    async def test_returns_subgroups(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_SUBGROUP]
        result = await r.get_subgroups_by_group(GROUP_ID)
        assert len(result) == 1

    async def test_empty_result(self, repo):
        r, gw = repo
        gw.select.return_value = None
        result = await r.get_subgroups_by_group(GROUP_ID)
        assert result == []

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.get_subgroups_by_group(GROUP_ID)


class TestUpdateSubgroup:

    async def test_update(self, repo):
        r, gw = repo
        updated = {**SAMPLE_SUBGROUP, "status": "completed"}
        gw.update.return_value = updated
        result = await r.update_subgroup(SUBGROUP_ID, {"status": "completed"})
        assert result == updated

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.update_subgroup(SUBGROUP_ID, {"x": 1})


class TestUpdateSubgroupStatus:

    async def test_running_sets_started_at(self, repo):
        r, gw = repo
        r.update_subgroup = AsyncMock(return_value=SAMPLE_SUBGROUP)
        await r.update_subgroup_status(SUBGROUP_ID, "running")
        call_data = r.update_subgroup.call_args[0][1]
        assert call_data["status"] == "running"
        assert "started_at" in call_data

    async def test_completed_sets_completed_at(self, repo):
        r, gw = repo
        r.update_subgroup = AsyncMock(return_value=SAMPLE_SUBGROUP)
        await r.update_subgroup_status(SUBGROUP_ID, "completed")
        call_data = r.update_subgroup.call_args[0][1]
        assert call_data["status"] == "completed"
        assert "completed_at" in call_data

    async def test_error_sets_completed_at(self, repo):
        r, gw = repo
        r.update_subgroup = AsyncMock(return_value=SAMPLE_SUBGROUP)
        await r.update_subgroup_status(SUBGROUP_ID, "error")
        call_data = r.update_subgroup.call_args[0][1]
        assert "completed_at" in call_data

    async def test_pending_no_timing(self, repo):
        r, gw = repo
        r.update_subgroup = AsyncMock(return_value=SAMPLE_SUBGROUP)
        await r.update_subgroup_status(SUBGROUP_ID, "pending")
        call_data = r.update_subgroup.call_args[0][1]
        assert call_data == {"status": "pending"}

    async def test_error_propagates(self, repo):
        r, gw = repo
        r.update_subgroup = AsyncMock(side_effect=Exception("Error"))
        with pytest.raises(Exception):
            await r.update_subgroup_status(SUBGROUP_ID, "running")


# ===========================================================================
# Node Operations
# ===========================================================================

class TestGetNode:

    async def test_found(self, repo):
        r, gw = repo
        gw.select.return_value = [SAMPLE_NODE_WRITING]
        result = await r.get_node(NODE_ID)
        assert result == SAMPLE_NODE_WRITING

    async def test_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_node(uuid4())
        assert result is None

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.get_node(uuid4())


class TestGetNodesBySubgroup:

    async def test_returns_normalized_nodes(self, repo):
        r, gw = repo
        gw.select.return_value = ALL_NODES
        result = await r.get_nodes_by_subgroup(SUBGROUP_ID)
        assert len(result) == 3
        # Verify normalization
        assert "node_id" in result[0]
        assert result[0]["node_id"] == SAMPLE_NODE_WRITING["id"]
        assert result[0]["type"] == "writing"
        assert result[0]["clickable"] is True
        assert result[1]["clickable"] is False  # executing
        assert result[2]["clickable"] is True   # output

    async def test_wrong_count_logs_warning(self, repo):
        """Non-3 node count should log warning but still return."""
        r, gw = repo
        gw.select.return_value = [SAMPLE_NODE_WRITING]  # Only 1 node
        result = await r.get_nodes_by_subgroup(SUBGROUP_ID)
        assert len(result) == 1

    async def test_empty_result(self, repo):
        r, gw = repo
        gw.select.return_value = None
        result = await r.get_nodes_by_subgroup(SUBGROUP_ID)
        assert result == []

    async def test_artifact_fields_included(self, repo):
        r, gw = repo
        node_with_artifact = {
            **SAMPLE_NODE_WRITING,
            "artifact_id": "art-001",
            "artifact_type": "code",
        }
        gw.select.return_value = [node_with_artifact]
        result = await r.get_nodes_by_subgroup(SUBGROUP_ID)
        assert result[0]["artifact_id"] == "art-001"
        assert result[0]["artifact_type"] == "code"

    async def test_timing_fields_included(self, repo):
        r, gw = repo
        node_with_timing = {
            **SAMPLE_NODE_WRITING,
            "started_at": NOW_ISO,
            "completed_at": NOW_ISO,
        }
        gw.select.return_value = [node_with_timing]
        result = await r.get_nodes_by_subgroup(SUBGROUP_ID)
        assert result[0]["started_at"] == NOW_ISO
        assert result[0]["completed_at"] == NOW_ISO

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.get_nodes_by_subgroup(uuid4())


class TestUpdateNodeStatus:

    async def test_active_sets_timing(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_NODE_WRITING]
        result = await r.update_node_status(NODE_ID, "active")
        call_data = gw.update.call_args[1]["data"]
        assert call_data["status"] == "active"
        assert "started_at" in call_data
        assert call_data["completed_at"] is None
        assert call_data["duration_ms"] is None

    async def test_completed_sets_completed_at(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_NODE_WRITING]
        result = await r.update_node_status(NODE_ID, "completed")
        call_data = gw.update.call_args[1]["data"]
        assert call_data["status"] == "completed"
        assert "completed_at" in call_data

    async def test_error_status_sets_completed_at(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_NODE_WRITING]
        await r.update_node_status(NODE_ID, "error")
        call_data = gw.update.call_args[1]["data"]
        assert "completed_at" in call_data

    async def test_pending_no_timing(self, repo):
        r, gw = repo
        gw.update.return_value = [SAMPLE_NODE_WRITING]
        await r.update_node_status(NODE_ID, "pending")
        call_data = gw.update.call_args[1]["data"]
        assert call_data == {"status": "pending"}

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.update_node_status(NODE_ID, "active")


class TestUpdateNode:

    async def test_update(self, repo):
        r, gw = repo
        updated = {**SAMPLE_NODE_WRITING, "artifact_id": "art-001"}
        gw.update.return_value = [updated]
        result = await r.update_node(NODE_ID, {"artifact_id": "art-001"})
        assert result == updated

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.update.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.update_node(NODE_ID, {"x": 1})


# ===========================================================================
# Artifact Linkage
# ===========================================================================

class TestLinkArtifactToNode:

    async def test_code_to_writing_succeeds(self, repo):
        r, gw = repo
        art = {"id": str(ART_ID), "type": "code"}
        node = {"id": str(NODE_ID), "type": "writing"}
        gw.select.side_effect = [
            [art],   # get artifact
            [node],  # get node
        ]
        updated = {**art, "node_id": str(NODE_ID)}
        gw.update.return_value = [updated]

        result = await r.link_artifact_to_node(ART_ID, NODE_ID, SUBGROUP_ID)
        assert result == updated

    async def test_output_to_output_succeeds(self, repo):
        r, gw = repo
        art = {"id": str(ART_ID), "type": "output"}
        node = {"id": str(NODE_ID), "type": "output"}
        gw.select.side_effect = [[art], [node]]
        gw.update.return_value = [art]
        result = await r.link_artifact_to_node(ART_ID, NODE_ID, SUBGROUP_ID)
        assert result is not None

    async def test_artifact_not_found_raises(self, repo):
        r, gw = repo
        gw.select.return_value = []
        with pytest.raises(ValueError, match="Artifact.*not found"):
            await r.link_artifact_to_node(uuid4(), NODE_ID, SUBGROUP_ID)

    async def test_node_not_found_raises(self, repo):
        r, gw = repo
        art = {"id": str(ART_ID), "type": "code"}
        gw.select.side_effect = [[art], []]
        with pytest.raises(ValueError, match="Node.*not found"):
            await r.link_artifact_to_node(ART_ID, uuid4(), SUBGROUP_ID)

    async def test_executing_node_rejected(self, repo):
        r, gw = repo
        art = {"id": str(ART_ID), "type": "code"}
        node = {"id": str(NODE_ID), "type": "executing"}
        gw.select.side_effect = [[art], [node]]
        with pytest.raises(ValueError, match="executing node"):
            await r.link_artifact_to_node(ART_ID, NODE_ID, SUBGROUP_ID)

    async def test_unsupported_artifact_type_rejected(self, repo):
        r, gw = repo
        art = {"id": str(ART_ID), "type": "markdown"}
        node = {"id": str(NODE_ID), "type": "writing"}
        gw.select.side_effect = [[art], [node]]
        with pytest.raises(ValueError, match="Unsupported artifact type"):
            await r.link_artifact_to_node(ART_ID, NODE_ID, SUBGROUP_ID)

    async def test_code_to_output_rejected(self, repo):
        r, gw = repo
        art = {"id": str(ART_ID), "type": "code"}
        node = {"id": str(NODE_ID), "type": "output"}
        gw.select.side_effect = [[art], [node]]
        with pytest.raises(ValueError, match="Code artifacts must link to writing"):
            await r.link_artifact_to_node(ART_ID, NODE_ID, SUBGROUP_ID)

    async def test_output_to_writing_rejected(self, repo):
        r, gw = repo
        art = {"id": str(ART_ID), "type": "output"}
        node = {"id": str(NODE_ID), "type": "writing"}
        gw.select.side_effect = [[art], [node]]
        with pytest.raises(ValueError, match="Output artifacts must link to output"):
            await r.link_artifact_to_node(ART_ID, NODE_ID, SUBGROUP_ID)

    async def test_db_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("DB error")
        with pytest.raises(Exception, match="DB error"):
            await r.link_artifact_to_node(ART_ID, NODE_ID, SUBGROUP_ID)


# ===========================================================================
# Hierarchy Queries
# ===========================================================================

class TestGetGroupHierarchy:

    async def test_found_with_subgroups_and_nodes(self, repo):
        r, gw = repo
        gw.select.side_effect = [
            [SAMPLE_GROUP],        # group
            [SAMPLE_SUBGROUP],     # subgroups
            ALL_NODES,             # nodes for subgroup
        ]
        result = await r.get_group_hierarchy(GROUP_ID)
        assert result is not None
        assert "subgroups" in result
        assert len(result["subgroups"]) == 1
        assert "nodes" in result["subgroups"][0]

    async def test_group_not_found(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_group_hierarchy(uuid4())
        assert result is None

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.get_group_hierarchy(uuid4())


class TestGetSubgroupArtifacts:

    async def test_returns_artifacts(self, repo):
        r, gw = repo
        artifacts = [{"id": str(uuid4()), "type": "code"}]
        gw.select.return_value = artifacts
        result = await r.get_subgroup_artifacts(SUBGROUP_ID)
        assert result == artifacts

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.get_subgroup_artifacts(uuid4())


class TestGetTrailHierarchy:

    async def test_full_hierarchy(self, repo):
        r, gw = repo
        gw.select.side_effect = [
            [SAMPLE_GROUP],        # groups
            [SAMPLE_SUBGROUP],     # subgroups for group
            ALL_NODES,             # nodes for subgroup
        ]
        result = await r.get_trail_hierarchy(CHAT_ID)
        assert len(result) == 1
        assert "subgroups" in result[0]
        assert "nodes" in result[0]["subgroups"][0]

    async def test_empty_chat(self, repo):
        r, gw = repo
        gw.select.return_value = []
        result = await r.get_trail_hierarchy(CHAT_ID)
        assert result == []

    async def test_multiple_groups(self, repo):
        r, gw = repo
        group2 = {**SAMPLE_GROUP, "id": str(uuid4()), "sequence_number": 2}
        gw.select.side_effect = [
            [SAMPLE_GROUP, group2],  # 2 groups
            [SAMPLE_SUBGROUP],       # subgroups for group 1
            ALL_NODES,               # nodes for group 1 subgroup
            [],                      # subgroups for group 2 (empty)
        ]
        result = await r.get_trail_hierarchy(CHAT_ID)
        assert len(result) == 2
        assert result[0]["subgroups"] is not None
        assert result[1]["subgroups"] == []

    async def test_error_propagates(self, repo):
        r, gw = repo
        gw.select.side_effect = Exception("Error")
        with pytest.raises(Exception):
            await r.get_trail_hierarchy(CHAT_ID)
