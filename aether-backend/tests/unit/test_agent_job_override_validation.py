import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from application.agents.agent_service import AgentService


@pytest.mark.unit
@pytest.mark.asyncio
async def test_queue_agent_job_rejects_unsupported_job_type_override():
    gateway = AsyncMock()
    gateway.select = AsyncMock(
        return_value=[
            {
                "id": str(uuid.uuid4()),
                "agent_name": "research",
                "enabled": True,
            }
        ]
    )
    uow = SimpleNamespace(gateway=gateway)
    service = AgentService(uow)

    with pytest.raises(ValueError, match="Unsupported job_type_override"):
        await service.queue_agent_job(
            agent_name="research",
            entity_id=uuid.uuid4(),
            entity_type="chat",
            job_type_override="bogus_nonexistent_type",
        )

