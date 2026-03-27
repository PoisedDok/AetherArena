"""
Unit Tests: AgentService (application/agents/agent_service.py)

Comprehensive coverage of agent config CRUD, job queuing, output storage,
enabled agents, and all error/edge paths.

Mock boundaries:
- uow.gateway → mock select/insert/update/delete (AsyncMock)
- config.settings.get_settings → mock workers.job_queue resource costs
"""

from __future__ import annotations

from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

import pytest

from application.agents.agent_service import AgentService


# ─── Helpers ─────────────────────────────────────────────────────────────────

AGENT_ID = str(uuid4())
JOB_ID = str(uuid4())
OUTPUT_ID = str(uuid4())
ENTITY_ID = uuid4()


def _make_uow(gateway: MagicMock | None = None) -> MagicMock:
    """Create a mock SupabaseUnitOfWork with a gateway attribute."""
    uow = MagicMock()
    gw = gateway or _make_gateway()
    uow.gateway = gw
    return uow


def _make_gateway() -> MagicMock:
    """Create a mock gateway with default returns."""
    gw = MagicMock()
    gw.select = AsyncMock(return_value=[])
    gw.insert = AsyncMock(return_value=[{"id": AGENT_ID}])
    gw.update = AsyncMock(return_value=[{"id": AGENT_ID}])
    gw.delete = AsyncMock(return_value=None)
    return gw


def _make_agent_config(
    *,
    agent_name: str = "research",
    agent_type: str = "research",
    enabled: bool = True,
    execution_trigger: str = "on_demand",
    config_id: str | None = None,
) -> Dict[str, Any]:
    """Create a fake agent config record."""
    return {
        "id": config_id or AGENT_ID,
        "agent_name": agent_name,
        "agent_type": agent_type,
        "model_name": "gpt-4",
        "prompt_template": "Analyze...",
        "execution_trigger": execution_trigger,
        "enabled": enabled,
        "configuration": {},
    }


def _make_settings_mock() -> MagicMock:
    """Create a mock settings with workers.job_queue resource costs."""
    settings = MagicMock()
    jq = MagicMock()
    jq.resource_cost_summarize = 3
    jq.resource_cost_extract_memories = 2
    jq.resource_cost_promote_memories = 2
    jq.resource_cost_research = 6
    jq.resource_cost_default = 3
    settings.workers.job_queue = jq
    return settings


# ─── list_agent_configs ──────────────────────────────────────────────────────


class TestListAgentConfigs:
    """Tests for list_agent_configs."""

    async def test_happy_path(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[
            _make_agent_config(agent_name="memory", enabled=False, execution_trigger="background"),
        ])
        svc = AgentService(_make_uow(gw))
        result = await svc.list_agent_configs()

        assert len(result) == 1
        gw.select.assert_called_once_with("agent_configs", order_by="agent_name")

    async def test_tool_agents_forced_enabled(self):
        """Tool agents (research, research) always forced to enabled=True."""
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[
            _make_agent_config(agent_name="research", enabled=False, execution_trigger="background"),
            _make_agent_config(agent_name="research", enabled=False, execution_trigger="background"),
        ])
        svc = AgentService(_make_uow(gw))
        result = await svc.list_agent_configs()

        for config in result:
            assert config["enabled"] is True

    async def test_on_demand_agents_forced_enabled(self):
        """Agents with execution_trigger=on_demand are also forced enabled."""
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[
            _make_agent_config(agent_name="custom_agent", enabled=False, execution_trigger="on_demand"),
        ])
        svc = AgentService(_make_uow(gw))
        result = await svc.list_agent_configs()

        assert result[0]["enabled"] is True

    async def test_background_agent_not_forced(self):
        """Non-tool background agents keep their enabled state."""
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[
            _make_agent_config(agent_name="memory", enabled=False, execution_trigger="background"),
        ])
        svc = AgentService(_make_uow(gw))
        result = await svc.list_agent_configs()

        assert result[0]["enabled"] is False

    async def test_exception_re_raised(self):
        gw = _make_gateway()
        gw.select = AsyncMock(side_effect=RuntimeError("DB down"))
        svc = AgentService(_make_uow(gw))
        with pytest.raises(RuntimeError, match="DB down"):
            await svc.list_agent_configs()


# ─── get_agent_config ────────────────────────────────────────────────────────


class TestGetAgentConfig:
    """Tests for get_agent_config."""

    async def test_found(self):
        config = _make_agent_config()
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        svc = AgentService(_make_uow(gw))

        result = await svc.get_agent_config("research")
        assert result == config
        gw.select.assert_called_once_with(
            "agent_configs", filters={"agent_name": "research"}, limit=1
        )

    async def test_not_found(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        svc = AgentService(_make_uow(gw))

        result = await svc.get_agent_config("nonexistent")
        assert result is None

    async def test_exception_re_raised(self):
        gw = _make_gateway()
        gw.select = AsyncMock(side_effect=RuntimeError("fail"))
        svc = AgentService(_make_uow(gw))
        with pytest.raises(RuntimeError):
            await svc.get_agent_config("research")


# ─── create_agent_config ─────────────────────────────────────────────────────


class TestCreateAgentConfig:
    """Tests for create_agent_config."""

    async def test_happy_path(self):
        gw = _make_gateway()
        # get_agent_config check returns empty (no existing)
        gw.select = AsyncMock(return_value=[])
        gw.insert = AsyncMock(return_value=[{"id": AGENT_ID, "agent_name": "new_agent"}])
        svc = AgentService(_make_uow(gw))

        data = {
            "agent_name": "new_agent",
            "agent_type": "custom",
            "model_name": "gpt-4",
            "prompt_template": "Do stuff",
            "execution_trigger": "on_demand",
        }
        result = await svc.create_agent_config(data)

        assert result["id"] == AGENT_ID
        gw.insert.assert_called_once()
        # Verify defaults were set
        call_data = gw.insert.call_args[0][1]
        assert call_data["enabled"] is False
        assert call_data["configuration"] == {}

    async def test_missing_required_fields(self):
        svc = AgentService(_make_uow())
        with pytest.raises(ValueError, match="Missing required fields"):
            await svc.create_agent_config({"agent_name": "test"})

    async def test_agent_already_exists(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[_make_agent_config()])
        svc = AgentService(_make_uow(gw))

        data = {
            "agent_name": "research",
            "agent_type": "research",
            "model_name": "gpt-4",
            "prompt_template": "Check",
            "execution_trigger": "on_demand",
        }
        with pytest.raises(ValueError, match="Agent already exists"):
            await svc.create_agent_config(data)

    async def test_preserves_explicit_enabled_true(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        gw.insert = AsyncMock(return_value=[{"id": AGENT_ID}])
        svc = AgentService(_make_uow(gw))

        data = {
            "agent_name": "new_agent",
            "agent_type": "custom",
            "model_name": "gpt-4",
            "prompt_template": "Do stuff",
            "execution_trigger": "background",
            "enabled": True,
        }
        await svc.create_agent_config(data)
        call_data = gw.insert.call_args[0][1]
        assert call_data["enabled"] is True

    async def test_result_as_dict_not_list(self):
        """When insert returns a dict instead of a list."""
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        gw.insert = AsyncMock(return_value={"id": AGENT_ID, "agent_name": "new"})
        svc = AgentService(_make_uow(gw))

        data = {
            "agent_name": "new",
            "agent_type": "custom",
            "model_name": "gpt-4",
            "prompt_template": "Do stuff",
            "execution_trigger": "on_demand",
        }
        result = await svc.create_agent_config(data)
        assert result["id"] == AGENT_ID

    async def test_exception_re_raised(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        gw.insert = AsyncMock(side_effect=RuntimeError("insert fail"))
        svc = AgentService(_make_uow(gw))

        data = {
            "agent_name": "new_agent",
            "agent_type": "custom",
            "model_name": "gpt-4",
            "prompt_template": "Do stuff",
            "execution_trigger": "on_demand",
        }
        with pytest.raises(RuntimeError, match="insert fail"):
            await svc.create_agent_config(data)


# ─── update_agent_config ─────────────────────────────────────────────────────


class TestUpdateAgentConfig:
    """Tests for update_agent_config."""

    async def test_happy_path(self):
        config = _make_agent_config()
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        updated_config = {**config, "model_name": "gpt-4o"}
        gw.update = AsyncMock(return_value=[updated_config])
        svc = AgentService(_make_uow(gw))

        result = await svc.update_agent_config("research", {"model_name": "gpt-4o"})
        assert result["model_name"] == "gpt-4o"
        gw.update.assert_called_once_with(
            "agent_configs",
            {"model_name": "gpt-4o"},
            record_id=AGENT_ID,
        )

    async def test_not_found_raises(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        svc = AgentService(_make_uow(gw))

        with pytest.raises(ValueError, match="Agent config not found"):
            await svc.update_agent_config("nonexistent", {"enabled": True})

    async def test_result_as_empty_list(self):
        """When update returns an empty list, it returns the list itself."""
        config = _make_agent_config()
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.update = AsyncMock(return_value=[])
        svc = AgentService(_make_uow(gw))

        result = await svc.update_agent_config("research", {"enabled": False})
        assert result == []

    async def test_result_as_non_list(self):
        """When update returns a non-list value."""
        config = _make_agent_config()
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.update = AsyncMock(return_value={"id": AGENT_ID, "enabled": False})
        svc = AgentService(_make_uow(gw))

        result = await svc.update_agent_config("research", {"enabled": False})
        assert result["id"] == AGENT_ID

    async def test_exception_re_raised(self):
        config = _make_agent_config()
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.update = AsyncMock(side_effect=RuntimeError("update fail"))
        svc = AgentService(_make_uow(gw))

        with pytest.raises(RuntimeError, match="update fail"):
            await svc.update_agent_config("research", {"enabled": True})


# ─── delete_agent_config ─────────────────────────────────────────────────────


class TestDeleteAgentConfig:
    """Tests for delete_agent_config."""

    async def test_happy_path(self):
        config = _make_agent_config()
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        svc = AgentService(_make_uow(gw))

        await svc.delete_agent_config("research")
        gw.delete.assert_called_once_with("agent_configs", record_id=AGENT_ID)

    async def test_not_found_raises(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        svc = AgentService(_make_uow(gw))

        with pytest.raises(ValueError, match="Agent config not found"):
            await svc.delete_agent_config("nonexistent")

    async def test_exception_re_raised(self):
        config = _make_agent_config()
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.delete = AsyncMock(side_effect=RuntimeError("delete fail"))
        svc = AgentService(_make_uow(gw))

        with pytest.raises(RuntimeError, match="delete fail"):
            await svc.delete_agent_config("research")


# ─── queue_agent_job ─────────────────────────────────────────────────────────


class TestQueueAgentJob:
    """Tests for queue_agent_job."""

    @patch("application.agents.agent_service.get_settings")
    async def test_happy_path_tool_agent(self, mock_get_settings):
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(agent_name="research", enabled=True)
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(return_value=[{"id": JOB_ID}])
        svc = AgentService(_make_uow(gw))

        job_id = await svc.queue_agent_job(
            agent_name="research",
            entity_id=ENTITY_ID,
            entity_type="chat",
        )

        assert isinstance(job_id, UUID)
        assert str(job_id) == JOB_ID
        # Verify job data
        call_args = gw.insert.call_args[0]
        assert call_args[0] == "pending_jobs"
        job_data = call_args[1]
        assert job_data["job_type"] == "agent_research"
        assert job_data["agent_name"] == "research"
        assert job_data["resource_cost"] == 6  # from settings

    @patch("application.agents.agent_service.get_settings")
    async def test_tool_agent_always_allowed_even_if_disabled(self, mock_get_settings):
        """Tool agents (research, research) bypass enabled check."""
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(agent_name="research", enabled=False)
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(return_value=[{"id": JOB_ID}])
        svc = AgentService(_make_uow(gw))

        # Should NOT raise even though enabled=False
        job_id = await svc.queue_agent_job(
            agent_name="research",
            entity_id=ENTITY_ID,
            entity_type="chat",
        )
        assert isinstance(job_id, UUID)

    @patch("application.agents.agent_service.get_settings")
    async def test_on_demand_agent_bypasses_enabled_check(self, mock_get_settings):
        """on_demand execution_trigger agents bypass enabled check."""
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(
            agent_name="custom",
            enabled=False,
            execution_trigger="on_demand",
        )
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(return_value=[{"id": JOB_ID}])
        svc = AgentService(_make_uow(gw))

        # on_demand agents aren't in TOOL_AGENTS set, so this tests
        # the execution_trigger check separately.
        # But agent_name 'custom' is not in job_type_map either → error
        with pytest.raises(ValueError, match="not queueable"):
            await svc.queue_agent_job(
                agent_name="custom",
                entity_id=ENTITY_ID,
                entity_type="chat",
            )

    async def test_agent_not_found_raises(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        svc = AgentService(_make_uow(gw))

        with pytest.raises(ValueError, match="Agent not found"):
            await svc.queue_agent_job(
                agent_name="nonexistent",
                entity_id=ENTITY_ID,
                entity_type="chat",
            )

    @patch("application.agents.agent_service.get_settings")
    async def test_disabled_system_agent_raises(self, mock_get_settings):
        """Non-tool, non-on-demand agents that are disabled get rejected."""
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(
            agent_name="memory",
            enabled=False,
            execution_trigger="background",
        )
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        svc = AgentService(_make_uow(gw))

        with pytest.raises(ValueError, match="Agent is disabled"):
            await svc.queue_agent_job(
                agent_name="memory",
                entity_id=ENTITY_ID,
                entity_type="chat",
            )

    @patch("application.agents.agent_service.get_settings")
    async def test_invalid_job_type_override_raises(self, mock_get_settings):
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(agent_name="research", enabled=True)
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        svc = AgentService(_make_uow(gw))

        with pytest.raises(ValueError, match="Unsupported job_type_override"):
            await svc.queue_agent_job(
                agent_name="research",
                entity_id=ENTITY_ID,
                entity_type="chat",
                job_type_override="invalid_type",
            )

    @patch("application.agents.agent_service.get_settings")
    async def test_valid_job_type_override(self, mock_get_settings):
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(agent_name="research", enabled=True)
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(return_value=[{"id": JOB_ID}])
        svc = AgentService(_make_uow(gw))

        job_id = await svc.queue_agent_job(
            agent_name="research",
            entity_id=ENTITY_ID,
            entity_type="chat",
            job_type_override="agent_research",
        )
        job_data = gw.insert.call_args[0][1]
        assert job_data["job_type"] == "agent_research"

    @patch("application.agents.agent_service.get_settings")
    async def test_agent_not_in_job_type_map_raises(self, mock_get_settings):
        """An agent that exists but has no job_type mapping and no override."""
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(
            agent_name="unknown_agent",
            enabled=True,
            execution_trigger="background",
        )
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        svc = AgentService(_make_uow(gw))

        with pytest.raises(ValueError, match="not queueable"):
            await svc.queue_agent_job(
                agent_name="unknown_agent",
                entity_id=ENTITY_ID,
                entity_type="chat",
            )

    @patch("application.agents.agent_service.get_settings")
    async def test_custom_resource_cost(self, mock_get_settings):
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(agent_name="research", enabled=True)
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(return_value=[{"id": JOB_ID}])
        svc = AgentService(_make_uow(gw))

        await svc.queue_agent_job(
            agent_name="research",
            entity_id=ENTITY_ID,
            entity_type="chat",
            resource_cost=8,
        )
        job_data = gw.insert.call_args[0][1]
        assert job_data["resource_cost"] == 8

    @patch("application.agents.agent_service.get_settings")
    async def test_all_optional_params(self, mock_get_settings):
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(agent_name="research", enabled=True)
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(return_value=[{"id": JOB_ID}])
        svc = AgentService(_make_uow(gw))

        depends = uuid4()
        await svc.queue_agent_job(
            agent_name="research",
            entity_id=ENTITY_ID,
            entity_type="document",
            priority=9,
            metadata={"key": "val"},
            execution_strategy="sequential",
            depends_on=depends,
            batch_group="batch-1",
            status="running",
        )
        job_data = gw.insert.call_args[0][1]
        assert job_data["priority"] == 9
        assert job_data["metadata"] == {"key": "val"}
        assert job_data["execution_strategy"] == "sequential"
        assert job_data["depends_on"] == str(depends)
        assert job_data["batch_group"] == "batch-1"
        assert job_data["status"] == "running"
        assert job_data["job_type"] == "agent_research"

    @patch("application.agents.agent_service.get_settings")
    async def test_default_resource_cost_from_settings(self, mock_get_settings):
        """Memory agent uses extract_memories resource cost from settings."""
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(
            agent_name="memory",
            enabled=True,
            execution_trigger="background",
        )
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(return_value=[{"id": JOB_ID}])
        svc = AgentService(_make_uow(gw))

        await svc.queue_agent_job(
            agent_name="memory",
            entity_id=ENTITY_ID,
            entity_type="chat",
        )
        job_data = gw.insert.call_args[0][1]
        assert job_data["job_type"] == "extract_memories"
        assert job_data["resource_cost"] == 2  # resource_cost_extract_memories

    @patch("application.agents.agent_service.get_settings")
    async def test_insert_returns_dict_not_list(self, mock_get_settings):
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(agent_name="research", enabled=True)
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(return_value={"id": JOB_ID})
        svc = AgentService(_make_uow(gw))

        job_id = await svc.queue_agent_job(
            agent_name="research",
            entity_id=ENTITY_ID,
            entity_type="chat",
        )
        assert str(job_id) == JOB_ID

    @patch("application.agents.agent_service.get_settings")
    async def test_exception_re_raised(self, mock_get_settings):
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(agent_name="research", enabled=True)
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(side_effect=RuntimeError("insert fail"))
        svc = AgentService(_make_uow(gw))

        with pytest.raises(RuntimeError, match="insert fail"):
            await svc.queue_agent_job(
                agent_name="research",
                entity_id=ENTITY_ID,
                entity_type="chat",
            )

    @patch("application.agents.agent_service.get_settings")
    async def test_depends_on_none_serializes_to_none(self, mock_get_settings):
        mock_get_settings.return_value = _make_settings_mock()
        config = _make_agent_config(agent_name="research", enabled=True)
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[config])
        gw.insert = AsyncMock(return_value=[{"id": JOB_ID}])
        svc = AgentService(_make_uow(gw))

        await svc.queue_agent_job(
            agent_name="research",
            entity_id=ENTITY_ID,
            entity_type="chat",
            depends_on=None,
        )
        job_data = gw.insert.call_args[0][1]
        assert job_data["depends_on"] is None


# ─── get_agent_outputs ───────────────────────────────────────────────────────


class TestGetAgentOutputs:
    """Tests for get_agent_outputs."""

    async def test_happy_path_with_all_filters(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[{"id": OUTPUT_ID, "content": {}}])
        svc = AgentService(_make_uow(gw))

        result = await svc.get_agent_outputs(
            agent_name="research",
            output_type="research",
            entity_id=ENTITY_ID,
            limit=25,
            offset=10,
        )

        assert len(result) == 1
        gw.select.assert_called_once_with(
            "agent_outputs",
            filters={
                "agent_name": "research",
                "output_type": "research",
                "entity_id": str(ENTITY_ID),
            },
            limit=25,
            offset=10,
            order_by="created_at.desc",
        )

    async def test_no_filters(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        svc = AgentService(_make_uow(gw))

        result = await svc.get_agent_outputs()

        assert result == []
        gw.select.assert_called_once_with(
            "agent_outputs",
            filters={},
            limit=50,
            offset=0,
            order_by="created_at.desc",
        )

    async def test_partial_filters(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        svc = AgentService(_make_uow(gw))

        await svc.get_agent_outputs(agent_name="research")
        filters = gw.select.call_args[1]["filters"]
        assert filters == {"agent_name": "research"}

    async def test_exception_re_raised(self):
        gw = _make_gateway()
        gw.select = AsyncMock(side_effect=RuntimeError("fail"))
        svc = AgentService(_make_uow(gw))

        with pytest.raises(RuntimeError):
            await svc.get_agent_outputs()


# ─── store_agent_output ──────────────────────────────────────────────────────


class TestStoreAgentOutput:
    """Tests for store_agent_output."""

    async def test_happy_path(self):
        gw = _make_gateway()
        gw.insert = AsyncMock(return_value=[{"id": OUTPUT_ID}])
        svc = AgentService(_make_uow(gw))

        job_uuid = uuid4()
        entity_uuid = uuid4()
        output_id = await svc.store_agent_output(
            agent_name="research",
            output_type="research",
            content={"score": 8.5, "analysis": "Good"},
            job_id=job_uuid,
            entity_id=entity_uuid,
            aether_rag_index_name="research_index",
        )

        assert isinstance(output_id, UUID)
        assert str(output_id) == OUTPUT_ID
        call_data = gw.insert.call_args[0][1]
        assert call_data["agent_name"] == "research"
        assert call_data["output_type"] == "research"
        assert call_data["content"] == {"score": 8.5, "analysis": "Good"}
        assert call_data["job_id"] == str(job_uuid)
        assert call_data["entity_id"] == str(entity_uuid)
        assert call_data["aether_rag_index_name"] == "research_index"

    async def test_optional_params_none(self):
        gw = _make_gateway()
        gw.insert = AsyncMock(return_value=[{"id": OUTPUT_ID}])
        svc = AgentService(_make_uow(gw))

        await svc.store_agent_output(
            agent_name="memory",
            output_type="memory",
            content={"text": "fact"},
        )
        call_data = gw.insert.call_args[0][1]
        assert call_data["job_id"] is None
        assert call_data["entity_id"] is None
        assert call_data["aether_rag_index_name"] is None

    async def test_result_as_dict_not_list(self):
        gw = _make_gateway()
        gw.insert = AsyncMock(return_value={"id": OUTPUT_ID})
        svc = AgentService(_make_uow(gw))

        output_id = await svc.store_agent_output(
            agent_name="research",
            output_type="research",
            content={"findings": []},
        )
        assert str(output_id) == OUTPUT_ID

    async def test_exception_re_raised(self):
        gw = _make_gateway()
        gw.insert = AsyncMock(side_effect=RuntimeError("insert fail"))
        svc = AgentService(_make_uow(gw))

        with pytest.raises(RuntimeError, match="insert fail"):
            await svc.store_agent_output(
                agent_name="research",
                output_type="research",
                content={},
            )


# ─── get_enabled_agents ──────────────────────────────────────────────────────


class TestGetEnabledAgents:
    """Tests for get_enabled_agents."""

    async def test_happy_path(self):
        gw = _make_gateway()
        configs = [
            _make_agent_config(agent_name="research", enabled=True),
            _make_agent_config(agent_name="research", enabled=True),
        ]
        gw.select = AsyncMock(return_value=configs)
        svc = AgentService(_make_uow(gw))

        result = await svc.get_enabled_agents()
        assert len(result) == 2
        gw.select.assert_called_once_with(
            "agent_configs",
            filters={"enabled": True},
            order_by="agent_name",
        )

    async def test_empty(self):
        gw = _make_gateway()
        gw.select = AsyncMock(return_value=[])
        svc = AgentService(_make_uow(gw))

        result = await svc.get_enabled_agents()
        assert result == []

    async def test_exception_re_raised(self):
        gw = _make_gateway()
        gw.select = AsyncMock(side_effect=RuntimeError("fail"))
        svc = AgentService(_make_uow(gw))

        with pytest.raises(RuntimeError):
            await svc.get_enabled_agents()
