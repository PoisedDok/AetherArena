import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from application.chat.memory_service import MemoryService
from data.database.persistence_gateway import SupabasePersistenceGateway


@pytest.mark.unit
@pytest.mark.asyncio
async def test_memory_service_uses_settings_group_frequency_when_num_groups_is_none(test_settings):
    settings = test_settings.model_copy(deep=True)
    settings.memory_service.group_frequency = 7

    client = SimpleNamespace(
        rpc=AsyncMock(return_value=[]),
        select=AsyncMock(return_value=[])
    )
    gateway = SupabasePersistenceGateway(client)
    uow = SimpleNamespace(gateway=gateway)

    svc = MemoryService(uow, settings)
    chat_id = uuid.uuid4()
    await svc.extract_memories_from_groups(chat_id=chat_id, num_groups=None)

    client.select.assert_awaited_once()
    select_args, select_kwargs = client.select.await_args
    assert select_args[0] == "groups"
    assert select_kwargs["filters"]["chat_id"] == str(chat_id)
    assert select_kwargs["limit"] == 7

